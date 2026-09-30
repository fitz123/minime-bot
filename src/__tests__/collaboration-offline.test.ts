import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../session-manager.js";
import { resolveBinding } from "../telegram-binding.js";
import { resolvePackageOwnedPiInvocation } from "../pi-runtime.js";
import { CollaborationDeliveryError, type Delivery } from "../collaboration.js";
import type { BotConfig } from "../types.js";

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for offline Pi"); await delay(30); }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), "collab-offline-"));
  const env = { ...process.env };
  for (const dir of ["agent", "sessions", "bot", "tmp"]) mkdirSync(join(root, dir), { mode: 0o700 });
  Object.assign(process.env, { MINIME_CONTROL_WORKSPACE_ROOT: root, MINIME_COLLABORATION_SOCKET: join(root, "absent.sock"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TMPDIR: join(root, "tmp") });
  delete process.env.PI_EXTENSIONS_DISABLED;
  delete process.env.MINIME_COLLABORATION_SESSION;
  return { root, restore() { for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k]; Object.assign(process.env, env); } };
}
const fixture = resolve("src/__tests__/fixtures/collaboration-provider.ts");

test("actual Pi runs ordinary tools and finishes when the bot socket is absent", { timeout: 30000 }, async () => {
  const { root, restore } = setup();
  const invocation = resolvePackageOwnedPiInvocation("cli", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension", fixture, "--extension", resolve("extensions/pi/collaboration.ts"), "--model", "openai-codex/fixture"]);
  const child = spawn(invocation.command, invocation.args, { cwd: join(root, "bot"), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errors = "";
  child.stdout!.on("data", c => { output += c.toString(); });
  child.stderr!.on("data", c => { errors += c.toString(); });
  try {
    child.stdin!.write(JSON.stringify({ type: "prompt", message: "START_COLLAB" }) + "\n");
    await until(() => output.includes('"type":"agent_settled"'));
    assert.match(output, /disconnected/);
    assert.match(output, /Internal tool receipt recorded/);
    assert.doesNotMatch(output, /"isError":true/);
  } catch (error) { throw new Error(`Offline Pi failed: ${output}\n${errors}`, { cause: error }); }
  finally { child.kill("SIGTERM"); restore(); }
});

test("actual SessionManager serializes internal input behind human output and quarantines internal files", { timeout: 30000 }, async () => {
  const { root, restore } = setup();
  const config: BotConfig = { whisperModelPath: "unused", collaboration: { socketPath: process.env.MINIME_COLLABORATION_SOCKET! }, agents: { b: { id: "b", workspaceCwd: join(root, "bot"), model: "openai-codex/fixture" } }, bindings: [], piExtraExtensions: [fixture], sessionDefaults: { maxConcurrentSessions: 4, idleTimeoutMs: 60000, maxMessageAgeMs: 60000, requireMention: false, maxMediaBytes: 1000 } };
  const manager = new SessionManager(() => config, join(root, "state", "sessions.json"), join(root, "logs"));
  let release!: () => void;
  try {
    const session = await manager.getOrCreateSession("fixture-thread", "b");
    for await (const _ of manager.sendSessionMessage("fixture-thread", "b", "Remember EXACT_CONTEXT_MARKER")) {}
    const outputDone = new Promise<void>(r => { release = r; });
    const human = (async () => { for await (const _ of manager.sendSessionMessage("fixture-thread", "b", "HUMAN_BUSY", { outputDone })) {} })();
    await until(() => session.processingStartedAt !== null);
    let consumed = false;
    const internal = manager.deliverCollaboration({ id: "fixture-message", conversation: "fixture-conversation", from: { kind: "terminal", id: "fixture-a" }, to: { kind: "thread", id: "fixture-thread" }, text: "INTERNAL_TASK", expires: Date.now() + 10000 }, () => { consumed = true; });
    await human;
    assert.equal(consumed, false, "internal input must wait for human relay cleanup");
    release();
    await internal;
    assert.equal(consumed, true);
    assert.deepEqual(readdirSync(session.outboxPath), []);
    const quarantine = readdirSync(join(session.outboxPath, "..")).filter(p => p.endsWith(".internal"));
    assert.equal(quarantine.length, 0, "internal runtime files are discarded before human outbox is restored");
    const transcript = readFileSync(session.sessionFile!, "utf8");
    assert.ok(transcript.indexOf("HUMAN_DONE") < transcript.indexOf("INTERNAL_TASK"));
    assert.match(transcript, /CLARIFY:/);
  } finally { release?.(); await manager.closeAll(); restore(); }
});

function ownerFixture() {
  const fixtureEnv = setup();
  const config: BotConfig = {
    whisperModelPath: "unused", collaboration: { socketPath: process.env.MINIME_COLLABORATION_SOCKET! },
    agents: { b: { id: "b", workspaceCwd: join(fixtureEnv.root, "bot"), model: "openai-codex/fixture", systemPrompt: "AGENT_CONTEXT_MARKER" } },
    bindings: [], piExtraExtensions: [fixture],
    sessionDefaults: { maxConcurrentSessions: 4, idleTimeoutMs: 60000, maxMessageAgeMs: 60000, requireMention: false, maxMediaBytes: 1000 },
  };
  const manager = new SessionManager(() => config, join(fixtureEnv.root, "state", "sessions.json"), join(fixtureEnv.root, "logs"));
  return { ...fixtureEnv, manager, config };
}
function message(to: Delivery["to"], text: string): Delivery {
  return { id: `fixture-${text}`, conversation: "fixture-conversation", from: { kind: "terminal", id: "fixture-a" }, to, text, expires: Date.now() + 15000 };
}
async function prompt(manager: SessionManager, lane: string, text: string): Promise<void> {
  for await (const line of manager.sendSessionMessage(lane, "b", text)) {
    if (line.type === "result") assert.notEqual(line.is_error, true);
  }
}

test("configured-agent consultation keeps target context through continuing internal turns and owner resume", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  try {
    const first = message({ kind: "agent", id: "b" }, "CONSULT_ONE");
    let consumed = 0;
    await manager.deliverCollaboration(first, () => { consumed++; });
    assert.equal(first.to.kind, "session");
    const lane = "collaboration:fixture-conversation:b";
    const initial = manager.getActive(lane)!;
    assert.match(readFileSync(initial.sessionFile!, "utf8"), /CONSULT_FIRST_DONE/);
    await manager.closeSession(lane);
    const second = message(first.to, "CONSULT_TWO");
    await manager.deliverCollaboration(second, () => { consumed++; });
    assert.equal(consumed, 2);
    const resumed = manager.getActive(lane)!;
    assert.equal(resumed.sessionId, initial.sessionId);
    assert.equal(resumed.sessionFile, initial.sessionFile);
    assert.match(readFileSync(resumed.sessionFile!, "utf8"), /CONSULT_CONTINUED/);
  } finally { await manager.closeAll(); restore(); }
});

test("inactive thread resumes through owner; exact missing or reset targets never create replacements", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  try {
    await prompt(manager, "fixture-thread", "Remember EXACT_CONTEXT_MARKER");
    const initial = manager.getActive("fixture-thread")!;
    await manager.closeSession("fixture-thread");
    await manager.deliverCollaboration(message({ kind: "thread", id: "fixture-thread" }, "INTERNAL_TASK"), () => {});
    assert.equal(manager.getActive("fixture-thread")?.sessionId, initial.sessionId);
    await manager.closeSession("fixture-thread");
    renameSync(initial.sessionFile!, `${initial.sessionFile}.held`);
    await assert.rejects(manager.deliverCollaboration(message({ kind: "session", id: initial.sessionId }, "missing"), () => {}), error => error instanceof CollaborationDeliveryError && error.status === "rejected");
    assert.equal(manager.getActive("fixture-thread"), undefined);
    assert.equal(existsSync(initial.sessionFile!), false);
    await manager.destroySession("fixture-thread");
    await assert.rejects(manager.deliverCollaboration(message({ kind: "session", id: initial.sessionId }, "reset"), () => {}), error => error instanceof CollaborationDeliveryError && error.status === "rejected");
    assert.equal(manager.getActive("fixture-thread"), undefined);
  } finally { await manager.closeAll(); restore(); }
});

test("staged/debounced human input takes priority and queued internal expiry has no effects", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  let release = () => {};
  try {
    await prompt(manager, "fixture-thread", "Remember EXACT_CONTEXT_MARKER");
    const initial = manager.getActive("fixture-thread")!;
    release = manager.holdHumanInput("fixture-thread");
    const expired = message({ kind: "session", id: initial.sessionId }, "DO_NOT_CONSUME");
    expired.expires = Date.now() + 40;
    await assert.rejects(manager.deliverCollaboration(expired, () => assert.fail("expired consumed")), error => error instanceof CollaborationDeliveryError && error.status === "expired");
    let pending = true;
    manager.setHumanWorkPending(() => pending);
    release();
    let consumed = false;
    const delivery = manager.deliverCollaboration(message({ kind: "session", id: initial.sessionId }, "INTERNAL_TASK"), () => { consumed = true; });
    await prompt(manager, "fixture-thread", "HUMAN_BUSY");
    assert.equal(consumed, false);
    pending = false;
    await delivery;
    assert.equal(consumed, true);
    const transcript = readFileSync(initial.sessionFile!, "utf8");
    assert.doesNotMatch(transcript, /DO_NOT_CONSUME/);
    assert.ok(transcript.indexOf("HUMAN_DONE") < transcript.indexOf("INTERNAL_TASK"));
  } finally { release(); await manager.closeAll(); restore(); }
});

test("reset during internal execution completes cleanup before a new owner uses the outbox", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  try {
    const initial = await manager.getOrCreateSession("fixture-thread", "b");
    const delivery = manager.deliverCollaboration(message({ kind: "session", id: initial.sessionId }, "INTERNAL_BUSY"), () => {});
    const outcome = delivery.catch(error => error);
    await until(() => initial.internalTurn === true && initial.processingStartedAt !== null);
    await manager.destroySession("fixture-thread");
    await outcome;
    const replacement = await manager.getOrCreateSession("fixture-thread", "b");
    assert.notEqual(replacement.sessionId, initial.sessionId);
    assert.deepEqual(readdirSync(replacement.outboxPath), []);
    assert.deepEqual(readdirSync(join(replacement.outboxPath, "..")).filter(p => p.endsWith(".human")), []);
    await prompt(manager, "fixture-thread", "A new human turn");
    assert.deepEqual(readdirSync(replacement.outboxPath), []);
  } finally { await manager.closeAll(); restore(); }
});


test("new internal consultations reject capacity without evicting a busy human turn", { timeout: 30000 }, async () => {
  const { manager, config, restore } = ownerFixture();
  try {
    config.sessionDefaults.maxConcurrentSessions = 1;
    const initial = await manager.getOrCreateSession("fixture-thread", "b");
    const human = prompt(manager, "fixture-thread", "HUMAN_BUSY");
    await until(() => initial.processingStartedAt !== null);
    await assert.rejects(manager.deliverCollaboration(message({ kind: "agent", id: "b" }, "CONSULT_ONE"), () => {}), error => error instanceof CollaborationDeliveryError && error.status === "rejected");
    assert.equal(manager.getActive("fixture-thread"), initial);
    await human;
    assert.match(readFileSync(initial.sessionFile!, "utf8"), /HUMAN_DONE/);
  } finally { await manager.closeAll(); restore(); }
});

test("crash cleanup fences immediate owner resume before reusing the outbox", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  try {
    const initial = await manager.getOrCreateSession("fixture-thread", "b");
    const delivery = manager.deliverCollaboration(message({ kind: "session", id: initial.sessionId }, "INTERNAL_BUSY"), () => {});
    const outcome = delivery.catch(error => error);
    await until(() => initial.internalTurn === true && initial.processingStartedAt !== null);
    initial.child.kill("SIGKILL");
    const resumed = await manager.getOrCreateSession("fixture-thread", "b", initial.sessionId);
    await outcome;
    assert.equal(resumed.sessionId, initial.sessionId);
    assert.deepEqual(readdirSync(resumed.outboxPath), []);
    assert.deepEqual(readdirSync(join(resumed.outboxPath, "..")).filter(p => p.endsWith(".human")), []);
    await prompt(manager, "fixture-thread", "Human after crash");
    await manager.closeSession("fixture-thread");
    // Simulate the reserved directories left if the whole bot exits before its
    // finally block. Owner startup must not publish or accumulate either one.
    mkdirSync(resumed.outboxPath, { mode: 0o700 });
    mkdirSync(`${resumed.outboxPath}.human`, { mode: 0o700 });
    writeFileSync(join(resumed.outboxPath, "internal.txt"), "INTERNAL_FILE");
    writeFileSync(join(`${resumed.outboxPath}.human`, "held.txt"), "old outbox");
    const reopened = await manager.getOrCreateSession("fixture-thread", "b", initial.sessionId);
    assert.deepEqual(readdirSync(reopened.outboxPath), []);
    assert.equal(existsSync(`${reopened.outboxPath}.human`), false);
  } finally { await manager.closeAll(); restore(); }
});


test("actual Bash background output stays private after the internal turn settles", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  try {
    const session = await manager.getOrCreateSession("fixture-thread", "b");
    await manager.deliverCollaboration(message({ kind: "session", id: session.sessionId }, "INTERNAL_BACKGROUND"), () => {});
    await prompt(manager, "fixture-thread", "HUMAN_BUSY");
    assert.deepEqual(readdirSync(session.outboxPath), []);
    assert.equal(readFileSync(join(`${session.outboxPath}.internal`, "late.txt"), "utf8"), "PRIVATE_BACKGROUND");
    await manager.closeSession("fixture-thread");
    assert.equal(existsSync(`${session.outboxPath}.internal`), false);
  } finally { await manager.closeAll(); restore(); }
});

test("internal persistence failure rejects before dispatch and cannot leak into the next human stream", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  const store = (manager as any).store;
  const original = store.setSession.bind(store);
  try {
    const session = await manager.getOrCreateSession("fixture-thread", "b");
    store.setSession = (...args: any[]) => {
      if (session.internalTurn && session.processingStartedAt !== null) throw new Error("fixture persistence failure");
      return original(...args);
    };
    await assert.rejects(manager.deliverCollaboration(message({ kind: "session", id: session.sessionId }, "INTERNAL_BUSY"), () => assert.fail("not dispatched")), error => error instanceof CollaborationDeliveryError && error.status === "rejected");
    store.setSession = original;
    const lines = [];
    for await (const line of manager.sendSessionMessage("fixture-thread", "b", "Human after persistence failure")) lines.push(line);
    assert.doesNotMatch(JSON.stringify(lines), /INTERNAL_DONE/);
    assert.doesNotMatch(readFileSync(session.sessionFile!, "utf8"), /INTERNAL_BUSY/);
  } finally { store.setSession = original; await manager.closeAll(); restore(); }
});

test("fatal internal reader failure terminates the dispatched child before releasing isolation", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  try {
    const session = await manager.getOrCreateSession("fixture-thread", "b");
    let exitedWhileIsolated = false;
    session.child.once("exit", () => { exitedWhileIsolated = session.internalTurn === true; });
    await assert.rejects(manager.deliverCollaboration(message({ kind: "session", id: session.sessionId }, "INTERNAL_BUSY"), () => { throw new Error("fixture reader failure"); }), error => error instanceof CollaborationDeliveryError && error.status === "unknown");
    assert.ok(session.child.exitCode !== null || session.child.signalCode !== null, "must stop dispatched child before restoring output ownership");
    assert.equal(exitedWhileIsolated, true);
    const lines = [];
    for await (const line of manager.sendSessionMessage("fixture-thread", "b", "Human after reader failure")) lines.push(line);
    assert.notEqual(manager.getActive("fixture-thread")?.child, session.child);
    assert.doesNotMatch(JSON.stringify(lines), /INTERNAL_DONE/);
  } finally { await manager.closeAll(); restore(); }
});

test("rejected stale attempt cannot remove the replacement turn's internal outbox", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  try {
    const old = await manager.getOrCreateSession("fixture-thread", "b");
    await manager.destroySession("fixture-thread");
    const replacement = await manager.getOrCreateSession("fixture-thread", "b");
    const active = manager.deliverCollaboration(message({ kind: "session", id: replacement.sessionId }, "INTERNAL_BUSY"), () => {});
    const privateFile = join(`${replacement.outboxPath}.internal`, "internal.txt");
    await until(() => existsSync(privateFile));
    await assert.rejects(async () => {
      for await (const _ of manager.sendSessionMessage("fixture-thread", "b", "stale", { internal: true, expectedSession: old })) {}
    }, error => error instanceof CollaborationDeliveryError && error.status === "rejected");
    assert.equal(readFileSync(privateFile, "utf8"), "INTERNAL_FILE");
    await active;
  } finally { await manager.closeAll(); restore(); }
});

test("an input reservation before Telegram mention filtering does not refresh activity or idle deadline", { timeout: 30000 }, async () => {
  const { manager, restore } = ownerFixture();
  try {
    const session = await manager.getOrCreateSession("fixture-thread", "b");
    const lastActivity = session.lastActivity;
    const idleTimer = session.idleTimer;
    await delay(20);
    const release = manager.holdHumanInput("fixture-thread");
    release(); // unrelated authorized chatter is filtered without a model turn
    assert.equal(session.lastActivity, lastActivity);
    assert.equal(session.idleTimer, idleTimer);
  } finally { await manager.closeAll(); restore(); }
});


test("stored fallback Telegram topic rejects a changed chat-wide owner after restart without replacing context", { timeout: 30000 }, async () => {
  const { manager, config, root, restore } = ownerFixture();
  let restarted: SessionManager | undefined;
  try {
    config.agents.a = { ...config.agents.b, id: "a" };
    config.bindings = [{ chatId: -101, agentId: "a", kind: "group" }];
    const lane = "-101:7";
    const initial = await manager.getOrCreateSession(lane, "a");
    await manager.closeAll();
    const transcript = readFileSync(initial.sessionFile!, "utf8");
    config.bindings[0].agentId = "b";
    assert.equal(resolveBinding(-101, config.bindings, 7)?.agentId, "b", "normal Telegram routing uses the new fallback owner");
    const storePath = join(root, "state", "sessions.json");
    restarted = new SessionManager(() => config, storePath, join(root, "logs"));
    const stored = readFileSync(storePath, "utf8");
    await assert.rejects(restarted.deliverCollaboration(message({ kind: "thread", id: lane }, "fallback owner check"), () => assert.fail("changed owner must not consume input")), error => error instanceof CollaborationDeliveryError && error.status === "rejected");
    assert.equal(restarted.getActive(lane), undefined);
    assert.equal(readFileSync(storePath, "utf8"), stored);
    assert.equal(readFileSync(initial.sessionFile!, "utf8"), transcript);
  } finally { await restarted?.closeAll(); await manager.closeAll(); restore(); }
});

test("thread owner resolution preserves explicit topics, unchanged fallback, synthetic and Discord lanes", { timeout: 30000 }, async () => {
  const { manager, config, restore } = ownerFixture();
  try {
    config.agents.a = { ...config.agents.b, id: "a" };
    config.bindings = [
      { chatId: -101, agentId: "a", kind: "group", topics: [{ topicId: 8, agentId: "b" }] },
      { chatId: -101, topicId: 9, agentId: "b", kind: "group" },
    ];
    for (const [lane, agentId] of [["-101:7", "a"], ["-101:8", "b"], ["-101:9", "b"], ["fixture-thread", "b"], ["discord:101:7", "b"]]) {
      const initial = await manager.getOrCreateSession(lane, agentId);
      await manager.closeSession(lane);
      let consumed = false;
      await manager.deliverCollaboration(message({ kind: "thread", id: lane }, "unchanged owner check"), () => { consumed = true; });
      assert.equal(consumed, true, lane);
      assert.equal(manager.getActive(lane)?.sessionId, initial.sessionId, lane);
      assert.equal(manager.getActive(lane)?.agentId, agentId, lane);
      await manager.closeSession(lane);
    }
  } finally { await manager.closeAll(); restore(); }
});
