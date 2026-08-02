# Exact interactive Pi transcript bindings and automatic rotation

## Goal

Replace provisional bot-local IDs and Pi ID/prefix discovery with one durable, verified Pi-authored transcript binding per interactive transport lane. Fresh and resumed sessions must always open an exact absolute transcript path. When a prior transcript is unavailable, preserve it, rotate once to one new canonical binding, notify the user with the exact failed ID, and process the triggering message in the replacement session without a resend.

## Non-goals

- No bot-owned transcript mirror, SQLite/event store, runtime/stored dual identity, generic provider abstraction, global session index, or distributed lock protocol.
- No automatic reconstruction, deletion, movement, rewriting, timestamp inference, or silent substitution of historical transcripts.
- No rotation for model, provider, network, or ordinary turn failures, and no exactly-once redesign for prompts, tools, or external side effects.
- No permanent legacy reader, `--resume`/`--continue` use, ID/prefix session lookup, ADR, new external dependency, or unrelated transport/media/outbox/idle/LRU/shutdown redesign.
- PR, release, deployment, production migration verification, and issue closure remain parent-supervisor work.

## Context

- Released base is `v2026.8.2` (`266bd164`). `src/types.ts` and `src/session-store.ts` persist only a `sessionId`; store parse failure currently becomes an empty store.
- `src/session-manager.ts` currently generates fallback UUIDs, discovers identity through timed `get_state`, resumes with `--session <id>`, and deletes an unopenable binding before a pathless retry. Existing per-lane queueing, startup-generation fencing, teardown, crash backoff, and media/outbox ownership must remain intact.
- `src/pi-rpc-protocol.ts` owns the Pi argument/environment contract. Pinned Pi 0.82.1 opens an absolute `--session <jsonl-path>` directly, while ID-shaped arguments enter local/global discovery. RPC `get_state` reports both `sessionId` and `sessionFile` and must become an equality assertion only.
- Pi exports `SessionManager`, `SettingsManager`, and `CURRENT_SESSION_VERSION`. Public PR #74 (`74e08a9`) proves the narrow pre-seed primitive: exclusive owner-only empty JSONL, `SessionManager.open(path, sessionDir, cwd)`, then canonical header/path/CWD validation.
- `MessageQueue` already serializes a transport lane and supplies a `PlatformContext`; Telegram and Discord adapters acknowledge `sendMessage` completion. This is the existing direct transport boundary for a durable recovery notice.
- Legacy cutover must inspect only the configured agent workspace's resolved Pi session directory with bounded local header reads, preserve a byte-identical store backup, and never invoke Pi discovery or modify candidate transcripts.

## Validation Commands

```bash
npm run test:file -- src/__tests__/session-store.test.ts src/__tests__/session-manager.test.ts src/__tests__/session-manager-pi-spawn.test.ts src/__tests__/pi-rpc-protocol.test.ts src/__tests__/message-queue.test.ts src/__tests__/telegram-bot.test.ts src/__tests__/discord-bot.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
git diff --check
git diff --stat main...HEAD
git diff --no-ext-diff main...HEAD | rg -n '/Users/|306600687|255582' || true
```

## Tasks

### Task 1: Establish the canonical exact-path session primitive
**Goal:** Resolve one authoritative workspace/session directory and create or inspect only verified Pi-authored transcript bindings.
**Serves:** Fresh topics must persist a real canonical ID/path before spawn; resumes must use exact paths; broad discovery, provisional IDs, and silent transcript mutation must be structurally impossible.
- [x] Add a cohesive interactive binding helper that resolves the canonical agent workspace and Pi session directory using Pi 0.82.1 precedence, validates owner/private/non-symlink directory state, and bounds header reads and candidate inspection.
- [x] Adapt the public #74 primitive to exclusively create a collision-safe `0600` JSONL, open it through Pi `SessionManager.open`, and return `{sessionId, sessionFile, workspaceRealpath}` only after canonical in-directory path, regular-file owner/mode, current header version, ID, and CWD all match.
- [x] Change the interactive spawn contract in `src/pi-rpc-protocol.ts` to accept the resolved session directory and absolute transcript path, emit exactly one `--session <absolute-jsonl-path>` (and an explicit matching session directory where required), and reject ID-shaped interactive bindings, `--resume`, and `--continue`.
- [x] Parse correlated `get_state` identity as `{sessionId, sessionFile}` for bounded equality assertions; never let reported state create or replace a durable identity.
- [x] Add focused protocol/helper tests for secure pre-seed, symlink/owner/mode/path/header/ID/CWD failures, collision safety, exact spawn arguments, and mismatched/absent/delayed `get_state` without fallback identity.
- [x] Run `npm run test:file -- src/__tests__/pi-rpc-protocol.test.ts src/__tests__/session-manager-pi-spawn.test.ts` and `npm run lint` before Task 2.

### Task 2: Perform one data-preserving legacy store cutover
**Goal:** Convert the legacy ID-only map into strict canonical bindings or an explicit one-time unresolved migration state without losing the old ID or any source bytes.
**Serves:** Existing topics must migrate by exact local evidence when possible, rotate once on access otherwise, preserve old evidence, and never silently become an empty store or use global search.
- [x] Extend `SessionState` with the canonical `sessionFile`, `workspaceRealpath`, and bounded pending recovery notice data; represent unmatched legacy records as an explicit one-time unresolved cutover state carrying the failed old ID rather than a second runtime identity.
- [x] Make `SessionStore` reject malformed/unsafe input instead of silently replacing it, create one byte-for-byte private legacy backup before the first rewrite, and expose atomic compare-and-set replacement/notice acknowledgement needed by generation-fenced startup.
- [x] At startup, migrate each legacy record using its configured agent's canonical workspace/session directory and bounded filename/header inspection: accept exactly one safe matching ID+CWD path, while missing, duplicate, malformed, cross-workspace, or ownership-conflicting evidence becomes eligible for one on-access rotation with the exact old ID retained.
- [x] Ensure migration is idempotent and stoppable: a backup/write/validation failure leaves the original store and every transcript unchanged, and the new runtime never keeps reading legacy shape after a successful cutover.
- [x] Add store/migration tests for unique match, every ambiguous/unsafe case, corrupted input, byte-identical backup, atomic stale-write rejection, idempotent restart, unchanged transcript hashes/paths/bytes, and no inspection outside the configured directory.
- [x] Run `npm run test:file -- src/__tests__/session-store.test.ts src/__tests__/session-manager.test.ts` and `npm run lint` before Task 3.

### Task 3: Bind, resume, rotate, notify, and replay under existing lane fences
**Goal:** Make the canonical binding the sole interactive lifecycle identity and recover one unavailable prior transcript without stranding or silently changing the lane.
**Serves:** A user must see the exact failed old ID, get one replacement session, and have the triggering message processed automatically; concurrent messages and `/clean` must not create duplicate or resurrected bindings.
- [x] Refactor `SessionManager.getOrCreateSession` so a fresh lane pre-seeds and compare-and-set persists its verified binding before spawn, while a normal resume validates and opens only the stored absolute path; remove UUID fallback, Pi-ID discovery, ID-based resume, and delete-then-pathless recovery.
- [x] Classify only local binding-validation failures or deterministic exact-open startup rejection as rotation signals. Under the existing teardown, per-lane serialization, and startup-generation fence, preserve the old binding/reason, pre-seed exactly one replacement, atomically publish it with a pending notice, and retain that new binding across spawn/provider failures instead of allocating again.
- [x] Require startup `get_state` ID/path equality for fresh, resumed, and rotated sessions; a timeout, mismatch, store/pre-seed failure, or superseded generation must not poison, overwrite, or silently republish a binding.
- [x] Add a transport-agnostic recovery-notice callback at the existing `MessageQueue`/`PlatformContext` processing boundary. Deliver fixed non-model prose containing the failed and new IDs, acknowledge/clear the exact durable notice only after `sendMessage` succeeds, retain it after transport failure/restart, and continue the original prompt through the replacement session without requiring resend.
- [x] Add focused tests covering missing/malformed/unreadable/unsafe/mismatched transcripts, deterministic exact-open rejection, ordinary provider/network failure without rotation, one rotation across concurrent messages/restarts, notice retry/acknowledgement, triggering-message replay, Telegram and Discord delivery, `/clean` generation races, and preservation of in-flight media/outbox/crash semantics.
- [x] Run `npm run test:file -- src/__tests__/session-manager.test.ts src/__tests__/session-manager-pi-spawn.test.ts src/__tests__/message-queue.test.ts src/__tests__/telegram-bot.test.ts src/__tests__/discord-bot.test.ts` and `npm run lint` before Task 4.

### Task 4: Lock the pinned-Pi exact-path contract and complete repository validation
**Goal:** Prove the implementation against the real offline Pi runtime and settle the complete branch at one validated head.
**Serves:** Exact-path opening, durable multi-turn history, workspace isolation, and slow-start identity stability must remain true across future Pi upgrades and full package integration.
- [ ] Add bounded provider-free pinned-Pi integration coverage showing pre-seed creates a canonical private transcript and exact-path RPC reports the same ID/path without inspecting decoy sessions in another workspace.
- [ ] Add an offline round-trip fixture that writes representative multi-turn session entries through Pi's session manager, exits, resumes the same absolute path, and proves the same history/identity remains; hash decoy and legacy transcripts before/after.
- [ ] Add a delayed-start regression proving the prior startup threshold cannot mint or persist a second identity, plus bounded child/process/temp cleanup on success and failure.
- [ ] Run all commands in `Validation Commands`; inspect `git diff --stat main...HEAD`, author metadata, generated artifacts, secrets/PII, and scope so the branch contains only issue #174 code, tests, and this plan.
