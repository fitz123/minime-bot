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

/**
 * Attempt native steering and resolve true only after correlated consumption.
 * `onEnqueued` fires after atomic child-side enqueue acceptance so the queue can
 * offer the next entry without transferring ownership early.
 */
export type AcknowledgedSteerFn = (
  chatId: string,
  agentId: string,
  text: string,
  onEnqueued?: () => void,
) => Promise<boolean>;

/** Deliver any durable non-model recovery notice after lane preparation. */
export type RecoveryNoticeFn = (
  chatId: string,
  agentId: string,
  platform: PlatformContext,
) => Promise<void>;

/** Prepare the lane before notice delivery; failures stop prompt processing. */
export type PrepareSessionFn = (
  chatId: string,
  agentId: string,
) => Promise<void>;

/** Fire-and-forget cleanup callback (e.g. delete a temp file after processing). */
export type CleanupFn = () => void;

interface CollectEntry {
  text: string;
  cleanup?: CleanupFn;
  dropCleanup?: CleanupFn;
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
  /** Exact entry currently waiting for correlated enqueue acceptance. */
  steerSubmitting: CollectEntry | null;
  /** Entries submitted to Pi whose consumption result is still pending. */
  steerPending: Set<CollectEntry>;
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
  private acceptingMessages = true;
  private activeFlushes = new Set<Promise<void>>();
  private debounceMs: number;
  private queueCap: number;
  private processFn: ProcessFn;
  private acknowledgedSteerFn?: AcknowledgedSteerFn;
  private prepareSessionFn?: PrepareSessionFn;
  private recoveryNoticeFn?: RecoveryNoticeFn;

  constructor(
    processFn: ProcessFn,
    options?: {
      debounceMs?: number;
      queueCap?: number;
      acknowledgedSteerFn?: AcknowledgedSteerFn;
      prepareSessionFn?: PrepareSessionFn;
      recoveryNoticeFn?: RecoveryNoticeFn;
    },
  ) {
    this.processFn = processFn;
    this.debounceMs = options?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.queueCap = options?.queueCap ?? DEFAULT_QUEUE_CAP;
    this.acknowledgedSteerFn = options?.acknowledgedSteerFn;
    this.prepareSessionFn = options?.prepareSessionFn;
    this.recoveryNoticeFn = options?.recoveryNoticeFn;
  }

  private async deliverRecoveryNotice(
    chatId: string,
    agentId: string,
    platform: PlatformContext,
  ): Promise<void> {
    if (!this.recoveryNoticeFn) return;
    try {
      await this.recoveryNoticeFn(chatId, agentId, platform);
    } catch (err) {
      // Notice delivery is durable and retried on the next processing boundary.
      // It must never strand the user message that caused the replacement.
      log.warn("message-queue", `Recovery notice delivery failed for ${chatId}:`, err);
    }
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
        steerSubmitting: null,
        steerPending: new Set(),
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
    if (!this.acceptingMessages) {
      this.runCleanups([cleanup, dropCleanup]);
      return;
    }
    const state = this.getState(chatId, agentId);
    state.latestPlatform = platform;

    if (state.busy) {
      if (state.collectEntries.length < this.queueCap) {
        state.collectEntries.push({
          text,
          cleanup,
          dropCleanup,
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
      this.startFlush(chatId);
    }, this.debounceMs);
  }

  private startFlush(chatId: string): void {
    const pending = this.flush(chatId);
    this.activeFlushes.add(pending);
    void pending.then(
      () => { this.activeFlushes.delete(pending); },
      (err) => {
        this.activeFlushes.delete(pending);
        log.error("message-queue", `Flush error for ${chatId}:`, err);
      },
    );
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
    const platform = state.latestPlatform;

    // Start pre-stream typing indicator (covers session spawn, queue wait, thinking phase)
    // relayStream() will clear this timer on handoff and start its own
    this.startPreStreamTyping(platform);

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
      if (platform) {
        try {
          await this.prepareSessionFn?.(chatId, state.agentId);
          if (this.queues.get(chatId) === state) {
            await this.deliverRecoveryNotice(chatId, state.agentId, platform);
          }
          if (this.queues.get(chatId) === state) {
            await this.processFn(chatId, state.agentId, combinedText, platform, transferOwnership);
          }
        } finally {
          this.settleBusyGeneration(state);
        }
      } else {
        this.settleBusyGeneration(state);
      }
    } catch (err) {
      log.error("message-queue", `Send error for ${chatId}:`, err);
      if (this.queues.get(chatId) === state && platform) {
        await platform
          .replyError(`Something went wrong: ${err instanceof Error ? err.message : String(err)}\n\nTry again or /reconnect the session.`)
          .catch(() => {});
      }
    } finally {
      this.stopPreStreamTyping(platform);
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
      const collected = entries.map(({ text }) => text);
      const cleanups = entries.map(({ cleanup }) => cleanup);
      // Hold drop cleanups locally for exactly this batch. If processFn
      // throws or the queue is cleared mid-drain, we must run them. Any
      // drop cleanups added during processing (new mid-turn collect) stay
      // in state — they'll be processed on the next loop iteration, or
      // handled by clear().
      const dropCleanups = entries.map(({ dropCleanup }) => dropCleanup);
      const prompt = buildCollectPrompt(collected);
      const platform = state.latestPlatform;

      this.beginBusyGeneration(state);
      log.debug(
        "message-queue",
        `Draining ${collected.length} collected message(s) for ${chatId}`,
      );

      this.startPreStreamTyping(platform);

      let liveDropCleanups: Array<CleanupFn | undefined> | null = dropCleanups;
      const transferOwnership = () => {
        if (this.queues.get(chatId) !== state) return;
        liveDropCleanups = null;
      };

      try {
        if (platform) {
          try {
            await this.prepareSessionFn?.(chatId, state.agentId);
            if (this.queues.get(chatId) === state) {
              await this.deliverRecoveryNotice(chatId, state.agentId, platform);
            }
            if (this.queues.get(chatId) === state) {
              await this.processFn(chatId, state.agentId, prompt, platform, transferOwnership);
            }
          } finally {
            this.settleBusyGeneration(state);
          }
        } else {
          this.settleBusyGeneration(state);
        }
      } catch (err) {
        log.error("message-queue", `Collect drain error for ${chatId}:`, err);
        if (this.queues.get(chatId) === state && platform) {
          await platform
            .replyError(`Something went wrong: ${err instanceof Error ? err.message : String(err)}\n\nTry again or /reconnect the session.`)
            .catch(() => {});
        }
      } finally {
        this.stopPreStreamTyping(platform);
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
    state.steerSubmitting = null;
    state.steerPending.clear();
    state.steerBlocked = false;
  }

  private settleBusyGeneration(state: ChatQueueState): void {
    state.steerSubmitting = null;
    state.steerPending.clear();
    state.steerBlocked = true;
  }

  private attemptAcknowledgedSteer(chatId: string, state: ChatQueueState): void {
    if (
      !this.acknowledgedSteerFn ||
      this.queues.get(chatId) !== state ||
      !state.busy ||
      state.steerBlocked ||
      state.steerSubmitting
    ) {
      return;
    }

    const entry = state.collectEntries.find(
      (candidate) => !state.steerPending.has(candidate),
    );
    if (!entry) return;

    state.steerSubmitting = entry;
    state.steerPending.add(entry);

    let acknowledgement: Promise<boolean>;
    try {
      acknowledgement = this.acknowledgedSteerFn(
        chatId,
        state.agentId,
        entry.text,
        () => this.finishSteerEnqueue(chatId, state, entry),
      );
    } catch {
      this.finishAcknowledgedSteer(chatId, state, entry, false);
      return;
    }

    void acknowledgement.then(
      (acknowledged) => {
        this.finishAcknowledgedSteer(chatId, state, entry, acknowledged);
      },
      () => {
        this.finishAcknowledgedSteer(chatId, state, entry, false);
      },
    );
  }

  private finishSteerEnqueue(
    chatId: string,
    state: ChatQueueState,
    entry: CollectEntry,
  ): void {
    if (
      this.queues.get(chatId) !== state ||
      !state.busy ||
      state.steerBlocked ||
      state.steerSubmitting !== entry ||
      !state.steerPending.has(entry) ||
      !state.collectEntries.includes(entry)
    ) {
      return;
    }

    state.steerSubmitting = null;
    this.attemptAcknowledgedSteer(chatId, state);
  }

  private finishAcknowledgedSteer(
    chatId: string,
    state: ChatQueueState,
    entry: CollectEntry,
    acknowledged: boolean,
  ): void {
    if (
      this.queues.get(chatId) !== state ||
      !state.busy ||
      !state.steerPending.has(entry)
    ) {
      return;
    }

    state.steerPending.delete(entry);
    if (state.steerSubmitting === entry) {
      state.steerSubmitting = null;
    }
    if (!acknowledged) {
      state.steerBlocked = true;
      return;
    }

    const entryIndex = state.collectEntries.indexOf(entry);
    if (entryIndex === -1) return;
    state.collectEntries.splice(entryIndex, 1);
    this.runCleanups([entry.cleanup]);
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

  /** Stop accepting messages and prevent pending debounce work from starting. */
  beginShutdown(): void {
    this.acceptingMessages = false;
    this.cancelAllDebounceTimers();
  }

  /** Start all accepted debounce work immediately during graceful shutdown. */
  flushPending(): void {
    for (const [chatId, state] of this.queues) {
      if (state.pendingTexts.length > 0 && !state.busy) {
        this.startFlush(chatId);
      }
    }
  }

  /** Wait for flushes that started before shutdown admission closed. */
  async waitForIdle(): Promise<void> {
    while (this.activeFlushes.size > 0) {
      await Promise.allSettled([...this.activeFlushes]);
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
    state.steerSubmitting = null;
    state.steerPending.clear();
    state.steerBlocked = true;
    const entries = state.collectEntries.splice(0);
    for (const entry of entries) {
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
