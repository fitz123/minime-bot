import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import {
  executeKnowledgeGet,
  executeKnowledgeSearch,
  formatKnowledgeToolResponse,
  type KnowledgeGetResponse,
  type KnowledgeSearchResponse,
} from "../knowledge/tools.js";

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
  const workspace = mkdtempSync(join(tmpdir(), "minime-knowledge-tools-"));
  fixtures.push(workspace);
  writeFiles(workspace, files);
  return workspace;
}

function createV2Workspace(files: Record<string, string> = {}): string {
  return createWorkspace({
    "wiki/schema.md": generateKnowledgeV2Schema(),
    "wiki/index.md": [
      "# Knowledge Index",
      "",
      "- [Runtime Notes](pages/project/runtime/runtime-notes.md) - C++/Node.js adapter work.",
      "- [User Preferences](pages/user/preferences.md)",
      "",
    ].join("\n"),
    ...files,
  });
}

function assertSearchOk(response: KnowledgeSearchResponse): asserts response is Extract<KnowledgeSearchResponse, { ok: true }> {
  assert.equal(response.ok, true, JSON.stringify(response));
}

function assertGetOk(response: KnowledgeGetResponse): asserts response is Extract<KnowledgeGetResponse, { ok: true }> {
  assert.equal(response.ok, true, JSON.stringify(response));
}

describe("knowledge tools", () => {
  it("searches v2 index and pages with punctuation-heavy queries", () => {
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime/runtime-notes.md": [
        "---",
        "name: Runtime Notes",
        "description: Notes about the C++ and Node.js bridge",
        "type: project",
        "---",
        "",
        "# Runtime Notes",
        "",
        "The C++/Node.js adapter should keep ABI details explicit.",
        "",
      ].join("\n"),
      "diary/2026-06-07.md": "# Diary\n\nC++/Node.js appeared in a debugging narrative.\n",
    });

    const response = executeKnowledgeSearch(
      { query: "C++/Node.js adapter", maxResults: 5 },
      { agentWorkspaceRoot: workspace },
    );

    assertSearchOk(response);
    assert.equal(response.layoutKind, "v2");
    assert.equal(response.scope, "auto");
    assert.equal(response.results.length, 2);
    assert.equal(response.results[0].path, "wiki/pages/project/runtime/runtime-notes.md");
    assert.equal(response.results[0].title, "Runtime Notes");
    assert.equal(response.results[0].heading, "Runtime Notes");
    assert.equal(response.results[0].sourceKind, "wiki");
    assert.equal(response.results[0].authority, "durable synthesized knowledge; verify freshness for time-sensitive facts");
    assert.equal(response.results[0].rank, 1);
    assert.match(response.results[0].snippet, /C\+\+\/Node\.js adapter/);
    assert.equal(response.results[1].path, "wiki/index.md");
    assert.equal(response.results[1].sourceKind, "index");
  });

  it("searches legacy default and diary scopes", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n\n- [Shipping](memory/auto/shipping.md)\n",
      "memory/auto/shipping.md": "# Shipping\n\nRelease notes mention ferrite planning.\n",
      "memory/diary/2026-06-07.md": "# Diary\n\nFerrite was discussed informally.\n",
    });

    const defaultResponse = executeKnowledgeSearch(
      { query: "ferrite", scope: "default" },
      { agentWorkspaceRoot: workspace },
    );
    assertSearchOk(defaultResponse);
    assert.equal(defaultResponse.layoutKind, "legacy");
    assert.deepEqual(
      defaultResponse.results.map((result) => result.path),
      ["memory/auto/shipping.md"],
    );
    assert.equal(defaultResponse.results[0].sourceKind, "auto");

    const diaryResponse = executeKnowledgeSearch(
      { query: "ferrite", scope: "diary" },
      { agentWorkspaceRoot: workspace },
    );
    assertSearchOk(diaryResponse);
    assert.deepEqual(
      diaryResponse.results.map((result) => result.path),
      ["memory/diary/2026-06-07.md"],
    );
    assert.equal(diaryResponse.results[0].authority, "narrative/history; stale-prone");
  });

  it("returns unavailable JSON for no-layout workspaces", () => {
    const workspace = createWorkspace({
      "notes.md": "# Notes\n",
    });

    const search = executeKnowledgeSearch({ query: "notes" }, { agentWorkspaceRoot: workspace });
    assert.equal(search.ok, false);
    assert.equal(search.status, "unavailable");
    assert.equal(search.reason, "knowledge-layout-unavailable");
    assert.equal(search.results.length, 0);
    assert.match(formatKnowledgeToolResponse(search), /"ok": false/);

    const get = executeKnowledgeGet({ path: "notes.md" }, { agentWorkspaceRoot: workspace });
    assert.equal(get.ok, false);
    assert.equal(get.status, "unavailable");
    assert.equal(get.reason, "knowledge-layout-unavailable");
  });

  it("returns unavailable JSON when the agent workspace is unset", () => {
    const search = executeKnowledgeSearch({ query: "notes" }, { env: {} });
    assert.equal(search.ok, false);
    assert.equal(search.status, "unavailable");
    assert.equal(search.reason, "agent-workspace-unset");
    assert.equal(search.results.length, 0);
    assert.match(formatKnowledgeToolResponse(search), /"agent-workspace-unset"/);

    const get = executeKnowledgeGet({ path: "wiki/index.md" }, { env: {} });
    assert.equal(get.ok, false);
    assert.equal(get.status, "unavailable");
    assert.equal(get.reason, "agent-workspace-unset");
  });

  it("rejects traversal, absolute, non-corpus, non-markdown, and symlink escape reads", () => {
    const outside = createWorkspace({
      "secret.md": "# Secret\n",
    });
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime/runtime-notes.md": "# Runtime Notes\n\nVisible knowledge.\n",
      "wiki/pages/project/runtime/not-markdown.txt": "Nope\n",
      "raw/source.md": "# Raw\n",
    });
    symlinkSync(join(outside, "secret.md"), join(workspace, "wiki", "pages", "project", "runtime", "escaped.md"));

    for (const path of [
      "../secret.md",
      "/tmp/secret.md",
      "wiki/pages/project/runtime/not-markdown.txt",
      "raw/source.md",
      "wiki/pages/project/runtime/escaped.md",
    ]) {
      const response = executeKnowledgeGet({ path }, { agentWorkspaceRoot: workspace });
      assert.equal(response.ok, false, path);
      assert.equal(response.status, "rejected", path);
    }
  });

  it("does not index exact corpus files or corpus roots that are symlinked", () => {
    const outsideExact = createWorkspace({
      "index.md": "# Secret Index\n\noutside-exact-token\n",
      "MEMORY.md": "# Secret Memory\n\noutside-legacy-token\n",
    });
    const v2Workspace = createWorkspace({
      "wiki/schema.md": generateKnowledgeV2Schema(),
    });
    symlinkSync(join(outsideExact, "index.md"), join(v2Workspace, "wiki", "index.md"));

    const v2Search = executeKnowledgeSearch(
      { query: "outside-exact-token" },
      { agentWorkspaceRoot: v2Workspace },
    );
    assert.equal(v2Search.ok, false);
    assert.equal(v2Search.reason, "knowledge-layout-unavailable");

    const v2Get = executeKnowledgeGet(
      { path: "wiki/index.md" },
      { agentWorkspaceRoot: v2Workspace },
    );
    assert.equal(v2Get.ok, false);
    assert.equal(v2Get.reason, "knowledge-layout-unavailable");

    const legacyWorkspace = createWorkspace();
    symlinkSync(join(outsideExact, "MEMORY.md"), join(legacyWorkspace, "MEMORY.md"));
    const legacySearch = executeKnowledgeSearch(
      { query: "outside-legacy-token" },
      { agentWorkspaceRoot: legacyWorkspace },
    );
    assert.equal(legacySearch.ok, false);
    assert.equal(legacySearch.reason, "knowledge-layout-unavailable");

    const outsidePages = createWorkspace({
      "runtime.md": "# Runtime\n\nzzoutsidezz\n",
    });
    const rootSymlinkWorkspace = createV2Workspace();
    symlinkSync(outsidePages, join(rootSymlinkWorkspace, "wiki", "pages"), "dir");
    const rootSymlinkSearch = executeKnowledgeSearch(
      { query: "zzoutsidezz" },
      { agentWorkspaceRoot: rootSymlinkWorkspace },
    );
    assertSearchOk(rootSymlinkSearch);
    assert.deepEqual(rootSymlinkSearch.results, []);

    const rawRootSymlinkWorkspace = createV2Workspace({
      "raw/private.md": "# Raw\n\nraw-root-token\n",
    });
    symlinkSync(join(rawRootSymlinkWorkspace, "raw"), join(rawRootSymlinkWorkspace, "wiki", "pages"), "dir");
    const rawRootSymlinkSearch = executeKnowledgeSearch(
      { query: "raw-root-token" },
      { agentWorkspaceRoot: rawRootSymlinkWorkspace },
    );
    assertSearchOk(rawRootSymlinkSearch);
    assert.deepEqual(rawRootSymlinkSearch.results, []);

    const rawRootSymlinkGet = executeKnowledgeGet(
      { path: "wiki/pages/private.md" },
      { agentWorkspaceRoot: rawRootSymlinkWorkspace },
    );
    assert.equal(rawRootSymlinkGet.ok, false);
    assert.equal(rawRootSymlinkGet.reason, "non-corpus-path");

    const rawSymlinkWorkspace = createV2Workspace({
      "raw/private.md": "# Raw\n\nraw-private-token\n",
    });
    mkdirSync(join(rawSymlinkWorkspace, "wiki", "pages", "project"), { recursive: true });
    symlinkSync(
      join(rawSymlinkWorkspace, "raw", "private.md"),
      join(rawSymlinkWorkspace, "wiki", "pages", "project", "private.md"),
    );
    const rawSymlinkSearch = executeKnowledgeSearch(
      { query: "raw-private-token" },
      { agentWorkspaceRoot: rawSymlinkWorkspace },
    );
    assertSearchOk(rawSymlinkSearch);
    assert.deepEqual(rawSymlinkSearch.results, []);

    const rawSymlinkGet = executeKnowledgeGet(
      { path: "wiki/pages/project/private.md" },
      { agentWorkspaceRoot: rawSymlinkWorkspace },
    );
    assert.equal(rawSymlinkGet.ok, false);
    assert.equal(rawSymlinkGet.reason, "non-corpus-path");
  });

  it("reads exact clamped line ranges from corpus markdown", () => {
    const workspace = createV2Workspace({
      "wiki/pages/user/preferences.md": [
        "---",
        "name: Preferences",
        "description: User preferences",
        "type: user",
        "---",
        "",
        "# Preferences",
        "",
        "Line nine",
        "Line ten",
        "Line eleven",
      ].join("\n"),
    });

    const exact = executeKnowledgeGet(
      { path: "wiki/pages/user/preferences.md", startLine: 9, endLine: 10 },
      { agentWorkspaceRoot: workspace },
    );
    assertGetOk(exact);
    assert.equal(exact.title, "Preferences");
    assert.equal(exact.startLine, 9);
    assert.equal(exact.endLine, 10);
    assert.equal(exact.content, "Line nine\nLine ten");
    assert.equal(exact.sourceKind, "wiki");

    const clamped = executeKnowledgeGet(
      { path: "wiki/pages/user/preferences.md", startLine: -20, endLine: 999 },
      { agentWorkspaceRoot: workspace },
    );
    assertGetOk(clamped);
    assert.equal(clamped.startLine, 1);
    assert.equal(clamped.endLine, 11);
    assert.match(clamped.content, /^---\nname: Preferences/);
    assert.match(clamped.content, /Line eleven$/);
  });
});
