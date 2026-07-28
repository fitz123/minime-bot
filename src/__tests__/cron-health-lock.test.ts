import { after, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  type PathOrFileDescriptor,
  type WriteFileOptions,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const { default: fsDefault, ...fsNamedExports } = fs as typeof fs & {
  default: typeof fs;
};
const realWriteFileSync = fs.writeFileSync;
let rejectClaimWrite = false;

mock.module("node:fs", {
  defaultExport: fsDefault,
  namedExports: {
    ...fsNamedExports,
    writeFileSync(
      path: PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: WriteFileOptions,
    ): void {
      if (
        rejectClaimWrite
        && typeof path === "string"
        && basename(path).startsWith("claim-")
      ) {
        rejectClaimWrite = false;
        throw Object.assign(new Error("synthetic claim write failure"), { code: "EIO" });
      }
      realWriteFileSync(path, data, options);
    },
  },
});

const { writeCronHealthMetric } = await import("../cron-runner.js");
const metricDir = mkdtempSync(join(tmpdir(), "minime-cron-health-lock-"));
const previousMetricDir = process.env.CRON_HEALTH_TEXTFILE_DIR;
process.env.CRON_HEALTH_TEXTFILE_DIR = metricDir;

after(() => {
  if (previousMetricDir === undefined) {
    delete process.env.CRON_HEALTH_TEXTFILE_DIR;
  } else {
    process.env.CRON_HEALTH_TEXTFILE_DIR = previousMetricDir;
  }
  rmSync(metricDir, { recursive: true, force: true });
});

it("cleans a newly created lock directory when the initial claim write fails", () => {
  rejectClaimWrite = true;

  assert.throws(
    () => writeCronHealthMetric("claim-write-failure", 1, "failure"),
    /failed to lock cron health metric.*synthetic claim write failure/s,
  );
  assert.deepStrictEqual(readdirSync(metricDir), []);

  writeCronHealthMetric("claim-write-failure", 1, "failure");
  assert.ok(readdirSync(metricDir).some((name) => name.endsWith(".exit.prom")));
  assert.ok(readdirSync(metricDir).every((name) => !name.endsWith(".lock")));
});
