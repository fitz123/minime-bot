import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validatePrivateTopics } from "../config.js";
import { buildPiSpawnEnv, buildPiAskAgentChildSpawnEnv } from "../pi-rpc-protocol.js";

const collaboration = { socketPath: "/tmp/fixture-topics/router.sock" };

test("private topics are opt-in, require collaboration and an explicit bot/chat scope, and default to 17 graphemes", () => {
  assert.equal(validatePrivateTopics(undefined, undefined), undefined);
  assert.equal(validatePrivateTopics(false, undefined), undefined);
  assert.deepEqual(validatePrivateTopics({ expectedBotId: 900, chatIds: [100, 100] }, collaboration), { expectedBotId: 900, chatIds: [100], maxNameGraphemes: 17 });
  assert.throws(() => validatePrivateTopics({ expectedBotId: 900, chatIds: [100] }, undefined), /requires collaboration/);
  for (const value of [true, null, [], {}, { chatIds: [100] }, { expectedBotId: 900 }, { expectedBotId: 0, chatIds: [100] },
    { expectedBotId: 900, chatIds: [] }, { expectedBotId: 900, chatIds: [-100] }, { expectedBotId: 900, chatIds: [1.5] },
    { expectedBotId: 900, chatIds: [100], token: "not-a-credential" },
    ...[0, -1, 129, 1.5, "17"].map(maxNameGraphemes => ({ expectedBotId: 900, chatIds: [100], maxNameGraphemes }))]) {
    assert.throws(() => validatePrivateTopics(value, collaboration), /privateTopics/);
  }
});

test("normal config/instance loading preserves explicit bot scope and supports disabling the policy", t => {
  const root = mkdtempSync(join(tmpdir(), "topics-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = join(root, "config.yaml"), instance = join(root, "instance.yaml");
  writeFileSync(canonical, JSON.stringify({ agents: { main: { workspaceCwd: root, model: "fixture-model" } }, telegramTokenEnv: "UNUSED_TOPIC_FIXTURE_TOKEN",
    bindings: [{ chatId: 100, agentId: "main", kind: "dm" }], collaboration, privateTopics: { expectedBotId: 900, chatIds: [100] } }));
  writeFileSync(instance, "privateTopics: false\n");
  const read = () => loadConfig(canonical, { resolveSecrets: false, instanceConfigPath: instance, workspaceRoot: root });
  assert.equal(read().privateTopics, undefined);
  writeFileSync(instance, "{}\n");
  assert.deepEqual(read().privateTopics, { expectedBotId: 900, chatIds: [100], maxNameGraphemes: 17 });
  writeFileSync(instance, "privateTopics:\n  expectedBotId: 901\n  chatIds: [200]\n");
  assert.deepEqual(read().privateTopics, { expectedBotId: 901, chatIds: [200], maxNameGraphemes: 17 });
  writeFileSync(instance, "collaboration: false\n");
  assert.throws(read, /requires collaboration/);
});

test("the topic env flag is passed only explicitly to collaboration sessions and never inherited by other child consumers", () => {
  const previous = process.env.MINIME_PRIVATE_TOPIC_POLICY;
  process.env.MINIME_PRIVATE_TOPIC_POLICY = "1";
  try {
    assert.equal(buildPiSpawnEnv(process.cwd()).MINIME_PRIVATE_TOPIC_POLICY, undefined);
    assert.equal(buildPiAskAgentChildSpawnEnv(process.cwd(), "main").MINIME_PRIVATE_TOPIC_POLICY, undefined);
    assert.equal(buildPiSpawnEnv(process.cwd(), { privateTopicPolicy: true }).MINIME_PRIVATE_TOPIC_POLICY, undefined);
    assert.equal(buildPiSpawnEnv(process.cwd(), { collaborationSession: "fixture", collaborationSocket: collaboration.socketPath }).MINIME_PRIVATE_TOPIC_POLICY, undefined);
    assert.equal(buildPiSpawnEnv(process.cwd(), { privateTopicPolicy: true, collaborationSession: "fixture", collaborationSocket: collaboration.socketPath }).MINIME_PRIVATE_TOPIC_POLICY, "1");
  } finally { if (previous === undefined) delete process.env.MINIME_PRIVATE_TOPIC_POLICY; else process.env.MINIME_PRIVATE_TOPIC_POLICY = previous; }
});
