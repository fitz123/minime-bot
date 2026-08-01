import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
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
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKnowledgeV2Schema, resolveKnowledgeLayout } from "../knowledge/layout.js";
import { executeKnowledgeSearch } from "../knowledge/tools.js";
import {
  acquireKnowledgeUpdateLock,
  executeKnowledgeUpdate,
  formatKnowledgePage,
  formatKnowledgeUpdateResponse,
  type KnowledgeUpdateFs,
  type KnowledgeUpdateLockHandle,
  type KnowledgeUpdateResponse,
} from "../knowledge/update.js";
import { MINIME_AGENT_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

const RETIRED_AGENT_WORKSPACE_ENV = ["MINIME", "AGENT", "WORKSPACE", "CWD"].join("_");

const fixtures: string[] = [];

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relpath, content] of Object.entries(files)) {
    const path = join(root, ...relpath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

function createWorkspace(files: Record<string, string> = {}): string {
  const workspace = mkdtempSync(join(tmpdir(), "minime-knowledge-update-"));
  fixtures.push(workspace);
  writeFiles(workspace, files);
  return workspace;
}

function createV2Workspace(files: Record<string, string> = {}): string {
  return createWorkspace({
    "wiki/schema.md": generateKnowledgeV2Schema(),
    "wiki/index.md": "# Knowledge Index\n",
    ...files,
  });
}

function assertUpdateOk(response: KnowledgeUpdateResponse): asserts response is Extract<KnowledgeUpdateResponse, { ok: true }> {
  assert.equal(response.ok, true, JSON.stringify(response));
}

function pageFrontmatter(name: string, type = "project"): Record<string, unknown> {
  return {
    name,
    description: `${name} description`,
    type,
  };
}

describe("knowledge_update", () => {
  it("treats an explicit empty env as authoritative over the process env", () => {
    const workspace = createV2Workspace();
    const previous = process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
    process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV] = workspace;
    try {
      const response = executeKnowledgeUpdate(
        {
          op: "create",
          type: "project",
          slug: "ambient",
          frontmatter: pageFrontmatter("Ambient"),
          body: "# Ambient\n\nShould not be written through ambient env.\n",
        },
        { env: {} },
      );

      assert.equal(response.ok, false);
      assert.equal(response.reason, "agent-workspace-unset");
      assert.equal(existsSync(join(workspace, "wiki/pages/project/ambient.md")), false);
    } finally {
      if (previous === undefined) {
        delete process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV] = previous;
      }
    }
  });

  it("uses MINIME_AGENT_WORKSPACE_ROOT and ignores the retired agent workspace env", () => {
    const retiredWorkspace = createV2Workspace();
    const workspace = createV2Workspace();

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "canonical",
        frontmatter: pageFrontmatter("Canonical"),
        body: "# Canonical\n\nWritten through canonical env.\n",
      },
      {
        env: {
          [MINIME_AGENT_WORKSPACE_ROOT_ENV]: workspace,
          [RETIRED_AGENT_WORKSPACE_ENV]: retiredWorkspace,
        },
      },
    );

    assertUpdateOk(response);
    assert.equal(existsSync(join(workspace, "wiki/pages/project/canonical.md")), true);
    assert.equal(existsSync(join(retiredWorkspace, "wiki/pages/project/canonical.md")), false);

    const retiredOnly = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "retired",
        frontmatter: pageFrontmatter("Retired"),
        body: "# Retired\n\nShould not be written through retired env.\n",
      },
      { env: { [RETIRED_AGENT_WORKSPACE_ENV]: retiredWorkspace } },
    );

    assert.equal(retiredOnly.ok, false);
    assert.equal(retiredOnly.reason, "agent-workspace-unset");
    assert.equal(existsSync(join(retiredWorkspace, "wiki/pages/project/retired.md")), false);
  });

  it("creates a v2 page, regenerates the index, appends a structural log entry, and makes search see it", () => {
    const workspace = createV2Workspace();

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "runtime/runtime-notes",
        frontmatter: pageFrontmatter("Runtime Notes"),
        body: "# Runtime Notes\n\nAdapter work keeps ABI notes explicit.\n",
      },
      {
        agentWorkspaceRoot: workspace,
        now: () => new Date("2026-06-07T12:00:00.000Z"),
      },
    );

    assertUpdateOk(response);
    assert.equal(response.action, "created");
    assert.equal(response.path, "wiki/pages/project/runtime/runtime-notes.md");
    assert.equal(response.logPath, "wiki/log.md");

    const page = readFileSync(join(workspace, "wiki/pages/project/runtime/runtime-notes.md"), "utf8");
    assert.match(page, /^---\nname: Runtime Notes\n/s);
    assert.match(page, /type: project/);
    assert.match(page, /Adapter work keeps ABI notes explicit/);

    const index = readFileSync(join(workspace, "wiki/index.md"), "utf8");
    assert.match(index, /\[Runtime Notes\]\(pages\/project\/runtime\/runtime-notes\.md\)/);
    assert.equal(index.match(/pages\/project\/runtime\/runtime-notes\.md/g)?.length, 1);

    const log = readFileSync(join(workspace, "wiki/log.md"), "utf8");
    assert.match(log, /2026-06-07T12:00:00\.000Z create wiki\/pages\/project\/runtime\/runtime-notes\.md/);
    assert.equal(existsSync(join(workspace, ".tmp", "knowledge-update.lock")), false);

    const search = executeKnowledgeSearch(
      { query: "ABI notes", maxResults: 5 },
      { agentWorkspaceRoot: workspace },
    );
    assert.equal(search.ok, true, JSON.stringify(search));
    assert.equal(search.results[0].path, "wiki/pages/project/runtime/runtime-notes.md");
  });

  it("updates existing page content and appends an update action log", () => {
    const workspace = createV2Workspace({
      "wiki/log.md": "- 2026-06-07T12:00:00.000Z create wiki/pages/project/runtime/runtime-notes.md\n",
      "wiki/pages/project/runtime/runtime-notes.md": [
        "---",
        "name: Runtime Notes",
        "description: Runtime Notes description",
        "type: project",
        "---",
        "",
        "# Runtime Notes",
        "",
        "Old adapter notes.",
        "",
      ].join("\n"),
    });

    const response = executeKnowledgeUpdate(
      {
        op: "update",
        type: "project",
        slug: "runtime/runtime-notes",
        frontmatter: pageFrontmatter("Runtime Notes"),
        body: "# Runtime Notes\n\nUpdated adapter notes.\n",
      },
      {
        agentWorkspaceRoot: workspace,
        now: () => new Date("2026-06-08T12:00:00.000Z"),
      },
    );

    assertUpdateOk(response);
    assert.equal(response.action, "updated");
    assert.equal(response.logPath, "wiki/log.md");
    assert.match(readFileSync(join(workspace, "wiki/pages/project/runtime/runtime-notes.md"), "utf8"), /Updated adapter notes/);
    assert.equal(
      readFileSync(join(workspace, "wiki/log.md"), "utf8"),
      "- 2026-06-07T12:00:00.000Z create wiki/pages/project/runtime/runtime-notes.md\n" +
        "- 2026-06-08T12:00:00.000Z update wiki/pages/project/runtime/runtime-notes.md\n",
    );
  });

  it("archives and restores a page byte-for-byte while updating index, search, and action logs", () => {
    const relPath = "wiki/pages/project/history/issue-128-2026-05-01.md";
    const archiveRelPath = `artifacts/knowledge-archive/${relPath}`;
    const originalBytes = Buffer.from(
      [
        "---",
        "name: Archived Record",
        "description: Completed dated record",
        "type: project",
        "---",
        "",
        "# Archived Record",
        "",
        "BYTE_PRESERVATION_SEARCH_TOKEN",
        "",
      ].join("\r\n"),
      "utf8",
    );
    const workspace = createV2Workspace({
      "wiki/pages/project/current.md": [
        "---",
        "name: Current",
        "description: Current record",
        "type: project",
        "---",
        "",
        "# Current",
        "",
      ].join("\n"),
    });
    const activePath = join(workspace, ...relPath.split("/"));
    mkdirSync(dirname(activePath), { recursive: true });
    writeFileSync(activePath, originalBytes);

    const beforeSearch = executeKnowledgeSearch(
      { query: "BYTE_PRESERVATION_SEARCH_TOKEN" },
      { agentWorkspaceRoot: workspace },
    );
    assert.equal(beforeSearch.ok, true, JSON.stringify(beforeSearch));
    assert.equal(beforeSearch.results[0]?.path, relPath);

    const archived = executeKnowledgeUpdate(
      { op: "archive", path: relPath },
      {
        agentWorkspaceRoot: workspace,
        now: () => new Date("2026-06-09T12:00:00.000Z"),
      },
    );
    assertUpdateOk(archived);
    assert.equal(archived.operation, "archive");
    assert.equal(archived.action, "archived");
    if (archived.operation !== "archive") {
      assert.fail("expected archive response");
    }
    assert.equal(archived.archivePath, archiveRelPath);
    assert.equal(existsSync(activePath), false);
    assert.deepEqual(readFileSync(join(workspace, ...archiveRelPath.split("/"))), originalBytes);

    const archivedIndex = readFileSync(join(workspace, "wiki/index.md"), "utf8");
    assert.doesNotMatch(archivedIndex, /issue-128-2026-05-01/);
    assert.match(archivedIndex, /\[Current\]\(pages\/project\/current\.md\)/);
    for (const match of archivedIndex.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      assert.equal(existsSync(join(workspace, "wiki", ...match[1].split("/"))), true);
    }
    const archivedSearch = executeKnowledgeSearch(
      { query: "BYTE_PRESERVATION_SEARCH_TOKEN" },
      { agentWorkspaceRoot: workspace },
    );
    assert.equal(archivedSearch.ok, true, JSON.stringify(archivedSearch));
    assert.deepEqual(archivedSearch.results, []);

    const restored = executeKnowledgeUpdate(
      { operation: "restore", path: relPath },
      {
        agentWorkspaceRoot: workspace,
        now: () => new Date("2026-06-10T12:00:00.000Z"),
      },
    );
    assertUpdateOk(restored);
    assert.equal(restored.operation, "restore");
    assert.equal(restored.action, "restored");
    assert.equal(existsSync(join(workspace, ...archiveRelPath.split("/"))), false);
    assert.deepEqual(readFileSync(activePath), originalBytes);
    assert.match(readFileSync(join(workspace, "wiki/index.md"), "utf8"), /issue-128-2026-05-01\.md/);

    const restoredSearch = executeKnowledgeSearch(
      { query: "BYTE_PRESERVATION_SEARCH_TOKEN" },
      { agentWorkspaceRoot: workspace },
    );
    assert.equal(restoredSearch.ok, true, JSON.stringify(restoredSearch));
    assert.equal(restoredSearch.results[0]?.path, relPath);
    assert.equal(
      readFileSync(join(workspace, "wiki/log.md"), "utf8"),
      `- 2026-06-09T12:00:00.000Z archive ${relPath} -> ${archiveRelPath}\n` +
        `- 2026-06-10T12:00:00.000Z restore ${relPath} <- ${archiveRelPath}\n`,
    );
  });

  it("verifies the generated index structurally when valid names and descriptions contain Markdown syntax", () => {
    const workspace = createV2Workspace();
    const relPath = "wiki/pages/project/markdown-label.md";
    const frontmatter = {
      name: "Status [old] notes",
      description: "See [docs](https://example.invalid) for retained context",
      type: "project",
    };

    const created = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "markdown-label",
        frontmatter,
        body: "# Status\n\nMARKDOWN_LABEL_TOKEN\n",
      },
      { agentWorkspaceRoot: workspace },
    );
    assertUpdateOk(created);
    assert.match(
      readFileSync(join(workspace, "wiki/index.md"), "utf8"),
      /See \[docs\\\]\(https:\/\/example\.invalid\)/,
    );

    const archived = executeKnowledgeUpdate(
      { op: "archive", path: relPath },
      { agentWorkspaceRoot: workspace },
    );
    assertUpdateOk(archived);
    const restored = executeKnowledgeUpdate(
      { op: "restore", path: relPath },
      { agentWorkspaceRoot: workspace },
    );
    assertUpdateOk(restored);
  });

  it("logs upserts as create or update according to the resulting action", () => {
    const workspace = createV2Workspace();
    const args = {
      op: "upsert",
      type: "project",
      slug: "upserted",
      frontmatter: pageFrontmatter("Upserted"),
      body: "# Upserted\n\nFirst body.\n",
    };
    const created = executeKnowledgeUpdate(args, {
      agentWorkspaceRoot: workspace,
      now: () => new Date("2026-06-11T12:00:00.000Z"),
    });
    assertUpdateOk(created);
    assert.equal(created.action, "created");

    const updated = executeKnowledgeUpdate(
      { ...args, body: "# Upserted\n\nSecond body.\n" },
      {
        agentWorkspaceRoot: workspace,
        now: () => new Date("2026-06-12T12:00:00.000Z"),
      },
    );
    assertUpdateOk(updated);
    assert.equal(updated.action, "updated");
    assert.equal(
      readFileSync(join(workspace, "wiki/log.md"), "utf8"),
      "- 2026-06-11T12:00:00.000Z create wiki/pages/project/upserted.md\n" +
        "- 2026-06-12T12:00:00.000Z update wiki/pages/project/upserted.md\n",
    );
  });

  it("rejects non-path archive payloads, unmanaged paths, collisions, symlinks, and locks", () => {
    const relPath = "wiki/pages/project/archive-me.md";
    const archiveRelPath = `artifacts/knowledge-archive/${relPath}`;
    const page = [
      "---",
      "name: Archive Me",
      "description: Archive collision fixture",
      "type: project",
      "---",
      "",
      "# Archive Me",
      "",
    ].join("\n");
    const workspace = createV2Workspace({ [relPath]: page });

    const unexpectedPayload = executeKnowledgeUpdate(
      { op: "archive", path: relPath, type: "project" },
      { agentWorkspaceRoot: workspace },
    );
    assert.equal(unexpectedPayload.ok, false);
    assert.equal(unexpectedPayload.reason, "unexpected-move-payload");

    const unmanaged = executeKnowledgeUpdate(
      { op: "archive", path: "artifacts/archive-me.md" },
      { agentWorkspaceRoot: workspace },
    );
    assert.equal(unmanaged.ok, false);
    assert.equal(unmanaged.reason, "path-not-managed-page");

    writeFiles(workspace, { [archiveRelPath]: page });
    const duplicate = executeKnowledgeUpdate(
      { op: "archive", path: relPath },
      { agentWorkspaceRoot: workspace },
    );
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, "active-archive-collision");
    rmSync(join(workspace, "artifacts"), { recursive: true, force: true });

    const lockPath = join(workspace, ".tmp", "knowledge-update.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 1, acquiredAt: "2026-06-13T12:00:00.000Z" })}\n`,
      "utf8",
    );
    const locked = executeKnowledgeUpdate(
      { op: "archive", path: relPath },
      {
        agentWorkspaceRoot: workspace,
        lockNow: () => new Date("2026-06-13T12:00:01.000Z"),
        staleLockMs: 60_000,
      },
    );
    assert.equal(locked.ok, false);
    assert.equal(locked.status, "locked");
    rmSync(lockPath, { force: true });

    const outside = createWorkspace();
    mkdirSync(join(workspace, "artifacts"), { recursive: true });
    symlinkSync(outside, join(workspace, "artifacts", "knowledge-archive"), "dir");
    const symlinked = executeKnowledgeUpdate(
      { op: "archive", path: relPath },
      { agentWorkspaceRoot: workspace },
    );
    assert.equal(symlinked.ok, false);
    assert.equal(symlinked.reason, "symlink-escape");
    assert.equal(existsSync(join(outside, ...relPath.split("/"))), false);
    assert.equal(readFileSync(join(workspace, ...relPath.split("/")), "utf8"), page);
  });

  it("rejects occupied one-sided archive and restore destinations without overwriting", () => {
    const relPath = "wiki/pages/project/collision.md";
    const archiveRelPath = `artifacts/knowledge-archive/${relPath}`;
    const page = [
      "---",
      "name: Collision",
      "description: Collision fixture",
      "type: project",
      "---",
      "",
      "# Collision",
      "",
    ].join("\n");
    const archivedOnly = createV2Workspace({ [archiveRelPath]: page });
    const archiveAgain = executeKnowledgeUpdate(
      { op: "archive", path: relPath },
      { agentWorkspaceRoot: archivedOnly },
    );
    assert.equal(archiveAgain.ok, false);
    assert.equal(archiveAgain.reason, "archive-destination-exists");
    assert.equal(readFileSync(join(archivedOnly, ...archiveRelPath.split("/")), "utf8"), page);

    const activeOnly = createV2Workspace({ [relPath]: page });
    const restoreOverActive = executeKnowledgeUpdate(
      { op: "restore", path: relPath },
      { agentWorkspaceRoot: activeOnly },
    );
    assert.equal(restoreOverActive.ok, false);
    assert.equal(restoreOverActive.reason, "active-destination-exists");
    assert.equal(readFileSync(join(activeOnly, ...relPath.split("/")), "utf8"), page);
  });

  it("atomically rejects an archive destination created during the move", () => {
    const relPath = "wiki/pages/project/destination-race.md";
    const archiveRelPath = `artifacts/knowledge-archive/${relPath}`;
    const page = [
      "---",
      "name: Destination Race",
      "description: Destination no-clobber fixture",
      "type: project",
      "---",
      "",
      "# Destination Race",
      "",
    ].join("\n");
    const independentDestination = "independently created archive destination\n";
    const workspace = createV2Workspace({ [relPath]: page });
    const sourcePath = join(workspace, ...relPath.split("/"));
    const destinationPath = join(workspace, ...archiveRelPath.split("/"));
    let injected = false;

    const response = executeKnowledgeUpdate(
      { op: "archive", path: relPath },
      {
        agentWorkspaceRoot: workspace,
        fs: {
          linkSync(from, to) {
            if (!injected && from === sourcePath && to === destinationPath) {
              injected = true;
              writeFileSync(destinationPath, independentDestination, "utf8");
            }
            return linkSync(from, to);
          },
        },
      },
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.equal(response.reason, "archive-destination-exists");
    assert.equal(readFileSync(sourcePath, "utf8"), page);
    assert.equal(readFileSync(destinationPath, "utf8"), independentDestination);
  });

  it("rolls archive and restore back when their move, transaction write, or search refresh fails", () => {
    const relPath = "wiki/pages/project/rollback-move.md";
    const archiveRelPath = `artifacts/knowledge-archive/${relPath}`;
    const page = [
      "---",
      "name: Rollback Move",
      "description: Rollback fixture",
      "type: project",
      "---",
      "",
      "# Rollback Move",
      "",
      "ROLLBACK_MOVE_TOKEN",
      "",
    ].join("\n");

    for (const operation of ["archive", "restore"] as const) {
      for (const failureKind of ["move", "byte-drift", "write", "refresh", "refresh-rollback"] as const) {
        const originalIndex = "# Knowledge Index\n";
        const originalLog = "- prior entry\n";
        const workspace = createV2Workspace({
          [operation === "archive" ? relPath : archiveRelPath]: page,
          "wiki/index.md": originalIndex,
          "wiki/log.md": originalLog,
        });
        const activePath = join(workspace, ...relPath.split("/"));
        const archivePath = join(workspace, ...archiveRelPath.split("/"));
        const sourcePath = operation === "archive" ? activePath : archivePath;
        const destinationPath = operation === "archive" ? archivePath : activePath;
        let moveFailureInjected = false;
        const fs =
          failureKind === "move"
            ? {
                unlinkSync(path: Parameters<typeof unlinkSync>[0]) {
                  if (!moveFailureInjected && path === sourcePath) {
                    moveFailureInjected = true;
                    unlinkSync(path);
                    throw new Error("forced move failure");
                  }
                  return unlinkSync(path);
                },
              }
            : failureKind === "byte-drift"
              ? {
                  unlinkSync(path: Parameters<typeof unlinkSync>[0]) {
                    const result = unlinkSync(path);
                    if (!moveFailureInjected && path === sourcePath) {
                      moveFailureInjected = true;
                      writeFileSync(
                        destinationPath,
                        page.replace("# Rollback Move", "# Corrupted Move"),
                        "utf8",
                      );
                    }
                    return result;
                  },
                }
              : failureKind === "write"
              ? {
                  writeFileSync(path: Parameters<typeof writeFileSync>[0], ...args: unknown[]) {
                    if (typeof path === "string" && path.includes(".index.md.") && path.endsWith(".tmp")) {
                      throw new Error("forced transaction write failure");
                    }
                    return (writeFileSync as (...values: unknown[]) => void)(path, ...args);
                  },
                }
              : undefined;
        let refreshCalls = 0;

        const response = executeKnowledgeUpdate(
          { op: operation, path: relPath },
          {
            agentWorkspaceRoot: workspace,
            ...(fs ? { fs } : {}),
            ...(failureKind === "refresh" || failureKind === "refresh-rollback"
              ? {
                  refreshSearchBackend() {
                    refreshCalls += 1;
                    if (refreshCalls === 1 || failureKind === "refresh-rollback") {
                      throw new Error("forced search refresh failure");
                    }
                    assert.equal(existsSync(sourcePath), true);
                    assert.equal(existsSync(destinationPath), false);
                  },
                }
              : {}),
          },
        );
        assert.equal(response.ok, false, `${operation}:${failureKind}`);
        if (failureKind === "byte-drift") {
          assert.equal(response.reason, "move-byte-mismatch");
        }
        if (failureKind === "refresh-rollback") {
          assert.equal(response.reason, "knowledge-update-search-rollback-failed");
        }
        if (failureKind === "refresh") {
          assert.equal(refreshCalls, 2);
        }
        assert.equal(existsSync(sourcePath), true, `${operation}:${failureKind}`);
        assert.equal(existsSync(destinationPath), false, `${operation}:${failureKind}`);
        assert.equal(readFileSync(sourcePath, "utf8"), page, `${operation}:${failureKind}`);
        assert.equal(readFileSync(join(workspace, "wiki/index.md"), "utf8"), originalIndex, `${operation}:${failureKind}`);
        assert.equal(readFileSync(join(workspace, "wiki/log.md"), "utf8"), originalLog, `${operation}:${failureKind}`);
        const search = executeKnowledgeSearch(
          { query: "ROLLBACK_MOVE_TOKEN" },
          { agentWorkspaceRoot: workspace },
        );
        assert.equal(search.ok, true, JSON.stringify(search));
        if (operation === "archive") {
          assert.equal(search.results[0]?.path, relPath, failureKind);
        } else {
          assert.deepEqual(search.results, [], failureKind);
        }
      }
    }
  });

  it("rejects create for an existing page without changing page, index, or log", () => {
    const pagePath = "wiki/pages/project/runtime/runtime-notes.md";
    const existingPage = [
      "---",
      "name: Runtime Notes",
      "description: Runtime Notes description",
      "type: project",
      "---",
      "",
      "# Runtime Notes",
      "",
      "Original content.",
      "",
    ].join("\n");
    const existingIndex = "# Knowledge Index\n\n- [Runtime Notes](pages/project/runtime/runtime-notes.md) - Runtime Notes description\n";
    const existingLog = "- prior entry\n";
    const workspace = createV2Workspace({
      [pagePath]: existingPage,
      "wiki/index.md": existingIndex,
      "wiki/log.md": existingLog,
    });

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "runtime/runtime-notes",
        frontmatter: pageFrontmatter("Runtime Notes"),
        body: "# Runtime Notes\n\nReplacement content.\n",
      },
      { agentWorkspaceRoot: workspace },
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.equal(response.reason, "page-exists");
    assert.equal(readFileSync(join(workspace, pagePath), "utf8"), existingPage);
    assert.equal(readFileSync(join(workspace, "wiki/index.md"), "utf8"), existingIndex);
    assert.equal(readFileSync(join(workspace, "wiki/log.md"), "utf8"), existingLog);
  });

  it("rejects update for a missing page without creating page, index, or log", () => {
    const existingIndex = "# Knowledge Index\n";
    const workspace = createV2Workspace({
      "wiki/index.md": existingIndex,
    });

    const response = executeKnowledgeUpdate(
      {
        op: "update",
        type: "project",
        slug: "missing",
        frontmatter: pageFrontmatter("Missing"),
        body: "# Missing\n\nShould not be created.\n",
      },
      { agentWorkspaceRoot: workspace },
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.equal(response.reason, "page-missing");
    assert.equal(existsSync(join(workspace, "wiki/pages/project/missing.md")), false);
    assert.equal(readFileSync(join(workspace, "wiki/index.md"), "utf8"), existingIndex);
    assert.equal(existsSync(join(workspace, "wiki/log.md")), false);
  });

  it("rejects invalid nested frontmatter before writing", () => {
    const workspace = createV2Workspace();

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "nested",
        frontmatter: {
          name: "Nested",
          description: "Nested description",
          type: "project",
          metadata: { confidence: "high" },
        },
        body: "# Nested\n",
      },
      { agentWorkspaceRoot: workspace },
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.equal(response.reason, "nested-metadata-frontmatter");
    assert.match(formatKnowledgeUpdateResponse(response), /nested-metadata-frontmatter/);
    assert.equal(existsSync(join(workspace, "wiki/pages/project/nested.md")), false);
  });

  it("rejects traversal and symlink escape writes", () => {
    const outside = createWorkspace();
    const workspace = createV2Workspace();
    mkdirSync(join(workspace, "wiki/pages/project"), { recursive: true });
    symlinkSync(outside, join(workspace, "wiki/pages/project/escaped"));

    for (const badArgs of [
      { slug: "../secret" },
      { path: "wiki/pages/project/../secret.md" },
      { path: "/tmp/secret.md" },
      { path: "wiki/pages/project/escaped/secret.md" },
    ]) {
      const response = executeKnowledgeUpdate(
        {
          op: "upsert",
          type: "project",
          frontmatter: pageFrontmatter("Secret"),
          body: "# Secret\n",
          ...badArgs,
        },
        { agentWorkspaceRoot: workspace },
      );
      assert.equal(response.ok, false, JSON.stringify(response));
      assert.equal(response.status, "rejected");
    }

    assert.equal(existsSync(join(outside, "secret.md")), false);
  });

  it("rejects managed paths with control characters that could forge structural log entries", () => {
    const workspace = createV2Workspace();

    for (const path of [
      "wiki/pages/project/forged\n- 2026-07-29T00:00:00.000Z archive fake.md",
      "wiki/pages/project/forged\rentry.md",
      "wiki/pages/project/forged\tentry.md",
    ]) {
      const response = executeKnowledgeUpdate(
        { op: "archive", path },
        { agentWorkspaceRoot: workspace },
      );
      assert.equal(response.ok, false, path);
      assert.equal(response.status, "rejected", path);
      assert.equal(response.reason, "invalid-path", path);
    }

    assert.equal(existsSync(join(workspace, "wiki/log.md")), false);
  });

  it("preserves existing managed filenames and safely serializes their index links", () => {
    const relPath = "wiki/pages/project/Legacy Notes (β)+#?.md";
    const workspace = createV2Workspace({
      [relPath]: formatKnowledgePage(
        {
          name: "Legacy Notes",
          description: "Legacy Notes description",
          type: "project",
        },
        "# Legacy\n",
      ),
    });

    const created = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "unrelated",
        frontmatter: pageFrontmatter("Unrelated"),
        body: "# Unrelated\n",
      },
      { agentWorkspaceRoot: workspace, now: () => new Date("2026-07-29T01:00:00.000Z") },
    );
    assertUpdateOk(created);
    assert.match(
      readFileSync(join(workspace, "wiki/index.md"), "utf8"),
      /\(pages\/project\/Legacy%20Notes%20%28%CE%B2%29%2B%23%3F\.md\)/,
    );

    const archived = executeKnowledgeUpdate(
      { op: "archive", path: relPath },
      { agentWorkspaceRoot: workspace, now: () => new Date("2026-07-29T02:00:00.000Z") },
    );
    assertUpdateOk(archived);
    assert.match(
      readFileSync(join(workspace, "wiki/log.md"), "utf8"),
      / archive wiki\/pages\/project\/Legacy Notes \(β\)\+#\?\.md -> artifacts\/knowledge-archive\//,
    );

    const restored = executeKnowledgeUpdate(
      { op: "restore", path: relPath },
      { agentWorkspaceRoot: workspace, now: () => new Date("2026-07-29T03:00:00.000Z") },
    );
    assertUpdateOk(restored);
    assert.equal(existsSync(join(workspace, ...relPath.split("/"))), true);
  });

  it("rejects legacy and Karpathy-style non-v2 wiki layouts", () => {
    const legacy = createWorkspace({
      "MEMORY.md": "# Memory\n",
    });
    const karpathy = createWorkspace({
      "wiki/schema.md": [
        "---",
        "format: karpathy-llm-wiki",
        "version: 1",
        "---",
        "",
        "# Wiki Schema",
        "",
      ].join("\n"),
      "wiki/index.md": "# Index\n",
    });

    const legacyResponse = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "runtime",
        frontmatter: pageFrontmatter("Runtime"),
        body: "# Runtime\n",
      },
      { agentWorkspaceRoot: legacy },
    );
    assert.equal(legacyResponse.ok, false);
    assert.equal(legacyResponse.status, "unsupported");
    assert.equal(legacyResponse.layoutKind, "legacy");

    const karpathyResponse = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "runtime",
        frontmatter: pageFrontmatter("Runtime"),
        body: "# Runtime\n",
      },
      { agentWorkspaceRoot: karpathy },
    );
    assert.equal(karpathyResponse.ok, false);
    assert.equal(karpathyResponse.status, "unsupported");
    assert.equal(karpathyResponse.layoutKind, "none");
  });

  it("rolls back committed files when a multi-file write fails", () => {
    const workspace = createV2Workspace({
      "wiki/log.md": "- prior entry\n",
    });
    let renameCount = 0;

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "rollback",
        frontmatter: pageFrontmatter("Rollback"),
        body: "# Rollback\n",
      },
      {
        agentWorkspaceRoot: workspace,
        fs: {
          renameSync(from, to) {
            renameCount += 1;
            if (renameCount === 3) {
              throw new Error(`forced rename failure for ${to}`);
            }
            return renameSync(from, to);
          },
        },
      },
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, "error");
    assert.equal(response.reason, "knowledge-update-failed");
    assert.equal(existsSync(join(workspace, "wiki/pages/project/rollback.md")), false);
    assert.equal(readFileSync(join(workspace, "wiki/index.md"), "utf8"), "# Knowledge Index\n");
    assert.equal(readFileSync(join(workspace, "wiki/log.md"), "utf8"), "- prior entry\n");
  });

  it("refreshes restored search state after a write refresh fails", () => {
    for (const rollbackRefreshFails of [false, true]) {
      const workspace = createV2Workspace();
      let refreshCalls = 0;
      let indexed = readFileSync(join(workspace, "wiki/index.md"), "utf8");

      const response = executeKnowledgeUpdate(
        {
          op: "create",
          type: "project",
          slug: "refresh-rollback",
          frontmatter: pageFrontmatter("Refresh Rollback"),
          body: "# Refresh Rollback\n",
        },
        {
          agentWorkspaceRoot: workspace,
          refreshSearchBackend(layout) {
            refreshCalls += 1;
            indexed = readFileSync(layout.paths.indexPath, "utf8");
            if (refreshCalls === 1 || rollbackRefreshFails) {
              throw new Error("forced search refresh failure");
            }
          },
        },
      );

      assert.equal(response.ok, false);
      assert.equal(
        response.reason,
        rollbackRefreshFails
          ? "knowledge-update-search-rollback-failed"
          : "knowledge-update-verify-failed",
      );
      assert.equal(refreshCalls, 2);
      assert.equal(indexed, "# Knowledge Index\n");
      assert.equal(existsSync(join(workspace, "wiki/pages/project/refresh-rollback.md")), false);
      assert.equal(existsSync(join(workspace, "wiki/log.md")), false);
    }
  });

  it("recovers stale locks and rejects fresh concurrent locks", () => {
    const workspace = createV2Workspace();
    const lockPath = join(workspace, ".tmp", "knowledge-update.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 1, acquiredAt: "2026-06-07T11:00:00.000Z" })}\n`,
      "utf8",
    );

    const stale = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "stale-lock",
        frontmatter: pageFrontmatter("Stale Lock"),
        body: "# Stale Lock\n",
      },
      {
        agentWorkspaceRoot: workspace,
        lockNow: () => new Date("2026-06-07T12:00:00.000Z"),
        staleLockMs: 1_000,
        isProcessAlive: () => false,
      },
    );
    assertUpdateOk(stale);

    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 1, acquiredAt: "2026-06-07T12:00:00.000Z" })}\n`,
      "utf8",
    );
    const fresh = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "fresh-lock",
        frontmatter: pageFrontmatter("Fresh Lock"),
        body: "# Fresh Lock\n",
      },
      {
        agentWorkspaceRoot: workspace,
        lockNow: () => new Date("2026-06-07T12:00:01.000Z"),
        staleLockMs: 60_000,
      },
    );

    assert.equal(fresh.ok, false);
    assert.equal(fresh.status, "locked");
    rmSync(lockPath, { force: true });
  });

  it("serializes stale-lock reclamation against another cooperative caller", () => {
    const workspace = createV2Workspace();
    const layout = resolveKnowledgeLayout(workspace);
    assert.equal(layout.kind, "v2");
    if (layout.kind !== "v2") {
      return;
    }
    const lockPath = join(workspace, ".tmp/knowledge-update.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 999_999, acquiredAt: "2000-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );
    let nestedLock: KnowledgeUpdateLockHandle | ReturnType<typeof executeKnowledgeUpdate> | undefined;
    let interleaveOnPrimaryUnlink = true;
    const lockFs: KnowledgeUpdateFs = {
      closeSync,
      existsSync,
      linkSync,
      lstatSync,
      mkdirSync,
      openSync,
      readFileSync,
      readdirSync,
      realpathSync,
      renameSync,
      statSync,
      unlinkSync: ((path: Parameters<typeof unlinkSync>[0]) => {
        if (interleaveOnPrimaryUnlink && path === lockPath) {
          interleaveOnPrimaryUnlink = false;
          nestedLock = acquireKnowledgeUpdateLock(layout, lockFs, {
            lockNow: () => new Date("2026-08-01T12:00:00.000Z"),
            staleLockMs: 1,
            isProcessAlive: () => false,
          });
        }
        unlinkSync(path);
      }) as typeof unlinkSync,
      writeFileSync,
    };

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "serialized-reclaim",
        frontmatter: pageFrontmatter("Serialized Reclaim"),
        body: "# Serialized Reclaim\n",
      },
      {
        agentWorkspaceRoot: workspace,
        fs: lockFs,
        lockNow: () => new Date("2026-08-01T12:00:00.000Z"),
        staleLockMs: 1,
        isProcessAlive: () => false,
      },
    );

    assertUpdateOk(response);
    assert.ok(nestedLock && "ok" in nestedLock && nestedLock.ok === false);
    assert.equal(nestedLock.status, "locked");
  });

  it("recovers an abandoned stale-lock reclamation claim", () => {
    const workspace = createV2Workspace();
    const lockPath = join(workspace, ".tmp/knowledge-update.lock");
    const reclaimPath = `${lockPath}.reclaim`;
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({ pid: 999_999, acquiredAt: "2000-01-01T00:00:00.000Z" })}\n`,
      "utf8",
    );
    linkSync(lockPath, reclaimPath);

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "abandoned-reclaim",
        frontmatter: pageFrontmatter("Abandoned Reclaim"),
        body: "# Abandoned Reclaim\n",
      },
      {
        agentWorkspaceRoot: workspace,
        lockNow: () => new Date(Date.now() + 60_000),
        staleLockMs: 1,
        isProcessAlive: () => false,
      },
    );

    assertUpdateOk(response);
    assert.equal(existsSync(lockPath), false);
    assert.equal(existsSync(reclaimPath), false);
  });

  it("reclaims an expired lock when its PID belongs to a different process instance", () => {
    const workspace = createV2Workspace();
    const lockPath = join(workspace, ".tmp/knowledge-update.lock");
    mkdirSync(dirname(lockPath), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 42,
        acquiredAt: "2000-01-01T00:00:00.000Z",
        processIdentity: "old-process-instance",
      })}\n`,
      "utf8",
    );

    let acquiredProcessIdentity: unknown;
    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "reused-pid",
        frontmatter: pageFrontmatter("Reused PID"),
        body: "# Reused PID\n",
      },
      {
        agentWorkspaceRoot: workspace,
        lockNow: () => new Date("2026-08-01T12:00:00.000Z"),
        staleLockMs: 1,
        isProcessAlive: () => true,
        getProcessIdentity: (pid) => pid === 42 ? "new-process-instance" : "current-process-instance",
        refreshSearchBackend: () => {
          acquiredProcessIdentity = (JSON.parse(readFileSync(lockPath, "utf8")) as { processIdentity?: unknown })
            .processIdentity;
        },
      },
    );

    assertUpdateOk(response);
    assert.equal(acquiredProcessIdentity, "current-process-instance");
  });

  it("does not release a lock that has been replaced by a successor", () => {
    const workspace = createV2Workspace();
    const lockPath = join(workspace, ".tmp/knowledge-update.lock");
    const successorLock = `${JSON.stringify({
      pid: process.pid,
      acquiredAt: "2026-06-07T12:00:01.000Z",
      path: ".tmp/knowledge-update.lock",
      token: "successor-token",
    })}\n`;

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "successor-lock",
        frontmatter: pageFrontmatter("Successor Lock"),
        body: "# Successor Lock\n",
      },
      {
        agentWorkspaceRoot: workspace,
        refreshSearchBackend: () => {
          writeFileSync(lockPath, successorLock, "utf8");
        },
      },
    );

    assertUpdateOk(response);
    assert.equal(readFileSync(lockPath, "utf8"), successorLock);
  });

  it("rejects symlinked lock directory before creating the update lock", () => {
    const outside = createWorkspace();
    const workspace = createV2Workspace();
    symlinkSync(outside, join(workspace, ".tmp"), "dir");

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "locked",
        frontmatter: pageFrontmatter("Locked"),
        body: "# Locked\n",
      },
      { agentWorkspaceRoot: workspace },
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.equal(response.reason, "symlink-escape");
    assert.equal(existsSync(join(outside, "knowledge-update.lock")), false);
    assert.equal(existsSync(join(workspace, "wiki/pages/project/locked.md")), false);
  });

  it("rejects symlinked wiki log before reading or replacing it", () => {
    const outside = createWorkspace({
      "external-log.md": "outside private log\n",
    });
    const workspace = createV2Workspace();
    symlinkSync(join(outside, "external-log.md"), join(workspace, "wiki/log.md"));

    const response = executeKnowledgeUpdate(
      {
        op: "create",
        type: "project",
        slug: "log-symlink",
        frontmatter: pageFrontmatter("Log Symlink"),
        body: "# Log Symlink\n",
      },
      { agentWorkspaceRoot: workspace },
    );

    assert.equal(response.ok, false);
    assert.equal(response.status, "rejected");
    assert.equal(response.reason, "symlink-escape");
    assert.equal(lstatSync(join(workspace, "wiki/log.md")).isSymbolicLink(), true);
    assert.equal(readFileSync(join(outside, "external-log.md"), "utf8"), "outside private log\n");
    assert.equal(existsSync(join(workspace, "wiki/pages/project/log-symlink.md")), false);
  });
});
