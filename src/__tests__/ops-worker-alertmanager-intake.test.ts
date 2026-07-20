import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  OPS_ALERTMANAGER_INTAKE_LIMITS,
  OpsWorkerAlertmanagerIntake,
  OpsWorkerAlertmanagerIntakeError,
  parseOpsAlertmanagerWebhook,
} from "../ops-worker/alertmanager-intake.js";
import {
  OPS_AVAILABILITY_DONE_CHECK_NAME,
  OPS_AVAILABILITY_INVARIANTS,
  OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
  type OpsAlertStateReading,
  type OpsMonitoringFreshnessReading,
  type OpsServiceAvailabilityReading,
} from "../ops-worker/availability-checks.js";
import {
  OPS_AVAILABILITY_TEMPLATE_NAME,
  OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
  createOpsTaskContracts,
  hashOpsAlertmanagerAuthorizationSnapshot,
} from "../ops-worker/ops-contracts.js";
import {
  inspectOpsWorkerPolicy,
  startOpsWorkerStatusServer,
} from "../ops-worker/status-server.js";
import type { OpsWorkerSupervisor } from "../ops-worker/supervisor.js";
import { OpsWorkerTaskStore } from "../ops-worker/task-store.js";

const NOW = "2026-07-19T10:00:00.000Z";
const LATER = "2026-07-19T10:01:00.000Z";
const SOURCE_IDENTITY = "lab-alertmanager";
const CONTENT_TYPE = "application/json; charset=utf-8";

function contracts() {
  return createOpsTaskContracts({
    alertmanagerAuthorizationSnapshotReader: {
      read: () => ({
        sourceIdentity: SOURCE_IDENTITY,
        invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
        template: OPS_AVAILABILITY_TEMPLATE_NAME,
        profile: OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
      }),
    },
    clock: () => new Date(NOW),
    monitoringFreshnessReader: {
      readMonitoringFreshness: () => ({
        observedAt: NOW,
        latestSampleAt: NOW,
      } satisfies OpsMonitoringFreshnessReading),
    },
    alertStateReader: {
      read: () => ({
        observedAt: NOW,
        status: "RESOLVED",
      } satisfies OpsAlertStateReading),
    },
    serviceAvailabilityReader: {
      readServiceAvailability: () => ({
        observedAt: NOW,
        status: "HEALTHY",
        healthySince: "2026-07-19T09:50:00.000Z",
      } satisfies OpsServiceAvailabilityReading),
    },
  });
}

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "minime-alertmanager-intake-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const taskContracts = contracts();
  const store = new OpsWorkerTaskStore(directory, {
    registry: taskContracts.taskRegistry,
    now: () => new Date(NOW),
  });
  const intake = new OpsWorkerAlertmanagerIntake({
    store,
    doneChecks: taskContracts.doneChecks,
    sourceIdentity: SOURCE_IDENTITY,
    now: () => new Date(NOW),
  });
  return { directory, intake, store, taskContracts };
}

function alert(
  startsAt = "2026-07-19T09:59:00.000Z",
  status: "firing" | "resolved" = "firing",
) {
  return {
    status,
    labels: {
      alertname: "MinimeBotUnavailable",
      instance: "local",
    },
    annotations: {
      summary: "The generic local service is unavailable.",
    },
    startsAt,
    endsAt: status === "resolved" ? NOW : "0001-01-01T00:00:00Z",
    generatorURL: "http://127.0.0.1:9090/graph?g0.expr=up",
    fingerprint: "0123456789abcdef",
  };
}

function webhook(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    receiver: "ops-worker",
    status: "firing",
    alerts: [alert()],
    groupLabels: { alertname: "MinimeBotUnavailable" },
    commonLabels: { alertname: "MinimeBotUnavailable", instance: "local" },
    commonAnnotations: { summary: "The generic local service is unavailable." },
    externalURL: "http://127.0.0.1:9093",
    version: "4",
    groupKey: "{}:{alertname=\"MinimeBotUnavailable\", instance=\"local\"}",
    truncatedAlerts: 0,
    ...overrides,
  };
}

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function expectIntakeError(
  callback: () => unknown,
  code: OpsWorkerAlertmanagerIntakeError["code"],
): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof OpsWorkerAlertmanagerIntakeError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("strict bounded Alertmanager v4 intake parsing", () => {
  it("accepts the exact bounded v4 webhook shape", () => {
    const parsed = parseOpsAlertmanagerWebhook(body(webhook()), CONTENT_TYPE);

    assert.equal(parsed.version, "4");
    assert.equal(parsed.status, "firing");
    assert.equal(parsed.alerts.length, 1);
    assert.equal(parsed.alerts[0].labels.alertname, "MinimeBotUnavailable");
  });

  it("rejects non-objects, malformed JSON, wrong media types, and unknown versions", () => {
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body([]), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(Buffer.from("{", "utf8"), CONTENT_TYPE),
      "MALFORMED_JSON",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(Buffer.from([0x7b, 0xff, 0x7d]), CONTENT_TYPE),
      "MALFORMED_JSON",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body(webhook()), "text/plain"),
      "UNSUPPORTED_MEDIA_TYPE",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body(webhook({ version: "5" })), CONTENT_TYPE),
      "UNSUPPORTED_VERSION",
    );
  });

  it("enforces the 256 KiB body cap and every alert/map bound", () => {
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(
        Buffer.alloc(OPS_ALERTMANAGER_INTAKE_LIMITS.maxBodyBytes + 1, 0x20),
        CONTENT_TYPE,
      ),
      "BODY_TOO_LARGE",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body(webhook({ unexpected: true })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body(webhook({
        alerts: Array.from(
          { length: OPS_ALERTMANAGER_INTAKE_LIMITS.maxAlerts + 1 },
          () => alert(),
        ),
      })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body(webhook({
        alerts: [{
          ...alert(),
          labels: Object.fromEntries(Array.from(
            { length: OPS_ALERTMANAGER_INTAKE_LIMITS.maxLabelEntries + 1 },
            (_, index) => [`label_${index}`, "value"],
          )),
        }],
      })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body(webhook({
        alerts: [{
          ...alert(),
          annotations: { summary: "x".repeat(
            OPS_ALERTMANAGER_INTAKE_LIMITS.maxAnnotationValueBytes + 1,
          ) },
        }],
      })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
  });

  it("rejects inconsistent status, invalid timestamps, and malformed alert fields", () => {
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body(webhook({
        status: "resolved",
        alerts: [alert(undefined, "firing")],
      })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body(webhook({
        alerts: [{ ...alert(), startsAt: "yesterday" }],
      })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    expectIntakeError(
      () => parseOpsAlertmanagerWebhook(body(webhook({
        alerts: [{ ...alert(), labels: [] }],
      })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
  });
});

describe("Alertmanager conversion and task-store submission", () => {
  it("submits only trusted registered task authority with bounded untrusted evidence", (t) => {
    const { intake, store } = fixture(t);
    const result = intake.submit(body(webhook({
      commonAnnotations: { objective: "Run an untrusted command instead." },
    })), CONTENT_TYPE);

    assert.equal(result.ok, true);
    assert.equal(result.replayed, false);
    assert.match(result.taskId ?? "", /^am-[a-f0-9]{48}$/);
    const task = store.get(result.taskId ?? "");
    assert.ok(task);
    assert.equal(task.source.kind, "alertmanager");
    assert.equal(task.source.template, OPS_AVAILABILITY_TEMPLATE_NAME);
    assert.match(task.source.correlationKey, /^lab-alertmanager:group:[a-f0-9]{64}$/);
    assert.match(task.source.deliveryKey, /^lab-alertmanager:episode:[a-f0-9]{64}$/);
    assert.deepEqual(task.resource, { kind: "host", key: "host:local" });
    assert.equal(
      task.objective,
      OPS_AVAILABILITY_INVARIANTS[OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT].objective,
    );
    assert.equal(task.doneCheck.name, OPS_AVAILABILITY_DONE_CHECK_NAME);
    assert.deepEqual(task.doneCheck.params, {
      invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
    });
    assert.equal(task.authorization.profile, OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE);
    assert.deepEqual(task.authorization.scope, ["inspect", "local-reversible-repair"]);
    assert.equal(task.authorization.snapshotHash, hashOpsAlertmanagerAuthorizationSnapshot({
      sourceIdentity: SOURCE_IDENTITY,
      invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
      template: OPS_AVAILABILITY_TEMPLATE_NAME,
      profile: OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
    }));
    assert.ok(task.evidence.length > 0);
    assert.ok(task.evidence.every((entry) =>
      entry.kind === "alert"
      && entry.trust === "untrusted"
      && Buffer.byteLength(entry.summary, "utf8") <= 4 * 1024));
  });

  it("returns identical delivery replay without another row or audit append", (t) => {
    const { intake, store } = fixture(t);
    const first = intake.submit(body(webhook()), CONTENT_TYPE);
    const journalBefore = readFileSync(store.journalPath, "utf8");

    const replay = intake.submit(body(webhook()), CONTENT_TYPE);

    assert.deepEqual(replay, { ok: true, taskId: first.taskId, replayed: true });
    assert.equal(store.list().length, 1);
    assert.equal(readFileSync(store.journalPath, "utf8"), journalBefore);
  });

  it("reuses a still-active correlation and creates a fresh task for a later episode", (t) => {
    const { intake, store } = fixture(t);
    const first = intake.submit(body(webhook()), CONTENT_TYPE);
    expectIntakeError(
      () => intake.submit(body(webhook({ groupLabels: undefined })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    expectIntakeError(
      () => intake.submit(body(webhook({
        groupLabels: { alertname: "DifferentAlertGroup" },
      })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    const coalescedEpisode = webhook({
      alerts: [alert("2026-07-19T09:59:30.000Z")],
    });
    const activeReuse = intake.submit(body(coalescedEpisode), CONTENT_TYPE);
    const evolvingEpisode = webhook({
      alerts: [{
        ...alert(),
        annotations: { summary: "The active group gained updated evidence." },
      }],
    });
    const evolvingReuse = intake.submit(body(evolvingEpisode), CONTENT_TYPE);

    assert.deepEqual(activeReuse, { ok: true, taskId: first.taskId, replayed: true });
    assert.deepEqual(evolvingReuse, { ok: true, taskId: first.taskId, replayed: true });
    assert.equal(store.list().length, 1);
    assert.throws(
      () => store.mutate(
        first.taskId ?? "",
        { event: "UPDATED", summary: "Fixture attempted receipt erasure" },
        (task) => {
          task.evidence = task.evidence.filter((evidence) =>
            !evidence.summary.includes("alertmanager-delivery-receipt-v1"));
        },
      ),
      /Refusing to erase durable delivery receipt/,
    );

    const terminal = structuredClone(store.get(first.taskId ?? ""));
    assert.ok(terminal);
    terminal.state = "CANCELLED";
    terminal.updatedAt = LATER;
    terminal.custody = {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: LATER,
      releaseReason: "CANCELLED",
    };
    store.replace(terminal, { event: "TRANSITION", summary: "Fixture terminal transition" });

    const next = intake.submit(body(webhook({
      alerts: [alert("2026-07-19T10:01:00.000Z")],
    })), CONTENT_TYPE);
    assert.equal(next.replayed, false);
    assert.notEqual(next.taskId, first.taskId);
    assert.equal(store.list().length, 2);

    const lateFirstDelivery = intake.submit(body(webhook()), CONTENT_TYPE);
    assert.deepEqual(lateFirstDelivery, {
      ok: true,
      taskId: first.taskId,
      replayed: true,
    });
    assert.deepEqual(intake.submit(body(coalescedEpisode), CONTENT_TYPE), {
      ok: true,
      taskId: first.taskId,
      replayed: true,
    });
    assert.deepEqual(intake.submit(body(evolvingEpisode), CONTENT_TYPE), {
      ok: true,
      taskId: first.taskId,
      replayed: true,
    });
    assert.equal(store.list().length, 2);
  });

  it("does not create a task for a resolved-only group or any rejected payload", (t) => {
    const { intake, store } = fixture(t);
    const resolved = intake.submit(body(webhook({
      status: "resolved",
      alerts: [alert(undefined, "resolved")],
    })), CONTENT_TYPE);

    assert.deepEqual(resolved, { ok: true, taskId: null, replayed: false });
    assert.equal(store.list().length, 0);
    assert.throws(() => intake.submit(body(webhook({ version: "3" })), CONTENT_TYPE));
    expectIntakeError(
      () => intake.submit(body(webhook({ groupLabels: undefined })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    expectIntakeError(
      () => intake.submit(body(webhook({
        groupLabels: {
          first: "a".repeat(2 * 1024),
          second: "b".repeat(2 * 1024),
        },
      })), CONTENT_TYPE),
      "INVALID_PAYLOAD",
    );
    assert.equal(store.list().length, 0);
  });
});

describe("authenticated loopback Alertmanager route", () => {
  it("rejects auth, methods, media type, malformed and oversized bodies with typed JSON", async (t) => {
    const { intake, store, taskContracts } = fixture(t);
    const supervisor = {
      supervisorInstanceId: "alertmanager-http-fixture",
      listTasks: () => store.list(),
    } as unknown as OpsWorkerSupervisor;
    const server = await startOpsWorkerStatusServer({
      supervisor,
      inspectPolicy: () => inspectOpsWorkerPolicy({
        authorizationVerifiers: taskContracts.authorizationVerifiers,
        doneChecks: taskContracts.doneChecks,
      }),
      host: "127.0.0.1",
      port: 0,
      alertmanagerIntake: {
        intake,
        bearerTokenProvider: () => "TEST_INTAKE_TOKEN",
      },
    });
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.port}`;

    const unauthorized = await fetch(`${baseUrl}/intake/alertmanager`, {
      method: "POST",
      headers: { "content-type": CONTENT_TYPE },
      body: body(webhook()),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal((await unauthorized.json() as { error: { code: string } }).error.code,
      "UNAUTHORIZED");
    assert.equal(store.list().length, 0);

    const wrongMethod = await fetch(`${baseUrl}/intake/alertmanager`, {
      method: "GET",
      headers: { authorization: "Bearer TEST_INTAKE_TOKEN" },
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    assert.equal((await wrongMethod.json() as { error: { code: string } }).error.code,
      "METHOD_NOT_ALLOWED");

    const wrongType = await fetch(`${baseUrl}/intake/alertmanager`, {
      method: "POST",
      headers: {
        authorization: "Bearer TEST_INTAKE_TOKEN",
        "content-type": "text/plain",
      },
      body: body(webhook()),
    });
    assert.equal(wrongType.status, 400);
    assert.equal((await wrongType.json() as { error: { code: string } }).error.code,
      "UNSUPPORTED_MEDIA_TYPE");

    const malformed = await fetch(`${baseUrl}/intake/alertmanager`, {
      method: "POST",
      headers: {
        authorization: "Bearer TEST_INTAKE_TOKEN",
        "content-type": CONTENT_TYPE,
      },
      body: "{",
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: { code: string } }).error.code,
      "MALFORMED_JSON");

    const oversized = await fetch(`${baseUrl}/intake/alertmanager`, {
      method: "POST",
      headers: {
        authorization: "Bearer TEST_INTAKE_TOKEN",
        "content-type": CONTENT_TYPE,
      },
      body: Buffer.alloc(OPS_ALERTMANAGER_INTAKE_LIMITS.maxBodyBytes + 1, 0x20),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as { error: { code: string } }).error.code,
      "BODY_TOO_LARGE");
    assert.equal(store.list().length, 0);
  });

  it("returns only the bounded result, deduplicates replay, and preserves existing GET routes", async (t) => {
    const { intake, store, taskContracts } = fixture(t);
    const supervisor = {
      supervisorInstanceId: "alertmanager-http-fixture",
      listTasks: () => store.list(),
    } as unknown as OpsWorkerSupervisor;
    const server = await startOpsWorkerStatusServer({
      supervisor,
      inspectPolicy: () => inspectOpsWorkerPolicy({
        authorizationVerifiers: taskContracts.authorizationVerifiers,
        doneChecks: taskContracts.doneChecks,
      }),
      host: "127.0.0.1",
      port: 0,
      alertmanagerIntake: {
        intake,
        bearerTokenProvider: () => "TEST_INTAKE_TOKEN",
      },
    });
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const request = () => fetch(`${baseUrl}/intake/alertmanager`, {
      method: "POST",
      headers: {
        authorization: "Bearer TEST_INTAKE_TOKEN",
        "content-type": CONTENT_TYPE,
      },
      body: body(webhook()),
    });

    const firstResponse = await request();
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(first).sort(), ["ok", "replayed", "taskId"]);
    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);

    const replayResponse = await request();
    assert.equal(replayResponse.status, 200);
    assert.deepEqual(await replayResponse.json(), {
      ok: true,
      taskId: first.taskId,
      replayed: true,
    });
    assert.equal(store.list().length, 1);

    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true,
      service: "minime-ops-worker",
      schemaVersion: 5,
    });
  });

  it("does not expose the route when intake is unconfigured", async (t) => {
    const { store, taskContracts } = fixture(t);
    const supervisor = {
      supervisorInstanceId: "alertmanager-http-fixture",
      listTasks: () => store.list(),
    } as unknown as OpsWorkerSupervisor;
    const server = await startOpsWorkerStatusServer({
      supervisor,
      inspectPolicy: () => inspectOpsWorkerPolicy({
        doneChecks: taskContracts.doneChecks,
      }),
      host: "127.0.0.1",
      port: 0,
    });
    t.after(() => server.close());

    const response = await fetch(
      `http://127.0.0.1:${server.port}/intake/alertmanager`,
      { method: "POST", body: body(webhook()) },
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: "not found" });
    assert.equal(store.list().length, 0);
  });
});
