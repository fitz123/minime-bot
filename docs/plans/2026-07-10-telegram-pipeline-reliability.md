# Plan: Telegram pipeline reliability (#43, #44, #46)

## Goal

Fix three confirmed reliability defects in one Ralphex run and one feature PR:

- [#46](https://github.com/fitz123/minime-bot/issues/46): bounded message queues silently drop over-cap input.
- [#43](https://github.com/fitz123/minime-bot/issues/43): media download fails permanently on the first transient network error and callers report the wrong pipeline stage.
- [#44](https://github.com/fitz123/minime-bot/issues/44): Telegram DM drafts/typing create avoidable 429 bursts because sends are not coalesced or rate-aware.

Produce three separately reviewable commits, preserve existing successful behavior, and avoid unrelated refactors. Issues #41, #42, and #47 are out of scope.

## Verified current behavior

- `src/message-queue.ts:4-5, 144-177` caps debounce/collect buffers at 20, then runs cleanup and logs a warning without a user-visible rejection. Production Telegram and Discord queues use the defaults. Existing queue tests explicitly assert that overflow input disappears.
- `src/voice.ts:30-91` performs one `fetch()` with one timeout and no transient retry. Telegram and Discord callers map download/conversion/transcription failures inconsistently; Discord image failures currently only log.
- `src/stream-relay.ts:151-223, 304-307` emits fire-and-forget drafts at a 300 ms cadence, accumulates draft promises, and does not coordinate draft visibility with the typing loop. `src/telegram-adapter.ts:60-71` discards structured 429/`retry_after` information. Final message delivery and the existing no-autoRetry policy for drafts must remain unchanged.

## Shared invariants

- Reliability > efficiency > new capability.
- Memory remains bounded: queue caps stay finite, draft state is O(1), retries are bounded.
- Every platform input has one explicit outcome: eventual processing or visible rejection/degraded status.
- Cleanup/drop-cleanup and media ownership run exactly once on success, rejection, clear, and failure.
- No duplicate agent prompts, media downloads, retries, drafts, or final messages.
- No tokens, signed URLs, paths, chat IDs, message content, or unbounded values in logs/metrics/errors.
- Keep Telegram and Discord behavior aligned where they share the same downloader/queue contract.

## Tasks

### Task 1: Reject saturated queue input visibly (#46)

- [x] Keep both debounce and mid-turn collect queues bounded; do not merely raise the cap or make them unbounded.
- [x] Replace silent overflow with a user-visible, rate-bounded rejection that clearly says the affected input was not processed and must be resent later.
- [x] Preserve media/text parity and exactly-once `cleanup`/`dropCleanup` behavior. Clearing or reconnecting a queue must cancel any pending rejection-notification state/timer.
- [x] Add bounded metrics distinguishing debounce vs collect saturation/rejection without identifying the chat.
- [x] Replace existing “drop is terminal” expectations with deterministic tests for both buffers, bursts beyond the cap, concurrent arrivals, visible rejection, accepted-input non-duplication, media cleanup, clear/reconnect, rejection-notification failure, and no leaked timers.
- [x] Commit separately with `#46` in the message.

### Task 2: Retry transient media downloads and report the failing stage (#43)

- [ ] Trace all Telegram and Discord users of the shared media downloader. Keep retry logic inside the shared idempotent download path, not in individual handlers.
- [ ] Add a bounded transient policy with fresh timeout state per attempt, bounded backoff, partial-file cleanup before retry, preserved `0600` destination permissions, and existing size limits on every attempt.
- [ ] Retry only transient network/stream failures and explicitly retryable HTTP responses (408/429/5xx, honoring bounded `Retry-After`). Do not retry permanent 4xx, size-limit failures, conversion, transcription, or empty-transcript failures.
- [ ] Preserve the useful final cause internally while exposing a typed/bounded stage (`metadata`, `download`, `size-limit`, `conversion`, `transcription`, `empty-transcript`) without URL/token/path leakage.
- [ ] Make Telegram voice/photo/document/other-media and Discord audio/image callers produce accurate user-visible stage messages; Discord image failures must no longer be log-only.
- [ ] Add deterministic fetch/stream tests for transient recovery, exhausted retries, permanent failures, 429 handling, per-attempt timeout reset, corrupt partial cleanup, max-size enforcement, permissions, redaction, and Telegram/Discord handler mapping.
- [ ] Add bounded recovered/exhausted retry metrics. Commit separately with `#43` in the message.

### Task 3: Coalesce and throttle Telegram DM drafts (#44)

- [ ] Introduce one bounded per-stream draft scheduler/state machine. Keep at most one draft request in flight and only one latest pending text snapshot; stale intermediate snapshots are discarded.
- [ ] Enforce a Telegram-safe minimum send interval and use structured 429 `retry_after` feedback to pause future drafts. Do not retry the rejected stale draft or burst queued drafts after the pause.
- [ ] Final `sendMessage` remains authoritative and must not wait indefinitely for a draft. All final, error, abort, shutdown, and `NO_REPLY` paths must cancel timers and settle/abandon bounded draft state safely.
- [ ] Coordinate typing with drafts: after the first successful visible draft, stop periodic `sendChatAction` for that stream; preserve current typing behavior where drafts are unsupported.
- [ ] Preserve the existing rule that `sendMessageDraft` bypasses generic autoRetry while final delivery keeps its current retry behavior.
- [ ] Add metrics that distinguish cosmetic draft throttling/429 pauses from user-visible final-delivery failures, using bounded labels only.
- [ ] Add deterministic fake-timer/controlled-promise tests for one-in-flight behavior, minimum interval, latest-text coalescing, retry-after pause, no post-pause burst, hung/rejected drafts, prompt final delivery, typing coordination, `NO_REPLY`/error/abort cleanup, and non-draft platforms.
- [ ] Commit separately with `#44` in the message.

## Scope and review boundaries

Expected primary files: `src/message-queue.ts`, `src/voice.ts`, `src/stream-relay.ts`, Telegram/Discord handlers/adapters, `src/types.ts` only if the draft result contract requires it, `src/metrics.ts`, matching tests, and a short metrics documentation update if required by #44.

Do not add configuration knobs, persistent queues, a new monitoring stack, unrelated transport refactors, private-workspace code, release/version changes, or fixes for #41/#42/#47. Prefer the smallest implementation that satisfies each issue's acceptance criteria. If a proposed abstraction is used by only one task and does not simplify testing/correctness, keep it local.

## Ralphex execution contract

- Run from one feature branch created from current `main`; commit this plan on that branch before launch so the worktree is clean.
- Use the global Ralphex config only: Codex executor, model/reasoning inherited from `~/.codex/config.toml`, no local config overrides, no `--worktree`.
- Pass review base explicitly with `-b main`; no concurrent overlapping Ralphex run.
- Treat this plan as immutable after launch. If implementation discovers a real decision blocker, stop with evidence rather than silently changing scope.

## Validation

Run focused tests while implementing each task, then run the full gate once after all three commits:

```bash
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/message-queue.test.ts
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/voice.test.ts src/__tests__/telegram-bot.test.ts src/__tests__/discord-bot.test.ts
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/stream-relay.test.ts src/__tests__/telegram-adapter.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

Before trusting Ralphex review, verify its diffstat against `git diff --stat main...HEAD`; review base must be explicit `-b main`.

## PR and full-cycle handoff

- One feature PR linking and closing #43, #44, and #46; preserve the three logical commits during review.
- Run CI and the GitHub/Copilot review loop until green and clean. Public text must contain no private paths, IDs, or production content.
- After merge, use the normal separate CalVer release PR/tag, package validation, private deploy wrapper, approved restart, live process/version/config checks, feature metrics/log smoke, and final tail audit.
- Production smoke is bounded and non-destructive. Real CDN mid-stream failure and a genuine >20-message user-originated Telegram burst cannot be safely generated automatically; mark those live triggers unexercised and rely on deterministic regression tests plus post-deploy metrics/log observation. Do not fake equivalent live coverage.

## Rollback

Each task commit must be independently revertible. Production rollback is the previous released package through the canonical private deploy wrapper. No config/data migration is allowed in this bundle.
