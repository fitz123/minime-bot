# Issue #166: Runtime identity, split-brain guard, and media-pipeline alerts

## Goal
Make a live-but-wrong or live-but-degraded bot observable without relying on endpoint liveness alone:

1. expose the serving process as `minime_bot_instance_info{user,home,slot,pid} 1`;
2. reject or loudly classify duplicate/foreign startup ownership with the stable marker `MINIME_STARTUP_GUARD_CONFLICT reason=<reason>` and `minime_bot_startup_conflicts_total{reason}`;
3. count terminal user-visible media failures as `minime_media_pipeline_errors_total{transport,media_type,stage}` and provide a Prometheus alert for a sustained error rate while `up` remains healthy.

The implementation must retain bounded metric labels, avoid token/path/error-detail disclosure, recover stale locks without PID-reuse mistakes, and preserve supervisor-driven rolling replacement. Fatal conflicts that happen before the contender owns the configured metrics port are necessarily diagnosed by the stable log plus target-down/missing-or-unexpected-identity monitoring; only conflicts observed by an already scrape-visible process (notably Telegram 409) can make that process's in-memory counter visible before restart.

## Non-goals
- Production usernames, home directories, release-slot names, ports, destinations, or expected-identity selectors; those belong in the private control repository.
- Changing media size limits, retry policy, transcription engines, Telegram/Discord user messages, session behavior, or Ops-worker monitoring.
- Process-table token discovery, signals to competing processes, automatic deletion of foreign-owned media, or a second monitoring/notification service.
- Release, deployment, private Prometheus activation, production fault injection, issue closure, and terminal reporting; the parent lifecycle owns those after this public implementation passes review.

## Context
- `src/metrics.ts` serves liveness-shaped metrics and currently retries `EADDRINUSE`; a scrape can therefore remain healthy against the old or foreign listener without identifying it.
- `src/bot-startup.ts` recognizes Telegram 409 conflicts and retries them, but exports no duplicate-polling signal.
- `src/media-store.ts` hardens the shared media root only when a message allocates media. A foreign owner can therefore produce repeated per-message `EACCES` rather than one startup diagnosis.
- `src/telegram-bot.ts` and `src/discord-bot.ts` already reduce media errors to bounded stages at terminal handler catch boundaries, which are the correct exactly-once counting points after internal download retries are exhausted.
- `src/cron-runner.ts` already demonstrates process-start-token validation for stale-lock recovery; the bot guard must use the same PID-reuse-safe principle rather than trusting `kill(pid, 0)` alone.
- `examples/monitoring/minime.rules.yml`, its promtool fixture, `src/__tests__/monitoring-rules.test.ts`, and `docs/monitoring.md` are the public monitoring contract.

## Decisions
- Add a focused runtime guard module instead of scanning all host processes. Acquire owner-only advisory locks for hashed bounded resource keys (the resolved media root and, when configured, a one-way Telegram-token fingerprint); never store or log either raw value. Acquire multiple locks in deterministic order and roll back already-acquired locks if a later acquisition fails.
- Put locks in a release-slot-independent owner namespace under the OS temporary root. Publish each lock with an atomic directory claim followed by nonce-bearing claim/owner entries and verify device/inode plus exact entries before treating acquisition as complete. A lock record includes PID plus an OS process-start identity when available. A matching live PID/start identity is a conflict; a dead or PID-reused same-owner complete record is recoverable. A recent incomplete current-owner claim waits/fails closed. An empty current-owner lock directory left by a crash immediately after `mkdir` is recoverable after a short grace period only when repeated owner-UID, device/inode, mtime, and still-empty checks prove it was not replaced. A later abandoned claim-only state is recoverable after the same grace only after its nonce, owner UID, device/inode, exact-entry, and replacement-race checks. Foreign-owned, unreadable, malformed-complete, or ownership-changing locks are never deleted by the contender. Release only the exact claim/inode still owned by the current process.
- Before transports start, inspect an existing media root with `lstat`: missing is allowed; symlink/non-directory/unreadable/foreign-UID states are startup conflicts. Do not create, chmod, recurse into, or remove the media tree during preflight.
- Replace unbounded metrics-address retry with an awaited bind result. `EADDRINUSE` is a `metrics_port_in_use` startup conflict and exits nonzero; launchd/systemd remains responsible for retry after an intentional overlap. This prevents a new process from serving users while silently leaving observability attached to another process. Any failed startup releases all claims it acquired.
- Hold all claims through the complete serving lifetime. Graceful shutdown stops Telegram polling/watchdog, Discord, queued/session/media work, and the metrics listener before releasing claims last; the process-exit hook is ownership-checked best effort only. A replacement may start only after the prior owner has quiesced, and an overlap must not mutate the old process or its media.
- Record each Telegram 409 attempt as `duplicate_telegram_polling` and use the same stable log marker. Existing bounded backoff remains unchanged so a short old-poller handoff can recover; persistent conflict still follows the existing restart path.
- Supported startup-conflict label values are a closed set: `instance_lock_held`, `foreign_media_owner`, `unsafe_media_root`, `metrics_port_in_use`, and `duplicate_telegram_polling`. Logs contain only the marker and bounded reason, never raw resource paths, identities, tokens, owner IDs, or errors.
- Resolve instance identity once at startup: OS username, OS home, explicit `MINIME_BOT_SLOT` when non-empty or the real basename of the process working directory, and decimal PID. Set one info series before binding metrics. Identity values are diagnostics intentionally exposed by the local metrics endpoint; they must not be copied into conflict logs.
- Count only terminal handler outcomes, once per failed handler execution after retry logic settles. The closed media types are Telegram `voice|photo|document|animation|video|video_note|audio|sticker` and Discord `image|voice`; pre-download declared-size rejections use stage `size-limit` and enter the same single counting boundary. Multi-attachment Discord messages count each independently failed attachment. This is process-local event counting, not durable deduplication across an upstream update replay. Do not label by chat/session/user/path/URL/error text.
- Public rules detect each UP `job,instance` target that lacks the identity metric and sustained media failures joined to that same healthy target. Fatal pre-bind conflict counters are not promised to be scrape-visible; their stable marker plus down/missing/unexpected identity is the detection path. Installation-specific expected user/home/slot matching is documented as an external rule responsibility and implemented only in the private control repository.

## Validation Commands
```bash
npm run test:file -- src/__tests__/runtime-guard.test.ts src/__tests__/metrics.test.ts src/__tests__/bot-startup.test.ts src/__tests__/media-store.test.ts src/__tests__/telegram-bot.test.ts src/__tests__/discord-bot.test.ts src/__tests__/monitoring-rules.test.ts
promtool test rules examples/monitoring/minime.rules.test.yml
npm test
npm run lint
npm run build
npm pack --dry-run --ignore-scripts
```

## Tasks

### Task 1: Export serving identity and enforce startup ownership [HIGH]

**Goal:** Give every scrape a concrete serving identity and make duplicate resource ownership fail or recover deterministically before conversational transports start.

**Serves:** Issue #166 asks 1 and 2: instance identity in metrics plus an in-process guard for duplicate polling, foreign media ownership, and foreign metrics-port ownership.

**Files:**
- Create: `src/runtime-guard.ts`
- Create: `src/__tests__/runtime-guard.test.ts`
- Modify: `src/metrics.ts`
- Modify: `src/media-store.ts`
- Modify: `src/main.ts`
- Modify: `src/__tests__/metrics.test.ts`
- Modify: `src/__tests__/media-store.test.ts`

- [ ] Implement injectable identity resolution, bounded startup-conflict types/recording, foreign/unsafe media-root preflight, deterministic owner-only resource locks, PID-start-aware stale recovery, ownership-checked release, and redaction-safe `MINIME_STARTUP_GUARD_CONFLICT` logging in `src/runtime-guard.ts`.
- [ ] Register and initialize `minime_bot_instance_info` and `minime_bot_startup_conflicts_total` in `src/metrics.ts`; make metrics startup await `listening` and reject `EADDRINUSE` as `metrics_port_in_use` instead of retrying indefinitely.
- [ ] Wire identity initialization, guard acquisition, media-root preflight, awaited metrics bind, graceful release, and fatal-start cleanup into `src/main.ts` before either transport starts; retain supervisor-compatible nonzero exit and existing shutdown semantics.
- [ ] Add deterministic synthetic tests for identity labels and slot override/fallback, no secret/resource values in conflict output, active lock rejection, dead/PID-reused complete-lock recovery, crash immediately after empty-directory creation and crash-between-claim/publication grace handling, foreign/malformed/replaced/raced lock refusal, partial multi-lock rollback, idempotent inode/nonce-checked release, media-root missing/safe/foreign/symlink cases, successful metrics bind, occupied-port failure, and startup-failure cleanup.
- [ ] Add a bounded lifecycle integration test proving an overlapping contender cannot disturb the serving owner, exits nonzero and releases partial claims, the old owner keeps its claims until polling/session/media/metrics teardown completes, and a supervisor-style retry can then bind and expose the replacement identity.
- [ ] Run the Task 1 focused tests and lint; all must pass before Task 2.

### Task 2: Instrument duplicate Telegram polling [HIGH]

**Goal:** Turn every Telegram 409 duplicate-poller signal into bounded telemetry and the same operator-searchable startup marker while preserving handoff retries.

**Serves:** Issue #166 ask 2 specifically names duplicate polling and rejects silent retry loops.

**Files:**
- Modify: `src/bot-startup.ts`
- Modify: `src/__tests__/bot-startup.test.ts`

- [ ] Record `duplicate_telegram_polling` exactly once for each caught 409 attempt before bounded backoff or final propagation, without counting non-409 failures or exposing grammY error details.
- [ ] Emit `MINIME_STARTUP_GUARD_CONFLICT reason=duplicate_telegram_polling` through the shared conflict recorder and retain the existing retry count, delay cap, and eventual error behavior.
- [ ] Add tests for first-attempt recovery, repeated/final 409 counting, wrapped `GrammyError`, non-409 exclusion, bounded labels, and redacted stable logging.
- [ ] Run `src/__tests__/bot-startup.test.ts` and `src/__tests__/metrics.test.ts`; all must pass before Task 3.

### Task 3: Count terminal media-pipeline degradation [HIGH]

**Goal:** Export one bounded counter increment for each user-visible terminal media failure across the primary Telegram and Discord session pipelines.

**Serves:** Issue #166 ask 3: a media/session pipeline error counter that reveals per-session degradation while liveness is green.

**Files:**
- Modify: `src/metrics.ts`
- Modify: `src/telegram-bot.ts`
- Modify: `src/discord-bot.ts`
- Modify: `src/__tests__/metrics.test.ts`
- Modify: `src/__tests__/telegram-bot.test.ts`
- Modify: `src/__tests__/discord-bot.test.ts`

- [ ] Add `minime_media_pipeline_errors_total{transport,media_type,stage}` and a typed recording helper whose closed media set is Telegram `voice|photo|document|animation|video|video_note|audio|sticker` plus Discord `image|voice`, paired only with existing `MediaPipelineStage` values.
- [ ] Increment once at the single terminal outcome boundary for every Telegram media handler, including declared-size rejections before download, after deriving the existing bounded stage and before best-effort user reply/cleanup.
- [ ] Increment once per failed Discord image/voice attachment after deriving the existing bounded stage, before best-effort user reply and cleanup.
- [ ] Add metric and handler tests proving one increment per failed handler/attachment, correct bounded classifications for oversized Telegram document/generic media, sticker, representative later stages, and multi-attachment Discord failures; prove no increment on success or recovered internal retry and no identity/path/URL/error labels.
- [ ] Run the Task 3 focused tests and lint; all must pass before Task 4.

### Task 4: Publish and verify the monitoring contract [HIGH]

**Goal:** Make missing/wrong-era identity, observable startup conflicts, and sustained media degradation actionable through tested public rule templates and documentation.

**Serves:** Issue #166 requires alerts, including media degradation while the liveness endpoint remains green; public/private separation forbids embedding production expectations.

**Files:**
- Modify: `examples/monitoring/minime.rules.yml`
- Modify: `examples/monitoring/minime.rules.test.yml`
- Modify: `src/__tests__/monitoring-rules.test.ts`
- Modify: `docs/monitoring.md`
- Modify: `README.md` if its metrics catalog links require an update

- [ ] Add a per-target identity rule `(up{job="minime-bot"} == 1) unless on(job,instance) minime_bot_instance_info` and a healthy-target media rule equivalent to `sum by(job,instance,transport)(increase(minime_media_pipeline_errors_total[10m])) >= 3 and on(job,instance) (up{job="minime-bot"} == 1)`, with a five-minute `for`; aggregate away PID, stage, and media-type so alert identity remains stable.
- [ ] Extend promtool fixtures for multiple simultaneous targets where only one UP target lacks identity, healthy identity, target down and stale media-series suppression, isolated media error suppression, sustained media failure firing while that same target remains UP, counter reset, and recovery after the rolling window clears.
- [ ] Extend structural tests to enforce rule names, thresholds, pending periods, fixed labels/annotations, bounded alert identity, and the absence of deployment-specific user/home/slot values in public rules.
- [ ] Update `docs/monitoring.md` with metric schemas, stable log marker/reasons, fail-fast lock/media/port behavior, shutdown/claim ordering, supervisor retry expectation, identity privacy/cardinality, the pre-bind counter observability limitation and its down/missing/unexpected-identity coverage, public alerts, and a placeholder-only per-`job,instance` external expected-identity selector example; remove the obsolete occupied-port retry description.
- [ ] Run all focused tests and `promtool`; then run the complete `npm test`, lint, build, dry-pack, repository privacy/author checks required by `AGENTS.md`, verify every issue ask against synthetic evidence, and leave the branch clean with the completed plan moved by Ralphex.

## Post-Completion
The parent lifecycle will independently run the exact-head full suite, open and validate the public feature PR, publish a mechanical release PR/tag, update private monitoring with concrete expected identity selectors, deploy through canonical wrappers, run controlled production identity/duplicate/media-degradation smokes, close issue #166 and its private task, and send one exactly-once Russian terminal report with a durable receipt.
