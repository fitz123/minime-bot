import { GrammyError } from "grammy";
import { log } from "./logger.js";

/**
 * Check if an error is a Telegram 409 Conflict error.
 * This happens when another bot instance is already polling.
 */
export function is409ConflictError(err: unknown): boolean {
  // Direct GrammyError
  if (err instanceof GrammyError && err.error_code === 409) return true;

  // BotError wrapping a GrammyError (bot.start() wraps handler errors)
  if (
    err &&
    typeof err === "object" &&
    "error" in err &&
    (err as { error: unknown }).error instanceof GrammyError &&
    ((err as { error: GrammyError }).error).error_code === 409
  ) {
    return true;
  }

  return false;
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  /** Injected sleep for testing — defaults to real setTimeout */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type TimeoutHandle = ReturnType<typeof setTimeout>;

export interface TelegramPollingRestartSchedulerOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => TimeoutHandle;
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
}

export interface TelegramPollingRestartScheduler {
  /** Queue one restart and return its delay, or undefined when one is already queued. */
  schedule(restart: () => void): number | undefined;
  /** Reset exponential backoff after a getUpdates call succeeds. */
  reset(): void;
  /** Cancel a pending restart during shutdown. */
  cancel(): void;
}

/** Keep Telegram polling recoverable without taking down a healthy Discord bot. */
export function createTelegramPollingRestartScheduler(
  options: TelegramPollingRestartSchedulerOptions = {},
): TelegramPollingRestartScheduler {
  const baseDelayMs = Math.max(1, options.baseDelayMs ?? 5_000);
  const maxDelayMs = Math.max(baseDelayMs, options.maxDelayMs ?? 60_000);
  const setTimeoutFn: (callback: () => void, ms: number) => TimeoutHandle =
    options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutFn: (handle: TimeoutHandle) => void =
    options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  let attempt = 0;
  let timer: TimeoutHandle | undefined;

  return {
    schedule(restart) {
      if (timer !== undefined) return undefined;
      const delayMs = Math.min(baseDelayMs * 2 ** Math.min(attempt, 30), maxDelayMs);
      attempt += 1;
      const handle = setTimeoutFn(() => {
        timer = undefined;
        restart();
      }, delayMs);
      timer = handle;
      handle.unref?.();
      return delayMs;
    },
    reset() {
      attempt = 0;
    },
    cancel() {
      if (timer === undefined) return;
      clearTimeoutFn(timer);
      timer = undefined;
    },
  };
}

export interface ActiveAgentPlatformState {
  telegramStarted: boolean;
  telegramBindingCount: number;
  discordStarted: boolean;
  discordBindingCount: number;
}

/** Alert-only transports do not count as a usable conversational platform. */
export function hasActiveAgentPlatform(state: ActiveAgentPlatformState): boolean {
  return (state.telegramStarted && state.telegramBindingCount > 0) ||
    (state.discordStarted && state.discordBindingCount > 0);
}

export interface TelegramFailurePlatformState {
  telegramBindingCount: number;
  discordStarted: boolean;
  discordBindingCount: number;
}

/**
 * Restart only when failed Telegram polling was the sole conversational
 * platform. Alert-only Telegram and deployments with a live Discord platform
 * can keep serving while Telegram polling is unavailable.
 */
export function shouldRestartForTelegramFailure(state: TelegramFailurePlatformState): boolean {
  return state.telegramBindingCount > 0 &&
    !(state.discordStarted && state.discordBindingCount > 0);
}

/**
 * Start non-critical Telegram setup without delaying grammY's first getUpdates.
 * Synchronous throws and rejected promises are routed to the same error callback.
 */
export function runTelegramSetupInBackground(
  task: () => Promise<unknown>,
  onSuccess: () => void,
  onError: (error: unknown) => void,
): void {
  let pending: Promise<unknown>;
  try {
    pending = task();
  } catch (error) {
    onError(error);
    return;
  }
  void pending.then(onSuccess, onError);
}

/**
 * Stop grammY polling immediately without making graceful shutdown wait for
 * its final update-offset confirmation. That confirmation is best-effort and
 * can reject while Telegram is unreachable, so always observe its promise.
 */
export function stopTelegramBotInBackground(
  bot: { stop: () => Promise<void> },
  onError: (error: unknown) => void,
): void {
  void stopTelegramBot(bot, onError);
}

/** Wait until grammY has finished its final update-offset confirmation. */
export async function stopTelegramBot(
  bot: { stop: () => Promise<void> },
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await bot.stop();
  } catch (error) {
    onError(error);
  }
}

/**
 * Start a grammY bot with retry-on-409 logic.
 *
 * When a new bot instance starts before Telegram releases the old long-poll
 * connection, the API returns 409 Conflict. Instead of crashing immediately
 * (which causes a launchd crash-loop), this retries with exponential backoff.
 *
 * @param startFn - Function that starts the bot (typically () => bot.start(opts))
 * @param opts - Retry configuration
 */
export async function startBotWithRetry(
  startFn: () => Promise<void>,
  opts?: RetryOptions,
): Promise<void> {
  const maxRetries = opts?.maxRetries ?? 5;
  const baseDelayMs = opts?.baseDelayMs ?? 5_000;
  const sleep = opts?.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await startFn();
      return;
    } catch (err) {
      if (is409ConflictError(err) && attempt < maxRetries) {
        const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), 60_000);
        log.warn(
          "main",
          `409 Conflict on startup attempt ${attempt}/${maxRetries} — retrying in ${delay / 1000}s`,
        );
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}
