import assert from "node:assert/strict";
import { test, mock, type TestContext } from "node:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "grammy/types";
import type { SessionStore } from "../session-store.js";
import { TopicStore } from "../topic-store.js";
import type { CollaborationClient as Client } from "../collaboration.js";
import { EventEmitter } from "node:events";
import { Duplex } from "node:stream";
import * as net from "node:net";

// Replace only the OS socket boundary. Run the actual router framing, registration,
// client deadlines and owner dispatch even where the executor cannot bind sockets.
class Wire extends Duplex {
  peer?: Wire;
  _read() {}
  _write(chunk: Buffer, _encoding: string, callback: () => void) { this.peer!.push(chunk); callback(); }
  _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    if (!this.peer?.destroyed) this.peer?.destroy();
    callback(error);
  }
}
const servers = new Map<string, (socket: Wire) => void>();
mock.module("node:net", { namedExports: { ...net,
  createServer: (accept: (socket: Wire) => void) => {
    const server = new EventEmitter() as any;
    let path: string;
    server.listen = (value: string, ready: () => void) => {
      path = value; writeFileSync(path, "socket fixture", { mode: 0o600 }); servers.set(path, accept); queueMicrotask(ready);
    };
    server.close = (done: () => void) => { servers.delete(path); unlinkSync(path); done(); };
    return server;
  },
  createConnection: (path: string) => {
    const client = new Wire(), server = new Wire(); client.peer = server; server.peer = client;
    queueMicrotask(() => {
      const accept = servers.get(path);
      if (!accept) { client.destroy(Object.assign(new Error("fixture disconnected"), { code: "ECONNREFUSED" })); return; }
      accept(server); client.emit("connect");
    });
    return client;
  },
} });
const { createTelegramBot, BOT_COMMANDS } = await import("../telegram-bot.js");
const { SessionManager } = await import("../session-manager.js");
const { CollaborationClient, CollaborationRouter, collaborationTransport } = await import("../collaboration.js");
const { registerCollaboration } = await import("../pi-extensions/collaboration.js");
import type { BotConfig } from "../types.js";

// Synthetic numeric identities: peer, bot and event author deliberately differ.
const target = { botId: 900, chatId: 100, topicId: 10 };
const icons = [
  { custom_emoji_id: "catalog-code", emoji: "💻" },
  { custom_emoji_id: "catalog-garden", emoji: "🌱" },
  { custom_emoji_id: "catalog-music", emoji: "🎵" },
];
function message(extra: Record<string, unknown> = {}): Message {
  return { message_id: 1, date: Math.floor(Date.now() / 1000), from: { id: 101, is_bot: false, first_name: "Fixture" },
    chat: { id: target.chatId, type: "private", first_name: "Fixture" }, message_thread_id: target.topicId, ...extra } as Message;
}
async function fixture(t: TestContext, change?: (config: BotConfig) => void, botId = target.botId) {
  const root = mkdtempSync(join(tmpdir(), "private-topics-"));
  const previousRoot = process.env.MINIME_CONTROL_WORKSPACE_ROOT;
  process.env.MINIME_CONTROL_WORKSPACE_ROOT = root;
  t.after(() => { if (previousRoot === undefined) delete process.env.MINIME_CONTROL_WORKSPACE_ROOT; else process.env.MINIME_CONTROL_WORKSPACE_ROOT = previousRoot; });
  const config: BotConfig = {
    telegramToken: "synthetic-token", whisperModelPath: join(root, "unused-model"),
    agents: { main: { id: "main", workspaceCwd: root, model: "fixture-model" } },
    bindings: [{ chatId: 100, kind: "dm", agentId: "main" }],
    sessionDefaults: { idleTimeoutMs: 60000, maxConcurrentSessions: 2, maxMessageAgeMs: 300000, requireMention: false, maxMediaBytes: 1000 },
    collaboration: { socketPath: join(root, "router.sock") },
    privateTopics: { enabled: true, maxNameGraphemes: 17 },
  };
  change?.(config);
  const manager = new SessionManager(() => config, join(root, "sessions.json"), root);
  const sessions = (manager as unknown as { store: SessionStore }).store;
  function bind(lane = "100:10", sessionId = "fixture-session", agentId = "main") {
    sessions.setSession(lane, { bindingState: "bound", chatId: lane, agentId, sessionId, sessionFile: join(root, `${sessionId}.jsonl`), workspaceRealpath: root, lastActivity: Date.now() });
  }
  bind();
  const result = createTelegramBot(config, manager, { topicStorePath: join(root, "topics.json") });
  const { bot, topicController: controller } = result;
  const api: Array<{ method: string; payload: any; signal?: { aborted: boolean } }> = [];
  let edit: () => Promise<unknown> = async () => true;
  let catalog: () => Promise<typeof icons> = async () => icons;
  bot.api.config.use(async (_previous, method, payload, signal) => {
    api.push({ method, payload, signal });
    return { ok: true, result: method === "getForumTopicIconStickers" ? await catalog() : method === "editForumTopic" ? await edit() : true } as any;
  });
  bot.botInfo = { id: botId, is_bot: true, first_name: "Fixture", username: "fixture_bot" } as any;
  manager.setTopicController(controller);
  const inputs: string[] = [];
  t.mock.method(result.messageQueue, "enqueue", (_lane: string, _agent: string, text: string) => { inputs.push(text); });
  const transport = collaborationTransport(config) ?? { socketPath: config.collaboration!.socketPath, topicOnly: false };
  const router = new CollaborationRouter({ discover: () => [], deliver: async () => {},
    topicContext: source => manager.topicContext(source), topicApply: (source, request) => manager.topicApply(source, request) }, { topicOnly: transport.topicOnly });
  await router.start(transport.socketPath);
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) client.close(); await controller?.waitForIdle(); await router.stop(); result.messageQueue.clearAll(); rmSync(root, { recursive: true, force: true }); });
  return { root, transport, config, manager, sessions, bind, ...result, controller: controller!, api, inputs,
    setCatalog: (fn: () => Promise<typeof icons>) => { catalog = fn; },
    setEdit: (fn: () => Promise<unknown>) => { edit = fn; },
    async send(extra: Record<string, unknown> = {}) { await bot.handleUpdate({ update_id: 1, message: message(extra) } as any); },
    async client(kind: "terminal" | "session", id: string) {
      const client = new CollaborationClient(transport.socketPath, { kind, id }, "fixture", () => {});
      clients.push(client); assert.equal(await client.connect(), true); return client;
    },
  };
}
async function extension(t: TestContext, socket: string, session = "fixture-session", enabled = true, topicOnly = false) {
  const keys = ["MINIME_COLLABORATION_SOCKET", "MINIME_COLLABORATION_SESSION", "MINIME_PRIVATE_TOPIC_POLICY", "MINIME_COLLABORATION_TOPIC_ONLY"];
  const previous = keys.map(key => process.env[key]);
  process.env.MINIME_COLLABORATION_SOCKET = socket;
  process.env.MINIME_COLLABORATION_SESSION = session;
  if (topicOnly) process.env.MINIME_COLLABORATION_TOPIC_ONLY = "1"; else delete process.env.MINIME_COLLABORATION_TOPIC_ONLY;
  if (enabled) process.env.MINIME_PRIVATE_TOPIC_POLICY = "1"; else delete process.env.MINIME_PRIVATE_TOPIC_POLICY;
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const tools = new Map<string, any>();
  registerCollaboration({ on: (name: string, handler: any) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool: (tool: any) => { tools.set(tool.name, tool); } } as any);
  const emit = async (name: string, ...args: any[]) => {
    const results = [];
    for (const handler of handlers.get(name) ?? []) results.push(await handler(...args));
    return results.find(result => result?.message || result?.systemPrompt !== undefined);
  };
  t.after(async () => { await emit("session_shutdown"); keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; }); });
  await emit("session_start", {}, { sessionManager: { getSessionId: () => session } });
  return { tools, emit, async context(prompt: string) {
    const result = await emit("before_agent_start", { messageType: "user", prompt, systemPrompt: "unchanged" });
    if (result) {
      assert.equal(result.message, undefined, "topic context must never inject a transcript message");
      assert.ok(result.systemPrompt.startsWith("unchanged\n\n"), "preserve the existing system prompt");
      return JSON.parse(result.systemPrompt.slice("unchanged\n\nPrivate topic context:\n".length));
    }
  } };
}

test("representative fake end-to-end: authorized Message → registry → current session IPC → Pi context/tool → one combined edit → complete", async t => {
  const f = await fixture(t);
  const pi = await extension(t, f.config.collaboration!.socketPath);
  await f.send({ text: "hello" });
  assert.equal(f.inputs.length, 1, "ordinary greeting still routes to the existing message queue");
  assert.equal(f.controller.store.get(target)?.name.provenance, "unknown");
  const waiting = await pi.context("hello");
  assert.match(waiting.instruction, /Greetings.*must wait/);
  assert.equal(f.api.filter(c => c.method === "editForumTopic").length, 0);
  await f.send({ text: "Help design a compiler" });
  const context = await pi.context("Help design a compiler");
  assert.equal(context.status, "needs_presentation");
  assert.deepEqual(context.candidates[0], { index: 0, emoji: "💻" });
  assert.ok(!JSON.stringify(context).includes("catalog-code"), "context uses safe catalog indices rather than custom emoji identifiers");
  const output = await pi.tools.get("topic_apply").execute("fixture-call", { revision: context.revision, name: "Compiler design", iconCandidates: [0] });
  assert.equal(JSON.parse(output.content[0].text).status, "accepted");
  await f.controller.waitForIdle();
  assert.deepEqual(f.api.filter(c => c.method === "editForumTopic").map(c => c.payload), [{ chat_id: 100, message_thread_id: 10, name: "Compiler design", icon_custom_emoji_id: "catalog-code" }]);
  const stored = new TopicStore(f.controller.store.path).get(target)!;
  assert.equal(stored.initialized, true);
  assert.equal(stored.name.provenance, "policy-initialized");
  assert.equal(stored.pending, undefined);
  await f.send({ text: "Now add parsing" });
  assert.equal((await pi.context("Now add parsing")).status, "complete");
  assert.equal(JSON.parse((await pi.tools.get("topic_apply").execute("old-call", { revision: context.revision, name: "Parsing", iconCandidates: [1] })).content[0].text).status, "complete");
  assert.equal(f.api.filter(c => c.method === "editForumTopic").length, 1);
  assert.equal(f.inputs.length, 3);
  assert.ok(!BOT_COMMANDS.some(command => (command.command as string) === "topic"));
});

test("service observations distinguish author/peer, implicit/unknown/manual provenance, absent fields and an empty icon", async t => {
  const f = await fixture(t);
  await f.send({ forum_topic_created: { name: "Topic", is_name_implicit: true, icon_color: 0, icon_custom_emoji_id: "catalog-code" } });
  let topic = f.controller.store.get(target)!;
  assert.equal(f.inputs.length, 0, "service-only messages never start a model turn");
  assert.equal(topic.name.provenance, "implicit");
  assert.equal(topic.name.pinned, false);
  assert.equal(topic.icon.pinned, true);
  assert.equal(topic.icon.provenance, "manual");
  await f.send({ forum_topic_edited: { icon_custom_emoji_id: "" } });
  topic = f.controller.store.get(target)!;
  assert.equal(topic.icon.value, "");
  assert.equal(topic.icon.pinned, true);
  assert.equal(topic.name.value, "Topic", "absent name does not change it");
  await f.send({ forum_topic_edited: { name: "Hand chosen" } });
  topic = f.controller.store.get(target)!;
  assert.equal(topic.name.pinned, true, "manual author differs from chat peer and still pins");
  assert.equal(topic.icon.value, "", "absent icon preserves an explicit clear");
  await f.send({ from: { id: target.botId, is_bot: true, first_name: "Fixture" }, forum_topic_edited: { name: "Old bot echo", icon_custom_emoji_id: "catalog-code" } });
  assert.deepEqual(f.controller.store.get(target)!.name, topic.name);
  assert.deepEqual(f.controller.store.get(target)!.icon, topic.icon);
  assert.equal((await f.controller.context(target) as any).status, "complete");
  assert.deepEqual(f.api.map(call => call.method), ["getForumTopicIconStickers"]);
});

test("implicit names do not make icons implicit or release uncertain icons without a human icon observation", async t => {
  const f = await fixture(t);
  const implicit = { name: "Topic", is_name_implicit: true, icon_color: 0 };
  for (const from of [undefined, { id: target.botId, is_bot: true, first_name: "Fixture" }]) {
    await f.send({ from, forum_topic_created: { ...implicit, icon_custom_emoji_id: "catalog-code" } });
    const topic = f.controller.store.get(target)!;
    assert.equal(topic.name.provenance, "implicit");
    assert.equal(topic.icon.provenance, "unknown");
    assert.equal(topic.icon.pinned, false);
  }
  for (const icon of ["catalog-garden", ""]) {
    await f.send({ forum_topic_edited: { icon_custom_emoji_id: "catalog-garden" } });
    await f.send({ from: { id: target.botId, is_bot: true, first_name: "Fixture" },
      forum_topic_created: { ...implicit, icon_custom_emoji_id: "catalog-code" } });
    assert.deepEqual(f.controller.store.get(target)!.occupiedIconIds, ["catalog-code"]);
    await f.send({ forum_topic_created: implicit });
    assert.deepEqual(f.controller.store.get(target)!.occupiedIconIds, ["catalog-code"], "absent icon cannot release occupancy");
    await f.send({ forum_topic_created: { ...implicit, icon_custom_emoji_id: icon } });
    const topic = new TopicStore(f.controller.store.path).get(target)!;
    assert.equal(topic.name.provenance, "implicit");
    assert.equal(topic.name.pinned, false);
    assert.equal(topic.icon.value, icon);
    assert.equal(topic.icon.provenance, "manual");
    assert.equal(topic.icon.pinned, true);
    assert.equal(topic.occupiedIconIds, undefined, "explicit human icon resets occupancy even with an implicit name");
  }
});

test("own creation/edits and missing authors never become manual pins; explicit creation does", async t => {
  const f = await fixture(t);
  for (const extra of [
    { from: { id: target.botId, is_bot: true, first_name: "Fixture" }, forum_topic_created: { name: "Created", icon_color: 0 } },
    { from: undefined, forum_topic_edited: { name: "Observed" } },
    { from: { id: 902, is_bot: true, first_name: "Fixture" }, forum_topic_edited: { icon_custom_emoji_id: "catalog-garden" } },
  ]) await f.send(extra);
  let topic = f.controller.store.get(target)!;
  assert.equal(topic.name.pinned, false);
  assert.equal(topic.name.provenance, "unknown");
  assert.equal(topic.icon.pinned, false);
  await f.send({ forum_topic_created: { name: "Explicit", icon_color: 0, icon_custom_emoji_id: "catalog-music" } });
  topic = f.controller.store.get(target)!;
  assert.equal(topic.name.provenance, "manual");
  assert.equal(topic.name.pinned, true);
  assert.equal(topic.icon.pinned, true);
});

test("a pinned name permits only an icon edit, and a pinned cleared icon permits only a name edit", async t => {
  const f = await fixture(t);
  await f.send({ forum_topic_edited: { name: "Manual name" } });
  const context = await f.controller.context(target) as any;
  assert.equal(context.namePinned, true);
  assert.equal((f.controller.apply(target, { revision: context.revision, name: "Ignored", iconCandidates: [0] }, () => true) as any).status, "accepted");
  await f.controller.waitForIdle();
  assert.deepEqual(f.api.find(c => c.method === "editForumTopic")!.payload, { chat_id: 100, message_thread_id: 10, icon_custom_emoji_id: "catalog-code" });
  assert.equal(f.controller.store.get(target)!.name.value, "Manual name");
  await f.send({ message_thread_id: 20, forum_topic_edited: { icon_custom_emoji_id: "" } });
  const second = { ...target, topicId: 20 };
  const ctx2 = await f.controller.context(second) as any;
  assert.equal(ctx2.iconPinned, true);
  f.controller.apply(second, { revision: ctx2.revision, name: "Gardening", iconCandidates: [1] }, () => true);
  await f.controller.waitForIdle();
  assert.deepEqual(f.api.filter(c => c.method === "editForumTopic").at(-1)!.payload, { chat_id: 100, message_thread_id: 20, name: "Gardening" });
  await f.send({ forum_topic_edited: { name: "Later manual" } });
  assert.equal(f.controller.store.get(target)!.name.value, "Later manual");
  assert.equal(f.controller.store.get(target)!.initialized, true);
  assert.equal((await f.controller.context(target) as any).status, "complete");
});

test("stale context and a manual event after reserve fence unsent edits", async t => {
  const f = await fixture(t);
  await f.send({ text: "Design a compiler" });
  const client = await f.client("session", "fixture-session");
  const stale = await client.request({ op: "topic_context" });
  await f.send({ forum_topic_edited: { name: "Manual" } });
  assert.equal((await client.request({ op: "topic_apply", revision: stale.revision, name: "Compiler", iconCandidates: [0] })).status, "stale");
  const context = await f.controller.context(target) as any;
  assert.equal((f.controller.apply(target, { revision: context.revision, iconCandidates: [0] }, () => true) as any).status, "accepted");
  // This event arrives before the scheduled network task begins.
  f.controller.observe(message({ forum_topic_edited: { icon_custom_emoji_id: "catalog-garden" } }));
  await f.controller.waitForIdle();
  assert.equal(f.api.filter(c => c.method === "editForumTopic").length, 0);
  const topic = f.controller.store.get(target)!;
  assert.equal(topic.pending, undefined);
  assert.equal(topic.name.value, "Manual");
  assert.equal(topic.icon.value, "catalog-garden");
  assert.equal(topic.icon.pinned, true);
});

test("manual event during an in-flight API call wins metadata and aborts subsequent retries; own echoes never pin", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler design" });
  const context = await f.controller.context(target) as any;
  let resolve!: (value: boolean) => void;
  f.setEdit(() => new Promise<boolean>(done => { resolve = done; }));
  f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true);
  await new Promise(done => setImmediate(done));
  assert.ok(resolve);
  await f.send({ from: { id: target.botId, is_bot: true, first_name: "Fixture" }, forum_topic_edited: { name: "Compiler", icon_custom_emoji_id: "catalog-code" } });
  assert.equal(f.controller.store.get(target)!.name.pinned, false);
  await f.send({ forum_topic_edited: { name: "Human wins" } });
  assert.equal(f.api.find(call => call.method === "editForumTopic")!.signal?.aborted, true);
  resolve(true);
  await f.controller.waitForIdle();
  assert.equal(f.controller.store.get(target)!.name.value, "Human wins");
  assert.equal(f.controller.store.get(target)!.name.pinned, true);
  assert.equal(f.controller.store.get(target)!.icon.value, "catalog-code");
  assert.equal(f.controller.store.get(target)!.pending, undefined);
});

test("concurrent topics reserve distinct ranked candidates durably before the API and restart preserves uncertain occupancy", async t => {
  const f = await fixture(t);
  const other = { ...target, topicId: 20 };
  await f.send({ text: "Compiler" });
  await f.send({ message_thread_id: 20, text: "Gardening" });
  const [first, second] = await Promise.all([f.controller.context(target), f.controller.context(other)]) as any[];
  f.setEdit(async () => { throw new Error("uncertain network outcome"); });
  const result1 = f.controller.apply(target, { revision: first.revision, name: "Compiler", iconCandidates: [0] }, () => true) as any;
  const result2 = f.controller.apply(other, { revision: second.revision, name: "Compiler", iconCandidates: [0, 1] }, () => true) as any;
  assert.equal(result1.status, "accepted");
  assert.equal(result2.status, "accepted");
  assert.equal(f.api.filter(c => c.method === "editForumTopic").length, 0);
  const reserved = new TopicStore(f.controller.store.path);
  assert.equal(reserved.get(target)!.pending!.icon, "catalog-code");
  assert.equal(reserved.get(other)!.pending!.icon, "catalog-garden");
  assert.equal(reserved.get(other)!.pending!.name, "Compiler", "pending topics may share a semantic title");
  await f.controller.waitForIdle();
  const { PrivateTopicController } = await import("../private-topics.js");
  const restarted = new PrivateTopicController(f.config, new TopicStore(f.controller.store.path), f.bot.api, () => target.botId);
  assert.equal((await restarted.context(target) as any).outcome, "uncertain");
  const third = { ...target, topicId: 30 };
  restarted.observe(message({ message_thread_id: 30, text: "Music" }));
  const ctx3 = await restarted.context(third) as any;
  assert.deepEqual(ctx3.candidates, [{ index: 2, emoji: "🎵" }]);
  assert.equal(f.controller.store.get(target)!.availability, "observed", "API failure is never deletion evidence");
  assert.equal(f.api.filter(c => c.method === "editForumTopic").length, 2, "restart/context never replays pending effects");
});

test("snapshot import reserves unavailable and deleted-unconfirmed topics without edits; no fallback on exhaustion", async t => {
  const f = await fixture(t);
  f.controller.store.importSnapshot(icons.map((icon, i) => ({ ...target, topicId: 20 + i,
    name: { value: `Existing ${i}`, provenance: "unknown", pinned: false },
    icon: { value: icon.custom_emoji_id, provenance: "manual", pinned: true },
    availability: i === 0 ? "unavailable" : "deleted-unconfirmed", initialized: true,
  })));
  assert.equal(f.api.length, 0);
  assert.throws(() => f.controller.store.importSnapshot([{ ...target, topicId: 20,
    name: { provenance: "unknown", pinned: false }, icon: { provenance: "unknown", pinned: false }, availability: "observed" }]), /already known/);
  await f.send({ text: "Compiler design" });
  assert.equal((await f.controller.context(target) as any).status, "catalog_exhausted");
  assert.equal(f.api.filter(c => c.method === "editForumTopic").length, 0);
  assert.equal(f.controller.store.get(target)!.initialized, false);
});

test("automatic names may repeat and remain bounded in graphemes including spaces/punctuation", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler design" });
  const context = await f.controller.context(target) as any;
  for (const name of ["", " ", "💻", "Compiler\nwork", "x".repeat(18)]) {
    assert.equal((f.controller.apply(target, { revision: context.revision, name, iconCandidates: [0] }, () => true) as any).status, "invalid_name");
  }
  const name = "Cafe\u0301 " + "👨‍👩‍👧‍👦".repeat(12); // 17 graphemes; normalization and ZWJ sequences count once.
  assert.equal((f.controller.apply(target, { revision: context.revision, name, iconCandidates: [0] }, () => true) as any).status, "accepted");
  await f.controller.waitForIdle();
  assert.equal(f.controller.store.get(target)!.name.value, name.normalize("NFC"));
  const other = { ...target, topicId: 20 };
  await f.send({ message_thread_id: 20, text: "Other subject" });
  const second = await f.controller.context(other) as any;
  for (const candidates of [[-1], [100], [0.5], []]) {
    const status = (f.controller.apply(other, { revision: second.revision, name: "Other", iconCandidates: candidates }, () => true) as any).status;
    assert.ok(status === "invalid_candidates" || status === "no_suitable_free_icon");
  }
  assert.equal((f.controller.apply(other, { revision: second.revision, name: "Other", iconCandidates: [0] }, () => true) as any).status, "no_suitable_free_icon");
  assert.equal((f.controller.apply(other, { revision: second.revision, name, iconCandidates: [1] }, () => true) as any).status, "accepted");
  await f.controller.waitForIdle();
  assert.equal(f.controller.store.get(other)!.name.value, f.controller.store.get(target)!.name.value);
});

test("non-opted, unauthorized chat, groups and non-topic messages remain unchanged", async t => {
  for (const kind of ["disabled", "unauthorized", "group-binding", "group-chat", "supergroup-chat", "no-topic"] as const) {
    await t.test(kind, async t => {
      const f = await fixture(t, config => {
        if (kind === "disabled") delete config.privateTopics;
        if (kind === "unauthorized") config.bindings = [];
        if (kind === "group-binding") config.bindings[0].kind = "group";
      });
      await f.send({ text: "Compiler", ...((kind === "group-chat" || kind === "supergroup-chat") ? { chat: { id: 100, type: kind === "group-chat" ? "group" : "supergroup", title: "Fixture" } } : {}), ...(kind === "no-topic" ? { message_thread_id: undefined } : {}) });
      assert.equal(f.controller?.store.list().length ?? 0, 0);
      assert.equal(f.api.length, 0, "no cosmetic API calls");
      assert.equal(existsSync(join(f.root, "topics.json")), false);
      if (!["group-chat", "supergroup-chat", "unauthorized"].includes(kind)) assert.equal(f.inputs.length, 1);
      const client = await f.client("session", "fixture-session");
      assert.equal((await client.request({ op: "topic_context" })).status, "unavailable");
      assert.equal((await client.request({ op: "topic_apply", revision: "invented", name: "Compiler", iconCandidates: [0] })).status, "unavailable");
    });
  }
});

test("IPC accepts only the current routed source and ignores caller-selected targets", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  await f.send({ message_thread_id: 20, text: "Gardening" });
  for (const [kind, id, expected] of [["terminal", "fixture-terminal", "rejected"], ["session", "old-session", "unavailable"], ["session", "discord-session", "unavailable"], ["session", "consultation-session", "unavailable"]] as const) {
    if (id === "discord-session") f.bind("discord:fixture", id);
    if (id === "consultation-session") f.bind("collaboration:fixture:main", id);
    const client = await f.client(kind, id);
    assert.equal((await client.request({ op: "topic_context" })).status, expected);
    assert.equal((await client.request({ op: "topic_apply", revision: "invented" })).status, expected);
  }
  const current = await f.client("session", "fixture-session");
  const context = await current.request({ op: "topic_context", chatId: 200, topicId: 20 });
  assert.equal(context.status, "needs_presentation");
  assert.equal((await current.request({ op: "topic_apply", revision: context.revision, name: "Compiler", iconCandidates: [0], chatId: 200, topicId: 20 })).status, "accepted");
  await f.controller.waitForIdle();
  assert.equal(f.api.find(c => c.method === "editForumTopic")!.payload.message_thread_id, 10);
  assert.equal(f.controller.store.get({ ...target, topicId: 20 })!.initialized, false);
  f.config.agents.other = { ...f.config.agents.main, id: "other" };
  f.config.bindings[0].agentId = "other";
  assert.equal((await current.request({ op: "topic_context" })).status, "unavailable", "changed agent binding rejects the former session");
  f.config.bindings[0].agentId = "main";
  f.bot.botInfo = { ...f.bot.botInfo, id: 901 };
  assert.equal((await current.request({ op: "topic_context" })).status, "unavailable", "current numeric bot identity is checked server-side");
});

test("/clean and current-session rebinding join the persistent topic instead of duplicating session state", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const old = await f.client("session", "fixture-session");
  assert.equal((await old.request({ op: "topic_context" })).status, "needs_presentation");
  const before = f.controller.store.get(target)!;
  await f.manager.destroySession("100:10");
  assert.equal((await old.request({ op: "topic_context" })).status, "unavailable");
  f.bind("100:10", "replacement-session");
  assert.equal((await old.request({ op: "topic_apply", revision: "old" })).status, "unavailable");
  const replacement = await f.client("session", "replacement-session");
  assert.equal((await replacement.request({ op: "topic_context" })).status, "needs_presentation");
  assert.deepEqual(f.manager.resolveTopicSource({ kind: "session", id: "replacement-session" }), { ...target, agentId: "main", sessionId: "replacement-session" });
  assert.deepEqual(f.controller.store.get(target), before, "inventory has no session fields and survives clean");
  assert.equal(Object.keys(before).some(key => /session|agent/i.test(key)), false);
});

test("a routing change between durable reserve and API dispatch cancels the unsent request", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const source = { kind: "session" as const, id: "fixture-session" };
  const context = await f.manager.topicContext(source) as any;
  assert.equal((f.manager.topicApply(source, { revision: context.revision, name: "Compiler", iconCandidates: [0] }) as any).status, "accepted");
  f.bind("100:10", "replacement-session");
  await f.controller.waitForIdle();
  assert.equal(f.api.filter(call => call.method === "editForumTopic").length, 0);
  assert.equal(f.controller.store.get(target)!.pending, undefined);
});

test("extension skips custom/internal turns, omits tools without the eligible flag, and server rejects disabled extensions", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const pi = await extension(t, f.config.collaboration!.socketPath);
  for (const event of [{ messageType: "custom", message: { customType: "minime-collaboration" } }, { messageType: "custom", message: { customType: "other" } }, { messageType: "user", prompt: "[Internal collaboration fixture]" }]) {
    assert.equal(await pi.emit("before_agent_start", event), undefined);
  }
  assert.equal(f.api.length, 0, "internal turns never request a catalog");
  assert.ok(await pi.context("Design a compiler"));
  const previous = process.env.PI_EXTENSIONS_DISABLED;
  process.env.PI_EXTENSIONS_DISABLED = "1";
  try {
    assert.deepEqual(await f.manager.topicContext({ kind: "session", id: "fixture-session" }), { status: "unavailable" });
    assert.deepEqual(f.manager.topicApply({ kind: "session", id: "fixture-session" }, { revision: "old" }), { status: "unavailable" });
  } finally { if (previous === undefined) delete process.env.PI_EXTENSIONS_DISABLED; else process.env.PI_EXTENSIONS_DISABLED = previous; }
  const terminal = await extension(t, f.config.collaboration!.socketPath, "", false);
  assert.equal(terminal.tools.has("topic_apply"), false);
});

test("catalog, API, persistence and optional IPC failures never prevent ordinary input; pending is not completion", async t => {
  await t.test("catalog unavailable", async t => {
    const f = await fixture(t);
    f.setCatalog(async () => { throw new Error("cosmetic catalog unavailable"); });
    const pi = await extension(t, f.config.collaboration!.socketPath);
    await f.send({ text: "Compiler" });
    assert.equal((await pi.context("Compiler")).catalogAvailable, false);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.controller.store.get(target)!.initialized, false);
    await f.send({ text: "Continue" });
    assert.equal(f.inputs.length, 2);
  });
  await t.test("storage failure on an observed manual event disables automatic edits", async t => {
    const f = await fixture(t);
    await f.send({ text: "Compiler" });
    const context = await f.controller.context(target) as any;
    t.mock.method(f.controller.store, "put", () => { throw new Error("cosmetic store unavailable"); });
    await f.send({ forum_topic_edited: { name: "Human choice" } });
    assert.deepEqual(f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true), { status: "unavailable" });
    await f.send({ text: "Continue" });
    assert.equal(f.inputs.length, 2);
    assert.equal(f.api.filter(call => call.method === "editForumTopic").length, 0);
  });
  await t.test("reservation failure precedes API", async t => {
    const f = await fixture(t);
    await f.send({ text: "Compiler" });
    const client = await f.client("session", "fixture-session");
    const context = await client.request({ op: "topic_context" });
    t.mock.method(f.controller.store, "put", () => { throw new Error("cosmetic store unavailable"); });
    assert.equal((await client.request({ op: "topic_apply", revision: context.revision, name: "Compiler", iconCandidates: [0] })).status, "unavailable");
    await f.send({ text: "Continue" });
    assert.equal(f.inputs.length, 2);
    assert.equal(f.api.filter(call => call.method === "editForumTopic").length, 0);
  });
  await t.test("Telegram failure keeps the pending request occupied", async t => {
    const f = await fixture(t);
    await f.send({ text: "Compiler" });
    const client = await f.client("session", "fixture-session");
    const context = await client.request({ op: "topic_context" });
    f.setEdit(async () => { throw new Error("cosmetic edit unavailable"); });
    assert.equal((await client.request({ op: "topic_apply", revision: context.revision, name: "Compiler", iconCandidates: [0] })).status, "accepted");
    await f.controller.waitForIdle();
    assert.equal((await client.request({ op: "topic_context" })).status, "pending");
    assert.equal(f.controller.store.get(target)!.initialized, false);
    await f.send({ text: "Continue" });
    assert.equal(f.inputs.length, 2);
  });
});

test("successful not-modified completes the reserved target; identical existing presentation suppresses an API call", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const context = await f.controller.context(target) as any;
  f.setEdit(async () => { throw { error_code: 400, description: "Bad Request: TOPIC_NOT_MODIFIED" }; });
  f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true);
  await f.controller.waitForIdle();
  assert.equal(f.controller.store.get(target)!.initialized, true);
  assert.equal(f.controller.store.get(target)!.pending, undefined);
  const second = { ...target, topicId: 20 };
  await f.send({ message_thread_id: 20, forum_topic_created: { name: "Gardening", is_name_implicit: true, icon_color: 0, icon_custom_emoji_id: "catalog-garden" } });
  const ctx2 = await f.controller.context(second) as any;
  const count = f.api.filter(call => call.method === "editForumTopic").length;
  assert.deepEqual(f.controller.apply(second, { revision: ctx2.revision, name: "Gardening", iconCandidates: [1] }, () => true), { status: "complete" });
  assert.equal(f.api.filter(call => call.method === "editForumTopic").length, count);
  assert.equal(f.controller.store.get(second)!.name.provenance, "policy-initialized");
});

test("candidate indices from an earlier catalog cannot select a different icon after controller restart", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const first = await f.controller.context(target) as any;
  const { PrivateTopicController } = await import("../private-topics.js");
  const restarted = new PrivateTopicController(f.config, new TopicStore(f.controller.store.path), {
    getForumTopicIconStickers: async () => [...icons].reverse(), editForumTopic: async () => { throw new Error("must not edit"); },
  }, () => target.botId);
  const current = await restarted.context(target) as any;
  assert.notEqual(first.revision, current.revision);
  assert.deepEqual(restarted.apply(target, { revision: first.revision, name: "Compiler", iconCandidates: [0] }, () => true), { status: "stale" });
});

test("optional context timeout skips the cosmetic hook while ordinary input continues", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const pi = await extension(t, f.config.collaboration!.socketPath);
  let release!: (value: unknown) => void;
  t.mock.method(f.manager, "topicContext", () => new Promise(resolve => { release = resolve; }));
  const started = Date.now();
  assert.equal(await pi.context("Compiler"), undefined);
  assert.ok(Date.now() - started < 2000, "optional context is bounded to about one second");
  release({ status: "needs_presentation", instruction: "late context must be discarded" });
  await f.send({ text: "Continue" });
  assert.equal(f.inputs.length, 2);
  assert.equal(f.api.length, 0);
});

test("optional client timeout includes connection and never dispatches the request late", async t => {
  const client = new CollaborationClient("/unused/fixture.sock", { kind: "session", id: "fixture" }, "fixture", () => {});
  let release!: (value: boolean) => void;
  t.mock.method(client, "connect", () => new Promise<boolean>(resolve => { release = resolve; }));
  let exchanged = false;
  t.mock.method(client as any, "exchange", async () => { exchanged = true; return { status: "accepted" }; });
  assert.equal((await client.request({ op: "topic_context" }, 20)).status, "unavailable");
  release(true);
  await new Promise(done => setImmediate(done));
  assert.equal(exchanged, false);
  client.close();
});

test("known records for other bots/chats do not occupy this chat's catalog", async t => {
  const f = await fixture(t);
  f.controller.store.importSnapshot([{ ...target, botId: 901 }, { ...target, chatId: 200 }].map(scope => ({ ...scope,
    name: { value: "Compiler", provenance: "manual", pinned: true },
    icon: { value: "catalog-code", provenance: "manual", pinned: true }, availability: "observed", initialized: true,
  })));
  await f.send({ text: "Compiler" });
  const client = await f.client("session", "fixture-session");
  const context = await client.request({ op: "topic_context" });
  assert.deepEqual(context.candidates, icons.map((icon, index) => ({ index, emoji: icon.emoji })));
  assert.equal((await client.request({ op: "topic_apply", revision: context.revision, name: "Compiler", iconCandidates: [0] })).status, "accepted");
  await f.controller.waitForIdle();
  assert.equal(f.controller.store.get(target)!.icon.value, "catalog-code");
});

test("context waiting on a catalog cannot leak across a current-session move to another chat", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  let release!: (value: typeof icons) => void;
  f.setCatalog(() => new Promise(resolve => { release = resolve; }));
  const request = f.manager.topicContext({ kind: "session", id: "fixture-session" });
  assert.ok(release);
  f.sessions.deleteSession("100:10");
  f.config.bindings.push({ chatId: 200, kind: "dm", agentId: "main" });
  f.bind("200:20", "fixture-session");
  release(icons);
  assert.deepEqual(await request, { status: "unavailable" });
});

test("invalid inventory at bot construction disables only cosmetic presentation", async t => {
  const f = await fixture(t);
  const path = join(f.root, "invalid-topics.json");
  writeFileSync(path, "invalid fixture inventory");
  const result = createTelegramBot(f.config, f.manager, { topicStorePath: path });
  t.after(() => result.messageQueue.clearAll());
  result.bot.botInfo = f.bot.botInfo;
  let received = 0;
  t.mock.method(result.messageQueue, "enqueue", () => { received++; });
  assert.equal(result.topicController, undefined);
  await result.bot.handleUpdate({ update_id: 1, message: message({ text: "Compiler" }) } as any);
  assert.equal(received, 1);
});

test("another topic's manual icon choice fences a duplicate icon; a repeated name remains valid", async t => {
  for (const field of ["name", "icon"] as const) {
    await t.test(field, async t => {
      const f = await fixture(t);
      await f.send({ text: "Compiler" });
      const context = await f.controller.context(target) as any;
      f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true);
      f.controller.observe(message({ message_thread_id: 20, forum_topic_edited: field === "name" ? { name: "Compiler" } : { icon_custom_emoji_id: "catalog-code" } }));
      await f.controller.waitForIdle();
      assert.equal(f.api.filter(call => call.method === "editForumTopic").length, field === "icon" ? 0 : 1);
      assert.equal(f.controller.store.get(target)!.pending, undefined);
      assert.equal(f.controller.store.get(target)!.initialized, field === "name");
    });
  }
});

test("an observed conflicting icon on another topic aborts in-flight retries and retains the uncertain reservation", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const context = await f.controller.context(target) as any;
  let reject!: (error: Error) => void;
  f.setEdit(() => new Promise((_resolve, fail) => { reject = fail; }));
  f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true);
  await new Promise(done => setImmediate(done));
  await f.send({ message_thread_id: 20, forum_topic_edited: { icon_custom_emoji_id: "catalog-code" } });
  assert.equal(f.api.find(call => call.method === "editForumTopic")!.signal?.aborted, true);
  reject(new Error("aborted before retry"));
  await f.controller.waitForIdle();
  assert.equal(f.controller.store.get(target)!.pending!.state, "uncertain");
  assert.equal(f.controller.store.get({ ...target, topicId: 20 })!.icon.pinned, true);
});

test("message evidence persists the private peer separately from actual human/bot authors and does not invent a missing author", async t => {
  const f = await fixture(t);
  await f.send({ message_id: 41, date: 1700000000, text: "Compiler" });
  let topic = new TopicStore(f.controller.store.path).get(target)!;
  assert.equal(topic.peerId, 100);
  assert.deepEqual(topic.lastActor, { actorId: 101, isBot: false });
  assert.equal(topic.lastObservedAt, 1700000000000);
  assert.equal(topic.lastMessageId, 41);
  assert.equal(topic.lastUpdateId, 1);
  assert.equal(topic.lastObservationSource, "message");
  assert.equal(topic.name.observedAt, undefined, "ordinary content does not observe a topic name");
  await f.send({ message_id: 42, date: 1700000001, from: { id: 900, is_bot: true, first_name: "Fixture" },
    forum_topic_created: { name: "Implicit", is_name_implicit: true, icon_color: 0 } });
  topic = new TopicStore(f.controller.store.path).get(target)!;
  assert.equal(topic.peerId, 100);
  assert.deepEqual(topic.lastActor, { actorId: 900, isBot: true });
  assert.equal(topic.lastObservationSource, "topic-created");
  assert.equal(topic.name.observedAt, 1700000001000);
  assert.equal(topic.name.appliedAt, undefined);
  assert.equal(topic.name.pinned, false);
  await f.send({ message_id: 43, date: 1700000002, forum_topic_edited: { icon_custom_emoji_id: "" } });
  topic = f.controller.store.get(target)!;
  assert.equal(topic.lastObservationSource, "topic-edited");
  assert.equal(topic.icon.observedAt, 1700000002000);
  assert.equal(topic.name.observedAt, 1700000001000, "absent field keeps its own observation timestamp");
  await f.send({ message_id: 44, date: 1700000003, from: undefined, text: "Continue" });
  topic = new TopicStore(f.controller.store.path).get(target)!;
  assert.equal(topic.lastActor, undefined);
  assert.equal(topic.peerId, 100, "a missing sender never becomes the peer or previous sender");
  assert.equal(topic.lastObservedAt, 1700000003000);
});

test("successful true/not-modified receipts record application time/source without inventing an observation or a no-op receipt", async t => {
  for (const source of ["telegram-true", "telegram-not-modified", "no-op"] as const) {
    await t.test(source, async t => {
      const f = await fixture(t);
      await f.send({ date: 1700000000, ...(source === "no-op"
        ? { forum_topic_created: { name: "Compiler", is_name_implicit: true, icon_color: 0, icon_custom_emoji_id: "catalog-code" } }
        : { text: "Compiler" }) });
      const context = await f.controller.context(target) as any;
      if (source === "telegram-not-modified") f.setEdit(async () => { throw { error_code: 400, description: "TOPIC_NOT_MODIFIED" }; });
      const started = Date.now();
      f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true);
      await f.controller.waitForIdle();
      const topic = new TopicStore(f.controller.store.path).get(target)!;
      assert.equal(topic.lastObservedAt, 1700000000000, "own receipt is distinct from Message observation time");
      if (source === "no-op") {
        assert.equal(topic.lastReceipt, undefined);
        assert.equal(topic.name.appliedAt, undefined);
        assert.equal(topic.icon.appliedAt, undefined);
        assert.equal(topic.name.observedAt, 1700000000000);
      } else {
        assert.equal(topic.lastReceipt!.source, source);
        assert.ok(topic.lastReceipt!.confirmedAt >= started && topic.lastReceipt!.confirmedAt <= Date.now());
        assert.equal(topic.name.appliedAt, topic.lastReceipt!.confirmedAt);
        assert.equal(topic.icon.appliedAt, topic.lastReceipt!.confirmedAt);
        assert.equal(topic.name.observedAt, undefined, "receipt does not invent a service-message observation");
      }
    });
  }
});

test("bootstrap leaves optional actor, observation and receipt evidence unknown", async t => {
  const f = await fixture(t);
  f.controller.store.importSnapshot([{ ...target, name: { value: "Compiler", provenance: "unknown", pinned: false },
    icon: { value: "catalog-code", provenance: "unknown", pinned: false }, availability: "observed", initialized: true }]);
  const topic = new TopicStore(f.controller.store.path).get(target)!;
  for (const field of ["peerId", "lastActor", "lastObservedAt", "lastMessageId", "lastUpdateId", "lastObservationSource", "lastReceipt"] as const) assert.equal(topic[field], undefined);
  assert.equal(topic.name.observedAt, undefined);
  assert.equal(topic.icon.appliedAt, undefined);
});

test("known-topic inspection joins current route/session/file across clean, rotation and agent rebind without copying session data", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const inventory = f.controller.store.get(target)!;
  let view = f.manager.inspectKnownTopics(900, 100);
  assert.equal(view.length, 1);
  assert.equal(view[0].agentId, "main");
  assert.deepEqual(view[0].session, { sessionId: "fixture-session", sessionFile: join(f.root, "fixture-session.jsonl") });
  view[0].topic.name.value = "Mutated copy";
  assert.deepEqual(f.controller.store.get(target), inventory);
  await f.manager.destroySession("100:10");
  view = f.manager.inspectKnownTopics(900, 100);
  assert.equal(view[0].agentId, "main");
  assert.equal(view[0].session, undefined);
  f.bind("100:10", "rotated-session");
  assert.deepEqual(f.manager.inspectKnownTopics(900, 100)[0].session, { sessionId: "rotated-session", sessionFile: join(f.root, "rotated-session.jsonl") });
  f.config.agents.other = { ...f.config.agents.main, id: "other" };
  f.config.bindings[0].agentId = "other";
  view = f.manager.inspectKnownTopics(900, 100);
  assert.equal(view[0].agentId, "other", "current configured agent wins over stored old agent");
  assert.equal(view[0].session, undefined, "old agent session/file is not attributed to its replacement");
  f.bind("100:10", "rebound-session", "other");
  assert.deepEqual(f.manager.inspectKnownTopics(900, 100)[0].session, { sessionId: "rebound-session", sessionFile: join(f.root, "rebound-session.jsonl") });
  assert.deepEqual(f.controller.store.get(target), inventory);
  assert.deepEqual(f.manager.inspectKnownTopics(901, 100), []);
  assert.deepEqual(f.manager.inspectKnownTopics(900, 200), []);
  f.config.bindings = [];
  view = f.manager.inspectKnownTopics(900, 100);
  assert.equal(view.length, 1, "scoped known inventory still includes a topic whose binding was removed");
  assert.equal(view[0].agentId, undefined);
  assert.equal(view[0].session, undefined);
  f.bot.botInfo = { ...f.bot.botInfo, id: 901 };
  assert.deepEqual(f.manager.inspectKnownTopics(900, 100), []);
});

test("pinned manual icons retain conflicting observed/applied bot icons across receipt/event ordering and restart", async t => {
  for (const order of ["receipt-before-events", "manual-before-receipt", "echo-before-receipt", "conflicting-own-echoes"] as const) {
    await t.test(order, async t => {
      const f = await fixture(t);
      await f.send({ text: "Compiler" });
      const context = await f.controller.context(target) as any;
      let resolve!: (value: boolean) => void;
      f.setEdit(() => new Promise<boolean>(done => { resolve = done; }));
      f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true);
      await new Promise(done => setImmediate(done));
      const echo = (id: string) => f.send({ from: { id: target.botId, is_bot: true, first_name: "Fixture" },
        forum_topic_edited: { icon_custom_emoji_id: id } });
      if (order === "receipt-before-events" || order === "conflicting-own-echoes") {
        resolve(true);
        await f.controller.waitForIdle();
      }
      await f.send({ forum_topic_edited: { icon_custom_emoji_id: "catalog-garden" } });
      if (order === "echo-before-receipt") await echo("catalog-code");
      if (order === "manual-before-receipt" || order === "echo-before-receipt") {
        resolve(true);
        await f.controller.waitForIdle();
        assert.ok(new TopicStore(f.controller.store.path).get(target)!.occupiedIconIds?.includes("catalog-code"), "confirmed applied icon stays occupied when its manual field was superseded");
      }
      await echo("catalog-code");
      if (order === "conflicting-own-echoes") await echo("catalog-music");
      const stored = new TopicStore(f.controller.store.path).get(target)!;
      assert.equal(stored.icon.value, "catalog-garden");
      assert.equal(stored.icon.pinned, true);
      assert.equal(stored.icon.provenance, "manual");
      assert.ok(stored.occupiedIconIds?.includes("catalog-code"), "an own echo must reserve its icon without replacing the manual choice");
      const other = { ...target, topicId: 20 };
      await f.send({ message_thread_id: 20, text: "Music" });
      const { PrivateTopicController } = await import("../private-topics.js");
      const restarted = new PrivateTopicController(f.config, new TopicStore(f.controller.store.path), f.bot.api, () => target.botId);
      const occupied = await restarted.context(other) as any;
      if (order === "conflicting-own-echoes") {
        assert.ok(stored.occupiedIconIds?.includes("catalog-music"), "another conflicting own echo does not release the earlier observed icon");
        assert.equal(occupied.status, "catalog_exhausted");
      } else {
        assert.deepEqual(occupied.candidates, [{ index: 2, emoji: "🎵" }]);
        assert.deepEqual(restarted.apply(other, { revision: occupied.revision, name: "Music", iconCandidates: [0] }, () => true), { status: "no_suitable_free_icon" });
      }
      restarted.observe(message({ text: "Continue" }));
      restarted.observe(message({ forum_topic_edited: { name: "Manual title" } }));
      assert.ok(restarted.store.get(target)!.occupiedIconIds?.includes("catalog-code"), "ordinary input and absent icon fields do not prove release");
      // A subsequent explicit human icon observation proves the conflicting icons released.
      restarted.observe(message({ forum_topic_edited: { icon_custom_emoji_id: "catalog-garden" } }));
      assert.equal(restarted.store.get(target)!.occupiedIconIds, undefined);
      assert.deepEqual((await restarted.context(other) as any).candidates, [{ index: 0, emoji: "💻" }, { index: 2, emoji: "🎵" }]);
    });
  }
});


test("every authorized private topic across two bot instances works, including the topic-only instance", async t => {
  const instances = [];
  for (const botId of [900, 901]) {
    const f = await fixture(t, config => {
      if (botId === 901) delete config.collaboration;
      config.bindings.push({ chatId: 200, kind: "dm", agentId: "main" });
    }, botId);
    instances.push(f);
    assert.equal(f.transport.topicOnly, botId === 901);
    if (botId === 901) assert.ok(Buffer.byteLength(f.transport.socketPath) <= 100);
    for (const chatId of [100, 200]) {
      const session = `session-${botId}-${chatId}`;
      f.bind(`${chatId}:10`, session);
      await f.send({ chat: { id: chatId, type: "private", first_name: "Fixture" }, text: "Compiler" });
      const client = await f.client("session", session);
      const context = await client.request({ op: "topic_context" });
      assert.equal(context.status, "needs_presentation");
      assert.equal((await client.request({ op: "topic_apply", revision: context.revision, name: "Compiler", iconCandidates: [0] })).status, "accepted");
      await f.controller.waitForIdle();
      assert.equal(f.controller.store.get({ botId, chatId, topicId: 10 })!.icon.value, "catalog-code");
    }
    assert.equal(f.controller.store.list().length, 2);
    assert.ok(f.controller.store.list().every(topic => topic.botId === botId));
  }
  assert.notEqual(instances[0].controller.store.path, instances[1].controller.store.path);
  assert.notEqual(instances[0].transport.socketPath, instances[1].transport.socketPath);
});

test("topic-only IPC rejects general collaboration operations and stale sessions; extension exposes only topic_apply", async t => {
  const f = await fixture(t, config => { delete config.collaboration; });
  await f.send({ text: "Compiler" });
  const client = await f.client("session", "fixture-session");
  for (const op of ["discover", "send", "reply", "receipt", "delivery_status"]) {
    assert.equal((await client.request({ op, to: { kind: "agent", id: "main" }, text: "internal", id: "missing" })).status, "rejected");
  }
  const stale = await f.client("session", "stale-session");
  assert.equal((await stale.request({ op: "topic_context" })).status, "unavailable");
  assert.equal((await stale.request({ op: "topic_apply", intent: "manual", revision: "stale", name: "Wrong" })).status, "unavailable");
  const terminal = new CollaborationClient(f.transport.socketPath, { kind: "terminal", id: "terminal" }, "fixture", () => {});
  t.after(() => terminal.close());
  assert.equal(await terminal.connect(), false);
  client.close();
  await new Promise(done => setImmediate(done));
  const pi = await extension(t, f.transport.socketPath, "fixture-session", true, true);
  assert.deepEqual([...pi.tools.keys()], ["topic_apply"]);
  const context = await pi.context("Design a compiler");
  assert.equal(context.status, "needs_presentation");
  assert.equal(JSON.parse((await pi.tools.get("topic_apply").execute("call", { revision: context.revision, name: "Compiler", iconCandidates: [0] })).content[0].text).status, "accepted");
});

async function initialize(f: Awaited<ReturnType<typeof fixture>>) {
  await f.send({ text: "Design a compiler" });
  const context = await f.controller.context(target) as any;
  f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true);
  await f.controller.waitForIdle();
}

test("completed topics never auto-repeat; the same human turn can explicitly rename or change only its icon and pin choices", async t => {
  const f = await fixture(t);
  await initialize(f);
  const pi = await extension(t, f.transport.socketPath);
  const apply = async (p: any) => JSON.parse((await pi.tools.get("topic_apply").execute("call", p)).content[0].text);
  const ordinary = await pi.context("Now discuss gardens");
  assert.equal(ordinary.status, "complete");
  assert.equal(ordinary.name, "Compiler");
  assert.equal((await apply({ revision: ordinary.revision, name: "Gardening", iconCandidates: [1] })).status, "complete");
  const rename = await pi.context("Please rename this topic to Parsing");
  const oldIcon = f.controller.store.get(target)!.icon;
  const accepted = await apply({ intent: "manual", revision: rename.revision, name: "Parsing" });
  assert.equal(accepted.status, "accepted");
  assert.match(accepted.outcome, /has not completed/);
  await f.controller.waitForIdle();
  let topic = f.controller.store.get(target)!;
  assert.equal(topic.name.value, "Parsing");
  assert.equal(topic.name.pinned, true);
  assert.equal(topic.name.provenance, "manual");
  assert.deepEqual(topic.icon, oldIcon);
  assert.deepEqual(f.api.filter(call => call.method === "editForumTopic").at(-1)!.payload, { chat_id: 100, message_thread_id: 10, name: "Parsing" });
  const icon = await pi.context("Change this topic's icon to the plant");
  assert.equal(icon.receipt.requestId, accepted.requestId);
  assert.equal(icon.receipt.source, "telegram-true");
  await apply({ intent: "manual", revision: icon.revision, iconCandidates: [1] });
  await f.controller.waitForIdle();
  topic = f.controller.store.get(target)!;
  assert.equal(topic.name.value, "Parsing");
  assert.equal(topic.icon.value, "catalog-garden");
  assert.equal(topic.icon.pinned, true);
  assert.deepEqual(f.api.filter(call => call.method === "editForumTopic").at(-1)!.payload, { chat_id: 100, message_thread_id: 10, icon_custom_emoji_id: "catalog-garden" });
});

test("manual no-ops pin only requested fields, retain uncertain occupancy, and never invent receipts", async t => {
  const f = await fixture(t);
  await f.send({ from: undefined, forum_topic_created: { name: "Compiler", is_name_implicit: true, icon_color: 0, icon_custom_emoji_id: "catalog-code" } });
  const before = f.controller.store.get(target)!;
  before.occupiedIconIds = ["catalog-garden"];
  f.controller.store.put(before);
  let context = await f.controller.context(target) as any;
  assert.deepEqual(f.controller.apply(target, { intent: "manual", revision: context.revision, name: "Compiler" }, () => true), { status: "complete" });
  let topic = f.controller.store.get(target)!;
  assert.equal(topic.name.pinned, true);
  assert.deepEqual(topic.icon, before.icon);
  assert.equal(topic.initialized, false, "manual name choice leaves the remaining initial icon eligible");
  context = await f.controller.context(target) as any;
  assert.deepEqual(f.controller.apply(target, { intent: "manual", revision: context.revision, iconCandidates: [0] }, () => true), { status: "complete" });
  topic = f.controller.store.get(target)!;
  assert.equal(topic.icon.pinned, true);
  assert.deepEqual(topic.occupiedIconIds, ["catalog-garden"]);
  assert.equal(topic.lastReceipt, undefined);
  assert.equal(f.api.filter(call => call.method === "editForumTopic").length, 0);
});

test("manual edits recheck stale/session fences, reject empty requests and occupied icons, and respect the grapheme cap", async t => {
  const f = await fixture(t);
  await initialize(f);
  const context = await f.controller.context(target) as any;
  const apply = (extra: any, current = true) => (f.controller.apply(target, { intent: "manual", revision: context.revision, ...extra }, () => current) as any).status;
  assert.equal(apply({}), "no_requested_fields");
  assert.equal(apply({ name: "x".repeat(18) }), "invalid_name");
  assert.equal(apply({ name: "Parsing" }, false), "unavailable");
  await f.send({ message_thread_id: 20, forum_topic_edited: { icon_custom_emoji_id: "catalog-garden" } });
  assert.equal(apply({ iconCandidates: [1] }), "no_suitable_free_icon");
  await f.send({ forum_topic_edited: { name: "New human choice" } });
  assert.equal(apply({ name: "Parsing" }), "stale");
});

test("manual in-flight races retain the newer observed choices and conservative icon occupancy; own echoes cannot pin or supersede them", async t => {
  for (const outcome of ["success", "uncertain"] as const) await t.test(outcome, async t => {
    const f = await fixture(t);
    await initialize(f);
    const context = await f.controller.context(target) as any;
    let release!: (value: unknown) => void;
    f.setEdit(() => new Promise(resolve => { release = resolve; }));
    const accepted = f.controller.apply(target, { intent: "manual", revision: context.revision, name: "Parsing", iconCandidates: [1] }, () => true) as any;
    await new Promise(done => setImmediate(done));
    assert.equal((await f.controller.context(target) as any).status, "pending");
    assert.equal((f.controller.apply(target, { intent: "manual", revision: context.revision, name: "Another" }, () => true) as any).status, "pending");
    await f.send({ forum_topic_edited: { name: "Human wins", icon_custom_emoji_id: "catalog-music" } });
    assert.equal(f.api.filter(call => call.method === "editForumTopic").at(-1)!.signal!.aborted, true);
    release(outcome === "success");
    await f.controller.waitForIdle();
    await f.send({ from: { id: target.botId, is_bot: true, first_name: "Fixture" }, forum_topic_edited: { name: "Parsing", icon_custom_emoji_id: "catalog-garden" } });
    const topic = new TopicStore(f.controller.store.path).get(target)!;
    assert.equal(topic.name.value, "Human wins");
    assert.equal(topic.icon.value, "catalog-music");
    assert.equal(topic.name.pinned && topic.icon.pinned, true);
    assert.ok(topic.occupiedIconIds?.includes("catalog-garden"));
    if (outcome === "success") assert.equal(topic.lastReceipt!.requestId, accepted.requestId);
    else assert.equal(topic.pending!.state, "uncertain");
  });
});

test("own echo during a manual edit keeps the request current and confirmation pins the requested value", async t => {
  const f = await fixture(t);
  await initialize(f);
  await f.send({ forum_topic_edited: { name: "Old human choice" } });
  const context = await f.controller.context(target) as any;
  let release!: (value: unknown) => void;
  f.setEdit(() => new Promise(resolve => { release = resolve; }));
  f.controller.apply(target, { intent: "manual", revision: context.revision, name: "Parsing" }, () => true);
  await new Promise(done => setImmediate(done));
  await f.send({ from: { id: target.botId, is_bot: true, first_name: "Fixture" }, forum_topic_edited: { name: "Parsing" } });
  assert.equal(f.controller.store.get(target)!.name.value, "Old human choice");
  release(true);
  await f.controller.waitForIdle();
  assert.equal(f.controller.store.get(target)!.name.value, "Parsing");
  assert.equal(f.controller.store.get(target)!.name.pinned, true);
});

test("internal turns cannot use retained manual tools, and catalog failure still allows a completed topic's name-only request", async t => {
  const f = await fixture(t);
  await initialize(f);
  const pi = await extension(t, f.transport.socketPath);
  const context = await pi.context("Please rename this topic");
  const active = (f.manager as any).active;
  active.set("100:10", { internalTurn: true });
  assert.deepEqual(await f.manager.topicContext({ kind: "session", id: "fixture-session" }), { status: "unavailable" });
  assert.deepEqual(f.manager.topicApply({ kind: "session", id: "fixture-session" }, { intent: "manual", revision: context.revision, name: "Wrong" }), { status: "unavailable" });
  active.delete("100:10");
  for (const event of [{ messageType: "custom", message: { customType: "cron" } }, { messageType: "user", prompt: "[Internal collaboration fixture] rename topic" }]) {
    await pi.emit("before_agent_start", event);
    const result = await pi.tools.get("topic_apply").execute("internal", { intent: "manual", revision: context.revision, name: "Wrong" });
    assert.equal(JSON.parse(result.content[0].text).status, "unavailable");
  }
  await pi.context("Please rename this topic");
  await pi.emit("agent_settled");
  assert.equal(JSON.parse((await pi.tools.get("topic_apply").execute("late", { intent: "manual", revision: context.revision, name: "Wrong" })).content[0].text).status, "unavailable");
  const { PrivateTopicController } = await import("../private-topics.js");
  const restarted = new PrivateTopicController(f.config, new TopicStore(f.controller.store.path), {
    getForumTopicIconStickers: async () => { throw new Error("offline catalog"); }, editForumTopic: async () => true,
  }, () => target.botId);
  const offline = await restarted.context(target) as any;
  assert.equal(offline.status, "complete");
  assert.equal(offline.catalogAvailable, false);
  assert.equal((restarted.apply(target, { intent: "manual", revision: offline.revision, name: "Parsing" }, () => true) as any).status, "accepted");
  await restarted.waitForIdle();
  assert.equal(restarted.store.get(target)!.name.pinned, true);
});


test("manual reservations are fenced before dispatch by a new observation or current-session replacement", async t => {
  for (const change of ["observation", "session"] as const) await t.test(change, async t => {
    const f = await fixture(t);
    await initialize(f);
    const source = { kind: "session" as const, id: "fixture-session" };
    const context = await f.manager.topicContext(source) as any;
    const edits = f.api.filter(call => call.method === "editForumTopic").length;
    assert.equal((f.manager.topicApply(source, { intent: "manual", revision: context.revision, name: "Parsing" }) as any).status, "accepted");
    if (change === "session") f.bind("100:10", "replacement-session");
    else f.controller.observe(message({ forum_topic_edited: { name: "Human wins" } }));
    await f.controller.waitForIdle();
    assert.equal(f.api.filter(call => call.method === "editForumTopic").length, edits);
    assert.equal(f.controller.store.get(target)!.pending, undefined);
    assert.equal(f.controller.store.get(target)!.name.value, change === "observation" ? "Human wins" : "Compiler");
  });
});

test("review3: topic-only sockets stay bounded and stable across long instance roots", async t => {
  const f = await fixture(t, config => { delete config.collaboration; });
  const previous = process.env.MINIME_CONTROL_WORKSPACE_ROOT;
  const previousTmp = process.env.TMPDIR;
  try {
    const paths = [];
    for (const root of ["/tmp/" + "a".repeat(110), "/tmp/" + "b".repeat(110)]) {
      process.env.MINIME_CONTROL_WORKSPACE_ROOT = root;
      const transport = collaborationTransport(f.config)!;
      assert.ok(Buffer.byteLength(transport.socketPath) <= 100);
      assert.deepEqual(collaborationTransport(f.config), transport);
      paths.push(transport.socketPath);
    }
    assert.notEqual(paths[0], paths[1]);
    process.env.TMPDIR = "/tmp/" + "t".repeat(110);
    const fallback = collaborationTransport(f.config)!;
    assert.ok(fallback.socketPath.startsWith("/tmp/minime-topics-"));
    assert.ok(Buffer.byteLength(fallback.socketPath) <= 100);
  } finally {
    process.env.MINIME_CONTROL_WORKSPACE_ROOT = previous;
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
  }
});

test("review3: topic-only startup failure is cosmetic; full collaboration still rejects", async t => {
  const f = await fixture(t);
  const blocked = join(f.root, "blocked");
  writeFileSync(blocked, "fixture");
  const owner = { discover: () => [], deliver: async () => {} };
  const cosmetic = new CollaborationRouter(owner, { topicOnly: true });
  t.after(() => cosmetic.stop());
  assert.equal(await cosmetic.start(join(blocked, "router.sock")), false);
  const full = new CollaborationRouter(owner);
  t.after(() => full.stop());
  await assert.rejects(full.start(join(blocked, "router.sock")));
});

test("review3: fresh manual requests supersede inactive reservations while preserving all uncertain icons", async t => {
  for (const state of ["uncertain", "accepted"] as const) await t.test(state, async t => {
    const f = await fixture(t);
    await f.send({ text: "Compiler" });
    const topic = f.controller.store.get(target)!;
    topic.pending = { id: "old-request", revision: topic.revision, name: "Old name", icon: "catalog-code", state };
    topic.occupiedIconIds = ["catalog-music"];
    f.controller.store.put(topic);
    const { PrivateTopicController } = await import("../private-topics.js");
    const restarted = new PrivateTopicController(f.config, new TopicStore(f.controller.store.path), f.bot.api, () => target.botId);
    const context = await restarted.context(target) as any;
    assert.equal((restarted.apply(target, { revision: context.revision, name: "Old name", iconCandidates: [0] }, () => true) as any).status, "pending");
    assert.equal((restarted.apply(target, { intent: "manual", revision: context.revision, name: "x".repeat(18) }, () => true) as any).status, "invalid_name");
    assert.equal(restarted.store.get(target)!.pending!.id, "old-request");
    const accepted = restarted.apply(target, { intent: "manual", revision: context.revision, name: "Parsing", iconCandidates: [1] }, () => true) as any;
    assert.equal(accepted.status, "accepted");
    await restarted.waitForIdle();
    const stored = new TopicStore(f.controller.store.path).get(target)!;
    assert.equal(stored.name.value, "Parsing");
    assert.equal(stored.icon.value, "catalog-garden");
    assert.deepEqual(new Set(stored.occupiedIconIds), new Set(["catalog-code", "catalog-music"]));
    assert.equal(stored.pending, undefined);
    assert.equal(stored.lastReceipt!.requestId, accepted.requestId);
    assert.equal(f.api.filter(call => call.method === "editForumTopic").length, 1, "only the new explicit request is sent");
    restarted.observe(message({ message_thread_id: 20, text: "Another topic" }));
    assert.deepEqual((await restarted.context({ ...target, topicId: 20 }) as any).candidates, []);
  });
});

test("review3: accepted work cannot be superseded before dispatch or while its abort settles", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const context = await f.controller.context(target) as any;
  let release!: (value: unknown) => void;
  f.setEdit(() => new Promise(resolve => { release = resolve; }));
  const accepted = f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true) as any;
  const request = { intent: "manual" as const, revision: context.revision, name: "Parsing" };
  assert.equal((f.controller.apply(target, request, () => true) as any).status, "pending");
  await new Promise(done => setImmediate(done));
  await f.send({ forum_topic_edited: { name: "Human pin" } });
  const fresh = await f.controller.context(target) as any;
  assert.equal((f.controller.apply(target, { ...request, revision: fresh.revision }, () => true) as any).status, "pending");
  assert.equal(f.controller.store.get(target)!.pending!.id, accepted.requestId);
  release(false);
  await f.controller.waitForIdle();
});

test("review3: a steered explicit request refreshes stale context through the retained tool", async t => {
  const f = await fixture(t);
  await f.send({ text: "Compiler" });
  const pi = await extension(t, f.transport.socketPath);
  const context = await pi.context("Design a compiler");
  f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true);
  await f.controller.waitForIdle();
  // Human steering stays within this turn: no second before_agent_start hook.
  const apply = async (revision: string) => JSON.parse((await pi.tools.get("topic_apply").execute("steered", { intent: "manual", revision, name: "Parsing" })).content[0].text);
  const stale = await apply(context.revision);
  assert.equal(stale.status, "stale");
  assert.equal(stale.context.name, "Compiler");
  assert.notEqual(stale.context.revision, context.revision);
  assert.equal((await apply(stale.context.revision)).status, "accepted");
  await f.controller.waitForIdle();
  assert.equal(f.controller.store.get(target)!.name.value, "Parsing");
  await pi.emit("before_agent_start", { messageType: "custom", message: { customType: "minime-collaboration" } });
  assert.equal((await apply(stale.context.revision)).status, "unavailable");
});

test("review3: fresh name-only and no-op requests retire failed work without replay or lost occupancy", async t => {
  for (const name of ["Parsing", "Compiler"]) await t.test(name, async t => {
    const f = await fixture(t);
    await initialize(f);
    let context = await f.controller.context(target) as any;
    f.setEdit(async () => { throw new Error("uncertain transport after possible effect"); });
    f.controller.apply(target, { intent: "manual", revision: context.revision, iconCandidates: [1] }, () => true);
    await f.controller.waitForIdle();
    assert.equal(f.controller.store.get(target)!.pending!.state, "uncertain");
    context = await f.controller.context(target) as any;
    assert.equal(context.manualCanSupersede, true);
    f.setEdit(async () => true);
    const previousIcon = new TopicStore(f.controller.store.path).get(target)!.icon;
    const previousCalls = f.api.filter(call => call.method === "editForumTopic").length;
    const result = f.controller.apply(target, { intent: "manual", revision: context.revision, name }, () => true) as any;
    assert.equal(result.status, name === "Compiler" ? "complete" : "accepted");
    await f.controller.waitForIdle();
    const stored = new TopicStore(f.controller.store.path).get(target)!;
    assert.equal(stored.pending, undefined);
    assert.equal(stored.name.value, name);
    assert.deepEqual(stored.icon, previousIcon);
    assert.deepEqual(stored.occupiedIconIds, ["catalog-garden"]);
    assert.equal(f.api.filter(call => call.method === "editForumTopic").length, previousCalls + (name === "Compiler" ? 0 : 1));
    if (name === "Parsing") assert.equal(f.api.at(-1)!.payload.icon_custom_emoji_id, undefined);
  });
});

test("review4: uncertain edits cannot turn a requested restoration into a no-op", async t => {
  for (const field of ["name", "icon"] as const) await t.test(field, async t => {
    const f = await fixture(t);
    await initialize(f);
    let context = await f.controller.context(target) as any;
    f.setEdit(async () => { throw new Error("response lost after possible effect"); });
    f.controller.apply(target, { intent: "manual", revision: context.revision,
      ...(field === "name" ? { name: "Parsing" } : { iconCandidates: [1] }) }, () => true);
    await f.controller.waitForIdle();
    context = await f.controller.context(target) as any;
    f.setEdit(async () => true);
    const calls = f.api.filter(call => call.method === "editForumTopic").length;
    assert.equal((f.controller.apply(target, { intent: "manual", revision: context.revision,
      ...(field === "name" ? { name: "Compiler" } : { iconCandidates: [0] }) }, () => true) as any).status, "accepted");
    await f.controller.waitForIdle();
    assert.equal(f.api.filter(call => call.method === "editForumTopic").length, calls + 1);
    assert.deepEqual(f.api.at(-1)!.payload, { chat_id: 100, message_thread_id: 10,
      ...(field === "name" ? { name: "Compiler" } : { icon_custom_emoji_id: "catalog-code" }) });
    assert.equal(f.controller.store.get(target)![field].pinned, true);
  });
});

test("review4: a receipt pins requested fields unaffected by a newer observation", async t => {
  for (const field of ["name", "icon"] as const) for (const both of [false, true]) await t.test(`${field}, both=${both}`, async t => {
    const f = await fixture(t);
    await f.send({ text: "Compiler" });
    const context = await f.controller.context(target) as any;
    let release!: (value: unknown) => void;
    f.setEdit(() => new Promise(resolve => { release = resolve; }));
    f.controller.apply(target, { intent: "manual", revision: context.revision,
      ...(both || field === "name" ? { name: "Parsing" } : {}),
      ...(both || field === "icon" ? { iconCandidates: [1] } : {}) }, () => true);
    await new Promise(done => setImmediate(done));
    await f.send({ date: 1700000000, forum_topic_edited: field === "name" ? { icon_custom_emoji_id: "catalog-music" } : { name: "Human wins" } });
    release(true);
    await f.controller.waitForIdle();
    const topic = f.controller.store.get(target)!;
    assert.equal(topic.name.value, field === "name" ? "Parsing" : "Human wins");
    assert.equal(topic.icon.value, field === "icon" ? "catalog-garden" : "catalog-music");
    assert.equal(topic.name.pinned && topic.icon.pinned, true);
    assert.equal(topic.pending, undefined);
    assert.equal(topic.lastReceipt?.source, "telegram-true");
  });
});

test("review4: confirmed manual icon replacements release normal icons and retain uncertain occupancy", async t => {
  for (const echo of [false, true]) await t.test(`echo=${echo}`, async t => {
    const f = await fixture(t);
    await initialize(f);
    // This distinct icon has uncertain prior occupancy and must survive all receipts.
    const initial = f.controller.store.get(target)!;
    initial.occupiedIconIds = ["uncertain-icon"];
    f.controller.store.put(initial);
    for (const index of [1, 2, 0]) {
      const context = await f.controller.context(target) as any;
      let release!: (value: unknown) => void;
      f.setEdit(() => new Promise(resolve => { release = resolve; }));
      f.controller.apply(target, { intent: "manual", revision: context.revision, iconCandidates: [index] }, () => true);
      await new Promise(done => setImmediate(done));
      if (echo) await f.send({ from: { id: target.botId, is_bot: true, first_name: "Fixture" },
        forum_topic_edited: { icon_custom_emoji_id: icons[index].custom_emoji_id } });
      release(true);
      await f.controller.waitForIdle();
      assert.deepEqual(f.controller.store.get(target)!.occupiedIconIds, ["uncertain-icon"]);
    }
    await f.send({ message_thread_id: 20, text: "Another topic" });
    assert.deepEqual((await f.controller.context({ ...target, topicId: 20 }) as any).candidates,
      [{ index: 1, emoji: "🌱" }, { index: 2, emoji: "🎵" }]);
  });
});

test("review4: live human evidence restores imported unavailable topics without probing", async t => {
  for (const availability of ["unavailable", "deleted-unconfirmed"] as const) await t.test(availability, async t => {
    const f = await fixture(t);
    f.controller.store.importSnapshot([{ ...target, availability,
      name: { value: "Compiler", pinned: false, provenance: "unknown" },
      icon: { value: "catalog-code", pinned: false, provenance: "unknown" } }]);
    assert.equal((await f.controller.context(target) as any).status, "unavailable");
    assert.equal(f.api.length, 0);
    await f.send({ text: "Continue this topic" });
    assert.equal(f.controller.store.get(target)!.availability, "observed");
    assert.equal((await f.controller.context(target) as any).status, "needs_presentation");
    assert.ok(f.api.every(call => call.method === "getForumTopicIconStickers"));
  });
});

test("review5: omitted uncertain fields survive manual supersession and restart until confirmed", async t => {
  for (const field of ["name", "icon"] as const) for (const noop of [false, true]) await t.test(`${field}, superseding noop=${noop}`, async t => {
    const f = await fixture(t);
    await initialize(f);
    let context = await f.controller.context(target) as any;
    f.setEdit(async () => { throw new Error("response lost after possible effect"); });
    f.controller.apply(target, { intent: "manual", revision: context.revision,
      ...(field === "name" ? { name: "Parsing" } : { iconCandidates: [1] }) }, () => true);
    await f.controller.waitForIdle();
    context = await f.controller.context(target) as any;
    f.setEdit(async () => true);
    f.controller.apply(target, { intent: "manual", revision: context.revision,
      ...(field === "name" ? { iconCandidates: [noop ? 0 : 2] } : { name: noop ? "Compiler" : "Parsing" }) }, () => true);
    await f.controller.waitForIdle();
    const { PrivateTopicController } = await import("../private-topics.js");
    const restarted = new PrivateTopicController(f.config, new TopicStore(f.controller.store.path), f.bot.api, () => target.botId);
    const restore = field === "name" ? { name: "Compiler" } : { iconCandidates: [0] };
    context = await restarted.context(target) as any;
    const calls = f.api.filter(call => call.method === "editForumTopic").length;
    assert.equal((restarted.apply(target, { intent: "manual", revision: context.revision, ...restore }, () => true) as any).status, "accepted");
    await restarted.waitForIdle();
    assert.equal(f.api.filter(call => call.method === "editForumTopic").length, calls + 1);
    context = await restarted.context(target) as any;
    assert.equal((restarted.apply(target, { intent: "manual", revision: context.revision, ...restore }, () => true) as any).status, "complete", "confirmed field can now be a no-op");
  });
});

test("review5: superseding uncertain or orphaned auto work never permits another automatic attempt", async t => {
  for (const field of ["name", "icon"] as const) for (const state of ["uncertain", "accepted"] as const) await t.test(`${field}, ${state}`, async t => {
    const f = await fixture(t);
    await f.send({ text: "Compiler" });
    let context = await f.controller.context(target) as any;
    f.setEdit(async () => { throw new Error("possibly applied auto initialization"); });
    f.controller.apply(target, { revision: context.revision, name: "Compiler", iconCandidates: [0] }, () => true);
    await f.controller.waitForIdle();
    const stored = f.controller.store.get(target)!;
    stored.pending!.state = state;
    f.controller.store.put(stored);
    const { PrivateTopicController } = await import("../private-topics.js");
    const restart = () => new PrivateTopicController(f.config, new TopicStore(f.controller.store.path), f.bot.api, () => target.botId);
    let restarted = restart();
    context = await restarted.context(target) as any;
    f.setEdit(async () => true);
    assert.equal((restarted.apply(target, { intent: "manual", revision: context.revision,
      ...(field === "name" ? { name: "Parsing" } : { iconCandidates: [1] }) }, () => true) as any).status, "accepted");
    await restarted.waitForIdle();
    restarted = restart();
    restarted.observe(message({ text: "Continue with parsing" }));
    context = await restarted.context(target) as any;
    assert.equal(context.initialized, true);
    assert.equal((restarted.apply(target, { revision: context.revision, name: "Repeat", iconCandidates: [2] }, () => true) as any).status, "complete");
    await restarted.waitForIdle();
    assert.equal(f.api.filter(call => call.method === "editForumTopic").length, 2);
  });
});

test("review5: catalog failure supplies current human context for name-only manual edits", async t => {
  for (const pinned of ["neither", "name", "icon"]) await t.test(`pinned=${pinned}`, async t => {
    const f = await fixture(t);
    f.setCatalog(async () => { throw new Error("catalog unavailable"); });
    await f.send(pinned === "name" ? { forum_topic_created: { name: "Compiler", icon_color: 0 } } :
      pinned === "icon" ? { forum_topic_edited: { icon_custom_emoji_id: "catalog-code" } } : { text: "Compiler" });
    const pi = await extension(t, f.transport.socketPath);
    const context = await pi.context("Rename this topic to Parsing");
    assert.ok(context?.revision);
    assert.equal(context.catalogAvailable, false);
    const apply = async (request: any) => JSON.parse((await pi.tools.get("topic_apply").execute("offline", { revision: context.revision, ...request })).content[0].text);
    assert.equal((await apply({ name: "Compiler", iconCandidates: [0] })).status, "unavailable");
    assert.equal((await apply({ intent: "manual", iconCandidates: [0] })).status, "unavailable");
    assert.equal((await apply({ intent: "manual", name: "Parsing" })).status, "accepted");
    await f.controller.waitForIdle();
    assert.equal(f.controller.store.get(target)!.name.value, "Parsing");
    assert.equal(f.controller.store.get(target)!.initialized, false);
    assert.deepEqual(f.api.filter(call => call.method === "editForumTopic").map(call => call.payload), [{ chat_id: 100, message_thread_id: 10, name: "Parsing" }]);
    assert.equal(await pi.emit("before_agent_start", { messageType: "custom", message: { customType: "minime-collaboration" } }), undefined);
  });
});

test("review5: only observations overlapping actual dispatched fields abort retries", async t => {
  for (const field of ["name", "icon"] as const) for (const manual of [false, true]) await t.test(`${field}, manual=${manual}`, async t => {
    const f = await fixture(t);
    if (manual) await initialize(f);
    else await f.send({ forum_topic_edited: field === "name" ? { icon_custom_emoji_id: "catalog-code" } : { name: "Compiler" } });
    const context = await f.controller.context(target) as any;
    let release!: (value: boolean) => void;
    f.setEdit(() => new Promise(resolve => { release = resolve; }));
    f.controller.apply(target, { intent: manual ? "manual" : "auto", revision: context.revision,
      // Auto ignores the supplied value for the pinned field.
      ...(manual ? {} : { name: "Parsing", iconCandidates: [1] }),
      ...(field === "name" ? { name: "Parsing" } : { iconCandidates: [1] }) }, () => true);
    await new Promise(done => setImmediate(done));
    await f.send({ forum_topic_edited: field === "name" ? { icon_custom_emoji_id: "catalog-music" } : { name: "Human choice" } });
    const call = f.api.filter(call => call.method === "editForumTopic").at(-1)!;
    const aborted = call.signal?.aborted;
    release(true);
    await f.controller.waitForIdle();
    assert.equal(aborted, false, "unrelated field must allow Telegram retry/confirmation");
    assert.equal(f.controller.store.get(target)![field].value, field === "name" ? "Parsing" : "catalog-garden");
    assert.equal(f.controller.store.get(target)!.pending, undefined);
  });
});
