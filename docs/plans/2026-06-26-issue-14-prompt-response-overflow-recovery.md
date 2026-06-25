# Plan: Issue #14 prompt-response context overflow recovery

## Goal

Extend the Pi RPC overflow recovery relay so a failed RPC `response` for `command="prompt"` with a Codex/OpenAI context-overflow error is treated like the already-fixed pre-compaction overflow `agent_end` path: do not deliver the intermediate error as the final user answer; wait for Pi's compaction/continuation, or surface a non-empty error if recovery fails.

## Evidence

Public issue: https://github.com/fitz123/minime-bot/issues/14

Sanitized production evidence added to issue #14 on 2026-06-26:

- Private Pi transcript line 226 at `2026-06-25T21:29:56.712Z`: assistant `stopReason=error`, empty content, `errorMessage` contains `invalid_request_error`, `code=context_length_exceeded`, and “Your input exceeds the context window of this model”.
- Private Pi transcript line 227 at `2026-06-25T21:31:31.831Z`: `type=compaction`, `parentId` points to the failed assistant message, `tokensBefore=271814`.
- User-visible behavior: the bot delivered the `context_length_exceeded` error even though Pi recognized overflow and compacted immediately afterward.

Existing source evidence:

- `src/pi-rpc-protocol.ts` already recognizes context-overflow text via `isContextOverflowError`.
- `agent_end` handling already defers overflow-only final assistant errors by setting `state.pendingOverflowErrorMessage` and waiting for `compaction_start` / `compaction_end` / final retry output.
- `readPiStream` already has an EOF fallback: if `pendingOverflowErrorMessage` remains when stdout ends, it yields a non-empty overflow error result.
- Gap: `response` handling currently treats every non-`already processing` failed prompt response as terminal, so `command="prompt"`, `success=false`, `error=context_length_exceeded...` returns `error_during_execution` immediately.

## Non-goals

- Do not change the existing `already processing` prompt-response behavior.
- Do not turn all prompt failures into retryable/deferred errors.
- Do not implement the older WebSocket 1009 byte-size/provider-hook normalization in this pass unless it is naturally small and directly covered; keep the main fix focused on prompt-response context overflow.
- Do not log or add fixtures containing private chat IDs, local user paths, tokens, or transcript payloads.

## Implementation direction

- Keep this fix narrow in `src/pi-rpc-protocol.ts` and `src/__tests__/pi-rpc-protocol.test.ts` unless implementation proves a tiny helper is cleaner.
- The production event evidence did not show `willRetry` on failed prompt `response` events. Do not rely on that field for correctness. If the field exists and is `false`, surfacing a terminal error is fine; otherwise the default should be “defer and let compaction/final agent_end/EOF decide”.
- Existing `compaction_start` should emit the `reset_response_text` control request when pending overflow state exists. Do not create tests that only pass because a synthetic response fixture has `willRetry: true`.
- A subsequent successful final `agent_end` must clear pending overflow state via the existing `finishPiRpcResult` path so EOF cannot later surface a stale overflow error.
- Guard overflow checks against missing/non-string `rawEvent.error`; malformed or non-overflow prompt failures must fall through to the existing terminal error behavior.

## Validation commands

```bash
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/pi-rpc-protocol.test.ts
npm test
npm run lint
npm run build
git diff --check
npm pack --dry-run
```

## Tasks

### Task 1: Add prompt-response overflow deferral in Pi RPC parser

- In `parsePiEvent`, inside `case "response"` and `rawEvent.success === false && rawEvent.command === "prompt"`, preserve the current first check for `isPiAlreadyProcessingRejection(rawEvent.error)` → log + `return null`.
- After that, if `isContextOverflowError(rawEvent.error)` and parser `state` exists, set `state.pendingOverflowErrorMessage` to the non-empty raw error or the existing overflow fallback.
- If `rawEvent.willRetry === false`, surface a terminal non-empty error result; otherwise return `null` and let `compaction_start`, `compaction_end`, final `agent_end`, or EOF determine the outcome.
- If parser `state` is absent, preserve the conservative terminal error result behavior.
- Keep generic non-overflow failed prompt responses terminal.
- Update comments in `pi-rpc-protocol.ts` so failed prompt-response overflow is documented next to the already-handled overflow `agent_end` path.

### Task 2: Cover prompt-response overflow success and pending-state cleanup

- Add `parsePiEvent` unit coverage proving a failed prompt response with `context_length_exceeded` and parser state returns `null` rather than `error_during_execution`.
- Add `readPiStream` integration coverage for failed prompt-response overflow → `compaction_start` → successful final `agent_end`; assert the intermediate error is not yielded, `reset_response_text` is yielded from `compaction_start`, and the final answer is delivered.
- Assert pending overflow state is cleared after the successful final result so a later EOF does not yield a stale overflow error.

### Task 3: Cover prompt-response overflow failure paths

- Add coverage for failed prompt-response overflow followed by `compaction_end` with `success=false` or an error string; assert a non-empty `error_during_execution` result is yielded.
- Add EOF fallback coverage for failed prompt-response overflow followed by stdout end; assert a non-empty `error_during_execution` result is yielded.

### Task 4: Preserve existing prompt-response regressions

- Ensure a generic non-overflow failed prompt response still returns terminal `error_during_execution` immediately.
- Ensure the `already processing` prompt rejection remains non-terminal.
- Run the focused Pi RPC protocol test before full validation.

### Task 5: Validate and prepare PR evidence

- Run the validation commands listed above.
- Keep issue/PR text sanitized: no private chat IDs, local user paths, tokens, or transcript payloads.
- Update the PR summary to mention that this complements v2026.6.0 / PR #23 by handling the failed prompt `response` overflow shape as well as the prior `agent_end` shape.
