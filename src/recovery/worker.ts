import { readFileSync } from "node:fs";
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
  type ProbeDefinition,
  type RecoveryExecutionResult,
  type RecoveryMode,
  type RunbookDefinition,
} from "./runbook-executor.js";
import type { RecoveryPlan } from "../pi-extensions/recovery-plan.js";

const MAX_WORKER_INPUT_BYTES = 512 * 1024;

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
        checkFence: () => deps.signal?.aborted !== true,
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
  const result = await runRecoveryWorkerRequest(value, { signal: controller.signal });
  process.stdout.write(JSON.stringify(result));
}

const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) {
  void main();
}
