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
    "dist/pi-runtime.js",
    "dist/tavily-monitor.js",
    "dist/tavily-monitor-runtime.js",
    "dist/workspace-contract.js",
    "dist/workspace-validator.js",
    "dist/pi-extensions/subagent-args.js",
    "dist/pi-extensions/ask-agent-args.js",
    "dist/pi-extensions/pi-invocation.js",
    "dist/pi-extensions/knowledge-tools.js",
    "dist/pi-extensions/codex-transport-overflow.js",
    "dist/pi-extensions/tavily.js",
    "dist/pi-extensions/tavily-events.js",
    "dist/pi-extensions/tavily-secret.js",
    "dist/pi-extensions/recovery-mode.js",
    "dist/pi-extensions/recovery-protocol.js",
    "dist/recovery/fixer-session.js",
    "dist/extensions/pi/codex-usage.js",
    "dist/extensions/pi/codex-transport-overflow.js",
    "dist/extensions/pi/knowledge-tools.js",
    "dist/extensions/pi/web-tools.js",
    "dist/extensions/pi/ask-agent/index.js",
    "dist/extensions/pi/subagent/agents.js",
    "dist/extensions/pi/subagent/index.js",
    "dist/extensions/pi/recovery.js",
    "scripts/deliver.sh",
    "scripts/monitoring_native.py",
    "scripts/alertmanager_webhook.py",
    "scripts/runtime_doctor.py",
    "scripts/recovery_config.py",
    "scripts/recovery_ledger.py",
    "scripts/recovery_supervisor.py",
    "scripts/recovery_cli.py",
    "scripts/recovery_rootctl.py",
    "scripts/recovery_slots.py",
    "scripts/restart-bot.sh",
    "scripts/run-cron.sh",
    "scripts/start-bot.sh",
    "telegram-bot.plist.example",
    "docs/monitoring.md",
    "docs/recovery.md",
    "examples/recovery/recovery.json",
    "examples/recovery/ai.minime.recovery-supervisor.plist",
    "examples/recovery/ai.minime.runtime-doctor-shadow.plist",
    "examples/recovery/alertmanager-shadow.yml",
    "examples/monitoring/ai.minime.alertmanager-webhook.plist",
    "examples/monitoring/ai.minime.runtime-doctor.plist",
    "examples/monitoring/alertmanager.yml",
    "examples/monitoring/minime.rules.yml",
    "examples/monitoring/prometheus.yml",
    ...EXPECTED_BUNDLED_AGENT_FILES.map((file) => `dist/extensions/pi/subagent/agents/${file}`),
    ...EXPECTED_BUNDLED_PROMPT_FILES.map((file) => `dist/extensions/pi/subagent/prompts/${file}`),
  ]) {
    assert.ok(files.includes(expected), `expected npm pack to include ${expected}`);
  }

  assert.ok(!files.some((file) => file.includes(RETIRED_GUARD_WRAPPER)), "guard extension should not be packed");
  const retiredOutputExtension = ["recovery", "plan"].join("-");
  const retiredKnowledgeWrapper = ["recovery", "knowledge", "tools"].join("-");
  assert.ok(!files.some((file) => file.includes(retiredOutputExtension)), "recovery output extension should not be packed");
  assert.ok(!files.some((file) => file.includes(retiredKnowledgeWrapper)), "recovery-only knowledge wrapper should not be packed");
  assert.ok(!files.some((file) => file.startsWith("src/")), "source TS should not be packed");
  assert.ok(!files.some((file) => file.startsWith(".claude/")), "source extension wrappers should not be packed");
  assert.ok(!files.some((file) => file.startsWith("extensions/")), "source Pi wrappers should not be packed");
  assert.ok(!files.some((file) => file.startsWith("test-fixtures/")), "workspace fixtures should not be packed");
  assert.ok(!files.some((file) => file.startsWith("dist/__tests__/")), "compiled tests should not be packed");
  assert.ok(!files.includes("schema.md"), "retired root schema contract should not be packed");
  assert.ok(!files.some((file) => RETIRED_GUARD_WRAPPER_PATTERN.test(file)), "retired guard contract should not be packed");
  assert.equal(
    files.filter((file) => file === "dist/extensions/pi/recovery.js").length,
    1,
    "recovery wrapper must be packaged exactly once without a dangling source artifact",
  );
  assert.equal(
    files.filter((file) => file === "dist/extensions/pi/web-tools.js").length,
    1,
    "canonical web-tools wrapper must be packaged exactly once",
  );
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
    writeWorkspaceFile(
      workspace,
      "recovery.json",
      JSON.stringify({
        version: 2,
        mode: "observe",
        database: "var/recovery/ledger.sqlite3",
        spoolDirectory: "var/recovery/spool",
        authTokenFile: "config/recovery-auth-token",
        fixerAuthTokenFile: "config/recovery-fixer-auth-token",
        host: "127.0.0.1",
        port: 9877,
        correlationRules: [{
          component: "bot",
          failureClass: "unavailable",
          incidentKey: "bot-unavailable",
          impact: 2,
        }],
        sourceIds: ["alertmanager", "runtime_doctor"],
        probes: [],
        runtimeDoctorCadenceSeconds: 300,
        verificationFreshnessSeconds: 660,
        verificationHoldDownSeconds: 60,
        internalAgentId: "recovery-fixer",
        sessionPolicy: {
          directory: "var/recovery/sessions",
          startupTimeoutSeconds: 30,
          resumeTimeoutSeconds: 30,
          maxReplacementsPerGeneration: 1,
          journalDigestMaxBytes: 32768,
        },
        actionPolicy: {
          maxActionsPerInvocation: 128,
          preimageMaxBytes: 1048576,
          reconciliationTimeoutSeconds: 300,
        },
        quarantinePolicy: {
          directory: "var/recovery/quarantine",
          allowedRoots: [],
          maxItemsPerIncident: 64,
          maxItemBytes: 10485760,
          maxIncidentBytes: 52428800,
        },
        reportPolicy: {
          maxBytes: 262144,
          maxTimelineEntries: 256,
          retrySeconds: 300,
        },
        slotPolicy: {
          stateDirectory: "var/recovery/slots",
          capsuleRoot: "var/recovery/capsule",
          botReleaseRoot: "var/releases",
          startupHealthTimeoutSeconds: 60,
          nodeExecutable: process.execPath,
          nodeVersion: process.versions.node,
          piExecutable: "/usr/local/bin/pi",
          piVersion: "0.80.6",
        },
        reviewedOperations: [],
        fixerLeaseSeconds: 120,
        fixerRenewSeconds: 30,
      }),
    );
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

      const installedPackage = join(projectDir, "node_modules", "minime-bot");
      for (const helper of [
        "monitoring_native.py",
        "alertmanager_webhook.py",
        "runtime_doctor.py",
        "recovery_supervisor.py",
        "recovery_cli.py",
        "recovery_slots.py",
      ]) {
        const helperPath = join(installedPackage, "scripts", helper);
        assert.ok(existsSync(helperPath), `expected installed native helper ${helper}`);
        const helperResult = spawnSync("python3", [helperPath, "--help"], {
          cwd: projectDir,
          encoding: "utf8",
          env: commandEnv(),
        });
        assert.equal(helperResult.status, 0, helperResult.stderr || helperResult.stdout || String(helperResult.error));
      }
      for (const plist of ["ai.minime.recovery-supervisor.plist", "ai.minime.runtime-doctor-shadow.plist"]) {
        const plistPath = join(installedPackage, "examples", "recovery", plist);
        const plistResult = spawnSync(
          "python3",
          ["-c", "import plistlib,sys; plistlib.load(open(sys.argv[1], 'rb'))", plistPath],
          { cwd: projectDir, encoding: "utf8", env: commandEnv() },
        );
        assert.equal(plistResult.status, 0, plistResult.stderr || String(plistResult.error));
      }
      const doctorShadow = readFileSync(
        join(installedPackage, "examples", "recovery", "ai.minime.runtime-doctor-shadow.plist"),
        "utf8",
      );
      assert.match(doctorShadow, /<string>ai\.minime\.runtime-doctor<\/string>/);
      assert.match(doctorShadow, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
      for (const requiredSetting of [
        "MINIME_DOCTOR_LAUNCHD_LABEL",
        "MINIME_DOCTOR_BOT_METRICS_URL",
        "MINIME_DOCTOR_PROMETHEUS_URL",
        "MINIME_TELEGRAM_CHAT_ID",
        "MINIME_TELEGRAM_SOPS_FILE",
        "MINIME_TELEGRAM_SOPS_KEY",
      ]) {
        assert.match(doctorShadow, new RegExp(`<key>${requiredSetting}</key>`));
      }
      for (const plist of ["ai.minime.alertmanager-webhook.plist", "ai.minime.runtime-doctor.plist"]) {
        const plistPath = join(installedPackage, "examples", "monitoring", plist);
        const plistResult = spawnSync(
          "python3",
          ["-c", "import plistlib,sys; plistlib.load(open(sys.argv[1], 'rb'))", plistPath],
          { cwd: projectDir, encoding: "utf8", env: commandEnv() },
        );
        assert.equal(plistResult.status, 0, plistResult.stderr || String(plistResult.error));
      }

      const help = runInstalledBin(projectDir, ["--help"], workspace);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /minime-bot workspace validate --workspace <path>/);
      assert.match(help.stdout, /minime-bot knowledge search --workspace <agent-workspace>/);
      assert.match(help.stdout, /minime-bot recovery config validate/);
      assert.match(help.stdout, /closed observe, diagnose, and enabled mode gates/);
      assert.match(help.stdout, /recovery capsule-stage\|bot-stage/);
      assert.match(help.stdout, /recovery-only wrapper/);

      const recoveryValidate = runInstalledBin(
        projectDir,
        ["recovery", "config", "validate", "--workspace", workspace],
        workspace,
      );
      assert.equal(recoveryValidate.status, 0, recoveryValidate.stderr || recoveryValidate.stdout);
      assert.equal(JSON.parse(recoveryValidate.stdout).mode, "observe");

      const recoveryStatus = runInstalledBin(
        projectDir,
        ["recovery", "status", "--workspace", workspace],
        workspace,
      );
      assert.equal(recoveryStatus.status, 0, recoveryStatus.stderr || recoveryStatus.stdout);
      assert.deepEqual(JSON.parse(recoveryStatus.stdout).foundation, {
        fixerAvailable: true,
        fixerDispatchAllowed: false,
        mutationAllowed: false,
        nativeVerification: true,
        observeOnly: true,
        remediationActionsAvailable: false,
      });

      const recoveryProcess = runInstalledBin(
        projectDir,
        ["recovery", "process", "--once", "--workspace", workspace],
        workspace,
      );
      assert.equal(recoveryProcess.status, 0, recoveryProcess.stderr || recoveryProcess.stdout);
      const recoveryProcessJson = JSON.parse(recoveryProcess.stdout) as Record<string, unknown>;
      assert.deepEqual(
        Object.keys(recoveryProcessJson).sort(),
        [
          "activeIncidents",
          "mode",
          "ok",
          "reportsDelivered",
          "reportsQueued",
          "verification",
        ],
      );
      assert.equal(recoveryProcessJson.reportsQueued, 0);
      assert.equal(recoveryProcessJson.reportsDelivered, 0);

      const recoveryE2e = spawnSync(
        "python3",
        ["-c", INSTALLED_RECOVERY_E2E, workspace],
        {
          cwd: join(installedPackage, "scripts"),
          encoding: "utf8",
          env: commandEnv(),
        },
      );
      assert.equal(recoveryE2e.status, 0, recoveryE2e.stderr || recoveryE2e.stdout || String(recoveryE2e.error));

      const installedRecoveryAcceptance = spawnSync(
        "python3",
        [join(BOT_ROOT, "scripts", "tests", "test_recovery_installed_acceptance.py")],
        {
          cwd: join(installedPackage, "scripts"),
          encoding: "utf8",
          env: commandEnv({ MINIME_INSTALLED_PACKAGE_ROOT: installedPackage }),
        },
      );
      assert.equal(
        installedRecoveryAcceptance.status,
        0,
        installedRecoveryAcceptance.stderr
          || installedRecoveryAcceptance.stdout
          || String(installedRecoveryAcceptance.error),
      );

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
      assert.equal(samplerDryRunJson.command, process.execPath);
      assert.match(
        samplerDryRunJson.args[0],
        /node_modules[\/\\]@earendil-works[\/\\]pi-coding-agent[\/\\]dist[\/\\]cli\.js$/,
      );
      assert.equal(samplerDryRunJson.args[1], "--approve");

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

const INSTALLED_RECOVERY_E2E = String.raw`
import json
import os
from pathlib import Path
import sys
import tempfile
import time
from unittest import mock

import monitoring_native
import recovery_config
import recovery_ledger
import recovery_supervisor
import runtime_doctor

workspace = Path(sys.argv[1])
config = recovery_config.load_recovery_config(workspace / "recovery.json", workspace)
assert config.mode == "observe"
assert set(recovery_config.recovery_static_policy(config)) == {
    "version", "mode", "correlationRules", "sourceIds", "probes",
    "runtimeDoctorCadenceSeconds", "verificationFreshnessSeconds",
    "verificationHoldDownSeconds", "internalAgentId", "sessionPolicy",
    "actionPolicy", "quarantinePolicy", "reportPolicy", "slotPolicy",
    "reviewedOperations", "fixerLeaseSeconds", "fixerRenewSeconds"
}
ledger = recovery_ledger.RecoveryLedger(config.database)
policy = recovery_supervisor.RecoveryPolicy(
    revision=1,
    rules=(recovery_supervisor.CorrelationRule("bot", "unavailable", "bot-unavailable", 2),),
    lease_seconds=10,
)

firing = json.dumps({"alerts": [{
    "status": "firing",
    "fingerprint": "installed-episode",
    "startsAt": "2026-07-14T00:00:00Z",
    "labels": {
        "alertname": "BotUnavailable",
        "component": "bot",
        "failure_class": "unavailable",
        "instance": "local",
    },
}]}).encode()
events = recovery_supervisor.normalize_alertmanager(firing)
assert ledger.record_events(events) == 1
assert ledger.record_events(events) == 0

observer = recovery_supervisor.IncidentCoordinator(
    ledger, policy, owner="installed-observer", mode="observe"
)
assert observer.reconcile() == 1
assert observer.claim_next() is None
assert ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0] == 0
assert ledger.connection.execute(
    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'actions'"
).fetchone()[0] == 0

resolved = json.dumps({"alerts": [{
    "status": "resolved",
    "fingerprint": "installed-episode",
    "startsAt": "2026-07-14T00:00:00Z",
    "endsAt": "2026-07-14T00:10:00Z",
    "labels": {
        "alertname": "BotUnavailable",
        "component": "bot",
        "failure_class": "unavailable",
        "instance": "local",
    },
}]}).encode()
resolved_events = recovery_supervisor.normalize_alertmanager(resolved)
assert ledger.record_events(resolved_events) == 1
observer.reconcile()

late_firing = json.dumps({"alerts": [{
    "status": "firing",
    "fingerprint": "installed-episode",
    "startsAt": "2026-07-13T23:00:00Z",
    "labels": {
        "alertname": "BotUnavailable",
        "component": "bot",
        "failure_class": "unavailable",
        "instance": "local",
    },
}]}).encode()
assert ledger.record_events(recovery_supervisor.normalize_alertmanager(late_firing)) == 1
observer.reconcile()
incident = ledger.connection.execute("SELECT id, state FROM incidents").fetchone()
assert incident["state"] == "verifying"
latest = ledger.latest_events()
assert len(latest) == 1
assert latest[0]["status"] == "resolved"

verification_clock = [2_000_000_000.0]
verifier = recovery_supervisor.RecoveryVerifier(
    ledger,
    observer,
    source_ids=("alertmanager",),
    cadence_seconds=config.runtime_doctor_cadence_seconds,
    freshness_seconds=config.verification_freshness_seconds,
    hold_down_seconds=0,
    clock=lambda: verification_clock[0],
)
stale_at = verification_clock[0] - config.verification_freshness_seconds - 1
verifier.record_heartbeat("supervisor", observed_at=stale_at)
verifier.record_heartbeat("alertmanager", observed_at=stale_at)
stale_result = verifier.evaluate(int(incident["id"]))
assert stale_result.recovered is False
assert "heartbeat_stale:supervisor" in stale_result.reasons
assert "heartbeat_stale:alertmanager" in stale_result.reasons
assert verifier.mechanical_classification(int(incident["id"]), stale_result) is None
assert ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0] == 0
assert ledger.connection.execute(
    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'actions'"
).fetchone()[0] == 0

controls_clock = [200.0]
controls = recovery_supervisor.RecoveryControls(ledger, clock=lambda: controls_clock[0])
controls.set_dispatch(False, actor="operator", reason="installed bounded control", expires_at=210.0)
assert controls.current().dispatch_enabled is False
controls_clock[0] = 211.0
assert controls.expire() is not None
assert controls.current().dispatch_enabled is True
ledger.close()

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    token = root / "auth-token"
    token.write_text("synthetic-auth-token-value", encoding="utf-8")
    token.chmod(0o600)
    doctor_env = {
        "MINIME_DOCTOR_STATE_PATH": str(root / "doctor.json"),
        "MINIME_DOCTOR_SINK": "tee",
        "MINIME_DOCTOR_RECOVERY_URL": "http://127.0.0.1:9877/v1/runtime-doctor",
        "MINIME_DOCTOR_RECOVERY_TOKEN_FILE": str(token),
        "MINIME_TELEGRAM_CHAT_ID": "DESTINATION_PLACEHOLDER",
    }
    doctor = runtime_doctor.DoctorConfig.from_environ(doctor_env)
    runtime_doctor.write_delivery_state(doctor.state_path, set(), None)
    native_messages = []
    recovery_batches = []

    def unavailable(batch):
        recovery_batches.append([dict(event) for event in batch])
        raise monitoring_native.DeliveryError("synthetic supervisor outage")

    for observed in (
        {"node_unavailable"},
        {"node_unavailable", "prometheus_unhealthy"},
        set(),
    ):
        with mock.patch.object(runtime_doctor, "collect_incidents", return_value=observed):
            assert runtime_doctor.run_doctor(
                doctor,
                deliver=native_messages.append,
                deliver_recovery=unavailable,
            ) == 1

    restarted_doctor = runtime_doctor.DoctorConfig.from_environ(doctor_env)
    with mock.patch.object(runtime_doctor, "collect_incidents", return_value=set()):
        assert runtime_doctor.run_doctor(
            restarted_doctor,
            deliver=native_messages.append,
            deliver_recovery=lambda batch: recovery_batches.append(
                [dict(event) for event in batch]
            ),
        ) == 0
    final_batch = recovery_batches[-1]
    assert [(event["code"], event["status"]) for event in final_batch] == [
        ("node_unavailable", "firing"),
        ("prometheus_unhealthy", "firing"),
        ("node_unavailable", "resolved"),
        ("prometheus_unhealthy", "resolved"),
    ]
    assert len({event["transition_id"] for event in final_batch}) == len(final_batch)
    assert native_messages.count(runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE) == 1
    assert "pending" not in json.loads(doctor.state_path.read_text("utf-8"))

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    true_executable = next(
        str(candidate)
        for candidate in (Path("/usr/bin/true"), Path("/bin/true"))
        if candidate.is_file()
    )
    probe_config = recovery_config.RecoveryConfig(
        path=root / "recovery.json",
        workspace=root,
        mode="observe",
        database=root / "ledger.sqlite3",
        spool_directory=root / "spool",
        auth_token_file=root / "auth-token",
        fixer_auth_token_file=root / "fixer-auth-token",
        host="127.0.0.1",
        port=9877,
        correlation_rules=config.correlation_rules,
        source_ids=("alertmanager",),
        probes=({
            "id": "native-health",
            "executable": true_executable,
            "argv": [],
            "env": {"LANG": "C"},
            "timeoutMs": 1000,
        },),
        runtime_doctor_cadence_seconds=300,
        verification_freshness_seconds=660,
        verification_hold_down_seconds=0,
        internal_agent_id="recovery-fixer",
        session_policy={
            "directory": str(root / "sessions"),
            "startupTimeoutSeconds": 30,
            "resumeTimeoutSeconds": 30,
            "maxReplacementsPerGeneration": 1,
            "journalDigestMaxBytes": 32768,
        },
        action_policy={
            "maxActionsPerInvocation": 128,
            "preimageMaxBytes": 1048576,
            "reconciliationTimeoutSeconds": 300,
        },
        quarantine_policy={
            "directory": str(root / "quarantine"),
            "allowedRoots": (),
            "maxItemsPerIncident": 64,
            "maxItemBytes": 10485760,
            "maxIncidentBytes": 52428800,
        },
        report_policy={"maxBytes": 262144, "maxTimelineEntries": 256, "retrySeconds": 300},
        slot_policy={
            "stateDirectory": str(root / "slots"),
            "capsuleRoot": str(root / "capsule"),
            "botReleaseRoot": str(root / "releases"),
            "startupHealthTimeoutSeconds": 60,
            "nodeExecutable": "/usr/local/bin/node",
            "nodeVersion": "22.19.0",
            "piExecutable": "/usr/local/bin/pi",
            "piVersion": "0.80.6",
        },
        reviewed_operations=(),
        fixer_lease_seconds=120,
        fixer_renew_seconds=30,
    )
    with recovery_ledger.RecoveryLedger(probe_config.database) as probe_ledger:
        probe_service = recovery_supervisor._build_recovery_service(
            probe_ledger,
            recovery_supervisor.AtomicJsonSpool(probe_config.spool_directory / "events"),
            recovery_supervisor.EmergencyNotifier(
                probe_config.spool_directory / "notifications", delivery=None
            ),
            configured=probe_config,
            verify_active_slots=False,
        )
        assert probe_service.accept(events, heartbeats={"alertmanager": True}).status == 200
        assert probe_service.accept(
            resolved_events, heartbeats={"alertmanager": True}
        ).status == 200
        isolated_cwd = root / "missing-active-package"
        isolated_cwd.mkdir()
        launches = []
        real_popen = recovery_supervisor.subprocess.Popen

        def capture_launch(*args, **kwargs):
            launches.append(args[0])
            return real_popen(*args, **kwargs)

        previous_cwd = Path.cwd()
        try:
            os.chdir(isolated_cwd)
            with mock.patch.dict(
                os.environ,
                {"PATH": str(root / "missing-bin"), "NODE": str(root / "missing-node")},
                clear=True,
            ), mock.patch.object(
                recovery_supervisor.subprocess, "Popen", side_effect=capture_launch
            ):
                probe_service.maintenance()
        finally:
            os.chdir(previous_cwd)
        assert len(launches) == 1
        assert tuple(launches[0]) == (true_executable,)
        probe_incident = probe_ledger.connection.execute(
            "SELECT id, generation, policy_revision, state FROM incidents"
        ).fetchone()
        assert probe_incident["state"] == "recovered"
        probe_fence = recovery_supervisor.VerificationFence(
            int(probe_incident["id"]),
            int(probe_incident["generation"]),
            int(probe_incident["policy_revision"]),
        )
        assert probe_service.verifier is not None
        assert probe_service.verifier._probe_observation(
            probe_ledger.connection, probe_fence, "native-health"
        )[0] is True
        assert probe_ledger.connection.execute(
            "SELECT count(*) FROM invocations"
        ).fetchone()[0] == 0
        assert probe_ledger.connection.execute(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'actions'"
        ).fetchone()[0] == 0

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as retention_ledger:
        historical_payloads = (
            ("firing", "2026-07-12T00:00:00Z"),
            ("resolved", "2026-07-13T00:00:00Z"),
            ("firing", "2026-07-14T00:00:00Z"),
        )
        for status, observed_at in historical_payloads:
            alert = {
                "status": status,
                "fingerprint": "retained-active-episode",
                "startsAt": observed_at,
                "labels": {
                    "alertname": "BotUnavailable",
                    "component": "bot",
                    "failure_class": "unavailable",
                    "instance": "local",
                },
            }
            if status == "resolved":
                alert["endsAt"] = observed_at
            payload = json.dumps({"alerts": [alert]}).encode()
            assert retention_ledger.record_events(
                recovery_supervisor.normalize_alertmanager(payload)
            ) == 1
        prune_at = time.time() + 2
        assert retention_ledger.prune_event_history(
            now=prune_at, retention_seconds=1, batch_size=1
        ) == 1
        assert retention_ledger.connection.execute(
            "SELECT count(*) FROM events"
        ).fetchone()[0] == 2
        assert retention_ledger.prune_event_history(
            now=prune_at, retention_seconds=1, batch_size=1
        ) == 1
        assert retention_ledger.prune_event_history(
            now=prune_at, retention_seconds=1, batch_size=1
        ) == 0
        retained = retention_ledger.latest_events()
        assert len(retained) == 1
        assert retained[0]["status"] == "firing"
        assert retention_ledger.connection.execute(
            "SELECT count(*) FROM audit WHERE operation = 'event_history_pruned'"
        ).fetchone()[0] == 2

class FailingLedger:
    def record_events(self, _events, *, observed_at=None):
        del observed_at
        raise recovery_ledger.LedgerUnavailable("synthetic")

with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    delivered = []
    emergency = recovery_supervisor.EmergencyNotifier(
        root / "notifications", delivery=delivered.append, cooldown=0
    )
    service = recovery_supervisor.RecoveryService(
        FailingLedger(), recovery_supervisor.AtomicJsonSpool(root / "events"), emergency
    )
    accepted = service.accept(events)
    assert accepted.status == 202
    assert len(list((root / "events").glob("*.json"))) == 1
    assert len(delivered) == 0
    emergency.drain()
    assert len(delivered) == 1
    assert "BotUnavailable" not in delivered[0]

    recovered_ledger = recovery_ledger.RecoveryLedger(root / "ledger.sqlite3")
    recovered_service = recovery_supervisor.RecoveryService(
        recovered_ledger, recovery_supervisor.AtomicJsonSpool(root / "events"), emergency
    )
    assert recovered_service.health().status == 200
    assert recovered_ledger.connection.execute(
        "SELECT count(*) FROM events"
    ).fetchone()[0] == 1
    assert list((root / "events").glob("*.json")) == []
    recovered_ledger.close()

    blocker = root / "blocked-spool"
    blocker.write_text("not a directory", encoding="utf-8")
    blocked_delivery = []
    blocked_service = recovery_supervisor.RecoveryService(
        FailingLedger(),
        recovery_supervisor.AtomicJsonSpool(blocker / "events"),
        recovery_supervisor.EmergencyNotifier(
            root / "blocked-notifications", delivery=blocked_delivery.append, cooldown=0
        ),
    )
    assert blocked_service.accept(events).status == 503
    blocked_service.emergency.drain()
    assert len(blocked_delivery) == 1
    assert "BotUnavailable" not in blocked_delivery[0]

    corrupt_spool = recovery_supervisor.AtomicJsonSpool(root / "corrupt-events")
    corrupt_spool.path.mkdir()
    (corrupt_spool.path / "invalid.json").write_text("not-json", encoding="ascii")
    corrupt_delivery = []
    with recovery_ledger.RecoveryLedger(root / "corrupt-spool-ledger.sqlite3") as healthy_ledger:
        corrupt_service = recovery_supervisor.RecoveryService(
            healthy_ledger,
            corrupt_spool,
            recovery_supervisor.EmergencyNotifier(
                root / "corrupt-notifications", delivery=corrupt_delivery.append, cooldown=0
            ),
        )
        assert corrupt_service.accept(events).status == 503
        corrupt_service.emergency.drain()
    assert len(corrupt_delivery) == 1
    assert "BotUnavailable" not in corrupt_delivery[0]

    corrupt_database = root / "corrupt.sqlite3"
    corrupt_bytes = b"invalid-ledger-fixture"
    corrupt_database.write_bytes(corrupt_bytes)
    try:
        recovery_ledger.RecoveryLedger(corrupt_database)
    except recovery_ledger.LedgerCorrupt:
        pass
    else:
        raise AssertionError("corrupt installed ledger must fail closed")
    assert corrupt_database.read_bytes() == corrupt_bytes

removed = (
    "Recovery" + "Processor",
    "Recovery" + "WorkerUnavailable",
    "Bounded" + "PolicyAdapter",
)
assert all(not hasattr(recovery_supervisor, name) for name in removed)
`;

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

function assertCanonicalWebWrapper(label, paths) {
  assert.equal(
    paths.filter((path) => path.endsWith("/web-tools.js")).length,
    1,
    label + " must load the canonical web-tools wrapper exactly once",
  );
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
const tavilyMonitorCore = await importPackageFile("dist/tavily-monitor.js");
const tavilyMonitorRuntime = await importPackageFile("dist/tavily-monitor-runtime.js");
const recoveryProtocol = await importPackageFile("dist/pi-extensions/recovery-protocol.js");
const recoveryFixer = await importPackageFile("dist/recovery/fixer-session.js");
assert.equal(typeof tavilyMonitorCore.TavilyMonitor, "function");
assert.equal(typeof tavilyMonitorRuntime.TavilyMonitorRuntime, "function");
assert.deepEqual(
  tavilyMonitorRuntime.resolveTavilyDeliveryDestination({
    adminChatId: undefined,
    defaultDeliveryChatId: 111,
    defaultDeliveryThreadId: 7,
  }),
  { chatId: 111, threadId: 7 },
);
assert.equal(typeof recoveryProtocol.RecoveryProtocolClient, "function");
assert.equal(typeof recoveryFixer.runRecoveryFixer, "function");
assert.equal(recoveryFixer.classifyRecoveryFixerResult({ is_error: true }), "provider_error");
assert.ok(existsSync(join(artifactDir, "recovery.js")));
const parentExtensionArgs = piRpc.resolvePiExtensionArgs({ env: {} });
const extensionPaths = extensionPathsFromArgs(parentExtensionArgs);
assert.deepEqual(
  extensionPaths.map((path) => relative(artifactDir, path)),
  ["codex-transport-overflow.js", "web-tools.js", "knowledge-tools.js", "subagent/index.js", "ask-agent/index.js"],
);
assertCanonicalWebWrapper("interactive parent", extensionPaths);
assert.equal(extensionPaths.some((path) => path.endsWith("/recovery.js")), false);
assertNoGuardContract("parent Pi extension args must not load the retired guard", parentExtensionArgs);

for (const [command, category] of [
  ["sudo launchctl kickstart gui/501/example", "privilege-escalation"],
  ["rm -rf cache", "irreversible-deletion"],
  ["git push origin repair", "external-mutation"],
  ["curl -X POST https://example.invalid", "external-mutation"],
  ["npm install package", "package-or-image-download"],
  ["docker pull example/image", "package-or-image-download"],
  ["docker volume rm data", "prune-or-volume"],
  ["telegram getUpdates", "competing-polling"],
  ["/bin/r? -rf cache", "ambiguous-shell"],
  ["{rm,-rf,cache}", "ambiguous-shell"],
  ["eval rm -rf cache", "ambiguous-shell"],
]) {
  assert.equal(recoveryProtocol.forbiddenRecoveryBashReason(command), category, command);
}

const subagentChildExtensionArgs = piRpc.resolvePiExtensionArgs({
  env: {},
  relpaths: piRpc.PI_SUBAGENT_CHILD_WRAPPER_RELPATHS,
});
assert.deepEqual(
  extensionPathsFromArgs(subagentChildExtensionArgs).map((path) => relative(artifactDir, path)),
  ["codex-transport-overflow.js", "web-tools.js", "knowledge-tools.js"],
);
assertCanonicalWebWrapper("subagent child", extensionPathsFromArgs(subagentChildExtensionArgs));
assertNoGuardContract("subagent child extension args must not load the retired guard", subagentChildExtensionArgs);

const cronExtensionArgs = piRpc.resolvePiExtensionArgs({
  env: {},
  relpaths: piRpc.PI_CRON_WRAPPER_RELPATHS,
});
assert.deepEqual(
  extensionPathsFromArgs(cronExtensionArgs).map((path) => relative(artifactDir, path)),
  ["web-tools.js", "knowledge-tools.js"],
);
assertCanonicalWebWrapper("cron", extensionPathsFromArgs(cronExtensionArgs));
assertNoGuardContract("cron Pi extension args must not load the retired guard", cronExtensionArgs);

const recoveryExtensionArgs = piRpc.resolvePiExtensionArgs({
  env: {},
  relpaths: piRpc.PI_RECOVERY_WRAPPER_RELPATHS,
});
assert.deepEqual(
  extensionPathsFromArgs(recoveryExtensionArgs).map((path) => relative(artifactDir, path)),
  ["codex-transport-overflow.js", "web-tools.js", "knowledge-tools.js"],
);
assertCanonicalWebWrapper("recovery", extensionPathsFromArgs(recoveryExtensionArgs));

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
mkdirSync(fakeBinDir, { recursive: true });
process.env.PATH = fakeBinDir + ":" + process.env.PATH;

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
  return new Response([
    'data: {"type":"response.output_text.delta","delta":"Installed "}',
    'data: {"type":"response.output_text.delta","delta":"answer."}',
    'data: {"type":"response.completed","response":{"id":"resp_installed","usage":{"input_tokens":4,"output_tokens":2,"total_tokens":6}}}',
    'data: [DONE]',
    '',
  ].join("\n\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } });
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
  ["ask_agent", "knowledge_get", "knowledge_search", "knowledge_update", "subagent", "web_search"],
);
assert.equal(registeredTools.filter((name) => name === "web_search").length, 1);
assert.equal(registeredTools.includes("web_fetch"), false);

// pi-dynamic-workflows creates in-memory sessions with SettingsManager and
// createAgentSession. Model that exact Pi boundary using the globally configured
// installed wrapper: the child inherits web_search from settings and receives no
// second custom registration path.
const piCodingAgent = await importFile(
  join(projectDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"),
);
const workflowAgentDir = join(projectDir, "workflow-agent-dir");
mkdirSync(workflowAgentDir, { recursive: true });
const workflowSettings = piCodingAgent.SettingsManager.inMemory({
  extensions: [join(artifactDir, "web-tools.js")],
});
const workflowChild = await piCodingAgent.createAgentSession({
  cwd: agentWorkspace,
  agentDir: workflowAgentDir,
  settingsManager: workflowSettings,
  sessionManager: piCodingAgent.SessionManager.inMemory(agentWorkspace),
  customTools: piCodingAgent.createCodingTools(agentWorkspace),
});
try {
  assert.deepEqual(workflowChild.extensionsResult.errors, []);
  assertCanonicalWebWrapper(
    "dynamic-workflow in-memory child",
    workflowChild.extensionsResult.extensions.map((extension) => extension.path),
  );
  assert.equal(
    workflowChild.session.getActiveToolNames().filter((name) => name === "web_search").length,
    1,
  );
  assert.equal(
    workflowChild.session.getAllTools().filter((tool) => tool.name === "web_search").length,
    1,
  );
  assert.equal(workflowChild.session.getAllTools().some((tool) => tool.name === "web_fetch"), false);
} finally {
  workflowChild.session.dispose();
}

const askAgentArgs = await importPackageFile("dist/pi-extensions/ask-agent-args.js");
const piInvocation = await importPackageFile("dist/pi-extensions/pi-invocation.js");
const installedChildInvocation = piInvocation.resolvePiInvocation(["--mode", "json"]);
assert.equal(installedChildInvocation.command, process.execPath);
assert.match(
  installedChildInvocation.args[0],
  /node_modules[\/\\]@earendil-works[\/\\]pi-coding-agent[\/\\]dist[\/\\]cli\.js$/,
);
assert.deepEqual(installedChildInvocation.args.slice(1), ["--mode", "json"]);
assert.match(readFileSync(join(artifactDir, "subagent", "index.js"), "utf8"), /resolvePiInvocation\(args\)/);
assert.match(readFileSync(join(artifactDir, "ask-agent", "index.js"), "utf8"), /resolveInvocation:\s*resolvePiInvocation/);
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
        command: "pi",
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
assertCanonicalWebWrapper("ask-agent child", askAgentLoadedExtensions);
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
const globalPiMarkerPath = join(askAgentSmokeRoot, "global-pi-ran.txt");
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
    "printf '%s\\n' 'global pi ran' > " + JSON.stringify(globalPiMarkerPath),
    "exit 97",
    "",
  ].join("\n"),
  "utf8",
);
chmodSync(join(fakeBinDir, "pi"), 0o755);
const installedPiCliPath = installedChildInvocation.args[0];
writeFileSync(
  installedPiCliPath,
  [
    'import { writeFileSync } from "node:fs";',
    "writeFileSync(" + JSON.stringify(askAgentWrapperCwdPath) + ", process.cwd() + '\\n');",
    "writeFileSync(" + JSON.stringify(askAgentWrapperArgvPath) + ", process.argv.slice(2).join('\\0') + '\\0');",
    "writeFileSync(" + JSON.stringify(askAgentWrapperCallerEnvPath) + ", (process.env.MINIME_BOT_PI_SESSION_AGENT_ID ?? '__unset__') + '\\n');",
    "console.log(" + JSON.stringify(askAgentWrapperJsonl) + ");",
    "",
  ].join("\n"),
  "utf8",
);

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
  assert.equal(existsSync(globalPiMarkerPath), false);
  assert.equal(readFileSync(askAgentWrapperCwdPath, "utf8").trim(), askAgentTargetWorkspace);
  assert.equal(readFileSync(askAgentWrapperCallerEnvPath, "utf8").trim(), "__unset__");
  const askAgentWrapperArgv = readFileSync(askAgentWrapperArgvPath, "utf8").split("\0").filter(Boolean);
  const askAgentWrapperExtensions = extensionPathsFromSpawnArgs(askAgentWrapperArgv);
  assert.deepEqual(
    askAgentWrapperExtensions.map((path) => relative(artifactDir, path)),
    ["codex-transport-overflow.js", "web-tools.js", "knowledge-tools.js"],
  );
  assertCanonicalWebWrapper("ask-agent wrapper child", askAgentWrapperExtensions);
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
  const codexContext = {
    model: { provider: "openai-codex", id: "gpt-installed", api: "openai-codex-responses" },
    modelRegistry: {
      isUsingOAuth: () => true,
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "installed-oauth-token" }),
      authStorage: {
        get: () => ({
          type: "oauth",
          access: "installed-oauth-token",
          accountId: "installed-account-id",
        }),
      },
    },
  };
  const oldOpenAiApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-be-used";
  const searchResult = await searchTool.execute(
    "call-1",
    { query: "installed wrapper" },
    undefined,
    undefined,
    codexContext,
  );
  if (oldOpenAiApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = oldOpenAiApiKey;
  }
  assert.equal(searchResult.details.ok, true);
  assert.equal(searchResult.content[0].text, "Installed answer.");
  assert.equal(searchResult.details.provider, "openai-codex");
  assert.equal(searchResult.details.model, "gpt-installed");
  assert.equal(searchResult.details.responseId, "resp_installed");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.equal(fetchCalls[0].init.headers.Authorization, "Bearer installed-oauth-token");
  assert.equal(fetchCalls[0].init.headers["ChatGPT-Account-Id"], "installed-account-id");
  const searchBody = JSON.parse(fetchCalls[0].init.body);
  assert.equal(searchBody.model, "gpt-installed");
  assert.deepEqual(searchBody.tools, [{
    type: "web_search",
    external_web_access: true,
    search_context_size: "medium",
  }]);
  assert.equal(JSON.stringify(fetchCalls[0]).includes("must-not-be-used"), false);

  const installedMonitor = new tavilyMonitorCore.TavilyMonitor({
    controlWorkspaceRoot: workspace,
    apiKey: "installed-monitor-fixture-key",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), tavilyMonitorCore.TAVILY_USAGE_URL);
      assert.equal(init.headers.Authorization, "Bearer installed-monitor-fixture-key");
      return new Response(JSON.stringify({
        key: { usage: 1, limit: 100, search_usage: 1, extract_usage: 0 },
        account: {
          current_plan: "Fixture",
          plan_usage: 1,
          plan_limit: 100,
          paygo_usage: 0,
          paygo_limit: 50,
          search_usage: 1,
          extract_usage: 0,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  const usageResult = await installedMonitor.sampleUsage();
  assert.equal(usageResult.ok, true);
  assert.equal(installedMonitor.getState().latestSample.account.plan.remaining, 99);
  assert.ok(existsSync(join(workspace, "data", "tavily", "state.json")));
  assert.equal(existsSync(join(projectDir, "data", "tavily", "state.json")), false);

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
