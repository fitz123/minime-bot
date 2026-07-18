# Issue #58 — ADR-094 ops-worker core supervisor

## Goal

Implement **PR 1 only** from the approved ADR-094 plan: an opt-in, inactive-by-default TypeScript core for one ordinary Pi ops worker and one small durable supervisor. This PR does not add the Alertmanager route, Telegram reporting, production launchd/config, private workspace, release, drill, or legacy deletion.

Primary issue: https://github.com/fitz123/minime-bot/issues/58
Required deferred consumer: https://github.com/fitz123/minime-bot/issues/70
Approved architecture: ADR-094 (external architecture record; not packaged)
Governance: ADR-094 supersedes ADR-086; ADR-092 applies to delegated model context.

## Non-negotiable boundaries

- Minimum sufficient implementation; no verifier service, broker, SQLite, leases/generations/fencing, capsule/release slots, root helper, adaptive modes, generic workflow engine, or custom Pi transcript/session-binding protocol.
- Task snapshot JSON is authoritative. JSONL is audit only.
- Pi exit/completion is only a claim. Only a named deterministic `done_check=PASS` may mark `DONE`.
- Checks are tri-state: `PASS`, `ACTION_REQUIRED`, `DEFER`; check execution error is resumable, not proof of task failure.
- Use standard sessions supported by the pinned Pi package. Trace exact CLI/session behavior in installed Pi source before coding and capture that contract in tests. Do not use `--no-session`.
- One supervisor process owns at most one active Pi process group. It may terminate only a process group whose persisted identity it can prove; ambiguity becomes `BLOCKED`.
- Payload/evidence cannot choose shell commands, arbitrary executables, URLs, or authorization profiles.
- No production activation or package deploy. Keep all existing recovery code during coexistence.
- Account for #70 as a future adapter: core source/authorization/priority/task contracts must not block durable multi-enqueue and globally serialized full-cycle work later. Do not implement its issue scanner, release workflow, quota admission, or generic queue in PR 1, and do not import #70's superseded SQLite/lease/generation assumptions.
- Public examples/tests contain no private paths, IDs, destinations, or secrets.

## Validation

Run focused tests during tasks. Before completion run:

```bash
npm test -- --test-name-pattern='ops worker'
npm run lint
npm run build
npm pack --dry-run
```

If Node's test argument forwarding does not support the focused command, run the exact new ops-worker test files with the repository's existing Node/tsx flags, then run full `npm test` asynchronously before final completion.

## Tasks

### Task 1: Define the strict task contract and durable atomic store

- [x] Add `src/ops-worker/types.ts` with schema-versioned task envelopes covering source identity (`kind`, `correlationKey`, `template`), fixed numeric priority, bounded evidence, authorization profile reference with optional snapshot hash, fixed states, remediation/infrastructure counters, schedules, standard-session metadata, active process-group identity, last outcome, and report state required by ADR-094 PR 1.
- [x] Add strict runtime validation that rejects unknown/oversized/unsafe fields rather than trusting TypeScript types. Task input cannot supply commands, executables, URLs, or arbitrary authorization profiles.
- [x] Add `src/ops-worker/task-store.ts`: one `tasks/<id>.json` authoritative snapshot per task, same-directory temporary file, file fsync, atomic rename, directory fsync, and bounded append-only `journal.jsonl` audit after the snapshot. Recover from a snapshot even when the journal tail is missing or truncated.
- [x] Add traversal/symlink/duplicate-correlation protections and tests for crash boundaries, malformed snapshots, atomic replacement, and journal non-authority. Do not add a database or second state owner.

### Task 2: Implement state transitions and deterministic done-check authority

- [x] Add `src/ops-worker/done-checks.ts` with a closed named registry, strict per-check parameter validation, bounded timeout/output, and tri-state results `PASS`, `ACTION_REQUIRED`, `DEFER`. PR 1 ships the registry plus test-registered fixture checks only; production check implementations land in PR 2. Use dependency injection in tests; no shell and no payload-selected executable/URL.
- [x] Add `src/ops-worker/supervisor.ts` with a single-instance guard, deterministic scheduler selection, fixed priority ordering, remediation budget, resumable infrastructure outcomes, startup reconciliation, and durable transitions.
- [x] Enforce that `DONE` is reachable only after a fresh `PASS`; Pi success followed by `ACTION_REQUIRED` returns check evidence to the same task and queues/resumes it; `DEFER` schedules a later check without spending remediation budget; check errors become resumable.
- [x] Cover illegal transitions, restart recovery, duplicate/correlation behavior needed by the core, budget exhaustion to `BLOCKED`, and report-state persistence. Do not implement Alertmanager or Telegram behavior in this PR.

### Task 3: Launch and resume one standard Pi session in one owned process group

- [x] Add `src/ops-worker/pi-attempt.ts`. First trace the pinned Pi CLI/session implementation and use only its ordinary supported session-directory/create/resume behavior; record code citations in the implementation/task notes or tests.
- [x] Spawn Pi through the package-owned invocation resolver (`resolvePackageOwnedPiInvocation`, `src/pi-runtime.ts`) and reuse or extract the existing spawn-environment hardening and result-classification helpers from `src/pi-rpc-protocol.ts` and `src/cron-runner.ts` where suitable instead of duplicating them. Use no shell and one owned process group, bounded stdout/stderr evidence, and persist identity (PID, process group, start time) sufficient to avoid PID-reuse kills. Do not allow task payload to alter executable/model/provider/tool flags.
- [x] Implement bounded TERM/KILL for an unambiguously owned group, higher-priority preemption to `RESUMABLE`, restart reconciliation, and standard-session continuation. If ownership is ambiguous, do not signal and mark `BLOCKED`.
- [x] Classify quota/network/context overflow/crash as resumable without spending remediation budget; preserve the same standard session where valid. Quarantine a corrupt session and create a fresh standard session with bounded loss-of-context evidence.
- [x] Test with a fake Pi executable/process fixture: exit success but failed check, check pass without a success claim, crash/resume, preemption, context/quota classification, corrupt-session quarantine, ambiguous orphan, and exactly one active process group.

### Task 4: Add inactive-by-default CLI/API skeleton and complete package validation

- [x] Integrate a `worker` command group into `src/cli.ts` with the minimum PR-1 surfaces needed to start the local supervisor and inspect/submit/retry/cancel core tasks. Inputs select only registered task templates, authorization profiles, and done checks; no arbitrary command/URL fields.
- [x] Add the smallest loopback health/status endpoint skeleton only; no HTTP task-intake route in PR 1 — authenticated intake is PR 2, and PR-1 task submission happens only via the CLI. The package must never start the worker merely because the bot starts or the package is installed.
- [x] Add concise `docs/ops-worker.md` documentation that labels Alertmanager/reporting/production rollout as PR 2 or later; add example fixtures only if a PR-1 test consumes them, placeholders only.
- [x] Add metrics/state inspection only where required to test the core; defer production telemetry/report transport and the 24-case fault lab to PR 2.
- [x] Add `dist/ops-worker/**` to `package.json` `files`; run focused and full validation plus `npm run check:schema-guard-contract`, `node dist/cli.js --help`, and `npm run workspace:validate -- --workspace test-fixtures/minimal-workspace`; verify the npm tarball contains intended worker artifacts and no private data; compare Ralphex diff scope to `git diff --stat main...HEAD`; and commit all completed tasks.
