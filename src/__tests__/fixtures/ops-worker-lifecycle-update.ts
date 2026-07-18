import { existsSync, writeFileSync } from "node:fs";
import { OpsWorkerLifecycle } from "../../ops-worker/lifecycle.js";
import {
  OpsWorkerTaskStore,
  OpsWorkerTaskStoreBusyError,
} from "../../ops-worker/task-store.js";
import type {
  JsonObject,
  OpsWorkerTaskContractRegistry,
} from "../../ops-worker/types.js";

const [
  stateDirectory,
  taskId,
  action,
  value,
  readyPath,
  releasePath,
  startedPath,
  completedPath,
] =
  process.argv.slice(2);
if (
  !stateDirectory
  || !taskId
  || (action !== "repository" && action !== "branch" && action !== "claim")
  || !value
) {
  throw new Error(
    "lifecycle fixture requires state directory, task id, repository|branch|claim, and value",
  );
}

const registry: OpsWorkerTaskContractRegistry = {
  templates: { "fixture-task": { sourceKinds: ["operator-cli"] } },
  authorizationProfiles: {
    "fixture.inspect.v1": {
      sourceKinds: ["operator-cli"],
      scope: ["inspect"],
      tools: ["read", "grep", "find", "ls"],
    },
  },
  doneChecks: {
    "fixture-check": {
      validateParams(input: unknown): JsonObject {
        if (JSON.stringify(input) === JSON.stringify({ expected: true })) {
          return { expected: true };
        }
        if (JSON.stringify(input) === JSON.stringify({ sampleCount: 1 })) {
          return { sampleCount: 1 };
        }
        throw new TypeError("fixture params must be canonical");
      },
    },
  },
};

try {
  if (startedPath) writeFileSync(startedPath, "started\n", "utf8");
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
            throw new Error("Timed out waiting for lifecycle fixture release");
          }
          Atomics.wait(waiter, 0, 0, 10);
        }
      }
      : undefined,
  });
  const lifecycle = new OpsWorkerLifecycle(store, {
    authorizeMutationClaim: () => true,
  });
  if (action === "claim") {
    let result: ReturnType<OpsWorkerLifecycle["claimMutationReceipt"]> | undefined;
    const deadline = Date.now() + 15_000;
    while (result === undefined) {
      try {
        result = lifecycle.claimMutationReceipt(taskId, {
          boundary: "merge",
          operationId: value,
          intent: { taskId, action: "merge" },
        });
      } catch (error) {
        if (!(error instanceof OpsWorkerTaskStoreBusyError) || Date.now() >= deadline) {
          throw error;
        }
        const waiter = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(waiter, 0, 0, 10);
      }
    }
    process.stdout.write(`${JSON.stringify({ claimed: result.claimed })}\n`);
  } else {
    lifecycle.updateLifecycleIdentity(taskId, {
      [action]: value,
    });
  }
  if (completedPath) writeFileSync(completedPath, "completed\n", "utf8");
} catch (error) {
  process.stderr.write(`${(error as Error).name}: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
