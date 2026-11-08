# Issue252 execution canary (preparatory tooling)

This standalone, credential-free probe uses this checkout's actual Pi **1.5.0**
CLI and an explicitly loaded offline provider. It is not imported by the runtime
or included in package publication. It tests synthetic execution, transcript
resume, and cancellation; a passing result does not establish production runtime
isolation or provider authentication behavior.

The parent owns account/privilege provisioning, clean dependency publication,
root-owned staging, the external descriptor and launchd plist, and all lifecycle
operations. The harness never uses sudo, installs itself, changes services, or
restarts itself. Do not point it at production homes, sessions, configuration,
source installations, or private data. The sole exception is the explicit
`controllerHomeProbePath` metadata probe described below; it never lists or reads
that home's contents or changes its permissions.

## Descriptor and staging

Both modes accept only `--config /absolute/descriptor.json`. The fixed, nonsecret
JSON object has these fields (paths below describe roles, not deployable values):

| Field | Contract |
| --- | --- |
| `controllerUid`, `workerUid` | Positive integer UIDs; root is forbidden in either role. |
| `workerGid` | Positive integer primary GID; must match the worker and tool receipt. Baseline uses `process.getgid()`. |
| `controllerName` | Exact controller account's short name; cross-UID server verifies its UID using `/usr/bin/id`. |
| `sameUidBaseline` | Explicit boolean. Must be true exactly when the two UIDs match. |
| `nodePath` | Absolute nonsymlink path to Node used to start the server; cross-UID trust exception below. |
| `piCliPath` | Absolute nonsymlink path to this tree's `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`. |
| `providerPath` | Absolute nonsymlink path to the sibling `user-isolation-provider.mjs`. |
| `home` | Empty, canary-only private worker HOME. Server's initial HOME must already match. |
| `workspace` | Distinct canary-only worker working directory; no production context. |
| `tmpDir` | Canary-only worker temporary directory. |
| `socketDir` | Preprovisioned worker-owned directory, POSIX mode 0700. |
| `socketPath` | Direct child of `socketDir`, UTF-8 byte length less than 104. Must not already exist. |
| `sessionFile` | Fixed absolute JSONL path beneath `home`, e.g. `home/sessions/canary.jsonl`. |
| `privateFixturePath` | Controller-readable synthetic file outside worker state; its controller-owned, staff-group (20) parent is mode 0750 and inaccessible to the cross-UID worker. |
| `controllerHomeProbePath` | Absolute controller home directory outside worker state. Mandatory cross-UID, optional baseline; metadata access only. |
| `protectedFilePath` | Synthetic protected file inside the shared root-owned canary code tree, outside worker state. |
| `deadlineSeconds` | Integer 1–300. Use at least 30 seconds for the full probe. |

Use normalized absolute paths with no symlink components. Keep the descriptor,
code, dependencies, and socket directory's parent chain root-owned and not group
or world writable for cross-UID runs. The nonsecret descriptor must be readable
by both accounts (usually mode 0644). The root-owned canary tree must be searchable
by the intended accounts. The parent must supply pristine staging ACLs: no
inherited grants to other users, groups, or everyone. The endpoint directory and
socket ACLs are checked exactly at runtime; the parent retains the full ancestor
ACL staging audit. No general ancestor ACL checker is added.

The deliberate exception is configured `nodePath` and its ancestor chain: they
may be owned by root or the trusted controller UID, with owner write and optional
admin-group (GID 80) write, never world write or worker write. This accepts the
controller's Homebrew Node installation and its dylib dependencies, which the
parent audits as trusted controller/admin code and not canary writable. Do not
copy only the Node executable: it still needs those dylibs. Pi, provider, shared
probe, and their staging ancestors remain root-owned and nonwritable by groups
or everyone. The parent hashes the actual Node executable externally; the real
Node tool receipt records `process.version` without a runtime hash protocol.

Preprovision a private worker-owned state parent; the server creates `home`, its
`agent` and session directories, `workspace`, and `tmpDir` beneath appropriate
parents, with mode 0700 and umask 077. Existing directories must already be private
and worker-owned. Existing session evidence must be a nonsymlink private file.
Do not copy any real auth or settings into this HOME. Use separate state roots
and avoid overlapping them with the shared code tree or synthetic access fixtures.

Initialize the two **synthetic** access files with exactly these UTF-8 bytes:

```text
privateFixturePath:   ISSUE252_SYNTHETIC_PRIVATE\n
protectedFilePath:   ISSUE252_SYNTHETIC_PROTECTED\n
```

Here `\n` means a single newline. The controller checks both sentinel contents
before asking Pi to operate on them. Give the private file controller ownership
and mode 0600; give the protected file root ownership and mode 0644 (or 0444).
The private fixture's parent must be controller:staff mode 0750. The worker
separately calls `fs.accessSync(dirname(privateFixturePath), R_OK | X_OK)` and
requires EACCES/EPERM, so a mode-0600 file denial cannot hide group traversal.
The controller home probe calls only `fs.accessSync(controllerHomeProbePath,
R_OK | X_OK)`, with no readdir, file reads, or changes to the actual home.
Cross-UID access must fail with EACCES/EPERM; otherwise the probe fails and stops.
A missing path or other error does not count as isolation. Baseline expects
metadata access to both directories to succeed when configured. No real private
file contents are printed. Each metadata assertion records the requested
`R_OK|X_OK` flags and actual access receipt. The write attempt opens the existing synthetic protected file with `r+` and writes a synthetic prefix on
success; it never creates a missing target. A cross-UID run requires EACCES or
EPERM and verifies that the protected sentinel remains unchanged. A same-UID
baseline requires both accesses to succeed, so provision both files writable/
readable as that UID and restore only the synthetic protected sentinel before
repeating that baseline. Session history is retained across runs.

For same-UID local baselines, the descriptor and staging may instead be owned by
that UID. Root-owned sticky temporary ancestors are allowed, and user-owned
runtime ancestors may be group writable (for example a local package manager's
Cellar). Socket/descriptor staging remains nonwritable by groups or everyone.
No ACLs are inspected or added in baseline mode and no cross-user denial claim
is made. Cross-UID worker primary GID must match `workerGid`, and explicit GIDs
20 (staff) and 80 (admin) must be absent from the primary/supplementary groups.
All observed groups are retained in the receipt; this does not claim that all
dynamic macOS memberships disappear. Actual directory access probes provide
the evidence for the requested denials.

## Running

After the parent publishes the clean harness, fixture and `npm ci` dependencies,
it starts the server as the configured worker, with HOME set to the canary HOME:

```sh
/absolute/node /absolute/scripts/probes/user-isolation-canary.mjs serve --config /absolute/descriptor.json
```

The parent runs the controller as the normal configured controller UID:

```sh
/absolute/node /absolute/scripts/probes/user-isolation-canary.mjs probe --config /absolute/descriptor.json
```

The server emits JSON `ready` and `pi_start` reports with nonsecret UID/PID and
version information. In cross-UID macOS mode it uses owner-authorized
`/bin/chmod +a` to add only `user:<controllerName> allow search` to the socket
directory and `user:<controllerName> allow write` to the socket. It does not grant
group/everyone access. `/bin/ls -lde` inspects each absolute endpoint target,
without a shell. Only ACL entry lines are parsed: the sole exact entry must be
the controller user with `search` on the directory or `write` on the socket.
Extra, duplicate, broad, inherited, and expanded-permission entries are rejected.
Before adding a directory ACL, the server inspects it: an already exact sole
grant is reused, an empty ACL gets the grant, and a mismatch stops startup. The
socket is fresh each run. ACLs are checked after bind and before every controller
connection, including reconnects. These canary directory ACLs remain for inspection.

Each sequential connection starts a fresh Pi process with the exact same
`--session` path. The socket relays native newline Pi RPC; there is no custom
command executor. The controller waits for actual `agent_settled` events and
checks real bash receipts. The resume prompt contains no marker: the fixture
extracts the latest unique inspect marker from Pi's loaded tool-result history,
prints it through bash, and the controller checks it and the changed Pi PID.
Cancellation starts a bounded 20-second sleep descendant, waits for its actual
PID receipt, sends Pi `abort`, checks the terminal tool error within 5 seconds,
and asks a real worker-side Node tool to confirm ESRCH for that PID.

Pi receives an allowlisted environment only: canary HOME/TMPDIR/agent directory,
USER/LOGNAME, `/bin/bash`, explicit PATH, offline/version/telemetry flags, and the
nonsecret descriptor. It gets `--no-extensions --no-skills --no-prompt-templates
--no-context-files`, followed by only the offline fixture and the built-in bash
tool. It never inherits the launcher's credentials or workspace variables.
Disconnect, server SIGTERM/SIGINT, or deadline triggers owner-side Pi/process-group
cancellation. Pi 1.5.0 itself tracks and kills its detached bash groups on SIGTERM;
the harness bounds Pi termination with a 2-second SIGKILL fallback. The server
reserves 2.5 seconds of the configured lifetime for cleanup, closes sockets, and
exits without a restart loop. It removes only its socket; transcripts, marker,
outbox, directories, and reports remain. The external parent plist should use
`KeepAlive=false`.

The controller emits one JSON report: `state: passed|failed`,
`mode: same_uid_baseline|cross_uid`, `transport: unix_socket`, and individual
observed assertions. Any required failure produces a nonzero exit code.
Validated startup failures carry the same explicit mode; errors before a
trusted descriptor is loaded use `mode: descriptor_invalid`. Both produce a
failed JSON record and nonzero exit.
The parent collects server stdout and the report; neither role deletes history.

## Offline verification

From the package root, with dependencies installed:

```sh
node --check scripts/probes/user-isolation-canary.mjs
node --check scripts/probes/user-isolation-provider.mjs
node --check scripts/probes/user-isolation-canary.test.mjs
node --test scripts/probes/user-isolation-canary.test.mjs
```

Tests use only synthetic files under this checkout's ignored `.tmp/u-*`; no
privilege/account/ACL changes are performed. The suite exercises validation
failures, synthetic injected-stat Node trust cases, captured synthetic macOS
ACL text, metadata isolation failures, and a real Pi same-UID baseline with
metadata-access and actual Node-version receipts. It also retains a full socket
test for resume, abort, disconnect cancellation, deadline cancellation, and evidence
preservation. If socket binding returns EPERM, that socket test explicitly skips;
the same probe assertions still run against real Pi over direct RPC pipes,
labelled `transport: test_pipe`, without an endpoint-ownership assertion. This
pipe baseline proves no Unix socket or cross-UID ACL behavior. Its structured
report is retained as `.tmp/u-*/h/baseline-report.json` alongside Pi transcripts.
The parent must run the socket test and real provisioned cross-UID canary outside
such a sandbox before claiming that portion is verified.
