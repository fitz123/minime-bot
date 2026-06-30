import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_ROOT = resolve(__dirname, "..", "..");
const EXPECTED_BUNDLED_AGENT_FILES = ["planner.md", "reviewer.md", "scout.md", "worker.md"];
const EXPECTED_BUNDLED_PROMPT_FILES = ["implement-and-review.md", "implement.md", "scout-and-plan.md"];
const RETIRED_GUARD_WRAPPER = ["guardian", "protect", "files"].join("-");
const RETIRED_GUARD_WRAPPER_PATTERN = new RegExp(RETIRED_GUARD_WRAPPER);
const RETIRED_CONTROL_WORKSPACE_ENV = ["MINIME", "WORKSPACE", "ROOT"].join("_");
const RETIRED_AGENT_WORKSPACE_ENV = ["MINIME", "AGENT", "WORKSPACE", "CWD"].join("_");

interface PackedFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackedFile[];
}

function commandEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    npm_config_loglevel: "error",
    ...extra,
  };
}

function parseNpmPackJson(stdout: string): PackResult {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.lastIndexOf("\n[");
  const jsonText = jsonStart === -1 ? trimmed : trimmed.slice(jsonStart + 1);
  const parsed = JSON.parse(jsonText) as PackResult[];
  assert.equal(parsed.length, 1);
  return parsed[0];
}

function runNpmPack(args: readonly string[], cwd = BOT_ROOT): PackResult {
  const result = spawnSync("npm", ["pack", "--json", ...args], {
    cwd,
    encoding: "utf8",
    env: commandEnv(),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return parseNpmPackJson(result.stdout);
}

function createWorkspace(root: string): string {
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "agent-workspace"), { recursive: true });
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
      "  sopsFile: missing.sops.yaml",
      "telegramTokenSopsKey: telegram.bot_token",
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
  return workspace;
}

function writeWorkspaceFile(workspace: string, relPath: string, content: string): void {
  const path = join(workspace, ...relPath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function createKnowledgeFixture(agentWorkspace: string): void {
  writeWorkspaceFile(agentWorkspace, "wiki/schema.md", generateKnowledgeV2Schema());
  writeWorkspaceFile(
    agentWorkspace,
    "wiki/pages/project/runtime.md",
    [
      "---",
      "name: Runtime",
      "description: Installed package runtime notes",
      "type: project",
      "---",
      "",
      "# Runtime",
      "",
      "The installed package can search synthetic Knowledge v2 pages.",
      "",
    ].join("\n"),
  );
  writeWorkspaceFile(
    agentWorkspace,
    "wiki/index.md",
    [
      "# Knowledge Index",
      "",
      "## Project",
      "",
      "- [Runtime](pages/project/runtime.md) - Installed package runtime notes",
      "",
    ].join("\n"),
  );
}

function collectSchemaFiles(root: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectSchemaFiles(path));
    } else if (entry.isFile() && entry.name === "schema.md") {
      found.push(path);
    }
  }
  return found;
}

function runInstalledBin(projectDir: string, args: readonly string[], workspace: string): SpawnSyncReturns<string> {
  return spawnSync(join(projectDir, "node_modules", ".bin", "minime-bot"), args, {
    cwd: projectDir,
    encoding: "utf8",
    env: commandEnv({
      MINIME_CONTROL_WORKSPACE_ROOT: workspace,
    }),
  });
}

function runInstalledSamplerBin(projectDir: string, args: readonly string[], workspace: string): SpawnSyncReturns<string> {
  return spawnSync(join(projectDir, "node_modules", ".bin", "minime-codex-quota-sampler"), args, {
    cwd: projectDir,
    encoding: "utf8",
    env: commandEnv({
      MINIME_CONTROL_WORKSPACE_ROOT: workspace,
    }),
  });
}

function runInstalledDeliver(
  projectDir: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync("bash", [join(projectDir, "node_modules", "minime-bot", "scripts", "deliver.sh"), ...args], {
    cwd: projectDir,
    encoding: "utf8",
    env: commandEnv(env),
  });
}

function assertPackFiles(files: readonly string[]): void {
  for (const expected of [
    "dist/cli.js",
    "dist/config.js",
    "dist/cron-runner.js",
    "dist/pi-rpc-protocol.js",
    "dist/workspace-contract.js",
    "dist/workspace-validator.js",
    "dist/pi-extensions/subagent-args.js",
    "dist/pi-extensions/ask-agent-args.js",
    "dist/pi-extensions/pi-invocation.js",
    "dist/pi-extensions/knowledge-tools.js",
    "dist/pi-extensions/codex-transport-overflow.js",
    "dist/pi-extensions/tavily.js",
    "dist/pi-extensions/tavily-secret.js",
    "dist/extensions/pi/codex-usage.js",
    "dist/extensions/pi/codex-transport-overflow.js",
    "dist/extensions/pi/knowledge-tools.js",
    "dist/extensions/pi/web-tools.js",
    "dist/extensions/pi/ask-agent/index.js",
    "dist/extensions/pi/subagent/agents.js",
    "dist/extensions/pi/subagent/index.js",
    "scripts/deliver.sh",
    "scripts/restart-bot.sh",
    "scripts/run-cron.sh",
    "scripts/start-bot.sh",
    "telegram-bot.plist.example",
    ...EXPECTED_BUNDLED_AGENT_FILES.map((file) => `dist/extensions/pi/subagent/agents/${file}`),
    ...EXPECTED_BUNDLED_PROMPT_FILES.map((file) => `dist/extensions/pi/subagent/prompts/${file}`),
  ]) {
    assert.ok(files.includes(expected), `expected npm pack to include ${expected}`);
  }

  assert.ok(!files.some((file) => file.includes(RETIRED_GUARD_WRAPPER)), "guard extension should not be packed");
  assert.ok(!files.some((file) => file.startsWith("src/")), "source TS should not be packed");
  assert.ok(!files.some((file) => file.startsWith(".claude/")), "source extension wrappers should not be packed");
  assert.ok(!files.some((file) => file.startsWith("extensions/")), "source Pi wrappers should not be packed");
  assert.ok(!files.some((file) => file.startsWith("test-fixtures/")), "workspace fixtures should not be packed");
  assert.ok(!files.some((file) => file.startsWith("dist/__tests__/")), "compiled tests should not be packed");
  assert.ok(!files.includes("schema.md"), "retired root schema contract should not be packed");
  assert.ok(!files.some((file) => RETIRED_GUARD_WRAPPER_PATTERN.test(file)), "retired guard contract should not be packed");
}

describe("package artifact install", () => {
  it("npm pack --dry-run includes runtime artifacts and excludes source workspace files", { timeout: 120_000 }, () => {
    const staleFiles = [
      join(BOT_ROOT, "dist", "stale-pack-artifact.js"),
      join(BOT_ROOT, "dist", "stale-pack-artifact.d.ts"),
    ];
    mkdirSync(join(BOT_ROOT, "dist"), { recursive: true });
    for (const staleFile of staleFiles) {
      writeFileSync(staleFile, "throw new Error('stale artifact should not be packed');\n", "utf8");
    }

    try {
      const dryRun = runNpmPack(["--dry-run"]);
      const files = dryRun.files.map((file) => file.path);
      assertPackFiles(files);
      assert.ok(!files.includes("dist/stale-pack-artifact.js"), "stale dist JS should not be packed");
      assert.ok(!files.includes("dist/stale-pack-artifact.d.ts"), "stale dist declarations should not be packed");
    } finally {
      for (const staleFile of staleFiles) {
        try {
          unlinkSync(staleFile);
        } catch {
          // npm prepack removes these when the clean build path is working.
        }
      }
    }
  });

  it("installs the packed package and runs CLI plus generated Pi wrappers", { timeout: 180_000 }, () => {
    const temp = mkdtempSync(join(tmpdir(), "minime-package-install-"));
    const packDir = join(temp, "pack");
    const projectDir = join(temp, "project");
    mkdirSync(packDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });
    const workspace = createWorkspace(temp);
    const agentWorkspace = join(workspace, "agent-workspace");
    assert.deepEqual(collectSchemaFiles(workspace), [], "installed workspace fixture must not contain schema.md");
    createKnowledgeFixture(agentWorkspace);

    try {
      const pack = runNpmPack(["--pack-destination", packDir]);
      assertPackFiles(pack.files.map((file) => file.path));
      const tarball = join(packDir, pack.filename);
      assert.ok(existsSync(tarball), `expected tarball at ${tarball}`);

      writeFileSync(join(projectDir, "package.json"), "{\"type\":\"module\"}\n");
      const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
        cwd: projectDir,
        encoding: "utf8",
        env: commandEnv(),
      });
      assert.equal(install.status, 0, install.stderr || install.stdout);

      const help = runInstalledBin(projectDir, ["--help"], workspace);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /minime-bot workspace validate --workspace <path>/);
      assert.match(help.stdout, /minime-bot knowledge search --workspace <agent-workspace>/);

      const samplerHelp = runInstalledSamplerBin(projectDir, ["--help"], workspace);
      assert.equal(samplerHelp.status, 0, samplerHelp.stderr || samplerHelp.stdout || String(samplerHelp.error));
      assert.match(samplerHelp.stdout, /minime-codex-quota-sampler|codex-quota-sampler/);

      const samplerDryRun = runInstalledSamplerBin(
        projectDir,
        ["--dry-run", "--workspace", workspace, "--textfile-dir", join(temp, "quota-metrics")],
        workspace,
      );
      assert.equal(samplerDryRun.status, 0, samplerDryRun.stderr || samplerDryRun.stdout || String(samplerDryRun.error));
      const samplerDryRunJson = JSON.parse(samplerDryRun.stdout) as { command: string; args: string[] };
      assert.match(
        samplerDryRunJson.command,
        /(node_modules[\/\\]\.bin[\/\\]pi(?:\.cmd)?|node_modules[\/\\]@earendil-works[\/\\]pi-coding-agent[\/\\]dist[\/\\]cli\.js)$/,
      );
      assert.equal(samplerDryRunJson.args[0], "--approve");

      const configValidate = runInstalledBin(projectDir, ["config", "validate", "--workspace", workspace], workspace);
      assert.equal(configValidate.status, 0, configValidate.stderr);
      assert.match(configValidate.stdout, /Config valid\./);
      assert.doesNotMatch(configValidate.stdout, /telegram\.bot_token/);

      const workspaceValidate = runInstalledBin(projectDir, ["workspace", "validate", "--workspace", workspace], workspace);
      assert.equal(workspaceValidate.status, 0, workspaceValidate.stderr);
      assert.match(workspaceValidate.stdout, /Workspace valid\./);
      assert.match(workspaceValidate.stdout, /Pi extension dir: .*node_modules\/minime-bot\/dist\/extensions\/pi/);

      const launchAgentsDir = join(temp, "LaunchAgents");
      const launchdDryRun = runInstalledBin(
        projectDir,
        ["launchd", "crons", "sync", "--workspace", workspace, "--dry-run", "--launch-agents-dir", launchAgentsDir],
        workspace,
      );
      assert.equal(launchdDryRun.status, 0, launchdDryRun.stderr || launchdDryRun.stdout);
      assert.match(launchdDryRun.stdout, /\[DRY-RUN\] create ai\.minime\.cron\.smoke/);
      assert.equal(existsSync(join(launchAgentsDir, "ai.minime.cron.smoke.plist")), false);

      const knowledgeSearch = runInstalledBin(
        projectDir,
        ["knowledge", "search", "--workspace", agentWorkspace, "--query", "synthetic", "--json"],
        workspace,
      );
      assert.equal(knowledgeSearch.status, 0, knowledgeSearch.stderr || knowledgeSearch.stdout);
      const searchJson = JSON.parse(knowledgeSearch.stdout) as {
        ok: boolean;
        layoutKind: string;
        results: Array<{ path: string; title: string }>;
      };
      assert.equal(searchJson.ok, true);
      assert.equal(searchJson.layoutKind, "v2");
      assert.equal(searchJson.results[0]?.path, "wiki/pages/project/runtime.md");

      const knowledgeGet = runInstalledBin(
        projectDir,
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
        workspace,
      );
      assert.equal(knowledgeGet.status, 0, knowledgeGet.stderr || knowledgeGet.stdout);
      assert.equal(knowledgeGet.stdout, "# Runtime\n");

      const knowledgeBodyFile = join(temp, "installed-knowledge-body.md");
      writeFileSync(knowledgeBodyFile, "# Installed Update\n\nInstalled package CLI update is searchable.\n", "utf8");
      const knowledgeUpdate = runInstalledBin(
        projectDir,
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
          "installed-update",
          "--frontmatter",
          JSON.stringify({
            name: "Installed Update",
            description: "Installed package CLI update",
            type: "project",
          }),
          "--body-file",
          knowledgeBodyFile,
          "--json",
        ],
        workspace,
      );
      assert.equal(knowledgeUpdate.status, 0, knowledgeUpdate.stderr || knowledgeUpdate.stdout);
      const updateJson = JSON.parse(knowledgeUpdate.stdout) as { ok: boolean; path: string; indexPath: string };
      assert.equal(updateJson.ok, true);
      assert.equal(updateJson.path, "wiki/pages/project/installed-update.md");
      assert.equal(updateJson.indexPath, "wiki/index.md");

      const updatedSearch = runInstalledBin(
        projectDir,
        ["knowledge", "search", "--workspace", agentWorkspace, "--query", "installed package CLI update", "--json"],
        workspace,
      );
      assert.equal(updatedSearch.status, 0, updatedSearch.stderr || updatedSearch.stdout);
      const updatedSearchJson = JSON.parse(updatedSearch.stdout) as {
        ok: boolean;
        results: Array<{ path: string }>;
      };
      assert.equal(updatedSearchJson.ok, true);
      assert.ok(
        updatedSearchJson.results.some((result) => result.path === "wiki/pages/project/installed-update.md"),
        updatedSearch.stdout,
      );

      const fakeBin = join(temp, "fake-bin");
      const payloadPath = join(temp, "telegram-payload.json");
      mkdirSync(fakeBin, { recursive: true });
      writeFileSync(
        join(fakeBin, "curl"),
        [
          "#!/bin/bash",
          "set -euo pipefail",
          "payload=''",
          "while [ \"$#\" -gt 0 ]; do",
          "  if [ \"$1\" = \"-d\" ]; then",
          "    shift",
          "    payload=\"$1\"",
          "  fi",
          "  shift || true",
          "done",
          "cat >/dev/null",
          "printf '%s' \"$payload\" > \"$TELEGRAM_PAYLOAD_PATH\"",
          "printf '{\"ok\":true}'",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(join(fakeBin, "curl"), 0o755);
      const deliver = runInstalledDeliver(projectDir, ["111", "**bold**"], {
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        CURL_BIN: join(fakeBin, "curl"),
        TELEGRAM_BOT_TOKEN: "fixture-token",
        TELEGRAM_PAYLOAD_PATH: payloadPath,
        LOG_DIR: join(temp, "logs"),
        ECHO_DIR_BASE: join(temp, "echo"),
      });
      assert.equal(deliver.status, 0, deliver.stderr || deliver.stdout || String(deliver.error));
      const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as { parse_mode?: string; text?: string };
      assert.equal(payload.parse_mode, "HTML");
      assert.match(payload.text ?? "", /<b>bold<\/b>/);

      const artifactCheck = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", INSTALLED_ARTIFACT_CHECK],
        {
          cwd: projectDir,
          encoding: "utf8",
          env: commandEnv({
            FIXTURE_WORKSPACE: workspace,
            MINIME_AGENT_WORKSPACE_ROOT: agentWorkspace,
            MINIME_CONTROL_WORKSPACE_ROOT: workspace,
            [RETIRED_AGENT_WORKSPACE_ENV]: join(temp, "stale-agent-workspace"),
            [RETIRED_CONTROL_WORKSPACE_ENV]: join(temp, "stale-control-workspace"),
            SOURCE_BOT_ROOT: BOT_ROOT,
          }),
        },
      );
      assert.equal(artifactCheck.status, 0, artifactCheck.stderr || artifactCheck.stdout);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

const INSTALLED_ARTIFACT_CHECK = String.raw`
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = process.env.FIXTURE_WORKSPACE;
const sourceBotRoot = process.env.SOURCE_BOT_ROOT;
assert.ok(workspace, "FIXTURE_WORKSPACE is required");
assert.ok(sourceBotRoot, "SOURCE_BOT_ROOT is required");

const projectDir = process.cwd();
const packageDir = join(projectDir, "node_modules", "minime-bot");
const artifactDir = join(packageDir, "dist", "extensions", "pi");
const agentWorkspace = join(workspace, "agent-workspace");
const controlTavilySopsFile = join(workspace, "config", "secrets.sops.yaml");
const controlWorkspaceEnv = "MINIME_CONTROL_WORKSPACE_ROOT";
const agentWorkspaceEnv = "MINIME_AGENT_WORKSPACE_ROOT";
const retiredControlWorkspaceEnv = ["MINIME", "WORKSPACE", "ROOT"].join("_");
const retiredAgentWorkspaceEnv = ["MINIME", "AGENT", "WORKSPACE", "CWD"].join("_");
const importFile = (path) => import(pathToFileURL(path).href);
const importPackageFile = (relpath) => importFile(join(packageDir, relpath));
const expectedBundledAgentFiles = ${JSON.stringify(EXPECTED_BUNDLED_AGENT_FILES)};
const expectedBundledPromptFiles = ${JSON.stringify(EXPECTED_BUNDLED_PROMPT_FILES)};
const retiredGuardWrapperPattern = new RegExp(["guardian", "protect", "files"].join("-"));

function extensionPathsFromArgs(args) {
  const paths = [];
  for (let idx = 0; idx < args.length; idx += 2) {
    assert.equal(args[idx], "--extension");
    assert.equal(typeof args[idx + 1], "string");
    paths.push(args[idx + 1]);
  }
  return paths;
}

function assertNoGuardContract(label, args) {
  assert.doesNotMatch(JSON.stringify(args), retiredGuardWrapperPattern, label);
}

function extensionPathsFromSpawnArgs(args) {
  const paths = [];
  for (let idx = 0; idx < args.length; idx++) {
    if (args[idx] === "--extension") {
      assert.equal(typeof args[idx + 1], "string");
      paths.push(args[idx + 1]);
    }
  }
  return paths;
}

class FakeReadable extends EventEmitter {
  emitData(text) {
    this.emit("data", Buffer.from(text));
  }
}

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new FakeReadable();
    this.stderr = new FakeReadable();
    this.killed = false;
    this.killSignals = [];
  }

  kill(signal) {
    this.killed = true;
    this.killSignals.push(signal);
    return true;
  }

  emitClose(code) {
    this.emit("close", code);
  }
}

const piRpc = await importPackageFile("dist/pi-rpc-protocol.js");
const parentExtensionArgs = piRpc.resolvePiExtensionArgs({ env: {} });
const extensionPaths = extensionPathsFromArgs(parentExtensionArgs);
assert.deepEqual(
  extensionPaths.map((path) => relative(artifactDir, path)),
  ["codex-transport-overflow.js", "web-tools.js", "knowledge-tools.js", "subagent/index.js", "ask-agent/index.js"],
);
assertNoGuardContract("parent Pi extension args must not load the retired guard", parentExtensionArgs);

const subagentChildExtensionArgs = piRpc.resolvePiExtensionArgs({
  env: {},
  relpaths: piRpc.PI_SUBAGENT_CHILD_WRAPPER_RELPATHS,
});
assert.deepEqual(
  extensionPathsFromArgs(subagentChildExtensionArgs).map((path) => relative(artifactDir, path)),
  ["web-tools.js", "knowledge-tools.js"],
);
assertNoGuardContract("subagent child extension args must not load the retired guard", subagentChildExtensionArgs);

const cronExtensionArgs = piRpc.resolvePiExtensionArgs({
  env: {},
  relpaths: piRpc.PI_CRON_WRAPPER_RELPATHS,
});
assert.deepEqual(
  extensionPathsFromArgs(cronExtensionArgs).map((path) => relative(artifactDir, path)),
  ["knowledge-tools.js"],
);
assertNoGuardContract("cron Pi extension args must not load the retired guard", cronExtensionArgs);

for (const extensionPath of extensionPaths) {
  assert.ok(extensionPath.startsWith(artifactDir + "/"), extensionPath);
  assert.equal(extensionPath.startsWith(sourceBotRoot), false);
  const mod = await importFile(extensionPath);
  assert.equal(typeof mod.default, "function", extensionPath);
}

const configMod = await importPackageFile("dist/config.js");
const loadedConfig = configMod.loadConfig(join(workspace, "config.yaml"), {
  resolveSecrets: false,
  workspaceRoot: workspace,
});
assert.equal(loadedConfig.agents.main.workspaceCwd, agentWorkspace);
const childEnv = piRpc.buildPiSpawnEnv(loadedConfig.agents.main.workspaceCwd);
assert.equal(childEnv[controlWorkspaceEnv], workspace);
assert.equal(childEnv[agentWorkspaceEnv], agentWorkspace);
assert.equal(childEnv[retiredControlWorkspaceEnv], undefined);
assert.equal(childEnv[retiredAgentWorkspaceEnv], undefined);
assert.equal(childEnv.TELEGRAM_BOT_TOKEN, undefined);
assert.equal(childEnv.DISCORD_BOT_TOKEN, undefined);
assert.equal(childEnv.TAVILY_API_KEY, undefined);

const workspaceContract = await importPackageFile("dist/workspace-contract.js");
const validator = await importPackageFile("dist/workspace-validator.js");
const launchdCronPlists = await importPackageFile("dist/launchd-cron-plists.js");

const defaultContract = workspaceContract.resolveWorkspaceContract({
  workspace,
  cwd: projectDir,
  env: {},
});
const defaultResult = validator.validateWorkspaceContract(defaultContract);
assert.equal(validator.workspaceValidationErrors(defaultResult).length, 0);

const installedLaunchAgentsDir = join(projectDir, "installed-launch-agents");
const launchdCronResult = launchdCronPlists.generateLaunchdCronPlists({
  workspace,
  launchAgentsDir: installedLaunchAgentsDir,
  env: { MINIME_CONTROL_WORKSPACE_ROOT: workspace, HOME: join(projectDir, "home") },
  homeDir: join(projectDir, "home"),
  uid: 501,
});
assert.equal(launchdCronResult.context.runCronScript, join(packageDir, "scripts", "run-cron.sh"));
assert.ok(launchdCronResult.plists[0].content.includes("<string>" + join(packageDir, "scripts", "run-cron.sh") + "</string>"));
assert.equal(launchdCronResult.plists[0].content.includes(sourceBotRoot), false);

const registeredTools = [];
const registeredToolDefs = [];
const resourceHandlers = [];
const toolCallHandlers = [];
const fakePi = {
  on(event, handler) {
    if (event === "resources_discover") {
      resourceHandlers.push(handler);
    }
    if (event === "tool_call") {
      toolCallHandlers.push(handler);
    }
  },
  registerTool(tool) {
    registeredTools.push(tool.name);
    registeredToolDefs.push(tool);
  },
};

const fakeBinDir = join(projectDir, "fake-bin");
const sopsArgvFile = join(projectDir, "sops-argv.txt");
mkdirSync(fakeBinDir, { recursive: true });
writeFileSync(
  join(fakeBinDir, "sops"),
  [
    "#!/bin/bash",
    "printf '%s\\n' \"$@\" > \"$SOPS_ARGV_FILE\"",
    "printf 'tvly-installed-wrapper-key\\n'",
    "",
  ].join("\n"),
  "utf8",
);
chmodSync(join(fakeBinDir, "sops"), 0o755);
process.env.PATH = fakeBinDir + ":" + process.env.PATH;
process.env.SOPS_ARGV_FILE = sopsArgvFile;

const callerControlledCwd = join(projectDir, "caller-controlled-subagent-cwd");
mkdirSync(callerControlledCwd, { recursive: true });
process.chdir(callerControlledCwd);
const subagentChildEnv = piRpc.buildPiSubagentChildSpawnEnv(callerControlledCwd);
assert.equal(process.cwd(), callerControlledCwd);
assert.equal(subagentChildEnv[controlWorkspaceEnv], workspace);
assert.equal(subagentChildEnv[agentWorkspaceEnv], callerControlledCwd);
assert.equal(subagentChildEnv[retiredControlWorkspaceEnv], undefined);
assert.equal(subagentChildEnv[retiredAgentWorkspaceEnv], undefined);
assert.equal(subagentChildEnv.TELEGRAM_BOT_TOKEN, undefined);
assert.equal(subagentChildEnv.DISCORD_BOT_TOKEN, undefined);
assert.equal(subagentChildEnv.TAVILY_API_KEY, undefined);

process.chdir(agentWorkspace);

const fetchCalls = [];
const oldFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  return {
    ok: true,
    status: 200,
    json: async () => ({ results: [] }),
    text: async () => "{\"results\":[]}",
  };
};

const webTools = await importFile(join(artifactDir, "web-tools.js"));
webTools.default(fakePi);
const knowledgeTools = await importFile(join(artifactDir, "knowledge-tools.js"));
knowledgeTools.default(fakePi);
const subagent = await importFile(join(artifactDir, "subagent", "index.js"));
subagent.default(fakePi);
const askAgent = await importFile(join(artifactDir, "ask-agent", "index.js"));
askAgent.default(fakePi);
assert.deepEqual(
  registeredTools
    .filter((name) => ["web_search", "web_fetch", "knowledge_search", "knowledge_get", "knowledge_update", "subagent", "ask_agent"].includes(name))
    .sort(),
  ["ask_agent", "knowledge_get", "knowledge_search", "knowledge_update", "subagent", "web_fetch", "web_search"],
);

const askAgentArgs = await importPackageFile("dist/pi-extensions/ask-agent-args.js");
const askAgentSmokeRoot = join(projectDir, "ask-agent-smoke");
const askAgentCallerWorkspace = join(askAgentSmokeRoot, "agent-b-workspace");
const askAgentTargetWorkspace = join(askAgentSmokeRoot, "agent-c-workspace");
const askAgentTargetTmp = join(askAgentTargetWorkspace, ".tmp");
mkdirSync(askAgentCallerWorkspace, { recursive: true });
mkdirSync(askAgentTargetTmp, { recursive: true });
const askAgentContextPath = join(askAgentTargetTmp, "context.md");
writeFileSync(askAgentContextPath, "# Neutral target context\n", "utf8");

const askAgentChildEnv = piRpc.buildPiAskAgentChildSpawnEnv(askAgentTargetWorkspace);
assert.equal(askAgentChildEnv[agentWorkspaceEnv], askAgentTargetWorkspace);
assert.equal(askAgentChildEnv[piRpc.MINIME_BOT_PI_SESSION_AGENT_ID_ENV], undefined);
const askAgentChildExtensionArgs = piRpc.resolvePiAskAgentChildExtensionArgs({
  env: {},
  extensionsDir: artifactDir,
});
const askAgentSmokeChild = new FakeChild();
const askAgentSpawnCalls = [];
const askAgentExecutionLogs = [];
let askAgentNow = 1000;
const askAgentSmoke = askAgentArgs.executeAskAgent(
  { agent: "agent-c", question: "neutral package smoke question", context: "neutral package smoke context" },
  {
    config: {
      agents: {
        "agent-b": {
          id: "agent-b",
          workspaceCwd: askAgentCallerWorkspace,
          model: "gpt-5.5",
          askAgent: { enabled: true, canAsk: ["agent-c"] },
        },
        "agent-c": {
          id: "agent-c",
          workspaceCwd: askAgentTargetWorkspace,
          model: "gpt-5.5-mini",
          askAgent: { enabled: true },
        },
      },
    },
    env: { [piRpc.MINIME_BOT_PI_SESSION_AGENT_ID_ENV]: "agent-b" },
    assembleContext(target) {
      assert.equal(target.id, "agent-c");
      return { appendSystemPromptPath: askAgentContextPath };
    },
    runTarget(request) {
      return askAgentArgs.runAskAgentTargetChild(request, {
        spawn(command, args, options) {
          askAgentSpawnCalls.push({ command, args, options });
          return askAgentSmokeChild;
        },
        extensionArgs: askAgentChildExtensionArgs,
        env: askAgentChildEnv,
        timeoutMs: 1000,
        abortGraceMs: 10,
      });
    },
    log(event) {
      askAgentExecutionLogs.push(askAgentArgs.formatAskAgentExecutionLog(event));
    },
    now() {
      askAgentNow += 10;
      return askAgentNow;
    },
  },
);
assert.equal(askAgentSpawnCalls.length, 1);
assert.equal(askAgentSpawnCalls[0].command, "pi");
assert.equal(askAgentSpawnCalls[0].options.cwd, askAgentTargetWorkspace);
assert.equal(askAgentSpawnCalls[0].options.shell, false);
assert.equal(askAgentSpawnCalls[0].options.env, askAgentChildEnv);
assert.equal(askAgentSpawnCalls[0].args[askAgentSpawnCalls[0].args.indexOf("--model") + 1], "openai-codex/gpt-5.5-mini");
assert.equal(askAgentSpawnCalls[0].args[askAgentSpawnCalls[0].args.indexOf("--append-system-prompt") + 1], askAgentContextPath);
const askAgentLoadedExtensions = extensionPathsFromSpawnArgs(askAgentSpawnCalls[0].args);
assert.deepEqual(
  askAgentLoadedExtensions.map((path) => relative(artifactDir, path)),
  ["codex-transport-overflow.js", "web-tools.js", "knowledge-tools.js"],
);
assert.ok(!askAgentLoadedExtensions.some((path) => path.includes("subagent")));
assert.ok(!askAgentLoadedExtensions.some((path) => path.includes("ask-agent")));
askAgentSmokeChild.stdout.emitData(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Package smoke answer." }],
    stopReason: "end",
  },
}) + "\n");
askAgentSmokeChild.emitClose(0);
const askAgentSmokeResult = await askAgentSmoke;
assert.equal(askAgentSmokeResult.ok, true, JSON.stringify(askAgentSmokeResult));
assert.deepEqual(askAgentSmokeResult.result, {
  answer: "Package smoke answer.",
  truncated: false,
  needsClarification: false,
});
assert.deepEqual(askAgentExecutionLogs, [
  "[ask-agent] caller=agent-b target=agent-c durationMs=10 outcome=success truncated=false needsClarification=false",
]);
assert.doesNotMatch(JSON.stringify(askAgentExecutionLogs), /neutral package smoke question|neutral package smoke context|Package smoke answer/);

writeFileSync(join(askAgentTargetWorkspace, "CLAUDE.md"), "# Neutral target context\n", "utf8");
writeFileSync(
  join(askAgentSmokeRoot, "config.yaml"),
  [
    "agents:",
    "  agent-b:",
    "    workspaceCwd: ./agent-b-workspace",
    "    model: gpt-5.5",
    "    askAgent:",
    "      enabled: true",
    "      canAsk:",
    "        - agent-c",
    "  agent-c:",
    "    workspaceCwd: ./agent-c-workspace",
    "    model: gpt-5.5-mini",
    "    askAgent:",
    "      enabled: true",
    "telegramTokenEnv: TEST_UNSET_PACKAGE_ASK_AGENT_TOKEN",
    "bindings:",
    "  - chatId: 111",
    "    agentId: agent-b",
    "    kind: dm",
    "",
  ].join("\n"),
  "utf8",
);
const askAgentWrapperArgvPath = join(askAgentSmokeRoot, "wrapper-argv.bin");
const askAgentWrapperCwdPath = join(askAgentSmokeRoot, "wrapper-cwd.txt");
const askAgentWrapperCallerEnvPath = join(askAgentSmokeRoot, "wrapper-caller-env.txt");
const askAgentWrapperJsonl = JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "Wrapper " },
      { type: "text", text: "answer." },
    ],
    stopReason: "end",
  },
});
writeFileSync(
  join(fakeBinDir, "pi"),
  [
    "#!/bin/sh",
    "pwd > " + JSON.stringify(askAgentWrapperCwdPath),
    "printf '%s\\0' \"$@\" > " + JSON.stringify(askAgentWrapperArgvPath),
    "printf '%s\\n' \"\${MINIME_BOT_PI_SESSION_AGENT_ID-__unset__}\" > " + JSON.stringify(askAgentWrapperCallerEnvPath),
    "printf '%s\\n' " + JSON.stringify(askAgentWrapperJsonl),
    "",
  ].join("\n"),
  "utf8",
);
chmodSync(join(fakeBinDir, "pi"), 0o755);

const oldAskAgentWorkspace = process.env[controlWorkspaceEnv];
const oldAskAgentCaller = process.env[piRpc.MINIME_BOT_PI_SESSION_AGENT_ID_ENV];
try {
  process.env[controlWorkspaceEnv] = askAgentSmokeRoot;
  process.env[piRpc.MINIME_BOT_PI_SESSION_AGENT_ID_ENV] = "agent-b";
  const askAgentTool = registeredToolDefs.find((tool) => tool.name === "ask_agent");
  assert.ok(askAgentTool, "ask_agent should be registered");
  const askAgentWrapperResult = await askAgentTool.execute("ask-wrapper-call", {
    agent: "agent-c",
    question: "neutral wrapper smoke question",
    context: "neutral wrapper smoke context",
  });
  assert.equal(askAgentWrapperResult.details.ok, true, JSON.stringify(askAgentWrapperResult));
  assert.deepEqual(JSON.parse(askAgentWrapperResult.content[0].text), {
    answer: "Wrapper answer.",
    truncated: false,
    needsClarification: false,
  });
  assert.deepEqual(askAgentWrapperResult.details.result, {
    answer: "Wrapper answer.",
    truncated: false,
    needsClarification: false,
  });
  assert.equal(readFileSync(askAgentWrapperCwdPath, "utf8").trim(), askAgentTargetWorkspace);
  assert.equal(readFileSync(askAgentWrapperCallerEnvPath, "utf8").trim(), "__unset__");
  const askAgentWrapperArgv = readFileSync(askAgentWrapperArgvPath, "utf8").split("\0").filter(Boolean);
  const askAgentWrapperExtensions = extensionPathsFromSpawnArgs(askAgentWrapperArgv);
  assert.deepEqual(
    askAgentWrapperExtensions.map((path) => relative(artifactDir, path)),
    ["codex-transport-overflow.js", "web-tools.js", "knowledge-tools.js"],
  );
  assert.ok(!askAgentWrapperExtensions.some((path) => path.includes("subagent")));
  assert.ok(!askAgentWrapperExtensions.some((path) => path.includes("ask-agent")));
  assert.doesNotMatch(JSON.stringify(askAgentWrapperResult), /neutral wrapper smoke question|neutral wrapper smoke context/);
} finally {
  if (oldAskAgentWorkspace === undefined) {
    delete process.env[controlWorkspaceEnv];
  } else {
    process.env[controlWorkspaceEnv] = oldAskAgentWorkspace;
  }
  if (oldAskAgentCaller === undefined) {
    delete process.env[piRpc.MINIME_BOT_PI_SESSION_AGENT_ID_ENV];
  } else {
    process.env[piRpc.MINIME_BOT_PI_SESSION_AGENT_ID_ENV] = oldAskAgentCaller;
  }
}

try {
  const searchTool = registeredToolDefs.find((tool) => tool.name === "web_search");
  assert.ok(searchTool, "web_search should be registered");
  const searchResult = await searchTool.execute("call-1", { query: "installed wrapper" });
  assert.equal(searchResult.details.ok, true);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer tvly-installed-wrapper-key");
  assert.deepEqual(readFileSync(sopsArgvFile, "utf8").trim().split("\n"), [
    "-d",
    "--extract",
    "[\"tavily\"][\"api_key\"]",
    controlTavilySopsFile,
  ]);
} finally {
  globalThis.fetch = oldFetch;
}

const knowledgeSearchTool = registeredToolDefs.find((tool) => tool.name === "knowledge_search");
assert.ok(knowledgeSearchTool, "knowledge_search should be registered");
const knowledgeSearchResult = await knowledgeSearchTool.execute("knowledge-call-1", { query: "synthetic" });
assert.equal(knowledgeSearchResult.details.ok, true);
assert.match(knowledgeSearchResult.content[0].text, /wiki\/pages\/project\/runtime\.md/);

const knowledgeGetTool = registeredToolDefs.find((tool) => tool.name === "knowledge_get");
assert.ok(knowledgeGetTool, "knowledge_get should be registered");
const knowledgeGetResult = await knowledgeGetTool.execute("knowledge-call-2", {
  path: "wiki/pages/project/runtime.md",
  from: 7,
  lines: 1,
});
assert.equal(knowledgeGetResult.details.ok, true);
assert.match(knowledgeGetResult.content[0].text, /# Runtime/);

const knowledgeUpdateTool = registeredToolDefs.find((tool) => tool.name === "knowledge_update");
assert.ok(knowledgeUpdateTool, "knowledge_update should be registered");
const knowledgeUpdateResult = await knowledgeUpdateTool.execute("knowledge-call-3", {
  op: "upsert",
  type: "project",
  slug: "wrapper-update",
  frontmatter: {
    name: "Wrapper Update",
    description: "Installed wrapper update",
    type: "project",
  },
  body: "# Wrapper Update\\n\\nInstalled wrapper update is searchable.\\n",
});
assert.equal(knowledgeUpdateResult.details.ok, true);
assert.match(knowledgeUpdateResult.content[0].text, /wiki\/pages\/project\/wrapper-update\.md/);

assert.equal(toolCallHandlers.length, 1);
const blockDecision = await toolCallHandlers[0]({
  toolName: "bash",
  input: { command: "printf bad > wiki/index.md" },
});
assert.equal(blockDecision.block, true);
assert.match(blockDecision.reason, /knowledge_update/);

const agentsMod = await importFile(join(artifactDir, "subagent", "agents.js"));
const discovery = agentsMod.discoverAgents(workspace, "project");
const bundledAgentNames = discovery.agents
  .filter((agent) => agent.source === "bundled")
  .map((agent) => agent.name)
  .sort();
assert.deepEqual(bundledAgentNames, expectedBundledAgentFiles.map((file) => file.slice(0, -".md".length)).sort());
const bundledWorker = discovery.agents.find((agent) => agent.name === "worker" && agent.source === "bundled");
assert.ok(bundledWorker, "expected bundled worker agent from installed artifact");
assert.ok(bundledWorker.filePath.startsWith(join(artifactDir, "subagent", "agents")));
assert.equal(bundledWorker.filePath.startsWith(sourceBotRoot), false);

assert.equal(resourceHandlers.length, 1);
const resources = resourceHandlers[0]();
assert.deepEqual(resources.promptPaths, [join(artifactDir, "subagent", "prompts")]);
assert.deepEqual(
  readdirSync(join(artifactDir, "subagent", "agents")).filter((file) => file.endsWith(".md")).sort(),
  expectedBundledAgentFiles,
);
assert.deepEqual(
  readdirSync(resources.promptPaths[0]).filter((file) => file.endsWith(".md")).sort(),
  expectedBundledPromptFiles,
);
for (const file of expectedBundledAgentFiles) {
  assert.ok(existsSync(join(artifactDir, "subagent", "agents", file)), file);
}
for (const file of expectedBundledPromptFiles) {
  assert.ok(existsSync(join(resources.promptPaths[0], file)), file);
}
`;
