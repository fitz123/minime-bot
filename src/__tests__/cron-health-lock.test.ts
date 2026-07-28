import { after, afterEach, it, mock } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  rmSync,
  type PathOrFileDescriptor,
  type WriteFileOptions,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const { default: fsDefault, ...fsNamedExports } = fs as typeof fs & {
  default: typeof fs;
};
const realWriteFileSync = fs.writeFileSync;
type WriteFault =
  | "claim-before-write"
  | "claim-replace-before-write"
  | "claim-replace-after-write"
  | "owner-after-write";
let writeFault: WriteFault | undefined;

function installCompetingLock(lockPath: string): void {
  const ownerToken = `${process.pid}-unknown-deadbeef`;
  mkdirSync(lockPath, { mode: 0o700 });
  realWriteFileSync(
    join(lockPath, `claim-${ownerToken}`),
    `${ownerToken}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  realWriteFileSync(
    join(lockPath, `owner-${ownerToken}`),
    `${process.pid}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

mock.module("node:fs", {
  defaultExport: fsDefault,
  namedExports: {
    ...fsNamedExports,
    writeFileSync(
      path: PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      options?: WriteFileOptions,
    ): void {
      if (typeof path !== "string") {
        realWriteFileSync(path, data, options);
        return;
      }

      const entryName = basename(path);
      if (writeFault === "claim-before-write" && entryName.startsWith("claim-")) {
        writeFault = undefined;
        throw Object.assign(new Error("synthetic claim write failure"), { code: "EIO" });
      }

      if (writeFault === "claim-replace-before-write" && entryName.startsWith("claim-")) {
        writeFault = undefined;
        const lockPath = dirname(path);
        rmdirSync(lockPath);
        installCompetingLock(lockPath);
      } else if (writeFault === "claim-replace-after-write" && entryName.startsWith("claim-")) {
        writeFault = undefined;
        realWriteFileSync(path, data, options);
        const lockPath = dirname(path);
        fs.unlinkSync(path);
        rmdirSync(lockPath);
        installCompetingLock(lockPath);
        return;
      } else if (writeFault === "owner-after-write" && entryName.startsWith("owner-")) {
        writeFault = undefined;
        realWriteFileSync(path, data, options);
        throw Object.assign(new Error("synthetic owner write failure"), { code: "EIO" });
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

afterEach(() => {
  writeFault = undefined;
  rmSync(metricDir, { recursive: true, force: true });
  mkdirSync(metricDir, { recursive: true });
});

it("cleans a newly created lock directory when the initial claim write fails", () => {
  writeFault = "claim-before-write";

  assert.throws(
    () => writeCronHealthMetric("claim-write-failure", 1, "failure"),
    /failed to lock cron health metric.*synthetic claim write failure/s,
  );
  assert.deepStrictEqual(readdirSync(metricDir), []);

  writeCronHealthMetric("claim-write-failure", 1, "failure");
  assert.ok(readdirSync(metricDir).some((name) => name.endsWith(".exit.prom")));
  assert.ok(readdirSync(metricDir).every((name) => !name.endsWith(".lock")));
});

it("cleans a partially written owner file when the owner write fails", () => {
  writeFault = "owner-after-write";

  assert.throws(
    () => writeCronHealthMetric("owner-write-failure", 1, "failure"),
    /failed to lock cron health metric.*synthetic owner write failure/s,
  );
  assert.deepStrictEqual(readdirSync(metricDir), []);

  writeCronHealthMetric("owner-write-failure", 1, "failure");
  assert.ok(readdirSync(metricDir).some((name) => name.endsWith(".exit.prom")));
  assert.ok(readdirSync(metricDir).every((name) => !name.endsWith(".lock")));
});

for (const fault of [
  "claim-replace-before-write",
  "claim-replace-after-write",
] as const) {
  it(`fails before publishing when the lock directory is replaced at ${fault}`, () => {
    writeFault = fault;

    assert.throws(
      () => writeCronHealthMetric(`replaced-lock-${fault}`, 1, "failure"),
      /failed to lock cron health metric.*ownership changed during acquisition/s,
    );
    assert.ok(readdirSync(metricDir).every((name) => !name.endsWith(".prom")));

    const lockName = readdirSync(metricDir).find((name) => name.endsWith(".lock"));
    assert.ok(lockName);
    assert.deepStrictEqual(
      readdirSync(join(metricDir, lockName)).sort(),
      [
        `claim-${process.pid}-unknown-deadbeef`,
        `owner-${process.pid}-unknown-deadbeef`,
      ],
    );
    rmSync(join(metricDir, lockName), { recursive: true, force: true });
  });
}
