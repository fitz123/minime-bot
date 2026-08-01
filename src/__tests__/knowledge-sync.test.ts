import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import { formatKnowledgePage, generateKnowledgeIndex } from "../knowledge/update.js";
import {
  defaultKnowledgeSyncGitRunner,
  executeKnowledgeSync,
  type KnowledgeSyncResponse,
} from "../knowledge/sync.js";

interface SyncFixture {
  root: string;
  workspace: string;
  remote: string;
}

const fixtures: string[] = [];

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`,
  );
  return result.stdout.trim();
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
          if (args[0] === "push") {
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
        if (!raced && args[0] === "push") {
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
        if (args[0] === "push") {
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

  it("retains recovery refs after an interrupted push and completes idempotently on retry", () => {
    const fixture = createSyncFixture();
    const peer = cloneRemote(fixture, "peer-interrupted");
    const localTip = commitFiles(fixture.workspace, "local interrupted entry", {
      "diary/local-interrupted.md": "# Local before interruption\n",
    });
    const remoteTip = commitFiles(peer, "remote interrupted entry", {
      "diary/remote-interrupted.md": "# Remote before interruption\n",
    });
    git(peer, ["push", "origin", "main"]);
    let refusedPush = false;

    const interrupted = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (!refusedPush && args[0] === "push") {
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

    assert.equal(response.ok, false);
    assert.equal(response.reason, "candidate-not-knowledge-v2");
    assert.equal(response.attempts, 1);
    assert.equal(localHead(fixture), beforeHead);
    assert.equal(readFileSync(join(fixture.workspace, "wiki/index.md"), "utf8"), generateKnowledgeIndex([]));
    assert.equal(recoveryRefs(fixture).length, 2);
    assert.equal(worktreePaths(fixture).length, 2);
  });

  it("converts a post-lock Git exception into a typed failure and releases the lock", () => {
    const fixture = createSyncFixture();
    const lockPath = join(fixture.workspace, ".tmp/knowledge-update.lock");

    const response = executeKnowledgeSync({
      agentWorkspaceRoot: fixture.workspace,
      git: (args, options) => {
        if (args[0] === "fetch") {
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
});
