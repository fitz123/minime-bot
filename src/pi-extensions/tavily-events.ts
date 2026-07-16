import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { join, resolve } from "node:path";
import type { TavilyFailure, TavilyFailureClassification } from "./tavily.js";

export const TAVILY_CHILD_EVENT_VERSION = 1 as const;
export const TAVILY_EVENT_SPOOL_RELPATH = "data/tavily/events";

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
}
