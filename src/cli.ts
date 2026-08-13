#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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
  executeKnowledgeMaintenance,
  formatKnowledgeMaintenanceResponse,
  type KnowledgeMaintenanceResponse,
} from "./knowledge/maintenance.js";
import {
  executeKnowledgeSync,
  formatKnowledgeSyncResponse,
  type KnowledgeSyncResponse,
} from "./knowledge/sync.js";
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
import {
  runOpsWorkerCliCommand,
  type OpsWorkerCliDependencies,
} from "./ops-worker/worker-cli.js";

type WriteFn = (text: string) => void;

export interface CliRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdout?: WriteFn;
  stderr?: WriteFn;
  launchdCommandRunner?: LaunchdCommandRunner;
  launchdHomeDir?: string;
  launchdUid?: number;
  workerDependencies?: OpsWorkerCliDependencies;
}

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
  minime-bot knowledge update --workspace <agent-workspace> --op create|update|upsert --type <type> --slug <slug> --frontmatter <json> --body-file <file> [--json]
  minime-bot knowledge update --workspace <agent-workspace> --op archive|restore --path <wiki/pages/type/page.md> [--json]
  minime-bot knowledge sync --workspace <agent-workspace> [--json]
  minime-bot knowledge maintain --workspace <agent-workspace> [--closed-issues <json-array>] [--json] [--report <workspace-json-path>]
  minime-bot knowledge migrate --workspace <agent-workspace> --dry-run [--report <path>]
  minime-bot knowledge migrate --workspace <agent-workspace> --apply [--allow-dirty] [--report <path>]
  minime-bot launchd crons sync --workspace <path> [--dry-run] [--no-prune] [--launch-agents-dir <path>] [--run-cron-script <absolute-path>]
  minime-bot worker start --state-dir <path> --agent-workspace <path> [--host 127.0.0.1] [--port 9465] [--control-config <path>] [--once]
  minime-bot worker status|list --state-dir <path> [--json]
  minime-bot worker inspect --state-dir <path> --id <task-id> [--json]
  minime-bot worker submit --state-dir <path> --template <registered> --authorization <registered> --done-check <registered> --correlation-key <key> --delivery-key <adapter-delivery-key> --resource-key <normalized-resource-key> --objective <text> [--done-check-params <json>] [--json]
  minime-bot worker checkpoint --state-dir <path> --id <task-id> --checkpoint-id <id> --summary <text> --payload <json> [--artifact <relative-path>] [--lifecycle <json>] [--json]
  minime-bot worker receipt-query --state-dir <path> --id <task-id> --boundary <fixed-boundary> --operation-id <id> --intent <json> --query-observed-at <timestamp> --query-result <json> [--json]
  minime-bot worker receipt-claim --state-dir <path> --id <task-id> --boundary <fixed-boundary> --operation-id <id> --intent <json> [--json]
  minime-bot worker receipt-finish --state-dir <path> --id <task-id> --boundary <fixed-boundary> --operation-id <id> --intent <json> --result <APPLIED|ALREADY_APPLIED|NOT_NEEDED> --evidence <json> [--lifecycle <json>] [--json]
  minime-bot worker retry --state-dir <path> --id <task-id> [--json]
  minime-bot worker cancel --state-dir <path> --id <task-id> --reason <text> [--json]

Options:
  --workspace <path>         Control/app workspace root for config/workspace commands. Agent workspace root for knowledge commands.
  --run-cron-script <path>  Preserve an explicit executable run-cron.sh path during launchd cron sync.
  -h, --help                 Show this help text.

Config/workspace defaults: ${MINIME_CONTROL_WORKSPACE_ROOT_ENV}, then source repo root or package cwd.
Knowledge defaults: explicit --workspace, then ${MINIME_AGENT_WORKSPACE_ROOT_ENV}. Knowledge commands do not resolve config secrets.
Ops worker: inactive unless worker start is invoked. --control-config enables the dedicated second-token Telegram poller/reporter and, when configured, authenticated Alertmanager intake only for that started worker. CLI submission uses trusted registries; checkpoint and receipt commands record evidence only, and the loopback HTTP surface otherwise remains health/status only.
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
  "closed-issues",
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
  runCronScript?: string;
}

function parseLaunchdCronSyncOptions(args: readonly string[]): LaunchdCronSyncCliOptions {
  let dryRun = false;
  let prune = true;
  let launchAgentsDir: string | undefined;
  let runCronScript: string | undefined;

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
    if (rawArg === "--run-cron-script") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new CliUsageError("--run-cron-script requires a path");
      }
      if (runCronScript !== undefined) {
        throw new CliUsageError("--run-cron-script may only be specified once");
      }
      runCronScript = value;
      i += 1;
      continue;
    }
    if (rawArg.startsWith("--run-cron-script=")) {
      const value = rawArg.slice("--run-cron-script=".length);
      if (!value) {
        throw new CliUsageError("--run-cron-script requires a path");
      }
      if (runCronScript !== undefined) {
        throw new CliUsageError("--run-cron-script may only be specified once");
      }
      runCronScript = value;
      continue;
    }

    const equalsIndex = rawArg.indexOf("=");
    const optionName = equalsIndex >= 0 ? rawArg.slice(0, equalsIndex) : rawArg;
    throw new CliUsageError(`unknown launchd option: ${optionName}`);
  }

  return { dryRun, prune, launchAgentsDir, runCronScript };
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

function rejectUnexpectedKnowledgeOptions(
  options: KnowledgeCommandOptions,
  allowedValues: ReadonlySet<string>,
  allowedFlags: ReadonlySet<string>,
  command: string,
): void {
  for (const name of options.values.keys()) {
    if (!allowedValues.has(name)) {
      throw new CliUsageError(`knowledge ${command} does not accept --${name}`);
    }
  }
  for (const name of options.flags) {
    if (!allowedFlags.has(name)) {
      throw new CliUsageError(`knowledge ${command} does not accept --${name}`);
    }
  }
}

function knowledgeFailureExitCode(
  response:
    | KnowledgeSearchResponse
    | KnowledgeGetResponse
    | KnowledgeUpdateResponse
    | KnowledgeMigrationResponse
    | KnowledgeMaintenanceResponse
    | KnowledgeSyncResponse,
): number {
  if (response.ok) {
    return 0;
  }
  return response.status === "rejected" ? 2 : 1;
}

function writeKnowledgeFailure(
  response:
    | KnowledgeSearchResponse
    | KnowledgeGetResponse
    | KnowledgeUpdateResponse
    | KnowledgeMigrationResponse
    | KnowledgeMaintenanceResponse
    | KnowledgeSyncResponse,
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
  const operation = requiredKnowledgeValue(commandOptions, "op").toLowerCase();
  let updateArgs;
  if (operation === "archive" || operation === "restore") {
    rejectUnexpectedKnowledgeOptions(
      commandOptions,
      new Set(["op", "path"]),
      new Set(["json"]),
      "update --op archive|restore",
    );
    updateArgs = {
      op: operation,
      path: requiredKnowledgeValue(commandOptions, "path"),
    };
  } else {
    if (operation !== "create" && operation !== "update" && operation !== "upsert") {
      throw new CliUsageError(
        "knowledge update --op must be create, update, upsert, archive, or restore",
      );
    }
    rejectUnexpectedKnowledgeOptions(
      commandOptions,
      new Set(["op", "type", "slug", "path", "frontmatter", "body-file"]),
      new Set(["json"]),
      "update --op create|update|upsert",
    );
    const bodyFile = requiredKnowledgeValue(commandOptions, "body-file");
    const bodyPath = resolveCliPath(bodyFile, cwdForCli(options));
    updateArgs = {
      op: operation,
      type: requiredKnowledgeValue(commandOptions, "type"),
      slug: commandOptions.values.get("slug"),
      path: commandOptions.values.get("path"),
      frontmatter: parseFrontmatterJson(requiredKnowledgeValue(commandOptions, "frontmatter")),
      body: readFileSync(bodyPath, "utf8"),
    };
  }
  const response = executeKnowledgeUpdate(
    updateArgs,
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

function runKnowledgeMaintain(
  parsed: ParsedArgs,
  args: readonly string[],
  options: CliRunOptions,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  const commandOptions = parseKnowledgeCommandOptions(args);
  rejectUnexpectedKnowledgeOptions(
    commandOptions,
    new Set(["closed-issues", "report"]),
    new Set(["json"]),
    "maintain",
  );
  const json = commandOptions.flags.has("json");
  const agentWorkspaceRoot = resolveKnowledgeAgentWorkspace(parsed, options);
  const closedIssuesJson = commandOptions.values.get("closed-issues");
  const response = executeKnowledgeMaintenance(
    {
      reportPath: commandOptions.values.get("report"),
    },
    {
      agentWorkspaceRoot,
      env: options.env ?? process.env,
      loadClosedIssueNumbers: closedIssuesJson === undefined
        ? undefined
        : () => {
            try {
              return JSON.parse(closedIssuesJson);
            } catch {
              throw new Error("--closed-issues must be a valid JSON array");
            }
          },
    },
  );

  if (!response.ok) {
    return writeKnowledgeFailure(response, json, stdout, stderr);
  }
  if (json) {
    writeLine(stdout, formatKnowledgeMaintenanceResponse(response));
  } else if (
    response.stopReason !== "below-high-watermark" ||
    response.reportPath
  ) {
    writeLine(
      stdout,
      `Knowledge maintenance: ${response.stopReason}; ${response.bytesBefore} -> ${response.bytesAfter} bytes; archived ${response.archivedCount}.`,
    );
    if (response.reportPath) {
      writeLine(stdout, `Report: ${response.reportPath}`);
    }
  }
  return response.stopReason === "unsafe-failure" ? 1 : 0;
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

function runKnowledgeSync(
  parsed: ParsedArgs,
  args: readonly string[],
  options: CliRunOptions,
  stdout: WriteFn,
  stderr: WriteFn,
): number {
  const commandOptions = parseKnowledgeCommandOptions(args);
  rejectUnexpectedKnowledgeOptions(
    commandOptions,
    new Set(),
    new Set(["json"]),
    "sync",
  );
  const json = commandOptions.flags.has("json");
  const agentWorkspaceRoot = resolveKnowledgeAgentWorkspace(parsed, options);
  const response = executeKnowledgeSync({
    agentWorkspaceRoot,
    env: options.env ?? process.env,
  });

  if (!response.ok) {
    return writeKnowledgeFailure(response, json, stdout, stderr);
  }
  if (json) {
    writeLine(stdout, formatKnowledgeSyncResponse(response));
  } else {
    writeLine(
      stdout,
      `Knowledge sync converged main with origin/main at ${response.commit} ` +
        `(${response.classification}, ${response.attempts} ${response.attempts === 1 ? "attempt" : "attempts"}).`,
    );
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
  if (action === "maintain") {
    return runKnowledgeMaintain(parsed, args, options, stdout, stderr);
  }
  if (action === "migrate") {
    return runKnowledgeMigrate(parsed, args, options, stdout, stderr);
  }
  if (action === "sync") {
    return runKnowledgeSync(parsed, args, options, stdout, stderr);
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
    const command = ["launchd", action, action === "crons" ? args[0] : undefined]
      .filter((token): token is string => Boolean(token))
      .map((token) => token.startsWith("--") ? token.split("=", 1)[0] : token)
      .join(" ");
    throw new CliUsageError(`unknown launchd command: ${command}`);
  }

  const commandOptions = parseLaunchdCronSyncOptions(args.slice(1));
  const result = syncLaunchdCrons({
    workspace: parsed.workspace,
    dryRun: commandOptions.dryRun,
    prune: commandOptions.prune,
    launchAgentsDir: commandOptions.launchAgentsDir,
    runCronScript: commandOptions.runCronScript,
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    homeDir: options.launchdHomeDir,
    uid: options.launchdUid,
    commandRunner: options.launchdCommandRunner,
  });
  stdout(formatLaunchdCronSyncResult(result));
  return 0;
}

function formatEffectivePaths(contract: ResolvedWorkspaceContract): string[] {
  const diagnostics = contract.effectivePaths;
  return [
    `  control workspace root: ${diagnostics.controlWorkspaceRoot.path} (${diagnostics.controlWorkspaceRoot.source})`,
    `  config path: ${diagnostics.configPath.path} (${diagnostics.configPath.source})`,
    diagnostics.instanceConfigPath
      ? `  instance config path: ${diagnostics.instanceConfigPath.path} (${diagnostics.instanceConfigPath.source})`
      : "  instance config path: not configured",
    `  crons path: ${diagnostics.cronsPath.path} (${diagnostics.cronsPath.source})`,
    `  package root: ${diagnostics.packageRoot.path} (${diagnostics.packageRoot.source})`,
    `  Pi extension dir: ${diagnostics.piExtensionDir.path} (${diagnostics.piExtensionDir.source})`,
    `  data dir: ${diagnostics.dataDir.path} (${diagnostics.dataDir.source})`,
    `  session store path: ${diagnostics.sessionStorePath.path} (${diagnostics.sessionStorePath.source})`,
    `  log dir: ${diagnostics.logDir.path} (${diagnostics.logDir.source})`,
    `  media base dir: ${diagnostics.mediaBaseDir.path} (${diagnostics.mediaBaseDir.source})`,
    `  echo dir: ${diagnostics.echoDir.path} (${diagnostics.echoDir.source})`,
    `  runtime dir: ${diagnostics.runtimeDir.path} (${diagnostics.runtimeDir.source})`,
  ];
}

function runConfigValidate(contract: ResolvedWorkspaceContract, stdout: WriteFn): void {
  const config = loadConfig(contract.paths.configPath, {
    resolveSecrets: false,
    workspaceRoot: contract.paths.workspaceRoot,
    instanceConfigPath: contract.paths.instanceConfigPath,
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
    if (scope === "worker") {
      throw new CliUsageError(
        "worker commands require the asynchronous CLI entrypoint",
      );
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

export async function runCliAsync(
  argv: readonly string[] = process.argv.slice(2),
  options: CliRunOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    writeLine(stderr, `Error: ${(error as Error).message}`);
    return 2;
  }
  if (parsed.help || parsed.command[0] !== "worker") {
    return runCli(argv, options);
  }
  if (parsed.workspace !== undefined) {
    writeLine(
      stderr,
      "Error: worker commands do not accept --workspace; use --agent-workspace for worker start",
    );
    return 2;
  }
  const [, action, ...rest] = parsed.command;
  return runOpsWorkerCliCommand(action, rest, {
    cwd: cwdForCli(options),
    stdout,
    stderr,
    dependencies: options.workerDependencies,
  });
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
  void runCliAsync().then((code) => {
    process.exitCode = code;
  }).catch((error: unknown) => {
    process.stderr.write(`Error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
