import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  clearCronOutboxRecord,
  readCronOutboxRecord,
  sanitizeCronMetricStem,
  type CronOutboxRecord,
  writeCronOutboxRecord,
} from "../cron-outbox.js";
import { installCronTestEnv } from "./cron-test-env.js";

const testEnv = installCronTestEnv();
const outboxDir = join(testEnv.controlRoot, "data", "cron-outbox");

function makeRecord(overrides: Partial<CronOutboxRecord> = {}): CronOutboxRecord {
  return {
    version: 1,
    cron: "daily-report",
    runId: "daily-report@2026-07-17T09:00:01.234Z#4242",
    kind: "output",
    payload: "Scheduled report output",
    chatId: 111111111,
    threadId: 42,
    createdAt: "2026-07-17T09:00:31.000Z",
    attempts: 0,
    ...overrides,
  };
}

function recordPath(cronName: string): string {
  return join(outboxDir, `${sanitizeCronMetricStem(cronName)}.json`);
}

describe("cron outbox", () => {
  beforeEach(() => {
    rmSync(join(testEnv.controlRoot, "data"), { recursive: true, force: true });
  });

  it("round-trips and clears a record using an atomic write", () => {
    const record = makeRecord();

    writeCronOutboxRecord(record);

    assert.deepStrictEqual(readCronOutboxRecord(record.cron), record);
    assert.deepStrictEqual(
      readdirSync(outboxDir).filter((fileName) => fileName.endsWith(".tmp")),
      [],
    );
    assert.strictEqual(statSync(outboxDir).mode & 0o777, 0o700);
    assert.strictEqual(statSync(recordPath(record.cron)).mode & 0o777, 0o600);

    clearCronOutboxRecord(record.cron);
    assert.strictEqual(readCronOutboxRecord(record.cron), undefined);
  });

  it("removes its temporary file when the atomic rename fails", () => {
    const record = makeRecord();
    mkdirSync(recordPath(record.cron), { recursive: true });

    assert.throws(() => writeCronOutboxRecord(record));
    assert.deepStrictEqual(
      readdirSync(outboxDir).filter((fileName) => fileName.endsWith(".tmp")),
      [],
    );
  });

  it("round-trips a valid record without a thread ID", () => {
    const record = makeRecord();
    delete record.threadId;

    writeCronOutboxRecord(record);

    assert.deepStrictEqual(readCronOutboxRecord(record.cron), record);
  });

  it("creates a missing outbox directory when writing", () => {
    assert.strictEqual(existsSync(outboxDir), false);

    writeCronOutboxRecord(makeRecord());

    assert.strictEqual(existsSync(outboxDir), true);
  });

  it("uses collision-safe stems for cron names with the same sanitized prefix", () => {
    const first = makeRecord({ cron: "daily report", runId: "first-run" });
    const second = makeRecord({ cron: "daily/report", runId: "second-run" });

    assert.notStrictEqual(sanitizeCronMetricStem(first.cron), sanitizeCronMetricStem(second.cron));
    assert.ok(sanitizeCronMetricStem(first.cron).startsWith("daily_report_"));
    assert.ok(sanitizeCronMetricStem(second.cron).startsWith("daily_report_"));

    writeCronOutboxRecord(first);
    writeCronOutboxRecord(second);

    assert.deepStrictEqual(readCronOutboxRecord(first.cron), first);
    assert.deepStrictEqual(readCronOutboxRecord(second.cron), second);
    assert.strictEqual(readdirSync(outboxDir).length, 2);
  });

  it("returns corrupt for malformed JSON", () => {
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(recordPath("daily-report"), "{not-json", "utf8");

    assert.strictEqual(readCronOutboxRecord("daily-report"), "corrupt");
  });

  it("returns corrupt for a record with the wrong version", () => {
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(
      recordPath("daily-report"),
      JSON.stringify({ ...makeRecord(), version: 2 }),
      "utf8",
    );

    assert.strictEqual(readCronOutboxRecord("daily-report"), "corrupt");
  });

  it("returns corrupt for a record with a non-string payload", () => {
    mkdirSync(outboxDir, { recursive: true });
    writeFileSync(
      recordPath("daily-report"),
      JSON.stringify({ ...makeRecord(), payload: { text: "not a string" } }),
      "utf8",
    );

    assert.strictEqual(readCronOutboxRecord("daily-report"), "corrupt");
  });

  it("rejects every malformed record field", () => {
    const malformedRecords: Array<{ name: string; value: unknown }> = [
      { name: "null record", value: null },
      { name: "array record", value: [] },
      { name: "mismatched cron", value: { ...makeRecord(), cron: "other-cron" } },
      { name: "missing run ID", value: { ...makeRecord(), runId: undefined } },
      { name: "invalid kind", value: { ...makeRecord(), kind: "other" } },
      { name: "non-finite chat ID", value: { ...makeRecord(), chatId: Number.POSITIVE_INFINITY } },
      { name: "invalid thread ID", value: { ...makeRecord(), threadId: "42" } },
      { name: "invalid creation time", value: { ...makeRecord(), createdAt: "not-a-date" } },
      { name: "fractional attempts", value: { ...makeRecord(), attempts: 1.5 } },
      { name: "negative attempts", value: { ...makeRecord(), attempts: -1 } },
    ];
    mkdirSync(outboxDir, { recursive: true });

    for (const malformed of malformedRecords) {
      writeFileSync(
        recordPath("daily-report"),
        JSON.stringify(malformed.value),
        "utf8",
      );
      assert.strictEqual(
        readCronOutboxRecord("daily-report"),
        "corrupt",
        malformed.name,
      );
    }
  });

  it("rethrows filesystem read failures without deleting valid state", () => {
    const record = makeRecord();
    writeCronOutboxRecord(record);
    const path = recordPath(record.cron);
    chmodSync(path, 0o000);

    try {
      assert.throws(
        () => readCronOutboxRecord(record.cron),
        (err: unknown) => (err as NodeJS.ErrnoException).code === "EACCES",
      );
    } finally {
      chmodSync(path, 0o600);
    }

    assert.deepStrictEqual(readCronOutboxRecord(record.cron), record);
  });

  it("clears a nonexistent record without creating the outbox directory", () => {
    assert.doesNotThrow(() => clearCronOutboxRecord("missing"));
    assert.strictEqual(existsSync(outboxDir), false);
  });

  it("returns undefined when the outbox directory does not exist", () => {
    assert.strictEqual(readCronOutboxRecord("missing"), undefined);
    assert.strictEqual(existsSync(outboxDir), false);
  });
});
