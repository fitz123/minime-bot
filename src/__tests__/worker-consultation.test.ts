import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { mock, test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as descriptorModule from '../agent-runtime-descriptor.js';
import { AGENT_RUNTIME_CLIENT_PROMPT_TIMEOUT_MS } from '../agent-runtime-protocol.js';
import { generateKnowledgeV2Schema } from '../knowledge/layout.js';
import type { AgentConfig } from '../types.js';
import {
  alive, assertConsultationClean, consultationFixture, consultationPromptCount, consultationProvider,
  consultationStarted, until,
} from './fixtures/consultation-worker.js';

// Protocol and real-Pi coverage on a host without socket listen permission.
// The protected OS-socket discriminator lives in ask-agent-offline.test.ts.
class Wire extends EventEmitter {
  peer!: Wire;
  destroyed = false;
  writable = true;
  writableLength = 0;
  frames: Array<Record<string, unknown>> = [];
  write(frame: string): boolean {
    this.frames.push(JSON.parse(frame));
    queueMicrotask(() => { if (!this.peer.destroyed) this.peer.emit('data', Buffer.from(frame)); });
    return true;
  }
  pause() {}
  end() { queueMicrotask(() => this.destroy()); }
  destroySoon() { this.end(); }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.writable = false;
    this.peer.destroy();
    queueMicrotask(() => this.emit('close'));
  }
}

let connect: () => Wire;
mock.module('node:net', { namedExports: { createServer, createConnection: () => connect() } });
mock.module('../agent-runtime-descriptor.js', { namedExports: { ...descriptorModule, verifyAgentRuntimeEndpoint() {} } });
const { AgentRuntimeWorker } = await import('../agent-runtime-worker.js');
const { AgentRuntimeClient } = await import('../agent-runtime-client.js');
const { executeAskAgent } = await import('../pi-extensions/ask-agent-args.js');
const { MINIME_BOT_PI_SESSION_AGENT_ID_ENV } = await import('../pi-rpc-protocol.js');
const { validateWorkerRuntime } = await import('../config.js');

function setup(t: TestContext, options: {
  enabled?: boolean; timeout?: number; knowledge?: boolean;
  model?: string; thinking?: descriptorModule.AgentRuntimeDescriptor['thinking'];
} = {}) {
  const d = consultationFixture(t);
  if (options.model) d.model = options.model;
  if (options.thinking) d.thinking = options.thinking;
  if (options.enabled === false) d.capabilities = ['local-tools'];
  if (options.knowledge) {
    d.capabilities = [...d.capabilities, 'knowledge-tools'];
    d.knowledge = 'v2';
    mkdirSync(join(d.workspace, 'wiki'));
    writeFileSync(join(d.workspace, 'wiki/schema.md'), generateKnowledgeV2Schema());
    writeFileSync(join(d.workspace, 'wiki/index.md'), 'Synthetic index\n');
  }
  const worker = new AgentRuntimeWorker(d, { trustedTestExtensions: [consultationProvider], promptTimeoutMs: options.timeout });
  const callerId = 'fixture-caller';
  const targetId = d.agentId;
  const route = { socketPath: d.socketPath, workerUid: d.workerUid, controllerName: d.controllerName, inboundConsultation: true };
  const agents: Record<string, AgentConfig> = {
    [callerId]: { id: callerId, workspaceCwd: join(d.home, 'unused-caller'), model: 'unused/model',
      askAgent: { enabled: true, canAsk: [targetId] } },
    [targetId]: { id: targetId, workspaceCwd: join(d.home, 'unused-target'), model: 'unused/model',
      askAgent: { enabled: true }, workerRuntime: route },
  };
  const connections: Wire[] = [];
  const wire = (accept = (socket: Wire) => (worker as unknown as { accept(socket: Socket): void }).accept(socket as unknown as Socket)) => {
    const client = new Wire(), server = new Wire();
    client.peer = server; server.peer = client;
    connections.push(client);
    accept(server);
    queueMicrotask(() => client.emit('connect'));
    return client;
  };
  connect = () => wire();
  t.after(async () => { for (const connection of connections) connection.destroy(); await worker.shutdown(); });
  const noLocalAccess = t.mock.fn(() => assert.fail('Unexpected local lookup, context assembly, or spawn'));
  const ask = (question = 'CONSULT_ONE', extra: object = {}, signal?: AbortSignal) =>
    executeAskAgent({ agent: targetId, question, ...extra }, {
      config: { agents }, env: { [MINIME_BOT_PI_SESSION_AGENT_ID_ENV]: callerId },
      validateTargetWorkspace: noLocalAccess, assembleContext: noLocalAccess, runTarget: noLocalAccess, signal,
    });
  return { ask, d, agents, callerId, targetId, route, connections, wire, noLocalAccess };
}

test('actual Pi consultation, chat and cron use one worker subscription with separate settings and no consultation transcript', { timeout: 15_000 }, async t => {
  const f = setup(t);
  const profile = join(f.d.stateRoot, 'pi');
  const settingsPath = join(profile, 'settings.json');
  const settings = readFileSync(settingsPath);
  assert.deepEqual(readdirSync(f.d.stateRoot), ['pi']);
  assert.deepEqual(readdirSync(profile).sort(), ['auth.json', 'settings.json']);
  mkdirSync(join(profile, 'extensions'));
  writeFileSync(join(profile, 'extensions', 'ambient.ts'), 'process.exit(92);\n');
  writeFileSync(join(profile, 'APPEND_SYSTEM.md'), 'SYNTHETIC_AMBIENT_SYSTEM\n');
  const profileFiles = readdirSync(profile, { recursive: true, encoding: 'utf8' }).sort();
  assert.deepEqual(await f.ask(), { ok: true, callerAgentId: f.callerId, targetAgentId: f.targetId,
    result: { answer: 'ISOLATED_TARGET_ANSWER', truncated: false, needsClarification: false } });
  assert.equal(f.noLocalAccess.mock.callCount(), 0);
  assert.equal(f.connections.length, 1);
  const [check, question] = f.connections[0].frames;
  assert.deepEqual(check, { op: 'consult_check', version: 1, id: check.id, expectedAgentId: f.targetId });
  assert.deepEqual(question, { op: 'consult', version: 1, id: check.id, question: 'CONSULT_ONE' });
  assert.equal(f.connections[0].frames.length, 2);
  assert.equal(consultationPromptCount(f.d), 1);
  const started = consultationStarted(f.d);
  assert.deepEqual(started.tools, ['ls', 'read']);
  assert.equal(started.noCentralEnv, true);
  assert.equal(started.noSession, true);
  assert.equal(started.autoRetry, false);
  assert.equal(started.autoCompaction, false);
  assert.equal(started.cacheWarming, 'off');
  assert.equal(alive(started.pid), false);
  assertConsultationClean(f.d);
  assert.deepEqual(readdirSync(profile, { recursive: true, encoding: 'utf8' }).sort(), profileFiles);
  assert.deepEqual(readFileSync(settingsPath), settings);

  const client = await AgentRuntimeClient.connect(f.d.socketPath, undefined, f.route);
  t.after(() => client.disconnect());
  for (const lane of [`chat-${'0'.repeat(64)}`, `cron-${randomUUID()}`]) {
    const { handle } = await client.open(lane, undefined, f.targetId);
    const normal = consultationStarted(f.d);
    assert.equal(normal.noSession, false);
    assert.equal(normal.autoRetry, true);
    assert.equal(normal.autoCompaction, true);
    let answer: string | undefined;
    const prompt = client.prompt(handle, randomUUID(), 'WORKER_PRIMARY', event => {
      if (event.type === 'result' && !event.is_error) answer = event.result;
    });
    await prompt.completed;
    assert.equal(answer, 'PRIMARY_PROFILE_ANSWER');
    await client.close(handle);
  }
  assert.deepEqual(readFileSync(settingsPath), settings);
  assert.equal(consultationPromptCount(f.d), 3);
});

const unlistedModelId = 'consultation-fixture/unlisted-preview:low';

test('consultation sends the unlisted literal model ID and configured thinking to its subscription provider', { timeout: 15_000 }, async t => {
  const f = setup(t, { model: `consultation-fixture/${unlistedModelId}`, thinking: 'high' });
  const result = await f.ask('CONSULT_ONE CONSULT_LITERAL');
  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(result.result.answer), {
    provider: 'consultation-fixture', id: unlistedModelId, reasoning: 'high',
  });
  assert.equal(consultationPromptCount(f.d), 1);
  const started = consultationStarted(f.d);
  assert.equal(started.noSession, true);
  assert.equal(alive(started.pid), false);
  assertConsultationClean(f.d);
});

for (const changedId of ['offlin', 'Offline', 'offline:low']) {
  test(`consultation rejects model substitution for ${changedId} before session start`, { timeout: 15_000 }, async t => {
    const f = setup(t, { model: `consultation-fixture/${changedId}` });
    const result = await f.ask();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'consultation_failed');
    assert.equal(existsSync(join(f.d.workspace, 'consultation-started.json')), false);
    assert.equal(consultationPromptCount(f.d), 0);
    assertConsultationClean(f.d);
  });
}

for (const id of ['offline', unlistedModelId]) {
  test(`consultation requires a subscription for ${id} even when the primary profile contains an API key`, { timeout: 15_000 }, async t => {
    const f = setup(t, { model: `consultation-fixture/${id}` });
    writeFileSync(join(f.d.stateRoot, 'pi', 'auth.json'), JSON.stringify({
      'consultation-fixture': { type: 'api_key', key: 'offline-authorization-marker' },
    }));
    const result = await f.ask();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'consultation_failed');
    assert.equal(consultationPromptCount(f.d), 0);
    assertConsultationClean(f.d);
  });
}

test('controller rules deny worker callers, disabled participants, unallowed targets and explicit caller context before contact', async t => {
  const f = setup(t);
  const caller = f.agents[f.callerId], target = f.agents[f.targetId];
  async function denied(code: string, extra?: object) {
    const result = await f.ask('CONSULT_ONE', extra);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
  }
  caller.workerRuntime = f.route;
  await denied('unsupported_runtime');
  delete caller.workerRuntime;
  caller.askAgent = { enabled: false };
  await denied('not_enabled');
  caller.askAgent = { enabled: true };
  target.askAgent = { enabled: false };
  await denied('not_enabled');
  target.askAgent = { enabled: true };
  caller.askAgent = { enabled: true, canAsk: [f.targetId], deny: ['*'] };
  await denied('denied');
  caller.askAgent = { enabled: true, canAsk: [] };
  await denied('denied');
  caller.askAgent = { enabled: true };
  f.route.inboundConsultation = false;
  await denied('unsupported_runtime');
  f.route.inboundConsultation = true;
  for (const context of ['', 'private caller context', null]) await denied('invalid_request', { context });
  assert.equal(f.connections.length, 0);
  assert.equal(f.noLocalAccess.mock.callCount(), 0);
  assert.equal(consultationPromptCount(f.d), 0);
});

test('preflight discloses no question to disabled, mismatched or legacy workers', async t => {
  const f = setup(t, { enabled: false });
  const disabled = await f.ask();
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error.code, 'consultation_disabled');
  // The route points to a valid endpoint but the controller expects a different agent.
  const target = f.agents[f.targetId];
  f.agents['other-agent'] = { ...target, id: 'other-agent' };
  f.agents[f.callerId].askAgent = { enabled: true };
  const mismatch = await f.ask('CONSULT_ONE', { agent: 'other-agent' });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, 'agent_mismatch');
  for (const reply of [
    { type: 'error', id: '', code: 'invalid_frame', message: 'legacy' },
    { type: 'consult_ready', agentId: 'unexpected', inboundConsultation: true },
    { type: 'consult_ready', agentId: f.targetId, inboundConsultation: false },
  ]) {
    connect = () => f.wire(socket => socket.on('data', frame => {
      socket.write(JSON.stringify({ version: 1, id: JSON.parse(String(frame)).id, ...reply }) + '\n');
      socket.end();
    }));
    const result = await f.ask();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, reply.agentId === 'unexpected' ? 'agent_mismatch' : 'consultation_unavailable');
  }
  for (const socket of f.connections) {
    assert.equal(socket.frames.length, 1);
    assert.equal(socket.frames[0].op, 'consult_check');
    assert.equal('question' in socket.frames[0], false);
  }
  assert.equal(f.noLocalAccess.mock.callCount(), 0);
  assert.equal(consultationPromptCount(f.d), 0);
});

test('worker rejects prompt without preflight and rejects unrecognized fields at both stages', async t => {
  const f = setup(t);
  const check = { version: 1, id: 'consultation', op: 'consult_check', expectedAgentId: f.targetId };
  const question = { version: 1, id: check.id, op: 'consult', question: 'CONSULT_ONE' };
  async function send(socket: Wire, frame: object) {
    const response = once(socket, 'data');
    socket.write(JSON.stringify(frame) + '\n');
    return JSON.parse(String((await response)[0]));
  }
  assert.equal((await send(f.wire(), question)).code, 'invalid_frame');
  assert.equal((await send(f.wire(), { ...check, question: question.question })).code, 'invalid_frame');
  for (const extra of [{ cwd: '/synthetic' }, { tools: ['bash'] }, { model: 'unused/model' }, { env: {} },
    { context: 'synthetic' }, { sessionId: 'synthetic' }, { flags: ['--something'] }, { id: 'different' }]) {
    const socket = f.wire();
    assert.equal((await send(socket, check)).type, 'consult_ready');
    assert.equal((await send(socket, { ...question, ...extra })).code, 'invalid_frame');
  }
  assert.equal(consultationPromptCount(f.d), 0);
  assertConsultationClean(f.d);
});

test('route consultation opt-in is strictly boolean', () => {
  const route = { socketPath: '/synthetic/worker.sock', workerUid: process.getuid!() + 1, controllerName: 'fixture' };
  assert.deepEqual(validateWorkerRuntime(route, 'fixture'), route);
  for (const inboundConsultation of [true, false]) {
    assert.deepEqual(validateWorkerRuntime({ ...route, inboundConsultation }, 'fixture'), { ...route, inboundConsultation });
  }
  assert.throws(() => validateWorkerRuntime({ ...route, inboundConsultation: 'true' }, 'fixture'), /must be a boolean/);
});

test('worker exposes only selected read tools and bounds the final answer', { timeout: 15_000 }, async t => {
  const f = setup(t, { knowledge: true });
  const result = await f.ask('CONSULT_ONE CONSULT_LONG');
  assert.equal(result.ok, true);
  assert.equal(result.result.answer.length, 32_768);
  assert.ok(result.result.answer.endsWith('…[truncated]'));
  assert.equal(result.result.truncated, true);
  assert.equal(result.result.needsClarification, true);
  assert.deepEqual(consultationStarted(f.d).tools, ['knowledge_get', 'knowledge_search', 'ls', 'read']);
  assert.equal(consultationPromptCount(f.d), 1);
  assertConsultationClean(f.d);
});

test('missing confirmation after the client deadline is uncertain without replay', async t => {
  const f = setup(t);
  const sent = new Promise<void>(resolve => {
    connect = () => f.wire(socket => socket.on('data', frame => {
      const request = JSON.parse(String(frame));
      if (request.op === 'consult') { resolve(); return; }
      socket.write(JSON.stringify({
        version: 1, id: request.id, type: 'consult_ready', agentId: f.targetId, inboundConsultation: true,
      }) + '\n');
    }));
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = f.ask();
  await sent;
  t.mock.timers.tick(AGENT_RUNTIME_CLIENT_PROMPT_TIMEOUT_MS + 1);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'uncertain_outcome');
  assert.equal(f.connections.length, 1);
  assert.equal(f.connections[0].frames.length, 2);
  assert.equal(f.connections[0].destroyed, true);
});

test('worker timeout reaps Pi and returns one confirmed failure, without replay', { timeout: 15_000 }, async t => {
  const f = setup(t, { timeout: 2_500 });
  const result = await f.ask('CONSULT_WAIT');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'consultation_timeout');
  assert.equal(consultationPromptCount(f.d), 1);
  assert.equal(alive(consultationStarted(f.d).pid), false);
  assert.equal(f.connections.length, 1);
  assertConsultationClean(f.d);
});

for (const end of ['abort', 'disconnect'] as const) {
  test(`caller ${end} after send reports uncertainty and reaps Pi without replay`, { timeout: 15_000 }, async t => {
    const f = setup(t);
    const controller = new AbortController();
    controller.abort();
    const cancelled = await f.ask('CONSULT_WAIT', {}, controller.signal);
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error.code, 'cancelled');
    assert.equal(f.connections.length, 0);
    const active = new AbortController();
    const pending = f.ask('CONSULT_WAIT', {}, active.signal);
    await until(() => consultationPromptCount(f.d) === 1);
    if (end === 'abort') active.abort();
    else f.connections[0].destroy();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'uncertain_outcome');
    const pid = consultationStarted(f.d).pid;
    await until(() => !alive(pid));
    await until(() => {
      try { assertConsultationClean(f.d); return true; } catch { return false; }
    });
    assert.equal(f.connections.length, 1);
    assert.equal(f.connections[0].frames.length, 2);
    assert.equal(consultationPromptCount(f.d), 1);
  });
}

for (const command of ['CONSULT_ERROR', 'CONSULT_CRASH']) {
  test(`Pi ${command} returns a content-free failure and is reaped without replay`, { timeout: 15_000 }, async t => {
    const f = setup(t);
    const result = await f.ask(command);
    assert.equal(result.ok, false);
    assert.deepEqual(result.error, { code: 'consultation_failed', message: 'The worker consultation ended without an answer' });
    assert.equal(consultationPromptCount(f.d), 1);
    assert.equal(alive(consultationStarted(f.d).pid), false);
    assert.equal(f.connections.length, 1);
    assertConsultationClean(f.d);
  });
}

test('hard loss of a synthetic worker exits actual Pi through its ownership pipe', { timeout: 15_000 }, async t => {
  const d = consultationFixture(t);
  const workerUrl = new URL('../agent-runtime-worker.ts', import.meta.url).href;
  // Exercise the owned child lifetime directly. This probe has no socket or endpoint proxy.
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
    const { AgentRuntimeWorker } = await import(process.argv[1]);
    const worker = new AgentRuntimeWorker(JSON.parse(process.argv[2]), { trustedTestExtensions: [process.argv[3]] });
    await worker.runConsultation('CONSULT_WAIT', new AbortController().signal);
  `, workerUrl, JSON.stringify(d), consultationProvider], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: { HOME: d.home, TMPDIR: d.stateRoot, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
    stdio: 'ignore',
  });
  const closed = once(child, 'close');
  t.after(async () => { child.kill('SIGKILL'); await closed; });
  await until(() => consultationPromptCount(d) === 1);
  const pid = consultationStarted(d).pid;
  assert.equal(alive(pid), true);
  assert.equal(child.kill('SIGKILL'), true);
  await closed;
  await until(() => !alive(pid));
  assert.equal(consultationPromptCount(d), 1);
  assertConsultationClean(d);
});
