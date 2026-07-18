import { existsSync, writeFileSync } from "node:fs";
import { OpsWorkerLifecycle } from "../../ops-worker/lifecycle.js";
import { OpsWorkerTaskStore } from "../../ops-worker/task-store.js";
import type {
  JsonObject,
  OpsWorkerTaskContractRegistry,
} from "../../ops-worker/types.js";

const [stateDirectory, taskId, slot, value, readyPath, releasePath] =
  process.argv.slice(2);
if (
  !stateDirectory
  || !taskId
  || (slot !== "repository" && slot !== "branch")
  || !value
) {
  throw new Error(
    "lifecycle fixture requires state directory, task id, repository|branch, and value",
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
        if (JSON.stringify(input) !== JSON.stringify({ expected: true })) {
          throw new TypeError("fixture params must be canonical");
        }
        return { expected: true };
      },
    },
  },
};

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
            throw new Error("Timed out waiting for lifecycle fixture release");
          }
          Atomics.wait(waiter, 0, 0, 10);
        }
      }
      : undefined,
  });
  new OpsWorkerLifecycle(store).updateLifecycleIdentity(taskId, {
    [slot]: value,
  });
} catch (error) {
  process.stderr.write(`${(error as Error).name}: ${(error as Error).message}\n`);
  process.exitCode = 1;
}
