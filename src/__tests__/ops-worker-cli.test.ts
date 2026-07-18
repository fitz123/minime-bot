import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { runCliAsync } from "../cli.js";
import {
  OpsWorkerDoneCheckRegistry,
} from "../ops-worker/done-checks.js";
import { OpsWorkerTaskStore } from "../ops-worker/task-store.js";
import type {
  JsonObject,
  OpsWorkerTaskContractRegistry,
} from "../ops-worker/types.js";
import type { OpsWorkerCliDependencies } from "../ops-worker/worker-cli.js";

const FAKE_PI_PROCESS = fileURLToPath(
  new URL("./fixtures/fake-pi-process.mjs", import.meta.url),
);

interface FixtureContracts {
  doneChecks: OpsWorkerDoneCheckRegistry;
  taskRegistry: OpsWorkerTaskContractRegistry;
}

function validateFixtureParams(value: unknown): JsonObject {
  assert.deepEqual(value, { expected: true });
  return { expected: true };
}

function fixtureContracts(): FixtureContracts {
  const doneChecks = new OpsWorkerDoneCheckRegistry({
    "fixture-check": {
      timeoutMs: 500,
      validateParams: validateFixtureParams,
      run: () => ({
        result: "PASS",
        summary: "Fixture state is deterministically complete.",
      }),
    },
  });
  return {
    doneChecks,
    taskRegistry: {
      templates: {
        "fixture-task": { sourceKinds: ["operator-cli"] },
      },
      authorizationProfiles: {
        "fixture.inspect.v1": {
          sourceKinds: ["operator-cli"],
          scope: ["inspect"],
          tools: ["read", "grep", "find", "ls"],
        },
      },
      doneChecks: doneChecks.contracts,
    },
  };
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runWorkerCli(
  args: readonly string[],
  cwd: string,
  dependencies?: OpsWorkerCliDependencies,
): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await runCliAsync(args, {
    cwd,
    env: {},
    workerDependencies: dependencies,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

function fixtureRoot(t: TestContext): {
  root: string;
  stateDirectory: string;
  workspace: string;
} {
  const root = mkdtempSync(join(tmpdir(), "minime-ops-worker-cli-"));
  const stateDirectory = join(root, "state");
  const workspace = join(root, "agent-workspace");
  mkdirSync(workspace, { mode: 0o700 });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, stateDirectory, workspace };
}

function dependencies(
  contracts: FixtureContracts,
  overrides: Partial<OpsWorkerCliDependencies> = {},
): OpsWorkerCliDependencies {
  return {
    taskRegistry: contracts.taskRegistry,
    doneChecks: contracts.doneChecks,
    processStartToken: "ops-worker-cli-fixture-start",
    randomId: () => "fixture-task-id",
    ...overrides,
  };
}

function submitArgs(stateDirectory: string): string[] {
  return [
    "worker",
    "submit",
    "--state-dir",
    stateDirectory,
    "--template",
    "fixture-task",
    "--authorization",
    "fixture.inspect.v1",
    "--done-check",
    "fixture-check",
    "--done-check-params",
    '{"expected":true}',
    "--correlation-key",
    "operator:fixture:one",
    "--objective",
    "Inspect the registered fixture state",
    "--json",
  ];
}

describe("ops worker CLI and inactive runtime", () => {
  it("advertises explicit worker commands without activating the worker", async (t) => {
    const fixture = fixtureRoot(t);
    const result = await runWorkerCli(["--help"], fixture.root);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /worker start --state-dir <path> --agent-workspace <path>/);
    assert.match(result.stdout, /worker submit --state-dir <path> --template <registered>/);
    assert.match(result.stdout, /inactive unless worker start is invoked/);
    assert.equal(result.stderr, "");
  });

  it("submits and inspects only tasks selected from trusted registries", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const deps = dependencies(contracts);

    const submitted = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
      deps,
    );
    assert.equal(submitted.code, 0, submitted.stderr);
    const task = JSON.parse(submitted.stdout) as {
      id: string;
      state: string;
      authorization: { scope: string[] };
    };
    assert.equal(task.id, "op-fixture-task-id");
    assert.equal(task.state, "QUEUED");
    assert.deepEqual(task.authorization.scope, ["inspect"]);

    const status = await runWorkerCli([
      "worker",
      "status",
      "--state-dir",
      fixture.stateDirectory,
      "--json",
    ], fixture.root, deps);
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(
      JSON.parse(status.stdout),
      {
        service: "minime-ops-worker",
        schemaVersion: 2,
        totalTasks: 1,
        activeProcessGroups: 0,
        states: {
          QUEUED: 1,
          RUNNING: 0,
          CHECKING: 0,
          RESUMABLE: 0,
          BLOCKED: 0,
          DONE: 0,
          CANCELLED: 0,
        },
      },
    );

    const inspected = await runWorkerCli([
      "worker",
      "inspect",
      "--state-dir",
      fixture.stateDirectory,
      "--id",
      task.id,
      "--json",
    ], fixture.root, deps);
    assert.equal(inspected.code, 0, inspected.stderr);
    assert.equal(JSON.parse(inspected.stdout).source.template, "fixture-task");

    const listed = await runWorkerCli([
      "worker",
      "list",
      "--state-dir",
      fixture.stateDirectory,
      "--json",
    ], fixture.root, deps);
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(JSON.parse(listed.stdout).length, 1);
  });

  it("rejects arbitrary command and URL parameter fields and unregistered selections", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const deps = dependencies(contracts);

    const commandField = await runWorkerCli([
      ...submitArgs(fixture.stateDirectory).slice(0, -1),
      "--command",
      "uname -a",
    ], fixture.root, deps);
    assert.equal(commandField.code, 2);
    assert.match(commandField.stderr, /unknown worker submit option: --command/);

    const urlParams = submitArgs(fixture.stateDirectory);
    const paramsIndex = urlParams.indexOf('{"expected":true}');
    urlParams[paramsIndex] = '{"url":"https://example.invalid"}';
    const urlField = await runWorkerCli(urlParams, fixture.root, deps);
    assert.equal(urlField.code, 2);
    assert.match(urlField.stderr, /cannot select commands, executables, URLs, or authorization/);

    const noProductionCheck = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
    );
    assert.equal(noProductionCheck.code, 2);
    assert.match(noProductionCheck.stderr, /authorization profile .* is not registered/);
  });

  it("cancels queued tasks and retries blocked tasks under the single-instance guard", async (t) => {
    const cancelledFixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const deps = dependencies(contracts);
    const submitted = await runWorkerCli(
      submitArgs(cancelledFixture.stateDirectory),
      cancelledFixture.root,
      deps,
    );
    const cancelledId = JSON.parse(submitted.stdout).id as string;
    const cancelled = await runWorkerCli([
      "worker",
      "cancel",
      "--state-dir",
      cancelledFixture.stateDirectory,
      "--id",
      cancelledId,
      "--reason",
      "Operator withdrew the fixture",
      "--json",
    ], cancelledFixture.root, deps);
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.equal(JSON.parse(cancelled.stdout).state, "CANCELLED");

    const retryFixture = fixtureRoot(t);
    const retrySubmitted = await runWorkerCli(
      submitArgs(retryFixture.stateDirectory),
      retryFixture.root,
      deps,
    );
    const retryId = JSON.parse(retrySubmitted.stdout).id as string;
    const store = new OpsWorkerTaskStore(retryFixture.stateDirectory, {
      registry: contracts.taskRegistry,
    });
    const blocked = store.get(retryId);
    assert.ok(blocked);
    blocked.state = "BLOCKED";
    blocked.rounds.remediation = blocked.rounds.maxRemediation;
    blocked.updatedAt = new Date(Date.parse(blocked.updatedAt) + 1).toISOString();
    blocked.lastOutcome = {
      at: blocked.updatedAt,
      kind: "DONE_CHECK",
      result: "ACTION_REQUIRED",
      summary: "Fixture exhausted its remediation budget",
    };
    blocked.report.state = "PENDING";
    store.replace(blocked);

    const retried = await runWorkerCli([
      "worker",
      "retry",
      "--state-dir",
      retryFixture.stateDirectory,
      "--id",
      retryId,
      "--json",
    ], retryFixture.root, deps);
    assert.equal(retried.code, 0, retried.stderr);
    const retriedTask = JSON.parse(retried.stdout);
    assert.equal(retriedTask.state, "RESUMABLE");
    assert.equal(retriedTask.rounds.remediation, 0);
  });

  it("takes a CLI task through a fake Pi claim and deterministic PASS", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const invocations: string[][] = [];
    const deps = dependencies(contracts, {
      piAttemptDependencies: {
        resolveInvocation: (args) => {
          invocations.push([...args]);
          return {
            command: process.execPath,
            args: [FAKE_PI_PROCESS, "success", ...args],
          };
        },
        buildEnv: () => Object.fromEntries(
          ["HOME", "PATH", "TMPDIR", "LANG"].flatMap((key) =>
            process.env[key] === undefined
              ? []
              : [[key, process.env[key] as string]]),
        ),
        assembleContext: () => null,
      },
    });
    const submitted = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
      deps,
    );
    const taskId = JSON.parse(submitted.stdout).id as string;

    const started = await runWorkerCli([
      "worker",
      "start",
      "--state-dir",
      fixture.stateDirectory,
      "--agent-workspace",
      fixture.workspace,
      "--port",
      "0",
      "--once",
    ], fixture.root, deps);
    assert.equal(started.code, 0, started.stderr);
    assert.match(started.stdout, new RegExp(`Processed ${taskId}: DONE`));
    assert.equal(invocations.length, 1);
    assert.ok(invocations[0].includes("--session-dir"));
    assert.ok(invocations[0].includes("--session-id"));
    assert.ok(!invocations[0].includes("--no-session"));

    const store = new OpsWorkerTaskStore(fixture.stateDirectory, {
      registry: contracts.taskRegistry,
    });
    const completed = store.get(taskId);
    assert.equal(completed?.state, "DONE");
    assert.equal(completed?.lastOutcome?.result, "PASS");
  });

  it("stops active Pi work before worker shutdown releases the supervisor", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const controller = new AbortController();
    const deps = dependencies(contracts, {
      abortSignal: controller.signal,
      schedulerPollMs: 20,
      piAttemptDependencies: {
        resolveInvocation: (args) => ({
          command: process.execPath,
          args: [FAKE_PI_PROCESS, "wait", ...args],
        }),
        buildEnv: () => Object.fromEntries(
          ["HOME", "PATH", "TMPDIR", "LANG"].flatMap((key) =>
            process.env[key] === undefined
              ? []
              : [[key, process.env[key] as string]]),
        ),
        assembleContext: () => null,
      },
    });
    const submitted = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
      deps,
    );
    const taskId = JSON.parse(submitted.stdout).id as string;
    const running = runWorkerCli([
      "worker",
      "start",
      "--state-dir",
      fixture.stateDirectory,
      "--agent-workspace",
      fixture.workspace,
      "--port",
      "0",
    ], fixture.root, deps);
    const store = new OpsWorkerTaskStore(fixture.stateDirectory, {
      registry: contracts.taskRegistry,
    });
    const deadline = Date.now() + 2_000;
    while (store.get(taskId)?.state !== "RUNNING") {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for active CLI attempt");
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
    const activeRun = store.get(taskId)?.activeRun;
    assert.ok(activeRun);

    controller.abort();
    const stopped = await running;

    assert.equal(stopped.code, 0, stopped.stderr);
    assert.equal(store.get(taskId)?.state, "RESUMABLE");
    assert.equal(store.get(taskId)?.activeRun, null);
    assert.throws(
      () => process.kill(-activeRun.processGroupId, 0),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH",
    );
  });

  it("rejects persistence and execution done-check registry drift", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const mismatched = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 500,
        validateParams: (value) => value as JsonObject,
        run: () => ({ result: "PASS", summary: "mismatched fixture" }),
      },
    });

    const result = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
      dependencies(contracts, { doneChecks: mismatched }),
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /registries must match exactly/);
  });

  it("serves loopback health/status only and exposes no HTTP task intake", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const controller = new AbortController();
    let stdout = "";
    let resolveListening: (() => void) | undefined;
    const listening = new Promise<void>((resolvePromise) => {
      resolveListening = resolvePromise;
    });
    const running = runCliAsync([
      "worker",
      "start",
      "--state-dir",
      fixture.stateDirectory,
      "--agent-workspace",
      fixture.workspace,
      "--port",
      "0",
    ], {
      cwd: fixture.root,
      env: {},
      workerDependencies: dependencies(contracts, {
        abortSignal: controller.signal,
        schedulerPollMs: 20,
      }),
      stdout: (text) => {
        stdout += text;
        if (text.includes("/status")) resolveListening?.();
      },
      stderr: (text) => {
        assert.fail(`worker start wrote stderr: ${text}`);
      },
    });
    t.after(() => controller.abort());
    await listening;
    const base = /status (http:\/\/[^/]+)\/status/.exec(stdout)?.[1];
    assert.ok(base);

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "minime-ops-worker",
      schemaVersion: 2,
    });
    const status = await fetch(`${base}/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).totalTasks, 0);

    const intake = await fetch(`${base}/submit`, {
      method: "POST",
      body: JSON.stringify({ command: "uname -a" }),
      headers: { "content-type": "application/json" },
    });
    assert.equal(intake.status, 404);
    const mutatingStatus = await fetch(`${base}/status`, { method: "POST" });
    assert.equal(mutatingStatus.status, 405);

    controller.abort();
    assert.equal(await running, 0);
  });

  it("rejects non-loopback status binds", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const result = await runWorkerCli([
      "worker",
      "start",
      "--state-dir",
      fixture.stateDirectory,
      "--agent-workspace",
      fixture.workspace,
      "--host",
      "0.0.0.0",
      "--port",
      "0",
      "--once",
    ], fixture.root, dependencies(contracts));
    assert.equal(result.code, 1);
    assert.match(result.stderr, /must bind to 127\.0\.0\.1 or ::1/);
  });
});
