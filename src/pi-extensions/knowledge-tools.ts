import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { executeKnowledgeGet, executeKnowledgeSearch, formatKnowledgeToolResponse } from "../knowledge/tools.js";
import { resolveKnowledgeLayout, type ResolvedKnowledgeLayout } from "../knowledge/layout.js";
import { executeKnowledgeUpdate, formatKnowledgeUpdateResponse } from "../knowledge/update.js";
import { MINIME_AGENT_WORKSPACE_CWD_ENV } from "../workspace-contract.js";

export const KNOWLEDGE_SEARCH_TOOL = {
  name: "knowledge_search",
  label: "Knowledge Search",
  description:
    "Search curated workspace knowledge. Scope auto/default searches the durable index and pages; diary searches " +
    "chronological narrative notes; all combines both. Results include sourceKind and authority because durable " +
    "knowledge can still be stale and diary entries are history, not current truth.",
  promptSnippet: "Search workspace knowledge before answering from prior decisions, preferences, projects, or history.",
  promptGuidelines: [
    "Use knowledge_search before answering about prior work, decisions, people, preferences, projects, health, dates, or what happened with something.",
    "Use default scope for curated durable facts, diary/all for chronology, and knowledge_get for exact source lines before important assertions.",
  ] as string[],
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Case-insensitive search query." },
      scope: {
        type: "string",
        enum: ["auto", "default", "diary", "all"],
        description: "auto/default search curated knowledge; diary searches narrative history; all searches both.",
      },
      maxResults: { type: "number", description: "Maximum result count, clamped by the package helper." },
    },
    required: ["query"],
  },
} as const;

export const KNOWLEDGE_GET_TOOL = {
  name: "knowledge_get",
  label: "Knowledge Get",
  description:
    "Read exact Markdown line ranges from the resolved knowledge corpus. Paths must be relative corpus Markdown " +
    "paths from knowledge_search results; traversal, absolute paths, non-corpus files, and non-Markdown files are rejected.",
  promptSnippet: "Read exact knowledge source lines for important claims.",
  promptGuidelines: [
    "Use knowledge_get on knowledge_search result paths before making important claims from workspace knowledge.",
  ] as string[],
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative Markdown path inside the resolved knowledge corpus." },
      startLine: { type: "number", description: "1-based starting line. Defaults to the first line." },
      endLine: { type: "number", description: "1-based ending line. Defaults to the final line." },
    },
    required: ["path"],
  },
} as const;

export const KNOWLEDGE_UPDATE_TOOL = {
  name: "knowledge_update",
  label: "Knowledge Update",
  description:
    "Create, update, or upsert durable Knowledge v2 Markdown pages through the package-owned write path. This is " +
    "not arbitrary file editing: it validates flat frontmatter, writes under wiki/pages/<type> only, refreshes " +
    "wiki/index.md mechanically, and records structural creates in wiki/log.md. Direct manual writes to managed " +
    "wiki paths are blocked when first-party extensions are enabled.",
  promptSnippet: "Write durable Knowledge v2 pages through knowledge_update, never by editing managed wiki files directly.",
  promptGuidelines: [
    "Use knowledge_update for durable Knowledge v2 writes; do not directly write wiki/schema.md, wiki/index.md, wiki/log.md, wiki/issues.md, or wiki/pages/**.",
    "knowledge_update is for synthesized durable knowledge, not arbitrary file editing or active task state.",
  ] as string[],
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["create", "update", "upsert"], description: "Write operation." },
      type: { type: "string", enum: ["user", "project", "feedback", "reference"], description: "Knowledge page type." },
      slug: { type: "string", description: "Safe relative slug under wiki/pages/<type>, without or with .md." },
      path: { type: "string", description: "Alternative relative path under wiki/pages/<type>/**/*.md." },
      frontmatter: {
        type: "object",
        description: "Flat frontmatter with required name, description, and type fields.",
      },
      body: { type: "string", description: "Markdown body without frontmatter." },
    },
    required: ["op", "type", "frontmatter", "body"],
  },
} as const;

export interface PiKnowledgeToolDeps {
  agentWorkspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  resolveLayout?: (agentWorkspaceRoot: string) => ResolvedKnowledgeLayout;
}

export interface KnowledgeToolCallLike {
  toolName: string;
  input?: Record<string, unknown>;
}

export interface KnowledgeIntegrityDecision {
  block: true;
  reason: string;
  targetPath: string;
}

interface ShellToken {
  value: string;
}

interface UnwrappedCommand {
  command: string[];
  cwd?: string;
}

const MANAGED_EXACT_RELPATHS = [
  "wiki/schema.md",
  "wiki/index.md",
  "wiki/log.md",
  "wiki/issues.md",
] as const;

const AGENT_WORKSPACE_ENV_FALLBACK_WARNING =
  `${MINIME_AGENT_WORKSPACE_CWD_ENV} was not provided; falling back to process cwd for this Pi knowledge call.`;

const KNOWLEDGE_TOOL_NAMES = new Set(["knowledge_search", "knowledge_get", "knowledge_update"]);
const MUTATING_TOOL_NAMES = new Set(["write", "edit", "bash"]);
const WRAPPER_COMMANDS = new Set(["command", "builtin", "nohup", "time"]);
const NESTED_SHELL_COMMANDS = new Set(["sh", "bash", "zsh"]);
const READ_ONLY_SHELL_COMMANDS = new Set([
  "[",
  "basename",
  "cat",
  "cut",
  "dirname",
  "egrep",
  "false",
  "fgrep",
  "file",
  "grep",
  "head",
  "jq",
  "less",
  "ls",
  "more",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "stat",
  "tail",
  "test",
  "tr",
  "true",
  "uniq",
  "wc",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "for-each-ref",
  "grep",
  "log",
  "ls-files",
  "rev-parse",
  "show",
  "show-ref",
  "status",
]);
const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-D",
  "-g",
  "-h",
  "-p",
  "-T",
  "-u",
  "--chdir",
  "--close-from",
  "--group",
  "--host",
  "--prompt",
  "--user",
]);
const ENV_OPTIONS_WITH_VALUE = new Set(["-C", "-S", "-u", "--chdir", "--split-string", "--unset"]);
const SHELL_OPTIONS_WITH_VALUE = new Set(["-o", "--init-file", "--rcfile"]);
const MAX_NESTED_SHELL_DEPTH = 4;
const MANAGED_KNOWLEDGE_PATH_REFERENCE =
  /(?:^|[^A-Za-z0-9_-])((?:wiki\/(?:schema|index|log|issues)\.md|wiki\/pages(?:\/[A-Za-z0-9._~+@%=-]+)*))(?![A-Za-z0-9_/-])/g;

function explicitAgentWorkspaceRoot(deps: PiKnowledgeToolDeps): string | undefined {
  const root = deps.agentWorkspaceRoot;
  return typeof root === "string" && root.trim() ? root : undefined;
}

function envAgentWorkspaceRoot(deps: PiKnowledgeToolDeps): string | undefined {
  const env = deps.env ?? process.env;
  const root = env[MINIME_AGENT_WORKSPACE_CWD_ENV];
  return typeof root === "string" && root.trim() ? root : undefined;
}

function usesCwdFallback(deps: PiKnowledgeToolDeps): boolean {
  return !explicitAgentWorkspaceRoot(deps) && !envAgentWorkspaceRoot(deps);
}

function withFallbackWarning<T extends object>(response: T, deps: PiKnowledgeToolDeps): T {
  if (!usesCwdFallback(deps)) {
    return response;
  }
  return { ...response, warning: AGENT_WORKSPACE_ENV_FALLBACK_WARNING };
}

export function resolvePiKnowledgeAgentWorkspaceRoot(deps: PiKnowledgeToolDeps = {}): string {
  const root =
    explicitAgentWorkspaceRoot(deps) ??
    envAgentWorkspaceRoot(deps) ??
    deps.cwd ??
    process.cwd();
  return normalize(resolve(root));
}

function toolDeps(deps: PiKnowledgeToolDeps = {}) {
  return {
    agentWorkspaceRoot: resolvePiKnowledgeAgentWorkspaceRoot(deps),
    env: deps.env,
    resolveLayout: deps.resolveLayout,
  };
}

export function executePiKnowledgeSearch(params: Record<string, unknown> = {}, deps: PiKnowledgeToolDeps = {}): {
  ok: boolean;
  text: string;
} {
  const response = withFallbackWarning(executeKnowledgeSearch(params, toolDeps(deps)), deps);
  return { ok: response.ok, text: formatKnowledgeToolResponse(response) };
}

export function executePiKnowledgeGet(params: Record<string, unknown> = {}, deps: PiKnowledgeToolDeps = {}): {
  ok: boolean;
  text: string;
} {
  const response = withFallbackWarning(executeKnowledgeGet(params, toolDeps(deps)), deps);
  return { ok: response.ok, text: formatKnowledgeToolResponse(response) };
}

export function executePiKnowledgeUpdate(params: Record<string, unknown> = {}, deps: PiKnowledgeToolDeps = {}): {
  ok: boolean;
  text: string;
} {
  const response = withFallbackWarning(executeKnowledgeUpdate(params, toolDeps(deps)), deps);
  return { ok: response.ok, text: formatKnowledgeUpdateResponse(response) };
}

export function classifyKnowledgeIntegrityToolCall(
  event: KnowledgeToolCallLike,
  deps: PiKnowledgeToolDeps = {},
): KnowledgeIntegrityDecision | undefined {
  if (KNOWLEDGE_TOOL_NAMES.has(event.toolName) || !MUTATING_TOOL_NAMES.has(event.toolName)) {
    return undefined;
  }

  const agentWorkspaceRoot = resolvePiKnowledgeAgentWorkspaceRoot(deps);
  const layout = (deps.resolveLayout ?? resolveKnowledgeLayout)(agentWorkspaceRoot);
  if (layout.kind !== "v2") {
    return undefined;
  }

  const cwd = normalize(resolve(deps.cwd ?? process.cwd()));
  const mutatingTargets = event.toolName === "bash"
    ? extractBashWriteTargetsForCwd(stringField(event.input, "command") ?? "", cwd, deps.env)
    : extractMutatingTargets(event);
  for (const rawTarget of mutatingTargets) {
    const ambiguousManagedPath = ambiguousManagedKnowledgeRelPath(layout, rawTarget, cwd, deps.env);
    if (ambiguousManagedPath) {
      return {
        block: true,
        targetPath: ambiguousManagedPath,
        reason:
          `Knowledge v2 managed wiki paths are writable only through knowledge_update. ` +
          `Blocked direct ${event.toolName} target: ${ambiguousManagedPath}.`,
      };
    }
    const absTarget = resolveShellPath(rawTarget, cwd, deps.env);
    if (!absTarget) {
      const managedRawPath = unresolvedManagedKnowledgeRelPath(rawTarget);
      if (managedRawPath) {
        return {
          block: true,
          targetPath: managedRawPath,
          reason:
            `Knowledge v2 managed wiki paths are writable only through knowledge_update. ` +
            `Blocked direct ${event.toolName} target: ${managedRawPath}.`,
        };
      }
      continue;
    }
    const managedPath = managedKnowledgeRelPath(layout, absTarget);
    if (managedPath) {
      return {
        block: true,
        targetPath: managedPath,
        reason:
          `Knowledge v2 managed wiki paths are writable only through knowledge_update. ` +
          `Blocked direct ${event.toolName} target: ${managedPath}.`,
      };
    }
  }

  return undefined;
}

function stringField(input: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!input) {
    return undefined;
  }
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function extractMutatingTargets(event: KnowledgeToolCallLike): string[] {
  if (event.toolName === "write" || event.toolName === "edit") {
    const path = stringField(event.input, "path", "file_path");
    return path ? [path] : [];
  }

  if (event.toolName === "bash") {
    const command = stringField(event.input, "command");
    return command ? extractBashWriteTargets(command) : [];
  }

  return [];
}

export function extractBashWriteTargets(command: string): string[] {
  return extractBashWriteTargetsAtDepth(command, 0);
}

function extractBashWriteTargetsForCwd(command: string, cwd: string, env?: NodeJS.ProcessEnv): string[] {
  return extractBashWriteTargetsAtDepth(command, 0, cwd, env);
}

function extractBashWriteTargetsAtDepth(command: string, depth: number, cwd?: string, env?: NodeJS.ProcessEnv): string[] {
  if (depth > MAX_NESTED_SHELL_DEPTH) {
    return extractManagedKnowledgePathReferences(command);
  }
  const tokens = expandAttachedRedirections(tokenizeShell(command).map((token) => token.value));
  const targets: string[] = [];
  let currentCwd = cwd;

  for (const segment of splitShellSegments(tokens)) {
    appendTargetCandidates(targets, extractCommandWriteTargets(segment, depth, currentCwd, env), currentCwd, env);
    currentCwd = cwdAfterSegment(segment, currentCwd, env);
  }

  return targets;
}

function appendTarget(targets: string[], target: string): void {
  if (!targets.includes(target)) {
    targets.push(target);
  }
}

function appendTargetCandidates(
  targets: string[],
  rawTargets: string[],
  cwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): void {
  for (const rawTarget of rawTargets) {
    appendTarget(targets, rawTarget);
    if (!cwd) {
      continue;
    }
    const resolved = resolveShellPath(rawTarget, cwd, env);
    if (resolved) {
      appendTarget(targets, resolved);
    }
  }
}

function targetCandidates(rawTargets: string[], cwd: string | undefined, env: NodeJS.ProcessEnv | undefined): string[] {
  const targets: string[] = [];
  appendTargetCandidates(targets, rawTargets, cwd, env);
  return targets;
}

function extractManagedKnowledgePathReferences(command: string): string[] {
  const refs: string[] = [];
  for (const match of command.matchAll(MANAGED_KNOWLEDGE_PATH_REFERENCE)) {
    if (match[1]) {
      refs.push(match[1]);
    }
  }
  return refs;
}

function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let value = "";
  let quote: "'" | "\"" | undefined;

  const push = (): void => {
    if (value.length > 0) {
      tokens.push({ value });
      value = "";
    }
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (quote === "'") {
      if (char === "'") {
        quote = undefined;
      } else {
        value += char;
      }
      continue;
    }

    if (quote === "\"") {
      if (char === "\"") {
        quote = undefined;
      } else if (char === "\\" && index + 1 < command.length) {
        index += 1;
        value += command[index];
      } else {
        value += char;
      }
      continue;
    }

    if (char === "'") {
      quote = "'";
      continue;
    }
    if (char === "\"") {
      quote = "\"";
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      index += 1;
      value += command[index];
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (char === "#" && value.length === 0) {
      break;
    }
    if (char === "&" && command[index + 1] === ">") {
      push();
      const isAppend = command[index + 2] === ">";
      tokens.push({ value: isAppend ? "&>>" : "&>" });
      index += isAppend ? 2 : 1;
      continue;
    }
    if ((char === "&" && command[index + 1] === "&") || (char === "|" && command[index + 1] === "|")) {
      push();
      tokens.push({ value: `${char}${char}` });
      index += 1;
      continue;
    }
    if (char === ";" || char === "|") {
      push();
      tokens.push({ value: char });
      continue;
    }
    if (char === ">" || char === "<") {
      push();
      let op = char;
      if (command[index + 1] === char) {
        op += char;
        index += 1;
      } else if (char === ">" && command[index + 1] === "|") {
        op += "|";
        index += 1;
      }
      tokens.push({ value: op });
      continue;
    }

    value += char;
  }

  push();
  return tokens;
}

function expandAttachedRedirections(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const token of tokens) {
    const attached = /^(\d+|&)?(>>?|>\||&>>?)(.+)$/.exec(token);
    if (attached) {
      expanded.push(`${attached[1] ?? ""}${attached[2]}`, attached[3]);
      continue;
    }
    expanded.push(token);
  }
  return expanded;
}

function isWriteRedirection(token: string): boolean {
  return /^(?:\d+|&)?(?:>|>>|>\||&>|&>>)$/.test(token);
}

function isPathLikeShellTarget(value: string | undefined): value is string {
  if (!value || value === "-" || /^&\d+$/.test(value)) {
    return false;
  }
  return true;
}

function splitShellSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];

  for (const token of tokens) {
    if (token === ";" || token === "|" || token === "&&" || token === "||") {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(token);
  }

  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

function redirectionTargets(segment: string[]): string[] {
  const targets: string[] = [];
  for (let index = 0; index < segment.length; index += 1) {
    const token = segment[index];
    if (isWriteRedirection(token)) {
      const target = segment[index + 1];
      if (isPathLikeShellTarget(target)) {
        targets.push(target);
      }
    }
  }
  return targets;
}

function extractCommandWriteTargets(
  segment: string[],
  depth: number,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): string[] {
  const targets = redirectionTargets(segment);
  const { command, cwd: commandCwd } = unwrapCommandWithCwd(segment, cwd, env);
  if (command.length === 0) {
    return targetCandidates(targets, commandCwd, env);
  }

  const name = basename(command[0]);
  const args = command.slice(1);
  if (NESTED_SHELL_COMMANDS.has(name)) {
    const nestedCommand = nestedShellCommand(args);
    const nestedTargets = nestedCommand
      ? [...targets, ...extractBashWriteTargetsAtDepth(nestedCommand, depth + 1, commandCwd, env)]
      : targets;
    return targetCandidates(nestedTargets, commandCwd, env);
  }
  if (name === "tee") {
    return targetCandidates([...targets, ...commandOperands(args)], commandCwd, env);
  }
  if (name === "dd") {
    return targetCandidates([...targets, ...ddWriteTargets(args)], commandCwd, env);
  }
  if (name === "cp" || name === "install") {
    return targetCandidates([...targets, ...copyLikeTargets(args)], commandCwd, env);
  }
  if (name === "mv") {
    return targetCandidates([...targets, ...commandOperands(args)], commandCwd, env);
  }
  if (name === "rm" || name === "unlink" || name === "touch" || name === "truncate" || name === "mkdir") {
    return targetCandidates([...targets, ...commandOperands(args)], commandCwd, env);
  }
  if ((name === "sed" || name === "perl") && hasInPlaceEditFlag(args)) {
    return targetCandidates(
      [...targets, ...commandOperands(args).slice(1), ...extractManagedKnowledgePathReferences(command.join(" "))],
      commandCwd,
      env,
    );
  }
  if (name === "find" && args.includes("-delete")) {
    return targetCandidates([...targets, ...commandOperands(args)], commandCwd, env);
  }

  if (isReadOnlyShellCommand(name, args)) {
    return targetCandidates(targets, commandCwd, env);
  }
  return targetCandidates([...targets, ...extractManagedKnowledgePathReferences(command.join(" "))], commandCwd, env);
}

function nestedShellCommand(args: string[]): string | undefined {
  let endOfOptions = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg === "-c") {
      return args[index + 1];
    }
    if (!endOfOptions && arg.startsWith("--")) {
      if (SHELL_OPTIONS_WITH_VALUE.has(arg)) {
        index += 1;
      }
      continue;
    }
    if (!endOfOptions && /^-[^-]*c/.test(arg)) {
      return args[index + 1];
    }
    if (!endOfOptions && arg.startsWith("-")) {
      if (SHELL_OPTIONS_WITH_VALUE.has(arg)) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return undefined;
}

function isReadOnlyShellCommand(name: string, args: string[]): boolean {
  if (name === "find" && (args.includes("-delete") || args.includes("-exec") || args.includes("-execdir"))) {
    return false;
  }
  if (name === "git") {
    return isReadOnlyGitCommand(args);
  }
  return READ_ONLY_SHELL_COMMANDS.has(name);
}

function isReadOnlyGitCommand(args: string[]): boolean {
  const subcommand = gitSubcommand(args);
  return subcommand ? READ_ONLY_GIT_SUBCOMMANDS.has(subcommand) : false;
}

function gitSubcommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      return undefined;
    }
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
      index += 1;
      continue;
    }
    if (
      arg.startsWith("--git-dir=") ||
      arg.startsWith("--work-tree=") ||
      arg.startsWith("--namespace=")
    ) {
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return undefined;
}

function cwdOptionValue(option: string, args: string[], index: number): { value?: string; nextIndex: number } {
  if (option.startsWith("--chdir=")) {
    return { value: option.slice("--chdir=".length), nextIndex: index + 1 };
  }
  if (option === "-C" || option === "-D" || option === "--chdir") {
    return { value: args[index + 1], nextIndex: index + 2 };
  }
  return { nextIndex: index + 1 };
}

function resolveCwdOption(value: string | undefined, cwd: string | undefined, env: NodeJS.ProcessEnv | undefined): string | undefined {
  if (!value || !cwd) {
    return cwd;
  }
  return resolveShellPath(value, cwd, env) ?? cwd;
}

function unwrapCommandWithCwd(segment: string[], cwd?: string, env?: NodeJS.ProcessEnv): UnwrappedCommand {
  let index = 0;
  let effectiveCwd = cwd;
  while (index < segment.length) {
    const name = basename(segment[index]);
    if (name === "sudo") {
      index += 1;
      while (index < segment.length && segment[index].startsWith("-")) {
        const option = segment[index];
        const cwdOption = cwdOptionValue(option, segment, index);
        if (cwdOption.value !== undefined && (option === "-D" || option === "--chdir" || option.startsWith("--chdir="))) {
          effectiveCwd = resolveCwdOption(cwdOption.value, effectiveCwd, env);
          index = cwdOption.nextIndex;
          continue;
        }
        index += 1;
        if (SUDO_OPTIONS_WITH_VALUE.has(option) && index < segment.length) {
          index += 1;
        }
      }
      continue;
    }
    if (name === "env") {
      index += 1;
      while (index < segment.length) {
        const token = segment[index];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
          index += 1;
          continue;
        }
        if (token.startsWith("-")) {
          const cwdOption = cwdOptionValue(token, segment, index);
          if (cwdOption.value !== undefined && (token === "-C" || token === "--chdir" || token.startsWith("--chdir="))) {
            effectiveCwd = resolveCwdOption(cwdOption.value, effectiveCwd, env);
            index = cwdOption.nextIndex;
            continue;
          }
          index += 1;
          if (ENV_OPTIONS_WITH_VALUE.has(token) && index < segment.length) {
            index += 1;
          }
          continue;
        }
        break;
      }
      continue;
    }
    if (WRAPPER_COMMANDS.has(name)) {
      index += 1;
      while (name === "time" && index < segment.length && segment[index].startsWith("-")) {
        index += 1;
      }
      continue;
    }
    break;
  }
  return { command: segment.slice(index), cwd: effectiveCwd };
}

function cwdAfterSegment(segment: string[], cwd: string | undefined, env: NodeJS.ProcessEnv | undefined): string | undefined {
  if (!cwd) {
    return cwd;
  }
  const { command, cwd: commandCwd } = unwrapCommandWithCwd(segment, cwd, env);
  if (command.length === 0) {
    return cwd;
  }
  const name = basename(command[0]);
  if (name !== "cd" && name !== "pushd") {
    return cwd;
  }
  const target = cwdTargetOperand(command.slice(1)) ?? env?.HOME ?? homedir();
  return resolveShellPath(target, commandCwd ?? cwd, env) ?? cwd;
}

function cwdTargetOperand(args: string[]): string | undefined {
  let endOfOptions = false;
  for (const arg of args) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) {
      continue;
    }
    return arg;
  }
  return undefined;
}

function commandOperands(args: string[]): string[] {
  const operands: string[] = [];
  let endOfOptions = false;
  for (const arg of args) {
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith("-")) {
      continue;
    }
    if (isPathLikeShellTarget(arg) && !isWriteRedirection(arg)) {
      operands.push(arg);
    }
  }
  return operands;
}

function copyLikeTargets(args: string[]): string[] {
  const targetDir = optionValue(args, "-t") ?? optionValue(args, "--target-directory");
  if (targetDir) {
    return [targetDir];
  }
  const operands = commandOperands(args);
  return operands.length > 0 ? [operands[operands.length - 1]] : [];
}

function ddWriteTargets(args: string[]): string[] {
  const targets: string[] = [];
  for (const arg of args) {
    const match = /^of=(.+)$/.exec(arg);
    if (match && isPathLikeShellTarget(match[1])) {
      targets.push(match[1]);
    }
  }
  return targets;
}

function optionValue(args: string[], shortName: string): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === shortName) {
      const next = args[index + 1];
      return isPathLikeShellTarget(next) ? next : undefined;
    }
    if (arg.startsWith(`${shortName}=`)) {
      const value = arg.slice(shortName.length + 1);
      return isPathLikeShellTarget(value) ? value : undefined;
    }
  }
  return undefined;
}

function hasInPlaceEditFlag(args: string[]): boolean {
  return args.some((arg) => {
    if (arg === "--in-place" || arg.startsWith("--in-place=")) {
      return true;
    }
    if (arg.startsWith("--")) {
      return false;
    }
    if (arg === "-i" || arg.startsWith("-i")) {
      return true;
    }
    return /^-[A-Za-z]*i[A-Za-z]*$/.test(arg);
  });
}

function expandShellPathVariables(rawPath: string, cwd: string, env: NodeJS.ProcessEnv | undefined): string | undefined {
  const pwd = normalize(resolve(cwd));
  const envHome = typeof env?.HOME === "string" && env.HOME.trim() ? normalize(resolve(env.HOME)) : homedir();
  const expanded = rawPath
    .replace(/\$\{PWD\}|\$PWD(?=\/|$)/g, pwd)
    .replace(/\$\{HOME\}|\$HOME(?=\/|$)/g, envHome);
  if (expanded.includes("$") || expanded.includes("`")) {
    return undefined;
  }
  return expanded;
}

function resolveShellPath(rawPath: string, cwd: string, env?: NodeJS.ProcessEnv): string | undefined {
  if (!rawPath || rawPath.includes("\0") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(rawPath)) {
    return undefined;
  }
  if (rawPath.startsWith("<(") || rawPath.startsWith(">(")) {
    return undefined;
  }
  const expandedPath = expandShellPathVariables(rawPath, cwd, env);
  if (!expandedPath) {
    return undefined;
  }
  if (expandedPath === "~") {
    return normalize(homedir());
  }
  if (expandedPath.startsWith("~/")) {
    return normalize(resolve(homedir(), expandedPath.slice(2)));
  }
  return normalize(isAbsolute(expandedPath) ? expandedPath : resolve(cwd, expandedPath));
}

function unresolvedManagedKnowledgeRelPath(rawPath: string): string | undefined {
  const normalized = rawPath.replace(/\\/g, "/");
  for (const relPath of MANAGED_EXACT_RELPATHS) {
    if (normalized === relPath || normalized.endsWith(`/${relPath}`)) {
      return relPath;
    }
  }
  const marker = "/wiki/pages/";
  const markerIndex = normalized.indexOf(marker);
  if (normalized === "wiki/pages" || normalized.startsWith("wiki/pages/")) {
    return normalized;
  }
  if (markerIndex >= 0) {
    return normalized.slice(markerIndex + 1);
  }
  return undefined;
}

function hasShellPathExpansion(rawPath: string): boolean {
  return /[$`*?\[\]{}]/.test(rawPath);
}

function ambiguousManagedKnowledgeRelPath(
  layout: Extract<ResolvedKnowledgeLayout, { kind: "v2" }>,
  rawPath: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): string | undefined {
  if (!hasShellPathExpansion(rawPath)) {
    return undefined;
  }

  const normalizedRawPath = rawPath.replace(/\\/g, "/").replace(/^\.\//, "");
  const relCandidates = new Set<string>();
  if (normalizedRawPath === "wiki" || normalizedRawPath.startsWith("wiki/")) {
    relCandidates.add(normalizedRawPath);
  }

  const absPath = resolveShellPath(rawPath, cwd, env);
  if (absPath) {
    for (const candidate of pathCandidates(absPath)) {
      if (insideOrSame(layout.agentWorkspaceRoot, candidate)) {
        relCandidates.add(toWorkspaceRel(layout.agentWorkspaceRoot, candidate));
      }
    }
  } else {
    const marker = "/wiki/";
    const markerIndex = normalizedRawPath.indexOf(marker);
    if (markerIndex >= 0) {
      relCandidates.add(normalizedRawPath.slice(markerIndex + 1));
    }
  }

  for (const relCandidate of relCandidates) {
    const normalizedRel = relCandidate.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normalizedRel === "wiki" || normalizedRel.startsWith("wiki/")) {
      return normalizedRel;
    }
    const pagesMarker = "/wiki/pages/";
    const pagesMarkerIndex = normalizedRel.indexOf(pagesMarker);
    if (pagesMarkerIndex >= 0) {
      return normalizedRel.slice(pagesMarkerIndex + 1);
    }
  }

  return undefined;
}

function comparable(path: string): string {
  return normalize(path).split(sep).join("/").toLowerCase();
}

function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

function insideOrSame(parent: string, child: string): boolean {
  const parentKey = comparable(parent).replace(/\/+$/, "");
  const childKey = comparable(child).replace(/\/+$/, "");
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}

function maybeRealExistingPrefix(absPath: string): string | undefined {
  let current = absPath;
  const suffix: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        return suffix.length > 0
          ? join(realpathSync(current), ...suffix.reverse())
          : realpathSync(current);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    suffix.push(basename(current));
    current = parent;
  }
}

function pathCandidates(absPath: string): string[] {
  const rawCandidates = [normalize(absPath)];
  const real = maybeRealExistingPrefix(absPath);
  if (real) {
    rawCandidates.push(normalize(real));
  }
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of rawCandidates) {
    const key = comparable(candidate);
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push(candidate);
    }
  }
  return candidates;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function managedKnowledgeRelPath(layout: Extract<ResolvedKnowledgeLayout, { kind: "v2" }>, absPath: string): string | undefined {
  const candidates = pathCandidates(absPath);
  const exactPaths = MANAGED_EXACT_RELPATHS.flatMap((relPath) => {
    const direct = join(layout.agentWorkspaceRoot, ...relPath.split("/"));
    return [direct, realOrSelf(direct)];
  });
  const pageRoots = [layout.paths.pagesDir, realOrSelf(layout.paths.pagesDir)];

  for (const candidate of candidates) {
    if (exactPaths.some((managedPath) => samePath(candidate, managedPath))) {
      return toWorkspaceRel(layout.agentWorkspaceRoot, candidate);
    }
    if (pageRoots.some((managedPath) => insideOrSame(managedPath, candidate))) {
      return toWorkspaceRel(layout.agentWorkspaceRoot, candidate);
    }
  }

  return undefined;
}

function toWorkspaceRel(workspaceRoot: string, absPathOrComparable: string): string {
  const normalizedRoot = normalize(workspaceRoot);
  const normalizedPath = absPathOrComparable.startsWith("/")
    ? normalize(absPathOrComparable)
    : normalize(absPathOrComparable);
  const roots = [normalizedRoot, realOrSelf(normalizedRoot)];
  for (const root of roots) {
    const rel = relative(root, normalizedPath).split(sep).join("/");
    if (!rel.startsWith("..") && rel !== "") {
      return rel;
    }
  }
  const rel = relative(normalizedRoot, normalizedPath).split(sep).join("/");
  if (!rel.startsWith("..") && rel !== "") {
    return rel;
  }
  return normalizedPath.split(sep).join("/");
}
