import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import {
  OPS_WORKER_LIMITS,
  hashOpsWorkerVerificationSubject,
  OpsWorkerTaskValidationError,
  parseOpsWorkerTask,
  parseOpsWorkerTaskJson,
  withOpsWorkerSubmissionFingerprint,
  type JsonObject,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
  type OpsWorkerTaskState,
  type OpsWorkerTaskV1,
  type OpsWorkerTaskV2,
  type OpsWorkerTaskV3,
  type OpsWorkerTaskV4,
} from "../ops-worker/types.js";
import {
  OpsWorkerDeliveryConflictError,
  OpsWorkerDuplicateCorrelationError,
  OpsWorkerSteeringCapacityError,
  OpsWorkerTaskStore,
  OpsWorkerTaskStoreSafetyError,
  type OpsWorkerTaskStoreFaultPoint,
} from "../ops-worker/task-store.js";
import { appendOpsWorkerEvidence } from "../ops-worker/evidence.js";

const NOW = "2026-07-17T12:00:00.000Z";
const LATER = "2026-07-17T12:01:00.000Z";
const STORE_CREATE_FIXTURE = fileURLToPath(
  new URL("./fixtures/ops-worker-store-create.ts", import.meta.url),
);

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(object).sort(), [...expectedKeys].sort());
  return object;
}

const registry: OpsWorkerTaskContractRegistry = {
  templates: {
    "operator-health": { sourceKinds: ["operator-cli", "operator-telegram"] },
    "issue-full-cycle": { sourceKinds: ["authorized-issue"] },
  },
  authorizationProfiles: {
    "operator.inspect.v1": {
      sourceKinds: ["operator-cli", "operator-telegram"],
      scope: ["inspect"],
    },
    "operator.repair.v1": {
      sourceKinds: ["operator-cli"],
      scope: ["local-reversible-repair"],
    },
    "issue.full-cycle.v1": {
      sourceKinds: ["authorized-issue"],
      scope: ["repository-read", "repository-write", "pull-request", "issue-lifecycle"],
    },
  },
  doneChecks: {
    "fixture-health": {
      validateParams(value: unknown): JsonObject {
        const params = exactObject(value, ["sampleCount"]);
        assert.ok(Number.isSafeInteger(params.sampleCount));
        assert.ok((params.sampleCount as number) >= 1 && (params.sampleCount as number) <= 10);
        return { sampleCount: params.sampleCount as number };
      },
    },
    "lax-fixture": {
      validateParams(value: unknown): JsonObject {
        assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
        return value as JsonObject;
      },
    },
  },
};

function makeTask(
  id = "wt-20260717-ab12cd",
  correlationKey = "operator:health:local",
): OpsWorkerTask {
  return withOpsWorkerSubmissionFingerprint({
    schemaVersion: 5,
    id,
    source: {
      kind: "operator-cli",
      correlationKey,
      deliveryKey: `fixture:${id}`,
      template: "operator-health",
    },
    resource: {
      kind: "host",
      key: "host:local",
    },
    lifecycle: {
      schemaVersion: 2,
      canonicalTask: null,
      repository: null,
      base: null,
      head: null,
      branch: null,
      pullRequest: null,
      merge: null,
      tag: null,
      release: null,
      deploy: null,
      verifier: null,
      verifierVersion: null,
      verifierContractHash: null,
      report: null,
      tailAudit: null,
    },
    currentCheckpoint: null,
    mutationReceipts: {
      merge: null,
      tagRelease: null,
      deploy: null,
      canonicalTask: null,
      report: null,
    },
    custody: {
      status: "UNCLAIMED",
      claimedAt: null,
      releasedAt: null,
      releaseReason: null,
    },
    priority: 10,
    objective: "Verify the registered local health contract",
    evidence: [
      {
        at: NOW,
        kind: "operator",
        trust: "trusted",
        summary: "Operator requested the registered inspection template.",
        artifact: null,
      },
    ],
    doneCheck: {
      name: "fixture-health",
      params: { sampleCount: 3 },
    },
    authorization: {
      profile: "operator.inspect.v1",
      scope: ["inspect"],
      snapshotHash: null,
    },
    authorizationVerification: null,
    verification: null,
    legacyCompletion: null,
    steering: [],
    control: {
      paused: false,
      pausedAt: null,
      interrupt: null,
    },
    state: "QUEUED",
    rounds: {
      remediation: 0,
      maxRemediation: 5,
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
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function makeV1Task(
  id = "wt-20260717-ab12cd",
  correlationKey = "operator:health:local",
): OpsWorkerTaskV1 {
  const current = makeTask(id, correlationKey);
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
    steering: _steering,
    control: _control,
    ...legacy
  } = current;
  const { deliveryKey: _deliveryKey, ...source } = legacy.source;
  return {
    ...legacy,
    schemaVersion: 1,
    source: source as OpsWorkerTaskV1["source"],
  };
}

function makeV2Task(
  id = "wt-20260717-v2-ab12cd",
  correlationKey = "operator:health:v2",
): OpsWorkerTaskV2 {
  const current = makeTask(id, correlationKey);
  const {
    authorizationVerification: _authorizationVerification,
    verification: _verification,
    legacyCompletion: _legacyCompletion,
    steering: _steering,
    control: _control,
    lifecycle,
    ...previous
  } = current;
  const {
    verifierVersion: _verifierVersion,
    verifierContractHash: _verifierContractHash,
    ...legacyLifecycle
  } = lifecycle;
  return {
    ...previous,
    schemaVersion: 2,
    lifecycle: { ...legacyLifecycle, schemaVersion: 1 },
  };
}

function makeV3Task(
  id = "wt-20260717-v3-ab12cd",
  correlationKey = "operator:health:v3",
): OpsWorkerTaskV3 {
  const current = makeTask(id, correlationKey);
  const {
    verification: _verification,
    legacyCompletion: _legacyCompletion,
    steering: _steering,
    control: _control,
    lifecycle,
    ...previous
  } = current;
  const {
    verifierVersion: _verifierVersion,
    verifierContractHash: _verifierContractHash,
    ...legacyLifecycle
  } = lifecycle;
  return {
    ...previous,
    schemaVersion: 3,
    lifecycle: { ...legacyLifecycle, schemaVersion: 1 },
  };
}

function makeV4Task(
  id = "wt-20260717-v4-ab12cd",
  correlationKey = "operator:health:v4",
): OpsWorkerTaskV4 {
  const current = makeTask(id, correlationKey);
  const {
    steering: _steering,
    control: _control,
    ...previous
  } = current;
  return {
    ...previous,
    schemaVersion: 4,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function attachFreshPass(task: OpsWorkerTask, at: string): void {
  const contractHash = `sha256:${"9".repeat(64)}`;
  task.lifecycle.verifier = "fixture-verifier";
  task.lifecycle.verifierVersion = "1";
  task.lifecycle.verifierContractHash = contractHash;
  const subjectHash = hashOpsWorkerVerificationSubject(task);
  task.verification = {
    verifierIdentity: "fixture-verifier",
    verifierVersion: "1",
    contractHash,
    subjectHash,
    checkedAt: at,
    completedAt: at,
    outcome: "PASS",
    summary: "All required fixture components passed.",
    nextCheckAt: null,
    components: [{
      identity: "fixture-component",
      version: "1",
      required: true,
      convergence: "PRODUCT",
      outcome: "PASS",
      observedAt: at,
      evidenceHash: `sha256:${"7".repeat(64)}`,
      summary: "The required fixture component passed.",
      nextCheckAt: null,
    }],
  };
}

function testStateDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeStore(
  t: TestContext,
  options: {
    directory?: string;
    maxJournalBytes?: number;
    faultInjector?: (point: OpsWorkerTaskStoreFaultPoint) => void;
    now?: () => Date;
  } = {},
): OpsWorkerTaskStore {
  return new OpsWorkerTaskStore(options.directory ?? testStateDirectory(t), {
    registry,
    now: options.now ?? (() => new Date(NOW)),
    maxJournalBytes: options.maxJournalBytes,
    faultInjector: options.faultInjector,
  });
}

describe("ops worker task contract", () => {
  it("strictly round-trips a complete v5 envelope into an independent value", () => {
    const input = makeTask();
    input.state = "RUNNING";
    input.activeRun = {
      attemptId: "attempt-01",
      supervisorInstanceId: "supervisor-01",
      pid: 321,
      processGroupId: 321,
      processStartedAt: NOW,
      processStartToken: "darwin-start-123.45",
    };
    input.session.sessionId = "pi-session-01";
    input.session.resume = true;
    input.lastOutcome = {
      at: NOW,
      kind: "INFRASTRUCTURE",
      result: "NETWORK",
      summary: "Previous attempt stopped after a resumable network error.",
    };
    input.report = {
      state: "PENDING",
      attempts: 1,
      lastError: "Fixture transport unavailable.",
    };
    input.lifecycle = {
      schemaVersion: 2,
      canonicalTask: "issue:58",
      repository: "github:example/minime-bot",
      base: "main",
      head: "abc123",
      branch: "issue-58",
      pullRequest: "pr:99",
      merge: "merge:abc123",
      tag: "v1.2.3",
      release: "release:1.2.3",
      deploy: "deploy:staging-1",
      verifier: "check:fixture",
      verifierVersion: "2",
      verifierContractHash: `sha256:${"8".repeat(64)}`,
      report: "sha256:report-identity",
      tailAudit: "audit:tail-1",
    };
    input.currentCheckpoint = {
      checkpointId: "checkpoint-01",
      recordedAt: NOW,
      payloadHash: `sha256:${"1".repeat(64)}`,
      summary: "The bounded fixture checkpoint is durable.",
      artifact: "artifacts/checkpoint.json",
      replayHistory: [],
    };
    input.mutationReceipts.merge = {
      boundary: "merge",
      operationId: "merge-01",
      intentHash: `sha256:${"2".repeat(64)}`,
      queryObservedAt: NOW,
      queryResultHash: `sha256:${"3".repeat(64)}`,
      mutationStartedAt: NOW,
      outcome: {
        recordedAt: NOW,
        result: "APPLIED",
        evidenceHash: `sha256:${"4".repeat(64)}`,
      },
      replayHistory: [],
    };
    input.custody = {
      status: "HELD",
      claimedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    };

    const parsed = parseOpsWorkerTask(input, registry);
    assert.deepEqual(parsed, input);
    assert.notStrictEqual(parsed, input);
    assert.notStrictEqual(parsed.source, input.source);
    input.objective = "changed after validation";
    assert.equal(parsed.objective, "Verify the registered local health contract");
  });

  it("normalizes an exact v1 snapshot deterministically without sharing input references", () => {
    const input = makeV1Task();
    const before = clone(input);

    const first = parseOpsWorkerTask(input, registry);
    const second = parseOpsWorkerTaskJson(JSON.stringify(input), registry);

    assert.deepEqual(input, before);
    assert.deepEqual(first, second);
    assert.equal(first.schemaVersion, 5);
    assert.deepEqual(first.steering, []);
    assert.deepEqual(first.control, {
      paused: false,
      pausedAt: null,
      interrupt: null,
    });
    assert.equal(first.authorizationVerification, null);
    assert.deepEqual(first.source, {
      ...input.source,
      deliveryKey: `legacy:${input.id}`,
    });
    assert.deepEqual(first.resource, {
      kind: "host",
      key: `host:legacy-${input.id}`,
    });
    assert.equal(first.lifecycle.schemaVersion, 2);
    assert.ok(Object.values(first.lifecycle).slice(1).every((value) => value === null));
    assert.equal(first.currentCheckpoint, null);
    assert.ok(Object.values(first.mutationReceipts).every((value) => value === null));
    first.source.correlationKey = "changed:after:migration";
    assert.equal(input.source.correlationKey, "operator:health:local");
  });

  it("keeps a valid near-limit v1 snapshot readable after deterministic expansion", () => {
    const input = makeV1Task();
    const evidence = {
      at: NOW,
      kind: "operator" as const,
      trust: "trusted" as const,
      summary: "",
      artifact: null,
    };
    input.evidence = Array.from(
      { length: OPS_WORKER_LIMITS.maxEvidenceEntries },
      () => ({ ...evidence }),
    );
    const baseBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    const sharedSummaryBytes = Math.floor(
      (OPS_WORKER_LIMITS.maxLegacySnapshotBytes - baseBytes)
      / input.evidence.length,
    );
    for (const entry of input.evidence) {
      entry.summary = "x".repeat(sharedSummaryBytes);
    }
    const bytesBeforeRemainder = Buffer.byteLength(JSON.stringify(input), "utf8");
    input.evidence[0].summary += "x".repeat(
      OPS_WORKER_LIMITS.maxLegacySnapshotBytes - bytesBeforeRemainder,
    );
    const raw = JSON.stringify(input);
    assert.equal(
      Buffer.byteLength(raw, "utf8"),
      OPS_WORKER_LIMITS.maxLegacySnapshotBytes,
    );

    const migrated = parseOpsWorkerTaskJson(raw, registry);

    assert.equal(migrated.schemaVersion, 5);
    assert.ok(
      Buffer.byteLength(JSON.stringify(migrated), "utf8")
      > OPS_WORKER_LIMITS.maxLegacySnapshotBytes,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(migrated), "utf8")
      <= OPS_WORKER_LIMITS.maxSnapshotBytes,
    );
  });

  it("keeps a valid near-limit v4 snapshot readable and writable after v5 expansion", (t) => {
    const input = makeV4Task("near-limit-v4", "near:limit:v4");
    const evidence = {
      at: NOW,
      kind: "operator" as const,
      trust: "trusted" as const,
      summary: "x",
      artifact: null,
    };
    input.evidence = Array.from(
      { length: OPS_WORKER_LIMITS.maxEvidenceEntries },
      () => ({ ...evidence }),
    );
    const targetBytes = OPS_WORKER_LIMITS.maxPreV5SnapshotBytes - 64;
    let remaining = targetBytes - Buffer.byteLength(JSON.stringify(input), "utf8");
    for (const entry of input.evidence) {
      if (remaining === 0) break;
      const escapedCharacters = Math.min(
        OPS_WORKER_LIMITS.maxEvidenceSummaryBytes - 1,
        Math.floor(remaining / 6),
      );
      entry.summary = `x${"\u0001".repeat(escapedCharacters)}`;
      remaining -= escapedCharacters * 6;
      if (remaining > 0 && remaining < 6) {
        entry.summary += "x".repeat(remaining);
        remaining = 0;
      }
    }
    assert.equal(remaining, 0);
    const raw = JSON.stringify(input);
    assert.ok(
      Buffer.byteLength(raw, "utf8") < OPS_WORKER_LIMITS.maxPreV5SnapshotBytes,
    );
    assert.ok(
      Buffer.byteLength(raw, "utf8")
      > OPS_WORKER_LIMITS.maxPreV5SnapshotBytes - 128,
    );

    const migrated = parseOpsWorkerTaskJson(raw, registry);

    assert.equal(migrated.schemaVersion, 5);
    assert.ok(
      Buffer.byteLength(JSON.stringify(migrated), "utf8")
      > OPS_WORKER_LIMITS.maxPreV5SnapshotBytes,
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify(migrated), "utf8")
      <= OPS_WORKER_LIMITS.maxSnapshotBytes,
    );

    const store = makeStore(t);
    const snapshotPath = join(store.tasksDirectory, `${input.id}.json`);
    writeFileSync(snapshotPath, `${raw}\n`, { mode: 0o600 });
    assert.equal(store.get(input.id)?.schemaVersion, 5);
    store.replace(migrated, { event: "UPDATED" });
    assert.equal(
      (JSON.parse(readFileSync(snapshotPath, "utf8")) as OpsWorkerTask).schemaVersion,
      5,
    );
  });

  it("accepts dormant operator Telegram submissions only at operator priority", () => {
    const task = makeTask();
    task.source = {
      kind: "operator-telegram",
      correlationKey: "operator:telegram:fixture",
      deliveryKey: "telegram:update:fixture-1",
      template: "operator-health",
    };
    assert.equal(parseOpsWorkerTask(task, registry).priority, 10);

    task.priority = 20;
    assert.throws(() => parseOpsWorkerTask(task, registry), /fixed priority 10/);
  });

  it("migrates an exact v2 snapshot deterministically without writing or sharing input", () => {
    const input = makeV2Task();
    const before = clone(input);

    const first = parseOpsWorkerTask(input, registry);
    const second = parseOpsWorkerTaskJson(JSON.stringify(input), registry);

    assert.deepEqual(input, before);
    assert.deepEqual(first, second);
    assert.equal(first.schemaVersion, 5);
    assert.deepEqual(first.steering, []);
    assert.equal(first.control.paused, false);
    assert.equal(first.authorizationVerification, null);
    first.authorization.scope[0] = "repository-read";
    assert.deepEqual(input.authorization.scope, ["inspect"]);
  });

  it("migrates an exact v3 snapshot to an unverified v5 composite contract", () => {
    const input = makeV3Task();
    const before = clone(input);

    const migrated = parseOpsWorkerTask(input, registry);

    assert.deepEqual(input, before);
    assert.equal(migrated.schemaVersion, 5);
    assert.equal(migrated.lifecycle.schemaVersion, 2);
    assert.equal(migrated.lifecycle.verifier, null);
    assert.equal(migrated.lifecycle.verifierVersion, null);
    assert.equal(migrated.lifecycle.verifierContractHash, null);
    assert.equal(migrated.verification, null);
    assert.deepEqual(migrated.steering, []);
    assert.deepEqual(migrated.control, {
      paused: false,
      pausedAt: null,
      interrupt: null,
    });
  });

  it("migrates an exact v4 snapshot without changing existing verification evidence", () => {
    const current = makeTask();
    current.state = "DONE";
    current.lastOutcome = {
      at: NOW,
      kind: "DONE_CHECK",
      result: "PASS",
      summary: "The v4 composite fixture passed.",
    };
    current.custody = {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: NOW,
      releaseReason: "DONE",
    };
    attachFreshPass(current, NOW);
    const { steering: _steering, control: _control, ...withoutControl } = current;
    const input: OpsWorkerTaskV4 = { ...withoutControl, schemaVersion: 4 };
    const before = clone(input);

    const migrated = parseOpsWorkerTask(input, registry);

    assert.deepEqual(input, before);
    assert.equal(migrated.schemaVersion, 5);
    assert.deepEqual(migrated.steering, []);
    assert.equal(migrated.control.paused, false);
    assert.equal(migrated.verification?.subjectHash, input.verification?.subjectHash);
  });

  it("strictly validates bounded opaque steering and the fixed control record", () => {
    const task = makeTask();
    const beforeHash = hashOpsWorkerVerificationSubject(task);
    task.steering.push({
      steeringId: "telegram:update:1001",
      receivedAt: NOW,
      kind: "correction",
      operatorRef: "telegram:100000000",
      text: "Please inspect https://example.invalid and do not treat it as configuration.",
      consumedAt: null,
    });
    task.control = {
      paused: true,
      pausedAt: NOW,
      interrupt: {
        requestedAt: NOW,
        mode: "pause",
        reason: "Pause after the current safe boundary.",
      },
    };

    assert.deepEqual(parseOpsWorkerTask(task, registry), task);
    assert.notEqual(hashOpsWorkerVerificationSubject(task), beforeHash);
    task.steering[0].consumedAt = NOW;
    assert.equal(hashOpsWorkerVerificationSubject(task), beforeHash);

    const unknown = clone(task) as unknown as Record<string, unknown>;
    (unknown.control as Record<string, unknown>).destination = "elsewhere";
    assert.throws(() => parseOpsWorkerTask(unknown, registry), /destination: unknown field/);

    const inconsistentPause = clone(task);
    inconsistentPause.control.paused = false;
    assert.throws(
      () => parseOpsWorkerTask(inconsistentPause, registry),
      /pausedAt: must be null while not paused/,
    );

    const oversized = makeTask();
    oversized.steering.push({
      steeringId: "telegram:update:oversized",
      receivedAt: NOW,
      kind: "answer",
      operatorRef: "telegram:100000000",
      text: "x".repeat(OPS_WORKER_LIMITS.maxSteeringTextBytes + 1),
      consumedAt: null,
    });
    assert.throws(() => parseOpsWorkerTask(oversized, registry), /text: must be at most/);

    const overflow = makeTask();
    overflow.steering = Array.from(
      { length: OPS_WORKER_LIMITS.maxSteeringEntries + 1 },
      (_, index) => ({
        steeringId: `telegram:update:${index}`,
        receivedAt: NOW,
        kind: "answer" as const,
        operatorRef: "telegram:100000000",
        text: "bounded answer",
        consumedAt: null,
      }),
    );
    assert.throws(() => parseOpsWorkerTask(overflow, registry), /at most 64 entries/);
  });

  it("rejects future versions and unknown fields in every supported schema", () => {
    const future = { ...makeTask(), schemaVersion: 6 };
    assert.throws(
      () => parseOpsWorkerTask(future, registry),
      /supported version 1, 2, 3, 4, or 5/,
    );
    assert.throws(
      () => parseOpsWorkerTask({ ...makeV1Task(), resource: { kind: "host", key: "host:local" } }, registry),
      /task\.resource: unknown field/,
    );
    assert.throws(
      () => parseOpsWorkerTask({ ...makeV2Task(), authorizationVerification: null }, registry),
      /task\.authorizationVerification: unknown field/,
    );
    assert.throws(
      () => parseOpsWorkerTask({ ...makeV3Task(), verification: null }, registry),
      /task\.verification: unknown field/,
    );
    assert.throws(
      () => parseOpsWorkerTask({ ...makeV4Task(), steering: [] }, registry),
      /task\.steering: unknown field/,
    );
    const futureLifecycle = clone(makeTask()) as unknown as Record<string, unknown>;
    (futureLifecycle.lifecycle as Record<string, unknown>).workflow = "arbitrary";
    assert.throws(
      () => parseOpsWorkerTask(futureLifecycle, registry),
      /task\.lifecycle\.workflow: unknown field/,
    );
  });

  it("strictly validates the fixed bounded authorization-verification record", () => {
    const task = makeTask();
    task.authorizationVerification = {
      validatorIdentity: "fixture-authorization",
      validatorVersion: "1",
      checkedSnapshotHash: `sha256:${"1".repeat(64)}`,
      checkedAt: NOW,
      status: "PASS",
      evidenceHash: `sha256:${"2".repeat(64)}`,
      summary: "Authorization matches the registered fixture policy.",
    };
    assert.deepEqual(parseOpsWorkerTask(task, registry), task);

    const unknown = clone(task) as unknown as Record<string, unknown>;
    (unknown.authorizationVerification as Record<string, unknown>).actor = "untrusted";
    assert.throws(
      () => parseOpsWorkerTask(unknown, registry),
      /authorizationVerification\.actor: unknown field/,
    );

    const oversized = clone(task);
    assert.ok(oversized.authorizationVerification);
    oversized.authorizationVerification.summary = "x".repeat(
      OPS_WORKER_LIMITS.maxAuthorizationVerificationSummaryBytes + 1,
    );
    assert.throws(
      () => parseOpsWorkerTask(oversized, registry),
      /authorizationVerification\.summary: must be at most 1024/,
    );

    const invalidStatus = clone(task) as unknown as Record<string, unknown>;
    (invalidStatus.authorizationVerification as Record<string, unknown>).status = "ALLOW";
    assert.throws(
      () => parseOpsWorkerTask(invalidStatus, registry),
      /must be one of PASS, DRIFT, QUERY_ERROR, INVALID_CLAIM/,
    );
  });

  it("validates typed quota probe proofs while accepting legacy proofless outcomes", () => {
    const task = makeTask();
    task.lastOutcome = {
      at: task.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA_PROBE_PASS",
      summary: "Exact quota smoke probe succeeded.",
      quotaProbeProof: {
        version: 1,
        subjectHash: `sha256:${"4".repeat(64)}`,
      },
    };
    assert.deepEqual(parseOpsWorkerTask(task, registry), task);

    const legacyProofless = clone(task);
    assert.ok(legacyProofless.lastOutcome);
    delete legacyProofless.lastOutcome.quotaProbeProof;
    assert.deepEqual(parseOpsWorkerTask(legacyProofless, registry), legacyProofless);

    const wrongOutcome = clone(task);
    assert.ok(wrongOutcome.lastOutcome);
    wrongOutcome.lastOutcome.result = "NETWORK";
    assert.throws(
      () => parseOpsWorkerTask(wrongOutcome, registry),
      /quotaProbeProof: is allowed only for an exact quota probe PASS/,
    );

    const malformed = clone(task);
    assert.ok(malformed.lastOutcome?.quotaProbeProof);
    malformed.lastOutcome.quotaProbeProof.subjectHash = "sha256:not-a-proof";
    assert.throws(
      () => parseOpsWorkerTask(malformed, registry),
      /quotaProbeProof\.subjectHash: must be a lowercase sha256/,
    );
  });

  it("strictly validates bounded composite evidence and immutable verifier identity", () => {
    const task = makeTask();
    attachFreshPass(task, NOW);
    assert.deepEqual(parseOpsWorkerTask(task, registry), task);

    const duplicate = clone(task);
    assert.ok(duplicate.verification);
    duplicate.verification.components.push(
      clone(duplicate.verification.components[0]),
    );
    assert.throws(
      () => parseOpsWorkerTask(duplicate, registry),
      /duplicate component identities/,
    );

    const sparse = clone(task);
    assert.ok(sparse.verification);
    const sparseComponents = new Array<
      NonNullable<OpsWorkerTask["verification"]>["components"][number]
    >(2);
    sparseComponents[1] = clone(sparse.verification.components[0]);
    sparse.verification.components = sparseComponents;
    assert.throws(
      () => parseOpsWorkerTask(sparse, registry),
      /must be dense/,
    );

    const arbitraryIdentity = clone(task);
    assert.ok(arbitraryIdentity.verification);
    arbitraryIdentity.verification.components[0].identity = "payload/component";
    assert.throws(
      () => parseOpsWorkerTask(arbitraryIdentity, registry),
      /must be a lowercase registered name/,
    );

    const stale = clone(task);
    assert.ok(stale.verification);
    stale.verification.components[0].observedAt = "2026-07-17T11:59:59.000Z";
    assert.throws(
      () => parseOpsWorkerTask(stale, registry),
      /must be fresh within the composite query interval/,
    );

    const authorizationChanged = clone(task);
    authorizationChanged.authorizationVerification = {
      validatorIdentity: "fixture-authorization",
      validatorVersion: "1",
      checkedSnapshotHash: `sha256:${"1".repeat(64)}`,
      checkedAt: NOW,
      status: "PASS",
      evidenceHash: `sha256:${"2".repeat(64)}`,
      summary: "Fresh authorization evidence changed after verification.",
    };
    assert.throws(
      () => parseOpsWorkerTask(authorizationChanged, registry),
      /is stale for current task\/checkpoint\/authorization state/,
    );

    const mismatch = clone(task);
    mismatch.lifecycle.verifierContractHash = `sha256:${"6".repeat(64)}`;
    assert.throws(
      () => parseOpsWorkerTask(mismatch, registry),
      /must match the immutable lifecycle verifier contract/,
    );
  });

  it("requires normalized bounded resource and delivery identities", () => {
    const uppercase = clone(makeTask());
    uppercase.resource.key = "github:Example/minime-bot";
    assert.throws(() => parseOpsWorkerTask(uppercase, registry), /normalized lowercase/);

    const mismatched = clone(makeTask());
    mismatched.resource = { kind: "repository", key: "host:local" };
    assert.throws(() => parseOpsWorkerTask(mismatched, registry), /non-host namespace/);

    for (const key of [
      "github:owner/repository/extra",
      "github:owner/./repository",
      "github:owner-/repository",
      "github:owner/_repository",
    ]) {
      const aliased = clone(makeTask());
      aliased.resource = { kind: "repository", key };
      assert.throws(
        () => parseOpsWorkerTask(aliased, registry),
        /exactly one normalized owner\/name identity/,
      );
    }

    const missingDelivery = clone(makeTask()) as unknown as Record<string, unknown>;
    delete (missingDelivery.source as Record<string, unknown>).deliveryKey;
    assert.throws(() => parseOpsWorkerTask(missingDelivery, registry), /deliveryKey: missing/);
  });

  it("strictly bounds fixed lifecycle, checkpoint, receipt, and custody records", () => {
    const unsafeLifecycle = clone(makeTask());
    unsafeLifecycle.lifecycle.repository = "https://example.invalid/repository";
    assert.throws(
      () => parseOpsWorkerTask(unsafeLifecycle, registry),
      /not a URL or executable payload/,
    );

    const oversizedCheckpoint = clone(makeTask());
    oversizedCheckpoint.currentCheckpoint = {
      checkpointId: "checkpoint-oversized",
      recordedAt: NOW,
      payloadHash: `sha256:${"a".repeat(64)}`,
      summary: "x".repeat(OPS_WORKER_LIMITS.maxCheckpointSummaryBytes + 1),
      artifact: null,
      replayHistory: [],
    };
    assert.throws(
      () => parseOpsWorkerTask(oversizedCheckpoint, registry),
      /currentCheckpoint\.summary: must be at most 4096/,
    );

    const wrongBoundary = clone(makeTask());
    wrongBoundary.mutationReceipts.merge = {
      boundary: "report",
      operationId: "merge-wrong-boundary",
      intentHash: `sha256:${"b".repeat(64)}`,
      queryObservedAt: NOW,
      queryResultHash: `sha256:${"c".repeat(64)}`,
      mutationStartedAt: null,
      outcome: null,
      replayHistory: [],
    };
    assert.throws(
      () => parseOpsWorkerTask(wrongBoundary, registry),
      /must equal fixed slot boundary merge/,
    );

    const appliedWithoutClaim = clone(makeTask());
    appliedWithoutClaim.mutationReceipts.merge = {
      boundary: "merge",
      operationId: "merge-without-claim",
      intentHash: `sha256:${"d".repeat(64)}`,
      queryObservedAt: NOW,
      queryResultHash: `sha256:${"e".repeat(64)}`,
      mutationStartedAt: null,
      outcome: {
        recordedAt: NOW,
        result: "APPLIED",
        evidenceHash: `sha256:${"f".repeat(64)}`,
      },
      replayHistory: [],
    };
    assert.throws(
      () => parseOpsWorkerTask(appliedWithoutClaim, registry),
      /APPLIED requires a durable mutation claim/,
    );

    const outcomeBeforeClaim = clone(appliedWithoutClaim);
    const receipt = outcomeBeforeClaim.mutationReceipts.merge;
    assert.ok(receipt);
    receipt.mutationStartedAt = LATER;
    assert.throws(
      () => parseOpsWorkerTask(outcomeBeforeClaim, registry),
      /outcome\.recordedAt: must not be earlier than its mutation claim/,
    );

    const contradictoryCustody = clone(makeTask());
    contradictoryCustody.custody = {
      status: "HELD",
      claimedAt: null,
      releasedAt: null,
      releaseReason: null,
    };
    assert.throws(
      () => parseOpsWorkerTask(contradictoryCustody, registry),
      /status does not match its custody timestamps/,
    );

    const runningReleased = clone(makeTask());
    runningReleased.state = "RUNNING";
    runningReleased.activeRun = {
      attemptId: "attempt-released",
      supervisorInstanceId: "supervisor-released",
      pid: 123,
      processGroupId: 123,
      processStartedAt: NOW,
      processStartToken: "start-released",
    };
    runningReleased.custody = {
      status: "RELEASED",
      claimedAt: NOW,
      releasedAt: NOW,
      releaseReason: "BLOCKED",
    };
    assert.throws(
      () => parseOpsWorkerTask(runningReleased, registry),
      /RUNNING tasks must retain held custody/,
    );

    const doneHeld = clone(makeTask());
    doneHeld.state = "DONE";
    doneHeld.lastOutcome = {
      at: NOW,
      kind: "DONE_CHECK",
      result: "PASS",
      summary: "Fixture passed.",
    };
    attachFreshPass(doneHeld, NOW);
    doneHeld.custody = {
      status: "HELD",
      claimedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    };
    assert.throws(
      () => parseOpsWorkerTask(doneHeld, registry),
      /DONE tasks must be released with reason DONE/,
    );

    const blockedHeld = clone(makeTask());
    blockedHeld.state = "BLOCKED";
    blockedHeld.custody = {
      status: "HELD",
      claimedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    };
    assert.throws(
      () => parseOpsWorkerTask(blockedHeld, registry),
      /process-free BLOCKED task must be released with reason BLOCKED/,
    );
  });

  it("derives fail-safe custody for every legacy state and orphan mapping", () => {
    const legacyFor = (state: OpsWorkerTaskState): OpsWorkerTaskV1 => {
      const task = makeV1Task(`legacy-${state.toLowerCase()}`);
      task.state = state;
      if (state === "RUNNING") {
        task.activeRun = {
          attemptId: "attempt-legacy",
          supervisorInstanceId: "supervisor-legacy",
          pid: 123,
          processGroupId: 123,
          processStartedAt: NOW,
          processStartToken: "start-legacy",
        };
      }
      if (state === "DONE") {
        task.lastOutcome = {
          at: NOW,
          kind: "DONE_CHECK",
          result: "PASS",
          summary: "Legacy task passed.",
        };
      }
      return task;
    };

    for (const state of ["RUNNING", "CHECKING", "RESUMABLE"] as const) {
      assert.deepEqual(parseOpsWorkerTask(legacyFor(state), registry).custody, {
        status: "HELD",
        claimedAt: NOW,
        releasedAt: null,
        releaseReason: null,
      });
    }
    assert.deepEqual(
      parseOpsWorkerTask(legacyFor("QUEUED"), registry).custody,
      { status: "UNCLAIMED", claimedAt: null, releasedAt: null, releaseReason: null },
    );
    for (const state of ["DONE", "CANCELLED", "BLOCKED"] as const) {
      assert.deepEqual(parseOpsWorkerTask(legacyFor(state), registry).custody, {
        status: "RELEASED",
        claimedAt: null,
        releasedAt: NOW,
        releaseReason: state,
      });
    }

    const ambiguous = legacyFor("BLOCKED");
    ambiguous.lastOutcome = {
      at: NOW,
      kind: "RECONCILIATION",
      result: "AMBIGUOUS_ORPHAN",
      summary: "Ownership could not be proven absent.",
    };
    ambiguous.unverifiedRun = {
      attemptId: "attempt-ambiguous",
      supervisorInstanceId: "supervisor-legacy",
      pid: null,
      expectedProcessGroupId: null,
      launchedAt: NOW,
      ownershipNonceHash: `sha256:${"5".repeat(64)}`,
    };
    assert.equal(parseOpsWorkerTask(ambiguous, registry).custody.status, "HELD");

    const cancelledWithStaleOutcome = legacyFor("CANCELLED");
    cancelledWithStaleOutcome.lastOutcome = {
      at: NOW,
      kind: "RECONCILIATION",
      result: "AMBIGUOUS_ORPHAN",
      summary: "A stale terminal outcome must not retain custody.",
    };
    const migratedCancelled = parseOpsWorkerTask(cancelledWithStaleOutcome, registry);
    assert.deepEqual(migratedCancelled.custody, {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: NOW,
      releaseReason: "CANCELLED",
    });
    assert.doesNotThrow(() => parseOpsWorkerTask(migratedCancelled, registry));
  });

  it("supports the deferred issue source without letting it change fixed priority or scope", () => {
    const task = makeTask("wt-20260717-issue58", "issue:example-org/minime-bot:58");
    task.source = {
      kind: "authorized-issue",
      correlationKey: "issue:example-org/minime-bot:58",
      deliveryKey: "github:issue-delivery:58",
      template: "issue-full-cycle",
    };
    task.priority = 30;
    task.authorization = {
      profile: "issue.full-cycle.v1",
      scope: ["repository-read", "repository-write", "pull-request", "issue-lifecycle"],
      snapshotHash: `sha256:${"a".repeat(64)}`,
    };

    const parsed = parseOpsWorkerTask(task, registry);
    assert.equal(parsed.priority, 30);
    assert.equal(parsed.authorization.snapshotHash, `sha256:${"a".repeat(64)}`);

    const wrongPriority = clone(task) as unknown as Record<string, unknown>;
    wrongPriority.priority = 0;
    assert.throws(
      () => parseOpsWorkerTask(wrongPriority, registry),
      /fixed priority 30/,
    );

    const elevatedScope = clone(task);
    elevatedScope.authorization.scope.push("deploy");
    assert.throws(
      () => parseOpsWorkerTask(elevatedScope, registry),
      /exactly match the registered authorization profile/,
    );
  });

  it("rejects unknown fields, arbitrary profiles, and unregistered names", () => {
    const withCommand = { ...makeTask(), command: "dangerous command" };
    assert.throws(
      () => parseOpsWorkerTask(withCommand, registry),
      /task\.command: unknown field/,
    );

    const arbitraryProfile = clone(makeTask());
    arbitraryProfile.authorization.profile = "operator.unrestricted.v1";
    assert.throws(
      () => parseOpsWorkerTask(arbitraryProfile, registry),
      /unregistered authorization profile/,
    );

    const unknownTemplate = clone(makeTask());
    unknownTemplate.source.template = "payload-template";
    assert.throws(
      () => parseOpsWorkerTask(unknownTemplate, registry),
      /unregistered template/,
    );

    const unknownCheck = clone(makeTask());
    unknownCheck.doneCheck.name = "payload-check";
    assert.throws(
      () => parseOpsWorkerTask(unknownCheck, registry),
      /unregistered done check/,
    );
  });

  it("rejects component, command, executable, and URL selectors after lax validation", () => {
    for (const params of [
      { command: "restart service" },
      { nested: { executable: "/bin/tool" } },
      { url: "https://example.invalid/health" },
      { components: ["payload-selected-check"] },
      { selector: "payload-selected-check" },
    ] as JsonObject[]) {
      const task = clone(makeTask());
      task.doneCheck = { name: "lax-fixture", params };
      assert.throws(
        () => parseOpsWorkerTask(task, registry),
        /cannot select components, commands, executables, URLs, or authorization/,
      );
    }
  });

  it("bounds evidence, JSON parameters, paths, timestamps, and whole snapshots", () => {
    const oversizedEvidence = clone(makeTask());
    oversizedEvidence.evidence[0].summary = "x".repeat(
      OPS_WORKER_LIMITS.maxEvidenceSummaryBytes + 1,
    );
    assert.throws(
      () => parseOpsWorkerTask(oversizedEvidence, registry),
      /must be at most 4096 UTF-8 bytes/,
    );
    const sparseEvidence = clone(makeTask());
    sparseEvidence.evidence = new Array(1);
    assert.throws(
      () => parseOpsWorkerTask(sparseEvidence, registry),
      /task\.evidence: must be dense/,
    );

    const traversal = clone(makeTask());
    traversal.evidence[0].artifact = "artifacts/../outside";
    assert.throws(
      () => parseOpsWorkerTask(traversal, registry),
      /contain no traversal segments/,
    );

    const outsideSession = clone(makeTask());
    outsideSession.session.directory = "/tmp/session";
    assert.throws(
      () => parseOpsWorkerTask(outsideSession, registry),
      /must be the task-owned path/,
    );

    const invalidDate = clone(makeTask()) as unknown as Record<string, unknown>;
    invalidDate.updatedAt = "2026-02-30T12:00:00Z";
    assert.throws(
      () => parseOpsWorkerTask(invalidDate, registry),
      OpsWorkerTaskValidationError,
    );

    assert.throws(
      () => parseOpsWorkerTaskJson(
        `{"padding":"${"x".repeat(OPS_WORKER_LIMITS.maxSnapshotBytes)}"}`,
        registry,
      ),
      /snapshot exceeds/,
    );
  });

  it("enforces every done-check parameter boundary before and after registered validation", () => {
    const parseParams = (
      params: unknown,
      selectedRegistry = registry,
    ): OpsWorkerTask => {
      const task = makeTask();
      task.doneCheck = { name: "lax-fixture", params: params as JsonObject };
      return parseOpsWorkerTask(task, selectedRegistry);
    };
    const nested = (depth: number): JsonObject => {
      let value: JsonObject = { leaf: true };
      for (let index = 0; index < depth; index += 1) value = { nested: value };
      return value;
    };
    const itemObject = (count: number): JsonObject => Object.fromEntries(
      Array.from({ length: count }, (_unused, index) => [`value${index}`, index]),
    ) as JsonObject;
    const sizedObject = (bytes: number): JsonObject => {
      const result: JsonObject = { a: "", b: "", c: "", d: "", e: "" };
      let remaining = bytes - Buffer.byteLength(JSON.stringify(result), "utf8");
      for (const key of Object.keys(result)) {
        const length = Math.min(
          OPS_WORKER_LIMITS.maxDoneCheckParamStringBytes,
          remaining,
        );
        result[key] = "x".repeat(length);
        remaining -= length;
      }
      assert.equal(remaining, 0);
      assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8"), bytes);
      return result;
    };

    assert.doesNotThrow(() => parseParams(nested(
      OPS_WORKER_LIMITS.maxDoneCheckParamDepth - 1,
    )));
    assert.doesNotThrow(() => parseParams(itemObject(
      OPS_WORKER_LIMITS.maxDoneCheckParamItems - 1,
    )));
    assert.doesNotThrow(() => parseParams({
      values: Array(OPS_WORKER_LIMITS.maxDoneCheckParamArrayLength).fill(null),
    }));
    assert.doesNotThrow(() => parseParams({
      text: "é".repeat(OPS_WORKER_LIMITS.maxDoneCheckParamStringBytes / 2),
    }));
    assert.doesNotThrow(() => parseParams(sizedObject(
      OPS_WORKER_LIMITS.maxDoneCheckParamsBytes,
    )));

    for (const [params, message] of [
      [nested(OPS_WORKER_LIMITS.maxDoneCheckParamDepth), /nested too deeply/],
      [itemObject(OPS_WORKER_LIMITS.maxDoneCheckParamItems), /too many values/],
      [{ values: Array(OPS_WORKER_LIMITS.maxDoneCheckParamArrayLength + 1).fill(null) }, /array is too large/],
      [{ text: "é".repeat(OPS_WORKER_LIMITS.maxDoneCheckParamStringBytes / 2 + 1) }, /string value is too large/],
      [sizedObject(OPS_WORKER_LIMITS.maxDoneCheckParamsBytes + 1), /must be at most 8192/],
      [{ value: Number.NaN }, /number must be finite/],
      [{ "not.safe": true }, /unsafe parameter field name/],
    ] as const) {
      assert.throws(() => parseParams(params), message);
    }

    const accessorParams: Record<string, unknown> = {};
    Object.defineProperty(accessorParams, "value", {
      enumerable: true,
      get: () => true,
    });
    assert.throws(() => parseParams(accessorParams), /accessor fields are not allowed/);

    const unsafeValidatorRegistry: OpsWorkerTaskContractRegistry = {
      ...registry,
      doneChecks: {
        ...registry.doneChecks,
        "lax-fixture": {
          validateParams(): JsonObject {
            return { command: "validator-introduced" } as JsonObject;
          },
        },
      },
    };
    assert.throws(
      () => parseParams({}, unsafeValidatorRegistry),
      /cannot select components, commands, executables, URLs, or authorization/,
    );
  });

  it("requires process-group proof only for RUNNING tasks", () => {
    const missingIdentity = clone(makeTask());
    missingIdentity.state = "RUNNING";
    assert.throws(
      () => parseOpsWorkerTask(missingIdentity, registry),
      /must identify the owned process group/,
    );

    const unexpectedIdentity = clone(makeTask());
    unexpectedIdentity.activeRun = {
      attemptId: "attempt-1",
      supervisorInstanceId: "supervisor-1",
      pid: 123,
      processGroupId: 123,
      processStartedAt: NOW,
      processStartToken: "start-1",
    };
    assert.throws(
      () => parseOpsWorkerTask(unexpectedIdentity, registry),
      /must be null unless state is RUNNING/,
    );

    const unexpectedFence = clone(makeTask());
    unexpectedFence.unverifiedRun = {
      attemptId: "attempt-unverified",
      supervisorInstanceId: "supervisor-1",
      pid: 456,
      expectedProcessGroupId: 456,
      launchedAt: NOW,
      ownershipNonceHash: `sha256:${"b".repeat(64)}`,
    };
    assert.throws(
      () => parseOpsWorkerTask(unexpectedFence, registry),
      /must be null unless retaining an ambiguous blocked launch fence/,
    );

    unexpectedFence.state = "BLOCKED";
    unexpectedFence.lastOutcome = {
      at: NOW,
      kind: "RECONCILIATION",
      result: "AMBIGUOUS_ORPHAN",
      summary: "Synthetic unverified launch remains fenced.",
    };
    unexpectedFence.custody = {
      status: "HELD",
      claimedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    };
    assert.equal(
      parseOpsWorkerTask(unexpectedFence, registry).unverifiedRun?.pid,
      456,
    );
  });
});

describe("ops worker durable task store", () => {
  it("loads exact v1-v4 snapshots purely on read and writes only canonical v5", (t) => {
    const store = makeStore(t);
    const previousTasks = [
      makeV1Task("read-migrate-v1", "read:migrate:v1"),
      makeV2Task("read-migrate-v2", "read:migrate:v2"),
      makeV3Task("read-migrate-v3", "read:migrate:v3"),
      makeV4Task("read-migrate-v4", "read:migrate:v4"),
    ];

    for (const previous of previousTasks) {
      const snapshotPath = join(store.tasksDirectory, `${previous.id}.json`);
      const rawLegacy = `${JSON.stringify(previous)}\n`;
      writeFileSync(snapshotPath, rawLegacy, { encoding: "utf8", mode: 0o600 });

      const loaded = store.get(previous.id);
      assert.ok(loaded);
      assert.equal(loaded.schemaVersion, 5);
      assert.deepEqual(loaded.steering, []);
      assert.deepEqual(loaded.control, {
        paused: false,
        pausedAt: null,
        interrupt: null,
      });
      assert.equal(readFileSync(snapshotPath, "utf8"), rawLegacy);
      assert.deepEqual(store.get(previous.id), loaded);
      assert.equal(readFileSync(snapshotPath, "utf8"), rawLegacy);

      store.replace(loaded, { event: "UPDATED" });
      const canonicalV5 = readFileSync(snapshotPath, "utf8");
      assert.equal(
        (JSON.parse(canonicalV5) as OpsWorkerTask).schemaVersion,
        5,
      );
      assert.deepEqual(store.get(previous.id), loaded);
      assert.equal(readFileSync(snapshotPath, "utf8"), canonicalV5);
    }
  });

  it("mutates steering and control idempotently under the store guard", (t) => {
    const store = makeStore(t);
    const task = makeTask("steering-guard", "steering:guard");
    attachFreshPass(task, NOW);
    store.create(task);
    const steering = {
      steeringId: "telegram:update:2001",
      receivedAt: NOW,
      kind: "answer" as const,
      operatorRef: "telegram:100000000",
      text: "The bounded operator answer is durable evidence.",
      consumedAt: null,
    };

    const appended = store.appendSteering(task.id, steering);
    assert.deepEqual(appended.task.steering, [steering]);
    assert.equal(appended.task.verification, null);
    const replayed = store.appendSteering(task.id, steering);
    assert.equal(replayed.journalAppended, false);
    assert.deepEqual(replayed.task, appended.task);
    assert.throws(
      () => store.appendSteering(task.id, { ...steering, text: "conflicting reuse" }),
      /conflicts with its durable record/,
    );

    assert.equal(store.setPaused(task.id, true).task.control.paused, true);
    assert.equal(store.setPaused(task.id, true).journalAppended, false);
    assert.equal(store.clearPaused(task.id).task.control.pausedAt, null);
    const interrupt = {
      requestedAt: NOW,
      mode: "cancel" as const,
      reason: "Cancel only after the owned process group is proven stopped.",
    };
    assert.deepEqual(store.setInterrupt(task.id, interrupt).task.control.interrupt, interrupt);
    assert.equal(store.setInterrupt(task.id, interrupt).journalAppended, false);
    assert.throws(
      () => store.setInterrupt(task.id, { ...interrupt, mode: "pause" }),
      /different pending interrupt/,
    );
    assert.equal(store.clearInterrupt(task.id).task.control.interrupt, null);

    assert.throws(
      () => store.mutate(task.id, { event: "UPDATED" }, (working) => {
        working.steering = [];
      }),
      /erase steering history/,
    );

    const full = makeTask("steering-full", "steering:full");
    full.steering = Array.from(
      { length: OPS_WORKER_LIMITS.maxSteeringEntries },
      (_, index) => ({ ...steering, steeringId: `telegram:update:full:${index}` }),
    );
    store.create(full);
    assert.throws(
      () => store.appendSteering(full.id, { ...steering, steeringId: "telegram:update:overflow" }),
      /exceeds 64 entries/,
    );

    const terminal = makeTask("steering-terminal", "steering:terminal");
    terminal.state = "CANCELLED";
    terminal.custody = {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: NOW,
      releaseReason: "CANCELLED",
    };
    store.create(terminal);
    assert.throws(
      () => store.appendSteering(
        terminal.id,
        { ...steering, steeringId: "telegram:update:terminal" },
      ),
      /terminal task/,
    );
  });

  it("does not reapply stale pause or interrupt effects when steering is replayed", (t) => {
    const store = makeStore(t);
    const pauseTask = makeTask("steering-pause-aba", "steering:pause:aba");
    store.create(pauseTask);
    const pause = {
      steeringId: "telegram:update:pause:1",
      receivedAt: NOW,
      kind: "pause" as const,
      operatorRef: "telegram:100000000",
      text: "pause",
      consumedAt: null,
    };
    const resume = {
      ...pause,
      steeringId: "telegram:update:resume:2",
      kind: "resume" as const,
      text: "resume",
    };

    store.appendSteeringAndSetPaused(pauseTask.id, pause, true);
    const resumed = store.appendSteeringAndSetPaused(pauseTask.id, resume, false);
    const replayedPause = store.appendSteeringAndSetPaused(pauseTask.id, pause, true);
    assert.equal(replayedPause.journalAppended, false);
    assert.deepEqual(replayedPause.task, resumed.task);
    assert.equal(replayedPause.task.control.paused, false);

    const interruptTask = makeTask("steering-interrupt-aba", "steering:interrupt:aba");
    store.create(interruptTask);
    const interruptSteering = {
      ...pause,
      steeringId: "telegram:update:interrupt:3",
    };
    store.appendSteeringAndSetInterrupt(interruptTask.id, interruptSteering, {
      requestedAt: NOW,
      mode: "pause",
      reason: "Reach the next proven safe boundary.",
    });
    store.clearInterrupt(interruptTask.id);
    const cleared = store.clearPaused(interruptTask.id);

    const replayedInterrupt = store.appendSteeringAndSetInterrupt(
      interruptTask.id,
      interruptSteering,
      {
        requestedAt: NOW,
        mode: "pause",
        reason: "Reach the next proven safe boundary.",
      },
    );
    assert.equal(replayedInterrupt.journalAppended, false);
    assert.deepEqual(replayedInterrupt.task, cleared.task);
    assert.equal(replayedInterrupt.task.control.interrupt, null);
    assert.equal(replayedInterrupt.task.control.paused, false);
  });

  it("keeps accepted steering closed under bounded runtime evidence growth", (t) => {
    const store = makeStore(t);
    const task = makeTask("steering-runtime-headroom", "steering:runtime:headroom");
    task.evidence = [];
    store.create(task);

    let accepted = 0;
    for (let index = 0; index < OPS_WORKER_LIMITS.maxSteeringEntries; index += 1) {
      try {
        store.appendSteering(task.id, {
          steeringId: `telegram:update:capacity:${index}`,
          receivedAt: NOW,
          kind: "answer",
          operatorRef: "telegram:100000000",
          text: "x".repeat(OPS_WORKER_LIMITS.maxSteeringTextBytes),
          consumedAt: null,
        });
        accepted += 1;
      } catch (error) {
        assert.ok(error instanceof OpsWorkerSteeringCapacityError);
        break;
      }
    }
    assert.ok(accepted > 0 && accepted < OPS_WORKER_LIMITS.maxSteeringEntries);
    const beforeGrowth = store.get(task.id);
    assert.ok(beforeGrowth);
    assert.ok(
      Buffer.byteLength(`${JSON.stringify(beforeGrowth)}\n`, "utf8")
        <= OPS_WORKER_LIMITS.maxSnapshotBytes
          - OPS_WORKER_LIMITS.minRuntimeMutationHeadroomBytes,
    );

    const grown = store.mutate(task.id, {
      event: "EVIDENCE",
      summary: "Recorded bounded runtime evidence after steering",
    }, (working) => {
      for (let index = 0; index < OPS_WORKER_LIMITS.maxEvidenceEntries; index += 1) {
        appendOpsWorkerEvidence(working, {
          at: NOW,
          kind: "pi",
          trust: "trusted",
          summary: `${index.toString().padStart(2, "0")}:${"e".repeat(
            OPS_WORKER_LIMITS.maxEvidenceSummaryBytes - 3,
          )}`,
          artifact: null,
        });
      }
      working.updatedAt = new Date(Date.parse(working.updatedAt) + 1).toISOString();
    }).task;

    assert.equal(grown.steering.length, accepted);
    assert.ok(
      grown.evidence.length > 0
        && grown.evidence.length < OPS_WORKER_LIMITS.maxEvidenceEntries,
    );
    assert.ok(
      Buffer.byteLength(`${JSON.stringify(grown)}\n`, "utf8")
        <= OPS_WORKER_LIMITS.maxSnapshotBytes,
    );
  });

  it("keeps steering and control mutation timestamps monotonic when the clock regresses", (t) => {
    const store = makeStore(t, {
      now: () => new Date("2020-01-01T00:00:00.000Z"),
    });
    const task = makeTask("steering-regressed-clock", "steering:regressed-clock");
    store.create(task);
    const steering = (steeringId: string, kind: "answer" | "pause" | "cancel") => ({
      steeringId,
      receivedAt: NOW,
      kind,
      operatorRef: "telegram:100000000",
      text: kind,
      consumedAt: null,
    });
    const timestamps: string[] = [];

    timestamps.push(store.appendSteering(
      task.id,
      steering("telegram:update:regressed:1", "answer"),
    ).task.updatedAt);
    const paused = store.appendSteeringAndSetPaused(
      task.id,
      steering("telegram:update:regressed:2", "pause"),
      true,
    ).task;
    timestamps.push(paused.updatedAt);
    assert.equal(paused.control.pausedAt, paused.updatedAt);
    timestamps.push(store.clearPaused(task.id).task.updatedAt);
    timestamps.push(store.appendSteeringAndSetInterrupt(
      task.id,
      steering("telegram:update:regressed:3", "cancel"),
      { requestedAt: NOW, mode: "cancel", reason: "bounded cancellation" },
    ).task.updatedAt);
    timestamps.push(store.clearInterrupt(task.id).task.updatedAt);
    timestamps.push(store.setInterrupt(task.id, {
      requestedAt: NOW,
      mode: "pause",
      reason: "bounded pause",
    }).task.updatedAt);
    timestamps.push(store.clearInterrupt(task.id).task.updatedAt);

    assert.deepEqual(
      timestamps.map((timestamp) => Date.parse(timestamp)),
      timestamps.map((_timestamp, index) => Date.parse(NOW) + index + 1),
    );
    assert.equal(store.get(task.id)?.control.pausedAt, timestamps[5]);
  });

  it("persists report evidence on migrated legacy DONE snapshots without inventing PASS", (t) => {
    const store = makeStore(t);
    const previousTasks = [
      makeV1Task("legacy-done-v1", "legacy:done:v1"),
      makeV2Task("legacy-done-v2", "legacy:done:v2"),
      makeV3Task("legacy-done-v3", "legacy:done:v3"),
    ];
    for (const previous of previousTasks) {
      previous.state = "DONE";
      previous.lastOutcome = {
        at: NOW,
        kind: "DONE_CHECK",
        result: "PASS",
        summary: "Legacy completion predates composite verification.",
      };
      previous.report = { state: "PENDING", attempts: 0, lastError: null };
      if (previous.schemaVersion !== 1) {
        previous.custody = {
          status: "RELEASED",
          claimedAt: null,
          releasedAt: NOW,
          releaseReason: "DONE",
        };
      }
      const snapshotPath = join(store.tasksDirectory, `${previous.id}.json`);
      writeFileSync(snapshotPath, `${JSON.stringify(previous)}\n`, { mode: 0o600 });

      const loaded = store.get(previous.id);
      assert.equal(loaded?.legacyCompletion?.sourceSchemaVersion, previous.schemaVersion);
      assert.equal(loaded?.verification, null);
      const mutated = store.mutate(
        previous.id,
        { event: "REPORT", summary: "Recorded legacy completion report attempt" },
        (task) => {
          task.report.attempts = 1;
          task.report.lastError = "Synthetic report retry remains pending.";
        },
      ).task;

      assert.equal(mutated.state, "DONE");
      assert.equal(mutated.verification, null);
      assert.equal(mutated.legacyCompletion?.sourceSchemaVersion, previous.schemaVersion);
      assert.equal(store.get(previous.id)?.report.attempts, 1);
      assert.equal(
        (JSON.parse(readFileSync(snapshotPath, "utf8")) as OpsWorkerTask).schemaVersion,
        5,
      );
    }
  });

  it("writes a private authoritative snapshot before its bounded audit record", (t) => {
    const store = makeStore(t);
    const result = store.create(makeTask(), {
      event: "CREATED",
      summary: "Registered operator task accepted.",
    });

    assert.equal(result.journalAppended, true);
    assert.equal(lstatSync(store.stateDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(store.tasksDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(result.snapshotPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(store.journalPath).mode & 0o777, 0o600);
    assert.deepEqual(store.get(makeTask().id), makeTask());

    const entries = readFileSync(store.journalPath, "utf8").trim().split("\n");
    assert.equal(entries.length, 1);
    const entry = JSON.parse(entries[0]) as Record<string, unknown>;
    assert.equal(entry.taskId, makeTask().id);
    assert.equal(entry.state, "QUEUED");
    assert.equal(entry.event, "CREATED");
  });

  it("atomically replaces a snapshot and leaves no temp file on success", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    store.create(original);
    const replacement = clone(original);
    replacement.updatedAt = LATER;
    replacement.evidence.push({
      at: LATER,
      kind: "system",
      trust: "trusted",
      summary: "A second bounded observation was persisted.",
      artifact: "artifacts/observation.json",
    });

    store.replace(replacement, { event: "EVIDENCE" });

    assert.deepEqual(store.get(original.id), replacement);
    assert.deepEqual(
      readdirSync(store.tasksDirectory).filter((name) => name.endsWith(".tmp")),
      [],
    );
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(store.tasksDirectory, `${original.id}.json`), "utf8")));
  });

  it("rejects changes to immutable normalized resource identity", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    store.create(original);

    const changed = clone(original);
    changed.resource = {
      kind: "repository",
      key: "github:example/minime-bot",
    };
    assert.throws(
      () => store.replace(changed),
      /immutable identity/,
    );
    assert.deepEqual(store.get(original.id), original);
  });

  it("keeps submission, delivery, resource, and creation identity immutable", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    store.create(original);

    for (const change of [
      (task: OpsWorkerTask) => { task.source.deliveryKey = "fixture:changed-delivery"; },
      (task: OpsWorkerTask) => {
        task.resource = { kind: "repository", key: "github:example/minime-bot" };
      },
      (task: OpsWorkerTask) => {
        task.createdAt = LATER;
        task.updatedAt = LATER;
      },
      (task: OpsWorkerTask) => {
        task.submissionFingerprint = `sha256:${"f".repeat(64)}`;
      },
    ]) {
      assert.throws(
        () => store.mutate(original.id, { event: "UPDATED" }, (task) => change(task)),
        /immutable identity/,
      );
      assert.deepEqual(store.get(original.id), original);
    }
  });

  it("keeps the submitted execution contract immutable through replace and mutate", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    store.create(original);

    const changes: Array<(task: OpsWorkerTask) => void> = [
      (task) => {
        task.objective = "Run a different objective with the original submission fingerprint";
      },
      (task) => {
        task.doneCheck = { name: "lax-fixture", params: { sampleCount: 3 } };
      },
      (task) => {
        task.authorization = {
          profile: "operator.repair.v1",
          scope: ["local-reversible-repair"],
          snapshotHash: null,
        };
      },
    ];

    for (const change of changes) {
      const replacement = clone(original);
      change(replacement);
      assert.throws(() => store.replace(replacement), /immutable identity/);
      assert.throws(
        () => store.mutate(original.id, { event: "UPDATED" }, change),
        /immutable identity/,
      );
      assert.deepEqual(store.get(original.id), original);
    }
  });

  it("enforces write-once lifecycle identities in every authoritative store mutation", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    store.create(original);
    const identified = clone(original);
    identified.lifecycle.repository = "github:example/minime-bot";
    identified.updatedAt = LATER;
    store.replace(identified);

    const cleared = clone(identified);
    cleared.lifecycle.repository = null;
    assert.throws(
      () => store.replace(cleared),
      /write-once lifecycle identity repository/,
    );
    assert.throws(
      () => store.mutate(original.id, { event: "UPDATED" }, (task) => {
        task.lifecycle.repository = "github:example/other";
      }),
      /write-once lifecycle identity repository/,
    );
    assert.deepEqual(store.get(original.id), identified);
  });

  it("applies read-modify-write callbacks to the latest snapshot under one guard", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    store.create(original);

    const result = store.mutate(
      original.id,
      { event: "UPDATED", summary: "Increment remediation round" },
      (task) => {
        task.rounds.remediation += 1;
        task.updatedAt = LATER;
      },
    );

    assert.equal(result.task.rounds.remediation, 1);
    assert.equal(result.task.updatedAt, LATER);
    assert.equal(result.journalAppended, true);
    assert.deepEqual(store.get(original.id), result.task);
  });

  it("recovers the old snapshot when a crash occurs after temp-file fsync", (t) => {
    const directory = testStateDirectory(t);
    const initial = makeStore(t, { directory });
    const original = makeTask();
    initial.create(original);
    const replacement = clone(original);
    replacement.updatedAt = LATER;
    replacement.rounds.remediation = 1;
    let armed = true;
    const crashing = makeStore(t, {
      directory,
      faultInjector(point) {
        if (armed && point === "after-temp-file-fsync") {
          armed = false;
          throw new Error("simulated process crash");
        }
      },
    });

    assert.throws(() => crashing.replace(replacement), /simulated process crash/);
    const recovered = makeStore(t, { directory });
    assert.deepEqual(recovered.get(original.id), original);
    assert.equal(
      readdirSync(recovered.tasksDirectory).some((name) => name.endsWith(".tmp")),
      true,
      "crash-like temp tail is ignored rather than treated as a snapshot",
    );
  });

  it("recovers the new snapshot when a crash occurs before journal append", (t) => {
    const directory = testStateDirectory(t);
    const initial = makeStore(t, { directory });
    const original = makeTask();
    initial.create(original);
    const oldJournal = readFileSync(initial.journalPath, "utf8");
    const replacement = clone(original);
    replacement.updatedAt = LATER;
    replacement.rounds.remediation = 1;
    let armed = true;
    const crashing = makeStore(t, {
      directory,
      faultInjector(point) {
        if (armed && point === "before-journal-append") {
          armed = false;
          throw new Error("simulated process crash before audit");
        }
      },
    });

    assert.throws(() => crashing.replace(replacement), /simulated process crash before audit/);
    const recovered = makeStore(t, { directory });
    assert.deepEqual(recovered.get(original.id), replacement);
    assert.equal(readFileSync(recovered.journalPath, "utf8"), oldJournal);
  });

  it("keeps the old mutation before rename and the new mutation after rename", (t) => {
    for (const crashPoint of ["after-temp-file-fsync", "after-snapshot-rename"] as const) {
      const directory = testStateDirectory(t);
      const initial = makeStore(t, { directory });
      const original = makeTask(`wt-mutate-${crashPoint}`);
      initial.create(original);
      const oldJournal = readFileSync(initial.journalPath, "utf8");
      let armed = true;
      const crashing = makeStore(t, {
        directory,
        faultInjector(point) {
          if (armed && point === crashPoint) {
            armed = false;
            throw new Error(`simulated ${crashPoint} crash`);
          }
        },
      });

      assert.throws(
        () => crashing.mutate(original.id, { event: "UPDATED" }, (task) => {
          task.rounds.remediation = 1;
          task.updatedAt = LATER;
        }),
        new RegExp(`simulated ${crashPoint} crash`),
      );
      const recovered = makeStore(t, { directory });
      assert.equal(
        recovered.get(original.id)?.rounds.remediation,
        crashPoint === "after-snapshot-rename" ? 1 : original.rounds.remediation,
      );
      assert.equal(readFileSync(recovered.journalPath, "utf8"), oldJournal);
    }
  });

  it("loads snapshots with a missing, truncated, or contradictory journal tail", (t) => {
    const directory = testStateDirectory(t);
    const store = makeStore(t, { directory });
    const task = makeTask();
    store.create(task);

    writeFileSync(
      store.journalPath,
      `${JSON.stringify({ taskId: task.id, state: "DONE" })}\n{"truncated":`,
      { mode: 0o600 },
    );
    assert.equal(makeStore(t, { directory }).get(task.id)?.state, "QUEUED");

    unlinkSync(store.journalPath);
    assert.deepEqual(makeStore(t, { directory }).list(), [task]);
  });

  it("rejects malformed or mismatched authoritative snapshots", (t) => {
    const directory = testStateDirectory(t);
    const store = makeStore(t, { directory });
    writeFileSync(join(store.tasksDirectory, "wt-malformed.json"), "{not-json", { mode: 0o600 });
    assert.throws(() => store.list(), /malformed JSON/);
    unlinkSync(join(store.tasksDirectory, "wt-malformed.json"));

    const task = makeTask();
    writeFileSync(
      join(store.tasksDirectory, "wt-wrong-name.json"),
      `${JSON.stringify(task)}\n`,
      { mode: 0o600 },
    );
    assert.throws(() => store.list(), /does not match task id/);
  });

  it("rejects duplicate active correlations but permits a new task after a terminal snapshot", (t) => {
    const store = makeStore(t);
    const first = makeTask();
    store.create(first);
    const duplicate = makeTask("wt-20260717-duplicate", first.source.correlationKey);
    assert.throws(
      () => store.create(duplicate),
      (error: unknown) => {
        assert.ok(error instanceof OpsWorkerDuplicateCorrelationError);
        assert.equal(error.existingTaskId, first.id);
        return true;
      },
    );

    const completed = clone(first);
    completed.state = "DONE";
    completed.updatedAt = LATER;
    completed.lastOutcome = {
      at: LATER,
      kind: "DONE_CHECK",
      result: "PASS",
      summary: "Fresh fixture evidence passed.",
    };
    attachFreshPass(completed, LATER);
    completed.custody = {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: LATER,
      releaseReason: "DONE",
    };
    store.replace(completed, { event: "TRANSITION" });
    assert.doesNotThrow(() => store.create(duplicate));
    assert.equal(store.list().length, 2);
  });

  it("returns the original terminal task for an identical delivery replay", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    const created = store.create(original);
    assert.equal(created.created, true);
    assert.deepEqual(created.task, original);

    const completed = clone(original);
    completed.state = "DONE";
    completed.updatedAt = LATER;
    completed.lastOutcome = {
      at: LATER,
      kind: "DONE_CHECK",
      result: "PASS",
      summary: "Fresh fixture evidence passed.",
    };
    attachFreshPass(completed, LATER);
    completed.custody = {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: LATER,
      releaseReason: "DONE",
    };
    completed.evidence = Array.from(
      { length: OPS_WORKER_LIMITS.maxEvidenceEntries },
      (_, index) => ({
        at: LATER,
        kind: "system" as const,
        trust: "trusted" as const,
        summary: `Bounded runtime evidence ${index}`,
        artifact: null,
      }),
    );
    store.replace(completed, { event: "TRANSITION" });
    const journalBeforeReplay = readFileSync(store.journalPath, "utf8");
    const replay = makeTask("wt-20260717-replayed", original.source.correlationKey);
    replay.source.deliveryKey = original.source.deliveryKey;
    replay.createdAt = LATER;
    replay.updatedAt = LATER;

    const result = store.create(replay);

    assert.equal(result.created, false);
    assert.equal(result.journalAppended, false);
    assert.deepEqual(result.task, completed);
    assert.equal(store.list().length, 1);
    assert.equal(readFileSync(store.journalPath, "utf8"), journalBeforeReplay);
  });

  it("fails closed when one delivery key is reused for a conflicting submission", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    store.create(original);
    const conflict = makeTask("wt-20260717-conflict", original.source.correlationKey);
    conflict.source.deliveryKey = original.source.deliveryKey;
    conflict.objective = "A different canonical adapter submission";

    assert.throws(
      () => store.create(conflict),
      (error: unknown) => {
        assert.ok(error instanceof OpsWorkerDeliveryConflictError);
        assert.equal(error.existingTaskId, original.id);
        return true;
      },
    );
    assert.deepEqual(store.list(), [original]);
  });

  it("fails closed when a delivery replay changes submission evidence", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    store.create(original);
    const conflict = makeTask(
      "wt-20260717-evidence-conflict",
      original.source.correlationKey,
    );
    conflict.source.deliveryKey = original.source.deliveryKey;
    conflict.evidence[0].summary = "Materially different adapter evidence";

    assert.throws(
      () => store.create(conflict),
      (error: unknown) => {
        assert.ok(error instanceof OpsWorkerDeliveryConflictError);
        assert.equal(error.existingTaskId, original.id);
        return true;
      },
    );
    assert.deepEqual(store.list(), [original]);
  });

  it("enforces one held custody owner across create, replace, and mutate", (t) => {
    const store = makeStore(t);
    const first = makeTask("wt-held-first", "operator:held:first");
    first.custody = {
      status: "HELD",
      claimedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    };
    store.create(first);
    const second = makeTask("wt-held-second", "operator:held:second");
    store.create(second);

    assert.throws(
      () => store.mutate(second.id, { event: "TRANSITION" }, (task) => {
        task.custody = {
          status: "HELD",
          claimedAt: NOW,
          releasedAt: null,
          releaseReason: null,
        };
      }),
      /multiple held custody owners/,
    );
    const secondHeld = clone(second);
    secondHeld.custody = {
      status: "HELD",
      claimedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    };
    assert.throws(() => store.replace(secondHeld), /multiple held custody owners/);
    assert.deepEqual(store.get(second.id), second);
  });

  it("serializes concurrent cross-process correlation creation", async (t) => {
    const root = testStateDirectory(t);
    const directory = join(root, "state");
    const readyPath = join(root, "first-ready");
    const releasePath = join(root, "release-first");
    const runFixture = (
      operation: "create" | "mutate",
      taskId: string,
      barrier = false,
    ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        STORE_CREATE_FIXTURE,
        operation,
        directory,
        taskId,
        "operator:shared:concurrent",
        ...(barrier ? [readyPath, releasePath] : []),
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      return new Promise((resolveChild) => {
        child.once("close", (code) => resolveChild({ code, stdout, stderr }));
      });
    };

    const first = runFixture("create", "concurrent-a", true);
    let second:
      | Promise<{ code: number | null; stdout: string; stderr: string }>
      | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(readyPath)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for first store writer");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      second = runFixture("create", "concurrent-b");
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    } finally {
      writeFileSync(releasePath, "release\n", "utf8");
    }
    assert.ok(second !== undefined);
    const results = await Promise.all([first, second]);

    assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
    assert.equal(
      results.some((result) => /OpsWorkerDuplicateCorrelationError/.test(result.stderr)),
      true,
    );
    const recovered = new OpsWorkerTaskStore(directory, { registry });
    assert.equal(recovered.list().length, 1);
  });

  it("serializes concurrent cross-process read-modify-write callbacks", async (t) => {
    const root = testStateDirectory(t);
    const directory = join(root, "state");
    const readyPath = join(root, "first-ready");
    const releasePath = join(root, "release-first");
    const task = makeTask("concurrent-mutate", "operator:shared:mutation");
    makeStore(t, { directory }).create(task);
    const runFixture = (
      barrier = false,
    ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        STORE_CREATE_FIXTURE,
        "mutate",
        directory,
        task.id,
        task.source.correlationKey,
        ...(barrier ? [readyPath, releasePath] : []),
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      return new Promise((resolveChild) => {
        child.once("close", (code) => resolveChild({ code, stdout, stderr }));
      });
    };

    const first = runFixture(true);
    let second: ReturnType<typeof runFixture> | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(readyPath)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for first store mutator");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      second = runFixture();
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    } finally {
      writeFileSync(releasePath, "release\n", "utf8");
    }
    assert.ok(second !== undefined);
    const results = await Promise.all([first, second]);

    assert.deepEqual(results.map((result) => result.code), [0, 0]);
    assert.deepEqual(
      results.map((result) => Number(result.stdout.trim())).sort(),
      [1, 2],
    );
    const recovered = new OpsWorkerTaskStore(directory, { registry });
    assert.equal(recovered.get(task.id)?.rounds.remediation, 2);
  });

  it("publishes complete mutation locks and reclaims a reused PID identity", (t) => {
    const directory = testStateDirectory(t);
    const interrupted = makeStore(t, {
      directory,
      faultInjector(point) {
        if (point === "after-mutation-lock-temp-fsync") {
          throw new Error("synthetic mutation-lock publication crash");
        }
      },
    });
    assert.throws(
      () => interrupted.create(makeTask()),
      /synthetic mutation-lock publication crash/,
    );
    const canonicalLock = join(directory, ".task-store.lock");
    assert.equal(existsSync(canonicalLock), false);

    writeFileSync(canonicalLock, `${JSON.stringify({
      pid: process.pid,
      processStartToken: `sha256:${"0".repeat(64)}`,
      nonce: "1".repeat(32),
    })}\n`, { mode: 0o600 });
    const recovered = makeStore(t, { directory });
    assert.doesNotThrow(() => recovered.create(makeTask()));
    assert.equal(existsSync(canonicalLock), false);
    assert.equal(existsSync(join(directory, ".task-store.lock.recovery")), false);

    const fencedDirectory = testStateDirectory(t);
    const fencedLock = join(fencedDirectory, ".task-store.lock");
    const recoveryGuard = join(fencedDirectory, ".task-store.lock.recovery");
    const staleRecord = `${JSON.stringify({
      pid: process.pid,
      processStartToken: `sha256:${"0".repeat(64)}`,
      nonce: "2".repeat(32),
    })}\n`;
    writeFileSync(fencedLock, staleRecord, { mode: 0o600 });
    writeFileSync(recoveryGuard, "unfinished recovery\n", { mode: 0o600 });

    assert.throws(
      () => makeStore(t, { directory: fencedDirectory }).create(
        makeTask("wt-recovery-fenced", "operator:recovery:fenced"),
      ),
      /Another ops-worker task-store mutation is in progress/,
    );
    assert.equal(readFileSync(fencedLock, "utf8"), staleRecord);
    assert.equal(readFileSync(recoveryGuard, "utf8"), "unfinished recovery\n");
  });

  it("retries when a mutation lock disappears after a publish conflict", (t) => {
    const directory = testStateDirectory(t);
    const canonicalLock = join(directory, ".task-store.lock");
    writeFileSync(canonicalLock, "owner releases before inspection\n", { mode: 0o600 });
    let conflictCount = 0;
    const store = makeStore(t, {
      directory,
      faultInjector(point) {
        if (point === "after-mutation-lock-publish-conflict") {
          conflictCount += 1;
          unlinkSync(canonicalLock);
        }
      },
    });

    assert.doesNotThrow(() => store.create(
      makeTask("wt-release-race", "operator:release-race"),
    ));
    assert.equal(conflictCount, 1);
    assert.equal(existsSync(canonicalLock), false);
  });

  it("rejects traversal identifiers and symlinked state paths", (t) => {
    const store = makeStore(t);
    assert.throws(() => store.get("../outside"), /traversal-safe/);

    const outside = testStateDirectory(t);
    const symlinkRoot = join(testStateDirectory(t), "linked-state");
    symlinkSync(outside, symlinkRoot, "dir");
    assert.throws(
      () => new OpsWorkerTaskStore(symlinkRoot, { registry }),
      /path is a symlink/,
    );

    const task = makeTask();
    const snapshotPath = join(store.tasksDirectory, `${task.id}.json`);
    const target = join(testStateDirectory(t), "outside.json");
    writeFileSync(target, `${JSON.stringify(task)}\n`, { mode: 0o600 });
    symlinkSync(target, snapshotPath);
    assert.throws(() => store.get(task.id), /path is a symlink/);
  });

  it("rejects a symlinked journal before changing an existing snapshot", (t) => {
    const store = makeStore(t);
    const task = makeTask();
    store.create(task);
    unlinkSync(store.journalPath);
    const outsideJournal = join(testStateDirectory(t), "outside-journal.jsonl");
    writeFileSync(outsideJournal, "outside\n", { mode: 0o600 });
    symlinkSync(outsideJournal, store.journalPath);
    const replacement = clone(task);
    replacement.updatedAt = LATER;
    replacement.rounds.remediation = 1;

    assert.throws(() => store.replace(replacement), /path is a symlink/);
    rmSync(store.journalPath, { force: true });
    assert.deepEqual(store.get(task.id), task);
    assert.equal(readFileSync(outsideJournal, "utf8"), "outside\n");
  });

  it("keeps the append-only audit bounded without affecting snapshot authority", (t) => {
    const store = makeStore(t, { maxJournalBytes: 0 });
    const task = makeTask();
    const result = store.create(task);

    assert.equal(result.journalAppended, false);
    assert.equal(readFileSync(store.journalPath, "utf8"), "");
    assert.deepEqual(store.get(task.id), task);
  });

  it("rejects non-regular snapshot entries instead of following them", (t) => {
    const store = makeStore(t);
    const directoryName = "wt-directory.json";
    mkdirSync(join(store.tasksDirectory, directoryName), { mode: 0o700 });
    assert.throws(() => store.list(), OpsWorkerTaskStoreSafetyError);
  });

  it("does not depend on writable broad permissions supplied by the caller", (t) => {
    const directory = testStateDirectory(t);
    chmodSync(directory, 0o777);
    const store = makeStore(t, { directory });
    store.create(makeTask());
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.equal(existsSync(store.journalPath), true);
  });

  it("uses unpredictable same-directory temporary names at the crash boundary", (t) => {
    const directory = testStateDirectory(t);
    const suffix = randomBytes(3).toString("hex");
    const task = makeTask(`wt-temp-${suffix}`);
    const store = makeStore(t, {
      directory,
      faultInjector(point) {
        if (point === "after-temp-file-fsync") throw new Error("stop before rename");
      },
    });
    assert.throws(() => store.create(task), /stop before rename/);
    const tempNames = readdirSync(store.tasksDirectory).filter((name) => name.endsWith(".tmp"));
    assert.equal(tempNames.length, 1);
    assert.match(tempNames[0], new RegExp(`^\\.${task.id}\\.${process.pid}\\.[a-f0-9]{16}\\.tmp$`));
    assert.equal(lstatSync(join(store.tasksDirectory, tempNames[0])).isSymbolicLink(), false);
  });
});
