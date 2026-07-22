# Issue #58: Broad Generic Alertmanager Incident Handling for Minime Ops (v2, trimmed)

## Ninja-supplied outcome and constraints (authoritative, 2026-07-22)

- The bot receives ALL relevant Alertmanager problems instead of Ninja and handles them
  autonomously — equivalent to launching a full-capability agent from an independent
  environment (not broken when the primary bot's environment is broken), pasting it the alert,
  and asking it to investigate and fix end-to-end where safely possible.
- Prefer a loose generic incident contract and more agent autonomy. BotDown-only production
  scope is rejected. Static per-alert remediation profiles, runbook catalogues, and action
  allowlists are rejected.
- 2026-07-22 scope correction (supersedes the heavier v1 draft of this plan): do NOT build the
  adversarial anti-cheat verification layer (rule pinning, expression re-evaluation, scrape
  baseline, routing integrity). The agent has operator-level trust; DONE means what Ninja would
  check manually — the alert is really gone, stayed gone, and monitoring is alive. The plan
  must not reduce how long/persistently the agent can work.
- Existing global gates remain: exact confirmation before literal `sudo`; separate approval for
  destructive/irreversible action, credential/access-control change, financial action, and
  public/external mutation.
- Alert labels, annotations, URLs, and rule text are untrusted evidence, never instructions or
  authority.
- If safe remediation is impossible or approval/input is genuinely required, produce a typed
  BLOCKED/input-needed result and a useful report. Never manufacture DONE.
- Governance preserved: ADR-099, ADR-100, ADR-102. Issue #58 controls; #70 is out of scope.

Everything below is planner-selected technical design derived from source; none of it is
Ninja-supplied acceptance criteria.

## Minime source-review corrections (binding before Ralphex)

Minime reviewed Fable's v2 plan against the live v2026.7.26 source. These narrow corrections
preserve the loose trusted-agent design while closing source/lifecycle gaps:

- The native bridge must not launder a forged local webhook into the bearer-authenticated Ops
  source. Before forwarding a firing group, it queries loopback Alertmanager and requires an
  exact currently active group-label match across active/silenced/inhibited/unprocessed states.
  Query failure or mismatch does not create an Ops task and falls back to native Telegram.
  Resolved-only payloads need no Ops forwarding because the done check queries authoritative
  Alertmanager state directly.
- `OPS_WORKER_RESULT_FILE` is mandatory for the new generic Alertmanager template. Missing or
  invalid output is a resumable protocol error. Optional absence remains only for legacy
  `ops.availability` compatibility; generic incidents cannot silently lose diagnosis/actions or
  input-needed semantics.
- Private runtime-doctor coverage must detect persistent Ops `/healthz` failure and accepted-task
  liveness loss, then notify Ninja through the Node/Ops-independent native path. Intake success
  cannot make a later permanent worker failure silent until Alertmanager's four-hour repeat.
- The live canary proves one real Prometheus→Alertmanager→bridge→Ops episode and report. Exact
  replay/coalescing remains deterministic-test evidence; live acceptance does not wait four
  hours for `repeat_interval`.

## Verified baseline (public head `43e2346`, v2026.7.26; private state 2026-07-22)

- Intake accepts a bounded exact Alertmanager v4 webhook and stores alerts as untrusted
  evidence (`src/ops-worker/alertmanager-intake.ts:382-404`, limits :99-376), but hard-maps
  every firing group to template `ops.availability`, objective "Restore and verify Minime bot
  host availability.", check `ops.minime-availability` `{invariant: "minime-bot-host"}`
  (:539-614). Confirmed defect: an unrelated alert (e.g. `HostHighCPU`) receives the
  bot-availability objective and can converge falsely while the bot is healthy.
- The live composite verifier (`src/ops-worker/availability-checks.ts:260-449`) already has the
  right generic *shape* (freshness PRODUCT / alert-state PASSIVE / stability PRODUCT); its
  Alertmanager reader already matches exact persisted group labels across active + silenced +
  inhibited + unprocessed states (:589-628) — suppression already cannot fake resolution. Only
  its objective/params/service query are bot-specific (:13-15,:119-120).
- Zero-exit Pi is classified only `SUCCESS_CLAIM` (`src/ops-worker/pi-attempt.ts:1237-1279`,
  :2130-2168); no typed input-needed/impossible path exists although `ACTION_REQUIRED` and
  `BLOCKED` are in the closed outcome vocabulary (`src/ops-worker/types.ts:104-128`).
- The Ops Telegram report is only id/state/lastOutcome
  (`src/ops-worker/telegram-control.ts:232-256`).
- Autonomy mechanics that must not regress (and do not, see "Autonomy guarantees"):
  attempt/stall timeouts land in RESUMABLE with session resume, not failure
  (`pi-attempt.ts:95-109`, :1161-1172); remediation rounds are spent only on a
  verified-false claim (`supervisor.ts:3031-3063`); alertmanager tasks bypass initial quota
  admission (`types.ts:27-40`); `maxRemediation` parses 1..100 (`types.ts:2256`).
- Monitoring pins: Alertmanager v0.31.1, Prometheus v3.10.0
  (`monitoring/docker-compose.yml:3,20`); one receiver → native loopback webhook :9095,
  `group_by: [alertname]`, `send_resolved: true` (`monitoring/alertmanager/alertmanager.yml:4-15`);
  seven Prometheus-originated rules (`monitoring/prometheus/rules.yml:4-78`); 15s scrape/eval
  interval (`monitoring/prometheus/prometheus.yml:2-3`).
- Private launcher registers only the bot-availability contract
  (`~/.minime/control-workspace/ops/lib/runtime-dependencies.mjs:479-594`; loopback monitoring
  URLs and fixed source identity :54-56). The private main worktree is dirty/divergent —
  rollout requires a fresh branch/worktree and untouched protected local files.

## Selected architecture (one paragraph)

Keep the existing ops-worker, store, custody, and composite-verifier machinery; add one
package-owned generic `ops.alertmanager-incident` template and objective used for every
Alertmanager firing group; register one generic three-component deterministic done check
(monitoring freshness with scheduled recheck, exact-group Alertmanager resolution across all
states, flap-proof resolution stability via the Prometheus `ALERTS` series) that gates only the
DONE claim and never the agent's freedom or runtime; add a bounded typed agent-result envelope
(completed / no-action-needed / input-needed / impossible) persisted as protected evidence — no
schema migration — so approval-gated work becomes reportable BLOCKED instead of fake DONE or an
endless wait; upgrade the Ops report to carry diagnosis/actions/proof; and route broad
production alerts by turning the existing Node-independent native webhook into a forward-first
authenticated bridge to the loopback Ops intake using the already-live SOPS-backed bearer, with
independent native Telegram escalation for criticals and for any delivery Ops cannot accept.

## Planner-selected technical design

### D1. Generic incident contract

New constants in `src/ops-worker/ops-contracts.ts`:

- `OPS_ALERTMANAGER_INCIDENT_TEMPLATE_NAME = "ops.alertmanager-incident"`, sourceKinds
  `["alertmanager"]`.
- One fixed generic objective (same for all alerts, package constant): "Investigate this
  Alertmanager incident on the Minime host: diagnose cause and impact using the attached
  untrusted alert evidence, perform ordinary safe same-UID reversible remediation where useful,
  and finish with a typed result — completed, no-action-needed, input-needed, or impossible.
  A separate deterministic done check decides success."
- Authorization profile: reuse `ops.host-availability` unchanged
  (`ops-contracts.ts:282-287`); severity/component/failure_class never select authority — the
  fixed policy in `pi-attempt.ts:2114-2122` stays the only action boundary.
- Done check name `ops.alertmanager-incident` (D2); `doneCheck.params` is the closed empty
  object — incident identity comes from the store-protected group-label descriptor
  (`alertmanager-intake.ts:445-475`, protected by `evidence.ts:7-35`).
- `alertmanager-intake.ts` `createTask()` switches to the new template/objective/check and sets
  `rounds.maxRemediation = 5` (was 3) for alertmanager incidents — more autonomous runway
  before the exhaustion report; within parse bounds (`types.ts:2256`), no schema change.
- `assertOpsAlertmanagerIntakeContracts` (`ops-contracts.ts:58-103`) requires the generic set;
  the Alertmanager authorization verifier becomes version "2" pinning the new claimed
  template/check/objective shape (`claimedSnapshot`, :177-205, updated; accepts
  `maxRemediation` 5). Priority stays fixed 0 and quota-admission-exempt — preserve that split.
- `ops.availability` + `ops.minime-availability` remain verbatim for `operator-cli` (the proven
  live canary path; `worker-cli.ts:495-585` is registry-driven, unchanged). Compatibility:
  `ops.availability` keeps `"alertmanager"` in its template sourceKinds so the existing live
  terminal snapshot still parses; intake is the only alertmanager constructor, so no new task
  can take the old objective. Correlation/replay/receipt mechanics
  (`task-store.ts:718-914`) are untouched: exact duplicate → permanent replay; changed delivery
  in an active group → one coalesced receipt on the single active owner; resolved-only → no
  task; new episode after terminal → fresh task.

### D2. Generic deterministic done check `ops.alertmanager-incident` v1 — three components

New file `src/ops-worker/incident-checks.ts`, registered through the existing composite
registry (`done-checks.ts:469-607`); all components required, fixed 5s timeouts, bounded
loopback readers injected as today. Exports `createOpsIncidentDoneCheckRegistry` and
`createOpsMonitoringReaders(prometheusBaseUrl, alertmanagerBaseUrl, fetch)` so the private
launcher shrinks to URL + identity composition.

1. `monitoring-freshness` (PRODUCT). Generalized from `availability-checks.ts:271-323`: bounded
   raw-range query `up[2m]` (no job filter, ≤16 series); PASS when the query succeeds and the
   latest sample is within the 2-minute bound. **Unlike the availability version, NOT_READY
   always carries `nextCheckAt`** — telemetry lag loops in CHECKING and never spends a
   remediation round.
2. `alert-state` (PASSIVE). Exactly the existing reader semantics
   (`availability-checks.ts:589-628`): `GET /api/v2/alerts` with active + silenced + inhibited +
   unprocessed, exact persisted group-label match; absent everywhere → PASS, present in ANY
   state → DEFER with recheck (passive convergence, spends nothing). A silence or inhibition
   introduced during the incident cannot satisfy recovery — a suppressed alert still counts as
   present.
3. `resolution-stability` (PRODUCT). Bounded Prometheus range query of the built-in `ALERTS`
   series with the exact group-label matchers over the 5-minute window plus one 15s+jitter
   sample gap: zero samples (`alertstate` firing *or* pending) in the window → PASS; any sample
   (a flap or an impending re-fire) → NOT_READY with `nextCheckAt = last observed sample +
   window`, which resets stability in CHECKING without spending remediation
   (`supervisor.ts:2983-2995`). Trusted Prometheus API only; nothing agent- or alert-supplied.

Everything else is inherited: aggregation precedence and DEFER-only-for-PASSIVE
(`types.ts:2021-2043`, `done-checks.ts:190-351`), fresh-PASS-only DONE
(`types.ts:2615-2627`), verifier faults retry in CHECKING as infrastructure evidence, and
NOT_READY-without-recheck/PRODUCT_FAILURE spend a round toward BLOCKED at `maxRemediation`
(`supervisor.ts:2916-3064`) — by design the three components above emit *no*
round-spending outcome while waiting, so rounds are consumed only when the agent claims
completion and the check disproves it.

Seven current rule families (table-driven test matrix, one shared contract, zero per-alert
registrations; a rule added to `rules.yml` later flows through unchanged):

| Rule (rules.yml) | DONE means |
|---|---|
| BotDown :4-13 | group gone from AM in all states; no `ALERTS{alertname="BotDown"}` sample for 5m; telemetry fresh |
| SessionCrashes :15-24 | same, keyed on its exact group labels |
| TelegramAPIErrors :26-35 | same |
| TelegramNetworkErrors :37-46 | same |
| HostHighCPU :50-58 | same |
| HostDiskFull :60-68 | same |
| NodeExporterDown :70-78 | same |

Accepted residual risks (explicit, per the 2026-07-22 trust correction): detector blinding —
deleting/weakening a rule or scrape job makes the alert resolve and the harness will not
detect it. Mitigations: the fixed attempt policy prohibits treating monitoring changes as
repair, the recovered report lists every action taken (Ninja reads what happened), and a dead
scrape target surfaces as its own `BotDown`/`NodeExporterDown` incident. Non-Prometheus future
senders degrade gracefully: components 1–2 still apply; component 3 is vacuous for groups that
never produce `ALERTS` series (documented).

### D3. Typed agent results — protected evidence, no schema migration

- The harness passes `OPS_WORKER_RESULT_FILE` (a per-attempt path in the session directory)
  through spawn env — the exact mechanism of `CODEX_QUOTA_ATTEMPT_FILE_ENV`
  (`pi-attempt.ts:666-706`). The attempt prompt (`pi-attempt.ts:2521-2601`) instructs the agent
  to write before exit:

```
{ "type": "ops-agent-result-v1",
  "attemptId": <exact current attempt id>,
  "kind": "remediation-complete" | "no-action-needed" | "input-needed" | "impossible",
  "summary": <bounded diagnosis / root cause or explicit unknown>,
  "actions": [ <bounded strings, may be empty> ],
  "requestedInput": <bounded; only for input-needed>,
  "reason": "approval" | "information" | "policy-boundary" | "unrecoverable" }
```

- Exact-keys, byte-bounded, fail-closed parsing in `finishNaturalExit`
  (`pi-attempt.ts:1237-1279`) on zero exit:
  - `remediation-complete` / `no-action-needed` → existing `recordPiSuccessClaim` path
    (still only a claim; identical deterministic verification), distinct summaries.
  - `input-needed` / `impossible` → new `supervisor.recordPiTypedBlocker`: BLOCKED with
    `lastOutcome {kind:"PI_EXIT", result:"ACTION_REQUIRED"|"BLOCKED"}`, custody released with
    reason BLOCKED (required invariant, `types.ts:2692-2701`), `report.state = "PENDING"`.
    An agent-declared approval blocker becomes a reportable BLOCKED instead of an endless
    passive DEFER — and it grants nothing: no gate is bypassed.
  - File present but invalid (bad JSON/keys/bounds/attemptId mismatch) → CRASH-class resumable
    outcome, custody retained — never SUCCESS_CLAIM, never BLOCKED. Alert text cannot spoof
    the protocol: it cannot write files or know the attempt id.
  - File absent on zero exit is a resumable protocol error for the new generic
    `ops.alertmanager-incident` template. Only legacy `ops.availability` tasks retain absent-file
    → legacy SUCCESS_CLAIM compatibility; non-zero exits keep today's classification.
- Persistence: the validated envelope is appended as one **protected trusted evidence entry**
  (`kind:"pi"`, `type:"ops-agent-result-v1"`), with `isProtectedAlertmanagerEvidence`
  (`evidence.ts:7-35`) extended so it is never evicted/compacted. Schema stays v5 — no
  migration, no new task field; v1–v5 parsing, terminal snapshots, and verification subject
  hashes are untouched. `retryBlockedTask` (`supervisor.ts:2522-2579`) is extended to append a
  superseding marker so a stale envelope is not re-reported after `/answer` + `/retry`.

### D4. Result-bearing reports (ADR-100)

`reportSummary` (`telegram-control.ts:248-256`) becomes a bounded structured report from
persisted state only:

- Recovered (DONE): incident identity (alertname + bounded group labels from the protected
  descriptor), episode start, diagnosis/root cause from the envelope (or explicit "root cause
  unknown"), actions taken or "no action needed — condition auto-resolved", and deterministic
  proof: verifier identity/version, per-component `identity=outcome` line, `checkedAt` from the
  persisted verification record.
- Blocked (ACTION_REQUIRED / BLOCKED / remediation-exhausted): same fields plus the single
  exact requested input/approval and safe work already attempted.
- Bounds: existing summary/evidence byte limits; agent-sourced strings are included as bounded
  text only, never re-parsed; no secrets, tokens, private identifiers, or host-personal paths.
  Durable report receipts, single-flight PENDING→SENT, retry-without-repeat unchanged
  (`supervisor.ts:2618-2760`).

### D5. Routing: native forward-first bridge (selected over direct Alertmanager auth)

Direct `webhook_config.http_config.authorization` (supported by pinned v0.31.1, including
`credentials_file`) was evaluated and rejected: it requires a plaintext bearer file on disk
mounted into the Alertmanager container (a genuine credential-exposure change that would trip
the credential gate) and leaves no independent escalation branch when Ops is down short of
duplicating every notification to Ninja.

Selected: the packaged native webhook (`scripts/alertmanager_webhook.py`, loopback :9095,
validated/bounded/deduplicating :58-134,:246-290) gains a forward-first bridge mode;
`scripts/monitoring_native.py` SOPS resolution (:75-118, never logs values) is generalized to
resolve a second named secret — the *same already-live* SOPS-stored Ops intake bearer used by
`control-config.ts:264-296` — held in process memory only. No new credential, no compose/mount
change, `alertmanager.yml` untouched.

Bridge behavior (env-configured; unset env preserves exactly today's behavior):

- `MINIME_OPS_INTAKE_URL` and `MINIME_ALERTMANAGER_URL` must be loopback HTTP (else config is
  rejected at startup) plus the existing SOPS env pair for the intake bearer.
- Before forwarding a firing group, the bridge performs one bounded
  `GET /api/v2/alerts?active=true&silenced=true&inhibited=true&unprocessed=true` and requires an
  exact group-label match with the validated webhook. Query failure or mismatch falls back to
  native Telegram and does not forward. Resolved-only payloads are not forwarded.
- Once source presence is proved, the original validated bytes are POSTed verbatim with
  `Authorization: Bearer …` to `/intake/alertmanager` (`status-server.ts:395-484`; timing-safe
  auth :285-300) via `request_with_deadline` (`monitoring_native.py:229-260`).
- Escalation (ADR-100): Ops accepted (200) → quiet for noncritical groups; any
  `severity=critical` alert in the batch → native Telegram is ALSO sent immediately
  (independent escalation, regardless of Ops health); forward failure/rejection/timeout →
  native Telegram for the batch (any severity) so nothing goes dark; resolved-only batches are
  acknowledged without Ops forwarding and natively delivered only for critical groups.
- Toward Alertmanager: resolved-only no-op is 200; firing delivery is 200 when at least one
  durable delivery succeeded; 503 only when both
  paths failed (Alertmanager then redelivers — storm-safe: `BatchDeduplicator` suppresses
  duplicate Telegram sends and Ops intake replay is idempotent by delivery fingerprint).
- Independence: with Ops/Node/Pi down the bridge degrades to today's proven direct Telegram
  path; the native script never depends on Node or the worker. Private runtime-doctor coverage
  independently detects persistent Ops health/task-liveness loss after an accepted delivery.

## Autonomy guarantees (why this cannot stop the agent halfway)

The verifier gates only the DONE claim; the agent's tools, context parity, and session are
untouched. Concretely, with citations:

1. Attempt wall-clock (30m) and stall (20m) limits produce RESUMABLE with `session.resume` —
   the next attempt continues the same Pi session (`pi-attempt.ts:95-109`, :1161-1172). A
   multi-hour fix is a chain of resumed attempts, not a failure.
2. Quota/network/crash/verifier faults never spend remediation rounds; they retry from
   RESUMABLE/CHECKING indefinitely with bounded backoff (`supervisor.ts:2997-3030`,
   `types.ts:27-40` — alertmanager bypasses initial quota admission).
3. Remediation rounds are spent ONLY when the agent claims completion and the deterministic
   check disproves it (`supervisor.ts:3031-3063`). All three v2 components emit recheck-bearing
   waiting outcomes, so waiting is always free. Five disproved claims → BLOCKED + report
   (ADR-100 exhausted-handling), operator `/retry` resumes with context.
4. v2 removes every verifier-induced dead end that v1 had (rule-drift PRODUCT_FAILURE,
   rules-API QUERY_ERROR loops, missing-alertname BLOCKED, pre-launch pin failures).
5. Typed BLOCKED occurs only when the agent itself declares input-needed/impossible — Ninja's
   own requirement — and `/answer` + `/retry` resume the same task with steering context.

### Non-goals (YAGNI, explicit)

No per-alert remediation profiles/runbooks/action allowlists; no anti-cheat verification layer
(rule pinning, expr re-evaluation/hashing, scrape-target baseline, routing-integrity checks —
removed by the 2026-07-22 trust correction); no PromQL parser/workflow platform; no broker,
SQLite, second coordinator, verifier daemon, root helper, or new always-on service; no schema
migration; no change to `monitoring/prometheus/rules.yml` semantics; no enabling of
`pi-dynamic-workflows` (workspace-t71n.1); no #70 adapter work; no new ADR; no Alertmanager
container credential mounts; no rewriting of terminal legacy snapshots.

## Tasks

Testing approach: regular (code with tests in the same task; focused suite green before the
next task).

### Task 1: Generic incident contract and intake retarget

- [ ] Add `ops.alertmanager-incident` template, generic objective constant, and verifier v2
      claim shape in `src/ops-worker/ops-contracts.ts`; update
      `assertOpsAlertmanagerIntakeContracts`; retain `ops.availability` for `operator-cli` and
      parse-compat.
- [ ] Retarget `src/ops-worker/alertmanager-intake.ts` `createTask()` to the generic contract
      with `maxRemediation = 5`; correlation/replay/receipt mechanics unchanged.
- [ ] Write regression: table-driven over all seven rule families proving every firing group
      receives the generic objective/template/check and that no Alertmanager submission can
      construct the bot-availability objective (the pre-fix misassignment, demonstrated
      impossible).
- [ ] Write tests: verifier v2 PASS/DRIFT/INVALID_CLAIM/QUERY_ERROR; existing malformed/bounds/
      auth/resolved-only/replay/coalesce cases still pass; a persisted v5 snapshot with the old
      template still parses read-only.
- [ ] Run focused intake/contract tests — must pass before Task 2.

### Task 2: Generic three-component done check

- [ ] Implement `monitoring-freshness` (recheck-bearing), `alert-state` (generalized existing
      reader), and `resolution-stability` (`ALERTS` range query) plus
      `createOpsIncidentDoneCheckRegistry` / `createOpsMonitoringReaders` in
      `src/ops-worker/incident-checks.ts`, reusing the bounded loopback JSON reader and
      exact-group matching from `availability-checks.ts`.
- [ ] Write table-driven tests per rule family: success (group absent everywhere + empty
      `ALERTS` window + fresh telemetry → PASS→DONE), waiting (firing → DEFER; flap resets
      `nextCheckAt`; stale telemetry → NOT_READY with recheck — and assert **no remediation
      round is spent in any waiting state**), errors (Prometheus/AM query failure →
      QUERY_ERROR retry; out-of-contract reader output → VERIFIER_INVALID; component timeout →
      TIMEOUT).
- [ ] Write suppression tests: silenced/inhibited/unprocessed alert still counts as present
      (query provably includes all four states) — a silence cannot fake recovery.
- [ ] Write lifecycle tests through the supervisor: auto-resolved before action → no-action
      claim still requires the same PASS; resolves during repair → same path; five disproved
      claims → BLOCKED with PENDING report.
- [ ] Run focused tests — must pass before Task 3.

### Task 3: Typed agent-result envelope (protected evidence)

- [ ] Add `OPS_WORKER_RESULT_FILE` env + envelope validation in `pi-attempt.ts`
      `finishNaturalExit`; add `supervisor.recordPiTypedBlocker`; extend the attempt prompt
      with the envelope instruction; missing output is a resumable protocol error for generic
      incidents while legacy `ops.availability` retains absent-file compatibility.
- [ ] Extend `evidence.ts` protection for `ops-agent-result-v1` entries; extend
      `retryBlockedTask` with the superseding marker.
- [ ] Write tests: each envelope kind maps to its exact state/outcome; invalid/malformed/
      mismatched-attemptId envelopes are resumable errors (custody retained, no claim, no
      BLOCKED); typed BLOCKED persists across restart; `/answer` + `/retry` resumes and does
      not re-report the stale envelope; alert-text-only fixtures cannot produce a protocol
      result; envelope survives evidence compaction.
- [ ] Extend `ops-worker-fault-lab.test.ts`: crash between envelope validation and persist, and
      between BLOCKED persist and report delivery — resume without duplicate side effects.
- [ ] Run focused tests — must pass before Task 4.

### Task 4: Result-bearing reports

- [ ] Rebuild `reportSummary` in `src/ops-worker/telegram-control.ts` per D4 (recovered and
      blocked variants), sourced only from persisted task state, byte-bounded.
- [ ] Write tests: recovered report carries identity/diagnosis-or-unknown/actions-or-no-action/
      component proof line/checkedAt; blocked report carries the single requested input and
      attempted work; bounds enforced; report retry keeps a single durable receipt across
      restart; no secret/private-identifier patterns in fixtures.
- [ ] Run focused tests — must pass before Task 5.

### Task 5: Native webhook forward-first bridge

- [ ] Generalize `scripts/monitoring_native.py` secret resolution to a second named SOPS secret
      (parameterized env names; value never printed/logged/argv) and add a bounded
      loopback-only authenticated POST helper on `request_with_deadline`.
- [ ] Add bridge mode to `scripts/alertmanager_webhook.py` per D5: exact active-group source
      authentication, forward-first, critical dual-delivery, fallback-on-failure, 200/503
      semantics, dedup commit only after durable delivery, non-loopback Ops/Alertmanager URLs
      rejected at startup.
- [ ] Write tests (`monitoring-native.test.ts` + webhook module): exact active-group forwarding
      quiet for noncritical; forged/mismatched/stale firing payload never reaches Ops;
      source-query failure falls back; critical dual-delivers; Ops 4xx/5xx/timeout/down → native
      fallback + 200; both paths fail → 503 + dedup release; resolved-only does not forward;
      bearer absent from argv/logs/errors; unset env preserves today's behavior byte-for-byte.
- [ ] Run focused native tests — must pass before Task 6.

### Task 6: Docs, changelog, full validation

- [ ] Update `docs/ops-worker.md` (generic contract, three-component check, typed results,
      report format, autonomy semantics) and `docs/monitoring.md` (bridge mode, escalation
      policy, env contract); add `CHANGELOG.md` Unreleased entry.
- [ ] Verify acceptance: every fitness function below has a named passing test or documented
      evidence output.
- [ ] Run the full validation contract: `npm test`, `npm run lint`, `npm run build`,
      `npm pack --dry-run`, `npm run check:schema-guard-contract`, `node dist/cli.js --help`,
      minimal-workspace validation, configured gitleaks, public-safety/identity checks; verify
      the Ralphex diffstat equals `git diff --stat main...HEAD`.

## Completion fitness functions (each independently testable)

1. All seven rule families reach the same generic incident lifecycle; none can receive the
   bot-availability objective (named regression).
2. A new rule in the same Prometheus source uses the generic contract with zero registration
   change (test adds an eighth synthetic family).
3. Alert data grants no tool/action/authority anywhere.
4. DONE requires fresh composite PASS (group gone in all AM states + empty `ALERTS` stability
   window + fresh telemetry); safe repair and honest no-action share the identical proof.
5. A silence or inhibition cannot satisfy recovery (suppressed counts as present).
6. Missing telemetry, query failure, timeout, and malformed input fail closed with typed
   non-DONE behavior and scheduled retries.
7. Approval-gated/impossible handling reaches typed persistent BLOCKED/ACTION_REQUIRED with one
   useful report and resumes safely after `/answer` + `/retry`.
8. No waiting state spends a remediation round; attempt/stall timeouts and infra failures are
   resumable with session continuity (explicit autonomy tests).
9. Duplicate/replay/coalesce/flap/resolved-only/restart produce neither duplicate owners nor
   duplicate side effects/reports.
10. Routine noncritical occurrence is quiet while Ops owns it; recovered result reports once;
    critical/blocked/Ops-unavailable escalate independently; native path works with
    Node/Ops/Pi down.
11. Schema stays v5; v1–v5 parsing, custody, task identity, receipts, quota split, parity, and
    durable reporting remain compatible (existing suites green).
12. Full package validation + sanitization gates pass; diffstat matches Git exactly.

## Post-Completion (external actions — no Ralphex checkboxes)

Ralphex launch parameters for the single approved run: explicit `-b main`, Codex `gpt-5.6-sol`
xhigh, `.ralphex/config` `default_branch = main` verified, default iteration ceiling, plan file
immutable after launch, diffstat gate before PR.

**PR / release (zero logical runs).** Feature PR via the shared `github-pr` primitives; then a
release-only CalVer bump PR/tag (next `2026.7.x`). The persistent full-cycle supervisor owns
both.

**Private rollout (zero logical runs — ordinary recomposition, no private plan).** Fresh
worktree/branch from `origin/main`; never touch `config.local.yaml`,
`config/secrets.sops.yaml`, `crons.local.yaml`, deploy state, or unrelated dirty changes.
Steps with restart/reload notes:

1. Pin the released package for primary and the independently pinned Ops copy via the existing
   validated wrappers (`--validate-only` first). No restarts yet.
2. Recompose `ops/lib/runtime-dependencies.mjs` to consume `createOpsMonitoringReaders` + the
   generic contract factory; update the fixed authorization-registry assertion; run the
   existing private suites (`ops/test/*.test.mjs`, `verify-native-alertmanager.mjs`,
   `smoke-ops-worker.sh`). Extend the independent runtime doctor to verify Ops `/healthz` and
   accepted-task liveness, with native escalation on persistent loss. If this reveals
   substantive new private code, stop and ask Ninja for one additional logical run per ADR-102.
3. Add the bridge env (loopback Ops intake URL + existing SOPS intake-bearer key reference) to
   the private webhook entry point and its LaunchAgent plist; correct the stale private
   README/deploy text; no plaintext secrets, no destination identifiers in the public repo.
4. Reload order that never drops the independent alert path: restart Ops worker (new package),
   verify healthz + `/status`; then restart the native webhook LaunchAgent (bridge active;
   verify fallback by a deliberate Ops-stopped probe); Alertmanager/Prometheus untouched;
   primary bot restart only as the deploy wrapper requires. Restart only with no HELD custody
   owner (check `/status`), else wait for the safe boundary.
5. Before any reload: package `config validate` + `workspace validate`, private suites, and
   byte-identity of protected local files.

**Synthetic all-path canary (zero logical runs, safe/reversible, lab-first).** One temporary
self-clearing rule in the rule file: `alert: MinimeSyntheticCanary`,
`expr: vector(time() < bool <T>) == 1`, `for: 1m`, `severity: warning` — fires on load,
auto-resolves at wall-clock `<T>` (watchdog built into the expression; cannot stick; unique
alertname groups alone). Preflight: config check + reload + rules API healthy. Expected
evidence: rule fires → Alertmanager routes → bridge forwards → authenticated intake creates one
generic task → full-context attempt returns a typed result (expected `no-action-needed`; the
"synthetic" label is untrusted data and instructs nothing — the deterministic check, not the
label, closes the task) → composite PASS after `<T>` + stability window → DONE → one recovered
report with proof → tail audit. Exact replay/coalescing remains covered by deterministic
intake/fault-lab tests; the live canary does not wait four hours for `repeat_interval`. Cleanup:
remove the rule, reload, verify. Branches unsafe to exercise live (typed BLOCKED,
both-paths-down fallback, crash points) are covered by the fake/fault-lab suites; this canary —
unlike a forged intake POST — proves the real Prometheus→Alertmanager→bridge→intake route.

**Reversible outage drill (separately gated — requires Ninja's explicit go immediately before
execution).** Reversible primary-bot outage via its existing user-scope launchd wrapper (no
sudo, no data risk). Pre-armed independent fallback: a one-shot host-native timer job armed
before the outage that kickstarts the primary after the maximum outage duration (proposed 15
minutes) regardless of Ops/Pi/bridge health. Preflight: Ops healthz, Prometheus/Alertmanager
readiness, native escalation probe, pins recorded, rollback rehearsed, control channel live, no
HELD custody. Evidence chain: real `BotDown` fires → one generic incident owns custody → Ops
diagnoses and restarts the bot → group resolves and stays stable → composite PASS → DONE → one
recovered report → tail audit healthy → critical-severity native escalation observed
independently while routine noise stayed quiet. Abort on fallback-timer failure, custody
conflict, VPN loss, or Ninja abort. No legacy recovery-supervisor revival.

**Rollback (executable, evidence-preserving).** Unset the bridge env and restart the webhook
LaunchAgent first — this alone restores today's exact direct-Telegram behavior; repin previous
package versions through the validated wrappers (never edit `node_modules`); restore prior
plist/env from git history in the private branch; monitoring config untouched by this feature
(remove the canary rule + reload + verify if present). Retain all task snapshots, journals, Pi
sessions, receipts, and reports. Triggers: intake auth-failure loops, task storms, false-PASS
suspicion, verifier deadlock, noisy direct notifications, degraded native fallback.
Post-rollback verification: primary/Ops health, Prometheus targets up, one manual native alert
probe, report/control channel probe.

## Logical-run budget (ADR-102)

#58 had 2 approved logical runs and has used 2 of 2. **Recommendation: exactly 1 additional
logical Ralphex run.**

| # | Repository | Scope | Plan / lineage | Why Ralphex | Why not mechanics |
|---|---|---|---|---|---|
| 1 | `fitz123/minime-bot` (public) | Generic incident contract, three-component verifier, typed agent results, result reports, native bridge, tests/docs | `docs/plans/20260722-issue-58-broad-alertmanager-incidents.md` (this file, v2), branch `issue-58-broad-alertmanager-incidents`, base `main` | ~6 coherent code tasks across intake/contracts/verifier/protocol/native script with regression + lifecycle + autonomy test load — the substantial iterative shape ADR-102 budgets | New data contracts and lifecycle transitions; not reducible to deploy/config steps |

Zero additional runs are consumed by: feature-PR follow-through, release PR/tag, private
worktree/branch, package pins and validate-only deploys, the `runtime-dependencies.mjs`
recomposition + private config/plist edits (bounded, covered by existing private tests,
executed by the parent supervisor), monitoring config checks, staged activation, the synthetic
canary, the separately gated outage drill, and rollback verification. No second (private) run:
the private delta is composition of already-packaged capability; if that proves wrong during
rollout, custody is preserved and Ninja is asked once with evidence, per ADR-102.

**No run is authorized by this plan.** Required before launch: Ninja's explicit approval of
"+1 logical Ralphex run for issue #58 (public repo, this plan v2)".

## Remaining Ninja decisions / gates

1. Logical-run budget approval: the exact "+1 public run" above (required before any Ralphex
   launch).
2. Intentional production outage drill: existing separate gate, requested immediately before
   execution — not authorized by this plan.
3. Credential/access-control gate: **not triggered** — the bridge reuses the already-live
   SOPS-backed intake bearer with unchanged storage, scope, and access; the rejected
   direct-Alertmanager alternative would have triggered it.

No other outcome-level decisions remain.
