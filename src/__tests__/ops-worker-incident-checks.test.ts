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
import type { OpsWorkerEvidence } from "../ops-worker/types.js";

const NOW = "2026-07-22T12:00:00.000Z";
const ONE_MINUTE_AGO = "2026-07-22T11:59:00.000Z";
const FOUR_MINUTES_LATER = "2026-07-22T12:04:00.000Z";
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

function correlationEvidence(alertname: string): OpsWorkerEvidence[] {
  return [{
    at: NOW,
    kind: "alert",
    trust: "untrusted",
    summary: JSON.stringify({
      type: "alertmanager-group-correlation-v1",
      correlationKey: CORRELATION_KEY,
      groupLabels: { alertname, instance: "local" },
    }),
    artifact: null,
  }];
}

function healthyReadings(): {
  freshness: OpsIncidentMonitoringFreshnessReading;
  alerts: OpsIncidentAlertStateReading;
  stability: OpsIncidentResolutionStabilityReading;
} {
  return {
    freshness: { observedAt: NOW, latestSampleAt: ONE_MINUTE_AGO },
    alerts: { observedAt: NOW, status: "ABSENT" },
    stability: { observedAt: NOW, latestMatchingSampleAt: null },
  };
}

async function runIncident(
  readings: ReturnType<typeof healthyReadings>,
  alertname = "FutureSyntheticAlert",
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
      sourceEvidence: correlationEvidence(alertname),
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

  it("disproves a claim while the exact group remains present", async () => {
    const readings = healthyReadings();
    readings.alerts.status = "PRESENT";

    const result = await runIncident(readings);

    assert.equal(result.result, "PRODUCT_FAILURE");
    assert.equal(result.nextCheckAt, null);
    assert.equal(result.components[1].outcome, "PRODUCT_FAILURE");
    assert.match(result.summary, /exact-group-absence=PRODUCT_FAILURE/);
  });

  it("schedules stale telemetry and flap stability waits without a failure outcome", async () => {
    const stale = healthyReadings();
    stale.freshness.latestSampleAt = "2026-07-22T11:57:59.999Z";
    const staleResult = await runIncident(stale);
    assert.equal(staleResult.result, "NOT_READY");
    assert.equal(staleResult.nextCheckAt, RECHECK);

    const flap = healthyReadings();
    flap.stability.latestMatchingSampleAt = ONE_MINUTE_AGO;
    const flapResult = await runIncident(flap);
    assert.equal(flapResult.result, "NOT_READY");
    assert.equal(flapResult.nextCheckAt, FOUR_MINUTES_LATER);
    assert.equal(flapResult.components[2].outcome, "NOT_READY");
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
    }
  });

  it("matches only the exact persisted group labels and builds bounded Prometheus queries", async () => {
    const now = Date.now();
    const urls: URL[] = [];
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
        if (query === "up[2m]") {
          return jsonResponse({
            status: "success",
            data: {
              resultType: "matrix",
              result: [{ metric: { job: "prometheus" }, values: [[(now - 30_000) / 1_000, "1"]] }],
            },
          });
        }
        return jsonResponse({
          status: "success",
          data: { resultType: "matrix", result: [] },
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
    assert.equal(
      (await readers.incidentMonitoringReader.readResolutionStability(context))
        .latestMatchingSampleAt,
      null,
    );
    const stabilityQuery = urls.map((url) => url.searchParams.get("query")).find(
      (query) => query?.startsWith("ALERTS{"),
    );
    assert.equal(
      stabilityQuery,
      'ALERTS{alertname="FutureSyntheticAlert",instance="local",alertstate=~"pending|firing"}[5m]',
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
  });
});
