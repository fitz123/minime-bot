import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? process.env.MINIME_WATCHDOG_FIXTURE_MODE;

if (mode === "descendant") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
} else {
  const markerPath = process.env.MINIME_WATCHDOG_FIXTURE_MARKER;
  if (!markerPath) throw new Error("MINIME_WATCHDOG_FIXTURE_MARKER is required");

  const descendant = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "descendant"],
    { stdio: "ignore" },
  );
  descendant.unref();

  writeFileSync(markerPath, JSON.stringify({
    runnerPid: process.ppid,
    fixturePid: process.pid,
    descendantPid: descendant.pid,
  }));

  if (mode === "exit-code" || mode === "success-process") {
    process.exitCode = mode === "exit-code" ? 23 : 0;
  } else {
    test(`synthetic ${mode} fixture completed`, () => {
      assert.ok(descendant.pid);
    });

    if (mode === "stall") {
      setInterval(() => {}, 60_000);
    }
  }
}
