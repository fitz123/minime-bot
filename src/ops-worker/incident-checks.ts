import { createHash } from "node:crypto";
import {
  OpsWorkerDoneCheckRegistry,
  type OpsWorkerDoneCheckContext,
  type OpsWorkerDoneCheckDefinition,
} from "./done-checks.js";
import type {
  JsonObject,
  OpsWorkerEvidence,
  OpsWorkerSourceKind,
  OpsWorkerVerificationOutcome,
} from "./types.js";

export const OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME =
  "ops.alertmanager-incident" as const;
export const OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_VERSION = "1" as const;

export const OPS_INCIDENT_CHECK_LIMITS = Object.freeze({
  componentTimeoutMs: 5_000,
  observationFreshnessMs: 60_000,
  monitoringFreshnessMs: 2 * 60_000,
  stabilityWindowMs: 5 * 60_000,
  recheckMs: 60_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxAlertCount: 1_024,
  maxAlertFields: 24,
  maxAlertLabels: 64,
  maxLabelBytes: 2 * 1024,
  maxPrometheusSeries: 1,
  maxPrometheusSamplesPerSeries: 64,
} as const);

export interface OpsIncidentReaderContext {
  signal: AbortSignal;
  taskId: string;
  sourceKind?: OpsWorkerSourceKind;
  sourceCorrelationKey?: string;
  sourceEvidence?: readonly OpsWorkerEvidence[];
}

export interface OpsIncidentMonitoringFreshnessReading {
  observedAt: string;
  latestSampleAt: string | null;
}

export interface OpsIncidentAlertStateReading {
  observedAt: string;
  status: "PRESENT" | "ABSENT";
}

export interface OpsIncidentResolutionStabilityReading {
  observedAt: string;
  latestMatchingSampleAt: string | null;
  monitoringWindowStartedAt: string | null;
}

export interface OpsIncidentMonitoringReader {
  readMonitoringFreshness(
    context: OpsIncidentReaderContext,
  ): OpsIncidentMonitoringFreshnessReading
    | Promise<OpsIncidentMonitoringFreshnessReading>;
  readResolutionStability(
    context: OpsIncidentReaderContext,
  ): OpsIncidentResolutionStabilityReading
    | Promise<OpsIncidentResolutionStabilityReading>;
}

export interface OpsIncidentAlertmanagerReader {
  readExactGroupState(
    context: OpsIncidentReaderContext,
  ): OpsIncidentAlertStateReading | Promise<OpsIncidentAlertStateReading>;
}

export interface OpsIncidentDoneCheckDependencies {
  incidentMonitoringReader: OpsIncidentMonitoringReader;
  incidentAlertmanagerReader: OpsIncidentAlertmanagerReader;
  clock: () => Date;
}

interface ComponentResult {
  result: OpsWorkerVerificationOutcome;
  summary: string;
  observedAt: string;
  evidenceHash: string;
  nextCheckAt?: string;
}

export type OpsIncidentFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const PROMETHEUS_UP_RANGE_QUERY = "(max(timestamp(up)))[2m:5s]";
const PROMETHEUS_UP_STABILITY_COVERAGE_QUERY = "(max(timestamp(up)))[5m:5s]";
const PROMETHEUS_SUBQUERY_STEP_MS = 5_000;
const PROMETHEUS_LABEL_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const STABILITY_WAIT_SUMMARY =
  "The exact alert group has not yet been absent with five minutes of monitoring coverage.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  if (
    Object.keys(value).length !== expected.length
    || expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !expected.includes(key))
  ) return false;
  return expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const canonical = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  try {
    return new Date(value).toISOString() === canonical;
  } catch {
    return false;
  }
}

function hashEvidence(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function componentObservedAt(clock: () => Date, checkedAt: string): string {
  const current = clock();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
    throw new TypeError("Incident done-check clock returned an invalid date");
  }
  return new Date(Math.max(current.getTime(), Date.parse(checkedAt))).toISOString();
}

function scheduledAt(observedAt: string, delayMs = OPS_INCIDENT_CHECK_LIMITS.recheckMs): string {
  return new Date(Date.parse(observedAt) + delayMs).toISOString();
}

function componentResult(
  outcome: OpsWorkerVerificationOutcome,
  summary: string,
  observedAt: string,
  evidence: unknown,
  nextCheckAt?: string,
): ComponentResult {
  return {
    result: outcome,
    summary,
    observedAt,
    evidenceHash: hashEvidence(evidence),
    ...(nextCheckAt === undefined ? {} : { nextCheckAt }),
  };
}

function invalidReaderResult(): unknown {
  return Object.freeze({ invalidReaderOutput: true });
}

function parseFreshnessReading(
  raw: unknown,
): OpsIncidentMonitoringFreshnessReading | null {
  if (!isPlainObject(raw) || !hasExactDataKeys(raw, ["observedAt", "latestSampleAt"])) {
    return null;
  }
  if (
    !validTimestamp(raw.observedAt)
    || (raw.latestSampleAt !== null && !validTimestamp(raw.latestSampleAt))
  ) return null;
  return { observedAt: raw.observedAt, latestSampleAt: raw.latestSampleAt };
}

function parseAlertStateReading(raw: unknown): OpsIncidentAlertStateReading | null {
  if (!isPlainObject(raw) || !hasExactDataKeys(raw, ["observedAt", "status"])) {
    return null;
  }
  if (
    !validTimestamp(raw.observedAt)
    || (raw.status !== "PRESENT" && raw.status !== "ABSENT")
  ) return null;
  return { observedAt: raw.observedAt, status: raw.status };
}

function parseStabilityReading(
  raw: unknown,
): OpsIncidentResolutionStabilityReading | null {
  if (
    !isPlainObject(raw)
    || !hasExactDataKeys(
      raw,
      ["observedAt", "latestMatchingSampleAt", "monitoringWindowStartedAt"],
    )
    || !validTimestamp(raw.observedAt)
    || (
      raw.latestMatchingSampleAt !== null
      && !validTimestamp(raw.latestMatchingSampleAt)
    )
    || (
      raw.monitoringWindowStartedAt !== null
      && !validTimestamp(raw.monitoringWindowStartedAt)
    )
  ) return null;
  return {
    observedAt: raw.observedAt,
    latestMatchingSampleAt: raw.latestMatchingSampleAt,
    monitoringWindowStartedAt: raw.monitoringWindowStartedAt,
  };
}

function isFresh(timestamp: string, now: string, boundMs: number): boolean {
  const age = Date.parse(now) - Date.parse(timestamp);
  return age >= 0 && age <= boundMs;
}

function readerContext(context: OpsWorkerDoneCheckContext): OpsIncidentReaderContext {
  return {
    signal: context.signal,
    taskId: context.taskId,
    sourceKind: context.sourceKind,
    sourceCorrelationKey: context.sourceCorrelationKey,
    sourceEvidence: context.sourceEvidence,
  };
}

function previousAbsenceWindowReadyAt(
  context: OpsWorkerDoneCheckContext,
): number | null {
  const previous = context.previousVerification;
  if (
    previous === undefined
    || previous.verifierIdentity !== OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME
    || previous.verifierVersion !== OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_VERSION
    || previous.outcome !== "NOT_READY"
  ) return null;
  const absence = previous.components.find(
    (component) => component.identity === "exact-group-absence",
  );
  const stability = previous.components.find(
    (component) => component.identity === "resolution-stability",
  );
  if (
    absence?.outcome !== "PASS"
    || stability?.outcome !== "NOT_READY"
    || stability.summary !== STABILITY_WAIT_SUMMARY
    || stability.nextCheckAt === null
  ) return null;
  return Date.parse(stability.nextCheckAt);
}

function validateParams(value: unknown): JsonObject {
  if (!isPlainObject(value) || !hasExactDataKeys(value, [])) {
    throw new TypeError("Alertmanager incident parameters must be an empty object");
  }
  return {};
}

function assertDependencies(deps: OpsIncidentDoneCheckDependencies): void {
  if (
    !deps
    || typeof deps.clock !== "function"
    || typeof deps.incidentMonitoringReader?.readMonitoringFreshness !== "function"
    || typeof deps.incidentMonitoringReader?.readResolutionStability !== "function"
    || typeof deps.incidentAlertmanagerReader?.readExactGroupState !== "function"
  ) throw new TypeError("Incident done check requires all trusted read-only dependencies");
}

export function createOpsIncidentDoneCheckDefinition(
  deps: OpsIncidentDoneCheckDependencies,
): OpsWorkerDoneCheckDefinition {
  assertDependencies(deps);
  return {
    identity: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME,
    version: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_VERSION,
    validateParams,
    components: [
      {
        identity: "monitoring-freshness",
        version: "1",
        required: true,
        convergence: "PRODUCT",
        timeoutMs: OPS_INCIDENT_CHECK_LIMITS.componentTimeoutMs,
        async run(_params, context): Promise<unknown> {
          const raw = await deps.incidentMonitoringReader.readMonitoringFreshness(
            readerContext(context),
          );
          const reading = parseFreshnessReading(raw);
          if (!reading) return invalidReaderResult();
          const observedAt = componentObservedAt(deps.clock, context.checkedAt);
          if (
            Date.parse(reading.observedAt) > Date.parse(observedAt)
            || (
              reading.latestSampleAt !== null
              && Date.parse(reading.latestSampleAt) > Date.parse(reading.observedAt)
            )
          ) return invalidReaderResult();
          if (
            !isFresh(
              reading.observedAt,
              observedAt,
              OPS_INCIDENT_CHECK_LIMITS.observationFreshnessMs,
            )
            || reading.latestSampleAt === null
            || !isFresh(
              reading.latestSampleAt,
              observedAt,
              OPS_INCIDENT_CHECK_LIMITS.monitoringFreshnessMs,
            )
          ) {
            return componentResult(
              "NOT_READY",
              "Prometheus telemetry is missing or outside the trusted freshness bound.",
              observedAt,
              reading,
              scheduledAt(observedAt),
            );
          }
          return componentResult(
            "PASS",
            "Prometheus telemetry is fresh within the trusted bound.",
            observedAt,
            reading,
          );
        },
      },
      {
        identity: "exact-group-absence",
        version: "1",
        required: true,
        convergence: "PRODUCT",
        timeoutMs: OPS_INCIDENT_CHECK_LIMITS.componentTimeoutMs,
        async run(_params, context): Promise<unknown> {
          const raw = await deps.incidentAlertmanagerReader.readExactGroupState(
            readerContext(context),
          );
          const reading = parseAlertStateReading(raw);
          if (!reading) return invalidReaderResult();
          const observedAt = componentObservedAt(deps.clock, context.checkedAt);
          if (Date.parse(reading.observedAt) > Date.parse(observedAt)) {
            return invalidReaderResult();
          }
          if (!isFresh(
            reading.observedAt,
            observedAt,
            OPS_INCIDENT_CHECK_LIMITS.observationFreshnessMs,
          )) {
            return componentResult(
              "NOT_READY",
              "Alertmanager state lacks a fresh trusted observation.",
              observedAt,
              reading,
              scheduledAt(observedAt),
            );
          }
          if (reading.status === "PRESENT") {
            return componentResult(
              "PRODUCT_FAILURE",
              "The exact Alertmanager group is still present after the agent claim.",
              observedAt,
              reading,
            );
          }
          return componentResult(
            "PASS",
            "The exact Alertmanager group is absent in every queried state.",
            observedAt,
            reading,
          );
        },
      },
      {
        identity: "resolution-stability",
        version: "1",
        required: true,
        convergence: "PRODUCT",
        timeoutMs: OPS_INCIDENT_CHECK_LIMITS.componentTimeoutMs,
        async run(_params, context): Promise<unknown> {
          const raw = await deps.incidentMonitoringReader.readResolutionStability(
            readerContext(context),
          );
          const reading = parseStabilityReading(raw);
          if (!reading) return invalidReaderResult();
          const observedAt = componentObservedAt(deps.clock, context.checkedAt);
          if (
            Date.parse(reading.observedAt) > Date.parse(observedAt)
            || (
              reading.latestMatchingSampleAt !== null
              && Date.parse(reading.latestMatchingSampleAt) > Date.parse(reading.observedAt)
            )
            || (
              reading.monitoringWindowStartedAt !== null
              && Date.parse(reading.monitoringWindowStartedAt) > Date.parse(reading.observedAt)
            )
          ) return invalidReaderResult();
          if (!isFresh(
            reading.observedAt,
            observedAt,
            OPS_INCIDENT_CHECK_LIMITS.observationFreshnessMs,
          )) {
            return componentResult(
              "NOT_READY",
              "Prometheus stability evidence lacks a fresh trusted observation.",
              observedAt,
              reading,
              scheduledAt(observedAt),
            );
          }
          const priorAbsenceReadyAt = previousAbsenceWindowReadyAt(context);
          const readyAt = Math.max(
            reading.monitoringWindowStartedAt === null
              ? Date.parse(scheduledAt(observedAt))
              : Date.parse(reading.monitoringWindowStartedAt)
                + OPS_INCIDENT_CHECK_LIMITS.stabilityWindowMs,
            reading.latestMatchingSampleAt === null
              ? priorAbsenceReadyAt
                ?? Date.parse(observedAt) + OPS_INCIDENT_CHECK_LIMITS.stabilityWindowMs
              : Date.parse(reading.latestMatchingSampleAt)
                + OPS_INCIDENT_CHECK_LIMITS.stabilityWindowMs,
          );
          if (
            reading.monitoringWindowStartedAt === null
            || readyAt > Date.parse(observedAt)
          ) {
            return componentResult(
              "NOT_READY",
              reading.monitoringWindowStartedAt === null
                ? "Prometheus lacks monitoring history for the five-minute stability window."
                : STABILITY_WAIT_SUMMARY,
              observedAt,
              reading,
              new Date(readyAt).toISOString(),
            );
          }
          return componentResult(
            "PASS",
            reading.latestMatchingSampleAt === null && priorAbsenceReadyAt !== null
              ? "The durable exact-group absence window elapsed with complete monitoring coverage and no matching local samples."
              : "Prometheus has no pending or firing sample for the exact group in five minutes.",
            observedAt,
            reading,
          );
        },
      },
    ],
  };
}

export function createOpsIncidentDoneCheckRegistry(
  deps: OpsIncidentDoneCheckDependencies,
): OpsWorkerDoneCheckRegistry {
  return new OpsWorkerDoneCheckRegistry({
    [OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME]:
      createOpsIncidentDoneCheckDefinition(deps),
  });
}

function normalizeLoopbackBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError("Incident monitoring reader requires a loopback HTTP base URL");
  }
  const hostname = parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
    ? parsed.hostname.slice(1, -1)
    : parsed.hostname;
  if (
    parsed.protocol !== "http:"
    || !LOOPBACK_HOSTS.has(hostname)
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || (parsed.pathname !== "/" && parsed.pathname !== "")
  ) throw new TypeError("Incident monitoring reader requires a loopback HTTP base URL");
  parsed.pathname = "/";
  return parsed;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("Incident monitoring query returned a non-success status");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new Error("Incident monitoring response must be application/json");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsed)
      || parsed < 0
      || parsed > OPS_INCIDENT_CHECK_LIMITS.maxResponseBytes
    ) throw new Error("Incident monitoring response exceeds its byte bound");
  }
  if (!response.body) throw new Error("Incident monitoring response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > OPS_INCIDENT_CHECK_LIMITS.maxResponseBytes) {
      await reader.cancel();
      throw new Error("Incident monitoring response exceeds its byte bound");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new Error("Incident monitoring response is not bounded valid JSON");
  }
}

function assertBoundedLabelMap(value: unknown): asserts value is Record<string, string> {
  if (!isPlainObject(value) || Object.keys(value).length > OPS_INCIDENT_CHECK_LIMITS.maxAlertLabels) {
    throw new Error("Monitoring returned an invalid bounded label map");
  }
  for (const [key, label] of Object.entries(value)) {
    if (
      key.length === 0
      || typeof label !== "string"
      || Buffer.byteLength(key, "utf8") > OPS_INCIDENT_CHECK_LIMITS.maxLabelBytes
      || Buffer.byteLength(label, "utf8") > OPS_INCIDENT_CHECK_LIMITS.maxLabelBytes
      || key.includes("\0")
      || label.includes("\0")
    ) throw new Error("Monitoring returned an invalid bounded label map");
  }
}

function correlatedGroupLabels(
  context: OpsIncidentReaderContext,
): Record<string, string> {
  if (
    context.sourceKind !== "alertmanager"
    || typeof context.sourceCorrelationKey !== "string"
    || !Array.isArray(context.sourceEvidence)
  ) throw new Error("Incident reader requires trusted task correlation context");
  for (const evidence of context.sourceEvidence) {
    if (evidence.kind !== "alert") continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(evidence.summary) as unknown;
    } catch {
      continue;
    }
    if (
      !isPlainObject(decoded)
      || !hasExactDataKeys(decoded, ["type", "correlationKey", "groupLabels"])
      || decoded.type !== "alertmanager-group-correlation-v1"
      || decoded.correlationKey !== context.sourceCorrelationKey
    ) continue;
    assertBoundedLabelMap(decoded.groupLabels);
    return decoded.groupLabels;
  }
  throw new Error("Incident task lacks a usable exact group-label descriptor");
}

interface PrometheusMatrixEntry {
  samples: Array<{ observedAt: string; value: number }>;
}

function parsePrometheusSample(value: unknown): { observedAt: string; value: number } {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== 2
    || typeof value[1] !== "string"
  ) throw new Error("Prometheus returned an invalid bounded sample");
  const seconds = value[0];
  const numeric = Number(value[1]);
  if (
    typeof seconds !== "number"
    || !Number.isFinite(seconds)
    || seconds < 0
    || !Number.isFinite(numeric)
  ) throw new Error("Prometheus returned a non-finite sample");
  return { observedAt: new Date(seconds * 1_000).toISOString(), value: numeric };
}

function canonicalLabelIdentity(labels: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function parsePrometheusMatrix(raw: unknown): PrometheusMatrixEntry[] {
  if (!isPlainObject(raw) || raw.status !== "success" || !isPlainObject(raw.data)) {
    throw new Error("Prometheus returned an invalid success envelope");
  }
  if (
    raw.data.resultType !== "matrix"
    || !Array.isArray(raw.data.result)
    || Object.getPrototypeOf(raw.data.result) !== Array.prototype
    || raw.data.result.length > OPS_INCIDENT_CHECK_LIMITS.maxPrometheusSeries
  ) throw new Error("Prometheus returned an invalid bounded matrix");
  const identities = new Set<string>();
  const result = raw.data.result.map((candidate) => {
    if (
      !isPlainObject(candidate)
      || !isPlainObject(candidate.metric)
      || Object.keys(candidate.metric).length > OPS_INCIDENT_CHECK_LIMITS.maxAlertLabels
      || !Array.isArray(candidate.values)
      || Object.getPrototypeOf(candidate.values) !== Array.prototype
      || candidate.values.length > OPS_INCIDENT_CHECK_LIMITS.maxPrometheusSamplesPerSeries
    ) throw new Error("Prometheus returned an invalid bounded matrix series");
    assertBoundedLabelMap(candidate.metric);
    const identity = canonicalLabelIdentity(candidate.metric);
    if (identities.has(identity)) {
      throw new Error("Prometheus returned duplicate matrix series identities");
    }
    identities.add(identity);
    return { samples: candidate.values.map(parsePrometheusSample) };
  });
  return result;
}

function promqlString(value: string): string {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function alertRangeQuery(groupLabels: Record<string, string>): string {
  const matchers = Object.entries(groupLabels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!PROMETHEUS_LABEL_NAME_PATTERN.test(key)) {
        throw new Error("Alert group contains a label name unsafe for a Prometheus query");
      }
      return `${key}=${promqlString(value)}`;
    });
  matchers.push('alertstate=~"pending|firing"');
  return `(max(timestamp(ALERTS{${matchers.join(",")}})))[5m:5s]`;
}

function latestMetricTimestamp(series: readonly PrometheusMatrixEntry[]): string | null {
  const timestamps = series.flatMap((entry) => entry.samples).map((sample) => {
    const milliseconds = sample.value * 1_000;
    if (!Number.isFinite(milliseconds)) {
      throw new Error("Prometheus returned an invalid metric timestamp");
    }
    try {
      return new Date(milliseconds).toISOString();
    } catch {
      throw new Error("Prometheus returned an invalid metric timestamp");
    }
  });
  return timestamps.length === 0 ? null : timestamps.sort().at(-1) as string;
}

function completeMonitoringWindowStartedAt(
  series: readonly PrometheusMatrixEntry[],
  observedAt: string,
): string | null {
  if (series.length !== 1 || series[0].samples.length === 0) return null;
  const observedAtMs = Date.parse(observedAt);
  const windowStartedAtMs = observedAtMs - OPS_INCIDENT_CHECK_LIMITS.stabilityWindowMs;
  const samples = [...series[0].samples].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  const firstObservedAtMs = Date.parse(samples[0].observedAt);
  const lastObservedAtMs = Date.parse(samples.at(-1)!.observedAt);
  if (
    firstObservedAtMs > windowStartedAtMs + PROMETHEUS_SUBQUERY_STEP_MS
    || lastObservedAtMs < observedAtMs - PROMETHEUS_SUBQUERY_STEP_MS
    || lastObservedAtMs > observedAtMs
  ) return null;

  let previousObservedAtMs: number | null = null;
  for (const sample of samples) {
    const sampleObservedAtMs = Date.parse(sample.observedAt);
    const metricTimestampMs = sample.value * 1_000;
    if (
      !Number.isFinite(metricTimestampMs)
      || metricTimestampMs > sampleObservedAtMs
      || sampleObservedAtMs - metricTimestampMs
        > OPS_INCIDENT_CHECK_LIMITS.monitoringFreshnessMs
      || sampleObservedAtMs < windowStartedAtMs - PROMETHEUS_SUBQUERY_STEP_MS
      || sampleObservedAtMs > observedAtMs
      || (
        previousObservedAtMs !== null
        && (
          sampleObservedAtMs <= previousObservedAtMs
          || sampleObservedAtMs - previousObservedAtMs > PROMETHEUS_SUBQUERY_STEP_MS
        )
      )
    ) return null;
    previousObservedAtMs = sampleObservedAtMs;
  }
  return new Date(windowStartedAtMs).toISOString();
}

class OpsIncidentPrometheusHttpReader implements OpsIncidentMonitoringReader {
  constructor(
    private readonly baseUrl: URL,
    private readonly fetch: OpsIncidentFetch,
  ) {}

  private async queryRange(
    query: string,
    observedAt: string,
    signal: AbortSignal,
  ): Promise<PrometheusMatrixEntry[]> {
    const url = new URL("api/v1/query", this.baseUrl);
    url.searchParams.set("query", query);
    url.searchParams.set("time", String(Date.parse(observedAt) / 1_000));
    const response = await this.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
    return parsePrometheusMatrix(await readBoundedJson(response));
  }

  async readMonitoringFreshness(
    context: OpsIncidentReaderContext,
  ): Promise<OpsIncidentMonitoringFreshnessReading> {
    const observedAt = new Date().toISOString();
    const series = await this.queryRange(
      PROMETHEUS_UP_RANGE_QUERY,
      observedAt,
      context.signal,
    );
    return {
      observedAt,
      latestSampleAt: latestMetricTimestamp(series),
    };
  }

  async readResolutionStability(
    context: OpsIncidentReaderContext,
  ): Promise<OpsIncidentResolutionStabilityReading> {
    const groupLabels = correlatedGroupLabels(context);
    const observedAt = new Date().toISOString();
    const [series, monitoringSeries] = await Promise.all([
      this.queryRange(
        alertRangeQuery(groupLabels),
        observedAt,
        context.signal,
      ),
      this.queryRange(
        PROMETHEUS_UP_STABILITY_COVERAGE_QUERY,
        observedAt,
        context.signal,
      ),
    ]);
    return {
      observedAt,
      latestMatchingSampleAt: latestMetricTimestamp(series),
      monitoringWindowStartedAt: completeMonitoringWindowStartedAt(
        monitoringSeries,
        observedAt,
      ),
    };
  }
}

class OpsIncidentAlertmanagerHttpReader implements OpsIncidentAlertmanagerReader {
  constructor(
    private readonly baseUrl: URL,
    private readonly fetch: OpsIncidentFetch,
  ) {}

  async readExactGroupState(
    context: OpsIncidentReaderContext,
  ): Promise<OpsIncidentAlertStateReading> {
    const groupLabels = correlatedGroupLabels(context);
    const url = new URL("api/v2/alerts", this.baseUrl);
    url.searchParams.set("active", "true");
    url.searchParams.set("silenced", "true");
    url.searchParams.set("inhibited", "true");
    url.searchParams.set("unprocessed", "true");
    for (const [key, value] of Object.entries(groupLabels).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (!PROMETHEUS_LABEL_NAME_PATTERN.test(key)) {
        throw new Error("Alert group contains a label name unsafe for an Alertmanager query");
      }
      url.searchParams.append("filter", `${key}=${promqlString(value)}`);
    }
    const response = await this.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: context.signal,
    });
    const raw = await readBoundedJson(response);
    if (
      !Array.isArray(raw)
      || Object.getPrototypeOf(raw) !== Array.prototype
      || raw.length > OPS_INCIDENT_CHECK_LIMITS.maxAlertCount
    ) throw new Error("Alertmanager returned an invalid bounded alerts result");
    for (const item of raw) {
      if (
        !isPlainObject(item)
        || Object.keys(item).length > OPS_INCIDENT_CHECK_LIMITS.maxAlertFields
      ) throw new Error("Alertmanager returned an invalid bounded alert");
      assertBoundedLabelMap(item.labels);
      if (
        !isPlainObject(item.status)
        || !["active", "suppressed", "unprocessed"].includes(String(item.status.state))
      ) throw new Error("Alertmanager returned an invalid alert status");
    }
    const present = raw.some((item) => Object.entries(groupLabels).every(
      ([key, value]) => (item as { labels: Record<string, string> }).labels[key] === value,
    ));
    return {
      observedAt: new Date().toISOString(),
      status: present ? "PRESENT" : "ABSENT",
    };
  }
}

export function createOpsMonitoringReaders(
  prometheusBaseUrl: string,
  alertmanagerBaseUrl: string,
  fetch: OpsIncidentFetch,
): Pick<
  OpsIncidentDoneCheckDependencies,
  "incidentMonitoringReader" | "incidentAlertmanagerReader"
> {
  if (typeof fetch !== "function") {
    throw new TypeError("Incident monitoring readers require injected fetch");
  }
  return Object.freeze({
    incidentMonitoringReader: new OpsIncidentPrometheusHttpReader(
      normalizeLoopbackBaseUrl(prometheusBaseUrl),
      fetch,
    ),
    incidentAlertmanagerReader: new OpsIncidentAlertmanagerHttpReader(
      normalizeLoopbackBaseUrl(alertmanagerBaseUrl),
      fetch,
    ),
  });
}
