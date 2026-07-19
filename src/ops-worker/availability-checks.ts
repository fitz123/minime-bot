import { createHash } from "node:crypto";
import {
  OpsWorkerDoneCheckRegistry,
  type OpsWorkerDoneCheckContext,
} from "./done-checks.js";
import type { JsonObject, OpsWorkerVerificationOutcome } from "./types.js";

export const OPS_AVAILABILITY_DONE_CHECK_NAME = "ops.minime-availability" as const;
export const OPS_AVAILABILITY_DONE_CHECK_VERSION = "1" as const;
export const OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT = "minime-bot-host" as const;

export const OPS_AVAILABILITY_LIMITS = Object.freeze({
  componentTimeoutMs: 5_000,
  observationFreshnessMs: 60_000,
  monitoringFreshnessMs: 2 * 60_000,
  stabilityWindowMs: 5 * 60_000,
  recheckMs: 60_000,
  maxResponseBytes: 256 * 1024,
  maxAlertCount: 256,
  maxAlertFields: 24,
  maxAlertLabels: 64,
  maxLabelBytes: 2 * 1024,
  maxPrometheusSeries: 16,
} as const);

export interface OpsAvailabilityInvariant {
  name: typeof OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT;
  objective: string;
}

export const OPS_AVAILABILITY_INVARIANTS: Readonly<
  Record<typeof OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT, OpsAvailabilityInvariant>
> = Object.freeze({
  [OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT]: Object.freeze({
    name: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
    objective: "Restore and verify Minime bot host availability.",
  }),
});

export type OpsAvailabilityInvariantName = keyof typeof OPS_AVAILABILITY_INVARIANTS;

export interface OpsAvailabilityReaderContext {
  signal: AbortSignal;
}

export interface OpsMonitoringFreshnessReading {
  observedAt: string;
  latestSampleAt: string | null;
}

export interface OpsAlertStateReading {
  observedAt: string;
  status: "FIRING" | "RESOLVED";
}

export interface OpsServiceAvailabilityReading {
  observedAt: string;
  status: "HEALTHY" | "UNHEALTHY" | "UNKNOWN";
  healthySince: string | null;
}

export interface OpsMonitoringFreshnessReader {
  read?(
    invariant: OpsAvailabilityInvariantName,
    context: OpsAvailabilityReaderContext,
  ): OpsMonitoringFreshnessReading | Promise<OpsMonitoringFreshnessReading>;
  readMonitoringFreshness?(
    invariant: OpsAvailabilityInvariantName,
    context: OpsAvailabilityReaderContext,
  ): OpsMonitoringFreshnessReading | Promise<OpsMonitoringFreshnessReading>;
}

export interface OpsAlertStateReader {
  read(
    invariant: OpsAvailabilityInvariantName,
    context: OpsAvailabilityReaderContext,
  ): OpsAlertStateReading | Promise<OpsAlertStateReading>;
}

export interface OpsServiceAvailabilityReader {
  read?(
    invariant: OpsAvailabilityInvariantName,
    context: OpsAvailabilityReaderContext,
  ): OpsServiceAvailabilityReading | Promise<OpsServiceAvailabilityReading>;
  readServiceAvailability?(
    invariant: OpsAvailabilityInvariantName,
    context: OpsAvailabilityReaderContext,
  ): OpsServiceAvailabilityReading | Promise<OpsServiceAvailabilityReading>;
}

export interface OpsAvailabilityDoneCheckDependencies {
  monitoringFreshnessReader: OpsMonitoringFreshnessReader;
  alertStateReader: OpsAlertStateReader;
  serviceAvailabilityReader: OpsServiceAvailabilityReader;
  clock: () => Date;
}

interface ComponentResult {
  result: OpsWorkerVerificationOutcome;
  summary: string;
  observedAt: string;
  evidenceHash: string;
  nextCheckAt?: string;
}

const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const ALERT_NAME = "MinimeBotMetricsDown";
const PROMETHEUS_UP_QUERY = 'up{job="minime-bot"}';
const PROMETHEUS_STABILITY_QUERY =
  'min_over_time(up{job="minime-bot"}[5m])';

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
    return checkedAt;
  }
  return new Date(Math.max(current.getTime(), Date.parse(checkedAt))).toISOString();
}

function scheduledAt(observedAt: string, delayMs = OPS_AVAILABILITY_LIMITS.recheckMs): string {
  return new Date(Date.parse(observedAt) + delayMs).toISOString();
}

function result(
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
  // Deliberately outside the component result contract. The composite registry
  // converts it to VERIFIER_INVALID, preserving query exceptions as QUERY_ERROR.
  return Object.freeze({ invalidReaderOutput: true });
}

function parseMonitoringReading(raw: unknown): OpsMonitoringFreshnessReading | null {
  if (!isPlainObject(raw) || !hasExactDataKeys(raw, ["observedAt", "latestSampleAt"])) {
    return null;
  }
  if (
    !validTimestamp(raw.observedAt)
    || (raw.latestSampleAt !== null && !validTimestamp(raw.latestSampleAt))
  ) return null;
  return { observedAt: raw.observedAt, latestSampleAt: raw.latestSampleAt };
}

function parseAlertReading(raw: unknown): OpsAlertStateReading | null {
  if (!isPlainObject(raw) || !hasExactDataKeys(raw, ["observedAt", "status"])) return null;
  if (
    !validTimestamp(raw.observedAt)
    || (raw.status !== "FIRING" && raw.status !== "RESOLVED")
  ) return null;
  return { observedAt: raw.observedAt, status: raw.status };
}

function parseServiceReading(raw: unknown): OpsServiceAvailabilityReading | null {
  if (
    !isPlainObject(raw)
    || !hasExactDataKeys(raw, ["observedAt", "status", "healthySince"])
    || !validTimestamp(raw.observedAt)
    || !["HEALTHY", "UNHEALTHY", "UNKNOWN"].includes(String(raw.status))
    || (raw.healthySince !== null && !validTimestamp(raw.healthySince))
  ) return null;
  if (
    raw.status === "HEALTHY"
      ? raw.healthySince === null
      : raw.healthySince !== null
  ) return null;
  return {
    observedAt: raw.observedAt,
    status: raw.status as OpsServiceAvailabilityReading["status"],
    healthySince: raw.healthySince,
  };
}

function isFresh(timestamp: string, now: string, boundMs: number): boolean {
  const age = Date.parse(now) - Date.parse(timestamp);
  return age >= 0 && age <= boundMs;
}

function validateParams(value: unknown): JsonObject {
  if (!isPlainObject(value) || !hasExactDataKeys(value, ["invariant"])) {
    throw new TypeError("Availability parameters must contain only invariant");
  }
  if (value.invariant !== OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT) {
    throw new TypeError("Availability invariant is not registered in package code");
  }
  return { invariant: value.invariant };
}

function invariantFromParams(params: JsonObject): OpsAvailabilityInvariantName {
  return params.invariant as OpsAvailabilityInvariantName;
}

function assertDependencies(deps: OpsAvailabilityDoneCheckDependencies): void {
  if (
    !deps
    || typeof deps.clock !== "function"
    || (
      typeof deps.monitoringFreshnessReader?.read !== "function"
      && typeof deps.monitoringFreshnessReader?.readMonitoringFreshness !== "function"
    )
    || typeof deps.alertStateReader?.read !== "function"
    || (
      typeof deps.serviceAvailabilityReader?.read !== "function"
      && typeof deps.serviceAvailabilityReader?.readServiceAvailability !== "function"
    )
  ) throw new TypeError("Availability done check requires all trusted read-only dependencies");
}

function readMonitoringFreshness(
  reader: OpsMonitoringFreshnessReader,
  invariant: OpsAvailabilityInvariantName,
  context: OpsAvailabilityReaderContext,
): OpsMonitoringFreshnessReading | Promise<OpsMonitoringFreshnessReading> {
  if (reader.readMonitoringFreshness) {
    return reader.readMonitoringFreshness(invariant, context);
  }
  return (reader.read as NonNullable<OpsMonitoringFreshnessReader["read"]>)(
    invariant,
    context,
  );
}

function readServiceAvailability(
  reader: OpsServiceAvailabilityReader,
  invariant: OpsAvailabilityInvariantName,
  context: OpsAvailabilityReaderContext,
): OpsServiceAvailabilityReading | Promise<OpsServiceAvailabilityReading> {
  if (reader.readServiceAvailability) {
    return reader.readServiceAvailability(invariant, context);
  }
  return (reader.read as NonNullable<OpsServiceAvailabilityReader["read"]>)(
    invariant,
    context,
  );
}

export function createOpsAvailabilityDoneCheckRegistry(
  deps: OpsAvailabilityDoneCheckDependencies,
): OpsWorkerDoneCheckRegistry {
  assertDependencies(deps);
  return new OpsWorkerDoneCheckRegistry({
    [OPS_AVAILABILITY_DONE_CHECK_NAME]: {
      identity: OPS_AVAILABILITY_DONE_CHECK_NAME,
      version: OPS_AVAILABILITY_DONE_CHECK_VERSION,
      validateParams,
      components: [
        {
          identity: "monitoring-freshness",
          version: "1",
          required: true,
          convergence: "PRODUCT",
          timeoutMs: OPS_AVAILABILITY_LIMITS.componentTimeoutMs,
          async run(params, context): Promise<unknown> {
            const raw = await readMonitoringFreshness(
              deps.monitoringFreshnessReader,
              invariantFromParams(params),
              { signal: context.signal },
            );
            const reading = parseMonitoringReading(raw);
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
                OPS_AVAILABILITY_LIMITS.observationFreshnessMs,
              )
              || reading.latestSampleAt === null
              || !isFresh(
                reading.latestSampleAt,
                observedAt,
                OPS_AVAILABILITY_LIMITS.monitoringFreshnessMs,
              )
            ) {
              return result(
                "NOT_READY",
                "Monitoring telemetry is missing or outside the trusted freshness bound.",
                observedAt,
                reading,
                scheduledAt(observedAt),
              );
            }
            return result(
              "PASS",
              "Monitoring telemetry is fresh within the trusted bound.",
              observedAt,
              reading,
            );
          },
        },
        {
          identity: "alert-state",
          version: "1",
          required: true,
          convergence: "PASSIVE",
          timeoutMs: OPS_AVAILABILITY_LIMITS.componentTimeoutMs,
          async run(params, context): Promise<unknown> {
            const raw = await deps.alertStateReader.read(
              invariantFromParams(params),
              { signal: context.signal },
            );
            const reading = parseAlertReading(raw);
            if (!reading) return invalidReaderResult();
            const observedAt = componentObservedAt(deps.clock, context.checkedAt);
            if (Date.parse(reading.observedAt) > Date.parse(observedAt)) {
              return invalidReaderResult();
            }
            if (!isFresh(
              reading.observedAt,
              observedAt,
              OPS_AVAILABILITY_LIMITS.observationFreshnessMs,
            )) {
              return result(
                "NOT_READY",
                "Alert state was not observed by a fresh trusted query.",
                observedAt,
                reading,
                scheduledAt(observedAt),
              );
            }
            if (reading.status === "FIRING") {
              return result(
                "DEFER",
                "The correlated alert state is still firing and may converge passively.",
                observedAt,
                reading,
                scheduledAt(observedAt),
              );
            }
            return result(
              "PASS",
              "A fresh trusted query found the correlated alert state resolved.",
              observedAt,
              reading,
            );
          },
        },
        {
          identity: "service-stability",
          version: "1",
          required: true,
          convergence: "PRODUCT",
          timeoutMs: OPS_AVAILABILITY_LIMITS.componentTimeoutMs,
          async run(params, context): Promise<unknown> {
            const raw = await readServiceAvailability(
              deps.serviceAvailabilityReader,
              invariantFromParams(params),
              { signal: context.signal },
            );
            const reading = parseServiceReading(raw);
            if (!reading) return invalidReaderResult();
            const observedAt = componentObservedAt(deps.clock, context.checkedAt);
            if (
              Date.parse(reading.observedAt) > Date.parse(observedAt)
              || (
                reading.healthySince !== null
                && Date.parse(reading.healthySince) > Date.parse(reading.observedAt)
              )
            ) return invalidReaderResult();
            if (!isFresh(
              reading.observedAt,
              observedAt,
              OPS_AVAILABILITY_LIMITS.observationFreshnessMs,
            ) || reading.status === "UNKNOWN") {
              return result(
                "NOT_READY",
                "Direct service availability has no fresh trusted observation.",
                observedAt,
                reading,
                scheduledAt(observedAt),
              );
            }
            if (reading.status === "UNHEALTHY") {
              return result(
                "PRODUCT_FAILURE",
                "A fresh direct service observation is unhealthy.",
                observedAt,
                reading,
              );
            }
            const stableAt = new Date(
              Date.parse(reading.healthySince as string)
                + OPS_AVAILABILITY_LIMITS.stabilityWindowMs,
            ).toISOString();
            if (Date.parse(stableAt) > Date.parse(observedAt)) {
              return result(
                "NOT_READY",
                "Direct service health has not yet covered the trusted stability window.",
                observedAt,
                reading,
                stableAt,
              );
            }
            return result(
              "PASS",
              "Direct service health is fresh and continuously stable.",
              observedAt,
              reading,
            );
          },
        },
      ],
    },
  });
}

export type OpsAvailabilityFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

function normalizeLoopbackBaseUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError("Availability reader requires a loopback HTTP base URL");
  }
  if (
    parsed.protocol !== "http:"
    || !LOOPBACK_HOSTS.has(
      parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname,
    )
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || (parsed.pathname !== "/" && parsed.pathname !== "")
  ) throw new TypeError("Availability reader requires a loopback HTTP base URL");
  parsed.pathname = "/";
  return parsed;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("Availability reader query returned a non-success status");
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new Error("Availability reader response must be application/json");
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number(declaredLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > OPS_AVAILABILITY_LIMITS.maxResponseBytes) {
      throw new Error("Availability reader response exceeds its byte bound");
    }
  }
  if (!response.body) throw new Error("Availability reader response body is missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > OPS_AVAILABILITY_LIMITS.maxResponseBytes) {
      await reader.cancel();
      throw new Error("Availability reader response exceeds its byte bound");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Availability reader response is not bounded valid JSON");
  }
  return value;
}

function assertInvariant(
  invariant: OpsAvailabilityInvariantName,
): asserts invariant is typeof OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT {
  if (invariant !== OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT) {
    throw new TypeError("Availability reader invariant is not registered");
  }
}

function assertBoundedLabelMap(value: unknown): asserts value is Record<string, string> {
  if (!isPlainObject(value) || Object.keys(value).length > OPS_AVAILABILITY_LIMITS.maxAlertLabels) {
    throw new Error("Alertmanager returned an invalid bounded label map");
  }
  for (const [key, label] of Object.entries(value)) {
    if (
      key.length === 0
      || typeof label !== "string"
      || Buffer.byteLength(key, "utf8") > OPS_AVAILABILITY_LIMITS.maxLabelBytes
      || Buffer.byteLength(label, "utf8") > OPS_AVAILABILITY_LIMITS.maxLabelBytes
      || key.includes("\0")
      || label.includes("\0")
    ) throw new Error("Alertmanager returned an invalid bounded label map");
  }
}

export class OpsAlertmanagerHttpReader implements OpsAlertStateReader {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly fetch: OpsAvailabilityFetch,
  ) {
    this.baseUrl = normalizeLoopbackBaseUrl(baseUrl);
    if (typeof fetch !== "function") throw new TypeError("Alertmanager reader requires injected fetch");
  }

  async read(
    invariant: OpsAvailabilityInvariantName,
    context: OpsAvailabilityReaderContext,
  ): Promise<OpsAlertStateReading> {
    assertInvariant(invariant);
    const url = new URL("api/v2/alerts", this.baseUrl);
    url.searchParams.set("active", "true");
    url.searchParams.set("silenced", "false");
    url.searchParams.set("inhibited", "false");
    url.searchParams.set("unprocessed", "true");
    url.searchParams.set("filter", `alertname="${ALERT_NAME}"`);
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
      || raw.length > OPS_AVAILABILITY_LIMITS.maxAlertCount
    ) throw new Error("Alertmanager returned an invalid bounded alerts result");
    for (const item of raw) {
      if (!isPlainObject(item) || Object.keys(item).length > OPS_AVAILABILITY_LIMITS.maxAlertFields) {
        throw new Error("Alertmanager returned an invalid bounded alert");
      }
      assertBoundedLabelMap(item.labels);
      if (item.labels.alertname !== ALERT_NAME) {
        throw new Error("Alertmanager returned an alert outside the registered invariant");
      }
      if (!isPlainObject(item.status) || !["active", "suppressed", "unprocessed"].includes(String(item.status.state))) {
        throw new Error("Alertmanager returned an invalid alert status");
      }
    }
    return {
      observedAt: new Date().toISOString(),
      status: raw.length === 0 ? "RESOLVED" : "FIRING",
    };
  }
}

interface PrometheusVectorEntry {
  observedAt: string;
  value: number;
}

function parsePrometheusVector(raw: unknown): PrometheusVectorEntry[] {
  if (!isPlainObject(raw) || raw.status !== "success" || !isPlainObject(raw.data)) {
    throw new Error("Prometheus returned an invalid success envelope");
  }
  if (
    raw.data.resultType !== "vector"
    || !Array.isArray(raw.data.result)
    || Object.getPrototypeOf(raw.data.result) !== Array.prototype
    || raw.data.result.length > OPS_AVAILABILITY_LIMITS.maxPrometheusSeries
  ) throw new Error("Prometheus returned an invalid bounded vector");
  return raw.data.result.map((candidate) => {
    if (
      !isPlainObject(candidate)
      || !isPlainObject(candidate.metric)
      || Object.keys(candidate.metric).length > OPS_AVAILABILITY_LIMITS.maxAlertLabels
      || !Array.isArray(candidate.value)
      || Object.getPrototypeOf(candidate.value) !== Array.prototype
      || candidate.value.length !== 2
      || typeof candidate.value[1] !== "string"
    ) throw new Error("Prometheus returned an invalid bounded vector sample");
    assertBoundedLabelMap(candidate.metric);
    const seconds = candidate.value[0];
    const numeric = Number(candidate.value[1]);
    if (
      typeof seconds !== "number"
      || !Number.isFinite(seconds)
      || seconds < 0
      || !Number.isFinite(numeric)
    ) throw new Error("Prometheus returned a non-finite vector sample");
    return {
      observedAt: new Date(seconds * 1_000).toISOString(),
      value: numeric,
    };
  });
}

export class OpsPrometheusHttpReader implements
  OpsMonitoringFreshnessReader,
  OpsServiceAvailabilityReader {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly fetch: OpsAvailabilityFetch,
  ) {
    this.baseUrl = normalizeLoopbackBaseUrl(baseUrl);
    if (typeof fetch !== "function") throw new TypeError("Prometheus reader requires injected fetch");
  }

  private async query(query: string, signal: AbortSignal): Promise<PrometheusVectorEntry[]> {
    const url = new URL("api/v1/query", this.baseUrl);
    url.searchParams.set("query", query);
    const response = await this.fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal,
    });
    return parsePrometheusVector(await readBoundedJson(response));
  }

  async readMonitoringFreshness(
    invariant: OpsAvailabilityInvariantName,
    context: OpsAvailabilityReaderContext,
  ): Promise<OpsMonitoringFreshnessReading> {
    assertInvariant(invariant);
    const samples = await this.query(PROMETHEUS_UP_QUERY, context.signal);
    const observedAt = new Date().toISOString();
    return {
      observedAt,
      latestSampleAt: samples.length === 0
        ? null
        : samples.map((sample) => sample.observedAt).sort().at(-1) as string,
    };
  }

  async readServiceAvailability(
    invariant: OpsAvailabilityInvariantName,
    context: OpsAvailabilityReaderContext,
  ): Promise<OpsServiceAvailabilityReading> {
    assertInvariant(invariant);
    const direct = await this.query(PROMETHEUS_UP_QUERY, context.signal);
    if (direct.some((sample) => sample.value !== 0 && sample.value !== 1)) {
      throw new Error("Prometheus direct availability result is outside the closed contract");
    }
    const observedAt = direct.length === 0
      ? new Date().toISOString()
      : direct.map((sample) => sample.observedAt).sort()[0];
    if (direct.length === 0) {
      return { observedAt, status: "UNKNOWN", healthySince: null };
    }
    if (direct.some((sample) => sample.value === 0)) {
      return { observedAt, status: "UNHEALTHY", healthySince: null };
    }
    const stable = await this.query(PROMETHEUS_STABILITY_QUERY, context.signal);
    if (stable.some((sample) => sample.value !== 0 && sample.value !== 1)) {
      throw new Error("Prometheus stability result is outside the closed contract");
    }
    const coversWindow = stable.length === direct.length
      && stable.length > 0
      && stable.every((sample) => sample.value === 1);
    return {
      observedAt,
      status: "HEALTHY",
      healthySince: coversWindow
        ? new Date(Date.parse(observedAt) - OPS_AVAILABILITY_LIMITS.stabilityWindowMs).toISOString()
        : observedAt,
    };
  }
}
