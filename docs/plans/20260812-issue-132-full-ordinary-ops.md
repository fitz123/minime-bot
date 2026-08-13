# Issue #132 — Replace the bespoke Ops worker with a second full ordinary bot and a minimal trusted trigger input

## Goal

Make one ordinary `minime-bot` product safely instantiable twice, so a second independently deployed **full ordinary Minime** ("Ops") can run beside Primary on the same codebase, release stream, and single canonical shared behavior/configuration source, remain reachable in its own Telegram DM while Primary is down, and receive automatic operational triggers as ordinary turns of its normal persistent agent session.

This plan covers only repository implementation and its deterministic package validation:

1. per-deployment identity and writable-runtime isolation on top of one canonical shared configuration;
2. one minimal authenticated local trigger input inside the same bot process that adapts trigger evidence into the existing MessageQueue and persistent session;
3. removal of the historical bespoke worker product, including the worker-only parity/attestation machinery behind #143;
4. retargeting the existing Alertmanager and runtime-doctor sources onto that input, with the narrow "reserve engineer unavailable" notice boundary;
5. documentation, changelog, and a final cut pass.

## Operator-approved invariants

These are settled. Implementation must not reopen, extend, or reinterpret them. Every one of them is a hard acceptance boundary for the diff.

1. **One product instantiated twice.** Ops is a second independently deployed full ordinary `minime-bot` — not a separate product, reduced worker, or special workflow. One codebase, one release stream, one canonical source of shared behavior/configuration.
2. **Canonical shared configuration, allowlisted overlay.** Primary and Ops reference the same canonical configuration source and live agent `workspaceCwd` directly. The per-deployment overlay carries only genuine identity and writable-runtime-isolation values (process/application root, deployment-owned session/media/echo/runtime state, token/DM identity fields, ports, labels/namespaces, metrics identity, trigger-input binding/credential reference). Two shared configurations plus manual or automatic synchronization are forbidden. The overlay must not copy or override model/thinking, context, Knowledge, rules, skills, extensions, tools, safety behavior, reporting behavior, behavioral binding fields, or `workspaceCwd`.
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
- **Path and writable-state resolution are already centralized.** `src/workspace-contract.ts` resolves package root, control workspace root, config/crons paths, `data/`, session store, `logDir`, `mediaBaseDir`, and `runtimeDir`, with `MINIME_CONTROL_WORKSPACE_ROOT`, `MINIME_CONFIG_PATH`, `MINIME_CRONS_PATH`, and `LOG_DIR` overrides. A second deployment already gets its own bot session store and `data/` by pointing `MINIME_CONTROL_WORKSPACE_ROOT` at its own root while `MINIME_CONFIG_PATH` points at the canonical config.
- **The live context root is not an instance overlay.** `AgentConfig.workspaceCwd` is both the Pi cwd and the source of `CLAUDE.md`, Knowledge, rules, and persona (`src/types.ts`, `src/pi-context-assembler.ts`, `src/pi-rpc-protocol.ts`). Pi transcript storage can already be isolated without changing that shared context through `PI_CODING_AGENT_SESSION_DIR` (`src/interactive-session-binding.ts`), and `assemblePiContext` already has an `artifactWorkspaceCwd` seam for writing generated bundle/persona files outside the live context root.
- **Config already supports layered merge, but broad arrays would fork behavior.** `src/config.ts:80-119` implements `mergeDeep` plus `config.yaml` → `config.local.yaml`; arrays are replaced wholesale. `TelegramBinding` includes behavioral routing, mention, topic, voice-echo, and typing fields (`src/types.ts`). The instance layer therefore needs an allowlisted identity-only binding patch keyed by a unique canonical label, not a replacement `bindings` array, and it must reject `agents.<id>.workspaceCwd`.
- **The ordinary turn boundary is `MessageQueue.enqueue`.** `src/message-queue.ts:217` accepts `(chatId, agentId, text, platform, cleanup?, dropCleanup?)`, returns `void`, debounces, collects mid-turn, and rejects on cap with a cooldown notice. `src/telegram-bot.ts` calls it for every human input and derives keys with `sessionKey()` (`src/telegram-bot.ts:202`). Echo is deliberately passive: `routeTelegramEchoToActiveTurn` (`src/telegram-bot.ts:229`) only steers an already-active turn and never enqueues or starts a session — so echo cannot serve as the trigger path.
- **The platform adapter is bound to a grammY `Context`.** `src/telegram-adapter.ts:45` derives `chatId` from `ctx.chat?.id` and sends through `ctx.reply` / `ctx.api`. A trigger without an incoming update needs an API-based construction path.
- **The sources already have the transport plumbing and one compatible evidence ceiling.** `scripts/monitoring_native.py` provides `normalize_loopback_http_url`, `post_loopback_json_with_bearer`, SOPS-only bearer resolution, and `TELEGRAM_TEXT_MAX_UTF16_UNITS = 4096`; `scripts/alertmanager_webhook.py` already bounds its human-readable batch summary to that UTF-16-unit ceiling. `scripts/runtime_doctor.py` keeps an atomic versioned transition document with an advisory lock and today writes the new incident set only after Telegram delivery succeeds, returning non-zero so launchd retries the transition.
- **The Alertmanager bridge has three obsolete direct paths.** `scripts/alertmanager_webhook.py:_deliver_bridge_batch` sends critical resolved-only batches directly without forwarding them, sends the full critical summary directly on verification exceptions, and sends a direct critical duplicate after a successful forward. All three conflict with the approved bridge-mode matrix. A process-local TTL notice counter cannot guarantee D6's at-most-one bound across restart/expiry/eviction, so Alertmanager must choose the valid D6 outcome of zero direct notices and retain only Alertmanager-owned retry/grouping/deduplication.
- **Trigger startup currently depends on Telegram construction.** `src/main.ts` creates `bot.api` and the ordinary queue only inside the resolved-Telegram-token branch. Enabling `triggerInput` must therefore fail config/startup validation unless a Telegram token and matching binding resolve; silently omitting the listener would cause endless source retries.
- **The worker is separable, but removal must cover non-obvious consumers.** `src/ops-worker/**` is 25,483 lines across 24 files. `src/pi-primary-resources.ts`, `src/pi-parity-contract-limits.ts`, the two worker Pi extensions, their fixtures, and worker tests have no ordinary consumer. `captureResponseStatus` in `src/pi-extensions/codex-usage.ts` is used only by the worker parity wrapper. Active references also include `src/pi-extensions/README.md`, `src/cli.ts`, `package.json`, `scripts/build-package-artifacts.mjs`, package/CLI tests, `README.md`, and `docs/ops-worker.md`; complete removal requires import/use analysis in addition to content grep.
- **Python behavior is covered from the Node suite.** `src/__tests__/monitoring-native.test.ts` (1,831 lines) spawns `alertmanager_webhook.py` and `runtime_doctor.py` as subprocesses and asserts real delivery matrices, so source-side changes are validated by `npm test`. `scripts/tests/` additionally runs under `python3 -m unittest discover -s scripts/tests` (currently 16 tests, all passing).

## Technical approach

### 1. Instance overlay: one canonical live context plus deployment-owned writable state

Extend `src/workspace-contract.ts` with two deployment-owned runtime roots and one overlay path, keeping a single resolution point with diagnostics:

- `MINIME_MEDIA_ROOT` → `mediaBaseDir` (default `/tmp/bot-media`; the existing `MINIME_TEST_MEDIA_BASE` per-pid test convention keeps precedence in tests).
- `ECHO_DIR_BASE` → new `echoDir` contract path (default `~/.minime/bot-echo`), reusing the variable name `scripts/deliver.sh` already honors so a deployment sets it once for both writer and reader.
- `MINIME_INSTANCE_CONFIG_PATH` → new `instanceConfigPath` diagnostic (absent by default).

`src/media-store.ts` derives `MEDIA_BASE` from the contract instead of computing its own constant; `src/echo-watcher.ts` defaults `echoDir` from the contract. `src/main.ts` needs no restructuring: the runtime guard and media preflight already consume the resolved root.

`src/config.ts` gains a third layer applied after `config.local.yaml`, read from `instanceConfigPath` when set. Generic allowlisted scalar/object fields reuse `mergeDeep`; Telegram identity uses a separate overlay-only `bindingIdentityOverrides` map keyed by an existing unique canonical binding `label`. Each patch may contain only `chatId` and `topicId`, must resolve exactly one canonical binding, and preserves canonical `agentId`, `kind`, `label`, `requireMention`, `topics`, `voiceTranscriptEcho`, `typingIndicator`, and every other behavioral field. Validation rejects an offending key path without printing its value. Because relative agent workspaces currently resolve against the deployment control root, enabling `instanceConfigPath` also requires every canonical `agents.<id>.workspaceCwd` to be absolute; the overlay still cannot supply or change that field. With no instance overlay, existing relative `workspaceCwd` resolution remains unchanged.

| Allowed in the overlay | Rationale |
|---|---|
| `secrets.sopsFile` | deployment credential reference |
| `telegramTokenSopsKey`, `telegramTokenEnv` | deployment token identity |
| `bindingIdentityOverrides.<canonical-label>.chatId`, `.topicId` | deployment DM/topic identity only; not a replacement binding |
| `metricsPort`, `metricsHost` | deployment port/metrics identity |
| `adminChatId`, `defaultDeliveryChatId`, `defaultDeliveryThreadId` | deployment delivery identity |
| `triggerInput` (whole section) | deployment trigger binding, port, credential reference |

Everything else is rejected, explicitly including raw `bindings`, behavioral binding fields, `agents.<id>.workspaceCwd`, `agents.<id>.model`, `agents.<id>.thinking`, `agents.<id>.systemPrompt`, `agents.<id>.askAgent`, `sessionDefaults`, `piExtraExtensions`, `discord`, `logLevel`, and any unknown key. Overlay-enabled deployments therefore keep the same absolute canonical `workspaceCwd`. Their bot session stores stay under their distinct control roots and Pi transcripts use distinct existing `PI_CODING_AGENT_SESSION_DIR` values. Only when `instanceConfigPath` is configured, `src/pi-rpc-protocol.ts` passes the deployment control root as `artifactWorkspaceCwd` so generated context/persona artifacts land in that root's existing `.tmp` runtime directory rather than the shared live context tree; with no overlay it omits that option and preserves `assemblePiContext`'s current `agent.workspaceCwd` default exactly. `WorkspaceValidationResult` continues to carry the resolved contract, while the existing `formatEffectivePaths` in `src/cli.ts` adds the new instance-config/media/echo diagnostics to user-visible `workspace validate` output.

### 2. Minimal authenticated local trigger input

New `src/trigger-input.ts`, shipped in the same product and release, started only when the config declares `triggerInput`:

```yaml
triggerInput:
  port: 9466                 # required; presence of the section enables the input
  host: 127.0.0.1            # optional, loopback only (127.0.0.1 / ::1 / localhost)
  path: /trigger             # optional, default /trigger
  bearerSopsKey: <SOPS_KEY>  # or bearerEnv: <ENV_NAME>; exactly one is required
  chatId: <CHAT_ID>          # must match a configured Telegram binding
  threadId: <THREAD_ID>      # optional
```

Behavior, and nothing more:

- One `node:http` listener on loopback, mirroring the existing metrics-server pattern in `src/metrics.ts:481-525`. `EADDRINUSE` fails startup with a clear stable log line; **do not** extend `STARTUP_CONFLICT_REASONS`.
- One `POST <path>` route. Constant-time bearer comparison (`timingSafeEqual`), `Content-Type: application/json`, body ≤ 16 KiB, absolute read deadline.
- Payload contract: `{"source": "<slug ≤32 ASCII chars, [a-z0-9-]>", "text": "<bounded evidence>"}` with one end-to-end text ceiling of 4096 UTF-16 code units, matching `monitoring_native.TELEGRAM_TEXT_MAX_UTF16_UNITS`. Sources send already-bounded human-readable evidence; the bot does **not** parse Alertmanager schemas.
- The text is framed like existing ordinary context prefixes (`[Automatic trigger | source: <slug> | HH:MM]\n\n<text>`), then handed to the existing `MessageQueue.enqueue` for the binding resolved from `chatId`/`threadId`, using that binding's `agentId` and `sessionKey()`. Ordinary debounce, collect, steering, session ownership, and saturation behavior apply unchanged — there are no trigger-only queue semantics.
- Responses carry a status word only, no identifiers: `202` accepted into the queue, `429` queue saturated or shutting down, `401` bad/absent bearer, `400` malformed, `413` too large, `415` wrong content type, `404` other paths, `405` other methods.
- Startup validation: partial configuration, non-loopback host, a `chatId` that matches no configured binding, absence of a configured Telegram binding, or failure to resolve the Telegram token fails startup before any source can target a nonexistent listener.

Two small supporting changes make this possible without duplicating logic:

- `src/telegram-adapter.ts`: extract `createTelegramApiAdapter({ api, chatId, binding, threadId, sessionDefaults })` implementing `PlatformContext` over `bot.api`, and make the existing `createTelegramAdapter(ctx, …)` delegate to it. Existing behavior and call sites are preserved.
- `src/message-queue.ts`: `enqueue` returns `boolean` (`true` when accepted into pending or collect, `false` when rejected by cap or while not accepting). Existing `void` call sites are unaffected; this is what lets the endpoint answer truthfully so the source can apply its own native semantics.

`src/main.ts` starts the input after `createTelegramBot` returns (it needs `bot.api` and the queue) and stops it in the existing shutdown closure beside `echoWatcher.stop()`.

### 3. Worker removal

Delete the historical product and every worker-only consumer before changing source delivery, so the full validation gate remains green after each task. Remove `src/ops-worker/**`, both worker Pi extensions in `src/pi-extensions/` and `extensions/pi/`, `src/pi-primary-resources.ts`, `src/pi-parity-contract-limits.ts`, worker tests/fixtures (including `fake-ops-conversation.mjs`, `fake-pi-process.mjs`, and `fixtures/primary-skill/**`), active docs/package/CLI routes, and the worker-only `captureResponseStatus` option and branches in `src/pi-extensions/codex-usage.ts`. Do not port parity, realpath, task, custody, or status semantics. `restart-bot.sh --worker` remains untouched because it is the unrelated launchd foreground mode.

The zero-active-reference gate combines import/use analysis with content grep; only `CHANGELOG.md` and historical `docs/plans/**` may retain worker history.

### 4. Sources become triggers, with the narrow control-path notice

Define the source-side contract once in `scripts/monitoring_native.py`: `MINIME_TRIGGER_INPUT_URL`, `MINIME_TRIGGER_INPUT_SOPS_FILE`, `MINIME_TRIGGER_INPUT_SOPS_KEY`, `resolve_trigger_input_bearer`, and the sanitized `CONTROL_PATH_UNAVAILABLE_NOTICE`. Both `scripts/alertmanager_webhook.py` and `scripts/runtime_doctor.py` import those names; Alertmanager also renames `--ops-intake-url` to `--trigger-input-url`.

`scripts/alertmanager_webhook.py`:

- forwards `{"source": "alertmanager", "text": <existing 4096-UTF-16-unit batch message>}` instead of the raw validated v4 body;
- extends current loopback Alertmanager verification to resolved-only batches: firing requires one current exact receiver/group containing every delivered firing member, while resolved requires a successful query for the exact receiver/group showing that none of the delivered resolved member identities remains active. It forwards verified firing and resolved summaries so the ordinary agent observes recovery, acknowledges stale/forged batches without forwarding, and returns `503` for verification exceptions or trigger rejection so Alertmanager retries natively;
- removes all three bridge-mode full/direct incident paths: resolved-only critical native delivery, verification-exception critical native delivery, and the post-forward critical duplicate. Accepted firing or resolved triggers produce no direct message, failures never fall back to the raw/full incident, and Alertmanager emits **zero** D6 notices rather than adding state that cannot meet the at-most-one bound;
- preserves bridge-disabled native-only delivery, bounded process-local batch deduplication, and all Alertmanager-owned retry/grouping behavior for existing single-instance installs.

`scripts/runtime_doctor.py`:

- when all three shared trigger-input environment variables are present, delivers the existing `incident_message(...)` text as `{"source": "runtime-doctor", "text": …}` instead of Telegram; partial settings fail configuration, and trigger-mode delivery failure never falls back to the raw incident;
- extends only the existing versioned transition document with an exact pending transition identity (`fromIncidents` and `toIncidents`), bounded consecutive delivery-failure count, and `noticeSent`. The same pending transition survives restart; a changed transition resets those fields; successful delivery commits `toIncidents` and clears pending metadata. After three failed deliveries of a firing transition it may send `CONTROL_PATH_UNAVAILABLE_NOTICE` once; recovered transitions never produce a notice. If this cannot remain solely inside that existing transition document, implement zero notices instead;
- with no trigger-input settings, keeps today's direct Telegram delivery unchanged for single-instance installs.

No source classifies incidents into new categories, owns a task, or reports a result. #145's required outcome follows structurally: Primary-down evidence now enters the full ordinary agent's queue and session with no trigger-owned pre-step.

## Validation Commands

Each task lists its exact focused command. Run the narrowest command first, then the canonical full package gate below before starting the next task.

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

**Serves:** Issue #132 operator input — "There is one product, one codebase, one release stream, and one canonical source of shared behavior/configuration" and "Deployment identity and writable runtime state may differ where required for safe coexistence and recovery independence" — plus the operator-approved decision "Limit the per-deployment overlay to genuine identity/runtime-isolation values such as process/application root, deployment-owned session/media/echo/runtime state, token/DM binding, ports, labels/namespaces, and metrics identity."

- [x] add `MINIME_MEDIA_ROOT` → `mediaBaseDir` and `ECHO_DIR_BASE` → new `echoDir` resolution to `src/workspace-contract.ts`, preserving the existing `MINIME_TEST_MEDIA_BASE` per-pid test convention and reporting both through `effectivePaths` diagnostics
- [x] add `MINIME_INSTANCE_CONFIG_PATH` → `instanceConfigPath` to the same contract (absent by default)
- [x] derive `MEDIA_BASE` in `src/media-store.ts` from the contract instead of its own constant, and default `EchoWatcher`'s directory from the contract in `src/echo-watcher.ts`
- [x] in `src/config.ts`, load the instance layer after `config.local.yaml`; when it is enabled require every canonical `agents.<id>.workspaceCwd` to be absolute while preserving existing relative resolution when no overlay is configured; allow only the scalar/object paths listed in Technical approach plus `bindingIdentityOverrides.<canonical-label>.chatId`/`.topicId`, require each label key to match exactly one canonical binding, and reject raw `bindings`, every behavioral binding field, overlay `agents.<id>.workspaceCwd`, every other non-allowlisted key path, missing labels, and duplicate canonical labels with errors that name no value
- [x] apply each identity patch without replacing its canonical binding, proving that `agentId`, `kind`, `label`, `requireMention`, `topics`, `voiceTranscriptEcho`, `typingIndicator`, and all unmentioned fields remain canonical
- [x] in `src/pi-rpc-protocol.ts`, keep the canonical `agent.workspaceCwd` as the context source and Pi cwd; only when `instanceConfigPath` is configured pass `resolveWorkspaceContract().paths.controlWorkspaceRoot` to `assemblePiContext` as `artifactWorkspaceCwd`, otherwise omit the option and retain the current artifact location; keep `PI_CODING_AGENT_SESSION_DIR` as the existing per-deployment Pi transcript selector
- [x] extend the existing `formatEffectivePaths` in `src/cli.ts` with the overlay path and both runtime-root diagnostics so `workspace validate` shows the effective per-deployment values
- [x] write tests in `src/__tests__/workspace-contract.test.ts`, `src/__tests__/cli.test.ts`, `src/__tests__/config-merge.test.ts`, and `src/__tests__/config-defaults.test.ts` for path defaults/precedence, CLI effective-path formatting, instance precedence, every allowed leaf, identity-only patch preservation, unique-label failures, rejection of raw/behavioral binding fields, overlay `agents.<id>.workspaceCwd`, model/thinking/session/extension/Discord/unknown overrides without value leakage, two distinct control roots loading the same absolute canonical `workspaceCwd`, rejection of a relative canonical workspace when the overlay is enabled, and unchanged acceptance/resolution of a relative workspace with no overlay
- [x] update `src/__tests__/media-store.test.ts` and `src/__tests__/echo-watcher.test.ts` for the configured roots, including that two configured roots do not observe each other's files
- [x] update `src/__tests__/context-assembler.test.ts`, `src/__tests__/pi-rpc-protocol.test.ts`, and `src/__tests__/interactive-session-binding-integration.test.ts` to prove the no-overlay path still reads and writes artifacts under the canonical agent workspace, while two overlay-enabled deployments use the same absolute canonical live context/Pi cwd and keep generated context artifacts, `PI_CODING_AGENT_SESSION_DIR` transcripts, and control-root bot session-store paths distinct
- [x] run `npm run lint`, then `npm run test:file -- src/__tests__/workspace-contract.test.ts src/__tests__/cli.test.ts src/__tests__/config-merge.test.ts src/__tests__/config-defaults.test.ts src/__tests__/media-store.test.ts src/__tests__/echo-watcher.test.ts src/__tests__/context-assembler.test.ts src/__tests__/pi-rpc-protocol.test.ts src/__tests__/interactive-session-binding-integration.test.ts`, then the canonical full package gate — all must pass before Task 2

### Task 2: Minimal authenticated local trigger input into the ordinary MessageQueue

**Serves:** Issue #132 operator-approved decision D2 — "a minimal authenticated local input inside the same ordinary `minime-bot` process/release may adapt evidence into the existing Ops MessageQueue and persistent session: trigger evidence → existing MessageQueue/session → full ordinary Minime agent", which "owns no persistence, separate queue, task IDs, retry/custody state, lifecycle state, status/result APIs, incident routing, supervision, authorization, reporting semantics, daemon, or separate service."

- [ ] extract `createTelegramApiAdapter({ api, chatId, binding, threadId, sessionDefaults })` in `src/telegram-adapter.ts` and make the existing `createTelegramAdapter(ctx, …)` delegate to it without behavior change
- [ ] change `MessageQueue.enqueue` in `src/message-queue.ts` to return `boolean` (accepted into pending/collect vs. rejected by cap or shutdown), leaving all existing call sites and saturation-notice behavior unchanged
- [ ] add the `triggerInput` section to `src/config.ts` (`port` required, optional `host` restricted to loopback, optional `path` defaulting to `/trigger`, exactly one of `bearerSopsKey`/`bearerEnv` resolved through the existing secret path, `chatId`, optional `threadId`), failing config/startup validation on partial or non-loopback configuration, an unmatched binding, no Telegram binding, or an unresolved Telegram token
- [ ] implement `src/trigger-input.ts`: one loopback listener, one POST route, timing-safe bearer check, 16 KiB body ceiling with an absolute read deadline, source-slug validation, text bounded to exactly 4096 UTF-16 code units, ordinary trigger framing, one `enqueue` call through the API adapter, and the `202/400/401/404/405/413/415/429` status-word-only response contract — with no stored state, identifiers, or additional routes
- [ ] wire start/stop into `src/main.ts` after `createTelegramBot` and inside the existing shutdown closure; fail startup with a stable log line on `EADDRINUSE` without extending `STARTUP_CONFLICT_REASONS`
- [ ] write `src/__tests__/trigger-input.test.ts` covering listener lifecycle, accepted enqueue into the resolved binding/session key, an exactly-4096-UTF-16-unit evidence string, one-unit overflow, rejected bearer, oversized/malformed/wrong-content-type bodies, wrong path/method, saturated/shutdown `429`, disabled-by-default behavior, and absence of files, identifiers, or state
- [ ] update `src/__tests__/message-queue.test.ts`, `src/__tests__/telegram-adapter.test.ts`, `src/__tests__/config-defaults.test.ts`, and `src/__tests__/config-secrets.test.ts` for the return value, API adapter, all trigger config failures, and the fail-closed requirement that enabled trigger input has both a resolved Telegram token and configured binding
- [ ] run `npm run lint`, then `npm run test:file -- src/__tests__/trigger-input.test.ts src/__tests__/message-queue.test.ts src/__tests__/telegram-adapter.test.ts src/__tests__/config-defaults.test.ts src/__tests__/config-secrets.test.ts`, then the canonical full package gate — all must pass before Task 3

### Task 3: Remove the historical worker product and its worker-only attestation machinery

**Serves:** Issue #132 operator-approved decision — "Replace the bespoke worker with an independently deployed ordinary `minime-bot` instance"; scope — "removal/archive of worker-only code, tests, docs, runtime routes, and state references after verified cutover"; and the #143 outcome — "remove worker-only parity/attestation machinery where it caused the resource-topology crash loop. Do not port worker product semantics into ordinary Minime without independent evidence."

- [ ] delete `src/ops-worker/**`, `src/pi-primary-resources.ts`, `src/pi-parity-contract-limits.ts`, `src/pi-extensions/ops-worker-conversation-bounds.ts`, `src/pi-extensions/ops-worker-parity-attestation.ts`, `extensions/pi/ops-worker-conversation-bounds.ts`, and `extensions/pi/ops-worker-parity-attestation.ts`
- [ ] delete `src/__tests__/ops-worker-*.test.ts`, `src/__tests__/fixtures/ops-worker-*.ts`, `src/__tests__/fixtures/fake-pi-process.mjs`, `src/__tests__/fixtures/fake-ops-conversation.mjs`, and `src/__tests__/fixtures/primary-skill/**` after confirming their use graph is worker-only
- [ ] remove the `worker` command scope from `src/cli.ts` — its import, `workerDependencies` option, worker-only flags, help text, `runCli` guard, and `runCliAsync` branch — leaving the async entrypoint behavior correct for every remaining command
- [ ] remove worker entries from `package.json` `files` and `scripts/build-package-artifacts.mjs`, delete `docs/ops-worker.md`, and remove the ops-worker section/links from `README.md` while preserving the unrelated `scripts/restart-bot.sh --worker` / foreground launchd documentation in `README.md` and `docs/launchd-operations.md`
- [ ] remove worker extension documentation from `src/pi-extensions/README.md`; after confirming the deleted parity wrapper is its only consumer, remove `captureResponseStatus` and the associated response-status-only branches/types from `src/pi-extensions/codex-usage.ts` without changing ordinary quota capture
- [ ] update `src/__tests__/package-install.test.ts`, `src/__tests__/cli.test.ts`, `src/__tests__/package-import-safety.test.ts`, and directly affected assertions in `src/__tests__/codex-usage.test.ts` for the removed package files, command scope, imports, and option
- [ ] run import/use analysis with `rg -n '(from|import).*ops-worker|pi-primary-resources|pi-parity-contract-limits|captureResponseStatus' src extensions scripts`, then content audit with `rg -n 'ops-worker|opsWorker|OpsWorker|pi-primary-resources|pi-parity-contract-limits|parity attestation|captureResponseStatus' src extensions scripts package.json README.md docs --glob '!docs/plans/**' --glob '!CHANGELOG.md'`; both commands must return no active hit, and only `CHANGELOG.md` plus historical `docs/plans/**` may retain history
- [ ] run `npm run lint`, then `npm run test:file -- src/__tests__/cli.test.ts src/__tests__/package-install.test.ts src/__tests__/package-import-safety.test.ts src/__tests__/codex-usage.test.ts`, then the canonical full package gate — all must pass before Task 4

### Task 4: Retarget Alertmanager and runtime doctor with the approved D6 values

**Serves:** Issue #132 operator input — "Alertmanager, runtime doctor, cron, and future equivalent sources are only triggers for the same ordinary full agent. They do not own tasks, custody, incident lifecycle, receipts, verifiers, admission/status/result APIs, or reporting policy"; operator-approved decision D6 — "If source-native retries establish that Ops cannot receive a critical trigger, zero or one terse sanitized notice may tell the operator that the reserve engineer/control path was unavailable"; and the #145 outcome — "Primary-down evidence reaches the full trusted agent, which chooses sensible recovery using ordinary tools."

- [ ] define `MINIME_TRIGGER_INPUT_URL`, `MINIME_TRIGGER_INPUT_SOPS_FILE`, `MINIME_TRIGGER_INPUT_SOPS_KEY`, `resolve_trigger_input_bearer`, and sanitized `CONTROL_PATH_UNAVAILABLE_NOTICE` in `scripts/monitoring_native.py`; import them from both sources, rename Alertmanager's CLI option to `--trigger-input-url`, and reject partial/non-loopback settings without echoing values
- [ ] change Alertmanager forwarding to post only `{"source": "alertmanager", "text": <bounded batch message>}` and add a maximum-sized 4096-UTF-16-unit batch case proving the trigger accepts it
- [ ] replace the complete bridge-mode direct-delivery matrix in `scripts/alertmanager_webhook.py`: require a current exact receiver/group containing every delivered firing identity for firing batches and a successful exact receiver/group query with every delivered resolved identity absent for resolved-only batches; forward both bounded summaries; acknowledge stale/forged batches; keep verification/forwarding failures retryable as `503`; remove native delivery on resolved-only critical batches and verification exceptions as well as the post-forward critical duplicate; and emit zero Alertmanager D6 notices while leaving bridge-disabled native-only mode unchanged
- [ ] route `scripts/runtime_doctor.py` through the trigger input when all three shared settings are present; preserve direct Telegram when none are present, reject partial settings, and never send the raw incident as trigger-mode fallback
- [ ] extend only runtime doctor's existing versioned transition document with exact `fromIncidents`/`toIncidents`, bounded consecutive-failure count, and `noticeSent`; preserve the pending transition across restart, reset notice state when the transition changes, commit/clear it on successful delivery, permit one sanitized notice after three failed firing deliveries, and send none for recovered transitions (or select zero notices if this cannot be expressed solely in that document)
- [ ] add optional trigger-input placeholders to `examples/monitoring/ai.minime.alertmanager-webhook.plist` and `examples/monitoring/ai.minime.runtime-doctor.plist`, keeping them Node-free and `plutil`-valid, and update `docs/monitoring.md` for the shared settings, bridge-disabled compatibility, new firing/resolved matrix, Alertmanager's zero-notice choice, and runtime doctor's state-backed zero-or-one boundary
- [ ] update `src/__tests__/monitoring-native.test.ts` for bounded summary-only bodies; maximum-size acceptance; verified firing and resolved forwarding; no direct/raw delivery after acceptance, verification exceptions, or forwarding failures; retryable `503`; stale/forged acknowledgement; unchanged noncritical and bridge-disabled behavior; doctor trigger routing/retry; fail-closed partial settings; unchanged unconfigured Telegram delivery; and state-backed notice at-most-once across process restart, transition change, recovery, and successful convergence without payload/log leakage
- [ ] run `npm run lint`, then `npm run test:file -- src/__tests__/monitoring-native.test.ts`, then `python3 -m unittest discover -s scripts/tests`, then the canonical full package gate — all must pass before Task 5

### Task 5: Second-deployment documentation, changelog, and final cut pass

**Serves:** Issue #132 operator input — "Ops is a second independently deployed full Minime, not a separate product… Its primary purpose is to remain Telegram-accessible while Primary is unavailable" — and the issue's stated end state, "Final state has one product/release/config source and zero active worker-only references."

- [ ] add a README section documenting a second deployment of the same release: canonical `MINIME_CONFIG_PATH` and the same absolute canonical agent `workspaceCwd` required when an instance overlay is enabled; deployment-owned `MINIME_CONTROL_WORKSPACE_ROOT`, `MINIME_INSTANCE_CONFIG_PATH`, `PI_CODING_AGENT_SESSION_DIR`, `MINIME_MEDIA_ROOT`, `ECHO_DIR_BASE`, `LOG_DIR`, `CRON_HEALTH_TEXTFILE_DIR`, and `MINIME_BOT_SLOT`; plus distinct token/identity-only binding patch and metrics port — stating that context is read directly from the canonical workspace, overlay-enabled deployments redirect generated artifacts to their control roots, the no-overlay artifact location remains unchanged, transcripts/artifacts/bot sessions are isolated, the overlay cannot change behavior, and no synchronization step exists or is needed
- [ ] document the trigger input in README and `docs/monitoring.md`: configuration shape, payload/response contract, that it only starts an ordinary MessageQueue/session turn, and that it owns no task, state, lifecycle, status, or reporting surface
- [ ] add one `## Unreleased` entry to `CHANGELOG.md` describing the second ordinary deployment, minimal trigger input, Alertmanager zero-notice/native-retry behavior, runtime doctor's state-backed optional sanitized notice, and worker removal, referencing (#132); leave all released sections untouched
- [ ] update `src/__tests__/project-naming.test.ts` for the changed documentation/`files` expectations and add assertions that the packaged docs describe one canonical configuration source and no worker product
- [ ] verify acceptance end to end in the named suites: two overlay-enabled deployments with distinct control roots read the same absolute canonical live context/Pi cwd while using separate Pi transcripts, generated context/persona artifacts, bot session stores, and media/echo roots; the no-overlay path retains relative-workspace acceptance and its current artifact location; only `chatId`/`topicId` change through a unique canonical binding label; one shared setting change needs no sync; maximum-sized evidence starts an ordinary turn without lifecycle artifacts; every Alertmanager bridge-mode direct/raw path is absent and delivery failure yields zero notices plus native retry; runtime doctor yields zero or one sanitized notice only through its existing transition document; and the package builds/installs with zero active worker-only reference
- [ ] **final cut pass:** re-read the complete diff against the Operator-approved invariants and Drift tripwires above; remove any Ops-specific abstraction, helper, option, constant, or naming that is not required by an invariant; confirm the trigger path added no persistence, identifiers, retry, lifecycle, status/result surface, authorization, or reporting semantics; confirm no restart-before-investigation step exists; confirm no second shared-configuration source or sync step exists
- [ ] **privacy pass:** confirm the diff contains no private paths, identities, tokens, chat IDs, workspace-internal links, or private evidence — all new examples use placeholders, and all new log/response strings are stable sanitized text with no payload echo
- [ ] run `npm run lint`, then `npm run test:file -- src/__tests__/project-naming.test.ts src/__tests__/package-install.test.ts src/__tests__/workspace-contract.test.ts src/__tests__/cli.test.ts src/__tests__/config-merge.test.ts src/__tests__/config-defaults.test.ts src/__tests__/context-assembler.test.ts src/__tests__/pi-rpc-protocol.test.ts src/__tests__/interactive-session-binding-integration.test.ts src/__tests__/trigger-input.test.ts src/__tests__/monitoring-native.test.ts`, then `python3 -m unittest discover -s scripts/tests`, then the canonical full package gate; run `git diff --check` and report changed files, commands, and results

## Post-Completion

*Supervisor-owned stages and manual verification. No checkboxes; nothing here is a Ralphex task.*

**Release and rollout**

- Ship this work in the ordinary `minime-bot` release stream; no separate Ops package, branch, pin, or feature train is created. Controlled staggered rollout may reach Primary before Ops, but steady state converges on the same release.
- Migration rollback is the previously released package version through the existing package-owned release slots; the historical worker exists only as that prior release, and only until replacement validation succeeds.

**Deployment configuration (private, outside this repository)**

- Point the Ops deployment at the canonical shared configuration and the same absolute canonical agent `workspaceCwd` used by Primary; an overlay-enabled deployment must not use a relative canonical workspace. Give it only the identity overlay (token, `chatId`/`topicId` patch keyed by the canonical binding label, metrics port, slot identity, and trigger-input binding/credential reference) plus deployment-owned `MINIME_CONTROL_WORKSPACE_ROOT`, `PI_CODING_AGENT_SESSION_DIR`, media/echo/log/cron-health roots, and ports.
- Do not copy Primary crons into the Ops deployment; Primary crons remain the canonical schedules.
- Update the private launchd plists and monitoring configuration for the renamed trigger-input environment variables, and register the second legitimate monitoring target/expected identity so it is not classified as foreign.
- Add the shared human-readable Telegram journal guidance as an ordinary shared Markdown rule in the canonical rules source; it is deliberately not implemented in the package.

**Cutover and verification**

- Reversible, mutually exclusive handoff of the existing Ops Telegram token: stop the historical worker, then start ordinary Ops, so exactly one poller owns the token.
- Coexistence check: Primary and Ops serve their own DMs and voice concurrently, read the same absolute canonical live context/Pi cwd, keep Pi transcripts/context artifacts/bot sessions/media/echo/runtime state isolated, and cannot prune each other's artifacts.
- Canonical-configuration check: change one shared setting once and confirm both deployments observe it with no duplicate-config synchronization and no behavioral binding override.
- Trigger canaries: one real Alertmanager group and one real runtime-doctor transition each start an ordinary turn in the Ops session, with no task, custody, or status artifact anywhere.
- Journal check: a reportable incident produces an understandable Telegram journal in Ops's own DM covering what happened, the decision, the action, and the verified result, without raw payloads.
- Control-path check: Ops healthy or merely slow produces no direct duplicate; undeliverable Alertmanager triggers remain retryable and produce zero direct notices; a failed firing runtime-doctor transition produces at most one sanitized notice only if its existing transition document records the bound.
- #143 check: the previously crash-looping resource topology starts ordinary Ops normally. #145 check: controlled Primary-down evidence reaches the full agent, which repairs, verifies, and journals without any #132-specific approval prompt.
- Cleanup after success: remove old worker runtime state, routes, and configuration references, then confirm zero active worker references remain.
