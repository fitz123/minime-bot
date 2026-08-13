import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");
const retiredControlWorkspaceEnv = ["MINIME", "WORKSPACE", "ROOT"].join("_");
const retiredAgentWorkspaceEnv = ["MINIME", "AGENT", "WORKSPACE", "CWD"].join("_");
const retiredWorkerProduct = ["ops", "worker"].join("-");

function readPackageFile(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), "utf-8");
}

function normalizeDoc(content: string): string {
  return content.replace(/\s+/g, " ");
}

describe("project naming", () => {
  const readme = readPackageFile("README.md");
  const changelog = readPackageFile("CHANGELOG.md");
  const agentsDoc = readPackageFile("AGENTS.md");
  const launchdOperations = readPackageFile("docs/launchd-operations.md");
  const monitoringDoc = readPackageFile("docs/monitoring.md");
  const packageJson = JSON.parse(readPackageFile("package.json")) as {
    name: string;
    description: string;
    version: string;
    files?: string[];
    bin?: Record<string, string>;
    repository?: {
      type?: string;
      url?: string;
    };
  };
  const packageLock = JSON.parse(readPackageFile("package-lock.json")) as {
    name: string;
    packages?: Record<string, { name?: string }>;
  };

  it("README has no ~/.openclaw/ path references", () => {
    assert.ok(
      !readme.includes("~/.openclaw/"),
      "README.md still contains ~/.openclaw/ paths",
    );
  });

  it("README has no bot/bot double-path commands", () => {
    assert.ok(
      !readme.includes("bot/bot"),
      "README.md still contains bot/bot double-path",
    );
  });

  it("README has no OpenClaw references", () => {
    const readmeNoLinks = readme.replace(/\[[^\]]*\]\([^)]*\)/g, "");
    assert.ok(
      !readmeNoLinks.toLowerCase().includes("openclaw"),
      "README.md still contains OpenClaw self-references",
    );
  });

  it("README title names the package repository", () => {
    assert.ok(
      readme.startsWith("# minime-bot"),
      "README.md title should be '# minime-bot'",
    );
  });

  it("README documents the package CLI and external control workspace", () => {
    for (const expected of [
      "minime-bot --help",
      "minime-bot config validate --workspace /path/to/workspace",
      "minime-bot workspace validate --workspace /path/to/workspace",
      "minime-bot knowledge search --workspace /path/to/agent-workspace",
      "minime-bot knowledge update --workspace /path/to/agent-workspace",
      "MINIME_CONTROL_WORKSPACE_ROOT",
      "MINIME_AGENT_WORKSPACE_ROOT",
      "hard cut to canonical names",
      "not passed to Pi children",
      "agent workspace, not the control workspace",
      "control workspace",
      "test-fixtures/minimal-workspace",
    ]) {
      assert.ok(readme.includes(expected), `README.md should document ${expected}`);
    }
  });

  it("packaged docs describe one canonical configuration and no worker product", () => {
    const normalizedReadme = normalizeDoc(readme);
    for (const expected of [
      "two instances of the same ordinary `minime-bot` product from the same package release",
      "one canonical configuration source",
      "read the same absolute path directly",
      "there is no second behavioral configuration",
      "no manual or automatic synchronization step",
      "cannot override agents, models, thinking, prompts, session defaults",
    ]) {
      assert.ok(normalizedReadme.includes(expected), `README.md should document ${expected}`);
    }
    assert.ok(
      packageJson.files?.includes("docs/monitoring.md"),
      "npm package should include the ordinary trigger and monitoring guide",
    );
    assert.ok(
      !packageJson.files?.includes(`docs/${retiredWorkerProduct}.md`),
      "npm package should not include the retired worker product guide",
    );
    assert.ok(
      !packageJson.files?.includes(`dist/${retiredWorkerProduct}/**`),
      "npm package should not include the retired worker product runtime",
    );
    for (const [label, content] of [
      ["README.md", readme],
      ["docs/monitoring.md", monitoringDoc],
    ] as const) {
      assert.ok(
        !content.includes(retiredWorkerProduct),
        `${label} should not describe the retired worker product`,
      );
    }
  });

  it("packaged docs describe the ordinary trigger as stateless queue glue", () => {
    for (const [label, content] of [
      ["README.md", normalizeDoc(readme)],
      ["docs/monitoring.md", normalizeDoc(monitoringDoc)],
    ] as const) {
      for (const expected of [
        "ordinary `MessageQueue`",
        "persistent agent session",
        "no trigger IDs",
        "status/result API",
        "reporting surface",
      ]) {
        assert.ok(content.includes(expected), `${label} should document ${expected}`);
      }
    }
  });

  it("AGENTS documents distinct roots and canonical workspace env names", () => {
    for (const expected of [
      "control/app workspace",
      "agent workspace",
      "package source checkout",
      "package runtime install",
      "MINIME_CONTROL_WORKSPACE_ROOT",
      "MINIME_AGENT_WORKSPACE_ROOT",
      "retired ambiguous workspace env names must not be accepted",
    ]) {
      assert.ok(agentsDoc.includes(expected), `AGENTS.md should document ${expected}`);
    }
  });

  it("README and package examples do not document retired workspace env names", () => {
    for (const [label, content] of [
      ["README.md", readme],
      ["AGENTS.md", agentsDoc],
      ["CHANGELOG.md", changelog],
      ["telegram-bot.plist.example", readPackageFile("telegram-bot.plist.example")],
    ] as const) {
      assert.ok(!content.includes(retiredControlWorkspaceEnv), `${label} still documents retired control env`);
      assert.ok(!content.includes(retiredAgentWorkspaceEnv), `${label} still documents retired agent env`);
    }
  });

  it("README documents Knowledge v2 routing boundaries", () => {
    for (const expected of [
      "format: minime-knowledge-v2",
      "`wiki/index.md` is the catalog/discovery file",
      "`wiki/pages/<type>/**/*.md` contains synthesized durable knowledge pages",
      "`raw/**` contains external, user-provided, or source inputs",
      "`artifacts/**` contains process evidence",
      "`artifacts/` is the target process-artifact namespace",
    ]) {
      assert.ok(readme.includes(expected), `README.md should document ${expected}`);
    }
  });

  it("README documents validation commands", () => {
    for (const command of [
      "npm ci",
      "npm test",
      "npm run build",
      "npm pack --dry-run",
      "npm run check:schema-guard-contract",
      "node dist/cli.js --help",
      "npm run workspace:validate -- --workspace test-fixtures/minimal-workspace",
    ]) {
      assert.ok(readme.includes(command), `README.md should include ${command}`);
    }
  });

  it("README and monitoring docs preserve the Pi and grammY upgrade contract", () => {
    const normalizedReadme = normalizeDoc(readme);
    for (const expected of [
      "all four package-owned Pi packages to 0.82.1",
      "grammY to 1.45.1",
      "@grammyjs/types` 4.0.0",
      "Pi owns the bounded summarization retry",
      "does not add a second compaction retry",
      "`agent_settled` remains the accepted-turn terminal boundary",
      "272K (272,000-token) context window",
      "does not override the model metadata",
      "does not opt into new Bot API product features",
    ]) {
      assert.ok(normalizedReadme.includes(expected), `README.md should document ${expected}`);
    }

    const normalizedMonitoringDoc = normalizeDoc(monitoringDoc);
    for (const expected of [
      "Pi runtime to 0.82.1",
      "grammY to 1.45.1",
      "Pi owns bounded summarization retries",
      "`summarization_retry_scheduled`",
      "`summarization_retry_attempt_start`",
      "`summarization_retry_finished`",
      "272K (272,000-token) context window",
      "does not add a Minime-owned compaction retry",
      "reasoning-only `stopReason=length` case as fixed",
      "change production monitoring, deployment, restart, or rollback configuration",
    ]) {
      assert.ok(normalizedMonitoringDoc.includes(expected), `docs/monitoring.md should document ${expected}`);
    }
  });

  it("documents and packages the official Node launch runtime procedure", () => {
    assert.ok(
      readme.includes(
        "[Official Node launch runtime](docs/launchd-operations.md#official-node-launch-runtime)",
      ),
      "README.md should link the official Node launch runtime procedure",
    );
    for (const expected of [
      "set -euo pipefail",
      "SHASUMS256.txt",
      "codesign -v --strict",
      "certificate leaf[subject.OU]",
      "Identifier=node",
      "TeamIdentifier=HX7739G8FX",
      "/opt/homebrew/",
      "node.rollback",
      "scripts/restart-bot.sh --plist",
    ]) {
      assert.ok(
        launchdOperations.includes(expected),
        `launchd operations should document ${expected}`,
      );
    }
    assert.match(
      launchdOperations,
      /must never read, edit, or\s+write the TCC database directly/,
      "launchd operations should forbid direct TCC database access",
    );
    assert.ok(
      packageJson.files?.includes("docs/launchd-operations.md"),
      "npm package should include the linked launchd operations guide",
    );
    const failFast = launchdOperations.indexOf("set -euo pipefail");
    const checksum = launchdOperations.indexOf("shasum -a 256 -c");
    const trustCheck = launchdOperations.indexOf("codesign -v --strict -R");
    const activation = launchdOperations.indexOf('mv "$NEXT_NODE" "$STABLE_NODE"');
    assert.ok(
      failFast >= 0 && failFast < checksum && checksum < trustCheck && trustCheck < activation,
      "launchd operations should fail fast and complete checksum/trust checks before activation",
    );
  });

  it("README states that private workspace files are not bundled", () => {
    assert.ok(readme.includes("It does not bundle a private control workspace"));
    for (const privateRootPath of [
      "root `config.yaml`",
      "`crons.yaml`",
      "`CLAUDE.md`",
      "`.claude`",
      "`USER.md`",
      "`IDENTITY.md`",
      "`MEMORY.md`",
      "`reference/`",
      "`memory/`",
      "`artifacts/`",
    ]) {
      assert.ok(
        readme.includes(privateRootPath),
        `README.md should identify ${privateRootPath} as out of scope`,
      );
    }
  });

  it("CHANGELOG describes the current Pi/Codex package architecture", () => {
    assert.ok(changelog.includes("Pi/Codex"));
    assert.ok(changelog.includes("external control workspace"));
    assert.doesNotMatch(changelog, /Claude[- ]CLI[- ]only/i);
  });

  it("AGENTS.md records public repository rules and validation", () => {
    for (const expected of [
      "Do not commit secrets",
      "PII",
      "Do not add private workspace artifacts to the package root",
      "This repository owns package runtime code",
      "extensions/pi",
      "do not push directly to `main`",
      "npm test",
      "npm run build",
      "npm pack --dry-run",
      "npm run check:schema-guard-contract",
    ]) {
      assert.ok(agentsDoc.includes(expected), `AGENTS.md should include ${expected}`);
    }
  });

  it("package.json name is the current package name", () => {
    assert.strictEqual(packageJson.name, "minime-bot");
  });

  it("package metadata points at the public package repository", () => {
    assert.strictEqual(packageJson.repository?.type, "git");
    assert.strictEqual(packageJson.repository?.url, "https://github.com/fitz123/minime-bot.git");
  });

  it("package lock root name matches the package name", () => {
    assert.strictEqual(packageLock.name, packageJson.name);
    assert.strictEqual(packageLock.packages?.[""]?.name, packageJson.name);
  });

  it("keeps the public CLI binary name", () => {
    assert.strictEqual(packageJson.bin?.["minime-bot"], "./dist/cli.js");
    assert.strictEqual(packageJson.bin?.["minime-codex-quota-sampler"], "./dist/codex-quota-sampler.js");
  });

  it("package.json has no OpenClaw references in description", () => {
    assert.ok(
      !packageJson.description.toLowerCase().includes("openclaw"),
      "package.json description still contains OpenClaw",
    );
  });

  it("package.json version follows SemVer-valid CalVer (YYYY.M.patch)", () => {
    assert.match(packageJson.version, /^\d{4}\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
  });

  it("types.ts has no OpenClaw references", () => {
    const types = readPackageFile("src/types.ts");
    assert.ok(
      !types.toLowerCase().includes("openclaw"),
      "types.ts still contains OpenClaw references",
    );
  });

  it("config.ts resolves config.yaml through workspace contract defaults", () => {
    const configTs = readPackageFile("src/config.ts");
    assert.ok(
      configTs.includes("resolveWorkspaceContract().paths.configPath"),
      "config.ts should use the workspace contract for its default config path",
    );
    assert.ok(
      configTs.includes("existsSync(localPath)"),
      "config.ts should check for and load config.local.yaml when it exists",
    );
  });

  it("test files have no openclaw references in temp paths", () => {
    const testFiles = [
      "src/__tests__/voice.test.ts",
      "src/__tests__/session-manager.test.ts",
      "src/__tests__/session-store.test.ts",
    ];
    for (const file of testFiles) {
      const content = readPackageFile(file);
      assert.ok(
        !content.includes("openclaw"),
        `${file} still contains openclaw references`,
      );
    }
  });
});
