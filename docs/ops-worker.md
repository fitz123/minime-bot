# Ops-worker policy and foundation

The ops worker is an opt-in, inactive-by-default core. Installing or starting
`minime-bot` does not start it. The foundation provides durable task snapshots,
one single-instance supervisor, ordinary Pi session continuation, deterministic
composite verification, continuous authorization checks, reset-aware quota
waits, a strict local CLI, and read-only loopback health/status. Each attempt
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
minime-bot worker start --state-dir "$STATE_DIR" --agent-workspace "$AGENT_WORKSPACE"
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
Without `--once`, it runs until SIGINT or SIGTERM. The package-owned Pi
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
output. For `receipt-claim`, JSON output is `{ "claimed": <boolean>, "task":
<snapshot> }`; only `claimed: true` authorizes the caller to attempt the external
mutation. A replay returns `claimed: false`.

Submission creates an authoritative `tasks/<id>.json` snapshot before success
is reported. The delivery key identifies one adapter delivery permanently. An
identical replay returns the existing task, including after completion, without
adding a snapshot or audit transition. Reusing that key with a different
canonical submission fails closed. Each v4 snapshot retains a store-owned
immutable submission fingerprint, so later runtime evidence updates or bounded
evidence eviction cannot make a conflicting delivery look identical. The
correlation key has a different role:
it prevents duplicate active work for one episode and may be reused after the
earlier task becomes terminal.

Resource keys are immutable normalized scheduling identities. Host resources
use `host:<name>`; repository resources use a lowercase non-host namespace plus
an owner/name identity, for example `github:example/project`. A resource is not
a lane, executable, URL, or independently acquired lock.

`retry` and `cancel` acquire the supervisor's single-instance
guard and therefore fail safely if the long-running supervisor is active;
live control transport is not part of this foundation. A running task cannot
be cancelled without its owning supervisor first proving and stopping the
process group.

## Schema and migration

Schema v4 is the only write format. Exact schema v1, v2, and v3 snapshots remain
readable through deterministic pure migrations. Reading, listing, or inspecting
an older snapshot does not rewrite it; its first successful store mutation
writes one canonical v4 snapshot. Unknown fields, fields from a later schema,
and future schema versions are rejected.

V3 added one fixed authorization-verification record: validator identity and
version, checked authorization snapshot hash, checked time, closed status, and
bounded redacted evidence hash/summary. V4 adds the immutable composite verifier
identity/version/contract hash to the lifecycle manifest and fresh aggregate
component evidence to the task. Older snapshots migrate with these records
unset, never with an implied PASS. A migrated legacy `DONE` snapshot carries
fixed source-schema provenance so its report evidence can be updated in v4
without fabricating aggregate PASS evidence; current-schema completion still
requires a fresh aggregate PASS.

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
tool names as the primary session. Generated private wrappers give even
handler-only extensions a deterministic one-way identity. The ops policy is the
sole intentional additive context delta. Before provider work, a package-owned
extension compares the effective system prompt with its session baseline and
reports structured context-file, extension, skill, and tool metadata through a
parent/child acknowledgement handshake. The parent recomputes every prepared
digest before acknowledging. Any missing, internally inconsistent, or
mismatched evidence fails closed; persisted evidence contains versioned results
and hashes only.

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
tool call. Success resumes;
another quota response refreshes the reset; invalid telemetry and probe
infrastructure errors remain distinct bounded outcomes. No LLM is parked and no
blind polling or guessed reset deadline is used.

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
aggregate subject hash includes the current task, checkpoint, and authorization
state, so stale or partial PASS evidence is discarded. Only a fresh aggregate
PASS recorded atomically with the terminal transition can produce `DONE` and
release custody. Repeated diagnostic failures remain retryable with custody
held; only product evidence can exhaust remediation and block the task. This
phase intentionally registers no production components.

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
allowed while the supervisor owns the task.

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
are accepted bind addresses. The surface is read-only:

- `GET /healthz` returns process health.
- `GET /status` returns bounded task-state counts and the number of active
  process groups. It exposes at most one custody owner as task id and state. Its
  `policy` section contains only authorization/composite contract hashes and
  counts, current typed quota metadata/evidence hash, and primary resource
  digests for parity. It never includes objectives, canonical task bodies,
  context contents, personas, resource paths, lifecycle evidence, checkpoints,
  receipts, quota summaries, or credentials.

There is no HTTP task intake, retry, cancellation, command, or arbitrary proxy
route in this foundation. CLI submission and lifecycle evidence recording write
through the strict local task store.

## Deferred work

Alertmanager intake, authenticated HTTP intake, Telegram reporting, report
transport retries, production task templates and composite components, the full
fault lab, deployment configuration, launch activation, release workflows, and
production drills are later phases. Install, build, pack, help, and workspace
validation do not start a worker process or listener. Existing recovery
components remain in place during coexistence.
