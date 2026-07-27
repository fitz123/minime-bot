#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";

const DEFAULT_SUITE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const TIMEOUT_EXIT_CODE = 124;
const POLL_INTERVAL_MS = 25;

function readPositiveInteger(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

function quoteArgument(argument) {
  return /^[A-Za-z0-9_./:=+-]+$/.test(argument)
    ? argument
    : `'${argument.replaceAll("'", "'\\''")}'`;
}

function commandDescription(arguments_) {
  return [process.execPath, ...arguments_].map(quoteArgument).join(" ");
}

function groupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    // Darwin can report EPERM briefly after the final member of an owned
    // process group exits; subsequent probes report ESRCH.
    if (error?.code === "ESRCH" || (process.platform === "darwin" && error?.code === "EPERM")) {
      return false;
    }
    throw error;
  }
}

function signalGroup(processGroupId, signal) {
  try {
    process.kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH" || (process.platform === "darwin" && error?.code === "EPERM")) {
      return false;
    }
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForGroupExit(processGroupId, deadline) {
  while (groupExists(processGroupId) && Date.now() < deadline) {
    await delay(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  return !groupExists(processGroupId);
}

async function terminateProcessGroup(processGroupId, graceMs) {
  if (!signalGroup(processGroupId, "SIGTERM")) return;

  if (await waitForGroupExit(processGroupId, Date.now() + graceMs)) return;

  signalGroup(processGroupId, "SIGKILL");
  await waitForGroupExit(processGroupId, Date.now() + graceMs);
}

function childProcessEvidence(processGroupId) {
  const result = spawnSync(
    "ps",
    ["-axo", "pid=,ppid=,pgid=,stat=,etime=,command="],
    { encoding: "utf8", timeout: 2_000 },
  );

  if (result.error || result.status !== 0) {
    const reason = result.error?.message
      ?? (result.stderr.trim() || `ps exited ${result.status}`);
    return `  unavailable: ${reason}`;
  }

  const processes = result.stdout
    .split("\n")
    .filter((line) => {
      const match = line.match(/^\s*\d+\s+\d+\s+(\d+)\s+/);
      return match?.[1] === String(processGroupId);
    });

  if (processes.length === 0) return "  no live processes reported";
  return [
    "      PID    PPID    PGID STAT     ELAPSED COMMAND",
    ...processes,
  ].join("\n");
}

async function run() {
  const separator = process.argv.indexOf("--", 2);
  const arguments_ = separator === -1 ? process.argv.slice(2) : process.argv.slice(separator + 1);
  if (arguments_.length === 0) {
    process.stderr.write(
      "usage: node scripts/test-runner-watchdog.mjs -- <node arguments>\n",
    );
    return 2;
  }

  const suiteTimeoutMs = readPositiveInteger(
    "MINIME_TEST_SUITE_TIMEOUT_MS",
    DEFAULT_SUITE_TIMEOUT_MS,
  );
  const terminationGraceMs = readPositiveInteger(
    "MINIME_TEST_TERMINATION_GRACE_MS",
    DEFAULT_TERMINATION_GRACE_MS,
  );
  const stage = process.env.MINIME_TEST_STAGE ?? "package test suite";
  const command = commandDescription(arguments_);
  const startedAt = Date.now();

  const child = spawn(process.execPath, arguments_, {
    detached: true,
    env: process.env,
    stdio: "inherit",
  });

  const outcome = await new Promise((resolve) => {
    const deadline = setTimeout(() => resolve({ type: "timeout" }), suiteTimeoutMs);

    const settle = (result) => {
      clearTimeout(deadline);
      resolve(result);
    };

    child.once("error", (error) => settle({ type: "spawn-error", error }));
    child.once("exit", (code, signal) => settle({ type: "exit", code, signal }));
    process.once("SIGINT", () => settle({ type: "signal", signal: "SIGINT" }));
    process.once("SIGTERM", () => settle({ type: "signal", signal: "SIGTERM" }));
  });

  const elapsedMs = Date.now() - startedAt;
  const processGroupId = child.pid;

  if (outcome.type === "timeout") {
    process.stderr.write(
      [
        `[test-runner-watchdog] timeout in stage: ${stage}`,
        `[test-runner-watchdog] command: ${command}`,
        `[test-runner-watchdog] elapsed: ${elapsedMs}ms (deadline: ${suiteTimeoutMs}ms)`,
        `[test-runner-watchdog] child-process evidence for process group ${processGroupId}:`,
        childProcessEvidence(processGroupId),
        "",
      ].join("\n"),
    );
  } else if (outcome.type === "spawn-error") {
    process.stderr.write(
      `[test-runner-watchdog] failed to start stage ${stage}: ${outcome.error.message}\n`,
    );
  }

  if (processGroupId !== undefined) {
    try {
      await terminateProcessGroup(processGroupId, terminationGraceMs);
    } catch (error) {
      process.stderr.write(
        [
          `[test-runner-watchdog] process-group cleanup failed for ${processGroupId}: ${error.message}`,
          childProcessEvidence(processGroupId),
          "",
        ].join("\n"),
      );
      return 1;
    }
  }

  if (outcome.type === "timeout") return TIMEOUT_EXIT_CODE;
  if (outcome.type === "spawn-error") return 1;
  if (outcome.type === "signal") return outcome.signal === "SIGINT" ? 130 : 143;
  if (outcome.signal !== null) return 1;
  return outcome.code ?? 1;
}

try {
  const exitCode = await run();
  process.exit(exitCode);
} catch (error) {
  process.stderr.write(`[test-runner-watchdog] ${error.stack ?? error.message}\n`);
  process.exit(2);
}
