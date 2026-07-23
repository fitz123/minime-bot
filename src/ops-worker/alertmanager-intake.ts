import { createHash } from "node:crypto";
import type {
  OpsWorkerDoneCheckContractIdentity,
  OpsWorkerDoneCheckRegistry,
} from "./done-checks.js";
import {
  OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME,
  OPS_ALERTMANAGER_INCIDENT_OBJECTIVE,
  OPS_ALERTMANAGER_INCIDENT_TEMPLATE_NAME,
  OPS_AVAILABILITY_RESOURCE_KEY,
  OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
  hashOpsAlertmanagerAuthorizationSnapshot,
} from "./ops-contracts.js";
import type { OpsWorkerTaskStore } from "./task-store.js";
import {
  OPS_WORKER_LIMITS,
  OPS_WORKER_SOURCE_PRIORITIES,
  OPS_WORKER_TASK_SCHEMA_VERSION,
  createEmptyOpsWorkerLifecycleManifest,
  createEmptyOpsWorkerMutationReceipts,
  createUnclaimedOpsWorkerCustody,
  isOpsWorkerRegisteredName,
  withOpsWorkerSubmissionFingerprint,
  type OpsWorkerEvidence,
  type OpsWorkerTask,
} from "./types.js";

export const OPS_ALERTMANAGER_INTAKE_LIMITS = Object.freeze({
  maxBodyBytes: 256 * 1024,
  maxAlerts: 1_024,
  maxLabelEntries: OPS_WORKER_LIMITS.maxAlertmanagerGroupLabelEntries,
  maxAnnotationEntries: 64,
  maxKeyBytes: OPS_WORKER_LIMITS.maxAlertmanagerGroupLabelKeyBytes,
  maxLabelValueBytes: OPS_WORKER_LIMITS.maxAlertmanagerGroupLabelValueBytes,
  maxAnnotationValueBytes: 8 * 1024,
  maxGroupKeyBytes: 8 * 1024,
  maxReceiverBytes: 1024,
  maxExternalUrlBytes: 8 * 1024,
  maxFingerprintBytes: 512,
  maxTruncatedAlerts: 1_000_000,
} as const);

export type OpsWorkerAlertmanagerIntakeErrorCode =
  | "UNSUPPORTED_MEDIA_TYPE"
  | "BODY_TOO_LARGE"
  | "MALFORMED_JSON"
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_VERSION";

export class OpsWorkerAlertmanagerIntakeError extends Error {
  readonly code: OpsWorkerAlertmanagerIntakeErrorCode;

  constructor(code: OpsWorkerAlertmanagerIntakeErrorCode, message: string) {
    super(message);
    this.name = "OpsWorkerAlertmanagerIntakeError";
    this.code = code;
  }
}

export interface OpsAlertmanagerWebhookAlert {
  status: "firing" | "resolved";
  labels: Record<string, string>;
  annotations: Record<string, string>;
  startsAt: string;
  endsAt?: string;
  generatorURL?: string;
  fingerprint?: string;
}

export interface OpsAlertmanagerWebhook {
  version: "4";
  groupKey: string;
  status: "firing" | "resolved";
  alerts: OpsAlertmanagerWebhookAlert[];
  receiver?: string;
  groupLabels?: Record<string, string>;
  commonLabels?: Record<string, string>;
  commonAnnotations?: Record<string, string>;
  externalURL?: string;
  truncatedAlerts?: number;
}

export interface OpsWorkerAlertmanagerIntakeResult {
  ok: true;
  taskId: string | null;
  replayed: boolean;
}

export interface OpsWorkerAlertmanagerIntakeOptions {
  store: OpsWorkerTaskStore;
  doneChecks: OpsWorkerDoneCheckRegistry;
  sourceIdentity: string;
  now?: () => Date;
}

const TOP_LEVEL_KEYS = [
  "receiver",
  "status",
  "alerts",
  "groupLabels",
  "commonLabels",
  "commonAnnotations",
  "externalURL",
  "version",
  "groupKey",
  "truncatedAlerts",
] as const;
const TOP_LEVEL_REQUIRED_KEYS = ["status", "alerts", "version", "groupKey"] as const;
const ALERT_KEYS = [
  "status",
  "labels",
  "annotations",
  "startsAt",
  "endsAt",
  "generatorURL",
  "fingerprint",
] as const;
const ALERT_REQUIRED_KEYS = ["status", "labels", "annotations", "startsAt"] as const;
const RFC3339_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const TRUNCATION_MARKER = "… [truncated]";

function fail(
  code: OpsWorkerAlertmanagerIntakeErrorCode,
  message: string,
): never {
  throw new OpsWorkerAlertmanagerIntakeError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail("INVALID_PAYLOAD", `${path} must be a plain object`);
  return value;
}

function expectExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) fail("INVALID_PAYLOAD", `${path}.${key} is unknown`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail("INVALID_PAYLOAD", `${path}.${key} is required`);
    }
  }
}

function expectString(
  value: unknown,
  path: string,
  maxBytes: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > maxBytes
  ) fail("INVALID_PAYLOAD", `${path} must be bounded text`);
  return value;
}

function optionalString(
  value: unknown,
  path: string,
  maxBytes: number,
): string | undefined {
  return value === undefined ? undefined : expectString(value, path, maxBytes, true);
}

function expectStatus(value: unknown, path: string): "firing" | "resolved" {
  if (value !== "firing" && value !== "resolved") {
    fail("INVALID_PAYLOAD", `${path} must be firing or resolved`);
  }
  return value;
}

function expectTimestamp(value: unknown, path: string): string {
  const timestamp = expectString(value, path, 128);
  if (!RFC3339_PATTERN.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    fail("INVALID_PAYLOAD", `${path} must be a valid RFC3339 timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function expectStringMap(
  value: unknown,
  path: string,
  maxEntries: number,
  maxValueBytes: number,
): Record<string, string> {
  const object = expectObject(value, path);
  const entries = Object.entries(object);
  if (entries.length > maxEntries) {
    fail("INVALID_PAYLOAD", `${path} contains too many entries`);
  }
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, rawValue] of entries) {
    const boundedKey = expectString(key, `${path} key`, OPS_ALERTMANAGER_INTAKE_LIMITS.maxKeyBytes);
    result[boundedKey] = expectString(
      rawValue,
      `${path}.${key}`,
      maxValueBytes,
      true,
    );
  }
  return result;
}

function parseAlert(value: unknown, index: number): OpsAlertmanagerWebhookAlert {
  const path = `alertmanager.alerts[${index}]`;
  const alert = expectObject(value, path);
  expectExactKeys(alert, ALERT_KEYS, ALERT_REQUIRED_KEYS, path);
  return {
    status: expectStatus(alert.status, `${path}.status`),
    labels: expectStringMap(
      alert.labels,
      `${path}.labels`,
      OPS_ALERTMANAGER_INTAKE_LIMITS.maxLabelEntries,
      OPS_ALERTMANAGER_INTAKE_LIMITS.maxLabelValueBytes,
    ),
    annotations: expectStringMap(
      alert.annotations,
      `${path}.annotations`,
      OPS_ALERTMANAGER_INTAKE_LIMITS.maxAnnotationEntries,
      OPS_ALERTMANAGER_INTAKE_LIMITS.maxAnnotationValueBytes,
    ),
    startsAt: expectTimestamp(alert.startsAt, `${path}.startsAt`),
    ...(alert.endsAt === undefined
      ? {}
      : { endsAt: expectTimestamp(alert.endsAt, `${path}.endsAt`) }),
    ...(alert.generatorURL === undefined
      ? {}
      : {
          generatorURL: expectString(
            alert.generatorURL,
            `${path}.generatorURL`,
            OPS_ALERTMANAGER_INTAKE_LIMITS.maxExternalUrlBytes,
            true,
          ),
        }),
    ...(alert.fingerprint === undefined
      ? {}
      : {
          fingerprint: expectString(
            alert.fingerprint,
            `${path}.fingerprint`,
            OPS_ALERTMANAGER_INTAKE_LIMITS.maxFingerprintBytes,
            true,
          ),
        }),
  };
}

function parseWebhook(value: unknown): OpsAlertmanagerWebhook {
  const root = expectObject(value, "alertmanager");
  expectExactKeys(root, TOP_LEVEL_KEYS, TOP_LEVEL_REQUIRED_KEYS, "alertmanager");
  if (root.version !== "4") {
    fail("UNSUPPORTED_VERSION", "alertmanager.version must be 4");
  }
  if (!Array.isArray(root.alerts)) {
    fail("INVALID_PAYLOAD", "alertmanager.alerts must be an array");
  }
  if (
    root.alerts.length < 1
    || root.alerts.length > OPS_ALERTMANAGER_INTAKE_LIMITS.maxAlerts
  ) {
    fail(
      "INVALID_PAYLOAD",
      `alertmanager.alerts must contain 1-${OPS_ALERTMANAGER_INTAKE_LIMITS.maxAlerts} entries`,
    );
  }
  const status = expectStatus(root.status, "alertmanager.status");
  const alerts = root.alerts.map(parseAlert);
  const firingCount = alerts.filter((entry) => entry.status === "firing").length;
  if (
    (status === "resolved" && firingCount !== 0)
    || (status === "firing" && firingCount === 0)
  ) fail("INVALID_PAYLOAD", "alertmanager status does not match its alert statuses");
  if (
    root.truncatedAlerts !== undefined
    && (
      !Number.isSafeInteger(root.truncatedAlerts)
      || (root.truncatedAlerts as number) < 0
      || (root.truncatedAlerts as number) > OPS_ALERTMANAGER_INTAKE_LIMITS.maxTruncatedAlerts
    )
  ) fail("INVALID_PAYLOAD", "alertmanager.truncatedAlerts must be a bounded non-negative integer");
  const groupLabels = root.groupLabels === undefined
    ? undefined
    : expectStringMap(
        root.groupLabels,
        "alertmanager.groupLabels",
        OPS_ALERTMANAGER_INTAKE_LIMITS.maxLabelEntries,
        OPS_ALERTMANAGER_INTAKE_LIMITS.maxLabelValueBytes,
      );
  if (
    firingCount > 0
    && groupLabels !== undefined
    && alerts.some((alert) =>
      alert.status === "firing"
      && Object.entries(groupLabels).some(([key, value]) => alert.labels[key] !== value))
  ) {
    fail(
      "INVALID_PAYLOAD",
      "alertmanager.groupLabels must match every firing alert",
    );
  }
  return {
    version: "4",
    groupKey: expectString(
      root.groupKey,
      "alertmanager.groupKey",
      OPS_ALERTMANAGER_INTAKE_LIMITS.maxGroupKeyBytes,
    ),
    status,
    alerts,
    ...(root.receiver === undefined
      ? {}
      : {
          receiver: expectString(
            root.receiver,
            "alertmanager.receiver",
            OPS_ALERTMANAGER_INTAKE_LIMITS.maxReceiverBytes,
          ),
        }),
    ...(groupLabels === undefined
      ? {}
      : { groupLabels }),
    ...(root.commonLabels === undefined
      ? {}
      : {
          commonLabels: expectStringMap(
            root.commonLabels,
            "alertmanager.commonLabels",
            OPS_ALERTMANAGER_INTAKE_LIMITS.maxLabelEntries,
            OPS_ALERTMANAGER_INTAKE_LIMITS.maxLabelValueBytes,
          ),
        }),
    ...(root.commonAnnotations === undefined
      ? {}
      : {
          commonAnnotations: expectStringMap(
            root.commonAnnotations,
            "alertmanager.commonAnnotations",
            OPS_ALERTMANAGER_INTAKE_LIMITS.maxAnnotationEntries,
            OPS_ALERTMANAGER_INTAKE_LIMITS.maxAnnotationValueBytes,
          ),
        }),
    ...(root.externalURL === undefined
      ? {}
      : {
          externalURL: expectString(
            root.externalURL,
            "alertmanager.externalURL",
            OPS_ALERTMANAGER_INTAKE_LIMITS.maxExternalUrlBytes,
            true,
          ),
        }),
    ...(root.truncatedAlerts === undefined
      ? {}
      : { truncatedAlerts: root.truncatedAlerts as number }),
  };
}

function bodyBuffer(body: Uint8Array | string): Buffer {
  return typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
}

export function parseOpsAlertmanagerWebhook(
  body: Uint8Array | string,
  contentType: string | undefined,
): OpsAlertmanagerWebhook {
  if (contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    fail("UNSUPPORTED_MEDIA_TYPE", "Alertmanager intake requires application/json");
  }
  const bytes = bodyBuffer(body);
  if (bytes.byteLength > OPS_ALERTMANAGER_INTAKE_LIMITS.maxBodyBytes) {
    fail(
      "BODY_TOO_LARGE",
      `Alertmanager intake body exceeds ${OPS_ALERTMANAGER_INTAKE_LIMITS.maxBodyBytes} bytes`,
    );
  }
  let decoded: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    decoded = JSON.parse(text) as unknown;
  } catch {
    fail("MALFORMED_JSON", "Alertmanager intake body is malformed JSON");
  }
  return parseWebhook(decoded);
}

function hashIdentity(domain: string, ...parts: string[]): string {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const part of parts) {
    hash.update("\0");
    hash.update(part);
  }
  return hash.digest("hex");
}

function canonicalGroupIdentity(
  groupLabels: Record<string, string> | undefined,
): string {
  if (groupLabels === undefined) {
    fail(
      "INVALID_PAYLOAD",
      "Alertmanager firing groups require groupLabels for exact correlation",
    );
  }
  return JSON.stringify(Object.fromEntries(
    Object.entries(groupLabels).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const contentLimit = maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > contentLimit) break;
    result += character;
  }
  return `${result}${TRUNCATION_MARKER}`;
}

function alertEvidence(alert: OpsAlertmanagerWebhookAlert, at: string): OpsWorkerEvidence {
  const summary = JSON.stringify({
    status: alert.status,
    startsAt: alert.startsAt,
    labels: alert.labels,
    annotations: alert.annotations,
    generatorURL: alert.generatorURL ?? null,
    fingerprint: alert.fingerprint ?? null,
  });
  return {
    at,
    kind: "alert",
    trust: "untrusted",
    summary: truncateUtf8(summary, OPS_WORKER_LIMITS.maxEvidenceSummaryBytes),
    artifact: null,
  };
}

function alertGroupCorrelationEvidence(
  correlationKey: string,
  groupLabels: Record<string, string> | undefined,
  at: string,
): OpsWorkerEvidence {
  if (groupLabels === undefined) {
    fail(
      "INVALID_PAYLOAD",
      "Alertmanager firing groups require groupLabels for exact correlation",
    );
  }
  const value = {
    type: "alertmanager-group-correlation-v1",
    correlationKey,
    groupLabels,
  };
  const summary = JSON.stringify(value);
  if (
    Buffer.byteLength(summary, "utf8")
    > OPS_WORKER_LIMITS.maxAlertmanagerGroupCorrelationEvidenceBytes
  ) {
    fail(
      "INVALID_PAYLOAD",
      "Alertmanager groupLabels exceed the exact correlation evidence bound",
    );
  }
  return {
    at,
    kind: "alert",
    trust: "untrusted",
    summary,
    artifact: null,
  };
}

function boundedAlertEvidence(
  firingAlerts: readonly OpsAlertmanagerWebhookAlert[],
  upstreamOmittedAlerts: number,
  at: string,
): OpsWorkerEvidence[] {
  // Reserve one entry for the group descriptor and one for the store-owned
  // accepted-firing observation added when the task is persisted.
  const directCapacity = OPS_WORKER_LIMITS.maxEvidenceEntries - 2;
  if (upstreamOmittedAlerts === 0 && firingAlerts.length <= directCapacity) {
    return firingAlerts.map((entry) => alertEvidence(entry, at));
  }
  const retained = firingAlerts.slice(0, directCapacity - 1);
  const locallyOmittedFiringAlerts = firingAlerts.length - retained.length;
  return [
    ...retained.map((entry) => alertEvidence(entry, at)),
    {
      at,
      kind: "alert",
      trust: "untrusted",
      summary: JSON.stringify({
        type: "alertmanager-alert-omission-v1",
        includedAlerts: retained.length,
        omittedAlerts: locallyOmittedFiringAlerts + upstreamOmittedAlerts,
        locallyOmittedFiringAlerts,
        upstreamOmittedAlerts,
        deliveredFiringAlerts: firingAlerts.length,
      }),
      artifact: null,
    },
  ];
}

export class OpsWorkerAlertmanagerIntake {
  private readonly store: OpsWorkerTaskStore;
  private readonly doneCheck: OpsWorkerDoneCheckContractIdentity;
  private readonly sourceIdentity: string;
  private readonly now: () => Date;

  constructor(options: OpsWorkerAlertmanagerIntakeOptions) {
    if (!isOpsWorkerRegisteredName(options.sourceIdentity)) {
      throw new TypeError("Alertmanager intake sourceIdentity must be a registered name");
    }
    if (!options.store || typeof options.store.create !== "function") {
      throw new TypeError("Alertmanager intake requires an ops-worker task store");
    }
    const doneCheck = options.doneChecks?.describe(OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME);
    if (!doneCheck) {
      throw new TypeError(
        "Alertmanager intake requires the package-owned generic incident done check",
      );
    }
    this.store = options.store;
    this.doneCheck = doneCheck;
    this.sourceIdentity = options.sourceIdentity;
    this.now = options.now ?? (() => new Date());
  }

  submit(
    body: Uint8Array | string,
    contentType: string | undefined,
  ): OpsWorkerAlertmanagerIntakeResult {
    const webhook = parseOpsAlertmanagerWebhook(body, contentType);
    const firingAlerts = webhook.alerts.filter((entry) => entry.status === "firing");
    if (firingAlerts.length === 0) {
      return { ok: true, taskId: null, replayed: false };
    }
    const episodeStart = firingAlerts
      .map((entry) => entry.startsAt)
      .sort()[0];
    const groupIdentity = canonicalGroupIdentity(webhook.groupLabels);
    const correlationDigest = hashIdentity(
      "minime-ops-alertmanager-correlation-v2",
      this.sourceIdentity,
      groupIdentity,
    );
    const deliveryDigest = hashIdentity(
      "minime-ops-alertmanager-delivery-v2",
      this.sourceIdentity,
      groupIdentity,
      episodeStart,
    );
    const correlationKey = `${this.sourceIdentity}:group:${correlationDigest}`;
    const deliveryKey = `${this.sourceIdentity}:episode:${deliveryDigest}`;
    const task = this.createTask(
      firingAlerts,
      correlationKey,
      deliveryKey,
      deliveryDigest,
      webhook.groupLabels,
      webhook.truncatedAlerts ?? 0,
    );
    const created = this.store.createOrReuseActiveCorrelation(task, {
      event: "CREATED",
      summary: "Accepted authenticated Alertmanager firing episode",
    });
    return { ok: true, taskId: created.task.id, replayed: !created.created };
  }

  private createTask(
    firingAlerts: readonly OpsAlertmanagerWebhookAlert[],
    correlationKey: string,
    deliveryKey: string,
    deliveryDigest: string,
    groupLabels: Record<string, string> | undefined,
    upstreamOmittedAlerts: number,
  ): OpsWorkerTask {
    const current = this.now();
    if (!(current instanceof Date) || !Number.isFinite(current.getTime())) {
      throw new TypeError("Alertmanager intake clock returned an invalid date");
    }
    const now = current.toISOString();
    const doneCheck = this.doneCheck;
    const lifecycle = createEmptyOpsWorkerLifecycleManifest();
    lifecycle.verifier = doneCheck.verifierIdentity;
    lifecycle.verifierVersion = doneCheck.verifierVersion;
    lifecycle.verifierContractHash = doneCheck.contractHash;
    const authorizationClaim = {
      sourceIdentity: this.sourceIdentity,
      template: OPS_ALERTMANAGER_INCIDENT_TEMPLATE_NAME,
      doneCheck: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME,
      objective: OPS_ALERTMANAGER_INCIDENT_OBJECTIVE,
      profile: OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
    } as const;
    const id = `am-${deliveryDigest.slice(0, 48)}`;
    return withOpsWorkerSubmissionFingerprint({
      schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
      id,
      source: {
        kind: "alertmanager",
        correlationKey,
        deliveryKey,
        template: OPS_ALERTMANAGER_INCIDENT_TEMPLATE_NAME,
      },
      resource: { kind: "host", key: OPS_AVAILABILITY_RESOURCE_KEY },
      lifecycle,
      currentCheckpoint: null,
      mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
      custody: createUnclaimedOpsWorkerCustody(),
      priority: OPS_WORKER_SOURCE_PRIORITIES.alertmanager,
      objective: OPS_ALERTMANAGER_INCIDENT_OBJECTIVE,
      evidence: [
        alertGroupCorrelationEvidence(correlationKey, groupLabels, now),
        ...boundedAlertEvidence(firingAlerts, upstreamOmittedAlerts, now),
      ],
      doneCheck: {
        name: OPS_ALERTMANAGER_INCIDENT_DONE_CHECK_NAME,
        params: {},
      },
      authorization: {
        profile: OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
        scope: ["inspect", "local-reversible-repair"],
        snapshotHash: hashOpsAlertmanagerAuthorizationSnapshot(authorizationClaim),
      },
      authorizationVerification: null,
      verification: null,
      legacyCompletion: null,
      agentResult: null,
      steering: [],
      control: { paused: false, pausedAt: null, interrupt: null },
      state: "QUEUED",
      rounds: {
        remediation: 0,
        maxRemediation: 5,
        consecutiveInfrastructureFailures: 0,
      },
      schedule: { nextRunAt: null, nextCheckAt: null },
      session: { directory: `sessions/${id}`, sessionId: null, resume: false },
      activeRun: null,
      unverifiedRun: null,
      lastOutcome: null,
      report: { state: "NONE", attempts: 0, lastError: null },
      createdAt: now,
      updatedAt: now,
    });
  }
}
