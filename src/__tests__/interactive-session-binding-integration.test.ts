import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  CURRENT_SESSION_VERSION,
  SessionManager as PiSessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  listInteractiveSessionCandidates,
  resolveInteractiveSessionLocation,
  type InteractiveSessionBinding,
} from "../interactive-session-binding.js";
import { preseedInteractiveSessionBinding } from "../interactive-session-seed.js";
import {
  NewlineOnlyJsonlSplitter,
  sendPiGetState,
  spawnPiRpcSession,
} from "../pi-rpc-protocol.js";
import { EXPECTED_PI_PACKAGE_VERSION } from "../pi-runtime.js";
import { hasExited, SessionManager, waitForSpawn } from "../session-manager.js";
import { SessionStore } from "../session-store.js";
import type { AgentConfig, BotConfig } from "../types.js";
import {
  MINIME_CONTROL_WORKSPACE_ROOT_ENV,
  resolveWorkspaceContract,
} from "../workspace-contract.js";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const roundTripFixture = join(testDirectory, "fixtures", "pi-session-round-trip.mjs");
const rpcTimeoutMs = 5_000;

interface RpcSessionState {
  sessionId: string;
  sessionFile: string;
  messageCount: number;
  pendingMessageCount: number;
}

interface RoundTripResult {
  sessionId: string;
  sessionFile: string;
  cwd: string;
  entries: Array<{
    type: string;
    id: string;
    parentId: string | null;
    message?: { role?: string; content?: unknown };
  }>;
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeTranscriptHeader(
  path: string,
  sessionId: string,
  workspace: string,
): void {
  writeFileSync(path, `${JSON.stringify({
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: workspace,
  })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function makeAgent(workspaceCwd: string): AgentConfig {
  return {
    id: "integration-agent",
    workspaceCwd,
    model: "gpt-5.5",
  };
}

function makeConfig(agent: AgentConfig, piExtraExtensions?: string[]): BotConfig {
  return {
    agents: { [agent.id]: agent },
    bindings: [],
    sessionDefaults: {
      maxConcurrentSessions: 2,
      idleTimeoutMs: 60_000,
      maxMessageAgeMs: 60_000,
      requireMention: false,
      maxMediaBytes: 10 * 1024 * 1024,
    },
    ...(piExtraExtensions ? { piExtraExtensions } : {}),
  };
}

const isolatedEnvironmentKeys = [
  MINIME_CONTROL_WORKSPACE_ROOT_ENV,
  "NO_COLOR",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_EXTENSIONS_DISABLED",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
] as const;

function installIsolatedEnvironment(
  root: string,
  sessionDirectory: string,
  extensionsDisabled: boolean,
): () => void {
  const previous = new Map<string, string | undefined>();
  for (const key of isolatedEnvironmentKeys) previous.set(key, process.env[key]);

  const agentDirectory = join(root, "pi-agent");
  const xdgCache = join(root, "xdg-cache");
  const xdgConfig = join(root, "xdg-config");
  const xdgData = join(root, "xdg-data");
  const childTemp = join(root, "tmp");
  for (const path of [agentDirectory, xdgCache, xdgConfig, xdgData, childTemp]) {
    mkdirPrivate(path);
  }

  process.env[MINIME_CONTROL_WORKSPACE_ROOT_ENV] = root;
  process.env.NO_COLOR = "1";
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDirectory;
  process.env.PI_OFFLINE = "1";
  process.env.PI_SKIP_VERSION_CHECK = "1";
  process.env.PI_TELEMETRY = "0";
  process.env.TMPDIR = childTemp;
  process.env.XDG_CACHE_HOME = xdgCache;
  process.env.XDG_CONFIG_HOME = xdgConfig;
  process.env.XDG_DATA_HOME = xdgData;
  if (extensionsDisabled) process.env.PI_EXTENSIONS_DISABLED = "1";
  else delete process.env.PI_EXTENSIONS_DISABLED;

  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function requestRpcSessionState(
  child: ChildProcess,
  timeoutMs: number = rpcTimeoutMs,
): Promise<RpcSessionState> {
  await waitForSpawn(child, timeoutMs);
  const stdout = child.stdout;
  if (!stdout) throw new Error("Pinned Pi RPC stdout is unavailable");
  const responseId = `exact-binding-${process.pid}-${Date.now()}`;
  const splitter = new NewlineOnlyJsonlSplitter();

  return await new Promise<RpcSessionState>((resolveState, rejectState) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      stdout.removeListener("data", onData);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectState(error);
    };
    const onError = (error: Error) => fail(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      fail(new Error(`Pinned Pi RPC exited before get_state: code=${code} signal=${signal}`));
    };
    const onData = (chunk: Buffer | string) => {
      for (const line of splitter.push(chunk)) {
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (
          record.type !== "response"
          || record.command !== "get_state"
          || record.id !== responseId
        ) {
          continue;
        }
        const data = record.data as Record<string, unknown> | undefined;
        if (
          record.success !== true
          || !data
          || typeof data.sessionId !== "string"
          || typeof data.sessionFile !== "string"
          || typeof data.messageCount !== "number"
          || typeof data.pendingMessageCount !== "number"
        ) {
          fail(new Error("Pinned Pi RPC returned an invalid get_state response"));
          return;
        }
        if (settled) return;
        settled = true;
        cleanup();
        resolveState(data as unknown as RpcSessionState);
        return;
      }
    };
    const timer = setTimeout(
      () => fail(new Error(`Pinned Pi RPC get_state timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    sendPiGetState(child, responseId);
  });
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return await new Promise<boolean>((resolveWait) => {
    const done = (closed: boolean) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      resolveWait(closed);
    };
    const onClose = () => done(true);
    const timer = setTimeout(() => done(false), timeoutMs);
    child.once("close", onClose);
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (hasExited(child)) return;
  child.kill("SIGTERM");
  if (await waitForChildClose(child, 1_500)) return;
  child.kill("SIGKILL");
  if (!await waitForChildClose(child, 1_500)) {
    throw new Error(`Pinned Pi child ${child.pid ?? "unknown"} did not exit after SIGKILL`);
  }
}

function runRoundTripFixture(
  mode: "write" | "resume",
  binding: InteractiveSessionBinding,
): RoundTripResult {
  const child = spawnSync(process.execPath, [
    roundTripFixture,
    mode,
    binding.sessionFile,
    binding.sessionDirectory,
    binding.workspaceRealpath,
  ], {
    encoding: "utf8",
    env: {
      NO_COLOR: "1",
      PATH: process.env.PATH ?? "",
    },
    timeout: 5_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  assert.strictEqual(
    child.status,
    0,
    `round-trip fixture failed: signal=${child.signal ?? "none"} stderr=${child.stderr.trim()}`,
  );
  return JSON.parse(child.stdout) as RoundTripResult;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  return !processIsAlive(pid);
}

describe("pinned Pi exact interactive session integration", { concurrency: false }, () => {
  it("keeps transcript and bot session-store roots distinct for one canonical workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "minime-deployment-isolation-"));
    const workspace = join(root, "canonical-agent-workspace");
    const firstControlRoot = join(root, "first-control");
    const secondControlRoot = join(root, "second-control");
    mkdirPrivate(workspace);
    mkdirPrivate(firstControlRoot);
    mkdirPrivate(secondControlRoot);
    try {
      const agent = makeAgent(workspace);
      const firstLocation = resolveInteractiveSessionLocation(agent, {
        env: { PI_CODING_AGENT_SESSION_DIR: join(root, "first-pi-sessions") },
        homeDirectory: root,
      });
      const secondLocation = resolveInteractiveSessionLocation(agent, {
        env: { PI_CODING_AGENT_SESSION_DIR: join(root, "second-pi-sessions") },
        homeDirectory: root,
      });
      const firstContract = resolveWorkspaceContract({
        cwd: root,
        env: { [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: firstControlRoot },
      });
      const secondContract = resolveWorkspaceContract({
        cwd: root,
        env: { [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: secondControlRoot },
      });

      assert.strictEqual(firstLocation.workspaceRealpath, realpathSync(workspace));
      assert.strictEqual(secondLocation.workspaceRealpath, realpathSync(workspace));
      assert.notStrictEqual(firstLocation.sessionDirectory, secondLocation.sessionDirectory);
      assert.notStrictEqual(firstContract.paths.sessionStorePath, secondContract.paths.sessionStorePath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("privatizes a default-umask directory created by pinned Pi", () => {
    const createdRoot = mkdtempSync(join(tmpdir(), "minime-exact-binding-mode-"));
    chmodSync(createdRoot, 0o700);
    const root = realpathSync(createdRoot);
    const workspace = join(root, "agent-workspace");
    const sessionDirectory = join(root, "sessions");
    mkdirPrivate(workspace);
    const priorUmask = process.umask(0o022);

    try {
      PiSessionManager.create(workspace, sessionDirectory);
      assert.strictEqual(lstatSync(sessionDirectory).mode & 0o777, 0o755);

      const location = resolveInteractiveSessionLocation(makeAgent(workspace), {
        sessionDirectory,
        env: {},
        homeDirectory: root,
      });
      assert.strictEqual(location.sessionDirectory, realpathSync(sessionDirectory));
      assert.strictEqual(lstatSync(sessionDirectory).mode & 0o777, 0o700);
    } finally {
      process.umask(priorUmask);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pre-seeds one private transcript and opens only its exact path through offline RPC", {
    timeout: 15_000,
  }, async () => {
    const createdRoot = mkdtempSync(join(tmpdir(), "minime-exact-binding-rpc-"));
    chmodSync(createdRoot, 0o700);
    const root = realpathSync(createdRoot);
    const workspace = join(root, "agent-workspace");
    const decoyWorkspace = join(root, "decoy-workspace");
    const sessionDirectory = join(root, "sessions");
    const decoySessionDirectory = join(root, "decoy-sessions");
    for (const path of [workspace, decoyWorkspace, sessionDirectory, decoySessionDirectory]) {
      mkdirPrivate(path);
    }
    const restoreEnvironment = installIsolatedEnvironment(root, sessionDirectory, true);
    let child: ChildProcess | undefined;

    try {
      const agent = makeAgent(workspace);
      const location = resolveInteractiveSessionLocation(agent, {
        sessionDirectory,
        env: process.env,
        homeDirectory: root,
      });
      const binding = preseedInteractiveSessionBinding(location);
      const decoyPath = join(decoySessionDirectory, `${binding.sessionId}.jsonl`);
      writeTranscriptHeader(decoyPath, binding.sessionId, realpathSync(decoyWorkspace));
      const decoyHash = sha256(decoyPath);

      child = spawnPiRpcSession(
        agent,
        binding,
        { env: { PI_EXTENSIONS_DISABLED: "1" } },
        { askCallerAgentId: agent.id },
      );
      const state = await requestRpcSessionState(child);
      const sessionArgument = child.spawnargs.indexOf("--session");
      const sessionDirectoryArgument = child.spawnargs.indexOf("--session-dir");

      assert.strictEqual(EXPECTED_PI_PACKAGE_VERSION, "0.82.1");
      assert.match(
        child.spawnargs[1],
        /node_modules[\\/]@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]rpc-entry\.js$/,
      );
      assert.ok(sessionArgument >= 0);
      assert.ok(sessionDirectoryArgument >= 0);
      assert.strictEqual(child.spawnargs[sessionArgument + 1], binding.sessionFile);
      assert.strictEqual(child.spawnargs[sessionDirectoryArgument + 1], binding.sessionDirectory);
      assert.strictEqual(state.sessionId, binding.sessionId);
      assert.strictEqual(realpathSync(state.sessionFile), binding.sessionFile);
      assert.strictEqual(state.messageCount, 0);
      assert.strictEqual(state.pendingMessageCount, 0);
      assert.deepStrictEqual(listInteractiveSessionCandidates(location), [binding.sessionFile]);
      assert.strictEqual(sha256(decoyPath), decoyHash, "same-ID transcript in another workspace is untouched");
      assert.strictEqual(lstatSync(binding.sessionFile).mode & 0o777, 0o600);
      assert.strictEqual(lstatSync(binding.sessionDirectory).mode & 0o777, 0o700);
      if (typeof process.getuid === "function") {
        assert.strictEqual(lstatSync(binding.sessionFile).uid, process.getuid());
      }
    } finally {
      if (child) await terminateChild(child);
      restoreEnvironment();
      rmSync(root, { recursive: true, force: true });
    }
    assert.strictEqual(existsSync(root), false, "RPC smoke temporary root is removed");
    assert.ok(!child || hasExited(child), "RPC smoke child is reaped");
  });

  it("round-trips representative multi-turn history through separate pinned Pi processes", () => {
    const createdRoot = mkdtempSync(join(tmpdir(), "minime-exact-binding-round-trip-"));
    chmodSync(createdRoot, 0o700);
    const root = realpathSync(createdRoot);
    const workspace = join(root, "agent-workspace");
    const decoyWorkspace = join(root, "decoy-workspace");
    const sessionDirectory = join(root, "sessions");
    const decoySessionDirectory = join(root, "decoy-sessions");
    for (const path of [workspace, decoyWorkspace, sessionDirectory, decoySessionDirectory]) {
      mkdirPrivate(path);
    }

    try {
      const agent = makeAgent(workspace);
      const location = resolveInteractiveSessionLocation(agent, {
        sessionDirectory,
        env: {},
        homeDirectory: root,
      });
      const binding = preseedInteractiveSessionBinding(location);
      const legacyPath = join(sessionDirectory, "legacy-session.jsonl");
      const decoyPath = join(decoySessionDirectory, "decoy-session.jsonl");
      writeTranscriptHeader(legacyPath, "legacy-session-id", binding.workspaceRealpath);
      writeTranscriptHeader(decoyPath, "decoy-session-id", realpathSync(decoyWorkspace));
      const legacyHash = sha256(legacyPath);
      const decoyHash = sha256(decoyPath);

      const written = runRoundTripFixture("write", binding);
      const targetHashAfterWrite = sha256(binding.sessionFile);
      const resumed = runRoundTripFixture("resume", binding);

      assert.strictEqual(written.sessionId, binding.sessionId);
      assert.strictEqual(resumed.sessionId, binding.sessionId);
      assert.strictEqual(realpathSync(written.sessionFile), binding.sessionFile);
      assert.strictEqual(realpathSync(resumed.sessionFile), binding.sessionFile);
      assert.strictEqual(written.cwd, binding.workspaceRealpath);
      assert.deepStrictEqual(resumed.entries, written.entries);
      assert.strictEqual(resumed.entries.length, 4);
      assert.deepStrictEqual(
        resumed.entries.map((entry) => entry.message?.role),
        ["user", "assistant", "user", "assistant"],
      );
      assert.deepStrictEqual(
        resumed.entries.map((entry) => entry.parentId),
        [null, resumed.entries[0].id, resumed.entries[1].id, resumed.entries[2].id],
      );
      assert.strictEqual(sha256(binding.sessionFile), targetHashAfterWrite, "resume does not rewrite history");
      assert.strictEqual(sha256(legacyPath), legacyHash, "legacy transcript bytes are unchanged");
      assert.strictEqual(sha256(decoyPath), decoyHash, "decoy transcript bytes are unchanged");
      assert.deepStrictEqual(
        readdirSync(sessionDirectory).sort(),
        [binding.sessionFile, legacyPath].map((path) => path.slice(sessionDirectory.length + 1)).sort(),
        "round trip does not mint another transcript",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    assert.strictEqual(existsSync(root), false, "round-trip temporary root is removed");
  });

  it("retains one stored identity when real Pi startup exceeds the capture threshold", {
    timeout: 20_000,
  }, async () => {
    const createdRoot = mkdtempSync(join(tmpdir(), "minime-exact-binding-delayed-"));
    chmodSync(createdRoot, 0o700);
    const root = realpathSync(createdRoot);
    const workspace = join(root, "agent-workspace");
    const sessionDirectory = join(root, "sessions");
    const storePath = join(root, "sessions.json");
    const logDirectory = join(root, "logs");
    const extensionPath = join(root, "delayed-start.js");
    const pidMarker = join(root, "delayed-start.pid");
    for (const path of [workspace, sessionDirectory, logDirectory]) mkdirPrivate(path);
    writeFileSync(extensionPath, [
      "import { writeFileSync } from 'node:fs';",
      "export default function (pi) {",
      "  pi.on('session_start', async () => {",
      `    writeFileSync(${JSON.stringify(pidMarker)}, String(process.pid));`,
      "    await new Promise((resolve) => setTimeout(resolve, 10000));",
      "  });",
      "}",
      "",
    ].join("\n"), "utf8");
    const restoreEnvironment = installIsolatedEnvironment(root, sessionDirectory, false);
    const agent = makeAgent(workspace);
    const chatId = "delayed-start-integration";
    let delayedManager: SessionManager | undefined;
    let resumedManager: SessionManager | undefined;
    let delayedPid: number | undefined;
    let resumedPid: number | undefined;

    try {
      delayedManager = new SessionManager(
        () => makeConfig(agent, [extensionPath]),
        storePath,
        logDirectory,
        { startupTimeoutMs: 5_000 },
      );
      await assert.rejects(
        delayedManager.getOrCreateSession(chatId, agent.id),
        /did not report the exact session identity within 5000ms/,
      );

      assert.ok(existsSync(pidMarker), "delayed real Pi reached session_start before timing out");
      delayedPid = Number(readFileSync(pidMarker, "utf8"));
      assert.ok(Number.isSafeInteger(delayedPid) && delayedPid > 0);
      assert.strictEqual(await waitForProcessExit(delayedPid, 2_000), true, "timed-out Pi child is reaped");
      assert.strictEqual(delayedManager.getActiveCount(), 0);

      const storedAfterTimeout = new SessionStore(storePath).getSession(chatId);
      assert.strictEqual(storedAfterTimeout?.bindingState, "bound");
      if (storedAfterTimeout?.bindingState !== "bound") {
        throw new Error("delayed startup did not retain a bound session");
      }
      const location = resolveInteractiveSessionLocation(agent, {
        sessionDirectory,
        env: process.env,
        homeDirectory: root,
      });
      assert.deepStrictEqual(listInteractiveSessionCandidates(location), [storedAfterTimeout.sessionFile]);

      process.env.PI_EXTENSIONS_DISABLED = "1";
      resumedManager = new SessionManager(
        () => makeConfig(agent),
        storePath,
        logDirectory,
        { startupTimeoutMs: rpcTimeoutMs },
      );
      const resumed = await resumedManager.getOrCreateSession(chatId, agent.id);
      resumedPid = resumed.child.pid;
      assert.strictEqual(resumed.sessionId, storedAfterTimeout.sessionId);
      assert.strictEqual(resumed.sessionFile, storedAfterTimeout.sessionFile);
      assert.deepStrictEqual(listInteractiveSessionCandidates(location), [storedAfterTimeout.sessionFile]);
      assert.ok(resumedPid && processIsAlive(resumedPid));

      await resumedManager.closeAll();
      assert.strictEqual(await waitForProcessExit(resumedPid!, 2_000), true, "resumed Pi child is reaped");
      const storedAfterResume = new SessionStore(storePath).getSession(chatId);
      assert.strictEqual(storedAfterResume?.bindingState, "bound");
      if (storedAfterResume?.bindingState === "bound") {
        assert.strictEqual(storedAfterResume.sessionId, storedAfterTimeout.sessionId);
        assert.strictEqual(storedAfterResume.sessionFile, storedAfterTimeout.sessionFile);
      }
    } finally {
      await resumedManager?.closeAll();
      await delayedManager?.closeAll();
      restoreEnvironment();
      rmSync(root, { recursive: true, force: true });
    }
    assert.strictEqual(existsSync(root), false, "delayed-start temporary root is removed");
    if (delayedPid) assert.strictEqual(processIsAlive(delayedPid), false);
    if (resumedPid) assert.strictEqual(processIsAlive(resumedPid), false);
  });
});
