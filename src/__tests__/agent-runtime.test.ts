import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntimeClient } from '../agent-runtime-client.js';
import { AgentRuntimeError, AgentRuntimeUncertainError, AGENT_RUNTIME_MAX_FRAME_BYTES } from '../agent-runtime-protocol.js';
import { validateAgentRuntimeDescriptor, loadAgentRuntimeDescriptor, type AgentRuntimeDescriptor } from '../agent-runtime-descriptor.js';
import { NewlineOnlyJsonlSplitter } from '../pi-rpc-protocol.js';
import { generateKnowledgeV2Schema } from '../knowledge/layout.js';

const fixtures = resolve('test-fixtures/agent-runtime');
const uid = process.getuid!();
const gid = process.getgid!();
interface Message { id?: string; ready?: boolean; done?: boolean; state?: any; error?: {code: string}; event?: any; accepted?: any }
async function until<T>(read: () => T | undefined | false, timeout = 10_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = read(); if (value) return value; await delay(20); }
  throw new Error('Bounded fixture deadline exceeded');
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await until(() => child.exitCode !== null || child.signalCode !== null, 5_000); }
  catch { child.kill('SIGKILL'); await until(() => child.exitCode !== null || child.signalCode !== null, 2_000); }
}
function start(t: TestContext, file: string, args: string[], home: string) {
  const child = fork(join(fixtures, file), args, {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      MINIME_CONFIG_PATH: '/synthetic-unavailable-control/config.yaml', MINIME_CONTROL_WORKSPACE_ROOT: '/synthetic-unavailable-control' },
  });
  const messages: Message[] = [];
  let stderr = '';
  child.stderr!.on('data', chunk => { if (stderr.length < 4_096) stderr += String(chunk); });
  child.on('message', m => messages.push(m as Message));
  child.on('error', () => {});
  t.after(() => stop(child));
  return { child, messages, async ready() {
    await until(() => {
      if (child.exitCode !== null) throw new Error(`Fixture exited ${child.exitCode}: ${stderr}`);
      return messages.find(m => m.ready);
    });
  } };
}
function setup() {
  const root = realpathSync(mkdtempSync(join(realpathSync('/tmp'), 'ar-')));
  const dirs = Object.fromEntries(['home', 'workspace', 'state', 'sessions', 'context', 'socket'].map(name => {
    const path = join(root, name); mkdirSync(path, { mode: 0o700 }); return [name, path];
  }));
  mkdirSync(join(dirs.workspace, 'wiki'));
  mkdirSync(join(dirs.workspace, '.claude/rules/custom'), { recursive: true });
  writeFileSync(join(dirs.workspace, 'CLAUDE.md'), 'SYNTHETIC_LOCAL_CONTEXT\n@local.md\n');
  writeFileSync(join(dirs.workspace, 'local.md'), 'SYNTHETIC_IMPORTED_CONTEXT\n');
  writeFileSync(join(dirs.workspace, '.claude/rules/custom/test.md'), 'SYNTHETIC_RULE_CONTEXT\n');
  writeFileSync(join(dirs.workspace, 'wiki/schema.md'), generateKnowledgeV2Schema());
  writeFileSync(join(dirs.workspace, 'wiki/index.md'), 'SYNTHETIC_KNOWLEDGE_INDEX\n');
  const descriptor: AgentRuntimeDescriptor = { version: 1, agentId: 'synthetic-agent', workerUid: uid, workerGid: gid,
    home: dirs.home, controllerUid: uid, controllerName: 'fixture-controller', workspace: dirs.workspace,
    stateRoot: dirs.state, sessionRoot: dirs.sessions, contextRoot: dirs.context, socketDirectory: dirs.socket,
    socketPath: join(dirs.socket, 'worker.sock'), model: 'worker-offline/fixture', thinking: 'off', knowledge: 'v2',
    capabilities: ['local-tools'], tools: ['bash'], offline: true };
  const path = join(root, 'descriptor.json');
  writeFileSync(path, JSON.stringify(descriptor), { mode: 0o444 });
  return { root, dirs, descriptor, path };
}
function records(f: ReturnType<typeof setup>) {
  const root = join(f.dirs.state, 'lanes');
  return readdirSync(root).map(n => join(root, n, 'binding.json'));
}
let sequence = 0;
function call(controller: ReturnType<typeof start>, op: string, args: Record<string, unknown> = {}) {
  const id = String(++sequence);
  controller.child.send({ id, op, ...args });
  return { id, done: () => until(() => controller.messages.find(m => m.id === id && m.done), 20_000),
    accepted: () => until(() => controller.messages.find(m => m.id === id && (m.accepted || m.error)), 20_000) };
}
async function launch(t: TestContext, f: ReturnType<typeof setup>, extension = 'provider.mjs', startupTimeout = 10_000) {
  const worker = start(t, 'worker.ts', [f.path, join(fixtures, extension), String(startupTimeout)], f.dirs.home);
  await worker.ready();
  return worker;
}
async function controller(t: TestContext, f: ReturnType<typeof setup>) {
  const c = start(t, 'controller.ts', [f.descriptor.socketPath], f.dirs.home); await c.ready(); return c;
}
function json(path: string) { return JSON.parse(readFileSync(path, 'utf8')); }

test('worker/client processes use real pinned Pi, private context, durable exact history across restart', { timeout: 60_000 }, async t => {
  const f = setup();
  const worker = await launch(t, f);
  const c = await controller(t, f);
  const opened = await call(c, 'open').done();
  assert.equal(opened.error, undefined);
  const handle = opened.state.handle;
  assert.deepEqual(Object.keys(handle).sort(), ['agentId', 'generation', 'laneId', 'sessionId']);
  const startup = json(join(f.dirs.workspace, 'started.json'));
  assert.equal(startup.bindingVisible, true);
  assert.equal(startup.noCentralEnv, true);
  assert.equal(startup.uid, uid);
  assert.notEqual(startup.pid, worker.child.pid);
  assert.notEqual(c.child.pid, worker.child.pid);
  assert.equal(startup.sessionId, handle.sessionId);
  const prompt = call(c, 'prompt', { requestId: 'write-1', text: 'WRITE exact-marker' });
  assert.equal((await prompt.accepted()).accepted.request.outcome, 'accepted');
  const settled = await prompt.done();
  assert.equal(settled.state.request.outcome, 'settled');
  const events = c.messages.filter(m => m.id === prompt.id && m.event).map(m => m.event);
  assert.ok(events.some(e => e.type === 'stream_event' && e.event.content_block?.type === 'tool_use'));
  assert.ok(events.some(e => e.type === 'stream_event' && e.event.delta?.type === 'text_delta'));
  const result = events.find(e => e.type === 'result');
  assert.match(JSON.stringify(result), /"context\\?":true/);
  assert.match(JSON.stringify(result), /exact-marker/);
  assert.equal(readFileSync(join(f.dirs.workspace, 'marker.txt'), 'utf8'), 'exact-marker');
  const record = json(records(f)[0]);
  assert.equal(record.binding.sessionId, handle.sessionId);
  assert.equal(lstatSync(records(f)[0]).mode & 0o777, 0o600);
  assert.equal(lstatSync(record.binding.sessionFile).mode & 0o777, 0o600);
  assert.equal(lstatSync(f.dirs.sessions).mode & 0o777, 0o700);
  assert.equal(lstatSync(f.descriptor.socketPath).mode & 0o777, 0o600);
  assert.equal(existsSync(join(f.dirs.workspace, '.pi', 'context')), false);
  const artifacts = readdirSync(join(f.dirs.context, '.tmp'));
  assert.ok(artifacts.length > 0);
  const closed = await call(c, 'close').done(); assert.equal(closed.state.phase, 'closed');
  assert.equal(closed.state.handle.sessionId, handle.sessionId);
  await stop(c.child); await stop(worker.child);
  assert.equal(alive(startup.pid), false);
  await launch(t, f);
  const resumedController = await controller(t, f);
  const resumed = await call(resumedController, 'open', { expectedSessionId: handle.sessionId }).done();
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.state.handle.sessionId, handle.sessionId);
  assert.equal(resumed.state.handle.generation, handle.generation + 1);
  assert.deepEqual(resumed.state.request, { requestId: 'write-1', outcome: 'settled' });
  assert.deepEqual(json(records(f)[0]).binding, record.binding);
  const history = call(resumedController, 'prompt', { requestId: 'history-1', text: 'HISTORY' });
  assert.equal((await history.done()).state.request.outcome, 'settled');
  assert.ok(resumedController.messages.some(m => m.id === history.id && m.event?.type === 'result'
    && JSON.stringify(m.event).includes('priorMarker') && JSON.stringify(m.event).includes('exact-marker')));
  const other = await AgentRuntimeClient.connect(f.descriptor.socketPath); t.after(() => other.disconnect());
  await assert.rejects(other.getState(handle), (e: AgentRuntimeError) => e.code === 'stale_handle');
  const serialized = JSON.stringify(await other.getState(resumed.state.handle));
  for (const privateValue of [f.dirs.state, f.dirs.sessions, f.dirs.workspace, process.execPath]) assert.equal(serialized.includes(privateValue), false);
});

test('active request rejects concurrency; abort reaps tools and next prompt uses same session', { timeout: 45_000 }, async t => {
  const f = setup(); await launch(t, f); const c = await controller(t, f);
  const opened = await call(c, 'open').done(); assert.equal(opened.error, undefined);
  const waiting = call(c, 'prompt', { requestId: 'wait-1', text: 'WAIT' });
  await waiting.accepted();
  const sleeper = await until(() => existsSync(join(f.dirs.workspace, 'sleeper.json')) && json(join(f.dirs.workspace, 'sleeper.json')));
  assert.equal(alive(sleeper.pid), true);
  const state = await call(c, 'state').done(); assert.equal(state.state.phase, 'prompting');
  assert.equal(json(records(f)[0]).request.outcome, 'accepted');
  assert.equal((await call(c, 'prompt', { requestId: 'collision', text: 'HISTORY' }).done()).error?.code, 'busy');
  assert.equal((await call(c, 'abort', { requestId: 'wrong' }).done()).error?.code, 'request_mismatch');
  const aborted = await call(c, 'abort', { requestId: 'wait-1' }).done();
  assert.equal(aborted.error, undefined); assert.equal(aborted.state.phase, 'ready');
  assert.equal(aborted.state.handle.sessionId, opened.state.handle.sessionId);
  assert.equal(aborted.state.request.outcome, 'interrupted');
  assert.equal((await waiting.done()).state.request.outcome, 'interrupted');
  await until(() => !alive(sleeper.pid));
  assert.equal((await call(c, 'prompt', { requestId: 'wait-1', text: 'WAIT' }).done()).error?.code, 'duplicate_request');
  const next = await call(c, 'prompt', { requestId: 'after-abort', text: 'WRITE after-abort' }).done();
  assert.equal(next.state.request.outcome, 'settled');
});

test('disconnect aborts owned tool descendants, persists interrupted outcome, and never retries', { timeout: 40_000 }, async t => {
  const f = setup(); const worker = await launch(t, f); const c = await controller(t, f);
  const opened = await call(c, 'open').done();
  const waiting = call(c, 'prompt', { requestId: 'disconnected-request', text: 'WAIT' }); await waiting.accepted();
  const sleeper = await until(() => existsSync(join(f.dirs.workspace, 'sleeper.json')) && json(join(f.dirs.workspace, 'sleeper.json')));
  const piPid = json(join(f.dirs.workspace, 'started.json')).pid;
  c.child.send({ id: 'disconnect', op: 'disconnect' });
  await until(() => !alive(piPid) && !alive(sleeper.pid));
  await stop(worker.child);
  await launch(t, f);
  const client = await AgentRuntimeClient.connect(f.descriptor.socketPath); t.after(() => client.disconnect());
  const reopened = await client.open('lane', opened.state.handle.sessionId);
  assert.deepEqual(reopened.request, { requestId: 'disconnected-request', outcome: 'interrupted' });
  await delay(150);
  assert.equal(json(records(f)[0]).request.outcome, 'interrupted');
  assert.equal((await client.getState(reopened.handle)).phase, 'ready');
});

test('strict missing context/import/Knowledge and external rule symlinks fail before any child/binding', { timeout: 35_000 }, async t => {
  for (const kind of ['claude', 'import', 'knowledge', 'external-platform']) {
    const f = setup();
    if (kind === 'claude') renameSync(join(f.dirs.workspace, 'CLAUDE.md'), join(f.root, 'unused-context.md'));
    if (kind === 'import') writeFileSync(join(f.dirs.workspace, 'CLAUDE.md'), '@missing.md\n');
    if (kind === 'knowledge') writeFileSync(join(f.dirs.workspace, 'wiki/schema.md'), 'unmarked schema');
    if (kind === 'external-platform') {
      const external = join(f.root, 'external-rules'); mkdirSync(external); symlinkSync(external, join(f.dirs.workspace, '.claude/rules/platform'));
    }
    const w = await launch(t, f);
    const client = await AgentRuntimeClient.connect(f.descriptor.socketPath);
    await assert.rejects(client.open('bad-context'), (e: AgentRuntimeError) => e.code === 'context_invalid');
    assert.equal(existsSync(join(f.dirs.workspace, 'started.json')), false);
    assert.equal(readdirSync(f.dirs.sessions).length, 0);
    assert.equal(existsSync(join(f.dirs.state, 'lanes')), false);
    client.disconnect(); await stop(w.child);
  }
});

test('startup timeout reaps child and preserves binding; corrupt/missing existing bindings never rotate', { timeout: 45_000 }, async t => {
  const f = setup(); const w = await launch(t, f, 'blocked-startup.mjs', 2_000);
  const client = await AgentRuntimeClient.connect(f.descriptor.socketPath); t.after(() => client.disconnect());
  await assert.rejects(client.open('lane'), (e: AgentRuntimeError) => e.code === 'startup_timeout');
  const pid = json(join(f.dirs.workspace, 'blocked-pid.json')).pid;
  assert.equal(alive(pid), false);
  const before = json(records(f)[0]);
  await stop(w.child);
  await launch(t, f);
  const next = await AgentRuntimeClient.connect(f.descriptor.socketPath); t.after(() => next.disconnect());
  const state = await next.open('lane', before.binding.sessionId);
  assert.equal(state.handle.sessionId, before.binding.sessionId);
  assert.deepEqual(json(records(f)[0]).binding, before.binding);
  await next.close(state.handle);
  await assert.rejects(next.open('lane', 'unexpected-session'), (e: AgentRuntimeError) => e.code === 'session_mismatch');
  writeFileSync(records(f)[0], '{bad-json');
  await assert.rejects(next.open('lane'), (e: AgentRuntimeError) => e.code === 'binding_invalid');
  assert.equal(readdirSync(f.dirs.sessions).length, 1);
});

test('wire bounds, LF-only framing, unsupported capabilities and readonly descriptor', { timeout: 20_000 }, async t => {
  const f = setup();
  for (const capability of ['ask-agent', 'collaboration', 'fast', 'subagent', 'cron', 'media', 'outbox']) {
    assert.throws(() => validateAgentRuntimeDescriptor({ ...f.descriptor, capabilities: [capability] }), (e: AgentRuntimeError) => e.code === 'unsupported_capability');
  }
  assert.equal(loadAgentRuntimeDescriptor(f.path).agentId, f.descriptor.agentId);
  chmodSync(f.path, 0o644); assert.throws(() => loadAgentRuntimeDescriptor(f.path), /not worker writable/); chmodSync(f.path, 0o444);
  const splitter = new NewlineOnlyJsonlSplitter(12);
  assert.deepEqual(splitter.push('"a\u2028b"\n'), ['"a\u2028b"']);
  assert.throws(() => splitter.push('a'.repeat(13)), /byte limit/);
  await launch(t, f);
  const socket = createConnection(f.descriptor.socketPath);
  t.after(() => socket.destroy());
  const received: Buffer[] = []; socket.on('data', b => received.push(Buffer.from(b))); socket.on('error', () => {});
  await new Promise<void>(resolve => socket.once('connect', resolve));
  socket.write('a'.repeat(AGENT_RUNTIME_MAX_FRAME_BYTES + 1));
  await until(() => socket.destroyed);
  assert.match(Buffer.concat(received).toString(), /invalid_frame/);
  const client = await AgentRuntimeClient.connect(f.descriptor.socketPath); t.after(() => client.disconnect());
  const state = await client.open('lane');
  assert.throws(() => client.prompt(state.handle, 'huge', 'a'.repeat(AGENT_RUNTIME_MAX_FRAME_BYTES)), (e: AgentRuntimeError) => e.code === 'frame_too_large');
  assert.equal((await client.getState(state.handle)).phase, 'ready');
});

test('client deadline reports uncertain outcome and disconnect cleanup allows reopening without replay', { timeout: 30_000 }, async t => {
  const f = setup(); await launch(t, f);
  const client = await AgentRuntimeClient.connect(f.descriptor.socketPath); t.after(() => client.disconnect());
  const opened = await client.open('lane');
  const prompt = client.prompt(opened.handle, 'deadline-request', 'WAIT', undefined, 500);
  await prompt.accepted;
  await assert.rejects(prompt.completed, AgentRuntimeUncertainError);
  const observer = await AgentRuntimeClient.connect(f.descriptor.socketPath); t.after(() => observer.disconnect());
  const deadline = Date.now() + 6_000;
  while ((await observer.getState(opened.handle)).phase !== 'closed') {
    assert.ok(Date.now() < deadline); await delay(20);
  }
  const reopened = await observer.open('lane', opened.handle.sessionId);
  assert.deepEqual(reopened.request, { requestId: 'deadline-request', outcome: 'interrupted' });
});
