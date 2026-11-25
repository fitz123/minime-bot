import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { AgentRuntimeClient } from "../agent-runtime-client.js";
import { workerChatLaneId, type AgentRuntimeMessage } from "../agent-runtime-protocol.js";
import { AgentRuntimeWorker } from "../agent-runtime-worker.js";
import type { WorkerLaneRecord } from "../agent-runtime-store.js";
import { runCliAsync } from "../cli.js";
import { loadConfig } from "../config.js";
import { main as runCron } from "../cron-runner.js";
import { SessionManager } from "../session-manager.js";
import { SessionStore } from "../session-store.js";
import type { ResultMessage } from "../types.js";

// Replace socket I/O and endpoint metadata only. Both sides use production
// framing, dispatch and result correlation, and the worker starts real Pi.
class MemorySocket extends EventEmitter {
  peer!: MemorySocket;
  destroyed = false;
  writable = true;
  writableLength = 0;
  intercept?: (message: AgentRuntimeMessage) => boolean | void;

  write(frame: string): boolean {
    queueMicrotask(() => {
      if (this.destroyed || this.peer.destroyed || this.intercept?.(JSON.parse(frame))) return;
      this.peer.emit("data", Buffer.from(frame));
    });
    return true;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.peer.destroy();
    queueMicrotask(() => this.emit("close"));
  }

  pause(): void {}
  end(): void { this.destroy(); }
  destroySoon(): void { this.destroy(); }
}

const agentId = "fixture-worker";
const chatId = "fixture-conversation";
const model = "openai-codex/continuity-fixture";
const provider = realpathSync(resolve("test-fixtures/agent-runtime/continuity-provider.mjs"));

function fixture(t: TestContext) {
  const scratch = resolve(".tmp");
  mkdirSync(scratch, { mode: 0o700, recursive: true });
  const root = realpathSync(mkdtempSync(join(scratch, "worker-continuity-")));
  const dir = (name: string) => {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    return path;
  };
  const control = dir("control");
  const controllerHome = dir("controller-home");
  const controllerPi = dir("controller-pi");
  const localWorkspace = dir("local-workspace");
  const localSessions = dir("local-sessions");
  const workerHome = dir("worker-home");
  const workerWorkspace = dir("worker-workspace");
  const stateRoot = dir("worker-state");
  const sessionRoot = dir("worker-sessions");
  const contextRoot = dir("worker-context");
  const logs = dir("logs");
  const configPath = join(control, "config.yaml");
  const cronsPath = join(control, "crons.yaml");
  const storePath = join(control, "data/sessions.json");
  const route = {
    socketPath: "/synthetic/worker/agent.sock",
    workerUid: process.getuid!() === 60001 ? 60002 : 60001,
    controllerName: "fixture-controller",
    scheduledLlm: true,
  };
  const uid = process.getuid!();
  const worker = new AgentRuntimeWorker({
    version: 1, agentId, workerUid: uid, workerGid: process.getgid!(),
    home: workerHome, controllerUid: uid, controllerName: route.controllerName,
    workspace: workerWorkspace, stateRoot, sessionRoot, contextRoot,
    socketDirectory: dirname(route.socketPath), socketPath: route.socketPath,
    model, thinking: "off", knowledge: "none", capabilities: [], tools: [], offline: true,
  }, { trustedTestExtensions: [provider] });
  const originalEnv = process.env;
  process.env = {
    HOME: controllerHome, PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
    TMPDIR: dir("temp"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
    PI_CODING_AGENT_DIR: controllerPi, PI_CODING_AGENT_SESSION_DIR: localSessions,
    MINIME_CONTROL_WORKSPACE_ROOT: control, MINIME_CONFIG_PATH: configPath, MINIME_CRONS_PATH: cronsPath,
    MINIME_MEDIA_ROOT: dir("media"), LOG_DIR: logs,
  };
  t.after(async () => {
    try { await worker.shutdown(); }
    finally {
      process.env = originalEnv;
      rmSync(root, { recursive: true, force: true });
    }
  });
  for (const [directory, scope] of [[controllerHome, "controller-home"], [localWorkspace, "local"],
    [workerHome, "worker-home"], [workerWorkspace, "worker"]]) {
    writeFileSync(join(directory, "fixture-scope.txt"), scope);
  }
  for (const workspace of [localWorkspace, workerWorkspace]) {
    writeFileSync(join(workspace, "CLAUDE.md"), "Synthetic continuity fixture context.\n");
  }

  const wire: { receive?: (message: AgentRuntimeMessage, client: MemorySocket) => boolean | void } = {};
  t.mock.method(AgentRuntimeClient, "connect", async (...[path, timeout, identity]: Parameters<typeof AgentRuntimeClient.connect>) => {
    assert.equal(path, route.socketPath);
    assert.deepEqual(identity, route);
    const clientSocket = new MemorySocket();
    const workerSocket = new MemorySocket();
    clientSocket.peer = workerSocket;
    workerSocket.peer = clientSocket;
    workerSocket.intercept = frame => wire.receive?.(frame, clientSocket);
    (worker as unknown as { accept(socket: Socket): void }).accept(workerSocket as unknown as Socket);
    return Reflect.construct(AgentRuntimeClient, [clientSocket, timeout ?? 15_000]) as AgentRuntimeClient;
  });

  function configure(routed: boolean) {
    writeFileSync(configPath, JSON.stringify({
      telegramTokenEnv: "SYNTHETIC_TOKEN",
      agents: { [agentId]: { workspaceCwd: localWorkspace, model, thinking: "off", ...(routed ? { workerRuntime: route } : {}) } },
      bindings: [{ chatId: 101, kind: "dm", agentId }],
      piExtraExtensions: [provider],
    }));
  }
  function manager() {
    const config = loadConfig(configPath, { resolveSecrets: false });
    return new SessionManager(() => config, storePath, logs);
  }
  async function cli(action: "adopt" | "rollback") {
    let output = "";
    const capture = (text: string) => { output += text; };
    const status = await runCliAsync(
      ["worker-lane", action, "--workspace", control, "--agent", agentId, "--lane", chatId],
      { stdout: capture, stderr: capture },
    );
    return { status, output };
  }
  function records(): WorkerLaneRecord[] {
    const lanes = join(stateRoot, "lanes");
    return readdirSync(lanes).map(lane => JSON.parse(readFileSync(join(lanes, lane, "binding.json"), "utf8")));
  }
  const store = () => new SessionStore(storePath);
  return { configure, manager, cli, records, store, cronsPath, sessionRoot, workerWorkspace, wire };
}

async function ordinaryTurn(manager: SessionManager, prompt: string) {
  let result: ResultMessage | undefined;
  try {
    for await (const line of manager.sendSessionMessage(chatId, agentId, prompt)) {
      if (line.type === "result") result = line;
    }
    assert.ok(result && !result.is_error, JSON.stringify(result));
    return JSON.parse(result.result);
  } finally {
    await manager.closeAll();
  }
}

test("CLI adoption and rollback fence one binding and preserve exact histories through real Pi turns", { timeout: 75_000 }, async t => {
  const f = fixture(t);
  f.configure(false);
  assert.deepEqual((await ordinaryTurn(f.manager(), "LOCAL_BASE")).turns, ["LOCAL_BASE"]);
  const original = f.store().getSession(chatId);
  assert.equal(original?.bindingState, "bound");
  const localBytes = readFileSync(original.sessionFile);
  const newline = localBytes.indexOf(0x0a);
  const header = JSON.parse(localBytes.subarray(0, newline).toString("utf8"));
  const staged = join(f.sessionRoot, "adopt-" + workerChatLaneId(chatId) + ".jsonl");
  const stagedBytes = Buffer.concat([
    Buffer.from(JSON.stringify({ ...header, cwd: f.workerWorkspace }) + "\n"),
    localBytes.subarray(newline + 1),
  ]);
  writeFileSync(staged, stagedBytes, { mode: 0o600 });
  f.configure(true);

  appendFileSync(staged, "{}\n");
  assert.match((await f.cli("adopt")).output, /differs from the controller history/);
  assert.deepEqual(f.store().getSession(chatId), original);
  writeFileSync(staged, stagedBytes);

  const changedLocal = { ...original, lastActivity: original.lastActivity + 1 };
  f.wire.receive = frame => {
    if (frame.type === "response" && frame.state?.phase === "ready") {
      f.wire.receive = undefined;
      f.store().setSession(chatId, changedLocal);
    }
  };
  assert.match((await f.cli("adopt")).output, /selected lane changed concurrently/);
  assert.deepEqual(f.store().getSession(chatId), changedLocal);

  const staleWriter = f.store();
  const unrelated = {
    bindingState: "legacy-unresolved", chatId: "unrelated", agentId, lastActivity: 1,
    failedSessionId: "unrelated-session", legacyFailure: "missing",
  } as const;
  f.wire.receive = frame => {
    if (frame.type === "response" && frame.state?.phase === "ready") staleWriter.setSession("unrelated", unrelated);
  };
  assert.deepEqual(await f.cli("adopt"), { status: 0, output: "Worker lane adopted.\n" });
  f.wire.receive = undefined;
  assert.deepEqual(f.store().getSession("unrelated"), unrelated);
  const adopted = f.store().getSession(chatId);
  assert.equal(adopted?.bindingState, "worker");
  assert.deepEqual(adopted.adoption?.local, changedLocal);

  const first = await ordinaryTurn(f.manager(), "WORKER_FIRST");
  assert.deepEqual(first.turns, ["LOCAL_BASE", "WORKER_FIRST"]);
  assert.equal(first.workspace, "worker");
  assert.equal(first.home, "worker-home");
  assert.equal(first.controllerEnv, false);
  assert.equal(first.cronFastOff, false);
  const later = await ordinaryTurn(f.manager(), "WORKER_LATER");
  assert.deepEqual(later.turns, ["LOCAL_BASE", "WORKER_FIRST", "WORKER_LATER"]);
  const [binding] = f.records();
  assert.equal(binding.binding.sessionFile, staged);
  assert.equal(binding.binding.sessionId, original.sessionId);
  assert.equal(binding.request?.outcome, "settled");
  const workerBytes = readFileSync(staged);
  assert.deepEqual(readFileSync(original.sessionFile), localBytes);
  const afterTurns = f.store().getSession(chatId);
  assert.ok(afterTurns && afterTurns.lastActivity > adopted.lastActivity);

  appendFileSync(original.sessionFile, "{}\n");
  assert.match((await f.cli("rollback")).output, /local transcript changed after adoption/);
  assert.deepEqual(f.store().getSession(chatId), afterTurns);
  writeFileSync(original.sessionFile, localBytes);

  const changedWorker = { ...afterTurns, lastActivity: afterTurns.lastActivity + 1 };
  f.wire.receive = frame => {
    if (frame.type === "response" && frame.state?.phase === "ready") {
      f.wire.receive = undefined;
      f.store().setSession(chatId, changedWorker);
    }
  };
  assert.match((await f.cli("rollback")).output, /selected lane changed concurrently/);
  assert.deepEqual(f.store().getSession(chatId), changedWorker);

  const staleWorkerManager = f.manager();
  const unrelatedLater = { ...unrelated, lastActivity: 2 };
  f.wire.receive = frame => {
    if (frame.type === "response" && frame.state?.phase === "ready") staleWriter.setSession("unrelated", unrelatedLater);
  };
  assert.deepEqual(await f.cli("rollback"), { status: 0, output: "Local lane restored.\n" });
  f.wire.receive = undefined;
  assert.deepEqual(f.store().getSession(chatId), { ...changedLocal, workerRollback: true });
  assert.deepEqual(f.store().getSession("unrelated"), unrelatedLater);
  await assert.rejects(ordinaryTurn(staleWorkerManager, "STALE_WORKER_TURN"), /binding changed before this message was submitted/);
  assert.deepEqual(readFileSync(staged), workerBytes);
  assert.deepEqual(readFileSync(original.sessionFile), localBytes);
  const restored = await ordinaryTurn(f.manager(), "LOCAL_RESTORED");
  assert.equal(restored.workspace, "local");
  assert.deepEqual(restored.turns, ["LOCAL_BASE", "LOCAL_RESTORED"]);
  assert.equal(f.store().getSession(chatId)?.sessionId, original.sessionId);
  assert.match((await f.cli("adopt")).output, /not adopted from this controller history/);
  assert.deepEqual(readFileSync(staged), workerBytes);
});

test("scheduled controller entrypoint runs isolated offline worker lanes and owns delivery", { timeout: 45_000 }, async t => {
  const f = fixture(t);
  f.configure(true);
  const delivered: Array<{ chatId: number; text: string; threadId?: number }> = [];
  const terminal: string[] = [];
  const logs: string[] = [];
  const invoke = (prompt: string) => {
    writeFileSync(f.cronsPath, JSON.stringify({ crons: [{
      name: "fixture-cron", schedule: "0 0 * * *", agentId, prompt, deliveryChatId: 102, deliveryThreadId: 12,
    }] }));
    return runCron({
      argv: ["cron", "--task", "fixture-cron"],
      resolveCronAgentData: () => assert.fail("loaded the controller-local Pi profile"),
      runPi: () => assert.fail("spawned controller-local Pi"),
      deliver: (chatId, text, threadId) => { delivered.push({ chatId, text, threadId }); },
      readCronOutboxRecord: () => undefined,
      log: (_task, message) => { logs.push(message); },
      writeCronDiagnosticEvent: () => {},
      writeCronHealthMetric: (_task, _code, outcome) => { terminal.push(outcome); },
      exit: code => { throw new Error("cron exit " + code); },
    });
  };

  await invoke("CRON_FIRST");
  assert.deepEqual(delivered.map(({ chatId, threadId }) => ({ chatId, threadId })), [{ chatId: 102, threadId: 12 }]);
  assert.deepEqual(JSON.parse(delivered[0].text), {
    turns: ["CRON_FIRST"], workspace: "worker", home: "worker-home",
    cronFastOff: true, serviceTier: "default", cronSystemPrompt: true, controllerEnv: false,
  });
  await invoke("CRON_SUPPRESS");
  assert.equal(delivered.length, 1);

  let resultOnWire = false;
  f.wire.receive = (frame, socket) => {
    if (frame.type === "event" && frame.event.type === "result") resultOnWire = true;
    if (frame.type === "finished") { socket.destroy(); return true; }
  };
  await assert.rejects(invoke("CRON_LOST_COMPLETION"), /cron exit 1/);
  assert.ok(resultOnWire);
  assert.equal(delivered.length, 1);
  assert.deepEqual(terminal, ["success", "success", "failure"]);
  assert.ok(logs.some(line => /request may have been accepted/.test(line)));
  const records = f.records();
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map(record => record.binding.sessionId)).size, 3);
  assert.ok(records.every(record => record.laneId.startsWith("cron-") && record.request?.outcome === "settled"));
  assert.equal(f.store().size, 0);
});
