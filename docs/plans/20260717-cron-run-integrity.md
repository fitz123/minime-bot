# Cron Run Integrity: Test Isolation, Durable Delivery, Safe Launchd Sync

## Overview

Implement issues #76, #65, and #62 for `fitz123/minime-bot` as one coherent batch around
cron execution and lifecycle safety. Issue acceptance bullets are guidance; this plan
solves the observed problems with the minimum sufficient mechanism (ADR-094) and is the
authoritative scope.

- **#76** — cron-runner tests reach ambient production paths: `LOG_DIR` is captured at
  module import time, so tests hitting the module-level `log()` append to the real
  `~/.minime/logs/cron-*.log` on the machine that also runs production. Fix: call-time
  env resolution plus a shared test-env helper. Not a package-wide harness rewrite.
- **#65** — a transient generation or delivery failure silently loses a scheduled
  user-facing result: `main()` discards generated output when `deliver()` fails, and a
  generation-failure notification dies in the same outage. Fix: a short in-process
  retry, then one durable single-slot pending record per cron, redelivered at the start
  of that cron's next scheduled invocation. The pending record has priority: a run that
  cannot redeliver it — or cannot read its state — exits before generation, so an owed
  result is never overwritten by a newer one. Generation is never re-executed;
  already-generated output (`kind: "output"`) is distinguished from a generation-failure
  notice (`kind: "failure-notice"`). Satisfies ADR-087 without a queue, broker, sweeper,
  or workflow engine.
- **#62** — `syncLaunchdCrons()` boots out `update`/`delete` items unconditionally,
  killing an actively running cron mid-generation, and the immediate `bootstrap` can
  race launchd's asynchronous removal. Fix: classify activity via `launchctl print`
  before any mutation and defer active or unknown-state items — only a provably idle or
  not-loaded job is mutated (sync converges on a later run) — plus a bounded retry for
  transient failures on both the replacement and rollback bootstraps. Issue #62's
  original "wait for exit then bootout" wording predates ADR-087; deferral is the
  reconciled behavior — sync never destroys active work.

Order: #76 first (the #65 tests exercise exactly the leaking paths), then #65 (Tasks
2-3), then #62, then acceptance and docs. Excluded: #63, #86, #58, #70, #79, #84 (other
workstreams).

## Context

Verified against the current worktree (`origin/main` @ `991ef54`):

- `src/cron-runner.ts` (943 lines) — `LOG_DIR` import-time constant (line 48); `log()`
  starts at 149; `deliver()` starts at 475 and flattens `execFileSync` failures to
  `new Error("Delivery failed: ...")`, dropping structured `status`/`code`/`stderr`;
  `handleDeliveryFailure()` starts at 429; async `main()` with full
  `CronRunnerMainDeps` injection starts at 816; failure-notification delivery is around
  895-902 and output delivery around 923-930; `writeAtomicTextFile()` starts at 176;
  `writeCronHealthMetric()` starts at 186 and resolves
  `CRON_HEALTH_TEXTFILE_DIR` per call; `shortStableHash()` /
  `sanitizeCronMetricStem()` are unexported at 157-165.
- `src/workspace-contract.ts` — `resolveWorkspaceContract()` honors
  `MINIME_CONTROL_WORKSPACE_ROOT`; `paths.dataDir` is `<controlWorkspaceRoot>/data`.
  Production cron plists inject `MINIME_CONTROL_WORKSPACE_ROOT`, `LOG_DIR`, `HOME`
  (`renderLaunchdCronPlist()`, 229-240), so the outbox dir resolves correctly in
  production and is env-overridable in tests.
- `scripts/deliver.sh` — `set -euo pipefail`; network failures propagate curl's exit
  code; Telegram API rejections exit 1 with `[deliver] Error: sendMessage failed:
  <json>` on stderr; pre-send validation exits 1 with fixed `[deliver] Error: invalid
  chat_id|invalid thread_id|empty message` strings.
- `src/launchd-cron-plists.ts` (1,011 lines) — `syncLaunchdCrons()` starts at 383
  with injectable `LaunchdCommandRunner`; unconditional delete bootout is at 403 and
  update bootout/bootstrap at 417-424; rollback bootstrap is at 426-436;
  `writeValidatedPlist()` / `restorePreviousPlist()` are at 860 / 881; rendered plists
  set `RunAtLoad=false` around 239; `LaunchdCronPlanItem` starts at 103;
  `formatLaunchdCronSyncResult()` starts at 443; dry-run returns before commands at
  389-391. Recent semantic-plist comparison changes are already in this baseline and
  remain untouched.
- Tests: `src/__tests__/cron-runner.test.ts` (2050 lines; `makeMainHarness()` at 1204
  stubs every `main()` dep but is typed `Partial<CronRunnerMainDeps>`; direct
  `handleDeliveryFailure` tests at 95-118 hit the real `log()`),
  `src/__tests__/cron-runner-pi.test.ts` (686 lines; no `LOG_DIR` isolation),
  `src/__tests__/launchd-cron-sync.test.ts` (1,483 lines; temp fixture +
  `captureRunner()` fake at 79; its explicit-runner and semantic-equivalence
  "unchanged ... without running commands" regressions must stay true).
- Focused test command (matches `npm test`):
  `MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/<file>.test.ts`
- ADR-087 (eventual delivery), ADR-094 (minimum-sufficient), ADR-088 (cron model —
  untouched). No PII in code/tests (fake chat IDs like `111111111`). Windows out of
  scope.

## Development Approach

- **Testing approach**: reproduce-first where the defect is directly reproducible (#76
  log redirection, #62 active-label bootout): write the failing test, then fix. #65 is
  new behavior: code and tests in the same task.
- Complete each task fully; run its focused tests before the next task.
- Reuse existing primitives: `writeAtomicTextFile` pattern, redaction helpers,
  `CronRunnerMainDeps` / `LaunchdCommandRunner` seams, existing fixture patterns.
- Backward compatible: exit codes, metric semantics, admin-fallback notification, CLI
  surface, and plist rendering unchanged except where a task explicitly extends them.
- **CRITICAL: every task MUST include new/updated tests** (success and error/edge) as
  separate checklist items.
- **CRITICAL: all tests must pass before starting the next task.**
- **CRITICAL: update this plan file when scope changes during implementation.**

## Testing Strategy

- **Unit tests** (node test runner) in every task; focused runs via the command in
  Context.
- **#76 sentinels**: `src/__tests__/cron-runner-isolation.test.ts` proves ambient paths
  are resolved at call time by redirecting env to two successive temp dirs and asserting
  writes follow the redirection and the first dir gains nothing.
- **#65 state tests**: drive `main()` through the full-stub harness with failing fake
  `deliver`; assert on-disk records and log evidence across consecutive `main()` calls
  (each call is one process lifetime, so consecutive calls model restart safety).
- **#62 fake-launchctl tests**: extend `captureRunner()` to script `launchctl print`
  responses (active pid / not loaded) and transient `bootstrap` failures; no real
  `launchctl`.
- **Packaging/integration**: full suite, `npm run build`, `npm run lint`,
  `npm pack --dry-run` in the acceptance task. No e2e UI tests exist in this project.

## Progress Tracking

- Mark completed items with `[x]` immediately when done
- Add newly discovered tasks with ➕ prefix
- Document issues/blockers with ⚠️ prefix
- Update plan if implementation deviates from original scope
- Keep plan in sync with actual work done

## What Goes Where

- **Implementation Steps** (`[ ]` checkboxes): code, tests, and repo docs achievable in
  this repository by the executing agent. Checkboxes appear only inside `### Task N:`
  sections.
- **Post-Completion** (no checkboxes): PR/release/deploy lifecycle and production
  observation — external to this plan.

## Implementation Steps

### Task 1: Isolate cron-runner tests from ambient production paths (#76)

- [ ] In `src/cron-runner.ts`, replace the import-time `LOG_DIR` constant with an
  exported `resolveCronLogDir()` that reads `process.env.LOG_DIR` at call time, treating
  unset or blank as the unchanged fallback `join(homedir(), ".minime", "logs")`; use it
  inside `log()`. Production behavior is unchanged (cron plists always set `LOG_DIR`).
- [ ] Add `src/__tests__/cron-test-env.ts` exporting `installCronTestEnv()`: called at
  test-file top level, it eagerly creates a `mkdtempSync` root, saves and sets
  `LOG_DIR`, `CRON_HEALTH_TEXTFILE_DIR`, and `MINIME_CONTROL_WORKSPACE_ROOT` to subdirs
  of that root, registers a node:test `after()` that restores/deletes the saved env and
  removes the root, and returns `{ root, logDir, metricsDir, controlRoot }`.
- [ ] Call `installCronTestEnv()` at the top of `src/__tests__/cron-runner.test.ts` and
  `src/__tests__/cron-runner-pi.test.ts` so every existing test (including
  `handleDeliveryFailure` and real `runPi()` paths) writes only under the temp root.
- [ ] Make the harness fail-closed: type the deps object built by `makeMainHarness()` in
  `src/__tests__/cron-runner.test.ts` as a complete `CronRunnerMainDeps` (it already
  stubs every dep) so a future dep added to `main()` cannot silently fall back to a
  production-touching default in tests.
- [ ] Write `src/__tests__/cron-runner-isolation.test.ts`; write the log-redirection
  test first and confirm it fails against the import-time-captured `LOG_DIR`: (a)
  `log()` writes driven through `handleDeliveryFailure` (no-op deliver fn) land in temp
  dir A, then after changing `process.env.LOG_DIR` land in temp dir B while A gains no
  new files; (b) same A/B assertion for `writeCronHealthMetric()` and
  `CRON_HEALTH_TEXTFILE_DIR`.
- [ ] Write error-path test: `resolveCronLogDir()` with unset and with blank `LOG_DIR`
  returns the home fallback (pure path assertion — do not write there).
- [ ] Run focused tests (`cron-runner.test.ts`, `cron-runner-pi.test.ts`,
  `cron-runner-isolation.test.ts`) — must pass before Task 2.

### Task 2: Cron outbox primitive (#65)

- [ ] Create `src/cron-outbox.ts`: one durable single-slot pending-delivery record per
  cron. Move `sanitizeCronMetricStem()` and `shortStableHash()` here from
  `src/cron-runner.ts`, export them, and import them back in `cron-runner.ts` (one
  definition, no import cycle). Record path:
  `join(resolveWorkspaceContract().paths.dataDir, "cron-outbox", "<stem>.json")`.
- [ ] Define and export `CronOutboxRecord` (see Technical Details): `version: 1`,
  `cron`, `runId`, `kind: "output" | "failure-notice"`, `payload`, `chatId`,
  `threadId?`, `createdAt` (ISO), `attempts`.
- [ ] Implement `writeCronOutboxRecord(record)` (mkdir recursive + tmp+rename atomic
  write with the same dot-prefixed tmp naming as `writeAtomicTextFile`),
  `readCronOutboxRecord(cronName): CronOutboxRecord | "corrupt" | undefined` (missing
  file → `undefined`; unparseable JSON, wrong `version`, or non-string `payload` →
  `"corrupt"`; never throws), and `clearCronOutboxRecord(cronName)` (idempotent unlink).
- [ ] Write tests `src/__tests__/cron-outbox.test.ts` (success): round-trip
  write/read/clear under a temp `MINIME_CONTROL_WORKSPACE_ROOT` (via
  `installCronTestEnv()`); no stray tmp files after write; stem collision-safety for
  exotic cron names sharing a sanitized prefix.
- [ ] Write tests (error/edge): malformed JSON → `"corrupt"`; wrong version →
  `"corrupt"`; missing dir auto-created on write; clear of nonexistent record is a
  no-op; read with no outbox dir → `undefined`.
- [ ] Run focused tests (`cron-outbox.test.ts` plus Task 1 files) — must pass before
  Task 3.

### Task 3: Wire durable delivery into the cron run (#65)

- [ ] In `src/cron-runner.ts`, make `deliver()` throw an exported `DeliveryError`
  (extends `Error`) carrying `status` (child exit code), `code` (spawn error code such
  as `ETIMEDOUT`), and `stderrExcerpt` (sanitized via `sanitizeCapturedOutput`, first
  400 chars). Keep the exact existing `Delivery failed: ...` message text.
- [ ] Add exported `isQueueableDeliveryFailure(err: unknown): boolean` — `false` only
  for a `DeliveryError` with `status === 1` whose `stderrExcerpt` matches
  `/\[deliver\] Error: (invalid chat_id|invalid thread_id|empty message)/` (deliver.sh
  pre-send validation: provably non-retryable config errors); `true` for everything else
  (timeouts, curl exit codes, Telegram API rejections, token-load failures, unknown).
  Trade-off documented in Technical Details.
- [ ] Add constants `CRON_DELIVERY_RETRY_DELAYS_MS = [5_000, 30_000]`,
  `CRON_OUTBOX_MAX_ATTEMPTS = 10`, `CRON_OUTBOX_EXPIRY_MS = 48 * 60 * 60 * 1000`, and
  `runId` format `` `${cronName}@${new Date().toISOString()}#${process.pid}` `` computed
  once at run start. Module constants only — no new config schema fields.
- [ ] Extend `CronRunnerMainDeps` with `sleep(ms)` (default `setTimeout` from
  `node:timers/promises`), `readCronOutboxRecord`, `writeCronOutboxRecord`,
  `clearCronOutboxRecord` (defaults from `cron-outbox.ts`); update `makeMainHarness()`
  (now fail-closed, so compilation forces the additions).
- [ ] Add a `deliverWithRetry` helper inside `main()`'s flow: attempt `deps.deliver`,
  and on failure retry after each delay in `CRON_DELIVERY_RETRY_DELAYS_MS` (awaited
  `deps.sleep`); rethrow the final error.
- [ ] Add fail-safe outbox pickup in `main()` after `loadCronTask`/`loadAdminChatId`
  and before generation. Read this cron's record: `"corrupt"` → clear + log
  `OUTBOX TERMINAL corrupt`, then continue; expired (`now - createdAt >
  CRON_OUTBOX_EXPIRY_MS`) or `attempts >= CRON_OUTBOX_MAX_ATTEMPTS` → clear + log
  `OUTBOX TERMINAL gave-up runId=<id> attempts=<n>` + one best-effort try/catch admin
  notice, then continue; valid record → attempt one `deps.deliver` of its exact payload.
  On success, clear + log `OUTBOX REDELIVERED runId=<id> attempts=<n>` and continue.
  On queueable redelivery failure, atomically rewrite `attempts + 1`, log
  `OUTBOX RETRY-DEFERRED runId=<id> attempts=<n>`, write the existing failure health
  metric, and `deps.exit(1)` before generation. On a thrown/unknown outbox read, log
  `OUTBOX STATE-READ-FAILED`, write the failure metric, and `deps.exit(1)` before
  generation so an unknown owed result cannot be overwritten. A non-queueable pending
  delivery failure clears with `OUTBOX TERMINAL deterministic` + one best-effort admin
  notice, then continues.
- [ ] Route both outbound failure points through queueing, keeping the existing
  `handleDeliveryFailure` + failure metric + exit-1 behavior unchanged afterward: (a)
  output delivery and (b) generation-failure notification use `deliverWithRetry`; if the
  final error is queueable, first re-read the slot and write the new `"output"` or
  `"failure-notice"` record only when it is still empty, then log `OUTBOX QUEUED
  runId=<id> kind=<kind>`. If a record unexpectedly exists, preserve it, log
  `OUTBOX QUEUE-SKIPPED pending-existing`, and fail the current run without overwrite.
  If the delivery error is non-queueable, do not queue.
- [ ] Write tests (success paths): transient output-delivery failure retries in-process
  (assert sleep delays) then queues a record with correct fields; a second `main()` run
  redelivers the pending payload before generating, clears the record, then delivers its
  own output (order asserted); failure-notice path queues the same way; in-process retry
  succeeding on attempt 2 leaves no record; NO_REPLY and empty-output runs still perform
  pickup and queue nothing.
- [ ] Write tests (error/edge paths): non-queueable validation failure does not queue;
  pickup terminal paths (gave-up via attempts, gave-up via expiry, corrupt, deterministic)
  clear the record, log exact evidence, and send the admin notice where specified;
  queueable pickup failure persists `attempts + 1`, writes a failure metric, exits 1,
  and proves neither `runScript` nor `runPi` ran; thrown/unknown outbox read likewise
  exits before generation; an unexpected existing record at queue time is preserved;
  table-driven `isQueueableDeliveryFailure` cases cover every class above.
- [ ] Run focused tests (`cron-runner.test.ts`, `cron-outbox.test.ts`,
  `cron-runner-isolation.test.ts`) — must pass before Task 4.

### Task 4: Safe launchd cron sync around active jobs (#62)

- [ ] In `src/launchd-cron-plists.ts`, add `getCronJobActivity()` returning
  `"active" | "idle" | "not-loaded" | "unknown"`. Call the injected runner directly
  (bypassing `runCommand`'s throw-on-failure) with
  `["print", "<domain>/<label>"]` and record the call in `commands`: exit 0 plus
  `/^\s*pid = \d+/m` → `active`; exit 0 without a pid → `idle`; non-zero with the
  known launchctl not-found signature (`Could not find service`) → `not-loaded`; every
  other non-zero result, runner `error`, or missing output → `unknown`.
- [ ] In `syncLaunchdCrons()`, before any mutation of an `update` or `delete` item,
  check activity. For `active` or `unknown`, skip all mutations for that item (no plist
  write, bootout, or unlink), set `deferredReason` accordingly, and continue with the
  remaining items. Only `idle` and `not-loaded` are safe to mutate. `unchanged` items
  keep skipping everything (zero commands); dry-run keeps its existing early return.
- [ ] Add `deferredReason?: "active" | "unknown"` to `LaunchdCronPlanItem`; in
  `formatLaunchdCronSyncResult()`, print `deferred <label> (active job running)` or
  `deferred <label> (activity unknown)` and append `, deferred N` to the summary. Exit
  behavior remains 0 because deferral is a reported convergent state; no CLI changes.
- [ ] Handle the bootout→bootstrap removal race with one `bootstrapWithRetry()` helper
  reused for both the replacement plist and `restorePreviousPlist` rollback bootstrap.
  Record every attempt in `commands`; on failure whose stderr/stdout matches
  `/in progress|already loaded|already bootstrapped|input\/output error/i`, retry after
  `sleep(500)` up to 5 total attempts. A final replacement failure enters rollback; a
  final rollback failure leaves the restored previous plist contents on disk and throws
  one actionable error containing both the replacement and rollback evidence. Add
  `SyncLaunchdCronsOptions.sleep?: (ms: number) => void` (default synchronous
  `Atomics.wait` on a throwaway `SharedArrayBuffer`; `syncLaunchdCrons` stays sync).
- [ ] Extend the `captureRunner()` fixture in
  `src/__tests__/launchd-cron-sync.test.ts` to script `print` responses; write the
  deferral tests first against current behavior to prove they fail: update/delete while
  active defer with no mutation; exit-0 without pid and known not-found proceed; unknown
  non-zero, runner error, and missing output defer fail-safe.
- [ ] Write bootstrap tests: transient replacement failure retries then succeeds;
  replacement failure followed by transient rollback failure retries rollback then
  succeeds; persistent rollback failure preserves the previous plist contents and
  reports combined replacement+rollback evidence with bounded attempt/sleep counts.
- [ ] Preserve regressions: dry-run and unchanged items run zero commands; deferred
  items appear in formatted output with reason/count; idle jobs sync as before.
- [ ] Run focused tests (`launchd-cron-sync.test.ts`) — must pass before Task 5.

### Task 5: Verify acceptance criteria

- [ ] Verify #76: sentinel tests pass; spot-check that temporarily reverting
  `resolveCronLogDir()` to import-time capture makes the sentinel fail, then restore.
- [ ] Verify #65 against ADR-087: run identity persisted; generation vs delivery failure
  distinguished (`kind`); output preserved across retries without regeneration; bounded
  attempts + expiry; queueable pending/unknown state blocks new generation; no path
  overwrites an existing owed record; terminal/retry evidence is explicit; single slot
  per cron prevents unbounded growth; at-least-once crash window is documented.
- [ ] Verify #62: no code path issues `bootout` unless activity is proven `idle` or
  `not-loaded`; active/unknown states defer visibly; the same bounded helper covers
  replacement and rollback bootstrap; final rollback failure preserves previous plist
  contents and reports combined evidence.
- [ ] Run the full suite: `npm test`; then `npm run build` and `npm run lint`.
- [ ] Run `npm pack --dry-run` (new `dist/cron-outbox.*` ships), plus
  `npm run check:schema-guard-contract` and
  `npm run workspace:validate -- --workspace test-fixtures/minimal-workspace`.
- [ ] Review `git diff --stat main...HEAD`: changes confined to `src/cron-runner.ts`,
  `src/cron-outbox.ts`, `src/launchd-cron-plists.ts`, `src/__tests__/*`, `docs/*`,
  `README.md`, `CHANGELOG.md`.

### Task 6: Update documentation

- [ ] `README.md` (`## Launchd Operations` cron parts): durable delivery behavior —
  pickup-first order, single slot per cron, 10 attempts / 48h expiry, `OUTBOX` log
  evidence in `cron-<name>.log`, at-least-once semantics, and the honest limits from
  Technical Details.
- [ ] `docs/launchd-operations.md` ("Cron launchd sync"): active-job deferral semantics,
  convergence by re-running sync after the job finishes, bounded bootstrap retry.
- [ ] `CHANGELOG.md` `## Unreleased`: one entry per issue (#76 test isolation, #65
  durable cron delivery, #62 safe sync deferral).

## Technical Details

**Outbox record** (`<dataDir>/cron-outbox/<stem>.json`, atomic tmp+rename, single slot
per cron):

```json
{
  "version": 1,
  "cron": "daily-report",
  "runId": "daily-report@2026-07-17T09:00:01.234Z#4242",
  "kind": "output",
  "payload": "<exact message text owed to the chat>",
  "chatId": 111111111,
  "threadId": 42,
  "createdAt": "2026-07-17T09:00:31.000Z",
  "attempts": 0
}
```

Expiry is derived at read time (`createdAt + CRON_OUTBOX_EXPIRY_MS`); `attempts` counts
failed redelivery attempts by later runs. launchd serializes runs per label, so each
record has exactly one writer at a time.

**State transitions** (all by the one-shot runner for its own cron only): *queued*
(final in-process retry failed and the slot is empty → write), *redelivered* (pickup
succeeds → clear + evidence, then generate), *retry-deferred* (pickup fails queueably →
rewrite `attempts + 1`, fail the current invocation, and return before generation), and
*terminal* (gave-up via attempts/expiry, deterministic redelivery failure, or corrupt →
clear + `OUTBOX TERMINAL ...` evidence and the specified best-effort admin notice).
Unknown read state also fails before generation. There is no supersession transition:
an unexpected occupied slot is preserved, never overwritten.

**Crash safety and honest limits (at-least-once)**: every run starts from disk state, so
process death leaves either no record, a valid record (redelivered next run), or an
ignored dot-prefixed tmp file. The only duplicate-delivery window is a crash between
Telegram accepting the send and `clearCronOutboxRecord()`; multi-chunk messages share
the caveat. Receipt-based dedup is rejected as speculative (ADR-094). Records of crons
later removed or disabled are never picked up again; they remain inert, inspectable
files. No dedicated pending-age metric: the failed run already reports through
`minime_cron_last_exit_code` and the admin notice, and the record file plus `OUTBOX`
log lines are the durable evidence.

**Delivery classification trade-off**: only deliver.sh pre-send validation errors (fixed
`[deliver] Error:` strings, exit 1) are provably deterministic, so only those skip
queueing. Telegram API rejections are not JSON-parsed: a deterministic 4xx burns at most
`CRON_OUTBOX_MAX_ATTEMPTS` cheap redelivery attempts before terminal discard — a few
wasted attempts in exchange for no response-parsing machinery, while a genuine outage
(the observed production case) always queues. Token-load failures carry no child
`status` and therefore queue, correct for transient SOPS/keychain hiccups. Generation is
never retried: LLM re-runs cost quota and script crons may have side effects; the next
scheduled run regenerates naturally, and a generation failure's user-facing notice gets
the same durable path (the exact compound failure behind ADR-087).

**Launchd sync deferral and bootstrap**: `launchctl print gui/<uid>/<label>` with exit
0 and `pid = <n>` is active; exit 0 without pid is loaded-idle; only the known not-found
signature proves not-loaded. Every other non-zero/error/missing-output result is unknown.
Active and unknown states defer without touching plist or service; idle/not-loaded may
sync. A deferred item keeps its previous plist and loaded job intact and converges on a
later sync. Honest limit: until that later sync the old schedule stays live; nothing
re-runs sync automatically. One bounded transient-aware helper bootstraps both the
replacement and any restored previous plist. If rollback bootstrap also exhausts, the
previous plist contents remain on disk and the thrown error preserves both failure
causes.

**Rollback/compatibility**: no config/crons schema changes, no CLI changes, no new
required env vars; `data/cron-outbox/` is created on first queue. Reverting the release
restores today's best-effort behavior; leftover records become inert files. Exit codes,
metrics, admin-fallback notification, and plist rendering are unchanged — a run that
queued its output still exits 1 with a failure metric (alerting stays truthful until
the user actually receives the result).

**Non-goals**: no generic queue/broker/workflow engine, SQLite, leases/fencing, or
recovery-supervisor integration; no retry daemon/sweeper (recovery rides only the next
scheduled invocation of the same cron); no generation retry; no Telegram receipt
dedup; no pending-age gauge; no per-cron outbox config; no `--wait-active` or other CLI
additions; no forced-kill requeue in sync; no cross-cron outbox processing or GC; no
package-wide test-harness rewrite; no changes to interactive-session delivery paths.

## Post-Completion

*Items requiring manual intervention or external systems — informational only.*

- Open a PR referencing #76, #65, and #62; standard review cycle (Copilot + CI).
  Release, deploy, and restart follow the standard package release flow outside this
  plan.
- After production deploy: simulate a delivery outage on a low-stakes cron and observe
  `OUTBOX QUEUED` → `OUTBOX REDELIVERED` across two scheduled runs; run
  `launchd crons sync` while a long cron is active and confirm deferral output plus
  convergence on re-run.
- If operations later show stuck pending records going unnoticed, consider a pending-age
  textfile gauge as a follow-up (deliberately excluded here).
