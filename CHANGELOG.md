# Changelog

## Unreleased

## 2026.7.6

- Resolve every package-owned Pi process through the shipped 0.80.6 CLI and exact-pin all Pi runtime packages, removing dependence on a global `pi` executable.
- Finalize accepted Pi RPC turns on `agent_settled` so retry, compaction, and continuation remain inside one terminal lifecycle while preserving errors, metrics, steering, and delivery authority.
- Fail closed with correlated cancellation for unsupported blocking extension UI dialogs, including startup-time requests, so sessions cannot wedge before registration.
- Exact-pin grammY 1.44.0 without enabling Rich Messages or changing the existing draft scheduler.

## 2026.7.5

- Track real Telegram `getUpdates` progress so healthy quiet polling remains stable while stalled polling or API failure still triggers one bounded launchd recovery.
- Add Node-independent host-native Telegram alert delivery, Alertmanager webhook handling, runtime health checks, launchd/config examples, and a monitoring recovery runbook.
- Harden monitoring secret isolation, request deadlines, deduplication, corrupt-state recovery, bounded concurrency, and cross-version media retry tests.

## 2026.7.4

- Reject saturated debounce/collect queue input with bounded user-visible notices and queue-rejection metrics instead of silently dropping messages.
- Retry transient media downloads with bounded backoff, cleanup, redacted stage-specific diagnostics, and consistent Telegram/Discord failure replies.
- Coalesce and throttle Telegram DM drafts with one in-flight request, `retry_after` pauses, typing coordination, bounded cleanup, and separate cosmetic-throttling metrics.

## 2026.7.3

- Make long-message delivery splitting Unicode-safe and locale-independent, preserving Cyrillic and non-BMP characters while enforcing Telegram's UTF-16 message limit.

## 2026.7.2

- Log and notify bounded diagnostics for failing script-mode crons by wrapping captured stdout/stderr and process metadata in cron failure diagnostics.

## 2026.7.1

- Auto-reconnect active Pi sessions when an agent's configured model or thinking level changes, while preserving the stored Pi session id/context.
- Persist session runtime metadata (`provider`, `model`, `thinking`) for observability and log stored-session resumes under updated runtime config.

## 2026.7.0

- Allow satellite agent workspaces to load trusted shared platform rules through a narrow `.claude/rules/platform` symlink to the configured main workspace platform rules directory.
- Keep arbitrary out-of-workspace symlinks blocked and add regression coverage for trusted, untrusted, and cache invalidation paths.

## 2026.6.3

- Normalize Codex WebSocket 1009/message-too-big transport failures into Pi-recognized context overflow recovery so oversized Codex requests trigger compaction instead of retry loops.
- Preserve real request-too-large diagnostics in fallback errors and avoid stale Pi child/stdout reuse after overflow fallback.

## 2026.6.2

- Add first-party `ask_agent` Pi extension for trusted full-agent inter-agent questions.
- Add `askAgent` config, trusted Pi session agent identity env propagation, target context spawn, bounded timeout/error handling, and regression coverage.

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
