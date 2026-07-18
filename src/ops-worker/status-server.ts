import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  isOpsWorkerUnresolvedOrphan,
  type OpsWorkerSupervisor,
} from "./supervisor.js";
import {
  OPS_WORKER_TASK_SCHEMA_VERSION,
  OPS_WORKER_TASK_STATES,
  type OpsWorkerTask,
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

export interface OpsWorkerStatusSnapshot extends OpsWorkerTaskSummary {
  supervisorInstanceId: string;
}

export interface OpsWorkerStatusServerOptions {
  supervisor: OpsWorkerSupervisor;
  host?: string;
  port?: number;
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
): OpsWorkerStatusSnapshot {
  return {
    ...summarizeOpsWorkerTasks(supervisor.listTasks()),
    supervisorInstanceId: supervisor.supervisorInstanceId,
  };
}

function createRequestHandler(
  supervisor: OpsWorkerSupervisor,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
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
        : { ok: true, ...inspectOpsWorkerStatus(supervisor) };
      writeJson(response, 200, value, method !== "HEAD");
    } catch {
      writeJson(response, 503, {
        ok: false,
        service: "minime-ops-worker",
        error: "status unavailable",
      }, method !== "HEAD");
    }
  };
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
  const server = createServer(createRequestHandler(options.supervisor));
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
