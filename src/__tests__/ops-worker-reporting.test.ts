import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createOpsWorkerFieldRedactor,
  OPS_WORKER_REPORT_FIELD_LIMITS,
} from "../ops-worker/reporting.js";

describe("ops worker result reporting", () => {
  it("redacts configured and patterned secrets from every bounded agent field", () => {
    const configuredCanary = "CANARY_CONFIGURED_SECRET_58";
    const opaqueCanary = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef";
    const redact = createOpsWorkerFieldRedactor([configuredCanary]);
    const raw = [
      configuredCanary,
      "Bearer bearer-canary-value-1234567890",
      "password=assignment-canary",
      "https://private-user:private-password@example.invalid/path?token=query-canary",
      "/Users/private-user/control/workspace/file.txt",
      opaqueCanary,
      "line-one\nline-two\u0000tail",
    ].join(" | ");

    const result = redact(raw, 4_096);

    for (const secret of [
      configuredCanary,
      "bearer-canary-value-1234567890",
      "assignment-canary",
      "private-user",
      "private-password",
      "query-canary",
      opaqueCanary,
    ]) {
      assert.equal(result.includes(secret), false, secret);
    }
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(result), false);
    assert.match(result, /\[REDACTED\]/);
    assert.match(result, /\[REDACTED_HOME_PATH\]/);
  });

  it("applies a UTF-8 field budget after redaction", () => {
    const redact = createOpsWorkerFieldRedactor(["EXACT_CANARY"]);
    const result = redact(
      `EXACT_CANARY ${"🙂".repeat(2_000)}`,
      OPS_WORKER_REPORT_FIELD_LIMITS.agentSummaryBytes,
    );

    assert.ok(
      Buffer.byteLength(result, "utf8")
      <= OPS_WORKER_REPORT_FIELD_LIMITS.agentSummaryBytes,
    );
    assert.equal(result.includes("EXACT_CANARY"), false);
    assert.match(result, /… \[truncated\]$/);
  });
});
