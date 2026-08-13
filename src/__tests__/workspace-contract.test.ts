import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ECHO_DIR_BASE_ENV,
  MINIME_CONTROL_WORKSPACE_ROOT_ENV,
  MINIME_CONFIG_PATH_ENV,
  MINIME_CRONS_PATH_ENV,
  MINIME_INSTANCE_CONFIG_PATH_ENV,
  MINIME_MEDIA_ROOT_ENV,
  resolveWorkspaceContract,
  type WorkspaceContractPaths,
} from "../workspace-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_PI_EXTENSION_DIR =
  basename(dirname(__dirname)) === "dist"
    ? resolve(BOT_ROOT, "dist", "extensions", "pi")
    : resolve(BOT_ROOT, "extensions", "pi");
const RETIRED_CONTROL_WORKSPACE_ENV = ["MINIME", "WORKSPACE", "ROOT"].join("_");

function assertAbsolutePaths(paths: WorkspaceContractPaths): void {
  for (const [name, path] of Object.entries(paths)) {
    assert.ok(isAbsolute(path), `${name} should be absolute: ${path}`);
    assert.strictEqual(path, normalize(path), `${name} should be normalized`);
  }
}

describe("workspace contract resolver", () => {
  it("uses package-root source checkout paths by default", () => {
    const cwd = "/tmp/ignored-cwd";
    const contract = resolveWorkspaceContract({
      cwd,
      env: {},
      homeDir: "/tmp/minime-home",
      pid: 12345,
    });

    assertAbsolutePaths(contract.paths);
    assert.strictEqual(contract.paths.packageRoot, BOT_ROOT);
    assert.strictEqual(contract.paths.botRoot, BOT_ROOT);
    assert.strictEqual(contract.paths.controlWorkspaceRoot, cwd);
    assert.strictEqual(contract.paths.workspaceRoot, cwd);
    assert.strictEqual(contract.paths.configPath, resolve(cwd, "config.yaml"));
    assert.strictEqual(contract.paths.instanceConfigPath, undefined);
    assert.strictEqual(contract.effectivePaths.instanceConfigPath, undefined);
    assert.strictEqual(contract.paths.cronsPath, resolve(cwd, "crons.yaml"));
    assert.strictEqual(contract.paths.piExtensionDir, DEFAULT_PI_EXTENSION_DIR);
    assert.strictEqual(contract.paths.dataDir, resolve(cwd, "data"));
    assert.strictEqual(contract.paths.sessionStorePath, resolve(cwd, "data", "sessions.json"));
    assert.strictEqual(contract.effectivePaths.sessionStorePath.source, "workspace-default");
    assert.strictEqual(contract.paths.logDir, "/tmp/minime-home/.minime/logs");
    assert.strictEqual(contract.paths.mediaBaseDir, "/tmp/bot-media");
    assert.strictEqual(contract.paths.echoDir, "/tmp/minime-home/.minime/bot-echo");
    assert.strictEqual(contract.paths.runtimeDir, resolve(cwd, ".tmp"));
    assert.strictEqual(contract.effectivePaths.workspaceRoot.source, "cwd-fallback");
    assert.match(contract.warnings.join("\n"), /Pass --workspace or MINIME_CONTROL_WORKSPACE_ROOT/);
  });

  it("uses package artifact Pi wrappers for a built source checkout", () => {
    const builtSourceModuleUrl = pathToFileURL(
      join(BOT_ROOT, "dist", "workspace-contract.js"),
    ).href;
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/ignored-cwd",
      env: {},
      moduleUrl: builtSourceModuleUrl,
      homeDir: "/tmp/minime-home",
    });

    assert.strictEqual(contract.paths.packageRoot, BOT_ROOT);
    assert.strictEqual(contract.paths.piExtensionDir, resolve(BOT_ROOT, "dist", "extensions", "pi"));
  });

  it("uses package artifact Pi wrappers for an installed package", () => {
    const installedModuleUrl = pathToFileURL(
      join(tmpdir(), "project", "node_modules", "minime-bot", "dist", "workspace-contract.js"),
    ).href;
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/install-cwd",
      env: {},
      moduleUrl: installedModuleUrl,
      homeDir: "/tmp/minime-home",
    });

    assert.strictEqual(basename(contract.paths.packageRoot), "minime-bot");
    assert.strictEqual(
      contract.paths.piExtensionDir,
      normalize(join(tmpdir(), "project", "node_modules", "minime-bot", "dist", "extensions", "pi")),
    );
  });

  it("uses an explicit CLI workspace before MINIME_CONTROL_WORKSPACE_ROOT", () => {
    const cwd = mkdtempSync(join(tmpdir(), "minime-contract-cwd-"));
    const cliWorkspace = "cli-workspace";
    const envWorkspace = join(tmpdir(), "ignored-env-workspace");
    const contract = resolveWorkspaceContract({
      cwd,
      workspace: cliWorkspace,
      env: { [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: envWorkspace },
      homeDir: "/tmp/minime-home",
    });

    assert.strictEqual(contract.paths.workspaceRoot, resolve(cwd, cliWorkspace));
    assert.strictEqual(contract.paths.controlWorkspaceRoot, resolve(cwd, cliWorkspace));
    assert.strictEqual(contract.effectivePaths.workspaceRoot.source, "cli");
    assert.strictEqual(contract.effectivePaths.controlWorkspaceRoot.source, "cli");
    assert.strictEqual(contract.paths.configPath, resolve(cwd, cliWorkspace, "config.yaml"));
  });

  it("uses MINIME_CONTROL_WORKSPACE_ROOT for control workspace-relative defaults", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "minime-contract-workspace-"));
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/ignored-cwd",
      env: { [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: workspaceRoot },
      homeDir: "/tmp/minime-home",
    });

    assertAbsolutePaths(contract.paths);
    assert.strictEqual(contract.paths.controlWorkspaceRoot, workspaceRoot);
    assert.strictEqual(contract.paths.workspaceRoot, workspaceRoot);
    assert.strictEqual(contract.effectivePaths.workspaceRoot.source, "env");
    assert.strictEqual(contract.paths.configPath, join(workspaceRoot, "config.yaml"));
    assert.strictEqual(contract.paths.cronsPath, join(workspaceRoot, "crons.yaml"));
    assert.strictEqual(contract.paths.dataDir, join(workspaceRoot, "data"));
    assert.strictEqual(contract.paths.runtimeDir, join(workspaceRoot, ".tmp"));
  });

  it("ignores the retired control workspace env", () => {
    const cwd = mkdtempSync(join(tmpdir(), "minime-contract-old-env-cwd-"));
    const oldWorkspaceRoot = mkdtempSync(join(tmpdir(), "minime-contract-old-env-"));
    const contract = resolveWorkspaceContract({
      cwd,
      env: { [RETIRED_CONTROL_WORKSPACE_ENV]: oldWorkspaceRoot },
      homeDir: "/tmp/minime-home",
    });

    assert.strictEqual(contract.paths.controlWorkspaceRoot, cwd);
    assert.strictEqual(contract.paths.workspaceRoot, cwd);
    assert.strictEqual(contract.effectivePaths.controlWorkspaceRoot.source, "cwd-fallback");
    assert.notStrictEqual(contract.paths.configPath, join(oldWorkspaceRoot, "config.yaml"));
    assert.match(contract.warnings.join("\n"), /MINIME_CONTROL_WORKSPACE_ROOT/);
    assert.doesNotMatch(contract.warnings.join("\n"), new RegExp(RETIRED_CONTROL_WORKSPACE_ENV));
  });

  it("uses explicit config and crons path overrides", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "minime-contract-overrides-"));
    const absoluteCronsPath = join(workspaceRoot, "absolute", "crons.yaml");
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/ignored-cwd",
      env: {
        [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CONFIG_PATH_ENV]: "custom/config.yaml",
        [MINIME_CRONS_PATH_ENV]: absoluteCronsPath,
        [MINIME_INSTANCE_CONFIG_PATH_ENV]: "instances/ops.yaml",
        [MINIME_MEDIA_ROOT_ENV]: "runtime/media",
        [ECHO_DIR_BASE_ENV]: "runtime/echo",
        LOG_DIR: "/tmp/minime-logs",
      },
      homeDir: "/tmp/minime-home",
      pid: 6789,
    });

    assert.strictEqual(contract.paths.configPath, join(workspaceRoot, "custom", "config.yaml"));
    assert.strictEqual(contract.paths.instanceConfigPath, join(workspaceRoot, "instances", "ops.yaml"));
    assert.strictEqual(contract.paths.cronsPath, absoluteCronsPath);
    assert.strictEqual(contract.paths.logDir, "/tmp/minime-logs");
    assert.strictEqual(contract.paths.mediaBaseDir, "/tmp/ignored-cwd/runtime/media");
    assert.strictEqual(contract.paths.echoDir, "/tmp/ignored-cwd/runtime/echo");
    assert.strictEqual(contract.effectivePaths.configPath.source, "env");
    assert.strictEqual(contract.effectivePaths.instanceConfigPath?.source, "env");
    assert.strictEqual(contract.effectivePaths.cronsPath.source, "env");
  });

  it("keeps the per-pid test media root ahead of MINIME_MEDIA_ROOT", () => {
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/minime-cwd",
      env: {
        [MINIME_MEDIA_ROOT_ENV]: "/tmp/ignored-media-root",
        MINIME_TEST_MEDIA_BASE: "/tmp/minime-test-media",
      },
      homeDir: "/tmp/minime-home",
      pid: 6789,
    });

    assert.strictEqual(contract.paths.mediaBaseDir, "/tmp/minime-test-media/6789");
  });

  it("keeps writable session, media, and echo roots distinct across deployments", () => {
    const firstRoot = mkdtempSync(join(tmpdir(), "minime-contract-first-"));
    const secondRoot = mkdtempSync(join(tmpdir(), "minime-contract-second-"));
    const first = resolveWorkspaceContract({
      cwd: "/tmp/minime-cwd",
      env: {
        [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: firstRoot,
        [MINIME_MEDIA_ROOT_ENV]: join(firstRoot, "media"),
        [ECHO_DIR_BASE_ENV]: join(firstRoot, "echo"),
      },
    });
    const second = resolveWorkspaceContract({
      cwd: "/tmp/minime-cwd",
      env: {
        [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: secondRoot,
        [MINIME_MEDIA_ROOT_ENV]: join(secondRoot, "media"),
        [ECHO_DIR_BASE_ENV]: join(secondRoot, "echo"),
      },
    });

    assert.notStrictEqual(first.paths.sessionStorePath, second.paths.sessionStorePath);
    assert.notStrictEqual(first.paths.mediaBaseDir, second.paths.mediaBaseDir);
    assert.notStrictEqual(first.paths.echoDir, second.paths.echoDir);
  });

  it("does not guess a package install parent directory as the workspace", () => {
    const cwd = mkdtempSync(join(tmpdir(), "minime-contract-install-cwd-"));
    const installedModuleUrl = pathToFileURL(
      join(tmpdir(), "project", "node_modules", "minime-bot", "dist", "workspace-contract.js"),
    ).href;
    const contract = resolveWorkspaceContract({
      cwd,
      env: {},
      moduleUrl: installedModuleUrl,
      homeDir: "/tmp/minime-home",
    });

    assert.strictEqual(basename(contract.paths.packageRoot), "minime-bot");
    assert.strictEqual(contract.paths.workspaceRoot, cwd);
    assert.strictEqual(contract.effectivePaths.workspaceRoot.source, "cwd-fallback");
    assert.match(contract.warnings.join("\n"), /Pass --workspace or MINIME_CONTROL_WORKSPACE_ROOT/);
  });

  it("returns structured diagnostics without reading or echoing secret env values", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "minime-contract-diagnostics-"));
    const contract = resolveWorkspaceContract({
      cwd: "/tmp/ignored-cwd",
      env: {
        [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: workspaceRoot,
        [MINIME_CONFIG_PATH_ENV]: "missing-config.yaml",
        TELEGRAM_TOKEN: "do-not-print-me",
        SOPS_AGE_KEY: "do-not-print-me-either",
      },
      homeDir: "/tmp/minime-home",
    });
    const diagnostics = contract.effectivePaths;
    const serialized = JSON.stringify({ diagnostics, warnings: contract.warnings });

    assert.strictEqual(diagnostics.configPath.path, join(workspaceRoot, "missing-config.yaml"));
    assert.doesNotMatch(serialized, /do-not-print-me/);
  });
});
