import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import {
  OpsWorkerLifecycle,
  hashOpsWorkerCanonicalPayload,
} from "../ops-worker/lifecycle.js";
import { OpsWorkerTaskStore } from "../ops-worker/task-store.js";
import {
  createEmptyOpsWorkerLifecycleManifest,
  createEmptyOpsWorkerMutationReceipts,
  createUnclaimedOpsWorkerCustody,
  hashOpsWorkerVerificationSubject,
  withOpsWorkerSubmissionFingerprint,
  type JsonObject,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "../ops-worker/types.js";

const LIFECYCLE_UPDATE_FIXTURE = fileURLToPath(
  new URL("./fixtures/ops-worker-lifecycle-update.ts", import.meta.url),
);
const NOW = "2026-07-18T09:00:00.000Z";
const LATER = "2026-07-18T09:05:00.000Z";

const registry: OpsWorkerTaskContractRegistry = {
  templates: { "fixture-task": { sourceKinds: ["operator-cli"] } },
  authorizationProfiles: {
    "fixture.inspect.v1": {
      sourceKinds: ["operator-cli"],
      scope: ["inspect"],
    },
    "fixture.mutate.v1": {
      sourceKinds: ["operator-cli"],
      scope: ["pull-request", "release", "deploy", "issue-lifecycle"],
    },
  },
  doneChecks: {
    "fixture-check": {
      validateParams(value: unknown): JsonObject {
        assert.deepEqual(value, { expected: true });
        return { expected: true };
      },
    },
  },
};

function makeTask(id = "lifecycle-task"): OpsWorkerTask {
  return withOpsWorkerSubmissionFingerprint({
    schemaVersion: 4,
    id,
    source: {
      kind: "operator-cli",
      correlationKey: `fixture:${id}`,
      deliveryKey: `fixture:${id}`,
      template: "fixture-task",
    },
    resource: { kind: "repository", key: "github:example/minime-bot" },
    lifecycle: createEmptyOpsWorkerLifecycleManifest(),
    currentCheckpoint: null,
    mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
    custody: createUnclaimedOpsWorkerCustody(),
    priority: 10,
    objective: "Exercise package-owned lifecycle evidence",
    evidence: [],
    doneCheck: { name: "fixture-check", params: { expected: true } },
    authorization: {
      profile: "fixture.mutate.v1",
      scope: ["pull-request", "release", "deploy", "issue-lifecycle"],
      snapshotHash: null,
    },
    authorizationVerification: null,
    verification: null,
    legacyCompletion: null,
    state: "QUEUED",
    rounds: {
      remediation: 0,
      maxRemediation: 3,
      consecutiveInfrastructureFailures: 0,
    },
    schedule: { nextRunAt: null, nextCheckAt: null },
    session: { directory: `sessions/${id}`, sessionId: null, resume: false },
    activeRun: null,
    unverifiedRun: null,
    lastOutcome: null,
    report: { state: "NONE", attempts: 0, lastError: null },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function attachProductFailureVerification(task: OpsWorkerTask): void {
  const contractHash = `sha256:${"8".repeat(64)}`;
  task.state = "RESUMABLE";
  task.custody = {
    status: "HELD",
    claimedAt: NOW,
    releasedAt: null,
    releaseReason: null,
  };
  task.lifecycle.verifier = "fixture-verifier";
  task.lifecycle.verifierVersion = "1";
  task.lifecycle.verifierContractHash = contractHash;
  task.verification = {
    verifierIdentity: "fixture-verifier",
    verifierVersion: "1",
    contractHash,
    subjectHash: hashOpsWorkerVerificationSubject(task),
    checkedAt: NOW,
    completedAt: NOW,
    outcome: "PRODUCT_FAILURE",
    summary: "The fixture still requires product remediation.",
    nextCheckAt: null,
    components: [{
      identity: "fixture-component",
      version: "1",
      required: true,
      convergence: "PRODUCT",
      outcome: "PRODUCT_FAILURE",
      observedAt: NOW,
      evidenceHash: `sha256:${"7".repeat(64)}`,
      summary: "The fixture product evidence failed.",
      nextCheckAt: null,
    }],
  };
}

function makeHarness(t: TestContext): {
  directory: string;
  store: OpsWorkerTaskStore;
  lifecycle: OpsWorkerLifecycle;
  setNow(value: string): void;
} {
  const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-lifecycle-"));
  let currentNow = NOW;
  const store = new OpsWorkerTaskStore(directory, {
    registry,
    now: () => new Date(currentNow),
  });
  const lifecycle = new OpsWorkerLifecycle(store, {
    now: () => new Date(currentNow),
    authorizeMutationClaim: () => true,
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    store,
    lifecycle,
    setNow(value): void {
      currentNow = value;
    },
  };
}

describe("ops worker package-owned lifecycle evidence", () => {
  it("invalidates composite evidence across non-report lifecycle receipt changes", (t) => {
    const identityHarness = makeHarness(t);
    const identityTask = makeTask("verified-lifecycle-identity");
    attachProductFailureVerification(identityTask);
    identityHarness.store.create(identityTask);
    const identity = identityHarness.lifecycle.updateLifecycleIdentity(identityTask.id, {
      repository: "repository:example/minime-bot",
    });
    assert.equal(identity.verification, null);

    const queryHarness = makeHarness(t);
    const queryTask = makeTask("verified-receipt-query");
    attachProductFailureVerification(queryTask);
    queryHarness.store.create(queryTask);
    const queried = queryHarness.lifecycle.beginMutationReceipt(queryTask.id, {
      boundary: "merge",
      operationId: "merge-query",
      intent: { base: "main", head: "issue-58" },
      queryObservedAt: NOW,
      queryResult: { merged: false },
    });
    assert.equal(queried.verification, null);

    const claimHarness = makeHarness(t);
    const claimIntent = { base: "main", head: "claim-review" };
    const claimTask = makeTask("verified-receipt-claim");
    claimTask.mutationReceipts.merge = {
      boundary: "merge",
      operationId: "merge-claim",
      intentHash: hashOpsWorkerCanonicalPayload(claimIntent),
      queryObservedAt: NOW,
      queryResultHash: hashOpsWorkerCanonicalPayload({ merged: false }),
      mutationStartedAt: null,
      outcome: null,
      replayHistory: [],
    };
    attachProductFailureVerification(claimTask);
    claimHarness.store.create(claimTask);
    const claimed = claimHarness.lifecycle.claimMutationReceipt(claimTask.id, {
      boundary: "merge",
      operationId: "merge-claim",
      intent: claimIntent,
    });
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.task.verification, null);

    const finishHarness = makeHarness(t);
    const finishIntent = { environment: "fixture" };
    const finishTask = makeTask("verified-receipt-finish");
    finishTask.mutationReceipts.deploy = {
      boundary: "deploy",
      operationId: "deploy-finish",
      intentHash: hashOpsWorkerCanonicalPayload(finishIntent),
      queryObservedAt: NOW,
      queryResultHash: hashOpsWorkerCanonicalPayload({ deployed: false }),
      mutationStartedAt: NOW,
      outcome: null,
      replayHistory: [],
    };
    attachProductFailureVerification(finishTask);
    finishHarness.store.create(finishTask);
    const finished = finishHarness.lifecycle.finishMutationReceipt(finishTask.id, {
      boundary: "deploy",
      operationId: "deploy-finish",
      intent: finishIntent,
      result: "APPLIED",
      evidence: { deployment: "fixture-deployment" },
    });
    assert.equal(finished.verification, null);
    assert.equal(finished.mutationReceipts.deploy?.outcome?.result, "APPLIED");
  });

  it("fails closed when a mutation claim has no injected authorization fence", (t) => {
    const harness = makeHarness(t);
    const task = makeTask("receipt-missing-authorization");
    harness.store.create(task);
    const lifecycle = new OpsWorkerLifecycle(harness.store, {
      now: () => new Date(NOW),
    });
    const operation = {
      boundary: "merge" as const,
      operationId: "merge-missing-authorization",
      intent: { base: "main", head: "issue-58" },
    };
    lifecycle.beginMutationReceipt(task.id, {
      ...operation,
      queryObservedAt: NOW,
      queryResult: { merged: false },
    });

    assert.throws(
      () => lifecycle.claimMutationReceipt(task.id, operation),
      /requires a fresh package-owned authorization PASS/,
    );
    assert.equal(
      harness.store.get(task.id)?.mutationReceipts.merge?.mutationStartedAt,
      null,
    );
  });

  it("requires the registered domain scope for each mutation boundary", (t) => {
    const harness = makeHarness(t);
    const base = makeTask("scope-fence");
    const task = withOpsWorkerSubmissionFingerprint({
      ...base,
      authorization: {
        profile: "fixture.inspect.v1",
        scope: ["inspect"],
        snapshotHash: null,
      },
    });
    harness.store.create(task);
    const operation = {
      boundary: "merge" as const,
      operationId: "scope-fence-merge",
      intent: { base: "main", head: "scope-fence" },
    };
    harness.lifecycle.beginMutationReceipt(task.id, {
      ...operation,
      queryObservedAt: NOW,
      queryResult: { merged: false },
    });
    assert.throws(
      () => harness.lifecycle.claimMutationReceipt(task.id, operation),
      /outside the task's registered authorization scopes/,
    );
  });

  it("records one checkpoint and makes identical canonical replay a true no-op", (t) => {
    const harness = makeHarness(t);
    const task = makeTask();
    harness.store.create(task);

    const first = harness.lifecycle.recordCheckpoint(task.id, {
      checkpointId: "checkpoint-01",
      payload: { nested: { b: 2, a: 1 }, complete: false },
      summary: "Repository inspection is complete.",
      artifact: "artifacts/checkpoint-01.json",
      lifecycle: {
        repository: "github:example/minime-bot",
        branch: "refs/heads/issue-58",
      },
    });
    assert.equal(first.currentCheckpoint?.recordedAt, NOW);
    assert.equal(first.lifecycle.repository, "github:example/minime-bot");
    const snapshotPath = join(harness.store.tasksDirectory, `${task.id}.json`);
    const snapshotBeforeReplay = readFileSync(snapshotPath, "utf8");
    const journalBeforeReplay = readFileSync(harness.store.journalPath, "utf8");

    harness.setNow(LATER);
    const replay = harness.lifecycle.recordCheckpoint(task.id, {
      checkpointId: "checkpoint-01",
      payload: { complete: false, nested: { a: 1, b: 2 } },
      summary: "Repository inspection is complete.",
      artifact: "artifacts/checkpoint-01.json",
      lifecycle: {
        branch: "refs/heads/issue-58",
        repository: "github:example/minime-bot",
      },
    });

    assert.deepEqual(replay, first);
    assert.equal(readFileSync(snapshotPath, "utf8"), snapshotBeforeReplay);
    assert.equal(readFileSync(harness.store.journalPath, "utf8"), journalBeforeReplay);
    assert.equal(
      hashOpsWorkerCanonicalPayload({ b: [2, 1], a: true }),
      hashOpsWorkerCanonicalPayload({ a: true, b: [2, 1] }),
    );
  });

  it("fails closed on conflicting checkpoint reuse and unsafe identity evidence", (t) => {
    const harness = makeHarness(t);
    const task = makeTask("checkpoint-conflict");
    harness.store.create(task);
    harness.lifecycle.recordCheckpoint(task.id, {
      checkpointId: "checkpoint-stable",
      payload: { phase: 1 },
      summary: "First canonical payload.",
    });

    assert.throws(
      () => harness.lifecycle.recordCheckpoint(task.id, {
        checkpointId: "checkpoint-stable",
        payload: { phase: 2 },
        summary: "First canonical payload.",
      }),
      /checkpoint-stable.*different canonical payload/i,
    );
    assert.throws(
      () => harness.lifecycle.updateLifecycleIdentity(task.id, {
        arbitraryPhase: "command:run",
      } as never),
      /unknown lifecycle identity slot arbitraryPhase/,
    );
    assert.throws(
      () => harness.lifecycle.recordCheckpoint(task.id, {
        checkpointId: "checkpoint-verifier-poison",
        payload: { phase: "verify" },
        summary: "Untrusted checkpoint must not pin a verifier contract.",
        lifecycle: {
          verifier: "payload-selected-verifier",
          verifierVersion: "99",
          verifierContractHash: `sha256:${"f".repeat(64)}`,
        } as never,
      }),
      /unknown lifecycle identity slot verifier/,
    );
    assert.throws(
      () => harness.lifecycle.updateLifecycleIdentity(task.id, {
        repository: "https://example.invalid/repository",
      }),
      /not a URL or executable payload/,
    );
    assert.throws(
      () => harness.lifecycle.updateLifecycleIdentity(task.id, {
        repository: `repository:${"x".repeat(513)}`,
      }),
      /must be at most 512 UTF-8 bytes/,
    );
    assert.throws(
      () => hashOpsWorkerCanonicalPayload({ evidence: "x".repeat(20_000) }),
      /canonical payload must be at most/,
    );
    const sparse = new Array<unknown>(1);
    assert.throws(
      () => hashOpsWorkerCanonicalPayload(sparse),
      /arrays must be dense/,
    );
    const oversizedSparse = new Array<unknown>(257);
    assert.throws(
      () => hashOpsWorkerCanonicalPayload(oversizedSparse),
      /arrays must contain at most 256 items/,
    );
  });

  it("keeps displaced checkpoint ids replay-safe without rolling progress back", (t) => {
    const harness = makeHarness(t);
    const task = makeTask("checkpoint-history");
    harness.store.create(task);
    const checkpointA = {
      checkpointId: "checkpoint-a",
      payload: { phase: "inspect" },
      summary: "Inspection finished.",
    };
    const recordedCheckpointA = harness.lifecycle.recordCheckpoint(task.id, checkpointA);
    harness.setNow(LATER);
    const checkpointB = harness.lifecycle.recordCheckpoint(task.id, {
      checkpointId: "checkpoint-b",
      payload: { phase: "verify" },
      summary: "Verification finished.",
    });
    assert.equal(checkpointB.currentCheckpoint?.checkpointId, "checkpoint-b");
    assert.deepEqual(
      checkpointB.currentCheckpoint?.replayHistory.map((entry) => entry.checkpointId),
      ["checkpoint-a"],
    );
    const snapshotPath = join(harness.store.tasksDirectory, `${task.id}.json`);
    const snapshotBeforeReplay = readFileSync(snapshotPath, "utf8");
    const journalBeforeReplay = readFileSync(harness.store.journalPath, "utf8");

    const replay = harness.lifecycle.recordCheckpoint(task.id, checkpointA);
    assert.deepEqual(replay, checkpointB);
    assert.equal(replay.currentCheckpoint?.checkpointId, "checkpoint-b");
    assert.equal(readFileSync(snapshotPath, "utf8"), snapshotBeforeReplay);
    assert.equal(readFileSync(harness.store.journalPath, "utf8"), journalBeforeReplay);
    assert.throws(
      () => harness.lifecycle.recordCheckpoint(task.id, {
        ...checkpointA,
        payload: { phase: "conflicting-replay" },
      }),
      /checkpoint-a.*different canonical payload/i,
    );
    const erasedHistory = structuredClone(checkpointB);
    assert.ok(erasedHistory.currentCheckpoint);
    erasedHistory.currentCheckpoint.replayHistory = [];
    assert.throws(
      () => harness.store.replace(erasedHistory),
      /refusing to forget or change checkpoint replay identity checkpoint-a/i,
    );

    assert.ok(recordedCheckpointA.currentCheckpoint);
    assert.ok(checkpointB.currentCheckpoint);
    const rolledBack = structuredClone(checkpointB);
    rolledBack.currentCheckpoint = {
      ...structuredClone(recordedCheckpointA.currentCheckpoint),
      replayHistory: [{
        checkpointId: checkpointB.currentCheckpoint.checkpointId,
        contentHash: hashOpsWorkerCanonicalPayload({
          payloadHash: checkpointB.currentCheckpoint.payloadHash,
          summary: checkpointB.currentCheckpoint.summary,
          artifact: checkpointB.currentCheckpoint.artifact,
        }),
      }],
    };
    assert.throws(
      () => harness.store.replace(rolledBack),
      /refusing to restore historical checkpoint checkpoint-a/i,
    );
    assert.throws(
      () => harness.store.mutate(task.id, { event: "UPDATED" }, (working) => {
        working.currentCheckpoint = structuredClone(rolledBack.currentCheckpoint);
      }),
      /refusing to restore historical checkpoint checkpoint-a/i,
    );
    assert.deepEqual(harness.store.get(task.id), checkpointB);
  });

  it("requires a fresh query before a crashed mutation can be claimed again", (t) => {
    const harness = makeHarness(t);
    const task = makeTask("receipt-reconcile");
    harness.store.create(task);
    const operation = {
      boundary: "merge" as const,
      operationId: "merge-issue-58",
      intent: { base: "main", head: "issue-58" },
    };

    harness.lifecycle.beginMutationReceipt(task.id, {
      ...operation,
      queryObservedAt: NOW,
      queryResult: { merged: false },
    });
    const journalBeforeQueryReplay = readFileSync(harness.store.journalPath, "utf8");
    harness.lifecycle.beginMutationReceipt(task.id, {
      ...operation,
      intent: { head: "issue-58", base: "main" },
      queryObservedAt: NOW,
      queryResult: { merged: false },
    });
    assert.equal(
      readFileSync(harness.store.journalPath, "utf8"),
      journalBeforeQueryReplay,
    );
    assert.throws(
      () => harness.lifecycle.beginMutationReceipt(task.id, {
        ...operation,
        queryObservedAt: NOW,
        queryResult: { merged: true },
      }),
      /query observation was reused with different evidence/,
    );
    const claimed = harness.lifecycle.claimMutationReceipt(task.id, operation);
    assert.equal(claimed.claimed, true);
    assert.equal(claimed.task.mutationReceipts.merge?.outcome, null);
    assert.equal(
      harness.lifecycle.claimMutationReceipt(task.id, operation).claimed,
      false,
      "a repeated claim cannot authorize another mutation",
    );
    assert.throws(
      () => harness.lifecycle.beginMutationReceipt(task.id, {
        ...operation,
        queryObservedAt: NOW,
        queryResult: { merged: false },
      }),
      /fresh query observation.*unfinished merge/i,
    );

    harness.setNow(LATER);
    harness.lifecycle.beginMutationReceipt(task.id, {
      ...operation,
      queryObservedAt: LATER,
      queryResult: { merged: true, mergeCommit: "abc123" },
    });
    const reconciled = harness.lifecycle.finishMutationReceipt(task.id, {
      ...operation,
      result: "ALREADY_APPLIED",
      evidence: { merged: true, mergeCommit: "abc123" },
      lifecycle: { merge: "commit:abc123" },
    });
    assert.equal(reconciled.mutationReceipts.merge?.mutationStartedAt, null);
    assert.equal(reconciled.mutationReceipts.merge?.outcome?.result, "ALREADY_APPLIED");
    assert.equal(reconciled.lifecycle.merge, "commit:abc123");
  });

  it("rejects a stale replace that would erase a durable mutation claim", (t) => {
    const harness = makeHarness(t);
    const task = makeTask("receipt-stale-replace");
    harness.store.create(task);
    const operation = {
      boundary: "merge" as const,
      operationId: "merge-stale-replace",
      intent: { base: "main", head: "issue-58" },
    };
    harness.lifecycle.beginMutationReceipt(task.id, {
      ...operation,
      queryObservedAt: NOW,
      queryResult: { merged: false },
    });
    const staleQueryOnly = harness.store.get(task.id);
    assert.ok(staleQueryOnly);
    assert.equal(
      harness.lifecycle.claimMutationReceipt(task.id, operation).claimed,
      true,
    );

    assert.throws(
      () => harness.store.replace(staleQueryOnly),
      /erase claimed merge operation.*strictly newer unfinished query/,
    );
    assert.equal(
      harness.lifecycle.claimMutationReceipt(task.id, operation).claimed,
      false,
      "the durable claim must remain authoritative after the stale replace",
    );
  });

  it("accepts only fixed boundaries and matching operation intent and outcome evidence", (t) => {
    const harness = makeHarness(t);
    const task = makeTask("receipt-fixed");
    harness.store.create(task);
    const operation = {
      boundary: "deploy" as const,
      operationId: "deploy-release-01",
      intent: { release: "release-01", environment: "fixture" },
    };
    assert.throws(
      () => harness.lifecycle.claimMutationReceipt(task.id, operation),
      /requires a query observation/,
    );
    assert.throws(
      () => harness.lifecycle.finishMutationReceipt(task.id, {
        ...operation,
        result: "NOT_NEEDED",
        evidence: { reason: "not queried" },
      }),
      /requires a prior query observation/,
    );
    harness.lifecycle.beginMutationReceipt(task.id, {
      ...operation,
      queryObservedAt: NOW,
      queryResult: { deployed: false },
    });
    assert.throws(
      () => harness.lifecycle.finishMutationReceipt(task.id, {
        ...operation,
        result: "APPLIED",
        evidence: { deploymentId: "deploy-01" },
      }),
      /APPLIED outcome requires a durable mutation claim/,
    );
    harness.lifecycle.claimMutationReceipt(task.id, operation);
    const finished = harness.lifecycle.finishMutationReceipt(task.id, {
      ...operation,
      result: "APPLIED",
      evidence: { deploymentId: "deploy-01" },
      lifecycle: { deploy: "deployment:deploy-01" },
    });
    const journalBeforeReplay = readFileSync(harness.store.journalPath, "utf8");
    const replay = harness.lifecycle.finishMutationReceipt(task.id, {
      ...operation,
      result: "APPLIED",
      evidence: { deploymentId: "deploy-01" },
      lifecycle: { deploy: "deployment:deploy-01" },
    });
    assert.deepEqual(replay, finished);
    assert.equal(readFileSync(harness.store.journalPath, "utf8"), journalBeforeReplay);

    assert.throws(
      () => harness.lifecycle.finishMutationReceipt(task.id, {
        ...operation,
        intent: { release: "different-release" },
        result: "APPLIED",
        evidence: { deploymentId: "deploy-01" },
      }),
      /different intent/i,
    );
    assert.throws(
      () => harness.lifecycle.finishMutationReceipt(task.id, {
        ...operation,
        result: "APPLIED",
        evidence: { deploymentId: "deploy-conflict" },
      }),
      /outcome was reused with different evidence/,
    );
    assert.throws(
      () => harness.lifecycle.finishMutationReceipt(task.id, {
        ...operation,
        result: "ALREADY_APPLIED",
        evidence: { deploymentId: "deploy-01" },
      }),
      /outcome was reused with different evidence/,
    );
    assert.throws(
      () => harness.lifecycle.beginMutationReceipt(task.id, {
        boundary: "publish" as never,
        operationId: "publish-01",
        intent: {},
        queryObservedAt: LATER,
        queryResult: {},
      }),
      /unsupported mutation boundary publish/,
    );

    for (const boundary of [
      "merge",
      "tag-release",
      "canonical-task",
      "report",
    ] as const) {
      const boundaryTask = makeTask(`fixed-${boundary.replaceAll("-", "")}`);
      harness.store.create(boundaryTask);
      const recorded = harness.lifecycle.beginMutationReceipt(boundaryTask.id, {
        boundary,
        operationId: `${boundary}-01`,
        intent: { boundary },
        queryObservedAt: LATER,
        queryResult: { present: false },
      });
      assert.equal(
        Object.values(recorded.mutationReceipts).find((receipt) =>
          receipt?.boundary === boundary)?.boundary,
        boundary,
      );
    }
  });

  it("keeps displaced completed receipts permanently unclaimable", (t) => {
    const harness = makeHarness(t);
    const task = makeTask("receipt-history");
    harness.store.create(task);
    const operationA = {
      boundary: "deploy" as const,
      operationId: "deploy-a",
      intent: { release: "release-a" },
    };
    harness.lifecycle.beginMutationReceipt(task.id, {
      ...operationA,
      queryObservedAt: NOW,
      queryResult: { deployed: false },
    });
    harness.lifecycle.claimMutationReceipt(task.id, operationA);
    harness.lifecycle.finishMutationReceipt(task.id, {
      ...operationA,
      result: "APPLIED",
      evidence: { deployment: "deployment-a" },
    });

    harness.setNow(LATER);
    const operationB = {
      boundary: "deploy" as const,
      operationId: "deploy-b",
      intent: { release: "release-b" },
    };
    harness.lifecycle.beginMutationReceipt(task.id, {
      ...operationB,
      queryObservedAt: LATER,
      queryResult: { deployed: false },
    });
    harness.lifecycle.claimMutationReceipt(task.id, operationB);
    const completedB = harness.lifecycle.finishMutationReceipt(task.id, {
      ...operationB,
      result: "APPLIED",
      evidence: { deployment: "deployment-b" },
    });
    assert.equal(completedB.mutationReceipts.deploy?.operationId, "deploy-b");
    assert.deepEqual(
      completedB.mutationReceipts.deploy?.replayHistory.map((entry) => entry.operationId),
      ["deploy-a"],
    );
    const snapshotPath = join(harness.store.tasksDirectory, `${task.id}.json`);
    const snapshotBeforeReplay = readFileSync(snapshotPath, "utf8");
    const journalBeforeReplay = readFileSync(harness.store.journalPath, "utf8");

    const queryReplay = harness.lifecycle.beginMutationReceipt(task.id, {
      ...operationA,
      queryObservedAt: LATER,
      queryResult: { deployed: false },
    });
    assert.deepEqual(queryReplay, completedB);
    assert.equal(
      harness.lifecycle.claimMutationReceipt(task.id, operationA).claimed,
      false,
    );
    assert.deepEqual(
      harness.lifecycle.finishMutationReceipt(task.id, {
        ...operationA,
        result: "APPLIED",
        evidence: { deployment: "deployment-a" },
      }),
      completedB,
    );
    assert.equal(readFileSync(snapshotPath, "utf8"), snapshotBeforeReplay);
    assert.equal(readFileSync(harness.store.journalPath, "utf8"), journalBeforeReplay);
    assert.throws(
      () => harness.lifecycle.beginMutationReceipt(task.id, {
        ...operationA,
        intent: { release: "conflicting-release" },
        queryObservedAt: LATER,
        queryResult: { deployed: false },
      }),
      /deploy-a.*different intent/i,
    );
    assert.throws(
      () => harness.lifecycle.finishMutationReceipt(task.id, {
        ...operationA,
        result: "APPLIED",
        evidence: { deployment: "conflicting-deployment" },
      }),
      /deploy-a.*different evidence/i,
    );
    const erasedHistory = structuredClone(completedB);
    assert.ok(erasedHistory.mutationReceipts.deploy);
    erasedHistory.mutationReceipts.deploy.replayHistory = [];
    assert.throws(
      () => harness.store.replace(erasedHistory),
      /refusing to forget or change completed deploy operation deploy-a/i,
    );
  });

  it("serializes concurrent helper updates and grants only one mutation claim", async (t) => {
    const harness = makeHarness(t);
    const task = makeTask("concurrent-lifecycle");
    harness.store.create(task);
    const readyPath = join(harness.directory, "first-ready");
    const releasePath = join(harness.directory, "release-first");
    const runFixture = (
      slot: "repository" | "branch" | "claim",
      value: string,
      barrier = false,
      targetTaskId = task.id,
    ): Promise<{ code: number | null; stderr: string; stdout: string }> => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        LIFECYCLE_UPDATE_FIXTURE,
        harness.directory,
        targetTaskId,
        slot,
        value,
        ...(barrier ? [readyPath, releasePath] : []),
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      return new Promise((resolve) => {
        child.once("close", (code) => resolve({ code, stderr, stdout }));
      });
    };

    const first = runFixture("repository", "github:example/minime-bot", true);
    let second: ReturnType<typeof runFixture> | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(readyPath)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle writer");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      second = runFixture("branch", "refs/heads/issue-58");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      writeFileSync(releasePath, "release\n", "utf8");
    }
    assert.ok(second);
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.code), [0, 0], JSON.stringify(results));
    const updated = harness.store.get(task.id);
    assert.equal(updated?.lifecycle.repository, "github:example/minime-bot");
    assert.equal(updated?.lifecycle.branch, "refs/heads/issue-58");

    rmSync(readyPath, { force: true });
    rmSync(releasePath, { force: true });
    const claimTask = makeTask("concurrent-claim");
    harness.store.create(claimTask);
    harness.lifecycle.beginMutationReceipt(claimTask.id, {
      boundary: "merge",
      operationId: "merge-race",
      intent: { taskId: claimTask.id, action: "merge" },
      queryObservedAt: NOW,
      queryResult: { merged: false },
    });
    const claimResults = await Promise.all([
      runFixture("claim", "merge-race", false, claimTask.id),
      runFixture("claim", "merge-race", false, claimTask.id),
    ]);
    assert.deepEqual(
      claimResults.map((result) => result.code),
      [0, 0],
      JSON.stringify(claimResults),
    );
    const claims = claimResults
      .map((result) => (JSON.parse(result.stdout) as { claimed: boolean }).claimed)
      .sort();
    assert.deepEqual(
      claims,
      [false, true],
      JSON.stringify(claimResults),
    );
  });
});
