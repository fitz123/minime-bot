# Issue 58: Full Trusted Recovery Fixer and Two-Slot Runtime

## Goal

Build the follow-up to merged supervisor foundation PR #60: a full iterative same-UID Pi fixer controlled by the host-native Python supervisor and deployable in an independent two-slot recovery capsule. The fixer uses normal Pi context, default local read/bash/edit/write tools, explicit first-party extensions, git through bash, Knowledge tools, and Beads through its workspace CLI; it is not a restricted planner and never uses `--no-session`.

The Python supervisor remains authoritative for incident state, fencing, action intent/outcome, independent verification, and report queuing. Detection, intake, native fallback, probes, and recovery verdicts stay independent of Node, Pi, and the active bot package. The recovery Pi/Node entry lives in the separately staged capsule.

## Fixed architecture and safety boundaries

- Bind one exact persistent Pi session ID and canonical transcript path to each incident generation. Use a private recovery-owned `PI_CODING_AGENT_SESSION_DIR`, persist the binding before the first incident prompt, and resume it after retries or crashes. Only a proven unreadable/missing transcript permits a replacement session seeded with a bounded journal digest.
- Commit an action intent before every mutating tool call and a corresponding outcome afterward. Startup marks unfinished intents `unknown`; inspection remains available, but mutation stays blocked until each unknown action is reconciled against host state.
- Agent `finish` is only a structured claim. Fresh deterministic Python probes, source state, hold-down, and active-slot checks alone may mark recovery.
- Treat the fixer as a trusted same-UID agent, not a hostile-process sandbox. Immutable recovery rules, audited guards, and forbidden-command checks prevent mistakes without claiming complete same-UID enforcement.
- Permit ordinary-user config repair with preimages, existing user launchd/Docker restart, bounded temporary/cache quarantine, local commits, and pre-staged rollback. Forbid literal `sudo`, irreversible durable-data deletion, prune/volume operations, secret output/rotation, package/image downloads, GitHub/public writes, and other external mutation.
- Ship `rootctl` only as a fixed-enum protocol/scaffold with an empty phase-1 registry. Missing capability means blocked/escalated. No installer or runtime path invokes literal `sudo`.
- Incident recovery performs no npm/GitHub/package/image download and starts no competing Telegram `getUpdates` poller.
- Public source, examples, tests, package contents, and reports contain no private paths, identities, destinations, credentials, or payloads.

## Implementation contract

### Modes, ledger, and lifecycle

Deliberately extend `RECOVERY_MODES` from foundation-only `observe` to the closed set `observe`, `diagnose`, and `enabled`:

- `observe`: durable intake/verification/fallback only; `claim_next` never dispatches a fixer.
- `diagnose`: `claim_next` may dispatch the full fixer, but the recovery extension blocks all mutating default and recovery tools while permitting inspection, reconciliation, `recovery_blocked`, and `recovery_finish`.
- `enabled`: dispatches the same full fixer and permits journaled ordinary-user mutations plus reviewed supervisor-owned operations.

Enforce the mode both at Python claim/endpoint authorization and in the recovery extension's tool-call guard. Dispatch-off immediately returns to `observe` behavior/native fallback. A fixer spawn must fail closed if `PI_EXTENSIONS_DISABLED=1`, because running default mutation tools without the recovery extension would bypass journaling and mode enforcement.

Evolve the fixed schema in `scripts/recovery_ledger.py` before production adoption. Add session bindings/replacements, action intents/outcomes/reconciliation, verification attempts/claims, and detailed per-incident reports while retaining WAL, `synchronous=FULL`, fail-closed integrity, one global lease, generation/evidence/policy fencing, intake idempotency, and bounded retention.

Keep the foundation incident-state names rather than inventing incompatible renames: OBSERVED/CONFIRMING remain derived from durable events plus `confirmation_count`; ELIGIBLE maps to `eligible`; RUNNING maps to `invoking`; VERIFYING maps to `verifying`; RECOVERED maps to `recovered`; blocked/failed/escalated are durable invocation outcomes, `recovery_failed`/`recovery_unsafe`/`retries_exhausted`, and escalation-outbox records as appropriate. Any schema bump is migration-free and fail-closed because this is pre-production.

`REPORT_PENDING` and `REPORTED` are states of independently keyed report/outbox rows, never `incidents.state`; delivery failure leaves the incident `recovered`. Static policy owns confirmation, retry/cooldown, dispatch, fixer lease/renew timing, allowed quarantine roots/bytes, reviewed operation IDs, report bounds, and timeouts. Adaptive policy remains absent.

### Exact-session runner and fixer protocol

Add a full runner such as `src/recovery/fixer-session.ts`, shared recovery helper code under `src/pi-extensions/`, and a recovery-only spawn wrapper under `extensions/pi/` that packages to `dist/extensions/pi/**` but is not added to the bot's default wrapper list. Reuse normal Pi invocation, scrubbed environment, context assembly, configured-agent lookup, extension resolution, strict LF-only RPC parsing, and the package Pi pin.

Use only Pi 0.80.6 mechanics already verified by the project unless Task 2 proves a newer API in the pinned installed distribution:

1. Point `PI_CODING_AGENT_SESSION_DIR` at an empty owner-only directory dedicated to the incident generation.
2. Start RPC without an incident prompt and capture `data.sessionId` from the `get_state`/SystemInit path.
3. Derive and validate the canonical owner-only transcript path from the dedicated directory, which must contain exactly one matching session JSONL after bounded startup.
4. Commit ID, canonical path, generation, and fence before sending the first incident prompt.
5. Resume with `--session <id>` and the same session directory. Do not assume a `--session-dir` flag or `get_state.sessionFile`; adopt either only if explicitly verified in the pinned vendor dist and tested.

Use a distinct owner-only fixer credential accepted only by fixer endpoints; the existing intake bearer remains accepted only by intake/control routes. Pass only a credential-file path through the scrubbed process contract (never the value in argv/logs), and keep both route families mutually rejecting the other credential so a fixer cannot synthesize source heartbeat/evidence.

Expose body-bounded, redacted, idempotent loopback fixer endpoints for binding, intent, outcome, reconciliation, heartbeat, blocked, finish, quarantine, and reviewed operations. Fence every request by incident ID, generation, evidence hash, policy revision, and lease token. The extension journals `bash`, `edit`, `write`, `knowledge_update`, and every other mutating tool; leaves crash windows `unknown`; allows inspection during reconciliation; and rejects reviewed destructive/external/network-install patterns.

Execution ownership is explicit: generic diagnosis/config edits/local commits run in the full Pi process and are journaled by the extension; policy-sensitive quarantine and reviewed restart/rollback command IDs execute in the stdlib Python supervisor through fenced fixer endpoints using static argv from closed config. The Node extension never duplicates path/byte policy or executes mutable command strings. The supervisor persists the intent before executing these operations and their outcome afterward.

The supervisor launches one process group while holding the lease, persists session binding before prompt, renews/fences it, terminates it on timeout/fence loss, resumes the same session after verification failure, and creates a replacement only after direct readability validation plus the existing `No session found matching` startup classifier prove the transcript unusable. Pi/provider failure escalates through native fallback without corrupting incident state.

### Quarantine, root boundary, and reports

- Implement quarantine under recovery state with canonical containment, allowlisted roots, no symlink traversal, per-file/per-incident item and byte limits, atomic rename where possible, explicitly supported copy-and-verify fallback only, `0600` restore manifests, and restore support. Never auto-purge in this MVP.
- Add `scripts/recovery_rootctl.py` as an ordinary-user protocol validator with exactly capability ID, incident ID, idempotency key, active fence, current/peer UID, and rate-limit inputs. Phase 1 starts no privileged listener/helper, has an empty capability registry, and accepts no generic argv/path/shell field.
- Build a strict redacted report containing incident/generation/session IDs, trigger/impact/timeline, RCA/confidence, evidence references, actions/outcomes, changed files/services/releases, preimages/quarantine/rollback, verification, residual risk, Beads/Knowledge/ADR/local-commit references, runtime/policy/model versions, and outcome. The supervisor merges the claim with authoritative journal/verification data and queues one report key.
- Knowledge/Beads/report-enrichment failure records degraded metadata but never blocks repair or verification.

### Independent slot support

Add generic stdlib-first local slot tooling for two domains:

1. **Recovery capsule:** stable bootstrap, immutable validated `current`/`previous`, owner-only state, staged self-check, manifest/checksum validation, atomic symlink switch with directory fsync, and exactly one automatic `current -> previous` fallback on startup-health failure. Staging consumes an already validated local runtime tree and never downloads/builds during an incident.
2. **Bot release slots:** immutable locally staged `current`/`previous` manifests and a stable external restart/rollback wrapper. Rollback verifies the previous manifest, atomically switches, invokes only a reviewed static restart command, requires no network/build/package manager, and restores the former slot after a failed restart when safe.

The capsule contains an independent copy of package Python/compiled fixer artifacts and the required installed dependency closure. Node and Pi executables are configured absolute host prerequisites, pinned/version-checked and recorded in the capsule manifest rather than copied implicitly from the active bot release. Bot deploy and capsule upgrade remain separate explicit operations; bot deploy never switches the capsule.

## Validation commands

```bash
/usr/bin/python3 -m unittest discover -s scripts/tests
npm run lint
npm test
npm run build
npm pack --json --dry-run
```

Also run installed-tarball config/workspace/schema checks, package-content assertions, strict privacy scans, and offline fixtures that fail if recovery attempts npm, GitHub, package/image download, a second `getUpdates`, literal `sudo`, or a forbidden destructive/public command.

## Tasks

### Task 1: Extend closed modes, durable ledger, static config, and lifecycle
- [x] Add the exact `observe`/`diagnose`/`enabled` dispatch and mutation semantics at config, claim, endpoint, and extension boundaries; fail closed on missing recovery extension or `PI_EXTENSIONS_DISABLED=1`.
- [x] Evolve SQLite for exact session binding/replacement, action intent/outcome/unknown reconciliation, claims, verification history, and independent report/outbox state while preserving foundation durability, fencing, lease, and retention invariants.
- [x] Keep existing incident states and implement the documented presentation mapping plus idempotent report states outside `incidents.state`.
- [x] Extend closed config with internal agent ID, fixer credential reference, session/action/quarantine/report/slot policy, reviewed operation IDs, and fixer lease/renew timing; reject unknown fields, unsafe paths, shell strings, and adaptive settings.
- [x] Add schema/version, mode, lifecycle, stale-fence, duplicate, corruption/full/lock, and report-state tests; run focused Python tests.

### Task 2: Add the full exact-session Pi fixer and separated action protocol
- [ ] Add the full runner, shared helpers, and non-default recovery wrapper while preserving normal Pi tools/context and excluding the old planner/`--no-session` model.
- [ ] Implement the verified `PI_CODING_AGENT_SESSION_DIR` + `get_state.data.sessionId` + one canonical JSONL binding flow, commit before first prompt, and exact `--session` resume; verify vendor APIs before using any alternative.
- [ ] Add mutually exclusive intake/fixer credentials and fenced endpoints plus recovery intent/outcome/reconcile/blocked/finish tooling around all mutating tools.
- [ ] Resume after verification/crash and permit a journal-digest replacement only after transcript readability and startup-classifier proof.
- [ ] Test exact ID/path resume, unreadable degradation, crash unknowns, reconciliation-before-mutation, diagnose blocking, extension kill-switch rejection, process-group fencing, Pi/provider outage, credential separation, and no chat binding; run TypeScript/Python integration tests.

### Task 3: Make the supervisor outcome and report authority
- [ ] Drive one fixer process from the global lease/static retry budget while intake, fallback, and probes remain Python-host-native.
- [ ] Treat finish as a claim, verify independently with fresh evidence/hold-down, resume the same session on contradiction, and defer on stale/missing telemetry.
- [ ] Merge claim plus authoritative journal/verification into one redacted report and durably queue/dedupe delivery without changing the incident outcome.
- [ ] Record Knowledge/Beads enrichment failure as non-blocking degradation.
- [ ] Test false success, full lifecycle, deterministic verification, resume, report exactly-once/pending across restart, delivery outage, and Knowledge/Beads failure; run lifecycle tests.

### Task 4: Add supervisor-owned quarantine, reviewed operations, and zero-capability rootctl
- [ ] Implement fenced canonical-path quarantine/restore with ownership/mode/symlink/size/item guards and checksummed `0600` restore metadata.
- [ ] Implement supervisor-owned static-ID restart/rollback execution and prevent the Node extension from accepting mutable argv/shell/path policy.
- [ ] Add trusted-agent rules and audited guards for literal `sudo`, irreversible deletion, public/external mutation, secret operations, package/image download, prune/volume operations, and competing Telegram polling.
- [ ] Add `scripts/recovery_rootctl.py` with empty registry and fence/idempotency/UID/rate validation, no privileged listener, and no generic command/argv/path.
- [ ] Test quarantine/restore/rejections, allowed user config/restart, forbidden deletion/public/network actions, and inability to bypass empty root capability; run safety tests.

### Task 5: Add independent recovery-capsule and bot-release slots
- [ ] Implement validated local recovery staging plus stable bootstrap/current/previous/state, atomic switch/fsync, self-check, and one previous fallback.
- [ ] Stage an independent package artifact/dependency closure and validate configured absolute Node/Pi prerequisites and versions in the manifest.
- [ ] Implement immutable bot slots and stable offline static-ID restart/rollback with evidence and safe failed-restart restoration.
- [ ] Keep bot deploy and capsule upgrade separate and prohibit build/download/package/image operations during incident rollback.
- [ ] Test broken active bot package, broken capsule current-to-previous, manifests/checksums, interrupted switch, offline bot rollback, and restart restoration; run slot/bootstrap tests.

### Task 6: Complete package integration, documentation, and acceptance coverage
- [ ] Wire runner, non-default extension wrapper, Python modules, capsule/slot commands, and package files without private deployment details.
- [ ] Document exact mode gates, session mechanics, credential separation, reconciliation, reports, capsule upgrade/rollback, offline bot rollback, empty rootctl, and dispatch-off/native-fallback rollback.
- [ ] Add installed-tarball lifecycle tests for duplicate/out-of-order intake, broken package/capsule, Pi/provider outage, quarantine, forbidden actions, local rollback, verification, report pending/dedupe, Knowledge/Beads failure, and root boundary.
- [ ] Assert no competing `getUpdates`, Node verification, incident download, literal `sudo` invocation, stale-data failure, model-authoritative success, default recovery-wrapper loading, or dangling package artifact.
- [ ] Run all validation, installed-package checks, offline fixtures, privacy scans, and exact `git diff --stat main...HEAD`; leave the branch clean and move the plan only after every gate passes.
