# Host-native monitoring and Telegram alerts

The package includes a Python-standard-library alert path that does not load
Node or package JavaScript:

- `scripts/monitoring_native.py` resolves one secret and sends Telegram
  `sendMessage` requests;
- `scripts/alertmanager_webhook.py` receives loopback Alertmanager webhooks;
- `scripts/runtime_doctor.py` independently checks the bot and its monitoring
  stack once per launchd interval.

The files under `examples/monitoring/` are templates, not deployment defaults.
Copy them outside the package and replace every placeholder. Keep the package
checkout, installed package, control workspace, and runtime state in distinct
locations.

## Runtime compatibility boundary

The current package pins its package-owned Pi runtime to 0.82.1 and grammY to
1.45.1. Pi owns bounded summarization retries. Its
`summarization_retry_scheduled`, `summarization_retry_attempt_start`, and
`summarization_retry_finished` records are continued stream activity, not a
terminal result or a reason for host monitoring to restart the bot;
`agent_settled` remains the accepted-turn terminal boundary.

The upstream OpenAI GPT-5.6 model metadata reports a 272K (272,000-token)
context window, so earlier compaction is expected and is not a degraded-runtime
signal by itself. grammY polling, delivery, draft, topic, media/upload,
retry/connectivity, and cancellation metrics retain their existing meaning.
This upgrade does not add a Minime-owned compaction retry, classify the
reasoning-only `stopReason=length` case as fixed, adopt new Bot API features, or
change production monitoring, deployment, restart, or rollback configuration.

## Codex subscription quota and web search

`web_search` uses Pi's existing `openai-codex` subscription OAuth and active
model through one fixed Codex Responses endpoint. The tool does not own a
credential file, billing integration, retry loop, durable incident state, or a
provider-specific Prometheus metric family.

The out-of-band `minime-codex-quota-sampler` remains the single quota source for
interactive work and search. It writes the cached snapshot used by `/status`
and the `codex_usage_*` node-exporter textfile metrics, including bounded probe
success and timestamp series. Search failures themselves are returned to the
calling model as bounded classifications.

Direct URL reads and browser automation do not go through `web_search`.
Bash-capable full agents use the host `agent-browser` executable (`read` for
agent-readable text, or `open` followed by `snapshot` for browser state). The
[README host workflow](../README.md#codex-web-search-and-direct-url-workflows)
documents the required Homebrew installation, minimum version, first-time
browser setup, doctor check, and manual no-pin upgrade policy. Search-only roles
do not receive Bash solely for URL access.

## Bot runtime identity, startup ownership, and media degradation

The bot publishes three package-owned metric families for runtime ownership and
terminal media health:

- `minime_bot_instance_info{user,home,slot,pid} 1` identifies the process that
  owns the metrics listener. Identity is resolved once at startup from the OS
  username and home, decimal process ID, and either a non-empty
  `MINIME_BOT_SLOT` or the real working-directory basename.
- `minime_bot_startup_conflicts_total{reason}` counts a closed conflict reason:
  `instance_lock_held`, `foreign_media_owner`, `unsafe_media_root`,
  `metrics_port_in_use`, or `duplicate_telegram_polling`.
- `minime_media_pipeline_errors_total{transport,media_type,stage}` counts one
  terminal user-visible failure after internal retries finish. `transport` is
  `telegram` or `discord`; media types are Telegram
  `voice|photo|document|animation|video|video_note|audio|sticker` and Discord
  `image|voice`; stages are
  `metadata|download|size-limit|conversion|transcription|empty-transcript`.
  Discord counts independently failed attachments. These counters are
  process-local event counts, not durable upstream-update deduplication.

The identity labels are deliberate local diagnostics, not general-purpose
cardinality dimensions. There is one identity series per serving process, but
PID and slot changes create a new time series across replacements. Restrict the
metrics endpoint and Prometheus access accordingly. Conflict and media labels
are closed sets: paths, tokens, chat/session/user identities, URLs, and error
text must never be added to them.

Before either conversational transport starts, the process inspects an existing
media root without creating, changing, traversing, or deleting it. A symlink,
non-directory, unreadable root, or root owned by another UID is a fatal startup
conflict; a missing root is allowed. The process then claims hashed media-root
and Telegram-token-fingerprint resources in deterministic order under an
owner-only OS-temporary namespace. Raw resources are never stored in lock
names. Partial acquisition rolls back, stale recovery validates both PID and
process-start identity when available, and release removes only the exact
nonce/inode claim still owned by the process.

Metrics binding is awaited before transports start. An occupied configured
address is `metrics_port_in_use`: the contender logs the conflict, releases its
claims, and exits non-zero instead of retrying while a scrape silently reaches
another listener. Supervisors should retry the complete process after the prior
owner has quiesced. During graceful replacement the old owner first stops new
Telegram/Discord work and watchdogs, drains sessions and queue/media cleanup,
stops metrics and remaining sessions, and releases runtime claims last. The
process-exit hook performs only ownership-checked best-effort release.

Every conflict log is exactly searchable by its bounded marker:

```text
MINIME_STARTUP_GUARD_CONFLICT reason=<reason>
```

No resource, token, identity, owner ID, path, or underlying error is appended.
A Telegram 409 increments and logs `duplicate_telegram_polling` once per caught
polling attempt while retaining the bounded handoff retry behavior.

A fatal conflict before the contender owns the configured metrics port cannot
make that contender's in-memory conflict counter scrape-visible. The counter is
observable when the serving process itself sees the conflict, notably Telegram
409 attempts. For pre-bind failures, alert on target down, missing identity, or
an installation-specific unexpected identity, and use the stable log marker for
the conflict reason. Do not treat the conflict counter as durable evidence.

The public `MinimeBotInstanceIdentityMissing` rule selects each UP
`job="minime-bot"` target that has no `minime_bot_instance_info` series joined
on `job,instance`. This detects a foreign or older listener that still answers
the scrape. `MinimeBotMediaPipelineDegraded` sums the ten-minute counter
increase by `job,instance,transport`, fires at three failures only while that
same target remains UP, and has a five-minute pending period. Its alert identity
does not retain PID, stage, or media type. `MinimeBotMetricsDown` remains the
separate target-down signal.

Expected user, home, and slot values are deployment policy and therefore do not
belong in the public rules. An external configuration can define one selector
per target using placeholders like this, replacing every placeholder only in
the private installation:

```yaml
- alert: MinimeBotUnexpectedInstanceIdentity
  expr: |
    (up{job="JOB_PLACEHOLDER",instance="INSTANCE_PLACEHOLDER"} == 1)
      unless on (job, instance)
    (minime_bot_instance_info{
      job="JOB_PLACEHOLDER",
      instance="INSTANCE_PLACEHOLDER",
      user="USER_PLACEHOLDER",
      home="HOME_PLACEHOLDER",
      slot="SLOT_PLACEHOLDER"
    } == 1)
  for: 5m
```

Keep `job` and `instance` on the expected series join so simultaneous targets
are evaluated independently. Validate the public rules and their multi-target,
counter-reset, target-down, and rolling-window fixtures with:

```sh
promtool test rules examples/monitoring/minime.rules.test.yml
```

## Terminal cron health contract

Each completed new logical cron run publishes one restart-safe terminal
classification through the node-exporter textfile collector. Exit state, both
counters, and the last-run timestamp share one atomic terminal snapshot; the
separate success timestamp snapshot changes only after success. The public
contract has four metric families:

- `minime_cron_last_exit_code{cron}` is zero for the latest success and
  non-zero for the latest failure;
- `minime_cron_last_success_timestamp{cron}` is updated only by success;
- `minime_cron_runs_total{cron,outcome="success|failure"}` increments exactly
  one closed outcome for each logical invocation;
- `minime_cron_last_run_timestamp_seconds{cron}` is the timestamp of the latest
  terminal classification.

The runner writes these snapshots to
`/opt/homebrew/var/node_exporter/textfile` by default.
`CRON_HEALTH_TEXTFILE_DIR` selects a different directory. The selected
directory must be writable by the runner and must be the same host directory
that node-exporter's textfile collector scans, or be mapped to it by the active
container bind mount. Canonical launchd cron sync persists this selection in
generated cron plists and, when pruning an inactive removed or disabled cron,
retires only that cron identity's exact terminal snapshots.

Terminal metric persistence is fail-closed. A directory, lock, prior-state
read, or snapshot-write failure is emitted on standard error and makes the
runner non-zero rather than allowing a successful process status against an
older terminal snapshot.

Only the bounded configured cron name and the closed `success` or `failure`
outcome are labels. Exit values, timestamps, diagnostics, run IDs,
destinations, and identities are not labels. Counter resets do not change an
alert identity.

For an LLM cron, the exact standalone final non-empty line
`[[MINIME_CRON_UNRESOLVED_V1]]` declares that the clean report still contains
an unresolved finding. The runner removes that line before normal
retry/outbox delivery, then records a logical failure and exits non-zero. A
marker embedded in prose, quoted, repeated, or followed by another non-empty
line is delivered unchanged. Script cron output is never marker-classified.

The example `MinimeCronTerminalFailure` rule joins non-zero exit state to an
existing terminal timestamp by `cron`. Its five-minute `for` period suppresses
brief evaluation churn, and its five-minute future tolerance rejects
materially future-dated timestamps. The rule intentionally has no schedule-age
threshold: an old non-zero terminal result remains firing until a successful
run replaces it.

`MinimeCronTelemetryIncomplete` reports an exit series whose terminal
timestamp is missing or materially future-dated. Missing both series remains
unobservable, so the rule does not invent a cron or an incident. Both alerts
inherit only `cron` and add fixed `severity`, `component`, and `failure_class`
labels. The Alertmanager example groups by `alertname` and `cron`, repeats a
continuing incident every four hours, and sends resolved transitions.

Execution failures do not send a second generic `Cron FAIL` notification.
Prometheus owns terminal evaluation, while Alertmanager owns incident
grouping, deduplication, repeats, and recovery delivery. Generated-output
retry/outbox behavior and the admin fallback for delivery-path failures remain
separate and unchanged. An old queued `failure-notice` record encountered
after upgrade is discarded without delivery.

Pickup-only outbox preflight failures and deferred redelivery attempts happen
before a new logical cron run begins. They exit non-zero without changing
last-exit, last-run, last-success, or counter series; use their bounded
`OUTBOX` cron-log evidence and process status for diagnosis.

Run the deterministic rule fixture from the package root:

```sh
promtool test rules examples/monitoring/minime.rules.test.yml
```

For rollout, first merge the example rules and Alertmanager route into the
external active configuration without replacing unrelated rules or routes.
Run the pinned production `promtool`, validate the active Alertmanager and
Compose configuration and current bind mounts, then reload or recreate only
the required monitoring services. Verify targets, loaded rules, routing, and
native monitoring health before deploying the package that removes direct
generic failure delivery. Confirm that a controlled run exposes all four cron
metric families through Prometheus from the selected textfile directory.
Finally, run controlled installed-artifact success, failure, and recovery cases
and confirm the stable alert group, resolved transition, four-hour repeat
contract, bounded metrics, and absence of a duplicate direct failure message.

## Prerequisites

The native helpers require Python 3.9 or newer. The encrypted-secret path also
requires SOPS. Resolve SOPS to an absolute executable path and set
`MINIME_SOPS_EXECUTABLE`; the launchd examples intentionally keep
`PATH=/usr/bin:/bin` so Node is not reachable. Before bootstrap, validate the
same executables the plist will use:

```sh
/usr/bin/python3 --version
test -x /PATH/TO/sops
env -i PATH=/usr/bin:/bin /PATH/TO/sops --version
```

## Secret and destination contract

Set `MINIME_TELEGRAM_CHAT_ID` and optionally
`MINIME_TELEGRAM_THREAD_ID`. Supply the token either in the intentionally named
`MINIME_TELEGRAM_BOT_TOKEN` environment variable or with both
`MINIME_TELEGRAM_SOPS_FILE` and `MINIME_TELEGRAM_SOPS_KEY`. The key is a dotted
identifier such as `telegram.bot_token`.

The SOPS path executes only `sops -d --extract <expression> <file>`, captures
the result in memory, and rejects malformed keys. It never performs a whole
file decrypt. Do not put the token in command arguments, plist files, logs, or
test fixtures. The default Telegram API is the official HTTPS origin. Every
`MINIME_TELEGRAM_API_BASE` override is test-only and requires
`MINIME_TELEGRAM_ALLOW_INSECURE_TEST_API=1`; overrides with credentials,
paths, queries, or fragments are rejected. Neither variable may be set in
production.
The delivery CLI accepts `--timeout` (default 8 seconds, maximum 30) and
`--attempts` (default 3, maximum 10). Messages are limited to Telegram's 4,096
UTF-16-unit text boundary. The per-attempt timeout is an absolute deadline for
DNS resolution, connection establishment, headers, and the response body.

Validate delivery before installing services:

```sh
/usr/bin/python3 scripts/monitoring_native.py \
  --chat-id DESTINATION_PLACEHOLDER --message "synthetic monitoring test"
```

## Alertmanager webhook installation

Copy `examples/monitoring/ai.minime.alertmanager-webhook.plist`, fill its
placeholders, lint it with `plutil -lint`, copy it to
`~/Library/LaunchAgents`, then use `launchctl bootstrap gui/$(id -u) <plist>`.
Keep the listener on loopback. Configure the container-to-host route separately
and restrict it with the host firewall where appropriate.

The webhook flags are `--host` (default `127.0.0.1`), `--port` (default 9876),
`--path` (default `/alertmanager`), `--max-body` (default 256 KiB), and
`--body-timeout` (default 5 seconds, capped at 30). Optional bridge flags are
`--ops-intake-url`, `--alertmanager-url`, and `--bridge-timeout` (default 5
seconds, capped at 30). `GET /healthz` is its local readiness endpoint. Only
IPv4 loopback or `localhost` bind hosts are accepted.
`MINIME_WEBHOOK_HOST`, `MINIME_WEBHOOK_PORT`, and `MINIME_WEBHOOK_PATH` provide
the corresponding launchd environment settings. The body timeout is an
absolute input deadline, and the receiver caps concurrent requests so slow
local clients cannot create unbounded request threads.

Bridge mode is opt-in and requires all of the following settings:

- `MINIME_OPS_INTAKE_URL` is the loopback HTTP URL ending in
  `/intake/alertmanager`.
- `MINIME_ALERTMANAGER_URL` is a loopback HTTP base URL with no credentials,
  query, fragment, or non-root path.
- `MINIME_OPS_INTAKE_SOPS_FILE` and `MINIME_OPS_INTAKE_SOPS_KEY` identify the
  existing Ops intake bearer in SOPS; the key uses the same dotted-identifier
  grammar as the Telegram key.
- Optional `MINIME_BRIDGE_TIMEOUT` sets the source-query and Ops-forward
  deadline above zero and no more than 30 seconds.

Partial or non-loopback bridge configuration fails startup; setting only the
optional bridge timeout also counts as partial bridge configuration. The named
Ops secret is decrypted alone into process memory. Its value is never written to
arguments, logs, errors, or forwarded payloads. Bridge mode preserves the
256 KiB body ceiling and forwards the original validated Alertmanager v4 body
with bearer authentication.

Bridge validation accepts up to 1,024 alerts within that byte ceiling, matching
Ops intake. An empty `groupLabels` map is the valid single group produced by an
ungrouped route; source verification still requires every delivered firing
member's label set and episode start to remain current, plus its fingerprint
when supplied. Valid UTF-8 group-label names are accepted and quoted in
Prometheus and Alertmanager matchers when they are not legacy-compatible names.

For each firing delivery, the webhook first queries loopback Alertmanager's
grouped API with group-label and exact-receiver filters. The returned routed
group must have exactly the delivered `groupLabels` and receiver, and every
delivered firing member's labels and `startsAt` must exactly match a current
active, suppressed, or unprocessed member; a supplied fingerprint must match
too. The server-side filters keep unrelated global alert cardinality outside
the bounded response. Native deduplication derives its episode identity from
the verified receiver, group descriptor, and de-duplicated firing-member labels
and start times, never the opaque webhook `groupKey`. Critical classification
and firing-batch native text likewise use only that verified firing set, so
resolved-member text or duplicate multiplicity cannot create a new escalation.
A batch is critical when at least one de-duplicated decision member has the
exact, case-sensitive label `severity="critical"`. Firing batches consider only
verified firing members; resolved-only batches consider their resolved members.
All other values and casing are noncritical.
A mismatch is treated as stale or forged input and is acknowledged without
forwarding. A source-query failure returns 503 so Alertmanager retries.
Critical source-query failures still use the independent native path; routine
noncritical failures stay quiet. Once the source is verified, required sinks
are:

- Noncritical: Ops acceptance is required. Success is quiet. Rejection,
  timeout, or outage stays quiet and returns 503.
- Critical: both Ops acceptance and native Telegram delivery are required;
  failure of either returns 503.
- Resolved-only: nothing is forwarded to Ops. Noncritical input is
  acknowledged quietly; critical input uses native Telegram and requires it to
  succeed.

Routine noncritical source-query and Ops-forward failures deliberately do not
use a per-group data-plane native fallback. Alertmanager retains and retries
those groups, while failure of the shared Ops path relies on the separately
deduplicated Ops-health control-plane escalation. This prevents one shared Ops
outage from producing a native Telegram message for every warning group.

The webhook returns 2xx only after every required sink succeeds. Its
process-local native deduplication state prevents a successful critical
delivery from being repeated while Alertmanager retries an incomplete Ops
delivery. Ops intake replay and coalescing provide durable task idempotency;
native deduplication remains the bounded process-local contract described
below. Setting none of the bridge variables preserves native-only delivery.

Merge the example Alertmanager receiver into the active configuration rather
than replacing operator configuration. Validate the active configuration,
then recreate the service from its current Compose project:

```sh
docker compose config
docker compose up -d --force-recreate alertmanager prometheus
```

Do not use `docker start` on stale containers: it does not apply current bind
mounts or configuration. After recreation, verify Prometheus health, targets,
loaded rules and firing state, then Alertmanager health, loaded configuration,
routing and notification status. Check that each configured bind mount points
to the intended current file.

With bridge mode disabled, post controlled synthetic firing and resolved
Alertmanager payloads using placeholder labels and confirm one Telegram message
for each transition. Repost the same payload to confirm batch deduplication.

Validate bridge mode with a real controlled group that is active in the queried
Alertmanager; an arbitrary manually posted firing body is intentionally treated
as stale unless its exact group is current. Check the complete delivery matrix:

- a noncritical firing creates or replays one Ops task and stays quiet on
  Telegram;
- a critical firing reaches both Ops and Telegram;
- a noncritical resolved-only delivery is quiet;
- noncritical source-query or Ops failure stays quiet and returns 503 until Ops
  accepts;
- critical source-query or required-sink failure retains independent native
  delivery and returns 503 while required work remains incomplete.

A required delivery failure returns a non-2xx response so Alertmanager can
retry.
Deduplication is process-local, retains at most 1,024 successful batch digests
for one hour, and resets when the webhook restarts. It suppresses immediate
retries; it is not durable exactly-once delivery. Large batches are summarized
within Telegram's message limit.

Native-only and bridge-critical Telegram lines append
`cron=<sanitized-name>` when the alert has a `cron` label, for both firing and
resolved transitions. For a native-only alert without a supplied fingerprint,
that sanitized cron value also participates in the fallback identity. Alerts
without a `cron` label retain the previous message and fallback-identity
format.

## Runtime doctor installation

Copy and fill `examples/monitoring/ai.minime.runtime-doctor.plist`. Its generic
five-minute `StartInterval` may be adjusted after testing. The doctor runs once;
launchd supplies repetition. Configure only checks
that exist in the installation:

- `MINIME_DOCTOR_LAUNCHD_LABEL` checks a running launchd service;
- `MINIME_DOCTOR_BOT_METRICS_URL`, `MINIME_DOCTOR_PROMETHEUS_URL`, and
  `MINIME_DOCTOR_ALERTMANAGER_URL` check bounded HTTP health;
- `MINIME_DOCTOR_NODE_EXECUTABLE`, `MINIME_DOCTOR_NODE_BASELINE_PATH`, and
  `MINIME_DOCTOR_NODE_BASELINE_VERSION` detect missing or drifted Node;
- `MINIME_DOCTOR_RUNTIME_STATE_PATH` and `MINIME_DOCTOR_RUNTIME_MAX_AGE`
  check deployment freshness from a regular file;
- optional `MINIME_DOCTOR_TCC_STATUS_PATH` consumes a small regular-file,
  non-prompting external signal containing `granted` or `denied`; absent,
  oversized, or non-regular inputs are reported as unknown.

`MINIME_DOCTOR_TIMEOUT` bounds subprocess and HTTP checks (default 5 seconds,
maximum 30), and `MINIME_DOCTOR_LAUNCHCTL` may select the launchctl executable
(default `/bin/launchctl`). `MINIME_DOCTOR_LOG_PATH` enables a 256 KB rotating
log with three backups. `MINIME_DOCTOR_RUNTIME_MAX_AGE` defaults to 3,600
seconds. All health URLs must be HTTP(S) URLs with a host.

`MINIME_DOCTOR_STATE_PATH` is required. Incident state is bounded,
regular-file versioned JSON written atomically with mode 0600. Identical
failures are suppressed, a changed failure set is notified once, and a return
to health sends one recovery.
Corrupt state is replaced without notifying on that run to prevent a storm.
The next run can notify an active incident from the repaired baseline. An
adjacent process-owned advisory lock suppresses overlapping invocations and is
automatically released after abnormal process exit. Configure
`MINIME_DOCTOR_LOG_PATH` for a bounded rotating log; logs contain stable codes,
not configured paths, endpoints, destinations, payloads, or secrets.

The example plists use `/usr/bin/python3`, an absolute SOPS executable, and a
Node-free `PATH=/usr/bin:/bin`. To prove independence, temporarily point the bot's Node
check at an unavailable synthetic path, stop the monitoring containers, and
run the doctor. Telegram delivery must still work. Restore health and run it
again to confirm exactly one recovery. The doctor never reads or edits TCC
databases and must not be used to trigger permission prompts.

## Diagnostics and recovery

If notifications stop, test the native delivery CLI first, then inspect the
webhook HTTP status and bounded logs. Validate the SOPS binary can extract only
the configured key without printing its value. Check launchd with
`launchctl print`, then verify Prometheus targets and rules and Alertmanager
routing. Revalidate Compose configuration before recreating services.

Bridge-only rollback keeps native delivery live: remove all four required
bridge settings (and optional `MINIME_BRIDGE_TIMEOUT`) together, restart the
webhook, verify a controlled native notification, and only then remove unused
Ops-side wiring. No Alertmanager receiver change is needed because the same
Node-independent webhook remains its receiver.

Full monitoring rollback is additive: boot out and remove the two copied
launchd plists, remove the added Alertmanager receiver/routing and Prometheus
rule/scrape entries, and recreate the monitoring services from the validated
prior configuration. Removing these helpers does not change the bot runtime.
