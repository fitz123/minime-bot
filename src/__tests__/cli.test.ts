import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../cli.js";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import { MINIME_AGENT_WORKSPACE_ROOT_ENV, MINIME_CONTROL_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = resolve(__dirname, "..", "..");
const CLI_TS = join(BOT_ROOT, "src", "cli.ts");
const SAMPLER_TS = join(BOT_ROOT, "src", "codex-quota-sampler.ts");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const MINIMAL_WORKSPACE_FIXTURE = join(BOT_ROOT, "test-fixtures", "minimal-workspace");
const RETIRED_AGENT_WORKSPACE_ENV = ["MINIME", "AGENT", "WORKSPACE", "CWD"].join("_");

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "minime-cli-workspace-"));
  mkdirSync(join(workspace, "agent-workspace"), { recursive: true });
  writeFileSync(
    join(workspace, "config.yaml"),
    `
agents:
  main:
    workspaceCwd: ./agent-workspace
    model: gpt-5.5
secrets:
  sopsFile: missing.sops.yaml
telegramTokenSopsKey: telegram.bot_token
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`,
  );
  writeFileSync(
    join(workspace, "crons.yaml"),
    `
crons:
  - name: smoke
    schedule: "0 9 * * *"
    prompt: "smoke"
    agentId: main
    deliveryChatId: 111
`,
  );
  return workspace;
}

function writeWorkspaceFile(workspace: string, relPath: string, content: string): void {
  const path = join(workspace, ...relPath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function createKnowledgeWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "minime-cli-knowledge-"));
  writeWorkspaceFile(workspace, "wiki/schema.md", generateKnowledgeV2Schema());
  writeWorkspaceFile(
    workspace,
    "wiki/pages/project/runtime.md",
    [
      "---",
      "name: Runtime",
      "description: Durable runtime notes",
      "type: project",
      "---",
      "",
      "# Runtime",
      "",
      "The runtime uses durable knowledge search.",
      "",
    ].join("\n"),
  );
  writeWorkspaceFile(
    workspace,
    "wiki/index.md",
    [
      "# Knowledge Index",
      "",
      "## Project",
      "",
      "- [Runtime](pages/project/runtime.md) - Durable runtime notes",
      "",
    ].join("\n"),
  );
  return workspace;
}

function runWithCapture(args: readonly string[], workspace?: string, env: NodeJS.ProcessEnv = {}): {
  code: number;
  stdout: string;
  stderr: string;
} {
  let stdout = "";
  let stderr = "";
  const code = runCli(args, {
    cwd: workspace,
    env,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("minime-bot CLI", () => {
  it("prints help", () => {
    const result = runWithCapture(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /minime-bot config validate --workspace <path>/);
    assert.match(result.stdout, /minime-bot workspace validate --workspace <path>/);
    assert.match(result.stdout, /minime-bot knowledge search --workspace <agent-workspace>/);
    assert.match(result.stdout, /Knowledge commands do not resolve config secrets/);
    assert.match(result.stdout, /Control\/app workspace root/);
    assert.match(result.stdout, /MINIME_CONTROL_WORKSPACE_ROOT, then source repo root or package cwd\./);
    assert.match(result.stdout, /MINIME_AGENT_WORKSPACE_ROOT/);
    assert.doesNotMatch(result.stdout, /current repo layout/);
    assert.equal(result.stderr, "");
  });

  it("validates config with explicit --workspace and does not resolve SOPS secrets", () => {
    const workspace = createWorkspace();
    try {
      const result = runWithCapture(["config", "validate", "--workspace", workspace], workspace);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /Config valid\./);
      assert.match(result.stdout, /Agents: main/);
      assert.doesNotMatch(result.stdout, /telegram\.bot_token/);
      assert.equal(result.stderr, "");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("searches knowledge with JSON output using --workspace as the agent workspace", () => {
    const controlWorkspace = createWorkspace();
    const agentWorkspace = createKnowledgeWorkspace();
    try {
      writeFileSync(join(controlWorkspace, "config.yaml"), "not valid: [");
      const result = runWithCapture(
        ["knowledge", "search", "--workspace", agentWorkspace, "--query", "runtime", "--json"],
        controlWorkspace,
      );

      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        layoutKind: string;
        query: string;
        results: Array<{ path: string; title: string }>;
      };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.layoutKind, "v2");
      assert.equal(parsed.query, "runtime");
      assert.equal(parsed.results[0]?.path, "wiki/pages/project/runtime.md");
      assert.equal(parsed.results[0]?.title, "Runtime");
    } finally {
      rmSync(controlWorkspace, { recursive: true, force: true });
      rmSync(agentWorkspace, { recursive: true, force: true });
    }
  });

  it("searches knowledge with JSON output using MINIME_AGENT_WORKSPACE_ROOT", () => {
    const controlWorkspace = createWorkspace();
    const agentWorkspace = createKnowledgeWorkspace();
    try {
      writeFileSync(join(controlWorkspace, "config.yaml"), "not valid: [");
      const result = runWithCapture(
        ["knowledge", "search", "--query", "runtime", "--json"],
        controlWorkspace,
        { [MINIME_AGENT_WORKSPACE_ROOT_ENV]: agentWorkspace },
      );

      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        results: Array<{ path: string; title: string }>;
      };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.results[0]?.path, "wiki/pages/project/runtime.md");
      assert.equal(parsed.results[0]?.title, "Runtime");
    } finally {
      rmSync(controlWorkspace, { recursive: true, force: true });
      rmSync(agentWorkspace, { recursive: true, force: true });
    }
  });

  it("ignores the retired CLI knowledge agent workspace env", () => {
    const agentWorkspace = createKnowledgeWorkspace();
    try {
      const result = runWithCapture(
        ["knowledge", "search", "--query", "runtime", "--json"],
        BOT_ROOT,
        { [RETIRED_AGENT_WORKSPACE_ENV]: agentWorkspace },
      );

      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      const parsed = JSON.parse(result.stdout) as { ok: boolean; reason: string; message: string };
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "agent-workspace-unset");
      assert.match(parsed.message, /MINIME_AGENT_WORKSPACE_ROOT/);
      assert.doesNotMatch(parsed.message, new RegExp(RETIRED_AGENT_WORKSPACE_ENV));
    } finally {
      rmSync(agentWorkspace, { recursive: true, force: true });
    }
  });

  it("reads exact knowledge line ranges from the CLI", () => {
    const agentWorkspace = createKnowledgeWorkspace();
    try {
      const result = runWithCapture(
        [
          "knowledge",
          "get",
          "--workspace",
          agentWorkspace,
          "--path",
          "wiki/pages/project/runtime.md",
          "--from",
          "7",
          "--lines",
          "1",
        ],
        BOT_ROOT,
      );

      assert.equal(result.code, 0);
      assert.equal(result.stdout, "# Runtime\n");
      assert.equal(result.stderr, "");
    } finally {
      rmSync(agentWorkspace, { recursive: true, force: true });
    }
  });

  it("updates knowledge pages with JSON output", () => {
    const agentWorkspace = createKnowledgeWorkspace();
    const temp = mkdtempSync(join(tmpdir(), "minime-cli-knowledge-body-"));
    const bodyFile = join(temp, "body.md");
    writeFileSync(bodyFile, "# New Project\n\nA durable note from the CLI.\n");
    try {
      const result = runWithCapture(
        [
          "knowledge",
          "update",
          "--workspace",
          agentWorkspace,
          "--op",
          "upsert",
          "--type",
          "project",
          "--slug",
          "new-project",
          "--frontmatter",
          JSON.stringify({
            name: "New Project",
            description: "CLI-created project page",
            type: "project",
          }),
          "--body-file",
          bodyFile,
          "--json",
        ],
        temp,
      );

      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      const parsed = JSON.parse(result.stdout) as {
        ok: boolean;
        action: string;
        path: string;
        indexPath: string;
      };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.action, "created");
      assert.equal(parsed.path, "wiki/pages/project/new-project.md");
      assert.equal(parsed.indexPath, "wiki/index.md");
      assert.match(
        readFileSync(join(agentWorkspace, "wiki", "index.md"), "utf8"),
        /\[New Project\]\(pages\/project\/new-project\.md\)/,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
      rmSync(agentWorkspace, { recursive: true, force: true });
    }
  });

  it("reports knowledge command helper errors as JSON when requested", () => {
    const agentWorkspace = createKnowledgeWorkspace();
    try {
      const result = runWithCapture(
        ["knowledge", "search", "--workspace", agentWorkspace, "--json"],
        BOT_ROOT,
      );

      assert.equal(result.code, 2);
      assert.equal(result.stderr, "");
      const parsed = JSON.parse(result.stdout) as { ok: boolean; reason: string };
      assert.equal(parsed.ok, false);
      assert.equal(parsed.reason, "invalid-query");
    } finally {
      rmSync(agentWorkspace, { recursive: true, force: true });
    }
  });

  it("reports knowledge CLI parse errors without resolving secrets", () => {
    const temp = mkdtempSync(join(tmpdir(), "minime-cli-knowledge-parse-"));
    const bodyFile = join(temp, "body.md");
    writeFileSync(bodyFile, "# Body\n", "utf8");
    try {
      const result = runWithCapture(
        [
          "knowledge",
          "update",
          "--op",
          "upsert",
          "--type",
          "project",
          "--slug",
          "runtime",
          "--frontmatter",
          "not-json",
          "--body-file",
          bodyFile,
        ],
        BOT_ROOT,
        { [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: "/tmp/private-control-workspace" },
      );

      assert.equal(result.code, 2);
      assert.match(result.stderr, /--frontmatter must be valid JSON/);
      assert.equal(result.stdout, "");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("runs knowledge migration dry-run by default and writes a JSON report", () => {
    const agentWorkspace = mkdtempSync(join(tmpdir(), "minime-cli-knowledge-migrate-"));
    const reportPath = join(agentWorkspace, ".tmp", "migration-report.json");
    writeWorkspaceFile(agentWorkspace, "MEMORY.md", "# Memory\n");
    try {
      const result = runWithCapture(
        ["knowledge", "migrate", "--workspace", agentWorkspace, "--report", reportPath, "--json"],
        BOT_ROOT,
      );

      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
      const parsed = JSON.parse(result.stdout) as { ok: boolean; mode: string; operations: Array<{ targetPath: string }> };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.mode, "dry-run");
      assert.ok(parsed.operations.some((operation) => operation.targetPath === "wiki/schema.md"));
      assert.equal(existsSync(reportPath), true);
    } finally {
      rmSync(agentWorkspace, { recursive: true, force: true });
    }
  });

  it("validates a workspace and prints effective path diagnostics", () => {
    const workspace = createWorkspace();
    try {
      const result = runWithCapture(["workspace", "validate", "--workspace", workspace], workspace);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /Workspace valid\./);
      assert.match(result.stdout, /Effective paths:/);
      assert.match(result.stdout, new RegExp(`control workspace root: ${escapeRegExp(workspace)} \\(cli\\)`));
      assert.match(result.stdout, /package root:/);
      assert.match(result.stdout, /config path:/);
      assert.match(result.stdout, /crons path:/);
      assert.match(result.stdout, /Pi extension dir:/);
      assert.match(result.stdout, /data dir:/);
      assert.match(result.stdout, /session store path:/);
      assert.match(result.stdout, /log dir:/);
      assert.match(result.stdout, /media base dir:/);
      assert.match(result.stdout, /runtime dir:/);
      assert.match(result.stdout, new RegExp(`Agent workspaces:\\n  main: ${escapeRegExp(join(workspace, "agent-workspace"))}`));
      assert.match(result.stdout, /Crons: 1/);
      assert.equal(result.stderr, "");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("validates the tracked fixture through MINIME_CONTROL_WORKSPACE_ROOT", () => {
    const result = runWithCapture(
      ["workspace", "validate"],
      BOT_ROOT,
      { [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: MINIMAL_WORKSPACE_FIXTURE },
    );

    assert.equal(result.code, 0);
    assert.match(result.stdout, /Workspace valid\./);
    assert.match(result.stdout, new RegExp(`control workspace root: ${escapeRegExp(MINIMAL_WORKSPACE_FIXTURE)} \\(env\\)`));
    assert.match(result.stdout, /config path: .*minimal-workspace\/config\.yaml \(workspace-default\)/);
    assert.equal(result.stderr, "");
  });

  it("reports workspace validation hard failures separately from warnings", () => {
    const workspace = createWorkspace();
    try {
      rmSync(join(workspace, "agent-workspace"), { recursive: true, force: true });
      const result = runWithCapture(["workspace", "validate", "--workspace", workspace], workspace);

      assert.equal(result.code, 1);
      assert.match(result.stdout, /Workspace invalid\./);
      assert.match(result.stdout, /Hard failures:/);
      assert.match(result.stdout, /workspaceCwd does not exist/);
      assert.match(result.stderr, /Error: Workspace validation failed\./);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("runs through a minime-bot bin-style shim in source development", () => {
    const temp = mkdtempSync(join(tmpdir(), "minime-cli-bin-"));
    const binDir = join(temp, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, "minime-bot");
    writeFileSync(
      binPath,
      [
        "#!/bin/sh",
        `exec ${shellQuote(process.execPath)} --import ${shellQuote(TSX_LOADER)} ${shellQuote(CLI_TS)} "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(binPath, 0o755);

    try {
      const result = spawnSync(binPath, ["--help"], {
        cwd: temp,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage:/);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it("declares the package bin target and keeps a shebang in the source entrypoint", () => {
    const packageJson = JSON.parse(readFileSync(join(BOT_ROOT, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    assert.equal(packageJson.bin?.["minime-bot"], "./dist/cli.js");
    assert.equal(packageJson.bin?.["minime-codex-quota-sampler"], "./dist/codex-quota-sampler.js");
    assert.match(readFileSync(CLI_TS, "utf8"), /^#!\/usr\/bin\/env node/);
    assert.match(readFileSync(SAMPLER_TS, "utf8"), /^#!\/usr\/bin\/env node/);
  });
});
