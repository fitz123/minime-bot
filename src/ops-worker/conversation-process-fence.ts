import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

export const OPS_WORKER_CONVERSATION_PROCESS_FENCE_FILE_NAME =
  "conversation-process.json";

const OPS_WORKER_CONVERSATION_PROCESS_FENCE_SCHEMA_VERSION = 1 as const;
const MAX_FENCE_BYTES = 4 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

interface OpsWorkerConversationProcessFenceBase {
  schemaVersion: typeof OPS_WORKER_CONVERSATION_PROCESS_FENCE_SCHEMA_VERSION;
  phase: "PRESPAWN" | "SPAWNED";
  launchedAt: string;
  ownershipNonceHash: string;
}

export interface OpsWorkerConversationPrespawnFence
  extends OpsWorkerConversationProcessFenceBase {
  phase: "PRESPAWN";
}

export interface OpsWorkerConversationSpawnedFence
  extends OpsWorkerConversationProcessFenceBase {
  phase: "SPAWNED";
  pid: number;
  expectedProcessGroupId: number;
}

export type OpsWorkerConversationProcessFence =
  | OpsWorkerConversationPrespawnFence
  | OpsWorkerConversationSpawnedFence;

export class OpsWorkerConversationProcessFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsWorkerConversationProcessFenceError";
  }
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertOwnedRegularFile(path: string, stats: Stats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new OpsWorkerConversationProcessFenceError(
      `Refusing conversation process fence ${path}: not a regular file`,
    );
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new OpsWorkerConversationProcessFenceError(
      `Refusing conversation process fence ${path}: not owned by the current user`,
    );
  }
}

function assertSafeStateDirectory(path: string): void {
  if (!isAbsolute(path)) {
    throw new OpsWorkerConversationProcessFenceError(
      "Ops-worker state directory must be absolute",
    );
  }
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new OpsWorkerConversationProcessFenceError(
      `Refusing conversation process state directory ${path}: not a real directory`,
    );
  }
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new OpsWorkerConversationProcessFenceError(
      `Refusing conversation process state directory ${path}: not owned by the current user`,
    );
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isDirectory()) {
      throw new OpsWorkerConversationProcessFenceError(
        `Refusing to fsync conversation process state directory ${path}`,
      );
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function parseFence(raw: string): OpsWorkerConversationProcessFence {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OpsWorkerConversationProcessFenceError(
      "Conversation process fence is not valid JSON",
    );
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsWorkerConversationProcessFenceError(
      "Conversation process fence must be an object",
    );
  }
  const record = value as Record<string, unknown>;
  const baseValid = record.schemaVersion
      === OPS_WORKER_CONVERSATION_PROCESS_FENCE_SCHEMA_VERSION
    && (record.phase === "PRESPAWN" || record.phase === "SPAWNED")
    && typeof record.launchedAt === "string"
    && Number.isFinite(Date.parse(record.launchedAt))
    && typeof record.ownershipNonceHash === "string"
    && SHA256_PATTERN.test(record.ownershipNonceHash);
  if (!baseValid) {
    throw new OpsWorkerConversationProcessFenceError(
      "Conversation process fence has invalid fields",
    );
  }
  if (record.phase === "PRESPAWN") {
    if (!hasExactKeys(record, [
      "schemaVersion",
      "phase",
      "launchedAt",
      "ownershipNonceHash",
    ])) {
      throw new OpsWorkerConversationProcessFenceError(
        "Conversation pre-spawn fence has unexpected fields",
      );
    }
    return {
      schemaVersion: OPS_WORKER_CONVERSATION_PROCESS_FENCE_SCHEMA_VERSION,
      phase: "PRESPAWN",
      launchedAt: record.launchedAt as string,
      ownershipNonceHash: record.ownershipNonceHash as string,
    };
  }
  if (
    !hasExactKeys(record, [
      "schemaVersion",
      "phase",
      "launchedAt",
      "ownershipNonceHash",
      "pid",
      "expectedProcessGroupId",
    ])
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) < 1
    || record.expectedProcessGroupId !== record.pid
  ) {
    throw new OpsWorkerConversationProcessFenceError(
      "Conversation spawned fence has invalid process identity",
    );
  }
  return {
    schemaVersion: OPS_WORKER_CONVERSATION_PROCESS_FENCE_SCHEMA_VERSION,
    phase: "SPAWNED",
    launchedAt: record.launchedAt as string,
    ownershipNonceHash: record.ownershipNonceHash as string,
    pid: record.pid as number,
    expectedProcessGroupId: record.pid as number,
  };
}

export class OpsWorkerConversationProcessFenceStore {
  readonly path: string;

  private readonly stateDirectory: string;

  constructor(stateDirectory: string) {
    assertSafeStateDirectory(stateDirectory);
    this.stateDirectory = stateDirectory;
    this.path = join(
      stateDirectory,
      OPS_WORKER_CONVERSATION_PROCESS_FENCE_FILE_NAME,
    );
  }

  read(): OpsWorkerConversationProcessFence | null {
    let beforeOpen: Stats;
    try {
      beforeOpen = lstatSync(this.path);
    } catch (error) {
      if (isMissingError(error)) return null;
      throw error;
    }
    assertOwnedRegularFile(this.path, beforeOpen);
    if (beforeOpen.size > MAX_FENCE_BYTES) {
      throw new OpsWorkerConversationProcessFenceError(
        `Conversation process fence exceeds ${MAX_FENCE_BYTES} bytes`,
      );
    }
    const descriptor = openSync(this.path, constants.O_RDONLY | NO_FOLLOW);
    try {
      const stats = fstatSync(descriptor);
      assertOwnedRegularFile(this.path, stats);
      if (stats.ino !== beforeOpen.ino || stats.size > MAX_FENCE_BYTES) {
        throw new OpsWorkerConversationProcessFenceError(
          "Conversation process fence changed identity while being opened",
        );
      }
      return parseFence(readFileSync(descriptor, "utf8"));
    } finally {
      closeSync(descriptor);
    }
  }

  write(fence: OpsWorkerConversationProcessFence): void {
    const serialized = `${JSON.stringify(fence)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_FENCE_BYTES) {
      throw new OpsWorkerConversationProcessFenceError(
        `Conversation process fence exceeds ${MAX_FENCE_BYTES} bytes`,
      );
    }
    try {
      const stats = lstatSync(this.path);
      assertOwnedRegularFile(this.path, stats);
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
    const temporaryPath = join(
      this.stateDirectory,
      `.conversation-process.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
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
      renameSync(temporaryPath, this.path);
      renamed = true;
      fsyncDirectory(this.stateDirectory);
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

  clear(): void {
    let stats: Stats;
    try {
      stats = lstatSync(this.path);
    } catch (error) {
      if (isMissingError(error)) return;
      throw error;
    }
    assertOwnedRegularFile(this.path, stats);
    unlinkSync(this.path);
    fsyncDirectory(this.stateDirectory);
  }
}
