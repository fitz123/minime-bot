import { createHash } from "node:crypto";

export const OPS_WORKER_TASK_SCHEMA_VERSION = 6 as const;
export const OPS_WORKER_TASK_V5_SCHEMA_VERSION = 5 as const;
export const OPS_WORKER_TASK_V4_SCHEMA_VERSION = 4 as const;
export const OPS_WORKER_TASK_V3_SCHEMA_VERSION = 3 as const;
export const OPS_WORKER_TASK_V2_SCHEMA_VERSION = 2 as const;
export const OPS_WORKER_TASK_LEGACY_SCHEMA_VERSION = 1 as const;

export const OPS_WORKER_SOURCE_KINDS = [
  "alertmanager",
  "operator-cli",
  "operator-telegram",
  "registered-cron",
  "authorized-issue",
] as const;

export type OpsWorkerSourceKind = (typeof OPS_WORKER_SOURCE_KINDS)[number];

export const OPS_WORKER_SOURCE_PRIORITIES = {
  alertmanager: 0,
  "operator-cli": 10,
  "operator-telegram": 10,
  "registered-cron": 20,
  "authorized-issue": 30,
} as const satisfies Record<OpsWorkerSourceKind, number>;

const OPS_WORKER_INITIAL_QUOTA_ADMISSION_REQUIRED = {
  alertmanager: false,
  "operator-cli": false,
  "operator-telegram": false,
  "registered-cron": true,
  "authorized-issue": true,
} as const satisfies Record<OpsWorkerSourceKind, boolean>;

/** Initial quota admission applies only to autonomous/background task sources. */
export function requiresOpsWorkerInitialQuotaAdmission(
  sourceKind: OpsWorkerSourceKind,
): boolean {
  return OPS_WORKER_INITIAL_QUOTA_ADMISSION_REQUIRED[sourceKind];
}

export type OpsWorkerPriority =
  (typeof OPS_WORKER_SOURCE_PRIORITIES)[OpsWorkerSourceKind];

export const OPS_WORKER_TASK_STATES = [
  "QUEUED",
  "RUNNING",
  "CHECKING",
  "RESUMABLE",
  "BLOCKED",
  "DONE",
  "CANCELLED",
] as const;

export type OpsWorkerTaskState = (typeof OPS_WORKER_TASK_STATES)[number];

export const OPS_WORKER_TERMINAL_STATES = ["DONE", "CANCELLED"] as const;

export type OpsWorkerTerminalState = (typeof OPS_WORKER_TERMINAL_STATES)[number];

export const OPS_WORKER_AUTHORIZATION_SCOPES = [
  "inspect",
  "local-reversible-repair",
  "repository-read",
  "repository-write",
  "pull-request",
  "release",
  "deploy",
  "issue-lifecycle",
] as const;

export type OpsWorkerAuthorizationScope =
  (typeof OPS_WORKER_AUTHORIZATION_SCOPES)[number];

export const OPS_WORKER_EVIDENCE_KINDS = [
  "alert",
  "operator",
  "check",
  "pi",
  "infrastructure",
  "authorization",
  "system",
] as const;

export type OpsWorkerEvidenceKind = (typeof OPS_WORKER_EVIDENCE_KINDS)[number];

export const OPS_WORKER_EVIDENCE_TRUST = ["trusted", "untrusted"] as const;

export type OpsWorkerEvidenceTrust = (typeof OPS_WORKER_EVIDENCE_TRUST)[number];

export const OPS_WORKER_OUTCOME_KINDS = [
  "PI_EXIT",
  "DONE_CHECK",
  "INFRASTRUCTURE",
  "AUTHORIZATION",
  "PREEMPTION",
  "SESSION_RESET",
  "RECONCILIATION",
  "OPERATOR",
] as const;

export type OpsWorkerOutcomeKind = (typeof OPS_WORKER_OUTCOME_KINDS)[number];

export const OPS_WORKER_OUTCOME_RESULTS = [
  "SUCCESS_CLAIM",
  "PASS",
  "ACTION_REQUIRED",
  "NOT_READY",
  "PRODUCT_FAILURE",
  "DEFER",
  "VERIFIER_INVALID",
  "QUERY_ERROR",
  "TIMEOUT",
  "ERROR",
  "QUOTA",
  "QUOTA_ADMISSION_WAIT",
  "QUOTA_TELEMETRY_ERROR",
  "QUOTA_PROBE_ERROR",
  "QUOTA_PROBE_PASS",
  "NETWORK",
  "CONTEXT_OVERFLOW",
  "CRASH",
  "STALL",
  "PROTOCOL_FAILURE",
  "PREEMPTED",
  "AMBIGUOUS_ORPHAN",
  "CANCELLED",
  "BLOCKED",
] as const;

export type OpsWorkerOutcomeResult =
  (typeof OPS_WORKER_OUTCOME_RESULTS)[number];

export const OPS_WORKER_REPORT_STATES = ["NONE", "PENDING", "SENT"] as const;

export type OpsWorkerReportState = (typeof OPS_WORKER_REPORT_STATES)[number];

export const OPS_WORKER_AGENT_RESULT_KINDS = [
  "remediation-complete",
  "no-action-needed",
  "input-needed",
  "impossible",
] as const;

export type OpsWorkerAgentResultKind =
  (typeof OPS_WORKER_AGENT_RESULT_KINDS)[number];

export const OPS_WORKER_AGENT_RESULT_REASONS = [
  "approval",
  "information",
  "policy-boundary",
  "unrecoverable",
] as const;

export type OpsWorkerAgentResultReason =
  (typeof OPS_WORKER_AGENT_RESULT_REASONS)[number];

export const OPS_WORKER_STEERING_KINDS = [
  "correction",
  "answer",
  "pause",
  "resume",
  "cancel",
] as const;

export type OpsWorkerSteeringKind = (typeof OPS_WORKER_STEERING_KINDS)[number];

export const OPS_WORKER_INTERRUPT_MODES = ["pause", "cancel"] as const;

export type OpsWorkerInterruptMode = (typeof OPS_WORKER_INTERRUPT_MODES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export const OPS_WORKER_RESOURCE_KINDS = ["host", "repository"] as const;

export type OpsWorkerResourceKind = (typeof OPS_WORKER_RESOURCE_KINDS)[number];

export const OPS_WORKER_LIFECYCLE_SCHEMA_VERSION = 2 as const;
export const OPS_WORKER_LIFECYCLE_V1_SCHEMA_VERSION = 1 as const;

export const OPS_WORKER_MUTATION_BOUNDARIES = [
  "merge",
  "tag-release",
  "deploy",
  "canonical-task",
  "report",
] as const;

export type OpsWorkerMutationBoundary =
  (typeof OPS_WORKER_MUTATION_BOUNDARIES)[number];

export const OPS_WORKER_MUTATION_OUTCOMES = [
  "APPLIED",
  "ALREADY_APPLIED",
  "NOT_NEEDED",
] as const;

export type OpsWorkerMutationOutcomeResult =
  (typeof OPS_WORKER_MUTATION_OUTCOMES)[number];

export const OPS_WORKER_CUSTODY_STATUSES = [
  "UNCLAIMED",
  "HELD",
  "RELEASED",
] as const;

export type OpsWorkerCustodyStatus =
  (typeof OPS_WORKER_CUSTODY_STATUSES)[number];

export const OPS_WORKER_CUSTODY_RELEASE_REASONS = [
  "DONE",
  "CANCELLED",
  "BLOCKED",
] as const;

export type OpsWorkerCustodyReleaseReason =
  (typeof OPS_WORKER_CUSTODY_RELEASE_REASONS)[number];

export interface OpsWorkerTaskSourceV1 {
  kind: Exclude<OpsWorkerSourceKind, "operator-telegram">;
  correlationKey: string;
  template: string;
}

export interface OpsWorkerTaskSource {
  kind: OpsWorkerSourceKind;
  correlationKey: string;
  deliveryKey: string;
  template: string;
}

export interface OpsWorkerResourceIdentity {
  kind: OpsWorkerResourceKind;
  key: string;
}

/** Fixed identity evidence only; no slot can select executable behavior. */
export interface OpsWorkerLifecycleManifest {
  schemaVersion: typeof OPS_WORKER_LIFECYCLE_SCHEMA_VERSION;
  canonicalTask: string | null;
  repository: string | null;
  base: string | null;
  head: string | null;
  branch: string | null;
  pullRequest: string | null;
  merge: string | null;
  tag: string | null;
  release: string | null;
  deploy: string | null;
  verifier: string | null;
  verifierVersion: string | null;
  verifierContractHash: string | null;
  report: string | null;
  tailAudit: string | null;
}

export type OpsWorkerLifecycleManifestV1 = Omit<
  OpsWorkerLifecycleManifest,
  "schemaVersion" | "verifierVersion" | "verifierContractHash"
> & {
  schemaVersion: typeof OPS_WORKER_LIFECYCLE_V1_SCHEMA_VERSION;
};

export interface OpsWorkerCheckpoint {
  checkpointId: string;
  recordedAt: string;
  payloadHash: string;
  summary: string;
  artifact: string | null;
  replayHistory: OpsWorkerCheckpointReplay[];
}

export interface OpsWorkerCheckpointReplay {
  checkpointId: string;
  contentHash: string;
}

export interface OpsWorkerMutationOutcome {
  recordedAt: string;
  result: OpsWorkerMutationOutcomeResult;
  evidenceHash: string;
}

export interface OpsWorkerMutationReceipt {
  boundary: OpsWorkerMutationBoundary;
  operationId: string;
  intentHash: string;
  queryObservedAt: string;
  queryResultHash: string;
  mutationStartedAt: string | null;
  outcome: OpsWorkerMutationOutcome | null;
  replayHistory: OpsWorkerMutationReceiptReplay[];
}

export interface OpsWorkerMutationReceiptReplay {
  operationId: string;
  intentHash: string;
  result: OpsWorkerMutationOutcomeResult;
  evidenceHash: string;
}

/** One bounded durable slot per permitted external mutation boundary. */
export interface OpsWorkerMutationReceipts {
  merge: OpsWorkerMutationReceipt | null;
  tagRelease: OpsWorkerMutationReceipt | null;
  deploy: OpsWorkerMutationReceipt | null;
  canonicalTask: OpsWorkerMutationReceipt | null;
  report: OpsWorkerMutationReceipt | null;
}

export interface OpsWorkerCustody {
  status: OpsWorkerCustodyStatus;
  claimedAt: string | null;
  releasedAt: string | null;
  releaseReason: OpsWorkerCustodyReleaseReason | null;
}

export interface OpsWorkerEvidence {
  at: string;
  kind: OpsWorkerEvidenceKind;
  trust: OpsWorkerEvidenceTrust;
  summary: string;
  artifact: string | null;
}

export interface OpsWorkerDoneCheck {
  name: string;
  params: JsonObject;
}

export interface OpsWorkerAuthorization {
  profile: string;
  scope: OpsWorkerAuthorizationScope[];
  snapshotHash: string | null;
}

export const OPS_WORKER_AUTHORIZATION_VERIFICATION_STATUSES = [
  "PASS",
  "DRIFT",
  "QUERY_ERROR",
  "INVALID_CLAIM",
] as const;

export type OpsWorkerAuthorizationVerificationStatus =
  (typeof OPS_WORKER_AUTHORIZATION_VERIFICATION_STATUSES)[number];

/** Bounded, redacted proof from one package-owned authorization verifier. */
export interface OpsWorkerAuthorizationVerification {
  validatorIdentity: string;
  validatorVersion: string;
  checkedSnapshotHash: string;
  checkedAt: string;
  status: OpsWorkerAuthorizationVerificationStatus;
  evidenceHash: string;
  summary: string;
}

export const OPS_WORKER_VERIFICATION_OUTCOMES = [
  "PASS",
  "NOT_READY",
  "PRODUCT_FAILURE",
  "DEFER",
  "VERIFIER_INVALID",
  "QUERY_ERROR",
  "TIMEOUT",
] as const;

export type OpsWorkerVerificationOutcome =
  (typeof OPS_WORKER_VERIFICATION_OUTCOMES)[number];

export const OPS_WORKER_VERIFICATION_CONVERGENCE_KINDS = [
  "PRODUCT",
  "PASSIVE",
] as const;

export type OpsWorkerVerificationConvergenceKind =
  (typeof OPS_WORKER_VERIFICATION_CONVERGENCE_KINDS)[number];

/** Bounded evidence from one trusted, package-registered verifier component. */
export interface OpsWorkerVerificationComponentEvidence {
  identity: string;
  version: string;
  required: boolean;
  convergence: OpsWorkerVerificationConvergenceKind;
  outcome: OpsWorkerVerificationOutcome;
  observedAt: string;
  evidenceHash: string;
  summary: string;
  nextCheckAt: string | null;
}

/** One immutable composite contract result bound to the task snapshot. */
export interface OpsWorkerVerificationRecord {
  verifierIdentity: string;
  verifierVersion: string;
  contractHash: string;
  subjectHash: string;
  checkedAt: string;
  completedAt: string;
  outcome: OpsWorkerVerificationOutcome;
  summary: string;
  nextCheckAt: string | null;
  components: OpsWorkerVerificationComponentEvidence[];
}

export interface OpsWorkerRounds {
  remediation: number;
  maxRemediation: number;
  consecutiveInfrastructureFailures: number;
}

export interface OpsWorkerSchedule {
  nextRunAt: string | null;
  nextCheckAt: string | null;
}

/** Metadata for Pi's standard on-disk session, not a custom transcript protocol. */
export interface OpsWorkerSession {
  directory: string;
  sessionId: string | null;
  resume: boolean;
}

/**
 * Persisted operating-system identity used to prove process-group ownership.
 * processStartToken is an OS-derived identity in addition to the PID so a
 * recycled PID is never enough to authorize a signal.
 */
export interface OpsWorkerActiveRun {
  attemptId: string;
  supervisorInstanceId: string;
  pid: number;
  processGroupId: number;
  processStartedAt: string;
  processStartToken: string;
}

/**
 * Durable safety fence for a launch that has started but whose exact OS
 * process identity is not yet proven. A null PID/group is the pre-spawn
 * intent; both are filled immediately after detached spawn. The nonce is
 * stored only as a hash so restart reconciliation can bind a later inspection
 * without publishing the raw per-attempt token.
 */
export interface OpsWorkerUnverifiedRun {
  attemptId: string;
  supervisorInstanceId: string;
  pid: number | null;
  expectedProcessGroupId: number | null;
  launchedAt: string;
  ownershipNonceHash: string;
}

export const OPS_WORKER_QUOTA_PROBE_PROOF_VERSION = 1 as const;

export interface OpsWorkerQuotaProbeProof {
  version: typeof OPS_WORKER_QUOTA_PROBE_PROOF_VERSION;
  /** One-way identity of the exact model, thinking, context, and resources probed. */
  subjectHash: string;
}

export interface OpsWorkerLastOutcome {
  at: string;
  kind: OpsWorkerOutcomeKind;
  result: OpsWorkerOutcomeResult;
  summary: string;
  /** Present only for a newly written exact-configuration quota probe PASS. */
  quotaProbeProof?: OpsWorkerQuotaProbeProof;
}

export interface OpsWorkerReport {
  state: OpsWorkerReportState;
  attempts: number;
  lastError: string | null;
}

/** Bounded current claim authored by the agent; it is state, never trusted evidence. */
export interface OpsWorkerAgentResult {
  attemptId: string;
  kind: OpsWorkerAgentResultKind;
  summary: string;
  actions: string[];
  requestedInput: string | null;
  reason: OpsWorkerAgentResultReason | null;
}

/**
 * Provenance for a terminal snapshot that predates composite verification.
 * This preserves a legacy DONE state without fabricating a current-schema PASS.
 */
export interface OpsWorkerLegacyCompletion {
  sourceSchemaVersion: 1 | 2 | 3;
}

export interface OpsWorkerSteeringEntry {
  steeringId: string;
  receivedAt: string;
  kind: OpsWorkerSteeringKind;
  operatorRef: string;
  /** Bounded opaque operator data. It is never parsed as executable configuration. */
  text: string;
  consumedAt: string | null;
}

export interface OpsWorkerInterrupt {
  requestedAt: string;
  mode: OpsWorkerInterruptMode;
  /** Bounded opaque operator data. It is never parsed as executable configuration. */
  reason: string;
}

export interface OpsWorkerControl {
  paused: boolean;
  pausedAt: string | null;
  interrupt: OpsWorkerInterrupt | null;
}

export function createEmptyOpsWorkerControl(): OpsWorkerControl {
  return {
    paused: false,
    pausedAt: null,
    interrupt: null,
  };
}

export interface OpsWorkerTask {
  schemaVersion: typeof OPS_WORKER_TASK_SCHEMA_VERSION;
  id: string;
  source: OpsWorkerTaskSource;
  resource: OpsWorkerResourceIdentity;
  lifecycle: OpsWorkerLifecycleManifest;
  currentCheckpoint: OpsWorkerCheckpoint | null;
  mutationReceipts: OpsWorkerMutationReceipts;
  custody: OpsWorkerCustody;
  submissionFingerprint: string;
  priority: OpsWorkerPriority;
  objective: string;
  evidence: OpsWorkerEvidence[];
  doneCheck: OpsWorkerDoneCheck;
  authorization: OpsWorkerAuthorization;
  authorizationVerification: OpsWorkerAuthorizationVerification | null;
  verification: OpsWorkerVerificationRecord | null;
  legacyCompletion: OpsWorkerLegacyCompletion | null;
  agentResult: OpsWorkerAgentResult | null;
  steering: OpsWorkerSteeringEntry[];
  control: OpsWorkerControl;
  state: OpsWorkerTaskState;
  rounds: OpsWorkerRounds;
  schedule: OpsWorkerSchedule;
  session: OpsWorkerSession;
  activeRun: OpsWorkerActiveRun | null;
  unverifiedRun: OpsWorkerUnverifiedRun | null;
  lastOutcome: OpsWorkerLastOutcome | null;
  report: OpsWorkerReport;
  createdAt: string;
  updatedAt: string;
}

export type OpsWorkerTaskWithoutSubmissionFingerprint = Omit<
  OpsWorkerTask,
  "submissionFingerprint"
>;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    const array = expectDensePlainArray(value, "canonical submission");
    return `[${array.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

/** Exact durable task state covered by the atomic pre-spawn launch fence. */
export function hashOpsWorkerPiLaunchSubject(task: OpsWorkerTask): string {
  const canonical = stableJson(task);
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Exact persisted fields that determine one user-visible terminal report. */
export function hashOpsWorkerReportPayload(
  task: Pick<
    OpsWorkerTask,
    "state" | "lastOutcome" | "agentResult" | "verification"
  >,
): string {
  const canonical = stableJson({
    taskState: task.state,
    lastOutcome: task.lastOutcome,
    agentResult: task.agentResult,
    verification: task.verification,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/** Immutable fingerprint of the adapter-supplied semantic task envelope. */
export function hashOpsWorkerCanonicalSubmission(
  task: Pick<
    OpsWorkerTask,
    | "source"
    | "resource"
    | "priority"
    | "objective"
    | "evidence"
    | "doneCheck"
    | "authorization"
  >,
): string {
  const canonical = stableJson({
    source: task.source,
    resource: task.resource,
    priority: task.priority,
    objective: task.objective,
    evidence: task.evidence.map(({ kind, trust, summary, artifact }) => ({
      kind,
      trust,
      summary,
      artifact,
    })),
    doneCheck: task.doneCheck,
    authorization: task.authorization,
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function withOpsWorkerSubmissionFingerprint(
  task: OpsWorkerTaskWithoutSubmissionFingerprint,
): OpsWorkerTask {
  const {
    schemaVersion,
    id,
    source,
    resource,
    lifecycle,
    currentCheckpoint,
    mutationReceipts,
    custody,
    ...common
  } = task;
  return {
    schemaVersion,
    id,
    source,
    resource,
    lifecycle,
    currentCheckpoint,
    mutationReceipts,
    custody,
    submissionFingerprint: hashOpsWorkerCanonicalSubmission(task),
    ...common,
  };
}

/** Semantic task/checkpoint/authorization state covered by composite evidence. */
export function hashOpsWorkerVerificationSubject(
  task: Pick<
    OpsWorkerTask,
    | "source"
    | "resource"
    | "lifecycle"
    | "currentCheckpoint"
    | "mutationReceipts"
    | "submissionFingerprint"
    | "authorization"
    | "authorizationVerification"
    | "steering"
    | "agentResult"
  >,
): string {
  const pendingSteering = task.steering
    .filter((entry) => entry.consumedAt === null)
    .map(({ steeringId, receivedAt, kind, operatorRef, text }) => ({
      steeringId,
      receivedAt,
      kind,
      operatorRef,
      text,
    }));
  const canonical = stableJson({
    source: task.source,
    resource: task.resource,
    lifecycle: {
      canonicalTask: task.lifecycle.canonicalTask,
      repository: task.lifecycle.repository,
      base: task.lifecycle.base,
      head: task.lifecycle.head,
      branch: task.lifecycle.branch,
      pullRequest: task.lifecycle.pullRequest,
      merge: task.lifecycle.merge,
      tag: task.lifecycle.tag,
      release: task.lifecycle.release,
      deploy: task.lifecycle.deploy,
    },
    currentCheckpoint: task.currentCheckpoint,
    mutationReceipts: {
      merge: task.mutationReceipts.merge,
      tagRelease: task.mutationReceipts.tagRelease,
      deploy: task.mutationReceipts.deploy,
      canonicalTask: task.mutationReceipts.canonicalTask,
    },
    submissionFingerprint: task.submissionFingerprint,
    authorization: task.authorization,
    authorizationVerification: task.authorizationVerification === null
      ? null
      : {
        validatorIdentity: task.authorizationVerification.validatorIdentity,
        validatorVersion: task.authorizationVerification.validatorVersion,
        checkedSnapshotHash: task.authorizationVerification.checkedSnapshotHash,
        status: task.authorizationVerification.status,
        evidenceHash: task.authorizationVerification.evidenceHash,
      },
    ...(task.agentResult === null ? {} : { agentResult: task.agentResult }),
    // Keep the empty case byte-identical to the v4 verification subject so
    // exact v4 PASS snapshots remain valid during pure read migration.
    ...(pendingSteering.length === 0 ? {} : { pendingSteering }),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export type OpsWorkerTaskV1 = Omit<
  OpsWorkerTask,
  | "schemaVersion"
  | "source"
  | "resource"
  | "lifecycle"
  | "currentCheckpoint"
  | "mutationReceipts"
  | "custody"
  | "submissionFingerprint"
  | "authorizationVerification"
  | "verification"
  | "legacyCompletion"
  | "steering"
  | "control"
  | "agentResult"
> & {
  schemaVersion: typeof OPS_WORKER_TASK_LEGACY_SCHEMA_VERSION;
  source: OpsWorkerTaskSourceV1;
};

export type OpsWorkerTaskV2 = Omit<
  OpsWorkerTask,
  | "schemaVersion"
  | "lifecycle"
  | "authorizationVerification"
  | "verification"
  | "legacyCompletion"
  | "steering"
  | "control"
  | "agentResult"
> & {
  schemaVersion: typeof OPS_WORKER_TASK_V2_SCHEMA_VERSION;
  lifecycle: OpsWorkerLifecycleManifestV1;
};

export type OpsWorkerTaskV3 = Omit<
  OpsWorkerTask,
  | "schemaVersion"
  | "lifecycle"
  | "verification"
  | "legacyCompletion"
  | "steering"
  | "control"
  | "agentResult"
> & {
  schemaVersion: typeof OPS_WORKER_TASK_V3_SCHEMA_VERSION;
  lifecycle: OpsWorkerLifecycleManifestV1;
};

export type OpsWorkerTaskV4 = Omit<
  OpsWorkerTask,
  "schemaVersion" | "steering" | "control" | "agentResult"
> & {
  schemaVersion: typeof OPS_WORKER_TASK_V4_SCHEMA_VERSION;
};

export type OpsWorkerTaskV5 = Omit<
  OpsWorkerTask,
  "schemaVersion" | "agentResult"
> & {
  schemaVersion: typeof OPS_WORKER_TASK_V5_SCHEMA_VERSION;
};

export interface OpsWorkerTemplateContract {
  sourceKinds: readonly OpsWorkerSourceKind[];
}

export interface OpsWorkerAuthorizationProfileContract {
  sourceKinds: readonly OpsWorkerSourceKind[];
  scope: readonly OpsWorkerAuthorizationScope[];
}

export interface OpsWorkerDoneCheckContract {
  /** Validate all check-specific fields and return a JSON-safe canonical object. */
  validateParams(params: unknown): JsonObject;
}

/**
 * Trusted code constructs this registry. Untrusted task data may reference a
 * name, but it cannot define a template, authorization profile, or done check.
 */
export interface OpsWorkerTaskContractRegistry {
  templates: Readonly<Record<string, OpsWorkerTemplateContract>>;
  authorizationProfiles: Readonly<
    Record<string, OpsWorkerAuthorizationProfileContract>
  >;
  doneChecks: Readonly<Record<string, OpsWorkerDoneCheckContract>>;
}

export const OPS_WORKER_LIMITS = {
  maxLegacySnapshotBytes: 256 * 1024,
  maxPreV5SnapshotBytes: 512 * 1024,
  maxV5SnapshotBytes: 513 * 1024,
  maxSnapshotBytes: 545 * 1024,
  /** Space retained after steering admission for bounded lifecycle and verification growth. */
  minRuntimeMutationHeadroomBytes: 256 * 1024,
  maxObjectiveBytes: 8 * 1024,
  maxEvidenceEntries: 64,
  maxEvidenceSummaryBytes: 4 * 1024,
  maxAlertmanagerGroupCorrelationEvidenceBytes: 256 * 1024,
  maxAlertmanagerGroupLabelEntries: 64,
  maxAlertmanagerGroupLabelKeyBytes: 256,
  maxAlertmanagerGroupLabelValueBytes: 2 * 1024,
  maxOutcomeSummaryBytes: 4 * 1024,
  maxReportAttempts: 1_000,
  maxReportErrorBytes: 2 * 1024,
  maxDeliveryKeyBytes: 256,
  maxResourceKeyBytes: 256,
  maxLifecycleIdentityBytes: 512,
  maxCheckpointSummaryBytes: 4 * 1024,
  maxCheckpointReplayEntries: 128,
  maxMutationReceiptReplayEntries: 32,
  maxDoneCheckParamsBytes: 8 * 1024,
  maxDoneCheckParamDepth: 6,
  maxDoneCheckParamItems: 128,
  maxDoneCheckParamArrayLength: 64,
  maxDoneCheckParamStringBytes: 2 * 1024,
  maxAuthorizationVerificationSummaryBytes: 1024,
  maxVerificationComponents: 32,
  maxVerificationComponentSummaryBytes: 1024,
  maxVerificationSummaryBytes: 4 * 1024,
  maxSteeringEntries: 64,
  maxSteeringIdBytes: 256,
  maxSteeringOperatorRefBytes: 256,
  maxSteeringTextBytes: 8 * 1024,
  maxPendingSteeringPromptBytes: 64 * 1024,
  maxInterruptReasonBytes: 4 * 1024,
  maxAgentResultFileBytes: 32 * 1024,
  maxAgentResultSummaryBytes: 4 * 1024,
  maxAgentResultActions: 16,
  maxAgentResultActionBytes: 1024,
  maxAgentResultRequestedInputBytes: 4 * 1024,
} as const;

export interface SerializedOpsWorkerPendingSteering {
  text: string;
  steeringIds: string[];
}

/** Serialize every pending prompt-relevant steering entry using the launch wire format. */
export function serializeOpsWorkerPendingSteering(
  entries: readonly OpsWorkerSteeringEntry[],
): SerializedOpsWorkerPendingSteering {
  const steeringIds: string[] = [];
  const lines: string[] = [];
  for (const entry of entries) {
    if (
      entry.consumedAt !== null
      || (entry.kind !== "correction" && entry.kind !== "answer")
    ) continue;
    lines.push(JSON.stringify({
      steeringId: entry.steeringId,
      receivedAt: entry.receivedAt,
      kind: entry.kind,
      operatorRef: entry.operatorRef,
      text: entry.text,
    }));
    steeringIds.push(entry.steeringId);
  }
  return { text: lines.join("\n"), steeringIds };
}

const V1_TASK_KEYS = [
  "schemaVersion",
  "id",
  "source",
  "priority",
  "objective",
  "evidence",
  "doneCheck",
  "authorization",
  "state",
  "rounds",
  "schedule",
  "session",
  "activeRun",
  "unverifiedRun",
  "lastOutcome",
  "report",
  "createdAt",
  "updatedAt",
] as const;

const V2_TASK_KEYS = [
  "schemaVersion",
  "id",
  "source",
  "resource",
  "lifecycle",
  "currentCheckpoint",
  "mutationReceipts",
  "custody",
  "submissionFingerprint",
  "priority",
  "objective",
  "evidence",
  "doneCheck",
  "authorization",
  "state",
  "rounds",
  "schedule",
  "session",
  "activeRun",
  "unverifiedRun",
  "lastOutcome",
  "report",
  "createdAt",
  "updatedAt",
] as const;

const V3_TASK_KEYS = [
  ...V2_TASK_KEYS.slice(0, V2_TASK_KEYS.indexOf("state")),
  "authorizationVerification",
  ...V2_TASK_KEYS.slice(V2_TASK_KEYS.indexOf("state")),
] as const;

const V4_TASK_KEYS = [
  ...V3_TASK_KEYS.slice(0, V3_TASK_KEYS.indexOf("state")),
  "verification",
  "legacyCompletion",
  ...V3_TASK_KEYS.slice(V3_TASK_KEYS.indexOf("state")),
] as const;

const V5_TASK_KEYS = [
  ...V4_TASK_KEYS.slice(0, V4_TASK_KEYS.indexOf("state")),
  "steering",
  "control",
  ...V4_TASK_KEYS.slice(V4_TASK_KEYS.indexOf("state")),
] as const;

const TASK_KEYS = [
  ...V5_TASK_KEYS.slice(0, V5_TASK_KEYS.indexOf("steering")),
  "agentResult",
  ...V5_TASK_KEYS.slice(V5_TASK_KEYS.indexOf("steering")),
] as const;

const TASK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REGISTERED_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const CORRELATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+?-]{0,254}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const DELIVERY_KEY_PATTERN = CORRELATION_KEY_PATTERN;
const RESOURCE_KEY_PATTERN = /^[a-z0-9][a-z0-9.-]{0,31}:[a-z0-9](?:[a-z0-9._/-]{0,222}[a-z0-9])?$/;
const RESOURCE_IDENTITY_SEGMENT_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const LIFECYCLE_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+?-]{0,510}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const ARTIFACT_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const PARAM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORBIDDEN_PARAM_KEYS = new Set([
  "argv",
  "authorizationprofile",
  "cmd",
  "command",
  "commands",
  "component",
  "components",
  "executable",
  "profile",
  "selector",
  "selectors",
  "shell",
  "uri",
  "url",
  "urls",
]);

export class OpsWorkerTaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsWorkerTaskValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new OpsWorkerTaskValidationError(`${path}: ${message}`);
}

function expectDensePlainArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) return fail(path, "must be an array");
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    return fail(path, "must be a plain array");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return fail(path, "must not contain symbol keys");
  }
  if (Object.getOwnPropertyNames(value).length !== value.length + 1) {
    return fail(path, "must be dense and contain no extra properties");
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(path, "must contain only dense enumerable values");
    }
  }
  return value;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, "must be a plain object");
  }
  return value as Record<string, unknown>;
}

function expectExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const allowed = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${path}.${key}`, "unknown field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      fail(`${path}.${key}`, "accessor fields are not allowed");
    }
  }
  for (const key of expected) {
    if (!hasOwn(value, key)) {
      fail(`${path}.${key}`, "missing required field");
    }
  }
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    return fail(path, "must be a string");
  }
  return value;
}

function expectBoundedText(
  value: unknown,
  path: string,
  maxBytes: number,
  options: { allowEmpty?: boolean } = {},
): string {
  const text = expectString(value, path);
  if (!options.allowEmpty && text.length === 0) {
    fail(path, "must not be empty");
  }
  if (text.includes("\0")) {
    fail(path, "must not contain NUL bytes");
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    fail(path, `must be at most ${maxBytes} UTF-8 bytes`);
  }
  return text;
}

function expectInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(path, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    return fail(path, "must be a boolean");
  }
  return value;
}

function expectEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    return fail(path, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function expectTimestamp(value: unknown, path: string): string {
  const timestamp = expectString(value, path);
  if (!TIMESTAMP_PATTERN.test(timestamp)) {
    return fail(path, "must be an RFC 3339 UTC timestamp");
  }
  const canonical = timestamp.length === 20
    ? `${timestamp.slice(0, -1)}.000Z`
    : timestamp;
  let normalized: string;
  try {
    normalized = new Date(timestamp).toISOString();
  } catch {
    return fail(path, "must be a real calendar timestamp");
  }
  if (normalized !== canonical) {
    return fail(path, "must be a real calendar timestamp");
  }
  return timestamp;
}

function expectOptionalTimestamp(value: unknown, path: string): string | null {
  return value === null ? null : expectTimestamp(value, path);
}

function parseSteering(value: unknown): OpsWorkerSteeringEntry[] {
  const entries = expectDensePlainArray(value, "task.steering");
  if (entries.length > OPS_WORKER_LIMITS.maxSteeringEntries) {
    fail(
      "task.steering",
      `must contain at most ${OPS_WORKER_LIMITS.maxSteeringEntries} entries`,
    );
  }
  const steeringIds = new Set<string>();
  const parsed = entries.map((entryValue, index) => {
    const path = `task.steering[${index}]`;
    const entry = expectObject(entryValue, path);
    expectExactKeys(
      entry,
      ["steeringId", "receivedAt", "kind", "operatorRef", "text", "consumedAt"],
      path,
    );
    const steeringId = expectBoundedText(
      entry.steeringId,
      `${path}.steeringId`,
      OPS_WORKER_LIMITS.maxSteeringIdBytes,
    );
    if (!CORRELATION_KEY_PATTERN.test(steeringId)) {
      fail(`${path}.steeringId`, "must use only registered identity punctuation");
    }
    if (steeringIds.has(steeringId)) {
      fail(`${path}.steeringId`, "must be unique within the task");
    }
    steeringIds.add(steeringId);
    const receivedAt = expectTimestamp(entry.receivedAt, `${path}.receivedAt`);
    const consumedAt = expectOptionalTimestamp(entry.consumedAt, `${path}.consumedAt`);
    if (consumedAt !== null && Date.parse(consumedAt) < Date.parse(receivedAt)) {
      fail(`${path}.consumedAt`, "must not be earlier than receivedAt");
    }
    return {
      steeringId,
      receivedAt,
      kind: expectEnum(entry.kind, OPS_WORKER_STEERING_KINDS, `${path}.kind`),
      operatorRef: expectBoundedText(
        entry.operatorRef,
        `${path}.operatorRef`,
        OPS_WORKER_LIMITS.maxSteeringOperatorRefBytes,
      ),
      text: expectBoundedText(
        entry.text,
        `${path}.text`,
        OPS_WORKER_LIMITS.maxSteeringTextBytes,
        { allowEmpty: true },
      ),
      consumedAt,
    };
  });
  if (
    Buffer.byteLength(serializeOpsWorkerPendingSteering(parsed).text, "utf8")
    > OPS_WORKER_LIMITS.maxPendingSteeringPromptBytes
  ) {
    fail(
      "task.steering",
      `pending correction and answer entries must serialize to at most ${OPS_WORKER_LIMITS.maxPendingSteeringPromptBytes} UTF-8 bytes`,
    );
  }
  return parsed;
}

function parseInterrupt(value: unknown): OpsWorkerInterrupt | null {
  if (value === null) return null;
  const interrupt = expectObject(value, "task.control.interrupt");
  expectExactKeys(
    interrupt,
    ["requestedAt", "mode", "reason"],
    "task.control.interrupt",
  );
  return {
    requestedAt: expectTimestamp(
      interrupt.requestedAt,
      "task.control.interrupt.requestedAt",
    ),
    mode: expectEnum(
      interrupt.mode,
      OPS_WORKER_INTERRUPT_MODES,
      "task.control.interrupt.mode",
    ),
    reason: expectBoundedText(
      interrupt.reason,
      "task.control.interrupt.reason",
      OPS_WORKER_LIMITS.maxInterruptReasonBytes,
    ),
  };
}

function parseControl(value: unknown): OpsWorkerControl {
  const control = expectObject(value, "task.control");
  expectExactKeys(control, ["paused", "pausedAt", "interrupt"], "task.control");
  const paused = expectBoolean(control.paused, "task.control.paused");
  const pausedAt = expectOptionalTimestamp(control.pausedAt, "task.control.pausedAt");
  if (paused !== (pausedAt !== null)) {
    fail(
      "task.control.pausedAt",
      paused ? "must be set while paused" : "must be null while not paused",
    );
  }
  return {
    paused,
    pausedAt,
    interrupt: parseInterrupt(control.interrupt),
  };
}

export function isOpsWorkerRegisteredName(value: unknown): value is string {
  return typeof value === "string" && REGISTERED_NAME_PATTERN.test(value);
}

function expectRegisteredName(value: unknown, path: string): string {
  const name = expectString(value, path);
  if (!isOpsWorkerRegisteredName(name)) {
    return fail(path, "must be a lowercase registered name");
  }
  return name;
}

function registryValue<T>(
  registry: Readonly<Record<string, T>>,
  name: string,
): T | undefined {
  return hasOwn(registry, name) ? registry[name] : undefined;
}

function parseSource(
  value: unknown,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTaskSource {
  const source = expectObject(value, "task.source");
  expectExactKeys(
    source,
    ["kind", "correlationKey", "deliveryKey", "template"],
    "task.source",
  );
  const kind = expectEnum(source.kind, OPS_WORKER_SOURCE_KINDS, "task.source.kind");
  const correlationKey = expectString(source.correlationKey, "task.source.correlationKey");
  if (!CORRELATION_KEY_PATTERN.test(correlationKey)) {
    fail(
      "task.source.correlationKey",
      "must be 1-256 characters using only registered identity punctuation",
    );
  }
  const deliveryKey = expectBoundedText(
    source.deliveryKey,
    "task.source.deliveryKey",
    OPS_WORKER_LIMITS.maxDeliveryKeyBytes,
  );
  if (!DELIVERY_KEY_PATTERN.test(deliveryKey)) {
    fail(
      "task.source.deliveryKey",
      "must use only registered identity punctuation",
    );
  }
  const template = expectRegisteredName(source.template, "task.source.template");
  const templateContract = registryValue(registry.templates, template);
  if (!templateContract) {
    fail("task.source.template", `unregistered template ${JSON.stringify(template)}`);
  }
  if (!templateContract.sourceKinds.includes(kind)) {
    fail("task.source.template", `template is not registered for source kind ${kind}`);
  }
  return { kind, correlationKey, deliveryKey, template };
}

function parseSourceV1(
  value: unknown,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTaskSourceV1 {
  const source = expectObject(value, "task.source");
  expectExactKeys(source, ["kind", "correlationKey", "template"], "task.source");
  const kind = expectEnum(
    source.kind,
    ["alertmanager", "operator-cli", "registered-cron", "authorized-issue"] as const,
    "task.source.kind",
  );
  const correlationKey = expectString(source.correlationKey, "task.source.correlationKey");
  if (!CORRELATION_KEY_PATTERN.test(correlationKey)) {
    fail(
      "task.source.correlationKey",
      "must be 1-256 characters using only registered identity punctuation",
    );
  }
  const template = expectRegisteredName(source.template, "task.source.template");
  const templateContract = registryValue(registry.templates, template);
  if (!templateContract) {
    fail("task.source.template", `unregistered template ${JSON.stringify(template)}`);
  }
  if (!templateContract.sourceKinds.includes(kind)) {
    fail("task.source.template", `template is not registered for source kind ${kind}`);
  }
  return { kind, correlationKey, template };
}

function parseResource(value: unknown): OpsWorkerResourceIdentity {
  const resource = expectObject(value, "task.resource");
  expectExactKeys(resource, ["kind", "key"], "task.resource");
  const kind = expectEnum(resource.kind, OPS_WORKER_RESOURCE_KINDS, "task.resource.kind");
  const key = expectBoundedText(
    resource.key,
    "task.resource.key",
    OPS_WORKER_LIMITS.maxResourceKeyBytes,
  );
  if (
    !RESOURCE_KEY_PATTERN.test(key)
    || key.includes("..")
    || key.includes("//")
  ) {
    fail(
      "task.resource.key",
      "must be a normalized lowercase namespaced resource key",
    );
  }
  const separator = key.indexOf(":");
  const identity = key.slice(separator + 1);
  if (kind === "host" && (!key.startsWith("host:") || identity.includes("/"))) {
    fail("task.resource.key", "host resources must use host:<name>");
  }
  if (kind === "repository") {
    const identitySegments = identity.split("/");
    if (
      key.startsWith("host:")
      || identitySegments.length !== 2
      || identitySegments.some((segment) => !RESOURCE_IDENTITY_SEGMENT_PATTERN.test(segment))
    ) {
      fail(
        "task.resource.key",
        "repository resources must use a non-host namespace and exactly one normalized owner/name identity",
      );
    }
  }
  return { kind, key };
}

function parseLifecycleIdentity(value: unknown, path: string): string | null {
  if (value === null) return null;
  const identity = expectBoundedText(
    value,
    path,
    OPS_WORKER_LIMITS.maxLifecycleIdentityBytes,
  );
  if (!LIFECYCLE_IDENTITY_PATTERN.test(identity) || identity.includes("://")) {
    fail(path, "must be bounded identity evidence, not a URL or executable payload");
  }
  return identity;
}

export function createEmptyOpsWorkerLifecycleManifest(): OpsWorkerLifecycleManifest {
  return {
    schemaVersion: OPS_WORKER_LIFECYCLE_SCHEMA_VERSION,
    canonicalTask: null,
    repository: null,
    base: null,
    head: null,
    branch: null,
    pullRequest: null,
    merge: null,
    tag: null,
    release: null,
    deploy: null,
    verifier: null,
    verifierVersion: null,
    verifierContractHash: null,
    report: null,
    tailAudit: null,
  };
}

function parseLifecycleV1(value: unknown): OpsWorkerLifecycleManifestV1 {
  const lifecycle = expectObject(value, "task.lifecycle");
  const keys = Object.keys(createEmptyOpsWorkerLifecycleManifest()).filter(
    (key) => key !== "verifierVersion" && key !== "verifierContractHash",
  );
  expectExactKeys(lifecycle, keys, "task.lifecycle");
  if (lifecycle.schemaVersion !== OPS_WORKER_LIFECYCLE_V1_SCHEMA_VERSION) {
    fail(
      "task.lifecycle.schemaVersion",
      `must equal ${OPS_WORKER_LIFECYCLE_V1_SCHEMA_VERSION}`,
    );
  }
  return {
    schemaVersion: OPS_WORKER_LIFECYCLE_V1_SCHEMA_VERSION,
    canonicalTask: parseLifecycleIdentity(lifecycle.canonicalTask, "task.lifecycle.canonicalTask"),
    repository: parseLifecycleIdentity(lifecycle.repository, "task.lifecycle.repository"),
    base: parseLifecycleIdentity(lifecycle.base, "task.lifecycle.base"),
    head: parseLifecycleIdentity(lifecycle.head, "task.lifecycle.head"),
    branch: parseLifecycleIdentity(lifecycle.branch, "task.lifecycle.branch"),
    pullRequest: parseLifecycleIdentity(lifecycle.pullRequest, "task.lifecycle.pullRequest"),
    merge: parseLifecycleIdentity(lifecycle.merge, "task.lifecycle.merge"),
    tag: parseLifecycleIdentity(lifecycle.tag, "task.lifecycle.tag"),
    release: parseLifecycleIdentity(lifecycle.release, "task.lifecycle.release"),
    deploy: parseLifecycleIdentity(lifecycle.deploy, "task.lifecycle.deploy"),
    verifier: parseLifecycleIdentity(lifecycle.verifier, "task.lifecycle.verifier"),
    report: parseLifecycleIdentity(lifecycle.report, "task.lifecycle.report"),
    tailAudit: parseLifecycleIdentity(lifecycle.tailAudit, "task.lifecycle.tailAudit"),
  };
}

function migrateLifecycleV1(
  lifecycle: OpsWorkerLifecycleManifestV1,
): OpsWorkerLifecycleManifest {
  return {
    schemaVersion: OPS_WORKER_LIFECYCLE_SCHEMA_VERSION,
    canonicalTask: lifecycle.canonicalTask,
    repository: lifecycle.repository,
    base: lifecycle.base,
    head: lifecycle.head,
    branch: lifecycle.branch,
    pullRequest: lifecycle.pullRequest,
    merge: lifecycle.merge,
    tag: lifecycle.tag,
    release: lifecycle.release,
    deploy: lifecycle.deploy,
    verifier: null,
    verifierVersion: null,
    verifierContractHash: null,
    report: lifecycle.report,
    tailAudit: lifecycle.tailAudit,
  };
}

function parseLifecycle(value: unknown): OpsWorkerLifecycleManifest {
  const lifecycle = expectObject(value, "task.lifecycle");
  const keys = Object.keys(createEmptyOpsWorkerLifecycleManifest());
  expectExactKeys(lifecycle, keys, "task.lifecycle");
  if (lifecycle.schemaVersion !== OPS_WORKER_LIFECYCLE_SCHEMA_VERSION) {
    fail(
      "task.lifecycle.schemaVersion",
      `must equal ${OPS_WORKER_LIFECYCLE_SCHEMA_VERSION}`,
    );
  }
  const parsed = {
    schemaVersion: OPS_WORKER_LIFECYCLE_SCHEMA_VERSION,
    canonicalTask: parseLifecycleIdentity(
      lifecycle.canonicalTask,
      "task.lifecycle.canonicalTask",
    ),
    repository: parseLifecycleIdentity(lifecycle.repository, "task.lifecycle.repository"),
    base: parseLifecycleIdentity(lifecycle.base, "task.lifecycle.base"),
    head: parseLifecycleIdentity(lifecycle.head, "task.lifecycle.head"),
    branch: parseLifecycleIdentity(lifecycle.branch, "task.lifecycle.branch"),
    pullRequest: parseLifecycleIdentity(
      lifecycle.pullRequest,
      "task.lifecycle.pullRequest",
    ),
    merge: parseLifecycleIdentity(lifecycle.merge, "task.lifecycle.merge"),
    tag: parseLifecycleIdentity(lifecycle.tag, "task.lifecycle.tag"),
    release: parseLifecycleIdentity(lifecycle.release, "task.lifecycle.release"),
    deploy: parseLifecycleIdentity(lifecycle.deploy, "task.lifecycle.deploy"),
    verifier: parseLifecycleIdentity(lifecycle.verifier, "task.lifecycle.verifier"),
    verifierVersion: parseLifecycleIdentity(
      lifecycle.verifierVersion,
      "task.lifecycle.verifierVersion",
    ),
    verifierContractHash: parseLifecycleIdentity(
      lifecycle.verifierContractHash,
      "task.lifecycle.verifierContractHash",
    ),
    report: parseLifecycleIdentity(lifecycle.report, "task.lifecycle.report"),
    tailAudit: parseLifecycleIdentity(lifecycle.tailAudit, "task.lifecycle.tailAudit"),
  };
  const verifierFields = [
    parsed.verifier,
    parsed.verifierVersion,
    parsed.verifierContractHash,
  ];
  if (verifierFields.some((entry) => entry === null)
      && verifierFields.some((entry) => entry !== null)) {
    fail(
      "task.lifecycle.verifier",
      "verifier identity, version, and contract hash must be all null or all present",
    );
  }
  if (
    parsed.verifierContractHash !== null
    && !SHA256_PATTERN.test(parsed.verifierContractHash)
  ) {
    fail(
      "task.lifecycle.verifierContractHash",
      "must be a lowercase sha256:<hex> digest",
    );
  }
  return parsed;
}

function parseCheckpoint(value: unknown): OpsWorkerCheckpoint | null {
  if (value === null) return null;
  const checkpoint = expectObject(value, "task.currentCheckpoint");
  expectExactKeys(
    checkpoint,
    [
      "checkpointId",
      "recordedAt",
      "payloadHash",
      "summary",
      "artifact",
      "replayHistory",
    ],
    "task.currentCheckpoint",
  );
  const checkpointId = expectString(
    checkpoint.checkpointId,
    "task.currentCheckpoint.checkpointId",
  );
  if (!INSTANCE_ID_PATTERN.test(checkpointId)) {
    fail("task.currentCheckpoint.checkpointId", "contains unsafe characters");
  }
  const payloadHash = expectString(
    checkpoint.payloadHash,
    "task.currentCheckpoint.payloadHash",
  );
  if (!SHA256_PATTERN.test(payloadHash)) {
    fail("task.currentCheckpoint.payloadHash", "must be a lowercase sha256:<hex> digest");
  }
  const checkpointReplayHistory = expectDensePlainArray(
    checkpoint.replayHistory,
    "task.currentCheckpoint.replayHistory",
  );
  if (
    checkpointReplayHistory.length
    > OPS_WORKER_LIMITS.maxCheckpointReplayEntries
  ) {
    fail(
      "task.currentCheckpoint.replayHistory",
      `must contain at most ${OPS_WORKER_LIMITS.maxCheckpointReplayEntries} entries`,
    );
  }
  const replayIds = new Set<string>([checkpointId]);
  const replayHistory = checkpointReplayHistory.map((entry, index) => {
    const path = `task.currentCheckpoint.replayHistory[${index}]`;
    const replay = expectObject(entry, path);
    expectExactKeys(replay, ["checkpointId", "contentHash"], path);
    const replayId = expectString(replay.checkpointId, `${path}.checkpointId`);
    if (!INSTANCE_ID_PATTERN.test(replayId)) {
      fail(`${path}.checkpointId`, "contains unsafe characters");
    }
    if (replayIds.has(replayId)) {
      fail(`${path}.checkpointId`, "must be unique and differ from the current checkpoint");
    }
    replayIds.add(replayId);
    const contentHash = expectString(replay.contentHash, `${path}.contentHash`);
    if (!SHA256_PATTERN.test(contentHash)) {
      fail(`${path}.contentHash`, "must be a lowercase sha256:<hex> digest");
    }
    return { checkpointId: replayId, contentHash };
  });
  return {
    checkpointId,
    recordedAt: expectTimestamp(
      checkpoint.recordedAt,
      "task.currentCheckpoint.recordedAt",
    ),
    payloadHash,
    summary: expectBoundedText(
      checkpoint.summary,
      "task.currentCheckpoint.summary",
      OPS_WORKER_LIMITS.maxCheckpointSummaryBytes,
    ),
    artifact: checkpoint.artifact === null
      ? null
      : parseArtifactPath(checkpoint.artifact, "task.currentCheckpoint.artifact"),
    replayHistory,
  };
}

const RECEIPT_SLOTS = {
  merge: "merge",
  tagRelease: "tag-release",
  deploy: "deploy",
  canonicalTask: "canonical-task",
  report: "report",
} as const satisfies Record<string, OpsWorkerMutationBoundary>;

export function createEmptyOpsWorkerMutationReceipts(): OpsWorkerMutationReceipts {
  return {
    merge: null,
    tagRelease: null,
    deploy: null,
    canonicalTask: null,
    report: null,
  };
}

function parseMutationReceipt(
  value: unknown,
  slot: keyof typeof RECEIPT_SLOTS,
): OpsWorkerMutationReceipt | null {
  if (value === null) return null;
  const path = `task.mutationReceipts.${slot}`;
  const receipt = expectObject(value, path);
  expectExactKeys(
    receipt,
    [
      "boundary",
      "operationId",
      "intentHash",
      "queryObservedAt",
      "queryResultHash",
      "mutationStartedAt",
      "outcome",
      "replayHistory",
    ],
    path,
  );
  const boundary = expectEnum(receipt.boundary, OPS_WORKER_MUTATION_BOUNDARIES, `${path}.boundary`);
  if (boundary !== RECEIPT_SLOTS[slot]) {
    fail(`${path}.boundary`, `must equal fixed slot boundary ${RECEIPT_SLOTS[slot]}`);
  }
  const operationId = expectString(receipt.operationId, `${path}.operationId`);
  if (!INSTANCE_ID_PATTERN.test(operationId)) {
    fail(`${path}.operationId`, "contains unsafe characters");
  }
  const intentHash = expectString(receipt.intentHash, `${path}.intentHash`);
  const queryResultHash = expectString(receipt.queryResultHash, `${path}.queryResultHash`);
  for (const [hashPath, hash] of [
    [`${path}.intentHash`, intentHash],
    [`${path}.queryResultHash`, queryResultHash],
  ] as const) {
    if (!SHA256_PATTERN.test(hash)) {
      fail(hashPath, "must be a lowercase sha256:<hex> digest");
    }
  }
  const queryObservedAt = expectTimestamp(receipt.queryObservedAt, `${path}.queryObservedAt`);
  const mutationStartedAt = expectOptionalTimestamp(
    receipt.mutationStartedAt,
    `${path}.mutationStartedAt`,
  );
  if (
    mutationStartedAt !== null
    && Date.parse(mutationStartedAt) < Date.parse(queryObservedAt)
  ) {
    fail(`${path}.mutationStartedAt`, "must not be earlier than its query observation");
  }
  let outcome: OpsWorkerMutationOutcome | null = null;
  if (receipt.outcome !== null) {
    const outcomeValue = expectObject(receipt.outcome, `${path}.outcome`);
    expectExactKeys(
      outcomeValue,
      ["recordedAt", "result", "evidenceHash"],
      `${path}.outcome`,
    );
    const recordedAt = expectTimestamp(outcomeValue.recordedAt, `${path}.outcome.recordedAt`);
    const evidenceHash = expectString(outcomeValue.evidenceHash, `${path}.outcome.evidenceHash`);
    if (!SHA256_PATTERN.test(evidenceHash)) {
      fail(`${path}.outcome.evidenceHash`, "must be a lowercase sha256:<hex> digest");
    }
    const result = expectEnum(
      outcomeValue.result,
      OPS_WORKER_MUTATION_OUTCOMES,
      `${path}.outcome.result`,
    );
    if (result === "APPLIED" && mutationStartedAt === null) {
      fail(`${path}.outcome.result`, "APPLIED requires a durable mutation claim");
    }
    const outcomeFloor = mutationStartedAt ?? queryObservedAt;
    if (Date.parse(recordedAt) < Date.parse(outcomeFloor)) {
      fail(
        `${path}.outcome.recordedAt`,
        mutationStartedAt === null
          ? "must not be earlier than its query observation"
          : "must not be earlier than its mutation claim",
      );
    }
    outcome = {
      recordedAt,
      result,
      evidenceHash,
    };
  }
  const receiptReplayHistory = expectDensePlainArray(
    receipt.replayHistory,
    `${path}.replayHistory`,
  );
  if (
    receiptReplayHistory.length
    > OPS_WORKER_LIMITS.maxMutationReceiptReplayEntries
  ) {
    fail(
      `${path}.replayHistory`,
      `must contain at most ${OPS_WORKER_LIMITS.maxMutationReceiptReplayEntries} entries`,
    );
  }
  const replayIds = new Set<string>([operationId]);
  const replayHistory = receiptReplayHistory.map((entry, index) => {
    const replayPath = `${path}.replayHistory[${index}]`;
    const replay = expectObject(entry, replayPath);
    expectExactKeys(
      replay,
      ["operationId", "intentHash", "result", "evidenceHash"],
      replayPath,
    );
    const replayOperationId = expectString(
      replay.operationId,
      `${replayPath}.operationId`,
    );
    if (!INSTANCE_ID_PATTERN.test(replayOperationId)) {
      fail(`${replayPath}.operationId`, "contains unsafe characters");
    }
    if (replayIds.has(replayOperationId)) {
      fail(
        `${replayPath}.operationId`,
        "must be unique and differ from the current operation",
      );
    }
    replayIds.add(replayOperationId);
    const replayIntentHash = expectString(
      replay.intentHash,
      `${replayPath}.intentHash`,
    );
    const replayEvidenceHash = expectString(
      replay.evidenceHash,
      `${replayPath}.evidenceHash`,
    );
    for (const [hashPath, hash] of [
      [`${replayPath}.intentHash`, replayIntentHash],
      [`${replayPath}.evidenceHash`, replayEvidenceHash],
    ] as const) {
      if (!SHA256_PATTERN.test(hash)) {
        fail(hashPath, "must be a lowercase sha256:<hex> digest");
      }
    }
    return {
      operationId: replayOperationId,
      intentHash: replayIntentHash,
      result: expectEnum(
        replay.result,
        OPS_WORKER_MUTATION_OUTCOMES,
        `${replayPath}.result`,
      ),
      evidenceHash: replayEvidenceHash,
    };
  });
  return {
    boundary,
    operationId,
    intentHash,
    queryObservedAt,
    queryResultHash,
    mutationStartedAt,
    outcome,
    replayHistory,
  };
}

function parseMutationReceipts(value: unknown): OpsWorkerMutationReceipts {
  const receipts = expectObject(value, "task.mutationReceipts");
  expectExactKeys(receipts, Object.keys(RECEIPT_SLOTS), "task.mutationReceipts");
  return {
    merge: parseMutationReceipt(receipts.merge, "merge"),
    tagRelease: parseMutationReceipt(receipts.tagRelease, "tagRelease"),
    deploy: parseMutationReceipt(receipts.deploy, "deploy"),
    canonicalTask: parseMutationReceipt(receipts.canonicalTask, "canonicalTask"),
    report: parseMutationReceipt(receipts.report, "report"),
  };
}

export function createUnclaimedOpsWorkerCustody(): OpsWorkerCustody {
  return {
    status: "UNCLAIMED",
    claimedAt: null,
    releasedAt: null,
    releaseReason: null,
  };
}

function parseCustody(value: unknown): OpsWorkerCustody {
  const custody = expectObject(value, "task.custody");
  expectExactKeys(
    custody,
    ["status", "claimedAt", "releasedAt", "releaseReason"],
    "task.custody",
  );
  const status = expectEnum(custody.status, OPS_WORKER_CUSTODY_STATUSES, "task.custody.status");
  const claimedAt = expectOptionalTimestamp(custody.claimedAt, "task.custody.claimedAt");
  const releasedAt = expectOptionalTimestamp(custody.releasedAt, "task.custody.releasedAt");
  const releaseReason = custody.releaseReason === null
    ? null
    : expectEnum(
      custody.releaseReason,
      OPS_WORKER_CUSTODY_RELEASE_REASONS,
      "task.custody.releaseReason",
    );
  if (
    (status === "UNCLAIMED"
      && (claimedAt !== null || releasedAt !== null || releaseReason !== null))
    || (status === "HELD"
      && (claimedAt === null || releasedAt !== null || releaseReason !== null))
    || (status === "RELEASED"
      && (releasedAt === null || releaseReason === null))
  ) {
    fail("task.custody", "status does not match its custody timestamps and release reason");
  }
  if (
    claimedAt !== null
    && releasedAt !== null
    && Date.parse(releasedAt) < Date.parse(claimedAt)
  ) {
    fail("task.custody.releasedAt", "must not be earlier than claimedAt");
  }
  return { status, claimedAt, releasedAt, releaseReason };
}

function parseEvidenceSummary(
  value: unknown,
  path: string,
  source: OpsWorkerTaskSource | OpsWorkerTaskSourceV1,
  kind: OpsWorkerEvidence["kind"],
  trust: OpsWorkerEvidence["trust"],
): string {
  const summary = expectBoundedText(
    value,
    path,
    OPS_WORKER_LIMITS.maxAlertmanagerGroupCorrelationEvidenceBytes,
  );
  if (
    Buffer.byteLength(summary, "utf8")
    <= OPS_WORKER_LIMITS.maxEvidenceSummaryBytes
  ) return summary;
  if (
    source.kind !== "alertmanager"
    || kind !== "alert"
    || trust !== "untrusted"
  ) {
    fail(path, `must be at most ${OPS_WORKER_LIMITS.maxEvidenceSummaryBytes} UTF-8 bytes`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(summary) as unknown;
  } catch {
    return fail(path, "oversized Alertmanager correlation evidence must be valid JSON");
  }
  const descriptor = expectObject(decoded, path);
  expectExactKeys(descriptor, ["type", "correlationKey", "groupLabels"], path);
  if (
    descriptor.type !== "alertmanager-group-correlation-v1"
    || descriptor.correlationKey !== source.correlationKey
  ) {
    fail(path, "oversized evidence must be the task's exact Alertmanager group descriptor");
  }
  const groupLabels = expectObject(descriptor.groupLabels, `${path}.groupLabels`);
  const entries = Object.entries(groupLabels);
  if (entries.length > OPS_WORKER_LIMITS.maxAlertmanagerGroupLabelEntries) {
    fail(`${path}.groupLabels`, "contains too many entries");
  }
  for (const [key, label] of entries) {
    expectBoundedText(
      key,
      `${path}.groupLabels key`,
      OPS_WORKER_LIMITS.maxAlertmanagerGroupLabelKeyBytes,
    );
    expectBoundedText(
      label,
      `${path}.groupLabels.${key}`,
      OPS_WORKER_LIMITS.maxAlertmanagerGroupLabelValueBytes,
      { allowEmpty: true },
    );
  }
  return summary;
}

function parseEvidence(
  value: unknown,
  source: OpsWorkerTaskSource | OpsWorkerTaskSourceV1,
): OpsWorkerEvidence[] {
  const evidenceEntries = expectDensePlainArray(value, "task.evidence");
  if (evidenceEntries.length > OPS_WORKER_LIMITS.maxEvidenceEntries) {
    fail(
      "task.evidence",
      `must contain at most ${OPS_WORKER_LIMITS.maxEvidenceEntries} entries`,
    );
  }
  const parsed = evidenceEntries.map((item, index) => {
    const path = `task.evidence[${index}]`;
    const evidence = expectObject(item, path);
    expectExactKeys(evidence, ["at", "kind", "trust", "summary", "artifact"], path);
    const artifact = evidence.artifact === null
      ? null
      : parseArtifactPath(evidence.artifact, `${path}.artifact`);
    const kind = expectEnum(evidence.kind, OPS_WORKER_EVIDENCE_KINDS, `${path}.kind`);
    const trust = expectEnum(evidence.trust, OPS_WORKER_EVIDENCE_TRUST, `${path}.trust`);
    return {
      at: expectTimestamp(evidence.at, `${path}.at`),
      kind,
      trust,
      summary: parseEvidenceSummary(
        evidence.summary,
        `${path}.summary`,
        source,
        kind,
        trust,
      ),
      artifact,
    };
  });
  if (
    parsed.filter((evidence) =>
      Buffer.byteLength(evidence.summary, "utf8")
      > OPS_WORKER_LIMITS.maxEvidenceSummaryBytes).length > 1
  ) {
    fail("task.evidence", "must contain at most one oversized Alertmanager group descriptor");
  }
  return parsed;
}

function parseArtifactPath(value: unknown, path: string): string {
  const artifact = expectString(value, path);
  if (artifact.length > 240 || artifact.includes("\\") || artifact.startsWith("/")) {
    return fail(path, "must be a bounded relative artifact path");
  }
  const segments = artifact.split("/");
  if (
    segments[0] !== "artifacts"
    || segments.length < 2
    || segments.some((segment) => !ARTIFACT_SEGMENT_PATTERN.test(segment))
  ) {
    return fail(path, "must stay below artifacts/ and contain no traversal segments");
  }
  return artifact;
}

interface JsonBudget {
  items: number;
}

function parseSafeJson(
  value: unknown,
  path: string,
  depth: number,
  budget: JsonBudget,
): JsonValue {
  budget.items += 1;
  if (budget.items > OPS_WORKER_LIMITS.maxDoneCheckParamItems) {
    return fail(path, "contains too many values");
  }
  if (depth > OPS_WORKER_LIMITS.maxDoneCheckParamDepth) {
    return fail(path, "is nested too deeply");
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (
      typeof value === "string"
      && Buffer.byteLength(value, "utf8")
        > OPS_WORKER_LIMITS.maxDoneCheckParamStringBytes
    ) {
      return fail(path, "string value is too large");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail(path, "number must be finite");
    }
    return value;
  }
  if (Array.isArray(value)) {
    const array = expectDensePlainArray(value, path);
    if (array.length > OPS_WORKER_LIMITS.maxDoneCheckParamArrayLength) {
      return fail(path, "array is too large");
    }
    return array.map((item, index) =>
      parseSafeJson(item, `${path}[${index}]`, depth + 1, budget));
  }
  const object = expectObject(value, path);
  const result: JsonObject = {};
  for (const key of Object.keys(object)) {
    if (!PARAM_KEY_PATTERN.test(key)) {
      fail(`${path}.${key}`, "unsafe parameter field name");
    }
    if (FORBIDDEN_PARAM_KEYS.has(key.toLowerCase())) {
      fail(
        `${path}.${key}`,
        "task data cannot select components, commands, executables, URLs, or authorization",
      );
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) {
      fail(`${path}.${key}`, "accessor fields are not allowed");
    }
    result[key] = parseSafeJson(descriptor.value, `${path}.${key}`, depth + 1, budget);
  }
  return result;
}

function parseDoneCheck(
  value: unknown,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerDoneCheck {
  const doneCheck = expectObject(value, "task.doneCheck");
  expectExactKeys(doneCheck, ["name", "params"], "task.doneCheck");
  const name = expectRegisteredName(doneCheck.name, "task.doneCheck.name");
  const contract = registryValue(registry.doneChecks, name);
  if (!contract) {
    fail("task.doneCheck.name", `unregistered done check ${JSON.stringify(name)}`);
  }
  const supplied = parseSafeJson(doneCheck.params, "task.doneCheck.params", 0, { items: 0 });
  if (Array.isArray(supplied) || supplied === null || typeof supplied !== "object") {
    fail("task.doneCheck.params", "must be an object");
  }
  if (Buffer.byteLength(JSON.stringify(supplied), "utf8") > OPS_WORKER_LIMITS.maxDoneCheckParamsBytes) {
    fail(
      "task.doneCheck.params",
      `must be at most ${OPS_WORKER_LIMITS.maxDoneCheckParamsBytes} UTF-8 bytes`,
    );
  }
  let validated: JsonObject;
  try {
    validated = contract.validateParams(supplied);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("task.doneCheck.params", `failed registered validation: ${message}`);
  }
  const params = parseSafeJson(validated, "task.doneCheck.params", 0, { items: 0 });
  if (Array.isArray(params) || params === null || typeof params !== "object") {
    fail("task.doneCheck.params", "registered validator must return an object");
  }
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > OPS_WORKER_LIMITS.maxDoneCheckParamsBytes) {
    fail(
      "task.doneCheck.params",
      `must be at most ${OPS_WORKER_LIMITS.maxDoneCheckParamsBytes} UTF-8 bytes`,
    );
  }
  return { name, params: params as JsonObject };
}

function parseAuthorization(
  value: unknown,
  sourceKind: OpsWorkerSourceKind,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerAuthorization {
  const authorization = expectObject(value, "task.authorization");
  expectExactKeys(authorization, ["profile", "scope", "snapshotHash"], "task.authorization");
  const profile = expectRegisteredName(authorization.profile, "task.authorization.profile");
  const contract = registryValue(registry.authorizationProfiles, profile);
  if (!contract) {
    fail("task.authorization.profile", `unregistered authorization profile ${JSON.stringify(profile)}`);
  }
  if (!contract.sourceKinds.includes(sourceKind)) {
    fail("task.authorization.profile", `profile is not registered for source kind ${sourceKind}`);
  }
  const contractScope = expectDensePlainArray(
    contract.scope,
    "registry.authorization.scope",
  ).map((scope, index) =>
    expectEnum(scope, OPS_WORKER_AUTHORIZATION_SCOPES, `registry.authorization.scope[${index}]`));
  const suppliedScope = expectDensePlainArray(
    authorization.scope,
    "task.authorization.scope",
  ).map((scope, index) =>
    expectEnum(scope, OPS_WORKER_AUTHORIZATION_SCOPES, `task.authorization.scope[${index}]`));
  if (
    suppliedScope.length !== contractScope.length
    || suppliedScope.some((scope, index) => scope !== contractScope[index])
  ) {
    fail("task.authorization.scope", "must exactly match the registered authorization profile");
  }
  let snapshotHash: string | null = null;
  if (authorization.snapshotHash !== null) {
    snapshotHash = expectString(authorization.snapshotHash, "task.authorization.snapshotHash");
    if (!SHA256_PATTERN.test(snapshotHash)) {
      fail("task.authorization.snapshotHash", "must be a lowercase sha256:<hex> digest");
    }
  }
  return { profile, scope: [...suppliedScope], snapshotHash };
}

function parseAuthorizationVerification(
  value: unknown,
): OpsWorkerAuthorizationVerification | null {
  if (value === null) return null;
  const verification = expectObject(value, "task.authorizationVerification");
  expectExactKeys(
    verification,
    [
      "validatorIdentity",
      "validatorVersion",
      "checkedSnapshotHash",
      "checkedAt",
      "status",
      "evidenceHash",
      "summary",
    ],
    "task.authorizationVerification",
  );
  const validatorIdentity = expectRegisteredName(
    verification.validatorIdentity,
    "task.authorizationVerification.validatorIdentity",
  );
  const validatorVersion = expectRegisteredName(
    verification.validatorVersion,
    "task.authorizationVerification.validatorVersion",
  );
  const checkedSnapshotHash = expectString(
    verification.checkedSnapshotHash,
    "task.authorizationVerification.checkedSnapshotHash",
  );
  const evidenceHash = expectString(
    verification.evidenceHash,
    "task.authorizationVerification.evidenceHash",
  );
  for (const [path, hash] of [
    ["task.authorizationVerification.checkedSnapshotHash", checkedSnapshotHash],
    ["task.authorizationVerification.evidenceHash", evidenceHash],
  ] as const) {
    if (!SHA256_PATTERN.test(hash)) {
      fail(path, "must be a lowercase sha256:<hex> digest");
    }
  }
  return {
    validatorIdentity,
    validatorVersion,
    checkedSnapshotHash,
    checkedAt: expectTimestamp(
      verification.checkedAt,
      "task.authorizationVerification.checkedAt",
    ),
    status: expectEnum(
      verification.status,
      OPS_WORKER_AUTHORIZATION_VERIFICATION_STATUSES,
      "task.authorizationVerification.status",
    ),
    evidenceHash,
    summary: expectBoundedText(
      verification.summary,
      "task.authorizationVerification.summary",
      OPS_WORKER_LIMITS.maxAuthorizationVerificationSummaryBytes,
    ),
  };
}

export function aggregateOpsWorkerVerificationOutcome(
  components: readonly Pick<
    OpsWorkerVerificationComponentEvidence,
    "required" | "outcome"
  >[],
): OpsWorkerVerificationOutcome {
  const required = components.filter((component) => component.required);
  if (required.length === 0) return "VERIFIER_INVALID";
  // One trusted product failure conclusively disproves completion even when an
  // unrelated required component cannot produce evidence in the same query.
  const precedence: readonly OpsWorkerVerificationOutcome[] = [
    "PRODUCT_FAILURE",
    "VERIFIER_INVALID",
    "TIMEOUT",
    "QUERY_ERROR",
    "NOT_READY",
    "DEFER",
  ];
  for (const outcome of precedence) {
    if (required.some((component) => component.outcome === outcome)) return outcome;
  }
  return required.every((component) => component.outcome === "PASS")
    ? "PASS"
    : "VERIFIER_INVALID";
}

function assertVerificationNextCheckAt(
  outcome: OpsWorkerVerificationOutcome,
  nextCheckAt: string | null,
  anchor: string,
  path: string,
  anchorLabel: string,
): void {
  if (outcome === "DEFER") {
    if (nextCheckAt === null || Date.parse(nextCheckAt) <= Date.parse(anchor)) {
      fail(path, "DEFER requires a later query timestamp");
    }
    return;
  }
  if (outcome === "NOT_READY") {
    if (nextCheckAt !== null && Date.parse(nextCheckAt) <= Date.parse(anchor)) {
      fail(path, `NOT_READY recheck must be later than ${anchorLabel}`);
    }
    return;
  }
  if (nextCheckAt !== null) {
    fail(path, "must be null unless the outcome schedules convergence");
  }
}

function parseVerificationComponent(
  value: unknown,
  index: number,
  checkedAt: string,
  completedAt: string,
): OpsWorkerVerificationComponentEvidence {
  const path = `task.verification.components[${index}]`;
  const component = expectObject(value, path);
  expectExactKeys(
    component,
    [
      "identity",
      "version",
      "required",
      "convergence",
      "outcome",
      "observedAt",
      "evidenceHash",
      "summary",
      "nextCheckAt",
    ],
    path,
  );
  const outcome = expectEnum(
    component.outcome,
    OPS_WORKER_VERIFICATION_OUTCOMES,
    `${path}.outcome`,
  );
  const convergence = expectEnum(
    component.convergence,
    OPS_WORKER_VERIFICATION_CONVERGENCE_KINDS,
    `${path}.convergence`,
  );
  if (outcome === "DEFER" && convergence !== "PASSIVE") {
    fail(`${path}.outcome`, "DEFER is allowed only for passive convergence");
  }
  const observedAt = expectTimestamp(component.observedAt, `${path}.observedAt`);
  if (
    Date.parse(observedAt) < Date.parse(checkedAt)
    || Date.parse(observedAt) > Date.parse(completedAt)
  ) {
    fail(`${path}.observedAt`, "must be fresh within the composite query interval");
  }
  const evidenceHash = expectString(component.evidenceHash, `${path}.evidenceHash`);
  if (!SHA256_PATTERN.test(evidenceHash)) {
    fail(`${path}.evidenceHash`, "must be a lowercase sha256:<hex> digest");
  }
  const nextCheckAt = expectOptionalTimestamp(
    component.nextCheckAt,
    `${path}.nextCheckAt`,
  );
  assertVerificationNextCheckAt(
    outcome,
    nextCheckAt,
    observedAt,
    `${path}.nextCheckAt`,
    "observedAt",
  );
  return {
    identity: expectRegisteredName(component.identity, `${path}.identity`),
    version: expectRegisteredName(component.version, `${path}.version`),
    required: expectBoolean(component.required, `${path}.required`),
    convergence,
    outcome,
    observedAt,
    evidenceHash,
    summary: expectBoundedText(
      component.summary,
      `${path}.summary`,
      OPS_WORKER_LIMITS.maxVerificationComponentSummaryBytes,
    ),
    nextCheckAt,
  };
}

function parseVerification(value: unknown): OpsWorkerVerificationRecord | null {
  if (value === null) return null;
  const verification = expectObject(value, "task.verification");
  expectExactKeys(
    verification,
    [
      "verifierIdentity",
      "verifierVersion",
      "contractHash",
      "subjectHash",
      "checkedAt",
      "completedAt",
      "outcome",
      "summary",
      "nextCheckAt",
      "components",
    ],
    "task.verification",
  );
  const checkedAt = expectTimestamp(verification.checkedAt, "task.verification.checkedAt");
  const completedAt = expectTimestamp(
    verification.completedAt,
    "task.verification.completedAt",
  );
  if (Date.parse(completedAt) < Date.parse(checkedAt)) {
    fail("task.verification.completedAt", "must not be earlier than checkedAt");
  }
  const contractHash = expectString(
    verification.contractHash,
    "task.verification.contractHash",
  );
  if (!SHA256_PATTERN.test(contractHash)) {
    fail("task.verification.contractHash", "must be a lowercase sha256:<hex> digest");
  }
  const subjectHash = expectString(
    verification.subjectHash,
    "task.verification.subjectHash",
  );
  if (!SHA256_PATTERN.test(subjectHash)) {
    fail("task.verification.subjectHash", "must be a lowercase sha256:<hex> digest");
  }
  const outcome = expectEnum(
    verification.outcome,
    OPS_WORKER_VERIFICATION_OUTCOMES,
    "task.verification.outcome",
  );
  const componentValues = expectDensePlainArray(
    verification.components,
    "task.verification.components",
  );
  if (componentValues.length > OPS_WORKER_LIMITS.maxVerificationComponents) {
    fail(
      "task.verification.components",
      `must contain at most ${OPS_WORKER_LIMITS.maxVerificationComponents} components`,
    );
  }
  const components = componentValues.map((component, index) =>
    parseVerificationComponent(component, index, checkedAt, completedAt));
  const identities = components.map((component) => component.identity);
  if (new Set(identities).size !== identities.length) {
    fail("task.verification.components", "must not contain duplicate component identities");
  }
  if (components.length === 0) {
    if (outcome !== "VERIFIER_INVALID") {
      fail("task.verification.outcome", "empty component evidence is verifier-invalid");
    }
  } else if (aggregateOpsWorkerVerificationOutcome(components) !== outcome) {
    fail("task.verification.outcome", "does not match the required component outcomes");
  }
  const nextCheckAt = expectOptionalTimestamp(
    verification.nextCheckAt,
    "task.verification.nextCheckAt",
  );
  assertVerificationNextCheckAt(
    outcome,
    nextCheckAt,
    completedAt,
    "task.verification.nextCheckAt",
    "completion",
  );
  return {
    verifierIdentity: expectRegisteredName(
      verification.verifierIdentity,
      "task.verification.verifierIdentity",
    ),
    verifierVersion: expectRegisteredName(
      verification.verifierVersion,
      "task.verification.verifierVersion",
    ),
    contractHash,
    subjectHash,
    checkedAt,
    completedAt,
    outcome,
    summary: expectBoundedText(
      verification.summary,
      "task.verification.summary",
      OPS_WORKER_LIMITS.maxVerificationSummaryBytes,
    ),
    nextCheckAt,
    components,
  };
}

function parseRounds(value: unknown): OpsWorkerRounds {
  const rounds = expectObject(value, "task.rounds");
  expectExactKeys(
    rounds,
    ["remediation", "maxRemediation", "consecutiveInfrastructureFailures"],
    "task.rounds",
  );
  const remediation = expectInteger(rounds.remediation, "task.rounds.remediation", 0, 100);
  const maxRemediation = expectInteger(rounds.maxRemediation, "task.rounds.maxRemediation", 1, 100);
  if (remediation > maxRemediation) {
    fail("task.rounds.remediation", "must not exceed maxRemediation");
  }
  return {
    remediation,
    maxRemediation,
    consecutiveInfrastructureFailures: expectInteger(
      rounds.consecutiveInfrastructureFailures,
      "task.rounds.consecutiveInfrastructureFailures",
      0,
      1_000,
    ),
  };
}

function parseSchedule(value: unknown): OpsWorkerSchedule {
  const schedule = expectObject(value, "task.schedule");
  expectExactKeys(schedule, ["nextRunAt", "nextCheckAt"], "task.schedule");
  return {
    nextRunAt: expectOptionalTimestamp(schedule.nextRunAt, "task.schedule.nextRunAt"),
    nextCheckAt: expectOptionalTimestamp(schedule.nextCheckAt, "task.schedule.nextCheckAt"),
  };
}

function parseSession(value: unknown, taskId: string): OpsWorkerSession {
  const session = expectObject(value, "task.session");
  expectExactKeys(session, ["directory", "sessionId", "resume"], "task.session");
  const directory = expectString(session.directory, "task.session.directory");
  if (directory !== `sessions/${taskId}`) {
    fail("task.session.directory", `must be the task-owned path sessions/${taskId}`);
  }
  let sessionId: string | null = null;
  if (session.sessionId !== null) {
    sessionId = expectString(session.sessionId, "task.session.sessionId");
    if (!INSTANCE_ID_PATTERN.test(sessionId)) {
      fail("task.session.sessionId", "contains unsafe characters");
    }
  }
  return {
    directory,
    sessionId,
    resume: expectBoolean(session.resume, "task.session.resume"),
  };
}

function parseActiveRun(value: unknown): OpsWorkerActiveRun | null {
  if (value === null) return null;
  const activeRun = expectObject(value, "task.activeRun");
  expectExactKeys(
    activeRun,
    [
      "attemptId",
      "supervisorInstanceId",
      "pid",
      "processGroupId",
      "processStartedAt",
      "processStartToken",
    ],
    "task.activeRun",
  );
  const attemptId = expectString(activeRun.attemptId, "task.activeRun.attemptId");
  const supervisorInstanceId = expectString(
    activeRun.supervisorInstanceId,
    "task.activeRun.supervisorInstanceId",
  );
  const processStartToken = expectString(
    activeRun.processStartToken,
    "task.activeRun.processStartToken",
  );
  for (const [path, identifier] of [
    ["task.activeRun.attemptId", attemptId],
    ["task.activeRun.supervisorInstanceId", supervisorInstanceId],
    ["task.activeRun.processStartToken", processStartToken],
  ] as const) {
    if (!INSTANCE_ID_PATTERN.test(identifier)) {
      fail(path, "contains unsafe characters");
    }
  }
  return {
    attemptId,
    supervisorInstanceId,
    pid: expectInteger(activeRun.pid, "task.activeRun.pid", 1, 2_147_483_647),
    processGroupId: expectInteger(
      activeRun.processGroupId,
      "task.activeRun.processGroupId",
      1,
      2_147_483_647,
    ),
    processStartedAt: expectTimestamp(activeRun.processStartedAt, "task.activeRun.processStartedAt"),
    processStartToken,
  };
}

function parseUnverifiedRun(value: unknown): OpsWorkerUnverifiedRun | null {
  if (value === null) return null;
  const unverifiedRun = expectObject(value, "task.unverifiedRun");
  expectExactKeys(
    unverifiedRun,
    [
      "attemptId",
      "supervisorInstanceId",
      "pid",
      "expectedProcessGroupId",
      "launchedAt",
      "ownershipNonceHash",
    ],
    "task.unverifiedRun",
  );
  const attemptId = expectString(
    unverifiedRun.attemptId,
    "task.unverifiedRun.attemptId",
  );
  const supervisorInstanceId = expectString(
    unverifiedRun.supervisorInstanceId,
    "task.unverifiedRun.supervisorInstanceId",
  );
  for (const [path, identifier] of [
    ["task.unverifiedRun.attemptId", attemptId],
    ["task.unverifiedRun.supervisorInstanceId", supervisorInstanceId],
  ] as const) {
    if (!INSTANCE_ID_PATTERN.test(identifier)) {
      fail(path, "contains unsafe characters");
    }
  }
  const ownershipNonceHash = expectString(
    unverifiedRun.ownershipNonceHash,
    "task.unverifiedRun.ownershipNonceHash",
  );
  if (!SHA256_PATTERN.test(ownershipNonceHash)) {
    fail(
      "task.unverifiedRun.ownershipNonceHash",
      "must be a lowercase sha256:<hex> digest",
    );
  }
  const pid = unverifiedRun.pid === null
    ? null
    : expectInteger(
      unverifiedRun.pid,
      "task.unverifiedRun.pid",
      1,
      2_147_483_647,
    );
  const expectedProcessGroupId = unverifiedRun.expectedProcessGroupId === null
    ? null
    : expectInteger(
      unverifiedRun.expectedProcessGroupId,
      "task.unverifiedRun.expectedProcessGroupId",
      1,
      2_147_483_647,
    );
  if (
    (pid === null) !== (expectedProcessGroupId === null)
    || (pid !== null && expectedProcessGroupId !== pid)
  ) {
    fail(
      "task.unverifiedRun.expectedProcessGroupId",
      "must be null with pid or equal the detached launch leader PID",
    );
  }
  return {
    attemptId,
    supervisorInstanceId,
    pid,
    expectedProcessGroupId,
    launchedAt: expectTimestamp(
      unverifiedRun.launchedAt,
      "task.unverifiedRun.launchedAt",
    ),
    ownershipNonceHash,
  };
}

function parseQuotaProbeProof(value: unknown): OpsWorkerQuotaProbeProof {
  const proof = expectObject(value, "task.lastOutcome.quotaProbeProof");
  expectExactKeys(
    proof,
    ["version", "subjectHash"],
    "task.lastOutcome.quotaProbeProof",
  );
  if (proof.version !== OPS_WORKER_QUOTA_PROBE_PROOF_VERSION) {
    fail(
      "task.lastOutcome.quotaProbeProof.version",
      `must equal ${OPS_WORKER_QUOTA_PROBE_PROOF_VERSION}`,
    );
  }
  const subjectHash = expectString(
    proof.subjectHash,
    "task.lastOutcome.quotaProbeProof.subjectHash",
  );
  if (!SHA256_PATTERN.test(subjectHash)) {
    fail(
      "task.lastOutcome.quotaProbeProof.subjectHash",
      "must be a lowercase sha256:<hex> digest",
    );
  }
  return {
    version: OPS_WORKER_QUOTA_PROBE_PROOF_VERSION,
    subjectHash,
  };
}

function parseLastOutcome(value: unknown): OpsWorkerLastOutcome | null {
  if (value === null) return null;
  const outcome = expectObject(value, "task.lastOutcome");
  const hasQuotaProbeProof = Object.prototype.hasOwnProperty.call(
    outcome,
    "quotaProbeProof",
  );
  expectExactKeys(
    outcome,
    hasQuotaProbeProof
      ? ["at", "kind", "result", "summary", "quotaProbeProof"]
      : ["at", "kind", "result", "summary"],
    "task.lastOutcome",
  );
  const result = expectEnum(
    outcome.result,
    OPS_WORKER_OUTCOME_RESULTS,
    "task.lastOutcome.result",
  );
  if (hasQuotaProbeProof && result !== "QUOTA_PROBE_PASS") {
    fail(
      "task.lastOutcome.quotaProbeProof",
      "is allowed only for an exact quota probe PASS",
    );
  }
  const quotaProbeProof = hasQuotaProbeProof
    ? parseQuotaProbeProof(outcome.quotaProbeProof)
    : undefined;
  return {
    at: expectTimestamp(outcome.at, "task.lastOutcome.at"),
    kind: expectEnum(outcome.kind, OPS_WORKER_OUTCOME_KINDS, "task.lastOutcome.kind"),
    result,
    summary: expectBoundedText(
      outcome.summary,
      "task.lastOutcome.summary",
      OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
    ),
    ...(quotaProbeProof === undefined ? {} : { quotaProbeProof }),
  };
}

function parseReport(value: unknown): OpsWorkerReport {
  const report = expectObject(value, "task.report");
  expectExactKeys(report, ["state", "attempts", "lastError"], "task.report");
  const lastError = report.lastError === null
    ? null
    : expectBoundedText(
      report.lastError,
      "task.report.lastError",
      OPS_WORKER_LIMITS.maxReportErrorBytes,
    );
  return {
    state: expectEnum(report.state, OPS_WORKER_REPORT_STATES, "task.report.state"),
    attempts: expectInteger(
      report.attempts,
      "task.report.attempts",
      0,
      OPS_WORKER_LIMITS.maxReportAttempts,
    ),
    lastError,
  };
}

function parseAgentResultAt(
  value: unknown,
  path: string,
  expectedAttemptId?: string,
): OpsWorkerAgentResult {
  const result = expectObject(value, path);
  expectExactKeys(
    result,
    ["attemptId", "kind", "summary", "actions", "requestedInput", "reason"],
    path,
  );
  const attemptId = expectBoundedText(
    result.attemptId,
    `${path}.attemptId`,
    128,
  );
  if (!INSTANCE_ID_PATTERN.test(attemptId)) {
    fail(`${path}.attemptId`, "contains unsafe characters");
  }
  if (expectedAttemptId !== undefined && attemptId !== expectedAttemptId) {
    fail(`${path}.attemptId`, "must match the persisted attempt identity");
  }
  const actionsRaw = expectDensePlainArray(result.actions, `${path}.actions`);
  if (actionsRaw.length > OPS_WORKER_LIMITS.maxAgentResultActions) {
    fail(
      `${path}.actions`,
      `must contain at most ${OPS_WORKER_LIMITS.maxAgentResultActions} entries`,
    );
  }
  const parsed: OpsWorkerAgentResult = {
    attemptId,
    kind: expectEnum(
      result.kind,
      OPS_WORKER_AGENT_RESULT_KINDS,
      `${path}.kind`,
    ),
    summary: expectBoundedText(
      result.summary,
      `${path}.summary`,
      OPS_WORKER_LIMITS.maxAgentResultSummaryBytes,
    ),
    actions: actionsRaw.map((action, index) => expectBoundedText(
      action,
      `${path}.actions[${index}]`,
      OPS_WORKER_LIMITS.maxAgentResultActionBytes,
    )),
    requestedInput: result.requestedInput === null
      ? null
      : expectBoundedText(
          result.requestedInput,
          `${path}.requestedInput`,
          OPS_WORKER_LIMITS.maxAgentResultRequestedInputBytes,
        ),
    reason: result.reason === null
      ? null
      : expectEnum(
          result.reason,
          OPS_WORKER_AGENT_RESULT_REASONS,
          `${path}.reason`,
        ),
  };
  if (parsed.kind === "input-needed") {
    if (parsed.requestedInput === null) {
      fail(`${path}.requestedInput`, "must be present for input-needed");
    }
    if (parsed.reason !== "approval" && parsed.reason !== "information") {
      fail(`${path}.reason`, "must be approval or information for input-needed");
    }
  } else if (parsed.kind === "impossible") {
    if (parsed.requestedInput !== null) {
      fail(`${path}.requestedInput`, "must be null for impossible");
    }
    if (parsed.reason !== "policy-boundary" && parsed.reason !== "unrecoverable") {
      fail(`${path}.reason`, "must be policy-boundary or unrecoverable for impossible");
    }
  } else {
    if (parsed.requestedInput !== null) {
      fail(`${path}.requestedInput`, `must be null for ${parsed.kind}`);
    }
    if (parsed.reason !== null) {
      fail(`${path}.reason`, `must be null for ${parsed.kind}`);
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(parsed), "utf8")
    > OPS_WORKER_LIMITS.maxAgentResultFileBytes
  ) {
    fail(
      path,
      `must serialize to at most ${OPS_WORKER_LIMITS.maxAgentResultFileBytes} UTF-8 bytes`,
    );
  }
  return parsed;
}

/** Parse an exact bounded agent-authored result and optionally bind its attempt id. */
export function parseOpsWorkerAgentResult(
  value: unknown,
  expectedAttemptId?: string,
): OpsWorkerAgentResult {
  return parseAgentResultAt(value, "agentResult", expectedAttemptId);
}

/** Stable identity for the exact bounded agent result used by receipts and tests. */
export function hashOpsWorkerAgentResult(result: OpsWorkerAgentResult): string {
  const parsed = parseOpsWorkerAgentResult(result, result.attemptId);
  return `sha256:${createHash("sha256").update(stableJson(parsed)).digest("hex")}`;
}

function parseTaskAgentResult(value: unknown): OpsWorkerAgentResult | null {
  return value === null ? null : parseAgentResultAt(value, "task.agentResult");
}

function parseLegacyCompletion(value: unknown): OpsWorkerLegacyCompletion | null {
  if (value === null) return null;
  const legacy = expectObject(value, "task.legacyCompletion");
  expectExactKeys(legacy, ["sourceSchemaVersion"], "task.legacyCompletion");
  if (legacy.sourceSchemaVersion !== 1
      && legacy.sourceSchemaVersion !== 2
      && legacy.sourceSchemaVersion !== 3) {
    fail(
      "task.legacyCompletion.sourceSchemaVersion",
      "must identify supported legacy schema 1, 2, or 3",
    );
  }
  return { sourceSchemaVersion: legacy.sourceSchemaVersion };
}

export function assertOpsWorkerTaskId(id: unknown): asserts id is string {
  if (!isOpsWorkerTaskId(id)) {
    fail("task.id", "must be a traversal-safe lowercase task identifier");
  }
}

export function isOpsWorkerTaskId(id: unknown): id is string {
  return typeof id === "string" && TASK_ID_PATTERN.test(id);
}

export function isOpsWorkerTerminalState(
  state: OpsWorkerTaskState,
): state is OpsWorkerTerminalState {
  return (OPS_WORKER_TERMINAL_STATES as readonly string[]).includes(state);
}

type OpsWorkerTaskCommon = Omit<
  OpsWorkerTask,
  | "schemaVersion"
  | "id"
  | "source"
  | "resource"
  | "lifecycle"
  | "currentCheckpoint"
  | "mutationReceipts"
  | "custody"
  | "submissionFingerprint"
  | "authorizationVerification"
  | "verification"
  | "legacyCompletion"
  | "steering"
  | "control"
  | "agentResult"
>;

function parseTaskCommon(
  task: Record<string, unknown>,
  id: string,
  source: OpsWorkerTaskSource | OpsWorkerTaskSourceV1,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTaskCommon {
  const priority = expectInteger(task.priority, "task.priority", 0, 30);
  if (priority !== OPS_WORKER_SOURCE_PRIORITIES[source.kind]) {
    fail(
      "task.priority",
      `must equal fixed priority ${OPS_WORKER_SOURCE_PRIORITIES[source.kind]} for ${source.kind}`,
    );
  }
  const createdAt = expectTimestamp(task.createdAt, "task.createdAt");
  const updatedAt = expectTimestamp(task.updatedAt, "task.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail("task.updatedAt", "must not be earlier than createdAt");
  }
  const state = expectEnum(task.state, OPS_WORKER_TASK_STATES, "task.state");
  const activeRun = parseActiveRun(task.activeRun);
  const unverifiedRun = parseUnverifiedRun(task.unverifiedRun);
  if (state === "RUNNING" && activeRun === null) {
    fail("task.activeRun", "must identify the owned process group while state is RUNNING");
  }
  const lastOutcome = parseLastOutcome(task.lastOutcome);
  const preservesAmbiguousRun = state === "BLOCKED"
    && lastOutcome?.result === "AMBIGUOUS_ORPHAN";
  if (activeRun !== null && unverifiedRun !== null) {
    fail(
      "task.unverifiedRun",
      "cannot coexist with a verified active process-group identity",
    );
  }
  if (state !== "RUNNING" && activeRun !== null && !preservesAmbiguousRun) {
    fail(
      "task.activeRun",
      "must be null unless state is RUNNING or retains an ambiguous blocked process group",
    );
  }
  if (unverifiedRun !== null && !preservesAmbiguousRun) {
    fail(
      "task.unverifiedRun",
      "must be null unless retaining an ambiguous blocked launch fence",
    );
  }
  if (
    state === "DONE"
    && (
      lastOutcome?.kind !== "DONE_CHECK"
      || lastOutcome.result !== "PASS"
      || lastOutcome.at !== updatedAt
    )
  ) {
    fail(
      "task.lastOutcome",
      "DONE requires a fresh DONE_CHECK PASS recorded with the snapshot transition",
    );
  }
  return {
    priority: priority as OpsWorkerPriority,
    objective: expectBoundedText(
      task.objective,
      "task.objective",
      OPS_WORKER_LIMITS.maxObjectiveBytes,
    ),
    evidence: parseEvidence(task.evidence, source),
    doneCheck: parseDoneCheck(task.doneCheck, registry),
    authorization: parseAuthorization(task.authorization, source.kind, registry),
    state,
    rounds: parseRounds(task.rounds),
    schedule: parseSchedule(task.schedule),
    session: parseSession(task.session, id),
    activeRun,
    unverifiedRun,
    lastOutcome,
    report: parseReport(task.report),
    createdAt,
    updatedAt,
  };
}

export function isOpsWorkerUnclaimedQuotaProbeProcess(
  task: Pick<OpsWorkerTask, "state" | "custody" | "activeRun" | "unverifiedRun" | "lastOutcome">,
): boolean {
  if (task.custody.status !== "UNCLAIMED") return false;
  const attemptId = task.activeRun?.attemptId ?? task.unverifiedRun?.attemptId;
  if (!attemptId?.startsWith("quota-probe-")) return false;
  return task.state === "RUNNING"
    || (
      task.state === "BLOCKED"
      && task.lastOutcome?.result === "AMBIGUOUS_ORPHAN"
    );
}

function assertTaskCustodyMatchesState(task: OpsWorkerTask): void {
  const held = task.custody.status === "HELD";
  if (
    task.state === "RUNNING"
    || task.state === "CHECKING"
    || task.state === "RESUMABLE"
  ) {
    if (isOpsWorkerUnclaimedQuotaProbeProcess(task)) return;
    if (!held) {
      fail("task.custody.status", `${task.state} tasks must retain held custody`);
    }
    return;
  }
  if (task.state === "QUEUED") {
    if (task.custody.status === "RELEASED") {
      fail("task.custody.status", "QUEUED tasks may be unclaimed or atomically held, not released");
    }
    return;
  }
  if (task.state === "BLOCKED") {
    const ambiguous = task.lastOutcome?.result === "AMBIGUOUS_ORPHAN";
    if (ambiguous) {
      if (isOpsWorkerUnclaimedQuotaProbeProcess(task)) return;
      if (!held) {
        fail("task.custody.status", "an ambiguous blocked task must retain held custody");
      }
      return;
    }
    if (
      task.custody.status !== "RELEASED"
      || task.custody.releaseReason !== "BLOCKED"
    ) {
      fail(
        "task.custody",
        "a process-free BLOCKED task must be released with reason BLOCKED",
      );
    }
    return;
  }
  const expectedReason = task.state === "DONE" ? "DONE" : "CANCELLED";
  if (
    task.custody.status !== "RELEASED"
    || task.custody.releaseReason !== expectedReason
  ) {
    fail(
      "task.custody",
      `${task.state} tasks must be released with reason ${expectedReason}`,
    );
  }
}

function assertParsedSnapshotSize(task: OpsWorkerTask): void {
  const serializedBytes = Buffer.byteLength(JSON.stringify(task), "utf8");
  if (serializedBytes > OPS_WORKER_LIMITS.maxSnapshotBytes) {
    fail(
      "task",
      `serialized snapshot exceeds ${OPS_WORKER_LIMITS.maxSnapshotBytes} UTF-8 bytes`,
    );
  }
}

function legacyCustody(task: OpsWorkerTaskV1): OpsWorkerCustody {
  const ambiguousOrphan = task.lastOutcome?.result === "AMBIGUOUS_ORPHAN";
  if (
    task.state === "RUNNING"
    || task.state === "CHECKING"
    || task.state === "RESUMABLE"
    || (task.state === "BLOCKED" && ambiguousOrphan)
  ) {
    return {
      status: "HELD",
      claimedAt: task.createdAt,
      releasedAt: null,
      releaseReason: null,
    };
  }
  if (task.state === "QUEUED") return createUnclaimedOpsWorkerCustody();
  const releaseReason = task.state === "DONE"
    ? "DONE"
    : task.state === "CANCELLED"
      ? "CANCELLED"
      : "BLOCKED";
  return {
    status: "RELEASED",
    claimedAt: null,
    releasedAt: task.updatedAt,
    releaseReason,
  };
}

/**
 * Pure migration for an already validated exact v1 snapshot. Migration never
 * writes the source snapshot and never retains mutable references to it.
 */
export function migrateOpsWorkerTaskV1(task: OpsWorkerTaskV1): OpsWorkerTask {
  const copy = structuredClone(task);
  const migrated = withOpsWorkerSubmissionFingerprint({
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    id: copy.id,
    source: {
      kind: copy.source.kind,
      correlationKey: copy.source.correlationKey,
      deliveryKey: `legacy:${copy.id}`,
      template: copy.source.template,
    },
    resource: {
      kind: "host",
      key: `host:legacy-${copy.id}`,
    },
    lifecycle: createEmptyOpsWorkerLifecycleManifest(),
    currentCheckpoint: null,
    mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
    custody: legacyCustody(copy),
    priority: copy.priority,
    objective: copy.objective,
    evidence: copy.evidence,
    doneCheck: copy.doneCheck,
    authorization: copy.authorization,
    authorizationVerification: null,
    verification: null,
    legacyCompletion: copy.state === "DONE" ? { sourceSchemaVersion: 1 } : null,
    agentResult: null,
    steering: [],
    control: createEmptyOpsWorkerControl(),
    state: copy.state,
    rounds: copy.rounds,
    schedule: copy.schedule,
    session: copy.session,
    activeRun: copy.activeRun,
    unverifiedRun: copy.unverifiedRun,
    lastOutcome: copy.lastOutcome,
    report: copy.report,
    createdAt: copy.createdAt,
    updatedAt: copy.updatedAt,
  });
  return migrated;
}

/** Pure migration for an already validated exact v2 snapshot. */
export function migrateOpsWorkerTaskV2(task: OpsWorkerTaskV2): OpsWorkerTask {
  const copy = structuredClone(task);
  const {
    schemaVersion: _schemaVersion,
    id,
    source,
    resource,
    lifecycle,
    currentCheckpoint,
    mutationReceipts,
    custody,
    submissionFingerprint,
    ...common
  } = copy;
  return {
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    id,
    source,
    resource,
    lifecycle: migrateLifecycleV1(lifecycle),
    currentCheckpoint,
    mutationReceipts,
    custody,
    submissionFingerprint,
    authorizationVerification: null,
    verification: null,
    legacyCompletion: common.state === "DONE" ? { sourceSchemaVersion: 2 } : null,
    agentResult: null,
    steering: [],
    control: createEmptyOpsWorkerControl(),
    ...common,
  };
}

/** Pure migration for an already validated exact v3 snapshot. */
export function migrateOpsWorkerTaskV3(task: OpsWorkerTaskV3): OpsWorkerTask {
  const copy = structuredClone(task);
  const {
    schemaVersion: _schemaVersion,
    lifecycle,
    ...common
  } = copy;
  return {
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    lifecycle: migrateLifecycleV1(lifecycle),
    verification: null,
    legacyCompletion: common.state === "DONE" ? { sourceSchemaVersion: 3 } : null,
    agentResult: null,
    steering: [],
    control: createEmptyOpsWorkerControl(),
    ...common,
  };
}

/** Pure migration for an already validated exact v4 snapshot. */
export function migrateOpsWorkerTaskV4(task: OpsWorkerTaskV4): OpsWorkerTask {
  const copy = structuredClone(task);
  const { schemaVersion: _schemaVersion, ...common } = copy;
  return {
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    agentResult: null,
    steering: [],
    control: createEmptyOpsWorkerControl(),
    ...common,
  };
}

/** Pure migration for an already validated exact v5 snapshot. */
export function migrateOpsWorkerTaskV5(task: OpsWorkerTaskV5): OpsWorkerTask {
  const copy = structuredClone(task);
  const { schemaVersion: _schemaVersion, ...common } = copy;
  return {
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    agentResult: null,
    ...common,
  };
}

function parseOpsWorkerTaskV1(
  task: Record<string, unknown>,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTask {
  expectExactKeys(task, V1_TASK_KEYS, "task");
  if (task.schemaVersion !== OPS_WORKER_TASK_LEGACY_SCHEMA_VERSION) {
    fail(
      "task.schemaVersion",
      `must equal ${OPS_WORKER_TASK_LEGACY_SCHEMA_VERSION}`,
    );
  }
  assertOpsWorkerTaskId(task.id);
  const id = task.id;
  const source = parseSourceV1(task.source, registry);
  const legacy: OpsWorkerTaskV1 = {
    schemaVersion: OPS_WORKER_TASK_LEGACY_SCHEMA_VERSION,
    id,
    source,
    ...parseTaskCommon(task, id, source, registry),
  };
  const migrated = migrateOpsWorkerTaskV1(legacy);
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacy), "utf8");
  if (legacyBytes > OPS_WORKER_LIMITS.maxLegacySnapshotBytes) {
    fail(
      "task",
      `serialized legacy snapshot exceeds ${OPS_WORKER_LIMITS.maxLegacySnapshotBytes} UTF-8 bytes`,
    );
  }
  assertTaskCustodyMatchesState(migrated);
  assertParsedSnapshotSize(migrated);
  return migrated;
}

function parseOpsWorkerTaskV2(
  task: Record<string, unknown>,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTask {
  expectExactKeys(task, V2_TASK_KEYS, "task");
  if (task.schemaVersion !== OPS_WORKER_TASK_V2_SCHEMA_VERSION) {
    fail(
      "task.schemaVersion",
      `must equal ${OPS_WORKER_TASK_V2_SCHEMA_VERSION}`,
    );
  }
  assertOpsWorkerTaskId(task.id);
  const id = task.id;
  const source = parseSource(task.source, registry);
  const submissionFingerprint = expectString(
    task.submissionFingerprint,
    "task.submissionFingerprint",
  );
  if (!SHA256_PATTERN.test(submissionFingerprint)) {
    fail(
      "task.submissionFingerprint",
      "must be a lowercase sha256:<hex> digest",
    );
  }
  const previous: OpsWorkerTaskV2 = {
    schemaVersion: OPS_WORKER_TASK_V2_SCHEMA_VERSION,
    id,
    source,
    resource: parseResource(task.resource),
    lifecycle: parseLifecycleV1(task.lifecycle),
    currentCheckpoint: parseCheckpoint(task.currentCheckpoint),
    mutationReceipts: parseMutationReceipts(task.mutationReceipts),
    custody: parseCustody(task.custody),
    submissionFingerprint,
    ...parseTaskCommon(task, id, source, registry),
  };
  const parsed = migrateOpsWorkerTaskV2(previous);
  assertTaskCustodyMatchesState(parsed);
  assertParsedSnapshotSize(parsed);
  return parsed;
}

function parseOpsWorkerTaskV3(
  task: Record<string, unknown>,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTask {
  expectExactKeys(task, V3_TASK_KEYS, "task");
  if (task.schemaVersion !== OPS_WORKER_TASK_V3_SCHEMA_VERSION) {
    fail(
      "task.schemaVersion",
      `must equal ${OPS_WORKER_TASK_V3_SCHEMA_VERSION}`,
    );
  }
  assertOpsWorkerTaskId(task.id);
  const id = task.id;
  const source = parseSource(task.source, registry);
  const submissionFingerprint = expectString(
    task.submissionFingerprint,
    "task.submissionFingerprint",
  );
  if (!SHA256_PATTERN.test(submissionFingerprint)) {
    fail(
      "task.submissionFingerprint",
      "must be a lowercase sha256:<hex> digest",
    );
  }
  const previous: OpsWorkerTaskV3 = {
    schemaVersion: OPS_WORKER_TASK_V3_SCHEMA_VERSION,
    id,
    source,
    resource: parseResource(task.resource),
    lifecycle: parseLifecycleV1(task.lifecycle),
    currentCheckpoint: parseCheckpoint(task.currentCheckpoint),
    mutationReceipts: parseMutationReceipts(task.mutationReceipts),
    custody: parseCustody(task.custody),
    submissionFingerprint,
    authorizationVerification: parseAuthorizationVerification(
      task.authorizationVerification,
    ),
    ...parseTaskCommon(task, id, source, registry),
  };
  const parsed = migrateOpsWorkerTaskV3(previous);
  assertTaskCustodyMatchesState(parsed);
  assertParsedSnapshotSize(parsed);
  return parsed;
}

function parseOpsWorkerTaskV4(
  task: Record<string, unknown>,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTask {
  expectExactKeys(task, V4_TASK_KEYS, "task");
  if (task.schemaVersion !== OPS_WORKER_TASK_V4_SCHEMA_VERSION) {
    fail(
      "task.schemaVersion",
      `must equal ${OPS_WORKER_TASK_V4_SCHEMA_VERSION}`,
    );
  }
  assertOpsWorkerTaskId(task.id);
  const id = task.id;
  const source = parseSource(task.source, registry);
  const submissionFingerprint = expectString(
    task.submissionFingerprint,
    "task.submissionFingerprint",
  );
  if (!SHA256_PATTERN.test(submissionFingerprint)) {
    fail(
      "task.submissionFingerprint",
      "must be a lowercase sha256:<hex> digest",
    );
  }
  const previous: OpsWorkerTaskV4 = {
    schemaVersion: OPS_WORKER_TASK_V4_SCHEMA_VERSION,
    id,
    source,
    resource: parseResource(task.resource),
    lifecycle: parseLifecycle(task.lifecycle),
    currentCheckpoint: parseCheckpoint(task.currentCheckpoint),
    mutationReceipts: parseMutationReceipts(task.mutationReceipts),
    custody: parseCustody(task.custody),
    submissionFingerprint,
    authorizationVerification: parseAuthorizationVerification(
      task.authorizationVerification,
    ),
    verification: parseVerification(task.verification),
    legacyCompletion: parseLegacyCompletion(task.legacyCompletion),
    ...parseTaskCommon(task, id, source, registry),
  };
  const parsed = migrateOpsWorkerTaskV4(previous);
  assertTaskVerification(parsed);
  assertTaskCustodyMatchesState(parsed);
  assertParsedSnapshotSize(parsed);
  return parsed;
}

function assertTaskVerification(parsed: OpsWorkerTask): void {
  const verifier = parsed.verification;
  if (verifier !== null && (
    parsed.lifecycle.verifier !== verifier.verifierIdentity
    || parsed.lifecycle.verifierVersion !== verifier.verifierVersion
    || parsed.lifecycle.verifierContractHash !== verifier.contractHash
  )) {
    fail("task.verification", "must match the immutable lifecycle verifier contract");
  }
  if (
    verifier !== null
    && verifier.subjectHash !== hashOpsWorkerVerificationSubject(parsed)
  ) {
    fail("task.verification.subjectHash", "is stale for current task/checkpoint/authorization state");
  }
  if (
    parsed.legacyCompletion !== null
    && (
      parsed.state !== "DONE"
      || verifier !== null
      || parsed.lifecycle.verifier !== null
      || parsed.lifecycle.verifierVersion !== null
      || parsed.lifecycle.verifierContractHash !== null
    )
  ) {
    fail(
      "task.legacyCompletion",
      "may preserve only an unverified legacy DONE snapshot",
    );
  }
  if (
    parsed.state === "DONE"
    && (
      parsed.legacyCompletion === null
      && (
        verifier?.outcome !== "PASS"
        || verifier.completedAt !== parsed.updatedAt
      )
    )
  ) {
    fail(
      "task.verification",
      "DONE requires fresh aggregate PASS evidence from the terminal transition",
    );
  }
}

function parseOpsWorkerTaskV5(
  task: Record<string, unknown>,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTask {
  expectExactKeys(task, V5_TASK_KEYS, "task");
  if (task.schemaVersion !== OPS_WORKER_TASK_V5_SCHEMA_VERSION) {
    fail(
      "task.schemaVersion",
      `must equal ${OPS_WORKER_TASK_V5_SCHEMA_VERSION}`,
    );
  }
  assertOpsWorkerTaskId(task.id);
  const id = task.id;
  const source = parseSource(task.source, registry);
  const submissionFingerprint = expectString(
    task.submissionFingerprint,
    "task.submissionFingerprint",
  );
  if (!SHA256_PATTERN.test(submissionFingerprint)) {
    fail(
      "task.submissionFingerprint",
      "must be a lowercase sha256:<hex> digest",
    );
  }
  const previous: OpsWorkerTaskV5 = {
    schemaVersion: OPS_WORKER_TASK_V5_SCHEMA_VERSION,
    id,
    source,
    resource: parseResource(task.resource),
    lifecycle: parseLifecycle(task.lifecycle),
    currentCheckpoint: parseCheckpoint(task.currentCheckpoint),
    mutationReceipts: parseMutationReceipts(task.mutationReceipts),
    custody: parseCustody(task.custody),
    submissionFingerprint,
    authorizationVerification: parseAuthorizationVerification(
      task.authorizationVerification,
    ),
    verification: parseVerification(task.verification),
    legacyCompletion: parseLegacyCompletion(task.legacyCompletion),
    steering: parseSteering(task.steering),
    control: parseControl(task.control),
    ...parseTaskCommon(task, id, source, registry),
  };
  const parsed = migrateOpsWorkerTaskV5(previous);
  assertTaskVerification(parsed);
  assertTaskCustodyMatchesState(parsed);
  assertParsedSnapshotSize(parsed);
  return parsed;
}

function parseOpsWorkerTaskV6(
  task: Record<string, unknown>,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTask {
  expectExactKeys(task, TASK_KEYS, "task");
  if (task.schemaVersion !== OPS_WORKER_TASK_SCHEMA_VERSION) {
    fail(
      "task.schemaVersion",
      `must equal ${OPS_WORKER_TASK_SCHEMA_VERSION}`,
    );
  }
  assertOpsWorkerTaskId(task.id);
  const id = task.id;
  const source = parseSource(task.source, registry);
  const submissionFingerprint = expectString(
    task.submissionFingerprint,
    "task.submissionFingerprint",
  );
  if (!SHA256_PATTERN.test(submissionFingerprint)) {
    fail(
      "task.submissionFingerprint",
      "must be a lowercase sha256:<hex> digest",
    );
  }
  const parsed: OpsWorkerTask = {
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    id,
    source,
    resource: parseResource(task.resource),
    lifecycle: parseLifecycle(task.lifecycle),
    currentCheckpoint: parseCheckpoint(task.currentCheckpoint),
    mutationReceipts: parseMutationReceipts(task.mutationReceipts),
    custody: parseCustody(task.custody),
    submissionFingerprint,
    authorizationVerification: parseAuthorizationVerification(
      task.authorizationVerification,
    ),
    verification: parseVerification(task.verification),
    legacyCompletion: parseLegacyCompletion(task.legacyCompletion),
    agentResult: parseTaskAgentResult(task.agentResult),
    steering: parseSteering(task.steering),
    control: parseControl(task.control),
    ...parseTaskCommon(task, id, source, registry),
  };
  assertTaskVerification(parsed);
  assertTaskCustodyMatchesState(parsed);
  assertParsedSnapshotSize(parsed);
  return parsed;
}

/** Parse and copy exact v1-v6 input. Unknown versions fail closed. */
export function parseOpsWorkerTask(
  value: unknown,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTask {
  const task = expectObject(value, "task");
  const descriptor = Object.getOwnPropertyDescriptor(task, "schemaVersion");
  if (!descriptor || !("value" in descriptor)) {
    fail("task.schemaVersion", descriptor ? "accessor fields are not allowed" : "missing required field");
  }
  if (descriptor.value === OPS_WORKER_TASK_LEGACY_SCHEMA_VERSION) {
    return parseOpsWorkerTaskV1(task, registry);
  }
  if (descriptor.value === OPS_WORKER_TASK_V2_SCHEMA_VERSION) {
    return parseOpsWorkerTaskV2(task, registry);
  }
  if (descriptor.value === OPS_WORKER_TASK_V3_SCHEMA_VERSION) {
    return parseOpsWorkerTaskV3(task, registry);
  }
  if (descriptor.value === OPS_WORKER_TASK_V4_SCHEMA_VERSION) {
    return parseOpsWorkerTaskV4(task, registry);
  }
  if (descriptor.value === OPS_WORKER_TASK_V5_SCHEMA_VERSION) {
    return parseOpsWorkerTaskV5(task, registry);
  }
  if (descriptor.value === OPS_WORKER_TASK_SCHEMA_VERSION) {
    return parseOpsWorkerTaskV6(task, registry);
  }
  fail(
    "task.schemaVersion",
    `must equal supported version ${OPS_WORKER_TASK_LEGACY_SCHEMA_VERSION}, ${OPS_WORKER_TASK_V2_SCHEMA_VERSION}, ${OPS_WORKER_TASK_V3_SCHEMA_VERSION}, ${OPS_WORKER_TASK_V4_SCHEMA_VERSION}, ${OPS_WORKER_TASK_V5_SCHEMA_VERSION}, or ${OPS_WORKER_TASK_SCHEMA_VERSION}`,
  );
}

export function parseOpsWorkerTaskJson(
  raw: string | Buffer,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTask {
  const bytes = Buffer.isBuffer(raw) ? raw.byteLength : Buffer.byteLength(raw, "utf8");
  if (bytes > OPS_WORKER_LIMITS.maxSnapshotBytes) {
    fail(
      "task",
      `snapshot exceeds ${OPS_WORKER_LIMITS.maxSnapshotBytes} UTF-8 bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail("task", `malformed JSON: ${message}`);
  }
  const schemaVersion = typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    ? Object.getOwnPropertyDescriptor(value, "schemaVersion")?.value
    : undefined;
  if (
    schemaVersion === OPS_WORKER_TASK_LEGACY_SCHEMA_VERSION
    && bytes > OPS_WORKER_LIMITS.maxLegacySnapshotBytes
  ) {
    fail(
      "task",
      `legacy snapshot exceeds ${OPS_WORKER_LIMITS.maxLegacySnapshotBytes} UTF-8 bytes`,
    );
  }
  if (
    (schemaVersion === OPS_WORKER_TASK_V2_SCHEMA_VERSION
      || schemaVersion === OPS_WORKER_TASK_V3_SCHEMA_VERSION
      || schemaVersion === OPS_WORKER_TASK_V4_SCHEMA_VERSION)
    && bytes > OPS_WORKER_LIMITS.maxPreV5SnapshotBytes
  ) {
    fail(
      "task",
      `pre-v5 snapshot exceeds ${OPS_WORKER_LIMITS.maxPreV5SnapshotBytes} UTF-8 bytes`,
    );
  }
  if (
    schemaVersion === OPS_WORKER_TASK_V5_SCHEMA_VERSION
    && bytes > OPS_WORKER_LIMITS.maxV5SnapshotBytes
  ) {
    fail(
      "task",
      `v5 snapshot exceeds ${OPS_WORKER_LIMITS.maxV5SnapshotBytes} UTF-8 bytes`,
    );
  }
  return parseOpsWorkerTask(value, registry);
}
