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
  hasFreshOpsWorkerAuthorizationPass,
  OpsWorkerAuthorizationCoordinator,
  type OpsWorkerAuthorizationVerifierRegistry,
} from "./authorization.js";
import {
  OpsWorkerDoneCheckExecutionError,
  type OpsWorkerDoneCheckContractIdentity,
  type OpsWorkerDoneCheckRegistry,
  type OpsWorkerDoneCheckResult,
} from "./done-checks.js";
import {
  hashOpsWorkerCanonicalPayload,
  OpsWorkerLifecycle,
} from "./lifecycle.js";
import { appendOpsWorkerEvidence } from "./evidence.js";
import {
  DEFAULT_OPS_WORKER_QUOTA_STALE_MS,
  DEFAULT_OPS_WORKER_QUOTA_RECHECK_MS,
  isAuthoritativeQuotaDecision,
  type OpsWorkerQuotaAdmissionDecision,
  type OpsWorkerQuotaAdmissionGate,
  type OpsWorkerQuotaResponseDecision,
} from "./quota.js";
import {
  OPS_WORKER_TASK_STORE_NO_CHANGE,
  OpsWorkerTaskStore,
} from "./task-store.js";
import {
  OPS_WORKER_LIMITS,
  OPS_WORKER_QUOTA_PROBE_PROOF_VERSION,
  hashOpsWorkerPiLaunchSubject,
  hashOpsWorkerVerificationSubject,
  isOpsWorkerTerminalState,
  isOpsWorkerUnclaimedQuotaProbeProcess,
  type OpsWorkerActiveRun,
  type OpsWorkerCustodyReleaseReason,
  type OpsWorkerEvidence,
  type OpsWorkerInterrupt,
  type OpsWorkerInterruptMode,
  type OpsWorkerLastOutcome,
  type OpsWorkerOutcomeResult,
  type OpsWorkerSteeringEntry,
  type OpsWorkerTask,
  type OpsWorkerTaskState,
  type OpsWorkerUnverifiedRun,
  type OpsWorkerVerificationRecord,
} from "./types.js";

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SUPERVISOR_LOCK_SCHEMA_VERSION = 1 as const;
const SUPERVISOR_LOCK_FILE_NAME = "supervisor.lock";
const SUPERVISOR_LOCK_RECOVERY_FILE_NAME = "supervisor.lock.recovery";
const MAX_SUPERVISOR_LOCK_BYTES = 4 * 1024;
const MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES = 1_000;
const INSTANCE_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

const ALLOWED_STATE_TRANSITIONS: Readonly<
  Record<OpsWorkerTaskState, readonly OpsWorkerTaskState[]>
> = {
  QUEUED: ["RUNNING", "CHECKING", "RESUMABLE", "BLOCKED", "CANCELLED"],
  RUNNING: ["CHECKING", "RESUMABLE", "BLOCKED", "CANCELLED"],
  CHECKING: ["CHECKING", "RESUMABLE", "BLOCKED", "DONE", "CANCELLED"],
  RESUMABLE: ["RUNNING", "CHECKING", "RESUMABLE", "BLOCKED", "CANCELLED"],
  BLOCKED: ["RUNNING", "CHECKING", "BLOCKED", "RESUMABLE", "CANCELLED"],
  DONE: [],
  CANCELLED: [],
};

export type OpsWorkerScheduledAction = "RUN" | "CHECK" | "QUOTA_PROBE" | "WAIT";

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
  state: "QUEUED" | "RESUMABLE" | "BLOCKED" | "CANCELLED";
  result:
    | "CRASH"
    | "QUOTA_PROBE_ERROR"
    | "AMBIGUOUS_ORPHAN"
    | "PREEMPTED"
    | "CANCELLED";
}

export interface OpsWorkerSupervisorOptions {
  store: OpsWorkerTaskStore;
  doneChecks: OpsWorkerDoneCheckRegistry;
  instanceId: string;
  processStartToken: string;
  now?: () => Date;
  infrastructureRetryMs?: number;
  authorizationQueryRetryMs?: number;
  authorizationVerifiers?: OpsWorkerAuthorizationVerifierRegistry;
  quotaAdmission?: OpsWorkerQuotaAdmissionGate;
  quotaRecheckMs?: number;
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
  lockFaultInjector?: (
    point: "after-temp-file-fsync" | "after-lock-publish-conflict",
  ) => void;
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
  private readonly recoveryPath: string;
  private readonly record: OpsWorkerSupervisorLockRecord;
  private readonly inspectOwner:
    | ((owner: OpsWorkerSupervisorLockRecord) => OpsWorkerLockOwnerStatus)
    | undefined;
  private readonly faultInjector: ((
    point: "after-temp-file-fsync" | "after-lock-publish-conflict",
  ) => void) | undefined;
  private acquiredInode: bigint | number | undefined;
  private recoveryInode: bigint | number | undefined;

  constructor(
    stateDirectory: string,
    record: OpsWorkerSupervisorLockRecord,
    inspectOwner:
      | ((owner: OpsWorkerSupervisorLockRecord) => OpsWorkerLockOwnerStatus)
      | undefined,
    faultInjector: ((
      point: "after-temp-file-fsync" | "after-lock-publish-conflict",
    ) => void) | undefined,
  ) {
    this.path = join(stateDirectory, SUPERVISOR_LOCK_FILE_NAME);
    this.recoveryPath = join(stateDirectory, SUPERVISOR_LOCK_RECOVERY_FILE_NAME);
    this.record = record;
    this.inspectOwner = inspectOwner;
    this.faultInjector = faultInjector;
  }

  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.assertNoRecoveryGuard();
      if (this.publishCompleteRecord()) return;

      let existing: ReturnType<typeof readSupervisorLock>;
      try {
        existing = readSupervisorLock(this.path);
      } catch (error) {
        if (isMissingError(error)) continue;
        throw error;
      }
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
      this.acquireRecoveryGuard();
      try {
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
        const recheckedStatus = this.inspectOwner?.(rechecked.owner) ?? "AMBIGUOUS";
        if (recheckedStatus !== "STALE") {
          throw new OpsWorkerSupervisorAlreadyRunningError(
            recheckedStatus === "ACTIVE"
              ? `Ops worker supervisor ${rechecked.owner.instanceId} is already running`
              : "Existing supervisor ownership is ambiguous",
            rechecked.owner,
          );
        }
        const confirmed = readSupervisorLock(this.path);
        if (
          confirmed.stats.ino !== rechecked.stats.ino
          || confirmed.raw !== rechecked.raw
        ) {
          throw new OpsWorkerSupervisorAlreadyRunningError(
            "Supervisor lock changed during stale-owner inspection",
            rechecked.owner,
          );
        }
        unlinkSync(this.path);
      } catch (error) {
        // A stale owner can finish cleanup before this contender completes its
        // guarded recheck. A missing canonical lock is safe to retry.
        if (!isMissingError(error)) throw error;
      } finally {
        this.releaseRecoveryGuard();
      }
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
        if (isAlreadyExistsError(error)) {
          this.faultInjector?.("after-lock-publish-conflict");
          return false;
        }
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

  private assertNoRecoveryGuard(): void {
    try {
      lstatSync(this.recoveryPath);
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
    throw new OpsWorkerSupervisorAlreadyRunningError(
      "Supervisor stale-lock recovery is already in progress",
    );
  }

  private acquireRecoveryGuard(): void {
    let descriptor: number;
    try {
      descriptor = openSync(
        this.recoveryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        throw new OpsWorkerSupervisorAlreadyRunningError(
          "Supervisor stale-lock recovery is already in progress",
        );
      }
      throw error;
    }
    try {
      writeFileSync(descriptor, `${JSON.stringify(this.record)}\n`, "utf8");
      fsyncSync(descriptor);
      this.recoveryInode = fstatSync(descriptor).ino;
    } finally {
      closeSync(descriptor);
    }
  }

  private releaseRecoveryGuard(): void {
    if (this.recoveryInode === undefined) return;
    const current = readSupervisorLock(this.recoveryPath);
    if (
      current.stats.ino !== this.recoveryInode
      || current.owner.instanceId !== this.record.instanceId
      || current.owner.processStartToken !== this.record.processStartToken
    ) {
      throw new OpsWorkerSupervisorStateError(
        "Refusing to remove a supervisor stale-lock recovery guard whose ownership changed",
      );
    }
    unlinkSync(this.recoveryPath);
    this.recoveryInode = undefined;
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

function hasPendingPromptSteering(task: OpsWorkerTask): boolean {
  return task.steering.some((entry) =>
    entry.consumedAt === null
    && (entry.kind === "correction" || entry.kind === "answer"));
}

export function isOpsWorkerUnresolvedOrphan(task: OpsWorkerTask): boolean {
  return task.state === "BLOCKED"
    && task.lastOutcome?.result === "AMBIGUOUS_ORPHAN";
}

export function isOpsWorkerQuotaWait(task: OpsWorkerTask): boolean {
  return task.lastOutcome?.result === "QUOTA"
    || task.lastOutcome?.result === "QUOTA_ADMISSION_WAIT"
    || task.lastOutcome?.result === "QUOTA_TELEMETRY_ERROR"
    || task.lastOutcome?.result === "QUOTA_PROBE_ERROR";
}

function isAuthoritativePersistedQuotaWait(task: OpsWorkerTask): boolean {
  return task.lastOutcome?.result === "QUOTA"
    || task.lastOutcome?.result === "QUOTA_ADMISSION_WAIT";
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

function timestampAtOrAfter(now: Date, floor: string): string {
  return new Date(Math.max(now.getTime(), Date.parse(floor))).toISOString();
}

export class OpsWorkerSupervisor {
  private readonly store: OpsWorkerTaskStore;
  private readonly doneChecks: OpsWorkerDoneCheckRegistry;
  private readonly instanceId: string;
  private readonly now: () => Date;
  private readonly infrastructureRetryMs: number;
  private readonly quotaAdmission: OpsWorkerQuotaAdmissionGate | undefined;
  private readonly quotaRecheckMs: number;
  private readonly reconcileActiveRun:
    | ((task: OpsWorkerTask) => OpsWorkerStartupRunResult | Promise<OpsWorkerStartupRunResult>)
    | undefined;
  private readonly guard: OpsWorkerSingleInstanceGuard;
  private readonly lifecycle: OpsWorkerLifecycle;
  private readonly authorization: OpsWorkerAuthorizationCoordinator;
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
    const quotaRecheckMs = options.quotaRecheckMs
      ?? DEFAULT_OPS_WORKER_QUOTA_RECHECK_MS;
    if (
      !Number.isSafeInteger(quotaRecheckMs)
      || quotaRecheckMs < 1
      || quotaRecheckMs > 24 * 60 * 60 * 1_000
    ) {
      throw new TypeError(
        "quotaRecheckMs must be an integer between 1 and 86400000",
      );
    }
    this.store = options.store;
    this.doneChecks = options.doneChecks;
    this.instanceId = options.instanceId;
    this.now = options.now ?? (() => new Date());
    this.infrastructureRetryMs = infrastructureRetryMs;
    this.quotaAdmission = options.quotaAdmission;
    this.quotaRecheckMs = quotaRecheckMs;
    this.reconcileActiveRun = options.reconcileActiveRun;
    this.authorization = new OpsWorkerAuthorizationCoordinator(this.store, {
      verifiers: options.authorizationVerifiers,
      now: this.now,
      queryRetryMs: options.authorizationQueryRetryMs,
    });
    this.lifecycle = new OpsWorkerLifecycle(this.store, {
      now: this.now,
      authorizeMutationClaim: (task, receipt) =>
        hasFreshOpsWorkerAuthorizationPass(task, receipt.queryObservedAt),
    });
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

  appendTaskSteering(taskId: string, entry: OpsWorkerSteeringEntry): OpsWorkerTask {
    this.assertStarted();
    return this.store.appendSteering(taskId, entry).task;
  }

  setTaskPaused(
    taskId: string,
    paused: boolean,
    steering?: OpsWorkerSteeringEntry,
  ): OpsWorkerTask {
    this.assertStarted();
    return steering === undefined
      ? this.store.setPaused(taskId, paused).task
      : this.store.appendSteeringAndSetPaused(taskId, steering, paused).task;
  }

  requestOperatorInterrupt(
    taskId: string,
    mode: OpsWorkerInterruptMode,
    reason: string,
    steering?: OpsWorkerSteeringEntry,
  ): OpsWorkerTask {
    this.assertStarted();
    const requestedAt = this.now().toISOString();
    const interrupt: OpsWorkerInterrupt = {
      requestedAt,
      mode,
      reason,
    };
    const requested = (steering === undefined
      ? this.store.setInterrupt(taskId, interrupt, {
        event: "UPDATED",
        summary: `Recorded durable operator ${mode} interrupt`,
      })
      : this.store.appendSteeringAndSetInterrupt(taskId, steering, interrupt)).task;
    if (requested.state === "RUNNING" || isOpsWorkerUnresolvedOrphan(requested)) {
      return requested;
    }
    return this.#completeOperatorInterrupt(
      taskId,
      requested.control.interrupt as OpsWorkerInterrupt,
    );
  }

  async resolveOperatorInterrupt(
    taskId: string,
    interrupt: OpsWorkerInterrupt,
  ): Promise<OpsWorkerTask> {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (JSON.stringify(existing.control.interrupt) !== JSON.stringify(interrupt)) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} operator interrupt changed before its stop was resolved`,
      );
    }
    if (existing.state !== "RUNNING" && !isOpsWorkerUnresolvedOrphan(existing)) {
      return this.#completeOperatorInterrupt(taskId, interrupt);
    }

    let resolution: OpsWorkerStartupRunResult = {
      status: "AMBIGUOUS",
      summary: "No trusted process-group reconciler is configured",
    };
    try {
      if (this.reconcileActiveRun !== undefined) {
        resolution = await this.reconcileActiveRun(existing);
      }
    } catch {
      resolution = {
        status: "AMBIGUOUS",
        summary: "Trusted process-group reconciliation failed",
      };
    }
    if (resolution.status === "GONE" || resolution.status === "STOPPED") {
      return this.#completeOperatorInterrupt(taskId, interrupt);
    }

    const current = this.requireTask(taskId);
    if (JSON.stringify(current.control.interrupt) !== JSON.stringify(interrupt)) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} operator interrupt changed during stop reconciliation`,
      );
    }
    if (current.state === "RUNNING") {
      return this.blockAmbiguousRun(
        taskId,
        resolution.summary ?? "Operator interrupt could not prove the process group stopped",
      );
    }
    if (isOpsWorkerUnresolvedOrphan(current)) return current;
    throw new OpsWorkerSupervisorStateError(
      `Task ${taskId} operator interrupt did not reach a proven safe boundary`,
    );
  }

  #completeOperatorInterrupt(
    taskId: string,
    interrupt: OpsWorkerInterrupt,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (JSON.stringify(existing.control.interrupt) !== JSON.stringify(interrupt)) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} operator interrupt changed before its stop was resolved`,
      );
    }
    if (
      interrupt.mode === "pause"
      && existing.state !== "RUNNING"
      && !isOpsWorkerUnresolvedOrphan(existing)
    ) {
      return this.store.clearInterrupt(taskId, {
        event: "UPDATED",
        summary: "Applied operator interrupt at an idle safe boundary",
      }).task;
    }
    const target = interrupt.mode === "cancel" ? "CANCELLED" : "RESUMABLE";
    return this.transition(taskId, target, (task, at) => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.session.resume = task.session.sessionId !== null;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.control.interrupt = null;
      if (interrupt.mode === "pause") {
        task.control.paused = true;
        task.control.pausedAt ??= at;
      } else {
        task.control.paused = false;
        task.control.pausedAt = null;
      }
      task.lastOutcome = {
        at,
        kind: "OPERATOR",
        result: interrupt.mode === "cancel" ? "CANCELLED" : "PREEMPTED",
        summary: truncateUtf8(
          interrupt.reason,
          OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
        ),
      };
      task.verification = null;
      task.report.state = interrupt.mode === "cancel" ? "PENDING" : "NONE";
      task.report.lastError = null;
    }, `Applied proven operator ${interrupt.mode} interrupt`);
  }

  private describeDoneCheckContract(task: OpsWorkerTask): OpsWorkerDoneCheckContractIdentity {
    const contract = this.doneChecks.describe(task.doneCheck.name);
    if (!contract) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${task.id} done check is not registered in the execution registry`,
      );
    }
    return contract;
  }

  private pinDoneCheckContract(task: OpsWorkerTask): boolean {
    if (task.lifecycle.verifier !== null) return false;
    const contract = this.describeDoneCheckContract(task);
    task.lifecycle.verifier = contract.verifierIdentity;
    task.lifecycle.verifierVersion = contract.verifierVersion;
    task.lifecycle.verifierContractHash = contract.contractHash;
    return true;
  }

  private persistDoneCheckContract(taskId: string): OpsWorkerTask {
    const existing = this.requireTask(taskId);
    if (existing.lifecycle.verifier !== null) return existing;
    return this.store.mutate(
      taskId,
      {
        event: "UPDATED",
        summary: "Pinned immutable composite verifier contract before checking",
      },
      (task) => {
        if (task.lifecycle.verifier === null) {
          task.updatedAt = this.nextUpdatedAt(task);
          this.pinDoneCheckContract(task);
        }
      },
    ).task;
  }

  reservePiProcessGroupLaunch(taskId: string): void {
    this.reservePiLaunch(taskId, false);
  }

  reserveQuotaProbeProcessGroupLaunch(taskId: string): void {
    this.assertStarted();
    const task = this.requireTask(taskId);
    const unclaimedAuthoritativeProbe = task.custody.status === "UNCLAIMED"
      && task.state === "QUEUED"
      && isAuthoritativePersistedQuotaWait(task)
      && task.schedule.nextRunAt !== null
      && Date.parse(task.schedule.nextRunAt) <= this.now().getTime();
    if (task.custody.status !== "HELD" && !unclaimedAuthoritativeProbe) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} must hold custody or have a due unclaimed authoritative quota probe before reserving the Pi launch slot`,
      );
    }
    this.reservePiLaunch(taskId, unclaimedAuthoritativeProbe);
  }

  private reservePiLaunch(taskId: string, allowUnclaimedQuotaProbe: boolean): void {
    this.assertStarted();
    const task = this.requireTask(taskId);
    if (task.custody.status !== "HELD" && !allowUnclaimedQuotaProbe) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} must hold custody before reserving the Pi launch slot`,
      );
    }
    if (this.piLaunchReservation !== null) {
      throw new OpsWorkerSupervisorStateError(
        `Pi launch slot is already reserved by task ${this.piLaunchReservation}`,
      );
    }
    if (this.store.list().some((candidate) =>
      candidate.id !== taskId
      && (
        candidate.custody.status === "HELD"
        || candidate.state === "RUNNING"
        || isOpsWorkerUnresolvedOrphan(candidate)
      )
    )) {
      throw new OpsWorkerSupervisorStateError(
        "A supervisor may own at most one task custody or unresolved process group",
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
    return this.store.mutate(
      taskId,
      {
        event: "UPDATED",
        summary: resume
          ? "Prepared standard Pi session continuation"
          : "Prepared new standard Pi session",
      },
      (task) => {
        if (task.state !== "QUEUED" && task.state !== "RESUMABLE") {
          throw new OpsWorkerSupervisorStateError(
            `Pi session preparation requires QUEUED or RESUMABLE, found ${task.state}`,
          );
        }
        task.updatedAt = this.nextUpdatedAt(task);
        task.session.sessionId = sessionId;
        task.session.resume = resume;
      },
    ).task;
  }

  selectNextTask(): OpsWorkerScheduledTask | undefined {
    this.assertStarted();
    return this.selectScheduledTask(this.store.list());
  }

  async claimNextTask(): Promise<OpsWorkerScheduledTask | undefined> {
    this.assertStarted();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const scheduled = this.selectScheduledTask(this.store.list());
      if (!scheduled) return undefined;
      const quotaScheduled = await this.applyQuotaScheduling(scheduled, true);
      if (quotaScheduled) return quotaScheduled;
      const current = this.requireTask(scheduled.task.id);
      if (
        scheduled.action === "RUN"
        && current.custody.status === "UNCLAIMED"
        && this.hasFreshQuotaProbePass(current)
      ) {
        // Exact proof binding depends on the live model/context/resource contract,
        // which only the Pi runner can prepare. Defer custody until it can pass the
        // derived subject back into the atomic authorization-and-claim mutation.
        return { action: "RUN", task: current };
      }
      const claimed = await this.claimTaskCustody(
        scheduled.task.id,
        scheduled.action,
        true,
      );
      if (
        claimed
        && claimed.custody.status === "HELD"
        && hasFreshOpsWorkerAuthorizationPass(claimed)
      ) return { action: scheduled.action, task: claimed };
    }
    return undefined;
  }

  async ensureTaskCustody(
    taskId: string,
    action: OpsWorkerScheduledAction,
    options: {
      quotaProbeSubjectHash?: string;
      requireCurrentSelection?: boolean;
    } = {},
  ): Promise<OpsWorkerTask> {
    this.assertStarted();
    if (action === "RUN" && this.quotaAdmission) {
      const current = this.requireTask(taskId);
      const quotaScheduled = await this.applyQuotaScheduling(
        { action, task: current },
        false,
      );
      if (quotaScheduled) return quotaScheduled.task;
    }
    if (
      options.quotaProbeSubjectHash !== undefined
      && !SHA256_PATTERN.test(options.quotaProbeSubjectHash)
    ) {
      throw new OpsWorkerSupervisorStateError(
        "Quota probe proof subject must be a lowercase sha256 digest",
      );
    }
    const claimed = await this.claimTaskCustody(
      taskId,
      action,
      options.requireCurrentSelection ?? false,
      options.quotaProbeSubjectHash,
    );
    if (!claimed) {
      const current = this.requireTask(taskId);
      if (current.control.paused) return current;
      if (isOpsWorkerTerminalState(current.state)) return current;
      if (
        action === "RUN"
        && current.custody.status === "UNCLAIMED"
        && options.quotaProbeSubjectHash !== undefined
      ) return current;
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} changed while custody was being claimed`,
      );
    }
    return claimed;
  }

  async revalidateQuotaProbe(
    taskId: string,
  ): Promise<OpsWorkerScheduledTask | undefined> {
    this.assertStarted();
    return this.applyQuotaScheduling(
      { action: "RUN", task: this.requireTask(taskId) },
      false,
    );
  }

  private selectScheduledTask(
    tasks: readonly OpsWorkerTask[],
  ): OpsWorkerScheduledTask | undefined {
    const held = tasks.filter((task) => task.custody.status === "HELD");
    if (held.length > 1) {
      throw new OpsWorkerSupervisorStateError(
        `Refusing multiple held custody owners: ${held.map((task) => task.id).join(", ")}`,
      );
    }
    const now = this.now().getTime();
    const candidateFor = (task: OpsWorkerTask): OpsWorkerScheduledTask[] => {
      if (task.control.paused || task.control.interrupt !== null) return [];
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
        ) {
          if (
            !isOpsWorkerQuotaWait(task)
            || this.quotaAdmission?.check().status !== "ADMITTED"
          ) return [];
        }
        return [{ action: "RUN", task }];
      }
      return [];
    };
    if (held.length === 1) {
      if (tasks.some((task) =>
        task.id !== held[0].id
        && (task.state === "RUNNING" || isOpsWorkerUnresolvedOrphan(task))
      )) return undefined;
      return candidateFor(held[0])[0];
    }
    if (
      tasks.some((task) =>
        task.state === "RUNNING" || isOpsWorkerUnresolvedOrphan(task))
    ) return undefined;
    const candidates = tasks.flatMap(candidateFor);
    candidates.sort((left, right) =>
      left.task.priority - right.task.priority
      || Date.parse(left.task.createdAt) - Date.parse(right.task.createdAt)
      || (left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : 0));
    return candidates[0];
  }

  private async claimTaskCustody(
    taskId: string,
    action: OpsWorkerScheduledAction,
    requireCurrentSelection: boolean,
    quotaProbeSubjectHash?: string,
  ): Promise<OpsWorkerTask | undefined> {
    if (action !== "RUN" && action !== "CHECK") {
      throw new OpsWorkerSupervisorStateError(
        `Custody cannot be claimed for scheduler action ${action}`,
      );
    }
    let selectionChanged = false;
    const result = await this.authorization.revalidate(taskId, {
      audit: {
        event: "TRANSITION",
        summary: "Revalidated authorization and claimed exclusive custody",
      },
      onPass: (task) => {
        if (task.control.paused) {
          selectionChanged = true;
          return OPS_WORKER_TASK_STORE_NO_CHANGE;
        }
        const expectedStates: readonly OpsWorkerTaskState[] = action === "RUN"
          ? ["QUEUED", "RESUMABLE"]
          : ["CHECKING"];
        if (!expectedStates.includes(task.state)) {
          selectionChanged = true;
          return OPS_WORKER_TASK_STORE_NO_CHANGE;
        }
        const verifierPinned = this.pinDoneCheckContract(task);
        const tasks = this.store.list();
        const held = tasks.filter((candidate) => candidate.custody.status === "HELD");
        if (held.length > 1) {
          throw new OpsWorkerSupervisorStateError(
            `Refusing multiple held custody owners: ${held.map((candidate) => candidate.id).join(", ")}`,
          );
        }
        if (held.length === 1 && held[0].id !== taskId) {
          throw new OpsWorkerSupervisorStateError(
            `Task ${held[0].id} already holds exclusive custody`,
          );
        }
        if (requireCurrentSelection) {
          const selected = this.selectScheduledTask(tasks);
          if (
            selected?.task.id !== taskId
            || selected.action !== action
          ) {
            selectionChanged = true;
            return OPS_WORKER_TASK_STORE_NO_CHANGE;
          }
        }
        if (task.custody.status === "HELD") {
          return verifierPinned ? undefined : OPS_WORKER_TASK_STORE_NO_CHANGE;
        }
        if (
          task.custody.status === "UNCLAIMED"
          && task.lastOutcome?.result === "QUOTA_PROBE_PASS"
        ) {
          const proofMatches = quotaProbeSubjectHash !== undefined
            && this.hasFreshQuotaProbePass(task)
            && task.lastOutcome.quotaProbeProof?.subjectHash === quotaProbeSubjectHash;
          if (!proofMatches) {
            selectionChanged = true;
            if (quotaProbeSubjectHash !== undefined) {
              const at = this.nextUpdatedAt(task);
              task.updatedAt = at;
              task.schedule.nextCheckAt = null;
              task.schedule.nextRunAt = at;
              task.lastOutcome = {
                at,
                kind: "INFRASTRUCTURE",
                result: "QUOTA_PROBE_ERROR",
                summary: "Exact quota smoke probe proof did not match the prepared pre-claim launch",
              };
            }
            return;
          }
        }
        if (
          task.custody.status === "UNCLAIMED"
          && this.quotaAdmission !== undefined
          && this.quotaAdmission.check().status !== "ADMITTED"
        ) {
          selectionChanged = true;
          return OPS_WORKER_TASK_STORE_NO_CHANGE;
        }
        if (
          task.lastOutcome?.result === "QUOTA_PROBE_PASS"
          && !this.hasFreshQuotaProbePass(task)
          && this.quotaAdmission?.check().status !== "ADMITTED"
        ) {
          selectionChanged = true;
          return OPS_WORKER_TASK_STORE_NO_CHANGE;
        }
        const claimedAt = this.nextUpdatedAt(task);
        task.updatedAt = claimedAt;
        task.custody = {
          status: "HELD",
          claimedAt,
          releasedAt: null,
          releaseReason: null,
        };
      },
    });
    return selectionChanged ? undefined : result.task;
  }

  private async applyQuotaScheduling(
    scheduled: OpsWorkerScheduledTask,
    requireCurrentSelection: boolean,
  ): Promise<OpsWorkerScheduledTask | undefined> {
    if (scheduled.action !== "RUN" || !this.quotaAdmission) return undefined;
    let task = this.requireTask(scheduled.task.id);
    if (task.lastOutcome?.result === "QUOTA_PROBE_PASS") {
      if (this.hasFreshQuotaProbePass(task)) {
        if (task.custody.status === "HELD") return undefined;
      } else {
        task = this.invalidateQuotaProbeProof(
          task.id,
          "Exact quota smoke probe proof expired before launch",
        );
      }
    }
    const decision = this.quotaAdmission.check();
    const wait = isOpsWorkerQuotaWait(task);
    const authoritativeDeadline = wait
      && isAuthoritativePersistedQuotaWait(task)
      && task.schedule.nextRunAt !== null
      && Date.parse(task.schedule.nextRunAt) <= this.now().getTime();
    if (wait && (decision.status === "ADMITTED" || authoritativeDeadline)) {
      if (task.custody.status !== "HELD" && decision.status === "ADMITTED") {
        const claimed = await this.claimTaskCustody(
          task.id,
          "RUN",
          requireCurrentSelection,
        );
        if (!claimed) return undefined;
        return { action: "QUOTA_PROBE", task: claimed };
      }
      return this.revalidateQuotaProbeAuthorization(
        task.id,
        requireCurrentSelection,
      );
    }
    if (decision.status === "NOT_ADMITTED") {
      return {
        action: "WAIT",
        task: this.recordQuotaAdmissionWait(task.id, decision),
      };
    }
    return undefined;
  }

  private hasFreshQuotaProbePass(task: OpsWorkerTask): boolean {
    if (
      task.lastOutcome?.result !== "QUOTA_PROBE_PASS"
      || task.lastOutcome.quotaProbeProof?.version
        !== OPS_WORKER_QUOTA_PROBE_PROOF_VERSION
    ) return false;
    const passedAt = Date.parse(task.lastOutcome.at);
    const ageMs = this.now().getTime() - passedAt;
    return Number.isFinite(passedAt)
      && ageMs >= -DEFAULT_OPS_WORKER_QUOTA_STALE_MS
      && ageMs <= DEFAULT_OPS_WORKER_QUOTA_STALE_MS;
  }

  private invalidateQuotaProbeProof(taskId: string, summary: string): OpsWorkerTask {
    return this.store.mutate(
      taskId,
      { event: "TRANSITION", summary },
      (task) => {
        if (task.lastOutcome?.result !== "QUOTA_PROBE_PASS") {
          return OPS_WORKER_TASK_STORE_NO_CHANGE;
        }
        const at = this.nextUpdatedAt(task);
        task.updatedAt = at;
        task.schedule.nextCheckAt = null;
        task.schedule.nextRunAt = at;
        task.lastOutcome = {
          at,
          kind: "INFRASTRUCTURE",
          result: "QUOTA_PROBE_ERROR",
          summary,
        };
      },
    ).task;
  }

  private async revalidateQuotaProbeAuthorization(
    taskId: string,
    requireCurrentSelection: boolean,
  ): Promise<OpsWorkerScheduledTask | undefined> {
    let eligibilityChanged = false;
    const authorization = await this.authorization.revalidate(taskId, {
      audit: {
        event: "TRANSITION",
        summary: "Revalidated authorization before exact quota smoke probe",
      },
      onPass: (task) => {
        const decision = this.quotaAdmission?.check();
        const authoritativeDeadline = isOpsWorkerQuotaWait(task)
          && isAuthoritativePersistedQuotaWait(task)
          && task.schedule.nextRunAt !== null
          && Date.parse(task.schedule.nextRunAt) <= this.now().getTime();
        if (
          (task.state !== "QUEUED" && task.state !== "RESUMABLE")
          || !isOpsWorkerQuotaWait(task)
          || (decision?.status !== "ADMITTED" && !authoritativeDeadline)
        ) {
          eligibilityChanged = true;
          return;
        }
        if (requireCurrentSelection) {
          const selected = this.selectScheduledTask(this.store.list());
          if (selected?.task.id !== taskId || selected.action !== "RUN") {
            eligibilityChanged = true;
          }
        }
      },
    });
    if (eligibilityChanged) return undefined;
    if (
      !authorization.authorized
      || !hasFreshOpsWorkerAuthorizationPass(authorization.task)
    ) return { action: "WAIT", task: authorization.task };
    return { action: "QUOTA_PROBE", task: authorization.task };
  }

  beginPiLaunch(
    taskId: string,
    launchIntent: OpsWorkerUnverifiedRun,
    preparedTaskSubjectHash: string,
    quotaProbeSubjectHash?: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const task = this.requireTask(taskId);
    if (
      quotaProbeSubjectHash !== undefined
      && !SHA256_PATTERN.test(quotaProbeSubjectHash)
    ) {
      throw new OpsWorkerSupervisorStateError(
        "Quota probe proof subject must be a lowercase sha256 digest",
      );
    }
    if (!SHA256_PATTERN.test(preparedTaskSubjectHash)) {
      throw new OpsWorkerSupervisorStateError(
        "Prepared Pi launch task subject must be a lowercase sha256 digest",
      );
    }
    if (this.piLaunchReservation !== taskId) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} must reserve the Pi launch slot before persisting a launch intent`,
      );
    }
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
    const preserveUnclaimedQuotaProbe = task.custody.status === "UNCLAIMED"
      && launchIntent.attemptId.startsWith("quota-probe-");
    return this.store.mutate(
      taskId,
      {
        event: "TRANSITION",
        summary: "Evaluated exact quota proof and persisted Pi launch intent",
      },
      (replacement) => {
        if (
          hashOpsWorkerPiLaunchSubject(replacement) !== preparedTaskSubjectHash
          || !hasFreshOpsWorkerAuthorizationPass(replacement)
          || replacement.control.paused
        ) return OPS_WORKER_TASK_STORE_NO_CHANGE;
        if (replacement.state !== "QUEUED" && replacement.state !== "RESUMABLE") {
          throw new OpsWorkerSupervisorStateError(
            `Pi launch intent requires QUEUED or RESUMABLE, found ${replacement.state}`,
          );
        }
        const hasQuotaProbePass = replacement.lastOutcome?.result
          === "QUOTA_PROBE_PASS";
        if (quotaProbeSubjectHash !== undefined || hasQuotaProbePass) {
          const passedAt = hasQuotaProbePass
            ? Date.parse(replacement.lastOutcome?.at ?? "")
            : Number.NaN;
          const ageMs = this.now().getTime() - passedAt;
          const fresh = Number.isFinite(passedAt)
            && ageMs >= -DEFAULT_OPS_WORKER_QUOTA_STALE_MS
            && ageMs <= DEFAULT_OPS_WORKER_QUOTA_STALE_MS;
          const matches = quotaProbeSubjectHash !== undefined
            && replacement.lastOutcome?.quotaProbeProof?.version
              === OPS_WORKER_QUOTA_PROBE_PROOF_VERSION
            && replacement.lastOutcome.quotaProbeProof.subjectHash
              === quotaProbeSubjectHash;
          if (!fresh || !matches) {
            const at = this.nextUpdatedAt(replacement);
            replacement.updatedAt = at;
            replacement.schedule.nextCheckAt = null;
            replacement.schedule.nextRunAt = at;
            replacement.lastOutcome = {
              at,
              kind: "INFRASTRUCTURE",
              result: "QUOTA_PROBE_ERROR",
              summary: "Exact quota smoke probe proof expired or did not match the prepared launch",
            };
            return;
          }
        }
        assertStructuralStateTransition(replacement.state, "BLOCKED");
        const at = this.nextUpdatedAt(replacement);
        replacement.state = "BLOCKED";
        replacement.updatedAt = at;
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
        this.applyCustodyTransition(
          replacement,
          at,
          preserveUnclaimedQuotaProbe,
        );
      },
    ).task;
  }

  bindUnverifiedPiLaunch(
    taskId: string,
    unverifiedRun: OpsWorkerUnverifiedRun,
  ): OpsWorkerTask {
    this.assertStarted();
    return this.store.mutate(
      taskId,
      {
        event: "RECONCILIATION",
        summary: "Bound detached Pi PID to the durable launch fence",
      },
      (task) => {
        const intent = task.unverifiedRun;
        if (
          task.state !== "BLOCKED"
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
        task.updatedAt = this.nextUpdatedAt(task);
        task.unverifiedRun = structuredClone(unverifiedRun);
        if (task.lastOutcome) {
          task.lastOutcome.summary = "Bound detached Pi PID to the durable launch fence";
        }
      },
    ).task;
  }

  markRunning(
    taskId: string,
    activeRun: OpsWorkerActiveRun,
    consumedSteeringIds?: readonly string[],
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    const preserveUnclaimedQuotaProbe = isOpsWorkerUnclaimedQuotaProbeProcess(existing);
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
    const steeringIds = new Set(
      consumedSteeringIds ?? existing.steering
        .filter((entry) =>
          entry.consumedAt === null
          && (entry.kind === "correction" || entry.kind === "answer"))
        .map((entry) => entry.steeringId),
    );
    if (steeringIds.size !== (consumedSteeringIds?.length ?? steeringIds.size)) {
      throw new OpsWorkerSupervisorStateError("RUNNING steering ids must be unique");
    }
    const steeringNotBefore = existing.steering
      .filter((entry) => steeringIds.has(entry.steeringId))
      .reduce<string | undefined>((latest, entry) =>
        latest === undefined || Date.parse(entry.receivedAt) > Date.parse(latest)
          ? entry.receivedAt
          : latest, undefined);
    return this.transition(taskId, "RUNNING", (task, at) => {
      if (task.control.paused || task.control.interrupt !== null) {
        throw new OpsWorkerSupervisorStateError(
          `Task ${taskId} changed control state before RUNNING launch resolution`,
        );
      }
      for (const steeringId of steeringIds) {
        const entry = task.steering.find((candidate) => candidate.steeringId === steeringId);
        if (
          entry === undefined
          || entry.consumedAt !== null
          || (entry.kind !== "correction" && entry.kind !== "answer")
        ) {
          throw new OpsWorkerSupervisorStateError(
            `Task ${taskId} steering changed before RUNNING launch resolution`,
          );
        }
      }
      this.pinDoneCheckContract(task);
      for (const entry of task.steering) {
        if (
          entry.consumedAt === null
          && (entry.kind === "correction" || entry.kind === "answer")
          && steeringIds.has(entry.steeringId)
        ) entry.consumedAt = at;
      }
      task.activeRun = structuredClone(activeRun);
      task.unverifiedRun = null;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.lastOutcome = null;
      task.verification = null;
      task.report.state = "NONE";
      task.report.attempts = 0;
      task.report.lastError = null;
    }, "Started one supervisor-owned attempt", {
      notBefore: steeringNotBefore,
      preserveUnclaimedQuotaProbe,
    });
  }

  recordPiParityPass(taskId: string, summary: string): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (existing.state !== "RUNNING" || existing.activeRun === null) {
      throw new OpsWorkerSupervisorStateError(
        `Pi parity attestation requires RUNNING, found ${existing.state}`,
      );
    }
    return this.store.mutate(
      taskId,
      {
        event: "TRANSITION",
        summary: "Persisted pre-provider Pi context/capability parity",
      },
      (task) => {
        if (task.state !== "RUNNING" || task.activeRun === null) {
          throw new OpsWorkerSupervisorStateError(
            "Pi parity attestation lost its active process fence",
          );
        }
        const at = this.nextUpdatedAt(task);
        task.updatedAt = at;
        appendOpsWorkerEvidence(task, {
          at,
          kind: "system",
          trust: "trusted",
          summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxEvidenceSummaryBytes),
          artifact: null,
        });
      },
    ).task;
  }

  async requestDoneCheck(taskId: string): Promise<OpsWorkerTask> {
    this.assertStarted();
    const task = this.requireTask(taskId);
    if (task.state !== "QUEUED" && task.state !== "RESUMABLE") {
      throw new OpsWorkerSupervisorStateError(
        `Direct done-check request requires QUEUED or RESUMABLE, found ${task.state}`,
      );
    }
    const authorization = await this.authorization.revalidate(taskId, {
      audit: {
        event: "TRANSITION",
        summary: "Authorized and queued deterministic done check",
      },
      onPass: (replacement) => {
        if (replacement.state !== "QUEUED" && replacement.state !== "RESUMABLE") {
          throw new OpsWorkerSupervisorStateError(
            `Direct done-check request requires QUEUED or RESUMABLE, found ${replacement.state}`,
          );
        }
        assertStructuralStateTransition(replacement.state, "CHECKING");
        const updatedAt = this.nextUpdatedAt(replacement);
        replacement.state = "CHECKING";
        replacement.updatedAt = updatedAt;
        replacement.activeRun = null;
        replacement.schedule.nextRunAt = null;
        replacement.schedule.nextCheckAt = null;
        replacement.verification = null;
        this.pinDoneCheckContract(replacement);
        this.applyCustodyTransition(replacement, updatedAt);
      },
    });
    return authorization.task;
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
    const target = hasPendingPromptSteering(task) ? "RESUMABLE" : "CHECKING";
    return this.transition(taskId, target, (replacement, at) => {
      if (target === "CHECKING") this.pinDoneCheckContract(replacement);
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
        appendOpsWorkerEvidence(replacement, this.piEvidence(at, evidenceSummary));
      }
    }, target === "CHECKING"
      ? "Pi claim queued deterministic done check"
      : "Pi claim retained task for pending operator steering");
  }

  recordQuotaAdmissionWait(
    taskId: string,
    decision: OpsWorkerQuotaAdmissionDecision,
  ): OpsWorkerTask {
    this.assertStarted();
    if (decision.status !== "NOT_ADMITTED") {
      throw new OpsWorkerSupervisorStateError(
        "Quota admission wait requires a NOT_ADMITTED decision",
      );
    }
    const existing = this.requireTask(taskId);
    if (existing.state !== "QUEUED" && existing.state !== "RESUMABLE") {
      throw new OpsWorkerSupervisorStateError(
        `Quota admission wait requires QUEUED or RESUMABLE, found ${existing.state}`,
      );
    }
    const observedNow = this.now();
    const authoritativeNextProbeAt = isAuthoritativeQuotaDecision(decision)
      ? decision.nextProbeAt as string
      : null;
    const consumedElapsedDeadline = existing.lastOutcome?.result === "QUOTA_PROBE_PASS"
      && authoritativeNextProbeAt !== null
      && Date.parse(authoritativeNextProbeAt) <= observedNow.getTime();
    const nextRunAt = authoritativeNextProbeAt !== null && !consumedElapsedDeadline
      ? authoritativeNextProbeAt
      : new Date(observedNow.getTime() + this.quotaRecheckMs).toISOString();
    return this.store.mutate(
      taskId,
      { event: "TRANSITION", summary: "Recorded durable quota admission wait" },
      (task) => {
        const at = this.nextUpdatedAt(task);
        task.updatedAt = at;
        task.schedule.nextRunAt = nextRunAt;
        task.schedule.nextCheckAt = null;
        task.lastOutcome = {
          at,
          kind: "INFRASTRUCTURE",
          result: isAuthoritativeQuotaDecision(decision)
            ? "QUOTA_ADMISSION_WAIT"
            : "QUOTA_TELEMETRY_ERROR",
          summary: truncateUtf8(
            `${decision.summary}; evidence=${decision.evidenceHash}`,
            OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
          ),
        };
      },
    ).task;
  }

  private returnUnclaimedQuotaProbeToQueue(
    taskId: string,
    auditSummary: string,
    mutate: (task: OpsWorkerTask, at: string) => void,
  ): OpsWorkerTask {
    return this.store.mutate(
      taskId,
      { event: "TRANSITION", summary: auditSummary },
      (task) => {
        if (!isOpsWorkerUnclaimedQuotaProbeProcess(task)) {
          throw new OpsWorkerSupervisorStateError(
            `Task ${taskId} is not an unclaimed quota probe process`,
          );
        }
        const at = this.nextUpdatedAt(task);
        task.state = "QUEUED";
        task.updatedAt = at;
        task.activeRun = null;
        task.unverifiedRun = null;
        mutate(task, at);
      },
    ).task;
  }

  recordQuotaResponseWait(
    taskId: string,
    response: OpsWorkerQuotaResponseDecision,
    evidenceSummary?: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (
      existing.state !== "QUEUED"
      && existing.state !== "RUNNING"
      && existing.state !== "RESUMABLE"
    ) {
      throw new OpsWorkerSupervisorStateError(
        `Quota response wait requires QUEUED, RUNNING, or RESUMABLE, found ${existing.state}`,
      );
    }
    if (response.status === "TELEMETRY_ERROR") {
      if (existing.state === "QUEUED") {
        return this.recordQuotaProbeTelemetryError(taskId, response.summary);
      }
      return this.recordQuotaTelemetryError(taskId, response.summary, evidenceSummary);
    }
    if (isOpsWorkerUnclaimedQuotaProbeProcess(existing)) {
      return this.returnUnclaimedQuotaProbeToQueue(
        taskId,
        "Refreshed unclaimed authoritative quota reset wait",
        (task, at) => {
          task.schedule.nextCheckAt = null;
          task.schedule.nextRunAt = response.resetAt;
          task.lastOutcome = {
            at,
            kind: "INFRASTRUCTURE",
            result: "QUOTA",
            summary: truncateUtf8(
              `${response.summary}; evidence=${response.evidenceHash}`,
              OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
            ),
          };
          if (evidenceSummary) appendOpsWorkerEvidence(task, this.piEvidence(at, evidenceSummary));
        },
      );
    }
    if (existing.state === "QUEUED") {
      return this.store.mutate(
        taskId,
        { event: "TRANSITION", summary: "Refreshed unclaimed authoritative quota reset wait" },
        (task) => {
          const at = this.nextUpdatedAt(task);
          task.updatedAt = at;
          task.schedule.nextCheckAt = null;
          task.schedule.nextRunAt = response.resetAt;
          task.lastOutcome = {
            at,
            kind: "INFRASTRUCTURE",
            result: "QUOTA",
            summary: truncateUtf8(
              `${response.summary}; evidence=${response.evidenceHash}`,
              OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
            ),
          };
          if (evidenceSummary) appendOpsWorkerEvidence(task, this.piEvidence(at, evidenceSummary));
        },
      ).task;
    }
    return this.transition(taskId, "RESUMABLE", (task, at) => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.session.resume = task.session.sessionId !== null;
      task.schedule.nextCheckAt = null;
      task.schedule.nextRunAt = response.resetAt;
      task.lastOutcome = {
        at,
        kind: "INFRASTRUCTURE",
        result: "QUOTA",
        summary: truncateUtf8(
          `${response.summary}; evidence=${response.evidenceHash}`,
          OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
        ),
      };
      if (evidenceSummary) appendOpsWorkerEvidence(task, this.piEvidence(at, evidenceSummary));
    }, "Recorded authoritative quota reset wait");
  }

  recordQuotaProbeSuccess(
    taskId: string,
    summary: string,
    subjectHash: string,
  ): OpsWorkerTask {
    this.assertStarted();
    if (!SHA256_PATTERN.test(subjectHash)) {
      throw new OpsWorkerSupervisorStateError(
        "Quota probe proof subject must be a lowercase sha256 digest",
      );
    }
    const existing = this.requireTask(taskId);
    if (
      existing.state !== "QUEUED"
      && existing.state !== "RESUMABLE"
      && existing.state !== "RUNNING"
    ) {
      throw new OpsWorkerSupervisorStateError(
        `Quota probe success requires QUEUED, RESUMABLE, or RUNNING, found ${existing.state}`,
      );
    }
    const applySuccess = (task: OpsWorkerTask, at: string): void => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.lastOutcome = {
        at,
        kind: "INFRASTRUCTURE",
        result: "QUOTA_PROBE_PASS",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
        quotaProbeProof: {
          version: OPS_WORKER_QUOTA_PROBE_PROOF_VERSION,
          subjectHash,
        },
      };
    };
    if (isOpsWorkerUnclaimedQuotaProbeProcess(existing)) {
      return this.returnUnclaimedQuotaProbeToQueue(
        taskId,
        "Unclaimed quota smoke probe restored initial admission",
        applySuccess,
      );
    }
    if (existing.state === "RUNNING") {
      return this.transition(
        taskId,
        "RESUMABLE",
        applySuccess,
        "Quota smoke probe restored runnable state",
      );
    }
    return this.store.mutate(
      taskId,
      { event: "TRANSITION", summary: "Quota smoke probe restored runnable state" },
      (task) => {
        const at = this.nextUpdatedAt(task);
        task.updatedAt = at;
        applySuccess(task, at);
      },
    ).task;
  }

  recordQuotaProbeError(taskId: string, summary: string): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (
      existing.state !== "QUEUED"
      && existing.state !== "RESUMABLE"
      && existing.state !== "RUNNING"
    ) {
      throw new OpsWorkerSupervisorStateError(
        `Quota probe error requires QUEUED, RESUMABLE, or RUNNING, found ${existing.state}`,
      );
    }
    const applyError = (task: OpsWorkerTask, at: string): void => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.schedule.nextRunAt = new Date(
        this.now().getTime() + this.quotaRecheckMs,
      ).toISOString();
      task.schedule.nextCheckAt = null;
      task.lastOutcome = {
        at,
        kind: "INFRASTRUCTURE",
        result: "QUOTA_PROBE_ERROR",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
    };
    if (isOpsWorkerUnclaimedQuotaProbeProcess(existing)) {
      return this.returnUnclaimedQuotaProbeToQueue(
        taskId,
        "Recorded bounded unclaimed quota probe error",
        applyError,
      );
    }
    if (existing.state === "RUNNING") {
      return this.transition(
        taskId,
        "RESUMABLE",
        applyError,
        "Recorded bounded quota probe error",
      );
    }
    return this.store.mutate(
      taskId,
      { event: "TRANSITION", summary: "Recorded bounded quota probe error" },
      (task) => {
        const at = this.nextUpdatedAt(task);
        task.updatedAt = at;
        applyError(task, at);
      },
    ).task;
  }

  recordQuotaProbeTelemetryError(taskId: string, summary: string): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (
      existing.state !== "QUEUED"
      && existing.state !== "RESUMABLE"
      && existing.state !== "RUNNING"
    ) {
      throw new OpsWorkerSupervisorStateError(
        `Quota probe telemetry error requires QUEUED, RESUMABLE, or RUNNING, found ${existing.state}`,
      );
    }
    const applyError = (task: OpsWorkerTask, at: string): void => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.schedule.nextRunAt = new Date(
        this.now().getTime() + this.quotaRecheckMs,
      ).toISOString();
      task.schedule.nextCheckAt = null;
      task.lastOutcome = {
        at,
        kind: "INFRASTRUCTURE",
        result: "QUOTA_TELEMETRY_ERROR",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
    };
    if (isOpsWorkerUnclaimedQuotaProbeProcess(existing)) {
      return this.returnUnclaimedQuotaProbeToQueue(
        taskId,
        "Recorded unclaimed quota probe telemetry error",
        applyError,
      );
    }
    if (existing.state === "RUNNING") {
      return this.transition(
        taskId,
        "RESUMABLE",
        applyError,
        "Recorded quota probe telemetry error",
      );
    }
    return this.store.mutate(
      taskId,
      { event: "TRANSITION", summary: "Recorded quota probe telemetry error" },
      (task) => {
        const at = this.nextUpdatedAt(task);
        task.updatedAt = at;
        applyError(task, at);
      },
    ).task;
  }

  recordQuotaTelemetryError(
    taskId: string,
    summary: string,
    evidenceSummary?: string,
  ): OpsWorkerTask {
    const existing = this.requireTask(taskId);
    if (isOpsWorkerUnclaimedQuotaProbeProcess(existing)) {
      return this.recordQuotaProbeTelemetryError(taskId, summary);
    }
    const target = existing.state === "RUNNING" ? "RESUMABLE" : existing.state;
    return this.transition(taskId, target, (task, at) => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.session.resume = task.session.sessionId !== null;
      task.schedule.nextCheckAt = null;
      task.schedule.nextRunAt = new Date(
        this.now().getTime() + this.quotaRecheckMs,
      ).toISOString();
      task.lastOutcome = {
        at,
        kind: "INFRASTRUCTURE",
        result: "QUOTA_TELEMETRY_ERROR",
        summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
      };
      if (evidenceSummary) appendOpsWorkerEvidence(task, this.piEvidence(at, evidenceSummary));
    }, "Recorded quota response telemetry error without inventing a reset");
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
    this.requireTask(taskId);
    return this.transition(taskId, "RESUMABLE", (task, at) => {
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
        appendOpsWorkerEvidence(task, this.piEvidence(at, evidenceSummary));
      }
    }, `Recorded resumable infrastructure outcome ${result}`);
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
    return this.transition(taskId, "RESUMABLE", (task, at) => {
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
    }, "Recorded Pi attempt launch failure");
  }

  recordResolvedPiLaunchFailure(
    taskId: string,
    attemptId: string,
    summary: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireMatchingLaunchFence(taskId, attemptId);
    if (existing.control.interrupt !== null) {
      return this.#completeOperatorInterrupt(taskId, existing.control.interrupt);
    }
    if (isOpsWorkerUnclaimedQuotaProbeProcess(existing)) {
      return this.returnUnclaimedQuotaProbeToQueue(
        taskId,
        "Cleared a resolved unclaimed quota probe launch fence",
        (task, at) => {
          task.schedule.nextRunAt = new Date(
            this.now().getTime() + this.quotaRecheckMs,
          ).toISOString();
          task.schedule.nextCheckAt = null;
          task.report.state = "NONE";
          task.report.attempts = 0;
          task.report.lastError = null;
          task.lastOutcome = {
            at,
            kind: "INFRASTRUCTURE",
            result: "QUOTA_PROBE_ERROR",
            summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
          };
        },
      );
    }
    return this.transition(taskId, "RESUMABLE", (task, at) => {
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
    }, "Cleared resolved Pi launch fence after launch failure");
  }

  recordResolvedPiLaunchSuccessClaim(
    taskId: string,
    attemptId: string,
    summary: string,
    evidenceSummary?: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireMatchingLaunchFence(taskId, attemptId);
    if (existing.control.interrupt !== null) {
      return this.#completeOperatorInterrupt(taskId, existing.control.interrupt);
    }
    const target = hasPendingPromptSteering(existing) ? "RESUMABLE" : "CHECKING";
    return this.transition(taskId, target, (task, at) => {
      if (target === "CHECKING") this.pinDoneCheckContract(task);
      task.activeRun = null;
      task.unverifiedRun = null;
      task.session.resume = task.session.sessionId !== null;
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
        appendOpsWorkerEvidence(task, this.piEvidence(at, evidenceSummary));
      }
    }, target === "CHECKING"
      ? "Resolved short-lived Pi success claim and queued deterministic done check"
      : "Resolved short-lived Pi success claim retained pending operator steering");
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
    if (existing.control.interrupt !== null) {
      return this.#completeOperatorInterrupt(taskId, existing.control.interrupt);
    }
    return this.transition(taskId, "RESUMABLE", (task, at) => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.session.resume = task.session.sessionId !== null;
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
        appendOpsWorkerEvidence(task, this.piEvidence(at, evidenceSummary));
      }
    }, `Recorded resolved short-lived Pi outcome ${result}`);
  }

  clearResolvedPiLaunchFence(
    taskId: string,
    attemptId: string,
    summary: string,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireMatchingLaunchFence(taskId, attemptId);
    if (existing.control.interrupt !== null) {
      return this.#completeOperatorInterrupt(taskId, existing.control.interrupt);
    }
    if (isOpsWorkerUnclaimedQuotaProbeProcess(existing)) {
      return this.returnUnclaimedQuotaProbeToQueue(
        taskId,
        "Cleared a resolved unclaimed quota probe launch fence",
        (task, at) => {
          task.session.resume = task.session.sessionId !== null;
          task.schedule.nextRunAt = new Date(
            this.now().getTime() + this.quotaRecheckMs,
          ).toISOString();
          task.schedule.nextCheckAt = null;
          task.report.state = "NONE";
          task.report.attempts = 0;
          task.report.lastError = null;
          task.lastOutcome = {
            at,
            kind: "INFRASTRUCTURE",
            result: "QUOTA_PROBE_ERROR",
            summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxOutcomeSummaryBytes),
          };
        },
      );
    }
    return this.transition(taskId, "RESUMABLE", (task, at) => {
      task.activeRun = null;
      task.unverifiedRun = null;
      task.session.resume = task.session.sessionId !== null;
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
      appendOpsWorkerEvidence(task, {
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
    if (existing.state === "RUNNING") {
      return this.transition(
        taskId,
        "RESUMABLE",
        applyReset,
        "Quarantined corrupt standard Pi session and prepared a fresh session",
      );
    }
    return this.store.mutate(
      taskId,
      {
        event: "RECONCILIATION",
        summary: "Quarantined corrupt standard Pi session and prepared a fresh session",
      },
      (task) => {
        if (task.state !== "QUEUED" && task.state !== "RESUMABLE") {
          throw new OpsWorkerSupervisorStateError(
            `Pi session reset requires QUEUED or RESUMABLE, found ${task.state}`,
          );
        }
        task.updatedAt = this.nextUpdatedAt(task);
        applyReset(task, task.updatedAt);
      },
    ).task;
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
    const preserveUnclaimedQuotaProbe = isOpsWorkerUnclaimedQuotaProbeProcess(task);
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
    }, "Blocked Pi launch whose process-group identity could not be proven", {
      preserveUnclaimedQuotaProbe,
    });
  }

  async runDoneCheck(taskId: string, signal?: AbortSignal): Promise<OpsWorkerTask> {
    this.assertStarted();
    const task = this.persistDoneCheckContract(taskId);
    if (task.state !== "CHECKING") {
      throw new OpsWorkerSupervisorStateError(
        `Done check requires CHECKING, found ${task.state}`,
      );
    }
    const checkedAt = this.now().toISOString();
    const baseline = JSON.stringify(task);
    const expectedContract = task.lifecycle.verifier === null
      ? undefined
      : {
        verifierIdentity: task.lifecycle.verifier,
        verifierVersion: task.lifecycle.verifierVersion as string,
        contractHash: task.lifecycle.verifierContractHash as string,
      };
    let result: OpsWorkerDoneCheckResult;
    try {
      result = await this.doneChecks.run(task.doneCheck, {
        taskId: task.id,
        checkedAt,
        sourceKind: task.source.kind,
        sourceCorrelationKey: task.source.correlationKey,
        sourceEvidence: task.evidence,
        expectedContract,
        now: this.now,
      }, signal);
    } catch (error) {
      if (
        error instanceof OpsWorkerDoneCheckExecutionError
        && error.code === "ABORTED"
      ) {
        return this.transition(taskId, "CHECKING", (current, at) => {
          current.activeRun = null;
          current.schedule.nextRunAt = null;
          current.schedule.nextCheckAt = new Date(
            this.now().getTime() + this.infrastructureRetryMs,
          ).toISOString();
          current.lastOutcome = {
            at,
            kind: "DONE_CHECK",
            result: "ERROR",
            summary: "Composite verification was interrupted by worker shutdown (ABORTED)",
          };
          appendOpsWorkerEvidence(current, {
            at,
            kind: "infrastructure",
            trust: "trusted",
            summary: "Composite verification was interrupted by worker shutdown (ABORTED)",
            artifact: null,
          });
        }, "Interrupted composite verification remains resumable", {
          expectedBaseline: baseline,
        });
      }
      throw error;
    }
    return this.applyDoneCheckResult(taskId, result, task, baseline);
  }

  retryBlockedTask(
    taskId: string,
    steering?: OpsWorkerSteeringEntry,
  ): OpsWorkerTask {
    this.assertStarted();
    const existing = this.requireTask(taskId);
    if (
      steering !== undefined
      && existing.steering.some((entry) => entry.steeringId === steering.steeringId)
    ) {
      return this.store.appendSteering(taskId, steering).task;
    }
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
    if (
      existing.mutationReceipts.report?.outcome === null
      && existing.mutationReceipts.report.mutationStartedAt !== null
    ) {
      throw new OpsWorkerSupervisorStateError(
        "Cannot retry while a claimed report receipt still requires reconciliation",
      );
    }
    return this.transition(taskId, "RESUMABLE", (task) => {
      const reportReceipt = task.mutationReceipts.report;
      if (reportReceipt?.outcome === null) {
        if (reportReceipt.mutationStartedAt !== null) {
          throw new OpsWorkerSupervisorStateError(
            "Cannot retry while a claimed report receipt still requires reconciliation",
          );
        }
        reportReceipt.outcome = {
          recordedAt: timestampAtOrAfter(this.now(), reportReceipt.queryObservedAt),
          result: "NOT_NEEDED",
          evidenceHash: hashOpsWorkerCanonicalPayload({
            taskId,
            reason: "report episode superseded by operator retry before mutation claim",
          }),
        };
      }
      task.rounds.remediation = 0;
      task.rounds.consecutiveInfrastructureFailures = 0;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.report.state = "NONE";
      task.report.attempts = 0;
      task.report.lastError = null;
      task.lastOutcome = null;
      task.verification = null;
    }, "Operator retried blocked task", { steering });
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
      task.unverifiedRun = null;
      task.control.paused = false;
      task.control.pausedAt = null;
      task.control.interrupt = null;
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
      task.lastOutcome = {
        at,
        kind: "OPERATOR",
        result: "CANCELLED",
        summary,
      };
      task.verification = null;
      task.report.state = "PENDING";
      task.report.lastError = null;
    }, "Task cancelled");
  }

  async recordReportAttempt(
    taskId: string,
    attempt: (
      task: Readonly<OpsWorkerTask>,
    ) => Promise<{ sent: true } | { sent: false; error: string }>,
  ): Promise<OpsWorkerTask> {
    this.assertStarted();
    if (typeof attempt !== "function") {
      throw new OpsWorkerSupervisorStateError("Report attempt requires a transport callback");
    }
    let task = this.requireTask(taskId);
    if (task.report.state !== "PENDING") {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} has no pending report`,
      );
    }
    if (task.report.attempts >= OPS_WORKER_LIMITS.maxReportAttempts) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} exhausted its bounded report-attempt counter`,
      );
    }
    const reportIdentity = hashOpsWorkerCanonicalPayload({
      taskId: task.id,
      deliveryKey: task.source.deliveryKey,
      createdAt: task.createdAt,
    });
    const reportIntent = {
      reportIdentity,
      taskState: task.state,
      lastOutcome: task.lastOutcome === null
        ? null
        : {
          at: task.lastOutcome.at,
          kind: task.lastOutcome.kind,
          result: task.lastOutcome.result,
          summary: task.lastOutcome.summary,
        },
    };
    const reportPayloadHash = hashOpsWorkerCanonicalPayload(reportIntent);
    const operation = {
      boundary: "report" as const,
      operationId: `report:${reportPayloadHash.slice("sha256:".length, 31)}`,
      intent: reportIntent,
    };
    task = this.lifecycle.updateLifecycleIdentity(taskId, {
      report: reportIdentity,
    });
    const previousReceipt = task.mutationReceipts.report;
    const observedAt = previousReceipt?.mutationStartedAt === null
      ? timestampAtOrAfter(this.now(), previousReceipt.queryObservedAt)
      : previousReceipt?.mutationStartedAt
      ? new Date(Math.max(
        this.now().getTime(),
        Date.parse(previousReceipt.mutationStartedAt) + 1,
      )).toISOString()
      : this.now().toISOString();
    task = this.lifecycle.beginMutationReceipt(taskId, {
      ...operation,
      queryObservedAt: observedAt,
      queryResult: {
        state: task.report.state,
        attempts: task.report.attempts,
        lastError: task.report.lastError,
      },
    });
    let claimed = false;
    const authorization = await this.authorization.revalidate(taskId, {
      audit: {
        event: "UPDATED",
        summary: "Revalidated authorization and claimed report mutation boundary",
      },
      onPass: (replacement, verification) => {
        claimed = this.lifecycle.claimMutationReceiptAfterFreshAuthorization(
          replacement,
          operation,
          verification,
        );
      },
    });
    if (!authorization.authorized) return authorization.task;
    if (!claimed) {
      throw new OpsWorkerSupervisorStateError(
        `Task ${taskId} report receipt cannot claim another bookkeeping mutation`,
      );
    }
    const result = await attempt(authorization.task);
    return this.store.mutate(
      taskId,
      {
        event: "REPORT",
        summary: result.sent ? "Report marked sent" : "Report attempt remains pending",
      },
      (replacement) => {
        if (replacement.report.state !== "PENDING") {
          throw new OpsWorkerSupervisorStateError(
            `Task ${taskId} has no pending report`,
          );
        }
        if (replacement.report.attempts >= OPS_WORKER_LIMITS.maxReportAttempts) {
          throw new OpsWorkerSupervisorStateError(
            `Task ${taskId} exhausted its bounded report-attempt counter`,
          );
        }
        const receipt = replacement.mutationReceipts.report;
        if (
          receipt === null
          || receipt.operationId !== operation.operationId
          || receipt.intentHash !== reportPayloadHash
          || receipt.mutationStartedAt === null
          || receipt.outcome !== null
        ) {
          throw new OpsWorkerSupervisorStateError(
            `Task ${taskId} report bookkeeping lacks its matching mutation receipt`,
          );
        }
        // updatedAt remains the terminal transition timestamp so the fresh
        // PASS proof is not rewritten by report bookkeeping.
        replacement.report.attempts += 1;
        replacement.report.state = result.sent ? "SENT" : "PENDING";
        replacement.report.lastError = result.sent
          ? null
          : truncateUtf8(result.error, OPS_WORKER_LIMITS.maxReportErrorBytes);
        if (result.sent) {
          receipt.outcome = {
            recordedAt: timestampAtOrAfter(this.now(), receipt.mutationStartedAt),
            result: "APPLIED",
            evidenceHash: hashOpsWorkerCanonicalPayload({
              sent: true,
              attempt: replacement.report.attempts,
              state: replacement.report.state,
            }),
          };
        }
      },
    ).task;
  }

  private async reconcileStartup(): Promise<OpsWorkerStartupReconciliation[]> {
    const tasks = this.store.list();
    const heldOwners = tasks.filter((task) => task.custody.status === "HELD");
    if (heldOwners.length > 1) {
      throw new OpsWorkerSupervisorStateError(
        `Refusing multiple held custody owners at startup: ${heldOwners
          .map((task) => task.id)
          .join(", ")}`,
      );
    }
    const ownershipClaims = tasks.filter((task) =>
      task.custody.status === "HELD"
      || task.state === "RUNNING"
      || (
        isOpsWorkerUnresolvedOrphan(task)
        && (task.activeRun !== null || task.unverifiedRun !== null)
      ));
    if (new Set(ownershipClaims.map((task) => task.id)).size > 1) {
      throw new OpsWorkerSupervisorStateError(
        `Refusing multiple persisted custody or process owners at startup: ${ownershipClaims
          .map((task) => task.id)
          .join(", ")}`,
      );
    }
    const running = tasks.filter((task) =>
      task.state === "RUNNING"
      || (
        isOpsWorkerUnresolvedOrphan(task)
        && (task.activeRun !== null || task.unverifiedRun !== null)
      ));
    const reconciled: OpsWorkerStartupReconciliation[] = [];
    for (const task of running) {
      const interruptedQuotaProbe = (
        task.activeRun?.attemptId
        ?? task.unverifiedRun?.attemptId
        ?? ""
      ).startsWith("quota-probe-");
      let result: OpsWorkerStartupRunResult = { status: "AMBIGUOUS" };
      try {
        result = this.reconcileActiveRun
          ? await this.reconcileActiveRun(task)
          : result;
      } catch {
        result = { status: "AMBIGUOUS" };
      }
      if (result.status === "GONE" || result.status === "STOPPED") {
        if (task.control.interrupt !== null) {
          const applied = this.#completeOperatorInterrupt(
            task.id,
            task.control.interrupt,
          );
          reconciled.push({
            taskId: task.id,
            state: applied.state as "RESUMABLE" | "CANCELLED",
            result: applied.state === "CANCELLED" ? "CANCELLED" : "PREEMPTED",
          });
          continue;
        }
        if (
          interruptedQuotaProbe
          && isOpsWorkerUnclaimedQuotaProbeProcess(task)
        ) {
          this.returnUnclaimedQuotaProbeToQueue(
            task.id,
            "Reconciled interrupted unclaimed quota smoke probe as queued",
            (replacement, at) => {
              replacement.schedule.nextRunAt = new Date(
                this.now().getTime() + this.quotaRecheckMs,
              ).toISOString();
              replacement.schedule.nextCheckAt = null;
              replacement.lastOutcome = {
                at,
                kind: "INFRASTRUCTURE",
                result: "QUOTA_PROBE_ERROR",
                summary: truncateUtf8(
                  result.summary ?? "Prior unclaimed quota smoke probe is no longer running",
                  OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
                ),
              };
            },
          );
          reconciled.push({
            taskId: task.id,
            state: "QUEUED",
            result: "QUOTA_PROBE_ERROR",
          });
          continue;
        }
        this.transition(task.id, "RESUMABLE", (replacement, at) => {
          replacement.activeRun = null;
          replacement.unverifiedRun = null;
          if (!interruptedQuotaProbe) this.incrementInfrastructureFailures(replacement);
          replacement.schedule.nextRunAt = interruptedQuotaProbe
            ? new Date(this.now().getTime() + this.quotaRecheckMs).toISOString()
            : null;
          replacement.schedule.nextCheckAt = null;
          replacement.lastOutcome = {
            at,
            kind: interruptedQuotaProbe ? "INFRASTRUCTURE" : "RECONCILIATION",
            result: interruptedQuotaProbe ? "QUOTA_PROBE_ERROR" : "CRASH",
            summary: truncateUtf8(
              result.summary ?? (interruptedQuotaProbe
                ? "Prior owned quota smoke probe is no longer running"
                : "Prior owned attempt is no longer running"),
              OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
            ),
          };
        }, interruptedQuotaProbe
          ? "Reconciled interrupted quota smoke probe as resumable"
          : "Reconciled interrupted attempt as resumable");
        reconciled.push({
          taskId: task.id,
          state: "RESUMABLE",
          result: interruptedQuotaProbe ? "QUOTA_PROBE_ERROR" : "CRASH",
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
    for (const task of this.store.list()) {
      if (
        task.control.interrupt !== null
        && task.state !== "RUNNING"
        && !isOpsWorkerUnresolvedOrphan(task)
      ) {
        this.#completeOperatorInterrupt(task.id, task.control.interrupt);
      }
    }
    return reconciled;
  }

  private blockAmbiguousRun(taskId: string, summary: string): OpsWorkerTask {
    const preserveUnclaimedQuotaProbe = isOpsWorkerUnclaimedQuotaProbeProcess(
      this.requireTask(taskId),
    );
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
    }, "Blocked ambiguous persisted process group", { preserveUnclaimedQuotaProbe });
  }

  private applyDoneCheckResult(
    taskId: string,
    result: OpsWorkerDoneCheckResult,
    checkedTask: OpsWorkerTask,
    expectedBaseline: string,
  ): OpsWorkerTask {
    const persistVerification = (task: OpsWorkerTask, at: string): void => {
      const existingContract = task.lifecycle.verifier === null
        ? null
        : {
          verifierIdentity: task.lifecycle.verifier,
          verifierVersion: task.lifecycle.verifierVersion,
          contractHash: task.lifecycle.verifierContractHash,
        };
      if (existingContract !== null && (
        existingContract.verifierIdentity !== result.verifierIdentity
        || existingContract.verifierVersion !== result.verifierVersion
        || existingContract.contractHash !== result.contractHash
      )) {
        throw new OpsWorkerSupervisorStateError(
          `Task ${taskId} verifier contract changed after immutable pinning`,
        );
      }
      task.lifecycle.verifier = result.verifierIdentity;
      task.lifecycle.verifierVersion = result.verifierVersion;
      task.lifecycle.verifierContractHash = result.contractHash;
      task.verification = {
        verifierIdentity: result.verifierIdentity,
        verifierVersion: result.verifierVersion,
        contractHash: result.contractHash,
        subjectHash: hashOpsWorkerVerificationSubject(task),
        checkedAt: result.checkedAt,
        completedAt: at,
        outcome: result.result,
        summary: result.summary,
        nextCheckAt: result.nextCheckAt,
        components: structuredClone(result.components),
      } satisfies OpsWorkerVerificationRecord;
    };
    if (result.result === "PASS") {
      return this.transition(taskId, "DONE", (task, at) => {
        this.resetAfterCheck(task);
        persistVerification(task, at);
        task.lastOutcome = this.checkOutcome(at, "PASS", result.summary);
        appendOpsWorkerEvidence(task, this.checkEvidence(at, result.summary));
        task.report.state = "PENDING";
        task.report.lastError = null;
      }, "Fresh deterministic done check passed", {
        freshDoneCheckPass: true,
        expectedBaseline,
        notBefore: result.checkedAt,
      });
    }
    if (result.result === "DEFER") {
      return this.transition(taskId, "CHECKING", (task, at) => {
        task.activeRun = null;
        task.rounds.consecutiveInfrastructureFailures = 0;
        task.schedule.nextRunAt = null;
        task.schedule.nextCheckAt = result.nextCheckAt;
        persistVerification(task, at);
        task.lastOutcome = this.checkOutcome(at, "DEFER", result.summary);
        appendOpsWorkerEvidence(task, this.checkEvidence(at, result.summary));
      }, "Done check deferred without spending remediation budget", {
        expectedBaseline,
        notBefore: result.checkedAt,
      });
    }
    if (result.result === "NOT_READY" && result.nextCheckAt !== null) {
      return this.transition(taskId, "CHECKING", (task, at) => {
        task.activeRun = null;
        task.rounds.consecutiveInfrastructureFailures = 0;
        task.schedule.nextRunAt = null;
        task.schedule.nextCheckAt = result.nextCheckAt;
        persistVerification(task, at);
        task.lastOutcome = this.checkOutcome(at, "NOT_READY", result.summary);
        appendOpsWorkerEvidence(task, this.checkEvidence(at, result.summary));
      }, "Done check is waiting for product stability without remediation", {
        expectedBaseline,
        notBefore: result.checkedAt,
      });
    }
    if (
      result.result === "VERIFIER_INVALID"
      || result.result === "QUERY_ERROR"
      || result.result === "TIMEOUT"
    ) {
      return this.transition(taskId, "CHECKING", (task, at) => {
        task.activeRun = null;
        task.rounds.consecutiveInfrastructureFailures = Math.min(
          MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES,
          task.rounds.consecutiveInfrastructureFailures + 1,
        );
        task.schedule.nextRunAt = null;
        task.schedule.nextCheckAt = new Date(
          this.now().getTime() + this.infrastructureRetryMs,
        ).toISOString();
        persistVerification(task, at);
        task.lastOutcome = {
          at,
          kind: "DONE_CHECK",
          result: result.result,
          summary: result.summary,
        };
        appendOpsWorkerEvidence(task, {
          at,
          kind: "infrastructure",
          trust: "trusted",
          summary: result.summary,
          artifact: null,
        });
      }, `Composite verification will retry after ${result.result}`, {
        expectedBaseline,
        notBefore: result.checkedAt,
      });
    }
    if (result.result !== "NOT_READY" && result.result !== "PRODUCT_FAILURE") {
      throw new OpsWorkerSupervisorStateError(
        `Unsupported composite verification outcome ${result.result}`,
      );
    }
    const remediationResult = result.result;
    return this.transition(
      taskId,
      checkedTask.rounds.remediation + 1
          >= checkedTask.rounds.maxRemediation
        ? "BLOCKED"
        : "RESUMABLE",
      (task, at) => {
        task.activeRun = null;
        task.rounds.remediation += 1;
        task.rounds.consecutiveInfrastructureFailures = 0;
        task.schedule.nextRunAt = null;
        task.schedule.nextCheckAt = null;
        persistVerification(task, at);
        task.lastOutcome = this.checkOutcome(
          at,
          remediationResult,
          result.summary,
        );
        appendOpsWorkerEvidence(task, this.checkEvidence(at, result.summary));
        if (task.rounds.remediation >= task.rounds.maxRemediation) {
          task.report.state = "PENDING";
          task.report.lastError = null;
        }
      },
      `Composite verification requires remediation (${remediationResult})`,
      { expectedBaseline, notBefore: result.checkedAt },
    );
  }

  private resetAfterCheck(task: OpsWorkerTask): void {
    task.activeRun = null;
    task.rounds.consecutiveInfrastructureFailures = 0;
    task.schedule.nextRunAt = null;
    task.schedule.nextCheckAt = null;
  }

  private incrementInfrastructureFailures(task: OpsWorkerTask): void {
    // Saturate bounded diagnostics without converting them into product failure.
    // The surrounding transitions retain custody in RESUMABLE or CHECKING.
    task.rounds.consecutiveInfrastructureFailures = Math.min(
      MAX_CONSECUTIVE_INFRASTRUCTURE_FAILURES,
      task.rounds.consecutiveInfrastructureFailures + 1,
    );
  }

  private checkOutcome(
    at: string,
    result: Extract<
      OpsWorkerOutcomeResult,
      "PASS" | "NOT_READY" | "PRODUCT_FAILURE" | "DEFER"
    >,
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

  private applyCustodyTransition(
    task: OpsWorkerTask,
    at: string,
    preserveUnclaimedQuotaProbe = false,
  ): void {
    if (
      preserveUnclaimedQuotaProbe
      && isOpsWorkerUnclaimedQuotaProbeProcess(task)
    ) return;
    let releaseReason: OpsWorkerCustodyReleaseReason | undefined;
    if (task.state === "DONE") {
      releaseReason = "DONE";
    } else if (task.state === "CANCELLED") {
      releaseReason = "CANCELLED";
    } else if (
      task.state === "BLOCKED"
      && task.activeRun === null
      && task.unverifiedRun === null
      && !isOpsWorkerUnresolvedOrphan(task)
    ) {
      releaseReason = "BLOCKED";
    }
    if (releaseReason) {
      task.custody = {
        status: "RELEASED",
        claimedAt: task.custody.claimedAt,
        releasedAt: at,
        releaseReason,
      };
      return;
    }
    if (
      task.state === "RUNNING"
      || task.state === "CHECKING"
      || task.state === "RESUMABLE"
      || task.state === "BLOCKED"
    ) {
      if (task.custody.status === "HELD") return;
      task.custody = {
        status: "HELD",
        claimedAt: at,
        releasedAt: null,
        releaseReason: null,
      };
    }
  }

  private transition(
    taskId: string,
    to: OpsWorkerTaskState,
    mutate: (task: OpsWorkerTask, at: string) => void,
    auditSummary: string,
    options: {
      freshDoneCheckPass?: boolean;
      expectedBaseline?: string;
      notBefore?: string;
      preserveUnclaimedQuotaProbe?: boolean;
      steering?: OpsWorkerSteeringEntry;
    } = {},
  ): OpsWorkerTask {
    if (to === "DONE" && !options.freshDoneCheckPass) {
      throw new OpsWorkerSupervisorStateError(
        "DONE is reserved for a fresh deterministic done-check PASS",
      );
    }
    const audit = { event: "TRANSITION", summary: auditSummary } as const;
    const applyTransition = (task: OpsWorkerTask): void => {
      if (
        options.expectedBaseline !== undefined
        && JSON.stringify(task) !== options.expectedBaseline
      ) {
        throw new OpsWorkerStaleCheckResultError(taskId);
      }
      assertStructuralStateTransition(task.state, to);
      const updatedAt = this.nextUpdatedAt(task, options.notBefore);
      task.state = to;
      task.updatedAt = updatedAt;
      mutate(task, updatedAt);
      this.applyCustodyTransition(
        task,
        updatedAt,
        options.preserveUnclaimedQuotaProbe,
      );
    };
    return (options.steering === undefined
      ? this.store.mutate(taskId, audit, applyTransition)
      : this.store.appendSteeringAndMutate(
          taskId,
          options.steering,
          audit,
          applyTransition,
        )).task;
  }

  private nextUpdatedAt(task: OpsWorkerTask, notBefore?: string): string {
    const now = this.now().getTime();
    return new Date(Math.max(
      now,
      Date.parse(task.updatedAt) + 1,
      notBefore === undefined ? 0 : Date.parse(notBefore),
    )).toISOString();
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
