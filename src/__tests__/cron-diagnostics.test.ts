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
import { performance } from "node:perf_hooks";
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
    const bearer = `Bearer ${"b".repeat(20)}1234`;
    const combinedAuth = "token: Bearer opaquecredentialvalue123456";
    const url = "https://example.invalid/report?token=synthetic-value";
    const connectionUri = "postgresql://opaque-user:opaque-uri-password@db.example.invalid/opaque-database?sslmode=opaque-mode";
    const jwt = `${"j_".repeat(8)}.${"w-".repeat(8)}.${"t_".repeat(8)}`;
    const jsonCredential = "opaque-json-credential";
    const escapedJsonCredential = "opaque-escaped-json-credential";
    const yamlCredential = "opaque-yaml-credential";
    const compoundCredentials = [
      '{"access_token":"opaque-json-access-token","client_secret":"opaque-json-client-secret","database_password":"opaque-json-password"}',
      '{"accessToken":"opaque-camel-access-token","refreshToken":"opaque-camel-refresh-token","clientSecret":"opaque-camel-client-secret","databasePassword":"opaque-camel-password"}',
      '{"SECRET_KEY":"opaque-json-secret-key","service_secret_key":"opaque-json-prefixed-secret-key","databasePass":"opaque-camel-pass","cachePwd":"opaque-camel-pwd"}',
      "refresh_token: opaque-yaml-refresh-token",
      "service_passwd=opaque-yaml-passwd",
      "auth_api_key: opaque-yaml-api-key",
      "cloud_access-key=opaque-yaml-access-key",
      "tls_private_key: opaque-yaml-private-key",
      "storage_credential=opaque-yaml-credential",
    ].join(" ");
    const privateKeyBlocks = [
      "config: |\n  -----BEGIN RSA PRIVATE KEY-----\nopaque-rsa-private-material\n-----END RSA PRIVATE KEY-----",
      "config: |\n  -----BEGIN EC PRIVATE KEY-----\nopaque-ec-private-material\n-----END EC PRIVATE KEY-----",
      "config: |\n  -----BEGIN PRIVATE KEY-----\nopaque-pkcs8-private-material\n-----END PRIVATE KEY-----",
      "config: |\n  -----BEGIN OPENSSH PRIVATE KEY-----\nopaque-openssh-private-material\n-----END OPENSSH PRIVATE KEY-----",
      "config: |\n  -----BEGIN ENCRYPTED PRIVATE KEY-----\nopaque-encrypted-private-material\n-----END ENCRYPTED PRIVATE KEY-----",
      "config: |\n  -----BEGIN PGP PRIVATE KEY BLOCK-----\nopaque-pgp-private-material\n-----END PGP PRIVATE KEY BLOCK-----",
    ].join("\n");
    const escapedJson = `{\u0000\\"password\\":\\"${escapedJsonCredential}\\"}`;
    const ordinaryKeys = "tokenizer: keep-tokenizer-value secretariat=keep-secretariat-value passwordless: keep-passwordless-value";
    const source = `start\u0000\u001b[31m red\napi_key=${secret} ${bearer} ${combinedAuth} ${url} ${connectionUri} ${jwt} ${jwt}. {"password":"${jsonCredential}"} ${escapedJson} 'credential': '${yamlCredential}' ${compoundCredentials} ${privateKeyBlocks} ${ordinaryKeys} ending`;
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
    assert.doesNotMatch(
      fullySanitized.text,
      /opaque-(?:json|yaml|camel)-(?:access-token|client-secret|password|refresh-token|passwd|api-key|access-key|private-key|credential|secret-key|prefixed-secret-key|pass|pwd)/u,
    );
    assert.doesNotMatch(
      fullySanitized.text,
      /opaque-user|opaque-uri-password|db\.example\.invalid|opaque-database|opaque-mode/u,
    );
    assert.doesNotMatch(
      fullySanitized.text,
      /opaquecredentialvalue|opaque-escaped-json-credential|opaque-(?:rsa|ec|pkcs8|openssh|encrypted|pgp)-private-material|BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY|BEGIN PGP PRIVATE KEY BLOCK/u,
    );
    assert.ok(!fullySanitized.text.includes(jwt));
    assert.match(fullySanitized.text, /\[REDACTED\] \[REDACTED\]\./u);
    assert.match(fullySanitized.text, /token: \[REDACTED\]/u);
    assert.match(fullySanitized.text, /"password":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /\{ \\"password\\":\[REDACTED\]\}/u);
    assert.match(fullySanitized.text, /'credential': \[REDACTED\]/u);
    assert.match(fullySanitized.text, /"access_token":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /"client_secret":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /"accessToken":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /"refreshToken":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /"clientSecret":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /"databasePassword":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /"SECRET_KEY":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /"service_secret_key":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /"databasePass":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /"cachePwd":\[REDACTED\]/u);
    assert.match(fullySanitized.text, /refresh_token: \[REDACTED\]/u);
    assert.match(fullySanitized.text, /tls_private_key: \[REDACTED\]/u);
    assert.match(fullySanitized.text, /tokenizer: keep-tokenizer-value/u);
    assert.match(fullySanitized.text, /secretariat=keep-secretariat-value/u);
    assert.match(fullySanitized.text, /passwordless: keep-passwordless-value/u);
  });

  it("redacts sensitive YAML block bodies before control normalization", () => {
    const source = [
      "password: |",
      "  opaque-literal-first",
      "  opaque-literal-second",
      "following: preserved-value",
      "secret_key: >-",
      "    opaque-folded-first",
      "    opaque-folded-second",
      "tail: preserved-tail",
    ].join("\n");

    const retained = retainCronDiagnosticText(source, Number.MAX_SAFE_INTEGER);

    assert.strictEqual(retained.redacted, true);
    assert.doesNotMatch(retained.text, /opaque-(?:literal|folded)/u);
    assert.strictEqual(retained.text.match(/\[REDACTED\]/gu)?.length, 2);
    assert.match(retained.text, /password: \|   \[REDACTED\] following: preserved-value/u);
    assert.match(retained.text, /secret_key: >-     \[REDACTED\] tail: preserved-tail/u);
  });

  it("redacts escaped nested JSON fields without consuming later fields", () => {
    const source = String.raw`kubectl.kubernetes.io/last-applied-configuration: {\"password\":\"opaque-password, with \\\"inner\\\" material\", \"note\":\"kept, with spaces and \\\"inner\\\" material\", \"count\":2, \"token\":\"opaque-token\", \"tail\":\"preserved\"}`;
    const expected = String.raw`kubectl.kubernetes.io/last-applied-configuration: {\"password\":[REDACTED], \"note\":\"kept, with spaces and \\\"inner\\\" material\", \"count\":2, \"token\":[REDACTED], \"tail\":\"preserved\"}`;

    const retained = retainCronDiagnosticText(source, Number.MAX_SAFE_INTEGER);

    assert.strictEqual(retained.text, expected);
    assert.strictEqual(retained.redacted, true);
    assert.doesNotMatch(retained.text, /opaque-password|opaque-token/u);
  });

  it("handles repeated unterminated escaped secret assignments linearly", () => {
    const fragment = String.raw`{\"password\":\"unterminated-value`;
    const source = fragment.repeat(Math.ceil(400_000 / fragment.length)).slice(0, 400_000);
    const startedAt = performance.now();
    const retained = retainCronDiagnosticText(source, 128);
    const elapsedMs = performance.now() - startedAt;

    assert.strictEqual(retained.sourceChars, 400_000);
    assert.strictEqual(retained.text, String.raw`{\"password\":[REDACTED]`);
    assert.strictEqual(retained.retainedChars, retained.text.length);
    assert.strictEqual(retained.omittedChars, 0);
    assert.strictEqual(retained.truncated, false);
    assert.strictEqual(retained.redacted, true);
    assert.ok(elapsedMs < 1_000, `sanitizing malformed escaped JSON took ${elapsedMs.toFixed(1)}ms`);
  });

  it("redacts auth credentials in explicit contexts without redacting prose", () => {
    const source = [
      "Authorization: Bearer opaqueheaderletters",
      "token: Bearer opaqueassignmentletters",
      "Standalone Bearer opaqueletterscredential",
      "Standalone Basic alphabeticcredential",
      "Standalone Bearer opaque123456789",
      "Standalone Basic dG9rZW4=",
      "basic troubleshooting steps",
      "bearer instruments market",
    ].join("; ");

    const retained = retainCronDiagnosticText(source, Number.MAX_SAFE_INTEGER);

    assert.doesNotMatch(
      retained.text,
      /opaqueheaderletters|opaqueassignmentletters|opaqueletterscredential|alphabeticcredential|opaque123456789|dG9rZW4=/u,
    );
    assert.match(retained.text, /Authorization: Bearer \[REDACTED\]/u);
    assert.match(retained.text, /token: \[REDACTED\]/u);
    assert.strictEqual(retained.text.match(/Standalone Bearer \[REDACTED\]/gu)?.length, 2);
    assert.strictEqual(retained.text.match(/Standalone Basic \[REDACTED\]/gu)?.length, 2);
    assert.match(retained.text, /basic troubleshooting steps/u);
    assert.match(retained.text, /bearer instruments market/u);
  });

  it("handles bounded long URI/JWT-like non-candidates without overlapping rescans", () => {
    const source = [
      "a-".repeat(100_000),
      `${"b".repeat(15)}.`.repeat(12_500),
    ].join(" ");
    const startedAt = performance.now();
    const retained = retainCronDiagnosticText(source, 128);
    const elapsedMs = performance.now() - startedAt;

    assert.strictEqual(source.length, 400_001);
    assert.strictEqual(retained.sourceChars, Array.from(source).length);
    assert.strictEqual(retained.retainedChars, 128);
    assert.strictEqual(retained.omittedChars, Array.from(source).length - 128);
    assert.strictEqual(retained.truncated, true);
    assert.strictEqual(retained.redacted, false);
    assert.strictEqual(retained.text, source.slice(0, 128));
    assert.ok(elapsedMs < 1_000, `sanitizing adversarial input took ${elapsedMs.toFixed(1)}ms`);
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
