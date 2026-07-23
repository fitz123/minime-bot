import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME,
  OPS_INCIDENT_CHECK_LIMITS,
  createOpsIncidentDoneCheckRegistry,
  createOpsMonitoringReaders,
  type OpsIncidentAlertStateReading,
  type OpsIncidentMonitoringFreshnessReading,
  type OpsIncidentResolutionStabilityReading,
} from "../ops-worker/incident-checks.js";
import type {
  OpsWorkerEvidence,
  OpsWorkerVerificationRecord,
} from "../ops-worker/types.js";

const NOW = "2026-07-22T12:00:00.000Z";
const TEN_MINUTES_AGO = "2026-07-22T11:50:00.000Z";
const FIVE_MINUTES_AGO = "2026-07-22T11:55:00.000Z";
const ONE_MINUTE_AGO = "2026-07-22T11:59:00.000Z";
const FOUR_MINUTES_LATER = "2026-07-22T12:04:00.000Z";
const FIVE_MINUTES_LATER = "2026-07-22T12:05:00.000Z";
const FIVE_SECONDS_LATER = "2026-07-22T12:00:05.000Z";
const RECHECK = "2026-07-22T12:01:00.000Z";
const CORRELATION_KEY = `lab-alertmanager:group:${"a".repeat(64)}`;
const RULE_FAMILIES = [
  "MinimeBotMetricsDown",
  "BotDown",
  "SessionCrashes",
  "TelegramAPIErrors",
  "TelegramNetworkErrors",
  "HostHighCPU",
  "HostDiskFull",
  "NodeExporterDown",
  "FutureSyntheticAlert",
] as const;

function correlationEvidence(
  alertname: string,
  groupLabels: Record<string, string> = { alertname, instance: "local" },
): OpsWorkerEvidence[] {
  return [{
    at: NOW,
    kind: "alert",
    trust: "untrusted",
    summary: JSON.stringify({
      type: "alertmanager-group-correlation-v1",
      correlationKey: CORRELATION_KEY,
      groupLabels,
    }),
    artifact: null,
  }];
}

function firingObservation(at: string): OpsWorkerEvidence {
  return {
    at,
    kind: "system",
    trust: "trusted",
    summary: JSON.stringify({
      type: "alertmanager-firing-observation-v1",
      correlationKey: CORRELATION_KEY,
      deliveryKey: "lab-alertmanager:episode:fixture",
    }),
    artifact: null,
  };
}

function healthyReadings(): {
  freshness: OpsIncidentMonitoringFreshnessReading;
  alerts: OpsIncidentAlertStateReading;
  stability: OpsIncidentResolutionStabilityReading;
} {
  return {
    freshness: { observedAt: NOW, latestSampleAt: ONE_MINUTE_AGO },
    alerts: { observedAt: NOW, status: "ABSENT" },
    stability: {
      observedAt: NOW,
      latestMatchingSampleAt: null,
      monitoringWindowStartedAt: FIVE_MINUTES_AGO,
    },
  };
}

function completedAbsenceWindow(): OpsWorkerVerificationRecord {
  return {
    verifierIdentity: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME,
    verifierVersion: "1",
    contractHash: `sha256:${"a".repeat(64)}`,
    subjectHash: `sha256:${"b".repeat(64)}`,
    checkedAt: FIVE_MINUTES_AGO,
    completedAt: FIVE_MINUTES_AGO,
    outcome: "NOT_READY",
    summary: "synthetic prior stability wait",
    nextCheckAt: NOW,
    components: [
      {
        identity: "exact-group-absence",
        version: "1",
        required: true,
        convergence: "PRODUCT",
        outcome: "PASS",
        observedAt: FIVE_MINUTES_AGO,
        evidenceHash: `sha256:${"c".repeat(64)}`,
        summary: "The exact Alertmanager group is absent in every queried state.",
        nextCheckAt: null,
      },
      {
        identity: "resolution-stability",
        version: "1",
        required: true,
        convergence: "PRODUCT",
        outcome: "NOT_READY",
        observedAt: FIVE_MINUTES_AGO,
        evidenceHash: `sha256:${"d".repeat(64)}`,
        summary:
          "The exact alert group has not yet been absent with five minutes of monitoring coverage.",
        nextCheckAt: NOW,
      },
    ],
  };
}

async function runIncident(
  readings: ReturnType<typeof healthyReadings>,
  alertname = "FutureSyntheticAlert",
  withCompletedAbsenceWindow = true,
  groupLabels?: Record<string, string>,
  additionalEvidence: readonly OpsWorkerEvidence[] = [],
) {
  const registry = createOpsIncidentDoneCheckRegistry({
    clock: () => new Date(NOW),
    incidentMonitoringReader: {
      readMonitoringFreshness: () => structuredClone(readings.freshness),
      readResolutionStability: () => structuredClone(readings.stability),
    },
    incidentAlertmanagerReader: {
      readExactGroupState: () => structuredClone(readings.alerts),
    },
  });
  return registry.run(
    { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
    {
      taskId: "incident-fixture",
      checkedAt: NOW,
      now: () => new Date(NOW),
      sourceKind: "alertmanager",
      sourceCorrelationKey: CORRELATION_KEY,
      sourceEvidence: [
        ...correlationEvidence(alertname, groupLabels),
        ...additionalEvidence,
      ],
      ...(withCompletedAbsenceWindow
        ? { previousVerification: completedAbsenceWindow() }
        : {}),
    },
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("generic Alertmanager incident done check", () => {
  it("uses one three-component PASS contract for every current and future rule family", async () => {
    for (const alertname of RULE_FAMILIES) {
      const result = await runIncident(healthyReadings(), alertname);
      assert.equal(result.result, "PASS", alertname);
      assert.equal(result.verifierIdentity, OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME);
      assert.equal(result.verifierVersion, "1");
      assert.deepEqual(
        result.components.map(({ identity, outcome }) => ({ identity, outcome })),
        [
          { identity: "monitoring-freshness", outcome: "PASS" },
          { identity: "exact-group-absence", outcome: "PASS" },
          { identity: "resolution-stability", outcome: "PASS" },
        ],
        alertname,
      );
    }
  });

  it("starts a durable five-minute absence window when the exact-label query is empty", async () => {
    const firstAbsentCheck = await runIncident(
      healthyReadings(),
      "ExternalLabelAlert",
      false,
      { alertname: "ExternalLabelAlert", cluster: "production" },
    );

    assert.equal(firstAbsentCheck.result, "NOT_READY");
    assert.equal(firstAbsentCheck.nextCheckAt, FIVE_MINUTES_LATER);
    assert.equal(firstAbsentCheck.components[1].outcome, "PASS");
    assert.equal(firstAbsentCheck.components[2].outcome, "NOT_READY");
    assert.equal(firstAbsentCheck.components[2].nextCheckAt, FIVE_MINUTES_LATER);
  });

  it("measures the durable window from the later exact-absence observation", async () => {
    const readings = healthyReadings();
    const prior = completedAbsenceWindow();
    prior.components[0].observedAt = "2026-07-22T11:55:05.000Z";
    const registry = createOpsIncidentDoneCheckRegistry({
      clock: () => new Date(NOW),
      incidentMonitoringReader: {
        readMonitoringFreshness: () => structuredClone(readings.freshness),
        readResolutionStability: () => structuredClone(readings.stability),
      },
      incidentAlertmanagerReader: {
        readExactGroupState: () => structuredClone(readings.alerts),
      },
    });

    const result = await registry.run(
      { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
      {
        taskId: "delayed-absence-fixture",
        checkedAt: NOW,
        now: () => new Date(NOW),
        sourceKind: "alertmanager",
        sourceCorrelationKey: CORRELATION_KEY,
        sourceEvidence: correlationEvidence("ExternalLabelAlert"),
        previousVerification: prior,
      },
    );

    assert.equal(result.result, "NOT_READY");
    assert.equal(result.nextCheckAt, FIVE_SECONDS_LATER);
    assert.equal(result.components[2].nextCheckAt, FIVE_SECONDS_LATER);
  });

  it("does not substitute a firing receipt for the first exact-absence observation", async () => {
    for (const [priorWindow, firingObservedAt] of [
      [false, TEN_MINUTES_AGO],
      [true, ONE_MINUTE_AGO],
    ] as const) {
      const result = await runIncident(
        healthyReadings(),
        "ExternalLabelAlert",
        priorWindow,
        { alertname: "ExternalLabelAlert", cluster: "production" },
        [firingObservation(firingObservedAt)],
      );

      assert.equal(result.result, "NOT_READY");
      assert.equal(result.components[1].outcome, "PASS");
      assert.equal(result.components[2].outcome, "NOT_READY");
      assert.equal(result.components[2].nextCheckAt, FIVE_MINUTES_LATER);
    }
  });

  it("disproves a claim while the exact group remains present", async () => {
    const readings = healthyReadings();
    readings.alerts.status = "PRESENT";

    const result = await runIncident(readings);

    assert.equal(result.result, "PRODUCT_FAILURE");
    assert.equal(result.nextCheckAt, null);
    assert.equal(result.components[1].outcome, "PRODUCT_FAILURE");
    assert.match(result.summary, /exact-group-absence=PRODUCT_FAILURE/);
  });

  it("keeps a conclusive present group decisive when Prometheus also fails", async () => {
    const readings = healthyReadings();
    readings.alerts.status = "PRESENT";
    const registry = createOpsIncidentDoneCheckRegistry({
      clock: () => new Date(NOW),
      incidentMonitoringReader: {
        readMonitoringFreshness: () => { throw new Error("offline"); },
        readResolutionStability: () => readings.stability,
      },
      incidentAlertmanagerReader: {
        readExactGroupState: () => readings.alerts,
      },
    });

    const result = await registry.run(
      { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
      {
        taskId: "incident-present-during-prometheus-failure",
        checkedAt: NOW,
        now: () => new Date(NOW),
        sourceKind: "alertmanager",
        sourceCorrelationKey: CORRELATION_KEY,
        sourceEvidence: correlationEvidence("FutureSyntheticAlert"),
      },
    );

    assert.equal(result.result, "PRODUCT_FAILURE");
    assert.deepEqual(
      result.components.map((component) => component.outcome),
      ["QUERY_ERROR", "PRODUCT_FAILURE", "NOT_READY"],
    );
  });

  it("schedules stale telemetry and flap stability waits without a failure outcome", async () => {
    const stale = healthyReadings();
    stale.freshness.latestSampleAt = "2026-07-22T11:57:59.999Z";
    const staleResult = await runIncident(stale);
    assert.equal(staleResult.result, "NOT_READY");
    assert.equal(staleResult.nextCheckAt, RECHECK);

    const missingHistory = healthyReadings();
    missingHistory.stability.monitoringWindowStartedAt = null;
    const missingHistoryResult = await runIncident(missingHistory);
    assert.equal(missingHistoryResult.result, "NOT_READY");
    assert.equal(missingHistoryResult.nextCheckAt, RECHECK);

    const shortHistory = healthyReadings();
    shortHistory.stability.monitoringWindowStartedAt = ONE_MINUTE_AGO;
    const shortHistoryResult = await runIncident(shortHistory);
    assert.equal(shortHistoryResult.result, "NOT_READY");
    assert.equal(shortHistoryResult.nextCheckAt, FOUR_MINUTES_LATER);

    const flap = healthyReadings();
    flap.stability.latestMatchingSampleAt = ONE_MINUTE_AGO;
    const flapResult = await runIncident(flap);
    assert.equal(flapResult.result, "NOT_READY");
    assert.equal(flapResult.nextCheckAt, FOUR_MINUTES_LATER);
    assert.equal(flapResult.components[2].outcome, "NOT_READY");
  });

  it("independently rejects stale and impossible Alertmanager and stability observations", async () => {
    const staleAlerts = healthyReadings();
    staleAlerts.alerts.observedAt = "2026-07-22T11:57:59.999Z";
    assert.equal((await runIncident(staleAlerts)).result, "NOT_READY");

    const futureAlerts = healthyReadings();
    futureAlerts.alerts.observedAt = "2026-07-22T12:00:00.001Z";
    assert.equal((await runIncident(futureAlerts)).result, "VERIFIER_INVALID");

    const staleStability = healthyReadings();
    staleStability.stability.observedAt = "2026-07-22T11:57:59.999Z";
    assert.equal((await runIncident(staleStability)).result, "NOT_READY");

    for (const mutate of [
      (readings: ReturnType<typeof healthyReadings>) => {
        readings.stability.observedAt = "2026-07-22T12:00:00.001Z";
      },
      (readings: ReturnType<typeof healthyReadings>) => {
        readings.stability.latestMatchingSampleAt = "2026-07-22T12:00:00.001Z";
      },
      (readings: ReturnType<typeof healthyReadings>) => {
        readings.stability.monitoringWindowStartedAt = "2026-07-22T12:00:00.001Z";
      },
    ]) {
      const impossible = healthyReadings();
      mutate(impossible);
      assert.equal((await runIncident(impossible)).result, "VERIFIER_INVALID");
    }
  });

  it("types reader errors, invalid output, and the fixed component timeout", async () => {
    const queryErrorRegistry = createOpsIncidentDoneCheckRegistry({
      clock: () => new Date(NOW),
      incidentMonitoringReader: {
        readMonitoringFreshness: () => { throw new Error("offline"); },
        readResolutionStability: () => healthyReadings().stability,
      },
      incidentAlertmanagerReader: {
        readExactGroupState: () => healthyReadings().alerts,
      },
    });
    const context = {
      taskId: "incident-errors",
      checkedAt: NOW,
      now: () => new Date(NOW),
      sourceKind: "alertmanager" as const,
      sourceCorrelationKey: CORRELATION_KEY,
      sourceEvidence: correlationEvidence("FutureSyntheticAlert"),
    };
    const queryError = await queryErrorRegistry.run(
      { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
      context,
    );
    assert.equal(queryError.result, "QUERY_ERROR");

    const invalidRegistry = createOpsIncidentDoneCheckRegistry({
      clock: () => new Date(NOW),
      incidentMonitoringReader: {
        readMonitoringFreshness: () => ({ observedAt: NOW, latestSampleAt: NOW }),
        readResolutionStability: () => ({ observedAt: NOW, unexpected: true }) as never,
      },
      incidentAlertmanagerReader: {
        readExactGroupState: () => healthyReadings().alerts,
      },
    });
    const invalid = await invalidRegistry.run(
      { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
      context,
    );
    assert.equal(invalid.result, "VERIFIER_INVALID");

    const timeoutRegistry = createOpsIncidentDoneCheckRegistry({
      clock: () => new Date(NOW),
      incidentMonitoringReader: {
        readMonitoringFreshness: () => new Promise(() => undefined),
        readResolutionStability: () => healthyReadings().stability,
      },
      incidentAlertmanagerReader: {
        readExactGroupState: () => healthyReadings().alerts,
      },
    });
    const startedAt = Date.now();
    const timedOut = await timeoutRegistry.run(
      { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
      context,
    );
    assert.equal(timedOut.result, "TIMEOUT");
    assert.ok(Date.now() - startedAt >= OPS_INCIDENT_CHECK_LIMITS.componentTimeoutMs - 100);
  });
});

describe("bounded generic monitoring readers", () => {
  it("aborts a pending paired Prometheus read when its sibling query fails", async () => {
    let coverageAborted = false;
    const readers = createOpsMonitoringReaders(
      "http://127.0.0.1:9090",
      "http://127.0.0.1:9093",
      async (input, init) => {
        const url = new URL(input);
        if (url.port === "9093") return jsonResponse([]);
        const query = url.searchParams.get("query");
        if (query === "(max(timestamp(up)))[2m:5s]") {
          const now = Date.now() / 1_000;
          return jsonResponse({
            status: "success",
            data: {
              resultType: "matrix",
              result: [{ metric: {}, values: [[now, String(now)]] }],
            },
          });
        }
        if (query === "(max(timestamp(up)))[5m:5s]") {
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            const abort = (): void => {
              coverageAborted = true;
              reject(new Error("paired query aborted"));
            };
            if (signal?.aborted) abort();
            else signal?.addEventListener("abort", abort, { once: true });
          });
        }
        throw new Error("synthetic alert-range query failure");
      },
    );
    const registry = createOpsIncidentDoneCheckRegistry({
      clock: () => new Date(),
      ...readers,
    });
    const checkedAt = new Date().toISOString();
    const result = await registry.run(
      { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
      {
        taskId: "paired-prometheus-cleanup",
        checkedAt,
        now: () => new Date(),
        sourceKind: "alertmanager",
        sourceCorrelationKey: CORRELATION_KEY,
        sourceEvidence: correlationEvidence("FutureSyntheticAlert"),
      },
    );

    assert.equal(
      result.components.find((component) =>
        component.identity === "resolution-stability")?.outcome,
      "QUERY_ERROR",
    );
    assert.equal(coverageAborted, true);
  });

  it("treats an empty persisted group label set as the single ungrouped Alertmanager group", async () => {
    const urls: URL[] = [];
    const readers = createOpsMonitoringReaders(
      "http://127.0.0.1:9090",
      "http://127.0.0.1:9093",
      async (input) => {
        const url = new URL(input);
        urls.push(url);
        if (url.port === "9093") {
          return jsonResponse([{
            labels: { alertname: "AnyActiveAlert", instance: "local" },
            status: { state: "active" },
          }]);
        }
        return jsonResponse({ status: "success", data: { resultType: "matrix", result: [] } });
      },
    );
    const context = {
      signal: new AbortController().signal,
      taskId: "ungrouped-reader",
      sourceKind: "alertmanager" as const,
      sourceCorrelationKey: CORRELATION_KEY,
      sourceEvidence: [{
        at: NOW,
        kind: "alert" as const,
        trust: "untrusted" as const,
        summary: JSON.stringify({
          type: "alertmanager-group-correlation-v1",
          correlationKey: CORRELATION_KEY,
          groupLabels: {},
        }),
        artifact: null,
      }],
    };

    assert.equal(
      (await readers.incidentAlertmanagerReader.readExactGroupState(context)).status,
      "PRESENT",
    );
    assert.equal(
      (await readers.incidentMonitoringReader.readResolutionStability(context))
        .latestMatchingSampleAt,
      null,
    );
    assert.equal(
      urls.map((url) => url.searchParams.get("query")).find(
        (query) => query?.includes("ALERTS{"),
      ),
      '(max(timestamp(ALERTS{alertstate=~"pending|firing"})))[5m:5s]',
    );
  });

  it("queries all Alertmanager states and treats every matching state as present", async () => {
    const states = [
      { state: "active" },
      { state: "suppressed", silencedBy: ["silence-id"] },
      { state: "suppressed", inhibitedBy: ["inhibitor"] },
      { state: "unprocessed" },
    ];
    for (const status of states) {
      let requested: URL | undefined;
      const readers = createOpsMonitoringReaders(
        "http://127.0.0.1:9090",
        "http://127.0.0.1:9093",
        async (input) => {
          requested = new URL(input);
          return jsonResponse([{
            labels: { alertname: "HostHighCPU", instance: "local", extra: "evidence" },
            status,
          }]);
        },
      );
      const reading = await readers.incidentAlertmanagerReader.readExactGroupState({
        signal: new AbortController().signal,
        taskId: "all-states",
        sourceKind: "alertmanager",
        sourceCorrelationKey: CORRELATION_KEY,
        sourceEvidence: correlationEvidence("HostHighCPU"),
      });
      assert.equal(reading.status, "PRESENT", status.state);
      assert.equal(requested?.pathname, "/api/v2/alerts");
      for (const parameter of ["active", "silenced", "inhibited", "unprocessed"]) {
        assert.equal(requested?.searchParams.get(parameter), "true");
      }
      assert.deepEqual(
        requested?.searchParams.getAll("filter"),
        ['alertname="HostHighCPU"', 'instance="local"'],
      );
    }
  });

  it("matches only the exact persisted group labels and builds bounded Prometheus queries", async () => {
    const now = Date.now();
    const urls: URL[] = [];
    let stabilityValues: unknown[] = [];
    const completeMonitoringCoverage = () => Array.from(
      { length: OPS_INCIDENT_CHECK_LIMITS.stabilityWindowMs / 5_000 + 1 },
      (_, index) => {
        const evaluatedAt = now - OPS_INCIDENT_CHECK_LIMITS.stabilityWindowMs
          + index * 5_000;
        return [evaluatedAt / 1_000, String((evaluatedAt - 1_000) / 1_000)];
      },
    );
    let monitoringCoverageValues: unknown[] = completeMonitoringCoverage();
    let alertResponse: unknown = [{
      labels: { alertname: "Unrelated", instance: "local" },
      status: { state: "active" },
    }];
    const readers = createOpsMonitoringReaders(
      "http://127.0.0.1:9090",
      "http://127.0.0.1:9093",
      async (input) => {
        const url = new URL(input);
        urls.push(url);
        if (url.port === "9093") return jsonResponse(alertResponse);
        const query = url.searchParams.get("query");
        if (query === "(max(timestamp(up)))[2m:5s]") {
          return jsonResponse({
            status: "success",
            data: {
              resultType: "matrix",
              result: [{
                metric: {},
                values: [[now / 1_000, String((now - 30_000) / 1_000)]],
              }],
            },
          });
        }
        if (query === "(max(timestamp(up)))[5m:5s]") {
          return jsonResponse({
            status: "success",
            data: {
              resultType: "matrix",
              result: [{
                metric: {},
                values: monitoringCoverageValues,
              }],
            },
          });
        }
        return jsonResponse({
          status: "success",
          data: {
            resultType: "matrix",
            result: stabilityValues.length === 0
              ? []
              : [{
                  metric: {},
                  values: stabilityValues,
                }],
          },
        });
      },
    );
    const context = {
      signal: new AbortController().signal,
      taskId: "reader-fixture",
      sourceKind: "alertmanager" as const,
      sourceCorrelationKey: CORRELATION_KEY,
      sourceEvidence: correlationEvidence("FutureSyntheticAlert"),
    };

    assert.equal(
      (await readers.incidentAlertmanagerReader.readExactGroupState(context)).status,
      "ABSENT",
    );
    alertResponse = [{
      labels: { alertname: "FutureSyntheticAlert", instance: "local", extra: "ok" },
      status: { state: "active" },
    }];
    assert.equal(
      (await readers.incidentAlertmanagerReader.readExactGroupState(context)).status,
      "PRESENT",
    );
    assert.ok((await readers.incidentMonitoringReader.readMonitoringFreshness(context)).latestSampleAt);
    const stableReading = await readers.incidentMonitoringReader
      .readResolutionStability(context);
    assert.equal(stableReading.latestMatchingSampleAt, null);
    assert.equal(
      stableReading.monitoringWindowStartedAt,
      new Date(
        Date.parse(stableReading.observedAt)
          - OPS_INCIDENT_CHECK_LIMITS.stabilityWindowMs,
      ).toISOString(),
    );
    monitoringCoverageValues = [
      completeMonitoringCoverage()[0],
      completeMonitoringCoverage().at(-1),
    ];
    assert.equal(
      (await readers.incidentMonitoringReader.readResolutionStability(context))
        .monitoringWindowStartedAt,
      null,
      "a sparse start/end pair must not prove continuous monitoring coverage",
    );
    monitoringCoverageValues = completeMonitoringCoverage();
    const staleIndex = Math.floor(monitoringCoverageValues.length / 2);
    const staleEvaluation = monitoringCoverageValues[staleIndex] as [number, string];
    monitoringCoverageValues[staleIndex] = [
      staleEvaluation[0],
      String(
        staleEvaluation[0]
          - OPS_INCIDENT_CHECK_LIMITS.monitoringFreshnessMs / 1_000
          - 1,
      ),
    ];
    assert.equal(
      (await readers.incidentMonitoringReader.readResolutionStability(context))
        .monitoringWindowStartedAt,
      null,
      "a carried stale up value must not prove monitoring coverage through an outage",
    );
    monitoringCoverageValues = completeMonitoringCoverage();
    const stabilityQuery = urls.map((url) => url.searchParams.get("query")).find(
      (query) => query?.includes("ALERTS{"),
    );
    assert.equal(
      stabilityQuery,
      '(max(timestamp(ALERTS{alertname="FutureSyntheticAlert",instance="local",alertstate=~"pending|firing"})))[5m:5s]',
    );

    const quotedLabelContext = {
      ...context,
      sourceEvidence: correlationEvidence(
        "FutureSyntheticAlert",
        { "service.name": "edge", "团队": "值" },
      ),
    };
    const quotedRequestStart = urls.length;
    await readers.incidentAlertmanagerReader.readExactGroupState(quotedLabelContext);
    await readers.incidentMonitoringReader.readResolutionStability(quotedLabelContext);
    const quotedRequests = urls.slice(quotedRequestStart);
    const alertmanagerRequest = quotedRequests.find((url) => url.port === "9093");
    assert.deepEqual(
      new Set(alertmanagerRequest?.searchParams.getAll("filter")),
      new Set(['"service.name"="edge"', '"团队"="值"']),
    );
    const quotedPrometheusQuery = quotedRequests
      .map((url) => url.searchParams.get("query"))
      .find((query) => query?.includes("ALERTS{"));
    assert.match(quotedPrometheusQuery ?? "", /"service\.name"="edge"/);
    assert.match(quotedPrometheusQuery ?? "", /"团队"="值"/);

    stabilityValues = [[now / 1_000, String((now - 60_000) / 1_000)]];
    const latest = await readers.incidentMonitoringReader.readResolutionStability(context);
    assert.equal(latest.latestMatchingSampleAt, new Date(now - 60_000).toISOString());
    alertResponse = [{
      labels: { alertname: "Unrelated", instance: "local" },
      status: { state: "active" },
    }];
    const registry = createOpsIncidentDoneCheckRegistry({
      clock: () => new Date(now + 1_000),
      ...readers,
    });
    const waiting = await registry.run(
      { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
      {
        ...context,
        checkedAt: new Date(now + 1_000).toISOString(),
        now: () => new Date(now + 1_000),
      },
    );
    assert.equal(waiting.result, "NOT_READY");
    assert.equal(waiting.nextCheckAt, new Date(now + 4 * 60_000).toISOString());

    stabilityValues = [[
      now / 1_000,
      String((now - OPS_INCIDENT_CHECK_LIMITS.stabilityWindowMs) / 1_000),
    ]];
    const boundary = await registry.run(
      { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
      {
        ...context,
        checkedAt: new Date(now + 1_000).toISOString(),
        now: () => new Date(now + 1_000),
      },
    );
    assert.equal(boundary.result, "PASS");

    stabilityValues = [[now / 1_000, "not-a-number"]];
    await assert.rejects(
      async () => await readers.incidentMonitoringReader.readResolutionStability(context),
      /non-finite sample/,
    );
  });

  it("aggregates global Prometheus freshness and accepts source cardinality above the intake bound", async () => {
    const now = Date.now();
    const urls: URL[] = [];
    const readers = createOpsMonitoringReaders(
      "http://127.0.0.1:9090",
      "http://127.0.0.1:9093",
      async (input) => {
        const url = new URL(input);
        urls.push(url);
        if (url.port === "9093") {
          return jsonResponse(Array.from(
            { length: 1_025 },
            (_, index) => ({
              labels: { alertname: `BoundedAlert${index}` },
              status: { state: "active" },
            }),
          ));
        }
        return jsonResponse({
          status: "success",
          data: {
            resultType: "matrix",
            result: [{
              metric: {},
              values: [[now / 1_000, String((now - 15_000) / 1_000)]],
            }],
          },
        });
      },
    );
    const context = {
      signal: new AbortController().signal,
      taskId: "full-cardinality-reader",
      sourceKind: "alertmanager" as const,
      sourceCorrelationKey: CORRELATION_KEY,
      sourceEvidence: [{
        at: NOW,
        kind: "alert" as const,
        trust: "untrusted" as const,
        summary: JSON.stringify({
          type: "alertmanager-group-correlation-v1",
          correlationKey: CORRELATION_KEY,
          groupLabels: {},
        }),
        artifact: null,
      }],
    };

    assert.ok((await readers.incidentMonitoringReader.readMonitoringFreshness(context)).latestSampleAt);
    assert.equal(
      (await readers.incidentAlertmanagerReader.readExactGroupState(context)).status,
      "PRESENT",
    );
    assert.equal(
      urls.find((url) => url.port === "9090")?.searchParams.get("query"),
      "(max(timestamp(up)))[2m:5s]",
    );
  });

  it("rejects non-loopback endpoints and bounded-response violations", async () => {
    for (const baseUrl of [
      "https://127.0.0.1:9090",
      "http://localhost:9090",
      "http://127.0.0.1:9090/path",
      "http://user:secret@127.0.0.1:9090",
    ]) {
      assert.throws(
        () => createOpsMonitoringReaders(
          baseUrl,
          "http://127.0.0.1:9093",
          async () => jsonResponse({}),
        ),
        /loopback HTTP base URL/,
      );
    }

    const readers = createOpsMonitoringReaders(
      "http://127.0.0.1:9090",
      "http://127.0.0.1:9093",
      async () => new Response("x".repeat(OPS_INCIDENT_CHECK_LIMITS.maxResponseBytes + 1), {
        headers: { "content-type": "application/json" },
      }),
    );
    await assert.rejects(
      async () => await readers.incidentMonitoringReader.readMonitoringFreshness({
        signal: new AbortController().signal,
        taskId: "oversized",
      }),
      /byte bound/,
    );

    const context = {
      signal: new AbortController().signal,
      taskId: "invalid-reader-boundary",
      sourceKind: "alertmanager" as const,
      sourceCorrelationKey: CORRELATION_KEY,
      sourceEvidence: correlationEvidence("InvalidReaderBoundary"),
    };
    const prometheusEnvelope = (result: unknown) => ({
      status: "success",
      data: { resultType: "matrix", result },
    });
    const cases: Array<{
      name: string;
      response: Response;
      reader: "alertmanager" | "prometheus";
    }> = [
      {
        name: "non-success status",
        response: jsonResponse({}, 503),
        reader: "prometheus",
      },
      {
        name: "wrong content type",
        response: new Response("{}", { headers: { "content-type": "text/plain" } }),
        reader: "prometheus",
      },
      {
        name: "malformed JSON",
        response: new Response("{", { headers: { "content-type": "application/json" } }),
        reader: "prometheus",
      },
      {
        name: "invalid Alertmanager labels",
        response: jsonResponse([{ labels: { "": "invalid" }, status: { state: "active" } }]),
        reader: "alertmanager",
      },
      {
        name: "invalid Alertmanager state",
        response: jsonResponse([{ labels: {}, status: { state: "resolved" } }]),
        reader: "alertmanager",
      },
      {
        name: "excessive Prometheus series",
        response: jsonResponse(prometheusEnvelope([
          { metric: { series: "one" }, values: [] },
          { metric: { series: "two" }, values: [] },
        ])),
        reader: "prometheus",
      },
      {
        name: "excessive Prometheus samples",
        response: jsonResponse(prometheusEnvelope([{
          metric: {},
          values: Array.from(
            { length: OPS_INCIDENT_CHECK_LIMITS.maxPrometheusSamplesPerSeries + 1 },
            () => [Date.now() / 1_000, "1"],
          ),
        }])),
        reader: "prometheus",
      },
    ];
    for (const boundary of cases) {
      const invalidReaders = createOpsMonitoringReaders(
        "http://127.0.0.1:9090",
        "http://127.0.0.1:9093",
        async () => boundary.response.clone(),
      );
      await assert.rejects(async () => {
        if (boundary.reader === "alertmanager") {
          await invalidReaders.incidentAlertmanagerReader.readExactGroupState(context);
        } else {
          await invalidReaders.incidentMonitoringReader.readMonitoringFreshness(context);
        }
      }, boundary.name);
    }

    const failingReaders = createOpsMonitoringReaders(
      "http://127.0.0.1:9090",
      "http://127.0.0.1:9093",
      async () => jsonResponse({}, 503),
    );
    const registry = createOpsIncidentDoneCheckRegistry({
      clock: () => new Date(NOW),
      ...failingReaders,
    });
    const result = await registry.run(
      { name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME, params: {} },
      { ...context, checkedAt: NOW, now: () => new Date(NOW) },
    );
    assert.equal(result.result, "QUERY_ERROR");
  });
});
