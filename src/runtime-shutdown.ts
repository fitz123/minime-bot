import { stopTelegramBotInBackground } from "./bot-startup.js";

interface StoppableTelegramBot {
  stop(): Promise<void>;
}

interface ShutdownMessageQueue {
  cancelAllDebounceTimers(): void;
  clearAll(): void;
}

interface ShutdownSessionManager {
  gracefulShutdown(timeoutMs: number): Promise<void>;
  closeAll(): Promise<void>;
}

export interface ServingRuntimeShutdownOptions {
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

/** Stop inbound work, drain its handlers, then release serving ownership last. */
export async function shutdownServingRuntime(
  options: ServingRuntimeShutdownOptions,
): Promise<boolean> {
  if (options.telegramBot) {
    stopTelegramBotInBackground(options.telegramBot, options.onTelegramStopError);
  }
  const discordShutdown = options.shutdownDiscord?.().catch(options.onDiscordStopError);

  await Promise.all([
    options.telegramPolling ?? Promise.resolve(),
    discordShutdown ?? Promise.resolve(),
  ]);

  for (const queue of options.messageQueues) queue.cancelAllDebounceTimers();
  await options.sessionManager.gracefulShutdown(options.shutdownTimeoutMs);
  for (const queue of options.messageQueues) queue.clearAll();

  options.persistTransportState?.();
  await options.stopMetrics();
  await options.sessionManager.closeAll();
  return options.releaseRuntimeGuard();
}
