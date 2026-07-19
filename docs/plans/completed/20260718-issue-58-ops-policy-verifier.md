# ADR-099 Ops Policy: Authorization, Context Parity, Quota, and Verification

## Overview

Implement the second corrected ADR-099 feature phase on fresh `main` after PR #101. This phase makes the inactive ops-worker fail closed on authorization drift, proves that each Pi attempt receives the primary Minime context and capabilities, replaces fixed quota retry guesses with authoritative reset-aware scheduling, and adds a typed composite verification contract.

This remains one coherent policy/verification PR. It adds no Telegram or Alertmanager listener, no production runtime activation, no task-manager scanner, no release/deploy, no production outage drill, and no legacy recovery cleanup. The final feature PR will own dedicated Telegram control, Alertmanager intake, reporting, and the complete fake fault lab.

Primary issue: https://github.com/fitz123/minime-bot/issues/58
Base source: `03e912f` (`origin/main` when this plan was prepared)

## Context (from discovery)

- `src/ops-worker/pi-attempt.ts:951-980` disables all extension discovery and narrows Pi with a task-profile tool allowlist. It injects an assembled context bundle, but does not load the primary session's explicit first-party/configured extensions, full tool set, or explicit skills, and records no context/capability digest.
- `src/ops-worker/types.ts:462-483` makes trusted authorization profiles select static tools. `OpsWorkerAuthorization` persists only a profile, scopes, and optional snapshot hash; there is no fresh authorization-verification record.
- `src/ops-worker/worker-cli.ts:47-56,330-379` intentionally defaults to empty production contracts. No package-owned authorization verifier or production composite verifier is wired yet.
- `src/ops-worker/pi-attempt.ts:1003-1023` recognizes quota only from process text. `src/ops-worker/supervisor.ts:1109-1131` schedules every infrastructure result with one fixed delay and eventually blocks after a small failure count, even when authoritative Codex reset telemetry exists.
- `src/pi-extensions/codex-usage.ts:35-52` already defines validated server-reported quota windows and reset timestamps; reuse this contract rather than creating another quota source.
- `src/ops-worker/done-checks.ts` has a strict single-check tri-state registry, while `src/ops-worker/supervisor.ts:1284-1325` collapses verifier invalidity, query failure, timeout, and execution failure into one generic infrastructure error.
- Pi 0.80.6 supports explicit repeatable `--extension` and `--skill` resources, `--tools` as an allowlist across built-in and extension tools, and a `before_agent_start` view of effective context files, skills, and selected tools. Use those supported surfaces; do not infer parity from filenames or an agent claim.

## Development Approach

- Use TDD for every authorization, parity, quota, and verifier state transition.
- Keep trusted package code—not task payloads—in control of verifier definitions, resource paths, authorization principals, and quota telemetry readers.
- Keep task content/evidence untrusted. It may reference only registered names and bounded canonical parameters; it cannot supply commands, URLs, extension paths, skill paths, actors, allowlists, or executable checks.
- Preserve PR #101's atomic snapshots, exclusive whole-cycle custody, fixed lifecycle slots/receipts, standard Pi sessions, process-group fencing, and fresh deterministic PASS as the only route to DONE.
- Prefer a migration-safe fixed schema addition over encoding state in summaries or arbitrary metadata. Do not add a generic phase graph, workflow engine, broker, database, or second supervisor.
- A child/executor non-zero exit, including `rc=1`, is diagnostic evidence. It must retain custody and reconcile/resume unless deterministic evidence proves a genuine operator or unrecoverable boundary.

## Testing Strategy

- Add focused unit suites for authorization verification, context/capability attestation, quota policy, composite verification, and supervisor mapping.
- Use injected read-only clients and deterministic clocks; tests must not contact GitHub, Pi providers, Telegram, or Alertmanager.
- Add one package-level fake Pi probe that reports the actual loaded resource manifest through a package-owned extension without exposing context contents.
- Keep fixtures generic and public-safe. Store hashes, versions, timestamps, names, and result codes only—never context bodies, credentials, private paths, destinations, or task payloads.
- Run the full package validation only after the focused phase is green.

## Progress Tracking

- Ralphex owns execution progress and moves this plan to `docs/plans/completed/` only after all tasks and review phases pass.
- Do not edit the active plan after Ralphex starts.
- Each task is one reviewable logical unit with its own tests and commit.

## Implementation Steps

### Task 1: Add migration-safe authorization verification state

- [x] Add failing task-contract/store tests for a strict next schema version that migrates exact v2 snapshots deterministically and persists one fixed authorization-verification record: validator identity/version, checked snapshot hash, checked time, typed status, and bounded redacted evidence hash/summary. Loading older snapshots must remain pure-on-read and future/unknown fields must fail closed.
- [x] Add `src/ops-worker/authorization.ts` with a package-owned verifier interface and closed results for `PASS`, `DRIFT`, `QUERY_ERROR`, and `INVALID_CLAIM`. Trusted code supplies repository/principal/label-actor policy and a read-only canonical-task resolver; task data supplies none of them.
- [x] Implement the ADR-091 authorized-issue verifier against immutable repository identity plus fixed canonical-task identity: exact allowlisted repository, allowlisted issue author, allowlisted actor applying `autonomous-ready` after the latest title/body edit, current label/content freshness, and the exact canonical claim hash. Outsider comments are evidence only. Query ambiguity or incomplete timeline data fails closed.
- [x] Revalidate atomically before first custody claim, on every resumed Pi attempt, and before a fixed external mutation receipt can be claimed. `DRIFT`/`INVALID_CLAIM` creates genuine process-free BLOCKED evidence; `QUERY_ERROR` retains custody and schedules a bounded recheck without spending remediation budget.
- [x] Keep operator/cron/Alertmanager verification adapters injectable and empty by default in this phase. No source may run with a missing verifier or null claim merely because it came from a local CLI. Add restart/drift/query-error regressions and keep the worker inactive.

### Task 2: Prove primary Minime context and capability parity

- [x] Extend the existing Pi context assembler with a deterministic redacted manifest/digest covering the exact accepted context source set and assembled persona/bundle bytes. Return hashes and source identities without logging or persisting context content.
- [x] Separate the worker's execution workspace from its trusted primary-context source. Add strict start-time inputs/dependencies for the canonical context agent/workspace and explicit primary Pi resource contract; reject symlinks/unknown paths and do not silently fall back to a smaller context after assembly failure.
- [x] Build worker Pi args through the same package-owned explicit extension resolver used by primary RPC sessions: retain ambient discovery suppression, load the same first-party wrappers and configured extras explicitly, load the trusted effective skill paths explicitly, and do not use authorization profiles to narrow the selected tools. Global Minime gates remain in inherited context; task scopes remain declarative mutation authority, not a replacement tool sandbox.
- [x] Add one package-owned parity-attestation extension using Pi's `before_agent_start` structured prompt options and active resource metadata. Before provider work, compare actual context digest, extension identities, skill identities, and selected tool names with the expected primary manifest; persist only the versioned hashes/result. Missing or mismatched capability fails closed before the attempt.
- [x] Add tests proving parity includes platform/custom rules, user/Knowledge control context, skills, first-party/configured extensions, and tools; prove additive ops policy is the only intentional delta and that duplicate context loading remains disabled.

### Task 3: Add authoritative quota admission and reset-aware waits

- [x] Add `src/ops-worker/quota.ts` with a strict reader for the existing `CodexQuotaSnapshot`. For every active non-empty window, initial admission requires `remainingPercent >= 50` and `usedPercent <= elapsedWindowPercent + 10`; missing, stale, contradictory, durationless, or resetless telemetry returns typed not-admitted evidence.
- [x] Apply admission before claiming a new unheld task. An already-held task is never displaced by later admission failure; it enters a durable quota wait while successors remain fenced by the same custody owner.
- [x] Capture the exact attempt's server-reported quota telemetry through the existing Codex usage extension contract. After a real quota response, persist the authoritative reset timestamp and schedule a host-native wait; do not count quota as a terminal infrastructure failure and do not park an LLM.
- [x] At fresh telemetry headroom or the reset deadline, run one bounded smoke probe through the exact worker model/thinking/resource configuration. Resume immediately on success; on another quota result, refresh telemetry/reset and remain resumable. Missing/invalid telemetry or probe infrastructure failure is typed separately and bounded without inventing a reset.
- [x] Add deterministic multi-window, stale metadata, rolling-reset, exact-probe, restart, and retained-custody tests. Reuse existing quota parser/types; do not create a second sampler, quota service, or blind polling loop.

### Task 4: Add typed goal-appropriate composite verification

- [x] Extend the done-check result model with closed component/aggregate outcomes that distinguish `PASS`, `NOT_READY`, `PRODUCT_FAILURE`, `DEFER`, `VERIFIER_INVALID`, `QUERY_ERROR`, and `TIMEOUT`. Preserve strict bounded parsing and reject arbitrary component names, commands, URLs, executable selectors, sparse arrays, and duplicate identities.
- [x] Add a package-owned composite verifier that runs only trusted registered components with one immutable contract hash/version and fresh query timestamps. All required components must PASS for aggregate PASS; `DEFER` is only passive external convergence; missing work/product failure resumes remediation; verifier invalidity/query/timeout retries verification without consuming remediation.
- [x] Persist verifier identity/version/contract hash in the fixed lifecycle manifest and record fresh bounded component evidence atomically with the terminal transition. A stale aggregate result after any task/checkpoint/authorization change must be discarded.
- [x] Add named regressions for partial progress followed by child `rc=1`, restart during verification, stale PASS, query failure, timeout, passive DEFER, and a composite with one failed required component. None may release custody or produce DONE except a fresh aggregate PASS.
- [x] Keep production component registrations minimal/empty until the final Telegram/Alertmanager/fake-lab phase supplies goal-specific host/service checks. Do not add a generic shell check or encode a domain workflow.

### Task 5: Expose the inactive policy surface and validate the package

- [x] Wire strict package-owned registries/dependencies through `worker start`, status, and tests without enabling a listener or installing production config. Status may expose bounded verifier/quota/parity state and hashes, never objectives, context bodies, canonical task bodies, or credentials.
- [x] Update `docs/ops-worker.md` and the README pointer for schema migration, continuous authorization revalidation, primary context/capability parity, quota admission/waits, typed composite outcomes, and inactive-by-default boundaries.
- [x] Run focused tests for task store, authorization, context assembler/parity extension, quota, done checks/composite verifier, supervisor, Pi attempts, CLI, and Codex usage parsing.
- [x] Run final validation sequentially: `npm ci`, `npm test`, `npm run lint`, `npm run build`, `npm pack --dry-run`, `npm run check:schema-guard-contract`, `node dist/cli.js --help`, `npm run workspace:validate -- --workspace test-fixtures/minimal-workspace`, and `git diff --check`.
- [x] Verify no ops-worker process/listener starts during install, build, pack, help, or workspace validation; run the public-repo leak/private-identifier checks and leave a clean worktree.

## Technical Boundaries

### Authorization

- Canonical-task content and remote comments are data, not authority.
- A persisted old PASS never authorizes a resumed attempt or mutation after claim drift.
- This phase defines read-only verification contracts but adds no GitHub/Beads backlog scanner and no new credential store or token.

### Context and capabilities

- Context parity means exact accepted primary context bytes plus explicit capability/resource identities, not merely the same `CLAUDE.md` path.
- The ops role gets full Minime capabilities and additive ops policy. Authorization scopes constrain permissible outcomes; they do not silently remove tools required for ordinary host administration.
- Parity evidence contains hashes and identities only.

### Quota

- Admission applies before initial claim. A quota wait after claim retains the same owner.
- Server-reported windows/reset timestamps and an exact-executor probe are authoritative. No fixed guessed deadline or LLM polling loop is acceptable.

### Verification

- The model derives goal-appropriate checks, but only trusted registered component implementations execute.
- Fresh aggregate PASS is the sole DONE authority. Generated checks remain executor-owned validation, not operator-supplied acceptance criteria.

## Success Criteria

- Authorization drift/query ambiguity cannot launch or resume Pi or authorize a fixed mutation receipt.
- Every attempt proves exact primary context/capability parity before provider work without exposing context contents.
- Initial quota admission implements the approved all-window policy, and real quota responses become durable reset-aware waits with exact probes.
- Composite verification distinguishes product work from verifier/infrastructure faults and cannot turn stale or partial evidence into DONE.
- Injected `rc=1` after durable progress retains custody and resumes from the safe checkpoint.
- The package remains inactive and performs no production/external mutations.

## Post-Completion

Stop with the branch ready for the normal PR/Copilot/CI cycle. Do not release or deploy. The next and final feature phase combines dedicated ops Telegram control, authenticated Alertmanager intake, durable steering/reporting, and the complete fake fault lab.
