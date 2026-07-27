# Issue #125: acknowledged Telegram steering during active Pi turns

## Goal

Give ordinary Telegram inputs received during an active Pi turn the earliest real native Pi steering semantics—after the current complete tool-call batch and before the next model call—without known message loss or duplication. Bot ownership transfers only after the exact correlated Pi `steer` success response; every unresolved or failed attempt remains eligible for the existing follow-up path exactly once.

## Context

- Canonical task: `fitz123/minime-bot#125`, including the 2026-07-27 operator corrections and full-cycle authorization.
- Baseline: `main` commit `3ae49e957e7f4bfa824522a0e8b0e12e01ce23e9`, minime-bot 2026.7.36, Pi 0.82.1, grammY 1.45.1.
- `src/pi-rpc-protocol.ts` has the one stdout reader. It writes uncorrelated steer commands and deliberately keeps side-command responses nonterminal.
- Pi 0.82.1 RPC accepts optional command IDs; its steer handler awaits `session.steer(...)` and then emits a matching success/failure response.
- `src/session-manager.ts` owns the active read stream through `agent_settled`, including retry, compaction, and queued continuation. Child exit/activity timeout and settlement are existing resolution boundaries.
- `src/message-queue.ts` currently stores mid-turn text and cleanup callbacks in parallel arrays, then drains them only after the active send settles.
- `src/telegram-bot.ts` sends ordinary Telegram inputs through `MessageQueue`; passive echo and shutdown steering are separate best-effort paths.

## Development Approach

- **Testing approach:** invariant-first tests before or with each behavior change.
- Keep one logical Ralphex run in this repository/branch/plan lineage with Codex xhigh. Launch with `-b main`; invocation attempt 1 is capped at one task cycle for the mandatory trajectory check.
- Keep the implementation narrow: one correlated acknowledgement hook in the existing stdout owner, one session-owned pending-steer map, and structured collect entries with serial head-of-line steering.
- Complete and validate each task before moving to the next. The parent does not edit this active plan after launch.

## Testing Strategy

- Protocol unit tests prove exact ID correlation and that side responses never become terminal turn results.
- Session-manager tests prove success/rejection/write failure/child exit/settlement resolution and late-response no-ops.
- MessageQueue tests deterministically cover ordering, cap, fallback, clear/reconnect generation races, cleanup/media ownership, and exactly-once transfer.
- Telegram integration tests prove all ordinary Telegram input handlers use acknowledged steering while passive echo/shutdown and Discord remain unchanged.
- Final validation covers focused suites, full tests, TypeScript/build/package contracts, and public-data review.

## Validation Commands

```bash
npm run test:file -- src/__tests__/pi-rpc-protocol.test.ts
npm run test:file -- src/__tests__/session-manager.test.ts
npm run test:file -- src/__tests__/message-queue.test.ts
npm run test:file -- src/__tests__/telegram-bot.test.ts
npm run test:file -- src/__tests__/stream-relay.test.ts src/__tests__/telegram-adapter.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
node dist/cli.js --help
```

## Progress Tracking

Ralphex marks each item immediately after implementation and validation. A failed check is fixed before the next task. Any discovered separate repository, durable queue, retry subsystem, timeout subsystem, or broader abstraction is reported as out of scope rather than added.

## Non-goals

- No interruption of an already-running tool or sibling tool call in the current Pi batch.
- No generic RPC broker/client replacement, competing stdout reader, durable queue, independent acknowledgement timeout/retry loop, alternate Telegram implementation, or process-crash exactly-once claim.
- No steering-mode override; Pi configuration remains authoritative.
- No Discord behavior change, idle debounce change, draft/outbox redesign, capacity increase, media-lifecycle redesign, or passive echo/shutdown semantic change.
- No private identifiers, runtime paths, credentials, messages, or production payloads in public code, tests, docs, commits, or PR artifacts.
- No release, deploy, restart, production smoke, private pin update, or issue closure inside Ralphex; the parent owns those authorized lifecycle stages.

## Tasks

### Task 1: Correlate acknowledged steer responses in the existing Pi stream owner
**Goal:** Add a minimum session-level acknowledged-steer primitive whose exact response is observed by the existing single stdout reader and whose failure/settlement paths resolve without terminating the active turn.
**Serves:** The operator requires bot ownership to remain until matching Pi steer success, and requires rejection, write failure, child exit, inactive session, or settlement without that acknowledgement to preserve fallback.
- [ ] Add focused protocol tests for optional steer request IDs, matching and unrelated/out-of-order response observation, and successful/failed steer responses remaining nonterminal to the prompt result.
- [ ] Extend `src/pi-rpc-protocol.ts` only enough for callers to send an explicitly correlated steer and for `readPiStream` to expose valid command-response records to its owner without adding another reader or translating side responses into `ResultMessage`.
- [ ] Add session-manager tests for matching success, explicit rejection, stdin/write failure, inactive/wrong session, child exit, turn settlement before acknowledgement, late acknowledgement, and teardown/session replacement; every pending promise resolves exactly once with no independent timeout.
- [ ] Implement the per-`ActiveSession` pending-steer correlation map and acknowledged-steer API in `src/session-manager.ts`; settle unresolved entries as fallback at the existing turn/child/teardown boundaries and preserve passive shutdown steering.
- [ ] Run the protocol and session-manager focused suites; they must pass before Task 2.

### Task 2: Transfer structured MessageQueue entries serially and exactly once
**Goal:** Keep each mid-turn input as one structured bot-owned entry, attempt steering in arrival order, and transfer only the matching acknowledged head entry while preserving one ordered fallback for everything else.
**Serves:** The operator requires no known loss/duplication, arrival order, existing total cap/saturation behavior, and exact cleanup/media ownership across acknowledgement, fallback, `/clean`, and `/reconnect` races.
- [ ] Add deterministic MessageQueue tests for acknowledged head transfer, rejection/unacknowledged fallback, several corrections under one-at-a-time semantics, partial failures, around-settlement races, cap overflow, clear/replacement while acknowledgement is pending, and late callback no-ops.
- [ ] Add cleanup/media tests proving acknowledged entries run delivery cleanup once and transfer drop-cleanup ownership, while fallback/rejection/clear paths retain existing cleanup guarantees with no double execution.
- [ ] Replace only the collect parallel arrays with structured entries carrying stable entry identity/state and cleanup ownership; keep pending idle-debounce storage and public cap unchanged.
- [ ] Add a serial head-of-line acknowledged-steer attempt for the current busy generation; on matching success remove exactly that entry and try the next, while the first failure/settlement preserves the remaining ordered fallback without retries or timeouts.
- [ ] Run the MessageQueue focused suite; it must pass before Task 3.

### Task 3: Wire acknowledged steering for every ordinary Telegram input
**Goal:** Connect MessageQueue's acknowledged-steer hook to SessionManager for normal Telegram text and media-bearing inputs while leaving passive and non-Telegram behavior unchanged.
**Serves:** The operator requires the UX for ordinary Telegram text, voice, photo, document, other media, reply/forward/source-prefixed inputs, and reactions to improve without changing Discord, passive echo/shutdown steering, drafts, idle debounce, or Pi steering mode.
- [ ] Add Telegram integration tests proving ordinary active-turn inputs use the acknowledged path, inactive/post-settlement inputs retain fallback, and text/reply/forward/source-prefix content is preserved exactly.
- [ ] Add media-handler regressions for voice/photo/document/other media ownership on acknowledgement and fallback, including `/clean` and `/reconnect` while acknowledgement is pending.
- [ ] Wire `createTelegramBot` to pass only the new acknowledged SessionManager callback into `MessageQueue`; retain `makeSteerFn` for passive echo and retain graceful-shutdown best-effort steering.
- [ ] Verify Discord construction/call sites and Telegram idle 3-second debounce, draft relay, queue-cap notice, outbox behavior, and reaction routing remain unchanged.
- [ ] Run Telegram, MessageQueue, session-manager, stream-relay, and telegram-adapter focused suites; they must pass before Task 4.

### Task 4: Document semantics and run the complete regression contract
**Goal:** Publish the exact steering/fallback contract and prove the minimum implementation satisfies the whole repository contract without public-data leakage.
**Serves:** The operator authorized a full release only if the earliest-boundary semantics, no-loss/no-duplicate reliability boundary, preserved behaviors, and explicit non-goals are demonstrably met.
- [ ] Update README message-queue/runtime documentation: correlated acceptance, serial bot-to-Pi ownership transfer, settlement fallback, native tool-batch boundary, Pi steering-mode authority, and unchanged Discord/idle behavior.
- [ ] Run every focused regression from Tasks 1–3 and inspect the changed behavior against all ten required regression cases in issue #125.
- [ ] Run the full test suite, lint/typecheck, build, package dry-run, retired schema-guard contract check, minimal-workspace validation, and built CLI help.
- [ ] Review `main...HEAD` as a cut pass for unnecessary abstractions, timeout/retry machinery, unrelated changes, test weakening, private data, generated output, and dependency drift; run `git diff --check` and verify repository status is task-owned/clean.
- [ ] Record final changed files, commands/results, residual risks, plan progress, and Ralphex review outcome for parent lifecycle follow-through.

## Technical Details

- A correlated steer response is ownership evidence only when `type=response`, `command=steer`, `id` matches the exact pending request, and `success=true`.
- The existing stdout reader observes command responses before normal nonterminal parsing. Unmatched, duplicate, late, and non-steer responses cannot resolve another entry or terminate the prompt stream.
- A pending steer belongs to one `ActiveSession`; teardown and replacement resolve it as fallback. `agent_settled`/EOF/child exit resolve still-pending requests before MessageQueue begins its existing collect drain.
- MessageQueue attempts at most one head entry at a time. It does not acknowledge later entries past an unresolved/failed earlier entry, preserving arrival order even when responses are asynchronous.
- Successful acknowledgement runs normal consumed-message cleanup once and discards drop cleanup because Pi/session now owns referenced media. Every non-success retains the entry for existing follow-up delivery; clear/drop behavior remains recoverable and once-only.
- No wall-clock acknowledgement timer is introduced. The existing response activity timeout may terminate a dead child, after which SessionManager resolves fallback.

## Post-Completion

The parent supervisor performs independent diff/test validation, the GitHub PR/Copilot/CI loop, squash merge, next SemVer-valid July CalVer release, release validation/tag, private package validate/deploy/restart, and deterministic deployed-artifact steering/no-loss/no-duplicate smoke using fake/local protocol events without sending synthetic user content to Telegram or another external chat. It then performs clean log/metric tail audit, the private package-pin PR, issue closure, durable Knowledge update where useful, terminal milestone delivery, and worktree/temp cleanup after durable receipt.
