import { createServer, type Server } from "node:http";
import client from "prom-client";
import { log } from "./logger.js";
import type { TavilyMonitorState } from "./tavily-monitor.js";

// Use the default registry
const register = client.register;

// Expose Node.js process metrics (heap, CPU, event loop, GC)
client.collectDefaultMetrics();

// --- Token usage ---
// Legacy bot_claude_* names are retained for dashboard continuity. These
// counters record usage reported by the active agent runtime.

export const tokensInput = new client.Counter({
  name: "bot_claude_tokens_input_total",
  help: "Total input tokens reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

export const tokensOutput = new client.Counter({
  name: "bot_claude_tokens_output_total",
  help: "Total output tokens reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

export const tokensCacheRead = new client.Counter({
  name: "bot_claude_tokens_cache_read_total",
  help: "Total cache-read input tokens reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

export const tokensCacheCreation = new client.Counter({
  name: "bot_claude_tokens_cache_creation_total",
  help: "Total cache-creation input tokens reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

// --- Cost ---

export const costUsd = new client.Counter({
  name: "bot_claude_cost_usd_total",
  help: "Total USD cost reported by the active agent runtime (legacy metric name)",
  labelNames: ["agent_id"] as const,
});

// --- Turn duration ---

export const turnDuration = new client.Histogram({
  name: "bot_claude_turn_duration_seconds",
  help: "Turn duration reported by the active agent runtime in seconds (legacy metric name)",
  labelNames: ["agent_id"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

// --- Pi RPC (OpenAI Codex provider) ---
// Registered now (Plan A); consumed by the dispatch/alert layers in later plans.

export const piTurnDuration = new client.Histogram({
  name: "bot_pi_turn_duration_seconds",
  help: "Pi RPC turn duration in seconds",
  labelNames: ["agent_id"] as const,
  // SAME buckets as the legacy runtime histogram so dashboards compare directly.
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
});

export const piRetryTotal = new client.Counter({
  name: "bot_pi_retry_total",
  help: "Total Pi RPC auto-retries (incremented on every auto_retry_start)",
  labelNames: ["agent_id"] as const,
});

export const pi429Total = new client.Counter({
  name: "bot_pi_429_total",
  help: "Pi RPC auto-retries attributed to a rate-limit (429) signal",
  labelNames: ["agent_id"] as const,
});

export const piOverloadTotal = new client.Counter({
  name: "bot_pi_overload_total",
  help: "Pi RPC auto-retries attributed to an overload (529 / 5xx) signal",
  labelNames: ["agent_id"] as const,
});

export const piRetryUnknownTotal = new client.Counter({
  name: "bot_pi_retry_unknown_total",
  help: "Pi RPC auto-retries whose error message matched no known signal (graceful fallback)",
  labelNames: ["agent_id"] as const,
});

export const piSessionResumeDiscarded = new client.Counter({
  name: "bot_pi_session_resume_discarded_total",
  help: "Pi resume attempts discarded after the stored session id was not found (graceful fresh start)",
  labelNames: ["agent_id"] as const,
});

// --- Telegram API errors ---

export const telegramApiErrors = new client.Counter({
  name: "bot_telegram_api_errors_total",
  help: "Total Telegram API errors",
  labelNames: ["method", "error_code"] as const,
});

// --- Telegram API calls (success + failure) ---

export const telegramApiCalls = new client.Counter({
  name: "bot_telegram_api_calls_total",
  help: "Total Telegram API calls attempted by the bot (success or failure)",
  labelNames: ["method", "binding"] as const,
});

// --- Telegram polling watchdog ---

export type PollWatchdogCheckOutcome =
  | "healthy_active"
  | "healthy_quiet"
  | "update_processing"
  | "poll_resumed"
  | "poll_recovery_pending"
  | "poll_stalled"
  | "api_unreachable"
  | "overlap_suppressed";
export type PollWatchdogRestartReason = "poll_stalled";

export const telegramPollProgressAge = new client.Gauge({
  name: "bot_telegram_poll_progress_age_seconds",
  help: "Seconds since the last successful Telegram getUpdates completion or watchdog monitoring start",
});

export const telegramPollInFlight = new client.Gauge({
  name: "bot_telegram_poll_in_flight",
  help: "Whether a Telegram getUpdates request is currently in flight",
});

export const pollWatchdogChecks = new client.Counter({
  name: "bot_poll_watchdog_checks_total",
  help: "Total polling watchdog checks by bounded outcome",
  labelNames: ["outcome"] as const,
});

export const pollWatchdogRestarts = new client.Counter({
  name: "bot_poll_watchdog_restarts_total",
  help: "Total polling watchdog restart decisions by bounded reason",
  labelNames: ["reason"] as const,
});

// --- Session lifecycle ---

export const sessionsActive = new client.Gauge({
  name: "bot_sessions_active",
  help: "Number of currently active sessions",
});

export const sessionCrashes = new client.Counter({
  name: "bot_session_crashes_total",
  help: "Total session subprocess crashes",
  labelNames: ["agent_id"] as const,
});

// --- Message flow ---

export const messagesReceived = new client.Counter({
  name: "bot_messages_received_total",
  help: "Total messages received",
  labelNames: ["type"] as const,
});

export const messagesSent = new client.Counter({
  name: "bot_messages_sent_total",
  help: "Total messages sent by the bot",
});

// --- Message queue saturation ---

export type MessageQueueBuffer = "debounce" | "collect";
export type MessageQueueRejectionNoticeResult = "sent" | "failed" | "rate_limited";

export const messageQueueSaturation = new client.Counter({
  name: "bot_message_queue_saturation_total",
  help: "Total inputs rejected because a bounded message queue buffer was full",
  labelNames: ["buffer"] as const,
});

export const messageQueueRejectionNotices = new client.Counter({
  name: "bot_message_queue_rejection_notices_total",
  help: "Total user-visible queue rejection notices by bounded result",
  labelNames: ["buffer", "result"] as const,
});

// --- Media download retries ---

export type MediaDownloadRetryResult = "recovered" | "exhausted";

export const mediaDownloadRetries = new client.Counter({
  name: "bot_media_download_retries_total",
  help: "Total media downloads that recovered after a retry or exhausted retry attempts",
  labelNames: ["result"] as const,
});

// --- Streaming draft and final delivery reliability ---

export type DraftSchedulerEvent = "throttled" | "coalesced" | "rate_limited" | "failed";

export const draftSchedulerEvents = new client.Counter({
  name: "bot_draft_scheduler_events_total",
  help: "Total cosmetic streaming draft scheduler events by bounded outcome",
  labelNames: ["event"] as const,
});

export const finalDeliveryFailures = new client.Counter({
  name: "bot_final_delivery_failures_total",
  help: "Total user-visible final response delivery failures",
});

// --- Tavily quota and incident monitoring ---

let tavilySampleObservedAtMs: number | undefined;
let tavilyMetricsClock: () => Date = () => new Date();

export const tavilyUsageSamplePresent = new client.Gauge({
  name: "bot_tavily_usage_sample_present",
  help: "Whether a successful Tavily usage sample is available",
});

export const tavilyUsageSampleAge = new client.Gauge({
  name: "bot_tavily_usage_sample_age_seconds",
  help: "Age in seconds of the latest successful Tavily usage sample, or zero when missing",
  collect() {
    const nowMs = tavilyMetricsClock().getTime();
    this.set(tavilySampleObservedAtMs === undefined || !Number.isFinite(nowMs)
      ? 0
      : Math.max(0, nowMs - tavilySampleObservedAtMs) / 1_000);
  },
});

export const tavilyUsageSampleSuccess = new client.Gauge({
  name: "bot_tavily_usage_sample_success",
  help: "Whether the latest Tavily usage sampling attempt succeeded",
});

export const tavilyPlanUsage = new client.Gauge({
  name: "bot_tavily_plan_usage",
  help: "Tavily base-plan credits used in the latest successful sample",
});

export const tavilyPlanLimit = new client.Gauge({
  name: "bot_tavily_plan_limit",
  help: "Tavily base-plan credit limit in the latest successful sample",
});

export const tavilyPaygoUsage = new client.Gauge({
  name: "bot_tavily_paygo_usage",
  help: "Tavily PAYGO credits used in the latest successful sample",
});

export const tavilyPaygoLimit = new client.Gauge({
  name: "bot_tavily_paygo_limit",
  help: "Tavily PAYGO credit limit in the latest successful sample",
});

export const tavilyIncidentActive = new client.Gauge({
  name: "bot_tavily_incident_active",
  help: "Whether a Tavily credit exhaustion incident is active",
});

export const tavilyIncidentAcknowledged = new client.Gauge({
  name: "bot_tavily_incident_acknowledged",
  help: "Whether the active Tavily credit exhaustion incident is acknowledged",
});

export const tavilyUsageSamples = new client.Counter({
  name: "bot_tavily_usage_samples_total",
  help: "Durable Tavily usage sampling outcomes",
  labelNames: ["outcome"] as const,
});

export const tavilyFailures = new client.Counter({
  name: "bot_tavily_failures_total",
  help: "Durable Tavily failures by bounded classification and tool",
  labelNames: ["classification", "tool"] as const,
});

export const tavilyNotifications = new client.Counter({
  name: "bot_tavily_notifications_total",
  help: "Durable Tavily notification delivery outcomes",
  labelNames: ["outcome"] as const,
});

// --- Helpers ---

/**
 * Record metrics from an active-runtime result event.
 * The result message contains usage data via the [key: string]: unknown catch-all.
 */
export function recordResultMetrics(
  agentId: string,
  result: { cost_usd?: number; duration_ms?: number; [key: string]: unknown },
): void {
  if (typeof result.cost_usd === "number") {
    costUsd.inc({ agent_id: agentId }, result.cost_usd);
  }

  if (typeof result.duration_ms === "number") {
    turnDuration.observe({ agent_id: agentId }, result.duration_ms / 1000);
  }

  const usage = result.usage as Record<string, unknown> | undefined;
  if (usage && typeof usage === "object") {
    if (typeof usage.input_tokens === "number") {
      tokensInput.inc({ agent_id: agentId }, usage.input_tokens);
    }
    if (typeof usage.output_tokens === "number") {
      tokensOutput.inc({ agent_id: agentId }, usage.output_tokens);
    }
    if (typeof usage.cache_read_input_tokens === "number") {
      tokensCacheRead.inc({ agent_id: agentId }, usage.cache_read_input_tokens);
    }
    if (typeof usage.cache_creation_input_tokens === "number") {
      tokensCacheCreation.inc({ agent_id: agentId }, usage.cache_creation_input_tokens);
    }
  }
}

/** Retry bucket inferred from a Pi RPC auto_retry_start error message. */
export type PiRetryBucket = "429" | "overload" | "unknown";

/**
 * Classify a Pi RPC auto-retry error message into a metric bucket.
 *
 * Defensive by design: the 429 check runs before the 5xx check so a rate-limit
 * is never mis-bucketed as overload, and any unrecognized / missing message
 * falls back to "unknown" so a future Pi wording change is still counted rather
 * than silently dropped.
 */
export function classifyPiRetry(errorMessage?: string): PiRetryBucket {
  const msg = (errorMessage ?? "").toLowerCase();

  // Rate limit (429) — must come first; a 429 must never fall through to 5xx.
  if (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("ratelimit") ||
    msg.includes("too many requests")
  ) {
    return "429";
  }

  // Overload / server error (529, 5xx).
  if (
    msg.includes("529") ||
    msg.includes("overload") ||
    msg.includes("service unavailable") ||
    msg.includes("server error") ||
    /\b5\d\d\b/.test(msg)
  ) {
    return "overload";
  }

  return "unknown";
}

/**
 * Record a Pi RPC auto-retry, classifying the auto_retry_start error message.
 * Always increments pi_retry_total and exactly one of the 429 / overload /
 * unknown buckets. This is the classifier wired to parsePiEvent's
 * auto_retry_start translation (which preserves the raw error_message).
 */
export function recordPiRetry(agentId: string, errorMessage?: string): void {
  piRetryTotal.inc({ agent_id: agentId });

  switch (classifyPiRetry(errorMessage)) {
    case "429":
      pi429Total.inc({ agent_id: agentId });
      break;
    case "overload":
      piOverloadTotal.inc({ agent_id: agentId });
      break;
    default:
      piRetryUnknownTotal.inc({ agent_id: agentId });
      break;
  }
}

/**
 * Record a Pi RPC turn duration (seconds) into the Pi histogram, mirroring the
 * legacy turnDuration observation in recordResultMetrics.
 */
export function recordPiTurnDuration(agentId: string, durationSeconds: number): void {
  piTurnDuration.observe({ agent_id: agentId }, durationSeconds);
}

/**
 * Record a Telegram API error for metrics.
 */
export function recordTelegramApiError(method: string, errorCode: number | string): void {
  telegramApiErrors.inc({ method, error_code: String(errorCode) });
}

/**
 * Record a Telegram API call attempt for metrics. Incremented once per
 * transformer invocation (each autoRetry attempt is a separate call), so
 * `errors / calls` over the same window yields an attempt-level error ratio.
 *
 * The `binding` label MUST come from the resolved binding (or a fixed
 * sentinel) — never from the raw `chat_id`, since that would be unbounded.
 */
export function recordTelegramApiCall(method: string, binding: string): void {
  telegramApiCalls.inc({ method, binding });
}

export function recordPollProgress(ageMs: number, inFlight: boolean): void {
  telegramPollProgressAge.set(Math.max(0, ageMs) / 1000);
  telegramPollInFlight.set(inFlight ? 1 : 0);
}

export function recordPollWatchdogCheck(outcome: PollWatchdogCheckOutcome): void {
  pollWatchdogChecks.inc({ outcome });
}

export function recordPollWatchdogRestart(reason: PollWatchdogRestartReason): void {
  pollWatchdogRestarts.inc({ reason });
}

/** Record a rejected input without adding a chat identifier label. */
export function recordMessageQueueSaturation(buffer: MessageQueueBuffer): void {
  messageQueueSaturation.inc({ buffer });
}

/** Record the bounded outcome of a user-visible queue rejection notice. */
export function recordMessageQueueRejectionNotice(
  buffer: MessageQueueBuffer,
  result: MessageQueueRejectionNoticeResult,
): void {
  messageQueueRejectionNotices.inc({ buffer, result });
}

/** Record the bounded final outcome of a media download retry sequence. */
export function recordMediaDownloadRetry(result: MediaDownloadRetryResult): void {
  mediaDownloadRetries.inc({ result });
}

/** Record a bounded cosmetic draft scheduler event. */
export function recordDraftSchedulerEvent(event: DraftSchedulerEvent): void {
  draftSchedulerEvents.inc({ event });
}

/** Record a user-visible final response delivery failure. */
export function recordFinalDeliveryFailure(): void {
  finalDeliveryFailures.inc();
}

/**
 * Synchronize Tavily metrics from the durable monitor state. Counters are
 * rebuilt from persisted totals so process restarts do not erase incident
 * history and replayed transitions cannot double-count it.
 */
export function recordTavilyMonitorMetrics(
  state: TavilyMonitorState,
  observedAt: Date = new Date(),
  collectNow: () => Date = () => new Date(),
): void {
  const sample = state.latestSample;
  const sampleObservedAt = sample === undefined ? undefined : new Date(sample.observedAt).getTime();
  tavilySampleObservedAtMs = sampleObservedAt;
  tavilyMetricsClock = collectNow;
  tavilyUsageSamplePresent.set(sample === undefined ? 0 : 1);
  tavilyUsageSampleAge.set(sampleObservedAt === undefined
    ? 0
    : Math.max(0, observedAt.getTime() - sampleObservedAt) / 1_000);
  tavilyUsageSampleSuccess.set(state.latestSampleStatus?.classification === "ok" ? 1 : 0);
  tavilyPlanUsage.set(sample?.account.plan.usage ?? 0);
  tavilyPlanLimit.set(sample?.account.plan.limit ?? 0);
  tavilyPaygoUsage.set(sample?.account.paygo.usage ?? 0);
  tavilyPaygoLimit.set(sample?.account.paygo.limit ?? 0);

  const activeIncident = state.incident !== undefined && state.incident.resolvedAt === undefined;
  tavilyIncidentActive.set(activeIncident ? 1 : 0);
  tavilyIncidentAcknowledged.set(activeIncident && state.incident?.acknowledgedAt !== undefined ? 1 : 0);

  tavilyUsageSamples.reset();
  tavilyUsageSamples.inc({ outcome: "success" }, state.telemetryStats.usageSamples.success);
  tavilyUsageSamples.inc({ outcome: "failure" }, state.telemetryStats.usageSamples.failure);

  tavilyFailures.reset();
  for (const failure of state.telemetryStats.failures) {
    tavilyFailures.inc({ classification: failure.classification, tool: failure.tool }, failure.count);
  }

  tavilyNotifications.reset();
  tavilyNotifications.inc({ outcome: "delivered" }, state.notificationStats.delivered);
  tavilyNotifications.inc({ outcome: "retried" }, state.notificationStats.retried);
  tavilyNotifications.inc({ outcome: "terminal" }, state.notificationStats.terminal);
}

// --- HTTP server ---

let metricsServer: Server | null = null;

/**
 * Start the Prometheus metrics HTTP server on the given port.
 * Serves /metrics in standard Prometheus text format.
 * Returns the server instance.
 */
export function startMetricsServer(port: number, host?: string): Server {
  const listenHost = host ?? "127.0.0.1";
  const server = createServer(async (req, res) => {
    if (req.url === "/metrics" && req.method === "GET") {
      try {
        const metrics = await register.metrics();
        res.writeHead(200, { "Content-Type": register.contentType });
        res.end(metrics);
      } catch (err) {
        res.writeHead(500);
        res.end("Error collecting metrics");
        log.error("metrics", `Failed to collect metrics: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  server.on("error", (err) => {
    log.error("metrics", `Metrics server error: ${err.message}`);
  });

  server.listen(port, listenHost, () => {
    log.info("metrics", `Prometheus metrics server listening on ${listenHost}:${port}`);
  });

  metricsServer = server;
  return server;
}

/**
 * Stop the metrics server if running.
 */
export function stopMetricsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (metricsServer) {
      metricsServer.close(() => resolve());
      metricsServer = null;
    } else {
      resolve();
    }
  });
}
