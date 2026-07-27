# Issue #125: acknowledged Telegram steering during active Pi turns

## Goal

Give ordinary Telegram inputs received during an active Pi turn the earliest real native Pi steering semantics—after the current complete tool-call batch and before the next model call—without known message loss or duplication. Bot ownership transfers only after the exact correlated child-lifecycle gate accepts and Pi begins consuming the correction; every unresolved or failed attempt remains eligible for the existing follow-up path exactly once.

## Context

- Canonical task: `fitz123/minime-bot#125`, including the 2026-07-27 operator corrections and full-cycle authorization.
- Baseline: `main` commit `3ae49e957e7f4bfa824522a0e8b0e12e01ce23e9`, minime-bot 2026.7.36, Pi 0.82.1, grammY 1.45.1.
- `src/pi-rpc-protocol.ts` has the one stdout reader. Pi 0.82.1's native steer handler unconditionally queues while idle, so exact command correlation alone is not atomic with the child lifecycle.
- The package-owned acknowledged-steer extension gates and enqueues within Pi's event loop, then emits distinct matching enqueue, consumption, or rejection notification records to that existing reader through Pi's supported extension UI API.
- `src/session-manager.ts` owns the active read stream through `agent_settled`, including retry, compaction, and queued continuation. Child exit/activity timeout and settlement are existing resolution boundaries.
- `src/message-queue.ts` currently stores mid-turn text and cleanup callbacks in parallel arrays, then drains them only after the active send settles.
- `src/telegram-bot.ts` sends ordinary Telegram inputs through `MessageQueue`; passive echo and shutdown steering are separate best-effort paths.

## Development Approach

- **Testing approach:** invariant-first tests before or with each behavior change.
- Keep one logical Ralphex run in this repository/branch/plan lineage with Codex xhigh. Launch with `-b main`; invocation attempt 1 is capped at one task cycle for the mandatory trajectory check.
- Keep the implementation narrow: one first-party child-lifecycle gate observed by the existing stdout owner, one session-owned pending-steer map, and structured collect entries with serial head-of-line steering.
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
**Serves:** The operator requires bot ownership to remain until matching Pi acceptance, and requires rejection, write failure, child exit, inactive session, or settlement without that acknowledgement to preserve fallback.
- [x] Add focused protocol and extension tests for exact request IDs, child lifecycle acceptance/rejection, matching and unrelated/out-of-order result observation, and results remaining nonterminal to the prompt result.
- [x] Extend the first-party Pi wrapper set and `src/pi-rpc-protocol.ts` only enough to gate/enqueue a correlated correction atomically and expose its bounded result to the existing reader without adding another reader or translating it into `ResultMessage`.
- [x] Add session-manager tests for matching success, explicit rejection, stdin/write failure, inactive/wrong session, child exit, turn settlement before acknowledgement, late acknowledgement, and teardown/session replacement; every pending promise resolves exactly once with no independent timeout.
- [x] Implement the per-`ActiveSession` pending-steer correlation map and acknowledged-steer API in `src/session-manager.ts`; settle unresolved entries as fallback at the existing turn/child/teardown boundaries and preserve passive shutdown steering.
- [x] Run the protocol and session-manager focused suites; they must pass before Task 2.

### Task 2: Transfer structured MessageQueue entries serially and exactly once
**Goal:** Keep each mid-turn input as one structured bot-owned entry, attempt steering in arrival order, and transfer only the matching acknowledged head entry while preserving one ordered fallback for everything else.
**Serves:** The operator requires no known loss/duplication, arrival order, existing total cap/saturation behavior, and exact cleanup/media ownership across acknowledgement, fallback, `/clean`, and `/reconnect` races.
- [x] Add deterministic MessageQueue tests for acknowledged head transfer, rejection/unacknowledged fallback, several corrections under one-at-a-time semantics, partial failures, around-settlement races, cap overflow, clear/replacement while acknowledgement is pending, and late callback no-ops.
- [x] Add cleanup/media tests proving acknowledged entries run delivery cleanup once and transfer drop-cleanup ownership, while fallback/rejection/clear paths retain existing cleanup guarantees with no double execution.
- [x] Replace only the collect parallel arrays with structured entries carrying stable object identity and cleanup ownership; keep pending idle-debounce storage and public cap unchanged.
- [x] Add serial head-of-line acknowledged-steer submission for the current busy generation; matching enqueue acceptance opens the next submission, matching consumption removes exactly that entry, and the first failure/settlement preserves the remaining ordered fallback without retries or timeouts.
- [x] Run the MessageQueue focused suite; it must pass before Task 3.

### Task 3: Wire acknowledged steering for every ordinary Telegram input
**Goal:** Connect MessageQueue's acknowledged-steer hook to SessionManager for normal Telegram text and media-bearing inputs while leaving passive and non-Telegram behavior unchanged.
**Serves:** The operator requires the UX for ordinary Telegram text, voice, photo, document, other media, reply/forward/source-prefixed inputs, and reactions to improve without changing Discord, passive echo/shutdown steering, drafts, idle debounce, or Pi steering mode.
- [x] Add Telegram integration tests proving ordinary active-turn inputs use the acknowledged path, inactive/post-settlement inputs retain fallback, and text/reply/forward/source-prefix content is preserved exactly.
- [x] Add media-handler regressions for voice/photo/document/other media ownership on acknowledgement and fallback, including `/clean` and `/reconnect` while acknowledgement is pending.
- [x] Wire `createTelegramBot` to pass only the new acknowledged SessionManager callback into `MessageQueue`; retain `makeSteerFn` for passive echo and retain graceful-shutdown best-effort steering.
- [x] Verify Discord construction/call sites and Telegram idle 3-second debounce, draft relay, queue-cap notice, outbox behavior, and reaction routing remain unchanged.
- [x] Run Telegram, MessageQueue, session-manager, stream-relay, and telegram-adapter focused suites; they must pass before Task 4.

### Task 4: Document semantics and run the complete regression contract
**Goal:** Publish the exact steering/fallback contract and prove the minimum implementation satisfies the whole repository contract without public-data leakage.
**Serves:** The operator authorized a full release only if the earliest-boundary semantics, no-loss/no-duplicate reliability boundary, preserved behaviors, and explicit non-goals are demonstrably met.
- [x] Update README message-queue/runtime documentation: correlated acceptance, serial bot-to-Pi ownership transfer, settlement fallback, native tool-batch boundary, Pi steering-mode authority, and unchanged Discord/idle behavior.
- [x] Run every focused regression from Tasks 1–3 and inspect the changed behavior against all ten required regression cases in issue #125.
- [x] Run the full test suite, lint/typecheck, build, package dry-run, retired schema-guard contract check, minimal-workspace validation, and built CLI help.
- [x] Review `main...HEAD` as a cut pass for unnecessary abstractions, timeout/retry machinery, unrelated changes, test weakening, private data, generated output, and dependency drift; run `git diff --check` and verify repository status is task-owned/clean.
- [x] Record final changed files, commands/results, residual risks, plan progress, and Ralphex review outcome for parent lifecycle follow-through.

## Task 4 Validation Record

- Focused suites passed after review corrections: acknowledged-steer 3/3, Pi RPC 144/144, SessionManager 78/78, MessageQueue 43/43, Telegram 269/269, and stream-relay/Telegram adapter 135/135. The parity/resource/worker-CLI-inclusive run passed 194/194, and package install/workspace spawn passed 3/3.
- Issue #125 regression cases 1–10 passed by source/test trace: acknowledged no-duplicate transfer; explicit rejection with nonterminal stream and one fallback; before/after-settlement races; serial corrections; cap/notice behavior; child-exit/write-failure fallback; pending `/clean` and `/reconnect`; photo/document ownership; unrelated/out-of-order response isolation; and unchanged passive echo/shutdown steering.
- Full contract passed after review corrections: `npm test` (2342/2342 across 322 suites), `npm run lint`, `npm run build`, `npm pack --dry-run` (271 intended files), `npm run check:schema-guard-contract`, `npm run workspace:validate -- --workspace test-fixtures/minimal-workspace`, and `node dist/cli.js --help`. The workspace fixture remained valid with its expected missing-context/knowledge/rules warnings.
- Independent six-agent review confirmed Pi 0.82.1 preflight/settlement races in the original native-steer correlation, incomplete Telegram media/docs coverage, and avoidable queue state bookkeeping. Corrections add the atomic first-party lifecycle gate, complete the ordinary media matrix and public semantics, simplify queue identity tracking, and retain the fixture-required defensive pending-map guard.
- Corrective cut review passed the full contract plus `git diff --check`; dependency manifests, Discord sources, and stream-relay remain unchanged, generated output remains untracked, and status contains only task-owned source, tests, build wiring, and documentation. No generic broker, independent acknowledgement timeout/retry, test weakening, private data, or unrelated abstraction was added.
- Corrective files add `extensions/pi/acknowledged-steer.ts`, `src/pi-extensions/acknowledged-steer.ts`, its focused test, build/package/spawn wiring and assertions, session/protocol tests, the complete Telegram media matrix, queue simplification, and README/Pi-extension/plan documentation.
- Residual boundary: the queue remains process-memory scoped and native steering cannot interrupt the current tool-call batch. PR/CI, release, deploy/restart, installed-artifact smoke, tail audit, and issue closure remain with the parent as planned.
- Subsequent critical/major review passes fixed buffered-success handling at child exit/teardown, kept the lifecycle gate available through retry/compaction/continuation work, and separated serial enqueue acceptance from ownership-transferring consumption so Pi's configured steering mode remains authoritative.
- Latest review validation passed the focused extension/protocol/SessionManager/MessageQueue contract (270/270), the full suite (2,344/2,344 across 322 suites), lint/typecheck, and `git diff --check`.
- Plan progress: Tasks 1–4 are complete. This review iteration found and fixed confirmed issues, so another external review iteration is required before `REVIEW_DONE`.

## Technical Details

- The package-owned Pi extension opens steering on `agent_start`, keeps it open across low-level `agent_end` retry/compaction/continuation windows, closes it on `agent_settled`, and synchronously enqueues through Pi's extension binding only while `ctx.isIdle()` is false. This closes both prompt-preflight and settlement races left by Pi 0.82.1's unconditional native steer RPC.
- The extension emits correlated `enqueued`, `consumed`, or `rejected` results through `extension_ui_request` fire-and-forget notifications whose messages contain the exact prefixed, base64url-encoded result envelope. Enqueue acceptance advances serial submission so Pi's configured steering mode remains authoritative; ownership evidence additionally requires the exact pending `id` and `status=consumed`.
- Direct process/stdout access is deliberately absent so the wrapper remains compatible with primary-resource parity attestation. The existing stdout reader observes the notification before normal nonterminal parsing. Unmatched, malformed, duplicate, and late results cannot resolve another entry or terminate the prompt stream.
- A pending steer belongs to one `ActiveSession`; teardown and replacement resolve it as fallback. `agent_settled`/EOF/child exit resolve still-pending requests before MessageQueue begins its existing collect drain.
- MessageQueue has at most one enqueue submission awaiting acceptance at a time. Accepted entries remain bot-owned pending consumption while the queue serially offers later entries in arrival order; a rejection blocks entries behind it.
- Matching consumption runs normal consumed-message cleanup once because Pi/session now owns referenced media. Every unresolved or rejected entry remains available for existing follow-up delivery; explicit clear/drop behavior remains recoverable and once-only.
- No wall-clock acknowledgement timer is introduced. The existing response activity timeout may terminate a dead child, after which SessionManager resolves fallback.

## Post-Completion

The parent supervisor performs independent diff/test validation, the GitHub PR/Copilot/CI loop, squash merge, next SemVer-valid July CalVer release, release validation/tag, private package validate/deploy/restart, and deterministic deployed-artifact steering/no-loss/no-duplicate smoke using fake/local protocol events without sending synthetic user content to Telegram or another external chat. It then performs clean log/metric tail audit, the private package-pin PR, issue closure, durable Knowledge update where useful, terminal milestone delivery, and worktree/temp cleanup after durable receipt.
