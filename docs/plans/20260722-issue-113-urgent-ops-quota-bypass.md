# Plan

## Goal

Make optional quota-headroom admission apply only to package-owned autonomous/background task sources while allowing trusted operational sources to attempt immediately. Preserve the existing reset-aware runtime quota path, authorization, custody, process ownership, deterministic verification, and reporting.

## Context

- Issue #113 authorizes one narrow behavior correction. Issue #61's quota family/duration rendering is explicitly out of scope.
- `src/ops-worker/types.ts` defines the complete trusted source-kind union and fixed priorities: operational `alertmanager`, `operator-cli`, and `operator-telegram`; autonomous/background `registered-cron` and `authorized-issue`.
- `src/ops-worker/supervisor.ts` currently invokes the same quota scheduler for every `RUN`, rechecks quota while claiming custody, and treats persisted quota outcomes as scheduling waits without source classification.
- `src/ops-worker/pi-attempt.ts` correctly turns a real provider quota response into a held, reset-aware, resumable wait. That post-attempt behavior must remain active for every source.
- Production already contains one unclaimed operational task with a persisted pre-launch quota telemetry outcome. The fix must make that existing task runnable after upgrade, including legacy unclaimed admission wait/probe state, without weakening held runtime quota waits.
- Classification must consume only the validated package task's `source.kind`. Numeric priority, objective, evidence, steering, Alertmanager payload fields, and other free-form data cannot select the bypass.

## Validation Commands

```bash
node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 src/__tests__/ops-worker-supervisor.test.ts src/__tests__/ops-worker-pi-attempt.test.ts src/__tests__/ops-worker-task-store.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
git diff --check
git diff --stat main...HEAD
```

## Tasks

### Task 1: Define the trusted source-kind admission boundary

- [x] Add a minimum-sufficient package-owned source-kind classifier in `src/ops-worker/types.ts` that returns admission-required only for `registered-cron` and `authorized-issue`; do not derive policy from priority or task payload fields.
- [x] Add focused tests covering all five source kinds and preserving fixed source-priority/task parsing rejection so priority or free-form field manipulation cannot select the operational path.
- [x] Keep the task schema and source-kind set unchanged; no migration, new policy framework, configuration toggle, or issue #61 quota-model work.
- [x] Run the focused type/task-store tests before proceeding.

### Task 2: Separate initial admission from held runtime quota recovery

- [x] Update `src/ops-worker/supervisor.ts` so unclaimed operational tasks bypass quota admission at scheduler selection, `claimNextTask`, `ensureTaskCustody`, and the atomic custody mutation while background tasks retain current fail-closed checks and exact proof requirements.
- [x] Normalize only legacy unclaimed operational admission outcomes/proofs during the successful authorized custody claim so a persisted `QUOTA_ADMISSION_WAIT`, admission-time `QUOTA_TELEMETRY_ERROR`/`QUOTA_PROBE_ERROR`, `QUOTA`, or `QUOTA_PROBE_PASS` cannot trap the upgraded task; preserve evidence/journal integrity and never clear a held runtime quota wait.
- [x] Keep quota scheduling active for held tasks after a real provider quota response, regardless of source, so authoritative reset waits, exact smoke probes, rolling resets, and resumable custody continue unchanged.
- [x] Update `src/ops-worker/pi-attempt.ts` only where needed so unclaimed operational legacy probe state cannot trigger proof preparation or pre-launch wait rejection, while background proof binding and runtime response classification remain fail-closed.
- [x] Add table-driven supervisor/Pi-attempt regression coverage for all three operational sources under low, missing/malformed, stale, resetless, and contradictory admission decisions; cover initial and repeated custody fences plus persisted legacy admission wait/probe state.
- [x] Add regression coverage proving both background sources remain not-admitted under the same decisions, fresh proof mismatch still fails closed, authorization still revalidates before custody, and an operational task's actual provider quota response remains held/resumable and uses the existing reset-aware probe path.
- [x] Run the focused supervisor, Pi-attempt, quota, authorization, lifecycle, and task-store suites before proceeding.

### Task 3: Document and validate the bounded correction

- [ ] Update `docs/ops-worker.md` to distinguish background initial admission from all-source post-attempt quota recovery, and add a concise `CHANGELOG.md` Unreleased entry for #113.
- [ ] Run every validation command above, verify the worktree is clean after commits, and confirm `git diff --stat main...HEAD` is exactly the scope reviewed by Ralphex.
- [ ] Leave release, private deployment/restart, existing-task progression, dedicated Ops report verification, issue/task closure, and the separately gated outage drill to the parent full-cycle custodian.
