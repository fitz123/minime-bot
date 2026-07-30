import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  createServer as createHttpServer,
  type RequestListener,
} from "node:http";
import type { CodexQuotaSnapshot } from "../../pi-extensions/codex-usage.js";
import {
  syncLaunchdCrons,
  type LaunchdCommandRunner,
} from "../../launchd-cron-plists.js";
import {
  CRON_HEALTH_TEXTFILE_DIR_ENV,
  resolveCronHealthMetricArtifacts,
} from "../../cron-outbox.js";
import { assemblePiContext } from "../../pi-context-assembler.js";
import {
  PI_BUILTIN_TOOL_NAMES,
  resolvePiPrimaryResourceContract,
} from "../../pi-primary-resources.js";
import type { AgentConfig } from "../../types.js";
import {
  OPS_ALERTMANAGER_INTAKE_LIMITS,
  OpsWorkerAlertmanagerIntake,
} from "../../ops-worker/alertmanager-intake.js";
import type {
  OpsWorkerAuthorizationVerifier,
  OpsWorkerAuthorizationVerifierRegistry,
} from "../../ops-worker/authorization.js";
import {
  OPS_AVAILABILITY_DONE_CHECK_NAME,
  OPS_AVAILABILITY_LIMITS,
  OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
  createOpsAvailabilityDoneCheckRegistry,
  type OpsAlertStateReading,
  type OpsMonitoringFreshnessReading,
  type OpsServiceAvailabilityReading,
} from "../../ops-worker/availability-checks.js";
import type { OpsWorkerControlConfig } from "../../ops-worker/control-config.js";
import { OpsWorkerControlLedger } from "../../ops-worker/control-ledger.js";
import {
  OpsWorkerDoneCheckRegistry,
  type OpsWorkerDoneCheckDefinition,
} from "../../ops-worker/done-checks.js";
import { OpsWorkerLifecycle } from "../../ops-worker/lifecycle.js";
import {
  OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME,
  OPS_ALERTMANAGER_INCIDENT_OBJECTIVE,
  OPS_ALERTMANAGER_INCIDENT_TEMPLATE_NAME,
  OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
  createOpsTaskContracts,
} from "../../ops-worker/ops-contracts.js";
import {
  OpsWorkerPiAttemptRunner,
  stopOwnedProcessGroup,
} from "../../ops-worker/pi-attempt.js";
import { evaluateOpsWorkerQuotaResponse } from "../../ops-worker/quota.js";
import {
  inspectOpsWorkerPolicy,
  startOpsWorkerStatusServer,
} from "../../ops-worker/status-server.js";
import {
  OpsWorkerStaleCheckResultError,
  OpsWorkerSupervisor,
  type OpsWorkerStartupRunResult,
  type OpsWorkerSupervisorOptions,
} from "../../ops-worker/supervisor.js";
import {
  OpsWorkerDuplicateCorrelationError,
  OpsWorkerTaskStore,
  type OpsWorkerTaskStoreFaultPoint,
} from "../../ops-worker/task-store.js";
import {
  OpsWorkerTelegramControl,
  type OpsWorkerTelegramFetch,
} from "../../ops-worker/telegram-control.js";
import {
  OPS_WORKER_AUTHORIZATION_SCOPES,
  createEmptyOpsWorkerLifecycleManifest,
  createEmptyOpsWorkerMutationReceipts,
  createUnclaimedOpsWorkerCustody,
  withOpsWorkerSubmissionFingerprint,
  type JsonObject,
  type OpsWorkerSourceKind,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "../../ops-worker/types.js";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as nodeHttpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NOW = "2026-07-19T12:00:00.000Z";
const ONE_MINUTE_AGO = "2026-07-19T11:59:00.000Z";
const SIX_MINUTES_AGO = "2026-07-19T11:54:00.000Z";
const AUTHORIZATION_CLAIM_HASH = `sha256:${"a".repeat(64)}`;
const AUTHORIZATION_EVIDENCE_HASH = `sha256:${"b".repeat(64)}`;
const SOURCE_IDENTITY = "lab-alertmanager";
const CONTENT_TYPE = "application/json; charset=utf-8";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FAKE_PI_PROCESS = fileURLToPath(new URL("./fake-pi-process.mjs", import.meta.url));
const PYTHON = process.env.PYTHON ?? "/usr/bin/python3";
const ALERTMANAGER_WEBHOOK = join(PACKAGE_ROOT, "scripts", "alertmanager_webhook.py");
const BRIDGE_TELEGRAM_TOKEN = "FAULT_LAB_TELEGRAM_TOKEN";
const BRIDGE_OPS_BEARER = "FAULT_LAB_OPS_BEARER";

export const OPS_WORKER_FAULT_LAB_SCENARIO_NAMES = [
  "schema-mismatch-false-terminal",
  "stale-quota-reset-refresh",
  "predecessor-successor-overlap",
  "stale-verifier-not-product-failure",
  "crash-after-external-mutation-before-receipt",
  "telegram-duplicate-update-boundary",
  "steering-persisted-before-ack",
  "authorization-drift-after-claim",
  "passive-defer-vs-action-required",
  "alert-resolution-without-stable-health",
  "planner-completion-without-successor",
  "repository-aware-ownership",
  "child-rc1-after-partial-progress",
  "operator-allowlist-rejection",
  "pause-resume-safe-boundary",
  "cancel-interrupt-proven-process-group",
  "intake-auth-and-bounds-rejection",
  "intake-duplicate-delivery-replay",
  "monitoring-silence-not-health",
  "report-crash-before-receipt-finish",
  "complete-ops-alert-recovery-chain",
] as const;

export type OpsWorkerFaultLabScenarioName =
  (typeof OPS_WORKER_FAULT_LAB_SCENARIO_NAMES)[number];

export interface OpsWorkerFaultLabScenarioResult {
  name: OpsWorkerFaultLabScenarioName;
  outcome: "PASS" | "FAIL";
  summary: string;
}

export interface OpsWorkerFaultLabAggregate {
  labVersion: 1;
  scenarios: OpsWorkerFaultLabScenarioResult[];
  failures: OpsWorkerFaultLabScenarioName[];
  pass: boolean;
}

export type OpsWorkerFaultLabSafetyEvent =
  | { kind: "fetch-fake"; surface: "telegram" }
  | { kind: "fetch-passthrough"; url: string }
  | { kind: "socket-bind"; host: "127.0.0.1" | "::1" };

type SafetyObserver = (event: OpsWorkerFaultLabSafetyEvent) => void;

class DeterministicClock {
  private milliseconds = Date.parse(NOW);

  readonly now = (): Date => new Date(this.milliseconds += 1);

  at(millisecondsFromStart = 0): string {
    return new Date(Date.parse(NOW) + millisecondsFromStart).toISOString();
  }

  advance(milliseconds: number): void {
    this.milliseconds += milliseconds;
  }
}

interface ScenarioContext {
  root: string;
  stateDirectory: string;
  clock: DeterministicClock;
  observe: SafetyObserver;
  defer(callback: () => void | Promise<void>): void;
}

interface ScenarioDefinition {
  name: OpsWorkerFaultLabScenarioName;
  summary: string;
  run(context: ScenarioContext): void | Promise<void>;
}

const fixtureAuthorizationVerifier: OpsWorkerAuthorizationVerifier = {
  identity: "fault-lab-authorization",
  version: "1",
  verify: () => ({
    status: "PASS",
    evidenceHash: AUTHORIZATION_EVIDENCE_HASH,
    summary: "Fault-lab authorization matches the trusted fixture policy.",
  }),
};

const fixtureAuthorizationVerifiers: OpsWorkerAuthorizationVerifierRegistry = {
  alertmanager: fixtureAuthorizationVerifier,
  "operator-cli": fixtureAuthorizationVerifier,
  "operator-telegram": fixtureAuthorizationVerifier,
  "registered-cron": fixtureAuthorizationVerifier,
  "authorized-issue": fixtureAuthorizationVerifier,
};

function validateEmptyParams(value: unknown): JsonObject {
  assert.deepEqual(value, {});
  return {};
}

function createFixtureDoneChecks(
  run: OpsWorkerDoneCheckDefinition["run"] = () => ({
    result: "PASS",
    summary: "The fault-lab fixture passed deterministically.",
  }),
): OpsWorkerDoneCheckRegistry {
  return new OpsWorkerDoneCheckRegistry({
    "fault-lab-check": {
      identity: "fault-lab-check",
      version: "1",
      timeoutMs: 1_000,
      validateParams: validateEmptyParams,
      run,
    },
  });
}

function createFixtureRegistry(
  doneChecks: OpsWorkerDoneCheckRegistry,
): OpsWorkerTaskContractRegistry {
  return {
    templates: {
      "fault-lab-task": {
        sourceKinds: [
          "alertmanager",
          "operator-cli",
          "operator-telegram",
          "registered-cron",
          "authorized-issue",
        ],
      },
    },
    authorizationProfiles: {
      "fault-lab.full": {
        sourceKinds: [
          "alertmanager",
          "operator-cli",
          "operator-telegram",
          "registered-cron",
          "authorized-issue",
        ],
        scope: [...OPS_WORKER_AUTHORIZATION_SCOPES],
      },
    },
    doneChecks: doneChecks.contracts,
  };
}

function sourcePriority(sourceKind: OpsWorkerSourceKind): OpsWorkerTask["priority"] {
  return {
    alertmanager: 0,
    "operator-cli": 10,
    "operator-telegram": 10,
    "registered-cron": 20,
    "authorized-issue": 30,
  }[sourceKind] as OpsWorkerTask["priority"];
}

function makeTask(
  id: string,
  options: {
    sourceKind?: OpsWorkerSourceKind;
    correlationKey?: string;
    deliveryKey?: string;
    resource?: OpsWorkerTask["resource"];
    createdAt?: string;
  } = {},
): OpsWorkerTask {
  const sourceKind = options.sourceKind ?? "operator-cli";
  const createdAt = options.createdAt ?? NOW;
  return withOpsWorkerSubmissionFingerprint({
    schemaVersion: 6,
    id,
    source: {
      kind: sourceKind,
      correlationKey: options.correlationKey ?? `fault-lab:${id}`,
      deliveryKey: options.deliveryKey ?? `fault-lab:${id}`,
      template: "fault-lab-task",
    },
    resource: options.resource ?? { kind: "host", key: "host:local" },
    lifecycle: createEmptyOpsWorkerLifecycleManifest(),
    currentCheckpoint: null,
    mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
    custody: createUnclaimedOpsWorkerCustody(),
    priority: sourcePriority(sourceKind),
    objective: "Exercise one deterministic fault-lab invariant.",
    evidence: [],
    doneCheck: { name: "fault-lab-check", params: {} },
    authorization: {
      profile: "fault-lab.full",
      scope: [...OPS_WORKER_AUTHORIZATION_SCOPES],
      snapshotHash: AUTHORIZATION_CLAIM_HASH,
    },
    authorizationVerification: null,
    verification: null,
    legacyCompletion: null,
    agentResult: null,
    steering: [],
    control: { paused: false, pausedAt: null, interrupt: null },
    state: "QUEUED",
    rounds: { remediation: 0, maxRemediation: 3, consecutiveInfrastructureFailures: 0 },
    schedule: { nextRunAt: null, nextCheckAt: null },
    session: { directory: `sessions/${id}`, sessionId: null, resume: false },
    activeRun: null,
    unverifiedRun: null,
    lastOutcome: null,
    report: { state: "NONE", attempts: 0, lastError: null },
    createdAt,
    updatedAt: createdAt,
  });
}

function createStore(
  context: ScenarioContext,
  options: {
    directory?: string;
    doneChecks?: OpsWorkerDoneCheckRegistry;
    registry?: OpsWorkerTaskContractRegistry;
    faultInjector?: (point: OpsWorkerTaskStoreFaultPoint) => void;
  } = {},
): { store: OpsWorkerTaskStore; doneChecks: OpsWorkerDoneCheckRegistry } {
  const doneChecks = options.doneChecks ?? createFixtureDoneChecks();
  return {
    doneChecks,
    store: new OpsWorkerTaskStore(options.directory ?? context.stateDirectory, {
      registry: options.registry ?? createFixtureRegistry(doneChecks),
      now: context.clock.now,
      faultInjector: options.faultInjector,
    }),
  };
}

async function createSupervisor(
  context: ScenarioContext,
  options: {
    directory?: string;
    doneChecks?: OpsWorkerDoneCheckRegistry;
    registry?: OpsWorkerTaskContractRegistry;
    instanceId?: string;
    authorizationVerifiers?: OpsWorkerAuthorizationVerifierRegistry;
    faultInjector?: (point: OpsWorkerTaskStoreFaultPoint) => void;
    reconcileActiveRun?: OpsWorkerSupervisorOptions["reconcileActiveRun"];
  } = {},
): Promise<{
  store: OpsWorkerTaskStore;
  doneChecks: OpsWorkerDoneCheckRegistry;
  supervisor: OpsWorkerSupervisor;
}> {
  const created = createStore(context, options);
  const instanceId = options.instanceId ?? "fault-lab-supervisor";
  const supervisor = new OpsWorkerSupervisor({
    store: created.store,
    doneChecks: created.doneChecks,
    instanceId,
    processStartToken: `${instanceId}-start`,
    now: context.clock.now,
    infrastructureRetryMs: 1_000,
    authorizationQueryRetryMs: 1_000,
    authorizationVerifiers:
      options.authorizationVerifiers ?? fixtureAuthorizationVerifiers,
    reconcileActiveRun: options.reconcileActiveRun,
  });
  await supervisor.start();
  context.defer(() => supervisor.close());
  return { ...created, supervisor };
}

function activeRun(
  supervisor: OpsWorkerSupervisor,
  attemptId = "attempt-fault-lab",
): NonNullable<OpsWorkerTask["activeRun"]> {
  return {
    attemptId,
    supervisorInstanceId: supervisor.supervisorInstanceId,
    pid: 321,
    processGroupId: 321,
    processStartedAt: NOW,
    processStartToken: "fault-lab-process-start",
  };
}

const CONTROL_CONFIG: OpsWorkerControlConfig = {
  telegram: {
    token: "TEST_OPS_TOKEN",
    controlChatId: "100000000",
    operatorIds: ["100000000"],
  },
  intake: undefined,
  poll: {
    longPollSeconds: 1,
    requestTimeoutMs: 2_000,
    retryMinMs: 10,
    retryMaxMs: 20,
    maxResponseBytes: 65_536,
  },
  reply: { maxBytes: 1_024 },
};

class FakeTelegramTransport {
  readonly updates: unknown[][] = [];
  readonly messages: Record<string, unknown>[] = [];
  readonly offsets: unknown[] = [];

  constructor(private readonly observe: SafetyObserver) {}

  readonly fetch: OpsWorkerTelegramFetch = async (input, init) => {
    this.observe({ kind: "fetch-fake", surface: "telegram" });
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/getUpdates")) {
      this.offsets.push(body.offset);
      return Response.json({ ok: true, result: this.updates.shift() ?? [] });
    }
    if (url.endsWith("/sendMessage")) {
      this.messages.push(body);
      return Response.json({ ok: true, result: { message_id: this.messages.length } });
    }
    this.observe({ kind: "fetch-passthrough", url });
    throw new Error("Fault-lab fetch refused an unregistered URL");
  };
}

function telegramUpdate(
  updateId: number,
  text: string,
  options: { senderId?: number; chatId?: number } = {},
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_753_000_000,
      text,
      from: { id: options.senderId ?? 100000000, is_bot: false },
      chat: { id: options.chatId ?? 100000000, type: "private" },
    },
  };
}

function createTelegramControl(
  context: ScenarioContext,
  supervisor: OpsWorkerSupervisor,
  transport: FakeTelegramTransport,
  faultInjector?: ConstructorParameters<typeof OpsWorkerTelegramControl>[0]["faultInjector"],
): OpsWorkerTelegramControl {
  const doneChecks = createFixtureDoneChecks();
  return new OpsWorkerTelegramControl({
    config: CONTROL_CONFIG,
    supervisor,
    ledger: new OpsWorkerControlLedger(supervisor.stateDirectory),
    fetch: transport.fetch,
    inspectPolicy: () => inspectOpsWorkerPolicy({
      authorizationVerifiers: fixtureAuthorizationVerifiers,
      doneChecks,
    }),
    faultInjector,
  });
}

interface AvailabilityReadings {
  monitoring: unknown;
  alerts: unknown;
  service: unknown;
}

function healthyReadings(): AvailabilityReadings {
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

async function runAvailability(readings: AvailabilityReadings) {
  const doneChecks = createOpsAvailabilityDoneCheckRegistry({
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
  return doneChecks.run(
    {
      name: OPS_AVAILABILITY_DONE_CHECK_NAME,
      params: { invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT },
    },
    { taskId: "fault-lab-availability", checkedAt: NOW, now: () => new Date(NOW) },
  );
}

function availabilityContracts(
  clock: () => Date = () => new Date(NOW),
  incidentServiceMode: () => "unavailable" | "healthy" = () => "healthy",
) {
  return createOpsTaskContracts({
    alertmanagerAuthorizationSnapshotReader: {
      read: () => ({
        sourceIdentity: SOURCE_IDENTITY,
        template: OPS_ALERTMANAGER_INCIDENT_TEMPLATE_NAME,
        doneCheck: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME,
        objective: OPS_ALERTMANAGER_INCIDENT_OBJECTIVE,
        profile: OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
      }),
    },
    clock,
    incidentMonitoringReader: {
      readMonitoringFreshness: () => {
        const observedAt = clock().toISOString();
        return { observedAt, latestSampleAt: observedAt };
      },
      readResolutionStability: () => {
        const observedAt = clock().toISOString();
        return {
          observedAt,
          latestMatchingSampleAt: incidentServiceMode() === "unavailable"
            ? observedAt
            : null,
          monitoringWindowStartedAt: new Date(
            Date.parse(observedAt) - 5 * 60 * 1_000,
          ).toISOString(),
        };
      },
    },
    incidentAlertmanagerReader: {
      readExactGroupState: () => ({
        observedAt: clock().toISOString(),
        status: incidentServiceMode() === "unavailable"
          ? "PRESENT"
          : "ABSENT",
      }),
    },
    monitoringFreshnessReader: {
      readMonitoringFreshness: () => {
        const observedAt = clock().toISOString();
        return { observedAt, latestSampleAt: observedAt };
      },
    },
    alertStateReader: {
      read: () => ({ observedAt: clock().toISOString(), status: "RESOLVED" }),
    },
    serviceAvailabilityReader: {
      readServiceAvailability: () => {
        const observedAt = clock().toISOString();
        return {
          observedAt,
          status: "HEALTHY",
          healthySince: new Date(
            Date.parse(observedAt) - 6 * 60 * 1_000,
          ).toISOString(),
        };
      },
    },
  });
}

function alertmanagerWebhook(
  startsAt = "2026-07-19T11:59:00.000Z",
): Record<string, unknown> {
  return alertmanagerGroupWebhook("MinimeBotUnavailable", "warning", startsAt);
}

function alertmanagerGroupWebhook(
  alertname: string,
  severity: "warning" | "critical",
  startsAt = "2026-07-19T11:59:00.000Z",
): Record<string, unknown> {
  return {
    receiver: "ops-worker",
    status: "firing",
    alerts: [{
      status: "firing",
      labels: { alertname, severity, instance: "local" },
      annotations: { summary: "The generic local service is unavailable." },
      startsAt,
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "http://127.0.0.1:9090/graph?g0.expr=up",
      fingerprint: `fault-lab-${alertname.toLowerCase()}`,
    }],
    groupLabels: { alertname },
    commonLabels: { alertname, severity, instance: "local" },
    commonAnnotations: { summary: "The generic local service is unavailable." },
    externalURL: "http://127.0.0.1:9093",
    version: "4",
    groupKey: `{}/{alertname="${alertname}"}`,
    truncatedAlerts: 0,
  };
}

function createIntake(
  context: ScenarioContext,
  incidentServiceMode?: () => "unavailable" | "healthy",
): {
  intake: OpsWorkerAlertmanagerIntake;
  store: OpsWorkerTaskStore;
  contracts: ReturnType<typeof availabilityContracts>;
} {
  const contracts = availabilityContracts(
    context.clock.now,
    incidentServiceMode,
  );
  const store = new OpsWorkerTaskStore(context.stateDirectory, {
    registry: contracts.taskRegistry,
    now: context.clock.now,
  });
  return {
    contracts,
    store,
    intake: new OpsWorkerAlertmanagerIntake({
      store,
      doneChecks: contracts.doneChecks,
      sourceIdentity: SOURCE_IDENTITY,
      now: context.clock.now,
    }),
  };
}

function quotaSnapshot(
  sampledAt: string,
  resetAt: string,
): CodexQuotaSnapshot {
  return {
    provider: "codex",
    sampledAt,
    lastSuccess: sampledAt,
    lastSuccessTimestamp: Date.parse(sampledAt) / 1_000,
    activeLimit: "primary",
    windows: {
      "5h": {
        usedPercent: 100,
        remainingPercent: 0,
        resetAt,
        resetTimestamp: Date.parse(resetAt) / 1_000,
      },
      week: {},
    },
  };
}

async function requestLoopback(options: {
  port: number;
  method: string;
  path?: string;
  headers?: Record<string, string | number>;
  body?: Buffer;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = nodeHttpRequest({
      host: "127.0.0.1",
      port: options.port,
      path: options.path ?? "/intake/alertmanager",
      method: options.method,
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolveRequest({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", rejectRequest);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function startLoopbackServer(
  context: ScenarioContext,
  handler: RequestListener,
): Promise<string> {
  const server = createHttpServer(handler);
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  context.observe({ kind: "socket-bind", host: "127.0.0.1" });
  context.defer(() => new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  }));
  return `http://127.0.0.1:${address.port}`;
}

async function reserveLoopbackPort(context: ScenarioContext): Promise<number> {
  const server = createHttpServer((_request, response) => response.end());
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  context.observe({ kind: "socket-bind", host: "127.0.0.1" });
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  return address.port;
}

function waitForWebhookReady(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    const timer = setTimeout(
      () => rejectReady(new Error(`Alertmanager webhook readiness timed out: ${output}`)),
      5_000,
    );
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (!output.includes("webhook ready")) return;
      clearTimeout(timer);
      resolveReady();
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      rejectReady(new Error(`Alertmanager webhook exited before ready: ${code}; ${output}`));
    });
  });
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
}

async function createPiRunnerFixture(context: ScenarioContext): Promise<{
  store: OpsWorkerTaskStore;
  supervisor: OpsWorkerSupervisor;
  lifecycle: OpsWorkerLifecycle;
  runner: OpsWorkerPiAttemptRunner;
  setLaunchFaultInjector(
    injector: NonNullable<
      NonNullable<ConstructorParameters<typeof OpsWorkerPiAttemptRunner>[0]["dependencies"]>["launchFaultInjector"]
    >,
  ): void;
}> {
  const workspace = join(context.root, "agent-workspace");
  const primaryWorkspace = join(context.root, "primary-context");
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(primaryWorkspace, { mode: 0o700 });
  writeFileSync(
    join(primaryWorkspace, "CLAUDE.md"),
    "# Fault lab primary context\n\nExercise only deterministic fake dependencies.\n",
    "utf8",
  );
  const primaryContextAgent: AgentConfig = {
    id: "main",
    workspaceCwd: primaryWorkspace,
    model: "openai-codex/gpt-5.5",
    thinking: "medium",
    systemPrompt: "FAULT_LAB_PERSONA_CONTEXT",
  };
  const extraExtension = join(context.root, "configured-extra.ts");
  writeFileSync(extraExtension, "export default function () {}\n", "utf8");
  const primaryResources = resolvePiPrimaryResourceContract({
    extensionOptions: {
      extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
      relpaths: [],
      extraExtensions: [extraExtension],
    },
    extraExtensionResourcePaths: [[]],
    skillPaths: [],
    toolNames: [...PI_BUILTIN_TOOL_NAMES],
  });
  const created = await createSupervisor(context, {
    instanceId: "fault-lab-pi-supervisor",
  });
  let launchFaultInjector: NonNullable<
    NonNullable<ConstructorParameters<typeof OpsWorkerPiAttemptRunner>[0]["dependencies"]>["launchFaultInjector"]
  > | undefined;
  return {
    ...created,
    lifecycle: new OpsWorkerLifecycle(created.store, { now: context.clock.now }),
    setLaunchFaultInjector(injector): void {
      launchFaultInjector = injector;
    },
    runner: new OpsWorkerPiAttemptRunner({
      supervisor: created.supervisor,
      workspaceCwd: workspace,
      primaryContextAgent,
      primaryResources,
      attemptTimeoutMs: 5_000,
      termGraceMs: 200,
      killGraceMs: 200,
      dependencies: {
        assembleContext: (agent, options) => assemblePiContext(agent, options),
        resolveInvocation: (args) => ({
          command: process.execPath,
          args: [FAKE_PI_PROCESS, "partial-progress-rc1", ...args],
        }),
        buildEnv: () => Object.fromEntries(
          ["HOME", "PATH", "TMPDIR", "LANG"].flatMap((key) =>
            process.env[key] === undefined ? [] : [[key, process.env[key] as string]]),
        ),
        now: context.clock.now,
        launchFaultInjector: (point) => launchFaultInjector?.(point),
      },
    }),
  };
}

const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    name: "schema-mismatch-false-terminal",
    summary: "Future-schema terminal claims fail closed instead of becoming DONE.",
    run(context) {
      const { store } = createStore(context);
      const task = makeTask("schema-mismatch");
      store.create(task);
      const path = join(store.tasksDirectory, `${task.id}.json`);
      const snapshot = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      snapshot.schemaVersion = 999;
      snapshot.state = "DONE";
      writeFileSync(path, `${JSON.stringify(snapshot)}\n`, "utf8");
      assert.throws(() => store.get(task.id), /schemaVersion|future|version/i);
    },
  },
  {
    name: "stale-quota-reset-refresh",
    summary: "A later authoritative quota response replaces an elapsed reset.",
    run() {
      const first = evaluateOpsWorkerQuotaResponse({
        status: "OK",
        snapshot: quotaSnapshot(
          "2026-07-19T11:59:00.000Z",
          "2026-07-19T13:00:00.000Z",
        ),
      }, { now: new Date(NOW) });
      const refreshed = evaluateOpsWorkerQuotaResponse({
        status: "OK",
        snapshot: quotaSnapshot(
          "2026-07-19T13:00:00.000Z",
          "2026-07-19T18:00:00.000Z",
        ),
      }, { now: new Date("2026-07-19T13:00:01.000Z") });
      assert.equal(first.status, "WAIT");
      assert.equal(refreshed.status, "WAIT");
      if (first.status === "WAIT" && refreshed.status === "WAIT") {
        assert.equal(first.resetAt, "2026-07-19T13:00:00.000Z");
        assert.equal(refreshed.resetAt, "2026-07-19T18:00:00.000Z");
      }
    },
  },
  {
    name: "predecessor-successor-overlap",
    summary: "One active correlation episode rejects an overlapping successor.",
    run(context) {
      const { store } = createStore(context);
      store.create(makeTask("overlap-predecessor", {
        correlationKey: "fault-lab:shared-episode",
        deliveryKey: "fault-lab:predecessor",
      }));
      assert.throws(
        () => store.create(makeTask("overlap-successor", {
          correlationKey: "fault-lab:shared-episode",
          deliveryKey: "fault-lab:successor",
        })),
        OpsWorkerDuplicateCorrelationError,
      );
      assert.equal(store.list().length, 1);
    },
  },
  {
    name: "stale-verifier-not-product-failure",
    summary: "A late verifier PASS is discarded as stale without product-failure spend.",
    async run(context) {
      let resolveCheck: ((value: unknown) => void) | undefined;
      const doneChecks = createFixtureDoneChecks(() => new Promise((resolveCheckResult) => {
        resolveCheck = resolveCheckResult;
      }));
      const { store, supervisor } = await createSupervisor(context, { doneChecks });
      const task = makeTask("stale-verifier");
      store.create(task);
      await supervisor.requestDoneCheck(task.id);
      const pending = supervisor.runDoneCheck(task.id);
      await new Promise((resolveTurn) => setImmediate(resolveTurn));
      supervisor.cancelTask(task.id, "Fault-lab cancellation during verification");
      assert.ok(resolveCheck);
      resolveCheck({ result: "PASS", summary: "Late synthetic PASS." });
      await assert.rejects(pending, OpsWorkerStaleCheckResultError);
      const cancelled = store.get(task.id);
      assert.equal(cancelled?.state, "CANCELLED");
      assert.equal(cancelled?.rounds.remediation, 0);
      assert.notEqual(cancelled?.verification?.outcome, "PRODUCT_FAILURE");
    },
  },
  {
    name: "crash-after-external-mutation-before-receipt",
    summary: "An unfinished claimed mutation requires a strictly newer reconciliation query.",
    run(context) {
      const { store, doneChecks } = createStore(context);
      const task = makeTask("mutation-receipt-crash");
      store.create(task);
      const first = new OpsWorkerLifecycle(store, {
        now: context.clock.now,
        authorizeMutationClaim: () => true,
      });
      const intent = { base: "main", head: "fault-lab" };
      first.beginMutationReceipt(task.id, {
        boundary: "merge",
        operationId: "merge-fault-lab",
        intent,
        queryObservedAt: NOW,
        queryResult: { applied: false },
      });
      assert.equal(first.claimMutationReceipt(task.id, {
        boundary: "merge",
        operationId: "merge-fault-lab",
        intent,
      }).claimed, true);

      const restartedStore = new OpsWorkerTaskStore(context.stateDirectory, {
        registry: createFixtureRegistry(doneChecks),
        now: context.clock.now,
      });
      const restarted = new OpsWorkerLifecycle(restartedStore, {
        now: context.clock.now,
        authorizeMutationClaim: () => true,
      });
      assert.throws(() => restarted.beginMutationReceipt(task.id, {
        boundary: "merge",
        operationId: "merge-fault-lab",
        intent,
        queryObservedAt: NOW,
        queryResult: { applied: true },
      }), /fresh query observation/);
      const reconciled = restarted.beginMutationReceipt(task.id, {
        boundary: "merge",
        operationId: "merge-fault-lab",
        intent,
        queryObservedAt: "2026-07-19T12:01:00.000Z",
        queryResult: { applied: true },
      });
      assert.equal(reconciled.mutationReceipts.merge?.mutationStartedAt, null);
      assert.equal(restarted.claimMutationReceipt(task.id, {
        boundary: "merge",
        operationId: "merge-fault-lab",
        intent,
      }).claimed, true);
    },
  },
  {
    name: "telegram-duplicate-update-boundary",
    summary: "A repeated Telegram update advances no second effect or reply.",
    async run(context) {
      const { store, supervisor } = await createSupervisor(context);
      const task = makeTask("telegram-duplicate");
      store.create(task);
      const transport = new FakeTelegramTransport(context.observe);
      const duplicate = telegramUpdate(11, "/answer telegram-duplicate retain evidence");
      transport.updates.push([duplicate], [duplicate]);
      const control = createTelegramControl(context, supervisor, transport);
      await control.tick();
      await control.tick();
      assert.equal(store.get(task.id)?.steering.length, 1);
      assert.equal(transport.messages.length, 1);
      assert.deepEqual(transport.offsets, [undefined, 12]);
    },
  },
  {
    name: "steering-persisted-before-ack",
    summary: "A crash before ledger acknowledgement replays one durable steering effect.",
    async run(context) {
      const { store, supervisor } = await createSupervisor(context);
      const task = makeTask("steering-before-ack");
      store.create(task);
      const transport = new FakeTelegramTransport(context.observe);
      const redelivery = telegramUpdate(21, "/correct steering-before-ack inspect checkpoint");
      transport.updates.push([redelivery], [redelivery]);
      let armed = true;
      const crashing = createTelegramControl(context, supervisor, transport, (point) => {
        if (armed && point === "after-effect-before-ledger") {
          armed = false;
          throw new Error("synthetic crash before durable Telegram acknowledgement");
        }
      });
      await assert.rejects(crashing.tick(), /synthetic crash/);
      assert.equal(store.get(task.id)?.steering.length, 1);
      assert.equal(new OpsWorkerControlLedger(context.stateDirectory).nextOffset(), undefined);
      await createTelegramControl(context, supervisor, transport).tick();
      assert.equal(store.get(task.id)?.steering.length, 1);
      assert.equal(new OpsWorkerControlLedger(context.stateDirectory).nextOffset(), 22);
    },
  },
  {
    name: "authorization-drift-after-claim",
    summary: "Authorization drift after custody blocks safely and releases process-free work.",
    async run(context) {
      let status: "PASS" | "DRIFT" = "PASS";
      const verifier: OpsWorkerAuthorizationVerifier = {
        identity: "fault-lab-drift-verifier",
        version: "1",
        verify: () => ({
          status,
          evidenceHash: `sha256:${(status === "PASS" ? "c" : "d").repeat(64)}`,
          summary: `Fault-lab authorization result ${status}.`,
        }),
      };
      const { store, supervisor } = await createSupervisor(context, {
        authorizationVerifiers: { "operator-cli": verifier },
      });
      const task = makeTask("authorization-drift");
      store.create(task);
      assert.equal((await supervisor.claimNextTask())?.task.custody.status, "HELD");
      supervisor.recordPreLaunchInfrastructureOutcome(task.id, "Synthetic pre-launch boundary.");
      status = "DRIFT";
      const drifted = await supervisor.ensureTaskCustody(task.id, "RUN");
      assert.equal(drifted.state, "BLOCKED");
      assert.equal(drifted.custody.status, "RELEASED");
      assert.equal(drifted.authorizationVerification?.status, "DRIFT");
    },
  },
  {
    name: "passive-defer-vs-action-required",
    summary: "Firing alerts DEFER passively while unhealthy service evidence requires remediation.",
    async run() {
      const passive = healthyReadings();
      passive.alerts = { observedAt: NOW, status: "FIRING" };
      const deferred = await runAvailability(passive);
      assert.equal(deferred.result, "DEFER");
      assert.equal(deferred.components[1].convergence, "PASSIVE");

      const product = healthyReadings();
      product.service = { observedAt: NOW, status: "UNHEALTHY", healthySince: null };
      const failed = await runAvailability(product);
      assert.equal(failed.result, "PRODUCT_FAILURE");
      assert.equal(failed.components[2].convergence, "PRODUCT");
    },
  },
  {
    name: "alert-resolution-without-stable-health",
    summary: "Resolved alerts cannot PASS before the direct-health stability window.",
    async run() {
      const readings = healthyReadings();
      readings.service = {
        observedAt: NOW,
        status: "HEALTHY",
        healthySince: "2026-07-19T11:58:00.000Z",
      };
      const result = await runAvailability(readings);
      assert.equal(result.components[1].outcome, "PASS");
      assert.equal(result.components[2].outcome, "NOT_READY");
      assert.equal(result.result, "NOT_READY");
    },
  },
  {
    name: "planner-completion-without-successor",
    summary: "A Pi success claim atomically enters verification while retaining custody.",
    async run(context) {
      const { store, supervisor } = await createSupervisor(context);
      const task = makeTask("planner-completion");
      store.create(task);
      supervisor.markRunning(task.id, activeRun(supervisor));
      const checking = supervisor.recordPiSuccessClaim(
        task.id,
        "The fake planner claimed completion.",
      );
      assert.equal(checking.state, "CHECKING");
      assert.equal(checking.custody.status, "HELD");
      assert.equal(checking.schedule.nextRunAt, null);
      assert.equal(checking.schedule.nextCheckAt, null);
      assert.equal(supervisor.selectNextTask()?.task.id, task.id);
    },
  },
  {
    name: "repository-aware-ownership",
    summary: "Immutable repository and host identities round-trip under explicit global serialization.",
    async run(context) {
      const { store, supervisor } = await createSupervisor(context);
      const repositoryTask = makeTask("a-repository-owner", {
        sourceKind: "alertmanager",
        resource: { kind: "repository", key: "github:example/project" },
      });
      const hostTask = makeTask("z-host-successor", {
        resource: { kind: "host", key: "host:local" },
      });
      store.create(repositoryTask);
      store.create(hostTask);
      const claimed = await supervisor.claimNextTask();
      assert.equal(claimed?.task.id, repositoryTask.id);
      assert.deepEqual(store.get(repositoryTask.id)?.resource, {
        kind: "repository",
        key: "github:example/project",
      });
      assert.deepEqual(store.get(hostTask.id)?.resource, { kind: "host", key: "host:local" });
      assert.equal(supervisor.selectNextTask()?.task.id, repositoryTask.id);
      const changed = structuredClone(store.get(repositoryTask.id));
      assert.ok(changed);
      changed.resource = { kind: "host", key: "host:local" };
      assert.throws(() => store.replace(changed), /immutable identity/i);
    },
  },
  {
    name: "child-rc1-after-partial-progress",
    summary: "A fake Pi rc=1 preserves its prior checkpoint and resumes without a false PASS.",
    async run(context) {
      const fixture = await createPiRunnerFixture(context);
      const task = makeTask("child-rc1-progress");
      fixture.store.create(task);
      fixture.lifecycle.recordCheckpoint(task.id, {
        checkpointId: "checkpoint-before-rc1",
        payload: { inspected: true },
        summary: "Partial deterministic progress was persisted.",
      });
      let fenceObserved = false;
      fixture.setLaunchFaultInjector((point) => {
        if (point === "after-launch-intent-persisted") fenceObserved = true;
      });
      const result = await fixture.runner.runAttempt(task.id);
      assert.equal(fenceObserved, true);
      assert.equal(result.state, "RESUMABLE");
      assert.equal(result.lastOutcome?.result, "CRASH");
      assert.equal(result.currentCheckpoint?.checkpointId, "checkpoint-before-rc1");
      assert.equal(result.verification, null);
      assert.equal(result.activeRun, null);
      assert.equal(result.unverifiedRun, null);
    },
  },
  {
    name: "operator-allowlist-rejection",
    summary: "A non-allowlisted operator is durably dropped without task effects or replies.",
    async run(context) {
      const { store, supervisor } = await createSupervisor(context);
      const task = makeTask("allowlist-rejection");
      store.create(task);
      const transport = new FakeTelegramTransport(context.observe);
      transport.updates.push([
        telegramUpdate(31, "/correct allowlist-rejection forbidden", {
          senderId: 100000999,
        }),
      ]);
      await createTelegramControl(context, supervisor, transport).tick();
      assert.equal(store.get(task.id)?.steering.length, 0);
      assert.equal(transport.messages.length, 0);
      assert.equal(new OpsWorkerControlLedger(context.stateDirectory).nextOffset(), 32);
    },
  },
  {
    name: "pause-resume-safe-boundary",
    summary: "Pause holds scheduling at a safe boundary and resume restores the same task.",
    async run(context) {
      const { store, supervisor } = await createSupervisor(context);
      const task = makeTask("pause-resume");
      store.create(task);
      supervisor.setTaskPaused(task.id, true);
      assert.equal(supervisor.selectNextTask(), undefined);
      assert.equal(store.get(task.id)?.control.paused, true);
      supervisor.setTaskPaused(task.id, false);
      assert.equal(supervisor.selectNextTask()?.task.id, task.id);

      supervisor.markRunning(task.id, activeRun(supervisor, "attempt-pause"));
      const active = supervisor.setTaskPaused(task.id, true);
      assert.equal(active.state, "RUNNING");
      assert.ok(active.activeRun);
      const settled = supervisor.recordResumableInfrastructureOutcome(
        task.id,
        "NETWORK",
        "Synthetic in-flight attempt settled at the safe boundary.",
      );
      assert.equal(settled.control.paused, true);
      assert.equal(supervisor.selectNextTask(), undefined);
    },
  },
  {
    name: "cancel-interrupt-proven-process-group",
    summary: "Proven cancellation stops its group; ambiguous ownership retains the global fence.",
    async run(context) {
      const resolutions = new Map<string, OpsWorkerStartupRunResult>();
      const { store, supervisor } = await createSupervisor(context, {
        reconcileActiveRun: (task) => resolutions.get(task.id) ?? {
          status: "AMBIGUOUS",
          summary: "Synthetic process-group resolution is unavailable.",
        },
      });
      const provenTask = makeTask("interrupt-proven");
      store.create(provenTask);
      const run = activeRun(supervisor, "attempt-proven-stop");
      supervisor.markRunning(provenTask.id, run);
      const requested = supervisor.requestOperatorInterrupt(
        provenTask.id,
        "cancel",
        "Fault-lab proven cancellation.",
      );
      assert.equal(requested.state, "RUNNING");
      let present = true;
      const signals: NodeJS.Signals[] = [];
      const stopped = await stopOwnedProcessGroup(run, {
        inspect: () => ({
          status: "OWNED",
          identity: {
            pid: run.pid,
            processGroupId: run.processGroupId,
            processStartToken: run.processStartToken,
          },
        }),
        inspectGroup: () => present ? { status: "PRESENT" } : { status: "GONE" },
        signal: (_group, signal) => {
          signals.push(signal);
          present = false;
        },
        sleep: async () => undefined,
        termGraceMs: 1,
        killGraceMs: 1,
      });
      assert.equal(stopped.status, "STOPPED");
      assert.deepEqual(signals, ["SIGTERM"]);
      resolutions.set(provenTask.id, { status: "STOPPED" });
      const cancelled = await supervisor.resolveOperatorInterrupt(
        provenTask.id,
        requested.control.interrupt as NonNullable<OpsWorkerTask["control"]["interrupt"]>,
      );
      assert.equal(cancelled.state, "CANCELLED");

      const ambiguousTask = makeTask("interrupt-ambiguous");
      store.create(ambiguousTask);
      const ambiguousRun = activeRun(supervisor, "attempt-ambiguous-stop");
      supervisor.markRunning(ambiguousTask.id, ambiguousRun);
      supervisor.requestOperatorInterrupt(
        ambiguousTask.id,
        "cancel",
        "Fault-lab ambiguous cancellation.",
      );
      let ambiguousSignals = 0;
      const ambiguous = await stopOwnedProcessGroup(ambiguousRun, {
        inspect: () => ({ status: "AMBIGUOUS", summary: "Synthetic ownership ambiguity." }),
        inspectGroup: () => ({ status: "PRESENT" }),
        signal: () => { ambiguousSignals += 1; },
        sleep: async () => undefined,
        termGraceMs: 1,
        killGraceMs: 1,
      });
      assert.equal(ambiguous.status, "AMBIGUOUS");
      assert.equal(ambiguousSignals, 0);
      resolutions.set(ambiguousTask.id, {
        status: "AMBIGUOUS",
        summary: ambiguous.summary ?? "Synthetic process-group stop ambiguity.",
      });
      const pendingAmbiguousInterrupt = supervisor.getTask(
        ambiguousTask.id,
      )?.control.interrupt;
      assert.ok(pendingAmbiguousInterrupt);
      const fenced = await supervisor.resolveOperatorInterrupt(
        ambiguousTask.id,
        pendingAmbiguousInterrupt,
      );
      assert.equal(fenced.state, "BLOCKED");
      assert.equal(fenced.custody.status, "HELD");
      assert.equal(fenced.control.interrupt?.mode, "cancel");
      assert.equal(supervisor.selectNextTask(), undefined);
    },
  },
  {
    name: "intake-auth-and-bounds-rejection",
    summary: "The loopback intake rejects bad auth and oversized bodies without submissions.",
    async run(context) {
      const { intake, store, contracts } = createIntake(context);
      const supervisor = {
        supervisorInstanceId: "fault-lab-intake-http",
        listTasks: () => store.list(),
      } as unknown as OpsWorkerSupervisor;
      const server = await startOpsWorkerStatusServer({
        supervisor,
        inspectPolicy: () => inspectOpsWorkerPolicy({
          authorizationVerifiers: contracts.authorizationVerifiers,
          doneChecks: contracts.doneChecks,
        }),
        host: "127.0.0.1",
        port: 0,
        alertmanagerIntake: {
          intake,
          bearerTokenProvider: () => "TEST_INTAKE_TOKEN",
        },
      });
      context.observe({ kind: "socket-bind", host: server.host as "127.0.0.1" });
      context.defer(() => server.close());
      const payload = Buffer.from(JSON.stringify(alertmanagerWebhook()), "utf8");
      const unauthorized = await requestLoopback({
        port: server.port,
        method: "POST",
        headers: { "content-type": CONTENT_TYPE, "content-length": payload.byteLength },
        body: payload,
      });
      assert.equal(unauthorized.status, 401);
      assert.equal((JSON.parse(unauthorized.body) as { error: { code: string } }).error.code,
        "UNAUTHORIZED");

      const oversizedBody = Buffer.alloc(
        OPS_ALERTMANAGER_INTAKE_LIMITS.maxBodyBytes + 1,
        0x20,
      );
      const oversized = await requestLoopback({
        port: server.port,
        method: "POST",
        headers: {
          authorization: "Bearer TEST_INTAKE_TOKEN",
          "content-type": CONTENT_TYPE,
          "content-length": oversizedBody.byteLength,
        },
        body: oversizedBody,
      });
      assert.equal(oversized.status, 413);
      assert.equal((JSON.parse(oversized.body) as { error: { code: string } }).error.code,
        "BODY_TOO_LARGE");
      assert.equal(store.list().length, 0);
    },
  },
  {
    name: "intake-duplicate-delivery-replay",
    summary: "An identical authenticated firing episode replays one durable task row.",
    run(context) {
      const { intake, store } = createIntake(context);
      const payload = Buffer.from(JSON.stringify(alertmanagerWebhook()), "utf8");
      const first = intake.submit(payload, CONTENT_TYPE);
      const replay = intake.submit(payload, CONTENT_TYPE);
      assert.equal(first.replayed, false);
      assert.deepEqual(replay, { ok: true, taskId: first.taskId, replayed: true });
      assert.equal(store.list().length, 1);
    },
  },
  {
    name: "monitoring-silence-not-health",
    summary: "Missing monitoring samples remain NOT_READY despite resolved alerts and stable service.",
    async run() {
      const readings = healthyReadings();
      readings.monitoring = { observedAt: NOW, latestSampleAt: null };
      const result = await runAvailability(readings);
      assert.equal(result.result, "NOT_READY");
      assert.equal(result.components[0].outcome, "NOT_READY");
      assert.equal(result.components[1].outcome, "PASS");
      assert.equal(result.components[2].outcome, "PASS");
      assert.equal(result.nextCheckAt, null);
    },
  },
  {
    name: "report-crash-before-receipt-finish",
    summary: "A report crash after send re-queries and redelivers before finishing its receipt.",
    async run(context) {
      const first = await createSupervisor(context, {
        instanceId: "fault-lab-report-first",
      });
      const task = makeTask("report-receipt-crash");
      task.state = "CANCELLED";
      task.custody = {
        status: "RELEASED",
        claimedAt: null,
        releasedAt: NOW,
        releaseReason: "CANCELLED",
      };
      task.lastOutcome = {
        at: NOW,
        kind: "OPERATOR",
        result: "CANCELLED",
        summary: "Fault-lab terminal report.",
      };
      task.report.state = "PENDING";
      first.store.create(task);
      const transport = new FakeTelegramTransport(context.observe);
      await assert.rejects(
        createTelegramControl(context, first.supervisor, transport, (point) => {
          if (point === "after-report-send-before-receipt-finish") {
            throw new Error("synthetic report crash before receipt finish");
          }
        }).tick(),
        /synthetic report crash/,
      );
      const claimed = first.store.get(task.id)?.mutationReceipts.report;
      assert.ok(claimed?.mutationStartedAt);
      assert.equal(claimed.outcome, null);
      assert.equal(first.store.get(task.id)?.report.state, "PENDING");
      first.supervisor.close();

      context.clock.advance(60_000);
      const restarted = await createSupervisor(context, {
        directory: context.stateDirectory,
        instanceId: "fault-lab-report-restarted",
      });
      transport.updates.push([]);
      await createTelegramControl(context, restarted.supervisor, transport).tick();
      const sent = restarted.store.get(task.id);
      assert.equal(transport.messages.length, 2);
      assert.equal(sent?.report.state, "SENT");
      assert.equal(sent?.report.attempts, 1);
      assert.equal(sent?.mutationReceipts.report?.outcome?.result, "APPLIED");
      assert.ok(
        Date.parse(sent?.mutationReceipts.report?.queryObservedAt ?? "")
          > Date.parse(claimed.queryObservedAt),
      );
    },
  },
  {
    name: "complete-ops-alert-recovery-chain",
    summary: "The complete warning, Ops recovery, verified result, and cron-retirement chain stays truthful.",
    async run(context) {
      const repairStatePath = join(context.root, "bounded-repair-state.json");
      writeFileSync(
        repairStatePath,
        `${JSON.stringify({ serviceMode: "unavailable" })}\n`,
        { mode: 0o600 },
      );
      const readIncidentServiceMode = (): "unavailable" | "healthy" => {
        const state = JSON.parse(readFileSync(repairStatePath, "utf8")) as {
          serviceMode?: unknown;
        };
        assert.ok(
          state.serviceMode === "unavailable"
          || state.serviceMode === "healthy",
        );
        return state.serviceMode;
      };
      const created = createIntake(context, readIncidentServiceMode);
      const createIncidentStore = () => new OpsWorkerTaskStore(context.stateDirectory, {
        registry: created.contracts.taskRegistry,
        now: context.clock.now,
      });
      const startIncidentSupervisor = async (
        instanceId: string,
        reconcileActiveRun?: OpsWorkerSupervisorOptions["reconcileActiveRun"],
      ): Promise<{ store: OpsWorkerTaskStore; supervisor: OpsWorkerSupervisor }> => {
        const store = createIncidentStore();
        const supervisor = new OpsWorkerSupervisor({
          store,
          doneChecks: created.contracts.doneChecks,
          authorizationVerifiers: created.contracts.authorizationVerifiers,
          instanceId,
          processStartToken: `${instanceId}-start`,
          now: context.clock.now,
          infrastructureRetryMs: 1_000,
          authorizationQueryRetryMs: 1_000,
          reconcileActiveRun,
        });
        await supervisor.start();
        context.defer(() => supervisor.close());
        return { store, supervisor };
      };

      const ambiguousSubmission = created.intake.submit(
        Buffer.from(JSON.stringify(
          alertmanagerGroupWebhook("AmbiguousReportWarning", "warning"),
        )),
        CONTENT_TYPE,
      );
      assert.ok(ambiguousSubmission.taskId);
      const ambiguousTaskId = ambiguousSubmission.taskId;
      const first = await startIncidentSupervisor("complete-chain-first");
      first.supervisor.markRunning(
        ambiguousTaskId,
        activeRun(first.supervisor, "attempt-ambiguous-report"),
      );
      first.supervisor.close();

      const ambiguous = await startIncidentSupervisor(
        "complete-chain-ambiguous",
        () => ({
          status: "AMBIGUOUS",
          summary: "The fixture process group has an unknown external outcome.",
        }),
      );
      const attempted = await ambiguous.supervisor.recordReportAttempt(
        ambiguousTaskId,
        async () => ({
          sent: false,
          error: "The fixture report delivery has an unknown external outcome.",
        }),
      );
      const ambiguousReceipt = structuredClone(attempted.mutationReceipts.report);
      assert.ok(ambiguousReceipt?.mutationStartedAt);
      assert.equal(ambiguousReceipt.outcome, null);
      ambiguous.supervisor.close();

      const recovered = await startIncidentSupervisor(
        "complete-chain-recovered",
        () => ({
          status: "GONE",
          summary: "The fixture process group is proven inactive.",
        }),
      );
      const isolated = recovered.store.get(ambiguousTaskId);
      assert.equal(isolated?.state, "BLOCKED");
      assert.equal(isolated?.custody.status, "RELEASED");
      assert.equal(isolated?.activeRun, null);
      assert.deepEqual(isolated?.mutationReceipts.report, ambiguousReceipt);
      assert.match(
        isolated?.report.lastError ?? "",
        /external-outcome reconciliation/,
      );
      assert.throws(
        () => recovered.supervisor.retryBlockedTask(ambiguousTaskId),
        /claimed report receipt still requires reconciliation/,
      );

      const statusServer = await startOpsWorkerStatusServer({
        supervisor: recovered.supervisor,
        inspectPolicy: () => inspectOpsWorkerPolicy({
          authorizationVerifiers: created.contracts.authorizationVerifiers,
          doneChecks: created.contracts.doneChecks,
        }),
        host: "127.0.0.1",
        port: 0,
        alertmanagerIntake: {
          intake: created.intake,
          bearerTokenProvider: () => BRIDGE_OPS_BEARER,
        },
      });
      context.observe({ kind: "socket-bind", host: "127.0.0.1" });
      context.defer(() => statusServer.close());

      const health = await requestLoopback({
        port: statusServer.port,
        path: "/healthz",
        method: "GET",
      });
      assert.equal(health.status, 200);
      assert.equal((JSON.parse(health.body) as { ok: boolean }).ok, true);
      const status = await requestLoopback({
        port: statusServer.port,
        path: "/status",
        method: "GET",
      });
      assert.equal(status.status, 200);
      assert.equal(
        (JSON.parse(status.body) as { reportReconciliationBlocked: number })
          .reportReconciliationBlocked,
        1,
      );

      const recoveryWarning = alertmanagerGroupWebhook(
        "RecoveryActionWarning",
        "warning",
      );
      const recoveryBody = Buffer.from(JSON.stringify(recoveryWarning), "utf8");
      const directlyAccepted = await requestLoopback({
        port: statusServer.port,
        method: "POST",
        headers: {
          authorization: `Bearer ${BRIDGE_OPS_BEARER}`,
          "content-type": CONTENT_TYPE,
          "content-length": recoveryBody.byteLength,
        },
        body: recoveryBody,
      });
      assert.equal(directlyAccepted.status, 200);
      const accepted = JSON.parse(directlyAccepted.body) as {
        taskId: string;
        replayed: boolean;
      };
      assert.equal(accepted.replayed, false);
      assert.notEqual(accepted.taskId, ambiguousTaskId);
      assert.deepEqual(
        recovered.store.get(ambiguousTaskId)?.mutationReceipts.report,
        ambiguousReceipt,
      );

      const bridgePayloads = new Map([
        ["QuietRetryWarningA", alertmanagerGroupWebhook("QuietRetryWarningA", "warning")],
        ["QuietRetryWarningB", alertmanagerGroupWebhook("QuietRetryWarningB", "warning")],
        ["IndependentCritical", alertmanagerGroupWebhook("IndependentCritical", "critical")],
        ["RecoveryActionWarning", recoveryWarning],
      ]);
      const sourceQueries = new Map<string, number>();
      const opsAttempts = new Map<string, number>();
      const nativeMessages: string[] = [];
      let opsAvailable = false;
      let recoveredIntakeResult: {
        ok?: boolean;
        taskId?: string;
        replayed?: boolean;
      } | undefined;
      const syntheticBase = await startLoopbackServer(context, (request, response) => {
        if (
          request.method === "GET"
          && request.url?.startsWith("/api/v2/alerts/groups?")
        ) {
          const filters = new URL(
            request.url,
            "http://127.0.0.1",
          ).searchParams.getAll("filter");
          const alertnameFilter = filters.find((value) =>
            value.startsWith("alertname="));
          assert.ok(alertnameFilter);
          const alertname = JSON.parse(
            alertnameFilter.slice("alertname=".length),
          ) as string;
          const payload = bridgePayloads.get(alertname);
          assert.ok(payload);
          sourceQueries.set(alertname, (sourceQueries.get(alertname) ?? 0) + 1);
          const alert = (payload.alerts as Array<Record<string, unknown>>)[0];
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify([{
            labels: payload.groupLabels,
            routeLabels: {},
            receiver: { name: payload.receiver },
            alerts: [{
              labels: alert.labels,
              status: { state: "active" },
              startsAt: alert.startsAt,
              fingerprint: alert.fingerprint,
            }],
          }]));
          return;
        }

        let body = "";
        request.setEncoding("utf8").on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          void (async () => {
            if (request.url === "/intake/alertmanager") {
              const payload = JSON.parse(body) as {
                alerts: Array<{ labels: { alertname: string } }>;
              };
              const alertname = payload.alerts[0].labels.alertname;
              opsAttempts.set(alertname, (opsAttempts.get(alertname) ?? 0) + 1);
              response.setHeader("content-type", "application/json");
              if (!opsAvailable) {
                response.statusCode = 503;
                response.end(JSON.stringify({ ok: false }));
                return;
              }
              const forwardedBody = Buffer.from(body, "utf8");
              const forwarded = await requestLoopback({
                port: statusServer.port,
                method: "POST",
                headers: {
                  authorization: `Bearer ${BRIDGE_OPS_BEARER}`,
                  "content-type": CONTENT_TYPE,
                  "content-length": forwardedBody.byteLength,
                },
                body: forwardedBody,
              });
              response.statusCode = forwarded.status;
              response.end(forwarded.body);
              recoveredIntakeResult = JSON.parse(forwarded.body) as {
                taskId?: string;
                replayed?: boolean;
              };
              return;
            }
            if (request.url?.includes("/sendMessage")) {
              nativeMessages.push(new URLSearchParams(body).get("text") ?? "");
              response.setHeader("content-type", "application/json");
              response.end(JSON.stringify({ ok: true, result: {} }));
              return;
            }
            response.statusCode = 404;
            response.end();
          })().catch((error: unknown) => {
            response.statusCode = 500;
            response.end(JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }));
          });
        });
      });

      const sops = join(context.root, "fault-lab-sops");
      writeFileSync(
        sops,
        `#!/bin/sh\nprintf '%s\\n' '${BRIDGE_OPS_BEARER}'\n`,
        { mode: 0o700 },
      );
      chmodSync(sops, 0o700);
      const webhookPort = await reserveLoopbackPort(context);
      const webhook = spawn(
        PYTHON,
        [ALERTMANAGER_WEBHOOK, "--port", String(webhookPort)],
        {
          cwd: PACKAGE_ROOT,
          env: {
            ...process.env,
            MINIME_TELEGRAM_BOT_TOKEN: BRIDGE_TELEGRAM_TOKEN,
            MINIME_TELEGRAM_API_BASE: syntheticBase,
            MINIME_TELEGRAM_ALLOW_INSECURE_TEST_API: "1",
            MINIME_TELEGRAM_CHAT_ID: "10001",
            MINIME_OPS_INTAKE_URL: `${syntheticBase}/intake/alertmanager`,
            MINIME_ALERTMANAGER_URL: syntheticBase,
            MINIME_OPS_INTAKE_SOPS_FILE: join(context.root, "ops.sops.yaml"),
            MINIME_OPS_INTAKE_SOPS_KEY: "intake.bearer",
            MINIME_SOPS_EXECUTABLE: sops,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      context.defer(() => stopChild(webhook));
      await waitForWebhookReady(webhook);
      const postBridge = (payload: Record<string, unknown>) => {
        const body = Buffer.from(JSON.stringify(payload), "utf8");
        return requestLoopback({
          port: webhookPort,
          path: "/alertmanager",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": body.byteLength,
          },
          body,
        });
      };

      for (const alertname of ["QuietRetryWarningA", "QuietRetryWarningB"]) {
        const payload = bridgePayloads.get(alertname);
        assert.ok(payload);
        assert.equal((await postBridge(payload)).status, 503);
        assert.equal((await postBridge(payload)).status, 503);
      }
      assert.equal(nativeMessages.length, 0);
      assert.equal(
        (await postBridge(bridgePayloads.get("IndependentCritical") as Record<string, unknown>))
          .status,
        503,
      );
      assert.equal(nativeMessages.length, 1);
      assert.deepEqual(
        Object.fromEntries(
          ["QuietRetryWarningA", "QuietRetryWarningB"].map((alertname) => [
            alertname,
            opsAttempts.get(alertname),
          ]),
        ),
        { QuietRetryWarningA: 2, QuietRetryWarningB: 2 },
      );

      opsAvailable = true;
      assert.equal((await postBridge(recoveryWarning)).status, 200);
      assert.deepEqual(recoveredIntakeResult, {
        ok: true,
        taskId: accepted.taskId,
        replayed: true,
      });
      const quietRecoveryPayload = bridgePayloads.get("QuietRetryWarningA");
      assert.ok(quietRecoveryPayload);
      assert.equal((await postBridge(quietRecoveryPayload)).status, 200);
      const bridgeAccepted = structuredClone(recoveredIntakeResult);
      assert.equal(bridgeAccepted?.ok, true);
      assert.equal(bridgeAccepted?.replayed, false);
      assert.ok(bridgeAccepted?.taskId);
      const bridgedTaskId = bridgeAccepted.taskId;
      assert.notEqual(bridgedTaskId, accepted.taskId);
      assert.notEqual(bridgedTaskId, ambiguousTaskId);
      assert.equal((await postBridge(quietRecoveryPayload)).status, 200);
      assert.deepEqual(recoveredIntakeResult, {
        ok: true,
        taskId: bridgedTaskId,
        replayed: false,
      });
      assert.equal(opsAttempts.get("QuietRetryWarningA"), 3);
      assert.equal(nativeMessages.length, 1);
      assert.deepEqual(
        Object.fromEntries(sourceQueries),
        {
          QuietRetryWarningA: 3,
          QuietRetryWarningB: 2,
          IndependentCritical: 1,
          RecoveryActionWarning: 1,
        },
      );

      assert.equal(readIncidentServiceMode(), "unavailable");
      const diagnosticAttempt = activeRun(
        recovered.supervisor,
        "attempt-before-recovery-action",
      );
      recovered.supervisor.markRunning(bridgedTaskId, diagnosticAttempt);
      recovered.supervisor.recordPiAgentResult(bridgedTaskId, {
        attemptId: diagnosticAttempt.attemptId,
        kind: "remediation-complete",
        summary: "Diagnosed the fixture service as unavailable before the bounded repair.",
        actions: ["Confirmed the fixture remained unavailable before repair."],
        requestedInput: null,
        reason: null,
      });
      const stillUnavailable = await recovered.supervisor.runDoneCheck(
        bridgedTaskId,
      );
      assert.equal(stillUnavailable.state, "RESUMABLE");
      assert.equal(stillUnavailable.verification?.outcome, "PRODUCT_FAILURE");

      writeFileSync(
        repairStatePath,
        `${JSON.stringify({ serviceMode: "healthy" })}\n`,
        { mode: 0o600 },
      );
      assert.deepEqual(JSON.parse(readFileSync(repairStatePath, "utf8")), {
        serviceMode: "healthy",
      });
      const recoveryAttempt = activeRun(
        recovered.supervisor,
        "attempt-recovery-action",
      );
      recovered.supervisor.markRunning(bridgedTaskId, recoveryAttempt);
      recovered.supervisor.recordPiAgentResult(bridgedTaskId, {
        attemptId: recoveryAttempt.attemptId,
        kind: "remediation-complete",
        summary: "Diagnosed the fixture service as unavailable before the bounded repair.",
        actions: ["Changed the fixture service mode from unavailable to healthy."],
        requestedInput: null,
        reason: null,
      });
      const stabilizing = await recovered.supervisor.runDoneCheck(bridgedTaskId);
      assert.equal(stabilizing.state, "CHECKING");
      assert.equal(stabilizing.verification?.outcome, "NOT_READY");
      context.clock.advance(5 * 60 * 1_000 + 1);
      const passed = await recovered.supervisor.runDoneCheck(bridgedTaskId);
      assert.equal(
        passed.state,
        "DONE",
        JSON.stringify({
          outcome: passed.verification?.outcome,
          summary: passed.verification?.summary,
          components: passed.verification?.components,
        }),
      );
      assert.equal(passed.verification?.outcome, "PASS");
      assert.equal(passed.report.state, "PENDING");
      assert.equal(passed.agentResult?.actions.length, 1);

      const resultTransport = new FakeTelegramTransport(context.observe);
      const reportTick = await createTelegramControl(
        context,
        recovered.supervisor,
        resultTransport,
      ).tick();
      assert.equal(reportTick.reportTaskId, bridgedTaskId);
      assert.equal(resultTransport.messages.length, 1);
      const resultReport = String(resultTransport.messages[0].text);
      assert.match(resultReport, /Result: remediation-complete/);
      assert.match(resultReport, /Diagnosis: Diagnosed the fixture service/);
      assert.match(resultReport, /Actions: Changed the fixture service mode/);
      assert.match(resultReport, /Verification: PASS/);
      for (const component of [
        "monitoring-freshness/PASS",
        "exact-group-absence/PASS",
        "resolution-stability/PASS",
      ]) {
        assert.match(resultReport, new RegExp(component));
      }
      const reported = recovered.store.get(bridgedTaskId);
      assert.equal(reported?.report.state, "SENT");
      assert.equal(reported?.report.attempts, 1);
      assert.equal(
        reported?.mutationReceipts.report?.outcome?.result,
        "APPLIED",
      );
      assert.deepEqual(
        recovered.store.get(ambiguousTaskId)?.mutationReceipts.report,
        ambiguousReceipt,
      );

      const cronWorkspace = join(context.root, "cron-workspace");
      const cronHome = join(context.root, "cron-home");
      const launchAgentsDir = join(cronHome, "Library", "LaunchAgents");
      const metricDir = join(context.root, "cron-metrics");
      mkdirSync(cronWorkspace, { recursive: true });
      mkdirSync(launchAgentsDir, { recursive: true });
      writeFileSync(join(cronWorkspace, "crons.yaml"), "crons: []\n", "utf8");
      const cronName = "retired-failed-cron";
      const cronLabel = `ai.minime.cron.${cronName}`;
      const stalePlist = join(launchAgentsDir, `${cronLabel}.plist`);
      writeFileSync(
        stalePlist,
        `<plist><dict><key>Label</key><string>${cronLabel}</string><key>EnvironmentVariables</key><dict><key>${CRON_HEALTH_TEXTFILE_DIR_ENV}</key><string>${metricDir}</string></dict></dict></plist>\n`,
        "utf8",
      );
      const artifacts = resolveCronHealthMetricArtifacts(cronName, metricDir);
      mkdirSync(metricDir, { recursive: true });
      writeFileSync(
        artifacts.exitFilePath,
        'minime_cron_last_exit_code{cron="retired-failed-cron"} 1\n',
        "utf8",
      );
      writeFileSync(
        artifacts.successFilePath,
        'minime_cron_last_success_timestamp_seconds{cron="retired-failed-cron"} 0\n',
        "utf8",
      );
      const unrelatedMetric = join(metricDir, "unrelated.prom");
      writeFileSync(unrelatedMetric, "unrelated_metric 1\n", "utf8");
      const ambiguousTaskArtifact = join(
        recovered.store.tasksDirectory,
        `${ambiguousTaskId}.json`,
      );
      const reportedTaskArtifact = join(
        recovered.store.tasksDirectory,
        `${bridgedTaskId}.json`,
      );
      const taskArtifactsBefore = [
        readFileSync(ambiguousTaskArtifact, "utf8"),
        readFileSync(reportedTaskArtifact, "utf8"),
      ];
      const commandRunner: LaunchdCommandRunner = (_command, args) => {
        if (args[0] === "print") {
          return { status: 3, stdout: "", stderr: "Could not find service" };
        }
        if (args[0] === "bootout") {
          return { status: 3, stdout: "", stderr: "Could not find service" };
        }
        return { status: 0, stdout: "", stderr: "" };
      };
      const fixturePlutil = join(context.root, "fixture-plutil");
      copyFileSync(new URL("./plutil-convert.py", import.meta.url), fixturePlutil);
      chmodSync(fixturePlutil, 0o700);
      const cronResult = syncLaunchdCrons({
        workspace: cronWorkspace,
        launchAgentsDir,
        homeDir: cronHome,
        uid: 501,
        env: {
          HOME: cronHome,
          LOG_DIR: join(context.root, "cron-logs"),
          PLUTIL_BIN: fixturePlutil,
          UID: "501",
          [CRON_HEALTH_TEXTFILE_DIR_ENV]: metricDir,
        },
        commandRunner,
      });
      assert.equal(existsSync(stalePlist), false);
      assert.equal(existsSync(artifacts.exitFilePath), false);
      assert.equal(existsSync(artifacts.successFilePath), false);
      assert.equal(readFileSync(unrelatedMetric, "utf8"), "unrelated_metric 1\n");
      assert.deepEqual(
        cronResult.items.find((item) => item.label === cronLabel)?.metricRetirement,
        {
          status: "applied",
          removedArtifactCount: 2,
        },
      );
      assert.deepEqual(
        [
          readFileSync(ambiguousTaskArtifact, "utf8"),
          readFileSync(reportedTaskArtifact, "utf8"),
        ],
        taskArtifactsBefore,
      );
    },
  },
];

assert.deepEqual(
  SCENARIOS.map((scenario) => scenario.name),
  OPS_WORKER_FAULT_LAB_SCENARIO_NAMES,
);

async function runScenario(
  definition: ScenarioDefinition,
  observe: SafetyObserver,
): Promise<OpsWorkerFaultLabScenarioResult> {
  const root = mkdtempSync(join(tmpdir(), `minime-ops-fault-lab-${definition.name}-`));
  const deferred: Array<() => void | Promise<void>> = [];
  const context: ScenarioContext = {
    root,
    stateDirectory: join(root, "state"),
    clock: new DeterministicClock(),
    observe,
    defer(callback) {
      deferred.push(callback);
    },
  };
  try {
    await definition.run(context);
    return { name: definition.name, outcome: "PASS", summary: definition.summary };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: definition.name,
      outcome: "FAIL",
      summary: `Fault-lab assertion failed: ${message.split(root).join("<state-dir>")}`,
    };
  } finally {
    for (const callback of deferred.reverse()) {
      try {
        await callback();
      } catch {
        // Scenario assertions capture the primary failure; cleanup remains best-effort.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

export async function runOpsWorkerFaultLab(
  observe: SafetyObserver = () => undefined,
): Promise<OpsWorkerFaultLabAggregate> {
  const scenarios: OpsWorkerFaultLabScenarioResult[] = [];
  for (const definition of SCENARIOS) {
    scenarios.push(await runScenario(definition, observe));
  }
  const failures = scenarios
    .filter((scenario) => scenario.outcome === "FAIL")
    .map((scenario) => scenario.name);
  return {
    labVersion: 1,
    scenarios,
    failures,
    pass: failures.length === 0,
  };
}
