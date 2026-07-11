/** Polling liveness watchdog driven by successful getUpdates completions. */

import { log } from "./logger.js";
import {
  recordPollProgress,
  recordPollWatchdogCheck,
  recordPollWatchdogRestart,
  type PollWatchdogRestartReason,
} from "./metrics.js";
import {
  DEFAULT_POLL_STALL_THRESHOLD_MS,
  type PollProgressSnapshot,
  type UpdateProcessingSnapshot,
} from "./poll-progress.js";

const DEFAULT_INTERVAL_MS = 30 * 1000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15 * 1000;
export const DEFAULT_UPDATE_HANDLER_TIMEOUT_MS = 10 * 60 * 1000;

type TimeoutHandle = unknown;

export interface WatchdogDeps {
  /** Immutable progress snapshot from the getUpdates transformer. */
  pollProgress: () => Readonly<PollProgressSnapshot>;
  /** Current grammY middleware execution, which pauses simple long polling. */
  updateProcessing?: () => Readonly<UpdateProcessingSnapshot>;
  /** Bounded API reachability probe. The signal is aborted on timeout/stop. */
  heartbeat: (signal: AbortSignal) => Promise<boolean>;
  /** Called to terminate the process. Default: process.exit. */
  exit?: (code: number) => void;
  /** Clock for testing. Default: Date.now. */
  now?: () => number;
  /** Maximum age of the last successful poll. Default: 90 seconds. */
  thresholdMs?: number;
  /** Interval between checks. Default: 30 seconds. */
  intervalMs?: number;
  /** Maximum API heartbeat duration. Default: 15 seconds. */
  heartbeatTimeoutMs?: number;
  /** Maximum time to allow one update handler to pause polling. Default: 10 minutes. */
  updateHandlerTimeoutMs?: number;
  setTimeoutFn?: (callback: () => void, ms: number) => TimeoutHandle;
  clearTimeoutFn?: (handle: TimeoutHandle) => void;
}

export interface Watchdog {
  /** Record incoming message activity. This does not prove polling liveness. */
  touch(): void;
  start(): void;
  stop(): void;
  /** Run one check cycle (exposed for deterministic tests). */
  check(): Promise<void>;
}

export function pollProgressAgeMs(
  snapshot: Readonly<PollProgressSnapshot>,
  nowMs: number,
  monitoringStartedAtMs = snapshot.initializedAtMs,
): number {
  const progressAt = snapshot.lastPollSucceededAtMs
    ?? Math.max(snapshot.initializedAtMs, monitoringStartedAtMs);
  return Math.max(0, nowMs - progressAt);
}

export function createWatchdog(deps: WatchdogDeps): Watchdog {
  const thresholdMs = deps.thresholdMs ?? DEFAULT_POLL_STALL_THRESHOLD_MS;
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const updateHandlerTimeoutMs = deps.updateHandlerTimeoutMs ?? DEFAULT_UPDATE_HANDLER_TIMEOUT_MS;
  const exitFn = deps.exit ?? ((code: number) => process.exit(code));
  const now = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimeoutFn = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let lastActivityAtMs = now();
  let timer: ReturnType<typeof setInterval> | null = null;
  let checking = false;
  let restartDecided = false;
  let stopped = false;
  let heartbeatController: AbortController | null = null;
  let monitoringStartedAtMs = now();

  function touch(): void {
    lastActivityAtMs = now();
  }

  function decideRestart(reason: PollWatchdogRestartReason): void {
    if (restartDecided || stopped) return;
    restartDecided = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    recordPollWatchdogRestart(reason);
    log.error("watchdog", `Deliberate watchdog restart: reason=${reason}`);
    exitFn(1);
  }

  async function boundedHeartbeat(): Promise<boolean> {
    const controller = new AbortController();
    heartbeatController = controller;
    let timeout: TimeoutHandle | null = null;
    const timeoutResult = new Promise<boolean>((resolve) => {
      timeout = setTimeoutFn(() => {
        controller.abort();
        resolve(false);
      }, heartbeatTimeoutMs);
    });

    try {
      const heartbeatResult = Promise.resolve()
        .then(() => deps.heartbeat(controller.signal))
        .catch(() => false);
      return await Promise.race([
        heartbeatResult,
        timeoutResult,
      ]);
    } finally {
      if (timeout !== null) clearTimeoutFn(timeout);
      if (heartbeatController === controller) heartbeatController = null;
    }
  }

  async function check(): Promise<void> {
    if (restartDecided || stopped) return;
    if (checking) {
      recordPollWatchdogCheck("overlap_suppressed");
      return;
    }
    checking = true;
    try {
      const checkedAt = now();
      const snapshot = deps.pollProgress();
      const ageMs = pollProgressAgeMs(snapshot, checkedAt, monitoringStartedAtMs);
      recordPollProgress(ageMs, snapshot.inFlight);

      if (ageMs < thresholdMs) {
        const outcome = checkedAt - lastActivityAtMs >= thresholdMs
          ? "healthy_quiet"
          : "healthy_active";
        recordPollWatchdogCheck(outcome);
        log.debug(
          "watchdog",
          `Polling healthy: mode=${outcome === "healthy_quiet" ? "quiet" : "active"} in_flight=${snapshot.inFlight ? 1 : 0}`,
        );
        return;
      }

      const updateProcessing = deps.updateProcessing?.();
      if (
        updateProcessing?.inFlight
        && updateProcessing.startedAtMs !== null
        && checkedAt - updateProcessing.startedAtMs < updateHandlerTimeoutMs
      ) {
        recordPollWatchdogCheck("update_processing");
        log.debug(
          "watchdog",
          `Polling paused for update processing: handler_age_seconds=${Math.round((checkedAt - updateProcessing.startedAtMs) / 1000)}`,
        );
        return;
      }

      log.warn(
        "watchdog",
        `Poll progress stale: age_seconds=${Math.round(ageMs / 1000)} in_flight=${snapshot.inFlight ? 1 : 0}; checking API reachability`,
      );
      const apiReachable = await boundedHeartbeat();
      if (stopped || restartDecided) return;

      // Polling may have recovered while the reachability check was running.
      const latest = deps.pollProgress();
      const latestAgeMs = pollProgressAgeMs(latest, now(), monitoringStartedAtMs);
      recordPollProgress(latestAgeMs, latest.inFlight);
      if (latestAgeMs < thresholdMs) {
        recordPollWatchdogCheck("poll_resumed");
        log.info("watchdog", "Polling resumed during API reachability check; restart cancelled");
        return;
      }

      if (apiReachable) {
        recordPollWatchdogCheck("poll_stalled");
        log.error("watchdog", "Telegram API reachable but polling is stalled: reason=poll_stalled");
        decideRestart("poll_stalled");
      } else {
        recordPollWatchdogCheck("api_unreachable");
        log.error("watchdog", "Telegram API reachability check failed or timed out: reason=api_unreachable");
        decideRestart("api_unreachable");
      }
    } finally {
      checking = false;
    }
  }

  function start(): void {
    if (timer || restartDecided) return;
    stopped = false;
    lastActivityAtMs = now();
    monitoringStartedAtMs = now();
    timer = setInterval(() => {
      check().catch((error) => {
        log.error("watchdog", "Unexpected watchdog check failure", error);
      });
    }, intervalMs);
    (timer as NodeJS.Timeout).unref();
    log.info(
      "watchdog",
      `Started: poll_stall_threshold_seconds=${Math.round(thresholdMs / 1000)} interval_seconds=${Math.round(intervalMs / 1000)} heartbeat_timeout_seconds=${Math.round(heartbeatTimeoutMs / 1000)} update_handler_timeout_seconds=${Math.round(updateHandlerTimeoutMs / 1000)}`,
    );
  }

  function stop(): void {
    stopped = true;
    heartbeatController?.abort();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { touch, start, stop, check };
}
