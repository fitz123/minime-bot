import { spawn } from "node:child_process";
import { basename, isAbsolute } from "node:path";
import {
  validateRecoveryPlan,
  type RecoveryPlan,
  type RecoveryPlanFence,
} from "../pi-extensions/recovery-plan.js";
import type { RecoveryInvocationFence } from "./fixer-runner.js";

export const RESTRICTED_RECOVERY_ACTION_CLASSES = Object.freeze([
  "restart",
  "deploy",
  "sudo",
  "package_upgrade",
  "secret_migration",
  "public_write",
] as const);

export type RestrictedRecoveryActionClass = typeof RESTRICTED_RECOVERY_ACTION_CLASSES[number];
export type RecoveryActionClass =
  | "diagnostic"
  | "local_repair"
  | "cache_cleanup"
  | RestrictedRecoveryActionClass;
export type RecoveryMode = "observe" | "plan" | "enabled";

export const DEFAULT_RECOVERY_RUNBOOKS: readonly RunbookDefinition[] = Object.freeze([]);
export const DEFAULT_RECOVERY_PROBES: readonly ProbeDefinition[] = Object.freeze([]);
export const DEFAULT_RECOVERY_COMMAND_TIMEOUT_MS = 30_000;
export const RECOVERY_COMMAND_ABORT_GRACE_MS = 2_000;
export const MAX_RECOVERY_COMMAND_OUTPUT_BYTES = 16 * 1024;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;
const SENSITIVE_ENV_KEY = /(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i;
const SENSITIVE_ARG = /^--?(?:api[-_]?key|authorization|credential|password|secret|token)(?:=|$)/i;
const ACTION_CLASSES = new Set<RecoveryActionClass>([
  "diagnostic",
  "local_repair",
  "cache_cleanup",
  ...RESTRICTED_RECOVERY_ACTION_CLASSES,
]);
const RESTRICTED_CLASSES = new Set<RecoveryActionClass>(RESTRICTED_RECOVERY_ACTION_CLASSES);

export interface StaticRecoveryCommand {
  executable: string;
  argv: readonly string[];
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export interface RunbookDefinition extends StaticRecoveryCommand {
  id: string;
  actionClass: RecoveryActionClass;
}

export interface ProbeDefinition extends StaticRecoveryCommand {
  id: string;
}

export interface RecoveryCommandChildLike {
  pid?: number;
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: "close", listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface RecoveryCommandSpawnOptions {
  env: Record<string, string>;
  shell: false;
  detached: boolean;
  stdio: ["ignore", "pipe", "pipe"];
}

export type RecoveryCommandSpawn = (
  executable: string,
  argv: string[],
  options: RecoveryCommandSpawnOptions,
) => RecoveryCommandChildLike;

export interface RecoveryCommandResult {
  id: string;
  exitCode: number;
  timedOut: boolean;
  output: string;
  truncated: boolean;
}

export type RecoveryExecutionResult =
  | {
      status: "observe" | "not_actionable";
      actions: readonly RecoveryCommandResult[];
      probes: readonly RecoveryCommandResult[];
    }
  | {
      status: "planned";
      runbookIds: readonly string[];
      probeIds: readonly string[];
      actions: readonly RecoveryCommandResult[];
      probes: readonly RecoveryCommandResult[];
    }
  | {
      status: "approval_required";
      approvalClasses: readonly RestrictedRecoveryActionClass[];
      runbookIds: readonly string[];
      actions: readonly RecoveryCommandResult[];
      probes: readonly RecoveryCommandResult[];
    }
  | {
      status: "rejected" | "stale" | "failed" | "completed";
      actions: readonly RecoveryCommandResult[];
      probes: readonly RecoveryCommandResult[];
    };

export interface RecoveryExecutorRequest {
  mode?: RecoveryMode;
  plan: Readonly<RecoveryPlan>;
  fence: RecoveryInvocationFence;
  runbooks: readonly RunbookDefinition[];
  probes: readonly ProbeDefinition[];
}

export interface RecoveryExecutorDependencies {
  spawn?: RecoveryCommandSpawn;
  checkFence: (fence: RecoveryInvocationFence) => boolean | Promise<boolean>;
  killProcessGroup?: (
    child: RecoveryCommandChildLike,
    signal: NodeJS.Signals,
    detached: boolean,
  ) => void;
  abortGraceMs?: number;
  maxOutputBytes?: number;
}

class ExecutorConfigError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: object, required: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === required.length && keys.every((key) => required.includes(key));
}

function validateStaticCommand(command: StaticRecoveryCommand): void {
  if (
    !isRecord(command.env)
    || !isAbsolute(command.executable)
    || command.executable.includes("\0")
    || basename(command.executable).toLowerCase() === "sudo"
    || !Array.isArray(command.argv)
    || command.argv.length > 64
    || !Number.isSafeInteger(command.timeoutMs)
    || command.timeoutMs < 100
    || command.timeoutMs > 300_000
  ) {
    throw new ExecutorConfigError("recovery command configuration is invalid");
  }
  let argvBytes = 0;
  for (const value of command.argv) {
    if (
      typeof value !== "string"
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > 4_096
      || SENSITIVE_ARG.test(value)
    ) {
      throw new ExecutorConfigError("recovery command argv is invalid");
    }
    argvBytes += Buffer.byteLength(value, "utf8");
  }
  if (argvBytes > 16 * 1024) {
    throw new ExecutorConfigError("recovery command argv is oversized");
  }
  const envEntries = Object.entries(command.env);
  if (envEntries.length > 32) {
    throw new ExecutorConfigError("recovery command env is oversized");
  }
  for (const [key, value] of envEntries) {
    if (
      !ENV_KEY.test(key)
      || SENSITIVE_ENV_KEY.test(key)
      || typeof value !== "string"
      || value.includes("\0")
      || Buffer.byteLength(value, "utf8") > 4_096
    ) {
      throw new ExecutorConfigError("recovery command env is invalid");
    }
  }
}

function registry<T extends RunbookDefinition | ProbeDefinition>(
  definitions: readonly T[],
  kind: "runbook" | "probe",
): Map<string, T> {
  if (!Array.isArray(definitions) || definitions.length > 128) {
    throw new ExecutorConfigError(`${kind} registry is invalid`);
  }
  const result = new Map<string, T>();
  for (const definition of definitions) {
    const keys = kind === "runbook"
      ? ["id", "actionClass", "executable", "argv", "env", "timeoutMs"]
      : ["id", "executable", "argv", "env", "timeoutMs"];
    if (
      !definition
      || typeof definition !== "object"
      || !exactKeys(definition, keys)
      || typeof definition.id !== "string"
      || !SAFE_ID.test(definition.id)
      || result.has(definition.id)
    ) {
      throw new ExecutorConfigError(`${kind} registry is invalid`);
    }
    if (kind === "runbook") {
      const runbook = definition as RunbookDefinition;
      if (!ACTION_CLASSES.has(runbook.actionClass)) {
        throw new ExecutorConfigError("runbook action class is invalid");
      }
    }
    validateStaticCommand(definition);
    result.set(definition.id, definition);
  }
  return result;
}

export function redactRecoveryOutput(value: string): string {
  return value
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1[REDACTED]")
    .replace(/\b((?:api[-_]?key|credential|password|secret|token)\s*[:=]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

function defaultKillProcessGroup(
  child: RecoveryCommandChildLike,
  signal: NodeJS.Signals,
  detached: boolean,
): void {
  if (detached && process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The process may have exited between the timeout and signal delivery.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Cleanup is best effort after the bounded command has already failed.
  }
}

function runStaticCommand(
  id: string,
  command: StaticRecoveryCommand,
  deps: RecoveryExecutorDependencies,
): Promise<RecoveryCommandResult> {
  const commandSpawn: RecoveryCommandSpawn = deps.spawn ?? ((executable, argv, options) => (
    spawn(executable, argv, options) as unknown as RecoveryCommandChildLike
  ));
  const maxOutputBytes = deps.maxOutputBytes ?? MAX_RECOVERY_COMMAND_OUTPUT_BYTES;
  const abortGraceMs = deps.abortGraceMs ?? RECOVERY_COMMAND_ABORT_GRACE_MS;
  const detached = process.platform !== "win32";

  return new Promise((resolve) => {
    let child: RecoveryCommandChildLike;
    try {
      child = commandSpawn(command.executable, [...command.argv], {
        env: { ...command.env },
        shell: false,
        detached,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ id, exitCode: 1, timedOut: false, output: "", truncated: false });
      return;
    }

    const chunks: Buffer[] = [];
    let retainedBytes = 0;
    let totalBytes = 0;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const ingest = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
      totalBytes += buffer.byteLength;
      if (retainedBytes < maxOutputBytes) {
        const fitting = buffer.subarray(0, maxOutputBytes - retainedBytes);
        chunks.push(fitting);
        retainedBytes += fitting.byteLength;
      }
    };
    child.stdout?.on("data", ingest);
    child.stderr?.on("data", ingest);

    const kill = (signal: NodeJS.Signals) => {
      (deps.killProcessGroup ?? defaultKillProcessGroup)(child, signal, detached);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) {
          kill("SIGKILL");
        }
      }, abortGraceMs);
    }, command.timeoutMs);

    const finish = (exitCode: number) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve({
        id,
        exitCode,
        timedOut,
        output: redactRecoveryOutput(raw),
        truncated: totalBytes > retainedBytes,
      });
    };
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
    child.on("error", () => finish(1));
  });
}

function publicFence(fence: RecoveryInvocationFence): RecoveryPlanFence {
  return {
    invocationId: fence.invocationId,
    incidentId: fence.incidentId,
    generation: fence.generation,
    evidenceHash: fence.evidenceHash,
    policyRevision: fence.policyRevision,
  };
}

function emptyResult(status: "rejected" | "stale" | "failed"): RecoveryExecutionResult {
  return { status, actions: Object.freeze([]), probes: Object.freeze([]) };
}

/**
 * Preflight the complete plan, then execute only static configured commands.
 * No model-provided text is ever copied into executable, argv, env, or shell.
 */
export async function executeRecoveryPlan(
  request: RecoveryExecutorRequest,
  deps: RecoveryExecutorDependencies,
): Promise<RecoveryExecutionResult> {
  let runbooks: Map<string, RunbookDefinition>;
  let probes: Map<string, ProbeDefinition>;
  let plan: Readonly<RecoveryPlan>;
  try {
    runbooks = registry(request.runbooks, "runbook");
    probes = registry(request.probes, "probe");
    plan = validateRecoveryPlan(request.plan, {
      fence: publicFence(request.fence),
      knownEvidenceRefs: new Set(request.plan.evidenceRefs),
      knownRunbookIds: new Set(runbooks.keys()),
      knownProbeIds: new Set(probes.keys()),
    });
  } catch {
    return emptyResult("rejected");
  }

  if (!(await deps.checkFence(request.fence))) {
    return emptyResult("stale");
  }
  if (plan.verdict === "observe" || plan.verdict === "not_actionable") {
    return {
      status: plan.verdict,
      actions: Object.freeze([]),
      probes: Object.freeze([]),
    };
  }

  const mode = request.mode ?? "enabled";
  if (mode !== "observe" && mode !== "plan" && mode !== "enabled") {
    return emptyResult("rejected");
  }
  if (mode === "observe") {
    return {
      status: "observe",
      actions: Object.freeze([]),
      probes: Object.freeze([]),
    };
  }
  if (mode === "plan") {
    return {
      status: "planned",
      runbookIds: Object.freeze([...plan.runbookIds]),
      probeIds: Object.freeze([...plan.probeIds]),
      actions: Object.freeze([]),
      probes: Object.freeze([]),
    };
  }

  const selectedRunbooks = plan.runbookIds.map((id) => runbooks.get(id)!);
  const restricted = selectedRunbooks
    .map((runbook) => runbook.actionClass)
    .filter((actionClass): actionClass is RestrictedRecoveryActionClass => RESTRICTED_CLASSES.has(actionClass));
  if (plan.verdict === "approval_required" || restricted.length > 0) {
    return {
      status: "approval_required",
      approvalClasses: Object.freeze([...new Set(restricted)].sort()),
      runbookIds: Object.freeze([...plan.runbookIds]),
      actions: Object.freeze([]),
      probes: Object.freeze([]),
    };
  }

  const actions: RecoveryCommandResult[] = [];
  const probeResults: RecoveryCommandResult[] = [];
  for (const runbook of selectedRunbooks) {
    if (!(await deps.checkFence(request.fence))) {
      return { status: "stale", actions: Object.freeze(actions), probes: Object.freeze(probeResults) };
    }
    const result = await runStaticCommand(runbook.id, runbook, deps);
    actions.push(result);
    if (result.timedOut || result.exitCode !== 0) {
      return { status: "failed", actions: Object.freeze(actions), probes: Object.freeze(probeResults) };
    }
    if (!(await deps.checkFence(request.fence))) {
      return { status: "stale", actions: Object.freeze(actions), probes: Object.freeze(probeResults) };
    }
  }

  for (const probeId of plan.probeIds) {
    if (!(await deps.checkFence(request.fence))) {
      return { status: "stale", actions: Object.freeze(actions), probes: Object.freeze(probeResults) };
    }
    const result = await runStaticCommand(probeId, probes.get(probeId)!, deps);
    probeResults.push(result);
    if (result.timedOut || result.exitCode !== 0) {
      return { status: "failed", actions: Object.freeze(actions), probes: Object.freeze(probeResults) };
    }
  }
  if (!(await deps.checkFence(request.fence))) {
    return { status: "stale", actions: Object.freeze(actions), probes: Object.freeze(probeResults) };
  }
  return {
    status: "completed",
    actions: Object.freeze(actions),
    probes: Object.freeze(probeResults),
  };
}
