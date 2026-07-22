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

During an overlapping process replacement, the in-process Prometheus listener
retries an occupied configured host/port every second until the old listener
releases it. Scrapes can briefly continue reaching the old process. Other listen
errors remain logged, and shutdown cancels any pending address retry.

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

Partial or non-loopback bridge configuration fails startup. The named Ops
secret is decrypted alone into process memory. Its value is never written to
arguments, logs, errors, or forwarded payloads. Bridge mode preserves the
256 KiB body ceiling and forwards the original validated Alertmanager v4 body
with bearer authentication.

Bridge validation accepts up to 1,024 alerts within that byte ceiling, matching
Ops intake. An empty `groupLabels` map is the valid single group produced by an
ungrouped route; source verification still requires every delivered firing
member's label set and episode start to remain current, plus its fingerprint
when supplied.

For each firing delivery, the webhook first queries loopback Alertmanager's
grouped API with group-label and exact-receiver filters. The returned routed
group must have exactly the delivered `groupLabels` and receiver, and every
delivered firing member's labels and `startsAt` must exactly match a current
active, suppressed, or unprocessed member; a supplied fingerprint must match
too. The server-side filters keep unrelated global alert cardinality outside
the bounded response. Native deduplication derives its episode identity from
the verified receiver, group descriptor, member labels, and start time, never
the opaque webhook `groupKey`. A mismatch is treated as stale or forged input
and is acknowledged without forwarding. A source-query failure uses native
fallback and returns 503 so Alertmanager retries. Once the source is verified,
required sinks are:

- Noncritical: Ops acceptance is required. Success is quiet. Rejection,
  timeout, or outage sends native fallback but still returns 503.
- Critical: both Ops acceptance and native Telegram delivery are required;
  failure of either returns 503.
- Resolved-only: nothing is forwarded to Ops. Noncritical input is
  acknowledged quietly; critical input uses native Telegram and requires it to
  succeed.

The webhook returns 2xx only after every required sink succeeds. Its separate
process-local Ops and native deduplication state prevents a successful fallback
or escalation from being repeated while Alertmanager retries an incomplete Ops
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
- source-query or Ops failure sends one native fallback, returns 503, and does
  not repeat the successful fallback while the same body retries.

A required delivery failure returns a non-2xx response so Alertmanager can
retry.
Deduplication is process-local, retains at most 1,024 successful batch digests
for one hour, and resets when the webhook restarts. It suppresses immediate
retries; it is not durable exactly-once delivery. Large batches are summarized
within Telegram's message limit.

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

The runtime doctor defaults to `MINIME_DOCTOR_SINK=telegram`, preserving the
direct native behavior above. Recovery shadowing adds these settings:

- `MINIME_DOCTOR_SINK=tee` sends the native notification once, then retries the
  same durable recovery transition without duplicating Telegram delivery.
- `MINIME_DOCTOR_SINK=recovery` transfers routine transition delivery to the
  recovery supervisor; use it only after the shadow gates pass.
- `MINIME_DOCTOR_RECOVERY_URL` must be the loopback
  `http://.../v1/runtime-doctor` endpoint.
- `MINIME_DOCTOR_RECOVERY_TOKEN_FILE` must be an owner-only, non-symlink token
  file; `MINIME_DOCTOR_RECOVERY_ATTEMPTS` is bounded to 1-10.

During a prolonged recovery-sink outage, the doctor keeps the current pending
head in its owner-only state file and spills additional transitions into an
ordered owner-only sidecar queue. Recovery requests contain at most 64 events;
each acknowledged prefix is removed durably, and stable transition IDs make a
crash replay idempotent. Do not delete the state file or its
`.recovery-queue` sidecar while recovery delivery is pending.

The recovery shadow plist runs every 300 seconds. Keep its `StartInterval`
equal to the recovery configuration's required
`runtimeDoctorCadenceSeconds`. The shipped
`verificationFreshnessSeconds` is 660 seconds, strictly more than two doctor
cadences, so normal scheduling jitter does not make a source stale. A future,
missing, or expired heartbeat defers verification; it is never failure evidence.

In tee and recovery modes, exhausted supervisor delivery triggers a throttled
fixed native Telegram alert without including monitoring payload data. Keep the
doctor's native Telegram/SOPS settings configured after changing sinks.

These sink modes only select which native observations feed the supervisor.
`recovery.json` mode and the durable dispatch control independently decide fixer
behavior: `observe` keeps it off, `diagnose` permits inspection and
reconciliation only, and `enabled` permits journaled mutation. Sink selection
never grants mutation authority by itself.

Tee and recovery modes also send an authenticated heartbeat on every doctor
run, including unchanged healthy runs. Configure `MINIME_DOCTOR_ALERTMANAGER_URL`
so the same post carries a deterministic Alertmanager-health observation; this
prevents quiet sources from being mistaken for stale sources during recovery
verification.

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
