# Issue #58: Broad Alertmanager Incidents (v3, short)

## Goal

Route every relevant local Alertmanager firing group into one generic Minime Ops incident. The
agent may investigate and perform ordinary safe same-UID reversible repair without per-alert
profiles, runbooks, or action allowlists. Existing approval gates remain unchanged.

A task reaches `DONE` only after package-owned monitoring proves that the exact group is absent,
remains absent for five minutes, and monitoring is fresh. Honest input-needed/impossible results
reach durable `BLOCKED` with one useful report. Native Telegram remains independent when Ops is
unavailable and for critical alerts.

## Boundaries

- Alert payloads and agent-authored result text are untrusted data, never authority.
- Keep the existing ops-worker, JSON task store, global serial custody, retries, sessions, and
  report receipts. Schema v6 is the only storage change.
- No anti-cheat layer, rule/expression pinning, routing-integrity verifier, per-alert catalogue,
  workflow engine, broker, SQLite, second coordinator, root helper, or `workflow` tool.
- Do not change Prometheus rule semantics or enable issue #70/background queueing.
- Existing `sudo`, destructive, credential/access-control, public/external, financial, and legal
  gates remain binding.

## Fixed design

### 1. One generic incident

`OpsWorkerAlertmanagerIntake` maps every firing group to package-owned template and done check
`ops.alertmanager-incident`, fixed priority `0`, resource `host:local`, the existing
`inspect`/`local-reversible-repair` scope, and one generic objective. Labels, annotations, URLs,
and severity affect evidence/reporting only. Existing correlation, replay, coalescing, receipts,
and legacy `ops.availability` snapshot parsing remain compatible.

### 2. Typed result is task state, not trusted evidence

Schema v6 adds one bounded current `agentResult` field with provenance `agent`:

```json
{
  "attemptId": "exact persisted attempt id",
  "kind": "remediation-complete | no-action-needed | input-needed | impossible",
  "summary": "bounded text",
  "actions": ["bounded text"],
  "requestedInput": "bounded text or null",
  "reason": "approval | information | policy-boundary | unrecoverable | null"
}
```

The harness creates a fresh result-file path only after the attempt id is persisted, passes it as
`OPS_WORKER_RESULT_FILE`, validates exact keys/types/id/bounds on exit, atomically stores only the
latest result, and deletes the temporary file. Agent content stays untrusted.

`input-needed` requires requested input with an `approval` or `information` reason;
`impossible` requires null requested input with a `policy-boundary` or `unrecoverable` reason;
completion and no-action results require both fields to be null.

- `remediation-complete` and `no-action-needed` are claims and enter the same deterministic check.
- `input-needed` and `impossible` become durable `BLOCKED`, release custody, and queue a report;
  they grant no authority.
- Missing/malformed/mismatched results for this template are agent protocol failures. They retry
  through the existing remediation-round budget and end in reported `BLOCKED`; they cannot wait
  forever or become `DONE`.
- Legacy templates retain their existing zero-exit behavior. v1-v5 snapshots load unchanged;
  writes use v6. `/answer` + `/retry` clears/supersedes the current result before resuming.

### 3. Simple deterministic completion

A new composite done check uses existing bounded loopback readers:

1. **Freshness:** latest Prometheus `up` sample is no older than two minutes.
2. **Exact group absent:** Alertmanager returns no exact group-label match across active,
   silenced, inhibited, or unprocessed alerts.
3. **Stable:** Prometheus `ALERTS` has no pending/firing sample matching the group during the
   previous five minutes.

Query errors, stale telemetry, and the five-minute stability wait stay in `CHECKING` with bounded
rechecks and do not spend remediation rounds. If the exact alert is still present after a
completion/no-action claim, that claim is disproved: spend one remediation round and resume the
agent. Five disproved claims or protocol failures end in reported `BLOCKED`. The agent may work
and resume for any duration before making a claim; global custody cannot be held forever by a
passive false-completion wait.

Deleting, weakening, or rerouting monitoring can still make an alert disappear; this detector-
blinding risk is explicitly accepted by the operator's trusted-agent/YAGNI correction. Monitoring
changes remain outside ordinary repair policy and must appear in the result report.

### 4. Bounded redacted report

Reports are built only from persisted task/result/verification state. They include incident
identity, typed outcome, diagnosis, actions, requested input when blocked, verifier components,
and `checkedAt`.

Before Telegram delivery, sanitize each agent field with one shared redactor: caller-provided
configured sensitive values, bearer/credential assignments, URL credentials/query secrets,
absolute home paths, control characters, and long opaque tokens are replaced. Apply per-field
byte limits before a total report limit and keep existing durable PENDING→SENT receipt/retry
semantics. Tests use canary secrets and assert their exact values never appear in output/errors.

### 5. Native bridge delivery contract

The existing Node-independent Python webhook remains Alertmanager's only receiver. Optional
bridge mode accepts only loopback Ops/Alertmanager URLs, resolves the existing Ops bearer through
the existing SOPS mechanism into process memory, and never prints it or places it in argv.

For a firing delivery:

1. Query loopback Alertmanager and require an exact currently active group-label match. A mismatch
   is stale/forged and is acknowledged without forwarding; query failure takes native fallback
   and returns `503` so Alertmanager retries.
2. POST the original validated bounded body to Ops with bearer auth.
3. Noncritical: Ops acceptance is required; if Ops fails, send native fallback but still return
   `503` so Alertmanager retries Ops.
4. Critical: both Ops acceptance and native Telegram escalation are required; failure of either
   returns `503`.
5. Return `2xx` only when every required sink succeeded. Ops replay and native dedup make retries
   idempotent. Resolved-only payloads are never forwarded to Ops; critical resolved delivery may
   use the native path.

Unset bridge configuration preserves today's native-only behavior. No new service or direct
Alertmanager credential mount is introduced.

## Tasks

### Task 1: Add v6 typed result state and safe reporting [HIGH]

**Goal:** Persist one current untrusted agent result and report it without leaking configured
secrets.

- [x] Add schema-v6 `agentResult` parsing, canonical hashing, v1-v5 compatibility, and round-trip
      tests in `src/ops-worker/types.ts` and task-store fixtures.
- [x] Add result-file creation after persisted attempt identity, exact bounded validation, cleanup,
      protocol-failure accounting, typed blocker transition, and retry clearing in
      `pi-attempt.ts` / `supervisor.ts`.
- [x] Add a shared field redactor and result-bearing Telegram report with per-field/total budgets.
- [x] Test all four result kinds, malformed/missing/id-mismatch files, restart/fault boundaries,
      five protocol failures, `/answer` + `/retry`, legacy exits, exact-secret redaction, and one
      durable report receipt.
- [x] Run the focused type/store/attempt/supervisor/report tests before Task 2.

### Task 2: Add the generic contract and convergent done check [HIGH]

**Goal:** Give every Alertmanager group one contract and prevent false completion or passive
custody starvation.

- [x] Add `ops.alertmanager-incident` constants, authorization snapshot v2, template registration,
      and intake mapping while preserving legacy availability snapshots.
- [x] Add bounded generic monitoring readers and the freshness/exact-absence/five-minute-stability
      composite check in `src/ops-worker/incident-checks.ts`.
- [x] Make an alert still present after a claim consume one of five remediation rounds; keep
      telemetry/stability waits free and scheduled.
- [x] Test every current rule family plus an unknown synthetic alert, all Alertmanager states,
      flaps, query errors/timeouts, auto-resolution, false claims to BLOCKED, replay/coalescing,
      and unchanged authorization scope.
- [x] Run focused intake/authorization/check/supervisor tests before Task 3.

### Task 3: Add the native forward-first bridge [HIGH]

**Goal:** Deliver genuine incidents to Ops without losing independent native escalation.

- [x] Generalize the packaged SOPS resolver for a named second secret without exposing values.
- [x] Add loopback-only source verification, authenticated Ops forwarding, required-sink result
      semantics, critical dual delivery, retry-safe dedup, and native-only compatibility to the
      packaged webhook.
- [x] Test exact/mismatched groups, query failure, Ops rejection/timeout, native failure, critical
      dual delivery, resolved-only handling, repeated retries, non-loopback rejection, and secret
      absence from argv/logs/errors.
- [x] Run focused Python/native monitoring tests before Task 4.

### Task 4: Verify and document the public package [HIGH]

**Goal:** Prove the public implementation is compatible, minimal, and releasable.

- [x] Update `docs/ops-worker.md`, monitoring docs, and `CHANGELOG.md` with the generic lifecycle,
      bridge contract, accepted detector-blinding risk, and rollback behavior.
- [x] Run `npm test`, `npm run lint`, `npm run build`, `npm pack --dry-run`, schema-guard,
      minimal-workspace, CLI-help, gitleaks, public PII/identity, and branch-diff checks.
- [x] Confirm no per-alert remediation code, new service, workflow capability, or unrelated change
      entered the diff.
- [x] Commit a clean current-head review verdict with no unresolved Critical/Major findings.

Validation evidence (2026-07-22): clean `npm ci`; full `npm test`; lint/typecheck;
build; 285-file package dry-run; schema-guard; built CLI help; minimal-workspace;
configured gitleaks branch scan; tracked-path, public PII, noreply author/committer,
inactivity, diffstat, and `git diff --check` gates all passed. The current-tree
review verdict is PASS with no unresolved Critical or Major findings. The diff
contains no per-alert remediation branch, new service definition, workflow
capability, startup activation, or unrelated runtime change.

## Acceptance

- Every current and future Alertmanager firing group uses the same objective, authority, and done
  check; alert text cannot grant actions or create a typed result.
- `DONE` requires fresh monitoring, exact absence in every Alertmanager state, and five stable
  minutes. Silence/inhibition cannot fake recovery.
- Waiting for telemetry/stability is free; repeated false/protocol claims converge to `BLOCKED`;
  useful work itself is not time-capped.
- Reports are durable, bounded, result-bearing, and redact configured canary secrets.
- A firing delivery is acknowledged only after all required sinks succeed; fallback does not hide
  failed Ops delivery from Alertmanager retries.
- Existing v1-v5 snapshots, operator-cli availability flow, custody, receipts, quota split, and
  session resumption remain compatible.

## Logical-run budget and continuation

The operator approved exactly **+2 logical Ralphex runs** on 2026-07-22:

1. **Run #3 — public package:** this plan, the public package repository, branch
   `issue-58-broad-alertmanager-incidents`, base `main`.
2. **Run #4 — private integration:** a separate short plan in a fresh private control worktree,
   created after the public API/release is frozen. Scope: package pin/composition, bridge wiring,
   Ops health/task-liveness doctor coverage, private tests/docs. It must not read or modify live
   plaintext secrets; enabling the existing bearer for the additional bridge consumer remains a
   separate credential/access-control execution gate.

Restarts/reviews of either exact plan lineage do not consume new logical runs. PR follow-through,
release mechanics, validate-only deploys, canary, rollback, and the separately approved-at-time-
of-execution outage drill consume no Ralphex runs.

After Run #3: public PR → clean CI/Copilot → merge → CalVer release. Then write/freeze the private
plan and execute Run #4. Activate validate-only first, preserve all protected local files, keep
native delivery live, run a self-clearing Prometheus→Alertmanager→bridge→Ops canary, and stop at
an explicit gate immediately before credential enablement or the reversible production outage.
