#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import {
  executeKnowledgeGet,
  executeKnowledgeSearch,
  formatKnowledgeToolResponse,
  type KnowledgeGetResponse,
  type KnowledgeSearchResponse,
} from "./knowledge/tools.js";
import {
  executeKnowledgeMigration,
  formatKnowledgeMigrationResponse,
  type KnowledgeMigrationResponse,
} from "./knowledge/migration.js";
import {
  executeKnowledgeUpdate,
  formatKnowledgeUpdateResponse,
  type KnowledgeUpdateResponse,
} from "./knowledge/update.js";
import {
  validateWorkspaceContract,
  workspaceValidationErrors,
  workspaceValidationWarnings,
  type WorkspaceValidationResult,
} from "./workspace-validator.js";
import {
  MINIME_AGENT_WORKSPACE_ROOT_ENV,
  MINIME_CONTROL_WORKSPACE_ROOT_ENV,
  resolveWorkspaceContract,
  type ResolvedWorkspaceContract,
} from "./workspace-contract.js";
import {
  formatLaunchdCronSyncResult,
  syncLaunchdCrons,
  type LaunchdCommandRunner,
} from "./launchd-cron-plists.js";

type WriteFn = (text: string) => void;

export interface CliRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: WriteFn;
  stderr?: WriteFn;
  launchdCommandRunner?: LaunchdCommandRunner;
  launchdHomeDir?: string;
  launchdUid?: number;
  recoveryCommandRunner?: RecoveryCommandRunner;
}

export interface RecoveryCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export type RecoveryCommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => RecoveryCommandResult;

interface ParsedArgs {
  command: string[];
  help: boolean;
  workspace?: string;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

class WorkspaceValidationError extends Error {
  constructor() {
    super("Workspace validation failed.");
    this.name = "WorkspaceValidationError";
  }
}

const HELP_TEXT = `Usage:
  minime-bot --help
  minime-bot config validate --workspace <path>
  minime-bot workspace validate --workspace <path>
  minime-bot knowledge search --workspace <agent-workspace> --query <q> [--scope auto|diary|all] [--json]
  minime-bot knowledge get --workspace <agent-workspace> --path <relpath> [--from N] [--lines N]
  minime-bot knowledge update --workspace <agent-workspace> --op upsert --type project --slug <slug> --frontmatter <json> --body-file <file> [--json]
  minime-bot knowledge migrate --workspace <agent-workspace> --dry-run [--report <path>]
  minime-bot knowledge migrate --workspace <agent-workspace> --apply [--allow-dirty] [--report <path>]
  minime-bot launchd crons sync --workspace <path> [--dry-run] [--no-prune] [--launch-agents-dir <path>]
  minime-bot recovery config validate --workspace <control-workspace> [--config <path>]
  minime-bot recovery status|incidents|invocations --workspace <control-workspace>
  minime-bot recovery dispatch enable|disable --actor <actor> --reason <reason> [--ttl <seconds>]
  minime-bot recovery controls confirmation-count|cooldown|retry-budget <value> --actor <actor> --reason <reason> [--ttl <seconds>]
  minime-bot recovery silence <incident-key> --ttl <seconds> --actor <actor> --reason <reason>
  minime-bot recovery retry <incident-id> --actor <actor> --reason <reason>
  minime-bot recovery policy history|rollback [revision] [--limit N] [--actor <actor> --reason <reason>]
  minime-bot recovery approve|reject <invocation-id> --actor <actor> --reason <reason>
  minime-bot recovery digest preview [--window <seconds>]
  minime-bot recovery process --once

Options:
  --workspace <path>  Control/app workspace root for config/workspace commands. Agent workspace root for knowledge commands.
  -h, --help          Show this help text.

Config/workspace defaults: ${MINIME_CONTROL_WORKSPACE_ROOT_ENV}, then source repo root or package cwd.
Knowledge defaults: explicit --workspace, then ${MINIME_AGENT_WORKSPACE_ROOT_ENV}. Knowledge commands do not resolve config secrets.
Recovery defaults: <control-workspace>/recovery.json. Recovery commands accept only bounded named operations, never SQL or shell.
`;

function writeLine(write: WriteFn, text = ""): void {
  write(`${text}\n`);
}

function writeJson(write: WriteFn, value: unknown): void {
  writeLine(write, JSON.stringify(value, null, 2));
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let help = false;
  let workspace: string | undefined;
  const command: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (arg === "--workspace") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new CliUsageError("--workspace requires a path");
      }
      workspace = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--workspace=")) {
      const value = arg.slice("--workspace=".length).trim();
      if (!value) {
        throw new CliUsageError("--workspace requires a path");
      }
      workspace = value;
      continue;
    }
    command.push(arg);
  }

  return { command, help, workspace };
}

function resolveForCli(parsed: ParsedArgs, options: CliRunOptions): ResolvedWorkspaceContract {
  return resolveWorkspaceContract({
    workspace: parsed.workspace,
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
  });
}

function cwdForCli(options: CliRunOptions): string {
  return resolve(options.cwd ?? process.cwd());
}

function resolveCliPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function resolveKnowledgeAgentWorkspace(parsed: ParsedArgs, options: CliRunOptions): string | undefined {
  const cwd = cwdForCli(options);
  if (parsed.workspace?.trim()) {
    return resolveCliPath(parsed.workspace, cwd);
  }
  const env = options.env ?? process.env;
  const envWorkspace = env[MINIME_AGENT_WORKSPACE_ROOT_ENV]?.trim();
  return envWorkspace ? resolveCliPath(envWorkspace, cwd) : undefined;
}

interface KnowledgeCommandOptions {
  values: Map<string, string>;
  flags: Set<string>;
}

const KNOWLEDGE_VALUE_OPTIONS = new Set([
  "query",
  "scope",
  "max-results",
  "path",
  "from",
  "lines",
  "op",
  "type",
  "slug",
  "frontmatter",
  "body-file",
  "report",
]);

const KNOWLEDGE_BOOL_OPTIONS = new Set([
  "json",
  "dry-run",
  "apply",
  "allow-dirty",
]);

function parseKnowledgeCommandOptions(args: readonly string[]): KnowledgeCommandOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < args.length; i += 1) {
    const rawArg = args[i];
    if (!rawArg.startsWith("--")) {
      throw new CliUsageError(`unexpected argument: ${rawArg}`);
    }

    const equalsIndex = rawArg.indexOf("=");
    const name = rawArg.slice(2, equalsIndex >= 0 ? equalsIndex : undefined);
    if (!name) {
      throw new CliUsageError(`unexpected argument: ${rawArg}`);
    }

    if (KNOWLEDGE_BOOL_OPTIONS.has(name)) {
      if (equalsIndex >= 0) {
        throw new CliUsageError(`--${name} does not accept a value`);
      }
      flags.add(name);
      continue;
    }

    if (!KNOWLEDGE_VALUE_OPTIONS.has(name)) {
      throw new CliUsageError(`unknown knowledge option: --${name}`);
    }

    let value: string | undefined;
    if (equalsIndex >= 0) {
      value = rawArg.slice(equalsIndex + 1);
    } else {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        throw new CliUsageError(`--${name} requires a value`);
      }
      value = next;
      i += 1;
    }
    values.set(name, value);
  }

  return { values, flags };
}

function requiredKnowledgeValue(options: KnowledgeCommandOptions, name: string): string {
  const value = options.values.get(name)?.trim();
  if (!value) {
    throw new CliUsageError(`knowledge command requires --${name}`);
  }
  return value;
}

function parsePositiveIntegerOption(
  options: KnowledgeCommandOptions,
  name: string,
): number | undefined {
  const raw = options.values.get(name);
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new CliUsageError(`--${name} must be a positive integer`);
  }
  return value;
}

interface LaunchdCronSyncCliOptions {
  dryRun: boolean;
  prune: boolean;
  launchAgentsDir?: string;
}

function parseLaunchdCronSyncOptions(args: readonly string[]): LaunchdCronSyncCliOptions {
  let dryRun = false;
  let prune = true;
  let launchAgentsDir: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const rawArg = args[i];
    if (!rawArg.startsWith("--")) {
      throw new CliUsageError(`unexpected argument: ${rawArg}`);
    }

    if (rawArg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (rawArg === "--no-prune") {
      prune = false;
      continue;
    }
    if (rawArg === "--launch-agents-dir") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        throw new CliUsageError("--launch-agents-dir requires a path");
      }
      launchAgentsDir = value;
      i += 1;
      continue;
    }
    if (rawArg.startsWith("--launch-agents-dir=")) {
      const value = rawArg.slice("--launch-agents-dir=".length).trim();
      if (!value) {
        throw new CliUsageError("--launch-agents-dir requires a path");
      }
      launchAgentsDir = value;
      continue;
    }

    throw new CliUsageError(`unknown launchd option: ${rawArg}`);
  }

  return { dryRun, prune, launchAgentsDir };
}

function parseFrontmatterJson(raw: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliUsageError("--frontmatter must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError("--frontmatter must be a JSON object");
  }
  return parsed;
}

function knowledgeFailureExitCode(
  response: KnowledgeSearchResponse | KnowledgeGetResponse | KnowledgeUpdateResponse | KnowledgeMigrationResponse,
): number {
  if (response.ok) {
    return 0;
  }
  return response.status === "rejected" ? 2 : 1;
}

function writeKnowledgeFailure(
  response: KnowledgeSearchResponse | KnowledgeGetResponse | KnowledgeUpdateResponse | KnowledgeMigrationResponse,
  json: boolean,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  if (response.ok) {
    return 0;
  }
  if (json) {
    writeJson(stdout, response);
  } else {
    writeLine(stderr, `Error: ${response.message}`);
  }
  return knowledgeFailureExitCode(response);
}

function runKnowledgeSearch(
  parsed: ParsedArgs,
  args: readonly string[],
  options: CliRunOptions,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  const commandOptions = parseKnowledgeCommandOptions(args);
  const json = commandOptions.flags.has("json");
  const agentWorkspaceRoot = resolveKnowledgeAgentWorkspace(parsed, options);
  const response = executeKnowledgeSearch(
    {
      query: commandOptions.values.get("query"),
      scope: commandOptions.values.get("scope"),
      maxResults: parsePositiveIntegerOption(commandOptions, "max-results"),
    },
    { agentWorkspaceRoot, env: options.env ?? process.env },
  );

  if (!response.ok) {
    return writeKnowledgeFailure(response, json, stdout, stderr);
  }
  if (json) {
    writeLine(stdout, formatKnowledgeToolResponse(response));
  } else if (response.results.length === 0) {
    writeLine(stdout, "No results.");
  } else {
    for (const result of response.results) {
      writeLine(stdout, `${result.rank}. ${result.path}:${result.startLine}-${result.endLine} ${result.title}`);
      writeLine(stdout, `   ${result.snippet}`);
    }
  }
  return 0;
}

function runKnowledgeGet(
  parsed: ParsedArgs,
  args: readonly string[],
  options: CliRunOptions,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  const commandOptions = parseKnowledgeCommandOptions(args);
  const json = commandOptions.flags.has("json");
  const from = parsePositiveIntegerOption(commandOptions, "from");
  const lineCount = parsePositiveIntegerOption(commandOptions, "lines");
  const agentWorkspaceRoot = resolveKnowledgeAgentWorkspace(parsed, options);
  const response = executeKnowledgeGet(
    {
      path: commandOptions.values.get("path"),
      startLine: from,
      endLine: from !== undefined && lineCount !== undefined ? from + lineCount - 1 : undefined,
    },
    { agentWorkspaceRoot, env: options.env ?? process.env },
  );

  if (!response.ok) {
    return writeKnowledgeFailure(response, json, stdout, stderr);
  }
  if (json) {
    writeLine(stdout, formatKnowledgeToolResponse(response));
  } else if (response.content.endsWith("\n")) {
    stdout(response.content);
  } else {
    writeLine(stdout, response.content);
  }
  return 0;
}

function runKnowledgeUpdate(
  parsed: ParsedArgs,
  args: readonly string[],
  options: CliRunOptions,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  const commandOptions = parseKnowledgeCommandOptions(args);
  const json = commandOptions.flags.has("json");
  const agentWorkspaceRoot = resolveKnowledgeAgentWorkspace(parsed, options);
  const bodyFile = requiredKnowledgeValue(commandOptions, "body-file");
  const bodyPath = resolveCliPath(bodyFile, cwdForCli(options));
  const response = executeKnowledgeUpdate(
    {
      op: requiredKnowledgeValue(commandOptions, "op"),
      type: requiredKnowledgeValue(commandOptions, "type"),
      slug: commandOptions.values.get("slug"),
      path: commandOptions.values.get("path"),
      frontmatter: parseFrontmatterJson(requiredKnowledgeValue(commandOptions, "frontmatter")),
      body: readFileSync(bodyPath, "utf8"),
    },
    { agentWorkspaceRoot, env: options.env ?? process.env },
  );

  if (!response.ok) {
    return writeKnowledgeFailure(response, json, stdout, stderr);
  }
  if (json) {
    writeLine(stdout, formatKnowledgeUpdateResponse(response));
  } else {
    writeLine(stdout, `${response.action} ${response.path}`);
  }
  return 0;
}

function runKnowledgeMigrate(
  parsed: ParsedArgs,
  args: readonly string[],
  options: CliRunOptions,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  const commandOptions = parseKnowledgeCommandOptions(args);
  const json = commandOptions.flags.has("json");
  const dryRun = commandOptions.flags.has("dry-run");
  const apply = commandOptions.flags.has("apply");
  if (dryRun && apply) {
    throw new CliUsageError("knowledge migrate accepts --dry-run or --apply, not both");
  }
  const agentWorkspaceRoot = resolveKnowledgeAgentWorkspace(parsed, options);
  const reportPath = commandOptions.values.get("report");
  const response = executeKnowledgeMigration(
    {
      dryRun: dryRun ? true : undefined,
      apply,
      allowDirty: commandOptions.flags.has("allow-dirty"),
      reportPath: reportPath ? resolveCliPath(reportPath, cwdForCli(options)) : undefined,
    },
    { agentWorkspaceRoot, env: options.env ?? process.env },
  );

  if (!response.ok) {
    return writeKnowledgeFailure(response, json, stdout, stderr);
  }
  if (json) {
    writeLine(stdout, formatKnowledgeMigrationResponse(response));
  } else {
    writeLine(stdout, response.humanSummary);
    if (response.reportPath) {
      writeLine(stdout, `Report: ${response.reportPath}`);
    }
  }
  return 0;
}

function runKnowledgeCommand(
  action: string | undefined,
  args: readonly string[],
  parsed: ParsedArgs,
  options: CliRunOptions,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  if (action === "search") {
    return runKnowledgeSearch(parsed, args, options, stdout, stderr);
  }
  if (action === "get") {
    return runKnowledgeGet(parsed, args, options, stdout, stderr);
  }
  if (action === "update") {
    return runKnowledgeUpdate(parsed, args, options, stdout, stderr);
  }
  if (action === "migrate") {
    return runKnowledgeMigrate(parsed, args, options, stdout, stderr);
  }
  throw new CliUsageError(`unknown knowledge command: ${action ?? ""}`.trimEnd());
}

function runLaunchdCommand(
  action: string | undefined,
  args: readonly string[],
  parsed: ParsedArgs,
  options: CliRunOptions,
  stdout: WriteFn,
): number {
  if (action !== "crons" || args[0] !== "sync") {
    throw new CliUsageError(`unknown launchd command: ${["launchd", action, ...args].filter(Boolean).join(" ")}`);
  }

  const commandOptions = parseLaunchdCronSyncOptions(args.slice(1));
  const result = syncLaunchdCrons({
    workspace: parsed.workspace,
    dryRun: commandOptions.dryRun,
    prune: commandOptions.prune,
    launchAgentsDir: commandOptions.launchAgentsDir,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    homeDir: options.launchdHomeDir,
    uid: options.launchdUid,
    commandRunner: options.launchdCommandRunner,
  });
  stdout(formatLaunchdCronSyncResult(result));
  return 0;
}

function recoveryScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "recovery_cli.py");
}

function arrangeRecoveryArgs(args: readonly string[]): { configArgs: string[]; commandArgs: string[] } {
  const configArgs: string[] = [];
  const commandArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new CliUsageError("--config requires a path");
      }
      configArgs.push("--config", value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length).trim();
      if (!value) {
        throw new CliUsageError("--config requires a path");
      }
      configArgs.push("--config", value);
      continue;
    }
    commandArgs.push(arg);
  }
  return { configArgs, commandArgs };
}

function runRecoveryCommand(
  action: string | undefined,
  args: readonly string[],
  parsed: ParsedArgs,
  options: CliRunOptions,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  if (!action) {
    throw new CliUsageError("recovery command is required");
  }
  const contract = resolveForCli(parsed, options);
  const arranged = arrangeRecoveryArgs([action, ...args]);
  const python = options.env?.PYTHON?.trim() || process.env.PYTHON?.trim() || "/usr/bin/python3";
  const runner: RecoveryCommandRunner = options.recoveryCommandRunner ?? ((command, commandArgs, runOptions) => {
    const result = spawnSync(command, commandArgs, {
      cwd: runOptions.cwd,
      env: runOptions.env,
      encoding: "utf8",
      timeout: 30_000,
      shell: false,
    });
    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error,
    };
  });
  const cwd = cwdForCli(options);
  const result = runner(
    python,
    [
      recoveryScriptPath(),
      "--workspace",
      contract.paths.workspaceRoot,
      ...arranged.configArgs,
      ...arranged.commandArgs,
    ],
    { cwd, env: options.env ?? process.env },
  );
  if (result.stdout) {
    stdout(result.stdout);
  }
  if (result.stderr) {
    stderr(result.stderr);
  }
  if (result.error) {
    throw new Error("recovery command failed to start");
  }
  return result.status ?? 1;
}

function formatEffectivePaths(contract: ResolvedWorkspaceContract): string[] {
  const diagnostics = contract.effectivePaths;
  return [
    `  control workspace root: ${diagnostics.controlWorkspaceRoot.path} (${diagnostics.controlWorkspaceRoot.source})`,
    `  config path: ${diagnostics.configPath.path} (${diagnostics.configPath.source})`,
    `  crons path: ${diagnostics.cronsPath.path} (${diagnostics.cronsPath.source})`,
    `  package root: ${diagnostics.packageRoot.path} (${diagnostics.packageRoot.source})`,
    `  Pi extension dir: ${diagnostics.piExtensionDir.path} (${diagnostics.piExtensionDir.source})`,
    `  data dir: ${diagnostics.dataDir.path} (${diagnostics.dataDir.source})`,
    `  session store path: ${diagnostics.sessionStorePath.path} (${diagnostics.sessionStorePath.source})`,
    `  log dir: ${diagnostics.logDir.path} (${diagnostics.logDir.source})`,
    `  media base dir: ${diagnostics.mediaBaseDir.path} (${diagnostics.mediaBaseDir.source})`,
    `  runtime dir: ${diagnostics.runtimeDir.path} (${diagnostics.runtimeDir.source})`,
  ];
}

function runConfigValidate(contract: ResolvedWorkspaceContract, stdout: WriteFn): void {
  const config = loadConfig(contract.paths.configPath, {
    resolveSecrets: false,
    workspaceRoot: contract.paths.workspaceRoot,
  });
  writeLine(stdout, "Config valid.");
  writeLine(stdout, `Config path: ${contract.paths.configPath}`);
  writeLine(stdout, `Agents: ${Object.keys(config.agents).join(", ")}`);
  writeLine(stdout, `Telegram bindings: ${config.bindings.length}`);
  if (config.discord) {
    writeLine(stdout, `Discord bindings: ${config.discord.bindings.length}`);
  }
}

function writeWorkspaceValidationReport(
  result: WorkspaceValidationResult,
  stdout: WriteFn,
): void {
  const errors = workspaceValidationErrors(result);
  const warnings = workspaceValidationWarnings(result);
  writeLine(stdout, errors.length === 0 ? "Workspace valid." : "Workspace invalid.");
  writeLine(stdout, "Effective paths:");
  for (const line of formatEffectivePaths(result.contract)) {
    writeLine(stdout, line);
  }
  if (result.config) {
    writeLine(stdout, `Agents: ${Object.keys(result.config.agents).join(", ")}`);
    writeLine(stdout, "Agent workspaces:");
    for (const [agentId, agent] of Object.entries(result.config.agents)) {
      writeLine(stdout, `  ${agentId}: ${agent.workspaceCwd}`);
    }
  }
  writeLine(stdout, `Crons: ${result.crons === undefined ? "not present" : result.crons.length}`);
  if (errors.length > 0) {
    writeLine(stdout, "Hard failures:");
    for (const error of errors) {
      writeLine(stdout, `  - ${error.message}`);
    }
  }
  if (warnings.length > 0) {
    writeLine(stdout, "Warnings:");
    for (const warning of warnings) {
      writeLine(stdout, `  - ${warning.message}`);
    }
  }
}

function runWorkspaceValidate(
  contract: ResolvedWorkspaceContract,
  stdout: WriteFn,
): void {
  const result = validateWorkspaceContract(contract);
  writeWorkspaceValidationReport(result, stdout);
  if (workspaceValidationErrors(result).length > 0) {
    throw new WorkspaceValidationError();
  }
}

export function runCli(argv: readonly string[] = process.argv.slice(2), options: CliRunOptions = {}): number {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));

  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    writeLine(stderr, `Error: ${(err as Error).message}`);
    return 2;
  }

  if (parsed.help || parsed.command.length === 0) {
    writeLine(stdout, HELP_TEXT.trimEnd());
    return 0;
  }

  const [scope, action, ...rest] = parsed.command;

  try {
    if (scope === "knowledge") {
      return runKnowledgeCommand(action, rest, parsed, options, stdout, stderr);
    }
    if (scope === "launchd") {
      return runLaunchdCommand(action, rest, parsed, options, stdout);
    }
    if (scope === "recovery") {
      return runRecoveryCommand(action, rest, parsed, options, stdout, stderr);
    }

    if (rest.length > 0) {
      throw new CliUsageError(`unexpected argument: ${rest[0]}`);
    }

    const contract = resolveForCli(parsed, options);
    if (scope === "config" && action === "validate") {
      runConfigValidate(contract, stdout);
      return 0;
    }
    if (scope === "workspace" && action === "validate") {
      runWorkspaceValidate(contract, stdout);
      return 0;
    }
  } catch (err) {
    if (err instanceof CliUsageError) {
      writeLine(stderr, `Error: ${err.message}`);
      return 2;
    }
    writeLine(stderr, `Error: ${(err as Error).message}`);
    return 1;
  }

  writeLine(stderr, `Error: unknown command: ${parsed.command.join(" ")}`);
  return 2;
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function isDirectCliEntrypoint(
  moduleUrl = import.meta.url,
  entrypoint = process.argv[1],
): boolean {
  return entrypoint !== undefined
    && realpathOrResolve(entrypoint) === realpathOrResolve(fileURLToPath(moduleUrl));
}

if (isDirectCliEntrypoint()) {
  process.exitCode = runCli();
}
