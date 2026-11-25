import { createConnection, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { NewlineOnlyJsonlSplitter } from './pi-rpc-protocol.js';
import type { AgentConfig, StreamLine } from './types.js';
import {
  MAX_ASK_AGENT_ANSWER_BYTES, MAX_ASK_AGENT_ANSWER_CHARS, normalizeAskAgentQuestion, type AskAgentStructuredResult,
} from './pi-extensions/ask-agent-result.js';
import { verifyAgentRuntimeEndpoint, type AgentRuntimeEndpointIdentity } from './agent-runtime-descriptor.js';
import {
  AGENT_RUNTIME_MAX_FRAME_BYTES, AGENT_RUNTIME_RPC_TIMEOUT_MS, AGENT_RUNTIME_CLIENT_PROMPT_TIMEOUT_MS,
  AgentRuntimeError, AgentRuntimeUncertainError, AgentRuntimeConsultationError, type ConsultationErrorCode,
  type AgentLaneHandle, type AgentLaneState, type AgentRuntimeMessage, type AgentRuntimeOperation,
} from './agent-runtime-protocol.js';

/** A fresh connection with a content-free preflight followed by at most one question. */
export async function consultAgentRuntime(
  route: NonNullable<AgentConfig['workerRuntime']>, agentId: string, question: string, signal?: AbortSignal,
): Promise<AskAgentStructuredResult> {
  const unavailable = () => new AgentRuntimeConsultationError('consultation_unavailable');
  if (route.inboundConsultation !== true || !/^[a-zA-Z0-9_-]{1,80}$/.test(agentId) || !normalizeAskAgentQuestion(question)) {
    throw unavailable();
  }
  if (signal?.aborted) throw new AgentRuntimeConsultationError('cancelled');
  try { verifyAgentRuntimeEndpoint(route.socketPath, route); }
  catch { throw unavailable(); }

  const socket = createConnection(route.socketPath);
  const id = randomUUID();
  const splitter = new NewlineOnlyJsonlSplitter(AGENT_RUNTIME_MAX_FRAME_BYTES);
  let sent = false;
  try {
    return await new Promise<AskAgentStructuredResult>((resolve, reject) => {
      const lost = () => reject(sent ? new AgentRuntimeConsultationError('uncertain_outcome') : unavailable());
      const cancel = () => sent ? lost() : reject(new AgentRuntimeConsultationError('cancelled'));
      let deadline = setTimeout(lost, AGENT_RUNTIME_RPC_TIMEOUT_MS);
      const write = (request: AgentRuntimeOperation) => socket.write(JSON.stringify({ version: 1, id, ...request }) + '\n');
      const cleanup = () => {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', cancel);
      };
      socket.once('close', () => { cleanup(); lost(); });
      socket.once('end', lost);
      socket.on('error', lost);
      socket.once('connect', () => {
        if (!signal?.aborted) write({ op: 'consult_check', expectedAgentId: agentId });
      });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      socket.on('data', (chunk: Buffer) => {
        try {
          const records = splitter.push(chunk);
          if (!records.length) return;
          if (records.length !== 1 || splitter.hasPendingRecord()) return lost();
          const reply = JSON.parse(records[0]) as AgentRuntimeMessage;
          if (reply.version !== 1 || reply.id !== id) return lost();
          if (reply.type === 'error') {
            const codes: readonly ConsultationErrorCode[] = sent
              ? ['agent_mismatch', 'consultation_disabled', 'consultation_busy', 'consultation_timeout',
                'consultation_failed', 'consultation_cleanup_failed']
              : ['agent_mismatch', 'consultation_disabled'];
            const code = codes.find(code => code === reply.code);
            return code ? reject(new AgentRuntimeConsultationError(code)) : lost();
          }
          if (!sent && reply.type === 'consult_ready') {
            if (reply.agentId !== agentId) return reject(new AgentRuntimeConsultationError('agent_mismatch'));
            if (reply.inboundConsultation !== true || signal?.aborted) return lost();
            clearTimeout(deadline);
            deadline = setTimeout(lost, AGENT_RUNTIME_CLIENT_PROMPT_TIMEOUT_MS);
            sent = true;
            write({ op: 'consult', question });
            return;
          }
          if (sent && reply.type === 'consult_result') {
            const result = reply.result;
            if (typeof result?.answer === 'string' && result.answer.trim()
              && result.answer.length <= MAX_ASK_AGENT_ANSWER_CHARS && Buffer.byteLength(result.answer) <= MAX_ASK_AGENT_ANSWER_BYTES
              && typeof result.truncated === 'boolean' && typeof result.needsClarification === 'boolean') {
              return resolve({ answer: result.answer, truncated: result.truncated, needsClarification: result.needsClarification });
            }
          }
          lost();
        } catch { lost(); }
      });
    });
  } finally { socket.destroy(); }
}

interface Pending {
  prompt: boolean;
  accepted(state: AgentLaneState | undefined): void;
  finished(state: AgentLaneState | undefined): void;
  reject(error: unknown): void;
  event?(event: StreamLine): void;
  timer: ReturnType<typeof setTimeout>;
}
export interface AgentRuntimePrompt {
  accepted: Promise<AgentLaneState>;
  completed: Promise<AgentLaneState>;
}
/** Explicit socket client. Disconnect/deadline interrupts every owned lane; no reconnect/resend. */
export class AgentRuntimeClient {
  private readonly pending = new Map<string, Pending>();
  private ended = false;
  private constructor(private readonly socket: Socket, private readonly timeoutMs: number) {
    const splitter = new NewlineOnlyJsonlSplitter(AGENT_RUNTIME_MAX_FRAME_BYTES);
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const record of splitter.push(chunk)) {
          const message = JSON.parse(record) as AgentRuntimeMessage;
          if (message.version !== 1 || typeof message.id !== 'string') throw new Error('Invalid worker reply');
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          if (message.type === 'error') {
            pending.reject(new AgentRuntimeError(message.code, message.message));
            this.finish(message.id);
          } else if (message.type === 'response') {
            pending.accepted(message.state);
            if (!pending.prompt) { pending.finished(message.state); this.finish(message.id); }
          } else if (message.type === 'event') {
            try { pending.event?.(message.event); }
            catch (error) { pending.reject(error); this.finish(message.id); }
          } else if (message.type === 'finished') { pending.finished(message.state); this.finish(message.id); }
          else throw new Error('Invalid worker reply');
        }
      } catch { this.disconnect(); }
    });
    socket.on('error', () => this.disconnect());
    socket.on('close', () => this.disconnect());
    socket.on('end', () => this.disconnect());
  }

  /** Same-UID by default. Cross-UID callers must supply expected worker UID/controller name. */
  static async connect(socketPath: string, timeoutMs = AGENT_RUNTIME_RPC_TIMEOUT_MS,
    expected: AgentRuntimeEndpointIdentity = { workerUid: process.getuid!() }): Promise<AgentRuntimeClient> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Invalid client timeout');
    verifyAgentRuntimeEndpoint(socketPath, expected);
    const socket = createConnection(socketPath);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new AgentRuntimeError('connect_timeout', 'Worker connection deadline exceeded')); }, timeoutMs);
        const connected = () => { clearTimeout(timer); socket.off('error', failed); resolve(); };
        const failed = () => { clearTimeout(timer); socket.off('connect', connected); reject(new AgentRuntimeError('connect_failed', 'Worker connection failed')); };
        socket.once('connect', connected); socket.once('error', failed);
      });
      return new AgentRuntimeClient(socket, timeoutMs);
    } catch (error) { socket.destroy(); throw error; }
  }

  open(laneId: string, expectedSessionId?: string, expectedAgentId?: string): Promise<AgentLaneState> {
    if (expectedSessionId !== undefined && !expectedSessionId.trim()) throw new AgentRuntimeError('invalid_request', 'Expected session identity must be nonempty');
    return this.call({ op: 'open', laneId, expectedSessionId, expectedAgentId }) as Promise<AgentLaneState>;
  }
  adopt(laneId: string, expectedSessionId: string, expectedAgentId: string, adoptionDigest: string): Promise<AgentLaneState> {
    return this.call({ op: 'open', laneId, expectedSessionId, expectedAgentId, adoptionDigest }) as Promise<AgentLaneState>;
  }
  getState(handle: AgentLaneHandle): Promise<AgentLaneState> {
    return this.call({ op: 'getState', handle }) as Promise<AgentLaneState>;
  }
  abort(handle: AgentLaneHandle, requestId: string): Promise<AgentLaneState> {
    return this.call({ op: 'abort', handle, requestId }) as Promise<AgentLaneState>;
  }
  close(handle: AgentLaneHandle): Promise<AgentLaneState> {
    return this.call({ op: 'close', handle }) as Promise<AgentLaneState>;
  }
  shutdown(): Promise<void> { return this.call({ op: 'shutdown' }).then(() => {}); }

  prompt(handle: AgentLaneHandle, requestId: string, text: string, onEvent?: (event: StreamLine) => void,
    timeoutMs = AGENT_RUNTIME_CLIENT_PROMPT_TIMEOUT_MS): AgentRuntimePrompt {
    const result = this.request({ op: 'prompt', handle, requestId, text }, timeoutMs, onEvent);
    return result as AgentRuntimePrompt;
  }

  private call(operation: AgentRuntimeOperation): Promise<AgentLaneState | undefined> {
    return this.request(operation, this.timeoutMs).completed;
  }
  private request(operation: AgentRuntimeOperation, timeoutMs: number, event?: (event: StreamLine) => void): {
    accepted: Promise<AgentLaneState | undefined>; completed: Promise<AgentLaneState | undefined>;
  } {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error('Invalid request timeout');
    if (this.ended) throw new AgentRuntimeUncertainError();
    if (this.pending.size >= 32) throw new AgentRuntimeError('busy', 'Too many pending controller calls');
    const id = randomUUID();
    const frame = JSON.stringify({ ...operation, version: 1, id }) + '\n';
    if (Buffer.byteLength(frame) > AGENT_RUNTIME_MAX_FRAME_BYTES) throw new AgentRuntimeError('frame_too_large', 'Controller request exceeds frame limit');
    let accept!: Pending['accepted'];
    let finish!: Pending['finished'];
    let rejectAccept!: (error: unknown) => void;
    let rejectFinish!: (error: unknown) => void;
    const accepted = new Promise<AgentLaneState | undefined>((resolve, reject) => { accept = resolve; rejectAccept = reject; });
    const completed = new Promise<AgentLaneState | undefined>((resolve, reject) => { finish = resolve; rejectFinish = reject; });
    // Either promise may be the one a caller chooses to await first.
    void accepted.catch(() => {}); void completed.catch(() => {});
    this.pending.set(id, { prompt: operation.op === 'prompt', accepted: accept, finished: finish,
      reject(error) { rejectAccept(error); rejectFinish(error); }, event,
      timer: setTimeout(() => this.disconnect(), timeoutMs) });
    this.socket.write(frame);
    return { accepted, completed };
  }
  private finish(id: string): void {
    const pending = this.pending.get(id);
    if (pending) clearTimeout(pending.timer);
    this.pending.delete(id);
  }
  disconnect(): void {
    if (this.ended) return;
    this.ended = true;
    this.socket.destroy();
    for (const [id, pending] of this.pending) {
      pending.reject(new AgentRuntimeUncertainError());
      this.finish(id);
    }
  }
}
