import { it, type TestContext } from "node:test";
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
import type { BotConfig, NativeEffortLevel, PiThinkingLevel } from "../types.js";
import { formatEffortError, SESSION_EFFORT_ENV } from "../pi-extensions/session-effort.js";
import { createTelegramBindingReload } from "../telegram-binding-reload.js";

async function fixture(t: TestContext, thinking?: PiThinkingLevel) {
  const root = mkdtempSync(join(tmpdir(), "minime-session-effort-"));
  const previousRoot = process.env.MINIME_CONTROL_WORKSPACE_ROOT;
  process.env.MINIME_CONTROL_WORKSPACE_ROOT = root;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.MINIME_CONTROL_WORKSPACE_ROOT;
    else process.env.MINIME_CONTROL_WORKSPACE_ROOT = previousRoot;
  });
  const config: BotConfig = {
    telegramToken: "test-token", whisperModelPath: "/tmp/test-model.bin",
    agents: { main: { id: "main", workspaceCwd: root, model: "effort-fixture/fixture", thinking } },
    bindings: [{ chatId: 123, agentId: "main", kind: "group" }, { chatId: 124, agentId: "main", kind: "dm" }],
    sessionDefaults: { idleTimeoutMs: 60_000, maxConcurrentSessions: 4, maxMessageAgeMs: 300_000, requireMention: false, maxMediaBytes: 1024 },
  };
  const initialConfig = { ...config, bindings: structuredClone(config.bindings) };
  const loadControlConfig = t.mock.fn(() => config);
  const loadFullConfig = t.mock.fn(() => config);
  const telegramBindingReload = createTelegramBindingReload(initialConfig, loadControlConfig, loadFullConfig);
  const manager = new SessionManager(loadFullConfig, join(root, "sessions.json"), root, {
    startupTimeoutMs: 300, initialConfig, loadControlConfig, telegramBindingReload,
  });
  const store = (manager as unknown as { store: SessionStore }).store;
  t.after(async () => { await manager.closeAll(); rmSync(root, { recursive: true, force: true }); });
  function lane(key: string, reasoning = true) {
    const model = fauxProvider({ provider: "effort-fixture", models: [{ id: "fixture", reasoning }] }).getModel();
    const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
    const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
    let tool: any;
    const override = store.getSession(key)?.effortOverride;
    let effective: NativeEffortLevel = "medium";
    let suppressed = false;
    let suppressNext = false;
    let held: string | undefined;
    const stdout = new Readable({ read() {} });
    const emit = (event: unknown) => stdout.push(JSON.stringify(event) + "\n");
    const context = { model, modelRegistry: { getAll: () => [model], hasConfiguredAuth: () => true }, ui: { notify(message: string) {
      if (suppressed || suppressNext) {
        held = message;
        suppressNext = false;
      } else emit({ type: "extension_ui_request", id: "fixture-notice", method: "notify", notifyType: "info", message });
    } } } as unknown as ExtensionContext;
    const pi = {
      getSettings: () => ({ defaultThinkingLevel: "low" }),
      getThinkingLevel: () => effective,
      setThinkingLevel: (level: NativeEffortLevel) => { effective = clampThinkingLevel(model, level); },
      on: (name: string, handler: any) => handlers.set(name, handler),
      registerCommand: (name: string, options: any) => commands.set(name, options.handler),
      registerTool: (value: any) => { tool = value; },
    } as unknown as ExtensionAPI;
    const previous = process.env[SESSION_EFFORT_ENV];
    const previousAgent = process.env.MINIME_BOT_PI_SESSION_AGENT_ID;
    process.env[SESSION_EFFORT_ENV] = JSON.stringify({ inherited: thinking, override });
    process.env.MINIME_BOT_PI_SESSION_AGENT_ID = "main";
    try { extension(pi); } finally {
      if (previous === undefined) delete process.env[SESSION_EFFORT_ENV]; else process.env[SESSION_EFFORT_ENV] = previous;
      if (previousAgent === undefined) delete process.env.MINIME_BOT_PI_SESSION_AGENT_ID; else process.env.MINIME_BOT_PI_SESSION_AGENT_ID = previousAgent;
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
      } else {
        handlers.get("message_start")?.({ message: { role: "user" } }, context);
        emit({ type: "agent_start" });
      }
      callback();
    } });
    Object.assign(child, { stdout, stdin, stderr: null, exitCode: null, signalCode: null, killed: false, kill() { Object.assign(child, { exitCode: 0, killed: true }); stdout.push(null); child.emit("exit", 0, "SIGTERM"); return true; } });
    const session: ActiveSession = {
      child, sessionId: key.replace(":", "-"), sessionFile: join(root, key + ".jsonl"), workspaceRealpath: root,
      agentId: "main", provider: "pi", model: config.agents.main.model, thinking, effortOverride: override,
      queue: new PQueue({ concurrency: 1 }), idleTimer: null, idleTimeoutMs: 60_000, lastActivity: Date.now(),
      processingStartedAt: null, lastSuccessAt: null, restartCount: 0, outboxPath: join(root, key), pendingSteers: new Map(),
    };
    (manager as unknown as { active: Map<string, ActiveSession> }).active.set(key, session);
    store.setSession(key, { bindingState: "bound", sessionId: session.sessionId, sessionFile: session.sessionFile!, workspaceRealpath: root, chatId: key, agentId: "main", lastActivity: Date.now(), thinking, effortOverride: override });
    return { session, stdout, writes, emit, tool, context, get effective() { return effective; }, suppress() { suppressed = true; }, suppressNext() { suppressNext = true; }, release() { suppressed = false; if (held) context.ui.notify(held, "info"); }, settle() { emit({ type: "agent_end", messages: [] }); emit({ type: "agent_settled" }); },
      settleWithReply(split: boolean) {
        assert.ok(held, "effort result is ready before settlement");
        const reply = Buffer.from(JSON.stringify({ type: "extension_ui_request", id: "notice-🧠", method: "notify", notifyType: "info", message: held }) + "\n");
        const boundary = split ? reply.indexOf(Buffer.from("🧠")) + 1 : reply.length;
        stdout.push(Buffer.concat([Buffer.from('{"type":"agent_end","messages":[]}\n{"type":"agent_settled"}\n'), reply.subarray(0, boundary)]));
        return () => { if (split) stdout.push(reply.subarray(boundary)); };
      },
    };
  }
  return { manager, store, root, config, lane, loadControlConfig, loadFullConfig, telegramBindingReload };
}

it("isolates two threads, reports native capability, and restores inherited defaults", async t => {
  const { manager, store, lane, config, root } = await fixture(t, "medium");
  const first = lane("123:1");
  const second = lane("123:2");
  assert.match(await manager.sessionEffort("123:1", "main", "high"), /Effort is high.*conversation override/);
  assert.equal(first.effective, "high");
  assert.equal(second.effective, "medium");
  assert.equal(store.getSession("123:1")?.effortOverride, "high");
  assert.equal(store.getSession("123:2")?.effortOverride, undefined);
  assert.equal(new SessionStore(join(root, "sessions.json")).getSession("123:1")?.effortOverride, "high");
  assert.match(await manager.sessionEffort("123:2", "main"), /agent configuration/);
  first.emit({ type: "extension_ui_request", id: "idle-dialog", method: "confirm", title: "Confirm" });
  await manager.sessionEffort("123:1", "main");
  assert.ok(first.writes.some(command => command.type === "extension_ui_response" && command.id === "idle-dialog" && command.cancelled === true));

  assert.equal(first.stdout.listenerCount("data"), 0, "idle reader releases stdout");
  const levels = getSupportedThinkingLevels(first.context.model!);
  assert.equal(levels.includes("max"), false);
  await assert.rejects(manager.sessionEffort("123:1", "main", "max"), /does not support that effort level.*Effort is high/);
  assert.equal(first.effective, "high");
  assert.equal(store.getSession("123:1")?.effortOverride, "high");
  const invalid = "x".repeat(4096 - "/effort ".length);
  await assert.rejects(manager.sessionEffort("123:1", "main", invalid), error => {
    const reply = formatEffortError(error);
    assert.match(reply, /does not support that effort level.*Effort is high.*Supported levels/);
    assert.ok(reply.length <= 4096);
    return true;
  });
  assert.equal(store.getSession("123:1")?.effortOverride, "high");
  assert.match(await manager.sessionEffort("123:1", "main", "inherit"), /Effort is medium.*agent configuration/);
  assert.equal(store.getSession("123:1")?.effortOverride, undefined);
  config.agents.main.thinking = undefined;
  assert.match(await manager.sessionEffort("123:1", "main", "inherit"), /Effort is low/);
  assert.ok(levels.includes("high"));
  first.context.model!.thinkingLevelMap = { max: "max" };
  assert.match(await manager.sessionEffort("123:1", "main", "max"), /Effort is max.*conversation override.*Supported levels are off, minimal, low, medium, high, max/);
  assert.equal(first.effective, "max");
  assert.equal(second.effective, "medium");
  assert.equal(new SessionStore(join(root, "sessions.json")).getSession("123:1")?.effortOverride, "max");
  assert.equal(new SessionStore(join(root, "sessions.json")).getSession("123:1")?.thinking, "medium");
  const saved = store.getSession("123:1")!;
  assert.throws(() => store.setSession("123:1", { ...saved, effortOverride: "unknown" as NativeEffortLevel }), /unknown effort override/);
});

it("validates the current model rather than accepting a syntactically valid level", async t => {
  const { manager, store, lane } = await fixture(t);
  lane("123:1", false);
  await assert.rejects(manager.sessionEffort("123:1", "main", "high"), /Supported levels are off/);
  assert.equal(store.getSession("123:1")?.effortOverride, undefined);
});

it("passes configured model syntax and explicit thinking through default reset without reopening Pi", async t => {
  const { manager, store, lane, config } = await fixture(t);
  config.agents.main.model = "effort-fixture/fixture:high";
  const current = lane("123:1");
  assert.match(await manager.sessionEffort("123:1", "main", "inherit"), /Effort is high.*agent configuration/);
  assert.equal(store.getSession("123:1")?.effortOverride, undefined);
  config.agents.main.thinking = "low";
  assert.match(await manager.sessionEffort("123:1", "main", "inherit"), /Effort is low/);
  assert.equal(manager.getActive("123:1"), current.session);
  assert.equal(current.context.model?.id, "fixture");
});

it("changes a busy turn using its reader and persists an explicit tool request before acknowledgement", async t => {
  const { manager, store, lane } = await fixture(t, "low");
  const current = lane("123:1");
  const turn = (async () => { for await (const _line of manager.sendSessionMessage("123:1", "main", "question")) { /* drain */ } })();
  await new Promise(resolve => setTimeout(resolve, 10));
  const readers = current.stdout.listenerCount("data");
  assert.match(await manager.sessionEffort("123:1", "main", "high"), /Effort is high/);
  assert.equal(current.stdout.listenerCount("data"), readers, "no parallel turn reader");
  const result = await current.tool.execute("tool-1", { level: "medium" }, undefined, undefined, current.context);
  assert.equal(result.details.ok, true);
  assert.equal(store.getSession("123:1")?.effortOverride, "medium");
  assert.match(result.content[0].text, /next model request/);
  const save = store.compareAndSetSession.bind(store);
  store.compareAndSetSession = () => { throw new Error("simulated persistence failure at /tmp/synthetic-private-store.json"); };
  const failed = await current.tool.execute("tool-2", { level: "high" }, undefined, undefined, current.context);
  store.compareAndSetSession = save;
  assert.equal(failed.details.ok, false);
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /control data is unavailable/);
  assert.doesNotMatch(failed.content[0].text, /synthetic-private-store/);
  assert.equal(current.effective, "medium");
  assert.equal(store.getSession("123:1")?.effortOverride, "medium");
  assert.equal(current.session.child.killed, false);
  current.settle();
  await turn;
});

it("uses applied permissions for commands and tools and reads DM settings once per control", async t => {
  const { manager, store, lane, config, loadFullConfig, loadControlConfig } = await fixture(t, "low");
  const current = lane("123:1");
  config.bindings[0].kind = "dm";
  config.bindings[1].kind = "group";
  await assert.rejects(manager.sessionEffort("123:1", "main", "default high"), /private chat with a DM binding/);
  assert.equal(current.writes.length, 0);
  await assert.rejects(manager.sessionEffort("123:1", "main", "default"), /\/effort inherit/);
  const dm = lane("124:1");
  for (const [key, session] of [["123:1", current], ["124:1", dm]] as const) {
    const turn = (async () => { for await (const _line of manager.sendSessionMessage(key, "main", "question")) { /* drain */ } })();
    await new Promise(resolve => setImmediate(resolve));
    loadFullConfig.mock.resetCalls();
    loadControlConfig.mock.resetCalls();
    try {
      const changed = await session.tool.execute("change", { scope: "default", level: "high" }, undefined, undefined, session.context);
      if (session === current) {
        assert.equal(changed.isError, true);
        assert.match(changed.content[0].text, /private chat with a DM binding/);
        assert.equal(loadControlConfig.mock.callCount(), 0);
      } else {
        assert.equal(changed.isError, false);
        assert.match(changed.content[0].text, /agent's default for this model is now high/);
        assert.equal(loadControlConfig.mock.callCount(), 1);
        assert.equal(dm.effective, "low", "the current message keeps its inherited level");
        const status = await manager.sessionEffort(key, "main");
        assert.match(status, /Effort is high.*agent default.*Supported levels/);
        assert.equal(loadControlConfig.mock.callCount(), 2);
        assert.equal(store.getSession(key)?.effortOverride, undefined);
      }
      assert.equal(loadFullConfig.mock.callCount(), 0);
    } finally {
      session.settle();
      await turn;
    }
  }
  await assert.rejects(manager.sessionEffort("124:1", "main", "default max"), /does not support that effort level/);
  assert.match(await manager.sessionEffort("123:1", "main"), /Effort is high.*agent default/);
});

it("rejects and acknowledges an internal tool request while a human control waits for settlement", { timeout: 2_000 }, async t => {
  const { manager, store, lane } = await fixture(t);
  const current = lane("123:1");
  const turn = (async () => { for await (const _line of manager.sendSessionMessage("123:1", "main", "question")) { /* drain */ } })();
  await new Promise(resolve => setImmediate(resolve));
  current.session.internalTurn = true;
  const change = manager.sessionEffort("123:1", "main", "medium");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(current.session.queue.size, 1);
  try {
    const result = await current.tool.execute("internal", { level: "high" }, undefined, undefined, current.context);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /current human Telegram conversation/);
  } finally {
    current.session.internalTurn = false;
    current.settle();
    await turn;
  }
  assert.match(await change, /Effort is medium/);
  assert.equal(store.getSession("123:1")?.effortOverride, "medium");
});

it("hands a late busy-control reply to an idle owner after settlement", async t => {
  const { manager, lane } = await fixture(t);
  const current = lane("123:1");
  let finishOutput!: () => void;
  const outputDone = new Promise<void>(resolve => { finishOutput = resolve; });
  t.after(() => finishOutput());
  const turn = (async () => { for await (const _line of manager.sendSessionMessage("123:1", "main", "question", { outputDone })) { /* drain */ } })();
  await new Promise(resolve => setTimeout(resolve, 10));
  current.suppress();
  const change = manager.sessionEffort("123:1", "main", "high");
  await new Promise(resolve => setTimeout(resolve, 10));
  current.settle();
  await turn;
  current.release();
  assert.match(await change, /Effort is high/);
  assert.equal(current.session.processingStartedAt, null);
  assert.equal(current.session.queue.pending, 1, "delivery still owns the prompt queue");
  assert.match(await manager.sessionEffort("123:1", "main"), /Effort is high/, "status after reader release does not wait for delivery");
  assert.match(await manager.sessionEffort("123:1", "main", "low"), /Effort is low/, "a later control does not wait for delivery");
  finishOutput();
  await current.session.queue.onIdle();
});

for (const split of [false, true]) {
  it(`preserves ${split ? "partial UTF-8 bytes" : "a coalesced effort result"} at settlement with one reader`, async t => {
    const { manager, store, lane } = await fixture(t);
    const current = lane("123:1");
    let finishOutput!: () => void;
    const outputDone = new Promise<void>(resolve => { finishOutput = resolve; });
    t.after(() => finishOutput());
    const lines: string[] = [];
    const turn = (async () => { for await (const line of manager.sendSessionMessage("123:1", "main", "question", { outputDone })) lines.push(line.type); })();
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
    assert.match(await change, /Effort is high/);
    assert.equal(store.getSession("123:1")?.effortOverride, "high");
    assert.equal(notices, 1, "notice is decoded intact exactly once");
    assert.equal(lines.filter(type => type === "result").length, 1);
    assert.equal(current.stdout.listenerCount("data"), 0, "fallback releases stdout");
    assert.equal(current.session.queue.pending, 1, "delivery retains the prompt queue");
    current.release();
    assert.match(await manager.sessionEffort("123:1", "main"), /Effort is high/);
    finishOutput();
    await current.session.queue.onIdle();
  });
}

it("keeps the next prompt queued when delivery finishes before the control reply", async t => {
  const { manager, lane } = await fixture(t);
  const current = lane("123:1");
  let finishOutput!: () => void;
  const outputDone = new Promise<void>(resolve => { finishOutput = resolve; });
  t.after(() => finishOutput());
  const turn = (async () => { for await (const _line of manager.sendSessionMessage("123:1", "main", "question", { outputDone })) { /* drain */ } })();
  await new Promise(resolve => setTimeout(resolve, 10));
  current.suppress();
  const change = manager.sessionEffort("123:1", "main", "high");
  await new Promise(resolve => setTimeout(resolve, 10));
  current.settle();
  await turn;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(current.stdout.listenerCount("data"), 1, "control exclusively owns stdout during delivery");
  const next = (async () => { for await (const _line of manager.sendSessionMessage("123:1", "main", "next question")) { /* drain */ } })();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(current.writes.some(command => command.message === "next question"), false, "delivery holds the next prompt");
  finishOutput();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(current.writes.some(command => command.message === "next question"), false, "control reader holds the next prompt after delivery");
  current.release();
  assert.match(await change, /Effort is high/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(current.writes.some(command => command.message === "next question"), true);
  assert.equal(current.stdout.listenerCount("data"), 0, "next turn owns stdout without a duplicate control reader");
  current.settle();
  await next;
});

it("retains control ownership through restoration when delivery finishes during a failed save", async t => {
  const { manager, store, lane } = await fixture(t, "low");
  const current = lane("123:1");
  let finishOutput!: () => void;
  const outputDone = new Promise<void>(resolve => { finishOutput = resolve; });
  t.after(() => finishOutput());
  const turn = (async () => { for await (const _line of manager.sendSessionMessage("123:1", "main", "question", { outputDone })) { /* drain */ } })();
  await new Promise(resolve => setTimeout(resolve, 10));
  current.settle();
  await turn;
  const next = (async () => { for await (const _line of manager.sendSessionMessage("123:1", "main", "next question")) { /* drain */ } })();
  store.compareAndSetSession = () => {
    finishOutput();
    current.suppress();
    throw new Error("simulated write failure");
  };
  const rejected = assert.rejects(manager.sessionEffort("123:1", "main", "high"), /simulated write failure/);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(current.writes.filter(command => String(command.message).startsWith("/minime-session-effort ")).length, 2, "restoration was sent");
  assert.equal(current.stdout.listenerCount("data"), 1, "restoration has one reader after delivery finishes");
  assert.equal(current.writes.some(command => command.message === "next question"), false);
  current.release();
  await rejected;
  assert.equal(current.effective, "low");
  assert.equal(store.getSession("123:1")?.effortOverride, undefined);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(current.writes.some(command => command.message === "next question"), true);
  current.settle();
  await next;
});

it("restores durable effort after a late reply and does not persist across clean", async t => {
  const { manager, store, lane } = await fixture(t);
  const current = lane("123:1");
  const original = store.compareAndSetSession.bind(store);
  store.compareAndSetSession = () => { throw new Error("simulated write failure"); };
  await assert.rejects(manager.sessionEffort("123:1", "main", "high"), /simulated write failure/);
  assert.equal(current.session.effortOverride, undefined);
  assert.equal(current.effective, "low", "failed persistence restores native effort");
  store.compareAndSetSession = original;
  assert.match(await manager.sessionEffort("123:1", "main", "medium"), /Effort is medium/);
  current.suppressNext();
  await assert.rejects(manager.sessionEffort("123:1", "main", "high"), /did not confirm effort/);
  current.release();
  assert.equal(current.effective, "medium");
  assert.equal(store.getSession("123:1")?.effortOverride, "medium");
  assert.match(await manager.sessionEffort("123:1", "main"), /Effort is medium.*conversation override/);
  await manager.closeSession("123:1");
  const reopened = lane("123:1");
  assert.equal(reopened.effective, "medium");
  assert.match(await manager.sessionEffort("123:1", "main"), /Effort is medium.*conversation override/);
  reopened.suppress();
  const changing = manager.sessionEffort("123:1", "main", "high");
  await new Promise(resolve => setTimeout(resolve, 10));
  const rejected = assert.rejects(changing, /exited|changed|closed/);
  await manager.destroySession("123:1");
  await rejected;
  assert.equal(store.getSession("123:1"), undefined);
});

it("rejects a changed binding without touching the busy answer", async t => {
  const { manager, lane, telegramBindingReload } = await fixture(t);
  const current = lane("123:1");
  current.session.processingStartedAt = Date.now();
  telegramBindingReload.getBindings()[0].agentId = "another";
  await assert.rejects(manager.sessionEffort("123:1", "main", "high"), /binding changed/);
  assert.equal(current.session.child.killed, false);
  assert.equal(current.writes.length, 0);
});

it("rechecks the applied binding before dispatching a queued control", async t => {
  const { manager, lane, config, telegramBindingReload } = await fixture(t);
  const current = lane("123:1");
  let release!: () => void;
  const held = current.session.queue.add(() => new Promise<void>(resolve => { release = resolve; }));
  t.after(() => release());
  const change = manager.sessionEffort("123:1", "main", "high");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(current.session.queue.size, 1);
  config.bindings = config.bindings.filter(binding => binding.kind === "dm");
  telegramBindingReload.reload(() => {});
  release();
  await held;
  await assert.rejects(change, /binding changed/);
  assert.equal(current.writes.length, 0);
});

it("preserves a busy answer when its configured model or worker route changes", async t => {
  const { manager, lane, config } = await fixture(t);
  const current = lane("124:1");
  current.session.processingStartedAt = Date.now();
  config.agents.main.model = "effort-fixture/another-model";
  await assert.rejects(manager.sessionEffort("124:1", "main", "default high"), /Configured model changed.*wait for the current answer/);
  config.agents.main.workerRuntime = { socketPath: "/tmp/synthetic-worker.sock", workerUid: 1234, controllerName: "fixture" };
  await assert.rejects(manager.sessionEffort("124:1", "main"), /Worker routing changed.*Restart the controller/);
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
