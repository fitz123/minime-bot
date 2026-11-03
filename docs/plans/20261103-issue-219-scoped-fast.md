# Issue 219: scoped Codex Fast

## Plan

1. Upgrade the four coherent Pi pins to 1.5.0. Inspect installed source and prove offline RPC, exact-session resume, extension loading and tool validation before feature work.
2. Reuse only the upstream priority payload helper, with MIT provenance. Add explicit agent/exact-provider/model eligibility and initially-off control-owned preferences, separate from conversation state.
3. Pass trusted agent/thread identity through existing launch paths. Add authenticated Telegram/native commands and package the adapter; cron and ask-target consumers use their own defaults, generic subagents remain ineligible.
4. Validate focused behavior, installed artifacts and build; cut unnecessary changes, commit with noreply metadata, and return evidence to the parent. Parent owns full-suite review and lifecycle.

## Implementation log

The first dependency-install attempt failed registry DNS resolution. Parent restored `npm install --ignore-scripts`; implementation resumed against the installed 1.5.0 packages and lockfile.

**Early checkpoint passed before Fast implementation:** 24 tests across `pi-invocation`, `interactive-session-binding-integration`, `pi-extensions-acknowledged-steer` and `collaboration-extension`. These exercised real installed RPC, older-session resume, exact multi-process history round-trip and deterministic extension commands. A separate isolated SDK check loaded all seven existing wrappers, validated valid/invalid tool arguments and created a session without provider calls.

Inspected installed Pi manifests, extension request-hook dispatch, pi-ai validation and TypeBox aliases. The [official 1.5.0 changelog](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/CHANGELOG.md) agrees that tool validation uses pi-schema. Existing JSON Schema/TypeBox tools still work. Necessary compatibility changes distinguish user/custom before-agent-start events for collaboration outboxes and replace the subagent's mixed StringEnum builder with equivalent TypeBox literals. Loaded-schema tests preserve all three accepted scope values and reject invalid values.

Verified the published `@llblab/pi-codex-usage@0.13.2` tarball from the package cache without lifecycle scripts. Copied only `lib/fast.ts`'s six-line `applyFastToRequest`, with its MIT copyright 2026 narumiruna and llblab. The license ships with artifacts. The upstream shared-model toggle and quota-polling composition are not loaded.

Fast implementation is documented in [scoped Codex Fast](../codex-fast.md). Defaults and actual thread overrides use atomic control-data writes and live request reads. Model, reasoning, auth, history and independent provider tiers remain unchanged. No operator configuration enables Fast in this change.

The initial continuation-fixture adjustment raised its threshold from 1K to 2K and isolated its credential path, preserving exact lifecycle and persistence assertions. CI later exposed that this remained dependent on implicitly discovered host context. The deterministic fixture correction and reproduction are recorded below; runtime compaction settings are unchanged.

Workspace-local packaging fixtures needed explicit isolation: source-path assertions now distinguish installed fixture descendants from source extension paths, and an empty fixture `.pi/agents` bounds existing ancestor discovery. No production discovery behavior was changed; broader discovery work remains separate.

## Changed areas

- `src/codex-fast.ts`, `src/pi-extensions/codex-fast-request.ts`, `extensions/pi/codex-fast.ts`, license and `src/verify-codex-fast.ts`: preferences, payload adapter, native command and bounded offline verification.
- `src/types.ts`, `src/config.ts`, `src/telegram-bot.ts`: exact opt-in validation and authenticated command routing.
- `src/session-manager.ts`, `src/pi-rpc-protocol.ts`, `src/cron-runner.ts`, `extensions/pi/ask-agent/index.ts`: explicit consumer identity and wrapper inventories, preserving kill switches and recursive isolation.
- Pi pins/lockfile/runtime expectations, two necessary extension compatibility changes, artifact build list, focused tests and current runtime documentation.

## Validation

Final validation subprocesses used isolated control/home/agent/log/media directories and workspace-local scratch. The focused command used the following environment (directories pre-created), with `MINIME_CONFIG_PATH`, `MINIME_INSTANCE_CONFIG_PATH` and `MINIME_AGENT_WORKSPACE_ROOT` unset:

```sh
MINIME_CONTROL_WORKSPACE_ROOT="$PWD/.tmp/test-control" \
HOME="$PWD/.tmp/test-home" PI_CODING_AGENT_DIR="$PWD/.tmp/test-agent" \
LOG_DIR="$PWD/.tmp/logs" TMPDIR="$PWD/.tmp/test-tmp" \
MINIME_TEST_MEDIA_BASE="$PWD/.tmp/test-media" \
node --experimental-test-module-mocks --import tsx --test \
  --test-concurrency=1 --test-timeout=240000 \
  src/__tests__/{codex-fast,pi-invocation,interactive-session-binding-integration,pi-rpc-protocol,pi-rpc-spawn-workspaces,session-manager-pi-spawn,cron-runner-pi,ask-agent,ask-agent-config,subagent,telegram-bot,pi-extensions-acknowledged-steer,pi-extensions-compaction-continuation,collaboration-extension,config-defaults,project-naming}.test.ts
```

Result: **731/731 passed**. Includes default/override matrix, warm scope reads, exact identities, non-chat defaults, clean/restart persistence, malformed commands/store data, independent tiers, real loaded request hooks and Telegram/native routing without LLM invocation.

- `node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 --test-timeout=240000 --test-name-pattern='installs the packed package' src/__tests__/package-install.test.ts`: **passed**, using the same isolated environment plus `npm_config_offline=true` and `npm_config_cache="$PWD/.tmp/npm-cache"`. Real npm tarball installation, packed Fast verifier, license, CLI and wrapper/tool checks passed. Required public dependency-cache entries were copied into local scratch; no registry/provider calls were needed.
- `npm pack --dry-run` package test: **passed**; confirms runtime artifacts/license included and workspace files excluded.
- `npm run build` (also run by successful prepack), `npm run typecheck`, `npm run check:schema-guard-contract`, `node dist/cli.js --help`, `git diff --check`: **passed**.
- `TMPDIR="$PWD/.tmp/test-tmp" node dist/verify-codex-fast.js`: **passed**, Pi 1.5.0, **23 request checks / 24 command checks**. Exercises the real Codex request builder with synthetic claims and stops inside onPayload before transport; on/off differs only by priority tier.
- `node dist/cli.js workspace validate --workspace test-fixtures/minimal-workspace`: **passed**, with the fixture's expected missing optional resource warnings.
- `npm run workspace:validate -- --workspace test-fixtures/minimal-workspace`: initially blocked by sandbox EPERM on tsx IPC listen; **subsequently passed in parent canonical validation**.

## Handoff risks and remaining checks

Parent owns external review and lifecycle. The implementation was committed as `93d48f3` and opened as PR #248. The coding executor made no real provider calls or production changes. Parent validation results are recorded below.

Backend-granted priority remains unknown. Independent `service_tier` values are preserved, so adapter-off cannot override independent priority and adapter-on cannot replace an existing tier. Status and docs say this explicitly. A writer crash can leave a stale `data/codex-fast.json.lock`; the next command gives an actionable retry/removal message.

The parent-reported existing undici 6 advisory remains: `npm ls undici` traces 6.29.0 through discord.js/@discordjs/rest and pi-ai/openai 7.19.0; Pi coding-agent itself uses 8.12.3. Only the four direct Pi pins changed; no unrelated dependency sweep was performed.

## Parent validation and review 1 follow-up

Parent reported the full canonical suite at **2,667 passed / 1 skipped / 0 failed**, plus passing canonical workspace validation. Three isolated OAuth smoke requests confirmed off/no-tier and on/priority with the same Astra/high model and reasoning; the returned service tier was not exposed. Request intent remains distinct from backend-granted priority.

Independent Astra and Opus review completed, 2/2 nondegraded, with two findings:

1. Telegram `/fast` captured startup agent configuration while SessionManager and the request hook reload it. The handler now reloads the bound agent from the regular merged-config source with secret resolution disabled. An optional loader uses the existing bot options DI pattern. Authentication and topic routing remain unchanged. Regression edits merged config after bot creation: adding opt-in, changing model plus pin, removing opt-in without mutating preferences, and restoring opt-in.
2. The standalone verifier's lexical entrypoint comparison silently skipped execution through directory symlinks. It now uses the existing `realpathOrResolve` pattern on both paths. A subprocess regression invokes the actual CLI through a `current` directory symlink and asserts its real JSON version/request/command evidence.

Both new regressions failed before the fixes. With the isolated environment above, review follow-up validation passed:

- `node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 --test-timeout=240000 src/__tests__/{telegram-bot,codex-fast}.test.ts`: **301/301 passed**.
- `npm run build` and `npm run typecheck`: **passed**.
- `node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 --test-timeout=240000 dist/__tests__/codex-fast.test.js`: **7/7 passed**, including the compiled CLI invoked through a directory symlink and JSON assertions for Pi 1.5.0, 23 request checks and 24 command checks.
- `git diff --check`: **passed**.

The full canonical suite was not rerun in the sandbox. This follow-up made no provider calls or production changes.


## CI continuation-fixture isolation follow-up

At `c96de32`, Linux CI reported no threshold compaction where the test required exactly one. Inspected installed `resource-loader.js`, `agent-session.js`, compaction accounting and the faux provider: implicit resources change the system transcript; faux usage counts message characters divided by four, and threshold compaction requires usage strictly greater than `contextWindow - reserveTokens`.

An isolated HOME/agent directory alone still inherited ancestor context in the local nested worktree. Making the resource loader explicit while retaining the old stimulus reproduced CI's exact `[]` versus `["threshold"]` failure. The final fixture disables context files, skills, prompts, themes and ambient extensions, loads only the continuation wrapper, fixes the system prompt and disables append-prompt discovery. Its ~1.4K-token input plus a full-budget 1K-token reasoning response crosses the existing 2K fixture threshold; compacted continuation remains below it. No runtime compaction settings changed.

The real installed Pi session now runs four synthetic host variants: minimal, global resources, project resources, and both. Each asserts one threshold event after the reasoning response, one persisted compaction, three faux calls, one settlement, the same final answer, and no persisted/resumed continuation marker. Resource-list assertions prove host context was excluded.

Validation under isolated HOME/agent/control/media/log directories and workspace-local scratch:

- `node --experimental-test-module-mocks --import tsx --test --test-concurrency=1 --test-timeout=240000 src/__tests__/pi-extensions-compaction-continuation.test.ts`: **13/13 passed**, including all four host variants.
- `npm run typecheck` and `git diff --check`: **passed**.

Only this test fixture and implementation log changed. No provider calls, runtime changes, full-suite rerun or production access occurred.
