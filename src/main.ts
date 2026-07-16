import { loadConfig } from "./config.js";
import { SessionManager } from "./session-manager.js";
import {
  createTelegramBot,
  BOT_COMMANDS,
  TAVILY_DURABLE_DELIVERY,
  TELEGRAM_ALLOWED_UPDATES,
  type TelegramBotResult,
} from "./telegram-bot.js";
import { createDiscordBot } from "./discord-bot.js";
import { log, setLogLevel } from "./logger.js";
import { startMetricsServer, stopMetricsServer } from "./metrics.js";
import {
  runTelegramSetupInBackground,
  startBotWithRetry,
  stopTelegramBotInBackground,
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
import { resolveWorkspaceContract } from "./workspace-contract.js";
import { readTavilyApiKeyFromSops } from "./pi-extensions/tavily-secret.js";
import { TavilyMonitor } from "./tavily-monitor.js";
import {
  resolveTavilyDeliveryDestination,
  TavilyMonitorRuntime,
} from "./tavily-monitor-runtime.js";

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
  let tavilyRuntime: TavilyMonitorRuntime | undefined;

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
    if (echoWatcher) echoWatcher.stop();
    if (watchdog) watchdog.stop();
    const tavilyStop = tavilyRuntime?.stop();
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
    await tavilyStop;
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

  const controlWorkspaceRoot = resolveWorkspaceContract().paths.controlWorkspaceRoot;
  const tavilyMonitor = new TavilyMonitor({
    controlWorkspaceRoot,
    apiKey: readTavilyApiKeyFromSops({ controlWorkspaceRoot }),
  });
  const telegramConfigured = Boolean(config.telegramToken && config.bindings.length > 0);
  tavilyRuntime = new TavilyMonitorRuntime({
    monitor: tavilyMonitor,
    destination: telegramConfigured ? resolveTavilyDeliveryDestination(config) : undefined,
    deliver: async (payload) => {
      if (!telegramBot) {
        throw { error_code: 400 };
      }
      const sendOptions = {
        ...(payload.threadId === undefined ? {} : { message_thread_id: payload.threadId }),
        ...(payload.replyMarkup === undefined ? {} : { reply_markup: payload.replyMarkup }),
        [TAVILY_DURABLE_DELIVERY]: true,
      } as Parameters<typeof telegramBot.api.sendMessage>[2] & {
        [TAVILY_DURABLE_DELIVERY]: true;
      };
      await telegramBot.api.sendMessage(payload.chatId, payload.text, sendOptions);
    },
    onError: () => log.error("main", "Tavily monitor transition failed"),
  });

  // Start Telegram bot if configured
  if (config.telegramToken && config.bindings.length > 0) {
    // Mutable reference so onUpdate callback can reach the watchdog
    // (watchdog needs bot.api, which doesn't exist until after createTelegramBot)
    let onUpdateFn: (() => void) | undefined;
    const { bot, messageQueue, echoWatcher: ew, pollProgress, updateProcessing } = createTelegramBot(config, sessionManager, {
      onUpdate: () => onUpdateFn?.(),
      tavilyActions: tavilyRuntime,
    });
    telegramBot = bot;
    messageQueues.push(messageQueue);

    // Echo watcher: drain accumulated files from when bot was down, then start polling
    echoWatcher = ew;
    echoWatcher.drain();
    echoWatcher.start();

    // Polling liveness watchdog: successful getUpdates completions, including
    // empty responses during silence, are the health signal. Incoming updates
    // remain an activity signal only.
    watchdog = createWatchdog({
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
    });
    onUpdateFn = () => watchdog!.touch();

    // Startup timeout — if onStart doesn't fire, exit for launchd restart.
    // Set to 120s to accommodate the 409-retry backoff window (~75s worst case).
    let startedSuccessfully = false;
    const startupTimeout = setTimeout(() => {
      if (!startedSuccessfully) {
        log.error("main", "Telegram startup timed out after 120s — exiting for launchd restart");
        process.exit(1);
      }
    }, 120_000);

    log.info("main", "Starting Telegram bot polling...");
    // bot.start() blocks until stopped — run it without awaiting.
    // startBotWithRetry handles 409 Conflict errors (old instance still polling)
    // with exponential backoff to avoid crash-loops on restart.
    startBotWithRetry(
      () =>
        bot.start({
          timeout: TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
          onStart: (botInfo) => {
            startedSuccessfully = true;
            clearTimeout(startupTimeout);
            setBotUsername(botInfo.username);
            log.info("main", `Telegram bot @${botInfo.username} is running (id: ${botInfo.id})`);
            // No global media wipe on startup: grammY invokes onStart before the
            // first getUpdates, so polling ownership isn't proven yet. A blanket
            // wipe here can clobber files that an overlapping old instance is
            // still serving. Orphans from prior runs are reclaimed via per-session
            // cleanupSessionMediaDir on close and enforceMediaCap eviction.
            if (watchdog) watchdog.start();
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
    ).catch((err) => {
      log.error("main", "Telegram bot polling failed — exiting for restart:", err);
      process.exit(1);
    });
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

  // Fail fast if no bots are active
  if (!telegramBot && !discordClient) {
    log.error("main", "No bots started — exiting");
    process.exit(1);
  }

  void tavilyRuntime.start().catch(() => {
    log.error("main", "Tavily monitor startup failed");
  });
}

main().catch((err) => {
  log.error("main", "Fatal error:", err);
  process.exit(1);
});
