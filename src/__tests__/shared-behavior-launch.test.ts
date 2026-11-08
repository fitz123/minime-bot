import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { mock, test } from "node:test";
import { sharedBehaviorFixture } from "./shared-behavior-fixture.js";
import { installCronTestEnv } from "./cron-test-env.js";

installCronTestEnv();
const captures: { args: string[]; options: SpawnOptions }[] = [];
mock.module("node:child_process", { namedExports: {
  ...Object.fromEntries(Object.entries(childProcess).filter(([key]) => key !== "default")),
  spawn(_command: string, args: string[], options: SpawnOptions): ChildProcess {
    captures.push({ args, options });
    return Object.assign(new EventEmitter(), {
      stdout: new Readable({ read() {} }), stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk, _encoding, done) { done(); } }),
    }) as ChildProcess;
  },
} });

const { spawnPiRpcSession, spawnPreparedPiRpcSession, buildPiSpawnArgs, buildPiSubagentChildSpawnEnv } = await import("../pi-rpc-protocol.js");
const { assemblePiContext, assemblePiSubagentFoundation, piContextResourceArgs } = await import("../pi-context-assembler.js");
const { buildAskAgentTargetSpawnArgs, executeAskAgent, runAskAgentTargetChild } = await import("../pi-extensions/ask-agent-args.js");
const { buildSubagentSpawnArgs } = await import("../pi-extensions/subagent-args.js");
const { runPi, resolveCronAgentData, buildPiCronAgentConfig } = await import("../cron-runner.js");
const { resolveExplicitInteractiveSessionLocation } = await import("../interactive-session-binding.js");
const { preseedInteractiveSessionBinding } = await import("../interactive-session-seed.js");
const { MINIME_BEHAVIORAL_FOUNDATION_ROOT_ENV: ROOT_ENV } = await import("../behavioral-foundation.js");

const values = (args: string[], flag: string) => args.flatMap((arg, i) => arg === flag ? [args[i + 1]] : []);
const cron = { name: "foundation-fixture", schedule: "0 * * * *", type: "llm" as const, prompt: "Synthetic task", agentId: "example-agent", deliveryChatId: 1 };

test("all managed adapters use the same pinned shared resources; native delegation excludes parent private context", () => {
  const f = sharedBehaviorFixture();
  const binding = preseedInteractiveSessionBinding(resolveExplicitInteractiveSessionLocation(f.workspace, join(f.root, "sessions"), process.getuid!()));
  const context = assemblePiContext(f.agent)!;
  const shared = context.behavioralFoundation!;
  const expectedSkills = shared.skillPaths;
  const before = captures.length;
  spawnPiRpcSession(f.agent, binding, { relpaths: [] });
  const interactive = captures[before];
  assert.equal(interactive.options.env![ROOT_ENV], f.first.root);

  spawnPreparedPiRpcSession({ binding, context, model: f.agent.model, thinking: "off", tools: ["read"], extensions: [], env: {}, offline: true });
  const prepared = captures[before + 1];
  assert.equal(prepared.options.env![ROOT_ENV], f.first.root);

  let cronArgs: string[] = [];
  runPi(cron, f.workspace, {
    buildAgentConfig: () => f.agent, buildEnv: () => ({}), assembleContext: assemblePiContext, resolveExtensionArgs: () => [],
    spawnSync(_command, args, options) {
      cronArgs = [...args];
      assert.equal(options.env![ROOT_ENV], f.first.root);
      return { pid: 1, output: [null, "synthetic answer", ""], stdout: "synthetic answer", stderr: "", status: 0, signal: null };
    },
  });
  const ask = buildAskAgentTargetSpawnArgs(f.agent, "Synthetic question", { callerAgentId: "caller", context });
  const role = assemblePiSubagentFoundation(shared.root, f.workspace, "delegated-role", "SYNTHETIC_DELEGATED_ROLE");
  const delegatedBody = readFileSync(role.appendSystemPromptPath, "utf8");
  assert.match(delegatedBody, /SYNTHETIC_SHARED_RULE/);
  assert.match(delegatedBody, /SYNTHETIC_DELEGATED_ROLE/);
  assert.doesNotMatch(delegatedBody, /SYNTHETIC_PRIVATE_LOCAL_MARKER|SYNTHETIC_LOCAL_CONTEXT/);
  assert.equal(role.behavioralFoundation!.digest, shared.digest);
  const subagent = buildSubagentSpawnArgs({}, "Synthetic task", { foundationContext: role });
  for (const args of [interactive.args, prepared.args, cronArgs, ask, subagent, piContextResourceArgs(context)]) {
    assert.deepEqual(values(args, "--skill"), expectedSkills);
    assert.equal(args.filter(arg => arg === "--no-skills").length, 1);
    assert.equal(args.includes("--no-context-files"), true);
    assert.deepEqual(values(args, "--system-prompt"), [""]);
    assert.equal(args.includes(f.current), false);
  }
});

test("cron config inherits the global root for a newly configured agent", () => {
  const f = sharedBehaviorFixture();
  const path = join(f.root, "config.yaml");
  writeFileSync(path, JSON.stringify({ behavioralFoundation: { root: f.current }, agents: { fresh: { workspaceCwd: f.workspace, model: "openai-codex/gpt-5.5" } } }));
  assert.equal(resolveCronAgentData("fresh", path).behavioralFoundationRoot, f.current);
  assert.equal(buildPiCronAgentConfig("fresh", path).behavioralFoundationRoot, f.current);
});

test("native children inherit the trusted pinned root without reading config", t => {
  const f = sharedBehaviorFixture();
  const old = process.env[ROOT_ENV];
  process.env[ROOT_ENV] = f.first.root;
  t.after(() => { if (old === undefined) delete process.env[ROOT_ENV]; else process.env[ROOT_ENV] = old; });
  assert.equal(buildPiSubagentChildSpawnEnv(f.workspace)[ROOT_ENV], f.first.root);
});

test("ask-agent child receives its target's pinned root instead of an inherited parent revision", async () => {
  const f = sharedBehaviorFixture();
  const context = assemblePiContext(f.agent)!;
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  const result = await runAskAgentTargetChild({ caller: { ...f.agent, id: "caller" }, target: f.agent, context, question: "Synthetic question" }, {
    command: "synthetic-pi", env: { [ROOT_ENV]: "/synthetic/parent-revision" },
    spawn(_command, args, options) {
      assert.equal(options.env![ROOT_ENV], f.first.root);
      assert.deepEqual(values(args, "--skill"), context.behavioralFoundation!.skillPaths);
      queueMicrotask(() => {
        child.stdout.emit("data", JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "synthetic answer" }] } }) + "\n");
        child.emit("close", 0);
      });
      return child;
    },
  });
  assert.equal(result.answer, "synthetic answer");
});

test("required foundation failure stops interactive, cron, ask-agent and delegated preparation before spawn", async () => {
  const f = sharedBehaviorFixture();
  writeFileSync(join(f.first.root, "rules/shared.md"), "SYNTHETIC_CORRUPTION");
  const before = captures.length;
  assert.throws(() => buildPiSpawnArgs(f.agent, undefined, { relpaths: [] }), /Behavioral foundation.*hash mismatch/);
  assert.equal(captures.length, before);
  let spawned = false;
  assert.throws(() => runPi(cron, f.workspace, {
    buildAgentConfig: () => f.agent, buildEnv: () => ({}), assembleContext: assemblePiContext, resolveExtensionArgs: () => [],
    spawnSync() { spawned = true; throw new Error("Must not spawn"); },
  }), /Behavioral foundation.*hash mismatch/);
  const target = { ...f.agent, askAgent: { enabled: true } };
  const result = await executeAskAgent({ targetAgentId: target.id, question: "Synthetic question" }, {
    config: { agents: { [target.id]: target, caller: { ...target, id: "caller" } } },
    env: { MINIME_BOT_PI_SESSION_AGENT_ID: "caller" }, assembleContext: assemblePiContext,
    runTarget: async () => { spawned = true; return { answer: "Must not spawn", truncated: false, needsClarification: false }; },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "context_failed");
    assert.match(result.error.message, /foundation\/context is unavailable/);
  }
  assert.throws(() => assemblePiSubagentFoundation(f.current, f.workspace, "role", "Synthetic role"), /hash mismatch/);
  assert.equal(spawned, false);
});
