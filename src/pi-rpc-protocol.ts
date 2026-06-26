import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
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
  MINIME_AGENT_WORKSPACE_ROOT_ENV,
  MINIME_CONFIG_PATH_ENV,
  MINIME_CONTROL_WORKSPACE_ROOT_ENV,
  MINIME_CRONS_PATH_ENV,
  resolveAgentWorkspaceCwd,
  resolveWorkspaceContract,
  type ResolvedWorkspaceContract,
} from "./workspace-contract.js";

const PI_BIN = "pi";
const PI_PROVIDER = "openai-codex";
const DEFAULT_PI_MODEL = "openai-codex/gpt-5.5";

/**
 * Wrapper entrypoints loaded into EVERY Pi spawn, in load order:
 *   web-tools (Tavily web_search/web_fetch),
 *   knowledge-tools (knowledge_search/knowledge_get/knowledge_update + managed wiki protection),
 *   subagent (isolated `pi -p` child spawn).
 * Paths are relative to {@link DEFAULT_PI_EXTENSIONS_DIR}. subagent is a multi-file
 * DIRECTORY whose entrypoint is `index.ts`.
 */
export const PI_EXTENSION_WRAPPER_RELPATHS = [
  "web-tools.ts",
  "knowledge-tools.ts",
  "subagent/index.ts",
] as const;

export const PI_EXTENSION_ARTIFACT_WRAPPER_RELPATHS = [
  "web-tools.js",
  "knowledge-tools.js",
  "subagent/index.js",
] as const;

/**
 * Wrappers a subagent CHILD `pi` spawn must load. The subagent tool spawns an
 * isolated `pi -p` child to run a delegated task. Children load web tools and
 * knowledge tools/protection, but they do NOT load the subagent wrapper:
 * recursive spawning stays disabled in child sessions.
 */
export const PI_SUBAGENT_CHILD_WRAPPER_RELPATHS = ["web-tools.ts", "knowledge-tools.ts"] as const;

/**
 * Wrappers a Pi print-mode cron must load. Crons need the Knowledge wrapper so
 * managed wiki writes are protected, but do not get interactive web-tools or
 * subagent parity.
 */
export const PI_CRON_WRAPPER_RELPATHS = ["knowledge-tools.ts"] as const;

export const PI_SUBAGENT_CHILD_ARTIFACT_WRAPPER_RELPATHS = ["web-tools.js", "knowledge-tools.js"] as const;

/**
 * Kill-switch env var: set to exactly `"1"` to spawn Pi with no explicit
 * extensions. Spawns still pass `--no-extensions` so Pi's ambient extension
 * discovery remains disabled.
 */
export const PI_EXTENSIONS_DISABLED_ENV = "PI_EXTENSIONS_DISABLED";
export const MINIME_BOT_PI_SESSION_ENV = "MINIME_BOT_PI_SESSION";
export const MINIME_ASK_CALLER_AGENT_ID_ENV = "MINIME_ASK_CALLER_AGENT_ID";

export interface PiExtensionResolveOptions {
  /** Override the wrapper base dir (default: resolved workspace/package contract). */
  extensionsDir?: string;
  /** Override env lookup for the kill-switch (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Override the existence check (default: `fs.existsSync`). */
  exists?: (path: string) => boolean;
  /**
   * Which wrapper relpaths to resolve (default: the full interactive
   * {@link PI_EXTENSION_WRAPPER_RELPATHS}). A subagent child passes
   * {@link PI_SUBAGENT_CHILD_WRAPPER_RELPATHS} to load web tools while leaving
   * recursive subagent spawning disabled.
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
}

const PI_CHILD_ENV_KEY_ALLOWLIST = new Set([
  "CI",
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LOGNAME",
  MINIME_AGENT_WORKSPACE_ROOT_ENV,
  MINIME_ASK_CALLER_AGENT_ID_ENV,
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
}

export type PiRpcCommand = PiPromptCommand | PiSteerCommand | PiGetStateCommand;

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
  args.push(...resolvePiExtensionArgs(extensionOptions));
  args.push(...resolvePiExtraExtensionArgs(extensionOptions));

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
  delete env[MINIME_ASK_CALLER_AGENT_ID_ENV];
  env[MINIME_CONTROL_WORKSPACE_ROOT_ENV] = contract.paths.controlWorkspaceRoot;
  const agentRoot = agentWorkspaceRoot?.trim();
  if (agentRoot) {
    env[MINIME_AGENT_WORKSPACE_ROOT_ENV] = normalize(resolve(agentRoot));
  }
  const askCallerAgentId = runtimeEnvOptions?.askCallerAgentId?.trim();
  if (askCallerAgentId) {
    env[MINIME_ASK_CALLER_AGENT_ID_ENV] = askCallerAgentId;
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
  const child = spawn(PI_BIN, buildPiSpawnArgs(spawnAgent, resumeSessionId, extensionOptions), {
    env,
    cwd: workspaceCwd,
    stdio: ["pipe", "pipe", "pipe"],
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
): PiPromptCommand {
  const command: PiPromptCommand = { type: "prompt", message: text };
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

export function buildGetStateCommand(): PiGetStateCommand {
  return { type: "get_state" };
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
): void {
  writePiCommand(child, buildPiPromptCommand(text, streamingBehavior));
}

export function sendPiSteer(child: ChildProcess, text: string): void {
  writePiCommand(child, buildPiSteerCommand(text));
}

/**
 * Issue a `get_state` command. Its successful `response` carries the Pi-minted
 * session id, which `parsePiEvent` surfaces as a `SystemInit` — the bot's only
 * hook for capturing + persisting that id for resume.
 */
export function sendPiGetState(child: ChildProcess): void {
  writePiCommand(child, buildGetStateCommand());
}

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
  pendingOverflowErrorMessage?: string;
  pendingOverflowResetEmitted?: boolean;
}

const PI_RPC_AGENT_FAILURE_MESSAGE = "Pi RPC agent failed";
const PI_RPC_OVERFLOW_FAILURE_MESSAGE = "Pi RPC context overflow recovery failed";

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

function buildPiRpcRetryResetEvent(): ControlRequest {
  return {
    type: "assistant",
    subtype: "control_request",
    action: "reset_response_text",
    reason: "pi_context_overflow_retry",
  };
}

function finishPiRpcResult(result: ResultMessage, state?: PiRpcParseState): ResultMessage {
  if (state) {
    state.pendingOverflowErrorMessage = undefined;
    state.pendingOverflowResetEmitted = undefined;
  }
  return result;
}

function buildPendingOverflowErrorResult(state: PiRpcParseState, rawEvent?: PiRpcEvent): ResultMessage {
  const message =
    nonEmptyText(rawEvent?.errorMessage) ??
    nonEmptyText(rawEvent?.error) ??
    nonEmptyText(rawEvent?.message) ??
    state.pendingOverflowErrorMessage ??
    PI_RPC_OVERFLOW_FAILURE_MESSAGE;
  state.pendingOverflowErrorMessage = undefined;
  state.pendingOverflowResetEmitted = undefined;
  return buildPiRpcErrorResult(message, rawEvent?.sessionId);
}

function markPendingOverflowRetry(state: PiRpcParseState): ControlRequest | null {
  if (state.pendingOverflowResetEmitted) {
    return null;
  }
  state.pendingOverflowResetEmitted = true;
  return buildPiRpcRetryResetEvent();
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
 * - `agent_end` → terminal `ResultMessage`; the result text is the FINAL assistant
 *   message text reconstructed from `agent_end.messages`. A context overflow
 *   `agent_end` can be followed by compaction/retry records even though
 *   `agent_end` itself carries no retry field in Pi's RPC contract, so the
 *   stateful stream reader defers that overflow-only record until recovery
 *   succeeds, fails, or stdout ends.
 * - `compaction_start` / `compaction_end` → ignored unless a prior overflow
 *   `agent_end` is pending; a failed compaction end becomes the visible terminal
 *   error for that deferred overflow.
 * - `turn_end` → `null`. It is a per-turn boundary that fires once PER turn, so a
 *   multi-turn (tool-using) response emits several `turn_end`s before its single
 *   `agent_end`. Treating `turn_end` as terminal truncates such responses at their
 *   first turn — only `agent_end` is terminal.
 * - `response` → a successful `get_state`/`get_session_stats` reply yields a
 *   `SystemInit` capturing `data.sessionId` (the ONLY place Pi exposes the
 *   session id — no event carries it). A failed reply (`success: false`) is
 *   correlated by `command`: a failed `prompt` with a context-overflow error
 *   follows the same deferred recovery path as an overflow-only `agent_end`; a
 *   failed `prompt` with another REAL rejection yields an error `ResultMessage`
 *   (the turn cannot proceed), while Pi's "already processing" concurrency
 *   rejection returns null + logs (the in-flight turn is still alive and will
 *   emit its own `agent_end`). A failed side-command (`steer`, `get_state`,
 *   `set_model`, …) likewise returns null + logs — mapping it to a terminal
 *   result would truncate the in-flight prompt turn whose stdout it shares.
 * - `auto_retry_start` / `auto_retry_end` → `RateLimitEvent` (raw error message
 *   preserved for the Task 4 retry classifier).
 * - `error` → error `ResultMessage` (`subtype: "error_during_execution"`).
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

  switch (rawEvent.type) {
    case "message_update": {
      const inner = rawEvent.assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.delta === "string" && inner.delta.length > 0) {
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
      // Per-turn boundary, NOT terminal. A multi-turn (tool-using) response fires
      // turn_end once per turn; the run only truly ends at agent_end (fires once).
      // Mapping turn_end to a ResultMessage truncates such responses at turn 1.
      return null;

    case "agent_end": {
      const finalAssistant = extractFinalAssistantInfo(rawEvent.messages);
      const isFinalAssistantError = isErrorStopReason(finalAssistant.stopReason);
      if (
        isFinalAssistantError &&
        finalAssistant.text.length === 0 &&
        isContextOverflowError(finalAssistant.errorMessage)
      ) {
        const overflowMessage =
          nonEmptyText(finalAssistant.errorMessage) ?? PI_RPC_OVERFLOW_FAILURE_MESSAGE;
        if (state) {
          if (rawEvent.willRetry === false) {
            return finishPiRpcResult(
              buildPiRpcErrorResult(overflowMessage, rawEvent.sessionId),
              state,
            );
          }
          state.pendingOverflowErrorMessage = overflowMessage;
          if (rawEvent.willRetry === true) {
            return markPendingOverflowRetry(state);
          }
          return null;
        }
        if (rawEvent.willRetry === true) {
          return null;
        }
      }
      if (isFinalAssistantError && finalAssistant.text.length === 0) {
        return finishPiRpcResult(
          buildPiRpcErrorResult(
            nonEmptyText(finalAssistant.errorMessage) ?? PI_RPC_AGENT_FAILURE_MESSAGE,
            rawEvent.sessionId,
          ),
          state,
        );
      }
      const result: ResultMessage = {
        type: "result",
        result: finalAssistant.text,
        session_id: rawEvent.sessionId ?? "",
      };
      return finishPiRpcResult(result, state);
    }

    case "compaction_start":
      if (state?.pendingOverflowErrorMessage) {
        return markPendingOverflowRetry(state);
      }
      return null;

    case "compaction_end":
      if (!state?.pendingOverflowErrorMessage) {
        return null;
      }
      if (rawEvent.willRetry === true) {
        return markPendingOverflowRetry(state);
      }
      if (
        rawEvent.willRetry === false ||
        rawEvent.success === false ||
        rawEvent.aborted === true ||
        nonEmptyText(rawEvent.errorMessage) ||
        nonEmptyText(rawEvent.error) ||
        nonEmptyText(rawEvent.message)
      ) {
        return buildPendingOverflowErrorResult(state, rawEvent);
      }
      return null;

    case "response": {
      // Command responses are side-channel replies, NOT prompt-turn stream
      // content. The terminal event of a prompt turn is `agent_end` (or a
      // top-level `error`). A `response` shares the same stdout the active turn
      // is reading, so it must be correlated by `command` before being treated
      // as terminal:
      //  - a failed `prompt` response with a context-overflow error can be
      //    followed by Pi compaction/continuation, so the stateful reader defers
      //    it just like the overflow-only `agent_end` path above.
      //  - a failed `prompt` response with another REAL rejection IS terminal —
      //    the prompt was rejected with no live turn behind it, so no `agent_end`
      //    will ever arrive; surface it as an error result so the turn ends now
      //    instead of hanging until the activity timeout.
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
          if (isContextOverflowError(rawEvent.error) && state) {
            if (rawEvent.willRetry === false) {
              return finishPiRpcResult(
                buildPiRpcErrorResult(promptErrorMessage, rawEvent.sessionId),
                state,
              );
            }
            state.pendingOverflowErrorMessage = promptErrorMessage;
            return null;
          }
          return finishPiRpcResult(
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
      const result: ResultMessage = {
        type: "result",
        subtype: "error_during_execution",
        result: rawEvent.errorMessage ?? fallbackMessage ?? "Pi RPC error",
        session_id: rawEvent.sessionId ?? "",
        is_error: true,
      };
      return finishPiRpcResult(result, state);
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

/**
 * Async generator yielding translated `StreamLine`s from a Pi RPC child's
 * stdout: newline-only splitter → `JSON.parse` → `parsePiEvent`. Malformed
 * JSON records and untranslatable events are skipped (never throw mid-stream).
 */
export async function* readPiStream(child: ChildProcess): AsyncGenerator<StreamLine> {
  const stdout = child.stdout;
  if (!stdout) {
    throw new Error("Pi RPC child process stdout is not available");
  }

  const splitter = new NewlineOnlyJsonlSplitter();
  const parseState: PiRpcParseState = {};

  for (;;) {
    let chunk: Buffer | string | null;
    while ((chunk = stdout.read()) !== null) {
      for (const record of splitter.push(chunk)) {
        const line = parsePiRecord(record, parseState);
        if (line) {
          yield line;
        }
      }
    }

    const waitResult = await waitForPiStdout(stdout);
    if (waitResult === "end" || waitResult === "close") {
      break;
    }
  }

  for (const record of splitter.end()) {
    const line = parsePiRecord(record, parseState);
    if (line) {
      yield line;
    }
  }

  if (parseState.pendingOverflowErrorMessage) {
    yield buildPendingOverflowErrorResult(parseState);
  }
}

export function parsePiRecord(record: string, state?: PiRpcParseState): StreamLine | null {
  const trimmed = record.trim();
  if (!trimmed || !trimmed.startsWith("{")) {
    return null;
  }

  let parsed: PiRpcEvent;
  try {
    parsed = JSON.parse(trimmed) as PiRpcEvent;
  } catch {
    return null;
  }

  return parsePiEvent(parsed, state);
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
