import {
  OPS_WORKER_LIMITS,
  type OpsWorkerEvidence,
  type OpsWorkerTask,
} from "./types.js";

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
      !isProtectedAlertmanagerEvidence(task, entry));
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
      !isProtectedAlertmanagerEvidence(task, entry));
    if (evictable < 0) return;
    task.evidence.splice(evictable, 1);
  }
}
