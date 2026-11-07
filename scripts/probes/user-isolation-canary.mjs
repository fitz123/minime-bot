#!/usr/bin/env node
// Issue252 preparatory tooling; never import this module into the package runtime.
import { lstatSync, readFileSync, realpathSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const requiredPaths = ['nodePath', 'piCliPath', 'providerPath', 'home', 'workspace', 'tmpDir', 'socketDir', 'socketPath', 'sessionFile', 'privateFixturePath', 'protectedFilePath'];
export const PRIVATE_CONTENT = 'ISSUE252_SYNTHETIC_PRIVATE\n';
export const PROTECTED_CONTENT = 'ISSUE252_SYNTHETIC_PROTECTED\n';
const inside = (child, parent) => child.startsWith(parent + '/');
function check(ok, message) { if (!ok) throw new Error(message); }
function stat(path, kind) {
  const s = lstatSync(path);
  check(!s.isSymbolicLink() && (kind === 'directory' ? s.isDirectory() : kind === 'socket' ? s.isSocket() : s.isFile()), `Expected nonsymlink ${kind}`);
  return s;
}

// The parent provisions trusted staging. This is a coordination check, not a same-UID security boundary.
export function checkAncestors(path, c, { endpoint = false, runtime = false } = {}) {
  for (let p = path; ; p = dirname(p)) {
    const s = stat(p, 'directory');
    const baselineSticky = c.sameUidBaseline && s.uid === 0 && (s.mode & 0o1000);
    const baselineRuntime = runtime && c.sameUidBaseline && s.uid === c.workerUid && !(s.mode & 0o002);
    check(!(s.mode & 0o022) || baselineSticky || baselineRuntime, 'Writable staging ancestor');
    check(c.sameUidBaseline ? [0, c.workerUid].includes(s.uid) : s.uid === 0,
      endpoint ? 'Cross-UID socket parent must be root-owned' : 'Cross-UID staging must be root-owned');
    if (p === dirname(p)) break;
  }
}
export function validateConfig(c) {
  check(c && typeof c === 'object' && !Array.isArray(c), 'Expected descriptor object');
  for (const key of ['controllerUid', 'workerUid']) check(Number.isSafeInteger(c[key]) && c[key] > 0, 'Root execution is forbidden; expected positive UIDs');
  check(Number.isSafeInteger(c.workerGid) && c.workerGid > 0, 'Expected positive workerGid');
  check(typeof c.sameUidBaseline === 'boolean', 'sameUidBaseline must be explicit');
  check(c.sameUidBaseline === (c.controllerUid === c.workerUid), 'Same-UID runs require explicit baseline mode');
  check(typeof c.controllerName === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(c.controllerName), 'Invalid controllerName');
  check(Number.isInteger(c.deadlineSeconds) && c.deadlineSeconds > 0 && c.deadlineSeconds <= 300, 'deadlineSeconds must be 1..300');
  const paths = c.controllerHomeProbePath === undefined ? requiredPaths : [...requiredPaths, 'controllerHomeProbePath'];
  check(c.sameUidBaseline || c.controllerHomeProbePath !== undefined, 'Cross-UID mode requires controllerHomeProbePath');
  for (const key of paths) check(typeof c[key] === 'string' && isAbsolute(c[key]) && resolve(c[key]) === c[key] && !/[\0\r\n]/.test(c[key]), `Expected normalized absolute ${key}`);
  check(new Set(paths.map(k => c[k])).size === paths.length, 'Descriptor paths must be distinct');
  check(Buffer.byteLength(c.socketPath) < 104 && dirname(c.socketPath) === c.socketDir, 'Socket must be inside socketDir and shorter than 104 bytes');
  check(inside(c.sessionFile, c.home), 'Session must be inside private home');
  check(!inside(c.workspace, c.home) && !inside(c.home, c.workspace), 'Home and workspace must be distinct roots');
  for (const synthetic of ['privateFixturePath', 'protectedFilePath']) {
    check(![c.home, c.workspace, c.tmpDir, c.socketDir].some(p => inside(c[synthetic], p)), 'Synthetic access fixtures must be outside worker state');
  }
  if (c.controllerHomeProbePath !== undefined) {
    check(![c.home, c.workspace, c.tmpDir, c.socketDir].some(p => c.controllerHomeProbePath === p || inside(c.controllerHomeProbePath, p)), 'Controller home probe must be outside worker state');
  }
  return c;
}
export function loadConfig(path) {
  check(isAbsolute(path), 'Config path must be absolute');
  const s = stat(path, 'file');
  const c = validateConfig(JSON.parse(readFileSync(path, 'utf8')));
  check(s.uid === (c.sameUidBaseline ? c.controllerUid : 0) && !(s.mode & 0o022), 'Descriptor must have trusted ownership and mode');
  checkAncestors(dirname(path), c);
  return c;
}
export function childEnvironment(c) {
  return { HOME: c.home, USER: userInfo().username, LOGNAME: userInfo().username, SHELL: '/bin/bash',
    PATH: `${dirname(c.nodePath)}:/usr/bin:/bin`, TMPDIR: c.tmpDir,
    PI_CODING_AGENT_DIR: join(c.home, 'agent'), PI_CODING_AGENT_SESSION_DIR: dirname(c.sessionFile),
    PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    PI_CANARY_CONFIG: JSON.stringify(c) };
}
// Deliberately trust the controller's Homebrew Node and admin (GID 80), including
// its ancestor chain. The parent audits dylib dependencies; never copy Node alone.
export function validateNodePath(path, c, { statPath = stat, workerGroups = process.getgroups() } = {}) {
  if (c.sameUidBaseline) {
    const s = statPath(path, 'file');
    check(!(s.mode & 0o022), 'Runtime files must be trusted and nonwritable');
    checkAncestors(dirname(path), c, { runtime: true });
    return;
  }
  for (let p = path; ; p = dirname(p)) {
    const s = statPath(p, p === path ? 'file' : 'directory');
    check([0, c.controllerUid].includes(s.uid) && s.uid !== c.workerUid, 'Node path must be root- or controller-owned');
    check(!(s.mode & 0o002) && (!(s.mode & 0o020) || (s.gid === 80 && c.workerGid !== 80 && !workerGroups.includes(80))),
      'Node path writable outside trusted owner/admin group');
    if (p === dirname(p)) break;
  }
}

// ls's listing header is not an ACL entry. Reject every extra permission, entry,
// or inheritance flag rather than merely looking for the expected grant.
export function parseEndpointAcl(output) {
  return output.split('\n').filter(line => /^\s*\d+:/.test(line)).map(line => line.replace(/^\s*\d+:\s*/, '').trim());
}
export function checkEndpointAcl(entries, controllerName, permission) {
  check(entries.length === 1 && entries[0] === `user:${controllerName} allow ${permission}`, 'Endpoint ACL must be the sole exact controller grant');
}
function endpointAcl(path, c) {
  check(process.platform === 'darwin', 'Cross-UID endpoint ACL inspection requires macOS');
  check(isAbsolute(path), 'ACL target must be absolute');
  return parseEndpointAcl(execFileSync('/bin/ls', ['-lde', path], { encoding: 'utf8', env: childEnvironment(c), timeout: 2000 }));
}
function provisionEndpointAcl(path, c, permission) {
  const entries = endpointAcl(path, c);
  if (entries.length === 0) {
    execFileSync('/bin/chmod', ['+a', `user:${c.controllerName} allow ${permission}`, path], { env: childEnvironment(c), timeout: 2000 });
    checkEndpointAcl(endpointAcl(path, c), c.controllerName, permission);
  } else checkEndpointAcl(entries, c.controllerName, permission);
}
export function validateRuntime(c) {
  check(process.getuid() !== 0 && process.getuid() === c.workerUid && process.geteuid() === c.workerUid, 'Unexpected worker UID');
  check(process.getgid() === c.workerGid && (c.sameUidBaseline || ![process.getgid(), ...process.getgroups()].some(gid => [20, 80].includes(gid))), 'Unexpected worker GID or explicit staff/admin membership');
  check(process.env.HOME === c.home, 'Unexpected worker HOME');
  check(realpathSync(c.nodePath) === realpathSync(process.execPath), 'Run server with configured Node');
  const cli = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
  const root = resolve(dirname(cli), '../..');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  check(manifest.name === '@earendil-works/pi-coding-agent' && manifest.version === '1.5.0', 'Package-owned Pi 1.5.0 required');
  check(realpathSync(c.piCliPath) === realpathSync(resolve(root, manifest.bin.pi)), 'Configured CLI must be package-owned Pi');
  check(realpathSync(c.providerPath) === realpathSync(join(here, 'user-isolation-provider.mjs')), 'Expected explicit offline canary provider');
  validateNodePath(c.nodePath, c);
  for (const p of [c.piCliPath, c.providerPath, fileURLToPath(import.meta.url)]) {
    const s = stat(p, 'file');
    check(!(s.mode & 0o022) && (c.sameUidBaseline || s.uid === 0), 'Runtime files must be trusted and nonwritable');
    checkAncestors(dirname(p), c, { runtime: true });
  }
  if (!c.sameUidBaseline) check(process.platform === 'darwin', 'Cross-UID mode requires macOS');
}
function privateDir(path, c) {
  const uid = c.workerUid;
  for (let p = path; ; p = dirname(p)) {
    try {
      const s = stat(p, 'directory');
      const baselineSticky = c.sameUidBaseline && s.uid === 0 && (s.mode & 0o1000);
      check([0, uid].includes(s.uid) && (!(s.mode & 0o022) || baselineSticky), 'Unsafe worker state ancestor');
    } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (p === dirname(p)) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = stat(path, 'directory');
  check(s.uid === uid && !(s.mode & 0o077), 'Worker state directory must be owned privately by worker');
}
export function validateEndpoint(c) {
  const d = stat(c.socketDir, 'directory');
  check(d.uid === c.workerUid && !(d.mode & 0o077), 'Socket directory must be worker-owned 0700');
  checkAncestors(dirname(c.socketDir), c, { endpoint: true });
  const s = stat(c.socketPath, 'socket');
  check(s.uid === c.workerUid && !(s.mode & 0o077), 'Socket must be worker-owned 0600');
  if (!c.sameUidBaseline) {
    checkEndpointAcl(endpointAcl(c.socketDir, c), c.controllerName, 'search');
    checkEndpointAcl(endpointAcl(c.socketPath, c), c.controllerName, 'write');
  }
}
function signalGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; }
}
async function stopChild(child) {
  // Pi 1.5.0 SIGTERM handler kills its separately detached bash groups as well.
  signalGroup(child, 'SIGTERM');
  const exited = new Promise(resolve => child.once('close', resolve));
  if (child.exitCode === null && child.signalCode === null) {
    let timer;
    await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { signalGroup(child, 'SIGKILL'); resolve(); }, 2000); })]);
    clearTimeout(timer);
  }
}
export async function serve(c) {
  const startedAt = Date.now();
  validateRuntime(c);
  process.umask(0o077);
  for (const p of [c.home, c.workspace, c.tmpDir, join(c.home, 'agent'), dirname(c.sessionFile)]) privateDir(p, c);
  try {
    const s = stat(c.sessionFile, 'file');
    check(s.uid === c.workerUid && !(s.mode & 0o077), 'Session evidence must be private and worker-owned');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const d = stat(c.socketDir, 'directory');
  check(d.uid === c.workerUid && (d.mode & 0o777) === 0o700, 'Preprovision socketDir as worker 0700');
  checkAncestors(dirname(c.socketDir), c, { endpoint: true });
  // No unlink-before-bind: a stale endpoint is a provisioning error.
  if (!c.sameUidBaseline) {
    const actual = execFileSync('/usr/bin/id', ['-u', c.controllerName], { encoding: 'utf8', env: childEnvironment(c), timeout: 2000 }).trim();
    check(Number(actual) === c.controllerUid, 'controllerName does not match controllerUid');
    provisionEndpointAcl(c.socketDir, c, 'search');
  }
  let active;
  let stopping = false;
  const sockets = new Set();
  const server = net.createServer(async socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    // A reconnect can arrive while the preceding disconnect is still reaping Pi.
    socket.pause();
    if (active?.socket.destroyed && active.stopped) await active.stopped;
    if (active || stopping || socket.destroyed) { socket.destroy(); return; }
    const child = spawn(c.nodePath, [c.piCliPath, '--mode', 'rpc', '--offline', '--session', c.sessionFile,
      '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-context-files', '--extension', c.providerPath,
      '--tools', 'bash', '--model', 'canary-offline/fixture'], {
      cwd: c.workspace, env: childEnvironment(c), detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry = { child, socket, stopped: undefined };
    active = entry;
    console.log(JSON.stringify({ event: 'pi_start', uid: process.getuid(), pid: child.pid }));
    child.stdin.on('error', () => socket.destroy());
    child.on('error', () => socket.destroy());
    // Startup diagnostics only; do not print arbitrary stderr or host paths.
    child.stderr.resume();
    socket.pipe(child.stdin);
    socket.resume();
    child.stdout.pipe(socket);
    const stop = () => entry.stopped ??= stopChild(child).finally(() => { if (active === entry) active = undefined; });
    socket.on('close', stop);
    child.on('close', () => { socket.destroy(); void stop(); });
  });
  const closed = new Promise(resolve => server.once('close', resolve));
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  // Reserve time for child cancellation within the maximum 300-second lifetime.
  const timer = setTimeout(shutdown, Math.max(1, startedAt + c.deadlineSeconds * 1000 - Date.now() - 2500));
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(c.socketPath, resolve); });
    chmodSync(c.socketPath, 0o600);
    if (!c.sameUidBaseline) provisionEndpointAcl(c.socketPath, c, 'write');
    validateEndpoint(c);
    console.log(JSON.stringify({ event: 'ready', mode: c.sameUidBaseline ? 'same_uid_baseline' : 'cross_uid', uid: process.getuid(), nodeVersion: process.version, piVersion: '1.5.0', deadlineSeconds: c.deadlineSeconds }));
    await closed;
  } finally {
    clearTimeout(timer);
    shutdown();
    if (active) await (active.stopped ?? stopChild(active.child));
    process.off('SIGTERM', shutdown);
    process.off('SIGINT', shutdown);
  }
}

export async function connectRpc(c) {
  validateEndpoint(c);
  const socket = net.createConnection(c.socketPath);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  return attachRpc(socket);
}

// Shared Pi JSONL driver also permits offline pipe verification in socket-restricted sandboxes.
export function attachRpc(socket) {
  const events = [];
  let ended = false;
  let failure;
  socket.on('error', e => { failure = e; });
  socket.on('close', () => { ended = true; });
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  const record = line => { try { events.push(JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line)); } catch { failure = new Error('Malformed Pi JSON'); } };
  // Match Pi's LF-only JSONL framing and retain split UTF-8 characters.
  socket.on('data', chunk => {
    buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      record(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  });
  socket.on('end', () => {
    buffer += decoder.end();
    if (buffer.length) record(buffer);
    buffer = '';
    ended = true;
  });
  async function wait(predicate, start = 0, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const found = events.slice(start).find(predicate);
      if (found) return found;
      if (ended) throw new Error('Pi connection ended before required event');
      await delay(20);
    }
    throw new Error('Timed out waiting for Pi event');
  }
  let serial = 0;
  async function rpc(type, fields = {}) {
    const id = String(++serial);
    socket.write(JSON.stringify({ id, type, ...fields }) + '\n');
    const response = await wait(e => e.type === 'response' && e.id === id);
    check(response.success, `Pi ${type} failed`);
    return response.data;
  }
  async function prompt(message) {
    const start = events.length;
    await rpc('prompt', { message });
    await wait(e => e.type === 'agent_settled', start);
    const result = await rpc('get_last_assistant_text');
    return JSON.parse(result.text);
  }
  return { socket, events, wait, rpc, prompt, close: async () => { socket.destroy(); await delay(250); } };
}
export async function probe(c, open = connectRpc) {
  const report = { state: 'failed', mode: c.sameUidBaseline ? 'same_uid_baseline' : 'cross_uid',
    transport: open === connectRpc ? 'unix_socket' : 'test_pipe',
    scope: 'Synthetic offline Pi execution only; no production runtime isolation claim', assertions: [] };
  const observe = (name, passed, observed) => {
    report.assertions.push({ name, passed, observed });
    check(passed, `${report.mode}: Assertion failed: ${name}`);
  };
  let client;
  const timer = setTimeout(() => client?.socket.destroy(), c.deadlineSeconds * 1000);
  try {
    check(process.getuid() !== 0 && process.getuid() === c.controllerUid && process.geteuid() === c.controllerUid, 'Unexpected controller UID');
    // Refuse accidental real-data targets before submitting either synthetic operation.
    stat(c.privateFixturePath, 'file');
    stat(c.protectedFilePath, 'file');
    check(readFileSync(c.privateFixturePath, 'utf8') === PRIVATE_CONTENT, 'Expected synthetic private fixture sentinel');
    check(readFileSync(c.protectedFilePath, 'utf8') === PROTECTED_CONTENT, 'Expected fresh synthetic protected fixture sentinel');
    client = await open(c);
    if (open === connectRpc) observe('endpoint_owner_and_ancestors', true, { workerUid: c.workerUid });
    const firstState = await client.rpc('get_state');
    observe('exact_session_path', firstState.sessionFile === c.sessionFile, { expected: c.sessionFile, actual: firstState.sessionFile });
    const marker = randomUUID();
    const inspect = await client.prompt(`CANARY_INSPECT ${marker}`);
    observe('worker_identity_home_and_paths', inspect.uid === c.workerUid && inspect.home === c.home && inspect.cwd === c.workspace && inspect.tmp === c.tmpDir && inspect.agentDir === join(c.home, 'agent') && Array.isArray(inspect.groups) && inspect.gid === c.workerGid && typeof inspect.nodeVersion === 'string', inspect);
    if (!c.sameUidBaseline) observe('worker_explicit_groups', ![inspect.gid, ...inspect.groups].some(gid => [20, 80].includes(gid)), { gid: inspect.gid, groups: inspect.groups });
    observe('unique_marker', inspect.marker === marker, inspect.marker);
    const denied = value => ['EACCES', 'EPERM'].includes(value);
    const metadataAllowed = c.sameUidBaseline;
    observe('private_parent_metadata_access', metadataAllowed ? inspect.privateParentAccess === 'allowed' : denied(inspect.privateParentAccess), { flags: 'R_OK|X_OK', expected: metadataAllowed ? 'allowed' : 'EACCES/EPERM', actual: inspect.privateParentAccess });
    if (c.controllerHomeProbePath !== undefined) observe('controller_home_metadata_access', metadataAllowed ? inspect.controllerHomeAccess === 'allowed' : denied(inspect.controllerHomeAccess), { flags: 'R_OK|X_OK', expected: metadataAllowed ? 'allowed' : 'EACCES/EPERM', actual: inspect.controllerHomeAccess });
    if (c.sameUidBaseline) {
      observe('same_uid_access_baseline', inspect.privateRead === 'allowed' && inspect.protectedWrite === 'allowed', { privateRead: inspect.privateRead, protectedWrite: inspect.protectedWrite, separationClaim: false });
    } else {
      observe('cross_uid_synthetic_denials', ['EACCES', 'EPERM'].includes(inspect.privateRead) && ['EACCES', 'EPERM'].includes(inspect.protectedWrite), { privateRead: inspect.privateRead, protectedWrite: inspect.protectedWrite });
      const unchanged = readFileSync(c.protectedFilePath, 'utf8') === PROTECTED_CONTENT;
      observe('protected_fixture_unchanged', unchanged, { unchanged });
    }
    await client.close();
    client = await open(c);
    const state = await client.rpc('get_state');
    observe('same_session_reopened', state.sessionFile === c.sessionFile && state.sessionId === firstState.sessionId,
      { expected: { sessionFile: c.sessionFile, sessionId: firstState.sessionId }, actual: { sessionFile: state.sessionFile, sessionId: state.sessionId } });
    const resumed = await client.prompt('CANARY_RESUME');
    const history = await client.rpc('get_messages');
    observe('persisted_tool_history_marker', resumed.piPid !== inspect.piPid && resumed.priorMarker === marker && resumed.historyToolReceipt === true && history.messages.some(m => m.role === 'toolResult' && JSON.stringify(m.content).includes(marker)), resumed);
    const start = client.events.length;
    await client.rpc('prompt', { message: 'CANARY_CANCEL' });
    const update = await client.wait(e => e.type === 'tool_execution_update' && JSON.stringify(e.partialResult).includes('CANARY_SLEEP='), start);
    const output = update.partialResult.content.map(b => b.text ?? '').join('\n');
    const pid = Number(output.match(/CANARY_SLEEP=\{"pid":(\d+)\}/)?.[1]);
    check(Number.isSafeInteger(pid) && pid > 1, 'Expected real sleep PID receipt');
    const abortAt = Date.now();
    await client.rpc('abort');
    await client.wait(e => e.type === 'agent_settled', start, 5000);
    const end = await client.wait(e => e.type === 'tool_execution_end', start, 1000);
    observe('abort_terminal_event_bounded', Date.now() - abortAt < 5000 && end.isError && /aborted/i.test(JSON.stringify(end.result)), { elapsedMs: Date.now() - abortAt, pid });
    const stopped = await client.prompt(`CANARY_STOPPED ${pid}`);
    observe('sleep_descendant_gone', stopped.status === 'ESRCH', stopped);
    report.state = 'passed';
  } catch (error) { report.error = error.message; }
  finally { clearTimeout(timer); await client?.close(); }
  return report;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config;
  try {
    const [mode, flag, path, ...extra] = process.argv.slice(2);
    check(['serve', 'probe'].includes(mode) && flag === '--config' && path && !extra.length, 'Usage: user-isolation-canary.mjs serve|probe --config /absolute/descriptor.json');
    const c = config = loadConfig(path);
    if (mode === 'serve') await serve(c);
    else { const report = await probe(c); console.log(JSON.stringify(report)); if (report.state !== 'passed') process.exitCode = 1; }
  } catch (error) {
    console.log(JSON.stringify({ state: 'failed', mode: config ? (config.sameUidBaseline ? 'same_uid_baseline' : 'cross_uid') : 'descriptor_invalid', error: error.message }));
    process.exitCode = 1;
  }
}
