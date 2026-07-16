import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { TavilyMonitor } from "../tavily-monitor.js";
import {
  TAVILY_USAGE_SAMPLE_INTERVAL_MS,
  TavilyMonitorRuntime,
  classifyTavilyDeliveryError,
  parseTavilyCallbackData,
  resolveTavilyDeliveryDestination,
  type TavilyDeliveryPayload,
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
    const runtime = new TavilyMonitorRuntime({
      monitor,
      destination: { chatId: 71 },
      deliver: async () => {},
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
