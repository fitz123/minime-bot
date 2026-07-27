# Plan: Repair Telegram DM draft lifecycle (#149)

## Goal

Make Telegram DM streaming drafts remain visually continuous throughout long turns, prevent leading `NO_REPLY` sentinels from ever becoming visible, serialize ordinary draft completion before authoritative final delivery, and keep long snapshots useful and valid. Preserve the existing one-in-flight/O(1) scheduler, stable nonzero `draft_id`, minimum interval, bounded 429 handling, exactly-once final `sendMessage`, and non-DM behavior.

## Non-goals

- Do not adopt Bot API 10.2 empty-text “Thinking…” drafts, rich-message drafts, new Telegram product features, or new configuration knobs.
- Do not retry a rate-limited stale draft, bypass the existing minimum interval, or make final delivery wait without a bound.
- Do not hide the trailing bare-line `NO_REPLY` form while text is still streaming: it is unknowable until the stream ends. Preserve final suppression for that form without buffering every normal response or inventing draft deletion semantics.
- Do not change message-queue, media, polling, Pi, Discord, cron, topic, or final-message chunking behavior.
- Do not change package versions, private runtime/configuration, or release mechanics in this implementation run.

## Context and evidence

- Telegram documents `sendMessageDraft` as a temporary 30-second preview that must be replaced by final `sendMessage`; repeated updates with one nonzero `draft_id` animate the same draft. Bot API 10.2 permits empty text, but this task deliberately keeps the established text-draft surface.
- Current `DraftScheduler` only sends when a new text delta calls `enqueue()`. A tool gap over 30 seconds therefore lets the draft expire. After the first successful draft, `relayStream()` permanently stops its periodic typing indicator, leaving no visible activity until another delta or final delivery.
- Current finalization calls `cancel()`, aborting the only in-flight draft immediately, then waits at most three seconds. Client cancellation cannot prove Telegram did not accept the request, so an ordinary delayed completion can race behind final `sendMessage` and appear as a ghost draft.
- Current suppression runs only after stream completion. Incremental leading `N` / `NO_` / `NO_REPLY` output can therefore be shown even though the completed response is suppressed.
- Current long draft snapshots freeze on the response head, resend unchanged snapshots, and use UTF-16 `slice()` at the boundary. The Telegram adapter lacks the final-message path’s plain-text fallback when HTML entity parsing or renderer expansion exceeds the API limit.
- Existing #44 invariants remain authoritative: one in-flight request, one replaceable pending snapshot, minimum one-second starts, bounded `retry_after`, no generic autoRetry for drafts, cosmetic failure containment, and authoritative final delivery.
- Fable planning remains unavailable because its OAuth is expired; this decision-complete plan uses the documented Minime fallback and was self-reviewed only for removals, simplification, and blockers.

## Validation commands

```bash
npm run test:file -- src/__tests__/stream-relay.test.ts src/__tests__/telegram-adapter.test.ts src/__tests__/telegram-bot.test.ts src/__tests__/metrics.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
git diff --check
```

## Tasks

### Task 1: Make the draft scheduler continuous, ordered, suppressed, and bounded
**Goal:** Correct all confirmed draft lifecycle gaps in the existing bounded scheduler without weakening final delivery.
**Serves:** The operator’s report that DM streaming looks strange/buggy; the confirmed 30-second expiry, leading `NO_REPLY` leak, finalization race, frozen long snapshot, duplicate churn, surrogate split, and HTML-limit gaps.
- [x] Add a fixed refresh interval safely below Telegram’s 30-second expiry. After a successful visible draft, periodically resend only the latest visible snapshot while the turn remains active; preserve one in-flight request, one pending snapshot, minimum-start spacing, bounded 429 pause, stable `draft_id`, and O(1) state.
- [x] Dedupe ordinary unchanged snapshots while allowing intentional refreshes. Cancel refresh/pending timers on final, suppressed, reset, error, abort, and unsupported paths; never emit a refresh after relay settlement.
- [x] Keep periodic typing active until the turn settles so a failed/rate-limited refresh still leaves a truthful activity signal. Do not alter `typingIndicator: false` or unsupported-platform behavior.
- [x] Hold draft scheduling while trimmed accumulated output is either a prefix of `NO_REPLY` or already matches the leading sentinel boundary. Once output proves a non-sentinel such as `NO_REPLY_EXTRA`, publish the current complete snapshot normally. Preserve final suppression for both leading and trailing forms.
- [x] Replace head-freezing truncation with a tail-visible, UTF-16-surrogate-safe bounded snapshot helper. Ensure every ordinary draft snapshot is nonempty, within the platform limit, and does not split a surrogate pair.
- [x] Change finalization to stop future work and first let the sole in-flight draft settle naturally for the existing bounded window. Abort only the timeout fallback, then allow authoritative final delivery; ordinary delayed drafts must finish before final `sendMessage` starts.
- [x] Give Telegram draft sends the same narrow HTML parse/message-too-long plain-text fallback as final sends, preserving the same draft ID, signal, thread options, 429 classification, and cosmetic-failure containment.
- [x] Add deterministic fake-timer/controlled-promise tests for >30-second no-delta refresh, latest-snapshot refresh, unchanged-snapshot dedupe, rate-limit spacing/no burst, persistent typing, leading sentinel hold/disambiguation, trailing final suppression, natural draft-before-final ordering, timeout abort fallback, timer cleanup, long tail visibility, surrogate safety, HTML fallback, non-DM behavior, and exactly one final message.
- [x] Run the focused draft/Telegram/metrics matrix and commit the implementation as one reviewable task slice.

### Task 2: Document and validate the complete release candidate
**Goal:** Lock the user-visible contract and prove no regression outside DM cosmetic streaming.
**Serves:** The requirement to fix only confirmed draft lifecycle gaps on the Pi 0.82.1 / grammY 1.45.1 baseline and complete the authorized full release cycle safely.
- [x] Update current README documentation to state the sub-30-second keepalive, always-active configured typing fallback, leading-sentinel hold, bounded natural finalization ordering, useful tail snapshots, and unchanged authoritative final delivery; keep Bot API 10.2 empty-text/rich features explicitly unadopted.
- [x] Run clean install if dependency state changed, the full 2,299-test-or-later suite, lint/typecheck, build, package dry-run, schema contract, CLI help, minimal-workspace validation, and whitespace checks. Verify no test/runtime subprocess survives.
- [x] Inspect `git diff main...HEAD` for exact issue scope, PII/secrets, accidental generated files, metric-label drift, package/version movement, private paths, and unrelated Telegram behavior.
- [x] Move this plan to `docs/plans/completed/` only after both tasks and all gates pass; leave PR, CalVer release, private deployment/restart, installed-artifact smoke, issue closure, Knowledge/milestone persistence, and queue completion to the parent supervisor.

## Success criteria

- A visible draft receives a same-ID refresh before the 30-second TTL during a no-delta tool gap, but unchanged ordinary deltas do not churn requests and every start still obeys scheduler/rate-limit bounds.
- Configured periodic typing remains active until settlement; disabled typing and unsupported drafts retain their existing behavior.
- No leading `NO_REPLY` prefix becomes visible; `NO_REPLY_EXTRA` disambiguates and streams; final leading/trailing suppression stays exactly once with no final message.
- Ordinary delayed in-flight drafts settle before final `sendMessage`; hung drafts trigger only the bounded timeout-abort fallback, and no timer initiates work after settlement.
- Long drafts show the current tail, stay within the platform bound without split surrogate pairs, and fall back narrowly to bounded plain text when Telegram rejects HTML parsing/length.
- Final delivery remains authoritative and exactly once; groups, Discord, topics, files, 429 semantics, draft autoRetry exclusion, and message chunking do not regress.
- Focused, full, static, package, scope, and privacy gates pass; production rollout can verify the deployed installed artifact deterministically without sending synthetic user content.

## Ralphex execution contract

- One approved logical run: repository `fitz123/minime-bot`, branch `fix/issue-149-dm-draft-lifecycle`, this plan lineage, Codex executor with canonical xhigh settings, explicit review base `main`, and no Ralphex worktree mode.
- Invocation attempt 1 uses `--max-iterations 1`; the parent performs the mandatory trajectory gate before any uncapped continuation of this same logical run.
- Keep comprehensive and critical review enabled. Separate release/deploy work is parent-owned and does not consume another logical run.
