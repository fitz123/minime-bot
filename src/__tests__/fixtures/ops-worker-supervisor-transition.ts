import { existsSync, writeFileSync } from "node:fs";
import {
  OpsWorkerDoneCheckRegistry,
} from "../../ops-worker/done-checks.js";
import { OpsWorkerSupervisor } from "../../ops-worker/supervisor.js";
import { OpsWorkerTaskStore } from "../../ops-worker/task-store.js";
import type {
  JsonObject,
  OpsWorkerTaskContractRegistry,
} from "../../ops-worker/types.js";

const [stateDirectory, taskId, readyPath, releasePath] = process.argv.slice(2);
if (!stateDirectory || !taskId || !readyPath || !releasePath) {
  throw new Error(
    "supervisor transition fixture requires state directory, task id, ready path, and release path",
  );
}

const doneChecks = new OpsWorkerDoneCheckRegistry({
  "fixture-check": {
    timeoutMs: 500,
    validateParams(value: unknown): JsonObject {
      if (JSON.stringify(value) === JSON.stringify({ expected: true })) {
        return { expected: true };
      }
      if (JSON.stringify(value) === JSON.stringify({ sampleCount: 1 })) {
        return { sampleCount: 1 };
      }
      throw new TypeError("fixture params must be canonical");
    },
    run: () => ({ result: "PASS", summary: "Fixture passed." }),
  },
});

const registry: OpsWorkerTaskContractRegistry = {
  templates: { "fixture-task": { sourceKinds: ["operator-cli"] } },
  authorizationProfiles: {
    "fixture.inspect.v1": {
      sourceKinds: ["operator-cli"],
      scope: ["inspect"],
      tools: ["read", "grep", "find", "ls"],
    },
  },
  doneChecks: doneChecks.contracts,
};

function waitAtInterleavingBoundary(): void {
  writeFileSync(readyPath, "ready\n", "utf8");
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 15_000;
  while (!existsSync(releasePath)) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for supervisor transition release");
    }
    Atomics.wait(waiter, 0, 0, 10);
  }
}

const store = new OpsWorkerTaskStore(stateDirectory, { registry });
const supervisor = new OpsWorkerSupervisor({
  store,
  doneChecks,
  instanceId: "transition-fixture-supervisor",
  processStartToken: "transition-fixture-supervisor-start",
});

try {
  await supervisor.start();
  const replace = store.replace.bind(store);
  store.replace = ((value, audit) => {
    waitAtInterleavingBoundary();
    return replace(value, audit);
  }) as OpsWorkerTaskStore["replace"];
  const mutate = store.mutate.bind(store);
  store.mutate = ((id, audit, callback) => mutate(id, audit, (task) => {
    const returned = callback(task);
    waitAtInterleavingBoundary();
    return returned;
  })) as OpsWorkerTaskStore["mutate"];

  supervisor.preparePiSession(taskId, "session-after-interleaving", false);
} catch (error) {
  process.stderr.write(`${(error as Error).name}: ${(error as Error).message}\n`);
  process.exitCode = 1;
} finally {
  supervisor.close();
}
