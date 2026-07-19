import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OPS_WORKER_FAULT_LAB_SCENARIO_NAMES,
  runOpsWorkerFaultLab,
  type OpsWorkerFaultLabSafetyEvent,
} from "./fixtures/ops-worker-fault-lab.js";

const EXPECTED_SCENARIOS = [
  "schema-mismatch-false-terminal",
  "stale-quota-reset-refresh",
  "predecessor-successor-overlap",
  "stale-verifier-not-product-failure",
  "crash-after-external-mutation-before-receipt",
  "telegram-duplicate-update-boundary",
  "steering-persisted-before-ack",
  "authorization-drift-after-claim",
  "passive-defer-vs-action-required",
  "alert-resolution-without-stable-health",
  "planner-completion-without-successor",
  "repository-aware-ownership",
  "child-rc1-after-partial-progress",
  "operator-allowlist-rejection",
  "pause-resume-safe-boundary",
  "cancel-interrupt-proven-process-group",
  "intake-auth-and-bounds-rejection",
  "intake-duplicate-delivery-replay",
  "monitoring-silence-not-health",
  "report-crash-before-receipt-finish",
] as const;

describe("ops-worker batched fake fault lab", () => {
  it("runs the exact deterministic ADR-099 matrix without external network activity", async () => {
    assert.deepEqual(OPS_WORKER_FAULT_LAB_SCENARIO_NAMES, EXPECTED_SCENARIOS);

    const firstSafety: OpsWorkerFaultLabSafetyEvent[] = [];
    const secondSafety: OpsWorkerFaultLabSafetyEvent[] = [];
    const first = await runOpsWorkerFaultLab((event) => firstSafety.push(event));
    const second = await runOpsWorkerFaultLab((event) => secondSafety.push(event));

    assert.deepEqual(first, second);
    assert.equal(first.labVersion, 1);
    assert.deepEqual(first.scenarios.map((scenario) => scenario.name), EXPECTED_SCENARIOS);
    assert.equal(first.scenarios.every((scenario) => scenario.outcome === "PASS"), true);
    assert.deepEqual(first.failures, []);
    assert.equal(first.pass, true);

    for (const safety of [firstSafety, secondSafety]) {
      assert.equal(
        safety.some((event) => event.kind === "fetch-passthrough"),
        false,
      );
      assert.equal(
        safety.filter((event) => event.kind === "fetch-fake").length > 0,
        true,
      );
      assert.equal(
        safety
          .filter((event) => event.kind === "socket-bind")
          .every((event) => event.host === "127.0.0.1" || event.host === "::1"),
        true,
      );
    }
  });
});
