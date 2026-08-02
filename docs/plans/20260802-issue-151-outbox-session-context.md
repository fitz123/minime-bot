# Plan: Move file-delivery guidance out of per-message prompts

## Goal

Pass each interactive Pi session's deterministic outbox path through the package-owned `MINIME_OUTBOX` child environment variable, document that variable once in the static assembled Pi context, and stop appending identical file-delivery boilerplate to every user turn while preserving existing file delivery.

## Non-goals

- Do not add per-chat system-prompt injection or a first-prompt-only notice.
- Do not add a `share_file` tool.
- Do not change the intentional per-message chat header.
- Do not change cron outboxes, outbox cleanup/delivery semantics, or the post-response `sendOutboxFiles` path.
- Do not broaden the Pi child environment allowlist or redesign session startup ownership.

## Context

- `src/session-manager.ts` currently mutates every prompt with `appendOutboxInstruction(...)`. It spawns Pi before the startup generation guard and destructively prepares the per-chat outbox only after that guard.
- Preserve startup ownership ordering by deriving the deterministic path without mutation before spawn, passing that path through the existing explicit runtime-env options, and preparing the same path only after the guard.
- `src/pi-rpc-protocol.ts` owns the allowlisted Pi child environment and existing explicit session runtime values.
- `src/pi-context-assembler.ts` owns fixed package directives and their redacted manifest entries; it currently appends the fixed Knowledge directive.
- Existing delivery remains in `src/stream-relay.ts`; only its regression coverage is relevant.

## Validation Commands

```bash
npm run test:file -- src/__tests__/session-manager-pi-spawn.test.ts src/__tests__/session-manager.test.ts src/__tests__/pi-rpc-protocol.test.ts src/__tests__/context-assembler.test.ts src/__tests__/stream-relay.test.ts
npm run lint
git diff --check
```

## Tasks

### Task 1: Carry the session outbox through the Pi child environment and preserve raw prompt text
**Goal:** Give every initial or fresh-retry interactive Pi child the correct per-chat outbox path without moving destructive outbox preparation ahead of startup ownership, then remove per-message outbox boilerplate.
**Serves:** The approved spawn-env and per-message-removal outcomes while preserving existing session ownership and delivery behavior.

- [ ] Define `MINIME_OUTBOX` as the package-owned outbox environment variable and add an explicit outbox-path runtime option in the existing Pi spawn environment path.
- [ ] Separate pure deterministic outbox-path derivation from destructive directory preparation; pass the derived path to every applicable initial/retry interactive Pi spawn while retaining the post-generation-guard preparation point.
- [ ] Remove `appendOutboxInstruction` and send the accepted user text unchanged through `sendPiPrompt(..., "followUp")`.
- [ ] Add focused tests proving the interactive child receives the exact session outbox path, retry spawns retain it, unrelated child env paths do not gain it, and sent prompt text contains no outbox boilerplate.
- [ ] Run the affected session-manager, Pi spawn/protocol, and stream-relay tests plus lint before Task 2.

### Task 2: Add one static file-delivery directive to assembled Pi context
**Goal:** Make file-delivery semantics available once in package-owned session context without embedding chat-specific values.
**Serves:** The approved static assembler directive outcome and its compaction-safe, agent/chat-independent constraint.

- [ ] Add a fixed `## File delivery` package directive that refers only to the package-owned environment variable and explains post-response delivery.
- [ ] Append and manifest the directive through the existing package-directive mechanism with deterministic ordering and no absolute/per-chat path content.
- [ ] Add focused assembler/protocol tests proving the directive appears exactly once, remains static across agents/chats/cache paths, and the environment-variable name cannot drift from the spawn contract.
- [ ] Re-run all validation commands and verify existing outbox delivery tests remain unchanged and green.
