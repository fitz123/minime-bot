import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  OpsWorkerDoneCheckExecutionError,
  type OpsWorkerDoneCheckRegistry,
  type OpsWorkerDoneCheckResult,
} from "./done-checks.js";
import { OpsWorkerTaskStore } from "./task-store.js";
import {
  OPS_WORKER_LIMITS,
  type OpsWorkerActiveRun,
  type OpsWorkerEvidence,
  type OpsWorkerLastOutcome,
  type OpsWorkerOutcomeResult,
  type OpsWorkerTask,
  type OpsWorkerTaskState,
  type OpsWorkerUnverifiedRun,
} from "./types.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SUPERVISOR_LOCK_SCHEMA_VERSION = 1 as const;
const SUPERVISOR_LOCK_FILE_NAME = "supervisor.lock";
const MAX_SUPERVISOR_LOCK_BYTES = 4 * 1024;
const MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES = 1_000;
const INSTANCE_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const ALLOWED_STATE_TRANSITIONS: Readonly<
  Record<OpsWorkerTaskState, readonly OpsWorkerTaskState[]>
> = {
  QUEUED: ["RUNNING", "CHECKING", "RESUMABLE", "BLOCKED", "CANCELLED"],
  RUNNING: ["CHECKING", "RESUMABLE", "BLOCKED"],
  CHECKING: ["CHECKING", "RESUMABLE", "BLOCKED", "DONE", "CANCELLED"],
  RESUMABLE: ["RUNNING", "CHECKING", "RESUMABLE", "BLOCKED", "CANCELLED"],
  BLOCKED: ["RUNNING", "CHECKING", "BLOCKED", "RESUMABLE", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

export type OpsWorkerScheduledAction = "RUN" | "CHECK";

export interface OpsWorkerScheduledTask {
  action: OpsWorkerScheduledAction;
  task: OpsWorkerTask;
}

export type OpsWorkerLockOwnerStatus = "ACTIVE" | "STALE" | "AMBIGUOUS";

export interface OpsWorkerSupervisorLockRecord {
  schemaVersion: typeof SUPERVISOR_LOCK_SCHEMA_VERSION;
  instanceId: string;
  pid: number;
  processStartToken: string;
  startedAt: string;
}

export type OpsWorkerStartupRunStatus = "GONE" | "STOPPED" | "AMBIGUOUS";

export interface OpsWorkerStartupRunResult {
  status: OpsWorkerStartupRunStatus;
  summary?: string;
}

export interface OpsWorkerStartupReconciliation {
  taskId: string;
  state: "RESUMABLE" | "BLOCKED";
  result: "CRASH" | "AMBIGUOUS_ORPHAN";
}

export interface OpsWorkerSupervisorOptions {
  store: OpsWorkerTaskStore;
  doneChecks: OpsWorkerDoneCheckRegistry;
  instanceId: string;
  processStartToken: string;
  now?: () => Date;
  infrastructureRetryMs?: number;
  /**
   * Trusted host identity inspection. Without it, an existing lock is
   * ambiguous and is never removed merely because its PID looks reusable.
   */
  inspectLockOwner?: (
    owner: OpsWorkerSupervisorLockRecord,
  ) => OpsWorkerLockOwnerStatus;
  /** Task 3 supplies process-group ownership reconciliation. */
  reconcileActiveRun?: (
    task: OpsWorkerTask,
  ) => OpsWorkerStartupRunResult | Promise<OpsWorkerStartupRunResult>;
  /** Test-only crash-boundary hook. Production callers should leave this unset. */
  lockFaultInjector?: (point: "after-temp-file-fsync") => void;
}

export class OpsWorkerSupervisorStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsWorkerSupervisorStateError";
  }
}

export class OpsWorkerSupervisorAlreadyRunningError extends Error {
  readonly owner: OpsWorkerSupervisorLockRecord | undefined;

  constructor(
    message: string,
    owner?: OpsWorkerSupervisorLockRecord,
  ) {
    super(message);
    this.name = "OpsWorkerSupervisorAlreadyRunningError";
    this.owner = owner;
  }
}

export class OpsWorkerStaleCheckResultError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} changed while its done check was running`);
    this.name = "OpsWorkerStaleCheckResultError";
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isAlreadyExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function assertRegularOwnedFile(path: string): Stats {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new OpsWorkerSupervisorAlreadyRunningError(
      `Refusing unsafe supervisor lock at ${path}`,
    );
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new OpsWorkerSupervisorAlreadyRunningError(
      `Refusing supervisor lock owned by uid ${stats.uid}`,
    );
  }
  if (stats.size > MAX_SUPERVISOR_LOCK_BYTES) {
    throw new OpsWorkerSupervisorAlreadyRunningError(
      "Refusing oversized supervisor lock",
    );
  }
  return stats;
}

function readSupervisorLock(path: string): {
  stats: Stats;
  raw: string;
  owner: OpsWorkerSupervisorLockRecord;
} {
  const beforeOpen = assertRegularOwnedFile(path);
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile()
      || stats.ino !== beforeOpen.ino
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
      || stats.size > MAX_SUPERVISOR_LOCK_BYTES
    ) {
      throw new OpsWorkerSupervisorAlreadyRunningError(
        "Supervisor lock changed during safe open",
      );
    }
    const raw = readFileSync(descriptor, "utf8");
    return { stats, raw, owner: parseLockRecord(raw) };
  } finally {
    closeSync(descriptor);
  }
}

function assertIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || !INSTANCE_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} contains unsafe characters`);
  }
}

function parseLockRecord(raw: string): OpsWorkerSupervisorLockRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new OpsWorkerSupervisorAlreadyRunningError(
      "Existing supervisor lock is malformed and therefore ambiguous",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsWorkerSupervisorAlreadyRunningError(
      "Existing supervisor lock is malformed and therefore ambiguous",
    );
  }
  const record = value as Record<string, unknown>;
  const expected = [
    "schemaVersion",
    "instanceId",
    "pid",
    "processStartToken",
    "startedAt",
  ];
  if (
    Object.keys(record).length !== expected.length
    || expected.some((key) => !hasOwn(record, key))
    || Object.keys(record).some((key) => !expected.includes(key))
    || record.schemaVersion !== SUPERVISOR_LOCK_SCHEMA_VERSION
    || typeof record.instanceId !== "string"
    || !INSTANCE_ID_PATTERN.test(record.instanceId)
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || (record.pid as number) > 2_147_483_647
    || typeof record.processStartToken !== "string"
    || !INSTANCE_ID_PATTERN.test(record.processStartToken)
    || typeof record.startedAt !== "string"
    || !TIMESTAMP_PATTERN.test(record.startedAt)
    || Number.isNaN(Date.parse(record.startedAt))
  ) {
    throw new OpsWorkerSupervisorAlreadyRunningError(
      "Existing supervisor lock is malformed and therefore ambiguous",
    );
  }
  return {
    schemaVersion: SUPERVISOR_LOCK_SCHEMA_VERSION,
    instanceId: record.instanceId,
    pid: record.pid as number,
    processStartToken: record.processStartToken,
    startedAt: record.startedAt,
  };
}

class OpsWorkerSingleInstanceGuard {
  private readonly path: string;
  private readonly record: OpsWorkerSupervisorLockRecord;
  private readonly inspectOwner:
    | ((owner: OpsWorkerSupervisorLockRecord) => OpsWorkerLockOwnerStatus)
    | undefined;
  private readonly faultInjector: ((point: "after-temp-file-fsync") => void) | undefined;
  private acquiredInode: bigint | number | undefined;

  constructor(
    stateDirectory: string,
    record: OpsWorkerSupervisorLockRecord,
    inspectOwner:
      | ((owner: OpsWorkerSupervisorLockRecord) => OpsWorkerLockOwnerStatus)
      | undefined,
    faultInjector: ((point: "after-temp-file-fsync") => void) | undefined,
  ) {
    this.path = join(stateDirectory, SUPERVISOR_LOCK_FILE_NAME);
    this.record = record;
    this.inspectOwner = inspectOwner;
    this.faultInjector = faultInjector;
  }

  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.publishCompleteRecord()) return;

      const existing = readSupervisorLock(this.path);
      const existingStats = existing.stats;
      const ownerRaw = existing.raw;
      const owner = existing.owner;
      const status = this.inspectOwner?.(owner) ?? "AMBIGUOUS";
      if (status !== "STALE") {
        throw new OpsWorkerSupervisorAlreadyRunningError(
          status === "ACTIVE"
            ? `Ops worker supervisor ${owner.instanceId} is already running`
            : "Existing supervisor ownership is ambiguous",
          owner,
        );
      }
      const rechecked = readSupervisorLock(this.path);
      if (
        rechecked.stats.ino !== existingStats.ino
        || rechecked.raw !== ownerRaw
      ) {
        throw new OpsWorkerSupervisorAlreadyRunningError(
          "Supervisor lock changed during stale-owner inspection",
          owner,
        );
      }
      unlinkSync(this.path);
    }
    throw new OpsWorkerSupervisorAlreadyRunningError(
      "Could not acquire the supervisor lock",
    );
  }

  private publishCompleteRecord(): boolean {
    const nonce = randomBytes(8).toString("hex");
    const temporaryPath = `${this.path}.${process.pid}.${nonce}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      writeFileSync(descriptor, `${JSON.stringify(this.record)}\n`, "utf8");
      fsyncSync(descriptor);
      this.faultInjector?.("after-temp-file-fsync");
      const inode = fstatSync(descriptor).ino;
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporaryPath, this.path);
      } catch (error) {
        if (isAlreadyExistsError(error)) return false;
        throw error;
      }
      this.acquiredInode = inode;
      return true;
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (!isMissingError(error)) {
          // A leftover private hard link does not affect canonical lock ownership.
        }
      }
    }
  }

  release(): void {
    if (this.acquiredInode === undefined) return;
    try {
      const current = readSupervisorLock(this.path);
      const stats = current.stats;
      const owner = current.owner;
      if (
        stats.ino !== this.acquiredInode
        || owner.instanceId !== this.record.instanceId
        || owner.processStartToken !== this.record.processStartToken
      ) {
        throw new OpsWorkerSupervisorStateError(
          "Refusing to remove a supervisor lock whose ownership changed",
        );
      }
      unlinkSync(this.path);
      this.acquiredInode = undefined;
    } catch (error) {
      if (isMissingError(error)) {
        this.acquiredInode = undefined;
        return;
      }
      throw error;
    }
  }
}

function assertStructuralStateTransition(
  from: OpsWorkerTaskState,
  to: OpsWorkerTaskState,
): void {
  if (!ALLOWED_STATE_TRANSITIONS[from].includes(to)) {
    throw new OpsWorkerSupervisorStateError(
      `Illegal ops-worker transition ${from} -> ${to}`,
    );
  }
}

function appendEvidence(
  task: OpsWorkerTask,
  evidence: OpsWorkerEvidence,
): void {
  task.evidence = [...task.evidence, evidence].slice(
    -OPS_WORKER_LIMITS.maxEvidenceEntries,
  );
}

export function isOpsWorkerUnresolvedOrphan(task: OpsWorkerTask): boolean {
  return task.state === "BLOCKED"
    && task.lastOutcome?.result === "AMBIGUOUS_ORPHAN";
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > maxBytes) break;
    result += character;
  }
  return result;
}

export class OpsWorkerSupervisor {
  private readonly store: OpsWorkerTaskStore;
  private readonly doneChecks: OpsWorkerDoneCheckRegistry;
  private readonly instanceId: string;
  private readonly now: () => Date;
  private readonly infrastructureRetryMs: number;
  private readonly reconcileActiveRun:
    | ((task: OpsWorkerTask) => OpsWorkerStartupRunResult | Promise<OpsWorkerStartupRunResult>)
    | undefined;
  private readonly guard: OpsWorkerSingleInstanceGuard;
  private started = false;
  private piLaunchReservation: string | null = null;

  constructor(options: OpsWorkerSupervisorOptions) {
    assertIdentifier(options.instanceId, "Supervisor instance id");
    const processStartToken = options.processStartToken;
    assertIdentifier(processStartToken, "Supervisor process start token");
    const infrastructureRetryMs = options.infrastructureRetryMs ?? 60_000;
    if (
      !Number.isSafeInteger(infrastructureRetryMs)
      || infrastructureRetryMs < 1
      || infrastructureRetryMs > 24 * 60 * 60 * 1_000
    ) {
      throw new TypeError(
        "infrastructureRetryMs must be an integer between 1 and 86400000",
      );
    }
    this.store = options.store;
    this.doneChecks = options.doneChecks;
    this.instanceId = options.instanceId;
    this.now = options.now ?? (() => new Date());
    this.infrastructureRetryMs = infrastructureRetryMs;
    this.reconcileActiveRun = options.reconcileActiveRun;
    const startedAt = this.now().toISOString();
    this.guard = new OpsWorkerSingleInstanceGuard(
      this.store.stateDirectory,
      {
        schemaVersion: SUPERVISOR_LOCK_SCHEMA_VERSION,
        instanceId: options.instanceId,
        pid: process.pid,
        processStartToken,
        startedAt,
      },
      options.inspectLockOwner,
      options.lockFaultInjector,
    );
  }

  async start(): Promise<OpsWorkerStartupReconciliation[]> {
    if (this.started) {
      throw new OpsWorkerSupervisorStateError("Supervisor is already started");
    }
    this.guard.acquire();
    this.started = true;
    try {
      return await this.reconcileStartup();
    } catch (error) {
      this.started = false;
      this.guard.release();
      throw error;
    }
  }

  close(): void {
    if (!this.started) return;
    if (this.piLaunchReservation !== null) {
      throw new OpsWorkerSupervisorStateError(
        `Cannot close supervisor while task ${this.piLaunchReservation} owns the Pi launch slot`,
      );
    }
    this.guard.release();
    this.started = false;
  }

  listTasks(): OpsWorkerTask[] {
    this.assertStarted();
    return this.store.list();
  }

  getTask(taskId: string): OpsWorkerTask | undefined {
    this.assertStarted();
    return this.store.get(taskId);
  }

  get stateDirectory(): string {
    return this.store.stateDirectory;
  }

  get supervisorInstanceId(): string {
    return this.instanceId;
  }

  reservePiProcessGroupLaunch(taskId: string): void {
    this.assertStarted();
    this.requireTask(taskId);
    if (this.piLaunchReservation !== null) {
      throw new OpsWorkerSupervisorStateError(
        `Pi launch slot is already reserved by task ${this.piLaunchReservation}`,
      );
    }
    if (
      this.store.list().some((task) =>
        task.state === "RUNNING" || isOpsWorkerUnresolvedOrphan(task))
    ) {
      throw new OpsWorkerSupervisorStateError(
        "A supervisor may own at most one active or unresolved process group",
      );
    }
    this.piLaunchReservation = taskId;
  }

  releasePiProcessGroupLaunch(taskId: string): void {
    if (this.piLaunchReservation !== taskId) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} does not own the Pi launch slot`,
      );
    }
    this.piLaunchReservation = null;
  }

  preparePiSession(
    taskId: string,
    sessionId: string,
    resume: boolean,
  ): OpsWorkerTask {
    this.assertStarted();
    assertIdentifier(sessionId, "Pi session id");
    const existing = this.requireTask(taskId);
    if (existing.state !== "QUEUED" && existing.state !== "RESUMABLE") {
      throw new OpsWorkerSupervisorStateError(
        `Pi session preparation requires QUEUED or RESUMABLE, found ${existing.state}`,
      );
    }
    const replacement = structuredClone(existing);
    replacement.updatedAt = this.nextUpdatedAt(existing);
    replacement.session.sessionId = sessionId;
    replacement.session.resume = resume;
    this.store.replace(replacement, {
      event: "UPDATED",
      summary: resume
        ? "Prepared standard Pi session continuation"
        : "Prepared new standard Pi session",
    });
    return this.requireTask(taskId);
  }

  selectNextTask(): OpsWorkerScheduledTask | undefined {
    this.assertStarted();
    const tasks = this.store.list();
    if (
      tasks.some((task) =>
        task.state === "RUNNING" || isOpsWorkerUnresolvedOrphan(task))
    ) return undefined;
    const now = this.now().getTime();
    const candidates = tasks.flatMap((task): OpsWorkerScheduledTask[] => {
      if (task.state === "CHECKING") {
        if (
          task.schedule.nextCheckAt !== null
          && Date.parse(task.schedule.nextCheckAt) > now
        ) return [];
        return [{ action: "CHECK", task }];
      }
      if (task.state === "QUEUED" || task.state === "RESUMABLE") {
        if (
          task.schedule.nextRunAt !== null
          && Date.parse(task.schedule.nextRunAt) > now
        ) return [];
        return [{ action: "RUN", task }];
      }
      return [];
    });
    candidates.sort((left, right) =>
      left.task.priority - right.task.priority
      || Date.parse(left.task.createdAt) - Date.parse(right.task.createdAt)
      || (left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : 0));
    return candidates[0];
  }

  beginPiLaunch(
    taskId: string,
    launchIntent: OpsWorkerUnverifiedRun,
  ): OpsWorkerTask {
    this.assertStarted();
    const task = this.requireTask(taskId);
    if (task.state !== "QUEUED" && task.state !== "RESUMABLE") {
      throw new OpsWorkerSupervisorStateError(
        `Pi launch intent requires QUEUED or RESUMABLE, found ${task.state}`,
      );
    }
    if (launchIntent.supervisorInstanceId !== this.instanceId) {
      throw new OpsWorkerSupervisorStateError(
        "Pi launch intent must belong to this supervisor instance",
      );
    }
    if (launchIntent.pid !== null || launchIntent.expectedProcessGroupId !== null) {
      throw new OpsWorkerSupervisorStateError(
        "Pi launch intent must be persisted before a child PID is known",
      );
    }
    return this.transition(taskId, "BLOCKED", (replacement, at) => {
      replacement.activeRun = null;
      replacement.unverifiedRun = structuredClone(launchIntent);
      replacement.schedule.nextRunAt = null;
      replacement.schedule.nextCheckAt = null;
      replacement.lastOutcome = {
        at,
        kind: "RECONCILIATION",
        result: "AMBIGUOUS_ORPHAN",
        summary: "Persisted Pi launch intent before detached spawn",
      };
      replacement.report.state = "PENDING";
      replacement.report.lastError = null;
    }, "Persisted Pi launch intent before detached spawn");
  }

  bindUnverifiedPiLaunch(
    taskId: string,
    unverifiedRun: OpsWorkerUnverifiedRun,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    const intent = existing.unverifiedRun;
    if (
      existing.state !== "BLOCKED"
      || intent === null
      || intent.pid !== null
      || intent.attemptId !== unverifiedRun.attemptId
      || intent.supervisorInstanceId !== unverifiedRun.supervisorInstanceId
      || intent.launchedAt !== unverifiedRun.launchedAt
      || intent.ownershipNonceHash !== unverifiedRun.ownershipNonceHash
      || unverifiedRun.pid === null
      || unverifiedRun.expectedProcessGroupId !== unverifiedRun.pid
    ) {
      throw new OpsWorkerSupervisorStateError(
        "Detached Pi PID does not match the persisted launch intent",
      );
    }
    const replacement = structuredClone(existing);
    replacement.updatedAt = this.nextUpdatedAt(existing);
    replacement.unverifiedRun = structuredClone(unverifiedRun);
    if (replacement.lastOutcome) {
      replacement.lastOutcome.summary = "Bound detached Pi PID to the durable launch fence";
    }
    this.store.replace(replacement, {
      event: "RECONCILIATION",
      summary: "Bound detached Pi PID to the durable launch fence",
    });
    return this.requireTask(taskId);
  }

  markRunning(taskId: string, activeRun: OpsWorkerActiveRun): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (activeRun.supervisorInstanceId !== this.instanceId) {
      throw new OpsWorkerSupervisorStateError(
        "Active run must belong to this supervisor instance",
      );
    }
    if (existing.state === "BLOCKED") {
      const fence = existing.unverifiedRun;
      if (
        fence === null
        || fence.pid === null
        || fence.expectedProcessGroupId === null
        || fence.attemptId !== activeRun.attemptId
        || fence.supervisorInstanceId !== activeRun.supervisorInstanceId
        || fence.pid !== activeRun.pid
        || fence.expectedProcessGroupId !== activeRun.processGroupId
      ) {
        throw new OpsWorkerSupervisorStateError(
          "RUNNING identity does not match the durable Pi launch fence",
        );
      }
    } else if (existing.state !== "QUEUED" && existing.state !== "RESUMABLE") {
      throw new OpsWorkerSupervisorStateError(
        `Starting an attempt requires QUEUED, RESUMABLE, or a matching launch fence; found ${existing.state}`,
      );
    }
    if (
      this.store.list().some((task) =>
        task.id !== taskId
        && (task.state === "RUNNING" || isOpsWorkerUnresolvedOrphan(task)))
    ) {
      throw new OpsWorkerSupervisorStateError(
        "A supervisor may own at most one active or unresolved process group",
      );
    }
    return this.transition(taskId, "RUNNING", (task) => {
      task.activeRun = structuredClone(activeRun);
      task.unverifiedRun = null;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.lastOutcome = null;
      task.report.state = "NONE";
      task.report.attempts = 0;
      task.report.lastError = null;
    }, "Started one supervisor-owned attempt");
  }

  requestDoneCheck(taskId: string): OpsWorkerTask {
    this.assertStarted();
    const task = this.requireTask(taskId);
    if (task.state !== "QUEUED" && task.state !== "RESUMABLE") {
      throw new OpsWorkerSupervisorStateError(
        `Direct done-check request requires QUEUED or RESUMABLE, found ${task.state}`,
      );
    }
    return this.transition(taskId, "CHECKING", (replacement) => {
      replacement.activeRun = null;
      replacement.schedule.nextRunAt = null;
      replacement.schedule.nextCheckAt = null;
    }, "Queued deterministic done check");
  }

  recordPiSuccessClaim(
    taskId: string,
    summary: string,
    evidenceSummary?: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const task = this.requireTask(taskId);
    if (task.state !== "RUNNING") {
      throw new OpsWorkerSupervisorStateError(
        `Pi success claim requires RUNNING, found ${task.state}`,
      );
    }
    return this.transition(taskId, "CHECKING", (replacement, at) => {
      replacement.activeRun = null;
      replacement.session.resume = true;
      replacement.rounds.consecutiveInfrastructureFailures = 0;
      replacement.schedule.nextRunAt = null;
      replacement.schedule.nextCheckAt = null;
      replacement.lastOutcome = {
        at,
        kind: "PI_EXIT",
        result: "SUCCESS_CLAIM",
        summary,
      };
      if (evidenceSummary) {
        appendEvidence(replacement, this.piEvidence(at, evidenceSummary));
      }
    }, "Pi claim queued deterministic done check");
  }

  recordResumableInfrastructureOutcome(
    taskId: string,
    result: Extract<
      OpsWorkerOutcomeResult,
      "ERROR" | "QUOTA" | "NETWORK" | "CONTEXT_OVERFLOW" | "CRASH" | "STALL"
    >,
    summary: string,
    nextRunAt?: string,
    evidenceSummary?: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    const target = this.infrastructureFailureTarget(existing);
    return this.transition(taskId, target, (task, at) => {
      task.activeRun = null;
      task.session.resume = true;
      this.incrementInfrastructureFailures(task);
      task.schedule.nextCheckAt = null;
      task.schedule.nextRunAt = nextRunAt
        ?? new Date(this.now().getTime() + this.infrastructureRetryMs).toISOString();
      task.lastOutcome = {
        at,
        kind: "INFRASTRUCTURE",
        result,
        summary,
      };
      if (evidenceSummary) {
        appendEvidence(task, this.piEvidence(at, evidenceSummary));
      }
    }, target === "BLOCKED"
      ? `Blocked after bounded infrastructure failures (${result})`
      : `Recorded resumable infrastructure outcome ${result}`);
  }

  recordPreLaunchInfrastructureOutcome(
    taskId: string,
    summary: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (existing.state !== "QUEUED" && existing.state !== "RESUMABLE") {
      throw new OpsWorkerSupervisorStateError(
        `Pre-launch failure requires QUEUED or RESUMABLE, found ${existing.state}`,
      );
    }
    const target = this.infrastructureFailureTarget(existing);
    return this.transition(taskId, target, (task, at) => {
      task.activeRun = null;
      this.incrementInfrastructureFailures(task);
      task.schedule.nextCheckAt = null;
      task.schedule.nextRunAt = new Date(
        this.now().getTime() + this.infrastructureRetryMs,
      ).toISOString();
      task.lastOutcome = {
        at,
        kind: "INFRASTRUCTURE",
        result: "CRASH",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
    }, target === "BLOCKED"
      ? "Blocked after bounded Pi launch failures"
      : "Recorded Pi attempt launch failure");
  }

  recordResolvedPiLaunchFailure(
    taskId: string,
    attemptId: string,
    summary: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireMatchingLaunchFence(taskId, attemptId);
    const target = this.infrastructureFailureTarget(existing);
    return this.transition(taskId, target, (task, at) => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.report.state = "NONE";
      task.report.attempts = 0;
      task.report.lastError = null;
      this.incrementInfrastructureFailures(task);
      task.schedule.nextCheckAt = null;
      task.schedule.nextRunAt = new Date(
        this.now().getTime() + this.infrastructureRetryMs,
      ).toISOString();
      task.lastOutcome = {
        at,
        kind: "INFRASTRUCTURE",
        result: "CRASH",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
    }, target === "BLOCKED"
      ? "Blocked after bounded resolved Pi launch failures"
      : "Cleared resolved Pi launch fence after launch failure");
  }

  recordResolvedPiLaunchSuccessClaim(
    taskId: string,
    attemptId: string,
    summary: string,
    evidenceSummary?: string,
  ): OpsWorkerTask {
    this.assertStarted();
    this.requireMatchingLaunchFence(taskId, attemptId);
    return this.transition(taskId, "CHECKING", (task, at) => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.session.resume = true;
      task.rounds.consecutiveInfrastructureFailures = 0;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.report.state = "NONE";
      task.report.attempts = 0;
      task.report.lastError = null;
      task.lastOutcome = {
        at,
        kind: "PI_EXIT",
        result: "SUCCESS_CLAIM",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
      if (evidenceSummary) {
        appendEvidence(task, this.piEvidence(at, evidenceSummary));
      }
    }, "Resolved short-lived Pi success claim and queued deterministic done check");
  }

  recordResolvedPiLaunchOutcome(
    taskId: string,
    attemptId: string,
    result: Extract<
      OpsWorkerOutcomeResult,
      "QUOTA" | "NETWORK" | "CONTEXT_OVERFLOW" | "CRASH"
    >,
    summary: string,
    evidenceSummary?: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireMatchingLaunchFence(taskId, attemptId);
    const target = this.infrastructureFailureTarget(existing);
    return this.transition(taskId, target, (task, at) => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.session.resume = true;
      task.report.state = "NONE";
      task.report.attempts = 0;
      task.report.lastError = null;
      this.incrementInfrastructureFailures(task);
      task.schedule.nextCheckAt = null;
      task.schedule.nextRunAt = new Date(
        this.now().getTime() + this.infrastructureRetryMs,
      ).toISOString();
      task.lastOutcome = {
        at,
        kind: "INFRASTRUCTURE",
        result,
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
      if (evidenceSummary) {
        appendEvidence(task, this.piEvidence(at, evidenceSummary));
      }
    }, target === "BLOCKED"
      ? `Blocked after bounded resolved Pi outcomes (${result})`
      : `Recorded resolved short-lived Pi outcome ${result}`);
  }

  clearResolvedPiLaunchFence(
    taskId: string,
    attemptId: string,
    summary: string,
  ): OpsWorkerTask {
    this.assertStarted();
    this.requireMatchingLaunchFence(taskId, attemptId);
    return this.transition(taskId, "RESUMABLE", (task, at) => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.session.resume = true;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.report.state = "NONE";
      task.report.attempts = 0;
      task.report.lastError = null;
      task.lastOutcome = {
        at,
        kind: "RECONCILIATION",
        result: "CRASH",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
    }, "Cleared a resolved short-lived Pi launch fence");
  }

  recordPreemption(
    taskId: string,
    summary: string,
    evidenceSummary?: string,
  ): OpsWorkerTask {
    this.assertStarted();
    return this.transition(taskId, "RESUMABLE", (task, at) => {
      task.activeRun = null;
      task.session.resume = true;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.lastOutcome = {
        at,
        kind: "PREEMPTION",
        result: "PREEMPTED",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
      if (evidenceSummary) {
        appendEvidence(task, this.piEvidence(at, evidenceSummary));
      }
    }, "Preempted owned Pi process group for higher-priority work");
  }

  resetPiSession(
    taskId: string,
    newSessionId: string,
    summary: string,
  ): OpsWorkerTask {
    this.assertStarted();
    assertIdentifier(newSessionId, "Pi session id");
    const existing = this.requireTask(taskId);
    if (
      existing.state !== "QUEUED"
      && existing.state !== "RESUMABLE"
      && existing.state !== "RUNNING"
    ) {
      throw new OpsWorkerSupervisorStateError(
        `Pi session reset requires QUEUED, RESUMABLE, or RUNNING, found ${existing.state}`,
      );
    }
    const applyReset = (task: OpsWorkerTask, at: string): void => {
      task.activeRun = null;
      task.session.sessionId = newSessionId;
      task.session.resume = false;
      this.incrementInfrastructureFailures(task);
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      const boundedSummary = truncateUtf8(
        summary,
        OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
      );
      task.lastOutcome = {
        at,
        kind: "SESSION_RESET",
        result: "CRASH",
        summary: boundedSummary,
      };
      appendEvidence(task, {
        at,
        kind: "system",
        trust: "trusted",
        summary: truncateUtf8(
          boundedSummary,
          OPS_WORKER_LIMITS.maxEvidenceSummaryBytes,
        ),
        artifact: null,
      });
    };
    const target = this.infrastructureFailureTarget(existing);
    if (existing.state === "RUNNING" || target === "BLOCKED") {
      return this.transition(
        taskId,
        target,
        applyReset,
        "Quarantined corrupt standard Pi session and prepared a fresh session",
      );
    }
    const replacement = structuredClone(existing);
    replacement.updatedAt = this.nextUpdatedAt(existing);
    applyReset(replacement, replacement.updatedAt);
    this.store.replace(replacement, {
      event: "RECONCILIATION",
      summary: "Quarantined corrupt standard Pi session and prepared a fresh session",
    });
    return this.requireTask(taskId);
  }

  blockAmbiguousActiveRun(taskId: string, summary: string): OpsWorkerTask {
    this.assertStarted();
    const task = this.requireTask(taskId);
    if (task.state !== "RUNNING") {
      throw new OpsWorkerSupervisorStateError(
        `Ambiguous active run requires RUNNING, found ${task.state}`,
      );
    }
    return this.blockAmbiguousRun(taskId, summary);
  }

  blockUnverifiedPiLaunch(
    taskId: string,
    unverifiedRun: OpsWorkerUnverifiedRun,
    summary: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const task = this.requireTask(taskId);
    const priorFence = task.unverifiedRun;
    const matchesPersistedFence = task.state === "BLOCKED"
      && priorFence !== null
      && priorFence.attemptId === unverifiedRun.attemptId
      && priorFence.supervisorInstanceId === unverifiedRun.supervisorInstanceId
      && priorFence.launchedAt === unverifiedRun.launchedAt
      && priorFence.ownershipNonceHash === unverifiedRun.ownershipNonceHash
      && (
        priorFence.pid === null
          ? unverifiedRun.pid === null
            && unverifiedRun.expectedProcessGroupId === null
          : priorFence.pid === unverifiedRun.pid
            && priorFence.expectedProcessGroupId
              === unverifiedRun.expectedProcessGroupId
      );
    if (
      task.state !== "QUEUED"
      && task.state !== "RESUMABLE"
      && !matchesPersistedFence
    ) {
      throw new OpsWorkerSupervisorStateError(
        `Unverified Pi launch requires a runnable task or its matching launch fence, found ${task.state}`,
      );
    }
    return this.transition(taskId, "BLOCKED", (replacement, at) => {
      replacement.activeRun = null;
      replacement.unverifiedRun = structuredClone(unverifiedRun);
      replacement.schedule.nextRunAt = null;
      replacement.schedule.nextCheckAt = null;
      replacement.lastOutcome = {
        at,
        kind: "RECONCILIATION",
        result: "AMBIGUOUS_ORPHAN",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
      replacement.report.state = "PENDING";
      replacement.report.lastError = null;
    }, "Blocked Pi launch whose process-group identity could not be proven");
  }

  async runDoneCheck(taskId: string, signal?: AbortSignal): Promise<OpsWorkerTask> {
    this.assertStarted();
    const task = this.requireTask(taskId);
    if (task.state !== "CHECKING") {
      throw new OpsWorkerSupervisorStateError(
        `Done check requires CHECKING, found ${task.state}`,
      );
    }
    const checkedAt = this.now().toISOString();
    const baseline = JSON.stringify(task);
    let result: OpsWorkerDoneCheckResult;
    try {
      result = await this.doneChecks.run(task.doneCheck, {
        taskId: task.id,
        checkedAt,
      }, signal);
    } catch (error) {
      if (!(error instanceof OpsWorkerDoneCheckExecutionError)) throw error;
      this.assertFreshCheckSnapshot(taskId, baseline);
      const currentTask = this.requireTask(taskId);
      const target = currentTask.rounds.consecutiveInfrastructureFailures + 1
          >= MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES
        ? "BLOCKED"
        : "CHECKING";
      return this.transition(taskId, target, (current, at) => {
        current.activeRun = null;
        this.incrementInfrastructureFailures(current);
        current.schedule.nextCheckAt = target === "CHECKING"
          ? new Date(this.now().getTime() + this.infrastructureRetryMs).toISOString()
          : null;
        current.schedule.nextRunAt = null;
        current.lastOutcome = {
          at,
          kind: "DONE_CHECK",
          result: "ERROR",
          summary: `Done check could not establish an outcome (${error.code})`,
        };
        appendEvidence(current, {
          at,
          kind: "infrastructure",
          trust: "trusted",
          summary: `Done check deferred by infrastructure (${error.code})`,
          artifact: null,
        });
      }, target === "BLOCKED"
        ? "Done check reached the bounded infrastructure-failure limit"
        : "Done check error is resumable");
    }
    this.assertFreshCheckSnapshot(taskId, baseline);
    return this.applyDoneCheckResult(taskId, result);
  }

  retryBlockedTask(taskId: string): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (existing.state !== "BLOCKED") {
      throw new OpsWorkerSupervisorStateError(
        `Operator retry requires BLOCKED, found ${existing.state}`,
      );
    }
    if (isOpsWorkerUnresolvedOrphan(existing)) {
      throw new OpsWorkerSupervisorStateError(
        "Cannot retry a task while its prior process group remains unresolved",
      );
    }
    return this.transition(taskId, "RESUMABLE", (task) => {
      task.rounds.remediation = 0;
      task.rounds.consecutiveInfrastructureFailures = 0;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.report.state = "NONE";
      task.report.attempts = 0;
      task.report.lastError = null;
      task.lastOutcome = null;
    }, "Operator retried blocked task");
  }

  cancelTask(taskId: string, summary: string): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (existing.state === "RUNNING") {
      throw new OpsWorkerSupervisorStateError(
        "A running task must stop its proven process group before cancellation",
      );
    }
    if (isOpsWorkerUnresolvedOrphan(existing)) {
      throw new OpsWorkerSupervisorStateError(
        "Cannot cancel a task while its prior process group remains unresolved",
      );
    }
    return this.transition(taskId, "CANCELLED", (task, at) => {
      task.activeRun = null;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.lastOutcome = {
        at,
        kind: "OPERATOR",
        result: "CANCELLED",
        summary,
      };
      task.report.state = "PENDING";
      task.report.lastError = null;
    }, "Task cancelled");
  }

  recordReportAttempt(
    taskId: string,
    result: { sent: true } | { sent: false; error: string },
  ): OpsWorkerTask {
    this.assertStarted();
    const task = this.requireTask(taskId);
    if (task.report.state === "NONE") {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} has no pending report`,
      );
    }
    if (task.report.attempts >= 1_000) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} exhausted its bounded report-attempt counter`,
      );
    }
    const replacement = structuredClone(task);
    // updatedAt remains the DONE transition timestamp so the fresh PASS proof
    // is not rewritten by report-transport bookkeeping. The REPORT journal
    // entry supplies the mutation time for report attempts.
    replacement.report.attempts += 1;
    replacement.report.state = result.sent ? "SENT" : "PENDING";
    replacement.report.lastError = result.sent
      ? null
      : truncateUtf8(result.error, OPS_WORKER_LIMITS.maxReportErrorBytes);
    this.store.replace(replacement, {
      event: "REPORT",
      summary: result.sent ? "Report marked sent" : "Report attempt remains pending",
    });
    return this.requireTask(taskId);
  }

  private async reconcileStartup(): Promise<OpsWorkerStartupReconciliation[]> {
    const running = this.store.list().filter((task) =>
      task.state === "RUNNING"
      || (
        isOpsWorkerUnresolvedOrphan(task)
        && (task.activeRun !== null || task.unverifiedRun !== null)
      ));
    const reconciled: OpsWorkerStartupReconciliation[] = [];
    for (const task of running) {
      let result: OpsWorkerStartupRunResult = { status: "AMBIGUOUS" };
      try {
        result = this.reconcileActiveRun
          ? await this.reconcileActiveRun(task)
          : result;
      } catch {
        result = { status: "AMBIGUOUS" };
      }
      if (result.status === "GONE" || result.status === "STOPPED") {
        const target = this.infrastructureFailureTarget(task);
        this.transition(task.id, target, (replacement, at) => {
          replacement.activeRun = null;
          replacement.unverifiedRun = null;
          this.incrementInfrastructureFailures(replacement);
          replacement.schedule.nextRunAt = null;
          replacement.schedule.nextCheckAt = null;
          replacement.lastOutcome = {
            at,
            kind: "RECONCILIATION",
            result: "CRASH",
            summary: truncateUtf8(
              result.summary ?? "Prior owned attempt is no longer running",
              OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
            ),
          };
        }, "Reconciled interrupted attempt as resumable");
        reconciled.push({
          taskId: task.id,
          state: target,
          result: "CRASH",
        });
      } else {
        if (task.state === "RUNNING") {
          this.blockAmbiguousRun(
            task.id,
            result.summary ?? "Persisted process-group ownership is ambiguous",
          );
        }
        reconciled.push({
          taskId: task.id,
          state: "BLOCKED",
          result: "AMBIGUOUS_ORPHAN",
        });
      }
    }
    return reconciled;
  }

  private blockAmbiguousRun(taskId: string, summary: string): OpsWorkerTask {
    return this.transition(taskId, "BLOCKED", (task, at) => {
      task.unverifiedRun = null;
      task.session.resume = true;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.lastOutcome = {
        at,
        kind: "RECONCILIATION",
        result: "AMBIGUOUS_ORPHAN",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
      task.report.state = "PENDING";
      task.report.lastError = null;
    }, "Blocked ambiguous persisted process group");
  }

  private applyDoneCheckResult(
    taskId: string,
    result: OpsWorkerDoneCheckResult,
  ): OpsWorkerTask {
    if (result.result === "PASS") {
      return this.transition(taskId, "DONE", (task, at) => {
        this.resetAfterCheck(task);
        task.lastOutcome = this.checkOutcome(at, "PASS", result.summary);
        appendEvidence(task, this.checkEvidence(at, result.summary));
        task.report.state = "PENDING";
        task.report.lastError = null;
      }, "Fresh deterministic done check passed", true);
    }
    if (result.result === "DEFER") {
      return this.transition(taskId, "CHECKING", (task, at) => {
        task.activeRun = null;
        task.rounds.consecutiveInfrastructureFailures = 0;
        task.schedule.nextRunAt = null;
        task.schedule.nextCheckAt = result.nextCheckAt;
        task.lastOutcome = this.checkOutcome(at, "DEFER", result.summary);
        appendEvidence(task, this.checkEvidence(at, result.summary));
      }, "Done check deferred without spending remediation budget");
    }
    return this.transition(
      taskId,
      this.requireTask(taskId).rounds.remediation + 1
          >= this.requireTask(taskId).rounds.maxRemediation
        ? "BLOCKED"
        : "RESUMABLE",
      (task, at) => {
        task.activeRun = null;
        task.rounds.remediation += 1;
        task.rounds.consecutiveInfrastructureFailures = 0;
        task.schedule.nextRunAt = null;
        task.schedule.nextCheckAt = null;
        task.lastOutcome = this.checkOutcome(
          at,
          "ACTION_REQUIRED",
          result.summary,
        );
        appendEvidence(task, this.checkEvidence(at, result.summary));
        if (task.rounds.remediation >= task.rounds.maxRemediation) {
          task.report.state = "PENDING";
          task.report.lastError = null;
        }
      },
      "Done check requires another remediation round",
    );
  }

  private resetAfterCheck(task: OpsWorkerTask): void {
    task.activeRun = null;
    task.rounds.consecutiveInfrastructureFailures = 0;
    task.schedule.nextRunAt = null;
    task.schedule.nextCheckAt = null;
  }

  private infrastructureFailureTarget(
    task: OpsWorkerTask,
  ): "RESUMABLE" | "BLOCKED" {
    return task.rounds.consecutiveInfrastructureFailures + 1
        >= MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES
      ? "BLOCKED"
      : "RESUMABLE";
  }

  private incrementInfrastructureFailures(task: OpsWorkerTask): void {
    task.rounds.consecutiveInfrastructureFailures = Math.min(
      MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES,
      task.rounds.consecutiveInfrastructureFailures + 1,
    );
    if (
      task.rounds.consecutiveInfrastructureFailures
        >= MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES
    ) {
      task.report.state = "PENDING";
      task.report.lastError = null;
    }
  }

  private checkOutcome(
    at: string,
    result: Extract<OpsWorkerOutcomeResult, "PASS" | "ACTION_REQUIRED" | "DEFER">,
    summary: string,
  ): OpsWorkerLastOutcome {
    return { at, kind: "DONE_CHECK", result, summary };
  }

  private checkEvidence(at: string, summary: string): OpsWorkerEvidence {
    return {
      at,
      kind: "check",
      trust: "trusted",
      summary,
      artifact: null,
    };
  }

  private piEvidence(at: string, summary: string): OpsWorkerEvidence {
    return {
      at,
      kind: "pi",
      trust: "untrusted",
      summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxEvidenceSummaryBytes),
      artifact: null,
    };
  }

  private transition(
    taskId: string,
    to: OpsWorkerTaskState,
    mutate: (task: OpsWorkerTask, at: string) => void,
    auditSummary: string,
    freshDoneCheckPass = false,
  ): OpsWorkerTask {
    const existing = this.requireTask(taskId);
    if (to === "DONE" && !freshDoneCheckPass) {
      throw new OpsWorkerSupervisorStateError(
        "DONE is reserved for a fresh deterministic done-check PASS",
      );
    }
    assertStructuralStateTransition(existing.state, to);
    const replacement = structuredClone(existing);
    const updatedAt = this.nextUpdatedAt(existing);
    replacement.state = to;
    replacement.updatedAt = updatedAt;
    mutate(replacement, updatedAt);
    this.store.replace(replacement, {
      event: "TRANSITION",
      summary: auditSummary,
    });
    return this.requireTask(taskId);
  }

  private nextUpdatedAt(task: OpsWorkerTask): string {
    const now = this.now().getTime();
    return new Date(Math.max(now, Date.parse(task.updatedAt) + 1)).toISOString();
  }

  private assertFreshCheckSnapshot(taskId: string, baseline: string): void {
    if (JSON.stringify(this.requireTask(taskId)) !== baseline) {
      throw new OpsWorkerStaleCheckResultError(taskId);
    }
  }

  private requireTask(taskId: string): OpsWorkerTask {
    const task = this.store.get(taskId);
    if (!task) {
      throw new OpsWorkerSupervisorStateError(`Unknown ops-worker task ${taskId}`);
    }
    return task;
  }

  private requireMatchingLaunchFence(
    taskId: string,
    attemptId: string,
  ): OpsWorkerTask {
    const task = this.requireTask(taskId);
    if (
      task.state !== "BLOCKED"
      || task.unverifiedRun?.attemptId !== attemptId
      || task.unverifiedRun.supervisorInstanceId !== this.instanceId
    ) {
      throw new OpsWorkerSupervisorStateError(
        "Resolved Pi launch outcome must match this supervisor's durable launch fence",
      );
    }
    return task;
  }

  private assertStarted(): void {
    if (!this.started) {
      throw new OpsWorkerSupervisorStateError("Supervisor is not started");
    }
  }
}
