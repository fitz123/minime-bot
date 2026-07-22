import type { OpsWorkerTask } from "./types.js";

const TRUNCATION_MARKER = "… [truncated]";
const REDACTED = "[REDACTED]";

export const OPS_WORKER_REPORT_FIELD_LIMITS = Object.freeze({
  agentSummaryBytes: 1024,
  agentActionBytes: 512,
  agentActions: 8,
  requestedInputBytes: 1024,
  verifierSummaryBytes: 512,
  verifierComponents: 8,
});

export type OpsWorkerFieldRedactor = (value: string, maxBytes: number) => string;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const contentLimit = Math.max(0, maxBytes - markerBytes);
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > contentLimit) break;
    result += character;
  }
  return `${result}${TRUNCATION_MARKER}`;
}

function replaceExact(value: string, sensitive: readonly string[]): string {
  let redacted = value;
  for (const secret of sensitive) redacted = redacted.split(secret).join(REDACTED);
  return redacted;
}

/** Shared sanitizer for every agent-authored field before it enters a report. */
export function createOpsWorkerFieldRedactor(
  configuredSensitiveValues: readonly string[] = [],
): OpsWorkerFieldRedactor {
  const sensitive = [...new Set(configuredSensitiveValues.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  return (value, maxBytes) => {
    let result = replaceExact(value, sensitive);
    result = result
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
      .replace(/([?&](?:access[_-]?token|api[_-]?key|auth|authorization|credential|password|secret|signature|token)=)[^&#\s]*/gi, `$1${REDACTED}`)
      .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
      .replace(/\b((?:access[_-]?token|api[_-]?key|authorization|credential|password|passwd|secret|token)\s*[:=]\s*)[^\s,;]+/gi, `$1${REDACTED}`)
      .replace(/\/(?:Users|home)\/[^/\s]+(?:\/[^\s]*)?/g, "[REDACTED_HOME_PATH]")
      .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, REDACTED)
      .replace(/[ \t]+/g, " ")
      .trim();
    return truncateUtf8(result, maxBytes);
  };
}

export function buildOpsWorkerTelegramReport(
  task: Readonly<OpsWorkerTask>,
  options: {
    redact: OpsWorkerFieldRedactor;
    maxBytes: number;
  },
): string {
  const lines = [
    `Ops incident: ${task.id}`,
    `identity=${task.source.kind}/${task.source.template} correlation=${task.source.correlationKey}`,
    `state=${task.state}`,
  ];
  const result = task.agentResult;
  if (result === null) {
    lines.push(
      task.lastOutcome === null
        ? "typedOutcome=unavailable"
        : `typedOutcome=unavailable (${task.lastOutcome.kind}/${task.lastOutcome.result})`,
    );
    if (task.lastOutcome !== null) {
      lines.push(`outcome=${task.lastOutcome.summary}`);
    }
  } else {
    lines.push(`typedOutcome=${result.kind} reason=${result.reason ?? "none"}`);
    lines.push(
      `diagnosis=${options.redact(
        result.summary,
        OPS_WORKER_REPORT_FIELD_LIMITS.agentSummaryBytes,
      )}`,
    );
    if (result.actions.length === 0) {
      lines.push("actions=none");
    } else {
      lines.push("actions:");
      for (const action of result.actions.slice(0, OPS_WORKER_REPORT_FIELD_LIMITS.agentActions)) {
        lines.push(
          `- ${options.redact(action, OPS_WORKER_REPORT_FIELD_LIMITS.agentActionBytes)}`,
        );
      }
      if (result.actions.length > OPS_WORKER_REPORT_FIELD_LIMITS.agentActions) {
        lines.push("- … [additional actions omitted]");
      }
    }
    if (task.state === "BLOCKED" && result.requestedInput !== null) {
      lines.push(
        `requestedInput=${options.redact(
          result.requestedInput,
          OPS_WORKER_REPORT_FIELD_LIMITS.requestedInputBytes,
        )}`,
      );
    }
  }

  if (task.verification === null) {
    lines.push("verification=not-run");
  } else {
    lines.push(`verification=${task.verification.outcome}`);
    for (const component of task.verification.components.slice(
      0,
      OPS_WORKER_REPORT_FIELD_LIMITS.verifierComponents,
    )) {
      lines.push(
        `- ${component.identity}/${component.outcome}: ${truncateUtf8(
          component.summary,
          OPS_WORKER_REPORT_FIELD_LIMITS.verifierSummaryBytes,
        )}`,
      );
    }
  }
  lines.push(`checkedAt=${task.verification?.checkedAt ?? task.lastOutcome?.at ?? task.updatedAt}`);
  return truncateUtf8(lines.join("\n"), options.maxBytes);
}
