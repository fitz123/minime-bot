import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  validateWorkspaceContract,
  workspaceValidationErrors,
  workspaceValidationWarnings,
} from "../workspace-validator.js";
import { resolveWorkspaceContract } from "../workspace-contract.js";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = resolve(__dirname, "..", "..");
const MINIMAL_WORKSPACE_FIXTURE = join(BOT_ROOT, "test-fixtures", "minimal-workspace");

const fixtures: string[] = [];

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function writeFixtureFile(root: string, relpath: string, content: string): void {
  const path = join(root, ...relpath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function agentContextFiles(extraFiles: Record<string, string> = {}): Record<string, string> {
  return {
    "agent-workspace/CLAUDE.md": "# Agent Context\n",
    "agent-workspace/.claude/rules/platform/.gitkeep": "",
    "agent-workspace/.claude/rules/custom/.gitkeep": "",
    ...extraFiles,
  };
}

function createWorkspace(options: {
  extraFiles?: Record<string, string>;
  workspaceCwd?: string;
} = {}): string {
  const workspace = mkdtempSync(join(tmpdir(), "minime-validator-workspace-"));
  fixtures.push(workspace);
  mkdirSync(join(workspace, "agent-workspace"), { recursive: true });
  writeFileSync(
    join(workspace, "config.yaml"),
    [
      "agents:",
      "  main:",
      `    workspaceCwd: ${options.workspaceCwd ?? "./agent-workspace"}`,
      "    model: gpt-5.5",
      "telegramTokenEnv: MINIME_FIXTURE_TELEGRAM_TOKEN",
      "bindings:",
      "  - chatId: 111",
      "    agentId: main",
      "    kind: dm",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(workspace, "crons.yaml"),
    [
      "crons:",
      "  - name: smoke",
      "    schedule: \"0 9 * * *\"",
      "    prompt: smoke",
      "    agentId: main",
      "    deliveryChatId: 111",
      "",
    ].join("\n"),
  );

  for (const [rel, content] of Object.entries(options.extraFiles ?? {})) {
    writeFixtureFile(workspace, rel, content);
  }

  return workspace;
}

function validate(workspace: string, env: NodeJS.ProcessEnv = {}) {
  const contract = resolveWorkspaceContract({ workspace, cwd: workspace, env });
  return validateWorkspaceContract(contract);
}

function errorMessages(result: ReturnType<typeof validate>): string {
  return workspaceValidationErrors(result).map((item) => item.message).join("\n");
}

function warningMessages(result: ReturnType<typeof validate>): string {
  return workspaceValidationWarnings(result).map((item) => item.message).join("\n");
}

function createSiblingWorkspaceFixture(): {
  root: string;
  controlWorkspace: string;
  agentMain: string;
  agentReviewer: string;
} {
  const root = mkdtempSync(join(tmpdir(), "minime-validator-sibling-layout-"));
  fixtures.push(root);
  const controlWorkspace = join(root, "control-workspace");
  const agentMain = join(root, "agent-workspace-main");
  const agentReviewer = join(root, "agent-workspace-reviewer");
  mkdirSync(controlWorkspace, { recursive: true });
  mkdirSync(agentMain, { recursive: true });
  mkdirSync(agentReviewer, { recursive: true });
  writeFileSync(
    join(controlWorkspace, "config.yaml"),
    [
      "agents:",
      "  main:",
      `    workspaceCwd: ${agentMain}`,
      "    model: gpt-5.5",
      "  reviewer:",
      `    workspaceCwd: ${agentReviewer}`,
      "    model: gpt-5.5",
      "telegramTokenEnv: MINIME_FIXTURE_TELEGRAM_TOKEN",
      "bindings:",
      "  - chatId: 111",
      "    agentId: main",
      "    kind: dm",
      "  - chatId: 222",
      "    agentId: reviewer",
      "    kind: dm",
      "discord:",
      "  tokenEnv: MINIME_FIXTURE_DISCORD_TOKEN",
      "  bindings:",
      "    - guildId: \"guild-1\"",
      "      agentId: main",
      "      kind: channel",
      "      channels:",
      "        - channelId: \"review-channel\"",
      "          agentId: reviewer",
      "          label: Review",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(controlWorkspace, "crons.yaml"),
    [
      "crons:",
      "  - name: smoke",
      "    schedule: \"0 9 * * *\"",
      "    prompt: smoke",
      "    agentId: main",
      "    deliveryChatId: 111",
      "",
    ].join("\n"),
  );
  return { root, controlWorkspace, agentMain, agentReviewer };
}

describe("workspace validator", () => {
  it("validates the tracked fixture from a package-installed-like layout", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "minime-validator-installed-"));
    fixtures.push(projectDir);
    const packageRoot = join(projectDir, "node_modules", "minime-bot");
    const artifactExtensionDir = join(packageRoot, "dist", "extensions", "pi");
    mkdirSync(artifactExtensionDir, { recursive: true });
    const moduleUrl = pathToFileURL(join(packageRoot, "dist", "workspace-contract.js")).href;
    const contract = resolveWorkspaceContract({
      workspace: MINIMAL_WORKSPACE_FIXTURE,
      cwd: projectDir,
      moduleUrl,
      env: {},
    });

    const result = validateWorkspaceContract(contract);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.strictEqual(result.contract.effectivePaths.workspaceRoot.source, "cli");
    assert.strictEqual(result.contract.paths.piExtensionDir, artifactExtensionDir);
    assert.strictEqual(result.crons?.length, 1);
  });

  it("does not require schema.md in the control or agent workspace", () => {
    const workspace = createWorkspace();
    const result = validate(workspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(existsSync(join(workspace, "schema.md")), false);
    assert.equal(existsSync(join(workspace, "agent-workspace", "schema.md")), false);
  });

  it("hard-fails invalid control workspace config", () => {
    const workspace = createWorkspace();
    writeFileSync(
      join(workspace, "config.yaml"),
      [
        "agents: []",
        "telegramTokenEnv: MINIME_FIXTURE_TELEGRAM_TOKEN",
        "bindings: []",
        "",
      ].join("\n"),
    );

    const result = validate(workspace);

    assert.match(errorMessages(result), /config does not parse with secret resolution disabled/);
  });

  it("hard-fails invalid control workspace crons", () => {
    const workspace = createWorkspace();
    writeFileSync(join(workspace, "crons.yaml"), "crons: not-an-array\n");

    const result = validate(workspace);

    assert.match(errorMessages(result), /crons file does not parse: crons\.yaml missing 'crons' array/);
  });

  it("warns instead of hard-failing when agent context files are missing", () => {
    const workspace = createWorkspace();
    const result = validate(workspace);
    const warnings = warningMessages(result);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.match(warnings, /agent "main" context file is not present: .*CLAUDE\.md/);
    assert.match(warnings, /agent "main" has no supported knowledge layout yet/);
    assert.doesNotMatch(warnings, /context file is not present: .*MEMORY\.md/);
    assert.match(warnings, /agent "main" rules dir is not present: .*\.claude\/rules\/platform/);
    assert.match(warnings, /agent "main" rules dir is not present: .*\.claude\/rules\/custom/);
  });

  it("accepts a v2 agent workspace without root MEMORY.md", () => {
    const workspace = createWorkspace({
      extraFiles: agentContextFiles({
        "agent-workspace/wiki/schema.md": generateKnowledgeV2Schema(),
        "agent-workspace/wiki/index.md": "# Knowledge Index\n",
      }),
    });

    const result = validate(workspace);
    const warnings = warningMessages(result);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(warnings, "");
    assert.equal(existsSync(join(workspace, "agent-workspace", "MEMORY.md")), false);
  });

  it("accepts legacy MEMORY.md during compatibility", () => {
    const workspace = createWorkspace({
      extraFiles: agentContextFiles({
        "agent-workspace/MEMORY.md": "# Memory\n",
      }),
    });

    const result = validate(workspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(warningMessages(result), "");
  });

  it("reports non-v2 wiki schema and index as a supported pre-migration state", () => {
    const workspace = createWorkspace({
      extraFiles: agentContextFiles({
        "agent-workspace/wiki/schema.md": [
          "---",
          "format: karpathy-llm-wiki",
          "version: 1",
          "---",
          "",
          "# Wiki Schema",
          "",
        ].join("\n"),
        "agent-workspace/wiki/index.md": "# Wiki Index\n",
      }),
    });

    const result = validate(workspace);
    const warnings = warningMessages(result);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.match(warnings, /supported pre-migration wiki layout/);
    assert.match(warnings, /karpathy-llm-wiki/);
    assert.doesNotMatch(warnings, /has no supported knowledge layout yet/);
  });

  it("accepts artifacts as the target namespace without requiring legacy reference", () => {
    const workspace = createWorkspace({
      extraFiles: agentContextFiles({
        "agent-workspace/MEMORY.md": "# Memory\n",
        "agent-workspace/artifacts/reports/report.md": "# Report\n",
      }),
    });

    const result = validate(workspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(warningMessages(result), "");
  });

  it("surfaces symlinked legacy reference paths as migration notes", () => {
    const referenceTarget = mkdtempSync(join(tmpdir(), "minime-validator-reference-target-"));
    fixtures.push(referenceTarget);
    const workspace = createWorkspace({
      extraFiles: agentContextFiles({
        "agent-workspace/MEMORY.md": "# Memory\n",
      }),
    });
    symlinkSync(referenceTarget, join(workspace, "agent-workspace", "reference"), "dir");

    const result = validate(workspace);
    const warnings = warningMessages(result);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.match(warnings, /legacy reference\/ artifacts namespace/);
    assert.match(warnings, /reference\/ path is a symlink/);
  });

  it("validates configured SOPS references without invoking sops", () => {
    const workspace = createWorkspace();
    const fakeBin = mkdtempSync(join(tmpdir(), "minime-validator-fake-sops-"));
    fixtures.push(fakeBin);
    const marker = join(fakeBin, "sops-was-called");
    mkdirSync(join(workspace, "config"), { recursive: true });
    writeFileSync(join(workspace, "config", "secrets.sops.yaml"), "placeholder: true\n", "utf8");
    writeFileSync(
      join(workspace, "config.yaml"),
      [
        "agents:",
        "  main:",
        "    workspaceCwd: ./agent-workspace",
        "    model: gpt-5.5",
        "secrets:",
        "  sopsFile: config/secrets.sops.yaml",
        "telegramTokenSopsKey: telegram.bot_token",
        "bindings:",
        "  - chatId: 111",
        "    agentId: main",
        "    kind: dm",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(fakeBin, "sops"),
      [
        "#!/bin/bash",
        `touch ${JSON.stringify(marker)}`,
        "printf 'should-not-resolve\\n'",
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(join(fakeBin, "sops"), 0o755);

    const result = validate(workspace, { PATH: `${fakeBin}:${process.env.PATH ?? ""}` });

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(existsSync(marker), false);
  });

  it("accepts an absolute agent workspaceCwd outside the control workspace root", () => {
    const externalWorkspace = mkdtempSync(join(tmpdir(), "minime-validator-external-agent-"));
    fixtures.push(externalWorkspace);
    const workspace = createWorkspace({ workspaceCwd: externalWorkspace });
    const result = validate(workspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(result.config?.agents.main.workspaceCwd, externalWorkspace);
  });

  it("accepts a symlinked agent workspaceCwd that resolves outside the control workspace root", () => {
    const externalWorkspace = mkdtempSync(join(tmpdir(), "minime-validator-external-agent-"));
    fixtures.push(externalWorkspace);
    const workspace = createWorkspace();
    const agentWorkspace = join(workspace, "agent-workspace");
    rmSync(agentWorkspace, { recursive: true, force: true });
    symlinkSync(externalWorkspace, agentWorkspace, "dir");

    const result = validate(workspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
  });

  it("accepts sibling control and agent workspace roots with multiple agents", () => {
    const { controlWorkspace, agentMain, agentReviewer } = createSiblingWorkspaceFixture();
    const result = validate(controlWorkspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(result.contract.paths.controlWorkspaceRoot, controlWorkspace);
    assert.equal(result.config?.agents.main.workspaceCwd, agentMain);
    assert.equal(result.config?.agents.reviewer.workspaceCwd, agentReviewer);
  });

  it("validates separate control and agent workspaces with different knowledge layouts", () => {
    const { controlWorkspace, agentMain, agentReviewer } = createSiblingWorkspaceFixture();
    writeFixtureFile(agentMain, "CLAUDE.md", "# Main Agent\n");
    writeFixtureFile(agentMain, ".claude/rules/platform/.gitkeep", "");
    writeFixtureFile(agentMain, ".claude/rules/custom/.gitkeep", "");
    writeFixtureFile(agentMain, "wiki/schema.md", generateKnowledgeV2Schema());
    writeFixtureFile(agentMain, "wiki/index.md", "# Knowledge Index\n");
    writeFixtureFile(agentReviewer, "CLAUDE.md", "# Reviewer Agent\n");
    writeFixtureFile(agentReviewer, ".claude/rules/platform/.gitkeep", "");
    writeFixtureFile(agentReviewer, ".claude/rules/custom/.gitkeep", "");
    writeFixtureFile(agentReviewer, "MEMORY.md", "# Memory\n");

    const result = validate(controlWorkspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(warningMessages(result), "");
  });

  it("keeps one bot binding model routed to multiple sibling agent workspaces", () => {
    const { controlWorkspace, agentMain, agentReviewer } = createSiblingWorkspaceFixture();
    const result = validate(controlWorkspace);

    assert.deepStrictEqual(workspaceValidationErrors(result), []);
    assert.equal(result.config?.bindings[0]?.agentId, "main");
    assert.equal(result.config?.agents[result.config.bindings[0].agentId]?.workspaceCwd, agentMain);
    assert.equal(result.config?.bindings[1]?.agentId, "reviewer");
    assert.equal(result.config?.agents[result.config.bindings[1].agentId]?.workspaceCwd, agentReviewer);
    const discordBinding = result.config?.discord?.bindings[0];
    assert.equal(discordBinding?.agentId, "main");
    assert.equal(result.config?.agents[discordBinding?.agentId ?? ""]?.workspaceCwd, agentMain);
    assert.equal(discordBinding?.channels?.[0]?.agentId, "reviewer");
    assert.equal(result.config?.agents[discordBinding?.channels?.[0]?.agentId ?? ""]?.workspaceCwd, agentReviewer);
  });

  it("rejects a missing configured agent workspaceCwd", () => {
    const workspace = createWorkspace({ workspaceCwd: "./missing-agent-workspace" });
    const result = validate(workspace);

    assert.match(
      errorMessages(result),
      /agent "main" workspaceCwd does not exist/,
    );
  });

  it("rejects a configured agent workspaceCwd that is not a directory", () => {
    const workspace = createWorkspace({
      workspaceCwd: "./not-a-directory",
      extraFiles: { "not-a-directory": "not a directory" },
    });
    const result = validate(workspace);

    assert.match(
      errorMessages(result),
      /agent "main" workspaceCwd is not a directory/,
    );
  });

});
