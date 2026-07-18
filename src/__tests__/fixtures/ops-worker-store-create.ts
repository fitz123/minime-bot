import { existsSync, writeFileSync } from "node:fs";
import { OpsWorkerTaskStore } from "../../ops-worker/task-store.js";
import type {
  JsonObject,
  OpsWorkerTask,
  OpsWorkerTaskContractRegistry,
} from "../../ops-worker/types.js";
import {
  createEmptyOpsWorkerLifecycleManifest,
  createEmptyOpsWorkerMutationReceipts,
  createUnclaimedOpsWorkerCustody,
  withOpsWorkerSubmissionFingerprint,
} from "../../ops-worker/types.js";

const [operation, stateDirectory, taskId, correlationKey, readyPath, releasePath] =
  process.argv.slice(2);
if (
  (operation !== "create" && operation !== "mutate")
  || !stateDirectory
  || !taskId
  || !correlationKey
) {
  throw new Error(
    "store fixture requires create|mutate, state directory, task id, and correlation key",
  );
}

const registry: OpsWorkerTaskContractRegistry = {
  templates: { "operator-health": { sourceKinds: ["operator-cli"] } },
  authorizationProfiles: {
    "operator.inspect.v1": {
      sourceKinds: ["operator-cli"],
      scope: ["inspect"],
      tools: ["read", "grep", "find", "ls"],
    },
  },
  doneChecks: {
    "fixture-health": {
      validateParams(value: unknown): JsonObject {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new TypeError("fixture params must be an object");
        }
        const params = value as Record<string, unknown>;
        if (
          Object.keys(params).length !== 1
          || !Number.isSafeInteger(params.sampleCount)
        ) {
          throw new TypeError("fixture sampleCount must be an integer");
        }
        return { sampleCount: params.sampleCount as number };
      },
    },
    "lax-fixture": {
      validateParams(value: unknown): JsonObject {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new TypeError("fixture params must be an object");
        }
        return {};
      },
    },
  },
};

const now = "2026-07-17T12:00:00.000Z";
const task: OpsWorkerTask = withOpsWorkerSubmissionFingerprint({
  schemaVersion: 3,
  id: taskId,
  source: {
    kind: "operator-cli",
    correlationKey,
    deliveryKey: `fixture:${taskId}`,
    template: "operator-health",
  },
  resource: { kind: "host", key: "host:local" },
  lifecycle: createEmptyOpsWorkerLifecycleManifest(),
  currentCheckpoint: null,
  mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
  custody: createUnclaimedOpsWorkerCustody(),
  priority: 10,
  objective: "Exercise serialized correlation creation",
  evidence: [],
  doneCheck: { name: "lax-fixture", params: {} },
  authorization: {
    profile: "operator.inspect.v1",
    scope: ["inspect"],
    snapshotHash: null,
  },
  authorizationVerification: null,
  state: "QUEUED",
  rounds: {
    remediation: 0,
    maxRemediation: 3,
    consecutiveInfrastructureFailures: 0,
  },
  schedule: { nextRunAt: null, nextCheckAt: null },
  session: { directory: `sessions/${taskId}`, sessionId: null, resume: false },
  activeRun: null,
  unverifiedRun: null,
  lastOutcome: null,
  report: { state: "NONE", attempts: 0, lastError: null },
  createdAt: now,
  updatedAt: now,
});

try {
  const store = new OpsWorkerTaskStore(stateDirectory, {
    registry,
    faultInjector: readyPath && releasePath
      ? (point) => {
        if (point !== "after-correlation-check") return;
        writeFileSync(readyPath, "ready\n", "utf8");
        const waiter = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 15_000;
        while (!existsSync(releasePath)) {
          if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for store-create fixture release");
          }
          Atomics.wait(waiter, 0, 0, 10);
        }
      }
      : undefined,
  });
  if (operation === "create") {
    store.create(task);
    process.stdout.write(`${taskId}\n`);
  } else {
    const result = store.mutate(
      taskId,
      { event: "UPDATED", summary: "Concurrent fixture mutation" },
      (current) => {
        current.rounds.remediation += 1;
      },
    );
    process.stdout.write(`${result.task.rounds.remediation}\n`);
  }
} catch (error) {
  process.stderr.write(`${(error as Error).name}: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
