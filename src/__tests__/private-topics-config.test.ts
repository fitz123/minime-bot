import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, validatePrivateTopics } from "../config.js";
import { buildPiSpawnEnv, buildPiAskAgentChildSpawnEnv } from "../pi-rpc-protocol.js";

const collaboration = { socketPath: "/tmp/fixture-topics/router.sock" };

test("private topics default off, enable all authorized DMs independently of collaboration, and default to 17 graphemes", () => {
  assert.equal(validatePrivateTopics(undefined), undefined);
  assert.equal(validatePrivateTopics(false), undefined);
  assert.equal(validatePrivateTopics({ enabled: false }), undefined);
  assert.deepEqual(validatePrivateTopics({ enabled: true }), { enabled: true, maxNameGraphemes: 17 });
  for (const value of [true, null, [], {}, { expectedBotId: 900, chatIds: [100] }, { enabled: true, chatIds: [100] },
    { enabled: true, token: "not-a-credential" },
    ...[0, -1, 129, 1.5, "17"].map(maxNameGraphemes => ({ enabled: true, maxNameGraphemes }))]) {
    assert.throws(() => validatePrivateTopics(value), /privateTopics/);
  }
});

test("canonical policy is reusable across instance overlays, including collaboration-disabled instances", t => {
  const root = mkdtempSync(join(tmpdir(), "topics-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const canonical = join(root, "config.yaml"), instance = join(root, "instance.yaml");
  writeFileSync(canonical, JSON.stringify({ agents: { main: { workspaceCwd: root, model: "fixture-model" } }, telegramTokenEnv: "UNUSED_TOPIC_FIXTURE_TOKEN",
    bindings: [{ chatId: 100, agentId: "main", kind: "dm" }], collaboration, privateTopics: { enabled: true } }));
  writeFileSync(instance, "privateTopics: false\n");
  const read = () => loadConfig(canonical, { resolveSecrets: false, instanceConfigPath: instance, workspaceRoot: root });
  assert.equal(read().privateTopics, undefined);
  writeFileSync(instance, "{}\n");
  assert.deepEqual(read().privateTopics, { enabled: true, maxNameGraphemes: 17 });
  writeFileSync(instance, "collaboration: false\n");
  assert.equal(read().collaboration, undefined);
  assert.deepEqual(read().privateTopics, { enabled: true, maxNameGraphemes: 17 });
});

test("the topic env flag is passed only explicitly to collaboration sessions and never inherited by other child consumers", () => {
  const previous = process.env.MINIME_PRIVATE_TOPIC_POLICY;
  const previousMode = process.env.MINIME_COLLABORATION_TOPIC_ONLY;
  process.env.MINIME_COLLABORATION_TOPIC_ONLY = "1";
  process.env.MINIME_PRIVATE_TOPIC_POLICY = "1";
  try {
    assert.equal(buildPiSpawnEnv(process.cwd()).MINIME_COLLABORATION_TOPIC_ONLY, undefined);
    assert.equal(buildPiAskAgentChildSpawnEnv(process.cwd(), "main").MINIME_COLLABORATION_TOPIC_ONLY, undefined);
    assert.equal(buildPiSpawnEnv(process.cwd(), { privateTopicPolicy: true, collaborationTopicOnly: true, collaborationSession: "fixture", collaborationSocket: collaboration.socketPath }).MINIME_COLLABORATION_TOPIC_ONLY, "1");
    assert.equal(buildPiSpawnEnv(process.cwd()).MINIME_PRIVATE_TOPIC_POLICY, undefined);
    assert.equal(buildPiAskAgentChildSpawnEnv(process.cwd(), "main").MINIME_PRIVATE_TOPIC_POLICY, undefined);
    assert.equal(buildPiSpawnEnv(process.cwd(), { privateTopicPolicy: true }).MINIME_PRIVATE_TOPIC_POLICY, undefined);
    assert.equal(buildPiSpawnEnv(process.cwd(), { collaborationSession: "fixture", collaborationSocket: collaboration.socketPath }).MINIME_PRIVATE_TOPIC_POLICY, undefined);
    assert.equal(buildPiSpawnEnv(process.cwd(), { privateTopicPolicy: true, collaborationSession: "fixture", collaborationSocket: collaboration.socketPath }).MINIME_PRIVATE_TOPIC_POLICY, "1");
  } finally { if (previousMode === undefined) delete process.env.MINIME_COLLABORATION_TOPIC_ONLY; else process.env.MINIME_COLLABORATION_TOPIC_ONLY = previousMode; if (previous === undefined) delete process.env.MINIME_PRIVATE_TOPIC_POLICY; else process.env.MINIME_PRIVATE_TOPIC_POLICY = previous; }
});
