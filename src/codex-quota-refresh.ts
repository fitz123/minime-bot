import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { CodexQuotaReadError, readCodexQuota, type CodexQuotaReaderOptions } from "./codex-quota-reader.js";
import { resolveCodexQuotaPaths, writeCodexQuotaSnapshot } from "./pi-extensions/codex-usage.js";
import { parseQuotaSnapshot, readQuotaStatus, resolveQuotaStateFile, type QuotaStatus, type QuotaStatusOptions } from "./quota-status.js";

export interface RefreshQuotaOptions extends QuotaStatusOptions, CodexQuotaReaderOptions {
  textfileDir?: string;
}
export interface QuotaRefreshResult {
  status: QuotaStatus;
  success: boolean;
  failureReason?: string;
}
const inFlight = new Map<string, Promise<QuotaRefreshResult>>();

/** One acquisition per cache/metrics target, shared by sampler and status callers. */
export function refreshCodexQuota(options: RefreshQuotaOptions = {}): Promise<QuotaRefreshResult> {
  const stateFile = resolveQuotaStateFile(options);
  const paths = resolveCodexQuotaPaths({ ...options, stateFile });
  const key = JSON.stringify([stateFile, paths.textfileDir]);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const pending = refresh({ ...options, ...paths }).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

async function refresh(options: RefreshQuotaOptions & { stateFile: string }): Promise<QuotaRefreshResult> {
  const attemptedAt = options.now ?? new Date();
  const attempt = { lastAttempt: attemptedAt.toISOString(), lastAttemptTimestamp: Math.floor(attemptedAt.getTime() / 1000) };
  let success = false;
  let failureReason: string | undefined;
  try {
    const snapshot = await readCodexQuota(options);
    writeCodexQuotaSnapshot({ ...snapshot, ...attempt, probeSuccess: true }, options);
    success = true;
  } catch (error) {
    failureReason = error instanceof CodexQuotaReadError ? error.code : "cache_write_failed";
  }
  if (options.textfileDir) {
    try {
      atomicWriteQuotaFile(join(options.textfileDir, "codex_usage_probe.prom"), formatCodexQuotaProbePrometheus({ attemptedAt, probeSuccess: success }), 0o644);
    } catch {
      success = false;
      failureReason ??= "attempt_metrics_write_failed";
    }
  }
  if (!success) {
    try {
      const prior = existsSync(options.stateFile)
        ? parseQuotaSnapshot(JSON.parse(readFileSync(options.stateFile, "utf8")))
        : { provider: "codex", families: [] };
      atomicWriteQuotaFile(options.stateFile, JSON.stringify({ ...prior, ...attempt, probeSuccess: false }, null, 2) + "\n", 0o600);
    } catch { /* Preserve unreadable state; return an explicit failed refresh regardless. */ }
  }
  return { success, failureReason, status: { ...readQuotaStatus(options), refreshFailed: !success } };
}

export async function refreshQuotaStatus(options: RefreshQuotaOptions = {}): Promise<QuotaStatus> {
  return (await refreshCodexQuota(options)).status;
}

export function formatCodexQuotaProbePrometheus(attempt: { attemptedAt: Date; probeSuccess: boolean }): string {
  return [
    "# HELP codex_usage_last_attempt_timestamp Unix timestamp of the last Codex quota read attempt.",
    "# TYPE codex_usage_last_attempt_timestamp gauge",
    `codex_usage_last_attempt_timestamp ${Math.floor(attempt.attemptedAt.getTime() / 1000)}`,
    "# HELP codex_usage_probe_success Whether the last Codex quota read refreshed the cache.",
    "# TYPE codex_usage_probe_success gauge",
    `codex_usage_probe_success ${attempt.probeSuccess ? 1 : 0}`, "",
  ].join("\n");
}

function atomicWriteQuotaFile(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(temporary, content, { encoding: "utf8", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch { /* Already renamed or write failed. */ }
  }
}
