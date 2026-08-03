import { stopTelegramBotInBackground } from "./bot-startup.js";

interface StoppableTelegramBot {
  stop(): Promise<void>;
}

interface ShutdownMessageQueue {
  beginShutdown(): void;
  cancelAllDebounceTimers(): void;
  flushPending(): void;
  waitForIdle(): Promise<void>;
  clearAll(): void;
}

interface ShutdownSessionManager {
  beginShutdown(): void;
  gracefulShutdown(timeoutMs: number): Promise<void>;
  closeAll(): Promise<void>;
}

export interface ServingRuntimeShutdownOptions {
  abortTelegramPolling?: () => void;
  telegramBot?: StoppableTelegramBot;
  telegramPolling?: Promise<void>;
  shutdownDiscord?: () => Promise<void>;
  messageQueues: ShutdownMessageQueue[];
  sessionManager: ShutdownSessionManager;
  shutdownTimeoutMs: number;
  persistTransportState?: () => void;
  stopMetrics(): Promise<void>;
  releaseRuntimeGuard(): boolean;
  onTelegramStopError(error: unknown): void;
  onDiscordStopError(error: unknown): void;
}

class ServingRuntimeShutdownTimeoutError extends Error {
  constructor(readonly phase: string) {
    super(`Serving runtime shutdown timed out during ${phase}`);
    this.name = "ServingRuntimeShutdownTimeoutError";
  }
}

async function waitForShutdownPhase<T>(
  startWork: () => Promise<T>,
  deadline: number,
  phase: string,
): Promise<T> {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new ServingRuntimeShutdownTimeoutError(phase);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      startWork(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ServingRuntimeShutdownTimeoutError(phase)),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function forceShutdownCleanup(options: ServingRuntimeShutdownOptions): Promise<void> {
  const failures: unknown[] = [];
  const phaseTimeoutMs = Math.min(10_000, Math.max(1, options.shutdownTimeoutMs));
  const attempt = (work: () => void): void => {
    try {
      work();
    } catch (error) {
      failures.push(error);
    }
  };
  const attemptAsync = async (work: () => Promise<void>, phase: string): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new ServingRuntimeShutdownTimeoutError(phase)),
            phaseTimeoutMs,
          );
        }),
      ]);
    } catch (error) {
      failures.push(error);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  };

  for (const queue of options.messageQueues) attempt(() => queue.beginShutdown());
  attempt(() => options.sessionManager.beginShutdown());
  for (const queue of options.messageQueues) attempt(() => queue.cancelAllDebounceTimers());
  for (const queue of options.messageQueues) attempt(() => queue.clearAll());
  if (options.persistTransportState) attempt(options.persistTransportState);
  await attemptAsync(() => options.sessionManager.closeAll(), "forced session close");
  await attemptAsync(() => options.stopMetrics(), "forced metrics stop");
  attempt(() => { options.releaseRuntimeGuard(); });

  if (failures.length > 0) {
    throw new AggregateError(failures, "Serving runtime forced cleanup failed");
  }
}

/** Stop inbound work, drain its handlers, then release serving ownership last. */
export async function shutdownServingRuntime(
  options: ServingRuntimeShutdownOptions,
): Promise<boolean> {
  const deadline = Date.now() + Math.max(1, options.shutdownTimeoutMs);
  options.abortTelegramPolling?.();
  if (options.telegramBot) {
    stopTelegramBotInBackground(options.telegramBot, options.onTelegramStopError);
  }
  const discordShutdown = options.shutdownDiscord?.().catch(options.onDiscordStopError);
  try {
    await waitForShutdownPhase(
      () => Promise.all([
        options.telegramPolling ?? Promise.resolve(),
        discordShutdown ?? Promise.resolve(),
      ]).then(() => undefined),
      deadline,
      "transport drain",
    );

    for (const queue of options.messageQueues) queue.beginShutdown();
    for (const queue of options.messageQueues) queue.flushPending();
    await waitForShutdownPhase(
      () => options.sessionManager.gracefulShutdown(Math.max(1, deadline - Date.now())),
      deadline,
      "session drain",
    );
    await waitForShutdownPhase(
      () => Promise.all(options.messageQueues.map((queue) => queue.waitForIdle())).then(() => undefined),
      deadline,
      "queue drain",
    );

    options.sessionManager.beginShutdown();
    for (const queue of options.messageQueues) queue.clearAll();
    options.persistTransportState?.();
    await waitForShutdownPhase(
      () => options.sessionManager.closeAll(),
      deadline,
      "session close",
    );
    await waitForShutdownPhase(() => options.stopMetrics(), deadline, "metrics stop");
    return options.releaseRuntimeGuard();
  } catch (error) {
    try {
      await forceShutdownCleanup(options);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Serving runtime shutdown failed and forced cleanup was incomplete",
      );
    }
    throw error;
  }
}
