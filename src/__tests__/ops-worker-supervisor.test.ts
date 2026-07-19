import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import type {
  OpsWorkerAuthorizationVerifier,
  OpsWorkerAuthorizationVerifierRegistry,
} from "../ops-worker/authorization.js";
import {
  OPS_WORKER_DONE_CHECK_LIMITS,
  OpsWorkerDoneCheckExecutionError,
  OpsWorkerDoneCheckRegistry,
  type OpsWorkerDoneCheckDefinition,
} from "../ops-worker/done-checks.js";
import { OpsWorkerLifecycle } from "../ops-worker/lifecycle.js";
import type {
  OpsWorkerQuotaAdmissionDecision,
  OpsWorkerQuotaAdmissionGate,
} from "../ops-worker/quota.js";
import {
  OpsWorkerDuplicateCorrelationError,
  OpsWorkerTaskStore,
  type OpsWorkerTaskStoreFaultPoint,
} from "../ops-worker/task-store.js";
import {
  OpsWorkerStaleCheckResultError,
  OpsWorkerSupervisor,
  OpsWorkerSupervisorAlreadyRunningError,
  OpsWorkerSupervisorStateError,
} from "../ops-worker/supervisor.js";
import {
  createEmptyOpsWorkerLifecycleManifest,
  createEmptyOpsWorkerMutationReceipts,
  createUnclaimedOpsWorkerCustody,
  withOpsWorkerSubmissionFingerprint,
  type JsonObject,
  type OpsWorkerSourceKind,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "../ops-worker/types.js";

const NOW = "2026-07-17T12:00:00.000Z";
const LATER = "2026-07-17T12:05:00.000Z";
const AUTHORIZATION_CLAIM_HASH = `sha256:${"a".repeat(64)}`;
const AUTHORIZATION_EVIDENCE_HASH = `sha256:${"b".repeat(64)}`;
const QUOTA_PROBE_SUBJECT_HASH = `sha256:${"c".repeat(64)}`;
const fixtureAuthorizationVerifier: OpsWorkerAuthorizationVerifier = {
  identity: "fixture-authorization",
  version: "1",
  verify: () => ({
    status: "PASS",
    evidenceHash: AUTHORIZATION_EVIDENCE_HASH,
    summary: "Authorization matches the trusted fixture policy.",
  }),
};
const fixtureAuthorizationVerifiers: OpsWorkerAuthorizationVerifierRegistry = {
  alertmanager: fixtureAuthorizationVerifier,
  "operator-cli": fixtureAuthorizationVerifier,
  "operator-telegram": fixtureAuthorizationVerifier,
  "registered-cron": fixtureAuthorizationVerifier,
  "authorized-issue": fixtureAuthorizationVerifier,
};
const LIFECYCLE_UPDATE_FIXTURE = fileURLToPath(
  new URL("./fixtures/ops-worker-lifecycle-update.ts", import.meta.url),
);
const SUPERVISOR_TRANSITION_FIXTURE = fileURLToPath(
  new URL("./fixtures/ops-worker-supervisor-transition.ts", import.meta.url),
);

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
    "operator-telegram": 10,
    "registered-cron": 20,
    "authorized-issue": 30,
  }[sourceKind] as OpsWorkerTask["priority"];
  return withOpsWorkerSubmissionFingerprint({
    schemaVersion: 4,
    id,
    source: {
      kind: sourceKind,
      correlationKey: options.correlationKey ?? `fixture:${id}`,
      deliveryKey: `fixture:${id}`,
      template: "fixture-task",
    },
    resource: { kind: "host", key: "host:local" },
    lifecycle: createEmptyOpsWorkerLifecycleManifest(),
    currentCheckpoint: null,
    mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
    custody: createUnclaimedOpsWorkerCustody(),
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
      snapshotHash: AUTHORIZATION_CLAIM_HASH,
    },
    authorizationVerification: null,
    verification: null,
    legacyCompletion: null,
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
    unverifiedRun: null,
    lastOutcome: null,
    report: {
      state: "NONE",
      attempts: 0,
      lastError: null,
    },
    createdAt: options.createdAt ?? NOW,
    updatedAt: options.createdAt ?? NOW,
  });
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
    faultInjector?: (point: OpsWorkerTaskStoreFaultPoint) => void;
    authorizationVerifiers?: OpsWorkerAuthorizationVerifierRegistry;
    quotaAdmission?: OpsWorkerQuotaAdmissionGate;
    verifierIdentity?: string;
    verifierVersion?: string;
  } = {},
): Promise<Harness> {
  let currentNow = NOW;
  const directory = options.directory
    ?? mkdtempSync(join(tmpdir(), "minime-ops-worker-supervisor-"));
  const ownsDirectory = options.directory === undefined;
  const doneChecks = new OpsWorkerDoneCheckRegistry({
    "fixture-check": {
      identity: options.verifierIdentity,
      version: options.verifierVersion,
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
    faultInjector: options.faultInjector,
  });
  const supervisor = new OpsWorkerSupervisor({
    store,
    doneChecks,
    instanceId: options.instanceId ?? "fixture-supervisor",
    processStartToken: `${options.instanceId ?? "fixture-supervisor"}-start`,
    now: () => new Date(currentNow),
    infrastructureRetryMs: 1_000,
    reconcileActiveRun: options.reconcileActiveRun,
    authorizationVerifiers: options.authorizationVerifiers
      ?? fixtureAuthorizationVerifiers,
    authorizationQueryRetryMs: 1_000,
    quotaAdmission: options.quotaAdmission,
    quotaRecheckMs: 1_000,
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

function quotaDecision(
  status: "ADMITTED" | "NOT_ADMITTED",
  input: {
    reason?: OpsWorkerQuotaAdmissionDecision["reason"];
    nextResetAt?: string | null;
    nextProbeAt?: string | null;
    observedAt?: string;
  } = {},
): OpsWorkerQuotaAdmissionDecision {
  const admitted = status === "ADMITTED";
  return {
    version: 1,
    status,
    reason: input.reason ?? (admitted ? "HEADROOM" : "LOW_REMAINING"),
    observedAt: input.observedAt ?? NOW,
    sampledAt: NOW,
    activeWindows: ["5h"],
    nextResetAt: input.nextResetAt ?? (admitted ? null : LATER),
    nextProbeAt: input.nextProbeAt ?? (admitted ? null : LATER),
    evidenceHash: `sha256:${(admitted ? "c" : "d").repeat(64)}`,
    summary: admitted
      ? "Codex quota admission passed for 5h"
      : "Codex quota admission closed: LOW_REMAINING",
  };
}

describe("ops worker done-check registry", () => {
  it("runs only fixed composite components and computes the closed aggregate", async () => {
    const registry = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        identity: "fixture-composite",
        version: "2",
        validateParams: validateFixtureParams,
        components: [
          {
            identity: "required-product",
            version: "1",
            required: true,
            convergence: "PRODUCT",
            timeoutMs: 100,
            run: () => ({
              result: "PASS",
              summary: "Required product evidence passed.",
              observedAt: NOW,
              evidenceHash: `sha256:${"1".repeat(64)}`,
            }),
          },
          {
            identity: "optional-query",
            version: "1",
            required: false,
            convergence: "PASSIVE",
            timeoutMs: 100,
            run: () => {
              throw new Error("Synthetic optional query failure");
            },
          },
        ],
      },
    });

    const missing = await registry.run(
      { name: "missing-check", params: { sampleCount: 1 } },
      { taskId: "task-a", checkedAt: NOW },
    );
    assert.equal(missing.result, "VERIFIER_INVALID");
    assert.deepEqual(missing.components, []);

    const invalidParams = await registry.run(
      { name: "fixture-check", params: { sampleCount: 1, extra: true } },
      { taskId: "task-a", checkedAt: NOW },
    );
    assert.equal(invalidParams.result, "VERIFIER_INVALID");

    const result = await registry.run(
      { name: "fixture-check", params: { sampleCount: 1 } },
      { taskId: "task-a", checkedAt: NOW },
    );
    assert.equal(result.result, "PASS");
    assert.equal(result.verifierIdentity, "fixture-composite");
    assert.equal(result.verifierVersion, "2");
    assert.match(result.contractHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(
      result.components.map(({ identity, outcome }) => ({ identity, outcome })),
      [
        { identity: "required-product", outcome: "PASS" },
        { identity: "optional-query", outcome: "QUERY_ERROR" },
      ],
    );

    const invalid = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        identity: "strict-composite",
        version: "1",
        validateParams: validateFixtureParams,
        components: [{
          identity: "strict-component",
          version: "1",
          required: true,
          convergence: "PRODUCT",
          timeoutMs: 100,
          run: () => ({
            result: "PASS",
            summary: "passed",
            observedAt: NOW,
            evidenceHash: `sha256:${"2".repeat(64)}`,
            component: "payload-selected-component",
          }),
        }],
      },
    });
    const invalidResult = await invalid.run(
      { name: "fixture-check", params: { sampleCount: 1 } },
      { taskId: "task-a", checkedAt: NOW },
    );
    assert.equal(invalidResult.result, "VERIFIER_INVALID");
    assert.equal(invalidResult.components[0].outcome, "VERIFIER_INVALID");

    assert.throws(
      () => new OpsWorkerDoneCheckRegistry({
        "duplicate-check": {
          validateParams: validateFixtureParams,
          components: [
            {
              identity: "duplicate-component",
              version: "1",
              required: true,
              convergence: "PRODUCT",
              timeoutMs: 100,
              run: () => undefined,
            },
            {
              identity: "duplicate-component",
              version: "2",
              required: true,
              convergence: "PRODUCT",
              timeoutMs: 100,
              run: () => undefined,
            },
          ],
        },
      }),
      /duplicate component identity/,
    );

    const mixedRequired = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        validateParams: validateFixtureParams,
        components: [
          {
            identity: "required-pass",
            version: "1",
            required: true,
            convergence: "PRODUCT",
            timeoutMs: 100,
            run: () => ({
              result: "PASS",
              summary: "First required component passed.",
              observedAt: NOW,
              evidenceHash: `sha256:${"3".repeat(64)}`,
            }),
          },
          {
            identity: "required-failure",
            version: "1",
            required: true,
            convergence: "PRODUCT",
            timeoutMs: 100,
            run: () => ({
              result: "PRODUCT_FAILURE",
              summary: "Second required component failed.",
              observedAt: NOW,
              evidenceHash: `sha256:${"4".repeat(64)}`,
            }),
          },
          {
            identity: "optional-invalid",
            version: "1",
            required: false,
            convergence: "PASSIVE",
            timeoutMs: 100,
            run: () => ({ result: "UNKNOWN" }),
          },
        ],
      },
    });
    const mixed = await mixedRequired.run(
      { name: "fixture-check", params: { sampleCount: 1 } },
      { taskId: "task-mixed", checkedAt: NOW },
    );
    assert.equal(mixed.result, "PRODUCT_FAILURE");
    assert.deepEqual(
      mixed.components.map((component) => component.outcome),
      ["PASS", "PRODUCT_FAILURE", "VERIFIER_INVALID"],
    );
  });

  it("types timeout, invalid output, and non-passive DEFER without throwing", async () => {
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
    const timeout = await timeoutRegistry.run(
      { name: "fixture-check", params: { sampleCount: 1 } },
      { taskId: "task-a", checkedAt: NOW },
    );
    assert.equal(timeout.result, "TIMEOUT");
    assert.equal(observedAbort, true);

    const outputRegistry = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 100,
        validateParams: validateFixtureParams,
        run: () => ({
          result: "PRODUCT_FAILURE",
          summary: "x".repeat(OPS_WORKER_DONE_CHECK_LIMITS.maxSummaryBytes + 1),
        }),
      },
    });
    const oversized = await outputRegistry.run(
      { name: "fixture-check", params: { sampleCount: 1 } },
      { taskId: "task-a", checkedAt: NOW },
    );
    assert.equal(oversized.result, "VERIFIER_INVALID");

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
    const invalidDefer = await unserializableRegistry.run(
      { name: "fixture-check", params: { sampleCount: 1 } },
      { taskId: "task-a", checkedAt: NOW },
    );
    assert.equal(invalidDefer.result, "VERIFIER_INVALID");
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

  it("does not invalidate fresh evidence when the wall clock moves backward", async () => {
    const registry = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 100,
        validateParams: validateFixtureParams,
        run: () => ({ result: "PASS", summary: "Fresh fixture evidence." }),
      },
    });
    const result = await registry.run(
      { name: "fixture-check", params: { sampleCount: 1 } },
      { taskId: "clock-backward", checkedAt: LATER, now: () => new Date(NOW) },
    );
    assert.equal(result.result, "PASS");
    assert.equal(result.components[0].observedAt, LATER);
  });
});

describe("ops worker supervisor", () => {
  it("clamps persisted verification timestamps when the wall clock moves backward", async (t) => {
    let harness!: Harness;
    harness = await makeHarness(t, {
      implementation: () => {
        harness.setNow(NOW);
        return { result: "PASS", summary: "Clock-safe fixture evidence." };
      },
    });
    harness.store.create(makeTask("task-clock-backward"));
    harness.setNow(LATER);
    await harness.supervisor.requestDoneCheck("task-clock-backward");
    const done = await harness.supervisor.runDoneCheck("task-clock-backward");
    assert.equal(done.state, "DONE");
    assert.ok(done.verification);
    assert.ok(Date.parse(done.updatedAt) >= Date.parse(done.verification.checkedAt));
    assert.equal(done.verification.completedAt, done.updatedAt);
  });

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

  it("atomically claims the selected task before scheduling its action", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("task-claim", {
      sourceKind: "authorized-issue",
    }));

    const claimed = await harness.supervisor.claimNextTask();

    assert.equal(claimed?.action, "RUN");
    assert.equal(claimed?.task.id, "task-claim");
    assert.equal(claimed?.task.custody.status, "HELD");
    assert.ok(claimed?.task.custody.claimedAt);
    assert.deepEqual(harness.store.get("task-claim")?.custody, claimed?.task.custody);
  });

  it("revalidates before first custody and every resumed attempt, then blocks drift", async (t) => {
    const statuses = ["PASS", "PASS", "DRIFT"] as const;
    let checks = 0;
    const verifier: OpsWorkerAuthorizationVerifier = {
      identity: "sequence-authorization",
      version: "2",
      verify: () => {
        const status = statuses[Math.min(checks, statuses.length - 1)];
        checks += 1;
        return {
          status,
          evidenceHash: `sha256:${(status === "PASS" ? "c" : "d").repeat(64)}`,
          summary: status === "PASS"
            ? "Authorization matches the trusted fixture policy."
            : "Authorization policy evidence has drifted.",
        };
      },
    };
    const harness = await makeHarness(t, {
      authorizationVerifiers: { "operator-cli": verifier },
    });
    harness.store.create(makeTask("task-authorization-drift"));

    const first = await harness.supervisor.claimNextTask();
    assert.equal(first?.task.custody.status, "HELD");
    assert.equal(first?.task.authorizationVerification?.status, "PASS");
    harness.supervisor.recordPreLaunchInfrastructureOutcome(
      "task-authorization-drift",
      "Synthetic pre-launch interruption",
    );

    const resumed = await harness.supervisor.ensureTaskCustody(
      "task-authorization-drift",
      "RUN",
    );
    assert.equal(resumed.authorizationVerification?.status, "PASS");
    assert.equal(resumed.custody.status, "HELD");
    harness.supervisor.recordPreLaunchInfrastructureOutcome(
      "task-authorization-drift",
      "Synthetic second pre-launch interruption",
    );

    const drifted = await harness.supervisor.ensureTaskCustody(
      "task-authorization-drift",
      "RUN",
    );
    assert.equal(checks, 3);
    assert.equal(drifted.state, "BLOCKED");
    assert.equal(drifted.custody.status, "RELEASED");
    assert.equal(drifted.custody.releaseReason, "BLOCKED");
    assert.equal(drifted.authorizationVerification?.status, "DRIFT");
    assert.equal(drifted.lastOutcome?.kind, "AUTHORIZATION");
    assert.equal(drifted.activeRun, null);
    assert.equal(drifted.unverifiedRun, null);
  });

  it("retains held custody and remediation budget on authorization query errors", async (t) => {
    let checks = 0;
    const verifier: OpsWorkerAuthorizationVerifier = {
      identity: "query-authorization",
      version: "1",
      verify: () => {
        checks += 1;
        return checks === 1
          ? {
            status: "PASS",
            evidenceHash: `sha256:${"e".repeat(64)}`,
            summary: "Authorization matches the trusted fixture policy.",
          }
          : {
            status: "QUERY_ERROR",
            evidenceHash: `sha256:${"f".repeat(64)}`,
            summary: "Authorization evidence could not be queried.",
          };
      },
    };
    const harness = await makeHarness(t, {
      authorizationVerifiers: { "operator-cli": verifier },
    });
    harness.store.create(makeTask("task-authorization-query"));
    await harness.supervisor.claimNextTask();
    const waiting = harness.supervisor.recordPreLaunchInfrastructureOutcome(
      "task-authorization-query",
      "Synthetic pre-launch interruption",
    );
    const remediationBefore = waiting.rounds.remediation;
    const infrastructureBefore = waiting.rounds.consecutiveInfrastructureFailures;

    const queried = await harness.supervisor.ensureTaskCustody(
      "task-authorization-query",
      "RUN",
    );
    assert.equal(queried.state, "RESUMABLE");
    assert.equal(queried.custody.status, "HELD");
    assert.equal(queried.authorizationVerification?.status, "QUERY_ERROR");
    assert.equal(queried.rounds.remediation, remediationBefore);
    assert.equal(
      queried.rounds.consecutiveInfrastructureFailures,
      infrastructureBefore,
    );
    assert.ok(queried.schedule.nextRunAt);
  });

  it("does not trust a persisted PASS after restart and keeps empty adapters inactive", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-auth-restart-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "authorization-first",
    });
    first.store.create(makeTask("task-authorization-restart"));
    assert.equal(
      (await first.supervisor.claimNextTask())?.task.authorizationVerification?.status,
      "PASS",
    );
    first.close();

    const driftVerifier: OpsWorkerAuthorizationVerifier = {
      identity: "restart-authorization",
      version: "2",
      verify: () => ({
        status: "DRIFT",
        evidenceHash: `sha256:${"9".repeat(64)}`,
        summary: "Authorization policy evidence has drifted after restart.",
      }),
    };
    const restarted = await makeHarness(t, {
      directory,
      instanceId: "authorization-restarted",
      authorizationVerifiers: { "operator-cli": driftVerifier },
    });
    assert.equal(await restarted.supervisor.claimNextTask(), undefined);
    assert.equal(restarted.store.get("task-authorization-restart")?.state, "BLOCKED");
    restarted.close();

    const empty = await makeHarness(t, {
      instanceId: "authorization-empty",
      authorizationVerifiers: {},
    });
    empty.store.create(makeTask("task-authorization-missing"));
    assert.equal(await empty.supervisor.claimNextTask(), undefined);
    const notRun = empty.store.get("task-authorization-missing");
    assert.equal(notRun?.state, "QUEUED");
    assert.equal(notRun?.custody.status, "UNCLAIMED");
    assert.equal(notRun?.authorizationVerification?.status, "QUERY_ERROR");
    assert.ok(notRun?.schedule.nextRunAt);
  });

  it("serializes lifecycle evidence with a supervisor transition without losing either write", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-transition-race-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const doneChecks = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 500,
        validateParams: validateFixtureParams,
        run: () => ({ result: "PASS", summary: "Fixture passed." }),
      },
    });
    const store = new OpsWorkerTaskStore(directory, {
      registry: taskRegistry(doneChecks),
    });
    const task = makeTask("task-transition-race");
    store.create(task);
    const readyPath = join(directory, "transition-ready");
    const releasePath = join(directory, "transition-release");
    const lifecycleStartedPath = join(directory, "lifecycle-started");
    const lifecycleCompletedPath = join(directory, "lifecycle-completed");
    const runChild = (args: string[]): Promise<{
      code: number | null;
      stderr: string;
    }> => {
      const child = spawn(process.execPath, ["--import", "tsx", ...args], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      return new Promise((resolve) => {
        child.once("close", (code) => resolve({ code, stderr }));
      });
    };
    const waitForPath = async (path: string): Promise<void> => {
      const deadline = Date.now() + 10_000;
      while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    const transition = runChild([
      SUPERVISOR_TRANSITION_FIXTURE,
      directory,
      task.id,
      readyPath,
      releasePath,
    ]);
    await waitForPath(readyPath);
    const transitionHoldsStoreLock = existsSync(join(directory, ".task-store.lock"));
    const lifecycle = runChild([
      LIFECYCLE_UPDATE_FIXTURE,
      directory,
      task.id,
      "branch",
      "refs/heads/atomic-transition",
      "",
      "",
      lifecycleStartedPath,
      lifecycleCompletedPath,
    ]);
    await waitForPath(lifecycleStartedPath);
    if (!transitionHoldsStoreLock) {
      await waitForPath(lifecycleCompletedPath);
    }
    writeFileSync(releasePath, "release\n", "utf8");
    const results = await Promise.all([transition, lifecycle]);
    assert.equal(results[0].code, 0, JSON.stringify(results));
    if (results[1].code !== 0) {
      assert.match(results[1].stderr, /task-store mutation is in progress/);
      const retry = await runChild([
        LIFECYCLE_UPDATE_FIXTURE,
        directory,
        task.id,
        "branch",
        "refs/heads/atomic-transition",
      ]);
      assert.equal(retry.code, 0, JSON.stringify(retry));
    }

    const updated = store.get(task.id);
    assert.equal(updated?.session.sessionId, "session-after-interleaving");
    assert.equal(updated?.lifecycle.branch, "refs/heads/atomic-transition");
  });

  it("retains custody through delayed checks and releases it for PASS and cancellation", async (t) => {
    let result: unknown = {
      result: "DEFER",
      summary: "The fixture needs a later observation window.",
      nextCheckAt: LATER,
    };
    const harness = await makeHarness(t, {
      implementation: () => result,
    });
    harness.store.create(makeTask("task-custody-owner", {
      sourceKind: "authorized-issue",
    }));
    harness.store.create(makeTask("task-custody-successor", {
      sourceKind: "alertmanager",
    }));

    const checking = await harness.supervisor.requestDoneCheck("task-custody-owner");
    const claimedAt = checking.custody.claimedAt;
    const deferred = await harness.supervisor.runDoneCheck("task-custody-owner");
    assert.equal(deferred.state, "CHECKING");
    assert.equal(deferred.custody.status, "HELD");
    assert.equal(deferred.custody.claimedAt, claimedAt);
    assert.equal(harness.supervisor.selectNextTask(), undefined);

    harness.setNow(LATER);
    assert.equal(
      harness.supervisor.selectNextTask()?.task.id,
      "task-custody-owner",
    );
    result = {
      result: "PASS",
      summary: "Fresh fixture evidence passed.",
    };
    const done = await harness.supervisor.runDoneCheck("task-custody-owner");
    assert.equal(done.state, "DONE");
    assert.equal(done.custody.status, "RELEASED");
    assert.equal(done.custody.releaseReason, "DONE");
    assert.equal(
      harness.supervisor.selectNextTask()?.task.id,
      "task-custody-successor",
    );

    await harness.supervisor.requestDoneCheck("task-custody-successor");
    const cancelled = harness.supervisor.cancelTask(
      "task-custody-successor",
      "Synthetic operator cancellation",
    );
    assert.equal(cancelled.custody.status, "RELEASED");
    assert.equal(cancelled.custody.releaseReason, "CANCELLED");
  });

  it("applies quota admission before initial custody and probes after fresh headroom", async (t) => {
    let current = quotaDecision("NOT_ADMITTED");
    const gate: OpsWorkerQuotaAdmissionGate = { check: () => current };
    const harness = await makeHarness(t, { quotaAdmission: gate });
    harness.store.create(makeTask("task-quota-admission"));

    const waiting = await harness.supervisor.claimNextTask();
    assert.equal(waiting?.action, "WAIT");
    assert.equal(waiting?.task.state, "QUEUED");
    assert.equal(waiting?.task.custody.status, "UNCLAIMED");
    assert.equal(waiting?.task.lastOutcome?.result, "QUOTA_ADMISSION_WAIT");
    assert.equal(waiting?.task.schedule.nextRunAt, LATER);
    assert.equal(waiting?.task.rounds.consecutiveInfrastructureFailures, 0);

    current = quotaDecision("ADMITTED");
    const probe = await harness.supervisor.claimNextTask();
    assert.equal(probe?.action, "QUOTA_PROBE");
    assert.equal(probe?.task.custody.status, "HELD");
    const claimedAt = probe?.task.custody.claimedAt;

    harness.supervisor.recordQuotaProbeSuccess(
      "task-quota-admission",
      "Exact worker quota smoke probe succeeded.",
      QUOTA_PROBE_SUBJECT_HASH,
    );
    current = quotaDecision("NOT_ADMITTED", {
      reason: "STALE",
      nextResetAt: null,
      nextProbeAt: null,
    });
    const runnable = await harness.supervisor.claimNextTask();
    assert.equal(runnable?.action, "RUN");
    assert.equal(runnable?.task.custody.claimedAt, claimedAt);
    assert.equal(runnable?.task.lastOutcome?.result, "QUOTA_PROBE_PASS");
  });

  it("revalidates authorization before held and unclaimed quota probes", async (t) => {
    let authorizationStatus: "PASS" | "DRIFT" | "QUERY_ERROR" = "PASS";
    const verifier: OpsWorkerAuthorizationVerifier = {
      identity: "quota-probe-authorization",
      version: "1",
      verify: () => ({
        status: authorizationStatus,
        evidenceHash: `sha256:${"7".repeat(64)}`,
        summary: `Synthetic quota probe authorization ${authorizationStatus}`,
      }),
    };
    let current = quotaDecision("ADMITTED");
    const harness = await makeHarness(t, {
      authorizationVerifiers: {
        ...fixtureAuthorizationVerifiers,
        "operator-cli": verifier,
      },
      quotaAdmission: { check: () => current },
    });
    const held = makeTask("task-held-quota-authorization");
    held.state = "RESUMABLE";
    held.custody = {
      status: "HELD",
      claimedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    };
    held.lastOutcome = {
      at: NOW,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic held quota wait",
    };
    harness.store.create(held);

    authorizationStatus = "DRIFT";
    const blocked = await harness.supervisor.claimNextTask();
    assert.equal(blocked?.action, "WAIT");
    assert.equal(blocked?.task.state, "BLOCKED");
    assert.equal(blocked?.task.custody.status, "RELEASED");
    assert.equal(blocked?.task.authorizationVerification?.status, "DRIFT");

    const unclaimed = makeTask("task-unclaimed-quota-authorization");
    harness.store.create(unclaimed);
    current = quotaDecision("NOT_ADMITTED");
    const waiting = await harness.supervisor.claimNextTask();
    assert.equal(waiting?.action, "WAIT");
    assert.equal(waiting?.task.custody.status, "UNCLAIMED");
    harness.setNow(LATER);

    authorizationStatus = "QUERY_ERROR";
    const deniedProbe = await harness.supervisor.claimNextTask();
    assert.equal(deniedProbe?.action, "WAIT");
    assert.equal(deniedProbe?.task.state, "QUEUED");
    assert.equal(deniedProbe?.task.custody.status, "UNCLAIMED");
    assert.equal(
      deniedProbe?.task.authorizationVerification?.status,
      "QUERY_ERROR",
    );
    assert.equal(deniedProbe?.task.lastOutcome?.kind, "AUTHORIZATION");
  });

  it("retains held custody across quota response resets, rolling resets, and restart", async (t) => {
    let current = quotaDecision("ADMITTED");
    const gate: OpsWorkerQuotaAdmissionGate = { check: () => current };
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-quota-restart-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const harness = await makeHarness(t, { quotaAdmission: gate, directory });
    harness.store.create(makeTask("task-quota-owner", { sourceKind: "authorized-issue" }));
    harness.store.create(makeTask("task-quota-successor", { sourceKind: "alertmanager" }));
    const selected = await harness.supervisor.claimNextTask();
    assert.equal(selected?.task.id, "task-quota-successor");
    harness.supervisor.cancelTask("task-quota-successor", "Exercise the durable owner");
    const owner = await harness.supervisor.claimNextTask();
    assert.equal(owner?.task.id, "task-quota-owner");
    const claimedAt = owner?.task.custody.claimedAt;
    harness.supervisor.markRunning(
      "task-quota-owner",
      activeRun(harness.supervisor.supervisorInstanceId),
    );

    const waiting = harness.supervisor.recordQuotaResponseWait(
      "task-quota-owner",
      {
        status: "WAIT",
        resetAt: LATER,
        sampledAt: NOW,
        evidenceHash: `sha256:${"e".repeat(64)}`,
        summary: `Codex quota response requires a reset-aware wait until ${LATER}`,
      },
    );
    assert.equal(waiting.state, "RESUMABLE");
    assert.equal(waiting.custody.status, "HELD");
    assert.equal(waiting.custody.claimedAt, claimedAt);
    assert.equal(waiting.lastOutcome?.result, "QUOTA");
    assert.equal(waiting.schedule.nextRunAt, LATER);
    assert.equal(waiting.rounds.consecutiveInfrastructureFailures, 0);
    current = quotaDecision("NOT_ADMITTED");
    assert.equal(harness.supervisor.selectNextTask(), undefined);

    harness.setNow(LATER);
    const probe = await harness.supervisor.claimNextTask();
    assert.equal(probe?.action, "QUOTA_PROBE");
    assert.equal(probe?.task.custody.claimedAt, claimedAt);
    const rolledReset = "2026-07-17T13:00:00.000Z";
    const rolled = harness.supervisor.recordQuotaResponseWait(
      "task-quota-owner",
      {
        status: "WAIT",
        resetAt: rolledReset,
        sampledAt: LATER,
        evidenceHash: `sha256:${"f".repeat(64)}`,
        summary: `Codex quota response requires a reset-aware wait until ${rolledReset}`,
      },
    );
    assert.equal(rolled.schedule.nextRunAt, rolledReset);
    assert.equal(rolled.custody.claimedAt, claimedAt);

    harness.close();
    const restarted = await makeHarness(t, {
      directory: harness.directory,
      instanceId: "quota-restart-supervisor",
      quotaAdmission: gate,
    });
    const persisted = restarted.store.get("task-quota-owner");
    assert.equal(persisted?.state, "RESUMABLE");
    assert.equal(persisted?.custody.status, "HELD");
    assert.equal(persisted?.custody.claimedAt, claimedAt);
    assert.equal(persisted?.schedule.nextRunAt, rolledReset);
    assert.equal(restarted.supervisor.selectNextTask(), undefined);
  });

  it("types telemetry and probe failures without inventing reset deadlines or spending infrastructure budget", async (t) => {
    const harness = await makeHarness(t);
    const task = makeTask("task-quota-errors");
    task.state = "RESUMABLE";
    task.custody = {
      status: "HELD",
      claimedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    };
    harness.store.create(task);

    const telemetry = harness.supervisor.recordQuotaResponseWait(task.id, {
      status: "TELEMETRY_ERROR",
      reason: "RESETLESS",
      evidenceHash: `sha256:${"1".repeat(64)}`,
      summary: "Quota response telemetry is unusable: RESETLESS",
    });
    assert.equal(telemetry.lastOutcome?.result, "QUOTA_TELEMETRY_ERROR");
    assert.equal(telemetry.schedule.nextRunAt, "2026-07-17T12:00:01.000Z");
    assert.equal(telemetry.rounds.consecutiveInfrastructureFailures, 0);

    const probe = harness.supervisor.recordQuotaProbeError(
      task.id,
      "Exact quota smoke probe timed out within its bounded deadline.",
    );
    assert.equal(probe.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.equal(probe.schedule.nextRunAt, "2026-07-17T12:00:01.000Z");
    assert.equal(probe.rounds.consecutiveInfrastructureFailures, 0);
    assert.equal(probe.custody.status, "HELD");
  });

  it("refreshes an unclaimed reset wait when the reset-deadline probe is still quota-limited", async (t) => {
    const denied = quotaDecision("NOT_ADMITTED");
    const harness = await makeHarness(t, {
      quotaAdmission: { check: () => denied },
    });
    const task = makeTask("task-unclaimed-reset-probe");
    harness.store.create(task);
    const initial = await harness.supervisor.claimNextTask();
    assert.equal(initial?.action, "WAIT");
    assert.equal(initial?.task.custody.status, "UNCLAIMED");

    harness.setNow(LATER);
    const probe = await harness.supervisor.claimNextTask();
    assert.equal(probe?.action, "QUOTA_PROBE");
    assert.equal(probe?.task.custody.status, "UNCLAIMED");
    const rolledReset = "2026-07-17T13:05:00.000Z";
    const refreshed = harness.supervisor.recordQuotaResponseWait(task.id, {
      status: "WAIT",
      resetAt: rolledReset,
      sampledAt: LATER,
      evidenceHash: `sha256:${"2".repeat(64)}`,
      summary: `Codex quota response requires a reset-aware wait until ${rolledReset}`,
    });
    assert.equal(refreshed.state, "QUEUED");
    assert.equal(refreshed.custody.status, "UNCLAIMED");
    assert.equal(refreshed.schedule.nextRunAt, rolledReset);
    assert.equal(refreshed.lastOutcome?.result, "QUOTA");

    harness.supervisor.cancelTask(task.id, "Exercise unclaimed probe telemetry error");
    const telemetryTask = makeTask("task-unclaimed-probe-telemetry");
    harness.store.create(telemetryTask);
    const telemetry = harness.supervisor.recordQuotaResponseWait(telemetryTask.id, {
      status: "TELEMETRY_ERROR",
      reason: "RESETLESS",
      evidenceHash: `sha256:${"3".repeat(64)}`,
      summary: "Quota response telemetry is unusable: RESETLESS",
    });
    assert.equal(telemetry.state, "QUEUED");
    assert.equal(telemetry.custody.status, "UNCLAIMED");
    assert.equal(telemetry.lastOutcome?.result, "QUOTA_TELEMETRY_ERROR");
    assert.equal(telemetry.schedule.nextRunAt, "2026-07-17T12:05:01.000Z");

    harness.supervisor.recordQuotaProbeSuccess(
      telemetryTask.id,
      "Exact unclaimed quota smoke probe succeeded",
      QUOTA_PROBE_SUBJECT_HASH,
    );
    const stillWaiting = await harness.supervisor.claimNextTask();
    assert.equal(stillWaiting?.action, "WAIT");
    assert.equal(stillWaiting?.task.id, telemetryTask.id);
    assert.equal(stillWaiting?.task.custody.status, "UNCLAIMED");
    assert.equal(stillWaiting?.task.lastOutcome?.result, "QUOTA_ADMISSION_WAIT");
  });

  it("preserves a fresh probe proof until launch and expires a stale pass", async (t) => {
    let decision = quotaDecision("ADMITTED");
    const harness = await makeHarness(t, {
      quotaAdmission: { check: () => decision },
    });
    const fresh = makeTask("task-fresh-unclaimed-probe-pass");
    harness.store.create(fresh);
    harness.supervisor.recordQuotaProbeSuccess(
      fresh.id,
      "Exact unclaimed quota smoke probe succeeded",
      QUOTA_PROBE_SUBJECT_HASH,
    );
    harness.setNow(LATER);

    const claimed = await harness.supervisor.claimNextTask();
    assert.equal(claimed?.action, "RUN");
    assert.equal(claimed?.task.custody.status, "UNCLAIMED");
    assert.equal(claimed?.task.lastOutcome?.result, "QUOTA_PROBE_PASS");

    harness.supervisor.cancelTask(fresh.id, "Exercise stale probe admission");
    decision = quotaDecision("NOT_ADMITTED");
    const stale = makeTask("task-stale-unclaimed-probe-pass");
    harness.store.create(stale);
    harness.supervisor.recordQuotaProbeSuccess(
      stale.id,
      "Exact unclaimed quota smoke probe succeeded",
      QUOTA_PROBE_SUBJECT_HASH,
    );
    harness.setNow("2026-07-17T12:36:00.000Z");

    const waiting = await harness.supervisor.claimNextTask();
    assert.equal(waiting?.action, "WAIT");
    assert.equal(waiting?.task.custody.status, "UNCLAIMED");
    assert.equal(waiting?.task.lastOutcome?.result, "QUOTA_ADMISSION_WAIT");
  });

  it("rechecks admission atomically before a fresh unclaimed proof takes custody", async (t) => {
    let checks = 0;
    const harness = await makeHarness(t, {
      quotaAdmission: {
        check: () => {
          checks += 1;
          return quotaDecision(checks === 1 ? "ADMITTED" : "NOT_ADMITTED");
        },
      },
    });
    const task = makeTask("task-atomic-unclaimed-quota-admission");
    harness.store.create(task);
    harness.supervisor.recordQuotaProbeSuccess(
      task.id,
      "Exact unclaimed quota smoke probe succeeded",
      QUOTA_PROBE_SUBJECT_HASH,
    );

    const result = await harness.supervisor.ensureTaskCustody(task.id, "RUN", {
      quotaProbeSubjectHash: QUOTA_PROBE_SUBJECT_HASH,
    });

    assert.equal(checks, 2);
    assert.equal(result.custody.status, "UNCLAIMED");
    assert.equal(result.custody.claimedAt, null);
    assert.equal(result.lastOutcome?.result, "QUOTA_PROBE_PASS");
  });

  it("uses current admission instead of an expired unclaimed probe pass", async (t) => {
    const harness = await makeHarness(t, {
      quotaAdmission: { check: () => quotaDecision("ADMITTED") },
    });
    const task = makeTask("task-expired-probe-current-admission");
    harness.store.create(task);
    harness.supervisor.recordQuotaProbeSuccess(
      task.id,
      "Exact unclaimed quota smoke probe succeeded",
      QUOTA_PROBE_SUBJECT_HASH,
    );
    harness.setNow("2026-07-17T12:31:00.000Z");

    const claimed = await harness.supervisor.claimNextTask();
    assert.equal(claimed?.action, "QUOTA_PROBE");
    assert.equal(claimed?.task.custody.status, "HELD");
    assert.equal(claimed?.task.lastOutcome?.result, "QUOTA_PROBE_ERROR");
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
    await harness.supervisor.requestDoneCheck("task-pass");
    const done = await harness.supervisor.runDoneCheck("task-pass");
    assert.equal(done.state, "DONE");
    assert.equal(done.lastOutcome?.result, "PASS");
    assert.equal(done.report.state, "PENDING");
    const completionAt = done.updatedAt;
    const failedReport = await harness.supervisor.recordReportAttempt(
      "task-pass",
      { sent: false, error: "Synthetic report transport failure" },
    );
    assert.equal(failedReport.updatedAt, completionAt);
    assert.equal(failedReport.report.attempts, 1);
    assert.equal(failedReport.report.state, "PENDING");
    assert.match(failedReport.lifecycle.report ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.match(
      failedReport.mutationReceipts.report?.intentHash ?? "",
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.match(
      failedReport.mutationReceipts.report?.queryResultHash ?? "",
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.equal(failedReport.mutationReceipts.report?.outcome, null);
    const reportIntentHash = failedReport.mutationReceipts.report?.intentHash;
    const firstQueryHash = failedReport.mutationReceipts.report?.queryResultHash;
    const sentReport = await harness.supervisor.recordReportAttempt(
      "task-pass",
      { sent: true },
    );
    assert.equal(sentReport.updatedAt, completionAt);
    assert.equal(sentReport.report.attempts, 2);
    assert.equal(sentReport.report.state, "SENT");
    assert.equal(sentReport.mutationReceipts.report?.intentHash, reportIntentHash);
    assert.notEqual(sentReport.mutationReceipts.report?.queryResultHash, firstQueryHash);
    assert.equal(sentReport.mutationReceipts.report?.outcome?.result, "APPLIED");
    await assert.rejects(
      harness.supervisor.recordReportAttempt("task-pass", { sent: true }),
      /no pending report/,
    );
    assert.throws(
      () => harness.supervisor.cancelTask("task-pass", "too late"),
      /Illegal ops-worker transition DONE -> CANCELLED/,
    );
  });

  it("commits successful report state and receipt outcome in one crash-safe snapshot", async (t) => {
    let armed = false;
    let renamedSnapshots = 0;
    const harness = await makeHarness(t, {
      faultInjector: (point) => {
        if (!armed || point !== "after-snapshot-rename") return;
        renamedSnapshots += 1;
        if (renamedSnapshots === 4) {
          throw new Error("Synthetic crash after atomic report snapshot rename");
        }
      },
    });
    harness.store.create(makeTask("task-report-crash"));
    await harness.supervisor.requestDoneCheck("task-report-crash");
    await harness.supervisor.runDoneCheck("task-report-crash");

    armed = true;
    await assert.rejects(
      harness.supervisor.recordReportAttempt("task-report-crash", { sent: true }),
      /Synthetic crash after atomic report snapshot rename/,
    );
    assert.equal(renamedSnapshots, 4);
    const persisted = harness.store.get("task-report-crash");
    assert.equal(persisted?.report.state, "SENT");
    assert.equal(persisted?.report.attempts, 1);
    assert.equal(persisted?.mutationReceipts.report?.outcome?.result, "APPLIED");
  });

  it("revalidates after the external query and before claiming a mutation receipt", async (t) => {
    let checks = 0;
    const verifier: OpsWorkerAuthorizationVerifier = {
      identity: "mutation-authorization",
      version: "1",
      verify: () => {
        checks += 1;
        return checks === 1
          ? {
            status: "PASS",
            evidenceHash: `sha256:${"1".repeat(64)}`,
            summary: "Authorization matches the trusted fixture policy.",
          }
          : {
            status: "DRIFT",
            evidenceHash: `sha256:${"2".repeat(64)}`,
            summary: "Authorization policy evidence drifted before mutation.",
          };
      },
    };
    const harness = await makeHarness(t, {
      authorizationVerifiers: { "operator-cli": verifier },
    });
    harness.store.create(makeTask("task-mutation-authorization"));
    await harness.supervisor.requestDoneCheck("task-mutation-authorization");
    await harness.supervisor.runDoneCheck("task-mutation-authorization");

    const done = await harness.supervisor.recordReportAttempt(
      "task-mutation-authorization",
      { sent: true },
    );
    assert.equal(checks, 2);
    assert.equal(done.state, "DONE");
    assert.equal(done.authorizationVerification?.status, "PASS");
    assert.equal(done.custody.releaseReason, "DONE");
    assert.equal(done.report.state, "PENDING");
    assert.match(done.evidence.at(-1)?.summary ?? "", /drifted before mutation/);
    assert.equal(
      done.mutationReceipts.report?.mutationStartedAt,
      null,
    );
    assert.equal(done.mutationReceipts.report?.outcome, null);
  });

  it("invalidates nonterminal composite evidence and preserves DONE proof across changed authorization evidence", async (t) => {
    let checks = 0;
    const changingVerifier: OpsWorkerAuthorizationVerifier = {
      identity: "changing-authorization-evidence",
      version: "1",
      verify: () => {
        checks += 1;
        return {
          status: "PASS",
          evidenceHash: `sha256:${(checks % 2 === 1 ? "1" : "2").repeat(64)}`,
          summary: "Fresh authorization remains valid with new observation evidence.",
        };
      },
    };
    const deferred = await makeHarness(t, {
      authorizationVerifiers: { "operator-cli": changingVerifier },
      implementation: () => ({
        result: "DEFER",
        summary: "Passive convergence needs another observation.",
        nextCheckAt: LATER,
      }),
    });
    deferred.store.create(makeTask("task-changing-auth-check"));
    await deferred.supervisor.requestDoneCheck("task-changing-auth-check");
    const firstCheck = await deferred.supervisor.runDoneCheck("task-changing-auth-check");
    assert.equal(firstCheck.verification?.outcome, "DEFER");
    const reauthorized = await deferred.supervisor.ensureTaskCustody(
      "task-changing-auth-check",
      "CHECK",
    );
    assert.equal(reauthorized.state, "CHECKING");
    assert.equal(reauthorized.verification, null);

    let terminalChecks = 0;
    const terminalVerifier: OpsWorkerAuthorizationVerifier = {
      identity: "terminal-authorization-evidence",
      version: "1",
      verify: () => {
        terminalChecks += 1;
        return {
          status: "PASS",
          evidenceHash: `sha256:${(terminalChecks === 1 ? "3" : "4").repeat(64)}`,
          summary: "Terminal report remains freshly authorized.",
        };
      },
    };
    const terminal = await makeHarness(t, {
      authorizationVerifiers: { "operator-cli": terminalVerifier },
    });
    terminal.store.create(makeTask("task-changing-auth-report"));
    await terminal.supervisor.requestDoneCheck("task-changing-auth-report");
    const done = await terminal.supervisor.runDoneCheck("task-changing-auth-report");
    const immutableProof = structuredClone(done.verification);
    const sent = await terminal.supervisor.recordReportAttempt(
      "task-changing-auth-report",
      { sent: true },
    );
    assert.equal(sent.state, "DONE");
    assert.deepEqual(sent.verification, immutableProof);
    assert.equal(sent.report.state, "SENT");
    assert.equal(sent.mutationReceipts.report?.outcome?.result, "APPLIED");
    assert.equal(terminalChecks, 2);
  });

  it("requires claimed report reconciliation before retrying a blocked task", async (t) => {
    const harness = await makeHarness(t, {
      implementation: () => ({
        result: "PRODUCT_FAILURE",
        summary: "Fixture remains incomplete.",
      }),
    });
    harness.store.create(makeTask("task-report-retry", { maxRemediation: 1 }));
    await harness.supervisor.requestDoneCheck("task-report-retry");
    const blocked = await harness.supervisor.runDoneCheck("task-report-retry");
    assert.equal(blocked.state, "BLOCKED");

    await harness.supervisor.recordReportAttempt("task-report-retry", {
      sent: false,
      error: "Synthetic ambiguous report failure",
    });
    assert.throws(
      () => harness.supervisor.retryBlockedTask("task-report-retry"),
      /claimed report receipt still requires reconciliation/,
    );
    await harness.supervisor.recordReportAttempt("task-report-retry", { sent: true });
    const resumed = harness.supervisor.retryBlockedTask("task-report-retry");
    assert.equal(resumed.state, "RESUMABLE");
    assert.equal(resumed.report.state, "NONE");
    harness.supervisor.cancelTask("task-report-retry", "Release fixture custody");

    harness.store.create(makeTask("task-query-only-retry", { maxRemediation: 1 }));
    await harness.supervisor.requestDoneCheck("task-query-only-retry");
    await harness.supervisor.runDoneCheck("task-query-only-retry");
    new OpsWorkerLifecycle(harness.store, {
      now: () => new Date(LATER),
    }).beginMutationReceipt("task-query-only-retry", {
      boundary: "report",
      operationId: "report-query-only",
      intent: { taskId: "task-query-only-retry" },
      queryObservedAt: LATER,
      queryResult: { sent: false },
    });
    const queryOnlyRetried = harness.supervisor.retryBlockedTask("task-query-only-retry");
    assert.equal(
      queryOnlyRetried.mutationReceipts.report?.outcome?.result,
      "NOT_NEEDED",
    );
  });

  it("discards a stale PASS when the task changes during the check", async (t) => {
    let resolveCheck: ((result: unknown) => void) | undefined;
    const harness = await makeHarness(t, {
      implementation: () => new Promise<unknown>((resolve) => {
        resolveCheck = resolve;
      }),
    });
    harness.store.create(makeTask("task-stale"));
    await harness.supervisor.requestDoneCheck("task-stale");

    const pending = harness.supervisor.runDoneCheck("task-stale");
    await new Promise((resolve) => setImmediate(resolve));
    harness.supervisor.cancelTask("task-stale", "Operator cancelled during check");
    assert.ok(resolveCheck);
    resolveCheck({ result: "PASS", summary: "Late fixture pass" });
    await assert.rejects(pending, OpsWorkerStaleCheckResultError);
    assert.equal(harness.store.get("task-stale")?.state, "CANCELLED");
  });

  it("returns PRODUCT_FAILURE evidence to the same task and blocks at budget exhaustion", async (t) => {
    const harness = await makeHarness(t, {
      implementation: () => ({
        result: "PRODUCT_FAILURE",
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
    assert.equal(first.custody.status, "HELD");
    assert.equal(first.verification?.outcome, "PRODUCT_FAILURE");
    assert.equal(first.verification?.components[0].required, true);
    assert.equal(first.verification?.components[0].outcome, "PRODUCT_FAILURE");
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

    const notReadyHarness = await makeHarness(t, {
      implementation: () => ({
        result: "NOT_READY",
        summary: "Required fixture state is not ready yet.",
      }),
    });
    notReadyHarness.store.create(makeTask("task-not-ready"));
    await notReadyHarness.supervisor.requestDoneCheck("task-not-ready");
    const notReady = await notReadyHarness.supervisor.runDoneCheck("task-not-ready");
    assert.equal(notReady.state, "RESUMABLE");
    assert.equal(notReady.rounds.remediation, 1);
    assert.equal(notReady.verification?.outcome, "NOT_READY");
    assert.equal(notReady.custody.status, "HELD");
  });

  it("schedules DEFER and retries check errors without rerunning Pi", async (t) => {
    let result: unknown = {
      result: "DEFER",
      summary: "The fixture needs a later observation window.",
      nextCheckAt: LATER,
    };
    const harness = await makeHarness(t, {
      implementation: () => result,
    });
    harness.store.create(makeTask("task-defer"));
    await harness.supervisor.requestDoneCheck("task-defer");
    const deferred = await harness.supervisor.runDoneCheck("task-defer");
    assert.equal(deferred.state, "CHECKING");
    assert.equal(deferred.schedule.nextCheckAt, LATER);
    assert.equal(deferred.rounds.remediation, 0);
    assert.equal(harness.supervisor.selectNextTask(), undefined);

    harness.setNow(LATER);
    assert.equal(harness.supervisor.selectNextTask()?.action, "CHECK");
    result = { result: "UNKNOWN", summary: "invalid fixture result" };
    const retryingCheck = await harness.supervisor.runDoneCheck("task-defer");
    assert.equal(retryingCheck.state, "CHECKING");
    assert.equal(retryingCheck.rounds.remediation, 0);
    assert.equal(retryingCheck.rounds.consecutiveInfrastructureFailures, 1);
    assert.equal(retryingCheck.lastOutcome?.result, "VERIFIER_INVALID");
    assert.equal(retryingCheck.schedule.nextRunAt, null);
    assert.ok(retryingCheck.schedule.nextCheckAt);
    assert.equal(harness.supervisor.selectNextTask(), undefined);

    harness.supervisor.cancelTask(
      "task-defer",
      "Release the delayed fixture before testing the bounded case",
    );

    const bounded = makeTask("task-check-error-bound");
    bounded.rounds.consecutiveInfrastructureFailures = 999;
    harness.store.create(bounded);
    await harness.supervisor.requestDoneCheck(bounded.id);
    const retained = await harness.supervisor.runDoneCheck(bounded.id);
    assert.equal(retained.state, "CHECKING");
    assert.equal(retained.rounds.consecutiveInfrastructureFailures, 1_000);
    assert.equal(retained.schedule.nextRunAt, null);
    assert.ok(retained.schedule.nextCheckAt);
    assert.equal(retained.custody.status, "HELD");
    assert.equal(retained.custody.releaseReason, null);
  });

  it("retries query errors and timeouts as typed verification faults with custody held", async (t) => {
    const query = await makeHarness(t, {
      implementation: () => {
        throw new Error("Synthetic read-only query failure");
      },
    });
    query.store.create(makeTask("task-query-error"));
    await query.supervisor.requestDoneCheck("task-query-error");
    const queryError = await query.supervisor.runDoneCheck("task-query-error");
    assert.equal(queryError.state, "CHECKING");
    assert.equal(queryError.lastOutcome?.result, "QUERY_ERROR");
    assert.equal(queryError.verification?.outcome, "QUERY_ERROR");
    assert.equal(queryError.verification?.components[0].outcome, "QUERY_ERROR");
    assert.equal(queryError.rounds.remediation, 0);
    assert.equal(queryError.custody.status, "HELD");

    const timeout = await makeHarness(t, {
      implementation: () => new Promise(() => undefined),
    });
    timeout.store.create(makeTask("task-verifier-timeout"));
    await timeout.supervisor.requestDoneCheck("task-verifier-timeout");
    const timedOut = await timeout.supervisor.runDoneCheck("task-verifier-timeout");
    assert.equal(timedOut.state, "CHECKING");
    assert.equal(timedOut.lastOutcome?.result, "TIMEOUT");
    assert.equal(timedOut.verification?.outcome, "TIMEOUT");
    assert.equal(timedOut.rounds.remediation, 0);
    assert.equal(timedOut.custody.status, "HELD");
  });

  it("restarts a persisted CHECKING task under the same immutable verifier contract", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-check-restart-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, { directory, instanceId: "check-first" });
    first.store.create(makeTask("task-check-restart"));
    const checking = await first.supervisor.requestDoneCheck("task-check-restart");
    assert.equal(checking.state, "CHECKING");
    assert.equal(checking.custody.status, "HELD");
    assert.equal(checking.lifecycle.verifier, "fixture-check");
    assert.equal(checking.lifecycle.verifierVersion, "1");
    assert.match(checking.lifecycle.verifierContractHash ?? "", /^sha256:[a-f0-9]{64}$/);
    first.close();

    const restarted = await makeHarness(t, {
      directory,
      instanceId: "check-restarted",
    });
    assert.equal(restarted.supervisor.selectNextTask()?.action, "CHECK");
    const done = await restarted.supervisor.runDoneCheck("task-check-restart");
    assert.equal(done.state, "DONE");
    assert.equal(done.verification?.outcome, "PASS");
    assert.equal(done.lifecycle.verifier, "fixture-check");
    assert.equal(done.lifecycle.verifierVersion, "1");
    assert.equal(done.lifecycle.verifierContractHash, done.verification?.contractHash);
  });

  it("fails changed verifier code closed after restart before the first result", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-first-check-pin-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "first-check-pin-original",
      verifierVersion: "1",
    });
    first.store.create(makeTask("task-first-check-pin"));
    const checking = await first.supervisor.requestDoneCheck("task-first-check-pin");
    const pinnedHash = checking.lifecycle.verifierContractHash;
    assert.equal(checking.lifecycle.verifierVersion, "1");
    first.close();

    let changedComponentRuns = 0;
    const changed = await makeHarness(t, {
      directory,
      instanceId: "first-check-pin-changed",
      verifierVersion: "2",
      implementation: () => {
        changedComponentRuns += 1;
        return { result: "PASS", summary: "Changed verifier must not execute." };
      },
    });
    const invalid = await changed.supervisor.runDoneCheck("task-first-check-pin");
    assert.equal(invalid.state, "CHECKING");
    assert.equal(invalid.lastOutcome?.result, "VERIFIER_INVALID");
    assert.equal(invalid.verification?.outcome, "VERIFIER_INVALID");
    assert.deepEqual(invalid.verification?.components, []);
    assert.equal(invalid.lifecycle.verifierVersion, "1");
    assert.equal(invalid.lifecycle.verifierContractHash, pinnedHash);
    assert.equal(changedComponentRuns, 0);
  });

  it("fails a changed package verifier contract closed after immutable pinning", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-contract-pin-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "contract-pin-first",
      verifierVersion: "1",
      implementation: () => ({
        result: "DEFER",
        summary: "Passive fixture convergence needs another observation.",
        nextCheckAt: LATER,
      }),
    });
    first.store.create(makeTask("task-contract-pin"));
    await first.supervisor.requestDoneCheck("task-contract-pin");
    const pinned = await first.supervisor.runDoneCheck("task-contract-pin");
    const pinnedHash = pinned.lifecycle.verifierContractHash;
    assert.equal(pinned.lifecycle.verifierVersion, "1");
    first.close();

    const changed = await makeHarness(t, {
      directory,
      instanceId: "contract-pin-changed",
      verifierVersion: "2",
    });
    const invalid = await changed.supervisor.runDoneCheck("task-contract-pin");
    assert.equal(invalid.state, "CHECKING");
    assert.equal(invalid.lastOutcome?.result, "VERIFIER_INVALID");
    assert.equal(invalid.verification?.outcome, "VERIFIER_INVALID");
    assert.deepEqual(invalid.verification?.components, []);
    assert.equal(invalid.lifecycle.verifierVersion, "1");
    assert.equal(invalid.lifecycle.verifierContractHash, pinnedHash);
    assert.equal(invalid.custody.status, "HELD");
  });

  it("keeps infrastructure failures resumable without spending remediation budget", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("task-network", {
      sourceKind: "authorized-issue",
    }));
    harness.store.create(makeTask("task-network-successor", {
      sourceKind: "alertmanager",
    }));
    const running = harness.supervisor.markRunning(
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
    assert.equal(task.custody.status, "HELD");
    assert.equal(task.custody.claimedAt, running.custody.claimedAt);
    assert.equal(harness.supervisor.selectNextTask(), undefined);
  });

  it("retains custody at the bounded infrastructure-failure counter", async (t) => {
    const harness = await makeHarness(t);
    const task = makeTask("task-infrastructure-bound");
    task.rounds.consecutiveInfrastructureFailures = 999;
    harness.store.create(task);
    assert.throws(
      () => harness.supervisor.retryBlockedTask(task.id),
      /Operator retry requires BLOCKED, found QUEUED/,
    );
    harness.supervisor.markRunning(task.id, activeRun("fixture-supervisor"));

    const resumable = harness.supervisor.recordResumableInfrastructureOutcome(
      task.id,
      "NETWORK",
      "Persistent synthetic network failure",
    );

    assert.equal(resumable.state, "RESUMABLE");
    assert.equal(resumable.rounds.consecutiveInfrastructureFailures, 1_000);
    assert.equal(resumable.rounds.remediation, 0);
    assert.equal(resumable.report.state, "NONE");
    assert.equal(resumable.custody.status, "HELD");
    assert.equal(resumable.custody.releaseReason, null);
    assert.throws(
      () => harness.supervisor.retryBlockedTask(task.id),
      /Operator retry requires BLOCKED, found RESUMABLE/,
    );
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
      /at most one active or unresolved process group/,
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
    assert.equal(existsSync(join(stale.directory, "supervisor.lock.recovery")), false);

    const recoveryFenced = makeLockHarness("recovery-fenced");
    const recoveryFencedPath = join(recoveryFenced.directory, "supervisor.lock");
    const recoveryFencedRecord = `${JSON.stringify(lockRecord("recovery-stale-owner"))}\n`;
    writeFileSync(recoveryFencedPath, recoveryFencedRecord, { mode: 0o600 });
    writeFileSync(
      join(recoveryFenced.directory, "supervisor.lock.recovery"),
      "unfinished recovery\n",
      { mode: 0o600 },
    );
    const recoveryFencedSupervisor = new OpsWorkerSupervisor({
      store: recoveryFenced.store,
      doneChecks: recoveryFenced.doneChecks,
      instanceId: "recovery-fenced-replacement",
      processStartToken: "recovery-fenced-replacement-start",
      inspectLockOwner: () => "STALE",
    });
    await assert.rejects(
      recoveryFencedSupervisor.start(),
      /stale-lock recovery is already in progress/,
    );
    assert.equal(readFileSync(recoveryFencedPath, "utf8"), recoveryFencedRecord);

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

    const released = makeLockHarness("released");
    const releasedPath = join(released.directory, "supervisor.lock");
    writeFileSync(releasedPath, "owner releases before inspection\n", { mode: 0o600 });
    let releaseConflictCount = 0;
    const afterRelease = new OpsWorkerSupervisor({
      store: released.store,
      doneChecks: released.doneChecks,
      instanceId: "after-release-owner",
      processStartToken: "after-release-owner-start",
      lockFaultInjector: (point) => {
        if (point === "after-lock-publish-conflict") {
          releaseConflictCount += 1;
          unlinkSync(releasedPath);
        }
      },
    });
    await afterRelease.start();
    afterRelease.close();
    assert.equal(releaseConflictCount, 1);

    const vanished = makeLockHarness("vanished");
    const vanishedPath = join(vanished.directory, "supervisor.lock");
    writeFileSync(
      vanishedPath,
      `${JSON.stringify(lockRecord("vanished-owner"))}\n`,
      { mode: 0o600 },
    );
    const afterVanished = new OpsWorkerSupervisor({
      store: vanished.store,
      doneChecks: vanished.doneChecks,
      instanceId: "after-vanished-owner",
      processStartToken: "after-vanished-owner-start",
      inspectLockOwner: () => {
        unlinkSync(vanishedPath);
        return "STALE";
      },
    });
    await afterVanished.start();
    afterVanished.close();

    const atomic = makeLockHarness("atomic");
    const interrupted = new OpsWorkerSupervisor({
      store: atomic.store,
      doneChecks: atomic.doneChecks,
      instanceId: "interrupted-owner",
      processStartToken: "interrupted-owner-start",
      lockFaultInjector: () => { throw new Error("synthetic lock publication crash"); },
    });
    await assert.rejects(interrupted.start(), /synthetic lock publication crash/);
    assert.equal(existsSync(join(atomic.directory, "supervisor.lock")), false);
    const afterInterrupted = new OpsWorkerSupervisor({
      store: atomic.store,
      doneChecks: atomic.doneChecks,
      instanceId: "after-interrupted-owner",
      processStartToken: "after-interrupted-owner-start",
    });
    await afterInterrupted.start();
    afterInterrupted.close();
  });

  it("reconciles a prior RUNNING snapshot on restart", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-restart-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "first-supervisor",
    });
    first.store.create(makeTask("task-restart", {
      sourceKind: "authorized-issue",
    }));
    const running = first.supervisor.markRunning(
      "task-restart",
      activeRun("first-supervisor"),
    );
    first.store.create(makeTask("task-restart-successor", {
      sourceKind: "alertmanager",
    }));
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
    assert.equal(recovered?.custody.status, "HELD");
    assert.equal(recovered?.custody.claimedAt, running.custody.claimedAt);
    assert.equal(
      restarted.supervisor.selectNextTask()?.task.id,
      "task-restart",
    );
  });

  it("reconciles a quota probe fence without spending infrastructure budget", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-quota-probe-restart-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "quota-probe-first",
    });
    const task = makeTask("task-quota-probe-restart");
    task.rounds.consecutiveInfrastructureFailures = 7;
    first.store.create(task);
    first.supervisor.markRunning(task.id, {
      ...activeRun("quota-probe-first"),
      attemptId: "quota-probe-restart-fence",
    });
    first.close();

    const restarted = await makeHarness(t, {
      directory,
      instanceId: "quota-probe-restarted",
      reconcileActiveRun: () => ({
        status: "GONE",
        summary: "Owned quota probe process group is proven gone.",
      }),
    });
    const recovered = restarted.store.get(task.id);
    assert.equal(recovered?.state, "RESUMABLE");
    assert.equal(recovered?.activeRun, null);
    assert.equal(recovered?.unverifiedRun, null);
    assert.equal(recovered?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.equal(recovered?.rounds.consecutiveInfrastructureFailures, 7);
    assert.ok(recovered?.schedule.nextRunAt);
    assert.equal(recovered?.custody.status, "HELD");
  });

  it("reconciles an unclaimed quota probe fence back to admission", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-unclaimed-probe-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "unclaimed-probe-first",
    });
    const task = makeTask("task-unclaimed-probe-restart");
    task.state = "RUNNING";
    task.activeRun = {
      ...activeRun("unclaimed-probe-first"),
      attemptId: "quota-probe-unclaimed-restart",
    };
    first.store.create(task);
    first.close();

    const restarted = await makeHarness(t, {
      directory,
      instanceId: "unclaimed-probe-restarted",
      reconcileActiveRun: () => ({
        status: "GONE",
        summary: "Unclaimed quota probe process group is proven gone.",
      }),
    });
    const recovered = restarted.store.get(task.id);
    assert.equal(recovered?.state, "QUEUED");
    assert.equal(recovered?.activeRun, null);
    assert.equal(recovered?.unverifiedRun, null);
    assert.equal(recovered?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.ok(recovered?.schedule.nextRunAt);
    assert.equal(recovered?.custody.status, "UNCLAIMED");
  });

  it("fails startup closed when multiple v1 snapshots migrate to held custody", async (t) => {
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
      const {
        resource: _resource,
        lifecycle: _lifecycle,
        currentCheckpoint: _currentCheckpoint,
        mutationReceipts: _mutationReceipts,
        custody: _custody,
        submissionFingerprint: _submissionFingerprint,
        authorizationVerification: _authorizationVerification,
        verification: _verification,
        legacyCompletion: _legacyCompletion,
        source,
        schemaVersion: _schemaVersion,
        ...common
      } = task;
      writeFileSync(
        join(first.store.tasksDirectory, `${id}.json`),
        `${JSON.stringify({
          ...common,
          schemaVersion: 1,
          source: {
            kind: source.kind,
            correlationKey: source.correlationKey,
            template: source.template,
          },
        })}\n`,
        { mode: 0o600 },
      );
    }
    first.close();
    const reconciledIds: string[] = [];

    await assert.rejects(
      makeHarness(t, {
        directory,
        instanceId: "multi-restarted-supervisor",
        reconcileActiveRun: (task) => {
          reconciledIds.push(task.id);
          return { status: "GONE", summary: "fixture group is gone" };
        },
      }),
      /multiple held custody owners/i,
    );
    assert.deepEqual(reconciledIds, []);
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
    assert.deepEqual(blocked?.activeRun, activeRun("first-supervisor"));
    assert.equal(blocked?.custody.status, "HELD");
    assert.equal(blocked?.report.state, "PENDING");
    restarted.store.create(makeTask("task-after-ambiguous"));
    assert.equal(restarted.supervisor.selectNextTask(), undefined);
    assert.throws(
      () => restarted.supervisor.retryBlockedTask("task-ambiguous"),
      /prior process group remains unresolved/,
    );
    assert.throws(
      () => restarted.supervisor.cancelTask("task-ambiguous", "unsafe cancellation"),
      /prior process group remains unresolved/,
    );

    const attempted = await restarted.supervisor.recordReportAttempt(
      "task-ambiguous",
      { sent: false, error: "Fixture report transport unavailable" },
    );
    assert.equal(attempted.report.attempts, 1);
    assert.equal(attempted.report.state, "PENDING");
    assert.equal(attempted.mutationReceipts.report?.outcome, null);
    restarted.close();

    const final = await makeHarness(t, {
      directory,
      instanceId: "final-supervisor",
    });
    assert.equal(final.store.get("task-ambiguous")?.report.attempts, 1);
    assert.equal(final.store.get("task-ambiguous")?.mutationReceipts.report?.outcome, null);
    const sent = await final.supervisor.recordReportAttempt(
      "task-ambiguous",
      { sent: true },
    );
    assert.equal(sent.report.state, "SENT");
    assert.equal(sent.report.attempts, 2);
    assert.equal(sent.report.lastError, null);
    assert.equal(sent.mutationReceipts.report?.outcome?.result, "APPLIED");
  });

  it("reconciles a durable unverified-launch fence after the process and group are gone", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-unverified-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await makeHarness(t, {
      directory,
      instanceId: "unverified-first",
    });
    first.store.create(makeTask("task-unverified"));
    const blocked = first.supervisor.blockUnverifiedPiLaunch(
      "task-unverified",
      {
        attemptId: "attempt-unverified",
        supervisorInstanceId: "unverified-first",
        pid: 4321,
        expectedProcessGroupId: 4321,
        launchedAt: NOW,
        ownershipNonceHash: `sha256:${"a".repeat(64)}`,
      },
      "Synthetic launch identity inspection failed",
    );
    assert.equal(blocked.state, "BLOCKED");
    assert.equal(blocked.activeRun, null);
    assert.equal(blocked.unverifiedRun?.pid, 4321);
    first.close();

    const restarted = await makeHarness(t, {
      directory,
      instanceId: "unverified-restarted",
      reconcileActiveRun: () => ({
        status: "GONE",
        summary: "Synthetic unverified process and group are gone",
      }),
    });
    const reconciled = restarted.store.get("task-unverified");
    assert.equal(reconciled?.state, "RESUMABLE");
    assert.equal(reconciled?.activeRun, null);
    assert.equal(reconciled?.unverifiedRun, null);
    assert.equal(restarted.supervisor.selectNextTask()?.task.id, "task-unverified");
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

    await harness.supervisor.requestDoneCheck(first.id);
    await harness.supervisor.runDoneCheck(first.id);
    harness.store.create(duplicate);
    assert.equal(harness.store.get(duplicate.id)?.state, "QUEUED");
  });
});
