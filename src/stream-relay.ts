import { readdirSync, lstatSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { DraftSendResult, StreamLine, PlatformContext } from "./types.js";
import { log } from "./logger.js";
import {
  messagesSent,
  recordDraftSchedulerEvent,
  recordFinalDeliveryFailure,
} from "./metrics.js";
import { shouldSuppressNoReply } from "./no-reply.js";

/**
 * Split text into chunks that fit a platform's message limit.
 * Splits at paragraph boundaries (\n\n) when possible, otherwise at newlines, otherwise hard-cut.
 */
export function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    let skipChars = 2; // skip the \n\n boundary
    if (splitIdx > 0) {
      // Walk back to the start of the newline run so the chunk
      // doesn't end with a stray \n from an overlapping match.
      while (splitIdx > 0 && remaining[splitIdx - 1] === "\n") {
        splitIdx--;
      }
    }
    if (splitIdx <= 0) {
      // Try newline
      splitIdx = remaining.lastIndexOf("\n", maxLen);
      skipChars = 1; // skip the \n boundary
    }
    if (splitIdx <= 0) {
      // Hard cut at space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
      skipChars = 1; // skip the space
    }
    if (splitIdx <= 0) {
      // Hard cut
      splitIdx = maxLen;
      skipChars = 0;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx + skipChars);
  }

  return chunks;
}

/**
 * Collapse runs of 3+ consecutive newlines down to exactly 2 (\n\n).
 * Preserves single newlines (line breaks) and double newlines (paragraph breaks).
 */
export function collapseNewlines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n");
}

function extractTextDelta(msg: StreamLine): string | null {
  if (msg.type === "stream_event") {
    const event = msg.event;
    if (event?.delta?.type === "text_delta" && event.delta.text) {
      return event.delta.text;
    }
  }
  return null;
}

function shouldResetAccumulatedText(msg: StreamLine): boolean {
  return (
    msg.type === "assistant" &&
    msg.subtype === "control_request" &&
    (msg as { action?: unknown }).action === "reset_response_text"
  );
}

/**
 * Extract text content from a stream line.
 * Returns text delta for streaming events, full text for assistant/result messages.
 */
export function extractText(msg: StreamLine): { text: string | null; isFinal: boolean } {
  // Only accumulate text from streaming deltas.
  // Assistant message snapshots and result messages repeat the same text
  // that was already delivered via text_delta events, so extracting text
  // from them would cause duplicate/triple output.
  const delta = extractTextDelta(msg);
  if (delta !== null) {
    return { text: delta, isFinal: false };
  }

  if (msg.type === "result") {
    return { text: null, isFinal: true };
  }

  return { text: null, isFinal: false };
}

/** Image extensions that can be displayed inline. */
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** Check if a file path has an image extension suitable for inline display. */
export function isImageExtension(filePath: string): boolean {
  const dotIdx = filePath.lastIndexOf(".");
  if (dotIdx === -1) return false;
  return IMAGE_EXTENSIONS.has(filePath.slice(dotIdx).toLowerCase());
}

/**
 * Scan the outbox directory for files and send each via the platform adapter.
 * After sending, files are removed from the outbox.
 */
export async function sendOutboxFiles(outboxPath: string, platform: PlatformContext): Promise<void> {
  let entries: string[];
  try {
    const outboxStat = lstatSync(outboxPath);
    if (outboxStat.isSymbolicLink() || !outboxStat.isDirectory()) {
      log.warn("stream-relay", `Refusing to scan unsafe outbox path: ${outboxPath}`);
      return;
    }
    entries = readdirSync(outboxPath);
  } catch {
    return; // Directory doesn't exist or isn't readable
  }

  for (const name of entries) {
    const filePath = join(outboxPath, name);
    try {
      const stat = lstatSync(filePath);
      if (!stat.isFile()) continue;
      await platform.sendFile(filePath, isImageExtension(filePath));
      // Delete only after successful send
      try { unlinkSync(filePath); } catch { /* ignore cleanup errors */ }
    } catch (err) {
      log.error("stream-relay", `Failed to send outbox file ${name}:`, err);
    }
  }
}

/** Telegram drafts share the per-chat send budget; keep starts at least 1s apart. */
export const DRAFT_MIN_INTERVAL_MS = 1000;
const MAX_DRAFT_PAUSE_MS = 60_000;

/** Max time (ms) to wait for in-flight drafts before final delivery. */
export const DRAFT_SETTLE_TIMEOUT_MS = 3000;

/**
 * O(1) per-stream draft scheduler: one request in flight and one replaceable
 * pending snapshot. Draft failures are cosmetic and never escape this class.
 */
class DraftScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private pendingText: string | null = null;
  private lastStartedAt: number | null = null;
  private pauseUntil = 0;
  private cancelled = false;
  private unsupported = false;
  private inFlightController: AbortController | null = null;

  constructor(
    private readonly platform: PlatformContext,
    private readonly draftId: number,
    private readonly onFirstVisibleDraft: () => void,
  ) {}

  enqueue(text: string): void {
    if (this.cancelled || this.unsupported || !text) return;
    if (this.pendingText !== null) recordDraftSchedulerEvent("coalesced");
    this.pendingText = text;
    if (this.inFlight === null) this.startOrSchedule();
  }

  clearPending(): void {
    this.pendingText = null;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  cancel(): void {
    this.cancelled = true;
    this.clearPending();
    this.inFlightController?.abort();
  }

  async closeAndWait(): Promise<void> {
    this.cancel();
    const active = this.inFlight;
    if (active === null) return;

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, DRAFT_SETTLE_TIMEOUT_MS);
      void active.then(finish, finish);
    });
  }

  private startOrSchedule(): void {
    if (this.cancelled || this.unsupported || this.inFlight !== null || this.pendingText === null) return;
    const now = Date.now();
    const intervalUntil = this.lastStartedAt === null
      ? now
      : this.lastStartedAt + DRAFT_MIN_INTERVAL_MS;
    const dueAt = Math.max(intervalUntil, this.pauseUntil);
    if (dueAt > now) {
      if (this.timer === null) {
        recordDraftSchedulerEvent("throttled");
        this.timer = setTimeout(() => {
          this.timer = null;
          this.startOrSchedule();
        }, dueAt - now);
      }
      return;
    }

    const text = this.pendingText;
    this.pendingText = null;
    this.lastStartedAt = now;
    const controller = new AbortController();
    this.inFlightController = controller;
    this.inFlight = Promise.resolve()
      .then(() => this.platform.sendDraft(this.draftId, text, controller.signal))
      .then((result) => this.handleResult(result))
      .catch(() => this.handleResult({ status: "failed" }))
      .finally(() => {
        if (this.inFlightController === controller) this.inFlightController = null;
        this.inFlight = null;
        if (!this.cancelled) this.startOrSchedule();
      });
  }

  private handleResult(result: DraftSendResult): void {
    switch (result.status) {
      case "sent":
        if (!this.cancelled) this.onFirstVisibleDraft();
        break;
      case "unsupported":
        this.unsupported = true;
        this.clearPending();
        break;
      case "rate_limited":
        this.pauseUntil = Math.max(
          this.pauseUntil,
          Date.now() + Math.min(MAX_DRAFT_PAUSE_MS, Math.max(0, result.retryAfterMs)),
        );
        recordDraftSchedulerEvent("rate_limited");
        break;
      case "failed":
        recordDraftSchedulerEvent("failed");
        break;
    }
  }
}

/**
 * Relay agent stream output to a chat using the platform-agnostic interface.
 *
 * Strategy:
 * 1. Accumulate streaming text deltas
 * 2. Send coalesced, rate-aware draft updates via sendDraft
 * 3. On completion, sendMessage with final text (guaranteed delivery)
 * 4. If text exceeds maxMessageLength, send continuation chunks via sendMessage
 *
 * Drafts auto-disappear when sendMessage is called (or when the response is suppressed).
 * When typingIndicator is false, no typing actions are sent.
 */
export async function relayStream(
  stream: AsyncGenerator<StreamLine>,
  platform: PlatformContext,
  outboxPath?: string,
  onAgentOwnership?: () => void,
): Promise<void> {
  let accumulated = "";
  let typingTimer: ReturnType<typeof setInterval> | null = null;
  let sawNonTextBlock = false;

  // Generate a stable draft_id for this entire response
  const draftId = Math.floor(Math.random() * 2147483647) + 1;
  const stopPeriodicTyping = () => {
    if (typingTimer !== null) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  };
  const draftScheduler = new DraftScheduler(platform, draftId, stopPeriodicTyping);

  // Take over pre-stream typing if active (clean handoff from message queue)
  if (platform.preStreamTypingTimer) {
    clearInterval(platform.preStreamTypingTimer);
    platform.preStreamTypingTimer = undefined;
  }

  // Send typing indicator periodically (if enabled)
  if (platform.typingIndicator) {
    typingTimer = setInterval(() => {
      platform.sendTyping().catch(() => {});
    }, platform.typingIntervalMs);

    // Send initial typing
    await platform.sendTyping().catch(() => {});
  }

  /** Queue the latest display snapshot; stale pending snapshots are replaced. */
  const scheduleDraft = () => {
    if (!accumulated) return;
    const collapsed = collapseNewlines(accumulated);
    const displayText = collapsed.length > platform.maxMessageLength
      ? collapsed.slice(0, platform.maxMessageLength - 3) + "..."
      : collapsed;
    draftScheduler.enqueue(displayText);
  };

  try {
    let resultText: string | null = null;
    let ownershipSignaled = false;

    for await (const msg of stream) {
      // First event from the stream means the agent received the prompt and
      // started processing — the conversation history now references
      // any media paths in the prompt. Signal ownership so the queue won't
      // reclaim media if response delivery fails afterward (issue #99).
      if (!ownershipSignaled) {
        ownershipSignaled = true;
        onAgentOwnership?.();
      }
      if (shouldResetAccumulatedText(msg)) {
        accumulated = "";
        resultText = null;
        sawNonTextBlock = false;
        draftScheduler.clearPending();
        continue;
      }
      // Detect non-text content blocks (tool_use, etc.) so we can insert a
      // paragraph break when the next text block starts.  Without this,
      // "plan:" + [Edit tool] + "Done!" would become "plan:Done!".
      if (msg.type === "stream_event") {
        const ev = msg.event as Record<string, unknown>;
        if (ev.type === "content_block_start") {
          const block = ev.content_block as Record<string, unknown> | undefined;
          if (block?.type && block.type !== "text") {
            sawNonTextBlock = true;
          }
        }
      }

      const { text, isFinal } = extractText(msg);

      if (text !== null) {
        // Insert paragraph break when text resumes after a tool-use block
        if (sawNonTextBlock) {
          if (accumulated.length > 0 && !accumulated.endsWith("\n\n")) {
            accumulated += accumulated.endsWith("\n") ? "\n" : "\n\n";
          }
          sawNonTextBlock = false;
        }
        accumulated += text;

        // Send draft update (debounced, cosmetic)
        if (!isFinal) {
          scheduleDraft();
        }
      }

      // Track result text as fallback when no streaming deltas arrive
      if (msg.type === "result" && msg.result) {
        resultText = msg.result;
        if (msg.is_error === true) {
          accumulated = msg.result;
          sawNonTextBlock = false;
        }
      }

      if (isFinal) {
        break;
      }
    }

    // Fallback: if no streaming deltas arrived but result contains text,
    // use it (handles edge case where protocol sends no text_delta events)
    if (!accumulated && resultText) {
      accumulated = resultText;
    }

    // Discard pending cosmetic work and wait only a bounded time for the sole
    // in-flight request, so final delivery remains authoritative and prompt.
    await draftScheduler.closeAndWait();

    // NO_REPLY: agent explicitly signals "no response needed" — suppress delivery.
    // Drafts auto-disappear when no sendMessage follows.
    if (accumulated && shouldSuppressNoReply(accumulated)) {
      return;
    }

    // Final delivery: always sendMessage (completes draft in DMs, sends fresh in groups)
    if (accumulated) {
      const chunks = splitMessage(collapseNewlines(accumulated), platform.maxMessageLength);

      for (let i = 0; i < chunks.length; i++) {
        try {
          await platform.sendMessage(chunks[i]);
          messagesSent.inc();
        } catch (err) {
          recordFinalDeliveryFailure();
          log.error("stream-relay", `Failed to send message chunk ${i + 1}/${chunks.length}: ${err instanceof Error ? err.message : err}`);
          // If the first chunk fails, skip remaining — partial output missing
          // the beginning would be confusing.  Throw so the queue's error
          // handler can attempt to notify the user.
          if (i === 0) throw new Error(`Failed to deliver response: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Send any files the agent placed in the outbox directory
    if (outboxPath) {
      await sendOutboxFiles(outboxPath, platform);
    }
  } finally {
    stopPeriodicTyping();
    draftScheduler.cancel();
  }
}
