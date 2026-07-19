import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION = 2 as const;
export const OPS_WORKER_CONTROL_LEDGER_V1_SCHEMA_VERSION = 1 as const;
export const OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES = 256;
export const OPS_WORKER_CONTROL_LEDGER_MAX_BYTES = 128 * 1024;
export const OPS_WORKER_TELEGRAM_UPDATE_ID_IDLE_RESET_MS = 7 * 24 * 60 * 60 * 1_000;

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface OpsWorkerProcessedTelegramUpdate {
  epoch: number;
  updateId: number;
  fingerprint: string;
}

export interface OpsWorkerControlLedgerState {
  schemaVersion: typeof OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION;
  epoch: number;
  lastAckedUpdateId: number | null;
  lastAckedAt: string | null;
  processedUpdates: OpsWorkerProcessedTelegramUpdate[];
}

export interface OpsWorkerControlLedgerPollCursor {
  epoch: number;
  offset: number | undefined;
  resynchronizing: boolean;
}

export interface OpsWorkerControlLedgerRecordOptions {
  epoch?: number;
  acknowledgedAt?: Date;
}

export interface OpsWorkerControlLedgerRecordResult {
  state: OpsWorkerControlLedgerState;
  recorded: boolean;
  replayed: boolean;
}

export type OpsWorkerControlLedgerFaultPoint =
  | "after-temp-file-fsync"
  | "after-ledger-rename"
  | "after-control-directory-fsync";

export interface OpsWorkerControlLedgerOptions {
  maxProcessedUpdates?: number;
  /** Test-only crash-boundary hook. Production callers should leave this unset. */
  faultInjector?: (point: OpsWorkerControlLedgerFaultPoint) => void;
}

export class OpsWorkerControlLedgerSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsWorkerControlLedgerSafetyError";
  }
}

function freshLedger(): OpsWorkerControlLedgerState {
  return {
    schemaVersion: OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION,
    epoch: 0,
    lastAckedUpdateId: null,
    lastAckedAt: null,
    processedUpdates: [],
  };
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertPlainObject(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) {
    throw new OpsWorkerControlLedgerSafetyError(`${path} must be a plain object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new OpsWorkerControlLedgerSafetyError(`${path}.${key} is an unknown field`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new OpsWorkerControlLedgerSafetyError(`${path}.${key} is required`);
    }
  }
}

function assertUpdateId(value: unknown, path: string): asserts value is number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < 0
    || (value as number) >= Number.MAX_SAFE_INTEGER
  ) {
    throw new OpsWorkerControlLedgerSafetyError(
      `${path} must be a non-negative safe integer below Number.MAX_SAFE_INTEGER`,
    );
  }
}

function assertEpoch(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new OpsWorkerControlLedgerSafetyError(
      `${path} must be a non-negative safe integer`,
    );
  }
}

function assertTimestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new OpsWorkerControlLedgerSafetyError(`${path} must be a canonical timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new OpsWorkerControlLedgerSafetyError(`${path} must be a canonical timestamp`);
  }
}

function canonicalDate(value: Date, path: string): string {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new OpsWorkerControlLedgerSafetyError(`${path} must be a valid date`);
  }
  return new Date(milliseconds).toISOString();
}

function assertFingerprint(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    throw new OpsWorkerControlLedgerSafetyError(
      `${path} must be a lowercase sha256:<hex> fingerprint`,
    );
  }
}

function parseLedger(raw: string, legacyAcknowledgedAt: string): OpsWorkerControlLedgerState {
  if (Buffer.byteLength(raw, "utf8") > OPS_WORKER_CONTROL_LEDGER_MAX_BYTES) {
    throw new OpsWorkerControlLedgerSafetyError(
      `Control ledger exceeds ${OPS_WORKER_CONTROL_LEDGER_MAX_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OpsWorkerControlLedgerSafetyError(`Control ledger is malformed JSON: ${message}`);
  }
  assertPlainObject(value, "control ledger");
  const legacy = value.schemaVersion === OPS_WORKER_CONTROL_LEDGER_V1_SCHEMA_VERSION;
  if (!legacy && value.schemaVersion !== OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION) {
    throw new OpsWorkerControlLedgerSafetyError(
      `Unsupported control ledger schema version ${JSON.stringify(value.schemaVersion)}`,
    );
  }
  assertExactKeys(
    value,
    legacy
      ? ["schemaVersion", "lastAckedUpdateId", "processedUpdates"]
      : [
          "schemaVersion",
          "epoch",
          "lastAckedUpdateId",
          "lastAckedAt",
          "processedUpdates",
        ],
    "control ledger",
  );
  const epoch = legacy ? 0 : value.epoch;
  assertEpoch(epoch, "control ledger.epoch");
  if (value.lastAckedUpdateId !== null) {
    assertUpdateId(value.lastAckedUpdateId, "control ledger.lastAckedUpdateId");
  }
  const lastAckedAt = legacy
    ? value.lastAckedUpdateId === null ? null : legacyAcknowledgedAt
    : value.lastAckedAt;
  if (lastAckedAt !== null) {
    assertTimestamp(lastAckedAt, "control ledger.lastAckedAt");
  }
  if (!Array.isArray(value.processedUpdates)) {
    throw new OpsWorkerControlLedgerSafetyError(
      "control ledger.processedUpdates must be an array",
    );
  }
  if (
    Object.getPrototypeOf(value.processedUpdates) !== Array.prototype
    || Object.getOwnPropertyNames(value.processedUpdates).length
      !== value.processedUpdates.length + 1
  ) {
    throw new OpsWorkerControlLedgerSafetyError(
      "control ledger.processedUpdates must be a dense plain array",
    );
  }
  if (value.processedUpdates.length > OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES) {
    throw new OpsWorkerControlLedgerSafetyError(
      `Control ledger retains more than ${OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES} updates`,
    );
  }
  let previousEpoch = -1;
  let previousUpdateId = -1;
  const processedUpdates = value.processedUpdates.map((entryValue, index) => {
    const path = `control ledger.processedUpdates[${index}]`;
    assertPlainObject(entryValue, path);
    assertExactKeys(
      entryValue,
      legacy ? ["updateId", "fingerprint"] : ["epoch", "updateId", "fingerprint"],
      path,
    );
    const entryEpoch = legacy ? 0 : entryValue.epoch;
    assertEpoch(entryEpoch, `${path}.epoch`);
    assertUpdateId(entryValue.updateId, `${path}.updateId`);
    assertFingerprint(entryValue.fingerprint, `${path}.fingerprint`);
    if (
      entryEpoch < previousEpoch
      || (entryEpoch === previousEpoch && entryValue.updateId <= previousUpdateId)
    ) {
      throw new OpsWorkerControlLedgerSafetyError(
        "Control ledger update ids must be strictly increasing within ordered epochs",
      );
    }
    previousEpoch = entryEpoch;
    previousUpdateId = entryValue.updateId;
    return {
      epoch: entryEpoch,
      updateId: entryValue.updateId,
      fingerprint: entryValue.fingerprint,
    };
  });
  if (
    (value.lastAckedUpdateId === null) !== (processedUpdates.length === 0)
    || (value.lastAckedUpdateId === null) !== (lastAckedAt === null)
    || (
      value.lastAckedUpdateId !== null
      && (
        processedUpdates.at(-1)?.epoch !== epoch
        || processedUpdates.at(-1)?.updateId !== value.lastAckedUpdateId
      )
    )
  ) {
    throw new OpsWorkerControlLedgerSafetyError(
      "Control ledger cursor must identify the newest retained update",
    );
  }
  if (processedUpdates.length === 0 && epoch !== 0) {
    throw new OpsWorkerControlLedgerSafetyError(
      "A fresh control ledger must begin at epoch zero",
    );
  }
  return {
    schemaVersion: OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION,
    epoch,
    lastAckedUpdateId: value.lastAckedUpdateId,
    lastAckedAt,
    processedUpdates,
  };
}

function assertOwnedRegularFile(path: string, stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new OpsWorkerControlLedgerSafetyError(
      `Refusing control ledger path ${path}: not a regular file`,
    );
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new OpsWorkerControlLedgerSafetyError(
      `Refusing control ledger path ${path}: not owned by the current user`,
    );
  }
}

function ensureDirectory(path: string): boolean {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new OpsWorkerControlLedgerSafetyError(
        `Refusing control ledger directory ${path}: not a real directory`,
      );
    }
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new OpsWorkerControlLedgerSafetyError(
        `Refusing control ledger directory ${path}: not owned by the current user`,
      );
    }
    return false;
  } catch (error) {
    if (!isMissingError(error)) throw error;
    mkdirSync(path, { mode: 0o700 });
    return true;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fingerprintsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function hashOpsWorkerTelegramUpdate(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export class OpsWorkerControlLedger {
  readonly controlDirectory: string;
  readonly ledgerPath: string;

  private readonly maxProcessedUpdates: number;
  private readonly faultInjector:
    | ((point: OpsWorkerControlLedgerFaultPoint) => void)
    | undefined;

  constructor(stateDirectory: string, options: OpsWorkerControlLedgerOptions = {}) {
    if (!isAbsolute(stateDirectory)) {
      throw new OpsWorkerControlLedgerSafetyError(
        "Ops-worker state directory must be an absolute path",
      );
    }
    const maxProcessedUpdates = options.maxProcessedUpdates
      ?? OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES;
    if (
      !Number.isSafeInteger(maxProcessedUpdates)
      || maxProcessedUpdates < 1
      || maxProcessedUpdates > OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES
    ) {
      throw new OpsWorkerControlLedgerSafetyError(
        `maxProcessedUpdates must be between 1 and ${OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES}`,
      );
    }
    this.controlDirectory = join(stateDirectory, "control");
    this.ledgerPath = join(this.controlDirectory, "telegram.json");
    this.maxProcessedUpdates = maxProcessedUpdates;
    this.faultInjector = options.faultInjector;
    if (ensureDirectory(stateDirectory)) fsyncDirectory(dirname(stateDirectory));
    if (ensureDirectory(this.controlDirectory)) fsyncDirectory(stateDirectory);
  }

  read(): OpsWorkerControlLedgerState {
    let beforeOpen: Stats;
    try {
      beforeOpen = lstatSync(this.ledgerPath);
    } catch (error) {
      if (isMissingError(error)) return freshLedger();
      throw error;
    }
    assertOwnedRegularFile(this.ledgerPath, beforeOpen);
    if (beforeOpen.size > OPS_WORKER_CONTROL_LEDGER_MAX_BYTES) {
      throw new OpsWorkerControlLedgerSafetyError(
        `Control ledger exceeds ${OPS_WORKER_CONTROL_LEDGER_MAX_BYTES} bytes`,
      );
    }
    const descriptor = openSync(this.ledgerPath, constants.O_RDONLY | NO_FOLLOW);
    try {
      const stats = fstatSync(descriptor);
      assertOwnedRegularFile(this.ledgerPath, stats);
      if (stats.ino !== beforeOpen.ino || stats.size > OPS_WORKER_CONTROL_LEDGER_MAX_BYTES) {
        throw new OpsWorkerControlLedgerSafetyError(
          "Control ledger changed identity while being opened",
        );
      }
      return parseLedger(readFileSync(descriptor, "utf8"), stats.mtime.toISOString());
    } finally {
      closeSync(descriptor);
    }
  }

  pollCursor(at: Date = new Date()): OpsWorkerControlLedgerPollCursor {
    const observedAt = canonicalDate(at, "Telegram poll time");
    const current = this.read();
    if (current.lastAckedUpdateId === null || current.lastAckedAt === null) {
      return { epoch: current.epoch, offset: undefined, resynchronizing: false };
    }
    if (
      Date.parse(observedAt) - Date.parse(current.lastAckedAt)
      >= OPS_WORKER_TELEGRAM_UPDATE_ID_IDLE_RESET_MS
    ) {
      if (current.epoch >= Number.MAX_SAFE_INTEGER) {
        throw new OpsWorkerControlLedgerSafetyError(
          "Telegram update-id epoch counter is exhausted",
        );
      }
      return { epoch: current.epoch + 1, offset: undefined, resynchronizing: true };
    }
    return {
      epoch: current.epoch,
      offset: current.lastAckedUpdateId + 1,
      resynchronizing: false,
    };
  }

  nextOffset(at: Date = new Date()): number | undefined {
    return this.pollCursor(at).offset;
  }

  record(
    updateId: number,
    fingerprint: string,
    options: OpsWorkerControlLedgerRecordOptions = {},
  ): OpsWorkerControlLedgerRecordResult {
    assertUpdateId(updateId, "updateId");
    assertFingerprint(fingerprint, "fingerprint");
    const current = this.read();
    const requestedEpoch = options.epoch ?? current.epoch;
    assertEpoch(requestedEpoch, "epoch");
    const rawAcknowledgedAt = canonicalDate(
      options.acknowledgedAt ?? new Date(),
      "Telegram acknowledgement time",
    );
    const acknowledgedAt = current.lastAckedAt === null
      ? rawAcknowledgedAt
      : new Date(Math.max(
          Date.parse(rawAcknowledgedAt),
          Date.parse(current.lastAckedAt),
        )).toISOString();
    const replay = current.processedUpdates.find((entry) =>
      entry.epoch === requestedEpoch && entry.updateId === updateId);
    if (replay) {
      if (!fingerprintsEqual(replay.fingerprint, fingerprint)) {
        throw new OpsWorkerControlLedgerSafetyError(
          `Telegram update ${updateId} conflicts with its durable fingerprint`,
        );
      }
      return { state: current, recorded: false, replayed: true };
    }
    if (requestedEpoch < current.epoch || requestedEpoch > current.epoch + 1) {
      throw new OpsWorkerControlLedgerSafetyError(
        `Telegram update epoch ${requestedEpoch} is not current or the next idle epoch`,
      );
    }
    const beginsNewEpoch = requestedEpoch === current.epoch + 1;
    if (
      beginsNewEpoch
      && (
        current.lastAckedAt === null
        || Date.parse(rawAcknowledgedAt) - Date.parse(current.lastAckedAt)
          < OPS_WORKER_TELEGRAM_UPDATE_ID_IDLE_RESET_MS
      )
    ) {
      throw new OpsWorkerControlLedgerSafetyError(
        "Telegram update-id epoch cannot reset before a full idle week",
      );
    }
    if (
      !beginsNewEpoch
      && current.lastAckedUpdateId !== null
      && updateId <= current.lastAckedUpdateId
    ) {
      throw new OpsWorkerControlLedgerSafetyError(
        `Telegram update ${updateId} is older than the retained replay window`,
      );
    }
    const processedUpdates = [
      ...current.processedUpdates,
      { epoch: requestedEpoch, updateId, fingerprint },
    ].slice(-this.maxProcessedUpdates);
    const next: OpsWorkerControlLedgerState = {
      schemaVersion: OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION,
      epoch: requestedEpoch,
      lastAckedUpdateId: updateId,
      lastAckedAt: acknowledgedAt,
      processedUpdates,
    };
    this.write(next);
    return { state: structuredClone(next), recorded: true, replayed: false };
  }

  private write(state: OpsWorkerControlLedgerState): void {
    const serialized = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > OPS_WORKER_CONTROL_LEDGER_MAX_BYTES) {
      throw new OpsWorkerControlLedgerSafetyError(
        `Control ledger exceeds ${OPS_WORKER_CONTROL_LEDGER_MAX_BYTES} bytes`,
      );
    }
    try {
      const stats = lstatSync(this.ledgerPath);
      assertOwnedRegularFile(this.ledgerPath, stats);
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
    const temporaryPath = join(
      this.controlDirectory,
      `.telegram.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
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
      this.faultInjector?.("after-temp-file-fsync");
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.ledgerPath);
      renamed = true;
      chmodSync(this.ledgerPath, 0o600);
      this.faultInjector?.("after-ledger-rename");
      fsyncDirectory(this.controlDirectory);
      this.faultInjector?.("after-control-directory-fsync");
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      if (renamed) {
        try {
          unlinkSync(temporaryPath);
        } catch (error) {
          if (!isMissingError(error)) throw error;
        }
      }
    }
  }
}
