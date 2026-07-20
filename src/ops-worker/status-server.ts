import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { OpsWorkerAuthorizationVerifierRegistry } from "./authorization.js";
import {
  OPS_ALERTMANAGER_INTAKE_LIMITS,
  OpsWorkerAlertmanagerIntakeError,
  type OpsWorkerAlertmanagerIntake,
} from "./alertmanager-intake.js";
import type { OpsWorkerDoneCheckRegistry } from "./done-checks.js";
import {
  OPS_WORKER_QUOTA_POLICY_VERSION,
  type OpsWorkerQuotaAdmissionDecision,
  type OpsWorkerQuotaAdmissionGate,
} from "./quota.js";
import {
  validatePiPrimaryResourceContract,
  type PiPrimaryResourceContract,
} from "../pi-primary-resources.js";
import {
  isOpsWorkerUnresolvedOrphan,
  type OpsWorkerSupervisor,
} from "./supervisor.js";
import {
  OPS_WORKER_SOURCE_KINDS,
  OPS_WORKER_TASK_SCHEMA_VERSION,
  OPS_WORKER_TASK_STATES,
  isOpsWorkerRegisteredName,
  type OpsWorkerTask,
  type OpsWorkerSourceKind,
  type OpsWorkerTaskState,
} from "./types.js";

export const DEFAULT_OPS_WORKER_STATUS_HOST = "127.0.0.1";
export const DEFAULT_OPS_WORKER_STATUS_PORT = 9465;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);

export interface OpsWorkerTaskSummary {
  service: "minime-ops-worker";
  schemaVersion: typeof OPS_WORKER_TASK_SCHEMA_VERSION;
  totalTasks: number;
  activeProcessGroups: number;
  custodyOwner: { id: string; state: OpsWorkerTaskState } | null;
  states: Record<OpsWorkerTaskState, number>;
}

export interface OpsWorkerPolicySnapshot {
  authorization: {
    configuredSources: string[];
    verifierCount: number;
    contractsHash: string;
    contracts: Array<{
      source: string;
      verifierIdentity: string;
      verifierVersion: string;
    }>;
  };
  verification: {
    verifierCount: number;
    contractsHash: string;
    contracts: Array<{
      name: string;
      verifierIdentity: string;
      verifierVersion: string;
      contractHash: string;
    }>;
  };
  quota: {
    configured: false;
  } | ({ configured: true } & Omit<OpsWorkerQuotaAdmissionDecision, "summary">);
  parity: {
    configured: false;
  } | {
    configured: true;
    version: number;
    resourcesDigest: string;
    extensionsDigest: string;
    skillsDigest: string;
    toolsDigest: string;
  };
}

export interface OpsWorkerPolicyDependencies {
  authorizationVerifiers?: OpsWorkerAuthorizationVerifierRegistry;
  doneChecks: OpsWorkerDoneCheckRegistry;
  quotaAdmission?: OpsWorkerQuotaAdmissionGate;
  primaryPiResources?: PiPrimaryResourceContract;
}

export interface OpsWorkerStatusSnapshot extends OpsWorkerTaskSummary {
  supervisorInstanceId: string;
  policy: OpsWorkerPolicySnapshot;
}

export interface OpsWorkerStatusServerOptions {
  supervisor: OpsWorkerSupervisor;
  inspectPolicy: () => OpsWorkerPolicySnapshot;
  host?: string;
  port?: number;
  alertmanagerIntake?: {
    intake: OpsWorkerAlertmanagerIntake;
    bearerTokenProvider: () => string;
  };
}

export interface StartedOpsWorkerStatusServer {
  host: string;
  port: number;
  close(): Promise<void>;
}

function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new TypeError("Ops-worker status server must bind to 127.0.0.1 or ::1");
  }
}

function assertPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Ops-worker status server port must be an integer between 0 and 65535");
  }
}

function isLoopbackRemoteAddress(address: string | undefined): boolean {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const QUOTA_REASONS = new Set([
  "HEADROOM",
  "MISSING",
  "READ_ERROR",
  "INVALID",
  "STALE",
  "CONTRADICTORY",
  "DURATIONLESS",
  "RESETLESS",
  "LOW_REMAINING",
  "PACE_EXCEEDED",
]);

function policyHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function assertRegisteredName(value: unknown, label: string): asserts value is string {
  if (!isOpsWorkerRegisteredName(value)) {
    throw new TypeError(`${label} is not a registered name`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string"
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) throw new TypeError(`${label} must be a canonical UTC timestamp`);
}

function inspectQuotaPolicy(
  admission: OpsWorkerQuotaAdmissionGate | undefined,
): OpsWorkerPolicySnapshot["quota"] {
  if (!admission) return { configured: false };
  const decision = admission.check();
  if (
    decision.version !== OPS_WORKER_QUOTA_POLICY_VERSION
    || !["ADMITTED", "NOT_ADMITTED"].includes(decision.status)
    || !QUOTA_REASONS.has(decision.reason)
    || !Array.isArray(decision.activeWindows)
    || decision.activeWindows.length > 2
    || new Set(decision.activeWindows).size !== decision.activeWindows.length
    || decision.activeWindows.some((name) => name !== "5h" && name !== "week")
    || !SHA256_PATTERN.test(decision.evidenceHash)
  ) throw new TypeError("Quota admission returned invalid bounded status evidence");
  assertTimestamp(decision.observedAt, "quota observedAt");
  if (decision.sampledAt !== null) assertTimestamp(decision.sampledAt, "quota sampledAt");
  if (decision.nextResetAt !== null) assertTimestamp(decision.nextResetAt, "quota nextResetAt");
  if (decision.nextProbeAt !== null) assertTimestamp(decision.nextProbeAt, "quota nextProbeAt");
  const { summary: _summary, ...bounded } = decision;
  return { configured: true, ...bounded };
}

export function inspectOpsWorkerPolicy(
  dependencies: OpsWorkerPolicyDependencies,
): OpsWorkerPolicySnapshot {
  const verifiers: OpsWorkerAuthorizationVerifierRegistry =
    dependencies.authorizationVerifiers ?? Object.freeze({});
  const configuredSources = Object.keys(verifiers).sort();
  if (
    configuredSources.length > OPS_WORKER_SOURCE_KINDS.length
    || configuredSources.some((source) =>
      !(OPS_WORKER_SOURCE_KINDS as readonly string[]).includes(source))
  ) throw new TypeError("Authorization verifier registry contains an unknown source kind");
  const authorizationContracts = configuredSources.map((source) => {
    const verifier = verifiers[source as OpsWorkerSourceKind];
    if (!verifier) throw new TypeError("Authorization verifier registry is sparse");
    assertRegisteredName(verifier.identity, "authorization verifier identity");
    assertRegisteredName(verifier.version, "authorization verifier version");
    return {
      source,
      verifierIdentity: verifier.identity,
      verifierVersion: verifier.version,
    };
  });

  const checkNames = Object.keys(dependencies.doneChecks.contracts).sort();
  if (checkNames.length > 64) {
    throw new TypeError("Ops-worker status supports at most 64 verifier contracts");
  }
  const verificationContracts = checkNames.map((name) => {
    const contract = dependencies.doneChecks.describe(name);
    if (!contract || !SHA256_PATTERN.test(contract.contractHash)) {
      throw new TypeError("Done-check registry returned an invalid contract identity");
    }
    assertRegisteredName(contract.verifierIdentity, "done-check verifier identity");
    assertRegisteredName(contract.verifierVersion, "done-check verifier version");
    return { name, ...contract };
  });

  const resources = dependencies.primaryPiResources === undefined
    ? undefined
    : validatePiPrimaryResourceContract(dependencies.primaryPiResources);
  return {
    authorization: {
      configuredSources,
      verifierCount: authorizationContracts.length,
      contractsHash: policyHash(authorizationContracts),
      contracts: authorizationContracts,
    },
    verification: {
      verifierCount: verificationContracts.length,
      contractsHash: policyHash(verificationContracts),
      contracts: verificationContracts,
    },
    quota: inspectQuotaPolicy(dependencies.quotaAdmission),
    parity: resources === undefined
      ? { configured: false }
      : {
          configured: true,
          version: resources.version,
          resourcesDigest: resources.digest,
          extensionsDigest: resources.extensionsDigest,
          skillsDigest: resources.skillsDigest,
          toolsDigest: resources.toolsDigest,
        },
  };
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  includeBody = true,
): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body, "utf8"),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(includeBody ? body : undefined);
}

function writeIntakeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  writeJson(response, statusCode, {
    ok: false,
    error: { code, message },
  });
}

function bearerTokenMatches(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (
    expectedToken.length === 0
    || expectedToken.includes("\0")
    || /\s/.test(expectedToken)
    || Buffer.byteLength(expectedToken, "utf8") > 4 * 1024
  ) throw new TypeError("Alertmanager bearer token provider returned an invalid secret");
  const matched = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
  const suppliedToken = matched?.[1] ?? "";
  const expectedHash = createHash("sha256").update(expectedToken).digest();
  const suppliedHash = createHash("sha256").update(suppliedToken).digest();
  return matched !== null && timingSafeEqual(expectedHash, suppliedHash);
}

async function readAlertmanagerBody(request: IncomingMessage): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      request.resume();
      throw new OpsWorkerAlertmanagerIntakeError(
        "INVALID_PAYLOAD",
        "Alertmanager intake content-length is invalid",
      );
    }
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes)
      || declaredBytes > OPS_ALERTMANAGER_INTAKE_LIMITS.maxBodyBytes
    ) {
      request.resume();
      throw new OpsWorkerAlertmanagerIntakeError(
        "BODY_TOO_LARGE",
        `Alertmanager intake body exceeds ${OPS_ALERTMANAGER_INTAKE_LIMITS.maxBodyBytes} bytes`,
      );
    }
  }
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    totalBytes += chunk.byteLength;
    if (totalBytes > OPS_ALERTMANAGER_INTAKE_LIMITS.maxBodyBytes) {
      throw new OpsWorkerAlertmanagerIntakeError(
        "BODY_TOO_LARGE",
        `Alertmanager intake body exceeds ${OPS_ALERTMANAGER_INTAKE_LIMITS.maxBodyBytes} bytes`,
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, totalBytes);
}

export function summarizeOpsWorkerTasks(
  tasks: readonly OpsWorkerTask[],
): OpsWorkerTaskSummary {
  const states = Object.fromEntries(
    OPS_WORKER_TASK_STATES.map((state) => [state, 0]),
  ) as Record<OpsWorkerTaskState, number>;
  for (const task of tasks) states[task.state] += 1;
  const custodyOwners = tasks.filter((task) => task.custody.status === "HELD");
  if (custodyOwners.length > 1) {
    throw new Error("Ops-worker status found multiple held custody owners");
  }
  return {
    service: "minime-ops-worker",
    schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
    totalTasks: tasks.length,
    activeProcessGroups: tasks.filter((task) =>
      task.state === "RUNNING" || isOpsWorkerUnresolvedOrphan(task)).length,
    custodyOwner: custodyOwners[0]
      ? { id: custodyOwners[0].id, state: custodyOwners[0].state }
      : null,
    states,
  };
}

export function inspectOpsWorkerStatus(
  supervisor: OpsWorkerSupervisor,
  policy: OpsWorkerPolicySnapshot,
): OpsWorkerStatusSnapshot {
  return {
    ...summarizeOpsWorkerTasks(supervisor.listTasks()),
    supervisorInstanceId: supervisor.supervisorInstanceId,
    policy,
  };
}

function createRequestHandler(
  supervisor: OpsWorkerSupervisor,
  inspectPolicy: () => OpsWorkerPolicySnapshot,
  alertmanagerIntake: OpsWorkerStatusServerOptions["alertmanagerIntake"],
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        writeIntakeError(
          response,
          503,
          "INTAKE_UNAVAILABLE",
          "Alertmanager intake is unavailable",
        );
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  };

  async function handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!isLoopbackRemoteAddress(request.socket.remoteAddress)) {
      writeJson(response, 403, { ok: false, error: "loopback only" });
      return;
    }
    const method = request.method ?? "GET";
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      writeJson(response, 400, { ok: false, error: "invalid request target" });
      return;
    }
    if (path === "/intake/alertmanager") {
      if (alertmanagerIntake === undefined) {
        request.resume();
        writeJson(response, 404, { ok: false, error: "not found" });
        return;
      }
      if (method !== "POST") {
        request.resume();
        response.setHeader("allow", "POST");
        writeIntakeError(
          response,
          405,
          "METHOD_NOT_ALLOWED",
          "Alertmanager intake accepts POST only",
        );
        return;
      }
      let authorized: boolean;
      try {
        authorized = bearerTokenMatches(
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined,
          alertmanagerIntake.bearerTokenProvider(),
        );
      } catch {
        request.resume();
        writeIntakeError(
          response,
          503,
          "INTAKE_UNAVAILABLE",
          "Alertmanager intake authentication is unavailable",
        );
        return;
      }
      if (!authorized) {
        request.resume();
        response.setHeader("www-authenticate", "Bearer");
        writeIntakeError(
          response,
          401,
          "UNAUTHORIZED",
          "Alertmanager intake authentication failed",
        );
        return;
      }
      try {
        const body = await readAlertmanagerBody(request);
        const result = alertmanagerIntake.intake.submit(
          body,
          typeof request.headers["content-type"] === "string"
            ? request.headers["content-type"]
            : undefined,
        );
        writeJson(response, 200, result);
      } catch (error) {
        if (error instanceof OpsWorkerAlertmanagerIntakeError) {
          writeIntakeError(
            response,
            error.code === "BODY_TOO_LARGE" ? 413 : 400,
            error.code,
            error.message,
          );
          return;
        }
        writeIntakeError(
          response,
          503,
          "INTAKE_UNAVAILABLE",
          "Alertmanager intake could not submit the task safely",
        );
      }
      return;
    }
    const knownPath = path === "/healthz" || path === "/status";
    if (knownPath && method !== "GET" && method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      writeJson(response, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (!knownPath) {
      writeJson(response, 404, { ok: false, error: "not found" });
      return;
    }
    try {
      const value = path === "/healthz"
        ? {
            ok: true,
            service: "minime-ops-worker",
            schemaVersion: OPS_WORKER_TASK_SCHEMA_VERSION,
          }
        : { ok: true, ...inspectOpsWorkerStatus(supervisor, inspectPolicy()) };
      writeJson(response, 200, value, method !== "HEAD");
    } catch {
      writeJson(response, 503, {
        ok: false,
        service: "minime-ops-worker",
        error: "status unavailable",
      }, method !== "HEAD");
    }
  }
}

function listen(server: Server, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        rejectListen(new Error("Ops-worker status server returned an invalid address"));
        return;
      }
      resolveListen(address);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

export async function startOpsWorkerStatusServer(
  options: OpsWorkerStatusServerOptions,
): Promise<StartedOpsWorkerStatusServer> {
  const host = options.host ?? DEFAULT_OPS_WORKER_STATUS_HOST;
  const port = options.port ?? DEFAULT_OPS_WORKER_STATUS_PORT;
  assertLoopbackHost(host);
  assertPort(port);
  const server = createServer(createRequestHandler(
    options.supervisor,
    options.inspectPolicy,
    options.alertmanagerIntake,
  ));
  const address = await listen(server, host, port);
  let closed = false;
  return {
    host,
    port: address.port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await close(server);
    },
  };
}
