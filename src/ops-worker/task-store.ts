import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Stats,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import {
  assertOpsWorkerTaskId,
  hashOpsWorkerCanonicalSubmission,
  hashOpsWorkerReportPayload,
  isOpsWorkerTerminalState,
  OPS_WORKER_LIMITS,
  parseOpsWorkerTask,
  parseOpsWorkerTaskJson,
  serializeOpsWorkerPendingSteering,
  type OpsWorkerInterrupt,
  type OpsWorkerSteeringEntry,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "./types.js";
import {
  appendOpsWorkerEvidence,
  compactOpsWorkerEvidenceForSnapshot,
} from "./evidence.js";

export const OPS_WORKER_JOURNAL_SCHEMA_VERSION = 1 as const;
export const DEFAULT_OPS_WORKER_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
export const MAX_OPS_WORKER_JOURNAL_ENTRY_BYTES = 8 * 1024;
const MAX_ACTIVE_CORRELATION_DELIVERY_RECEIPTS = 32;

export const OPS_WORKER_AUDIT_EVENTS = [
  "CREATED",
  "UPDATED",
  "TRANSITION",
  "EVIDENCE",
  "RECONCILIATION",
  "REPORT",
] as const;

export type OpsWorkerAuditEvent = (typeof OPS_WORKER_AUDIT_EVENTS)[number];

export interface OpsWorkerAuditInput {
  event: OpsWorkerAuditEvent;
  summary?: string | null;
}

export interface OpsWorkerJournalEntry {
  schemaVersion: typeof OPS_WORKER_JOURNAL_SCHEMA_VERSION;
  at: string;
  taskId: string;
  correlationKey: string;
  state: OpsWorkerTask["state"];
  taskUpdatedAt: string;
  event: OpsWorkerAuditEvent;
  summary: string | null;
}

export type OpsWorkerTaskStoreFaultPoint =
  | "after-mutation-lock-temp-fsync"
  | "after-mutation-lock-publish-conflict"
  | "after-temp-file-fsync"
  | "after-snapshot-rename"
  | "after-task-directory-fsync"
  | "after-correlation-check"
  | "before-journal-append"
  | "after-journal-fsync";

export interface OpsWorkerTaskStoreOptions {
  registry: OpsWorkerTaskContractRegistry;
  maxJournalBytes?: number;
  now?: () => Date;
  /** Test-only crash-boundary hook. Production callers should leave this unset. */
  faultInjector?: (point: OpsWorkerTaskStoreFaultPoint) => void;
}

export interface OpsWorkerTaskStoreWriteResult {
  snapshotPath: string;
  journalAppended: boolean;
}

export interface OpsWorkerTaskStoreCreateResult extends OpsWorkerTaskStoreWriteResult {
  task: OpsWorkerTask;
  created: boolean;
}

export interface OpsWorkerTaskStoreMutationResult extends OpsWorkerTaskStoreWriteResult {
  task: OpsWorkerTask;
}

/** Return from a mutation callback when the guarded read proves no write is needed. */
export const OPS_WORKER_TASK_STORE_NO_CHANGE = Symbol(
  "OPS_WORKER_TASK_STORE_NO_CHANGE",
);

export class OpsWorkerDuplicateCorrelationError extends Error {
  readonly existingTaskId: string;

  constructor(correlationKey: string, existingTaskId: string) {
    super(
      `Active task ${existingTaskId} already owns correlation key ${JSON.stringify(correlationKey)}`,
    );
    this.name = "OpsWorkerDuplicateCorrelationError";
    this.existingTaskId = existingTaskId;
  }
}

export class OpsWorkerTaskStoreSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsWorkerTaskStoreSafetyError";
  }
}

export class OpsWorkerSteeringCapacityError extends OpsWorkerTaskStoreSafetyError {
  constructor(taskId: string) {
    super(`Task ${taskId} has no remaining steering capacity`);
    this.name = "OpsWorkerSteeringCapacityError";
  }
}

export class OpsWorkerDeliveryConflictError extends OpsWorkerTaskStoreSafetyError {
  readonly existingTaskId: string;

  constructor(deliveryKey: string, existingTaskId: string) {
    super(
      `Delivery key ${JSON.stringify(deliveryKey)} conflicts with existing task ${existingTaskId}`,
    );
    this.name = "OpsWorkerDeliveryConflictError";
    this.existingTaskId = existingTaskId;
  }
}

interface OpsWorkerDeliveryReceipt {
  type: "alertmanager-delivery-receipt-v1";
  deliveryKey: string;
  submissionFingerprint: string;
}

interface OpsWorkerFiringObservation {
  type: "alertmanager-firing-observation-v1";
  correlationKey: string;
  deliveryKey: string;
}

function parseFiringObservation(evidence: OpsWorkerTask["evidence"][number]):
OpsWorkerFiringObservation | undefined {
  if (evidence.kind !== "system" || evidence.trust !== "trusted") return undefined;
  try {
    const value = JSON.parse(evidence.summary) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3
      || record.type !== "alertmanager-firing-observation-v1"
      || typeof record.correlationKey !== "string"
      || typeof record.deliveryKey !== "string"
    ) return undefined;
    return record as unknown as OpsWorkerFiringObservation;
  } catch {
    return undefined;
  }
}

function parseDeliveryReceipt(evidence: OpsWorkerTask["evidence"][number]):
OpsWorkerDeliveryReceipt | undefined {
  if (evidence.kind !== "system" || evidence.trust !== "trusted") return undefined;
  try {
    const value = JSON.parse(evidence.summary) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 3
      || record.type !== "alertmanager-delivery-receipt-v1"
      || typeof record.deliveryKey !== "string"
      || typeof record.submissionFingerprint !== "string"
    ) return undefined;
    return record as unknown as OpsWorkerDeliveryReceipt;
  } catch {
    return undefined;
  }
}

function isAlertmanagerGroupCorrelationEvidence(
  evidence: OpsWorkerTask["evidence"][number],
  correlationKey: string,
): boolean {
  if (evidence.kind !== "alert" || evidence.trust !== "untrusted") return false;
  try {
    const value = JSON.parse(evidence.summary) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return record.type === "alertmanager-group-correlation-v1"
      && record.correlationKey === correlationKey;
  } catch {
    return false;
  }
}

function deliveryFingerprints(task: OpsWorkerTask, deliveryKey: string): Set<string> {
  const fingerprints = new Set<string>();
  if (task.source.deliveryKey === deliveryKey) {
    fingerprints.add(task.submissionFingerprint);
  }
  for (const evidence of task.evidence) {
    const receipt = parseDeliveryReceipt(evidence);
    if (receipt?.deliveryKey === deliveryKey) {
      fingerprints.add(receipt.submissionFingerprint);
    }
  }
  return fingerprints;
}

function serializedDeliveryReceipts(task: OpsWorkerTask): Set<string> {
  return new Set(
    task.evidence
      .map(parseDeliveryReceipt)
      .filter((receipt): receipt is OpsWorkerDeliveryReceipt => receipt !== undefined)
      .map((receipt) => JSON.stringify(receipt)),
  );
}

export class OpsWorkerTaskStoreBusyError extends Error {
  constructor() {
    super("Another ops-worker task-store mutation is in progress");
    this.name = "OpsWorkerTaskStoreBusyError";
  }
}

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SNAPSHOT_SUFFIX = ".json";
const JOURNAL_FILE_NAME = "journal.jsonl";
const MUTATION_LOCK_FILE_NAME = ".task-store.lock";
const MUTATION_LOCK_RECOVERY_FILE_NAME = ".task-store.lock.recovery";
const MAX_MUTATION_LOCK_BYTES = 512;
const MAX_AUDIT_SUMMARY_BYTES = 2 * 1024;

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertOwnedByCurrentUser(path: string, stats: Stats): void {
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new OpsWorkerTaskStoreSafetyError(
      `Refusing ops-worker path ${path}: owned by uid ${stats.uid}`,
    );
  }
}

function verifyDirectory(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new OpsWorkerTaskStoreSafetyError(
      `Refusing ops-worker directory ${path}: path is a symlink`,
    );
  }
  if (!stats.isDirectory()) {
    throw new OpsWorkerTaskStoreSafetyError(
      `Refusing ops-worker directory ${path}: path is not a directory`,
    );
  }
  assertOwnedByCurrentUser(path, stats);
  if ((stats.mode & 0o777) !== 0o700) {
    chmodSync(path, 0o700);
  }
}

function ensureDirectory(path: string): boolean {
  try {
    verifyDirectory(path);
    return false;
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  verifyDirectory(path);
  return true;
}

function assertRegularFile(path: string): Stats {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) {
    throw new OpsWorkerTaskStoreSafetyError(
      `Refusing ops-worker file ${path}: path is a symlink`,
    );
  }
  if (!stats.isFile()) {
    throw new OpsWorkerTaskStoreSafetyError(
      `Refusing ops-worker file ${path}: path is not a regular file`,
    );
  }
  assertOwnedByCurrentUser(path, stats);
  return stats;
}

function assertPathMissingOrRegularFile(path: string): Stats | undefined {
  try {
    return assertRegularFile(path);
  } catch (error) {
    if (isMissingError(error)) return undefined;
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isDirectory()) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing to fsync ${path}: descriptor is not a directory`,
      );
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

interface MutationLockRecord {
  pid: number;
  processStartToken: string;
  nonce: string;
}

type MutationLockOwnerInspection =
  | { status: "ACTIVE"; processStartToken: string }
  | { status: "STALE" }
  | { status: "AMBIGUOUS" };

const PROCESS_START_TOKEN_PATTERN = /^sha256:[a-f0-9]{64}$/;

function hashProcessStartToken(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function inspectMutationLockOwner(pid: number): MutationLockOwnerInspection {
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closingParen = raw.lastIndexOf(")");
      if (closingParen < 0) throw new Error("missing proc stat command boundary");
      const parsedPid = Number(raw.slice(0, raw.indexOf(" ")));
      const fields = raw.slice(closingParen + 2).trim().split(/\s+/);
      const startTicks = fields[19];
      if (parsedPid !== pid || !startTicks) throw new Error("invalid proc stat identity");
      return {
        status: "ACTIVE",
        processStartToken: hashProcessStartToken(`linux:${startTicks}`),
      };
    } catch {
      // The process probe below distinguishes a stale PID from ambiguous inspection.
    }
  } else {
    const inspected = spawnSync(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", timeout: 1_000, maxBuffer: 64 * 1024 },
    );
    if (!inspected.error && inspected.status === 0 && inspected.stdout.trim()) {
      return {
        status: "ACTIVE",
        processStartToken: hashProcessStartToken(
          `${process.platform}:${inspected.stdout.trim()}`,
        ),
      };
    }
  }
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { status: "STALE" };
  }
  return { status: "AMBIGUOUS" };
}

function parseMutationLockRecord(raw: string): MutationLockRecord {
  const value = JSON.parse(raw) as Partial<MutationLockRecord>;
  if (
    Object.keys(value).length !== 3
    || !Number.isSafeInteger(value.pid)
    || (value.pid as number) < 1
    || typeof value.processStartToken !== "string"
    || !PROCESS_START_TOKEN_PATTERN.test(value.processStartToken)
    || typeof value.nonce !== "string"
    || !/^[a-f0-9]{32}$/.test(value.nonce)
  ) throw new Error("invalid mutation lock");
  return {
    pid: value.pid as number,
    processStartToken: value.processStartToken,
    nonce: value.nonce,
  };
}

function readMutationLock(path: string): {
  stats: Stats;
  raw: string;
  record: MutationLockRecord;
} {
  const beforeOpen = assertRegularFile(path);
  if (beforeOpen.size > MAX_MUTATION_LOCK_BYTES) {
    throw new OpsWorkerTaskStoreBusyError();
  }
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (
      !stats.isFile()
      || stats.ino !== beforeOpen.ino
      || stats.size > MAX_MUTATION_LOCK_BYTES
      || (typeof process.getuid === "function" && stats.uid !== process.getuid())
    ) throw new OpsWorkerTaskStoreBusyError();
    const raw = readFileSync(descriptor, "utf8");
    return { stats, raw, record: parseMutationLockRecord(raw) };
  } catch {
    throw new OpsWorkerTaskStoreBusyError();
  } finally {
    closeSync(descriptor);
  }
}

class OpsWorkerTaskStoreMutationGuard {
  private readonly path: string;
  private readonly recoveryPath: string;
  private readonly record: MutationLockRecord;
  private readonly faultInjector: ((point: OpsWorkerTaskStoreFaultPoint) => void) | undefined;
  private acquiredInode: bigint | number | undefined;
  private recoveryInode: bigint | number | undefined;

  constructor(
    stateDirectory: string,
    faultInjector: ((point: OpsWorkerTaskStoreFaultPoint) => void) | undefined,
  ) {
    this.path = join(stateDirectory, MUTATION_LOCK_FILE_NAME);
    this.recoveryPath = join(stateDirectory, MUTATION_LOCK_RECOVERY_FILE_NAME);
    const owner = inspectMutationLockOwner(process.pid);
    if (owner.status !== "ACTIVE") {
      throw new OpsWorkerTaskStoreSafetyError(
        "Cannot prove the task-store mutation lock process identity",
      );
    }
    this.record = {
      pid: process.pid,
      processStartToken: owner.processStartToken,
      nonce: randomBytes(16).toString("hex"),
    };
    this.faultInjector = faultInjector;
  }

  acquire(): void {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      this.assertNoRecoveryGuard();
      if (this.publishCompleteRecord()) return;
      let existing: ReturnType<typeof readMutationLock>;
      try {
        existing = readMutationLock(this.path);
      } catch (error) {
        // A healthy owner may release after link(2) reports EEXIST but before
        // this contender inspects the canonical lock. Nothing remains to
        // recover in that case; retry publication within the bounded loop.
        if (isMissingError(error)) continue;
        throw new OpsWorkerTaskStoreBusyError();
      }
      const owner = inspectMutationLockOwner(existing.record.pid);
      if (
        owner.status === "STALE"
        || (
          owner.status === "ACTIVE"
          && owner.processStartToken !== existing.record.processStartToken
        )
      ) {
        this.acquireRecoveryGuard();
        try {
          const rechecked = readMutationLock(this.path);
          if (
            rechecked.stats.ino !== existing.stats.ino
            || rechecked.raw !== existing.raw
          ) throw new OpsWorkerTaskStoreBusyError();
          const recheckedOwner = inspectMutationLockOwner(rechecked.record.pid);
          if (
            recheckedOwner.status !== "STALE"
            && !(
              recheckedOwner.status === "ACTIVE"
              && recheckedOwner.processStartToken !== rechecked.record.processStartToken
            )
          ) throw new OpsWorkerTaskStoreBusyError();
          const confirmed = readMutationLock(this.path);
          if (
            confirmed.stats.ino !== rechecked.stats.ino
            || confirmed.raw !== rechecked.raw
          ) throw new OpsWorkerTaskStoreBusyError();
          unlinkSync(this.path);
        } catch (error) {
          // The observed owner may release and exit between inspection and the
          // recovery guard. A vanished canonical lock is a normal retry race.
          if (!isMissingError(error)) throw error;
        } finally {
          this.releaseRecoveryGuard();
        }
        continue;
      }
      if (owner.status === "AMBIGUOUS") throw new OpsWorkerTaskStoreBusyError();
      const waiter = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(waiter, 0, 0, 10);
    }
    throw new OpsWorkerTaskStoreBusyError();
  }

  release(): void {
    if (this.acquiredInode === undefined) return;
    const current = readMutationLock(this.path);
    const stats = current.stats;
    const value = current.record;
    if (
      stats.ino !== this.acquiredInode
      || value.pid !== this.record.pid
      || value.processStartToken !== this.record.processStartToken
      || value.nonce !== this.record.nonce
    ) {
      throw new OpsWorkerTaskStoreSafetyError(
        "Refusing to remove a task-store mutation lock whose ownership changed",
      );
    }
    unlinkSync(this.path);
    this.acquiredInode = undefined;
  }

  private publishCompleteRecord(): boolean {
    const temporaryPath = `${this.path}.${process.pid}.${this.record.nonce}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      writeFileSync(descriptor, `${JSON.stringify(this.record)}\n`, "utf8");
      fsyncSync(descriptor);
      this.faultInjector?.("after-mutation-lock-temp-fsync");
      const inode = fstatSync(descriptor).ino;
      closeSync(descriptor);
      descriptor = undefined;
      try {
        linkSync(temporaryPath, this.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          this.faultInjector?.("after-mutation-lock-publish-conflict");
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
    throw new OpsWorkerTaskStoreBusyError();
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
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new OpsWorkerTaskStoreBusyError();
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
    const current = readMutationLock(this.recoveryPath);
    if (
      current.stats.ino !== this.recoveryInode
      || current.record.pid !== this.record.pid
      || current.record.processStartToken !== this.record.processStartToken
      || current.record.nonce !== this.record.nonce
    ) {
      throw new OpsWorkerTaskStoreSafetyError(
        "Refusing to remove a task-store stale-lock recovery guard whose ownership changed",
      );
    }
    unlinkSync(this.recoveryPath);
    this.recoveryInode = undefined;
  }
}

function readRegularFile(path: string, maxBytes: number): string {
  assertRegularFile(path);
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing to read ${path}: descriptor is not a regular file`,
      );
    }
    if (stats.size > maxBytes) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing to read ${path}: file exceeds ${maxBytes} bytes`,
      );
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function stableTaskJson(task: OpsWorkerTask): string {
  const serialized = `${JSON.stringify(task)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > OPS_WORKER_LIMITS.maxSnapshotBytes) {
    throw new OpsWorkerTaskStoreSafetyError(
      `Task snapshot exceeds ${OPS_WORKER_LIMITS.maxSnapshotBytes} bytes`,
    );
  }
  return serialized;
}

function checkpointContentHash(checkpoint: NonNullable<OpsWorkerTask["currentCheckpoint"]>): string {
  const canonical = JSON.stringify({
    artifact: checkpoint.artifact,
    payloadHash: checkpoint.payloadHash,
    summary: checkpoint.summary,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function assertAuditInput(input: OpsWorkerAuditInput): void {
  if (!(OPS_WORKER_AUDIT_EVENTS as readonly string[]).includes(input.event)) {
    throw new OpsWorkerTaskStoreSafetyError(
      `Refusing unknown ops-worker audit event ${JSON.stringify(input.event)}`,
    );
  }
  if (input.summary !== undefined && input.summary !== null) {
    if (typeof input.summary !== "string" || input.summary.includes("\0")) {
      throw new OpsWorkerTaskStoreSafetyError("Audit summary must be plain bounded text");
    }
    if (Buffer.byteLength(input.summary, "utf8") > MAX_AUDIT_SUMMARY_BYTES) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Audit summary exceeds ${MAX_AUDIT_SUMMARY_BYTES} bytes`,
      );
    }
  }
}

export class OpsWorkerTaskStore {
  readonly stateDirectory: string;
  readonly tasksDirectory: string;
  readonly journalPath: string;

  private readonly registry: OpsWorkerTaskContractRegistry;
  private readonly maxJournalBytes: number;
  private readonly now: () => Date;
  private readonly faultInjector: ((point: OpsWorkerTaskStoreFaultPoint) => void) | undefined;

  constructor(stateDirectory: string, options: OpsWorkerTaskStoreOptions) {
    if (!isAbsolute(stateDirectory)) {
      throw new OpsWorkerTaskStoreSafetyError(
        "Ops-worker state directory must be an absolute path",
      );
    }
    if (
      !Number.isSafeInteger(options.maxJournalBytes ?? DEFAULT_OPS_WORKER_MAX_JOURNAL_BYTES)
      || (options.maxJournalBytes ?? DEFAULT_OPS_WORKER_MAX_JOURNAL_BYTES) < 0
    ) {
      throw new OpsWorkerTaskStoreSafetyError("maxJournalBytes must be a non-negative integer");
    }
    this.stateDirectory = stateDirectory;
    this.tasksDirectory = join(stateDirectory, "tasks");
    this.journalPath = join(stateDirectory, JOURNAL_FILE_NAME);
    this.registry = options.registry;
    this.maxJournalBytes = options.maxJournalBytes ?? DEFAULT_OPS_WORKER_MAX_JOURNAL_BYTES;
    this.now = options.now ?? (() => new Date());
    this.faultInjector = options.faultInjector;
    this.ensureSafeDirectories();
  }

  get(taskId: string): OpsWorkerTask | undefined {
    assertOpsWorkerTaskId(taskId);
    this.ensureSafeDirectories();
    const path = this.snapshotPath(taskId);
    try {
      return this.readSnapshot(path);
    } catch (error) {
      if (isMissingError(error)) return undefined;
      throw error;
    }
  }

  list(): OpsWorkerTask[] {
    this.ensureSafeDirectories();
    const tasks: OpsWorkerTask[] = [];
    const entries = readdirSync(this.tasksDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!entry.name.endsWith(SNAPSHOT_SUFFIX)) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing task snapshot ${entry.name}: path is not a regular file`,
        );
      }
      const taskId = entry.name.slice(0, -SNAPSHOT_SUFFIX.length);
      assertOpsWorkerTaskId(taskId);
      const task = this.readSnapshot(join(this.tasksDirectory, entry.name));
      if (task.id !== taskId) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Task snapshot filename ${entry.name} does not match task id ${task.id}`,
        );
      }
      tasks.push(task);
    }
    return tasks;
  }

  findActiveByCorrelation(correlationKey: string): OpsWorkerTask | undefined {
    return this.list().find(
      (task) =>
        task.source.correlationKey === correlationKey
        && !isOpsWorkerTerminalState(task.state),
    );
  }

  create(
    value: unknown,
    audit: OpsWorkerAuditInput = { event: "CREATED" },
  ): OpsWorkerTaskStoreCreateResult {
    const supplied = parseOpsWorkerTask(value, this.registry);
    const task = parseOpsWorkerTask({
      ...supplied,
      submissionFingerprint: hashOpsWorkerCanonicalSubmission(supplied),
    }, this.registry);
    if (serializedDeliveryReceipts(task).size > 0) {
      throw new OpsWorkerTaskStoreSafetyError(
        "Delivery receipts may be created only by Alertmanager correlation reuse",
      );
    }
    assertAuditInput(audit);
    return this.withMutationLock(() => {
      this.ensureSafeDirectories();
      const currentTasks = this.list();
      const deliveryMatches = currentTasks.filter((candidate) =>
        deliveryFingerprints(candidate, task.source.deliveryKey).size > 0);
      if (deliveryMatches.length > 1) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Multiple tasks own delivery key ${JSON.stringify(task.source.deliveryKey)}`,
        );
      }
      const replay = deliveryMatches[0];
      if (replay) {
        this.assertGlobalInvariants(currentTasks);
        if (!deliveryFingerprints(replay, task.source.deliveryKey).has(
          task.submissionFingerprint,
        )) {
          throw new OpsWorkerDeliveryConflictError(task.source.deliveryKey, replay.id);
        }
        return {
          task: replay,
          created: false,
          snapshotPath: this.snapshotPath(replay.id),
          journalAppended: false,
        };
      }
      const snapshotPath = this.snapshotPath(task.id);
      if (assertPathMissingOrRegularFile(snapshotPath)) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to replace existing task ${task.id} through create`,
        );
      }
      this.assertJournalSafe();
      this.assertGlobalInvariants([...currentTasks, task]);
      this.injectFault("after-correlation-check");
      return {
        task,
        created: true,
        ...this.write(task, snapshotPath, audit),
      };
    });
  }

  /**
   * Atomically reuse one active correlation while retaining every accepted
   * Alertmanager delivery fingerprint for permanent replay after termination.
   */
  createOrReuseActiveCorrelation(
    value: unknown,
    audit: OpsWorkerAuditInput = { event: "CREATED" },
  ): OpsWorkerTaskStoreCreateResult {
    const supplied = parseOpsWorkerTask(value, this.registry);
    const task = parseOpsWorkerTask({
      ...supplied,
      submissionFingerprint: hashOpsWorkerCanonicalSubmission(supplied),
    }, this.registry);
    if (task.source.kind !== "alertmanager") {
      throw new OpsWorkerTaskStoreSafetyError(
        "Active-correlation delivery reuse is restricted to Alertmanager submissions",
      );
    }
    if (serializedDeliveryReceipts(task).size > 0) {
      throw new OpsWorkerTaskStoreSafetyError(
        "Alertmanager submissions cannot supply store-owned delivery receipts",
      );
    }
    assertAuditInput(audit);
    return this.withMutationLock(() => {
      this.ensureSafeDirectories();
      const currentTasks = this.list();
      const deliveryOwners = currentTasks.filter((candidate) =>
        deliveryFingerprints(candidate, task.source.deliveryKey).size > 0);
      if (deliveryOwners.length > 1) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Multiple tasks own delivery key ${JSON.stringify(task.source.deliveryKey)}`,
        );
      }
      const deliveryOwner = deliveryOwners[0];
      if (
        deliveryOwner
        && deliveryFingerprints(deliveryOwner, task.source.deliveryKey)
          .has(task.submissionFingerprint)
      ) {
        this.assertGlobalInvariants(currentTasks);
        if (!isOpsWorkerTerminalState(deliveryOwner.state)) {
          const working = structuredClone(deliveryOwner);
          this.refreshAcceptedFiringObservation(working, task);
          compactOpsWorkerEvidenceForSnapshot(working);
          const persisted = parseOpsWorkerTask(working, this.registry);
          this.assertImmutableIdentity(deliveryOwner, persisted);
          this.assertReplaySafety(deliveryOwner, persisted);
          this.assertJournalSafe();
          this.assertGlobalInvariants(this.withReplacement(currentTasks, persisted));
          this.injectFault("after-correlation-check");
          return {
            task: persisted,
            created: false,
            ...this.write(persisted, this.snapshotPath(persisted.id), {
              event: "EVIDENCE",
              summary: "Refreshed accepted Alertmanager firing observation",
            }),
          };
        }
        return {
          task: deliveryOwner,
          created: false,
          snapshotPath: this.snapshotPath(deliveryOwner.id),
          journalAppended: false,
        };
      }

      const activeCorrelationOwners = currentTasks.filter((candidate) =>
        candidate.source.correlationKey === task.source.correlationKey
        && !isOpsWorkerTerminalState(candidate.state));
      if (activeCorrelationOwners.length > 1) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Multiple active tasks own correlation key ${JSON.stringify(task.source.correlationKey)}`,
        );
      }
      const activeOwner = activeCorrelationOwners[0];
      if (deliveryOwner && deliveryOwner.id !== activeOwner?.id) {
        throw new OpsWorkerDeliveryConflictError(
          task.source.deliveryKey,
          deliveryOwner.id,
        );
      }
      if (activeOwner) {
        const working = structuredClone(activeOwner);
        const reportPayloadHash = hashOpsWorkerReportPayload(working);
        const receiptCount = working.evidence.filter((evidence) =>
          parseDeliveryReceipt(evidence) !== undefined).length;
        if (receiptCount >= MAX_ACTIVE_CORRELATION_DELIVERY_RECEIPTS) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Task ${activeOwner.id} has no durable delivery-receipt capacity`,
          );
        }
        const receipt: OpsWorkerDeliveryReceipt = {
          type: "alertmanager-delivery-receipt-v1",
          deliveryKey: task.source.deliveryKey,
          submissionFingerprint: task.submissionFingerprint,
        };
        const observedAt = this.refreshAcceptedFiringObservation(working, task);
        this.mergeCoalescedAlertEvidence(working, task);
        this.reconcileUnclaimedReportForEvidenceChange(
          working,
          reportPayloadHash,
          observedAt,
        );
        try {
          appendOpsWorkerEvidence(working, {
            at: observedAt,
            kind: "system",
            trust: "trusted",
            summary: JSON.stringify(receipt),
            artifact: null,
          });
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          throw new OpsWorkerTaskStoreSafetyError(
            `Task ${activeOwner.id} has no durable delivery-receipt capacity`,
          );
        }
        compactOpsWorkerEvidenceForSnapshot(working);
        const persisted = parseOpsWorkerTask(working, this.registry);
        this.assertImmutableIdentity(activeOwner, persisted);
        this.assertReplaySafety(activeOwner, persisted, receipt);
        this.assertJournalSafe();
        this.assertGlobalInvariants(this.withReplacement(currentTasks, persisted));
        this.injectFault("after-correlation-check");
        return {
          task: persisted,
          created: false,
          ...this.write(persisted, this.snapshotPath(persisted.id), {
            event: "EVIDENCE",
            summary: "Recorded coalesced Alertmanager delivery receipt",
          }),
        };
      }
      if (deliveryOwner) {
        throw new OpsWorkerDeliveryConflictError(
          task.source.deliveryKey,
          deliveryOwner.id,
        );
      }

      const snapshotPath = this.snapshotPath(task.id);
      if (assertPathMissingOrRegularFile(snapshotPath)) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to replace existing task ${task.id} through create`,
        );
      }
      this.refreshAcceptedFiringObservation(task, task, true);
      compactOpsWorkerEvidenceForSnapshot(task);
      const persisted = parseOpsWorkerTask(task, this.registry);
      this.assertJournalSafe();
      this.assertGlobalInvariants([...currentTasks, persisted]);
      this.injectFault("after-correlation-check");
      return {
        task: persisted,
        created: true,
        ...this.write(persisted, snapshotPath, audit),
      };
    });
  }

  replace(
    value: unknown,
    audit: OpsWorkerAuditInput = { event: "UPDATED" },
  ): OpsWorkerTaskStoreWriteResult {
    const task = parseOpsWorkerTask(value, this.registry);
    assertAuditInput(audit);
    return this.withMutationLock(() => {
      this.ensureSafeDirectories();
      const snapshotPath = this.snapshotPath(task.id);
      const existing = this.readSnapshot(snapshotPath);
      this.assertImmutableIdentity(existing, task);
      this.assertReplaySafety(existing, task);
      this.assertJournalSafe();
      this.assertGlobalInvariants(this.withReplacement(this.list(), task));
      this.injectFault("after-correlation-check");
      return this.write(task, snapshotPath, audit);
    });
  }

  mutate(
    taskId: string,
    audit: OpsWorkerAuditInput,
    callback: (
      task: OpsWorkerTask,
    ) => void | typeof OPS_WORKER_TASK_STORE_NO_CHANGE,
  ): OpsWorkerTaskStoreMutationResult {
    assertOpsWorkerTaskId(taskId);
    assertAuditInput(audit);
    if (typeof callback !== "function") {
      throw new OpsWorkerTaskStoreSafetyError("Task mutation callback must be a function");
    }
    return this.withMutationLock(() => {
      this.ensureSafeDirectories();
      const snapshotPath = this.snapshotPath(taskId);
      const existing = this.readSnapshot(snapshotPath);
      const working = structuredClone(existing);
      const returned = callback(working);
      if (returned === OPS_WORKER_TASK_STORE_NO_CHANGE) {
        return {
          task: existing,
          snapshotPath,
          journalAppended: false,
        };
      }
      compactOpsWorkerEvidenceForSnapshot(working);
      const task = parseOpsWorkerTask(working, this.registry);
      this.assertImmutableIdentity(existing, task);
      this.assertReplaySafety(existing, task);
      this.assertJournalSafe();
      this.assertGlobalInvariants(this.withReplacement(this.list(), task));
      this.injectFault("after-correlation-check");
      return {
        task,
        ...this.write(task, snapshotPath, audit),
      };
    });
  }

  appendSteering(
    taskId: string,
    entry: OpsWorkerSteeringEntry,
    audit: OpsWorkerAuditInput = {
      event: "EVIDENCE",
      summary: "Recorded durable operator steering",
    },
  ): OpsWorkerTaskStoreMutationResult {
    return this.mutate(taskId, audit, (task) => {
      if (!this.appendSteeringEntry(task, entry)) {
        return OPS_WORKER_TASK_STORE_NO_CHANGE;
      }
      task.updatedAt = this.nextUpdatedAt(task);
      this.assertSteeringCapacity(task);
    });
  }

  appendSteeringAndMutate(
    taskId: string,
    entry: OpsWorkerSteeringEntry,
    audit: OpsWorkerAuditInput,
    callback: (task: OpsWorkerTask) => void,
  ): OpsWorkerTaskStoreMutationResult {
    return this.mutate(taskId, audit, (task) => {
      if (!this.appendSteeringEntry(task, entry)) {
        return OPS_WORKER_TASK_STORE_NO_CHANGE;
      }
      callback(task);
      this.assertSteeringCapacity(task);
    });
  }

  appendSteeringAndSetPaused(
    taskId: string,
    entry: OpsWorkerSteeringEntry,
    paused: boolean,
  ): OpsWorkerTaskStoreMutationResult {
    if (typeof paused !== "boolean") {
      throw new OpsWorkerTaskStoreSafetyError("Paused state must be a boolean");
    }
    return this.mutate(taskId, {
      event: "UPDATED",
      summary: paused
        ? "Recorded operator steering and paused task atomically"
        : "Recorded operator steering and resumed task atomically",
    }, (task) => {
      if (!this.appendSteeringEntry(task, entry)) {
        return OPS_WORKER_TASK_STORE_NO_CHANGE;
      }
      if (task.control.paused !== paused) {
        if (paused && isOpsWorkerTerminalState(task.state)) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Refusing to pause terminal task ${task.id}`,
          );
        }
        task.control.paused = paused;
      }
      const now = this.nextUpdatedAt(task);
      task.control.pausedAt = task.control.paused ? now : null;
      task.updatedAt = now;
      this.assertSteeringCapacity(task);
    });
  }

  appendSteeringAndSetInterrupt(
    taskId: string,
    entry: OpsWorkerSteeringEntry,
    interrupt: OpsWorkerInterrupt,
  ): OpsWorkerTaskStoreMutationResult {
    return this.mutate(taskId, {
      event: "UPDATED",
      summary: `Recorded operator steering and ${interrupt.mode} interrupt atomically`,
    }, (task) => {
      if (!this.appendSteeringEntry(task, entry)) {
        return OPS_WORKER_TASK_STORE_NO_CHANGE;
      }
      let startsPause = false;
      if (task.control.interrupt !== null) {
        if (
          task.control.interrupt.mode !== interrupt.mode
          || task.control.interrupt.reason !== interrupt.reason
        ) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Task ${task.id} already has a different pending interrupt`,
          );
        }
      } else {
        if (isOpsWorkerTerminalState(task.state)) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Refusing an interrupt for terminal task ${task.id}`,
          );
        }
        task.control.interrupt = structuredClone(interrupt);
        if (interrupt.mode === "pause" && !task.control.paused) {
          task.control.paused = true;
          startsPause = true;
        }
      }
      const now = this.nextUpdatedAt(task);
      if (startsPause) task.control.pausedAt = now;
      task.updatedAt = now;
      this.assertSteeringCapacity(task);
    });
  }

  setPaused(
    taskId: string,
    paused: boolean,
    audit: OpsWorkerAuditInput = {
      event: "UPDATED",
      summary: paused ? "Paused task at a safe boundary" : "Resumed task scheduling",
    },
  ): OpsWorkerTaskStoreMutationResult {
    if (typeof paused !== "boolean") {
      throw new OpsWorkerTaskStoreSafetyError("Paused state must be a boolean");
    }
    return this.mutate(taskId, audit, (task) => {
      if (task.control.paused === paused) {
        return OPS_WORKER_TASK_STORE_NO_CHANGE;
      }
      if (paused && isOpsWorkerTerminalState(task.state)) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to pause terminal task ${task.id}`,
        );
      }
      const now = this.nextUpdatedAt(task);
      task.control.paused = paused;
      task.control.pausedAt = paused ? now : null;
      task.updatedAt = now;
    });
  }

  clearPaused(
    taskId: string,
    audit?: OpsWorkerAuditInput,
  ): OpsWorkerTaskStoreMutationResult {
    return audit === undefined
      ? this.setPaused(taskId, false)
      : this.setPaused(taskId, false, audit);
  }

  setInterrupt(
    taskId: string,
    interrupt: OpsWorkerInterrupt,
    audit: OpsWorkerAuditInput = {
      event: "UPDATED",
      summary: "Recorded durable operator interrupt",
    },
  ): OpsWorkerTaskStoreMutationResult {
    return this.mutate(taskId, audit, (task) => {
      if (task.control.interrupt !== null) {
        if (
          task.control.interrupt.mode === interrupt.mode
          && task.control.interrupt.reason === interrupt.reason
        ) {
          return OPS_WORKER_TASK_STORE_NO_CHANGE;
        }
        throw new OpsWorkerTaskStoreSafetyError(
          `Task ${task.id} already has a different pending interrupt`,
        );
      }
      if (isOpsWorkerTerminalState(task.state)) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing an interrupt for terminal task ${task.id}`,
        );
      }
      const now = this.nextUpdatedAt(task);
      task.control.interrupt = structuredClone(interrupt);
      if (interrupt.mode === "pause" && !task.control.paused) {
        task.control.paused = true;
        task.control.pausedAt = now;
      }
      task.updatedAt = now;
    });
  }

  clearInterrupt(
    taskId: string,
    audit: OpsWorkerAuditInput = {
      event: "UPDATED",
      summary: "Cleared durable operator interrupt",
    },
  ): OpsWorkerTaskStoreMutationResult {
    return this.mutate(taskId, audit, (task) => {
      if (task.control.interrupt === null) {
        return OPS_WORKER_TASK_STORE_NO_CHANGE;
      }
      task.control.interrupt = null;
      task.updatedAt = this.nextUpdatedAt(task);
    });
  }

  private nextUpdatedAt(task: Pick<OpsWorkerTask, "updatedAt">): string {
    return new Date(Math.max(
      this.now().getTime(),
      Date.parse(task.updatedAt) + 1,
    )).toISOString();
  }

  private refreshAcceptedFiringObservation(
    task: OpsWorkerTask,
    submission: Readonly<OpsWorkerTask>,
    initial = false,
  ): string {
    const observedAt = new Date(Math.max(
      this.now().getTime(),
      Date.parse(submission.createdAt),
      Date.parse(task.updatedAt) + (initial ? 0 : 1),
    )).toISOString();
    task.evidence = task.evidence.filter((entry) =>
      parseFiringObservation(entry) === undefined);
    appendOpsWorkerEvidence(task, {
      at: observedAt,
      kind: "system",
      trust: "trusted",
      summary: JSON.stringify({
        type: "alertmanager-firing-observation-v1",
        correlationKey: task.source.correlationKey,
        deliveryKey: submission.source.deliveryKey,
      } satisfies OpsWorkerFiringObservation),
      artifact: null,
    });
    // BLOCKED verification is part of the pending durable report identity.
    // The explicit retry transition clears it before checks can resume.
    if (task.state !== "BLOCKED") task.verification = null;
    if (task.state === "CHECKING") task.schedule.nextCheckAt = observedAt;
    task.updatedAt = observedAt;
    return observedAt;
  }

  private mergeCoalescedAlertEvidence(
    task: OpsWorkerTask,
    submission: Readonly<OpsWorkerTask>,
  ): void {
    for (const evidence of submission.evidence) {
      if (
        evidence.kind !== "alert"
        || evidence.trust !== "untrusted"
        || isAlertmanagerGroupCorrelationEvidence(
          evidence,
          submission.source.correlationKey,
        )
      ) continue;
      const duplicate = task.evidence.findIndex((candidate) =>
        candidate.kind === evidence.kind
        && candidate.trust === evidence.trust
        && candidate.summary === evidence.summary
        && candidate.artifact === evidence.artifact);
      if (duplicate >= 0) task.evidence.splice(duplicate, 1);
      appendOpsWorkerEvidence(task, structuredClone(evidence));
    }
  }

  private reconcileUnclaimedReportForEvidenceChange(
    task: OpsWorkerTask,
    previousPayloadHash: string,
    observedAt: string,
  ): void {
    if (hashOpsWorkerReportPayload(task) === previousPayloadHash) return;
    const receipt = task.mutationReceipts.report;
    if (task.report.state !== "PENDING" || receipt === null || receipt.outcome !== null) return;
    if (receipt.mutationStartedAt !== null) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Task ${task.id} cannot change report evidence while its report delivery is unresolved`,
      );
    }
    receipt.outcome = {
      recordedAt: new Date(Math.max(
        Date.parse(observedAt),
        Date.parse(receipt.queryObservedAt),
      )).toISOString(),
      result: "NOT_NEEDED",
      evidenceHash: `sha256:${createHash("sha256").update(JSON.stringify({
        taskId: task.id,
        operationId: receipt.operationId,
        reason: "unclaimed report payload superseded by evolving Alertmanager evidence",
      })).digest("hex")}`,
    };
    task.report.attempts = 0;
    task.report.lastError = null;
  }

  private appendSteeringEntry(
    task: OpsWorkerTask,
    entry: OpsWorkerSteeringEntry,
  ): boolean {
    const existing = task.steering.find(
      (candidate) => candidate.steeringId === entry.steeringId,
    );
    if (existing) {
      if (
        existing.receivedAt === entry.receivedAt
        && existing.kind === entry.kind
        && existing.operatorRef === entry.operatorRef
        && existing.text === entry.text
        && (
          existing.consumedAt === entry.consumedAt
          || entry.consumedAt === null
        )
      ) return false;
      throw new OpsWorkerTaskStoreSafetyError(
        `Steering id ${JSON.stringify(entry.steeringId)} conflicts with its durable record`,
      );
    }
    if (isOpsWorkerTerminalState(task.state)) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing new steering for terminal task ${task.id}`,
      );
    }
    if (task.steering.length >= OPS_WORKER_LIMITS.maxSteeringEntries) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Task steering exceeds ${OPS_WORKER_LIMITS.maxSteeringEntries} entries`,
      );
    }
    task.steering.push(structuredClone(entry));
    task.verification = null;
    if (
      task.state === "CHECKING"
      && (entry.kind === "correction" || entry.kind === "answer")
    ) {
      task.state = "RESUMABLE";
      task.schedule.nextRunAt = null;
      task.schedule.nextCheckAt = null;
    }
    return true;
  }

  private assertSteeringCapacity(task: OpsWorkerTask): void {
    if (
      Buffer.byteLength(serializeOpsWorkerPendingSteering(task.steering).text, "utf8")
        > OPS_WORKER_LIMITS.maxPendingSteeringPromptBytes
      ||
      Buffer.byteLength(`${JSON.stringify(task)}\n`, "utf8")
      > OPS_WORKER_LIMITS.maxSnapshotBytes
        - OPS_WORKER_LIMITS.minRuntimeMutationHeadroomBytes
    ) {
      throw new OpsWorkerSteeringCapacityError(task.id);
    }
  }

  private ensureSafeDirectories(): void {
    if (ensureDirectory(this.stateDirectory)) {
      fsyncDirectory(dirname(this.stateDirectory));
    }
    if (ensureDirectory(this.tasksDirectory)) {
      fsyncDirectory(this.stateDirectory);
    }
  }

  private withMutationLock<T>(operation: () => T): T {
    this.ensureSafeDirectories();
    const guard = new OpsWorkerTaskStoreMutationGuard(
      this.stateDirectory,
      this.faultInjector,
    );
    guard.acquire();
    try {
      return operation();
    } finally {
      guard.release();
    }
  }

  private snapshotPath(taskId: string): string {
    assertOpsWorkerTaskId(taskId);
    return join(this.tasksDirectory, `${taskId}${SNAPSHOT_SUFFIX}`);
  }

  private readSnapshot(path: string): OpsWorkerTask {
    const raw = readRegularFile(path, OPS_WORKER_LIMITS.maxSnapshotBytes);
    return parseOpsWorkerTaskJson(raw, this.registry);
  }

  private assertJournalSafe(): void {
    const stats = assertPathMissingOrRegularFile(this.journalPath);
    if (stats && (stats.mode & 0o777) !== 0o600) {
      chmodSync(this.journalPath, 0o600);
    }
  }

  private assertImmutableIdentity(existing: OpsWorkerTask, replacement: OpsWorkerTask): void {
    if (
      existing.id !== replacement.id
      || existing.createdAt !== replacement.createdAt
      || JSON.stringify(existing.source) !== JSON.stringify(replacement.source)
      || JSON.stringify(existing.resource) !== JSON.stringify(replacement.resource)
      || existing.submissionFingerprint !== replacement.submissionFingerprint
      || existing.objective !== replacement.objective
      || JSON.stringify(existing.doneCheck) !== JSON.stringify(replacement.doneCheck)
      || JSON.stringify(existing.authorization) !== JSON.stringify(replacement.authorization)
      || JSON.stringify(existing.legacyCompletion)
        !== JSON.stringify(replacement.legacyCompletion)
    ) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing to change immutable identity of task ${existing.id}`,
      );
    }
    for (const slot of Object.keys(existing.lifecycle) as Array<
      keyof OpsWorkerTask["lifecycle"]
    >) {
      const current = existing.lifecycle[slot];
      if (typeof current === "string" && replacement.lifecycle[slot] !== current) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to change write-once lifecycle identity ${slot} of task ${existing.id}`,
        );
      }
    }
  }

  private assertReplaySafety(
    existing: OpsWorkerTask,
    replacement: OpsWorkerTask,
    allowedDeliveryReceipt?: OpsWorkerDeliveryReceipt,
  ): void {
    if (
      isOpsWorkerTerminalState(existing.state)
      && replacement.steering.length !== existing.steering.length
    ) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing new steering for terminal task ${existing.id}`,
      );
    }
    if (replacement.steering.length < existing.steering.length) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing to erase steering history for task ${existing.id}`,
      );
    }
    for (let index = 0; index < existing.steering.length; index += 1) {
      const prior = existing.steering[index];
      const next = replacement.steering[index];
      if (
        next === undefined
        || prior.steeringId !== next.steeringId
        || prior.receivedAt !== next.receivedAt
        || prior.kind !== next.kind
        || prior.operatorRef !== next.operatorRef
        || prior.text !== next.text
      ) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to erase, reorder, or change steering entry ${prior.steeringId}`,
        );
      }
      if (
        prior.consumedAt !== null
        && next.consumedAt !== prior.consumedAt
      ) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to change consumed steering entry ${prior.steeringId}`,
        );
      }
    }
    const existingDeliveryReceipts = serializedDeliveryReceipts(existing);
    const replacementDeliveryReceipts = serializedDeliveryReceipts(replacement);
    for (const receipt of existingDeliveryReceipts) {
      if (!replacementDeliveryReceipts.has(receipt)) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to erase durable delivery receipt from task ${existing.id}`,
        );
      }
    }
    const allowedReceipt = allowedDeliveryReceipt === undefined
      ? undefined
      : JSON.stringify(allowedDeliveryReceipt);
    for (const receipt of replacementDeliveryReceipts) {
      if (!existingDeliveryReceipts.has(receipt) && receipt !== allowedReceipt) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing caller-supplied delivery receipt for task ${existing.id}`,
        );
      }
    }
    const priorAuthorization = existing.authorizationVerification;
    const nextAuthorization = replacement.authorizationVerification;
    if (priorAuthorization !== null) {
      if (nextAuthorization === null) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to erase authorization verification for task ${existing.id}`,
        );
      }
      const priorCheckedAt = Date.parse(priorAuthorization.checkedAt);
      const nextCheckedAt = Date.parse(nextAuthorization.checkedAt);
      if (nextCheckedAt < priorCheckedAt) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to move authorization verification backwards for task ${existing.id}`,
        );
      }
      if (
        nextCheckedAt === priorCheckedAt
        && JSON.stringify(nextAuthorization) !== JSON.stringify(priorAuthorization)
      ) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to change authorization evidence at the same checked time for task ${existing.id}`,
        );
      }
    }
    const checkpointIdentities = (
      task: OpsWorkerTask,
    ): ReadonlyMap<string, string> => {
      const identities = new Map<string, string>();
      if (task.currentCheckpoint !== null) {
        for (const replay of task.currentCheckpoint.replayHistory) {
          identities.set(replay.checkpointId, replay.contentHash);
        }
        identities.set(
          task.currentCheckpoint.checkpointId,
          checkpointContentHash(task.currentCheckpoint),
        );
      }
      return identities;
    };
    const priorCheckpoints = checkpointIdentities(existing);
    const nextCheckpoints = checkpointIdentities(replacement);
    const priorCurrentCheckpointId = existing.currentCheckpoint?.checkpointId;
    const nextCurrentCheckpointId = replacement.currentCheckpoint?.checkpointId;
    if (
      priorCurrentCheckpointId !== undefined
      && nextCurrentCheckpointId !== undefined
      && nextCurrentCheckpointId !== priorCurrentCheckpointId
      && priorCheckpoints.has(nextCurrentCheckpointId)
    ) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing to restore historical checkpoint ${nextCurrentCheckpointId}`,
      );
    }
    for (const [checkpointId, contentHash] of priorCheckpoints) {
      if (nextCheckpoints.get(checkpointId) !== contentHash) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing to forget or change checkpoint replay identity ${checkpointId}`,
        );
      }
    }

    for (const slot of Object.keys(existing.mutationReceipts) as Array<
      keyof OpsWorkerTask["mutationReceipts"]
    >) {
      const current = existing.mutationReceipts[slot];
      const next = replacement.mutationReceipts[slot];
      if (current?.outcome === null) {
        if (
          next === null
          || next.operationId !== current.operationId
          || next.intentHash !== current.intentHash
        ) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Refusing to forget unfinished ${current.boundary} operation ${current.operationId}`,
          );
        }
        const currentQueryAt = Date.parse(current.queryObservedAt);
        const nextQueryAt = Date.parse(next.queryObservedAt);
        if (nextQueryAt < currentQueryAt) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Refusing to move ${current.boundary} query observation backwards`,
          );
        }
        if (
          nextQueryAt === currentQueryAt
          && next.queryResultHash !== current.queryResultHash
        ) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Refusing to change ${current.boundary} query evidence at the same observation time`,
          );
        }
        if (current.mutationStartedAt !== null) {
          if (next.mutationStartedAt === null) {
            if (
              next.outcome !== null
              || nextQueryAt <= Date.parse(current.mutationStartedAt)
            ) {
              throw new OpsWorkerTaskStoreSafetyError(
                `Refusing to erase claimed ${current.boundary} operation ${current.operationId} without a strictly newer unfinished query`,
              );
            }
          } else if (next.mutationStartedAt !== current.mutationStartedAt) {
            throw new OpsWorkerTaskStoreSafetyError(
              `Refusing to change the durable claim time for ${current.boundary} operation ${current.operationId}`,
            );
          }
        } else if (
          next.mutationStartedAt !== null
          && (
            next.queryObservedAt !== current.queryObservedAt
            || next.queryResultHash !== current.queryResultHash
          )
        ) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Refusing to claim ${current.boundary} operation ${current.operationId} against unrecorded query evidence`,
          );
        }
      }
      const completedIdentities = (
        receipt: typeof current,
      ): ReadonlyMap<string, string> => {
        const identities = new Map<string, string>();
        if (receipt === null) return identities;
        for (const replay of receipt.replayHistory) {
          identities.set(
            replay.operationId,
            JSON.stringify({
              intentHash: replay.intentHash,
              result: replay.result,
              evidenceHash: replay.evidenceHash,
            }),
          );
        }
        if (receipt.outcome !== null) {
          identities.set(
            receipt.operationId,
            JSON.stringify({
              intentHash: receipt.intentHash,
              result: receipt.outcome.result,
              evidenceHash: receipt.outcome.evidenceHash,
            }),
          );
        }
        return identities;
      };
      const priorOperations = completedIdentities(current);
      const nextOperations = completedIdentities(next);
      for (const [operationId, fingerprint] of priorOperations) {
        if (nextOperations.get(operationId) !== fingerprint) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Refusing to forget or change completed ${slot} operation ${operationId}`,
          );
        }
      }
    }
  }

  private withReplacement(
    tasks: readonly OpsWorkerTask[],
    replacement: OpsWorkerTask,
  ): OpsWorkerTask[] {
    let found = false;
    const prospective = tasks.map((task) => {
      if (task.id !== replacement.id) return task;
      found = true;
      return replacement;
    });
    if (!found) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Cannot replace missing task ${replacement.id}`,
      );
    }
    return prospective;
  }

  private assertGlobalInvariants(tasks: readonly OpsWorkerTask[]): void {
    const deliveryOwners = new Map<string, string>();
    const activeCorrelationOwners = new Map<string, string>();
    const heldOwners: string[] = [];
    for (const task of tasks) {
      const taskDeliveryKeys = new Set([task.source.deliveryKey]);
      for (const evidence of task.evidence) {
        const receipt = parseDeliveryReceipt(evidence);
        if (receipt) {
          if (task.source.kind !== "alertmanager") {
            throw new OpsWorkerTaskStoreSafetyError(
              `Non-Alertmanager task ${task.id} contains a delivery receipt`,
            );
          }
          taskDeliveryKeys.add(receipt.deliveryKey);
        }
      }
      for (const deliveryKey of taskDeliveryKeys) {
        const deliveryOwner = deliveryOwners.get(deliveryKey);
        if (deliveryOwner && deliveryOwner !== task.id) {
          throw new OpsWorkerTaskStoreSafetyError(
            `Multiple tasks own delivery key ${JSON.stringify(deliveryKey)}`,
          );
        }
        deliveryOwners.set(deliveryKey, task.id);
      }

      if (!isOpsWorkerTerminalState(task.state)) {
        const correlationOwner = activeCorrelationOwners.get(task.source.correlationKey);
        if (correlationOwner && correlationOwner !== task.id) {
          throw new OpsWorkerDuplicateCorrelationError(
            task.source.correlationKey,
            correlationOwner,
          );
        }
        activeCorrelationOwners.set(task.source.correlationKey, task.id);
      }
      if (task.custody.status === "HELD") heldOwners.push(task.id);
    }
    if (heldOwners.length > 1) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing multiple held custody owners: ${heldOwners.join(", ")}`,
      );
    }
  }

  private write(
    task: OpsWorkerTask,
    snapshotPath: string,
    audit: OpsWorkerAuditInput,
  ): OpsWorkerTaskStoreWriteResult {
    const serialized = stableTaskJson(task);
    const temporaryPath = join(
      this.tasksDirectory,
      `.${task.id}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
    );
    let descriptor: number | undefined;
    let renamed = false;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      writeFileSync(descriptor, serialized, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.injectFault("after-temp-file-fsync");

      // Recheck immediately before replacement so a pre-existing symlink is
      // rejected rather than silently becoming part of the store contract.
      assertPathMissingOrRegularFile(snapshotPath);
      renameSync(temporaryPath, snapshotPath);
      renamed = true;
      this.injectFault("after-snapshot-rename");

      fsyncDirectory(this.tasksDirectory);
      this.injectFault("after-task-directory-fsync");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      // A successful rename consumes the temp name. On other failures leave
      // it behind exactly as a process crash would; list() deliberately ignores
      // temp names and a later write uses a fresh unpredictable name.
      if (renamed) {
        try {
          unlinkSync(temporaryPath);
        } catch (error) {
          if (!isMissingError(error)) throw error;
        }
      }
    }

    this.injectFault("before-journal-append");
    const journalAppended = this.appendJournal(task, audit);
    return { snapshotPath, journalAppended };
  }

  private appendJournal(task: OpsWorkerTask, audit: OpsWorkerAuditInput): boolean {
    const entry: OpsWorkerJournalEntry = {
      schemaVersion: OPS_WORKER_JOURNAL_SCHEMA_VERSION,
      at: this.now().toISOString(),
      taskId: task.id,
      correlationKey: task.source.correlationKey,
      state: task.state,
      taskUpdatedAt: task.updatedAt,
      event: audit.event,
      summary: audit.summary ?? null,
    };
    let line = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_OPS_WORKER_JOURNAL_ENTRY_BYTES) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Journal entry exceeds ${MAX_OPS_WORKER_JOURNAL_ENTRY_BYTES} bytes`,
      );
    }

    const existed = assertPathMissingOrRegularFile(this.journalPath) !== undefined;
    const descriptor = openSync(
      this.journalPath,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW,
      0o600,
    );
    try {
      const stats = fstatSync(descriptor);
      if (!stats.isFile()) {
        throw new OpsWorkerTaskStoreSafetyError(
          `Refusing journal ${this.journalPath}: descriptor is not a regular file`,
        );
      }
      assertOwnedByCurrentUser(this.journalPath, stats);
      const needsSeparator = stats.size > 0 && !this.journalEndsWithNewline(stats.size);
      if (needsSeparator) line = `\n${line}`;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (stats.size + lineBytes > this.maxJournalBytes) {
        return false;
      }
      writeSync(descriptor, line, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(this.journalPath, 0o600);
    if (!existed) fsyncDirectory(this.stateDirectory);
    this.injectFault("after-journal-fsync");
    return true;
  }

  private journalEndsWithNewline(size: number): boolean {
    const descriptor = openSync(this.journalPath, constants.O_RDONLY | NO_FOLLOW);
    try {
      const finalByte = Buffer.allocUnsafe(1);
      const bytesRead = readSync(descriptor, finalByte, 0, 1, size - 1);
      return bytesRead === 1 && finalByte[0] === 0x0a;
    } finally {
      closeSync(descriptor);
    }
  }

  private injectFault(point: OpsWorkerTaskStoreFaultPoint): void {
    this.faultInjector?.(point);
  }
}
