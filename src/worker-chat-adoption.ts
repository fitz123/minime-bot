import { AgentRuntimeClient } from "./agent-runtime-client.js";
import { AgentRuntimeError, workerChatLaneId, workerRouteDigest, type AgentLaneHandle } from "./agent-runtime-protocol.js";
import {
  fingerprintInteractiveSession,
  inspectInteractiveSessionBinding,
  resolveInteractiveSessionLocation,
} from "./interactive-session-binding.js";
import { SessionStore } from "./session-store.js";
import type { AgentConfig, BoundSessionState, SessionState } from "./types.js";

/** The operator must quiesce controller work for this lane before changing its route. */
export async function changeWorkerChatBinding(
  action: "adopt" | "rollback",
  store: SessionStore,
  chatId: string,
  agent: AgentConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const route = agent.workerRuntime;
  if (!route) throw new Error("The agent requires a configured worker route");
  const routeDigest = workerRouteDigest(route);
  const current = store.getSession(chatId);
  if (current?.agentId !== agent.id) throw new Error("The lane is not bound to the selected agent");

  let local: BoundSessionState;
  let rollbackDigest: string | undefined;
  if (action === "adopt") {
    if (current.bindingState !== "bound" || current.pendingRecoveryNotice) {
      throw new Error("Adoption requires an exact local binding without pending recovery");
    }
    local = current;
  } else {
    if (current.bindingState !== "worker" || !current.adoption || current.adoption.routeDigest !== routeDigest) {
      throw new Error("Rollback requires this lane's original adopted worker route");
    }
    local = current.adoption.local;
    rollbackDigest = current.adoption.digest;
  }

  const fingerprintLocal = (): string => {
    const location = resolveInteractiveSessionLocation(agent, { env, readOnly: true });
    const inspection = inspectInteractiveSessionBinding(location, local.sessionFile, local.sessionId);
    if (location.workspaceRealpath !== local.workspaceRealpath || !inspection.valid) {
      throw new Error("The original exact local transcript is unavailable or unsafe");
    }
    return fingerprintInteractiveSession(inspection.binding);
  };
  const digest = fingerprintLocal();
  if (rollbackDigest !== undefined && digest !== rollbackDigest) {
    throw new Error("The original local transcript changed after adoption");
  }
  const laneId = workerChatLaneId(chatId);
  const client = await AgentRuntimeClient.connect(route.socketPath, undefined, route);
  let ownedHandle: AgentLaneHandle | undefined;
  let committed = false;
  try {
    const opened = action === "adopt"
      ? await client.adopt(laneId, local.sessionId, agent.id, digest)
      : await client.open(laneId, local.sessionId, agent.id);
    const { handle } = opened;
    if (opened.phase !== "ready" || handle.agentId !== agent.id || handle.laneId !== laneId
      || handle.sessionId !== local.sessionId) {
      throw new Error("Worker did not open the exact session identity");
    }
    ownedHandle = handle;
    if (opened.adoptionDigest !== digest) {
      throw new Error("Worker did not verify the exact adopted binding");
    }
    if (opened.request && opened.request.outcome !== "settled") {
      throw new Error("The worker lane has an interrupted request and requires operator inspection");
    }
    if (fingerprintLocal() !== digest) throw new Error("The original local transcript changed during the binding update");

    const replacement: SessionState = action === "adopt"
      ? { bindingState: "worker", agentId: agent.id, chatId, sessionId: local.sessionId,
        lastActivity: local.lastActivity, adoption: { local, digest, routeDigest } }
      : { ...local, workerRollback: true as const };
    // This connection exclusively owns the open worker lane until the controller commits.
    if (!store.compareAndSetSession(chatId, current, replacement)) {
      throw new Error("The selected lane changed concurrently. Inspect its current binding before retrying");
    }
    committed = true;
  } finally {
    try {
      if (ownedHandle) await client.close(ownedHandle);
    } catch {
      if (committed) {
        throw new AgentRuntimeError("cleanup_unconfirmed", "The binding update committed, but worker cleanup could not be confirmed");
      }
    } finally {
      client.disconnect();
    }
  }
}
