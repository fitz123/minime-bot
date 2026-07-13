# Plan: Pi 0.80.6 lifecycle/UI compatibility and grammY 1.44.0 (#53)

## Goal

Land issue #53 as one compatibility PR with four reviewable commits: make every package-owned Pi process use the locked Pi 0.80.6 runtime, finalize RPC turns only after `agent_settled`, cancel unsupported blocking extension dialogs instead of hanging, and exact-pin grammY 1.44.0 without enabling new UX features.

## Verified current state and root cause

- `package.json` and `package-lock.json` resolve all four direct Pi packages to 0.79.0 and grammY to 1.41.1, while interactive and cron paths still spawn bare `pi` (`src/pi-rpc-protocol.ts`, `src/cron-runner.ts`). A global Pi upgrade can therefore change the live protocol independently of the package lock.
- Pi 0.80.6 exports `@earendil-works/pi-coding-agent/rpc-entry`; its package CLI and RPC entry can be resolved from the installed dependency. `src/codex-quota-sampler.ts` already demonstrates package-local bin/CLI resolution and should share, not duplicate, the new resolver.
- Pi 0.80.6 defines `agent_end` as a low-level run boundary and `agent_settled` as the only boundary after retry, overflow compaction, and queued continuation. `parsePiEvent` currently emits a terminal result at `agent_end`, and `SessionManager` stops reading on that result.
- `extension_ui_request` is currently ignored. Pi keeps no-timeout `select`/`confirm`/`input`/`editor` promises pending until a same-ID `extension_ui_response` arrives; the bundled subagent extension has a reachable no-timeout `confirm` call.
- The existing `DraftScheduler` and final-delivery path are authoritative and already cover coalescing, one in-flight draft, bounded 429 handling, and final `sendMessage` delivery.

## Sequencing and rollback principles

- Commit each task independently in the order below. Tasks 2–3 rely on the Pi 0.80.6 contract from Task 1; Task 4 is dependency-only.
- Keep subprocess isolation and the RPC transport (ADR-063/072). Do not introduce SDK embedding or global PATH fallback.
- Preserve configured thinking levels through `xhigh`; `max` remains unsupported by this change.
- Do not edit this plan after Ralphex starts. Review and validation use `main` as the explicit base.
- Rolling back the feature PR restores all four prior contracts atomically; no workspace/config migration is required.

## Validation commands

```bash
npm test
npm run build
npm pack --dry-run
npm ls --depth=0 @earendil-works/pi-agent-core @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui grammy
```

## Tasks

### Task 1: Pin and resolve the package-owned Pi 0.80.6 runtime

- [x] Exact-pin `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui` to 0.80.6 in `package.json`; refresh `package-lock.json` and assert one aligned direct version set.
- [x] Add one shared ESM-safe resolver module for package-owned Pi invocation. Resolve the exported `@earendil-works/pi-coding-agent/rpc-entry` for RPC mode and the sibling package CLI/bin for print mode; execute JS entrypoints with `process.execPath`. Fail loudly if the locked entrypoint is absent—never fall back to bare `pi`.
- [x] Use the resolver in `spawnPiRpcSession`, `runPi`, `resolvePiInvocation` fallback, and the quota sampler. Preserve self-reuse when a child already runs from the package-owned Pi entrypoint; cover subagent and ask-agent children through their existing shared invocation helper.
- [x] Add a non-sensitive startup/version diagnostic containing expected package version, selected entrypoint kind, and detected mismatch state, but not an absolute host path. Do not add `thinking:max`.
- [x] Update spawn/invocation/cron/quota/package-install tests to prove a missing or deliberately different global `pi` cannot affect package-owned RPC, cron, subagent, ask-agent, or sampler execution.
- [x] Run focused tests for Pi invocation, RPC spawn workspaces, cron runner, subagent, ask-agent, quota sampler, and package installation.
- [x] Commit this slice as `Pin package-owned Pi runtime to 0.80.6 (#53)`.

### Task 2: Finalize Pi turns on agent_settled

- [ ] Extend `PiRpcParseState` to retain the latest low-level `agent_end` outcome (success text or terminal error plus session metadata) without yielding a `ResultMessage` at `agent_end`.
- [ ] On each later `agent_end`, replace the retained outcome so retries/continuations settle on the final run. Keep overflow reset signalling and original-cause preservation, but do not surface a terminal recovery failure before Pi settles unless the prompt was rejected before acceptance or the process/stream ends.
- [ ] Add `agent_settled` handling that consumes the retained outcome and emits exactly one terminal result. If settlement arrives without a usable outcome, emit one explicit non-empty protocol error instead of an empty success.
- [ ] On EOF/close before settlement, surface the retained failure/outcome or a clear `Pi subprocess exited before agent_settled` error exactly once. Keep real prompt preflight rejection terminal; keep failed side-command responses nonterminal.
- [ ] Update `readPiStream`, comments, and SessionManager integration so metrics, busy state, duration, retry telemetry, stream text reset, session persistence/resume, steering, and follow-up queues remain active until the settled result.
- [ ] Replace old `agent_end is terminal` fixtures with sequences for: one run then settled; multiple retry runs; overflow compaction retry; queued continuation; final error; settlement without outcome; prompt rejection; and EOF before settlement. Assert one result and no duplicate/stale text.
- [ ] Run focused Pi protocol, SessionManager, stream relay, queue, metrics, and resume tests.
- [ ] Commit this slice as `Finalize Pi RPC turns on agent_settled (#53)`.

### Task 3: Fail closed for blocking extension UI requests

- [ ] Extend RPC record types with the request ID and method needed for `extension_ui_request`; validate both are non-empty strings before acting.
- [ ] Extend the command union and centralized JSONL stdin writer with `extension_ui_response`. For `select`, `confirm`, `input`, and `editor`, construct `{type:"extension_ui_response", id, cancelled:true}` using the exact request ID.
- [ ] Route cancellation controls inside `readPiStream`/the shared child-stdin path before user-facing stream delivery. Do not yield them as assistant text, do not classify their command responses as prompt results, and do not truncate an active turn.
- [ ] Ignore fire-and-forget UI methods as today. Unknown/malformed requests remain ignored and logged without echoing titles/messages/options.
- [ ] Add pure parser/command tests plus capturing-child integration fixtures for all four blocking methods. Include no-timeout `confirm` and `editor`, interleaved command responses, a normal `agent_end` + `agent_settled`, destroyed stdin, and malformed/missing IDs; assert no hang and exactly one final result.
- [ ] Run focused Pi protocol, SessionManager, subagent, ask-agent, and package-install extension tests.
- [ ] Commit this slice as `Cancel unsupported Pi RPC dialogs safely (#53)`.

### Task 4: Exact-pin grammY 1.44.0 and run compatibility gates

- [ ] Change only the grammY dependency contract to exact `1.44.0`; refresh the lockfile and verify clean install/runtime resolution. Keep `@grammyjs/auto-retry` unchanged unless npm lock resolution requires metadata-only movement.
- [ ] Compile against Bot API 10.1 types without adding Rich Message calls, `@grammyjs/stream`, new commands, or Telegram interaction features.
- [ ] Preserve `sendMessageDraft` outside autoRetry, the bounded/coalescing DraftScheduler, HTML-to-plain fallback, authoritative final delivery, topics, polling, media, and retry behavior. Add/adjust regression assertions only where 1.44.0 types require it.
- [ ] Run Telegram adapter/bot, stream relay, polling, media, package-import, package-install, and full test suites.
- [ ] Run `npm test`, `npm run build`, `npm pack --dry-run`, `git diff --check`, and verify `git diff --stat main...HEAD` contains only issue #53 implementation/tests/plan/dependency lock changes.
- [ ] Confirm no `/cancel`, Telegram dialog buttons, input/editor bridge, Rich Messages, stream plugin, thinking:max, session-tree UI, watchdog, SDK embedding, or unrelated refactor entered the diff.
- [ ] Commit this slice as `Pin grammY 1.44.0 compatibility contract (#53)`.

## Final acceptance

- Every package-owned Pi execution path is deterministic on locked 0.80.6 with no global `pi` fallback.
- Accepted prompts terminate once at `agent_settled`; preflight rejection and pre-settlement process exit remain explicit errors.
- All blocking extension dialogs receive correlated cancellation and cannot hang a run.
- grammY resolves exactly to 1.44.0 while existing Telegram delivery semantics remain unchanged.
- Full tests/build/pack pass from a clean feature branch and the review diff is scoped to `main`.
