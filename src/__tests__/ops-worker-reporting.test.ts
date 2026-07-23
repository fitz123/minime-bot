import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOpsWorkerTelegramReport,
  createOpsWorkerFieldRedactor,
  OPS_WORKER_REPORT_FIELD_LIMITS,
} from "../ops-worker/reporting.js";
import type { OpsWorkerTask } from "../ops-worker/types.js";

describe("ops worker result reporting", () => {
  it("redacts configured and patterned secrets from every bounded agent field", () => {
    const configuredCanary = "CANARY_CONFIGURED_SECRET_58";
    const opaqueCanary = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef";
    const paddedOpaqueCanary = "ABCDEFGHIJKLMNOPQRSTUVWXYZ01234=";
    const slashOpaqueCanary = "/ABCDEFGHIJKLMNOPQRSTUVWXYZ01234";
    const punctuatedOpaqueCanary = "abcdefghijklmnopqrst.uvwxyz:ABCDEFGHIJKLMN";
    const redact = createOpsWorkerFieldRedactor([configuredCanary]);
    const raw = [
      configuredCanary,
      "Bearer bearer-canary-value-1234567890",
      "password=assignment-canary",
      "password=\"alpha beta gamma\"",
      "passwd=escaped-canary\\ continuation-canary",
      "Authorization: Basic dXNlcjpwYXNz",
      "https://private-user:private-password@example.invalid/path?token=query-canary",
      "/Users/private-user/control/workspace/file.txt",
      opaqueCanary,
      paddedOpaqueCanary,
      slashOpaqueCanary,
      punctuatedOpaqueCanary,
      "line-one\nline-two\u0000tail",
    ].join(" | ");

    const result = redact(raw, 4_096);

    for (const secret of [
      configuredCanary,
      "bearer-canary-value-1234567890",
      "assignment-canary",
      "alpha beta gamma",
      "escaped-canary",
      "continuation-canary",
      "dXNlcjpwYXNz",
      "private-user",
      "private-password",
      "query-canary",
      opaqueCanary,
      paddedOpaqueCanary,
      slashOpaqueCanary,
      punctuatedOpaqueCanary,
    ]) {
      assert.equal(result.includes(secret), false, secret);
    }
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(result), false);
    assert.match(result, /\[REDACTED\]/);
    assert.match(result, /\[REDACTED_HOME_PATH\]/);
  });

  it("retains every required result and verifier section within the total report budget", () => {
    const task = {
      id: "report-budget-fixture",
      source: {
        kind: "alertmanager",
        template: "ops.alertmanager-incident",
        correlationKey: `lab-alertmanager:group:${"a".repeat(64)}`,
      },
      state: "BLOCKED",
      agentResult: {
        attemptId: "attempt-report-budget",
        kind: "input-needed",
        summary: `diagnosis-visible ${"d".repeat(2_000)}`,
        actions: [`action-visible ${"a".repeat(1_000)}`],
        requestedInput: `input-visible ${"i".repeat(2_000)}`,
        reason: "information",
      },
      verification: {
        checkedAt: "2026-07-22T12:00:00.000Z",
        outcome: "NOT_READY",
        components: [
          { identity: "monitoring-freshness", outcome: "PASS", summary: "fresh" },
          { identity: "exact-group-absence", outcome: "PASS", summary: "absent" },
          { identity: "resolution-stability", outcome: "NOT_READY", summary: "waiting" },
        ],
      },
      lastOutcome: null,
      updatedAt: "2026-07-22T12:00:00.000Z",
    } as unknown as OpsWorkerTask;

    const report = buildOpsWorkerTelegramReport(task, {
      redact: createOpsWorkerFieldRedactor(),
      maxBytes: 1_024,
    });

    assert.ok(Buffer.byteLength(report, "utf8") <= 1_024);
    for (const required of [
      "typedOutcome=input-needed reason=information",
      "diagnosis=diagnosis-visible",
      "actions=action-visible",
      "requestedInput=input-visible",
      "verification=NOT_READY",
      "monitoring-freshness/PASS",
      "exact-group-absence/PASS",
      "resolution-stability/NOT_READY",
      "checkedAt=2026-07-22T12:00:00.000Z",
    ]) assert.match(report, new RegExp(required));
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

  it("redacts configured values from the persisted source identity", () => {
    const configuredCanary = "SOURCE_IDENTITY_CANARY_58";
    const task = {
      id: "report-source-identity-fixture",
      source: {
        kind: "operator-cli",
        template: "ops.availability",
        correlationKey: `operator:${configuredCanary}`,
      },
      state: "BLOCKED",
      agentResult: null,
      verification: null,
      lastOutcome: null,
      updatedAt: "2026-07-22T12:00:00.000Z",
    } as unknown as OpsWorkerTask;

    const report = buildOpsWorkerTelegramReport(task, {
      redact: createOpsWorkerFieldRedactor([configuredCanary]),
      maxBytes: 4_096,
    });

    assert.match(report, /identity=operator-cli\/ops\.availability correlation=operator:\[REDACTED\]/);
    assert.equal(report.includes(configuredCanary), false);
  });

  it("renders bounded redacted Alertmanager group and episode identity", () => {
    const configuredCanary = "REPORT_IDENTITY_CANARY_58";
    const correlationKey = `lab-alertmanager:group:${"b".repeat(64)}`;
    const task = {
      id: "report-identity-fixture",
      source: {
        kind: "alertmanager",
        template: "ops.alertmanager-incident",
        correlationKey,
      },
      evidence: [
        {
          kind: "alert",
          summary: JSON.stringify({
            type: "alertmanager-group-correlation-v1",
            correlationKey,
            groupLabels: { alertname: "HostHighCPU", cluster: configuredCanary },
          }),
        },
        {
          kind: "alert",
          summary: JSON.stringify({
            status: "firing",
            startsAt: "2026-07-22T11:55:00.000Z",
            labels: { alertname: "HostHighCPU", cluster: configuredCanary },
          }),
        },
      ],
      state: "BLOCKED",
      agentResult: null,
      verification: null,
      lastOutcome: null,
      updatedAt: "2026-07-22T12:00:00.000Z",
    } as unknown as OpsWorkerTask;

    const report = buildOpsWorkerTelegramReport(task, {
      redact: createOpsWorkerFieldRedactor([configuredCanary]),
      maxBytes: 4_096,
    });

    assert.match(report, /incident=alertname=HostHighCPU/);
    assert.match(report, /groupLabels=\{"alertname":"HostHighCPU","cluster":"\[REDACTED\]"\}/);
    assert.match(report, /episodeStart=2026-07-22T11:55:00.000Z/);
    assert.equal(report.includes(configuredCanary), false);
  });
});
