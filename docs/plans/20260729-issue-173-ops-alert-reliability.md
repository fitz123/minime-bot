# Issue #173: Keep Ops Intake Available and Prevent Warning Fallback Fan-out

## Goal

Restore the existing ADR-100 contract after the compound production failure in
[issue #173](https://github.com/fitz123/minime-bot/issues/173): an ambiguous
external report receipt stays fail-closed and truthful without taking down Ops;
noncritical Alertmanager delivery stays retryable without per-group native
fan-out; canonical cron removal retires its terminal metric snapshots; and the
complete warning-to-Ops-to-verified-result path is regression tested.

## Context

- `src/ops-worker/supervisor.ts` builds report operations from the current
  report payload, while `src/ops-worker/lifecycle.ts` correctly refuses a new
  operation when a prior claimed receipt has no outcome.
- `src/ops-worker/telegram-control.ts` selects one pending report before polling
  commands; a lifecycle conflict is not a Telegram transport error and currently
  escapes the control loop, terminating the worker after its status server was
  started.
- `src/ops-worker/task-store.ts` already protects claimed receipts from evolving
  evidence, and the fixed `worker receipt-*`, `retry`, and `cancel` controls are
  the only supported reconciliation surface.
- `scripts/alertmanager_webhook.py` currently sends native fallback for a
  noncritical batch when source verification or Ops forwarding fails, then
  returns failure. Critical batches intentionally require independent native
  delivery.
- `src/cron-runner.ts` writes package-owned `.exit.prom` and `.success.prom`
  files from `sanitizeCronMetricStem()`. `src/launchd-cron-plists.ts` prunes
  removed/disabled launchd jobs but does not retire those exact metric files.
- Existing focused coverage lives in the Ops supervisor/control/intake/fault-lab,
  monitoring-native, cron-runner, and launchd-cron-sync suites.

## Non-goals

- Changing ADR-100 or suppressing post-recovery result reports.
- Weakening receipt query/claim/finish ordering, replay protection, authorization,
  or exactly-once ambiguity handling.
- Changing native-only monitoring mode or critical native delivery.
- Adding a broker, workflow database, second Ops role, generic policy framework,
  alert-specific runbooks, or unrelated retry machinery.
- Scanning or deleting arbitrary historical textfiles, durable Ops tasks,
  sessions, journals, or outbox records.
- Private monitoring/config implementation, production recovery, PR/release,
  deployment, launchd operation, and live drills; these remain parent-owned
  lifecycle work.

## Development Approach

- Keep the change package-owned and minimum-sufficient.
- Preserve public interfaces unless the task explicitly requires a bounded
  extension.
- Complete and validate each task before moving to the next.
- Treat alert payloads and external receipt state as untrusted evidence; never
  infer that an ambiguous external send happened or did not happen.
- Do not edit this plan after Ralphex starts.

## Testing Strategy

- Add focused regressions beside each changed subsystem.
- Use deterministic clocks, fake transports/readers, temporary state/textfile
  roots, and loopback-only servers.
- Add one package integration/fault-lab scenario that composes the observed
  failure and recovery chain rather than relying only on disconnected units.
- Preserve existing native-only, critical dual-delivery, receipt crash-replay,
  cron sync deferral, and `--no-prune` coverage.

## Validation Commands

```bash
npm run test:file -- src/__tests__/ops-worker-supervisor.test.ts
npm run test:file -- src/__tests__/ops-worker-telegram-control.test.ts
npm run test:file -- src/__tests__/ops-worker-alertmanager-intake.test.ts
npm run test:file -- src/__tests__/ops-worker-fault-lab.test.ts
npm run test:file -- src/__tests__/monitoring-native.test.ts
npm run test:file -- src/__tests__/launchd-cron-sync.test.ts
npm run test:file -- src/__tests__/cron-runner.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
```

## Tasks

### Task 1: Isolate an ambiguous report receipt to its task

**Serves:** Operator input 1 — keep fail-closed exactly-once protection for the
ambiguous external report while keeping worker health/status, intake, and
unrelated incident processing available.

- [x] Add a task-local report-reconciliation boundary in the Ops supervisor/control path: detect an incompatible claimed unfinished report before attempting a new operation, preserve the receipt and unknown external outcome unchanged, and durably make only that process-free task blocked/non-runnable with custody released until package-owned receipt/cancel recovery.
- [x] Ensure one isolated report cannot terminate or starve the Telegram control loop, status server, authenticated intake, other pending reports, or scheduler work; do not classify lifecycle safety failures as Telegram transport retries.
- [x] Keep fixed `receipt-query`, `receipt-claim`, `receipt-finish`, `retry`, and `cancel` semantics authoritative, and expose enough bounded task/status evidence to diagnose the isolated state without payload or secret disclosure.
- [x] Add supervisor/control/intake regressions for repeated startup/ticks with `mutationStartedAt != null` and `outcome == null`, including acceptance and processing of another incident while the original receipt remains ambiguous.
- [x] Run the Task 1 focused Ops suites and keep them green before Task 2.

### Task 2: Keep noncritical Ops failures quiet and retryable

**Serves:** Operator input 2 — no native per-group warning fan-out when Ops
forwarding is unavailable, while independent critical delivery remains intact.

- [x] Change bridge-mode delivery so noncritical source-query or Ops-forward failures return retryable failure without calling the native Telegram sink; leave successful noncritical forwarding quiet.
- [x] Preserve native-only compatibility, stale/forged acknowledgement behavior, and critical firing/resolved dual-delivery semantics, including failure when required critical native delivery fails.
- [x] Update monitoring integration tests for several distinct noncritical groups and repeated retries: zero per-group native messages, retryable HTTP outcomes until Ops accepts, and unchanged critical native delivery.
- [x] Update public monitoring documentation to state that routine noncritical bridge failures rely on the separately deduplicated Ops-health control-plane escalation rather than data-plane fallback.
- [x] Run the monitoring-native focused suite and keep it green before Task 3.

### Task 3: Retire terminal metrics with canonical cron removal

**Serves:** Operator input 3 — a cron removed through canonical sync must not
leave a terminal failure snapshot that can never self-clear.

- [ ] Share the existing deterministic cron metric artifact naming with canonical launchd sync without introducing a second naming rule or broad directory scan.
- [ ] When pruning is enabled and sync has proven a removed/disabled cron job inactive, retire only that identity's package-owned terminal `.exit.prom` and `.success.prom` artifacts; make missing files idempotent, surface unsafe I/O failures, and preserve deferral for active/unknown jobs.
- [ ] Keep dry-run and `--no-prune` mutation-free, and report planned/applied metric retirement in the bounded sync result without exposing metric contents.
- [ ] Add launchd sync regressions for stale and disabled identities, missing/idempotent files, active/unknown deferral, dry-run, `--no-prune`, unrelated textfiles, and failure without overbroad deletion.
- [ ] Run the launchd-cron-sync and cron-runner focused suites and keep them green before Task 4.

### Task 4: Prove the complete incident and recovery contract

**Serves:** Operator input 4 — regression and end-to-end package proof for the
exact incident chain, including one post-change result report.

- [ ] Add one deterministic package integration/fault-lab scenario that seeds an ambiguous report receipt, proves health/status and intake stay available, accepts an unrelated warning, and leaves the ambiguous task/receipt truthful and recoverable.
- [ ] Prove multiple noncritical groups during Ops unavailability remain retryable with no data-plane native messages, and prove a critical group still uses the independent native path.
- [ ] Continue the fixture through Ops recovery: accept a warning incident, persist an actual bounded repair/change action, obtain fresh deterministic PASS, and send exactly one result report whose receipt is APPLIED and whose payload retains diagnosis, action, and health proof.
- [ ] Exercise canonical cron removal against a failed terminal snapshot and prove the retired series source disappears without touching unrelated metrics or durable task artifacts.
- [ ] Run all focused suites, full tests, lint, build, and package dry-run; inspect the final diff for scope, safety, and public-data hygiene.

## Post-Completion

Parent-owned lifecycle work after Ralphex completes:

- Verify Ralphex's reported review diffstat against `git diff --stat main...HEAD`.
- Open and complete the sanitized feature PR review/CI cycle linked to #173.
- Create the next live-release-derived SemVer-valid CalVer release PR, publish
  the release, and deploy it through the canonical private wrapper.
- Activate the same release for the primary package consumer and isolated Ops
  wrapper, validating config/workspace/deploy contracts before cutover.
- Run production smokes for receipt isolation, quiet warning retries,
  deduplicated Ops-health escalation, independent critical delivery, real
  repair/change result reporting, cron telemetry retirement, runtime health,
  and tail audit.
- Close #173 only after merged-main validation, release/deploy parity, clean
  repository/worktree state, durable Knowledge update, and independent terminal
  verification pass.
