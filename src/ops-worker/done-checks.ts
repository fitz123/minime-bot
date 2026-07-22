import { createHash } from "node:crypto";
import {
  aggregateOpsWorkerVerificationOutcome,
  OPS_WORKER_LIMITS,
  OPS_WORKER_VERIFICATION_OUTCOMES,
  type JsonObject,
  type OpsWorkerEvidence,
  type OpsWorkerDoneCheck,
  type OpsWorkerDoneCheckContract,
  type OpsWorkerSourceKind,
  type OpsWorkerVerificationRecord,
  type OpsWorkerVerificationComponentEvidence,
  type OpsWorkerVerificationConvergenceKind,
  type OpsWorkerVerificationOutcome,
} from "./types.js";

export const OPS_WORKER_DONE_CHECK_RESULTS = OPS_WORKER_VERIFICATION_OUTCOMES;

export type OpsWorkerDoneCheckResultKind = OpsWorkerVerificationOutcome;

export interface OpsWorkerDoneCheckResult {
  verifierIdentity: string;
  verifierVersion: string;
  contractHash: string;
  checkedAt: string;
  result: OpsWorkerDoneCheckResultKind;
  summary: string;
  nextCheckAt: string | null;
  components: OpsWorkerVerificationComponentEvidence[];
}

export interface OpsWorkerDoneCheckContractIdentity {
  verifierIdentity: string;
  verifierVersion: string;
  contractHash: string;
}

export interface OpsWorkerDoneCheckContext {
  /** Aborted when a component's registry-enforced timeout expires. */
  signal: AbortSignal;
  taskId: string;
  checkedAt: string;
  sourceKind?: OpsWorkerSourceKind;
  sourceCorrelationKey?: string;
  sourceEvidence?: readonly OpsWorkerEvidence[];
  /** Last durable result for the same validated task subject, when one exists. */
  previousVerification?: Readonly<OpsWorkerVerificationRecord>;
}

export interface OpsWorkerDoneCheckComponentDefinition {
  identity: string;
  version: string;
  required: boolean;
  convergence: OpsWorkerVerificationConvergenceKind;
  /** A trusted, fixed timeout. Task data cannot override it. */
  timeoutMs: number;
  run(
    params: JsonObject,
    context: OpsWorkerDoneCheckContext,
  ): unknown | Promise<unknown>;
}

/**
 * Trusted composite definition. The legacy timeoutMs/run shorthand remains a
 * one-required-component contract so existing package integrations migrate
 * without turning task data into a component selector.
 */
export interface OpsWorkerDoneCheckDefinition extends OpsWorkerDoneCheckContract {
  identity?: string;
  version?: string;
  components?: readonly OpsWorkerDoneCheckComponentDefinition[];
  timeoutMs?: number;
  run?(
    params: JsonObject,
    context: OpsWorkerDoneCheckContext,
  ): unknown | Promise<unknown>;
}

export const OPS_WORKER_DONE_CHECK_LIMITS = {
  maxTimeoutMs: 5 * 60 * 1_000,
  maxOutputBytes: 64 * 1024,
  maxSummaryBytes: OPS_WORKER_LIMITS.maxVerificationComponentSummaryBytes,
  maxComponents: OPS_WORKER_LIMITS.maxVerificationComponents,
} as const;

const REGISTERED_NAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9.-]{0,78}[a-z0-9])?$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export type OpsWorkerDoneCheckErrorCode =
  | "UNKNOWN_CHECK"
  | "INVALID_PARAMS"
  | "TIMEOUT"
  | "INVALID_RESULT"
  | "ABORTED";

export class OpsWorkerDoneCheckExecutionError extends Error {
  readonly code: OpsWorkerDoneCheckErrorCode;

  constructor(code: OpsWorkerDoneCheckErrorCode, message: string) {
    super(message);
    this.name = "OpsWorkerDoneCheckExecutionError";
    this.code = code;
  }
}

interface NormalizedComponent extends OpsWorkerDoneCheckComponentDefinition {
  legacyResult: boolean;
}

interface NormalizedDefinition {
  identity: string;
  version: string;
  contractHash: string;
  validateParams(params: unknown): JsonObject;
  components: readonly NormalizedComponent[];
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hashEvidence(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function expectPlainObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("component result must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("component result must be a plain object");
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
    throw new TypeError("component returned fields outside its closed result contract");
  }
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      throw new TypeError("component returned accessor fields");
    }
  }
}

function parseTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) {
    throw new TypeError(`${label} must be an RFC 3339 UTC timestamp`);
  }
  const canonical = value.length === 20
    ? `${value.slice(0, -1)}.000Z`
    : value;
  let normalized: string;
  try {
    normalized = new Date(value).toISOString();
  } catch {
    throw new TypeError(`${label} must be a real calendar timestamp`);
  }
  if (normalized !== canonical) {
    throw new TypeError(`${label} must be a real calendar timestamp`);
  }
  return value;
}

function parseSummary(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\0")
    || Buffer.byteLength(value, "utf8") > OPS_WORKER_DONE_CHECK_LIMITS.maxSummaryBytes
  ) {
    throw new TypeError(
      `component summary must be 1-${OPS_WORKER_DONE_CHECK_LIMITS.maxSummaryBytes} UTF-8 bytes`,
    );
  }
  return value;
}

function parseComponentResult(
  raw: unknown,
  component: NormalizedComponent,
  checkedAt: string,
): OpsWorkerVerificationComponentEvidence {
  const result = expectPlainObject(raw);
  const suppliedResult = result.result;
  if (
    typeof suppliedResult !== "string"
    || !(OPS_WORKER_DONE_CHECK_RESULTS as readonly string[]).includes(suppliedResult)
  ) {
    throw new TypeError("component returned an unknown closed outcome");
  }
  const outcome = suppliedResult as OpsWorkerVerificationOutcome;
  const hasScheduledRecheck = outcome === "DEFER"
    || (outcome === "NOT_READY" && hasOwn(result, "nextCheckAt"));
  if (component.legacyResult) {
    assertExactKeys(
      result,
      hasScheduledRecheck
        ? ["result", "summary", "nextCheckAt"]
        : ["result", "summary"],
    );
  } else {
    assertExactKeys(
      result,
      hasScheduledRecheck
        ? ["result", "summary", "observedAt", "evidenceHash", "nextCheckAt"]
        : ["result", "summary", "observedAt", "evidenceHash"],
    );
  }
  if (outcome === "DEFER" && component.convergence !== "PASSIVE") {
    throw new TypeError("DEFER is allowed only for passive convergence components");
  }
  const summary = parseSummary(result.summary);
  const observedAt = component.legacyResult
    ? checkedAt
    : parseTimestamp(result.observedAt, "component observedAt");
  if (Date.parse(observedAt) < Date.parse(checkedAt)) {
    throw new TypeError("component observedAt predates this composite query");
  }
  const evidenceHash = component.legacyResult
    ? hashEvidence({ identity: component.identity, outcome, observedAt, summary })
    : result.evidenceHash;
  if (typeof evidenceHash !== "string" || !SHA256_PATTERN.test(evidenceHash)) {
    throw new TypeError("component evidenceHash must be a lowercase sha256 digest");
  }
  let nextCheckAt: string | null = null;
  if (hasScheduledRecheck) {
    nextCheckAt = parseTimestamp(result.nextCheckAt, "component nextCheckAt");
    if (Date.parse(nextCheckAt) <= Date.parse(observedAt)) {
      throw new TypeError("scheduled nextCheckAt must be later than observedAt");
    }
  }
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8")
      > OPS_WORKER_DONE_CHECK_LIMITS.maxOutputBytes
  ) {
    throw new TypeError("component output exceeds its bounded result contract");
  }
  return {
    identity: component.identity,
    version: component.version,
    required: component.required,
    convergence: component.convergence,
    outcome,
    observedAt,
    evidenceHash,
    summary,
    nextCheckAt,
  };
}

function generatedComponentResult(
  component: NormalizedComponent,
  checkedAt: string,
  outcome: Extract<OpsWorkerVerificationOutcome, "VERIFIER_INVALID" | "QUERY_ERROR" | "TIMEOUT">,
  summary: string,
): OpsWorkerVerificationComponentEvidence {
  return {
    identity: component.identity,
    version: component.version,
    required: component.required,
    convergence: component.convergence,
    outcome,
    observedAt: checkedAt,
    evidenceHash: hashEvidence({ identity: component.identity, outcome, checkedAt }),
    summary,
    nextCheckAt: null,
  };
}

async function runComponent(
  component: NormalizedComponent,
  params: JsonObject,
  context: Omit<OpsWorkerDoneCheckContext, "signal">,
  externalSignal?: AbortSignal,
): Promise<OpsWorkerVerificationComponentEvidence> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let removeExternalAbort: (() => void) | undefined;
  const timeout = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("TIMEOUT");
    }, component.timeoutMs);
  });
  const externalAbort = new Promise<never>((_resolve, reject) => {
    if (!externalSignal) return;
    const abort = (): void => {
      controller.abort();
      reject(new OpsWorkerDoneCheckExecutionError(
        "ABORTED",
        `Done check component ${JSON.stringify(component.identity)} was interrupted by worker shutdown`,
      ));
    };
    if (externalSignal.aborted) abort();
    else {
      externalSignal.addEventListener("abort", abort, { once: true });
      removeExternalAbort = () => externalSignal.removeEventListener("abort", abort);
    }
  });
  try {
    const execution = Promise.resolve()
      .then(() => component.run(structuredClone(params), {
        ...context,
        signal: controller.signal,
      }))
      .then((raw) => ({ kind: "RESULT" as const, raw }))
      .catch((error: unknown) => ({ kind: "ERROR" as const, error }));
    const settled = await Promise.race([execution, timeout, externalAbort]);
    if (settled === "TIMEOUT") {
      return generatedComponentResult(
        component,
        context.checkedAt,
        "TIMEOUT",
        "Trusted verifier component exceeded its fixed timeout.",
      );
    }
    if (settled.kind === "ERROR") {
      return generatedComponentResult(
        component,
        context.checkedAt,
        "QUERY_ERROR",
        "Trusted verifier component could not complete its read-only query.",
      );
    }
    try {
      return parseComponentResult(settled.raw, component, context.checkedAt);
    } catch {
      return generatedComponentResult(
        component,
        context.checkedAt,
        "VERIFIER_INVALID",
        "Trusted verifier component returned evidence outside its closed contract.",
      );
    }
  } finally {
    // Component implementations may start more than one read. Abort any
    // sibling work that is still pending after an early result or failure.
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
    removeExternalAbort?.();
  }
}

function normalizeDefinitions(
  definitions: Readonly<Record<string, OpsWorkerDoneCheckDefinition>>,
): Readonly<Record<string, NormalizedDefinition>> {
  const normalized: Record<string, NormalizedDefinition> = Object.create(null) as Record<
    string,
    NormalizedDefinition
  >;
  for (const [name, definition] of Object.entries(definitions)) {
    if (!REGISTERED_NAME_PATTERN.test(name)) {
      throw new TypeError(`Invalid registered done-check name ${JSON.stringify(name)}`);
    }
    const identity = definition.identity ?? name;
    const version = definition.version ?? "1";
    if (!REGISTERED_NAME_PATTERN.test(identity) || !REGISTERED_NAME_PATTERN.test(version)) {
      throw new TypeError(`Done check ${name} identity and version must be registered names`);
    }
    if (typeof definition.validateParams !== "function") {
      throw new TypeError(`Done check ${name} must provide parameter validation`);
    }
    const hasComposite = definition.components !== undefined;
    const hasLegacy = definition.timeoutMs !== undefined || definition.run !== undefined;
    if (hasComposite === hasLegacy) {
      throw new TypeError(
        `Done check ${name} must provide either components or the single-component shorthand`,
      );
    }
    let components: NormalizedComponent[];
    if (hasComposite) {
      if (
        !Array.isArray(definition.components)
        || Object.getPrototypeOf(definition.components) !== Array.prototype
        || definition.components.length < 1
        || definition.components.length > OPS_WORKER_DONE_CHECK_LIMITS.maxComponents
      ) {
        throw new TypeError(
          `Done check ${name} must register 1-${OPS_WORKER_DONE_CHECK_LIMITS.maxComponents} components`,
        );
      }
      components = definition.components.map((component) => ({
        ...component,
        legacyResult: false,
      }));
    } else {
      components = [{
        identity: name,
        version: "1",
        required: true,
        convergence: "PASSIVE",
        timeoutMs: definition.timeoutMs as number,
        run: definition.run as NonNullable<OpsWorkerDoneCheckDefinition["run"]>,
        legacyResult: true,
      }];
    }
    const identities = new Set<string>();
    for (const component of components) {
      if (
        !REGISTERED_NAME_PATTERN.test(component.identity)
        || !REGISTERED_NAME_PATTERN.test(component.version)
      ) {
        throw new TypeError(`Done check ${name} has an invalid component identity or version`);
      }
      if (identities.has(component.identity)) {
        throw new TypeError(`Done check ${name} has duplicate component identity ${component.identity}`);
      }
      identities.add(component.identity);
      if (
        typeof component.required !== "boolean"
        || !(["PRODUCT", "PASSIVE"] as const).includes(component.convergence)
        || !Number.isSafeInteger(component.timeoutMs)
        || component.timeoutMs < 1
        || component.timeoutMs > OPS_WORKER_DONE_CHECK_LIMITS.maxTimeoutMs
        || typeof component.run !== "function"
      ) {
        throw new TypeError(`Done check ${name} has an invalid trusted component definition`);
      }
    }
    if (!components.some((component) => component.required)) {
      throw new TypeError(`Done check ${name} must register at least one required component`);
    }
    const contractHash = hashEvidence({
      identity,
      version,
      components: components.map((component) => ({
        identity: component.identity,
        version: component.version,
        required: component.required,
        convergence: component.convergence,
        timeoutMs: component.timeoutMs,
      })),
    });
    normalized[name] = Object.freeze({
      identity,
      version,
      contractHash,
      validateParams: definition.validateParams,
      components: Object.freeze(components.map((component) => Object.freeze(component))),
    });
  }
  return Object.freeze(normalized);
}

function invalidAggregate(
  contract: OpsWorkerDoneCheckContractIdentity,
  checkedAt: string,
  summary: string,
): OpsWorkerDoneCheckResult {
  return {
    ...contract,
    checkedAt,
    result: "VERIFIER_INVALID",
    summary,
    nextCheckAt: null,
    components: [],
  };
}

export class OpsWorkerDoneCheckRegistry {
  readonly contracts: Readonly<Record<string, OpsWorkerDoneCheckContract>>;

  private readonly definitions: Readonly<Record<string, NormalizedDefinition>>;

  constructor(definitions: Readonly<Record<string, OpsWorkerDoneCheckDefinition>>) {
    this.definitions = normalizeDefinitions(definitions);
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

  describe(name: string): OpsWorkerDoneCheckContractIdentity | undefined {
    const definition = hasOwn(this.definitions, name)
      ? this.definitions[name]
      : undefined;
    return definition === undefined
      ? undefined
      : {
        verifierIdentity: definition.identity,
        verifierVersion: definition.version,
        contractHash: definition.contractHash,
      };
  }

  async run(
    check: OpsWorkerDoneCheck,
    context: Omit<OpsWorkerDoneCheckContext, "signal"> & {
      expectedContract?: OpsWorkerDoneCheckContractIdentity;
      now?: () => Date;
    },
    externalSignal?: AbortSignal,
  ): Promise<OpsWorkerDoneCheckResult> {
    const definition = hasOwn(this.definitions, check.name)
      ? this.definitions[check.name]
      : undefined;
    if (!definition) {
      const fallback = context.expectedContract ?? {
        verifierIdentity: "ops-worker-registry",
        verifierVersion: "1",
        contractHash: hashEvidence({ unknownCheck: check.name }),
      };
      return invalidAggregate(
        fallback,
        context.checkedAt,
        "The persisted done check is not registered in trusted package code.",
      );
    }
    const contract = {
      verifierIdentity: definition.identity,
      verifierVersion: definition.version,
      contractHash: definition.contractHash,
    };
    if (context.expectedContract && (
      context.expectedContract.verifierIdentity !== contract.verifierIdentity
      || context.expectedContract.verifierVersion !== contract.verifierVersion
      || context.expectedContract.contractHash !== contract.contractHash
    )) {
      return invalidAggregate(
        context.expectedContract,
        context.checkedAt,
        "The package verifier contract changed after this task was pinned.",
      );
    }
    let params: JsonObject;
    try {
      params = definition.validateParams(structuredClone(check.params));
    } catch {
      return invalidAggregate(
        contract,
        context.checkedAt,
        "The persisted verifier parameters are invalid for the immutable contract.",
      );
    }
    const queriedComponents = await Promise.all(definition.components.map((component) =>
      runComponent(component, params, context, externalSignal)));
    const completedAt = new Date(Math.max(
      (context.now ?? (() => new Date()))().getTime(),
      Date.parse(context.checkedAt),
    )).toISOString();
    const components = queriedComponents.map((component, index) =>
      Date.parse(component.observedAt) > Date.parse(completedAt)
        || (
          component.nextCheckAt !== null
          && Date.parse(component.nextCheckAt as string) <= Date.parse(completedAt)
        )
        ? generatedComponentResult(
          definition.components[index],
          context.checkedAt,
          "VERIFIER_INVALID",
          "Trusted verifier component returned evidence outside the fresh query interval.",
        )
        : component);
    const result = aggregateOpsWorkerVerificationOutcome(components);
    const decidingComponents = components
      .filter((component) => component.required && component.outcome === result);
    const scheduled = decidingComponents
      .map((component) => component.nextCheckAt)
      .filter((value): value is string => value !== null)
      .sort();
    const deciding = components.find((component) =>
      component.required && component.outcome === result) ?? components[0];
    const summary = `Composite verifier ${definition.identity} returned ${result}: ${components
      .map((component) => `${component.identity}=${component.outcome}`)
      .join(", ")}; ${deciding.summary}`;
    if (Buffer.byteLength(summary, "utf8") > OPS_WORKER_LIMITS.maxVerificationSummaryBytes) {
      return invalidAggregate(
        contract,
        context.checkedAt,
        "The composite verifier summary exceeded its bounded evidence contract.",
      );
    }
    return {
      ...contract,
      checkedAt: context.checkedAt,
      result,
      summary,
      nextCheckAt: result === "DEFER"
        ? scheduled[0] ?? null
        : result === "NOT_READY"
          && decidingComponents.every((component) => component.nextCheckAt !== null)
          ? scheduled[0] ?? null
          : null,
      components,
    };
  }
}

/** This phase intentionally includes no production component registrations. */
export const EMPTY_OPS_WORKER_DONE_CHECK_REGISTRY =
  new OpsWorkerDoneCheckRegistry({});
