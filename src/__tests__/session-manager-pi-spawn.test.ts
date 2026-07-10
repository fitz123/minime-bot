import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import type { AgentConfig, BotConfig, StreamLine } from "../types.js";
import type { ActiveSession } from "../session-manager.js";
// Real (un-mocked) modules — the SAME singletons session-manager imports, so a
// spy on log.warn and a read of piSessionResumeDiscarded observe its behavior.
import { log } from "../logger.js";
import { piSessionResumeDiscarded, sessionsActive, sessionCrashes } from "../metrics.js";
import { ensureSessionMediaDir, sessionMediaDir, allocateMediaPath, releaseMediaPath } from "../media-store.js";
// Real protocol helpers the spawn-path capture needs (parse get_state replies).
// Resolved here BEFORE mock.module installs the stub, so these are the genuine
// implementations; the stub below re-exports them so capture parses correctly.
import { MINIME_BOT_PI_SESSION_AGENT_ID_ENV, NewlineOnlyJsonlSplitter, normalizePiModel, parsePiRecord, type PiSpawnExtensionOptions, type PiSpawnRuntimeEnvOptions } from "../pi-rpc-protocol.js";
import PQueue from "p-queue";

const TEST_DIR = "/tmp/minime-test-pi-spawn";
const TEST_STORE_PATH = `${TEST_DIR}/sessions.json`;

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Captures + tunables driven by the module mocks below.
// ---------------------------------------------------------------------------

/** Args captured from the mocked Pi spawnPiRpcSession. */
interface PiSpawnCapture {
  agent: AgentConfig;
  resumeSessionId?: string;
  extensionOptions?: PiSpawnExtensionOptions;
  runtimeEnvOptions?: PiSpawnRuntimeEnvOptions;
}

const piSpawnCaptures: PiSpawnCapture[] = [];

/**
 * The session id the mocked readPiStream surfaces from get_state. Set to null to
 * model a Pi process that goes idle without ever emitting a SystemInit record
 * (capture must then fall back to the bot's local id).
 */
let nextPiSessionId: string | null = "pi-generated-id";
let suppressGetStateResponse = false;

/**
 * When set, the mocked sendPiGetState throws this error — models the
 * spawn-then-exit race where the child dies after waitForSpawn resolves but
 * before get_state is written (the real writePiCommand rejects a closed stdin).
 * Capture must swallow it and fall back to the local id, never escaping spawn.
 */
let getStateError: Error | null = null;

/**
 * Optional hook fired with the child whenever the mocked sendPiGetState is
 * invoked — lets a test observe the exact moment a startup is parked inside
 * capturePiSessionId (the window before active.set / store.setSession). Combine
 * with `suppressGetStateResponse = true` to hold the capture open until the test
 * pushes the get_state reply manually.
 */
let onGetState: ((child: ChildProcess) => void) | null = null;

/** Create a mock ChildProcess that auto-emits 'spawn' on next tick. */
function createAutoSpawnChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    pid: Math.floor(Math.random() * 100000),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal?: string) {
      (child as unknown as Record<string, unknown>).killed = true;
      process.nextTick(() => {
        (child as unknown as Record<string, unknown>).exitCode =
          signal === "SIGKILL" ? 137 : 0;
        child.emit("exit", signal === "SIGKILL" ? 137 : 0, signal ?? "SIGTERM");
      });
      return true;
    },
  });

  process.nextTick(() => child.emit("spawn"));

  return child;
}

/**
 * Per-spawn outcomes consumed FIFO by the mocked spawnPiRpcSession. Empty → the
 * default "ok" auto-spawn, so the Task 3 capture/resume tests are unaffected.
 *  - `{ failStderr }` models a Pi process that fails BEFORE 'spawn' (it never
 *    emits 'spawn', exits 1 → waitForSpawn rejects). This is the rare edge path.
 *  - `{ spawnThenExitStderr }` models the REAL `pi` timing for a stale --session:
 *    it execs cleanly (emits 'spawn', so waitForSpawn RESOLVES) and only THEN
 *    exits 1. The resume failure surfaces during the get_state capture, not as a
 *    spawn rejection — the production path the recovery must actually cover.
 *  - `{ spawnThenDelayedExitStderr }` models the narrower window where stderr
 *    already has the stale-resume signal but exitCode is still null when
 *    capture returns no id; the exit state settles shortly after.
 *  - `{ spawnThenDelayedStderrExitStderr }` models stdout closing before the
 *    buffered stderr signal has reached the startup classifier.
 * Both expose their stderr via the same piStartupStderr accessor the real
 * spawnPiRpcSession installs (Pi prints `No session found matching <id>`).
 */
type PiSpawnOutcome =
  | "ok"
  | { failStderr: string }
  | { spawnThenExitStderr: string }
  | { spawnThenDelayedExitStderr: string; delayMs?: number }
  | { spawnThenDelayedStderrExitStderr: string; stderrDelayMs?: number; exitDelayMs?: number };
let piSpawnOutcomes: PiSpawnOutcome[] = [];

/** A Pi child that fails startup (no 'spawn', exit 1) with buffered stderr. */
function createFailingPiChild(failStderr: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    pid: Math.floor(Math.random() * 100000),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill() {
      (child as unknown as Record<string, unknown>).killed = true;
      return true;
    },
  });

  // Mirror spawnPiRpcSession: expose buffered startup stderr so the spawn-failure
  // classifier can match Pi's "No session found matching" signal.
  (child as unknown as { piStartupStderr: () => string }).piStartupStderr = () => failStderr;

  // Fail startup: exit 1, never 'spawn' → waitForSpawn rejects with code=1.
  process.nextTick(() => {
    (child as unknown as Record<string, unknown>).exitCode = 1;
    child.emit("exit", 1, null);
  });

  return child;
}

/**
 * A Pi child that execs successfully (emits 'spawn', so waitForSpawn RESOLVES)
 * and only THEN exits 1 with buffered stderr — the REAL `pi` timing for a stale
 * --session. Node guarantees 'spawn' fires before all other events, so the
 * resume failure does NOT reach the waitForSpawn catch; it surfaces when the
 * get_state capture finds the child already dead. Marked `__resumeFailed` so the
 * mocked readPiStream yields no SystemInit (a dead process emits no records),
 * forcing capture to return null.
 */
function createSpawnThenExitChild(failStderr: string): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    pid: Math.floor(Math.random() * 100000),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill() {
      (child as unknown as Record<string, unknown>).killed = true;
      return true;
    },
  });

  (child as unknown as { piStartupStderr: () => string }).piStartupStderr = () => failStderr;
  (child as unknown as { __resumeFailed: boolean }).__resumeFailed = true;

  // Real timing: 'spawn' fires first (waitForSpawn resolves and drops its exit
  // listener), THEN exit 1. Set exitCode synchronously alongside the spawn emit
  // so hasExited(child) is already true by the time the capture completes.
  process.nextTick(() => {
    child.emit("spawn");
    (child as unknown as Record<string, unknown>).exitCode = 1;
    child.emit("exit", 1, null);
  });

  return child;
}

/**
 * A Pi child that has already buffered the stale-resume stderr signal, returns
 * no session id from get_state, and only reports exit shortly after capture has
 * returned. This reproduces the un-reaped stale-resume window.
 */
function createSpawnThenDelayedExitChild(failStderr: string, delayMs: number = 10): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  const finish = (code: number, signal: string | null) => {
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
    if ((child as ChildProcess).exitCode !== null || (child as ChildProcess).signalCode !== null) return;
    (child as unknown as Record<string, unknown>).exitCode = code;
    (child as unknown as Record<string, unknown>).signalCode = signal;
    child.emit("exit", code, signal);
  };

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    pid: Math.floor(Math.random() * 100000),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal?: string) {
      (child as unknown as Record<string, unknown>).killed = true;
      process.nextTick(() => finish(signal === "SIGKILL" ? 137 : 0, signal ?? "SIGTERM"));
      return true;
    },
  });

  (child as unknown as { piStartupStderr: () => string }).piStartupStderr = () => failStderr;
  (child as unknown as { __closeStdoutOnGetState: boolean }).__closeStdoutOnGetState = true;

  process.nextTick(() => {
    child.emit("spawn");
    exitTimer = setTimeout(() => finish(1, null), delayMs);
  });

  return child;
}

/**
 * A Pi child that closes stdout first, then has the stale-resume stderr signal
 * become visible, then exits. This covers the ordering where stdout capture ends
 * before `spawnPiRpcSession`'s stderr data listener has buffered the classifier
 * signal.
 */
function createSpawnThenDelayedStderrExitChild(
  failStderr: string,
  stderrDelayMs: number = 10,
  exitDelayMs: number = 30,
): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  let stderrBuffer = "";
  let stderrTimer: ReturnType<typeof setTimeout> | null = null;
  let exitTimer: ReturnType<typeof setTimeout> | null = null;
  const clearStderrTimer = () => {
    if (stderrTimer) {
      clearTimeout(stderrTimer);
      stderrTimer = null;
    }
  };
  const clearExitTimer = () => {
    if (exitTimer) {
      clearTimeout(exitTimer);
      exitTimer = null;
    }
  };
  const finish = (code: number, signal: string | null) => {
    clearExitTimer();
    if ((child as ChildProcess).exitCode !== null || (child as ChildProcess).signalCode !== null) return;
    (child as unknown as Record<string, unknown>).exitCode = code;
    (child as unknown as Record<string, unknown>).signalCode = signal;
    child.emit("exit", code, signal);
  };

  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    pid: Math.floor(Math.random() * 100000),
    exitCode: null,
    signalCode: null,
    killed: false,
    kill(signal?: string) {
      (child as unknown as Record<string, unknown>).killed = true;
      clearStderrTimer();
      process.nextTick(() => finish(signal === "SIGKILL" ? 137 : 0, signal ?? "SIGTERM"));
      return true;
    },
  });

  (child as unknown as { piStartupStderr: () => string }).piStartupStderr = () => stderrBuffer;
  (child as unknown as { __closeStdoutOnGetState: boolean }).__closeStdoutOnGetState = true;

  process.nextTick(() => {
    child.emit("spawn");
    stderrTimer = setTimeout(() => {
      stderrBuffer = failStderr;
      stderrTimer = null;
    }, stderrDelayMs);
    exitTimer = setTimeout(() => finish(1, null), exitDelayMs);
  });

  return child;
}

// ---------------------------------------------------------------------------
// Mock the Pi protocol module BEFORE importing session-manager so the mock is
// in place when session-manager's static imports resolve. The spawn path needs
// the REAL session-manager but stubbed protocol fns (mirrors hot-reload.test.ts).
// ---------------------------------------------------------------------------
mock.module("../pi-rpc-protocol.js", {
  namedExports: {
    spawnPiRpcSession(
      agent: AgentConfig,
      resumeSessionId?: string,
      extensionOptions?: PiSpawnExtensionOptions,
      runtimeEnvOptions?: PiSpawnRuntimeEnvOptions,
    ) {
      piSpawnCaptures.push({ agent, resumeSessionId, extensionOptions, runtimeEnvOptions });
      const outcome = piSpawnOutcomes.shift() ?? "ok";
      if (outcome === "ok") return createAutoSpawnChild();
      if ("failStderr" in outcome) return createFailingPiChild(outcome.failStderr);
      if ("spawnThenExitStderr" in outcome) return createSpawnThenExitChild(outcome.spawnThenExitStderr);
      if ("spawnThenDelayedStderrExitStderr" in outcome) {
        return createSpawnThenDelayedStderrExitChild(
          outcome.spawnThenDelayedStderrExitStderr,
          outcome.stderrDelayMs,
          outcome.exitDelayMs,
        );
      }
      return createSpawnThenDelayedExitChild(outcome.spawnThenDelayedExitStderr, outcome.delayMs);
    },
    sendPiGetState(child: ChildProcess) {
      if (getStateError) throw getStateError;
      onGetState?.(child);
      if (suppressGetStateResponse) return;
      // capturePiSessionId reads child.stdout directly (abortable), so model Pi's
      // get_state reply by pushing the real JSONL record onto stdout. `null`
      // models a process that answers without a session id: end the stream so
      // capture returns promptly (close ends the read) instead of timing out.
      const stdout = child.stdout as Readable | undefined;
      if (!stdout) return;
      if ((child as unknown as { __closeStdoutOnGetState?: boolean }).__closeStdoutOnGetState) {
        stdout.push(null);
        return;
      }
      if (nextPiSessionId !== null) {
        stdout.push(
          JSON.stringify({ type: "response", success: true, data: { sessionId: nextPiSessionId } }) + "\n",
        );
      } else {
        stdout.push(null);
      }
    },
    sendPiPrompt() {},
    sendPiSteer() {},
    normalizePiModel,
    async *readPiStream(): AsyncGenerator<StreamLine> {
      // Message-path reader (unused by the spawn-path capture, which now reads
      // child.stdout directly). Present so session-manager's import resolves.
    },
    // Re-export the genuine parse helpers the capture uses.
    NewlineOnlyJsonlSplitter,
    parsePiRecord,
  },
});

const { SessionManager, outboxDir, hasExited } = await import("../session-manager.js");
const { SessionStore } = await import("../session-store.js");

async function crashCount(agentId: string): Promise<number> {
  const metric = await sessionCrashes.get();
  const entry = metric.values.find((v) => v.labels.agent_id === agentId);
  return entry?.value ?? 0;
}

async function discardedCount(agentId: string): Promise<number> {
  const metric = await piSessionResumeDiscarded.get();
  const entry = metric.values.find((v) => v.labels.agent_id === agentId);
  return entry?.value ?? 0;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    telegramToken: "test-token",
    agents: {
      main: {
        id: "main",
        workspaceCwd: "/tmp/test-workspace",
        model: "gpt-5.5",
      },
      pi: {
        id: "pi",
        workspaceCwd: "/tmp/test-workspace-pi",
        model: "gpt-5.5",
        provider: "pi",
        thinking: "xhigh",
      },
    },
    bindings: [
      { chatId: 123, agentId: "main", kind: "dm" as const },
      { chatId: 456, agentId: "pi", kind: "dm" as const },
    ],
    sessionDefaults: {
      idleTimeoutMs: 60_000,
      maxConcurrentSessions: 5,
      maxMessageAgeMs: 300_000,
      requireMention: false,
      maxMediaBytes: 209715200,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager Pi session-id capture + resume", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = "pi-generated-id";
    suppressGetStateResponse = false;
    getStateError = null;
    onGetState = null;
  });

  afterEach(() => {
    cleanup();
    onGetState = null;
  });

  it("captures the Pi-minted session id via get_state and persists it", async () => {
    nextPiSessionId = "pi-generated-id";
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    const session = await manager.getOrCreateSession("pi-chat", "pi");

    // A fresh Pi spawn must NOT pass --session (no resume id).
    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, undefined, "fresh start: no resume id");

    // The in-memory session adopts the Pi-minted id (not the local UUID).
    assert.strictEqual(session.sessionId, "pi-generated-id", "session uses the captured Pi id");
    assert.strictEqual(session.provider, "pi");
    assert.strictEqual(session.model, "openai-codex/gpt-5.5");
    assert.strictEqual(session.thinking, "xhigh");
    assert.strictEqual(session.outboxPath, outboxDir("pi-chat"));
    assert.ok(!session.outboxPath.startsWith("/tmp/bot-outbox"));
    assert.strictEqual(statSync(dirname(session.outboxPath)).mode & 0o777, 0o700);
    assert.strictEqual(statSync(session.outboxPath).mode & 0o777, 0o700);

    const health = manager.getSessionHealth("pi-chat");
    assert.ok(health);
    assert.strictEqual(health.provider, "pi");
    assert.strictEqual(health.model, "openai-codex/gpt-5.5");
    assert.strictEqual(health.thinking, "xhigh");

    // ...and the captured id is persisted for resume across restarts.
    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      store.getSession("pi-chat")?.sessionId,
      "pi-generated-id",
      "captured Pi id is persisted to the store",
    );

    await manager.closeAll();
  });

  it("does not reuse an active Pi session whose stdout was destroyed", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const first = await manager.getOrCreateSession("pi-closed-stdout", "pi");
    const firstChild = first.child;

    firstChild.stdout?.destroy();
    (firstChild as unknown as { killed: boolean }).killed = false;

    const second = await manager.getOrCreateSession("pi-closed-stdout", "pi");

    assert.notStrictEqual(second.child, firstChild, "closed stdout child must not be reused");
    assert.strictEqual(piSpawnCaptures.length, 2, "a replacement Pi child is spawned");
    assert.strictEqual(firstChild.killed, true, "closed stdout child is terminated during replacement");

    await manager.closeAll();
  });

  it("terminates the spawned child if outbox setup fails before active registration", async () => {
    let capturedChild: ChildProcess | null = null;
    onGetState = (child) => {
      capturedChild = child;
    };
    nextPiSessionId = "pi-generated-id";

    const originalWorkspaceRoot = process.env.MINIME_CONTROL_WORKSPACE_ROOT;
    const badCwd = `${TEST_DIR}/bad-runtime-cwd`;
    mkdirSync(badCwd, { recursive: true });
    writeFileSync(`${badCwd}/.tmp`, "not a directory");

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    try {
      process.env.MINIME_CONTROL_WORKSPACE_ROOT = badCwd;
      await assert.rejects(
        () => manager.getOrCreateSession("pi-outbox-fail", "pi"),
        /not a directory/,
        "outbox setup failure should reject startup",
      );
    } finally {
      if (originalWorkspaceRoot === undefined) {
        delete process.env.MINIME_CONTROL_WORKSPACE_ROOT;
      } else {
        process.env.MINIME_CONTROL_WORKSPACE_ROOT = originalWorkspaceRoot;
      }
    }

    assert.ok(capturedChild, "child reached get_state before outbox setup failed");
    assert.strictEqual((capturedChild as ChildProcess).killed, true, "child is terminated when outbox setup fails");
    assert.strictEqual(hasExited(capturedChild as ChildProcess), true, "child is reaped when outbox setup fails");
    assert.strictEqual(manager.getActive("pi-outbox-fail"), undefined, "failed startup is not registered active");

    await manager.closeAll();
  });

  it("passes top-level piExtraExtensions to interactive Pi spawns", async () => {
    const extraExtensions = ["/approved/interactive-a.ts", "/approved/interactive-b.ts"];
    const manager = new SessionManager(() => makeConfig({ piExtraExtensions: extraExtensions }), TEST_STORE_PATH);

    await manager.getOrCreateSession("pi-extra", "pi");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.deepStrictEqual(piSpawnCaptures[0].extensionOptions, { extraExtensions });
    assert.ok(!("piExtraExtensions" in piSpawnCaptures[0].agent));

    await manager.closeAll();
  });

  it("passes the trusted ask-agent caller id from the requested session agent", async () => {
    const oldCaller = process.env[MINIME_BOT_PI_SESSION_AGENT_ID_ENV];
    process.env[MINIME_BOT_PI_SESSION_AGENT_ID_ENV] = "ambient-agent";
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    try {
      await manager.getOrCreateSession("pi-caller", "pi");

      assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
      assert.strictEqual(piSpawnCaptures[0].agent.id, "pi");
      assert.deepStrictEqual(piSpawnCaptures[0].runtimeEnvOptions, { askCallerAgentId: "pi" });
    } finally {
      if (oldCaller === undefined) {
        delete process.env[MINIME_BOT_PI_SESSION_AGENT_ID_ENV];
      } else {
        process.env[MINIME_BOT_PI_SESSION_AGENT_ID_ENV] = oldCaller;
      }
      await manager.closeAll();
    }
  });

  it("resumes a stored Pi session by spawning with the stored id as --session", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-resume", {
      sessionId: "stored-pi-id",
      chatId: "pi-resume",
      agentId: "pi",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      thinking: "xhigh",
      lastActivity: Date.now(),
    });
    // On resume, Pi re-confirms the same id through get_state.
    nextPiSessionId = "stored-pi-id";

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-resume", "pi");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(
      piSpawnCaptures[0].resumeSessionId,
      "stored-pi-id",
      "resume passes the stored Pi id as --session",
    );
    assert.strictEqual(session.sessionId, "stored-pi-id", "resumed session keeps its id");

    await manager.closeAll();
  });

  it("resumes stored Pi sessions with the current configured model after a model change", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-model-change", {
      sessionId: "stored-model-change-id",
      chatId: "pi-model-change",
      agentId: "pi",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      thinking: "xhigh",
      lastActivity: Date.now(),
    });
    nextPiSessionId = "stored-model-change-id";

    const updatedConfig = makeConfig({
      agents: {
        ...makeConfig().agents,
        pi: {
          ...makeConfig().agents.pi,
          model: "gpt-5.6-sol",
        },
      },
    });
    const manager = new SessionManager(() => updatedConfig, TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-model-change", "pi");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-model-change-id");
    assert.strictEqual(piSpawnCaptures[0].agent.model, "gpt-5.6-sol");
    assert.strictEqual(session.sessionId, "stored-model-change-id", "context-preserving resume keeps the id");
    assert.strictEqual(session.model, "openai-codex/gpt-5.6-sol", "active session records current model");

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-model-change")?.model, "openai-codex/gpt-5.6-sol");

    await manager.closeAll();
  });

  it("falls back to the bot's local id when get_state surfaces no session id", async () => {
    nextPiSessionId = null; // process goes idle without a SystemInit record

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-noid", "pi");

    // The session stays functional on its locally-generated id (resume just
    // can't target it; Task 4 recovery handles a later "No session found").
    assert.ok(session.sessionId.length > 0, "session keeps a usable local id");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, undefined, "fresh start: no resume id");

    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      store.getSession("pi-noid")?.sessionId,
      session.sessionId,
      "the local id is persisted",
    );

    await manager.closeAll();
  });

  it("falls back to the bot's local id when get_state capture times out on an idle child", async () => {
    suppressGetStateResponse = true;

    const manager = new SessionManager(
      () => makeConfig(),
      TEST_STORE_PATH,
      undefined,
      { startupTimeoutMs: 20 },
    );
    const session = await manager.getOrCreateSession("pi-timeout", "pi");

    assert.ok(session.sessionId.length > 0, "session keeps a usable local id");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, undefined, "fresh start: no resume id");

    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      store.getSession("pi-timeout")?.sessionId,
      session.sessionId,
      "the local id is persisted after capture timeout",
    );

    await manager.closeAll();
  });

  it("get_state throwing (child died right after spawn) falls back to the local id, not an uncaught throw", async () => {
    // Spawn succeeds (waitForSpawn resolves on 'spawn'), but the child dies before
    // get_state is written, so sendPiGetState throws — the spawn-then-exit race.
    getStateError = new Error("Pi RPC child process is not available");

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    // getOrCreateSession must NOT reject: capture swallows the throw and the
    // session falls back to the bot's local id.
    const session = await manager.getOrCreateSession("pi-getstate-fail", "pi");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn, no recovery loop");
    assert.ok(session.sessionId.length > 0, "session keeps a usable local id");

    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(
      store.getSession("pi-getstate-fail")?.sessionId,
      session.sessionId,
      "the local id is persisted",
    );

    await manager.closeAll();
  });

  it("spawns an absent-provider agent via Pi and captures its Pi session id", async () => {
    nextPiSessionId = "main-pi-id";
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("main-chat", "main");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(piSpawnCaptures[0].agent.id, "main");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, undefined);
    assert.strictEqual(session.sessionId, "main-pi-id");
    assert.strictEqual(session.provider, "pi");
    assert.strictEqual(session.model, "openai-codex/gpt-5.5");
    assert.strictEqual(session.thinking, undefined);

    await manager.closeAll();
  });

  it("rotates a live active session when the requested agent changes", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    nextPiSessionId = "main-live-id";
    const oldSession = await manager.getOrCreateSession("agent-switch", "main");

    const inflightPath = allocateMediaPath("agent-switch", "photo", ".jpg");
    writeFileSync(inflightPath, "current turn media");
    const stalePath = `${sessionMediaDir("agent-switch")}/prior-agent.jpg`;
    writeFileSync(stalePath, "stale prior agent media");

    nextPiSessionId = "pi-live-id";
    const newSession = await manager.getOrCreateSession("agent-switch", "pi");

    assert.notStrictEqual(newSession, oldSession, "agent switch must not reuse the old active session");
    assert.strictEqual(oldSession.child.killed, true, "old agent child should be terminated");
    assert.strictEqual(newSession.agentId, "pi");
    assert.strictEqual(newSession.sessionId, "pi-live-id");
    assert.strictEqual(piSpawnCaptures.length, 2, "old agent spawn + new agent spawn");
    assert.strictEqual(piSpawnCaptures[1].agent.id, "pi");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "new agent starts fresh");

    const store = new SessionStore(TEST_STORE_PATH);
    assert.deepEqual(store.getSession("agent-switch"), {
      sessionId: "pi-live-id",
      chatId: "agent-switch",
      agentId: "pi",
      provider: "pi",
      model: "openai-codex/gpt-5.5",
      thinking: "xhigh",
      lastActivity: newSession.lastActivity,
    });
    assert.ok(existsSync(inflightPath), "current-turn in-flight media survives active agent rotation");
    assert.strictEqual(existsSync(stalePath), false, "prior-agent media is purged on active agent rotation");

    releaseMediaPath(inflightPath);
    await manager.closeAll();
  });
});

describe("SessionManager Pi graceful resume-recovery (Task 4)", () => {
  /** Current value of the discard metric for an agent (0 if never set). */
  async function discardedCount(agentId: string): Promise<number> {
    const metric = await piSessionResumeDiscarded.get();
    const entry = metric.values.find((v) => v.labels.agent_id === agentId);
    return entry?.value ?? 0;
  }

  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = "pi-generated-id";
    getStateError = null;
    // The media-preserved assertions write into the test media root; clear each
    // chat's dir between runs so a prior run's file can't mask a regression.
    try { rmSync(sessionMediaDir("pi-keep"), { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(sessionMediaDir("pi-inflight"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    cleanup();
    try { rmSync(sessionMediaDir("pi-keep"), { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(sessionMediaDir("pi-inflight"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("missing-session signal: discards once, warns once, increments metric, then starts fresh", async () => {
    const extraExtensions = ["/approved/recovery-a.ts", "/approved/recovery-b.ts"];
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-stale", {
      sessionId: "stored-pi-id",
      chatId: "pi-stale",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // The resume spawn fails with Pi's "No session found" signal; the inline
    // fresh re-spawn then succeeds and get_state mints a new id.
    piSpawnOutcomes = [{ failStderr: "No session found matching stored-pi-id" }];
    nextPiSessionId = "fresh-pi-id";

    const before = await discardedCount("pi");
    const crashesBefore = await crashCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig({ piExtraExtensions: extraExtensions }), TEST_STORE_PATH);
    let session;
    try {
      session = await manager.getOrCreateSession("pi-stale", "pi");
    } finally {
      warnSpy.mock.restore();
    }

    // Exactly two spawns: the failed resume, then ONE inline fresh start.
    assert.strictEqual(piSpawnCaptures.length, 2, "resume spawn + one inline fresh re-spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "first spawn resumed the stored id");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn starts fresh (no --session)");
    assert.deepStrictEqual(
      piSpawnCaptures.map((capture) => capture.extensionOptions),
      [{ extraExtensions }, { extraExtensions }],
      "recovery retry keeps the configured extra extensions",
    );

    // The recovered session is live on the freshly-captured id, and it's persisted.
    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered session adopts the new Pi id");
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-stale")?.sessionId, "fresh-pi-id", "fresh id persisted");

    // Exactly one discard warning + one metric increment.
    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session stored-pi-id — starting fresh"),
    );
    assert.strictEqual(recoveryWarns.length, 1, "exactly one recovery warning");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "metric incremented exactly once");
    assert.strictEqual(
      await crashCount("pi"),
      crashesBefore,
      "resume-recovery does not increment bot_session_crashes_total",
    );

    await manager.closeAll();
  });

  it("resume-recovery preserves the current turn's in-flight media while discarding the stored id", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-inflight", {
      sessionId: "stored-pi-id",
      chatId: "pi-inflight",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // The triggering turn already staged a media file under this chat's dir and
    // it is tracked as in-flight (allocateMediaPath registers it). The fresh Pi
    // session's prompt will reference this path, so recovery must NOT delete it.
    const inflightPath = allocateMediaPath("pi-inflight", "photo", ".jpg");
    writeFileSync(inflightPath, "current turn media");
    // A leftover from the prior (now-unresumable) session — NOT in-flight. This
    // SHOULD be swept by the stale cleanup.
    const stalePath = `${sessionMediaDir("pi-inflight")}/prior-session.jpg`;
    writeFileSync(stalePath, "stale leftover");

    // Resume fails with the "No session found" signal → recovery fires; the
    // inline fresh re-spawn then succeeds.
    piSpawnOutcomes = [{ failStderr: "No session found matching stored-pi-id" }];
    nextPiSessionId = "fresh-pi-id";

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const warnSpy = mock.method(log, "warn", () => {});
    let session;
    try {
      session = await manager.getOrCreateSession("pi-inflight", "pi");
    } finally {
      warnSpy.mock.restore();
    }

    // Recovery happened: fresh id adopted, stored id discarded (then re-persisted
    // with the fresh id by the successful spawn).
    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered onto the fresh id");

    // The in-flight file for the current turn SURVIVES (the bug fix): the fresh
    // Pi session's prompt can still reach it.
    assert.ok(existsSync(inflightPath), "in-flight media for the current turn is preserved across recovery");
    // The prior-session leftover is swept (it was not in-flight).
    assert.strictEqual(existsSync(stalePath), false, "prior-session media leftover is removed");

    releaseMediaPath(inflightPath);
    await manager.closeAll();
  });

  it("both spawns fail: discards once, warns once, then throws — no loop", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-doomed", {
      sessionId: "stored-pi-id",
      chatId: "pi-doomed",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // Resume fails with the signal; the inline fresh re-spawn ALSO fails. The
    // second failure must propagate (no third spawn, no recursion).
    piSpawnOutcomes = [
      { failStderr: "No session found matching stored-pi-id" },
      { failStderr: "still broken on the fresh start" },
    ];

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    try {
      await assert.rejects(
        () => manager.getOrCreateSession("pi-doomed", "pi"),
        /exited during startup/,
        "the second (fresh) failure propagates as a startup error",
      );
    } finally {
      warnSpy.mock.restore();
    }

    // At-most-once: exactly two spawn attempts (resume + one fresh), no loop.
    assert.strictEqual(piSpawnCaptures.length, 2, "exactly two spawns — recovery does not loop");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn was a fresh start");

    // The discard + warn + metric ran exactly once despite the fresh start failing.
    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session stored-pi-id — starting fresh"),
    );
    assert.strictEqual(recoveryWarns.length, 1, "exactly one recovery warning");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "metric incremented exactly once");

    // The final failure feeds the normal crash backoff (restart count increments).
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("pi-doomed"), 1, "second failure increments the crash count");
  });

  it("preserves an accumulated crash count across a resume-recovery discard", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-flap", {
      sessionId: "stored-pi-id",
      chatId: "pi-flap",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // Resume fails with the signal; the inline fresh re-spawn then succeeds.
    piSpawnOutcomes = [{ failStderr: "No session found matching stored-pi-id" }];
    nextPiSessionId = "fresh-pi-id";

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    // Seed a prior crash history. The recovery discard routes through
    // destroySession → closeSession, which clears restartCounts; the fix must
    // restore the count so a flapping chat keeps advancing toward the circuit
    // breaker instead of resetting to zero on every recovery. (prevCrashCount=1
    // triggers a ~5s crash backoff before the spawn — expected.)
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    restartCounts.set("pi-flap", 1);

    const warnSpy = mock.method(log, "warn", () => {});
    let session;
    try {
      session = await manager.getOrCreateSession("pi-flap", "pi");
    } finally {
      warnSpy.mock.restore();
    }

    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered onto the fresh id");
    assert.strictEqual(
      restartCounts.get("pi-flap"),
      1,
      "prior crash count survives the recovery discard (not reset to 0)",
    );

    await manager.closeAll();
  });

  it("non-matching startup failure: no discard, stored id + media preserved, normal backoff", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-keep", {
      sessionId: "keep-pi-id",
      chatId: "pi-keep",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // A media file from a prior turn — a non-recovery failure must preserve it so
    // a later successful resume can still reference it.
    const mediaDir = ensureSessionMediaDir("pi-keep");
    const mediaFile = `${mediaDir}/prior-turn.jpg`;
    writeFileSync(mediaFile, "keep me");

    // Resume fails, but NOT with the "No session found" signal → no recovery.
    piSpawnOutcomes = [{ failStderr: "codex: authentication token expired" }];

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    try {
      await assert.rejects(
        () => manager.getOrCreateSession("pi-keep", "pi"),
        /exited during startup/,
        "a non-matching failure propagates unchanged",
      );
    } finally {
      warnSpy.mock.restore();
    }

    // Exactly one spawn — no inline recovery re-spawn.
    assert.strictEqual(piSpawnCaptures.length, 1, "no recovery spawn for a non-matching failure");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "keep-pi-id", "the resume attempt used the stored id");

    // No discard: stored id preserved (NOT deleted), media dir preserved.
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-keep")?.sessionId, "keep-pi-id", "stored id preserved");
    assert.ok(existsSync(mediaFile), "media file preserved on a non-recovery failure");

    // No recovery warning, metric untouched.
    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session"),
    );
    assert.strictEqual(recoveryWarns.length, 0, "no recovery warning for a non-matching failure");
    assert.strictEqual((await discardedCount("pi")) - before, 0, "metric not incremented");

    // Existing crash backoff still applies.
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("pi-keep"), 1, "non-matching failure increments the crash count");
  });

  // The tests above drive failure via createFailingPiChild, which never emits
  // 'spawn' — an edge that a real exec'd binary cannot produce. The tests below
  // use createSpawnThenExitChild, which mirrors REAL `pi` timing: it execs
  // (emits 'spawn', so waitForSpawn RESOLVES) and only THEN exits 1. This is the
  // production path the recovery must cover — the failure surfaces during the
  // get_state capture, not as a spawn rejection.

  it("real pi timing (spawn then exit 1 with the signal): recovery still fires", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-real", {
      sessionId: "stored-pi-id",
      chatId: "pi-real",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // The resume spawn execs then exits 1 with the signal (real timing); the
    // inline fresh re-spawn then succeeds and get_state mints a new id.
    piSpawnOutcomes = [{ spawnThenExitStderr: "No session found matching stored-pi-id" }];
    nextPiSessionId = "fresh-pi-id";

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    let session;
    try {
      session = await manager.getOrCreateSession("pi-real", "pi");
    } finally {
      warnSpy.mock.restore();
    }

    // Exactly two spawns: the failed resume, then ONE inline fresh start — even
    // though waitForSpawn RESOLVED for the failed resume (this is the bug fix).
    assert.strictEqual(piSpawnCaptures.length, 2, "resume spawn + one inline fresh re-spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "first spawn resumed the stored id");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn starts fresh (no --session)");

    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered session adopts the new Pi id");
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-real")?.sessionId, "fresh-pi-id", "fresh id persisted");

    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session stored-pi-id — starting fresh"),
    );
    assert.strictEqual(recoveryWarns.length, 1, "exactly one recovery warning");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "metric incremented exactly once");

    await manager.closeAll();
  });

  it("un-reaped stale resume window: waits for exitCode to settle, then recovers fresh", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-unreaped", {
      sessionId: "stored-pi-id",
      chatId: "pi-unreaped",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // The resume child has already buffered Pi's stale-session stderr, but
    // get_state closes stdout with no id while exitCode is still null. It exits
    // shortly after, inside the bounded settle wait; the inline fresh re-spawn
    // then succeeds.
    piSpawnOutcomes = [
      { spawnThenDelayedExitStderr: "No session found matching stored-pi-id", delayMs: 20 },
    ];
    nextPiSessionId = "fresh-pi-id";

    const before = await discardedCount("pi");
    const crashesBefore = await crashCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    let session;
    try {
      session = await manager.getOrCreateSession("pi-unreaped", "pi");
    } finally {
      warnSpy.mock.restore();
    }

    assert.strictEqual(piSpawnCaptures.length, 2, "resume spawn + one inline fresh re-spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "first spawn resumed the stored id");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn starts fresh (no --session)");
    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered session adopts the new Pi id");

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-unreaped")?.sessionId, "fresh-pi-id", "fresh id persisted");

    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session stored-pi-id — starting fresh"),
    );
    assert.strictEqual(recoveryWarns.length, 1, "exactly one recovery warning");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "metric incremented exactly once");
    assert.strictEqual(
      await crashCount("pi"),
      crashesBefore,
      "un-reaped resume-recovery does not increment bot_session_crashes_total",
    );

    await manager.closeAll();
  });

  it("delayed stale resume stderr is recovered instead of becoming an active local-id session", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-delayed-stderr", {
      sessionId: "stored-pi-id",
      chatId: "pi-delayed-stderr",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // stdout closes with no id before the stderr listener has buffered Pi's
    // stale-session message. Startup must briefly wait before deciding whether
    // the resumed child is safe to keep as a local-id session.
    piSpawnOutcomes = [
      {
        spawnThenDelayedStderrExitStderr: "No session found matching stored-pi-id",
        stderrDelayMs: 5,
        exitDelayMs: 20,
      },
    ];
    nextPiSessionId = "fresh-pi-id";

    const before = await discardedCount("pi");
    const crashesBefore = await crashCount("pi");
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-delayed-stderr", "pi");

    assert.strictEqual(piSpawnCaptures.length, 2, "resume spawn + one inline fresh re-spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "first spawn resumed the stored id");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn starts fresh");
    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered session adopts the fresh Pi id");

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-delayed-stderr")?.sessionId, "fresh-pi-id", "fresh id persisted");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "resume discard metric incremented once");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "delayed stderr recovery is not a crash");

    await manager.closeAll();
  });

  it("exit-before-stderr stale resume signal is still recovered fresh", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-exit-before-stderr", {
      sessionId: "stored-pi-id",
      chatId: "pi-exit-before-stderr",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // Node can observe process exit before the stderr data listener has appended
    // the stale-session message. The settle wait must not treat exit alone as
    // final while the bounded stderr window is still open.
    piSpawnOutcomes = [
      {
        spawnThenDelayedStderrExitStderr: "No session found matching stored-pi-id",
        stderrDelayMs: 20,
        exitDelayMs: 5,
      },
    ];
    nextPiSessionId = "fresh-pi-id";

    const before = await discardedCount("pi");
    const crashesBefore = await crashCount("pi");
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-exit-before-stderr", "pi");

    assert.strictEqual(piSpawnCaptures.length, 2, "resume spawn + one inline fresh re-spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "first spawn resumed the stored id");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn starts fresh");
    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered session adopts the fresh Pi id");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "resume discard metric incremented once");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "exit-before-stderr recovery is not a crash");

    await manager.closeAll();
  });

  it("slow stale resume signal is still recovered instead of becoming an active local-id session", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-slow-stale", {
      sessionId: "stored-pi-id",
      chatId: "pi-slow-stale",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // The stale-resume signal is already buffered, but the child would not report
    // exit until after the bounded settle wait. The signal is still decisive: the
    // failed resume is killed/reaped and the existing fresh-start recovery fires.
    piSpawnOutcomes = [
      { spawnThenDelayedExitStderr: "No session found matching stored-pi-id", delayMs: 1_000 },
    ];
    nextPiSessionId = "fresh-pi-id";

    const before = await discardedCount("pi");
    const crashesBefore = await crashCount("pi");
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-slow-stale", "pi");

    assert.strictEqual(piSpawnCaptures.length, 2, "slow stale resume still triggers one fresh recovery spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "first spawn resumed the stored id");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "recovery spawn starts fresh");
    assert.strictEqual(session.sessionId, "fresh-pi-id", "recovered session adopts the fresh Pi id");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "resume discard metric incremented once");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "slow stale-resume recovery is not a crash");

    await manager.closeAll();
  });

  it("real pi timing (spawn then exit 1 with a non-matching error): no discard, crash count increments", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-real-keep", {
      sessionId: "keep-pi-id",
      chatId: "pi-real-keep",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    // Execs then exits 1, but NOT with the "No session found" signal → no recovery.
    piSpawnOutcomes = [{ spawnThenExitStderr: "codex: authentication token expired" }];

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    try {
      await assert.rejects(
        () => manager.getOrCreateSession("pi-real-keep", "pi"),
        /exited during startup/,
        "a non-matching post-spawn exit propagates as a startup error",
      );
    } finally {
      warnSpy.mock.restore();
    }

    // Exactly one spawn — no inline recovery re-spawn.
    assert.strictEqual(piSpawnCaptures.length, 1, "no recovery spawn for a non-matching failure");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "keep-pi-id", "the resume attempt used the stored id");

    // No discard: stored id preserved.
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-real-keep")?.sessionId, "keep-pi-id", "stored id preserved");

    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not resume Pi session"),
    );
    assert.strictEqual(recoveryWarns.length, 0, "no recovery warning for a non-matching failure");
    assert.strictEqual((await discardedCount("pi")) - before, 0, "metric not incremented");

    // A post-spawn startup exit must still feed crash backoff (the bug fix also
    // closes the gap where a spawned-then-died child created a session with no
    // crash count and could tight-loop).
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("pi-real-keep"), 1, "post-spawn startup exit increments the crash count");
  });
});

describe("SessionManager /clean in-flight startup race (Task 1)", () => {
  /** Current sessionsActive gauge value (0 if unset). */
  async function activeGauge(): Promise<number> {
    const metric = await sessionsActive.get();
    return metric.values[0]?.value ?? 0;
  }

  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = "pi-generated-id";
    suppressGetStateResponse = false;
    getStateError = null;
    onGetState = null;
  });

  afterEach(() => {
    cleanup();
    onGetState = null;
  });

  it("destroySession during in-flight startup supersedes it: no store entry, child reaped, no active session", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    // Park the startup inside capturePiSessionId: get_state is invoked but no
    // reply is pushed, so getOrCreateSession is suspended awaiting the Pi-minted
    // id — the exact window BEFORE active.set(...) / store.setSession(...).
    suppressGetStateResponse = true;
    let capturedChild: ChildProcess | null = null;
    let signalCaptureStarted: (() => void) | null = null;
    const captureStarted = new Promise<void>((resolve) => { signalCaptureStarted = resolve; });
    onGetState = (child) => {
      capturedChild = child;
      signalCaptureStarted?.();
    };

    const before = await activeGauge();
    const crashesBefore = await crashCount("pi");

    // Start the spawn but do NOT await — it must remain parked mid-capture.
    const startup = manager.getOrCreateSession("clean-race", "pi");
    // Consume the expected supersede rejection here so the floating promise never
    // surfaces as an unhandled rejection before we assert on the outcome.
    const settled = startup.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );

    // Wait until the startup is genuinely parked in the capture window.
    await captureStarted;

    // /clean lands while the startup is in flight and not yet in `active`.
    await manager.destroySession("clean-race");

    // Release the parked capture so the startup resumes and reaches the guard.
    assert.ok(capturedChild, "get_state was invoked during startup");
    (capturedChild as ChildProcess).stdout!.push(
      JSON.stringify({ type: "response", success: true, data: { sessionId: "pi-generated-id" } }) + "\n",
    );

    const result = await settled;
    assert.strictEqual(result.ok, false, "a superseded startup must not resolve a session");
    if (!result.ok) {
      assert.match(result.err.message, /superseded/, "startup fails with the supersede signal");
    }

    // No stale store entry survives the clean (the in-flight startup did not
    // re-persist state after destroySession deleted it).
    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(store.getSession("clean-race"), undefined, "no stale store entry after clean");

    // The superseded child was terminated/reaped.
    assert.strictEqual((capturedChild as ChildProcess).killed, true, "superseded startup child is terminated");
    assert.strictEqual(hasExited(capturedChild as ChildProcess), true, "superseded startup child is reaped before rejection");

    // No active session and no net sessionsActive increment from the superseded startup.
    assert.strictEqual(manager.getActive("clean-race"), undefined, "no active session for the superseded startup");
    assert.strictEqual(manager.getActiveCount(), 0, "no active sessions remain");
    assert.strictEqual(await activeGauge(), before, "sessionsActive not incremented by the superseded startup");
    assert.strictEqual(
      await crashCount("pi"),
      crashesBefore,
      "superseded startup does not increment bot_session_crashes_total",
    );
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("clean-race") ?? 0, 0, "superseded startup does not increment restartCounts");

    await manager.closeAll();
  });

  it("post-clean startup waits for active teardown before reusing shared resources", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const chatId = "active-clean-race";
    const oldOutbox = outboxDir(chatId);
    mkdirSync(oldOutbox, { recursive: true });
    const oldMediaDir = ensureSessionMediaDir(chatId);
    writeFileSync(`${oldMediaDir}/old-media.jpg`, "old media");

    let signalKillCalled: (() => void) | null = null;
    const killCalled = new Promise<void>((resolve) => { signalKillCalled = resolve; });
    let releaseExit: () => void = () => { throw new Error("kill was not called"); };
    const oldChild = new EventEmitter() as unknown as ChildProcess;
    Object.assign(oldChild, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
      pid: 99997,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: NodeJS.Signals | number) {
        (oldChild as unknown as Record<string, unknown>).killed = true;
        signalKillCalled?.();
        releaseExit = () => {
          if ((oldChild as ChildProcess).exitCode !== null || (oldChild as ChildProcess).signalCode !== null) return;
          const code = signal === "SIGKILL" ? 137 : 0;
          const signalCode = typeof signal === "string" ? signal : "SIGTERM";
          (oldChild as unknown as Record<string, unknown>).exitCode = code;
          (oldChild as unknown as Record<string, unknown>).signalCode = signalCode;
          oldChild.emit("exit", code, signalCode);
        };
        return true;
      },
    });

    const fakeSession: ActiveSession = {
      child: oldChild,
      sessionId: "old-sid",
      agentId: "pi",
      provider: "pi",
      model: "gpt-5.5",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 100000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: oldOutbox,
    };
    (manager as unknown as { active: Map<string, ActiveSession> }).active.set(chatId, fakeSession);
    sessionsActive.inc();

    const destroyPromise = manager.destroySession(chatId);
    await killCalled;

    const lateOutboxFile = `${oldOutbox}/late-old-output.txt`;
    mkdirSync(dirname(lateOutboxFile), { recursive: true });
    writeFileSync(lateOutboxFile, "late old outbox");
    const lateMediaFile = `${ensureSessionMediaDir(chatId)}/late-old-media.jpg`;
    writeFileSync(lateMediaFile, "late old media");

    nextPiSessionId = "new-pi-id";
    let startupDone = false;
    const startupPromise = manager.getOrCreateSession(chatId, "pi").then((session) => {
      startupDone = true;
      return session;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.strictEqual(startupDone, false, "fresh startup is blocked behind active teardown");
    assert.strictEqual(piSpawnCaptures.length, 0, "fresh Pi child is not spawned while old child can still write");

    releaseExit();
    await destroyPromise;
    const newSession = await startupPromise;

    assert.strictEqual(newSession.sessionId, "new-pi-id", "fresh post-clean startup owns the session");
    assert.strictEqual(piSpawnCaptures.length, 1, "fresh Pi child spawns only after active teardown");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, undefined, "post-clean startup starts fresh");
    assert.ok(!existsSync(lateOutboxFile), "late old outbox output is removed before resource reuse");
    assert.ok(!existsSync(lateMediaFile), "late old media is removed before resource reuse");
    assert.strictEqual(manager.getActive(chatId), newSession, "new session remains active");

    await manager.closeAll();
  });

  it("startup that began before clean is superseded after waiting for prior teardown", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const chatId = "preclean-teardown-race";
    const oldOutbox = outboxDir(chatId);
    mkdirSync(oldOutbox, { recursive: true });

    let signalKillCalled: (() => void) | null = null;
    const killCalled = new Promise<void>((resolve) => { signalKillCalled = resolve; });
    let releaseExit: () => void = () => { throw new Error("kill was not called"); };
    const oldChild = new EventEmitter() as unknown as ChildProcess;
    Object.assign(oldChild, {
      stdout: new Readable({ read() {} }),
      stderr: new Readable({ read() {} }),
      stdin: new Writable({ write(_chunk, _enc, cb) { cb(); } }),
      pid: 99996,
      exitCode: null,
      signalCode: null,
      killed: false,
      kill(signal?: NodeJS.Signals | number) {
        (oldChild as unknown as Record<string, unknown>).killed = true;
        signalKillCalled?.();
        releaseExit = () => {
          if ((oldChild as ChildProcess).exitCode !== null || (oldChild as ChildProcess).signalCode !== null) return;
          const code = signal === "SIGKILL" ? 137 : 0;
          const signalCode = typeof signal === "string" ? signal : "SIGTERM";
          (oldChild as unknown as Record<string, unknown>).exitCode = code;
          (oldChild as unknown as Record<string, unknown>).signalCode = signalCode;
          oldChild.emit("exit", code, signalCode);
        };
        return true;
      },
    });

    const fakeSession: ActiveSession = {
      child: oldChild,
      sessionId: "old-sid",
      agentId: "pi",
      provider: "pi",
      model: "gpt-5.5",
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: 100000,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount: 0,
      outboxPath: oldOutbox,
    };
    (manager as unknown as { active: Map<string, ActiveSession> }).active.set(chatId, fakeSession);
    const before = await activeGauge();
    sessionsActive.inc();

    const priorTeardown = manager.closeSession(chatId, { persist: false });
    await killCalled;

    const oldStartup = manager.getOrCreateSession(chatId, "pi");
    const oldSettled = oldStartup.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );
    assert.strictEqual(piSpawnCaptures.length, 0, "startup waits behind the prior teardown before spawning");

    const clean = manager.destroySession(chatId);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(piSpawnCaptures.length, 0, "startup remains blocked while clean is chained behind teardown");

    releaseExit();
    await priorTeardown;
    await clean;

    const result = await oldSettled;
    assert.strictEqual(result.ok, false, "pre-clean startup must not resolve after clean");
    if (!result.ok) {
      assert.match(result.err.message, /superseded/, "pre-clean startup fails with the supersede signal");
    }
    assert.strictEqual(piSpawnCaptures.length, 0, "superseded pre-clean startup never spawns Pi");
    assert.strictEqual(manager.getActive(chatId), undefined, "no active session is created by the old startup");
    assert.strictEqual(manager.getActiveCount(), 0, "no active sessions remain");
    assert.strictEqual(await activeGauge(), before, "sessionsActive is restored after teardown and supersede");
    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(store.getSession(chatId), undefined, "cleaned store is not re-persisted by the old startup");

    await manager.closeAll();
  });

  it("destroySession supersedes an in-flight stale-resume recovery before it can discard newer state", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("clean-resume", {
      sessionId: "stored-pi-id",
      chatId: "clean-resume",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    piSpawnOutcomes = [
      { spawnThenDelayedExitStderr: "No session found matching stored-pi-id", delayMs: 1_000 },
    ];
    nextPiSessionId = "old-local-id";

    let oldChild: ChildProcess | null = null;
    let signalOldCaptureStarted: (() => void) | null = null;
    const oldCaptureStarted = new Promise<void>((resolve) => { signalOldCaptureStarted = resolve; });
    onGetState = (child) => {
      if (!oldChild) {
        oldChild = child;
        signalOldCaptureStarted?.();
      }
    };

    const before = await activeGauge();
    const discardedBefore = await discardedCount("pi");
    const crashesBefore = await crashCount("pi");
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    const oldStartup = manager.getOrCreateSession("clean-resume", "pi");
    const oldSettled = oldStartup.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );

    await oldCaptureStarted;
    await manager.destroySession("clean-resume");

    nextPiSessionId = "new-pi-id";
    const newSession = await manager.getOrCreateSession("clean-resume", "pi");
    assert.strictEqual(newSession.sessionId, "new-pi-id", "post-clean startup owns the fresh session");

    const outboxSentinel = `${newSession.outboxPath}/owned-after-clean.txt`;
    writeFileSync(outboxSentinel, "new owner outbox file");
    const mediaSentinel = `${ensureSessionMediaDir("clean-resume")}/owned-after-clean.jpg`;
    writeFileSync(mediaSentinel, "new owner media file");

    const result = await oldSettled;
    assert.strictEqual(result.ok, false, "superseded stale-resume startup must reject");
    if (!result.ok) {
      assert.match(result.err.message, /superseded/, "old stale-resume startup fails with the supersede signal");
    }

    assert.ok(oldChild, "old resume child reached get_state capture");
    assert.strictEqual((oldChild as ChildProcess).killed, true, "superseded resume child is terminated");
    assert.strictEqual(hasExited(oldChild as ChildProcess), true, "superseded resume child is reaped");
    assert.strictEqual(piSpawnCaptures.length, 2, "old resume + new post-clean startup, no stale-resume recovery spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "old startup attempted stored resume");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "new post-clean startup starts fresh");
    assert.strictEqual(manager.getActive("clean-resume"), newSession, "new session remains active");
    assert.strictEqual(await activeGauge(), before + 1, "only the new session counts toward sessionsActive");
    assert.strictEqual((await discardedCount("pi")) - discardedBefore, 0, "superseded stale resume is not counted as recovery");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "superseded stale resume is not a crash");
    assert.ok(existsSync(outboxSentinel), "new outbox survives superseded stale-resume cleanup");
    assert.ok(existsSync(mediaSentinel), "new media survives superseded stale-resume cleanup");

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("clean-resume")?.sessionId, "new-pi-id", "new persisted session survives old recovery");

    await manager.closeAll();
  });

  it("destroySession during startup child termination prevents stale-resume discard of newer state", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("clean-resume-terminate", {
      sessionId: "stored-pi-id",
      chatId: "clean-resume-terminate",
      agentId: "pi",
      lastActivity: Date.now(),
    });

    piSpawnOutcomes = [
      { spawnThenDelayedExitStderr: "No session found matching stored-pi-id", delayMs: 10_000 },
    ];
    nextPiSessionId = "old-local-id";

    let oldChild: ChildProcess | null = null;
    let signalOldCaptureStarted: (() => void) | null = null;
    const oldCaptureStarted = new Promise<void>((resolve) => { signalOldCaptureStarted = resolve; });
    let signalKillCalled: (() => void) | null = null;
    const killCalled = new Promise<void>((resolve) => { signalKillCalled = resolve; });
    let releaseKillExit: () => void = () => { throw new Error("kill was not called"); };

    onGetState = (child) => {
      if (oldChild) return;
      oldChild = child;
      const mutableChild = child as ChildProcess & {
        killed: boolean;
        exitCode: number | null;
        signalCode: string | null;
      };
      mutableChild.kill = (signal?: NodeJS.Signals | number) => {
        mutableChild.killed = true;
        signalKillCalled?.();
        releaseKillExit = () => {
          if (mutableChild.exitCode !== null || mutableChild.signalCode !== null) return;
          const code = signal === "SIGKILL" ? 137 : 0;
          const signalCode = typeof signal === "string" ? signal : "SIGTERM";
          mutableChild.exitCode = code;
          mutableChild.signalCode = signalCode;
          child.emit("exit", code, signalCode);
        };
        return true;
      };
      signalOldCaptureStarted?.();
    };

    const before = await activeGauge();
    const discardedBefore = await discardedCount("pi");
    const crashesBefore = await crashCount("pi");
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    const oldStartup = manager.getOrCreateSession("clean-resume-terminate", "pi");
    const oldSettled = oldStartup.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );

    await oldCaptureStarted;
    await killCalled;

    await manager.destroySession("clean-resume-terminate");

    nextPiSessionId = "new-pi-id";
    const newSession = await manager.getOrCreateSession("clean-resume-terminate", "pi");
    assert.strictEqual(newSession.sessionId, "new-pi-id", "post-clean startup owns the fresh session");

    const outboxSentinel = `${newSession.outboxPath}/owned-after-termination-clean.txt`;
    writeFileSync(outboxSentinel, "new owner outbox file");
    const mediaSentinel = `${ensureSessionMediaDir("clean-resume-terminate")}/owned-after-termination-clean.jpg`;
    writeFileSync(mediaSentinel, "new owner media file");

    releaseKillExit();
    const result = await oldSettled;
    assert.strictEqual(result.ok, false, "superseded stale-resume startup must reject");
    if (!result.ok) {
      assert.match(result.err.message, /superseded/, "old stale-resume startup fails with the supersede signal");
    }

    assert.ok(oldChild, "old resume child reached get_state capture");
    assert.strictEqual((oldChild as ChildProcess).killed, true, "superseded resume child is terminated");
    assert.strictEqual(hasExited(oldChild as ChildProcess), true, "superseded resume child is reaped");
    assert.strictEqual(piSpawnCaptures.length, 2, "old resume + new post-clean startup, no stale-resume recovery spawn");
    assert.strictEqual(piSpawnCaptures[0].resumeSessionId, "stored-pi-id", "old startup attempted stored resume");
    assert.strictEqual(piSpawnCaptures[1].resumeSessionId, undefined, "new post-clean startup starts fresh");
    assert.strictEqual(manager.getActive("clean-resume-terminate"), newSession, "new session remains active");
    assert.strictEqual(await activeGauge(), before + 1, "only the new session counts toward sessionsActive");
    assert.strictEqual((await discardedCount("pi")) - discardedBefore, 0, "superseded stale resume is not counted as recovery");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "superseded stale resume is not a crash");
    assert.ok(existsSync(outboxSentinel), "new outbox survives superseded stale-resume cleanup");
    assert.ok(existsSync(mediaSentinel), "new media survives superseded stale-resume cleanup");

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("clean-resume-terminate")?.sessionId, "new-pi-id", "new persisted session survives old recovery");

    await manager.closeAll();
  });
});

describe("SessionManager superseded startup resource ownership (Task 3)", () => {
  /** Current sessionsActive gauge value (0 if unset). */
  async function activeGauge(): Promise<number> {
    const metric = await sessionsActive.get();
    return metric.values[0]?.value ?? 0;
  }

  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true });
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = "pi-generated-id";
    suppressGetStateResponse = false;
    getStateError = null;
    onGetState = null;
    try { rmSync(sessionMediaDir("supersede-res"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    cleanup();
    onGetState = null;
    try { rmSync(sessionMediaDir("supersede-res"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("a superseded startup must not wipe the newer post-clean startup's outbox/media", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const before = await activeGauge();

    // Park the OLD startup inside get_state capture, before it can pass the
    // generation guard or prepare the shared outbox. An interleaved /clean plus a
    // fresh post-clean startup then takes ownership of the deterministic
    // outbox/media paths.
    suppressGetStateResponse = true;
    let oldChild: ChildProcess | null = null;
    let signalCaptureStarted: (() => void) | null = null;
    const captureStarted = new Promise<void>((resolve) => { signalCaptureStarted = resolve; });
    onGetState = (child) => {
      if (oldChild) return;
      oldChild = child;
      signalCaptureStarted?.();
    };

    nextPiSessionId = "old-pi-id";
    const oldStartup = manager.getOrCreateSession("supersede-res", "pi");
    let oldDone = false;
    // Consume the expected supersede rejection so the floating promise never
    // surfaces as an unhandled rejection before we assert on the outcome.
    const oldSettled = oldStartup.then(
      () => {
        oldDone = true;
        return { ok: true as const };
      },
      (err: Error) => {
        oldDone = true;
        return { ok: false as const, err };
      },
    );

    await captureStarted;
    assert.strictEqual(oldDone, false, "old startup is still parked before /clean and the new owner");

    // /clean lands while the old startup is parked: it bumps the generation and
    // supersedes the old startup.
    await manager.destroySession("supersede-res");

    // A fresh post-clean startup begins, succeeds, and takes ownership of the
    // shared per-chat outbox/media for this chat.
    suppressGetStateResponse = false;
    onGetState = null;
    nextPiSessionId = "new-pi-id";
    const newSession = await manager.getOrCreateSession("supersede-res", "pi");
    assert.strictEqual(newSession.sessionId, "new-pi-id", "fresh post-clean startup owns the session");
    assert.strictEqual(newSession.outboxPath, outboxDir("supersede-res"), "new owner holds the per-chat outbox");
    assert.strictEqual(oldDone, false, "old startup is still unresolved when the new owner writes resources");

    // Files the NEW owner placed under the shared outbox/media dirs after taking
    // ownership. The superseded old startup must not remove these.
    const outboxSentinel = `${newSession.outboxPath}/owned-by-new.txt`;
    writeFileSync(outboxSentinel, "new owner outbox file");
    const mediaSentinel = `${ensureSessionMediaDir("supersede-res")}/owned-by-new.jpg`;
    writeFileSync(mediaSentinel, "new owner media file");

    // Release the old startup: it must be superseded and
    // must NOT touch the shared outbox/media the new owner now holds.
    assert.ok(oldChild, "old startup reached get_state capture");
    (oldChild as ChildProcess).stdout!.push(
      JSON.stringify({ type: "response", success: true, data: { sessionId: "old-pi-id" } }) + "\n",
    );
    const result = await oldSettled;
    assert.strictEqual(result.ok, false, "the superseded old startup must not resolve a session");
    if (!result.ok) {
      assert.match(result.err.message, /superseded/, "old startup fails with the supersede signal");
    }

    // The new owner's resources survive the superseded old startup (the fix).
    assert.ok(existsSync(outboxSentinel), "new owner's outbox file survives the superseded startup");
    assert.ok(existsSync(mediaSentinel), "new owner's media file survives the superseded startup");

    // The new session is intact and still the sole persisted owner.
    assert.strictEqual(manager.getActive("supersede-res"), newSession, "new session remains active");
    assert.strictEqual(manager.getActiveCount(), 1, "only the new session remains active");
    assert.strictEqual(await activeGauge(), before + 1, "only the new session counts toward sessionsActive");
    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(store.getSession("supersede-res")?.sessionId, "new-pi-id", "the fresh id stays persisted");

    await manager.closeAll();
  });
});
