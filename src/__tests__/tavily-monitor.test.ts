import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync } from "node:fs";
import {
  TAVILY_BILLING_URL,
  TAVILY_RECOVERY_EXTRACT_URL,
  TAVILY_RECOVERY_SEARCH_QUERY,
  TAVILY_STATE_RELPATH,
  TAVILY_USAGE_URL,
  TAVILY_WRITER_LEASE_RELPATH,
  TavilyMonitor,
  buildTavilyUsageRequest,
  isTavilyUsageRecoverable,
  parseTavilyUsageResponse,
  requestTavilyUsage,
  tavilyBillingCycleGeneration,
  tryAcquireTavilyWriterLease,
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
  keyLimit?: number | null;
  extra?: Record<string, unknown>;
} = {}): Record<string, unknown> {
  return {
    key: {
      usage: overrides.keyUsage ?? 700,
      limit: overrides.keyLimit === undefined ? 1_000 : overrides.keyLimit,
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
  it("keeps isolated usage and recovery-probe timeouts live until stalled fetches abort", () => {
    const monitorModule = pathToFileURL(resolve("src/tavily-monitor.ts")).href;
    const childScript = `
      import {
        parseTavilyUsageResponse,
        requestTavilyUsage,
        verifyTavilyRecovery,
      } from ${JSON.stringify(monitorModule)};

      function stalledFetch(_input, init) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }

      let usageAttempts = 0;
      const usageResult = await requestTavilyUsage({
        apiKey: "fixture-key",
        timeoutMs: 25,
        fetchImpl: (...args) => {
          usageAttempts += 1;
          return stalledFetch(...args);
        },
      });
      if (usageResult.ok ||
          usageResult.diagnostic.classification !== "provider_unavailable" ||
          usageAttempts !== 1) {
        throw new Error("isolated usage request did not time out once");
      }

      const sample = parseTavilyUsageResponse({
        key: { usage: 1, limit: 100 },
        account: {
          current_plan: "Researcher",
          plan_usage: 1,
          plan_limit: 100,
          paygo_usage: 0,
          paygo_limit: 0,
        },
      }, new Date("2026-07-17T00:00:00.000Z"));
      let probeAttempts = 0;
      const recoveryResult = await verifyTavilyRecovery({
        apiKey: "fixture-key",
        usageSample: sample,
        probeTimeoutMs: 25,
        fetchImpl: (...args) => {
          probeAttempts += 1;
          return stalledFetch(...args);
        },
      });
      if (recoveryResult.ok ||
          recoveryResult.stage !== "search_probe" ||
          recoveryResult.classification !== "provider_unavailable" ||
          probeAttempts !== 1) {
        throw new Error("isolated recovery probe did not time out once");
      }
      process.stdout.write("bounded\\n");
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript],
      { encoding: "utf8", timeout: 5_000 },
    );

    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "bounded\n");
  });

  it("cancels isolated usage and recovery-probe timers after early settlement", () => {
    const monitorModule = pathToFileURL(resolve("src/tavily-monitor.ts")).href;
    const childScript = `
      import {
        parseTavilyUsageResponse,
        requestTavilyUsage,
        verifyTavilyRecovery,
      } from ${JSON.stringify(monitorModule)};

      const longTimeoutMs = 60_000;
      const usageBody = {
        key: { usage: 1, limit: 100 },
        account: {
          current_plan: "Researcher",
          plan_usage: 1,
          plan_limit: 100,
          paygo_usage: 0,
          paygo_limit: 0,
        },
      };
      const searchBody = {
        results: [{ title: "Tavily", url: "https://tavily.com/", content: "Tavily" }],
      };
      const extractBody = {
        results: [{ url: "https://tavily.com/", raw_content: "Tavily" }],
      };
      const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
      const invalidJsonResponse = () => new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      const sequenceFetch = (...steps) => async () => {
        const step = steps.shift();
        if (step instanceof Error) throw step;
        if (!step) throw new Error("unexpected test fetch");
        return step;
      };
      const expect = (condition, message) => {
        if (!condition) throw new Error(message);
      };
      const usageOptions = { apiKey: "fixture-key", timeoutMs: longTimeoutMs };

      const rejectedUsage = await requestTavilyUsage({
        ...usageOptions,
        fetchImpl: async () => { throw new Error("offline"); },
      });
      expect(!rejectedUsage.ok, "usage rejection path was not exercised");

      const httpUsage = await requestTavilyUsage({
        ...usageOptions,
        fetchImpl: async () => jsonResponse({}, 503),
      });
      expect(!httpUsage.ok, "usage HTTP failure path was not exercised");

      const invalidUsage = await requestTavilyUsage({
        ...usageOptions,
        fetchImpl: async () => invalidJsonResponse(),
      });
      expect(!invalidUsage.ok, "usage JSON failure path was not exercised");

      const successfulUsage = await requestTavilyUsage({
        ...usageOptions,
        fetchImpl: async () => jsonResponse(usageBody),
      });
      expect(successfulUsage.ok, "usage success path was not exercised");
      const sample = parseTavilyUsageResponse(usageBody);
      const verify = (fetchImpl) => verifyTavilyRecovery({
        apiKey: "fixture-key",
        usageSample: sample,
        probeTimeoutMs: longTimeoutMs,
        fetchImpl,
      });

      const successfulRecovery = await verify(sequenceFetch(
        jsonResponse(searchBody),
        jsonResponse(extractBody),
      ));
      expect(successfulRecovery.ok, "recovery success paths were not exercised");

      for (const [name, fetchImpl] of [
        ["search rejection", sequenceFetch(new Error("offline"))],
        ["search HTTP failure", sequenceFetch(jsonResponse({}, 503))],
        ["search JSON failure", sequenceFetch(invalidJsonResponse())],
        ["extract rejection", sequenceFetch(jsonResponse(searchBody), new Error("offline"))],
        ["extract HTTP failure", sequenceFetch(jsonResponse(searchBody), jsonResponse({}, 503))],
        ["extract JSON failure", sequenceFetch(jsonResponse(searchBody), invalidJsonResponse())],
      ]) {
        const result = await verify(fetchImpl);
        expect(!result.ok, name + " path was not exercised");
      }

      process.stdout.write("cancelled\\n");
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript],
      { encoding: "utf8", timeout: 5_000 },
    );

    assert.equal(child.error, undefined, child.error?.message);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, "cancelled\n");
  });

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

  it("omits the key limit pair when Tavily explicitly reports a null limit", () => {
    const sample = parseTavilyUsageResponse(
      usageResponse({ keyUsage: 700, keyLimit: null, planUsage: 100 }),
      new Date("2026-07-16T09:00:00.000Z"),
    );

    assert.deepEqual(sample.key, {
      usage: 700,
      searchUsage: 600,
      extractUsage: 100,
    });
    assert.equal(isTavilyUsageRecoverable(sample), true);

    const exhaustedAccount = parseTavilyUsageResponse(
      usageResponse({
        keyUsage: 10_000,
        keyLimit: null,
        planUsage: 1_000,
        paygoUsage: 1_250,
      }),
    );
    assert.equal(
      isTavilyUsageRecoverable(exhaustedAccount),
      false,
      "an absent key cap does not bypass account capacity requirements",
    );

    const exhaustedFiniteKey = parseTavilyUsageResponse(
      usageResponse({ keyUsage: 1_000, keyLimit: 1_000, planUsage: 100 }),
    );
    assert.equal(isTavilyUsageRecoverable(exhaustedFiniteKey), false);
  });

  it("rejects malformed, missing, negative, and non-finite usage fields", () => {
    const malformed: unknown[] = [
      undefined,
      {},
      { key: {}, account: {} },
      { ...usageResponse(), key: { usage: 1 } },
      { ...usageResponse(), key: { usage: -1, limit: 1_000 } },
      { ...usageResponse(), key: { usage: 1, limit: "unlimited" } },
      { ...usageResponse(), key: { usage: 1, limit: -1 } },
      { ...usageResponse(), key: { usage: 1, limit: Number.NaN } },
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
    let bodyCanceled = false;
    const serverFailure = await requestTavilyUsage({
      apiKey: "fixture-key",
      now: clock,
      fetchImpl: (async () => ({
        ok: false,
        status: 503,
        body: { cancel: async () => { bodyCanceled = true; } },
        json: async () => { bodyRead = true; return { secret: "provider-body" }; },
      }) as unknown as Response) as typeof fetch,
    });
    assert.equal(serverFailure.ok, false);
    if (!serverFailure.ok) {
      assert.equal(serverFailure.diagnostic.classification, "provider_unavailable");
      assert.equal(serverFailure.diagnostic.httpStatus, 503);
    }
    assert.equal(bodyRead, false, "non-2xx provider bodies are never read");
    assert.equal(bodyCanceled, true, "non-2xx provider bodies are cancelled");

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
      jsonResponse(usageResponse({ keyLimit: null, planUsage: 100, paygoUsage: 0 })),
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

  it("rejects empty, malformed, HTTP-failed, and timed-out Extract probes", async () => {
    const recoverable = parseTavilyUsageResponse(
      usageResponse({ planUsage: 100 }),
      new Date("2026-07-16T11:00:00.000Z"),
    );
    const cases = [
      { response: jsonResponse({ results: [] }), classification: "probe_failed", httpStatus: undefined },
      {
        response: new Response("{", { status: 200, headers: { "Content-Type": "application/json" } }),
        classification: "probe_failed",
        httpStatus: undefined,
      },
      { response: jsonResponse({}, 503), classification: "provider_unavailable", httpStatus: 503 },
    ] as const;
    for (const testCase of cases) {
      const fetches = sequenceFetch([jsonResponse(successfulSearchResponse()), testCase.response]);
      const result = await verifyTavilyRecovery({
        apiKey: "fixture-key",
        usageSample: recoverable,
        fetchImpl: fetches.fetchImpl,
      });
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.stage, "extract_probe");
        assert.equal(result.classification, testCase.classification);
        assert.equal(result.httpStatus, testCase.httpStatus);
      }
      assert.equal(fetches.calls.length, 2);
    }

    let calls = 0;
    const timedOut = await verifyTavilyRecovery({
      apiKey: "fixture-key",
      usageSample: recoverable,
      probeTimeoutMs: 5,
      fetchImpl: ((_: string | URL | Request, init?: RequestInit) => {
        calls += 1;
        if (calls === 1) return Promise.resolve(jsonResponse(successfulSearchResponse()));
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }) as typeof fetch,
    });
    assert.equal(timedOut.ok, false);
    if (!timedOut.ok) {
      assert.equal(timedOut.stage, "extract_probe");
      assert.equal(timedOut.classification, "provider_unavailable");
    }
    assert.equal(calls, 2);
  });

  it("cancels non-2xx recovery-probe bodies without replacing their classification", async () => {
    const recoverable = parseTavilyUsageResponse(
      usageResponse({ planUsage: 100 }),
      new Date("2026-07-16T11:00:00.000Z"),
    );
    let bodyCanceled = false;
    const fetches = sequenceFetch([
      jsonResponse(successfulSearchResponse()),
      {
        ok: false,
        status: 503,
        body: { cancel: async () => { bodyCanceled = true; } },
      } as unknown as Response,
    ]);

    const result = await verifyTavilyRecovery({
      apiKey: "fixture-key",
      usageSample: recoverable,
      fetchImpl: fetches.fetchImpl,
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "extract_probe");
      assert.equal(result.classification, "provider_unavailable");
      assert.equal(result.httpStatus, 503);
    }
    assert.equal(bodyCanceled, true);
  });
});

describe("Tavily production writer lease", () => {
  it("permits one writer, recovers a dead owner, and protects a replacement from stale release", () => {
    const workspace = temporaryWorkspace();
    const first = tryAcquireTavilyWriterLease(workspace, {
      pid: 101,
      uniqueId: () => "first",
      now: () => new Date("2026-07-16T11:00:00.000Z"),
    });
    assert.ok(first);
    assert.equal(first.path, join(workspace, TAVILY_WRITER_LEASE_RELPATH));
    assert.equal(lstatSync(first.path).mode & 0o777, 0o600);

    const blocked = tryAcquireTavilyWriterLease(workspace, {
      pid: 102,
      uniqueId: () => "blocked",
      isProcessAlive: (pid) => pid === 101,
    });
    assert.equal(blocked, undefined);

    const replacement = tryAcquireTavilyWriterLease(workspace, {
      pid: 102,
      uniqueId: () => "replacement",
      now: () => new Date("2026-07-16T11:01:00.000Z"),
      isProcessAlive: () => false,
    });
    assert.ok(replacement);
    first.release();
    assert.equal(lstatSync(replacement.path).isFile(), true, "the stale owner cannot unlink its replacement");
    replacement.release();
    assert.equal(readdirSync(join(workspace, "data", "tavily")).includes("writer.lock"), false);
  });

  it("recovers a crashed writer lease after its PID is reused", () => {
    const workspace = temporaryWorkspace();
    const first = tryAcquireTavilyWriterLease(workspace, {
      pid: 101,
      uniqueId: () => "first-instance",
      getProcessIdentity: () => "old-process-instance",
      now: () => new Date("2026-07-16T11:00:00.000Z"),
    });
    assert.ok(first);

    const replacement = tryAcquireTavilyWriterLease(workspace, {
      pid: 102,
      uniqueId: () => "replacement-instance",
      isProcessAlive: () => true,
      getProcessIdentity: (pid) => pid === 101
        ? "reused-process-instance"
        : "replacement-process-instance",
      now: () => new Date("2026-07-16T11:01:00.000Z"),
    });
    assert.ok(replacement, "a different process instance must not inherit the stale lease");
    first.release();
    assert.equal(lstatSync(replacement.path).isFile(), true, "the stale release preserves its replacement");
    replacement.release();
  });

  it("uses acquisition time to recover a pre-fingerprint writer lease after PID reuse", () => {
    const workspace = temporaryWorkspace();
    const first = tryAcquireTavilyWriterLease(workspace, {
      pid: 101,
      uniqueId: () => "legacy-owner",
      getProcessIdentity: () => undefined,
      now: () => new Date("2026-07-16T11:00:00.000Z"),
    });
    assert.ok(first);

    const replacement = tryAcquireTavilyWriterLease(workspace, {
      pid: 102,
      uniqueId: () => "legacy-replacement",
      isProcessAlive: () => true,
      getProcessIdentity: () => undefined,
      getProcessStartedAt: (pid) => pid === 101
        ? new Date("2026-07-16T11:01:00.000Z").getTime()
        : new Date("2026-07-16T11:00:30.000Z").getTime(),
      now: () => new Date("2026-07-16T11:02:00.000Z"),
    });
    assert.ok(replacement);
    first.release();
    assert.equal(lstatSync(replacement.path).isFile(), true);
    replacement.release();
  });
});

describe("Tavily threshold and durable incident state", () => {
  it("records null-key-limit samples and deduplicates account 80/95 thresholds by UTC month", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-01T00:00:00.000Z");
    let usage = usageResponse({ keyLimit: null, planUsage: 799, paygoUsage: 999, paygoLimit: 1_250 });
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => jsonResponse(usage)) as typeof fetch,
    });

    const firstResult = await monitor.sampleUsage();
    assert.equal(firstResult.ok, true, "an explicit null key limit is a successful sampler result");
    const firstState = monitor.getState();
    assert.deepEqual(firstState.latestSample?.key, {
      usage: 700,
      searchUsage: 600,
      extractUsage: 100,
    });
    assert.deepEqual(firstState.latestSampleStatus, {
      classification: "ok",
      observedAt: "2026-07-01T00:00:00.000Z",
    });
    assert.deepEqual(firstState.telemetryStats.usageSamples, { success: 1, failure: 0 });
    assert.equal(
      firstState.telemetryStats.failures.some((failure) => failure.classification === "usage_invalid"),
      false,
    );
    assert.equal(firstState.outbox.length, 0);

    clock.set("2026-07-02T00:00:00.000Z");
    usage = usageResponse({ keyLimit: null, planUsage: 800, paygoUsage: 1_000, paygoLimit: 1_250 });
    await monitor.sampleUsage();
    assert.deepEqual(
      monitor.getState().outbox.map((entry) => entry.key).sort(),
      ["threshold:2026-07:paygo:80", "threshold:2026-07:plan:80"],
    );

    clock.set("2026-07-03T00:00:00.000Z");
    usage = usageResponse({ keyLimit: null, planUsage: 950, paygoUsage: 1_188, paygoLimit: 1_250 });
    await monitor.sampleUsage();
    await monitor.sampleUsage();
    assert.deepEqual(
      monitor.getState().outbox.map((entry) => entry.key).sort(),
      [
        "threshold:2026-07:paygo:80",
        "threshold:2026-07:paygo:95",
        "threshold:2026-07:plan:80",
        "threshold:2026-07:plan:95",
      ],
      "account thresholds remain unchanged and same-cycle samples remain deduplicated",
    );

    clock.set("2026-08-01T00:00:00.000Z");
    usage = usageResponse({ keyLimit: null, planUsage: 800, paygoUsage: 0, paygoLimit: 1_250 });
    await monitor.sampleUsage();
    const state = monitor.getState();
    assert.equal(state.outbox.length, 1, "prior-cycle threshold notices are no longer actionable");
    assert.ok(state.notificationKeys.includes("threshold:2026-08:plan:80"));
    assert.equal(state.notificationKeys.some((key) => key.startsWith("threshold:2026-07:")), false);
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

  it("drains, reminds every six hours, and stops reminders on acknowledgement", () => {
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
    });
    monitor.drainChildEvents();
    const generation = monitor.getState().incident?.generation as string;
    assert.ok(generation);
    const incidentKey = monitor.getState().outbox.find((entry) => entry.kind === "incident")?.key;
    assert.ok(incidentKey);
    assert.equal(monitor.recordNotificationDelivered(incidentKey), true);

    clock.set("2026-07-16T17:59:59.999Z");
    assert.equal(monitor.queueDueReminder(), false);
    clock.set("2026-07-16T18:00:00.000Z");
    assert.equal(monitor.queueDueReminder(), true);
    assert.equal(monitor.queueDueReminder(), false);
    assert.equal(monitor.getState().outbox.filter((entry) => entry.kind === "reminder").length, 1);
    const firstReminderKey = monitor.getState().outbox.find((entry) => entry.kind === "reminder")?.key;
    assert.ok(firstReminderKey);
    assert.equal(monitor.recordNotificationDelivered(firstReminderKey), true);
    assert.equal(monitor.getState().notificationKeys.includes(firstReminderKey), false);
    clock.set("2026-07-17T00:00:00.000Z");
    assert.equal(monitor.queueDueReminder(), true);

    assert.equal(monitor.acknowledgeIncident("stale-generation"), false);
    assert.equal(monitor.acknowledgeIncident(generation), true);
    const acknowledgedAt = monitor.getState().incident?.acknowledgedAt;
    assert.equal(monitor.acknowledgeIncident(generation), true, "acknowledgement is idempotent");
    assert.equal(monitor.getState().incident?.acknowledgedAt, acknowledgedAt);
    assert.equal(monitor.getState().outbox.some((entry) => entry.kind === "reminder"), false);
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
    assert.equal(monitor.getState().outbox.filter((entry) => entry.kind === "recheck_failure").length, 1);
    assert.match(
      monitor.getState().outbox.find((entry) => entry.kind === "recheck_failure")?.message ?? "",
      /failed at search_probe \(probe_failed\).*remains active/,
    );

    clock.set("2026-07-16T12:05:00.000Z");
    const recovered = await monitor.recheckIncident(generation);
    assert.equal(recovered.ok, true);
    assert.equal(monitor.getState().incident?.resolvedAt, "2026-07-16T12:05:00.000Z");
    assert.deepEqual(monitor.getState().outbox.map((entry) => entry.kind), ["recovery"]);

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

  it("waits for key-level capacity before automatic recovery", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:00:00.000Z");
    writeExhaustionEvent(
      workspace,
      "web_search",
      "base_plan_exhausted",
      "2026-07-16T12:00:00.000Z",
      "key-capacity",
    );
    const fetches = sequenceFetch([
      jsonResponse(usageResponse({ planUsage: 100, keyUsage: 1_000, keyLimit: 1_000 })),
      jsonResponse(usageResponse({ planUsage: 100, keyUsage: 999, keyLimit: 1_000 })),
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
    assert.equal(fetches.calls.length, 1, "account capacity cannot override an exhausted key");
    assert.equal(monitor.getState().incident?.lastUsageRecoverable, false);

    clock.set("2026-07-16T12:05:00.000Z");
    await monitor.sampleUsage();
    assert.equal(fetches.calls.length, 4);
    assert.ok(monitor.getState().incident?.resolvedAt);
  });

  it("keeps an incident active when exhaustion arrives during recovery probes", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:05:00.000Z");
    writeExhaustionEvent(
      workspace,
      "web_search",
      "base_plan_exhausted",
      "2026-07-16T12:00:00.000Z",
      "verification-start",
    );
    let calls = 0;
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1 || calls === 4) {
          return jsonResponse(usageResponse({ planUsage: 100 }));
        }
        if (calls === 2 || calls === 5) return jsonResponse(successfulSearchResponse());
        if (calls === 3) {
          writeExhaustionEvent(
            workspace,
            "web_fetch",
            "paygo_exhausted",
            "2026-07-16T12:05:00.000Z",
            "during-verification",
          );
        }
        return jsonResponse(successfulExtractResponse());
      }) as typeof fetch,
    });
    monitor.drainChildEvents();
    const generation = monitor.getState().incident?.generation as string;

    const result = await monitor.recheckIncident(generation);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "usage_state");
      assert.equal(result.classification, "usage_exhausted");
    }
    assert.equal(monitor.getState().incident?.resolvedAt, undefined);
    assert.equal(monitor.getState().incident?.lastObservedAt, "2026-07-16T12:05:00.000Z");
    assert.equal(monitor.getState().incident?.exhaustionSequence, 2);
    assert.equal(monitor.getState().outbox.some((entry) => entry.kind === "recovery"), false);

    clock.set("2026-07-16T12:10:00.000Z");
    await monitor.sampleUsage();
    assert.equal(calls, 6, "a later recoverable transition reruns both probes");
    assert.ok(monitor.getState().incident?.resolvedAt);
  });

  it("waits for a cross-process request that observed exhaustion before publishing", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:05:00.000Z");
    writeExhaustionEvent(
      workspace,
      "web_search",
      "base_plan_exhausted",
      "2026-07-16T12:00:00.000Z",
      "verification-start",
    );
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: sequenceFetch([
        jsonResponse(usageResponse({ planUsage: 100 })),
        jsonResponse(successfulSearchResponse()),
        jsonResponse(successfulExtractResponse()),
      ]).fetchImpl,
    });
    monitor.drainChildEvents();
    const generation = monitor.getState().incident?.generation as string;

    const eventsModule = pathToFileURL(resolve("src/pi-extensions/tavily-events.ts")).href;
    const childScript = `
      import {
        beginTavilyToolRequestPublication,
      } from ${JSON.stringify(eventsModule)};
      const workspace = process.argv[1];
      const publication = beginTavilyToolRequestPublication(workspace);
      process.stdout.write("observed\\n");
      setTimeout(() => {
        publication.complete(
          "web_fetch",
          { classification: "paygo_exhausted", httpStatus: 433 },
          new Date("2026-07-16T12:06:00.000Z"),
        );
      }, 150);
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childScript, workspace],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const exited = new Promise<number | null>((resolveExit) => child.once("exit", resolveExit));
    await new Promise<void>((resolveLocked, rejectLocked) => {
      let output = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("observed\n")) resolveLocked();
      });
      child.once("error", rejectLocked);
      child.once("exit", (code) => {
        if (!output.includes("observed\n")) {
          rejectLocked(new Error(`publication child exited early (${code}): ${stderr}`));
        }
      });
    });

    const result = await monitor.recheckIncident(generation);
    assert.equal(await exited, 0, stderr);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "usage_state");
      assert.equal(result.classification, "usage_exhausted");
    }
    assert.equal(monitor.getState().incident?.resolvedAt, undefined);
    assert.equal(monitor.getState().outbox.some((entry) => entry.kind === "recovery"), false);
  });

  it("reopens for an event published after the final drain but before resolution commits", async () => {
    const workspace = temporaryWorkspace();
    const clock = mutableClock("2026-07-16T12:05:00.000Z");
    writeExhaustionEvent(
      workspace,
      "web_search",
      "base_plan_exhausted",
      "2026-07-16T12:00:00.000Z",
      "verification-start",
    );
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: clock.now,
      fetchImpl: sequenceFetch([
        jsonResponse(usageResponse({ planUsage: 100 })),
        jsonResponse(successfulSearchResponse()),
        jsonResponse(successfulExtractResponse()),
      ]).fetchImpl,
    });
    monitor.drainChildEvents();
    const firstGeneration = monitor.getState().incident?.generation as string;
    const originalDrain = monitor.drainChildEvents.bind(monitor);
    let verificationDrains = 0;
    monitor.drainChildEvents = () => {
      verificationDrains += 1;
      const processed = originalDrain();
      if (verificationDrains === 2) {
        clock.set("2026-07-16T12:06:00.000Z");
        writeExhaustionEvent(
          workspace,
          "web_fetch",
          "paygo_exhausted",
          "2026-07-16T12:06:00.000Z",
          "after-final-listing",
        );
      }
      return processed;
    };

    const result = await monitor.recheckIncident(firstGeneration);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.stage, "usage_state");
      assert.equal(result.classification, "usage_exhausted");
    }
    const state = monitor.getState();
    assert.equal(state.incident?.generation, "2026-07-2");
    assert.equal(state.incident?.resolvedAt, undefined);
    assert.equal(state.outbox.some((entry) => entry.kind === "recovery"), false);
    assert.equal(state.outbox.filter((entry) => entry.kind === "incident").length, 1);
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
    assert.equal(state.outbox.filter((entry) => entry.kind === "incident").length, 1);
    assert.equal(state.outbox.some((entry) => entry.kind === "recovery"), false);
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

  it("round-trips finite and absent key limit pairs through durable state", async () => {
    const workspace = temporaryWorkspace();
    let response = usageResponse({ keyLimit: 1_000, planUsage: 100 });
    const options = {
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      now: () => new Date("2026-07-16T12:00:00.000Z"),
      fetchImpl: (async () => jsonResponse(response)) as typeof fetch,
    };
    const monitor = new TavilyMonitor(options);

    await monitor.sampleUsage();
    const finiteState = monitor.getState();
    assert.deepEqual(new TavilyMonitor(options).getState(), finiteState);
    assert.deepEqual(finiteState.latestSample?.key, {
      usage: 700,
      limit: 1_000,
      remaining: 300,
      searchUsage: 600,
      extractUsage: 100,
    });

    response = usageResponse({ keyLimit: null, planUsage: 100 });
    await monitor.sampleUsage();
    const absentState = monitor.getState();
    assert.deepEqual(new TavilyMonitor(options).getState(), absentState);
    assert.deepEqual(absentState.latestSample?.key, {
      usage: 700,
      searchUsage: 600,
      extractUsage: 100,
    });
  });

  it("does not mutate live state or delete a child event when persistence fails", () => {
    const workspace = temporaryWorkspace();
    const eventPath = writeExhaustionEvent(
      workspace,
      "web_search",
      "base_plan_exhausted",
      "2026-07-16T12:00:00.000Z",
      "save-failure",
    );
    const monitor = new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key" });
    const before = monitor.getState();
    const temporaryStatePath = join(workspace, "data", "tavily", ".state.json.tmp");
    mkdirSync(temporaryStatePath);

    assert.throws(() => monitor.drainChildEvents(), /temporary state is not a file/);
    assert.deepEqual(monitor.getState(), before);
    assert.equal(lstatSync(eventPath).isFile(), true, "uncommitted spool event remains available");

    rmSync(temporaryStatePath, { recursive: true });
    assert.equal(monitor.drainChildEvents(), 1);
    assert.ok(monitor.getState().incident);
    const restored = new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key" });
    assert.deepEqual(restored.getState(), monitor.getState());
  });

  it("rejects malformed, legacy, duplicate, private, and symlinked state documents", async () => {
    const workspace = temporaryWorkspace();
    const monitor = new TavilyMonitor({
      controlWorkspaceRoot: workspace,
      apiKey: "fixture-key",
      fetchImpl: (async () => jsonResponse(usageResponse())) as typeof fetch,
    });
    await monitor.sampleUsage();
    const statePath = join(workspace, TAVILY_STATE_RELPATH);
    const valid = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    const invalidDocuments: unknown[] = [
      "{",
      { ...valid, privateQuery: "must-not-be-accepted" },
      { ...valid, telemetryStats: undefined },
      { ...valid, notificationKeys: ["duplicate", "duplicate"] },
      {
        ...valid,
        latestSample: {
          ...(valid.latestSample as Record<string, unknown>),
          key: { usage: 700, limit: 1_000 },
        },
      },
      {
        ...valid,
        latestSample: {
          ...(valid.latestSample as Record<string, unknown>),
          key: { usage: 700, remaining: 300 },
        },
      },
      {
        ...valid,
        latestSample: {
          ...(valid.latestSample as Record<string, unknown>),
          key: { usage: 700, limit: 1_000, remaining: 299 },
        },
      },
    ];
    for (const document of invalidDocuments) {
      writeFileSync(statePath, typeof document === "string" ? document : JSON.stringify(document), "utf8");
      assert.throws(
        () => new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key" }),
        /state is invalid/,
      );
    }

    const outside = join(workspace, "outside-state.json");
    writeFileSync(outside, JSON.stringify(valid), { mode: 0o600 });
    rmSync(statePath);
    symlinkSync(outside, statePath);
    assert.throws(
      () => new TavilyMonitor({ controlWorkspaceRoot: workspace, apiKey: "fixture-key" }),
      /state is not a plain file/,
    );
  });
});
