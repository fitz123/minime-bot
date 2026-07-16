# Issue #71: Durable Tavily quota monitoring and incidents

## Overview

Keep Tavily as the sole provider behind the existing `web_search` and `web_fetch` contracts, while making account usage, exhaustion, acknowledgement, and verified recovery durable and observable. Use the existing single `tavily.api_key` SOPS contract; do not add alternate providers, fallback, key rotation, billing mutation, or a generic incident framework.

## Context

- `src/pi-extensions/tavily.ts` and `extensions/pi/web-tools.ts` already implement Search/Extract, secret-safe request construction, graceful tool errors, and query/URL egress guards.
- Pi tools execute in child processes, while `src/main.ts` owns Telegram and Prometheus. Reuse the package's private atomic-file and polled-spool patterns (`SessionStore`, `EchoWatcher`) to hand sanitized tool failures to one main-process Tavily monitor without exposing queries, URLs, credentials, or host paths.
- Store the specialized Tavily state, notification outbox, and unique child-event spool under the resolved control-workspace `data` directory. The main monitor is the sole consolidated-state writer and serializes sampler, spool, delivery, and operator-action transitions.
- Use the existing owner delivery configuration (`adminChatId`, otherwise `defaultDeliveryChatId` plus its optional thread) rather than introducing private destinations in source. Missing/invalid delivery configuration remains a durable diagnostic error instead of an infinite retry.
- Tavily `/usage` exposes key/account usage and account plan/PAYGO limits, but no guaranteed reset timestamp. Use a stable monthly billing-cycle generation and report reset only when provider data makes it known.

## Development Approach

- Keep successful tool schemas and rendered results backward-compatible; change only sanitized failure classification and incident side effects.
- Add one Tavily-specific monitor/state module, not a provider abstraction or second general recovery stack.
- Reuse owner-only directories, same-directory atomic rename, unique JSON spool files, startup drain, short polling, and dependency-injected clocks/fetch/delivery for deterministic tests.
- Default usage sampling is five minutes; unacknowledged exhaustion reminders are six hours. Constants remain fixed package defaults unless tests need injected values.
- No automatic request retries or provider fallback. Recovery probes are bounded and run only for an explicit recheck or once when an active incident's usage state transitions to recoverable.

## Testing Strategy

- Pure tests cover usage parsing, bounded HTTP classification, threshold and incident generations, state transitions, fixed probes, and redaction.
- Filesystem tests cover owner-only atomic state, restart restoration, unique child events, startup drain, and delivery outbox dedup/retry.
- Telegram, status, metrics, lifecycle, and installed-package tests cover integration without real provider or Telegram calls.
- Existing Tavily egress suites remain regression gates.

## Implementation Steps

### Task 1: Classify Tavily requests and emit sanitized child events
- [x] In `src/pi-extensions/tavily.ts`, add a typed Tavily failure classifier for missing/invalid credential or HTTP 401, HTTP 429, base-plan exhaustion 432, PAYGO exhaustion 433, transport/5xx outage, and extraction failure; never retain provider bodies, queries, URLs, or keys in returned diagnostics/events.
- [x] Preserve `WEB_SEARCH_TOOL` and `WEB_FETCH_TOOL` schemas and successful formatting; make failure text explicitly distinguish the bounded classes and treat an empty/failed Extract response as extraction failure while retaining useful partial Extract results.
- [x] Add a small owner-only unique-event writer under the resolved control-workspace data path and have `extensions/pi/web-tools.ts` emit only `{version, tool, classification, httpStatus, observedAt}`; 432/433 event persistence must happen before the tool returns.
- [x] Keep the existing SOPS lookup and all query/URL/DNS egress guards unchanged, and pass the Pi cancellation signal through bounded requests without adding retries.
- [x] Extend `src/__tests__/tavily.test.ts` with all classifications, Search/Extract 432/433 events, extraction failure, missing secret, transport/5xx, redaction, event-file safety, unchanged schemas/success output, and complete existing egress regressions.
- [x] Run the focused Tavily tests and typecheck before Task 2.

### Task 2: Implement the durable usage/incident state machine
- [ ] Add a Tavily-specific module that builds/parses authenticated `GET /usage`, validates key/account/base-plan/PAYGO counters, derives the monthly billing-cycle generation, and exposes fixed sanitized Search and Extract recovery probes with explicit timeouts and no retries.
- [ ] Implement one versioned owner-only state document under the control-workspace data directory with atomic same-directory replacement: latest sample/classification, bounded diagnostics, threshold-delivery keys, one active exhaustion incident generation, generation-scoped acknowledgement/resolution, and a durable notification outbox.
- [ ] Deduplicate plan and PAYGO 80% warnings and 95% critical warnings by billing-cycle/scope/threshold generation; include only provider, usage, limit, remaining credits, reset when known, affected tools, and the fixed Tavily Billing URL.
- [ ] Ingest the child-event spool with startup drain plus the existing short polling pattern. A 432/433 from either tool opens or refreshes the same active critical generation and durably queues its immediate notification; only a later post-resolution exhaustion creates a new generation.
- [ ] Queue one six-hour reminder cadence for an active unacknowledged generation, stop reminders on acknowledgement or resolution, and keep notification keys idempotent across process restarts.
- [ ] Implement one shared verification path for explicit recheck and automatic recovery: current `/usage` plus both fixed probes must succeed before persisting resolution and queuing exactly one recovery notice; dedupe automatic probes by the observed recoverable usage transition.
- [ ] Add focused state-machine/filesystem tests for malformed usage, 80/95 transitions, cycle rollover, concurrent child events, 432/433 refresh, acknowledgement, later generations, six-hour cadence, failed/successful recheck, automatic recovery, atomic restart persistence, and no private fields.
- [ ] Run the focused quota-state tests and typecheck before Task 3.

### Task 3: Wire lifecycle, durable delivery, and Telegram actions
- [ ] Add a lifecycle-managed Tavily monitor to `src/main.ts`: restore/drain state, sample immediately and every five minutes, process due child events/outbox entries, and stop all timers cleanly during shutdown.
- [ ] Deliver through the existing grammY bot API and configured owner/admin destination. Persist success before removing work; retry transient transport/429/5xx delivery with bounded backoff, while recording deterministic destination/4xx errors as visible terminal outbox diagnostics rather than retrying forever.
- [ ] Add generation-bound inline actions for “acknowledge degraded mode” and “credits fixed — recheck” in `src/telegram-bot.ts`; accept them only from the configured destination/thread and only for the current active generation, answer stale/unauthorized callbacks safely, and include `callback_query` in polling updates.
- [ ] Keep recheck single-flight and bounded; report failure without resolving, and use the same successful resolution path as sampler recovery.
- [ ] Add lifecycle and Telegram tests for startup drain, timer idempotence/shutdown, transient delivery retry, deterministic delivery failure, restart deduplication, exact destination authorization, stale generation actions, acknowledgement, single-flight recheck, and callback updates.
- [ ] Run focused lifecycle/Telegram tests and typecheck before Task 4.

### Task 4: Expose safe diagnostics and Prometheus metrics
- [ ] Extend `src/metrics.ts` with low-cardinality Tavily gauges/counters for sample freshness/success, plan and PAYGO usage/limits, active/acknowledged incident state, bounded failure classes/tools, and notification outcomes; never label by key, query, URL, destination, generation, or host path.
- [ ] Extend `/status` through `src/status-report.ts` and `src/telegram-bot.ts` with a compact Tavily block showing sample freshness, plan/PAYGO usage, last bounded failure class, and incident/acknowledgement state without private values.
- [ ] Restore metrics and diagnostics from durable state on startup and update them after every serialized transition.
- [ ] Add `src/__tests__/metrics.test.ts`, `src/__tests__/status-report.test.ts`, and monitor integration assertions for exact metric names, bounded labels, stale/missing/error states, and secret/private-data absence.
- [ ] Run focused metrics/status tests and typecheck before Task 5.

### Task 5: Package, document, and validate the complete contract
- [ ] Update `README.md`, `src/pi-extensions/README.md`, and `docs/monitoring.md` with the single-key Tavily contract, default cadences, durable state/incident behavior, operator actions, diagnostics/metrics, manual PAYGO requirement, and rollback behavior; do not publish deployment identifiers or local paths.
- [ ] Update `src/__tests__/package-install.test.ts` and package-artifact assertions so the installed package includes and exercises the monitor/core and generated web-tools wrapper from an arbitrary control workspace.
- [ ] Run all focused Tavily/Telegram/lifecycle/metrics/status/package tests, then `npm test`, `npm run build`, `npm pack --dry-run`, `npm run check:schema-guard-contract`, `git diff --check`, and a public-data scan.
- [ ] Verify `git diff --stat main...HEAD` contains only issue #71 implementation, tests, docs, and this completed plan, with no Brave/fallback/multi-key/provider abstraction or billing automation.

## Technical Details

- Fixed recovery probes: basic Search for `Tavily API documentation` with one result and no answer, and basic Extract of `https://example.com/`. A 2xx alone is insufficient; each probe must produce a non-empty validated result.
- The child spool is an at-least-once handoff. The monitor commits its state/outbox transition before deleting an event, and idempotent event/notification keys make replay safe.
- Threshold notification keys use billing-cycle generation, quota scope (`plan` or `paygo`), and threshold (`80` or `95`). Incident acknowledgement and action callback data carry only the bounded incident generation.
- Provider response bodies are neither logged nor persisted. Tool output, state, metrics, and notifications use fixed classification text only.

## Post-Completion

Use the normal feature PR, review/CI, CalVer release PR/tag, package validation, deploy/restart, live metrics/status/tool smoke, and full tail audit. Before closure, verify Tavily `/usage` reports `account.paygo_limit = 1250`; PAYGO and its credit limit remain manual Tavily Billing operations.
