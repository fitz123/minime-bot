import {
  OPS_WORKER_LIMITS,
  type OpsWorkerEvidence,
  type OpsWorkerTask,
} from "./types.js";

function isProtectedAlertmanagerCorrelationEvidence(
  task: Readonly<OpsWorkerTask>,
  evidence: Readonly<OpsWorkerEvidence>,
): boolean {
  if (task.source.kind !== "alertmanager" || evidence.kind !== "alert") return false;
  try {
    const value = JSON.parse(evidence.summary) as unknown;
    return typeof value === "object"
      && value !== null
      && !Array.isArray(value)
      && (value as { type?: unknown }).type === "alertmanager-group-correlation-v1"
      && (value as { correlationKey?: unknown }).correlationKey
        === task.source.correlationKey;
  } catch {
    return false;
  }
}

/** Append bounded runtime evidence without evicting the exact alert-group descriptor. */
export function appendOpsWorkerEvidence(
  task: OpsWorkerTask,
  evidence: OpsWorkerEvidence,
): void {
  const entries = [...task.evidence, evidence];
  while (entries.length > OPS_WORKER_LIMITS.maxEvidenceEntries) {
    const evictable = entries.findIndex((entry) =>
      !isProtectedAlertmanagerCorrelationEvidence(task, entry));
    entries.splice(evictable < 0 ? 0 : evictable, 1);
  }
  task.evidence = entries;
}
