import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import { formatKnowledgePage, generateKnowledgeIndex } from "../knowledge/update.js";
import {
  defaultKnowledgeSyncGitRunner,
  executeKnowledgeSync as executeKnowledgeSyncWithAmbientConfig,
  type KnowledgeSyncDeps,
  type KnowledgeSyncResponse,
} from "../knowledge/sync.js";

interface SyncFixture {
  root: string;
  workspace: string;
  remote: string;
}

const fixtures: string[] = [];
const ISOLATED_GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function executeKnowledgeSync(deps: KnowledgeSyncDeps = {}): KnowledgeSyncResponse {
  return executeKnowledgeSyncWithAmbientConfig({
    ...deps,
    env: { ...ISOLATED_GIT_ENV, ...(deps.env ?? {}) },
  });
}

function filesystemIsCaseInsensitive(): boolean {
  const root = mkdtempSync(join(tmpdir(), "minime-knowledge-sync-case-check-"));
  try {
    writeFileSync(join(root, "Case"), "case probe\n", "utf8");
    return existsSync(join(root, "case"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const CASE_INSENSITIVE_FILESYSTEM = filesystemIsCaseInsensitive();

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...ISOLATED_GIT_ENV },
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`,
  );
  return result.stdout.trim();
}

function gitCommand(args: readonly string[]): string | undefined {
  let index = 0;
  while (args[index] === "-c") {
    index += 2;
  }
  return args[index];
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const path = join(root, ...relPath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

function configureIdentity(workspace: string): void {
  git(workspace, ["config", "user.name", "Knowledge Sync Test"]);
  git(workspace, ["config", "user.email", "knowledge-sync-test@users.noreply.github.com"]);
  git(workspace, ["config", "commit.gpgSign", "false"]);
}

function commitFiles(workspace: string, message: string, files: Record<string, string>): string {
  writeFiles(workspace, files);
  git(workspace, ["add", ...Object.keys(files)]);
  git(workspace, ["commit", "-m", message]);
  return git(workspace, ["rev-parse", "HEAD"]);
}

function page(
  name: string,
  description: string,
  type: "user" | "project" | "feedback" | "reference",
  body: string,
): string {
  return formatKnowledgePage({ name, description, type }, body);
}

function createSyncFixture(): SyncFixture {
  const root = mkdtempSync(join(tmpdir(), "minime-knowledge-sync-test-"));
  fixtures.push(root);
  const workspace = join(root, "workspace");
  const remote = join(root, "remote.git");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(remote, { recursive: true });
  git(remote, ["init", "--bare", "--initial-branch=main"]);
  git(workspace, ["init", "--initial-branch=main"]);
  configureIdentity(workspace);
  git(workspace, ["config", "core.autocrlf", "false"]);
  commitFiles(workspace, "initial Knowledge v2 workspace", {
    ".gitignore": ".tmp/\n",
    "README.md": "# Agent workspace\n\nShared baseline.\n",
    "wiki/schema.md": generateKnowledgeV2Schema(),
    "wiki/index.md": generateKnowledgeIndex([]),
    "wiki/log.md": "# Knowledge Structural Log\n",
  });
  git(workspace, ["remote", "add", "origin", remote]);
  git(workspace, ["push", "-u", "origin", "main"]);
  return { root, workspace, remote };
}

function cloneRemote(fixture: SyncFixture, name: string): string {
  const clone = join(fixture.root, name);
  git(fixture.root, ["clone", fixture.remote, clone]);
  configureIdentity(clone);
  return clone;
}

function remoteHead(fixture: SyncFixture): string {
  return git(fixture.remote, ["rev-parse", "refs/heads/main"]);
}

function localHead(fixture: SyncFixture): string {
  return git(fixture.workspace, ["rev-parse", "refs/heads/main"]);
}

function recoveryRefs(fixture: SyncFixture): string[] {
  const output = git(fixture.workspace, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/minime/knowledge-sync/recovery",
  ]);
  return output ? output.split("\n").sort() : [];
}

function worktreePaths(fixture: SyncFixture): string[] {
  return git(fixture.workspace, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
}

function assertSyncOk(response: KnowledgeSyncResponse): asserts response is Extract<KnowledgeSyncResponse, { ok: true }> {
  assert.equal(response.ok, true, JSON.stringify(response));
}

function assertAncestor(fixture: SyncFixture, ancestor: string, descendant: string): void {
  git(fixture.workspace, ["merge-base", "--is-ancestor", ancestor, descendant]);
}

describe("knowledge sync Git convergence", () => {
  it("is a verified no-op when local and remote main already match", () => {
    const fixture = createSyncFixture();
    const before = localHead(fixture);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    assert.equal(response.classification, "no-op");
    assert.equal(response.attempts, 1);
    assert.equal(response.commit, before);
    assert.equal(localHead(fixture), before);
    assert.equal(remoteHead(fixture), before);
    assert.deepEqual(recoveryRefs(fixture), []);
    assert.deepEqual(worktreePaths(fixture), [realpathSync(fixture.workspace)]);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  });

  it("does not repeat full corpus validation when canonical HEAD is unchanged", () => {
    const fixture = createSyncFixture();
    let attributeChecks = 0;

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (gitCommand(args) === "check-attr") {
          attributeChecks += 1;
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assertSyncOk(response);
    assert.equal(response.classification, "no-op");
    assert.equal(attributeChecks, 3);
  });

  it("rejects a no-op corpus with no committed structural log", () => {
    const fixture = createSyncFixture();
    git(fixture.workspace, ["rm", "wiki/log.md"]);
    git(fixture.workspace, ["commit", "-m", "remove the structural log"]);
    git(fixture.workspace, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-structural-log-missing");
    assert.equal(localHead(fixture), remoteHead(fixture));
  });

  it("rejects stale committed indexes in no-op, ahead, and behind histories", () => {
    for (const classification of ["no-op", "ahead", "behind"] as const) {
      const fixture = createSyncFixture();
      const files = {
        "wiki/pages/reference/stale-index.md": page(
          "Stale index",
          "A committed page omitted from the committed index.",
          "reference",
          "This page must be indexed before synchronization.\n",
        ),
        "wiki/index.md": "# Stale committed index\n",
      };
      if (classification === "behind") {
        const peer = cloneRemote(fixture, "peer-stale-index");
        commitFiles(peer, "commit stale remote index", files);
        git(peer, ["push", "origin", "main"]);
      } else {
        commitFiles(fixture.workspace, "commit stale local index", files);
        if (classification === "no-op") {
          git(fixture.workspace, ["push", "origin", "main"]);
        }
      }
      const localTip = localHead(fixture);
      const remoteTip = remoteHead(fixture);

      const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

      assert.equal(response.ok, false, classification);
      assert.equal(response.reason, "candidate-index-page-set-mismatch", classification);
      assert.equal(localHead(fixture), localTip, classification);
      assert.equal(remoteHead(fixture), remoteTip, classification);
    }
  });

  it("rejects hidden managed pages before an ahead commit can be pushed", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/reference/hidden.md";
    const malformedPage = "---\nname: [invalid yaml\n---\n\nHidden malformed bytes.\n";
    const localTip = commitFiles(fixture.workspace, "commit a hidden malformed page", {
      [relPath]: malformedPage,
    });
    const remoteTip = remoteHead(fixture);
    git(fixture.workspace, ["update-index", "--skip-worktree", relPath]);
    rmSync(join(fixture.workspace, ...relPath.split("/")));
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-hidden-managed-entry");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
  });

  it("fast-forwards a behind canonical main only after validating the fetched tree", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-behind");
    const remoteCommit = commitFiles(peer, "remote diary entry", {
      "diary/2026-08-01.md": "# Remote diary\n\nFetched history.\n",
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    assert.equal(response.classification, "behind");
    assert.equal(response.commit, remoteCommit);
    assert.equal(localHead(fixture), remoteCommit);
    assert.equal(remoteHead(fixture), remoteCommit);
    assert.match(readFileSync(join(fixture.workspace, "diary/2026-08-01.md"), "utf8"), /Fetched history/);
    assert.deepEqual(recoveryRefs(fixture), []);
  });

  it("does not fast-forward behind main when a canonical managed file is hidden from the worktree", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-behind-hidden-canonical");
    const localTip = localHead(fixture);
    const remoteTip = commitFiles(peer, "remote change behind hidden canonical state", {
      "diary/remote-hidden-canonical.md": "# Remote history\n",
    });
    git(peer, ["push", "origin", "main"]);
    git(fixture.workspace, ["update-index", "--skip-worktree", "wiki/log.md"]);
    rmSync(join(fixture.workspace, "wiki/log.md"));
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-hidden-managed-entry");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assert.equal(existsSync(join(fixture.workspace, "diary/remote-hidden-canonical.md")), false);
  });

  it("preserves ignored canonical Knowledge bytes that collide with a fetched tracked page", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/reference/ignored-collision.md";
    const localIgnoredPage = page(
      "Local ignored collision",
      "Ignored local bytes must survive a rejected sync.",
      "reference",
      "Local ignored Knowledge bytes.\n",
    );
    const remotePage = page(
      "Remote tracked collision",
      "A remote tracked page collides with ignored local bytes.",
      "reference",
      "Remote committed Knowledge bytes.\n",
    );
    const localTip = commitFiles(fixture.workspace, "ignore a future managed page", {
      ".gitignore": `.tmp/\n${relPath}\n`,
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-ignored-collision");
    writeFiles(peer, {
      [relPath]: remotePage,
      "wiki/index.md": generateKnowledgeIndex([
        {
          absPath: join(peer, ...relPath.split("/")),
          relPath,
          linkPath: "pages/reference/ignored-collision.md",
          frontmatter: {
            name: "Remote tracked collision",
            description: "A remote tracked page collides with ignored local bytes.",
            type: "reference",
          },
        },
      ]),
    });
    git(peer, ["add", "-f", relPath]);
    git(peer, ["add", "wiki/index.md"]);
    git(peer, ["commit", "-m", "track the colliding remote page"]);
    git(peer, ["push", "origin", "main"]);
    const remoteTip = remoteHead(fixture);
    writeFiles(fixture.workspace, { [relPath]: localIgnoredPage });
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-untracked-managed-files");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assert.equal(readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8"), localIgnoredPage);
  });

  it("rechecks canonical managed materialization immediately before fast-forward", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/reference/late-ignored.md";
    const ignoredPage = page(
      "Late ignored page",
      "Ignored bytes introduced during candidate preparation must remain local.",
      "reference",
      "Late ignored Knowledge bytes.\n",
    );
    const localTip = commitFiles(fixture.workspace, "ignore a late managed page", {
      ".gitignore": `.tmp/\n${relPath}\n`,
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-late-ignored");
    const remoteTip = commitFiles(peer, "remote history during canonical recheck", {
      "diary/remote-late-ignored.md": "# Remote history\n",
    });
    git(peer, ["push", "origin", "main"]);
    let canonicalIgnoredChecks = 0;

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        const result = defaultKnowledgeSyncGitRunner(args, options);
        if (
          options.cwd === fixture.workspace &&
          gitCommand(args) === "ls-files" &&
          args.includes("--ignored") &&
          canonicalIgnoredChecks++ === 0
        ) {
          writeFiles(fixture.workspace, { [relPath]: ignoredPage });
        }
        return result;
      },
    });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-untracked-managed-files");
    assert.equal(canonicalIgnoredChecks, 2);
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assert.equal(readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8"), ignoredPage);
  });

  it(
    "rejects tracked page aliases that cannot be uniquely materialized",
    { skip: !CASE_INSENSITIVE_FILESYSTEM },
    () => {
      const fixture = createSyncFixture();
      const upperPath = "wiki/pages/reference/Case-Alias.md";
      const lowerPath = "wiki/pages/reference/case-alias.md";
      const aliasedPage = page(
        "Case alias",
        "Two tracked paths must not alias one materialized page.",
        "reference",
        "Aliased committed Knowledge bytes.\n",
      );
      writeFiles(fixture.workspace, { [upperPath]: aliasedPage });
      const blob = git(fixture.workspace, ["hash-object", "-w", upperPath]);
      git(fixture.workspace, ["update-index", "--add", "--cacheinfo", `100644,${blob},${upperPath}`]);
      git(fixture.workspace, ["update-index", "--add", "--cacheinfo", `100644,${blob},${lowerPath}`]);
      writeFiles(fixture.workspace, {
        "wiki/index.md": generateKnowledgeIndex([
          {
            absPath: join(fixture.workspace, ...upperPath.split("/")),
            relPath: upperPath,
            linkPath: "pages/reference/Case-Alias.md",
            frontmatter: {
              name: "Case alias",
              description: "Two tracked paths must not alias one materialized page.",
              type: "reference",
            },
          },
        ]),
      });
      git(fixture.workspace, ["add", "wiki/index.md"]);
      git(fixture.workspace, ["commit", "-m", "track colliding case aliases"]);
      git(fixture.workspace, ["push", "origin", "main"]);
      const committedTip = localHead(fixture);
      assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

      const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

      assert.equal(response.ok, false);
      assert.equal(response.reason, "candidate-active-page-set-mismatch");
      assert.equal(localHead(fixture), committedTip);
      assert.equal(remoteHead(fixture), committedTip);
    },
  );

  it("rejects a behind commit that truncates structural-log history", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-truncated-log");
    const localTip = localHead(fixture);
    const remoteTip = commitFiles(peer, "truncate structural history", {
      "wiki/log.md": "# Replaced Structural Log\n",
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-log-history-not-preserved");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assert.equal(readFileSync(join(fixture.workspace, "wiki/log.md"), "utf8"), "# Knowledge Structural Log\n");
  });

  it("rejects structural-log entries appended and then removed from linear history", () => {
    for (const classification of ["ahead", "behind"] as const) {
      const fixture = createSyncFixture();
      const originalLog = readFileSync(join(fixture.workspace, "wiki/log.md"), "utf8");
      const branch = classification === "ahead"
        ? fixture.workspace
        : cloneRemote(fixture, `peer-intermediate-log-${classification}`);
      commitFiles(branch, "append intermediate structural history", {
        "wiki/log.md": `${originalLog}- intermediate structural entry\n`,
      });
      commitFiles(branch, "remove intermediate structural history", {
        "wiki/log.md": originalLog,
      });
      if (classification === "behind") {
        git(branch, ["push", "origin", "main"]);
      }

      const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

      assert.equal(response.ok, false);
      assert.equal(response.reason, "candidate-log-history-not-preserved");
    }
  });

  it("rejects a divergent branch that appended and then removed structural history", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-intermediate-divergent-log");
    const originalLog = readFileSync(join(fixture.workspace, "wiki/log.md"), "utf8");
    commitFiles(fixture.workspace, "append local intermediate structural history", {
      "wiki/log.md": `${originalLog}- local intermediate structural entry\n`,
    });
    const localTip = commitFiles(fixture.workspace, "remove local intermediate structural history", {
      "wiki/log.md": originalLog,
    });
    const remoteTip = commitFiles(peer, "create remote divergence", {
      "diary/remote-divergence.md": "# Remote divergence\n",
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-log-history-not-preserved");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
  });

  it("does not push when the validated commit already equals fetched origin/main", () => {
    for (const scenario of ["no-op", "behind"] as const) {
      const fixture = createSyncFixture();
      let expectedCommit = localHead(fixture);
      if (scenario === "behind") {
        const peer = cloneRemote(fixture, "peer-fetch-only");
        expectedCommit = commitFiles(peer, "remote fetch-only entry", {
          "diary/fetch-only.md": "# Remote fetch-only entry\n",
        });
        git(peer, ["push", "origin", "main"]);
      }
      let pushAttempts = 0;

      const response = executeKnowledgeSync({
        agentWorkspaceRoot: fixture.workspace,
        git: (args, options) => {
          if (gitCommand(args) === "push") {
            pushAttempts += 1;
            return { status: 1, stdout: "", stderr: "pushes are not permitted" };
          }
          return defaultKnowledgeSyncGitRunner(args, options);
        },
      });

      assertSyncOk(response);
      assert.equal(response.classification, scenario);
      assert.equal(response.commit, expectedCommit);
      assert.equal(pushAttempts, 0);
      assert.equal(localHead(fixture), expectedCommit);
      assert.equal(remoteHead(fixture), expectedCommit);
    }
  });

  it("pushes an ahead canonical main and verifies origin/main", () => {
    const fixture = createSyncFixture();
    const localCommit = commitFiles(fixture.workspace, "local diary entry", {
      "diary/2026-08-02.md": "# Local diary\n\nCommitted locally.\n",
    });

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    assert.equal(response.classification, "ahead");
    assert.equal(response.commit, localCommit);
    assert.equal(remoteHead(fixture), localCommit);
    assert.deepEqual(recoveryRefs(fixture), []);
  });

  it("does not publish annotated tags when push.followTags is enabled", () => {
    const fixture = createSyncFixture();
    commitFiles(fixture.workspace, "local tagged diary entry", {
      "diary/tagged.md": "# Tagged local diary\n",
    });
    git(fixture.workspace, ["tag", "-a", "private-local-tag", "-m", "local-only tag"]);
    git(fixture.workspace, ["config", "push.followTags", "true"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    assert.equal(
      git(fixture.remote, ["for-each-ref", "--format=%(refname)", "refs/tags"]),
      "",
    );
  });

  it("disables recursive submodule behavior for transaction fetches and pushes", () => {
    const fixture = createSyncFixture();
    commitFiles(fixture.workspace, "local submodule-safe diary entry", {
      "diary/submodule-safe.md": "# Submodule-safe local diary\n",
    });
    let fetchArgs: readonly string[] | undefined;
    let pushArgs: readonly string[] | undefined;

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (gitCommand(args) === "fetch") {
          fetchArgs = args;
        } else if (gitCommand(args) === "push") {
          pushArgs = args;
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assertSyncOk(response);
    assert.ok(fetchArgs?.includes("--recurse-submodules=no"));
    assert.ok(pushArgs?.includes("--recurse-submodules=no"));
  });

  it("does not push an ahead commit that truncates structural-log history", () => {
    const fixture = createSyncFixture();
    const remoteTip = remoteHead(fixture);
    const localTip = commitFiles(fixture.workspace, "truncate local structural history", {
      "wiki/log.md": "# Replaced Local Structural Log\n",
    });

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-log-history-not-preserved");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
  });

  it("rejects prepended structural-log entries in linear histories", () => {
    for (const classification of ["ahead", "behind"] as const) {
      const fixture = createSyncFixture();
      const originalLog = readFileSync(join(fixture.workspace, "wiki/log.md"), "utf8");
      const rewrittenLog = `- 2026-08-01T00:00:00.000Z update wiki/pages/project/prepended.md\n${originalLog}`;
      if (classification === "ahead") {
        commitFiles(fixture.workspace, "prepend local structural history", {
          "wiki/log.md": rewrittenLog,
        });
      } else {
        const peer = cloneRemote(fixture, "peer-prepended-log");
        commitFiles(peer, "prepend remote structural history", {
          "wiki/log.md": rewrittenLog,
        });
        git(peer, ["push", "origin", "main"]);
      }

      const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

      assert.equal(response.ok, false);
      assert.equal(response.reason, "candidate-log-history-not-preserved");
    }
  });

  it("rejects reordered structural history after an unrelated merge commit", () => {
    const fixture = createSyncFixture();
    const originalLog = readFileSync(join(fixture.workspace, "wiki/log.md"), "utf8");
    git(fixture.workspace, ["checkout", "-b", "unrelated-side"]);
    commitFiles(fixture.workspace, "side history without Knowledge changes", {
      "diary/unrelated-side.md": "# Unrelated side history\n",
    });
    git(fixture.workspace, ["checkout", "main"]);
    commitFiles(fixture.workspace, "main history without Knowledge changes", {
      "diary/unrelated-main.md": "# Unrelated main history\n",
    });
    git(fixture.workspace, ["merge", "--no-ff", "unrelated-side", "-m", "merge unrelated side history"]);
    const rewrittenLog = `- prepended after merge\n${originalLog}`;
    const localTip = commitFiles(fixture.workspace, "reorder structural history after merge", {
      "wiki/log.md": rewrittenLog,
    });
    const remoteTip = remoteHead(fixture);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-log-history-not-preserved");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
  });

  it("reconciles committed structural logs larger than spawnSync's default output buffer", () => {
    const fixture = createSyncFixture();
    const largeLog = `# Knowledge Structural Log\n\n- ${"x".repeat(1_200_000)}\n`;
    commitFiles(fixture.workspace, "grow structural history beyond one MiB", {
      "wiki/log.md": largeLog,
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-large-log");
    commitFiles(fixture.workspace, "local large-log divergence", {
      "diary/local-large-log.md": "# Local large-log branch\n",
    });
    commitFiles(peer, "remote large-log divergence", {
      "diary/remote-large-log.md": "# Remote large-log branch\n",
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    assert.equal(response.classification, "diverged");
    assert.ok(readFileSync(join(fixture.workspace, "wiki/log.md"), "utf8").startsWith(largeLog));
  });

  it("fails privately when committed Git output exceeds the 64 MiB synchronization bound", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-output-overflow");
    const localTip = localHead(fixture);
    const privateMarker = "PRIVATE-KNOWLEDGE-OUTPUT-OVERFLOW-MARKER";
    const oversizedLog = `# Knowledge Structural Log\n\n- ${privateMarker}${"x".repeat(64 * 1024 * 1024)}\n`;
    const remoteTip = commitFiles(peer, "oversized committed structural history", {
      "wiki/log.md": oversizedLog,
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-source-read-failed");
    assert.match(response.message, /output exceeded the 64 MiB knowledge sync limit/);
    assert.equal(response.message.includes(privateMarker), false);
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
  });

  it("rejects invalid UTF-8 structural-log history before divergent reconstruction", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-invalid-structural-log");
    const logPath = join(fixture.workspace, "wiki/log.md");
    const invalidLog = Buffer.concat([
      Buffer.from("# Knowledge Structural Log\n\n- invalid bytes: ", "utf8"),
      Buffer.from([0xff, 0xfe]),
      Buffer.from("\n", "utf8"),
    ]);
    writeFileSync(logPath, invalidLog);
    git(fixture.workspace, ["add", "wiki/log.md"]);
    git(fixture.workspace, ["commit", "-m", "commit invalid structural-log bytes"]);
    const localTip = localHead(fixture);
    const remoteTip = commitFiles(peer, "remote divergence from invalid structural log", {
      "diary/remote-invalid-log.md": "# Remote history\n",
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-structural-log-invalid-encoding");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assert.deepEqual(readFileSync(logPath), invalidLog);
  });

  it("merges clean divergence in a detached worktree and keeps both pre-sync tips reachable", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-diverged");
    const localCommit = commitFiles(fixture.workspace, "local divergent entry", {
      "diary/local.md": "# Local\n\nLocal committed history.\n",
    });
    const remoteCommit = commitFiles(peer, "remote divergent entry", {
      "diary/remote.md": "# Remote\n\nRemote committed history.\n",
    });
    git(peer, ["push", "origin", "main"]);
    const candidateBase = join(fixture.root, "candidate-worktrees");
    let temporaryWorktrees = 0;

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      temporaryDirectory: candidateBase,
      fs: {
        mkdtempSync: ((prefix: string) => {
          temporaryWorktrees += 1;
          return mkdtempSync(prefix);
        }) as typeof mkdtempSync,
      },
    });

    assertSyncOk(response);
    assert.equal(response.classification, "diverged");
    assert.equal(temporaryWorktrees, 1);
    assert.equal(localHead(fixture), remoteHead(fixture));
    assertAncestor(fixture, localCommit, response.commit);
    assertAncestor(fixture, remoteCommit, response.commit);
    assert.match(readFileSync(join(fixture.workspace, "diary/local.md"), "utf8"), /Local committed history/);
    assert.match(readFileSync(join(fixture.workspace, "diary/remote.md"), "utf8"), /Remote committed history/);
    assert.deepEqual(recoveryRefs(fixture), []);
    assert.deepEqual(worktreePaths(fixture), [realpathSync(fixture.workspace)]);
  });

  it("ignores replacement refs when classifying and verifying the real commit graph", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-replacement-ref");
    const localCommit = commitFiles(fixture.workspace, "local replacement-ref entry", {
      "diary/local-replacement-ref.md": "# Local replacement-ref history\n",
    });
    const remoteCommit = commitFiles(peer, "remote replacement-ref entry", {
      "diary/remote-replacement-ref.md": "# Remote replacement-ref history\n",
    });
    git(peer, ["push", "origin", "main"]);
    git(fixture.workspace, ["fetch", "origin", "main"]);
    git(fixture.workspace, ["replace", "--graft", remoteCommit, localCommit]);
    git(fixture.workspace, ["merge-base", "--is-ancestor", localCommit, remoteCommit]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    assert.equal(response.classification, "diverged");
    git(fixture.workspace, ["--no-replace-objects", "merge-base", "--is-ancestor", localCommit, response.commit]);
    git(fixture.workspace, ["--no-replace-objects", "merge-base", "--is-ancestor", remoteCommit, response.commit]);
    assert.equal(existsSync(join(fixture.workspace, "diary/local-replacement-ref.md")), true);
    assert.equal(existsSync(join(fixture.workspace, "diary/remote-replacement-ref.md")), true);
    assert.deepEqual(recoveryRefs(fixture), []);
  });

  it("fails closed when unresolved-conflict inspection fails", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-conflict-inspection-failure");
    const localTip = commitFiles(fixture.workspace, "local conflict-inspection history", {
      "diary/local-conflict-inspection.md": "# Local conflict-inspection history\n",
    });
    const remoteTip = commitFiles(peer, "remote conflict-inspection history", {
      "diary/remote-conflict-inspection.md": "# Remote conflict-inspection history\n",
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (gitCommand(args) === "diff" && args.includes("--diff-filter=U")) {
          return { status: 1, stdout: "", stderr: "simulated conflict inspection failure" };
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-conflict-inspection-failed");
    assert.match(response.message, /simulated conflict inspection failure/);
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
  });

  it("disables repository hooks for every transaction-owned Git mutation", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-hooks");
    commitFiles(fixture.workspace, "local hook-safe entry", {
      "diary/local-hook-safe.md": "# Local hook-safe entry\n",
    });
    commitFiles(peer, "remote hook-safe entry", {
      "diary/remote-hook-safe.md": "# Remote hook-safe entry\n",
    });
    git(peer, ["push", "origin", "main"]);
    const hooksPath = join(fixture.root, "hooks");
    const sentinel = join(fixture.root, "hook-ran");
    mkdirSync(hooksPath, { recursive: true });
    for (const hook of [
      "post-checkout",
      "pre-merge-commit",
      "post-merge",
      "pre-commit",
      "prepare-commit-msg",
      "commit-msg",
      "post-commit",
      "pre-push",
      "reference-transaction",
    ]) {
      const hookPath = join(hooksPath, hook);
      writeFileSync(hookPath, `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(sentinel)}\n`, "utf8");
      chmodSync(hookPath, 0o755);
    }
    git(fixture.workspace, ["config", "core.hooksPath", hooksPath]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    assert.equal(existsSync(sentinel), false);
    assert.equal(localHead(fixture), remoteHead(fixture));
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  });

  it("performs one bounded reconciliation retry when a remote commit wins the first push race", () => {
    const fixture = createSyncFixture();
    const racer = cloneRemote(fixture, "peer-racer");
    const localCommit = commitFiles(fixture.workspace, "local race entry", {
      "diary/local-race.md": "# Local race\n",
    });
    let raced = false;

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (!raced && gitCommand(args) === "push") {
          raced = true;
          commitFiles(racer, "winning remote race entry", {
            "diary/remote-race.md": "# Remote race\n",
          });
          git(racer, ["push", "origin", "main"]);
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assertSyncOk(response);
    assert.equal(raced, true);
    assert.equal(response.classification, "ahead");
    assert.equal(response.attempts, 2);
    assert.equal(localHead(fixture), remoteHead(fixture));
    assertAncestor(fixture, localCommit, response.commit);
    assert.match(readFileSync(join(fixture.workspace, "diary/remote-race.md"), "utf8"), /Remote race/);
    assert.deepEqual(recoveryRefs(fixture), []);
  });

  it("stops after the single allowed push-race retry and preserves the last raced tip", () => {
    const fixture = createSyncFixture();
    const racer = cloneRemote(fixture, "peer-repeated-racer");
    commitFiles(fixture.workspace, "local repeated race entry", {
      "diary/local-repeated-race.md": "# Local repeated race\n",
    });
    let pushAttempts = 0;

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (gitCommand(args) === "push") {
          pushAttempts += 1;
          commitFiles(racer, `remote race ${pushAttempts}`, {
            [`diary/remote-race-${pushAttempts}.md`]: `# Remote race ${pushAttempts}\n`,
          });
          git(racer, ["push", "origin", "main"]);
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "push-race-exhausted");
    assert.equal(response.attempts, 2);
    assert.equal(pushAttempts, 2);
    assert.match(response.message, /one bounded push-race retry/);
    const finalRemoteTip = remoteHead(fixture);
    assert.ok(
      recoveryRefs(fixture).some((ref) => ref.endsWith(`remote-${finalRemoteTip}`)),
      "the final fetched racing tip must have a durable recovery ref",
    );
  });

  it("accepts verified convergence when the second push succeeds but reports a transport failure", () => {
    const fixture = createSyncFixture();
    const racer = cloneRemote(fixture, "peer-lost-push-response");
    commitFiles(fixture.workspace, "local lost-response entry", {
      "diary/local-lost-response.md": "# Local lost response\n",
    });
    let pushAttempts = 0;

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (gitCommand(args) !== "push") {
          return defaultKnowledgeSyncGitRunner(args, options);
        }
        pushAttempts += 1;
        if (pushAttempts === 1) {
          commitFiles(racer, "winning first push race", {
            "diary/remote-first-race.md": "# Remote first race\n",
          });
          git(racer, ["push", "origin", "main"]);
        }
        const pushed = defaultKnowledgeSyncGitRunner(args, options);
        if (pushAttempts === 2) {
          assert.equal(pushed.status, 0);
          return { status: 1, stdout: "", stderr: "simulated lost push response" };
        }
        return pushed;
      },
    });

    assertSyncOk(response);
    assert.equal(response.attempts, 2);
    assert.equal(pushAttempts, 2);
    assert.equal(localHead(fixture), remoteHead(fixture));
    assert.deepEqual(recoveryRefs(fixture), []);
    assert.deepEqual(worktreePaths(fixture), [realpathSync(fixture.workspace)]);
  });

  it("retains recovery refs after an interrupted push and completes idempotently on retry", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-interrupted");
    const localTip = commitFiles(fixture.workspace, "local interrupted entry", {
      "diary/local-interrupted.md": "# Local before interruption\n",
      "wiki/log.md": "# Knowledge Structural Log\n\n- local interrupted structural entry\n",
    });
    const remoteTip = commitFiles(peer, "remote interrupted entry", {
      "diary/remote-interrupted.md": "# Remote before interruption\n",
      "wiki/log.md": "# Knowledge Structural Log\n\n- remote interrupted structural entry\n",
    });
    git(peer, ["push", "origin", "main"]);
    let refusedPush = false;

    const interrupted = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (!refusedPush && gitCommand(args) === "push") {
          refusedPush = true;
          return { status: 1, stdout: "", stderr: "simulated transport interruption" };
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.reason, "push-failed");
    assert.equal(interrupted.attempts, 1);
    const candidateCommit = localHead(fixture);
    assert.notEqual(candidateCommit, localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assertAncestor(fixture, localTip, candidateCommit);
    assertAncestor(fixture, remoteTip, candidateCommit);
    assert.equal(recoveryRefs(fixture).length, 3);
    assert.equal(worktreePaths(fixture).length, 2);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

    const retried = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(retried);
    assert.equal(retried.classification, "ahead");
    assert.equal(retried.commit, candidateCommit);
    assert.equal(remoteHead(fixture), candidateCommit);
    assert.deepEqual(recoveryRefs(fixture), []);
    assert.deepEqual(worktreePaths(fixture), [realpathSync(fixture.workspace)]);
  });

  it("revalidates a retained successful candidate before fast-forwarding canonical main", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-retained-candidate-revalidation");
    const localTip = commitFiles(fixture.workspace, "local retained-candidate divergence", {
      "diary/local-retained-candidate.md": "# Local retained candidate\n",
    });
    commitFiles(peer, "remote retained-candidate divergence", {
      "diary/remote-retained-candidate.md": "# Remote retained candidate\n",
    });
    git(peer, ["push", "origin", "main"]);
    let refusedFastForward = false;

    const interrupted = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (!refusedFastForward && gitCommand(args) === "merge" && args.includes("--ff-only")) {
          refusedFastForward = true;
          return { status: 1, stdout: "", stderr: "simulated canonical fast-forward interruption" };
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.reason, "canonical-fast-forward-failed");
    assert.equal(localHead(fixture), localTip);
    assert.equal(worktreePaths(fixture).length, 2);

    writeFileSync(
      join(fixture.workspace, ".git", "info", "attributes"),
      "wiki/index.md filter=late\n",
      "utf8",
    );
    git(fixture.workspace, ["config", "filter.late.clean", "cat"]);
    git(fixture.workspace, ["config", "filter.late.smudge", "sed 's/Knowledge Index/Filtered Index/'"]);

    const retried = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(retried.ok, false);
    assert.equal(retried.reason, "candidate-unsupported-clean-filter");
    assert.equal(localHead(fixture), localTip);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  });

  it("revalidates retained candidates under current canonical worktree attributes", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-retained-worktree-attributes");
    const neutralAttributes = join(fixture.root, "neutral-attributes");
    const rejectingAttributes = join(fixture.root, "rejecting-attributes");
    writeFileSync(neutralAttributes, "", "utf8");
    writeFileSync(rejectingAttributes, "wiki/index.md filter=late\n", "utf8");
    git(fixture.workspace, ["config", "extensions.worktreeConfig", "true"]);
    git(fixture.workspace, ["config", "--worktree", "core.attributesFile", neutralAttributes]);
    git(fixture.workspace, ["config", "filter.late.clean", "cat"]);
    git(fixture.workspace, ["config", "filter.late.smudge", "sed 's/Knowledge Index/Filtered Index/'"]);
    const localTip = commitFiles(fixture.workspace, "local retained-attribute divergence", {
      "diary/local-retained-attribute.md": "# Local retained attribute history\n",
    });
    const relPath = "wiki/pages/reference/retained-attribute.md";
    const remotePage = page(
      "Retained attribute page",
      "A page introduced by the remote divergent branch.",
      "reference",
      "Remote committed Knowledge.\n",
    );
    const remoteIndex = generateKnowledgeIndex([
      {
        absPath: join(peer, ...relPath.split("/")),
        relPath,
        linkPath: "pages/reference/retained-attribute.md",
        frontmatter: {
          name: "Retained attribute page",
          description: "A page introduced by the remote divergent branch.",
          type: "reference",
        },
      },
    ]);
    commitFiles(peer, "remote retained-attribute divergence", {
      [relPath]: remotePage,
      "wiki/index.md": remoteIndex,
    });
    git(peer, ["push", "origin", "main"]);
    let refusedFastForward = false;

    const interrupted = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (!refusedFastForward && gitCommand(args) === "merge" && args.includes("--ff-only")) {
          refusedFastForward = true;
          return { status: 1, stdout: "", stderr: "simulated canonical fast-forward interruption" };
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.reason, "canonical-fast-forward-failed");
    assert.equal(localHead(fixture), localTip);
    assert.equal(worktreePaths(fixture).length, 2);
    git(fixture.workspace, ["config", "--worktree", "core.attributesFile", rejectingAttributes]);

    const retried = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(retried.ok, false);
    assert.equal(retried.reason, "candidate-unsupported-clean-filter");
    assert.equal(localHead(fixture), localTip);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  });

  it("retries cleanup when a converged temporary worktree cannot initially be removed", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-worktree-cleanup");
    commitFiles(fixture.workspace, "local cleanup divergence", {
      "diary/local-cleanup.md": "# Local cleanup branch\n",
    });
    commitFiles(peer, "remote cleanup divergence", {
      "diary/remote-cleanup.md": "# Remote cleanup branch\n",
    });
    git(peer, ["push", "origin", "main"]);
    let refusedRemoval = false;

    const interrupted = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (!refusedRemoval && gitCommand(args) === "worktree" && args.includes("remove")) {
          refusedRemoval = true;
          return { status: 1, stdout: "", stderr: "simulated worktree removal failure" };
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.reason, "candidate-worktree-remove-failed");
    assert.equal(localHead(fixture), remoteHead(fixture));
    assert.ok(recoveryRefs(fixture).length > 0);
    assert.equal(worktreePaths(fixture).length, 2);

    const retried = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(retried);
    assert.deepEqual(recoveryRefs(fixture), []);
    assert.deepEqual(worktreePaths(fixture), [realpathSync(fixture.workspace)]);
  });

  it("retries cleanup when a reachable recovery ref cannot initially be deleted", () => {
    const fixture = createSyncFixture();
    let refusedDeletion = false;

    const interrupted = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (!refusedDeletion && gitCommand(args) === "update-ref" && args.includes("-d")) {
          refusedDeletion = true;
          return { status: 1, stdout: "", stderr: "simulated recovery-ref deletion failure" };
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.reason, "recovery-ref-delete-failed");
    assert.ok(recoveryRefs(fixture).length > 0);

    const retried = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(retried);
    assert.deepEqual(recoveryRefs(fixture), []);
  });

  it("retains only candidate ownership and tip metadata between retries", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-marker-metadata");
    const localTip = commitFiles(fixture.workspace, "local marker metadata", {
      "diary/local-marker-metadata.md": "# Local marker metadata\n",
    });
    const remoteTip = commitFiles(peer, "remote marker metadata", {
      "diary/remote-marker-metadata.md": "# Remote marker metadata\n",
    });
    git(peer, ["push", "origin", "main"]);
    let refusedFastForward = false;

    const interrupted = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (!refusedFastForward && gitCommand(args) === "merge" && args.includes("--ff-only")) {
          refusedFastForward = true;
          return { status: 1, stdout: "", stderr: "simulated canonical fast-forward interruption" };
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.reason, "canonical-fast-forward-failed");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    const retainedPath = worktreePaths(fixture).find((path) => path !== realpathSync(fixture.workspace));
    assert.ok(retainedPath);
    const marker = JSON.parse(
      readFileSync(join(dirname(retainedPath), ".minime-knowledge-sync-owner.json"), "utf8"),
    ) as Record<string, unknown>;
    assert.equal(marker.version, 2);
    assert.equal(marker.localTip, localTip);
    assert.equal(marker.remoteTip, remoteTip);
    assert.equal(marker.classification, "diverged");
    assert.equal("outcome" in marker, false);

    const retried = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(retried);
    assert.equal(localHead(fixture), remoteHead(fixture));
    assertAncestor(fixture, localTip, retried.commit);
    assertAncestor(fixture, remoteTip, retried.commit);
    assert.deepEqual(recoveryRefs(fixture), []);
    assert.deepEqual(worktreePaths(fixture), [realpathSync(fixture.workspace)]);
  });

  it("does not remove an unmarked lookalike worktree or its untracked files", () => {
    const fixture = createSyncFixture();
    const lookalikeRoot = join(fixture.root, "minime-knowledge-sync-user-owned");
    const lookalikeWorktree = join(lookalikeRoot, "candidate");
    mkdirSync(lookalikeRoot, { recursive: true });
    git(fixture.workspace, ["worktree", "add", "--detach", lookalikeWorktree, "HEAD"]);
    writeFiles(lookalikeWorktree, { "untracked-user-file.txt": "preserve me\n" });

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    assert.equal(existsSync(lookalikeWorktree), true);
    assert.equal(readFileSync(join(lookalikeWorktree, "untracked-user-file.txt"), "utf8"), "preserve me\n");
    assert.ok(worktreePaths(fixture).includes(realpathSync(lookalikeWorktree)));
  });
});

describe("knowledge sync managed Knowledge reconciliation", () => {
  it("merges independent pages, regenerates stale indexes, and preserves concurrent structural logs", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-independent-pages");
    const localLogEntry = "- 2026-08-01T10:00:00.000Z create wiki/pages/user/local.md";
    const remoteLogEntry = "- 2026-08-01T11:00:00.000Z create wiki/pages/project/remote.md";
    const localTip = commitFiles(fixture.workspace, "local Knowledge page", {
      "wiki/pages/user/local.md": page(
        "Local profile",
        "Knowledge committed on the local branch.",
        "user",
        "Local committed detail.\n",
      ),
      "wiki/index.md": "# Stale local index\n",
      "wiki/log.md": `# Knowledge Structural Log\n\n${localLogEntry}\n`,
    });
    const remoteTip = commitFiles(peer, "remote Knowledge page", {
      "wiki/pages/project/remote.md": page(
        "Remote project",
        "Knowledge committed on the remote branch.",
        "project",
        "Remote committed detail.\n",
      ),
      "wiki/index.md": "# Stale remote index\n",
      "wiki/log.md": `# Knowledge Structural Log\n\n${remoteLogEntry}\n`,
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    const index = readFileSync(join(fixture.workspace, "wiki/index.md"), "utf8");
    assert.match(index, /\[Local profile\]\(pages\/user\/local\.md\)/);
    assert.match(index, /\[Remote project\]\(pages\/project\/remote\.md\)/);
    assert.doesNotMatch(index, /Stale (?:local|remote) index/);
    const log = readFileSync(join(fixture.workspace, "wiki/log.md"), "utf8");
    assert.match(log, new RegExp(localLogEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(log, new RegExp(remoteLogEntry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(log, new RegExp(`knowledge-sync merge local=${localTip} remote=${remoteTip}`));
    assert.equal(log.match(/knowledge-sync merge/g)?.length, 1);
  });

  it("uses the fixed package identity for divergent merge commits", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-fixed-merge-identity");
    commitFiles(fixture.workspace, "create local identity divergence", {
      "diary/local-identity.md": "# Local identity divergence\n",
    });
    commitFiles(peer, "create remote identity divergence", {
      "diary/remote-identity.md": "# Remote identity divergence\n",
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      env: {
        GIT_AUTHOR_NAME: "Private Author",
        GIT_AUTHOR_EMAIL: "private-author@example.test",
        GIT_COMMITTER_NAME: "Private Committer",
        GIT_COMMITTER_EMAIL: "private-committer@example.test",
      },
    });

    assertSyncOk(response);
    assert.equal(
      git(fixture.workspace, ["show", "-s", "--format=%an|%ae|%cn|%ce", response.commit]),
      "minime-bot|minime-bot@users.noreply.github.com|minime-bot|minime-bot@users.noreply.github.com",
    );
  });

  it("preserves identical structural-log entries independently appended on both branches", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-identical-log-entry");
    const sharedEntry = "- 2026-08-01T12:00:00.000Z update wiki/pages/reference/shared.md";
    const branchLog = `# Knowledge Structural Log\n\n${sharedEntry}\n`;
    commitFiles(fixture.workspace, "local identical structural entry", {
      "wiki/log.md": branchLog,
      "diary/local-identical-log.md": "# Local branch\n",
    });
    commitFiles(peer, "remote identical structural entry", {
      "wiki/log.md": branchLog,
      "diary/remote-identical-log.md": "# Remote branch\n",
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    const log = readFileSync(join(fixture.workspace, "wiki/log.md"), "utf8");
    assert.equal(log.split(sharedEntry).length - 1, 2);
  });

  it("accepts Git's clean three-way result for compatible edits to one page", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/project/compatible.md";
    const sharedBody = [
      "# Compatible topic",
      "",
      "Local detail: pending.",
      "",
      ...Array.from({ length: 12 }, (_, index) => `Shared context ${index + 1}.`),
      "",
      "Remote detail: pending.",
      "",
    ].join("\n");
    commitFiles(fixture.workspace, "shared compatible page", {
      [relPath]: page("Compatible topic", "A page with independently editable details.", "project", sharedBody),
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-compatible-page");
    commitFiles(fixture.workspace, "local compatible edit", {
      [relPath]: page(
        "Compatible topic",
        "A page with independently editable details.",
        "project",
        sharedBody.replace("Local detail: pending.", "Local detail: committed locally."),
      ),
    });
    commitFiles(peer, "remote compatible edit", {
      [relPath]: page(
        "Compatible topic",
        "A page with independently editable details.",
        "project",
        sharedBody.replace("Remote detail: pending.", "Remote detail: committed remotely."),
      ),
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    const merged = readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8");
    assert.match(merged, /Local detail: committed locally\./);
    assert.match(merged, /Remote detail: committed remotely\./);
    assert.doesNotMatch(merged, /UNRESOLVED/);
  });

  it("wraps contradictory add/add variants with deterministic provenance and reruns idempotently", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-contradictory-page");
    const relPath = "wiki/pages/feedback/preference.md";
    const localVariant = page(
      "Local preference",
      "The preference as committed locally.",
      "feedback",
      "The user prefers the local variant.\n",
    );
    const remoteVariant = page(
      "Remote preference",
      "The preference as committed remotely.",
      "feedback",
      "The user prefers the remote variant.\n",
    );
    const localTip = commitFiles(fixture.workspace, "local contradictory page", { [relPath]: localVariant });
    const remoteTip = commitFiles(peer, "remote contradictory page", { [relPath]: remoteVariant });
    git(peer, ["push", "origin", "main"]);

    const first = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(first);
    const pagePath = join(fixture.workspace, ...relPath.split("/"));
    const unresolved = readFileSync(pagePath, "utf8");
    assert.match(unresolved, /type: feedback/);
    assert.match(unresolved, /revisit_if:/);
    assert.match(unresolved, /UNRESOLVED: Both committed variants are retained/);
    assert.match(unresolved, new RegExp(localTip));
    assert.match(unresolved, new RegExp(remoteTip));
    assert.ok(unresolved.includes(localVariant.trimEnd()));
    assert.ok(unresolved.includes(remoteVariant.trimEnd()));
    assert.match(readFileSync(join(fixture.workspace, "wiki/index.md"), "utf8"), /Unresolved conflict: preference/);
    const firstCommit = first.commit;

    const second = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(second);
    assert.equal(second.classification, "no-op");
    assert.equal(second.commit, firstCommit);
    assert.equal(readFileSync(pagePath, "utf8"), unresolved);
  });

  it("ignores a recorded rerere resolution for a current managed-page conflict", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/feedback/rerere.md";
    const sharedVariant = page(
      "Rerere preference",
      "A shared preference before contradictory edits.",
      "feedback",
      "The shared preference is undecided.\n",
    );
    commitFiles(fixture.workspace, "shared page before rerere conflict", { [relPath]: sharedVariant });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-rerere");
    const localVariant = sharedVariant.replace(
      "The shared preference is undecided.",
      "The current local preference must be retained.",
    );
    const remoteVariant = sharedVariant.replace(
      "The shared preference is undecided.",
      "The current remote preference must be retained.",
    );
    const staleResolution = sharedVariant.replace(
      "The shared preference is undecided.",
      "A stale recorded resolution must not be reused.",
    );
    const localTip = commitFiles(fixture.workspace, "local rerere preference", { [relPath]: localVariant });
    const remoteTip = commitFiles(peer, "remote rerere preference", { [relPath]: remoteVariant });
    git(peer, ["push", "origin", "main"]);
    git(fixture.workspace, ["config", "rerere.enabled", "true"]);
    git(fixture.workspace, ["config", "rerere.autoupdate", "true"]);
    git(fixture.workspace, ["fetch", "origin", "main"]);
    const conflicted = spawnSync("git", ["merge", "--no-ff", "--no-commit", "origin/main"], {
      cwd: fixture.workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.notEqual(conflicted.status, 0);
    writeFiles(fixture.workspace, { [relPath]: staleResolution });
    git(fixture.workspace, ["add", relPath]);
    git(fixture.workspace, ["rerere"]);
    git(fixture.workspace, ["merge", "--abort"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    const unresolved = readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8");
    assert.match(unresolved, /UNRESOLVED: Both committed variants are retained/);
    assert.match(unresolved, new RegExp(localTip));
    assert.match(unresolved, new RegExp(remoteTip));
    assert.ok(unresolved.includes(localVariant.trimEnd()));
    assert.ok(unresolved.includes(remoteVariant.trimEnd()));
    assert.doesNotMatch(unresolved, /A stale recorded resolution must not be reused/);
  });

  it("rejects a union merge attribute before it can hide a managed page conflict", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/feedback/union.md";
    const sharedVariant = page(
      "Union preference",
      "A shared preference before contradictory edits.",
      "feedback",
      "The shared preference is undecided.\n",
    );
    commitFiles(fixture.workspace, "shared page with union merge attribute", {
      ".gitattributes": `${relPath} merge=union\n`,
      [relPath]: sharedVariant,
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-union-driver");
    const localVariant = sharedVariant.replace(
      "The shared preference is undecided.",
      "The local preference is authoritative.",
    );
    const remoteVariant = sharedVariant.replace(
      "The shared preference is undecided.",
      "The remote preference is authoritative.",
    );
    const localTip = commitFiles(fixture.workspace, "local union preference", { [relPath]: localVariant });
    const remoteTip = commitFiles(peer, "remote union preference", { [relPath]: remoteVariant });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "unsupported-merge-driver");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assert.equal(readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8"), localVariant);
  });

  it("rejects a union merge attribute on a renamed destination before it can hide a conflict", () => {
    const fixture = createSyncFixture();
    const oldPath = "wiki/pages/reference/rename-union-old.md";
    const newPath = "wiki/pages/reference/rename-union-new.md";
    const sharedBody = [
      "# Rename union topic",
      "",
      ...Array.from({ length: 16 }, (_, index) => `Stable rename context ${index + 1}.`),
      "",
      "Claim: undecided.",
      "",
    ].join("\n");
    const sharedVariant = page("Rename union topic", "A page renamed during divergent edits.", "reference", sharedBody);
    commitFiles(fixture.workspace, "shared rename page with destination union driver", {
      ".gitattributes": `${newPath} merge=union\n`,
      [oldPath]: sharedVariant,
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-rename-union-driver");
    const localVariant = sharedVariant.replace("Claim: undecided.", "Claim: local.");
    const remoteVariant = sharedVariant.replace("Claim: undecided.", "Claim: remote.");
    git(fixture.workspace, ["mv", oldPath, newPath]);
    writeFiles(fixture.workspace, { [newPath]: localVariant });
    git(fixture.workspace, ["add", "-A"]);
    git(fixture.workspace, ["commit", "-m", "rename and edit page locally"]);
    const localTip = localHead(fixture);
    const remoteTip = commitFiles(peer, "edit old page remotely", { [oldPath]: remoteVariant });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "unsupported-merge-driver");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
  });

  it("rejects configured overrides of Git's built-in text and binary merge drivers", () => {
    for (const driver of ["text", "binary"] as const) {
      const fixture = createSyncFixture();
      const relPath = `wiki/pages/feedback/overridden-${driver}.md`;
      const sharedVariant = page(
        `Overridden ${driver} driver`,
        "A shared page whose merge driver name is overridden locally.",
        "feedback",
        "Shared committed body.\n",
      );
      commitFiles(fixture.workspace, `configure shared ${driver} attribute`, {
        ".gitattributes": `${relPath} merge=${driver}\n`,
        [relPath]: sharedVariant,
      });
      git(fixture.workspace, ["push", "origin", "main"]);
      const peer = cloneRemote(fixture, `peer-overridden-${driver}`);
      const localTip = commitFiles(fixture.workspace, `local ${driver} driver variant`, {
        [relPath]: sharedVariant.replace("Shared committed body.", "LOCAL.DRIVER.VARIANT"),
      });
      const remoteTip = commitFiles(peer, `remote ${driver} driver variant`, {
        [relPath]: sharedVariant.replace("Shared committed body.", "REMOTE.DRIVER.VARIANT"),
      });
      git(peer, ["push", "origin", "main"]);
      git(fixture.workspace, ["config", `merge.${driver}.driver`, "cp %B %A"]);

      const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

      assert.equal(response.ok, false, driver);
      assert.equal(response.reason, "unsupported-merge-driver", driver);
      assert.equal(localHead(fixture), localTip, driver);
      assert.equal(remoteHead(fixture), remoteTip, driver);
    }
  });

  it("rejects a clean filter before it can alter a staged unresolved page", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/feedback/filtered.md";
    commitFiles(fixture.workspace, "configure shared clean-filter attribute", {
      ".gitattributes": `${relPath} filter=drop\n`,
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-clean-filter");
    const localTip = commitFiles(fixture.workspace, "local filtered variant", {
      [relPath]: page(
        "Local filtered variant",
        "The local committed variant.",
        "feedback",
        "LOCAL.UNIQUE.BODY\n",
      ),
    });
    const remoteTip = commitFiles(peer, "remote filtered variant", {
      [relPath]: page(
        "Remote filtered variant",
        "The remote committed variant.",
        "feedback",
        "REMOTE.UNIQUE.BODY\n",
      ),
    });
    git(peer, ["push", "origin", "main"]);
    git(fixture.workspace, ["config", "filter.drop.clean", "sed '/REMOTE.UNIQUE.BODY/d'"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-unsupported-clean-filter");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
  });

  it("rejects managed check-in transformations before preparing a divergent merge", () => {
    for (const [name, attribute] of [
      ["ident", "ident"],
      ["working-tree-encoding", "working-tree-encoding=UTF-16"],
      ["text", "text"],
      ["eol", "eol=crlf"],
    ] as const) {
      const fixture = createSyncFixture();
      const relPath = `wiki/pages/reference/${name}-transformation.md`;
      commitFiles(fixture.workspace, `add shared ${name} page`, {
        [relPath]: page(
          `${name} transformation`,
          `A managed page covered by the ${name} check-in attribute.`,
          "reference",
          "A committed variant must not be transformed during synchronization.\n",
        ),
      });
      git(fixture.workspace, ["push", "origin", "main"]);
      const peer = cloneRemote(fixture, `peer-${name}-transformation`);
      const localTip = commitFiles(fixture.workspace, `configure ${name} transformation`, {
        ".gitattributes": `${relPath} ${attribute}\n`,
      });
      rmSync(join(fixture.workspace, ...relPath.split("/")));
      git(fixture.workspace, ["checkout", "--", relPath]);
      const remoteTip = commitFiles(peer, `diverge from ${name} transformation`, {
        [`diary/remote-${name}.md`]: `# Remote ${name} history\n`,
      });
      git(peer, ["push", "origin", "main"]);

      const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

      assert.equal(response.ok, false, name);
      assert.equal(response.reason, "candidate-unsupported-checkin-transformation", name);
      assert.equal(localHead(fixture), localTip, name);
      assert.equal(remoteHead(fixture), remoteTip, name);
    }
  });

  it("rejects a managed check-in transformation introduced by the remote branch", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/reference/remote-ident-transformation.md";
    const sharedVariant = page(
      "Remote ident transformation",
      "A shared page before the remote branch introduces an ident attribute.",
      "reference",
      "The shared committed claim is undecided.\n",
    );
    commitFiles(fixture.workspace, "add shared page before remote transformation", {
      [relPath]: sharedVariant,
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-remote-ident-transformation");
    const localTip = commitFiles(fixture.workspace, "edit local page before remote transformation", {
      [relPath]: sharedVariant.replace("undecided", "local"),
    });
    commitFiles(peer, "edit remote page before adding ident transformation", {
      [relPath]: sharedVariant.replace("undecided", "remote"),
    });
    const remoteTip = commitFiles(peer, "configure remote ident transformation", {
      ".gitattributes": `${relPath} ident\n`,
    });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-unsupported-checkin-transformation");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
  });

  it("rejects effective core.autocrlf before it can transform reconciled Knowledge", () => {
    for (const [name, configure] of [
      ["common-input", (workspace: string) => git(workspace, ["config", "core.autocrlf", "input"])],
      ["canonical-worktree-true", (workspace: string) => {
        git(workspace, ["config", "extensions.worktreeConfig", "true"]);
        git(workspace, ["config", "--worktree", "core.autocrlf", "true"]);
      }],
    ] as const) {
      const fixture = createSyncFixture();
      const relPath = `wiki/pages/reference/${name}.md`;
      const sharedVariant = page(
        "Autocrlf conflict",
        "A shared page before conflicting line-ending variants.",
        "reference",
        "The shared line-ending claim is undecided.\n",
      );
      commitFiles(fixture.workspace, `add shared ${name} page`, { [relPath]: sharedVariant });
      git(fixture.workspace, ["push", "origin", "main"]);
      const peer = cloneRemote(fixture, `peer-${name}`);
      const localTip = commitFiles(fixture.workspace, `edit local ${name} page`, {
        [relPath]: sharedVariant.replace("undecided", "local"),
      });
      const remoteTip = commitFiles(peer, `edit remote ${name} page`, {
        [relPath]: sharedVariant.replace("undecided", "remote").replaceAll("\n", "\r\n"),
      });
      git(peer, ["push", "origin", "main"]);
      configure(fixture.workspace);

      const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

      assert.equal(response.ok, false, name);
      assert.equal(response.reason, "candidate-unsupported-checkin-transformation", name);
      assert.equal(localHead(fixture), localTip, name);
      assert.equal(remoteHead(fixture), remoteTip, name);
    }
  });

  it("retains the complete present variant and the deletion provenance for modify/delete", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/reference/deletion.md";
    commitFiles(fixture.workspace, "shared page before deletion", {
      [relPath]: page("Deletion topic", "A shared page before concurrent changes.", "reference", "Shared claim.\n"),
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-modify-delete");
    const modifiedVariant = page(
      "Deletion topic",
      "A locally modified page retained through conflict.",
      "reference",
      "Locally modified committed claim.\n",
    );
    const localTip = commitFiles(fixture.workspace, "modify page locally", { [relPath]: modifiedVariant });
    git(peer, ["rm", relPath]);
    git(peer, ["commit", "-m", "delete page remotely"]);
    const remoteTip = git(peer, ["rev-parse", "HEAD"]);
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    const unresolved = readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8");
    assert.ok(unresolved.includes(modifiedVariant.trimEnd()));
    assert.match(unresolved, /committed deletion/);
    assert.match(unresolved, new RegExp(localTip));
    assert.match(unresolved, new RegExp(remoteTip));
  });

  it("retains both index-stage variants when Git maps a rename/modify conflict to the destination", () => {
    const fixture = createSyncFixture();
    const oldPath = "wiki/pages/project/renamed-old.md";
    const newPath = "wiki/pages/project/renamed-new.md";
    const sharedBody = [
      "# Renamed topic",
      "",
      ...Array.from({ length: 16 }, (_, index) => `Stable renamed context ${index + 1}.`),
      "",
      "Claim: undecided.",
      "",
    ].join("\n");
    const sharedVariant = page("Renamed topic", "A page renamed during divergent edits.", "project", sharedBody);
    commitFiles(fixture.workspace, "shared page before rename", { [oldPath]: sharedVariant });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-rename-modify");
    const localVariant = sharedVariant.replace("Claim: undecided.", "Claim: local renamed variant.");
    const remoteVariant = sharedVariant.replace("Claim: undecided.", "Claim: remote original-path variant.");
    git(fixture.workspace, ["mv", oldPath, newPath]);
    writeFiles(fixture.workspace, { [newPath]: localVariant });
    git(fixture.workspace, ["add", "-A"]);
    git(fixture.workspace, ["commit", "-m", "rename and edit page locally"]);
    const localTip = localHead(fixture);
    const remoteTip = commitFiles(peer, "edit original page remotely", { [oldPath]: remoteVariant });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    const unresolved = readFileSync(join(fixture.workspace, ...newPath.split("/")), "utf8");
    assert.ok(unresolved.includes(localVariant.trimEnd()));
    assert.ok(unresolved.includes(remoteVariant.trimEnd()));
    assert.doesNotMatch(unresolved, /committed deletion/);
    assert.match(unresolved, new RegExp(localTip));
    assert.match(unresolved, new RegExp(remoteTip));
  });

  it("retains a malformed conflicting source variant inside a schema-valid unresolved page", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/user/malformed.md";
    commitFiles(fixture.workspace, "shared page before malformed edit", {
      [relPath]: page("Shared profile", "A valid shared profile.", "user", "Shared body.\n"),
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-malformed-page");
    const malformedVariant = "---\nname: [invalid yaml\n---\n\nMalformed committed bytes.\n";
    commitFiles(fixture.workspace, "malform local variant", { [relPath]: malformedVariant });
    const validRemoteVariant = page(
      "Remote profile",
      "A valid conflicting remote profile.",
      "user",
      "Remote committed bytes.\n",
    );
    commitFiles(peer, "edit remote variant", { [relPath]: validRemoteVariant });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    const unresolved = readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8");
    assert.match(unresolved, /type: user/);
    assert.ok(unresolved.includes(malformedVariant.trimEnd()));
    assert.ok(unresolved.includes(validRemoteVariant.trimEnd()));
    assert.match(unresolved, /UNRESOLVED/);
  });

  it("retains a non-UTF-8 conflicting source variant as exact base64 bytes", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/user/binary.md";
    const sharedVariant = page(
      "Shared binary profile",
      "A valid page before one committed variant becomes binary.",
      "user",
      "Shared body.\n",
    );
    commitFiles(fixture.workspace, "add shared page before binary edit", {
      [relPath]: sharedVariant,
    });
    git(fixture.workspace, ["push", "origin", "main"]);
    const peer = cloneRemote(fixture, "peer-binary-page");
    const binaryVariant = Buffer.concat([
      Buffer.from("---\nname: Binary profile\ntype: user\n---\n\nBinary bytes: ", "utf8"),
      Buffer.from([0x00, 0xff, 0xfe]),
      Buffer.from("\n", "utf8"),
    ]);
    writeFileSync(join(fixture.workspace, ...relPath.split("/")), binaryVariant);
    git(fixture.workspace, ["add", relPath]);
    git(fixture.workspace, ["commit", "-m", "commit binary local variant"]);
    const localTip = localHead(fixture);
    const remoteTip = commitFiles(peer, "edit remote binary page as text", {
      [relPath]: sharedVariant.replace("Shared body.", "Remote text body."),
    });
    git(peer, ["push", "origin", "main"]);

    const missingRawOutput = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        const result = defaultKnowledgeSyncGitRunner(args, options);
        if (gitCommand(args) === "show" && args.some((arg) => arg.startsWith(":"))) {
          return { ...result, stdoutBytes: undefined };
        }
        return result;
      },
    });

    assert.equal(missingRawOutput.ok, false);
    assert.equal(missingRawOutput.reason, "candidate-source-byte-output-unavailable");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assertSyncOk(response);
    const unresolved = readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8");
    assert.match(unresolved, /not valid UTF-8/);
    const encoded = /```base64\n([A-Za-z0-9+/=]+)\n```/u.exec(unresolved)?.[1];
    assert.ok(encoded);
    assert.deepEqual(Buffer.from(encoded, "base64"), binaryVariant);
  });

  it("fails closed on unsupported managed control, issues, and archive conflicts", () => {
    for (const scenario of ["control", "issues", "archive"] as const) {
      const fixture = createSyncFixture();
      const peer = cloneRemote(fixture, `peer-unsupported-${scenario}`);
      const relPath =
        scenario === "control"
          ? "wiki/schema.md"
          : scenario === "issues"
            ? "wiki/issues.md"
          : "artifacts/knowledge-archive/wiki/pages/reference/retired.md";
      const localContent =
        scenario === "control"
          ? generateKnowledgeV2Schema().replace("# Knowledge Schema", "# Local Knowledge Schema")
          : scenario === "issues"
            ? "# Knowledge Issues\n\nLocal issue state.\n"
            : "Local archived variant.\n";
      const remoteContent =
        scenario === "control"
          ? generateKnowledgeV2Schema().replace("# Knowledge Schema", "# Remote Knowledge Schema")
          : scenario === "issues"
            ? "# Knowledge Issues\n\nRemote issue state.\n"
            : "Remote archived variant.\n";
      const localTip = commitFiles(fixture.workspace, `local ${scenario} change`, { [relPath]: localContent });
      const remoteTip = commitFiles(peer, `remote ${scenario} change`, { [relPath]: remoteContent });
      git(peer, ["push", "origin", "main"]);

      const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

      assert.equal(response.ok, false);
      assert.equal(response.reason, "unsupported-managed-conflict");
      assert.deepEqual(response.conflictPaths, [relPath]);
      assert.equal(localHead(fixture), localTip);
      assert.equal(remoteHead(fixture), remoteTip);
      assert.equal(readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8"), localContent);
      assert.equal(recoveryRefs(fixture).length, 2);
    }
  });
});

describe("knowledge sync validation and failure boundaries", () => {
  it("rejects a Knowledge v2 directory that is not a Git repository", () => {
    const root = mkdtempSync(join(tmpdir(), "minime-knowledge-sync-nonrepo-"));
    fixtures.push(root);
    writeFiles(root, {
      "wiki/schema.md": generateKnowledgeV2Schema(),
      "wiki/index.md": "# Knowledge Index\n",
    });

    const response = executeKnowledgeSync({ agentWorkspaceRoot: root });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "not-a-git-repository");
    assert.match(response.message, /Git repository root/);
  });

  it("rejects a non-main branch without changing HEAD or the worktree", () => {
    const fixture = createSyncFixture();
    git(fixture.workspace, ["switch", "-c", "topic"]);
    const before = localHead(fixture);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "not-on-main");
    assert.equal(localHead(fixture), before);
    assert.equal(git(fixture.workspace, ["branch", "--show-current"]), "topic");
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  });

  it("rejects a fetched managed symlink before fast-forwarding canonical main", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-managed-symlink");
    const relPath = "wiki/pages/reference/unsafe-link.md";
    const linkPath = join(peer, ...relPath.split("/"));
    mkdirSync(dirname(linkPath), { recursive: true });
    symlinkSync("../../../README.md", linkPath);
    git(peer, ["add", relPath]);
    git(peer, ["commit", "-m", "track unsafe managed symlink"]);
    git(peer, ["push", "origin", "main"]);
    const localTip = localHead(fixture);
    const remoteTip = remoteHead(fixture);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-unsafe-managed-entry");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assert.equal(existsSync(join(fixture.workspace, ...relPath.split("/"))), false);
    assert.ok(recoveryRefs(fixture).length > 0);
  });

  it("rejects dirty tracked or untracked state byte-for-byte", () => {
    const fixture = createSyncFixture();
    const readmePath = join(fixture.workspace, "README.md");
    writeFileSync(readmePath, "# Agent workspace\n\nUncommitted edit.\n", "utf8");
    writeFiles(fixture.workspace, { "notes/untracked.md": "untracked\n" });
    const beforeHead = localHead(fixture);
    const beforeStatus = git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const beforeReadme = readFileSync(readmePath, "utf8");

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "dirty-worktree");
    assert.match(response.message, /commit or remove/);
    assert.equal(localHead(fixture), beforeHead);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), beforeStatus);
    assert.equal(readFileSync(readmePath, "utf8"), beforeReadme);
  });

  it("rejects an unfinished merge even when porcelain status is empty", () => {
    const fixture = createSyncFixture();
    git(fixture.workspace, ["switch", "-c", "empty-merge-source"]);
    git(fixture.workspace, ["commit", "--allow-empty", "-m", "empty merge source"]);
    const mergeSource = git(fixture.workspace, ["rev-parse", "HEAD"]);
    git(fixture.workspace, ["switch", "main"]);
    const beforeHead = localHead(fixture);
    git(fixture.workspace, ["merge", "--no-ff", "--no-commit", "empty-merge-source"]);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(git(fixture.workspace, ["rev-parse", "--verify", "MERGE_HEAD"]), mergeSource);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "git-operation-in-progress");
    assert.equal(localHead(fixture), beforeHead);
    assert.equal(git(fixture.workspace, ["rev-parse", "--verify", "MERGE_HEAD"]), mergeSource);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  });

  it("rechecks repository operation state after acquiring the Knowledge lock", () => {
    const fixture = createSyncFixture();
    git(fixture.workspace, ["switch", "-c", "late-merge-source"]);
    git(fixture.workspace, ["commit", "--allow-empty", "-m", "late empty merge source"]);
    const mergeSource = git(fixture.workspace, ["rev-parse", "HEAD"]);
    git(fixture.workspace, ["switch", "main"]);
    const beforeHead = localHead(fixture);
    let statusChecks = 0;

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        const result = defaultKnowledgeSyncGitRunner(args, options);
        if (gitCommand(args) === "status" && statusChecks === 0) {
          statusChecks += 1;
          git(fixture.workspace, ["merge", "--no-ff", "--no-commit", "late-merge-source"]);
        }
        return result;
      },
    });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "git-operation-in-progress");
    assert.equal(localHead(fixture), beforeHead);
    assert.equal(git(fixture.workspace, ["rev-parse", "--verify", "MERGE_HEAD"]), mergeSource);
    assert.equal(existsSync(join(fixture.workspace, ".tmp/knowledge-update.lock")), false);
  });

  it("rejects ignored untracked files under managed Knowledge paths", () => {
    const fixture = createSyncFixture();
    const relPath = "wiki/pages/reference/ignored.md";
    const ignoredPage = page(
      "Ignored page",
      "An ignored page must not masquerade as committed Knowledge.",
      "reference",
      "Ignored local bytes.\n",
    );
    writeFiles(fixture.workspace, { [relPath]: ignoredPage });
    const committedIndex = generateKnowledgeIndex([
      {
        absPath: join(fixture.workspace, ...relPath.split("/")),
        relPath,
        linkPath: "pages/reference/ignored.md",
        frontmatter: {
          name: "Ignored page",
          description: "An ignored page must not masquerade as committed Knowledge.",
          type: "reference",
        },
      },
    ]);
    const committedTip = commitFiles(fixture.workspace, "ignore a managed page", {
      ".gitignore": `.tmp/\n${relPath}\n`,
      "wiki/index.md": committedIndex,
    });
    git(fixture.workspace, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-untracked-managed-files");
    assert.equal(localHead(fixture), committedTip);
    assert.equal(remoteHead(fixture), committedTip);
    assert.equal(readFileSync(join(fixture.workspace, ...relPath.split("/")), "utf8"), ignoredPage);
  });

  it("rejects a tracked runtime lock without deleting committed bytes", () => {
    const fixture = createSyncFixture();
    const lockPath = join(fixture.workspace, ".tmp/knowledge-update.lock");
    const lockContent = `${JSON.stringify({
      pid: 999_999,
      acquiredAt: "2000-01-01T00:00:00.000Z",
      path: ".tmp/knowledge-update.lock",
    })}\n`;
    writeFiles(fixture.workspace, { ".tmp/knowledge-update.lock": lockContent });
    git(fixture.workspace, ["add", "-f", ".tmp/knowledge-update.lock"]);
    git(fixture.workspace, ["commit", "-m", "track the reserved runtime lock path"]);
    git(fixture.workspace, ["push", "origin", "main"]);
    const committedTip = localHead(fixture);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "tracked-runtime-lock");
    assert.equal(localHead(fixture), committedTip);
    assert.equal(remoteHead(fixture), committedTip);
    assert.equal(readFileSync(lockPath, "utf8"), lockContent);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  });

  it("rejects a tracked runtime reclaim marker without deleting committed bytes", () => {
    const fixture = createSyncFixture();
    const reclaimPath = join(fixture.workspace, ".tmp/knowledge-update.lock.reclaim");
    const reclaimContent = "reserved runtime reclaim state\n";
    writeFiles(fixture.workspace, { ".tmp/knowledge-update.lock.reclaim": reclaimContent });
    git(fixture.workspace, ["add", "-f", ".tmp/knowledge-update.lock.reclaim"]);
    git(fixture.workspace, ["commit", "-m", "track the reserved runtime reclaim path"]);
    git(fixture.workspace, ["push", "origin", "main"]);
    const committedTip = localHead(fixture);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "tracked-runtime-lock");
    assert.equal(localHead(fixture), committedTip);
    assert.equal(remoteHead(fixture), committedTip);
    assert.equal(readFileSync(reclaimPath, "utf8"), reclaimContent);
  });

  it("recovers an untracked abandoned reclaim marker before locked preflight", () => {
    const fixture = createSyncFixture();
    git(fixture.workspace, ["rm", ".gitignore"]);
    git(fixture.workspace, ["commit", "-m", "remove runtime ignore for reclaim coverage"]);
    git(fixture.workspace, ["push", "origin", "main"]);
    const lockPath = join(fixture.workspace, ".tmp/knowledge-update.lock");
    const reclaimPath = `${lockPath}.reclaim`;
    writeFiles(fixture.workspace, {
      ".tmp/knowledge-update.lock": `${JSON.stringify({
        pid: 999_999,
        acquiredAt: "2000-01-01T00:00:00.000Z",
      })}\n`,
    });
    linkSync(lockPath, reclaimPath);

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      lockNow: () => new Date(Date.now() + 60_000),
      staleLockMs: 1,
      isProcessAlive: () => false,
    });

    assertSyncOk(response);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(reclaimPath), false);
  });

  it("rejects a tracked runtime lock introduced by fetched history before fast-forwarding", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-tracked-runtime-lock");
    const localTip = localHead(fixture);
    writeFiles(peer, {
      ".tmp/knowledge-update.lock": `${JSON.stringify({
        pid: 999_999,
        acquiredAt: "2000-01-01T00:00:00.000Z",
        path: ".tmp/knowledge-update.lock",
      })}\n`,
    });
    git(peer, ["add", "-f", ".tmp/knowledge-update.lock"]);
    git(peer, ["commit", "-m", "track the reserved runtime lock remotely"]);
    const remoteTip = git(peer, ["rev-parse", "HEAD"]);
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "tracked-runtime-lock");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assert.equal(existsSync(join(fixture.workspace, ".tmp/knowledge-update.lock")), false);
    assert.equal(recoveryRefs(fixture).length, 2);
  });

  it("shares the Knowledge update lock and returns a typed locked response", () => {
    const fixture = createSyncFixture();
    const lockPath = join(fixture.workspace, ".tmp/knowledge-update.lock");
    writeFiles(fixture.workspace, {
      ".tmp/knowledge-update.lock": `${JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
        path: ".tmp/knowledge-update.lock",
      })}\n`,
    });

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.status, "locked");
    assert.equal(response.reason, "knowledge-sync-locked");
    assert.match(response.message, /already running/);
    assert.match(readFileSync(lockPath, "utf8"), /knowledge-update\.lock/);
  });

  it("returns the typed lock response while the lock owner has dirty managed files", () => {
    const fixture = createSyncFixture();
    const lockPath = join(fixture.workspace, ".tmp/knowledge-update.lock");
    const lockContent = `${JSON.stringify({
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      path: ".tmp/knowledge-update.lock",
    })}\n`;
    writeFiles(fixture.workspace, {
      ".tmp/knowledge-update.lock": lockContent,
      "wiki/log.md": "# Knowledge Structural Log\n\n- update in progress\n",
    });

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.status, "locked");
    assert.equal(response.reason, "knowledge-sync-locked");
    assert.equal(readFileSync(lockPath, "utf8"), lockContent);
  });

  it("does not reclaim an old lock owned by a live process", () => {
    const fixture = createSyncFixture();
    const lockPath = join(fixture.workspace, ".tmp/knowledge-update.lock");
    const lockContent = `${JSON.stringify({
      pid: process.pid,
      acquiredAt: "2000-01-01T00:00:00.000Z",
      path: ".tmp/knowledge-update.lock",
    })}\n`;
    writeFiles(fixture.workspace, { ".tmp/knowledge-update.lock": lockContent });

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      lockNow: () => new Date("2026-08-01T12:00:00.000Z"),
      staleLockMs: 1,
    });

    assert.equal(response.ok, false);
    assert.equal(response.status, "locked");
    assert.equal(response.reason, "knowledge-sync-locked");
    assert.equal(readFileSync(lockPath, "utf8"), lockContent);
  });

  it("does not fast-forward canonical main when a fetched candidate is not Knowledge v2", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-invalid-candidate");
    const beforeHead = localHead(fixture);
    git(peer, ["rm", "wiki/index.md"]);
    git(peer, ["commit", "-m", "remove required Knowledge index"]);
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });
    const pathsAfterFirst = worktreePaths(fixture);
    const retried = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-not-knowledge-v2");
    assert.equal(response.attempts, 1);
    assert.equal(localHead(fixture), beforeHead);
    assert.equal(readFileSync(join(fixture.workspace, "wiki/index.md"), "utf8"), generateKnowledgeIndex([]));
    assert.equal(recoveryRefs(fixture).length, 2);
    assert.equal(pathsAfterFirst.length, 2);
    assert.equal(retried.ok, false);
    assert.equal(retried.reason, "candidate-not-knowledge-v2");
    assert.deepEqual(worktreePaths(fixture), pathsAfterFirst);
  });

  it("converts a post-lock Git exception into a typed failure and releases the lock", () => {
    const fixture = createSyncFixture();
    const lockPath = join(fixture.workspace, ".tmp/knowledge-update.lock");

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (gitCommand(args) === "fetch") {
          throw new Error("injected Git failure after lock acquisition");
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "knowledge-sync-failed");
    assert.match(response.message, /injected Git failure after lock acquisition/);
    assert.equal(existsSync(lockPath), false);

    const retried = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });
    assertSyncOk(retried);
  });

  it("does not include Git stdout in execution failures", () => {
    const fixture = createSyncFixture();
    const privateOutput = "private committed Knowledge bytes";

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (gitCommand(args) === "fetch") {
          return { status: 1, stdout: privateOutput, stderr: "" };
        }
        return defaultKnowledgeSyncGitRunner(args, options);
      },
    });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "fetch-failed");
    assert.equal(response.message.includes(privateOutput), false);
  });

  it("leaves canonical HEAD and files unchanged on a non-Knowledge conflict", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-conflict");
    const localReadme = "# Agent workspace\n\nLocal claim.\n";
    const remoteReadme = "# Agent workspace\n\nRemote claim.\n";
    const localTip = commitFiles(fixture.workspace, "local readme edit", { "README.md": localReadme });
    const remoteTip = commitFiles(peer, "remote readme edit", { "README.md": remoteReadme });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.status, "conflict");
    assert.equal(response.reason, "non-knowledge-conflict");
    assert.equal(response.attempts, 1);
    assert.deepEqual(response.conflictPaths, ["README.md"]);
    assert.match(response.message, /outside managed Knowledge/);
    assert.equal(localHead(fixture), localTip);
    assert.equal(readFileSync(join(fixture.workspace, "README.md"), "utf8"), localReadme);
    assert.equal(git(fixture.workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.equal(remoteHead(fixture), remoteTip);
    assert.equal(recoveryRefs(fixture).length, 2);
    assert.equal(worktreePaths(fixture).length, 2);
  });

  it("rechecks a repaired custom default merge driver instead of caching the rejection", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-custom-default-driver");
    git(fixture.workspace, ["config", "merge.default", "ours"]);
    git(fixture.workspace, ["config", "merge.ours.driver", "true"]);
    const localReadme = "# Agent workspace\n\nLocal custom-driver claim.\n";
    const remoteReadme = "# Agent workspace\n\nRemote custom-driver claim.\n";
    const localTip = commitFiles(fixture.workspace, "local custom-driver readme", { "README.md": localReadme });
    const remoteTip = commitFiles(peer, "remote custom-driver readme", { "README.md": remoteReadme });
    git(peer, ["push", "origin", "main"]);

    const response = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "unsupported-merge-driver");
    assert.equal(localHead(fixture), localTip);
    assert.equal(remoteHead(fixture), remoteTip);
    assert.equal(readFileSync(join(fixture.workspace, "README.md"), "utf8"), localReadme);

    git(fixture.workspace, ["config", "--unset", "merge.default"]);
    const retried = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(retried.ok, false);
    assert.equal(retried.reason, "non-knowledge-conflict");
  });

  it("reuses one retained candidate for repeated failures with identical tips", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-repeated-conflict");
    commitFiles(fixture.workspace, "local repeated conflict", {
      "README.md": "# Agent workspace\n\nLocal repeated claim.\n",
    });
    commitFiles(peer, "remote repeated conflict", {
      "README.md": "# Agent workspace\n\nRemote repeated claim.\n",
    });
    git(peer, ["push", "origin", "main"]);

    const first = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });
    const pathsAfterFirst = worktreePaths(fixture);
    const second = executeKnowledgeSync({ agentWorkspaceRoot: fixture.workspace });

    assert.equal(first.ok, false);
    assert.equal(first.reason, "non-knowledge-conflict");
    assert.equal(second.ok, false);
    assert.equal(second.reason, "non-knowledge-conflict");
    assert.equal(pathsAfterFirst.length, 2);
    assert.deepEqual(worktreePaths(fixture), pathsAfterFirst);
  });
});
