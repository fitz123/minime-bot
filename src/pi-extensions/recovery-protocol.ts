import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { request as httpRequest, type RequestOptions } from "node:http";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  assertRecoveryToolCallAllowed,
  parseRecoveryMode,
  type RecoveryMode,
} from "./recovery-mode.js";

export const RECOVERY_ENV = Object.freeze({
  endpoint: "MINIME_RECOVERY_ENDPOINT",
  fixerCredentialFile: "MINIME_RECOVERY_FIXER_CREDENTIAL_FILE",
  mode: "MINIME_RECOVERY_MODE",
  invocationId: "MINIME_RECOVERY_INVOCATION_ID",
  incidentId: "MINIME_RECOVERY_INCIDENT_ID",
  generation: "MINIME_RECOVERY_GENERATION",
  evidenceHash: "MINIME_RECOVERY_EVIDENCE_HASH",
  policyRevision: "MINIME_RECOVERY_POLICY_REVISION",
  leaseToken: "MINIME_RECOVERY_LEASE_TOKEN",
  preimageDirectory: "MINIME_RECOVERY_PREIMAGE_DIRECTORY",
  preimageMaxBytes: "MINIME_RECOVERY_PREIMAGE_MAX_BYTES",
} as const);

const MAX_TOKEN_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_PROTOCOL_TEXT = 4_096;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SECRET_KEY = /(?:auth|credential|password|secret|token)/i;

export interface RecoveryFenceContract {
  invocationId: number;
  incidentId: number;
  generation: number;
  evidenceHash: string;
  policyRevision: number;
  leaseToken: string;
}

export interface RecoveryRuntimeContract {
  endpoint: URL;
  fixerCredentialFile: string;
  mode: "diagnose" | "enabled";
  fence: RecoveryFenceContract;
  preimageDirectory: string;
  preimageMaxBytes: number;
}

export interface RecoveryRuntimeVersions {
  model: string;
  node: string;
  package: string;
  pi: string;
}

export interface RecoverySessionBinding {
  bindingId: number;
  sessionId: string;
  sessionDirectory: string;
  transcriptPath: string;
  generation: number;
}

export interface RecoveryUnknownAction {
  actionKey: string;
  toolName: string;
  intent: Record<string, unknown>;
  state: "unknown";
}

export interface RecoveryFixerState {
  mode: RecoveryMode;
  evidence: Record<string, unknown>[];
  unknownActions: RecoveryUnknownAction[];
  currentSession?: RecoverySessionBinding;
  resumeSession?: RecoverySessionBinding;
  journalDigest: string;
}

export interface RecoveryProtocolResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
}

export type RecoveryGuardCategory =
  | "ambiguous-shell"
  | "competing-polling"
  | "external-mutation"
  | "irreversible-deletion"
  | "package-or-image-download"
  | "privilege-escalation"
  | "prune-or-volume"
  | "secret-operation"
  | "supervisor-owned-operation";

interface RecoveryProtocolClientOptions {
  timeoutMs?: number;
  readToken?: (path: string) => string;
  request?: typeof httpRequest;
}

function requiredText(env: NodeJS.ProcessEnv, name: string, maxBytes = MAX_PROTOCOL_TEXT): string {
  const value = env[name];
  if (!value || value.trim() !== value || Buffer.byteLength(value, "utf8") > maxBytes || value.includes("\0")) {
    throw new Error(`Recovery fixer environment is invalid: ${name}`);
  }
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string): number {
  const value = requiredText(env, name, 32);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`Recovery fixer environment is invalid: ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Recovery fixer environment is invalid: ${name}`);
  }
  return parsed;
}

function nonNegativeInteger(env: NodeJS.ProcessEnv, name: string, maximum: number): number {
  const value = requiredText(env, name, 32);
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`Recovery fixer environment is invalid: ${name}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`Recovery fixer environment is invalid: ${name}`);
  }
  return parsed;
}

function absolutePathEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = requiredText(env, name);
  if (!isAbsolute(value) || normalize(value) !== value) {
    throw new Error(`Recovery fixer environment is invalid: ${name}`);
  }
  return value;
}

function loopbackEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("Recovery fixer endpoint is invalid");
  }
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "::1", "localhost"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== "/" && endpoint.pathname !== "")
  ) {
    throw new Error("Recovery fixer endpoint must be an uncredentialed loopback HTTP origin");
  }
  return endpoint;
}

export function readRecoveryRuntimeContract(env: NodeJS.ProcessEnv = process.env): RecoveryRuntimeContract {
  const evidenceHash = requiredText(env, RECOVERY_ENV.evidenceHash, 64);
  if (!SHA256.test(evidenceHash)) {
    throw new Error(`Recovery fixer environment is invalid: ${RECOVERY_ENV.evidenceHash}`);
  }
  const leaseToken = requiredText(env, RECOVERY_ENV.leaseToken, 256);
  if (!SAFE_IDENTIFIER.test(leaseToken)) {
    throw new Error(`Recovery fixer environment is invalid: ${RECOVERY_ENV.leaseToken}`);
  }
  const mode = parseRecoveryMode(requiredText(env, RECOVERY_ENV.mode, 16));
  if (mode === "observe") {
    throw new Error("Recovery fixer is unavailable in observe mode");
  }
  return {
    endpoint: loopbackEndpoint(requiredText(env, RECOVERY_ENV.endpoint)),
    fixerCredentialFile: requiredText(env, RECOVERY_ENV.fixerCredentialFile),
    mode,
    preimageDirectory: absolutePathEnv(env, RECOVERY_ENV.preimageDirectory),
    preimageMaxBytes: nonNegativeInteger(env, RECOVERY_ENV.preimageMaxBytes, 16 * 1024 * 1024),
    fence: {
      invocationId: positiveInteger(env, RECOVERY_ENV.invocationId),
      incidentId: positiveInteger(env, RECOVERY_ENV.incidentId),
      generation: positiveInteger(env, RECOVERY_ENV.generation),
      evidenceHash,
      policyRevision: positiveInteger(env, RECOVERY_ENV.policyRevision),
      leaseToken,
    },
  };
}

export function readPrivateRecoveryCredential(path: string): string {
  let descriptor: number | undefined;
  let details;
  let raw: Buffer;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    details = fstatSync(descriptor);
    raw = readFileSync(descriptor);
  } catch {
    throw new Error("Recovery fixer credential file is unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : details.uid;
  if (
    !details.isFile() ||
    details.uid !== uid ||
    (details.mode & 0o077) !== 0 ||
    raw.length < 16 ||
    raw.length > MAX_TOKEN_BYTES ||
    raw.includes(0)
  ) {
    throw new Error("Recovery fixer credential file is invalid");
  }
  const token = raw.toString("utf8").trim();
  if (
    !token ||
    !/^[\x21-\x7e]+$/.test(token) ||
    Buffer.byteLength(token, "utf8") !== token.length
  ) {
    throw new Error("Recovery fixer credential file is invalid");
  }
  return token;
}

function responseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export class RecoveryProtocolClient {
  private readonly timeoutMs: number;
  private readonly readToken: (path: string) => string;
  private readonly requestImpl: typeof httpRequest;

  constructor(
    readonly contract: RecoveryRuntimeContract,
    options: RecoveryProtocolClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.readToken = options.readToken ?? readPrivateRecoveryCredential;
    this.requestImpl = options.request ?? httpRequest;
  }

  private request(path: string, payload: Record<string, unknown>): Promise<RecoveryProtocolResponse> {
    const body = Buffer.from(JSON.stringify({ ...this.contract.fence, ...payload }), "utf8");
    const token = this.readToken(this.contract.fixerCredentialFile);
    const options: RequestOptions = {
      protocol: this.contract.endpoint.protocol,
      hostname: this.contract.endpoint.hostname,
      port: this.contract.endpoint.port,
      method: "POST",
      path,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Length": String(body.length),
      },
    };
    return new Promise((resolve, reject) => {
      const request = this.requestImpl(options, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer | string) => {
          const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += next.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("Recovery supervisor response is too large"));
            return;
          }
          chunks.push(next);
        });
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          let parsed: unknown = {};
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            reject(new Error("Recovery supervisor returned an invalid response"));
            return;
          }
          resolve({ ok: status >= 200 && status < 300, status, body: responseObject(parsed) });
        });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error("Recovery supervisor request timed out")));
      request.once("error", reject);
      request.end(body);
    });
  }

  async state(): Promise<RecoveryFixerState> {
    const response = await this.request("/v1/fixer/state", {});
    if (!response.ok) {
      throw new Error(`Recovery supervisor rejected state inspection (${response.status})`);
    }
    return response.body as unknown as RecoveryFixerState;
  }

  async heartbeat(): Promise<boolean> {
    return (await this.request("/v1/fixer/heartbeat", {})).ok;
  }

  async bindSession(
    binding: Omit<RecoverySessionBinding, "bindingId" | "generation"> & { runtime: RecoveryRuntimeVersions },
  ): Promise<number> {
    const response = await this.request("/v1/fixer/session/bind", binding);
    const bindingId = response.body.bindingId;
    if (!response.ok || !Number.isSafeInteger(bindingId) || Number(bindingId) < 1) {
      throw new Error(`Recovery supervisor rejected session binding (${response.status})`);
    }
    return Number(bindingId);
  }

  async markSessionResumed(bindingId: number): Promise<boolean> {
    return (await this.request("/v1/fixer/session/resumed", { bindingId })).ok;
  }

  async replaceSession(payload: {
    previousBindingId: number;
    sessionId: string;
    sessionDirectory: string;
    transcriptPath: string;
    startupClassifier: "no_session_found";
    journalDigest: string;
    runtime: RecoveryRuntimeVersions;
  }): Promise<number> {
    const response = await this.request("/v1/fixer/session/replace", payload);
    const bindingId = response.body.bindingId;
    if (!response.ok || !Number.isSafeInteger(bindingId) || Number(bindingId) < 1) {
      throw new Error(`Recovery supervisor rejected session replacement (${response.status})`);
    }
    return Number(bindingId);
  }

  async intent(actionKey: string, toolName: string, intent: Record<string, unknown>): Promise<boolean> {
    const response = await this.request("/v1/fixer/action/intent", { actionKey, toolName, intent });
    return response.ok;
  }

  async outcome(
    actionKey: string,
    outcome: "succeeded" | "failed",
    details: Record<string, unknown>,
  ): Promise<boolean> {
    return (await this.request("/v1/fixer/action/outcome", { actionKey, outcome, details })).ok;
  }

  async reconcile(
    actionKey: string,
    idempotencyKey: string,
    result: "applied" | "not_applied",
    details: Record<string, unknown>,
  ): Promise<boolean> {
    return (await this.request("/v1/fixer/action/reconcile", {
      actionKey,
      idempotencyKey,
      result,
      details,
    })).ok;
  }

  async guardRejected(
    eventKey: string,
    category: RecoveryGuardCategory,
    toolName: string,
    inputSha256: string,
  ): Promise<boolean> {
    return (await this.request("/v1/fixer/guard/rejection", {
      eventKey,
      category,
      toolName,
      inputSha256,
    })).ok;
  }

  async quarantine(idempotencyKey: string, sourcePath: string): Promise<RecoveryProtocolResponse> {
    return this.request("/v1/fixer/quarantine", { idempotencyKey, sourcePath });
  }

  async restore(idempotencyKey: string, quarantineId: string): Promise<RecoveryProtocolResponse> {
    return this.request("/v1/fixer/restore", { idempotencyKey, quarantineId });
  }

  async operation(idempotencyKey: string, operationId: string): Promise<RecoveryProtocolResponse> {
    return this.request("/v1/fixer/operation", { idempotencyKey, operationId });
  }

  async blocked(claimKey: string, reason: string, residualRisk?: string): Promise<boolean> {
    return (await this.request("/v1/fixer/blocked", {
      claimKey,
      reason,
      residualRisk: residualRisk ?? null,
    })).ok;
  }

  async finish(claimKey: string, claim: Record<string, unknown>): Promise<boolean> {
    return (await this.request("/v1/fixer/finish", { claimKey, claim })).ok;
  }
}

const READ_ONLY_TOOLS = new Set([
  "find",
  "grep",
  "knowledge_get",
  "knowledge_search",
  "ls",
  "read",
  "web_fetch",
  "web_search",
]);

const READ_ONLY_COMMANDS = new Set([
  "[", "basename", "cat", "cut", "date", "df", "dirname", "du", "egrep", "false", "fgrep",
  "file", "grep", "head", "id", "jq", "less", "ls", "more", "pgrep", "ps", "pwd", "readlink",
  "realpath", "rg", "stat", "tail", "test", "tr", "true", "type", "uname", "uniq", "wc", "which",
]);

const READ_ONLY_GIT = new Set([
  "blame", "cat-file", "describe", "diff", "for-each-ref", "grep", "log", "ls-files", "rev-parse",
  "show", "show-ref", "status",
]);

function shellWords(command: string): string[] | undefined {
  // Expansion and process/group syntax can hide additional commands or
  // mutation flags. Treat them as mutating instead of attempting a shell
  // parser in this guard.
  if (command.includes("$") || command.includes("(") || command.includes(")")) return undefined;
  const words: string[] = [];
  let current = "";
  let quote: "'" | "\"" | undefined;
  const push = () => {
    if (current) words.push(current);
    current = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === "\"" && index + 1 < command.length) current += command[++index];
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
    } else if (char === "\\" && index + 1 < command.length) {
      current += command[++index];
    } else if (char === "\n" || char === "\r") {
      push();
      if (char === "\r" && command[index + 1] === "\n") index += 1;
      words.push(";");
    } else if (/\s/.test(char)) {
      push();
    } else if (char === ";" || char === "|") {
      push();
      if (command[index + 1] === char) index += 1;
      words.push(";");
    } else if (char === "&") {
      push();
      if (command[index + 1] === "&") index += 1;
      words.push(";");
    } else if (char === ">" || char === "`") {
      return undefined;
    } else {
      current += char;
    }
  }
  if (quote) return undefined;
  push();
  return words;
}

function gitSubcommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
      index += 1;
    } else if (!arg.startsWith("-")) {
      return arg;
    }
  }
  return undefined;
}

function readOnlySegment(segment: string[]): boolean {
  while (segment[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[0])) segment.shift();
  if (segment.length === 0) return true;
  const executable = segment[0].split("/").pop() ?? segment[0];
  const args = segment.slice(1);
  if (executable === "git") return READ_ONLY_GIT.has(gitSubcommand(args) ?? "");
  if (executable === "find") return !args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg));
  if (executable === "launchctl") return args[0] === "print";
  if (executable === "docker") return ["inspect", "logs", "ps", "version"].includes(args[0] ?? "");
  if (executable === "systemctl") return ["is-active", "show", "status"].includes(args[0] ?? "");
  return READ_ONLY_COMMANDS.has(executable);
}

const NETWORK_MUTATORS = new Set(["curl", "gh", "rsync", "scp", "sftp", "ssh", "wget"]);
const PACKAGE_MUTATORS = new Set([
  "apt", "apt-get", "brew", "bun", "dnf", "npm", "npx", "pip", "pip3", "pnpm", "yarn", "yum",
]);
const DELETERS = new Set(["rm", "rmdir", "shred", "unlink"]);
const SECRET_EXECUTABLES = new Set(["gpg", "openssl", "pass", "security", "ssh-keygen"]);
const OPAQUE_COMMAND_WRAPPERS = new Set([
  "builtin", "command", "exec", "nice", "nohup", "time", "xargs",
]);
const NESTED_SHELLS = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"]);
const EVALUATOR_FLAGS = new Map<string, Set<string>>([
  ["node", new Set(["-e", "--eval"])],
  ["perl", new Set(["-e"])],
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["ruby", new Set(["-e"])],
]);
const NETWORK_GIT = new Set([
  "archive", "clone", "fetch", "ls-remote", "pull", "push", "send-email", "submodule",
]);
const LOCAL_GIT = new Set([...READ_ONLY_GIT, "add", "commit"]);
const SECRET_ARGUMENT = /(?:^|[./_-])(?:auth|credential|id_rsa|password|private[-_]?key|secret|token)(?:$|[./_=-])|(?:^|\/)\.env(?:$|[./_-])/i;
const SUPERVISOR_RECOVERY_TOOLS = new Set([
  "recovery_blocked",
  "recovery_finish",
  "recovery_heartbeat",
  "recovery_inspect",
  "recovery_operation",
  "recovery_quarantine",
  "recovery_reconcile",
  "recovery_restore",
]);

function commandSegments(command: string): string[][] | undefined {
  const words = shellWords(command);
  if (!words) return undefined;
  const segments: string[][] = [[]];
  for (const word of words) {
    if (word === ";") segments.push([]);
    else segments.at(-1)?.push(word);
  }
  return segments;
}

/** Return the fixed safety category for a command that must never execute. */
export function forbiddenRecoveryBashReason(command: unknown): RecoveryGuardCategory | undefined {
  if (typeof command !== "string" || !command.trim()) return "ambiguous-shell";
  if (/getupdates/i.test(command)) return "competing-polling";
  const segments = commandSegments(command);
  if (!segments) return "ambiguous-shell";
  for (const rawSegment of segments) {
    const segment = [...rawSegment];
    while (segment[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(segment[0])) segment.shift();
    if (segment.length === 0) continue;
    const words = segment.map((word) => word.toLowerCase());
    const executable = (words[0].split("/").pop() ?? words[0]);
    const args = words.slice(1);
    if (words.includes("sudo") || executable === "sudo") return "privilege-escalation";
    if (NESTED_SHELLS.has(executable) || OPAQUE_COMMAND_WRAPPERS.has(executable)) {
      return "ambiguous-shell";
    }
    const evaluatorFlags = EVALUATOR_FLAGS.get(executable);
    if (evaluatorFlags && args.some((arg) => evaluatorFlags.has(arg))) return "ambiguous-shell";
    if (DELETERS.has(executable) || ["dd", "mkfs", "truncate", "wipefs"].includes(executable) || (executable === "find" && args.some((arg) =>
      ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg)))) {
      return "irreversible-deletion";
    }
    if (NETWORK_MUTATORS.has(executable)) return "external-mutation";
    if (PACKAGE_MUTATORS.has(executable) || (executable === "python" || executable === "python3") && args[0] === "-m" && args[1] === "pip") {
      return "package-or-image-download";
    }
    if (executable === "git") {
      if (args.includes("-c")) return "ambiguous-shell";
      const subcommand = gitSubcommand(segment.slice(1))?.toLowerCase();
      if (NETWORK_GIT.has(subcommand ?? "")) return "external-mutation";
      if (["clean"].includes(subcommand ?? "") || (subcommand === "reset" && args.includes("--hard"))) {
        return "irreversible-deletion";
      }
      if (!LOCAL_GIT.has(subcommand ?? "")) return "ambiguous-shell";
    }
    if (executable === "docker" || executable === "podman") {
      if (args.includes("prune") || args[0] === "volume") return "prune-or-volume";
      if (args[0] === "rmi" || (args[0] === "image" && args[1] === "rm")) {
        return "irreversible-deletion";
      }
      if (["build", "compose", "create", "exec", "kill", "pull", "push", "restart", "rm", "run", "start", "stop"].includes(args[0] ?? "")) {
        return args[0] === "build" || args[0] === "pull"
          ? "package-or-image-download"
          : "supervisor-owned-operation";
      }
    }
    if (["launchctl", "systemctl"].includes(executable) && !readOnlySegment([...segment])) {
      return "supervisor-owned-operation";
    }
    if (["env", "export", "printenv", "set"].includes(executable) || SECRET_EXECUTABLES.has(executable) || words.some((word) => SECRET_ARGUMENT.test(word))) {
      return "secret-operation";
    }
    if (["kill", "killall", "pkill"].includes(executable)) return "supervisor-owned-operation";
  }
  return undefined;
}

/** Guard non-bash tools that could rotate or expose known secret stores. */
export function forbiddenRecoveryToolReason(
  event: Pick<ToolCallEvent, "toolName" | "input">,
): RecoveryGuardCategory | undefined {
  const input = event.input as Record<string, unknown>;
  if (["web_fetch", "web_search"].includes(event.toolName)) return undefined;
  if (event.toolName === "bash") return forbiddenRecoveryBashReason(input.command);
  if (["edit", "write", "read"].includes(event.toolName)) {
    const path = typeof input.path === "string" ? input.path : "";
    if (path && SECRET_ARGUMENT.test(path)) return "secret-operation";
  }
  if (/^(?:browser|email|github|http|slack|telegram|web)_/i.test(event.toolName)) {
    return "external-mutation";
  }
  return undefined;
}

export function isReadOnlyRecoveryBash(command: unknown): boolean {
  if (typeof command !== "string" || !command.trim()) return false;
  const words = shellWords(command);
  if (!words) return false;
  const segments: string[][] = [[]];
  for (const word of words) {
    if (word === ";") segments.push([]);
    else segments.at(-1)?.push(word);
  }
  return segments.every(readOnlySegment);
}

export function recoveryToolMutates(event: Pick<ToolCallEvent, "toolName" | "input">): boolean {
  if (SUPERVISOR_RECOVERY_TOOLS.has(event.toolName)) return false;
  if (READ_ONLY_TOOLS.has(event.toolName)) return false;
  if (event.toolName === "bash") {
    return !isReadOnlyRecoveryBash((event.input as Record<string, unknown>).command);
  }
  return true;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null").digest("hex");
}

function boundedText(value: unknown, limit = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

export function summarizeRecoveryIntent(event: Pick<ToolCallEvent, "toolName" | "input">): Record<string, unknown> {
  const input = event.input as Record<string, unknown>;
  const nonSecretKeys = Object.keys(input).filter((key) => !SECRET_KEY.test(key)).sort().slice(0, 64);
  const summary: Record<string, unknown> = {
    inputSha256: digest(input),
    inputKeyCount: Object.keys(input).length,
    inputSchemaSha256: digest(nonSecretKeys),
  };
  const path = boundedText(input.path, 2_048);
  if (path) {
    summary.pathBytes = Buffer.byteLength(path, "utf8");
    summary.pathSha256 = digest(path);
  }
  if (event.toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    summary.commandBytes = Buffer.byteLength(command, "utf8");
    summary.commandSha256 = digest(command);
  }
  for (const key of ["op", "type", "slug"] as const) {
    const value = boundedText(input[key], 160);
    if (value) {
      summary[`${key}Bytes`] = Buffer.byteLength(value, "utf8");
      summary[`${key}Sha256`] = digest(value);
    }
  }
  return summary;
}

function privatePreimageDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const descriptor = openSync(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const details = fstatSync(descriptor);
    const uid = typeof process.getuid === "function" ? process.getuid() : details.uid;
    if (!details.isDirectory() || details.uid !== uid) {
      throw new Error("Recovery preimage directory is unsafe");
    }
    fchmodSync(descriptor, 0o700);
    if ((fstatSync(descriptor).mode & 0o077) !== 0) {
      throw new Error("Recovery preimage directory is unsafe");
    }
  } finally {
    closeSync(descriptor);
  }
}

function existingPreimageMatches(path: string, expectedSha256: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const details = fstatSync(descriptor);
    const uid = typeof process.getuid === "function" ? process.getuid() : details.uid;
    if (!details.isFile() || details.uid !== uid || (details.mode & 0o077) !== 0) return false;
    return createHash("sha256").update(readFileSync(descriptor)).digest("hex") === expectedSha256;
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writePrivatePreimage(path: string, content: Buffer, expectedSha256: string): void {
  privatePreimageDirectory(dirname(path));
  if (existsSync(path)) {
    if (!existingPreimageMatches(path, expectedSha256)) {
      throw new Error("Recovery preimage conflicts with an existing capture");
    }
    return;
  }
  const temporary = `${path}.pending-${process.pid}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < content.length) {
      offset += writeSync(descriptor, content, offset, content.length - offset);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !existingPreimageMatches(path, expectedSha256)) {
        throw error;
      }
    }
    const directory = openSync(dirname(path), fsConstants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary was renamed or cleanup is best effort after a failed write.
    }
  }
}

function captureRecoveryPreimage(
  event: Pick<ToolCallEvent, "toolCallId" | "toolName" | "input">,
  contract: RecoveryRuntimeContract,
): Record<string, unknown> | undefined {
  if (!new Set(["edit", "write"]).has(event.toolName)) return undefined;
  const input = event.input as Record<string, unknown>;
  if (typeof input.path !== "string" || !input.path || input.path.includes("\0")) {
    throw new Error("Recovery mutation path is invalid");
  }
  const target = resolve(input.path);
  let details;
  try {
    details = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent", pathSha256: digest(target) };
    }
    throw error;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : details.uid;
  if (!details.isFile() || details.isSymbolicLink() || details.uid !== uid || details.size > contract.preimageMaxBytes) {
    throw new Error("Recovery mutation preimage is unavailable or exceeds policy");
  }
  const descriptor = openSync(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let content: Buffer;
  try {
    const opened = fstatSync(descriptor);
    if (opened.dev !== details.dev || opened.ino !== details.ino || opened.size > contract.preimageMaxBytes) {
      throw new Error("Recovery mutation preimage changed during capture");
    }
    content = readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  const contentSha256 = createHash("sha256").update(content).digest("hex");
  const name = `${digest(`${contract.fence.invocationId}:${event.toolCallId}:${target}`)}.preimage`;
  const reference = join(contract.preimageDirectory, name);
  writePrivatePreimage(reference, content, contentSha256);
  return {
    state: "captured",
    reference,
    contentSha256,
    sizeBytes: content.length,
    pathSha256: digest(target),
  };
}

export function summarizeRecoveryOutcome(event: Pick<ToolResultEvent, "isError" | "content">): Record<string, unknown> {
  return {
    isError: event.isError,
    resultSha256: digest(event.content),
    contentItems: Array.isArray(event.content) ? event.content.length : 0,
  };
}

export class RecoveryToolJournal {
  private readonly active = new Map<string, string>();

  constructor(
    readonly client: RecoveryProtocolClient,
    readonly mode: RecoveryMode = client.contract.mode,
  ) {}

  async before(event: ToolCallEvent): Promise<{ block: true; reason: string } | undefined> {
    const forbidden = forbiddenRecoveryToolReason(event);
    if (forbidden) {
      const summary = summarizeRecoveryIntent(event);
      try {
        await this.client.guardRejected(
          event.toolCallId,
          forbidden,
          event.toolName,
          String(summary.inputSha256),
        );
      } catch {
        // Guard availability never weakens the local block.
      }
      return {
        block: true,
        reason: `Recovery safety policy blocked ${forbidden}`,
      };
    }
    if (!recoveryToolMutates(event)) return undefined;
    try {
      assertRecoveryToolCallAllowed(this.mode, true);
    } catch {
      return { block: true, reason: "Recovery diagnose mode permits inspection but blocks mutation" };
    }
    const actionKey = event.toolCallId;
    let accepted = false;
    try {
      const summary = summarizeRecoveryIntent(event);
      const preimage = captureRecoveryPreimage(event, this.client.contract);
      if (preimage) summary.preimage = preimage;
      accepted = await this.client.intent(actionKey, event.toolName, summary);
    } catch {
      accepted = false;
    }
    if (!accepted) {
      return {
        block: true,
        reason: "Recovery mutation was not durably journaled; reconcile unresolved actions or restore the supervisor",
      };
    }
    this.active.set(event.toolCallId, actionKey);
    return undefined;
  }

  async after(event: ToolResultEvent): Promise<void> {
    const actionKey = this.active.get(event.toolCallId);
    if (!actionKey) return;
    this.active.delete(event.toolCallId);
    const accepted = await this.client.outcome(
      actionKey,
      event.isError ? "failed" : "succeeded",
      summarizeRecoveryOutcome(event),
    );
    if (!accepted) {
      throw new Error("Recovery mutation outcome was not durably journaled");
    }
  }
}
