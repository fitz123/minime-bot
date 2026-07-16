import assert from "node:assert/strict";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import {
  TAVILY_BILLING_URL,
  TAVILY_RECOVERY_EXTRACT_URL,
  TAVILY_RECOVERY_SEARCH_QUERY,
  TAVILY_STATE_RELPATH,
  TAVILY_USAGE_URL,
  TavilyMonitor,
  buildTavilyUsageRequest,
  isTavilyUsageRecoverable,
  parseTavilyUsageResponse,
  requestTavilyUsage,
  tavilyBillingCycleGeneration,
  verifyTavilyRecovery,
} from "../tavily-monitor.js";
import {
  tavilyEventSpoolDirectory,
  writeTavilyChildEvent,
} from "../pi-extensions/tavily-events.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryWorkspace(): string {
  const path = mkdtempSync(join(tmpdir(), "tavily-monitor-test-"));
  temporaryDirectories.push(path);
  return path;
}

function usageResponse(overrides: {
  planUsage?: number;
  planLimit?: number;
  paygoUsage?: number;
  paygoLimit?: number;
  keyUsage?: number;
  keyLimit?: number;
  extra?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    key: {
      usage: overrides.keyUsage ?? 700,
      limit: overrides.keyLimit ?? 1_000,
      search_usage: 600,
      extract_usage: 100,
    },
    account: {
      current_plan: "Researcher",
      plan_usage: overrides.planUsage ?? 700,
      plan_limit: overrides.planLimit ?? 1_000,
      paygo_usage: overrides.paygoUsage ?? 0,
      paygo_limit: overrides.paygoLimit ?? 1_250,
      search_usage: 600,
      extract_usage: 100,
    },
    ...overrides.extra,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulSearchResponse(): Record<string, unknown> {
  return {
    results: [{
      title: "Tavily API docs",
      url: "https://docs.tavily.com/",
      content: "Public documentation",
    }],
  };
}

function successfulExtractResponse(): Record<string, unknown> {
  return {
    results: [{
      url: TAVILY_RECOVERY_EXTRACT_URL,
      raw_content: "Example Domain",
    }],
    failed_results: [],
  };
}

function sequenceFetch(responses: Array<Response | (() => Response)>): {
  fetchImpl: typeof fetch;
  calls: Array<{ input: string; init: RequestInit | undefined }>;
} {
  const calls: Array<{ input: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ input: String(input), init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected test fetch");
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function mutableClock(initial: string): {
  now: () => Date;
  set: (value: string) => void;
} {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    set: (next) => { value = new Date(next); },
  };
}

function writeExhaustionEvent(
  workspace: string,
  tool: "web_search" | "web_fetch",
  classification: "base_plan_exhausted" | "paygo_exhausted",
  observedAt: string,
  id: string,
): string {
  return writeTavilyChildEvent(
    workspace,
    tool,
    {
      classification,
      httpStatus: classification === "base_plan_exhausted" ? 432 : 433,
    },
    { now: () => new Date(observedAt), uniqueId: () => id, pid: 71 },
  );
}

describe("Tavily usage parsing and bounded requests", () => {
  it("builds authenticated GET /usage and parses all quota-relevant counters", () => {
    assert.deepEqual(buildTavilyUsageRequest("fixture-key"), {
      url: TAVILY_USAGE_URL,
      method: "GET",
      headers: { Authorization: "Bearer fixture-key" },
    });

    const sample = parseTavilyUsageResponse(
      usageResponse({
        planUsage: 1_012,
        paygoUsage: 12,
        extra: { reset_at: "2026-08-01T00:00:00.000Z" },
      }),
      new Date("2026-07-16T09:00:00.000Z"),
    );
    assert.deepEqual(sample, {
      observedAt: "2026-07-16T09:00:00.000Z",
      cycleGeneration: "2026-07",
      resetAt: "2026-08-01T00:00:00.000Z",
      key: {
        usage: 700,
        limit: 1_000,
        remaining: 300,
        searchUsage: 600,
        extractUsage: 100,
      },
      account: {
        currentPlan: "Researcher",
        plan: { usage: 1_012, limit: 1_000, remaining: 0 },
        paygo: { usage: 12, limit: 1_250, remaining: 1_238 },
        searchUsage: 600,
        extractUsage: 100,
      },
    });
    assert.equal(tavilyBillingCycleGeneration("2026-12-31T23:59:59.000Z"), "2026-12");
    assert.equal(isTavilyUsageRecoverable(sample), true, "PAYGO capacity is recoverable");
    assert.equal(sample.resetAt, "2026-08-01T00:00:00.000Z");
    assert.equal(
      parseTavilyUsageResponse(usageResponse(), new Date("2026-07-01T00:00:00.000Z")).resetAt,
      undefined,
      "a reset is not invented when the provider omits it",
    );
  });

  it("rejects malformed, missing, negative, and non-finite usage fields", () => {
    const malformed: unknown[] = [
      undefined,
      {},
      { key: {}, account: {} },
      { ...usageResponse(), key: { usage: -1, limit: 1_000 } },
      {
        ...usageResponse(),
        account: { ...(usageResponse().account as Record<string, unknown>), paygo_limit: "1250" },
      },
      {
        ...usageResponse(),
        account: { ...(usageResponse().account as Record<string, unknown>), plan_usage: Infinity },
      },
      {
        ...usageResponse(),
        account: { ...(usageResponse().account as Record<string, unknown>), current_plan: "bad\nplan" },
      },
    ];
    for (const value of malformed) {
      assert.throws(
        () => parseTavilyUsageResponse(value, new Date("2026-07-01T00:00:00.000Z")),
        /usage response is invalid/,
      );
    }
  });

  it("classifies missing credentials, bounded HTTP failures, malformed JSON, and timeouts", async () => {
    const clock = () => new Date("2026-07-16T10:00:00.000Z");
    assert.deepEqual(await requestTavilyUsage({ apiKey: undefined, now: clock }), {
      ok: false,
      diagnostic: {
        classification: "credential_missing",
        source: "usage",
        observedAt: "2026-07-16T10:00:00.000Z",
      },
    });

    let bodyRead = false;
    const serverFailure = await requestTavilyUsage({
      apiKey: "fixture-key",
      now: clock,
      fetchImpl: (async () => ({
        ok: false,
        status: 503,
        json: async () => { bodyRead = true; return { secret: "provider-body" }; },
      }) as unknown as Response) as typeof fetch,
    });
    assert.equal(serverFailure.ok, false);
    if (!serverFailure.ok) {
      assert.equal(serverFailure.diagnostic.classification, "provider_unavailable");
      assert.equal(serverFailure.diagnostic.httpStatus, 503);
    }
    assert.equal(bodyRead, false, "non-2xx provider bodies are never read");

    const malformed = await requestTavilyUsage({
      apiKey: "fixture-key",
      now: clock,
      fetchImpl: (async () => jsonResponse({ key: {}, account: {} })) as typeof fetch,
    });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.diagnostic.classification, "usage_invalid");

    let attempts = 0;
    const timedOut = await requestTavilyUsage({
      apiKey: "fixture-key",
      now: clock,
      timeoutMs: 5,
      fetchImpl: ((_: string | URL | Request, init?: RequestInit) => {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }) as typeof fetch,
    });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) assert.equal(timedOut.diagnostic.classification, "provider_unavailable");
    assert.equal(attempts, 1, "timeouts are not retried");
  });
});

describe("Tavily fixed recovery verification", () => {
  it("requires current recoverable usage and validated fixed Search and Extract probes", async () => {
    const { fetchImpl, calls } = sequenceFetch([
      jsonResponse(usageResponse({ planUsage: 100, paygoUsage: 0 })),
      jsonResponse(successfulSearchResponse()),
      jsonResponse(successfulExtractResponse()),
    ]);
    const result = await verifyTavilyRecovery({
      apiKey: "fixture-key",
      fetchImpl,
      now: () => new Date("2026-07-16T11:00:00.000Z"),
      timeoutMs: 50,
      probeTimeoutMs: 50,
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.equal(calls[0].input, TAVILY_USAGE_URL);
    assert.equal(calls[0].init?.method, "GET");

    assert.equal(calls[1].input, "https://api.tavily.com/search");
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)), {
      query: TAVILY_RECOVERY_SEARCH_QUERY,
      max_results: 1,
      search_depth: "basic",
      include_answer: false,
    });
    assert.equal(calls[2].input, "https://api.tavily.com/extract");
    assert.deepEqual(JSON.parse(String(calls[2].init?.body)), {
      urls: [TAVILY_RECOVERY_EXTRACT_URL],
      extract_depth: "basic",
    });
    for (const call of calls) {
      assert.equal((call.init?.headers as Record<string, string>).Authorization, "Bearer fixture-key");
      assert.ok(call.init?.signal instanceof AbortSignal);
    }
  });

  it("does not resolve exhausted usage or empty 2xx probe responses", async () => {
    const exhausted = parseTavilyUsageResponse(
      usageResponse({ planUsage: 1_000, paygoUsage: 1_250 }),
      new Date("2026-07-16T11:00:00.000Z"),
    );
    let calls = 0;
    const exhaustedResult = await verifyTavilyRecovery({
      apiKey: "fixture-key",
      usageSample: exhausted,
      fetchImpl: (async () => { calls += 1; return jsonResponse({}); }) as typeof fetch,
    });
    assert.equal(exhaustedResult.ok, false);
    if (!exhaustedResult.ok) {
      assert.equal(exhaustedResult.stage, "usage_state");
      assert.equal(exhaustedResult.classification, "usage_exhausted");
    }
    assert.equal(calls, 0);

    const recoverable = parseTavilyUsageResponse(
      usageResponse({ planUsage: 100 }),
      new Date("2026-07-16T11:00:00.000Z"),
    );
    const emptyProbe = sequenceFetch([jsonResponse({ results: [] })]);
    const emptyResult = await verifyTavilyRecovery({
      apiKey: "fixture-key",
      usageSample: recoverable,
      fetchImpl: emptyProbe.fetchImpl,
    });
    assert.equal(emptyResult.ok, false);
    if (!emptyResult.ok) {
      assert.equal(emptyResult.stage, "search_probe");
      assert.equal(emptyResult.classification, "probe_failed");
    }
    assert.equal(emptyProbe.calls.length, 1, "a failed Search probe does not spend an Extract probe");
  });
});

describe("Tavily threshold and durable incident state", () => {
  it("deduplicates plan/PAYGO 80 and 95 thresholds by UTC monthly generation", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-01T00:00:00.000Z");
    let usage = usageResponse({ planUsage: 799, paygoUsage: 999, paygoLimit: 1_250 });
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => jsonResponse(usage)) as typeof fetch,
    });

    await monitor.sampleUsage();
    assert.equal(monitor.getState().outbox.length, 0);

    clock.set("2026-07-02T00:00:00.000Z");
    usage = usageResponse({ planUsage: 800, paygoUsage: 1_000, paygoLimit: 1_250 });
    await monitor.sampleUsage();
    assert.deepEqual(
      monitor.getState().outbox.map((entry) => entry.key).sort(),
      ["threshold:2026-07:paygo:80", "threshold:2026-07:plan:80"],
    );

    clock.set("2026-07-03T00:00:00.000Z");
    usage = usageResponse({ planUsage: 950, paygoUsage: 1_188, paygoLimit: 1_250 });
    await monitor.sampleUsage();
    await monitor.sampleUsage();
    assert.equal(monitor.getState().outbox.length, 4, "same-cycle samples remain deduplicated");

    clock.set("2026-08-01T00:00:00.000Z");
    usage = usageResponse({ planUsage: 800, paygoUsage: 0, paygoLimit: 1_250 });
    await monitor.sampleUsage();
    const state = monitor.getState();
    assert.equal(state.outbox.length, 5);
    assert.ok(state.thresholdNotificationKeys.includes("threshold:2026-08:plan:80"));
    for (const notification of state.outbox) {
      assert.match(notification.message, /Provider: Tavily/);
      assert.match(notification.message, /Usage:/);
      assert.match(notification.message, /Limit:/);
      assert.match(notification.message, /Remaining credits:/);
      assert.match(notification.message, /Affected tools: web_search, web_fetch/);
      assert.match(notification.message, new RegExp(TAVILY_BILLING_URL.replaceAll("/", "\\/")));
      assert.doesNotMatch(notification.message, /Reset:/, "provider omitted reset data");
    }
  });

  it("drains concurrent 432/433 files into one immediate, replay-safe incident", () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:02.000Z");
    const firstPath = writeExhaustionEvent(
      workspace,
      "web_search",
      "base_plan_exhausted",
      "2026-07-16T12:00:00.000Z",
      "first",
    );
    writeExhaustionEvent(
      workspace,
      "web_fetch",
      "paygo_exhausted",
      "2026-07-16T12:00:01.000Z",
      "second",
    );
    const firstName = firstPath.split("/").at(-1) as string;
    const firstRaw = readFileSync(firstPath, "utf8");

    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
    });
    assert.equal(monitor.drainChildEvents(), 2);
    let state = monitor.getState();
    assert.equal(state.incidentSequence, 1);
    assert.equal(state.incident?.generation, "2026-07-1");
    assert.equal(state.incident?.lastClassification, "paygo_exhausted");
    assert.deepEqual(state.incident?.observedTools, ["web_search", "web_fetch"]);
    assert.equal(state.outbox.filter((entry) => entry.kind === "incident").length, 1);
    assert.deepEqual(state.telemetryStats.failures, [
      { classification: "base_plan_exhausted", tool: "web_search", count: 1 },
      { classification: "paygo_exhausted", tool: "web_fetch", count: 1 },
    ]);
    assert.deepEqual(readdirSync(tavilyEventSpoolDirectory(workspace)), []);

    writeFileSync(join(tavilyEventSpoolDirectory(workspace), firstName), firstRaw, { mode: 0o600 });
    assert.equal(monitor.drainChildEvents(), 0);
    state = monitor.getState();
    assert.equal(state.incidentSequence, 1);
    assert.equal(state.outbox.filter((entry) => entry.kind === "incident").length, 1);
    assert.equal(state.telemetryStats.failures.reduce((total, entry) => total + entry.count, 0), 2);
  });

  it("startup-drains, reminds every six hours, and stops reminders on acknowledgement", () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(
      workspace,
      "web_search",
      "base_plan_exhausted",
      "2026-07-16T12:00:00.000Z",
      "startup",
    );
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      eventPollIntervalMs: 20,
    });
    monitor.startChildEventPolling();
    monitor.stopChildEventPolling();
    const generation = monitor.getState().incident?.generation as string;
    assert.ok(generation);

    clock.set("2026-07-16T17:59:59.999Z");
    assert.equal(monitor.queueDueReminder(), false);
    clock.set("2026-07-16T18:00:00.000Z");
    assert.equal(monitor.queueDueReminder(), true);
    assert.equal(monitor.queueDueReminder(), false);
    assert.equal(monitor.getState().outbox.filter((entry) => entry.kind === "reminder").length, 1);

    assert.equal(monitor.acknowledgeIncident("stale-generation"), false);
    assert.equal(monitor.acknowledgeIncident(generation), true);
    const acknowledgedAt = monitor.getState().incident?.acknowledgedAt;
    assert.equal(monitor.acknowledgeIncident(generation), true, "acknowledgement is idempotent");
    assert.equal(monitor.getState().incident?.acknowledgedAt, acknowledgedAt);
    clock.set("2026-07-17T12:00:00.000Z");
    assert.equal(monitor.queueDueReminder(), false);
  });
});

describe("Tavily recovery, later generations, and atomic restart persistence", () => {
  it("keeps failed rechecks active, resolves after both probes, and queues recovery once", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(
      workspace,
      "web_search",
      "base_plan_exhausted",
      "2026-07-16T12:00:00.000Z",
      "recheck",
    );
    const fetches = sequenceFetch([
      jsonResponse(usageResponse({ planUsage: 100 })),
      jsonResponse({ results: [] }),
      jsonResponse(usageResponse({ planUsage: 100 })),
      jsonResponse(successfulSearchResponse()),
      jsonResponse(successfulExtractResponse()),
    ]);
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: fetches.fetchImpl,
    });
    monitor.drainChildEvents();
    const generation = monitor.getState().incident?.generation as string;

    const failed = await monitor.recheckIncident(generation);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.stage, "search_probe");
    assert.equal(monitor.getState().incident?.resolvedAt, undefined);
    assert.equal(monitor.getState().lastVerification?.ok, false);

    clock.set("2026-07-16T12:05:00.000Z");
    const recovered = await monitor.recheckIncident(generation);
    assert.equal(recovered.ok, true);
    assert.equal(monitor.getState().incident?.resolvedAt, "2026-07-16T12:05:00.000Z");
    assert.equal(monitor.getState().outbox.filter((entry) => entry.kind === "recovery").length, 1);

    const callsBeforeStale = fetches.calls.length;
    const stale = await monitor.recheckIncident(generation);
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.classification, "stale_incident");
    assert.equal(fetches.calls.length, callsBeforeStale);
  });

  it("uses the same verification path for an automatic recoverable transition", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(
      workspace,
      "web_fetch",
      "paygo_exhausted",
      "2026-07-16T12:00:00.000Z",
      "automatic",
    );
    const fetches = sequenceFetch([
      jsonResponse(usageResponse({ planUsage: 100, paygoUsage: 0 })),
      jsonResponse(successfulSearchResponse()),
      jsonResponse(successfulExtractResponse()),
    ]);
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: fetches.fetchImpl,
    });
    monitor.drainChildEvents();
    await monitor.sampleUsage();
    assert.ok(monitor.getState().incident?.resolvedAt);
    assert.equal(monitor.getState().pendingAutomaticVerification, undefined);
    assert.equal(monitor.getState().outbox.filter((entry) => entry.kind === "recovery").length, 1);
    assert.equal(fetches.calls.length, 3, "the current sample is reused by the shared verification path");
  });

  it("deduplicates failed automatic probes until usage leaves and re-enters recoverable state", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(
      workspace,
      "web_fetch",
      "paygo_exhausted",
      "2026-07-16T12:00:00.000Z",
      "automatic-transition",
    );
    const fetches = sequenceFetch([
      jsonResponse(usageResponse({ planUsage: 100, paygoUsage: 0 })),
      jsonResponse({ results: [] }),
      jsonResponse(usageResponse({ planUsage: 100, paygoUsage: 0 })),
      jsonResponse(usageResponse({ planUsage: 1_000, paygoUsage: 1_250 })),
      jsonResponse(usageResponse({ planUsage: 100, paygoUsage: 0 })),
      jsonResponse(successfulSearchResponse()),
      jsonResponse(successfulExtractResponse()),
    ]);
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: fetches.fetchImpl,
    });
    monitor.drainChildEvents();

    await monitor.sampleUsage();
    assert.equal(fetches.calls.length, 2);
    assert.equal(monitor.getState().incident?.resolvedAt, undefined);

    clock.set("2026-07-16T12:05:00.000Z");
    await monitor.sampleUsage();
    assert.equal(fetches.calls.length, 3, "continuously recoverable usage does not repeat probes");

    clock.set("2026-07-16T12:10:00.000Z");
    await monitor.sampleUsage();
    assert.equal(fetches.calls.length, 4);
    clock.set("2026-07-16T12:15:00.000Z");
    await monitor.sampleUsage();
    assert.equal(fetches.calls.length, 7, "a new recoverable transition runs both probes once");
    assert.ok(monitor.getState().incident?.resolvedAt);
  });

  it("creates a later generation only for post-resolution exhaustion", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(
      workspace,
      "web_search",
      "base_plan_exhausted",
      "2026-07-16T12:00:00.000Z",
      "generation-one",
    );
    const fetches = sequenceFetch([
      jsonResponse(usageResponse({ planUsage: 100 })),
      jsonResponse(successfulSearchResponse()),
      jsonResponse(successfulExtractResponse()),
    ]);
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: fetches.fetchImpl,
    });
    monitor.drainChildEvents();
    const firstGeneration = monitor.getState().incident?.generation as string;
    assert.equal(monitor.acknowledgeIncident(firstGeneration), true);
    clock.set("2026-07-16T12:10:00.000Z");
    await monitor.recheckIncident(firstGeneration);

    writeExhaustionEvent(
      workspace,
      "web_fetch",
      "paygo_exhausted",
      "2026-07-16T12:09:00.000Z",
      "old-after-resolution",
    );
    monitor.drainChildEvents();
    assert.equal(monitor.getState().incident?.generation, firstGeneration);

    writeExhaustionEvent(
      workspace,
      "web_fetch",
      "paygo_exhausted",
      "2026-07-16T12:11:00.000Z",
      "generation-two",
    );
    monitor.drainChildEvents();
    const state = monitor.getState();
    assert.notEqual(state.incident?.generation, firstGeneration);
    assert.equal(state.incident?.generation, "2026-07-2");
    assert.equal(state.incident?.acknowledgedAt, undefined);
    assert.equal(state.incident?.resolvedAt, undefined);
    assert.equal(state.outbox.filter((entry) => entry.kind === "incident").length, 2);
  });

  it("atomically restores owner-only state without persisting private fields", async () => {
    const workspace = temporaryWorkspace();
    const privateKey = "private-api-key-fixture-never-persist";
    const privateQuery = "private-query-fixture-never-persist";
    const privateUrl = "https://private.invalid/private-url-fixture";
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    const response = usageResponse({
      planUsage: 950,
      extra: { query: privateQuery, url: privateUrl, api_key: privateKey },
    });
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: privateKey,
      now: clock.now,
      fetchImpl: (async () => jsonResponse(response)) as typeof fetch,
    });
    await monitor.sampleUsage();
    const beforeRestart = monitor.getState();

    const statePath = join(workspace, TAVILY_STATE_RELPATH);
    const raw = readFileSync(statePath, "utf8");
    assert.equal(lstatSync(join(workspace, "data")).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(workspace, "data", "tavily")).mode & 0o777, 0o700);
    assert.equal(lstatSync(statePath).mode & 0o777, 0o600);
    assert.equal(readdirSync(join(workspace, "data", "tavily")).includes(".state.json.tmp"), false);
    assert.doesNotMatch(raw, new RegExp(privateKey));
    assert.doesNotMatch(raw, new RegExp(privateQuery));
    assert.doesNotMatch(raw, new RegExp(privateUrl));
    assert.doesNotMatch(raw, /Authorization|Bearer/);

    const restored = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: privateKey,
      now: clock.now,
      fetchImpl: (async () => { throw new Error("not called"); }) as typeof fetch,
    });
    assert.deepEqual(restored.getState(), beforeRestart);
    assert.equal(restored.dueNotifications().length, 2);

    const firstKey = restored.dueNotifications()[0].key;
    assert.equal(restored.recordNotificationRetry(
      firstKey,
      new Date("2026-07-16T12:01:00.000Z"),
      "transport",
    ), true);
    assert.equal(restored.getState().notificationStats.retried, 1);
    assert.equal(restored.recordNotificationDelivered(firstKey), true);
    assert.equal(restored.getState().notificationStats.delivered, 1);
    assert.equal(restored.getState().notificationKeys.includes(firstKey), true, "delivery dedupe key survives removal");
  });
});
