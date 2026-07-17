import {
  OPS_WORKER_LIMITS,
  type JsonObject,
  type OpsWorkerDoneCheck,
  type OpsWorkerDoneCheckContract,
} from "./types.js";

export const OPS_WORKER_DONE_CHECK_RESULTS = [
  "PASS",
  "ACTION_REQUIRED",
  "DEFER",
] as const;

export type OpsWorkerDoneCheckResultKind =
  (typeof OPS_WORKER_DONE_CHECK_RESULTS)[number];

export interface OpsWorkerDoneCheckPassResult {
  result: "PASS";
  summary: string;
}

export interface OpsWorkerDoneCheckActionRequiredResult {
  result: "ACTION_REQUIRED";
  summary: string;
}

export interface OpsWorkerDoneCheckDeferResult {
  result: "DEFER";
  summary: string;
  nextCheckAt: string;
}

export type OpsWorkerDoneCheckResult =
  | OpsWorkerDoneCheckPassResult
  | OpsWorkerDoneCheckActionRequiredResult
  | OpsWorkerDoneCheckDeferResult;

export interface OpsWorkerDoneCheckContext {
  /** Aborted when the registry-enforced timeout expires. */
  signal: AbortSignal;
  taskId: string;
  checkedAt: string;
}

export interface OpsWorkerDoneCheckDefinition
  extends OpsWorkerDoneCheckContract {
  /** A trusted, fixed timeout. Task data cannot override it. */
  timeoutMs: number;
  run(
    params: JsonObject,
    context: OpsWorkerDoneCheckContext,
  ): unknown | Promise<unknown>;
}

export const OPS_WORKER_DONE_CHECK_LIMITS = {
  maxTimeoutMs: 5 * 60 * 1_000,
  maxOutputBytes: OPS_WORKER_LIMITS.maxEvidenceSummaryBytes + 512,
  maxSummaryBytes: OPS_WORKER_LIMITS.maxEvidenceSummaryBytes,
} as const;

const REGISTERED_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export type OpsWorkerDoneCheckErrorCode =
  | "UNKNOWN_CHECK"
  | "INVALID_PARAMS"
  | "TIMEOUT"
  | "EXECUTION_ERROR"
  | "INVALID_RESULT";

export class OpsWorkerDoneCheckExecutionError extends Error {
  readonly code: OpsWorkerDoneCheckErrorCode;

  constructor(code: OpsWorkerDoneCheckErrorCode, message: string) {
    super(message);
    this.name = "OpsWorkerDoneCheckExecutionError";
    this.code = code;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function expectPlainObject(
  value: unknown,
  errorMessage: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpsWorkerDoneCheckExecutionError("INVALID_RESULT", errorMessage);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OpsWorkerDoneCheckExecutionError("INVALID_RESULT", errorMessage);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const allowed = new Set(expected);
  if (
    Object.keys(value).length !== expected.length
    || Object.keys(value).some((key) => !allowed.has(key))
    || expected.some((key) => !hasOwn(value, key))
  ) {
    throw new OpsWorkerDoneCheckExecutionError(
      "INVALID_RESULT",
      "Done check returned fields outside its closed result contract",
    );
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new OpsWorkerDoneCheckExecutionError(
        "INVALID_RESULT",
        "Done check returned accessor fields",
      );
    }
  }
}

function parseTimestamp(value: unknown): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new OpsWorkerDoneCheckExecutionError(
      "INVALID_RESULT",
      "DEFER must provide an RFC 3339 UTC nextCheckAt timestamp",
    );
  }
  const canonical = value.length === 20
    ? `${value.slice(0, -1)}.000Z`
    : value;
  let normalized: string;
  try {
    normalized = new Date(value).toISOString();
  } catch {
    throw new OpsWorkerDoneCheckExecutionError(
      "INVALID_RESULT",
      "DEFER must provide a real nextCheckAt timestamp",
    );
  }
  if (normalized !== canonical) {
    throw new OpsWorkerDoneCheckExecutionError(
      "INVALID_RESULT",
      "DEFER must provide a real nextCheckAt timestamp",
    );
  }
  return value;
}

function parseResult(value: unknown, checkedAt: string): OpsWorkerDoneCheckResult {
  const result = expectPlainObject(
    value,
    "Done check must return a plain result object",
  );
  if (
    typeof result.result !== "string"
    || !(OPS_WORKER_DONE_CHECK_RESULTS as readonly string[]).includes(result.result)
  ) {
    throw new OpsWorkerDoneCheckExecutionError(
      "INVALID_RESULT",
      "Done check returned an unknown tri-state result",
    );
  }
  const resultKind = result.result as OpsWorkerDoneCheckResultKind;
  assertExactKeys(
    result,
    resultKind === "DEFER"
      ? ["result", "summary", "nextCheckAt"]
      : ["result", "summary"],
  );
  if (
    typeof result.summary !== "string"
    || result.summary.length === 0
    || result.summary.includes("\0")
    || Buffer.byteLength(result.summary, "utf8")
      > OPS_WORKER_DONE_CHECK_LIMITS.maxSummaryBytes
  ) {
    throw new OpsWorkerDoneCheckExecutionError(
      "INVALID_RESULT",
      `Done check summary must be 1-${OPS_WORKER_DONE_CHECK_LIMITS.maxSummaryBytes} UTF-8 bytes`,
    );
  }
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8")
      > OPS_WORKER_DONE_CHECK_LIMITS.maxOutputBytes
  ) {
    throw new OpsWorkerDoneCheckExecutionError(
      "INVALID_RESULT",
      `Done check output exceeds ${OPS_WORKER_DONE_CHECK_LIMITS.maxOutputBytes} UTF-8 bytes`,
    );
  }
  if (resultKind === "DEFER") {
    const nextCheckAt = parseTimestamp(result.nextCheckAt);
    if (Date.parse(nextCheckAt) <= Date.parse(checkedAt)) {
      throw new OpsWorkerDoneCheckExecutionError(
        "INVALID_RESULT",
        "DEFER nextCheckAt must be later than the current check",
      );
    }
    return { result: resultKind, summary: result.summary, nextCheckAt };
  }
  return { result: resultKind, summary: result.summary };
}

function freezeDefinitions(
  definitions: Readonly<Record<string, OpsWorkerDoneCheckDefinition>>,
): Readonly<Record<string, OpsWorkerDoneCheckDefinition>> {
  const copy: Record<string, OpsWorkerDoneCheckDefinition> = Object.create(null) as Record<
    string,
    OpsWorkerDoneCheckDefinition
  >;
  for (const [name, definition] of Object.entries(definitions)) {
    if (!REGISTERED_NAME_PATTERN.test(name)) {
      throw new TypeError(`Invalid registered done-check name ${JSON.stringify(name)}`);
    }
    if (
      !Number.isSafeInteger(definition.timeoutMs)
      || definition.timeoutMs < 1
      || definition.timeoutMs > OPS_WORKER_DONE_CHECK_LIMITS.maxTimeoutMs
    ) {
      throw new TypeError(
        `Done check ${name} timeout must be an integer between 1 and ${OPS_WORKER_DONE_CHECK_LIMITS.maxTimeoutMs}`,
      );
    }
    if (
      typeof definition.validateParams !== "function"
      || typeof definition.run !== "function"
    ) {
      throw new TypeError(`Done check ${name} must provide validation and execution functions`);
    }
    copy[name] = Object.freeze({ ...definition });
  }
  return Object.freeze(copy);
}

export class OpsWorkerDoneCheckRegistry {
  readonly contracts: Readonly<Record<string, OpsWorkerDoneCheckContract>>;

  private readonly definitions: Readonly<
    Record<string, OpsWorkerDoneCheckDefinition>
  >;

  constructor(
    definitions: Readonly<Record<string, OpsWorkerDoneCheckDefinition>>,
  ) {
    this.definitions = freezeDefinitions(definitions);
    const contracts: Record<string, OpsWorkerDoneCheckContract> = Object.create(null) as Record<
      string,
      OpsWorkerDoneCheckContract
    >;
    for (const [name, definition] of Object.entries(this.definitions)) {
      contracts[name] = Object.freeze({
        validateParams: definition.validateParams,
      });
    }
    this.contracts = Object.freeze(contracts);
  }

  async run(
    check: OpsWorkerDoneCheck,
    context: Omit<OpsWorkerDoneCheckContext, "signal">,
  ): Promise<OpsWorkerDoneCheckResult> {
    const definition = hasOwn(this.definitions, check.name)
      ? this.definitions[check.name]
      : undefined;
    if (!definition) {
      throw new OpsWorkerDoneCheckExecutionError(
        "UNKNOWN_CHECK",
        `Done check ${JSON.stringify(check.name)} is not registered`,
      );
    }

    let params: JsonObject;
    try {
      params = definition.validateParams(structuredClone(check.params));
    } catch {
      throw new OpsWorkerDoneCheckExecutionError(
        "INVALID_PARAMS",
        `Done check ${JSON.stringify(check.name)} rejected its persisted parameters`,
      );
    }

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new OpsWorkerDoneCheckExecutionError(
          "TIMEOUT",
          `Done check ${JSON.stringify(check.name)} exceeded its trusted timeout`,
        ));
      }, definition.timeoutMs);
    });
    let rawResult: unknown;
    try {
      const execution = Promise.resolve().then(() =>
        definition.run(structuredClone(params), {
          ...context,
          signal: controller.signal,
        }));
      rawResult = await Promise.race([execution, timeout]);
    } catch (error) {
      if (error instanceof OpsWorkerDoneCheckExecutionError) throw error;
      throw new OpsWorkerDoneCheckExecutionError(
        "EXECUTION_ERROR",
        `Done check ${JSON.stringify(check.name)} failed during execution`,
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return parseResult(rawResult, context.checkedAt);
  }
}

/** PR 1 intentionally includes no production check implementations. */
export const EMPTY_OPS_WORKER_DONE_CHECK_REGISTRY =
  new OpsWorkerDoneCheckRegistry({});
