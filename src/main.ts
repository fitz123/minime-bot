import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import {
  createTelegramBot,
  BOT_COMMANDS,
  TELEGRAM_ALLOWED_UPDATES,
  type TelegramBotResult,
} from "./telegram-bot.js";
import { createDiscordBot } from "./discord-bot.js";
import { log, setLogLevel } from "./logger.js";
import { startMetricsServer, stopMetricsServer } from "./metrics.js";
import {
  createTelegramPollingRestartScheduler,
  hasActiveAgentPlatform,
  runTelegramSetupInBackground,
  shouldRestartForTelegramFailure,
  startBotWithRetry,
  stopTelegramBot,
  stopTelegramBotInBackground,
  type TelegramPollingRestartScheduler,
} from "./bot-startup.js";
import { createWatchdog, type Watchdog } from "./polling-watchdog.js";
import { restoreThreadCache, saveThreadCache } from "./message-thread-cache.js";
import { restoreMessageIndex, saveMessageIndex } from "./message-content-index.js";
import { setBotUsername } from "./telegram-adapter.js";
import { getVersion } from "./version.js";
import type { Client } from "discord.js";
import type { MessageQueue } from "./message-queue.js";
import type { EchoWatcher } from "./echo-watcher.js";
import { TELEGRAM_LONG_POLL_TIMEOUT_SECONDS } from "./poll-progress.js";

async function main(): Promise<void> {
  log.info("main", `Bot version: ${getVersion()}`);
  log.info("main", "Loading config...");
  const config = loadConfig();
  if (config.logLevel) {
    setLogLevel(config.logLevel);
  }
  log.info("main", `Config loaded: ${Object.keys(config.agents).length} agents, ${config.bindings.length} Telegram bindings${config.discord ? `, ${config.discord.bindings.length} Discord bindings` : ""}`);

  // Start Prometheus metrics server if configured
  if (config.metricsPort !== undefined) {
    startMetricsServer(config.metricsPort, config.metricsHost);
  }

  // Restore caches from disk (survives restarts)
  restoreThreadCache();
  restoreMessageIndex();

  const sessionManager = new SessionManager(loadConfig);
  log.info("main", "Session manager initialized");

  // Track resources for shutdown
  let telegramBot: TelegramBotResult["bot"] | undefined;
  const messageQueues: MessageQueue[] = [];
  let echoWatcher: EchoWatcher | undefined;
  let discordClient: Client | undefined;
  let watchdog: Watchdog | undefined;
  let telegramStartupTimeout: ReturnType<typeof setTimeout> | undefined;
  let telegramPollingRestart: TelegramPollingRestartScheduler | undefined;

  // Graceful shutdown — registered early so signals during bot startup are handled.
  // Closure captures mutable variables, so shutdown always sees current state.
  const shutdownTimeoutMs = parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? "", 10) || 60_000;

  let shuttingDown = false;
  let requestedExitCode = 0;
  const shutdown = async (signal: string, exitCode = 0) => {
    requestedExitCode = Math.max(requestedExitCode, exitCode);
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("main", `Received ${signal}, shutting down...`);
    if (telegramStartupTimeout) clearTimeout(telegramStartupTimeout);
    telegramPollingRestart?.cancel();
    if (echoWatcher) echoWatcher.stop();
    if (watchdog) watchdog.stop();
    if (telegramBot) {
      stopTelegramBotInBackground(telegramBot, () => {
        log.warn("main", "Telegram stopped without confirming the final update offset; continuing shutdown");
      });
    }
    if (discordClient) discordClient.destroy();
    // Cancel debounce timers BEFORE waiting — telegramBot.stop() prevents new
    // updates, but already-scheduled debounce timers could still fire and start
    // new flush() work during the graceful shutdown wait window.
    for (const mq of messageQueues) mq.cancelAllDebounceTimers();
    // Wait for busy sessions to finish their current turns BEFORE clearing
    // queues — clearAll() runs cleanup callbacks (e.g. temp file deletion)
    // that would break in-flight sessions still reading those files.
    await sessionManager.gracefulShutdown(shutdownTimeoutMs);

    for (const mq of messageQueues) mq.clearAll();

    if (telegramBot) {
      saveThreadCache();
      saveMessageIndex();
    }
    await stopMetricsServer();
    await sessionManager.closeAll();
    log.info("main", "All sessions closed. Exiting.");
    process.exit(requestedExitCode);
  };
  const requestShutdown = (signal: string, exitCode = 0) => {
    void shutdown(signal, exitCode).catch((err) => {
      log.error("main", `Shutdown after ${signal} failed:`, err);
      process.exit(1);
    });
  };
  process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  process.on("SIGINT", () => requestShutdown("SIGINT"));

  // Safety net: log fatal process errors, run best-effort shutdown, then let
  // the supervisor restart us. Continuing after these can leave corrupted state.
  process.on("uncaughtException", (error) => {
    log.error("main", "FATAL uncaught exception:", error);
    requestShutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    log.error("main", "FATAL unhandled rejection:", reason);
    requestShutdown("unhandledRejection", 1);
  });

  // Telegram starts before Discord has finished connecting. Polling failures
  // wait for that startup decision so an auxiliary alert transport cannot take
  // down a healthy conversational platform merely because it failed first.
  let finishAgentPlatformStartup!: () => void;
  const agentPlatformStartup = new Promise<void>((resolve) => {
    finishAgentPlatformStartup = resolve;
  });

  // Start Telegram bot if configured
  if (config.telegramToken) {
    telegramPollingRestart = createTelegramPollingRestartScheduler();
    let telegramPollingGeneration = 0;
    let telegramFailureHandled = true;
    // Mutable reference so onUpdate callback can reach the watchdog
    // (watchdog needs bot.api, which doesn't exist until after createTelegramBot)
    let onUpdateFn: (() => void) | undefined;
    const { bot, messageQueue, echoWatcher: ew, pollProgress, updateProcessing } = createTelegramBot(config, sessionManager, {
      onUpdate: () => onUpdateFn?.(),
      // A failed generation disables this before grammY's final offset
      // confirmation, so cleanup cannot collapse the restart backoff.
      onSuccessfulPoll: () => {
        if (!telegramFailureHandled && !shuttingDown) telegramPollingRestart?.reset();
      },
    });
    telegramBot = bot;
    messageQueues.push(messageQueue);

    function handleTelegramPollingFailure(
      generation: number,
      reason: "startup_timeout" | "polling_failed" | "watchdog_restart",
      error?: unknown,
    ): void {
      if (generation !== telegramPollingGeneration || telegramFailureHandled || shuttingDown) return;
      telegramFailureHandled = true;
      if (telegramStartupTimeout) {
        clearTimeout(telegramStartupTimeout);
        telegramStartupTimeout = undefined;
      }
      watchdog?.stop();
      watchdog = undefined;
      onUpdateFn = undefined;

      void agentPlatformStartup.then(async () => {
        if (shuttingDown) return;
        const restartRequired = shouldRestartForTelegramFailure({
          telegramBindingCount: config.bindings.length,
          discordStarted: Boolean(discordClient),
          discordBindingCount: config.discord?.bindings.length ?? 0,
        });
        if (restartRequired) {
          log.error("main", `Telegram polling unavailable (${reason}) — exiting for restart`, error);
          process.exit(1);
          return;
        }

        log.error(
          "main",
          `Telegram polling unavailable (${reason}); keeping the active conversational platform online`,
          error,
        );
        await stopTelegramBot(bot, () => {
          log.warn("main", "Telegram polling cleanup could not confirm the final update offset");
        });
        if (shuttingDown) return;
        const delayMs = telegramPollingRestart?.schedule(startTelegramPolling);
        if (delayMs !== undefined) {
          log.warn("main", `Retrying Telegram polling in ${delayMs}ms`);
        }
      });
    }

    // Echo watcher: drain accumulated files from when bot was down, then start polling
    echoWatcher = ew;
    echoWatcher.drain();
    echoWatcher.start();

    function startTelegramPolling(): void {
      if (shuttingDown) return;
      const generation = ++telegramPollingGeneration;
      telegramFailureHandled = false;
      let startedSuccessfully = false;

      // A watchdog cannot be reused after it decides to restart, so each
      // supervised polling generation owns a fresh one.
      const cycleWatchdog = createWatchdog({
        pollProgress: () => pollProgress.snapshot(),
        updateProcessing: () => updateProcessing.snapshot(),
        heartbeat: async (signal) => {
          try {
            await bot.api.getMe(signal as Parameters<typeof bot.api.getMe>[0]);
            return true;
          } catch {
            return false;
          }
        },
        exit: () => handleTelegramPollingFailure(generation, "watchdog_restart"),
      });
      watchdog = cycleWatchdog;
      onUpdateFn = () => cycleWatchdog.touch();

      // Set to 120s to accommodate the 409-retry backoff window (~75s worst case).
      telegramStartupTimeout = setTimeout(() => {
        if (!startedSuccessfully) {
          handleTelegramPollingFailure(generation, "startup_timeout");
        }
      }, 120_000);

      log.info("main", "Starting Telegram bot polling...");
      // bot.start() blocks until stopped — run it without awaiting.
      // startBotWithRetry handles 409 Conflict errors (old instance still polling)
      // before the outer supervisor applies its bounded restart backoff.
      void startBotWithRetry(
        () =>
          bot.start({
            timeout: TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
            allowed_updates: TELEGRAM_ALLOWED_UPDATES,
            onStart: (botInfo) => {
              if (generation !== telegramPollingGeneration || telegramFailureHandled || shuttingDown) {
                stopTelegramBotInBackground(bot, () => {
                  log.warn("main", "Telegram polling cleanup could not confirm the final update offset");
                });
                return;
              }
              startedSuccessfully = true;
              if (telegramStartupTimeout) {
                clearTimeout(telegramStartupTimeout);
                telegramStartupTimeout = undefined;
              }
              setBotUsername(botInfo.username);
              log.info("main", `Telegram bot @${botInfo.username} is running (id: ${botInfo.id})`);
              // No global media wipe on startup: grammY invokes onStart before the
              // first getUpdates, so polling ownership isn't proven yet. A blanket
              // wipe here can clobber files that an overlapping old instance is
              // still serving. Orphans from prior runs are reclaimed via per-session
              // cleanupSessionMediaDir on close and enforceMediaCap eviction.
              cycleWatchdog.start();
              // grammY does not begin getUpdates until onStart returns. Command
              // registration is non-critical and autoRetry may wait indefinitely,
              // so keep it off the polling startup path.
              runTelegramSetupInBackground(
                () => bot.api.setMyCommands(BOT_COMMANDS),
                () => log.info("main", "Bot commands registered with Telegram"),
                (err) => log.error("main", "Failed to register bot commands:", err),
              );
            },
          }),
      ).catch((err) => handleTelegramPollingFailure(generation, "polling_failed", err));
    }

    startTelegramPolling();
  }

  // Start Discord bot if configured
  if (config.discord) {
    try {
      const result = await createDiscordBot(config, config.discord, sessionManager);
      discordClient = result.client;
      messageQueues.push(result.messageQueue);
      log.info("main", "Discord bot started");
    } catch (err) {
      log.error("main", "Failed to start Discord bot:", err);
    }
  }

  // Require at least one started transport with a conversational binding.
  if (!hasActiveAgentPlatform({
    telegramStarted: Boolean(telegramBot),
    telegramBindingCount: config.bindings.length,
    discordStarted: Boolean(discordClient),
    discordBindingCount: config.discord?.bindings.length ?? 0,
  })) {
    log.error("main", "No bots started — exiting");
    process.exit(1);
  }
  finishAgentPlatformStartup();
}

main().catch((err) => {
  log.error("main", "Fatal error:", err);
  process.exit(1);
});
