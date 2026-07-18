import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  OpsWorkerDoneCheckRegistry,
  type OpsWorkerDoneCheckDefinition,
  type OpsWorkerDoneCheckResult,
} from "../ops-worker/done-checks.js";
import {
  createOpsWorkerPiStartupReconciler,
  inspectOpsWorkerActiveRun,
  OPS_WORKER_ATTEMPT_TOKEN_ENV,
  OPS_WORKER_PI_LIMITS,
  OPS_WORKER_SYSTEM_POLICY,
  OpsWorkerPiAttemptRunner,
  type OpsWorkerPiAttemptDependencies,
  type OpsWorkerProcessGroupInspection,
  type OpsWorkerProcessInspection,
} from "../ops-worker/pi-attempt.js";
import { OpsWorkerSupervisor } from "../ops-worker/supervisor.js";
import { OpsWorkerTaskStore } from "../ops-worker/task-store.js";
import {
  OPS_WORKER_LIMITS,
  type JsonObject,
  type OpsWorkerSourceKind,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "../ops-worker/types.js";

const FAKE_PI_PROCESS = fileURLToPath(
  new URL("./fixtures/fake-pi-process.mjs", import.meta.url),
);

function validateFixtureParams(value: unknown): JsonObject {
  assert.deepEqual(value, { expected: true });
  return { expected: true };
}

function registry(
  doneChecks: OpsWorkerDoneCheckRegistry,
): OpsWorkerTaskContractRegistry {
  return {
    templates: {
      "fixture-task": {
        sourceKinds: [
          "alertmanager",
          "operator-cli",
          "registered-cron",
          "authorized-issue",
        ],
      },
    },
    authorizationProfiles: {
      "fixture.inspect.v1": {
        sourceKinds: [
          "alertmanager",
          "operator-cli",
          "registered-cron",
          "authorized-issue",
        ],
        scope: ["inspect"],
        tools: ["read", "grep", "find", "ls"],
      },
    },
    doneChecks: doneChecks.contracts,
  };
}

function makeTask(
  id: string,
  options: {
    sourceKind?: OpsWorkerSourceKind;
    objective?: string;
  } = {},
): OpsWorkerTask {
  const sourceKind = options.sourceKind ?? "operator-cli";
  const priority = {
    alertmanager: 0,
    "operator-cli": 10,
    "registered-cron": 20,
    "authorized-issue": 30,
  }[sourceKind] as OpsWorkerTask["priority"];
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    id,
    source: {
      kind: sourceKind,
      correlationKey: `fixture:${id}`,
      template: "fixture-task",
    },
    priority,
    objective: options.objective ?? "Inspect the synthetic fixture state",
    evidence: [],
    doneCheck: {
      name: "fixture-check",
      params: { expected: true },
    },
    authorization: {
      profile: "fixture.inspect.v1",
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
    session: {
      directory: `sessions/${id}`,
      sessionId: null,
      resume: false,
    },
    activeRun: null,
    unverifiedRun: null,
    lastOutcome: null,
    report: { state: "NONE", attempts: 0, lastError: null },
    createdAt: now,
    updatedAt: now,
  };
}

interface Harness {
  root: string;
  workspace: string;
  store: OpsWorkerTaskStore;
  supervisor: OpsWorkerSupervisor;
  children: ChildProcess[];
  invocations: string[][];
  setScenario(scenario: string): void;
  runner(options?: {
    attemptTimeoutMs?: number;
    stallTimeoutMs?: number;
    abortSignal?: AbortSignal;
    dependencies?: OpsWorkerPiAttemptDependencies;
  }): OpsWorkerPiAttemptRunner;
}

async function makeHarness(
  t: TestContext,
  check: OpsWorkerDoneCheckDefinition["run"] = () => ({
    result: "PASS",
    summary: "Fixture is deterministically complete.",
  }),
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "minime-ops-worker-pi-"));
  const workspace = join(root, "workspace");
  const stateDirectory = join(root, "state");
  writeFileSync(join(root, ".keep"), "fixture\n", "utf8");
  mkdirSync(workspace, { mode: 0o700 });
  const doneChecks = new OpsWorkerDoneCheckRegistry({
    "fixture-check": {
      timeoutMs: 500,
      validateParams: validateFixtureParams,
      run: check,
    },
  });
  const store = new OpsWorkerTaskStore(stateDirectory, {
    registry: registry(doneChecks),
  });
  const supervisor = new OpsWorkerSupervisor({
    store,
    doneChecks,
    instanceId: "pi-fixture-supervisor",
    processStartToken: "pi-fixture-supervisor-start",
    infrastructureRetryMs: 1,
  });
  await supervisor.start();
  const children: ChildProcess[] = [];
  const invocations: string[][] = [];
  let scenario = "success";
  t.after(() => {
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The fixture process group already exited.
        }
      }
    }
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    workspace,
    store,
    supervisor,
    children,
    invocations,
    setScenario(value): void {
      scenario = value;
    },
    runner(options = {}): OpsWorkerPiAttemptRunner {
      return new OpsWorkerPiAttemptRunner({
        supervisor,
        workspaceCwd: workspace,
        authorizationProfiles: registry(doneChecks).authorizationProfiles,
        abortSignal: options.abortSignal,
        attemptTimeoutMs: options.attemptTimeoutMs ?? 5_000,
        stallTimeoutMs: options.stallTimeoutMs,
        termGraceMs: 200,
        killGraceMs: 200,
        preemptionPollMs: 20,
        dependencies: {
          resolveInvocation: (args) => {
            invocations.push([...args]);
            return {
              command: process.execPath,
              args: [FAKE_PI_PROCESS, scenario, ...args],
            };
          },
          spawnProcess: (command, args, options) => {
            const child = spawn(command, args, options);
            children.push(child);
            return child;
          },
          buildEnv: () => Object.fromEntries(
            ["HOME", "PATH", "TMPDIR", "LANG"].flatMap((key) =>
              process.env[key] === undefined ? [] : [[key, process.env[key] as string]]),
          ),
          assembleContext: () => null,
          ...options.dependencies,
        },
      });
    },
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture state");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

describe("ops worker Pi standard-session attempts", () => {
  it("traces the pinned Pi 0.80.6 create/resume and corrupt-session contract", () => {
    const rpcEntry = fileURLToPath(
      import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
    );
    const packageRoot = resolve(dirname(rpcEntry), "..");
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { version: string };
    const mainSource = readFileSync(join(packageRoot, "dist/main.js"), "utf8");
    const sessionSource = readFileSync(
      join(packageRoot, "dist/core/session-manager.js"),
      "utf8",
    );
    const initialMessageSource = readFileSync(
      join(packageRoot, "dist/cli/initial-message.js"),
      "utf8",
    );

    assert.equal(manifest.version, "0.80.6");
    assert.match(mainSource, /if \(parsed\.sessionId\)/);
    assert.match(mainSource, /SessionManager\.create\(cwd, sessionDir/);
    assert.match(mainSource, /if \(parsed\.session\)/);
    assert.match(mainSource, /openSessionOrExit\(resolved\.path, sessionDir\)/);
    assert.match(mainSource, /stdinContent = await readPipedStdin\(\)/);
    assert.match(initialMessageSource, /parts\.push\(stdinContent\)/);
    assert.match(sessionSource, /Session file is not a valid pi session/);
  });

  it("injects the assembled agent context before the fixed ops-worker policy", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("assembled-context"));
    let assembledWorkspace: string | undefined;

    await harness.runner({
      dependencies: {
        assembleContext: (agent) => {
          assembledWorkspace = agent.workspaceCwd;
          return {
            systemPromptPath: "/fixture/ops-worker-persona.md",
            appendSystemPromptPath: "/fixture/ops-worker-context.md",
          };
        },
      },
    }).runAttempt("assembled-context");

    assert.equal(assembledWorkspace, realpathSync(harness.workspace));
    const args = harness.invocations[0];
    assert.ok(args.includes("--no-context-files"));
    assert.equal(
      args[args.indexOf("--system-prompt") + 1],
      "/fixture/ops-worker-persona.md",
    );
    const appended = args.flatMap((arg, index) =>
      arg === "--append-system-prompt" ? [args[index + 1]] : []);
    assert.deepEqual(appended, [
      "/fixture/ops-worker-context.md",
      OPS_WORKER_SYSTEM_POLICY,
    ]);
  });

  it("falls back to Pi context discovery only for a genuinely empty workspace", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("empty-context"));

    await harness.runner({
      dependencies: { assembleContext: () => null },
    }).runAttempt("empty-context");

    const args = harness.invocations[0];
    assert.ok(!args.includes("--no-context-files"));
    assert.equal(
      args[args.indexOf("--append-system-prompt") + 1],
      OPS_WORKER_SYSTEM_POLICY,
    );
  });

  it("treats exit success as a claim and a failed done check as remediation", async (t) => {
    const harness = await makeHarness(t, () => ({
      result: "ACTION_REQUIRED",
      summary: "Synthetic state still requires repair.",
    }));
    harness.store.create(makeTask("success-failed-check", {
      objective: "--model payload-selected-model",
    }));

    const result = await harness.runner().runAttempt("success-failed-check");

    assert.equal(result.state, "RESUMABLE");
    assert.equal(result.rounds.remediation, 1);
    assert.equal(result.lastOutcome?.result, "ACTION_REQUIRED");
    assert.equal(result.session.resume, true);
    assert.equal(harness.invocations.length, 1);
    const args = harness.invocations[0];
    assert.ok(args.includes("--session-dir"));
    assert.ok(args.includes("--session-id"));
    assert.ok(!args.includes("--no-session"));
    assert.ok(!args.includes("payload-selected-model"));
    assert.equal(args[0], "-p");
    assert.equal(args[1], "--session-dir");
    assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-5.5");
    assert.equal(args[args.indexOf("--tools") + 1], "read,grep,find,ls");
    assert.match(
      args[args.indexOf("--append-system-prompt") + 1],
      /Do not use sudo or perform irreversible deletion/,
    );
    assert.equal(result.evidence.some((entry) => /success claim/.test(entry.summary)), true);
  });

  it("treats clean exit as a claim even when successful output mentions old errors", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("success-with-diagnostics"));
    harness.setScenario("success-diagnostic");

    const result = await harness.runner().runAttempt("success-with-diagnostics");

    assert.equal(result.state, "DONE");
    assert.equal(result.lastOutcome?.result, "PASS");
  });

  it("runs a ready deterministic check without requiring a Pi success claim", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("check-without-claim"));
    harness.supervisor.requestDoneCheck("check-without-claim");

    const result = await harness.runner().runNext();

    assert.equal(result?.state, "DONE");
    assert.equal(result?.lastOutcome?.result, "PASS");
    assert.equal(harness.invocations.length, 0);
  });

  it("preserves and resumes the same standard Pi session after a crash", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("crash-resume"));
    harness.setScenario("crash");

    const crashed = await harness.runner().runAttempt("crash-resume");
    const sessionId = crashed.session.sessionId;
    assert.equal(crashed.state, "RESUMABLE");
    assert.equal(crashed.lastOutcome?.result, "CRASH");
    assert.equal(crashed.rounds.remediation, 0);
    assert.equal(crashed.session.resume, true);
    assert.ok(sessionId);

    harness.setScenario("success");
    const resumed = await harness.runner().runAttempt("crash-resume");
    assert.equal(resumed.state, "DONE");
    assert.equal(resumed.session.sessionId, sessionId);
    assert.equal(harness.invocations.length, 2);
    const resumeArgs = harness.invocations[1];
    assert.equal(resumeArgs[resumeArgs.indexOf("--session") + 1], sessionId);
    assert.ok(!resumeArgs.includes("--session-id"));
  });

  it("classifies quota, network, context overflow, and bounded crash evidence as resumable", async (t) => {
    const harness = await makeHarness(t);
    const cases = [
      ["quota", "QUOTA"],
      ["network", "NETWORK"],
      ["context", "CONTEXT_OVERFLOW"],
      ["large-output", "CRASH"],
    ] as const;

    for (const [scenario, expected] of cases) {
      const taskId = `classify-${scenario}`;
      harness.store.create(makeTask(taskId));
      harness.setScenario(scenario);
      const result = await harness.runner().runAttempt(taskId);
      assert.equal(result.state, "RESUMABLE");
      assert.equal(result.lastOutcome?.result, expected);
      assert.equal(result.rounds.remediation, 0);
      assert.equal(result.session.resume, true);
      const piEvidence = [...result.evidence]
        .reverse()
        .find((entry) => entry.kind === "pi");
      assert.ok(piEvidence);
      assert.ok(
        Buffer.byteLength(piEvidence.summary, "utf8")
          <= OPS_WORKER_LIMITS.maxEvidenceSummaryBytes,
      );
      if (scenario === "large-output") {
        assert.match(piEvidence.summary, /omitted \d+ earlier byte/);
      }
    }
  });

  it("quarantines a corrupt session and continues in one fresh standard session", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("corrupt-session"));
    harness.setScenario("crash");
    const crashed = await harness.runner().runAttempt("corrupt-session");
    const oldSessionId = crashed.session.sessionId as string;
    const sessionDirectory = join(
      harness.supervisor.stateDirectory,
      "sessions",
      "corrupt-session",
    );
    const sessionFile = readdirSync(sessionDirectory)
      .find((file) => file.endsWith(".jsonl") && file.includes(oldSessionId));
    assert.ok(sessionFile);
    writeFileSync(join(sessionDirectory, sessionFile), "not-json\n", "utf8");

    harness.setScenario("success");
    const recovered = await harness.runner().runAttempt("corrupt-session");

    assert.equal(recovered.state, "DONE");
    assert.notEqual(recovered.session.sessionId, oldSessionId);
    assert.equal(
      recovered.evidence.some((entry) =>
        /bounded loss of prior conversation context/.test(entry.summary)),
      true,
    );
    const quarantined = readdirSync(join(sessionDirectory, "quarantine"));
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0], /\.corrupt$/);
    assert.ok(harness.invocations[1].includes("--session-id"));
  });

  it("preempts only for higher priority and owns exactly one process group", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("low-priority", {
      sourceKind: "authorized-issue",
    }));
    harness.setScenario("wait");
    const runner = harness.runner();
    const running = runner.runAttempt("low-priority");
    await waitFor(() => harness.supervisor.getTask("low-priority")?.state === "RUNNING");
    const active = harness.supervisor.getTask("low-priority")?.activeRun;
    assert.ok(active);
    assert.equal(active.pid, active.processGroupId);
    assert.equal(inspectOpsWorkerActiveRun(active).status, "OWNED");

    harness.store.create(makeTask("second-low", {
      sourceKind: "authorized-issue",
    }));
    await assert.rejects(
      harness.runner().runAttempt("second-low"),
      /launch slot is already reserved by task low-priority/,
    );
    await assert.rejects(
      runner.runAttempt("second-low"),
      /launch slot is already reserved by task low-priority/,
    );
    assert.equal(harness.supervisor.getTask("low-priority")?.state, "RUNNING");

    harness.store.create(makeTask("urgent", { sourceKind: "alertmanager" }));
    const preempted = await running;
    assert.equal(preempted.state, "RESUMABLE", JSON.stringify(preempted.lastOutcome));
    assert.equal(preempted.lastOutcome?.result, "PREEMPTED");
    assert.equal(preempted.rounds.remediation, 0);
    assert.equal(preempted.activeRun, null);
    assert.equal(harness.supervisor.getTask("urgent")?.state, "QUEUED");
    assert.equal(inspectOpsWorkerActiveRun(active).status, "GONE");
  });

  it("stops the owned group when priority monitoring fails", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("priority-monitor-failure"));
    harness.setScenario("wait");
    const originalListTasks = harness.supervisor.listTasks.bind(harness.supervisor);
    let failPriorityPoll = false;
    harness.supervisor.listTasks = () => {
      if (failPriorityPoll) throw new Error("synthetic priority store failure");
      return originalListTasks();
    };

    const running = harness.runner().runAttempt("priority-monitor-failure");
    await waitFor(() =>
      harness.supervisor.getTask("priority-monitor-failure")?.state === "RUNNING"
    );
    const active = harness.supervisor.getTask("priority-monitor-failure")?.activeRun;
    assert.ok(active);
    failPriorityPoll = true;

    const result = await running;
    harness.supervisor.listTasks = originalListTasks;

    assert.equal(result.state, "RESUMABLE", JSON.stringify(result.lastOutcome));
    assert.equal(result.lastOutcome?.result, "CRASH");
    assert.match(result.lastOutcome?.summary ?? "", /monitor failed.*priority store failure/);
    assert.equal(result.activeRun, null);
    assert.equal(result.rounds.remediation, 0);
    assert.equal(inspectOpsWorkerActiveRun(active).status, "GONE");
  });

  it("stops a no-progress attempt at the stall bound without spending remediation", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("stall-timeout"));
    harness.setScenario("wait");
    const running = harness.runner({
      attemptTimeoutMs: 2_000,
      stallTimeoutMs: 80,
    }).runAttempt("stall-timeout");
    await waitFor(() => harness.supervisor.getTask("stall-timeout")?.state === "RUNNING");
    const active = harness.supervisor.getTask("stall-timeout")?.activeRun;
    assert.ok(active);

    const result = await running;

    assert.equal(result.state, "RESUMABLE", JSON.stringify(result.lastOutcome));
    assert.equal(result.lastOutcome?.result, "STALL");
    assert.equal(result.rounds.remediation, 0);
    assert.equal(result.activeRun, null);
    assert.equal(inspectOpsWorkerActiveRun(active).status, "GONE");
  });

  it("does not KILL a surviving group after the proven Pi leader exits", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("descendant-cleanup"));
    harness.setScenario("leader-exits-child-survives");
    const running = harness.runner({
      attemptTimeoutMs: 2_000,
      stallTimeoutMs: 120,
    }).runAttempt("descendant-cleanup");
    await waitFor(() => harness.supervisor.getTask("descendant-cleanup")?.state === "RUNNING");
    const active = harness.supervisor.getTask("descendant-cleanup")?.activeRun;
    assert.ok(active);
    t.after(() => {
      try {
        process.kill(-active.processGroupId, "SIGKILL");
      } catch {
        // The isolated fixture group is already gone.
      }
    });

    const result = await running;

    assert.equal(result.state, "BLOCKED");
    assert.equal(result.lastOutcome?.result, "AMBIGUOUS_ORPHAN");
    assert.deepEqual(result.activeRun, active);
    assert.equal(inspectOpsWorkerActiveRun(active).status, "GONE");
    assert.doesNotThrow(() => process.kill(-active.processGroupId, 0));
  });

  it("turns shutdown into bounded owned-group cleanup and a resumable task", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("shutdown-cleanup"));
    harness.setScenario("wait");
    const controller = new AbortController();
    const running = harness.runner({ abortSignal: controller.signal })
      .runAttempt("shutdown-cleanup");
    await waitFor(() => harness.supervisor.getTask("shutdown-cleanup")?.state === "RUNNING");
    const active = harness.supervisor.getTask("shutdown-cleanup")?.activeRun;
    assert.ok(active);

    controller.abort();
    const result = await running;

    assert.equal(result.state, "RESUMABLE", JSON.stringify(result.lastOutcome));
    assert.equal(result.lastOutcome?.result, "CRASH");
    assert.match(result.lastOutcome?.summary ?? "", /worker shutdown/);
    assert.equal(inspectOpsWorkerActiveRun(active).status, "GONE");
  });

  it("abandons child handles and priority polling after ambiguous shutdown", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("ambiguous-shutdown"));
    const controller = new AbortController();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as ChildProcess;
    let ownershipNonce = "";
    let unrefCalls = 0;
    Object.assign(child, {
      pid: 600_001,
      stdout,
      stderr,
      exitCode: null,
      signalCode: null,
      unref: () => { unrefCalls += 1; },
    });
    t.after(() => child.emit("close", null, null));

    const originalListTasks = harness.supervisor.listTasks.bind(harness.supervisor);
    let priorityPolls = 0;
    harness.supervisor.listTasks = () => {
      priorityPolls += 1;
      return originalListTasks();
    };
    const running = harness.runner({
      abortSignal: controller.signal,
      dependencies: {
        spawnProcess: (_command, _args, options) => {
          const token = options.env?.[OPS_WORKER_ATTEMPT_TOKEN_ENV];
          if (typeof token !== "string") {
            throw new TypeError("Expected the trusted ownership token in the Pi environment");
          }
          ownershipNonce = token;
          return child;
        },
        readProcessIdentity: (pid) => ({
          status: "OWNED",
          identity: {
            pid,
            processGroupId: pid,
            processStartToken: "ambiguous-shutdown-start",
            ownershipNonce,
          },
        }),
        inspectActiveRun: () => ({
          status: "AMBIGUOUS",
          summary: "Synthetic ownership inspection ambiguity",
        }),
      },
    }).runAttempt("ambiguous-shutdown");
    await waitFor(() => harness.supervisor.getTask("ambiguous-shutdown")?.state === "RUNNING");

    controller.abort();
    const result = await running;

    assert.equal(result.state, "BLOCKED");
    assert.equal(result.lastOutcome?.result, "AMBIGUOUS_ORPHAN");
    assert.equal(unrefCalls, 1);
    assert.equal(stdout.destroyed, true);
    assert.equal(stderr.destroyed, true);
    const pollsAfterReturn = priorityPolls;
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    assert.equal(priorityPolls, pollsAfterReturn);
  });

  it("interrupts the deterministic check after a natural Pi success", async (t) => {
    let markCheckStarted: (() => void) | undefined;
    const checkStarted = new Promise<void>((resolveStarted) => {
      markCheckStarted = resolveStarted;
    });
    const harness = await makeHarness(t, () => {
      markCheckStarted?.();
      return new Promise<OpsWorkerDoneCheckResult>(() => undefined);
    });
    harness.store.create(makeTask("shutdown-success-check"));
    harness.setScenario("success");
    const controller = new AbortController();
    const running = harness.runner({ abortSignal: controller.signal })
      .runAttempt("shutdown-success-check");
    await checkStarted;

    controller.abort();
    const result = await running;

    assert.equal(result.state, "CHECKING");
    assert.equal(result.lastOutcome?.result, "ERROR");
    assert.match(result.lastOutcome?.summary ?? "", /ABORTED/);
    assert.equal(result.schedule.nextRunAt, null);
    assert.ok(result.schedule.nextCheckAt);
  });

  it("persists a launch fence before spawn and fails fresh launches closed", async (t) => {
    const beforeSpawn = await makeHarness(t);
    beforeSpawn.store.create(makeTask("intent-before-spawn"));
    const intentSpawnFailure = await beforeSpawn.runner({
      dependencies: {
        spawnProcess: () => {
          const persisted = beforeSpawn.store.get("intent-before-spawn");
          assert.equal(persisted?.state, "BLOCKED");
          assert.equal(persisted?.unverifiedRun?.pid, null);
          assert.equal(persisted?.unverifiedRun?.expectedProcessGroupId, null);
          throw new Error("synthetic spawn rejection");
        },
      },
    }).runAttempt("intent-before-spawn");
    assert.equal(intentSpawnFailure.state, "RESUMABLE");
    assert.equal(intentSpawnFailure.unverifiedRun, null);

    const asynchronousSpawnFailure = await makeHarness(t);
    asynchronousSpawnFailure.store.create(makeTask("async-spawn-error"));
    const missingExecutable = join(
      asynchronousSpawnFailure.root,
      "missing-package-owned-pi",
    );
    const asynchronousFailure = await asynchronousSpawnFailure.runner({
      dependencies: {
        spawnProcess: (_command, _args, options) =>
          spawn(missingExecutable, [], options),
      },
    }).runAttempt("async-spawn-error");
    assert.equal(asynchronousFailure.state, "RESUMABLE");
    assert.equal(asynchronousFailure.unverifiedRun, null);
    assert.match(asynchronousFailure.lastOutcome?.summary ?? "", /ENOENT/);

    const identityPollingCrash = await makeHarness(t);
    identityPollingCrash.store.create(makeTask("crash-during-identity-poll"));
    identityPollingCrash.setScenario("wait");
    await assert.rejects(
      identityPollingCrash.runner({
        dependencies: {
          readProcessIdentity: (pid) => ({
            status: "OWNED",
            identity: {
              pid,
              processGroupId: pid,
              processStartToken: "identity-not-yet-bound",
            },
          }),
          sleep: async () => {
            const persisted = identityPollingCrash.store.get(
              "crash-during-identity-poll",
            );
            assert.equal(
              persisted?.unverifiedRun?.pid,
              identityPollingCrash.children.at(-1)?.pid,
            );
            throw new Error("synthetic supervisor crash during identity polling");
          },
        },
      }).runAttempt("crash-during-identity-poll"),
      /synthetic supervisor crash during identity polling/,
    );
    const pollingFence = identityPollingCrash.store.get(
      "crash-during-identity-poll",
    );
    assert.equal(pollingFence?.state, "BLOCKED");
    assert.equal(
      pollingFence?.unverifiedRun?.pid,
      identityPollingCrash.children.at(-1)?.pid,
    );

    const crashBoundary = await makeHarness(t);
    crashBoundary.store.create(makeTask("crash-after-pid-fence"));
    crashBoundary.setScenario("wait");
    await assert.rejects(
      crashBoundary.runner({
        dependencies: {
          launchFaultInjector: (point) => {
            if (point === "after-unverified-run-persisted") {
              throw new Error("synthetic supervisor crash after PID fence");
            }
          },
        },
      }).runAttempt("crash-after-pid-fence"),
      /synthetic supervisor crash after PID fence/,
    );
    const fenced = crashBoundary.store.get("crash-after-pid-fence");
    assert.equal(fenced?.state, "BLOCKED");
    assert.equal(fenced?.unverifiedRun?.pid, crashBoundary.children.at(-1)?.pid);
    assert.equal(crashBoundary.supervisor.selectNextTask(), undefined);

    const harness = await makeHarness(t);

    harness.store.create(makeTask("spawn-throws"));
    const spawnFailure = await harness.runner({
      dependencies: {
        spawnProcess: () => { throw new Error("synthetic spawn failure"); },
      },
    }).runAttempt("spawn-throws");
    assert.equal(spawnFailure.state, "RESUMABLE");
    assert.equal(spawnFailure.lastOutcome?.result, "CRASH");

    harness.store.create(makeTask("identity-gone"));
    harness.setScenario("success");
    const identityGone = await harness.runner({
      dependencies: { readProcessIdentity: () => ({ status: "GONE" }) },
    }).runAttempt("identity-gone");
    assert.equal(identityGone.state, "DONE");
    assert.equal(identityGone.activeRun, null);
    assert.equal(identityGone.unverifiedRun, null);

    const missingPidHarness = await makeHarness(t);
    missingPidHarness.store.create(makeTask("missing-pid"));
    const missingPid = await missingPidHarness.runner({
      dependencies: {
        spawnProcess: () => {
          const child = new EventEmitter() as ChildProcess;
          Object.assign(child, {
            pid: undefined,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            exitCode: null,
            signalCode: null,
            unref: () => child,
          });
          queueMicrotask(() => child.emit("close", 1, null));
          return child;
        },
      },
    }).runAttempt("missing-pid");
    assert.equal(missingPid.state, "BLOCKED");
    assert.equal(missingPid.activeRun, null);
    assert.equal(missingPid.unverifiedRun?.pid, null);

    for (const [taskId, inspection, group] of [
      [
        "settled-without-nonce",
        (pid: number): OpsWorkerProcessInspection => ({
          status: "OWNED",
          identity: {
            pid,
            processGroupId: pid,
            processStartToken: "reused-process",
          },
        }),
        (): OpsWorkerProcessGroupInspection => ({ status: "GONE" }),
      ],
      [
        "gone-leader-live-group",
        (_pid: number): OpsWorkerProcessInspection => ({ status: "GONE" }),
        (): OpsWorkerProcessGroupInspection => ({ status: "PRESENT" }),
      ],
    ] as const) {
      const isolated = await makeHarness(t);
      isolated.store.create(makeTask(taskId));
      const blocked = await isolated.runner({
        dependencies: {
          spawnProcess: () => {
            const child = new EventEmitter() as ChildProcess;
            Object.assign(child, {
              pid: 500_000 + isolated.children.length,
              stdout: new PassThrough(),
              stderr: new PassThrough(),
              exitCode: null,
              signalCode: null,
              unref: () => undefined,
            });
            queueMicrotask(() => child.emit("close", 1, null));
            return child;
          },
          readProcessIdentity: inspection,
          inspectProcessGroup: group,
        },
      }).runAttempt(taskId);
      assert.equal(blocked.state, "BLOCKED");
      assert.equal(blocked.lastOutcome?.result, "AMBIGUOUS_ORPHAN");
      assert.ok(blocked.unverifiedRun?.pid);
    }

    for (const [taskId, inspection] of [
      ["identity-ambiguous", (_pid: number): OpsWorkerProcessInspection => ({
        status: "AMBIGUOUS",
        summary: "synthetic ambiguous identity",
      })],
      ["identity-mismatch", (pid: number): OpsWorkerProcessInspection => ({
        status: "OWNED",
        identity: {
          pid,
          processGroupId: pid + 1,
          processStartToken: "mismatched-group",
          ownershipNonce: "owner-unrelated",
        },
      })],
      ["identity-wrong-nonce", (pid: number): OpsWorkerProcessInspection => ({
        status: "OWNED",
        identity: {
          pid,
          processGroupId: pid,
          processStartToken: "unrelated-nonce",
          ownershipNonce: "owner-unrelated",
        },
      })],
    ] as const) {
      const isolated = await makeHarness(t);
      isolated.setScenario("wait");
      isolated.store.create(makeTask(taskId));
      let signals = 0;
      const startedAt = Date.now();
      const blocked = await isolated.runner({
        dependencies: {
          readProcessIdentity: inspection,
          signalProcessGroup: () => { signals += 1; },
        },
      }).runAttempt(taskId);
      assert.equal(blocked.state, "BLOCKED");
      assert.equal(blocked.activeRun, null);
      assert.equal(blocked.unverifiedRun?.pid, isolated.children.at(-1)?.pid);
      assert.match(blocked.unverifiedRun?.ownershipNonceHash ?? "", /^sha256:[a-f0-9]{64}$/);
      assert.equal(signals, 0);
      assert.ok(Date.now() - startedAt < 2_500);
      isolated.store.create(makeTask(`${taskId}-next`));
      assert.equal(isolated.supervisor.selectNextTask(), undefined);
    }
  });

  it("restart reconciliation stops proven ownership and blocks an ambiguous orphan without signaling", async (t) => {
    const activeRun = {
      attemptId: "attempt-reconcile",
      supervisorInstanceId: "prior-supervisor",
      pid: 404,
      processGroupId: 404,
      processStartedAt: new Date().toISOString(),
      processStartToken: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    } satisfies NonNullable<OpsWorkerTask["activeRun"]>;
    const task = makeTask("restart-owned");
    task.state = "RUNNING";
    task.activeRun = activeRun;
    const signals: NodeJS.Signals[] = [];
    let inspected = 0;
    const ownedThenGone = createOpsWorkerPiStartupReconciler({
      inspect: () => {
        inspected += 1;
        return inspected === 1
          ? { status: "OWNED", identity: activeRun }
          : { status: "GONE" };
      },
      inspectGroup: () => ({ status: "GONE" }),
      signal: (_group, signal) => signals.push(signal),
      sleep: async () => undefined,
      termGraceMs: 1,
      killGraceMs: 1,
    });
    assert.deepEqual(await ownedThenGone(task), {
      status: "STOPPED",
      summary: "Owned Pi process group stopped after TERM",
    });
    assert.deepEqual(signals, ["SIGTERM"]);

    const escalatedSignals: NodeJS.Signals[] = [];
    let killed = false;
    const requiresKill = createOpsWorkerPiStartupReconciler({
      inspect: () => ({ status: "OWNED", identity: activeRun }),
      inspectGroup: () => killed ? { status: "GONE" } : { status: "PRESENT" },
      signal: (_group, signal) => {
        escalatedSignals.push(signal);
        if (signal === "SIGKILL") killed = true;
      },
      sleep: async (milliseconds) => new Promise((resolveSleep) => {
        setTimeout(resolveSleep, milliseconds);
      }),
      termGraceMs: 1,
      killGraceMs: 1,
    });
    assert.equal((await requiresKill(task)).status, "STOPPED");
    assert.deepEqual(escalatedSignals, ["SIGTERM", "SIGKILL"]);

    const pgidReuseSignals: NodeJS.Signals[] = [];
    const vanishedLeader = createOpsWorkerPiStartupReconciler({
      inspect: () => ({ status: "GONE" }),
      inspectGroup: () => ({ status: "PRESENT" }),
      signal: (_group, signal) => pgidReuseSignals.push(signal),
      sleep: async () => undefined,
      termGraceMs: 1,
      killGraceMs: 1,
    });
    assert.equal((await vanishedLeader(task)).status, "AMBIGUOUS");
    assert.deepEqual(pgidReuseSignals, []);

    const noPgidOnlyKillSignals: NodeJS.Signals[] = [];
    let ownershipChecks = 0;
    const leaderExitsAfterTerm = createOpsWorkerPiStartupReconciler({
      inspect: () => {
        ownershipChecks += 1;
        return ownershipChecks === 1
          ? { status: "OWNED", identity: activeRun }
          : { status: "GONE" };
      },
      inspectGroup: () => ({ status: "PRESENT" }),
      signal: (_group, signal) => noPgidOnlyKillSignals.push(signal),
      sleep: async () => undefined,
      termGraceMs: 1,
      killGraceMs: 1,
    });
    assert.equal((await leaderExitsAfterTerm(task)).status, "AMBIGUOUS");
    assert.deepEqual(noPgidOnlyKillSignals, ["SIGTERM"]);

    const pendingIntentTask = makeTask("restart-pending-intent");
    pendingIntentTask.state = "BLOCKED";
    pendingIntentTask.lastOutcome = {
      at: pendingIntentTask.updatedAt,
      kind: "RECONCILIATION",
      result: "AMBIGUOUS_ORPHAN",
      summary: "Synthetic pre-spawn launch intent requires a global fence.",
    };
    pendingIntentTask.unverifiedRun = {
      attemptId: "attempt-pending",
      supervisorInstanceId: "prior-supervisor",
      pid: null,
      expectedProcessGroupId: null,
      launchedAt: pendingIntentTask.updatedAt,
      ownershipNonceHash: `sha256:${"a".repeat(64)}`,
    };
    let pendingIntentInspections = 0;
    const reconcilePendingIntent = createOpsWorkerPiStartupReconciler({
      inspectUnverified: () => {
        pendingIntentInspections += 1;
        return { status: "GONE" };
      },
      inspectGroup: () => {
        pendingIntentInspections += 1;
        return { status: "GONE" };
      },
      signal: () => {
        pendingIntentInspections += 1;
      },
    });
    assert.equal((await reconcilePendingIntent(pendingIntentTask)).status, "AMBIGUOUS");
    assert.equal(pendingIntentInspections, 0);

    const unverifiedTask = makeTask("restart-unverified");
    unverifiedTask.state = "BLOCKED";
    unverifiedTask.lastOutcome = {
      at: unverifiedTask.updatedAt,
      kind: "RECONCILIATION",
      result: "AMBIGUOUS_ORPHAN",
      summary: "Synthetic unverified launch requires restart reconciliation.",
    };
    unverifiedTask.unverifiedRun = {
      attemptId: "attempt-unverified",
      supervisorInstanceId: "prior-supervisor",
      pid: 505,
      expectedProcessGroupId: 505,
      launchedAt: unverifiedTask.updatedAt,
      ownershipNonceHash: `sha256:${createHash("sha256")
        .update("ownership-nonce:owner-restart")
        .digest("hex")}`,
    };
    let unverifiedStopped = false;
    const unverifiedSignals: NodeJS.Signals[] = [];
    const reconcileUnverified = createOpsWorkerPiStartupReconciler({
      inspectUnverified: () => ({
        status: "OWNED",
        identity: {
          pid: 505,
          processGroupId: 505,
          processStartToken: "unverified-start-token",
          ownershipNonce: "owner-restart",
        },
      }),
      inspectGroup: () => unverifiedStopped
        ? { status: "GONE" }
        : { status: "PRESENT" },
      signal: (_group, signal) => {
        unverifiedSignals.push(signal);
        unverifiedStopped = true;
      },
      sleep: async () => undefined,
      termGraceMs: 1,
      killGraceMs: 1,
    });
    assert.equal((await reconcileUnverified(unverifiedTask)).status, "STOPPED");
    assert.deepEqual(unverifiedSignals, ["SIGTERM"]);

    const root = mkdtempSync(join(tmpdir(), "minime-ops-worker-orphan-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const doneChecks = new OpsWorkerDoneCheckRegistry({
      "fixture-check": {
        timeoutMs: 100,
        validateParams: validateFixtureParams,
        run: () => ({ result: "PASS", summary: "fixture passed" }),
      },
    });
    const store = new OpsWorkerTaskStore(root, { registry: registry(doneChecks) });
    const persisted = makeTask("ambiguous-orphan");
    persisted.state = "RUNNING";
    persisted.activeRun = activeRun;
    store.create(persisted);
    let signalCount = 0;
    const ambiguousInspection: OpsWorkerProcessInspection = {
      status: "AMBIGUOUS",
      summary: "Synthetic PID start token does not match",
    };
    const supervisor = new OpsWorkerSupervisor({
      store,
      doneChecks,
      instanceId: "restart-supervisor",
      processStartToken: "restart-supervisor-start",
      reconcileActiveRun: createOpsWorkerPiStartupReconciler({
        inspect: () => ambiguousInspection,
        signal: () => { signalCount += 1; },
        sleep: async () => undefined,
        termGraceMs: 1,
        killGraceMs: 1,
      }),
    });
    t.after(() => supervisor.close());
    await supervisor.start();
    assert.equal(store.get("ambiguous-orphan")?.state, "BLOCKED");
    assert.equal(
      store.get("ambiguous-orphan")?.lastOutcome?.result,
      "AMBIGUOUS_ORPHAN",
    );
    assert.equal(signalCount, 0);
  });
});
