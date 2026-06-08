import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import {
  KNOWLEDGE_GET_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  KNOWLEDGE_UPDATE_TOOL,
  classifyKnowledgeIntegrityToolCall,
  executePiKnowledgeSearch,
  extractBashWriteTargets,
} from "../pi-extensions/knowledge-tools.js";
import { MINIME_AGENT_WORKSPACE_ROOT_ENV, MINIME_CONTROL_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

const RETIRED_AGENT_WORKSPACE_ENV = ["MINIME", "AGENT", "WORKSPACE", "CWD"].join("_");
const RETIRED_CONTROL_WORKSPACE_ENV = ["MINIME", "WORKSPACE", "ROOT"].join("_");

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
  const workspace = mkdtempSync(join(tmpdir(), "minime-knowledge-pi-"));
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

function assertBlocked(
  workspace: string,
  event: Parameters<typeof classifyKnowledgeIntegrityToolCall>[0],
  target: string,
): void {
  const decision = classifyKnowledgeIntegrityToolCall(event, {
    agentWorkspaceRoot: workspace,
    cwd: workspace,
    env: {},
  });
  assert.equal(decision?.block, true, JSON.stringify(event));
  assert.equal(decision.targetPath, target);
  assert.match(decision.reason, /knowledge_update/);
}

describe("Knowledge Pi extension helpers", () => {
  it("defines model-callable knowledge tools with scope, authority, write-path, and protection guidance", () => {
    assert.equal(KNOWLEDGE_SEARCH_TOOL.name, "knowledge_search");
    assert.match(KNOWLEDGE_SEARCH_TOOL.description, /Scope auto\/default/);
    assert.match(KNOWLEDGE_SEARCH_TOOL.description, /authority/);
    assert.equal(KNOWLEDGE_GET_TOOL.name, "knowledge_get");
    assert.match(KNOWLEDGE_GET_TOOL.description, /exact Markdown line ranges/);
    assert.equal(KNOWLEDGE_UPDATE_TOOL.name, "knowledge_update");
    assert.match(KNOWLEDGE_UPDATE_TOOL.description, /not arbitrary file editing/);
    assert.match(KNOWLEDGE_UPDATE_TOOL.description, /Direct manual writes/);
  });

  it("lets Pi knowledge tool execution use the validated cwd with a warning when the agent workspace env is absent", () => {
    const staleWorkspace = createV2Workspace({
      "wiki/pages/project/stale.md": "# Stale\n\nStale-only token.\n",
      "wiki/index.md": "# Knowledge Index\n\n- [Stale](pages/project/stale.md)\n",
    });
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime.md": "# Runtime\n\nKnowledge wrapper token.\n",
      "wiki/index.md": "# Knowledge Index\n\n- [Runtime](pages/project/runtime.md)\n",
    });
    const previous = process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
    process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV] = staleWorkspace;
    try {
      const result = executePiKnowledgeSearch(
        { query: "wrapper token" },
        { cwd: workspace, env: { [RETIRED_AGENT_WORKSPACE_ENV]: staleWorkspace } },
      );

      assert.equal(result.ok, true, result.text);
      assert.match(result.text, /wiki\/pages\/project\/runtime\.md/);
      assert.doesNotMatch(result.text, /stale\.md/);
      assert.match(result.text, /falling back to process cwd/);
      assert.match(result.text, /MINIME_AGENT_WORKSPACE_ROOT/);
      assert.doesNotMatch(result.text, new RegExp(RETIRED_AGENT_WORKSPACE_ENV));
    } finally {
      if (previous === undefined) {
        delete process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV] = previous;
      }
    }
  });

  it("prefers the canonical agent workspace env over cwd and control workspace env", () => {
    const controlWorkspace = createWorkspace({
      "wiki/schema.md": generateKnowledgeV2Schema(),
      "wiki/index.md": "# Knowledge Index\n",
      "wiki/pages/project/control.md": "# Control\n\nControl-only token.\n",
    });
    const agentWorkspace = createV2Workspace({
      "wiki/pages/project/agent.md": "# Agent\n\nAgent-only token.\n",
      "wiki/index.md": "# Knowledge Index\n\n- [Agent](pages/project/agent.md)\n",
    });

    const result = executePiKnowledgeSearch(
      { query: "agent-only" },
      {
        cwd: controlWorkspace,
        env: {
          [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: controlWorkspace,
          [MINIME_AGENT_WORKSPACE_ROOT_ENV]: agentWorkspace,
          [RETIRED_CONTROL_WORKSPACE_ENV]: controlWorkspace,
          [RETIRED_AGENT_WORKSPACE_ENV]: controlWorkspace,
        },
      },
    );

    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /wiki\/pages\/project\/agent\.md/);
    assert.doesNotMatch(result.text, /control\.md/);
    assert.doesNotMatch(result.text, /falling back to process cwd/);
  });

  it("blocks direct write and edit targets under managed v2 wiki paths", () => {
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime.md": "# Runtime\n",
    });

    assertBlocked(
      workspace,
      { toolName: "write", input: { path: "wiki/index.md", content: "bad" } },
      "wiki/index.md",
    );
    assertBlocked(
      workspace,
      { toolName: "edit", input: { path: "wiki/pages/project/runtime.md", edits: [] } },
      "wiki/pages/project/runtime.md",
    );
  });

  it("allows knowledge tools and read-only tools against managed paths", () => {
    const workspace = createV2Workspace();

    for (const event of [
      { toolName: "knowledge_update", input: { path: "wiki/index.md" } },
      { toolName: "knowledge_search", input: { query: "index" } },
      { toolName: "knowledge_get", input: { path: "wiki/index.md" } },
      { toolName: "read", input: { path: "wiki/index.md" } },
    ]) {
      assert.equal(
        classifyKnowledgeIntegrityToolCall(event, { agentWorkspaceRoot: workspace, cwd: workspace, env: {} }),
        undefined,
        event.toolName,
      );
    }
  });

  it("blocks bash write targets from redirects, tee, mv, cp, and wrapper commands", () => {
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime.md": "# Runtime\n",
    });

    const cases: Array<[string, string]> = [
      ["printf x > wiki/index.md", "wiki/index.md"],
      ["printf x 2>wiki/log.md", "wiki/log.md"],
      ["printf x | sudo env LC_ALL=C nohup time tee -a wiki/pages/project/runtime.md", "wiki/pages/project/runtime.md"],
      ["cp source.md wiki/pages/project/copied.md", "wiki/pages/project/copied.md"],
      ["install source.md wiki/pages/project/installed.md", "wiki/pages/project/installed.md"],
      ["mv wiki/pages/project/runtime.md tmp/runtime.md", "wiki/pages/project/runtime.md"],
      ["rm wiki/pages/project/runtime.md", "wiki/pages/project/runtime.md"],
      ["unlink wiki/pages/project/runtime.md", "wiki/pages/project/runtime.md"],
      ["touch wiki/index.md", "wiki/index.md"],
      ["truncate -s 0 wiki/log.md", "wiki/log.md"],
      ["mkdir wiki/pages/project/generated", "wiki/pages/project/generated"],
      ["sed -i 's/a/b/' wiki/index.md", "wiki/index.md"],
      ["sed -Ei 's/a/b/' wiki/index.md", "wiki/index.md"],
      ["sed -ibak 's/a/b/' wiki/index.md", "wiki/index.md"],
      ["sed -n 'w wiki/index.md' /dev/null", "wiki/index.md"],
      ["sed -i.bak 'w wiki/index.md' /tmp/source.md", "wiki/index.md"],
      ["perl --in-place -e 's/a/b/' wiki/index.md", "wiki/index.md"],
      ["perl -i.bak -e 'open(F, \">wiki/log.md\")' /tmp/source.md", "wiki/log.md"],
      ["perl -pi -e 's/a/b/' wiki/index.md", "wiki/index.md"],
      ["awk 'BEGIN { print \"x\" > \"wiki/index.md\" }'", "wiki/index.md"],
      ["sort -o wiki/index.md /dev/null", "wiki/index.md"],
      ["yq -i '.name = \"x\"' wiki/index.md", "wiki/index.md"],
      [": > $PWD/wiki/index.md", "wiki/index.md"],
      ["printf x > ${PWD}/wiki/pages/project/runtime.md", "wiki/pages/project/runtime.md"],
      ["printf x > $UNKNOWN/wiki/index.md", "wiki/index.md"],
      ["cd wiki && printf x > index.md", "wiki/index.md"],
      ["env -C wiki bash -c 'printf x > index.md'", "wiki/index.md"],
      ["sudo -D wiki bash -c 'printf x > index.md'", "wiki/index.md"],
      ["bash -lc 'printf x > wiki/index.md'", "wiki/index.md"],
      ["sh -c 'printf x > wiki/log.md'", "wiki/log.md"],
      ["env bash -c 'printf x > wiki/pages/project/runtime.md'", "wiki/pages/project/runtime.md"],
      ["python -c 'open(\"wiki/index.md\", \"w\").write(\"x\")'", "wiki/index.md"],
      ["dd if=/dev/null of=wiki/index.md", "wiki/index.md"],
      ["f=index; printf x > wiki/$f.md", "wiki/$f.md"],
      ["rm wiki/i?dex.md", "wiki/i?dex.md"],
      ["rm wiki/*.md", "wiki/*.md"],
      ["cd wiki && rm i?dex.md", "wiki/i?dex.md"],
    ];

    for (const [command, target] of cases) {
      assertBlocked(
        workspace,
        { toolName: "bash", input: { command } },
        target,
      );
    }

    assert.deepEqual(
      extractBashWriteTargets("cat <<EOF | tee -a wiki/issues.md && cp a.md wiki/pages/project/a.md"),
      ["wiki/issues.md", "wiki/pages/project/a.md"],
    );
  });

  it("allows bash read-only commands against managed knowledge paths", () => {
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime.md": "# Runtime\n",
    });

    for (const command of [
      "cat wiki/index.md",
      "grep Runtime wiki/pages/project/runtime.md",
      "bash -lc 'cat wiki/index.md'",
      "git diff -- wiki/index.md",
      "git status -- wiki/pages/project/runtime.md",
      "git show HEAD:wiki/index.md",
      "git log -- wiki/index.md",
    ]) {
      assert.equal(
        classifyKnowledgeIntegrityToolCall(
          { toolName: "bash", input: { command } },
          { agentWorkspaceRoot: workspace, cwd: workspace, env: {} },
        ),
        undefined,
        command,
      );
    }
  });

  it("blocks symlink aliases that resolve into managed pages", () => {
    const workspace = createV2Workspace();
    mkdirSync(join(workspace, "wiki/pages/project"), { recursive: true });
    symlinkSync(join(workspace, "wiki/pages/project"), join(workspace, "page-link"));

    assertBlocked(
      workspace,
      { toolName: "write", input: { path: "page-link/alias.md", content: "bad" } },
      "wiki/pages/project/alias.md",
    );
  });

  it("stays inactive for legacy and Karpathy pre-migration wiki layouts", () => {
    const legacy = createWorkspace({ "MEMORY.md": "# Memory\n" });
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

    for (const workspace of [legacy, karpathy]) {
      assert.equal(
        classifyKnowledgeIntegrityToolCall(
          { toolName: "write", input: { path: "wiki/index.md", content: "allowed pre-migration" } },
          { agentWorkspaceRoot: workspace, cwd: workspace, env: {} },
        ),
        undefined,
      );
    }
  });
});
