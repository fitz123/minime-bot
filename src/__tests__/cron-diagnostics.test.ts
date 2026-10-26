import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import {
  CRON_DIAGNOSTIC_FILE_NAME,
  CRON_DIAGNOSTIC_SCHEMA_VERSION,
  resolveCronDiagnosticPath,
  retainCronDiagnosticText,
  serializeCronDiagnosticEvent,
  writeCronDiagnosticEvent,
  type CronDiagnosticEvent,
} from "../cron-diagnostics.js";

const roots: string[] = [];
const DIAGNOSTICS_SOURCE_URL = new URL("../cron-diagnostics.ts", import.meta.url).href;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "cron-diagnostics-test-"));
  roots.push(root);
  return root;
}

function startedEvent(runId = "fixture-task@2026-01-02T03:04:05.000Z#123"): CronDiagnosticEvent {
  return {
    event: "run_started",
    cron: "fixture-task",
    cronType: "llm",
    runId,
  };
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true });
  }
});

describe("cron diagnostics writer", () => {
  it("appends valid versioned JSONL at the exact stable path with mode 0600", () => {
    const logDir = join(tempRoot(), "logs");
    const expectedPath = join(logDir, CRON_DIAGNOSTIC_FILE_NAME);

    writeCronDiagnosticEvent(startedEvent(), logDir);
    chmodSync(expectedPath, 0o666);
    writeCronDiagnosticEvent({
      ...startedEvent(),
      event: "run_terminal",
      outcome: "success",
      disposition: "delivered",
    }, logDir);

    assert.strictEqual(resolveCronDiagnosticPath(logDir), expectedPath);
    assert.strictEqual(statSync(expectedPath).mode & 0o777, 0o600);
    const lines = readFileSync(expectedPath, "utf8").trimEnd().split("\n");
    assert.strictEqual(lines.length, 2);
    const records = lines.map((line) => JSON.parse(line));
    assert.deepStrictEqual(records.map((record) => record.schemaVersion), [
      CRON_DIAGNOSTIC_SCHEMA_VERSION,
      CRON_DIAGNOSTIC_SCHEMA_VERSION,
    ]);
    assert.deepStrictEqual(records.map((record) => record.event), [
      "run_started",
      "run_terminal",
    ]);
    assert.ok(records.every((record) => Number.isFinite(Date.parse(record.timestamp))));
  });

  it("sanitizes controls, redacts secret-shaped material and URLs, and reports exact truncation", () => {
    const secret = `sk-${"a".repeat(24)}`;
    const bearer = `Bearer ${"b".repeat(24)}`;
    const url = "https://example.invalid/report?token=synthetic-value";
    const jsonCredential = "opaque-json-credential";
    const yamlCredential = "opaque-yaml-credential";
    const source = `start\u0000\u001b[31m red\napi_key=${secret} ${bearer} ${url} {"password":"${jsonCredential}"} 'credential': '${yamlCredential}' ending`;
    const limit = 32;
    const fullySanitized = retainCronDiagnosticText(source, Number.MAX_SAFE_INTEGER);
    const retained = retainCronDiagnosticText(source, limit);

    assert.strictEqual(retained.sourceChars, Array.from(source).length);
    assert.strictEqual(retained.retainedChars, Array.from(retained.text).length);
    assert.strictEqual(
      retained.omittedChars,
      Array.from(fullySanitized.text).length - limit,
    );
    assert.strictEqual(retained.truncated, true);
    assert.strictEqual(retained.redacted, true);
    assert.doesNotMatch(retained.text, /[\u0000-\u001F\u007F-\u009F]/u);
    assert.doesNotMatch(retained.text, /example\.invalid|synthetic-value|a{12}|b{12}/u);
    assert.match(retained.text, /\[REDACTED/);
    assert.doesNotMatch(fullySanitized.text, /opaque-json-credential|opaque-yaml-credential/u);
    assert.match(fullySanitized.text, /"password":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /'credential': \[REDACTED\]/u);
  });

  it("serializes only allowlisted event and retained-text fields", () => {
    const longRunId = "r".repeat(300);
    const event = {
      event: "execution_failure",
      cron: "fixture-task",
      cronType: "script",
      runId: longRunId,
      outcome: "failure",
      failure: {
        category: "execution_error",
        kind: "error",
        summary: {
          ...retainCronDiagnosticText("safe summary", 100),
          forbiddenNested: "must not be serialized",
        },
        forbiddenFailure: "must not be serialized",
      },
      prompt: "must not be serialized",
      stack: "must not be serialized",
    } as unknown as CronDiagnosticEvent;

    const record = JSON.parse(serializeCronDiagnosticEvent(event));

    assert.deepStrictEqual(Object.keys(record).sort(), [
      "cron",
      "cronType",
      "event",
      "failure",
      "outcome",
      "runId",
      "schemaVersion",
      "timestamp",
    ]);
    assert.deepStrictEqual(Object.keys(record.failure).sort(), ["category", "kind", "summary"]);
    assert.ok(!("forbiddenNested" in record.failure.summary));
    assert.doesNotMatch(JSON.stringify(record), /must not be serialized/);
    const truncatedRunId = record.runId as string;
    const suffix = truncatedRunId.match(/ \[truncated (\d+) chars\]$/);
    assert.ok(suffix);
    assert.strictEqual(Array.from(truncatedRunId).length, 256);
    assert.strictEqual(
      Number(suffix[1]),
      Array.from(longRunId).length - Array.from(truncatedRunId.slice(0, suffix.index)).length,
    );
  });

  it("refuses an unsafe sink target instead of following or replacing it", () => {
    const logDir = join(tempRoot(), "logs");
    mkdirSync(join(logDir, CRON_DIAGNOSTIC_FILE_NAME), { recursive: true });

    assert.throws(() => writeCronDiagnosticEvent(startedEvent(), logDir));
    assert.ok(statSync(join(logDir, CRON_DIAGNOSTIC_FILE_NAME)).isDirectory());
  });

  it("keeps concurrent process appends as complete parseable JSON lines", async () => {
    const logDir = join(tempRoot(), "logs");
    const writers = 4;
    const eventsPerWriter = 20;
    const children = Array.from({ length: writers }, (_, writer) => {
      const script = [
        `import { writeCronDiagnosticEvent } from ${JSON.stringify(DIAGNOSTICS_SOURCE_URL)};`,
        `for (let index = 0; index < ${eventsPerWriter}; index += 1) {`,
        `writeCronDiagnosticEvent({ event: "run_started", cron: "fixture-task", cronType: "llm", runId: ${JSON.stringify(`writer-${writer}`)} + "-" + index }, ${JSON.stringify(logDir)});`,
        "}",
      ].join("\n");
      return new Promise<void>((resolvePromise, reject) => {
        const child = spawn(
          process.execPath,
          ["--import", "tsx", "--input-type=module", "--eval", script],
          { stdio: ["ignore", "ignore", "pipe"] },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
          if (code === 0) resolvePromise();
          else reject(new Error(`diagnostic writer child failed (${code ?? signal}): ${stderr}`));
        });
      });
    });

    await Promise.all(children);

    const lines = readFileSync(resolveCronDiagnosticPath(logDir), "utf8").trimEnd().split("\n");
    assert.strictEqual(lines.length, writers * eventsPerWriter);
    assert.ok(lines.every((line) => JSON.parse(line).event === "run_started"));
  });

  it("surfaces direct filesystem write failures for the runner's fail-soft boundary", () => {
    const root = tempRoot();
    const blocker = join(root, "not-a-directory");
    writeFileSync(blocker, "fixture", "utf8");

    assert.throws(
      () => writeCronDiagnosticEvent(startedEvent(), join(blocker, "logs")),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOTDIR",
    );
  });
});
