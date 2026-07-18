import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import type {
  CodexQuotaSnapshot,
  CodexQuotaWindow,
  CodexQuotaWindowName,
} from "../pi-extensions/codex-usage.js";

export const OPS_WORKER_QUOTA_POLICY_VERSION = 1 as const;
export const OPS_WORKER_QUOTA_MIN_REMAINING_PERCENT = 50;
export const OPS_WORKER_QUOTA_PACING_BURST_PERCENT = 10;
export const DEFAULT_OPS_WORKER_QUOTA_STALE_MS = 30 * 60_000;
export const DEFAULT_OPS_WORKER_QUOTA_RECHECK_MS = 60_000;
export const MAX_OPS_WORKER_QUOTA_SNAPSHOT_BYTES = 64 * 1024;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WINDOW_DURATIONS_MS: Readonly<Record<CodexQuotaWindowName, number>> = {
  "5h": 5 * 60 * 60_000,
  week: 7 * 24 * 60 * 60_000,
};
const SNAPSHOT_KEYS = new Set([
  "provider",
  "sampledAt",
  "lastSuccess",
  "lastSuccessTimestamp",
  "lastAttempt",
  "lastAttemptTimestamp",
  "probeSuccess",
  "planType",
  "activeLimit",
  "windows",
]);
const WINDOW_KEYS = new Set([
  "usedPercent",
  "remainingPercent",
  "resetAt",
  "resetTimestamp",
]);

export type OpsWorkerQuotaReadStatus =
  | "OK"
  | "MISSING"
  | "DURATIONLESS"
  | "INVALID"
  | "READ_ERROR";

export type OpsWorkerQuotaReadResult =
  | { status: "OK"; snapshot: CodexQuotaSnapshot }
  | { status: Exclude<OpsWorkerQuotaReadStatus, "OK"> };

export interface OpsWorkerQuotaReader {
  read(): OpsWorkerQuotaReadResult;
}

export interface OpsWorkerQuotaAdmissionGate {
  check(): OpsWorkerQuotaAdmissionDecision;
}

export type OpsWorkerQuotaAdmissionReason =
  | "HEADROOM"
  | "MISSING"
  | "READ_ERROR"
  | "INVALID"
  | "STALE"
  | "CONTRADICTORY"
  | "DURATIONLESS"
  | "RESETLESS"
  | "LOW_REMAINING"
  | "PACE_EXCEEDED";

export interface OpsWorkerQuotaAdmissionDecision {
  version: typeof OPS_WORKER_QUOTA_POLICY_VERSION;
  status: "ADMITTED" | "NOT_ADMITTED";
  reason: OpsWorkerQuotaAdmissionReason;
  observedAt: string;
  sampledAt: string | null;
  activeWindows: CodexQuotaWindowName[];
  nextResetAt: string | null;
  nextProbeAt: string | null;
  evidenceHash: string;
  summary: string;
}

export interface OpsWorkerQuotaAdmissionOptions {
  now?: Date;
  staleMs?: number;
}

export type OpsWorkerQuotaResponseDecision =
  | {
    status: "WAIT";
    resetAt: string;
    sampledAt: string;
    evidenceHash: string;
    summary: string;
  }
  | {
    status: "TELEMETRY_ERROR";
    reason: Exclude<OpsWorkerQuotaAdmissionReason, "HEADROOM">;
    evidenceHash: string;
    summary: string;
  };

export class CodexQuotaFileReader implements OpsWorkerQuotaReader {
  constructor(private readonly stateFile: string) {
    if (typeof stateFile !== "string" || stateFile.trim() === "") {
      throw new TypeError("Codex quota state file must be a non-empty path");
    }
  }

  read(): OpsWorkerQuotaReadResult {
    let raw: string;
    try {
      const stats = lstatSync(this.stateFile);
      if (!stats.isFile() || stats.isSymbolicLink()) return { status: "INVALID" };
      if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
        return { status: "INVALID" };
      }
      if (stats.size < 2 || stats.size > MAX_OPS_WORKER_QUOTA_SNAPSHOT_BYTES) {
        return { status: "INVALID" };
      }
      const fd = openSync(this.stateFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const openedStats = fstatSync(fd);
        if (
          !openedStats.isFile()
          || (typeof process.getuid === "function" && openedStats.uid !== process.getuid())
          || openedStats.size < 2
          || openedStats.size > MAX_OPS_WORKER_QUOTA_SNAPSHOT_BYTES
        ) return { status: "INVALID" };
        raw = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { status: "MISSING" }
        : { status: "READ_ERROR" };
    }
    try {
      return { status: "OK", snapshot: parseStrictCodexQuotaSnapshot(JSON.parse(raw)) };
    } catch (error) {
      if (error instanceof QuotaShapeError && error.reason === "DURATIONLESS") {
        return { status: "DURATIONLESS" };
      }
      return { status: "INVALID" };
    }
  }
}

export class OpsWorkerQuotaAdmissionPolicy implements OpsWorkerQuotaAdmissionGate {
  constructor(
    private readonly reader: OpsWorkerQuotaReader,
    private readonly options: {
      now?: () => Date;
      staleMs?: number;
    } = {},
  ) {}

  check(): OpsWorkerQuotaAdmissionDecision {
    return evaluateOpsWorkerQuotaAdmission(this.reader.read(), {
      now: this.options.now?.() ?? new Date(),
      staleMs: this.options.staleMs,
    });
  }
}

export function evaluateOpsWorkerQuotaAdmission(
  read: OpsWorkerQuotaReadResult,
  options: OpsWorkerQuotaAdmissionOptions = {},
): OpsWorkerQuotaAdmissionDecision {
  const now = options.now ?? new Date();
  const staleMs = options.staleMs ?? DEFAULT_OPS_WORKER_QUOTA_STALE_MS;
  if (!Number.isSafeInteger(staleMs) || staleMs < 1 || staleMs > 24 * 60 * 60_000) {
    throw new TypeError("quota staleMs must be an integer between 1 and 86400000");
  }
  if (read.status !== "OK") {
    return decision({
      status: "NOT_ADMITTED",
      reason: read.status,
      now,
      sampledAt: null,
      activeWindows: [],
      nextResetAt: null,
      nextProbeAt: null,
    });
  }

  let snapshot: CodexQuotaSnapshot;
  try {
    snapshot = parseStrictCodexQuotaSnapshot(read.snapshot);
  } catch (error) {
    const reason = error instanceof QuotaShapeError
      && error.reason === "DURATIONLESS"
      ? "DURATIONLESS"
      : "INVALID";
    return decision({
      status: "NOT_ADMITTED",
      reason,
      now,
      sampledAt: null,
      activeWindows: [],
      nextResetAt: null,
      nextProbeAt: null,
    });
  }
  const sampledAtMs = Date.parse(snapshot.sampledAt);
  const lastSuccessMs = Date.parse(snapshot.lastSuccess);
  if (
    !Number.isFinite(sampledAtMs)
    || sampledAtMs !== lastSuccessMs
    || Math.floor(sampledAtMs / 1_000) !== snapshot.lastSuccessTimestamp
    || sampledAtMs > now.getTime()
  ) {
    return closedSnapshotDecision("CONTRADICTORY", snapshot, now);
  }
  if (now.getTime() - sampledAtMs > staleMs) {
    return closedSnapshotDecision("STALE", snapshot, now);
  }

  const entries = Object.entries(snapshot.windows);
  const active = entries.filter(([, window]) => Object.keys(window).length > 0);
  if (active.length === 0) {
    return closedSnapshotDecision("MISSING", snapshot, now);
  }
  const activeWindows = active.map(([name]) => name as CodexQuotaWindowName);
  const blockers: Array<{
    reason: "LOW_REMAINING" | "PACE_EXCEEDED";
    resetAt: string;
    probeAt: string;
  }> = [];
  for (const [rawName, window] of active) {
    const name = rawName as CodexQuotaWindowName;
    const durationMs = WINDOW_DURATIONS_MS[name];
    if (durationMs === undefined) {
      return closedSnapshotDecision("DURATIONLESS", snapshot, now, activeWindows);
    }
    if (
      window.resetAt === undefined
      || window.resetTimestamp === undefined
    ) {
      return closedSnapshotDecision("RESETLESS", snapshot, now, activeWindows);
    }
    if (
      window.usedPercent === undefined
      || window.remainingPercent === undefined
      || Math.abs(window.usedPercent + window.remainingPercent - 100) > 0.001
      || Date.parse(window.resetAt) !== window.resetTimestamp * 1_000
    ) {
      return closedSnapshotDecision("CONTRADICTORY", snapshot, now, activeWindows);
    }
    const resetMs = Date.parse(window.resetAt);
    const startMs = resetMs - durationMs;
    if (resetMs <= sampledAtMs || sampledAtMs < startMs) {
      return closedSnapshotDecision("CONTRADICTORY", snapshot, now, activeWindows);
    }
    if (window.remainingPercent < OPS_WORKER_QUOTA_MIN_REMAINING_PERCENT) {
      blockers.push({
        reason: "LOW_REMAINING",
        resetAt: window.resetAt,
        probeAt: window.resetAt,
      });
      continue;
    }
    const elapsedWindowPercent = Math.max(
      0,
      Math.min(100, ((now.getTime() - startMs) / durationMs) * 100),
    );
    if (
      window.usedPercent
      > elapsedWindowPercent + OPS_WORKER_QUOTA_PACING_BURST_PERCENT
    ) {
      const permittedElapsedPercent = Math.max(
        0,
        window.usedPercent - OPS_WORKER_QUOTA_PACING_BURST_PERCENT,
      );
      blockers.push({
        reason: "PACE_EXCEEDED",
        resetAt: window.resetAt,
        probeAt: new Date(
          startMs + (durationMs * permittedElapsedPercent) / 100,
        ).toISOString(),
      });
    }
  }
  if (blockers.length > 0) {
    const reason = blockers.some((blocker) => blocker.reason === "LOW_REMAINING")
      ? "LOW_REMAINING"
      : "PACE_EXCEEDED";
    return decision({
      status: "NOT_ADMITTED",
      reason,
      now,
      sampledAt: snapshot.sampledAt,
      activeWindows,
      nextResetAt: latestTimestamp(blockers.map((blocker) => blocker.resetAt)),
      nextProbeAt: latestTimestamp(blockers.map((blocker) => blocker.probeAt)),
    });
  }
  return decision({
    status: "ADMITTED",
    reason: "HEADROOM",
    now,
    sampledAt: snapshot.sampledAt,
    activeWindows,
    nextResetAt: null,
    nextProbeAt: null,
  });
}

export function evaluateOpsWorkerQuotaResponse(
  read: OpsWorkerQuotaReadResult,
  options: OpsWorkerQuotaAdmissionOptions = {},
): OpsWorkerQuotaResponseDecision {
  const admission = evaluateOpsWorkerQuotaAdmission(read, options);
  if (
    read.status !== "OK"
    || admission.reason === "MISSING"
    || admission.reason === "READ_ERROR"
    || admission.reason === "INVALID"
    || admission.reason === "STALE"
    || admission.reason === "CONTRADICTORY"
    || admission.reason === "DURATIONLESS"
    || admission.reason === "RESETLESS"
  ) {
    return {
      status: "TELEMETRY_ERROR",
      reason: admission.reason === "HEADROOM" ? "INVALID" : admission.reason,
      evidenceHash: admission.evidenceHash,
      summary: `Quota response telemetry is unusable: ${admission.reason}`,
    };
  }
  const resetValues = Object.entries(read.snapshot.windows)
    .filter(([, window]) => Object.keys(window).length > 0)
    .flatMap(([, window]) => window.resetAt === undefined ? [] : [window.resetAt]);
  if (resetValues.length === 0) {
    return {
      status: "TELEMETRY_ERROR",
      reason: "RESETLESS",
      evidenceHash: admission.evidenceHash,
      summary: "Quota response telemetry is unusable: RESETLESS",
    };
  }
  const resetAt = new Date(
    Math.min(...resetValues.map((value) => Date.parse(value))),
  ).toISOString();
  return {
    status: "WAIT",
    resetAt,
    sampledAt: read.snapshot.sampledAt,
    evidenceHash: admission.evidenceHash,
    summary: `Codex quota response requires a reset-aware wait until ${resetAt}`,
  };
}

export function isAuthoritativeQuotaDecision(
  value: OpsWorkerQuotaAdmissionDecision,
): boolean {
  return value.status === "NOT_ADMITTED"
    && value.nextProbeAt !== null
    && (value.reason === "LOW_REMAINING" || value.reason === "PACE_EXCEEDED");
}

class QuotaShapeError extends Error {
  constructor(readonly reason: "INVALID" | "DURATIONLESS") {
    super(reason);
  }
}

function parseStrictCodexQuotaSnapshot(value: unknown): CodexQuotaSnapshot {
  const snapshot = plainObject(value);
  if (Object.keys(snapshot).some((key) => !SNAPSHOT_KEYS.has(key))) {
    throw new QuotaShapeError("INVALID");
  }
  for (const required of [
    "provider",
    "sampledAt",
    "lastSuccess",
    "lastSuccessTimestamp",
    "windows",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, required)) {
      throw new QuotaShapeError("INVALID");
    }
  }
  if (
    snapshot.provider !== "codex"
    || !timestamp(snapshot.sampledAt)
    || !timestamp(snapshot.lastSuccess)
    || !nonNegativeInteger(snapshot.lastSuccessTimestamp)
  ) throw new QuotaShapeError("INVALID");
  optionalTimestamp(snapshot.lastAttempt);
  optionalNonNegativeInteger(snapshot.lastAttemptTimestamp);
  if (snapshot.probeSuccess !== undefined && typeof snapshot.probeSuccess !== "boolean") {
    throw new QuotaShapeError("INVALID");
  }
  optionalBoundedText(snapshot.planType);
  optionalBoundedText(snapshot.activeLimit);
  const rawWindows = plainObject(snapshot.windows);
  if (Object.keys(rawWindows).some((name) => !(name in WINDOW_DURATIONS_MS))) {
    throw new QuotaShapeError("DURATIONLESS");
  }
  for (const name of Object.keys(WINDOW_DURATIONS_MS)) {
    if (!Object.prototype.hasOwnProperty.call(rawWindows, name)) {
      throw new QuotaShapeError("INVALID");
    }
  }
  const parsedWindow = (raw: unknown): CodexQuotaWindow => {
    const window = plainObject(raw);
    if (Object.keys(window).some((key) => !WINDOW_KEYS.has(key))) {
      throw new QuotaShapeError("INVALID");
    }
    optionalPercent(window.usedPercent);
    optionalPercent(window.remainingPercent);
    optionalTimestamp(window.resetAt);
    optionalNonNegativeInteger(window.resetTimestamp);
    return structuredClone(window) as CodexQuotaWindow;
  };
  return structuredClone({
    ...snapshot,
    provider: "codex",
    windows: {
      "5h": parsedWindow(rawWindows["5h"]),
      week: parsedWindow(rawWindows.week),
    },
  }) as CodexQuotaSnapshot;
}

function plainObject(value: unknown): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) throw new QuotaShapeError("INVALID");
  return value as Record<string, unknown>;
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function optionalTimestamp(value: unknown): void {
  if (value !== undefined && !timestamp(value)) throw new QuotaShapeError("INVALID");
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function optionalNonNegativeInteger(value: unknown): void {
  if (value !== undefined && !nonNegativeInteger(value)) {
    throw new QuotaShapeError("INVALID");
  }
}

function optionalPercent(value: unknown): void {
  if (
    value !== undefined
    && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
  ) throw new QuotaShapeError("INVALID");
}

function optionalBoundedText(value: unknown): void {
  if (
    value !== undefined
    && (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 128)
  ) throw new QuotaShapeError("INVALID");
}

function latestTimestamp(values: readonly string[]): string {
  return new Date(Math.max(...values.map((value) => Date.parse(value)))).toISOString();
}

function closedSnapshotDecision(
  reason: Exclude<OpsWorkerQuotaAdmissionReason, "HEADROOM">,
  snapshot: CodexQuotaSnapshot,
  now: Date,
  activeWindows: CodexQuotaWindowName[] = [],
): OpsWorkerQuotaAdmissionDecision {
  return decision({
    status: "NOT_ADMITTED",
    reason,
    now,
    sampledAt: snapshot.sampledAt,
    activeWindows,
    nextResetAt: null,
    nextProbeAt: null,
  });
}

function decision(input: {
  status: "ADMITTED" | "NOT_ADMITTED";
  reason: OpsWorkerQuotaAdmissionReason;
  now: Date;
  sampledAt: string | null;
  activeWindows: CodexQuotaWindowName[];
  nextResetAt: string | null;
  nextProbeAt: string | null;
}): OpsWorkerQuotaAdmissionDecision {
  const proof = {
    version: OPS_WORKER_QUOTA_POLICY_VERSION,
    status: input.status,
    reason: input.reason,
    observedAt: input.now.toISOString(),
    sampledAt: input.sampledAt,
    activeWindows: [...input.activeWindows].sort(),
    nextResetAt: input.nextResetAt,
    nextProbeAt: input.nextProbeAt,
    minimumRemainingPercent: OPS_WORKER_QUOTA_MIN_REMAINING_PERCENT,
    pacingBurstPercent: OPS_WORKER_QUOTA_PACING_BURST_PERCENT,
  };
  const evidenceHash = `sha256:${createHash("sha256")
    .update(JSON.stringify(proof))
    .digest("hex")}`;
  if (!SHA256_PATTERN.test(evidenceHash)) throw new Error("unreachable quota hash");
  return {
    version: OPS_WORKER_QUOTA_POLICY_VERSION,
    status: input.status,
    reason: input.reason,
    observedAt: proof.observedAt,
    sampledAt: input.sampledAt,
    activeWindows: [...input.activeWindows],
    nextResetAt: input.nextResetAt,
    nextProbeAt: input.nextProbeAt,
    evidenceHash,
    summary: input.status === "ADMITTED"
      ? `Codex quota admission passed for ${input.activeWindows.join(",")}`
      : `Codex quota admission closed: ${input.reason}`,
  };
}
