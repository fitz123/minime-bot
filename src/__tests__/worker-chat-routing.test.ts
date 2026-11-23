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
import { createTelegramBot } from "../telegram-bot.js";
import type { BotConfig } from "../types.js";

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

function transport(t: TestContext, config: BotConfig, manager: SessionManager) {
  const { bot, messageQueue } = createTelegramBot(config, manager);
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
  async function receive(text: string, chat = workerChat, extra = {}) {
    const id = ++updateId;
    await bot.handleUpdate({
      update_id: id,
      message: {
        message_id: id, chat: { id: chat, type: "private", first_name: "Fixture" },
        from: { id: chat, is_bot: false, first_name: "Fixture" },
        date: Math.floor(Date.now() / 1000), text, ...extra,
      },
    });
    messageQueue.flushPending();
  }
  return { receive, waitForIdle: () => messageQueue.waitForIdle(), sent };
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
