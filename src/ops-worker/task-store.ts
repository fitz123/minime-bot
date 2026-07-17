import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
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
import { randomBytes } from "node:crypto";
import { isAbsolute, join } from "node:path";
import {
  assertOpsWorkerTaskId,
  isOpsWorkerTerminalState,
  OPS_WORKER_LIMITS,
  parseOpsWorkerTask,
  parseOpsWorkerTaskJson,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "./types.js";

export const OPS_WORKER_JOURNAL_SCHEMA_VERSION = 1 as const;
export const DEFAULT_OPS_WORKER_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
export const MAX_OPS_WORKER_JOURNAL_ENTRY_BYTES = 8 * 1024;

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
  | "after-temp-file-fsync"
  | "after-snapshot-rename"
  | "after-task-directory-fsync"
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

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SNAPSHOT_SUFFIX = ".json";
const JOURNAL_FILE_NAME = "journal.jsonl";
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

function ensureDirectory(path: string): void {
  try {
    verifyDirectory(path);
    return;
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  verifyDirectory(path);
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
  ): OpsWorkerTaskStoreWriteResult {
    const task = parseOpsWorkerTask(value, this.registry);
    assertAuditInput(audit);
    this.ensureSafeDirectories();
    const snapshotPath = this.snapshotPath(task.id);
    if (assertPathMissingOrRegularFile(snapshotPath)) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing to replace existing task ${task.id} through create`,
      );
    }
    this.assertJournalSafe();
    this.assertUniqueActiveCorrelation(task);
    return this.write(task, snapshotPath, audit);
  }

  replace(
    value: unknown,
    audit: OpsWorkerAuditInput = { event: "UPDATED" },
  ): OpsWorkerTaskStoreWriteResult {
    const task = parseOpsWorkerTask(value, this.registry);
    assertAuditInput(audit);
    this.ensureSafeDirectories();
    const snapshotPath = this.snapshotPath(task.id);
    const existing = this.readSnapshot(snapshotPath);
    this.assertImmutableIdentity(existing, task);
    this.assertJournalSafe();
    this.assertUniqueActiveCorrelation(task);
    return this.write(task, snapshotPath, audit);
  }

  private ensureSafeDirectories(): void {
    ensureDirectory(this.stateDirectory);
    ensureDirectory(this.tasksDirectory);
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

  private assertUniqueActiveCorrelation(candidate: OpsWorkerTask): void {
    if (isOpsWorkerTerminalState(candidate.state)) return;
    const duplicate = this.list().find(
      (task) =>
        task.id !== candidate.id
        && !isOpsWorkerTerminalState(task.state)
        && task.source.correlationKey === candidate.source.correlationKey,
    );
    if (duplicate) {
      throw new OpsWorkerDuplicateCorrelationError(
        candidate.source.correlationKey,
        duplicate.id,
      );
    }
  }

  private assertImmutableIdentity(existing: OpsWorkerTask, replacement: OpsWorkerTask): void {
    if (
      existing.id !== replacement.id
      || existing.createdAt !== replacement.createdAt
      || JSON.stringify(existing.source) !== JSON.stringify(replacement.source)
    ) {
      throw new OpsWorkerTaskStoreSafetyError(
        `Refusing to change immutable identity of task ${existing.id}`,
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
