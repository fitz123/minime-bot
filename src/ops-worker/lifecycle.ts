import { createHash } from "node:crypto";
import {
  OPS_WORKER_TASK_STORE_NO_CHANGE,
  OpsWorkerTaskStore,
} from "./task-store.js";
import {
  OPS_WORKER_MUTATION_BOUNDARIES,
  type OpsWorkerLifecycleManifest,
  type OpsWorkerMutationBoundary,
  type OpsWorkerMutationOutcomeResult,
  type OpsWorkerMutationReceipt,
  type OpsWorkerMutationReceipts,
  type OpsWorkerTask,
} from "./types.js";

export const OPS_WORKER_LIFECYCLE_IDENTITY_SLOTS = [
  "canonicalTask",
  "repository",
  "base",
  "head",
  "branch",
  "pullRequest",
  "merge",
  "tag",
  "release",
  "deploy",
  "verifier",
  "report",
  "tailAudit",
] as const;

export type OpsWorkerLifecycleIdentitySlot =
  (typeof OPS_WORKER_LIFECYCLE_IDENTITY_SLOTS)[number];

export type OpsWorkerLifecycleIdentityUpdate = Partial<
  Record<OpsWorkerLifecycleIdentitySlot, string>
>;

export const OPS_WORKER_LIFECYCLE_HELPER_LIMITS = {
  maxCanonicalPayloadBytes: 16 * 1024,
  maxCanonicalPayloadDepth: 8,
  maxCanonicalPayloadItems: 256,
} as const;

export interface OpsWorkerCheckpointInput {
  checkpointId: string;
  payload: unknown;
  summary: string;
  artifact?: string | null;
  lifecycle?: OpsWorkerLifecycleIdentityUpdate;
}

export interface OpsWorkerMutationOperationInput {
  boundary: OpsWorkerMutationBoundary;
  operationId: string;
  intent: unknown;
}

export interface OpsWorkerMutationQueryInput extends OpsWorkerMutationOperationInput {
  queryObservedAt: string;
  queryResult: unknown;
}

export interface OpsWorkerMutationFinishInput extends OpsWorkerMutationOperationInput {
  result: OpsWorkerMutationOutcomeResult;
  evidence: unknown;
  lifecycle?: OpsWorkerLifecycleIdentityUpdate;
}

export interface OpsWorkerMutationClaimResult {
  task: OpsWorkerTask;
  /** True only when this call durably acquired a new mutation claim. */
  claimed: boolean;
}

export interface OpsWorkerLifecycleOptions {
  now?: () => Date;
}

export class OpsWorkerLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsWorkerLifecycleError";
  }
}

const RECEIPT_SLOTS = {
  merge: "merge",
  "tag-release": "tagRelease",
  deploy: "deploy",
  "canonical-task": "canonicalTask",
  report: "report",
} as const satisfies Record<
  OpsWorkerMutationBoundary,
  keyof OpsWorkerMutationReceipts
>;

const IDENTITY_SLOTS = new Set<string>(OPS_WORKER_LIFECYCLE_IDENTITY_SLOTS);
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function canonicalTimestamp(value: string, label: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new OpsWorkerLifecycleError(`${label} must be an RFC 3339 UTC timestamp`);
  }
  const canonical = value.length === 20
    ? `${value.slice(0, -1)}.000Z`
    : value;
  let normalized: string;
  try {
    normalized = new Date(value).toISOString();
  } catch {
    throw new OpsWorkerLifecycleError(`${label} must be a real calendar timestamp`);
  }
  if (normalized !== canonical) {
    throw new OpsWorkerLifecycleError(`${label} must be a real calendar timestamp`);
  }
  return value;
}

function canonicalPayload(value: unknown): string {
  const seen = new Set<object>();
  let items = 0;
  const visit = (entry: unknown, depth: number): string => {
    items += 1;
    if (items > OPS_WORKER_LIFECYCLE_HELPER_LIMITS.maxCanonicalPayloadItems) {
      throw new OpsWorkerLifecycleError(
        `canonical payload must contain at most ${OPS_WORKER_LIFECYCLE_HELPER_LIMITS.maxCanonicalPayloadItems} items`,
      );
    }
    if (depth > OPS_WORKER_LIFECYCLE_HELPER_LIMITS.maxCanonicalPayloadDepth) {
      throw new OpsWorkerLifecycleError(
        `canonical payload must be at most ${OPS_WORKER_LIFECYCLE_HELPER_LIMITS.maxCanonicalPayloadDepth} levels deep`,
      );
    }
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") {
      return JSON.stringify(entry);
    }
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) {
        throw new OpsWorkerLifecycleError("canonical payload numbers must be finite");
      }
      return JSON.stringify(entry);
    }
    if (typeof entry !== "object") {
      throw new OpsWorkerLifecycleError(
        "canonical payload must contain only JSON values",
      );
    }
    if (seen.has(entry)) {
      throw new OpsWorkerLifecycleError("canonical payload must not contain cycles");
    }
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        return `[${entry.map((item) => visit(item, depth + 1)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new OpsWorkerLifecycleError(
          "canonical payload objects must be plain JSON objects",
        );
      }
      if (Object.getOwnPropertySymbols(entry).length > 0) {
        throw new OpsWorkerLifecycleError(
          "canonical payload must not contain symbol keys",
        );
      }
      const object = entry as Record<string, unknown>;
      const keys = Object.keys(object).sort();
      for (const key of keys) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor?.enumerable || descriptor.get || descriptor.set) {
          throw new OpsWorkerLifecycleError(
            "canonical payload must contain only plain enumerable values",
          );
        }
      }
      return `{${keys.map((key) =>
        `${JSON.stringify(key)}:${visit(object[key], depth + 1)}`).join(",")}}`;
    } finally {
      seen.delete(entry);
    }
  };
  const serialized = visit(value, 0);
  if (
    Buffer.byteLength(serialized, "utf8")
    > OPS_WORKER_LIFECYCLE_HELPER_LIMITS.maxCanonicalPayloadBytes
  ) {
    throw new OpsWorkerLifecycleError(
      `canonical payload must be at most ${OPS_WORKER_LIFECYCLE_HELPER_LIMITS.maxCanonicalPayloadBytes} UTF-8 bytes`,
    );
  }
  return serialized;
}

export function hashOpsWorkerCanonicalPayload(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalPayload(value)).digest("hex")}`;
}

function receiptSlot(
  boundary: OpsWorkerMutationBoundary,
): keyof OpsWorkerMutationReceipts {
  if (!(OPS_WORKER_MUTATION_BOUNDARIES as readonly unknown[]).includes(boundary)) {
    throw new OpsWorkerLifecycleError(
      `unsupported mutation boundary ${String(boundary)}`,
    );
  }
  return RECEIPT_SLOTS[boundary];
}

function applyLifecycleIdentity(
  manifest: OpsWorkerLifecycleManifest,
  update: OpsWorkerLifecycleIdentityUpdate | undefined,
): boolean {
  if (update === undefined) return false;
  let changed = false;
  for (const [slot, identity] of Object.entries(update)) {
    if (!IDENTITY_SLOTS.has(slot)) {
      throw new OpsWorkerLifecycleError(`unknown lifecycle identity slot ${slot}`);
    }
    if (typeof identity !== "string") {
      throw new OpsWorkerLifecycleError(
        `lifecycle identity slot ${slot} must be a string`,
      );
    }
    const typedSlot = slot as OpsWorkerLifecycleIdentitySlot;
    const existing = manifest[typedSlot];
    if (existing !== null && existing !== identity) {
      throw new OpsWorkerLifecycleError(
        `lifecycle identity slot ${slot} already contains different evidence`,
      );
    }
    if (existing === null) {
      manifest[typedSlot] = identity;
      changed = true;
    }
  }
  return changed;
}

function assertMatchingOperation(
  receipt: OpsWorkerMutationReceipt,
  operationId: string,
  intentHash: string,
): void {
  if (receipt.operationId !== operationId) {
    throw new OpsWorkerLifecycleError(
      `receipt slot ${receipt.boundary} belongs to operation ${receipt.operationId}, not ${operationId}`,
    );
  }
  if (receipt.intentHash !== intentHash) {
    throw new OpsWorkerLifecycleError(
      `operation ${operationId} was reused with a different intent`,
    );
  }
}

function timestampAtOrAfter(now: Date, floor: string): string {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new OpsWorkerLifecycleError("lifecycle clock returned an invalid date");
  }
  return new Date(Math.max(milliseconds, Date.parse(floor))).toISOString();
}

/**
 * Atomic, evidence-only lifecycle helpers. They never execute a mutation or
 * contact a transport; callers remain responsible for those external actions.
 */
export class OpsWorkerLifecycle {
  private readonly now: () => Date;

  constructor(
    private readonly store: OpsWorkerTaskStore,
    options: OpsWorkerLifecycleOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  updateLifecycleIdentity(
    taskId: string,
    update: OpsWorkerLifecycleIdentityUpdate,
  ): OpsWorkerTask {
    const result = this.store.mutate(
      taskId,
      { event: "EVIDENCE", summary: "Recorded fixed lifecycle identity evidence" },
      (task) => {
        if (!applyLifecycleIdentity(task.lifecycle, update)) {
          return OPS_WORKER_TASK_STORE_NO_CHANGE;
        }
      },
    );
    return result.task;
  }

  recordCheckpoint(taskId: string, input: OpsWorkerCheckpointInput): OpsWorkerTask {
    const payloadHash = hashOpsWorkerCanonicalPayload(input.payload);
    const artifact = input.artifact ?? null;
    const result = this.store.mutate(
      taskId,
      { event: "EVIDENCE", summary: "Recorded package-owned lifecycle checkpoint" },
      (task) => {
        let changed = applyLifecycleIdentity(task.lifecycle, input.lifecycle);
        const existing = task.currentCheckpoint;
        if (existing?.checkpointId === input.checkpointId) {
          if (
            existing.payloadHash !== payloadHash
            || existing.summary !== input.summary
            || existing.artifact !== artifact
          ) {
            throw new OpsWorkerLifecycleError(
              `checkpoint ${input.checkpointId} was reused with a different canonical payload`,
            );
          }
        } else {
          task.currentCheckpoint = {
            checkpointId: input.checkpointId,
            recordedAt: this.now().toISOString(),
            payloadHash,
            summary: input.summary,
            artifact,
          };
          changed = true;
        }
        if (!changed) return OPS_WORKER_TASK_STORE_NO_CHANGE;
      },
    );
    return result.task;
  }

  beginMutationReceipt(
    taskId: string,
    input: OpsWorkerMutationQueryInput,
  ): OpsWorkerTask {
    const slot = receiptSlot(input.boundary);
    const intentHash = hashOpsWorkerCanonicalPayload(input.intent);
    const queryResultHash = hashOpsWorkerCanonicalPayload(input.queryResult);
    const queryObservedAt = canonicalTimestamp(
      input.queryObservedAt,
      "mutation query observation",
    );
    const result = this.store.mutate(
      taskId,
      { event: "UPDATED", summary: `Recorded ${input.boundary} query observation` },
      (task) => {
        const existing = task.mutationReceipts[slot];
        if (existing !== null) {
          if (existing.operationId !== input.operationId) {
            if (existing.outcome === null) {
              throw new OpsWorkerLifecycleError(
                `unfinished ${input.boundary} receipt must be reconciled before operation ${input.operationId}`,
              );
            }
          } else {
            assertMatchingOperation(existing, input.operationId, intentHash);
            if (existing.outcome !== null) {
              return OPS_WORKER_TASK_STORE_NO_CHANGE;
            }
            if (
              existing.mutationStartedAt !== null
              && Date.parse(queryObservedAt) <= Date.parse(existing.mutationStartedAt)
            ) {
              throw new OpsWorkerLifecycleError(
                `a fresh query observation is required to reconcile unfinished ${input.boundary} operation ${input.operationId}`,
              );
            }
            if (
              existing.mutationStartedAt === null
              && existing.queryObservedAt === queryObservedAt
            ) {
              if (existing.queryResultHash === queryResultHash) {
                return OPS_WORKER_TASK_STORE_NO_CHANGE;
              }
              throw new OpsWorkerLifecycleError(
                `${input.boundary} query observation was reused with different evidence`,
              );
            }
            if (Date.parse(queryObservedAt) < Date.parse(existing.queryObservedAt)) {
              throw new OpsWorkerLifecycleError(
                `${input.boundary} query observation cannot move backwards`,
              );
            }
          }
        }
        task.mutationReceipts[slot] = {
          boundary: input.boundary,
          operationId: input.operationId,
          intentHash,
          queryObservedAt,
          queryResultHash,
          mutationStartedAt: null,
          outcome: null,
        };
      },
    );
    return result.task;
  }

  claimMutationReceipt(
    taskId: string,
    input: OpsWorkerMutationOperationInput,
  ): OpsWorkerMutationClaimResult {
    const slot = receiptSlot(input.boundary);
    const intentHash = hashOpsWorkerCanonicalPayload(input.intent);
    let claimed = false;
    const result = this.store.mutate(
      taskId,
      { event: "UPDATED", summary: `Claimed ${input.boundary} mutation boundary` },
      (task) => {
        const receipt = task.mutationReceipts[slot];
        if (receipt === null) {
          throw new OpsWorkerLifecycleError(
            `${input.boundary} mutation requires a query observation before it can be claimed`,
          );
        }
        assertMatchingOperation(receipt, input.operationId, intentHash);
        if (receipt.outcome !== null || receipt.mutationStartedAt !== null) {
          return OPS_WORKER_TASK_STORE_NO_CHANGE;
        }
        receipt.mutationStartedAt = timestampAtOrAfter(
          this.now(),
          receipt.queryObservedAt,
        );
        claimed = true;
      },
    );
    return { task: result.task, claimed };
  }

  finishMutationReceipt(
    taskId: string,
    input: OpsWorkerMutationFinishInput,
  ): OpsWorkerTask {
    const slot = receiptSlot(input.boundary);
    const intentHash = hashOpsWorkerCanonicalPayload(input.intent);
    const evidenceHash = hashOpsWorkerCanonicalPayload(input.evidence);
    const result = this.store.mutate(
      taskId,
      { event: "UPDATED", summary: `Finished ${input.boundary} mutation receipt` },
      (task) => {
        const receipt = task.mutationReceipts[slot];
        if (receipt === null) {
          throw new OpsWorkerLifecycleError(
            `${input.boundary} outcome requires a prior query observation`,
          );
        }
        assertMatchingOperation(receipt, input.operationId, intentHash);
        if (input.result === "APPLIED" && receipt.mutationStartedAt === null) {
          throw new OpsWorkerLifecycleError(
            `${input.boundary} APPLIED outcome requires a durable mutation claim`,
          );
        }
        let changed = applyLifecycleIdentity(task.lifecycle, input.lifecycle);
        if (receipt.outcome !== null) {
          if (
            receipt.outcome.result !== input.result
            || receipt.outcome.evidenceHash !== evidenceHash
          ) {
            throw new OpsWorkerLifecycleError(
              `operation ${input.operationId} outcome was reused with different evidence`,
            );
          }
        } else {
          const floor = receipt.mutationStartedAt ?? receipt.queryObservedAt;
          receipt.outcome = {
            recordedAt: timestampAtOrAfter(this.now(), floor),
            result: input.result,
            evidenceHash,
          };
          changed = true;
        }
        if (!changed) return OPS_WORKER_TASK_STORE_NO_CHANGE;
      },
    );
    return result.task;
  }
}
