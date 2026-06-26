import { type ChildProcess } from "node:child_process";
import { chmodSync, createWriteStream, existsSync, lstatSync, mkdirSync, rmSync, type Stats, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { on } from "node:events";
import PQueue from "p-queue";
import type { SessionState, StreamLine, BotConfig, AgentConfig } from "./types.js";
import { spawnPiRpcSession, sendPiPrompt, sendPiSteer, sendPiGetState, readPiStream, parsePiRecord, NewlineOnlyJsonlSplitter, normalizePiModel, type PiSpawnExtensionOptions, type PiSpawnRuntimeEnvOptions, type PiStartupDiagnostics } from "./pi-rpc-protocol.js";
import { SessionStore } from "./session-store.js";
import { log } from "./logger.js";
import { recordResultMetrics, recordPiRetry, recordPiTurnDuration, sessionsActive, sessionCrashes, piSessionResumeDiscarded } from "./metrics.js";
import { ensureSessionMediaDir, cleanupSessionMediaDir, cleanupStaleSessionMedia } from "./media-store.js";
import { resolveWorkspaceContract } from "./workspace-contract.js";

const LOG_DIR = process.env.LOG_DIR ?? join(homedir(), ".minime", "logs");
const OUTBOX_DIR_NAME = "bot-outbox";
const STARTUP_TIMEOUT_MS = 10_000;
const PI_RESUME_NOT_FOUND_SETTLE_MS = 300;
const RESPONSE_ACTIVITY_TIMEOUT_MS = 1_800_000; // 30 minutes with no events = hung
const CRASH_BACKOFF_BASE_MS = 5_000; // Base delay for crash backoff
const MAX_CRASH_BACKOFF_MS = 60_000; // Maximum backoff delay (1 minute)
export const MAX_CRASH_RESTARTS = 5; // Block session after this many consecutive crashes
const OUTBOX_PROMPT_PREFIX = "To share a file with the user, write or copy it to this outbox directory:";
const OUTBOX_PROMPT_SUFFIX = "Files placed there will be automatically sent to the user after your response completes.";

class SessionStartupSupersededError extends Error {
  constructor() {
    super("Session startup superseded by clean");
    this.name = "SessionStartupSupersededError";
  }
}

/** Deterministic outbox directory path for a given chat. */
export function outboxDir(chatId: string): string {
  const safeChatId = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(resolveWorkspaceContract().paths.runtimeDir, OUTBOX_DIR_NAME, safeChatId);
}

function isMissingErr(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function assertOwnedByCurrentUser(path: string, stat: Stats): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid.call(process)) {
    throw new Error(`Refusing to use ${path}: owned by uid ${stat.uid}`);
  }
}

function verifyPrivateDir(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to use ${path}: it is a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to use ${path}: not a directory`);
  }
  assertOwnedByCurrentUser(path, stat);
  if ((stat.mode & 0o777) !== 0o700) {
    chmodSync(path, 0o700);
  }
}

function ensurePrivateDir(path: string): void {
  try {
    verifyPrivateDir(path);
    return;
  } catch (err) {
    if (!isMissingErr(err)) {
      throw err;
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  verifyPrivateDir(path);
}

function removeOutboxDirIfPresent(path: string): void {
  if (!existsSync(path)) return;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      unlinkSync(path);
      return;
    }
  } catch (err) {
    if (isMissingErr(err)) return;
    throw err;
  }
  rmSync(path, { recursive: true, force: true });
}

function prepareOutboxDir(chatId: string): string {
  const runtimeDir = resolveWorkspaceContract().paths.runtimeDir;
  const outboxPath = join(runtimeDir, OUTBOX_DIR_NAME, chatId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  const outboxBase = join(runtimeDir, OUTBOX_DIR_NAME);
  ensurePrivateDir(runtimeDir);
  ensurePrivateDir(outboxBase);
  removeOutboxDirIfPresent(outboxPath);
  ensurePrivateDir(outboxPath);
  return outboxPath;
}

export function appendOutboxInstruction(text: string, outboxPath: string): string {
  return [
    text,
    `${OUTBOX_PROMPT_PREFIX} ${outboxPath}`,
    OUTBOX_PROMPT_SUFFIX,
  ].join("\n\n");
}

/** Check whether a child process has exited (by exit code or signal). */
export function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * Read the startup stderr buffered on a Pi child by `spawnPiRpcSession`. Returns
 * "" before any stderr arrived or when a mock child has no accessor. Used by
 * the spawn-failure classifier to detect Pi's "No session found matching" signal.
 */
function piStartupStderr(child: ChildProcess): string {
  const reader = (child as unknown as PiStartupDiagnostics).piStartupStderr;
  return typeof reader === "function" ? reader() : "";
}

/**
 * Parse one raw JSONL record from a Pi child's stdout via the protocol module's
 * shared `parsePiRecord` (single source of truth for the JSONL framing/guard
 * rules) and, if it is a SystemInit (get_state) record, return its non-empty
 * session_id; otherwise null.
 */
function parsePiSystemInitId(record: string): string | null {
  const line = parsePiRecord(record);
  if (line && line.type === "system" && typeof line.session_id === "string" && line.session_id.length > 0) {
    return line.session_id;
  }
  return null;
}

export interface ActiveSession {
  child: ChildProcess;
  sessionId: string;
  agentId: string;
  /** Provider is retained temporarily for status/reporting while runtime is Pi-only. */
  provider: "pi";
  /** Spawn-time Pi model after normalization. */
  model: string;
  /** Spawn-time Pi thinking level, when configured. */
  thinking?: AgentConfig["thinking"];
  queue: PQueue;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Idle timeout baked at spawn time from config. */
  idleTimeoutMs: number;
  lastActivity: number;
  /** Timestamp when current turn started processing, null if idle. */
  processingStartedAt: number | null;
  /** Timestamp of last successful response (result received). */
  lastSuccessAt: number | null;
  /** Number of times this session's subprocess was restarted. */
  restartCount: number;
  /** Per-session outbox directory for file delivery. */
  outboxPath: string;
}

export interface SessionHealth {
  pid: number | null;
  alive: boolean;
  agentId: string;
  sessionId: string;
  provider: "pi";
  model: string;
  thinking?: AgentConfig["thinking"];
  idleMs: number;
  /** Milliseconds since current turn started, or null if not processing. */
  processingMs: number | null;
  /** Timestamp of last successful response, or null if none yet. */
  lastSuccessAt: number | null;
  restartCount: number;
}

function normalizedSessionModel(agent: AgentConfig): string {
  return normalizePiModel(agent.model);
}

/**
 * Wait for a child process to emit 'spawn' (successful start).
 * Rejects if the process emits 'error', exits early, or times out.
 */
export function waitForSpawn(child: ChildProcess, timeoutMs: number = STARTUP_TIMEOUT_MS): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      removeListeners();
      child.kill("SIGKILL");
      reject(new Error(`Pi subprocess did not start within ${timeoutMs}ms`));
    }, timeoutMs);

    function removeListeners() {
      clearTimeout(timer);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    }

    function onSpawn() {
      removeListeners();
      resolve();
    }

    function onError(err: Error) {
      removeListeners();
      reject(new Error(`Pi subprocess failed to start: ${err.message}`));
    }

    function onExit(code: number | null, signal: string | null) {
      removeListeners();
      reject(new Error(`Pi subprocess exited during startup: code=${code} signal=${signal}`));
    }

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export class SessionManager {
  private active: Map<string, ActiveSession> = new Map();
  /** Restart counts survive crash recovery (active.delete) so they accumulate. */
  private restartCounts: Map<string, number> = new Map();
  /** Per-chat active-session teardown barrier before shared dirs can be reused. */
  private sessionTeardowns: Map<string, Promise<void>> = new Map();
  /**
   * Per-chat startup generation. `destroySession` (/clean) bumps it; an in-flight
   * `getOrCreateSession` captures it at entry and re-checks before persisting, so
   * older startup work cannot re-create state a clean just removed.
   */
  private sessionGenerations: Map<string, number> = new Map();
  private store: SessionStore;
  private loadConfig: () => BotConfig;
  private logDir: string;
  private startupTimeoutMs: number;

  constructor(
    loadConfig: () => BotConfig,
    storePath?: string,
    logDir?: string,
    options?: { startupTimeoutMs?: number },
  ) {
    this.loadConfig = loadConfig;
    // Validate config at boot — fail fast if config is broken
    loadConfig();
    this.store = new SessionStore(storePath);
    this.logDir = logDir ?? LOG_DIR;
    this.startupTimeoutMs = options?.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
  }

  /**
   * Load fresh config for use at each decision point (spawn, eviction, idle timer).
   * On failure, propagates the error — no cache fallback.
   */
  private getFreshConfig(): BotConfig {
    try {
      const config = this.loadConfig();
      log.debug("session-manager", "config: reload ok");
      return config;
    } catch (err) {
      log.error("session-manager", `config: reload failed: ${(err as Error).message}`);
      throw err;
    }
  }

  /** Build a SessionState snapshot for persisting to the store. */
  private toSessionState(chatId: string, session: ActiveSession): SessionState {
    return {
      sessionId: session.sessionId,
      chatId,
      agentId: session.agentId,
      lastActivity: session.lastActivity,
    };
  }

  /**
   * Capture the Pi-minted session id by issuing get_state and reading the single
   * SystemInit record it produces. Pi mints its own id and exposes it ONLY
   * through a get_state response. Honors the single-consumer contract: this is
   * the lone reader of child.stdout during spawn and is fully stopped before any
   * sendSessionMessage opens its own fresh readPiStream. Returns null on timeout
   * or if no id surfaces (e.g. the process went idle without a system record) —
   * the session stays usable on its local id, and a later resume that can't
   * match falls to resume recovery.
   */
  private async capturePiSessionId(child: ChildProcess): Promise<string | null> {
    const stdout = child.stdout;
    // No stdout, or the child already died during/just-after spawn: nothing to
    // read. Return null so the caller falls back to the local id (or, if the
    // child exited, classifies the failure for recovery via hasExited).
    if (!stdout || hasExited(child)) return null;

    // Read stdout directly with an abortable listener rather than an
    // async-generator over stdout.iterator(): a generator early-return/timeout
    // leaves a queued return() blocked behind a pending next() on an
    // alive-but-idle stdout (destroyOnReturn:false never forces it to settle),
    // which would wedge session creation forever. `on(...)` removes its stdout
    // listeners synchronously on abort/return, and `close` ends the read when
    // the stream closes; a child 'exit' aborts promptly as a backstop.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.startupTimeoutMs);
    const onExit = () => controller.abort();
    child.once("exit", onExit);
    const splitter = new NewlineOnlyJsonlSplitter();
    try {
      sendPiGetState(child);
      for await (const [chunk] of on(stdout, "data", { signal: controller.signal, close: ["close"] })) {
        for (const record of splitter.push(chunk as Buffer)) {
          const id = parsePiSystemInitId(record);
          if (id) return id;
        }
      }
      return null;
    } catch (err) {
      // Aborted (timeout or child exit) is an expected best-effort end: the
      // session stays usable on its local id. Otherwise sendPiGetState may have
      // thrown on a closed stdin (a spawn-then-exit race) — swallow it too, but
      // log, so a dead child surfaces via normal crash recovery on the next
      // message rather than as an uncaught rejection out of spawn.
      if (!controller.signal.aborted) {
        log.warn("session-manager", `Pi get_state capture failed: ${(err as Error).message}`);
      }
      return null;
    } finally {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      controller.abort();
      // Hand stdout back idle (no flowing listeners) so the next per-message
      // readPiStream takes over cleanly; buffered chunks survive the pause.
      stdout.pause();
    }
  }

  private hasPiResumeNotFoundSignal(child: ChildProcess): boolean {
    return /No session found matching/.test(piStartupStderr(child));
  }

  private async terminateStartupChild(child: ChildProcess): Promise<void> {
    if (hasExited(child)) return;
    if (!child.killed) {
      child.kill("SIGKILL");
    }
    if (hasExited(child)) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        child.removeListener("exit", done);
        resolve();
      };
      timer = setTimeout(done, 1_000);
      child.once("exit", done);
    });
  }

  private async waitForPiResumeNotFoundSettle(child: ChildProcess): Promise<void> {
    if (this.hasPiResumeNotFoundSignal(child)) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let poll: ReturnType<typeof setInterval>;
      const done = () => {
        clearTimeout(timer);
        clearInterval(poll);
        resolve();
      };
      timer = setTimeout(done, PI_RESUME_NOT_FOUND_SETTLE_MS);
      poll = setInterval(() => {
        if (this.hasPiResumeNotFoundSignal(child)) done();
      }, 5);
    });
  }

  private async waitForSessionTeardown(chatId: string): Promise<void> {
    for (;;) {
      const teardown = this.sessionTeardowns.get(chatId);
      if (!teardown) return;
      await teardown;
    }
  }

  private async runSessionTeardown(chatId: string, teardown: () => Promise<void>): Promise<void> {
    const previous = this.sessionTeardowns.get(chatId);
    const current = (async () => {
      if (previous) {
        await previous;
      }
      await teardown();
    })();
    this.sessionTeardowns.set(chatId, current);
    try {
      await current;
    } finally {
      if (this.sessionTeardowns.get(chatId) === current) {
        this.sessionTeardowns.delete(chatId);
      }
    }
  }

  private cleanupSessionFiles(
    chatId: string,
    outboxPath: string,
    mediaCleanup: "all" | "stale",
  ): void {
    try {
      removeOutboxDirIfPresent(outboxPath);
    } catch {
      // Ignore cleanup errors
    }
    try {
      if (mediaCleanup === "stale") {
        cleanupStaleSessionMedia(chatId);
      } else {
        cleanupSessionMediaDir(chatId);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  private async waitForSessionChildExit(session: ActiveSession, chatId: string): Promise<void> {
    if (hasExited(session.child)) return;
    if (!session.child.killed) {
      session.child.kill("SIGTERM");
    }
    if (hasExited(session.child)) return;

    await new Promise<void>((resolve) => {
      let gracefulTimer: ReturnType<typeof setTimeout>;
      let killTimer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(gracefulTimer);
        clearTimeout(killTimer);
        session.child.removeListener("exit", done);
        resolve();
      };
      gracefulTimer = setTimeout(() => {
        if (!hasExited(session.child)) {
          session.child.kill("SIGKILL");
        }
      }, 5000);
      killTimer = setTimeout(() => {
        if (!hasExited(session.child)) {
          log.error("session-manager", `Subprocess did not exit after SIGKILL for chat ${chatId}`);
        }
        done();
      }, 6000);
      session.child.once("exit", done);
    });
  }

  /**
   * Perform the Pi graceful resume-recovery action: discard the unresumable
   * stored id (deletes the store record so a fresh Pi session is spawned), log,
   * bump the metric, and return a fresh (no --session) child. Callers gate this
   * on the at-most-once `alreadyRetried` flag + the "session not found" signal;
   * this performs only the discard + fresh re-spawn.
   *
   * Media: the triggering turn's media has ALREADY been staged under this chat's
   * media dir and is still tracked as in-flight — the fresh Pi session's prompt
   * will reference those paths. So we must NOT wipe the whole dir (the prior
   * `destroySession` path did, leaving the prompt pointing at deleted files).
   * Use `cleanupStaleSessionMedia`, which removes only prior-session leftovers
   * (including orphans from the failed-resume child) and preserves in-flight
   * files for the current turn.
   */
  private async discardUnresumablePiSession(
    chatId: string,
    agentId: string,
    agent: AgentConfig,
    staleSessionId: string,
    extensionOptions?: PiSpawnExtensionOptions,
    runtimeEnvOptions?: PiSpawnRuntimeEnvOptions,
  ): Promise<ChildProcess> {
    // Discard ONLY the unresumable stored id so a fresh Pi session is spawned.
    // Deleting the store record directly (instead of destroySession) avoids the
    // full media-dir wipe; in-flight files for the current turn must survive.
    // The crash count is intentionally left untouched: a resume-recovery is NOT
    // a clean reconnect, so a flapping chat keeps advancing toward the circuit
    // breaker rather than resetting toward zero on every recovery.
    this.store.deleteSession(chatId);
    // Purge prior-session leftovers (including any orphan from the failed-resume
    // child) WITHOUT deleting the file the handler just staged for this turn.
    try { cleanupStaleSessionMedia(chatId); } catch { /* ignore */ }
    log.warn("session-manager", `could not resume Pi session ${staleSessionId} — starting fresh`);
    piSessionResumeDiscarded.inc({ agent_id: agentId });
    return spawnPiRpcSession(agent, undefined, extensionOptions, runtimeEnvOptions);
  }

  /**
   * Get or create a session for a given chatId.
   * If a session exists in memory with a live process, reuse it.
   * If a session exists in store but process is dead, respawn with --resume.
   * If no session exists, create a fresh one.
   * Enforces maxConcurrentSessions via LRU eviction.
   */
  async getOrCreateSession(chatId: string, agentId: string): Promise<ActiveSession> {
    const generation = this.sessionGenerations.get(chatId) ?? 0;
    const isStartupSuperseded = () => (this.sessionGenerations.get(chatId) ?? 0) !== generation;
    const abortSupersededStartup = async (childToTerminate?: ChildProcess): Promise<never> => {
      if (childToTerminate) {
        await this.terminateStartupChild(childToTerminate);
      }
      log.warn("session-manager", `Session startup superseded by clean for chat ${chatId}`);
      throw new SessionStartupSupersededError();
    };

    await this.waitForSessionTeardown(chatId);
    if (isStartupSuperseded()) {
      await abortSupersededStartup();
    }

    // Check if session is active in memory
    let existing = this.active.get(chatId);
    if (existing && !hasExited(existing.child) && !existing.child.killed) {
      if (existing.agentId === agentId) {
        existing.lastActivity = Date.now();
        this.resetIdleTimer(chatId);
        return existing;
      }
      log.warn(
        "session-manager",
        `Closing active session for chat ${chatId}: agentId changed from "${existing.agentId}" to "${agentId}"`,
      );
      await this.closeSession(chatId, { mediaCleanup: "stale" });
      if (isStartupSuperseded()) {
        await abortSupersededStartup();
      }
      existing = undefined;
    }

    // If we had an active entry but child is dead/dying, clean it up
    if (existing) {
      // Clear idle timer to prevent it from closing the new session
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
      }
      // Ensure the child is actually dead before discarding the session;
      // a SIGTERM may have been sent (child.killed=true) but the process
      // could still be running if it ignored the signal.
      if (!hasExited(existing.child)) {
        existing.child.kill("SIGKILL");
      }
      this.active.delete(chatId);
      sessionsActive.dec();
    }
    if (isStartupSuperseded()) {
      await abortSupersededStartup();
    }

    // Reload config fresh — pick up any changes to agents/sessionDefaults
    const freshConfig = this.getFreshConfig();
    const agent = freshConfig.agents[agentId];
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // Check if we need to evict
    await this.evictIfNeeded(freshConfig);
    if (isStartupSuperseded()) {
      await abortSupersededStartup();
    }

    // Check if we have a stored session to resume (discards stale sessions)
    const { resume, sessionId } = this.resolveStoredSession(chatId, agentId, freshConfig);

    // Crash backoff: prevent rapid crash→spawn→crash loops
    const prevCrashCount = this.restartCounts.get(chatId) ?? 0;
    if (prevCrashCount >= MAX_CRASH_RESTARTS) {
      log.error("session-manager", `Session for chat ${chatId} blocked after ${prevCrashCount} consecutive crashes — use /reconnect to unblock`);
      throw new Error(`Session blocked: ${prevCrashCount} consecutive crashes for chat ${chatId}`);
    }
    if (prevCrashCount > 0) {
      const delayMs = Math.min(CRASH_BACKOFF_BASE_MS * 2 ** (prevCrashCount - 1), MAX_CRASH_BACKOFF_MS);
      log.warn("session-manager", `Crash backoff: ${delayMs}ms for chat ${chatId} (crash #${prevCrashCount})`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (isStartupSuperseded()) {
        await abortSupersededStartup();
      }
    }

    // Ensure media directory exists (do NOT wipe: a photo may have been
    // downloaded into it moments before this spawn was triggered).
    // Cleanup happens on session close, crash recovery, and via the global cap.
    // It is idempotent and non-destructive, so it is safe even for a startup
    // that a later generation check supersedes. The destructive
    // prepareOutboxDir(chatId) is deferred until AFTER the generation guard.
    ensureSessionMediaDir(chatId);

    // Spawn the agent subprocess via Pi RPC. Only a genuine resume points
    // --session at the stored Pi-minted id; a fresh start omits it (an unknown
    // id makes Pi exit with "No session found matching").
    const extensionOptions: PiSpawnExtensionOptions | undefined = freshConfig.piExtraExtensions === undefined
      ? undefined
      : { extraExtensions: freshConfig.piExtraExtensions };
    const runtimeEnvOptions: PiSpawnRuntimeEnvOptions = { askCallerAgentId: agentId };
    let child = spawnPiRpcSession(agent, resume ? sessionId : undefined, extensionOptions, runtimeEnvOptions);

    // Graceful Pi resume-recovery state (signal-matched, inline, at-most-once):
    // Pi flushes a session to disk only after agent_end/SIGTERM, so a restart
    // MID-turn legitimately yields "No session found matching". Rather than
    // crash-loop a chat to BLOCKED on a stale stored id, discard it and start
    // fresh EXACTLY once. `effectiveResume` flips false after the discard so the
    // fresh spawn's media handling matches a fresh start; `alreadyRetried` caps
    // the recovery at one attempt (any second failure falls through to backoff).
    let effectiveResume = resume;
    let effectiveSessionId = sessionId;
    let alreadyRetried = false;

    // Verify the subprocess started and capture its Pi-minted session id.
    // A real `pi` handed a stale --session does NOT fail at spawn: Node emits
    // 'spawn' before all other events, so waitForSpawn RESOLVES, and only THEN
    // does Pi print "No session found matching" and exit 1. So a resume failure
    // surfaces during the get_state capture (the child is already dead by then),
    // NOT as a spawn rejection. Detect that here and throw into the shared catch,
    // which classifies BOTH a spawn rejection and a post-spawn startup exit the
    // same way: the "session not found" signal → one inline fresh start;
    // anything else → crash-backoff.
    for (;;) {
      try {
        await waitForSpawn(child, this.startupTimeoutMs);
        if (isStartupSuperseded()) {
          throw new SessionStartupSupersededError();
        }

        // Prevent EPIPE from becoming uncaughtException when the subprocess
        // dies — wired before any capture write so a racing child death on the
        // get_state stdin write is logged, not thrown.
        child.stdin?.on("error", (err) => {
          log.error("session-manager", `stdin error for chat ${chatId}: ${err.message}`);
        });

        const piSessionId = await this.capturePiSessionId(child);
        if (piSessionId) {
          // Capture succeeded — the process is alive and answered get_state.
          effectiveSessionId = piSessionId;
        } else if (effectiveResume && !alreadyRetried) {
          // A stale resume can close stdout before Node has delivered the stderr
          // chunk or exit state. Give both streams a short chance to settle before
          // accepting the local-id fallback for this resumed child.
          await this.waitForPiResumeNotFoundSettle(child);
          if (this.hasPiResumeNotFoundSignal(child)) {
            throw new Error(`Pi resume session not found during startup: ${sessionId}`);
          }
          if (hasExited(child)) {
            throw new Error(`Pi subprocess exited during startup: code=${child.exitCode}`);
          }
        } else if (hasExited(child)) {
          // No id AND the child already exited: it spawned but died during
          // startup (e.g. a stale --session). Throw into the shared catch for
          // classification (recovery vs backoff), same as a spawn rejection.
          throw new Error(`Pi subprocess exited during startup: code=${child.exitCode}`);
        }
        // Else: no id but the child is still alive — capture timed out or the
        // process went idle without a SystemInit. The session stays functional
        // on its local id (a later resume just can't target it).
        break;
      } catch (err) {
        if (err instanceof SessionStartupSupersededError || isStartupSuperseded()) {
          await abortSupersededStartup(child);
        }

        // Ensure child is dead and reaped before inspecting/throwing.
        await this.terminateStartupChild(child);
        if (isStartupSuperseded()) {
          await abortSupersededStartup(child);
        }

        // Pi-only graceful resume-recovery. Only when resuming, only on the
        // specific "session not found" stderr signal, and
        // only once: discard the unresumable stored session and start fresh
        // INLINE (no recursion into getOrCreateSession, no --session). Any other
        // failure — and any second failure — falls through to crash-backoff.
        if (effectiveResume && !alreadyRetried && this.hasPiResumeNotFoundSignal(child)) {
          alreadyRetried = true;
          child = await this.discardUnresumablePiSession(chatId, agentId, agent, sessionId, extensionOptions, runtimeEnvOptions);
          effectiveResume = false;
          effectiveSessionId = randomUUID();
          continue;
        }

        // No session will be created to own files just downloaded for this turn;
        // wipe the dir so they don't sit around until the next startup/cap eviction.
        // Skip when resuming: the stored session record stays intact, so a later
        // successful resume will continue the same conversation history — and that
        // history may reference files already in this dir from prior turns.
        if (!effectiveResume) {
          try { cleanupSessionMediaDir(chatId); } catch { /* ignore */ }
        }
        // Increment crash count so startup failures contribute to backoff
        const count = (this.restartCounts.get(chatId) ?? 0) + 1;
        this.restartCounts.set(chatId, count);
        log.error("session-manager", `Startup failure for chat ${chatId} (crash #${count}): ${(err as Error).message}`);
        throw err;
      }
    }

    // Pipe stderr to log file (on the child that ultimately started).
    this.setupStderrLogging(chatId, child);

    // Restart/crash count accumulates via setupCrashRecovery and survives
    // active.delete(). Reset to 0 for fresh sessions (no existing, no resume).
    const restartCount = this.restartCounts.get(chatId) ?? 0;
    if (!existing && !resume) {
      this.restartCounts.set(chatId, 0);
    }

    // Startup generation guard: if a destroySession (/clean) for this chat ran
    // while this startup was in flight, the generation has advanced. Abort
    // WITHOUT persisting so an older startup cannot undo a clean. Reap only the
    // newly spawned child; leave shared per-chat outbox/media alone (a newer
    // post-clean startup may already own them) and do NOT count this as a crash —
    // it is a superseded startup, not a failure.
    if (isStartupSuperseded()) {
      await abortSupersededStartup(child);
    }

    // Clean and recreate the outbox directory ONLY after the generation guard
    // passes, immediately before creating the ActiveSession that owns it. This
    // is destructive (it wipes the per-chat outbox), so a superseded older
    // startup must never reach it — otherwise it could blow away an outbox a
    // newer post-clean startup already owns.
    let outboxPath: string;
    try {
      outboxPath = prepareOutboxDir(chatId);
    } catch (err) {
      await this.terminateStartupChild(child);
      throw err;
    }

    const session: ActiveSession = {
      child,
      sessionId: effectiveSessionId,
      agentId,
      provider: "pi",
      model: normalizedSessionModel(agent),
      thinking: agent.thinking,
      queue: new PQueue({ concurrency: 1 }),
      idleTimer: null,
      idleTimeoutMs: freshConfig.sessionDefaults.idleTimeoutMs,
      lastActivity: Date.now(),
      processingStartedAt: null,
      lastSuccessAt: null,
      restartCount,
      outboxPath,
    };

    this.active.set(chatId, session);
    sessionsActive.inc();

    // Persist to store
    this.store.setSession(chatId, this.toSessionState(chatId, session));

    // Set up crash recovery
    this.setupCrashRecovery(chatId, child);

    // Start idle timer
    this.resetIdleTimer(chatId);

    return session;
  }

  /**
   * Send a message to a session, creating it if needed.
   * Returns an async generator of parsed stream lines.
   * Messages are queued per-session (concurrency=1).
   */
  async *sendSessionMessage(
    chatId: string,
    agentId: string,
    text: string
  ): AsyncGenerator<StreamLine> {
    const session = await this.getOrCreateSession(chatId, agentId);

    // Async channel: queue task pushes lines, generator yields them in real-time
    const buffer: StreamLine[] = [];
    let notify: (() => void) | null = null;
    let done = false;
    let taskError: Error | null = null;

    const push = (line: StreamLine) => {
      buffer.push(line);
      if (notify) {
        notify();
        notify = null;
      }
    };

    const finish = (err?: Error) => {
      if (err) taskError = err;
      done = true;
      if (notify) {
        notify();
        notify = null;
      }
    };

    // Start the queue task — do NOT await, so we can yield concurrently
    const taskPromise = session.queue.add(async () => {
      let activityTimer: ReturnType<typeof setTimeout> | null = null;
      let killEscalationTimer: ReturnType<typeof setTimeout> | null = null;
      const clearActivityTimers = () => {
        if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
        // Only cancel the SIGKILL escalation if the child has already exited;
        // if SIGTERM was sent and the child is still alive, let escalation
        // complete to avoid orphaning the process.
        if (killEscalationTimer && hasExited(session.child)) {
          clearTimeout(killEscalationTimer); killEscalationTimer = null;
        }
      };
      try {
        // Always deliver Pi prompts with streamingBehavior:"followUp" (Defect
        // B). Pi ignores the field when the agent is idle (the prompt runs as
        // a fresh turn) and honors it when the agent is still mid-turn — the
        // bot's MessageQueue.busy / processingStartedAt tracking can desync
        // from the child's real lifecycle, and a bare prompt sent into that
        // window would be rejected with "already processing" and the message
        // lost. followUp queues it behind the live turn instead.
        sendPiPrompt(session.child, appendOutboxInstruction(text, session.outboxPath), "followUp");
        session.lastActivity = Date.now();
        session.processingStartedAt = Date.now();
        this.resetIdleTimer(chatId);

        // Update store with new activity time
        this.store.setSession(chatId, this.toSessionState(chatId, session));

        // Read response lines until we get a result.
        // Activity timeout: if no events arrive for RESPONSE_ACTIVITY_TIMEOUT_MS,
        // kill the subprocess to unstick the queue (handles hung processes).
        let gotResult = false;
        const resetActivityTimer = () => {
          // Only reset the activity timer; never cancel a pending SIGKILL escalation.
          // Once we've decided to kill the process, the escalation must complete.
          if (activityTimer) { clearTimeout(activityTimer); activityTimer = null; }
          activityTimer = setTimeout(() => {
            if (!hasExited(session.child)) {
              log.error("session-manager", `Response activity timeout for chat ${chatId} — killing subprocess`);
              if (!session.child.killed) {
                session.child.kill("SIGTERM");
              }
              // Escalate to SIGKILL if SIGTERM doesn't terminate within 5s
              if (!killEscalationTimer) {
                killEscalationTimer = setTimeout(() => {
                  if (!hasExited(session.child)) {
                    log.error("session-manager", `Subprocess ignored SIGTERM for chat ${chatId} — sending SIGKILL`);
                    session.child.kill("SIGKILL");
                  }
                }, 5000);
              }
            }
          }, RESPONSE_ACTIVITY_TIMEOUT_MS);
        };
        resetActivityTimer();
        // Pi turns carry no duration_ms in their result, so measure wall-clock
        // from the prompt send for the Pi-specific
        // histogram. processingStartedAt is reset to null after the loop, so
        // capture it now while it is still set.
        const turnStartedAt = session.processingStartedAt ?? Date.now();
        const stream = readPiStream(session.child);
        for await (const line of stream) {
          resetActivityTimer();
          push(line);
          // Pi auto-retry telemetry: increment once per retry on auto_retry_start
          // (auto_retry_end signals recovery — counting it too would double-count).
          if (
            line.type === "assistant" &&
            line.subtype === "rate_limit_event" &&
            line.pi_event_type === "auto_retry_start"
          ) {
            const errorMessage = typeof line.error_message === "string" ? line.error_message : undefined;
            recordPiRetry(session.agentId, errorMessage);
          }
          if (line.type === "result") {
            gotResult = true;
            session.lastSuccessAt = Date.now();
            session.lastActivity = Date.now();
            // Reset crash backoff on successful response
            this.restartCounts.set(chatId, 0);
            recordResultMetrics(session.agentId, line);
            recordPiTurnDuration(session.agentId, (Date.now() - turnStartedAt) / 1000);
            break;
          }
        }
        clearActivityTimers();
        session.processingStartedAt = null;
        if (!gotResult) {
          finish(new Error("Pi subprocess exited before sending a result"));
          return;
        }
        finish();
      } catch (err) {
        clearActivityTimers();
        session.processingStartedAt = null;
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    // Yield lines as they arrive from the queue task
    try {
      while (true) {
        while (buffer.length > 0) {
          yield buffer.shift()!;
        }
        if (done) break;
        await new Promise<void>((r) => { notify = r; });
      }
      if (taskError) throw taskError;
    } finally {
      // Ensure queue bookkeeping completes even if consumer stops early
      await taskPromise;
    }
  }

  /**
   * Extend the idle window for an active session without creating one.
   * Called by message handlers while staging incoming payloads (e.g. media
   * downloads) so the idle timer cannot fire mid-download and wipe the
   * session media dir before the queued message is consumed.
   */
  touchActivity(chatId: string): void {
    const session = this.active.get(chatId);
    if (!session) return;
    session.lastActivity = Date.now();
    this.resetIdleTimer(chatId);
  }

  /** Reset the idle timer for a session. After timeout, session is closed. */
  resetIdleTimer(chatId: string): void {
    const session = this.active.get(chatId);
    if (!session) return;

    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    session.idleTimer = setTimeout(() => {
      this.closeSession(chatId).catch(() => {});
    }, session.idleTimeoutMs);
  }

  /** Close a session: persist state, SIGTERM child, clean up. */
  async closeSession(
    chatId: string,
    {
      persist = true,
      mediaCleanup = "all",
    }: { persist?: boolean; mediaCleanup?: "all" | "stale" } = {},
  ): Promise<void> {
    await this.runSessionTeardown(chatId, () => this.closeSessionInternal(chatId, { persist, mediaCleanup }));
  }

  private async closeSessionInternal(
    chatId: string,
    {
      persist = true,
      mediaCleanup = "all",
    }: { persist?: boolean; mediaCleanup?: "all" | "stale" } = {},
  ): Promise<void> {
    // Always clear crash count so /reconnect unblocks circuit-broken chats
    this.restartCounts.delete(chatId);

    const session = this.active.get(chatId);
    if (!session) return;

    // Clear idle timer
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }

    // Persist final state (skipped by destroySession to prevent race)
    if (persist) {
      this.store.setSession(chatId, this.toSessionState(chatId, session));
    }

    // Remove from active map first to prevent re-entry
    this.active.delete(chatId);
    sessionsActive.dec();

    // Clean before termination so old files are gone immediately, then sweep
    // again after exit for any last writes the dying child made.
    this.cleanupSessionFiles(chatId, session.outboxPath, mediaCleanup);

    // Gracefully terminate (even if SIGTERM was already sent elsewhere)
    await this.waitForSessionChildExit(session, chatId);
    this.cleanupSessionFiles(chatId, session.outboxPath, "stale");
  }

  /**
   * Graceful shutdown: steer a notification into busy Pi sessions, wait for
   * active turns to finish (up to timeoutMs), then log outcomes.
   * Called before closeAll() during SIGTERM/SIGINT handling.
   */
  async gracefulShutdown(timeoutMs: number): Promise<void> {
    const busySessions: { chatId: string; startedAt: number }[] = [];

    const shutdownNotice =
      "[System: Bot is shutting down for restart. Do NOT attempt to restart the bot — the restart is already in progress. Wrap up your current task.]";
    for (const [chatId, session] of this.active) {
      if (session.processingStartedAt !== null) {
        // Deliver the shutdown notice through Pi's live mid-turn channel.
        try {
          if (!hasExited(session.child)) {
            sendPiSteer(session.child, shutdownNotice);
          }
        } catch { /* best-effort */ }
        busySessions.push({ chatId, startedAt: session.processingStartedAt });
      }
    }

    if (busySessions.length === 0) {
      log.info("session-manager", "Graceful shutdown: no busy sessions");
      return;
    }

    log.info("session-manager", `Graceful shutdown: waiting for ${busySessions.length} session(s) (timeout: ${timeoutMs}ms)`);

    // Wait for all busy session queues to go idle, or timeout
    const idlePromises = busySessions.map(({ chatId }) => {
      const session = this.active.get(chatId);
      return session?.queue.onIdle() ?? Promise.resolve();
    });

    await Promise.race([
      Promise.all(idlePromises),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);

    // Log each session's outcome
    for (const { chatId, startedAt } of busySessions) {
      const session = this.active.get(chatId);
      const duration = Date.now() - startedAt;
      if (!session || session.processingStartedAt === null) {
        log.info("session-manager", `Shutdown: session ${chatId} finished naturally (${duration}ms)`);
      } else {
        log.warn("session-manager", `Shutdown: session ${chatId} timed out (${duration}ms)`);
      }
    }
  }

  /**
   * Destroy a session: close it AND delete stored state.
   * Next message will start a completely fresh session (no --resume).
   *
   * Deletes from store BEFORE closing and skips closeSession's persist
   * to prevent a concurrent getOrCreateSession from resuming with
   * --resume during the child-exit await window.
   */
  async destroySession(chatId: string): Promise<void> {
    const hadActiveSession = this.active.has(chatId);
    // Bump the startup generation BEFORE deleting store state so any in-flight
    // getOrCreateSession for this chat is superseded and cannot re-persist state.
    this.sessionGenerations.set(chatId, (this.sessionGenerations.get(chatId) ?? 0) + 1);
    this.store.deleteSession(chatId);
    // If there is no active session, clean orphaned media now, before a fresh
    // post-clean startup can own the same per-chat media directory.
    if (!hadActiveSession) {
      try { cleanupSessionMediaDir(chatId); } catch { /* ignore */ }
    }
    await this.closeSession(chatId, { persist: false });
  }

  /** Close all sessions gracefully. For shutdown. */
  async closeAll(): Promise<void> {
    const chatIds = [...this.active.keys()];
    await Promise.all(chatIds.map((id) => this.closeSession(id)));
  }

  /** Number of active sessions with live processes. */
  getActiveCount(): number {
    return this.active.size;
  }

  /** Get active session for a chatId (for monitoring/status). */
  getActive(chatId: string): ActiveSession | undefined {
    return this.active.get(chatId);
  }

  /** Get subprocess health info for a session (for /status command). */
  getSessionHealth(chatId: string): SessionHealth | undefined {
    const session = this.active.get(chatId);
    if (!session) return undefined;

    const alive = !hasExited(session.child) && !session.child.killed;
    const now = Date.now();

    return {
      pid: session.child.pid ?? null,
      alive,
      agentId: session.agentId,
      sessionId: session.sessionId,
      provider: session.provider,
      model: session.model,
      thinking: session.thinking,
      idleMs: now - session.lastActivity,
      processingMs: session.processingStartedAt ? now - session.processingStartedAt : null,
      lastSuccessAt: session.lastSuccessAt,
      restartCount: this.restartCounts.get(chatId) ?? 0,
    };
  }

  /**
   * Determine if a stored session should be resumed or discarded.
   * Discards and logs if the agentId changed or the stored agent was deleted.
   */
  resolveStoredSession(chatId: string, agentId: string, config?: BotConfig): { resume: boolean; sessionId: string } {
    const stored = this.store.getSession(chatId);
    if (!stored || stored.sessionId === "") {
      return { resume: false, sessionId: randomUUID() };
    }

    const agents = config ? config.agents : this.getFreshConfig().agents;
    const agentDeleted = !(stored.agentId in agents);
    const agentMismatch = stored.agentId !== agentId;

    if (agentMismatch || agentDeleted) {
      const reason = agentDeleted
        ? `agent "${stored.agentId}" no longer exists`
        : `agentId changed from "${stored.agentId}" to "${agentId}"`;
      log.warn("session-manager", `Discarding stale session for chat ${chatId}: ${reason}`);
      this.store.deleteSession(chatId);
      // Purge leftover media belonging to the discarded session so the new
      // agent cannot read the prior agent's files. Files currently tracked
      // as in-flight (the download the active handler just enqueued) are
      // preserved; anything else — including orphans from a crashed prior
      // process — is wiped.
      try { cleanupStaleSessionMedia(chatId); } catch { /* ignore */ }
      return { resume: false, sessionId: randomUUID() };
    }

    return { resume: true, sessionId: stored.sessionId };
  }

  /** LRU eviction: close the session with oldest lastActivity. */
  private async evictIfNeeded(config: BotConfig): Promise<void> {
    const maxConcurrentSessions = config.sessionDefaults.maxConcurrentSessions;
    if (this.active.size < maxConcurrentSessions) return;

    // Find session with oldest lastActivity
    let oldest: { chatId: string; lastActivity: number } | null = null;
    for (const [chatId, session] of this.active) {
      if (!oldest || session.lastActivity < oldest.lastActivity) {
        oldest = { chatId, lastActivity: session.lastActivity };
      }
    }

    if (oldest) {
      await this.closeSession(oldest.chatId);
    }
  }

  /** Set up crash recovery: when child exits unexpectedly, clean up. */
  private setupCrashRecovery(chatId: string, child: ChildProcess): void {
    child.once("exit", (code, signal) => {
      const session = this.active.get(chatId);
      if (!session || session.child !== child) return;

      // Clear idle timer
      if (session.idleTimer) {
        clearTimeout(session.idleTimer);
      }

      // Remove from active map (not from store — session can be resumed)
      this.active.delete(chatId);
      sessionsActive.dec();

      // Clean up media directory — files are scoped to this session's lifetime
      try { cleanupSessionMediaDir(chatId); } catch { /* ignore */ }

      if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGKILL") {
        sessionCrashes.inc({ agent_id: session.agentId });
        // Increment crash count for backoff (survives active.delete)
        const count = (this.restartCounts.get(chatId) ?? 0) + 1;
        this.restartCounts.set(chatId, count);
        log.error(
          "session-manager",
          `Session for chat ${chatId} crashed: code=${code} signal=${signal} (crash #${count})`,
        );
      }
    });
  }

  /** Pipe child stderr to a log file. */
  private setupStderrLogging(chatId: string, child: ChildProcess): void {
    if (!child.stderr) return;

    const logDir = this.logDir;
    mkdirSync(logDir, { recursive: true });

    const safeChatId = chatId.replace(/:/g, "_");
    const logPath = `${logDir}/session-${safeChatId}.log`;
    const logStream = createWriteStream(logPath, { flags: "a" });

    logStream.on("error", (err) => {
      log.error("session-manager", `Log write error for chat ${chatId}: ${err.message}`);
    });

    // pipe() auto-ends logStream when stderr emits 'end', which fires after
    // all buffered data has been consumed. Do NOT manually call logStream.end()
    // on the 'exit' event — 'exit' can fire while stderr data is still in
    // kernel buffers, causing data loss (0-byte log files).
    child.stderr.pipe(logStream);
  }
}
