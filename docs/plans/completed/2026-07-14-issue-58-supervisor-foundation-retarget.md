# Issue 58: Retarget PR #60 to the Recovery Supervisor Foundation

## Goal

Retarget PR #60 from a restricted planner/actuator implementation to the corrected host-native supervisor foundation approved for issue #58. Preserve durable authenticated intake, correlation, fencing, crash reconciliation, controls, verification, notification outboxes/fallback, and inspection CLI. Remove the planner, model-output action contract, Node worker/static actuator, and adaptive policy. The full trusted Pi fixer and independent recovery capsule belong to the follow-up PR.

The foundation must remain safe and useful with no runnable fixer: it may observe, persist, reconcile, verify through host-native probes, report status, and exercise static controls, but it must not spawn Pi/Node remediation or execute mutating runbooks.

## Required behavior

- Runtime-doctor tee delivery is independent: a failed recovery sink cannot block native delivery of later transitions, and a throttled native supervisor-unavailable fallback is armed in tee and recovery modes.
- Runtime-doctor cadence and source freshness are strict configurable values with shipped defaults of 300 seconds and 660 seconds. Missing or stale telemetry is insufficient evidence and defers evaluation; it never becomes `recovery_failed` or `missed_recovery`.
- Deterministic verification probes execute in the stdlib Python supervisor using reviewed absolute executable/static argv definitions, never through the active bot package's Node worker and never through a shell.
- Event history is indexed and bounded without losing the latest state needed to reconstruct active firing episodes.
- Public files contain no private paths, identities, destinations, payloads, or secrets.

## Scope removals

Remove planner-only package artifacts and wiring, including `src/recovery/fixer-runner.ts`, `src/recovery/runbook-executor.ts`, `src/recovery/worker.ts`, both `recovery_plan` extension copies (`src/pi-extensions/recovery-plan.ts` and `extensions/pi/recovery-plan.ts`), the planner-only Knowledge wrapper `extensions/pi/recovery-knowledge-tools.ts`, the `recovery_plan` output contract, planner/executor tests, planner modes, approval-actuator states/commands, and their documentation. Remove the `runbooks` config field and its actuator-only `actionClass` handoff enum from the closed schema, examples, and docs; retain only deterministic `probes`. Remove `BoundedPolicyAdapter`, adaptation/replay controls, outcomes, CLI commands, docs, and tests. Remove the aggregate success digest end-to-end: `queue_digest`, `queue_periodic`, `format_recovery_notification`, the `digest` CLI command, and maintenance digest queue/delivery; retain only the durable immediate-escalation outbox plus `EmergencyNotifier` and automatic native fallback. Do not edit the completed obsolete plan or unrelated coding-agent role files named planner/worker.

The foundation has one runtime mode: `observe`. `RECOVERY_MODES`, config, CLI defaults, examples, and startup validation must reject legacy `plan`/`enabled` modes. Python probe refresh and verification still run in observe mode, but observe mode creates no fixer invocation, completion claim, approval, or remediation action.

## Validation commands

```bash
/usr/bin/python3 -m unittest scripts.tests.test_recovery_supervisor scripts.tests.test_recovery_cli
npm run lint
npm test
npm run build
npm pack --json --dry-run
! rg -n 'worker\.js|recovery[_-]plan|recovery-knowledge-tools|BoundedPolicyAdapter|RecoveryProcessor|planner_evidence|record_worker_result|plannerLaunched|executorLaunched|resolveRecoveryPlannerExtensionArgs|queue_digest|queue_periodic|format_recovery_notification' scripts src package.json examples README.md docs/recovery.md docs/monitoring.md
! rg -n "(^|[\"' ])(approve|reject|digest)([\"' ]|$)" scripts/recovery_cli.py
! rg -n 'runbook|actionClass' scripts/recovery_config.py scripts/recovery_supervisor.py scripts/recovery_cli.py examples
```

## Tasks

### Task 1: Remove the obsolete planner, actuator, worker, and adaptive policy
- [x] Delete both planner output-extension copies, the planner-only Knowledge wrapper, static runbook actuator, Node worker, planner-only package build entries, and their dedicated tests without removing the generic supervisor ledger/fencing substrate.
- [x] Remove the actuator-only `runbooks` config field and `actionClass` handoff enum from the closed schema, examples, docs, and tests while retaining only validated deterministic `probes`.
- [x] Remove plan-mode/model-result/runbook execution paths and reduce `RECOVERY_MODES` plus config/CLI/example defaults to startup-enforced `observe` only, so the foundation cannot spawn Pi or Node remediation and cannot claim aggregate planner output as final recovery success.
- [x] Remove adaptive threshold/replay implementation and aggregate digest queue/format/CLI/docs/tests while retaining reviewed static controls, dispatch kill switch, expiring silences, retry controls, audit, status, the durable immediate-escalation outbox, and native fallback.
- [x] Pin the post-retarget CLI: retain `status`, `incidents`, `invocations`, `dispatch`, `controls`, `silence`, `retry`, `policy history`, `policy rollback`, and `process --once`; remove `approve`, `reject`, and `digest`, `_approval`, approval/handoff states and outcomes, and drop `plannerLaunched`/`executorLaunched` from the `process --once` JSON contract and installed-package assertions.
- [x] Keep crash reconciliation, one-owner lease/fencing, generations, deterministic incident state, and explicit injectable seams needed by the subsequent full-fixer PR.
- [x] Add regression assertions that observe/foundation operation launches no Pi/Node fixer, creates no completion claim, and performs no mutating action, then run focused tests.

### Task 2: Make tee delivery lossless across recovery-sink outages
- [x] Refactor `scripts/runtime_doctor.py` so a stuck recovery pending batch does not return before comparing the current incident set with the pending target in tee mode.
- [x] When new transitions occur while the recovery sink is down, deliver the new native state once, append/deduplicate those transitions into the durable pending recovery batch, and preserve retry state without duplicating earlier native notifications.
- [x] Invoke the existing throttled supervisor-unavailable native fallback on recovery-sink failure in both tee and recovery modes, while preserving default telegram-mode behavior.
- [x] Add tests for multiple firing/resolved transitions during a prolonged sink outage, restart from pending state, native-delivery failure, eventual recovery delivery, dedupe, and fallback throttling.
- [x] Run the runtime-doctor and supervisor focused tests before continuing.

### Task 3: Configure 300-second cadence and 660-second freshness with stale-as-defer semantics
- [x] Add required closed-schema recovery config fields for runtime-doctor cadence and verification freshness, wire them into production construction, and ship/document defaults of 300 and 660 seconds respectively; retain a bounded configurable hold-down.
- [x] Keep the launchd shadow example at the configured 300-second cadence and validate field presence, ranges, and timing relationships without silently substituting hard-coded verifier defaults.
- [x] Distinguish missing, stale, fresh-unhealthy, and fresh-healthy heartbeat/probe evidence in verification results.
- [x] Retain `mechanical_classification`/`mark_missed_recovery` only as a guarded follow-up seam: no recorded completed invocation claim means defer, any missing/stale required evidence means defer regardless of elapsed time, and only a completed claim plus fresh contradictory evidence may classify/mark failed; observe-mode maintenance never creates such a claim.
- [x] Add boundary tests spanning successive 300-second doctor observations, 660-second freshness expiry, future timestamps, missing sources/probes, no-invocation observe mode, and fresh unhealthy evidence after an explicit test claim; prove stale data cannot emit `recovery_failed`.
- [x] Run focused config, CLI, and supervisor tests before continuing.

### Task 4: Execute deterministic verification entirely in the Python supervisor
- [x] Replace Node-worker verification with a stdlib Python probe runner that accepts only validated absolute executables plus static argv/env, uses no shell or interpreter indirection, and applies bounded output and process-group timeouts.
- [x] Fence probe execution and result recording against incident generation/policy before launch and after completion; terminate/ignore stale work safely.
- [x] Run Python probe refresh and verification from the observe-mode maintenance loop, removing the legacy `mode == "enabled"` gate while keeping all remediation dispatch disabled.
- [x] Keep host-native intake, source heartbeats, probe refresh, hold-down, and notification fallback operable when Node, Pi, or the active bot package is unavailable.
- [x] Add tests for healthy/unhealthy probes, timeout/process cleanup, malformed configuration, stale fences, observe-mode refresh, broken/missing Node and package artifacts, and direct supervisor authority over recovery state.
- [x] Run focused Python tests before continuing.

### Task 5: Bound event history without losing active episode state
- [x] Add minimum-sufficient SQLite indexes for received-time and latest source/fingerprint lookups used by reconciliation and CLI queries.
- [x] Add deterministic maintenance retention with conservative reviewed defaults, preserving the newest state for every source/fingerprint and all rows required by active incidents while pruning only superseded history.
- [x] Keep retention transactional, bounded per maintenance pass, audited/observable, and fail-safe under lock/full/corrupt-ledger conditions.
- [x] Add tests for high-volume history, active firing preservation, out-of-order input, bounded maintenance batches, restart reconstruction, and query-plan/index use where stable.
- [x] Run focused ledger/supervisor tests before continuing.

### Task 6: Align the public foundation contract, package, and validation
- [x] Update recovery config examples, CLI help/status, docs, monitoring docs, README, package artifacts, and installed-tarball expectations to describe only the foundation and the follow-up full-fixer/exact-session/action-journal/two-slot-capsule/offline-bot-rollback boundary.
- [x] Remove recovery worker/plan entries from `package.json`; remove both `recovery-plan.ts` and `recovery-knowledge-tools.ts` wrapper entries from `scripts/build-package-artifacts.mjs`; and remove `dist/recovery/*`, `dist/pi-extensions/recovery-plan.js`, `dist/extensions/pi/recovery-plan.js`, `dist/extensions/pi/recovery-knowledge-tools.js`, the `resolveRecoveryPlannerExtensionArgs` assertion block, and old `plannerLaunched`/`executorLaunched` `process --once` expectations from `src/__tests__/package-install.test.ts`, without touching unrelated coding-agent role files.
- [x] Preserve authenticated loopback intake, atomic spool, idempotency, correlation/generations, one-owner fencing/crash recovery, static controls/kill switch/status CLI, deterministic verification, the durable immediate-escalation outbox, and automatic native fallback.
- [x] Add installed-package tests covering duplicate/out-of-order intake, tee sink-down transitions, cadence/freshness defer, Node/package failure, probe execution, retention, controls, corruption/full-spool fallback, and zero remediation side effects.
- [x] Run targeted no-dangling-reference checks for removed planner/worker/adaptation/digest symbols, then scan the complete `main...HEAD` diff and packed file list for private paths, identifiers, destinations, payloads, secrets, obsolete claims, and source-checkout assumptions.
- [x] Run every validation command, verify the worktree is clean after commits, and report the exact `git diff --stat main...HEAD` scope.
