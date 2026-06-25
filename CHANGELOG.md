# Changelog

## Unreleased

## 2026.6.1

- Fix Pi RPC prompt-response context-overflow recovery: failed prompt responses with `context_length_exceeded` now defer to Pi compaction/continuation instead of surfacing the intermediate provider error.
- Add regression coverage for prompt-response overflow recovery, compaction failure, EOF fallback, non-retryable overflow, stateless calls, and non-string errors.

## 2026.6.0

- Fix Pi RPC context-overflow recovery relay: intermediate pre-compaction `agent_end` records no longer silently finalize Telegram turns before post-compaction output arrives.
- Surface terminal Pi RPC error-only `agent_end` records as visible errors instead of sending nothing.
- Add regression coverage for overflow retry, failed compaction, EOF fallback, explicit non-retry overflow, and relay reset handling.

- Imported the bot package into the public `minime-bot` repository.
- Documented the package-root architecture: runtime code and Pi extensions live
  in this package, while production config and agent workspace state live in an
  external control workspace.
- Documented the package CLI, workspace selection through `--workspace` or
  `MINIME_CONTROL_WORKSPACE_ROOT`, and the validation commands for pull
  requests.
- Clarified that the current runtime path is Pi/Codex based.
