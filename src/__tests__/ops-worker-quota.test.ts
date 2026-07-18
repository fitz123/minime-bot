import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CodexQuotaSnapshot } from "../pi-extensions/codex-usage.js";
import {
  CodexQuotaFileReader,
  evaluateOpsWorkerQuotaAdmission,
  evaluateOpsWorkerQuotaResponse,
  type OpsWorkerQuotaReadResult,
} from "../ops-worker/quota.js";

const NOW = new Date("2026-07-18T12:00:00.000Z");

function snapshot(input: {
  sampledAt?: string;
  activeLimit?: string;
  fiveHour?: { used: number; resetAt: string } | null;
  week?: { used: number; resetAt: string } | null;
} = {}): CodexQuotaSnapshot {
  const sampledAt = input.sampledAt ?? "2026-07-18T11:59:00.000Z";
  const window = (
    value: { used: number; resetAt: string } | null | undefined,
  ): CodexQuotaSnapshot["windows"]["5h"] => value === null
    ? {}
    : {
      usedPercent: value?.used ?? 20,
      remainingPercent: 100 - (value?.used ?? 20),
      resetAt: value?.resetAt ?? "2026-07-18T15:00:00.000Z",
      resetTimestamp: Date.parse(
        value?.resetAt ?? "2026-07-18T15:00:00.000Z",
      ) / 1_000,
    };
  return {
    provider: "codex",
    sampledAt,
    lastSuccess: sampledAt,
    lastSuccessTimestamp: Date.parse(sampledAt) / 1_000,
    ...(input.activeLimit === undefined ? {} : { activeLimit: input.activeLimit }),
    windows: {
      "5h": window(input.fiveHour),
      week: window(input.week === undefined
        ? {
          used: 45,
          resetAt: "2026-07-21T00:00:00.000Z",
        }
        : input.week),
    },
  };
}

function readOk(value: CodexQuotaSnapshot): OpsWorkerQuotaReadResult {
  return { status: "OK", snapshot: value };
}

describe("ops worker Codex quota admission", () => {
  it("requires every active window to retain half its quota and stay within elapsed pacing", () => {
    const admitted = evaluateOpsWorkerQuotaAdmission(readOk(snapshot({
      fiveHour: { used: 20, resetAt: "2026-07-18T15:00:00.000Z" },
      week: { used: 45, resetAt: "2026-07-21T00:00:00.000Z" },
    })), { now: NOW, staleMs: 5 * 60_000 });
    assert.equal(admitted.status, "ADMITTED");
    assert.equal(admitted.reason, "HEADROOM");
    assert.deepEqual(admitted.activeWindows, ["5h", "week"]);
    assert.match(admitted.evidenceHash, /^sha256:[a-f0-9]{64}$/);

    const lowRemaining = evaluateOpsWorkerQuotaAdmission(readOk(snapshot({
      fiveHour: { used: 51, resetAt: "2026-07-18T15:00:00.000Z" },
      week: null,
    })), { now: NOW });
    assert.equal(lowRemaining.status, "NOT_ADMITTED");
    assert.equal(lowRemaining.reason, "LOW_REMAINING");

    const paceExceeded = evaluateOpsWorkerQuotaAdmission(readOk(snapshot({
      fiveHour: { used: 45, resetAt: "2026-07-18T16:00:00.000Z" },
      week: null,
    })), { now: NOW });
    assert.equal(paceExceeded.status, "NOT_ADMITTED");
    assert.equal(paceExceeded.reason, "PACE_EXCEEDED");
    assert.equal(paceExceeded.nextResetAt, "2026-07-18T16:00:00.000Z");
  });

  it("uses inclusive headroom and pacing boundaries at the sample timestamp", () => {
    const exactHeadroom = evaluateOpsWorkerQuotaAdmission(readOk(snapshot({
      sampledAt: "2026-07-18T13:00:00.000Z",
      fiveHour: { used: 50, resetAt: "2026-07-18T15:00:00.000Z" },
      week: null,
    })), { now: new Date("2026-07-18T13:00:01.000Z") });
    assert.equal(exactHeadroom.status, "ADMITTED");

    const exactPace = evaluateOpsWorkerQuotaAdmission(readOk(snapshot({
      sampledAt: "2026-07-18T11:30:00.000Z",
      fiveHour: { used: 40, resetAt: "2026-07-18T15:00:00.000Z" },
      week: null,
    })), { now: new Date("2026-07-18T11:31:00.000Z") });
    assert.equal(exactPace.status, "ADMITTED");

    const justOverPace = evaluateOpsWorkerQuotaAdmission(readOk(snapshot({
      sampledAt: "2026-07-18T11:30:00.000Z",
      fiveHour: { used: 40.001, resetAt: "2026-07-18T15:00:00.000Z" },
      week: null,
    })), { now: new Date("2026-07-18T14:00:00.000Z"), staleMs: 24 * 60 * 60_000 });
    assert.equal(justOverPace.reason, "PACE_EXCEEDED");
  });

  it("returns typed closed evidence for missing, stale, resetless, durationless, and contradictory telemetry", () => {
    const missing = evaluateOpsWorkerQuotaAdmission({ status: "MISSING" }, { now: NOW });
    assert.equal(missing.reason, "MISSING");

    const stale = evaluateOpsWorkerQuotaAdmission(readOk(snapshot({
      sampledAt: "2026-07-18T10:00:00.000Z",
    })), { now: NOW, staleMs: 30 * 60_000 });
    assert.equal(stale.reason, "STALE");

    const resetlessSnapshot = snapshot({ week: null });
    delete resetlessSnapshot.windows["5h"].resetAt;
    delete resetlessSnapshot.windows["5h"].resetTimestamp;
    assert.equal(
      evaluateOpsWorkerQuotaAdmission(readOk(resetlessSnapshot), { now: NOW }).reason,
      "RESETLESS",
    );

    const durationlessSnapshot = snapshot({ week: null });
    durationlessSnapshot.windows = {
      ...durationlessSnapshot.windows,
      month: {
        usedPercent: 10,
        remainingPercent: 90,
        resetAt: "2026-08-01T00:00:00.000Z",
        resetTimestamp: Date.parse("2026-08-01T00:00:00.000Z") / 1_000,
      },
    } as CodexQuotaSnapshot["windows"];
    assert.equal(
      evaluateOpsWorkerQuotaAdmission(readOk(durationlessSnapshot), { now: NOW }).reason,
      "DURATIONLESS",
    );

    const contradictorySnapshot = snapshot({ week: null });
    contradictorySnapshot.windows["5h"].remainingPercent = 81;
    assert.equal(
      evaluateOpsWorkerQuotaAdmission(readOk(contradictorySnapshot), { now: NOW }).reason,
      "CONTRADICTORY",
    );
  });

  it("strictly reads one bounded regular snapshot and refuses symlinks or unknown fields", () => {
    const root = mkdtempSync(join(tmpdir(), "minime-ops-quota-"));
    try {
      const stateFile = join(root, "quota.json");
      const reader = new CodexQuotaFileReader(stateFile);
      assert.deepEqual(reader.read(), { status: "MISSING" });

      writeFileSync(stateFile, `${JSON.stringify(snapshot())}\n`, "utf8");
      assert.equal(reader.read().status, "OK");

      writeFileSync(
        stateFile,
        `${JSON.stringify({ ...snapshot(), unexpected: true })}\n`,
        "utf8",
      );
      assert.equal(reader.read().status, "INVALID");

      const durationless = snapshot();
      durationless.windows = {
        ...durationless.windows,
        month: {},
      } as CodexQuotaSnapshot["windows"];
      writeFileSync(stateFile, `${JSON.stringify(durationless)}\n`, "utf8");
      assert.equal(reader.read().status, "DURATIONLESS");

      const target = join(root, "target.json");
      writeFileSync(target, `${JSON.stringify(snapshot())}\n`, "utf8");
      rmSync(stateFile);
      symlinkSync(target, stateFile);
      assert.equal(reader.read().status, "INVALID");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the response's named authoritative reset and refreshes a rolling reset", () => {
    const first = evaluateOpsWorkerQuotaResponse(readOk(snapshot({
      activeLimit: "secondary",
      fiveHour: { used: 100, resetAt: "2026-07-18T13:00:00.000Z" },
      week: { used: 80, resetAt: "2026-07-20T00:00:00.000Z" },
    })), { now: NOW });
    assert.equal(first.status, "WAIT");
    assert.equal(first.resetAt, "2026-07-20T00:00:00.000Z");

    const rolled = evaluateOpsWorkerQuotaResponse(readOk(snapshot({
      sampledAt: "2026-07-18T12:59:59.000Z",
      fiveHour: { used: 100, resetAt: "2026-07-18T17:59:59.000Z" },
      week: null,
    })), { now: new Date("2026-07-18T13:00:00.000Z") });
    assert.equal(rolled.status, "WAIT");
    assert.equal(rolled.resetAt, "2026-07-18T17:59:59.000Z");

    const invalid = snapshot({ week: null });
    delete invalid.windows["5h"].resetAt;
    delete invalid.windows["5h"].resetTimestamp;
    assert.equal(
      evaluateOpsWorkerQuotaResponse(readOk(invalid), { now: NOW }).status,
      "TELEMETRY_ERROR",
    );

    const ambiguous = evaluateOpsWorkerQuotaResponse(readOk(snapshot({
      fiveHour: { used: 100, resetAt: "2026-07-18T13:00:00.000Z" },
      week: { used: 80, resetAt: "2026-07-20T00:00:00.000Z" },
    })), { now: NOW });
    assert.equal(ambiguous.status, "TELEMETRY_ERROR");
  });
});
