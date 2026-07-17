import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
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
export const TAVILY_EVENT_IN_FLIGHT_REQUEST_PREFIX = ".request-";
export const TAVILY_EVENT_IN_FLIGHT_REQUEST_SUFFIX = ".active";
export const TAVILY_EVENT_RECOVERY_WAIT_TIMEOUT_MS = 35_000;
export const TAVILY_EVENT_RECOVERY_WAIT_INTERVAL_MS = 500;

const publicationLocksHeldByThisProcess = new Map<string, {
  depth: number;
  token: string;
}>();
const publicationWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
export const TAVILY_LOCK_PROCESS_START_CLOCK_SKEW_MS = 5_000;

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
  getProcessIdentity?: (pid: number) => string | undefined;
  getProcessStartedAt?: (pid: number) => number | undefined;
  now?: () => Date;
  waitTimeoutMs?: number;
  waitIntervalMs?: number;
}

export interface TavilyEventPublicationLock {
  path: string;
  release: () => void;
}

export interface TavilyToolRequestPublication {
  complete: (
    tool: TavilyChildEvent["tool"],
    failure: TavilyFailure | undefined,
    observedAt: Date,
  ) => string | undefined;
}

export interface TavilyEventRecoveryBarrierOptions extends TavilyEventPublicationLockOptions {
  inFlightWaitTimeoutMs?: number;
  inFlightWaitIntervalMs?: number;
}

interface TavilyEventPublicationLockRecord {
  version: 1;
  pid: number;
  token: string;
  processIdentity?: string;
  acquiredAt: string;
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

function hashProcessIdentity(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function queryPosixProcessStart(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        LC_ALL: "C",
        TZ: "UTC",
      },
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Return the process start epoch used to recover pre-fingerprint lock files. */
export function tavilyProcessStartedAt(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  const value = queryPosixProcessStart(pid);
  if (!value) return undefined;
  const milliseconds = Date.parse(`${value} UTC`);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/**
 * Return a bounded fingerprint for one OS process instance. PIDs alone can be
 * reused after a crash or reboot, so lock recovery also compares the process
 * start identity. Raw boot IDs and process metadata never reach the lock file.
 */
export function tavilyProcessIdentity(pid: number): string | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd < 0) return undefined;
      const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
      const startTicks = fields[19];
      const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!startTicks || !/^\d+$/.test(startTicks) || !bootId) return undefined;
      return hashProcessIdentity(`linux:${bootId}:${startTicks}`);
    } catch {
      // Fall through to the portable POSIX process-start query.
    }
  }
  const startedAt = queryPosixProcessStart(pid);
  return startedAt ? hashProcessIdentity(`${process.platform}:${startedAt}`) : undefined;
}

function validProcessIdentity(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    new Date(value).toISOString() === value;
}

function isoNow(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Tavily event publication lock time is invalid");
  }
  return value.toISOString();
}

function readPublicationLock(path: string): TavilyEventPublicationLockRecord {
  assertPrivateFile(path);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tavily event publication lock is invalid");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (!keys.every((key) =>
    key === "version" || key === "pid" || key === "token" ||
    key === "processIdentity" || key === "acquiredAt") ||
      record.version !== 1 ||
      !Number.isSafeInteger(record.pid) || (record.pid as number) <= 0 ||
      typeof record.token !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(record.token) ||
      (record.processIdentity !== undefined &&
        (typeof record.processIdentity !== "string" || !validProcessIdentity(record.processIdentity))) ||
      (record.acquiredAt !== undefined && !isCanonicalIsoTimestamp(record.acquiredAt))) {
    throw new Error("Tavily event publication lock is invalid");
  }
  const acquiredAt = record.acquiredAt ?? lstatSync(path).mtime.toISOString();
  return { ...record, acquiredAt } as unknown as TavilyEventPublicationLockRecord;
}

function lockOwnerMatchesLiveProcess(
  owner: TavilyEventPublicationLockRecord,
  isProcessAlive: (pid: number) => boolean,
  getProcessIdentity: (pid: number) => string | undefined,
  getProcessStartedAt: (pid: number) => number | undefined,
): boolean {
  if (!isProcessAlive(owner.pid)) return false;
  if (owner.processIdentity !== undefined) {
    const currentIdentity = getProcessIdentity(owner.pid);
    return currentIdentity === undefined || currentIdentity === owner.processIdentity;
  }
  const currentStartedAt = getProcessStartedAt(owner.pid);
  return currentStartedAt === undefined ||
    currentStartedAt <= new Date(owner.acquiredAt).getTime() + TAVILY_LOCK_PROCESS_START_CLOCK_SKEW_MS;
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

function publicationOwnerRecord(
  pid: number,
  token: string,
  getProcessIdentity: (pid: number) => string | undefined,
  now: () => Date,
): TavilyEventPublicationLockRecord {
  const processIdentity = getProcessIdentity(pid);
  if (processIdentity !== undefined && !validProcessIdentity(processIdentity)) {
    throw new Error("Tavily event publication process identity is invalid");
  }
  return {
    version: 1,
    pid,
    token,
    ...(processIdentity === undefined ? {} : { processIdentity }),
    acquiredAt: isoNow(now),
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
  const getProcessIdentity = options.getProcessIdentity ?? tavilyProcessIdentity;
  const getProcessStartedAt = options.getProcessStartedAt ?? tavilyProcessStartedAt;
  const now = options.now ?? (() => new Date());
  const deadline = Date.now() + waitTimeoutMs;

  for (;;) {
    const token = (options.uniqueId?.() ?? randomUUID()).replaceAll(/[^A-Za-z0-9-]/g, "");
    if (!token) throw new Error("Tavily event publication lock token is invalid");
    const candidatePath = join(directory, `.publish-${pid}-${token}.tmp`);
    const record = publicationOwnerRecord(pid, token, getProcessIdentity, now);
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
    const sameProcessInstance = lockOwnerMatchesLiveProcess(
      owner,
      isProcessAlive,
      getProcessIdentity,
      getProcessStartedAt,
    );
    if (!sameProcessInstance) {
      try {
        const current = readPublicationLock(path);
        if (current.token === owner.token && current.processIdentity === owner.processIdentity) {
          unlinkSync(path);
        }
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

/**
 * Register a provider request before it starts. Completion publishes any
 * sanitized failure and removes the marker under the same lock used by the
 * recovery commit, so recovery cannot pass an already-started request.
 */
export function beginTavilyToolRequestPublication(
  controlWorkspaceRoot: string,
  options: TavilyEventPublicationLockOptions = {},
): TavilyToolRequestPublication {
  const lock = acquireTavilyEventPublicationLock(controlWorkspaceRoot, options);
  let markerPath: string;
  try {
    const directory = ensureTavilyEventSpool(controlWorkspaceRoot);
    const pid = options.pid ?? process.pid;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("Tavily in-flight request PID is invalid");
    }
    const token = (options.uniqueId?.() ?? randomUUID()).replaceAll(/[^A-Za-z0-9-]/g, "");
    if (!token) throw new Error("Tavily in-flight request token is invalid");
    const getProcessIdentity = options.getProcessIdentity ?? tavilyProcessIdentity;
    const now = options.now ?? (() => new Date());
    const record = publicationOwnerRecord(pid, token, getProcessIdentity, now);
    markerPath = join(
      directory,
      `${TAVILY_EVENT_IN_FLIGHT_REQUEST_PREFIX}${pid}-${token}${TAVILY_EVENT_IN_FLIGHT_REQUEST_SUFFIX}`,
    );
    const candidatePath = `${markerPath}.tmp`;
    try {
      writeFileSync(candidatePath, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      // Publish only a complete marker. A crash before the hard link leaves an
      // ignored staging file rather than a truncated active request record.
      linkSync(candidatePath, markerPath);
    } finally {
      try { unlinkSync(candidatePath); } catch { /* best-effort staging cleanup */ }
    }
  } finally {
    lock.release();
  }

  let completed = false;
  return {
    complete: (tool, failure, observedAt) => {
      if (completed) return undefined;
      if (!Number.isFinite(observedAt.getTime())) {
        throw new Error("Tavily request observation time is invalid");
      }
      const completionLock = acquireTavilyEventPublicationLock(controlWorkspaceRoot, options);
      try {
        return failure === undefined
          ? undefined
          : writeTavilyChildEvent(controlWorkspaceRoot, tool, failure, {
            now: () => observedAt,
            uniqueId: options.uniqueId,
            pid: options.pid,
          });
      } finally {
        try {
          unlinkSync(markerPath);
          completed = true;
        } finally {
          completionLock.release();
        }
      }
    },
  };
}

function liveInFlightRequestCount(
  controlWorkspaceRoot: string,
  options: TavilyEventPublicationLockOptions,
): number {
  const directory = ensureTavilyEventSpool(controlWorkspaceRoot);
  const isProcessAlive = options.isProcessAlive ?? defaultProcessIsAlive;
  const getProcessIdentity = options.getProcessIdentity ?? tavilyProcessIdentity;
  const getProcessStartedAt = options.getProcessStartedAt ?? tavilyProcessStartedAt;
  let live = 0;
  for (const file of readdirSync(directory)) {
    if (!file.startsWith(TAVILY_EVENT_IN_FLIGHT_REQUEST_PREFIX) ||
        !file.endsWith(TAVILY_EVENT_IN_FLIGHT_REQUEST_SUFFIX)) {
      continue;
    }
    const path = join(directory, file);
    let owner: TavilyEventPublicationLockRecord;
    try {
      owner = readPublicationLock(path);
    } catch (error) {
      if (isMissing(error)) continue;
      // Active markers are published under this lock, so a malformed plain
      // owner-only file cannot be a partially written live request. Recover
      // crash debris without unlinking symlinks or foreign-owned files.
      try {
        assertPrivateFile(path);
        unlinkSync(path);
      } catch (cleanupError) {
        if (!isMissing(cleanupError)) throw error;
      }
      continue;
    }
    if (lockOwnerMatchesLiveProcess(
      owner,
      isProcessAlive,
      getProcessIdentity,
      getProcessStartedAt,
    )) {
      live += 1;
      continue;
    }
    try {
      const current = readPublicationLock(path);
      if (current.token === owner.token && current.processIdentity === owner.processIdentity) {
        unlinkSync(path);
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return live;
}

/**
 * Acquire the recovery commit lock only after all registered requests have
 * completed. New requests cannot register until the returned lock is released.
 */
export async function acquireTavilyEventRecoveryBarrier(
  controlWorkspaceRoot: string,
  options: TavilyEventRecoveryBarrierOptions = {},
): Promise<TavilyEventPublicationLock> {
  const inFlightWaitTimeoutMs = options.inFlightWaitTimeoutMs ??
    TAVILY_EVENT_RECOVERY_WAIT_TIMEOUT_MS;
  const inFlightWaitIntervalMs = options.inFlightWaitIntervalMs ??
    TAVILY_EVENT_RECOVERY_WAIT_INTERVAL_MS;
  if (!Number.isFinite(inFlightWaitTimeoutMs) || inFlightWaitTimeoutMs < 0 ||
      !Number.isFinite(inFlightWaitIntervalMs) || inFlightWaitIntervalMs <= 0) {
    throw new Error("Tavily in-flight request wait is invalid");
  }
  const deadline = Date.now() + inFlightWaitTimeoutMs;
  for (;;) {
    const lock = acquireTavilyEventPublicationLock(controlWorkspaceRoot, options);
    let liveRequests: number;
    try {
      liveRequests = liveInFlightRequestCount(controlWorkspaceRoot, options);
    } catch (error) {
      lock.release();
      throw error;
    }
    if (liveRequests === 0) return lock;
    lock.release();
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for Tavily in-flight requests");
    }
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, Math.min(inFlightWaitIntervalMs, deadline - Date.now()));
    });
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
  }, { pid: options.pid, now: options.now });
}
