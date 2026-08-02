import { spawnSync } from "node:child_process";
import { isUtf8 } from "node:buffer";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
  parseKnowledgeV2SchemaMarker,
  resolveKnowledgeLayout,
  type ResolvedKnowledgeLayout,
  type ResolvedKnowledgeV2Layout,
} from "./layout.js";
import {
  acquireKnowledgeUpdateLock,
  assertSafeKnowledgeWorkspacePath,
  collectKnowledgePages,
  formatKnowledgePage,
  generateKnowledgeIndex,
  parseManagedKnowledgePagePath,
  type KnowledgeUpdateFailure,
  type KnowledgeUpdateFs,
  type KnowledgeUpdateLockHandle,
} from "./update.js";
import { MINIME_AGENT_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

export type KnowledgeSyncClassification = "no-op" | "behind" | "ahead" | "diverged";

export interface KnowledgeSyncSuccess {
  ok: true;
  status: "converged";
  layoutKind: "v2";
  branch: "main";
  remote: "origin";
  classification: KnowledgeSyncClassification;
  commit: string;
  attempts: 1 | 2;
  lockPath: ".tmp/knowledge-update.lock";
}

export interface KnowledgeSyncFailure {
  ok: false;
  status: "unavailable" | "unsupported" | "rejected" | "locked" | "conflict" | "error";
  reason: string;
  message: string;
  layoutKind?: ResolvedKnowledgeLayout["kind"];
  attempts?: 1 | 2;
  conflictPaths?: string[];
}

export type KnowledgeSyncResponse = KnowledgeSyncSuccess | KnowledgeSyncFailure;

export interface KnowledgeSyncGitResult {
  status: number;
  stdout: string;
  stdoutBytes?: Buffer;
  stderr: string;
}

export interface KnowledgeSyncGitOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type KnowledgeSyncGitRunner = (
  args: readonly string[],
  options: KnowledgeSyncGitOptions,
) => KnowledgeSyncGitResult;

export interface KnowledgeSyncFs extends KnowledgeUpdateFs {
  mkdtempSync: typeof mkdtempSync;
  rmSync: typeof rmSync;
}

export interface KnowledgeSyncDeps {
  agentWorkspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  resolveLayout?: (agentWorkspaceRoot: string) => ResolvedKnowledgeLayout;
  git?: KnowledgeSyncGitRunner;
  fs?: Partial<KnowledgeSyncFs>;
  temporaryDirectory?: string;
  lockNow?: () => Date;
  staleLockMs?: number;
  isProcessAlive?: (pid: number) => boolean;
  getProcessIdentity?: (pid: number) => string | undefined;
}

interface GitTips {
  local: string;
  remote: string;
}

interface CandidateResult {
  ok: true;
  commit: string;
  root: string;
}

type AttemptResult = CandidateResult | KnowledgeSyncFailure;

const RECOVERY_REF_PREFIX = "refs/minime/knowledge-sync/recovery";
const LOCK_RELPATH = ".tmp/knowledge-update.lock" as const;
const LOCK_RECLAIM_RELPATH = ".tmp/knowledge-update.lock.reclaim" as const;
const SYNC_WORKTREE_MARKER = ".minime-knowledge-sync-owner.json";
const MAX_ATTEMPTS = 2;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT_MS = 120_000;
const DISABLE_GIT_HOOKS = ["-c", "core.hooksPath=/dev/null"] as const;
const REPOSITORY_SCOPING_GIT_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;
const FIXED_GIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "minime-bot",
  GIT_AUTHOR_EMAIL: "minime-bot@users.noreply.github.com",
  GIT_COMMITTER_NAME: "minime-bot",
  GIT_COMMITTER_EMAIL: "minime-bot@users.noreply.github.com",
} as const;
const GIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-apply",
  "rebase-merge",
  "sequencer",
] as const;
const MANAGED_KNOWLEDGE_PATHSPECS = [
  "wiki/schema.md",
  "wiki/index.md",
  "wiki/log.md",
  "wiki/issues.md",
  "wiki/pages",
  "artifacts/knowledge-archive",
] as const;
const CHECKIN_TRANSFORMATION_ATTRIBUTES = [
  "filter",
  "ident",
  "working-tree-encoding",
  "text",
  "eol",
  "crlf",
] as const;
const NEUTRAL_CHECKIN_ATTRIBUTE_VALUES = new Set(["unspecified", "unset"]);
const AMBIGUOUS_ATTRIBUTE_SENTINEL_VALUES = new Set(["set", "unset", "unspecified"]);

const defaultFs: KnowledgeSyncFs = {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
};

export const defaultKnowledgeSyncGitRunner: KnowledgeSyncGitRunner = (args, options) => {
  const env = { ...process.env, ...(options.env ?? {}) };
  for (const name of REPOSITORY_SCOPING_GIT_ENV) {
    delete env[name];
  }
  Object.assign(env, {
    GCM_INTERACTIVE: "Never",
    GIT_GRAFT_FILE: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS_REQUIRE: "never",
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const result = spawnSync("git", [...args], {
    cwd: options.cwd,
    encoding: null,
    env,
    killSignal: "SIGKILL",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
  });
  const executionError = result.error as NodeJS.ErrnoException | undefined;
  const stdoutBytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr.toString("utf8")
    : result.stderr ?? "";
  return {
    status: executionError ? 1 : (result.status ?? 1),
    stdout: executionError ? "" : stdoutBytes.toString("utf8"),
    stdoutBytes: executionError ? Buffer.alloc(0) : stdoutBytes,
    stderr: executionError
      ? executionError.code === "ENOBUFS"
        ? "git output exceeded the 64 MiB knowledge sync limit."
        : executionError.code === "ETIMEDOUT"
          ? `git execution timed out after ${timeoutMs} ms.`
        : `git execution failed${executionError.code ? ` (${executionError.code})` : ""}.`
      : stderr,
  };
};

function failure(
  status: KnowledgeSyncFailure["status"],
  reason: string,
  message: string,
  extra: Pick<KnowledgeSyncFailure, "layoutKind" | "attempts" | "conflictPaths"> = {},
): KnowledgeSyncFailure {
  return { ok: false, status, reason, message, ...extra };
}

function errorText(result: KnowledgeSyncGitResult): string {
  return result.stderr.trim() || `git exited with status ${result.status}`;
}

function isUpdateFailure(value: unknown): value is KnowledgeUpdateFailure {
  return typeof value === "object" && value !== null && "ok" in value && value.ok === false;
}

function workspaceRootFromDeps(deps: KnowledgeSyncDeps): string | undefined {
  const env = deps.env ?? process.env;
  const root = deps.agentWorkspaceRoot ?? env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
  return typeof root === "string" && root.trim() ? normalize(resolve(root)) : undefined;
}

function realOrResolved(path: string, fs: KnowledgeSyncFs): string {
  try {
    return normalize(fs.realpathSync(path));
  } catch {
    return normalize(resolve(path));
  }
}

function resolveV2Layout(
  workspaceRoot: string,
  deps: KnowledgeSyncDeps,
): ResolvedKnowledgeV2Layout | KnowledgeSyncFailure {
  const layout = (deps.resolveLayout ?? resolveKnowledgeLayout)(workspaceRoot);
  if (layout.kind !== "v2") {
    return failure(
      "unsupported",
      "knowledge-sync-requires-v2",
      "knowledge sync requires a positively detected Knowledge v2 workspace.",
      { layoutKind: layout.kind },
    );
  }
  return layout;
}

function validateGitRoot(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): KnowledgeSyncFailure | undefined {
  const result = git(["rev-parse", "--show-toplevel"], { cwd: workspaceRoot });
  if (result.status !== 0) {
    return failure(
      "rejected",
      "not-a-git-repository",
      "knowledge sync requires the agent workspace to be a Git repository root.",
    );
  }
  const gitRoot = result.stdout.trim();
  if (!gitRoot || realOrResolved(gitRoot, fs) !== realOrResolved(workspaceRoot, fs)) {
    return failure(
      "rejected",
      "workspace-not-git-root",
      "knowledge sync requires the agent workspace itself, not a parent or child directory, to be the Git root.",
    );
  }
  return undefined;
}

function validateMainBranch(workspaceRoot: string, git: KnowledgeSyncGitRunner): KnowledgeSyncFailure | undefined {
  const result = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: workspaceRoot });
  const branch = result.stdout.trim();
  if (result.status !== 0 || branch !== "main") {
    return failure(
      "rejected",
      "not-on-main",
      `knowledge sync requires the canonical worktree to be on main; current branch is ${branch || "detached HEAD"}.`,
    );
  }
  return undefined;
}

function validateCleanWorktree(workspaceRoot: string, git: KnowledgeSyncGitRunner): KnowledgeSyncFailure | undefined {
  const result = git(
    [
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignore-submodules=none",
      "--",
      ".",
      `:(exclude)${LOCK_RELPATH}`,
      `:(exclude)${LOCK_RECLAIM_RELPATH}`,
    ],
    { cwd: workspaceRoot },
  );
  if (result.status !== 0) {
    return failure("error", "git-status-failed", `knowledge sync could not inspect the worktree: ${errorText(result)}`);
  }
  const detail = result.stdout.trim();
  if (detail) {
    return failure(
      "rejected",
      "dirty-worktree",
      `knowledge sync requires a clean committed worktree; commit or remove these changes first: ${detail}`,
    );
  }
  return undefined;
}

function validateNoGitOperationInProgress(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): KnowledgeSyncFailure | undefined {
  for (const marker of GIT_OPERATION_MARKERS) {
    const result = git(["rev-parse", "--git-path", marker], { cwd: workspaceRoot });
    const gitPath = result.stdout.trim();
    if (result.status !== 0 || !gitPath) {
      return failure(
        "error",
        "git-operation-state-inspection-failed",
        `knowledge sync could not inspect the repository operation state for ${marker}: ${errorText(result)}`,
      );
    }
    const markerPath = isAbsolute(gitPath) ? gitPath : resolve(workspaceRoot, gitPath);
    try {
      fs.lstatSync(markerPath);
      return failure(
        "rejected",
        "git-operation-in-progress",
        `knowledge sync requires no unfinished Git operation; finish or abort the operation associated with ${marker} first.`,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return failure(
          "error",
          "git-operation-state-inspection-failed",
          `knowledge sync could not inspect the repository operation state for ${marker}.`,
        );
      }
    }
  }
  return undefined;
}

function validateRuntimeLockUntracked(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const result = git(["ls-files", "--cached", "-z", "--", LOCK_RELPATH, LOCK_RECLAIM_RELPATH], {
    cwd: workspaceRoot,
  });
  if (result.status !== 0) {
    return failure(
      "error",
      "runtime-lock-inspection-failed",
      `knowledge sync could not inspect the reserved runtime lock path: ${errorText(result)}`,
    );
  }
  if (result.stdout) {
    return failure(
      "rejected",
      "tracked-runtime-lock",
      `knowledge sync requires ${LOCK_RELPATH} and its reclaim marker to remain untracked runtime state; remove them from Git history first.`,
    );
  }
  return undefined;
}

function preflightBeforeLock(
  workspaceRoot: string,
  deps: KnowledgeSyncDeps,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): ResolvedKnowledgeV2Layout | KnowledgeSyncFailure {
  const layout = resolveV2Layout(workspaceRoot, deps);
  if ("ok" in layout) {
    return layout;
  }
  return (
    validateGitRoot(workspaceRoot, git, fs) ??
    validateMainBranch(workspaceRoot, git) ??
    validateNoGitOperationInProgress(workspaceRoot, git, fs) ??
    validateRuntimeLockUntracked(workspaceRoot, git) ??
    validateEffectiveAutocrlf(workspaceRoot, git) ??
    layout
  );
}

function preflight(
  workspaceRoot: string,
  deps: KnowledgeSyncDeps,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): ResolvedKnowledgeV2Layout | KnowledgeSyncFailure {
  const beforeLock = preflightBeforeLock(workspaceRoot, deps, git, fs);
  if ("ok" in beforeLock) {
    return beforeLock;
  }
  return validateCleanWorktree(workspaceRoot, git) ?? beforeLock;
}

function readTips(workspaceRoot: string, git: KnowledgeSyncGitRunner): GitTips | KnowledgeSyncFailure {
  const local = git(["rev-parse", "--verify", "refs/heads/main^{commit}"], { cwd: workspaceRoot });
  if (local.status !== 0) {
    return failure("rejected", "main-missing", "knowledge sync requires a local main commit.");
  }
  const remote = git(["rev-parse", "--verify", "refs/remotes/origin/main^{commit}"], { cwd: workspaceRoot });
  if (remote.status !== 0) {
    return failure(
      "rejected",
      "origin-main-missing",
      "knowledge sync requires origin/main to exist after fetching origin main.",
    );
  }
  return { local: local.stdout.trim(), remote: remote.stdout.trim() };
}

function isAncestor(
  workspaceRoot: string,
  ancestor: string,
  descendant: string,
  git: KnowledgeSyncGitRunner,
): boolean | KnowledgeSyncFailure {
  const result = git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: workspaceRoot });
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  return failure("error", "git-ancestry-failed", `knowledge sync could not classify Git history: ${errorText(result)}`);
}

function classifyTips(
  workspaceRoot: string,
  tips: GitTips,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncClassification | KnowledgeSyncFailure {
  if (tips.local === tips.remote) {
    return "no-op";
  }
  const localBehind = isAncestor(workspaceRoot, tips.local, tips.remote, git);
  if (typeof localBehind !== "boolean") {
    return localBehind;
  }
  if (localBehind) {
    return "behind";
  }
  const localAhead = isAncestor(workspaceRoot, tips.remote, tips.local, git);
  if (typeof localAhead !== "boolean") {
    return localAhead;
  }
  return localAhead ? "ahead" : "diverged";
}

function recoveryRef(kind: "local" | "remote", commit: string): string {
  return `${RECOVERY_REF_PREFIX}/${kind}-${commit}`;
}

function preserveTips(
  workspaceRoot: string,
  tips: GitTips,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  for (const [kind, commit] of [["local", tips.local], ["remote", tips.remote]] as const) {
    const ref = recoveryRef(kind, commit);
    const result = git([...DISABLE_GIT_HOOKS, "update-ref", ref, commit], { cwd: workspaceRoot });
    if (result.status !== 0) {
      return failure(
        "error",
        "recovery-ref-create-failed",
        `knowledge sync could not preserve ${kind} tip ${commit} at ${ref}: ${errorText(result)}`,
      );
    }
  }
  return undefined;
}

function listRecoveryRefs(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
): Array<{ ref: string; commit: string }> | KnowledgeSyncFailure {
  const result = git(
    ["for-each-ref", "--format=%(refname)%00%(objectname)", RECOVERY_REF_PREFIX],
    { cwd: workspaceRoot },
  );
  if (result.status !== 0) {
    return failure("error", "recovery-ref-list-failed", `knowledge sync could not inspect recovery refs: ${errorText(result)}`);
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", commit = ""] = line.split("\0");
      return { ref, commit };
    });
}

function removeReachableRecoveryRefs(
  workspaceRoot: string,
  canonicalCommit: string,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const refs = listRecoveryRefs(workspaceRoot, git);
  if (!Array.isArray(refs)) {
    return refs;
  }
  for (const entry of refs) {
    const reachable = isAncestor(workspaceRoot, entry.commit, canonicalCommit, git);
    if (typeof reachable !== "boolean") {
      return reachable;
    }
    if (!reachable) {
      return failure(
        "error",
        "recovery-ref-not-reachable",
        `knowledge sync kept recovery refs because ${entry.commit} is not reachable from canonical main.`,
      );
    }
  }
  for (const entry of refs) {
    const deleted = git([...DISABLE_GIT_HOOKS, "update-ref", "-d", entry.ref, entry.commit], {
      cwd: workspaceRoot,
    });
    if (deleted.status !== 0) {
      return failure(
        "error",
        "recovery-ref-delete-failed",
        `knowledge sync converged but could not remove reachable recovery ref ${entry.ref}: ${errorText(deleted)}`,
      );
    }
  }
  return undefined;
}

function validateCandidateLayout(
  candidateRoot: string,
  deps: KnowledgeSyncDeps,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): KnowledgeSyncFailure | undefined {
  const layout = (deps.resolveLayout ?? resolveKnowledgeLayout)(candidateRoot);
  if (layout.kind !== "v2") {
    return failure(
      "rejected",
      "candidate-not-knowledge-v2",
      "knowledge sync refused a candidate that does not contain a valid Knowledge v2 layout.",
      { layoutKind: layout.kind },
    );
  }
  const runtimeLockProblem = validateRuntimeLockUntracked(candidateRoot, git);
  if (runtimeLockProblem) {
    return runtimeLockProblem;
  }
  const corpusProblem = validateCandidateCorpus(layout, git, fs);
  if (corpusProblem) {
    return corpusProblem;
  }
  const clean = validateCleanWorktree(candidateRoot, git);
  if (clean) {
    return failure(
      clean.status,
      "candidate-worktree-not-clean",
      `knowledge sync candidate validation failed: ${clean.message}`,
    );
  }
  return undefined;
}

function candidateUpdateFailure(
  problem: KnowledgeUpdateFailure,
  reason: string,
  context: string,
): KnowledgeSyncFailure {
  return failure(
    "rejected",
    reason,
    `${context}: ${problem.message}`,
    problem.layoutKind ? { layoutKind: problem.layoutKind } : {},
  );
}

function trackedManagedKnowledgePaths(
  candidateRoot: string,
  git: KnowledgeSyncGitRunner,
): string[] | KnowledgeSyncFailure {
  const listed = git(["ls-files", "--cached", "-z", "--", ...MANAGED_KNOWLEDGE_PATHSPECS], {
    cwd: candidateRoot,
  });
  if (listed.status !== 0) {
    return failure(
      "error",
      "candidate-managed-path-inspection-failed",
      `knowledge sync could not inspect tracked managed paths: ${errorText(listed)}`,
    );
  }
  return [...new Set(listed.stdout.split("\0").filter(Boolean))].sort();
}

function validateEffectiveAutocrlf(
  candidateRoot: string,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const configured = git(["config", "--get", "core.autocrlf"], { cwd: candidateRoot });
  if (configured.status === 1 && !configured.stdout.trim()) {
    return undefined;
  }
  if (configured.status !== 0) {
    return failure(
      "error",
      "candidate-managed-config-inspection-failed",
      `knowledge sync could not inspect the effective core.autocrlf setting: ${errorText(configured)}`,
    );
  }
  const value = configured.stdout.trim().toLowerCase();
  if (value !== "input") {
    const booleanValue = git(["config", "--type=bool", "--get", "core.autocrlf"], {
      cwd: candidateRoot,
    });
    if (booleanValue.status !== 0) {
      return failure(
        "error",
        "candidate-managed-config-inspection-failed",
        `knowledge sync could not interpret the effective core.autocrlf setting: ${errorText(booleanValue)}`,
      );
    }
    if (booleanValue.stdout.trim() === "false") {
      return undefined;
    }
  }
  return failure(
    "unsupported",
    "candidate-unsupported-checkin-transformation",
    "knowledge sync refused the effective core.autocrlf setting because it can alter committed Knowledge bytes; set core.autocrlf=false before retrying.",
  );
}

function validateManagedCheckinTransformations(
  candidateRoot: string,
  git: KnowledgeSyncGitRunner,
  cached = false,
): KnowledgeSyncFailure | undefined {
  const configProblem = validateEffectiveAutocrlf(candidateRoot, git);
  if (configProblem) {
    return configProblem;
  }
  const trackedPaths = trackedManagedKnowledgePaths(candidateRoot, git);
  if (!Array.isArray(trackedPaths)) {
    return trackedPaths;
  }
  return validateManagedCheckinAttributes(candidateRoot, trackedPaths, git, [], cached);
}

function validateManagedCheckinAttributes(
  candidateRoot: string,
  trackedPaths: readonly string[],
  git: KnowledgeSyncGitRunner,
  configArgs: readonly string[] = [],
  cached = false,
): KnowledgeSyncFailure | undefined {
  for (const relPath of trackedPaths) {
    const result = git(
      [
        ...configArgs,
        "check-attr",
        ...(cached ? ["--cached"] : []),
        "-z",
        ...CHECKIN_TRANSFORMATION_ATTRIBUTES,
        "--",
        relPath,
      ],
      { cwd: candidateRoot },
    );
    if (result.status !== 0) {
      return failure(
        "error",
        "candidate-managed-attribute-inspection-failed",
        `knowledge sync could not inspect check-in attributes for ${relPath}: ${errorText(result)}`,
      );
    }
    const fields = result.stdout.split("\0");
    for (let index = 0; index < CHECKIN_TRANSFORMATION_ATTRIBUTES.length; index += 1) {
      const offset = index * 3;
      const expectedAttribute = CHECKIN_TRANSFORMATION_ATTRIBUTES[index];
      const value = fields[offset + 2];
      if (fields[offset] !== relPath || fields[offset + 1] !== expectedAttribute || !value) {
        return failure(
          "error",
          "candidate-managed-attribute-inspection-failed",
          `knowledge sync received an invalid check-in attribute result for ${relPath}.`,
        );
      }
      if (NEUTRAL_CHECKIN_ATTRIBUTE_VALUES.has(value)) {
        if (expectedAttribute === "filter") {
          for (const key of [`filter.${value}.clean`, `filter.${value}.process`]) {
            const configured = git([...configArgs, "config", "--get", key], {
              cwd: candidateRoot,
            });
            if (configured.status === 0) {
              return failure(
                "unsupported",
                "candidate-unsupported-clean-filter",
                `knowledge sync refused ${relPath} because its Git filter value is indistinguishable from the ${value} check-attr sentinel and ${key} can alter committed Knowledge bytes.`,
              );
            }
            if (configured.status !== 1 || configured.stderr.trim()) {
              return failure(
                "error",
                "candidate-managed-config-inspection-failed",
                `knowledge sync could not inspect ${key}: ${errorText(configured)}`,
              );
            }
          }
        }
        continue;
      }
      if (expectedAttribute === "filter") {
        return failure(
          "unsupported",
          "candidate-unsupported-clean-filter",
          `knowledge sync refused ${relPath} because its Git clean filter can alter committed Knowledge bytes.`,
        );
      }
      return failure(
        "unsupported",
        "candidate-unsupported-checkin-transformation",
        `knowledge sync refused ${relPath} because its Git ${expectedAttribute} attribute can alter committed Knowledge bytes.`,
      );
    }
  }
  return undefined;
}

function validateCanonicalCheckinTransformations(
  workspaceRoot: string,
  candidateRoot: string,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const autocrlfProblem = validateEffectiveAutocrlf(workspaceRoot, git);
  if (autocrlfProblem) {
    return autocrlfProblem;
  }
  const configured = git(["config", "--path", "--get", "core.attributesFile"], {
    cwd: workspaceRoot,
  });
  if (configured.status === 1 && !configured.stdout.trim()) {
    return undefined;
  }
  if (configured.status !== 0) {
    return failure(
      "error",
      "candidate-managed-config-inspection-failed",
      `knowledge sync could not inspect the canonical core.attributesFile setting: ${errorText(configured)}`,
    );
  }
  const attributesFile = configured.stdout.trim();
  if (!attributesFile) {
    return undefined;
  }
  const canonicalAttributesFile = isAbsolute(attributesFile)
    ? attributesFile
    : resolve(workspaceRoot, attributesFile);
  const trackedPaths = trackedManagedKnowledgePaths(candidateRoot, git);
  if (!Array.isArray(trackedPaths)) {
    return trackedPaths;
  }
  return validateManagedCheckinAttributes(
    candidateRoot,
    trackedPaths,
    git,
    ["-c", `core.attributesFile=${canonicalAttributesFile}`],
  );
}

function disabledConfiguredFilterArgs(
  candidateRoot: string,
  git: KnowledgeSyncGitRunner,
): string[] | KnowledgeSyncFailure {
  const configured = git(
    [
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    { cwd: candidateRoot },
  );
  if (configured.status === 1 && !configured.stdout) {
    return [];
  }
  if (configured.status !== 0) {
    return failure(
      "error",
      "candidate-managed-config-inspection-failed",
      `knowledge sync could not inspect configured Git filters: ${errorText(configured)}`,
    );
  }
  const drivers = new Set<string>();
  for (const key of configured.stdout.split("\0").filter(Boolean)) {
    const match = /^filter\.(.+)\.(?:clean|smudge|process|required)$/iu.exec(key);
    if (!match?.[1]) {
      return failure(
        "error",
        "candidate-managed-config-inspection-failed",
        "knowledge sync could not parse a configured Git filter name.",
      );
    }
    drivers.add(match[1]);
  }
  return [...drivers].sort().flatMap((driver) => [
    "-c",
    `filter.${driver}.clean=`,
    "-c",
    `filter.${driver}.smudge=`,
    "-c",
    `filter.${driver}.process=`,
    "-c",
    `filter.${driver}.required=false`,
  ]);
}

function validateManagedWorktreeMaterialization(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const indexFlags = git(
    ["ls-files", "-v", "-z"],
    { cwd: workspaceRoot },
  );
  if (indexFlags.status !== 0) {
    return failure(
      "error",
      "candidate-managed-path-inspection-failed",
      `knowledge sync could not inspect tracked candidate index flags: ${errorText(indexFlags)}`,
    );
  }
  const hiddenPaths: string[] = [];
  for (const entry of indexFlags.stdout.split("\0").filter(Boolean)) {
    const match = /^([^ ]) ([\s\S]+)$/u.exec(entry);
    if (!match) {
      return failure(
        "error",
        "candidate-managed-path-inspection-failed",
        "knowledge sync could not parse the tracked candidate Git index flags.",
      );
    }
    const [, tag, relPath] = match;
    if (tag !== "H") {
      hiddenPaths.push(relPath);
    }
  }
  if (hiddenPaths.length > 0) {
    hiddenPaths.sort();
    const hiddenManagedPaths = hiddenPaths.filter((path) => isManagedKnowledgePath(path));
    if (hiddenManagedPaths.length === 0) {
      return failure(
        "rejected",
        "candidate-hidden-tracked-entry",
        `knowledge sync requires all tracked files to be materialized without skip-worktree or assume-unchanged index flags; restore normal tracking for: ${hiddenPaths.join(", ")}.`,
        { conflictPaths: hiddenPaths },
      );
    }
    return failure(
      "rejected",
      "candidate-hidden-managed-entry",
      `knowledge sync requires all tracked files to be materialized without skip-worktree or assume-unchanged index flags; restore normal tracking for: ${hiddenPaths.join(", ")}.`,
      { conflictPaths: hiddenPaths },
    );
  }

  const ignored = git(
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ...MANAGED_KNOWLEDGE_PATHSPECS,
    ],
    { cwd: workspaceRoot },
  );
  if (ignored.status !== 0) {
    return failure(
      "error",
      "candidate-managed-path-inspection-failed",
      `knowledge sync could not inspect ignored managed candidate paths: ${errorText(ignored)}`,
    );
  }
  const ignoredPaths = ignored.stdout.split("\0").filter(Boolean).sort();
  if (ignoredPaths.length > 0) {
    return failure(
      "rejected",
      "candidate-untracked-managed-files",
      `knowledge sync requires every managed Knowledge file to be committed; ignored files were found: ${ignoredPaths.join(", ")}.`,
      { conflictPaths: ignoredPaths },
    );
  }

  return undefined;
}

function validateManagedGitEntries(
  layout: ResolvedKnowledgeV2Layout,
  git: KnowledgeSyncGitRunner,
): string[] | KnowledgeSyncFailure {
  const listed = git(
    [
      "ls-files",
      "--stage",
      "-z",
      "--",
      ...MANAGED_KNOWLEDGE_PATHSPECS,
    ],
    { cwd: layout.agentWorkspaceRoot },
  );
  if (listed.status !== 0) {
    return failure(
      "error",
      "candidate-managed-path-inspection-failed",
      `knowledge sync could not inspect managed candidate paths: ${errorText(listed)}`,
    );
  }

  const materializationProblem = validateManagedWorktreeMaterialization(layout.agentWorkspaceRoot, git);
  if (materializationProblem) {
    return materializationProblem;
  }

  const trackedPaths = new Set<string>();
  const trackedPagePaths: string[] = [];
  for (const entry of listed.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d+) [0-9a-f]+ (\d+)\t([\s\S]+)$/u.exec(entry);
    if (!match) {
      return failure(
        "error",
        "candidate-managed-path-inspection-failed",
        "knowledge sync could not parse the managed candidate Git index.",
      );
    }
    const [, mode, stage, relPath] = match;
    trackedPaths.add(relPath);
    if (stage !== "0") {
      return failure(
        "conflict",
        "candidate-unresolved-conflict",
        `knowledge sync candidate still has an unresolved managed path: ${relPath}.`,
        { conflictPaths: [relPath] },
      );
    }
    if (mode !== "100644" && mode !== "100755") {
      return failure(
        "rejected",
        "candidate-unsafe-managed-entry",
        `knowledge sync requires managed paths to be regular files; refused Git mode ${mode} at ${relPath}.`,
      );
    }
    if (relPath.startsWith("wiki/pages/")) {
      trackedPagePaths.push(relPath);
      const managedPage = parseManagedKnowledgePagePath(relPath);
      if (isUpdateFailure(managedPage)) {
        return candidateUpdateFailure(
          managedPage,
          "candidate-invalid-managed-page-path",
          `knowledge sync refused invalid active page path ${relPath}`,
        );
      }
    }
  }
  const transformationProblem = validateManagedCheckinTransformations(layout.agentWorkspaceRoot, git);
  if (transformationProblem) {
    return transformationProblem;
  }
  if (!trackedPaths.has("wiki/log.md")) {
    return failure(
      "rejected",
      "candidate-structural-log-missing",
      "knowledge sync requires a committed regular wiki/log.md structural history.",
    );
  }
  return trackedPagePaths.sort();
}

function validateCandidateCorpus(
  layout: ResolvedKnowledgeV2Layout,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): KnowledgeSyncFailure | undefined {
  const trackedPagePaths = validateManagedGitEntries(layout, git);
  if (!Array.isArray(trackedPagePaths)) {
    return trackedPagePaths;
  }
  for (const path of [layout.paths.schemaPath, layout.paths.indexPath, layout.paths.logPath]) {
    const safePathProblem = assertSafeKnowledgeWorkspacePath(layout.agentWorkspaceRoot, path, fs);
    if (safePathProblem) {
      return candidateUpdateFailure(
        safePathProblem,
        "candidate-unsafe-managed-path",
        "knowledge sync candidate managed-path validation failed",
      );
    }
  }
  try {
    if (!isUtf8(fs.readFileSync(layout.paths.logPath))) {
      return failure(
        "rejected",
        "candidate-structural-log-invalid-encoding",
        "knowledge sync requires committed wiki/log.md structural history to be valid UTF-8.",
      );
    }
  } catch (error) {
    return failure(
      "rejected",
      "candidate-structural-log-unreadable",
      `knowledge sync could not read the candidate structural log: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const pages = collectKnowledgePages(layout, fs);
  if (!Array.isArray(pages)) {
    return candidateUpdateFailure(
      pages,
      "candidate-page-invalid",
      "knowledge sync candidate page validation failed",
    );
  }
  const materializedPagePaths = pages.map(({ relPath }) => relPath).sort();
  if (
    trackedPagePaths.length !== materializedPagePaths.length ||
    trackedPagePaths.some((relPath, index) => relPath !== materializedPagePaths[index])
  ) {
    const trackedPageSet = new Set(trackedPagePaths);
    const materializedPageSet = new Set(materializedPagePaths);
    const mismatchedPaths = [
      ...trackedPagePaths.filter((relPath) => !materializedPageSet.has(relPath)),
      ...materializedPagePaths.filter((relPath) => !trackedPageSet.has(relPath)),
    ].sort();
    return failure(
      "rejected",
      "candidate-active-page-set-mismatch",
      `knowledge sync requires every tracked active page to be uniquely materialized and no untracked active pages; mismatched paths: ${mismatchedPaths.join(", ")}.`,
      { conflictPaths: mismatchedPaths },
    );
  }
  let actualIndex: string;
  try {
    actualIndex = fs.readFileSync(layout.paths.indexPath, "utf8");
  } catch (error) {
    return failure(
      "rejected",
      "candidate-index-unreadable",
      `knowledge sync could not read the candidate index: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (actualIndex !== generateKnowledgeIndex(pages)) {
    return failure(
      "rejected",
      "candidate-index-page-set-mismatch",
      "knowledge sync requires wiki/index.md to exactly match the generated complete active Knowledge page set.",
    );
  }
  return undefined;
}

function unresolvedConflictPaths(
  candidateRoot: string,
  git: KnowledgeSyncGitRunner,
): string[] | KnowledgeSyncFailure {
  const result = git(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: candidateRoot });
  if (result.status !== 0) {
    return failure(
      "error",
      "candidate-conflict-inspection-failed",
      `knowledge sync could not inspect unresolved candidate paths: ${errorText(result)}`,
    );
  }
  return result.stdout.split("\0").filter(Boolean).sort();
}

const SAFE_DEFAULT_MERGE_DRIVERS = new Set(["text", "binary"]);
const SAFE_MERGE_ATTRIBUTE_VALUES = new Set(["unspecified", "set", "unset", "text", "binary"]);

interface ChangedPath {
  paths: string[];
}

function changedPathsBetween(
  candidateRoot: string,
  base: string,
  tip: string,
  git: KnowledgeSyncGitRunner,
): ChangedPath[] | KnowledgeSyncFailure {
  const changed = git(["diff", "--name-status", "-z", "--find-renames", base, tip, "--"], {
    cwd: candidateRoot,
  });
  if (changed.status !== 0) {
    return failure(
      "error",
      "candidate-changed-path-inspection-failed",
      `knowledge sync could not inspect divergent changed paths: ${errorText(changed)}`,
    );
  }
  const fields = changed.stdout.split("\0");
  fields.pop();
  const paths: ChangedPath[] = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) {
      return failure(
        "error",
        "candidate-changed-path-inspection-failed",
        "knowledge sync received an invalid divergent changed-path result.",
      );
    }
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    const recordPaths = fields.slice(index, index + pathCount);
    if (recordPaths.length !== pathCount || recordPaths.some((path) => !path)) {
      return failure(
        "error",
        "candidate-changed-path-inspection-failed",
        "knowledge sync received an incomplete divergent changed-path result.",
      );
    }
    paths.push({ paths: recordPaths });
    index += pathCount;
  }
  return paths;
}

function validateMergeDrivers(
  candidateRoot: string,
  tips: GitTips,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const mergeBase = git(["merge-base", tips.local, tips.remote], { cwd: candidateRoot });
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    return failure(
      "error",
      "candidate-merge-base-unreadable",
      `knowledge sync could not read the merge base before validating merge drivers: ${errorText(mergeBase)}`,
    );
  }
  const base = mergeBase.stdout.trim();
  const localPaths = changedPathsBetween(candidateRoot, base, tips.local, git);
  if (!Array.isArray(localPaths)) {
    return localPaths;
  }
  const remotePaths = changedPathsBetween(candidateRoot, base, tips.remote, git);
  if (!Array.isArray(remotePaths)) {
    return remotePaths;
  }
  const remoteChangesByPath = new Map<string, ChangedPath[]>();
  for (const remoteChange of remotePaths) {
    for (const path of remoteChange.paths) {
      const changes = remoteChangesByPath.get(path) ?? [];
      changes.push(remoteChange);
      remoteChangesByPath.set(path, changes);
    }
  }
  const jointlyChangedPaths = new Set<string>();
  for (const localChange of localPaths) {
    for (const localPath of localChange.paths) {
      for (const remoteChange of remoteChangesByPath.get(localPath) ?? []) {
        for (const path of [...localChange.paths, ...remoteChange.paths]) {
          jointlyChangedPaths.add(path);
        }
      }
    }
  }
  if (jointlyChangedPaths.size === 0) {
    return undefined;
  }

  for (const driver of SAFE_DEFAULT_MERGE_DRIVERS) {
    const configured = git(["config", "--get", `merge.${driver}.driver`], { cwd: candidateRoot });
    if (configured.status === 0) {
      return failure(
        "unsupported",
        "unsupported-merge-driver",
        `knowledge sync refused divergent paths because merge.${driver}.driver overrides Git's built-in ${driver} merge driver.`,
      );
    }
    if (configured.stderr.trim()) {
      return failure(
        "error",
        "candidate-merge-driver-inspection-failed",
        `knowledge sync could not inspect merge.${driver}.driver: ${errorText(configured)}`,
      );
    }
  }

  const defaultDriver = git(["config", "--get", "merge.default"], { cwd: candidateRoot });
  if (defaultDriver.status === 0 && !SAFE_DEFAULT_MERGE_DRIVERS.has(defaultDriver.stdout.trim())) {
    return failure(
      "unsupported",
      "unsupported-merge-driver",
      "knowledge sync refused divergent paths because merge.default selects a union or custom merge driver; use Git's text or binary merge driver so conflicts remain explicit.",
    );
  }
  if (defaultDriver.status !== 0 && defaultDriver.stderr.trim()) {
    return failure(
      "error",
      "candidate-merge-driver-inspection-failed",
      `knowledge sync could not inspect merge.default: ${errorText(defaultDriver)}`,
    );
  }

  for (const path of [...jointlyChangedPaths].sort()) {
    const attribute = git(["check-attr", "-z", "merge", "--", path], { cwd: candidateRoot });
    if (attribute.status !== 0) {
      return failure(
        "error",
        "candidate-merge-driver-inspection-failed",
        `knowledge sync could not inspect the merge driver for ${path}: ${errorText(attribute)}`,
      );
    }
    const fields = attribute.stdout.split("\0");
    if (fields[0] !== path || fields[1] !== "merge" || !fields[2]) {
      return failure(
        "error",
        "candidate-merge-driver-inspection-failed",
        `knowledge sync received an invalid merge-attribute result for ${path}.`,
      );
    }
    if (!SAFE_MERGE_ATTRIBUTE_VALUES.has(fields[2])) {
      return failure(
        "unsupported",
        "unsupported-merge-driver",
        `knowledge sync refused ${path} because its union or custom merge driver can hide a conflict; use Git's text or binary merge driver so conflicts remain explicit.`,
      );
    }
    if (AMBIGUOUS_ATTRIBUTE_SENTINEL_VALUES.has(fields[2])) {
      const key = `merge.${fields[2]}.driver`;
      const configured = git(["config", "--get", key], { cwd: candidateRoot });
      if (configured.status === 0) {
        return failure(
          "unsupported",
          "unsupported-merge-driver",
          `knowledge sync refused ${path} because its Git merge value is indistinguishable from the ${fields[2]} check-attr sentinel and ${key} can hide a conflict.`,
        );
      }
      if (configured.status !== 1 || configured.stderr.trim()) {
        return failure(
          "error",
          "candidate-merge-driver-inspection-failed",
          `knowledge sync could not inspect ${key}: ${errorText(configured)}`,
        );
      }
    }
  }
  return undefined;
}

function isManagedKnowledgePath(path: string): boolean {
  return (
    path === "wiki/schema.md" ||
    path === "wiki/index.md" ||
    path === "wiki/log.md" ||
    path === "wiki/issues.md" ||
    path.startsWith("wiki/pages/") ||
    path === "artifacts/knowledge-archive" ||
    path.startsWith("artifacts/knowledge-archive/")
  );
}

interface CommitFileResult {
  ok: true;
  content?: string;
}

interface ConflictFileResult {
  ok: true;
  content?: Buffer;
}

function readConflictIndexFile(
  candidateRoot: string,
  relPath: string,
  stage: 2 | 3,
  git: KnowledgeSyncGitRunner,
): ConflictFileResult | KnowledgeSyncFailure {
  const listed = git(["ls-files", "--stage", "-z", "--", relPath], { cwd: candidateRoot });
  if (listed.status !== 0) {
    return failure(
      "error",
      "candidate-source-inspection-failed",
      `knowledge sync could not inspect conflict stage ${stage} for ${relPath}: ${errorText(listed)}`,
    );
  }
  let stagePresent = false;
  for (const entry of listed.stdout.split("\0").filter(Boolean)) {
    const match = /^(\d+) [0-9a-f]+ (\d+)\t([\s\S]+)$/u.exec(entry);
    if (!match) {
      return failure(
        "error",
        "candidate-source-inspection-failed",
        `knowledge sync could not parse conflict stages for ${relPath}.`,
      );
    }
    if (match[2] === String(stage) && match[3] === relPath) {
      stagePresent = true;
    }
  }
  if (!stagePresent) {
    return { ok: true };
  }
  const shown = git(["show", `:${stage}:${relPath}`], { cwd: candidateRoot });
  if (shown.status !== 0) {
    return failure(
      "error",
      "candidate-source-read-failed",
      `knowledge sync could not read conflict stage ${stage} for ${relPath}: ${errorText(shown)}`,
    );
  }
  if (shown.stdoutBytes === undefined) {
    return failure(
      "error",
      "candidate-source-byte-output-unavailable",
      `knowledge sync could not read exact conflict bytes for ${relPath}; the configured Git runner did not provide raw output.`,
    );
  }
  return { ok: true, content: shown.stdoutBytes };
}

function readCommitFile(
  candidateRoot: string,
  commit: string,
  relPath: string,
  git: KnowledgeSyncGitRunner,
): CommitFileResult | KnowledgeSyncFailure {
  const listed = git(["ls-tree", "-z", commit, "--", relPath], { cwd: candidateRoot });
  if (listed.status !== 0) {
    return failure(
      "error",
      "candidate-source-inspection-failed",
      `knowledge sync could not inspect ${relPath} at ${commit}: ${errorText(listed)}`,
    );
  }
  if (!listed.stdout) {
    return { ok: true };
  }
  const shown = git(["show", `${commit}:${relPath}`], { cwd: candidateRoot });
  if (shown.status !== 0) {
    return failure(
      "error",
      "candidate-source-read-failed",
      `knowledge sync could not read ${relPath} at ${commit}: ${errorText(shown)}`,
    );
  }
  if (shown.stdoutBytes === undefined) {
    return failure(
      "error",
      "candidate-source-byte-output-unavailable",
      `knowledge sync could not read exact committed bytes for ${relPath}; the configured Git runner did not provide raw output.`,
    );
  }
  if (!isUtf8(shown.stdoutBytes)) {
    return failure(
      "rejected",
      "candidate-structural-log-invalid-encoding",
      `knowledge sync requires committed ${relPath} structural history to be valid UTF-8.`,
    );
  }
  return { ok: true, content: shown.stdoutBytes.toString("utf8") };
}

function splitStableLines(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized) {
    return [];
  }
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

function stableLineUnion(baseContent: string, sourceContents: readonly string[]): string[] {
  const baseLines = splitStableLines(baseContent);
  const baseCounts = new Map<string, number>();
  for (const line of baseLines) {
    baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1);
  }
  const union = [...baseLines];
  for (const sourceContent of sourceContents) {
    const sourceLines = splitStableLines(sourceContent);
    const sourceCounts = new Map<string, number>();
    for (const line of sourceLines) {
      const occurrence = (sourceCounts.get(line) ?? 0) + 1;
      sourceCounts.set(line, occurrence);
      if (occurrence > (baseCounts.get(line) ?? 0)) {
        union.push(line);
      }
    }
  }
  return union;
}

function stableThreeWayLineUnion(baseContent: string, localContent: string, remoteContent: string): string[] {
  return stableLineUnion(baseContent, [localContent, remoteContent]);
}

function lineMultisetContains(candidate: string, source: string): boolean {
  const candidateCounts = new Map<string, number>();
  for (const line of splitStableLines(candidate)) {
    candidateCounts.set(line, (candidateCounts.get(line) ?? 0) + 1);
  }
  const sourceCounts = new Map<string, number>();
  for (const line of splitStableLines(source)) {
    const count = (sourceCounts.get(line) ?? 0) + 1;
    sourceCounts.set(line, count);
    if (count > (candidateCounts.get(line) ?? 0)) {
      return false;
    }
  }
  return true;
}

function lineSequenceStartsWith(candidate: string, prefix: string): boolean {
  const candidateLines = splitStableLines(candidate);
  const prefixLines = splitStableLines(prefix);
  return prefixLines.every((line, index) => candidateLines[index] === line);
}

function readRequiredStructuralLog(
  candidateRoot: string,
  commit: string,
  git: KnowledgeSyncGitRunner,
): string | KnowledgeSyncFailure {
  const result = readCommitFile(candidateRoot, commit, "wiki/log.md", git);
  if (!result.ok) {
    return result;
  }
  if (result.content === undefined) {
    return failure(
      "rejected",
      "candidate-log-history-not-preserved",
      `knowledge sync refused structural history because wiki/log.md is missing at ${commit}.`,
    );
  }
  return result.content;
}

type HistoricalStructuralLog =
  | { kind: "pre-v2" }
  | { kind: "v2"; content: string };

function readHistoricalStructuralLog(
  candidateRoot: string,
  commit: string,
  git: KnowledgeSyncGitRunner,
): HistoricalStructuralLog | KnowledgeSyncFailure {
  const schema = readCommitFile(candidateRoot, commit, "wiki/schema.md", git);
  if (!schema.ok) {
    return schema;
  }
  const marker = schema.content === undefined
    ? undefined
    : parseKnowledgeV2SchemaMarker(schema.content);
  if (!marker) {
    return { kind: "pre-v2" };
  }
  const log = readRequiredStructuralLog(candidateRoot, commit, git);
  return typeof log === "string" ? { kind: "v2", content: log } : log;
}

function validateStructuralLogCommit(
  candidateRoot: string,
  commit: string,
  parents: readonly string[],
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const commitState = readHistoricalStructuralLog(candidateRoot, commit, git);
  if (!("kind" in commitState)) {
    return commitState;
  }
  if (commitState.kind === "pre-v2") {
    for (const parent of parents) {
      const parentState = readHistoricalStructuralLog(candidateRoot, parent, git);
      if (!("kind" in parentState)) {
        return parentState;
      }
      if (parentState.kind === "v2") {
        return failure(
          "rejected",
          "candidate-log-history-not-preserved",
          `knowledge sync refused commit ${commit} because it removed or invalidated the Knowledge v2 schema after structural history began.`,
        );
      }
    }
    return undefined;
  }
  const commitLog = commitState.content;
  if (parents.length === 0) {
    return failure(
      "rejected",
      "candidate-log-history-not-preserved",
      `knowledge sync refused unexpected root commit ${commit} in the linear synchronization range.`,
    );
  }
  if (parents.length === 1) {
    const parentState = readHistoricalStructuralLog(candidateRoot, parents[0], git);
    if (!("kind" in parentState)) {
      return parentState;
    }
    if (parentState.kind === "pre-v2") {
      return undefined;
    }
    return lineSequenceStartsWith(commitLog, parentState.content)
      ? undefined
      : failure(
        "rejected",
        "candidate-log-history-not-preserved",
        `knowledge sync refused commit ${commit} because it did not append to its parent structural log.`,
      );
  }

  const mergeBase = git(["merge-base", "--octopus", ...parents], { cwd: candidateRoot });
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    return failure(
      "error",
      "candidate-history-inspection-failed",
      `knowledge sync could not inspect the merge base for structural-log commit ${commit}: ${errorText(mergeBase)}`,
    );
  }
  const baseState = readHistoricalStructuralLog(candidateRoot, mergeBase.stdout.trim(), git);
  if (!("kind" in baseState)) {
    return baseState;
  }
  const parentLogs: string[] = [];
  for (const parent of parents) {
    const parentState = readHistoricalStructuralLog(candidateRoot, parent, git);
    if (!("kind" in parentState)) {
      return parentState;
    }
    if (parentState.kind === "v2") {
      parentLogs.push(parentState.content);
    }
  }
  if (parentLogs.length === 0) {
    return undefined;
  }
  const baseLog = baseState.kind === "v2" ? baseState.content : "";
  const expectedLines = stableLineUnion(baseLog, parentLogs);
  const expectedMergePrefix = expectedLines.length === 0 ? "" : `${expectedLines.join("\n")}\n`;
  return lineSequenceStartsWith(commitLog, expectedMergePrefix)
    ? undefined
    : failure(
      "rejected",
      "candidate-log-history-not-preserved",
      `knowledge sync refused merge commit ${commit} because its structural log is not the deterministic parent-history union.`,
    );
}

function validateStructuralLogRange(
  candidateRoot: string,
  ancestorCommit: string,
  candidateCommit: string,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const history = git(
    ["rev-list", "--topo-order", "--reverse", "--parents", `${ancestorCommit}..${candidateCommit}`],
    { cwd: candidateRoot },
  );
  if (history.status !== 0) {
    return failure(
      "error",
      "candidate-history-inspection-failed",
      `knowledge sync could not inspect candidate structural-log history: ${errorText(history)}`,
    );
  }
  for (const line of history.stdout.split("\n").filter(Boolean)) {
    const [commit, ...parents] = line.trim().split(/\s+/u);
    if (!commit) {
      return failure(
        "error",
        "candidate-history-inspection-failed",
        "knowledge sync received an invalid structural-log history record.",
      );
    }
    const invalid = validateStructuralLogCommit(candidateRoot, commit, parents, git);
    if (invalid) {
      return invalid;
    }
  }
  return undefined;
}

function validateLinearStructuralLogHistory(
  candidateRoot: string,
  tips: GitTips,
  classification: "ahead" | "behind",
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const ancestorCommit = classification === "ahead" ? tips.remote : tips.local;
  const candidateCommit = classification === "ahead" ? tips.local : tips.remote;
  return validateStructuralLogRange(candidateRoot, ancestorCommit, candidateCommit, git);
}

function validateDivergentStructuralLogHistories(
  candidateRoot: string,
  tips: GitTips,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const mergeBase = git(["merge-base", tips.local, tips.remote], { cwd: candidateRoot });
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    return failure(
      "error",
      "candidate-merge-base-unreadable",
      `knowledge sync could not read the merge base before validating structural-log history: ${errorText(mergeBase)}`,
    );
  }
  const base = mergeBase.stdout.trim();
  return (
    validateStructuralLogRange(candidateRoot, base, tips.local, git) ??
    validateStructuralLogRange(candidateRoot, base, tips.remote, git)
  );
}

function validateCandidateMergeState(
  candidateRoot: string,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const unstaged = git(["diff", "--quiet", "--"], { cwd: candidateRoot });
  if (unstaged.status !== 0) {
    return failure(
      "error",
      "candidate-unstaged-changes",
      "knowledge sync refused a candidate whose reconciled files were not fully staged.",
    );
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], { cwd: candidateRoot });
  if (untracked.status !== 0) {
    return failure(
      "error",
      "candidate-untracked-inspection-failed",
      `knowledge sync could not inspect candidate untracked files: ${errorText(untracked)}`,
    );
  }
  if (untracked.stdout) {
    return failure(
      "rejected",
      "candidate-untracked-files",
      "knowledge sync refused a merge candidate containing untracked files.",
    );
  }
  return undefined;
}

function mergeStructuralLogs(
  baseContent: string,
  localContent: string,
  remoteContent: string,
  tips: GitTips,
  unresolvedPageCount: number,
): string {
  const lines = stableThreeWayLineUnion(baseContent, localContent, remoteContent);
  const provenance = `- knowledge-sync merge local=${tips.local} remote=${tips.remote} unresolved-pages=${unresolvedPageCount}`;
  if (!lines.includes(provenance)) {
    lines.push(provenance);
  }
  return `${lines.join("\n")}\n`;
}

function unresolvedVariantSection(
  label: "Local" | "Remote",
  commit: string,
  content: Buffer | undefined,
): string {
  const lines = [`## ${label} committed variant`, "", `Source commit: \`${commit}\``, ""];
  if (content === undefined) {
    lines.push("_This commit has no page at this path; the variant is a committed deletion._", "");
  } else if (!isUtf8(content) || content.includes(0)) {
    const reason = isUtf8(content)
      ? "contains binary NUL bytes"
      : "is not valid UTF-8";
    lines.push(
      `_This committed variant ${reason}. Its exact bytes are encoded as base64 below._`,
      "",
      `<!-- BEGIN ${label.toUpperCase()} COMMITTED VARIANT ${commit} BASE64 -->`,
      "```base64",
      content.toString("base64"),
      "```",
      `<!-- END ${label.toUpperCase()} COMMITTED VARIANT ${commit} BASE64 -->`,
      "",
    );
  } else {
    const text = content.toString("utf8");
    lines.push(
      `<!-- BEGIN ${label.toUpperCase()} COMMITTED VARIANT ${commit} -->`,
      text.endsWith("\n") ? text.slice(0, -1) : text,
      `<!-- END ${label.toUpperCase()} COMMITTED VARIANT ${commit} -->`,
      "",
    );
  }
  return lines.join("\n");
}

function resolveManagedPageConflict(
  candidateRoot: string,
  relPath: string,
  tips: GitTips,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): KnowledgeSyncFailure | undefined {
  const managedPage = parseManagedKnowledgePagePath(relPath);
  if (isUpdateFailure(managedPage)) {
    return failure(
      "conflict",
      "unsupported-managed-conflict",
      `knowledge sync cannot safely reconcile unsupported managed page path ${relPath}.`,
      { conflictPaths: [relPath] },
    );
  }
  const local = readConflictIndexFile(candidateRoot, relPath, 2, git);
  if (!local.ok) {
    return local;
  }
  const remote = readConflictIndexFile(candidateRoot, relPath, 3, git);
  if (!remote.ok) {
    return remote;
  }
  if (local.content === undefined && remote.content === undefined) {
    return failure(
      "conflict",
      "managed-page-variants-missing",
      `knowledge sync could not recover either committed variant for ${relPath}.`,
      { conflictPaths: [relPath] },
    );
  }

  const absPath = join(candidateRoot, ...relPath.split("/"));
  const safePathProblem = assertSafeKnowledgeWorkspacePath(candidateRoot, absPath, fs);
  if (safePathProblem) {
    return candidateUpdateFailure(
      safePathProblem,
      "candidate-unsafe-managed-path",
      `knowledge sync cannot safely reconcile ${relPath}`,
    );
  }
  const slug = basename(relPath, ".md");
  const body = [
    "# Unresolved Knowledge Conflict",
    "",
    "> UNRESOLVED: Both committed variants are retained below with provenance. This page does not declare either variant correct.",
    "",
    unresolvedVariantSection("Local", tips.local, local.content),
    unresolvedVariantSection("Remote", tips.remote, remote.content),
  ].join("\n");
  const content = formatKnowledgePage(
    {
      name: `Unresolved conflict: ${slug}`,
      description: "Conflicting committed Knowledge variants retained for review; no winner was selected.",
      type: managedPage.type,
      confidence: "unresolved",
      revisit_if: `Resolve variants from local ${tips.local} and remote ${tips.remote}.`,
    },
    body,
  );
  fs.mkdirSync(dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf8");
  return undefined;
}

function reconcileDerivedKnowledgeState(
  candidateRoot: string,
  tips: GitTips,
  resolvedPagePaths: readonly string[],
  deps: KnowledgeSyncDeps,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): KnowledgeSyncFailure | undefined {
  const detectedLayout = (deps.resolveLayout ?? resolveKnowledgeLayout)(candidateRoot);
  const layout: ResolvedKnowledgeV2Layout | undefined = detectedLayout.kind === "v2"
    ? detectedLayout
    : detectedLayout.kind === "none" &&
        detectedLayout.reason === "v2-index-missing" &&
        detectedLayout.marker
      ? {
          kind: "v2",
          agentWorkspaceRoot: detectedLayout.agentWorkspaceRoot,
          candidatePaths: detectedLayout.candidatePaths,
          marker: detectedLayout.marker,
          paths: detectedLayout.candidatePaths.v2,
        }
      : undefined;
  if (!layout) {
    return failure(
      "rejected",
      "candidate-not-knowledge-v2",
      "knowledge sync refused a merged candidate that does not contain a valid Knowledge v2 layout.",
      { layoutKind: detectedLayout.kind },
    );
  }
  const pages = collectKnowledgePages(layout, fs);
  if (!Array.isArray(pages)) {
    return candidateUpdateFailure(
      pages,
      "candidate-page-invalid",
      "knowledge sync candidate page validation failed",
    );
  }
  const mergeBase = git(["merge-base", tips.local, tips.remote], { cwd: candidateRoot });
  if (mergeBase.status !== 0 || !mergeBase.stdout.trim()) {
    return failure(
      "error",
      "candidate-merge-base-unreadable",
      `knowledge sync could not read the merge base for structural-log reconciliation: ${errorText(mergeBase)}`,
    );
  }
  const baseLog = readCommitFile(candidateRoot, mergeBase.stdout.trim(), "wiki/log.md", git);
  if (!baseLog.ok) {
    return baseLog;
  }
  const localLog = readCommitFile(candidateRoot, tips.local, "wiki/log.md", git);
  if (!localLog.ok) {
    return localLog;
  }
  const remoteLog = readCommitFile(candidateRoot, tips.remote, "wiki/log.md", git);
  if (!remoteLog.ok) {
    return remoteLog;
  }
  const localLogContent = localLog.content ?? "";
  const remoteLogContent = remoteLog.content ?? "";
  const baseLogContent = baseLog.content ?? "";
  const mergedLog = mergeStructuralLogs(
    baseLogContent,
    localLogContent,
    remoteLogContent,
    tips,
    resolvedPagePaths.length,
  );
  if (
    !lineMultisetContains(mergedLog, baseLogContent) ||
    !lineMultisetContains(mergedLog, localLogContent) ||
    !lineMultisetContains(mergedLog, remoteLogContent)
  ) {
    return failure(
      "error",
      "candidate-log-history-not-preserved",
      "knowledge sync refused a candidate that did not preserve both structural-log histories.",
    );
  }

  for (const path of [layout.paths.indexPath, layout.paths.logPath]) {
    const safePathProblem = assertSafeKnowledgeWorkspacePath(candidateRoot, path, fs);
    if (safePathProblem) {
      return candidateUpdateFailure(
        safePathProblem,
        "candidate-unsafe-managed-path",
        "knowledge sync cannot safely regenerate derived Knowledge state",
      );
    }
  }
  fs.writeFileSync(layout.paths.indexPath, generateKnowledgeIndex(pages), "utf8");
  fs.writeFileSync(layout.paths.logPath, mergedLog, "utf8");

  const staged = git(
    ["add", "--", "wiki/index.md", "wiki/log.md", ...resolvedPagePaths],
    { cwd: candidateRoot },
  );
  if (staged.status !== 0) {
    return failure(
      "error",
      "candidate-stage-failed",
      `knowledge sync could not stage the reconciled candidate: ${errorText(staged)}`,
    );
  }
  const unresolved = unresolvedConflictPaths(candidateRoot, git);
  if (!Array.isArray(unresolved)) {
    return unresolved;
  }
  if (unresolved.length > 0) {
    return failure(
      "conflict",
      "candidate-unresolved-conflict",
      `knowledge sync candidate still has unresolved paths: ${unresolved.join(", ")}.`,
      { conflictPaths: unresolved },
    );
  }
  const mergeStateProblem = validateCandidateMergeState(candidateRoot, git);
  if (mergeStateProblem) {
    return mergeStateProblem;
  }
  const invalid = validateCandidateCorpus(layout, git, fs);
  return invalid ?? undefined;
}

function materializeTemporaryWorktree(
  candidateRoot: string,
  startCommit: string,
  tips: GitTips,
  classification: "behind" | "diverged",
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const commitsToInspect = classification === "diverged"
    ? [startCommit, tips.remote]
    : [startCommit];
  for (const commit of commitsToInspect) {
    const populated = git(["read-tree", "--reset", commit], { cwd: candidateRoot });
    if (populated.status !== 0) {
      return failure(
        "error",
        "candidate-index-create-failed",
        `knowledge sync could not prepare an isolated candidate index: ${errorText(populated)}`,
      );
    }
    const transformationProblem = validateManagedCheckinTransformations(candidateRoot, git, true);
    if (transformationProblem) {
      return transformationProblem;
    }
  }
  if (commitsToInspect.at(-1) !== startCommit) {
    const restored = git(["read-tree", "--reset", startCommit], { cwd: candidateRoot });
    if (restored.status !== 0) {
      return failure(
        "error",
        "candidate-index-create-failed",
        `knowledge sync could not restore its isolated candidate index: ${errorText(restored)}`,
      );
    }
  }
  const filterArgs = disabledConfiguredFilterArgs(candidateRoot, git);
  if (!Array.isArray(filterArgs)) {
    return filterArgs;
  }
  const materialized = git(
    [...filterArgs, ...DISABLE_GIT_HOOKS, "checkout-index", "--all", "--force"],
    { cwd: candidateRoot },
  );
  if (materialized.status !== 0) {
    return failure(
      "error",
      "candidate-worktree-materialization-failed",
      `knowledge sync could not materialize its validated candidate worktree: ${errorText(materialized)}`,
    );
  }
  return undefined;
}

function withTemporaryWorktree(
  workspaceRoot: string,
  startCommit: string,
  tips: GitTips,
  classification: "behind" | "diverged",
  deps: KnowledgeSyncDeps,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
  work: (candidateRoot: string) => AttemptResult,
): AttemptResult {
  const commonDir = gitCommonDir(workspaceRoot, git, fs);
  if (typeof commonDir !== "string") {
    return commonDir;
  }
  const existingWorktrees = listSyncTemporaryWorktrees(workspaceRoot, git, fs);
  if (!Array.isArray(existingWorktrees)) {
    return existingWorktrees;
  }
  const reusable = existingWorktrees.find(({ marker }) =>
    marker.startCommit === startCommit &&
    marker.localTip === tips.local &&
    marker.remoteTip === tips.remote &&
    marker.classification === classification
  );
  if (reusable) {
    const removed = git(["worktree", "remove", "--force", reusable.path], { cwd: workspaceRoot });
    if (removed.status !== 0) {
      return failure(
        "error",
        "candidate-worktree-reset-failed",
        `knowledge sync could not reset its retained candidate worktree: ${errorText(removed)}`,
      );
    }
    const added = git(
      [...DISABLE_GIT_HOOKS, "worktree", "add", "--detach", "--no-checkout", reusable.path, startCommit],
      { cwd: workspaceRoot },
    );
    if (added.status !== 0) {
      try {
        fs.rmSync(dirname(reusable.path), { recursive: true, force: true });
      } catch {
        // Git no longer owns the worktree; its temporary parent can be left for system cleanup.
      }
      return failure(
        "error",
        "candidate-worktree-create-failed",
        `knowledge sync could not recreate its isolated candidate worktree: ${errorText(added)}`,
      );
    }
    const materializationFailure = materializeTemporaryWorktree(
      reusable.path,
      startCommit,
      tips,
      classification,
      git,
    );
    if (materializationFailure) {
      return materializationFailure;
    }
    return work(reusable.path);
  }

  const base = deps.temporaryDirectory ?? tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const tempRoot = fs.mkdtempSync(join(base, "minime-knowledge-sync-"));
  const candidateRoot = join(tempRoot, "candidate");
  const markerPath = join(tempRoot, SYNC_WORKTREE_MARKER);
  const marker: SyncWorktreeMarker = {
    version: 2,
    repositoryGitCommonDir: commonDir,
    candidateRoot: normalize(resolve(candidateRoot)),
    startCommit,
    localTip: tips.local,
    remoteTip: tips.remote,
    classification,
  };
  const markerFailure = writeSyncWorktreeMarker(markerPath, marker, fs);
  if (markerFailure) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // The fresh temporary directory contains no registered worktree and is safe to leave for system cleanup.
    }
    return markerFailure;
  }
  const add = git(
    [...DISABLE_GIT_HOOKS, "worktree", "add", "--detach", "--no-checkout", candidateRoot, startCommit],
    { cwd: workspaceRoot },
  );
  if (add.status !== 0) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Nothing was registered with Git; an unused temporary directory is safe to leave for system cleanup.
    }
    return failure(
      "error",
      "candidate-worktree-create-failed",
      `knowledge sync could not create an isolated candidate worktree: ${errorText(add)}`,
    );
  }
  const materializationFailure = materializeTemporaryWorktree(
    candidateRoot,
    startCommit,
    tips,
    classification,
    git,
  );
  if (materializationFailure) {
    return materializationFailure;
  }
  return work(candidateRoot);
}

interface SyncWorktreeMarker {
  version: 2;
  repositoryGitCommonDir: string;
  candidateRoot: string;
  startCommit: string;
  localTip: string;
  remoteTip: string;
  classification: "behind" | "diverged";
}

interface SyncTemporaryWorktree {
  path: string;
  marker: SyncWorktreeMarker;
}

function writeSyncWorktreeMarker(
  markerPath: string,
  marker: SyncWorktreeMarker,
  fs: KnowledgeSyncFs,
): KnowledgeSyncFailure | undefined {
  const temporaryMarkerPath = `${markerPath}.tmp`;
  try {
    fs.writeFileSync(temporaryMarkerPath, `${JSON.stringify(marker)}\n`, "utf8");
    fs.renameSync(temporaryMarkerPath, markerPath);
    return undefined;
  } catch (error) {
    try {
      fs.unlinkSync(temporaryMarkerPath);
    } catch {
      // The previous complete marker remains authoritative when temporary replacement fails.
    }
    return failure(
      "error",
      "candidate-marker-create-failed",
      `knowledge sync could not mark its isolated candidate worktree: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function gitCommonDir(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): string | KnowledgeSyncFailure {
  const result = git(["rev-parse", "--git-common-dir"], { cwd: workspaceRoot });
  if (result.status !== 0 || !result.stdout.trim()) {
    return failure(
      "error",
      "git-common-dir-unreadable",
      `knowledge sync could not identify its repository for temporary-worktree ownership: ${errorText(result)}`,
    );
  }
  const rawPath = result.stdout.trim();
  return realOrResolved(isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath), fs);
}

function listSyncTemporaryWorktrees(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): SyncTemporaryWorktree[] | KnowledgeSyncFailure {
  const commonDir = gitCommonDir(workspaceRoot, git, fs);
  if (typeof commonDir !== "string") {
    return commonDir;
  }
  const listed = git(["worktree", "list", "--porcelain"], { cwd: workspaceRoot });
  if (listed.status !== 0) {
    return failure(
      "error",
      "candidate-worktree-list-failed",
      `knowledge sync could not inspect temporary worktrees: ${errorText(listed)}`,
    );
  }
  const candidates = listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter(
      (path) => basename(path) === "candidate" && basename(dirname(path)).startsWith("minime-knowledge-sync-"),
    );
  const owned: SyncTemporaryWorktree[] = [];
  for (const path of candidates) {
    try {
      const markerPath = join(dirname(path), SYNC_WORKTREE_MARKER);
      const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<SyncWorktreeMarker>;
      if (
        marker.version === 2 &&
        marker.repositoryGitCommonDir === commonDir &&
        typeof marker.candidateRoot === "string" &&
        typeof marker.startCommit === "string" &&
        typeof marker.localTip === "string" &&
        typeof marker.remoteTip === "string" &&
        (marker.classification === "behind" || marker.classification === "diverged") &&
        realOrResolved(marker.candidateRoot, fs) === realOrResolved(path, fs)
      ) {
        owned.push({ path, marker: marker as SyncWorktreeMarker });
      }
    } catch {
      // Ignore unowned or malformed lookalikes.
    }
  }
  return owned;
}

function removeSyncTemporaryWorktrees(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): KnowledgeSyncFailure | undefined {
  const worktrees = listSyncTemporaryWorktrees(workspaceRoot, git, fs);
  if (!Array.isArray(worktrees)) {
    return worktrees;
  }
  for (const { path } of worktrees) {
    const removed = git(["worktree", "remove", "--force", path], { cwd: workspaceRoot });
    if (removed.status !== 0) {
      return failure(
        "error",
        "candidate-worktree-remove-failed",
        `knowledge sync converged but could not remove temporary worktree ${path}: ${errorText(removed)}`,
      );
    }
    const tempRoot = dirname(path);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      return failure(
        "error",
        "candidate-directory-remove-failed",
        `knowledge sync converged but could not remove the temporary directory containing ${path}.`,
      );
    }
  }
  return undefined;
}

function prepareCandidate(
  workspaceRoot: string,
  tips: GitTips,
  classification: KnowledgeSyncClassification,
  deps: KnowledgeSyncDeps,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): AttemptResult {
  if (classification === "no-op" || classification === "ahead") {
    const invalid = validateCandidateLayout(workspaceRoot, deps, git, fs);
    if (invalid) {
      return invalid;
    }
    const logHistoryProblem = classification === "ahead"
      ? validateLinearStructuralLogHistory(workspaceRoot, tips, classification, git)
      : undefined;
    return logHistoryProblem ?? { ok: true, commit: tips.local, root: workspaceRoot };
  }

  if (classification === "behind") {
    return withTemporaryWorktree(workspaceRoot, tips.remote, tips, classification, deps, git, fs, (candidateRoot) => {
      const invalid = validateCandidateLayout(candidateRoot, deps, git, fs);
      if (invalid) {
        return invalid;
      }
      const logHistoryProblem = validateLinearStructuralLogHistory(candidateRoot, tips, classification, git);
      return logHistoryProblem ?? { ok: true, commit: tips.remote, root: candidateRoot };
    });
  }

  const divergentLogHistoryProblem = validateDivergentStructuralLogHistories(workspaceRoot, tips, git);
  if (divergentLogHistoryProblem) {
    return divergentLogHistoryProblem;
  }

  return withTemporaryWorktree(workspaceRoot, tips.local, tips, classification, deps, git, fs, (candidateRoot) => {
    const localTransformationProblem = validateManagedCheckinTransformations(candidateRoot, git);
    if (localTransformationProblem) {
      return localTransformationProblem;
    }
    const mergeDriverProblem = validateMergeDrivers(candidateRoot, tips, git);
    if (mergeDriverProblem) {
      return mergeDriverProblem;
    }
    const filterArgs = disabledConfiguredFilterArgs(candidateRoot, git);
    if (!Array.isArray(filterArgs)) {
      return filterArgs;
    }
    const merged = git(
      [
        ...filterArgs,
        ...DISABLE_GIT_HOOKS,
        "-c",
        "rerere.enabled=false",
        "merge",
        "--no-ff",
        "--no-commit",
        tips.remote,
      ],
      { cwd: candidateRoot },
    );
    const conflictPaths = unresolvedConflictPaths(candidateRoot, git);
    if (!Array.isArray(conflictPaths)) {
      return conflictPaths;
    }
    if (merged.status !== 0) {
      if (conflictPaths.length === 0) {
        return failure(
          "error",
          "candidate-merge-failed",
          `knowledge sync could not prepare the isolated merge candidate: ${errorText(merged)}`,
        );
      }
      const outsideKnowledge = conflictPaths.filter((path) => !isManagedKnowledgePath(path));
      if (outsideKnowledge.length > 0) {
        return failure(
          "conflict",
          "non-knowledge-conflict",
          `knowledge sync stopped because Git found conflicts outside managed Knowledge: ${outsideKnowledge.join(", ")}.`,
          { conflictPaths },
        );
      }
      const unsupportedKnowledge = conflictPaths.filter((path) => {
        if (path === "wiki/index.md" || path === "wiki/log.md") {
          return false;
        }
        if (!path.startsWith("wiki/pages/")) {
          return true;
        }
        return isUpdateFailure(parseManagedKnowledgePagePath(path));
      });
      if (unsupportedKnowledge.length > 0) {
        return failure(
          "conflict",
          "unsupported-managed-conflict",
          `knowledge sync stopped at unsupported managed control or archive conflicts: ${unsupportedKnowledge.join(", ")}.`,
          { conflictPaths },
        );
      }
    }

    const mergedTransformationProblem = validateManagedCheckinTransformations(candidateRoot, git);
    if (mergedTransformationProblem) {
      return mergedTransformationProblem;
    }

    const pageConflictPaths = conflictPaths.filter((path) => path.startsWith("wiki/pages/"));
    for (const relPath of pageConflictPaths) {
      const pageFailure = resolveManagedPageConflict(candidateRoot, relPath, tips, git, fs);
      if (pageFailure) {
        return pageFailure;
      }
    }
    const derivedFailure = reconcileDerivedKnowledgeState(
      candidateRoot,
      tips,
      pageConflictPaths,
      deps,
      git,
      fs,
    );
    if (derivedFailure) {
      return derivedFailure;
    }

    const committed = git(
      [
        ...DISABLE_GIT_HOOKS,
        "-c",
        "commit.gpgSign=false",
        "commit",
        "-m",
        `knowledge sync: merge ${tips.remote.slice(0, 12)} into ${tips.local.slice(0, 12)}`,
      ],
      { cwd: candidateRoot, env: FIXED_GIT_IDENTITY_ENV },
    );
    if (committed.status !== 0) {
      return failure(
        "error",
        "candidate-commit-failed",
        `knowledge sync could not commit the isolated merge candidate: ${errorText(committed)}`,
      );
    }
    const head = git(["rev-parse", "HEAD"], { cwd: candidateRoot });
    if (head.status !== 0) {
      return failure(
        "error",
        "candidate-head-unreadable",
        `knowledge sync could not read candidate HEAD: ${errorText(head)}`,
      );
    }
    const invalid = validateCandidateLayout(candidateRoot, deps, git, fs);
    return invalid ?? { ok: true, commit: head.stdout.trim(), root: candidateRoot };
  });
}

function fastForwardCanonical(
  workspaceRoot: string,
  commit: string,
  git: KnowledgeSyncGitRunner,
): KnowledgeSyncFailure | undefined {
  const current = git(["rev-parse", "HEAD"], { cwd: workspaceRoot });
  if (current.status !== 0) {
    return failure("error", "canonical-head-unreadable", `knowledge sync could not read canonical HEAD: ${errorText(current)}`);
  }
  if (current.stdout.trim() === commit) {
    return undefined;
  }
  const merged = git([...DISABLE_GIT_HOOKS, "merge", "--ff-only", "--no-overwrite-ignore", commit], {
    cwd: workspaceRoot,
  });
  if (merged.status !== 0) {
    return failure(
      "error",
      "canonical-fast-forward-failed",
      `knowledge sync could not fast-forward canonical main to the validated candidate: ${errorText(merged)}`,
    );
  }
  return undefined;
}

function convergeAttempt(
  workspaceRoot: string,
  tips: GitTips,
  classification: KnowledgeSyncClassification,
  deps: KnowledgeSyncDeps,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): AttemptResult {
  const candidate = prepareCandidate(workspaceRoot, tips, classification, deps, git, fs);
  if (!candidate.ok) {
    return candidate;
  }
  const canonicalStateFailure =
    validateMainBranch(workspaceRoot, git) ??
    validateNoGitOperationInProgress(workspaceRoot, git, fs) ??
    validateCleanWorktree(workspaceRoot, git) ??
    validateManagedWorktreeMaterialization(workspaceRoot, git);
  if (canonicalStateFailure) {
    return canonicalStateFailure;
  }
  const canonicalTransformationFailure = validateCanonicalCheckinTransformations(
    workspaceRoot,
    candidate.root,
    git,
  );
  if (canonicalTransformationFailure) {
    return canonicalTransformationFailure;
  }
  const fastForwardFailure = fastForwardCanonical(workspaceRoot, candidate.commit, git);
  if (fastForwardFailure) {
    return fastForwardFailure;
  }
  if (classification === "behind" || classification === "diverged") {
    const canonicalValidationFailure = validateCandidateLayout(workspaceRoot, deps, git, fs);
    if (canonicalValidationFailure) {
      return canonicalValidationFailure;
    }
  }
  return { ok: true, commit: candidate.commit, root: workspaceRoot };
}

function fetchOriginMain(workspaceRoot: string, git: KnowledgeSyncGitRunner): KnowledgeSyncFailure | undefined {
  const fetched = git(
    [
      ...DISABLE_GIT_HOOKS,
      "fetch",
      "--no-tags",
      "--recurse-submodules=no",
      "origin",
      "+refs/heads/main:refs/remotes/origin/main",
    ],
    { cwd: workspaceRoot },
  );
  if (fetched.status !== 0) {
    return failure("error", "fetch-failed", `knowledge sync could not fetch origin/main: ${errorText(fetched)}`);
  }
  return undefined;
}

function fetchAndReadTips(workspaceRoot: string, git: KnowledgeSyncGitRunner): GitTips | KnowledgeSyncFailure {
  const fetchFailure = fetchOriginMain(workspaceRoot, git);
  return fetchFailure ?? readTips(workspaceRoot, git);
}

function mapLockFailure(lockFailure: KnowledgeUpdateFailure): KnowledgeSyncFailure {
  return failure(
    lockFailure.status === "locked" ? "locked" : lockFailure.status,
    lockFailure.reason.replace(/^knowledge-update-/, "knowledge-sync-"),
    lockFailure.message.replaceAll("knowledge_update", "knowledge sync"),
    lockFailure.layoutKind ? { layoutKind: lockFailure.layoutKind } : {},
  );
}

export function executeKnowledgeSync(deps: KnowledgeSyncDeps = {}): KnowledgeSyncResponse {
  const workspaceRoot = workspaceRootFromDeps(deps);
  if (!workspaceRoot) {
    return failure(
      "unavailable",
      "agent-workspace-unset",
      `knowledge sync requires --workspace or ${MINIME_AGENT_WORKSPACE_ROOT_ENV}.`,
    );
  }

  const fs = { ...defaultFs, ...(deps.fs ?? {}) };
  const gitRunner = deps.git ?? defaultKnowledgeSyncGitRunner;
  const git: KnowledgeSyncGitRunner = (args, options) => gitRunner(args, {
    ...options,
    env: { ...(deps.env ?? {}), ...(options.env ?? {}) },
  });
  let lock: KnowledgeUpdateLockHandle | undefined;
  try {
    const initial = preflightBeforeLock(workspaceRoot, deps, git, fs);
    if ("ok" in initial) {
      return initial;
    }
    const acquired = acquireKnowledgeUpdateLock(initial, fs, {
      lockNow: deps.lockNow,
      staleLockMs: deps.staleLockMs,
      isProcessAlive: deps.isProcessAlive,
      getProcessIdentity: deps.getProcessIdentity,
    });
    if (isUpdateFailure(acquired)) {
      return mapLockFailure(acquired);
    }
    lock = acquired;

    const lockedPreflight = preflight(workspaceRoot, deps, git, fs);
    if ("ok" in lockedPreflight) {
      return lockedPreflight;
    }
    const canonicalMaterializationFailure = validateManagedWorktreeMaterialization(workspaceRoot, git);
    if (canonicalMaterializationFailure) {
      return canonicalMaterializationFailure;
    }

    let initialClassification: KnowledgeSyncClassification | undefined;
    for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
      const attempts = (attemptIndex + 1) as 1 | 2;
      const fetchedTips = fetchAndReadTips(workspaceRoot, git);
      if ("ok" in fetchedTips) {
        return { ...fetchedTips, attempts };
      }
      const classification = classifyTips(workspaceRoot, fetchedTips, git);
      if (typeof classification !== "string") {
        return { ...classification, attempts };
      }
      initialClassification ??= classification;
      if (classification !== "no-op") {
        const preserveFailure = preserveTips(workspaceRoot, fetchedTips, git);
        if (preserveFailure) {
          return { ...preserveFailure, attempts };
        }
      }

      const convergence = convergeAttempt(workspaceRoot, fetchedTips, classification, deps, git, fs);
      if (!convergence.ok) {
        return { ...convergence, attempts };
      }

      let verified: GitTips | KnowledgeSyncFailure | undefined;
      if (convergence.commit !== fetchedTips.remote) {
        const pushed = git(
          [
            ...DISABLE_GIT_HOOKS,
            "push",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "origin",
            `${convergence.commit}:refs/heads/main`,
          ],
          { cwd: workspaceRoot },
        );
        if (pushed.status !== 0) {
          const afterFailure = fetchAndReadTips(workspaceRoot, git);
          if ("ok" in afterFailure) {
            return { ...afterFailure, attempts };
          }
          const racedTipPreservationFailure = preserveTips(workspaceRoot, afterFailure, git);
          if (racedTipPreservationFailure) {
            return { ...racedTipPreservationFailure, attempts };
          }
          if (afterFailure.local === afterFailure.remote) {
            verified = afterFailure;
          } else if (afterFailure.remote !== fetchedTips.remote && attemptIndex + 1 < MAX_ATTEMPTS) {
            continue;
          } else {
            return failure(
              "error",
              afterFailure.remote !== fetchedTips.remote ? "push-race-exhausted" : "push-failed",
              afterFailure.remote !== fetchedTips.remote
                ? "knowledge sync stopped after one bounded push-race retry; recovery refs retain every observed tip."
                : `knowledge sync could not push validated main to origin/main: ${errorText(pushed)}`,
              { attempts },
            );
          }
        }
      }

      verified ??= fetchAndReadTips(workspaceRoot, git);
      if ("ok" in verified) {
        return { ...verified, attempts };
      }
      if (verified.local !== verified.remote) {
        const racedTipPreservationFailure = preserveTips(workspaceRoot, verified, git);
        if (racedTipPreservationFailure) {
          return { ...racedTipPreservationFailure, attempts };
        }
        if (attemptIndex + 1 < MAX_ATTEMPTS) {
          continue;
        }
        return failure(
          "error",
          "push-race-exhausted",
          "knowledge sync could not verify local/remote convergence after one bounded push-race retry; recovery refs were retained.",
          { attempts },
        );
      }

      const cleanFailure =
        validateNoGitOperationInProgress(workspaceRoot, git, fs) ??
        validateCleanWorktree(workspaceRoot, git) ??
        validateManagedWorktreeMaterialization(workspaceRoot, git);
      if (cleanFailure) {
        return { ...cleanFailure, attempts };
      }
      const worktreeCleanupFailure = removeSyncTemporaryWorktrees(workspaceRoot, git, fs);
      if (worktreeCleanupFailure) {
        return { ...worktreeCleanupFailure, attempts };
      }
      const cleanupFailure = removeReachableRecoveryRefs(workspaceRoot, verified.local, git);
      if (cleanupFailure) {
        return { ...cleanupFailure, attempts };
      }
      return {
        ok: true,
        status: "converged",
        layoutKind: "v2",
        branch: "main",
        remote: "origin",
        classification: initialClassification,
        commit: verified.local,
        attempts,
        lockPath: LOCK_RELPATH,
      };
    }

    return failure(
      "error",
      "push-race-exhausted",
      "knowledge sync exhausted its bounded reconciliation attempts; recovery refs were retained.",
      { attempts: 2 },
    );
  } catch (error) {
    return failure(
      "error",
      "knowledge-sync-failed",
      `knowledge sync failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    lock?.release();
  }
}

export function formatKnowledgeSyncResponse(response: KnowledgeSyncResponse): string {
  return JSON.stringify(response, null, 2);
}
