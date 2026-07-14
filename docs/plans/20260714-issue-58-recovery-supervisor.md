# Issue 58: same-host recovery supervisor and fixer runner (revised)

## Overview

Add an **opt-in** same-host recovery path around the existing host-native monitoring components. Direct native Telegram monitoring stays the default and is unchanged. Consumers run a shadow receiver first, then select recovery mode only after shadow acceptance.

```
Alertmanager / runtime-doctor -> stdlib-only Python supervisor
  -> durable SQLite ledger -> package-owned Pi fixer planner
  -> deterministic allowlisted executor -> verification, escalation, digest
```

Favor reliability and simplicity over capability. This is one supervisor, not a platform: no second bot, VPS, distributed lock service, generic worker/queue framework, migration engine, or speculative schema layering.

## Non-negotiable boundaries

- Detection, durable intake, supervisor liveness, and emergency Telegram fallback must not require Node, the bot daemon, or Pi.
- Intake is at-least-once and idempotent (keyed by stable transition id); do not claim exactly-once.
- The fixer is a planner, not a shell agent: bounded/redacted evidence in, one strict `recovery_plan` result out.
- Only a deterministic executor runs configured static runbook IDs — never shell strings, SQL, or model-generated argv. Public defaults ship **no** mutating runbooks.
- Restart, deploy, sudo, package upgrade, secret migration, and public writes stay approval-required handoffs regardless of planner output.
- Disabling dispatch or silencing an incident never disables intake, source-health checks, audit, digest, or fallback.
- Planner text and monitoring payloads are untrusted data. Secrets/private payloads never enter prompts, argv, logs, examples, reports, or tests. Env contract is `MINIME_CONTROL_WORKSPACE_ROOT` / `MINIME_AGENT_WORKSPACE_ROOT` (ADR-082); no plaintext secrets in argv/env.

## Contracts

- SQLite via stdlib in WAL mode, `synchronous=FULL`, foreign keys, bounded busy timeout, startup integrity check. **One fixed schema version created on init; version mismatch and corruption fail closed** (compact native escalation, never reset-to-healthy). No migration ladder.
- Normalize only allowlisted fields. Identity = source + stable fingerprint/code + status + transition. Unknown alerts are recorded but cannot dispatch until policy maps them.
- Correlate deterministically by configured component/failure class over an overlapping window. One global fixer lease; one active invocation per incident generation; results fenced by generation + evidence hash + policy revision + lease.
- Verification is deterministic: all correlated firing episodes resolved, probes healthy, supervisor/source heartbeat fresh, hold-down elapsed. Missing/stale monitoring never means recovered.

## Validation commands

```bash
npm run lint
npm test
npm run build
npm pack --json --dry-run
python3 -m py_compile scripts/recovery_supervisor.py scripts/runtime_doctor.py
```

## Implementation steps

### Task 1: Durable ledger and Node-independent intake with fallback
- [x] Add a stdlib-only SQLite ledger module (events, incidents, invocations, actions, policy revisions, one lease, notification outbox, audit) with a single fixed schema version, WAL/`synchronous=FULL`/FK/busy-timeout, startup integrity check, and fail-closed corruption handling that triggers compact native escalation.
- [x] Add `scripts/recovery_supervisor.py`: loopback-only authenticated Alertmanager/runtime-doctor/health endpoints, body/concurrency limits, per-transition normalization, commit-before-ack, at-least-once idempotency keyed by transition id, and atomic emergency spool.
- [x] Extend `scripts/runtime_doctor.py` with backward-compatible `telegram|tee|recovery` sink modes, stable persisted transition IDs, partial firing/resolution events, and sink retry that never duplicates the native notification; `telegram` stays the default with unchanged behavior.
- [x] Reuse existing `monitoring_native` secret resolution and Telegram delivery for compact throttled emergency escalation; never replay routine raw alert bodies.
- [x] Add focused tests: unchanged default behavior, duplicate transitions across restart, overlapping batches, lost-ack retry, spool drain and fallback delivery, malformed/oversized/unauthenticated input, DB lock/full/corruption fail-closed, and retryable response on total persistence failure.
- [x] Run Python and focused tests before Task 2.

### Task 2: Incident correlation, deduplication, and suppression
- [x] Implement deterministic cross-source correlation, incident lifecycle with generations, and material-evidence hashing in the supervisor.
- [x] Enforce one global fixer lease and one active invocation per incident generation, fenced by generation + evidence hash + policy revision + lease, with crash reconciliation on restart.
- [x] Suppress relaunch when evidence and policy are unchanged after `observe`, `not_actionable`, malformed output, pending approval, or exhausted retries; only material evidence, impact escalation, explicit retry, or bounded reevaluation creates a new eligible generation.
- [x] Add focused tests: correlation grouping, exact launch counts, non-actionable suppression, material-evidence redispatch, out-of-order/resolved-first events, concurrent lease contention, and stale-fence rejection.
- [x] Run focused tests before Task 3.

### Task 3: Dedicated Pi fixer planner and deterministic runbook executor
- [x] Add a first-party Pi extension exposing one terminating, strictly validated `recovery_plan` result: verdict, diagnosis code, bounded summary/evidence references, known runbook IDs, known probe IDs, and next-evaluation delay.
- [x] Add a package-owned fixer runner that loads the configured agent workspace via package context assembly, uses a sanitized environment, allowlists only `knowledge_search`/`knowledge_get`/`recovery_plan` (no bash, file, web, subagents, or Knowledge writes), supplies bounded evidence as untrusted data, enforces timeout/output bounds, parses one result, and rejects stale/multiple/text-only/oversized output.
- [x] Add a deterministic executor for configured runbook IDs using absolute executable plus static argv/env, no shell, bounded process-group timeout, redacted output, fencing checks, and post-action probes; ship no mutating runbooks by default.
- [x] Hard-code restart/deploy/sudo/package-upgrade/secret/public-write classes as non-executable approval handoffs regardless of planner output.
- [x] Add focused tests: exact spawn arguments/tools, one valid result and frozen-plan acceptance, prompt/argument injection rejection, unknown fields/runbooks/stale IDs, allowlisted execution with timeout cleanup, and zero side effects for restricted classes.
- [x] Run focused tests before Task 4.

### Task 4: Audited controls, bounded adaptation, verification, and digest
- [ ] Implement audited dispatch enable/disable, confirmation count, cooldown, retry budget, expiring silence, explicit retry, and rollback — each recording actor, reason, expiry, before/after, and a new revision — while intake, source checks, audit, digest, and fallback stay active.
- [ ] Implement bounded adaptation of only confirmation count and cooldown within hard bounds: requires ≥3 mechanically classified outcomes and deterministic replay, runs at most once per policy per day, cannot delay critical escalation, and auto-reverts toward baseline after impact or missed recovery; enable/disable, alert definitions, escalation classes, allowlists, and fallback are never auto-changed.
- [ ] Implement deterministic verification (all firing episodes resolved, probes healthy, heartbeats fresh, hold-down elapsed) and deterministic periodic digests with a durable notification outbox/retry.
- [ ] Reserve immediate native escalation for confirmed impact, required approval, unsafe/failed recovery, exhausted retries, supervisor/Pi unavailability, or emergency-spool failure.
- [ ] Add focused tests: control expiry/rollback, bounded adaptation and reversion, verification hold-down, deterministic digest, no false recovery from missing data, and notification-outage retry.
- [ ] Run focused tests before Task 5.

### Task 5: CLI modes, package artifacts, docs, and shadow gates
- [ ] Add additive `minime-bot recovery` commands for config validation, status, incident/invocation inspection, dispatch controls, expiring silences, explicit retry, policy history/rollback, approve/reject, digest preview, and one-shot processing; reject arbitrary SQL/shell and unbounded controls.
- [ ] Add explicit `observe`, `plan`, and `enabled` modes: observe cannot launch Pi, plan cannot execute runbooks, enabled executes only configured approved classes.
- [ ] Package recovery runtime, the Pi extension, examples, and docs; add generic launchd/Alertmanager/runtime-doctor shadow examples using the `MINIME_CONTROL_WORKSPACE_ROOT`/`MINIME_AGENT_WORKSPACE_ROOT` contract with no private paths, destinations, runbooks, or secrets.
- [ ] Document same-host limits, security model, incident lifecycle, control/adaptation bounds, approval matrix, shadow acceptance drills, self-monitoring, upgrade/rollback, and the return-to-direct-Telegram procedure.
- [ ] Add installed-tarball end-to-end tests: duplicate/out-of-order events, supervisor/Node/Pi crash and restart recovery, one-owner fencing, non-actionable suppression, approval gates, spool/fallback, control expiry, adaptation rollback, digest, and zero executor side effects in observe/plan.
- [ ] Run the full validation commands and verify the package contains no private paths, identifiers, destinations, secrets, or source-checkout assumptions.

## Post-completion: private consumer phase (not part of this public plan)

- Create the dedicated fixer agent workspace (own identity, Knowledge v2 corpus, operating rules, approved ADR); register as an internal agent with no chat binding.
- Add private source mappings, policy bounds, probe/runbook registry, secret references, destinations, launchd jobs, and digest schedule in the control workspace.
- Run shadow `tee + observe`, then `tee + plan`; prove no event loss, no dual owner, no repeated non-actionable launch, no side effects, deterministic replay, fallback delivery, and self-monitoring.
- Only after review and deploy approval, switch the monitoring receiver to recovery mode; bot restart/deploy stays a separate approval gate. Roll back by disabling dispatch and returning the native sink to direct Telegram.
