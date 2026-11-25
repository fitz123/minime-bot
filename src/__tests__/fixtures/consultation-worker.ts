import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { AgentRuntimeDescriptor } from '../../agent-runtime-descriptor.js';

export const consultationProvider = realpathSync(fileURLToPath(
  new URL('../../../test-fixtures/agent-runtime/consultation-provider.mjs', import.meta.url)));

export function consultationFixture(t: TestContext): AgentRuntimeDescriptor {
  const root = mkdtempSync(join(realpathSync('/tmp'), 'ar-consult-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(['home', 'workspace', 'state', 'sessions', 'context', 'socket'].map(name => {
    const path = join(root, name);
    mkdirSync(path, { mode: 0o700 });
    return [name, path];
  }));
  writeFileSync(join(paths.workspace, 'CLAUDE.md'), 'ISOLATED_TARGET_CONTEXT\n');
  writeFileSync(join(paths.workspace, 'SYSTEM.md'), 'SYNTHETIC_AMBIENT_SYSTEM\n');
  const primaryProfile = join(paths.state, 'pi');
  mkdirSync(primaryProfile, { mode: 0o700 });
  writeFileSync(join(primaryProfile, 'auth.json'), JSON.stringify({
    'consultation-fixture': {
      type: 'oauth', access: 'offline-authorization-marker', refresh: 'unused-offline-refresh',
      expires: Date.now() + 3_600_000,
    },
  }), { mode: 0o600 });
  writeFileSync(join(primaryProfile, 'settings.json'), JSON.stringify({
    retry: { enabled: true, provider: { maxRetries: 2 } },
    compaction: { enabled: true },
    transport: 'websocket-cached',
    cacheWarming: 'off',
  }), { mode: 0o600 });
  const uid = process.getuid!();
  return {
    version: 1, agentId: 'fixture-target', workerUid: uid, workerGid: process.getgid!(),
    controllerUid: uid, controllerName: 'fixture-controller', home: paths.home, workspace: paths.workspace,
    stateRoot: paths.state, sessionRoot: paths.sessions, contextRoot: paths.context,
    socketDirectory: paths.socket, socketPath: join(paths.socket, 'worker.sock'),
    model: 'consultation-fixture/offline', thinking: 'off', knowledge: 'none', offline: true,
    capabilities: ['inbound-consultation', 'local-tools'], tools: ['read', 'ls', 'bash', 'write', 'edit'],
  };
}

export function consultationStarted(d: AgentRuntimeDescriptor): {
  pid: number; noSession: boolean; noCentralEnv: boolean; tools: string[];
  autoRetry: boolean; autoCompaction: boolean; cacheWarming: string;
} {
  return JSON.parse(readFileSync(join(d.workspace, 'consultation-started.json'), 'utf8'));
}

export function consultationPromptCount(d: AgentRuntimeDescriptor): number {
  const receipt = join(d.workspace, 'consultation-prompts');
  return existsSync(receipt) ? readFileSync(receipt, 'utf8').trim().split('\n').length : 0;
}

export function assertConsultationClean(d: AgentRuntimeDescriptor): void {
  assert.deepEqual(readdirSync(d.sessionRoot), []);
  assert.deepEqual(readdirSync(d.contextRoot), []);
  assert.equal(existsSync(join(d.stateRoot, 'lanes')), false);
  const stateFiles = readdirSync(d.stateRoot, { recursive: true, encoding: 'utf8' });
  assert.deepEqual(stateFiles.filter(path => path.endsWith('.jsonl') || path.endsWith('sessions.json')), []);
  assert.deepEqual(stateFiles.filter(path => path.endsWith('auth.json')), [join('pi', 'auth.json')]);
  assert.equal(existsSync(join(d.stateRoot, 'consult-pi')), false);
  assert.deepEqual(readdirSync(d.home, { recursive: true, encoding: 'utf8' }).filter(path => path.endsWith('auth.json')), []);
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}

export async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(15);
  }
  assert.fail('Offline consultation fixture deadline exceeded');
}
