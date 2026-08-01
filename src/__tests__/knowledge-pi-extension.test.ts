import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import {
  KNOWLEDGE_GET_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  KNOWLEDGE_UPDATE_TOOL,
  classifyKnowledgeIntegrityToolCall,
  executePiKnowledgeSearch,
  executePiKnowledgeUpdate,
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
    assert.match(KNOWLEDGE_UPDATE_TOOL.description, /archive, or restore/);
    assert.match(KNOWLEDGE_UPDATE_TOOL.description, /preserve page bytes/);
    assert.match(KNOWLEDGE_UPDATE_TOOL.description, /minime-bot knowledge sync/);
    assert.match(KNOWLEDGE_UPDATE_TOOL.description, /raw Git worktree mutations remain blocked/);
    assert.equal(KNOWLEDGE_UPDATE_TOOL.parameters.type, "object");
    assert.deepEqual(KNOWLEDGE_UPDATE_TOOL.parameters.required, ["op"]);
    assert.deepEqual(KNOWLEDGE_UPDATE_TOOL.parameters.properties.op.enum, [
      "create",
      "update",
      "upsert",
      "archive",
      "restore",
    ]);
    assert.ok("path" in KNOWLEDGE_UPDATE_TOOL.parameters.properties);
    assert.ok("body" in KNOWLEDGE_UPDATE_TOOL.parameters.properties);
    const [writeSchema, moveSchema] = KNOWLEDGE_UPDATE_TOOL.parameters.anyOf;
    assert.deepEqual(writeSchema.required, ["op", "type", "frontmatter", "body"]);
    assert.deepEqual(writeSchema.properties.op.enum, ["create", "update", "upsert"]);
    assert.deepEqual(moveSchema.required, ["op", "path"]);
    assert.deepEqual(moveSchema.properties.op.enum, ["archive", "restore"]);
    assert.equal("body" in moveSchema.properties, false);
    assert.equal(moveSchema.additionalProperties, false);
  });

  it("archives and restores through the Pi tool with path-only arguments while preserving managed-path protection", () => {
    const relPath = "wiki/pages/project/history/issue-128-2026-05-01.md";
    const archiveRelPath = `artifacts/knowledge-archive/${relPath}`;
    const page = [
      "---",
      "name: Completed Issue",
      "description: Durable completed issue record",
      "type: project",
      "---",
      "",
      "# Completed Issue",
      "",
      "Exact archived bytes.",
      "",
    ].join("\n");
    const workspace = createV2Workspace({
      [relPath]: page,
      "wiki/index.md": [
        "# Knowledge Index",
        "",
        "## Project",
        "",
        "- [Completed Issue](pages/project/history/issue-128-2026-05-01.md) - Durable completed issue record",
        "",
      ].join("\n"),
    });

    const archived = executePiKnowledgeUpdate(
      { op: "archive", path: relPath },
      { agentWorkspaceRoot: workspace, cwd: workspace, env: {} },
    );
    assert.equal(archived.ok, true, archived.text);
    assert.match(archived.text, /"action": "archived"/);
    assert.equal(existsSync(join(workspace, ...relPath.split("/"))), false);
    assert.equal(readFileSync(join(workspace, ...archiveRelPath.split("/")), "utf8"), page);
    assertBlocked(
      workspace,
      { toolName: "edit", input: { path: archiveRelPath, edits: [] } },
      archiveRelPath,
    );

    const restored = executePiKnowledgeUpdate(
      { op: "restore", path: relPath },
      { agentWorkspaceRoot: workspace, cwd: workspace, env: {} },
    );
    assert.equal(restored.ok, true, restored.text);
    assert.match(restored.text, /"action": "restored"/);
    assert.equal(readFileSync(join(workspace, ...relPath.split("/")), "utf8"), page);
    assert.equal(existsSync(join(workspace, ...archiveRelPath.split("/"))), false);

    assertBlocked(
      workspace,
      { toolName: "edit", input: { path: relPath, edits: [] } },
      relPath,
    );
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

  it("blocks direct write and edit targets under managed v2 wiki and archive paths", () => {
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
    assertBlocked(
      workspace,
      {
        toolName: "write",
        input: {
          path: "artifacts/knowledge-archive/wiki/pages/project/runtime.md",
          content: "bad",
        },
      },
      "artifacts/knowledge-archive/wiki/pages/project/runtime.md",
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
      [
        "python -c 'import shutil; shutil.rmtree(\"artifacts/knowledge-archive\")'",
        "artifacts/knowledge-archive",
      ],
      ["python -c 'import shutil; shutil.rmtree(\"artifacts\")'", "artifacts"],
      ["python -c 'import shutil; shutil.rmtree(\"wiki\")'", "wiki"],
      [
        "ruby -e 'File.write(\"artifacts/knowledge-archive/wiki/pages/project/runtime.md\", \"x\")'",
        "artifacts/knowledge-archive/wiki/pages/project/runtime.md",
      ],
      ["dd if=/dev/null of=wiki/index.md", "wiki/index.md"],
      ["f=index; printf x > wiki/$f.md", "wiki/$f.md"],
      ["rm wiki/i?dex.md", "wiki/i?dex.md"],
      ["rm wiki/*.md", "wiki/*.md"],
      ["cd wiki && rm i?dex.md", "wiki/i?dex.md"],
      [
        "printf x > artifacts/knowledge-archive/wiki/pages/project/runtime.md",
        "artifacts/knowledge-archive/wiki/pages/project/runtime.md",
      ],
      [
        "rm artifacts/knowledge-archive/wiki/pages/project/*.md",
        "artifacts/knowledge-archive/wiki/pages/project/*.md",
      ],
      ["rm -rf artifacts", "artifacts"],
      ["rm -rf artifacts/*", "artifacts"],
      ["mv artifacts /tmp/archive-backup", "artifacts"],
      ["find artifacts -delete", "artifacts"],
      ["rsync -a --delete /tmp/empty/ artifacts/", "artifacts"],
      ["git restore artifacts", "artifacts"],
      ["tar -xf payload.tar", workspace],
      ["tar -xf payload.tar -Cartifacts", "artifacts"],
      ["tar -xC artifacts -f payload.tar", "artifacts"],
      [
        "cat /dev/null\nrm -rf artifacts/knowledge-archive",
        "artifacts/knowledge-archive",
      ],
      ["true # an ordinary comment\nrm -rf wiki/pages", "wiki/pages"],
      [
        "printf x > $UNKNOWN/artifacts/knowledge-archive/wiki/pages/project/runtime.md",
        "artifacts/knowledge-archive/wiki/pages/project/runtime.md",
      ],
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

  it("blocks implicit Git worktree mutations and canonical workspace-root ancestor targets", () => {
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime.md": "# Runtime\n",
    });
    const notes = join(workspace, "notes");
    mkdirSync(notes, { recursive: true });

    for (const command of [
      "git clean -fdx",
      "git reset --hard",
      "git stash --include-untracked",
      "git checkout-index -a -f",
      "git read-tree -u --reset HEAD^",
      "git restore :/",
      "git rm -r :/",
      "git merge origin/main",
      "git pull --ff-only",
      "git rebase origin/main",
      "git cherry-pick HEAD^",
    ]) {
      assertBlocked(
        workspace,
        { toolName: "bash", input: { command } },
        workspace,
      );
    }

    const mergeDecision = classifyKnowledgeIntegrityToolCall(
      { toolName: "bash", input: { command: "git merge origin/main" } },
      { agentWorkspaceRoot: workspace, cwd: workspace, env: {} },
    );
    assert.equal(mergeDecision?.targetPath, workspace);
    assert.match(mergeDecision?.reason ?? "", /raw Git worktree mutations are blocked/);
    assert.match(mergeDecision?.reason ?? "", /knowledge_update/);
    assert.match(mergeDecision?.reason ?? "", /minime-bot knowledge sync/);

    for (const [command, cwd] of [
      ["git merge origin/main", notes],
      ["git -C notes merge origin/main", workspace],
      ["cd notes && git merge origin/main", workspace],
    ] as const) {
      const decision = classifyKnowledgeIntegrityToolCall(
        { toolName: "bash", input: { command } },
        { agentWorkspaceRoot: workspace, cwd, env: {} },
      );
      assert.equal(decision?.block, true, command);
      assert.equal(decision.targetPath, workspace, command);
    }

    const outside = createWorkspace();
    const env = { [MINIME_AGENT_WORKSPACE_ROOT_ENV]: workspace };
    for (const [command, target] of [
      [`rm -rf $${MINIME_AGENT_WORKSPACE_ROOT_ENV}/artifacts`, "artifacts"],
      [`git -C $${MINIME_AGENT_WORKSPACE_ROOT_ENV} clean -fdx`, workspace],
      [`git --work-tree=$${MINIME_AGENT_WORKSPACE_ROOT_ENV} reset --hard`, workspace],
      [`tar -xC $${MINIME_AGENT_WORKSPACE_ROOT_ENV} -f payload.tar`, workspace],
      [
        `env P=$${MINIME_AGENT_WORKSPACE_ROOT_ENV}/artifacts/knowledge-archive sh -c 'rm -rf "$P"'`,
        "artifacts/knowledge-archive",
      ],
    ] as const) {
      const decision = classifyKnowledgeIntegrityToolCall(
        { toolName: "bash", input: { command } },
        { agentWorkspaceRoot: workspace, cwd: outside, env },
      );
      assert.equal(decision?.block, true, command);
      assert.equal(decision.targetPath, target, command);
    }
  });

  it("allows unrelated writes beneath archive ancestors", () => {
    const workspace = createV2Workspace();

    for (const command of [
      "mkdir -p artifacts/maintenance",
      "touch artifacts/maintenance-report.json",
      "mv source.md artifacts",
      "node report.js artifacts/maintenance",
      "tar -xf payload.tar -Cartifacts/maintenance",
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
      "find . -type f",
      "node inspect.js .",
      "npm test -- .",
      "git add .",
      "git restore --staged :/",
      "git rm --cached -r :/",
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
      for (const event of [
        { toolName: "write", input: { path: "wiki/index.md", content: "allowed pre-migration" } },
        { toolName: "bash", input: { command: "git merge origin/main" } },
      ]) {
        assert.equal(
          classifyKnowledgeIntegrityToolCall(
            event,
            { agentWorkspaceRoot: workspace, cwd: workspace, env: {} },
          ),
          undefined,
          `${workspace}: ${event.toolName}`,
        );
      }
    }
  });
});
