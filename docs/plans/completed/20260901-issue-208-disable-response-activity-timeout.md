# Plan: Disable the fixed Pi response-activity timeout

## Goal

Remove the hard-coded 30-minute response-activity watchdog from `src/session-manager.ts` globally, so an accepted Pi turn is never SIGTERM/SIGKILL-terminated for parent stream silence alone. Preserve explicit shutdown, `/clean`, `/reconnect`, crash recovery, idle-session cleanup, per-session queue semantics, and LRU behavior. Pin the new silence-tolerant behavior with a focused regression test.

## Non-goals

- No config setting, longer/replacement timeout, heartbeat, nested-process watchdog, compatibility layer, or metrics subsystem.
- No changes to `src/pi-rpc-protocol.ts`; its `readPiStream` activity callback remains optional generic plumbing.
- No changes to the separate idle-session timeout, startup timeout, crash backoff, explicit teardown, or LRU policy.
- No `web_search`, research-workflow, or `pi-dynamic-workflows` changes.
- No release, deploy, or production workflow replay inside the Ralphex implementation run; those are parent-supervisor follow-through.

## Context

- Public issue #208 records two production workflows killed at exactly 30 minutes without a workflow tool result. Historical issue #147 records a healthy opaque workflow taking 39m17s.
- `src/session-manager.ts` owns the complete watchdog: `RESPONSE_ACTIVITY_TIMEOUT_MS`, `activityTimer`, `killEscalationTimer`, their clear/reset helpers, initial arming, activity refresh, SIGTERM, and five-second SIGKILL escalation.
- `readPiStream` accepts an optional activity callback, so removing this policy does not require protocol changes.
- `src/__tests__/session-manager.test.ts` already contains `refreshes the activity watchdog for filtered lifecycle records before settlement`; this obsolete policy test must be replaced, not duplicated, with a silence-tolerance regression using the existing fake-child and fake-timer pattern.
- Existing issue-#172 tests separately prove that a busy turn survives idle expiry and that settlement starts a fresh idle window; they remain unchanged.

## Validation Commands

Focused implementation validation:

```bash
npm run test:file -- src/__tests__/session-manager.test.ts
npm run typecheck
```

Parent-owned post-Ralphex full-suite gate on the exact final `HEAD`:

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

## Tasks

### Task 1: Remove the response-activity watchdog and prove silence tolerance

**Goal:** An accepted Pi turn is never terminated by parent stream silence, while all independent session lifecycle controls retain their existing behavior.

**Serves:** Ninja's approved request to disable the recurring 30-minute limit globally, release/deploy the change, and determine through an exact workflow replay whether the removal should remain permanent.

- [x] Remove `RESPONSE_ACTIVITY_TIMEOUT_MS` and only the response-activity timer/SIGTERM/SIGKILL machinery inside `sendSessionMessage()` from `src/session-manager.ts`.
- [x] Pass no activity callback to `readPiStream` while preserving prompt correlation, steering settlement, retry telemetry, result metrics, queue completion, and post-turn idle-window behavior.
- [x] Replace the existing watchdog-refresh test in `src/__tests__/session-manager.test.ts` with a fake-timer regression that advances well beyond 30 minutes of silence, proves the accepted turn/session remains alive and un-killed, then supplies settlement and proves normal completion.
- [x] Keep the existing issue-#172 idle-lifecycle, explicit teardown, crash, queue, and LRU tests unchanged; do not remove unrelated assertions.
- [x] Add a concise `CHANGELOG.md` Unreleased entry referencing #208 and the removed fixed kill behavior.
- [x] Run the focused session-manager test file and typecheck; both must pass before Ralphex review.
- [x] Perform a final scope/privacy cut pass: no replacement mechanism or config surface, no unrelated hunks, and no private data.

## Post-Completion

Parent-supervisor work after Ralphex succeeds: run the full-suite gate, complete PR review/merge, publish and deploy the next package release, verify the live runtime no longer arms this timer, then replay the exact failed workflow under independent three-hour custody. Keep the removal on a usable workflow result; otherwise restore the previous timeout through the normal release path.
