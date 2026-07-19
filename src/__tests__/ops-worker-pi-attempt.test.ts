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
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { assemblePiContext } from "../pi-context-assembler.js";
import type { CodexQuotaSnapshot } from "../pi-extensions/codex-usage.js";
import { opsWorkerEffectiveContextDigest } from "../pi-extensions/ops-worker-parity-attestation.js";
import {
  PI_BUILTIN_TOOL_NAMES,
  resolvePiPrimaryResourceContract,
  type PiPrimaryResourceContract,
} from "../pi-primary-resources.js";
import type { AgentConfig, PiThinkingLevel } from "../types.js";
import {
  hasFreshOpsWorkerAuthorizationPass,
  type OpsWorkerAuthorizationVerifier,
  type OpsWorkerAuthorizationVerifierRegistry,
} from "../ops-worker/authorization.js";
import {
  OpsWorkerDoneCheckRegistry,
  type OpsWorkerDoneCheckDefinition,
} from "../ops-worker/done-checks.js";
import { OpsWorkerLifecycle } from "../ops-worker/lifecycle.js";
import type {
  OpsWorkerQuotaAdmissionDecision,
  OpsWorkerQuotaAdmissionGate,
} from "../ops-worker/quota.js";
import {
  createOpsWorkerPiStartupReconciler,
  inspectOpsWorkerActiveRun,
  OPS_WORKER_ATTEMPT_TOKEN_ENV,
  OPS_WORKER_NODE_OPTIONS,
  OPS_WORKER_PI_LIMITS,
  OPS_WORKER_SYSTEM_POLICY,
  OpsWorkerPiAttemptRunner,
  type OpsWorkerPiAttemptDependencies,
  type OpsWorkerQuotaProbeRequest,
  type OpsWorkerProcessGroupInspection,
  type OpsWorkerProcessInspection,
} from "../ops-worker/pi-attempt.js";
import { OpsWorkerSupervisor } from "../ops-worker/supervisor.js";
import { OpsWorkerTaskStore } from "../ops-worker/task-store.js";
import {
  createEmptyOpsWorkerLifecycleManifest,
  createEmptyOpsWorkerMutationReceipts,
  createUnclaimedOpsWorkerCustody,
  OPS_WORKER_LIMITS,
  withOpsWorkerSubmissionFingerprint,
  type JsonObject,
  type OpsWorkerSourceKind,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "../ops-worker/types.js";

const FAKE_PI_PROCESS = fileURLToPath(
  new URL("./fixtures/fake-pi-process.mjs", import.meta.url),
);
const TSX_IMPORT = import.meta.resolve("tsx");
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRIMARY_TOOL_NAMES = [
  ...PI_BUILTIN_TOOL_NAMES,
  "web_search",
  "knowledge_search",
  "knowledge_get",
  "knowledge_update",
  "subagent",
  "ask_agent",
  "configured_extra",
] as const;
const AUTHORIZATION_CLAIM_HASH = `sha256:${"a".repeat(64)}`;

function admittedQuota(now = new Date()): OpsWorkerQuotaAdmissionDecision {
  return {
    version: 1,
    status: "ADMITTED",
    reason: "HEADROOM",
    observedAt: now.toISOString(),
    sampledAt: now.toISOString(),
    activeWindows: ["5h"],
    nextResetAt: null,
    nextProbeAt: null,
    evidenceHash: `sha256:${"c".repeat(64)}`,
    summary: "Codex quota admission passed for 5h",
  };
}

function deniedQuota(nextProbeAt: string): OpsWorkerQuotaAdmissionDecision {
  const observedAt = new Date().toISOString();
  return {
    version: 1,
    status: "NOT_ADMITTED",
    reason: "LOW_REMAINING",
    observedAt,
    sampledAt: observedAt,
    activeWindows: ["5h"],
    nextResetAt: nextProbeAt,
    nextProbeAt,
    evidenceHash: `sha256:${"d".repeat(64)}`,
    summary: "Codex quota admission closed: LOW_REMAINING",
  };
}

function quotaSnapshot(now = new Date()): CodexQuotaSnapshot {
  const reset = new Date(Math.floor(now.getTime() / 1_000) * 1_000 + 60 * 60_000);
  return {
    provider: "codex",
    sampledAt: now.toISOString(),
    lastSuccess: now.toISOString(),
    lastSuccessTimestamp: Math.floor(now.getTime() / 1_000),
    windows: {
      "5h": {
        usedPercent: 100,
        remainingPercent: 0,
        resetAt: reset.toISOString(),
        resetTimestamp: Math.floor(reset.getTime() / 1_000),
      },
      week: {},
    },
  };
}
const fixtureAuthorizationVerifier: OpsWorkerAuthorizationVerifier = {
  identity: "fixture-authorization",
  version: "1",
  verify: () => ({
    status: "PASS",
    evidenceHash: `sha256:${"b".repeat(64)}`,
    summary: "Authorization matches the trusted fixture policy.",
  }),
};
const fixtureAuthorizationVerifiers: OpsWorkerAuthorizationVerifierRegistry = {
  alertmanager: fixtureAuthorizationVerifier,
  "operator-cli": fixtureAuthorizationVerifier,
  "operator-telegram": fixtureAuthorizationVerifier,
  "registered-cron": fixtureAuthorizationVerifier,
  "authorized-issue": fixtureAuthorizationVerifier,
};

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
    "operator-telegram": 10,
    "registered-cron": 20,
    "authorized-issue": 30,
  }[sourceKind] as OpsWorkerTask["priority"];
  const now = new Date().toISOString();
  return withOpsWorkerSubmissionFingerprint({
    schemaVersion: 4,
    id,
    source: {
      kind: sourceKind,
      correlationKey: `fixture:${id}`,
      deliveryKey: `fixture:${id}`,
      template: "fixture-task",
    },
    resource: { kind: "host", key: "host:local" },
    lifecycle: createEmptyOpsWorkerLifecycleManifest(),
    currentCheckpoint: null,
    mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
    custody: createUnclaimedOpsWorkerCustody(),
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
      snapshotHash: AUTHORIZATION_CLAIM_HASH,
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
  });
}

interface Harness {
  root: string;
  workspace: string;
  primaryWorkspace: string;
  primaryContextAgent: AgentConfig;
  primaryResources: PiPrimaryResourceContract;
  store: OpsWorkerTaskStore;
  supervisor: OpsWorkerSupervisor;
  children: ChildProcess[];
  invocations: string[][];
  setScenario(scenario: string): void;
  runner(options?: {
    model?: string;
    thinking?: PiThinkingLevel;
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
  options: {
    authorizationVerifiers?: OpsWorkerAuthorizationVerifierRegistry;
    quotaAdmission?: OpsWorkerQuotaAdmissionGate;
  } = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "minime-ops-worker-pi-"));
  const workspace = join(root, "workspace");
  const primaryWorkspace = join(root, "primary");
  const stateDirectory = join(root, "state");
  writeFileSync(join(root, ".keep"), "fixture\n", "utf8");
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(join(primaryWorkspace, ".claude", "rules", "platform"), { recursive: true });
  mkdirSync(join(primaryWorkspace, ".claude", "rules", "custom"), { recursive: true });
  mkdirSync(join(primaryWorkspace, ".claude", "skills", "fixture-skill"), { recursive: true });
  writeFileSync(
    join(primaryWorkspace, "CLAUDE.md"),
    "# Primary fixture\n\n@USER.md\n@MEMORY.md\n",
    "utf8",
  );
  writeFileSync(join(primaryWorkspace, "USER.md"), "PRIMARY_USER_CONTEXT\n", "utf8");
  writeFileSync(join(primaryWorkspace, "MEMORY.md"), "PRIMARY_KNOWLEDGE_CONTEXT\n", "utf8");
  writeFileSync(
    join(primaryWorkspace, ".claude", "rules", "platform", "platform.md"),
    "PRIMARY_PLATFORM_RULE\n",
    "utf8",
  );
  writeFileSync(
    join(primaryWorkspace, ".claude", "rules", "custom", "custom.md"),
    "PRIMARY_CUSTOM_RULE\n",
    "utf8",
  );
  const skillPath = join(primaryWorkspace, ".claude", "skills", "fixture-skill", "SKILL.md");
  writeFileSync(
    skillPath,
    "---\nname: fixture-skill\ndescription: Synthetic parity skill.\n---\n\nFIXTURE_SKILL_BODY\n",
    "utf8",
  );
  const extraExtension = join(root, "configured-extra.ts");
  writeFileSync(extraExtension, "export default function () {}\n", "utf8");
  const primaryContextAgent: AgentConfig = {
    id: "main",
    workspaceCwd: primaryWorkspace,
    model: "openai-codex/gpt-5.5",
    thinking: "medium",
    systemPrompt: "PRIMARY_PERSONA_CONTEXT",
  };
  const primaryResources = resolvePiPrimaryResourceContract({
    extensionOptions: {
      extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
      relpaths: [],
      extraExtensions: [extraExtension],
    },
    skillPaths: [skillPath],
    toolNames: PRIMARY_TOOL_NAMES,
  });
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
    authorizationVerifiers: options.authorizationVerifiers
      ?? fixtureAuthorizationVerifiers,
    authorizationQueryRetryMs: 1,
    quotaAdmission: options.quotaAdmission,
    quotaRecheckMs: 1,
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
    primaryWorkspace,
    primaryContextAgent,
    primaryResources,
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
        primaryContextAgent,
        primaryResources,
        model: options.model,
        thinking: options.thinking,
        abortSignal: options.abortSignal,
        attemptTimeoutMs: options.attemptTimeoutMs ?? 5_000,
        stallTimeoutMs: options.stallTimeoutMs,
        termGraceMs: 200,
        killGraceMs: 200,
        dependencies: {
          resolveInvocation: (args) => {
            invocations.push([...args]);
            return {
              command: process.execPath,
              args: ["--import", TSX_IMPORT, FAKE_PI_PROCESS, scenario, ...args],
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
    let strictAssembly: boolean | undefined;
    let environmentWorkspace: string | undefined;
    let callerAgentId: string | undefined;

    const completed = await harness.runner({
      dependencies: {
        assembleContext: (agent, options) => {
          assembledWorkspace = agent.workspaceCwd;
          strictAssembly = options?.strict;
          return assemblePiContext(agent, options);
        },
        buildEnv: (workspace, runtime) => {
          environmentWorkspace = workspace;
          callerAgentId = runtime?.askCallerAgentId;
          return Object.fromEntries(
            ["HOME", "PATH", "TMPDIR", "LANG"].flatMap((key) =>
              process.env[key] === undefined ? [] : [[key, process.env[key] as string]]),
          );
        },
      },
    }).runAttempt("assembled-context");

    assert.equal(assembledWorkspace, realpathSync(harness.primaryWorkspace));
    assert.equal(strictAssembly, true);
    assert.equal(environmentWorkspace, realpathSync(harness.workspace));
    assert.equal(callerAgentId, harness.primaryContextAgent.id);
    const args = harness.invocations[0];
    assert.ok(args.includes("--no-extensions"));
    assert.ok(args.includes("--no-skills"));
    assert.ok(args.includes("--no-context-files"));
    const executionWorkspace = realpathSync(harness.workspace);
    assert.equal(
      args[args.indexOf("--system-prompt") + 1],
      join(executionWorkspace, ".tmp", "pi-context-main.persona.md"),
    );
    const appended = args.flatMap((arg, index) =>
      arg === "--append-system-prompt" ? [args[index + 1]] : []);
    assert.deepEqual(appended, [
      "/fixture/ops-worker-context.md",
      OPS_WORKER_SYSTEM_POLICY,
    ].map((value, index) => index === 0
      ? join(executionWorkspace, ".tmp", "pi-context-main.bundle.md")
      : value));
    assert.equal(appended[1], OPS_WORKER_SYSTEM_POLICY);
    const bundle = readFileSync(appended[0], "utf8");
    for (const acceptedContext of [
      "PRIMARY_USER_CONTEXT",
      "PRIMARY_KNOWLEDGE_CONTEXT",
      "PRIMARY_PLATFORM_RULE",
      "PRIMARY_CUSTOM_RULE",
    ]) assert.ok(bundle.includes(acceptedContext));
    assert.equal(
      readFileSync(args[args.indexOf("--system-prompt") + 1], "utf8"),
      "PRIMARY_PERSONA_CONTEXT",
    );
    assert.equal(bundle.includes(OPS_WORKER_SYSTEM_POLICY), false);

    const extensions = args.flatMap((arg, index) =>
      arg === "--extension" ? [args[index + 1]] : []);
    assert.equal(extensions.slice(0, -1).length, harness.primaryResources.extensionPaths.length);
    for (const extension of extensions.slice(0, -1)) {
      assert.match(extension, /parity-extension-\d+\.mjs$/);
    }
    assert.match(extensions.at(-1) ?? "", /parity-gate\.mjs$/);
    assert.equal(new Set(extensions).size, extensions.length);
    const skills = args.flatMap((arg, index) =>
      arg === "--skill" ? [args[index + 1]] : []);
    assert.deepEqual(skills, harness.primaryResources.skillPaths);
    assert.equal(args[args.indexOf("--tools") + 1], PRIMARY_TOOL_NAMES.join(","));
    const parityEvidence = completed.evidence.find((entry) =>
      entry.summary.includes("Pi parity v1 PASS"));
    assert.ok(parityEvidence);
    assert.match(parityEvidence.summary, /primary-context=sha256:[a-f0-9]{64}/);
    assert.match(parityEvidence.summary, /actual-context=sha256:[a-f0-9]{64}/);
    assert.match(parityEvidence.summary, /capabilities=sha256:[a-f0-9]{64}/);
    assert.equal(parityEvidence.summary.includes(harness.primaryWorkspace), false);
    assert.equal(parityEvidence.summary.includes("PRIMARY_USER_CONTEXT"), false);
  });

  it("rejects equal, overlapping, and symlinked context workspaces at construction", async (t) => {
    const harness = await makeHarness(t);
    const common = {
      supervisor: harness.supervisor,
      primaryResources: harness.primaryResources,
    };
    assert.throws(() => new OpsWorkerPiAttemptRunner({
      ...common,
      workspaceCwd: harness.workspace,
      primaryContextAgent: {
        ...harness.primaryContextAgent,
        workspaceCwd: harness.workspace,
      },
    }), /must not equal or overlap/);

    const nestedExecution = join(harness.primaryWorkspace, "nested-execution");
    mkdirSync(nestedExecution);
    assert.throws(() => new OpsWorkerPiAttemptRunner({
      ...common,
      workspaceCwd: nestedExecution,
      primaryContextAgent: harness.primaryContextAgent,
    }), /must not equal or overlap/);

    const linkedPrimary = join(harness.root, "linked-primary");
    symlinkSync(harness.primaryWorkspace, linkedPrimary);
    assert.throws(() => new OpsWorkerPiAttemptRunner({
      ...common,
      workspaceCwd: harness.workspace,
      primaryContextAgent: {
        ...harness.primaryContextAgent,
        workspaceCwd: linkedPrimary,
      },
    }), /must not be a symlink/);
  });

  it("includes bounded resource and lifecycle resume evidence in the private prompt", async (t) => {
    const harness = await makeHarness(t);
    const task = makeTask("lifecycle-prompt");
    harness.store.create(task);
    const lifecycle = new OpsWorkerLifecycle(harness.store, {
      now: () => new Date("2026-07-18T09:05:00.000Z"),
      authorizeMutationClaim: () => true,
    });
    lifecycle.recordCheckpoint(task.id, {
      checkpointId: "checkpoint-prompt",
      payload: { inspected: true },
      summary: "Repository inspection reached the merge boundary.",
      artifact: "artifacts/checkpoint-prompt.json",
      lifecycle: {
        repository: "github:example/minime-bot",
        branch: "refs/heads/issue-58",
      },
    });
    const receipt = {
      boundary: "report" as const,
      operationId: "merge-prompt",
      intent: { base: "main", head: "issue-58" },
    };
    lifecycle.beginMutationReceipt(task.id, {
      ...receipt,
      queryObservedAt: "2026-07-18T09:05:00.000Z",
      queryResult: { merged: false },
    });
    lifecycle.claimMutationReceipt(task.id, receipt);
    const promptPath = join(harness.root, "private-prompt.txt");

    await harness.runner({
      dependencies: {
        buildEnv: () => ({
          PATH: process.env.PATH ?? "",
          MINIME_TEST_PRIVATE_PROMPT_PATH: promptPath,
        }),
      },
    }).runAttempt(task.id);

    const prompt = readFileSync(promptPath, "utf8");
    assert.match(prompt, /Normalized resource: host:local \(host\)/);
    assert.match(prompt, /repository=github:example\/minime-bot/);
    assert.match(prompt, /branch=refs\/heads\/issue-58/);
    assert.match(prompt, /checkpoint-prompt/);
    assert.match(prompt, /Repository inspection reached the merge boundary/);
    assert.match(prompt, /merge-prompt.*mutation-started/);
    assert.ok(Buffer.byteLength(prompt, "utf8") <= OPS_WORKER_PI_LIMITS.maxPromptBytes);
  });

  it("fails closed instead of falling back after primary context assembly failure", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("empty-context"));

    const result = await harness.runner({
      dependencies: { assembleContext: () => null },
    }).runAttempt("empty-context");

    assert.equal(result.state, "RESUMABLE");
    assert.match(result.lastOutcome?.summary ?? "", /refusing a smaller fallback/);
    assert.equal(harness.invocations.length, 0);
  });

  it("stops before provider work when the loaded capability manifest mismatches", async (t) => {
    let checkCalls = 0;
    const harness = await makeHarness(t, () => {
      checkCalls += 1;
      return { result: "PASS", summary: "Should not run after parity failure." };
    });
    harness.store.create(makeTask("parity-mismatch"));
    harness.setScenario("parity-mismatch");

    const result = await harness.runner().runAttempt("parity-mismatch");

    assert.equal(result.state, "RESUMABLE");
    assert.equal(result.lastOutcome?.result, "CRASH");
    assert.match(result.lastOutcome?.summary ?? "", /parity failed: TOOLS/);
    assert.equal(result.rounds.remediation, 0);
    assert.equal(checkCalls, 0);
    assert.equal(harness.invocations.length, 1);
    const parityEvidence = result.evidence.find((entry) =>
      entry.summary.includes("Pi parity v1 MISMATCH"));
    assert.ok(parityEvidence);
    assert.match(parityEvidence.summary, /primary-context=sha256:[a-f0-9]{64}/);
    assert.match(parityEvidence.summary, /capabilities=sha256:[a-f0-9]{64}/);
    assert.equal(parityEvidence.summary.includes(harness.primaryWorkspace), false);
    assert.equal(parityEvidence.summary.includes("PRIMARY_USER_CONTEXT"), false);
  });

  it("treats exit success as a claim and a failed done check as remediation", async (t) => {
    const harness = await makeHarness(t, () => ({
      result: "PRODUCT_FAILURE",
      summary: "Synthetic state still requires repair.",
    }));
    harness.store.create(makeTask("success-failed-check", {
      objective: "--model payload-selected-model",
    }));

    const result = await harness.runner().runAttempt("success-failed-check");

    assert.equal(result.state, "RESUMABLE");
    assert.equal(result.rounds.remediation, 1);
    assert.equal(result.lastOutcome?.result, "PRODUCT_FAILURE");
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
    assert.equal(args[args.indexOf("--tools") + 1], PRIMARY_TOOL_NAMES.join(","));
    const appended = args.flatMap((arg, index) =>
      arg === "--append-system-prompt" ? [args[index + 1]] : []);
    assert.match(appended[1], /Do not use sudo or perform irreversible deletion/);
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
    await harness.supervisor.requestDoneCheck("check-without-claim");

    const result = await harness.runner().runNext();

    assert.equal(result?.state, "DONE");
    assert.equal(result?.lastOutcome?.result, "PASS");
    assert.equal(harness.invocations.length, 0);
  });

  it("runs one exact-configuration quota smoke probe and refreshes quota waits", async (t) => {
    const gate: OpsWorkerQuotaAdmissionGate = { check: () => admittedQuota() };
    const harness = await makeHarness(t, undefined, { quotaAdmission: gate });
    const task = makeTask("exact-quota-probe");
    task.state = "RESUMABLE";
    task.custody = {
      status: "HELD",
      claimedAt: task.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
    task.lastOutcome = {
      at: task.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic authoritative quota wait.",
    };
    harness.store.create(task);
    let request: OpsWorkerQuotaProbeRequest | undefined;
    const sampled = quotaSnapshot();
    const runner = harness.runner({
      dependencies: {
        runQuotaProbe: async (value) => {
          request = value;
          return { status: "SUCCESS", snapshot: sampled };
        },
      },
    });

    const resumed = await runner.runNext();
    assert.equal(resumed?.lastOutcome?.result, "QUOTA_PROBE_PASS");
    assert.equal(resumed?.custody.status, "HELD");
    assert.equal(resumed?.rounds.consecutiveInfrastructureFailures, 0);
    if (!request) throw new Error("Quota probe request was not captured");
    const probeRequest = request as OpsWorkerQuotaProbeRequest;
    assert.equal(probeRequest.model, "openai-codex/gpt-5.5");
    assert.equal(probeRequest.thinking, "medium");
    assert.equal(probeRequest.resources.digest, harness.primaryResources.digest);
    assert.ok(probeRequest.args.includes("--no-session"));
    assert.equal(
      probeRequest.args[probeRequest.args.indexOf("--model") + 1],
      "openai-codex/gpt-5.5",
    );
    assert.equal(
      probeRequest.args[probeRequest.args.indexOf("--thinking") + 1],
      "medium",
    );
    assert.equal(
      probeRequest.args[probeRequest.args.indexOf("--tools") + 1],
      PRIMARY_TOOL_NAMES.join(","),
    );
    const extensions = probeRequest.args.flatMap((arg, index) =>
      arg === "--extension" ? [probeRequest.args[index + 1]] : []);
    assert.equal(extensions.slice(0, -1).length, harness.primaryResources.extensionPaths.length);
    for (const extension of extensions.slice(0, -1)) {
      assert.match(extension, /parity-extension-\d+\.mjs$/);
    }
    assert.match(extensions.at(-1) ?? "", /parity-gate\.mjs$/);
    assert.deepEqual(
      probeRequest.args.flatMap((arg, index) =>
        arg === "--skill" ? [probeRequest.args[index + 1]] : []),
      harness.primaryResources.skillPaths,
    );

    harness.supervisor.cancelTask(task.id, "Exercise another probe result");
    const quotaAgain = makeTask("exact-quota-probe-again");
    quotaAgain.state = "RESUMABLE";
    quotaAgain.custody = {
      status: "HELD",
      claimedAt: quotaAgain.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
    quotaAgain.lastOutcome = {
      at: quotaAgain.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic rolling quota wait.",
    };
    harness.store.create(quotaAgain);
    const quotaResult = await harness.runner({
      dependencies: {
        runQuotaProbe: async () => ({ status: "QUOTA", snapshot: sampled }),
      },
    }).runNext();
    assert.equal(quotaResult?.lastOutcome?.result, "QUOTA");
    assert.equal(quotaResult?.schedule.nextRunAt, sampled.windows["5h"].resetAt);
    assert.equal(quotaResult?.custody.status, "HELD");
    assert.equal(quotaResult?.rounds.consecutiveInfrastructureFailures, 0);
  });

  it("binds a fresh quota probe proof to exact launch configuration and consumes it once", async (t) => {
    const gate: OpsWorkerQuotaAdmissionGate = { check: () => admittedQuota() };
    const harness = await makeHarness(t, undefined, { quotaAdmission: gate });
    const task = makeTask("bound-quota-probe-proof");
    task.state = "RESUMABLE";
    task.custody = {
      status: "HELD",
      claimedAt: task.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
    task.lastOutcome = {
      at: task.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic quota wait requiring an exact proof.",
    };
    harness.store.create(task);
    const successfulProbe = {
      runQuotaProbe: async () => ({
        status: "SUCCESS" as const,
        snapshot: quotaSnapshot(),
      }),
    };

    const initialProof = await harness.runner({
      dependencies: successfulProbe,
    }).runNext();
    const initialSubject = initialProof?.lastOutcome?.quotaProbeProof?.subjectHash;
    assert.match(initialSubject ?? "", /^sha256:[a-f0-9]{64}$/);

    const changedModel = "openai-codex/gpt-5.5-mini";
    const modelMismatch = await harness.runner({ model: changedModel }).runNext();
    assert.equal(modelMismatch?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.equal(harness.children.length, 0);

    const modelProof = await harness.runner({
      model: changedModel,
      dependencies: successfulProbe,
    }).runNext();
    const modelSubject = modelProof?.lastOutcome?.quotaProbeProof?.subjectHash;
    assert.match(modelSubject ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(modelSubject, initialSubject);

    writeFileSync(
      join(harness.primaryWorkspace, "USER.md"),
      "CHANGED_PRIMARY_USER_CONTEXT\n",
      "utf8",
    );
    const contextMismatch = await harness.runner({ model: changedModel }).runNext();
    assert.equal(contextMismatch?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.equal(harness.children.length, 0);

    const contextProof = await harness.runner({
      model: changedModel,
      dependencies: successfulProbe,
    }).runNext();
    const contextSubject = contextProof?.lastOutcome?.quotaProbeProof?.subjectHash;
    assert.match(contextSubject ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(contextSubject, modelSubject);

    const completed = await harness.runner({ model: changedModel }).runNext();
    assert.equal(completed?.state, "DONE");
    assert.equal(completed?.lastOutcome?.result, "PASS");
    assert.equal(completed?.lastOutcome?.quotaProbeProof, undefined);
    assert.equal(harness.children.length, 1);
  });

  it("rejects a mismatched unclaimed quota proof before taking custody", async (t) => {
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    const gate: OpsWorkerQuotaAdmissionGate = { check: () => deniedQuota(dueAt) };
    const harness = await makeHarness(t, undefined, { quotaAdmission: gate });
    const task = makeTask("unclaimed-bound-quota-proof");
    task.schedule.nextRunAt = dueAt;
    task.lastOutcome = {
      at: task.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA_ADMISSION_WAIT",
      summary: "Synthetic unclaimed authoritative quota wait.",
    };
    harness.store.create(task);
    harness.setScenario("quota-probe-success");

    const proof = await harness.runner().runNext();
    assert.equal(proof?.lastOutcome?.result, "QUOTA_PROBE_PASS");
    assert.equal(proof?.custody.status, "UNCLAIMED");
    assert.equal(harness.children.length, 1);

    const rejected = await harness.runner({
      model: "openai-codex/gpt-5.5-mini",
    }).runNext();
    assert.equal(rejected?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.equal(rejected?.custody.status, "UNCLAIMED");
    assert.equal(rejected?.custody.claimedAt, null);
    assert.equal(harness.children.length, 1);
  });

  it("refuses a normal spawn when authorization-covered task state changes after preparation", async (t) => {
    const harness = await makeHarness(t);
    const task = makeTask("atomic-launch-authorization-fence");
    harness.store.create(task);
    let changed = false;

    const result = await harness.runner({
      dependencies: {
        assembleContext: (agent, options) => {
          const context = assemblePiContext(agent, options);
          if (!changed) {
            changed = true;
            harness.store.mutate(
              task.id,
              { event: "UPDATED", summary: "Changed authorization subject before launch fence" },
              (replacement) => {
                replacement.updatedAt = new Date(
                  Date.parse(replacement.updatedAt) + 1,
                ).toISOString();
                replacement.lifecycle.repository = "github:example/changed";
              },
            );
          }
          return context;
        },
      },
    }).runAttempt(task.id);

    assert.equal(result.state, "QUEUED");
    assert.equal(result.custody.status, "HELD");
    assert.equal(result.unverifiedRun, null);
    assert.equal(result.activeRun, null);
    assert.equal(hasFreshOpsWorkerAuthorizationPass(result), false);
    assert.equal(harness.children.length, 0);
  });

  it("refuses a quota-probe spawn when its prepared task revision changes", async (t) => {
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    const gate: OpsWorkerQuotaAdmissionGate = { check: () => deniedQuota(dueAt) };
    const harness = await makeHarness(t, undefined, { quotaAdmission: gate });
    const task = makeTask("atomic-quota-probe-launch-fence");
    task.schedule.nextRunAt = dueAt;
    task.lastOutcome = {
      at: task.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA_ADMISSION_WAIT",
      summary: "Synthetic due quota wait for a launch-fence race.",
    };
    harness.store.create(task);
    let changed = false;

    const result = await harness.runner({
      dependencies: {
        resolveInvocation: (args) => {
          if (!changed) {
            changed = true;
            harness.store.mutate(
              task.id,
              { event: "UPDATED", summary: "Changed quota-probe task before launch fence" },
              (replacement) => {
                replacement.updatedAt = new Date(
                  Date.parse(replacement.updatedAt) + 1,
                ).toISOString();
                replacement.lifecycle.repository = "github:example/quota-changed";
              },
            );
          }
          return {
            command: process.execPath,
            args: ["--import", TSX_IMPORT, FAKE_PI_PROCESS, "quota-probe-success", ...args],
          };
        },
      },
    }).runNext();

    assert.equal(result?.state, "QUEUED");
    assert.equal(result?.custody.status, "UNCLAIMED");
    assert.equal(result?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.equal(result?.unverifiedRun, null);
    assert.equal(harness.children.length, 0);
  });

  it("revalidates again immediately before spawning held and unclaimed quota probes", async (t) => {
    const statuses: Array<"PASS" | "DRIFT" | "QUERY_ERROR"> = [];
    let verificationCalls = 0;
    const verifier: OpsWorkerAuthorizationVerifier = {
      identity: "quota-probe-runner-authorization",
      version: "1",
      verify: () => {
        verificationCalls += 1;
        const status = statuses.shift() ?? "QUERY_ERROR";
        return {
          status,
          evidenceHash: `sha256:${"8".repeat(64)}`,
          summary: `Synthetic runner quota probe authorization ${status}`,
        };
      },
    };
    let quota = admittedQuota();
    const harness = await makeHarness(t, undefined, {
      authorizationVerifiers: {
        ...fixtureAuthorizationVerifiers,
        "operator-cli": verifier,
      },
      quotaAdmission: { check: () => quota },
    });
    const held = makeTask("held-quota-probe-revalidation");
    held.state = "RESUMABLE";
    held.custody = {
      status: "HELD",
      claimedAt: held.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
    held.lastOutcome = {
      at: held.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic held quota wait",
    };
    harness.store.create(held);
    statuses.push("PASS", "DRIFT");

    const blocked = await harness.runner().runNext();
    assert.equal(blocked?.state, "BLOCKED");
    assert.equal(blocked?.authorizationVerification?.status, "DRIFT");
    assert.equal(harness.invocations.length, 0);
    assert.equal(verificationCalls, 2);

    const dueAt = new Date(Date.now() - 1_000).toISOString();
    quota = deniedQuota(dueAt);
    const unclaimed = makeTask("unclaimed-quota-probe-revalidation");
    unclaimed.schedule.nextRunAt = dueAt;
    unclaimed.lastOutcome = {
      at: unclaimed.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA_ADMISSION_WAIT",
      summary: "Synthetic unclaimed authoritative quota wait",
    };
    harness.store.create(unclaimed);
    statuses.push("PASS", "QUERY_ERROR");

    const queryError = await harness.runner().runNext();
    assert.equal(queryError?.state, "QUEUED");
    assert.equal(queryError?.custody.status, "UNCLAIMED");
    assert.equal(queryError?.authorizationVerification?.status, "QUERY_ERROR");
    assert.equal(queryError?.lastOutcome?.kind, "AUTHORIZATION");
    assert.equal(harness.invocations.length, 0);
    assert.equal(verificationCalls, 4);
  });

  it("runs a due reset probe without claiming whole-cycle custody", async (t) => {
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    const gate: OpsWorkerQuotaAdmissionGate = { check: () => deniedQuota(dueAt) };
    const harness = await makeHarness(t, undefined, { quotaAdmission: gate });
    const task = makeTask("unclaimed-quota-reset-probe");
    task.schedule.nextRunAt = dueAt;
    task.lastOutcome = {
      at: task.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA_ADMISSION_WAIT",
      summary: "Synthetic unclaimed authoritative quota wait.",
    };
    harness.store.create(task);
    harness.setScenario("quota-probe-success");

    const result = await harness.runner().runNext();

    assert.equal(result?.state, "QUEUED");
    assert.equal(result?.custody.status, "UNCLAIMED");
    assert.equal(result?.lastOutcome?.result, "QUOTA_PROBE_PASS");
    assert.equal(result?.schedule.nextRunAt, null);
    assert.equal(result?.activeRun, null);
    assert.equal(result?.unverifiedRun, null);
    assert.equal(harness.invocations.length, 1);
  });

  it("contains held and unclaimed quota-probe preparation failures", async (t) => {
    let quota = admittedQuota();
    const harness = await makeHarness(t, undefined, {
      quotaAdmission: { check: () => quota },
    });
    const held = makeTask("held-quota-preparation-error");
    held.state = "RESUMABLE";
    held.custody = {
      status: "HELD",
      claimedAt: held.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
    held.lastOutcome = {
      at: held.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic held quota wait",
    };
    harness.store.create(held);

    const heldError = await harness.runner({
      dependencies: {
        assembleContext: () => {
          throw new Error("Synthetic strict context assembly failure");
        },
      },
    }).runNext();
    assert.equal(heldError?.state, "RESUMABLE");
    assert.equal(heldError?.custody.status, "HELD");
    assert.equal(heldError?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.match(heldError?.lastOutcome?.summary ?? "", /context assembly failure/);
    assert.equal(harness.invocations.length, 0);

    harness.supervisor.cancelTask(held.id, "Exercise unclaimed preparation failure");
    const dueAt = new Date(Date.now() - 1_000).toISOString();
    quota = deniedQuota(dueAt);
    const unclaimed = makeTask("unclaimed-quota-preparation-error");
    unclaimed.schedule.nextRunAt = dueAt;
    unclaimed.lastOutcome = {
      at: unclaimed.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA_ADMISSION_WAIT",
      summary: "Synthetic unclaimed authoritative quota wait",
    };
    harness.store.create(unclaimed);
    const unclaimedRunner = harness.runner();
    const configuredExtra = harness.primaryResources.extensionPaths.at(-1);
    assert.ok(configuredExtra);
    writeFileSync(
      configuredExtra,
      "export default function changedAfterPrimaryPin() {}\n",
      "utf8",
    );

    const unclaimedError = await unclaimedRunner.runNext();
    assert.equal(unclaimedError?.state, "QUEUED");
    assert.equal(unclaimedError?.custody.status, "UNCLAIMED");
    assert.equal(unclaimedError?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.match(unclaimedError?.lastOutcome?.summary ?? "", /hashes are inconsistent/);
    assert.equal(harness.invocations.length, 0);
  });

  it("executes the bounded probe child through parity and attempt-scoped quota capture", async (t) => {
    const gate: OpsWorkerQuotaAdmissionGate = { check: () => admittedQuota() };
    const harness = await makeHarness(t, undefined, { quotaAdmission: gate });
    const task = makeTask("bounded-quota-probe-child");
    task.state = "RESUMABLE";
    task.custody = {
      status: "HELD",
      claimedAt: task.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
    task.lastOutcome = {
      at: task.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic quota wait for the package-owned probe child.",
    };
    harness.store.create(task);
    harness.setScenario("quota-probe-success");
    let probeSpawnOptions: Parameters<NonNullable<OpsWorkerPiAttemptDependencies["spawnProcess"]>>[2]
      | undefined;

    const result = await harness.runner({
      dependencies: {
        spawnProcess: (command, args, options) => {
          probeSpawnOptions = options;
          return spawn(command, args, options);
        },
      },
    }).runNext();

    assert.equal(result?.lastOutcome?.result, "QUOTA_PROBE_PASS");
    assert.equal(result?.custody.status, "HELD");
    assert.equal(harness.invocations.length, 1);
    assert.ok(harness.invocations[0].includes("--no-session"));
    assert.equal(probeSpawnOptions?.detached, true);
    assert.equal(
      (probeSpawnOptions?.env as Record<string, string> | undefined)
        ?.MINIME_OPS_WORKER_QUOTA_PROBE,
      "1",
    );
    assert.equal(
      (probeSpawnOptions?.env as Record<string, string> | undefined)?.NODE_OPTIONS,
      OPS_WORKER_NODE_OPTIONS,
    );
    assert.equal(
      harness.invocations[0][harness.invocations[0].indexOf("--model") + 1],
      "openai-codex/gpt-5.5",
    );
    assert.equal(
      harness.invocations[0][harness.invocations[0].indexOf("--thinking") + 1],
      "medium",
    );
    assert.equal(
      readdirSync(join(harness.supervisor.stateDirectory, "sessions", task.id))
        .some((name) => name === "quota-smoke-telemetry.json"),
      false,
    );

    harness.supervisor.cancelTask(task.id, "Exercise a typed quota probe response");
    const quotaAgain = makeTask("bounded-quota-probe-child-quota");
    quotaAgain.state = "RESUMABLE";
    quotaAgain.custody = {
      status: "HELD",
      claimedAt: quotaAgain.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
    quotaAgain.lastOutcome = {
      at: quotaAgain.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic rolling quota wait for the package-owned probe child.",
    };
    harness.store.create(quotaAgain);
    harness.setScenario("quota-probe-quota-clean-exit");

    const refreshed = await harness.runner().runNext();
    assert.equal(refreshed?.lastOutcome?.result, "QUOTA");
    assert.equal(refreshed?.custody.status, "HELD");
    assert.equal(refreshed?.rounds.consecutiveInfrastructureFailures, 0);
    assert.ok(refreshed?.schedule.nextRunAt);

    harness.supervisor.cancelTask(quotaAgain.id, "Exercise a non-2xx probe response");
    const serverError = makeTask("bounded-quota-probe-child-server-error");
    serverError.state = "RESUMABLE";
    serverError.custody = {
      status: "HELD",
      claimedAt: serverError.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
    serverError.lastOutcome = {
      at: serverError.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic quota wait before a provider server error.",
    };
    harness.store.create(serverError);
    harness.setScenario("quota-probe-server-error");

    const rejected = await harness.runner().runNext();
    assert.equal(rejected?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.match(rejected?.lastOutcome?.summary ?? "", /provider HTTP 503/);
    assert.equal(rejected?.lastOutcome?.quotaProbeProof, undefined);
  });

  it("durably fences and safely stops an owned quota probe process group", async (t) => {
    const gate: OpsWorkerQuotaAdmissionGate = { check: () => admittedQuota() };
    const harness = await makeHarness(t, undefined, { quotaAdmission: gate });
    const task = makeTask("owned-quota-probe-fence");
    task.state = "RESUMABLE";
    task.custody = {
      status: "HELD",
      claimedAt: task.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
    task.lastOutcome = {
      at: task.updatedAt,
      kind: "INFRASTRUCTURE",
      result: "QUOTA",
      summary: "Synthetic quota wait for durable probe ownership.",
    };
    harness.store.create(task);
    harness.setScenario("quota-probe-wait");
    const controller = new AbortController();
    const running = harness.runner({ abortSignal: controller.signal }).runNext();
    await waitFor(() => harness.supervisor.getTask(task.id)?.state === "RUNNING");
    const active = harness.supervisor.getTask(task.id)?.activeRun;
    assert.ok(active);
    assert.match(active.attemptId, /^quota-probe-/);
    assert.equal(active.pid, active.processGroupId);
    assert.equal(inspectOpsWorkerActiveRun(active).status, "OWNED");

    controller.abort();
    const result = await running;

    assert.equal(result?.state, "RESUMABLE", JSON.stringify(result?.lastOutcome));
    assert.equal(result?.lastOutcome?.result, "QUOTA_PROBE_ERROR");
    assert.match(result?.lastOutcome?.summary ?? "", /worker shutdown/);
    assert.equal(result?.activeRun, null);
    assert.equal(result?.unverifiedRun, null);
    assert.equal(result?.custody.status, "HELD");
    assert.equal(inspectOpsWorkerActiveRun(active).status, "GONE");
  });

  it("keeps scheduling when checkpoint liveness makes a done-check result stale", async (t) => {
    let checkCalls = 0;
    let resolveFirstCheck: ((result: unknown) => void) | undefined;
    const harness = await makeHarness(t, () => {
      checkCalls += 1;
      if (checkCalls === 1) {
        return new Promise<unknown>((resolveCheck) => {
          resolveFirstCheck = resolveCheck;
        });
      }
      return {
        result: "PASS",
        summary: "Fresh fixture pass after checkpoint liveness.",
      };
    });
    const task = makeTask("stale-checkpoint-check");
    harness.store.create(task);
    await harness.supervisor.requestDoneCheck(task.id);

    const pending = harness.runner().runNext();
    await waitFor(() => resolveFirstCheck !== undefined);
    new OpsWorkerLifecycle(harness.store).recordCheckpoint(task.id, {
      checkpointId: "checkpoint-during-check",
      payload: { progress: "still-live" },
      summary: "Lifecycle progress arrived during deterministic verification.",
    });
    assert.ok(resolveFirstCheck);
    resolveFirstCheck({ result: "PASS", summary: "Stale fixture pass." });

    const stale = await pending;
    assert.equal(stale?.state, "CHECKING");
    assert.equal(stale?.currentCheckpoint?.checkpointId, "checkpoint-during-check");
    const completed = await harness.runner().runNext();
    assert.equal(completed?.state, "DONE");
    assert.equal(checkCalls, 2);
  });

  it("keeps scheduling when a checkpoint makes the post-attempt done check stale", async (t) => {
    let checkCalls = 0;
    let resolveFirstCheck: ((result: unknown) => void) | undefined;
    const harness = await makeHarness(t, () => {
      checkCalls += 1;
      if (checkCalls === 1) {
        return new Promise<unknown>((resolveCheck) => {
          resolveFirstCheck = resolveCheck;
        });
      }
      return {
        result: "PASS",
        summary: "Fresh fixture pass after post-attempt checkpoint liveness.",
      };
    });
    const task = makeTask("stale-post-attempt-check");
    harness.store.create(task);
    const runner = harness.runner();

    const pending = runner.runAttempt(task.id);
    await waitFor(() => resolveFirstCheck !== undefined, 5_000);
    new OpsWorkerLifecycle(harness.store).recordCheckpoint(task.id, {
      checkpointId: "checkpoint-during-post-attempt-check",
      payload: { progress: "still-live" },
      summary: "Lifecycle progress arrived during post-attempt verification.",
    });
    assert.ok(resolveFirstCheck);
    resolveFirstCheck({ result: "PASS", summary: "Stale fixture pass." });

    const stale = await pending;
    assert.equal(stale.state, "CHECKING");
    assert.equal(
      stale.currentCheckpoint?.checkpointId,
      "checkpoint-during-post-attempt-check",
    );
    const completed = await runner.runNext();
    assert.equal(completed?.state, "DONE");
    assert.equal(checkCalls, 2);
  });

  it("rejects an early parity PASS that exits before parent persistence and acknowledgement", async (t) => {
    let checkCalls = 0;
    const harness = await makeHarness(t, () => {
      checkCalls += 1;
      return {
        result: "PASS",
        summary: "Must not run for an unacknowledged parity report.",
      };
    });
    const task = makeTask("stale-early-exit-check");
    harness.store.create(task);
    const runner = harness.runner({
      dependencies: {
        spawnProcess: (_command, _args, options) => {
          const env = options.env as Record<string, string>;
          const expected = JSON.parse(readFileSync(
            env.MINIME_OPS_WORKER_PARITY_EXPECTED_PATH,
            "utf8",
          )) as {
            version: 1;
            digest: string;
            primaryContextDigest: string;
            capabilityDigest: string;
            extensionsDigest: string;
            skillsDigest: string;
            toolsDigest: string;
            customPromptHash: string | null;
            appendSystemPromptHash: string;
            contextFilesDigest: string;
          };
          writeFileSync(
            env.MINIME_OPS_WORKER_PARITY_REPORT_PATH,
            `${JSON.stringify({
              version: expected.version,
              status: "PASS",
              expectedDigest: expected.digest,
              primaryContextDigest: expected.primaryContextDigest,
              actualContextDigest: opsWorkerEffectiveContextDigest(expected),
              actualSystemPromptHash: `sha256:${"c".repeat(64)}`,
              actualCapabilityDigest: expected.capabilityDigest,
              actualExtensionsDigest: expected.extensionsDigest,
              actualSkillsDigest: expected.skillsDigest,
              actualToolsDigest: expected.toolsDigest,
              mismatch: [],
            })}\n`,
            "utf8",
          );
          const child = new EventEmitter() as ChildProcess;
          Object.assign(child, {
            pid: 600_002,
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            exitCode: null,
            signalCode: null,
            unref: () => child,
          });
          queueMicrotask(() => child.emit("close", 0, null));
          return child;
        },
        readProcessIdentity: () => ({ status: "GONE" }),
        inspectProcessGroup: () => ({ status: "GONE" }),
      },
    });

    const result = await runner.runAttempt(task.id);
    assert.equal(result.state, "RESUMABLE");
    assert.equal(result.lastOutcome?.result, "CRASH");
    assert.match(
      result.lastOutcome?.summary ?? "",
      /before parent persistence and acknowledgement/,
    );
    assert.equal(checkCalls, 0);
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
    harness.store.create(makeTask("classify-successor", {
      sourceKind: "authorized-issue",
    }));
    const cases = [
      ["quota", "QUOTA"],
      ["quota-clean-exit", "QUOTA"],
      ["server-error-clean-exit", "CRASH"],
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
      assert.equal(result.custody.status, "HELD");
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
      if (expected === "QUOTA") {
        assert.equal(harness.supervisor.selectNextTask(), undefined);
        assert.ok(result.schedule.nextRunAt);
        assert.ok(Date.parse(result.schedule.nextRunAt) > Date.now());
      } else {
        assert.equal(harness.supervisor.selectNextTask()?.task.id, taskId);
      }
      harness.supervisor.cancelTask(taskId, "Release fixture custody");
    }
  });

  it("fails closed when a clean attempt has no response telemetry", async (t) => {
    const harness = await makeHarness(t);
    const task = makeTask("clean-exit-without-telemetry");
    harness.store.create(task);
    harness.setScenario("success-missing-telemetry");

    const result = await harness.runner().runAttempt(task.id);

    assert.equal(result.state, "RESUMABLE");
    assert.equal(result.lastOutcome?.result, "QUOTA_TELEMETRY_ERROR");
    assert.match(result.lastOutcome?.summary ?? "", /without valid attempt response telemetry/);
    assert.equal(result.rounds.remediation, 0);
    assert.equal(result.custody.status, "HELD");
    assert.ok(result.schedule.nextRunAt);
  });

  it("retains custody and durable progress after a child rc=1", async (t) => {
    const harness = await makeHarness(t);
    const task = makeTask("rc-one-after-progress");
    harness.store.create(task);
    new OpsWorkerLifecycle(harness.store).recordCheckpoint(task.id, {
      checkpointId: "durable-progress-before-rc-one",
      payload: { phase: "repair-applied", generation: 1 },
      summary: "A safe remediation checkpoint was durable before child exit.",
    });
    harness.setScenario("network");

    const result = await harness.runner().runAttempt(task.id);

    assert.equal(result.state, "RESUMABLE");
    assert.equal(result.lastOutcome?.result, "NETWORK");
    assert.equal(result.currentCheckpoint?.checkpointId, "durable-progress-before-rc-one");
    assert.equal(result.rounds.remediation, 0);
    assert.equal(result.custody.status, "HELD");
    assert.equal(result.custody.releasedAt, null);
    assert.equal(harness.supervisor.selectNextTask()?.task.id, task.id);
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

  it("revalidates authorization before a fresh launch after corrupt-session reset", async (t) => {
    const statuses: Array<"PASS" | "DRIFT"> = [];
    let verificationCalls = 0;
    const verifier: OpsWorkerAuthorizationVerifier = {
      identity: "session-reset-authorization",
      version: "1",
      verify: () => {
        verificationCalls += 1;
        const status = statuses.shift() ?? "PASS";
        return {
          status,
          evidenceHash: `sha256:${"7".repeat(64)}`,
          summary: `Synthetic session-reset authorization ${status}`,
        };
      },
    };
    const harness = await makeHarness(t, undefined, {
      authorizationVerifiers: {
        ...fixtureAuthorizationVerifiers,
        "operator-cli": verifier,
      },
    });
    harness.store.create(makeTask("corrupt-session-drift"));
    harness.setScenario("crash");
    const crashed = await harness.runner().runAttempt("corrupt-session-drift");
    const oldSessionId = crashed.session.sessionId as string;
    const sessionDirectory = join(
      harness.supervisor.stateDirectory,
      "sessions",
      "corrupt-session-drift",
    );
    const sessionFile = readdirSync(sessionDirectory)
      .find((file) => file.endsWith(".jsonl") && file.includes(oldSessionId));
    assert.ok(sessionFile);
    writeFileSync(join(sessionDirectory, sessionFile), "not-json\n", "utf8");
    statuses.push("PASS", "DRIFT");

    harness.setScenario("success");
    const blocked = await harness.runner().runAttempt("corrupt-session-drift");

    assert.equal(blocked.state, "BLOCKED");
    assert.equal(blocked.authorizationVerification?.status, "DRIFT");
    assert.notEqual(blocked.session.sessionId, oldSessionId);
    assert.equal(blocked.custody.status, "RELEASED");
    assert.equal(harness.invocations.length, 1);
    assert.equal(verificationCalls, 4);
  });

  it("keeps an interrupted owner ahead of a queued higher-priority task", async (t) => {
    const harness = await makeHarness(t);
    harness.store.create(makeTask("low-priority", {
      sourceKind: "authorized-issue",
    }));
    harness.setScenario("wait");
    const controller = new AbortController();
    const runner = harness.runner({ abortSignal: controller.signal });
    const running = runner.runAttempt("low-priority");
    await waitFor(() => harness.supervisor.getTask("low-priority")?.state === "RUNNING");
    const active = harness.supervisor.getTask("low-priority")?.activeRun;
    const claimedAt = harness.supervisor.getTask("low-priority")?.custody.claimedAt;
    assert.ok(active);
    assert.equal(active.pid, active.processGroupId);
    assert.equal(inspectOpsWorkerActiveRun(active).status, "OWNED");

    harness.store.create(makeTask("urgent", { sourceKind: "alertmanager" }));
    await new Promise((resolveWait) => setTimeout(resolveWait, 75));
    assert.equal(harness.supervisor.getTask("low-priority")?.state, "RUNNING");
    assert.equal(await harness.runner().runNext(), undefined);

    controller.abort();
    const interrupted = await running;
    assert.equal(interrupted.state, "RESUMABLE", JSON.stringify(interrupted.lastOutcome));
    assert.equal(interrupted.lastOutcome?.result, "CRASH");
    assert.match(interrupted.lastOutcome?.summary ?? "", /worker shutdown/);
    assert.equal(interrupted.custody.status, "HELD");
    assert.equal(interrupted.custody.claimedAt, claimedAt);
    assert.equal(interrupted.rounds.remediation, 0);
    assert.equal(interrupted.activeRun, null);
    assert.equal(harness.supervisor.getTask("urgent")?.state, "QUEUED");
    assert.equal(inspectOpsWorkerActiveRun(active).status, "GONE");
    assert.equal(harness.supervisor.selectNextTask()?.task.id, "low-priority");
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

  it("counts an authoritative checkpoint snapshot write as attempt progress", async (t) => {
    const harness = await makeHarness(t);
    const task = makeTask("checkpoint-progress");
    harness.store.create(task);
    harness.setScenario("wait");
    let clockNow = 0;
    interface ScheduledTimer {
      at: number;
      callback: () => void;
      cancelled: boolean;
    }
    const timers = new Set<ScheduledTimer>();
    const stallMonitorClock = {
      now: (): number => clockNow,
      setTimeout(callback: () => void, milliseconds: number): ScheduledTimer {
        const timer = { at: clockNow + milliseconds, callback, cancelled: false };
        timers.add(timer);
        return timer;
      },
      clearTimeout(handle: unknown): void {
        (handle as ScheduledTimer).cancelled = true;
        timers.delete(handle as ScheduledTimer);
      },
    };
    const advanceClock = async (milliseconds: number): Promise<void> => {
      clockNow += milliseconds;
      while (true) {
        const due = [...timers]
          .filter((timer) => !timer.cancelled && timer.at <= clockNow)
          .sort((left, right) => left.at - right.at)[0];
        if (!due) break;
        timers.delete(due);
        due.callback();
        await Promise.resolve();
      }
      await new Promise((resolve) => setImmediate(resolve));
    };
    const running = harness.runner({
      attemptTimeoutMs: 10_000,
      stallTimeoutMs: 200,
      dependencies: { stallMonitorClock },
    }).runAttempt(task.id);
    await waitFor(() => harness.supervisor.getTask(task.id)?.state === "RUNNING");
    await waitFor(() => timers.size > 0, 5_000);
    new OpsWorkerLifecycle(harness.store).recordCheckpoint(task.id, {
      checkpointId: "checkpoint-live",
      payload: { progress: 1 },
      summary: "A durable package-owned progress checkpoint.",
    });
    const taskSnapshotPath = join(
      harness.supervisor.stateDirectory,
      "tasks",
      `${task.id}.json`,
    );
    const futureMtime = new Date(Date.now() + 10_000);
    utimesSync(taskSnapshotPath, futureMtime, futureMtime);

    await advanceClock(200);
    await advanceClock(199);

    assert.equal(harness.supervisor.getTask(task.id)?.state, "RUNNING");
    await advanceClock(1);
    const result = await running;
    assert.equal(result.state, "RESUMABLE", JSON.stringify(result.lastOutcome));
    assert.equal(result.lastOutcome?.result, "STALL");
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

  it("abandons child handles after ambiguous shutdown", async (t) => {
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
    assert.equal(result.custody.status, "HELD");
  });

  it("interrupts the deterministic check after a natural Pi success", async (t) => {
    let markCheckStarted: (() => void) | undefined;
    const checkStarted = new Promise<void>((resolveStarted) => {
      markCheckStarted = resolveStarted;
    });
    const harness = await makeHarness(t, () => {
      markCheckStarted?.();
      return new Promise<unknown>(() => undefined);
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
    harness.supervisor.cancelTask("spawn-throws", "Release fixture custody");

    harness.store.create(makeTask("identity-gone"));
    harness.setScenario("success");
    const identityGone = await harness.runner({
      dependencies: { readProcessIdentity: () => ({ status: "GONE" }) },
    }).runAttempt("identity-gone");
    assert.equal(identityGone.state, "BLOCKED");
    assert.equal(identityGone.lastOutcome?.result, "AMBIGUOUS_ORPHAN");
    assert.equal(identityGone.activeRun, null);
    assert.ok(identityGone.unverifiedRun);

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
    persisted.custody = {
      status: "HELD",
      claimedAt: persisted.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
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
