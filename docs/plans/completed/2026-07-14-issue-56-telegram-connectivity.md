# Plan: Preserve Telegram work across connectivity loss

Issue: [#56](https://github.com/fitz123/minime-bot/issues/56)

## Goal

Keep pending and in-flight Telegram work alive through a temporary connectivity outage by treating an unreachable Telegram API as degraded connectivity rather than a restart condition, and by consuming delayed updates retained by Telegram instead of dropping them at the application age gate.

## Context

Two independent loss paths are confirmed:

1. `src/polling-watchdog.ts` calls `decideRestart("api_unreachable")`. Restarting cannot repair an external outage, but it destroys process-local `MessageQueue` state and active Pi turns. grammY already retries failed `getUpdates` calls, and important Telegram API calls already use generic `autoRetry` with network retries.
2. Telegram handlers return when an update timestamp exceeds `sessionDefaults.maxMessageAgeMs` (10 minutes in production). Telegram itself retains pending updates for no longer than 24 hours, so this local age check defeats the server backlog.

This is a focused transport-lifecycle fix. Do not add SQLite, a durable inbox/outbox, webhook delivery, a new dependency, exactly-once semantics, queue-cap changes, or a general watchdog/message-queue redesign. Keep Discord stale-message behavior unchanged.

## Validation Commands

```bash
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test \
  src/__tests__/polling-watchdog.test.ts \
  src/__tests__/telegram-bot.test.ts \
  src/__tests__/discord-bot.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
npm run workspace:validate
npm run validate-config
```

### Task 1: Preserve Telegram work during temporary outages

- [x] In `src/polling-watchdog.ts`, keep the existing reachable-API `poll_stalled` restart path exactly once, but make `api_unreachable` a recorded/logged degraded state that does not call the exit path. Preserve bounded heartbeat timeout/abort, overlap suppression, and later recovery observation.
- [x] Narrow restart-reason typing/metrics if `api_unreachable` can no longer be a restart reason, while retaining it as a watchdog check outcome.
- [x] In `src/telegram-bot.ts`, remove local message-age rejection from `/start`, `/reconnect`, `/clean`, `/status`, text, voice, photo, document/animation, other media, and reaction handling. Remove only helpers/local variables made unused by this deletion. Keep `sessionDefaults.maxMessageAgeMs` in the shared configuration contract because Discord still uses it.
- [x] Leave `src/discord-bot.ts`, queue capacity/rejection, media lifecycle/ownership, grammY polling retry, generic `autoRetry`, and final delivery behavior unchanged.
- [x] Update watchdog tests to prove failed/thrown/timed-out heartbeats never exit, repeated unreachable checks stay bounded and can observe resumed polling, and reachable poll stalls still restart once.
- [x] Add delayed Telegram update coverage through the existing bot harness, including text plus at least one non-text/command path, proving old timestamps reach normal handling.
- [x] Add or preserve an explicit Discord regression proving its stale-message behavior remains unchanged.
- [x] Run every validation command above, keep the branch diff limited to issue #56, and commit all intended changes with a clean worktree.
