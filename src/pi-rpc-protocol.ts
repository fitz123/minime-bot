import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import type { Readable } from "node:stream";
import type {
  AgentConfig,
  StreamLine,
  StreamEvent,
  SystemInit,
  RateLimitEvent,
  ResultMessage,
  ControlRequest,
} from "./types.js";
import { log } from "./logger.js";
import { assemblePiContext } from "./pi-context-assembler.js";
import {
  formatPiRuntimeDiagnostic,
  resolvePackageOwnedPiInvocation,
} from "./pi-runtime.js";
import {
  MINIME_AGENT_WORKSPACE_ROOT_ENV,
  MINIME_CONFIG_PATH_ENV,
  MINIME_CONTROL_WORKSPACE_ROOT_ENV,
  MINIME_CRONS_PATH_ENV,
  resolveAgentWorkspaceCwd,
  resolveWorkspaceContract,
  type ResolvedWorkspaceContract,
} from "./workspace-contract.js";

export const PI_PROVIDER = "openai-codex";
export const DEFAULT_PI_MODEL = "openai-codex/gpt-5.5";

/**
 * Wrapper entrypoints loaded into EVERY Pi spawn, in load order:
 *   codex-transport-overflow (Codex request-byte overflow normalization),
 *   web-tools (Tavily web_search/web_fetch),
 *   knowledge-tools (knowledge_search/knowledge_get/knowledge_update + managed wiki protection),
 *   subagent (isolated `pi -p` child spawn),
 *   ask-agent (configured full-agent question handoff).
 * Paths are relative to {@link DEFAULT_PI_EXTENSIONS_DIR}. subagent and
 * ask-agent are multi-file DIRECTORIES whose entrypoint is `index.ts`.
 */
export const PI_EXTENSION_WRAPPER_RELPATHS = [
  "codex-transport-overflow.ts",
  "web-tools.ts",
  "knowledge-tools.ts",
  "subagent/index.ts",
  "ask-agent/index.ts",
] as const;

export const PI_EXTENSION_ARTIFACT_WRAPPER_RELPATHS = [
  "codex-transport-overflow.js",
  "web-tools.js",
  "knowledge-tools.js",
  "subagent/index.js",
  "ask-agent/index.js",
] as const;

/**
 * Wrappers a subagent CHILD `pi` spawn must load. The subagent tool spawns an
 * isolated `pi -p` child to run a delegated task. Children load the transport
 * overflow normalizer, web tools, and knowledge tools/protection, but they do
 * NOT load the subagent wrapper: recursive spawning stays disabled in child
 * sessions.
 */
export const PI_SUBAGENT_CHILD_WRAPPER_RELPATHS = [
  "codex-transport-overflow.ts",
  "web-tools.ts",
  "knowledge-tools.ts",
] as const;

/**
 * Wrappers an ask-agent target CHILD `pi` spawn must load. The child runs as a
 * full target agent with the target's normal first-party tool surface, except
 * recursive handoff tools stay disabled for MVP.
 */
const PI_ASK_AGENT_CHILD_EXCLUDED_WRAPPER_RELPATHS = new Set<string>(["subagent/index.ts", "ask-agent/index.ts"]);
export const PI_ASK_AGENT_CHILD_WRAPPER_RELPATHS = Object.freeze(
  PI_EXTENSION_WRAPPER_RELPATHS.filter((relpath) => !PI_ASK_AGENT_CHILD_EXCLUDED_WRAPPER_RELPATHS.has(relpath)),
);

/**
 * Wrappers a Pi print-mode cron must load. Crons need the Knowledge wrapper so
 * managed wiki writes are protected, but do not get interactive web-tools or
 * subagent parity.
 */
export const PI_CRON_WRAPPER_RELPATHS = ["knowledge-tools.ts"] as const;

export const PI_SUBAGENT_CHILD_ARTIFACT_WRAPPER_RELPATHS = [
  "codex-transport-overflow.js",
  "web-tools.js",
  "knowledge-tools.js",
] as const;
const PI_ASK_AGENT_CHILD_EXCLUDED_ARTIFACT_WRAPPER_RELPATHS = new Set<string>([
  "subagent/index.js",
  "ask-agent/index.js",
]);
export const PI_ASK_AGENT_CHILD_ARTIFACT_WRAPPER_RELPATHS = Object.freeze(
  PI_EXTENSION_ARTIFACT_WRAPPER_RELPATHS.filter(
    (relpath) => !PI_ASK_AGENT_CHILD_EXCLUDED_ARTIFACT_WRAPPER_RELPATHS.has(relpath),
  ),
);

/**
 * Kill-switch env var: set to exactly `"1"` to spawn Pi with no explicit
 * extensions. Spawns still pass `--no-extensions` so Pi's ambient extension
 * discovery remains disabled.
 */
export const PI_EXTENSIONS_DISABLED_ENV = "PI_EXTENSIONS_DISABLED";
export const MINIME_BOT_PI_SESSION_ENV = "MINIME_BOT_PI_SESSION";
export const MINIME_BOT_PI_SESSION_AGENT_ID_ENV = "MINIME_BOT_PI_SESSION_AGENT_ID";

export interface PiExtensionResolveOptions {
  /** Override the wrapper base dir (default: resolved workspace/package contract). */
  extensionsDir?: string;
  /** Override env lookup for the kill-switch (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Override the existence check (default: `fs.existsSync`). */
  exists?: (path: string) => boolean;
  /** Override realpath resolution (default: `fs.realpathSync`). */
  realpath?: (path: string) => string;
  /**
   * Which wrapper relpaths to resolve (default: the full interactive
   * {@link PI_EXTENSION_WRAPPER_RELPATHS}). A subagent child passes
   * {@link PI_SUBAGENT_CHILD_WRAPPER_RELPATHS} to load non-recursive first-party
   * child wrappers while leaving recursive subagent spawning disabled.
   */
  relpaths?: readonly string[];
}

export interface PiSpawnExtensionOptions extends PiExtensionResolveOptions {
  /** Operator-approved external extension entrypoints for interactive bot RPC sessions. */
  extraExtensions?: readonly string[];
}

export interface PiSpawnRuntimeEnvOptions {
  /** Trusted current agent id supplied by SessionManager for first-party tools. */
  askCallerAgentId?: string;
  /** Fixed recovery-only child contract. Arbitrary environment injection is deliberately unsupported. */
  recovery?: {
    endpoint: string;
    fixerCredentialFile: string;
    mode: "diagnose" | "enabled";
    invocationId: number;
    incidentId: number;
    generation: number;
    evidenceHash: string;
    policyRevision: number;
    leaseToken: string;
    sessionDirectory: string;
  };
  /** Create a process group rooted at the Pi child so fence loss can kill its tool descendants. */
  startNewProcessGroup?: boolean;
}

const PI_CHILD_ENV_KEY_ALLOWLIST = new Set([
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOGNAME",
  MINIME_AGENT_WORKSPACE_ROOT_ENV,
  MINIME_BOT_PI_SESSION_AGENT_ID_ENV,
  MINIME_BOT_PI_SESSION_ENV,
  MINIME_CONFIG_PATH_ENV,
  MINIME_CONTROL_WORKSPACE_ROOT_ENV,
  MINIME_CRONS_PATH_ENV,
  "NO_COLOR",
  "PATH",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_OFFLINE",
  "PI_PACKAGE_DIR",
  "PI_SHARE_VIEWER_URL",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "SHELL",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
]);

const PI_CHILD_LC_ENV_KEYS = new Set([
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
]);

const RETIRED_CONTROL_WORKSPACE_ENV = ["MINIME", "WORKSPACE", "ROOT"].join("_");
const RETIRED_AGENT_WORKSPACE_ENV = ["MINIME", "AGENT", "WORKSPACE", "CWD"].join("_");

export function shouldIncludePiChildEnvKey(key: string): boolean {
  return PI_CHILD_ENV_KEY_ALLOWLIST.has(key) || PI_CHILD_LC_ENV_KEYS.has(key);
}

/**
 * Resolve the repeatable `--extension <abs-path>` args for a Pi spawn.
 *
 * Loading is DELIBERATELY per-spawn rather than via Pi's auto-discovery dirs.
 * Returns `[]` when `PI_EXTENSIONS_DISABLED=1` so the spawn has no explicit
 * first-party wrappers; callers still pass `--no-extensions` to keep ambient
 * discovery disabled.
 *
 * A configured wrapper missing on disk throws loudly instead of silently
 * dropping part of the first-party extension contract. The thrown message names
 * the missing path and points at the kill-switch as the deliberate bypass.
 */
export function resolvePiExtensionArgs(options?: PiExtensionResolveOptions): string[] {
  const env = options?.env ?? process.env;
  if (env[PI_EXTENSIONS_DISABLED_ENV] === "1") {
    return [];
  }

  const baseDir = options?.extensionsDir ?? resolveWorkspaceContract().paths.piExtensionDir;
  const fileExists = options?.exists ?? existsSync;
  const relpaths = options?.relpaths ?? PI_EXTENSION_WRAPPER_RELPATHS;

  const args: string[] = [];
  for (const rel of relpaths) {
    const abs = resolve(baseDir, piExtensionRelpathForDir(baseDir, rel));
    if (!fileExists(abs)) {
      throw new Error(
        `Pi extension wrapper not found: ${abs}. Refusing to spawn without the ` +
          `expected first-party extensions. Restore the wrapper, or set ${PI_EXTENSIONS_DISABLED_ENV}=1 ` +
          `to spawn without explicit first-party extensions.`,
      );
    }
    args.push("--extension", abs);
  }

  return args;
}

function resolvePiExtraExtensionArgs(options?: PiSpawnExtensionOptions): string[] {
  const env = options?.env ?? process.env;
  if (env[PI_EXTENSIONS_DISABLED_ENV] === "1") {
    return [];
  }

  const fileExists = options?.exists ?? existsSync;
  const args: string[] = [];
  for (const extra of options?.extraExtensions ?? []) {
    if (typeof extra !== "string" || extra.trim() === "") {
      throw new Error("Pi extra extension paths must be non-empty absolute strings");
    }
    if (!isAbsolute(extra)) {
      throw new Error(`Pi extra extension path must be absolute: ${extra}`);
    }
    if (!fileExists(extra)) {
      throw new Error(
        `Pi extra extension not found: ${extra}. Remove it from piExtraExtensions, restore the file, ` +
          `or set ${PI_EXTENSIONS_DISABLED_ENV}=1 to spawn without explicit extensions.`,
      );
    }
    args.push("--extension", extra);
  }
  return args;
}

function extensionArgPaths(args: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--extension" && typeof args[index + 1] === "string") {
      paths.push(normalize(resolve(args[index + 1])));
      index++;
    }
  }
  return paths;
}

function addPathAndRealpath(
  paths: Set<string>,
  path: string,
  options?: PiExtensionResolveOptions,
): void {
  const normalized = normalize(resolve(path));
  paths.add(normalized);

  try {
    paths.add(normalize(resolve((options?.realpath ?? realpathSync)(normalized))));
  } catch (err) {
    if (options?.exists === undefined && options?.realpath === undefined) {
      throw err;
    }
    // Tests may use synthetic paths with a mocked exists() predicate. Keep those
    // checks path-based while production resolves real symlink targets.
  }
}

function recursiveWrapperBaseDirs(baseDir: string): string[] {
  const normalizedBase = normalize(baseDir).replace(/[\\/]+$/, "");
  const dirs = new Set<string>([normalizedBase]);
  const sourceSuffix = normalize("extensions/pi");
  const artifactSuffix = normalize("dist/extensions/pi");

  if (normalizedBase.endsWith(sourceSuffix) && !normalizedBase.endsWith(artifactSuffix)) {
    dirs.add(normalize(resolve(normalizedBase, "..", "..", "dist", "extensions", "pi")));
  } else if (normalizedBase.endsWith(artifactSuffix)) {
    dirs.add(normalize(resolve(normalizedBase, "..", "..", "..", "extensions", "pi")));
  }

  return [...dirs];
}

function recursiveWrapperDeniedPaths(options?: PiSpawnExtensionOptions): Set<string> {
  const baseDir = options?.extensionsDir ?? resolveWorkspaceContract().paths.piExtensionDir;
  const fileExists = options?.exists ?? existsSync;
  const paths = new Set<string>();

  for (const candidateBaseDir of recursiveWrapperBaseDirs(baseDir)) {
    for (const relpath of ["subagent/index.ts", "subagent/index.js", "ask-agent/index.ts", "ask-agent/index.js"]) {
      const abs = normalize(resolve(candidateBaseDir, relpath));
      if (fileExists(abs)) {
        addPathAndRealpath(paths, abs, options);
      }

      const wrapperDir = dirname(abs);
      if (fileExists(wrapperDir)) {
        addPathAndRealpath(paths, wrapperDir, options);
      }
    }
  }

  return paths;
}

function assertNoAskAgentRecursiveExtraExtensions(
  extraArgs: readonly string[],
  options?: PiSpawnExtensionOptions,
): void {
  if (extraArgs.length === 0) {
    return;
  }

  const recursiveWrapperPaths = recursiveWrapperDeniedPaths(options);

  for (const extraPath of extensionArgPaths(extraArgs)) {
    const candidatePaths = new Set<string>();
    addPathAndRealpath(candidatePaths, extraPath, options);
    if ([...candidatePaths].some((candidatePath) => recursiveWrapperPaths.has(candidatePath))) {
      throw new Error(`Pi extra extension cannot load recursive handoff wrapper in ask-agent children: ${extraPath}`);
    }
  }
}

export function resolvePiSpawnExtensionArgs(options?: PiSpawnExtensionOptions): string[] {
  return [
    ...resolvePiExtensionArgs(options),
    ...resolvePiExtraExtensionArgs(options),
  ];
}

export function resolvePiAskAgentChildExtensionArgs(options?: PiSpawnExtensionOptions): string[] {
  const extraArgs = resolvePiExtraExtensionArgs(options);
  assertNoAskAgentRecursiveExtraExtensions(extraArgs, options);
  return [
    ...resolvePiExtensionArgs({
      ...options,
      relpaths: PI_ASK_AGENT_CHILD_WRAPPER_RELPATHS,
    }),
    ...extraArgs,
  ];
}

export function piExtensionRelpathForDir(baseDir: string, relpath: string): string {
  const normalizedBase = normalize(baseDir).replace(/[\\/]+$/, "");
  if (!normalizedBase.endsWith(`${normalize("dist/extensions/pi")}`)) {
    return relpath;
  }
  if (relpath.endsWith(".ts")) {
    return `${relpath.slice(0, -".ts".length)}.js`;
  }
  return relpath;
}

export interface PiPromptCommand {
  type: "prompt";
  message: string;
  /** Correlates prompt acceptance/rejection with the active bot request. */
  id?: string;
  /**
   * Pi's mid-turn concurrency control. When the agent is STREAMING (a turn is
   * live), a `prompt` with no `streamingBehavior` is REJECTED with the "already
   * processing" error (vendor `dist/core/agent-session.js`). Supplying
   * `"followUp"` queues the message to run after the live turn; `"steer"`
   * interrupts. When the agent is IDLE (not streaming) the field is IGNORED and
   * the prompt runs immediately. The queue-driven SessionManager send path
   * passes `"followUp"` on the prompts it sends: a no-op when idle, and the fix
   * for Defect B when the bot's busy-tracking has desynced and the child is
   * actually still mid-turn — the message is queued, never rejected-and-dropped.
   * The field is OPTIONAL though: `buildPiPromptCommand`/`sendPiPrompt` still
   * emit a bare prompt when no behavior is given (the historical shape some
   * callers and tests rely on), so it is not attached unconditionally.
   */
  streamingBehavior?: "steer" | "followUp";
}

export interface PiSteerCommand {
  type: "steer";
  message: string;
}

/**
 * `get_state` is a no-argument RPC command whose successful `response` is the
 * ONLY place Pi exposes the session id it minted (no agent event carries it).
 * Issued once right after spawn to capture + persist that id for `--session`
 * resume across restarts.
 */
export interface PiGetStateCommand {
  type: "get_state";
  /** Optional correlation id for in-turn state probes. */
  id?: string;
}

export interface PiExtensionUiResponseCommand {
  type: "extension_ui_response";
  id: string;
  cancelled: true;
}

export type PiRpcCommand =
  | PiPromptCommand
  | PiSteerCommand
  | PiGetStateCommand
  | PiExtensionUiResponseCommand;

/**
 * Pi RPC uses strict JSONL framing: LF is the only record delimiter.
 * Node readline is intentionally avoided because it also splits on U+2028/U+2029.
 */
export class NewlineOnlyJsonlSplitter {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer | Uint8Array | string): string[] {
    this.buffer += decodeChunk(this.decoder, chunk);
    return this.takeCompleteRecords();
  }

  end(chunk?: Buffer | Uint8Array | string): string[] {
    if (chunk !== undefined) {
      this.buffer += decodeChunk(this.decoder, chunk);
    }
    this.buffer += this.decoder.end();

    if (this.buffer.length === 0) {
      return [];
    }

    const finalRecord = stripTrailingCarriageReturn(this.buffer);
    this.buffer = "";
    return [finalRecord];
  }

  private takeCompleteRecords(): string[] {
    const records: string[] = [];

    for (;;) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) {
        return records;
      }

      const record = this.buffer.slice(0, newlineIndex);
      records.push(stripTrailingCarriageReturn(record));
      this.buffer = this.buffer.slice(newlineIndex + 1);
    }
  }
}

function decodeChunk(
  decoder: StringDecoder,
  chunk: Buffer | Uint8Array | string,
): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  return decoder.write(Buffer.from(chunk));
}

function stripTrailingCarriageReturn(record: string): string {
  return record.endsWith("\r") ? record.slice(0, -1) : record;
}

export function normalizePiModel(model: string | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return DEFAULT_PI_MODEL;
  }
  return trimmed.includes("/") ? trimmed : `${PI_PROVIDER}/${trimmed}`;
}

function validateAgentWorkspaceCwd(
  agent: AgentConfig,
  contract: ResolvedWorkspaceContract,
): string {
  const agentWorkspace = resolveAgentWorkspaceCwd(contract.paths.workspaceRoot, agent.workspaceCwd);
  if (!existsSync(agentWorkspace)) {
    throw new Error(
      `Agent "${agent.id}" workspaceCwd does not exist: ${agentWorkspace}. ` +
        `Create the configured agent workspace or update agents.${agent.id}.workspaceCwd.`,
    );
  }
  if (!statSync(agentWorkspace).isDirectory()) {
    throw new Error(
      `Agent "${agent.id}" workspaceCwd is not a directory: ${agentWorkspace}. ` +
        `Point agents.${agent.id}.workspaceCwd at a directory.`,
    );
  }
  return agentWorkspace;
}

export function resolveValidatedPiAgentWorkspaceCwd(agent: AgentConfig): string {
  return validateAgentWorkspaceCwd(agent, resolveWorkspaceContract());
}

export function buildPiSpawnArgs(
  agent: AgentConfig,
  resumeSessionId?: string,
  extensionOptions?: PiSpawnExtensionOptions,
): string[] {
  const args = [
    "--mode", "rpc",
    "--provider", PI_PROVIDER,
    "--model", normalizePiModel(agent.model),
    "--no-extensions",
  ];

  if (agent.thinking) {
    args.push("--thinking", agent.thinking);
  }

  // Spawn-time context assembly. The assembler (pi-context-assembler.ts) gives
  // workspace-context parity from the agent's LIVE workspace files, delivered as three CLI
  // layers, REPLACING the old `agent.systemPrompt → --append-system-prompt` branch:
  //   --system-prompt <persona>   REPLACES Pi's base prompt (omitted when no persona
  //                               resolves — the agent then rides Pi's base prompt).
  //   --append-system-prompt <bundle>  the CLAUDE.md + @-imports + rules bundle.
  //   --no-context-files          so Pi does NOT ALSO flat-load CLAUDE.md/AGENTS.md
  //                               from cwd (avoids double context).
  // At most ONE --system-prompt and ONE --append-system-prompt are emitted. The
  // assembler is fail-safe for source reads (bad source → warn+skip; empty
  // workspace → null → bare spawn), but artifact writes can throw after source
  // content has been classified. A throw must fail closed with --no-context-files
  // so Pi does not flat-load context files the assembler could not safely deliver.
  try {
    const context = assemblePiContext(agent);
    if (context) {
      if (context.systemPromptPath) {
        args.push("--system-prompt", context.systemPromptPath);
      }
      args.push("--append-system-prompt", context.appendSystemPromptPath);
      args.push("--no-context-files");
    }
  } catch (err) {
    log.error(
      "pi-rpc",
      `Pi context assembly threw for agent "${agent.id}", suppressing flat context loading: ${(err as Error).message}`,
    );
    args.push("--no-context-files");
  }

  // Keep `--no-extensions` on every spawn to suppress Pi's ambient extension
  // discovery; load first-party wrappers and configured extras only as explicit
  // repeatable `--extension <abs-path>` args. The kill-switch and missing-path
  // checks live in the extension resolvers.
  args.push(...resolvePiSpawnExtensionArgs(extensionOptions));

  // Pi mints its own session id (the bot cannot pre-assign one with
  // --session-id). When resuming a stored session, point Pi at the
  // captured id with --session; on a fresh start, omit it entirely (passing an
  // unknown id makes Pi exit 1 with "No session found matching").
  if (resumeSessionId) {
    args.push("--session", resumeSessionId);
  }

  return args;
}

export function buildPiSpawnEnv(
  agentWorkspaceRoot?: string,
  runtimeEnvOptions?: PiSpawnRuntimeEnvOptions,
): Record<string, string> {
  return buildAllowedPiChildEnv(resolveWorkspaceContract(), agentWorkspaceRoot, runtimeEnvOptions);
}

export function buildPiSubagentChildSpawnEnv(agentWorkspaceRoot?: string): Record<string, string> {
  return buildAllowedPiChildEnv(resolveWorkspaceContract(), agentWorkspaceRoot);
}

export function buildPiAskAgentChildSpawnEnv(agentWorkspaceRoot?: string): Record<string, string> {
  return buildAllowedPiChildEnv(resolveWorkspaceContract(), agentWorkspaceRoot);
}

function buildAllowedPiChildEnv(
  contract: ResolvedWorkspaceContract,
  agentWorkspaceRoot?: string,
  runtimeEnvOptions?: PiSpawnRuntimeEnvOptions,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, val] of Object.entries(process.env)) {
    if (val !== undefined && shouldIncludePiChildEnvKey(key)) {
      env[key] = val;
    }
  }

  // A Pi/Codex subprocess authenticates via ~/.pi/agent/auth.json. Keep the
  // child environment allowlisted so prompt-influenced agents do not inherit
  // ambient credentials such as provider tokens or SSH agent sockets.
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_API_KEY;
  // Never leak the legacy session marker into a spawned agent subprocess.
  delete env.CLAUDECODE;

  const pathParts = (env.PATH ?? "").split(":").filter(Boolean);
  if (!pathParts.includes("/opt/homebrew/bin")) {
    pathParts.unshift("/opt/homebrew/bin");
  }
  env.PATH = pathParts.join(":");
  delete env[RETIRED_CONTROL_WORKSPACE_ENV];
  delete env[RETIRED_AGENT_WORKSPACE_ENV];
  delete env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
  delete env[MINIME_BOT_PI_SESSION_AGENT_ID_ENV];
  env[MINIME_CONTROL_WORKSPACE_ROOT_ENV] = contract.paths.controlWorkspaceRoot;
  const agentRoot = agentWorkspaceRoot?.trim();
  if (agentRoot) {
    env[MINIME_AGENT_WORKSPACE_ROOT_ENV] = normalize(resolve(agentRoot));
  }
  const askCallerAgentId = runtimeEnvOptions?.askCallerAgentId?.trim();
  if (askCallerAgentId) {
    env[MINIME_BOT_PI_SESSION_AGENT_ID_ENV] = askCallerAgentId;
  }
  const recovery = runtimeEnvOptions?.recovery;
  if (recovery) {
    env.PI_CODING_AGENT_SESSION_DIR = recovery.sessionDirectory;
    env.MINIME_RECOVERY_ENDPOINT = recovery.endpoint;
    env.MINIME_RECOVERY_FIXER_CREDENTIAL_FILE = recovery.fixerCredentialFile;
    env.MINIME_RECOVERY_MODE = recovery.mode;
    env.MINIME_RECOVERY_INVOCATION_ID = String(recovery.invocationId);
    env.MINIME_RECOVERY_INCIDENT_ID = String(recovery.incidentId);
    env.MINIME_RECOVERY_GENERATION = String(recovery.generation);
    env.MINIME_RECOVERY_EVIDENCE_HASH = recovery.evidenceHash;
    env.MINIME_RECOVERY_POLICY_REVISION = String(recovery.policyRevision);
    env.MINIME_RECOVERY_LEASE_TOKEN = recovery.leaseToken;
  }
  copyExplicitControlPathEnv(env, contract, MINIME_CONFIG_PATH_ENV, "configPath");
  copyExplicitControlPathEnv(env, contract, MINIME_CRONS_PATH_ENV, "cronsPath");
  env[MINIME_BOT_PI_SESSION_ENV] = "1";

  return env;
}

function copyExplicitControlPathEnv(
  env: Record<string, string>,
  contract: ResolvedWorkspaceContract,
  envKey: typeof MINIME_CONFIG_PATH_ENV | typeof MINIME_CRONS_PATH_ENV,
  pathName: "configPath" | "cronsPath",
): void {
  if (contract.effectivePaths[pathName].source !== "env") {
    delete env[envKey];
    return;
  }
  env[envKey] = contract.paths[pathName];
}

/**
 * Startup diagnostics stashed on a Pi child by `spawnPiRpcSession` so the spawn
 * caller can classify a startup failure WITHOUT re-piping stderr. `piStartupStderr()`
 * returns the stderr buffered since spawn — the spawn caller matches it against
 * `No session found matching` to detect an unresumable stored session (and start
 * fresh once). The exit code is read directly from `child.exitCode`.
 */
export interface PiStartupDiagnostics {
  piStartupStderr?: () => string;
}

/** Cap on buffered startup stderr (the classifier only needs the startup tail). */
const PI_STARTUP_STDERR_CAP = 64 * 1024;

export function spawnPiRpcSession(
  agent: AgentConfig,
  resumeSessionId?: string,
  extensionOptions?: PiSpawnExtensionOptions,
  runtimeEnvOptions?: PiSpawnRuntimeEnvOptions,
): ChildProcess {
  const workspaceCwd = resolveValidatedPiAgentWorkspaceCwd(agent);
  const spawnAgent = { ...agent, workspaceCwd };
  const env = buildPiSpawnEnv(workspaceCwd, runtimeEnvOptions);
  const invocation = resolvePackageOwnedPiInvocation(
    "rpc",
    buildPiSpawnArgs(spawnAgent, resumeSessionId, extensionOptions),
  );
  log.info("pi-rpc", `package-owned runtime ${formatPiRuntimeDiagnostic(invocation.diagnostic)}`);
  const child = spawn(invocation.command, invocation.args, {
    env,
    cwd: workspaceCwd,
    stdio: ["pipe", "pipe", "pipe"],
    detached: runtimeEnvOptions?.startNewProcessGroup === true,
  });

  // Buffer startup stderr so the spawn caller can classify a resume failure
  // (Pi prints `No session found matching <id>` and exits 1 when handed a stale
  // --session). Keep the existing log.warn so stderr stays visible in logs.
  // Cap the buffer: the only consumer is the startup classifier, and the signal
  // it matches appears in the first chunk(s); without a cap a long-lived, chatty
  // Pi session would accumulate all stderr in memory for the child's lifetime.
  let stderrBuffer = "";
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const raw = chunk.toString();
    if (stderrBuffer.length < PI_STARTUP_STDERR_CAP) {
      stderrBuffer += raw;
    }
    const text = raw.trimEnd();
    if (text) {
      log.warn("pi-rpc", text);
    }
  });
  (child as unknown as PiStartupDiagnostics).piStartupStderr = () => stderrBuffer;

  return child;
}

export function buildPiPromptCommand(
  text: string,
  streamingBehavior?: "steer" | "followUp",
  id?: string,
): PiPromptCommand {
  const command: PiPromptCommand = { type: "prompt", message: text };
  if (id) {
    command.id = id;
  }
  // Only attach the field when requested so a bare prompt (no behavior) stays
  // byte-identical to its historical shape — callers that pass nothing get the
  // exact `{ type, message }` object Pi accepted before Defect B's fix.
  if (streamingBehavior) {
    command.streamingBehavior = streamingBehavior;
  }
  return command;
}

export function buildPiSteerCommand(text: string): PiSteerCommand {
  return { type: "steer", message: text };
}

export function buildGetStateCommand(id?: string): PiGetStateCommand {
  return id ? { type: "get_state", id } : { type: "get_state" };
}

const PI_BLOCKING_EXTENSION_UI_METHODS = new Set(["select", "confirm", "input", "editor"]);
const PI_FIRE_AND_FORGET_EXTENSION_UI_METHODS = new Set([
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Convert a blocking extension UI request into Pi's correlated cancellation
 * command. Unsupported UI is deliberately failed closed: minime-bot has no UI
 * bridge for extension dialogs, so leaving one pending would stall the turn.
 */
export function buildPiExtensionUiCancellationCommand(
  event: PiRpcEvent,
): PiExtensionUiResponseCommand | null {
  if (
    event.type !== "extension_ui_request" ||
    !isNonEmptyString(event.id) ||
    !isNonEmptyString(event.method) ||
    !PI_BLOCKING_EXTENSION_UI_METHODS.has(event.method)
  ) {
    return null;
  }
  return { type: "extension_ui_response", id: event.id, cancelled: true };
}

/**
 * Send a `prompt` command. Pass `streamingBehavior: "followUp"` for the
 * queue-driven send path: it is a no-op when the Pi agent is idle (the prompt
 * runs immediately) and queues the message behind a live turn when the agent is
 * still streaming — so a bare prompt can never collide with an active turn and
 * trigger Pi's "already processing" rejection (Defect B).
 */
export function sendPiPrompt(
  child: ChildProcess,
  text: string,
  streamingBehavior?: "steer" | "followUp",
): string {
  const id = `minime-prompt-${++piPromptCommandSequence}`;
  writePiCommand(child, buildPiPromptCommand(text, streamingBehavior, id));
  return id;
}

export function sendPiSteer(child: ChildProcess, text: string): void {
  writePiCommand(child, buildPiSteerCommand(text));
}

/**
 * Issue a `get_state` command. Its successful `response` carries the Pi-minted
 * session id, which `parsePiEvent` surfaces as a `SystemInit` — the bot's only
 * hook for capturing + persisting that id for resume.
 */
export function sendPiGetState(child: ChildProcess, id?: string): void {
  writePiCommand(child, buildGetStateCommand(id));
}

let piPromptCommandSequence = 0;

function writePiCommand(child: ChildProcess, command: PiRpcCommand): void {
  if (!child.stdin || child.stdin.destroyed || child.exitCode !== null || child.killed) {
    throw new Error("Pi RPC child process is not available");
  }
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

/**
 * A raw Pi RPC record (stdout line) as decoded from JSONL — either an agent
 * event (`type: "turn_end"` etc.) or a command response (`type: "response"`).
 * Field access is defensive (everything optional) because the translator must
 * never throw on an unexpected/extended shape — it returns null and the caller
 * skips it.
 */
export interface PiRpcEvent {
  type?: string;
  /** Correlation id for command responses and extension UI requests. */
  id?: string;
  /** Extension UI method (`select`, `confirm`, `input`, `editor`, etc.). */
  method?: string;
  sessionId?: string;
  errorMessage?: string;
  /**
   * For `turn_end`/`message_*` events this is an `AgentMessage` object (an
   * AssistantMessage whose `content` is an array of `{type, text}` blocks), NOT
   * a string. Typed `unknown` so the translator narrows at each use site; the
   * defensive `error`-event path also reads it when it happens to be a string.
   */
  message?: unknown;
  /** `agent_end` carries every `AgentMessage` generated during the run. */
  messages?: unknown;
  assistantMessageEvent?: {
    type?: string;
    /** Text chunk for `text_delta` — the Pi RPC field is `delta`, not `text`. */
    delta?: string;
    [key: string]: unknown;
  };
  // Command-response correlation fields (records with `type: "response"`).
  command?: string;
  success?: boolean;
  data?: { sessionId?: string; [key: string]: unknown };
  error?: unknown;
  toolName?: string;
  tool?: { name?: string; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Concatenate the text blocks of a Pi `AgentMessage` (AssistantMessage). Pi
 * emits `turn_end.message` as an object whose `content` is an array of
 * `{type, text}` blocks — never a bare string. Returns "" for any other shape
 * so the translator never throws.
 */
function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (block): block is { text: string } =>
        Boolean(block) &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");
}

interface FinalAssistantInfo {
  text: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface PiRpcParseState {
  /** Latest usable run or terminal failure outcome waiting for `agent_settled`. */
  pendingOutcome?: ResultMessage;
  /** Session metadata observed on this stream, used when events omit it. */
  observedSessionId?: string;
  /** Guards prompt rejection, settlement, and EOF fallbacks from duplicating results. */
  terminalResultEmitted?: boolean;
  /** Whether the current low-level run emitted user-facing stream content. */
  currentRunHasStreamOutput?: boolean;
  /** Whether the completed run left stream content that a continuation must replace. */
  completedRunHasStreamOutput?: boolean;
  /** Prevents duplicate resets across retry, compaction, and continuation signals. */
  completedRunResetEmitted?: boolean;
  pendingOverflowErrorMessage?: string;
  pendingOverflowSessionId?: string;
  /** Prompt response id owned by this stream reader. */
  expectedPromptId?: string;
  /** Correlated get_state request used to detect a prompt handled without a run. */
  promptStateProbeId?: string;
  /** Guards an idle state probe from racing a real agent lifecycle. */
  agentLifecycleObserved?: boolean;
}

const PI_RPC_AGENT_FAILURE_MESSAGE = "Pi RPC agent failed";
const PI_RPC_OVERFLOW_FAILURE_MESSAGE = "Pi RPC context overflow recovery failed";
const PI_RPC_SETTLED_WITHOUT_OUTCOME_MESSAGE =
  "Pi agent_settled arrived without a usable agent_end outcome";
const PI_RPC_EXIT_BEFORE_SETTLED_MESSAGE = "Pi subprocess exited before agent_settled";

/**
 * True when a failed `prompt` response is Pi's "already processing" CONCURRENCY
 * rejection — a second prompt sent mid-turn with no `streamingBehavior`. Pi
 * throws this (vendor `dist/core/agent-session.js`) when the turn is STILL ALIVE,
 * so it is NOT terminal: the in-flight turn will still emit its own `agent_end`.
 *
 * Matched defensively (lowercased substring, not exact-string) so a reworded or
 * reframed vendor message still classifies — the literal text is:
 *   "Agent is already processing. Specify streamingBehavior ('steer' or
 *    'followUp') to queue the message."
 * The discriminating phrase is "already processing"; we additionally require the
 * "agent" subject so an unrelated error that merely contains those words does not
 * get mis-classified as recoverable.
 */
export function isPiAlreadyProcessingRejection(error: unknown): boolean {
  if (typeof error !== "string") {
    return false;
  }
  const normalized = error.toLowerCase();
  return normalized.includes("already processing") && normalized.includes("agent");
}

function extractFinalAssistantInfo(messages: unknown): FinalAssistantInfo {
  if (!Array.isArray(messages)) {
    return { text: "" };
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (
      msg &&
      typeof msg === "object" &&
      (msg as { role?: unknown }).role === "assistant"
    ) {
      const stopReason = (msg as { stopReason?: unknown }).stopReason;
      const errorMessage = (msg as { errorMessage?: unknown }).errorMessage;
      return {
        text: extractAssistantText(msg),
        stopReason: typeof stopReason === "string" ? stopReason : undefined,
        errorMessage: typeof errorMessage === "string" ? errorMessage : undefined,
      };
    }
  }
  return { text: "" };
}

function isErrorStopReason(stopReason: string | undefined): boolean {
  return stopReason?.toLowerCase() === "error";
}

function isContextOverflowError(message: unknown): boolean {
  if (typeof message !== "string") {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes("context_length_exceeded") ||
    normalized.includes("exceeds the context window") ||
    normalized.includes("maximum context length") ||
    normalized.includes("too many tokens")
  );
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function buildPiRpcErrorResult(message: string, sessionId: string | undefined): ResultMessage {
  return {
    type: "result",
    subtype: "error_during_execution",
    result: message,
    session_id: sessionId ?? "",
    is_error: true,
  };
}

function buildPiRpcRetryResetEvent(reason = "pi_context_overflow_retry"): ControlRequest {
  return {
    type: "assistant",
    subtype: "control_request",
    action: "reset_response_text",
    reason,
  };
}

function clearPendingOverflow(state: PiRpcParseState): void {
  state.pendingOverflowErrorMessage = undefined;
  state.pendingOverflowSessionId = undefined;
}

function emitPiRpcResult(
  result: ResultMessage,
  state?: PiRpcParseState,
): ResultMessage | null {
  if (!state) {
    return result;
  }
  if (state.terminalResultEmitted) {
    return null;
  }
  state.terminalResultEmitted = true;
  state.pendingOutcome = undefined;
  state.currentRunHasStreamOutput = undefined;
  state.completedRunHasStreamOutput = undefined;
  state.completedRunResetEmitted = undefined;
  clearPendingOverflow(state);
  return result;
}

function buildOverflowAwareErrorResult(state: PiRpcParseState, rawEvent?: PiRpcEvent): ResultMessage {
  const recoveryFailureMessage =
    nonEmptyText(rawEvent?.errorMessage) ??
    nonEmptyText(rawEvent?.error) ??
    nonEmptyText(rawEvent?.message);
  const overflowMessage = nonEmptyText(state.pendingOverflowErrorMessage);
  const message =
    recoveryFailureMessage && overflowMessage && !recoveryFailureMessage.includes(overflowMessage)
      ? `${recoveryFailureMessage}; original overflow: ${overflowMessage}`
      : recoveryFailureMessage ?? overflowMessage ?? PI_RPC_OVERFLOW_FAILURE_MESSAGE;
  const sessionId = rawEvent?.sessionId ?? state.pendingOverflowSessionId ?? state.observedSessionId;
  return buildPiRpcErrorResult(message, sessionId);
}

function rememberPendingOverflow(
  state: PiRpcParseState,
  message: string,
  sessionId: string | undefined,
): void {
  state.pendingOverflowErrorMessage ??= message;
  state.pendingOverflowSessionId ??= sessionId ?? state.observedSessionId;
}

function retainAgentEndOutcome(
  state: PiRpcParseState,
  outcome: ResultMessage | undefined,
): void {
  state.pendingOutcome = outcome;
  state.completedRunHasStreamOutput = state.currentRunHasStreamOutput;
  state.currentRunHasStreamOutput = undefined;
  state.completedRunResetEmitted = undefined;
}

function consumeSettledOutcome(state?: PiRpcParseState): ResultMessage | null {
  if (!state) {
    return buildPiRpcErrorResult(PI_RPC_SETTLED_WITHOUT_OUTCOME_MESSAGE, undefined);
  }
  const outcome = state.pendingOutcome;
  if (outcome && nonEmptyText(outcome.result)) {
    return emitPiRpcResult(outcome, state);
  }
  return emitPiRpcResult(
    buildPiRpcErrorResult(PI_RPC_SETTLED_WITHOUT_OUTCOME_MESSAGE, state.observedSessionId),
    state,
  );
}

function consumeEofOutcome(state: PiRpcParseState): ResultMessage | null {
  const outcome = state.pendingOutcome;
  if (outcome?.is_error === true && nonEmptyText(outcome.result)) {
    return emitPiRpcResult(outcome, state);
  }
  return emitPiRpcResult(
    buildPiRpcErrorResult(
      PI_RPC_EXIT_BEFORE_SETTLED_MESSAGE,
      nonEmptyText(outcome?.session_id) ?? state.observedSessionId,
    ),
    state,
  );
}

function markCompletedRunReset(
  state: PiRpcParseState,
  reason = "pi_context_overflow_retry",
): ControlRequest | null {
  if (state.completedRunResetEmitted) {
    return null;
  }
  state.completedRunResetEmitted = true;
  return buildPiRpcRetryResetEvent(reason);
}

/**
 * Translate a single Pi RPC event into the bot's existing 8-variant `StreamLine`
 * union so the downstream stream-relay/delivery path needs no changes.
 *
 * Mapping (per Plan A Technical Details, field shapes per Pi's `docs/rpc.md`):
 * - `message_update` w/ `assistantMessageEvent.type === "text_delta"` → `StreamEvent`
 *   carrying `event.delta = { type: "text_delta", text }` from the Pi event's
 *   `assistantMessageEvent.delta` chunk (drives live streaming).
 * - `tool_execution_start` → synthetic `StreamEvent` shaped as a
 *   `content_block_start` tool_use block so stream-relay flips `sawNonTextBlock`.
 * - `agent_end` → retains the latest low-level run outcome without yielding a
 *   terminal result. Pi may still retry, compact, or drain queued continuations.
 * - a later `agent_start` → resets response text left by the completed run before
 *   a queued continuation begins, unless retry/compaction already reset it.
 * - `agent_settled` → consumes the latest retained outcome and yields the one
 *   terminal `ResultMessage` for the accepted prompt.
 * - `compaction_start` / `compaction_end` → ignored unless a prior overflow
 *   `agent_end` is pending; a failed compaction end is retained until settlement.
 * - `turn_end` → `null`. It is a per-turn boundary that fires once PER turn, so a
 *   multi-turn (tool-using) response emits several `turn_end`s before `agent_end`.
 *   Neither boundary settles the accepted prompt.
 * - `response` → a successful `get_state`/`get_session_stats` reply yields a
 *   `SystemInit` capturing `data.sessionId` (the ONLY place Pi exposes the
 *   session id — no event carries it). A failed reply (`success: false`) is
 *   correlated by `command`: a failed `prompt` is a preflight rejection and
 *   yields an error `ResultMessage` (the turn was never accepted), while Pi's
 *   "already processing" concurrency
 *   rejection returns null + logs (the in-flight turn is still alive and will
 *   emit its own `agent_end`). A failed side-command (`steer`, `get_state`,
 *   `set_model`, …) likewise returns null + logs — mapping it to a terminal
 *   result would truncate the in-flight prompt turn whose stdout it shares.
 * - `auto_retry_start` / `auto_retry_end` → `RateLimitEvent` (raw error message
 *   preserved for the Task 4 retry classifier).
 * - `error` → retains an error outcome until settlement when state is present.
 *
 * Returns null for unknown/ignored records (e.g. `tool_execution_update/end`,
 * non-text `message_update` deltas, responses with no session id) so the caller
 * skips them.
 */
export function parsePiEvent(
  rawEvent: PiRpcEvent | null | undefined,
  state?: PiRpcParseState,
): StreamLine | null {
  if (!rawEvent || typeof rawEvent !== "object") {
    return null;
  }

  if (
    state?.terminalResultEmitted &&
    ["agent_end", "agent_settled", "compaction_start", "compaction_end", "error"].includes(
      rawEvent.type ?? "",
    )
  ) {
    return null;
  }

  switch (rawEvent.type) {
    case "message_update": {
      const inner = rawEvent.assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.delta === "string" && inner.delta.length > 0) {
        if (state) {
          state.currentRunHasStreamOutput = true;
        }
        const event: StreamEvent = {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: inner.delta },
          },
        };
        return event;
      }
      return null;
    }

    case "tool_execution_start": {
      if (state) {
        state.currentRunHasStreamOutput = true;
      }
      const toolName = rawEvent.toolName ?? rawEvent.tool?.name ?? "tool";
      const event: StreamEvent = {
        type: "stream_event",
        event: {
          type: "content_block_start",
          content_block: { type: "tool_use", name: toolName },
        },
      };
      return event;
    }

    case "turn_end":
      // Per-turn boundary, NOT terminal. A multi-turn response fires turn_end
      // once per turn, and the accepted prompt remains active through settlement.
      return null;

    case "agent_start":
      if (state) {
        state.agentLifecycleObserved = true;
      }
      if (state?.completedRunHasStreamOutput) {
        return markCompletedRunReset(state, "pi_queued_continuation");
      }
      return null;

    case "agent_end": {
      const finalAssistant = extractFinalAssistantInfo(rawEvent.messages);
      const isFinalAssistantError = isErrorStopReason(finalAssistant.stopReason);
      if (!state) {
        // Correct lifecycle translation requires state so the low-level outcome
        // can be consumed by a later agent_settled record.
        return null;
      }
      state.agentLifecycleObserved = true;
      const sessionId = rawEvent.sessionId ?? state.observedSessionId;
      if (isFinalAssistantError && isContextOverflowError(finalAssistant.errorMessage)) {
        const overflowMessage =
          nonEmptyText(finalAssistant.errorMessage) ?? PI_RPC_OVERFLOW_FAILURE_MESSAGE;
        rememberPendingOverflow(state, overflowMessage, sessionId);
        retainAgentEndOutcome(
          state,
          buildOverflowAwareErrorResult(state, { ...rawEvent, errorMessage: overflowMessage }),
        );
        if (rawEvent.willRetry === true) {
          return markCompletedRunReset(state);
        }
        return null;
      }
      if (isFinalAssistantError) {
        const outcome = state.pendingOverflowErrorMessage
          ? buildOverflowAwareErrorResult(state, {
            ...rawEvent,
            errorMessage: nonEmptyText(finalAssistant.errorMessage) ?? PI_RPC_AGENT_FAILURE_MESSAGE,
          })
          : buildPiRpcErrorResult(
              nonEmptyText(finalAssistant.errorMessage) ?? PI_RPC_AGENT_FAILURE_MESSAGE,
              sessionId,
            );
        clearPendingOverflow(state);
        retainAgentEndOutcome(state, outcome);
        if (rawEvent.willRetry === true) {
          return markCompletedRunReset(state, "pi_agent_retry");
        }
        return null;
      }
      clearPendingOverflow(state);
      retainAgentEndOutcome(
        state,
        finalAssistant.text.trim().length > 0
          ? {
              type: "result",
              result: finalAssistant.text,
              session_id: sessionId ?? "",
            }
          : undefined,
      );
      return null;
    }

    case "agent_settled":
      if (state) {
        state.agentLifecycleObserved = true;
      }
      return consumeSettledOutcome(state);

    case "compaction_start":
      if (state?.pendingOverflowErrorMessage) {
        return markCompletedRunReset(state);
      }
      return null;

    case "compaction_end":
      if (!state?.pendingOverflowErrorMessage) {
        return null;
      }
      if (rawEvent.willRetry === true) {
        return markCompletedRunReset(state);
      }
      if (
        rawEvent.willRetry === false ||
        rawEvent.success === false ||
        rawEvent.aborted === true ||
        nonEmptyText(rawEvent.errorMessage) ||
        nonEmptyText(rawEvent.error) ||
        nonEmptyText(rawEvent.message)
      ) {
        state.pendingOutcome = buildOverflowAwareErrorResult(state, rawEvent);
        clearPendingOverflow(state);
      }
      return null;

    case "response": {
      // Command responses are side-channel replies, NOT prompt-turn stream
      // content. The terminal event of an accepted prompt is `agent_settled`.
      // A `response` shares the same stdout the active turn
      // is reading, so it must be correlated by `command` before being treated
      // as terminal:
      //  - a failed `prompt` response is terminal because Pi 0.80.6 emits it
      //    only when preflight rejects before acceptance; no agent lifecycle
      //    records will follow for that prompt.
      //  - EXCEPT Pi's "already processing" concurrency rejection (a second,
      //    concurrent prompt colliding with a turn that is STILL ALIVE). That
      //    turn will still emit its own `agent_end`, so terminating here would
      //    (a) truncate the live answer, (b) relay Pi's internal error to the
      //    user as the "answer", (c) clear busy/processingStartedAt early →
      //    wedge. Log + return null so the in-flight turn proceeds untouched;
      //    the queue-driven send path proactively uses followUp to avoid the
      //    collision in the first place.
      //  - a failed side-command response (`steer`, `get_state`, `set_model`, …)
      //    must NOT be mapped to a terminal result: a mid-turn `steer` rejection
      //    would otherwise truncate the in-flight response (and the steered
      //    message has already been dropped from the queue). Log + return null so
      //    the failure is visible without ending the turn.
      // A successful `get_state`/`get_session_stats` reply carries the Pi-minted
      // session id (no event exposes it) and is captured below.
      if (
        rawEvent.command === "prompt" &&
        state?.expectedPromptId &&
        rawEvent.id !== state.expectedPromptId
      ) {
        return null;
      }
      if (rawEvent.success === false) {
        if (rawEvent.command === "prompt") {
          if (isPiAlreadyProcessingRejection(rawEvent.error)) {
            log.warn(
              "pi-rpc",
              `Pi rejected a concurrent prompt as "already processing" — NOT terminating the in-flight turn: ${nonEmptyText(rawEvent.error) ?? "(none)"}`,
            );
            return null;
          }
          const promptErrorMessage = nonEmptyText(rawEvent.error) ?? "Pi RPC command failed";
          // In Pi 0.80.6 a failed prompt response is emitted only when preflight
          // rejected before acceptance, so it is terminal without agent_settled.
          return emitPiRpcResult(
            buildPiRpcErrorResult(promptErrorMessage, rawEvent.sessionId),
            state,
          );
        }
        log.warn(
          "pi-rpc",
          `Pi RPC command failed (ignored in stream): command=${rawEvent.command ?? "unknown"} error=${nonEmptyText(rawEvent.error) ?? "(none)"}`,
        );
        return null;
      }
      const sessionId = rawEvent.data?.sessionId;
      if (typeof sessionId === "string" && sessionId.length > 0) {
        if (state) {
          state.observedSessionId = sessionId;
        }
        const init: SystemInit = {
          type: "system",
          subtype: "init",
          session_id: sessionId,
        };
        return init;
      }
      return null;
    }

    case "auto_retry_start":
    case "auto_retry_end": {
      const rateLimit: RateLimitEvent = {
        type: "assistant",
        subtype: "rate_limit_event",
        pi_event_type: rawEvent.type,
        error_message: rawEvent.errorMessage ?? "",
      };
      return rateLimit;
    }

    case "error": {
      const fallbackMessage =
        typeof rawEvent.message === "string" ? rawEvent.message : undefined;
      if (state) {
        state.pendingOutcome = state.pendingOverflowErrorMessage
          ? buildOverflowAwareErrorResult(state, rawEvent)
          : buildPiRpcErrorResult(
              rawEvent.errorMessage ?? fallbackMessage ?? "Pi RPC error",
              rawEvent.sessionId ?? state.observedSessionId,
            );
        clearPendingOverflow(state);
        return null;
      }
      return buildPiRpcErrorResult(
        rawEvent.errorMessage ?? fallbackMessage ?? "Pi RPC error",
        rawEvent.sessionId,
      );
    }

    default:
      return null;
  }
}

type PiStdoutWaitResult = "readable" | "end" | "close";

function waitForPiStdout(stdout: Readable): Promise<PiStdoutWaitResult> {
  if (stdout.readableEnded) {
    return Promise.resolve("end");
  }
  if (stdout.destroyed) {
    return Promise.resolve("close");
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdout.off("readable", onReadable);
      stdout.off("end", onEnd);
      stdout.off("close", onClose);
      stdout.off("error", onError);
    };
    const finish = (result: PiStdoutWaitResult) => {
      cleanup();
      resolve(result);
    };
    const onReadable = () => finish("readable");
    const onEnd = () => finish("end");
    const onClose = () => finish("close");
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    stdout.once("readable", onReadable);
    stdout.once("end", onEnd);
    stdout.once("close", onClose);
    stdout.once("error", onError);
  });
}

export type PiExtensionUiRequestHandling = "not_ui" | "nonblocking" | "blocking";

export class PiStartupBlockingUiError extends Error {
  constructor() {
    super("Pi requested unsupported blocking extension UI before RPC startup completed");
    this.name = "PiStartupBlockingUiError";
  }
}

function handlePiExtensionUiRequest(
  child: ChildProcess,
  event: PiRpcEvent,
): PiExtensionUiRequestHandling {
  if (event.type !== "extension_ui_request") {
    return "not_ui";
  }

  const cancellation = buildPiExtensionUiCancellationCommand(event);
  if (cancellation) {
    try {
      writePiCommand(child, cancellation);
    } catch {
      // The prompt lifecycle remains authoritative even when stdin has already
      // closed. A failed side-channel cancellation must not truncate the turn.
      log.warn("pi-rpc", "Unable to cancel unsupported Pi extension UI request: child stdin unavailable");
    }
    return "blocking";
  }

  if (!isNonEmptyString(event.id) || !isNonEmptyString(event.method)) {
    log.warn("pi-rpc", "Ignored malformed Pi extension UI request: missing non-empty id or method");
    return "nonblocking";
  }
  if (!PI_FIRE_AND_FORGET_EXTENSION_UI_METHODS.has(event.method)) {
    log.warn("pi-rpc", "Ignored unknown Pi extension UI request method");
  }
  return "nonblocking";
}

function parsePiJsonlRecord(record: string): PiRpcEvent | null {
  const trimmed = record.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as PiRpcEvent;
  } catch {
    return null;
  }
}

/**
 * Route an extension UI JSONL record through the shared cancellation writer.
 * Startup capture uses the result to fail promptly on blocking dialogs: Pi
 * 0.80.6 does not attach its RPC stdin reader until session_start handlers have
 * completed, so a handler awaiting a dialog cannot consume its cancellation.
 */
export function handlePiExtensionUiRecord(
  child: ChildProcess,
  record: string,
): PiExtensionUiRequestHandling {
  const event = parsePiJsonlRecord(record);
  return event ? handlePiExtensionUiRequest(child, event) : "not_ui";
}

/** Route startup side channels and extract a Pi-minted session id when present. */
export function parsePiStartupRecord(child: ChildProcess, record: string): string | null {
  if (handlePiExtensionUiRecord(child, record) === "blocking") {
    throw new PiStartupBlockingUiError();
  }
  const line = parsePiRecord(record);
  if (
    line?.type === "system" &&
    typeof line.session_id === "string" &&
    line.session_id.length > 0
  ) {
    return line.session_id;
  }
  return null;
}

function handlePiStreamRecord(
  child: ChildProcess,
  record: string,
  state: PiRpcParseState,
  onActivity?: () => void,
): StreamLine | null {
  const event = parsePiJsonlRecord(record);
  if (!event) {
    return null;
  }
  onActivity?.();
  if (handlePiExtensionUiRequest(child, event) !== "not_ui") {
    return null;
  }
  const promptCompletionProbe = handlePiPromptCompletionProbe(child, event, state);
  if (promptCompletionProbe.handled) {
    return promptCompletionProbe.line;
  }
  return parsePiEvent(event, state);
}

interface PiPromptCompletionProbeResult {
  handled: boolean;
  line: StreamLine | null;
}

/**
 * Pi 0.80.6 accepts extension commands and `input` handlers that finish without
 * starting an agent run. Those paths emit a successful prompt response but no
 * agent lifecycle events. Probe the correlated session state after acceptance:
 * an active/queued model turn remains authoritative through agent_settled,
 * while an idle prompt completes successfully with no fabricated reply text.
 */
function handlePiPromptCompletionProbe(
  child: ChildProcess,
  event: PiRpcEvent,
  state: PiRpcParseState,
): PiPromptCompletionProbeResult {
  if (
    event.type === "response" &&
    event.command === "prompt" &&
    event.success === true &&
    state.expectedPromptId &&
    event.id === state.expectedPromptId
  ) {
    if (!state.promptStateProbeId) {
      state.promptStateProbeId = `${state.expectedPromptId}-state`;
      sendPiGetState(child, state.promptStateProbeId);
    }
    return { handled: true, line: null };
  }

  if (
    event.type !== "response" ||
    event.command !== "get_state" ||
    !state.promptStateProbeId ||
    event.id !== state.promptStateProbeId
  ) {
    return { handled: false, line: null };
  }

  const sessionId = nonEmptyText(event.data?.sessionId);
  if (sessionId) {
    state.observedSessionId = sessionId;
  }
  if (
    event.success === true &&
    event.data?.isStreaming === false &&
    !state.agentLifecycleObserved
  ) {
    return {
      handled: true,
      line: emitPiRpcResult(
        { type: "result", result: "", session_id: sessionId ?? state.observedSessionId ?? "" },
        state,
      ),
    };
  }
  return { handled: true, line: null };
}

/**
 * Async generator yielding translated `StreamLine`s from a Pi RPC child's
 * stdout: newline-only splitter → `JSON.parse` → `parsePiEvent`. The reader
 * remains active through low-level run boundaries and ends only on the settled
 * result, prompt preflight rejection, or an EOF/close fallback. Blocking
 * extension UI requests are cancelled through the child's shared JSONL stdin
 * writer before stream delivery. `onActivity` runs for every valid JSON record,
 * including lifecycle and UI records that do not become user-facing lines, so
 * callers can maintain an accurate inactivity watchdog. Malformed JSON records
 * and untranslatable events are skipped (never throw mid-stream).
 */
export async function* readPiStream(
  child: ChildProcess,
  onActivity?: () => void,
  expectedPromptId?: string,
): AsyncGenerator<StreamLine> {
  const stdout = child.stdout;
  if (!stdout) {
    throw new Error("Pi RPC child process stdout is not available");
  }

  const splitter = new NewlineOnlyJsonlSplitter();
  const parseState: PiRpcParseState = { expectedPromptId };

  for (;;) {
    let chunk: Buffer | string | null;
    while ((chunk = stdout.read()) !== null) {
      for (const record of splitter.push(chunk)) {
        const line = handlePiStreamRecord(child, record, parseState, onActivity);
        if (line) {
          yield line;
          if (line.type === "result") {
            return;
          }
        }
      }
    }

    const waitResult = await waitForPiStdout(stdout);
    if (waitResult === "end" || waitResult === "close") {
      break;
    }
  }

  for (const record of splitter.end()) {
    const line = handlePiStreamRecord(child, record, parseState, onActivity);
    if (line) {
      yield line;
      if (line.type === "result") {
        return;
      }
    }
  }

  const eofResult = consumeEofOutcome(parseState);
  if (eofResult) {
    yield eofResult;
  }
}

export function parsePiRecord(record: string, state?: PiRpcParseState): StreamLine | null {
  const parsed = parsePiJsonlRecord(record);
  return parsed ? parsePiEvent(parsed, state) : null;
}

/**
 * Extract streamable text from a translated Pi `StreamLine`.
 */
export function extractPiTextDelta(msg: StreamLine): string | null {
  if (msg.type === "stream_event") {
    const event = msg.event;
    if (event?.delta?.type === "text_delta" && event.delta.text) {
      return event.delta.text;
    }
  }
  return null;
}
