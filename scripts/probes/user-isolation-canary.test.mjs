import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, existsSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { validateConfig, loadConfig, validateEndpoint, childEnvironment, PRIVATE_CONTENT, PROTECTED_CONTENT, connectRpc, attachRpc, probe, validateRuntime, checkAncestors, validateNodePath, parseEndpointAcl, checkEndpointAcl } from './user-isolation-canary.mjs';

const harness = fileURLToPath(new URL('./user-isolation-canary.mjs', import.meta.url));
mkdirSync('.tmp', { recursive: true });
function fixture() {
  const root = mkdtempSync(resolve('.tmp/u-'));
  const c = { controllerUid: process.getuid(), workerUid: process.getuid(), workerGid: process.getgid(), controllerName: 'canary', sameUidBaseline: true,
    nodePath: realpathSync(process.execPath), piCliPath: resolve('node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
    providerPath: fileURLToPath(new URL('./user-isolation-provider.mjs', import.meta.url)), home: join(root, 'h'),
    workspace: join(root, 'w'), tmpDir: join(root, 't'), socketDir: join(root, 's'), socketPath: join(root, 's', 'p'),
    sessionFile: join(root, 'h', 'sessions', 'session.jsonl'), privateFixturePath: join(root, 'private', 'fixture.txt'), controllerHomeProbePath: join(root, 'controller-home'),
    protectedFilePath: join(root, 'protected.txt'), deadlineSeconds: 40 };
  mkdirSync(join(root, 'private'), { mode: 0o750 });
  mkdirSync(c.controllerHomeProbePath, { mode: 0o750 });
  mkdirSync(c.socketDir, { mode: 0o700 });
  writeFileSync(c.privateFixturePath, PRIVATE_CONTENT, { mode: 0o600 });
  writeFileSync(c.protectedFilePath, PROTECTED_CONTENT, { mode: 0o600 });
  const configPath = join(root, 'descriptor.json');
  writeFileSync(configPath, JSON.stringify(c), { mode: 0o600 });
  return { c, configPath, root };
}
function run(mode, c, configPath) {
  const child = spawn(c.nodePath, [harness, mode, '--config', configPath], { env: childEnvironment(c), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const closed = once(child, 'close');
  return { child, closed, output: () => ({ stdout, stderr }) };
}
async function ready(server) {
  const deadline = Date.now() + 10000;
  while (!server.output().stdout.includes('"event":"ready"')) {
    if (server.child.exitCode !== null || Date.now() > deadline) throw new Error(`Server not ready: ${JSON.stringify(server.output())}`);
    await delay(20);
  }
}
async function shutdown(server) {
  if (server.child.exitCode === null) server.child.kill('SIGTERM');
  await server.closed;
}

test('descriptor rejects root, implicit baseline, invalid paths and excessive lifetime', () => {
  const { c } = fixture();
  assert.equal(validateConfig(c), c);
  assert.doesNotThrow(() => validateConfig({ ...c, controllerHomeProbePath: undefined }));
  const cross = { ...c, sameUidBaseline: false, workerUid: c.workerUid + 1 };
  assert.equal(validateConfig(cross), cross);
  assert.throws(() => validateConfig({ ...cross, controllerHomeProbePath: undefined }), /requires controllerHomeProbePath/);
  for (const change of [{ workerUid: 0 }, { workerGid: 0 }, { workerGid: undefined }, { workerGid: 1.5 }, { sameUidBaseline: false }, { sameUidBaseline: undefined },
    { deadlineSeconds: 301 }, { deadlineSeconds: 0 }, { home: 'relative' }, { controllerName: 'everyone allow write' },
    { socketPath: '/' + 'x'.repeat(104) }, { sessionFile: '/elsewhere/session.jsonl' },
    { privateFixturePath: join(c.workspace, 'private') }, { controllerHomeProbePath: join(c.home, 'controller') },
    { controllerHomeProbePath: c.workspace }, { controllerHomeProbePath: 'relative' }]) assert.throws(() => validateConfig({ ...c, ...change }));
});

test('descriptor and endpoint reject symlinks, wrong owners and writable staging', () => {
  const { c, configPath, root } = fixture();
  const link = join(root, 'link.json');
  symlinkSync(configPath, link);
  assert.throws(() => loadConfig(link), /nonsymlink/);
  chmodSync(configPath, 0o666);
  assert.throws(() => loadConfig(configPath), /ownership and mode/);
  chmodSync(configPath, 0o600);
  checkAncestors(root, c);
  chmodSync(root, 0o777);
  assert.throws(() => checkAncestors(root, c), /Writable staging/);
  chmodSync(root, 0o700);
  assert.throws(() => validateEndpoint({ ...c, workerUid: c.workerUid + 1 }), /worker-owned/);
  writeFileSync(c.socketPath, 'not a socket', { mode: 0o600 });
  assert.throws(() => validateEndpoint(c), /nonsymlink socket/);
  const other = join(c.socketDir, 'other');
  symlinkSync(c.socketPath, other);
  assert.throws(() => validateEndpoint({ ...c, socketPath: other }), /nonsymlink/);
  const linkedDir = join(root, 'linked-dir');
  symlinkSync(c.socketDir, linkedDir);
  assert.throws(() => validateEndpoint({ ...c, socketDir: linkedDir }), /nonsymlink/);
});

test('cross-UID Node accepts controller/admin Homebrew chain and rejects worker/world writes', () => {
  const c = { sameUidBaseline: false, controllerUid: 501, workerUid: 502, workerGid: 503 };
  const chain = new Map([
    ['/brew/bin/node', { uid: 501, gid: 80, mode: 0o755 }],
    ['/brew/bin', { uid: 501, gid: 80, mode: 0o775 }],
    ['/brew', { uid: 0, gid: 80, mode: 0o775 }],
    ['/', { uid: 0, gid: 0, mode: 0o755 }],
  ]);
  const statPath = (path, kind) => {
    assert.equal(kind, path === '/brew/bin/node' ? 'file' : 'directory');
    assert.ok(chain.has(path), `Unexpected path ${path}`);
    return chain.get(path);
  };
  const options = { statPath, workerGroups: [503, 61] };
  validateNodePath('/brew/bin/node', c, options);
  // The same policy applies to the executable and every ancestor.
  for (const path of chain.keys()) {
    const original = chain.get(path);
    for (const change of [{ uid: 502 }, { uid: 504 }, { mode: 0o777 }, { mode: 0o775, gid: 20 }, { mode: 0o775, gid: 503 }]) {
      chain.set(path, { ...original, ...change });
      assert.throws(() => validateNodePath('/brew/bin/node', c, options), /Node path/);
    }
    chain.set(path, original);
  }
  assert.throws(() => validateNodePath('/brew/bin/node', c, { statPath, workerGroups: [503, 80] }), /Node path/);
  assert.throws(() => validateNodePath('/brew/bin/node', { ...c, workerGid: 80 }, options), /Node path/);
});

test('macOS ls ACL parser requires a sole exact controller entry', () => {
  const header = 'drwx------+ 2 worker staff 64 Nov  7 00:00 /canary/socket-dir\n';
  const parse = entries => parseEndpointAcl(header + entries);
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse(' 0: user:controller allow search\n'), ['user:controller allow search']);
  checkEndpointAcl(parse(' 0: user:controller allow search\n'), 'controller', 'search');
  checkEndpointAcl(parse(' 0: user:controller allow write\n'), 'controller', 'write');
  for (const entries of ['', ' 0: user:other allow search\n', ' 0: group:staff allow search\n',
    ' 0: everyone allow search\n', ' 0: user:controller deny search\n',
    ' 0: user:controller allow search,readattr\n', ' 0: user:controller inherited allow search\n',
    ' 0: user:controller allow search,file_inherit,directory_inherit\n',
    ' 0: user:controller allow search\n 1: user:controller allow search\n',
    ' 0: user:controller allow search\n 1: group:admin allow write\n',
    ' 0: user:controller allow write\n']) {
    assert.throws(() => checkEndpointAcl(parse(entries), 'controller', 'search'), /sole exact/);
  }
});

test('cross-UID receipts stop for failed metadata isolation, primary GID or staff/admin groups', async () => {
  const scenarios = [
    ...['allowed', 'ENOENT', 'ENOTDIR'].flatMap(actual => [
      [{ privateParentAccess: actual }, 'private_parent_metadata_access'],
      [{ controllerHomeAccess: actual }, 'controller_home_metadata_access'],
    ]),
    [{ gid: 12346 }, 'worker_identity_home_and_paths'],
    [{ groups: [12345, 20] }, 'worker_explicit_groups'],
    [{ groups: [12345, 80] }, 'worker_explicit_groups'],
  ];
  for (const [change, failedAssertion] of scenarios) {
    const { c } = fixture();
    const cross = { ...c, sameUidBaseline: false, workerUid: c.workerUid + 1, workerGid: 12345 };
    let closes = 0;
    const report = await probe(cross, async () => ({
      socket: { destroy() {} },
      rpc: async () => ({ sessionFile: c.sessionFile }),
      prompt: async message => ({ uid: cross.workerUid, gid: cross.workerGid, groups: [12345, 61], nodeVersion: process.version,
        home: c.home, cwd: c.workspace, tmp: c.tmpDir, agentDir: join(c.home, 'agent'), marker: message.split(' ')[1],
        privateParentAccess: 'EACCES', controllerHomeAccess: 'EPERM', ...change }),
      close: async () => { closes++; },
    }));
    assert.equal(report.state, 'failed');
    assert.equal(report.mode, 'cross_uid');
    assert.equal(report.assertions.at(-1).passed, false);
    assert.equal(report.assertions.at(-1).name, failedAssertion, JSON.stringify(change));
    assert.match(report.error, /cross_uid: Assertion failed/);
    assert.equal(closes, 1);
  }
});

test('child environment is an explicit credential-free allowlist', () => {
  const { c } = fixture();
  process.env.CANARY_FAKE_SECRET = 'must-not-flow';
  try {
    const env = childEnvironment(c);
    assert.equal(env.CANARY_FAKE_SECRET, undefined);
    assert.equal(env.HOME, c.home);
    assert.equal(env.SHELL, '/bin/bash');
    assert.equal(env.PI_OFFLINE, '1');
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.MINIME_CONTROL_WORKSPACE_ROOT, undefined);
  } finally { delete process.env.CANARY_FAKE_SECRET; }
});

test('baseline server fails before startup for wrong UID, GID or HOME', async () => {
  const { c, configPath } = fixture();
  assert.throws(() => validateRuntime({ ...c, workerUid: c.workerUid + 1 }), /Unexpected worker UID/);
  assert.throws(() => validateRuntime({ ...c, workerGid: c.workerGid + 1 }), /Unexpected worker GID/);
  const badHome = spawn(c.nodePath, [harness, 'serve', '--config', configPath], { env: { ...childEnvironment(c), HOME: c.workspace }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  badHome.stdout.on('data', d => { out += d; });
  assert.equal((await once(badHome, 'close'))[0], 1);
  assert.match(out, /Unexpected worker HOME/);
  assert.equal(JSON.parse(out).mode, 'same_uid_baseline');
  assert.equal(existsSync(c.socketPath), false);
});

test('server refuses a symlinked session and an existing nonprivate HOME', async () => {
  for (const scenario of ['session-link', 'public-home']) {
    const { c, configPath } = fixture();
    mkdirSync(c.home, { mode: scenario === 'public-home' ? 0o755 : 0o700 });
    if (scenario === 'session-link') {
      mkdirSync(join(c.home, 'sessions'), { mode: 0o700 });
      symlinkSync(c.privateFixturePath, c.sessionFile);
    }
    const server = run('serve', c, configPath);
    assert.equal((await server.closed)[0], 1);
    assert.match(server.output().stdout, scenario === 'session-link' ? /nonsymlink file/ : /Worker state directory/);
    assert.equal(existsSync(c.socketPath), false);
    assert.equal(readFileSync(c.privateFixturePath, 'utf8'), PRIVATE_CONTENT);
  }
});

test('real package Pi 1.5.0 baseline: identity, tool results, disk resume, abort, disconnect, deadline', { timeout: 60000 }, async t => {
  const { c, configPath } = fixture();
  const availability = createServer();
  try { await new Promise((resolve, reject) => { availability.once('error', reject); availability.listen(c.socketPath, resolve); }); await new Promise(resolve => availability.close(resolve)); }
  catch (e) { if (e.code === 'EPERM') { t.skip('Sandbox forbids Unix socket binding (EPERM)'); return; } throw e; }
  const server = run('serve', c, configPath);
  let client;
  try {
    await ready(server);
    const controller = run('probe', c, configPath);
    assert.equal((await controller.closed)[0], 0, JSON.stringify(controller.output()));
    const report = JSON.parse(controller.output().stdout);
    assert.equal(report.state, 'passed');
    assert.equal(report.mode, 'same_uid_baseline');
    assert.equal(report.assertions.find(a => a.name === 'worker_identity_home_and_paths').observed.nodeVersion, process.version);
    for (const name of ['private_parent_metadata_access', 'controller_home_metadata_access']) {
      assert.equal(report.assertions.find(a => a.name === name).observed.actual, 'allowed');
    }
    assert.equal(report.assertions.find(a => a.name === 'same_uid_access_baseline').observed.separationClaim, false);
    assert.match(readFileSync(c.sessionFile, 'utf8'), /CANARY_RESULT=/);
    assert.equal(lstatSync(c.sessionFile).mode & 0o077, 0);
    assert.equal(readFileSync(join(c.workspace, 'outbox', 'marker.txt'), 'utf8'), report.assertions.find(a => a.name === 'unique_marker').observed);
    // Abandon a second live bash tool. Reconnect to a fresh Pi and check owner-side PID liveness.
    client = await connectRpc(c);
    const start = client.events.length;
    await client.rpc('prompt', { message: 'CANARY_CANCEL' });
    const event = await client.wait(e => e.type === 'tool_execution_update' && JSON.stringify(e.partialResult).includes('CANARY_SLEEP='), start);
    const text = event.partialResult.content.map(b => b.text ?? '').join('\n');
    const pid = Number(text.match(/CANARY_SLEEP=\{"pid":(\d+)\}/)[1]);
    await client.close();
    client = await connectRpc(c);
    assert.equal((await client.prompt(`CANARY_STOPPED ${pid}`)).status, 'ESRCH');
    await client.close();
    client = undefined;
  } finally {
    await client?.close();
    await shutdown(server);
  }
  assert.equal(existsSync(c.socketPath), false);
  assert.equal(existsSync(c.sessionFile), true, 'Preserve transcript evidence');
  // Short-lived separate server tests deadline cancellation with a running descendant.
  const next = fixture();
  next.c.deadlineSeconds = 6;
  writeFileSync(next.configPath, JSON.stringify(next.c));
  const expiring = run('serve', next.c, next.configPath);
  try {
    await ready(expiring);
    client = await connectRpc(next.c);
    await client.rpc('prompt', { message: 'CANARY_CANCEL' });
    const event = await client.wait(e => e.type === 'tool_execution_update' && JSON.stringify(e.partialResult).includes('CANARY_SLEEP='));
    const pid = Number(event.partialResult.content.map(b => b.text ?? '').join('\n').match(/CANARY_SLEEP=\{"pid":(\d+)\}/)[1]);
    await expiring.closed;
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    assert.equal(existsSync(next.c.socketPath), false);
  } finally { await client?.close(); await shutdown(expiring); }
});


test('real Pi same-UID pipe baseline when Unix sockets are unavailable', { timeout: 45000 }, async () => {
  const { c } = fixture();
  for (const p of [c.home, c.workspace, c.tmpDir]) mkdirSync(p, { mode: 0o700 });
  mkdirSync(join(c.home, 'agent'), { mode: 0o700 });
  mkdirSync(join(c.home, 'sessions'), { mode: 0o700 });
  const children = [];
  const previousUmask = process.umask(0o077);
  const open = async () => {
    const child = spawn(c.nodePath, [c.piCliPath, '--mode', 'rpc', '--offline', '--session', c.sessionFile,
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--extension', c.providerPath,
      '--tools', 'bash', '--model', 'canary-offline/fixture'], {
      cwd: c.workspace, env: childEnvironment(c), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    child.stderr.resume();
    const closed = once(child, 'close');
    const rpc = attachRpc(Duplex.from({ readable: child.stdout, writable: child.stdin }));
    rpc.close = async () => { if (child.exitCode === null) child.kill('SIGTERM'); await closed; };
    return rpc;
  };
  try {
    const report = await probe(c, open);
    assert.equal(report.state, 'passed', JSON.stringify(report));
    assert.equal(report.mode, 'same_uid_baseline');
    assert.equal(report.assertions.find(a => a.name === 'worker_identity_home_and_paths').observed.nodeVersion, process.version);
    for (const name of ['private_parent_metadata_access', 'controller_home_metadata_access']) {
      assert.equal(report.assertions.find(a => a.name === name).observed.actual, 'allowed');
    }
    assert.equal(report.transport, 'test_pipe');
    assert.equal(report.assertions.some(a => a.name === 'endpoint_owner_and_ancestors'), false);
    assert.equal(report.assertions.find(a => a.name === 'same_uid_access_baseline').observed.separationClaim, false);
    assert.equal(children.length, 2, 'Fresh real Pi process for resumed session');
    assert.match(readFileSync(c.sessionFile, 'utf8'), /CANARY_RESULT=/);
    assert.equal(readFileSync(join(c.workspace, 'outbox', 'marker.txt'), 'utf8'), report.assertions.find(a => a.name === 'unique_marker').observed);
    writeFileSync(join(c.home, 'baseline-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    writeFileSync(c.protectedFilePath, PROTECTED_CONTENT);
    const repeated = await probe(c, open);
    assert.equal(repeated.state, 'passed', JSON.stringify(repeated));
    assert.notEqual(repeated.assertions.find(a => a.name === 'unique_marker').observed,
      report.assertions.find(a => a.name === 'unique_marker').observed, 'Resume uses the latest actual inspect receipt');
    const active = await open();
    const start = active.events.length;
    await active.rpc('prompt', { message: 'CANARY_CANCEL' });
    const update = await active.wait(e => e.type === 'tool_execution_update' && JSON.stringify(e.partialResult).includes('CANARY_SLEEP='), start);
    const pid = Number(update.partialResult.content.map(b => b.text ?? '').join('\n').match(/CANARY_SLEEP=\{"pid":(\d+)\}/)[1]);
    await active.close(); // Owner SIGTERM path used by the socket server, while bash is running.
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });

  } finally { process.umask(previousUmask); for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); }
});
