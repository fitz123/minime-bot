import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { UserFromGetMe } from "grammy/types";
import { AgentRuntimeClient } from "../agent-runtime-client.js";
import { AgentRuntimeUncertainError, type AgentLaneState } from "../agent-runtime-protocol.js";
import { loadConfig, resolveAskAgentPolicy, validateAgent } from "../config.js";
import { loadDefaultDelivery, main as runCron } from "../cron-runner.js";
import { SessionManager } from "../session-manager.js";
import { SessionStore } from "../session-store.js";
import { createTelegramBindingReload } from "../telegram-binding-reload.js";
import { createTelegramBot } from "../telegram-bot.js";
import type { BotConfig, TelegramBinding } from "../types.js";

const workerChat = 10001;
const localChat = 10002;
const workerSession = "worker-fixture-session";
const route = {
  socketPath: "/synthetic/worker/socket",
  workerUid: process.getuid?.() === 60001 ? 60002 : 60001,
  controllerName: "fixture-controller",
};

function setup(t: TestContext) {
  const root = mkdtempSync(join("/tmp", "worker-chat-routing-"));
  const storePath = join(root, "sessions.json");
  const config: BotConfig = {
    telegramToken: "1:synthetic",
    agents: {
      satellite: validateAgent({ model: "fixture/model", workspaceCwd: "/synthetic/worker", workerRuntime: route }, "satellite"),
      local: validateAgent({ model: "fixture/model", workspaceCwd: "/synthetic/local" }, "local"),
    },
    bindings: [
      { chatId: workerChat, kind: "dm", agentId: "satellite" },
      { chatId: localChat, kind: "dm", agentId: "local" },
    ],
    whisperModelPath: "/synthetic/unused",
    sessionDefaults: {
      idleTimeoutMs: 1000, maxConcurrentSessions: 2, maxMediaBytes: 1024,
      maxMessageAgeMs: 60_000, requireMention: false,
    },
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, storePath, config };
}

function transport(t: TestContext, config: BotConfig, manager: SessionManager, options?: Parameters<typeof createTelegramBot>[2]) {
  const { bot, messageQueue, reloadGroupBindings } = createTelegramBot(config, manager, options);
  t.after(() => { messageQueue.clearAll(); });
  bot.botInfo = { id: 100, is_bot: true, first_name: "Fixture", username: "fixture_bot" } as UserFromGetMe;
  const sent: string[] = [];
  bot.api.config.use((_prev, method, payload, _signal) => {
    if (method === "sendMessage" && "text" in payload) sent.push(String(payload.text));
    if (method === "sendRichMessage" && "rich_message" in payload) {
      const rich = payload.rich_message as { markdown?: string; blocks?: Array<{ text?: string }> };
      sent.push(rich.markdown ?? rich.blocks?.map(block => block.text).join("") ?? "");
    }
    return Promise.resolve({ ok: true, result: { message_id: 1 } }) as never;
  });
  let updateId = 0;
  async function receive(text: string, chat = workerChat, extra = {}, flush = true) {
    const id = ++updateId;
    await bot.handleUpdate({
      update_id: id,
      message: {
        message_id: id, chat: chat < 0
          ? { id: chat, type: "supergroup", title: "Fixture group" }
          : { id: chat, type: "private", first_name: "Fixture" },
        from: { id: Math.abs(chat), is_bot: false, first_name: "Fixture" },
        date: Math.floor(Date.now() / 1000), text, ...extra,
      },
    });
    if (flush) messageQueue.flushPending();
  }
  return { receive, reloadGroupBindings, messageQueue, waitForIdle: () => messageQueue.waitForIdle(), sent };
}

function workerClient(t: TestContext, hooks: Partial<Pick<AgentRuntimeClient, "open" | "prompt" | "close" | "disconnect">> = {}) {
  const calls: string[] = [];
  let lane: AgentLaneState;
  const client: Required<typeof hooks> = {
    async open(laneId, expected, expectedAgent) {
      calls.push(`open:${expected ?? "new"}`);
      assert.equal(expectedAgent, "satellite");
      assert.match(laneId, /^chat-[a-f0-9]{64}$/);
      assert.ok(expected === undefined || expected === workerSession);
      lane = {
        handle: { agentId: "satellite", laneId, sessionId: workerSession, generation: 1 },
        phase: "ready",
      };
      return lane;
    },
    prompt(handle, requestId, text, onEvent) {
      assert.deepEqual(handle, lane.handle);
      calls.push(`prompt:${text}`);
      onEvent?.({ type: "result", result: "Worker reply", session_id: workerSession });
      return {
        accepted: Promise.resolve({ ...lane, request: { requestId, outcome: "accepted" } }),
        completed: Promise.resolve({ ...lane, request: { requestId, outcome: "settled" } }),
      };
    },
    async close(handle) {
      assert.deepEqual(handle, lane.handle);
      calls.push("close");
      return { ...lane, phase: "closed" };
    },
    disconnect: () => { calls.push("disconnect"); },
    ...hooks,
  };
  const connect = t.mock.method(AgentRuntimeClient, "connect", async (...[path, _timeout, identity]: Parameters<typeof AgentRuntimeClient.connect>) => {
    assert.equal(path, route.socketPath);
    assert.deepEqual(identity, route);
    calls.push("connect");
    return client as AgentRuntimeClient;
  });
  return { calls, connect };
}

test("ordinary Telegram text uses the bound worker and reopens its exact session on controller restart", async t => {
  const { storePath, config } = setup(t);
  const { calls } = workerClient(t);
  let manager = new SessionManager(() => config, storePath);
  const localPrepare = t.mock.method(manager, "getOrCreateSession");
  const first = transport(t, config, manager);
  await first.receive("ordinary worker message");
  await first.waitForIdle();
  assert.deepEqual(first.sent, ["Worker reply"]);
  assert.deepEqual(calls.map(call => call.split(":")[0]), ["connect", "open", "prompt", "close", "disconnect"]);
  assert.match(calls[2], /ordinary worker message$/);
  assert.equal(localPrepare.mock.callCount(), 0);
  assert.equal(manager.getActiveCount(), 0);
  const saved = new SessionStore(storePath).getSession(String(workerChat));
  assert.equal(saved?.bindingState, "worker");
  assert.equal(saved?.sessionId, workerSession);
  assert.equal(saved?.sessionFile, undefined);
  await manager.closeAll();

  manager = new SessionManager(() => config, storePath);
  const second = transport(t, config, manager);
  await second.receive("follow-up");
  await second.waitForIdle();
  assert.equal(second.sent[0], "Worker reply");
  assert.equal(calls[6], `open:${workerSession}`);
  assert.deepEqual(new SessionStore(storePath).getSession(String(workerChat)), saved);
});

test("a running Telegram handler applies only validated effective group routes", async t => {
  const { root, storePath, config } = setup(t);
  const configPath = join(root, "config.yaml");
  const localPath = join(root, "config.local.yaml");
  const instanceConfigPath = join(root, "instance.yaml");
  const sopsFile = join(root, "fixture-secrets.yaml");
  writeFileSync(sopsFile, "{}");
  let telegramCredential = "1:synthetic";
  const secretExecFileSync = t.mock.fn((_file: string, args: readonly string[]) => {
    return args[2] === '["telegram"]["token"]' ? telegramCredential : "synthetic-trigger-bearer";
  });
  const keep = { chatId: -101, agentId: "satellite", kind: "group", label: "keep" } as const;
  const remove = { ...keep, chatId: -102, label: "remove" };
  const add = { ...keep, chatId: -103, label: "add" };
  const triggerGroup = { ...keep, chatId: -104, label: "trigger", agentId: "local", topicId: 0 };
  const dm = config.bindings[1];
  const triggerInput = { chatId: triggerGroup.chatId, threadId: 0, port: 31001, bearerSopsKey: "trigger.bearer" };
  const initial = [keep, remove, triggerGroup, dm];
  const next = [keep, add, triggerGroup, dm];
  const staged = { ...keep, chatId: -105, label: "staged" };
  const effectiveAdd = -203;
  const topic = { message_thread_id: 7, is_topic_message: true };
  writeFileSync(configPath, JSON.stringify({
    agents: config.agents, bindings: initial, sessionDefaults: config.sessionDefaults,
    secrets: { sopsFile }, telegramTokenSopsKey: "telegram.token", triggerInput,
  }));
  writeFileSync(instanceConfigPath, "{}");
  const loadOptions = { instanceConfigPath, secretExecFileSync };
  const readConfig = t.mock.fn(() => loadConfig(configPath, { ...loadOptions, resolveSecrets: false }));
  const readCandidate = t.mock.fn(() => loadConfig(configPath, { ...loadOptions, telegramBindingReload: true }));
  const startup = loadConfig(configPath, loadOptions);
  const bindingReload = createTelegramBindingReload(startup, readConfig, readCandidate);
  const manager = new SessionManager(readConfig, storePath, undefined, { initialConfig: startup, telegramBindingReload: bindingReload });
  t.after(() => manager.closeAll());
  const { calls, connect } = workerClient(t);
  const prepareLocal = t.mock.method(manager, "getOrCreateSession");
  const holdInput = t.mock.method(manager, "holdHumanInput");
  const chat = transport(t, startup, manager, { bindingReload });
  const reload = chat.reloadGroupBindings!;

  async function expectWorker(text: string, id: number, extra = {}) {
    const replied = chat.sent.length;
    const connections = connect.mock.callCount();
    const configReads = readConfig.mock.callCount();
    const candidateReads = readCandidate.mock.callCount();
    const secretReads = secretExecFileSync.mock.callCount();
    await chat.receive(text, id, extra);
    await chat.waitForIdle();
    assert.equal(connect.mock.callCount(), connections + 1);
    assert.equal(chat.sent.length, replied + 1);
    assert.equal(chat.sent.at(-1), "Worker reply");
    assert.equal(readConfig.mock.callCount(), configReads);
    assert.equal(readCandidate.mock.callCount(), candidateReads);
    assert.equal(secretExecFileSync.mock.callCount(), secretReads);
    assert.ok(calls.filter(call => call.startsWith("prompt:")).at(-1)?.endsWith(text));
  }
  async function expectDrop(id: number, extra = {}, admitted = false) {
    const replied = chat.sent.length;
    const connections = connect.mock.callCount();
    const admittedUpdates = holdInput.mock.callCount();
    await chat.receive("ordinary dropped message", id, extra);
    await chat.waitForIdle();
    assert.equal(holdInput.mock.callCount(), admittedUpdates + Number(admitted));
    assert.equal(connect.mock.callCount(), connections);
    assert.equal(chat.sent.length, replied);
    assert.equal(chat.messageQueue.getPendingCount(String(id)), 0);
  }
  function writeCandidate(bindings: TelegramBinding[], extra = {}) {
    writeFileSync(localPath, JSON.stringify({ bindings, ...extra }));
  }

  await expectWorker("initial unchanged group", keep.chatId);
  await expectWorker("initial group to remove", remove.chatId);
  writeCandidate(next);
  writeFileSync(instanceConfigPath, JSON.stringify({
    bindingIdentityOverrides: { add: { chatId: effectiveAdd, topicId: topic.message_thread_id } },
  }));
  await expectDrop(effectiveAdd, topic);
  await expectWorker("removed only after explicit reload", remove.chatId);
  secretExecFileSync.mock.resetCalls();
  assert.equal(reload(), 3);
  assert.deepEqual(secretExecFileSync.mock.calls.map(call => call.arguments[1][2]), ['["telegram"]["token"]']);
  await expectWorker("new effective topic", effectiveAdd, topic);
  assert.equal(new SessionStore(storePath).getSession(`${effectiveAdd}:7`)?.bindingState, "worker");
  await expectWorker("unchanged after reload", keep.chatId);
  await expectDrop(effectiveAdd, {}, true);
  await expectDrop(add.chatId, topic);
  await expectDrop(remove.chatId);

  const command = { entities: [{ type: "bot_command", offset: 0, length: 6 }] };
  const handling = chat.receive("/start", effectiveAdd, { ...topic, ...command });
  assert.throws(reload, /Telegram is processing an update/);
  await handling;
  assert.match(chat.sent.at(-1) ?? "", /route text to the worker for "satellite"/);
  const replies = chat.sent.length;
  await chat.receive("/start", remove.chatId, command);
  assert.equal(chat.sent.length, replies);

  const invalidConfig = /Effective config or Telegram credential is invalid/;
  const invalidCandidates: Array<[string, () => void, RegExp]> = [
    ["malformed YAML", () => writeFileSync(localPath, "bindings: ["), invalidConfig],
    ["non-list bindings", () => writeFileSync(localPath, "bindings: { kind: group }"), invalidConfig],
    ["malformed topic", () => writeFileSync(localPath, JSON.stringify({
      bindings: [...next, { ...staged, topicId: "7" }],
    })), invalidConfig],
    ["private chat ID in a group route", () => writeCandidate([...next, {
      ...staged, chatId: -staged.chatId,
    }]), invalidConfig],
    ["unknown topic agent", () => writeCandidate([...next, {
      ...staged, topics: [{ topicId: 7, agentId: "missing" }],
    }]), invalidConfig],
    ["disk-only topic agent", () => writeCandidate([...next, {
      ...staged, topics: [{ topicId: 7, agentId: "diskOnly" }],
    }], { agents: { diskOnly: config.agents.local } }), /unavailable in the running process/],
    ["changed worker route", () => writeCandidate([...next, staged], {
      agents: { satellite: { workerRuntime: { socketPath: "/synthetic/worker/replacement" } } },
    }), /worker route changed since startup/],
    ["changed running trigger route", () => writeCandidate([keep, add, dm, staged], {
      triggerInput: { ...triggerInput, chatId: dm.chatId },
    }), /running trigger input binding requires a restart/],
    ["changed global mention policy", () => writeCandidate([...next, staged], {
      sessionDefaults: { requireMention: true },
    }), /global mention policy requires a restart/],
    ["duplicate chat binding", () => writeCandidate([...next, staged, { ...staged, label: "duplicate" }]),
      /Duplicate Telegram group chat\/topic route/],
    ["duplicate nested and direct topic", () => writeCandidate([...next,
      { ...staged, topics: [{ topicId: 9 }] }, { ...staged, label: "duplicate", topicId: 9 },
    ]), /Duplicate Telegram group chat\/topic route/],
    ["direct reassignment", () => writeCandidate([
      ...next.map(binding => binding === keep ? { ...keep, agentId: "local" } : binding), staged,
    ]), /reassigning an existing Telegram group binding requires a restart/],
    ["topic addition reassigns an existing fallback", () => writeCandidate([
      ...next, staged, { ...keep, label: "override", topicId: 9, agentId: "local" },
    ]), /Reassigning an existing Telegram group chat\/topic route requires a restart/],
    ["changed DM", () => writeCandidate([...next.filter(binding => binding.kind === "group"), staged, {
      ...dm, chatId: dm.chatId + 1,
    }]), /DM binding changes require a restart/],
  ];
  for (const [name, write, error] of invalidCandidates) {
    write();
    assert.throws(reload, error, name);
    await expectWorker(`unchanged after ${name}`, keep.chatId);
    await expectDrop(staged.chatId);
  }
  writeCandidate([...next, staged]);
  telegramCredential = "2:synthetic-replacement";
  assert.throws(reload, { message: "Telegram credential differs from the running transport" });
  await expectDrop(staged.chatId);
  await expectWorker("unchanged after credential mismatch", keep.chatId);
  telegramCredential = "1:synthetic";

  const instance = readFileSync(instanceConfigPath);
  writeFileSync(instanceConfigPath, JSON.stringify({
    bindingIdentityOverrides: { add: { chatId: effectiveAdd }, absent: { chatId: -299 } },
  }));
  assert.throws(reload, invalidConfig);
  await expectDrop(staged.chatId);
  await expectWorker("added route survives rejected reloads", effectiveAdd, topic);
  await expectDrop(remove.chatId);
  assert.equal(prepareLocal.mock.callCount(), 0);
  writeFileSync(instanceConfigPath, instance);

  await chat.receive("work already queued for the worker", keep.chatId, topic, false);
  writeCandidate(next.filter(binding => binding !== keep));
  assert.throws(reload, /removed Telegram lane still has accepted work/);
  chat.messageQueue.flushPending();
  await chat.waitForIdle();
  assert.ok(calls.filter(call => call.startsWith("prompt:")).at(-1)?.endsWith("work already queued for the worker"));
  assert.equal(reload(), 2);
  await expectDrop(keep.chatId, topic);
  writeCandidate([...next.filter(binding => binding !== keep), { ...keep, agentId: "local" }]);
  assert.throws(reload, /reassigning an existing Telegram group binding requires a restart/);
  await expectDrop(keep.chatId, topic);
});

test("the running Telegram handler requires another ready conversational transport before removing its last binding", t => {
  const { root, storePath, config } = setup(t);
  const configPath = join(root, "config.yaml");
  const instanceConfigPath = join(root, "instance.yaml");
  const sopsFile = join(root, "fixture-secrets.yaml");
  writeFileSync(instanceConfigPath, "{}");
  writeFileSync(sopsFile, "{}");
  const base = {
    agents: config.agents,
    secrets: { sopsFile },
    telegramTokenSopsKey: "telegram.token",
    discord: { tokenEnv: "SYNTHETIC_DISCORD_TOKEN", bindings: [
      { guildId: "fixture", channelId: "fixture", agentId: "local", kind: "channel" },
    ] },
  };
  const group = { chatId: -108, agentId: "satellite", kind: "group" };
  writeFileSync(configPath, JSON.stringify({ ...base, bindings: [group] }));
  const readConfig = () => loadConfig(configPath, { instanceConfigPath, resolveSecrets: false });
  const readCandidate = () => loadConfig(configPath, {
    instanceConfigPath,
    telegramBindingReload: true,
    secretExecFileSync: () => "1:synthetic",
  });
  const startup = readCandidate();
  const bindingReload = createTelegramBindingReload(startup, readConfig, readCandidate);
  const manager = new SessionManager(readConfig, storePath, undefined, { initialConfig: startup, telegramBindingReload: bindingReload });
  t.after(() => manager.closeAll());
  let otherReady = false;
  const chat = transport(t, startup, manager, { bindingReload, hasOtherActivePlatform: () => otherReady });
  writeFileSync(configPath, JSON.stringify({ ...base, bindings: [] }));

  assert.throws(chat.reloadGroupBindings!, /last binding without another running conversational transport/);
  assert.equal(bindingReload.getBindings()[0].chatId, group.chatId);
  otherReady = true;
  assert.equal(chat.reloadGroupBindings!(), 0);
  assert.deepEqual(bindingReload.getBindings(), []);
});

test("worker connection failure cannot call local Pi, and another agent still follows local preparation and relay", async t => {
  const { storePath, config } = setup(t);
  const connect = t.mock.method(AgentRuntimeClient, "connect", async () => { throw new Error("synthetic unavailable endpoint"); });
  const manager = new SessionManager(() => config, storePath);
  const localPrepare = t.mock.method(manager, "getOrCreateSession", async () => ({} as never));
  const localSend = manager.sendSessionMessage.bind(manager);
  t.mock.method(manager, "sendSessionMessage", async function* (...[chatId, agentId, text, options]: Parameters<SessionManager["sendSessionMessage"]>) {
    if (agentId !== "local") {
      yield* localSend(chatId, agentId, text, options);
      return;
    }
    assert.match(text, /ordinary local message$/);
    yield { type: "result", result: "Local reply", session_id: "local-fixture" };
  });
  const chat = transport(t, config, manager);
  await chat.receive("unavailable worker");
  await chat.waitForIdle();
  assert.match(chat.sent[0], /worker session could not be opened.*not submitted/i);
  assert.equal(localPrepare.mock.callCount(), 0);
  assert.equal(new SessionStore(storePath).getSession(String(workerChat)), undefined);

  await chat.receive("ordinary local message", localChat);
  await chat.waitForIdle();
  assert.deepEqual(localPrepare.mock.calls[0].arguments, [String(localChat), "local"]);
  assert.equal(chat.sent[1], "Local reply");
  assert.equal(connect.mock.callCount(), 1);
});

test("old local history is blocked before worker open or clean, and a worker binding cannot fall back", async t => {
  const { root, storePath, config } = setup(t);
  const { connect } = workerClient(t);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const sessionFile = join(workspace, "history.jsonl");
  writeFileSync(sessionFile, "synthetic prior history");
  const store = new SessionStore(storePath);
  const key = String(workerChat);
  store.setSession(key, {
    bindingState: "bound", chatId: key, agentId: "satellite",
    workspaceRealpath: workspace, sessionId: "prior-local-session", sessionFile, lastActivity: 1,
  });
  const localBytes = readFileSync(storePath);
  const manager = new SessionManager(() => config, storePath);
  const chat = transport(t, config, manager);
  await chat.receive("existing chat");
  await chat.waitForIdle();
  await chat.receive("/clean", workerChat, { entities: [{ type: "bot_command", offset: 0, length: 6 }] });
  assert.match(chat.sent[0], /existing session binding/);
  assert.match(chat.sent[1], /existing binding was retained/);
  assert.equal(connect.mock.callCount(), 0);
  await assert.rejects(manager.destroySession(key), /existing binding was retained/);
  assert.deepEqual(readFileSync(storePath), localBytes);
  assert.equal(readFileSync(sessionFile, "utf8"), "synthetic prior history");

  const workerKey = String(localChat);
  store.setSession(workerKey, { bindingState: "worker", chatId: workerKey, agentId: "local", sessionId: workerSession, lastActivity: 2 });
  const reloaded = new SessionManager(() => config, storePath);
  const reassigned = transport(t, config, reloaded);
  await reassigned.receive("attempt to use local route", localChat);
  await reassigned.waitForIdle();
  assert.match(reassigned.sent[0], /requires its configured worker route/);
  await assert.rejects(reloaded.getOrCreateSession(workerKey, "local"), /existing binding was retained/);
  assert.equal(new SessionStore(storePath).getSession(workerKey)?.sessionId, workerSession);
  assert.equal(connect.mock.callCount(), 0);
});

test("an early worker result is withheld on uncertain completion and the prompt is never replayed", async t => {
  const { storePath, config } = setup(t);
  let opened = 0;
  let prompted = 0;
  let closed = 0;
  let disconnected = 0;
  workerClient(t, {
    async open(laneId, expected) {
      opened++;
      assert.equal(expected, opened === 1 ? undefined : workerSession);
      return {
        handle: { agentId: "satellite", laneId, sessionId: workerSession, generation: opened }, phase: "ready",
        ...(opened === 2 ? { request: { requestId: "prior", outcome: "interrupted" } } : {}),
      };
    },
    prompt(handle, requestId, _text, onEvent) {
      prompted++;
      onEvent?.({ type: "result", result: "Unconfirmed result", session_id: workerSession });
      return {
        accepted: Promise.resolve({ handle, phase: "prompting", request: { requestId, outcome: "accepted" } }),
        completed: Promise.reject(new AgentRuntimeUncertainError()),
      };
    },
    async close(handle) { closed++; return { handle, phase: "closed" }; },
    disconnect() { disconnected++; },
  });
  const manager = new SessionManager(() => config, storePath);
  const chat = transport(t, config, manager);
  await chat.receive("may have run");
  await chat.waitForIdle();
  assert.equal(chat.sent.length, 1);
  assert.match(chat.sent[0], /may have been accepted.*never resend implicitly/);
  assert.deepEqual({ opened, prompted, closed, disconnected }, { opened: 1, prompted: 1, closed: 0, disconnected: 1 });

  await chat.receive("separate later turn");
  await chat.waitForIdle();
  assert.match(chat.sent[1], /previous worker turn was interrupted/);
  assert.deepEqual({ opened, prompted, closed, disconnected }, { opened: 2, prompted: 1, closed: 1, disconnected: 2 });
  assert.equal(new SessionStore(storePath).getSession(String(workerChat))?.sessionId, workerSession);
});

test("worker configuration rejects the controller UID, and ask-agent denies either worker endpoint", t => {
  const { config } = setup(t);
  const { local, satellite } = config.agents;
  assert.throws(() => validateAgent({ ...satellite, workerRuntime: { ...route, workerUid: process.getuid?.() } }, "satellite"), /distinct nonroot workerUid/);
  assert.equal(resolveAskAgentPolicy(local, satellite).allowed, false);
  assert.equal(resolveAskAgentPolicy(satellite, local).allowed, false);
});

test("controller shutdown disconnects an active worker turn and keeps its binding", async t => {
  const { storePath, config } = setup(t);
  let start!: () => void;
  let interrupt!: (error: Error) => void;
  const started = new Promise<void>(resolve => { start = resolve; });
  const completion = new Promise<AgentLaneState>((_resolve, reject) => { interrupt = reject; });
  let disconnected = false;
  workerClient(t, {
    prompt(handle, requestId) {
      start();
      return {
        accepted: Promise.resolve({ handle, phase: "prompting", request: { requestId, outcome: "accepted" } }),
        completed: completion,
      };
    },
    disconnect() {
      disconnected = true;
      interrupt(new AgentRuntimeUncertainError());
    },
  });
  const manager = new SessionManager(() => config, storePath);
  const chat = transport(t, config, manager);
  await chat.receive("active worker turn");
  await started;
  await manager.closeAll();
  await chat.waitForIdle();
  assert.equal(disconnected, true);
  assert.match(chat.sent[0], /may have been accepted/);
  assert.equal(new SessionStore(storePath).getSession(String(workerChat))?.sessionId, workerSession);
});

test("worker agents cannot run central consultation, trigger input, or scheduled work", async t => {
  const { root, storePath, config } = setup(t);
  const manager = new SessionManager(() => config, storePath);
  const prepare = t.mock.method(manager, "getOrCreateSession");
  assert.ok(!manager.collaborationEndpoints().some(endpoint => endpoint.label === "satellite"));
  await assert.rejects(manager.deliverCollaboration({
    from: { kind: "agent", id: "local" }, to: { kind: "agent", id: "satellite" },
    text: "synthetic consultation", id: "fixture-delivery", conversation: "fixture", expires: Date.now() + 10_000,
  }, () => assert.fail("consultation consumed")), /unavailable for worker-routed sessions/);
  assert.equal(prepare.mock.callCount(), 0);

  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, JSON.stringify({
    agents: config.agents, bindings: config.bindings, telegramTokenEnv: "SYNTHETIC_TELEGRAM_TOKEN",
    triggerInput: { chatId: workerChat, port: 31001, bearerEnv: "SYNTHETIC_TRIGGER_BEARER" },
  }));
  assert.throws(() => loadConfig(configPath, { resolveSecrets: false }), /Trigger input cannot target a worker-routed agent/);

  for (const type of ["llm", "script"] as const) {
    const messages: string[] = [];
    await assert.rejects(runCron({
      argv: ["cron", "--task", "fixture"],
      loadDefaultDelivery: () => loadDefaultDelivery(configPath),
      log: (_name, message) => messages.push(message),
      loadCronTask: () => ({ name: "fixture", schedule: "", type, agentId: "satellite", deliveryChatId: workerChat }),
      readCronOutboxRecord: () => assert.fail("outbox read"),
      runScript: () => assert.fail("central script"),
      resolveCronAgentData: () => assert.fail("central Pi"),
      writeCronHealthMetric: () => {},
      writeCronDiagnosticEvent: () => {},
      exit: code => { throw new Error(`cron exit ${code}`); },
    }), /cron exit 1/);
    assert.ok(messages.some(message => message.includes("Cron execution is unavailable for worker-routed agent")));
  }
});
