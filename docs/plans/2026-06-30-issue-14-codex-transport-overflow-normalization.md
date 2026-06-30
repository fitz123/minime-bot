# Plan: Issue #14 Codex transport byte-size overflow normalization

## Goal

Make Pi-backed bot sessions recover when Codex/OpenAI fails before streaming with `WebSocket closed 1009 message too big` and large `requestBytes`, instead of retrying/resuming forever and showing users only `Codex SSE response headers timed out after 20000ms`.

## Evidence

- Public issue: `fitz123/minime-bot#14`.
- Production sanitized recurrence on 2026-06-30:
  - transcript grew to about 65 MB;
  - repeated visible error: `Codex SSE response headers timed out after 20000ms`;
  - assistant diagnostics: `WebSocket closed 1009 message too big`, `phase=before_message_stream_start`, `requestBytes≈24.8MB`;
  - `/reconnect` resumed prior context and reproduced the same failure; a clean/fresh session stopped the loop.
- Vendor trace from `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`:
  - `_handlePostAgentRun()` checks `_isRetryableError()` before `_checkCompaction()`.
  - `_isRetryableError()` excludes only messages recognized by Pi's `isContextOverflow()`.
  - Pi's overflow detector in `@earendil-works/pi-ai/dist/utils/overflow.js` matches `context_length_exceeded`/token-window text but not WebSocket 1009 diagnostics.
- Extension hook evidence:
  - `message_end` handlers may replace the assistant message before persistence and before `_lastAssistantMessage` is checked for retry/compaction.

## Approach

Add a first-party Pi extension wrapper that normalizes only the Codex transport byte-size overflow shape on assistant `message_end`:

- detect assistant messages with `stopReason: "error"` and diagnostics indicating provider transport failure before stream start:
  - error code `1009`, or diagnostic/error text containing both `message too big` and WebSocket/1009 signal;
  - optionally include numeric `details.requestBytes` in the sanitized replacement text;
- replace `errorMessage` with a Pi-recognized overflow string prefixed by `context_length_exceeded:`;
- keep all other message fields intact;
- do not log transcript content, local paths, chat IDs, usernames, or raw stacks.

Why `message_end`, not only the bot relay parser: Pi must see the normalized error before `_isRetryableError()` / `_checkCompaction()`. Relay-only classification would still be too late; Pi would already be in retry behavior and would not compact.

## Tasks

### Task 1: Add pure normalizer helper

- [x] Add `src/pi-extensions/codex-transport-overflow.ts` with small testable helpers:
  - `isCodexTransportMessageTooBigDiagnostic(...)`.
  - `normalizeCodexTransportOverflowAssistantMessage(...)`.
- [x] Require assistant role + `stopReason === "error"`.
- [x] Require a diagnostic signal, not the generic timeout string alone, so ordinary transient timeouts remain retryable.
- [x] Preserve diagnostics and content; only replace `errorMessage` when normalization applies.

### Task 2: Add wrapper and package wiring

- [x] Add `extensions/pi/codex-transport-overflow.ts` registering `pi.on("message_end", ...)`.
- [x] Add the wrapper to:
  - `PI_EXTENSION_WRAPPER_RELPATHS`;
  - `PI_EXTENSION_ARTIFACT_WRAPPER_RELPATHS`;
  - `scripts/build-package-artifacts.mjs` wrapper list.
- [x] Load it for normal interactive bot sessions. It does not need to be model-callable and should not register tools.

### Task 3: Ensure user-visible error text is diagnostic, not misleading

- [x] When normalization applies, set `errorMessage` to a sanitized string that contains the real cause, e.g. `context_length_exceeded: Codex request too large (WebSocket 1009 message too big; requestBytes=...)`.
- [x] If compaction succeeds, the user should see the recovered answer, not the intermediate transport error.
- [x] If compaction/recovery fails, the user-visible fallback must include the real `1009/message too big/request too large` signal, not only `Codex SSE response headers timed out after 20000ms`.
- [x] Do not treat the generic SSE timeout alone as the root cause; it is a wrapper/secondary symptom unless paired with diagnostics.

### Task 4: Tests

- [ ] Unit-test normalization for:
  - code `1009` + `message too big` + `phase=before_message_stream_start` + `requestBytes`.
  - string-only diagnostic with WebSocket 1009/message-too-big wording.
  - generic `Codex SSE response headers timed out` with no diagnostic stays unchanged.
  - transient WebSocket/network errors without message-too-big stay unchanged.
  - non-assistant / non-error messages stay unchanged.
- [ ] Test that the normalized error text is suitable for user-facing fallback if recovery fails.
- [ ] Existing Pi RPC overflow tests should continue to pass.

### Task 5: Validation and PR

Run:

```bash
npm test -- src/__tests__/pi-rpc-protocol.test.ts src/__tests__/pi-extensions-codex-transport-overflow.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
```

- [ ] Open/update PR against `main`, run `gh pr checks`, and keep issue #14 open only if another transport-overflow variant remains unfixed.

## Non-goals

- Do not disable `/reconnect` resume globally.
- Do not parse or truncate private transcript payloads.
- Do not change Pi vendored source in `node_modules`.
- Do not make all WebSocket timeouts non-retryable; only the diagnostic 1009/message-too-big byte-size path is overflow.
