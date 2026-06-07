import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import { executeKnowledgeSearch } from "../knowledge/tools.js";
import {
  executeKnowledgeUpdate,
  formatKnowledgeUpdateResponse,
  type KnowledgeUpdateResponse,
} from "../knowledge/update.js";

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

  it("updates existing page content without appending a structural log entry", () => {
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
      { agentWorkspaceRoot: workspace },
    );

    assertUpdateOk(response);
    assert.equal(response.action, "updated");
    assert.equal(response.logPath, undefined);
    assert.match(readFileSync(join(workspace, "wiki/pages/project/runtime/runtime-notes.md"), "utf8"), /Updated adapter notes/);
    assert.equal(
      readFileSync(join(workspace, "wiki/log.md"), "utf8"),
      "- 2026-06-07T12:00:00.000Z create wiki/pages/project/runtime/runtime-notes.md\n",
    );
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
        now: () => new Date("2026-06-07T12:00:00.000Z"),
        staleLockMs: 1_000,
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
        now: () => new Date("2026-06-07T12:00:01.000Z"),
        staleLockMs: 60_000,
      },
    );

    assert.equal(fresh.ok, false);
    assert.equal(fresh.status, "locked");
    rmSync(lockPath, { force: true });
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
