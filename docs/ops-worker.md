# Ops-worker policy and foundation

The ops worker is an opt-in, inactive-by-default core. Installing or starting
`minime-bot` does not start it. The foundation provides durable task snapshots,
one single-instance supervisor, ordinary Pi session continuation, deterministic
composite verification, continuous authorization checks, reset-aware quota
waits, a strict local CLI, optional dedicated Telegram control, authenticated
loopback Alertmanager intake, and bounded health/status. Each attempt
assembles the canonical primary agent's exact accepted context in a trusted
source workspace, adds only the fixed ops-worker policy, and executes in a
separate worker workspace. Pi's flat context loading is disabled only after
assembly succeeds, avoiding both missing rules and duplicate context. The task
prompt is written to Pi over stdin rather than exposed in child arguments.

The installed binary registers no task templates, authorization profiles,
authorization verifiers, composite verifier components, quota reader, primary
Pi resource contract, listener, or production configuration. Submission and
start define the adapter-facing contract but cannot execute production work
until trusted package code supplies the complete dependency set. Authorization
profiles fix declarative mutation scopes; they do not narrow Pi's primary tool
surface. Task input cannot select commands, executables, URLs, models, tools,
resource paths, verifier components, actors, or scopes.

## Commands

All commands require an explicit state directory. Starting the supervisor also
requires an explicit agent workspace:

```text
minime-bot worker start --state-dir "$STATE_DIR" --agent-workspace "$AGENT_WORKSPACE" \
  [--control-config /path/to/ops-control.yaml]
minime-bot worker status --state-dir "$STATE_DIR"
minime-bot worker list --state-dir "$STATE_DIR"
minime-bot worker inspect --state-dir "$STATE_DIR" --id <task-id>
minime-bot worker submit --state-dir "$STATE_DIR" \
  --template <registered-template> \
  --authorization <registered-profile> \
  --done-check <registered-check> \
  [--done-check-params '<registered-parameters-json>'] \
  --correlation-key <source-correlation-key> \
  --delivery-key <adapter-delivery-key> \
  --resource-key <normalized-resource-key> \
  --objective <bounded-objective>
minime-bot worker checkpoint --state-dir "$STATE_DIR" --id <task-id> \
  --checkpoint-id <id> --summary <bounded-summary> --payload '<json>' \
  [--artifact <relative-artifact-path>] [--lifecycle '<identity-json>']
minime-bot worker receipt-query --state-dir "$STATE_DIR" --id <task-id> \
  --boundary <merge|tag-release|deploy|canonical-task|report> \
  --operation-id <id> --intent '<json>' \
  --query-observed-at <utc-timestamp> --query-result '<json>'
minime-bot worker receipt-claim --state-dir "$STATE_DIR" --id <task-id> \
  --boundary <fixed-boundary> --operation-id <id> --intent '<json>'
minime-bot worker receipt-finish --state-dir "$STATE_DIR" --id <task-id> \
  --boundary <fixed-boundary> --operation-id <id> --intent '<json>' \
  --result <APPLIED|ALREADY_APPLIED|NOT_NEEDED> --evidence '<json>' \
  [--lifecycle '<identity-json>']
minime-bot worker retry --state-dir "$STATE_DIR" --id <task-id>
minime-bot worker cancel --state-dir "$STATE_DIR" --id <task-id> --reason <reason>
```

`worker start --once` performs at most one eligible scheduler action and exits.
When `--control-config` is also present, it then performs exactly one bounded
Telegram control tick, including at most one terminal-report attempt, before
exiting. Without `--once`, it runs until SIGINT or SIGTERM. The package-owned Pi
invocation, model/tool flags, authorization scope, remediation budget, task
priority, and source kind are not task-supplied CLI options.

A trusted embedding of `worker start` must supply the canonical primary context
agent, explicit primary extension/skill/tool contract, authorization verifiers
for every registered source kind, a matching composite verifier registry, and a
quota admission gate. Missing dependencies fail before the supervisor can claim
work.

`worker start` also accepts `--host` (only `127.0.0.1` or `::1`) and `--port`
(an integer from 0 through 65535). Omitted done-check parameters default to an
empty object. Every command except `start` accepts `--json` for machine-readable
output. `worker status --json` returns the bounded task summary plus the same
`policy` snapshot described for `GET /status` below; non-JSON status remains the
task/custody summary. For `receipt-claim`, JSON output is `{ "claimed":
<boolean>, "task": <snapshot> }`; only `claimed: true` authorizes the caller to
attempt the external mutation. A replay returns `claimed: false`.

Submission creates an authoritative `tasks/<id>.json` snapshot before success
is reported. The delivery key identifies one adapter delivery permanently. An
identical replay returns the existing task, including after completion, without
adding a snapshot or audit transition. Reusing that key with a different
canonical submission fails closed, except that the Alertmanager adapter may
coalesce an evolving notification into the task that currently owns the same
active correlation. Each accepted coalesced delivery key and submission
fingerprint is retained as bounded protected trusted receipt evidence, so its exact
replay still returns that task after termination; an unrecorded conflicting
payload fails closed. Each v5 snapshot retains a store-owned
immutable submission fingerprint, so later runtime evidence updates or bounded
evidence eviction cannot make a conflicting delivery look identical. The
correlation key has a different role:
it prevents duplicate active work for one episode and may be reused after the
earlier task becomes terminal.

Resource keys are immutable normalized scheduling identities. Host resources
use `host:<name>`; repository resources use a lowercase non-host namespace plus
an owner/name identity, for example `github:example/project`. A resource is not
a lane, executable, URL, or independently acquired lock.

CLI `retry` and `cancel` acquire the supervisor's single-instance guard and
therefore fail safely if the long-running supervisor is active. An explicitly
started worker may instead expose the dedicated Telegram control commands
described below. A running task cannot be cancelled without its owning
supervisor first proving and stopping the process group.

## Dedicated Telegram control

`worker start --control-config <path>` is the only entrypoint that loads the
separate ops control YAML and starts its long poller. Omitting the option keeps
the pre-control startup behavior. No install, build, pack, help, validation, or
other worker command reads this file or starts a listener. The control client
uses an independently configured second BotFather token; it never reads the
primary `telegramToken*` settings, imports grammY, or shares the primary bot's
`getUpdates` stream.

The config is strict, rejects unknown keys, requires a non-empty operator
allowlist, and accepts exactly one secret source for each token. Values below
are placeholders:

```yaml
telegram:
  tokenEnv: MINIME_OPS_TELEGRAM_TOKEN
  controlChatId: "100000000"
  operatorIds:
    - "100000000"

intake:
  host: 127.0.0.1
  port: 9465
  bearerTokenEnv: MINIME_OPS_INTAKE_TOKEN
  sourceIdentity: example-alertmanager

poll:
  longPollSeconds: 30
  requestTimeoutMs: 35000
  retryMinMs: 250
  retryMaxMs: 5000
  maxResponseBytes: 262144

reply:
  maxBytes: 3500
```

`tokenEnv` may be replaced by the pair `sopsFile` and `tokenSopsKey`;
`bearerTokenEnv` may likewise be replaced by `sopsFile` and
`bearerTokenSopsKey`. Relative SOPS paths resolve from the control config's
directory. The config itself must be a non-symlink regular file of at most 64
KiB. The `poll` and `reply` sections are optional and use the defaults shown
above when omitted. Secret values never belong in the YAML. Intake is
optional, but when present its host must be `127.0.0.1` or `::1` and its port
is also the status server port.

The bounded command set is `/status`, `/tasks`, `/task <id>`, `/answer <id>
<text>`, `/correct <id> <text>`, `/pause <id>`, `/resume <id>`, `/cancel <id>
<reason>`, and `/retry <id>`. Telegram text can select and steer only an
existing task. It cannot create tasks or select configuration, commands,
destinations, URLs, models, tools, templates, profiles, or verifier components.

Every update is fingerprinted in the versioned ledger at
`<state-dir>/control/telegram.json`. An allowlisted command's task or steering
effect is persisted first, then the update fingerprint and monotonic offset are
persisted, and only then is a reply sent. A crash between the task effect and
ledger write is safe because the update-derived steering id makes redelivery an
idempotent replay. Malformed and non-allowlisted updates receive no task effect
or reply, but their fingerprints are retained before the offset advances.
The ledger also records the local acknowledgement time and an update-id epoch.
After a full week without an update it polls once without the stale offset,
because Telegram may randomize the next update id, and begins a new epoch when
that update arrives. Fingerprint-qualified steering ids keep this
resynchronization replay-safe even if a numeric update id is reused.

Corrections and answers are bounded trusted operator evidence and are consumed
atomically when the next attempt resolves its launch. They are clearly marked
as data in the prompt and are never written into a running child's stdin or
session. Pause prevents the next scheduler action while preserving custody and
queue position; an in-flight attempt reaches its next safe boundary without a
signal. Cancel is the explicit interrupt path: it stops only a proven owned
process group. Ambiguous ownership retains the task, interrupt, and global
fence for startup reconciliation.

Each control-loop tick sends at most one pending terminal report. Report sends
use the fixed receipt boundary: fresh authorization is proved and the receipt
is claimed before the Telegram send is attempted. A crash after send but before receipt finish
requires a strictly newer external-state query and permits at-least-once
redelivery; it never invents a false unsent or sent state.

## Schema and migration

Schema v5 is the only write format. Exact schema v1, v2, v3, and v4 snapshots
remain readable through deterministic pure migrations. Reading, listing, or
inspecting an older snapshot does not rewrite it; its first successful store
mutation writes one canonical v5 snapshot. Unknown fields, v5-only fields on an
older version, and future schema versions are rejected.

V3 added one fixed authorization-verification record: validator identity and
version, checked authorization snapshot hash, checked time, closed status, and
bounded redacted evidence hash/summary. V4 adds the immutable composite verifier
identity/version/contract hash to the lifecycle manifest and fresh aggregate
component evidence to the task. Older snapshots migrate with these records
unset, never with an implied PASS. A migrated legacy `DONE` snapshot carries
fixed source-schema provenance so its report evidence can be updated in the
current schema without fabricating aggregate PASS evidence; current-schema completion still
requires a fresh aggregate PASS. A newly written `QUOTA_PROBE_PASS` outcome may
also carry its fixed typed proof subrecord; proofless outcomes remain readable
for compatibility but never authorize a launch.

V5 adds the bounded append-only steering list and fixed control record containing
pause and pending interrupt state. Older snapshots migrate with no steering,
`paused: false`, and no interrupt. Steering ids are replay-safe, conflicting id
reuse and overflow fail closed, and pending steering contributes to the
verification subject hash so it invalidates stale aggregate evidence.

The v1 migration derives a task-unique legacy delivery key and non-shareable
legacy host resource. It also derives custody conservatively: active, checking,
resumable, and ambiguously orphaned work remains held, while queued work is
unclaimed and genuinely process-free terminal or blocked work is released.

## Continuous authorization

Authorization is revalidated atomically before initial custody, before every
resumed Pi attempt, and before a fixed external mutation receipt can be claimed.
The registered verifier, repository/principal policy, and canonical-task
resolver come only from trusted package code. Task content and remote comments
are evidence, not authority.

The closed results are `PASS`, `DRIFT`, `QUERY_ERROR`, and `INVALID_CLAIM`.
`DRIFT` or `INVALID_CLAIM` blocks only after process absence is proven and
releases custody with durable evidence. `QUERY_ERROR` retains existing custody,
schedules a bounded recheck, and does not spend remediation budget. A persisted
old PASS cannot authorize a changed task, resumed attempt, or later mutation
claim. A denial observed while attempting post-completion reporting fences that
mutation and appends audit evidence; it never rewrites immutable `DONE` or
`CANCELLED` task state.

Mutation receipts also enforce a package-owned scope map: `merge` requires
`pull-request`, `tag-release` requires `release`, `deploy` requires `deploy`, and
`canonical-task` requires `issue-lifecycle`. Reporting is bounded lifecycle
bookkeeping available to every otherwise-authorized task.

## Primary context and capability parity

The execution workspace must be a distinct, non-overlapping canonical directory
from the primary context workspace. Context assembly fails closed on unsafe
paths, symlinks, or missing required material and never falls back to a smaller
bundle. Its redacted manifest hashes the accepted source identities, exact
assembled bundle bytes, and persona bytes without persisting their contents or
host paths.

Worker Pi launches keep ambient discovery disabled and explicitly load the same
package-owned/configured extensions, effective skills, and complete selected
tool names as the primary session. Generated private wrappers load verified
read-only snapshots of each extension closure, including the parity gate, and
give even handler-only extensions a deterministic one-way identity. The worker
also replaces every selected skill with a bounded, read-only snapshot of its
complete directory package, preserving relative scripts, references, assets,
and executable bits. The ops policy is the sole intentional additive context
delta. Before provider work, a package-owned extension compares the effective
system prompt with its session baseline and reports structured context-file,
extension, skill, and tool metadata through a
parent/child acknowledgement handshake. The parent recomputes every prepared
digest before acknowledging. Any missing, internally inconsistent, or
mismatched evidence fails closed; persisted evidence contains versioned results
and hashes only.

Extension identities include the complete statically resolved local module
closure using the same fixed Jiti resolver contract as execution, plus the
package-owned subagent manifest's bundled agent and prompt resources. Ambient
Jiti extension ordering and cache configuration cannot change that contract. Dynamic
imports, runtime `require`, `createRequire`, VM loaders, and runtime code generation
fail closed because their eventual executable dependency bytes cannot be fenced
before launch. Extension imports outside the local closure are limited to the
package-owned primary dependency allowlist and resolve through fixed package
aliases rather than extension-local replacements; global/process aliases and
reflective loader surfaces are rejected. Worker children additionally run with
V8 string code generation disabled, including quota smoke probes.

Trusted configured extras must provide an explicit, parallel manifest of every
non-module runtime file they read relative to their entrypoint; an
empty manifest is an explicit no-assets claim. Those bounded resources,
entrypoint selection, bytes, and executable bits are included in the identity
and private copy. The parent re-reads the generated wrappers and exact private
snapshot manifests before acknowledging parity.

## Quota admission and waits

Initial admission evaluates every active window in the existing server-reported
Codex quota snapshot. Each window must have at least 50 percent remaining and
usage no more than the window percentage elapsed at `sampledAt` plus 10 points. Missing, stale,
contradictory, durationless, resetless, unreadable, or malformed telemetry is a
typed not-admitted result. Admission runs before an unheld task is claimed.

After custody, quota never displaces the task or increments its terminal
infrastructure-failure count. A real quota response selects the reset named by
the server's active-limit header (`primary` for five-hour, `secondary` for
weekly); an unnamed multi-window response is invalid rather than guessed. It
records that authoritative reset timestamp and creates a durable host-native
wait. At fresh headroom or the reset deadline, one bounded smoke probe uses the
exact worker model, thinking level, context, extensions, skills, and tools. The
probe runs in a detached owned process group and its parity gate blocks every
tool call. Success records a short-lived, single-use proof bound to the exact
model, thinking level, primary context, parity contract, and resource digest.
The real launch validates and consumes that proof atomically with its durable
pre-spawn fence; an expired or mismatched proof returns to the probe flow without
spawning. A successful deadline probe for an unclaimed task does not bypass
all-window admission or reuse the elapsed reset; if admission remains closed,
the worker schedules a bounded host-native telemetry recheck. Another quota
response refreshes the reset; invalid telemetry and
probe infrastructure errors remain distinct bounded outcomes. No LLM is parked
and no blind polling or guessed reset deadline is used.

A normal attempt likewise requires valid attempt-scoped response telemetry: a
captured 429 enters the reset-aware quota path, another non-2xx response is an
infrastructure failure, and only a captured 2xx response can support a clean-exit
completion claim.

## Typed composite verification

Trusted package code registers an immutable composite identity, version,
contract hash, required components, convergence kind, and timeout. Task data may
only select a registered check name and its bounded canonical parameters; it
cannot select components, commands, URLs, or executable selectors.

Component and aggregate outcomes are `PASS`, `NOT_READY`, `PRODUCT_FAILURE`,
`DEFER`, `VERIFIER_INVALID`, `QUERY_ERROR`, and `TIMEOUT`. Every required
component must PASS for aggregate PASS. `DEFER` is reserved for passive external
convergence. Product work resumes remediation; verifier invalidity, query
failure, and timeout retry verification without consuming remediation. The
aggregate subject hash includes the current task, checkpoint, authorization,
and pending steering state, so stale or partial PASS evidence is discarded.
Only a fresh aggregate PASS recorded atomically with the terminal transition
can produce `DONE` and release custody. Repeated diagnostic failures remain
retryable with custody held; only product evidence can exhaust remediation and
block the task. This package exports the `ops.minime-availability` version 1
composite and its task contract factory for a trusted worker embedding; no
production embedding is constructed or activated by the installed binary.

## Availability contract

`createOpsTaskContracts` registers template `ops.availability` for authenticated
Alertmanager and local CLI submissions, authorization profile
`ops.host-availability`, and invariant `minime-bot-host`. The invariant fixes
the host resource, objective, scopes, and composite parameters in package code.
Alert payloads and task text cannot select probes or policy.
The factory provides the closed Alertmanager authorization verifier only. A
trusted embedding that enables `operator-cli` submission must separately
register its own `operator-cli` verifier; startup otherwise fails closed.

The `ops.minime-availability` composite requires three fresh components:

- `monitoring-freshness` is PRODUCT evidence that the telemetry pipeline has a
  recent sample. Silence is `NOT_READY`, never health.
- `alert-state` is PASSIVE evidence from a fresh correlated Alertmanager query.
  A still-firing group returns `DEFER` with a bounded recheck.
- `service-stability` is PRODUCT evidence that direct availability is healthy
  and has stayed healthy for the fixed five-minute window. A shorter streak is
  `NOT_READY`; a fresh unhealthy observation is `PRODUCT_FAILURE`.

Aggregate PASS requires all three. Resolved-alert disappearance, stale data,
or an agent completion claim is insufficient. Reader exceptions remain
`QUERY_ERROR`; malformed reader output is `VERIFIER_INVALID`; timeouts and
passive/product convergence retain their existing distinct outcomes. The
exported Alertmanager and Prometheus HTTP readers accept only explicit loopback
base URLs and injected fetch implementations. They perform one bounded query,
without retries or import-time construction. One composite evaluation makes one
Prometheus raw range-vector query for freshness, one Alertmanager active-alert
query, and one Prometheus instant query for direct service state. When every
direct series is healthy, it makes one additional raw range-vector query
covering the five-minute window plus one fixed scrape step. The
Alertmanager query includes active suppressed alerts and filters the response by
the exact group labels stored with the task's correlation evidence; unrelated
active groups cannot hold the task open. For a trusted `operator-cli`
availability task, the same reader uses the package-owned
`alertname="MinimeBotMetricsDown"` invariant because there is no intake group
descriptor.

The Prometheus reader's trusted cadence is the explicit one-minute scrape
interval in `examples/monitoring/prometheus.yml`. Stability accepts up to 15
seconds of scrape jitter between samples and resets the healthy streak when a
larger gap or an unhealthy sample appears. Embeddings that use this reader must
preserve that cadence.

## Custody, checkpoints, and receipts

At most one task holds whole-cycle custody. A claimed task keeps custody through
running, checking, quota or network waits, resumable state, and safe restart
reconciliation. Only fresh deterministic `PASS`, cancellation, or a genuinely
process-free blocked outcome releases it. Priority orders an initial claim but
does not hand work to another task during the claimed cycle.

`worker checkpoint` atomically records one latest bounded checkpoint and
optional fixed lifecycle identities. The payload is canonicalized and stored
only as a SHA-256 hash; the helper never runs a command or contacts an external
system. Identical checkpoint replay is a no-op, while reuse of the checkpoint id
with different content fails closed, including after a newer checkpoint has
become current. Checkpoint snapshot updates count as attempt liveness and are
allowed while the supervisor owns the task, except during the atomic pre-spawn
fence. While an `unverifiedRun` is present, lifecycle identity, checkpoint, and
receipt evidence writes fail closed and callers must retry after launch
resolution.

`--lifecycle` accepts only `canonicalTask`, `repository`, `base`, `head`,
`branch`, `pullRequest`, `merge`, `tag`, `release`, `deploy`, `report`, and
`tailAudit`. Verifier identity, version, and contract hash are reserved for the
package-owned composite verifier and cannot be supplied through lifecycle or
checkpoint input. For example:

```json
{"repository":"github:example/project","pullRequest":"pr:58","merge":"commit:abc123"}
```

These slots hold bounded identity evidence only. Each non-null identity is
write-once; an identical replay is a no-op and a conflicting update fails
closed.

Receipts are evidence records for only `merge`, `tag-release`, `deploy`,
`canonical-task`, and `report`. `receipt-query` durably records a real external
state observation. `receipt-claim` records that the matching mutation is about
to be attempted; it does not perform the mutation. `receipt-finish` records the
matching outcome and evidence hash. After a crash with a claimed but unfinished
receipt, a strictly newer query is required before reconciliation. Operation
ids, intents, outcomes, and fixed lifecycle identities are replay-safe and fail
closed on conflicting reuse. The `--payload`, `--intent`, `--query-result`, and
`--evidence` values are bounded canonical JSON and are retained only as hashes;
callers must retain any raw external observation they will need later. Operator
retry also fails closed while a claimed report receipt remains unfinished.
Snapshots keep non-evicting replay fingerprints for up to 128 displaced
checkpoints and 32 displaced completed operations per receipt boundary. A new
identity fails closed when its ledger is full; old identities are never
forgotten or made claimable again.

An ambiguous process-group identity is a global safety fence: its task retains
any proven identity evidence, no new Pi attempt is launched, and ordinary retry
or cancellation is rejected until restart reconciliation proves the group gone.

## Loopback status

The supervisor binds to `127.0.0.1:9465` by default. Only `127.0.0.1` and `::1`
are accepted bind addresses. The surface is read-only unless an explicit
`worker start --control-config` file registers the fixed Alertmanager intake
route:

- `GET /healthz` returns process health.
- `GET /status` returns bounded task-state counts and the number of active
  process groups. It exposes at most one custody owner as task id and state. Its
  `policy` section contains only authorization/composite contract hashes and
  counts, current typed quota metadata/evidence hash, and primary resource
  digests for parity. It never includes objectives, canonical task bodies,
  context contents, personas, resource paths, lifecycle evidence, checkpoints,
  receipts, quota summaries, or credentials.
- `POST /intake/alertmanager`, when explicitly configured, requires the
  configured bearer token and accepts only a bounded Alertmanager v4 webhook.
  It can submit only the package-owned availability task contract; alert text,
  labels, and annotations remain bounded untrusted evidence. The route is
  absent when intake is not configured.

There is no generic HTTP task intake, retry, cancellation, command, or arbitrary
proxy route. Both the fixed adapter and CLI submission write through the strict
local task store.

Ops intake is an additional Alertmanager receiver. It never replaces or
forwards through the independent native Alertmanager-to-Telegram delivery in
`scripts/alertmanager_webhook.py`; that path and `scripts/monitoring_native.py`
remain separate and unchanged.

The route accepts only a strictly bounded Alertmanager v4 JSON webhook and a
constant-time matched bearer token. The 256 KiB body limit mirrors the native
receiver. Firing episodes derive their delivery and correlation keys from the
trusted source identity, group key, and episode start. Identical delivery or an
already-active correlation replays the existing task. Coalescing first records
a durable delivery receipt in that task, preserving exact replay after the task
becomes terminal. Resolved-only groups do not create work. A firing group must
include non-empty group labels that fit the
bounded correlation descriptor; intake rejects a group it could not later query
exactly. Alert labels and annotations are stored only as bounded
untrusted evidence. Responses expose only `ok`, `taskId`, and `replayed`, while
authentication, media, syntax, method, and size failures use bounded typed JSON.

Clients send `POST /intake/alertmanager` with `Authorization: Bearer <token>`
and `Content-Type: application/json`; the body is the Alertmanager v4 webhook.
A newly accepted firing episode returns HTTP 200 with
`{"ok":true,"taskId":"<generated-id>","replayed":false}`. An identical or
active-correlation replay returns the existing id with `replayed:true`.
Resolved-only input returns `{"ok":true,"taskId":null,"replayed":false}`.

## Batched fake fault lab

The development fault lab lives at
`src/__tests__/fixtures/ops-worker-fault-lab.ts` and is asserted by
`src/__tests__/ops-worker-fault-lab.test.ts`. It runs the complete ADR-099
regression matrix in one batch. Every scenario receives an isolated temporary
state directory, deterministic clock, and fake Pi, Telegram, intake, or reader
dependencies as appropriate. It exercises public store, supervisor, runner,
control, intake, and done-check surfaces and returns one deterministic aggregate
with `labVersion`, ordered `scenarios`, `failures`, and `pass`.

```text
node --experimental-test-module-mocks --import tsx --test \
  src/__tests__/ops-worker-fault-lab.test.ts
```

The test requires exactly the registered scenario-name set, two identical
aggregate runs, all PASS outcomes, no external fetch passthrough, and no
non-loopback socket bind. The lab complements the focused unit suites; it does
not replace them.

## Inactivity and deferred work

Deployment configuration, launch activation, release workflows, production
rollout, outage drills, and legacy cleanup remain later phases. The package
still installs no control config, token, receiver, verifier dependencies, or
launch state. Install, build, pack, help, and workspace validation do not start
a worker process, poller, or listener. Only an explicit `worker start` with the
complete trusted embedding dependencies can run the worker, and only an
explicit `--control-config` can add the Telegram poller or intake route.
Existing recovery components and the independent native delivery path remain
in place during coexistence.
