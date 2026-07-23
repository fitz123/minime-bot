import type { OpsWorkerTask } from "./types.js";

const TRUNCATION_MARKER = "… [truncated]";
const REDACTED = "[REDACTED]";

export const OPS_WORKER_REPORT_FIELD_LIMITS = Object.freeze({
  sourceIdentityBytes: 512,
  incidentIdentityBytes: 1024,
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
      .replace(/(?<![A-Za-z0-9._~+/:-])(?=[A-Za-z0-9._~+/=:-]{32,}(?![A-Za-z0-9._~+/=:-]))[A-Za-z0-9._~+/:-]+={0,2}(?![A-Za-z0-9._~+/=:-])/g, REDACTED)
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

function plainStringMap(value: unknown): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.some(([key, entry]) => key.length === 0 || typeof entry !== "string")) {
    return null;
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function alertmanagerIncidentIdentity(task: Readonly<OpsWorkerTask>): string | null {
  if (task.source.kind !== "alertmanager" || !Array.isArray(task.evidence)) return null;
  let groupLabels: Record<string, string> | null = null;
  const alertNames = new Set<string>();
  const episodeStarts: string[] = [];
  for (const evidence of task.evidence) {
    if (evidence.kind !== "alert") continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(evidence.summary) as unknown;
    } catch {
      continue;
    }
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) continue;
    const record = decoded as Record<string, unknown>;
    if (
      record.type === "alertmanager-group-correlation-v1"
      && record.correlationKey === task.source.correlationKey
    ) {
      groupLabels = plainStringMap(record.groupLabels);
      continue;
    }
    if (record.status !== "firing" || typeof record.startsAt !== "string") continue;
    const labels = plainStringMap(record.labels);
    if (labels === null) continue;
    if (typeof labels.alertname === "string" && labels.alertname.length > 0) {
      alertNames.add(labels.alertname);
    }
    if (Number.isFinite(Date.parse(record.startsAt))) episodeStarts.push(record.startsAt);
  }
  if (groupLabels === null) return null;
  const canonicalGroup = Object.fromEntries(
    Object.entries(groupLabels).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
  return [
    `alertname=${[...alertNames].sort().join(",") || "unknown"}`,
    `groupLabels=${JSON.stringify(canonicalGroup)}`,
    `episodeStart=${episodeStarts.sort()[0] ?? "unknown"}`,
  ].join(" ");
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
      value: options.redact(
        `${task.source.kind}/${task.source.template} correlation=${task.source.correlationKey}`,
        OPS_WORKER_REPORT_FIELD_LIMITS.sourceIdentityBytes,
      ),
      minimum: "…",
    },
    { prefix: "state=", value: task.state, minimum: task.state },
  ];
  const incidentIdentity = alertmanagerIncidentIdentity(task);
  if (incidentIdentity !== null) {
    lines.splice(2, 0, {
      prefix: "incident=",
      value: options.redact(
        incidentIdentity,
        OPS_WORKER_REPORT_FIELD_LIMITS.incidentIdentityBytes,
      ),
      minimum: "…",
    });
  }
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
