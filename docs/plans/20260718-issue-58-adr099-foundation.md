# ADR-099 Ops Foundation: Durable Custody and Lifecycle State

## Overview

Implement the first corrected ADR-099 foundation PR on top of the inactive ops-worker core from PR #92. This phase makes the existing JSON state model safe for later control-plane adapters by adding migration-safe lifecycle identity, delivery idempotency, atomic checkpoints/receipts, and exclusive whole-cycle custody.

The worker remains opt-in and inactive by default. This phase adds no transport listener, production task registry, runtime activation, external mutation executor, or multi-process scheduling. Fixed lifecycle slots may record repository, merge, tag/release, deploy, canonical-task, verifier, report, and tail-audit identity, but this PR performs none of those external actions.

Primary issue: https://github.com/fitz123/minime-bot/issues/58
Base source: `f419d13` (`origin/main` when this plan was prepared)

## Context (from discovery)

- `src/ops-worker/types.ts:1,207-226,911-914` accepts only exact schema v1 and has no resource, custody, lifecycle, checkpoint, or mutation-receipt fields.
- `src/ops-worker/task-store.ts:542-577` already provides atomic snapshot replacement under a cross-process mutation guard, but callers still read before `replace`; there is no read-modify-write callback under the same guard and no terminal-safe delivery replay key.
- `src/ops-worker/supervisor.ts:496-579` blocks a new process group only for `RUNNING` or an unresolved orphan. A delayed `CHECKING` or `RESUMABLE` task therefore does not retain custody.
- `src/ops-worker/pi-attempt.ts:900-956` preempts for a newly queued higher-priority task and marks the predecessor `RESUMABLE`, which currently allows cross-task handoff before terminal verification.
- `src/ops-worker/pi-attempt.ts:1758-1790` observes session/evidence artifact mtimes for liveness but not the authoritative task snapshot, so an atomic checkpoint in the task record would not yet count as progress.
- PR #92 behavior to preserve: strict task contracts, authoritative atomic JSON snapshots plus audit-only JSONL, standard Pi sessions, one proven process group, and fresh deterministic `PASS` as the only route to `DONE`.

## Development Approach

- **Testing approach:** TDD for each corrected incident and migration boundary.
- Complete each task fully and keep focused tests green before the next task.
- Keep the state model fixed and bounded. Do not add arbitrary phase graphs, command fields, callback registries, or a generic workflow engine.
- Reuse the existing atomic snapshot and mutation-lock implementation; do not introduce another state owner.
- Preserve strict parsing and fail closed on unknown future schema versions, conflicting idempotency replays, ambiguous process ownership, and malformed lifecycle evidence.
- Before Ralphex starts, revise and re-review this plan if scope changes. After launch, do not edit the active plan file.

## Testing Strategy

- Extend the existing ops-worker unit suites for schema migration, atomic store behavior, scheduling, process-group safety, CLI behavior, and package inactivity.
- Add one focused lifecycle-helper suite for checkpoint and receipt crash/idempotency semantics.
- Use cross-process fixtures only for store races that cannot be proven in-process.
- Keep public fixtures generic: no private paths, identifiers, destinations, or secrets.
- Run focused ops-worker tests after every task and the full package validation in the final task.

## Progress Tracking

- Ralphex owns execution progress; the active plan remains immutable after launch.
- Each task is one reviewable logical unit and includes its own regression tests.
- A newly discovered requirement outside this first-phase boundary is a blocker/follow-up, not silent scope expansion.

## What Goes Where

- Task checkboxes cover only package code, tests, and public documentation in this repository.
- Fixed lifecycle metadata records evidence; it does not execute domain workflow steps.
- Transport adapters, authorization/context parity, quota policy, composite production verification, runtime activation, and external rollout remain later phases.

## Implementation Steps

### Task 1: Add the migration-safe v2 task and lifecycle contract

- [x] Write failing cases in `src/__tests__/ops-worker-task-store.test.ts` for loading an exact v1 snapshot, deterministic v1-to-v2 normalization, strict v2 round-trip, rejection of unknown future versions/fields, and immutable normalized resource identity.
- [x] Update `src/ops-worker/types.ts` to make schema v2 the write format while accepting exact v1 snapshots through one explicit pure migrator; loading v1 must not mutate files, and the next successful write must persist canonical v2 exactly once.
- [x] Extend `OpsWorkerTaskSource` with a bounded adapter delivery key distinct from active `correlationKey`, add the dormant `operator-telegram` source kind at operator priority, and add a required normalized immutable resource identity with fixed `host`/`repository` kinds and lowercase namespaced keys such as `host:local` or `github:example/minime-bot`.
- [x] Add a small versioned `OpsWorkerLifecycleManifest` containing fixed optional identity slots for canonical task, repository/base/head/branch, pull request/merge, tag/release, deploy, verifier, report, and tail audit; add bounded current-checkpoint and fixed-boundary mutation-receipt records, plus explicit custody status/timestamps/release reason. Do not add arbitrary step names or executable data.
- [x] Define fail-safe v1 defaults: derive a unique legacy delivery key from the task id, derive a non-shareable legacy resource key, treat v1 `RUNNING`/`CHECKING`/`RESUMABLE` and ambiguous-orphan snapshots as held custody, map `QUEUED` to unclaimed custody, and map `DONE`/`CANCELLED`/genuine process-free `BLOCKED` to released custody; cover every mapping in tests.
- [x] Run `src/__tests__/ops-worker-task-store.test.ts` and keep all existing strict-validation tests passing before Task 2.

### Task 2: Make adapter submission and task mutation atomic and idempotent

- [ ] Write failing store tests in `src/__tests__/ops-worker-task-store.test.ts` and `src/__tests__/fixtures/ops-worker-store-create.ts` for concurrent read-modify-write, replay of the same delivery after terminal completion, conflicting reuse of one delivery key, and crash boundaries before/after snapshot rename.
- [ ] Add a bounded `OpsWorkerTaskStore.mutate(taskId, audit, callback)` primitive in `src/ops-worker/task-store.ts` that acquires the existing mutation guard before reading, validates immutable identity and global invariants, writes one atomic authoritative snapshot, and appends only best-effort audit afterward.
- [ ] Add idempotent create-or-return semantics keyed by immutable source delivery identity: an identical replay returns the existing task without another row or transition, while the same key with a different canonical submission fails closed. Keep `correlationKey` as active-episode deduplication rather than overloading it for delivery replay.
- [ ] Refactor store-owned identity checks so source delivery identity, normalized resource identity, and creation time cannot change through `replace` or `mutate`; enforce at most one held custody owner while under the same mutation guard.
- [ ] Preserve v1 read compatibility, journal non-authority, symlink/traversal protections, bounded files, and the existing no-database design; run the task-store tests before Task 3.

### Task 3: Add package-owned atomic checkpoints and fixed mutation receipts

- [ ] Create `src/__tests__/ops-worker-lifecycle.test.ts` with failing cases for idempotent checkpoint replay, conflicting checkpoint ids, receipt-without-fresh-query rejection, crash-after-mutation reconciliation by a repeated query, fixed boundary names, bounded identity evidence, and concurrent helper calls.
- [ ] Add `src/ops-worker/lifecycle.ts` with package-owned helpers that use `OpsWorkerTaskStore.mutate`: record one current checkpoint and update only fixed lifecycle identity slots; begin a query-before-mutate receipt; and finish only the matching operation/intent. Restrict receipts to `merge`, `tag-release`, `deploy`, `canonical-task`, and `report`; helpers record evidence only and never run commands or contact external systems.
- [ ] Make checkpoint and receipt writes replay-safe: identical operation/checkpoint ids plus identical canonical payloads are no-ops, mismatched reuse fails closed, and an unfinished mutation receipt requires a fresh query observation on resume before any repeat mutation can be claimed.
- [ ] Update `src/ops-worker/pi-attempt.ts` so the bounded attempt prompt includes the normalized resource, current lifecycle identity, and latest checkpoint/unfinished receipt summary; observe `tasks/<task-id>.json` in `latestObservableMtime` so package-owned checkpoints feed liveness without adding a heartbeat service.
- [ ] Update report bookkeeping in `src/ops-worker/supervisor.ts` to use fixed report identity/payload hashes and the same receipt semantics, without adding a report transport; run the lifecycle and Pi-attempt tests before Task 4.

### Task 4: Enforce one exclusive custody owner through verification and waits

- [ ] Add failing cases to `src/__tests__/ops-worker-supervisor.test.ts` and `src/__tests__/ops-worker-pi-attempt.test.ts` proving that delayed `CHECKING`, quota/network `RESUMABLE`, restart-reconciled `RESUMABLE`, and an interrupted owned attempt all block a queued successor; prove fresh `PASS`, `CANCELLED`, or genuine process-free `BLOCKED` releases custody, while an ambiguous orphan does not.
- [ ] Add an atomic supervisor custody claim used by `OpsWorkerPiAttemptRunner.runNext()` before either `RUN` or `CHECK`; if a held owner exists, the scheduler may return only that task when eligible and must return no successor while the owner is waiting.
- [ ] Preserve held custody across `RUNNING -> CHECKING`, `ACTION_REQUIRED -> RESUMABLE`, infrastructure/quota outcomes, shutdown reconciliation, and explicit owned-group interruption; release it only with the ADR-099 terminal conditions and persist every acquisition/release through the v2 snapshot.
- [ ] Remove queue-priority-driven cross-task handoff from `src/ops-worker/pi-attempt.ts` (`createPreemptionMonitor` / `findHigherPriorityReadyTask`) for this globally serial phase. Keep proven owned-group stop/reconciliation paths; do not implement recovery nesting, lanes, or a second active process group.
- [ ] Update startup reconciliation to fail closed on multiple migrated held owners and to resume the single proven owner before queued work; retain the unresolved-orphan global fence and run supervisor/Pi-attempt tests before Task 5.

### Task 5: Expose only the inactive helper surface and validate the package

- [ ] Extend `src/ops-worker/worker-cli.ts` and `src/cli.ts` with strict adapter-facing `--delivery-key` / `--resource-key` submission fields and package-owned checkpoint/receipt recording commands that mutate through the new atomic helpers; do not add Telegram, Alertmanager, arbitrary command, URL, or live-control routes.
- [ ] Extend `src/__tests__/ops-worker-cli.test.ts` for v1 inspection, v2 creation, idempotent submission replay, conflicting replay, checkpoint/receipt validation, and helper use while the supervisor owns the task; extend status assertions to expose at most one custody owner without leaking task evidence.
- [ ] Update `docs/ops-worker.md` and the existing README pointer to document schema migration, delivery-vs-correlation identity, custody, checkpoints, and receipt semantics while preserving the explicit opt-in/inactive-by-default contract.
- [ ] Run focused validation: `node --experimental-test-module-mocks --import tsx --test src/__tests__/ops-worker-task-store.test.ts src/__tests__/ops-worker-lifecycle.test.ts src/__tests__/ops-worker-supervisor.test.ts src/__tests__/ops-worker-pi-attempt.test.ts src/__tests__/ops-worker-cli.test.ts`.
- [ ] Run final repository validation: `npm test`, `npm run lint`, `npm run build`, `npm pack --dry-run`, `npm run check:schema-guard-contract`, `node dist/cli.js --help`, `npm run workspace:validate -- --workspace test-fixtures/minimal-workspace`, and `git diff --check`; verify the package remains inactive unless `worker start` is explicitly invoked.

## Technical Details

### State ownership

- `tasks/<id>.json` remains authoritative; `journal.jsonl` remains bounded audit only.
- The existing file mutation guard remains the only cross-process serialization mechanism.
- Schema migration is pure-on-read and lazy-on-write. There is no bulk migrator, side database, or second state file.

### Identity and idempotency

- `deliveryKey` identifies one adapter delivery forever; replay returns the same task.
- `correlationKey` prevents concurrent duplicate work for one active episode and may be reused after a terminal task.
- `resource` is immutable scheduling identity, not a lane or lock.
- Lifecycle slots and mutation boundaries are closed enums. They cannot carry commands, executables, URLs, or arbitrary workflow steps.

### Custody

- Exactly one task may have held custody.
- Waiting does not release custody: `CHECKING` and `RESUMABLE` remain part of the same whole cycle.
- A blocked task releases custody only after it is genuinely process-free; ambiguous ownership remains a global fence.
- Priority still orders initial unheld claims. It does not switch owners mid-cycle in this phase.

### Checkpoint and receipt semantics

- A checkpoint is a bounded latest progress/resume record with stable idempotency identity and optional artifact reference.
- A mutation receipt records a fixed boundary, operation/intent hash, fresh query observation, and outcome evidence. If a crash leaves the outcome unknown, resume queries actual state again before deciding whether mutation is still needed.
- Receipts make side-effect reconciliation explicit; they do not execute or orchestrate the side effect.

## Success Criteria

- Existing v1 snapshots load deterministically and become canonical v2 only after a successful atomic write.
- Duplicate adapter delivery creates one task row, including replay after terminal completion.
- One started task retains custody across run/check/wait/resume and no queued successor can claim early.
- Checkpoints update liveness and resume context atomically.
- Fixed-boundary receipts support query-before-mutate and crash reconciliation without becoming a workflow engine.
- PR #92 process ownership, standard sessions, atomic snapshots, strict contracts, and fresh-PASS terminal authority remain intact.
- The package still starts no worker automatically and exposes no new transport listener.

## Post-Completion

None in this plan. Stop after repository validation with the implementation branch ready for the normal PR review flow.
