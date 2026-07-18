import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  EMPTY_OPS_WORKER_DONE_CHECK_REGISTRY,
  type OpsWorkerDoneCheckRegistry,
} from "./done-checks.js";
import {
  createOpsWorkerPiStartupReconciler,
  readOpsWorkerProcessIdentity,
  OpsWorkerPiAttemptRunner,
  type OpsWorkerPiAttemptDependencies,
} from "./pi-attempt.js";
import {
  isOpsWorkerUnresolvedOrphan,
  OpsWorkerSupervisor,
  type OpsWorkerLockOwnerStatus,
  type OpsWorkerStartupRunResult,
  type OpsWorkerSupervisorLockRecord,
} from "./supervisor.js";
import { OpsWorkerTaskStore } from "./task-store.js";
import {
  DEFAULT_OPS_WORKER_STATUS_HOST,
  DEFAULT_OPS_WORKER_STATUS_PORT,
  startOpsWorkerStatusServer,
} from "./status-server.js";
import {
  OPS_WORKER_SOURCE_PRIORITIES,
  OPS_WORKER_TASK_SCHEMA_VERSION,
  OPS_WORKER_TASK_STATES,
  type JsonObject,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
  type OpsWorkerTaskState,
  OpsWorkerTaskValidationError,
} from "./types.js";

type WriteFn = (text: string) => void;

export const EMPTY_OPS_WORKER_TASK_CONTRACT_REGISTRY: OpsWorkerTaskContractRegistry =
  Object.freeze({
    templates: Object.freeze({}),
    authorizationProfiles: Object.freeze({}),
    doneChecks: EMPTY_OPS_WORKER_DONE_CHECK_REGISTRY.contracts,
  });

export interface OpsWorkerCliDependencies {
  taskRegistry?: OpsWorkerTaskContractRegistry;
  doneChecks?: OpsWorkerDoneCheckRegistry;
  now?: () => Date;
  randomId?: () => string;
  processStartToken?: string;
  inspectLockOwner?: (
    owner: OpsWorkerSupervisorLockRecord,
  ) => OpsWorkerLockOwnerStatus;
  reconcileActiveRun?: (
    task: OpsWorkerTask,
  ) => OpsWorkerStartupRunResult | Promise<OpsWorkerStartupRunResult>;
  piAttemptDependencies?: OpsWorkerPiAttemptDependencies;
  abortSignal?: AbortSignal;
  schedulerPollMs?: number;
}

export interface RunOpsWorkerCliOptions {
  cwd: string;
  stdout: WriteFn;
  stderr: WriteFn;
  dependencies?: OpsWorkerCliDependencies;
}

interface ParsedWorkerOptions {
  values: Map<string, string>;
  flags: Set<string>;
}

const WORKER_VALUE_OPTIONS = new Set([
  "agent-workspace",
  "authorization",
  "correlation-key",
  "done-check",
  "done-check-params",
  "host",
  "id",
  "objective",
  "port",
  "reason",
  "state-dir",
  "template",
]);

const WORKER_BOOL_OPTIONS = new Set(["json", "once"]);

const WORKER_ACTION_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  start: ["state-dir", "agent-workspace", "host", "port", "once"],
  status: ["state-dir", "json"],
  list: ["state-dir", "json"],
  inspect: ["state-dir", "id", "json"],
  submit: [
    "state-dir",
    "template",
    "authorization",
    "done-check",
    "done-check-params",
    "correlation-key",
    "objective",
    "json",
  ],
  retry: ["state-dir", "id", "json"],
  cancel: ["state-dir", "id", "reason", "json"],
};

class OpsWorkerCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsWorkerCliUsageError";
  }
}

function writeLine(write: WriteFn, text = ""): void {
  write(`${text}\n`);
}

function writeJson(write: WriteFn, value: unknown): void {
  writeLine(write, JSON.stringify(value, null, 2));
}

function parseWorkerOptions(
  action: string,
  args: readonly string[],
): ParsedWorkerOptions {
  const allowed = new Set(WORKER_ACTION_OPTIONS[action]);
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const raw = args[index];
    if (!raw.startsWith("--")) {
      throw new OpsWorkerCliUsageError(`unexpected worker argument: ${raw}`);
    }
    const equals = raw.indexOf("=");
    const name = raw.slice(2, equals >= 0 ? equals : undefined);
    if (!allowed.has(name)) {
      throw new OpsWorkerCliUsageError(`unknown worker ${action} option: --${name}`);
    }
    if (WORKER_BOOL_OPTIONS.has(name)) {
      if (equals >= 0) {
        throw new OpsWorkerCliUsageError(`--${name} does not accept a value`);
      }
      if (flags.has(name)) {
        throw new OpsWorkerCliUsageError(`--${name} may be specified only once`);
      }
      flags.add(name);
      continue;
    }
    if (!WORKER_VALUE_OPTIONS.has(name)) {
      throw new OpsWorkerCliUsageError(`unknown worker ${action} option: --${name}`);
    }
    let value: string;
    if (equals >= 0) {
      value = raw.slice(equals + 1);
    } else {
      const next = args[index + 1];
      if (!next || next.startsWith("--")) {
        throw new OpsWorkerCliUsageError(`--${name} requires a value`);
      }
      value = next;
      index += 1;
    }
    if (!value.trim()) {
      throw new OpsWorkerCliUsageError(`--${name} requires a non-empty value`);
    }
    if (values.has(name)) {
      throw new OpsWorkerCliUsageError(`--${name} may be specified only once`);
    }
    values.set(name, value);
  }
  return { values, flags };
}

function requiredValue(options: ParsedWorkerOptions, name: string): string {
  const value = options.values.get(name)?.trim();
  if (!value) throw new OpsWorkerCliUsageError(`worker command requires --${name}`);
  return value;
}

function resolveCliPath(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function stateDirectory(options: ParsedWorkerOptions, cwd: string): string {
  return resolveCliPath(requiredValue(options, "state-dir"), cwd);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_OPS_WORKER_STATUS_PORT;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new OpsWorkerCliUsageError("--port must be an integer between 0 and 65535");
  }
  return value;
}

function parseDoneCheckParams(raw: string | undefined): JsonObject {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new OpsWorkerCliUsageError("--done-check-params must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsWorkerCliUsageError("--done-check-params must be a JSON object");
  }
  return value as JsonObject;
}

function taskSummary(tasks: readonly OpsWorkerTask[]): {
  service: "minime-ops-worker";
  schemaVersion: typeof OPS_WORKER_TASK_SCHEMA_VERSION;
  totalTasks: number;
  activeProcessGroups: number;
  states: Record<OpsWorkerTaskState, number>;
} {
  const states = Object.fromEntries(
    OPS_WORKER_TASK_STATES.map((state) => [state, 0]),
  ) as Record<OpsWorkerTaskState, number>;
  for (const task of tasks) states[task.state] += 1;
  return {
    service: "minime-ops-worker",
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    totalTasks: tasks.length,
    activeProcessGroups: tasks.filter((task) =>
      task.state === "RUNNING" || isOpsWorkerUnresolvedOrphan(task)).length,
    states,
  };
}

function defaultProcessStartToken(): string {
  const inspected = readOpsWorkerProcessIdentity(process.pid);
  if (inspected.status !== "OWNED") {
    throw new Error("Cannot start ops-worker without a proven supervisor process identity");
  }
  return inspected.identity.processStartToken;
}

function defaultInspectLockOwner(
  owner: OpsWorkerSupervisorLockRecord,
): OpsWorkerLockOwnerStatus {
  const inspected = readOpsWorkerProcessIdentity(owner.pid);
  if (inspected.status === "GONE") return "STALE";
  if (inspected.status === "AMBIGUOUS") return "AMBIGUOUS";
  return inspected.identity.processStartToken === owner.processStartToken
    ? "ACTIVE"
    : "STALE";
}

function dependencies(options: RunOpsWorkerCliOptions): Required<
  Pick<OpsWorkerCliDependencies, "taskRegistry" | "doneChecks" | "now" | "randomId">
> & OpsWorkerCliDependencies {
  const supplied = options.dependencies ?? {};
  const doneChecks = supplied.doneChecks ?? EMPTY_OPS_WORKER_DONE_CHECK_REGISTRY;
  const taskRegistry = supplied.taskRegistry ?? {
    ...EMPTY_OPS_WORKER_TASK_CONTRACT_REGISTRY,
    doneChecks: doneChecks.contracts,
  };
  assertCompatibleDoneCheckRegistries(taskRegistry, doneChecks);
  return {
    ...supplied,
    taskRegistry,
    doneChecks,
    now: supplied.now ?? (() => new Date()),
    randomId: supplied.randomId ?? randomUUID,
  };
}

function assertCompatibleDoneCheckRegistries(
  taskRegistry: OpsWorkerTaskContractRegistry,
  doneChecks: OpsWorkerDoneCheckRegistry,
): void {
  const contractNames = Object.keys(taskRegistry.doneChecks).sort();
  const executionNames = Object.keys(doneChecks.contracts).sort();
  if (
    contractNames.length !== executionNames.length
    || contractNames.some((name, index) => name !== executionNames[index])
    || contractNames.some((name) =>
      taskRegistry.doneChecks[name].validateParams
        !== doneChecks.contracts[name].validateParams)
  ) {
    throw new TypeError(
      "Ops-worker persistence and execution done-check registries must match exactly",
    );
  }
}

function createStore(
  directory: string,
  deps: ReturnType<typeof dependencies>,
): OpsWorkerTaskStore {
  return new OpsWorkerTaskStore(directory, {
    registry: deps.taskRegistry,
    now: deps.now,
  });
}

function createSupervisor(
  store: OpsWorkerTaskStore,
  deps: ReturnType<typeof dependencies>,
): OpsWorkerSupervisor {
  const suffix = deps.randomId().replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 72);
  return new OpsWorkerSupervisor({
    store,
    doneChecks: deps.doneChecks,
    instanceId: `worker-${process.pid}-${suffix}`,
    processStartToken: deps.processStartToken ?? defaultProcessStartToken(),
    now: deps.now,
    inspectLockOwner: deps.inspectLockOwner ?? defaultInspectLockOwner,
    reconcileActiveRun: deps.reconcileActiveRun
      ?? createOpsWorkerPiStartupReconciler(),
  });
}

function createTask(
  options: ParsedWorkerOptions,
  deps: ReturnType<typeof dependencies>,
): OpsWorkerTask {
  const randomTaskId = deps.randomId()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  if (!randomTaskId) throw new TypeError("Trusted task id source returned no safe characters");
  const id = `op-${randomTaskId}`;
  const now = deps.now().toISOString();
  const authorizationProfile = requiredValue(options, "authorization");
  const authorization = Object.prototype.hasOwnProperty.call(
    deps.taskRegistry.authorizationProfiles,
    authorizationProfile,
  )
    ? deps.taskRegistry.authorizationProfiles[authorizationProfile]
    : undefined;
  if (!authorization) {
    throw new OpsWorkerCliUsageError(
      `authorization profile ${JSON.stringify(authorizationProfile)} is not registered`,
    );
  }
  return {
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    id,
    source: {
      kind: "operator-cli",
      correlationKey: requiredValue(options, "correlation-key"),
      template: requiredValue(options, "template"),
    },
    priority: OPS_WORKER_SOURCE_PRIORITIES["operator-cli"],
    objective: requiredValue(options, "objective"),
    evidence: [{
      at: now,
      kind: "operator",
      trust: "trusted",
      summary: "Submitted by the local CLI through registered PR-1 contracts",
      artifact: null,
    }],
    doneCheck: {
      name: requiredValue(options, "done-check"),
      params: parseDoneCheckParams(options.values.get("done-check-params")),
    },
    authorization: {
      profile: authorizationProfile,
      scope: [...authorization.scope],
      snapshotHash: null,
    },
    state: "QUEUED",
    rounds: {
      remediation: 0,
      maxRemediation: 3,
      consecutiveInfrastructureFailures: 0,
    },
    schedule: { nextRunAt: null, nextCheckAt: null },
    session: {
      directory: `sessions/${id}`,
      sessionId: null,
      resume: false,
    },
    activeRun: null,
    unverifiedRun: null,
    lastOutcome: null,
    report: { state: "NONE", attempts: 0, lastError: null },
    createdAt: now,
    updatedAt: now,
  };
}

function printTask(
  task: OpsWorkerTask,
  json: boolean,
  stdout: WriteFn,
): void {
  if (json) {
    writeJson(stdout, task);
    return;
  }
  writeLine(stdout, `${task.id} ${task.state} ${task.source.template} ${task.source.correlationKey}`);
}

function printTaskList(
  tasks: readonly OpsWorkerTask[],
  json: boolean,
  stdout: WriteFn,
): void {
  if (json) {
    writeJson(stdout, tasks);
    return;
  }
  if (tasks.length === 0) {
    writeLine(stdout, "No ops-worker tasks.");
    return;
  }
  for (const task of tasks) printTask(task, false, stdout);
}

async function mutateWithStoppedSupervisor(
  store: OpsWorkerTaskStore,
  deps: ReturnType<typeof dependencies>,
  mutate: (supervisor: OpsWorkerSupervisor) => OpsWorkerTask,
): Promise<OpsWorkerTask> {
  const supervisor = createSupervisor(store, deps);
  await supervisor.start();
  try {
    return mutate(supervisor);
  } finally {
    supervisor.close();
  }
}

function validateSchedulerPollMs(value: number | undefined): number {
  const result = value ?? 250;
  if (!Number.isSafeInteger(result) || result < 10 || result > 60_000) {
    throw new TypeError("schedulerPollMs must be an integer between 10 and 60000");
  }
  return result;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveDelay();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function installProcessAbortSignal(): {
  signal: AbortSignal;
  close(): void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  return {
    signal: controller.signal,
    close(): void {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    },
  };
}

async function runStart(
  parsed: ParsedWorkerOptions,
  cliOptions: RunOpsWorkerCliOptions,
  deps: ReturnType<typeof dependencies>,
): Promise<number> {
  const directory = stateDirectory(parsed, cliOptions.cwd);
  const workspace = resolveCliPath(requiredValue(parsed, "agent-workspace"), cliOptions.cwd);
  const host = parsed.values.get("host") ?? DEFAULT_OPS_WORKER_STATUS_HOST;
  const port = parsePort(parsed.values.get("port"));
  const store = createStore(directory, deps);
  const supervisor = createSupervisor(store, deps);
  let started = false;
  let statusServer: Awaited<ReturnType<typeof startOpsWorkerStatusServer>> | undefined;
  let processAbort: ReturnType<typeof installProcessAbortSignal> | undefined;
  try {
    await supervisor.start();
    started = true;
    statusServer = await startOpsWorkerStatusServer({ supervisor, host, port });
    processAbort = deps.abortSignal ? undefined : installProcessAbortSignal();
    const signal = deps.abortSignal ?? processAbort?.signal;
    if (!signal) throw new Error("Ops-worker abort signal was not initialized");
    const runner = new OpsWorkerPiAttemptRunner({
      supervisor,
      workspaceCwd: workspace,
      authorizationProfiles: deps.taskRegistry.authorizationProfiles,
      abortSignal: signal,
      dependencies: deps.piAttemptDependencies,
    });
    writeLine(
      cliOptions.stdout,
    `Ops worker started; status http://${statusServer.host.includes(":") ? `[${statusServer.host}]` : statusServer.host}:${statusServer.port}/status`,
    );
    if (parsed.flags.has("once")) {
      const result = await runner.runNext();
      writeLine(
        cliOptions.stdout,
        result ? `Processed ${result.id}: ${result.state}` : "No eligible ops-worker task.",
      );
      return 0;
    }
    const pollMs = validateSchedulerPollMs(deps.schedulerPollMs);
    while (!signal.aborted) {
      const result = await runner.runNext();
      if (!result) await abortableDelay(pollMs, signal);
    }
    return 0;
  } finally {
    processAbort?.close();
    await statusServer?.close();
    if (started) supervisor.close();
  }
}

export async function runOpsWorkerCliCommand(
  action: string | undefined,
  args: readonly string[],
  cliOptions: RunOpsWorkerCliOptions,
): Promise<number> {
  try {
    if (!action || !Object.prototype.hasOwnProperty.call(WORKER_ACTION_OPTIONS, action)) {
      throw new OpsWorkerCliUsageError(
        `unknown worker command: ${action ?? ""}`.trimEnd(),
      );
    }
    const parsed = parseWorkerOptions(action, args);
    const deps = dependencies(cliOptions);
    if (action === "start") return await runStart(parsed, cliOptions, deps);

    const store = createStore(stateDirectory(parsed, cliOptions.cwd), deps);
    const json = parsed.flags.has("json");
    if (action === "status") {
      const summary = taskSummary(store.list());
      if (json) writeJson(cliOptions.stdout, summary);
      else {
        writeLine(cliOptions.stdout, `Tasks: ${summary.totalTasks}`);
        writeLine(cliOptions.stdout, `Active process groups: ${summary.activeProcessGroups}`);
        for (const state of OPS_WORKER_TASK_STATES) {
          writeLine(cliOptions.stdout, `${state}: ${summary.states[state]}`);
        }
      }
      return 0;
    }
    if (action === "list") {
      printTaskList(store.list(), json, cliOptions.stdout);
      return 0;
    }
    if (action === "inspect") {
      const id = requiredValue(parsed, "id");
      const task = store.get(id);
      if (!task) throw new Error(`Unknown ops-worker task ${id}`);
      printTask(task, json, cliOptions.stdout);
      return 0;
    }
    if (action === "submit") {
      const task = createTask(parsed, deps);
      store.create(task, { event: "CREATED", summary: "Submitted through local CLI" });
      printTask(task, json, cliOptions.stdout);
      return 0;
    }
    if (action === "retry") {
      const id = requiredValue(parsed, "id");
      const task = await mutateWithStoppedSupervisor(
        store,
        deps,
        (supervisor) => supervisor.retryBlockedTask(id),
      );
      printTask(task, json, cliOptions.stdout);
      return 0;
    }
    const id = requiredValue(parsed, "id");
    const reason = requiredValue(parsed, "reason");
    const task = await mutateWithStoppedSupervisor(
      store,
      deps,
      (supervisor) => supervisor.cancelTask(id, reason),
    );
    printTask(task, json, cliOptions.stdout);
    return 0;
  } catch (error) {
    writeLine(cliOptions.stderr, `Error: ${(error as Error).message}`);
    return error instanceof OpsWorkerCliUsageError
      || error instanceof OpsWorkerTaskValidationError
      ? 2
      : 1;
  }
}
