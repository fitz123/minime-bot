import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { tmpdir } from "node:os";
import { validateAgent } from "../config.js";
import { handleFastCommand, isFastEligible, PI_FAST_THREAD_ENV, readFastStatus, type FastScope } from "../codex-fast.js";
import { applyFastToRequest } from "../pi-extensions/codex-fast-request.js";
import { buildPiAskAgentChildSpawnEnv, buildPiSpawnEnv, buildPiSubagentChildSpawnEnv, MINIME_BOT_PI_SESSION_AGENT_ID_ENV } from "../pi-rpc-protocol.js";
import { SessionStore } from "../session-store.js";
import { SessionManager } from "../session-manager.js";
import { verifyCodexFast } from "../verify-codex-fast.js";
import type { AgentConfig, BotConfig } from "../types.js";

const agent: AgentConfig = { id: "fixture-primary", workspaceCwd: ".", model: "openai-codex/gpt-6-astra", thinking: "high", codexFast: { provider: "openai-codex", model: "gpt-6-astra" } };
function fixture(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), "codex-fast-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("agent Fast config requires an exact provider/model pin and never changes reasoning", () => {
  const raw = { ...agent, model: "gpt-6-astra" };
  const parsed = validateAgent(raw, agent.id);
  assert.deepEqual(parsed.codexFast, agent.codexFast);
  assert.equal(parsed.thinking, "high");
  for (const codexFast of [true, {}, { provider: "openai", model: "gpt-6-astra" }, { provider: "openai-codex", model: "gpt-*" }, { ...agent.codexFast, extra: true }]) {
    assert.throws(() => validateAgent({ ...raw, codexFast }, agent.id), /codexFast/);
  }
  assert.throws(() => validateAgent({ ...raw, model: "other/model" }, agent.id), /codexFast/);
  assert.equal(isFastEligible({ ...agent, codexFast: undefined }), false);
  assert.equal(isFastEligible(agent, { provider: "other", id: "gpt-6-astra" }), false);
  assert.equal(isFastEligible(agent, { provider: "openai-codex", id: "other-model" }), false);
});

test("priority helper preserves malformed, mismatched, independently configured and off payloads", () => {
  for (const payload of [undefined, null, [], "string", 1, { model: "other-model" }, { model: "gpt-6-astra", service_tier: "auto" }]) {
    assert.equal(applyFastToRequest(payload, "gpt-6-astra", true), undefined);
  }
  const payload = { model: "gpt-6-astra", reasoning: { effort: "high" } };
  assert.equal(applyFastToRequest(payload, "gpt-6-astra", false), undefined);
  assert.deepEqual(applyFastToRequest(payload, "gpt-6-astra", true), { ...payload, service_tier: "priority" });
  assert.equal("service_tier" in payload, false);
});

test("defaults/overrides stay isolated by agent/model/thread and survive actual clean/restart", async t => {
  const root = fixture(t);
  const path = join(root, "data/codex-fast.json");
  const one: FastScope = { agent, threadKey: "fixture-chat:one" };
  const two: FastScope = { agent, threadKey: "fixture-chat:two" };
  assert.deepEqual(readFastStatus(one, path), { defaultEnabled: false, override: "inherit", enabled: false });
  assert.equal(existsSync(path), false, "status is read-only");
  assert.equal(handleFastCommand("status", one, path), handleFastCommand("", one, path));
  assert.equal(existsSync(path), false);
  handleFastCommand("default on", one, path);
  handleFastCommand("off", one, path);
  assert.equal(readFastStatus(two, path).enabled, true);
  assert.equal(readFastStatus(one, path).enabled, false);
  assert.equal(readFastStatus({ agent: { ...agent, id: "fixture-other" } }, path).enabled, false);
  assert.equal(readFastStatus({ agent: { ...agent, model: "different", codexFast: { provider: "openai-codex", model: "different" } } }, path).enabled, false);
  const bytes = readFileSync(path, "utf8");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  const config = { agents: { [agent.id]: agent }, bindings: [], sessionDefaults: {} } as unknown as BotConfig;
  const storePath = join(root, "data/sessions.json");
  new SessionStore(storePath).setSession(one.threadKey!, { bindingState: "bound", chatId: one.threadKey!, agentId: agent.id, sessionId: "fixture-session", sessionFile: join(root, "fixture-session.jsonl"), workspaceRealpath: root, lastActivity: 1 });
  const manager = new SessionManager(() => config, join(root, "data/sessions.json"));
  await manager.destroySession(one.threadKey!);
  assert.equal(readFileSync(path, "utf8"), bytes);
  assert.equal(new SessionStore(storePath).getSession(one.threadKey!), undefined);
  const restarted = new SessionManager(() => config, join(root, "data/sessions.json"));
  assert.equal(restarted.getActiveCount(), 0);
  assert.deepEqual(readFastStatus(one, path), { defaultEnabled: true, override: "off", enabled: false });
  handleFastCommand("inherit", one, path);
  assert.deepEqual(readFastStatus(one, path), { defaultEnabled: true, override: "inherit", enabled: true });
  await manager.closeAll(); await restarted.closeAll();
});

test("strict store and commands reject malformed input without silently activating another scope", t => {
  const path = join(fixture(t), "codex-fast.json");
  const scope = { agent, threadKey: "fixture-chat" };
  for (const args of ["ON", "default", "default inherit", "on extra", "inherit extra", "default on extra"]) {
    assert.match(handleFastCommand(args, scope, path), /Usage:/);
    assert.equal(existsSync(path), false);
  }
  assert.match(handleFastCommand("on", { agent }, path), /No identified chat/);
  assert.match(handleFastCommand("on", undefined, path), /unavailable/);
  assert.match(handleFastCommand("on", { agent: { ...agent, codexFast: undefined } }, path), /unavailable/);
  for (const raw of ["{", "null", '{"version":2,"defaults":[],"threads":[]}', '{"version":1,"defaults":[],"threads":[{"agentId":"fixture-primary","provider":"openai-codex","model":"gpt-6-astra","enabled":true}]}']) {
    writeFileSync(path, raw);
    assert.throws(() => readFastStatus(scope, path), /Invalid Codex Fast preferences/);
  }
  writeFileSync(path, JSON.stringify({ version: 1, defaults: [], threads: [] }));
  writeFileSync(`${path}.lock`, "");
  assert.throws(() => handleFastCommand("default on", scope, path), /busy; retry/);
  assert.equal(readFastStatus(scope, path).enabled, false);
});

test("trusted launch identities clear caller/thread state for cron, target handoff and generic subagents", t => {
  const keys = [MINIME_BOT_PI_SESSION_AGENT_ID_ENV, PI_FAST_THREAD_ENV];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }));
  process.env[MINIME_BOT_PI_SESSION_AGENT_ID_ENV] = agent.id;
  process.env[PI_FAST_THREAD_ENV] = "caller-topic";
  const interactive = buildPiSpawnEnv(undefined, { askCallerAgentId: agent.id, fastThreadKey: "actual-topic" });
  assert.equal(interactive[PI_FAST_THREAD_ENV], "actual-topic");
  assert.equal(interactive[MINIME_BOT_PI_SESSION_AGENT_ID_ENV], agent.id);
  const cron = buildPiSpawnEnv(undefined, { askCallerAgentId: "cron-agent" });
  const target = buildPiAskAgentChildSpawnEnv(undefined, "target-agent");
  assert.equal(cron[MINIME_BOT_PI_SESSION_AGENT_ID_ENV], "cron-agent");
  assert.equal(target[MINIME_BOT_PI_SESSION_AGENT_ID_ENV], "target-agent");
  for (const env of [cron, target, buildPiSubagentChildSpawnEnv(), buildPiSpawnEnv(undefined, { fastThreadKey: "untrusted-without-agent" })]) assert.equal(env[PI_FAST_THREAD_ENV], undefined);
  assert.equal(buildPiSubagentChildSpawnEnv()[MINIME_BOT_PI_SESSION_AGENT_ID_ENV], undefined);
});

test("actual installed Pi loads Fast, routes native commands without LLM, and runs warm request matrix", { timeout: 20_000 }, async () => {
  const result = await verifyCodexFast();
  assert.equal(result.piVersion, "1.5.0");
  assert.ok(result.requestChecks >= 21);
  assert.ok(result.commandsChecked >= 21);
});

test("offline verifier CLI executes through a current directory symlink", { timeout: 30_000 }, t => {
  const root = fixture(t);
  const current = join(root, "current");
  const testPath = fileURLToPath(import.meta.url);
  symlinkSync(dirname(dirname(testPath)), current, "dir");
  const result = spawnSync(process.execPath, ["--import", "tsx", join(current, `verify-codex-fast${extname(testPath)}`)], {
    encoding: "utf8", timeout: 25_000, env: { ...process.env, TMPDIR: root },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { piVersion: "1.5.0", requestChecks: 23, commandsChecked: 24 });
});
