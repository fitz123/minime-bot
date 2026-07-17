import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import client from "prom-client";
import {
  recordResultMetrics,
  recordTelegramApiError,
  recordTelegramApiCall,
  classifyPiRetry,
  recordPiRetry,
  recordPiTurnDuration,
  tokensInput,
  tokensOutput,
  tokensCacheRead,
  tokensCacheCreation,
  costUsd,
  turnDuration,
  piTurnDuration,
  piRetryTotal,
  pi429Total,
  piOverloadTotal,
  piRetryUnknownTotal,
  piSessionResumeDiscarded,
  telegramApiErrors,
  telegramApiCalls,
  telegramPollProgressAge,
  telegramPollInFlight,
  pollWatchdogChecks,
  pollWatchdogRestarts,
  recordPollProgress,
  recordPollWatchdogCheck,
  recordPollWatchdogRestart,
  sessionsActive,
  sessionCrashes,
  messagesReceived,
  messagesSent,
  messageQueueSaturation,
  messageQueueRejectionNotices,
  recordMessageQueueSaturation,
  recordMessageQueueRejectionNotice,
  mediaDownloadRetries,
  recordMediaDownloadRetry,
  draftSchedulerEvents,
  finalDeliveryFailures,
  recordDraftSchedulerEvent,
  recordFinalDeliveryFailure,
  tavilyUsageSamplePresent,
  tavilyUsageSampleAge,
  tavilyUsageSampleSuccess,
  tavilyPlanUsage,
  tavilyPlanLimit,
  tavilyPaygoUsage,
  tavilyPaygoLimit,
  tavilyIncidentActive,
  tavilyIncidentAcknowledged,
  tavilyUsageSamples,
  tavilyFailures,
  tavilyNotifications,
  recordTavilyMonitorMetrics,
  startMetricsServer,
  stopMetricsServer,
} from "../metrics.js";
import { parsePiEvent } from "../pi-rpc-protocol.js";
import type { TavilyMonitorState } from "../tavily-monitor.js";

// Reset all metrics before each test to get clean counts
beforeEach(() => {
  client.register.resetMetrics();
});

describe("recordResultMetrics", () => {
  it("records cost and duration", async () => {
    recordResultMetrics("main", {
      cost_usd: 0.05,
      duration_ms: 12000,
    });

    const costVal = await costUsd.get();
    assert.strictEqual(costVal.values.length, 1);
    assert.strictEqual(costVal.values[0].value, 0.05);
    assert.strictEqual(costVal.values[0].labels.agent_id, "main");

    const durVal = await turnDuration.get();
    // Histogram has sum, count, and bucket values
    const sum = durVal.values.find((v) => v.metricName === "bot_claude_turn_duration_seconds_sum");
    assert.ok(sum, "expected histogram sum");
    assert.strictEqual(sum.value, 12); // 12000ms = 12s
  });

  it("records token usage from usage object", async () => {
    recordResultMetrics("test-agent", {
      cost_usd: 0.01,
      duration_ms: 5000,
      usage: {
        input_tokens: 1500,
        output_tokens: 800,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 100,
      },
    });

    const input = await tokensInput.get();
    assert.strictEqual(input.values[0].value, 1500);
    assert.strictEqual(input.values[0].labels.agent_id, "test-agent");

    const output = await tokensOutput.get();
    assert.strictEqual(output.values[0].value, 800);

    const cacheRead = await tokensCacheRead.get();
    assert.strictEqual(cacheRead.values[0].value, 500);

    const cacheCreate = await tokensCacheCreation.get();
    assert.strictEqual(cacheCreate.values[0].value, 100);
  });

  it("handles missing fields gracefully", async () => {
    // Should not throw when fields are missing
    recordResultMetrics("main", {});

    const costVal = await costUsd.get();
    assert.strictEqual(costVal.values.length, 0);
  });

  it("handles missing usage gracefully", async () => {
    recordResultMetrics("main", { cost_usd: 0.01 });

    const input = await tokensInput.get();
    assert.strictEqual(input.values.length, 0);
  });

  it("accumulates across multiple calls", async () => {
    recordResultMetrics("main", { cost_usd: 0.05 });
    recordResultMetrics("main", { cost_usd: 0.03 });

    const costVal = await costUsd.get();
    assert.strictEqual(costVal.values[0].value, 0.08);
  });
});

describe("legacy active-runtime metric compatibility", () => {
  it("keeps legacy bot_claude names while describing active-runtime usage", async () => {
    const body = await client.register.metrics();

    assert.match(
      body,
      /# HELP bot_claude_tokens_input_total Total input tokens reported by the active agent runtime \(legacy metric name\)/,
    );
    assert.match(
      body,
      /# HELP bot_claude_tokens_output_total Total output tokens reported by the active agent runtime \(legacy metric name\)/,
    );
    assert.match(
      body,
      /# HELP bot_claude_cost_usd_total Total USD cost reported by the active agent runtime \(legacy metric name\)/,
    );
    assert.match(
      body,
      /# HELP bot_claude_turn_duration_seconds Turn duration reported by the active agent runtime in seconds \(legacy metric name\)/,
    );
  });
});

describe("recordTelegramApiError", () => {
  it("records error with method and code labels", async () => {
    recordTelegramApiError("editMessageText", 429);

    const val = await telegramApiErrors.get();
    assert.strictEqual(val.values.length, 1);
    assert.strictEqual(val.values[0].labels.method, "editMessageText");
    assert.strictEqual(val.values[0].labels.error_code, "429");
    assert.strictEqual(val.values[0].value, 1);
  });

  it("records http_error string code", async () => {
    recordTelegramApiError("sendMessage", "http_error");

    const val = await telegramApiErrors.get();
    assert.strictEqual(val.values[0].labels.error_code, "http_error");
  });

  it("accumulates errors per label set", async () => {
    recordTelegramApiError("editMessageText", 429);
    recordTelegramApiError("editMessageText", 429);
    recordTelegramApiError("sendMessage", 400);

    const val = await telegramApiErrors.get();
    const edit429 = val.values.find(
      (v) => v.labels.method === "editMessageText" && v.labels.error_code === "429",
    );
    const send400 = val.values.find(
      (v) => v.labels.method === "sendMessage" && v.labels.error_code === "400",
    );
    assert.strictEqual(edit429?.value, 2);
    assert.strictEqual(send400?.value, 1);
  });
});

describe("recordTelegramApiCall", () => {
  it("records call with method and binding labels", async () => {
    recordTelegramApiCall("sendMessage", "User1 DM");

    const val = await telegramApiCalls.get();
    assert.strictEqual(val.values.length, 1);
    assert.strictEqual(val.values[0].labels.method, "sendMessage");
    assert.strictEqual(val.values[0].labels.binding, "User1 DM");
    assert.strictEqual(val.values[0].value, 1);
  });

  it("accumulates per (method, binding) label set", async () => {
    recordTelegramApiCall("sendMessage", "User1 DM");
    recordTelegramApiCall("sendMessage", "User1 DM");
    recordTelegramApiCall("sendMessage", "Group A");
    recordTelegramApiCall("getUpdates", "none");

    const val = await telegramApiCalls.get();
    const userSend = val.values.find(
      (v) => v.labels.method === "sendMessage" && v.labels.binding === "User1 DM",
    );
    const groupSend = val.values.find(
      (v) => v.labels.method === "sendMessage" && v.labels.binding === "Group A",
    );
    const poll = val.values.find(
      (v) => v.labels.method === "getUpdates" && v.labels.binding === "none",
    );
    assert.strictEqual(userSend?.value, 2);
    assert.strictEqual(groupSend?.value, 1);
    assert.strictEqual(poll?.value, 1);
  });

  it("records 'unbound' sentinel as a regular label value", async () => {
    recordTelegramApiCall("sendMessage", "unbound");

    const val = await telegramApiCalls.get();
    assert.strictEqual(val.values[0].labels.binding, "unbound");
    assert.strictEqual(val.values[0].value, 1);
  });
});

describe("polling watchdog metrics", () => {
  it("records progress gauges without labels", async () => {
    recordPollProgress(12_500, true);
    assert.equal((await telegramPollProgressAge.get()).values[0].value, 12.5);
    assert.equal((await telegramPollInFlight.get()).values[0].value, 1);

    recordPollProgress(-1, false);
    assert.equal((await telegramPollProgressAge.get()).values[0].value, 0);
    assert.equal((await telegramPollInFlight.get()).values[0].value, 0);
  });

  it("uses only bounded check outcomes and restart reasons", async () => {
    recordPollWatchdogCheck("healthy_quiet");
    recordPollWatchdogCheck("poll_stalled");
    recordPollWatchdogRestart("poll_stalled");

    const checks = await pollWatchdogChecks.get();
    assert.equal(checks.values.find((v) => v.labels.outcome === "healthy_quiet")?.value, 1);
    assert.equal(checks.values.find((v) => v.labels.outcome === "poll_stalled")?.value, 1);
    const restarts = await pollWatchdogRestarts.get();
    assert.equal(restarts.values[0].labels.reason, "poll_stalled");
    assert.equal(restarts.values[0].value, 1);
  });
});

describe("session lifecycle metrics", () => {
  it("sessionsActive gauge increments and decrements", async () => {
    sessionsActive.inc();
    sessionsActive.inc();
    let val = await sessionsActive.get();
    assert.strictEqual(val.values[0].value, 2);

    sessionsActive.dec();
    val = await sessionsActive.get();
    assert.strictEqual(val.values[0].value, 1);
  });

  it("sessionCrashes counter increments", async () => {
    sessionCrashes.inc();
    sessionCrashes.inc();

    const val = await sessionCrashes.get();
    assert.strictEqual(val.values[0].value, 2);
  });
});

describe("message flow metrics", () => {
  it("messagesReceived tracks by type", async () => {
    messagesReceived.inc({ type: "text" });
    messagesReceived.inc({ type: "text" });
    messagesReceived.inc({ type: "voice" });

    const val = await messagesReceived.get();
    const text = val.values.find((v) => v.labels.type === "text");
    const voice = val.values.find((v) => v.labels.type === "voice");
    assert.strictEqual(text?.value, 2);
    assert.strictEqual(voice?.value, 1);
  });

  it("messagesSent increments", async () => {
    messagesSent.inc();
    messagesSent.inc();
    messagesSent.inc();

    const val = await messagesSent.get();
    assert.strictEqual(val.values[0].value, 3);
  });
});

describe("message queue saturation metrics", () => {
  it("distinguishes bounded debounce and collect rejection labels without chat identity", async () => {
    recordMessageQueueSaturation("debounce");
    recordMessageQueueSaturation("debounce");
    recordMessageQueueSaturation("collect");
    recordMessageQueueRejectionNotice("debounce", "sent");
    recordMessageQueueRejectionNotice("collect", "failed");
    recordMessageQueueRejectionNotice("collect", "rate_limited");

    const saturation = await messageQueueSaturation.get();
    assert.deepStrictEqual(
      saturation.values.map(({ labels, value }) => ({ labels, value })),
      [
        { labels: { buffer: "debounce" }, value: 2 },
        { labels: { buffer: "collect" }, value: 1 },
      ],
    );

    const notices = await messageQueueRejectionNotices.get();
    assert.deepStrictEqual(
      notices.values.map(({ labels, value }) => ({ labels, value })),
      [
        { labels: { buffer: "debounce", result: "sent" }, value: 1 },
        { labels: { buffer: "collect", result: "failed" }, value: 1 },
        { labels: { buffer: "collect", result: "rate_limited" }, value: 1 },
      ],
    );
    assert.ok(saturation.values.every(({ labels }) => !("chat_id" in labels)));
    assert.ok(notices.values.every(({ labels }) => !("chat_id" in labels)));
  });

  it("registers and exposes both queue reliability counters", async () => {
    const names = client.register.getMetricsAsArray().map((metric) => metric.name);
    assert.ok(names.includes("bot_message_queue_saturation_total"));
    assert.ok(names.includes("bot_message_queue_rejection_notices_total"));

    recordMessageQueueSaturation("debounce");
    recordMessageQueueRejectionNotice("debounce", "sent");
    const body = await client.register.metrics();
    assert.match(body, /bot_message_queue_saturation_total\{buffer="debounce"\} 1/);
    assert.match(
      body,
      /bot_message_queue_rejection_notices_total\{buffer="debounce",result="sent"\} 1/,
    );
  });
});

describe("media download retry metrics", () => {
  it("records only bounded recovered and exhausted outcomes", async () => {
    recordMediaDownloadRetry("recovered");
    recordMediaDownloadRetry("recovered");
    recordMediaDownloadRetry("exhausted");

    const values = await mediaDownloadRetries.get();
    assert.deepStrictEqual(
      values.values.map(({ labels, value }) => ({ labels, value })),
      [
        { labels: { result: "recovered" }, value: 2 },
        { labels: { result: "exhausted" }, value: 1 },
      ],
    );
    assert.ok(values.values.every(({ labels }) => Object.keys(labels).length === 1));
  });

  it("registers the retry outcome counter", async () => {
    const names = client.register.getMetricsAsArray().map((metric) => metric.name);
    assert.ok(names.includes("bot_media_download_retries_total"));
    recordMediaDownloadRetry("recovered");
    assert.match(await client.register.metrics(), /bot_media_download_retries_total\{result="recovered"\} 1/);
  });
});

describe("draft and final delivery reliability metrics", () => {
  it("uses bounded cosmetic draft event labels and a separate final failure counter", async () => {
    recordDraftSchedulerEvent("throttled");
    recordDraftSchedulerEvent("coalesced");
    recordDraftSchedulerEvent("rate_limited");
    recordDraftSchedulerEvent("failed");
    recordFinalDeliveryFailure();

    const drafts = await draftSchedulerEvents.get();
    assert.deepStrictEqual(
      drafts.values.map(({ labels, value }) => ({ labels, value })),
      [
        { labels: { event: "throttled" }, value: 1 },
        { labels: { event: "coalesced" }, value: 1 },
        { labels: { event: "rate_limited" }, value: 1 },
        { labels: { event: "failed" }, value: 1 },
      ],
    );
    assert.ok(drafts.values.every(({ labels }) => Object.keys(labels).length === 1));

    const finalFailures = await finalDeliveryFailures.get();
    assert.strictEqual(finalFailures.values[0].value, 1);
    assert.deepStrictEqual(finalFailures.values[0].labels, {});
  });

  it("registers both reliability counters", () => {
    const names = client.register.getMetricsAsArray().map((metric) => metric.name);
    assert.ok(names.includes("bot_draft_scheduler_events_total"));
    assert.ok(names.includes("bot_final_delivery_failures_total"));
  });
});

describe("Tavily durable metrics", () => {
  function baseTavilyState(overrides: Partial<TavilyMonitorState> = {}): TavilyMonitorState {
    return {
      version: 1,
      updatedAt: "2026-07-16T12:00:00.000Z",
      incidentSequence: 0,
      notificationKeys: [],
      processedEventKeys: [],
      outbox: [],
      notificationStats: { delivered: 0, retried: 0, terminal: 0 },
      telemetryStats: {
        usageSamples: { success: 0, failure: 0 },
        failures: [],
      },
      ...overrides,
    };
  }

  it("restores account gauges and durable counters from a null-key-limit sample", async () => {
    const sampledAt = "2026-07-16T11:58:00.000Z";
    let collectedAt = new Date("2026-07-16T12:00:00.000Z");
    const state = baseTavilyState({
      incidentSequence: 7,
      latestSample: {
        observedAt: sampledAt,
        cycleGeneration: "2026-07",
        key: { usage: 950 },
        account: {
          currentPlan: "Researcher",
          plan: { usage: 950, limit: 1_000, remaining: 50 },
          paygo: { usage: 1_000, limit: 1_250, remaining: 250 },
        },
      },
      latestSampleStatus: { classification: "ok", observedAt: sampledAt },
      lastFailure: {
        classification: "base_plan_exhausted",
        source: "web_search",
        observedAt: "2026-07-16T11:57:00.000Z",
        httpStatus: 432,
      },
      telemetryStats: {
        usageSamples: { success: 9, failure: 2 },
        failures: [
          { classification: "base_plan_exhausted", tool: "web_search", count: 3 },
          { classification: "provider_unavailable", tool: "usage", count: 2 },
        ],
      },
      notificationStats: { delivered: 4, retried: 2, terminal: 1 },
      incident: {
        generation: "private-generation-must-not-be-a-label",
        exhaustionSequence: 1,
        openedAt: "2026-07-16T11:57:00.000Z",
        lastObservedAt: "2026-07-16T11:57:00.000Z",
        lastClassification: "base_plan_exhausted",
        observedTools: ["web_search"],
        nextReminderAt: "2026-07-16T17:57:00.000Z",
        lastUsageRecoverable: false,
        acknowledgedAt: "2026-07-16T11:59:00.000Z",
      },
      outbox: [{
        key: "private-outbox-key",
        kind: "incident",
        message: "private query URL key destination and host path",
        createdAt: "2026-07-16T11:57:00.000Z",
        nextAttemptAt: "2026-07-16T11:57:00.000Z",
        attempts: 0,
        status: "pending",
      }],
    });

    recordTavilyMonitorMetrics(
      state,
      new Date("2026-07-16T12:00:00.000Z"),
      () => new Date(collectedAt),
    );

    const names = new Set(client.register.getMetricsAsArray().map((metric) => metric.name));
    for (const name of [
      "bot_tavily_usage_sample_present",
      "bot_tavily_usage_sample_age_seconds",
      "bot_tavily_usage_sample_success",
      "bot_tavily_plan_usage",
      "bot_tavily_plan_limit",
      "bot_tavily_paygo_usage",
      "bot_tavily_paygo_limit",
      "bot_tavily_incident_active",
      "bot_tavily_incident_acknowledged",
      "bot_tavily_usage_samples_total",
      "bot_tavily_failures_total",
      "bot_tavily_notifications_total",
    ]) assert.ok(names.has(name), `expected ${name}`);

    assert.equal((await tavilyUsageSamplePresent.get()).values[0].value, 1);
    assert.equal((await tavilyUsageSampleAge.get()).values[0].value, 120);
    collectedAt = new Date("2026-07-16T12:03:00.000Z");
    assert.equal(
      (await tavilyUsageSampleAge.get()).values[0].value,
      300,
      "sample age advances at collection time without another state transition",
    );
    assert.equal((await tavilyUsageSampleSuccess.get()).values[0].value, 1);
    assert.equal((await tavilyPlanUsage.get()).values[0].value, 950);
    assert.equal((await tavilyPlanLimit.get()).values[0].value, 1_000);
    assert.equal((await tavilyPaygoUsage.get()).values[0].value, 1_000);
    assert.equal((await tavilyPaygoLimit.get()).values[0].value, 1_250);
    assert.equal((await tavilyIncidentActive.get()).values[0].value, 1);
    assert.equal((await tavilyIncidentAcknowledged.get()).values[0].value, 1);
    assert.deepEqual(
      (await tavilyUsageSamples.get()).values.map(({ labels, value }) => ({ labels, value })),
      [
        { labels: { outcome: "success" }, value: 9 },
        { labels: { outcome: "failure" }, value: 2 },
      ],
    );
    assert.deepEqual(
      (await tavilyFailures.get()).values.map(({ labels, value }) => ({ labels, value })),
      [
        { labels: { classification: "base_plan_exhausted", tool: "web_search" }, value: 3 },
        { labels: { classification: "provider_unavailable", tool: "usage" }, value: 2 },
      ],
    );
    assert.deepEqual(
      (await tavilyNotifications.get()).values.map(({ labels, value }) => ({ labels, value })),
      [
        { labels: { outcome: "delivered" }, value: 4 },
        { labels: { outcome: "retried" }, value: 2 },
        { labels: { outcome: "terminal" }, value: 1 },
      ],
    );
    const scrape = await client.register.metrics();
    assert.doesNotMatch(
      scrape,
      /private-generation|private-outbox|private query|destination|host path/,
    );
  });

  it("represents missing and failed samples without private or unbounded labels", async () => {
    const collectNow = () => new Date("2026-07-16T12:00:00.000Z");
    recordTavilyMonitorMetrics(baseTavilyState(), collectNow(), collectNow);
    assert.equal((await tavilyUsageSamplePresent.get()).values[0].value, 0);
    assert.equal((await tavilyUsageSampleAge.get()).values[0].value, 0);
    assert.equal((await tavilyUsageSampleSuccess.get()).values[0].value, 0);

    recordTavilyMonitorMetrics(baseTavilyState({
      latestSampleStatus: {
        classification: "credential_invalid",
        observedAt: "2026-07-16T11:59:00.000Z",
        httpStatus: 401,
      },
      lastFailure: {
        classification: "credential_invalid",
        source: "usage",
        observedAt: "2026-07-16T11:59:00.000Z",
        httpStatus: 401,
      },
      telemetryStats: {
        usageSamples: { success: 0, failure: 1 },
        failures: [{ classification: "credential_invalid", tool: "usage", count: 1 }],
      },
    }), collectNow(), collectNow);
    assert.equal((await tavilyUsageSamplePresent.get()).values[0].value, 0);
    assert.equal((await tavilyUsageSampleSuccess.get()).values[0].value, 0);
    const failures = await tavilyFailures.get();
    assert.deepEqual(failures.values[0].labels, {
      classification: "credential_invalid",
      tool: "usage",
    });
    assert.deepEqual(Object.keys(failures.values[0].labels).sort(), ["classification", "tool"]);
  });
});

describe("classifyPiRetry", () => {
  it("buckets rate-limit signals as 429", () => {
    assert.strictEqual(classifyPiRetry("HTTP 429 Too Many Requests"), "429");
    assert.strictEqual(classifyPiRetry("rate limit exceeded, retrying"), "429");
    assert.strictEqual(classifyPiRetry("rate_limit_error"), "429");
  });

  it("buckets overload / 5xx signals as overload", () => {
    assert.strictEqual(classifyPiRetry("upstream returned 529 overloaded"), "overload");
    assert.strictEqual(classifyPiRetry("503 Service Unavailable"), "overload");
    assert.strictEqual(classifyPiRetry("internal server error"), "overload");
  });

  it("prefers 429 over overload when both could match", () => {
    // A 429 message must never be mis-bucketed as a 5xx/overload.
    assert.strictEqual(classifyPiRetry("429 after a transient 503"), "429");
  });

  it("falls back to unknown for unrecognized or missing messages", () => {
    assert.strictEqual(classifyPiRetry("connection reset by peer"), "unknown");
    assert.strictEqual(classifyPiRetry(""), "unknown");
    assert.strictEqual(classifyPiRetry(undefined), "unknown");
  });
});

describe("recordPiRetry", () => {
  async function bucketValue(
    counter: typeof piRetryTotal,
    agentId: string,
  ): Promise<number> {
    const metric = await counter.get();
    const entry = metric.values.find((v) => v.labels.agent_id === agentId);
    return entry?.value ?? 0;
  }

  it("always increments pi_retry_total plus exactly the 429 bucket", async () => {
    recordPiRetry("main", "HTTP 429 rate limit");

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(pi429Total, "main"), 1);
    assert.strictEqual(await bucketValue(piOverloadTotal, "main"), 0);
    assert.strictEqual(await bucketValue(piRetryUnknownTotal, "main"), 0);
  });

  it("always increments pi_retry_total plus exactly the overload bucket", async () => {
    recordPiRetry("main", "529 overloaded");

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(pi429Total, "main"), 0);
    assert.strictEqual(await bucketValue(piOverloadTotal, "main"), 1);
    assert.strictEqual(await bucketValue(piRetryUnknownTotal, "main"), 0);
  });

  it("always increments pi_retry_total plus exactly the unknown bucket", async () => {
    recordPiRetry("main", "some brand new wording");

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(pi429Total, "main"), 0);
    assert.strictEqual(await bucketValue(piOverloadTotal, "main"), 0);
    assert.strictEqual(await bucketValue(piRetryUnknownTotal, "main"), 1);
  });

  it("treats a missing error message as unknown but still counts the retry", async () => {
    recordPiRetry("main");

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(piRetryUnknownTotal, "main"), 1);
  });

  it("classifies the error_message carried by a translated auto_retry_start", async () => {
    // End-to-end wiring: Pi raw event -> parsePiEvent -> classifier metric.
    const line = parsePiEvent({ type: "auto_retry_start", errorMessage: "429 slow down" });
    assert.ok(line);
    const errorMessage = (line as { error_message?: string }).error_message;
    recordPiRetry("main", errorMessage);

    assert.strictEqual(await bucketValue(piRetryTotal, "main"), 1);
    assert.strictEqual(await bucketValue(pi429Total, "main"), 1);
  });
});

describe("recordPiTurnDuration", () => {
  it("observes seconds into the Pi turn-duration histogram", async () => {
    recordPiTurnDuration("main", 30);

    const durVal = await piTurnDuration.get();
    const sum = durVal.values.find(
      (v) => v.metricName === "bot_pi_turn_duration_seconds_sum",
    );
    assert.ok(sum, "expected Pi histogram sum");
    assert.strictEqual(sum.value, 30);
    assert.strictEqual(sum.labels.agent_id, "main");
  });
});

describe("piSessionResumeDiscarded", () => {
  async function bucketValue(agentId: string): Promise<number> {
    const metric = await piSessionResumeDiscarded.get();
    const entry = metric.values.find((v) => v.labels.agent_id === agentId);
    return entry?.value ?? 0;
  }

  it("increments per agent_id when a Pi resume is discarded", async () => {
    piSessionResumeDiscarded.inc({ agent_id: "pi" });
    assert.strictEqual(await bucketValue("pi"), 1);
    assert.strictEqual(await bucketValue("other"), 0);
  });

  it("accumulates across multiple discards for the same agent", async () => {
    piSessionResumeDiscarded.inc({ agent_id: "pi" });
    piSessionResumeDiscarded.inc({ agent_id: "pi" });
    assert.strictEqual(await bucketValue("pi"), 2);
  });
});

describe("Pi metrics registration", () => {
  it("registers all Pi metrics on the default registry", () => {
    const names = client.register.getMetricsAsArray().map((m) => m.name);
    for (const name of [
      "bot_pi_turn_duration_seconds",
      "bot_pi_retry_total",
      "bot_pi_429_total",
      "bot_pi_overload_total",
      "bot_pi_retry_unknown_total",
      "bot_pi_session_resume_discarded_total",
    ]) {
      assert.ok(names.includes(name), `expected ${name} to be registered`);
    }
  });

  it("exposes Pi metrics in the scrape output", async () => {
    recordPiRetry("main", "429 rate limit");
    recordPiTurnDuration("main", 5);
    piSessionResumeDiscarded.inc({ agent_id: "main" });

    const body = await client.register.metrics();
    assert.ok(body.includes("bot_pi_turn_duration_seconds"));
    assert.ok(body.includes("bot_pi_retry_total"));
    assert.ok(body.includes("bot_pi_429_total"));
    assert.ok(body.includes("bot_pi_overload_total"));
    assert.ok(body.includes("bot_pi_retry_unknown_total"));
    assert.ok(body.includes("bot_pi_session_resume_discarded_total"));
  });
});

describe("metrics HTTP server", () => {
  const listen = (server: Server): Promise<void> => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const close = (server: Server): Promise<void> => new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });

  const waitUntil = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) assert.fail("condition was not met before timeout");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  afterEach(async () => {
    await stopMetricsServer();
  });

  it("serves /metrics endpoint with Prometheus text format", async () => {
    // Use port 0 to let the OS assign an available port
    const server = startMetricsServer(0);
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address() as { port: number };

    // Record some data
    messagesReceived.inc({ type: "text" });
    costUsd.inc({ agent_id: "test" }, 0.01);

    const res = await fetch(`http://localhost:${addr.port}/metrics`);
    assert.strictEqual(res.status, 200);
    const contentType = res.headers.get("content-type") ?? "";
    assert.ok(contentType.includes("text/plain") || contentType.includes("openmetrics"), `Expected text/plain or openmetrics, got: ${contentType}`);

    const body = await res.text();
    assert.ok(body.includes("bot_messages_received_total"), "Expected messagesReceived metric");
    assert.ok(body.includes("bot_claude_cost_usd_total"), "Expected costUsd metric");
  });

  it("returns 404 for non-metrics paths", async () => {
    const server = startMetricsServer(0);
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address() as { port: number };

    const res = await fetch(`http://localhost:${addr.port}/other`);
    assert.strictEqual(res.status, 404);
  });

  it("defaults host to 127.0.0.1 when not specified", async () => {
    const server = startMetricsServer(0);
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address() as { address: string; port: number };
    assert.strictEqual(addr.address, "127.0.0.1");
  });

  it("binds to provided host (0.0.0.0 for Linux Docker scrape)", async () => {
    const server = startMetricsServer(0, "0.0.0.0");
    await new Promise((r) => setTimeout(r, 100));
    const addr = server.address() as { address: string; port: number };
    assert.strictEqual(addr.address, "0.0.0.0");

    // Verify still reachable on loopback even when bound to 0.0.0.0
    const res = await fetch(`http://127.0.0.1:${addr.port}/metrics`);
    assert.strictEqual(res.status, 200);
  });

  it("retries EADDRINUSE until an overlapping process releases the port", async () => {
    const oldServer = createServer();
    await listen(oldServer);
    const address = oldServer.address();
    assert.ok(address && typeof address === "object");

    const server = startMetricsServer(address.port, undefined, { addressInUseRetryMs: 10 });
    await new Promise<void>((resolve) => server.once("error", () => resolve()));
    await close(oldServer);
    await waitUntil(() => server.listening);

    const res = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    assert.strictEqual(res.status, 200);
  });

  it("cancels a pending EADDRINUSE retry during shutdown", async () => {
    const oldServer = createServer();
    await listen(oldServer);
    const address = oldServer.address();
    assert.ok(address && typeof address === "object");

    const server = startMetricsServer(address.port, undefined, { addressInUseRetryMs: 20 });
    await new Promise<void>((resolve) => server.once("error", () => resolve()));
    await stopMetricsServer();
    await close(oldServer);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(server.listening, false);
  });
});
