import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { loadConfig } from "./config.js";
import { loadMergedCrons } from "./cron-loader.js";
import { KNOWLEDGE_V2_FORMAT, resolveKnowledgeLayout } from "./knowledge/layout.js";
import type { BotConfig } from "./types.js";
import {
  resolveAgentWorkspaceCwd,
  type ResolvedWorkspaceContract,
} from "./workspace-contract.js";

export type WorkspaceValidationSeverity = "error" | "warning";

export interface WorkspaceValidationIssue {
  severity: WorkspaceValidationSeverity;
  message: string;
}

export interface WorkspaceValidationResult {
  contract: ResolvedWorkspaceContract;
  config?: BotConfig;
  crons?: Array<Record<string, unknown>>;
  issues: WorkspaceValidationIssue[];
}

function issue(
  issues: WorkspaceValidationIssue[],
  severity: WorkspaceValidationSeverity,
  message: string,
): void {
  issues.push({ severity, message });
}

function safeStat(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function safeLstat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function existsAsDirectory(path: string): boolean {
  return safeStat(path)?.isDirectory() === true;
}

function existsAsFile(path: string): boolean {
  return safeStat(path)?.isFile() === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSchemaFormat(schemaPath: string): string | undefined {
  let markdown: string;
  try {
    markdown = readFileSync(schemaPath, "utf8");
  } catch {
    return undefined;
  }

  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!frontmatterMatch) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterMatch[1]);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }
  const format = parsed.format;
  if (typeof format === "string") {
    return format;
  }
  if (typeof format === "number" && Number.isFinite(format)) {
    return String(format);
  }
  return undefined;
}

function warnIfLegacyReferenceNamespace(
  issues: WorkspaceValidationIssue[],
  agentId: string,
  agentWorkspace: string,
): void {
  const referencePath = join(agentWorkspace, "reference");
  if (!existsSync(referencePath)) {
    return;
  }

  const linkNote = safeLstat(referencePath)?.isSymbolicLink() === true
    ? " The legacy reference/ path is a symlink; verify the target before renaming."
    : "";
  issue(
    issues,
    "warning",
    `agent "${agentId}" uses legacy reference/ artifacts namespace: ${referencePath}. ` +
      `artifacts/ is the target process-artifact namespace; reference/ is tolerated during compatibility, ` +
      `but rename it before private skill rewrites.${linkNote}`,
  );
}

function warnIfMissingAgentContext(
  issues: WorkspaceValidationIssue[],
  agentId: string,
  agentWorkspace: string,
): void {
  const claudePath = join(agentWorkspace, "CLAUDE.md");
  if (!existsAsFile(claudePath)) {
    issue(issues, "warning", `agent "${agentId}" context file is not present: ${claudePath}`);
  }

  const layout = resolveKnowledgeLayout(agentWorkspace);
  const schemaPath = layout.candidatePaths.v2.schemaPath;
  const indexPath = layout.candidatePaths.v2.indexPath;
  const hasWikiSchemaAndIndex = existsAsFile(schemaPath) && existsAsFile(indexPath);
  const schemaFormat = hasWikiSchemaAndIndex ? readSchemaFormat(schemaPath) : undefined;
  const hasPreMigrationWiki =
    hasWikiSchemaAndIndex && schemaFormat !== undefined && schemaFormat !== KNOWLEDGE_V2_FORMAT;

  if (hasPreMigrationWiki) {
    issue(
      issues,
      "warning",
      `agent "${agentId}" has a supported pre-migration wiki layout at ${join(agentWorkspace, "wiki")} ` +
        `with schema format "${schemaFormat}". It is not Knowledge v2 until migrated or marked ` +
        `${KNOWLEDGE_V2_FORMAT}.`,
    );
  }

  if (layout.kind === "none" && !hasPreMigrationWiki) {
    if (layout.reason === "v2-index-missing") {
      issue(
        issues,
        "warning",
        `agent "${agentId}" Knowledge v2 schema marker is present but wiki/index.md is missing: ${indexPath}`,
      );
    } else if (layout.reason === "schema-unreadable") {
      issue(
        issues,
        "warning",
        `agent "${agentId}" knowledge schema cannot be read: ${schemaPath}`,
      );
    } else {
      issue(
        issues,
        "warning",
        `agent "${agentId}" has no supported knowledge layout yet: add Knowledge v2 ` +
          `wiki/schema.md plus wiki/index.md, or keep legacy MEMORY.md during compatibility.`,
      );
    }
  }

  for (const relDir of [join(".claude", "rules", "platform"), join(".claude", "rules", "custom")] as const) {
    const path = join(agentWorkspace, relDir);
    if (!existsAsDirectory(path)) {
      issue(issues, "warning", `agent "${agentId}" rules dir is not present: ${path}`);
    }
  }

  warnIfLegacyReferenceNamespace(issues, agentId, agentWorkspace);
}

function describePathKind(path: string): string {
  if (!existsSync(path)) {
    return "does not exist";
  }
  const stat = safeStat(path);
  if (!stat) {
    return "cannot be accessed";
  }
  if (stat.isDirectory()) {
    return "is a directory";
  }
  if (stat.isFile()) {
    return "is a regular file";
  }
  return "is not a regular file";
}

export function workspaceValidationErrors(
  result: WorkspaceValidationResult,
): WorkspaceValidationIssue[] {
  return result.issues.filter((item) => item.severity === "error");
}

export function workspaceValidationWarnings(
  result: WorkspaceValidationResult,
): WorkspaceValidationIssue[] {
  return result.issues.filter((item) => item.severity === "warning");
}

export function validateWorkspaceContract(
  contract: ResolvedWorkspaceContract,
): WorkspaceValidationResult {
  const issues: WorkspaceValidationIssue[] = [];
  let config: BotConfig | undefined;
  let crons: Array<Record<string, unknown>> | undefined;

  if (!existsSync(contract.paths.workspaceRoot)) {
    issue(issues, "error", `control workspace root does not exist: ${contract.paths.workspaceRoot}`);
  } else if (!existsAsDirectory(contract.paths.workspaceRoot)) {
    issue(issues, "error", `control workspace root is not a directory: ${contract.paths.workspaceRoot}`);
  }

  if (!existsAsFile(contract.paths.configPath)) {
    issue(issues, "error", `config path ${describePathKind(contract.paths.configPath)}: ${contract.paths.configPath}`);
  } else {
    try {
      config = loadConfig(contract.paths.configPath, {
        resolveSecrets: false,
        workspaceRoot: contract.paths.workspaceRoot,
      });
    } catch (err) {
      issue(issues, "error", `config does not parse with secret resolution disabled: ${(err as Error).message}`);
    }
  }

  if (!existsSync(contract.paths.cronsPath)) {
    issue(issues, "warning", `crons file is not present: ${contract.paths.cronsPath}`);
  } else if (!existsAsFile(contract.paths.cronsPath)) {
    issue(issues, "error", `crons path ${describePathKind(contract.paths.cronsPath)}: ${contract.paths.cronsPath}`);
  } else {
    try {
      crons = loadMergedCrons(contract.paths.cronsPath);
    } catch (err) {
      issue(issues, "error", `crons file does not parse: ${(err as Error).message}`);
    }
  }

  if (config) {
    for (const [agentId, agent] of Object.entries(config.agents)) {
      const agentWorkspace = resolveAgentWorkspaceCwd(contract.paths.workspaceRoot, agent.workspaceCwd);
      if (!existsSync(agentWorkspace)) {
        issue(issues, "error", `agent "${agentId}" workspaceCwd does not exist: ${agentWorkspace}`);
      } else if (!existsAsDirectory(agentWorkspace)) {
        issue(issues, "error", `agent "${agentId}" workspaceCwd is not a directory: ${agentWorkspace}`);
      } else {
        warnIfMissingAgentContext(issues, agentId, agentWorkspace);
      }
    }
  }

  if (!existsSync(contract.paths.piExtensionDir)) {
    issue(issues, "error", `Pi extension dir does not exist: ${contract.paths.piExtensionDir}`);
  } else if (!existsAsDirectory(contract.paths.piExtensionDir)) {
    issue(issues, "error", `Pi extension dir is not a directory: ${contract.paths.piExtensionDir}`);
  }

  for (const warning of contract.warnings) {
    issue(issues, "warning", warning);
  }

  return { contract, config, crons, issues };
}
