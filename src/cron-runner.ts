// cron-runner.ts — CLI entry point for running scheduled cron tasks
// Usage: npx tsx src/cron-runner.ts --task <name>
// Loads cron definition from crons.yaml, runs a Pi print-mode one-shot, delivers output to Telegram

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  loadRawMergedConfig,
  loadTelegramToken,
  resolveConfigWorkspaceRoot,
  validateAgent,
} from "./config.js";
import {
  execFileSync,
  execSync,
  spawnSync,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { CronJob, AgentConfig } from "./types.js";
import { shouldSuppressNoReply } from "./no-reply.js";
import {
  buildPiSpawnEnv,
  PI_CRON_WRAPPER_RELPATHS,
  normalizePiModel,
  resolvePiExtensionArgs,
  resolveValidatedPiAgentWorkspaceCwd,
  shouldIncludePiChildEnvKey,
} from "./pi-rpc-protocol.js";
import { assemblePiContext } from "./pi-context-assembler.js";
import {
  formatPiRuntimeDiagnostic,
  resolvePackageOwnedPiInvocation,
} from "./pi-runtime.js";
import {
  normalizePiProcessOutput as normalizeSpawnOutput,
  sanitizePiProcessOutput as sanitizeCapturedOutput,
} from "./pi-process-utils.js";
import { MINIME_AGENT_WORKSPACE_ROOT_ENV } from "./workspace-contract.js";
import { loadMergedCrons } from "./cron-loader.js";
import {
  clearCronOutboxRecord,
  readCronOutboxRecord,
  sanitizeCronMetricStem,
  writeCronOutboxRecord,
  type CronOutboxRecord,
} from "./cron-outbox.js";
export { loadMergedCrons, resolveCronsPath } from "./cron-loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = resolve(__dirname, "..");
const DELIVER_SCRIPT = resolve(BOT_DIR, "scripts", "deliver.sh");

const DEFAULT_TIMEOUT_MS = 900000; // 15 minutes
const DEFAULT_CRON_HEALTH_TEXTFILE_DIR = "/opt/homebrew/var/node_exporter/textfile";
const CRON_HEALTH_LOCK_RETRY_MS = 10;
const CRON_HEALTH_STALE_LOCK_MS = 30_000;
const CRON_HEALTH_LOCK_TIMEOUT_MS = CRON_HEALTH_STALE_LOCK_MS + 5_000;
const PI_ERROR_EXCERPT_CHARS = 1000;
const FAILURE_FALLBACK_ERROR_CHARS = 400;
export const CRON_DELIVERY_RETRY_DELAYS_MS = [5_000, 30_000] as const;
export const CRON_OUTBOX_MAX_ATTEMPTS = 10;
export const CRON_OUTBOX_EXPIRY_MS = 48 * 60 * 60 * 1000;
export const MINIME_CRON_UNRESOLVED_MARKER = "[[MINIME_CRON_UNRESOLVED_V1]]";
export type CronTerminalOutcome = "success" | "failure";
type PiThinkingLevel = NonNullable<AgentConfig["thinking"]>;
const PI_THINKING_LEVELS = new Set<PiThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh"]);
export interface CronAgentData {
  id: string;
  workspaceCwd: string;
  model: string;
  systemPrompt?: string;
  thinking?: AgentConfig["thinking"];
}

export type PiRunResult =
  | { status: "ok"; output: string }
  | { status: "error"; message: string; diagnostics?: string };
type PiErrorRunResult = Extract<PiRunResult, { status: "error" }>;

class CronRunError extends Error {
  diagnostics?: string;

  constructor(message: string, diagnostics?: string) {
    super(message);
    this.name = "CronRunError";
    this.diagnostics = diagnostics;
  }
}

function errorFromUnknown(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function cronErrorDiagnostics(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("diagnostics" in err)) {
    return undefined;
  }
  const diagnostics = (err as { diagnostics?: unknown }).diagnostics;
  return typeof diagnostics === "string" && diagnostics.trim() ? diagnostics : undefined;
}

export function resolveCronLogDir(): string {
  const configuredDir = process.env.LOG_DIR;
  return configuredDir?.trim() ? configuredDir : join(homedir(), ".minime", "logs");
}

function log(taskName: string, msg: string): void {
  const logDir = resolveCronLogDir();
  mkdirSync(logDir, { recursive: true });
  const logFile = resolve(logDir, `cron-${taskName}.log`);
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  appendFileSync(logFile, line);
  process.stderr.write(line);
}

function escapePrometheusLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/"/g, "\\\"");
}

function writeAtomicTextFile(dir: string, fileName: string, content: string): void {
  const filePath = join(dir, fileName);
  const tmpPath = join(
    dir,
    `.${fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // The temporary file may not exist or may already have been renamed.
    }
    throw err;
  }
}

function inspectProcessStartToken(pid: number): string | undefined {
  let identity: string | undefined;
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closingParen = raw.lastIndexOf(")");
      const fields = raw.slice(closingParen + 2).trim().split(/\s+/);
      if (closingParen >= 0 && fields[19]) {
        identity = `linux:${fields[19]}`;
      }
    } catch {
      // The liveness probe below remains the fail-closed fallback.
    }
  } else {
    const inspected = spawnSync(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", timeout: 1_000, maxBuffer: 64 * 1024 },
    );
    if (!inspected.error && inspected.status === 0 && inspected.stdout.trim()) {
      identity = `${process.platform}:${inspected.stdout.trim()}`;
    }
  }

  return identity === undefined
    ? undefined
    : createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function removeEmptyCronHealthLockDirectory(lockPath: string): boolean {
  try {
    rmdirSync(lockPath);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") {
      return code === "ENOENT";
    }
    throw err;
  }
}

function removeCronHealthLockEntry(entryPath: string): boolean {
  try {
    unlinkSync(entryPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

function recoverCronHealthLock(lockPath: string): boolean {
  let lockStat: ReturnType<typeof statSync>;
  try {
    lockStat = statSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw err;
  }

  if (!lockStat.isDirectory()) {
    if (Date.now() - lockStat.mtimeMs <= CRON_HEALTH_STALE_LOCK_MS) {
      return false;
    }
    try {
      unlinkSync(lockPath);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "EPERM") {
        return true;
      }
      throw err;
    }
  }

  let entries: string[];
  try {
    entries = readdirSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw err;
  }

  if (entries.length === 0) {
    if (Date.now() - lockStat.mtimeMs <= CRON_HEALTH_STALE_LOCK_MS) {
      return false;
    }
    return removeEmptyCronHealthLockDirectory(lockPath);
  }

  const ownerEntries = entries.filter((entry) =>
    /^owner-(\d+)-(unknown|[0-9a-f]{16})-[0-9a-f-]+$/.test(entry)
  );
  const ownerEntry = ownerEntries.length === 1 ? ownerEntries[0] : undefined;
  const ownerMatch = ownerEntry?.match(
    /^owner-(\d+)-(unknown|[0-9a-f]{16})-[0-9a-f-]+$/,
  );
  if (
    entries.length === 2
    && entries.includes("claim")
    && ownerEntry !== undefined
    && ownerMatch
  ) {
    const ownerPid = Number(ownerMatch[1]);
    const recordedStartToken = ownerMatch[2];
    if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
      const currentStartToken = inspectProcessStartToken(ownerPid);
      if (
        currentStartToken !== undefined
        && recordedStartToken !== "unknown"
        && currentStartToken === recordedStartToken
      ) {
        return false;
      }
      if (
        (currentStartToken === undefined || recordedStartToken === "unknown")
        && isProcessAlive(ownerPid)
      ) {
        return false;
      }
    }
    if (!removeCronHealthLockEntry(join(lockPath, ownerEntry))) {
      return true;
    }
    if (!removeCronHealthLockEntry(join(lockPath, "claim"))) {
      return true;
    }
    return removeEmptyCronHealthLockDirectory(lockPath);
  }

  if (Date.now() - lockStat.mtimeMs <= CRON_HEALTH_STALE_LOCK_MS) {
    return false;
  }

  if (entries.length === 1 && entries[0] === "claim") {
    if (!removeCronHealthLockEntry(join(lockPath, "claim"))) {
      return true;
    }
    return removeEmptyCronHealthLockDirectory(lockPath);
  }

  throw new Error(`cron health lock "${lockPath}" has invalid ownership state`);
}

function acquireCronHealthLock(dir: string, fileStem: string): () => void {
  const lockPath = join(dir, `.minime_cron_${fileStem}.lock`);
  const deadline = Date.now() + CRON_HEALTH_LOCK_TIMEOUT_MS;
  const waitState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const ownerToken = [
        process.pid,
        inspectProcessStartToken(process.pid) ?? "unknown",
        randomUUID(),
      ].join("-");
      const claimPath = join(lockPath, "claim");
      writeFileSync(claimPath, `${ownerToken}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      const ownerEntry = `owner-${ownerToken}`;
      const ownerPath = join(lockPath, ownerEntry);
      try {
        writeFileSync(ownerPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      } catch (err) {
        removeCronHealthLockEntry(claimPath);
        removeEmptyCronHealthLockDirectory(lockPath);
        throw err;
      }

      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        if (!removeCronHealthLockEntry(ownerPath)) {
          throw new Error(`cron health lock owner "${ownerPath}" is missing`);
        }
        if (!removeCronHealthLockEntry(claimPath)) {
          throw new Error(`cron health lock claim "${claimPath}" is missing`);
        }
        if (!removeEmptyCronHealthLockDirectory(lockPath)) {
          throw new Error(`cron health lock directory "${lockPath}" is not empty`);
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }

    if (recoverCronHealthLock(lockPath)) {
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for cron health lock "${lockPath}"`);
    }
    Atomics.wait(waitState, 0, 0, CRON_HEALTH_LOCK_RETRY_MS);
  }
}

interface CronRunCounts {
  success: number;
  failure: number;
}

function parseCronRunCounts(contents: string, label: string): CronRunCounts {
  const values = new Map<string, number>();
  for (const line of contents.split(/\r?\n/)) {
    for (const outcome of ["success", "failure"] as const) {
      const prefix = `minime_cron_runs_total{cron="${label}",outcome="${outcome}"} `;
      if (!line.startsWith(prefix)) {
        continue;
      }
      const rawValue = line.slice(prefix.length);
      if (!/^\d+$/.test(rawValue)) {
        return { success: 0, failure: 0 };
      }
      const value = Number(rawValue);
      if (!Number.isSafeInteger(value) || value < 0) {
        return { success: 0, failure: 0 };
      }
      values.set(outcome, value);
    }
  }
  if (!values.has("success") || !values.has("failure")) {
    return { success: 0, failure: 0 };
  }
  return {
    success: values.get("success") ?? 0,
    failure: values.get("failure") ?? 0,
  };
}

function readCronRunCounts(filePath: string, label: string): CronRunCounts {
  try {
    return parseCronRunCounts(readFileSync(filePath, "utf8"), label);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { success: 0, failure: 0 };
    }
    throw err;
  }
}

function writeCronHealthMetric(
  cronName: string,
  exitCode: number,
  outcome: CronTerminalOutcome,
): void {
  const fileStem = sanitizeCronMetricStem(cronName);
  const label = escapePrometheusLabelValue(cronName);
  const dir = process.env.CRON_HEALTH_TEXTFILE_DIR ?? DEFAULT_CRON_HEALTH_TEXTFILE_DIR;
  const suppliedExitCode = Number.isFinite(exitCode) ? Math.trunc(exitCode) : 1;
  const normalizedExitCode = outcome === "success"
    ? 0
    : suppliedExitCode === 0
      ? 1
      : suppliedExitCode;
  const exitFileName = `minime_cron_${fileStem}.exit.prom`;
  const exitFilePath = join(dir, exitFileName);

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(
      `failed to prepare cron health metric dir for "${cronName}": ${errorFromUnknown(err).message}`,
    );
  }

  let releaseLock: () => void;
  try {
    releaseLock = acquireCronHealthLock(dir, fileStem);
  } catch (err) {
    throw new Error(
      `failed to lock cron health metric for "${cronName}": ${errorFromUnknown(err).message}`,
    );
  }

  try {
    let previousCounts: CronRunCounts;
    try {
      previousCounts = readCronRunCounts(exitFilePath, label);
    } catch (err) {
      throw new Error(
        `failed to read prior cron health metric for "${cronName}": ${errorFromUnknown(err).message}`,
      );
    }

    const counts: CronRunCounts = {
      success: previousCounts.success + (outcome === "success" ? 1 : 0),
      failure: previousCounts.failure + (outcome === "failure" ? 1 : 0),
    };
    const timestamp = Math.floor(Date.now() / 1000);
    const terminalSnapshot = [
      `minime_cron_last_exit_code{cron="${label}"} ${normalizedExitCode}`,
      `minime_cron_runs_total{cron="${label}",outcome="success"} ${counts.success}`,
      `minime_cron_runs_total{cron="${label}",outcome="failure"} ${counts.failure}`,
      `minime_cron_last_run_timestamp_seconds{cron="${label}"} ${timestamp}`,
      "",
    ].join("\n");

    if (outcome === "success") {
      try {
        writeAtomicTextFile(
          dir,
          `minime_cron_${fileStem}.success.prom`,
          `minime_cron_last_success_timestamp{cron="${label}"} ${timestamp}\n`,
        );
      } catch (err) {
        throw new Error(
          `failed to write cron health success metric for "${cronName}": ${errorFromUnknown(err).message}`,
        );
      }
    }

    try {
      writeAtomicTextFile(dir, exitFileName, terminalSnapshot);
    } catch (err) {
      throw new Error(
        `failed to write cron health terminal metric for "${cronName}": ${errorFromUnknown(err).message}`,
      );
    }
  } finally {
    try {
      releaseLock();
    } catch (err) {
      throw new Error(
        `failed to release cron health metric lock for "${cronName}": ${errorFromUnknown(err).message}`,
      );
    }
  }
}

export interface DeliveryDefaults {
  defaultDeliveryChatId?: number;
  defaultDeliveryThreadId?: number;
}

function loadCronTask(taskName: string, cronsPath?: string, defaults?: DeliveryDefaults): CronJob {
  const crons = loadMergedCrons(cronsPath);
  const found = crons.find(
    (c) => c.name === taskName,
  );
  if (!found) {
    throw new Error(
      `Task "${taskName}" not found in crons.yaml / crons.local.yaml. Available: ${crons.map((c) => c.name).join(", ")}`,
    );
  }

  const c = found as Record<string, unknown>;

  // Resolve deliveryChatId: cron-level > config default. Error on present-but-invalid.
  let deliveryChatId: number | undefined;
  if (c.deliveryChatId !== undefined) {
    if (typeof c.deliveryChatId !== "number" || !Number.isInteger(c.deliveryChatId) || c.deliveryChatId === 0) {
      throw new Error(`Task "${taskName}" has invalid 'deliveryChatId' (${c.deliveryChatId}): must be a non-zero integer`);
    }
    deliveryChatId = c.deliveryChatId;
  } else {
    deliveryChatId = defaults?.defaultDeliveryChatId;
  }
  if (typeof deliveryChatId !== "number") {
    throw new Error(`Task "${taskName}" missing 'deliveryChatId' (not in cron config or config defaults)`);
  }

  // Resolve deliveryThreadId: cron-level > config default.
  // Only inherit default thread when targeting the default chat (thread IDs are chat-specific).
  const usedDefaultChat = c.deliveryChatId === undefined || c.deliveryChatId === defaults?.defaultDeliveryChatId;
  let deliveryThreadId: number | undefined;
  if (c.deliveryThreadId !== undefined) {
    if (typeof c.deliveryThreadId !== "number" || !Number.isInteger(c.deliveryThreadId) || c.deliveryThreadId === 0) {
      throw new Error(`Task "${taskName}" has invalid 'deliveryThreadId' (${c.deliveryThreadId}): must be a non-zero integer`);
    }
    deliveryThreadId = c.deliveryThreadId;
  } else if (usedDefaultChat) {
    deliveryThreadId = defaults?.defaultDeliveryThreadId;
  }

  if (c.type !== undefined && c.type !== "llm" && c.type !== "script") {
    throw new Error(`Task "${taskName}" has invalid type "${c.type}" (must be "llm" or "script")`);
  }
  const cronType = c.type === "script" ? "script" as const : "llm" as const;

  if (cronType === "script") {
    if (typeof c.command !== "string" || !c.command.trim()) {
      throw new Error(`Task "${taskName}" is type 'script' but missing required 'command' field`);
    }
  } else {
    if (typeof c.prompt !== "string" || !c.prompt.trim()) {
      throw new Error(`Task "${taskName}" missing required 'prompt' field`);
    }
  }

  if (typeof c.timeout === "number" && (!Number.isFinite(c.timeout) || c.timeout <= 0)) {
    throw new Error(`Task "${taskName}" has invalid 'timeout' (${c.timeout}): must be a positive number`);
  }

  let engine: CronJob["engine"];
  if (cronType === "llm" && c.engine !== undefined) {
    if (c.engine === "claude") {
      throw new Error(`Task "${taskName}" uses engine: claude, but Claude cron runtime was removed; remove engine or set engine: pi`);
    }
    if (c.engine !== "pi") {
      throw new Error(`Task "${taskName}" has invalid 'engine' "${c.engine}" (must be "pi" or omitted)`);
    }
    engine = c.engine;
  }

  return {
    name: String(c.name),
    schedule: String(c.schedule ?? ""),
    type: cronType,
    prompt: cronType === "llm" ? String(c.prompt) : undefined,
    command: cronType === "script" ? String(c.command) : undefined,
    agentId: String(c.agentId ?? "main"),
    deliveryChatId,
    deliveryThreadId,
    timeout: typeof c.timeout === "number" ? c.timeout : undefined,
    enabled: c.enabled === false ? false : undefined,
    engine,
  };
}

function isCronPiThinking(value: unknown): value is PiThinkingLevel {
  return typeof value === "string" && PI_THINKING_LEVELS.has(value as PiThinkingLevel);
}

function resolveCronAgentData(agentId: string, configPath?: string): CronAgentData {
  const workspaceRoot = resolveConfigWorkspaceRoot(configPath);
  const raw = loadRawMergedConfig(configPath) as {
    agents?: Record<string, unknown>;
    defaultModel?: unknown;
    defaultFallbackModel?: unknown;
  };
  if (raw.defaultModel !== undefined && typeof raw.defaultModel !== "string") {
    throw new Error(`Invalid defaultModel: must be a string`);
  }
  if (raw.defaultFallbackModel !== undefined) {
    throw new Error(`defaultFallbackModel was removed with the Claude runtime; remove defaultFallbackModel`);
  }
  if (
    typeof raw?.agents !== "object" ||
    raw.agents === null ||
    !Object.prototype.hasOwnProperty.call(raw.agents, agentId)
  ) {
    throw new Error(`Agent "${agentId}" not found in config.yaml / config.local.yaml`);
  }
  const rawAgent = raw.agents[agentId];
  if (typeof rawAgent !== "object" || rawAgent === null) {
    throw new Error(`Agent "${agentId}" missing workspaceCwd`);
  }

  const defaultModel = typeof raw.defaultModel === "string" ? raw.defaultModel : undefined;
  const knownAgentIds = new Set(Object.keys(raw.agents));
  const agent = validateAgent(rawAgent, agentId, defaultModel, workspaceRoot, knownAgentIds);
  if (!agent.workspaceCwd.trim()) {
    throw new Error(`Agent "${agentId}" missing workspaceCwd`);
  }

  const result: CronAgentData = {
    id: agentId,
    workspaceCwd: agent.workspaceCwd,
    model: normalizePiModel(agent.model),
  };
  if (agent.systemPrompt !== undefined) {
    result.systemPrompt = agent.systemPrompt;
  }
  if (agent.thinking !== undefined) {
    result.thinking = agent.thinking;
  }
  return result;
}

function buildPiCronAgentConfig(agentId: string, configPath?: string): AgentConfig {
  return buildPiCronAgentConfigFromData(resolveCronAgentData(agentId, configPath));
}

function buildPiCronAgentConfigFromData(agent: CronAgentData): AgentConfig {
  const result: AgentConfig = {
    id: agent.id,
    workspaceCwd: agent.workspaceCwd,
    provider: "pi",
    model: agent.model,
  };
  if (agent.systemPrompt !== undefined) {
    result.systemPrompt = agent.systemPrompt;
  }
  if (agent.thinking !== undefined) {
    result.thinking = agent.thinking;
  }
  return result;
}

function getAgentWorkspace(agentId: string, configPath?: string): string {
  return resolveCronAgentData(agentId, configPath).workspaceCwd;
}

export function loadAdminChatId(configPath?: string): number | undefined {
  const raw = loadRawMergedConfig(configPath) as {
    adminChatId?: unknown;
  };
  if (raw?.adminChatId === undefined) {
    return undefined;
  }
  if (typeof raw.adminChatId === "number" && Number.isInteger(raw.adminChatId) && raw.adminChatId !== 0) {
    return raw.adminChatId;
  }
  process.stderr.write(`[cron-runner] WARN: invalid adminChatId in config (${raw.adminChatId}), ignoring\n`);
  return undefined;
}

export function loadDefaultDelivery(configPath?: string): DeliveryDefaults {
  const raw = loadRawMergedConfig(configPath) as {
    defaultDeliveryChatId?: unknown;
    defaultDeliveryThreadId?: unknown;
  };
  const result: DeliveryDefaults = {};
  if (raw?.defaultDeliveryChatId !== undefined) {
    if (typeof raw.defaultDeliveryChatId === "number" && Number.isInteger(raw.defaultDeliveryChatId) && raw.defaultDeliveryChatId !== 0) {
      result.defaultDeliveryChatId = raw.defaultDeliveryChatId;
    } else {
      process.stderr.write(`[cron-runner] WARN: invalid defaultDeliveryChatId in config (${raw.defaultDeliveryChatId}), ignoring\n`);
    }
  }
  if (raw?.defaultDeliveryThreadId !== undefined) {
    if (typeof raw.defaultDeliveryThreadId === "number" && Number.isInteger(raw.defaultDeliveryThreadId) && raw.defaultDeliveryThreadId !== 0) {
      result.defaultDeliveryThreadId = raw.defaultDeliveryThreadId;
    } else {
      process.stderr.write(`[cron-runner] WARN: invalid defaultDeliveryThreadId in config (${raw.defaultDeliveryThreadId}), ignoring\n`);
    }
  }
  return result;
}

export function handleDeliveryFailure(
  cronName: string,
  targetChatId: number,
  errorMsg: string,
  adminChatId: number | undefined,
  deliverFn: (chatId: number, msg: string) => void = deliver,
): void {
  log(cronName, `FAIL delivery: ${errorMsg}`);
  if (adminChatId !== undefined) {
    try {
      deliverFn(
        adminChatId,
        `⚠️ Cron delivery FAIL\nTask: ${cronName}\nTarget: ${targetChatId}\nError: ${errorMsg}`,
      );
    } catch (err) {
      log(cronName, `FAIL: admin notification failed: ${(err as Error).message}`);
    }
  }
}

function buildDeliverArgs(
  chatId: number,
  threadId?: number,
): string[] {
  return threadId ? [String(chatId), "--thread", String(threadId)] : [String(chatId)];
}

export interface CronDeliveryDeps {
  loadTelegramToken: () => string;
  execFileSync: (
    file: string,
    args: string[],
    options: ExecFileSyncOptionsWithStringEncoding,
  ) => string;
}

const defaultCronDeliveryDeps: CronDeliveryDeps = {
  loadTelegramToken,
  execFileSync,
};

let cachedDeliveryTelegramToken:
  | { source: () => string; token: string }
  | undefined;

function loadDeliveryTelegramToken(source: () => string): string {
  if (cachedDeliveryTelegramToken?.source === source) {
    return cachedDeliveryTelegramToken.token;
  }
  const token = source();
  cachedDeliveryTelegramToken = { source, token };
  return token;
}

export class DeliveryError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly stderrExcerpt: string | undefined;

  constructor(
    message: string,
    details: { status?: number; code?: string; stderrExcerpt?: string } = {},
  ) {
    super(message);
    this.name = "DeliveryError";
    this.status = details.status;
    this.code = details.code;
    this.stderrExcerpt = details.stderrExcerpt;
  }
}

export function isQueueableDeliveryFailure(err: unknown): boolean {
  return !(err instanceof DeliveryError
    && err.status === 1
    && err.stderrExcerpt !== undefined
    && /\[deliver\] Error: (invalid chat_id|invalid thread_id|empty message)/.test(
      err.stderrExcerpt,
    ));
}

function deliver(
  chatId: number,
  message: string,
  threadId?: number,
  overrides: Partial<CronDeliveryDeps> = {},
): void {
  const deps = { ...defaultCronDeliveryDeps, ...overrides };
  try {
    const telegramToken = loadDeliveryTelegramToken(deps.loadTelegramToken);
    deps.execFileSync(DELIVER_SCRIPT, buildDeliverArgs(chatId, threadId), {
      input: message,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        TELEGRAM_BOT_TOKEN: telegramToken,
      },
    });
  } catch (err) {
    const failure = err as {
      message?: unknown;
      status?: unknown;
      code?: unknown;
      stderr?: string | Buffer | null;
    };
    const sanitizedStderr = sanitizeCapturedOutput(normalizeSpawnOutput(failure.stderr));
    throw new DeliveryError(`Delivery failed: ${failure.message}`, {
      status: typeof failure.status === "number" ? failure.status : undefined,
      code: typeof failure.code === "string" ? failure.code : undefined,
      stderrExcerpt: sanitizedStderr ? sanitizedStderr.slice(0, 400) : undefined,
    });
  }
}

interface ScriptExecFailure extends Error {
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  status?: number | null;
  signal?: NodeJS.Signals | string | null;
  code?: string | number;
}

function isScriptExecFailure(err: Error): err is ScriptExecFailure {
  return "stdout" in err || "stderr" in err || "status" in err || "signal" in err || "code" in err;
}

function formatScriptFailureSummary(err: ScriptExecFailure, timeoutMs: number): string {
  const code = typeof err.code === "string" ? err.code : undefined;
  if (code === "ETIMEDOUT" || /\b(?:ETIMEDOUT|timed out|timeout)\b/i.test(err.message)) {
    return `Script cron timed out after ${timeoutMs}ms`;
  }
  if (err.signal) {
    return `Script cron exited with signal ${err.signal}`;
  }
  if (typeof err.status === "number") {
    return `Script cron exited with code ${err.status}`;
  }

  const sanitizedMessage = sanitizeCapturedOutput(err.message);
  return sanitizedMessage
    ? `Script cron failed: ${sanitizedMessage.slice(0, FAILURE_FALLBACK_ERROR_CHARS)}`
    : "Script cron failed";
}

function formatScriptFailureDiagnostics(err: ScriptExecFailure): string | undefined {
  const stdout = normalizeSpawnOutput(err.stdout);
  const stderr = normalizeSpawnOutput(err.stderr);
  const metadata = [
    typeof err.status === "number" ? `status: ${err.status}` : undefined,
    err.signal ? `signal: ${err.signal}` : undefined,
    typeof err.code === "string" && err.code ? `code: ${sanitizeCapturedOutput(err.code)}` : undefined,
  ];
  const details = [
    formatCapturedOutputExcerpt("stderr", stderr),
    formatCapturedOutputExcerpt("stdout", stdout),
    ...metadata,
  ].filter((line): line is string => line !== undefined);
  return details.length > 0 ? details.join("; ") : undefined;
}

function runScript(cron: CronJob): string {
  if (!cron.command) {
    throw new Error(`Script-mode cron "${cron.name}" has no command`);
  }
  const timeoutMs = cron.timeout ?? DEFAULT_TIMEOUT_MS;

  const env = scrubLegacyRuntimeEnv(process.env);

  try {
    const output = execSync(cron.command, {
      encoding: "utf8",
      timeout: timeoutMs,
      shell: "/bin/bash",
      env,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      stdio: ["pipe", "pipe", "pipe"],
    });

    return output.trim();
  } catch (err) {
    const error = errorFromUnknown(err);
    if (isScriptExecFailure(error)) {
      throw new CronRunError(
        formatScriptFailureSummary(error, timeoutMs),
        formatScriptFailureDiagnostics(error),
      );
    }
    throw error;
  }
}

function scrubLegacyRuntimeEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...rawEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_") || key.startsWith("ANTHROPIC_")) {
      delete env[key];
    }
  }
  delete env.CLAUDECODE;
  return env;
}

function buildCronSystemInstruction(): string {
  const today = new Date().toISOString().split("T")[0];
  return [
    `Today is ${today}. Respond concisely.`,
    `If your final report has an unresolved finding, add ${MINIME_CRON_UNRESOLVED_MARKER} as its exact standalone final non-empty line. Do not use this marker otherwise.`,
  ].join(" ");
}

export interface LlmCronTerminalResult {
  output: string;
  outcome: CronTerminalOutcome;
}

export function classifyLlmCronTerminalResult(output: string): LlmCronTerminalResult {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  let finalNonEmptyLine = lines.length - 1;
  while (finalNonEmptyLine >= 0 && lines[finalNonEmptyLine].trim() === "") {
    finalNonEmptyLine -= 1;
  }
  const exactMarkerCount = lines.filter(
    (line) => line === MINIME_CRON_UNRESOLVED_MARKER,
  ).length;

  if (
    exactMarkerCount === 1
    && finalNonEmptyLine >= 0
    && lines[finalNonEmptyLine] === MINIME_CRON_UNRESOLVED_MARKER
  ) {
    return {
      output: lines.slice(0, finalNonEmptyLine).join("\n").trim(),
      outcome: "failure",
    };
  }
  return { output, outcome: "success" };
}

function formatCapturedOutputExcerpt(label: "stdout" | "stderr", value: string): string | undefined {
  const trimmed = sanitizeCapturedOutput(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= PI_ERROR_EXCERPT_CHARS) {
    return `${label}: ${trimmed}`;
  }

  const excerpt = trimmed.slice(0, PI_ERROR_EXCERPT_CHARS);
  return `${label} (first ${PI_ERROR_EXCERPT_CHARS} chars): ${excerpt}... [truncated ${trimmed.length - PI_ERROR_EXCERPT_CHARS} chars]`;
}

function piErrorResult(summary: string, stdout: string, stderr: string): PiErrorRunResult {
  const details = [
    formatCapturedOutputExcerpt("stderr", stderr),
    formatCapturedOutputExcerpt("stdout", stdout),
  ].filter((line): line is string => line !== undefined);
  return {
    status: "error",
    message: summary,
    diagnostics: details.length > 0 ? details.join("; ") : undefined,
  };
}

function classifyPiResult(
  exitCode: number | null | undefined,
  signal: NodeJS.Signals | string | null | undefined,
  stdoutValue: string | Buffer | null | undefined,
  stderrValue: string | Buffer | null | undefined,
): PiRunResult {
  const stdout = normalizeSpawnOutput(stdoutValue);
  const stderr = normalizeSpawnOutput(stderrValue);
  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (signal) {
    return piErrorResult(`Pi cron exited with signal ${signal}`, stdout, stderr);
  }
  if (exitCode !== 0) {
    const summary = typeof exitCode === "number"
      ? `Pi cron exited with code ${exitCode}`
      : "Pi cron exited without an exit code";
    return piErrorResult(summary, stdout, stderr);
  }
  if (trimmedStdout) {
    return { status: "ok", output: trimmedStdout };
  }
  if (trimmedStderr) {
    return piErrorResult("Pi cron produced stderr without stdout", stdout, stderr);
  }
  return { status: "ok", output: "" };
}

type PiSpawnSync = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface PiRunDeps {
  spawnSync: PiSpawnSync;
  buildAgentConfig: (cron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => AgentConfig;
  buildEnv: (agentWorkspaceRoot?: string) => Record<string, string>;
  assembleContext: typeof assemblePiContext;
  resolveExtensionArgs?: () => string[];
}

function buildPiCronAgentConfigForRun(cron: CronJob, workspaceCwd: string, agentData?: CronAgentData): AgentConfig {
  const agent = agentData ?? resolveCronAgentData(cron.agentId);
  return buildPiCronAgentConfigFromData({ ...agent, workspaceCwd });
}

const defaultPiDeps: PiRunDeps = {
  spawnSync,
  buildAgentConfig: buildPiCronAgentConfigForRun,
  buildEnv: buildPiSpawnEnv,
  assembleContext: assemblePiContext,
};

function hardenPiCronEnv(rawEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (shouldIncludePiChildEnvKey(key)) {
      env[key] = value;
    }
  }
  return env;
}

function buildPiCronPromptArg(prompt: string): string {
  // Pi parses leading "-" as options and leading "@" as file references.
  return prompt.startsWith("-") || prompt.startsWith("@") ? ` ${prompt}` : prompt;
}

function runPi(
  cron: CronJob,
  workspaceCwd: string,
  deps: PiRunDeps = defaultPiDeps,
  agentData?: CronAgentData,
): string {
  if (!cron.prompt) {
    throw new Error(`Pi cron "${cron.name}" has no prompt`);
  }

  const agent = deps.buildAgentConfig(cron, workspaceCwd, agentData);
  const validatedWorkspaceCwd = resolveValidatedPiAgentWorkspaceCwd(agent);
  const thinking = isCronPiThinking(agent.thinking) ? agent.thinking : "medium";
  const systemInstruction = buildCronSystemInstruction();
  const env = hardenPiCronEnv(deps.buildEnv(validatedWorkspaceCwd));
  env[MINIME_AGENT_WORKSPACE_ROOT_ENV] = validatedWorkspaceCwd;
  // Pi authenticates via ~/.pi/agent/auth.json, not legacy OAuth credentials.
  env.HOME ||= homedir();
  const args: string[] = [
    "-p",
    buildPiCronPromptArg(cron.prompt),
    "--no-session",
    "--no-extensions",
    "--model",
    agent.model,
    "--thinking",
    thinking,
  ];

  try {
    const context = deps.assembleContext(agent);
    if (context) {
      if (context.systemPromptPath) {
        args.push("--system-prompt", context.systemPromptPath);
      }
      args.push("--append-system-prompt", context.appendSystemPromptPath);
      args.push("--no-context-files");
    }
  } catch (err) {
    log(cron.name, `Pi context assembly failed; suppressing flat context loading: ${(err as Error).message}`);
    args.push("--no-context-files");
  }

  args.push("--append-system-prompt", systemInstruction);
  args.push(...(deps.resolveExtensionArgs?.() ?? resolvePiExtensionArgs({ relpaths: PI_CRON_WRAPPER_RELPATHS })));
  const invocation = resolvePackageOwnedPiInvocation("cli", args);
  log(cron.name, `package-owned Pi runtime ${formatPiRuntimeDiagnostic(invocation.diagnostic)}`);
  const result = deps.spawnSync(invocation.command, invocation.args, {
    cwd: validatedWorkspaceCwd,
    timeout: cron.timeout ?? DEFAULT_TIMEOUT_MS,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env,
  });

  if (result.error) {
    const spawnError = piErrorResult(`Pi cron spawn failed: ${result.error.message}`, result.stdout, result.stderr);
    throw new CronRunError(spawnError.message, spawnError.diagnostics);
  }

  const classified = classifyPiResult(result.status, result.signal, result.stdout, result.stderr);
  if (classified.status === "error") {
    throw new CronRunError(classified.message, classified.diagnostics);
  }
  return classified.output;
}

function resolveCronEngine(cron: CronJob): "pi" {
  if (cron.engine !== undefined && cron.engine !== "pi") {
    throw new Error(`Cron task "${cron.name}" uses unsupported engine "${cron.engine}"; only Pi cron execution is supported`);
  }
  if (process.env.CRON_PI_DISABLED === "1") {
    throw new Error("CRON_PI_DISABLED=1 is no longer supported; LLM crons only run via Pi print mode");
  }
  return "pi";
}

interface OneShotDeps {
  runPi: (cron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => string;
}

const defaultOneShotDeps: OneShotDeps = {
  runPi: (cron, workspaceCwd, agentData) => runPi(cron, workspaceCwd, defaultPiDeps, agentData),
};

function runOneShot(
  cron: CronJob,
  workspaceCwd: string,
  deps: OneShotDeps = defaultOneShotDeps,
  agentData?: CronAgentData,
): string {
  resolveCronEngine(cron);
  return deps.runPi(cron, workspaceCwd, agentData);
}

export interface CronRunnerMainDeps {
  argv: string[];
  consoleError: (message?: unknown, ...optionalParams: unknown[]) => void;
  exit: (code: number) => never;
  log: (taskName: string, msg: string) => void;
  loadDefaultDelivery: (configPath?: string) => DeliveryDefaults;
  loadCronTask: (taskName: string, cronsPath?: string, defaults?: DeliveryDefaults) => CronJob;
  loadAdminChatId: (configPath?: string) => number | undefined;
  resolveCronAgentData: (agentId: string, configPath?: string) => CronAgentData;
  runScript: (cron: CronJob) => string;
  runPi: (cron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => string;
  deliver: (chatId: number, message: string, threadId?: number) => void;
  sleep: (ms: number) => Promise<void>;
  readCronOutboxRecord: (
    cronName: string,
  ) => CronOutboxRecord | "corrupt" | undefined;
  writeCronOutboxRecord: (record: CronOutboxRecord) => void;
  clearCronOutboxRecord: (cronName: string) => void;
  handleDeliveryFailure: (
    cronName: string,
    targetChatId: number,
    errorMsg: string,
    adminChatId: number | undefined,
  ) => void;
  writeCronHealthMetric: (
    cronName: string,
    exitCode: number,
    outcome: CronTerminalOutcome,
  ) => void;
}

const defaultMainDeps: Omit<CronRunnerMainDeps, "argv"> = {
  consoleError: console.error,
  exit: (code: number): never => process.exit(code),
  log,
  loadDefaultDelivery,
  loadCronTask,
  loadAdminChatId,
  resolveCronAgentData,
  runScript,
  runPi: (cron, workspaceCwd, agentData) => runPi(cron, workspaceCwd, defaultPiDeps, agentData),
  deliver,
  sleep,
  readCronOutboxRecord,
  writeCronOutboxRecord,
  clearCronOutboxRecord,
  handleDeliveryFailure,
  writeCronHealthMetric,
};

async function main(overrides: Partial<CronRunnerMainDeps> = {}): Promise<void> {
  const deps: CronRunnerMainDeps = {
    ...defaultMainDeps,
    argv: process.argv,
    ...overrides,
  };
  let terminalFinalized = false;
  const finalizeInvocation = (
    cronName: string,
    outcome: CronTerminalOutcome,
  ): void => {
    if (terminalFinalized) {
      throw new Error(`Cron invocation "${cronName}" was finalized more than once`);
    }
    deps.writeCronHealthMetric(cronName, outcome === "success" ? 0 : 1, outcome);
    terminalFinalized = true;
  };

  const taskIdx = deps.argv.indexOf("--task");
  if (taskIdx === -1 || !deps.argv[taskIdx + 1]) {
    try {
      deps.consoleError("Usage: cron-runner.ts --task <name>");
    } catch {
      // Usage reporting is best-effort; the terminal failure still must publish.
    }
    finalizeInvocation("unknown", "failure");
    deps.exit(1);
  }
  const taskName = deps.argv[taskIdx + 1];
  const runId = `${taskName}@${new Date().toISOString()}#${process.pid}`;

  const deliverWithRetry = async (
    chatId: number,
    payload: string,
    threadId?: number,
  ): Promise<void> => {
    try {
      deps.deliver(chatId, payload, threadId);
      return;
    } catch (initialError) {
      let lastError: unknown = initialError;
      for (const delayMs of CRON_DELIVERY_RETRY_DELAYS_MS) {
        await deps.sleep(delayMs);
        try {
          deps.deliver(chatId, payload, threadId);
          return;
        } catch (retryError) {
          lastError = retryError;
        }
      }
      throw lastError;
    }
  };

  const queueOutputIfEmpty = (
    payload: string,
    chatId: number,
    threadId?: number,
  ): void => {
    try {
      if (deps.readCronOutboxRecord(taskName) !== undefined) {
        deps.log(taskName, "OUTBOX QUEUE-SKIPPED pending-existing");
        return;
      }
    } catch {
      deps.log(taskName, "OUTBOX QUEUE-SKIPPED pending-existing");
      return;
    }

    try {
      deps.writeCronOutboxRecord({
        version: 1,
        cron: taskName,
        runId,
        kind: "output",
        payload,
        chatId,
        ...(threadId === undefined ? {} : { threadId }),
        createdAt: new Date().toISOString(),
        attempts: 0,
      });
      deps.log(taskName, `OUTBOX QUEUED runId=${runId} kind=output`);
    } catch (err) {
      deps.log(taskName, `OUTBOX QUEUE-WRITE-FAILED: ${errorFromUnknown(err).message}`);
    }
  };

  deps.log(taskName, `Starting cron task: ${taskName}`);

  let defaults: DeliveryDefaults = {};
  try {
    defaults = deps.loadDefaultDelivery();
  } catch (err) {
    deps.log(taskName, `WARN: could not load delivery defaults from config: ${(err as Error).message}`);
  }

  let cron: CronJob;
  try {
    cron = deps.loadCronTask(taskName, undefined, defaults);
  } catch (err) {
    try {
      deps.log(taskName, `FAIL: ${(err as Error).message}`);
    } finally {
      finalizeInvocation(taskName, "failure");
    }
    deps.exit(1);
  }

  let adminChatId: number | undefined;
  try {
    adminChatId = deps.loadAdminChatId();
  } catch (err) {
    deps.log(taskName, `WARN: could not load adminChatId from config: ${(err as Error).message}`);
  }

  deps.log(taskName, `Loaded: type=${cron.type}, agent=${cron.agentId}, deliver=${cron.deliveryChatId}${cron.deliveryThreadId ? `, thread=${cron.deliveryThreadId}` : ""}`);

  const notifyAdminOfTerminalOutbox = (
    record: CronOutboxRecord,
    reason: "gave-up" | "deterministic",
  ): void => {
    if (adminChatId === undefined) {
      return;
    }
    try {
      deps.deliver(
        adminChatId,
        `⚠️ Cron outbox ${reason}\nTask: ${taskName}\nRun: ${record.runId}\nAttempts: ${record.attempts}`,
      );
    } catch (err) {
      deps.log(
        taskName,
        `OUTBOX ADMIN-NOTICE-FAILED runId=${record.runId}: ${errorFromUnknown(err).message}`,
      );
    }
  };

  let pendingRecord: CronOutboxRecord | "corrupt" | undefined;
  try {
    pendingRecord = deps.readCronOutboxRecord(taskName);
  } catch (err) {
    deps.log(taskName, `OUTBOX STATE-READ-FAILED: ${errorFromUnknown(err).message}`);
    // No logical cron execution started, so this outbox preflight failure must
    // not increment terminal logical-run counters.
    deps.exit(1);
  }

  if (
    pendingRecord !== undefined
    && pendingRecord !== "corrupt"
    && pendingRecord.kind === "failure-notice"
  ) {
    try {
      deps.clearCronOutboxRecord(taskName);
    } catch (err) {
      deps.log(
        taskName,
        `OUTBOX CLEAR-FAILED legacy-failure-notice runId=${pendingRecord.runId}: ${errorFromUnknown(err).message}`,
      );
      deps.exit(1);
    }
    deps.log(
      taskName,
      `OUTBOX DROPPED legacy-failure-notice runId=${pendingRecord.runId}`,
    );
    pendingRecord = undefined;
  }

  if (pendingRecord === "corrupt") {
    try {
      deps.clearCronOutboxRecord(taskName);
      deps.log(taskName, "OUTBOX TERMINAL corrupt");
    } catch (err) {
      deps.log(taskName, `OUTBOX CLEAR-FAILED corrupt: ${errorFromUnknown(err).message}`);
      deps.exit(1);
    }
  } else if (pendingRecord !== undefined) {
    const expired = Date.now() - Date.parse(pendingRecord.createdAt) > CRON_OUTBOX_EXPIRY_MS;
    if (expired || pendingRecord.attempts >= CRON_OUTBOX_MAX_ATTEMPTS) {
      try {
        deps.clearCronOutboxRecord(taskName);
      } catch (err) {
        deps.log(
          taskName,
          `OUTBOX CLEAR-FAILED runId=${pendingRecord.runId}: ${errorFromUnknown(err).message}`,
        );
        deps.exit(1);
      }
      deps.log(
        taskName,
        `OUTBOX TERMINAL gave-up runId=${pendingRecord.runId} attempts=${pendingRecord.attempts}`,
      );
      notifyAdminOfTerminalOutbox(pendingRecord, "gave-up");
    } else {
      const deliveryAttempt: { ok: true } | { ok: false; error: unknown } = (() => {
        try {
          deps.deliver(pendingRecord.chatId, pendingRecord.payload, pendingRecord.threadId);
          return { ok: true };
        } catch (error) {
          return { ok: false, error };
        }
      })();

      if (!deliveryAttempt.ok) {
        const err = deliveryAttempt.error;
        if (isQueueableDeliveryFailure(err)) {
          const updatedRecord = {
            ...pendingRecord,
            attempts: pendingRecord.attempts + 1,
          };
          try {
            deps.writeCronOutboxRecord(updatedRecord);
          } catch (writeError) {
            deps.log(
              taskName,
              `OUTBOX RETRY-WRITE-FAILED runId=${pendingRecord.runId}: ${errorFromUnknown(writeError).message}`,
            );
            deps.exit(1);
          }
          deps.log(
            taskName,
            `OUTBOX RETRY-DEFERRED runId=${pendingRecord.runId} attempts=${updatedRecord.attempts}`,
          );
          // This invocation only retried delivery owed by an earlier logical
          // run. It exits without generating or counting a new logical run.
          deps.exit(1);
        }
        try {
          deps.clearCronOutboxRecord(taskName);
        } catch (clearError) {
          deps.log(
            taskName,
            `OUTBOX CLEAR-FAILED runId=${pendingRecord.runId}: ${errorFromUnknown(clearError).message}`,
          );
          deps.exit(1);
        }
        deps.log(
          taskName,
          `OUTBOX TERMINAL deterministic runId=${pendingRecord.runId} attempts=${pendingRecord.attempts}`,
        );
        notifyAdminOfTerminalOutbox(pendingRecord, "deterministic");
      } else {
        try {
          deps.clearCronOutboxRecord(taskName);
        } catch (err) {
          deps.log(
            taskName,
            `OUTBOX CLEAR-FAILED runId=${pendingRecord.runId}: ${errorFromUnknown(err).message}`,
          );
          deps.exit(1);
        }
        deps.log(
          taskName,
          `OUTBOX REDELIVERED runId=${pendingRecord.runId} attempts=${pendingRecord.attempts}`,
        );
      }
    }
  }

  let output: string;
  let terminalOutcome: CronTerminalOutcome = "success";
  try {
    if (cron.type === "script") {
      output = deps.runScript(cron);
      deps.log(taskName, `Script returned ${output.length} chars`);
    } else {
      const cronAgentData = deps.resolveCronAgentData(cron.agentId);
      const workspaceCwd = cronAgentData.workspaceCwd;
      output = runOneShot(
        cron,
        workspaceCwd,
        { runPi: deps.runPi },
        cronAgentData,
      );
      deps.log(taskName, `Pi returned ${output.length} chars`);
      const classified = classifyLlmCronTerminalResult(output);
      output = classified.output;
      terminalOutcome = classified.outcome;
    }
  } catch (err) {
    const error = errorFromUnknown(err);
    const errMsg = `Cron task "${taskName}" failed: ${error.message}`;
    const diagnostics = cronErrorDiagnostics(err);
    try {
      try {
        deps.log(taskName, `FAIL: ${errMsg}`);
      } finally {
        if (diagnostics) {
          deps.log(taskName, `FAIL diagnostics: ${diagnostics}`);
        }
      }
    } finally {
      finalizeInvocation(taskName, "failure");
    }
    deps.exit(1);
  }

  if (!output) {
    finalizeInvocation(taskName, terminalOutcome);
    deps.log(taskName, "WARN: empty output — skipping delivery");
    if (terminalOutcome === "failure") {
      deps.exit(1);
    }
    deps.log(taskName, "DONE");
    return;
  }
  if (cron.type === "llm" && shouldSuppressNoReply(output)) {
    finalizeInvocation(taskName, terminalOutcome);
    deps.log(taskName, "NO_REPLY — skipping delivery");
    if (terminalOutcome === "failure") {
      deps.exit(1);
    }
    deps.log(taskName, "DONE");
    return;
  }

  // Deliver output to target chat
  try {
    await deliverWithRetry(cron.deliveryChatId, output, cron.deliveryThreadId);
  } catch (err) {
    try {
      try {
        if (isQueueableDeliveryFailure(err)) {
          queueOutputIfEmpty(output, cron.deliveryChatId, cron.deliveryThreadId);
        }
      } finally {
        deps.handleDeliveryFailure(taskName, cron.deliveryChatId, (err as Error).message, adminChatId);
      }
    } finally {
      finalizeInvocation(taskName, "failure");
    }
    deps.exit(1);
  }

  finalizeInvocation(taskName, terminalOutcome);
  deps.log(taskName, `Delivered to chat ${cron.deliveryChatId}${cron.deliveryThreadId ? ` thread ${cron.deliveryThreadId}` : ""}`);
  if (terminalOutcome === "failure") {
    deps.exit(1);
  }
  deps.log(taskName, "DONE");
}

// Only run main() when executed directly (not when imported in tests)
const isMain =
  process.argv[1]?.endsWith("cron-runner.ts") ||
  process.argv[1]?.endsWith("cron-runner.js");
if (isMain) {
  main();
}

export { loadCronTask, resolveCronAgentData, buildPiCronAgentConfig, getAgentWorkspace, deliver, buildDeliverArgs, runPi, runOneShot, resolveCronEngine, classifyPiResult, writeCronHealthMetric, runScript, main };
