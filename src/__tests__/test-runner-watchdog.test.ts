import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const supervisorPath = resolve(packageRoot, "scripts/test-runner-watchdog.mjs");
const fixturePath = resolve(
  packageRoot,
  "src/__tests__/fixtures/test-runner-watchdog-fixture.mjs",
);

type FixtureProcesses = {
  runnerPid: number;
  fixturePid: number;
  descendantPid: number;
};

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function killProcessGroup(processGroupId: number): void {
  try {
    process.kill(-processGroupId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await delay(25);
  assert.ok(predicate(), `timed out waiting for ${description}`);
}

function readFixtureProcesses(markerPath: string): FixtureProcesses {
  return JSON.parse(readFileSync(markerPath, "utf8")) as FixtureProcesses;
}

async function assertProcessesGone(processes: FixtureProcesses): Promise<void> {
  const pids = Object.values(processes);
  await waitFor(
    () => pids.every((pid) => !processExists(pid)),
    `fixture processes to exit: ${pids.join(", ")}`,
  );
}

function cleanupFixture(markerPath: string): void {
  if (!existsSync(markerPath)) return;
  const processes = readFixtureProcesses(markerPath);
  for (const pid of [
    processes.descendantPid,
    processes.fixturePid,
    processes.runnerPid,
  ]) {
    killProcess(pid);
  }
}

function fixtureEnvironment(
  markerPath: string,
  overrides: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    MINIME_WATCHDOG_FIXTURE_MARKER: markerPath,
    ...overrides,
  };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function runSupervisor(
  arguments_: string[],
  markerPath: string,
  environment: Record<string, string> = {},
) {
  return spawnSync(process.execPath, [supervisorPath, "--", ...arguments_], {
    cwd: packageRoot,
    encoding: "utf8",
    env: fixtureEnvironment(markerPath, {
      MINIME_TEST_SUITE_TIMEOUT_MS: "1000",
      MINIME_TEST_TERMINATION_GRACE_MS: "150",
      ...environment,
    }),
    timeout: 10_000,
  });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

describe("test-runner watchdog", () => {
  it("rejects timeout values outside Node's supported timer range", () => {
    const markerPath = join(tmpdir(), "unused-watchdog-marker");
    const invalidValues = ["0", "-1", "invalid", "2147483648", "9".repeat(400)];

    for (const variable of [
      "MINIME_TEST_SUITE_TIMEOUT_MS",
      "MINIME_TEST_TERMINATION_GRACE_MS",
    ] as const) {
      for (const value of invalidValues) {
        const result = runSupervisor(["--version"], markerPath, {
          [variable]: value,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 2, `${variable}=${value}\n${result.stderr}`);
        assert.match(
          result.stderr,
          new RegExp(`${variable} must be an integer from 1 to 2147483647`),
        );
      }
    }
  });

  it("accepts the maximum supported timer value", () => {
    const result = runSupervisor(
      ["--version"],
      join(tmpdir(), "unused-watchdog-marker"),
      {
        MINIME_TEST_SUITE_TIMEOUT_MS: "2147483647",
        MINIME_TEST_TERMINATION_GRACE_MS: "2147483647",
      },
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
  });

  it("reproduces the direct runner gap with completed test work and live resources", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-watchdog-direct-"));
    const markerPath = join(directory, "processes.json");
    let output = "";
    const directRunner = spawn(
      process.execPath,
      ["--test", fixturePath],
      {
        cwd: packageRoot,
        detached: true,
        env: fixtureEnvironment(markerPath, {
          MINIME_WATCHDOG_FIXTURE_MODE: "stall",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    directRunner.stdout.on("data", (chunk) => { output += chunk.toString(); });
    directRunner.stderr.on("data", (chunk) => { output += chunk.toString(); });

    t.after(async () => {
      killProcessGroup(directRunner.pid!);
      cleanupFixture(markerPath);
      rmSync(directory, { recursive: true, force: true });
    });

    await waitFor(() => existsSync(markerPath), "fixture process marker");
    await waitFor(
      () => output.includes("synthetic stall fixture completed"),
      "completed test output",
    );
    await delay(100);

    const processes = readFixtureProcesses(markerPath);
    assert.equal(processExists(directRunner.pid!), true);
    assert.equal(processExists(processes.descendantPid), true);

    killProcessGroup(directRunner.pid!);
    await new Promise<void>((resolveExit) => directRunner.once("exit", () => resolveExit()));
    await assertProcessesGone(processes);
  });

  it("times out with diagnostics, a nonzero exit, and no surviving fixture process", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-watchdog-timeout-"));
    const markerPath = join(directory, "processes.json");
    t.after(() => {
      cleanupFixture(markerPath);
      rmSync(directory, { recursive: true, force: true });
    });

    const result = runSupervisor(
      ["--test", fixturePath],
      markerPath,
      {
        MINIME_WATCHDOG_FIXTURE_MODE: "stall",
        MINIME_TEST_STAGE: "synthetic stalled tests",
        MINIME_TEST_SUITE_TIMEOUT_MS: "750",
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 124, result.stderr);

    const diagnostics = `${result.stdout}\n${result.stderr}`;
    assert.match(diagnostics, /timeout in stage: synthetic stalled tests/);
    assert.match(diagnostics, /command: .*--test.*test-runner-watchdog-fixture\.mjs/);
    assert.match(diagnostics, /elapsed: \d+ms \(deadline: 750ms\)/);
    const evidenceMatch = diagnostics.match(
      /child-process evidence for process group \d+:\n([\s\S]*)$/,
    );
    assert.ok(evidenceMatch, "timeout diagnostics should include a process-evidence section");
    assert.match(evidenceMatch[1], /PID\s+PPID\s+PGID STAT\s+ELAPSED COMMAND/);
    assert.match(
      evidenceMatch[1],
      /test-runner-watchdog-fixture\.mjs descendant/,
    );

    const processes = readFixtureProcesses(markerPath);
    await assertProcessesGone(processes);
  });

  for (const [signal, expectedExitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    it(`cleans its process group when it receives ${signal}`, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "minime-watchdog-signal-"));
      const markerPath = join(directory, "processes.json");
      let output = "";
      const watchdog = spawn(
        process.execPath,
        [supervisorPath, "--", "--test", fixturePath],
        {
          cwd: packageRoot,
          env: fixtureEnvironment(markerPath, {
            MINIME_WATCHDOG_FIXTURE_MODE: "stall",
            MINIME_TEST_SUITE_TIMEOUT_MS: "10000",
            MINIME_TEST_TERMINATION_GRACE_MS: "150",
          }),
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      watchdog.stdout.on("data", (chunk) => { output += chunk.toString(); });
      watchdog.stderr.on("data", (chunk) => { output += chunk.toString(); });

      t.after(() => {
        if (
          watchdog.pid !== undefined
          && watchdog.exitCode === null
          && watchdog.signalCode === null
        ) {
          killProcess(watchdog.pid);
        }
        cleanupFixture(markerPath);
        rmSync(directory, { recursive: true, force: true });
      });

      await waitFor(() => existsSync(markerPath), "fixture process marker");
      const watchdogExit = waitForExit(watchdog);
      assert.equal(watchdog.kill(signal), true);

      const result = await watchdogExit;
      assert.equal(result.signal, null, output);
      assert.equal(result.code, expectedExitCode, output);

      const processes = readFixtureProcesses(markerPath);
      await assertProcessesGone(processes);
    });
  }

  it("propagates an ordinary exit code and cleans its descendant", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-watchdog-failure-"));
    const markerPath = join(directory, "processes.json");
    t.after(() => {
      cleanupFixture(markerPath);
      rmSync(directory, { recursive: true, force: true });
    });

    const result = runSupervisor([fixturePath], markerPath, {
      MINIME_WATCHDOG_FIXTURE_MODE: "exit-code",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 23, result.stderr);

    const processes = readFixtureProcesses(markerPath);
    await assertProcessesGone(processes);
  });

  it("cleans a descendant after an ordinary successful test run", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-watchdog-success-"));
    const markerPath = join(directory, "processes.json");
    t.after(() => {
      cleanupFixture(markerPath);
      rmSync(directory, { recursive: true, force: true });
    });

    const result = runSupervisor([fixturePath], markerPath, {
      MINIME_WATCHDOG_FIXTURE_MODE: "success-process",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);

    const processes = readFixtureProcesses(markerPath);
    await assertProcessesGone(processes);
  });

  it("keeps the package test gate bounded without force-exit", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    ) as { scripts: { test: string } };
    const testScript = packageJson.scripts.test;

    for (const expected of [
      "MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test",
      "node scripts/test-runner-watchdog.mjs --",
      "--experimental-test-module-mocks",
      "--import tsx",
      "--test",
      "--test-concurrency=1",
      "--test-timeout=240000",
      "src/__tests__/*.test.ts",
    ]) {
      assert.ok(testScript.includes(expected), `test script should include ${expected}`);
    }
    assert.doesNotMatch(testScript, /--test-force-exit/);
  });
});
