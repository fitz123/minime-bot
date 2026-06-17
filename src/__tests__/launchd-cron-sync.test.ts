import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateLaunchdCronPlists,
  syncLaunchdCrons,
  type LaunchdCommandRunner,
} from "../launchd-cron-plists.js";
import { MINIME_CONFIG_PATH_ENV, MINIME_CRONS_PATH_ENV } from "../workspace-contract.js";

interface Fixture {
  root: string;
  workspace: string;
  home: string;
  logDir: string;
  launchAgentsDir: string;
  env: NodeJS.ProcessEnv;
}

interface CommandCall {
  command: string;
  args: string[];
}

function createFixture(prefix = "minime-launchd-crons-"): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const logDir = join(root, "logs");
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(launchAgentsDir, { recursive: true });
  return {
    root,
    workspace,
    home,
    logDir,
    launchAgentsDir,
    env: { HOME: home, LOG_DIR: logDir, UID: "501" },
  };
}

function writeCrons(workspace: string, body: string): void {
  writeFileSync(join(workspace, "crons.yaml"), body.trimStart(), "utf8");
}

function cronYaml(name: string, schedule: string, extra = ""): string {
  return [
    "crons:",
    `  - name: ${name}`,
    `    schedule: "${schedule}"`,
    '    prompt: "run task"',
    "    agentId: main",
    "    deliveryChatId: 111",
    extra,
    "",
  ].join("\n");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function captureRunner(calls: CommandCall[], bootoutStatus = 0): LaunchdCommandRunner {
  return (command, args) => {
    calls.push({ command, args: [...args] });
    if (args[0] === "bootout") {
      return { status: bootoutStatus, stderr: bootoutStatus === 0 ? "" : "not loaded" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
}

function cleanup(fixture: Fixture): void {
  rmSync(fixture.root, { recursive: true, force: true });
}

describe("launchd cron plist sync", () => {
  it("uses crons.local.yaml overrides when rendering StartCalendarInterval", () => {
    const fixture = createFixture();
    try {
      writeCrons(fixture.workspace, cronYaml("daily-report", "0 9 * * *"));
      writeFileSync(
        join(fixture.workspace, "crons.local.yaml"),
        cronYaml("daily-report", "15 10 * * 1"),
        "utf8",
      );

      const result = generateLaunchdCronPlists({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        env: fixture.env,
        homeDir: fixture.home,
      });

      assert.equal(result.plists.length, 1);
      const plist = result.plists[0].content;
      assert.match(plist, /<key>StartCalendarInterval<\/key>/);
      assert.match(plist, /<key>Minute<\/key>\s*<integer>15<\/integer>/);
      assert.match(plist, /<key>Hour<\/key>\s*<integer>10<\/integer>/);
      assert.match(plist, /<key>Weekday<\/key>\s*<integer>1<\/integer>/);
      assert.doesNotMatch(plist, /<key>StartInterval<\/key>/);
      assert.match(plist, new RegExp(`<string>${result.context.runCronScript.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</string>`));
    } finally {
      cleanup(fixture);
    }
  });

  it("renders every N schedules as StartInterval", () => {
    const fixture = createFixture();
    try {
      writeCrons(fixture.workspace, cronYaml("frequent", "every 300"));

      const result = generateLaunchdCronPlists({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        env: fixture.env,
        homeDir: fixture.home,
      });

      const plist = result.plists[0].content;
      assert.match(plist, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/);
      assert.doesNotMatch(plist, /<key>StartCalendarInterval<\/key>/);
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects cron schedules that restrict both day-of-month and weekday", () => {
    const fixture = createFixture();
    try {
      writeCrons(fixture.workspace, cronYaml("ambiguous-day", "0 9 1 * 1"));

      assert.throws(
        () =>
          generateLaunchdCronPlists({
            workspace: fixture.workspace,
            launchAgentsDir: fixture.launchAgentsDir,
            env: fixture.env,
            homeDir: fixture.home,
          }),
        /restricting both day-of-month and weekday is unsupported/,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("preserves uppercase cron names supported by the previous generator", () => {
    const fixture = createFixture();
    try {
      writeFileSync(
        join(fixture.workspace, "crons.yaml"),
        [
          "crons:",
          "  - name: Daily",
          '    schedule: "0 8 * * *"',
          '    prompt: "run uppercase"',
          "    agentId: main",
          "    deliveryChatId: 111",
          "",
        ].join("\n"),
        "utf8",
      );

      const result = generateLaunchdCronPlists({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        env: fixture.env,
        homeDir: fixture.home,
      });

      assert.equal(result.plists.length, 1);
      assert.equal(result.plists[0].label, "ai.minime.cron.Daily");
      assert.match(result.plists[0].content, /<string>Daily<\/string>/);
    } finally {
      cleanup(fixture);
    }
  });

  it("persists explicit config and crons path env overrides in rendered plists", () => {
    const fixture = createFixture();
    try {
      const settingsDir = join(fixture.workspace, "settings");
      mkdirSync(settingsDir, { recursive: true });
      const configPath = join(settingsDir, "config.yaml");
      const cronsPath = join(settingsDir, "crons.yaml");
      writeFileSync(configPath, "agents: {}\n", "utf8");
      writeFileSync(cronsPath, cronYaml("active", "0 8 * * *"), "utf8");

      const result = generateLaunchdCronPlists({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        env: {
          ...fixture.env,
          [MINIME_CONFIG_PATH_ENV]: "settings/config.yaml",
          [MINIME_CRONS_PATH_ENV]: "settings/crons.yaml",
        },
        homeDir: fixture.home,
      });

      const plist = result.plists[0].content;
      assert.match(
        plist,
        new RegExp(`<key>${MINIME_CONFIG_PATH_ENV}</key>\\s*<string>${escapeRegex(configPath)}</string>`),
      );
      assert.match(
        plist,
        new RegExp(`<key>${MINIME_CRONS_PATH_ENV}</key>\\s*<string>${escapeRegex(cronsPath)}</string>`),
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("dry-run plans create and prune actions without writing files or running commands", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const stalePath = join(fixture.launchAgentsDir, "ai.minime.cron.stale.plist");
      const botPath = join(fixture.launchAgentsDir, "ai.minime.telegram-bot.plist");
      writeFileSync(stalePath, "<plist><dict><key>Label</key><string>ai.minime.cron.stale</string></dict></plist>\n", "utf8");
      writeFileSync(botPath, "bot", "utf8");

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        dryRun: true,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls),
      });

      assert.equal(calls.length, 0);
      assert.equal(existsSync(join(fixture.launchAgentsDir, "ai.minime.cron.active.plist")), false);
      assert.match(readFileSync(stalePath, "utf8"), /ai\.minime\.cron\.stale/);
      assert.equal(readFileSync(botPath, "utf8"), "bot");
      assert.deepEqual(result.items.map((item) => `${item.action}:${item.label}`), [
        "create:ai.minime.cron.active",
        "delete:ai.minime.cron.stale",
      ]);
      assert.equal(result.items.some((item) => item.label === "ai.minime.telegram-bot"), false);
    } finally {
      cleanup(fixture);
    }
  });

  it("writes changed active plists, rebootstraps them, and prunes stale or disabled cron plists", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeFileSync(
        join(fixture.workspace, "crons.yaml"),
        [
          "crons:",
          "  - name: active",
          '    schedule: "0 8 * * *"',
          '    prompt: "run active"',
          "    agentId: main",
          "    deliveryChatId: 111",
          "  - name: disabled",
          '    schedule: "0 9 * * *"',
          '    prompt: "disabled"',
          "    agentId: main",
          "    deliveryChatId: 111",
          "    enabled: false",
          "",
        ].join("\n"),
        "utf8",
      );
      const activePath = join(fixture.launchAgentsDir, "ai.minime.cron.active.plist");
      const stalePath = join(fixture.launchAgentsDir, "ai.minime.cron.stale.plist");
      const disabledPath = join(fixture.launchAgentsDir, "ai.minime.cron.disabled.plist");
      const botPath = join(fixture.launchAgentsDir, "ai.minime.telegram-bot.plist");
      writeFileSync(activePath, "old active plist", "utf8");
      writeFileSync(stalePath, "<plist><dict><key>Label</key><string>ai.minime.cron.stale</string></dict></plist>\n", "utf8");
      writeFileSync(disabledPath, "<plist><dict><key>Label</key><string>ai.minime.cron.disabled</string></dict></plist>\n", "utf8");
      writeFileSync(botPath, "bot", "utf8");

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls, 3),
      });

      assert.match(readFileSync(activePath, "utf8"), /<string>ai\.minime\.cron\.active<\/string>/);
      assert.equal(existsSync(stalePath), false);
      assert.equal(existsSync(disabledPath), false);
      assert.equal(readFileSync(botPath, "utf8"), "bot");
      assert.deepEqual(result.items.map((item) => `${item.action}:${item.label}:${item.reason}`), [
        "update:ai.minime.cron.active:active",
        "delete:ai.minime.cron.disabled:disabled",
        "delete:ai.minime.cron.stale:stale",
      ]);

      assert.ok(calls.some((call) => call.command.endsWith("plutil") && call.args.join(" ").startsWith(`-lint ${activePath}.tmp-`)));
      assert.ok(calls.some((call) => call.args.join(" ") === "bootout gui/501/ai.minime.cron.active"));
      assert.ok(calls.some((call) => call.args.join(" ") === `bootstrap gui/501 ${activePath}`));
      assert.ok(calls.some((call) => call.args.join(" ") === "bootout gui/501/ai.minime.cron.stale"));
      assert.ok(calls.some((call) => call.args.join(" ") === "bootout gui/501/ai.minime.cron.disabled"));
      assert.equal(calls.some((call) => call.args[0] === "bootstrap" && call.args.some((arg) => arg.includes("stale"))), false);
      assert.equal(calls.some((call) => call.args[0] === "bootstrap" && call.args.some((arg) => arg.includes("disabled"))), false);
      assert.equal(calls.some((call) => call.args.some((arg) => arg.includes("ai.minime.telegram-bot"))), false);
    } finally {
      cleanup(fixture);
    }
  });

  it("keeps stale cron plists when prune is disabled", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const stalePath = join(fixture.launchAgentsDir, "ai.minime.cron.stale.plist");
      writeFileSync(stalePath, "stale", "utf8");

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        prune: false,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls),
      });

      assert.equal(existsSync(stalePath), true);
      assert.equal(result.items.some((item) => item.label === "ai.minime.cron.stale"), false);
      assert.equal(calls.some((call) => call.args.some((arg) => arg.includes("ai.minime.cron.stale"))), false);
    } finally {
      cleanup(fixture);
    }
  });

  it("does not run commands for unchanged active plists", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const generated = generateLaunchdCronPlists({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
      });
      writeFileSync(generated.plists[0].plistPath, generated.plists[0].content, "utf8");

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls),
      });

      assert.deepEqual(result.items.map((item) => `${item.action}:${item.label}`), [
        "unchanged:ai.minime.cron.active",
      ]);
      assert.equal(calls.length, 0);
    } finally {
      cleanup(fixture);
    }
  });

  it("keeps the previous plist when plutil lint fails", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const activePath = join(fixture.launchAgentsDir, "ai.minime.cron.active.plist");
      writeFileSync(activePath, "old active plist", "utf8");
      const runner: LaunchdCommandRunner = (command, args) => {
        calls.push({ command, args: [...args] });
        if (command.endsWith("plutil")) {
          return { status: 1, stderr: "lint failed" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      assert.throws(
        () => syncLaunchdCrons({
          workspace: fixture.workspace,
          launchAgentsDir: fixture.launchAgentsDir,
          env: fixture.env,
          homeDir: fixture.home,
          uid: 501,
          commandRunner: runner,
        }),
        /plutil -lint .* failed: lint failed/,
      );
      assert.equal(readFileSync(activePath, "utf8"), "old active plist");
      assert.equal(calls.some((call) => call.args[0] === "bootstrap"), false);
    } finally {
      cleanup(fixture);
    }
  });

  it("restores and re-bootstraps the previous plist when launchctl bootstrap fails", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const activePath = join(fixture.launchAgentsDir, "ai.minime.cron.active.plist");
      writeFileSync(activePath, "old active plist", "utf8");
      let bootstrapCount = 0;
      const runner: LaunchdCommandRunner = (command, args) => {
        calls.push({ command, args: [...args] });
        if (args[0] === "bootout") {
          return { status: 0, stdout: "", stderr: "" };
        }
        if (args[0] === "bootstrap") {
          bootstrapCount += 1;
          if (bootstrapCount > 1) {
            return { status: 0, stdout: "", stderr: "" };
          }
          return { status: 5, stderr: "bootstrap failed" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      assert.throws(
        () => syncLaunchdCrons({
          workspace: fixture.workspace,
          launchAgentsDir: fixture.launchAgentsDir,
          env: fixture.env,
          homeDir: fixture.home,
          uid: 501,
          commandRunner: runner,
        }),
        /launchctl bootstrap .* failed: bootstrap failed/,
      );
      assert.equal(readFileSync(activePath, "utf8"), "old active plist");
      assert.equal(calls.filter((call) => call.args.join(" ") === `bootstrap gui/501 ${activePath}`).length, 2);
    } finally {
      cleanup(fixture);
    }
  });

  it("does not rollback-bootstrap the previous plist when bootout was only an ignored not-loaded failure", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const activePath = join(fixture.launchAgentsDir, "ai.minime.cron.active.plist");
      writeFileSync(activePath, "old active plist", "utf8");
      const runner: LaunchdCommandRunner = (command, args) => {
        calls.push({ command, args: [...args] });
        if (args[0] === "bootout") {
          return { status: 1, stderr: "not loaded" };
        }
        if (args[0] === "bootstrap") {
          return { status: 5, stderr: "bootstrap failed" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };

      assert.throws(
        () => syncLaunchdCrons({
          workspace: fixture.workspace,
          launchAgentsDir: fixture.launchAgentsDir,
          env: fixture.env,
          homeDir: fixture.home,
          uid: 501,
          commandRunner: runner,
        }),
        /launchctl bootstrap .* failed: bootstrap failed/,
      );
      assert.equal(readFileSync(activePath, "utf8"), "old active plist");
      assert.equal(calls.filter((call) => call.args.join(" ") === `bootstrap gui/501 ${activePath}`).length, 1);
    } finally {
      cleanup(fixture);
    }
  });

  it("prunes by plist Label instead of filename prefix", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const misleadingPath = join(fixture.launchAgentsDir, "ai.minime.cron.not-owned.plist");
      const nonstandardOwnedPath = join(fixture.launchAgentsDir, "manual-name.plist");
      writeFileSync(
        misleadingPath,
        "<plist><dict><key>Label</key><string>com.example.not-owned</string></dict></plist>\n",
        "utf8",
      );
      writeFileSync(
        nonstandardOwnedPath,
        "<plist><dict><key>Label</key><string>ai.minime.cron.old</string></dict></plist>\n",
        "utf8",
      );

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls, 3),
      });

      assert.equal(existsSync(misleadingPath), true);
      assert.equal(existsSync(nonstandardOwnedPath), false);
      assert.ok(result.items.some((item) => item.action === "delete" && item.label === "ai.minime.cron.old"));
      assert.equal(result.items.some((item) => item.label === "ai.minime.cron.not-owned"), false);
    } finally {
      cleanup(fixture);
    }
  });
});
