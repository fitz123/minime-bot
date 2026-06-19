# Plan: Issue #16 — harden `/clean` and stale Pi startup/resume recovery

Status: complete. Review findings addressed on 2026-06-19.

## Goal

Fix the Pi session lifecycle so a chat cannot remain wedged on stale startup state:

1. `/clean` becomes a hard boundary: older in-flight startup/resume work for the same chat cannot re-persist state after clean.
2. The remaining missing Pi resume edge case recovers to a fresh Pi session instead of creating an `ActiveSession` around a dying child.
3. Recovered stale-resume failures do not increment `bot_session_crashes_total`.

Tracking issue: <https://github.com/fitz123/minime-bot/issues/16>

## Context

Relevant code:

- `src/telegram-bot.ts`
  - `/clean` handler calls `messageQueue.clear(key)` then `sessionManager.destroySession(key)`.
  - `/clean` bypasses the per-chat `MessageQueue`, so it can race with `getOrCreateSession()` startup.
- `src/session-manager.ts`
  - `getOrCreateSession()` reads persisted state, spawns Pi with `--session` when `resume=true`, and only later calls `active.set(...)` / `store.setSession(...)`.
  - `destroySession()` deletes store state and closes active sessions, but has no way to cancel startup work that is not yet in `active`.
  - Existing stale-resume signal detection / `discardUnresumablePiSession()` already implement the normal stale-resume fallback and have tests. Do **not** rebuild this machinery.
- `src/pi-rpc-protocol.ts`
  - `spawnPiRpcSession()` buffers startup stderr for classification via `piStartupStderr()`.

Important constraints:

- Do not delete Pi transcript/session JSONL files.
- Do not delete shared per-chat outbox/media dirs from stale-generation cleanup; a newer post-clean startup may already own them.
- Keep the fix local and boring: no broad cancellation framework.

## Proposed design

### 1. Add a minimal per-chat startup generation guard

In `SessionManager`, add one private map:

```ts
private sessionGenerations = new Map<string, number>();
```

Use it directly; do not add a public-shaped helper trio.

Behavior:

- In `getOrCreateSession(chatId, agentId)`, after dead-active cleanup and before reading stored session state, capture the current generation:

```ts
const generation = this.sessionGenerations.get(chatId) ?? 0;
```

- In `destroySession(chatId)`, before `store.deleteSession(chatId)`, increment the generation:

```ts
this.sessionGenerations.set(chatId, (this.sessionGenerations.get(chatId) ?? 0) + 1);
```

- Immediately before `active.set(...)` / `sessionsActive.inc()` / `store.setSession(...)`, compare the captured generation to the current value.
  - If stale: terminate and reap only the newly spawned child; do **not** persist state.
  - Do **not** increment `sessionsActive`.
  - Do **not** bump `restartCounts` or `sessionCrashes`: this is a superseded startup, not a crash.
  - Use a specific internal error/log message such as `Session startup superseded by clean`.

### 2. Make resource ownership explicit

`outboxDir` and media dirs are deterministic per-chat resources, not per-startup resources.

Implementation decision:

- Move destructive `prepareOutboxDir(chatId)` until after the generation check, immediately before creating the `ActiveSession` that will own that outbox.
- Leave `ensureSessionMediaDir(chatId)` where it is: it is idempotent and does not wipe.
- On stale-generation abort, kill/reap only the new child. Do **not** call:
  - `removeOutboxDirIfPresent(...)`
  - `cleanupSessionMediaDir(...)`
  - `cleanupStaleSessionMedia(...)`

Rationale: a newer post-clean startup for the same chat may already be using the shared per-chat outbox/media resources.

### 3. Narrow stale Pi resume work to the un-reaped window

Existing state:

- Normal `No session found matching ...` stale-resume fallback already exists.
- Existing tests cover spawn-then-exit with `exitCode` set synchronously.

Missing edge case:

- `capturePiSessionId(child)` returns no id or hits write/stdout close while `piStartupStderr(child)` already contains `No session found matching ...`, but `child.exitCode` is still `null` at the decision point.
- Current code can take the “no id but child still alive” branch, break out of startup capture, and build an `ActiveSession` around a dying child. The next prompt then fails with `Pi subprocess exited before sending a result`.

Implementation decision:

- In the no-id / child-not-yet-exited branch, if startup stderr already contains `No session found matching`, perform a short bounded settle wait (cap: ≤300ms) for the child exit state to populate, then route into the existing stale-resume recovery path.
- Preserve current behavior for cases without the stale-resume signal: if no id is captured and there is no `No session found matching` signal, keep the current “session stays usable on local id” behavior.
- Reuse the existing stale-resume discard machinery and the existing at-most-once retry guard.

### 4. Metrics/logging

- Keep `piSessionResumeDiscarded` for recovered stale resumes.
- Do not increment `sessionCrashes` for recovered stale resumes or superseded startup generations.
- Log exactly once per stale-resume recovery:

```text
could not resume Pi session <id> — starting fresh
```

Public logs/tests should avoid real chat ids or private agent names.

## Validation commands

```bash
npm test -- --runInBand src/__tests__/session-manager-pi-spawn.test.ts
npm test -- --runInBand src/__tests__/session-manager.test.ts
npm test -- --runInBand src/__tests__/metrics.test.ts
npm test
npm run build
```

If the test runner does not support `--runInBand`, use the existing package test invocation pattern for focused tests.

## Review validation (2026-06-19)

The package uses Node's test runner rather than Jest, so focused files were run
directly with the same module-mocking flags as `npm test`.

```bash
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/session-manager-pi-spawn.test.ts
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/session-manager.test.ts
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/metrics.test.ts
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/message-queue.test.ts
env -u MINIME_BOT_PI_SESSION npm test
npm run build
git diff --check
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

## Tasks

### Task 1: Reproduce the `/clean` in-flight startup race

- [x] Add/extend a `SessionManager` unit test where `getOrCreateSession()` starts a Pi spawn that has not yet reached `active.set(...)`.
- [x] Call `destroySession(chatId)` while startup is paused.
- [x] Release startup and assert no stale store entry is written for that chat.
- [x] Assert the superseded child is terminated/reaped.
- [x] Assert no `active` session and no `sessionsActive` increment remains for the superseded startup.

### Task 2: Implement the minimal generation guard

- [x] Add the private `sessionGenerations` map.
- [x] Capture generation in `getOrCreateSession()` after dead-active cleanup and before reading stored state.
- [x] Increment generation in `destroySession()` before deleting store state.
- [x] Check generation before `active.set(...)` / `sessionsActive.inc()` / `store.setSession(...)`.
- [x] On stale generation, kill/reap only the child; do not persist state, do not bump `restartCounts`, and do not touch shared outbox/media cleanup.

### Task 3: Protect newer-generation resources

- [x] Move `prepareOutboxDir(chatId)` after the generation check.
- [x] Leave `ensureSessionMediaDir(chatId)` in place unless tests prove a stronger reason to move it.
- [x] Add a regression where old startup is superseded by `/clean`, a new startup begins, then old startup completes and must not remove/corrupt the newer startup's outbox/media resources.

### Task 4: Reproduce and fix the un-reaped stale-resume window

- [x] Add/extend a test where a Pi spawn with `--session` buffers `No session found matching ...`, `capturePiSessionId()` returns no id or hits write/stdout close, and `exitCode` is still `null` at classification time but settles shortly after.
- [x] Implement the ≤300ms settle wait gated only on the buffered stale-resume signal.
- [x] Route the settled stale-resume case into the existing `discardUnresumablePiSession()` path.
- [x] Preserve current local-id behavior when there is no stale-resume signal.

### Task 5: Metrics and regression checks

- [x] Assert recovered stale resume increments `piSessionResumeDiscarded`.
- [x] Assert recovered stale resume does not increment `bot_session_crashes_total` / `sessionCrashes`.
- [x] Assert superseded startup generation does not increment `sessionCrashes`.
- [x] Run focused tests, full tests, and build.

## Acceptance criteria

- `/clean` cannot be undone by an older in-flight startup for the same chat.
- Superseded startup cleanup cannot delete/corrupt resources used by a newer post-clean startup.
- The un-reaped stale-resume case (`No session found matching ...` buffered while `exitCode === null`) recovers to a fresh session and does not increment `sessionCrashes`.
- Existing normal stale-resume fallback behavior remains intact.
- Recovered stale resumes are visible in logs/metrics but are not counted as session crashes.
- No transcript/session history files are deleted by the fix.
