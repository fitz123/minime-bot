import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { log } from "./logger.js";
import { recordStartupConflictMetric } from "./metrics.js";

export const STARTUP_CONFLICT_REASONS = [
  "instance_lock_held",
  "foreign_media_owner",
  "unsafe_media_root",
  "metrics_port_in_use",
  "duplicate_telegram_polling",
] as const;

export type StartupConflictReason = (typeof STARTUP_CONFLICT_REASONS)[number];

export interface RuntimeIdentity {
  user: string;
  home: string;
  slot: string;
  pid: string;
}

export interface RuntimeIdentityOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  realpath?: (path: string) => string;
  homedir?: () => string;
  userInfo?: () => { username: string };
  pid?: number;
}

export function resolveRuntimeIdentity(options: RuntimeIdentityOptions = {}): RuntimeIdentity {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd;
  const resolveRealpath = options.realpath ?? realpathSync;
  const resolveHome = options.homedir ?? homedir;
  const resolveUser = options.userInfo ?? userInfo;
  const explicitSlot = env.MINIME_BOT_SLOT?.trim();
  const workingDirectory = resolveRealpath(cwd());

  return {
    user: resolveUser().username,
    home: resolveHome(),
    slot: explicitSlot || basename(workingDirectory) || "root",
    pid: String(options.pid ?? process.pid),
  };
}

export class StartupConflictError extends Error {
  readonly reason: StartupConflictReason;
  readonly reported = true;

  constructor(reason: StartupConflictReason) {
    super(`MINIME_STARTUP_GUARD_CONFLICT reason=${reason}`);
    this.name = "StartupConflictError";
    this.reason = reason;
  }
}

export interface StartupConflictRecorderOptions {
  recordMetric?: (reason: StartupConflictReason) => void;
  writeLog?: (message: string) => void;
}

/** Emit the complete stable diagnostic. Resource values and error details are intentionally not accepted. */
export function recordStartupConflict(
  reason: StartupConflictReason,
  options: StartupConflictRecorderOptions = {},
): void {
  (options.recordMetric ?? recordStartupConflictMetric)(reason);
  (options.writeLog ?? ((message) => log.error("runtime-guard", message)))(
    `MINIME_STARTUP_GUARD_CONFLICT reason=${reason}`,
  );
}

function conflict(reason: StartupConflictReason, options?: StartupConflictRecorderOptions): never {
  recordStartupConflict(reason, options);
  throw new StartupConflictError(reason);
}

export interface MediaRootPreflightOptions extends StartupConflictRecorderOptions {
  expectedUid?: number;
  lstat?: typeof lstatSync;
  access?: typeof accessSync;
  realpath?: typeof realpathSync;
}

/**
 * Inspect the configured media root without mutating it. Missing roots are
 * allowed and will be created later by the media store after ownership has
 * been claimed.
 */
export function preflightMediaRoot(
  mediaRoot: string,
  options: MediaRootPreflightOptions = {},
): string {
  const absoluteRoot = resolve(mediaRoot);
  const inspect = options.lstat ?? lstatSync;
  let stats: Stats;
  try {
    stats = inspect(absoluteRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absoluteRoot;
    return conflict("unsafe_media_root", options);
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return conflict("unsafe_media_root", options);
  }
  const expectedUid = options.expectedUid
    ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (expectedUid !== undefined && stats.uid !== expectedUid) {
    return conflict("foreign_media_owner", options);
  }
  try {
    (options.access ?? accessSync)(absoluteRoot, constants.R_OK | constants.W_OK | constants.X_OK);
    return (options.realpath ?? realpathSync)(absoluteRoot);
  } catch {
    return conflict("unsafe_media_root", options);
  }
}

export type RuntimeResource =
  | { kind: "media"; value: string }
  | { kind: "telegram"; value: string };

/** Build resource identifiers without retaining the raw Telegram token. */
export function runtimeGuardResources(mediaRoot: string, telegramToken?: string): RuntimeResource[] {
  const resources: RuntimeResource[] = [{ kind: "media", value: resolve(mediaRoot) }];
  if (telegramToken) {
    resources.push({
      kind: "telegram",
      value: createHash("sha256").update(telegramToken).digest("hex"),
    });
  }
  return resources;
}

export function inspectProcessStartToken(pid: number): string | undefined {
  let identity: string | undefined;
  if (process.platform === "linux") {
    try {
      const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closingParen = raw.lastIndexOf(")");
      const fields = raw.slice(closingParen + 2).trim().split(/\s+/);
      if (closingParen >= 0 && fields[19]) identity = `linux:${fields[19]}`;
    } catch {
      // Liveness remains the fail-closed fallback when start identity is unavailable.
    }
  } else {
    const inspected = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 64 * 1024,
    });
    if (!inspected.error && inspected.status === 0 && inspected.stdout.trim()) {
      identity = `${process.platform}:${inspected.stdout.trim()}`;
    }
  }
  return identity === undefined
    ? undefined
    : createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

const ENTRY_PATTERN = /^(claim|owner)-(\d+)-(unknown|[0-9a-f]{16})-([0-9a-f-]+)$/;

interface ParsedEntry {
  type: "claim" | "owner";
  pid: number;
  startToken: string;
  nonce: string;
  suffix: string;
}

function parseEntry(entry: string): ParsedEntry | undefined {
  const match = entry.match(ENTRY_PATTERN);
  if (!match) return undefined;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return {
    type: match[1] as "claim" | "owner",
    pid,
    startToken: match[3],
    nonce: match[4],
    suffix: entry.slice(entry.indexOf("-") + 1),
  };
}

function resourceLockName(resource: RuntimeResource): string {
  const digest = createHash("sha256")
    .update(resource.kind)
    .update("\0")
    .update(resource.value)
    .digest("hex")
    .slice(0, 32);
  return `${resource.kind}-${digest}`;
}

export function runtimeResourceLockPath(
  resource: RuntimeResource,
  lockRoot = join(tmpdir(), `minime-bot-runtime-${typeof process.getuid === "function" ? process.getuid() : "user"}`),
): string {
  return join(lockRoot, resourceLockName(resource));
}

interface LockSnapshot {
  stats: Stats;
  entries: string[];
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return left.isDirectory()
    && right.isDirectory()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs;
}

function readSnapshot(lockPath: string): LockSnapshot | undefined {
  try {
    const stats = lstatSync(lockPath);
    if (stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 0o077) !== 0) return undefined;
    return { stats, entries: readdirSync(lockPath).sort() };
  } catch {
    return undefined;
  }
}

function entryHasExactContents(lockPath: string, entry: string, suffix: string): boolean {
  try {
    return readFileSync(join(lockPath, entry), "utf8") === `${suffix}\n`;
  } catch {
    return false;
  }
}

function removeExactSnapshot(lockPath: string, snapshot: LockSnapshot): boolean {
  const current = readSnapshot(lockPath);
  if (
    !current
    || !sameDirectory(snapshot.stats, current.stats)
    || current.entries.length !== snapshot.entries.length
    || current.entries.some((entry, index) => entry !== snapshot.entries[index])
  ) {
    return false;
  }
  try {
    for (const entry of [...snapshot.entries].reverse()) unlinkSync(join(lockPath, entry));
    rmdirSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

export interface RuntimeGuardOptions extends StartupConflictRecorderOptions {
  resources: RuntimeResource[];
  lockRoot?: string;
  incompleteGraceMs?: number;
  now?: () => number;
  pid?: number;
  expectedUid?: number;
  processStartToken?: (pid: number) => string | undefined;
  isProcessAlive?: (pid: number) => boolean;
  nonce?: () => string;
  beforeRecoveryVerification?: (lockPath: string) => void;
  beforeReleaseVerification?: (lockPath: string) => void;
}

interface HeldLock {
  path: string;
  snapshot: LockSnapshot;
  claimEntry: string;
  ownerEntry: string;
  suffix: string;
}

function removeHeldLock(lock: HeldLock): boolean {
  return entryHasExactContents(lock.path, lock.claimEntry, lock.suffix)
    && entryHasExactContents(lock.path, lock.ownerEntry, lock.suffix)
    && removeExactSnapshot(lock.path, lock.snapshot);
}

export interface RuntimeGuard {
  readonly lockPaths: readonly string[];
  release(): boolean;
  installProcessExitHook(target?: NodeJS.Process): () => void;
}

function ensureOwnerOnlyRoot(root: string, expectedUid: number | undefined): void {
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stats = lstatSync(root);
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || (stats.mode & 0o077) !== 0
    || (expectedUid !== undefined && stats.uid !== expectedUid)
  ) {
    throw new Error("unsafe runtime lock namespace");
  }
}

function recoverStaleLock(
  lockPath: string,
  options: Required<Pick<RuntimeGuardOptions, "incompleteGraceMs" | "now" | "processStartToken" | "isProcessAlive">>
    & Pick<RuntimeGuardOptions, "expectedUid" | "beforeRecoveryVerification">,
): boolean {
  const snapshot = readSnapshot(lockPath);
  if (!snapshot) return false;
  if (options.expectedUid !== undefined && snapshot.stats.uid !== options.expectedUid) return false;

  if (snapshot.entries.length === 0) {
    if (options.now() - snapshot.stats.mtimeMs <= options.incompleteGraceMs) return false;
    options.beforeRecoveryVerification?.(lockPath);
    return removeExactSnapshot(lockPath, snapshot);
  }

  const parsed = snapshot.entries.map(parseEntry);
  if (parsed.some((entry) => entry === undefined)) return false;
  const entries = parsed as ParsedEntry[];

  if (entries.length === 1 && entries[0].type === "claim") {
    const claim = entries[0];
    if (!entryHasExactContents(lockPath, snapshot.entries[0], claim.suffix)) return false;
    if (options.now() - snapshot.stats.mtimeMs <= options.incompleteGraceMs) return false;
    options.beforeRecoveryVerification?.(lockPath);
    const current = readSnapshot(lockPath);
    if (!current || !entryHasExactContents(lockPath, snapshot.entries[0], claim.suffix)) return false;
    return removeExactSnapshot(lockPath, snapshot);
  }

  if (entries.length !== 2) return false;
  const claim = entries.find((entry) => entry.type === "claim");
  const owner = entries.find((entry) => entry.type === "owner");
  if (!claim || !owner || claim.suffix !== owner.suffix) return false;
  if (
    !entryHasExactContents(lockPath, `claim-${claim.suffix}`, claim.suffix)
    || !entryHasExactContents(lockPath, `owner-${owner.suffix}`, owner.suffix)
  ) {
    return false;
  }

  const currentStartToken = options.processStartToken(owner.pid);
  const sameProcess = currentStartToken !== undefined
    && owner.startToken !== "unknown"
    && currentStartToken === owner.startToken;
  const mustFallBackToLiveness = currentStartToken === undefined || owner.startToken === "unknown";
  if (sameProcess || (mustFallBackToLiveness && options.isProcessAlive(owner.pid))) return false;

  options.beforeRecoveryVerification?.(lockPath);
  if (
    !entryHasExactContents(lockPath, `claim-${claim.suffix}`, claim.suffix)
    || !entryHasExactContents(lockPath, `owner-${owner.suffix}`, owner.suffix)
  ) {
    return false;
  }
  return removeExactSnapshot(lockPath, snapshot);
}

function acquireOneLock(
  lockPath: string,
  options: RuntimeGuardOptions,
  startToken: string,
  expectedUid: number | undefined,
): HeldLock {
  const pid = options.pid ?? process.pid;
  const recoveryOptions = {
    incompleteGraceMs: Math.max(0, options.incompleteGraceMs ?? 1_000),
    now: options.now ?? Date.now,
    processStartToken: options.processStartToken ?? inspectProcessStartToken,
    isProcessAlive: options.isProcessAlive ?? processIsAlive,
    expectedUid,
    beforeRecoveryVerification: options.beforeRecoveryVerification,
  };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        if (recoverStaleLock(lockPath, recoveryOptions)) continue;
        return conflict("instance_lock_held", options);
      }
      return conflict("instance_lock_held", options);
    }

    const created = readSnapshot(lockPath);
    if (!created || (expectedUid !== undefined && created.stats.uid !== expectedUid)) {
      return conflict("instance_lock_held", options);
    }
    const suffix = `${pid}-${startToken}-${options.nonce?.() ?? randomUUID()}`;
    const claimEntry = `claim-${suffix}`;
    const ownerEntry = `owner-${suffix}`;
    try {
      writeFileSync(join(lockPath, claimEntry), `${suffix}\n`, { flag: "wx", mode: 0o600 });
      writeFileSync(join(lockPath, ownerEntry), `${suffix}\n`, { flag: "wx", mode: 0o600 });
    } catch {
      const partial = readSnapshot(lockPath);
      const ownEntries = new Set([claimEntry, ownerEntry]);
      if (
        partial
        && partial.stats.dev === created.stats.dev
        && partial.stats.ino === created.stats.ino
        && partial.entries.every((entry) => ownEntries.has(entry))
        && partial.entries.every((entry) => entryHasExactContents(lockPath, entry, suffix))
      ) {
        removeExactSnapshot(lockPath, partial);
      }
      return conflict("instance_lock_held", options);
    }
    const owned = readSnapshot(lockPath);
    const exactEntries = [claimEntry, ownerEntry].sort();
    if (
      !owned
      || owned.stats.dev !== created.stats.dev
      || owned.stats.ino !== created.stats.ino
      || owned.entries.length !== 2
      || owned.entries.some((entry, index) => entry !== exactEntries[index])
      || !entryHasExactContents(lockPath, claimEntry, suffix)
      || !entryHasExactContents(lockPath, ownerEntry, suffix)
    ) {
      return conflict("instance_lock_held", options);
    }
    return { path: lockPath, snapshot: owned, claimEntry, ownerEntry, suffix };
  }
  return conflict("instance_lock_held", options);
}

export function acquireRuntimeGuard(options: RuntimeGuardOptions): RuntimeGuard {
  const expectedUid = options.expectedUid
    ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const root = options.lockRoot
    ?? join(tmpdir(), `minime-bot-runtime-${expectedUid ?? "user"}`);
  try {
    ensureOwnerOnlyRoot(root, expectedUid);
  } catch {
    return conflict("instance_lock_held", options);
  }

  const pid = options.pid ?? process.pid;
  const startToken = (options.processStartToken ?? inspectProcessStartToken)(pid) ?? "unknown";
  const paths = options.resources.map((resource) => runtimeResourceLockPath(resource, root)).sort();
  const held: HeldLock[] = [];
  try {
    for (const lockPath of paths) held.push(acquireOneLock(lockPath, options, startToken, expectedUid));
  } catch (error) {
    for (const lock of [...held].reverse()) removeHeldLock(lock);
    throw error;
  }

  let releaseResult: boolean | undefined;
  const release = (): boolean => {
    if (releaseResult !== undefined) return releaseResult;
    let complete = true;
    for (const lock of [...held].reverse()) {
      options.beforeReleaseVerification?.(lock.path);
      complete = removeHeldLock(lock) && complete;
    }
    releaseResult = complete;
    return releaseResult;
  };

  return {
    lockPaths: paths,
    release,
    installProcessExitHook(target = process): () => void {
      const onExit = () => { release(); };
      target.once("exit", onExit);
      return () => target.off("exit", onExit);
    },
  };
}
