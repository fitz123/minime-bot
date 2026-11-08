import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Socket } from "node:net";
import { mock, test } from "node:test";
import type { AgentRuntimeDescriptor } from "../agent-runtime-descriptor.js";
import type { AgentLaneState, AgentRuntimeMessage, AgentRuntimeOperation } from "../agent-runtime-protocol.js";
import { publication, sharedBehaviorFixture } from "./shared-behavior-fixture.js";

let centralReads = 0;
mock.module("../config.js", { namedExports: {
  loadRawMergedConfig() { centralReads++; throw new Error("Worker must not read central config"); },
  resolveConfigWorkspaceRoot() { centralReads++; throw new Error("Worker must not resolve central config"); },
} });
const { AgentRuntimeWorker } = await import("../agent-runtime-worker.js");
const { assemblePiContext } = await import("../pi-context-assembler.js");

function fixture() {
  const f = sharedBehaviorFixture();
  for (const name of ["home", "state", "sessions", "context", "socket"]) mkdirSync(join(f.root, name), { mode: 0o700 });
  mkdirSync(join(f.workspace, ".claude/rules"), { recursive: true });
  symlinkSync(join(f.root, "unavailable-source-home/platform"), join(f.workspace, ".claude/rules/platform"));
  const descriptor: AgentRuntimeDescriptor = {
    version: 1, agentId: f.agent.id, workerUid: process.getuid!(), workerGid: process.getgid!(),
    home: join(f.root, "home"), controllerUid: process.getuid!(), controllerName: "fixture-controller",
    workspace: f.workspace, stateRoot: join(f.root, "state"), sessionRoot: join(f.root, "sessions"), contextRoot: join(f.root, "context"),
    socketDirectory: join(f.root, "socket"), socketPath: join(f.root, "socket/worker.sock"),
    behavioralFoundationRoot: f.current, model: "foundation-offline/fixture", thinking: "off", knowledge: "none",
    capabilities: ["local-tools"], tools: ["read"], offline: true,
  };
  const worker = new AgentRuntimeWorker(descriptor, { trustedTestExtensions: [resolve("test-fixtures/agent-runtime/foundation-provider.mjs")] });
  const messages: AgentRuntimeMessage[] = [];
  const owner = { destroyed: false, writable: true, writableLength: 0,
    write(frame: string) { messages.push(JSON.parse(frame)); return true; } } as unknown as Socket;
  const dispatch = (op: AgentRuntimeOperation) => (worker as unknown as { dispatch(r: object, s: Socket): Promise<void> })
    .dispatch({ ...op, version: 1, id: String(messages.length) }, owner);
  const open = async () => {
    await dispatch({ op: "open", laneId: "lane" });
    return (messages.at(-1) as { state: AgentLaneState }).state;
  };
  const record = () => JSON.parse(readFileSync(join(descriptor.stateRoot, "lanes", readdirSync(join(descriptor.stateRoot, "lanes"))[0], "binding.json"), "utf8"));
  return { ...f, descriptor, worker, messages, dispatch, open, record };
}

test("configured worker uses real pinned Pi skills/tools and descriptor root without central config or private control env", { timeout: 20_000 }, async t => {
  const f = fixture();
  t.after(() => f.worker.shutdown());
  const before = await f.open();
  await f.dispatch({ op: "prompt", handle: before.handle, requestId: "first", text: "Verify shared foundation" });
  const result = f.messages.filter(m => m.type === "event" && m.event.type === "result").at(-1);
  assert.ok(result?.type === "event" && result.event.type === "result");
  const receipt = JSON.parse(result.event.result!);
  assert.equal(receipt.sharedRule, true);
  assert.equal(receipt.localPrivate, true);
  assert.equal(receipt.metadata, true);
  assert.equal(receipt.lazyBody, true);
  assert.equal(receipt.skillRead, true);
  assert.equal(receipt.supportRead, true);
  assert.equal(receipt.root, f.first.root);
  assert.equal(receipt.noCentralEnv, true);
  const recorded = f.record();
  assert.equal(recorded.contextManifest.digest, before.contextDigest);
  assert.equal(JSON.stringify(recorded.contextManifest).includes(f.root), false);

  const next = publication(f.root, "revision-two");
  symlinkSync(next.root, join(f.root, "next"));
  renameSync(join(f.root, "next"), f.current);
  await f.dispatch({ op: "getState", handle: before.handle });
  assert.equal((f.messages.at(-1) as { state: AgentLaneState }).state.contextDigest, before.contextDigest);
  await f.dispatch({ op: "prompt", handle: before.handle, requestId: "still-old", text: "Verify shared foundation" });
  const oldResult = f.messages.filter(m => m.type === "event" && m.event.type === "result").at(-1);
  assert.ok(oldResult?.type === "event" && oldResult.event.type === "result");
  assert.equal(JSON.parse(oldResult.event.result!).root, f.first.root);
  await f.dispatch({ op: "close", handle: before.handle });
  const after = await f.open();
  assert.notEqual(after.contextDigest, before.contextDigest);
  assert.equal(after.handle.sessionId, before.handle.sessionId);
  await f.dispatch({ op: "prompt", handle: after.handle, requestId: "next-load", text: "Verify shared foundation" });
  const nextResult = f.messages.filter(m => m.type === "event" && m.event.type === "result").at(-1);
  assert.ok(nextResult?.type === "event" && nextResult.event.type === "result");
  const nextReceipt = JSON.parse(nextResult.event.result!);
  assert.equal(nextReceipt.root, next.root);
  assert.equal(nextReceipt.location, join(next.root, "skills/example-workflow/SKILL.md"));
  assert.equal(nextReceipt.skillRead, true);
  assert.equal(nextReceipt.supportRead, true);
  assert.equal(centralReads, 0);
});

test("ordinary configured assembly bypasses legacy config/signature lookup with strict false", () => {
  const f = fixture();
  writeFileSync(join(f.workspace, ".claude/settings.local.json"), JSON.stringify({ outputStyle: "optional-missing" }));
  const context = assemblePiContext(f.agent, { strict: false })!;
  assert.equal(context.systemPromptPath, undefined);
  assert.match(readFileSync(context.appendSystemPromptPath, "utf8"), /SYNTHETIC_SHARED_RULE/);
  writeFileSync(join(f.workspace, "USER.md"), "SYNTHETIC_UPDATED_LOCAL_CONTEXT");
  const updated = assemblePiContext(f.agent, { strict: false })!;
  assert.notEqual(updated.manifest.digest, context.manifest.digest);
  assert.match(readFileSync(updated.appendSystemPromptPath, "utf8"), /SYNTHETIC_UPDATED_LOCAL_CONTEXT/);
  assert.equal(centralReads, 0);
});

test("worker retains strict missing optional output-style rejection with foundation configured", async t => {
  const f = fixture();
  t.after(() => f.worker.shutdown());
  writeFileSync(join(f.workspace, ".claude/settings.local.json"), JSON.stringify({ outputStyle: "optional-missing" }));
  await assert.rejects(f.open(), (error: { code: string; message: string }) => error.code === "context_invalid" && /Output-style is not a readable regular source/.test(error.message));
  assert.equal(readdirSync(f.descriptor.sessionRoot).length, 0);
  assert.equal(existsSync(join(f.descriptor.stateRoot, "lanes")), false);
  assert.equal(centralReads, 0);
});

test("worker rejects a corrupt required publication before starting Pi or minting lane state", async t => {
  const f = fixture();
  t.after(() => f.worker.shutdown());
  writeFileSync(join(f.first.root, "rules/shared.md"), "SYNTHETIC_CORRUPTION");
  await assert.rejects(f.open(), (error: { code: string; message: string }) => error.code === "context_invalid" && /Behavioral foundation.*hash mismatch/.test(error.message));
  assert.equal(readdirSync(f.descriptor.sessionRoot).length, 0);
  assert.equal(existsSync(join(f.descriptor.stateRoot, "lanes")), false);
  assert.equal(centralReads, 0);
});
