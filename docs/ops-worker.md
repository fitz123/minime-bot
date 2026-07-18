# Ops-worker foundation

The ops worker is an opt-in, inactive-by-default core. Installing or starting
`minime-bot` does not start it. The foundation provides durable task snapshots,
one single-instance supervisor, ordinary Pi session continuation, deterministic
done checks, a strict local CLI, and read-only loopback health/status. Each
attempt receives the agent workspace's assembled context bundle plus the fixed
ops-worker policy; Pi's flat context loading is disabled only after assembly
succeeds, avoiding both missing rules and duplicate context. The task prompt is
written to Pi over stdin rather than exposed in the child process arguments.

The installed binary registers no task templates, authorization profiles,
or done checks. Submission and start define the adapter-facing contract but
cannot execute production work until trusted package code registers all three.
Each trusted authorization profile fixes both its scopes and Pi tool allowlist;
task input cannot select commands, executables, URLs, models, tools, or scopes.

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
canonical submission fails closed. The correlation key has a different role:
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

Schema v2 is the only write format. Exact schema v1 snapshots remain readable
through a deterministic pure migration. Reading, listing, or inspecting v1 does
not rewrite it; its first successful store mutation writes one canonical v2
snapshot. Unknown fields and future schema versions are rejected.

The v1 migration derives a task-unique legacy delivery key and non-shareable
legacy host resource. It also derives custody conservatively: active, checking,
resumable, and ambiguously orphaned work remains held, while queued work is
unclaimed and genuinely process-free terminal or blocked work is released.

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
with different content fails closed. Checkpoint snapshot updates count as
attempt liveness and are allowed while the supervisor owns the task.

`--lifecycle` accepts only `canonicalTask`, `repository`, `base`, `head`,
`branch`, `pullRequest`, `merge`, `tag`, `release`, `deploy`, `verifier`,
`report`, and `tailAudit`. For example:

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

An ambiguous process-group identity is a global safety fence: its task retains
any proven identity evidence, no new Pi attempt is launched, and ordinary retry
or cancellation is rejected until restart reconciliation proves the group gone.

## Loopback status

The supervisor binds to `127.0.0.1:9465` by default. Only `127.0.0.1` and `::1`
are accepted bind addresses. The surface is read-only:

- `GET /healthz` returns process health.
- `GET /status` returns bounded task-state counts and the number of active
  process groups. It exposes at most one custody owner as task id and state and
  never includes objectives, lifecycle evidence, checkpoints, or receipts.

There is no HTTP task intake, retry, cancellation, command, or arbitrary proxy
route in this foundation. CLI submission and lifecycle evidence recording write
through the strict local task store.

## Deferred work

Alertmanager intake, authenticated HTTP intake, Telegram reporting, report
transport retries, production telemetry, production task templates and done
checks, the full fault lab, deployment configuration, launch activation,
release workflows, and production drills are later phases. Existing recovery
components remain in place during coexistence.
