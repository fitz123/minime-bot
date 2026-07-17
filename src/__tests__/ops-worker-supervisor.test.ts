import assert from "node:assert/strict";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  OPS_WORKER_DONE_CHECK_LIMITS,
  OpsWorkerDoneCheckExecutionError,
  OpsWorkerDoneCheckRegistry,
  type OpsWorkerDoneCheckDefinition,
  type OpsWorkerDoneCheckResult,
} from "../ops-worker/done-checks.js";
import {
  OpsWorkerDuplicateCorrelationError,
  OpsWorkerTaskStore,
} from "../ops-worker/task-store.js";
import {
  OpsWorkerStaleCheckResultError,
  OpsWorkerSupervisor,
  OpsWorkerSupervisorAlreadyRunningError,
  OpsWorkerSupervisorStateError,
} from "../ops-worker/supervisor.js";
import {
  type JsonObject,
  type OpsWorkerSourceKind,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "../ops-worker/types.js";

const NOW = "2026-07-17T12:00:00.000Z";
const LATER = "2026-07-17T12:05:00.000Z";

function validateFixtureParams(value: unknown): JsonObject {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  const params = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(params), ["sampleCount"]);
  assert.ok(Number.isSafeInteger(params.sampleCount));
  assert.ok((params.sampleCount as number) >= 1);
  assert.ok((params.sampleCount as number) <= 10);
  return { sampleCount: params.sampleCount as number };
}

function taskRegistry(
  checks: OpsWorkerDoneCheckRegistry,
): OpsWorkerTaskContractRegistry {
  return {
    templates: {
      "fixture-task": {
        sourceKinds: [
          "alertmanager",
          "operator-cli",
          "registered-cron",
          "authorized-issue",
        ],
      },
    },
    authorizationProfiles: {
      "fixture.inspect.v1": {
        sourceKinds: [
          "alertmanager",
          "operator-cli",
          "registered-cron",
          "authorized-issue",
        ],
        scope: ["inspect"],
        tools: ["read", "grep", "find", "ls"],
      },
    },
    doneChecks: checks.contracts,
  };
}

function makeTask(
  id: string,
  options: {
    sourceKind?: OpsWorkerSourceKind;
    correlationKey?: string;
    createdAt?: string;
    maxRemediation?: number;
  } = {},
): OpsWorkerTask {
  const sourceKind = options.sourceKind ?? "operator-cli";
  const priority = {
    alertmanager: 0,
    "operator-cli": 10,
    "registered-cron": 20,
    "authorized-issue": 30,
  }[sourceKind] as OpsWorkerTask["priority"];
  return {
    schemaVersion: 1,
    id,
    source: {
      kind: sourceKind,
      correlationKey: options.correlationKey ?? `fixture:${id}`,
      template: "fixture-task",
    },
    priority,
    objective: "Exercise the registered deterministic fixture",
    evidence: [],
    doneCheck: {
      name: "fixture-check",
      params: { sampleCount: 1 },
    },
    authorization: {
      profile: "fixture.inspect.v1",
      scope: ["inspect"],
      snapshotHash: null,
    },
    state: "QUEUED",
    rounds: {
      remediation: 0,
      maxRemediation: options.maxRemediation ?? 3,
      consecutiveInfrastructureFailures: 0,
    },
    schedule: {
      nextRunAt: null,
      nextCheckAt: null,
    },
    session: {
      directory: `sessions/${id}`,
      sessionId: null,
      resume: false,
    },
    activeRun: null,
    lastOutcome: null,
    report: {
      state: "NONE",
      attempts: 0,
      lastError: null,
    },
    createdAt: options.createdAt ?? NOW,
    updatedAt: options.createdAt ?? NOW,
  };
}

interface Harness {
  directory: string;
  store: OpsWorkerTaskStore;
  supervisor: OpsWorkerSupervisor;
  setNow(value: string): void;
  close(): void;
}

async function makeHarness(
  t: TestContext,
  options: {
    implementation?: OpsWorkerDoneCheckDefinition["run"];
    directory?: string;
    instanceId?: string;
    reconcileActiveRun?: ConstructorParameters<typeof OpsWorkerSupervisor>[0]["reconcileActiveRun"];
  } = {},
): Promise<Harness> {
  let currentNow = NOW;
  const directory = options.directory
    ?? mkdtempSync(join(tmpdir(), "minime-ops-worker-supervisor-"));
  const ownsDirectory = options.directory === undefined;
  const doneChecks = new OpsWorkerDoneCheckRegistry({
    "fixture-check": {
      timeoutMs: 100,
      validateParams: validateFixtureParams,
      run: options.implementation ?? (() => ({
        result: "PASS",
        summary: "Fixture is deterministically complete.",
      })),
    },
  });
  const store = new OpsWorkerTaskStore(directory, {
    registry: taskRegistry(doneChecks),
    now: () => new Date(currentNow),
  });
  const supervisor = new OpsWorkerSupervisor({
    store,
    doneChecks,
    instanceId: options.instanceId ?? "fixture-supervisor",
    processStartToken: `${options.instanceId ?? "fixture-supervisor"}-start`,
    now: () => new Date(currentNow),
    infrastructureRetryMs: 1_000,
    reconcileActiveRun: options.reconcileActiveRun,
  });
  await supervisor.start();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    supervisor.close();
    if (ownsDirectory) rmSync(directory, { recursive: true, force: true });
  };
  t.after(close);
  return {
    directory,
    store,
    supervisor,
    setNow(value: string): void {
      currentNow = value;
    },
    close,
  };
}

function activeRun(instanceId: string): NonNullable<OpsWorkerTask["activeRun"]> {
  return {
    attemptId: "attempt-01",
    supervisorInstanceId: instanceId,
    pid: 321,
    processGroupId: 321,
    processStartedAt: NOW,
    processStartToken: "fixture-process-start",
  };
}

describe("ops worker done-check registry", () => {
  it("enforces strict parameters and the closed tri-state output", async () => {
    const registry = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 100,
        validateParams: validateFixtureParams,
        run: () => ({ result: "PASS", summary: "All fixture samples passed." }),
      },
    });

    await assert.rejects(
      registry.run(
        { name: "missing-check", params: { sampleCount: 1 } },
        { taskId: "task-a", checkedAt: NOW },
      ),
      (error: unknown) =>
        error instanceof OpsWorkerDoneCheckExecutionError
        && error.code === "UNKNOWN_CHECK",
    );
    await assert.rejects(
      registry.run(
        { name: "fixture-check", params: { sampleCount: 1, extra: true } },
        { taskId: "task-a", checkedAt: NOW },
      ),
      (error: unknown) =>
        error instanceof OpsWorkerDoneCheckExecutionError
        && error.code === "INVALID_PARAMS",
    );

    const result = await registry.run(
      { name: "fixture-check", params: { sampleCount: 1 } },
      { taskId: "task-a", checkedAt: NOW },
    );
    assert.deepEqual(result, {
      result: "PASS",
      summary: "All fixture samples passed.",
    });

    const invalid = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 100,
        validateParams: validateFixtureParams,
        run: () => ({ result: "PASS", summary: "passed", extra: true }),
      },
    });
    await assert.rejects(
      invalid.run(
        { name: "fixture-check", params: { sampleCount: 1 } },
        { taskId: "task-a", checkedAt: NOW },
      ),
      (error: unknown) =>
        error instanceof OpsWorkerDoneCheckExecutionError
        && error.code === "INVALID_RESULT",
    );
  });

  it("bounds fixture execution time and output", async () => {
    let observedAbort = false;
    const timeoutRegistry = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 5,
        validateParams: validateFixtureParams,
        run: (_params, context) => new Promise((_resolve) => {
          context.signal.addEventListener("abort", () => {
            observedAbort = true;
          });
        }),
      },
    });
    await assert.rejects(
      timeoutRegistry.run(
        { name: "fixture-check", params: { sampleCount: 1 } },
        { taskId: "task-a", checkedAt: NOW },
      ),
      (error: unknown) =>
        error instanceof OpsWorkerDoneCheckExecutionError
        && error.code === "TIMEOUT",
    );
    assert.equal(observedAbort, true);

    const outputRegistry = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 100,
        validateParams: validateFixtureParams,
        run: () => ({
          result: "ACTION_REQUIRED",
          summary: "x".repeat(OPS_WORKER_DONE_CHECK_LIMITS.maxSummaryBytes + 1),
        }),
      },
    });
    await assert.rejects(
      outputRegistry.run(
        { name: "fixture-check", params: { sampleCount: 1 } },
        { taskId: "task-a", checkedAt: NOW },
      ),
      (error: unknown) =>
        error instanceof OpsWorkerDoneCheckExecutionError
        && error.code === "INVALID_RESULT",
    );

    const unserializableRegistry = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 100,
        validateParams: validateFixtureParams,
        run: () => ({
          result: "DEFER",
          summary: "wait",
          nextCheckAt: 1n,
        }),
      },
    });
    await assert.rejects(
      unserializableRegistry.run(
        { name: "fixture-check", params: { sampleCount: 1 } },
        { taskId: "task-a", checkedAt: NOW },
      ),
      (error: unknown) =>
        error instanceof OpsWorkerDoneCheckExecutionError
        && error.code === "INVALID_RESULT",
    );
  });

  it("aborts an active check when worker shutdown is requested", async () => {
    let observedAbort = false;
    const registry = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 10_000,
        validateParams: validateFixtureParams,
        run: (_params, context) => new Promise(() => {
          context.signal.addEventListener("abort", () => {
            observedAbort = true;
          });
        }),
      },
    });
    const controller = new AbortController();
    const pending = registry.run(
      { name: "fixture-check", params: { sampleCount: 1 } },
      { taskId: "task-a", checkedAt: NOW },
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(
      pending,
      (error: unknown) =>
        error instanceof OpsWorkerDoneCheckExecutionError
        && error.code === "ABORTED",
    );
    assert.equal(observedAbort, true);
  });
});

describe("ops worker supervisor", () => {
  it("selects ready tasks deterministically by fixed source priority", async (t) => {
    const harness = await makeHarness(t);
    const later = makeTask("task-later", {
      sourceKind: "alertmanager",
      createdAt: "2026-07-17T12:00:01.000Z",
    });
    later.schedule.nextRunAt = LATER;
    harness.store.create(later);
    harness.store.create(makeTask("task-operator", {
      sourceKind: "operator-cli",
      createdAt: "2026-07-17T11:59:00.000Z",
    }));
    harness.store.create(makeTask("task-alert", {
      sourceKind: "alertmanager",
    }));

    assert.equal(harness.supervisor.selectNextTask()?.task.id, "task-alert");
    harness.supervisor.cancelTask("task-alert", "Fixture cleanup");
    assert.equal(harness.supervisor.selectNextTask()?.task.id, "task-operator");
    harness.setNow(LATER);
    assert.equal(harness.supervisor.selectNextTask()?.task.id, "task-later");
  });

  it("allows DONE only through a fresh PASS, even without a Pi success claim", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("task-pass"));

    assert.throws(
      () => harness.supervisor.recordPiSuccessClaim("task-pass", "claim"),
      /requires RUNNING/,
    );
    const forged = structuredClone(harness.store.get("task-pass"));
    assert.ok(forged);
    forged.state = "DONE";
    forged.updatedAt = LATER;
    forged.lastOutcome = {
      at: LATER,
      kind: "PI_EXIT",
      result: "SUCCESS_CLAIM",
      summary: "Pi claimed success without deterministic verification.",
    };
    assert.throws(
      () => harness.store.replace(forged),
      /DONE requires a fresh DONE_CHECK PASS/,
    );
    harness.supervisor.requestDoneCheck("task-pass");
    const done = await harness.supervisor.runDoneCheck("task-pass");
    assert.equal(done.state, "DONE");
    assert.equal(done.lastOutcome?.result, "PASS");
    assert.equal(done.report.state, "PENDING");
    assert.throws(
      () => harness.supervisor.cancelTask("task-pass", "too late"),
      /Illegal ops-worker transition DONE -> CANCELLED/,
    );
  });

  it("discards a stale PASS when the task changes during the check", async (t) => {
    let resolveCheck: ((result: OpsWorkerDoneCheckResult) => void) | undefined;
    const harness = await makeHarness(t, {
      implementation: () => new Promise<OpsWorkerDoneCheckResult>((resolve) => {
        resolveCheck = resolve;
      }),
    });
    harness.store.create(makeTask("task-stale"));
    harness.supervisor.requestDoneCheck("task-stale");

    const pending = harness.supervisor.runDoneCheck("task-stale");
    await new Promise((resolve) => setImmediate(resolve));
    harness.supervisor.cancelTask("task-stale", "Operator cancelled during check");
    assert.ok(resolveCheck);
    resolveCheck({ result: "PASS", summary: "Late fixture pass" });
    await assert.rejects(pending, OpsWorkerStaleCheckResultError);
    assert.equal(harness.store.get("task-stale")?.state, "CANCELLED");
  });

  it("returns ACTION_REQUIRED evidence to the same task and blocks at budget exhaustion", async (t) => {
    const harness = await makeHarness(t, {
      implementation: () => ({
        result: "ACTION_REQUIRED",
        summary: "A registered fixture still needs remediation.",
      }),
    });
    harness.store.create(makeTask("task-budget", { maxRemediation: 2 }));

    harness.supervisor.markRunning(
      "task-budget",
      activeRun("fixture-supervisor"),
    );
    harness.supervisor.recordPiSuccessClaim(
      "task-budget",
      "Pi claimed the registered objective was complete.",
    );
    const first = await harness.supervisor.runDoneCheck("task-budget");
    assert.equal(first.state, "RESUMABLE");
    assert.equal(first.rounds.remediation, 1);
    assert.equal(first.evidence.at(-1)?.kind, "check");
    assert.match(first.evidence.at(-1)?.summary ?? "", /still needs remediation/);

    harness.supervisor.markRunning(
      "task-budget",
      { ...activeRun("fixture-supervisor"), attemptId: "attempt-02" },
    );
    harness.supervisor.recordPiSuccessClaim(
      "task-budget",
      "Pi made a second success claim.",
    );
    const exhausted = await harness.supervisor.runDoneCheck("task-budget");
    assert.equal(exhausted.state, "BLOCKED");
    assert.equal(exhausted.rounds.remediation, 2);
    assert.equal(exhausted.report.state, "PENDING");
  });

  it("schedules DEFER without budget spend and makes check errors resumable", async (t) => {
    let result: unknown = {
      result: "DEFER",
      summary: "The fixture needs a later observation window.",
      nextCheckAt: LATER,
    };
    const harness = await makeHarness(t, {
      implementation: () => result,
    });
    harness.store.create(makeTask("task-defer"));
    harness.supervisor.requestDoneCheck("task-defer");
    const deferred = await harness.supervisor.runDoneCheck("task-defer");
    assert.equal(deferred.state, "CHECKING");
    assert.equal(deferred.schedule.nextCheckAt, LATER);
    assert.equal(deferred.rounds.remediation, 0);
    assert.equal(harness.supervisor.selectNextTask(), undefined);

    harness.setNow(LATER);
    assert.equal(harness.supervisor.selectNextTask()?.action, "CHECK");
    result = { result: "UNKNOWN", summary: "invalid fixture result" };
    const resumable = await harness.supervisor.runDoneCheck("task-defer");
    assert.equal(resumable.state, "RESUMABLE");
    assert.equal(resumable.rounds.remediation, 0);
    assert.equal(resumable.rounds.consecutiveInfrastructureFailures, 1);
    assert.equal(resumable.lastOutcome?.result, "ERROR");
    assert.ok(resumable.schedule.nextRunAt);
  });

  it("keeps infrastructure failures resumable without spending remediation budget", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("task-network"));
    harness.supervisor.markRunning(
      "task-network",
      activeRun("fixture-supervisor"),
    );

    const task = harness.supervisor.recordResumableInfrastructureOutcome(
      "task-network",
      "NETWORK",
      "Registered attempt hit a transient network failure.",
    );
    assert.equal(task.state, "RESUMABLE");
    assert.equal(task.rounds.remediation, 0);
    assert.equal(task.rounds.consecutiveInfrastructureFailures, 1);
    assert.equal(task.activeRun, null);
  });

  it("blocks at the bounded infrastructure-failure limit and retries only BLOCKED tasks", async (t) => {
    const harness = await makeHarness(t);
    const task = makeTask("task-infrastructure-bound");
    task.rounds.consecutiveInfrastructureFailures = 999;
    harness.store.create(task);
    assert.throws(
      () => harness.supervisor.retryBlockedTask(task.id),
      /Operator retry requires BLOCKED, found QUEUED/,
    );
    harness.supervisor.markRunning(task.id, activeRun("fixture-supervisor"));

    const blocked = harness.supervisor.recordResumableInfrastructureOutcome(
      task.id,
      "NETWORK",
      "Persistent synthetic network failure",
    );

    assert.equal(blocked.state, "BLOCKED");
    assert.equal(blocked.rounds.consecutiveInfrastructureFailures, 1_000);
    assert.equal(blocked.rounds.remediation, 0);
    assert.equal(blocked.report.state, "PENDING");
    const retried = harness.supervisor.retryBlockedTask(task.id);
    assert.equal(retried.state, "RESUMABLE");
    assert.equal(retried.rounds.consecutiveInfrastructureFailures, 0);
  });

  it("enforces one supervisor instance and at most one active process group", async (t) => {
    const harness = await makeHarness(t);
    const secondStore = new OpsWorkerTaskStore(harness.directory, {
      registry: taskRegistry(new OpsWorkerDoneCheckRegistry({
        "fixture-check": {
          timeoutMs: 100,
          validateParams: validateFixtureParams,
          run: () => ({ result: "PASS", summary: "fixture passed" }),
        },
      })),
    });
    const second = new OpsWorkerSupervisor({
      store: secondStore,
      doneChecks: new OpsWorkerDoneCheckRegistry({
        "fixture-check": {
          timeoutMs: 100,
          validateParams: validateFixtureParams,
          run: () => ({ result: "PASS", summary: "fixture passed" }),
        },
      }),
      instanceId: "second-supervisor",
      processStartToken: "second-supervisor-start",
      inspectLockOwner: () => "ACTIVE",
    });
    await assert.rejects(
      second.start(),
      OpsWorkerSupervisorAlreadyRunningError,
    );

    harness.store.create(makeTask("task-active-a"));
    harness.store.create(makeTask("task-active-b"));
    harness.supervisor.markRunning(
      "task-active-a",
      activeRun("fixture-supervisor"),
    );
    assert.throws(
      () => harness.supervisor.markRunning(
        "task-active-b",
        { ...activeRun("fixture-supervisor"), attemptId: "attempt-02" },
      ),
      /at most one active process group/,
    );
  });

  it("reclaims only a proven stale, unchanged supervisor lock", async (t) => {
    const makeLockHarness = (suffix: string): {
      directory: string;
      store: OpsWorkerTaskStore;
      doneChecks: OpsWorkerDoneCheckRegistry;
    } => {
      const directory = mkdtempSync(join(tmpdir(), `minime-ops-worker-lock-${suffix}-`));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const doneChecks = new OpsWorkerDoneCheckRegistry({
        "fixture-check": {
          timeoutMs: 100,
          validateParams: validateFixtureParams,
          run: () => ({ result: "PASS", summary: "fixture passed" }),
        },
      });
      return {
        directory,
        store: new OpsWorkerTaskStore(directory, { registry: taskRegistry(doneChecks) }),
        doneChecks,
      };
    };
    const lockRecord = (instanceId: string) => ({
      schemaVersion: 1,
      instanceId,
      pid: 999_999,
      processStartToken: `${instanceId}-start`,
      startedAt: NOW,
    });

    const stale = makeLockHarness("stale");
    writeFileSync(
      join(stale.directory, "supervisor.lock"),
      `${JSON.stringify(lockRecord("stale-owner"))}\n`,
      { mode: 0o600 },
    );
    const replacement = new OpsWorkerSupervisor({
      store: stale.store,
      doneChecks: stale.doneChecks,
      instanceId: "replacement-owner",
      processStartToken: "replacement-owner-start",
      inspectLockOwner: () => "STALE",
    });
    await replacement.start();
    replacement.close();

    const malformed = makeLockHarness("malformed");
    writeFileSync(join(malformed.directory, "supervisor.lock"), "not-json\n", { mode: 0o600 });
    const malformedSupervisor = new OpsWorkerSupervisor({
      store: malformed.store,
      doneChecks: malformed.doneChecks,
      instanceId: "malformed-replacement",
      processStartToken: "malformed-replacement-start",
      inspectLockOwner: () => "STALE",
    });
    await assert.rejects(malformedSupervisor.start(), /malformed and therefore ambiguous/);

    const oversized = makeLockHarness("oversized");
    writeFileSync(join(oversized.directory, "supervisor.lock"), "x".repeat(4_097), { mode: 0o600 });
    const oversizedSupervisor = new OpsWorkerSupervisor({
      store: oversized.store,
      doneChecks: oversized.doneChecks,
      instanceId: "oversized-replacement",
      processStartToken: "oversized-replacement-start",
      inspectLockOwner: () => "STALE",
    });
    await assert.rejects(oversizedSupervisor.start(), /oversized supervisor lock/);

    const symlinked = makeLockHarness("symlink");
    const outsideLock = join(symlinked.directory, "outside.lock");
    writeFileSync(outsideLock, `${JSON.stringify(lockRecord("outside-owner"))}\n`, { mode: 0o600 });
    symlinkSync(outsideLock, join(symlinked.directory, "supervisor.lock"));
    const symlinkSupervisor = new OpsWorkerSupervisor({
      store: symlinked.store,
      doneChecks: symlinked.doneChecks,
      instanceId: "symlink-replacement",
      processStartToken: "symlink-replacement-start",
      inspectLockOwner: () => "STALE",
    });
    await assert.rejects(symlinkSupervisor.start(), /Refusing unsafe supervisor lock/);

    const changed = makeLockHarness("changed");
    const changedPath = join(changed.directory, "supervisor.lock");
    writeFileSync(
      changedPath,
      `${JSON.stringify(lockRecord("first-owner"))}\n`,
      { mode: 0o600 },
    );
    const changedSupervisor = new OpsWorkerSupervisor({
      store: changed.store,
      doneChecks: changed.doneChecks,
      instanceId: "changed-replacement",
      processStartToken: "changed-replacement-start",
      inspectLockOwner: () => {
        writeFileSync(
          changedPath,
          `${JSON.stringify(lockRecord("new-live-owner"))}\n`,
          { mode: 0o600 },
        );
        return "STALE";
      },
    });
    await assert.rejects(changedSupervisor.start(), /changed during stale-owner inspection/);
    assert.match(readFileSync(changedPath, "utf8"), /new-live-owner/);

    assert.throws(
      () => new OpsWorkerSupervisor({
        store: changed.store,
        doneChecks: changed.doneChecks,
        instanceId: "missing-identity",
        processStartToken: undefined as unknown as string,
      }),
      /process start token contains unsafe characters/,
    );
  });

  it("reconciles a prior RUNNING snapshot on restart", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-restart-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "first-supervisor",
    });
    first.store.create(makeTask("task-restart"));
    first.supervisor.markRunning(
      "task-restart",
      activeRun("first-supervisor"),
    );
    first.close();

    const restarted = await makeHarness(t, {
      directory,
      instanceId: "restarted-supervisor",
      reconcileActiveRun: () => ({
        status: "GONE",
        summary: "Fixture process is no longer present.",
      }),
    });
    const recovered = restarted.store.get("task-restart");
    assert.equal(recovered?.state, "RESUMABLE");
    assert.equal(recovered?.activeRun, null);
    assert.equal(recovered?.lastOutcome?.kind, "RECONCILIATION");
    assert.equal(recovered?.rounds.remediation, 0);
  });

  it("reconciles every persisted RUNNING snapshot independently", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-multi-restart-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "multi-first-supervisor",
    });
    for (const [id, attemptId] of [
      ["multi-running-a", "attempt-a"],
      ["multi-running-b", "attempt-b"],
    ]) {
      const task = makeTask(id);
      task.state = "RUNNING";
      task.activeRun = {
        ...activeRun("prior-supervisor"),
        attemptId,
        pid: id.endsWith("a") ? 401 : 402,
        processGroupId: id.endsWith("a") ? 401 : 402,
      };
      first.store.create(task);
    }
    first.close();
    const reconciledIds: string[] = [];

    const restarted = await makeHarness(t, {
      directory,
      instanceId: "multi-restarted-supervisor",
      reconcileActiveRun: (task) => {
        reconciledIds.push(task.id);
        return { status: "GONE", summary: "fixture group is gone" };
      },
    });

    assert.deepEqual(reconciledIds.sort(), ["multi-running-a", "multi-running-b"]);
    assert.equal(restarted.store.get("multi-running-a")?.state, "RESUMABLE");
    assert.equal(restarted.store.get("multi-running-b")?.state, "RESUMABLE");
  });

  it("blocks ambiguous startup ownership and persists report attempts across restart", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-report-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "first-supervisor",
    });
    first.store.create(makeTask("task-ambiguous"));
    first.supervisor.markRunning(
      "task-ambiguous",
      activeRun("first-supervisor"),
    );
    first.close();

    const restarted = await makeHarness(t, {
      directory,
      instanceId: "restarted-supervisor",
      reconcileActiveRun: () => ({ status: "AMBIGUOUS" }),
    });
    const blocked = restarted.store.get("task-ambiguous");
    assert.equal(blocked?.state, "BLOCKED");
    assert.equal(blocked?.lastOutcome?.result, "AMBIGUOUS_ORPHAN");
    assert.equal(blocked?.report.state, "PENDING");

    const attempted = restarted.supervisor.recordReportAttempt(
      "task-ambiguous",
      { sent: false, error: "Fixture report transport unavailable" },
    );
    assert.equal(attempted.report.attempts, 1);
    assert.equal(attempted.report.state, "PENDING");
    restarted.close();

    const final = await makeHarness(t, {
      directory,
      instanceId: "final-supervisor",
    });
    assert.equal(final.store.get("task-ambiguous")?.report.attempts, 1);
    const sent = final.supervisor.recordReportAttempt(
      "task-ambiguous",
      { sent: true },
    );
    assert.equal(sent.report.state, "SENT");
    assert.equal(sent.report.attempts, 2);
    assert.equal(sent.report.lastError, null);
  });

  it("retains correlation ownership until a fresh PASS reaches DONE", async (t) => {
    const harness = await makeHarness(t);
    const first = makeTask("task-correlation-a", {
      correlationKey: "fixture:shared-correlation",
    });
    const duplicate = makeTask("task-correlation-b", {
      correlationKey: "fixture:shared-correlation",
    });
    harness.store.create(first);
    assert.throws(
      () => harness.store.create(duplicate),
      OpsWorkerDuplicateCorrelationError,
    );

    harness.supervisor.requestDoneCheck(first.id);
    await harness.supervisor.runDoneCheck(first.id);
    harness.store.create(duplicate);
    assert.equal(harness.store.get(duplicate.id)?.state, "QUEUED");
  });
});
