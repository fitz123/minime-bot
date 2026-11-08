import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { assemblePiContext, type PiContextArtifacts } from './pi-context-assembler.js';
import { resolveKnowledgeLayout } from './knowledge/layout.js';
import { inspectInteractiveSessionBinding, resolveExplicitInteractiveSessionLocation } from './interactive-session-binding.js';
import { preseedInteractiveSessionBinding, assertInteractiveSessionBindingOpenable } from './interactive-session-seed.js';
import { NewlineOnlyJsonlSplitter, spawnPreparedPiRpcSession } from './pi-rpc-protocol.js';
import { AgentRuntimePi } from './agent-runtime-pi.js';
import { WorkerLaneStore, requirePrivateWorkerDirectory, type WorkerLaneRecord } from './agent-runtime-store.js';
import {
  validateAgentRuntimeDescriptor, assertAgentRuntimeIdentity, assertAgentEndpointMetadata, ensureAgentEndpointAcl, type AgentRuntimeDescriptor,
} from './agent-runtime-descriptor.js';
import {
  AGENT_RUNTIME_MAX_FRAME_BYTES, AGENT_RUNTIME_PROMPT_TIMEOUT_MS, AgentRuntimeError,
  type AgentLaneHandle, type AgentLaneState, type AgentRuntimeRequest, type AgentRuntimeMessage,
} from './agent-runtime-protocol.js';

interface Lane {
  store: WorkerLaneStore;
  record: WorkerLaneRecord;
  phase: AgentLaneState['phase'];
  owner?: Socket;
  pi?: AgentRuntimePi;
  context?: PiContextArtifacts;
  promptDone?: Promise<void>;
  closing?: Promise<void>;
}
export interface AgentRuntimeWorkerOptions {
  /** Trusted fixture code only. There is deliberately no corresponding IPC field. */
  trustedTestExtensions?: readonly string[];
  startupTimeoutMs?: number;
  promptTimeoutMs?: number;
}
const boundedTimeout = (value: number | undefined, fallback: number) => {
  const n = value ?? fallback;
  if (!Number.isSafeInteger(n) || n < 1 || n > 300_000) throw new Error('Worker timeout must be 1..300000ms');
  return n;
};
const fail = (code: string, message: string): never => { throw new AgentRuntimeError(code, message); };
function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('../');
}

export class AgentRuntimeWorker {
  readonly descriptor: AgentRuntimeDescriptor;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly lanes = new Map<string, Lane>();
  private readonly startupTimeoutMs: number;
  private readonly promptTimeoutMs: number;
  private stopping?: Promise<void>;
  private listening = false;
  private readonly extensions: string[];

  constructor(input: AgentRuntimeDescriptor, options: AgentRuntimeWorkerOptions = {}) {
    this.descriptor = validateAgentRuntimeDescriptor(input);
    this.startupTimeoutMs = boundedTimeout(options.startupTimeoutMs, 10_000);
    this.promptTimeoutMs = boundedTimeout(options.promptTimeoutMs, AGENT_RUNTIME_PROMPT_TIMEOUT_MS);
    this.extensions = [...options.trustedTestExtensions ?? []];
    for (const p of this.extensions) {
      if (!isAbsolute(p) || realpathSync(p) !== p || !lstatSync(p).isFile()) throw new Error('Test extension must be an explicit canonical file');
    }
    this.server = createServer(socket => this.accept(socket));
  }

  async listen(): Promise<void> {
    const d = this.descriptor;
    assertAgentRuntimeIdentity(d);
    process.umask(0o077);
    for (const path of [d.home, d.stateRoot, d.sessionRoot, d.contextRoot, d.socketDirectory]) {
      requirePrivateWorkerDirectory(path, d.workerUid);
      if (realpathSync(path) !== path) throw new Error('Worker private roots must be canonical');
    }
    // Refuse stale/live endpoints; net.listen never unlinks somebody else's socket.
    ensureAgentEndpointAcl(d.socketDirectory, d, 'search');
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(d.socketPath, () => { this.server.off('error', reject); resolve(); });
    });
    this.listening = true;
    try {
      chmodSync(d.socketPath, 0o600);
      ensureAgentEndpointAcl(d.socketPath, d, 'write');
      assertAgentEndpointMetadata(d.socketPath, d.workerUid, 'socket');
    } catch (error) { await this.shutdown(); throw error; }
  }

  private prepareContext(laneId: string): PiContextArtifacts {
    const d = this.descriptor;
    try {
      const claude = join(d.workspace, 'CLAUDE.md');
      if (!lstatSync(claude).isFile() || realpathSync(claude) !== claude) throw new Error('Missing local CLAUDE.md');
      readFileSync(claude);
      // Reject before assembler's legacy external platform-rule resolver can read central config.
      for (const rel of ['.claude', '.claude/rules', '.claude/rules/platform', '.claude/rules/custom']) {
        if (d.behavioralFoundationRoot !== undefined && rel === '.claude/rules/platform') continue;
        const p = join(d.workspace, rel);
        try {
          if (lstatSync(p).isSymbolicLink() || !inside(d.workspace, realpathSync(p))) throw new Error('External/symlink rule directories are unsupported');
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (d.knowledge === 'v2') {
        for (const rel of ['wiki/schema.md', 'wiki/index.md']) {
          const p = join(d.workspace, rel);
          if (!lstatSync(p).isFile() || realpathSync(p) !== p) throw new Error('Missing local Knowledge layer');
          readFileSync(p);
        }
        if (resolveKnowledgeLayout(d.workspace).kind !== 'v2') throw new Error('Expected Knowledge v2');
      }
      const artifactRoot = join(d.contextRoot, createHash('sha256').update(laneId).digest('hex'));
      requirePrivateWorkerDirectory(artifactRoot, d.workerUid);
      const context = assemblePiContext({ id: d.agentId, workspaceCwd: d.workspace, model: d.model, thinking: d.thinking },
        { strict: true, artifactWorkspaceCwd: artifactRoot, behavioralFoundationRoot: d.behavioralFoundationRoot });
      if (!context) throw new Error('No worker context');
      return context;
    } catch (error) {
      if (d.behavioralFoundationRoot !== undefined) return fail('context_invalid', `Required local context or behavioral foundation is invalid; Pi was not started. ${error instanceof Error ? error.message : 'Check descriptor and publication'}`);
      return fail('context_invalid', 'Required local context/imports/rules are missing or unsupported; Pi was not started');
    }
  }

  private environment(): NodeJS.ProcessEnv {
    const d = this.descriptor;
    const agentDirectory = join(d.stateRoot, 'pi');
    const temp = join(d.stateRoot, 'tmp');
    for (const p of [agentDirectory, temp]) requirePrivateWorkerDirectory(p, d.workerUid);
    return {
      HOME: d.home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, SHELL: '/bin/bash',
      TMPDIR: temp, PI_CODING_AGENT_DIR: agentDirectory, PI_CODING_AGENT_SESSION_DIR: d.sessionRoot,
      MINIME_AGENT_WORKSPACE_ROOT: d.workspace, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
      ...(d.offline ? { PI_OFFLINE: '1' } : {}),
    };
  }

  private state(lane: Lane): AgentLaneState {
    const r = lane.record;
    return {
      handle: { agentId: r.agentId, laneId: r.laneId, sessionId: r.binding.sessionId, generation: r.generation },
      phase: lane.phase,
      ...(r.request ? { request: { ...r.request } } : {}),
      ...(lane.context ? { contextDigest: lane.context.manifest.digest } : {}),
    };
  }

  private bound(handle: AgentLaneHandle): Lane {
    const lane = this.lanes.get(handle.laneId);
    const actual = lane && this.state(lane).handle;
    if (!lane || !actual || actual.agentId !== handle.agentId || actual.sessionId !== handle.sessionId
      || actual.generation !== handle.generation) return fail('stale_handle', 'Lane handle is stale; open with the expected session identity');
    return lane;
  }
  private owned(handle: AgentLaneHandle, socket: Socket): Lane {
    const lane = this.bound(handle);
    if (lane.owner !== socket) return fail('lane_owner', 'Lane belongs to a different connection; reopen after cleanup');
    return lane;
  }

  private async startPi(lane: Lane): Promise<void> {
    if (this.stopping || lane.owner?.destroyed || lane.phase === 'closing') return fail('disconnected', 'Lane owner disconnected');
    const d = this.descriptor;
    const child = spawnPreparedPiRpcSession({ binding: lane.record.binding, context: lane.context!,
      model: d.model, thinking: d.thinking, tools: d.tools, extensions: this.extensions,
      env: this.environment(), offline: d.offline });
    const pi = new AgentRuntimePi(child, lane.record.binding, this.startupTimeoutMs, { model: d.model, thinking: d.thinking });
    lane.pi = pi;
    child.once('close', () => {
      if (lane.pi !== pi || lane.phase !== 'ready') return;
      lane.phase = 'closed';
      lane.owner = undefined;
    });
    try { await pi.ready; }
    catch (error) { await pi.stop(); lane.phase = 'closed'; lane.owner = undefined; throw error; }
    if (this.stopping || lane.owner?.destroyed || lane.closing) { await pi.stop(); return fail('disconnected', 'Lane owner disconnected'); }
    lane.phase = 'ready';
  }

  private async open(laneId: string, expectedSessionId: string | undefined, socket: Socket): Promise<AgentLaneState> {
    let lane = this.lanes.get(laneId);
    if (lane && lane.phase !== 'closed') return fail('busy', 'Lane is already open or changing state');
    // Source failures cannot mint a new session or create an unbound lane marker.
    const context = this.prepareContext(laneId);
    const d = this.descriptor;
    const location = resolveExplicitInteractiveSessionLocation(d.workspace, d.sessionRoot, d.workerUid);
    const root = join(d.stateRoot, 'lanes');
    requirePrivateWorkerDirectory(root, d.workerUid);
    const store = new WorkerLaneStore(root, d.agentId, laneId, expectedSessionId !== undefined);
    let record: WorkerLaneRecord;
    if (store.isNew) {
      if (expectedSessionId) return fail('binding_invalid', 'Expected session has no existing lane binding');
      record = { version: 1, agentId: d.agentId, laneId, generation: 0, binding: preseedInteractiveSessionBinding(location) };
    } else {
      record = store.load();
      if (expectedSessionId && record.binding.sessionId !== expectedSessionId) return fail('session_mismatch', 'Expected session does not match the lane binding');
      if (record.binding.workspaceRealpath !== location.workspaceRealpath || record.binding.sessionDirectory !== location.sessionDirectory) return fail('binding_invalid', 'Existing binding does not match worker roots');
      const inspection = inspectInteractiveSessionBinding(location, record.binding.sessionFile, record.binding.sessionId);
      if (!inspection.valid) return fail('binding_invalid', 'Existing exact transcript is missing, corrupt, or unsafe; refusing to rotate identity');
      assertInteractiveSessionBindingOpenable(record.binding);
      if (record.request?.outcome === 'accepted') record.request.outcome = 'interrupted';
    }
    record.generation += 1;
    record.contextManifest = context.manifest;
    store.save(record); // fsync binding BEFORE constructing/spawning Pi.
    lane = { store, record, phase: 'opening', owner: socket, context };
    this.lanes.set(laneId, lane);
    try { await this.startPi(lane); }
    catch (error) { lane.phase = 'closed'; lane.owner = undefined; throw error; }
    return this.state(lane);
  }

  private async closeLane(lane: Lane): Promise<void> {
    if (lane.closing) return lane.closing;
    lane.phase = 'closing';
    let persistenceError: unknown;
    if (lane.record.request?.outcome === 'accepted') {
      lane.record.request.outcome = 'interrupted';
      try { lane.store.save(lane.record); } catch (error) { persistenceError = error; }
    }
    return lane.closing = (async () => {
      try {
        await lane.pi?.stop();
        await lane.promptDone;
        if (persistenceError) throw persistenceError;
      }
      finally { lane.pi = undefined; lane.promptDone = undefined; lane.owner = undefined; lane.phase = 'closed'; lane.closing = undefined; }
    })();
  }

  private async prompt(lane: Lane, request: Extract<AgentRuntimeRequest, { op: 'prompt' }>, socket: Socket): Promise<void> {
    if (lane.phase !== 'ready' || !lane.pi) return fail('busy', 'Lane has an active request or state transition');
    if (lane.record.request?.requestId === request.requestId) return fail('duplicate_request', 'Request ID was already used; no replay is performed');
    lane.phase = 'prompting';
    lane.record.request = { requestId: request.requestId, outcome: 'accepted' };
    try { lane.store.save(lane.record); }
    catch (error) { lane.phase = 'closed'; await lane.pi.stop(); throw error; }
    this.send(socket, { version: 1, type: 'response', id: request.id, state: this.state(lane) });
    const timer = setTimeout(() => { void this.closeLane(lane).catch(() => socket.destroy()); }, this.promptTimeoutMs);
    lane.promptDone = (async () => {
      try {
        await lane.pi!.prompt(request.requestId, request.text, event => {
          this.send(socket, { version: 1, type: 'event', id: request.id, requestId: request.requestId, event });
        });
        // An explicit abort/disconnect may already have marked this uncertain.
        if (lane.record.request?.outcome === 'accepted') lane.record.request.outcome = 'settled';
      } catch {
        if (lane.record.request) lane.record.request.outcome = 'interrupted';
        // Reap after a protocol/child failure, without awaiting our own promptDone.
        await lane.pi?.stop();
        if (lane.phase === 'prompting') { lane.phase = 'closed'; lane.owner = undefined; }
      } finally {
        clearTimeout(timer);
        try { lane.store.save(lane.record); }
        catch (error) {
          if (lane.record.request) lane.record.request.outcome = 'interrupted';
          lane.phase = 'closing';
          // Reap directly: closeLane would await this promptDone itself.
          try { await lane.pi?.stop(); }
          catch { /* Preserve the persistence failure even if cleanup fails. */ }
          finally { lane.pi = undefined; lane.promptDone = undefined; lane.owner = undefined; lane.phase = 'closed'; }
          throw error;
        }
        if (lane.phase === 'prompting') lane.phase = 'ready';
        this.send(socket, { version: 1, type: 'finished', id: request.id, state: this.state(lane) });
      }
    })();
    await lane.promptDone;
  }

  private send(socket: Socket, message: AgentRuntimeMessage): void {
    if (socket.destroyed || !socket.writable) return;
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > AGENT_RUNTIME_MAX_FRAME_BYTES || socket.writableLength > 2 * AGENT_RUNTIME_MAX_FRAME_BYTES) {
      socket.destroy(); return;
    }
    socket.write(frame);
  }

  private accept(socket: Socket): void {
    if (this.stopping) { socket.destroy(); return; }
    this.sockets.add(socket);
    const splitter = new NewlineOnlyJsonlSplitter(AGENT_RUNTIME_MAX_FRAME_BYTES);
    let partialTimer: ReturnType<typeof setTimeout> | undefined;
    let rejecting = false;
    const rejectFrame = () => {
      if (rejecting) return;
      rejecting = true;
      socket.pause();
      this.send(socket, { version: 1, type: 'error', id: '', code: 'invalid_frame', message: 'Malformed, oversized, incomplete, or unsupported worker request' });
      socket.end();
      socket.destroySoon();
    };
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(partialTimer);
      this.sockets.delete(socket);
      for (const lane of this.lanes.values()) {
        if (lane.owner === socket) void this.closeLane(lane).catch(() => {});
      }
    });
    socket.on('end', () => { if (splitter.hasPendingRecord()) socket.destroy(); });
    socket.on('data', (chunk: Buffer) => {
      if (rejecting) return;
      try {
        const records = splitter.push(chunk);
        if (records.length || !splitter.hasPendingRecord()) { clearTimeout(partialTimer); partialTimer = undefined; }
        if (splitter.hasPendingRecord() && !partialTimer) partialTimer = setTimeout(rejectFrame, 5_000);
        for (const record of records) {
          const request = validateRequest(JSON.parse(record));
          void this.dispatch(request, socket).catch(error => {
            this.send(socket, { version: 1, type: 'error', id: request.id,
              code: error instanceof AgentRuntimeError ? error.code : 'worker_error',
              message: error instanceof AgentRuntimeError ? error.message : 'Worker operation failed; inspect worker-local state' });
          });
        }
      } catch {
        rejectFrame();
      }
    });
  }

  private async dispatch(r: AgentRuntimeRequest, socket: Socket): Promise<void> {
    if (this.stopping) return fail('shutdown', 'Worker is shutting down');
    if (r.op === 'shutdown') {
      this.send(socket, { version: 1, type: 'response', id: r.id });
      void this.shutdown().catch(() => { process.exitCode = 1; }); return;
    }
    if (r.op === 'open') {
      const state = await this.open(r.laneId, r.expectedSessionId, socket);
      this.send(socket, { version: 1, type: 'response', id: r.id, state }); return;
    }
    if (r.op === 'getState') {
      this.send(socket, { version: 1, type: 'response', id: r.id, state: this.state(this.bound(r.handle)) }); return;
    }
    const lane = this.owned(r.handle, socket);
    if (r.op === 'prompt') { await this.prompt(lane, r, socket); return; }
    if (r.op === 'abort') {
      if (lane.phase !== 'prompting' || lane.record.request?.requestId !== r.requestId) return fail('request_mismatch', 'No matching active request to abort');
      const owner = lane.owner;
      await this.closeLane(lane);
      if (owner?.destroyed || this.stopping) return fail('disconnected', 'Lane owner disconnected');
      lane.owner = owner; lane.phase = 'opening';
      try {
        lane.context = this.prepareContext(lane.record.laneId);
        lane.record.contextManifest = lane.context.manifest;
        lane.store.save(lane.record);
        await this.startPi(lane);
      } catch (error) { lane.phase = 'closed'; lane.owner = undefined; throw error; }
    } else {
      if (lane.phase === 'opening' || lane.phase === 'closing') return fail('busy', 'Lane has an active state transition');
      await this.closeLane(lane);
    }
    this.send(socket, { version: 1, type: 'response', id: r.id, state: this.state(lane) });
  }

  shutdown(): Promise<void> {
    return this.stopping ??= (async () => {
      const closed = this.listening ? new Promise<void>(resolve => this.server.close(() => resolve())) : Promise.resolve();
      const results = await Promise.allSettled([...this.lanes.values()].map(lane => this.closeLane(lane)));
      for (const socket of this.sockets) socket.destroy();
      await closed;
      const failure = results.find(r => r.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    })();
  }
}

function validateRequest(value: unknown): AgentRuntimeRequest {
  const r = value as AgentRuntimeRequest;
  if (!r || r.version !== 1 || typeof r.id !== 'string' || !r.id || r.id.length > 100) throw new Error('Invalid request');
  const fields: Record<string, string[]> = {
    open: ['laneId', 'expectedSessionId'], prompt: ['handle', 'requestId', 'text'],
    getState: ['handle'], abort: ['handle', 'requestId'], close: ['handle'], shutdown: [],
  };
  if (!Object.hasOwn(fields, r.op) || Object.keys(r).some(k => !['version', 'id', 'op', ...fields[r.op]].includes(k))) throw new Error('Unsupported request field');
  if (r.op === 'open') {
    if (typeof r.laneId !== 'string' || !r.laneId || r.laneId.length > 200
      || (r.expectedSessionId !== undefined && (typeof r.expectedSessionId !== 'string' || !r.expectedSessionId.trim() || r.expectedSessionId.length > 200))) throw new Error('Invalid lane');
  } else if (r.op !== 'shutdown') {
    const h = r.handle;
    if (!h || Object.keys(h).some(k => !['agentId', 'laneId', 'sessionId', 'generation'].includes(k))
      || ![h.agentId, h.laneId, h.sessionId].every(s => typeof s === 'string' && s.length > 0 && s.length <= 200)
      || !Number.isSafeInteger(h.generation) || h.generation < 1) throw new Error('Invalid handle');
    if ((r.op === 'prompt' || r.op === 'abort') && (typeof r.requestId !== 'string' || !r.requestId || r.requestId.length > 100)) throw new Error('Invalid request identity');
    if (r.op === 'prompt' && (typeof r.text !== 'string' || !r.text.trim())) throw new Error('Invalid prompt');
  }
  return r;
}
