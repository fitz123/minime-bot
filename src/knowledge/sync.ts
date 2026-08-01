import { spawnSync } from "node:child_process";
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
import { basename, dirname, join, normalize, resolve } from "node:path";
import {
  resolveKnowledgeLayout,
  type ResolvedKnowledgeLayout,
  type ResolvedKnowledgeV2Layout,
} from "./layout.js";
import {
  acquireKnowledgeUpdateLock,
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
  stderr: string;
}

export interface KnowledgeSyncGitOptions {
  cwd: string;
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
}

interface GitTips {
  local: string;
  remote: string;
}

interface CandidateResult {
  ok: true;
  commit: string;
}

interface AttemptFailure {
  ok: false;
  failure: KnowledgeSyncFailure;
}

interface ConvergeAttemptSuccess {
  ok: true;
  commit: string;
}

type ConvergeAttemptResult = ConvergeAttemptSuccess | AttemptFailure;

const RECOVERY_REF_PREFIX = "refs/minime/knowledge-sync/recovery";
const LOCK_RELPATH = ".tmp/knowledge-update.lock" as const;
const MAX_ATTEMPTS = 2;

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
  const result = spawnSync("git", [...args], {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? (result.error ? String(result.error.message) : ""),
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
  return (result.stderr || result.stdout).trim() || `git exited with status ${result.status}`;
}

function isUpdateFailure(value: KnowledgeUpdateLockHandle | KnowledgeUpdateFailure): value is KnowledgeUpdateFailure {
  return "ok" in value && value.ok === false;
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
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", `:(exclude)${LOCK_RELPATH}`],
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

function preflight(
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
    validateCleanWorktree(workspaceRoot, git) ??
    layout
  );
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
    const result = git(["update-ref", ref, commit], { cwd: workspaceRoot });
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
    const deleted = git(["update-ref", "-d", entry.ref, entry.commit], { cwd: workspaceRoot });
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

function unresolvedConflictPaths(candidateRoot: string, git: KnowledgeSyncGitRunner): string[] {
  const result = git(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: candidateRoot });
  return result.status === 0 ? result.stdout.split("\0").filter(Boolean).sort() : [];
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

function withTemporaryWorktree(
  workspaceRoot: string,
  startCommit: string,
  deps: KnowledgeSyncDeps,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
  work: (candidateRoot: string) => CandidateResult | AttemptFailure,
): CandidateResult | AttemptFailure {
  const base = deps.temporaryDirectory ?? tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const tempRoot = fs.mkdtempSync(join(base, "minime-knowledge-sync-"));
  const candidateRoot = join(tempRoot, "candidate");
  const add = git(["worktree", "add", "--detach", candidateRoot, startCommit], { cwd: workspaceRoot });
  if (add.status !== 0) {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Nothing was registered with Git; an unused temporary directory is safe to leave for system cleanup.
    }
    return {
      ok: false,
      failure: failure(
        "error",
        "candidate-worktree-create-failed",
        `knowledge sync could not create an isolated candidate worktree: ${errorText(add)}`,
      ),
    };
  }
  return work(candidateRoot);
}

function listSyncTemporaryWorktrees(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
): string[] | KnowledgeSyncFailure {
  const listed = git(["worktree", "list", "--porcelain"], { cwd: workspaceRoot });
  if (listed.status !== 0) {
    return failure(
      "error",
      "candidate-worktree-list-failed",
      `knowledge sync could not inspect temporary worktrees: ${errorText(listed)}`,
    );
  }
  return listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .filter(
      (path) => basename(path) === "candidate" && basename(dirname(path)).startsWith("minime-knowledge-sync-"),
    );
}

function removeSyncTemporaryWorktrees(
  workspaceRoot: string,
  git: KnowledgeSyncGitRunner,
  fs: KnowledgeSyncFs,
): KnowledgeSyncFailure | undefined {
  const paths = listSyncTemporaryWorktrees(workspaceRoot, git);
  if (!Array.isArray(paths)) {
    return paths;
  }
  for (const path of paths) {
    const removed = git(["worktree", "remove", "--force", path], { cwd: workspaceRoot });
    if (removed.status !== 0) {
      return failure(
        "error",
        "candidate-worktree-remove-failed",
        `knowledge sync converged but could not remove temporary worktree ${path}: ${errorText(removed)}`,
      );
    }
    try {
      fs.rmSync(dirname(path), { recursive: true, force: true });
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
): CandidateResult | AttemptFailure {
  if (classification === "no-op" || classification === "ahead") {
    const invalid = validateCandidateLayout(workspaceRoot, deps, git);
    return invalid ? { ok: false, failure: invalid } : { ok: true, commit: tips.local };
  }

  if (classification === "behind") {
    return withTemporaryWorktree(workspaceRoot, tips.remote, deps, git, fs, (candidateRoot) => {
      const invalid = validateCandidateLayout(candidateRoot, deps, git);
      return invalid ? { ok: false, failure: invalid } : { ok: true, commit: tips.remote };
    });
  }

  return withTemporaryWorktree(workspaceRoot, tips.local, deps, git, fs, (candidateRoot) => {
    const merged = git(["merge", "--no-ff", "--no-commit", tips.remote], { cwd: candidateRoot });
    if (merged.status !== 0) {
      const conflictPaths = unresolvedConflictPaths(candidateRoot, git);
      const outsideKnowledge = conflictPaths.filter((path) => !isManagedKnowledgePath(path));
      const nonKnowledge = outsideKnowledge.length > 0;
      return {
        ok: false,
        failure: failure(
          "conflict",
          nonKnowledge ? "non-knowledge-conflict" : "managed-knowledge-conflict",
          nonKnowledge
            ? `knowledge sync stopped because Git found conflicts outside managed Knowledge: ${outsideKnowledge.join(", ")}.`
            : `knowledge sync cannot yet reconcile managed Knowledge conflicts: ${conflictPaths.join(", ") || errorText(merged)}.`,
          { conflictPaths },
        ),
      };
    }

    const committed = git(
      [
        "-c",
        "commit.gpgSign=false",
        "-c",
        "user.name=minime-bot",
        "-c",
        "user.email=minime-bot@users.noreply.github.com",
        "commit",
        "-m",
        `knowledge sync: merge ${tips.remote.slice(0, 12)} into ${tips.local.slice(0, 12)}`,
      ],
      { cwd: candidateRoot },
    );
    if (committed.status !== 0) {
      return {
        ok: false,
        failure: failure(
          "error",
          "candidate-commit-failed",
          `knowledge sync could not commit the isolated merge candidate: ${errorText(committed)}`,
        ),
      };
    }
    const head = git(["rev-parse", "HEAD"], { cwd: candidateRoot });
    if (head.status !== 0) {
      return {
        ok: false,
        failure: failure("error", "candidate-head-unreadable", `knowledge sync could not read candidate HEAD: ${errorText(head)}`),
      };
    }
    const invalid = validateCandidateLayout(candidateRoot, deps, git);
    return invalid ? { ok: false, failure: invalid } : { ok: true, commit: head.stdout.trim() };
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
  const merged = git(["merge", "--ff-only", commit], { cwd: workspaceRoot });
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
): ConvergeAttemptResult {
  const candidate = prepareCandidate(workspaceRoot, tips, classification, deps, git, fs);
  if (!candidate.ok) {
    return candidate;
  }
  const fastForwardFailure = fastForwardCanonical(workspaceRoot, candidate.commit, git);
  if (fastForwardFailure) {
    return { ok: false, failure: fastForwardFailure };
  }
  return { ok: true, commit: candidate.commit };
}

function fetchOriginMain(workspaceRoot: string, git: KnowledgeSyncGitRunner): KnowledgeSyncFailure | undefined {
  const fetched = git(["fetch", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], {
    cwd: workspaceRoot,
  });
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
  const git = deps.git ?? defaultKnowledgeSyncGitRunner;
  let lock: KnowledgeUpdateLockHandle | undefined;
  try {
    const initial = preflight(workspaceRoot, deps, git, fs);
    if ("ok" in initial) {
      return initial;
    }
    const acquired = acquireKnowledgeUpdateLock(initial, fs, {
      lockNow: deps.lockNow,
      staleLockMs: deps.staleLockMs,
    });
    if (isUpdateFailure(acquired)) {
      return mapLockFailure(acquired);
    }
    lock = acquired;

    const lockedPreflight = preflight(workspaceRoot, deps, git, fs);
    if ("ok" in lockedPreflight) {
      return lockedPreflight;
    }

    let initialClassification: KnowledgeSyncClassification | undefined;
    for (let attemptIndex = 0; attemptIndex < MAX_ATTEMPTS; attemptIndex += 1) {
      const attempts = (attemptIndex + 1) as 1 | 2;
      const fetchedTips = fetchAndReadTips(workspaceRoot, git);
      if ("ok" in fetchedTips) {
        return { ...fetchedTips, attempts };
      }
      const preserveFailure = preserveTips(workspaceRoot, fetchedTips, git);
      if (preserveFailure) {
        return { ...preserveFailure, attempts };
      }
      const classification = classifyTips(workspaceRoot, fetchedTips, git);
      if (typeof classification !== "string") {
        return { ...classification, attempts };
      }
      initialClassification ??= classification;

      const convergence = convergeAttempt(workspaceRoot, fetchedTips, classification, deps, git, fs);
      if (!convergence.ok) {
        return { ...convergence.failure, attempts };
      }

      const pushed = git(["push", "origin", `${convergence.commit}:refs/heads/main`], { cwd: workspaceRoot });
      if (pushed.status !== 0) {
        const afterFailure = fetchAndReadTips(workspaceRoot, git);
        if ("ok" in afterFailure) {
          return { ...afterFailure, attempts };
        }
        const racedTipPreservationFailure = preserveTips(workspaceRoot, afterFailure, git);
        if (racedTipPreservationFailure) {
          return { ...racedTipPreservationFailure, attempts };
        }
        if (afterFailure.remote !== fetchedTips.remote && attemptIndex + 1 < MAX_ATTEMPTS) {
          continue;
        }
        return failure(
          "error",
          afterFailure.remote !== fetchedTips.remote ? "push-race-exhausted" : "push-failed",
          afterFailure.remote !== fetchedTips.remote
            ? "knowledge sync stopped after one bounded push-race retry; recovery refs retain every observed tip."
            : `knowledge sync could not push validated main to origin/main: ${errorText(pushed)}`,
          { attempts },
        );
      }

      const verified = fetchAndReadTips(workspaceRoot, git);
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

      const cleanFailure = validateCleanWorktree(workspaceRoot, git);
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
