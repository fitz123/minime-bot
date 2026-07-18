import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { installCronTestEnv } from "./cron-test-env.js";

const testEnv = installCronTestEnv();
const {
  handleDeliveryFailure,
  resolveCronLogDir,
  writeCronHealthMetric,
} = await import("../cron-runner.js");

function snapshotDir(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir).sort().map((fileName) => [
      fileName,
      readFileSync(join(dir, fileName), "utf8"),
    ]),
  );
}

describe("cron-runner path isolation", () => {
  it("resolves log and metric output directories at call time", () => {
    const logDirA = join(testEnv.root, "log-a");
    const logDirB = join(testEnv.root, "log-b");
    const metricsDirA = join(testEnv.root, "metrics-a");
    const metricsDirB = join(testEnv.root, "metrics-b");
    for (const dir of [logDirA, logDirB, metricsDirA, metricsDirB]) {
      mkdirSync(dir, { recursive: true });
    }

    process.env.LOG_DIR = logDirA;
    handleDeliveryFailure("isolation", 111111111, "first failure", undefined, () => {});
    const logSnapshotA = snapshotDir(logDirA);

    process.env.LOG_DIR = logDirB;
    handleDeliveryFailure("isolation", 111111111, "second failure", undefined, () => {});

    assert.deepStrictEqual(snapshotDir(logDirA), logSnapshotA);
    assert.match(readFileSync(join(logDirB, "cron-isolation.log"), "utf8"), /second failure/);

    process.env.CRON_HEALTH_TEXTFILE_DIR = metricsDirA;
    writeCronHealthMetric("isolation", 0, true);
    const metricSnapshotA = snapshotDir(metricsDirA);

    process.env.CRON_HEALTH_TEXTFILE_DIR = metricsDirB;
    writeCronHealthMetric("isolation", 1, false);

    assert.deepStrictEqual(snapshotDir(metricsDirA), metricSnapshotA);
    assert.ok(
      readdirSync(metricsDirB).some((fileName) => fileName.endsWith(".exit.prom")),
    );
  });

  it("uses the home log directory fallback when LOG_DIR is unset or blank", () => {
    const fallback = join(homedir(), ".minime", "logs");

    delete process.env.LOG_DIR;
    assert.strictEqual(resolveCronLogDir(), fallback);

    process.env.LOG_DIR = "   ";
    assert.strictEqual(resolveCronLogDir(), fallback);
  });
});
