import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  CURRENT_SESSION_VERSION,
  SessionManager as PiSessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./types.js";

export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
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
  ) => Pick<PiSessionManager, "getSessionId" | "getSessionFile">;
  candidateName?: (attempt: number) => string;
  maxAttempts?: number;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid.call(process) : undefined;
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
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) {
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
  let created = false;
  try {
    lstatSync(path);
  } catch (error) {
    if (!create || !isMissingError(error)) throw error;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    created = true;
  }

  const details = lstatSync(path);
  if (details.isSymbolicLink()) {
    throw new Error(`Refusing to use Pi session directory ${path}: it is a symlink`);
  }
  if (!details.isDirectory()) {
    throw new Error(`Refusing to use Pi session directory ${path}: not a directory`);
  }
  assertOwned(path, details, uid);
  if ((details.mode & 0o777) !== 0o700) {
    const provenance = created ? "created with unexpected permissions" : "not private";
    throw new Error(`Refusing to use Pi session directory ${path}: ${provenance}`);
  }
  return realpathSync(path);
}

function defaultPiSessionDirectory(workspaceRealpath: string, agentDirectory: string): string {
  const safeWorkspace = `--${workspaceRealpath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDirectory, "sessions", safeWorkspace);
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
  const settingsDirectory = SettingsManager.create(workspaceRealpath, agentDirectory).getSessionDir();
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
export function inspectInteractiveSessionBinding(
  location: InteractiveSessionLocation,
  sessionFile: string,
  expectedSessionId: string,
  options: InteractiveSessionInspectionOptions = {},
): InteractiveTranscriptInspection {
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
      || header.version !== CURRENT_SESSION_VERSION
      || header.id !== expectedSessionId
      || header.cwd !== location.workspaceRealpath
    ) {
      return { valid: false, reason: "invalid" };
    }
    return {
      valid: true,
      binding: {
        sessionId: expectedSessionId,
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

function defaultCandidateName(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}_${randomUUID()}.jsonl`;
}

/**
 * Exclusively create a private empty file and let Pi author its canonical
 * header. The returned binding is accepted only after exact path, identity,
 * header version, ownership, permissions, and cwd validation all succeed.
 */
export function preseedInteractiveSessionBinding(
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

  const openSession = options.openSession
    ?? ((path: string, directory: string, cwd: string) => PiSessionManager.open(path, directory, cwd));
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
