# Codex `web_search` cutover and Tavily retirement (issue #85)

## Goal

Replace Tavily with one package-owned `web_search` backed by Codex Responses native web search over Pi's existing `openai-codex` subscription OAuth. Remove `web_fetch`. Expose `web_search` exactly once on every intended runtime surface and remove Tavily runtime, monitoring, incident, metric, and active documentation paths only after an isolated smoke of the exact built candidate passes.

This plan is immutable once Ralphex starts. Track execution in Ralphex progress rather than editing this file.

## Context

- Preserve the canonical model-facing name `web_search` and a compatible input schema. Do not add another search abstraction.
- The verified reference transport uses `https://chatgpt.com/backend-api/codex/responses`, an OAuth credential from Pi's `openai-codex` model registry, the active Codex model, native `web_search`, and streamed Responses events. It returned citations, web-action metadata, and token usage with `OPENAI_API_KEY` absent.
- `extensions/pi/web-tools.ts` is the canonical wrapper. The build emits `dist/extensions/pi/web-tools.js`, which the deployment's global Pi settings load; dynamic-workflow in-memory children inherit that deployed artifact.
- Interactive parent, package subagent, `ask_agent`, and recovery extension sets already include `web-tools` once. The cron extension set currently omits it.
- Bundled planner/reviewer/scout tool allowlists include `web_search` and `web_fetch`; keep those roles search-only where they currently lack Bash.
- The main runtime currently owns Tavily monitoring, usage/recovery requests, durable incidents/outbox delivery, Telegram acknowledge/recheck actions, status rendering, and `bot_tavily_*` metrics.
- Never use `OPENAI_API_KEY`, `api.openai.com` billing, an alternate provider, a hidden fallback, or a configurable credential-bearing base URL. Add no call-count, concurrency, daily, or monthly Minime search quota.
- Direct URL/browser work is outside this package tool: Bash-capable full agents use the official host `agent-browser`; roles without Bash remain search-only.
- Preserve truthful historical changelog entries and completed plans.

## Validation Commands

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

## Tasks

### Task 1: Implement the package-owned Codex search transport

- [x] Add a focused search core under `src/pi-extensions/` that obtains the refreshed `openai-codex` OAuth token and account id through the Pi extension execution context's model registry/auth storage, never by reading `OPENAI_API_KEY`.
- [x] Call only the fixed subscription endpoint `https://chatgpt.com/backend-api/codex/responses` with the active `openai-codex` model, native `web_search`, one bounded request, normal timeout/abort cleanup, and no alternate endpoint/provider fallback.
- [x] Parse streamed Responses events into bounded answer text (50,000-character cap), citations, selected provider/model, web-action metadata, response id, and token usage when returned; classify auth, rate-limit, timeout, transport, schema, and unknown failures without exposing provider bodies or credentials.
- [x] Rewire `extensions/pi/web-tools.ts` to register only `web_search` with the compatible current schema and safe query-content boundary. Do not register `web_fetch`. Keep Tavily modules intact until Task 3 passes.
- [x] Add focused tests for request shape, OAuth-only auth, active-model selection, SSE parsing, citations/metadata/usage, output cap, abort/timeout cleanup, failure classes, and absence of API-key or alternate-provider paths.

### Task 2: Propagate one registration to every runtime surface

- [x] Add `web-tools` to the cron extension list so LLM crons receive `web_search` once.
- [x] Assert interactive parent, package subagent, `ask_agent`, cron, and recovery extension inventories each load the canonical wrapper exactly once.
- [x] Verify dynamic-workflow children receive the globally deployed wrapper without adding a second registration path.
- [x] Update bundled planner/reviewer/scout allowlists to keep `web_search`, remove `web_fetch`, and avoid granting Bash solely for URL fetching.
- [x] Update protocol, package-install, spawn-workspace, subagent, ask-agent, cron, and recovery tests for the exact runtime matrix and tool inventory.

### Task 3: Pass the exact candidate evidence gate

- [x] Build the feature worktree and identify its `dist/extensions/pi/web-tools.js` artifact.
- [x] Run an isolated Pi process/session that explicitly loads only the built candidate wrapper while the deployed Tavily artifact remains untouched.
- [x] Execute one benign `web_search` call and prove the registered name is exactly `web_search`, registration count is one, auth type is OAuth, the endpoint/model are the approved subscription pair, `OPENAI_API_KEY` is absent, citations are useful, and metadata/usage are returned when supplied by Codex.
- [x] Stop without removing Tavily if any gate assertion fails.

### Task 4: Remove Tavily and `web_fetch` after the gate

- [x] Remove Tavily search, fetch, SOPS helper/constants, event-spool, monitor/runtime, usage/recovery, durable incident/outbox, Telegram acknowledge/recheck, Discord/Telegram status, and `bot_tavily_*` metric code plus provider-specific tests.
- [x] Remove `web_fetch` from recovery read-only/external-tool filters, bundled role definitions, documentation, and tests while preserving `web_search` as read-only where intended.
- [x] Update active `README.md`, Pi-extension/subagent documentation, and monitoring documentation for Codex `web_search` plus host `agent-browser` direct-URL workflows.
- [x] Leave historical changelog entries and completed plans unchanged.
- [x] Confirm no Tavily fallback, active provider config/secret contract, PAYGO path, or dormant `web_fetch` registration remains.

### Task 5: Validate packaging, residue, and public hygiene

- [ ] Run all Validation Commands and focused runtime-matrix tests.
- [ ] Confirm active source, extensions, tests, and docs contain no `tavily`, `web_fetch`, Tavily metric, or Tavily secret/config references; allow only truthful historical changelog and completed-plan matches.
- [ ] Confirm the packed artifact includes the canonical Codex wrapper and no Tavily modules.
- [ ] Verify the diff contains no credentials, private queries/URLs, identities, chat metadata, operational logs, or operator-local absolute paths.

## Post-Completion

Private rollout work, outside this public repository, must remove the Tavily encrypted-secret key and manifest consumer without printing values; retire stale provider scheduler wiring; update active cron/skill instructions from `web_fetch` to `agent-browser read`; record the deployed `agent-browser` version and manual/planned upgrade policy without `brew pin`; deploy/restart through the canonical package wrapper; and verify every runtime surface. A post-deploy canonical search failure triggers release-level rollback to the previous known-good package, never a provider switch.
