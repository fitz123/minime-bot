# Same-host recovery supervisor

The recovery supervisor is an opt-in, host-native authority around the existing
monitoring path. Direct native Telegram delivery remains the fallback. The
supervisor persists and correlates incidents, dispatches a mode-gated trusted Pi
fixer, independently verifies results, and queues redacted reports. Detection,
intake, native fallback, probes, and the recovery verdict stay in standard-library
Python and do not depend on Node, Pi, or the active bot release.

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
`version` is `2` and `mode` must be exactly `observe`, `diagnose`, or `enabled`.
Legacy and unknown modes are rejected.
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

All modes may intake, correlate, audit, report health, refresh deterministic
probes, verify resolved episodes, and use native escalation fallback. `observe`
never claims fixer work. `diagnose` permits fixer dispatch and inspection,
reconciliation, blocked, and finish protocol operations but rejects host
mutation. `enabled` permits the same dispatch plus journaled mutation. A fixer
spawn must carry the recovery-only extension; a missing wrapper or
`PI_EXTENSIONS_DISABLED=1` is a hard failure, never a bare default-tool spawn.

## Installation

Install the package first, then copy `examples/recovery/recovery.json` and
`examples/recovery/ai.minime.recovery-supervisor.plist` from that installed
package. Replace every plist placeholder with the installed package root and
control-workspace values. The supervisor requires both `--workspace` (or
`MINIME_CONTROL_WORKSPACE_ROOT`) and `--config`; there is no raw path/timing
fallback.

Create the dedicated private directories and both authentication tokens as the
same account that runs the launch agent:

```sh
umask 077
mkdir -p /path/to/control-workspace/config /path/to/control-workspace/var/recovery
chmod 700 /path/to/control-workspace/config /path/to/control-workspace/var/recovery
/usr/bin/uuidgen > /path/to/control-workspace/config/recovery-auth-token
/usr/bin/uuidgen > /path/to/control-workspace/config/recovery-fixer-auth-token
chmod 600 /path/to/control-workspace/config/recovery-auth-token /path/to/control-workspace/config/recovery-fixer-auth-token
```

Each token reader requires an owner-owned, regular, non-symlink ASCII file with
no group/other permission and a trimmed value from 16 through 4,096 bytes. The
intake token is accepted only by intake/control routes; the distinct fixer token
is accepted only by `/v1/fixer/*`. The supervisor passes the fixer credential
file path, never the token value, to the recovery process. Do not put either
token in the plist, logs, shell arguments, or recovery JSON.
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

Static controls remain available in every mode. Dispatch can be disabled with a
TTL while intake, native fallback, and verification continue:

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
minime-bot recovery capsule-stage|bot-stage --source LOCAL_RUNTIME --release-id RELEASE
minime-bot recovery capsule-activate|bot-activate --release-id RELEASE
minime-bot recovery capsule-bootstrap
minime-bot recovery bot-rollback --restart-operation-id REVIEWED_ID
```

Every command accepts the global `--workspace WORKSPACE` and optional
`--config PATH`. `minime-bot recovery COMMAND --help` forwards to the recovery
CLI for subcommand help.

## Incident lifecycle

Allowlisted component/failure-class pairs correlate into deterministic
incidents. Material evidence or policy changes advance the incident generation.
The ledger retains one-owner lease and generation/evidence/policy fencing.
`observe` never claims fixer work. `diagnose` and `enabled` claim eligible work
only while dispatch is on; disabling dispatch immediately restores observe-style
native fallback. The supervisor launches one fixer process group from the
recovery capsule and terminates it on timeout or fence loss.

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

The version-3 ledger stores exact-session bindings/replacements, action
intents/outcomes/reconciliations, completion claims, verification history, and
independent report/outbox state. A fixer `finish` is only a claim: it can never
mark the incident recovered. Fresh host evidence, hold-down, active-slot state,
and deterministic probes alone establish the terminal verdict. A contradiction
creates another fenced generation and resumes the same Pi session.

## Exact fixer session and action reconciliation

The fixer uses normal Pi context and tools plus the non-default
`dist/extensions/pi/recovery.js` wrapper. Recovery fails closed if that wrapper
cannot load or `PI_EXTENSIONS_DISABLED=1`; normal bot, cron, subagent, and
ask-agent invocations never load it by default. The runner uses the pinned Pi
mechanics: an owner-only `PI_CODING_AGENT_SESSION_DIR`, RPC `get_state` to obtain
`data.sessionId`, and exactly one canonical owner-only JSONL transcript. The
supervisor commits that binding before the incident prompt. A retry uses
`--session ID` and the same directory, never `--no-session`. Replacement is
allowed only after host inspection proves the transcript unreadable and Pi
returns its explicit no-session startup classifier.

Before every mutating `bash`, `edit`, `write`, Knowledge update, recovery tool,
or other mutating tool, the extension commits an intent. It commits an outcome
after the call. A crash leaves an `unknown` intent; inspection and the
idempotent reconcile endpoint remain available, but every later mutation is
blocked until all unknown actions are reconciled against host state. Diagnose
mode enforces the same journal but blocks mutation. Quarantine and reviewed
restart/rollback IDs execute in Python; the extension cannot submit argv, shell,
or path policy for those operations.

The trusted fixer may repair ordinary-user configuration, create preimages,
quarantine bounded temporary/cache files, make local commits, and request
reviewed user-service operations. Guards reject privilege escalation,
irreversible deletion, public or external mutation, secret access/rotation,
package or image download, prune/volume operations, and a competing Telegram
poller. This is a same-UID safety contract, not a hostile-process sandbox.

## Reports and degraded enrichment

After independent verification, the supervisor merges the model claim with the
authoritative event, action, session, quarantine, slot, and verification journal.
It redacts secrets and private paths, bounds the document, and queues one durable
report key. `REPORT_PENDING` and `REPORTED` belong to report/outbox rows and
never replace the incident's `recovered` outcome. Delivery failure leaves the
report pending across restart. Knowledge or Beads enrichment failure is listed
under degraded metadata and never blocks repair, verification, or report
creation.

## Recovery capsule and bot release slots

Capsule upgrade and bot deploy are separate offline operations. Stage only an
already installed, locally validated runtime tree; incident handling never
builds, downloads, runs a package manager, pulls an image, or switches both
domains. Capsule staging copies the recovery Python files, compiled fixer and
wrapper artifacts, and installed dependency closure into an immutable release.
Its manifest records checksums plus absolute, version-checked Node and Pi host
prerequisites. Activate only after staging succeeds:

```sh
minime-bot recovery capsule-stage --workspace /path/to/control-workspace --source /path/to/local/runtime --release-id capsule-2026-07
minime-bot recovery capsule-activate --workspace /path/to/control-workspace --release-id capsule-2026-07
minime-bot recovery capsule-bootstrap --workspace /path/to/control-workspace
```

The stable bootstrap validates `current`, starts it, and checks the authenticated
loopback health endpoint. Manifest or startup-health failure performs exactly one
`current -> previous` fallback for that generation. A second failure stops and
escalates. Atomic relative symlinks, a checksummed owner-only state file,
directory fsync, and pending-transition reconciliation make interrupted switches
recoverable.

Bot releases use a different slot root and the same immutable manifest rules.
Stage and activate local releases during deployment. During an incident,
`bot-rollback` verifies `previous`, switches atomically, and invokes only a
configured static restart operation ID. If restart fails and the former release
still verifies, it restores that release and invokes the same reviewed restart:

```sh
minime-bot recovery bot-stage --workspace /path/to/control-workspace --source /path/to/local/runtime --release-id bot-2026-07
minime-bot recovery bot-activate --workspace /path/to/control-workspace --release-id bot-2026-07
minime-bot recovery bot-rollback --workspace /path/to/control-workspace --restart-operation-id restart-bot
```

## Root capability boundary

The installed `scripts/recovery_rootctl.py` is an ordinary-user protocol
validator, not a privileged helper or listener. Phase 1 has an immutable empty
capability registry. Requests contain only a capability ID, incident ID,
idempotency key, active fence, current/peer UID, and rate-limit state; generic
command, argv, shell, and path fields are rejected. Every capability request is
therefore unsupported and must be blocked or escalated. No installation or
runtime path invokes privilege elevation.

## Shadow acceptance drills

1. Install the package, create the owner-only authentication token, validate the
   configuration, and start the supervisor.
2. Configure Alertmanager's shadow receiver with `continue: true` and run the
   runtime doctor with `MINIME_DOCTOR_SINK=tee`. Treat the supplied plist as a
   replacement for the existing doctor job, not a second parallel job.
3. In `observe`, send duplicate and out-of-order firing/resolved transitions.
   Verify one durable event per transition ID, deterministic correlation, zero
   invocations, and zero remediation processes.
4. Restart with unacknowledged intake, a synthetic stale lease, and queued
   emergency notification state. Verify spool drain, crash reconciliation,
   fencing, and fallback retry while Node, Pi, and the bot package are absent.
5. Exercise ledger and delivery failure. Verify retryable intake or durable
   spool, compact fallback without raw payload, and later delivery. Never
   replace or delete a corrupt ledger during the drill.
6. In `diagnose`, confirm that the full fixer can inspect and finish but every
   mutating tool is rejected. In `enabled`, crash after an intent, confirm all
   later mutation stays blocked, reconcile it, and then permit the next intent.
7. Exercise false success, stale telemetry, Pi/provider failure, quarantine,
   forbidden commands, report delivery failure/deduplication, degraded
   Knowledge/Beads enrichment, capsule fallback, offline bot rollback, and the
   empty root capability registry.

Self-monitor the authenticated `/healthz` endpoint, process liveness, source
heartbeats, ledger/spool disk space, pending immediate escalation age, and
emergency delivery.

## Upgrade and rollback

Before an upgrade, disable dispatch with a TTL, keep shadow intake running, take
a filesystem-consistent backup of the stopped ledger and spool, stage and
self-check a new capsule, then activate it. Upgrade the bot release separately.
The schema has no migration ladder: a version mismatch fails closed, so restore
the matching capsule and ledger together. Policy rollback changes static
controls only; it does not rewrite event history or switch release slots.

To abandon recovery, restore the runtime doctor to its default `telegram`
sink, remove the Alertmanager shadow route while retaining the native Telegram
receiver, confirm direct firing and resolution delivery, then unload the
supervisor. Preserve the ledger and audit for review.
