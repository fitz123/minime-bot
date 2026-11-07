# Standalone agent execution core (issue 252)

`minime-agent-runtime --descriptor /absolute/readonly-descriptor.json` is an
inert, separately launched execution worker. Importing its module starts
nothing. Installation, account provisioning, launch policy, and supervision
belong to the host administrator/controller. The bot's production transports
and SessionManager still use their existing path. This increment neither
activates isolation nor completes the migration.

The earlier `scripts/probes/user-isolation-canary.mjs` established a physical
cross-UID macOS mechanism with an offline provider. That probe and its approved
stage are separate from this reusable core. This core has not been installed
or exercised as a cross-UID deployment.

## Descriptor and capability slice

The version 1 descriptor has no defaults for identity or roots. It requires:

- `agentId`, `workerUid`, `workerGid`, `home`, `controllerUid`, `controllerName`;
- `workspace`, `stateRoot`, `sessionRoot`, `contextRoot`,
  `socketDirectory`, `socketPath` (normalized absolute paths);
- `model` as `provider/model`, `thinking`, `knowledge` (`none` or `v2`),
  `capabilities`, `tools`, and explicit boolean `offline`.

The worker refuses root execution or mismatched UID/GID/HOME. The descriptor file
must be owned by root or the controller and must not be worker writable. In
same-UID tests it must be readonly, for example mode 0444. Trusted in-memory
construction is also supported. The descriptor contains no auth material,
control YAML, instance configuration, transport tokens, executable selection,
or child environment overrides.

The implemented capability is `local-tools`, with an explicit subset of Pi's
`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools. An empty tool list
passes `--no-tools`. All other requested capabilities fail with
`unsupported_capability`. Ask-agent, cross-UID collaboration, Fast, subagents,
cron, Web/provider wrappers, Knowledge tools, media, and outbox delivery are
not adapted in this slice. Knowledge v2 **context** can be required independently
of Knowledge **tools**. There is no global extensions kill-switch workaround.

Ambient extensions, skills, prompt templates, and context discovery are disabled.
Only the trusted constructor's `trustedTestExtensions` can add fixture code;
there is no extension-path, cwd, executable, environment, or transcript-path
field in IPC. The standalone CLI does not load test extensions. Offline tests
register a synthetic provider and execute real Pi tools without network or real
auth. Later provisioning may supply the worker's own user-local Pi auth below
`stateRoot/pi`; the worker never copies controller auth or passes API-key env
fallbacks.

## Context and session ownership

The workspace must contain a real local `CLAUDE.md`. Declared imports and rules
are assembled strictly into private artifacts below `contextRoot/.tmp` before
Pi is spawned. With `knowledge: "v2"`, local marked `wiki/schema.md` and
`wiki/index.md` are required. The binding record preserves the content-redacted
context manifest; controller state exposes only its digest. External/symlink
rule directories are rejected before the assembler's legacy shared-platform
resolver can consult control configuration. An external shared-rules substrate
remains pending policy approval.

The worker owns Pi, context artifacts, transcripts, and per-lane records. Private
roots are canonical worker-owned 0700 directories; records/transcripts are 0600.
Pi is resolved from the package's pinned 1.5.0 dependency, never PATH. Its child
environment is explicitly constructed from descriptor roots and fixed runtime
settings. The legacy deployment resolver/context fallback is not used.

Each lane directory records that a lane existed. Pi authors its transcript
header; the worker fsyncs the exact binding and generation before spawning Pi,
then verifies Pi's correlated startup session ID **and** exact transcript file,
model, and thinking selection. Pi fuzzy-model fallback is rejected.
Close and restart reuse that same binding. Existing missing/corrupt bindings or
transcripts cause an error rather than minting replacement identities. An
incomplete initial lane allocation also needs explicit administrator recovery;
there is no automatic repair or history rotation. Only one worker may own a
state root: there is no cross-process lease or database.

## Controller API and failure semantics

`AgentRuntimeClient.connect(socketPath)` exposes `open(laneId,
expectedSessionId?)`, `prompt(handle, requestId, text, onEvent?)`,
`getState(handle)`, `abort(handle, requestId)`, `close(handle)`, and `shutdown()`.
A prompt returns separate `accepted` and `completed` promises; `onEvent` receives
normalized text/tool/result stream events. Native Pi `agent_settled` completes a
started run; `agent_end` alone does not. A correlated Pi preflight rejection may
finish without a run. Paths, cwd, executable details, and child environment are
not included in controller state.

Handles contain opaque agent/lane/session identity and a persisted generation.
Open increments the generation; old handles reject. One connection owns an open
lane. Lane transitions are serialized by rejecting conflicting calls; a lane
accepts only one prompt at a time. There is no queue or implicit resend. State
contains the current/last request ID and `accepted`, `settled`, or `interrupted`
outcome. `settled` means the lifecycle ended, including a model/tool failure;
the result event carries the prompt result. Only the most recent request ID is
retained, not an idempotency ledger. An interrupted request is never replay-safe.

Acceptance is persisted before writing the prompt to Pi. After restart an
unsettled accepted request becomes `interrupted` when its lane is reopened.
Reconnect by opening with the expected session ID, then inspect state. A client
disconnect or deadline reports `AgentRuntimeUncertainError`; acceptance or
partial tool side effects may already have occurred. The client never
reconnects/resends automatically. The worker aborts owned work on disconnect.

Abort terminates/reaps the owned Pi process and tool descendants, then opens the
same exact transcript with the same handle before accepting another prompt.
Close, disconnect, and SIGTERM reap Pi without deleting history. Cleanup uses
Pi 1.5.0's tracked detached-tool SIGTERM behavior, with bounded process-group
SIGKILL fallback. This is not a generic supervisor; the host still owns worker
lifecycle. A hard worker kill/power loss remains host-supervisor recovery work.

IPC is versioned LF-delimited JSON, with a 1 MiB frame bound, 5-second incomplete
frame deadline, bounded client calls, 10-second Pi startup and 120-second worker
prompt deadlines. Trusted constructors may select finite deadlines up to
300 seconds. Oversized/invalid requests fail explicitly and close the connection.
The worker has one stdout reader per Pi lifetime, correlating startup replies
and prompt events without competing readers.

On macOS cross-UID endpoints use a worker-owned 0700 directory and 0600 socket,
with sole exact `user:<controllerName> allow search` and `... allow write` ACLs,
respectively. Same-UID runs omit ACL grants. No native peercred module or custom
auth manager is introduced. Shared package code and the controller are trusted;
these checks are coordination and filesystem isolation, not a same-UID hostile
agent boundary.

## Validation and remaining work

`src/__tests__/agent-runtime-core.test.ts` directly exercises the real pinned Pi
core without binding a socket. `src/__tests__/agent-runtime.test.ts` launches
separate unprivileged controller/worker processes using the actual socket client
and synthetic local fixtures. The socket suite requires a host that permits
Unix-socket listen; a sandbox `listen EPERM` is not integration evidence and
must not be converted to a passing skip.

Remaining migration work includes adapted first-party wrappers and transport
integration; collaboration/consultation, cron and outbox boundaries; approved
external rules; explicit per-user auth provisioning; additional isolated agents;
and representative production canaries with history preservation. No production
readiness or parity claim follows from these source tests.
