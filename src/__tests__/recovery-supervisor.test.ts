import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const python = process.env.PYTHON ?? "/usr/bin/python3";

describe("recovery supervisor", () => {
  it("passes the focused standard-library recovery suite", () => {
    const result = spawnSync(
      python,
      ["-m", "unittest", "scripts.tests.test_recovery_supervisor"],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
});
