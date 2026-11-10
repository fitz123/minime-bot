#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCodexQuotaPaths } from "./pi-extensions/codex-usage.js";
import { resolveQuotaStateFile } from "./quota-status.js";
import { refreshCodexQuota } from "./codex-quota-refresh.js";
import type { CodexQuotaReaderOptions } from "./codex-quota-reader.js";
export { formatCodexQuotaProbePrometheus } from "./codex-quota-refresh.js";

export const CODEX_QUOTA_TIMEOUT_MS_ENV = "CODEX_QUOTA_TIMEOUT_MS";
export const CODEX_QUOTA_DRY_RUN_ENV = "CODEX_QUOTA_DRY_RUN";
export const CODEX_QUOTA_PROBE_TEXTFILE_NAME = "codex_usage_probe.prom";

export interface CodexQuotaSamplerCliOptions {
  workspace?: string;
  model?: string;
  textfileDir?: string;
  stateFile?: string;
  samplerCwd?: string;
  timeoutMs?: number;
  dryRun?: boolean;
  piBin?: string;
  prompt?: string;
  help?: boolean;
}
export interface CodexQuotaSamplerConfig {
  stateFile: string;
  textfileDir: string;
  timeoutMs: number;
  dryRun: boolean;
}
export interface ResolveCodexQuotaSamplerConfigOptions {
  cli?: CodexQuotaSamplerCliOptions;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  isWritableDir?: (path: string) => boolean;
}
export interface RunCodexQuotaSamplerOptions extends ResolveCodexQuotaSamplerConfigOptions, CodexQuotaReaderOptions {
  config?: CodexQuotaSamplerConfig;
}

export function parseCodexQuotaSamplerArgs(argv: readonly string[]): CodexQuotaSamplerCliOptions {
  const parsed: CodexQuotaSamplerCliOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        parsed.help = true;
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--model":
        parsed.model = readFlagValue(argv, ++i, arg);
        break;
      case "--workspace":
        parsed.workspace = readFlagValue(argv, ++i, arg);
        break;
      case "--textfile-dir":
        parsed.textfileDir = readFlagValue(argv, ++i, arg);
        break;
      case "--state-file":
        parsed.stateFile = readFlagValue(argv, ++i, arg);
        break;
      case "--sampler-cwd":
        parsed.samplerCwd = readFlagValue(argv, ++i, arg);
        break;
      case "--timeout":
      case "--timeout-ms":
        parsed.timeoutMs = parsePositiveInteger(readFlagValue(argv, ++i, arg), arg);
        break;
      case "--pi-bin":
        parsed.piBin = readFlagValue(argv, ++i, arg);
        break;
      case "--prompt":
        parsed.prompt = readFlagValue(argv, ++i, arg);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

export function resolveCodexQuotaSamplerConfig(options: ResolveCodexQuotaSamplerConfigOptions = {}): CodexQuotaSamplerConfig {
  const cli = options.cli ?? {};
  const env = options.env ?? process.env;
  const stateFile = resolveQuotaStateFile({ ...options, stateFile: cli.stateFile, workspace: cli.workspace });
  const paths = resolveCodexQuotaPaths({ ...options, stateFile, textfileDir: cli.textfileDir });
  if (!paths.textfileDir) throw new Error("Codex quota sampler requires a configured or writable Prometheus textfile directory");
  return {
    stateFile, textfileDir: paths.textfileDir,
    timeoutMs: cli.timeoutMs ?? parseOptionalPositiveInteger(env[CODEX_QUOTA_TIMEOUT_MS_ENV], CODEX_QUOTA_TIMEOUT_MS_ENV) ?? 20_000,
    dryRun: cli.dryRun ?? parseBooleanEnv(env[CODEX_QUOTA_DRY_RUN_ENV]) ?? false,
  };
}

export async function runCodexQuotaSampler(options: RunCodexQuotaSamplerOptions = {}) {
  const config = options.config ?? resolveCodexQuotaSamplerConfig(options);
  if (config.dryRun) return { status: "dry_run" as const, config };
  const result = await refreshCodexQuota({ ...options, ...config });
  return { status: result.success ? "success" as const : "failure" as const, config, failureReason: result.failureReason };
}

export async function runCodexQuotaSamplerFromCli(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const cli = parseCodexQuotaSamplerArgs(argv);
  if (cli.help) { console.log(formatCodexQuotaSamplerHelp()); return; }
  const result = await runCodexQuotaSampler({ cli });
  if (result.status === "dry_run") { console.log(JSON.stringify({ method: "GET", ...result.config }, null, 2)); return; }
  if (result.status === "success") { console.log("[codex-quota-sampler] quota read succeeded"); return; }
  console.error(`[codex-quota-sampler] quota read failed: ${result.failureReason}`);
  process.exitCode = 1;
}

export function formatCodexQuotaSamplerHelp(): string {
  return [
    "Usage: minime-codex-quota-sampler [options]",
    "Reads subscription quota with Pi OAuth using GET /wham/usage; sends no inference.",
    "  --workspace <path>       Control/app workspace root",
    "  --textfile-dir <dir>     Prometheus textfile directory",
    "  --state-file <file>      Codex quota JSON state file",
    "  --timeout, --timeout-ms <ms>  Whole-read deadline (default 20000)",
    "  --dry-run                Print configuration without resolving auth or requesting quota",
    "  --model, --prompt, --pi-bin, --sampler-cwd <value>  Ignored compatibility options",
    "  --help, -h               Show this help",
    "Environment: CODEX_QUOTA_STATE_FILE, CODEX_QUOTA_TEXTFILE_DIR, NODE_EXPORTER_TEXTFILE_DIR,",
    "CODEX_QUOTA_TIMEOUT_MS, CODEX_QUOTA_DRY_RUN. Former inference settings are ignored.",
  ].join("\n");
}

function readFlagValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseOptionalPositiveInteger(raw: string | undefined, label: string): number | undefined {
  const trimmed = nonEmpty(raw);
  if (!trimmed) {
    return undefined;
  }
  return parsePositiveInteger(trimmed, label);
}

function parsePositiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseBooleanEnv(raw: string | undefined): boolean | undefined {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(trimmed)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(trimmed)) {
    return false;
  }
  throw new Error(`${CODEX_QUOTA_DRY_RUN_ENV} must be boolean-like`);
}

function nonEmpty(raw: string | undefined): string | undefined { return raw?.trim() || undefined; }

export function isDirectCodexQuotaSamplerEntrypoint(
  moduleUrl = import.meta.url,
  entrypoint = process.argv[1],
): boolean {
  return entrypoint !== undefined
    && realpathOrResolve(entrypoint) === realpathOrResolve(fileURLToPath(moduleUrl));
}

if (isDirectCodexQuotaSamplerEntrypoint()) {
  runCodexQuotaSamplerFromCli().catch(() => {
    console.error("[codex-quota-sampler] configuration or local state error");
    process.exitCode = 1;
  });
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}
