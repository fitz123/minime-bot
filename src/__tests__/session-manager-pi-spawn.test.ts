import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, realpathSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { dirname } from "node:path";
import type { AgentConfig, BotConfig, BoundSessionState, StreamLine } from "../types.js";
import type { ActiveSession } from "../session-manager.js";
import type { InteractiveSessionBinding } from "../interactive-session-binding.js";
// Real (un-mocked) modules — the SAME singletons session-manager imports, so a
// spy on log.warn and a read of piSessionResumeDiscarded observe its behavior.
import { log } from "../logger.js";
import { piSessionResumeDiscarded, sessionsActive, sessionCrashes } from "../metrics.js";
import { ensureSessionMediaDir, sessionMediaDir, allocateMediaPath, releaseMediaPath } from "../media-store.js";
// Real protocol helpers the spawn-path capture needs (parse get_state replies).
// Resolved here BEFORE mock.module installs the stub, so these are the genuine
// implementations; the stub below re-exports them so capture parses correctly.
import { MINIME_BOT_PI_SESSION_AGENT_ID_ENV, NewlineOnlyJsonlSplitter, PiStartupBlockingUiError, assertPiSessionIdentityMatchesBinding, normalizePiModel, parsePiStartupIdentityRecord, type PiSpawnExtensionOptions, type PiSpawnRuntimeEnvOptions } from "../pi-rpc-protocol.js";
import PQueue from "p-queue";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const TEST_DIR = "/tmp/minime-test-pi-spawn";
const TEST_STORE_PATH = `${TEST_DIR}/sessions.json`;
const MAIN_WORKSPACE = `${TEST_DIR}/workspace-main`;
const PI_WORKSPACE = `${TEST_DIR}/workspace-pi`;
const PI_SESSION_DIR = `${TEST_DIR}/pi-sessions`;

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

function setupTestFilesystem(): void {
  cleanup();
  mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(MAIN_WORKSPACE, { recursive: true, mode: 0o700 });
  mkdirSync(PI_WORKSPACE, { recursive: true, mode: 0o700 });
  mkdirSync(PI_SESSION_DIR, { recursive: true, mode: 0o700 });
  for (const path of [TEST_DIR, MAIN_WORKSPACE, PI_WORKSPACE, PI_SESSION_DIR]) {
    chmodSync(path, 0o700);
  }
  process.env.PI_CODING_AGENT_SESSION_DIR = PI_SESSION_DIR;
}

function teardownTestFilesystem(): void {
  cleanup();
  delete process.env.PI_CODING_AGENT_SESSION_DIR;
}

// ---------------------------------------------------------------------------
// Captures + tunables driven by the module mocks below.
// ---------------------------------------------------------------------------

/** Args captured from the mocked Pi spawnPiRpcSession. */
interface PiSpawnCapture {
  agent: AgentConfig;
  sessionBinding: InteractiveSessionBinding;
  extensionOptions?: PiSpawnExtensionOptions;
  runtimeEnvOptions?: PiSpawnRuntimeEnvOptions;
}

const piSpawnCaptures: PiSpawnCapture[] = [];

/**
 * Optional get_state identity overrides. Null models an absent identity; unless
 * forceIdentityOverride is set, the mock reports the exact selected binding.
 */
let nextPiSessionId: string | null | undefined;
let nextPiSessionFile: string | null | undefined;
let forceIdentityOverride = false;
let suppressGetStateResponse = false;
let startupRecords: Array<Record<string, unknown>> = [];
const piStdinWrites: Array<Record<string, unknown>> = [];

/**
 * When set, the mocked sendPiGetState throws this error — models the
 * spawn-then-exit race where the child dies after waitForSpawn resolves but
 * before get_state is written (the real writePiCommand rejects a closed stdin).
 * Startup must fail closed without changing the durable binding.
 */
let getStateError: Error | null = null;

/**
 * Optional hook fired with the child whenever the mocked sendPiGetState is
 * invoked — lets a test observe the exact moment a startup is parked inside
 * its identity assertion (the window before active.set). Combine
 * with `suppressGetStateResponse = true` to hold the capture open until the test
 * pushes the get_state reply manually.
 */
let onGetState: ((child: ChildProcess, responseId?: string) => void) | null = null;

/** Create a mock ChildProcess that auto-emits 'spawn' on next tick. */
function createAutoSpawnChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdout = new Readable({ read() {} });
  const stderr = new Readable({ read() {} });
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      piStdinWrites.push(JSON.parse(chunk.toString().trim()) as Record<string, unknown>);
      cb();
    },
  });

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
  | { throwBindingFailure: "missing" | "unsafe" | "unreadable" | "invalid" }
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
      sessionBinding: InteractiveSessionBinding,
      extensionOptions?: PiSpawnExtensionOptions,
      runtimeEnvOptions?: PiSpawnRuntimeEnvOptions,
    ) {
      piSpawnCaptures.push({
        agent,
        sessionBinding,
        extensionOptions,
        runtimeEnvOptions,
      });
      const outcome = piSpawnOutcomes.shift() ?? "ok";
      if (outcome === "ok") return createAutoSpawnChild();
      if ("throwBindingFailure" in outcome) {
        throw new Error(`Interactive Pi session binding is not usable: ${outcome.throwBindingFailure}`);
      }
      const exactStderr = (stderr: string) => stderr === "No session found matching stored-pi-id"
        ? `No session found matching '${sessionBinding.sessionFile}'`
        : stderr;
      if ("failStderr" in outcome) return createFailingPiChild(exactStderr(outcome.failStderr));
      if ("spawnThenExitStderr" in outcome) return createSpawnThenExitChild(exactStderr(outcome.spawnThenExitStderr));
      if ("spawnThenDelayedStderrExitStderr" in outcome) {
        return createSpawnThenDelayedStderrExitChild(
          exactStderr(outcome.spawnThenDelayedStderrExitStderr),
          outcome.stderrDelayMs,
          outcome.exitDelayMs,
        );
      }
      return createSpawnThenDelayedExitChild(exactStderr(outcome.spawnThenDelayedExitStderr), outcome.delayMs);
    },
    sendPiGetState(child: ChildProcess, id?: string) {
      if (getStateError) throw getStateError;
      onGetState?.(child, id);
      if (suppressGetStateResponse) return;
      // The startup identity assertion reads child.stdout directly, so model Pi's
      // get_state reply by pushing the real JSONL record onto stdout. `null`
      // models a process that answers without a session id: end the stream so
      // capture returns promptly (close ends the read) instead of timing out.
      const stdout = child.stdout as Readable | undefined;
      if (!stdout) return;
      if ((child as unknown as { __closeStdoutOnGetState?: boolean }).__closeStdoutOnGetState) {
        stdout.push(null);
        return;
      }
      for (const record of startupRecords) {
        stdout.push(`${JSON.stringify(record)}\n`);
      }
      if (nextPiSessionId !== null && nextPiSessionFile !== null) {
        const binding = piSpawnCaptures.at(-1)?.sessionBinding;
        const sessionId = forceIdentityOverride
          ? nextPiSessionId ?? binding?.sessionId
          : binding?.sessionId;
        const sessionFile = forceIdentityOverride
          ? nextPiSessionFile ?? binding?.sessionFile
          : binding?.sessionFile;
        stdout.push(
          JSON.stringify({
            type: "response",
            id,
            command: "get_state",
            success: true,
            data: { sessionId, sessionFile },
          }) + "\n",
        );
      } else {
        stdout.push(null);
      }
    },
    sendPiPrompt() {},
    sendPiSteer() {},
    sendPiAcknowledgedSteer() {},
    PI_EXTENSIONS_DISABLED_ENV: "PI_EXTENSIONS_DISABLED",
    normalizePiModel,
    async *readPiStream(): AsyncGenerator<StreamLine> {
      // Message-path reader (unused by the spawn-path capture, which now reads
      // child.stdout directly). Present so session-manager's import resolves.
    },
    // Re-export the genuine parse helpers the capture uses.
    NewlineOnlyJsonlSplitter,
    PiStartupBlockingUiError,
    assertPiSessionIdentityMatchesBinding,
    parsePiStartupIdentityRecord,
  },
});

const { SessionManager, formatSessionRecoveryNotice, outboxDir, hasExited } = await import("../session-manager.js");
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
        workspaceCwd: MAIN_WORKSPACE,
        model: "gpt-5.5",
      },
      pi: {
        id: "pi",
        workspaceCwd: PI_WORKSPACE,
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

function storedPiBinding(
  chatId: string,
  sessionId: string,
  overrides: Partial<BoundSessionState> = {},
): BoundSessionState {
  const workspaceRealpath = realpathSync(PI_WORKSPACE);
  const sessionFile = `${PI_SESSION_DIR}/${sessionId}.jsonl`;
  writeFileSync(sessionFile, `${JSON.stringify({
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: "2026-08-02T00:00:00.000Z",
    cwd: workspaceRealpath,
  })}\n`, { mode: 0o600 });
  chmodSync(sessionFile, 0o600);
  return {
    bindingState: "bound",
    sessionId,
    sessionFile,
    workspaceRealpath,
    chatId,
    agentId: "pi",
    provider: "pi",
    model: "openai-codex/gpt-5.5",
    thinking: "xhigh",
    lastActivity: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager exact Pi binding startup", () => {
  beforeEach(() => {
    setupTestFilesystem();
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = undefined;
    nextPiSessionFile = undefined;
    forceIdentityOverride = false;
    suppressGetStateResponse = false;
    startupRecords = [];
    piStdinWrites.length = 0;
    getStateError = null;
    onGetState = null;
  });

  afterEach(() => {
    teardownTestFilesystem();
    onGetState = null;
  });

  it("pre-seeds, persists, and asserts one exact Pi binding before spawn", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    const session = await manager.getOrCreateSession("pi-chat", "pi");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(session.sessionId, piSpawnCaptures[0].sessionBinding.sessionId);
    assert.strictEqual(session.sessionFile, piSpawnCaptures[0].sessionBinding.sessionFile);
    assert.strictEqual(session.workspaceRealpath, piSpawnCaptures[0].sessionBinding.workspaceRealpath);
    assert.strictEqual(session.provider, "pi");
    assert.strictEqual(session.model, "openai-codex/gpt-5.5");
    assert.strictEqual(session.thinking, "xhigh");
    assert.strictEqual(session.outboxPath, outboxDir("pi-chat"));
    assert.deepStrictEqual(piSpawnCaptures[0].runtimeEnvOptions, {
      askCallerAgentId: "pi",
      outboxPath: session.outboxPath,
    });
    assert.ok(!session.outboxPath.startsWith("/tmp/bot-outbox"));
    assert.strictEqual(statSync(dirname(session.outboxPath)).mode & 0o777, 0o700);
    assert.strictEqual(statSync(session.outboxPath).mode & 0o777, 0o700);

    const health = manager.getSessionHealth("pi-chat");
    assert.ok(health);
    assert.strictEqual(health.provider, "pi");
    assert.strictEqual(health.model, "openai-codex/gpt-5.5");
    assert.strictEqual(health.thinking, "xhigh");

    const store = new SessionStore(TEST_STORE_PATH);
    const stored = store.getSession("pi-chat");
    assert.strictEqual(stored?.bindingState, "bound");
    assert.strictEqual(stored?.sessionId, session.sessionId);
    assert.strictEqual(stored?.sessionFile, session.sessionFile);

    await manager.closeAll();
  });

  it("fails promptly and reaps a child blocked on extension UI during startup", async () => {
    startupRecords = [{
      type: "extension_ui_request",
      id: "startup-confirm",
      method: "confirm",
      title: "sensitive title",
      message: "sensitive message",
    }];
    let child: ChildProcess | undefined;
    onGetState = (spawnedChild) => {
      child = spawnedChild;
    };
    const manager = new SessionManager(
      () => makeConfig(),
      TEST_STORE_PATH,
      undefined,
      { startupTimeoutMs: 5_000 },
    );
    const startedAt = Date.now();

    await assert.rejects(
      manager.getOrCreateSession("pi-startup-ui", "pi"),
      /unsupported blocking extension UI before RPC startup completed/,
    );

    assert.ok(Date.now() - startedAt < 1_000, "startup dialog must not wait for the timeout");
    assert.deepStrictEqual(piStdinWrites, [{
      type: "extension_ui_response",
      id: "startup-confirm",
      cancelled: true,
    }]);
    assert.strictEqual(child?.killed, true, "failed startup child must be reaped");
    assert.strictEqual(manager.getActive("pi-startup-ui"), undefined);
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
      assert.deepStrictEqual(piSpawnCaptures[0].runtimeEnvOptions, {
        askCallerAgentId: "pi",
        outboxPath: outboxDir("pi-caller"),
      });
    } finally {
      if (oldCaller === undefined) {
        delete process.env[MINIME_BOT_PI_SESSION_AGENT_ID_ENV];
      } else {
        process.env[MINIME_BOT_PI_SESSION_AGENT_ID_ENV] = oldCaller;
      }
      await manager.closeAll();
    }
  });

  it("resumes a stored Pi session by spawning with its exact absolute path", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    const prior = storedPiBinding("pi-resume", "stored-pi-id");
    store.setSession("pi-resume", prior);
    // On resume, Pi re-confirms the same id through get_state.
    nextPiSessionId = "stored-pi-id";

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-resume", "pi");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(
      piSpawnCaptures[0].sessionBinding.sessionFile,
      realpathSync(prior.sessionFile),
      "resume passes the stored absolute transcript path",
    );
    assert.strictEqual(session.sessionId, "stored-pi-id", "resumed session keeps its id");

    await manager.closeAll();
  });

  it("resumes stored Pi sessions with the current configured model after a model change", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    const prior = storedPiBinding("pi-model-change", "stored-model-change-id");
    store.setSession("pi-model-change", prior);
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
    assert.strictEqual(
      piSpawnCaptures[0].sessionBinding.sessionFile,
      realpathSync(prior.sessionFile),
    );
    assert.strictEqual(piSpawnCaptures[0].agent.model, "gpt-5.6-sol");
    assert.strictEqual(session.sessionId, "stored-model-change-id", "context-preserving resume keeps the id");
    assert.strictEqual(session.model, "openai-codex/gpt-5.6-sol", "active session records current model");

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-model-change")?.model, "openai-codex/gpt-5.6-sol");

    await manager.closeAll();
  });

  it("rejects absent get_state identity without replacing the pre-seeded binding", async () => {
    nextPiSessionId = null;
    nextPiSessionFile = null;

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    await assert.rejects(
      manager.getOrCreateSession("pi-noid", "pi"),
      /before the exact session identity was reported/,
    );

    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(store.getSession("pi-noid")?.sessionId, piSpawnCaptures[0].sessionBinding.sessionId);
    assert.strictEqual(manager.getActive("pi-noid"), undefined);

    await manager.closeAll();
  });

  it("rejects get_state timeout without minting or persisting a second identity", async () => {
    suppressGetStateResponse = true;

    const manager = new SessionManager(
      () => makeConfig(),
      TEST_STORE_PATH,
      undefined,
      { startupTimeoutMs: 20 },
    );
    await assert.rejects(
      manager.getOrCreateSession("pi-timeout", "pi"),
      /did not report the exact session identity/,
    );

    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(store.getSession("pi-timeout")?.sessionId, piSpawnCaptures[0].sessionBinding.sessionId);

    await manager.closeAll();
  });

  it("rejects a get_state write failure and retains the pre-seeded identity", async () => {
    // Spawn succeeds (waitForSpawn resolves on 'spawn'), but the child dies before
    // get_state is written, so sendPiGetState throws — the spawn-then-exit race.
    getStateError = new Error("Pi RPC child process is not available");

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    await assert.rejects(
      manager.getOrCreateSession("pi-getstate-fail", "pi"),
      /Pi RPC child process is not available/,
    );

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn, no recovery loop");

    const store = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(store.getSession("pi-getstate-fail")?.sessionId, piSpawnCaptures[0].sessionBinding.sessionId);

    await manager.closeAll();
  });

  it("rejects mismatched get_state IDs and paths without rotating the durable binding", async () => {
    forceIdentityOverride = true;
    nextPiSessionId = "wrong-session-id";
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    await assert.rejects(
      manager.getOrCreateSession("pi-id-mismatch", "pi"),
      /get_state sessionId mismatch/,
    );
    const idBinding = piSpawnCaptures[0].sessionBinding;
    assert.strictEqual(new SessionStore(TEST_STORE_PATH).getSession("pi-id-mismatch")?.sessionId, idBinding.sessionId);

    nextPiSessionId = undefined;
    nextPiSessionFile = `${PI_SESSION_DIR}/wrong-session.jsonl`;
    await assert.rejects(
      manager.getOrCreateSession("pi-path-mismatch", "pi"),
      /get_state sessionFile mismatch/,
    );
    const pathBinding = piSpawnCaptures[1].sessionBinding;
    assert.strictEqual(new SessionStore(TEST_STORE_PATH).getSession("pi-path-mismatch")?.sessionId, pathBinding.sessionId);
    assert.strictEqual(piSpawnCaptures.length, 2, "identity mismatches never allocate a recovery binding");
  });

  it("rotates locally missing, malformed, unsafe, and ID-mismatched transcripts before spawn", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    const cases = [
      { chatId: "local-missing", mutate: (state: BoundSessionState) => rmSync(state.sessionFile), reason: "missing" },
      {
        chatId: "local-malformed",
        mutate: (state: BoundSessionState) => writeFileSync(state.sessionFile, "not-json\n", { mode: 0o600 }),
        reason: "invalid",
      },
      {
        chatId: "local-unsafe",
        mutate: (state: BoundSessionState) => chmodSync(state.sessionFile, 0o644),
        reason: "unsafe",
      },
      {
        chatId: "local-id-mismatch",
        mutate: (state: BoundSessionState) => writeFileSync(state.sessionFile, `${JSON.stringify({
          type: "session",
          version: CURRENT_SESSION_VERSION,
          id: "different-header-id",
          timestamp: "2026-08-02T00:00:00.000Z",
          cwd: state.workspaceRealpath,
        })}\n`, { mode: 0o600 }),
        reason: "invalid",
      },
    ] as const;

    const preparedCases = cases.map((testCase) => {
      const prior = storedPiBinding(testCase.chatId, `${testCase.chatId}-old-id`);
      store.setSession(testCase.chatId, prior);
      testCase.mutate(prior);
      return { ...testCase, prior };
    });
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    for (const testCase of preparedCases) {
      const spawnCount = piSpawnCaptures.length;
      const session = await manager.getOrCreateSession(testCase.chatId, "pi");
      assert.strictEqual(piSpawnCaptures.length, spawnCount + 1, "invalid local binding is never spawned");
      assert.notStrictEqual(session.sessionId, testCase.prior.sessionId);
      assert.deepStrictEqual(new SessionStore(TEST_STORE_PATH).getSession(testCase.chatId)?.pendingRecoveryNotice, {
        failedSessionId: testCase.prior.sessionId,
        replacementSessionId: session.sessionId,
        reason: testCase.reason,
      });
    }
    await manager.closeAll();
  });

  it("rotates once when spawn-time revalidation finds an unreadable transcript", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    const prior = storedPiBinding("local-unreadable", "local-unreadable-old-id");
    store.setSession("local-unreadable", prior);
    piSpawnOutcomes = [{ throwBindingFailure: "unreadable" }];

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("local-unreadable", "pi");

    assert.strictEqual(piSpawnCaptures.length, 2, "the unreadable binding and one replacement are attempted");
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionFile, realpathSync(prior.sessionFile));
    assert.notStrictEqual(session.sessionId, prior.sessionId);
    assert.deepStrictEqual(
      new SessionStore(TEST_STORE_PATH).getSession("local-unreadable")?.pendingRecoveryNotice,
      {
        failedSessionId: prior.sessionId,
        replacementSessionId: session.sessionId,
        reason: "unreadable",
      },
    );
    await manager.closeAll();
  });

  it("spawns an absent-provider agent through one exact Pi binding", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("main-chat", "main");

    assert.strictEqual(piSpawnCaptures.length, 1, "one Pi spawn");
    assert.strictEqual(piSpawnCaptures[0].agent.id, "main");
    assert.strictEqual(session.sessionId, piSpawnCaptures[0].sessionBinding.sessionId);
    assert.strictEqual(session.provider, "pi");
    assert.strictEqual(session.model, "openai-codex/gpt-5.5");
    assert.strictEqual(session.thinking, undefined);

    await manager.closeAll();
  });

  it("rotates a live active session when the requested agent changes", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const oldSession = await manager.getOrCreateSession("agent-switch", "main");

    const inflightPath = allocateMediaPath("agent-switch", "photo", ".jpg");
    writeFileSync(inflightPath, "current turn media");
    const stalePath = `${sessionMediaDir("agent-switch")}/prior-agent.jpg`;
    writeFileSync(stalePath, "stale prior agent media");

    const newSession = await manager.getOrCreateSession("agent-switch", "pi");

    assert.notStrictEqual(newSession, oldSession, "agent switch must not reuse the old active session");
    assert.strictEqual(oldSession.child.killed, true, "old agent child should be terminated");
    assert.strictEqual(newSession.agentId, "pi");
    assert.strictEqual(newSession.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);
    assert.strictEqual(piSpawnCaptures.length, 2, "old agent spawn + new agent spawn");
    assert.strictEqual(piSpawnCaptures[1].agent.id, "pi");
    assert.notStrictEqual(
      piSpawnCaptures[1].sessionBinding.sessionId,
      piSpawnCaptures[0].sessionBinding.sessionId,
      "new agent receives a distinct Pi-authored binding",
    );

    const store = new SessionStore(TEST_STORE_PATH);
    const stored = store.getSession("agent-switch");
    assert.strictEqual(stored?.bindingState, "bound");
    assert.strictEqual(stored?.sessionId, newSession.sessionId);
    assert.strictEqual(stored?.sessionFile, newSession.sessionFile);
    assert.strictEqual(stored?.agentId, "pi");
    assert.ok(existsSync(inflightPath), "current-turn in-flight media survives active agent rotation");
    assert.strictEqual(existsSync(stalePath), false, "prior-agent media is purged on active agent rotation");

    releaseMediaPath(inflightPath);
    await manager.closeAll();
  });
});

describe("SessionManager exact-path recovery", () => {
  /** Current value of the discard metric for an agent (0 if never set). */
  async function discardedCount(agentId: string): Promise<number> {
    const metric = await piSessionResumeDiscarded.get();
    const entry = metric.values.find((v) => v.labels.agent_id === agentId);
    return entry?.value ?? 0;
  }

  beforeEach(() => {
    setupTestFilesystem();
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = undefined;
    nextPiSessionFile = undefined;
    forceIdentityOverride = false;
    getStateError = null;
    // The media-preserved assertions write into the test media root; clear each
    // chat's dir between runs so a prior run's file can't mask a regression.
    try { rmSync(sessionMediaDir("pi-keep"), { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(sessionMediaDir("pi-inflight"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    teardownTestFilesystem();
    try { rmSync(sessionMediaDir("pi-keep"), { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(sessionMediaDir("pi-inflight"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("missing-session signal: discards once, warns once, increments metric, then starts fresh", async () => {
    const extraExtensions = ["/approved/recovery-a.ts", "/approved/recovery-b.ts"];
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-stale", storedPiBinding("pi-stale", "stored-pi-id"));

    // The exact resume fails with Pi's deterministic signal; the one
    // pre-seeded replacement then starts and get_state confirms its binding.
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
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionId, "stored-pi-id");
    assert.notStrictEqual(
      piSpawnCaptures[1].sessionBinding.sessionFile,
      piSpawnCaptures[0].sessionBinding.sessionFile,
      "recovery opens the one pre-seeded replacement path",
    );
    assert.deepStrictEqual(
      piSpawnCaptures.map((capture) => capture.extensionOptions),
      [{ extraExtensions }, { extraExtensions }],
      "recovery retry keeps the configured extra extensions",
    );
    assert.deepStrictEqual(
      piSpawnCaptures.map((capture) => capture.runtimeEnvOptions),
      [
        { askCallerAgentId: "pi", outboxPath: outboxDir("pi-stale") },
        { askCallerAgentId: "pi", outboxPath: outboxDir("pi-stale") },
      ],
      "recovery retry keeps the exact session outbox path",
    );

    // The recovered session is live on the one pre-seeded replacement, and it is persisted.
    assert.strictEqual(session.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);
    assert.notStrictEqual(session.sessionId, "stored-pi-id");
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    const recovered = storeAfter.getSession("pi-stale");
    assert.strictEqual(recovered?.sessionId, session.sessionId, "replacement id persisted");
    assert.deepStrictEqual(recovered?.pendingRecoveryNotice, {
      failedSessionId: "stored-pi-id",
      replacementSessionId: session.sessionId,
      reason: "exact-open-rejected",
    });

    // Exactly one discard warning + one metric increment.
    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not open Pi session stored-pi-id (exact-open-rejected)"),
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
    store.setSession("pi-inflight", storedPiBinding("pi-inflight", "stored-pi-id"));

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
    assert.strictEqual(session.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);

    // The in-flight file for the current turn SURVIVES (the bug fix): the fresh
    // Pi session's prompt can still reach it.
    assert.ok(existsSync(inflightPath), "in-flight media for the current turn is preserved across recovery");
    // The prior-session leftover is swept (it was not in-flight).
    assert.strictEqual(existsSync(stalePath), false, "prior-session media leftover is removed");

    releaseMediaPath(inflightPath);
    await manager.closeAll();
  });

  it("retries a durable recovery notice after transport failure and acknowledges only successful delivery", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-notice", storedPiBinding("pi-notice", "failed-old-id"));
    piSpawnOutcomes = [{ failStderr: "No session found matching stored-pi-id" }];

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const session = await manager.getOrCreateSession("pi-notice", "pi");
    const pending = new SessionStore(TEST_STORE_PATH).getSession("pi-notice")?.pendingRecoveryNotice;
    assert.deepStrictEqual(pending, {
      failedSessionId: "failed-old-id",
      replacementSessionId: session.sessionId,
      reason: "exact-open-rejected",
    });

    await assert.rejects(
      manager.deliverPendingRecoveryNotice("pi-notice", {
        sendMessage: async () => { throw new Error("transport failed"); },
      }),
      /transport failed/,
    );
    assert.deepStrictEqual(
      new SessionStore(TEST_STORE_PATH).getSession("pi-notice")?.pendingRecoveryNotice,
      pending,
      "failed delivery leaves the exact notice durable",
    );

    await manager.closeAll();
    const restarted = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    const delivered: string[] = [];
    assert.strictEqual(await restarted.deliverPendingRecoveryNotice("pi-notice", {
      sendMessage: async (text) => {
        delivered.push(text);
        return "transport-message-id";
      },
    }), true);
    assert.deepStrictEqual(delivered, [formatSessionRecoveryNotice(pending!)]);
    assert.strictEqual(
      new SessionStore(TEST_STORE_PATH).getSession("pi-notice")?.pendingRecoveryNotice,
      undefined,
      "successful transport completion acknowledges the exact notice",
    );
  });

  it("both spawns fail: discards once, warns once, then throws — no loop", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-doomed", storedPiBinding("pi-doomed", "stored-pi-id"));

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
    assert.notStrictEqual(
      piSpawnCaptures[1].sessionBinding.sessionFile,
      piSpawnCaptures[0].sessionBinding.sessionFile,
      "recovery attempts one exact replacement path",
    );

    // The discard + warn + metric ran exactly once despite the fresh start failing.
    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not open Pi session stored-pi-id (exact-open-rejected)"),
    );
    assert.strictEqual(recoveryWarns.length, 1, "exactly one recovery warning");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "metric incremented exactly once");

    // The final failure feeds the normal crash backoff (restart count increments).
    const restartCounts = (manager as unknown as Record<string, Map<string, number>>).restartCounts;
    assert.strictEqual(restartCounts.get("pi-doomed"), 1, "second failure increments the crash count");

    const replacement = new SessionStore(TEST_STORE_PATH).getSession("pi-doomed");
    assert.strictEqual(replacement?.bindingState, "bound");
    assert.ok(replacement?.pendingRecoveryNotice, "the one replacement remains durable after spawn failure");
    piSpawnOutcomes = [{ failStderr: "No session found matching stored-pi-id" }];
    const restarted = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    await assert.rejects(
      restarted.getOrCreateSession("pi-doomed", "pi"),
      /exited during startup/,
    );
    assert.strictEqual(piSpawnCaptures.length, 3, "restart retries the same replacement without a third allocation");
    assert.strictEqual(piSpawnCaptures[2].sessionBinding.sessionId, replacement?.sessionId);
    assert.strictEqual(new SessionStore(TEST_STORE_PATH).getSession("pi-doomed")?.sessionId, replacement?.sessionId);
  });

  it("preserves an accumulated crash count across a resume-recovery discard", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-flap", storedPiBinding("pi-flap", "stored-pi-id"));

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

    assert.strictEqual(session.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);
    assert.strictEqual(
      restartCounts.get("pi-flap"),
      1,
      "prior crash count survives the recovery discard (not reset to 0)",
    );

    await manager.closeAll();
  });

  it("non-matching startup failure: no discard, stored id + media preserved, normal backoff", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-keep", storedPiBinding("pi-keep", "keep-pi-id"));

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
    assert.strictEqual(
      piSpawnCaptures[0].sessionBinding.sessionFile,
      realpathSync(`${PI_SESSION_DIR}/keep-pi-id.jsonl`),
      "the resume attempt used the stored exact path",
    );

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
    store.setSession("pi-real", storedPiBinding("pi-real", "stored-pi-id"));

    // The exact resume execs then exits 1 with the signal (real timing); the
    // one pre-seeded replacement then starts and get_state confirms its binding.
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
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionId, "stored-pi-id");
    assert.notStrictEqual(piSpawnCaptures[1].sessionBinding.sessionFile, piSpawnCaptures[0].sessionBinding.sessionFile);

    assert.strictEqual(session.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);
    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-real")?.sessionId, session.sessionId, "replacement id persisted");

    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not open Pi session stored-pi-id (exact-open-rejected)"),
    );
    assert.strictEqual(recoveryWarns.length, 1, "exactly one recovery warning");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "metric incremented exactly once");

    await manager.closeAll();
  });

  it("un-reaped stale resume window: waits for exitCode to settle, then recovers fresh", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-unreaped", storedPiBinding("pi-unreaped", "stored-pi-id"));

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
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionId, "stored-pi-id");
    assert.notStrictEqual(piSpawnCaptures[1].sessionBinding.sessionFile, piSpawnCaptures[0].sessionBinding.sessionFile);
    assert.strictEqual(session.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-unreaped")?.sessionId, session.sessionId, "replacement id persisted");

    const recoveryWarns = warnCalls.filter(
      (a) =>
        a[0] === "session-manager" &&
        typeof a[1] === "string" &&
        (a[1] as string).includes("could not open Pi session stored-pi-id (exact-open-rejected)"),
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

  it("delayed exact-open rejection rotates instead of activating an unverified session", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession(
      "pi-delayed-stderr",
      storedPiBinding("pi-delayed-stderr", "stored-pi-id"),
    );

    // stdout closes with no id before the stderr listener has buffered Pi's
    // stale-session message. Startup must briefly wait for the deterministic
    // exact-open rejection and must never keep the unverified child.
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
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionId, "stored-pi-id");
    assert.notStrictEqual(piSpawnCaptures[1].sessionBinding.sessionFile, piSpawnCaptures[0].sessionBinding.sessionFile);
    assert.strictEqual(session.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("pi-delayed-stderr")?.sessionId, session.sessionId, "replacement id persisted");
    assert.strictEqual((await discardedCount("pi")) - before, 1, "resume discard metric incremented once");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "delayed stderr recovery is not a crash");

    await manager.closeAll();
  });

  it("exit-before-stderr stale resume signal is still recovered fresh", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession(
      "pi-exit-before-stderr",
      storedPiBinding("pi-exit-before-stderr", "stored-pi-id"),
    );

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
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionId, "stored-pi-id");
    assert.notStrictEqual(piSpawnCaptures[1].sessionBinding.sessionFile, piSpawnCaptures[0].sessionBinding.sessionFile);
    assert.strictEqual(session.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);
    assert.strictEqual((await discardedCount("pi")) - before, 1, "resume discard metric incremented once");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "exit-before-stderr recovery is not a crash");

    await manager.closeAll();
  });

  it("slow exact-open rejection still rotates instead of activating an unverified session", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-slow-stale", storedPiBinding("pi-slow-stale", "stored-pi-id"));

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
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionId, "stored-pi-id");
    assert.notStrictEqual(piSpawnCaptures[1].sessionBinding.sessionFile, piSpawnCaptures[0].sessionBinding.sessionFile);
    assert.strictEqual(session.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);
    assert.strictEqual((await discardedCount("pi")) - before, 1, "resume discard metric incremented once");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "slow stale-resume recovery is not a crash");

    await manager.closeAll();
  });

  it("real pi timing (spawn then exit 1 with a non-matching error): no discard, crash count increments", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession("pi-real-keep", storedPiBinding("pi-real-keep", "keep-pi-id"));

    // Execs then exits 1, but NOT with the "No session found" signal → no recovery.
    piSpawnOutcomes = [{ spawnThenExitStderr: "codex: authentication token expired" }];

    const before = await discardedCount("pi");
    const warnCalls: unknown[][] = [];
    const warnSpy = mock.method(log, "warn", (...args: unknown[]) => { warnCalls.push(args); });

    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);
    try {
      await assert.rejects(
        () => manager.getOrCreateSession("pi-real-keep", "pi"),
        /exited before startup identity was verified/,
        "a non-matching post-spawn exit propagates as a startup error",
      );
    } finally {
      warnSpy.mock.restore();
    }

    // Exactly one spawn — no inline recovery re-spawn.
    assert.strictEqual(piSpawnCaptures.length, 1, "no recovery spawn for a non-matching failure");
    assert.strictEqual(
      piSpawnCaptures[0].sessionBinding.sessionFile,
      realpathSync(`${PI_SESSION_DIR}/keep-pi-id.jsonl`),
      "the resume attempt used the stored exact path",
    );

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
    setupTestFilesystem();
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = undefined;
    nextPiSessionFile = undefined;
    forceIdentityOverride = false;
    suppressGetStateResponse = false;
    getStateError = null;
    onGetState = null;
  });

  afterEach(() => {
    teardownTestFilesystem();
    onGetState = null;
  });

  it("destroySession during in-flight startup supersedes it: no store entry, child reaped, no active session", async () => {
    const manager = new SessionManager(() => makeConfig(), TEST_STORE_PATH);

    // Park the startup inside the identity assertion: get_state is invoked but no
    // reply is pushed, so getOrCreateSession is suspended awaiting the Pi-minted
    // id — the exact window BEFORE active.set(...) / store.setSession(...).
    suppressGetStateResponse = true;
    let capturedChild: ChildProcess | null = null;
    let capturedResponseId: string | undefined;
    let signalCaptureStarted: (() => void) | null = null;
    const captureStarted = new Promise<void>((resolve) => { signalCaptureStarted = resolve; });
    onGetState = (child, responseId) => {
      capturedChild = child;
      capturedResponseId = responseId;
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
    const oldBinding = piSpawnCaptures[0].sessionBinding;
    (capturedChild as ChildProcess).stdout!.push(
      JSON.stringify({
        type: "response",
        id: capturedResponseId,
        command: "get_state",
        success: true,
        data: { sessionId: oldBinding.sessionId, sessionFile: oldBinding.sessionFile },
      }) + "\n",
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
      pendingSteers: new Map(),
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

    assert.strictEqual(newSession.sessionId, piSpawnCaptures[0].sessionBinding.sessionId);
    assert.strictEqual(piSpawnCaptures.length, 1, "fresh Pi child spawns only after active teardown");
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionId, newSession.sessionId);
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
      pendingSteers: new Map(),
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
    store.setSession("clean-resume", storedPiBinding("clean-resume", "stored-pi-id"));

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
    assert.strictEqual(newSession.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);

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
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionId, "stored-pi-id");
    assert.strictEqual(piSpawnCaptures[1].sessionBinding.sessionId, newSession.sessionId);
    assert.strictEqual(manager.getActive("clean-resume"), newSession, "new session remains active");
    assert.strictEqual(await activeGauge(), before + 1, "only the new session counts toward sessionsActive");
    assert.strictEqual((await discardedCount("pi")) - discardedBefore, 0, "superseded stale resume is not counted as recovery");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "superseded stale resume is not a crash");
    assert.ok(existsSync(outboxSentinel), "new outbox survives superseded stale-resume cleanup");
    assert.ok(existsSync(mediaSentinel), "new media survives superseded stale-resume cleanup");

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("clean-resume")?.sessionId, newSession.sessionId);

    await manager.closeAll();
  });

  it("destroySession during startup child termination prevents stale-resume discard of newer state", async () => {
    const store = new SessionStore(TEST_STORE_PATH);
    store.setSession(
      "clean-resume-terminate",
      storedPiBinding("clean-resume-terminate", "stored-pi-id"),
    );

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
    assert.strictEqual(newSession.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);

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
    assert.strictEqual(piSpawnCaptures[0].sessionBinding.sessionId, "stored-pi-id");
    assert.strictEqual(piSpawnCaptures[1].sessionBinding.sessionId, newSession.sessionId);
    assert.strictEqual(manager.getActive("clean-resume-terminate"), newSession, "new session remains active");
    assert.strictEqual(await activeGauge(), before + 1, "only the new session counts toward sessionsActive");
    assert.strictEqual((await discardedCount("pi")) - discardedBefore, 0, "superseded stale resume is not counted as recovery");
    assert.strictEqual(await crashCount("pi"), crashesBefore, "superseded stale resume is not a crash");
    assert.ok(existsSync(outboxSentinel), "new outbox survives superseded stale-resume cleanup");
    assert.ok(existsSync(mediaSentinel), "new media survives superseded stale-resume cleanup");

    const storeAfter = new SessionStore(TEST_STORE_PATH);
    assert.strictEqual(storeAfter.getSession("clean-resume-terminate")?.sessionId, newSession.sessionId);

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
    setupTestFilesystem();
    piSpawnCaptures.length = 0;
    piSpawnOutcomes = [];
    nextPiSessionId = undefined;
    nextPiSessionFile = undefined;
    forceIdentityOverride = false;
    suppressGetStateResponse = false;
    getStateError = null;
    onGetState = null;
    try { rmSync(sessionMediaDir("supersede-res"), { recursive: true, force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    teardownTestFilesystem();
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
    let oldResponseId: string | undefined;
    let signalCaptureStarted: (() => void) | null = null;
    const captureStarted = new Promise<void>((resolve) => { signalCaptureStarted = resolve; });
    onGetState = (child, responseId) => {
      if (oldChild) return;
      oldChild = child;
      oldResponseId = responseId;
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
    assert.strictEqual(newSession.sessionId, piSpawnCaptures[1].sessionBinding.sessionId);
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
    const supersededBinding = piSpawnCaptures[0].sessionBinding;
    (oldChild as ChildProcess).stdout!.push(
      JSON.stringify({
        type: "response",
        id: oldResponseId,
        command: "get_state",
        success: true,
        data: {
          sessionId: supersededBinding.sessionId,
          sessionFile: supersededBinding.sessionFile,
        },
      }) + "\n",
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
    assert.strictEqual(store.getSession("supersede-res")?.sessionId, newSession.sessionId);

    await manager.closeAll();
  });
});
