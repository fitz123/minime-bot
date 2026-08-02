import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "./types.js";

export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
export const PI_CURRENT_SESSION_VERSION = 3;
export const MAX_INTERACTIVE_SESSION_HEADER_BYTES = 64 * 1024;
export const MAX_INTERACTIVE_SESSION_CANDIDATES = 2_048;

export interface InteractiveSessionLocation {
  workspaceRealpath: string;
  sessionDirectory: string;
}

export interface InteractiveSessionBinding extends InteractiveSessionLocation {
  sessionId: string;
  sessionFile: string;
}

export type InteractiveTranscriptFailure =
  | "missing"
  | "unsafe"
  | "unreadable"
  | "invalid";

export type InteractiveTranscriptInspection =
  | { valid: true; binding: InteractiveSessionBinding }
  | { valid: false; reason: InteractiveTranscriptFailure };

export type LegacyInteractiveTranscriptInspection =
  | { valid: true; binding: InteractiveSessionBinding }
  | {
    valid: false;
    reason: InteractiveTranscriptFailure;
    observedSessionId?: string;
  };

export interface InteractiveSessionLocationOptions {
  /** Mirrors Pi's highest-precedence --session-dir input. */
  sessionDirectory?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  expectedUid?: number;
}

export interface InteractiveSessionInspectionOptions {
  expectedUid?: number;
  maxHeaderBytes?: number;
}

export interface InteractiveSessionSeedOptions extends InteractiveSessionInspectionOptions {
  openSession?: (
    sessionFile: string,
    sessionDirectory: string,
    workspaceRealpath: string,
  ) => { getSessionId(): string; getSessionFile(): string | undefined };
  candidateName?: (attempt: number) => string;
  maxAttempts?: number;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function expectedUid(options?: { expectedUid?: number }): number | undefined {
  return options?.expectedUid ?? currentUid();
}

function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertOwned(path: string, details: Stats, uid: number | undefined): void {
  if (uid !== undefined && details.uid !== uid) {
    throw new Error(`Refusing to use ${path}: owned by uid ${details.uid}`);
  }
}

function expandTilde(path: string, homeDirectory: string): string {
  if (path === "~") return homeDirectory;
  if (path.startsWith("~/") || (platform() === "win32" && path.startsWith("~\\"))) {
    return join(homeDirectory, path.slice(2));
  }
  return path;
}

function absolutePiPath(path: string, workspaceRealpath: string, homeDirectory: string): string {
  const expanded = expandTilde(path, homeDirectory);
  return normalize(isAbsolute(expanded) ? resolve(expanded) : resolve(workspaceRealpath, expanded));
}

function canonicalWorkspace(agent: AgentConfig): string {
  const configured = normalize(resolve(agent.workspaceCwd));
  const details = statSync(configured);
  if (!details.isDirectory()) {
    throw new Error(`Agent "${agent.id}" workspaceCwd is not a directory: ${configured}`);
  }
  return realpathSync(configured);
}

function privateSessionDirectory(
  path: string,
  create: boolean,
  uid: number | undefined,
): string {
  try {
    lstatSync(path);
  } catch (error) {
    if (!create || !isMissingError(error)) throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }

  let details = lstatSync(path);
  if (details.isSymbolicLink()) {
    throw new Error(`Refusing to use Pi session directory ${path}: it is a symlink`);
  }
  if (!details.isDirectory()) {
    throw new Error(`Refusing to use Pi session directory ${path}: not a directory`);
  }
  assertOwned(path, details, uid);
  if ((details.mode & 0o777) !== 0o700) {
    if (!create) {
      throw new Error(`Refusing to use Pi session directory ${path}: not private`);
    }
    // Pi 0.82.1 creates its default session directory under the process umask,
    // which is normally 0755. Once ownership/type/symlink checks pass, bring
    // that existing directory up to the private exact-binding contract.
    chmodSync(path, 0o700);
    details = lstatSync(path);
    if ((details.mode & 0o777) !== 0o700) {
      throw new Error(`Refusing to use Pi session directory ${path}: could not make it private`);
    }
  }
  return realpathSync(path);
}

function defaultPiSessionDirectory(workspaceRealpath: string, agentDirectory: string): string {
  const safeWorkspace = `--${workspaceRealpath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDirectory, "sessions", safeWorkspace);
}

function readPiSettings(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/** Mirrors the read-only portion of Pi 0.82.1's global/project settings merge. */
function readPiSettingsSessionDirectory(
  workspaceRealpath: string,
  agentDirectory: string,
): string | undefined {
  const globalSettings = readPiSettings(join(agentDirectory, "settings.json"));
  const projectSettings = readPiSettings(join(workspaceRealpath, ".pi", "settings.json"));
  const sessionDir = Object.hasOwn(projectSettings, "sessionDir")
    ? projectSettings.sessionDir
    : globalSettings.sessionDir;
  if (!sessionDir) return undefined;
  if (typeof sessionDir !== "string") {
    throw new Error("Invalid Pi sessionDir setting: expected a string");
  }
  if (sessionDir === "~") return homedir();
  if (sessionDir.startsWith("~/") || (platform() === "win32" && sessionDir.startsWith("~\\"))) {
    return join(homedir(), sessionDir.slice(2));
  }
  return /^file:\/\//.test(sessionDir) ? fileURLToPath(sessionDir) : sessionDir;
}

/**
 * Resolve the canonical interactive workspace and session directory using Pi
 * 0.82.1's precedence: explicit --session-dir, environment, merged settings,
 * then the cwd-encoded directory below the Pi agent directory.
 */
export function resolveInteractiveSessionLocation(
  agent: AgentConfig,
  options: InteractiveSessionLocationOptions = {},
): InteractiveSessionLocation {
  const env = options.env ?? process.env;
  const homeDirectory = normalize(resolve(options.homeDirectory ?? homedir()));
  const workspaceRealpath = canonicalWorkspace(agent);
  const configuredAgentDirectory = env[PI_AGENT_DIR_ENV]?.trim() || join(homeDirectory, ".pi", "agent");
  const agentDirectory = absolutePiPath(configuredAgentDirectory, workspaceRealpath, homeDirectory);
  const settingsDirectory = readPiSettingsSessionDirectory(workspaceRealpath, agentDirectory);
  const selectedDirectory =
    options.sessionDirectory?.trim()
    || env[PI_SESSION_DIR_ENV]?.trim()
    || settingsDirectory
    || defaultPiSessionDirectory(workspaceRealpath, agentDirectory);
  const requestedDirectory = absolutePiPath(selectedDirectory, workspaceRealpath, homeDirectory);
  const sessionDirectory = privateSessionDirectory(
    requestedDirectory,
    true,
    expectedUid(options),
  );
  return { workspaceRealpath, sessionDirectory };
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertCanonicalWorkspace(path: string): void {
  if (
    !isAbsolute(path)
    || normalize(path) !== path
    || !statSync(path).isDirectory()
    || realpathSync(path) !== path
  ) {
    throw new Error("Interactive Pi workspace must be an existing canonical directory");
  }
}

function readBoundedHeader(
  sessionFile: string,
  maxHeaderBytes: number,
): Record<string, unknown> | undefined {
  if (!Number.isSafeInteger(maxHeaderBytes) || maxHeaderBytes < 1) {
    throw new Error("Pi transcript header bound must be a positive safe integer");
  }
  const descriptor = openSync(sessionFile, "r");
  try {
    const buffer = Buffer.alloc(maxHeaderBytes);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    if (newline < 1) return undefined;
    const parsed: unknown = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

/** Validate one exact transcript without searching for a substitute. */
function inspectInteractiveSessionCandidate(
  location: InteractiveSessionLocation,
  sessionFile: string,
  expectedSessionId: string | undefined,
  options: InteractiveSessionInspectionOptions = {},
): LegacyInteractiveTranscriptInspection {
  try {
    assertCanonicalWorkspace(location.workspaceRealpath);
    if (!isAbsolute(sessionFile) || normalize(sessionFile) !== sessionFile) {
      return { valid: false, reason: "unsafe" };
    }
    const sessionDirectory = privateSessionDirectory(
      location.sessionDirectory,
      false,
      expectedUid(options),
    );
    const details = lstatSync(sessionFile);
    if (details.isSymbolicLink() || !details.isFile()) {
      return { valid: false, reason: "unsafe" };
    }
    assertOwned(sessionFile, details, expectedUid(options));
    if ((details.mode & 0o777) !== 0o600) {
      return { valid: false, reason: "unsafe" };
    }
    const canonicalFile = realpathSync(sessionFile);
    if (
      !isInside(sessionDirectory, canonicalFile)
      || dirname(canonicalFile) !== sessionDirectory
      || !canonicalFile.endsWith(".jsonl")
    ) {
      return { valid: false, reason: "unsafe" };
    }
    const header = readBoundedHeader(
      canonicalFile,
      options.maxHeaderBytes ?? MAX_INTERACTIVE_SESSION_HEADER_BYTES,
    );
    if (
      header?.type !== "session"
      || header.version !== PI_CURRENT_SESSION_VERSION
      || typeof header.id !== "string"
      || header.id.length === 0
      || (expectedSessionId !== undefined && header.id !== expectedSessionId)
      || header.cwd !== location.workspaceRealpath
    ) {
      return {
        valid: false,
        reason: "invalid",
        ...(typeof header?.id === "string" && header.id.length > 0
          ? { observedSessionId: header.id }
          : {}),
      };
    }
    return {
      valid: true,
      binding: {
        sessionId: header.id,
        sessionFile: canonicalFile,
        sessionDirectory,
        workspaceRealpath: location.workspaceRealpath,
      },
    };
  } catch (error) {
    if (isMissingError(error)) return { valid: false, reason: "missing" };
    if ((error as Error).message.includes("owned by uid")) {
      return { valid: false, reason: "unsafe" };
    }
    return { valid: false, reason: "unreadable" };
  }
}

/** Validate one exact transcript against an already-known durable ID. */
export function inspectInteractiveSessionBinding(
  location: InteractiveSessionLocation,
  sessionFile: string,
  expectedSessionId: string,
  options: InteractiveSessionInspectionOptions = {},
): InteractiveTranscriptInspection {
  const inspection = inspectInteractiveSessionCandidate(
    location,
    sessionFile,
    expectedSessionId,
    options,
  );
  return inspection.valid
    ? inspection
    : { valid: false, reason: inspection.reason };
}

/**
 * Read one bounded, direct local candidate for the one-time legacy cutover.
 * Unlike runtime validation, migration may learn the Pi-authored ID from a
 * verified header so each candidate needs to be inspected only once.
 */
export function inspectLegacyInteractiveSessionCandidate(
  location: InteractiveSessionLocation,
  sessionFile: string,
  options: InteractiveSessionInspectionOptions = {},
): LegacyInteractiveTranscriptInspection {
  return inspectInteractiveSessionCandidate(location, sessionFile, undefined, options);
}

/**
 * Return only direct JSONL candidates and refuse unbounded directory scans.
 * Callers must still inspect each returned path with
 * inspectInteractiveSessionBinding before accepting it.
 */
export function listInteractiveSessionCandidates(
  location: InteractiveSessionLocation,
  maxCandidates: number = MAX_INTERACTIVE_SESSION_CANDIDATES,
  options: Pick<InteractiveSessionInspectionOptions, "expectedUid"> = {},
): string[] {
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) {
    throw new Error("Pi transcript candidate bound must be a positive safe integer");
  }
  const sessionDirectory = privateSessionDirectory(
    location.sessionDirectory,
    false,
    expectedUid(options),
  );
  const entries = readdirSync(sessionDirectory, { withFileTypes: true });
  if (entries.length > maxCandidates) {
    throw new Error(`Pi session directory exceeds the ${maxCandidates}-entry inspection bound`);
  }
  return entries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(sessionDirectory, entry.name));
}

/**
 * Return every direct JSONL-named entry without following it. Legacy cutover
 * uses this wider evidence list so a matching symlink or non-file is classified
 * as unsafe instead of disappearing as a false "missing" result.
 */
export function listInteractiveSessionEvidence(
  location: InteractiveSessionLocation,
  maxCandidates: number = MAX_INTERACTIVE_SESSION_CANDIDATES,
  options: Pick<InteractiveSessionInspectionOptions, "expectedUid"> = {},
): string[] {
  if (!Number.isSafeInteger(maxCandidates) || maxCandidates < 1) {
    throw new Error("Pi transcript candidate bound must be a positive safe integer");
  }
  const sessionDirectory = privateSessionDirectory(
    location.sessionDirectory,
    false,
    expectedUid(options),
  );
  const entries = readdirSync(sessionDirectory, { withFileTypes: true });
  if (entries.length > maxCandidates) {
    throw new Error(`Pi session directory exceeds the ${maxCandidates}-entry inspection bound`);
  }
  return entries
    .filter((entry) => entry.name.endsWith(".jsonl"))
    .map((entry) => join(sessionDirectory, entry.name));
}

function defaultCandidateName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}_${randomUUID()}.jsonl`;
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Exclusively create a private empty file and let Pi author its canonical
 * header. The returned binding is accepted only after exact path, identity,
 * header version, ownership, permissions, and cwd validation all succeed.
 */
export function preseedInteractiveSessionBindingCore(
  location: InteractiveSessionLocation,
  options: InteractiveSessionSeedOptions = {},
): InteractiveSessionBinding {
  assertCanonicalWorkspace(location.workspaceRealpath);
  const sessionDirectory = privateSessionDirectory(
    location.sessionDirectory,
    false,
    expectedUid(options),
  );
  const maxAttempts = options.maxAttempts ?? 100;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1_000) {
    throw new Error("Pi transcript seed attempt bound must be between 1 and 1000");
  }

  let sessionFile: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidateName = options.candidateName?.(attempt) ?? defaultCandidateName();
    if (
      !candidateName
      || candidateName !== normalize(candidateName)
      || candidateName.includes("/")
      || candidateName.includes("\\")
      || !candidateName.endsWith(".jsonl")
    ) {
      throw new Error("Pi transcript seed filename must be a direct .jsonl basename");
    }
    const candidate = join(sessionDirectory, candidateName);
    try {
      const descriptor = openSync(candidate, "wx", 0o600);
      try {
        fchmodSync(descriptor, 0o600);
      } finally {
        closeSync(descriptor);
      }
      sessionFile = realpathSync(candidate);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!sessionFile) {
    throw new Error(`Unable to allocate a collision-free Pi transcript after ${maxAttempts} attempts`);
  }

  const openSession = options.openSession;
  if (!openSession) {
    throw new Error("A pinned Pi session opener is required to author the transcript");
  }
  const piSession = openSession(sessionFile, sessionDirectory, location.workspaceRealpath);
  const sessionId = piSession.getSessionId();
  const reportedFile = piSession.getSessionFile();
  if (
    typeof sessionId !== "string"
    || sessionId.length === 0
    || typeof reportedFile !== "string"
    || !isAbsolute(reportedFile)
  ) {
    throw new Error("Pi did not author a complete interactive session identity");
  }
  const canonicalReportedFile = realpathSync(reportedFile);
  if (canonicalReportedFile !== sessionFile) {
    throw new Error("Pi authored the interactive session at an unexpected transcript path");
  }
  // Pi writes the header synchronously but does not fsync it. Make both the
  // authored bytes and their directory entry durable before publishing a
  // binding that the store may commit independently.
  fsyncPath(canonicalReportedFile);
  fsyncPath(sessionDirectory);
  const inspection = inspectInteractiveSessionBinding(
    { ...location, sessionDirectory },
    canonicalReportedFile,
    sessionId,
    options,
  );
  if (!inspection.valid) {
    throw new Error(`Pi authored an invalid interactive session transcript: ${inspection.reason}`);
  }
  return inspection.binding;
}
