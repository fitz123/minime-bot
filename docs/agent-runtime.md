# Agent execution worker

`minime-agent-runtime --descriptor /absolute/readonly-descriptor.json` is an
inert, separately launched execution worker. Importing its module starts
nothing. Installation, account provisioning, launch policy, and supervision
belong to the host administrator. Normal Telegram and Discord text can opt in
per agent. Existing configurations continue to use local Pi.

The earlier `scripts/probes/user-isolation-canary.mjs` established a physical
cross-UID macOS mechanism with an offline provider. That probe and its approved
stage are separate from this reusable core. This core has not been installed
or exercised as a cross-UID deployment.

## Opt-in text routing

Add a `workerRuntime` object to the existing agent entry in the bot's canonical
configuration. The example uses a synthetic endpoint and identity.

```yaml
agents:
  satellite:
    workspaceCwd: /example/previous-workspace
    model: example/model
    workerRuntime:
      socketPath: /example/worker/agent.sock
      workerUid: 60001
      controllerName: example-controller
```

The controller selects routes at startup. Change the route with the controller
and the agent's scheduled jobs stopped. Use a dedicated worker for this
controller's session store. The worker UID must be distinct and nonroot. The
descriptor's `agentId` must match the config map key. Use the descriptor for the
worker's model, tools, workspace, context, and auth. The existing controller
model and workspace fields remain required for the agent config.

A fresh transport lane, such as a new thread with the existing agent binding,
can open a worker session immediately. An existing local lane requires the
explicit adoption below. An ID-only legacy store with history for the selected
agent must first complete the existing local store migration with worker routing
off. The controller store records an opaque worker session ID. Reopen requires
that exact identity. If the route is removed or the worker binding disappears,
the lane fails closed.

The worker opens Pi for a turn, confirms settlement, and closes Pi before the
transport sends the final answer. The queue collects later text during a turn
and sends it as a separate follow-up. A missing worker fails the message without
starting local Pi. A lost completion is reported as uncertain and the message
is never automatically replayed. If the next exact open reports an interrupted
turn, further prompts require operator inspection. There is no chat command for
clearing that worker state.

This route handles text. Attachments and voice are rejected before download or
transcription. Outbox delivery, live steering, passive echo steering, private
topic tools, Fast controls, and session cleanup/reconnect commands are
unavailable on worker lanes. Collaboration and trigger input cannot target a
worker agent. Worker agents can receive opt-in one-shot Ask Agent questions
through the separate operation below. Transport bindings and reply delivery
remain controller responsibilities.

## Adopt or roll back one existing text lane

Quiesce controller work for the selected lane, including queued messages and
any live local Pi process. Run the binding commands with the same controller
workspace, instance overlay, and Pi session-directory resolution the controller
uses. The lane argument is the exact key in the controller's session store.
Leave the worker available for exact open verification.

Prepare an independent 0600 worker-owned copy of the current-version transcript
directly under the descriptor's session root. Its filename is
`adopt-chat-<sha256 of the UTF-8 session-store key>.jsonl`. In the copy's JSON
header, set `cwd` to the worker's canonical workspace. Preserve the other
header fields and their order, the session ID, every subsequent byte, and the
final newline. The handoff into the worker's private root is an administrator
operation. IPC carries the expected identities and digest only.

~~~sh
minime-bot worker-lane adopt --workspace /example/control --agent satellite --lane example-lane
minime-bot worker-lane rollback --workspace /example/control --agent satellite --lane example-lane
~~~

Adoption checks the local binding and the staged copy, opens the exact worker
transcript with pinned Pi, and updates the selected controller record while the
connection owns the worker lane. A stale selected record causes the write to
fail. Other records are reloaded under the store writer lock and retained.
If the worker adopted the transcript before the controller commit failed,
retrying from the same unchanged local history reuses the worker binding.
An existing worker lane from a different source blocks adoption.

Rollback verifies the original endpoint, the exact adopted worker session, and
the saved local transcript before restoring the selected lane to local Pi.
It refuses a changed or missing local transcript, a changed binding, an
unavailable or busy worker, and a prior interrupted worker request. Settled
worker turns stay in the worker copy. Local replies after rollback extend the
original local transcript, so the two histories can diverge. Repeat adoption
requires the same original history. Automatic history merging is unsupported.

Keep the controller quiesced for the selected lane through the operation and
reload its in-memory session store before resuming traffic. A competing store
writer can cause a lock error. After an interrupted process, inspect the
selected binding and verify writer ownership before clearing a stale store
lock. Controllers predating this format reject records carrying adoption or
rollback metadata.

## Scheduled LLM jobs

Set `workerRuntime.scheduledLlm: true` to route that agent's LLM cron
execution through the worker. Existing local cron jobs keep their print-mode
path. Scripts for worker-routed agents and worker LLM jobs without this
additional opt-in fail before execution or outbox replay.

Each invocation opens a fresh `cron-` lane with the expected agent identity
and submits one prompt using the descriptor's model, workspace, context and
tools. The worker forces Fast off through the packaged Codex request wrapper
and the cron child environment. The runner uses the smaller of the configured
prompt timeout and the 130-second client bound. Worker prompt and cleanup
deadlines also apply. A lane and its private transcript are retained for
inspection. The controller logs the opaque lane ID and uses a fresh lane on
the next scheduled invocation.

The controller waits for correlated settlement and confirmed close before
passing any output to its existing unresolved-marker, `NO_REPLY`, delivery,
and outbox logic. A worker failure or uncertain completion ends the invocation
without replaying its prompt or starting local Pi. Worker-created files and
the local cron Web wrapper are outside this delivery path.

## Inbound Ask Agent

Set `workerRuntime.inboundConsultation: true` on the target agent's controller
route and add `"inbound-consultation"` to the worker descriptor's
`capabilities`. Both opt-ins default to off. The controller also requires
`askAgent.enabled: true` for both agents and applies the caller's `canAsk` and
`deny` lists. Worker-routed callers are refused.

For each call, the controller verifies the existing protected endpoint and
checks the expected agent ID and inbound capability on a fresh connection.
Only after confirmation does it send the question. Questions are capped at
64 KiB in UTF-8. The worker route rejects the optional `context` field,
including an explicit empty value. The protocol has no fields for paths,
tools, model selection, environment, or a session handle.

The worker accepts at most one active consultation at a time. It assembles
the target's private context, starts pinned Pi RPC with the SDK's in-memory
session, checks its model, thinking level, and empty history, and submits one
prompt. The consultation has a 120-second worker deadline including startup,
with a 10-second startup bound. The controller allows 15 seconds for preflight
and 130 seconds after sending the question. Worker shutdown, socket loss,
and deadlines stop the owned process. The worker returns its answer only
after reap, then closes the connection. There is no durable lane, transcript,
resume, automatic retry, or local fallback. A hard worker crash during
startup can leave a private context artifact containing only the target's
assembled context. The worker removes its reserved scratch directory on
startup and before prompting Pi.

The descriptor selects the workspace, model, context, and read-only tool
allowlist. From `local-tools`, only `read`, `grep`, `find`, and `ls` are
available. The `knowledge-tools` capability adds `knowledge_search` and
`knowledge_get`. Bash, edit/write, Knowledge updates, Web, MCP, Code Mode,
skills, extra extensions, Fast, Ask Agent, subagents, collaboration, and
delivery tools are unavailable. Filesystem access follows the worker's OS
permissions.

Pi uses the worker's existing subscription login under `stateRoot/pi` for
chat, cron, and consultations. The descriptor must select a bundled model
for the provider the worker signed in to. Pi owns credential access and
refresh in that profile. Each consultation supplies in-memory settings with
agent and provider retries, automatic compaction, and cache warming disabled.
It uses SSE to avoid Codex WebSocket resubmissions and disables Anthropic's
strict-tool resubmissions and model fallbacks for the consultation.

The pinned Pi 1.5.0 implementation uses the following paths under
`node_modules/@earendil-works/`.

- `pi-coding-agent/dist/config.js:510` resolves the worker's
  `PI_CODING_AGENT_DIR`. `dist/core/model-runtime.js:79` uses the default
  credential store and selects an in-memory model catalog with
  `modelsPath: null`. `dist/core/auth-storage.js:289` opens `auth.json` in
  the agent directory.
- `pi-coding-agent/dist/core/settings-manager.js:251` and
  `dist/core/session-manager.js:1376` provide in-memory settings and session
  storage. The CLI RPC setters at `dist/modes/rpc/rpc-mode.js:421` call
  settings setters that save to storage at
  `dist/core/settings-manager.js:646` and `:697`.
- `pi-coding-agent/dist/core/sdk.js:193` passes the provider retry budget
  into requests, and `:285` selects the transport. Codex WebSocket and SSE
  retry paths are in `pi-ai/dist/api/openai-codex-responses.js:193` and
  `:261`. Anthropic's strict-tool resubmission and fallback selection are in
  `pi-ai/dist/api/anthropic-messages.js:453` and `:1011`.

The result contains one answer, capped at 32,768 UTF-16 code units and 128 KiB,
with the usual truncation and clarification flags. Errors contain no question,
answer, or provider diagnostics. A missing controller opt-in yields
`unsupported_runtime`, and submitting `context` yields `invalid_request`.
Worker preflight can return `agent_mismatch`,
`consultation_disabled`, or `consultation_unavailable` for a bad endpoint or
legacy protocol. Other codes include `consultation_busy`,
`consultation_timeout`, `consultation_failed`, and
`consultation_cleanup_failed`. A cancelled call before send returns
`cancelled`. Cancellation, connection loss, or a missing or invalid result
after send yields `uncertain_outcome`. A missing answer does not show whether
the provider received the question.

## Descriptor and capability slice

The version 1 descriptor has no defaults for identity or roots. It requires:

- `agentId`, `workerUid`, `workerGid`, `home`, `controllerUid`, `controllerName`;
- `workspace`, `stateRoot`, `sessionRoot`, `contextRoot`,
  `socketDirectory`, `socketPath` (normalized absolute paths);
- `model` as `provider/model`, `thinking`, `knowledge` (`none` or `v2`),
  `capabilities`, `tools`, and explicit boolean `offline`.

The optional `behavioralFoundationRoot` selects a required published foundation;
each lane load pins its physical revision. Workers receive this path explicitly
and never discover it through central control config.

The worker refuses root execution or mismatched UID/GID/HOME. The descriptor file
must be owned by root or the controller and must not be worker writable. In
same-UID tests it must be readonly, for example mode 0444. Trusted in-memory
construction is also supported. The descriptor contains no auth material,
control YAML, instance configuration, transport tokens, executable selection,
or child environment overrides.

The `local-tools` capability selects an explicit subset of Pi's
`read`, `bash`, `edit`, `write`, `grep`, `find`, and `ls` tools. An empty tool list
selects no local tools. The optional `knowledge-tools` capability requires
`knowledge: "v2"` and registers `knowledge_search`, `knowledge_get`, and
`knowledge_update`, plus the existing managed Knowledge write protection.
It can be used independently of `local-tools`. The worker resolves only the
Knowledge wrapper bundled with its executing source/distribution; a missing or
unloadable required wrapper fails before prompt execution. Ambient extension
settings cannot disable a requested capability. The `inbound-consultation`
capability applies to the separate Ask Agent operation above. Other capabilities fail with
`unsupported_capability`. Cross-UID collaboration, interactive Fast,
subagents, Web/provider wrappers, media, and worker-side outbox delivery remain
outside the worker capability slice. Knowledge v2 **context** can be required independently
of Knowledge **tools**. Workers with neither tool capability pass `--no-tools`.
Knowledge calls use only the worker-local `MINIME_AGENT_WORKSPACE_ROOT`; no
controller configuration or auth is passed over IPC.

Ambient extensions, skills, prompt templates, and context discovery are disabled.
Prepared worker spawns always pass `--system-prompt`: the explicit persona path
when present, otherwise an empty string. In pinned Pi 1.5.0 this suppresses
independent `SYSTEM.md` discovery while retaining Pi's built-in default prompt.
Descriptor capabilities select package wrappers. The trusted constructor's
`trustedTestExtensions` can also add fixture code;
there is no extension-path, cwd, executable, environment, or transcript-path
field in IPC. The standalone CLI does not load test extensions. Offline tests
register a synthetic provider and execute real Pi tools without network or real
auth. Later provisioning may supply the worker's own user-local Pi auth below
`stateRoot/pi`. The worker uses its own auth and omits API-key env fallbacks.
Adopted and scheduled runs require any existing `auth.json` there to be an
independent 0600 worker-owned file.

## Context and session ownership

The workspace must contain a real local `CLAUDE.md`. Declared imports and rules
are assembled strictly into private artifacts below
`contextRoot/<sha256(laneId)>/.tmp` before Pi is spawned. With a foundation,
artifact names include the context digest. Old artifacts are intentionally retained
so active reloads and parallel contexts preserve their original bytes. This can
accumulate artifacts without bound; lifecycle-aware cleanup remains outside this scope.
With `knowledge: "v2"`, local marked `wiki/schema.md` and
`wiki/index.md` are required. The binding record preserves the content-redacted
context manifest; controller state exposes only its digest. External/symlink
rule directories are rejected. With a configured publication, the exact
`.claude/rules/platform` symlink is ignored without resolving its legacy target;
other local rule escapes still fail. Without a publication, external rule
directories are rejected before legacy central-config discovery. The approved
publication contract is described in [shared-behavior.md](shared-behavior.md).

The worker owns Pi, context artifacts, transcripts, and per-lane records. Private
roots are canonical worker-owned 0700 directories; records/transcripts are 0600.
Pi is resolved from the package's pinned 1.5.0 dependency, never PATH. Its child
environment is explicitly constructed from descriptor roots and fixed runtime
settings. The legacy deployment resolver/context fallback is not used.

Each lane directory records that a lane existed. Pi authors its transcript
header; the worker fsyncs the exact binding and generation before spawning Pi,
then verifies Pi's correlated startup session ID **and** exact transcript file,
model, and thinking selection. Pi fuzzy-model fallback is rejected.
Close and restart reuse that same binding. Missing, corrupt, or unsafe binding
records reject rather than minting replacement identities. Transcript checks
cover path, ownership/mode, header, identity, and Pi openability; they do not
validate full JSONL integrity. Pinned Pi 1.5.0 skips malformed later records,
including an unparseable partial tail, when loading history. A parseable final
record is handled normally. For a valid-header file with a nonempty unterminated
tail, Pi appends a newline; it does not truncate the skipped malformed bytes.
Exact adoption fingerprints the staged history and relies on the same Pi
JSONL open behavior. Whole-history repair remains outside the operation.
An incomplete initial lane allocation also needs explicit
administrator recovery;
there is no automatic repair or history rotation. Only one worker may own a
state root: there is no cross-process lease or database.

## Controller API and failure semantics

`AgentRuntimeClient.connect(socketPath)` exposes `open(laneId,
expectedSessionId?, expectedAgentId?)`, `adopt(laneId, expectedSessionId,
expectedAgentId, adoptionDigest)`, `prompt(handle, requestId, text, onEvent?)`,
`getState(handle)`, `abort(handle, requestId)`, `close(handle)`, and `shutdown()`.
A prompt returns separate `accepted` and `completed` promises; `onEvent` receives
normalized text/tool/result stream events. A thrown `onEvent` error rejects that
prompt call with the original error. The connection and other lanes remain
usable, and later frames are still parsed. The worker may continue that prompt;
inspect its lane state before further work. Native Pi `agent_settled` completes a
started run; `agent_end` alone does not. A correlated Pi preflight rejection may
finish without a run. Paths, cwd, executable details, and child environment are
not included in controller state.

Handles contain opaque agent/lane/session identity and a persisted generation.
Open increments the generation; old handles reject. One connection owns an open
lane. Lane transitions are serialized by rejecting conflicting calls; a lane
accepts only one prompt at a time. Public `close` rejects with `busy` while a
lane is opening or closing, including abort cleanup and its reopen. Internal
cleanup remains idempotent. There is no queue or implicit resend. State
contains the current/last request ID and `accepted`, `settled`, or `interrupted`
outcome. `settled` means the lifecycle ended, including a model/tool failure;
the result event carries the prompt result. Only the most recent request ID is
retained, not an idempotency ledger. An interrupted request is never replay-safe.

Acceptance is persisted before writing the prompt to Pi. After restart an
unsettled accepted request becomes `interrupted` when its lane is reopened.
Reconnect by opening with the expected session ID, then inspect state. A client
disconnect or any transport/client call deadline reports
`AgentRuntimeUncertainError` and ends the shared connection, interrupting all
lanes it owns. Acceptance or partial tool side effects may already have occurred.
The client never reconnects/resends automatically. The worker aborts owned work on disconnect.

Abort terminates/reaps the owned Pi process and active tracked tools, then opens
the same exact transcript with the same handle before accepting another prompt.
Close, disconnect, and SIGTERM reap Pi without deleting history. Cleanup uses
Pi 1.5.0's active tracked bash-group SIGTERM behavior, with bounded process-group
SIGKILL fallback. Pi stops tracking a bash group once its originating shell
returns. Detached jobs whose originating bash tool already completed are outside
this cleanup guarantee. Keep worker bash work foregrounded and awaited; any
escaped user-local background work requires explicit operator ownership. Cleanup
is not proof that all processes under the worker UID are gone. This slice has
no descendant supervisor and does not claim production parity. The host owns
worker lifecycle, including hard worker kill/power-loss recovery.

IPC is versioned LF-delimited JSON, with a 1 MiB frame bound, 5-second incomplete
frame deadline, bounded client calls, 10-second Pi startup and 120-second worker
prompt deadlines. The default client prompt completion deadline is 130 seconds,
allowing 10 seconds for worker timeout cleanup and transport. Explicit custom
client/worker bounds remain finite, up to 300 seconds; callers selecting a custom
worker deadline must leave a suitable client margin. The raw Pi stdout splitter
is unbounded, as in the local Pi path: large image/tool/`agent_end` records may
normalize to small controller events. The 1 MiB bound remains on controller IPC.
Oversized/invalid requests fail explicitly and close the connection.
The worker has one stdout reader per Pi lifetime, correlating startup replies
and prompt events without competing readers.

On macOS cross-UID endpoints use a worker-owned 0700 directory and 0600 socket,
with sole exact `user:<controllerName> allow search` and `... allow write` ACLs,
respectively. Before connecting, the client verifies the nonsymlink directory
and socket types, expected worker ownership, and these modes. Same-UID calls
default the expected worker UID to the caller UID and omit ACL grants.
Cross-UID callers must configure the expected identity locally:
`AgentRuntimeClient.connect(socketPath, undefined, { workerUid, controllerName })`.
The caller UID supplies the controller UID; the controller name must resolve to
it. The client verifies both sole exact controller ACLs without provisioning or
changing them. Identity is never taken from IPC. No native peercred module or
custom auth manager is introduced. Shared package code and the controller are trusted;
these checks are coordination and filesystem isolation, not a same-UID hostile
agent boundary.

## Validation and remaining work

`src/__tests__/agent-runtime-core.test.ts` directly exercises the real pinned Pi
core without binding a socket. `src/__tests__/agent-runtime.test.ts` launches
separate unprivileged controller/worker processes using the actual socket client
and synthetic local fixtures. The socket suite requires a host that permits
Unix-socket listen; a sandbox `listen EPERM` is not integration evidence and
must not be converted to a passing skip.

`src/__tests__/worker-continuity-offline.test.ts` exercises the package CLI,
ordinary session entry point and cron runner with real pinned Pi and a synthetic
provider. Its in-memory wire replaces socket I/O and endpoint checks. Cron
delivery is a controller-side test double. Cross-UID endpoints and authentic
provider requests require separate evidence.

`src/__tests__/ask-agent-offline.test.ts` includes the protected same-UID Unix
socket consultation test with actual pinned Pi and a deterministic provider.
`src/__tests__/worker-consultation.test.ts` uses an in-memory wire to exercise
the consultation protocol and Pi lifecycle, including hard worker loss. Its
synthetic subscription exists only in the primary worker profile. The test
runs consultations, chat, and cron through pinned Pi and checks the profile's
settings, the consultation's retry controls, and the absence of a consultation
transcript or second credential store.
Those fixtures establish neither cross-UID filesystem denial nor live
provider or tool parity.

Remaining migration work includes other first-party wrappers and transport
capabilities, collaboration, worker-side file delivery,
per-user auth provisioning, additional isolated agents, and representative
production canaries with history preservation.
