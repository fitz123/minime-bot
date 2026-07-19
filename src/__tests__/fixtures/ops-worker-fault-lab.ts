import assert from "node:assert/strict";
import type { CodexQuotaSnapshot } from "../../pi-extensions/codex-usage.js";
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
  OPS_AVAILABILITY_TEMPLATE_NAME,
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
    schemaVersion: 5,
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

function availabilityContracts() {
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
      readMonitoringFreshness: () => healthyReadings().monitoring as OpsMonitoringFreshnessReading,
    },
    alertStateReader: {
      read: () => healthyReadings().alerts as OpsAlertStateReading,
    },
    serviceAvailabilityReader: {
      readServiceAvailability: () => healthyReadings().service as OpsServiceAvailabilityReading,
    },
  });
}

function alertmanagerWebhook(
  startsAt = "2026-07-19T11:59:00.000Z",
): Record<string, unknown> {
  return {
    receiver: "ops-worker",
    status: "firing",
    alerts: [{
      status: "firing",
      labels: { alertname: "MinimeBotUnavailable", instance: "local" },
      annotations: { summary: "The generic local service is unavailable." },
      startsAt,
      endsAt: "0001-01-01T00:00:00Z",
      generatorURL: "http://127.0.0.1:9090/graph?g0.expr=up",
      fingerprint: "0123456789abcdef",
    }],
    groupLabels: { alertname: "MinimeBotUnavailable" },
    commonLabels: { alertname: "MinimeBotUnavailable", instance: "local" },
    commonAnnotations: { summary: "The generic local service is unavailable." },
    externalURL: "http://127.0.0.1:9093",
    version: "4",
    groupKey: "{}:{alertname=\"MinimeBotUnavailable\", instance=\"local\"}",
    truncatedAlerts: 0,
  };
}

function createIntake(
  context: ScenarioContext,
): {
  intake: OpsWorkerAlertmanagerIntake;
  store: OpsWorkerTaskStore;
  contracts: ReturnType<typeof availabilityContracts>;
} {
  const contracts = availabilityContracts();
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
  headers?: Record<string, string | number>;
  body?: Buffer;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolveRequest, rejectRequest) => {
    const request = nodeHttpRequest({
      host: "127.0.0.1",
      port: options.port,
      path: "/intake/alertmanager",
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
      const { store, supervisor } = await createSupervisor(context);
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
      const cancelled = supervisor.completeOperatorInterrupt(
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
      const fenced = supervisor.blockAmbiguousActiveRun(
        ambiguousTask.id,
        ambiguous.summary ?? "Synthetic process-group stop ambiguity.",
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
