import { readFileSync, readSync, writeSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RecoveryPlannerError,
  runRecoveryPlanner,
  type RecoveryEvidenceItem,
  type RecoveryInvocationFence,
  type RecoveryPlannerRequest,
} from "./fixer-runner.js";
import {
  executeRecoveryPlan,
  executeRecoveryProbes,
  type ProbeDefinition,
  type RecoveryExecutionResult,
  type RecoveryMode,
  type RunbookDefinition,
} from "./runbook-executor.js";
import type { RecoveryPlan } from "../pi-extensions/recovery-plan.js";

const MAX_WORKER_INPUT_BYTES = 512 * 1024;
const MAX_WORKER_COMMAND_OUTPUT_BYTES = 8 * 1024;

export interface RecoveryWorkerRequest {
  version: 1;
  mode: RecoveryMode;
  fence: RecoveryInvocationFence;
  evidence: readonly RecoveryEvidenceItem[];
  runbooks: readonly RunbookDefinition[];
  probes: readonly ProbeDefinition[];
}

export interface RecoveryWorkerDependencies {
  planner?: (request: RecoveryPlannerRequest) => Promise<Readonly<RecoveryPlan>>;
  executor?: typeof executeRecoveryPlan;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  checkFence?: () => boolean | Promise<boolean>;
}

export interface RecoveryVerificationWorkerRequest {
  version: 1;
  operation: "verify";
  fence: {
    incidentId: number;
    generation: number;
    policyRevision: number;
  };
  probes: readonly ProbeDefinition[];
}

export interface RecoveryVerificationWorkerResult {
  version: 1;
  status: "completed" | "failed" | "rejected" | "stale";
  probes: readonly import("./runbook-executor.js").RecoveryCommandResult[];
}

export interface RecoveryWorkerResult {
  version: 1;
  status: RecoveryExecutionResult["status"] | "planner_error";
  code?: string;
  plan?: Readonly<RecoveryPlan>;
  actions: RecoveryExecutionResult["actions"];
  probes: RecoveryExecutionResult["probes"];
  plannerLaunched: boolean;
  executorLaunched: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function validateRequest(value: unknown): RecoveryWorkerRequest {
  if (
    !isRecord(value)
    || !exactKeys(value, ["version", "mode", "fence", "evidence", "runbooks", "probes"])
    || value.version !== 1
    || (value.mode !== "observe" && value.mode !== "plan" && value.mode !== "enabled")
    || !isRecord(value.fence)
    || !Array.isArray(value.evidence)
    || !Array.isArray(value.runbooks)
    || !Array.isArray(value.probes)
  ) {
    throw new RecoveryPlannerError("invalid_request", "recovery worker request is invalid");
  }
  return value as unknown as RecoveryWorkerRequest;
}

function validateVerificationRequest(value: unknown): RecoveryVerificationWorkerRequest {
  if (
    !isRecord(value)
    || !exactKeys(value, ["version", "operation", "fence", "probes"])
    || value.version !== 1
    || value.operation !== "verify"
    || !isRecord(value.fence)
    || !exactKeys(value.fence, ["incidentId", "generation", "policyRevision"])
    || !Number.isSafeInteger(value.fence.incidentId)
    || (value.fence.incidentId as number) < 1
    || !Number.isSafeInteger(value.fence.generation)
    || (value.fence.generation as number) < 1
    || !Number.isSafeInteger(value.fence.policyRevision)
    || (value.fence.policyRevision as number) < 1
    || !Array.isArray(value.probes)
  ) {
    throw new RecoveryPlannerError("invalid_request", "recovery verification request is invalid");
  }
  return value as unknown as RecoveryVerificationWorkerRequest;
}

function emptyPlannerError(code: string): RecoveryWorkerResult {
  return {
    version: 1,
    status: "planner_error",
    code,
    actions: Object.freeze([]),
    probes: Object.freeze([]),
    plannerLaunched: true,
    executorLaunched: false,
  };
}

export async function runRecoveryWorkerRequest(
  value: unknown,
  deps: RecoveryWorkerDependencies = {},
): Promise<RecoveryWorkerResult> {
  let request: RecoveryWorkerRequest;
  try {
    request = validateRequest(value);
  } catch (error) {
    return emptyPlannerError(error instanceof RecoveryPlannerError ? error.code : "invalid_request");
  }
  const env = deps.env ?? process.env;
  const agentWorkspace = env.MINIME_AGENT_WORKSPACE_ROOT?.trim() ?? "";
  if (!agentWorkspace || !isAbsolute(agentWorkspace)) {
    return emptyPlannerError("context_unavailable");
  }
  const plannerRequest: RecoveryPlannerRequest = {
    agent: {
      id: "recovery-fixer",
      workspaceCwd: agentWorkspace,
      model: "openai-codex/gpt-5.5",
      thinking: "low",
    },
    fence: request.fence,
    evidence: request.evidence,
    knownRunbookIds: request.runbooks.map((runbook) => runbook.id),
    knownProbeIds: request.probes.map((probe) => probe.id),
  };
  let plan: Readonly<RecoveryPlan>;
  try {
    plan = await (deps.planner ?? ((plannerValue) => (
      runRecoveryPlanner(plannerValue, { signal: deps.signal })
    )))(plannerRequest);
  } catch (error) {
    return emptyPlannerError(error instanceof RecoveryPlannerError ? error.code : "spawn_failed");
  }
  let execution: RecoveryExecutionResult;
  try {
    execution = await (deps.executor ?? executeRecoveryPlan)(
      {
        mode: request.mode,
        plan,
        fence: request.fence,
        runbooks: request.runbooks,
        probes: request.probes,
      },
      {
        checkFence: deps.checkFence ?? (() => deps.signal?.aborted !== true),
        maxOutputBytes: MAX_WORKER_COMMAND_OUTPUT_BYTES,
        signal: deps.signal,
      },
    );
  } catch {
    return {
      version: 1,
      status: "rejected",
      plan,
      actions: Object.freeze([]),
      probes: Object.freeze([]),
      plannerLaunched: true,
      executorLaunched: false,
    };
  }
  return {
    version: 1,
    status: execution.status,
    plan,
    actions: execution.actions,
    probes: execution.probes,
    plannerLaunched: true,
    executorLaunched: execution.actions.length > 0 || execution.probes.length > 0,
  };
}

export async function runRecoveryVerificationWorkerRequest(
  value: unknown,
  deps: Pick<RecoveryWorkerDependencies, "signal" | "checkFence"> = {},
): Promise<RecoveryVerificationWorkerResult> {
  let request: RecoveryVerificationWorkerRequest;
  try {
    request = validateVerificationRequest(value);
  } catch {
    return { version: 1, status: "rejected", probes: Object.freeze([]) };
  }
  const result = await executeRecoveryProbes(request.probes, {
    checkFence: deps.checkFence ?? (() => deps.signal?.aborted !== true),
    maxOutputBytes: MAX_WORKER_COMMAND_OUTPUT_BYTES,
    signal: deps.signal,
  });
  return {
    version: 1,
    status: result.status,
    probes: Object.freeze(result.probes.map((probe) => Object.freeze({
      ...probe,
      output: "",
    }))),
  };
}

function fenceCheckFromEnvironment(env: NodeJS.ProcessEnv): (() => boolean) | undefined {
  const raw = env.MINIME_RECOVERY_FENCE_FD?.trim();
  if (!raw || !/^[0-9]{1,6}$/.test(raw)) {
    return undefined;
  }
  const descriptor = Number(raw);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
    return undefined;
  }
  return () => {
    const response = Buffer.alloc(1);
    try {
      if (writeSync(descriptor, Buffer.from("?", "ascii")) !== 1) {
        return false;
      }
      return readSync(descriptor, response, 0, 1, null) === 1 && response[0] === 0x31;
    } catch {
      return false;
    }
  };
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  let value: unknown;
  try {
    const input = readFileSync(0);
    if (input.byteLength > MAX_WORKER_INPUT_BYTES) {
      throw new Error("oversized");
    }
    value = JSON.parse(input.toString("ascii"));
  } catch {
    process.stdout.write(JSON.stringify(emptyPlannerError("invalid_request")));
    return;
  }
  const checkFence = fenceCheckFromEnvironment(process.env);
  const result = isRecord(value) && value.operation === "verify"
    ? await runRecoveryVerificationWorkerRequest(value, { signal: controller.signal, checkFence })
    : await runRecoveryWorkerRequest(value, { signal: controller.signal, checkFence });
  process.stdout.write(JSON.stringify(result));
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main();
}
