export const OPS_WORKER_TASK_SCHEMA_VERSION = 1 as const;

export const OPS_WORKER_SOURCE_KINDS = [
  "alertmanager",
  "operator-cli",
  "registered-cron",
  "authorized-issue",
] as const;

export type OpsWorkerSourceKind = (typeof OPS_WORKER_SOURCE_KINDS)[number];

export const OPS_WORKER_SOURCE_PRIORITIES = {
  alertmanager: 0,
  "operator-cli": 10,
  "registered-cron": 20,
  "authorized-issue": 30,
} as const satisfies Record<OpsWorkerSourceKind, number>;

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

export const OPS_WORKER_AUTHORIZATION_TOOLS = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export type OpsWorkerAuthorizationTool =
  (typeof OPS_WORKER_AUTHORIZATION_TOOLS)[number];

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
  "DEFER",
  "ERROR",
  "QUOTA",
  "NETWORK",
  "CONTEXT_OVERFLOW",
  "CRASH",
  "STALL",
  "PREEMPTED",
  "AMBIGUOUS_ORPHAN",
  "CANCELLED",
  "BLOCKED",
] as const;

export type OpsWorkerOutcomeResult =
  (typeof OPS_WORKER_OUTCOME_RESULTS)[number];

export const OPS_WORKER_REPORT_STATES = ["NONE", "PENDING", "SENT"] as const;

export type OpsWorkerReportState = (typeof OPS_WORKER_REPORT_STATES)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface OpsWorkerTaskSource {
  kind: OpsWorkerSourceKind;
  correlationKey: string;
  template: string;
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

export interface OpsWorkerLastOutcome {
  at: string;
  kind: OpsWorkerOutcomeKind;
  result: OpsWorkerOutcomeResult;
  summary: string;
}

export interface OpsWorkerReport {
  state: OpsWorkerReportState;
  attempts: number;
  lastError: string | null;
}

export interface OpsWorkerTask {
  schemaVersion: typeof OPS_WORKER_TASK_SCHEMA_VERSION;
  id: string;
  source: OpsWorkerTaskSource;
  priority: OpsWorkerPriority;
  objective: string;
  evidence: OpsWorkerEvidence[];
  doneCheck: OpsWorkerDoneCheck;
  authorization: OpsWorkerAuthorization;
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

export interface OpsWorkerTemplateContract {
  sourceKinds: readonly OpsWorkerSourceKind[];
}

export interface OpsWorkerAuthorizationProfileContract {
  sourceKinds: readonly OpsWorkerSourceKind[];
  scope: readonly OpsWorkerAuthorizationScope[];
  /** Fixed Pi tool allowlist selected by trusted package code, never task data. */
  tools: readonly OpsWorkerAuthorizationTool[];
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
  maxSnapshotBytes: 256 * 1024,
  maxObjectiveBytes: 8 * 1024,
  maxEvidenceEntries: 64,
  maxEvidenceSummaryBytes: 4 * 1024,
  maxOutcomeSummaryBytes: 4 * 1024,
  maxReportErrorBytes: 2 * 1024,
  maxDoneCheckParamsBytes: 8 * 1024,
  maxDoneCheckParamDepth: 6,
  maxDoneCheckParamItems: 128,
  maxDoneCheckParamArrayLength: 64,
  maxDoneCheckParamStringBytes: 2 * 1024,
} as const;

const TASK_KEYS = [
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

const TASK_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REGISTERED_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const CORRELATION_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+?-]{0,254}[A-Za-z0-9]$|^[A-Za-z0-9]$/;
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
  "executable",
  "profile",
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

function expectRegisteredName(value: unknown, path: string): string {
  const name = expectString(value, path);
  if (!REGISTERED_NAME_PATTERN.test(name)) {
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
  expectExactKeys(source, ["kind", "correlationKey", "template"], "task.source");
  const kind = expectEnum(source.kind, OPS_WORKER_SOURCE_KINDS, "task.source.kind");
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

function parseEvidence(value: unknown): OpsWorkerEvidence[] {
  if (!Array.isArray(value)) {
    return fail("task.evidence", "must be an array");
  }
  if (value.length > OPS_WORKER_LIMITS.maxEvidenceEntries) {
    fail(
      "task.evidence",
      `must contain at most ${OPS_WORKER_LIMITS.maxEvidenceEntries} entries`,
    );
  }
  return value.map((item, index) => {
    const path = `task.evidence[${index}]`;
    const evidence = expectObject(item, path);
    expectExactKeys(evidence, ["at", "kind", "trust", "summary", "artifact"], path);
    const artifact = evidence.artifact === null
      ? null
      : parseArtifactPath(evidence.artifact, `${path}.artifact`);
    return {
      at: expectTimestamp(evidence.at, `${path}.at`),
      kind: expectEnum(evidence.kind, OPS_WORKER_EVIDENCE_KINDS, `${path}.kind`),
      trust: expectEnum(evidence.trust, OPS_WORKER_EVIDENCE_TRUST, `${path}.trust`),
      summary: expectBoundedText(
        evidence.summary,
        `${path}.summary`,
        OPS_WORKER_LIMITS.maxEvidenceSummaryBytes,
      ),
      artifact,
    };
  });
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
    if (value.length > OPS_WORKER_LIMITS.maxDoneCheckParamArrayLength) {
      return fail(path, "array is too large");
    }
    return value.map((item, index) => parseSafeJson(item, `${path}[${index}]`, depth + 1, budget));
  }
  const object = expectObject(value, path);
  const result: JsonObject = {};
  for (const key of Object.keys(object)) {
    if (!PARAM_KEY_PATTERN.test(key)) {
      fail(`${path}.${key}`, "unsafe parameter field name");
    }
    if (FORBIDDEN_PARAM_KEYS.has(key.toLowerCase())) {
      fail(`${path}.${key}`, "task data cannot select commands, executables, URLs, or authorization");
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
  if (!Array.isArray(contract.tools) || contract.tools.length === 0) {
    fail("task.authorization.profile", "registered profile must provide a fixed tool allowlist");
  }
  const tools = contract.tools.map((tool, index) =>
    expectEnum(tool, OPS_WORKER_AUTHORIZATION_TOOLS, `registry.authorization.tools[${index}]`));
  if (new Set(tools).size !== tools.length) {
    fail("task.authorization.profile", "registered profile tool allowlist must not contain duplicates");
  }
  const readOnlyScope = contract.scope.every((scope) =>
    scope === "inspect" || scope === "repository-read");
  if (readOnlyScope && tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write")) {
    fail(
      "task.authorization.profile",
      "read-only profiles cannot enable mutation or shell tools",
    );
  }
  if (!Array.isArray(authorization.scope)) {
    fail("task.authorization.scope", "must be an array");
  }
  const suppliedScope = authorization.scope.map((scope, index) =>
    expectEnum(scope, OPS_WORKER_AUTHORIZATION_SCOPES, `task.authorization.scope[${index}]`));
  if (
    suppliedScope.length !== contract.scope.length
    || suppliedScope.some((scope, index) => scope !== contract.scope[index])
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

function parseLastOutcome(value: unknown): OpsWorkerLastOutcome | null {
  if (value === null) return null;
  const outcome = expectObject(value, "task.lastOutcome");
  expectExactKeys(outcome, ["at", "kind", "result", "summary"], "task.lastOutcome");
  return {
    at: expectTimestamp(outcome.at, "task.lastOutcome.at"),
    kind: expectEnum(outcome.kind, OPS_WORKER_OUTCOME_KINDS, "task.lastOutcome.kind"),
    result: expectEnum(outcome.result, OPS_WORKER_OUTCOME_RESULTS, "task.lastOutcome.result"),
    summary: expectBoundedText(
      outcome.summary,
      "task.lastOutcome.summary",
      OPS_WORKER_LIMITS.maxOutcomeSummaryBytes,
    ),
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
    attempts: expectInteger(report.attempts, "task.report.attempts", 0, 1_000),
    lastError,
  };
}

export function assertOpsWorkerTaskId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !TASK_ID_PATTERN.test(id)) {
    fail("task.id", "must be a traversal-safe lowercase task identifier");
  }
}

export function isOpsWorkerTerminalState(
  state: OpsWorkerTaskState,
): state is OpsWorkerTerminalState {
  return (OPS_WORKER_TERMINAL_STATES as readonly string[]).includes(state);
}

/** Parse and copy an unknown value. No unchecked input object is returned. */
export function parseOpsWorkerTask(
  value: unknown,
  registry: OpsWorkerTaskContractRegistry,
): OpsWorkerTask {
  const task = expectObject(value, "task");
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
  const parsed: OpsWorkerTask = {
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    id,
    source,
    priority: priority as OpsWorkerPriority,
    objective: expectBoundedText(
      task.objective,
      "task.objective",
      OPS_WORKER_LIMITS.maxObjectiveBytes,
    ),
    evidence: parseEvidence(task.evidence),
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
  const serializedBytes = Buffer.byteLength(JSON.stringify(parsed), "utf8");
  if (serializedBytes > OPS_WORKER_LIMITS.maxSnapshotBytes) {
    fail(
      "task",
      `serialized snapshot exceeds ${OPS_WORKER_LIMITS.maxSnapshotBytes} UTF-8 bytes`,
    );
  }
  return parsed;
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
  return parseOpsWorkerTask(value, registry);
}
