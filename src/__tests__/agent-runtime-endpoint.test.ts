import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// Metadata/ACL unit tests only; actual endpoint evidence lives in the host socket suite.
const directory = '/synthetic/endpoint';
const socket = `${directory}/worker.sock`;
const uid = process.getuid!();
const metadata = new Map<string, { uid: number; mode: number; symlink: boolean; kind: string }>();
const acls = new Map<string, string[]>();
let controllerUid = uid;
let commands: string[] = [];
function reset() {
  metadata.set(directory, { uid, mode: 0o700, symlink: false, kind: 'directory' });
  metadata.set(socket, { uid, mode: 0o600, symlink: false, kind: 'socket' });
  acls.clear(); commands = []; controllerUid = uid;
}
reset(); afterEach(reset);
mock.module('node:fs', { namedExports: {
  lstatSync(path: string) {
    const s = metadata.get(path);
    if (!s) throw new Error('Unexpected metadata path');
    return { uid: s.uid, mode: s.mode, isSymbolicLink: () => s.symlink,
      isDirectory: () => s.kind === 'directory', isSocket: () => s.kind === 'socket' };
  },
  readFileSync() { throw new Error('Endpoint verification must not read worker files'); },
  realpathSync() { throw new Error('Unexpected realpath'); },
} });
mock.module('node:child_process', { namedExports: {
  execFileSync(command: string, args: string[]) {
    commands.push(command);
    if (command === '/usr/bin/id') return String(controllerUid);
    if (command === '/bin/ls') return (acls.get(args[1]) ?? []).map((acl, i) => ` ${i}: ${acl}`).join('\n');
    throw new Error('Endpoint verification must never provision ACLs');
  },
} });
const { verifyAgentRuntimeEndpoint } = await import('../agent-runtime-descriptor.js');

test('same-UID endpoint requires worker ownership, nonsymlink types and exact private modes', () => {
  verifyAgentRuntimeEndpoint(socket, { workerUid: uid });
  assert.deepEqual(commands, []);
  for (const path of [directory, socket]) {
    for (const patch of [{ uid: uid + 1 }, { mode: 0o777 }, { symlink: true }, { kind: 'file' }]) {
      reset(); Object.assign(metadata.get(path)!, patch);
      assert.throws(() => verifyAgentRuntimeEndpoint(socket, { workerUid: uid }), /nonsymlink, worker-owned/);
    }
  }
});

test('cross-UID expected identity is explicit and requires exact controller ACLs without provisioning', () => {
  assert.throws(() => verifyAgentRuntimeEndpoint(socket, { workerUid: uid + 1 }), /requires expected/);
  for (const path of [directory, socket]) metadata.get(path)!.uid = uid + 1;
  const expected = { workerUid: uid + 1, controllerName: 'fixture-controller' };
  if (process.platform !== 'darwin') {
    assert.throws(() => verifyAgentRuntimeEndpoint(socket, expected), /requires macOS ACLs/);
    return;
  }
  acls.set(directory, ['user:fixture-controller allow search']);
  acls.set(socket, ['user:fixture-controller allow write']);
  verifyAgentRuntimeEndpoint(socket, expected);
  for (const path of [directory, socket]) {
    const correct = acls.get(path)!;
    for (const incorrect of [[], ['user:other-controller allow write'], [...correct, 'user:other-controller allow read'], ['user:fixture-controller allow read,write']]) {
      acls.set(path, incorrect);
      assert.throws(() => verifyAgentRuntimeEndpoint(socket, expected), /sole exact controller ACL/);
    }
    acls.set(path, correct);
  }
  controllerUid = uid + 2;
  assert.throws(() => verifyAgentRuntimeEndpoint(socket, expected), /name\/UID mismatch/);
  assert.equal(commands.includes('/bin/chmod'), false);
});
