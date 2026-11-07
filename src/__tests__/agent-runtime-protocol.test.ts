import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex, PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { AgentRuntimePi } from '../agent-runtime-pi.js';
import type { Socket } from 'node:net';
import { AgentRuntimeClient } from '../agent-runtime-client.js';
import { AgentRuntimeWorker } from '../agent-runtime-worker.js';
import { validateAgentRuntimeDescriptor, type AgentRuntimeDescriptor } from '../agent-runtime-descriptor.js';
import { NewlineOnlyJsonlSplitter } from '../pi-rpc-protocol.js';
import { AgentRuntimeError, AgentRuntimeUncertainError, AGENT_RUNTIME_MAX_FRAME_BYTES, AGENT_RUNTIME_PROMPT_TIMEOUT_MS, AGENT_RUNTIME_CLIENT_PROMPT_TIMEOUT_MS, type AgentLaneState } from '../agent-runtime-protocol.js';

// Wire-unit tests only: OS socket/process proof lives in agent-runtime.test.ts.
class Wire extends Duplex {
  readonly frames: Array<{ id: string; code?: string }> = [];
  _read(): void {}
  _write(chunk: Buffer, _encoding: string, callback: (error?: Error | null) => void): void {
    this.frames.push(JSON.parse(chunk.toString())); callback();
  }
  destroySoon(): void { this.destroy(); }
  incoming(message: object): void { this.emit('data', Buffer.from(JSON.stringify(message) + '\n')); }
}
const descriptor: AgentRuntimeDescriptor = {
  version: 1, agentId: 'fixture-agent', workerUid: process.getuid!(), workerGid: process.getgid!(), controllerUid: process.getuid!(),
  controllerName: 'fixture-controller', home: '/synthetic/home', workspace: '/synthetic/workspace', stateRoot: '/synthetic/state',
  sessionRoot: '/synthetic/sessions', contextRoot: '/synthetic/context', socketDirectory: '/synthetic/socket', socketPath: '/synthetic/socket/worker.sock',
  model: 'fixture/model', thinking: 'off', knowledge: 'none', capabilities: [], tools: [], offline: true,
};
const state: AgentLaneState = { handle: { agentId: 'fixture-agent', laneId: 'lane', sessionId: 'opaque-session', generation: 1 }, phase: 'ready' };
function attachClient(wire: Wire): AgentRuntimeClient { return Reflect.construct(AgentRuntimeClient, [wire, 1_000]) as AgentRuntimeClient; }
function attachWorker(wire: Wire): AgentRuntimeWorker {
  const worker = new AgentRuntimeWorker(descriptor);
  (worker as unknown as { accept(socket: Socket): void }).accept(wire as unknown as Socket);
  return worker;
}

test('controller wire correlates acceptance, stream, settlement and typed errors without resend', async t => {
  const wire = new Wire(); const client = attachClient(wire); t.after(() => client.disconnect());
  const opened = client.open('lane');
  const openId = wire.frames[0].id;
  wire.incoming({ version: 1, type: 'response', id: 'unrelated', state });
  wire.incoming({ version: 1, type: 'response', id: openId, state });
  assert.deepEqual(await opened, state);
  const events: unknown[] = [];
  const prompt = client.prompt(state.handle, 'request-1', 'synthetic prompt', e => events.push(e));
  const promptId = wire.frames[1].id;
  const accepted = { ...state, phase: 'prompting', request: { requestId: 'request-1', outcome: 'accepted' } };
  wire.incoming({ version: 1, type: 'response', id: promptId, state: accepted });
  assert.deepEqual(await prompt.accepted, accepted);
  wire.incoming({ version: 1, type: 'event', id: promptId, requestId: 'request-1', event: { type: 'stream_event', event: { type: 'content_block_delta', delta: {type: 'text_delta', text: 'receipt' } } } });
  const settled = { ...state, request: { requestId: 'request-1', outcome: 'settled' } };
  wire.incoming({ version: 1, type: 'finished', id: promptId, state: settled });
  assert.deepEqual(await prompt.completed, settled);
  assert.equal(events.length, 1);
  const rejected = client.getState(state.handle);
  wire.incoming({ version: 1, type: 'error', id: wire.frames[2].id, code: 'stale_handle', message: 'Stale lane' });
  await assert.rejects(rejected, (e: AgentRuntimeError) => e.code === 'stale_handle');
  assert.equal(wire.frames.length, 3);
});

test('controller deadline and disconnect reject pending prompt as uncertain, with no implicit retry', async () => {
  for (const deadline of [false, true]) {
    const wire = new Wire(); const client = attachClient(wire);
    const pending = client.prompt(state.handle, 'uncertain-request', 'synthetic prompt', undefined, 20);
    const rejected = assert.rejects(pending.completed, AgentRuntimeUncertainError);
    if (!deadline) client.disconnect();
    await rejected;
    assert.equal(wire.frames.length, 1);
    assert.equal(wire.destroyed, true);
  }
});

test('controller rejects oversized frames before writing any request', () => {
  const wire = new Wire(); const client = attachClient(wire);
  assert.throws(() => client.prompt(state.handle, 'oversized', 'a'.repeat(AGENT_RUNTIME_MAX_FRAME_BYTES)), (e: AgentRuntimeError) => e.code === 'frame_too_large');
  assert.throws(() => client.open('lane', ''), (e: AgentRuntimeError) => e.code === 'invalid_request');
  assert.equal(wire.frames.length, 0); client.disconnect();
});

test('worker rejects malformed/oversized frames and IPC spawn knobs; LF-only Unicode is preserved', async t => {
  for (const payload of ['{invalid}\n', 'a'.repeat(AGENT_RUNTIME_MAX_FRAME_BYTES + 1), JSON.stringify({ version: 1, id: 'bad-knob', op: 'open', laneId: 'lane', extensions: ['/synthetic/extension'] }) + '\n']) {
    const wire = new Wire(); const worker = attachWorker(wire); t.after(() => worker.shutdown());
    wire.emit('data', Buffer.from(payload));
    assert.equal(wire.frames[0].code, 'invalid_frame');
    assert.equal(wire.destroyed, true);
  }
  const wire = new Wire(); const worker = attachWorker(wire); t.after(() => { wire.destroy(); return worker.shutdown(); });
  wire.incoming({ version: 1, id: 'unicode', op: 'getState', handle: { ...state.handle, laneId: 'lane\u2028separator\u2029' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wire.frames[0].code, 'stale_handle');
  const bounded = new NewlineOnlyJsonlSplitter(4);
  assert.deepEqual(bounded.push(Buffer.from('éé\n')), ['éé']);
  assert.throws(() => bounded.push('ééé'), /byte limit/);
});

test('worker rejects incomplete frames at a finite deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new Wire(); const worker = attachWorker(wire); t.after(() => worker.shutdown());
  wire.emit('data', Buffer.from('{'));
  t.mock.timers.tick(5_001);
  assert.equal(wire.frames[0].code, 'invalid_frame');
  assert.equal(wire.destroyed, true);
});

test('descriptor explicitly rejects unsupported capabilities, ambient knobs and root worker', () => {
  for (const capability of ['ask-agent', 'collaboration', 'fast', 'subagent', 'cron', 'media', 'outbox', 'web', 'knowledge-tools']) {
    assert.throws(() => validateAgentRuntimeDescriptor({ ...descriptor, capabilities: [capability] }), (e: AgentRuntimeError) => e.code === 'unsupported_capability');
  }
  assert.throws(() => validateAgentRuntimeDescriptor({ ...descriptor, workerUid: 0 }), /nonroot/);
  assert.throws(() => validateAgentRuntimeDescriptor({ ...descriptor, env: {} }), /Unsupported worker descriptor field/);
  assert.throws(() => validateAgentRuntimeDescriptor({ ...descriptor, model: '' }), /Explicit model/);
});

test('descriptor identity fields require strings before regex validation', () => {
  for (const field of ['agentId', 'controllerName']) {
    for (const value of [undefined, null, 123]) {
      assert.throws(() => validateAgentRuntimeDescriptor({ ...descriptor, [field]: value }), /identity|controller name/);
    }
  }
});

test('callback exceptions reject only that prompt and later frames and other lanes remain usable', async t => {
  const wire = new Wire(); const client = attachClient(wire); t.after(() => client.disconnect());
  const original = new Error('synthetic callback failure');
  const failed = client.prompt(state.handle, 'callback-throws', 'synthetic', () => { throw original; });
  const otherState = { ...state, handle: { ...state.handle, laneId: 'other' } };
  const other = client.prompt(otherState.handle, 'other-request', 'synthetic');
  const failedId = wire.frames[0].id; const otherId = wire.frames[1].id;
  wire.incoming({ version: 1, type: 'response', id: failedId, state });
  wire.incoming({ version: 1, type: 'response', id: otherId, state: otherState });
  await failed.accepted; await other.accepted;
  const rejected = assert.rejects(failed.completed, e => e === original);
  // One chunk exercises continued parsing after the callback throws.
  wire.emit('data', Buffer.from([
    { version: 1, type: 'event', id: failedId, event: { type: 'result', result: 'receipt' } },
    { version: 1, type: 'finished', id: failedId, state },
    { version: 1, type: 'finished', id: otherId, state: otherState },
  ].map(m => JSON.stringify(m) + '\n').join('')));
  await rejected;
  assert.deepEqual(await other.completed, otherState);
  const query = client.getState(state.handle);
  wire.incoming({ version: 1, type: 'response', id: wire.frames[2].id, state });
  assert.deepEqual(await query, state);
  assert.equal(wire.destroyed, false);
});

test('default client prompt deadline leaves room for worker timeout cleanup and outcome delivery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wire = new Wire(); const client = attachClient(wire); t.after(() => client.disconnect());
  const prompt = client.prompt(state.handle, 'worker-timeout', 'synthetic');
  const id = wire.frames[0].id;
  wire.incoming({ version: 1, type: 'response', id, state });
  await prompt.accepted;
  assert.equal(AGENT_RUNTIME_CLIENT_PROMPT_TIMEOUT_MS - AGENT_RUNTIME_PROMPT_TIMEOUT_MS, 10_000);
  t.mock.timers.tick(AGENT_RUNTIME_PROMPT_TIMEOUT_MS + 3_000);
  assert.equal(wire.destroyed, false);
  const interrupted = { ...state, phase: 'closing', request: { requestId: 'worker-timeout', outcome: 'interrupted' } };
  wire.incoming({ version: 1, type: 'finished', id, state: interrupted });
  assert.deepEqual(await prompt.completed, interrupted);
  t.mock.timers.tick(10_000);
  assert.equal(wire.destroyed, false);
});

test('raw Pi agent_end larger than the controller frame bound normalizes small and settles', async () => {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const commands: Array<{ id: string }> = [];
  Object.assign(child, { stdout, stderr: new PassThrough(),
    stdin: new Writable({ write(chunk, _encoding, callback) { commands.push(JSON.parse(String(chunk))); callback(); } }) });
  const binding = { workspaceRealpath: '/synthetic/workspace', sessionDirectory: '/synthetic/sessions',
    sessionId: 'synthetic-session', sessionFile: '/synthetic/sessions/session.jsonl' };
  const pi = new AgentRuntimePi(child, binding, 1_000, { model: 'fixture/model', thinking: 'off' });
  stdout.write(JSON.stringify({ type: 'response', command: 'get_state', id: commands[0].id, success: true,
    data: { ...binding, model: { provider: 'fixture', id: 'model' }, thinkingLevel: 'off' } }) + '\n');
  await pi.ready;
  const events: unknown[] = [];
  const prompt = pi.prompt('large-record', 'synthetic', event => events.push(event));
  const raw = JSON.stringify({ type: 'agent_end', messages: [
    { role: 'toolResult', content: [{ type: 'image', data: 'a'.repeat(AGENT_RUNTIME_MAX_FRAME_BYTES + 1), mimeType: 'image/png' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'small receipt' }], stopReason: 'stop' },
  ] }) + '\n';
  assert.ok(Buffer.byteLength(raw) > AGENT_RUNTIME_MAX_FRAME_BYTES);
  stdout.write(raw.slice(0, 500_000)); stdout.write(raw.slice(500_000));
  assert.equal(events.length, 0);
  stdout.write('{"type":"agent_settled"}\n');
  await prompt;
  assert.deepEqual(events, [{ type: 'result', result: 'small receipt', session_id: '' }]);
  child.emit('close', 0);
});
