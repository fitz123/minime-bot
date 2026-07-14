# Same-host recovery supervisor

The recovery supervisor is an opt-in, same-host safety net around the existing
native monitoring path. Direct native Telegram delivery remains the default.
Do not switch a receiver to recovery-only delivery until the observe and plan
shadow gates have passed.

## Limits and security model

Detection, authenticated intake, the SQLite ledger, health checks, durable
spooling, and emergency Telegram fallback use Python's standard library and do
not depend on Node, the bot daemon, or Pi. This improves failure independence,
but it is not host-independent: power, disk, network, account, and whole-host
failures can affect both the service and its supervisor.

The HTTP listener accepts only loopback addresses and bearer authentication.
It normalizes allowlisted fields and commits before acknowledging. Delivery is
at-least-once, keyed by stable transition ID; it is not exactly-once. The fixed
SQLite schema uses WAL, full synchronous writes, foreign keys, a bounded busy
timeout, and startup integrity checks. Corruption or a schema mismatch fails
closed and is never reset to healthy automatically.

Monitoring payloads and planner text are untrusted. The planner receives only
bounded normalized evidence and can return only one strict recovery plan. It
cannot use shell, files, web, delegation, or Knowledge writes. The executor
accepts configured IDs only, uses an absolute executable plus static argv/env,
never invokes a shell, and fences every action. Public defaults contain no
mutating runbooks. Secrets belong in files resolved by the native monitoring
secret contract; never put them in config, argv, logs, or planner evidence.

The control workspace, agent workspace, installed package, and source checkout
are separate roots. Set only `MINIME_CONTROL_WORKSPACE_ROOT` and
`MINIME_AGENT_WORKSPACE_ROOT`. The examples use placeholders so they work from
an installed package without relying on a checkout.

## Configuration and modes

Copy `examples/recovery/recovery.json` to the control workspace. All runtime
paths in it are control-workspace-relative and cannot contain `..`. Validate it:

```sh
minime-bot recovery config validate --workspace /path/to/control-workspace
```

The JSON object is closed and requires every field shown in the example:
`version` is `1`; `mode` is `observe`, `plan`, or `enabled`; `database`,
`spoolDirectory`, and `authTokenFile` are control-workspace-relative; `host` is
loopback; and `port` is 0-65535. `sourceIds` contains unique values from
`alertmanager` and `runtime_doctor`. Each correlation rule has unique
`component`/`failureClass` identity, an `incidentKey`, and impact 0-3. Each
registry is limited to 128 unique IDs:

```json
{
  "id": "local-health",
  "actionClass": "diagnostic",
  "executable": "/usr/bin/true",
  "argv": [],
  "env": {"LANG": "C"},
  "timeoutMs": 1000
}
```

Probe entries omit `actionClass`. IDs use letters, digits, `.`, `_`, `:`, and
`-`; executables are absolute and cannot be `sudo`; argv has at most 64 static
items and cannot contain credential-bearing flags; env has at most 32 uppercase
keys and rejects authentication, credential, key, password, secret, and token
names. Command timeouts are 100-300000 ms. Allowed runbook classes are
`diagnostic`, `local_repair`, `cache_cleanup`, and the restricted handoff
classes listed below. The public example intentionally configures no commands.

The supervisor starts the package-owned Node worker with
`MINIME_RECOVERY_NODE_EXECUTABLE` when set, otherwise an absolute `node` found
on its bounded `PATH`. The dedicated fixer context comes only from
`MINIME_AGENT_WORKSPACE_ROOT`; the control workspace comes only from
`MINIME_CONTROL_WORKSPACE_ROOT`. Plan/enabled startup also requires the native
Telegram destination and secret-reference environment used by
`monitoring_native`; the status command reports only whether that delivery is
configured, never its destination.

The modes are intentionally one-way safety gates:

- `observe`: intake, correlation, audit, health, digest, fallback, and
  verification stay active; no Pi invocation is claimed and no action runs.
- `plan`: the bounded planner may produce a frozen plan, but the executor runs
  neither runbooks nor probes.
- `enabled`: configured diagnostic/local-repair/cache-cleanup runbooks may run
  after all fences pass. Restricted classes always stop for approval.

Changing the JSON mode requires config validation and a supervisor restart.
Dispatch can also be disabled immediately without stopping intake:

```sh
minime-bot recovery dispatch disable --actor operator --reason maintenance --ttl 3600
```

Confirmation count is bounded to 1-5, cooldown to 0-86400 seconds, retry budget
to 0-10, list output to 100 rows, and every expiring control to 31 days. Mutating
commands require a bounded actor and reason and create an immutable policy
revision plus audit record. The CLI exposes named operations only; there is no
SQL, shell, or arbitrary argv mode.

Useful commands include `recovery status`, `incidents`, `invocations`,
`controls`, `silence`, `retry`, `policy history`, `policy rollback`,
`approve`, `reject`, `digest preview`, and `process --once`. Run
`minime-bot --help` for exact forms.

## Incident lifecycle and approvals

Allowlisted component/failure-class pairs correlate into an incident. Material
evidence or policy changes advance its generation. A single global lease and
generation/evidence/policy/lease fence permit one active planner invocation.
Unchanged observe, not-actionable, malformed, pending-approval, and exhausted
outcomes do not spin. Explicit retry is bounded and audited.

Recovery is declared only after every correlated firing episode resolves,
configured probes are healthy, source and supervisor heartbeats are fresh, and
the hold-down elapses. Missing or stale monitoring never means recovered.

The following action classes always require a handoff, regardless of planner
output: restart, deploy, sudo, package upgrade, secret migration, and public
write. Approval/rejection is tied to one pending invocation and recorded in the
audit ledger. It terminates that frozen handoff; it never executes a restricted
class or silently asks the planner for a different plan. Material evidence or
an explicit bounded retry is required for another invocation. Confirmed impact,
approval requirements, unsafe/failed recovery,
exhausted retries, planner/supervisor unavailability, and spool failure use the
immediate native escalation path.

Adaptation may change only confirmation count and cooldown within hard bounds.
It requires at least three mechanically classified outcomes and deterministic
replay, runs no more than daily, cannot delay critical escalation, and moves
back toward baseline after impact or missed recovery. It never changes dispatch,
alerts, escalation classes, allowlists, fallback, or runbooks.

## Shadow acceptance drills

1. Install the package, create the auth-token file with restrictive permissions,
   validate config, and start the supervisor in `observe`.
2. Configure Alertmanager's shadow receiver with `continue: true` and run the
   runtime doctor with `MINIME_DOCTOR_SINK=tee`, as shown in
   `examples/recovery/ai.minime.runtime-doctor-shadow.plist`. Direct Telegram
   remains the owner of user notifications.
3. Send duplicate and out-of-order firing/resolved transitions. Verify one
   durable event per transition ID, correct correlation, no planner invocation,
   and no executor process.
4. Restart the supervisor with an unacknowledged request, a held fixer lease,
   and queued notifications. Verify spool drain, lease fencing, crash
   reconciliation, and notification retry. Stop Node and Pi independently;
   intake, health, digest, and fallback must continue.
5. Exercise a disk/ledger failure and notification outage. Verify retryable
   intake or durable spool, compact fallback without raw payload, and later
   delivery. Never replace or delete a corrupt ledger during the drill.
6. Review source-heartbeat freshness, hold-down behavior, silence/control expiry,
   policy rollback, adaptation replay/reversion, and daily digest counts.
7. Change to `plan`, restart, and repeat. Confirm a repeated non-actionable
   incident launches only within the reevaluation bound and that every planned
   runbook has zero executor side effects.
8. Only after review and separate deployment approval, configure approved static
   runbooks and select `enabled`. Restart/deploy remains a separate approval
   class and is never silently enabled.

Self-monitor the authenticated `/healthz` endpoint, process liveness, both source
heartbeats, ledger/spool disk space, pending outbox age, and emergency delivery.

## Upgrade, rollback, and return to direct Telegram

Before an upgrade, disable dispatch with a TTL, keep shadow intake running, take
a filesystem-consistent backup of the stopped ledger and spool, install the new
package, validate config, and start in `observe`. The schema has no migration
ladder: a version mismatch fails closed, so restore the matching package and
ledger together. Use policy history and audited rollback only for control-policy
changes; it does not rewrite event history.

To abandon recovery, first disable dispatch, restore the runtime doctor to its
default `telegram` sink, remove the Alertmanager shadow/recovery route while
retaining the existing native Telegram receiver, confirm direct firing and
resolution delivery, then unload the supervisor. Preserve the ledger and audit
for review. Intake must not be treated as the notification owner until all
shadow acceptance drills have passed.
