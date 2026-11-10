import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const CODEX_QUOTA_STATE_FILE_ENV = "CODEX_QUOTA_STATE_FILE";
export const CODEX_QUOTA_TEXTFILE_DIR_ENV = "CODEX_QUOTA_TEXTFILE_DIR";
export const NODE_EXPORTER_TEXTFILE_DIR_ENV = "NODE_EXPORTER_TEXTFILE_DIR";
export const CODEX_QUOTA_ATTEMPT_FILE_ENV = "CODEX_QUOTA_ATTEMPT_FILE";
export const DEFAULT_NODE_EXPORTER_TEXTFILE_DIR = "/opt/homebrew/var/node_exporter/textfile";
export const DEFAULT_CODEX_QUOTA_STATE_FILENAME = "codex-quota-state.json";
export const DEFAULT_CODEX_QUOTA_STATE_RELPATH = join(".tmp", DEFAULT_CODEX_QUOTA_STATE_FILENAME);
export const CODEX_USAGE_TEXTFILE_NAME = "codex_usage.prom";

export type CodexQuotaWindowName = "primary" | "secondary";

export interface CodexQuotaWindow {
  durationSeconds?: number;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
  resetTimestamp?: number;
}

export interface CodexQuotaFamily {
  id: string;
  name?: string;
  meteredFeature?: string;
  allowed?: boolean;
  limitReached?: boolean;
  windows: Partial<Record<CodexQuotaWindowName, CodexQuotaWindow>>;
}

export interface CodexQuotaSnapshot {
  provider: "codex";
  sampledAt: string;
  lastSuccess: string;
  lastSuccessTimestamp: number;
  lastAttempt?: string;
  lastAttemptTimestamp?: number;
  probeSuccess?: boolean;
  planType?: string;
  activeLimit?: string;
  families: CodexQuotaFamily[];
}

export interface CodexQuotaPathOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stateFile?: string;
  defaultStateDir?: string;
  textfileDir?: string;
  isWritableDir?: (path: string) => boolean;
}

export interface CodexQuotaPaths {
  stateFile: string;
  textfileDir?: string;
}

export interface CodexQuotaWriteOptions extends CodexQuotaPathOptions {
  textfileName?: string;
}

export interface CodexQuotaCaptureOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  attemptFile?: string;
  now?: Date;
}

export interface CodexQuotaWriteResult {
  stateFile: string;
  metricsFile?: string;
}

export type CodexQuotaRecordResult =
  | { status: "no_quota_headers" }
  | ({ status: "written"; snapshot: CodexQuotaSnapshot } & CodexQuotaWriteResult)
  | { status: "write_error"; snapshot: CodexQuotaSnapshot; error: unknown };

export type CodexQuotaCaptureResult =
  | { status: "no_quota_headers" }
  | {
    status: "captured";
    snapshot: CodexQuotaSnapshot;
    attemptFile: string;
  }
  | { status: "write_error"; snapshot?: CodexQuotaSnapshot; error: unknown };

interface HeaderGetter {
  get: (name: string) => unknown;
}

export function resolveCodexQuotaPaths(options: CodexQuotaPathOptions = {}): CodexQuotaPaths {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const defaultStateDir = configuredPath(options.defaultStateDir, cwd);
  const stateFile =
    configuredPath(options.stateFile, cwd) ??
    configuredPath(env[CODEX_QUOTA_STATE_FILE_ENV], cwd) ??
    (defaultStateDir
      ? resolve(defaultStateDir, DEFAULT_CODEX_QUOTA_STATE_FILENAME)
      : resolve(cwd, DEFAULT_CODEX_QUOTA_STATE_RELPATH));

  const explicitTextfileDir =
    configuredPath(options.textfileDir, cwd) ??
    configuredPath(env[CODEX_QUOTA_TEXTFILE_DIR_ENV], cwd) ??
    configuredPath(env[NODE_EXPORTER_TEXTFILE_DIR_ENV], cwd);
  if (explicitTextfileDir) {
    return { stateFile, textfileDir: explicitTextfileDir };
  }

  const isWritableDir = options.isWritableDir ?? isDirWritable;
  if (isWritableDir(DEFAULT_NODE_EXPORTER_TEXTFILE_DIR)) {
    return { stateFile, textfileDir: DEFAULT_NODE_EXPORTER_TEXTFILE_DIR };
  }

  return { stateFile };
}

function newSnapshot(families: CodexQuotaFamily[], now: Date): CodexQuotaSnapshot | null {
  if (!families.some((family) => Object.values(family.windows).some((window) => window.usedPercent !== undefined))) {
    return null;
  }
  return {
    provider: "codex", sampledAt: now.toISOString(), lastSuccess: now.toISOString(),
    lastSuccessTimestamp: Math.floor(now.getTime() / 1000), families,
  };
}

export function parseCodexQuotaHeaders(headers: unknown, now = new Date()): CodexQuotaSnapshot | null {
  const ids = new Set(["codex"]);
  for (const key of headerNames(headers)) {
    const match = /^x-(.+)-(?:primary|secondary)-/.exec(key.toLowerCase());
    if (match) ids.add(match[1]);
  }
  const families: CodexQuotaFamily[] = [];
  for (const id of ids) {
    const family: CodexQuotaFamily = { id: id.replace(/-/g, "_"), windows: {} };
    family.name = normalizeHeaderText(getHeaderValue(headers, `x-${id}-limit-name`));
    for (const slot of ["primary", "secondary"] as const) {
      const prefix = `x-${id}-${slot}-`;
      const window: CodexQuotaWindow = {};
      setUsedPercent(window, getHeaderValue(headers, prefix + "used-percent"));
      setResetAt(window, getHeaderValue(headers, prefix + "reset-at"));
      const minutes = parseNonNegativeNumber(getHeaderValue(headers, prefix + "window-minutes"));
      if (minutes !== undefined && minutes > 0 && Number.isFinite(minutes * 60)) window.durationSeconds = minutes * 60;
      // Upstream sometimes supplies a zero-filled absent window.
      if (minutes === 0 && !window.usedPercent && !window.resetTimestamp) continue;
      if (window.usedPercent !== undefined) family.windows[slot] = window;
    }
    if (Object.keys(family.windows).length) families.push(family);
  }
  const snapshot = newSnapshot(families, now);
  if (snapshot) {
    snapshot.planType = normalizeHeaderText(getHeaderValue(headers, "x-codex-plan-type"));
    snapshot.activeLimit = normalizeHeaderText(getHeaderValue(headers, "x-codex-active-limit"));
  }
  return snapshot;
}

/** Retain quota metadata only; never persist the surrounding account/credits payload. */
export function parseCodexQuotaUsage(raw: unknown, now = new Date()): CodexQuotaSnapshot | null {
  const body = objectRecord(raw);
  if (!body) return null;
  const families: CodexQuotaFamily[] = [];
  const add = (id: string, rateLimit: unknown, name?: string, meteredFeature?: string) => {
    const rate = objectRecord(rateLimit);
    if (!rate) return;
    const family: CodexQuotaFamily = { id, name, meteredFeature, windows: {} };
    if (typeof rate.allowed === "boolean") family.allowed = rate.allowed;
    if (typeof rate.limit_reached === "boolean") family.limitReached = rate.limit_reached;
    for (const slot of ["primary", "secondary"] as const) {
      const source = objectRecord(rate[`${slot}_window`]);
      if (!source) continue;
      const window: CodexQuotaWindow = {};
      const used = nonNegativeNumber(source.used_percent);
      const duration = nonNegativeNumber(source.limit_window_seconds);
      const reset = nonNegativeNumber(source.reset_at);
      const after = nonNegativeNumber(source.reset_after_seconds);
      if (used === undefined || (duration === 0 && used === 0 && !reset && !after)) continue;
      setUsedPercent(window, used);
      if (duration !== undefined && duration > 0) window.durationSeconds = duration;
      setResetAt(window, reset ? String(reset) : after !== undefined ? String(Math.floor(now.getTime() / 1000) + after) : undefined);
      family.windows[slot] = window;
    }
    if (Object.keys(family.windows).length) families.push(family);
  };
  add("codex", body.rate_limit);
  if (Array.isArray(body.additional_rate_limits)) {
    for (const entry of body.additional_rate_limits) {
      const item = objectRecord(entry);
      if (!item) continue;
      const name = normalizeQuotaText(item.limit_name);
      const feature = normalizeQuotaText(item.metered_feature);
      const id = feature ?? name;
      if (id) add(id, item.rate_limit, name, feature);
    }
  }
  const snapshot = newSnapshot(families, now);
  if (snapshot) snapshot.planType = normalizeQuotaText(body.plan_type);
  return snapshot;
}

function normalizeQuotaText(raw: unknown): string | undefined {
  return typeof raw === "string" ? normalizeHeaderText(raw) : undefined;
}

function objectRecord(raw: unknown): Record<string, unknown> | undefined {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

function nonNegativeNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

function headerNames(headers: unknown): string[] {
  if (headers instanceof Headers) return [...headers.keys()];
  if (Array.isArray(headers)) return headers.flatMap((entry) => Array.isArray(entry) && typeof entry[0] === "string" ? [entry[0]] : []);
  if (headers && typeof headers === "object") return Object.keys(headers);
  return [];
}

export function extractCodexResponseHeaders(input: unknown): unknown | undefined {
  return findHeaderSource(input, 0, new Set<object>());
}

export function recordCodexQuotaFromProviderResponse(
  input: unknown,
  options: CodexQuotaWriteOptions & { now?: Date } = {},
): CodexQuotaRecordResult {
  const headers = extractCodexResponseHeaders(input);
  if (!headers) {
    return { status: "no_quota_headers" };
  }
  return recordCodexQuotaFromHeaders(headers, options);
}

export function recordCodexQuotaFromHeaders(
  headers: unknown,
  options: CodexQuotaWriteOptions & { now?: Date } = {},
): CodexQuotaRecordResult {
  const snapshot = parseCodexQuotaHeaders(headers, options.now ?? new Date());
  if (!snapshot) {
    return { status: "no_quota_headers" };
  }

  try {
    return {
      status: "written",
      snapshot,
      ...writeCodexQuotaSnapshot(snapshot, options),
    };
  } catch (error) {
    return { status: "write_error", snapshot, error };
  }
}

export function captureCodexQuotaFromProviderResponse(
  input: unknown,
  options: CodexQuotaCaptureOptions = {},
): CodexQuotaCaptureResult {
  return captureCodexQuotaFromHeaders(extractCodexResponseHeaders(input), options);
}

export function captureCodexQuotaFromHeaders(
  headers: unknown,
  options: CodexQuotaCaptureOptions = {},
): CodexQuotaCaptureResult {
  const snapshot = parseCodexQuotaHeaders(headers, options.now ?? new Date());
  if (!snapshot) {
    return { status: "no_quota_headers" };
  }

  try {
    const attemptFile = resolveCodexQuotaAttemptFile(options);
    atomicWriteFile(attemptFile, `${JSON.stringify(snapshot, null, 2)}\n`);
    return {
      status: "captured",
      snapshot,
      attemptFile,
    };
  } catch (error) {
    return { status: "write_error", snapshot, error };
  }
}

export function writeCodexQuotaSnapshot(
  snapshot: CodexQuotaSnapshot,
  options: CodexQuotaWriteOptions = {},
): CodexQuotaWriteResult {
  const paths = resolveCodexQuotaPaths(options);
  const writes: Array<{ path: string; content: string }> = [
    { path: paths.stateFile, content: `${JSON.stringify(snapshot, null, 2)}\n` },
  ];

  if (!paths.textfileDir) {
    atomicWriteFiles(writes);
    return { stateFile: paths.stateFile };
  }

  const metricsFile = join(paths.textfileDir, options.textfileName ?? CODEX_USAGE_TEXTFILE_NAME);
  writes.push({ path: metricsFile, content: formatCodexQuotaPrometheus(snapshot) });
  atomicWriteFiles(writes);
  return { stateFile: paths.stateFile, metricsFile };
}

export function formatCodexQuotaPrometheus(snapshot: CodexQuotaSnapshot): string {
  const lines: string[] = [];
  for (const [metric, field] of [
    ["percent", "usedPercent"], ["reset_timestamp", "resetTimestamp"], ["duration_seconds", "durationSeconds"],
  ] as const) {
    const name = `codex_usage_window_${metric}`;
    lines.push(`# HELP ${name} Codex quota window ${metric} from the last successful read.`, `# TYPE ${name} gauge`);
    for (const family of snapshot.families) {
      for (const [slot, window] of Object.entries(family.windows)) {
        const value = window[field];
        if (value !== undefined) {
          const labels = `family="${prometheusLabelValue(family.id)}",window="${slot}"`;
          lines.push(`${name}{${labels}} ${formatPrometheusNumber(value)}`);
        }
      }
    }
  }
  // Preserve semantic legacy series only for known durations in the default family.
  const defaults = snapshot.families.find((family) => family.id === "codex");
  for (const [duration, legacy] of [[18000, "5h"], [604800, "weekly"]] as const) {
    const window = Object.values(defaults?.windows ?? {}).find((window) => window.durationSeconds === duration);
    if (!window) continue;
    pushGauge(lines, `codex_usage_${legacy}_percent`, "Codex usage percent for this duration.", window.usedPercent);
    pushGauge(lines, `codex_usage_${legacy}_reset_timestamp`, "Unix timestamp when this Codex window resets.", window.resetTimestamp);
  }
  pushGauge(
    lines,
    "codex_usage_last_success_timestamp",
    "Unix timestamp of the last successful Codex quota sampler probe.",
    snapshot.lastSuccessTimestamp,
  );

  const planType = prometheusLabelValue(lowCardinalityLabel(snapshot.planType));
  const activeLimit = prometheusLabelValue(lowCardinalityLabel(snapshot.activeLimit));
  lines.push(
    "# HELP codex_usage_info Codex quota metadata from the last successful sampler probe.",
    "# TYPE codex_usage_info gauge",
    `codex_usage_info{provider="codex",plan_type="${planType}",active_limit="${activeLimit}"} 1`,
  );

  return `${lines.join("\n")}\n`;
}

export function formatCodexQuotaWriteError(_error: unknown): string {
  return "[codex-usage] failed to write quota cache: local_write_failed";
}

function configuredPath(raw: string | undefined, cwd: string): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? resolve(cwd, trimmed) : undefined;
}

function resolveCodexQuotaAttemptFile(options: CodexQuotaCaptureOptions): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const attemptFile =
    configuredPath(options.attemptFile, cwd) ??
    configuredPath(env[CODEX_QUOTA_ATTEMPT_FILE_ENV], cwd);
  if (!attemptFile) {
    throw new Error(`${CODEX_QUOTA_ATTEMPT_FILE_ENV} is required`);
  }
  return attemptFile;
}

function isDirWritable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(
    dir,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    writeFileSync(tempPath, content, { encoding: "utf8" });
    renameSync(tempPath, path);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Best effort cleanup of a same-directory staging file.
    }
    throw error;
  }
}

interface AtomicWritePlan {
  path: string;
  content: string;
  tempPath: string;
  previousContent?: string;
  existed: boolean;
  committed: boolean;
}

function atomicWriteFiles(writes: Array<{ path: string; content: string }>): void {
  const plans: AtomicWritePlan[] = writes.map(({ path, content }) => ({
    path,
    content,
    tempPath: tempPathFor(path),
    ...readPreviousFile(path),
    committed: false,
  }));

  try {
    for (const plan of plans) {
      mkdirSync(dirname(plan.path), { recursive: true });
      writeFileSync(plan.tempPath, plan.content, { encoding: "utf8" });
    }
    for (const plan of plans) {
      renameSync(plan.tempPath, plan.path);
      plan.committed = true;
    }
  } catch (error) {
    for (const plan of plans) {
      if (!plan.committed) {
        try {
          unlinkSync(plan.tempPath);
        } catch {
          // Best effort cleanup of same-directory staging files.
        }
      }
    }
    rollbackCommittedWrites(plans);
    throw error;
  }
}

function tempPathFor(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
}

function readPreviousFile(path: string): { existed: boolean; previousContent?: string } {
  if (!existsSync(path)) {
    return { existed: false };
  }
  return { existed: true, previousContent: readFileSync(path, "utf8") };
}

function rollbackCommittedWrites(plans: AtomicWritePlan[]): void {
  for (const plan of plans.slice().reverse()) {
    if (!plan.committed) {
      continue;
    }
    try {
      if (plan.existed) {
        writeFileSync(plan.path, plan.previousContent ?? "", { encoding: "utf8" });
      } else {
        unlinkSync(plan.path);
      }
    } catch {
      // Preserve the original write error; rollback is best effort.
    }
  }
}

function findHeaderSource(input: unknown, depth: number, seen: Set<object>): unknown | undefined {
  if (!input || depth > 4) {
    return undefined;
  }
  if (hasAnyKnownHeader(input)) {
    return input;
  }
  if (typeof input !== "object") {
    return undefined;
  }
  if (seen.has(input)) {
    return undefined;
  }
  seen.add(input);

  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findHeaderSource(item, depth + 1, seen);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  const record = input as Record<string, unknown>;
  const priorityKeys = [
    "headers",
    "responseHeaders",
    "response",
    "providerResponse",
    "httpResponse",
    "rawResponse",
    "res",
  ];
  for (const key of priorityKeys) {
    if (key in record) {
      const found = findHeaderSource(record[key], depth + 1, seen);
      if (found) {
        return found;
      }
    }
  }

  if (depth < 2) {
    for (const value of Object.values(record)) {
      const found = findHeaderSource(value, depth + 1, seen);
      if (found) {
        return found;
      }
    }
  }

  return undefined;
}

function hasAnyKnownHeader(headers: unknown): boolean {
  return headerNames(headers).some((name) => /^x-.+-(primary|secondary)-used-percent$/i.test(name)) ||
    getHeaderValue(headers, "x-codex-primary-used-percent") !== undefined ||
    getHeaderValue(headers, "x-codex-secondary-used-percent") !== undefined;
}

function getHeaderValue(headers: unknown, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (isHeaderGetter(headers)) {
    return normalizeHeaderValue(headers.get(name));
  }

  if (Array.isArray(headers)) {
    const lowerName = name.toLowerCase();
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) {
        continue;
      }
      const key = typeof entry[0] === "string" ? entry[0].toLowerCase() : "";
      if (key === lowerName) {
        return normalizeHeaderValue(entry[1]);
      }
    }
    return undefined;
  }

  if (typeof headers !== "object") {
    return undefined;
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === lowerName) {
      return normalizeHeaderValue(value);
    }
  }

  return undefined;
}

function isHeaderGetter(value: unknown): value is HeaderGetter {
  return Boolean(value) && typeof value === "object" && typeof (value as HeaderGetter).get === "function";
}

function normalizeHeaderValue(raw: unknown): string | undefined {
  if (Array.isArray(raw)) {
    for (const value of raw) {
      const normalized = normalizeHeaderValue(value);
      if (normalized !== undefined) {
        return normalized;
      }
    }
    return undefined;
  }
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? String(raw) : undefined;
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function setUsedPercent(window: CodexQuotaWindow, raw: string | number | undefined): void {
  const usedPercent = typeof raw === "number" ? nonNegativeNumber(raw) : parseNonNegativeNumber(raw);
  if (usedPercent === undefined) {
    return;
  }
  window.usedPercent = roundMetricValue(usedPercent);
  window.remainingPercent = roundMetricValue(Math.max(0, 100 - usedPercent));
}

function setResetAt(window: CodexQuotaWindow, raw: string | undefined): void {
  const resetTimestamp = parseTimestampSeconds(raw);
  if (resetTimestamp === undefined) {
    return;
  }
  if (!Number.isFinite(new Date(resetTimestamp * 1000).getTime())) return;
  window.resetTimestamp = resetTimestamp;
  window.resetAt = new Date(resetTimestamp * 1000).toISOString();
}

function parseNonNegativeNumber(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const normalized = raw.endsWith("%") ? raw.slice(0, -1).trim() : raw;
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return parsed;
}

function parseTimestampSeconds(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return undefined;
    }
    return Math.floor(numeric > 1_000_000_000_000 ? numeric / 1000 : numeric);
  }

  const millis = Date.parse(raw);
  if (!Number.isFinite(millis)) {
    return undefined;
  }
  return Math.floor(millis / 1000);
}

function normalizeHeaderText(raw: string | undefined): string | undefined {
  const trimmed = raw?.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.slice(0, 128);
}

function roundMetricValue(value: number): number {
  return Number(value.toFixed(3));
}

function pushGauge(lines: string[], name: string, help: string, value: number | undefined): void {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  if (value !== undefined && Number.isFinite(value)) {
    lines.push(`${name} ${formatPrometheusNumber(value)}`);
  }
}

function formatPrometheusNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(roundMetricValue(value));
}

function lowCardinalityLabel(raw: string | undefined): string {
  const normalized = raw
    ?.toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) {
    return "unknown";
  }
  return normalized.length <= 64 ? normalized : "other";
}

function prometheusLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
}
