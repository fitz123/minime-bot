import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InteractiveSessionBinding } from './interactive-session-binding.js';
import type { AgentRequestOutcome } from './agent-runtime-protocol.js';
import { AgentRuntimeError } from './agent-runtime-protocol.js';
import type { PiContextManifest } from './pi-context-assembler.js';

export interface WorkerLaneRecord {
  version: 1;
  agentId: string;
  laneId: string;
  generation: number;
  binding: InteractiveSessionBinding;
  contextManifest?: PiContextManifest;
  request?: AgentRequestOutcome;
}
export function requirePrivateWorkerDirectory(path: string, uid: number): void {
  const created = mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = lstatSync(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid || (s.mode & 0o777) !== 0o700) throw new Error('Worker directory must be worker-owned 0700');
  if (created) { sync(path); sync(dirname(created)); }
}
function sync(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** One worker owner; the directory is the durable evidence that a lane already existed. */
export class WorkerLaneStore {
  private readonly directory: string;
  private readonly path: string;
  readonly isNew: boolean;
  constructor(root: string, readonly agentId: string, readonly laneId: string, expectExisting = false) {
    this.directory = join(root, createHash('sha256').update(laneId).digest('hex'));
    this.path = join(this.directory, 'binding.json');
    if (expectExisting && !existsSync(this.directory)) {
      throw new AgentRuntimeError('binding_invalid', 'Expected session has no existing lane binding');
    }
    try { mkdirSync(this.directory, { mode: 0o700 }); this.isNew = true; sync(root); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; this.isNew = false; }
    requirePrivateWorkerDirectory(this.directory, process.getuid!());
  }
  load(): WorkerLaneRecord {
    try {
      const s = lstatSync(this.path);
      if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid!() || (s.mode & 0o777) !== 0o600) throw new Error('Unsafe binding');
      const r = JSON.parse(readFileSync(this.path, 'utf8')) as WorkerLaneRecord;
      if (r.version !== 1 || r.agentId !== this.agentId || r.laneId !== this.laneId
        || !Number.isSafeInteger(r.generation) || r.generation < 0
        || !r.binding || typeof r.binding.sessionId !== 'string' || !r.binding.sessionId
        || (r.request && (typeof r.request.requestId !== 'string' || !r.request.requestId
          || !['accepted', 'settled', 'interrupted'].includes(r.request.outcome)))) throw new Error('Invalid binding');
      return r;
    } catch {
      throw new AgentRuntimeError('binding_invalid', 'Existing lane binding is missing, corrupt, or unsafe; refusing to rotate identity');
    }
  }
  save(record: WorkerLaneRecord): void {
    const temp = join(this.directory, `${randomUUID()}.tmp`);
    writeFileSync(temp, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
    sync(temp);
    renameSync(temp, this.path);
    sync(this.directory);
  }
}
