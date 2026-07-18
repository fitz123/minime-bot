import { createHash } from "node:crypto";
import {
  OPS_WORKER_TASK_STORE_NO_CHANGE,
  OpsWorkerTaskStore,
  type OpsWorkerAuditInput,
} from "./task-store.js";
import {
  OPS_WORKER_AUTHORIZATION_VERIFICATION_STATUSES,
  OPS_WORKER_LIMITS,
  isOpsWorkerTerminalState,
  type OpsWorkerAuthorizationVerification,
  type OpsWorkerAuthorizationVerificationStatus,
  type OpsWorkerEvidence,
  type OpsWorkerSourceKind,
  type OpsWorkerTask,
} from "./types.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_IDENTITY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:@/+-]{0,254}[A-Za-z0-9])?$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export const ADR_091_AUTHORIZED_ISSUE_VALIDATOR_IDENTITY =
  "adr-091-authorized-issue" as const;
export const ADR_091_AUTHORIZED_ISSUE_VALIDATOR_VERSION = "1" as const;

export interface OpsWorkerAuthorizationVerifierResult {
  status: OpsWorkerAuthorizationVerificationStatus;
  evidenceHash: string;
  summary: string;
}

/** Trusted package adapter. Task data can never construct or select one. */
export interface OpsWorkerAuthorizationVerifier {
  readonly identity: string;
  readonly version: string;
  verify(
    task: Readonly<OpsWorkerTask>,
  ): OpsWorkerAuthorizationVerifierResult | Promise<OpsWorkerAuthorizationVerifierResult>;
}

export type OpsWorkerAuthorizationVerifierRegistry = Readonly<
  Partial<Record<OpsWorkerSourceKind, OpsWorkerAuthorizationVerifier>>
>;

export interface Adr091RepositoryIdentity {
  identity: string;
  resourceKey: string;
}

export type Adr091IssueTimelineEvent =
  | { id: string; kind: "CONTENT_EDIT"; at: string }
  | {
    id: string;
    kind: "LABEL_APPLIED" | "LABEL_REMOVED";
    label: string;
    actorIdentity: string;
    at: string;
  }
  | {
    id: string;
    kind: "COMMENT";
    actorIdentity: string;
    at: string;
  };

export interface Adr091AuthorizedIssueSnapshot {
  canonicalTask: string;
  repository: Adr091RepositoryIdentity;
  issue: {
    identity: string;
    authorIdentity: string;
    title: string;
    body: string;
    labels: string[];
    createdAt: string;
  };
  timeline: {
    complete: boolean;
    events: Adr091IssueTimelineEvent[];
  };
}

export interface Adr091CanonicalTaskResolver {
  resolve(
    canonicalTask: string,
  ): Adr091AuthorizedIssueSnapshot | Promise<Adr091AuthorizedIssueSnapshot>;
}

export interface Adr091AuthorizedIssuePolicy {
  repository: Adr091RepositoryIdentity;
  allowedIssueAuthorIdentities: readonly string[];
  allowedReadyActorIdentities: readonly string[];
  readyLabel?: string;
}

export interface Adr091AuthorizedIssueVerifierOptions {
  policy: Adr091AuthorizedIssuePolicy;
  resolver: Adr091CanonicalTaskResolver;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function hashCanonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function authorizationEvidenceHash(
  status: OpsWorkerAuthorizationVerificationStatus,
  reason: string,
  checkedSnapshotHash: string,
): string {
  return hashCanonical({ status, reason, checkedSnapshotHash });
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  const canonical = value.length === 20
    ? `${value.slice(0, -1)}.000Z`
    : value;
  try {
    return new Date(value).toISOString() === canonical;
  } catch {
    return false;
  }
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && SAFE_IDENTITY_PATTERN.test(value);
}

function boundedSummary(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
  ) return "Authorization verifier returned invalid bounded evidence.";
  if (
    Buffer.byteLength(value, "utf8")
    <= OPS_WORKER_LIMITS.maxAuthorizationVerificationSummaryBytes
  ) return value;
  let result = "";
  for (const character of value) {
    if (
      Buffer.byteLength(result + character, "utf8")
      > OPS_WORKER_LIMITS.maxAuthorizationVerificationSummaryBytes
    ) break;
    result += character;
  }
  return result;
}

function closedResult(
  status: OpsWorkerAuthorizationVerificationStatus,
  reason: string,
  checkedSnapshotHash: string,
): OpsWorkerAuthorizationVerifierResult {
  const summaries: Record<OpsWorkerAuthorizationVerificationStatus, string> = {
    PASS: "Authorization claim is current and matches trusted policy.",
    DRIFT: "Authorization policy evidence has drifted from the trusted claim.",
    QUERY_ERROR: "Authorization evidence could not be resolved unambiguously.",
    INVALID_CLAIM: "Authorization claim is missing or does not match canonical evidence.",
  };
  return {
    status,
    evidenceHash: authorizationEvidenceHash(status, reason, checkedSnapshotHash),
    summary: summaries[status],
  };
}

function assertTrustedPolicyIdentity(value: string, label: string): void {
  if (!validIdentity(value)) throw new TypeError(`${label} is not a safe fixed identity`);
}

function normalizePolicy(
  supplied: Adr091AuthorizedIssuePolicy,
): Required<Adr091AuthorizedIssuePolicy> {
  assertTrustedPolicyIdentity(supplied.repository.identity, "repository identity");
  assertTrustedPolicyIdentity(supplied.repository.resourceKey, "repository resource key");
  const authors = [...supplied.allowedIssueAuthorIdentities];
  const actors = [...supplied.allowedReadyActorIdentities];
  if (authors.length === 0 || actors.length === 0) {
    throw new TypeError("ADR-091 policy allowlists must not be empty");
  }
  authors.forEach((identity) => assertTrustedPolicyIdentity(identity, "issue author identity"));
  actors.forEach((identity) => assertTrustedPolicyIdentity(identity, "ready-label actor identity"));
  if (new Set(authors).size !== authors.length || new Set(actors).size !== actors.length) {
    throw new TypeError("ADR-091 policy allowlists must not contain duplicates");
  }
  const readyLabel = supplied.readyLabel ?? "autonomous-ready";
  assertTrustedPolicyIdentity(readyLabel, "ready label");
  return {
    repository: { ...supplied.repository },
    allowedIssueAuthorIdentities: authors,
    allowedReadyActorIdentities: actors,
    readyLabel,
  };
}

function snapshotShapeIsComplete(snapshot: Adr091AuthorizedIssueSnapshot): boolean {
  if (
    !snapshot
    || !validIdentity(snapshot.canonicalTask)
    || !validIdentity(snapshot.repository?.identity)
    || !validIdentity(snapshot.repository?.resourceKey)
    || !validIdentity(snapshot.issue?.identity)
    || !validIdentity(snapshot.issue?.authorIdentity)
    || typeof snapshot.issue?.title !== "string"
    || typeof snapshot.issue?.body !== "string"
    || Buffer.byteLength(snapshot.issue.title, "utf8") > 8 * 1024
    || Buffer.byteLength(snapshot.issue.body, "utf8") > 128 * 1024
    || !validTimestamp(snapshot.issue?.createdAt)
    || !Array.isArray(snapshot.issue?.labels)
    || snapshot.issue.labels.length > 100
    || snapshot.issue.labels.some((label) => !validIdentity(label))
    || new Set(snapshot.issue.labels).size !== snapshot.issue.labels.length
    || snapshot.timeline?.complete !== true
    || !Array.isArray(snapshot.timeline?.events)
    || snapshot.timeline.events.length > 10_000
  ) return false;
  const ids = new Set<string>();
  for (const event of snapshot.timeline.events) {
    if (
      !event
      || !validIdentity(event.id)
      || ids.has(event.id)
      || !validTimestamp(event.at)
      || !["CONTENT_EDIT", "LABEL_APPLIED", "LABEL_REMOVED", "COMMENT"].includes(event.kind)
      || Date.parse(event.at) < Date.parse(snapshot.issue.createdAt)
    ) return false;
    ids.add(event.id);
    if (
      event.kind !== "CONTENT_EDIT"
      && !validIdentity(event.actorIdentity)
    ) return false;
    if (
      (event.kind === "LABEL_APPLIED" || event.kind === "LABEL_REMOVED")
      && !validIdentity(event.label)
    ) return false;
  }
  return true;
}

/** Exact canonical claim; comments are deliberately non-authoritative evidence. */
export function hashAdr091AuthorizedIssueClaim(
  snapshot: Adr091AuthorizedIssueSnapshot,
): string {
  const authoritativeTimeline = snapshot.timeline.events
    .filter((event) => event.kind !== "COMMENT")
    .map((event) => ({ ...event }))
    .sort((left, right) => left.at.localeCompare(right.at) || left.id.localeCompare(right.id));
  return hashCanonical({
    canonicalTask: snapshot.canonicalTask,
    repository: snapshot.repository,
    issue: {
      identity: snapshot.issue.identity,
      authorIdentity: snapshot.issue.authorIdentity,
      title: snapshot.issue.title,
      body: snapshot.issue.body,
      labels: [...snapshot.issue.labels].sort(),
      createdAt: snapshot.issue.createdAt,
    },
    authoritativeTimeline,
  });
}

export function createAdr091AuthorizedIssueVerifier(
  options: Adr091AuthorizedIssueVerifierOptions,
): OpsWorkerAuthorizationVerifier {
  const policy = normalizePolicy(options.policy);
  if (!options.resolver || typeof options.resolver.resolve !== "function") {
    throw new TypeError("ADR-091 canonical-task resolver is required");
  }
  return Object.freeze({
    identity: ADR_091_AUTHORIZED_ISSUE_VALIDATOR_IDENTITY,
    version: ADR_091_AUTHORIZED_ISSUE_VALIDATOR_VERSION,
    async verify(task: Readonly<OpsWorkerTask>): Promise<OpsWorkerAuthorizationVerifierResult> {
      const checkedSnapshotHash = hashOpsWorkerAuthorizationSnapshot(task);
      if (
        task.source.kind !== "authorized-issue"
        || task.resource.kind !== "repository"
        || task.lifecycle.canonicalTask === null
        || task.authorization.snapshotHash === null
      ) return closedResult("INVALID_CLAIM", "missing-fixed-claim", checkedSnapshotHash);

      let snapshot: Adr091AuthorizedIssueSnapshot;
      try {
        snapshot = await options.resolver.resolve(task.lifecycle.canonicalTask);
      } catch {
        return closedResult("QUERY_ERROR", "resolver-failed", checkedSnapshotHash);
      }
      if (!snapshotShapeIsComplete(snapshot)) {
        return closedResult("QUERY_ERROR", "incomplete-snapshot", checkedSnapshotHash);
      }
      if (snapshot.canonicalTask !== task.lifecycle.canonicalTask) {
        return closedResult("QUERY_ERROR", "canonical-task-ambiguity", checkedSnapshotHash);
      }
      if (
        task.resource.key !== policy.repository.resourceKey
        || task.lifecycle.repository !== policy.repository.identity
      ) return closedResult("INVALID_CLAIM", "fixed-repository-claim", checkedSnapshotHash);
      if (
        snapshot.repository.identity !== policy.repository.identity
        || snapshot.repository.resourceKey !== policy.repository.resourceKey
      ) return closedResult("DRIFT", "repository-drift", checkedSnapshotHash);
      if (!policy.allowedIssueAuthorIdentities.includes(snapshot.issue.authorIdentity)) {
        return closedResult("DRIFT", "issue-author-drift", checkedSnapshotHash);
      }
      if (!snapshot.issue.labels.includes(policy.readyLabel)) {
        return closedResult("DRIFT", "ready-label-missing", checkedSnapshotHash);
      }

      const criticalEvents = snapshot.timeline.events.filter((event) =>
        event.kind === "CONTENT_EDIT"
        || (
          (event.kind === "LABEL_APPLIED" || event.kind === "LABEL_REMOVED")
          && event.label === policy.readyLabel
        ));
      const criticalTimes = new Set<string>();
      for (const event of criticalEvents) {
        if (criticalTimes.has(event.at)) {
          return closedResult("QUERY_ERROR", "ambiguous-event-order", checkedSnapshotHash);
        }
        criticalTimes.add(event.at);
      }
      const contentEdits = criticalEvents.filter((event) => event.kind === "CONTENT_EDIT");
      const latestContentAt = contentEdits.reduce(
        (latest, event) => event.at > latest ? event.at : latest,
        snapshot.issue.createdAt,
      );
      const readyEvents = criticalEvents.filter((event) => event.kind !== "CONTENT_EDIT") as Array<
        Extract<Adr091IssueTimelineEvent, { kind: "LABEL_APPLIED" | "LABEL_REMOVED" }>
      >;
      readyEvents.sort((left, right) => left.at.localeCompare(right.at));
      const latestReady = readyEvents.at(-1);
      if (!latestReady) {
        return closedResult("QUERY_ERROR", "missing-ready-timeline", checkedSnapshotHash);
      }
      if (latestReady.kind !== "LABEL_APPLIED") {
        return closedResult("QUERY_ERROR", "label-state-contradiction", checkedSnapshotHash);
      }
      if (latestReady.at <= latestContentAt) {
        return closedResult("DRIFT", "content-newer-than-ready", checkedSnapshotHash);
      }
      if (!policy.allowedReadyActorIdentities.includes(latestReady.actorIdentity)) {
        return closedResult("DRIFT", "ready-actor-drift", checkedSnapshotHash);
      }
      if (hashAdr091AuthorizedIssueClaim(snapshot) !== task.authorization.snapshotHash) {
        return closedResult("INVALID_CLAIM", "canonical-claim-mismatch", checkedSnapshotHash);
      }
      return closedResult("PASS", "canonical-claim-pass", checkedSnapshotHash);
    },
  });
}

export function hashOpsWorkerAuthorizationSnapshot(
  task: Pick<
    OpsWorkerTask,
    "source" | "resource" | "lifecycle" | "authorization"
  >,
): string {
  return hashCanonical({
    sourceKind: task.source.kind,
    resource: task.resource,
    canonicalTask: task.lifecycle.canonicalTask,
    repository: task.lifecycle.repository,
    authorization: task.authorization,
  });
}

export function hasFreshOpsWorkerAuthorizationPass(
  task: Readonly<OpsWorkerTask>,
  notBefore?: string,
): boolean {
  const verification = task.authorizationVerification;
  return verification?.status === "PASS"
    && verification.checkedSnapshotHash === hashOpsWorkerAuthorizationSnapshot(task)
    && (
      notBefore === undefined
      || Date.parse(verification.checkedAt) >= Date.parse(notBefore)
    );
}

function isValidVerifierResult(
  value: OpsWorkerAuthorizationVerifierResult,
): boolean {
  return Boolean(
    value
    && (OPS_WORKER_AUTHORIZATION_VERIFICATION_STATUSES as readonly string[])
      .includes(value.status)
    && SHA256_PATTERN.test(value.evidenceHash)
    && typeof value.summary === "string"
    && value.summary.length > 0
    && !value.summary.includes("\0")
    && Buffer.byteLength(value.summary, "utf8")
      <= OPS_WORKER_LIMITS.maxAuthorizationVerificationSummaryBytes,
  );
}

export async function verifyOpsWorkerAuthorization(
  task: Readonly<OpsWorkerTask>,
  verifiers: OpsWorkerAuthorizationVerifierRegistry,
  checkedAt: string,
): Promise<OpsWorkerAuthorizationVerification> {
  const checkedSnapshotHash = hashOpsWorkerAuthorizationSnapshot(task);
  const verifier = verifiers[task.source.kind];
  const validVerifierMetadata = verifier !== undefined
    && validIdentity(verifier.identity)
    && validIdentity(verifier.version);
  const validatorIdentity = validVerifierMetadata ? verifier.identity : "missing-verifier";
  const validatorVersion = validVerifierMetadata ? verifier.version : "1";
  let result: OpsWorkerAuthorizationVerifierResult;
  if (!verifier || !validVerifierMetadata) {
    result = closedResult("QUERY_ERROR", "missing-verifier", checkedSnapshotHash);
  } else if (task.authorization.snapshotHash === null) {
    result = closedResult("INVALID_CLAIM", "null-claim", checkedSnapshotHash);
  } else {
    try {
      const supplied = await verifier.verify(task);
      result = isValidVerifierResult(supplied)
        ? supplied
        : closedResult("QUERY_ERROR", "invalid-verifier-result", checkedSnapshotHash);
    } catch {
      result = closedResult("QUERY_ERROR", "verifier-threw", checkedSnapshotHash);
    }
  }
  return {
    validatorIdentity,
    validatorVersion,
    checkedSnapshotHash,
    checkedAt,
    status: result.status,
    evidenceHash: result.evidenceHash,
    summary: boundedSummary(result.summary),
  };
}

export interface OpsWorkerAuthorizationCoordinatorOptions {
  verifiers?: OpsWorkerAuthorizationVerifierRegistry;
  now?: () => Date;
  queryRetryMs?: number;
}

export interface OpsWorkerAuthorizationDecision {
  authorized: boolean;
  task: OpsWorkerTask;
}

export interface OpsWorkerAuthorizationRevalidationOptions {
  /** Runs in the same task-store mutation as a fresh PASS record. */
  onPass?: (task: OpsWorkerTask) => void;
  audit?: OpsWorkerAuditInput;
}

function atOrAfter(now: Date, previous: string | undefined): string {
  const floor = previous === undefined ? 0 : Date.parse(previous) + 1;
  return new Date(Math.max(now.getTime(), floor)).toISOString();
}

function authorizationEvidence(
  verification: OpsWorkerAuthorizationVerification,
): OpsWorkerEvidence {
  return {
    at: verification.checkedAt,
    kind: "authorization",
    trust: "trusted",
    summary: verification.summary,
    artifact: null,
  };
}

/** Persists a fresh decision and applies every closed outcome atomically. */
export class OpsWorkerAuthorizationCoordinator {
  private readonly verifiers: OpsWorkerAuthorizationVerifierRegistry;
  private readonly now: () => Date;
  private readonly queryRetryMs: number;

  constructor(
    private readonly store: OpsWorkerTaskStore,
    options: OpsWorkerAuthorizationCoordinatorOptions = {},
  ) {
    this.verifiers = options.verifiers ?? Object.freeze({});
    this.now = options.now ?? (() => new Date());
    this.queryRetryMs = options.queryRetryMs ?? 60_000;
    if (
      !Number.isSafeInteger(this.queryRetryMs)
      || this.queryRetryMs < 1
      || this.queryRetryMs > 24 * 60 * 60 * 1_000
    ) throw new TypeError("authorization queryRetryMs must be between 1 and 86400000");
  }

  async revalidate(
    taskId: string,
    options: OpsWorkerAuthorizationRevalidationOptions = {},
  ): Promise<OpsWorkerAuthorizationDecision> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const baseline = this.store.get(taskId);
      if (!baseline) throw new Error(`Unknown ops-worker task ${taskId}`);
      const checkedAt = atOrAfter(
        this.now(),
        baseline.authorizationVerification?.checkedAt,
      );
      const verification = await verifyOpsWorkerAuthorization(
        baseline,
        this.verifiers,
        checkedAt,
      );
      let stale = false;
      const result = this.store.mutate(
        taskId,
        options.audit
          ?? { event: "EVIDENCE", summary: "Revalidated fixed authorization policy" },
        (task) => {
          if (
            hashOpsWorkerAuthorizationSnapshot(task)
            !== verification.checkedSnapshotHash
          ) {
            stale = true;
            return OPS_WORKER_TASK_STORE_NO_CHANGE;
          }
          if (
            verification.status !== "PASS"
            && isOpsWorkerTerminalState(task.state)
          ) {
            // A fresh denial fences the requested mutation, but terminal task state is
            // immutable. Retain the successful composite evidence that established the
            // terminal state and append the denial as an audit-only observation.
            task.evidence = [...task.evidence, authorizationEvidence(verification)].slice(
              -OPS_WORKER_LIMITS.maxEvidenceEntries,
            );
            return;
          }
          const previousVerification = task.authorizationVerification;
          task.authorizationVerification = verification;
          if (
            task.verification !== null
            && (
              previousVerification?.checkedSnapshotHash
                !== verification.checkedSnapshotHash
              || previousVerification.status !== verification.status
            )
          ) {
            task.verification = null;
          }
          if (verification.status === "PASS") {
            options.onPass?.(task);
            return;
          }
          if (task.activeRun !== null || task.unverifiedRun !== null || task.state === "RUNNING") {
            throw new Error("Cannot apply authorization failure while a process may still exist");
          }
          const at = atOrAfter(this.now(), task.updatedAt);
          task.updatedAt = at;
          task.evidence = [...task.evidence, authorizationEvidence(verification)].slice(
            -OPS_WORKER_LIMITS.maxEvidenceEntries,
          );
          task.lastOutcome = {
            at,
            kind: "AUTHORIZATION",
            result: verification.status === "QUERY_ERROR" ? "ERROR" : "BLOCKED",
            summary: verification.summary,
          };
          if (verification.status === "QUERY_ERROR") {
            const next = new Date(
              this.now().getTime() + this.queryRetryMs,
            ).toISOString();
            if (task.state === "CHECKING") task.schedule.nextCheckAt = next;
            else task.schedule.nextRunAt = next;
            return;
          }
          task.state = "BLOCKED";
          task.schedule.nextRunAt = null;
          task.schedule.nextCheckAt = null;
          task.report.state = "PENDING";
          task.report.lastError = null;
          task.custody = {
            status: "RELEASED",
            claimedAt: task.custody.claimedAt,
            releasedAt: at,
            releaseReason: "BLOCKED",
          };
        },
      );
      if (stale) continue;
      return {
        authorized: verification.status === "PASS",
        task: result.task,
      };
    }
    throw new Error(`Task ${taskId} changed during authorization verification`);
  }
}
