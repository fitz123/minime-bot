import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { executeAskAgent, runAskAgentTargetChild } from "../pi-extensions/ask-agent-args.js";
import { resolvePiInvocation } from "../pi-extensions/pi-invocation.js";
import type { SubagentSpawnOptions } from "../pi-extensions/subagent-args.js";
import {
  assemblePiContextForCurrentDeployment,
  buildPiAskAgentChildSpawnEnv,
  MINIME_BOT_PI_SESSION_AGENT_ID_ENV,
  resolvePiAskAgentChildExtensionArgs,
  resolveValidatedPiAgentWorkspaceCwd,
} from "../pi-rpc-protocol.js";
import type { AgentConfig } from "../types.js";

const scratch = fileURLToPath(new URL("../../.tmp/", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/collaboration-provider.ts", import.meta.url));
const callerId = "fixture-caller";
const targetId = "fixture-target";
const model = "openai-codex/fixture";
const question = "CONSULT_ONE";
const answer = "CONSULT_FIRST_DONE";

function consultationAgents(root: string): Record<string, AgentConfig> {
  return {
    [callerId]: {
      id: callerId,
      workspaceCwd: join(root, "caller"),
      model,
      askAgent: { enabled: true, canAsk: [targetId] },
    },
    [targetId]: {
      id: targetId,
      workspaceCwd: join(root, "target"),
      model,
      thinking: "off",
      askAgent: { enabled: true },
    },
  };
}

test("one-shot Ask Agent returns one target-context answer without a durable transcript", { timeout: 30_000 }, async t => {
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(scratch, "ask-agent-offline-"));
  const originalEnv = process.env;
  t.after(() => {
    process.env = originalEnv;
    rmSync(root, { recursive: true, force: true });
  });

  const agents = consultationAgents(root);
  const targetWorkspace = agents[targetId].workspaceCwd;
  process.env = {
    HOME: join(root, "home"),
    PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    TMPDIR: join(root, "tmp"),
    PI_CODING_AGENT_DIR: join(root, "pi"),
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    MINIME_CONTROL_WORKSPACE_ROOT: join(root, "control"),
    [MINIME_BOT_PI_SESSION_AGENT_ID_ENV]: callerId,
  };
  for (const dir of ["home", "tmp", "pi", "sessions", "control", "caller", "target"]) {
    mkdirSync(join(root, dir), { mode: 0o700 });
  }
  writeFileSync(join(agents[callerId].workspaceCwd, "CLAUDE.md"), "Synthetic caller context.\n");
  // The offline provider answers CONSULT_ONE only if it sees this marker in context.
  writeFileSync(join(targetWorkspace, "CLAUDE.md"), "AGENT_CONTEXT_MARKER\n");

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const spawnChild = t.mock.fn((command: string, args: string[], options: SubagentSpawnOptions) => {
    assert.equal(options.cwd, targetWorkspace);
    assert.ok(args.includes("--no-context-files"), "Pi must skip ancestor context discovery");
    const child = spawn(command, args, options);
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    return child;
  });
  const config = { agents, piExtraExtensions: [provider] };
  const result = await executeAskAgent({ agent: targetId, question }, {
    config,
    validateTargetWorkspace: resolveValidatedPiAgentWorkspaceCwd,
    assembleContext: assemblePiContextForCurrentDeployment,
    runTarget: request => runAskAgentTargetChild(request, {
      spawn: spawnChild,
      // Skip Pi's project resource discovery outside the synthetic target workspace.
      resolveInvocation: args => resolvePiInvocation(["--no-approve", ...args]),
      extensionArgs: resolvePiAskAgentChildExtensionArgs({ extraExtensions: config.piExtraExtensions }),
      env: buildPiAskAgentChildSpawnEnv(request.target.workspaceCwd, request.target.id),
      timeoutMs: 20_000,
      abortGraceMs: 1_000,
    }),
    signal: t.signal,
  });

  assert.deepEqual(
    readdirSync(root, { recursive: true }).filter(path => path.endsWith(".jsonl") || path.endsWith("sessions.json")),
    [],
    "Consultation must leave no session transcript or session store",
  );
  assert.equal(spawnChild.mock.callCount(), 1, JSON.stringify(result));
  assert.ifError(spawnChild.mock.calls[0].error);
  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");
  assert.deepEqual(result, {
    ok: true,
    callerAgentId: callerId,
    targetAgentId: targetId,
    result: { answer, truncated: false, needsClarification: false },
  }, `Pi stdout:\n${stdout}\nPi stderr:\n${stderr}`);

  const completions = stdout.trim().split("\n")
    .map(line => JSON.parse(line))
    .filter(event => event.type === "message_end" && event.message?.role === "assistant");
  assert.equal(completions.length, 1);
  assert.equal(`${completions[0].message.provider}/${completions[0].message.model}`, model);
});

test("Ask Agent rejects a worker target before local workspace access or spawn", async t => {
  const agents = consultationAgents(join(scratch, "unused-worker-route"));
  agents[targetId].workerRuntime = {
    socketPath: join(agents[targetId].workspaceCwd, "unused.sock"),
    workerUid: 60_001,
    controllerName: "fixture-controller",
  };
  const validateTargetWorkspace = t.mock.fn(() => assert.fail("Unexpected local workspace validation"));
  const assembleContext = t.mock.fn(() => assert.fail("Unexpected local context assembly"));
  const runTarget = t.mock.fn(async () => assert.fail("Unexpected local child dispatch"));

  const result = await executeAskAgent({ agent: targetId, question }, {
    config: { agents },
    env: { [MINIME_BOT_PI_SESSION_AGENT_ID_ENV]: callerId },
    validateTargetWorkspace,
    assembleContext,
    runTarget,
  });

  assert.equal(validateTargetWorkspace.mock.callCount(), 0);
  assert.equal(assembleContext.mock.callCount(), 0);
  assert.equal(runTarget.mock.callCount(), 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unsupported_runtime");
});
