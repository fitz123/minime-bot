import { it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import PQueue from "p-queue";
import { fauxProvider, getSupportedThinkingLevels, clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
const { default: extension } = await import(pathToFileURL(resolve("extensions/pi/session-effort.ts")).href);
import { SessionManager, type ActiveSession } from "../session-manager.js";
import { SessionStore } from "../session-store.js";
import type { BotConfig, PiThinkingLevel } from "../types.js";
import { SESSION_EFFORT_ENV } from "../pi-extensions/session-effort.js";

async function fixture(t: { after: (fn: () => unknown) => void }, thinking?: PiThinkingLevel) {
  const root = mkdtempSync(join(tmpdir(), "minime-session-effort-"));
  const config: BotConfig = {
    telegramToken: "test-token", whisperModelPath: "/tmp/test-model.bin",
    agents: { main: { id: "main", workspaceCwd: root, model: "gpt-5.5", thinking } },
    bindings: [{ chatId: 123, agentId: "main", kind: "group" }],
    sessionDefaults: { idleTimeoutMs: 60_000, maxConcurrentSessions: 4, maxMessageAgeMs: 300_000, requireMention: false, maxMediaBytes: 1024 },
  };
  const manager = new SessionManager(() => config, join(root, "sessions.json"), root, { startupTimeoutMs: 300 });
  const store = (manager as unknown as { store: SessionStore }).store;
  t.after(async () => { await manager.closeAll(); rmSync(root, { recursive: true, force: true }); });
  function lane(key: string, reasoning = true) {
    const model = fauxProvider({ provider: "effort-fixture", models: [{ id: "fixture", reasoning }] }).getModel();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
    let tool: any;
    let effective: PiThinkingLevel = "medium";
    let suppressed = false;
    let held: string | undefined;
    const stdout = new Readable({ read() {} });
    const emit = (event: unknown) => stdout.push(JSON.stringify(event) + "\n");
    const context = { model, modelRegistry: { getAll: () => [model], hasConfiguredAuth: () => true }, ui: { notify(message: string) { if (!suppressed) emit({ type: "extension_ui_request", id: "fixture-notice", method: "notify", notifyType: "info", message }); else held = message; } } } as unknown as ExtensionContext;
    const pi = {
      getSettings: () => ({ defaultThinkingLevel: "low" }),
      getThinkingLevel: () => effective,
      setThinkingLevel: (level: PiThinkingLevel) => { effective = clampThinkingLevel(model, level); },
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerCommand: (name: string, options: any) => commands.set(name, options.handler),
      registerTool: (value: any) => { tool = value; },
    } as unknown as ExtensionAPI;
    const previous = process.env[SESSION_EFFORT_ENV];
    process.env[SESSION_EFFORT_ENV] = JSON.stringify({ inherited: thinking });
    try { extension(pi); } finally {
      if (previous === undefined) delete process.env[SESSION_EFFORT_ENV]; else process.env[SESSION_EFFORT_ENV] = previous;
    }
    handlers.get("session_start")?.({}, context);
    const child = new EventEmitter() as ChildProcess;
    const writes: any[] = [];
    const stdin = new Writable({ write(chunk, _encoding, callback) {
      const command = JSON.parse(chunk.toString());
      writes.push(command);
      const text = String(command.message);
      if (text.startsWith("/")) {
        const [name, args] = text.slice(1).split(" ");
        void commands.get(name)?.(args, context);
      } else emit({ type: "agent_start" });
      callback();
    } });
    Object.assign(child, { stdout, stdin, stderr: null, exitCode: null, signalCode: null, killed: false, kill() { Object.assign(child, { exitCode: 0, killed: true }); stdout.push(null); child.emit("exit", 0, "SIGTERM"); return true; } });
    const session: ActiveSession = {
      child, sessionId: key.replace(":", "-"), sessionFile: join(root, key + ".jsonl"), workspaceRealpath: root,
      agentId: "main", provider: "pi", model: "openai-codex/gpt-5.5", thinking,
      queue: new PQueue({ concurrency: 1 }), idleTimer: null, idleTimeoutMs: 60_000, lastActivity: Date.now(),
      processingStartedAt: null, lastSuccessAt: null, restartCount: 0, outboxPath: join(root, key), pendingSteers: new Map(),
    };
    (manager as unknown as { active: Map<string, ActiveSession> }).active.set(key, session);
    store.setSession(key, { bindingState: "bound", sessionId: session.sessionId, sessionFile: session.sessionFile!, workspaceRealpath: root, chatId: key, agentId: "main", lastActivity: Date.now(), thinking });
    return { session, stdout, writes, emit, tool, context, get effective() { return effective; }, suppress() { suppressed = true; }, release() { suppressed = false; if (held) context.ui.notify(held, "info"); }, settle() { emit({ type: "agent_end", messages: [] }); emit({ type: "agent_settled" }); },
      settleWithReply(split: boolean) {
        assert.ok(held, "effort result is ready before settlement");
        const reply = Buffer.from(JSON.stringify({ type: "extension_ui_request", id: "notice-🧠", method: "notify", notifyType: "info", message: held }) + "\n");
        const boundary = split ? reply.indexOf(Buffer.from("🧠")) + 1 : reply.length;
        stdout.push(Buffer.concat([Buffer.from('{"type":"agent_end","messages":[]}\n{"type":"agent_settled"}\n'), reply.subarray(0, boundary)]));
        return () => { if (split) stdout.push(reply.subarray(boundary)); };
      },
    };
  }
  return { manager, store, root, config, lane };
}

it("isolates two threads, reports native capability, and restores inherited defaults", async t => {
  const { manager, store, lane, config, root } = await fixture(t, "medium");
  const first = lane("123:1");
  const second = lane("123:2");
  assert.match(await manager.sessionEffort("123:1", "main", "high"), /Effort: high \(thread override: high\)/);
  assert.equal(first.effective, "high");
  assert.equal(second.effective, "medium");
  assert.equal(store.getSession("123:1")?.effortOverride, "high");
  assert.equal(store.getSession("123:2")?.effortOverride, undefined);
  assert.equal(new SessionStore(join(root, "sessions.json")).getSession("123:1")?.effortOverride, "high");
  assert.match(await manager.sessionEffort("123:2", "main"), /inherited default/);
  first.emit({ type: "extension_ui_request", id: "idle-dialog", method: "confirm", title: "Confirm" });
  await manager.sessionEffort("123:1", "main");
  assert.ok(first.writes.some(command => command.type === "extension_ui_response" && command.id === "idle-dialog" && command.cancelled === true));

  assert.equal(first.stdout.listenerCount("data"), 0, "idle reader releases stdout");
  const levels = getSupportedThinkingLevels(first.context.model!);
  assert.equal(levels.includes("max"), false);
  await assert.rejects(manager.sessionEffort("123:1", "main", "max"), /Unsupported effort: max.*Effective effort: high/);
  assert.equal(first.effective, "high");
  assert.equal(store.getSession("123:1")?.effortOverride, "high");
  await assert.rejects(manager.sessionEffort("123:1", "main", "impossible"), /Unsupported effort.*Effective effort: high/);
  assert.equal(store.getSession("123:1")?.effortOverride, "high");
  assert.match(await manager.sessionEffort("123:1", "main", "default"), /Effort: medium \(inherited default\)/);
  assert.equal(store.getSession("123:1")?.effortOverride, undefined);
  config.agents.main.thinking = undefined;
  assert.match(await manager.sessionEffort("123:1", "main", "default"), /Effort: low/);
  assert.ok(levels.includes("high"));
  first.context.model!.thinkingLevelMap = { max: "max" };
  assert.match(await manager.sessionEffort("123:1", "main", "max"), /Effort: max \(thread override: max\).*Supported: off, minimal, low, medium, high, max, default/);
  assert.equal(first.effective, "max");
  assert.equal(second.effective, "medium");
  assert.equal(new SessionStore(join(root, "sessions.json")).getSession("123:1")?.effortOverride, "max");
  assert.equal(new SessionStore(join(root, "sessions.json")).getSession("123:1")?.thinking, "max");
  const saved = store.getSession("123:1")!;
  assert.throws(() => store.setSession("123:1", { ...saved, effortOverride: "unknown" as PiThinkingLevel }), /unknown effort override/);

});

it("validates the current model rather than accepting a syntactically valid level", async t => {
  const { manager, store, lane } = await fixture(t);
  lane("123:1", false);
  await assert.rejects(manager.sessionEffort("123:1", "main", "high"), /Supported: off, default/);
  assert.equal(store.getSession("123:1")?.effortOverride, undefined);
});

it("passes configured model syntax and explicit thinking through default reset without reopening Pi", async t => {
  const { manager, store, lane, config } = await fixture(t);
  config.agents.main.model = "effort-fixture/fixture:high";
  const current = lane("123:1");
  assert.match(await manager.sessionEffort("123:1", "main", "default"), /Effort: high \(inherited default\)/);
  assert.equal(store.getSession("123:1")?.effortOverride, undefined);
  config.agents.main.thinking = "low";
  assert.match(await manager.sessionEffort("123:1", "main", "default"), /Effort: low/);
  assert.equal(manager.getActive("123:1"), current.session);
  assert.equal(current.context.model?.id, "fixture");
});

it("changes a busy turn using its reader and persists an explicit tool request before acknowledgement", async t => {
  const { manager, store, lane } = await fixture(t, "low");
  const current = lane("123:1");
  const turn = (async () => { for await (const _line of manager.sendSessionMessage("123:1", "main", "question")) { /* drain */ } })();
  await new Promise(resolve => setTimeout(resolve, 10));
  const readers = current.stdout.listenerCount("data");
  assert.match(await manager.sessionEffort("123:1", "main", "high"), /Effort: high/);
  assert.equal(current.stdout.listenerCount("data"), readers, "no parallel turn reader");
  const result = await current.tool.execute("tool-1", { level: "medium" }, undefined, undefined, current.context);
  assert.equal(result.details.ok, true);
  assert.equal(store.getSession("123:1")?.effortOverride, "medium");
  assert.match(result.content[0].text, /next model request/);
  const save = store.compareAndSetSession.bind(store);
  store.compareAndSetSession = () => { throw new Error("simulated persistence failure"); };
  const failed = await current.tool.execute("tool-2", { level: "high" }, undefined, undefined, current.context);
  store.compareAndSetSession = save;
  assert.equal(failed.details.ok, false);
  assert.equal(failed.isError, true);
  assert.equal(current.effective, "medium");
  assert.equal(store.getSession("123:1")?.effortOverride, "medium");
  assert.equal(current.session.child.killed, false);
  current.settle();
  await turn;
});

it("hands a late busy-control reply to an idle owner after settlement", async t => {
  const { manager, lane } = await fixture(t);
  const current = lane("123:1");
  const turn = (async () => { for await (const _line of manager.sendSessionMessage("123:1", "main", "question")) { /* drain */ } })();
  await new Promise(resolve => setTimeout(resolve, 10));
  current.suppress();
  const change = manager.sessionEffort("123:1", "main", "high");
  await new Promise(resolve => setTimeout(resolve, 10));
  current.settle();
  await turn;
  current.release();
  assert.match(await change, /Effort: high/);
});

for (const split of [false, true]) {
  it(`preserves ${split ? "partial UTF-8 bytes" : "a coalesced effort result"} at settlement with one reader`, async t => {
    const { manager, store, lane } = await fixture(t);
    const current = lane("123:1");
    const lines: string[] = [];
    const turn = (async () => { for await (const line of manager.sendSessionMessage("123:1", "main", "question")) lines.push(line.type); })();
    await new Promise(resolve => setTimeout(resolve, 10));
    current.suppress();
    const change = manager.sessionEffort("123:1", "main", "high");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(current.stdout.listenerCount("data"), 0, "turn owns stdout alone");
    let notices = 0;
    const observer = manager as unknown as { observeEffortEvent: (...args: any[]) => void };
    const original = observer.observeEffortEvent.bind(manager);
    observer.observeEffortEvent = (...args) => { if (args[2].id === "notice-🧠") notices++; original(...args); };
    current.stdout.on("newListener", event => {
      if (event === "data") {
        assert.equal(current.session.processingStartedAt, null, "fallback waits for turn reader release");
        assert.equal(current.stdout.listenerCount("data"), 0, "only one fallback reader");
      }
    });
    const finishReply = current.settleWithReply(split);
    await turn;
    finishReply();
    assert.match(await change, /Effort: high/);
    assert.equal(store.getSession("123:1")?.effortOverride, "high");
    assert.equal(notices, 1, "notice is decoded intact exactly once");
    assert.equal(lines.filter(type => type === "result").length, 1);
    assert.equal(current.stdout.listenerCount("data"), 0, "fallback releases stdout");
    current.release();
    assert.match(await manager.sessionEffort("123:1", "main"), /Effort: high/);
  });
}

it("does not confirm a clean race, missing acknowledgement, or failed durable write", async t => {
  const { manager, store, lane } = await fixture(t);
  const current = lane("123:1");
  const original = store.compareAndSetSession.bind(store);
  store.compareAndSetSession = () => { throw new Error("simulated write failure"); };
  await assert.rejects(manager.sessionEffort("123:1", "main", "high"), /simulated write failure/);
  assert.equal(current.session.effortOverride, undefined);
  assert.equal(current.effective, "low", "failed persistence restores native effort");
  store.compareAndSetSession = original;
  current.suppress();
  await assert.rejects(manager.sessionEffort("123:1", "main", "high"), /did not confirm effort/);
  assert.equal(store.getSession("123:1")?.effortOverride, undefined);
  const changing = manager.sessionEffort("123:1", "main", "high");
  await new Promise(resolve => setTimeout(resolve, 10));
  const rejected = assert.rejects(changing, /exited|changed|closed/);
  await manager.destroySession("123:1");
  await rejected;
  assert.equal(store.getSession("123:1"), undefined);
});

it("rejects a changed binding without touching the busy answer", async t => {
  const { manager, lane, config } = await fixture(t);
  const current = lane("123:1");
  current.session.processingStartedAt = Date.now();
  config.bindings[0].agentId = "another";
  await assert.rejects(manager.sessionEffort("123:1", "main", "high"), /binding changed/);
  assert.equal(current.session.child.killed, false);
  assert.equal(current.writes.length, 0);
});

it("does not evict another busy thread to discover effort capabilities", async t => {
  const { manager, lane, config, store } = await fixture(t);
  const current = lane("123:1");
  current.session.processingStartedAt = Date.now();
  config.sessionDefaults.maxConcurrentSessions = 1;
  await assert.rejects(manager.sessionEffort("123:2", "main"), /all bot session slots are busy/);
  assert.equal(current.session.child.killed, false);
  assert.equal(store.getSession("123:2"), undefined);
});

it("does not register a tool without an interactive Telegram envelope", () => {
  const previous = process.env[SESSION_EFFORT_ENV];
  delete process.env[SESSION_EFFORT_ENV];
  try { extension({ registerTool() { assert.fail("tool registered outside Telegram"); } } as unknown as ExtensionAPI); }
  finally { if (previous !== undefined) process.env[SESSION_EFFORT_ENV] = previous; }
});
