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
reset automatically. The ledger directory must be owned by the service account
with no group or other access; the database and SQLite sidecars are likewise
owner-only. Unsafe directories, files, and symlinks are rejected at startup.

Event retention runs during maintenance with conservative fixed defaults: only
superseded rows received more than 90 days ago are eligible, and at most 256
rows are removed per transaction. The semantic latest state for every
source/fingerprint is always retained, including the firing evidence needed to
reconstruct active incidents after restart. Each non-empty pass writes its
audit record in the same transaction; lock, disk-full, or ledger failures roll
the entire pass back.

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
Alertmanager rules match the normalized `component` and `failure_class` labels.
Runtime-doctor rules use `component: "runtime"` and the doctor incident code as
`failureClass`; for example, `node_unavailable` matches the second rule in the
shipped configuration. Unmatched transitions remain durably inspectable in the
ledger but do not open an incident. Add a reviewed rule before expecting a new
signal to appear in the incident drill.

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

IDs use letters, digits, `.`, `_`, `:`, and `-`. Probe execution uses a closed
positive registry rather than accepting arbitrary native programs. The current
reviewed contracts are `/usr/bin/true` or `/bin/true` with no arguments,
`/usr/bin/false` or `/bin/false` with no arguments, `/usr/bin/sleep` or
`/bin/sleep` with one bounded numeric argument, and macOS `/bin/launchctl` with
exactly `print` plus a bounded launchd target. Only `LANG` and `LC_ALL` locale
variables are accepted. Shells, interpreters, arbitrary files, network clients,
loader variables, and other executable/argument forms are rejected. Timeouts
are bounded, and the cumulative timeout budget must fit within one configured
runtime-doctor cadence. Each maintenance pass refreshes at most one incident's
probe set and schedules its next refresh from the durable set-completion time.
The stdlib Python supervisor resolves and revalidates the native
executable immediately before launch, supplies only the configured environment,
uses no shell, runs from `/`, discards all output, and isolates the probe in a
process group that is terminated on timeout or a stale generation/policy fence.
Results are recorded only after the same fence is rechecked transactionally.
The public example configures no probes.

The supervisor has one mode: `observe`. It may intake, correlate, audit,
report health, refresh deterministic probes, verify resolved episodes, and use
native escalation fallback. It never creates a fixer invocation or completion
claim and never executes a remediation action.

## Installation

Install the package first, then copy `examples/recovery/recovery.json` and
`examples/recovery/ai.minime.recovery-supervisor.plist` from that installed
package. Replace every plist placeholder with the installed package root and
control-workspace values. The supervisor requires both `--workspace` (or
`MINIME_CONTROL_WORKSPACE_ROOT`) and `--config`; there is no raw path/timing
fallback.

Create the dedicated private directories and authentication token as the same
account that runs the launch agent:

```sh
umask 077
mkdir -p /path/to/control-workspace/config /path/to/control-workspace/var/recovery
chmod 700 /path/to/control-workspace/config /path/to/control-workspace/var/recovery
/usr/bin/uuidgen > /path/to/control-workspace/config/recovery-auth-token
chmod 600 /path/to/control-workspace/config/recovery-auth-token
```

The token reader requires an owner-owned, regular, non-symlink ASCII file with
no group/other permission and a trimmed value from 16 through 4,096 bytes. Do
not put the token in the plist, logs, shell arguments, or recovery JSON.
Ledger and spool directories and their files also fail closed unless they are
owner-owned, regular non-symlink storage with no group/other permission. The
supervisor creates spool directories as mode `0700` and items as mode `0600`.

Validate the JSON, lint the filled plist, copy it into the account's
`~/Library/LaunchAgents` directory, and bootstrap it:

```sh
minime-bot recovery config validate --workspace /path/to/control-workspace
plutil -lint /path/to/ai.minime.recovery-supervisor.plist
launchctl bootstrap "gui/$(id -u)" /path/to/ai.minime.recovery-supervisor.plist
```

The plist log parent must exist before bootstrap. Validate `/healthz` with a
small local client that reads the bearer from the protected file at runtime;
do not place it in `curl` arguments or command history. For example:

```sh
MINIME_CONTROL_WORKSPACE_ROOT=/path/to/control-workspace /usr/bin/python3 - <<'PY'
import http.client
import os
from pathlib import Path

root = Path(os.environ["MINIME_CONTROL_WORKSPACE_ROOT"])
token = (root / "config/recovery-auth-token").read_text("ascii").strip()
connection = http.client.HTTPConnection("127.0.0.1", 9877, timeout=5)
connection.request("GET", "/healthz", headers={"Authorization": f"Bearer {token}"})
response = connection.getresponse()
print(response.status, response.read(1024).decode("ascii", "replace"))
connection.close()
PY
```

Behavioral settings come only from the validated recovery JSON. Operational
limits remain startup flags: `--max-body` defaults to 262,144 bytes and is
bounded to 1-4,194,304; `--body-timeout` defaults to 5 seconds and is bounded to
more than 0 through 30; `--max-concurrent` defaults to 16 and is bounded to
1-128; `--busy-timeout-ms` defaults to 2,000 and is bounded to 1-30,000; and
`--emergency-cooldown` defaults to 300 seconds and is bounded to 0-86,400.
`--chat-id`/`--thread-id` or `MINIME_TELEGRAM_CHAT_ID`/
`MINIME_TELEGRAM_THREAD_ID` select native emergency delivery. The supplied
plist also uses the documented SOPS environment contract for the Telegram bot
token.

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

The retained commands and their exact operation-specific arguments are:

```text
minime-bot recovery status [--config PATH] --workspace WORKSPACE
minime-bot recovery incidents|invocations [--id ID] [--limit 1-100] [--config PATH] --workspace WORKSPACE
minime-bot recovery dispatch enable|disable --actor ACTOR --reason REASON [--ttl SECONDS]
minime-bot recovery controls confirmation-count|cooldown|retry-budget VALUE --actor ACTOR --reason REASON [--ttl SECONDS]
minime-bot recovery silence INCIDENT_KEY --ttl SECONDS --actor ACTOR --reason REASON
minime-bot recovery retry INCIDENT_ID --actor ACTOR --reason REASON
minime-bot recovery policy history [--limit 1-100]
minime-bot recovery policy rollback REVISION --actor ACTOR --reason REASON
minime-bot recovery process --once
```

Every command accepts the global `--workspace WORKSPACE` and optional
`--config PATH`. `minime-bot recovery COMMAND --help` forwards to the recovery
CLI for subcommand help.

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

Alert timestamps more than five minutes ahead of their receive time are not
trusted for semantic ordering; the ledger conservatively orders those events by
receive time so a malformed future transition cannot mask later input.

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
