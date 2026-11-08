import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntimeWorker } from '../agent-runtime-worker.js';
import { AgentRuntimePi } from '../agent-runtime-pi.js';
import { WorkerLaneStore, type WorkerLaneRecord } from '../agent-runtime-store.js';
import type { AgentRuntimeDescriptor } from '../agent-runtime-descriptor.js';
import { AgentRuntimeError, type AgentLaneState, type AgentRuntimeMessage, type AgentRuntimeOperation } from '../agent-runtime-protocol.js';
import { generateKnowledgeV2Schema } from '../knowledge/layout.js';

// Direct core tests also run in socket-restricted environments. They provide no endpoint evidence.
function fixture(extension = 'provider.mjs', startupTimeoutMs = 10_000, model = 'worker-offline/fixture') {
  const root = realpathSync(mkdtempSync('/tmp/arc-'));
  for (const name of ['home', 'workspace', 'state', 'sessions', 'context', 'socket']) mkdirSync(join(root, name), { mode: 0o700 });
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, '.claude/rules/custom'), { recursive: true });
  mkdirSync(join(workspace, 'wiki'));
  writeFileSync(join(workspace, 'CLAUDE.md'), 'SYNTHETIC_LOCAL_CONTEXT\n@local.md\n');
  writeFileSync(join(workspace, 'local.md'), 'SYNTHETIC_IMPORTED_CONTEXT\n');
  writeFileSync(join(workspace, '.claude/rules/custom/test.md'), 'SYNTHETIC_RULE_CONTEXT\n');
  writeFileSync(join(workspace, 'wiki/schema.md'), generateKnowledgeV2Schema());
  writeFileSync(join(workspace, 'wiki/index.md'), 'SYNTHETIC_KNOWLEDGE_INDEX\n');
  const d: AgentRuntimeDescriptor = { version: 1, agentId: 'fixture-agent', workerUid: process.getuid!(), workerGid: process.getgid!(),
    home: join(root, 'home'), controllerUid: process.getuid!(), controllerName: 'fixture-controller', workspace,
    stateRoot: join(root, 'state'), sessionRoot: join(root, 'sessions'), contextRoot: join(root, 'context'),
    socketDirectory: join(root, 'socket'), socketPath: join(root, 'socket', 'worker.sock'), model, thinking: 'off',
    knowledge: 'v2', capabilities: ['local-tools'], tools: ['bash'], offline: true };
  const worker = new AgentRuntimeWorker(d, { trustedTestExtensions: [realpathSync(resolve('test-fixtures/agent-runtime', extension))], startupTimeoutMs });
  const messages: AgentRuntimeMessage[] = [];
  // A controller output sink, not a ChildProcess proxy or substitute Pi runtime.
  const owner = { destroyed: false, writable: true, writableLength: 0, write(frame: string) { messages.push(JSON.parse(frame)); return true; } } as unknown as Socket;
  const dispatch = (request: AgentRuntimeOperation) =>
    (worker as unknown as { dispatch(r: object, owner: Socket): Promise<void> }).dispatch({ ...request, version: 1, id: String(messages.length) }, owner);
  const open = async (expectedSessionId?: string) => {
    await dispatch({ op: 'open', laneId: 'lane', expectedSessionId });
    return (messages.at(-1) as {state: AgentLaneState}).state;
  };
  const recordPath = () => join(d.stateRoot, 'lanes', readdirSync(join(d.stateRoot, 'lanes'))[0], 'binding.json');
  return { d, root, worker, messages, owner, dispatch, open, recordPath };
}
async function until<T>(read: () => T | undefined | false, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const result = read(); if (result) return result; await delay(20); }
  throw new Error('Bounded core fixture deadline exceeded');
}
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('direct worker core: real tools/context, durable binding, close/restart history and native settlement', { timeout: 45_000 }, async t => {
  const f = fixture(); t.after(() => f.worker.shutdown());
  const opened = await f.open();
  assert.equal(json(join(f.d.workspace, 'started.json')).bindingVisible, true);
  assert.equal(json(join(f.d.workspace, 'started.json')).noCentralEnv, true);
  const before = json(f.recordPath());
  assert.equal(before.contextManifest.digest, opened.contextDigest);
  assert.equal(JSON.stringify(before.contextManifest).includes(f.root), false);
  let completed = false;
  const prompt = f.dispatch({ op: 'prompt', handle: opened.handle, requestId: 'write', text: 'WRITE durable-marker' }).then(() => { completed = true; });
  await until(() => existsSync(join(f.d.workspace, 'settling.json')));
  assert.equal(completed, false, 'agent_end alone must not complete the worker prompt');
  await prompt;
  assert.equal(readFileSync(join(f.d.workspace, 'marker.txt'), 'utf8'), 'durable-marker');
  assert.ok(f.messages.some(m => m.type === 'event' && m.event.type === 'result' && JSON.stringify(m.event).includes('\\"context\\":true')));
  assert.ok(f.messages.some(m => m.type === 'event' && m.event.type === 'stream_event' && m.event.event.delta?.type === 'text_delta'));
  assert.equal(json(f.recordPath()).request.outcome, 'settled');
  await f.dispatch({ op: 'close', handle: opened.handle });
  await f.worker.shutdown();
  const restarted = new AgentRuntimeWorker(f.d, { trustedTestExtensions: [realpathSync(resolve('test-fixtures/agent-runtime/provider.mjs'))] });
  t.after(() => restarted.shutdown());
  const dispatch = (r: object) => (restarted as unknown as { dispatch(r: object, owner: Socket): Promise<void> }).dispatch({ ...r, version: 1, id: 'restart' }, f.owner);
  await dispatch({ op: 'open', laneId: 'lane', expectedSessionId: opened.handle.sessionId });
  const resumed = (f.messages.at(-1) as {state: AgentLaneState}).state;
  assert.equal(resumed.handle.sessionId, opened.handle.sessionId);
  assert.equal(resumed.handle.generation, opened.handle.generation + 1);
  assert.deepEqual(json(f.recordPath()).binding, before.binding);
  await assert.rejects(dispatch({ op: 'getState', handle: opened.handle }), (e: AgentRuntimeError) => e.code === 'stale_handle');
  await dispatch({ op: 'prompt', handle: resumed.handle, requestId: 'history', text: 'HISTORY' });
  assert.ok(f.messages.some(m => m.type === 'event' && m.event.type === 'result' && JSON.stringify(m.event).includes('priorMarker') && JSON.stringify(m.event).includes('durable-marker')));
});

test('direct worker core: concurrency rejects, abort reaps owned Pi/tool and next prompt works', { timeout: 40_000 }, async t => {
  const f = fixture(); t.after(() => f.worker.shutdown()); const opened = await f.open();
  const pending = f.dispatch({ op: 'prompt', handle: opened.handle, requestId: 'wait', text: 'WAIT' });
  const sleeper = await until(() => existsSync(join(f.d.workspace, 'sleeper.json')) && json(join(f.d.workspace, 'sleeper.json')));
  assert.equal(json(f.recordPath()).request.outcome, 'accepted');
  const piPid = json(join(f.d.workspace, 'started.json')).pid;
  await assert.rejects(f.dispatch({ op: 'prompt', handle: opened.handle, requestId: 'collision', text: 'HISTORY' }), (e: AgentRuntimeError) => e.code === 'busy');
  await f.dispatch({ op: 'abort', handle: opened.handle, requestId: 'wait' });
  await pending;
  await until(() => !alive(sleeper.pid) && !alive(piPid));
  assert.equal(json(f.recordPath()).request.outcome, 'interrupted');
  await f.dispatch({ op: 'prompt', handle: opened.handle, requestId: 'next', text: 'WRITE after-abort' });
  assert.equal(json(f.recordPath()).request.outcome, 'settled');
});

test('direct worker core: strict context fails before spawn; timeout preserves exact binding; missing/corrupt evidence rejects', { timeout: 35_000 }, async t => {
  const missing = fixture(); t.after(() => missing.worker.shutdown());
  renameSync(join(missing.d.workspace, 'CLAUDE.md'), join(missing.root, 'unused.md'));
  await assert.rejects(missing.open(), (e: AgentRuntimeError) => e.code === 'context_invalid');
  assert.equal(readdirSync(missing.d.sessionRoot).length, 0);
  assert.equal(existsSync(join(missing.d.stateRoot, 'lanes')), false);
  const external = fixture(); t.after(() => external.worker.shutdown());
  symlinkSync(external.root, join(external.d.workspace, '.claude/rules/platform'));
  await assert.rejects(external.open(), (e: AgentRuntimeError) => e.code === 'context_invalid');
  const blocked = fixture('blocked-startup.mjs', 2_000); t.after(() => blocked.worker.shutdown());
  await assert.rejects(blocked.open(), (e: AgentRuntimeError) => e.code === 'startup_timeout');
  const before = json(blocked.recordPath());
  assert.equal(alive(json(join(blocked.d.workspace, 'blocked-pid.json')).pid), false);
  await assert.rejects(blocked.open(before.binding.sessionId), (e: AgentRuntimeError) => e.code === 'startup_timeout');
  assert.deepEqual(json(blocked.recordPath()).binding, before.binding);
  renameSync(blocked.recordPath(), join(blocked.root, 'missing-binding.json'));
  await assert.rejects(blocked.open(), (e: AgentRuntimeError) => e.code === 'binding_invalid');
  writeFileSync(blocked.recordPath(), '{broken', { mode: 0o600 });
  await assert.rejects(blocked.open(), (e: AgentRuntimeError) => e.code === 'binding_invalid');
  assert.equal(readdirSync(blocked.d.sessionRoot).length, 1);
});

test('direct worker core rejects Pi fuzzy-model fallback instead of silently changing descriptor intent', { timeout: 15_000 }, async t => {
  const f = fixture('provider.mjs', 10_000, 'worker-offline/fix'); t.after(() => f.worker.shutdown());
  await assert.rejects(f.open(), (e: AgentRuntimeError) => e.code === 'model_mismatch');
  assert.equal(alive(json(join(f.d.workspace, 'started.json')).pid), false);
  assert.equal(readdirSync(f.d.sessionRoot).length, 1);
});

test('direct worker core still reaps active Pi/tools when interrupted-state persistence fails', { timeout: 20_000 }, async t => {
  const f = fixture(); t.after(() => f.worker.shutdown()); const opened = await f.open();
  const pending = f.dispatch({ op: 'prompt', handle: opened.handle, requestId: 'wait', text: 'WAIT' });
  const sleeper = await until(() => existsSync(join(f.d.workspace, 'sleeper.json')) && json(join(f.d.workspace, 'sleeper.json')));
  const piPid = json(join(f.d.workspace, 'started.json')).pid;
  const save = WorkerLaneStore.prototype.save;
  const injected = t.mock.method(WorkerLaneStore.prototype, 'save', function(this: WorkerLaneStore, record: WorkerLaneRecord) {
    if (record.request?.outcome === 'interrupted') throw new Error('synthetic-persistence-failure');
    return save.call(this, record);
  });
  const rejected = assert.rejects(pending, /synthetic-persistence-failure/);
  await assert.rejects(f.dispatch({ op: 'close', handle: opened.handle }), /synthetic-persistence-failure/);
  await rejected;
  await until(() => !alive(sleeper.pid) && !alive(piPid));
  injected.mock.restore();
});

for (const cleanupFails of [false, true]) {
  test(`settlement-save failure closes the lane and preserves its binding (cleanup error: ${cleanupFails})`, { timeout: 20_000 }, async t => {
    const f = fixture(); t.after(() => f.worker.shutdown()); const opened = await f.open();
    const before = json(f.recordPath());
    const piPid = json(join(f.d.workspace, 'started.json')).pid;
    const persistenceError = new Error('synthetic-settlement-save-failure');
    const save = WorkerLaneStore.prototype.save;
    const injectedSave = t.mock.method(WorkerLaneStore.prototype, 'save', function(this: WorkerLaneStore, record: WorkerLaneRecord) {
      if (record.request?.outcome === 'settled') throw persistenceError;
      return save.call(this, record);
    });
    const stop = AgentRuntimePi.prototype.stop;
    const injectedStop = t.mock.method(AgentRuntimePi.prototype, 'stop', async function(this: AgentRuntimePi) {
      await stop.call(this);
      if (cleanupFails) throw new Error('synthetic-cleanup-failure');
    });
    await assert.rejects(f.dispatch({ op: 'prompt', handle: opened.handle, requestId: 'write', text: 'WRITE saved-marker' }),
      error => error === persistenceError);
    await until(() => !alive(piPid), 4_000);
    assert.equal(json(f.recordPath()).request.outcome, 'accepted', 'failed settlement save retains durable uncertainty');
    assert.equal(f.messages.some(m => m.type === 'finished'), false);
    await f.dispatch({ op: 'getState', handle: opened.handle });
    const closed = (f.messages.at(-1) as { state: AgentLaneState }).state;
    assert.equal(closed.phase, 'closed');
    assert.equal(closed.request?.outcome, 'interrupted');
    const lane = (f.worker as unknown as { lanes: Map<string, { owner?: Socket; pi?: AgentRuntimePi; promptDone?: Promise<void> }> }).lanes.get('lane')!;
    assert.equal(lane.owner, undefined);
    assert.equal(lane.pi, undefined);
    assert.equal(lane.promptDone, undefined);
    injectedSave.mock.restore();
    injectedStop.mock.restore();
    const reopened = await f.open(opened.handle.sessionId);
    assert.equal(reopened.phase, 'ready');
    assert.equal(reopened.handle.sessionId, opened.handle.sessionId);
    assert.equal(reopened.handle.generation, opened.handle.generation + 1);
    assert.equal(reopened.request?.outcome, 'interrupted');
    assert.deepEqual(json(f.recordPath()).binding, before.binding);
    await f.dispatch({ op: 'prompt', handle: reopened.handle, requestId: 'history', text: 'HISTORY' });
    assert.equal(json(f.recordPath()).request.outcome, 'settled');
    assert.ok(f.messages.some(m => m.type === 'event' && m.event.type === 'result' && JSON.stringify(m.event).includes('priorMarker') && JSON.stringify(m.event).includes('saved-marker')));
  });
}

test('prepared worker Pi suppresses ambient SYSTEM.md while retaining its default provider prompt', { timeout: 20_000 }, async t => {
  const f = fixture(); t.after(() => f.worker.shutdown());
  mkdirSync(join(f.d.stateRoot, 'pi'), { mode: 0o700 });
  writeFileSync(join(f.d.stateRoot, 'pi', 'SYSTEM.md'), 'SYNTHETIC_AMBIENT_SYSTEM_SENTINEL');
  const opened = await f.open();
  await f.dispatch({ op: 'prompt', handle: opened.handle, requestId: 'context', text: 'CONTEXT' });
  const result = [...f.messages].reverse().find(m => m.type === 'event' && m.event.type === 'result');
  assert.ok(result?.type === 'event' && result.event.type === 'result');
  assert.deepEqual(JSON.parse(result.event.result!), { sentinel: false, defaultPrompt: true, before: false, after: false });
});

test('public close rejects abort cleanup and reopen transitions instead of reporting a closed lane', { timeout: 25_000 }, async t => {
  const f = fixture(); t.after(() => f.worker.shutdown());
  const opened = await f.open();
  const pending = f.dispatch({ op: 'prompt', handle: opened.handle, requestId: 'wait', text: 'WAIT' });
  await until(() => existsSync(join(f.d.workspace, 'sleeper.json')));
  const runtime = f.worker as unknown as { startPi(lane: unknown): Promise<void> };
  const startPi = runtime.startPi.bind(runtime);
  let release!: () => void;
  let reopening = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(runtime, 'startPi', async (lane: unknown) => { reopening = true; await gate; await startPi(lane); });
  t.after(release);
  const abort = f.dispatch({ op: 'abort', handle: opened.handle, requestId: 'wait' });
  await assert.rejects(f.dispatch({ op: 'close', handle: opened.handle }), (e: AgentRuntimeError) => e.code === 'busy');
  await until(() => reopening);
  await assert.rejects(f.dispatch({ op: 'close', handle: opened.handle }), (e: AgentRuntimeError) => e.code === 'busy');
  release(); await abort; await pending;
  assert.equal((f.messages.at(-1) as { state: AgentLaneState }).state.phase, 'ready');
  await f.dispatch({ op: 'close', handle: opened.handle });
  assert.equal((f.messages.at(-1) as { state: AgentLaneState }).state.phase, 'closed');
});

test('overlapping different-lane opens keep their own artifacts and manifest after source edits', { timeout: 30_000 }, async t => {
  const f = fixture(); t.after(() => f.worker.shutdown());
  writeFileSync(join(f.d.workspace, 'CLAUDE.md'), 'SYNTHETIC_LANE_BEFORE\n');
  const runtime = f.worker as unknown as { startPi(lane: { record: WorkerLaneRecord }): Promise<void> };
  const startPi = runtime.startPi.bind(runtime);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.after(release);
  t.mock.method(runtime, 'startPi', async (lane: { record: WorkerLaneRecord }) => {
    if (lane.record.laneId === 'before') await gate;
    await startPi(lane);
  });
  const firstOpen = f.dispatch({ op: 'open', laneId: 'before' });
  // The first lane is awaiting spawn; the second assembles edited source first.
  writeFileSync(join(f.d.workspace, 'CLAUDE.md'), 'SYNTHETIC_LANE_AFTER\n');
  await f.dispatch({ op: 'open', laneId: 'after' });
  const after = (f.messages.at(-1) as { state: AgentLaneState }).state;
  release(); await firstOpen;
  const before = (f.messages.at(-1) as { state: AgentLaneState }).state;
  assert.notEqual(before.contextDigest, after.contextDigest);
  for (const [opened, expected] of [[before, { before: true, after: false }], [after, { before: false, after: true }]] as const) {
    const store = new WorkerLaneStore(join(f.d.stateRoot, 'lanes'), f.d.agentId, opened.handle.laneId, true);
    assert.equal(store.load().contextManifest?.digest, opened.contextDigest);
    await f.dispatch({ op: 'prompt', handle: opened.handle, requestId: 'context', text: 'CONTEXT' });
    const result = [...f.messages].reverse().find(m => m.type === 'event' && m.event.type === 'result');
    assert.ok(result?.type === 'event' && result.event.type === 'result');
    assert.deepEqual(JSON.parse(result.event.result!), { sentinel: false, defaultPrompt: true, ...expected });
  }
});

test('owner-private binding can save, load and reopen a valid context manifest larger than 64KiB', { timeout: 30_000 }, async t => {
  const f = fixture(); t.after(() => f.worker.shutdown());
  mkdirSync(join(f.d.workspace, 'sources'));
  const imports = Array.from({ length: 600 }, (_, i) => {
    const name = `sources/synthetic-source-${i}.md`;
    writeFileSync(join(f.d.workspace, name), `SYNTHETIC_SOURCE_${i}\n`);
    return `@${name}`;
  });
  writeFileSync(join(f.d.workspace, 'CLAUDE.md'), imports.join('\n') + '\n');
  const opened = await f.open();
  const store = new WorkerLaneStore(join(f.d.stateRoot, 'lanes'), f.d.agentId, 'lane', true);
  const record = store.load();
  assert.ok(Buffer.byteLength(JSON.stringify(record.contextManifest)) > 64 * 1024);
  store.save(record);
  assert.deepEqual(store.load(), record);
  await f.dispatch({ op: 'close', handle: opened.handle });
  const reopened = await f.open(opened.handle.sessionId);
  assert.equal(reopened.handle.sessionId, opened.handle.sessionId);
  assert.equal(reopened.contextDigest, opened.contextDigest);
});
