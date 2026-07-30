# Plan: Telegram draft lifecycle across mid-turn steering

## Goal

Prevent Telegram iOS from replaying/flickering an active native `sendMessageDraft` after another message enters the same chat topic, while preserving acknowledged Pi steering, ordered fallback, media ownership, and exactly-once final delivery.

The minimum-sufficient behavior is:

1. a normal single-message turn keeps native draft streaming;
2. the first interleaved incoming Telegram message in the same session key suspends further cosmetic updates for that active relay;
3. accepted/consumed steering continues inside Pi without reactivating or replacing the suspended draft;
4. rejected/unconsumed steering remains bot-owned, the current relay finalizes normally, and the later fallback relay may stream a fresh draft;
5. repeated interleaved inputs are idempotent and topic-isolated;
6. the permanent final response is still sent exactly once.

## Context and root cause

- Telegram documents [`sendMessageDraft`](https://core.telegram.org/bots/api#sendmessagedraft) as an ephemeral 30-second preview and states that changes under the same non-zero `draft_id` are animated.
- `src/stream-relay.ts` currently keeps one stable `draftId` for the full relay, sends cumulative snapshots as often as once per second, and refreshes a visible draft every 25 seconds.
- Mid-turn Telegram inputs can be atomically enqueued/consumed through `MessageQueue` → `SessionManager` → `extensions/pi/acknowledged-steer.ts`, while rejected or unsettled inputs retain the existing fallback path.
- A second incoming message changes the visible Telegram timeline while the original draft remains active. The relay has no transition from that event to its cosmetic scheduler, so it continues replacing the same animated draft. Queued-continuation `reset_response_text` can also replace response text within that same relay.
- Session evidence confirms the visible cycle is not repeated model delivery. Private recordings and identifying runtime data remain local and must not enter repository artifacts.
- Issue #125 intentionally left draft-streaming UX out of scope; issue #181 is the canonical task for this interaction.
- One direct Fable planning attempt failed before planning with an expired OAuth token. Under the reset-aware fallback policy, Minime authored and source-cut-reviewed this plan instead of blocking on credential intervention.

## Recommended design

Use one small, generation-safe active-draft coordinator keyed by the existing Telegram session key (`chatId` plus optional topic ID):

- `relayStream` exposes only a narrow registration hook for the active scheduler's `suspend()` callback.
- `DraftScheduler.suspend()` becomes an idempotent cosmetic transition: reject future enqueues, discard pending/coalesced snapshots, cancel refresh/timing work, allow at most the already in-flight request to settle, and never affect accumulated answer text or final delivery.
- Telegram registers the callback for the relay's session key and unregisters it with token/generation fencing so an old relay cannot remove a newer relay's registration.
- An authenticated incoming Telegram message notifies the coordinator before command/media/queue processing. If no relay is active, the notification is a no-op. This covers ordinary steering inputs and commands that bypass `MessageQueue`, and it suspends immediately rather than after media preprocessing or steer acknowledgement.
- Suspension lasts only for the current relay. If steering is rejected/unconsumed and falls back after settlement, the new relay registers independently and may stream normally.

This keeps the message-ownership state machine authoritative and adds no second queue, retry system, or alternate delivery path.

## Rejected alternatives

- **Only increase the one-second interval:** reduces frequency but does not remove same-ID replay and violates the requested correctness fix.
- **Rotate `draft_id` after steering:** can leave both old and new ephemeral previews visible for up to 30 seconds.
- **Send a partial permanent message before steering:** breaks the one-final-message UX and can expose an obsolete partial answer.
- **Disable native drafts globally:** removes healthy single-message streaming rather than fixing the interleaved-input boundary.
- **Suspend only on `reset_response_text` or consumed steering:** misses commands, timeline mutation before acknowledgement, rejected fallback, and slow media preprocessing.
- **Cancel or hard-interrupt Pi:** contradicts native steering semantics and the existing no-known-loss contract.

## Non-goals

- No hard interruption of running tools or sibling tool calls.
- No change to Pi steering mode, correlated ownership transfer, queue capacity, debounce, media lifetime, or Discord behavior.
- No generic event broker, durable queue, draft retry subsystem, or client-specific Telegram fork.
- No attempt to delete a Telegram draft through a nonexistent Bot API method.
- No publication of private recordings, chat data, local paths, or message contents.
- No performance-only interval tuning as the primary fix.

## Validation commands

```bash
npm test -- --test-name-pattern='draft|steer|Telegram'
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

## Tasks

### Task 1: Make a relay draft safely suspendable
**Goal:** Add an idempotent cosmetic suspension boundary without changing answer accumulation or final delivery.
**Serves:** Ninja's requirement to stop the visible draft loop while keeping the bot's answer and final delivery correct.

- [x] Add the minimum relay registration option and a `DraftScheduler.suspend()` transition that blocks new/pending/refresh sends while allowing bounded in-flight settlement.
- [x] Ensure `reset_response_text`, close, cancel, rate-limit, and refresh paths cannot reactivate a suspended scheduler.
- [x] Add focused relay tests for suspension before the first draft, after a visible draft, with pending/coalesced text, during reset/queued continuation, and with one exactly-once final message.
- [x] Run focused stream-relay tests, lint, and typecheck before Task 2.

### Task 2: Suspend the active topic draft on interleaved Telegram input
**Goal:** Connect the existing Telegram session boundary to the active relay without coupling draft state to message ownership.
**Serves:** Ninja's explicit requirement that acknowledged steering and drafts interact correctly, including commands/messages received while processing.

- [x] Add a small generation-safe active-draft coordinator keyed by the existing `sessionKey`, with idempotent suspend and fenced unregister behavior.
- [x] Register/unregister each Telegram relay's suspension callback through the narrow relay hook.
- [x] Notify the coordinator for authenticated incoming Telegram messages before command, media preprocessing, or `MessageQueue` steering/fallback handling; keep topics isolated and idle notifications as no-ops.
- [x] Add tests proving same-topic suspension, cross-topic isolation, repeated-input idempotence, command/ordinary-message coverage, and stale-unregister safety.
- [x] Run focused Telegram, queue, session-manager, acknowledged-steer, and stream-relay tests before Task 3.

### Task 3: Lock the cross-layer steering/fallback contract and documentation
**Goal:** Prove the fix preserves delivery ownership and document the intentional degraded-streaming behavior after an interleaved input.
**Serves:** Ninja's requirement to preserve correct steering rather than hide the flicker by dropping, duplicating, or prematurely finalizing messages.

- [ ] Add or extend deterministic integration-level regression cases for accepted/consumed steering, rejected/unconsumed ordered fallback, multiple interleaved inputs, queued-continuation response reset, final draft settlement, and exactly-once permanent delivery.
- [ ] Confirm media cleanup/ownership and Discord behavior remain unchanged through existing tests; add a narrow regression only if the changed interface reaches those paths.
- [ ] Update README/runtime documentation to state that native draft streaming pauses after an interleaved Telegram message and resumes with a later independent relay if fallback creates one.
- [ ] Run the full test suite, lint/typecheck, build, package dry-run, schema/CLI/workspace gates, and privacy/diff checks.

## Post-completion

- Open and review a public PR linked to #181; keep all evidence sanitized.
- Publish the next valid CalVer release after merged-main validation.
- Deploy with the private package wrapper, restart after the advisory active-session check, and verify installed version, runtime health, config/workspace validity, logs/metrics, and deterministic installed-artifact regressions.
- Close #181 only after release, production verification, merged-main validation, and the no-tail audit pass.
