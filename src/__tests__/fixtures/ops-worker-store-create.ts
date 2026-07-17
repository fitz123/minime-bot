import { existsSync, writeFileSync } from "node:fs";
import { OpsWorkerTaskStore } from "../../ops-worker/task-store.js";
import type {
  JsonObject,
  OpsWorkerTask,
  OpsWorkerTaskContractRegistry,
} from "../../ops-worker/types.js";

const [stateDirectory, taskId, correlationKey, readyPath, releasePath] =
  process.argv.slice(2);
if (!stateDirectory || !taskId || !correlationKey) {
  throw new Error("store-create fixture requires state directory, task id, and correlation key");
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
const task: OpsWorkerTask = {
  schemaVersion: 1,
  id: taskId,
  source: { kind: "operator-cli", correlationKey, template: "operator-health" },
  priority: 10,
  objective: "Exercise serialized correlation creation",
  evidence: [],
  doneCheck: { name: "lax-fixture", params: {} },
  authorization: {
    profile: "operator.inspect.v1",
    scope: ["inspect"],
    snapshotHash: null,
  },
  state: "QUEUED",
  rounds: {
    remediation: 0,
    maxRemediation: 3,
    consecutiveInfrastructureFailures: 0,
  },
  schedule: { nextRunAt: null, nextCheckAt: null },
  session: { directory: `sessions/${taskId}`, sessionId: null, resume: false },
  activeRun: null,
  lastOutcome: null,
  report: { state: "NONE", attempts: 0, lastError: null },
  createdAt: now,
  updatedAt: now,
};

try {
  const store = new OpsWorkerTaskStore(stateDirectory, {
    registry,
    faultInjector: readyPath && releasePath
      ? (point) => {
        if (point !== "after-correlation-check") return;
        writeFileSync(readyPath, "ready\n", "utf8");
        const waiter = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 10);
      }
      : undefined,
  });
  store.create(task);
  process.stdout.write(`${taskId}\n`);
} catch (error) {
  process.stderr.write(`${(error as Error).name}: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
