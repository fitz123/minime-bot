import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { runCliAsync } from "../cli.js";
import {
  OpsWorkerDoneCheckRegistry,
} from "../ops-worker/done-checks.js";
import { OpsWorkerSupervisor } from "../ops-worker/supervisor.js";
import { OpsWorkerTaskStore } from "../ops-worker/task-store.js";
import type {
  JsonObject,
  OpsWorkerTask,
  OpsWorkerTaskContractRegistry,
  OpsWorkerTaskV1,
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
    "--delivery-key",
    "operator-cli:fixture-delivery-one",
    "--resource-key",
    "github:example/minime-bot",
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
    assert.match(result.stdout, /--delivery-key <adapter-delivery-key>/);
    assert.match(result.stdout, /worker checkpoint --state-dir <path>/);
    assert.match(result.stdout, /worker receipt-query --state-dir <path>/);
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
      schemaVersion: number;
      state: string;
      source: { deliveryKey: string };
      resource: { kind: string; key: string };
      authorization: { scope: string[] };
    };
    assert.equal(task.id, "op-fixture-task-id");
    assert.equal(task.schemaVersion, 2);
    assert.equal(task.state, "QUEUED");
    assert.equal(task.source.deliveryKey, "operator-cli:fixture-delivery-one");
    assert.deepEqual(task.resource, {
      kind: "repository",
      key: "github:example/minime-bot",
    });
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
        custodyOwner: null,
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

  it("inspects v1 snapshots through pure normalization without rewriting them", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const deps = dependencies(contracts);
    const submitted = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
      deps,
    );
    assert.equal(submitted.code, 0, submitted.stderr);
    const current = JSON.parse(submitted.stdout) as OpsWorkerTask;
    const {
      resource: _resource,
      lifecycle: _lifecycle,
      currentCheckpoint: _currentCheckpoint,
      mutationReceipts: _mutationReceipts,
      custody: _custody,
      ...legacyFields
    } = current;
    const legacySource: OpsWorkerTaskV1["source"] = {
      kind: "operator-cli",
      correlationKey: current.source.correlationKey,
      template: current.source.template,
    };
    const legacy: OpsWorkerTaskV1 = {
      ...legacyFields,
      schemaVersion: 1,
      source: legacySource,
    };
    const snapshotPath = join(
      fixture.stateDirectory,
      "tasks",
      `${current.id}.json`,
    );
    const legacyJson = `${JSON.stringify(legacy)}\n`;
    writeFileSync(snapshotPath, legacyJson, { encoding: "utf8", mode: 0o600 });

    const inspected = await runWorkerCli([
      "worker",
      "inspect",
      "--state-dir",
      fixture.stateDirectory,
      "--id",
      current.id,
      "--json",
    ], fixture.root, deps);

    assert.equal(inspected.code, 0, inspected.stderr);
    const normalized = JSON.parse(inspected.stdout) as OpsWorkerTask;
    assert.equal(normalized.schemaVersion, 2);
    assert.equal(normalized.source.deliveryKey, `legacy:${current.id}`);
    assert.deepEqual(normalized.resource, {
      kind: "host",
      key: `host:legacy-${current.id}`,
    });
    assert.equal(readFileSync(snapshotPath, "utf8"), legacyJson);
  });

  it("returns identical delivery replays and rejects conflicting reuse", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const deps = dependencies(contracts);
    const first = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
      deps,
    );
    assert.equal(first.code, 0, first.stderr);

    const replay = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
      deps,
    );
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout), JSON.parse(first.stdout));

    const store = new OpsWorkerTaskStore(fixture.stateDirectory, {
      registry: contracts.taskRegistry,
    });
    assert.equal(store.list().length, 1);

    const conflictArgs = submitArgs(fixture.stateDirectory);
    conflictArgs[conflictArgs.indexOf("Inspect the registered fixture state")] =
      "Conflicting objective for the same delivery";
    const conflict = await runWorkerCli(conflictArgs, fixture.root, deps);
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /Delivery key .* conflicts with existing task/);
    assert.equal(store.list().length, 1);
  });

  it("records checkpoints and fixed receipts while the supervisor owns custody", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const deps = dependencies(contracts, {
      now: () => new Date("2026-07-18T10:00:01.000Z"),
    });
    const submitted = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
      deps,
    );
    assert.equal(submitted.code, 0, submitted.stderr);
    const taskId = (JSON.parse(submitted.stdout) as OpsWorkerTask).id;
    const store = new OpsWorkerTaskStore(fixture.stateDirectory, {
      registry: contracts.taskRegistry,
      now: deps.now,
    });
    const supervisor = new OpsWorkerSupervisor({
      store,
      doneChecks: contracts.doneChecks,
      instanceId: "fixture-cli-owner",
      processStartToken: "fixture-cli-owner-start",
      now: deps.now,
    });
    await supervisor.start();
    t.after(() => supervisor.close());
    assert.equal(supervisor.claimNextTask()?.task.id, taskId);

    const checkpointArgs = [
      "worker",
      "checkpoint",
      "--state-dir",
      fixture.stateDirectory,
      "--id",
      taskId,
      "--checkpoint-id",
      "checkpoint-cli-01",
      "--summary",
      "Repository evidence collected",
      "--payload",
      '{"head":"abc123","ready":true}',
      "--artifact",
      "artifacts/checkpoint.json",
      "--lifecycle",
      '{"repository":"example/minime-bot","head":"abc123"}',
      "--json",
    ];
    const checkpoint = await runWorkerCli(checkpointArgs, fixture.root, deps);
    assert.equal(checkpoint.code, 0, checkpoint.stderr);
    const checkpointTask = JSON.parse(checkpoint.stdout) as OpsWorkerTask;
    assert.equal(checkpointTask.custody.status, "HELD");
    assert.equal(checkpointTask.currentCheckpoint?.checkpointId, "checkpoint-cli-01");
    assert.match(checkpointTask.currentCheckpoint?.payloadHash ?? "", /^sha256:/);

    const replay = await runWorkerCli(checkpointArgs, fixture.root, deps);
    assert.equal(replay.code, 0, replay.stderr);
    assert.deepEqual(JSON.parse(replay.stdout), checkpointTask);

    const query = await runWorkerCli([
      "worker",
      "receipt-query",
      "--state-dir",
      fixture.stateDirectory,
      "--id",
      taskId,
      "--boundary",
      "merge",
      "--operation-id",
      "merge-cli-01",
      "--intent",
      '{"pullRequest":58,"head":"abc123"}',
      "--query-observed-at",
      "2026-07-18T10:00:00.000Z",
      "--query-result",
      '{"merged":false}',
      "--json",
    ], fixture.root, deps);
    assert.equal(query.code, 0, query.stderr);

    const claimArgs = [
      "worker",
      "receipt-claim",
      "--state-dir",
      fixture.stateDirectory,
      "--id",
      taskId,
      "--boundary",
      "merge",
      "--operation-id",
      "merge-cli-01",
      "--intent",
      '{"head":"abc123","pullRequest":58}',
      "--json",
    ];
    const claim = await runWorkerCli(claimArgs, fixture.root, deps);
    assert.equal(claim.code, 0, claim.stderr);
    const claimed = JSON.parse(claim.stdout) as {
      claimed: boolean;
      task: OpsWorkerTask;
    };
    assert.equal(claimed.claimed, true);
    assert.equal(
      claimed.task.mutationReceipts.merge?.mutationStartedAt,
      "2026-07-18T10:00:01.000Z",
    );

    const claimReplay = await runWorkerCli(claimArgs, fixture.root, deps);
    assert.equal(claimReplay.code, 0, claimReplay.stderr);
    const replayedClaim = JSON.parse(claimReplay.stdout) as {
      claimed: boolean;
      task: OpsWorkerTask;
    };
    assert.equal(replayedClaim.claimed, false);
    assert.deepEqual(replayedClaim.task, claimed.task);

    const finish = await runWorkerCli([
      "worker",
      "receipt-finish",
      "--state-dir",
      fixture.stateDirectory,
      "--id",
      taskId,
      "--boundary",
      "merge",
      "--operation-id",
      "merge-cli-01",
      "--intent",
      '{"pullRequest":58,"head":"abc123"}',
      "--result",
      "APPLIED",
      "--evidence",
      '{"mergeCommit":"def456"}',
      "--lifecycle",
      '{"merge":"def456","pullRequest":"58"}',
      "--json",
    ], fixture.root, deps);
    assert.equal(finish.code, 0, finish.stderr);
    const finished = JSON.parse(finish.stdout) as OpsWorkerTask;
    assert.equal(finished.mutationReceipts.merge?.outcome?.result, "APPLIED");
    assert.equal(finished.lifecycle.merge, "def456");

    const status = await runWorkerCli([
      "worker",
      "status",
      "--state-dir",
      fixture.stateDirectory,
      "--json",
    ], fixture.root, deps);
    assert.equal(status.code, 0, status.stderr);
    const statusValue = JSON.parse(status.stdout) as Record<string, unknown>;
    assert.deepEqual(statusValue.custodyOwner, { id: taskId, state: "QUEUED" });
    assert.ok(!status.stdout.includes("Repository evidence collected"));
    assert.ok(!status.stdout.includes("Inspect the registered fixture state"));
    assert.ok(!Object.hasOwn(statusValue, "evidence"));
  });

  it("rejects malformed helper JSON, unknown receipt boundaries, and unsafe resources", async (t) => {
    const fixture = fixtureRoot(t);
    const contracts = fixtureContracts();
    const deps = dependencies(contracts);
    const invalidResource = submitArgs(fixture.stateDirectory);
    invalidResource[invalidResource.indexOf("github:example/minime-bot")] =
      "github:Example/minime-bot";
    const resourceResult = await runWorkerCli(invalidResource, fixture.root, deps);
    assert.equal(resourceResult.code, 2);
    assert.match(resourceResult.stderr, /normalized lowercase namespaced resource key/);

    const submitted = await runWorkerCli(
      submitArgs(fixture.stateDirectory),
      fixture.root,
      deps,
    );
    const taskId = (JSON.parse(submitted.stdout) as OpsWorkerTask).id;
    const malformed = await runWorkerCli([
      "worker",
      "checkpoint",
      "--state-dir",
      fixture.stateDirectory,
      "--id",
      taskId,
      "--checkpoint-id",
      "checkpoint-invalid",
      "--summary",
      "Invalid JSON fixture",
      "--payload",
      "{not-json}",
    ], fixture.root, deps);
    assert.equal(malformed.code, 2);
    assert.match(malformed.stderr, /--payload must be valid JSON/);

    const boundary = await runWorkerCli([
      "worker",
      "receipt-query",
      "--state-dir",
      fixture.stateDirectory,
      "--id",
      taskId,
      "--boundary",
      "publish",
      "--operation-id",
      "publish-invalid",
      "--intent",
      "{}",
      "--query-observed-at",
      "2026-07-18T10:00:00.000Z",
      "--query-result",
      "{}",
    ], fixture.root, deps);
    assert.equal(boundary.code, 2);
    assert.match(boundary.stderr, /--boundary must be one of merge, tag-release, deploy, canonical-task, report/);
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
    blocked.custody = {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: blocked.updatedAt,
      releaseReason: "BLOCKED",
    };
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
    const statusValue = await status.json() as Record<string, unknown>;
    assert.equal(statusValue.totalTasks, 0);
    assert.equal(statusValue.custodyOwner, null);
    assert.ok(!Object.hasOwn(statusValue, "evidence"));

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
