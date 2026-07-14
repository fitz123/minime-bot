/** Strict, terminating result contract for the same-host recovery planner. */

export const RECOVERY_PLAN_TOOL_NAME = "recovery_plan";
export const MAX_RECOVERY_SUMMARY_CHARS = 1_000;
export const MAX_RECOVERY_SUMMARY_BYTES = 4_000;
export const MAX_RECOVERY_EVIDENCE_REFS = 16;
export const MAX_RECOVERY_RUNBOOK_IDS = 8;
export const MAX_RECOVERY_PROBE_IDS = 16;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIAGNOSIS_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const EVIDENCE_HASH = /^[a-f0-9]{64}$/;
const VERDICTS = new Set<RecoveryPlanVerdict>([
  "observe",
  "not_actionable",
  "execute",
  "approval_required",
]);

export type RecoveryPlanVerdict =
  | "observe"
  | "not_actionable"
  | "execute"
  | "approval_required";

export interface RecoveryPlanFence {
  invocationId: number;
  incidentId: number;
  generation: number;
  evidenceHash: string;
  policyRevision: number;
}

export interface RecoveryPlan extends RecoveryPlanFence {
  verdict: RecoveryPlanVerdict;
  diagnosisCode: string;
  summary: string;
  evidenceRefs: readonly string[];
  runbookIds: readonly string[];
  probeIds: readonly string[];
  nextEvaluationDelaySeconds: number;
}

export interface RecoveryPlanValidationContext {
  fence: RecoveryPlanFence;
  knownEvidenceRefs: ReadonlySet<string>;
  knownRunbookIds: ReadonlySet<string>;
  knownProbeIds: ReadonlySet<string>;
}

export class RecoveryPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryPlanValidationError";
  }
}

const PLAN_KEYS = new Set([
  "invocationId",
  "incidentId",
  "generation",
  "evidenceHash",
  "policyRevision",
  "verdict",
  "diagnosisCode",
  "summary",
  "evidenceRefs",
  "runbookIds",
  "probeIds",
  "nextEvaluationDelaySeconds",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new RecoveryPlanValidationError(`${name} is invalid`);
  }
  return value as number;
}

function boundedString(value: unknown, name: string, maxChars: number, maxBytes: number): string {
  if (
    typeof value !== "string"
    || value.trim() === ""
    || value.length > maxChars
    || Buffer.byteLength(value, "utf8") > maxBytes
    || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new RecoveryPlanValidationError(`${name} is invalid`);
  }
  return value;
}

function idList(value: unknown, name: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new RecoveryPlanValidationError(`${name} is invalid`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !SAFE_ID.test(item)) {
      throw new RecoveryPlanValidationError(`${name} is invalid`);
    }
    result.push(item);
  }
  if (new Set(result).size !== result.length) {
    throw new RecoveryPlanValidationError(`${name} contains duplicates`);
  }
  return result;
}

function assertKnown(values: readonly string[], known: ReadonlySet<string>, name: string): void {
  if (values.some((value) => !known.has(value))) {
    throw new RecoveryPlanValidationError(`${name} contains an unknown id`);
  }
}

function assertFence(actual: RecoveryPlanFence, expected: RecoveryPlanFence): void {
  if (
    actual.invocationId !== expected.invocationId
    || actual.incidentId !== expected.incidentId
    || actual.generation !== expected.generation
    || actual.evidenceHash !== expected.evidenceHash
    || actual.policyRevision !== expected.policyRevision
  ) {
    throw new RecoveryPlanValidationError("recovery plan fence is stale");
  }
}

/**
 * Validate and freeze one planner result. Unknown fields, stale fences, unknown
 * registry ids, and verdict/action mismatches fail closed.
 */
export function validateRecoveryPlan(
  value: unknown,
  context?: RecoveryPlanValidationContext,
): Readonly<RecoveryPlan> {
  if (!isRecord(value)) {
    throw new RecoveryPlanValidationError("recovery plan is not an object");
  }
  const keys = Object.keys(value);
  if (keys.length !== PLAN_KEYS.size || keys.some((key) => !PLAN_KEYS.has(key))) {
    throw new RecoveryPlanValidationError("recovery plan fields are invalid");
  }

  const fence: RecoveryPlanFence = {
    invocationId: positiveInteger(value.invocationId, "invocationId"),
    incidentId: positiveInteger(value.incidentId, "incidentId"),
    generation: positiveInteger(value.generation, "generation"),
    evidenceHash: typeof value.evidenceHash === "string" && EVIDENCE_HASH.test(value.evidenceHash)
      ? value.evidenceHash
      : (() => { throw new RecoveryPlanValidationError("evidenceHash is invalid"); })(),
    policyRevision: positiveInteger(value.policyRevision, "policyRevision"),
  };
  if (context) {
    assertFence(fence, context.fence);
  }

  if (typeof value.verdict !== "string" || !VERDICTS.has(value.verdict as RecoveryPlanVerdict)) {
    throw new RecoveryPlanValidationError("verdict is invalid");
  }
  const verdict = value.verdict as RecoveryPlanVerdict;
  const diagnosisCode = typeof value.diagnosisCode === "string" && DIAGNOSIS_CODE.test(value.diagnosisCode)
    ? value.diagnosisCode
    : (() => { throw new RecoveryPlanValidationError("diagnosisCode is invalid"); })();
  const summary = boundedString(
    value.summary,
    "summary",
    MAX_RECOVERY_SUMMARY_CHARS,
    MAX_RECOVERY_SUMMARY_BYTES,
  );
  const evidenceRefs = idList(value.evidenceRefs, "evidenceRefs", MAX_RECOVERY_EVIDENCE_REFS);
  const runbookIds = idList(value.runbookIds, "runbookIds", MAX_RECOVERY_RUNBOOK_IDS);
  const probeIds = idList(value.probeIds, "probeIds", MAX_RECOVERY_PROBE_IDS);
  if (
    !Number.isSafeInteger(value.nextEvaluationDelaySeconds)
    || (value.nextEvaluationDelaySeconds as number) < 30
    || (value.nextEvaluationDelaySeconds as number) > 86_400
  ) {
    throw new RecoveryPlanValidationError("nextEvaluationDelaySeconds is invalid");
  }

  if (verdict === "execute" && (runbookIds.length === 0 || probeIds.length === 0)) {
    throw new RecoveryPlanValidationError("execute requires runbooks and post-action probes");
  }
  if ((verdict === "observe" || verdict === "not_actionable") && runbookIds.length !== 0) {
    throw new RecoveryPlanValidationError(`${verdict} cannot request runbooks`);
  }
  if (verdict === "approval_required" && runbookIds.length === 0) {
    throw new RecoveryPlanValidationError("approval_required requires a runbook id");
  }

  if (context) {
    assertKnown(evidenceRefs, context.knownEvidenceRefs, "evidenceRefs");
    assertKnown(runbookIds, context.knownRunbookIds, "runbookIds");
    assertKnown(probeIds, context.knownProbeIds, "probeIds");
  }

  const plan: RecoveryPlan = {
    ...fence,
    verdict,
    diagnosisCode,
    summary,
    evidenceRefs: Object.freeze(evidenceRefs),
    runbookIds: Object.freeze(runbookIds),
    probeIds: Object.freeze(probeIds),
    nextEvaluationDelaySeconds: value.nextEvaluationDelaySeconds as number,
  };
  return Object.freeze(plan);
}

export const RECOVERY_PLAN_TOOL = {
  name: RECOVERY_PLAN_TOOL_NAME,
  label: "Recovery Plan",
  description:
    "Submit the single final recovery decision. The result is validated and terminates this planner session.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      invocationId: { type: "integer", minimum: 1 },
      incidentId: { type: "integer", minimum: 1 },
      generation: { type: "integer", minimum: 1 },
      evidenceHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
      policyRevision: { type: "integer", minimum: 1 },
      verdict: { type: "string", enum: ["observe", "not_actionable", "execute", "approval_required"] },
      diagnosisCode: { type: "string", pattern: "^[a-z][a-z0-9_]{0,63}$" },
      summary: { type: "string", minLength: 1, maxLength: MAX_RECOVERY_SUMMARY_CHARS },
      evidenceRefs: {
        type: "array",
        maxItems: MAX_RECOVERY_EVIDENCE_REFS,
        uniqueItems: true,
        items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      },
      runbookIds: {
        type: "array",
        maxItems: MAX_RECOVERY_RUNBOOK_IDS,
        uniqueItems: true,
        items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      },
      probeIds: {
        type: "array",
        maxItems: MAX_RECOVERY_PROBE_IDS,
        uniqueItems: true,
        items: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
      },
      nextEvaluationDelaySeconds: { type: "integer", minimum: 30, maximum: 86_400 },
    },
    required: [
      "invocationId",
      "incidentId",
      "generation",
      "evidenceHash",
      "policyRevision",
      "verdict",
      "diagnosisCode",
      "summary",
      "evidenceRefs",
      "runbookIds",
      "probeIds",
      "nextEvaluationDelaySeconds",
    ],
  },
} as const;

export interface RecoveryPlanToolState {
  accepted: boolean;
}

export type RecoveryPlanToolExecutionResult =
  | {
      content: Array<{ type: "text"; text: string }>;
      details: { ok: true; plan: Readonly<RecoveryPlan> };
    }
  | {
      content: Array<{ type: "text"; text: string }>;
      details: { ok: false; code: "multiple_results" | "invalid_result" };
      isError: true;
    };

/** Pure execution helper used by the Pi wrapper and focused tests. */
export function executeRecoveryPlanTool(
  params: unknown,
  state: RecoveryPlanToolState,
  shutdown: () => void,
): RecoveryPlanToolExecutionResult {
  if (state.accepted) {
    return {
      content: [{ type: "text", text: "A recovery plan was already submitted." }],
      details: { ok: false, code: "multiple_results" },
      isError: true,
    };
  }
  try {
    const plan = validateRecoveryPlan(params);
    state.accepted = true;
    shutdown();
    return {
      content: [{ type: "text", text: "Recovery plan accepted." }],
      details: { ok: true, plan },
    };
  } catch {
    return {
      content: [{ type: "text", text: "Recovery plan rejected by the strict result contract." }],
      details: { ok: false, code: "invalid_result" },
      isError: true,
    };
  }
}
