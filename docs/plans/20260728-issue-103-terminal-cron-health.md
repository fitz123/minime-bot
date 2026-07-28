# Issue #103: Terminal cron health through Prometheus and Alertmanager

## Goal

Classify each completed cron invocation exactly once as a bounded terminal success or failure, expose that state through restart-safe node-exporter textfile metrics, and provide a stable Prometheus/Alertmanager rule contract so monitoring—not per-invocation `Cron FAIL` delivery—owns incident grouping, repeats, and recovery. Let an LLM cron deliberately mark an unresolved finding as logical failure while delivering only its clean report.

## Non-goals

- No execution retry/backoff, idempotency declaration, logical-run deduplication, side-effect reconciliation, or retry policy framework.
- No Apple Health incident repair, issue #65 reopening, dashboard/Grafana, workflow database, or per-cron alert profile/threshold framework.
- No change to generated-output delivery retry/outbox reliability, ordinary successful delivery, cron schedules/prompts, runtime selection, or interactive/child-agent behavior.
- No promise of exactly-once Telegram notification. The guarantee is one terminal metric classification per invocation; Alertmanager owns incident-state delivery semantics.
- No production/private monitoring configuration in this public branch. Package examples and deterministic fixtures are the deployable contract; rollout is parent-owned.

## Context

- `src/cron-runner.ts` currently writes only `minime_cron_last_exit_code{cron}` on every terminal branch and `minime_cron_last_success_timestamp{cron}` on success. It directly sends a generic `⚠️ Cron FAIL` for execution failures, bypassing Alertmanager grouping/deduplication.
- The canonical metric addition is `minime_cron_runs_total{cron,outcome="success|failure"}` plus `minime_cron_last_run_timestamp_seconds{cron}`. Keep only bounded `cron` and closed `outcome` labels; diagnostics, error text, run IDs, destinations, identities, and private values must never become labels.
- Existing output delivery retries and the per-cron outbox protect delivery of owed generated output. They are not execution retries and must remain intact.
- `runPi()` already appends a package-owned cron system instruction. Extend it with the exact LLM-only marker `[[MINIME_CRON_UNRESOLVED_V1]]`. Recognize only one exact standalone final non-empty line, strip it before delivery, and ignore embedded/quoted marker-like prose and every script-cron output.
- Public deployment templates live in `examples/monitoring/`; active monitoring configuration is intentionally outside the package. Add `MinimeCronTerminalFailure` for non-zero exit state paired with an existing, non-future terminal timestamp, and `MinimeCronTelemetryIncomplete` when an exit series lacks its terminal timestamp (or the timestamp is materially future-dated). A stale old timestamp with a non-zero exit remains a firing terminal failure until a successful run replaces the state; missing both series is unobservable and must not be guessed. This avoids a false schedule-age threshold or per-cron policy.
- ADR-100 remains controlling: routine incidents are handled by monitoring/Ops state; only established escalation paths notify the operator. The package runner must not emit a duplicate generic execution-failure notification after this replacement contract ships.

## Validation Commands

```sh
npm ci
node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 --test-timeout=240000 src/__tests__/cron-runner.test.ts src/__tests__/cron-runner-pi.test.ts src/__tests__/cron-runner-isolation.test.ts
node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 --test-timeout=240000 src/__tests__/monitoring-rules.test.ts src/__tests__/package-install.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
```

Run the checked-in Prometheus rule fixture with `promtool test rules` when `promtool` is available. Parent rollout must run the same fixture with the pinned production Prometheus tool before active reload; absence of `promtool` there is a rollout failure, not a reason to skip validation.

## Tasks

### Task 1: Add one terminal classification and metric update contract

**Goal:** Make every terminal cron path produce one bounded terminal metric snapshot, and make an intentional unresolved LLM result become one stripped report plus non-zero logical failure without duplicate generic failure delivery.

**Serves:** Exact terminal outcome/timestamp metrics; clean `NO_REPLY` and repaired success; agent-declared unresolved failure; bounded labels; removal of direct per-invocation `Cron FAIL`; no execution retry/idempotency.

- [x] Introduce a small exported terminal-result classifier for LLM output. Put the exact marker `[[MINIME_CRON_UNRESOLVED_V1]]` in the package-owned cron system instruction; accept only one exact standalone final non-empty line for LLM crons, remove it from delivered output, and leave embedded/quoted marker-like prose and all script output unchanged.
- [x] Route clean empty/`NO_REPLY`, visible successful/repaired output, agent-declared unresolved output, execution failure, delivery-terminal failure, config failure, and outbox-terminal paths through one explicit outcome-finalization boundary per invocation. An unresolved report is delivered through the existing retry/outbox path, then records failure and exits non-zero; it never triggers an additional generic failure message.
- [x] Remove direct generic execution-failure delivery and failure-notice outbox creation from the execution-error branch while preserving bounded local diagnostics, generated-output delivery retry/outbox semantics, admin notification for delivery-path failure, and successful user-facing output behavior.
- [x] Extend the atomic per-cron textfile contract with both `minime_cron_runs_total{cron,outcome="success|failure"}` series and `minime_cron_last_run_timestamp_seconds{cron}`. Preserve existing last-exit and last-success series, stable collision-safe filenames, label escaping, prior counts across process restarts, and valid whole-file snapshots without temporary-file residue.
- [x] Add focused tests proving exactly one metric update per terminal path, monotonic success/failure counts across writes and module/process-like restarts, counter-reset/corrupt-or-missing prior-state behavior, atomic files, bounded labels, clean `NO_REPLY`, repaired visible success, unresolved stripped report/non-zero exit, no generic duplicate, marker-like prose safety, script exclusion, execution failure without direct delivery, and unchanged output/outbox delivery behavior.

### Task 2: Publish the stable Prometheus/Alertmanager contract

**Goal:** Supply deterministic public templates and rule fixtures for one stable cron-health incident with firing, recovery, and explicitly tested stale/missing telemetry behavior.

**Serves:** Prometheus/Alertmanager ownership of state/grouping/dedup/repeats/resolved transitions; bounded stable labels; parent-owned production cutover evidence.

- [x] Add `MinimeCronTerminalFailure` to `examples/monitoring/minime.rules.yml`: fire on non-zero `minime_cron_last_exit_code` joined by `cron` to an existing `minime_cron_last_run_timestamp_seconds` that is not materially future-dated. Add `MinimeCronTelemetryIncomplete` for an exit series with no terminal timestamp or a materially future-dated timestamp. A stale old timestamp plus non-zero exit must remain firing until success; missing both series stays unobservable. Keep output labels closed and stable (`alertname`, bounded inherited `cron`, fixed severity/component/failure class); do not put values, diagnostics, destinations, run IDs, or timestamps into labels and do not invent schedule-age/per-cron policy.
- [x] Add a checked-in `promtool` rule-test fixture covering success/no alert, terminal failure after the configured `for`, repeated failed samples as one stable alert identity, success recovery, counter reset without alert-identity change, stale failure remaining firing, missing timestamp producing telemetry-incomplete, future timestamp producing telemetry-incomplete, and missing all series producing no invented alert.
- [x] Add repository tests that parse the example rule, Alertmanager template, and rule-test fixture and assert the bounded label/grouping contract, four-hour Alertmanager repeat, resolved delivery, and absence of per-cron/unbounded selectors. When a compatible local `promtool` is available, execute the fixture; keep the fixture independently runnable in parent rollout.
- [x] Update `README.md` and `docs/monitoring.md` with the four-series terminal contract, logical-failure marker semantics, direct-generic-notification removal, Alertmanager ownership boundaries, `promtool` command, and safe rollout order. Do not document private destinations or active host paths.

### Task 3: Close package regressions and release readiness

**Goal:** Prove the narrowed change is package-complete and does not alter unrelated cron, runtime, or delivery behavior.

**Serves:** Full package confidence, public safety, installability, and a decision-complete handoff to monitored rollout.

- [x] Extend package-install/artifact assertions so the monitoring rule-test fixture and updated examples are shipped and runnable, with no import-time process, network, or filesystem side effects.
- [x] Run all focused cron/monitoring tests and inspect terminal branch coverage for a single metric-finalization call. Confirm no test or implementation adds execution retries, idempotency fields, per-cron policies, direct generic `Cron FAIL`, or changes outside runner/metrics/examples/docs/package tests.
- [x] Run `npm test`, `npm run lint`, `npm run build`, and `npm pack --dry-run`; run `git diff --check`, public tracked-file/identity/secrets checks, and verify the worktree is clean after commits.

## Post-Completion

Parent custody will independently compare the Ralphex diffstat with `main...HEAD`, rerun focused/full validation, open the public feature PR, complete Copilot/CI review, and merge only with green checks and no unresolved threads. It will create a CalVer release PR and published tag.

Before deploying the package, parent custody will use the canonical private-repository PR flow to add the tested cron-health rule fixture to active Prometheus configuration and verify the existing Alertmanager grouping, four-hour repeat, and resolved route. It will run the pinned `promtool`, validate Compose/current bind mounts, reload or recreate only the required monitoring services, and prove the replacement route while native monitoring remains healthy. No Apple Health repair or retry/idempotency work is allowed.

Every bot deploy/restart or cron sync will use the operator-required Homebrew runtime root. Immediately before and after each operation, parent custody will verify all persisted and live cron jobs retain that root and that `run-cron.sh` resolves Homebrew Node. Cron-only corrections use the no-restart sync path.

After active monitoring is verified, parent custody will deploy/restart the released package and run controlled installed-artifact checks for clean `NO_REPLY`, repaired visible success, stripped unresolved logical failure/non-zero exit, bounded counters/timestamps, and absence of duplicate direct generic failure. A controlled real Prometheus→Alertmanager firing/recovery episode will prove stable grouping, one configured incident episode, resolved transition, healthy native monitoring, and no unrelated cron changes. Parent then performs final-main/release/deploy/worktree audit, closes issue #103 with public proof, updates Knowledge, and leaves the sole terminal report to the host watcher.
