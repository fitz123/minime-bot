import type { PlatformContext } from "./types.js";
import { log } from "./logger.js";
import {
  recordMessageQueueRejectionNotice,
  recordMessageQueueSaturation,
  type MessageQueueBuffer,
} from "./metrics.js";

export const DEFAULT_DEBOUNCE_MS = 3000;
export const DEFAULT_QUEUE_CAP = 20;
export const DEFAULT_REJECTION_NOTICE_COOLDOWN_MS = 30_000;
export const QUEUE_REJECTION_MESSAGE =
  "Message queue full: messages received while it is full are not processed. Please resend them later.";

/**
 * Callback that sends combined text to the active agent and relays the response.
 * Called by the queue when debounce expires or collect buffer drains.
 *
 * `onAgentOwnership` MUST be invoked once the agent has accepted the prompt
 * (the conversation history now references any media paths in the text). After
 * that point, even if response relay fails, persistent media must NOT be
 * discarded — the agent owns it for the rest of the session.
 */
export type ProcessFn = (
  chatId: string,
  agentId: string,
  text: string,
  platform: PlatformContext,
  onAgentOwnership: () => void,
) => Promise<void>;

/** Attempt native steering and resolve true only after correlated acceptance. */
export type AcknowledgedSteerFn = (
  chatId: string,
  agentId: string,
  text: string,
) => Promise<boolean>;

/** Fire-and-forget cleanup callback (e.g. delete a temp file after processing). */
export type CleanupFn = () => void;

type CollectEntryState = "queued" | "steering" | "fallback" | "transferred" | "dropped";

interface CollectEntry {
  id: number;
  text: string;
  cleanup?: CleanupFn;
  dropCleanup?: CleanupFn;
  state: CollectEntryState;
}

interface ChatQueueState {
  /** Messages pending debounce timer (pre-send) */
  pendingTexts: string[];
  /** Cleanup callbacks for pending messages (fire on successful delivery) */
  pendingCleanups: CleanupFn[];
  /**
   * Drop-only cleanup callbacks for pending messages. Fire when the message
   * is rejected (cap exceeded) or the queue is cleared (/reconnect, /clean).
   * Discarded on successful flush — the session will own the file and clean
   * it up on close. Used for persistent media that must outlive the turn.
   */
  pendingDropCleanups: CleanupFn[];
  debounceTimer: ReturnType<typeof setTimeout> | null;

  /** Bot-owned messages collected during active processing (mid-turn). */
  collectEntries: CollectEntry[];

  /** Whether a message is currently being processed */
  busy: boolean;
  /** Monotonic token invalidating steer callbacks after the current turn settles. */
  busyGeneration: number;
  /** Exact head entry currently waiting for correlated acceptance. */
  steerInFlight: { generation: number; entryId: number } | null;
  /** Stop attempting later entries after the first failure in this busy turn. */
  steerBlocked: boolean;

  /** Latest platform context for sending responses */
  latestPlatform: PlatformContext | null;

  /** Agent ID for this chat */
  agentId: string;

  /** Earliest time another user-visible saturation notice may be sent. */
  nextRejectionNoticeAt: number;
  /** A microtask notice waiting to be dispatched; clear() can cancel it. */
  rejectionNoticeScheduled: boolean;
  /** Releases idle cooldown-only state without retaining it indefinitely. */
  rejectionCooldownTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Build a collect prompt from queued messages.
 * Single message is returned as-is; multiple messages get a header and separators.
 */
export function buildCollectPrompt(texts: string[]): string {
  if (texts.length === 1) return texts[0];

  const lines = ["[Queued messages while agent was busy]"];
  for (let i = 0; i < texts.length; i++) {
    lines.push("---");
    lines.push(`Queued #${i + 1}`);
    lines.push(texts[i]);
  }
  return lines.join("\n");
}

/**
 * Per-chat message queue with pre-send debounce and mid-turn collect.
 *
 * Pre-send debounce: messages arriving within debounceMs are concatenated
 * into a single prompt before sending to the agent.
 *
 * Mid-turn collect: messages arriving while the agent is processing are buffered
 * and delivered as a combined followup when the current turn completes.
 */
export class MessageQueue {
  private queues = new Map<string, ChatQueueState>();
  private debounceMs: number;
  private queueCap: number;
  private processFn: ProcessFn;
  private acknowledgedSteerFn?: AcknowledgedSteerFn;
  private nextCollectEntryId = 1;

  constructor(
    processFn: ProcessFn,
    options?: {
      debounceMs?: number;
      queueCap?: number;
      acknowledgedSteerFn?: AcknowledgedSteerFn;
    },
  ) {
    this.processFn = processFn;
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.queueCap = options?.queueCap ?? DEFAULT_QUEUE_CAP;
    this.acknowledgedSteerFn = options?.acknowledgedSteerFn;
  }

  private getState(chatId: string, agentId: string): ChatQueueState {
    let state = this.queues.get(chatId);
    if (!state) {
      state = {
        pendingTexts: [],
        pendingCleanups: [],
        pendingDropCleanups: [],
        debounceTimer: null,
        collectEntries: [],
        busy: false,
        busyGeneration: 0,
        steerInFlight: null,
        steerBlocked: false,
        latestPlatform: null,
        agentId,
        nextRejectionNoticeAt: 0,
        rejectionNoticeScheduled: false,
        rejectionCooldownTimer: null,
      };
      this.queues.set(chatId, state);
    }
    if (state.rejectionCooldownTimer) {
      clearTimeout(state.rejectionCooldownTimer);
      state.rejectionCooldownTimer = null;
    }
    state.agentId = agentId;
    return state;
  }

  /**
   * Enqueue a message for a chat. Handles debouncing and mid-turn collect.
   * Fire-and-forget: returns immediately, processing happens in background.
   *
   * `cleanup` runs when the message is consumed (successful delivery or rejection)
   * and is the right hook for turn-scoped temp files.
   *
   * `dropCleanup` runs only on rejection/clear paths (cap exceeded, /reconnect,
   * /clean). It is discarded on successful delivery so the callee can own the
   * file for the session lifetime (persistent media). Use this for downloads
   * that must survive the turn but be reclaimed if the message never reaches
   * an agent.
   */
  enqueue(
    chatId: string,
    agentId: string,
    text: string,
    platform: PlatformContext,
    cleanup?: CleanupFn,
    dropCleanup?: CleanupFn,
  ): void {
    const state = this.getState(chatId, agentId);
    state.latestPlatform = platform;

    if (state.busy) {
      if (state.collectEntries.length < this.queueCap) {
        state.collectEntries.push({
          id: this.nextCollectEntryId++,
          text,
          cleanup,
          dropCleanup,
          state: "queued",
        });

        log.debug(
          "message-queue",
          `Queued mid-turn message for ${chatId} (${state.collectEntries.length} in buffer)`,
        );
        this.attemptAcknowledgedSteer(chatId, state);
      } else {
        this.rejectSaturatedInput(chatId, state, "collect", platform, cleanup, dropCleanup);
      }
      return;
    }

    // Pre-send debounce: add to pending and reset timer
    if (state.pendingTexts.length >= this.queueCap) {
      this.rejectSaturatedInput(chatId, state, "debounce", platform, cleanup, dropCleanup);
      return;
    }
    state.pendingTexts.push(text);
    state.pendingCleanups.push(cleanup ?? (() => {}));
    state.pendingDropCleanups.push(dropCleanup ?? (() => {}));

    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
    }

    state.debounceTimer = setTimeout(() => {
      this.flush(chatId).catch((err) => {
        log.error("message-queue", `Flush error for ${chatId}:`, err);
      });
    }, this.debounceMs);
  }

  private async flush(chatId: string): Promise<void> {
    const state = this.queues.get(chatId);
    if (!state || state.pendingTexts.length === 0) return;

    const texts = state.pendingTexts.splice(0);
    const cleanups = state.pendingCleanups.splice(0);
    // Hold drop cleanups locally during processing. If processFn throws, or
    // the queue is cleared mid-process, we must run them so persistent media
    // doesn't leak on disk. Splicing out of state now also means clear()'s
    // own drop-cleanup loop won't double-fire them.
    const dropCleanups = state.pendingDropCleanups.splice(0);
    state.debounceTimer = null;
    this.beginBusyGeneration(state);

    const combinedText = texts.length === 1 ? texts[0] : texts.join("\n\n");

    // Start pre-stream typing indicator (covers session spawn, queue wait, thinking phase)
    // relayStream() will clear this timer on handoff and start its own
    this.startPreStreamTyping(state.latestPlatform);

    // Mutable holder so onAgentOwnership can drop the cleanups: once the
    // agent has accepted the prompt, the conversation references any media
    // paths and we must never reclaim them via drop cleanup, even if the
    // response relay fails afterward (issue #99 regression vector). If the
    // queue was cleared before ownership transferred (/reconnect, /clean),
    // ignore the signal — the session is being torn down and drop cleanups
    // must still run.
    let liveDropCleanups: CleanupFn[] | null = dropCleanups;
    const transferOwnership = () => {
      if (this.queues.get(chatId) !== state) return;
      liveDropCleanups = null;
    };

    try {
      if (state.latestPlatform) {
        try {
          await this.processFn(chatId, state.agentId, combinedText, state.latestPlatform, transferOwnership);
        } finally {
          this.settleBusyGeneration(state);
        }
      } else {
        this.settleBusyGeneration(state);
      }
    } catch (err) {
      log.error("message-queue", `Send error for ${chatId}:`, err);
      if (this.queues.get(chatId) === state && state.latestPlatform) {
        await state.latestPlatform
          .replyError(`Something went wrong: ${err instanceof Error ? err.message : String(err)}\n\nTry again or /reconnect the session.`)
          .catch(() => {});
      }
    } finally {
      this.stopPreStreamTyping(state.latestPlatform);
      this.runCleanups(cleanups);
    }

    // If transferOwnership() fired, liveDropCleanups is null and we skip — the
    // session now owns the media for its full lifetime, even if response relay
    // failed afterward. Otherwise (queue cleared, processFn threw before
    // ownership, or processFn returned without ever taking ownership): the
    // agent never claimed the media, reclaim it.
    const queueCleared = this.queues.get(chatId) !== state;
    if (liveDropCleanups) {
      this.runCleanups(liveDropCleanups);
    }
    if (queueCleared) return;

    state.busy = false;

    // Drain collect buffer if messages arrived during processing
    await this.drainCollectBuffer(chatId);

    // Evict idle state to prevent unbounded memory growth from stale entries
    this.evictIfIdle(chatId);
  }

  private async drainCollectBuffer(chatId: string): Promise<void> {
    const state = this.queues.get(chatId);
    if (!state || state.collectEntries.length === 0) return;

    // Loop to drain messages that arrive during processing (avoids recursion)
    while (state.collectEntries.length > 0) {
      const entries = state.collectEntries.splice(0);
      for (const entry of entries) entry.state = "fallback";
      const collected = entries.map(({ text }) => text);
      const cleanups = entries.map(({ cleanup }) => cleanup);
      // Hold drop cleanups locally for exactly this batch. If processFn
      // throws or the queue is cleared mid-drain, we must run them. Any
      // drop cleanups added during processing (new mid-turn collect) stay
      // in state — they'll be processed on the next loop iteration, or
      // handled by clear().
      const dropCleanups = entries.map(({ dropCleanup }) => dropCleanup);
      const prompt = buildCollectPrompt(collected);

      this.beginBusyGeneration(state);
      log.debug(
        "message-queue",
        `Draining ${collected.length} collected message(s) for ${chatId}`,
      );

      this.startPreStreamTyping(state.latestPlatform);

      let liveDropCleanups: Array<CleanupFn | undefined> | null = dropCleanups;
      const transferOwnership = () => {
        if (this.queues.get(chatId) !== state) return;
        liveDropCleanups = null;
      };

      try {
        if (state.latestPlatform) {
          try {
            await this.processFn(chatId, state.agentId, prompt, state.latestPlatform, transferOwnership);
          } finally {
            this.settleBusyGeneration(state);
          }
        } else {
          this.settleBusyGeneration(state);
        }
      } catch (err) {
        log.error("message-queue", `Collect drain error for ${chatId}:`, err);
        if (this.queues.get(chatId) === state && state.latestPlatform) {
          await state.latestPlatform
            .replyError(`Something went wrong: ${err instanceof Error ? err.message : String(err)}\n\nTry again or /reconnect the session.`)
            .catch(() => {});
        }
      } finally {
        this.stopPreStreamTyping(state.latestPlatform);
        this.runCleanups(cleanups);
      }

      const queueCleared = this.queues.get(chatId) !== state;
      if (liveDropCleanups) {
        this.runCleanups(liveDropCleanups);
      }
      if (queueCleared) return;

      state.busy = false;
    }
  }

  private beginBusyGeneration(state: ChatQueueState): void {
    state.busy = true;
    state.busyGeneration++;
    state.steerInFlight = null;
    state.steerBlocked = false;
  }

  private settleBusyGeneration(state: ChatQueueState): void {
    const inFlight = state.steerInFlight;
    if (inFlight) {
      const entry = state.collectEntries.find(({ id }) => id === inFlight.entryId);
      if (entry?.state === "steering") entry.state = "queued";
    }
    state.busyGeneration++;
    state.steerInFlight = null;
    state.steerBlocked = true;
  }

  private attemptAcknowledgedSteer(chatId: string, state: ChatQueueState): void {
    if (
      !this.acknowledgedSteerFn ||
      this.queues.get(chatId) !== state ||
      !state.busy ||
      state.steerBlocked ||
      state.steerInFlight
    ) {
      return;
    }

    const entry = state.collectEntries[0];
    if (!entry || entry.state !== "queued") return;

    const generation = state.busyGeneration;
    entry.state = "steering";
    state.steerInFlight = { generation, entryId: entry.id };

    let acknowledgement: Promise<boolean>;
    try {
      acknowledgement = this.acknowledgedSteerFn(chatId, state.agentId, entry.text);
    } catch {
      this.finishAcknowledgedSteer(chatId, state, generation, entry.id, false);
      return;
    }

    void acknowledgement.then(
      (acknowledged) => {
        this.finishAcknowledgedSteer(chatId, state, generation, entry.id, acknowledged);
      },
      () => {
        this.finishAcknowledgedSteer(chatId, state, generation, entry.id, false);
      },
    );
  }

  private finishAcknowledgedSteer(
    chatId: string,
    state: ChatQueueState,
    generation: number,
    entryId: number,
    acknowledged: boolean,
  ): void {
    if (
      this.queues.get(chatId) !== state ||
      !state.busy ||
      state.busyGeneration !== generation ||
      state.steerInFlight?.generation !== generation ||
      state.steerInFlight.entryId !== entryId
    ) {
      return;
    }

    const entry = state.collectEntries[0];
    if (!entry || entry.id !== entryId || entry.state !== "steering") return;

    state.steerInFlight = null;
    if (!acknowledged) {
      entry.state = "queued";
      state.steerBlocked = true;
      return;
    }

    state.collectEntries.shift();
    entry.state = "transferred";
    this.runCleanups([entry.cleanup]);
    entry.dropCleanup = undefined;
    this.attemptAcknowledgedSteer(chatId, state);
  }

  /** Check if a chat is currently busy processing. */
  isBusy(chatId: string): boolean {
    return this.queues.get(chatId)?.busy ?? false;
  }

  /** Get pending debounce message count. */
  getPendingCount(chatId: string): number {
    return this.queues.get(chatId)?.pendingTexts.length ?? 0;
  }

  /** Get mid-turn collect buffer count. */
  getCollectCount(chatId: string): number {
    return this.queues.get(chatId)?.collectEntries.length ?? 0;
  }

  /** Clear a chat's queue state (e.g., on /reconnect). */
  clear(chatId: string): void {
    const state = this.queues.get(chatId);
    if (state) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
      if (state.rejectionCooldownTimer) {
        clearTimeout(state.rejectionCooldownTimer);
      }
      state.rejectionNoticeScheduled = false;
      this.runCleanups(state.pendingCleanups);
      this.runCleanups(state.pendingDropCleanups);
      this.dropCollectEntries(state);
      this.queues.delete(chatId);
    }
  }

  /**
   * Cancel all pending debounce timers without running cleanups or clearing queues.
   * Call before gracefulShutdown() to prevent new flushes from starting during
   * the shutdown wait window.
   */
  cancelAllDebounceTimers(): void {
    for (const state of this.queues.values()) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
        state.debounceTimer = null;
      }
    }
  }

  /** Clear all queues (for shutdown). */
  clearAll(): void {
    for (const [chatId, state] of this.queues) {
      if (state.debounceTimer) {
        clearTimeout(state.debounceTimer);
      }
      if (state.rejectionCooldownTimer) {
        clearTimeout(state.rejectionCooldownTimer);
      }
      state.rejectionNoticeScheduled = false;
      this.runCleanups(state.pendingCleanups);
      this.runCleanups(state.pendingDropCleanups);
      this.dropCollectEntries(state);
    }
    this.queues.clear();
  }

  private dropCollectEntries(state: ChatQueueState): void {
    const entries = state.collectEntries.splice(0);
    for (const entry of entries) {
      entry.state = "dropped";
      this.runCleanups([entry.cleanup, entry.dropCleanup]);
    }
  }

  /** Start pre-stream typing indicator on the platform context. */
  private startPreStreamTyping(platform: PlatformContext | null): void {
    if (!platform?.typingIndicator) return;
    platform.sendTyping().catch(() => {});
    platform.preStreamTypingTimer = setInterval(() => {
      platform.sendTyping().catch(() => {});
    }, platform.typingIntervalMs);
  }

  /** Stop pre-stream typing if relayStream didn't already clear it (error/cancel path). */
  private stopPreStreamTyping(platform: PlatformContext | null): void {
    if (platform?.preStreamTypingTimer) {
      clearInterval(platform.preStreamTypingTimer);
      platform.preStreamTypingTimer = undefined;
    }
  }

  /** Reject one over-cap input and coalesce burst notifications per chat. */
  private rejectSaturatedInput(
    chatId: string,
    state: ChatQueueState,
    buffer: MessageQueueBuffer,
    platform: PlatformContext,
    cleanup?: CleanupFn,
    dropCleanup?: CleanupFn,
  ): void {
    this.runCleanups([cleanup, dropCleanup]);
    recordMessageQueueSaturation(buffer);
    log.warn("message-queue", `Rejected input because the ${buffer} buffer is full`);

    const now = Date.now();
    if (state.rejectionNoticeScheduled || now < state.nextRejectionNoticeAt) {
      recordMessageQueueRejectionNotice(buffer, "rate_limited");
      return;
    }

    state.rejectionNoticeScheduled = true;
    state.nextRejectionNoticeAt = now + DEFAULT_REJECTION_NOTICE_COOLDOWN_MS;

    queueMicrotask(() => {
      if (this.queues.get(chatId) !== state || !state.rejectionNoticeScheduled) return;
      state.rejectionNoticeScheduled = false;

      Promise.resolve()
        .then(() => platform.replyError(QUEUE_REJECTION_MESSAGE))
        .then(
          () => recordMessageQueueRejectionNotice(buffer, "sent"),
          () => {
            recordMessageQueueRejectionNotice(buffer, "failed");
            log.warn("message-queue", "Failed to send queue rejection notice");
          },
        );
    });
  }

  /** Run each provided cleanup once and isolate failures from sibling cleanup. */
  private runCleanups(cleanups: Array<CleanupFn | undefined>): void {
    for (const cleanup of cleanups) {
      if (!cleanup) continue;
      try {
        cleanup();
      } catch {
        log.warn("message-queue", "Message cleanup failed");
      }
    }
  }

  /** Remove idle queue state, retaining only a bounded saturation cooldown. */
  private evictIfIdle(chatId: string): void {
    const state = this.queues.get(chatId);
    if (
      state &&
      !state.busy &&
      state.pendingTexts.length === 0 &&
      state.collectEntries.length === 0 &&
      !state.debounceTimer
    ) {
      const cooldownRemaining = state.nextRejectionNoticeAt - Date.now();
      if (cooldownRemaining <= 0) {
        this.queues.delete(chatId);
        return;
      }

      // Do not retain the latest platform/context solely for rate limiting.
      state.latestPlatform = null;
      if (state.rejectionCooldownTimer === null) {
        state.rejectionCooldownTimer = setTimeout(() => {
          state.rejectionCooldownTimer = null;
          this.evictIfIdle(chatId);
        }, cooldownRemaining);
      }
    }
  }
}
