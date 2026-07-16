# Issue #58 recovery exact-session bootstrap fix

## Goal

Fix the production diagnosis gate exposed by `v2026.7.9`: a fresh recovery Pi process reports an ID/path through RPC `get_state`, but Pi 0.80.6 does not create its JSONL transcript before the first persisted assistant turn. The recovery runner currently waits for that file before sending the first prompt, so both retries expire after the 30-second startup timeout with no durable session binding.

Preserve ADR-086: one exact owner-only resumable Pi session per incident generation, bind before the incident prompt can invoke tools, same-UID trusted fixer policy, host-native outcome authority, and no change to sudo/root/external-action boundaries.

## Evidence and constraints

- Production evidence: `/tmp/full-cycle-recovery-fixer/live-diagnose-session-bootstrap-root-cause.md` (local operator evidence; do not copy private paths or payloads into public docs/PR text).
- Relevant code: `src/recovery/fixer-session.ts`, `src/pi-rpc-protocol.ts`, `src/__tests__/recovery-fixer-session.test.ts`.
- Pi 0.80.6 source confirms lazy persistence: `SessionManager` exposes an ID/path immediately but does not write a new file until persistence conditions are met.
- A securely created empty `0600` JSONL opened through Pi's exported `SessionManager.open(path, sessionDir, cwdOverride)` is rewritten as a valid v3 header. Starting Pi with `--session <id>` then reports that exact ID/path without a provider request.
- Do not hand-author vendor session JSON, start a competing chat poller, weaken transcript ownership/path checks, expose secrets, invoke sudo, or add network/package dependencies to incident recovery.
- Existing exact resume, unreadable-transcript replacement, process-group fencing, lease renewal, and report semantics must remain intact.

## Validation commands

```bash
npm test
npm run lint
npm run build
npm pack --dry-run
git diff --check
git diff --stat main...HEAD
```

## Tasks

### Task 1: Pre-seed and verify the fresh canonical Pi session
- [x] Add a small testable helper in `src/recovery/fixer-session.ts` that creates exactly one owner-only `.jsonl` inside the already-private fresh generation directory using an exclusive `0600` file and Pi's exported `SessionManager`, with the recovery agent workspace as the session cwd.
- [x] Return the Pi-generated session ID and canonical transcript path only after existing owner/type/path/header validation succeeds; fail closed on collision, unsafe mode/owner, invalid header, or escaped path.
- [x] Start fresh Pi with that exact session ID, require RPC `get_state` to report the same ID, require discovery to resolve the same pre-seeded canonical path, and durably bind before sending the incident prompt.
- [x] Keep the existing prior-session resume/replacement path unchanged and preserve full process-group cleanup and lease behavior on every bootstrap failure.
- [x] Update focused unit tests so `get_state` no longer fabricates a transcript, and assert strict order: secure pre-seed → exact Pi resume/ID verification → durable bind → prompt.
- [x] Add edge tests for owner-only mode, exclusive creation/collision, invalid/escaped transcript state, child ID mismatch, and bootstrap failure cleanup.
- [x] Run the focused recovery fixer tests and typecheck/build before Task 2.

### Task 2: Prove the real Pi 0.80.6 persistence contract without a provider call
- [ ] Add a bounded provider-free integration smoke using the pinned Pi CLI/RPC and a temporary private directory: pre-seed through the production helper, start with the exact session, issue only `get_state`, and prove exact ID/path plus a regular owner-only `0600` transcript.
- [ ] Make the smoke deterministic and offline: no model prompt/provider request, no global session mutation, no production workspace/runtime path, and complete child/process cleanup on success or failure.
- [ ] Preserve and extend the pinned-vendor mechanics test so future Pi upgrades cannot silently reintroduce the lazy-transcript deadlock.
- [ ] Run the focused tests repeatedly and verify no temporary child/session leakage.
- [ ] Run `npm test`, `npm run lint`, `npm run build`, `npm pack --dry-run`, and `git diff --check`.
- [ ] Inspect `git diff --stat main...HEAD` and ensure the diff is limited to the recovery session bootstrap, tests, and this completed plan; no private identifiers or paths may enter the public diff.

## Post-completion

Push one corrective public PR linked to issue #58, complete CI/Copilot gates, merge, release the next CalVer patch, update the private package pin through its own reviewed PR, redeploy through the canonical wrapper, and rerun the same bounded live diagnosis gate before enabled-mode promotion or cutover.
