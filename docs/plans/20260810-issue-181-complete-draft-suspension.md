# Plan: Complete Telegram native-draft suspension coverage

## Goal

Finish the issue #181 mitigation for the two verified normal package paths that can mutate or steer an active Telegram topic without passing through `ctx.message`: package-owned delivery echoes and `message_reaction` updates. Reuse the existing per-session `ActiveDraftCoordinator` so these paths stop later cosmetic draft updates while preserving topic isolation, acknowledged steering, fallback ownership, and exactly-once permanent final delivery.

## Context

- `src/telegram-bot.ts` registers each relay under its session key and already suspends authenticated updates carrying `ctx.message`.
- `EchoWatcher` invokes `routeTelegramEchoToActiveTurn` outside Telegram middleware; the route resolves the exact binding/session key and calls passive `steerFn` without a draft transition.
- `message_reaction` resolves its topic through the existing message-to-topic cache and can enqueue/steer reaction context without carrying `ctx.message`.
- `src/active-draft-coordinator.ts` and `src/stream-relay.ts` already provide idempotent same-key suspension and prove that resets, refreshes, pending snapshots, and later deltas cannot reactivate a suspended relay.
- Issue #181 and production `2026.8.5` provide the verified source trace and operator-authorized outcome.

## Non-goals

- Do not replace native drafts with edited ordinary messages or disable normal single-message draft streaming.
- Do not add a generic lifecycle abstraction, queue, broker, or new draft state machine.
- Do not claim to delete an already accepted or client-cached Telegram draft; Bot API exposes no such primitive.
- Do not cover speculative external senders or unrelated Telegram update types without a concrete package-owned path.
- Do not change reaction/echo ownership, acknowledged-steering semantics, fallback ordering, or permanent final-delivery behavior.

## Validation Commands

```bash
npm run test:file -- src/__tests__/telegram-bot.test.ts src/__tests__/stream-relay.test.ts
npm run lint
npm run build
```

## Tasks

### Task 1: Suspend the exact echo session before passive steering
**Goal:** Route a valid package-owned delivery echo through the existing coordinator immediately before its passive Pi steer attempt, including when the steer is rejected because the active turn has already settled, without suspending malformed, unauthorized, mention-gated, or other-topic routes.
**Serves:** The operator requires same-session package echoes to suspend the active relay before steering, including the post-settlement/pre-final window, while preserving cross-topic isolation and current passive-echo ownership.

- [x] Add the minimum callback/hook needed for `routeTelegramEchoToActiveTurn` to expose the already-resolved session key immediately before `steerFn`, and wire it to `draftCoordinator.suspend` in `EchoWatcher`.
- [x] Add focused route/integration regressions proving callback-before-steer ordering, suspension even when `steerFn` returns false, and no suspension for malformed, blocked, or another-topic echoes.
- [x] Add or extend an active-relay regression proving later reset/deltas/refresh do not emit another native draft after the echo while one permanent final remains exactly once.
- [x] Run the focused Telegram and stream-relay tests and lint before Task 2.

### Task 2: Suspend same-topic reaction relays before queue or steering
**Goal:** Use the reaction handler's existing resolved session key to suspend the active relay before reaction context enters `MessageQueue`, while retaining message-to-topic cache routing and cross-topic isolation.
**Serves:** The operator requires same-topic reaction updates to receive the same draft lifecycle transition without changing reaction ownership, acknowledged steering, or final delivery.

- [ ] Invoke the existing coordinator for a valid non-empty reaction update immediately before queue/steering handling, using the same resolved key passed to `messageQueue.enqueue`.
- [ ] Extend reaction tests to prove suspension precedes enqueue/steer, repeated same-key updates stay idempotent, and a reaction mapped to another topic does not suspend the active relay.
- [ ] Re-run the focused Telegram and stream-relay tests, lint, and build; leave the one-time full suite to the parent gate.
- [ ] Review the final diff as a cut pass for scope, privacy, and preservation of issue #181 invariants.

## Parent-owned post-completion

After Ralphex and the parent full-suite gate, the full-cycle supervisor owns PR/CI/Copilot follow-through, merge, CalVer release, validated production deployment/restart, installed-artifact smoke, issue closure, Knowledge update, and tail audit.
