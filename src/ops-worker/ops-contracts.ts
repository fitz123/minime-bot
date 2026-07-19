import { createHash } from "node:crypto";
import {
  OPS_AVAILABILITY_DONE_CHECK_NAME,
  OPS_AVAILABILITY_DONE_CHECK_VERSION,
  OPS_AVAILABILITY_INVARIANTS,
  OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
  createOpsAvailabilityDoneCheckRegistry,
  type OpsAvailabilityDoneCheckDependencies,
  type OpsAvailabilityInvariantName,
} from "./availability-checks.js";
import type {
  OpsWorkerAuthorizationVerifier,
  OpsWorkerAuthorizationVerifierRegistry,
  OpsWorkerAuthorizationVerifierResult,
} from "./authorization.js";
import type { OpsWorkerDoneCheckRegistry } from "./done-checks.js";
import {
  isOpsWorkerRegisteredName,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "./types.js";

export const OPS_AVAILABILITY_TEMPLATE_NAME = "ops.availability" as const;
export const OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE =
  "ops.host-availability" as const;
export const OPS_ALERTMANAGER_AUTHORIZATION_VALIDATOR_IDENTITY =
  "ops-alertmanager-authorization" as const;
export const OPS_ALERTMANAGER_AUTHORIZATION_VALIDATOR_VERSION = "1" as const;
export const OPS_AVAILABILITY_RESOURCE_KEY = "host:local" as const;

export interface OpsAlertmanagerAuthorizationSnapshot {
  sourceIdentity: string;
  invariant: OpsAvailabilityInvariantName;
  template: string;
  profile: string;
}

export interface OpsAlertmanagerAuthorizationSnapshotReader {
  read(): unknown | Promise<unknown>;
}

export interface CreateOpsTaskContractsDependencies
  extends OpsAvailabilityDoneCheckDependencies {
  alertmanagerAuthorizationSnapshotReader: OpsAlertmanagerAuthorizationSnapshotReader;
}

export interface OpsTaskContracts {
  taskRegistry: OpsWorkerTaskContractRegistry;
  doneChecks: OpsWorkerDoneCheckRegistry;
  alertmanagerAuthorizationVerifier: OpsWorkerAuthorizationVerifier;
  authorizationVerifiers: OpsWorkerAuthorizationVerifierRegistry;
}

export function assertOpsAlertmanagerIntakeContracts(
  taskRegistry: OpsWorkerTaskContractRegistry,
  doneChecks: OpsWorkerDoneCheckRegistry,
  authorizationVerifiers: OpsWorkerAuthorizationVerifierRegistry | undefined,
): void {
  const template = taskRegistry.templates[OPS_AVAILABILITY_TEMPLATE_NAME];
  if (!template?.sourceKinds.includes("alertmanager")) {
    throw new TypeError(
      "Alertmanager intake requires the fixed ops.availability template for alertmanager",
    );
  }
  const profile = taskRegistry.authorizationProfiles[
    OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE
  ];
  if (
    !profile?.sourceKinds.includes("alertmanager")
    || profile.scope.length !== 2
    || profile.scope[0] !== "inspect"
    || profile.scope[1] !== "local-reversible-repair"
  ) {
    throw new TypeError(
      "Alertmanager intake requires the fixed ops.host-availability authorization profile",
    );
  }
  const doneCheck = doneChecks.describe(OPS_AVAILABILITY_DONE_CHECK_NAME);
  if (
    doneCheck?.verifierIdentity !== OPS_AVAILABILITY_DONE_CHECK_NAME
    || doneCheck.verifierVersion !== OPS_AVAILABILITY_DONE_CHECK_VERSION
  ) {
    throw new TypeError(
      "Alertmanager intake requires the package-owned availability done check",
    );
  }
  const verifier = authorizationVerifiers?.alertmanager;
  if (
    verifier?.identity !== OPS_ALERTMANAGER_AUTHORIZATION_VALIDATOR_IDENTITY
    || verifier.version !== OPS_ALERTMANAGER_AUTHORIZATION_VALIDATOR_VERSION
  ) {
    throw new TypeError(
      "Alertmanager intake requires the package-owned Alertmanager authorization verifier",
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactDataKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  if (
    Object.keys(value).length !== expected.length
    || expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
    || Object.keys(value).some((key) => !expected.includes(key))
  ) return false;
  return expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor;
  });
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

export function hashOpsAlertmanagerAuthorizationSnapshot(
  snapshot: OpsAlertmanagerAuthorizationSnapshot,
): string {
  return hashCanonical({
    sourceKind: "alertmanager",
    sourceIdentity: snapshot.sourceIdentity,
    invariant: snapshot.invariant,
    template: snapshot.template,
    profile: snapshot.profile,
  });
}

function parseTrustedSnapshot(value: unknown): OpsAlertmanagerAuthorizationSnapshot | null {
  if (
    !isPlainObject(value)
    || !hasExactDataKeys(value, ["sourceIdentity", "invariant", "template", "profile"])
    || !isOpsWorkerRegisteredName(value.sourceIdentity)
    || value.invariant !== OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT
    || !isOpsWorkerRegisteredName(value.template)
    || !isOpsWorkerRegisteredName(value.profile)
  ) return null;
  return {
    sourceIdentity: value.sourceIdentity,
    invariant: value.invariant,
    template: value.template,
    profile: value.profile,
  };
}

function sourceIdentityFromKey(value: string): string | null {
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  const identity = value.slice(0, separator);
  return isOpsWorkerRegisteredName(identity) ? identity : null;
}

function claimedSnapshot(task: Readonly<OpsWorkerTask>): OpsAlertmanagerAuthorizationSnapshot | null {
  if (
    task.source.kind !== "alertmanager"
    || task.resource.kind !== "host"
    || task.resource.key !== OPS_AVAILABILITY_RESOURCE_KEY
    || task.priority !== 0
    || task.source.template !== OPS_AVAILABILITY_TEMPLATE_NAME
    || task.doneCheck.name !== OPS_AVAILABILITY_DONE_CHECK_NAME
    || task.authorization.profile !== OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE
    || task.authorization.scope.length !== 2
    || task.authorization.scope[0] !== "inspect"
    || task.authorization.scope[1] !== "local-reversible-repair"
    || task.authorization.snapshotHash === null
    || !isPlainObject(task.doneCheck.params)
    || !hasExactDataKeys(task.doneCheck.params, ["invariant"])
    || task.doneCheck.params.invariant !== OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT
    || task.objective
      !== OPS_AVAILABILITY_INVARIANTS[OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT].objective
  ) return null;
  const correlationIdentity = sourceIdentityFromKey(task.source.correlationKey);
  const deliveryIdentity = sourceIdentityFromKey(task.source.deliveryKey);
  if (correlationIdentity === null || correlationIdentity !== deliveryIdentity) return null;
  return {
    sourceIdentity: correlationIdentity,
    invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
    template: OPS_AVAILABILITY_TEMPLATE_NAME,
    profile: OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
  };
}

function result(
  status: OpsWorkerAuthorizationVerifierResult["status"],
  reason: string,
  task: Readonly<OpsWorkerTask>,
): OpsWorkerAuthorizationVerifierResult {
  const summaries: Record<OpsWorkerAuthorizationVerifierResult["status"], string> = {
    PASS: "Alertmanager authorization matches the current trusted ops contract.",
    DRIFT: "Alertmanager authorization configuration drifted from the submitted claim.",
    QUERY_ERROR: "Alertmanager authorization configuration could not be read safely.",
    INVALID_CLAIM: "Alertmanager authorization claim does not match the closed ops contract.",
  };
  return {
    status,
    evidenceHash: hashCanonical({
      status,
      reason,
      submissionFingerprint: task.submissionFingerprint,
      authorizationSnapshotHash: task.authorization.snapshotHash,
    }),
    summary: summaries[status],
  };
}

function createAlertmanagerAuthorizationVerifier(
  reader: OpsAlertmanagerAuthorizationSnapshotReader,
): OpsWorkerAuthorizationVerifier {
  if (!reader || typeof reader.read !== "function") {
    throw new TypeError("Alertmanager authorization requires a trusted snapshot reader");
  }
  return Object.freeze({
    identity: OPS_ALERTMANAGER_AUTHORIZATION_VALIDATOR_IDENTITY,
    version: OPS_ALERTMANAGER_AUTHORIZATION_VALIDATOR_VERSION,
    async verify(task: Readonly<OpsWorkerTask>): Promise<OpsWorkerAuthorizationVerifierResult> {
      const claimed = claimedSnapshot(task);
      if (claimed === null) {
        return result("INVALID_CLAIM", "closed-task-claim-mismatch", task);
      }
      if (
        task.authorization.snapshotHash
        !== hashOpsAlertmanagerAuthorizationSnapshot(claimed)
      ) return result("INVALID_CLAIM", "snapshot-hash-mismatch", task);

      let configuredRaw: unknown;
      try {
        configuredRaw = await reader.read();
      } catch {
        return result("QUERY_ERROR", "snapshot-reader-failed", task);
      }
      const configured = parseTrustedSnapshot(configuredRaw);
      if (configured === null) {
        return result("QUERY_ERROR", "snapshot-reader-invalid", task);
      }
      if (canonicalJson(configured) !== canonicalJson(claimed)) {
        return result("DRIFT", "configured-snapshot-drift", task);
      }
      return result("PASS", "configured-snapshot-pass", task);
    },
  });
}

export function createOpsTaskContracts(
  deps: CreateOpsTaskContractsDependencies,
): OpsTaskContracts {
  const doneChecks = createOpsAvailabilityDoneCheckRegistry(deps);
  const alertmanagerAuthorizationVerifier = createAlertmanagerAuthorizationVerifier(
    deps.alertmanagerAuthorizationSnapshotReader,
  );
  const taskRegistry: OpsWorkerTaskContractRegistry = Object.freeze({
    templates: Object.freeze({
      [OPS_AVAILABILITY_TEMPLATE_NAME]: Object.freeze({
        sourceKinds: Object.freeze(["alertmanager", "operator-cli"] as const),
      }),
    }),
    authorizationProfiles: Object.freeze({
      [OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE]: Object.freeze({
        sourceKinds: Object.freeze(["alertmanager", "operator-cli"] as const),
        scope: Object.freeze(["inspect", "local-reversible-repair"] as const),
      }),
    }),
    doneChecks: doneChecks.contracts,
  });
  const authorizationVerifiers: OpsWorkerAuthorizationVerifierRegistry = Object.freeze({
    alertmanager: alertmanagerAuthorizationVerifier,
  });
  return Object.freeze({
    taskRegistry,
    doneChecks,
    alertmanagerAuthorizationVerifier,
    authorizationVerifiers,
  });
}
