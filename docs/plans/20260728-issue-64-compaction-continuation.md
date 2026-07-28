# Plan: Continue reasoning-only length turns after compaction

## Goal

On the package-owned Pi 0.82.1 lifecycle, preserve a reasoning-only `stopReason="length"` `agent_end` as an observed low-level outcome and, after successful automatic threshold compaction, continue the same accepted turn until it emits exactly one real final answer or one specific unrecoverable error. Never classify that path as success or as the genuine missing-`agent_end` diagnostic.

## Non-goals

- No new compaction engine or Pi dependency upgrade.
- No manual Continue UX.
- No generic lifecycle broker, retry framework, or unrelated session refactor.
- No synthetic user-role message or user-visible continuation control text.
- No change to cron, subagent, Ask Agent, or unrelated extension behavior.
- No weakening of queued steering, overflow recovery, exactly-once delivery, or genuine missing-`agent_end` diagnostics.

## Context

- Public issue: `fitz123/minime-bot#64`.
- `src/pi-rpc-protocol.ts` currently retains no outcome when the final assistant has no visible text, so `agent_settled` later reports that no usable `agent_end` arrived even when a reasoning-only length stop was observed.
- Pi 0.82.1 emits `agent_end` before its post-run compaction check. Successful threshold compaction emits `session_compact` after the compacted state is persisted and before Pi decides whether queued messages require `agent.continue()`; unlike overflow recovery, threshold compaction sets `willRetry=false`.
- Existing first-party extension code already demonstrates hidden custom messages queued with `deliverAs: "followUp"`. A narrowly scoped wrapper can arm on the exact reasoning-only length outcome and enqueue one hidden custom continuation only from the successful threshold `session_compact` boundary. Failed compaction never emits that boundary and therefore must settle to a specific error instead of continuing blindly.
- Parent interactive extension inventories, source-to-package artifact generation, and installed-package assertions are centralized in `src/pi-rpc-protocol.ts`, `scripts/build-package-artifacts.mjs`, and package-install tests.

## Validation Commands

```bash
npm run test:file -- src/__tests__/pi-extensions-compaction-continuation.test.ts
npm run test:file -- src/__tests__/pi-rpc-protocol.test.ts
npm run test:file -- src/__tests__/package-install.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
git diff --check
```

## Tasks

### Task 1: Queue one hidden continuation only after successful threshold compaction
**Goal:** Add the minimum first-party Pi extension state machine for the exact reasoning-only length lifecycle.
**Serves:** The approved outcome that successful automatic compaction resumes the original turn without manual Continue UX or synthetic user-message leakage.
- [ ] Add a small shared helper/contract that recognizes only a final assistant `stopReason="length"` with no non-whitespace visible text.
- [ ] Add a parent interactive Pi wrapper that arms on that exact `agent_end`, consumes the arm only at a successful threshold `session_compact`, and queues one `display:false` custom follow-up so Pi 0.82.1 continues from compacted state.
- [ ] Make duplicate/nonmatching events, overflow retry compaction, failed/aborted compaction, and settlement clear or ignore the arm without queuing extra work.
- [ ] Add focused wrapper/helper tests proving one custom follow-up, no user-role message, no visible control text, no duplicate continuation, and no continuation when compaction did not succeed.
- [ ] Run the new focused extension tests before Task 2.

### Task 2: Package the continuation wrapper only for primary interactive sessions
**Goal:** Ship the new wrapper through the existing source and built-artifact contract without expanding other Pi execution surfaces.
**Serves:** The approved constraint to preserve unrelated cron/subagent behavior and verify the released installed artifact rather than relying on source-only behavior.
- [ ] Add the wrapper to primary interactive source/artifact inventories and the package artifact builder.
- [ ] Explicitly keep the wrapper out of cron, subagent-child, and Ask Agent child inventories.
- [ ] Update extension inventory and package-install assertions so both source and built package paths contain exactly the intended wrapper set.
- [ ] Add/adjust installed-artifact tests proving the packaged wrapper can load and retains the hidden custom-message contract.
- [ ] Run extension inventory, build, and package-install focused tests before Task 3.

### Task 3: Distinguish observed length outcomes and lock the end-to-end lifecycle regression
**Goal:** Make terminal parsing truthful and prove length → compaction → automatic continuation → one final answer.
**Serves:** The approved outcome that an observed reasoning-only length `agent_end` is neither success nor the false missing-`agent_end` diagnostic, while genuine missing-`agent_end` behavior remains distinct.
- [ ] Track observation of the completed run's `agent_end` separately from retained visible answer text and keep a specific unrecoverable length outcome until a real continuation outcome replaces it.
- [ ] Update settlement/reset handling so a final answer after continuation wins exactly once, while a settled length path that could not continue returns one specific error and a true settlement with no `agent_end` retains the existing missing-outcome diagnostic.
- [ ] Add deterministic parser/stream tests for reasoning-only length, successful threshold compaction and hidden continuation, final visible answer exactly once, compaction failure/no continuation, genuine missing `agent_end`, queued steering/follow-up, and overflow recovery.
- [ ] Run focused lifecycle tests, then the full package test suite, lint, build, package dry-run, and whitespace validation.
- [ ] Review `git diff main...HEAD` as a scope/privacy cut pass and confirm no unrelated lifecycle framework or dependency change entered the branch.

## Post-Completion

The parent supervisor owns PR review/CI, merge, CalVer release/tag, validated private package deployment and restart, installed-artifact/runtime smoke verification, final-main validation, issue closure, durable Knowledge update, and terminal delivery. Production verification must use a bounded artifact/session fixture and prove that the hidden continuation is not persisted or exposed as a synthetic user message.
