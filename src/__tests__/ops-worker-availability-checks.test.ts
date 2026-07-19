import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OPS_AVAILABILITY_DONE_CHECK_NAME,
  OPS_AVAILABILITY_LIMITS,
  OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
  OpsAlertmanagerHttpReader,
  OpsPrometheusHttpReader,
  createOpsAvailabilityDoneCheckRegistry,
  type OpsAvailabilityReaderContext,
  type OpsAlertStateReading,
  type OpsMonitoringFreshnessReading,
  type OpsServiceAvailabilityReading,
} from "../ops-worker/availability-checks.js";
import type { JsonObject, OpsWorkerEvidence } from "../ops-worker/types.js";

const NOW = "2026-07-19T12:00:00.000Z";
const ONE_MINUTE_AGO = "2026-07-19T11:59:00.000Z";
const SIX_MINUTES_AGO = "2026-07-19T11:54:00.000Z";
const ONE_MINUTE_LATER = "2026-07-19T12:01:00.000Z";
const PARAMS = { invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT };

interface Readings {
  monitoring: unknown;
  alerts: unknown;
  service: unknown;
}

function healthyReadings(): Readings {
  return {
    monitoring: {
      observedAt: NOW,
      latestSampleAt: ONE_MINUTE_AGO,
    } satisfies OpsMonitoringFreshnessReading,
    alerts: {
      observedAt: NOW,
      status: "RESOLVED",
    } satisfies OpsAlertStateReading,
    service: {
      observedAt: NOW,
      status: "HEALTHY",
      healthySince: SIX_MINUTES_AGO,
    } satisfies OpsServiceAvailabilityReading,
  };
}

function registry(readings: Readings) {
  return createOpsAvailabilityDoneCheckRegistry({
    clock: () => new Date(NOW),
    monitoringFreshnessReader: {
      readMonitoringFreshness: async () => structuredClone(readings.monitoring) as OpsMonitoringFreshnessReading,
    },
    alertStateReader: {
      read: async () => structuredClone(readings.alerts) as OpsAlertStateReading,
    },
    serviceAvailabilityReader: {
      readServiceAvailability: async () => structuredClone(readings.service) as OpsServiceAvailabilityReading,
    },
  });
}

async function run(readings = healthyReadings()) {
  return registry(readings).run(
    { name: OPS_AVAILABILITY_DONE_CHECK_NAME, params: PARAMS },
    { taskId: "ops-availability-fixture", checkedAt: NOW, now: () => new Date(NOW) },
  );
}

describe("package-owned ops availability done check", () => {
  it("requires all three fresh components before aggregate PASS", async () => {
    const result = await run();

    assert.equal(result.result, "PASS");
    assert.equal(result.verifierIdentity, "ops.minime-availability");
    assert.equal(result.verifierVersion, "1");
    assert.match(result.contractHash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(
      result.components.map(({ identity, required, convergence, outcome }) => ({
        identity,
        required,
        convergence,
        outcome,
      })),
      [
        {
          identity: "monitoring-freshness",
          required: true,
          convergence: "PRODUCT",
          outcome: "PASS",
        },
        {
          identity: "alert-state",
          required: true,
          convergence: "PASSIVE",
          outcome: "PASS",
        },
        {
          identity: "service-stability",
          required: true,
          convergence: "PRODUCT",
          outcome: "PASS",
        },
      ],
    );
  });

  it("treats monitoring silence and stale evidence as NOT_READY, never health", async () => {
    for (const latestSampleAt of [null, "2026-07-19T11:57:59.999Z"]) {
      const readings = healthyReadings();
      readings.monitoring = { observedAt: NOW, latestSampleAt };
      const result = await run(readings);
      assert.equal(result.result, "NOT_READY");
      assert.equal(result.components[0].outcome, "NOT_READY");
      assert.equal(result.nextCheckAt, null);
    }

    const staleAlertQuery = healthyReadings();
    staleAlertQuery.alerts = {
      observedAt: "2026-07-19T11:58:59.999Z",
      status: "RESOLVED",
    };
    const staleAlertResult = await run(staleAlertQuery);
    assert.equal(staleAlertResult.result, "NOT_READY");
    assert.equal(staleAlertResult.nextCheckAt, ONE_MINUTE_LATER);

    const staleServiceObservation = healthyReadings();
    staleServiceObservation.service = {
      observedAt: "2026-07-19T11:58:59.999Z",
      status: "HEALTHY",
      healthySince: SIX_MINUTES_AGO,
    };
    const staleServiceResult = await run(staleServiceObservation);
    assert.equal(staleServiceResult.result, "NOT_READY");
    assert.equal(staleServiceResult.nextCheckAt, null);

    const mixedProductConvergence = healthyReadings();
    mixedProductConvergence.monitoring = { observedAt: NOW, latestSampleAt: null };
    mixedProductConvergence.service = {
      observedAt: NOW,
      status: "HEALTHY",
      healthySince: "2026-07-19T11:58:00.000Z",
    };
    const mixedResult = await run(mixedProductConvergence);
    assert.equal(mixedResult.result, "NOT_READY");
    assert.equal(mixedResult.components[0].nextCheckAt, null);
    assert.equal(mixedResult.components[2].nextCheckAt, "2026-07-19T12:03:00.000Z");
    assert.equal(mixedResult.nextCheckAt, null);
  });

  it("defers a fresh firing alert and schedules passive convergence", async () => {
    const readings = healthyReadings();
    readings.alerts = { observedAt: NOW, status: "FIRING" };

    const result = await run(readings);
    assert.equal(result.result, "DEFER");
    assert.equal(result.components[1].outcome, "DEFER");
    assert.equal(result.nextCheckAt, ONE_MINUTE_LATER);
  });

  it("distinguishes a short healthy streak from direct product failure", async () => {
    const short = healthyReadings();
    short.service = {
      observedAt: NOW,
      status: "HEALTHY",
      healthySince: "2026-07-19T11:58:00.000Z",
    };
    const notReady = await run(short);
    assert.equal(notReady.result, "NOT_READY");
    assert.equal(notReady.components[2].outcome, "NOT_READY");
    assert.equal(notReady.nextCheckAt, "2026-07-19T12:03:00.000Z");

    const unhealthy = healthyReadings();
    unhealthy.service = {
      observedAt: NOW,
      status: "UNHEALTHY",
      healthySince: null,
    };
    const failed = await run(unhealthy);
    assert.equal(failed.result, "PRODUCT_FAILURE");
    assert.equal(failed.components[2].outcome, "PRODUCT_FAILURE");
    assert.equal(failed.nextCheckAt, null);
  });

  it("maps reader failures to QUERY_ERROR and malformed output to VERIFIER_INVALID", async () => {
    const queryFailure = createOpsAvailabilityDoneCheckRegistry({
      clock: () => new Date(NOW),
      monitoringFreshnessReader: { readMonitoringFreshness: async () => { throw new Error("offline"); } },
      alertStateReader: { read: async () => healthyReadings().alerts as OpsAlertStateReading },
      serviceAvailabilityReader: {
        readServiceAvailability: async () => healthyReadings().service as OpsServiceAvailabilityReading,
      },
    });
    const queryResult = await queryFailure.run(
      { name: OPS_AVAILABILITY_DONE_CHECK_NAME, params: PARAMS },
      { taskId: "query-error", checkedAt: NOW, now: () => new Date(NOW) },
    );
    assert.equal(queryResult.result, "QUERY_ERROR");
    assert.equal(queryResult.components[0].outcome, "QUERY_ERROR");

    for (const malformed of [
      { observedAt: NOW, latestSampleAt: ONE_MINUTE_AGO, url: "http://example.invalid" },
      { observedAt: NOW, latestSampleAt: "not-a-timestamp" },
      null,
    ]) {
      const readings = healthyReadings();
      readings.monitoring = malformed;
      const result = await run(readings);
      assert.equal(result.result, "VERIFIER_INVALID");
      assert.equal(result.components[0].outcome, "VERIFIER_INVALID");
    }
  });

  it("fails through the typed query path when the trusted clock is invalid", async () => {
    const checks = createOpsAvailabilityDoneCheckRegistry({
      clock: () => new Date(Number.NaN),
      monitoringFreshnessReader: {
        readMonitoringFreshness: async () => healthyReadings().monitoring as OpsMonitoringFreshnessReading,
      },
      alertStateReader: {
        read: async () => healthyReadings().alerts as OpsAlertStateReading,
      },
      serviceAvailabilityReader: {
        readServiceAvailability: async () => healthyReadings().service as OpsServiceAvailabilityReading,
      },
    });
    const result = await checks.run(
      { name: OPS_AVAILABILITY_DONE_CHECK_NAME, params: PARAMS },
      { taskId: "invalid-clock", checkedAt: NOW, now: () => new Date(NOW) },
    );
    assert.equal(result.result, "QUERY_ERROR");
    assert.equal(result.components.every((component) => component.outcome === "QUERY_ERROR"), true);
  });

  it("accepts only the bounded closed invariant parameter", async () => {
    let calls = 0;
    const checks = createOpsAvailabilityDoneCheckRegistry({
      clock: () => new Date(NOW),
      monitoringFreshnessReader: { readMonitoringFreshness: async () => { calls += 1; return healthyReadings().monitoring as OpsMonitoringFreshnessReading; } },
      alertStateReader: { read: async () => { calls += 1; return healthyReadings().alerts as OpsAlertStateReading; } },
      serviceAvailabilityReader: { readServiceAvailability: async () => { calls += 1; return healthyReadings().service as OpsServiceAvailabilityReading; } },
    });
    for (const params of [
      {},
      { invariant: "unknown-invariant" },
      { invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT, url: "http://127.0.0.1" },
      { invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT, components: ["alert-state"] },
      { invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT, command: "true" },
    ] as JsonObject[]) {
      const result = await checks.run(
        { name: OPS_AVAILABILITY_DONE_CHECK_NAME, params },
        { taskId: "invalid-params", checkedAt: NOW, now: () => new Date(NOW) },
      );
      assert.equal(result.result, "VERIFIER_INVALID");
    }
    assert.equal(calls, 0);
  });
});

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...init.headers },
    ...init,
  });
}

function prometheusVector(value: Array<{ at: number; value: string }>): unknown {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: value.map((entry) => ({
        metric: { job: "minime-bot" },
        value: [entry.at, entry.value],
      })),
    },
  };
}

function prometheusMatrix(
  series: Array<{
    labels?: Record<string, string>;
    values: Array<{ at: number; value: string }>;
  }>,
): unknown {
  return {
    status: "success",
    data: {
      resultType: "matrix",
      result: series.map((entry) => ({
        metric: entry.labels ?? { job: "minime-bot" },
        values: entry.values.map((sample) => [sample.at, sample.value]),
      })),
    },
  };
}

const ALERT_CORRELATION_KEY = `fixture:group:${"a".repeat(64)}`;
const ALERT_CORRELATION_EVIDENCE: OpsWorkerEvidence[] = [{
  at: NOW,
  kind: "alert",
  trust: "untrusted",
  summary: JSON.stringify({
    type: "alertmanager-group-correlation-v1",
    correlationKey: ALERT_CORRELATION_KEY,
    groupLabels: { alertname: "MinimeBotUnavailable", instance: "local" },
  }),
  artifact: null,
}];

function readerContext(): OpsAvailabilityReaderContext {
  return {
    signal: new AbortController().signal,
    taskId: "ops-availability-fixture",
    sourceKind: "alertmanager",
    sourceCorrelationKey: ALERT_CORRELATION_KEY,
    sourceEvidence: ALERT_CORRELATION_EVIDENCE,
  };
}

describe("bounded loopback availability readers", () => {
  it("queries Alertmanager and Prometheus through injected fetch only", async () => {
    const alertRequests: string[] = [];
    const alertReader = new OpsAlertmanagerHttpReader(
      "http://127.0.0.1:9093",
      async (input) => {
        alertRequests.push(String(input));
        return jsonResponse([]);
      },
    );
    const alerts = await alertReader.read(
      OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      readerContext(),
    );
    assert.equal(alerts.status, "RESOLVED");
    assert.equal(alertRequests.length, 1);
    assert.match(alertRequests[0], /^http:\/\/127\.0\.0\.1:9093\/api\/v2\/alerts\?/);
    assert.doesNotMatch(alertRequests[0], /filter=/);

    const queries: string[] = [];
    const responses = [
      prometheusMatrix([{
        values: [{ at: Date.parse(NOW) / 1_000, value: "1" }],
      }]),
      prometheusVector([{ at: Date.parse(NOW) / 1_000, value: "1" }]),
      prometheusMatrix([{
        values: Array.from({ length: 21 }, (_, index) => ({
          at: (Date.parse(NOW) - OPS_AVAILABILITY_LIMITS.stabilityWindowMs) / 1_000
            + index * OPS_AVAILABILITY_LIMITS.prometheusStabilityStepSeconds,
          value: "1",
        })),
      }]),
    ];
    const prometheus = new OpsPrometheusHttpReader(
      "http://[::1]:9090",
      async (input) => {
        queries.push(String(input));
        const response = responses.shift();
        assert.ok(response);
        return jsonResponse(response);
      },
    );
    const monitoring = await prometheus.readMonitoringFreshness(
      OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      readerContext(),
    );
    const service = await prometheus.readServiceAvailability(
      OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      readerContext(),
    );
    assert.equal(monitoring.latestSampleAt, NOW);
    assert.equal(service.status, "HEALTHY");
    assert.equal(
      Date.parse(service.observedAt) - Date.parse(service.healthySince as string),
      OPS_AVAILABILITY_LIMITS.stabilityWindowMs,
    );
    assert.equal(queries.length, 3);
    assert.equal(queries.filter((query) => query.includes("/api/v1/query?")).length, 3);
    assert.equal(queries.filter((query) => query.includes("/api/v1/query_range?")).length, 0);
    assert.equal(queries.some((query) => query.includes(encodeURIComponent("[315s]"))), true);
  });

  it("maps Prometheus silence and zero directly without a stability query", async () => {
    const responses = [
      prometheusMatrix([]),
      prometheusVector([]),
      prometheusVector([{ at: Date.parse(NOW) / 1_000, value: "0" }]),
    ];
    let calls = 0;
    const reader = new OpsPrometheusHttpReader(
      "http://127.0.0.1:9090",
      async () => {
        calls += 1;
        return jsonResponse(responses.shift());
      },
    );

    const monitoring = await reader.readMonitoringFreshness(
      OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      readerContext(),
    );
    const silent = await reader.readServiceAvailability(
      OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      readerContext(),
    );
    const unhealthy = await reader.readServiceAvailability(
      OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      readerContext(),
    );

    assert.equal(monitoring.latestSampleAt, null);
    assert.equal(silent.status, "UNKNOWN");
    assert.equal(silent.healthySince, null);
    assert.equal(unhealthy.status, "UNHEALTHY");
    assert.equal(unhealthy.healthySince, null);
    assert.equal(calls, 3);
  });

  it("rejects remote endpoints and strict HTTP/JSON contract violations without retrying", async () => {
    assert.throws(
      () => new OpsAlertmanagerHttpReader("https://alerts.example.invalid", async () => new Response()),
      /loopback HTTP base URL/,
    );
    assert.throws(
      () => new OpsPrometheusHttpReader("http://localhost:9090", async () => new Response()),
      /loopback HTTP base URL/,
    );

    for (const response of [
      new Response("[]", { headers: { "content-type": "text/plain" } }),
      new Response("x".repeat(OPS_AVAILABILITY_LIMITS.maxResponseBytes + 1), {
        headers: { "content-type": "application/json" },
      }),
      jsonResponse({ unexpected: true }),
    ]) {
      let calls = 0;
      const reader = new OpsAlertmanagerHttpReader(
        "http://127.0.0.1:9093",
        async () => { calls += 1; return response; },
      );
      await assert.rejects(
        reader.read(OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT, {
          ...readerContext(),
        }),
      );
      assert.equal(calls, 1);
    }
  });

  it("matches only the task's correlated Alertmanager group, including suppressed alerts", async () => {
    const reader = new OpsAlertmanagerHttpReader(
      "http://127.0.0.1:9093",
      async () => jsonResponse([
        {
          labels: { alertname: "OtherAlert", instance: "other" },
          status: { state: "active" },
        },
        {
          labels: { alertname: "MinimeBotUnavailable", instance: "local" },
          status: { state: "suppressed" },
        },
      ]),
    );
    const firing = await reader.read(
      OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      readerContext(),
    );
    assert.equal(firing.status, "FIRING");

    const unrelated = new OpsAlertmanagerHttpReader(
      "http://127.0.0.1:9093",
      async () => jsonResponse([{
        labels: { alertname: "MinimeBotUnavailable", instance: "different" },
        status: { state: "active" },
      }]),
    );
    assert.equal((await unrelated.read(
      OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      readerContext(),
    )).status, "RESOLVED");

    const operatorReader = new OpsAlertmanagerHttpReader(
      "http://127.0.0.1:9093",
      async () => jsonResponse([{
        labels: { alertname: "MinimeBotMetricsDown", instance: "local" },
        status: { state: "active" },
      }]),
    );
    assert.equal((await operatorReader.read(
      OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      {
        signal: new AbortController().signal,
        taskId: "operator-availability-fixture",
        sourceKind: "operator-cli",
      },
    )).status, "FIRING");
  });

  it("requires identical series and a complete fixed-step stability window", async () => {
    const direct = prometheusVector([{ at: Date.parse(NOW) / 1_000, value: "1" }]);
    for (const matrix of [
      prometheusMatrix([{
        labels: { job: "minime-bot", instance: "replacement" },
        values: Array.from({ length: 21 }, (_, index) => ({
          at: (Date.parse(NOW) - OPS_AVAILABILITY_LIMITS.stabilityWindowMs) / 1_000
            + index * OPS_AVAILABILITY_LIMITS.prometheusStabilityStepSeconds,
          value: "1",
        })),
      }]),
      prometheusMatrix([{
        values: Array.from({ length: 20 }, (_, index) => ({
          at: (Date.parse(NOW) - OPS_AVAILABILITY_LIMITS.stabilityWindowMs) / 1_000
            + (index + 1) * OPS_AVAILABILITY_LIMITS.prometheusStabilityStepSeconds,
          value: "1",
        })),
      }]),
    ]) {
      const responses = [direct, matrix];
      const reader = new OpsPrometheusHttpReader(
        "http://127.0.0.1:9090",
        async () => jsonResponse(responses.shift()),
      );
      const reading = await reader.readServiceAvailability(
        OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
        readerContext(),
      );
      assert.equal(reading.status, "HEALTHY");
      assert.equal(reading.healthySince, reading.observedAt);
    }
  });
});
