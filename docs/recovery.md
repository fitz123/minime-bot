# Same-host recovery supervisor

The recovery supervisor is an opt-in, host-native safety foundation around the
existing monitoring path. Direct native Telegram delivery remains the default.
The shipped foundation observes, persists, correlates, verifies, exposes static
controls, and escalates. It does not start Pi or Node remediation, interpret
model output, or execute mutating commands.

## Limits and security model

Authenticated intake, the SQLite ledger, durable spooling, deterministic
verification, and emergency Telegram fallback use Python's standard library.
They do not depend on Node, Pi, the bot daemon, or the active package's
JavaScript runtime. This improves failure independence, but it is not
host-independent: power, disk, network, account, and whole-host failures can
still affect both the service and supervisor.

The HTTP listener accepts only loopback addresses and bearer authentication.
It normalizes allowlisted fields and commits before acknowledging. Delivery is
at-least-once and keyed by a stable transition ID. The fixed SQLite schema uses
WAL, full synchronous writes, foreign keys, a bounded busy timeout, and startup
integrity checks. Corruption or a schema mismatch fails closed and is never
reset automatically.

Monitoring payloads are untrusted. Secrets belong in files resolved by the
native monitoring secret contract; never put them in configuration, argv, logs,
or event fields. The control workspace, installed package, and source checkout
are separate roots. Set the control workspace with
`MINIME_CONTROL_WORKSPACE_ROOT`. The examples contain placeholders and do not
depend on a source checkout.

## Configuration

Copy `examples/recovery/recovery.json` to the control workspace and validate
it:

```sh
minime-bot recovery config validate --workspace /path/to/control-workspace
```

The JSON object is closed and requires every field shown in the example.
`version` is `1` and `mode` must be `observe`. Legacy modes are rejected.
Runtime paths are control-workspace-relative and cannot contain `..`; the host
must be loopback; and the port is bounded. Source IDs are unique values from
`alertmanager` and `runtime_doctor`. Correlation rules have a unique
component/failure-class identity, an incident key, and impact from 0 through 3.

The required timing fields are `runtimeDoctorCadenceSeconds`,
`verificationFreshnessSeconds`, and `verificationHoldDownSeconds`. The shipped
values are 300, 660, and 60 seconds. Cadence is bounded from 30 through 3,600
seconds, freshness from 60 through 86,400 seconds, and hold-down from 0 through
86,400 seconds. Freshness must be strictly greater than two doctor cadences, so
two successive delayed or missed five-minute observations do not immediately
turn a quiet source stale. The runtime-doctor launchd `StartInterval` must match
the configured cadence.

The optional `probes` registry is limited to 128 unique IDs. A probe has this
closed shape:

```json
{
  "id": "local-health",
  "executable": "/usr/bin/true",
  "argv": [],
  "env": {"LANG": "C"},
  "timeoutMs": 1000
}
```

IDs use letters, digits, `.`, `_`, `:`, and `-`. Executables must be
absolute and cannot be shells, interpreters, process-indirection utilities, or
known mutating service/package/privilege tools. Argv and environment are static,
bounded, and reject credential-bearing flags and sensitive variable names.
Timeouts are bounded. The public example configures no probes.

The supervisor has one mode: `observe`. It may intake, correlate, audit,
report health, refresh deterministic probes, verify resolved episodes, and use
native escalation fallback. It never creates a fixer invocation or completion
claim and never executes a remediation action.

## Controls and inspection

Static controls remain available even though remediation dispatch is absent.
Dispatch can be disabled with a TTL while intake and verification continue:

```sh
minime-bot recovery dispatch disable --actor operator --reason maintenance --ttl 3600
```

Confirmation count is bounded to 1-5, cooldown to 0-86400 seconds, retry budget
to 0-10, list output to 100 rows, and every expiring control to 31 days.
Mutating commands require a bounded actor and reason and create an immutable
policy revision plus audit record. The CLI exposes named operations only; there
is no SQL, shell, or arbitrary argv mode.

The retained commands are `status`, `incidents`, `invocations`,
`dispatch`, `controls`, `silence`, `retry`, `policy history`,
`policy rollback`, and `process --once`. Run `minime-bot --help` for exact
forms.

## Incident lifecycle

Allowlisted component/failure-class pairs correlate into deterministic
incidents. Material evidence or policy changes advance the incident generation.
The ledger retains one-owner lease and generation/evidence/policy fencing as
substrate for the follow-up trusted fixer, but observe mode never claims that
lease or inserts an invocation.

A resolved episode enters verification. Recovery is declared only after every
correlated firing episode resolves, required probes are healthy, source and
supervisor heartbeats are fresh, and the hold-down elapses. Missing or stale
monitoring is insufficient evidence: evaluation defers and cannot classify or
mark a missed recovery. A future-dated observation is stale rather than fresh.
Only a fresh unhealthy observation that contradicts a recorded completed fixer
claim can use the guarded missed-recovery seam; observe mode never creates such
a claim. Confirmed impact, failed verification, exhausted crash retries,
supervisor unavailability, and persistence failures use the immediate native
escalation path.

The trusted Pi fixer, exact-session re-entry, action journal, independent
two-slot recovery capsule, and offline bot rollback are explicitly deferred to
a follow-up change.

## Shadow acceptance drills

1. Install the package, create the owner-only authentication token, validate the
   configuration, and start the supervisor.
2. Configure Alertmanager's shadow receiver with `continue: true` and run the
   runtime doctor with `MINIME_DOCTOR_SINK=tee`. Treat the supplied plist as a
   replacement for the existing doctor job, not a second parallel job.
3. Send duplicate and out-of-order firing/resolved transitions. Verify one
   durable event per transition ID, deterministic correlation, zero invocations,
   and zero remediation processes.
4. Restart with unacknowledged intake, a synthetic stale lease, and queued
   emergency notification state. Verify spool drain, crash reconciliation,
   fencing, and fallback retry while Node, Pi, and the bot package are absent.
5. Exercise ledger and delivery failure. Verify retryable intake or durable
   spool, compact fallback without raw payload, and later delivery. Never
   replace or delete a corrupt ledger during the drill.
6. Exercise source freshness, hold-down, control expiry, retry bounds, and policy
   rollback. Confirm that no control can enable remediation.

Self-monitor the authenticated `/healthz` endpoint, process liveness, source
heartbeats, ledger/spool disk space, pending immediate escalation age, and
emergency delivery.

## Upgrade and rollback

Before an upgrade, disable dispatch with a TTL, keep shadow intake running, take
a filesystem-consistent backup of the stopped ledger and spool, install the new
package, validate configuration, and restart. The schema has no migration
ladder: a version mismatch fails closed, so restore the matching package and
ledger together. Policy rollback changes static controls only; it does not
rewrite event history.

To abandon recovery, restore the runtime doctor to its default `telegram`
sink, remove the Alertmanager shadow route while retaining the native Telegram
receiver, confirm direct firing and resolution delivery, then unload the
supervisor. Preserve the ledger and audit for review.
