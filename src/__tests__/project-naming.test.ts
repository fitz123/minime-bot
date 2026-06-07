import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");

function readPackageFile(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), "utf-8");
}

describe("project naming", () => {
  const readme = readPackageFile("README.md");
  const changelog = readPackageFile("CHANGELOG.md");
  const agentsDoc = readPackageFile("AGENTS.md");
  const packageJson = JSON.parse(readPackageFile("package.json")) as {
    name: string;
    description: string;
    version: string;
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
      "MINIME_WORKSPACE_ROOT",
      "control workspace",
      "test-fixtures/minimal-workspace",
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
  });

  it("package.json has no OpenClaw references in description", () => {
    assert.ok(
      !packageJson.description.toLowerCase().includes("openclaw"),
      "package.json description still contains OpenClaw",
    );
  });

  it("package.json version follows CalVer (YYYY.MM.patch)", () => {
    assert.match(packageJson.version, /^\d{4}\.\d{2}\.\d+$/);
  });

  it("types.ts has no OpenClaw references", () => {
    const types = readPackageFile("src/types.ts");
    assert.ok(
      !types.toLowerCase().includes("openclaw"),
      "types.ts still contains OpenClaw references",
    );
  });

  it("does not track private workspace template files at the package root", () => {
    for (const relativePath of [
      ".claude",
      "CLAUDE.md",
      "USER.md",
      "IDENTITY.md",
      "MEMORY.md",
      "config.yaml",
      "config.local.yaml",
      "crons.yaml",
      "crons.local.yaml",
      "reference",
      "memory",
    ]) {
      assert.equal(
        existsSync(resolve(packageRoot, relativePath)),
        false,
        `${relativePath} should not exist at the package root`,
      );
    }
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
