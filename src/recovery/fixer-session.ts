#!/usr/bin/env node

import { on } from "node:events";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CURRENT_SESSION_VERSION,
  SessionManager as PiSessionManager,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config.js";
import {
  NewlineOnlyJsonlSplitter,
  PI_RECOVERY_WRAPPER_RELPATHS,
  PiStartupBlockingUiError,
  normalizePiModel,
  parsePiStartupRecord,
  piExtensionRelpathForDir,
  readPiStream,
  resolveValidatedPiAgentWorkspaceCwd,
  sendPiGetState,
  sendPiPrompt,
  spawnPiRpcSession,
  type PiSpawnExtensionOptions,
  type PiSpawnRuntimeEnvOptions,
  type PiStartupDiagnostics,
} from "../pi-rpc-protocol.js";
import { resolveRequiredRecoveryExtensionArgs, type RecoveryMode } from "../pi-extensions/recovery-mode.js";
import {
  RecoveryProtocolClient,
  readRecoveryRuntimeContract,
  type RecoveryFixerState,
  type RecoveryRuntimeVersions,
  type RecoverySessionBinding,
} from "../pi-extensions/recovery-protocol.js";
import { EXPECTED_PI_PACKAGE_VERSION } from "../pi-runtime.js";
import { waitForSpawn } from "../session-manager.js";
import type { AgentConfig, ResultMessage } from "../types.js";
import { resolveWorkspaceContract } from "../workspace-contract.js";

export const RECOVERY_RUNNER_ENV = Object.freeze({
  agentId: "MINIME_RECOVERY_AGENT_ID",
  sessionRoot: "MINIME_RECOVERY_SESSION_ROOT",
  startupTimeoutSeconds: "MINIME_RECOVERY_STARTUP_TIMEOUT_SECONDS",
  resumeTimeoutSeconds: "MINIME_RECOVERY_RESUME_TIMEOUT_SECONDS",
  renewSeconds: "MINIME_RECOVERY_RENEW_SECONDS",
  runTimeoutSeconds: "MINIME_RECOVERY_RUN_TIMEOUT_SECONDS",
  piExecutable: "MINIME_RECOVERY_PI_EXECUTABLE",
  supervisorProcessGroup: "MINIME_RECOVERY_SUPERVISOR_PROCESS_GROUP",
} as const);

const MAX_TRANSCRIPT_HEADER_BYTES = 64 * 1024;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const DEFAULT_RENEW_MS = 30_000;
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60_000;

export interface RecoveryTranscriptInspection {
  readable: boolean;
  reason: "ok" | "missing" | "unsafe" | "unreadable" | "invalid";
  canonicalPath?: string;
}

export interface RecoverySessionHandle {
  child: ChildProcess;
  bindingId: number;
  sessionId: string;
  sessionDirectory: string;
  transcriptPath: string;
  replaced: boolean;
}

export interface PreseededRecoverySession {
  sessionId: string;
  transcriptPath: string;
}

export interface RecoverySessionSeedOptions {
  openSession?: (
    transcriptPath: string,
    sessionDirectory: string,
    workspaceCwd: string,
  ) => Pick<PiSessionManager, "getSessionId" | "getSessionFile">;
}

export interface RecoveryFixerRunResult {
  status: "settled" | "provider_error" | "lease_lost" | "timed_out";
  session: Omit<RecoverySessionHandle, "child">;
  result?: ResultMessage;
}

export function classifyRecoveryFixerResult(result: ResultMessage | undefined): "settled" | "provider_error" {
  return result?.is_error ? "provider_error" : "settled";
}

interface RecoveryFixerRunnerOptions {
  env?: NodeJS.ProcessEnv;
  client?: RecoveryProtocolClient;
  spawn?: typeof spawnPiRpcSession;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  processKill?: (pid: number, signal: NodeJS.Signals) => void;
  startupTimeoutMs?: number;
  renewMs?: number;
  runTimeoutMs?: number;
}

interface RecoveryRunnerContract {
  agentId: string;
  sessionRoot: string;
  startupTimeoutMs: number;
  resumeTimeoutMs: number;
  renewMs: number;
  runTimeoutMs: number;
  piExecutable: string;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value || value.trim() !== value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 4_096) {
    throw new Error(`Recovery runner environment is invalid: ${key}`);
  }
  return value;
}

function secondsEnv(env: NodeJS.ProcessEnv, key: string, fallbackMs: number, maxSeconds: number): number {
  const raw = env[key];
  if (raw === undefined) return fallbackMs;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error(`Recovery runner environment is invalid: ${key}`);
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds > maxSeconds) {
    throw new Error(`Recovery runner environment is invalid: ${key}`);
  }
  return seconds * 1_000;
}

function absoluteRunnerPath(env: NodeJS.ProcessEnv, key: string): string {
  const value = requiredEnv(env, key);
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new Error(`Recovery runner environment is invalid: ${key}`);
  }
  return value;
}

export function readRecoveryRunnerContract(env: NodeJS.ProcessEnv = process.env): RecoveryRunnerContract {
  const sessionRoot = absoluteRunnerPath(env, RECOVERY_RUNNER_ENV.sessionRoot);
  return {
    agentId: requiredEnv(env, RECOVERY_RUNNER_ENV.agentId),
    sessionRoot,
    startupTimeoutMs: secondsEnv(env, RECOVERY_RUNNER_ENV.startupTimeoutSeconds, DEFAULT_STARTUP_TIMEOUT_MS, 300),
    resumeTimeoutMs: secondsEnv(env, RECOVERY_RUNNER_ENV.resumeTimeoutSeconds, DEFAULT_STARTUP_TIMEOUT_MS, 300),
    renewMs: secondsEnv(env, RECOVERY_RUNNER_ENV.renewSeconds, DEFAULT_RENEW_MS, 3_600),
    runTimeoutMs: secondsEnv(env, RECOVERY_RUNNER_ENV.runTimeoutSeconds, DEFAULT_RUN_TIMEOUT_MS, 86_400),
    piExecutable: absoluteRunnerPath(env, RECOVERY_RUNNER_ENV.piExecutable),
  };
}

function ownerUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function privateDirectory(path: string, create: boolean): string {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const details = lstatSync(path);
  const uid = ownerUid();
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0 || (uid !== undefined && details.uid !== uid)) {
    throw new Error("Recovery session directory is not private");
  }
  return realpathSync(path);
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function readTranscriptHeader(path: string): Record<string, unknown> | undefined {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_TRANSCRIPT_HEADER_BYTES);
    const size = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, size).indexOf(0x0a);
    if (newline < 1) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    } catch {
      return undefined;
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } finally {
    closeSync(descriptor);
  }
}

export function inspectRecoveryTranscript(
  sessionDirectory: string,
  transcriptPath: string,
  expectedSessionId: string,
): RecoveryTranscriptInspection {
  try {
    const directory = privateDirectory(normalize(resolve(sessionDirectory)), false);
    const details = lstatSync(transcriptPath);
    const uid = ownerUid();
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      (details.mode & 0o077) !== 0 ||
      (uid !== undefined && details.uid !== uid)
    ) {
      return { readable: false, reason: "unsafe" };
    }
    const canonicalPath = realpathSync(transcriptPath);
    if (!inside(directory, canonicalPath) || !canonicalPath.endsWith(".jsonl")) {
      return { readable: false, reason: "unsafe" };
    }
    const header = readTranscriptHeader(canonicalPath);
    if (header?.type !== "session" || header.id !== expectedSessionId) {
      return { readable: false, reason: "invalid", canonicalPath };
    }
    return { readable: true, reason: "ok", canonicalPath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { readable: false, reason: code === "ENOENT" ? "missing" : "unreadable" };
  }
}

function createSessionDirectory(root: string, incidentId: number, generation: number): string {
  const canonicalRoot = privateDirectory(root, true);
  const directory = mkdtempSync(join(canonicalRoot, `incident-${incidentId}-generation-${generation}-`));
  chmodSync(directory, 0o700);
  return realpathSync(directory);
}

function jsonlCandidates(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(directory, entry.name));
}

export function preseedCanonicalRecoverySession(
  sessionDirectory: string,
  agentWorkspaceCwd: string,
  options: RecoverySessionSeedOptions = {},
): PreseededRecoverySession {
  const directory = privateDirectory(normalize(resolve(sessionDirectory)), false);
  const resolvedWorkspaceCwd = normalize(resolve(agentWorkspaceCwd));
  if (!statSync(resolvedWorkspaceCwd).isDirectory()) {
    throw new Error("Recovery agent workspace is not a directory");
  }
  const workspaceCwd = realpathSync(resolvedWorkspaceCwd);

  const transcriptPath = join(directory, "recovery-session.jsonl");
  const descriptor = openSync(transcriptPath, "wx", 0o600);
  try {
    fchmodSync(descriptor, 0o600);
  } finally {
    closeSync(descriptor);
  }

  const openSession = options.openSession
    ?? ((path: string, sessionDir: string, cwd: string) => PiSessionManager.open(path, sessionDir, cwd));
  const session = openSession(transcriptPath, directory, workspaceCwd);
  const sessionId = session.getSessionId();
  const reportedPath = session.getSessionFile();
  if (typeof sessionId !== "string" || sessionId.length === 0 || typeof reportedPath !== "string") {
    throw new Error("Pi did not create a valid recovery session identity");
  }

  const inspection = inspectRecoveryTranscript(directory, reportedPath, sessionId);
  const jsonlEntries = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith(".jsonl"));
  if (
    !inspection.readable
    || !inspection.canonicalPath
    || inspection.canonicalPath !== realpathSync(transcriptPath)
    || jsonlEntries.length !== 1
    || jsonlEntries[0]?.name !== basename(transcriptPath)
  ) {
    throw new Error("Pi created an invalid recovery session transcript");
  }

  const details = lstatSync(inspection.canonicalPath);
  const header = readTranscriptHeader(inspection.canonicalPath);
  if (
    (details.mode & 0o777) !== 0o600
    || header?.version !== CURRENT_SESSION_VERSION
    || header.cwd !== workspaceCwd
  ) {
    throw new Error("Pi created an unsafe recovery session transcript");
  }
  return { sessionId, transcriptPath: inspection.canonicalPath };
}

export async function discoverCanonicalRecoveryTranscript(
  sessionDirectory: string,
  sessionId: string,
  timeoutMs: number,
  options: Pick<RecoveryFixerRunnerOptions, "now" | "sleep"> = {},
): Promise<string> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const deadline = now() + timeoutMs;
  do {
    const candidates = jsonlCandidates(sessionDirectory);
    if (candidates.length === 1) {
      const inspection = inspectRecoveryTranscript(sessionDirectory, candidates[0], sessionId);
      if (inspection.readable && inspection.canonicalPath) return inspection.canonicalPath;
    }
    await sleep(25);
  } while (now() < deadline);
  throw new Error("Recovery session transcript did not become uniquely readable");
}

function startupStderr(child: ChildProcess): string {
  const read = (child as unknown as PiStartupDiagnostics).piStartupStderr;
  return typeof read === "function" ? read() : "";
}

export function hasNoSessionFoundClassifier(child: ChildProcess): boolean {
  return /No session found matching/.test(startupStderr(child));
}

export async function captureRecoverySessionId(child: ChildProcess, timeoutMs: number): Promise<string> {
  await waitForSpawn(child, timeoutMs);
  const stdout = child.stdout;
  if (!stdout) throw new Error("Recovery Pi stdout is unavailable");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExit = () => controller.abort();
  child.once("exit", onExit);
  const splitter = new NewlineOnlyJsonlSplitter();
  try {
    sendPiGetState(child, "recovery-session-binding");
    for await (const [chunk] of on(stdout, "data", { signal: controller.signal, close: ["close"] })) {
      for (const record of splitter.push(chunk as Buffer)) {
        const id = parsePiStartupRecord(child, record);
        if (id) return id;
      }
    }
  } catch (error) {
    if (error instanceof PiStartupBlockingUiError) throw error;
    if (!controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    child.removeListener("exit", onExit);
    controller.abort();
    stdout.pause();
  }
  throw new Error("Recovery Pi did not expose a session id before startup timeout");
}

export async function terminateRecoveryProcessGroup(
  child: ChildProcess,
  processKill: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  ownsProcessGroup = true,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  try {
    if (pid && ownsProcessGroup) processKill(-pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise<void>((resolveWait) => {
    let killTimer: ReturnType<typeof setTimeout>;
    const done = () => {
      clearTimeout(killTimer);
      child.removeListener("exit", done);
      resolveWait();
    };
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (pid && ownsProcessGroup) processKill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      done();
    }, 5_000);
    child.once("exit", done);
  });
}

export function resolveRecoveryAgent(agentId: string, configPath?: string): AgentConfig {
  const config = loadConfig(configPath, { resolveSecrets: false });
  const agent = config.agents[agentId];
  if (!agent) throw new Error("Configured recovery agent is unavailable");
  return agent;
}

export function recoveryExtensionOptions(
  mode: RecoveryMode,
  env: NodeJS.ProcessEnv = process.env,
): PiSpawnExtensionOptions {
  const contract = resolveWorkspaceContract({ env });
  const relpath = piExtensionRelpathForDir(contract.paths.piExtensionDir, "recovery.ts");
  const extensionPath = resolve(contract.paths.piExtensionDir, relpath);
  resolveRequiredRecoveryExtensionArgs(mode, extensionPath, { env });
  return {
    extraExtensions: [extensionPath],
    relpaths: PI_RECOVERY_WRAPPER_RELPATHS,
    env,
  };
}

export function recoveryStartsNewPiProcessGroup(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[RECOVERY_RUNNER_ENV.supervisorProcessGroup] !== "1";
}

function runtimeEnv(
  contract: ReturnType<typeof readRecoveryRuntimeContract>,
  sessionDirectory: string,
  agentId: string,
  piExecutable: string,
  env: NodeJS.ProcessEnv = process.env,
): PiSpawnRuntimeEnvOptions {
  return {
    askCallerAgentId: agentId,
    // The Python supervisor starts the runner as a new session. In that mode
    // Pi and its tool descendants must remain in the runner's process group so
    // one host-native kill fences the entire tree. Standalone/test callers keep
    // the Task-2 Pi-rooted group behavior.
    startNewProcessGroup: recoveryStartsNewPiProcessGroup(env),
    recovery: {
      endpoint: contract.endpoint.origin,
      fixerCredentialFile: contract.fixerCredentialFile,
      mode: contract.mode,
      invocationId: contract.fence.invocationId,
      incidentId: contract.fence.incidentId,
      generation: contract.fence.generation,
      evidenceHash: contract.fence.evidenceHash,
      policyRevision: contract.fence.policyRevision,
      leaseToken: contract.fence.leaseToken,
      sessionDirectory,
      piExecutable,
      preimageDirectory: contract.preimageDirectory,
      preimageMaxBytes: contract.preimageMaxBytes,
    },
  };
}

function recoveryRuntimeVersions(agent: AgentConfig): RecoveryRuntimeVersions {
  let packageVersion = "unreported";
  try {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
    ) as { version?: unknown };
    if (typeof manifest.version === "string" && manifest.version.trim()) packageVersion = manifest.version.trim();
  } catch {
    // Binding remains available with an explicit degraded package version.
  }
  return {
    model: normalizePiModel(agent.model),
    node: process.version,
    package: packageVersion,
    pi: EXPECTED_PI_PACKAGE_VERSION,
  };
}

function spawnWithPrivateUmask(
  spawn: typeof spawnPiRpcSession,
  agent: AgentConfig,
  sessionId: string | undefined,
  extensionOptions: PiSpawnExtensionOptions,
  runtimeOptions: PiSpawnRuntimeEnvOptions,
): ChildProcess {
  const previousUmask = process.umask(0o077);
  try {
    return spawn(agent, sessionId, extensionOptions, runtimeOptions);
  } finally {
    process.umask(previousUmask);
  }
}

function buildIncidentPrompt(state: RecoveryFixerState): string {
  const boundedDigest = state.journalDigest.slice(0, 256 * 1024);
  return [
    "You are the trusted same-UID recovery fixer for one durably fenced incident.",
    "Use normal local inspection and repair tools. Every mutation is journaled by the recovery extension.",
    "Reconcile every unknown action against current host state before attempting any new mutation.",
    "Do not start chat polling, publish externally, install/download packages or images, expose secrets, or use sudo.",
    "Finish only by calling recovery_finish with a structured claim, or recovery_blocked if safe progress is impossible.",
    "A recovery_finish call is not authoritative success; fresh host-native verification decides the outcome.",
    `Evidence: ${JSON.stringify(state.evidence)}`,
    `Unknown actions: ${JSON.stringify(state.unknownActions)}`,
    boundedDigest ? `Bounded prior journal digest: ${boundedDigest}` : "Bounded prior journal digest: none",
  ].join("\n\n");
}

async function spawnBoundSession(
  agent: AgentConfig,
  state: RecoveryFixerState,
  client: RecoveryProtocolClient,
  runner: RecoveryRunnerContract,
  options: RecoveryFixerRunnerOptions,
  observeChild: (child: ChildProcess | undefined) => void,
): Promise<RecoverySessionHandle> {
  const protocol = client.contract;
  const extensionOptions = recoveryExtensionOptions(protocol.mode, options.env);
  const spawn = options.spawn ?? spawnPiRpcSession;
  const prior = state.currentSession ?? state.resumeSession;
  const runtime = recoveryRuntimeVersions(agent);
  let previousInspection: RecoveryTranscriptInspection | undefined;
  if (prior) {
    previousInspection = inspectRecoveryTranscript(prior.sessionDirectory, prior.transcriptPath, prior.sessionId);
    const child = spawnWithPrivateUmask(
      spawn,
      agent,
      prior.sessionId,
      extensionOptions,
      runtimeEnv(protocol, prior.sessionDirectory, runner.agentId, runner.piExecutable, options.env),
    );
    observeChild(child);
    try {
      const observedId = await captureRecoverySessionId(child, runner.resumeTimeoutMs);
      if (observedId !== prior.sessionId) throw new Error("Recovery Pi resumed a different session id");
      const transcriptPath = await discoverCanonicalRecoveryTranscript(
        prior.sessionDirectory,
        prior.sessionId,
        runner.resumeTimeoutMs,
        options,
      );
      if (normalize(transcriptPath) !== normalize(prior.transcriptPath)) {
        throw new Error("Recovery Pi resumed a different transcript path");
      }
      const bindingId = state.currentSession
        ? prior.bindingId
        : await client.bindSession({
          sessionId: prior.sessionId,
          sessionDirectory: prior.sessionDirectory,
          transcriptPath,
          runtime,
        });
      if (!(await client.markSessionResumed(bindingId))) {
        throw new Error("Recovery session resume was not durably recorded");
      }
      return {
        child,
        bindingId,
        sessionId: prior.sessionId,
        sessionDirectory: prior.sessionDirectory,
        transcriptPath,
        replaced: false,
      };
    } catch (error) {
      const classified = hasNoSessionFoundClassifier(child);
      await terminateRecoveryProcessGroup(
        child,
        options.processKill,
        recoveryStartsNewPiProcessGroup(options.env),
      );
      observeChild(undefined);
      if (previousInspection.readable || !classified) throw error;
    }
  }

  const sessionDirectory = createSessionDirectory(
    runner.sessionRoot,
    protocol.fence.incidentId,
    protocol.fence.generation,
  );
  const seeded = preseedCanonicalRecoverySession(
    sessionDirectory,
    resolveValidatedPiAgentWorkspaceCwd(agent),
  );
  const child = spawnWithPrivateUmask(
    spawn,
    agent,
    seeded.sessionId,
    extensionOptions,
    runtimeEnv(protocol, sessionDirectory, runner.agentId, runner.piExecutable, options.env),
  );
  observeChild(child);
  try {
    const observedId = await captureRecoverySessionId(child, runner.startupTimeoutMs);
    if (observedId !== seeded.sessionId) {
      throw new Error("Recovery Pi resumed a different pre-seeded session id");
    }
    const transcriptPath = await discoverCanonicalRecoveryTranscript(
      sessionDirectory,
      seeded.sessionId,
      runner.startupTimeoutMs,
      options,
    );
    if (normalize(transcriptPath) !== normalize(seeded.transcriptPath)) {
      throw new Error("Recovery Pi resumed a different pre-seeded transcript path");
    }
    const bindingId = prior
      ? await client.replaceSession({
        previousBindingId: prior.bindingId,
        sessionId: seeded.sessionId,
        sessionDirectory,
        transcriptPath,
        startupClassifier: "no_session_found",
        journalDigest: state.journalDigest,
        runtime,
      })
      : await client.bindSession({ sessionId: seeded.sessionId, sessionDirectory, transcriptPath, runtime });
    return {
      child,
      bindingId,
      sessionId: seeded.sessionId,
      sessionDirectory,
      transcriptPath,
      replaced: Boolean(prior),
    };
  } catch (error) {
    await terminateRecoveryProcessGroup(
      child,
      options.processKill,
      recoveryStartsNewPiProcessGroup(options.env),
    );
    observeChild(undefined);
    throw error;
  }
}

export async function runRecoveryFixer(options: RecoveryFixerRunnerOptions = {}): Promise<RecoveryFixerRunResult> {
  const env = options.env ?? process.env;
  const runner = readRecoveryRunnerContract(env);
  if (options.startupTimeoutMs !== undefined) runner.startupTimeoutMs = options.startupTimeoutMs;
  if (options.renewMs !== undefined) runner.renewMs = options.renewMs;
  if (options.runTimeoutMs !== undefined) runner.runTimeoutMs = options.runTimeoutMs;
  const protocol = readRecoveryRuntimeContract(env);
  const client = options.client ?? new RecoveryProtocolClient(protocol);
  const configPath = env.MINIME_CONFIG_PATH;
  const agent = resolveRecoveryAgent(runner.agentId, configPath);
  let terminal: "lease_lost" | "timed_out" | undefined;
  let renewing = false;
  let activeChild: ChildProcess | undefined;
  let terminating: Promise<void> | undefined;
  const terminateActiveChild = (): Promise<void> => {
    if (!activeChild) return Promise.resolve();
    terminating ??= terminateRecoveryProcessGroup(
      activeChild,
      options.processKill,
      recoveryStartsNewPiProcessGroup(options.env),
    );
    return terminating;
  };
  const observeChild = (child: ChildProcess | undefined) => {
    activeChild = child;
    terminating = undefined;
    if (child && terminal) void terminateActiveChild();
  };
  const renewTimer = setInterval(async () => {
    if (renewing || terminal) return;
    renewing = true;
    try {
      if (!(await client.heartbeat())) {
        terminal = "lease_lost";
        await terminateActiveChild();
      }
    } catch {
      terminal = "lease_lost";
      await terminateActiveChild();
    } finally {
      renewing = false;
    }
  }, runner.renewMs);
  try {
    const state = await client.state();
    if (state.mode !== protocol.mode) throw new Error("Recovery supervisor mode changed before spawn");
    if (terminal) throw new Error("Recovery fixer lease was lost during startup");
    const handle = await spawnBoundSession(agent, state, client, runner, options, observeChild);
    const session = {
      bindingId: handle.bindingId,
      sessionId: handle.sessionId,
      sessionDirectory: handle.sessionDirectory,
      transcriptPath: handle.transcriptPath,
      replaced: handle.replaced,
    };
    if (terminal) return { status: terminal, session };
    const timeout = setTimeout(async () => {
      terminal = "timed_out";
      await terminateActiveChild();
    }, runner.runTimeoutMs);
    try {
      const promptId = sendPiPrompt(handle.child, buildIncidentPrompt(state));
      let result: ResultMessage | undefined;
      for await (const line of readPiStream(handle.child, undefined, promptId)) {
        if (line.type === "result") result = line;
      }
      if (terminal) return { status: terminal, session, result };
      return {
        status: classifyRecoveryFixerResult(result),
        session,
        result,
      };
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    clearInterval(renewTimer);
    await terminateActiveChild();
  }
}

function isDirectEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) return false;
  try {
    return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

async function main(): Promise<number> {
  try {
    const result = await runRecoveryFixer();
    return result.status === "settled" ? 0 : 1;
  } catch {
    // Deliberately omit exception text: vendor/provider errors and local paths
    // can contain sensitive material. The supervisor owns durable diagnostics.
    process.stderr.write("recovery fixer failed\n");
    return 1;
  }
}

if (isDirectEntrypoint()) {
  process.exitCode = await main();
}
