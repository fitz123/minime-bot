/** Versioned controller API. No worker-local paths or spawn controls cross this boundary. */
import type { AgentConfig, StreamLine } from './types.js';
import { createHash } from 'node:crypto';

export const AGENT_RUNTIME_MAX_FRAME_BYTES = 1024 * 1024;
export const AGENT_RUNTIME_RPC_TIMEOUT_MS = 15_000;
export const AGENT_RUNTIME_PROMPT_TIMEOUT_MS = 120_000;
export const AGENT_RUNTIME_CLIENT_PROMPT_TIMEOUT_MS = AGENT_RUNTIME_PROMPT_TIMEOUT_MS + 10_000;

export function workerChatLaneId(chatId: string): string {
  return `chat-${createHash('sha256').update(chatId).digest('hex')}`;
}

export function workerRouteDigest(route: NonNullable<AgentConfig['workerRuntime']>): string {
  return createHash('sha256').update(JSON.stringify([route.socketPath, route.workerUid, route.controllerName])).digest('hex');
}

export const WORKER_CHAT_LANE = /^chat-[0-9a-f]{64}$/;
export const WORKER_CRON_LANE = /^cron-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
export const WORKER_TRANSCRIPT_DIGEST = /^[0-9a-f]{64}$/;

export interface AgentLaneHandle {
  agentId: string;
  laneId: string;
  sessionId: string;
  generation: number;
}
export interface AgentRequestOutcome {
  requestId: string;
  outcome: 'accepted' | 'settled' | 'interrupted';
}
export interface AgentLaneState {
  handle: AgentLaneHandle;
  phase: 'opening' | 'ready' | 'prompting' | 'closing' | 'closed';
  request?: AgentRequestOutcome;
  contextDigest?: string;
  adoptionDigest?: string;
}
export type AgentRuntimeOperation =
  | { op: 'open'; laneId: string; expectedSessionId?: string; expectedAgentId?: string; adoptionDigest?: string }
  | { op: 'prompt'; handle: AgentLaneHandle; requestId: string; text: string }
  | { op: 'getState'; handle: AgentLaneHandle }
  | { op: 'abort'; handle: AgentLaneHandle; requestId: string }
  | { op: 'close'; handle: AgentLaneHandle }
  | { op: 'shutdown' };
export type AgentRuntimeRequest = AgentRuntimeOperation & { version: 1; id: string };
export type AgentRuntimeMessage =
  | { version: 1; type: 'response'; id: string; state?: AgentLaneState }
  | { version: 1; type: 'error'; id: string; code: string; message: string }
  | { version: 1; type: 'event'; id: string; requestId: string; event: StreamLine }
  | { version: 1; type: 'finished'; id: string; state: AgentLaneState };

export class AgentRuntimeError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'AgentRuntimeError'; }
}
export class AgentRuntimeUncertainError extends AgentRuntimeError {
  constructor() {
    super('uncertain_outcome', 'Worker connection or deadline lost; request may have been accepted. Inspect state before further work; never resend implicitly.');
  }
}
