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

1. Refactor the existing deferred-overflow bookkeeping into a small helper if useful, or keep the code inline if simpler. Avoid a broad abstraction.
2. In `parsePiEvent`, inside `case "response"` and `rawEvent.success === false && rawEvent.command === "prompt"`:
   - Preserve the current first check for `isPiAlreadyProcessingRejection(rawEvent.error)` → log + `return null`.
   - Then check `isContextOverflowError(rawEvent.error)`.
   - If there is parser state:
     - if `rawEvent.willRetry === false`, surface a terminal non-empty error result;
     - otherwise set `state.pendingOverflowErrorMessage` to the non-empty raw error/fallback;
     - if `rawEvent.willRetry === true`, emit the existing `reset_response_text` control request;
     - if retry intent is unknown, return `null` and let subsequent `compaction_start` / `compaction_end` / final `agent_end` or EOF decide.
   - If there is no parser state, keep the conservative terminal error result behavior.
3. Keep `compaction_start`, `compaction_end`, final successful `agent_end`, and EOF fallback semantics shared with the existing #22 path.
4. Update comments/docs in `pi-rpc-protocol.ts` so they mention both overflow shapes: `agent_end` and failed prompt `response`.

## Tests

Add focused tests in `src/__tests__/pi-rpc-protocol.test.ts`:

1. `parsePiEvent` unit: failed prompt response with `context_length_exceeded` + parser state returns `null` and records pending overflow instead of returning an error result.
2. `readPiStream` integration: failed prompt response overflow → `compaction_start` → `compaction_end` with `willRetry=true` → final successful `agent_end`; assert no intermediate `error_during_execution` is yielded and final result text is delivered. Assert one `reset_response_text` control request appears.
3. Failure path: failed prompt response overflow → `compaction_end` with `success=false` or error text; assert a non-empty `error_during_execution` result is yielded.
4. EOF fallback: failed prompt response overflow then stdout ends; assert a non-empty `error_during_execution` result is yielded.
5. Regression: generic non-overflow failed prompt response still returns terminal `error_during_execution` immediately.
6. Regression: `already processing` prompt rejection remains non-terminal.

## Validation commands

```bash
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/pi-rpc-protocol.test.ts
npm test
npm run lint
npm run build
git diff --check
npm pack --dry-run
```
