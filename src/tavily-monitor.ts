import { createHash } from "node:crypto";
import {
  chmodSync,
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
  classifyTavilyFailure,
  parseExtractResponse,
  parseSearchResponse,
  type TavilyFailureClassification,
} from "./pi-extensions/tavily.js";
import {
  TAVILY_CHILD_EVENT_VERSION,
  tavilyEventSpoolDirectory,
  type TavilyChildEvent,
} from "./pi-extensions/tavily-events.js";

export const TAVILY_USAGE_URL = "https://api.tavily.com/usage";
export const TAVILY_BILLING_URL = "https://app.tavily.com/billing";
export const TAVILY_RECOVERY_SEARCH_QUERY = "Tavily API documentation";
export const TAVILY_RECOVERY_EXTRACT_URL = "https://example.com/";
export const TAVILY_STATE_VERSION = 1 as const;
export const TAVILY_STATE_RELPATH = "data/tavily/state.json";
export const TAVILY_EVENT_POLL_INTERVAL_MS = 2_000;
export const TAVILY_USAGE_TIMEOUT_MS = 10_000;
export const TAVILY_RECOVERY_PROBE_TIMEOUT_MS = 10_000;
export const TAVILY_REMINDER_INTERVAL_MS = 6 * 60 * 60 * 1_000;

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
  acknowledgedAt?: string;
  resolvedAt?: string;
}

export interface TavilyPendingAutomaticVerification {
  generation: string;
  usageObservedAt: string;
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
  thresholdNotificationKeys: string[];
  notificationKeys: string[];
  processedEventKeys: string[];
  outbox: TavilyNotification[];
  notificationStats: {
    delivered: number;
    retried: number;
    terminal: number;
  };
  incident?: TavilyIncident;
  pendingAutomaticVerification?: TavilyPendingAutomaticVerification;
}

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
  eventPollIntervalMs?: number;
  reminderIntervalMs?: number;
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
    timeout.cancel();
    const failure = classifyTavilyFailure({ kind: "http", httpStatus: response.status });
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

/** True when at least one provider credit path can currently serve requests. */
export function isTavilyUsageRecoverable(sample: TavilyUsageSample): boolean {
  return sample.account.plan.usage < sample.account.plan.limit ||
    (sample.account.paygo.limit > 0 && sample.account.paygo.usage < sample.account.paygo.limit);
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
    timeout.cancel();
    const failure = classifyTavilyFailure({ kind: "http", httpStatus: response.status });
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
    thresholdNotificationKeys: [],
    notificationKeys: [],
    processedEventKeys: [],
    outbox: [],
    notificationStats: { delivered: 0, retried: 0, terminal: 0 },
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
        "acknowledgedAt",
        "resolvedAt",
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
      (value.acknowledgedAt !== undefined && !isCanonicalIsoTimestamp(value.acknowledgedAt)) ||
      (value.resolvedAt !== undefined && !isCanonicalIsoTimestamp(value.resolvedAt))) {
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
      !["threshold_warning", "threshold_critical", "incident", "reminder", "recovery"].includes(
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
    "thresholdNotificationKeys",
    "notificationKeys",
    "processedEventKeys",
    "outbox",
    "notificationStats",
    "incident",
    "pendingAutomaticVerification",
  ])) return false;
  const latestSampleStatus = value.latestSampleStatus;
  const lastVerification = value.lastVerification;
  const pending = value.pendingAutomaticVerification;
  const stats = value.notificationStats;
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
    Array.isArray(value.thresholdNotificationKeys) &&
    value.thresholdNotificationKeys.every((key) => boundedString(key, 256)) &&
    new Set(value.thresholdNotificationKeys).size === value.thresholdNotificationKeys.length &&
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
      chmodSync(this.path, 0o600);
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

function addThresholdNotifications(state: TavilyMonitorState, sample: TavilyUsageSample, now: string): void {
  for (const scope of ["plan", "paygo"] as const) {
    const quota = sample.account[scope];
    if (quota.limit <= 0) continue;
    const percentage = (quota.usage / quota.limit) * 100;
    for (const threshold of [80, 95] as const) {
      if (percentage < threshold) continue;
      const key = thresholdKey(sample, scope, threshold);
      if (state.thresholdNotificationKeys.includes(key)) continue;
      state.thresholdNotificationKeys.push(key);
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
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly usageTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly eventPollIntervalMs: number;
  private readonly reminderIntervalMs: number;
  private readonly eventDirectory: string;
  private readonly store: TavilyStateStore;
  private state: TavilyMonitorState;
  private eventTimer: ReturnType<typeof setInterval> | undefined;
  private readonly verificationFlights = new Map<string, Promise<TavilyRecoveryResult>>();

  constructor(options: TavilyMonitorOptions) {
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.usageTimeoutMs = options.usageTimeoutMs ?? TAVILY_USAGE_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? TAVILY_RECOVERY_PROBE_TIMEOUT_MS;
    this.eventPollIntervalMs = options.eventPollIntervalMs ?? TAVILY_EVENT_POLL_INTERVAL_MS;
    this.reminderIntervalMs = options.reminderIntervalMs ?? TAVILY_REMINDER_INTERVAL_MS;
    this.eventDirectory = tavilyEventSpoolDirectory(options.controlWorkspaceRoot);
    this.store = new TavilyStateStore(options.controlWorkspaceRoot, this.now);
    this.state = this.store.load();
  }

  getState(): TavilyMonitorState {
    return structuredClone(this.state);
  }

  private commit(change: (state: TavilyMonitorState, now: string) => void): void {
    const now = isoNow(this.now);
    change(this.state, now);
    this.state.updatedAt = now;
    this.store.save(this.state);
  }

  private recordUsageResult(result: TavilyUsageRequestResult, scheduleAutomatic: boolean): void {
    this.commit((state, now) => {
      if (!result.ok) {
        state.latestSampleStatus = {
          classification: result.diagnostic.classification,
          observedAt: result.diagnostic.observedAt,
          ...(result.diagnostic.httpStatus === undefined
            ? {}
            : { httpStatus: result.diagnostic.httpStatus }),
        };
        state.lastFailure = result.diagnostic;
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
    if (event.classification !== "base_plan_exhausted" && event.classification !== "paygo_exhausted") {
      return;
    }

    const existing = state.incident;
    if (existing && !existing.resolvedAt) {
      existing.lastObservedAt = laterTimestamp(existing.lastObservedAt, event.observedAt);
      if (event.observedAt >= existing.lastObservedAt) existing.lastClassification = event.classification;
      if (!existing.observedTools.includes(event.tool)) existing.observedTools.push(event.tool);
      return;
    }
    if (existing?.resolvedAt && new Date(event.observedAt).getTime() <= new Date(existing.resolvedAt).getTime()) {
      return;
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
    ensureMonitorDirectories(dirname(dirname(dirname(this.eventDirectory))));
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

  /** Startup drain followed by the package's short, unref'ed polling pattern. */
  startChildEventPolling(): void {
    if (this.eventTimer) return;
    this.drainChildEvents();
    this.eventTimer = setInterval(() => this.drainChildEvents(), this.eventPollIntervalMs);
    this.eventTimer.unref();
  }

  stopChildEventPolling(): void {
    if (!this.eventTimer) return;
    clearInterval(this.eventTimer);
    this.eventTimer = undefined;
  }

  /** Queue at most one due reminder and advance its stable six-hour cadence. */
  queueDueReminder(): boolean {
    const incident = this.state.incident;
    const nowDate = validDate(this.now());
    if (!incident || incident.resolvedAt || incident.acknowledgedAt ||
        nowDate.getTime() < new Date(incident.nextReminderAt).getTime()) {
      return false;
    }
    let queued = false;
    this.commit((state, now) => {
      const current = state.incident;
      if (!current || current.resolvedAt || current.acknowledgedAt) return;
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

  acknowledgeIncident(generation: string): boolean {
    const incident = this.state.incident;
    if (!incident || incident.generation !== generation || incident.resolvedAt) return false;
    if (incident.acknowledgedAt) return true;
    this.commit((state, now) => {
      if (state.incident?.generation === generation && !state.incident.resolvedAt) {
        state.incident.acknowledgedAt = now;
      }
    });
    return true;
  }

  private verificationFailure(
    generation: string,
    stage: TavilyRecoveryStage,
    classification: TavilyMonitorFailureClassification,
    httpStatus?: number,
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
      if (stage === "usage") {
        state.latestSampleStatus = {
          classification,
          observedAt: now,
          ...(httpStatus === undefined ? {} : { httpStatus }),
        };
      }
      if (state.pendingAutomaticVerification?.generation === generation) {
        delete state.pendingAutomaticVerification;
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

  private runVerification(
    generation: string,
    usageSample?: TavilyUsageSample,
  ): Promise<TavilyRecoveryResult> {
    const existingFlight = this.verificationFlights.get(generation);
    if (existingFlight) return existingFlight;
    const incident = this.state.incident;
    if (!incident || incident.generation !== generation || incident.resolvedAt) {
      return Promise.resolve({
        ok: false,
        generation,
        stage: "incident",
        classification: "stale_incident",
      });
    }

    const flight = (async (): Promise<TavilyRecoveryResult> => {
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
          this.recordUsageResult({ ok: true, sample: result.sample }, false);
        }
        return this.verificationFailure(
          generation,
          result.stage,
          result.classification as TavilyMonitorFailureClassification,
          result.httpStatus,
        );
      }
      this.recordUsageResult({ ok: true, sample: result.sample }, false);
      this.commit((state, now) => {
        const current = state.incident;
        if (!current || current.generation !== generation || current.resolvedAt) return;
        current.resolvedAt = now;
        delete state.pendingAutomaticVerification;
        state.lastVerification = {
          generation,
          ok: true,
          stage: "extract_probe",
          observedAt: now,
        };
        addNotification(state, {
          key: `incident:${generation}:recovery`,
          kind: "recovery",
          createdAt: now,
          incidentGeneration: generation,
          message: `Tavily recovered. Provider: Tavily. Incident generation: ${generation}. ` +
            "Verified tools: web_search, web_fetch.",
        });
      });
      return { ok: true, generation, sample: result.sample };
    })();
    this.verificationFlights.set(generation, flight);
    void flight.then(
      () => this.verificationFlights.delete(generation),
      () => this.verificationFlights.delete(generation),
    );
    return flight;
  }

  recheckIncident(generation: string): Promise<TavilyRecoveryResult> {
    return this.runVerification(generation);
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
    this.commit((state) => {
      const entry = state.outbox.find((candidate) => candidate.key === key && candidate.status === "pending");
      if (!entry) return;
      entry.attempts += 1;
      entry.status = "terminal";
      entry.lastFailure = "destination_invalid";
      state.notificationStats.terminal += 1;
    });
    return true;
  }
}
