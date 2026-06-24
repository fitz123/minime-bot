# Plan: Do not finalize Pi RPC turns on pre-compaction overflow `agent_end`

## Goal

Fix issue #22: when Pi emits an `agent_end` for a failed context-overflow assistant before compaction/retry, minime-bot must not treat that intermediate event as the final Telegram answer. The user must either receive the post-compaction answer or a non-empty failure message.

Claude planning validation note: `claude -p` was attempted from the bot/launchd-like environment and failed with `401 Invalid authentication credentials`; proceed with this Codex plan.

## Context

Public issue: https://github.com/fitz123/minime-bot/issues/22

Observed failure shape, sanitized:

```text
assistant calls tools
provider returns assistant error with stopReason=error and context_length_exceeded
Pi appends a compaction entry and starts post-compaction continuation
minime-bot delivers nothing because it finalized the pre-compaction agent_end with empty text
```

Relevant code:

- `src/pi-rpc-protocol.ts`
  - `parsePiEvent()` maps every `agent_end` to a terminal `ResultMessage` using `extractFinalAssistantText(...)`.
  - It currently ignores assistant `stopReason`, `errorMessage`, and any retry/compaction intent on the raw event.
- `src/stream-relay.ts`
  - `extractText()` marks every `result` as final.
  - The relay breaks on that result and sends nothing when accumulated/result text is empty.
- Tests already cover Pi RPC event parsing in `src/__tests__/pi-rpc-protocol.test.ts` and read/relay flows in `src/__tests__/session-manager.test.ts`.

## Requirements

1. Do not finalize the stream on an intermediate `agent_end` whose final assistant message is an overflow error that Pi is going to recover from.
2. Continue reading the RPC stream through compaction/retry until the actual successful terminal answer.
3. If an error-only `agent_end` is truly terminal, surface a non-empty error result instead of silently producing no Telegram message.
4. Avoid broad retries that could duplicate side effects. This fix is relay classification, not a new blind retry mechanism.
5. Keep public code and tests free of private chat IDs, usernames, transcript paths, or other PII.

## Suggested implementation direction

- Add helpers in `src/pi-rpc-protocol.ts` to inspect the final assistant message from `agent_end.messages`:
  - final assistant text;
  - `stopReason`;
  - `errorMessage`.
- Add a conservative overflow classifier for relay purposes, matching messages like:
  - `context_length_exceeded`;
  - `exceeds the context window`;
  - `maximum context length` / `too many tokens` if appropriate.
- If raw `agent_end` indicates the run will retry/recover (for example Pi's `willRetry` field is true) and the final assistant is an overflow error, return `null` from `parsePiEvent()` so the relay keeps reading subsequent events.
- If the final assistant is an error with no text and no recovery pending, return an error `ResultMessage` with the sanitized `errorMessage` so stream-relay delivers a visible failure.
- Keep normal successful `agent_end` behavior unchanged.

## Validation Commands

```bash
npm test -- src/__tests__/pi-rpc-protocol.test.ts
npm test -- src/__tests__/session-manager.test.ts
npm run typecheck
```

If targeted npm test argument semantics do not work with Node's test runner, use the equivalent direct command with `node --experimental-test-module-mocks --import tsx --test <test-file>`.

## Tasks

### Task 1: Reproduce the relay classification bug in tests

- [x] Add a `parsePiEvent` regression test for a Pi `agent_end` whose final assistant has `stopReason: "error"`, `errorMessage` containing `context_length_exceeded`, empty/no text content, and `willRetry: true`.
- [x] Assert the event is ignored (`null`) so the stream is not finalized before compaction/retry output.
- [x] Add a sequence-level test where intermediate overflow `agent_end` is followed by a successful final `agent_end`; assert only the final answer becomes a terminal result.

### Task 2: Surface terminal error-only `agent_end`

- [x] Add a test for `agent_end` with final assistant `stopReason: "error"`, no assistant text, and no retry/recovery signal.
- [x] Assert it returns an error `ResultMessage` with non-empty text and `is_error: true`.
- [x] Preserve existing behavior for non-error `agent_end` with no text if tests require it, or update the test intentionally if the old behavior was the silent-drop footgun.

### Task 3: Implement the minimal parser fix

- [x] Implement helper(s) in `src/pi-rpc-protocol.ts` without changing transport/session-manager behavior.
- [x] Use raw Pi fields defensively; unknown event shapes must still not throw.
- [x] Keep normal successful multi-turn and single-turn tests passing.

### Task 4: Validate and update issue

- [x] Run focused tests and typecheck.
- [x] Update issue #22 with the fix summary and validation evidence after implementation.
