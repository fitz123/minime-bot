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
  OpsWorkerTaskValidationError,
  parseOpsWorkerTask,
  parseOpsWorkerTaskJson,
  type JsonObject,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
  type OpsWorkerTaskState,
  type OpsWorkerTaskV1,
} from "../ops-worker/types.js";
import {
  OpsWorkerDeliveryConflictError,
  OpsWorkerDuplicateCorrelationError,
  OpsWorkerTaskStore,
  OpsWorkerTaskStoreSafetyError,
  type OpsWorkerTaskStoreFaultPoint,
} from "../ops-worker/task-store.js";

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
      tools: ["read", "grep", "find", "ls"],
    },
    "issue.full-cycle.v1": {
      sourceKinds: ["authorized-issue"],
      scope: ["repository-read", "repository-write", "pull-request", "issue-lifecycle"],
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
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
  return {
    schemaVersion: 2,
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
      schemaVersion: 1,
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
  };
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
    ...legacy
  } = current;
  const { deliveryKey: _deliveryKey, ...source } = legacy.source;
  return {
    ...legacy,
    schemaVersion: 1,
    source: source as OpsWorkerTaskV1["source"],
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
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
  } = {},
): OpsWorkerTaskStore {
  return new OpsWorkerTaskStore(options.directory ?? testStateDirectory(t), {
    registry,
    now: () => new Date(NOW),
    maxJournalBytes: options.maxJournalBytes,
    faultInjector: options.faultInjector,
  });
}

describe("ops worker task contract", () => {
  it("strictly round-trips a complete v2 envelope into an independent value", () => {
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
      schemaVersion: 1,
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
      report: "sha256:report-identity",
      tailAudit: "audit:tail-1",
    };
    input.currentCheckpoint = {
      checkpointId: "checkpoint-01",
      recordedAt: NOW,
      payloadHash: `sha256:${"1".repeat(64)}`,
      summary: "The bounded fixture checkpoint is durable.",
      artifact: "artifacts/checkpoint.json",
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
    assert.equal(first.schemaVersion, 2);
    assert.deepEqual(first.source, {
      ...input.source,
      deliveryKey: `legacy:${input.id}`,
    });
    assert.deepEqual(first.resource, {
      kind: "host",
      key: `host:legacy-${input.id}`,
    });
    assert.equal(first.lifecycle.schemaVersion, 1);
    assert.ok(Object.values(first.lifecycle).slice(1).every((value) => value === null));
    assert.equal(first.currentCheckpoint, null);
    assert.ok(Object.values(first.mutationReceipts).every((value) => value === null));
    first.source.correlationKey = "changed:after:migration";
    assert.equal(input.source.correlationKey, "operator:health:local");
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

  it("rejects unknown schema versions and unknown v1 or v2 fields", () => {
    const future = { ...makeTask(), schemaVersion: 3 };
    assert.throws(
      () => parseOpsWorkerTask(future, registry),
      /supported version 1 or 2/,
    );
    assert.throws(
      () => parseOpsWorkerTask({ ...makeV1Task(), resource: { kind: "host", key: "host:local" } }, registry),
      /task\.resource: unknown field/,
    );
    const futureLifecycle = clone(makeTask()) as unknown as Record<string, unknown>;
    (futureLifecycle.lifecycle as Record<string, unknown>).workflow = "arbitrary";
    assert.throws(
      () => parseOpsWorkerTask(futureLifecycle, registry),
      /task\.lifecycle\.workflow: unknown field/,
    );
  });

  it("requires normalized bounded resource and delivery identities", () => {
    const uppercase = clone(makeTask());
    uppercase.resource.key = "github:Example/minime-bot";
    assert.throws(() => parseOpsWorkerTask(uppercase, registry), /normalized lowercase/);

    const mismatched = clone(makeTask());
    mismatched.resource = { kind: "repository", key: "host:local" };
    assert.throws(() => parseOpsWorkerTask(mismatched, registry), /non-host namespace/);

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

  it("rejects command, executable, and URL selectors even after a lax check validator", () => {
    for (const params of [
      { command: "restart service" },
      { nested: { executable: "/bin/tool" } },
      { url: "https://example.invalid/health" },
    ] as JsonObject[]) {
      const task = clone(makeTask());
      task.doneCheck = { name: "lax-fixture", params };
      assert.throws(
        () => parseOpsWorkerTask(task, registry),
        /cannot select commands, executables, URLs, or authorization/,
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
      /cannot select commands, executables, URLs, or authorization/,
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
  it("loads v1 without writing and persists canonical v2 on the next successful write", (t) => {
    const store = makeStore(t);
    const legacy = makeV1Task();
    const snapshotPath = join(store.tasksDirectory, `${legacy.id}.json`);
    const rawLegacy = `${JSON.stringify(legacy)}\n`;
    writeFileSync(snapshotPath, rawLegacy, { encoding: "utf8", mode: 0o600 });

    const loaded = store.get(legacy.id);
    assert.ok(loaded);
    assert.equal(loaded.schemaVersion, 2);
    assert.equal(readFileSync(snapshotPath, "utf8"), rawLegacy);
    assert.deepEqual(store.get(legacy.id), loaded);
    assert.equal(readFileSync(snapshotPath, "utf8"), rawLegacy);

    store.replace(loaded, { event: "UPDATED" });
    const canonicalV2 = `${JSON.stringify(loaded)}\n`;
    assert.equal(readFileSync(snapshotPath, "utf8"), canonicalV2);
    assert.deepEqual(store.get(legacy.id), loaded);
    assert.equal(readFileSync(snapshotPath, "utf8"), canonicalV2);
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

  it("keeps source delivery identity, resource identity, and creation time immutable", (t) => {
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
    ]) {
      assert.throws(
        () => store.mutate(original.id, { event: "UPDATED" }, (task) => change(task)),
        /immutable identity/,
      );
      assert.deepEqual(store.get(original.id), original);
    }
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
    replacement.objective = "Replacement that must not become visible before rename";
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
    replacement.objective = "Durable replacement before non-authoritative audit";
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
          task.objective = `Mutation visible ${crashPoint}`;
          task.updatedAt = LATER;
        }),
        new RegExp(`simulated ${crashPoint} crash`),
      );
      const recovered = makeStore(t, { directory });
      assert.equal(
        recovered.get(original.id)?.objective,
        crashPoint === "after-snapshot-rename"
          ? `Mutation visible ${crashPoint}`
          : original.objective,
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
    completed.custody = {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: LATER,
      releaseReason: "DONE",
    };
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
    replacement.objective = "Must not be written through unsafe journal setup";

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
