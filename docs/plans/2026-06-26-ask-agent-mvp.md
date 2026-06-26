# Plan: Ask Agent MVP

## Goal

Implement a first-party `ask-agent` extension for full-agent inter-agent questions. The caller asks a target agent; the extension spawns a one-shot full target child in the target workspace with the target's context/Knowledge/tools and returns the final answer.

Public issue: https://github.com/fitz123/minime-bot/issues/27

## Product constraints

- Trusted internal mesh, not a hostile multi-tenant sandbox.
- Target must be a full agent, not a read-only/limited-context stub.
- Any enabled agent can ask any other enabled agent unless config denies the pair.
- No `ask-agent` inside ask children; recursion is out of MVP.
- Do not use personal names, real handles, chat IDs, or local absolute paths in public repo tests/docs.
- Snapshot spawn only; intercom/live backend is future work.

## Code pointers

- `src/session-manager.ts` — `getOrCreateSession()` / `ActiveSession.agentId` know the current agent id when spawning RPC sessions; add the trusted caller env here.
- `src/pi-rpc-protocol.ts` — `PI_CHILD_ENV_KEY_ALLOWLIST` + `buildAllowedPiChildEnv()` (child env allowlist), model normalization, context prompt args, and `resolvePiExtensionArgs()` / `resolvePiExtraExtensionArgs()` (extension args). JSONL parsing via `parsePiRecord()`.
- `src/pi-context-assembler.ts` — `assemblePiContext(agent)` returns `PiContextArtifacts` (`systemPromptPath`, `appendSystemPromptPath`) for the target.
- `extensions/pi/subagent/index.ts` and `src/pi-extensions/subagent-args.ts` — reuse spawn/env/JSONL/wrapper-arg patterns (`buildSubagentSpawnArgs()`, `runSubagentChild()`, `getFinalOutput()`); model the new extension on this.
- `extensions/pi/web-tools.ts`, `extensions/pi/knowledge-tools.ts` — first-party wrapper convention for the new `ask-agent` wrapper.
- `src/types.ts` (`AgentConfig`) and `src/config.ts` (`validateAgent()`) — add `askAgent` config typing and validation.

## Validation Commands

```
npm test
npm run build
npm pack
```

All three must pass with no PII in output or fixtures. Latest run: 1665 tests, 0 fail.

## Tasks

### Task 1: Config schema and validation

- [x] Add `askAgent` config to `AgentConfig` with `enabled: boolean`, optional `canAsk?: string[]`, optional `deny?: string[]`.
- [x] Treat absent `canAsk` as wildcard allow (`["*"]`) for enabled targets.
- [x] Make `deny` override allow; support `deny: ["*"]` as deny-all for that asker.
- [x] Validate referenced agent IDs and wildcard usage in `validateAgent()`.
- [x] Add neutral unit tests for the new fields and policy resolution (use `agent-b`/`agent-c`-style ids).

### Task 2: Trusted caller identity env

- [x] Add `MINIME_ASK_CALLER_AGENT_ID` to the trusted RPC session spawn path in `session-manager.ts`, sourced from `ActiveSession.agentId`.
- [x] Add the key to `PI_CHILD_ENV_KEY_ALLOWLIST` in `pi-rpc-protocol.ts`.
- [x] Ensure the value comes from bot/session-manager state, not tool input, prompt text, cwd inference, or model-controlled data.
- [x] Add tests for present, missing, and empty caller env.

### Task 3: Ask-agent extension and policy

- [x] Add first-party wrapper `extensions/pi/ask-agent/index.ts` registering tool `ask-agent`, delegating to a pure helper `src/pi-extensions/ask-agent-args.ts`.
- [x] Read caller only from `MINIME_ASK_CALLER_AGENT_ID`; missing/empty -> structured `caller_unknown` error without spawn.
- [x] Resolve target id to `AgentConfig`; unknown -> structured `target_unknown` error without spawn.
- [x] Call `assemblePiContext()`; null or thrown assembly error -> structured `context_unavailable` error without spawn.
- [x] Enforce enabled/canAsk/deny policy with structured `not_enabled` / `denied` errors.
- [x] Return a structured result (`{ answer, truncated, needsClarification }`).

### Task 4: Full target child spawn

- [x] Build ask-agent child extension args from the target's normal RPC extension profile (first-party wrappers plus configured `extraExtensions`), then exclude `subagent` and `ask-agent`.
- [x] Do not assert this differs from the current minimal subagent child set; with today's built-ins it may be the same (`web-tools` + `knowledge-tools`).
- [x] Spawn Pi in the target `workspaceCwd` with that cwd, provider `"pi"`, and the normalized target model.
- [x] Wire target context like a normal RPC spawn: `systemPrompt` when present, `assemblePiContext()` artifacts (`systemPromptPath` / `appendSystemPromptPath`), plus a trusted preamble + fenced untrusted question.
- [x] Use a bounded timeout and a direct child `SIGTERM` -> `SIGKILL` kill path; no process-group kill in MVP because `subagent` is excluded.
- [x] Reuse/extract JSONL final-assistant parsing (`parsePiRecord()` / `getFinalOutput()`) and spawn helpers from subagent where practical.

### Task 5: Result handling, logging, and limits

- [ ] Implement answer truncation with a max char length, a byte cap, and a `…[truncated]` marker.
- [ ] Treat a child clarification question as a valid result with `needsClarification: true`.
- [ ] Ensure common logs contain only metadata: caller, target, duration, outcome/error code — never question or answer text.
- [ ] Add tests for timeout, child error, empty answer, truncation, and JSONL parse edge cases.

### Task 6: Hermetic package smoke and docs

- [ ] Add a DI/mock-spawn package smoke with temporary neutral workspaces and canned JSONL; do not run real Pi/network/auth in the package smoke.
- [ ] Update package docs/config examples using neutral placeholders.
- [ ] Run validation commands and keep the repo free of PII.
