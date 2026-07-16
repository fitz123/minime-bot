import { randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import type { TavilyFailure, TavilyFailureClassification } from "./tavily.js";

export const TAVILY_CHILD_EVENT_VERSION = 1 as const;
export const TAVILY_EVENT_SPOOL_RELPATH = "data/tavily/events";
export const TAVILY_EVENT_PUBLICATION_LOCK_RELPATH =
  `${TAVILY_EVENT_SPOOL_RELPATH}/.publish.lock`;

const publicationLocksHeldByThisProcess = new Map<string, {
  depth: number;
  token: string;
}>();
const publicationWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface TavilyChildEvent {
  version: typeof TAVILY_CHILD_EVENT_VERSION;
  tool: "web_search" | "web_fetch";
  classification: TavilyFailureClassification;
  httpStatus?: number;
  observedAt: string;
}

export interface WriteTavilyChildEventOptions {
  now?: () => Date;
  uniqueId?: () => string;
  pid?: number;
}

export interface TavilyEventPublicationLockOptions {
  uniqueId?: () => string;
  pid?: number;
  isProcessAlive?: (pid: number) => boolean;
  waitTimeoutMs?: number;
  waitIntervalMs?: number;
}

export interface TavilyEventPublicationLock {
  path: string;
  release: () => void;
}

interface TavilyEventPublicationLockRecord {
  version: 1;
  pid: number;
  token: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertPrivateDirectory(path: string, details: Stats): void {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("Tavily event spool component is not a plain directory");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && details.uid !== uid) {
    throw new Error("Tavily event spool component is not owned by the current user");
  }
  if ((details.mode & 0o077) !== 0) {
    chmodSync(path, 0o700);
  }
}

function assertPrivateFile(path: string): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("Tavily event publication lock is not a plain file");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && details.uid !== uid) {
    throw new Error("Tavily event publication lock is not owned by the current user");
  }
  if ((details.mode & 0o077) !== 0) chmodSync(path, 0o600);
}

function ensurePrivateDirectory(path: string): void {
  try {
    assertPrivateDirectory(path, lstatSync(path));
    return;
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertPrivateDirectory(path, lstatSync(path));
}

/** Resolve the child-event spool below the canonical control-workspace data directory. */
export function tavilyEventSpoolDirectory(controlWorkspaceRoot: string): string {
  return resolve(controlWorkspaceRoot, TAVILY_EVENT_SPOOL_RELPATH);
}

function ensureTavilyEventSpool(controlWorkspaceRoot: string): string {
  const dataDirectory = resolve(controlWorkspaceRoot, "data");
  const tavilyDirectory = join(dataDirectory, "tavily");
  const eventDirectory = join(tavilyDirectory, "events");
  ensurePrivateDirectory(dataDirectory);
  ensurePrivateDirectory(tavilyDirectory);
  ensurePrivateDirectory(eventDirectory);
  return eventDirectory;
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readPublicationLock(path: string): TavilyEventPublicationLockRecord {
  assertPrivateFile(path);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tavily event publication lock is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 ||
      !keys.every((key) => key === "version" || key === "pid" || key === "token") ||
      record.version !== 1 ||
      !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 ||
      typeof record.token !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(record.token)) {
    throw new Error("Tavily event publication lock is invalid");
  }
  return record as unknown as TavilyEventPublicationLockRecord;
}

function publicationLockHandle(
  path: string,
  held: { depth: number; token: string },
): TavilyEventPublicationLock {
  let released = false;
  return {
    path,
    release: () => {
      if (released) return;
      released = true;
      held.depth -= 1;
      if (held.depth > 0) return;
      publicationLocksHeldByThisProcess.delete(path);
      try {
        if (readPublicationLock(path).token === held.token) unlinkSync(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
    },
  };
}

/**
 * Serialize child-event publication with the monitor's recovery commit. The
 * lock is process-reentrant for synchronous callbacks and recovers records
 * left by a dead process.
 */
export function acquireTavilyEventPublicationLock(
  controlWorkspaceRoot: string,
  options: TavilyEventPublicationLockOptions = {},
): TavilyEventPublicationLock {
  const directory = ensureTavilyEventSpool(controlWorkspaceRoot);
  const path = resolve(controlWorkspaceRoot, TAVILY_EVENT_PUBLICATION_LOCK_RELPATH);
  if (join(directory, ".publish.lock") !== path) {
    throw new Error("Tavily event publication lock path is invalid");
  }
  const reentrant = publicationLocksHeldByThisProcess.get(path);
  if (reentrant) {
    reentrant.depth += 1;
    return publicationLockHandle(path, reentrant);
  }

  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error("Tavily event publication lock PID is invalid");
  }
  const waitTimeoutMs = options.waitTimeoutMs ?? 10_000;
  const waitIntervalMs = options.waitIntervalMs ?? 10;
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0 ||
      !Number.isFinite(waitIntervalMs) || waitIntervalMs <= 0) {
    throw new Error("Tavily event publication lock wait is invalid");
  }
  const isProcessAlive = options.isProcessAlive ?? defaultProcessIsAlive;
  const deadline = Date.now() + waitTimeoutMs;

  for (;;) {
    const token = (options.uniqueId?.() ?? randomUUID()).replaceAll(/[^A-Za-z0-9-]/g, "");
    if (!token) throw new Error("Tavily event publication lock token is invalid");
    const candidatePath = join(directory, `.publish-${pid}-${token}.tmp`);
    const record: TavilyEventPublicationLockRecord = { version: 1, pid, token };
    writeFileSync(candidatePath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    let acquired = false;
    try {
      linkSync(candidatePath, path);
      acquired = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      try { unlinkSync(candidatePath); } catch { /* best-effort candidate cleanup */ }
    }
    if (acquired) {
      const held = { depth: 1, token };
      publicationLocksHeldByThisProcess.set(path, held);
      return publicationLockHandle(path, held);
    }

    let owner: TavilyEventPublicationLockRecord;
    try {
      owner = readPublicationLock(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (!isProcessAlive(owner.pid)) {
      try {
        if (readPublicationLock(path).token === owner.token) unlinkSync(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Tavily event publication lock");
    }
    Atomics.wait(publicationWaitBuffer, 0, 0, Math.min(waitIntervalMs, deadline - Date.now()));
  }
}

export function withTavilyEventPublicationLock<T>(
  controlWorkspaceRoot: string,
  callback: () => T,
  options: TavilyEventPublicationLockOptions = {},
): T {
  const lock = acquireTavilyEventPublicationLock(controlWorkspaceRoot, options);
  try {
    return callback();
  } finally {
    lock.release();
  }
}

/**
 * Atomically persist one minimal, unique provider failure event for the main
 * process. The file and all dedicated directories are readable only by their
 * owner; no request or response data is accepted by this API.
 */
export function writeTavilyChildEvent(
  controlWorkspaceRoot: string,
  tool: TavilyChildEvent["tool"],
  failure: TavilyFailure,
  options: WriteTavilyChildEventOptions = {},
): string {
  return withTavilyEventPublicationLock(controlWorkspaceRoot, () => {
    const directory = ensureTavilyEventSpool(controlWorkspaceRoot);
    const now = options.now?.() ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Tavily child event timestamp is invalid");
    }
    const uniqueId = (options.uniqueId?.() ?? randomUUID()).replaceAll(/[^A-Za-z0-9-]/g, "");
    if (!uniqueId) {
      throw new Error("Tavily child event ID is invalid");
    }
    const pid = options.pid ?? process.pid;
    const baseName = `${now.getTime()}-${pid}-${uniqueId}`;
    const finalPath = join(directory, `${baseName}.json`);
    const temporaryPath = join(directory, `.${baseName}.tmp`);
    const event: TavilyChildEvent = {
      version: TAVILY_CHILD_EVENT_VERSION,
      tool,
      classification: failure.classification,
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
      observedAt: now.toISOString(),
    };

    try {
      writeFileSync(temporaryPath, `${JSON.stringify(event)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, finalPath);
      chmodSync(finalPath, 0o600);
      return finalPath;
    } catch (error) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Best-effort cleanup; the monitor ignores non-JSON staging files.
      }
      throw error;
    }
  }, { pid: options.pid });
}
