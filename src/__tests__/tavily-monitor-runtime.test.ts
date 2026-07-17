import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import client from "prom-client";
import { TAVILY_STATE_RELPATH, TavilyMonitor } from "../tavily-monitor.js";
import {
  recordTavilyMonitorMetrics,
  tavilyFailures,
  tavilyIncidentAcknowledged,
  tavilyIncidentActive,
  tavilyNotifications,
  tavilyUsageSampleAge,
  tavilyUsageSamplePresent,
  tavilyUsageSampleSuccess,
  tavilyUsageSamples,
} from "../metrics.js";
import {
  TAVILY_USAGE_SAMPLE_INTERVAL_MS,
  TavilyMonitorSupervisor,
  TavilyMonitorRuntime,
  classifyTavilyDeliveryError,
  parseTavilyCallbackData,
  resolveTavilyDeliveryDestination,
  type TavilyDeliveryPayload,
  type TavilyOwnedMonitorRuntime,
} from "../tavily-monitor-runtime.js";
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
  const path = mkdtempSync(join(tmpdir(), "tavily-runtime-test-"));
  temporaryDirectories.push(path);
  return path;
}

function mutableClock(initial: string): { now: () => Date; set: (value: string) => void } {
  let value = new Date(initial);
  return {
    now: () => new Date(value),
    set: (next) => { value = new Date(next); },
  };
}

function usageResponse(planUsage = 100, paygoUsage = 0, paygoLimit = 1_250): Record<string, unknown> {
  return {
    key: { usage: planUsage, limit: 1_000 },
    account: {
      current_plan: "Researcher",
      plan_usage: planUsage,
      plan_limit: 1_000,
      paygo_usage: paygoUsage,
      paygo_limit: paygoLimit,
    },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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
    results: [{ url: "https://example.com/", raw_content: "Example Domain" }],
    failed_results: [],
  };
}

function writeExhaustionEvent(workspace: string, observedAt: string, id: string): void {
  writeTavilyChildEvent(
    workspace,
    "web_search",
    { classification: "base_plan_exhausted", httpStatus: 432 },
    { now: () => new Date(observedAt), uniqueId: () => id, pid: 71 },
  );
}

function stubOwnedRuntime(events: string[]): TavilyOwnedMonitorRuntime {
  return {
    getDeliveryDestination: () => undefined,
    isIncidentActive: () => false,
    acknowledgeIncident: async () => false,
    recheckIncident: async (generation) => ({
      ok: false,
      generation,
      stage: "incident",
      classification: "stale_incident",
    }),
    start: async () => { events.push("runtime-start"); },
    stop: async () => { events.push("runtime-stop"); },
  };
}

describe("Tavily monitor ownership supervisor", () => {
  it("starts monitoring immediately without waiting for a Telegram poll", async () => {
    const workspace = temporaryWorkspace();
    const events: string[] = [];
    const supervisor = new TavilyMonitorSupervisor({
      destination: { chatId: 71 },
      tryAcquireLease: () => {
        events.push("lease-acquire");
        return { release: () => { events.push("lease-release"); } };
      },
      createRuntime: () => {
        events.push("runtime-create");
        return {
          monitor: new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key" }),
          runtime: stubOwnedRuntime(events),
        };
      },
    });

    supervisor.start();
    assert.deepEqual(events.slice(0, 3), ["lease-acquire", "runtime-create", "runtime-start"]);
    await supervisor.stop();
    assert.deepEqual(events.slice(-2), ["runtime-stop", "lease-release"]);
  });

  it("returns while a live writer owns the lease and retries with a fresh runtime later", async () => {
    const workspace = temporaryWorkspace();
    const events: string[] = [];
    const retries: Array<() => void> = [];
    let leaseAvailable = false;
    let factoryCalls = 0;
    const supervisor = new TavilyMonitorSupervisor({
      destination: undefined,
      tryAcquireLease: () => {
        events.push("lease-attempt");
        return leaseAvailable
          ? { release: () => { events.push("lease-release"); } }
          : undefined;
      },
      createRuntime: () => {
        factoryCalls += 1;
        return {
          monitor: new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key" }),
          runtime: stubOwnedRuntime(events),
        };
      },
      setTimeoutImpl: (callback) => {
        retries.push(callback);
        return { unref() {} };
      },
      clearTimeoutImpl: () => {},
      onWait: () => { events.push("waiting"); },
    });

    supervisor.start();
    assert.equal(factoryCalls, 0, "a waiting replacement does not restore stale monitor state");
    assert.deepEqual(events, ["lease-attempt", "waiting"]);
    assert.equal(retries.length, 1, "lease waiting is asynchronous and leaves bot startup unblocked");

    leaseAvailable = true;
    retries.shift()?.();
    await Promise.resolve();
    assert.equal(factoryCalls, 1);
    assert.equal(events.includes("runtime-start"), true);
    await supervisor.stop();
    assert.equal(events.at(-1), "lease-release");
  });

  it("retries after lease acquisition and runtime construction failures", async () => {
    const workspace = temporaryWorkspace();
    const acquisitionError = new Error("synthetic lease failure");
    const constructionError = new Error("synthetic runtime construction failure");
    const errors: unknown[] = [];
    const retries: Array<() => void> = [];
    let attempt = 0;
    let releases = 0;
    const supervisor = new TavilyMonitorSupervisor({
      destination: undefined,
      tryAcquireLease: () => {
        attempt += 1;
        if (attempt === 1) throw acquisitionError;
        return { release: () => { releases += 1; } };
      },
      createRuntime: () => {
        if (attempt === 2) throw constructionError;
        return {
          monitor: new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key" }),
          runtime: stubOwnedRuntime([]),
        };
      },
      setTimeoutImpl: (callback) => {
        retries.push(callback);
        return { unref() {} };
      },
      clearTimeoutImpl: () => {},
      onError: (error) => { errors.push(error); },
    });

    supervisor.start();
    assert.equal(retries.length, 1);
    retries.shift()?.();
    assert.equal(releases, 1, "a failed construction releases its lease");
    assert.equal(retries.length, 1);
    retries.shift()?.();
    await Promise.resolve();
    assert.deepEqual(errors, [acquisitionError, constructionError]);
    await supervisor.stop();
    assert.equal(releases, 2, "the successfully activated owner also releases on stop");
  });

  it("stops failed runtimes and releases their leases before retrying", async () => {
    const workspace = temporaryWorkspace();
    const synchronousStartError = new Error("synthetic synchronous start failure");
    const asynchronousStartError = new Error("synthetic asynchronous start failure");
    const cleanupError = new Error("synthetic cleanup failure");
    const errors: unknown[] = [];
    const events: string[] = [];
    const retries: Array<() => void> = [];
    let runtimeNumber = 0;
    let leaseNumber = 0;
    const supervisor = new TavilyMonitorSupervisor({
      destination: undefined,
      tryAcquireLease: () => {
        const current = ++leaseNumber;
        return { release: () => { events.push(`release-${current}`); } };
      },
      createRuntime: () => {
        const current = ++runtimeNumber;
        const runtime = stubOwnedRuntime(events);
        if (current === 1) {
          runtime.start = () => {
            events.push("start-1");
            throw synchronousStartError;
          };
          runtime.stop = async () => { events.push("stop-1"); };
        } else if (current === 2) {
          runtime.start = async () => {
            events.push("start-2");
            throw asynchronousStartError;
          };
          runtime.stop = async () => {
            events.push("stop-2");
            throw cleanupError;
          };
        }
        return {
          monitor: new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key" }),
          runtime,
        };
      },
      setTimeoutImpl: (callback) => {
        retries.push(callback);
        return { unref() {} };
      },
      clearTimeoutImpl: () => {},
      onError: (error) => { errors.push(error); },
    });

    supervisor.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events.slice(0, 3), ["start-1", "stop-1", "release-1"]);
    assert.equal(retries.length, 1);

    retries.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(events.slice(3, 6), ["start-2", "stop-2", "release-2"]);
    assert.equal(retries.length, 1);

    retries.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(runtimeNumber, 3);
    assert.deepEqual(errors, [synchronousStartError, asynchronousStartError, cleanupError]);
    await supervisor.stop();
    assert.equal(events.at(-1), "release-3");
  });
});

describe("Tavily monitor lifecycle", () => {
  it("startup-drains events, samples immediately, and delivers incident actions", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T11:59:59.000Z", "startup");
    const deliveries: TavilyDeliveryPayload[] = [];
    const timers: unknown[] = [];
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => jsonResponse(usageResponse(1_000, 1_250))) as typeof fetch,
    });
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: -10071, threadId: 17 },
      deliver: async (payload) => { deliveries.push(payload); },
      now: clock.now,
      setIntervalImpl: (callback, intervalMs) => {
        const handle = { callback, intervalMs, unref() {} };
        timers.push(handle);
        return handle;
      },
      clearIntervalImpl: () => {},
    });

    await runtime.start();
    assert.deepEqual(readdirSync(tavilyEventSpoolDirectory(workspace)), []);
    assert.equal(timers.length, 2);
    assert.ok(timers.some((timer) =>
      (timer as { intervalMs: number }).intervalMs === TAVILY_USAGE_SAMPLE_INTERVAL_MS));
    const incident = deliveries.find((delivery) => delivery.replyMarkup !== undefined);
    assert.ok(incident);
    assert.equal(incident.chatId, -10071);
    assert.equal(incident.threadId, 17);
    assert.deepEqual(
      incident.replyMarkup?.inline_keyboard[0].map((button) => button.text),
      ["acknowledge degraded mode", "credits fixed — recheck"],
    );
    assert.equal(monitor.getState().notificationStats.delivered, deliveries.length);
    await runtime.stop();
  });

  it("starts idempotently and clears both lifecycle timers on shutdown", async () => {
    const workspace = temporaryWorkspace();
    const installed: unknown[] = [];
    const cleared: unknown[] = [];
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      fetchImpl: (async () => jsonResponse(usageResponse())) as typeof fetch,
    });
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: undefined,
      deliver: async () => assert.fail("no notification should be delivered"),
      setIntervalImpl: () => {
        const handle = { unref() {} };
        installed.push(handle);
        return handle;
      },
      clearIntervalImpl: (handle) => { cleared.push(handle); },
    });

    const first = runtime.start();
    const second = runtime.start();
    assert.strictEqual(first, second);
    await first;
    assert.equal(runtime.isRunning(), true);
    assert.equal(installed.length, 2);
    await runtime.stop();
    await runtime.stop();
    assert.equal(runtime.isRunning(), false);
    assert.deepEqual(cleared, installed);
  });

  it("serializes startup sampling, spool processing, and operator actions", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "serialized-runtime");
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
    let usageStarted!: () => void;
    const started = new Promise<void>((resolve) => { usageStarted = resolve; });
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => {
        usageStarted();
        await usageGate;
        return jsonResponse(usageResponse(1_000));
      }) as typeof fetch,
    });
    const timerCallbacks: Array<() => void> = [];
    const deliveries: TavilyDeliveryPayload[] = [];
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliver: async (payload) => { deliveries.push(payload); },
      now: clock.now,
      setIntervalImpl: (callback) => {
        timerCallbacks.push(callback);
        return { unref() {} };
      },
      clearIntervalImpl: () => {},
    });

    const startup = runtime.start();
    await started;
    const generation = monitor.getState().incident?.generation as string;
    timerCallbacks[0]?.();
    const acknowledgement = runtime.acknowledgeIncident(generation);
    await Promise.resolve();
    assert.equal(deliveries.length, 0, "queued transitions cannot overtake the blocked sampler");

    releaseUsage();
    await Promise.all([startup, acknowledgement]);
    assert.equal(monitor.getState().incident?.acknowledgedAt !== undefined, true);
    assert.equal(
      deliveries.filter((delivery) => /exhaustion incident/.test(delivery.text)).length,
      1,
      "overlapping triggers do not duplicate the incident delivery",
    );
    await runtime.stop();
  });

  it("resumes one crash-interrupted automatic verification on startup", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:05:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "pending-recovery");
    const initial = new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key", now: clock.now });
    initial.drainChildEvents();
    const statePath = join(workspace, TAVILY_STATE_RELPATH);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, any>;
    persisted.incident.lastUsageRecoverable = true;
    persisted.pendingAutomaticVerification = {
      generation: persisted.incident.generation,
      usageObservedAt: "2026-07-16T12:04:59.000Z",
    };
    writeFileSync(statePath, `${JSON.stringify(persisted)}\n`, "utf8");

    let calls = 0;
    const restored = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1 || calls === 4) return jsonResponse(usageResponse(100));
        if (calls === 2) return jsonResponse(successfulSearchResponse());
        if (calls === 3) return jsonResponse(successfulExtractResponse());
        throw new Error("unexpected startup recovery request");
      }) as typeof fetch,
    });
    const deliveries: TavilyDeliveryPayload[] = [];
    const runtime = new TavilyMonitorRuntime({
      monitor: restored,
      destination: { chatId: 71 },
      deliver: async (payload) => { deliveries.push(payload); },
      now: clock.now,
    });

    await runtime.start();
    await runtime.stop();
    assert.equal(calls, 4, "pending verification plus the normal startup sample run once each");
    assert.ok(restored.getState().incident?.resolvedAt);
    assert.equal(restored.getState().pendingAutomaticVerification, undefined);
    assert.equal(deliveries.filter((delivery) => delivery.text.startsWith("Tavily recovered.")).length, 1);
  });

  it("restores and refreshes metrics and safe status after serialized transitions", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    const privateKey = "tvly-private-runtime-key";
    let observations = 0;
    const observe = (state: Parameters<typeof recordTavilyMonitorMetrics>[0], at: Date) => {
      observations += 1;
      recordTavilyMonitorMetrics(state, at, clock.now);
    };
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: privateKey,
      now: clock.now,
      fetchImpl: (async () => jsonResponse(usageResponse(100))) as typeof fetch,
      onStateChange: observe,
    });
    assert.equal((await tavilyUsageSamplePresent.get()).values[0].value, 0);

    await monitor.sampleUsage();
    writeExhaustionEvent(workspace, "2026-07-16T12:00:01.000Z", "metrics");
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: undefined,
      deliver: async () => assert.fail("missing destination must not deliver"),
      now: clock.now,
    });
    const beforeProcess = observations;
    await runtime.processNow();
    assert.ok(observations > beforeProcess, "serialized transitions refresh diagnostics");
    const generation = monitor.getState().incident?.generation as string;
    assert.equal(await runtime.acknowledgeIncident(generation), true);

    assert.equal((await tavilyUsageSamplePresent.get()).values[0].value, 1);
    assert.equal((await tavilyUsageSampleSuccess.get()).values[0].value, 1);
    assert.equal((await tavilyUsageSamples.get()).values.find((value) =>
      value.labels.outcome === "success")?.value, 1);
    assert.equal((await tavilyFailures.get()).values.find((value) =>
      value.labels.classification === "base_plan_exhausted" && value.labels.tool === "web_search")?.value, 1);
    assert.equal((await tavilyNotifications.get()).values.find((value) =>
      value.labels.outcome === "terminal")?.value, 1);
    assert.equal((await tavilyIncidentActive.get()).values[0].value, 1);
    assert.equal((await tavilyIncidentAcknowledged.get()).values[0].value, 1);

    clock.set("2026-07-16T12:11:00.000Z");
    const restored = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: privateKey,
      now: clock.now,
      fetchImpl: (async () => assert.fail("startup restoration must not fetch")) as typeof fetch,
      onStateChange: (state, at) => recordTavilyMonitorMetrics(state, at, clock.now),
    });
    assert.equal(restored.getStatus().sampleState, "stale");
    assert.deepEqual(restored.getStatus(), {
      sampleState: "stale",
      sampledAt: "2026-07-16T12:00:00.000Z",
      latestAttemptAt: "2026-07-16T12:00:00.000Z",
      plan: { usage: 100, limit: 1_000, remaining: 900 },
      paygo: { usage: 0, limit: 1_250, remaining: 1_250 },
      lastFailure: {
        classification: "base_plan_exhausted",
        source: "web_search",
        observedAt: "2026-07-16T12:00:01.000Z",
        httpStatus: 432,
      },
      incident: "active",
      acknowledged: true,
    });
    assert.equal((await tavilyUsageSampleAge.get()).values[0].value, 660);
    assert.equal((await tavilyNotifications.get()).values.find((value) =>
      value.labels.outcome === "terminal")?.value, 1, "durable outcome restores without replay");
    const scrape = await client.register.metrics();
    assert.doesNotMatch(scrape, /tvly-private-runtime-key|private-generation|\/Users\/|state\.json/);
  });
});

describe("Tavily durable notification delivery", () => {
  it("retries transient 429 delivery with capped backoff and then persists success", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => jsonResponse(usageResponse(800))) as typeof fetch,
    });
    await monitor.sampleUsage();
    let attempts = 0;
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliver: async () => {
        attempts++;
        if (attempts === 1) throw { error_code: 429, parameters: { retry_after: 20 } };
      },
      now: clock.now,
      retryBaseMs: 1_000,
      retryMaxMs: 5_000,
    });

    await runtime.processNow();
    let state = monitor.getState();
    assert.equal(attempts, 1);
    assert.equal(state.outbox[0].lastFailure, "rate_limited");
    assert.equal(state.outbox[0].nextAttemptAt, "2026-07-16T12:00:05.000Z");
    assert.equal(state.notificationStats.retried, 1);

    clock.set("2026-07-16T12:00:05.000Z");
    await runtime.processNow();
    state = monitor.getState();
    assert.equal(attempts, 2);
    assert.equal(state.outbox.length, 0);
    assert.equal(state.notificationStats.delivered, 1);
  });

  it("cancels a backed-off reminder when the incident is acknowledged", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "retry-before-ack");
    const monitor = new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key", now: clock.now });
    const deliveries: string[] = [];
    let failReminder = true;
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliver: async (payload) => {
        deliveries.push(payload.text);
        if (failReminder && /exhaustion reminder/.test(payload.text)) {
          failReminder = false;
          throw new Error("transient reminder failure");
        }
      },
      now: clock.now,
      retryBaseMs: 1_000,
      retryMaxMs: 1_000,
    });
    await runtime.processNow();
    const generation = monitor.getState().incident?.generation as string;

    clock.set("2026-07-16T18:00:00.000Z");
    await runtime.processNow();
    assert.equal(monitor.getState().outbox.some((entry) => entry.kind === "reminder"), true);
    assert.equal(await runtime.acknowledgeIncident(generation), true);
    assert.equal(monitor.getState().outbox.some((entry) => entry.kind === "reminder"), false);

    const attemptsBeforeRetry = deliveries.length;
    clock.set("2026-07-16T18:00:01.000Z");
    await runtime.processNow();
    assert.equal(deliveries.length, attemptsBeforeRetry, "the backed-off reminder is not delivered after acknowledgement");
  });

  it("cancels a backed-off incident notification before delivering recovery", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:05:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "retry-before-recovery");
    let fetchCalls = 0;
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => {
        fetchCalls += 1;
        if (fetchCalls === 1) return jsonResponse(usageResponse(100));
        if (fetchCalls === 2) return jsonResponse(successfulSearchResponse());
        if (fetchCalls === 3) return jsonResponse(successfulExtractResponse());
        throw new Error("unexpected recovery fetch");
      }) as typeof fetch,
    });
    const deliveries: string[] = [];
    let failIncident = true;
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliver: async (payload) => {
        deliveries.push(payload.text);
        if (failIncident && /exhaustion incident/.test(payload.text)) {
          failIncident = false;
          throw new Error("transient incident failure");
        }
      },
      now: clock.now,
      retryBaseMs: 60_000,
      retryMaxMs: 60_000,
    });
    await runtime.processNow();
    const generation = monitor.getState().incident?.generation as string;
    assert.equal(monitor.getState().outbox[0].attempts, 1);

    const result = await runtime.recheckIncident(generation);

    assert.equal(result.ok, true);
    assert.equal(fetchCalls, 3);
    assert.equal(deliveries.length, 2);
    assert.match(deliveries[1], /^Tavily recovered\./);
    assert.deepEqual(monitor.getState().outbox, []);
  });

  it("records missing destinations and deterministic 4xx failures as terminal", async () => {
    for (const mode of ["missing", "bad-request"] as const) {
      const workspace = temporaryWorkspace();
      const monitor = new TavilyMonitor({
        controlWorkspaceRoot: workspace,
        apiKey: "fixture-key",
        fetchImpl: (async () => jsonResponse(usageResponse(800))) as typeof fetch,
      });
      await monitor.sampleUsage();
      let calls = 0;
      const runtime = new TavilyMonitorRuntime({
        monitor,
        destination: mode === "missing" ? undefined : { chatId: 71 },
        deliver: async () => {
          calls++;
          throw { error_code: 400 };
        },
      });

      await runtime.processNow();
      const entry = monitor.getState().outbox[0];
      assert.equal(entry.status, "terminal");
      assert.equal(entry.lastFailure, "destination_invalid");
      assert.equal(monitor.getState().notificationStats.terminal, 1);
      assert.equal(calls, mode === "missing" ? 0 : 1);
    }
  });

  it("suppresses a due reminder invalidated by terminalizing the opening delivery", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T18:00:01.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "old-terminal-incident");
    const monitor = new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key", now: clock.now });
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: undefined,
      deliver: async () => assert.fail("missing destination must not deliver"),
      now: clock.now,
    });

    await runtime.processNow();
    const state = monitor.getState();
    assert.equal(state.notificationStats.terminal, 1);
    assert.equal(state.outbox.filter((entry) => entry.kind === "incident" && entry.status === "terminal").length, 1);
    assert.equal(state.outbox.some((entry) => entry.kind === "reminder"), false);
  });

  it("cancels a backed-off reminder when another incident notification becomes terminal", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "terminal-after-reminder");
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
    });
    let deliveryMode: "success" | "retry-reminder" | "terminal" = "success";
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliver: async (payload) => {
        if (deliveryMode === "retry-reminder" && /exhaustion reminder/.test(payload.text)) {
          throw new Error("synthetic transient reminder failure");
        }
        if (deliveryMode === "terminal") throw { error_code: 400 };
      },
      now: clock.now,
      retryBaseMs: 60_000,
      retryMaxMs: 60_000,
    });
    await runtime.processNow();
    const generation = monitor.getState().incident?.generation as string;

    clock.set("2026-07-16T18:00:00.000Z");
    deliveryMode = "retry-reminder";
    await runtime.processNow();
    assert.equal(monitor.getState().outbox.some((entry) => entry.kind === "reminder"), true);

    deliveryMode = "terminal";
    await runtime.recheckIncident(generation);
    const state = monitor.getState();
    assert.equal(state.incident?.deliveryTerminalAt, "2026-07-16T18:00:00.000Z");
    assert.equal(state.outbox.some((entry) => entry.kind === "reminder"), false);
  });

  it("stops terminal incident reminders and resumes once after a configured restart", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "terminal-incident");
    const monitor = new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key", now: clock.now });
    const missingDestination = new TavilyMonitorRuntime({
      monitor,
      destination: undefined,
      deliver: async () => assert.fail("missing destination must not deliver"),
      now: clock.now,
    });
    await missingDestination.processNow();
    assert.equal(monitor.getState().incident?.deliveryTerminalAt, "2026-07-16T12:00:00.000Z");

    clock.set("2026-07-17T00:00:00.000Z");
    await missingDestination.processNow();
    assert.equal(
      monitor.getState().outbox.filter((entry) => entry.kind === "reminder").length,
      0,
      "a terminal destination does not create endless reminder entries",
    );

    const restored = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => jsonResponse(usageResponse(1_000, 1_250))) as typeof fetch,
    });
    const deliveries: TavilyDeliveryPayload[] = [];
    const configured = new TavilyMonitorRuntime({
      monitor: restored,
      destination: { chatId: 71 },
      deliver: async (payload) => { deliveries.push(payload); },
      now: clock.now,
    });
    await configured.start();
    await configured.stop();
    assert.equal(restored.getState().incident?.deliveryTerminalAt, undefined);
    assert.equal(deliveries.filter((delivery) => /exhaustion incident/.test(delivery.text)).length, 1);
    assert.equal(deliveries.some((delivery) => /exhaustion reminder/.test(delivery.text)), false);
  });

  it("retries a terminal threshold warning once after a configured restart", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => jsonResponse(usageResponse(800))) as typeof fetch,
    });
    await monitor.sampleUsage();
    const missingDestination = new TavilyMonitorRuntime({
      monitor,
      destination: undefined,
      deliver: async () => assert.fail("missing destination must not deliver"),
      now: clock.now,
    });
    await missingDestination.processNow();
    assert.equal(monitor.getState().outbox[0].status, "terminal");

    clock.set("2026-07-16T12:05:00.000Z");
    const restored = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => jsonResponse(usageResponse(800))) as typeof fetch,
    });
    const deliveries: TavilyDeliveryPayload[] = [];
    const configured = new TavilyMonitorRuntime({
      monitor: restored,
      destination: { chatId: 71 },
      deliver: async (payload) => { deliveries.push(payload); },
      now: clock.now,
    });
    await configured.start();
    await configured.stop();
    assert.equal(deliveries.filter((delivery) => /quota warning \(80%\)/.test(delivery.text)).length, 1);
    assert.equal(restored.getState().outbox.length, 0);
  });

  it("retries a terminal recovery notice without replaying its resolved incident", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "terminal-recovery");
    const recoveryResponses = [
      usageResponse(100),
      successfulSearchResponse(),
      successfulExtractResponse(),
    ];
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () =>
        jsonResponse(recoveryResponses.shift() as Record<string, unknown>)) as typeof fetch,
    });
    const missingDestination = new TavilyMonitorRuntime({
      monitor,
      destination: undefined,
      deliver: async () => assert.fail("missing destination must not deliver"),
      now: clock.now,
    });
    await missingDestination.processNow();
    const generation = monitor.getState().incident?.generation as string;
    assert.equal((await monitor.recheckIncident(generation)).ok, true);
    await missingDestination.processNow();
    assert.equal(monitor.getState().outbox.some((entry) =>
      entry.kind === "recovery" && entry.status === "terminal"), true);

    clock.set("2026-07-16T12:05:00.000Z");
    const restored = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => jsonResponse(usageResponse(100))) as typeof fetch,
    });
    const deliveries: TavilyDeliveryPayload[] = [];
    const configured = new TavilyMonitorRuntime({
      monitor: restored,
      destination: { chatId: 71 },
      deliver: async (payload) => { deliveries.push(payload); },
      now: clock.now,
    });
    await configured.start();
    await configured.stop();
    assert.equal(deliveries.filter((delivery) => /^Tavily recovered\./.test(delivery.text)).length, 1);
    assert.equal(deliveries.some((delivery) => /exhaustion incident/.test(delivery.text)), false);
  });

  it("aborts the active delivery during shutdown without starting the next due notification", async () => {
    const workspace = temporaryWorkspace();
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      fetchImpl: (async () => jsonResponse(usageResponse(950))) as typeof fetch,
    });
    await monitor.sampleUsage();
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    let observedSignal: AbortSignal | undefined;
    let deliveryAttempts = 0;
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliveryTimeoutMs: 60_000,
      deliver: async (_payload, signal) => {
        deliveryAttempts += 1;
        observedSignal = signal;
        deliveryStarted();
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    });

    const processing = runtime.processNow();
    await started;
    const stopping = runtime.stop();
    await Promise.all([processing, stopping]);
    assert.equal(observedSignal?.aborted, true);
    assert.equal(deliveryAttempts, 1);
    assert.equal(monitor.getState().outbox.length, 2);
    assert.equal(monitor.getState().outbox.every((entry) => entry.attempts === 0), true);
    await assert.rejects(runtime.processNow(), /runtime is stopped/);
    await assert.rejects(runtime.acknowledgeIncident("2026-07-1"), /runtime is stopped/);
  });

  it("classifies a delivery timeout as a durable transport retry", async () => {
    const workspace = temporaryWorkspace();
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      fetchImpl: (async () => jsonResponse(usageResponse(800))) as typeof fetch,
    });
    await monitor.sampleUsage();
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliveryTimeoutMs: 5,
      retryBaseMs: 10,
      retryMaxMs: 10,
      deliver: async (_payload, signal) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
        });
      },
    });

    await runtime.processNow();
    assert.equal(monitor.getState().outbox[0].lastFailure, "transport");
    assert.equal(monitor.getState().notificationStats.retried, 1);
  });

  it("retains notification deduplication after delivery and restart", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    const fetchImpl = (async () => jsonResponse(usageResponse(800))) as typeof fetch;
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl,
    });
    await monitor.sampleUsage();
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliver: async () => {},
      now: clock.now,
    });
    await runtime.processNow();
    assert.equal(monitor.getState().outbox.length, 0);

    clock.set("2026-07-16T12:05:00.000Z");
    const restored = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl,
    });
    await restored.sampleUsage();
    assert.equal(restored.getState().outbox.length, 0);
    assert.equal(restored.getState().notificationStats.delivered, 1);
  });
});

describe("Tavily operator transition runtime", () => {
  it("delivers failed explicit rechecks through the durable outbox", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "failed-recheck");
    let calls = 0;
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1
          ? jsonResponse(usageResponse(100))
          : jsonResponse({ results: [] });
      }) as typeof fetch,
    });
    const deliveries: TavilyDeliveryPayload[] = [];
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliver: async (payload) => { deliveries.push(payload); },
      now: clock.now,
    });
    await runtime.processNow();
    deliveries.splice(0);
    const generation = monitor.getState().incident?.generation as string;

    const result = await runtime.recheckIncident(generation);
    assert.equal(result.ok, false);
    assert.equal(deliveries.length, 1);
    assert.match(deliveries[0].text, /failed at search_probe \(probe_failed\).*remains active/);
    assert.equal(monitor.getState().outbox.some((entry) => entry.kind === "recheck_failure"), false);
    assert.equal(monitor.getState().notificationStats.delivered, 2);
  });

  it("coalesces concurrent rechecks into one bounded usage/Search/Extract flight", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(workspace, "2026-07-16T12:00:00.000Z", "single-flight");
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>((resolve) => { releaseUsage = resolve; });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        await usageGate;
        return jsonResponse(usageResponse(100));
      }
      if (calls === 2) return jsonResponse(successfulSearchResponse());
      if (calls === 3) return jsonResponse(successfulExtractResponse());
      throw new Error("unexpected extra recovery request");
    }) as typeof fetch;
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl,
    });
    monitor.drainChildEvents();
    const generation = monitor.getState().incident?.generation as string;
    const deliveries: TavilyDeliveryPayload[] = [];
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliver: async (payload) => { deliveries.push(payload); },
      now: clock.now,
    });

    const first = runtime.recheckIncident(generation);
    const second = runtime.recheckIncident(generation);
    assert.strictEqual(first, second);
    releaseUsage();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.ok, true);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(calls, 3);
    assert.ok(monitor.getState().incident?.resolvedAt);
    assert.equal(deliveries.filter((delivery) => delivery.text.startsWith("Tavily recovered.")).length, 1);
  });

  it("uses bounded destinations, callback data, and delivery error classes", () => {
    assert.deepEqual(resolveTavilyDeliveryDestination({
      adminChatId: 71,
      defaultDeliveryChatId: 72,
      defaultDeliveryThreadId: 17,
    }), { chatId: 71 });
    assert.deepEqual(resolveTavilyDeliveryDestination({
      defaultDeliveryChatId: -10071,
      defaultDeliveryThreadId: 17,
    }), { chatId: -10071, threadId: 17 });
    assert.equal(resolveTavilyDeliveryDestination({
      defaultDeliveryChatId: -10071,
      defaultDeliveryThreadId: -1,
    }), undefined);
    assert.equal(resolveTavilyDeliveryDestination({
      adminChatId: Number.MAX_SAFE_INTEGER + 1,
      defaultDeliveryChatId: 72,
    }), undefined);
    assert.equal(resolveTavilyDeliveryDestination({}), undefined);
    assert.deepEqual(parseTavilyCallbackData("tavily:ack:2026-07-1"), {
      action: "acknowledge",
      generation: "2026-07-1",
    });
    assert.deepEqual(parseTavilyCallbackData("tavily:recheck:2026-07-2"), {
      action: "recheck",
      generation: "2026-07-2",
    });
    assert.equal(parseTavilyCallbackData("tavily:recheck:private-value"), undefined);
    assert.deepEqual(classifyTavilyDeliveryError({ error_code: 503 }), { failure: "server_error" });
    assert.deepEqual(classifyTavilyDeliveryError(new Error("network")), { failure: "transport" });
  });
});
