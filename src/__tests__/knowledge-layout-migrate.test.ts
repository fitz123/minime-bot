import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import {
  executeKnowledgeMigration,
  type KnowledgeMigrationResponse,
} from "../knowledge/migration.js";
import { MINIME_AGENT_WORKSPACE_CWD_ENV } from "../workspace-contract.js";

const fixtures: string[] = [];
const hasGit = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

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
  const workspace = mkdtempSync(join(tmpdir(), "minime-knowledge-migrate-"));
  fixtures.push(workspace);
  writeFiles(workspace, files);
  return workspace;
}

function assertMigrationOk(
  response: KnowledgeMigrationResponse,
): asserts response is Extract<KnowledgeMigrationResponse, { ok: true }> {
  assert.equal(response.ok, true, JSON.stringify(response));
}

function runGit(workspace: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function initCleanGitWorkspace(workspace: string): void {
  runGit(workspace, ["init"]);
  runGit(workspace, ["add", "."]);
  runGit(workspace, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@users.noreply.github.com",
    "commit",
    "-m",
    "fixture",
  ]);
}

function operationTargets(response: Extract<KnowledgeMigrationResponse, { ok: true }>): string[] {
  return response.operations.map((operation) => operation.targetPath).sort();
}

function hasFrontmatterTargetMismatch(
  response: Extract<KnowledgeMigrationResponse, { ok: true }>,
  sourcePath: string,
  targetPath: string,
): boolean {
  return response.reviewItems.some((item) => (
    item.kind === "type_review" &&
    item.path === sourcePath &&
    item.reason === "frontmatter_target_type_mismatch" &&
    item.suggestedTarget === targetPath &&
    item.blocking
  ));
}

function hasReviewItem(
  response: Extract<KnowledgeMigrationResponse, { ok: true }>,
  path: string,
  reason: string,
  blocking?: boolean,
): boolean {
  return response.reviewItems.some((item) => (
    item.path === path &&
    item.reason === reason &&
    (blocking === undefined || item.blocking === blocking)
  ));
}

function legacyProjectPage(name = "Runtime"): string {
  return [
    "---",
    "metadata:",
    `  name: ${name}`,
    "  description: Runtime status context",
    "  type: project",
    "  node_type: durable",
    "confidence: high",
    "---",
    "",
    `# ${name}`,
    "",
    "See [old diary](../diary/2026-06-07.md).",
    "",
  ].join("\n");
}

describe("knowledge layout migration", () => {
  it("defaults to dry-run for legacy workspaces and apply creates v2 files without deleting sources", { skip: !hasGit }, () => {
    const workspace = createWorkspace({
      "MEMORY.md": [
        "# Memory",
        "",
        "## Pending Review",
        "",
        "- Confirm runtime citation.",
        "",
      ].join("\n"),
      "memory/auto/project_runtime.md": legacyProjectPage(),
      "memory/diary/2026-06-07.md": "# Diary\n\nRuntime work happened.\n",
      "reference/drafts/idea.md": "# Draft\n",
      "scripts/deploy.sh": "#!/bin/sh\n",
    });
    initCleanGitWorkspace(workspace);

    const dryRun = executeKnowledgeMigration({}, {
      agentWorkspaceRoot: workspace,
      now: () => new Date("2026-06-07T12:00:00.000Z"),
    });

    assertMigrationOk(dryRun);
    assert.equal(dryRun.mode, "dry-run");
    assert.equal(dryRun.layoutKind, "legacy");
    assert.deepEqual(operationTargets(dryRun), [
      "artifacts/legacy/MEMORY.md",
      "diary/2026-06-07.md",
      "wiki/index.md",
      "wiki/issues.md",
      "wiki/log.md",
      "wiki/pages/project/runtime/status.md",
      "wiki/schema.md",
    ]);
    assert.equal(dryRun.summary.pages, 1);
    assert.equal(dryRun.summary.diaryEntries, 1);
    assert.equal(dryRun.summary.blockers, 0);
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "reference_draft_artifact"));
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "active_runtime_state"));
    assert.equal(existsSync(join(workspace, "wiki", "schema.md")), false);

    const applied = executeKnowledgeMigration({ apply: true }, {
      agentWorkspaceRoot: workspace,
      now: () => new Date("2026-06-07T12:00:00.000Z"),
    });

    assertMigrationOk(applied);
    assert.equal(applied.mode, "apply");
    assert.equal(existsSync(join(workspace, "MEMORY.md")), true);
    assert.match(readFileSync(join(workspace, "wiki", "schema.md"), "utf8"), /format: minime-knowledge-v2/);
    assert.match(
      readFileSync(join(workspace, "wiki", "index.md"), "utf8"),
      /\[Runtime\]\(pages\/project\/runtime\/status\.md\)/,
    );
    const page = readFileSync(join(workspace, "wiki", "pages", "project", "runtime", "status.md"), "utf8");
    assert.match(page, /confidence: high/);
    assert.doesNotMatch(page, /metadata:/);
    assert.match(page, /Source: \[memory\/auto\/project_runtime\.md\]/);
    assert.match(page, /\.\.\/\.\.\/\.\.\/\.\.\/diary\/2026-06-07\.md/);
    assert.doesNotMatch(page, /\]\([^)]*memory\/diary\/2026-06-07\.md\)/);
    assert.match(readFileSync(join(workspace, "wiki", "issues.md"), "utf8"), /Confirm runtime citation/);
    assert.equal(readFileSync(join(workspace, "artifacts", "legacy", "MEMORY.md"), "utf8"), readFileSync(join(workspace, "MEMORY.md"), "utf8"));
  });

  it("splits typed root MEMORY sections into v2 pages while archiving the exact legacy file", { skip: !hasGit }, () => {
    const legacyMemory = [
      "# Memory",
      "",
      "## Catalog",
      "",
      "- [Runtime](memory/auto/project_runtime.md)",
      "",
      "## Project: Runtime",
      "",
      "Runtime status is durable and should become a project page.",
      "",
      "## Feedback: Response Style",
      "",
      "Do not invent prior decisions when knowledge is missing.",
      "",
    ].join("\n");
    const workspace = createWorkspace({
      "MEMORY.md": legacyMemory,
    });
    initCleanGitWorkspace(workspace);

    const applied = executeKnowledgeMigration({ apply: true }, {
      agentWorkspaceRoot: workspace,
      now: () => new Date("2026-06-07T12:00:00.000Z"),
    });

    assertMigrationOk(applied);
    assert.equal(applied.summary.blockers, 0);
    assert.ok(operationTargets(applied).includes("wiki/pages/project/runtime.md"));
    assert.ok(operationTargets(applied).includes("wiki/pages/feedback/response-style.md"));
    assert.match(
      readFileSync(join(workspace, "wiki/pages/project/runtime.md"), "utf8"),
      /Source: \[MEMORY\.md\]/,
    );
    assert.match(
      readFileSync(join(workspace, "wiki/index.md"), "utf8"),
      /\[Runtime\]\(pages\/project\/runtime\.md\)/,
    );
    assert.equal(readFileSync(join(workspace, "artifacts/legacy/MEMORY.md"), "utf8"), legacyMemory);
  });

  it("skips catalog-only MEMORY link lists with descriptions and simple tables", () => {
    const legacyMemory = [
      "# Memory",
      "",
      "## Catalog",
      "",
      "- [Runtime](memory/auto/project_runtime.md) - Runtime status context",
      "- [Reports](reference/reports/runtime.md): archived reports",
      "",
      "## Contents",
      "",
      "| Page | Description |",
      "| --- | --- |",
      "| [Runtime](memory/auto/project_runtime.md) | Runtime status context |",
      "| [Diary](memory/diary/2026-06-07.md) | Timeline entries |",
      "",
    ].join("\n");
    const workspace = createWorkspace({
      "MEMORY.md": legacyMemory,
      "memory/auto/project_runtime.md": legacyProjectPage(),
    });

    const response = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(response);
    const targets = operationTargets(response);
    assert.equal(response.summary.pages, 1);
    assert.equal(response.summary.blockers, 0);
    assert.ok(targets.includes("wiki/pages/project/runtime/status.md"));
    assert.equal(targets.some((target) => /catalog|contents/.test(target)), false);
    assert.equal(hasReviewItem(response, "MEMORY.md", "legacy_memory_split_required"), false);
  });

  it("treats existing v2 workspaces as a no-op", () => {
    const workspace = createWorkspace({
      "wiki/schema.md": generateKnowledgeV2Schema(),
      "wiki/index.md": "# Knowledge Index\n",
    });

    const response = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(response);
    assert.equal(response.layoutKind, "v2");
    assert.deepEqual(response.operations, []);
    assert.equal(response.summary.operations, 0);
  });

  it("routes topic-wiki compiled topic pages and dual-layer project memory under one project topic", () => {
    const workspace = createWorkspace({
      "wiki/schema.md": "---\nformat: karpathy-llm-wiki\nversion: 1\n---\n",
      "wiki/index.md": "# Topic Wiki Index\n",
      "wiki/runtime/index.md": "# Runtime Landing\n\nCompiled page.\n",
      "wiki/runtime/provenance.md": "# Runtime Provenance\n\nCites raw notes.\n",
      "memory/auto/project_runtime.md": legacyProjectPage("Runtime Status"),
    });

    const response = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(response);
    const targets = operationTargets(response);
    assert.ok(targets.includes("wiki/pages/project/runtime/README.md"));
    assert.ok(targets.includes("wiki/pages/project/runtime/provenance.md"));
    assert.ok(targets.includes("wiki/pages/project/runtime/status.md"));
    assert.ok(!targets.includes("wiki/pages/project/runtime.md"));
  });

  it("reports secrets, unknown types, profile-like references, runtime captures, and domain trees as review items", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n\n## Pending Review\n\n- Existing issue must not overwrite.\n",
      "memory/auto/about.md": "---\nname: About\ndescription: User-ish profile\ntype: reference\n---\n\n# About\n",
      "memory/auto/unknown.md": "# Loose Note\n\nPlain note without type.\n",
      "memory/auto/secret.md": "---\nname: Secret\ndescription: Secret\ntype: project\n---\n\napi_key: fixture-secret-value\n",
      "memory/auto/private-key.md": "---\nname: Key\ndescription: Key\ntype: project\n---\n\nprivate_key: fixture-secret-value\n",
      "memory/diary/secret.md": "token: fixture-secret-value\n",
      "wiki/runtime/token.md": "# Token\n\ntoken: fixture-secret-value\n",
      "pilot/app/readme.md": "# Domain tree\n",
      ".tmp/capture.md": "# Runtime capture\n",
      "state.json": "{\"active\":true}\n",
    });

    const dryRun = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(dryRun);
    assert.ok(dryRun.reviewItems.some((item) => item.kind === "secret_review" && item.path === "memory/auto/secret.md"));
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "missing_or_unknown_type"));
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "profile_reference_type_review"));
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "hidden_runtime_state"));
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "domain_client_training_tree"));
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "non_markdown_state"));
    assert.ok(dryRun.summary.blockers >= 3);

    const apply = executeKnowledgeMigration({ apply: true, allowDirty: true }, { agentWorkspaceRoot: workspace });

    assert.equal(apply.ok, false);
    assert.equal(apply.reason, "knowledge-migration-review-required");
    assert.equal(apply.summary?.applied, false);
    assert.match(apply.humanSummary ?? "", /not applied/);
  });

  it("classifies active docs and domain trees as nonblocking while unknown Markdown still blocks", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      "README.md": "# Workspace\n",
      "CHANGELOG.md": "# Changelog\n",
      "AGENTS.md": "# Agent Instructions\n",
      "STATUS.md": "# Status\n",
      ".beads/README.md": "# Beads\n",
      "nix/runtime.nix": "{ pkgs }: {}\n",
      "domain/orders/model.md": "# Orders\n",
      "clients/acme/README.md": "# Acme\n",
      "training/onboarding.md": "# Onboarding\n",
      "loose-note.md": "# Loose Note\n\nNo package-level provenance.\n",
    });

    const response = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(response);
    assert.ok(hasReviewItem(response, "README.md", "root_active_doc", false));
    assert.ok(hasReviewItem(response, "CHANGELOG.md", "root_active_doc", false));
    assert.ok(hasReviewItem(response, "AGENTS.md", "root_active_doc", false));
    assert.ok(hasReviewItem(response, "STATUS.md", "root_status_doc", false));
    assert.ok(hasReviewItem(response, ".beads/README.md", "beads_metadata_doc", false));
    assert.ok(hasReviewItem(response, "nix/runtime.nix", "nix_runtime_tree", false));
    assert.ok(hasReviewItem(response, "domain/orders/model.md", "domain_client_training_tree", false));
    assert.ok(hasReviewItem(response, "clients/acme/README.md", "domain_client_training_tree", false));
    assert.ok(hasReviewItem(response, "training/onboarding.md", "domain_client_training_tree", false));
    assert.ok(hasReviewItem(response, "loose-note.md", "unknown_provenance", true));
    assert.equal(response.summary.blockers, 1);
  });

  it("reports target/frontmatter type mismatches as blocking review items", () => {
    const sourcePath = "memory/auto/curriculum_notes.md";
    const mismatchedTarget = "wiki/pages/project/learning/curriculum-notes-status.md";
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      [sourcePath]: [
        "---",
        "name: Curriculum Notes",
        "description: Reference notes for a course plan",
        "type: reference",
        "---",
        "",
        "# Curriculum Notes",
        "",
        "This curriculum should remain reference material until reviewed.",
        "",
      ].join("\n"),
    });
    const reportPath = join(workspace, "reports", "migration.json");

    const dryRun = executeKnowledgeMigration({ dryRun: true, reportPath }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(dryRun);
    assert.ok(hasFrontmatterTargetMismatch(dryRun, sourcePath, mismatchedTarget));
    assert.equal(operationTargets(dryRun).includes(mismatchedTarget), false);
    assert.equal(existsSync(reportPath), true);

    const report = JSON.parse(readFileSync(reportPath, "utf8")) as KnowledgeMigrationResponse;
    assertMigrationOk(report);
    assert.ok(hasFrontmatterTargetMismatch(report, sourcePath, mismatchedTarget));
    assert.equal(operationTargets(report).includes(mismatchedTarget), false);

    const apply = executeKnowledgeMigration({ apply: true, allowDirty: true }, { agentWorkspaceRoot: workspace });

    assert.equal(apply.ok, false);
    assert.equal(apply.reason, "knowledge-migration-review-required");
    assert.equal(apply.summary?.applied, false);
    assert.equal(existsSync(join(workspace, ...mismatchedTarget.split("/"))), false);
    assert.equal(existsSync(join(workspace, "wiki", "schema.md")), false);
  });

  it("treats an explicit empty env as authoritative over the process env", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      "memory/auto/project_runtime.md": legacyProjectPage(),
    });
    const previous = process.env[MINIME_AGENT_WORKSPACE_CWD_ENV];
    process.env[MINIME_AGENT_WORKSPACE_CWD_ENV] = workspace;
    try {
      const response = executeKnowledgeMigration({ dryRun: true }, { env: {} });

      assert.equal(response.ok, false);
      assert.equal(response.reason, "agent-workspace-unset");
    } finally {
      if (previous === undefined) {
        delete process.env[MINIME_AGENT_WORKSPACE_CWD_ENV];
      } else {
        process.env[MINIME_AGENT_WORKSPACE_CWD_ENV] = previous;
      }
    }
  });

  it("blocks apply when root MEMORY.md has unsplit durable content", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n\nDurable fact that needs typed routing.\n",
      "memory/auto/project_runtime.md": legacyProjectPage(),
    });

    const dryRun = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(dryRun);
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "legacy_memory_split_required" && item.blocking));

    const apply = executeKnowledgeMigration({ apply: true, allowDirty: true }, { agentWorkspaceRoot: workspace });

    assert.equal(apply.ok, false);
    assert.equal(apply.reason, "knowledge-migration-review-required");
    assert.equal(apply.summary?.applied, false);
  });

  it("does not overwrite existing pre-v2 wiki control files during migration apply", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n\n## Pending Review\n\n- Existing issue must not overwrite.\n",
      "wiki/schema.md": "---\nformat: karpathy-llm-wiki\nversion: 1\n---\n",
      "wiki/index.md": "# Topic Wiki Index\n",
      "wiki/log.md": "# Existing Log\n",
      "wiki/issues.md": "# Existing Issues\n",
      "wiki/runtime/index.md": "# Runtime Landing\n\nCompiled page.\n",
    });

    const dryRun = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(dryRun);
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "target_exists" && item.suggestedTarget === "wiki/schema.md"));
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "target_exists" && item.suggestedTarget === "wiki/index.md"));
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "target_exists" && item.suggestedTarget === "wiki/log.md"));
    assert.ok(dryRun.reviewItems.some((item) => item.reason === "target_exists" && item.suggestedTarget === "wiki/issues.md"));

    const apply = executeKnowledgeMigration({ apply: true, allowDirty: true }, { agentWorkspaceRoot: workspace });

    assert.equal(apply.ok, false);
    assert.equal(apply.reason, "knowledge-migration-review-required");
    assert.equal(readFileSync(join(workspace, "wiki", "schema.md"), "utf8"), "---\nformat: karpathy-llm-wiki\nversion: 1\n---\n");
    assert.equal(readFileSync(join(workspace, "wiki", "index.md"), "utf8"), "# Topic Wiki Index\n");
    assert.equal(readFileSync(join(workspace, "wiki", "log.md"), "utf8"), "# Existing Log\n");
    assert.equal(readFileSync(join(workspace, "wiki", "issues.md"), "utf8"), "# Existing Issues\n");
  });

  it("rewrites topic-wiki links to migrated v2 page targets when the target is deterministic", { skip: !hasGit }, () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      "wiki/runtime/index.md": "# Runtime Landing\n\nSee [provenance](provenance.md).\n",
      "wiki/runtime/provenance.md": "# Runtime Provenance\n\nCites raw notes.\n",
    });
    initCleanGitWorkspace(workspace);

    const applied = executeKnowledgeMigration({ apply: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(applied);
    const landing = readFileSync(join(workspace, "wiki", "pages", "project", "runtime", "README.md"), "utf8");
    assert.match(landing, /\[provenance\]\(provenance\.md\)/);
    assert.doesNotMatch(landing, /wiki\/runtime\/provenance\.md/);
  });

  it("detects slug collisions as type-review blockers", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      "memory/auto/topic.md": "---\nname: Topic\ndescription: First\ntype: project\n---\n\n# Topic\n",
      "memory/auto/topic.markdown": "---\nname: Topic\ndescription: Second\ntype: project\n---\n\n# Topic\n",
    });

    const response = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(response);
    assert.ok(response.reviewItems.some((item) => item.reason === "slug_collision" && item.blocking));
  });

  it("refuses apply on a dirty git worktree unless allow-dirty is supplied", { skip: !hasGit }, () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      "memory/auto/project_runtime.md": legacyProjectPage(),
    });
    initCleanGitWorkspace(workspace);
    writeFileSync(join(workspace, "untracked.txt"), "Dirty change.\n", "utf8");

    const rejected = executeKnowledgeMigration({ apply: true }, { agentWorkspaceRoot: workspace });

    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "knowledge-migration-dirty-worktree");

    const allowed = executeKnowledgeMigration({ apply: true, allowDirty: true }, { agentWorkspaceRoot: workspace });
    assertMigrationOk(allowed);
    assert.equal(existsSync(join(workspace, "wiki", "pages", "project", "runtime", "status.md")), true);
  });

  it("refuses apply when the workspace is not a git repository even with allow-dirty", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
    });

    const response = executeKnowledgeMigration({ apply: true, allowDirty: true }, { agentWorkspaceRoot: workspace });

    assert.equal(response.ok, false);
    assert.equal(response.reason, "knowledge-migration-git-required");
    assert.equal(existsSync(join(workspace, "wiki", "schema.md")), false);
  });

  it("rejects migration reports that collide with managed or planned output paths before apply", { skip: !hasGit }, () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      "memory/auto/project_runtime.md": legacyProjectPage(),
    });
    initCleanGitWorkspace(workspace);

    const response = executeKnowledgeMigration(
      { apply: true, reportPath: "wiki/index.md" },
      { agentWorkspaceRoot: workspace },
    );

    assert.equal(response.ok, false);
    assert.equal(response.reason, "knowledge-migration-report-path-invalid");
    assert.match(response.message, /planned migration target|managed Knowledge v2 paths/);
    assert.equal(existsSync(join(workspace, "wiki", "schema.md")), false);
  });

  it("rejects invalid migration report parent paths before apply", { skip: !hasGit }, () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      "memory/auto/project_runtime.md": legacyProjectPage(),
      "blocked": "not a directory\n",
    });
    initCleanGitWorkspace(workspace);

    const response = executeKnowledgeMigration(
      { apply: true, reportPath: "blocked/report.json" },
      { agentWorkspaceRoot: workspace },
    );

    assert.equal(response.ok, false);
    assert.equal(response.reason, "knowledge-migration-report-path-invalid");
    assert.match(response.message, /not a directory/);
    assert.equal(existsSync(join(workspace, "wiki", "schema.md")), false);
  });

  it("reports symlinked migration target ancestors as blocking and refuses to write through them", () => {
    const outside = createWorkspace();
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      "memory/auto/project_runtime.md": legacyProjectPage(),
    });
    symlinkSync(outside, join(workspace, "wiki"), "dir");

    const dryRun = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(dryRun);
    assert.ok(dryRun.reviewItems.some((item) => (
      item.reason === "symlink_escape" &&
      item.suggestedTarget === "wiki/pages/project/runtime/status.md" &&
      item.blocking
    )));

    const apply = executeKnowledgeMigration({ apply: true, allowDirty: true }, { agentWorkspaceRoot: workspace });

    assert.equal(apply.ok, false);
    assert.equal(apply.reason, "knowledge-migration-review-required");
    assert.equal(existsSync(join(outside, "schema.md")), false);
    assert.equal(existsSync(join(outside, "pages", "project", "runtime", "status.md")), false);
  });

  it("reports symlinked root MEMORY.md as blocking without reading the target", () => {
    const outside = createWorkspace({
      "MEMORY.md": "# External Memory\n\noutside-symlink-token\n",
    });
    const workspace = createWorkspace();
    symlinkSync(join(outside, "MEMORY.md"), join(workspace, "MEMORY.md"));

    const dryRun = executeKnowledgeMigration({ dryRun: true }, { agentWorkspaceRoot: workspace });

    assertMigrationOk(dryRun);
    assert.ok(dryRun.reviewItems.some((item) => (
      item.reason === "unsafe_legacy_memory_source" &&
      item.path === "MEMORY.md" &&
      item.blocking
    )));
    assert.equal(operationTargets(dryRun).includes("artifacts/legacy/MEMORY.md"), false);
    assert.doesNotMatch(JSON.stringify(dryRun), /outside-symlink-token/);
  });
});
