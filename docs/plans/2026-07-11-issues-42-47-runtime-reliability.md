# Plan: Issues #42 and #47 runtime reliability

Status: public package implementation complete and validated on 2026-07-11;
private control-workspace wiring remains a post-merge external follow-up.

## Goal

Ship two independently testable fixes in one sequential Ralphex run:

1. **#47:** stop restart churn during healthy Telegram silence while retaining bounded recovery for a stalled or failed `getUpdates` loop.
2. **#42:** provide portable host-native monitoring, Alertmanager webhook delivery, and Telegram notification helpers that remain functional when Node and/or the container monitoring stack are unavailable.

Keep separate implementation commits, tests, acceptance evidence, and rollback boundaries. Public code must contain no installation-specific paths, destinations, identities, secrets, or production payloads. Private control-workspace compose/config/launchd wiring is a post-merge follow-up and is not implemented in this repository.

## Verified root causes and constraints

- `src/polling-watchdog.ts` currently resets from incoming updates, calls `getMe()` after ten quiet minutes, and deliberately exits after three **successful** quiet heartbeats. Production therefore restarts a healthy quiet bot roughly every 33 minutes; current tests encode that false positive.
- `src/main.ts` touches the watchdog only from incoming updates. API reachability is not polling-loop progress.
- The installed grammY implementation (compatible with this repository's dependency) issues `getUpdates` through `bot.api`, has a 30-second default long-poll timeout, and runs configured API transformers for internal polling calls. A transformer can therefore expose successful poll completions independently of whether updates were returned.
- The existing operator webhook invokes a wrapper whose token resolution requires Node. The public package has no host-native SOPS-to-Telegram alert path or out-of-band runtime doctor.
- Prometheus/AlertManager remain the primary monitoring architecture. The host-native doctor is the independent fallback that must detect failures of that stack itself.
- Python standard library plus host tools (`launchctl`, `sops`) are allowed; the new alert/doctor runtime path must not execute Node or import package JavaScript.
- Never print decrypted secrets. SOPS extraction must be one validated key, captured in process memory, with no whole-file decrypt and no plaintext output/logging.

## Validation commands

```bash
npm test
npm run build
npm pack --dry-run
```

### Task 1: #47 polling progress watchdog

- [x] Implement and wire the real `getUpdates` progress probe and bounded watchdog state machine.
- [x] Add stable low-cardinality logs/metrics for healthy quiet polling and restart reasons.
- [x] Add deterministic fake-clock/probe coverage for every #47 acceptance path.
- [x] Run focused and full validation, then commit this task independently with `#47` in the commit message.

### Runtime design

- Add a small poll-progress probe (prefer `src/poll-progress.ts`) with a grammY `Transformer` and an immutable snapshot interface. Track `getUpdates` start time, successful completion time/count, in-flight state, and failed completion count. Only a successful `getUpdates` response advances healthy poll progress; an empty successful response is healthy silence.
- Install the probe through `bot.api.config.use(...)` before polling starts and return/read its snapshot without exposing the bot token.
- Replace the watchdog's `quietHeartbeats` heuristic with a poll-stall state machine:
  - a recent successful poll completion is healthy regardless of incoming update count;
  - ordinary silence may log/measure as quiet but never exits;
  - stale poll progress beyond a threshold greater than the explicit long-poll cadence triggers one bounded API reachability check;
  - reachable API + stale polling exits once with a `poll_stalled` reason;
  - failed/timed-out API reachability exits once with an `api_unreachable` reason;
  - overlapping checks are suppressed, heartbeat duration is bounded, and a decided restart cannot be emitted repeatedly.
- Set an explicit grammY long-poll timeout in `src/main.ts` and derive/document a conservative stall threshold from it rather than relying on an upstream default.
- Preserve incoming-update `touch()` as an activity signal only; it must not be required for healthy liveness.
- Do not suppress a real poll stall indefinitely merely because an agent turn is active. Current message processing is queued outside grammY's middleware, so a long Pi turn and healthy `getUpdates` completions can coexist. Cover that condition explicitly.
- Add low-cardinality watchdog observability in `src/metrics.ts`: poll-progress age/in-flight gauges and restart/check outcomes with stable reasons. Logs must distinguish healthy quiet polling, API failure, poll stall, and deliberate watchdog restart without chat/user data.

### Deterministic tests

Update `src/__tests__/polling-watchdog.test.ts` and add focused probe/wiring coverage as needed:

- fake-clock healthy silence for at least 60 simulated minutes (well beyond the old false-positive window), with successful empty poll completions and zero updates/exits;
- successful API heartbeat after stale poll progress -> exactly one `poll_stalled` restart;
- failed and hung/bounded-timeout API heartbeat -> exactly one `api_unreachable` restart;
- hung `getUpdates`, rejected `getUpdates`, and resumed polling;
- real incoming update does not substitute for poll progress and does not create a false restart while polling is healthy;
- active long-running agent turn while polling continues -> no restart;
- reentrant/overlapping checks and repeated checks after a restart decision -> one bounded decision only;
- transformer ignores non-`getUpdates`, marks in-flight correctly, advances completion only on success, and exposes no payload/token.

Commit this task independently with `#47` in the commit message. The task is complete only when focused tests plus the full suite pass.

### Rollback

Reverting the #47 commit removes the probe and restores the previous watchdog behavior without touching #42 files.

### Task 2: #42 Node-independent host monitoring and alert delivery

- [x] Implement the portable Python-standard-library secret, Telegram delivery, webhook, and runtime-doctor contracts.
- [x] Add generic launchd/config examples, package-file coverage, and public install/recovery documentation.
- [x] Add deterministic synthetic, Node-unavailable, secret-redaction, dedup/recovery, and self-monitoring tests.
- [x] Run full test/build/pack validation, then commit this task independently with `#42` in the commit message.

### Portable public contracts

Implement a small Python-standard-library toolset under `scripts/` (exact module split may be simplified, but responsibilities and test seams must remain explicit):

1. **Native Telegram delivery module/CLI**
   - Resolve the token in process from an intentionally named environment variable or from one SOPS file + validated dotted key.
   - Invoke `sops -d --extract <validated-expression> <file>` with captured stdout/stderr, timeout, and sanitized errors. Never decrypt the full file and never write/print the token.
   - POST `sendMessage` with `urllib`; destination/thread/message are POST data, token never appears in argv or emitted logs, and URL-bearing exception details are never logged.
   - Support bounded retry for 429/transient 5xx/network failures, honor bounded `retry_after`, validate Telegram's JSON `ok`, and exit nonzero after final failure.
   - Provide a test-only/configurable API base URL without weakening production HTTPS defaults.

2. **Alertmanager webhook receiver**
   - Bind to configurable loopback host/port/path; accept bounded JSON bodies; format only safe alert fields; use the native delivery module directly (not a Node wrapper or package JS).
   - Return success only when delivery succeeds so Alertmanager can retry failures. Support firing and resolved notifications, batch deduplication, and sanitized bounded logging.

3. **Host-native runtime doctor**
   - Run once under a launchd `StartInterval` (or an equivalently simple bounded loop), with all labels/endpoints/paths supplied through environment/config rather than hardcoded operator values.
   - Check the bot launchd service/process, bot metrics endpoint, Prometheus health, Alertmanager health, configured Node executable availability/path/version against a recorded baseline, and deploy/runtime-state freshness.
   - Optionally consume a configured non-prompting TCC status file/signal; report `unknown` when absent. Never inspect/edit TCC databases or trigger permission prompts.
   - Persist a versioned JSON incident state atomically. Notify only on failure transitions, deduplicate repeated identical failures, and send exactly one recovery transition. Corrupt state must fail safe without a notification storm.
   - Deliver directly through the native module so Prometheus, Alertmanager, Node, and the bot may all be down.
   - Emit concise public-safe incident codes/actions; no configured path, destination, token, decrypted material, or payload in logs/messages. Use bounded rotating local logs when a log file is configured.

4. **Package/install contract and docs**
   - Add generic launchd examples for the webhook and doctor with placeholders only and a Node-free PATH/runtime.
   - Add minimal Prometheus scrape/rule and Alertmanager route examples only where they clarify integration; do not ship operator configuration as defaults.
   - Add `docs/monitoring.md` covering validation-before-recreation, Compose recreation (not stale-container start), health/target/rule/routing checks, SOPS/env secret contract, launchd installation, synthetic firing/resolved tests, Node-unavailable test, dedup/recovery semantics, diagnostics, and rollback.
   - Include every runtime helper/template/example in `package.json` `files`; verify with `npm pack --dry-run` and package-install tests.

### Deterministic tests

Add Node test-runner coverage that spawns Python with isolated temporary directories and local fake HTTP endpoints. Tests must use synthetic values only.

- secret resolver validates dotted keys, captures only the requested SOPS value, rejects malformed keys, times out, and sanitizes all failures;
- Telegram delivery succeeds/retries/fails deterministically while the secret is absent from child argv, captured logs, exceptions, and retained fixtures;
- controlled Alertmanager firing and resolved payloads produce expected safe messages; duplicate incidents are suppressed; delivery failure returns non-2xx;
- doctor detects each configured component failure, including Prometheus/Alertmanager being down, deduplicates repeated runs, and emits one recovery after health returns;
- Node is absent or replaced by a failing stub in `PATH`, yet webhook delivery and doctor notification still succeed; assert no Node subprocess invocation;
- Node path/version drift and stale runtime state produce stable actionable incident codes without leaking their configured values;
- corrupt/missing state, overlapping invocation, timeouts, bounded body size, and malformed webhook payloads fail safely;
- launchd examples are valid plists and package dry-run contains all public runtime files.

Commit this task independently with `#42` in the commit message. Run the full test/build/pack validation after both task commits.

### Rollback

The public #42 change is additive. Reverting its commit removes helpers/templates/docs without changing the existing Node bot runtime or #47 watchdog.

## Post-public private handoff (document only; do not edit private files in this run)

After the public PR merges and a package version is available, the operator control repository will need a separate isolated branch/PR and, because the wiring is nontrivial, a second sequential Ralphex run. That follow-up must:

- replace the private Node-coupled webhook implementation with a thin invocation of the installed package's native webhook;
- configure the native doctor and webhook through private launchd/config values and the existing encrypted secret source;
- validate current Prometheus/Alertmanager config, recreate services from the current Compose location, and verify current bind mounts;
- prove targets/rules/routing, controlled firing/resolved delivery, Node-unavailable delivery, monitoring-stack-down detection, deduplication, and exactly-once recovery;
- preserve the current Compose architecture and avoid sudo, plaintext secrets, or token-bearing argv/logs.

## Final public acceptance boundary

- #47 tests prove hours of healthy silence never restart and forced poll failure still causes one bounded restart.
- #42 tests prove delivery and host detection work with Node unavailable and secrets absent from argv/logs/artifacts.
- `npm test`, `npm run build`, and `npm pack --dry-run` pass from a clean branch.
- `git diff --stat main...HEAD` matches the Ralphex review scope, with separate #47 and #42 implementation commits after the committed plan.
