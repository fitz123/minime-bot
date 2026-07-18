# Changelog

## Unreleased

## 2026.7.18

- Isolate cron-runner tests from ambient production log, health-metric, and control-workspace paths by resolving their environment at call time (#76).
- Preserve failed cron output and generation-failure notices in a durable single-slot-per-cron outbox with bounded retries, pickup-first redelivery, and explicit terminal evidence (#65).
- Defer launchd cron creates, updates, and deletes while jobs are active or their activity is unknown, and retry transient replacement and rollback bootstrap races (#62).

## 2026.7.17

- Treat semantically identical launchd cron plists as unchanged despite XML formatting or dictionary-key order differences, while failing safely on malformed parser output and preserving scalar types and array order.

## 2026.7.16

- Preserve an explicit validated cron runner during launchd cron generation and sync, including atomic release-slot selectors, narrow unchanged/create planning, and fail-closed zero-write validation.
- Add the inactive-by-default ADR-094 ops-worker core with strict task envelopes, atomic state/audit persistence, deterministic scheduling, bounded process supervision, and no production registrations or activation.

## 2026.7.15

- Replace Tavily with one package-owned Codex subscription OAuth `web_search` across interactive, delegated, cron, workflow, and recovery runtimes.
- Remove `web_fetch`, Tavily credentials, monitoring, incidents, metrics, and fallback paths; use the host-installed official `agent-browser` workflow for direct and rendered pages.

## 2026.7.14

- Strip the known trailing `Продолжение следует` ASR artifact at the shared transcription boundary while preserving legitimate occurrences and existing empty-transcript handling.

## 2026.7.13

- Accept Tavily `/usage` payloads with a nullable per-key limit while preserving strict account plan/PAYGO validation, successful sampling, and quota metrics.

## 2026.7.12

- Keep Tavily as the sole provider for `web_search` and `web_fetch` while adding five-minute quota sampling, durable acknowledgement-driven exhaustion incidents, and bounded recovery verification.
- Expose sanitized Tavily quota diagnostics and Prometheus metrics, including distinct credential, rate-limit, plan/PAYGO exhaustion, provider-outage, and extraction failures.

## 2026.7.11

- Make LLM cron jobs inherit the selected agent's normalized model for both context assembly and Pi execution instead of using a stale package-level pin.
- Reject blank agent model configuration and add regression coverage for agent-specific cron model isolation and spawn consistency.

## 2026.7.10

- Pre-seed a canonical owner-only Pi transcript before launching a fresh recovery session, avoiding Pi lazy-transcript startup deadlock before the first assistant turn.
- Verify the exact session ID and path through RPC before binding the incident generation while preserving exact resume, replacement, fencing, workspace-alias, and process-cleanup behavior.

## 2026.7.9

- Decouple internal recovery-agent lookup from unrelated transport secret materialization so the host-native recovery runner can bind its dedicated agent in a restricted environment.
- Preserve merged configuration and selected-agent validation without weakening recovery runner secret isolation.

## 2026.7.8

- Add the host-native recovery supervisor foundation with durable authenticated intake, incident correlation and fencing, deterministic verification, static controls, outboxes, automatic native fallback, bounded event retention, and stale-telemetry deferral.
- Add the full iterative same-user Pi recovery fixer with exact per-generation session resume, crash-safe action reconciliation, recoverable quarantine, independently verified outcomes, and durable detailed incident reports.
- Add independent two-slot recovery capsule and offline bot rollback tooling, plus an inert zero-capability root-helper protocol scaffold.

## 2026.7.7

- Preserve active Telegram work during connectivity loss by treating an unreachable API as degraded state instead of restarting the process.
- Consume delayed Telegram updates retained by Telegram while keeping Discord's existing stale-message policy unchanged.
- Let grammY own short polling retries and add a bounded recovery window before a reachable stalled poller can restart.

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
