import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, validateCollaboration } from "../config.js";
import { buildPiSpawnEnv, resolvePiSpawnExtensionArgs } from "../pi-rpc-protocol.js";

test("collaboration is explicit, bounded to a local socket path, and disabled by default", () => {
  assert.equal(validateCollaboration(undefined), undefined);
  assert.equal(validateCollaboration(false), undefined);
  assert.deepEqual(validateCollaboration({ socketPath: "/tmp/fixture-collab/router.sock" }), { socketPath: "/tmp/fixture-collab/router.sock" });
  for (const value of [true, null, [], {}, { socketPath: "relative.sock" }, { socketPath: "/" + "a".repeat(101) }, { socketPath: "/tmp/test", host: "example.invalid" }]) {
    assert.throws(() => validateCollaboration(value), /collaboration/);
  }
});

test("bot-owned collaboration identity is passed explicitly and does not leak into ask_agent/default children", () => {
  const previous = process.env.MINIME_COLLABORATION_SOCKET;
  process.env.MINIME_COLLABORATION_SOCKET = "/tmp/fixture-parent/router.sock";
  try {
    const defaultEnv = buildPiSpawnEnv(process.cwd());
    assert.equal(defaultEnv.MINIME_COLLABORATION_SOCKET, undefined);
    assert.equal(defaultEnv.MINIME_COLLABORATION_SESSION, undefined);
    const enabled = buildPiSpawnEnv(process.cwd(), { collaborationSocket: "/tmp/fixture-bot/router.sock", collaborationSession: "exact-fixture" });
    assert.equal(enabled.MINIME_COLLABORATION_SOCKET, "/tmp/fixture-bot/router.sock");
    assert.equal(enabled.MINIME_COLLABORATION_SESSION, "exact-fixture");
    assert.equal(resolvePiSpawnExtensionArgs().some(arg => arg.endsWith("collaboration.ts")), false);
    assert.equal(resolvePiSpawnExtensionArgs({ collaboration: true }).some(arg => arg.endsWith("collaboration.ts")), true);
    assert.deepEqual(resolvePiSpawnExtensionArgs({ collaboration: true, env: { PI_EXTENSIONS_DISABLED: "1" } }), []);
  } finally {
    if (previous === undefined) delete process.env.MINIME_COLLABORATION_SOCKET;
    else process.env.MINIME_COLLABORATION_SOCKET = previous;
  }
});


test("normal config loading and the instance overlay select the bot socket or disable it", () => {
  const root = mkdtempSync(join(tmpdir(), "collab-config-"));
  const canonical = join(root, "config.yaml"), instance = join(root, "instance.yaml");
  writeFileSync(canonical, `agents:\n  b:\n    workspaceCwd: ${JSON.stringify(root)}\n    model: gpt-5.5\ntelegramTokenEnv: COLLABORATION_FIXTURE_TOKEN\nbindings:\n  - { chatId: 101, agentId: b, kind: dm }\ncollaboration:\n  socketPath: /tmp/fixture-canonical/router.sock\n`);
  try {
    writeFileSync(instance, "collaboration:\n  socketPath: /tmp/fixture-instance/router.sock\n");
    assert.deepEqual(loadConfig(canonical, { resolveSecrets: false, instanceConfigPath: instance, workspaceRoot: root }).collaboration, { socketPath: "/tmp/fixture-instance/router.sock" });
    writeFileSync(instance, "collaboration: false\n");
    assert.equal(loadConfig(canonical, { resolveSecrets: false, instanceConfigPath: instance, workspaceRoot: root }).collaboration, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
