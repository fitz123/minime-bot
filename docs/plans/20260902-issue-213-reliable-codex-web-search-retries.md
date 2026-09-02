# Reliable bounded retries for Codex `web_search`

## Goal

Make the package-owned Codex subscription `web_search` absorb observed transient timeout, rate-limit, transport, and provider-response failures instead of exposing the first failed attempt to an agent. A call retries for at most ten minutes, stops immediately on caller cancellation or a terminal failure, and either returns a useful non-empty search result or the last classified failure for the external caller to handle.

## Non-goals

- No alternate provider, endpoint, API-key path, or automatic browser/provider fallback.
- No search smoke/preflight, Minime concurrency limit, result cache, circuit breaker, durable state, new metrics family, dependency, generic retry framework, or configuration/env surface.
- No change to the model-facing tool schema, fixed Codex endpoint, 60-second per-attempt timeout, or direct-URL/`agent-browser` behavior.
- No retry of invalid/private input, auth failures, caller cancellation, or ordinary non-transient 4xx responses.
- No change or upstream contribution to external `pi-dynamic-workflows`; its empty-string/`done` behavior is outside the operator-selected scope.
- PR, review, release, deploy, and production smoke are parent-owned lifecycle stages after this implementation plan.

## Context

- `src/pi-extensions/codex-web-search.ts` currently validates input, resolves OAuth, performs one request, parses bounded SSE, and returns the first classified failure.
- `extensions/pi/web-tools.ts` is already a thin registration wrapper and should remain unchanged.
- A valid `Retry-After` can be read from response headers before the existing bounded body cancellation. RFC-defined numeric-seconds and HTTP-date forms are sufficient; raw provider headers and bodies remain private.
- Node's `node:timers/promises` provides the required abortable wait. Existing `src/voice.ts` behavior is prior art only; coupling the modules or adding a retry dependency would be larger than the required fix.
- Input/privacy validation must stay outside the retry loop. OAuth resolution stays inside each attempt so a later attempt can use a refreshed token.
- Operator decisions are recorded in [issue #213](https://github.com/fitz123/minime-bot/issues/213): one provider, no concurrency cap or smoke, ten-minute wall-clock boundary, no separate attempt-count cap, and caller-owned alternatives after exhaustion.

## Design

1. Keep deterministic query normalization and egress validation before the loop.
2. Isolate the existing network path as one private attempt in the same source file; do not duplicate transport or parser logic. Each attempt resolves OAuth, uses a timeout no greater than both 60 seconds and the remaining total window, cleans up its response/reader, and returns its existing classified result plus an internal parsed `Retry-After` value when present.
3. Retry post-validation `timeout`, `rate_limit`, `transport`, and provider-response `schema` failures. Keep `auth`, caller abort, and `unknown` ordinary 4xx terminal. A persistent provider contract problem is bounded by the same ten-minute deadline.
4. Use a strict `600_000 ms` monotonic wall-clock budget and no attempt-count condition. Prefer a valid `Retry-After`; if it exceeds the remaining budget, return immediately. Otherwise use a small exponential delay with random jitter and a bounded delay cap to avoid synchronized parallel retries. Never jitter below a server-requested minimum.
5. Every wait is abortable. Check caller cancellation and remaining time before a retry, before waiting, and before starting the next attempt. Exhaustion returns the last existing failure classification rather than inventing a new model-facing failure type.
6. Preserve bounded secret-safe diagnostics. Add only the minimum attempt/delay/elapsed fields needed to distinguish scheduled retry from terminal exhaustion; never include query text, URLs, provider bodies, raw headers, OAuth data, or credentials.
7. Keep timing/random/sleep seams private to the helper dependency object only where deterministic fast tests require them; they are not runtime configuration.

## Validation Commands

```bash
npm run test:file -- src/__tests__/codex-web-search.test.ts
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

## Tasks

### Task 1: Add the ten-minute retry boundary, focused tests, and truthful documentation [HIGH]

**Goal:** Implement the complete minimum-sufficient retry behavior without changing provider, tool schema, concurrency, or external workflow behavior.

**Serves:** Ninja's requirements to retry timeout and HTTP 429 failures persistently, use progressive/exponential backoff, retain one provider and unrestricted workflow fan-out, stop after ten minutes for caller-owned alternatives, and apply the Ponytail minimum-code ladder.

**Files:**

- Modify: `src/pi-extensions/codex-web-search.ts`
- Modify: `src/__tests__/codex-web-search.test.ts`
- Modify: `README.md`
- Modify: `docs/monitoring.md`
- Modify: `src/pi-extensions/README.md`
- Verify unchanged: `extensions/pi/web-tools.ts`

- [ ] Refactor only the post-validation request path in `src/pi-extensions/codex-web-search.ts` into one private attempt and add the strict ten-minute, cancellation-aware, no-attempt-cap retry loop described above.
- [ ] Parse numeric and HTTP-date `Retry-After` before response cleanup; otherwise apply simple jittered exponential backoff using only Node/platform primitives.
- [ ] Preserve existing result classifications and privacy bounds while adding minimum secret-safe retry scheduling/exhaustion details.
- [ ] Add compact table-driven tests covering first-attempt success; recovery after more than two 429s with both `Retry-After` forms and fallback backoff; timeout, transport/5xx, and provider-schema recovery; refreshed OAuth per attempt; body/reader cleanup; and success after more than forty fast virtual attempts to prove no hidden attempt cap.
- [ ] Add deterministic deadline/cancellation tests covering strict ten-minute exhaustion without real waiting, `Retry-After` beyond the remaining window, a final timeout clamped to remaining time, abort during request/backoff, and no retry for input/privacy/auth/ordinary-4xx failures.
- [ ] Update the three existing web-search documentation sections and module comment to describe bounded transient retries, ten-minute exhaustion, caller cancellation, one fixed provider, and absence of fallback/concurrency quota.
- [ ] Run the focused test, both TypeScript typechecks, build, full suite, and package dry-run; inspect the final diff to confirm only the five listed files changed and all Non-goals remain excluded.
