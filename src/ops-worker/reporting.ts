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
  const marker = maxBytes >= Buffer.byteLength(TRUNCATION_MARKER, "utf8")
    ? TRUNCATION_MARKER
    : "…";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const contentLimit = Math.max(0, maxBytes - markerBytes);
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > contentLimit) break;
    result += character;
  }
  return `${result}${marker}`;
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
      .replace(/\b((?:access[_-]?token|api[_-]?key|authorization|credential|password|passwd|secret|token)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, `$1${REDACTED}`)
      .replace(/\b(authorization\s*[:=]\s*)(?:basic|bearer|digest|token)\s+[^\s,;]+/gi, `$1${REDACTED}`)
      .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
      .replace(/\b((?:access[_-]?token|api[_-]?key|authorization|credential|password|passwd|secret|token)\s*[:=]\s*)(?:\\[^\r\n]|[^\s,;])+/gi, `$1${REDACTED}`)
      .replace(/\/(?:Users|home)\/[^/\s]+(?:\/[^\s]*)?/g, "[REDACTED_HOME_PATH]")
      .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, REDACTED)
      .replace(/[ \t]+/g, " ")
      .trim();
    return truncateUtf8(result, maxBytes);
  };
}

interface ReportLine {
  prefix: string;
  value: string;
  minimum: string;
}

function fitReportLines(lines: readonly ReportLine[], maxBytes: number): string {
  const newlineBytes = Math.max(0, lines.length - 1);
  const minimumBytes = lines.reduce(
    (total, line) => total + Buffer.byteLength(line.prefix + line.minimum, "utf8"),
    newlineBytes,
  );
  if (minimumBytes > maxBytes) {
    return truncateUtf8(
      lines.map((line) => `${line.prefix}${line.minimum}`).join("\n"),
      maxBytes,
    );
  }
  let remaining = maxBytes - minimumBytes;
  const desired = lines.map((line) => Math.max(
    0,
    Buffer.byteLength(line.value, "utf8") - Buffer.byteLength(line.minimum, "utf8"),
  ));
  const allocated = desired.map(() => 0);
  let pending = desired
    .map((bytes, index) => ({ bytes, index }))
    .filter(({ bytes }) => bytes > 0);
  while (remaining > 0 && pending.length > 0) {
    const share = Math.max(1, Math.floor(remaining / pending.length));
    for (const entry of pending) {
      if (remaining === 0) break;
      const granted = Math.min(
        share,
        entry.bytes - allocated[entry.index],
        remaining,
      );
      allocated[entry.index] += granted;
      remaining -= granted;
    }
    pending = pending.filter(({ bytes, index }) => allocated[index] < bytes);
  }
  return lines.map((line, index) => {
    if (desired[index] === 0) return `${line.prefix}${line.value}`;
    if (allocated[index] === 0) return `${line.prefix}${line.minimum}`;
    const budget = Buffer.byteLength(line.minimum, "utf8") + allocated[index];
    return `${line.prefix}${truncateUtf8(line.value, budget)}`;
  }).join("\n");
}

export function buildOpsWorkerTelegramReport(
  task: Readonly<OpsWorkerTask>,
  options: {
    redact: OpsWorkerFieldRedactor;
    maxBytes: number;
  },
): string {
  const lines: ReportLine[] = [
    { prefix: "Ops incident: ", value: task.id, minimum: "…" },
    {
      prefix: "identity=",
      value: `${task.source.kind}/${task.source.template} correlation=${task.source.correlationKey}`,
      minimum: "…",
    },
    { prefix: "state=", value: task.state, minimum: task.state },
  ];
  const result = task.agentResult;
  if (result === null) {
    lines.push(
      {
        prefix: "typedOutcome=",
        value: task.lastOutcome === null
          ? "unavailable"
          : `unavailable (${task.lastOutcome.kind}/${task.lastOutcome.result})`,
        minimum: "unavailable",
      },
    );
    if (task.lastOutcome !== null) {
      lines.push({
        prefix: "outcome=",
        value: options.redact(
          task.lastOutcome.summary,
          OPS_WORKER_REPORT_FIELD_LIMITS.agentSummaryBytes,
        ),
        minimum: "…",
      });
    }
  } else {
    lines.push({
      prefix: "typedOutcome=",
      value: `${result.kind} reason=${result.reason ?? "none"}`,
      minimum: `${result.kind} reason=${result.reason ?? "none"}`,
    });
    lines.push({
      prefix: "diagnosis=",
      value: options.redact(
        result.summary,
        OPS_WORKER_REPORT_FIELD_LIMITS.agentSummaryBytes,
      ),
      minimum: "…",
    });
    if (result.actions.length === 0) {
      lines.push({ prefix: "actions=", value: "none", minimum: "none" });
    } else {
      const actions = result.actions
        .slice(0, OPS_WORKER_REPORT_FIELD_LIMITS.agentActions)
        .map((action) => options.redact(
          action,
          OPS_WORKER_REPORT_FIELD_LIMITS.agentActionBytes,
        ));
      if (result.actions.length > OPS_WORKER_REPORT_FIELD_LIMITS.agentActions) {
        actions.push("… [additional actions omitted]");
      }
      lines.push({
        prefix: "actions=",
        value: actions.join(" | "),
        minimum: `… (${result.actions.length} reported)`,
      });
    }
    if (task.state === "BLOCKED" && result.requestedInput !== null) {
      lines.push({
        prefix: "requestedInput=",
        value: options.redact(
          result.requestedInput,
          OPS_WORKER_REPORT_FIELD_LIMITS.requestedInputBytes,
        ),
        minimum: "…",
      });
    }
  }

  if (task.verification === null) {
    lines.push({ prefix: "verification=", value: "not-run", minimum: "not-run" });
  } else {
    lines.push({
      prefix: "verification=",
      value: task.verification.outcome,
      minimum: task.verification.outcome,
    });
    const components = task.verification.components.slice(
      0,
      OPS_WORKER_REPORT_FIELD_LIMITS.verifierComponents,
    ).map((component) =>
      `${component.identity}/${component.outcome}: ${truncateUtf8(
          component.summary,
          OPS_WORKER_REPORT_FIELD_LIMITS.verifierSummaryBytes,
        )}`);
    lines.push({
      prefix: "components=",
      value: components.length === 0 ? "none" : components.join(" | "),
      minimum: components.length === 0 ? "none" : `… (${components.length} reported)`,
    });
  }
  const checkedAt = task.verification?.checkedAt ?? task.lastOutcome?.at ?? task.updatedAt;
  lines.push({ prefix: "checkedAt=", value: checkedAt, minimum: checkedAt });
  return fitReportLines(lines, options.maxBytes);
}
