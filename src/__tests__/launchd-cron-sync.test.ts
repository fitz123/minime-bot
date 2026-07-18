import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  formatLaunchdCronSyncResult,
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
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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

function writeRunner(directory: string, mode = 0o700): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const runner = join(directory, "run-cron.sh");
  writeFileSync(runner, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(runner, mode);
  return runner;
}

function writeFixturePlutil(fixture: Fixture): string {
  const plutil = join(fixture.root, "fixture-plutil");
  copyFileSync(new URL("./fixtures/plutil-convert.py", import.meta.url), plutil);
  chmodSync(plutil, 0o700);
  return plutil;
}

function renderReorderedPlistFixture(
  fixture: Fixture,
  runner: string,
  cronName: string,
  hour: number,
  minute = 0,
): string {
  const replacements: Record<string, string> = {
    CRON_NAME: cronName,
    HOME: fixture.home,
    HOUR: String(hour),
    LABEL: `ai.minime.cron.${cronName}`,
    LOG_DIR: fixture.logDir,
    MINUTE: String(minute),
    RUNNER: runner,
    STANDARD_ERROR_PATH: join(fixture.logDir, `cron-${cronName}.stderr.log`),
    STANDARD_OUT_PATH: join(fixture.logDir, `cron-${cronName}.stdout.log`),
    WORKSPACE: fixture.workspace,
  };
  let content = readFileSync(
    new URL("./fixtures/launchd-cron-reordered.plist", import.meta.url),
    "utf8",
  );
  for (const [name, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${name}}}`, xmlEscapeFixture(value));
  }
  assert.doesNotMatch(content, /{{[^}]+}}/);
  return content;
}

function xmlEscapeFixture(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function generateWithRunner(fixture: Fixture, runCronScript?: string) {
  writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
  return generateLaunchdCronPlists({
    workspace: fixture.workspace,
    launchAgentsDir: fixture.launchAgentsDir,
    runCronScript,
    env: fixture.env,
    homeDir: fixture.home,
  });
}

function assertRunCronRejection(
  action: () => unknown,
  suppliedValue: string,
  expectedInvariant: RegExp,
): void {
  assert.throws(action, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, expectedInvariant);
    assert.equal(err.message.includes(suppliedValue), false);
    return true;
  });
}

describe("launchd cron runner selection", () => {
  it("keeps the package-root runner as the default", () => {
    const fixture = createFixture();
    try {
      const result = generateWithRunner(fixture);
      const expectedRunner = join(result.context.packageRoot, "scripts", "run-cron.sh");

      assert.equal(result.context.runCronScript, expectedRunner);
      assert.match(result.plists[0].content, new RegExp(`<string>${escapeRegex(expectedRunner)}</string>`));
    } finally {
      cleanup(fixture);
    }
  });

  it("accepts and preserves an explicit regular executable runner", () => {
    const fixture = createFixture();
    try {
      const runner = writeRunner(join(fixture.root, "deployment", "scripts"));
      const result = generateWithRunner(fixture, runner);

      assert.equal(result.context.runCronScript, runner);
      assert.match(result.plists[0].content, new RegExp(`<string>${escapeRegex(runner)}</string>`));
    } finally {
      cleanup(fixture);
    }
  });

  it("accepts a current-user-owned runner beneath a writable sticky ancestor", () => {
    const fixture = createFixture();
    try {
      const stickyParent = join(fixture.root, "sticky-parent");
      mkdirSync(stickyParent, { mode: 0o700 });
      const runner = writeRunner(join(stickyParent, "owned-deployment", "scripts"));
      chmodSync(stickyParent, 0o1777);

      const result = generateWithRunner(fixture, runner);

      assert.equal(result.context.runCronScript, runner);
      assert.match(result.plists[0].content, new RegExp(`<string>${escapeRegex(runner)}</string>`));
    } finally {
      cleanup(fixture);
    }
  });

  it("accepts one contained current directory symlink and preserves its lexical path", () => {
    const fixture = createFixture();
    try {
      const deployment = join(fixture.root, "deployment");
      const runner = writeRunner(join(deployment, "slots", "blue", "scripts"));
      symlinkSync(join("slots", "blue"), join(deployment, "current"), "dir");
      const lexicalRunner = join(deployment, "current", "scripts", "run-cron.sh");
      const result = generateWithRunner(fixture, lexicalRunner);

      assert.notEqual(lexicalRunner, runner);
      assert.equal(result.context.runCronScript, lexicalRunner);
      assert.match(result.plists[0].content, new RegExp(`<string>${escapeRegex(lexicalRunner)}</string>`));
    } finally {
      cleanup(fixture);
    }
  });

  it("accepts a contained selector target whose directory name starts with two dots", () => {
    const fixture = createFixture();
    try {
      const deployment = join(fixture.root, "deployment");
      const runner = writeRunner(join(deployment, "..slots", "blue", "scripts"));
      symlinkSync(join("..slots", "blue"), join(deployment, "current"), "dir");
      const lexicalRunner = join(deployment, "current", "scripts", "run-cron.sh");
      const result = generateWithRunner(fixture, lexicalRunner);

      assert.notEqual(lexicalRunner, runner);
      assert.equal(result.context.runCronScript, lexicalRunner);
      assert.match(result.plists[0].content, new RegExp(`<string>${escapeRegex(lexicalRunner)}</string>`));
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects selector targets that hide symlinks behind parent traversal", () => {
    const fixture = createFixture();
    try {
      const deployment = join(fixture.root, "deployment");
      writeRunner(join(deployment, "slots", "blue", "scripts"));

      const external = join(fixture.root, "external");
      const externalNested = join(external, "nested");
      mkdirSync(externalNested, { recursive: true });
      symlinkSync(externalNested, join(deployment, "pivot"), "dir");
      symlinkSync(join(deployment, "slots"), join(external, "slots"), "dir");
      chmodSync(external, 0o777);

      symlinkSync("pivot/../slots/blue", join(deployment, "current"), "dir");
      const lexicalRunner = join(deployment, "current", "scripts", "run-cron.sh");
      assertRunCronRejection(
        () => generateWithRunner(fixture, lexicalRunner),
        lexicalRunner,
        /Invalid run cron script override: directory symlink target must not contain parent directory references/,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects relative, unnormalized, missing, wrong-name, unreadable, and non-executable runners", () => {
    const fixture = createFixture();
    try {
      const relativeRunner = "relative/run-cron.sh";
      assertRunCronRejection(
        () => generateWithRunner(fixture, "relative/run-cron.sh"),
        relativeRunner,
        /Invalid run cron script override: must be an absolute path/,
      );

      const validRunner = writeRunner(join(fixture.root, "normalized", "scripts"));
      const unnormalizedRunner = `${dirname(validRunner)}/../scripts/run-cron.sh`;
      assertRunCronRejection(
        () => generateWithRunner(fixture, unnormalizedRunner),
        unnormalizedRunner,
        /Invalid run cron script override: path must be normalized/,
      );

      const missingRunner = join(fixture.root, "missing", "run-cron.sh");
      assertRunCronRejection(
        () => generateWithRunner(fixture, missingRunner),
        missingRunner,
        /Invalid run cron script override: must resolve to an existing path/,
      );

      const nonRegular = join(fixture.root, "non-regular", "run-cron.sh");
      mkdirSync(nonRegular, { recursive: true });
      assertRunCronRejection(
        () => generateWithRunner(fixture, nonRegular),
        nonRegular,
        /Invalid run cron script override: must resolve to a regular file/,
      );

      const wrongName = join(fixture.root, "normalized", "scripts", "runner.sh");
      writeFileSync(wrongName, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(wrongName, 0o700);
      assertRunCronRejection(
        () => generateWithRunner(fixture, wrongName),
        wrongName,
        /Invalid run cron script override: basename must be run-cron\.sh/,
      );

      const nonExecutable = writeRunner(join(fixture.root, "non-executable"), 0o600);
      assertRunCronRejection(
        () => generateWithRunner(fixture, nonExecutable),
        nonExecutable,
        /Invalid run cron script override: file must be readable and executable by its owner/,
      );

      const unreadable = writeRunner(join(fixture.root, "unreadable"), 0o100);
      assertRunCronRejection(
        () => generateWithRunner(fixture, unreadable),
        unreadable,
        /Invalid run cron script override: file must be readable and executable by its owner/,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects final-file, dangling, escaping, and multiple symlinks", () => {
    const fixture = createFixture();
    try {
      const finalLinkDir = join(fixture.root, "final-link");
      mkdirSync(finalLinkDir, { recursive: true });
      const finalTarget = join(finalLinkDir, "runner-target");
      writeFileSync(finalTarget, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(finalTarget, 0o700);
      const finalLink = join(finalLinkDir, "run-cron.sh");
      symlinkSync("runner-target", finalLink, "file");
      assertRunCronRejection(
        () => generateWithRunner(fixture, finalLink),
        finalLink,
        /Invalid run cron script override: final file must not be a symlink/,
      );

      const danglingDeployment = join(fixture.root, "dangling-deployment");
      mkdirSync(danglingDeployment, { recursive: true });
      symlinkSync(join("slots", "missing"), join(danglingDeployment, "current"), "dir");
      const danglingRunner = join(danglingDeployment, "current", "scripts", "run-cron.sh");
      assertRunCronRejection(
        () => generateWithRunner(fixture, danglingRunner),
        danglingRunner,
        /Invalid run cron script override: must resolve to an existing path/,
      );

      const escapingDeployment = join(fixture.root, "escaping-deployment");
      const outsideRunner = writeRunner(join(fixture.root, "outside-slot", "scripts"));
      mkdirSync(escapingDeployment, { recursive: true });
      symlinkSync(join("..", "outside-slot"), join(escapingDeployment, "current"), "dir");
      const escapingRunner = join(escapingDeployment, "current", "scripts", "run-cron.sh");
      assert.notEqual(escapingRunner, outsideRunner);
      assertRunCronRejection(
        () => generateWithRunner(fixture, escapingRunner),
        escapingRunner,
        /Invalid run cron script override: directory symlink target must not contain parent directory references/,
      );

      const multipleDeployment = join(fixture.root, "multiple-deployment");
      const slot = join(multipleDeployment, "slots", "blue");
      writeRunner(join(slot, "real-scripts"));
      symlinkSync("real-scripts", join(slot, "scripts"), "dir");
      symlinkSync(join("slots", "blue"), join(multipleDeployment, "current"), "dir");
      const multipleRunner = join(multipleDeployment, "current", "scripts", "run-cron.sh");
      assertRunCronRejection(
        () => generateWithRunner(fixture, multipleRunner),
        multipleRunner,
        /Invalid run cron script override: path must contain at most one directory symlink/,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects writable regular, trust, resolved-directory, and file components", () => {
    const fixture = createFixture();
    try {
      const writableDir = join(fixture.root, "writable");
      const writableRunner = writeRunner(writableDir);
      chmodSync(writableDir, 0o777);
      assertRunCronRejection(
        () => generateWithRunner(fixture, writableRunner),
        writableRunner,
        /Invalid run cron script override: containing directory must not be group or world writable/,
      );

      const writableFile = writeRunner(join(fixture.root, "writable-file"), 0o722);
      assertRunCronRejection(
        () => generateWithRunner(fixture, writableFile),
        writableFile,
        /Invalid run cron script override: file must not be group or world writable/,
      );

      const writableTrust = join(fixture.root, "writable-trust");
      writeRunner(join(writableTrust, "slots", "blue", "scripts"));
      symlinkSync(join("slots", "blue"), join(writableTrust, "current"), "dir");
      chmodSync(writableTrust, 0o777);
      const writableTrustRunner = join(writableTrust, "current", "scripts", "run-cron.sh");
      assertRunCronRejection(
        () => generateWithRunner(fixture, writableTrustRunner),
        writableTrustRunner,
        /Invalid run cron script override: trust directory must not be group or world writable/,
      );

      const writableSlot = join(fixture.root, "writable-slot");
      writeRunner(join(writableSlot, "slots", "blue", "scripts"));
      symlinkSync(join("slots", "blue"), join(writableSlot, "current"), "dir");
      chmodSync(join(writableSlot, "slots", "blue"), 0o777);
      const writableSlotRunner = join(writableSlot, "current", "scripts", "run-cron.sh");
      assertRunCronRejection(
        () => generateWithRunner(fixture, writableSlotRunner),
        writableSlotRunner,
        /Invalid run cron script override: resolved directory must not be group or world writable/,
      );

      const writableScripts = join(fixture.root, "writable-scripts");
      writeRunner(join(writableScripts, "slots", "blue", "scripts"));
      symlinkSync(join("slots", "blue"), join(writableScripts, "current"), "dir");
      chmodSync(join(writableScripts, "slots", "blue", "scripts"), 0o777);
      const writableScriptsRunner = join(writableScripts, "current", "scripts", "run-cron.sh");
      assertRunCronRejection(
        () => generateWithRunner(fixture, writableScriptsRunner),
        writableScriptsRunner,
        /Invalid run cron script override: resolved directory must not be group or world writable/,
      );

      const writableSelectorFile = join(fixture.root, "writable-selector-file");
      writeRunner(join(writableSelectorFile, "slots", "blue", "scripts"), 0o722);
      symlinkSync(join("slots", "blue"), join(writableSelectorFile, "current"), "dir");
      const writableSelectorRunner = join(
        writableSelectorFile,
        "current",
        "scripts",
        "run-cron.sh",
      );
      assertRunCronRejection(
        () => generateWithRunner(fixture, writableSelectorRunner),
        writableSelectorRunner,
        /Invalid run cron script override: file must not be group or world writable/,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects replaceable ancestors above direct and selector trust directories", () => {
    const fixture = createFixture();
    try {
      const directParent = join(fixture.root, "replaceable-direct-parent");
      const directRunner = writeRunner(join(directParent, "deployment", "scripts"));
      chmodSync(directParent, 0o777);
      assertRunCronRejection(
        () => generateWithRunner(fixture, directRunner),
        directRunner,
        /Invalid run cron script override: ancestor directories must not be group or world writable unless sticky/,
      );

      const selectorParent = join(fixture.root, "replaceable-selector-parent");
      const deployment = join(selectorParent, "deployment");
      writeRunner(join(deployment, "slots", "blue", "scripts"));
      symlinkSync(join("slots", "blue"), join(deployment, "current"), "dir");
      chmodSync(selectorParent, 0o777);
      const selectorRunner = join(deployment, "current", "scripts", "run-cron.sh");
      assertRunCronRejection(
        () => generateWithRunner(fixture, selectorRunner),
        selectorRunner,
        /Invalid run cron script override: ancestor directories must not be group or world writable unless sticky/,
      );
    } finally {
      cleanup(fixture);
    }
  });

  it("rejects wrong-owner regular and atomic-selector components", (t) => {
    const regularFixture = createFixture();
    try {
      const ownedRunner = writeRunner(join(regularFixture.root, "wrong-owner"));
      if (typeof process.getuid !== "function") {
        assert.fail("ownership test requires process.getuid");
      }
      const actualUid = process.getuid();
      t.mock.method(process as { getuid: () => number }, "getuid", () => actualUid + 1);
      assertRunCronRejection(
        () => generateWithRunner(regularFixture, ownedRunner),
        ownedRunner,
        /Invalid run cron script override: containing directory must be owned by the current user/,
      );
    } finally {
      cleanup(regularFixture);
      t.mock.restoreAll();
    }

    const selectorFixture = createFixture();
    try {
      const deployment = join(selectorFixture.root, "wrong-owner-selector");
      writeRunner(join(deployment, "slots", "blue", "scripts"));
      symlinkSync(join("slots", "blue"), join(deployment, "current"), "dir");

      if (typeof process.getuid !== "function") {
        assert.fail("ownership test requires process.getuid");
      }
      const actualUid = process.getuid();
      t.mock.method(process as { getuid: () => number }, "getuid", () => actualUid + 1);
      const selectorRunner = join(deployment, "current", "scripts", "run-cron.sh");
      assertRunCronRejection(
        () => generateWithRunner(selectorFixture, selectorRunner),
        selectorRunner,
        /Invalid run cron script override: directory symlink must be owned by the current user/,
      );
    } finally {
      cleanup(selectorFixture);
    }
  });

  it("rejects an invalid override before cron loading, writes, or commands", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, "crons:\n  - name: [");
      const untouchedLaunchAgentsDir = join(fixture.root, "untouched", "LaunchAgents");

      assert.throws(
        () => syncLaunchdCrons({
          workspace: fixture.workspace,
          launchAgentsDir: untouchedLaunchAgentsDir,
          runCronScript: "relative/run-cron.sh",
          env: fixture.env,
          homeDir: fixture.home,
          commandRunner: captureRunner(calls),
        }),
        /Invalid run cron script override: must be an absolute path/,
      );
      assert.equal(existsSync(untouchedLaunchAgentsDir), false);
      assert.equal(existsSync(fixture.logDir), false);
      assert.equal(calls.length, 0);
    } finally {
      cleanup(fixture);
    }
  });

  it("keeps valid override dry-run zero-write with absent output directories", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const runner = writeRunner(join(fixture.root, "release", "scripts"));
      const untouchedLaunchAgentsDir = join(fixture.root, "dry-run", "LaunchAgents");

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: untouchedLaunchAgentsDir,
        runCronScript: runner,
        dryRun: true,
        env: fixture.env,
        homeDir: fixture.home,
        commandRunner: captureRunner(calls),
      });

      assert.deepEqual(result.items.map((item) => `${item.action}:${item.label}`), [
        "create:ai.minime.cron.active",
      ]);
      assert.equal(result.context.runCronScript, runner);
      assert.equal(existsSync(untouchedLaunchAgentsDir), false);
      assert.equal(existsSync(fixture.logDir), false);
      assert.equal(calls.length, 0);
    } finally {
      cleanup(fixture);
    }
  });
});

describe("launchd cron plist sync", () => {
  it("keeps a PlistBuddy-shaped matching explicit-runner plist unchanged", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const runner = writeRunner(join(fixture.root, "release", "scripts"));
      const generated = generateLaunchdCronPlists({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: runner,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
      });
      const existingContent = renderReorderedPlistFixture(fixture, runner, "active", 8);
      assert.notEqual(existingContent, generated.plists[0].content);
      writeFileSync(generated.plists[0].plistPath, existingContent, "utf8");
      const plutil = writeFixturePlutil(fixture);

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: runner,
        dryRun: true,
        env: { ...fixture.env, PLUTIL_BIN: plutil },
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls),
      });

      assert.deepEqual(result.items.map((item) => `${item.action}:${item.label}`), [
        "unchanged:ai.minime.cron.active",
      ]);
      assert.equal(result.context.plutilBin, plutil);
      assert.equal(readFileSync(generated.plists[0].plistPath, "utf8"), existingContent);
      assert.equal(existsSync(fixture.logDir), false);
      assert.equal(calls.length, 0);
    } finally {
      cleanup(fixture);
    }
  });

  it("keeps scalar, array-order, runner, and schedule differences as updates", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const runner = writeRunner(join(fixture.root, "release", "scripts"));
      const generated = generateLaunchdCronPlists({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: runner,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
      });
      const desired = generated.plists[0].content;
      const otherRunner = join(fixture.root, "previous-release", "scripts", "run-cron.sh");
      const differences = new Map<string, string>([
        ["scalar value", desired.replace("<false/>", "<true/>")],
        ["scalar type", desired.replace("<integer>8</integer>", "<real>8.0</real>")],
        [
          "array order",
          desired.replace(
            `      <string>${xmlEscapeFixture(runner)}</string>\n      <string>active</string>`,
            `      <string>active</string>\n      <string>${xmlEscapeFixture(runner)}</string>`,
          ),
        ],
        [
          "runner",
          desired.replace(
            `<string>${xmlEscapeFixture(runner)}</string>`,
            `<string>${xmlEscapeFixture(otherRunner)}</string>`,
          ),
        ],
        ["schedule", desired.replace("<integer>8</integer>", "<integer>9</integer>")],
      ]);
      const plutil = writeFixturePlutil(fixture);

      for (const [difference, existingContent] of differences) {
        assert.notEqual(existingContent, desired, `${difference} fixture must differ from desired`);
        writeFileSync(generated.plists[0].plistPath, existingContent, "utf8");
        const result = syncLaunchdCrons({
          workspace: fixture.workspace,
          launchAgentsDir: fixture.launchAgentsDir,
          runCronScript: runner,
          dryRun: true,
          env: { ...fixture.env, PLUTIL_BIN: plutil },
          homeDir: fixture.home,
          uid: 501,
          commandRunner: captureRunner(calls),
        });

        assert.equal(result.items[0].action, "update", difference);
        assert.equal(readFileSync(generated.plists[0].plistPath, "utf8"), existingContent);
      }
      assert.equal(existsSync(fixture.logDir), false);
      assert.equal(calls.length, 0);
    } finally {
      cleanup(fixture);
    }
  });

  it("fails malformed plist parsing safely without writes or leaked diagnostics", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const runner = writeRunner(join(fixture.root, "release", "scripts"));
      const activePath = join(fixture.launchAgentsDir, "ai.minime.cron.active.plist");
      const malformedContent = "<plist><dict><key>private-file-marker</key>";
      writeFileSync(activePath, malformedContent, "utf8");
      const beforeEntries = readdirSync(fixture.launchAgentsDir).sort();
      const plutil = writeFixturePlutil(fixture);

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: runner,
        dryRun: true,
        env: { ...fixture.env, PLUTIL_BIN: plutil },
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls),
      });
      const output = formatLaunchdCronSyncResult(result);

      assert.equal(result.items[0].action, "update");
      assert.equal(readFileSync(activePath, "utf8"), malformedContent);
      assert.deepEqual(readdirSync(fixture.launchAgentsDir).sort(), beforeEntries);
      assert.equal(existsSync(fixture.logDir), false);
      assert.equal(calls.length, 0);
      assert.doesNotMatch(output, /private-(?:file|parser)-marker/);
      assert.equal(output.includes(activePath), false);
    } finally {
      cleanup(fixture);
    }
  });

  it("fails returned, thrown, and malformed conversion errors without writes or leaks", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const runner = writeRunner(join(fixture.root, "release", "scripts"));
      const activePath = join(fixture.launchAgentsDir, "ai.minime.cron.active.plist");
      const existingContent = renderReorderedPlistFixture(fixture, runner, "active", 8);
      writeFileSync(activePath, existingContent, "utf8");
      const beforeEntries = readdirSync(fixture.launchAgentsDir).sort();
      const malformedJsonPlutil = join(fixture.root, "malformed-json-plutil");
      writeFileSync(malformedJsonPlutil, `#!/bin/sh
if [ "$5" = "-" ]; then
  printf '%s\\n' 'private-parser-invalid-json'
else
  printf '%s\\n' '{}'
fi
`, "utf8");
      chmodSync(malformedJsonPlutil, 0o700);
      const fixturePlutil = writeFixturePlutil(fixture);
      const xmlFailurePlutil = join(fixture.root, "xml-failure-plutil");
      writeFileSync(xmlFailurePlutil, `#!/bin/sh
if [ "$2" = "xml1" ]; then
  printf '%s\\n' 'private-parser-xml-failure' >&2
  exit 1
fi
exec "${fixturePlutil}" "$@"
`, "utf8");
      chmodSync(xmlFailurePlutil, 0o700);
      const invalidPlutils = [
        join(fixture.root, "private-parser-path-must-not-leak"),
        "private-parser\0command-must-not-leak",
        malformedJsonPlutil,
        xmlFailurePlutil,
      ];

      for (const plutil of invalidPlutils) {
        const result = syncLaunchdCrons({
          workspace: fixture.workspace,
          launchAgentsDir: fixture.launchAgentsDir,
          runCronScript: runner,
          dryRun: true,
          env: { ...fixture.env, PLUTIL_BIN: plutil },
          homeDir: fixture.home,
          uid: 501,
          commandRunner: captureRunner(calls),
        });
        const output = formatLaunchdCronSyncResult(result);

        assert.equal(result.items[0].action, "update");
        assert.equal(readFileSync(activePath, "utf8"), existingContent);
        assert.deepEqual(readdirSync(fixture.launchAgentsDir).sort(), beforeEntries);
        assert.equal(existsSync(fixture.logDir), false);
        assert.equal(calls.length, 0);
        assert.doesNotMatch(output, /private-parser/);
        assert.equal(output.includes(plutil), false);
      }
    } finally {
      cleanup(fixture);
    }
  });

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
      const runner = writeRunner(join(fixture.root, "release", "scripts"));
      const stalePath = join(fixture.launchAgentsDir, "ai.minime.cron.stale.plist");
      const botPath = join(fixture.launchAgentsDir, "ai.minime.telegram-bot.plist");
      writeFileSync(stalePath, "<plist><dict><key>Label</key><string>ai.minime.cron.stale</string></dict></plist>\n", "utf8");
      writeFileSync(botPath, "bot", "utf8");

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: runner,
        dryRun: true,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls),
      });

      assert.equal(calls.length, 0);
      assert.equal(result.context.runCronScript, runner);
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

  it("applies and rebootstraps a plist with the lexical atomic-selector runner", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const deployment = join(fixture.root, "deployment");
      const canonicalRunner = writeRunner(join(deployment, "slots", "blue", "scripts"));
      symlinkSync(join("slots", "blue"), join(deployment, "current"), "dir");
      const lexicalRunner = join(deployment, "current", "scripts", "run-cron.sh");

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: lexicalRunner,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls),
      });

      const plistPath = join(fixture.launchAgentsDir, "ai.minime.cron.active.plist");
      const content = readFileSync(plistPath, "utf8");
      assert.deepEqual(result.items.map((item) => `${item.action}:${item.label}`), [
        "create:ai.minime.cron.active",
      ]);
      assert.equal(result.context.runCronScript, lexicalRunner);
      assert.match(content, new RegExp(`<string>${escapeRegex(lexicalRunner)}</string>`));
      assert.doesNotMatch(content, new RegExp(`<string>${escapeRegex(canonicalRunner)}</string>`));
      assert.deepEqual(calls.map((call) => [call.command, call.args[0]]), [
        ["/usr/bin/plutil", "-lint"],
        ["/bin/launchctl", "bootout"],
        ["/bin/launchctl", "bootstrap"],
      ]);
      assert.equal(calls[2].args[2], plistPath);
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

  it("keeps a matching explicit-runner plist unchanged without running commands", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    try {
      writeCrons(fixture.workspace, cronYaml("active", "0 8 * * *"));
      const runner = writeRunner(join(fixture.root, "release", "scripts"));
      const generated = generateLaunchdCronPlists({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: runner,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
      });
      writeFileSync(generated.plists[0].plistPath, generated.plists[0].content, "utf8");

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: runner,
        env: { ...fixture.env, PLUTIL_BIN: "private-parser\0must-not-run" },
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

  it("plans only one create when reordered explicit-runner plists already exist", () => {
    const fixture = createFixture();
    const calls: CommandCall[] = [];
    const runner = writeRunner(join(fixture.root, "release", "scripts"));
    const existingHours = new Map([
      ["existing-morning", 8],
      ["existing-evening", 18],
    ]);
    const cronsYaml = (includeNew: boolean): string => [
      "crons:",
      "  - name: existing-morning",
      '    schedule: "0 8 * * *"',
      '    prompt: "run morning task"',
      "    agentId: main",
      "    deliveryChatId: 111",
      "  - name: existing-evening",
      '    schedule: "0 18 * * *"',
      '    prompt: "run evening task"',
      "    agentId: main",
      "    deliveryChatId: 111",
      ...(includeNew ? [
        "  - name: new-midday",
        '    schedule: "0 12 * * *"',
        '    prompt: "run midday task"',
        "    agentId: main",
        "    deliveryChatId: 111",
      ] : []),
      "",
    ].join("\n");

    try {
      writeCrons(fixture.workspace, cronsYaml(false));
      const initial = generateLaunchdCronPlists({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: runner,
        env: fixture.env,
        homeDir: fixture.home,
        uid: 501,
      });
      for (const plist of initial.plists) {
        const hour = existingHours.get(plist.cron.name);
        assert.ok(hour !== undefined);
        const existingContent = renderReorderedPlistFixture(
          fixture,
          runner,
          plist.cron.name,
          hour,
        );
        assert.notEqual(existingContent, plist.content);
        writeFileSync(plist.plistPath, existingContent, "utf8");
      }
      const beforeEntries = readdirSync(fixture.launchAgentsDir).sort();
      const beforeContents = new Map(
        initial.plists.map((plist) => [plist.plistPath, readFileSync(plist.plistPath, "utf8")]),
      );
      writeCrons(fixture.workspace, cronsYaml(true));
      const plutil = writeFixturePlutil(fixture);

      const result = syncLaunchdCrons({
        workspace: fixture.workspace,
        launchAgentsDir: fixture.launchAgentsDir,
        runCronScript: runner,
        dryRun: true,
        env: { ...fixture.env, PLUTIL_BIN: plutil },
        homeDir: fixture.home,
        uid: 501,
        commandRunner: captureRunner(calls),
      });

      assert.deepEqual(result.items.map((item) => `${item.action}:${item.label}`), [
        "unchanged:ai.minime.cron.existing-evening",
        "unchanged:ai.minime.cron.existing-morning",
        "create:ai.minime.cron.new-midday",
      ]);
      assert.equal(calls.length, 0);
      assert.equal(existsSync(join(fixture.launchAgentsDir, "ai.minime.cron.new-midday.plist")), false);
      assert.deepEqual(readdirSync(fixture.launchAgentsDir).sort(), beforeEntries);
      for (const [plistPath, existingContent] of beforeContents) {
        assert.equal(readFileSync(plistPath, "utf8"), existingContent);
      }
      assert.equal(existsSync(fixture.logDir), false);
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
