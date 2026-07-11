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
UTF-16-unit text boundary.

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
`--body-timeout` (default 5 seconds, capped at 30). `GET /healthz` is its local
readiness endpoint. Only IPv4 loopback or `localhost` bind hosts are accepted.
`MINIME_WEBHOOK_HOST`, `MINIME_WEBHOOK_PORT`, and `MINIME_WEBHOOK_PATH` provide
the corresponding launchd environment settings. The body timeout is an
absolute input deadline, and the receiver caps concurrent requests so slow
local clients cannot create unbounded request threads.

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

Post controlled synthetic firing and resolved Alertmanager payloads using
placeholder labels and confirm one Telegram message for each transition.
Repost the same payload to confirm batch deduplication. A delivery failure
returns a non-2xx response so Alertmanager can retry.
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
  check deployment freshness;
- optional `MINIME_DOCTOR_TCC_STATUS_PATH` consumes a small regular-file,
  non-prompting external signal containing `granted` or `denied`; absent,
  oversized, or non-regular inputs are reported as unknown.

`MINIME_DOCTOR_TIMEOUT` bounds subprocess and HTTP checks (default 5 seconds,
maximum 30), and `MINIME_DOCTOR_LAUNCHCTL` may select the launchctl executable
(default `/bin/launchctl`). `MINIME_DOCTOR_LOG_PATH` enables a 256 KB rotating
log with three backups. `MINIME_DOCTOR_RUNTIME_MAX_AGE` defaults to 3,600
seconds. All health URLs must be HTTP(S) URLs with a host.

`MINIME_DOCTOR_STATE_PATH` is required. Incident state is versioned JSON,
written atomically with mode 0600. Identical failures are suppressed, a changed
failure set is notified once, and a return to health sends one recovery.
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

Rollback is additive: boot out and remove the two copied launchd plists, remove
the added Alertmanager receiver/routing and Prometheus rule/scrape entries, and
recreate the monitoring services from the validated prior configuration.
Removing these helpers does not change the bot runtime.
