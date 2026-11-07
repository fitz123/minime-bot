import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { PiThinkingLevel } from './types.js';
import { AgentRuntimeError } from './agent-runtime-protocol.js';

/** Nonsecret, administrator/controller-authored input; never supplied over IPC. */
export interface AgentRuntimeDescriptor {
  version: 1;
  agentId: string;
  workerUid: number;
  workerGid: number;
  home: string;
  controllerUid: number;
  controllerName: string;
  workspace: string;
  stateRoot: string;
  sessionRoot: string;
  contextRoot: string;
  socketDirectory: string;
  socketPath: string;
  model: string;
  thinking: PiThinkingLevel;
  knowledge: 'none' | 'v2';
  capabilities: readonly string[];
  tools: readonly string[];
  offline: boolean;
}
const tools = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);
export function validateAgentRuntimeDescriptor(input: unknown): AgentRuntimeDescriptor {
  const d = input as AgentRuntimeDescriptor;
  if (!d || d.version !== 1 || !/^[a-zA-Z0-9_-]{1,80}$/.test(d.agentId)) throw new Error('Invalid worker descriptor identity/version');
  const fields = ['version', 'agentId', 'workerUid', 'workerGid', 'home', 'controllerUid', 'controllerName',
    'workspace', 'stateRoot', 'sessionRoot', 'contextRoot', 'socketDirectory', 'socketPath', 'model',
    'thinking', 'knowledge', 'capabilities', 'tools', 'offline'];
  if (Object.keys(d).some(k => !fields.includes(k))) throw new Error('Unsupported worker descriptor field');
  for (const value of [d.workerUid, d.workerGid]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Positive nonroot worker identity required');
  }
  if (!Number.isSafeInteger(d.controllerUid) || d.controllerUid < 0) throw new Error('Explicit controller UID required');
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(d.controllerName)) throw new Error('Invalid controller name');
  for (const p of [d.home, d.workspace, d.stateRoot, d.sessionRoot, d.contextRoot, d.socketDirectory, d.socketPath]) {
    if (typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p || /[\0\r\n]/.test(p)) throw new Error('Explicit canonical absolute worker paths required');
  }
  if (dirname(d.socketPath) !== d.socketDirectory || Buffer.byteLength(d.socketPath) >= 104) throw new Error('Invalid worker socket location');
  if (new Set([d.home, d.workspace, d.stateRoot, d.sessionRoot, d.contextRoot, d.socketDirectory]).size !== 6) throw new Error('Worker roots must be distinct');
  if (typeof d.model !== 'string' || !/^[^\s/]+\/\S+$/.test(d.model)
    || !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(d.thinking)
    || !['none', 'v2'].includes(d.knowledge) || typeof d.offline !== 'boolean') throw new Error('Explicit model, thinking, Knowledge and offline choices required');
  if (!Array.isArray(d.capabilities)) throw new Error('Explicit capabilities required');
  for (const capability of d.capabilities) {
    if (capability !== 'local-tools') throw new AgentRuntimeError('unsupported_capability', `Unsupported worker capability: ${String(capability)}`);
  }
  if (!Array.isArray(d.tools) || d.tools.some(t => !tools.has(t)) || (d.tools.length && !d.capabilities.includes('local-tools'))) {
    throw new AgentRuntimeError('unsupported_capability', 'Unsupported or undeclared worker tools');
  }
  return structuredClone(d);
}

export function loadAgentRuntimeDescriptor(path: string): AgentRuntimeDescriptor {
  if (!isAbsolute(path)) throw new Error('Descriptor path must be absolute');
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink()) throw new Error('Descriptor must be a regular file');
  const d = validateAgentRuntimeDescriptor(JSON.parse(readFileSync(path, 'utf8')));
  const sameUid = d.controllerUid === d.workerUid;
  if (![0, d.controllerUid].includes(s.uid) || (s.mode & (sameUid ? 0o222 : 0o022)) || (!sameUid && s.uid === d.workerUid)) {
    throw new Error('Descriptor must be controller/root-owned and not worker writable (same-UID fixture: readonly)');
  }
  return d;
}

export function assertAgentRuntimeIdentity(d: AgentRuntimeDescriptor): void {
  if (!process.getuid || !process.geteuid || !process.getgid || process.getuid() === 0 || process.getuid() !== d.workerUid || process.geteuid() !== d.workerUid
    || process.getgid() !== d.workerGid || process.env.HOME !== d.home) throw new Error('Unexpected worker UID/GID/HOME');
  if (realpathSync(d.workspace) !== d.workspace) throw new Error('Workspace must be canonical');
}

// The physical macOS mechanism was established by the separate canary. No peercred addon.
export function ensureAgentEndpointAcl(path: string, d: AgentRuntimeDescriptor, permission: 'search' | 'write'): void {
  if (d.controllerUid === d.workerUid) return;
  if (process.platform !== 'darwin') throw new Error('Cross-UID worker endpoint requires macOS ACLs');
  const options = { encoding: 'utf8' as const, timeout: 2_000, env: { PATH: '/usr/bin:/bin', HOME: d.home } };
  const uid = execFileSync('/usr/bin/id', ['-u', d.controllerName], options).trim();
  if (Number(uid) !== d.controllerUid) throw new Error('Controller name/UID mismatch');
  const entries = () => execFileSync('/bin/ls', ['-lde', path], options).split('\n')
    .filter(line => /^\s*\d+:/.test(line)).map(line => line.replace(/^\s*\d+:\s*/, '').trim());
  if (!entries().length) execFileSync('/bin/chmod', ['+a', `user:${d.controllerName} allow ${permission}`, path], options);
  const actual = entries();
  if (actual.length !== 1 || actual[0] !== `user:${d.controllerName} allow ${permission}`) throw new Error('Endpoint requires sole exact controller ACL grant');
}
