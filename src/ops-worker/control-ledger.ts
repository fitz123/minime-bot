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

export const OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION = 1 as const;
export const OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES = 256;
export const OPS_WORKER_CONTROL_LEDGER_MAX_BYTES = 128 * 1024;

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface OpsWorkerProcessedTelegramUpdate {
  updateId: number;
  fingerprint: string;
}

export interface OpsWorkerControlLedgerState {
  schemaVersion: typeof OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION;
  lastAckedUpdateId: number | null;
  processedUpdates: OpsWorkerProcessedTelegramUpdate[];
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
    lastAckedUpdateId: null,
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

function assertFingerprint(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !FINGERPRINT_PATTERN.test(value)) {
    throw new OpsWorkerControlLedgerSafetyError(
      `${path} must be a lowercase sha256:<hex> fingerprint`,
    );
  }
}

function parseLedger(raw: string): OpsWorkerControlLedgerState {
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
  assertExactKeys(
    value,
    ["schemaVersion", "lastAckedUpdateId", "processedUpdates"],
    "control ledger",
  );
  if (value.schemaVersion !== OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION) {
    throw new OpsWorkerControlLedgerSafetyError(
      `Unsupported control ledger schema version ${JSON.stringify(value.schemaVersion)}`,
    );
  }
  if (value.lastAckedUpdateId !== null) {
    assertUpdateId(value.lastAckedUpdateId, "control ledger.lastAckedUpdateId");
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
  let previousUpdateId = -1;
  const processedUpdates = value.processedUpdates.map((entryValue, index) => {
    const path = `control ledger.processedUpdates[${index}]`;
    assertPlainObject(entryValue, path);
    assertExactKeys(entryValue, ["updateId", "fingerprint"], path);
    assertUpdateId(entryValue.updateId, `${path}.updateId`);
    assertFingerprint(entryValue.fingerprint, `${path}.fingerprint`);
    if (entryValue.updateId <= previousUpdateId) {
      throw new OpsWorkerControlLedgerSafetyError(
        "Control ledger update ids must be strictly increasing",
      );
    }
    previousUpdateId = entryValue.updateId;
    return {
      updateId: entryValue.updateId,
      fingerprint: entryValue.fingerprint,
    };
  });
  if (
    (value.lastAckedUpdateId === null) !== (processedUpdates.length === 0)
    || (
      value.lastAckedUpdateId !== null
      && processedUpdates.at(-1)?.updateId !== value.lastAckedUpdateId
    )
  ) {
    throw new OpsWorkerControlLedgerSafetyError(
      "Control ledger offset must identify the newest retained update",
    );
  }
  return {
    schemaVersion: OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION,
    lastAckedUpdateId: value.lastAckedUpdateId,
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
      return parseLedger(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  }

  nextOffset(): number | undefined {
    const updateId = this.read().lastAckedUpdateId;
    return updateId === null ? undefined : updateId + 1;
  }

  record(
    updateId: number,
    fingerprint: string,
  ): OpsWorkerControlLedgerRecordResult {
    assertUpdateId(updateId, "updateId");
    assertFingerprint(fingerprint, "fingerprint");
    const current = this.read();
    const replay = current.processedUpdates.find((entry) => entry.updateId === updateId);
    if (replay) {
      if (!fingerprintsEqual(replay.fingerprint, fingerprint)) {
        throw new OpsWorkerControlLedgerSafetyError(
          `Telegram update ${updateId} conflicts with its durable fingerprint`,
        );
      }
      return { state: current, recorded: false, replayed: true };
    }
    if (current.lastAckedUpdateId !== null && updateId <= current.lastAckedUpdateId) {
      throw new OpsWorkerControlLedgerSafetyError(
        `Telegram update ${updateId} is older than the retained replay window`,
      );
    }
    const processedUpdates = [
      ...current.processedUpdates,
      { updateId, fingerprint },
    ].slice(-this.maxProcessedUpdates);
    const next: OpsWorkerControlLedgerState = {
      schemaVersion: OPS_WORKER_CONTROL_LEDGER_SCHEMA_VERSION,
      lastAckedUpdateId: updateId,
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
