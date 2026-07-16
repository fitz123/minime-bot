import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  TAVILY_EXTRACT_URL,
  TAVILY_SEARCH_URL,
  cancelTavilyResponseBody,
  classifyTavilyFailure,
  parseExtractResponse,
  parseSearchResponse,
  type TavilyFailureClassification,
} from "./pi-extensions/tavily.js";
import {
  TAVILY_CHILD_EVENT_VERSION,
  tavilyEventSpoolDirectory,
  withTavilyEventPublicationLock,
  type TavilyChildEvent,
} from "./pi-extensions/tavily-events.js";

export const TAVILY_USAGE_URL = "https://api.tavily.com/usage";
export const TAVILY_BILLING_URL = "https://app.tavily.com/billing";
export const TAVILY_RECOVERY_SEARCH_QUERY = "Tavily API documentation";
export const TAVILY_RECOVERY_EXTRACT_URL = "https://example.com/";
export const TAVILY_STATE_VERSION = 1 as const;
export const TAVILY_STATE_RELPATH = "data/tavily/state.json";
export const TAVILY_WRITER_LEASE_RELPATH = "data/tavily/writer.lock";
export const TAVILY_EVENT_POLL_INTERVAL_MS = 2_000;
export const TAVILY_USAGE_TIMEOUT_MS = 10_000;
export const TAVILY_RECOVERY_PROBE_TIMEOUT_MS = 10_000;
export const TAVILY_REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1_000;
export const TAVILY_STATUS_STALE_MS = 10 * 60 * 1_000;

const MAX_PROCESSED_EVENT_KEYS = 2_048;
const TAVILY_FAILURE_CLASSIFICATIONS = new Set<TavilyFailureClassification>([
  "credential_missing",
  "credential_invalid",
  "rate_limited",
  "base_plan_exhausted",
  "paygo_exhausted",
  "provider_unavailable",
  "extraction_failed",
  "request_failed",
]);

export type TavilyQuotaScope = "plan" | "paygo";
export type TavilyThreshold = 80 | 95;
export type TavilyDiagnosticSource =
  | "usage"
  | "web_search"
  | "web_fetch"
  | "recovery_search"
  | "recovery_extract";
export type TavilyMonitorFailureClassification =
  | TavilyFailureClassification
  | "usage_invalid"
  | "usage_exhausted"
  | "probe_failed";

export interface TavilyUsageRequest {
  url: typeof TAVILY_USAGE_URL;
  method: "GET";
  headers: Record<string, string>;
}

export interface TavilyRecoveryProbeRequest {
  url: typeof TAVILY_SEARCH_URL | typeof TAVILY_EXTRACT_URL;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface TavilyQuotaCounter {
  usage: number;
  limit: number;
  remaining: number;
}

export interface TavilyUsageSample {
  observedAt: string;
  cycleGeneration: string;
  resetAt?: string;
  key: TavilyQuotaCounter & {
    searchUsage?: number;
    extractUsage?: number;
  };
  account: {
    currentPlan: string;
    plan: TavilyQuotaCounter;
    paygo: TavilyQuotaCounter;
    searchUsage?: number;
    extractUsage?: number;
  };
}

export interface TavilyMonitorDiagnostic {
  classification: TavilyMonitorFailureClassification;
  source: TavilyDiagnosticSource;
  observedAt: string;
  httpStatus?: number;
}

export type TavilyUsageRequestResult =
  | { ok: true; sample: TavilyUsageSample }
  | {
    ok: false;
    diagnostic: TavilyMonitorDiagnostic;
  };

export type TavilyRecoveryStage =
  | "usage"
  | "usage_state"
  | "search_probe"
  | "extract_probe"
  | "incident";

export type TavilyRecoveryResult =
  | { ok: true; generation: string; sample: TavilyUsageSample }
  | {
    ok: false;
    generation: string;
    stage: TavilyRecoveryStage;
    classification: TavilyMonitorFailureClassification | "stale_incident";
    httpStatus?: number;
  };

export type TavilyRecoveryVerificationResult =
  | { ok: true; sample: TavilyUsageSample }
  | {
    ok: false;
    stage: Exclude<TavilyRecoveryStage, "incident">;
    classification: TavilyMonitorFailureClassification;
    httpStatus?: number;
    sample?: TavilyUsageSample;
  };

export type TavilyNotificationKind =
  | "threshold_warning"
  | "threshold_critical"
  | "incident"
  | "reminder"
  | "recheck_failure"
  | "recovery";

export type TavilyNotificationFailure =
  | "transport"
  | "rate_limited"
  | "server_error"
  | "destination_invalid";

export interface TavilyNotification {
  key: string;
  kind: TavilyNotificationKind;
  message: string;
  createdAt: string;
  nextAttemptAt: string;
  attempts: number;
  status: "pending" | "terminal";
  incidentGeneration?: string;
  lastFailure?: TavilyNotificationFailure;
}

export interface TavilyIncident {
  generation: string;
  openedAt: string;
  lastObservedAt: string;
  lastClassification: "base_plan_exhausted" | "paygo_exhausted";
  observedTools: Array<"web_search" | "web_fetch">;
  nextReminderAt: string;
  lastUsageRecoverable: boolean;
  deliveryTerminalAt?: string;
  acknowledgedAt?: string;
  resolvedAt?: string;
  recoveryUsageObservedAt?: string;
}

export interface TavilyWriterLease {
  path: string;
  release: () => void;
}

export interface TavilyWriterLeaseOptions {
  pid?: number;
  uniqueId?: () => string;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
}

export interface TavilyPendingAutomaticVerification {
  generation: string;
  usageObservedAt: string;
}

export interface TavilyFailureStat {
  classification: TavilyMonitorFailureClassification;
  tool: TavilyDiagnosticSource;
  count: number;
}

export interface TavilyTelemetryStats {
  usageSamples: {
    success: number;
    failure: number;
  };
  failures: TavilyFailureStat[];
}

export interface TavilyMonitorState {
  version: typeof TAVILY_STATE_VERSION;
  updatedAt: string;
  incidentSequence: number;
  latestSample?: TavilyUsageSample;
  latestSampleStatus?: {
    classification: "ok" | TavilyMonitorFailureClassification;
    observedAt: string;
    httpStatus?: number;
  };
  lastFailure?: TavilyMonitorDiagnostic;
  lastVerification?: {
    generation: string;
    ok: boolean;
    stage: TavilyRecoveryStage;
    classification?: TavilyMonitorFailureClassification;
    observedAt: string;
    httpStatus?: number;
  };
  notificationKeys: string[];
  processedEventKeys: string[];
  outbox: TavilyNotification[];
  notificationStats: {
    delivered: number;
    retried: number;
    terminal: number;
  };
  telemetryStats: TavilyTelemetryStats;
  incident?: TavilyIncident;
  pendingAutomaticVerification?: TavilyPendingAutomaticVerification;
}

export type TavilyStatusSampleState = "fresh" | "stale" | "missing" | "error";

/** Privacy-safe projection used by /status; it intentionally omits durable identifiers and paths. */
export interface TavilyStatusSnapshot {
  sampleState: TavilyStatusSampleState;
  sampledAt?: string;
  latestAttemptAt?: string;
  plan?: TavilyQuotaCounter;
  paygo?: TavilyQuotaCounter;
  lastFailure?: TavilyMonitorDiagnostic;
  incident: "none" | "active" | "resolved";
  acknowledged: boolean;
}

export type TavilyStateObserver = (state: TavilyMonitorState, observedAt: Date) => void;

export interface TavilyUsageRequestOptions {
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}

export interface TavilyRecoveryVerificationOptions extends TavilyUsageRequestOptions {
  probeTimeoutMs?: number;
  usageSample?: TavilyUsageSample;
}

export interface TavilyMonitorOptions {
  controlWorkspaceRoot: string;
  apiKey: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  usageTimeoutMs?: number;
  probeTimeoutMs?: number;
  reminderIntervalMs?: number;
  statusStaleMs?: number;
  onStateChange?: TavilyStateObserver;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function validDate(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new Error("Tavily monitor clock returned an invalid timestamp");
  }
  return value;
}

function isoNow(now: () => Date): string {
  return validDate(now()).toISOString();
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredRecord(parent: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = parent[field];
  if (!isRecord(value)) {
    throw new Error("Tavily usage response is invalid");
  }
  return value;
}

function counter(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("Tavily usage response is invalid");
  }
  return value;
}

function optionalCounter(record: Record<string, unknown>, field: string): number | undefined {
  if (!(field in record)) return undefined;
  return counter(record, field);
}

function quotaCounter(usage: number, limit: number): TavilyQuotaCounter {
  return { usage, limit, remaining: Math.max(0, limit - usage) };
}

function providerResetAt(root: Record<string, unknown>, account: Record<string, unknown>): string | undefined {
  const candidates = [
    root.reset_at,
    root.resetAt,
    account.reset_at,
    account.resetAt,
    account.plan_reset_at,
    account.billing_cycle_end,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const date = new Date(candidate);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return undefined;
}

/** Return the stable UTC calendar-month generation used for threshold deduplication. */
export function tavilyBillingCycleGeneration(observedAt: Date | string): string {
  const date = typeof observedAt === "string" ? new Date(observedAt) : observedAt;
  validDate(date);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Build the authenticated, body-free Tavily usage request. */
export function buildTavilyUsageRequest(apiKey: string): TavilyUsageRequest {
  return {
    url: TAVILY_USAGE_URL,
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

/** Build the immutable, public Search probe used by every recovery path. */
export function buildTavilyRecoverySearchRequest(apiKey: string): TavilyRecoveryProbeRequest {
  return {
    url: TAVILY_SEARCH_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: TAVILY_RECOVERY_SEARCH_QUERY,
      max_results: 1,
      search_depth: "basic",
      include_answer: false,
    }),
  };
}

/** Build the immutable, public Extract probe used by every recovery path. */
export function buildTavilyRecoveryExtractRequest(apiKey: string): TavilyRecoveryProbeRequest {
  return {
    url: TAVILY_EXTRACT_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      urls: [TAVILY_RECOVERY_EXTRACT_URL],
      extract_depth: "basic",
    }),
  };
}

/** Parse and validate only documented, quota-relevant fields from `/usage`. */
export function parseTavilyUsageResponse(raw: unknown, observedAt: Date = new Date()): TavilyUsageSample {
  validDate(observedAt);
  if (!isRecord(raw)) throw new Error("Tavily usage response is invalid");
  const key = requiredRecord(raw, "key");
  const account = requiredRecord(raw, "account");
  const currentPlan = account.current_plan;
  if (
    typeof currentPlan !== "string" ||
    !/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(currentPlan)
  ) {
    throw new Error("Tavily usage response is invalid");
  }

  const observedAtIso = observedAt.toISOString();
  const resetAt = providerResetAt(raw, account);
  return {
    observedAt: observedAtIso,
    cycleGeneration: tavilyBillingCycleGeneration(observedAt),
    ...(resetAt === undefined ? {} : { resetAt }),
    key: {
      ...quotaCounter(counter(key, "usage"), counter(key, "limit")),
      ...(optionalCounter(key, "search_usage") === undefined
        ? {}
        : { searchUsage: optionalCounter(key, "search_usage") }),
      ...(optionalCounter(key, "extract_usage") === undefined
        ? {}
        : { extractUsage: optionalCounter(key, "extract_usage") }),
    },
    account: {
      currentPlan,
      plan: quotaCounter(counter(account, "plan_usage"), counter(account, "plan_limit")),
      paygo: quotaCounter(counter(account, "paygo_usage"), counter(account, "paygo_limit")),
      ...(optionalCounter(account, "search_usage") === undefined
        ? {}
        : { searchUsage: optionalCounter(account, "search_usage") }),
      ...(optionalCounter(account, "extract_usage") === undefined
        ? {}
        : { extractUsage: optionalCounter(account, "extract_usage") }),
    },
  };
}

function monitorDiagnostic(
  classification: TavilyMonitorFailureClassification,
  source: TavilyDiagnosticSource,
  observedAt: string,
  httpStatus?: number,
): TavilyMonitorDiagnostic {
  return {
    classification,
    source,
    observedAt,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
}

function timeoutController(timeoutMs: number): { controller: AbortController; cancel: () => void } {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Tavily request timeout must be positive");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  return { controller, cancel: () => clearTimeout(timer) };
}

/** Fetch `/usage` once, with a fixed timeout and no response-body diagnostics. */
export async function requestTavilyUsage(
  options: TavilyUsageRequestOptions,
): Promise<TavilyUsageRequestResult> {
  const now = options.now ?? (() => new Date());
  const observedAt = isoNow(now);
  if (!options.apiKey) {
    return {
      ok: false,
      diagnostic: monitorDiagnostic("credential_missing", "usage", observedAt),
    };
  }
  const request = buildTavilyUsageRequest(options.apiKey);
  const timeout = timeoutController(options.timeoutMs ?? TAVILY_USAGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(request.url, {
      method: request.method,
      headers: request.headers,
      signal: timeout.controller.signal,
    });
  } catch {
    timeout.cancel();
    return {
      ok: false,
      diagnostic: monitorDiagnostic("provider_unavailable", "usage", observedAt),
    };
  }
  if (!response.ok) {
    const failure = classifyTavilyFailure({ kind: "http", httpStatus: response.status });
    await cancelTavilyResponseBody(response);
    timeout.cancel();
    return {
      ok: false,
      diagnostic: monitorDiagnostic(
        failure.classification,
        "usage",
        observedAt,
        failure.httpStatus,
      ),
    };
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return {
      ok: false,
      diagnostic: monitorDiagnostic(
        timeout.controller.signal.aborted ? "provider_unavailable" : "usage_invalid",
        "usage",
        observedAt,
      ),
    };
  } finally {
    timeout.cancel();
  }
  try {
    return { ok: true, sample: parseTavilyUsageResponse(raw, new Date(observedAt)) };
  } catch {
    return {
      ok: false,
      diagnostic: monitorDiagnostic("usage_invalid", "usage", observedAt),
    };
  }
}

/** True when the API key and at least one account credit path can serve requests. */
export function isTavilyUsageRecoverable(sample: TavilyUsageSample): boolean {
  const keyHasCapacity = sample.key.usage < sample.key.limit;
  const accountHasCapacity = sample.account.plan.usage < sample.account.plan.limit ||
    (sample.account.paygo.limit > 0 && sample.account.paygo.usage < sample.account.paygo.limit);
  return keyHasCapacity && accountHasCapacity;
}

interface ProbeResult {
  ok: boolean;
  classification?: TavilyMonitorFailureClassification;
  httpStatus?: number;
}

async function runRecoveryProbe(
  source: "recovery_search" | "recovery_extract",
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const isSearch = source === "recovery_search";
  const request = isSearch
    ? buildTavilyRecoverySearchRequest(apiKey)
    : buildTavilyRecoveryExtractRequest(apiKey);
  const timeout = timeoutController(timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: timeout.controller.signal,
    });
  } catch {
    timeout.cancel();
    return { ok: false, classification: "provider_unavailable" };
  }

  if (!response.ok) {
    const failure = classifyTavilyFailure({ kind: "http", httpStatus: response.status });
    await cancelTavilyResponseBody(response);
    timeout.cancel();
    return {
      ok: false,
      classification: failure.classification,
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
    };
  }

  try {
    const raw = await response.json();
    if (isSearch) {
      const parsed = parseSearchResponse(raw);
      const valid = parsed.results.some((result) =>
        result.url.trim().length > 0 &&
        (result.title.trim().length > 0 || result.content.trim().length > 0));
      return valid ? { ok: true } : { ok: false, classification: "probe_failed" };
    }
    const parsed = parseExtractResponse(raw);
    const valid = parsed.results.some((result) =>
      result.url.trim().length > 0 && result.content.trim().length > 0);
    return valid ? { ok: true } : { ok: false, classification: "probe_failed" };
  } catch {
    return {
      ok: false,
      classification: timeout.controller.signal.aborted ? "provider_unavailable" : "probe_failed",
    };
  } finally {
    timeout.cancel();
  }
}

/** Run the shared bounded recovery verification without retries or side effects. */
export async function verifyTavilyRecovery(
  options: TavilyRecoveryVerificationOptions,
): Promise<TavilyRecoveryVerificationResult> {
  if (options.usageSample !== undefined && !validUsageSample(options.usageSample)) {
    return { ok: false, stage: "usage", classification: "usage_invalid" };
  }
  const usage = options.usageSample === undefined
    ? await requestTavilyUsage(options)
    : { ok: true as const, sample: options.usageSample };
  if (!usage.ok) {
    return {
      ok: false,
      stage: "usage",
      classification: usage.diagnostic.classification,
      ...(usage.diagnostic.httpStatus === undefined ? {} : { httpStatus: usage.diagnostic.httpStatus }),
    };
  }
  if (!isTavilyUsageRecoverable(usage.sample)) {
    return {
      ok: false,
      stage: "usage_state",
      classification: "usage_exhausted",
      sample: usage.sample,
    };
  }
  if (!options.apiKey) {
    return { ok: false, stage: "usage", classification: "credential_missing" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const probeTimeoutMs = options.probeTimeoutMs ?? TAVILY_RECOVERY_PROBE_TIMEOUT_MS;
  const search = await runRecoveryProbe("recovery_search", options.apiKey, fetchImpl, probeTimeoutMs);
  if (!search.ok) {
    return {
      ok: false,
      stage: "search_probe",
      classification: search.classification ?? "probe_failed",
      ...(search.httpStatus === undefined ? {} : { httpStatus: search.httpStatus }),
      sample: usage.sample,
    };
  }
  const extract = await runRecoveryProbe("recovery_extract", options.apiKey, fetchImpl, probeTimeoutMs);
  if (!extract.ok) {
    return {
      ok: false,
      stage: "extract_probe",
      classification: extract.classification ?? "probe_failed",
      ...(extract.httpStatus === undefined ? {} : { httpStatus: extract.httpStatus }),
      sample: usage.sample,
    };
  }
  return { ok: true, sample: usage.sample };
}

function assertPrivateDirectory(path: string, details: Stats): void {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("Tavily monitor data component is not a plain directory");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && details.uid !== uid) {
    throw new Error("Tavily monitor data component is not owned by the current user");
  }
  if ((details.mode & 0o077) !== 0) chmodSync(path, 0o700);
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

function ensureMonitorDirectories(controlWorkspaceRoot: string): string {
  const dataDirectory = resolve(controlWorkspaceRoot, "data");
  const tavilyDirectory = join(dataDirectory, "tavily");
  ensurePrivateDirectory(dataDirectory);
  ensurePrivateDirectory(tavilyDirectory);
  return tavilyDirectory;
}

interface TavilyWriterLeaseRecord {
  version: 1;
  pid: number;
  token: string;
  acquiredAt: string;
}

function defaultProcessIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readWriterLease(path: string): TavilyWriterLeaseRecord {
  assertPrivateFile(path);
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["version", "pid", "token", "acquiredAt"]) ||
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 ||
      typeof value.token !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(value.token) ||
      !isCanonicalIsoTimestamp(value.acquiredAt)) {
    throw new Error("Tavily monitor writer lease is invalid");
  }
  return value as unknown as TavilyWriterLeaseRecord;
}

/** Acquire the one production writer lease, recovering a lock left by a dead process. */
export function tryAcquireTavilyWriterLease(
  controlWorkspaceRoot: string,
  options: TavilyWriterLeaseOptions = {},
): TavilyWriterLease | undefined {
  const directory = ensureMonitorDirectories(controlWorkspaceRoot);
  const path = resolve(controlWorkspaceRoot, TAVILY_WRITER_LEASE_RELPATH);
  if (dirname(path) !== directory) throw new Error("Tavily monitor writer lease path is invalid");
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Tavily monitor writer lease PID is invalid");
  const isProcessAlive = options.isProcessAlive ?? defaultProcessIsAlive;
  const now = options.now ?? (() => new Date());

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = (options.uniqueId?.() ?? randomUUID()).replaceAll(/[^A-Za-z0-9-]/g, "");
    if (!token) throw new Error("Tavily monitor writer lease token is invalid");
    const candidatePath = join(directory, `.writer-${pid}-${token}.tmp`);
    const record: TavilyWriterLeaseRecord = {
      version: 1,
      pid,
      token,
      acquiredAt: isoNow(now),
    };
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
      let released = false;
      return {
        path,
        release: () => {
          if (released) return;
          released = true;
          try {
            if (readWriterLease(path).token === token) unlinkSync(path);
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        },
      };
    }

    let owner: TavilyWriterLeaseRecord;
    try {
      owner = readWriterLease(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (isProcessAlive(owner.pid)) return undefined;
    try {
      const current = readWriterLease(path);
      if (current.token !== owner.token) return undefined;
      unlinkSync(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return undefined;
}

function assertPrivateFile(path: string): void {
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error("Tavily monitor state is not a plain file");
  }
  const uid = process.getuid?.();
  if (uid !== undefined && details.uid !== uid) {
    throw new Error("Tavily monitor state is not owned by the current user");
  }
  if ((details.mode & 0o077) !== 0) chmodSync(path, 0o600);
}

function freshState(now: () => Date): TavilyMonitorState {
  return {
    version: TAVILY_STATE_VERSION,
    updatedAt: isoNow(now),
    incidentSequence: 0,
    notificationKeys: [],
    processedEventKeys: [],
    outbox: [],
    notificationStats: { delivered: 0, retried: 0, terminal: 0 },
    telemetryStats: {
      usageSamples: { success: 0, failure: 0 },
      failures: [],
    },
  };
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function boundedString(value: unknown, maximumLength = 2_048): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function nonnegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validHttpStatus(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599;
}

function validQuotaCounter(value: unknown, optionalUsageFields = false): boolean {
  if (!isRecord(value)) return false;
  const allowed = optionalUsageFields
    ? ["usage", "limit", "remaining", "searchUsage", "extractUsage"]
    : ["usage", "limit", "remaining"];
  return hasOnlyKeys(value, allowed) &&
    nonnegativeFiniteNumber(value.usage) &&
    nonnegativeFiniteNumber(value.limit) &&
    nonnegativeFiniteNumber(value.remaining) &&
    value.remaining === Math.max(0, value.limit - value.usage) &&
    (value.searchUsage === undefined || nonnegativeFiniteNumber(value.searchUsage)) &&
    (value.extractUsage === undefined || nonnegativeFiniteNumber(value.extractUsage));
}

function validUsageSample(value: unknown): value is TavilyUsageSample {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["observedAt", "cycleGeneration", "resetAt", "key", "account"]) ||
      !isCanonicalIsoTimestamp(value.observedAt) ||
      value.cycleGeneration !== tavilyBillingCycleGeneration(value.observedAt as string) ||
      (value.resetAt !== undefined && !isCanonicalIsoTimestamp(value.resetAt)) ||
      !validQuotaCounter(value.key, true) ||
      !isRecord(value.account) ||
      !hasOnlyKeys(value.account, ["currentPlan", "plan", "paygo", "searchUsage", "extractUsage"]) ||
      typeof value.account.currentPlan !== "string" ||
      !/^[A-Za-z][A-Za-z0-9 _-]{0,63}$/.test(value.account.currentPlan) ||
      !validQuotaCounter(value.account.plan) ||
      !validQuotaCounter(value.account.paygo) ||
      (value.account.searchUsage !== undefined && !nonnegativeFiniteNumber(value.account.searchUsage)) ||
      (value.account.extractUsage !== undefined && !nonnegativeFiniteNumber(value.account.extractUsage))) {
    return false;
  }
  return true;
}

function validMonitorClassification(value: unknown): value is TavilyMonitorFailureClassification {
  return typeof value === "string" &&
    (TAVILY_FAILURE_CLASSIFICATIONS.has(value as TavilyFailureClassification) ||
      value === "usage_invalid" || value === "usage_exhausted" || value === "probe_failed");
}

function validDiagnostic(value: unknown): value is TavilyMonitorDiagnostic {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, ["classification", "source", "observedAt", "httpStatus"]) ||
      !validMonitorClassification(value.classification) ||
      !["usage", "web_search", "web_fetch", "recovery_search", "recovery_extract"].includes(
        value.source as string,
      ) ||
      !isCanonicalIsoTimestamp(value.observedAt) ||
      (value.httpStatus !== undefined && !validHttpStatus(value.httpStatus))) {
    return false;
  }
  return true;
}

function validTelemetryStats(value: unknown): value is TavilyTelemetryStats {
  if (!isRecord(value) || !hasOnlyKeys(value, ["usageSamples", "failures"]) ||
      !isRecord(value.usageSamples) ||
      !hasOnlyKeys(value.usageSamples, ["success", "failure"]) ||
      !Number.isSafeInteger(value.usageSamples.success) || (value.usageSamples.success as number) < 0 ||
      !Number.isSafeInteger(value.usageSamples.failure) || (value.usageSamples.failure as number) < 0 ||
      !Array.isArray(value.failures) || value.failures.length > 64) {
    return false;
  }
  const keys = new Set<string>();
  for (const failure of value.failures) {
    if (!isRecord(failure) ||
        !hasOnlyKeys(failure, ["classification", "tool", "count"]) ||
        !validMonitorClassification(failure.classification) ||
        !["usage", "web_search", "web_fetch", "recovery_search", "recovery_extract"].includes(
          failure.tool as string,
        ) ||
        !Number.isSafeInteger(failure.count) || (failure.count as number) < 1) {
      return false;
    }
    const key = `${failure.classification}:${failure.tool}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

function validIncident(value: unknown): value is TavilyIncident {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, [
        "generation",
        "openedAt",
        "lastObservedAt",
        "lastClassification",
        "observedTools",
        "nextReminderAt",
        "lastUsageRecoverable",
        "deliveryTerminalAt",
        "acknowledgedAt",
        "resolvedAt",
        "recoveryUsageObservedAt",
      ]) ||
      !boundedString(value.generation, 80) ||
      !isCanonicalIsoTimestamp(value.openedAt) ||
      !isCanonicalIsoTimestamp(value.lastObservedAt) ||
      (value.lastClassification !== "base_plan_exhausted" &&
        value.lastClassification !== "paygo_exhausted") ||
      !Array.isArray(value.observedTools) ||
      value.observedTools.length < 1 || value.observedTools.length > 2 ||
      value.observedTools.some((tool) => tool !== "web_search" && tool !== "web_fetch") ||
      new Set(value.observedTools).size !== value.observedTools.length ||
      !isCanonicalIsoTimestamp(value.nextReminderAt) ||
      typeof value.lastUsageRecoverable !== "boolean" ||
      (value.deliveryTerminalAt !== undefined && !isCanonicalIsoTimestamp(value.deliveryTerminalAt)) ||
      (value.acknowledgedAt !== undefined && !isCanonicalIsoTimestamp(value.acknowledgedAt)) ||
      (value.resolvedAt !== undefined && !isCanonicalIsoTimestamp(value.resolvedAt)) ||
      (value.recoveryUsageObservedAt !== undefined &&
        (!isCanonicalIsoTimestamp(value.recoveryUsageObservedAt) || value.resolvedAt === undefined))) {
    return false;
  }
  return true;
}

function validNotification(value: unknown): value is TavilyNotification {
  if (!isRecord(value) ||
      !hasOnlyKeys(value, [
        "key",
        "kind",
        "message",
        "createdAt",
        "nextAttemptAt",
        "attempts",
        "status",
        "incidentGeneration",
        "lastFailure",
      ]) ||
      !boundedString(value.key, 256) ||
      !["threshold_warning", "threshold_critical", "incident", "reminder", "recheck_failure", "recovery"].includes(
        value.kind as string,
      ) ||
      !boundedString(value.message) ||
      !isCanonicalIsoTimestamp(value.createdAt) ||
      !isCanonicalIsoTimestamp(value.nextAttemptAt) ||
      !Number.isSafeInteger(value.attempts) || (value.attempts as number) < 0 ||
      (value.status !== "pending" && value.status !== "terminal") ||
      (value.incidentGeneration !== undefined && !boundedString(value.incidentGeneration, 80)) ||
      (value.lastFailure !== undefined &&
        !["transport", "rate_limited", "server_error", "destination_invalid"].includes(
          value.lastFailure as string,
        ))) {
    return false;
  }
  return true;
}

function validMonitorState(value: unknown): value is TavilyMonitorState {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, [
    "version",
    "updatedAt",
    "incidentSequence",
    "latestSample",
    "latestSampleStatus",
    "lastFailure",
    "lastVerification",
    "notificationKeys",
    "processedEventKeys",
    "outbox",
    "notificationStats",
    "telemetryStats",
    "incident",
    "pendingAutomaticVerification",
  ])) return false;
  const latestSampleStatus = value.latestSampleStatus;
  const lastVerification = value.lastVerification;
  const pending = value.pendingAutomaticVerification;
  const stats = value.notificationStats;
  const telemetryStats = value.telemetryStats;
  return value.version === TAVILY_STATE_VERSION &&
    isCanonicalIsoTimestamp(value.updatedAt) &&
    Number.isSafeInteger(value.incidentSequence) &&
    (value.incidentSequence as number) >= 0 &&
    (value.latestSample === undefined || validUsageSample(value.latestSample)) &&
    (latestSampleStatus === undefined ||
      (isRecord(latestSampleStatus) &&
        hasOnlyKeys(latestSampleStatus, ["classification", "observedAt", "httpStatus"]) &&
        (latestSampleStatus.classification === "ok" ||
          validMonitorClassification(latestSampleStatus.classification)) &&
        isCanonicalIsoTimestamp(latestSampleStatus.observedAt) &&
        (latestSampleStatus.httpStatus === undefined || validHttpStatus(latestSampleStatus.httpStatus)))) &&
    (value.lastFailure === undefined || validDiagnostic(value.lastFailure)) &&
    (lastVerification === undefined ||
      (isRecord(lastVerification) &&
        hasOnlyKeys(lastVerification, [
          "generation", "ok", "stage", "classification", "observedAt", "httpStatus",
        ]) &&
        boundedString(lastVerification.generation, 80) &&
        typeof lastVerification.ok === "boolean" &&
        ["usage", "usage_state", "search_probe", "extract_probe", "incident"].includes(
          lastVerification.stage as string,
        ) &&
        (lastVerification.classification === undefined ||
          validMonitorClassification(lastVerification.classification)) &&
        isCanonicalIsoTimestamp(lastVerification.observedAt) &&
        (lastVerification.httpStatus === undefined || validHttpStatus(lastVerification.httpStatus)))) &&
    Array.isArray(value.notificationKeys) &&
    value.notificationKeys.every((key) => boundedString(key, 256)) &&
    new Set(value.notificationKeys).size === value.notificationKeys.length &&
    Array.isArray(value.processedEventKeys) &&
    value.processedEventKeys.length <= MAX_PROCESSED_EVENT_KEYS &&
    value.processedEventKeys.every((key) => /^[a-f0-9]{64}$/.test(key as string)) &&
    new Set(value.processedEventKeys).size === value.processedEventKeys.length &&
    Array.isArray(value.outbox) &&
    value.outbox.every(validNotification) &&
    new Set(value.outbox.map((entry) => (entry as TavilyNotification).key)).size === value.outbox.length &&
    isRecord(stats) &&
    hasOnlyKeys(stats, ["delivered", "retried", "terminal"]) &&
    Number.isSafeInteger(stats.delivered) && (stats.delivered as number) >= 0 &&
    Number.isSafeInteger(stats.retried) && (stats.retried as number) >= 0 &&
    Number.isSafeInteger(stats.terminal) && (stats.terminal as number) >= 0 &&
    validTelemetryStats(telemetryStats) &&
    (value.incident === undefined || validIncident(value.incident)) &&
    (pending === undefined ||
      (isRecord(pending) &&
        hasOnlyKeys(pending, ["generation", "usageObservedAt"]) &&
        boundedString(pending.generation, 80) &&
        isCanonicalIsoTimestamp(pending.usageObservedAt)));
}

/** Owner-only atomic persistence for the single consolidated Tavily state document. */
export class TavilyStateStore {
  readonly path: string;
  private readonly now: () => Date;
  private readonly controlWorkspaceRoot: string;

  constructor(controlWorkspaceRoot: string, now: () => Date = () => new Date()) {
    this.controlWorkspaceRoot = resolve(controlWorkspaceRoot);
    this.path = resolve(this.controlWorkspaceRoot, TAVILY_STATE_RELPATH);
    this.now = now;
  }

  load(): TavilyMonitorState {
    try {
      assertPrivateFile(this.path);
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!validMonitorState(parsed)) throw new Error("Tavily monitor state is invalid");
      return structuredClone(parsed);
    } catch (error) {
      if (isMissing(error)) return freshState(this.now);
      if (error instanceof SyntaxError) throw new Error("Tavily monitor state is invalid");
      throw error;
    }
  }

  save(state: TavilyMonitorState): void {
    if (!validMonitorState(state)) throw new Error("Tavily monitor state is invalid");
    const directory = ensureMonitorDirectories(this.controlWorkspaceRoot);
    if (directory !== dirname(this.path)) {
      throw new Error("Tavily monitor state path is invalid");
    }
    try {
      assertPrivateFile(this.path);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const temporaryPath = join(directory, ".state.json.tmp");
    try {
      const temporary = lstatSync(temporaryPath);
      if (!temporary.isFile() && !temporary.isSymbolicLink()) {
        throw new Error("Tavily monitor temporary state is not a file");
      }
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporaryPath, this.path);
    } catch (error) {
      try { unlinkSync(temporaryPath); } catch { /* best-effort staging cleanup */ }
      throw error;
    }
  }
}

function notificationMessageForQuota(
  heading: string,
  scope: TavilyQuotaScope,
  sample: TavilyUsageSample | undefined,
  generation?: string,
): string {
  const quota = sample?.account[scope];
  const reset = sample?.resetAt ? ` Reset: ${sample.resetAt}.` : "";
  const generationText = generation ? ` Incident generation: ${generation}.` : "";
  return `${heading} Provider: Tavily. Scope: ${scope === "plan" ? "base plan" : "PAYGO"}. ` +
    `Usage: ${quota?.usage ?? "unavailable"}. Limit: ${quota?.limit ?? "unavailable"}. ` +
    `Remaining credits: ${quota?.remaining ?? "unavailable"}.${reset}${generationText} ` +
    `Affected tools: web_search, web_fetch. Billing: ${TAVILY_BILLING_URL}`;
}

function thresholdKey(sample: TavilyUsageSample, scope: TavilyQuotaScope, threshold: TavilyThreshold): string {
  return `threshold:${sample.cycleGeneration}:${scope}:${threshold}`;
}

function addNotification(
  state: TavilyMonitorState,
  notification: Omit<TavilyNotification, "attempts" | "status" | "nextAttemptAt">,
): boolean {
  if (state.notificationKeys.includes(notification.key)) return false;
  state.notificationKeys.push(notification.key);
  state.outbox.push({
    ...notification,
    attempts: 0,
    status: "pending",
    nextAttemptAt: notification.createdAt,
  });
  return true;
}

function cancelPendingNotifications(
  state: TavilyMonitorState,
  generation: string,
  kinds: readonly TavilyNotificationKind[],
): void {
  const canceledKinds = new Set<TavilyNotificationKind>(kinds);
  state.outbox = state.outbox.filter((entry) =>
    entry.status !== "pending" ||
    entry.incidentGeneration !== generation ||
    !canceledKinds.has(entry.kind));
}

function recordUsageSampleStat(state: TavilyMonitorState, outcome: "success" | "failure"): void {
  state.telemetryStats.usageSamples[outcome] += 1;
}

function recordFailureStat(
  state: TavilyMonitorState,
  diagnostic: Pick<TavilyMonitorDiagnostic, "classification" | "source">,
): void {
  const existing = state.telemetryStats.failures.find((entry) =>
    entry.classification === diagnostic.classification && entry.tool === diagnostic.source);
  if (existing) {
    existing.count += 1;
    return;
  }
  state.telemetryStats.failures.push({
    classification: diagnostic.classification,
    tool: diagnostic.source,
    count: 1,
  });
  state.telemetryStats.failures.sort((left, right) =>
    `${left.classification}:${left.tool}`.localeCompare(`${right.classification}:${right.tool}`));
}

function addThresholdNotifications(state: TavilyMonitorState, sample: TavilyUsageSample, now: string): void {
  for (const scope of ["plan", "paygo"] as const) {
    const quota = sample.account[scope];
    if (quota.limit <= 0) continue;
    const percentage = (quota.usage / quota.limit) * 100;
    for (const threshold of [80, 95] as const) {
      if (percentage < threshold) continue;
      const key = thresholdKey(sample, scope, threshold);
      addNotification(state, {
        key,
        kind: threshold === 80 ? "threshold_warning" : "threshold_critical",
        createdAt: now,
        message: notificationMessageForQuota(
          `Tavily quota ${threshold === 80 ? "warning" : "critical"} (${threshold}%).`,
          scope,
          sample,
        ),
      });
    }
  }
}

function exhaustionScope(classification: "base_plan_exhausted" | "paygo_exhausted"): TavilyQuotaScope {
  return classification === "base_plan_exhausted" ? "plan" : "paygo";
}

function incidentGeneration(state: TavilyMonitorState, observedAt: string): string {
  state.incidentSequence += 1;
  return `${tavilyBillingCycleGeneration(observedAt)}-${state.incidentSequence}`;
}

function laterTimestamp(left: string, right: string): string {
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function parseChildEvent(raw: unknown): TavilyChildEvent | undefined {
  if (!isRecord(raw)) return undefined;
  const allowed = new Set(["version", "tool", "classification", "httpStatus", "observedAt"]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) return undefined;
  if (raw.version !== TAVILY_CHILD_EVENT_VERSION) return undefined;
  if (raw.tool !== "web_search" && raw.tool !== "web_fetch") return undefined;
  if (typeof raw.classification !== "string" ||
      !TAVILY_FAILURE_CLASSIFICATIONS.has(raw.classification as TavilyFailureClassification)) {
    return undefined;
  }
  if (!isCanonicalIsoTimestamp(raw.observedAt)) return undefined;
  if (raw.httpStatus !== undefined &&
      (!Number.isInteger(raw.httpStatus) || (raw.httpStatus as number) < 100 || (raw.httpStatus as number) > 599)) {
    return undefined;
  }
  if (raw.classification === "base_plan_exhausted" && raw.httpStatus !== 432) return undefined;
  if (raw.classification === "paygo_exhausted" && raw.httpStatus !== 433) return undefined;
  return raw as unknown as TavilyChildEvent;
}

function eventKey(fileName: string, raw: string): string {
  return createHash("sha256").update(fileName).update("\0").update(raw).digest("hex");
}

/** Stateful quota/incident core used by the main-process lifecycle integration. */
export class TavilyMonitor {
  private readonly controlWorkspaceRoot: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly usageTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly reminderIntervalMs: number;
  private readonly statusStaleMs: number;
  private readonly onStateChange: TavilyStateObserver | undefined;
  private readonly eventDirectory: string;
  private readonly store: TavilyStateStore;
  private state: TavilyMonitorState;

  constructor(options: TavilyMonitorOptions) {
    this.controlWorkspaceRoot = resolve(options.controlWorkspaceRoot);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.usageTimeoutMs = options.usageTimeoutMs ?? TAVILY_USAGE_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? TAVILY_RECOVERY_PROBE_TIMEOUT_MS;
    this.reminderIntervalMs = options.reminderIntervalMs ?? TAVILY_REMINDER_INTERVAL_MS;
    this.statusStaleMs = options.statusStaleMs ?? TAVILY_STATUS_STALE_MS;
    if (!Number.isFinite(this.statusStaleMs) || this.statusStaleMs <= 0) {
      throw new Error("Tavily status stale interval must be positive");
    }
    this.onStateChange = options.onStateChange;
    this.eventDirectory = tavilyEventSpoolDirectory(this.controlWorkspaceRoot);
    this.store = new TavilyStateStore(this.controlWorkspaceRoot, this.now);
    this.state = this.store.load();
    this.refreshDiagnostics();
  }

  getState(): TavilyMonitorState {
    return structuredClone(this.state);
  }

  getStatus(at: Date = this.now()): TavilyStatusSnapshot {
    const now = validDate(at);
    const sample = this.state.latestSample;
    const latestStatus = this.state.latestSampleStatus;
    let sampleState: TavilyStatusSampleState;
    if (latestStatus && latestStatus.classification !== "ok") {
      sampleState = "error";
    } else if (!sample) {
      sampleState = "missing";
    } else {
      const ageMs = Math.max(0, now.getTime() - new Date(sample.observedAt).getTime());
      sampleState = ageMs > this.statusStaleMs ? "stale" : "fresh";
    }
    const incident = this.state.incident;
    return {
      sampleState,
      ...(sample === undefined
        ? {}
        : {
          sampledAt: sample.observedAt,
          plan: structuredClone(sample.account.plan),
          paygo: structuredClone(sample.account.paygo),
        }),
      ...(latestStatus === undefined ? {} : { latestAttemptAt: latestStatus.observedAt }),
      ...(this.state.lastFailure === undefined
        ? {}
        : { lastFailure: structuredClone(this.state.lastFailure) }),
      incident: !incident ? "none" : incident.resolvedAt ? "resolved" : "active",
      acknowledged: Boolean(incident?.acknowledgedAt),
    };
  }

  /** Re-publish the restored/current durable state without exposing mutable state to observers. */
  refreshDiagnostics(at: Date = this.now()): void {
    if (!this.onStateChange) return;
    this.onStateChange(structuredClone(this.state), validDate(at));
  }

  private commit(change: (state: TavilyMonitorState, now: string) => void): void {
    const now = isoNow(this.now);
    const candidate = structuredClone(this.state);
    change(candidate, now);
    candidate.updatedAt = now;
    this.store.save(candidate);
    this.state = candidate;
    this.refreshDiagnostics(new Date(now));
  }

  private recordUsageResult(
    result: TavilyUsageRequestResult,
    scheduleAutomatic: boolean,
    countSample = true,
  ): void {
    this.commit((state, now) => {
      if (countSample) recordUsageSampleStat(state, result.ok ? "success" : "failure");
      if (!result.ok) {
        state.latestSampleStatus = {
          classification: result.diagnostic.classification,
          observedAt: result.diagnostic.observedAt,
          ...(result.diagnostic.httpStatus === undefined
            ? {}
            : { httpStatus: result.diagnostic.httpStatus }),
        };
        state.lastFailure = result.diagnostic;
        recordFailureStat(state, result.diagnostic);
        return;
      }
      state.latestSample = result.sample;
      state.latestSampleStatus = { classification: "ok", observedAt: result.sample.observedAt };
      addThresholdNotifications(state, result.sample, now);
      const incident = state.incident;
      if (!incident || incident.resolvedAt) return;
      const recoverable = isTavilyUsageRecoverable(result.sample);
      const transitionedToRecoverable = recoverable && !incident.lastUsageRecoverable;
      incident.lastUsageRecoverable = recoverable;
      if (scheduleAutomatic && transitionedToRecoverable &&
          state.pendingAutomaticVerification?.generation !== incident.generation) {
        state.pendingAutomaticVerification = {
          generation: incident.generation,
          usageObservedAt: result.sample.observedAt,
        };
      }
    });
  }

  /** Sample once and automatically verify a newly recoverable active incident. */
  async sampleUsage(): Promise<TavilyUsageRequestResult> {
    const result = await requestTavilyUsage({
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      now: this.now,
      timeoutMs: this.usageTimeoutMs,
    });
    this.recordUsageResult(result, true);
    if (result.ok &&
        this.state.pendingAutomaticVerification?.usageObservedAt === result.sample.observedAt) {
      await this.runVerification(
        this.state.pendingAutomaticVerification.generation,
        result.sample,
      );
    }
    return result;
  }

  private applyChildEvent(state: TavilyMonitorState, event: TavilyChildEvent, now: string): void {
    state.lastFailure = monitorDiagnostic(
      event.classification,
      event.tool,
      event.observedAt,
      event.httpStatus,
    );
    recordFailureStat(state, state.lastFailure);
    if (event.classification !== "base_plan_exhausted" && event.classification !== "paygo_exhausted") {
      return;
    }

    const existing = state.incident;
    if (existing && !existing.resolvedAt) {
      existing.lastObservedAt = laterTimestamp(existing.lastObservedAt, event.observedAt);
      if (event.observedAt >= existing.lastObservedAt) existing.lastClassification = event.classification;
      if (!existing.observedTools.includes(event.tool)) existing.observedTools.push(event.tool);
      existing.lastUsageRecoverable = false;
      if (state.pendingAutomaticVerification?.generation === existing.generation) {
        delete state.pendingAutomaticVerification;
      }
      return;
    }
    if (existing?.resolvedAt) {
      const recoveryCutoff = existing.recoveryUsageObservedAt ?? existing.resolvedAt;
      if (new Date(event.observedAt).getTime() <= new Date(recoveryCutoff).getTime()) return;
      cancelPendingNotifications(state, existing.generation, ["recovery"]);
    }

    const generation = incidentGeneration(state, event.observedAt);
    const reminderAt = new Date(new Date(event.observedAt).getTime() + this.reminderIntervalMs).toISOString();
    state.incident = {
      generation,
      openedAt: event.observedAt,
      lastObservedAt: event.observedAt,
      lastClassification: event.classification,
      observedTools: [event.tool],
      nextReminderAt: reminderAt,
      lastUsageRecoverable: false,
    };
    addNotification(state, {
      key: `incident:${generation}:opened`,
      kind: "incident",
      createdAt: now,
      incidentGeneration: generation,
      message: notificationMessageForQuota(
        "Tavily credit exhaustion incident.",
        exhaustionScope(event.classification),
        state.latestSample,
        generation,
      ),
    });
  }

  /** Drain all committed child events; each state transition is saved before unlink. */
  drainChildEvents(): number {
    ensureMonitorDirectories(this.controlWorkspaceRoot);
    ensurePrivateDirectory(this.eventDirectory);
    let files: string[];
    try {
      files = readdirSync(this.eventDirectory).filter((file) => file.endsWith(".json")).sort();
    } catch {
      return 0;
    }
    let processed = 0;
    for (const file of files) {
      const path = join(this.eventDirectory, file);
      let raw: string;
      try {
        assertPrivateFile(path);
        raw = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      let event: TavilyChildEvent | undefined;
      try {
        event = parseChildEvent(JSON.parse(raw));
      } catch {
        event = undefined;
      }
      if (!event) {
        try { unlinkSync(path); } catch { /* retry cleanup on the next drain */ }
        continue;
      }
      const key = eventKey(basename(path), raw);
      if (!this.state.processedEventKeys.includes(key)) {
        this.commit((state, now) => {
          state.processedEventKeys.push(key);
          if (state.processedEventKeys.length > MAX_PROCESSED_EVENT_KEYS) {
            state.processedEventKeys.splice(0, state.processedEventKeys.length - MAX_PROCESSED_EVENT_KEYS);
          }
          this.applyChildEvent(state, event as TavilyChildEvent, now);
        });
        processed += 1;
      }
      try { unlinkSync(path); } catch { /* committed replay is idempotent */ }
    }
    return processed;
  }

  /** Queue at most one due reminder and advance its stable six-hour cadence. */
  queueDueReminder(): boolean {
    const incident = this.state.incident;
    const nowDate = validDate(this.now());
    if (!incident || incident.resolvedAt || incident.acknowledgedAt || incident.deliveryTerminalAt ||
        nowDate.getTime() < new Date(incident.nextReminderAt).getTime()) {
      return false;
    }
    let queued = false;
    this.commit((state, now) => {
      const current = state.incident;
      if (!current || current.resolvedAt || current.acknowledgedAt || current.deliveryTerminalAt) return;
      const scheduledAt = current.nextReminderAt;
      queued = addNotification(state, {
        key: `incident:${current.generation}:reminder:${scheduledAt}`,
        kind: "reminder",
        createdAt: now,
        incidentGeneration: current.generation,
        message: notificationMessageForQuota(
          "Tavily credit exhaustion reminder.",
          exhaustionScope(current.lastClassification),
          state.latestSample,
          current.generation,
        ),
      });
      let next = new Date(scheduledAt).getTime();
      const nowMs = new Date(now).getTime();
      do next += this.reminderIntervalMs; while (next <= nowMs);
      current.nextReminderAt = new Date(next).toISOString();
    });
    return queued;
  }

  /** Retry one active incident after an operator explicitly restarts with a usable destination. */
  resumeIncidentDelivery(): boolean {
    const incident = this.state.incident;
    if (!incident || incident.resolvedAt || incident.acknowledgedAt || !incident.deliveryTerminalAt) {
      return false;
    }
    this.commit((state, now) => {
      const current = state.incident;
      if (!current || current.resolvedAt || current.acknowledgedAt || !current.deliveryTerminalAt) return;
      delete current.deliveryTerminalAt;
      current.nextReminderAt = now;
    });
    return true;
  }

  acknowledgeIncident(generation: string): boolean {
    const incident = this.state.incident;
    if (!incident || incident.generation !== generation || incident.resolvedAt) return false;
    if (incident.acknowledgedAt) return true;
    this.commit((state, now) => {
      if (state.incident?.generation === generation && !state.incident.resolvedAt) {
        state.incident.acknowledgedAt = now;
        cancelPendingNotifications(state, generation, ["reminder"]);
      }
    });
    return true;
  }

  isIncidentActive(generation: string): boolean {
    const incident = this.state.incident;
    return incident?.generation === generation && incident.resolvedAt === undefined;
  }

  private verificationFailure(
    generation: string,
    stage: TavilyRecoveryStage,
    classification: TavilyMonitorFailureClassification,
    httpStatus?: number,
    notifyOperator = false,
  ): TavilyRecoveryResult {
    this.commit((state, now) => {
      state.lastVerification = {
        generation,
        ok: false,
        stage,
        classification,
        observedAt: now,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      };
      state.lastFailure = monitorDiagnostic(
        classification,
        stage === "search_probe" ? "recovery_search" :
          stage === "extract_probe" ? "recovery_extract" : "usage",
        now,
        httpStatus,
      );
      recordFailureStat(state, state.lastFailure);
      if (stage === "usage") {
        recordUsageSampleStat(state, "failure");
        state.latestSampleStatus = {
          classification,
          observedAt: now,
          ...(httpStatus === undefined ? {} : { httpStatus }),
        };
      }
      if (state.pendingAutomaticVerification?.generation === generation) {
        delete state.pendingAutomaticVerification;
      }
      if (notifyOperator) {
        const failureSequence = state.notificationKeys.length + 1;
        addNotification(state, {
          key: `incident:${generation}:recheck-failure:${now}:${failureSequence}`,
          kind: "recheck_failure",
          createdAt: now,
          incidentGeneration: generation,
          message: `Tavily recovery check failed at ${stage} (${classification}). ` +
            "The incident remains active.",
        });
      }
    });
    return {
      ok: false,
      generation,
      stage,
      classification,
      ...(httpStatus === undefined ? {} : { httpStatus }),
    };
  }

  private async runVerification(
    generation: string,
    usageSample?: TavilyUsageSample,
    notifyOperator = false,
  ): Promise<TavilyRecoveryResult> {
    this.drainChildEvents();
    const incident = this.state.incident;
    if (!incident || incident.generation !== generation || incident.resolvedAt) {
      return {
        ok: false,
        generation,
        stage: "incident",
        classification: "stale_incident",
      };
    }
    const lastObservedBeforeVerification = incident.lastObservedAt;

    const result = await verifyTavilyRecovery({
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      now: this.now,
      timeoutMs: this.usageTimeoutMs,
      probeTimeoutMs: this.probeTimeoutMs,
      ...(usageSample === undefined ? {} : { usageSample }),
    });
    if (!result.ok) {
      if (result.sample) {
        this.recordUsageResult(
          { ok: true, sample: result.sample },
          false,
          usageSample === undefined,
        );
      }
      return this.verificationFailure(
        generation,
        result.stage,
        result.classification as TavilyMonitorFailureClassification,
        result.httpStatus,
        notifyOperator,
      );
    }
    this.recordUsageResult(
      { ok: true, sample: result.sample },
      false,
      usageSample === undefined,
    );
    return withTavilyEventPublicationLock(this.controlWorkspaceRoot, () => {
      // A writer takes the same lock before it timestamps or stages an event.
      // Acquiring it here therefore waits for every already-started publication
      // before recovery can be committed or exposed to the delivery runtime.
      this.drainChildEvents();
      const current = this.state.incident;
      const exhaustionAfterUsage = current?.lastObservedAt !== undefined &&
        (current.lastObservedAt > result.sample.observedAt ||
          (current.lastObservedAt === result.sample.observedAt &&
            current.lastObservedAt !== lastObservedBeforeVerification));
      if (current?.generation === generation && !current.resolvedAt &&
          exhaustionAfterUsage) {
        return this.verificationFailure(
          generation,
          "usage_state",
          "usage_exhausted",
          undefined,
          notifyOperator,
        );
      }
      this.commit((state, now) => {
        const active = state.incident;
        if (!active || active.generation !== generation || active.resolvedAt) return;
        active.resolvedAt = now;
        active.recoveryUsageObservedAt = result.sample.observedAt;
        delete state.pendingAutomaticVerification;
        state.lastVerification = {
          generation,
          ok: true,
          stage: "extract_probe",
          observedAt: now,
        };
        cancelPendingNotifications(state, generation, ["incident", "reminder", "recheck_failure"]);
        addNotification(state, {
          key: `incident:${generation}:recovery`,
          kind: "recovery",
          createdAt: now,
          incidentGeneration: generation,
          message: `Tavily recovered. Provider: Tavily. Incident generation: ${generation}. ` +
            "Verified tools: web_search, web_fetch.",
        });
      });
      // Preserve same-process reentrant safety for observers/tests that publish
      // synchronously from a state transition while the outer lock is held.
      this.drainChildEvents();
      const afterResolution = this.state.incident;
      if (afterResolution && afterResolution.generation !== generation && !afterResolution.resolvedAt) {
        return {
          ok: false,
          generation,
          stage: "usage_state",
          classification: "usage_exhausted",
        };
      }
      return { ok: true, generation, sample: result.sample };
    });
  }

  recheckIncident(generation: string): Promise<TavilyRecoveryResult> {
    return this.runVerification(generation, undefined, true);
  }

  /** Resume a crash-interrupted automatic verification using a fresh usage read. */
  runPendingAutomaticRecovery(): Promise<TavilyRecoveryResult | undefined> {
    const pending = this.state.pendingAutomaticVerification;
    if (!pending) return Promise.resolve(undefined);
    return this.runVerification(pending.generation);
  }

  dueNotifications(at: Date = this.now()): TavilyNotification[] {
    validDate(at);
    return this.state.outbox
      .filter((entry) => entry.status === "pending" &&
        new Date(entry.nextAttemptAt).getTime() <= at.getTime())
      .map((entry) => structuredClone(entry));
  }

  recordNotificationDelivered(key: string): boolean {
    if (!this.state.outbox.some((entry) => entry.key === key)) return false;
    this.commit((state) => {
      const index = state.outbox.findIndex((entry) => entry.key === key);
      if (index < 0) return;
      state.outbox.splice(index, 1);
      state.notificationStats.delivered += 1;
    });
    return true;
  }

  recordNotificationRetry(
    key: string,
    nextAttemptAt: Date,
    failure: Exclude<TavilyNotificationFailure, "destination_invalid">,
  ): boolean {
    validDate(nextAttemptAt);
    if (!this.state.outbox.some((entry) => entry.key === key && entry.status === "pending")) return false;
    this.commit((state) => {
      const entry = state.outbox.find((candidate) => candidate.key === key && candidate.status === "pending");
      if (!entry) return;
      entry.attempts += 1;
      entry.nextAttemptAt = nextAttemptAt.toISOString();
      entry.lastFailure = failure;
      state.notificationStats.retried += 1;
    });
    return true;
  }

  recordNotificationTerminal(key: string): boolean {
    if (!this.state.outbox.some((entry) => entry.key === key && entry.status === "pending")) return false;
    this.commit((state, now) => {
      const entry = state.outbox.find((candidate) => candidate.key === key && candidate.status === "pending");
      if (!entry) return;
      entry.attempts += 1;
      entry.status = "terminal";
      entry.lastFailure = "destination_invalid";
      state.notificationStats.terminal += 1;
      const incident = state.incident;
      if (incident && !incident.resolvedAt && entry.incidentGeneration === incident.generation) {
        incident.deliveryTerminalAt = now;
        cancelPendingNotifications(state, incident.generation, ["reminder"]);
      }
    });
    return true;
  }
}
