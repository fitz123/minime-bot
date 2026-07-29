import { createHash } from "node:crypto";
import {
  OPS_WORKER_LIMITS,
  OPS_WORKER_OUTCOME_KINDS,
  OPS_WORKER_OUTCOME_RESULTS,
  OPS_WORKER_TASK_STATES,
  type OpsWorkerEvidence,
  type OpsWorkerTask,
} from "./types.js";

const REPORT_RECONCILIATION_INTENT_EVIDENCE_TYPE =
  "ops-worker-report-reconciliation-intent-v1";
const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function canonicalReportReconciliationIntent(
  value: unknown,
): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const intent = value as Record<string, unknown>;
  if (
    hasExactKeys(intent, ["reportIdentity", "reportPayloadHash"])
    && typeof intent.reportIdentity === "string"
    && SHA256_DIGEST_PATTERN.test(intent.reportIdentity)
    && typeof intent.reportPayloadHash === "string"
    && SHA256_DIGEST_PATTERN.test(intent.reportPayloadHash)
  ) {
    return JSON.stringify({
      reportIdentity: intent.reportIdentity,
      reportPayloadHash: intent.reportPayloadHash,
    });
  }
  if (
    !hasExactKeys(intent, ["reportIdentity", "taskState", "lastOutcome"])
    || typeof intent.reportIdentity !== "string"
    || !SHA256_DIGEST_PATTERN.test(intent.reportIdentity)
    || typeof intent.taskState !== "string"
    || !(OPS_WORKER_TASK_STATES as readonly string[]).includes(intent.taskState)
  ) return undefined;
  if (intent.lastOutcome === null) {
    return JSON.stringify({
      lastOutcome: null,
      reportIdentity: intent.reportIdentity,
      taskState: intent.taskState,
    });
  }
  if (
    typeof intent.lastOutcome !== "object"
    || Array.isArray(intent.lastOutcome)
  ) return undefined;
  const outcome = intent.lastOutcome as Record<string, unknown>;
  if (
    !hasExactKeys(outcome, ["at", "kind", "result", "summary"])
    || typeof outcome.at !== "string"
    || typeof outcome.kind !== "string"
    || !(OPS_WORKER_OUTCOME_KINDS as readonly string[]).includes(outcome.kind)
    || typeof outcome.result !== "string"
    || !(OPS_WORKER_OUTCOME_RESULTS as readonly string[]).includes(outcome.result)
    || typeof outcome.summary !== "string"
  ) return undefined;
  return JSON.stringify({
    lastOutcome: {
      at: outcome.at,
      kind: outcome.kind,
      result: outcome.result,
      summary: outcome.summary,
    },
    reportIdentity: intent.reportIdentity,
    taskState: intent.taskState,
  });
}

function isProtectedAlertmanagerEvidence(
  task: Readonly<OpsWorkerTask>,
  evidence: Readonly<OpsWorkerEvidence>,
): boolean {
  if (task.source.kind !== "alertmanager") return false;
  try {
    const value = JSON.parse(evidence.summary) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const typed = value as {
      type?: unknown;
      correlationKey?: unknown;
      deliveryKey?: unknown;
      submissionFingerprint?: unknown;
    };
    return (
      evidence.kind === "alert"
      && typed.type === "alertmanager-group-correlation-v1"
      && typed.correlationKey === task.source.correlationKey
    ) || (
      evidence.kind === "system"
      && evidence.trust === "trusted"
      && typed.type === "alertmanager-delivery-receipt-v1"
      && typeof typed.deliveryKey === "string"
      && typeof typed.submissionFingerprint === "string"
    ) || (
      evidence.kind === "system"
      && evidence.trust === "trusted"
      && typed.type === "alertmanager-firing-observation-v1"
      && typed.correlationKey === task.source.correlationKey
      && typeof typed.deliveryKey === "string"
    );
  } catch {
    return false;
  }
}

function isProtectedReportReconciliationIntent(
  task: Readonly<OpsWorkerTask>,
  evidence: Readonly<OpsWorkerEvidence>,
): boolean {
  const receipt = task.mutationReceipts.report;
  if (
    receipt === null
    || receipt.outcome !== null
    || evidence.kind !== "system"
    || evidence.trust !== "trusted"
  ) return false;
  try {
    const value = JSON.parse(evidence.summary) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const marker = value as {
      type?: unknown;
      operationId?: unknown;
      intentHash?: unknown;
      intent?: unknown;
    };
    if (
      !hasExactKeys(marker, ["type", "operationId", "intentHash", "intent"])
      || marker.type !== REPORT_RECONCILIATION_INTENT_EVIDENCE_TYPE
      || marker.operationId !== receipt.operationId
      || marker.intentHash !== receipt.intentHash
      || typeof marker.intentHash !== "string"
      || !SHA256_DIGEST_PATTERN.test(marker.intentHash)
    ) return false;
    const canonicalIntent = canonicalReportReconciliationIntent(marker.intent);
    if (canonicalIntent === undefined) return false;
    const intentHash = `sha256:${createHash("sha256")
      .update(canonicalIntent)
      .digest("hex")}`;
    return intentHash === receipt.intentHash;
  } catch {
    return false;
  }
}

function isProtectedEvidence(
  task: Readonly<OpsWorkerTask>,
  evidence: Readonly<OpsWorkerEvidence>,
): boolean {
  return isProtectedAlertmanagerEvidence(task, evidence)
    || isProtectedReportReconciliationIntent(task, evidence);
}

function serializedTaskBytes(task: Readonly<OpsWorkerTask>): number {
  return Buffer.byteLength(`${JSON.stringify(task)}\n`, "utf8");
}

/** Append bounded runtime evidence without evicting the exact alert-group descriptor. */
export function appendOpsWorkerEvidence(
  task: OpsWorkerTask,
  evidence: OpsWorkerEvidence,
): void {
  const entries = [...task.evidence, evidence];
  while (entries.length > OPS_WORKER_LIMITS.maxEvidenceEntries) {
    const evictable = entries.findIndex((entry) =>
      !isProtectedEvidence(task, entry));
    if (evictable < 0) {
      throw new RangeError("Ops-worker evidence has no evictable entry capacity");
    }
    entries.splice(evictable, 1);
  }
  task.evidence = entries;
}

/** Evict oldest non-essential runtime evidence until the snapshot fits its durable bound. */
export function compactOpsWorkerEvidenceForSnapshot(task: OpsWorkerTask): void {
  while (serializedTaskBytes(task) > OPS_WORKER_LIMITS.maxSnapshotBytes) {
    const evictable = task.evidence.findIndex((entry) =>
      !isProtectedEvidence(task, entry));
    if (evictable < 0) return;
    task.evidence.splice(evictable, 1);
  }
}
