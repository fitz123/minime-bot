import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AgentRuntimeDescriptor } from '../agent-runtime-descriptor.js';
import type { PiExtensionResolveOptions } from '../pi-rpc-protocol.js';

const protocol = await import('../pi-rpc-protocol.js');
let missing = false;
const resolutions: PiExtensionResolveOptions[] = [];
mock.module('../pi-rpc-protocol.js', {
  namedExports: { ...protocol, resolvePiExtensionArgs(options: PiExtensionResolveOptions) {
    resolutions.push(options);
    return protocol.resolvePiExtensionArgs({ ...options, exists: path => !missing && existsSync(path) });
  } },
});
const { AgentRuntimeWorker } = await import('../agent-runtime-worker.js');
const descriptor: AgentRuntimeDescriptor = {
  version: 1, agentId: 'fixture-agent', workerUid: process.getuid!(), workerGid: process.getgid!(), controllerUid: process.getuid!(),
  controllerName: 'fixture-controller', home: '/synthetic/home', workspace: '/synthetic/workspace', stateRoot: '/synthetic/state',
  sessionRoot: '/synthetic/sessions', contextRoot: '/synthetic/context', socketDirectory: '/synthetic/socket', socketPath: '/synthetic/socket/worker.sock',
  model: 'fixture/model', thinking: 'off', knowledge: 'v2', capabilities: ['knowledge-tools'], tools: [], offline: true,
};
const paths = (worker: InstanceType<typeof AgentRuntimeWorker>) =>
  (worker as unknown as { extensions: string[] }).extensions;

test('worker resolves only the executing package Knowledge wrapper despite ambient settings', async t => {
  const previous = process.env.PI_EXTENSIONS_DISABLED;
  process.env.PI_EXTENSIONS_DISABLED = '1';
  t.after(() => {
    if (previous === undefined) delete process.env.PI_EXTENSIONS_DISABLED;
    else process.env.PI_EXTENSIONS_DISABLED = previous;
  });
  const worker = new AgentRuntimeWorker(descriptor); t.after(() => worker.shutdown());
  assert.deepEqual(paths(worker), [resolve('extensions/pi/knowledge-tools.ts')]);
  assert.deepEqual(resolutions.at(-1), {
    env: {}, relpaths: ['knowledge-tools.ts'], extensionsDir: resolve('extensions/pi'),
  });
});

test('required missing wrapper fails during worker construction, before any prompt or Pi spawn', () => {
  missing = true;
  try {
    assert.throws(() => new AgentRuntimeWorker(descriptor), /Pi extension wrapper not found/);
    const before = resolutions.length;
    const worker = new AgentRuntimeWorker({ ...descriptor, capabilities: [] });
    assert.deepEqual(paths(worker), []);
    assert.equal(resolutions.length, before, 'unrequested capability must not resolve wrappers');
    void worker.shutdown();
  } finally { missing = false; }
});
