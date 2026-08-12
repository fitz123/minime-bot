# Issue #132 — Replace the bespoke Ops worker with a second full ordinary bot and a minimal trusted trigger input

## Goal

Make one ordinary `minime-bot` product safely instantiable twice, so a second independently deployed **full ordinary Minime** ("Ops") can run beside Primary on the same codebase, release stream, and single canonical shared behavior/configuration source, remain reachable in its own Telegram DM while Primary is down, and receive automatic operational triggers as ordinary turns of its normal persistent agent session.

This plan covers only repository implementation and its deterministic package validation:

1. per-deployment identity and writable-runtime isolation on top of one canonical shared configuration;
2. one minimal authenticated local trigger input inside the same bot process that adapts trigger evidence into the existing MessageQueue and persistent session;
3. retargeting the existing Alertmanager and runtime-doctor sources onto that input, with the narrow "reserve engineer unavailable" notice boundary;
4. removal of the historical bespoke worker product, including the worker-only parity/attestation machinery behind #143;
5. documentation, changelog, and a final cut pass.

## Operator-approved invariants

These are settled. Implementation must not reopen, extend, or reinterpret them. Every one of them is a hard acceptance boundary for the diff.

1. **One product instantiated twice.** Ops is a second independently deployed full ordinary `minime-bot` — not a separate product, reduced worker, or special workflow. One codebase, one release stream, one canonical source of shared behavior/configuration.
2. **Canonical shared configuration, allowlisted overlay.** Primary and Ops reference the same canonical configuration source directly. The per-deployment overlay carries only genuine identity and writable-runtime-isolation values (process/application root, deployment-owned session/media/echo/runtime state, token/DM binding, ports, labels/namespaces, metrics identity, trigger-input binding/credential reference). Two shared configurations plus manual or automatic synchronization are forbidden. The overlay must not copy or override model/thinking, context, Knowledge, rules, skills, extensions, tools, safety behavior, or reporting behavior.
3. **Trigger glue only.** The trigger path is exactly: authenticated trigger evidence → existing ordinary MessageQueue / persistent session → full ordinary agent. It owns no persistence, no separate queue, no task IDs, no retry/custody state, no lifecycle state, no status/result API, no incident routing, no supervision, no authorization engine, no reporting policy, no daemon, and no separate service.
4. **Source-owned delivery semantics.** Alertmanager, the runtime doctor, and any future source keep their own native retry, deduplication, and transition state. No new retry/redelivery subsystem is added on the bot side.
5. **Narrow control-path notice.** After source-native retries establish that Ops cannot receive a critical trigger, a source may send **zero or one** terse sanitized notice that the reserve engineer/control path was unavailable. No raw payload or low-level logs, no unconditional critical duplicate, no always-direct Primary-down route, no separate reporting/retry lifecycle.
6. **Telegram journal is ordinary UX.** Human-readable observability may span one or more ordinary Telegram messages. No database, receipt system, analytics, or rigid wire schema is implemented in the package.
7. **Trusted engineer, unchanged boundaries.** Ops operates under the existing ordinary Minime safety and external-action boundaries. This issue adds no authorization engine, action taxonomy, approval gate, or per-trigger approval checkpoint.
8. **#143 and #145 outcomes.** #143 is satisfied by removing the worker-only parity/attestation machinery with the worker — not by porting it. #145 is satisfied because Primary-down evidence reaches the full trusted agent; no deterministic restart-before-investigation step is added anywhere.
9. **Single-instance installs keep working.** Every new capability is opt-in. With no overlay and no trigger input configured, current behavior is byte-for-byte preserved, including direct runtime-doctor Telegram delivery.

### Drift tripwires

If any of the following seems required to finish a task, **stop and report it as architectural drift instead of implementing it**: a trigger store or spool; task/incident identifiers; a status, result, or inspection endpoint; a retry/backoff subsystem in the bot; custody or lifecycle state; an authorization profile or action taxonomy; a report/receipt record; a router, supervisor, or daemon around the trigger input; a second copy of shared behavior configuration plus a synchronization step; a scheduler or backlog feature.

## Non-goals

- No new Ops product, package, service, endpoint daemon, feature train, branch, pin, or release cycle.
- No task/custody/verifier/quota/receipt/control machinery, and no migration of the historical worker's task schema or state into anything new.
- No reporting, journaling, analytics, or incident-database implementation in the package; the journal is ordinary Telegram output produced by the agent.
- No #132-specific approval checkpoints, authorization profiles, action classes, or per-trigger policy.
- No deterministic restart or other trigger-owned repair pre-step for Primary-down evidence.
- No scheduler, issue scanner, maintenance queue, broker, or workflow engine. Issue #70 (scheduled GitHub maintenance/backlog) and issue #144 (one-shot/admin hardening) stay out of scope; the design only leaves future sources able to trigger the same ordinary agent through the same ordinary turn boundary.
- No compatibility shim, adapter, or rollback shim for the removed worker. Migration rollback is the previously released package version through the existing package-owned release slots, not retained code.
- No changes to `scripts/restart-bot.sh --worker` / `--foreground` launchd modes; that flag is launchd foreground restart and is unrelated to the removed ops-worker.
- No edits to historical evidence: `CHANGELOG.md` history, `docs/plans/completed/**`, and the two superseded worker plans `docs/plans/20260720-issue-58-parity-live-resources.md` and `docs/plans/20260722-issue-58-broad-alertmanager-incidents.md` stay unchanged as public historical records.
- No release, PR merge, deploy, restart, token handoff, cutover, or private deployment/monitoring configuration work in this plan; those are supervisor stages listed under Post-Completion.

## Evidence / source context

Verified by reading the current source on this branch (package version 2026.8.6):

- **Coexistence blockers are concrete.** `src/media-store.ts:8` pins `MEDIA_BASE` to `/tmp/bot-media` with only a test override; `src/echo-watcher.ts:22` pins `ECHO_DIR_BASE` to `~/.minime/bot-echo` while `scripts/deliver.sh:90` already honors an `ECHO_DIR_BASE` environment variable. Two ordinary processes would contend on both, and echo consumption deletes files after dispatch.
- **The runtime guard already keys on the right resources.** `src/runtime-guard.ts:178` builds locks from the resolved media root and a Telegram token fingerprint, and `src/main.ts:69-75` claims them at startup. Distinct media roots plus distinct tokens are therefore sufficient for two ordinary instances once the media root is deployment-owned. `MINIME_BOT_SLOT` already feeds metrics identity (`src/runtime-guard.ts:56`, `src/metrics.ts:18`).
- **Path resolution is already centralized.** `src/workspace-contract.ts` resolves package root, control workspace root, config/crons paths, `data/`, session store, `logDir`, `mediaBaseDir`, and `runtimeDir`, with `MINIME_CONTROL_WORKSPACE_ROOT`, `MINIME_CONFIG_PATH`, `MINIME_CRONS_PATH`, and `LOG_DIR` overrides. A second deployment already gets its own session store and `data/` by pointing `MINIME_CONTROL_WORKSPACE_ROOT` at its own root while `MINIME_CONFIG_PATH` points at the canonical config.
- **Config already supports layered merge.** `src/config.ts:80-119` implements `mergeDeep` plus `config.yaml` → `config.local.yaml`. The `.local` file is derived from the canonical config's own directory, so it cannot express a per-deployment overlay; that is the missing piece, and it must be allowlisted rather than free-form.
- **The ordinary turn boundary is `MessageQueue.enqueue`.** `src/message-queue.ts:217` accepts `(chatId, agentId, text, platform, cleanup?, dropCleanup?)`, returns `void`, debounces, collects mid-turn, and rejects on cap with a cooldown notice. `src/telegram-bot.ts` calls it for every human input and derives keys with `sessionKey()` (`src/telegram-bot.ts:202`). Echo is deliberately passive: `routeTelegramEchoToActiveTurn` (`src/telegram-bot.ts:229`) only steers an already-active turn and never enqueues or starts a session — so echo cannot serve as the trigger path.
- **The platform adapter is bound to a grammY `Context`.** `src/telegram-adapter.ts:45` derives `chatId` from `ctx.chat?.id` and sends through `ctx.reply` / `ctx.api`. A trigger without an incoming update needs an API-based construction path.
- **The sources already have the transport plumbing.** `scripts/monitoring_native.py` provides `normalize_loopback_http_url`, `post_loopback_json_with_bearer`, and SOPS-only bearer resolution; `scripts/alertmanager_webhook.py:532` forwards the validated body to the worker's intake and already builds bounded human-readable batch text. `scripts/runtime_doctor.py:344-379` keeps atomic versioned transition state with an advisory lock and today notifies Telegram directly on every transition, returning a non-zero exit so launchd retries the transition on the next interval.
- **The unconditional critical duplicate is real and must change.** `scripts/alertmanager_webhook.py:591-628` sends the native Telegram message for every critical batch *even when Ops accepted it*. That is the historical mechanism the approved narrow notice boundary supersedes.
- **The worker is fully separable.** `src/ops-worker/**` is 25,483 lines across 24 files. `src/pi-primary-resources.ts` (1,607 lines) and `src/pi-parity-contract-limits.ts` are imported only by `src/ops-worker/**`, the worker parity extension, and worker tests — no ordinary bot path uses them, which is exactly why removing them satisfies #143 without porting anything. The only non-worker entanglements are `src/cli.ts` (the `worker` command scope), `package.json` `files`, `scripts/build-package-artifacts.mjs:19-20`, `src/__tests__/package-install.test.ts`, `README.md:44-58`, and `docs/ops-worker.md`.
- **Python behavior is covered from the Node suite.** `src/__tests__/monitoring-native.test.ts` (1,831 lines) spawns `alertmanager_webhook.py` and `runtime_doctor.py` as subprocesses and asserts real delivery matrices, so source-side changes are validated by `npm test`. `scripts/tests/` additionally runs under `python3 -m unittest discover -s scripts/tests` (currently 16 tests, all passing).

## Technical approach

### 1. Instance overlay: one canonical configuration plus allowlisted deployment values

Extend `src/workspace-contract.ts` with two deployment-owned runtime roots and one overlay path, keeping a single resolution point with diagnostics:

- `MINIME_MEDIA_ROOT` → `mediaBaseDir` (default `/tmp/bot-media`; the existing `MINIME_TEST_MEDIA_BASE` per-pid test convention keeps precedence in tests).
- `ECHO_DIR_BASE` → new `echoDir` contract path (default `~/.minime/bot-echo`), reusing the variable name `scripts/deliver.sh` already honors so a deployment sets it once for both writer and reader.
- `MINIME_INSTANCE_CONFIG_PATH` → new `instanceConfigPath` diagnostic (absent by default).

`src/media-store.ts` derives `MEDIA_BASE` from the contract instead of computing its own constant; `src/echo-watcher.ts` defaults `echoDir` from the contract. `src/main.ts` needs no restructuring: the runtime guard and media preflight already consume the resolved root.

`src/config.ts` gains a third merge layer applied after `config.local.yaml`, read from `instanceConfigPath` when set, reusing the existing `mergeDeep`. Before merging, the overlay is checked against a fixed allowlist and rejected with a startup error naming the offending key path (never its value):

| Allowed in the overlay | Rationale |
|---|---|
| `secrets.sopsFile` | deployment credential reference |
| `telegramTokenSopsKey`, `telegramTokenEnv` | deployment token identity |
| `bindings` | deployment DM/chat binding identity |
| `metricsPort`, `metricsHost` | deployment port/metrics identity |
| `adminChatId`, `defaultDeliveryChatId`, `defaultDeliveryThreadId` | deployment delivery identity |
| `triggerInput` (whole section) | deployment trigger binding, port, credential reference |
| `agents.<id>.workspaceCwd` | deployment-owned writable agent workspace |

Everything else is rejected, explicitly including `agents.<id>.model`, `agents.<id>.thinking`, `agents.<id>.systemPrompt`, `agents.<id>.askAgent`, `sessionDefaults`, `piExtraExtensions`, `discord`, `logLevel`, and any unknown key. This is the mechanical guarantee that the second deployment cannot become a behavior fork, and it is why no synchronization mechanism is needed or permitted.

### 2. Minimal authenticated local trigger input

New `src/trigger-input.ts`, shipped in the same product and release, started only when the config declares `triggerInput`:

```yaml
triggerInput:
  port: 9466                 # required; presence of the section enables the input
  host: 127.0.0.1            # optional, loopback only (127.0.0.1 / ::1 / localhost)
  path: /trigger             # optional, default /trigger
  bearerSopsKey: ops.trigger # or bearerEnv: <ENV_NAME>; exactly one is required
  chatId: <configured chat>  # must match a configured Telegram binding
  threadId: <topic id>       # optional
```

Behavior, and nothing more:

- One `node:http` listener on loopback, mirroring the existing metrics-server pattern in `src/metrics.ts:481-525`. `EADDRINUSE` fails startup with a clear stable log line; **do not** extend `STARTUP_CONFLICT_REASONS`.
- One `POST <path>` route. Constant-time bearer comparison (`timingSafeEqual`), `Content-Type: application/json`, body ≤ 16 KiB, absolute read deadline.
- Payload contract: `{"source": "<slug ≤32 chars, [a-z0-9-]>", "text": "<bounded evidence text ≤ 4000 chars>"}`. Sources send already-bounded human-readable evidence; the bot does **not** parse Alertmanager schemas.
- The text is framed like existing ordinary context prefixes (`[Automatic trigger | source: <slug> | HH:MM]\n\n<text>`), then handed to the existing `MessageQueue.enqueue` for the binding resolved from `chatId`/`threadId`, using that binding's `agentId` and `sessionKey()`. Ordinary debounce, collect, steering, session ownership, and saturation behavior apply unchanged — there are no trigger-only queue semantics.
- Responses carry a status word only, no identifiers: `202` accepted into the queue, `429` queue saturated or shutting down, `401` bad/absent bearer, `400` malformed, `413` too large, `415` wrong content type, `404` other paths, `405` other methods.
- Startup validation: partial configuration, non-loopback host, or a `chatId` that matches no configured binding fails startup.

Two small supporting changes make this possible without duplicating logic:

- `src/telegram-adapter.ts`: extract `createTelegramApiAdapter({ api, chatId, binding, threadId, sessionDefaults })` implementing `PlatformContext` over `bot.api`, and make the existing `createTelegramAdapter(ctx, …)` delegate to it. Existing behavior and call sites are preserved.
- `src/message-queue.ts`: `enqueue` returns `boolean` (`true` when accepted into pending or collect, `false` when rejected by cap or while not accepting). Existing `void` call sites are unaffected; this is what lets the endpoint answer truthfully so the source can apply its own native semantics.

`src/main.ts` starts the input after `createTelegramBot` returns (it needs `bot.api` and the queue) and stops it in the existing shutdown closure beside `echoWatcher.stop()`.

### 3. Sources become triggers, with the narrow control-path notice

Rename the source-side bridge vocabulary away from the removed worker's intake product: `MINIME_OPS_INTAKE_URL` → `MINIME_TRIGGER_INPUT_URL`, `MINIME_OPS_INTAKE_SOPS_FILE`/`_KEY` → `MINIME_TRIGGER_INPUT_SOPS_FILE`/`_KEY`, `--ops-intake-url` → `--trigger-input-url`, `resolve_ops_intake_bearer` → `resolve_trigger_input_bearer`.

`scripts/alertmanager_webhook.py`:

- forwards `{"source": "alertmanager", "text": <existing bounded batch message>}` to the trigger input instead of the raw validated v4 body — the sanitized summary the source already builds;
- keeps every existing source-side behavior: group verification against loopback Alertmanager, stale/forged acknowledgement, `503` on required-sink failure so Alertmanager retries, bounded process-local batch deduplication;
- **removes the unconditional critical native duplicate.** A critical batch that the trigger input accepts produces no direct operator message at all;
- adds one bounded per-batch-key consecutive-failure counter reusing the existing bounded, TTL'd deduplicator style. After `TRIGGER_DELIVERY_FAILURE_NOTICE_THRESHOLD = 3` consecutive failed forwards of the same critical batch key, it sends **at most one** sanitized constant notice (`monitoring_native.CONTROL_PATH_UNAVAILABLE_NOTICE`, e.g. "Minime Ops is unavailable and could not receive a critical signal.") and marks that key as notified. Noncritical batches stay quiet and retryable exactly as today. State stays process-local and source-owned; nothing durable, no lifecycle.

`scripts/runtime_doctor.py`:

- when trigger-input settings are present, delivers the existing `incident_message(...)` text as `{"source": "runtime-doctor", "text": …}` to the trigger input instead of Telegram, and preserves its current retry shape (transition state is written only after successful delivery, so the next launchd interval retries);
- extends its existing versioned state document with two bounded source-owned fields (consecutive delivery failures for the pending transition, and whether the notice was already sent) so that after 3 consecutive failed deliveries of a **firing** transition it sends at most one sanitized `CONTROL_PATH_UNAVAILABLE_NOTICE` and then stops re-notifying for that transition. Recovered transitions never produce a notice;
- with no trigger-input settings, keeps today's direct Telegram delivery unchanged for single-instance installs.

No source classifies incidents into new categories, owns a task, or reports a result. #145's required outcome follows structurally: Primary-down evidence now enters the full ordinary agent's queue and session with no trigger-owned pre-step.

### 4. Worker removal

Delete the historical product and its only consumers. `src/pi-primary-resources.ts` and `src/pi-parity-contract-limits.ts` are removed **with** the worker; this is the #143 outcome, and no dedupe/realpath contract is ported anywhere. `restart-bot.sh --worker` (launchd foreground mode) is untouched.

## Validation Commands

Focused, per task (run the narrowest first):

```bash
npm run lint
npm run test:file -- src/__tests__/<changed-area>.test.ts
python3 -m unittest discover -s scripts/tests
```

Full package validation, required at the end of every task and as the final gate:

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

Release, PR follow-through, deploy, restart, token handoff, and cutover are **not** validation steps of this plan.

## Tasks

### Task 1: Deployment-owned runtime roots and allowlisted instance config overlay

**Serves:** Issue #132 Ninja's inputs — "There is one product, one codebase, one release stream, and one canonical source of shared behavior/configuration" and "Deployment identity and writable runtime state may differ where required for safe coexistence and recovery independence" — plus the operator-approved decision "Limit the per-deployment overlay to genuine identity/runtime-isolation values such as process/application root, deployment-owned session/media/echo/runtime state, token/DM binding, ports, labels/namespaces, and metrics identity."

- [ ] add `MINIME_MEDIA_ROOT` → `mediaBaseDir` and `ECHO_DIR_BASE` → new `echoDir` resolution to `src/workspace-contract.ts`, preserving the existing `MINIME_TEST_MEDIA_BASE` per-pid test convention and reporting both through `effectivePaths` diagnostics
- [ ] add `MINIME_INSTANCE_CONFIG_PATH` → `instanceConfigPath` to the same contract (absent by default)
- [ ] derive `MEDIA_BASE` in `src/media-store.ts` from the contract instead of its own constant, and default `EchoWatcher`'s directory from the contract in `src/echo-watcher.ts`
- [ ] in `src/config.ts`, merge the instance overlay after `config.local.yaml` using the existing `mergeDeep`, gated by a new allowlist check that rejects any non-allowlisted key path with a startup error naming the path and never the value
- [ ] surface the overlay path and both runtime roots in `src/workspace-validator.ts` output so `workspace validate` shows the effective per-deployment values
- [ ] write tests in `src/__tests__/workspace-contract.test.ts` for both new env roots, the overlay path, defaults, and precedence versus the test media convention
- [ ] write tests in `src/__tests__/config-merge.test.ts` for overlay precedence over `config.local.yaml`, each allowlisted key path, and rejection of `agents.<id>.model`, `agents.<id>.thinking`, `sessionDefaults`, `piExtraExtensions`, `discord`, and an unknown key (asserting the message contains the key path and not the value)
- [ ] update `src/__tests__/media-store.test.ts` and `src/__tests__/echo-watcher.test.ts` for the configured roots, including that two configured roots do not observe each other's files
- [ ] run the focused tests, then the full validation command list — all must pass before Task 2

### Task 2: Minimal authenticated local trigger input into the ordinary MessageQueue

**Serves:** Issue #132 operator-approved decision D2 — "a minimal authenticated local input inside the same ordinary `minime-bot` process/release may adapt evidence into the existing Ops MessageQueue and persistent session: trigger evidence → existing MessageQueue/session → full ordinary Minime agent", which "owns no persistence, separate queue, task IDs, retry/custody state, lifecycle state, status/result APIs, incident routing, supervision, authorization, reporting semantics, daemon, or separate service."

- [ ] extract `createTelegramApiAdapter({ api, chatId, binding, threadId, sessionDefaults })` in `src/telegram-adapter.ts` and make the existing `createTelegramAdapter(ctx, …)` delegate to it without behavior change
- [ ] change `MessageQueue.enqueue` in `src/message-queue.ts` to return `boolean` (accepted into pending/collect vs. rejected by cap or shutdown), leaving all existing call sites and saturation-notice behavior unchanged
- [ ] add the `triggerInput` section to `src/config.ts` (`port` required, optional `host` restricted to loopback, optional `path` defaulting to `/trigger`, exactly one of `bearerSopsKey`/`bearerEnv` resolved through the existing secret path, `chatId`, optional `threadId`), failing startup on partial or non-loopback configuration and on a `chatId` that matches no configured Telegram binding
- [ ] implement `src/trigger-input.ts`: one loopback listener, one POST route, timing-safe bearer check, 16 KiB body ceiling with an absolute read deadline, `{"source","text"}` validation with the documented bounds, ordinary trigger framing, one `enqueue` call through the API adapter, and the `202/400/401/404/405/413/415/429` status-word-only response contract — with no stored state, identifiers, or additional routes
- [ ] wire start/stop into `src/main.ts` after `createTelegramBot` and inside the existing shutdown closure; fail startup with a stable log line on `EADDRINUSE` without extending `STARTUP_CONFLICT_REASONS`
- [ ] write `src/__tests__/trigger-input.test.ts` covering accepted enqueue into the resolved binding and session key, rejected bearer, oversized/malformed/wrong-content-type bodies, wrong path/method, saturated-queue `429`, disabled-by-default behavior, and that no file, identifier, or state is produced by a trigger
- [ ] update `src/__tests__/message-queue.test.ts` and `src/__tests__/telegram-adapter.test.ts` for the new return value and the extracted API adapter, and add config validation cases to `src/__tests__/config-defaults.test.ts` or `src/__tests__/config-secrets.test.ts` as appropriate
- [ ] run the focused tests, then the full validation command list — all must pass before Task 3

### Task 3: Retarget Alertmanager and runtime-doctor sources; apply the control-path notice boundary

**Serves:** Issue #132 Ninja's inputs — "Alertmanager, runtime doctor, cron, and future equivalent sources are only triggers for the same ordinary full agent. They do not own tasks, custody, incident lifecycle, receipts, verifiers, admission/status/result APIs, or reporting policy"; operator-approved decision D6 — "If source-native retries establish that Ops cannot receive a critical trigger, zero or one terse sanitized notice may tell the operator that the reserve engineer/control path was unavailable"; and the #145 outcome — "Primary-down evidence reaches the full trusted agent, which chooses sensible recovery using ordinary tools."

- [ ] rename the bridge vocabulary in `scripts/monitoring_native.py` and `scripts/alertmanager_webhook.py` to `MINIME_TRIGGER_INPUT_URL`, `MINIME_TRIGGER_INPUT_SOPS_FILE`, `MINIME_TRIGGER_INPUT_SOPS_KEY`, `--trigger-input-url`, and `resolve_trigger_input_bearer`, and add the shared sanitized `CONTROL_PATH_UNAVAILABLE_NOTICE` constant to `scripts/monitoring_native.py`
- [ ] change `forward_to_ops` in `scripts/alertmanager_webhook.py` to post the bounded `{"source": "alertmanager", "text": <existing batch message>}` document, keeping the loopback/bearer/timeout contract
- [ ] remove the unconditional critical native duplicate from `_deliver_bridge_batch` so an accepted critical trigger produces no direct operator message, while preserving source verification, stale/forged acknowledgement, `503` retry semantics, and existing batch deduplication
- [ ] add a bounded, process-local, per-batch-key consecutive-forward-failure counter that emits at most one sanitized `CONTROL_PATH_UNAVAILABLE_NOTICE` for a critical batch after three consecutive failures and never repeats it for that key; noncritical batches stay quiet and retryable
- [ ] route `scripts/runtime_doctor.py` transitions to the trigger input when its settings are present, keep transition state written only after successful delivery, extend the versioned state document with bounded consecutive-failure and notice-sent fields, emit at most one sanitized notice for a firing transition after three consecutive failed deliveries, never notify for recovered transitions, and keep today's direct Telegram delivery when no trigger input is configured
- [ ] add optional trigger-input placeholders to `examples/monitoring/ai.minime.alertmanager-webhook.plist` and `examples/monitoring/ai.minime.runtime-doctor.plist`, keeping them Node-free and `plutil`-valid
- [ ] update `docs/monitoring.md` (bridge settings, the new delivery matrix, and the control-path notice boundary) so the documented behavior matches the code
- [ ] update `src/__tests__/monitoring-native.test.ts`: replace the critical dual-delivery expectations with "accepted critical trigger produces no direct message", add cases for zero-or-one sanitized notice after repeated forward failures, absence of raw payload/log text in that notice, doctor routing to the trigger input, doctor retry across a failed delivery, unchanged direct delivery when unconfigured, and unchanged noncritical quiet-retry behavior
- [ ] run the focused tests plus `python3 -m unittest discover -s scripts/tests`, then the full validation command list — all must pass before Task 4

### Task 4: Remove the historical worker product and its worker-only attestation machinery

**Serves:** Issue #132 operator-approved decision — "Replace the bespoke worker with an independently deployed ordinary `minime-bot` instance"; scope — "removal/archive of worker-only code, tests, docs, runtime routes, and state references after verified cutover"; and the #143 outcome — "remove worker-only parity/attestation machinery where it caused the resource-topology crash loop. Do not port worker product semantics into ordinary Minime without independent evidence."

- [ ] delete `src/ops-worker/**`, `src/pi-primary-resources.ts`, `src/pi-parity-contract-limits.ts`, `src/pi-extensions/ops-worker-conversation-bounds.ts`, `src/pi-extensions/ops-worker-parity-attestation.ts`, `extensions/pi/ops-worker-conversation-bounds.ts`, and `extensions/pi/ops-worker-parity-attestation.ts`
- [ ] delete the worker test surface: `src/__tests__/ops-worker-*.test.ts`, `src/__tests__/fixtures/ops-worker-*.ts`, and `src/__tests__/fixtures/fake-pi-process.mjs` (used only by worker tests)
- [ ] remove the `worker` command scope from `src/cli.ts` — its import, `workerDependencies` option, worker-only flags, help text, `runCli` guard, and the `runCliAsync` branch — leaving the async entrypoint behavior correct for all remaining commands
- [ ] remove worker entries from `package.json` `files` (`dist/ops-worker/**`, `docs/ops-worker.md`) and from `scripts/build-package-artifacts.mjs`, and delete `docs/ops-worker.md`
- [ ] remove the ops-worker section and links from `README.md` while preserving the unrelated `scripts/restart-bot.sh --worker` / foreground launchd documentation in `README.md` and `docs/launchd-operations.md`
- [ ] update `src/__tests__/package-install.test.ts` so the packaged file expectations match the removed artifacts, and update `src/__tests__/cli.test.ts` for the removed command scope
- [ ] grep the working tree for `ops-worker`, `opsWorker`, `OpsWorker`, `pi-primary-resources`, and `parity attestation`, and confirm the only remaining hits are historical evidence (`CHANGELOG.md`, `docs/plans/**`) that must stay unchanged
- [ ] run the focused tests, then the full validation command list — all must pass before Task 5

### Task 5: Second-deployment documentation, changelog, and final cut pass

**Serves:** Issue #132 Ninja's inputs — "Ops is a second independently deployed full Minime, not a separate product… Its primary purpose is to remain Telegram-accessible while Primary is unavailable" — and the issue's stated end state, "Final state has one product/release/config source and zero active worker-only references."

- [ ] add a README section documenting running a second deployment of the same release: canonical `MINIME_CONFIG_PATH` plus deployment-owned `MINIME_CONTROL_WORKSPACE_ROOT`, `MINIME_INSTANCE_CONFIG_PATH`, `MINIME_MEDIA_ROOT`, `ECHO_DIR_BASE`, `LOG_DIR`, `CRON_HEALTH_TEXTFILE_DIR`, `MINIME_BOT_SLOT`, and distinct token/metrics port — stating explicitly that the overlay is allowlisted, that shared behavior/configuration has exactly one source, and that no synchronization step exists or is needed
- [ ] document the trigger input in README and `docs/monitoring.md`: configuration shape, payload/response contract, that it only starts an ordinary MessageQueue/session turn, and that it owns no task, state, lifecycle, status, or reporting surface
- [ ] add one `## Unreleased` entry to `CHANGELOG.md` describing the second ordinary deployment, the minimal trigger input, the control-path notice boundary, and the worker removal, referencing (#132); leave all released sections untouched
- [ ] update `src/__tests__/project-naming.test.ts` for the changed documentation/`files` expectations and add assertions that the packaged docs describe one canonical configuration source and no worker product
- [ ] verify acceptance end to end in tests: both deployments' roots are isolated, one shared setting change requires no duplicate-config sync, a trigger starts an ordinary turn and creates no lifecycle artifact, an accepted critical trigger produces no direct duplicate, a confirmed undeliverable critical trigger produces zero or one sanitized notice, and the package builds and installs without worker artifacts
- [ ] **final cut pass:** re-read the complete diff against the Operator-approved invariants and Drift tripwires above; remove any Ops-specific abstraction, helper, option, constant, or naming that is not required by an invariant; confirm the trigger path added no persistence, identifiers, retry, lifecycle, status/result surface, authorization, or reporting semantics; confirm no restart-before-investigation step exists; confirm no second shared-configuration source or sync step exists
- [ ] **privacy pass:** confirm the diff contains no private paths, identities, tokens, chat IDs, workspace-internal links, or private evidence — all new examples use placeholders, and all new log/response strings are stable sanitized text with no payload echo
- [ ] run the full validation command list plus `python3 -m unittest discover -s scripts/tests`; report changed files, commands, and results

## Post-Completion

*Supervisor-owned stages and manual verification. No checkboxes; nothing here is a Ralphex task.*

**Release and rollout**

- Ship this work in the ordinary `minime-bot` release stream; no separate Ops package, branch, pin, or feature train is created. Controlled staggered rollout may reach Primary before Ops, but steady state converges on the same release.
- Migration rollback is the previously released package version through the existing package-owned release slots; the historical worker exists only as that prior release, and only until replacement validation succeeds.

**Deployment configuration (private, outside this repository)**

- Point the Ops deployment at the canonical shared configuration and give it only the allowlisted overlay: token/DM binding, metrics port and slot label, media/echo/log/cron-health roots, control workspace root, agent workspace, and trigger-input port plus bearer reference.
- Do not copy Main crons into the Ops deployment; Main crons remain the canonical schedules.
- Update the private launchd plists and monitoring configuration for the renamed trigger-input environment variables, and register the second legitimate monitoring target/expected identity so it is not classified as foreign.
- Add the shared human-readable Telegram journal guidance as an ordinary shared Markdown rule in the canonical rules source; it is deliberately not implemented in the package.

**Cutover and verification**

- Reversible, mutually exclusive handoff of the existing Ops Telegram token: stop the historical worker, then start ordinary Ops, so exactly one poller owns the token.
- Coexistence check: Primary and Ops serve their own DMs and voice concurrently with isolated writable media/echo/session/runtime state, and Ops runtime operations cannot prune Primary artifacts.
- Canonical-configuration check: change one shared setting once and confirm both deployments observe it with no duplicate-config synchronization.
- Trigger canaries: one real Alertmanager group and one real runtime-doctor transition each start an ordinary turn in the Ops session, with no task, custody, or status artifact anywhere.
- Journal check: a reportable incident produces an understandable Telegram journal in Ops's own DM covering what happened, the decision, the action, and the verified result, without raw payloads.
- Control-path check: Ops healthy or merely slow produces no direct duplicate; a confirmed undeliverable critical trigger produces zero or one sanitized notice.
- #143 check: the previously crash-looping resource topology starts ordinary Ops normally. #145 check: controlled Primary-down evidence reaches the full agent, which repairs, verifies, and journals without any #132-specific approval prompt.
- Cleanup after success: remove old worker runtime state, routes, and configuration references, then confirm zero active worker references remain.
