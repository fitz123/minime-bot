# Plan: self-safe restart and packaged cron launchd sync

Status: APPROVED — derived from workspace plan `artifacts/plans/2026-06-17-plan-fixes-for-minime-bot-restart-reliab.md`; architecture-simplified 2026-06-17.

## Scope for this Ralphex run

This run is for the public package repository only: `/Users/ninja/src/minime-bot`.

Implement package/runtime changes only:

- self-safe `scripts/restart-bot.sh --plist` default via launchd one-shot supervisor;
- explicit foreground/worker restart mode with in-bot guard;
- Pi child env marker `MINIME_BOT_PI_SESSION=1`;
- packaged cron launchd sync CLI `minime-bot launchd crons sync`.

Do **not** edit private deployment files in this run:

- `/Users/ninja/.minime/control-workspace/scripts/deploy-bot-package.sh`;
- `/Users/ninja/.minime/workspace/.claude/skills/bot-operations/SKILL.md`;
- private control/workspace README/wiki files.

Those private wrapper/docs updates happen after the package API is implemented and deployed.

## Goal

Fix the 2026-06-17 restart/cron deployment reliability issues at the package level:

1. `restart-bot.sh --plist` must be safe when invoked from inside a live bot/Pi turn. It must schedule an independent launchd one-shot supervisor and return before the bot is stopped.
2. Cron launchd schedule sync must be available from the package CLI so private wrappers can regenerate/prune/rebootstrap cron plists without restarting `ai.minime.telegram-bot`.

## Key architectural decisions

- Use launchd one-shot supervisor, not shell detach, for self-restart reliability.
- `restart-bot.sh --plist` is self-safe by default.
- Foreground/worker restart is explicit debug mode only, guarded by `MINIME_BOT_PI_SESSION=1` unless `MINIME_RESTART_UNSAFE_FOREGROUND=1` is set.
- Use fixed helper label `ai.minime.telegram-bot.restart-supervisor` and `bootout` cleanup before `bootstrap`; no custom lock files in MVP.
- Use bounded not-before delay in worker mode before bot `bootout`; no file marker/handshake in MVP.
- Cron sync prune is default in owned namespace `ai.minime.cron.*`; `--no-prune` is an emergency/manual escape hatch.
- Prune means `bootout` stale/disabled cron label + delete plist + do not bootstrap it again.
- Cron sync must never touch `ai.minime.telegram-bot`.

## Context

Relevant files:

- `scripts/restart-bot.sh` — current foreground restart implementation.
- `scripts/generate-plists.ts` — current source-only cron plist generator.
- `scripts/run-cron.sh` — launchd cron wrapper.
- `src/cron-runner.ts` — loads merged `crons.yaml` + `crons.local.yaml` at each run.
- `src/cron-plist.ts` — cron/plist validation helpers.
- `src/cli.ts` — package CLI dispatch.
- `src/pi-rpc-protocol.ts` — Pi child environment construction.
- `src/__tests__/restart-bot.test.ts` — existing restart script tests; migrate affected `--plist` assertions to explicit foreground/worker mode.
- `src/__tests__/generate-plists.test.ts` — existing generator tests; keep green or migrate to new module.
- `package.json` — package files list; avoid new helper script if possible by keeping helper mode inside `restart-bot.sh`.

Verified behavior from prior research:

- Bot shutdown waits for busy sessions; a self-restart foreground script can be killed mid-`bootout`/`bootstrap`.
- Cron runner reads merged cron definitions at each cron execution, so timeout/prompt changes do not require bot restart.
- `scripts/generate-plists.ts` materializes `StartCalendarInterval` / `StartInterval` but is not shipped in npm package files.

## Validation Commands

```bash
# Targeted tests
node --experimental-test-module-mocks --import tsx --test src/__tests__/restart-bot.test.ts src/__tests__/generate-plists.test.ts
node --experimental-test-module-mocks --import tsx --test src/__tests__/restart-bot-supervisor.test.ts src/__tests__/launchd-cron-sync.test.ts src/__tests__/cli.test.ts

# Full package validation
npm test
npm run build
npm pack --dry-run
node dist/cli.js --help
```

## Tasks

### Task 1: Implement packaged cron launchd sync CLI [HIGH]

**Goal:** Provide a compiled package CLI/API for cron plist generation, pruning, and cron-only launchd rebootstrap.

**Files:**

- Create: `src/launchd-cron-plists.ts`
- Modify: `src/cli.ts`
- Modify: `scripts/generate-plists.ts`
- Create/Modify: `src/__tests__/launchd-cron-sync.test.ts`
- Create/Modify: `src/__tests__/cli.test.ts`
- Modify as needed: `src/__tests__/generate-plists.test.ts`

- [x] Extract plist generation/rendering from `scripts/generate-plists.ts` into `src/launchd-cron-plists.ts`, reusing `src/cron-plist.ts` validation.
- [x] Resolve package paths module-relatively from `import.meta.url`, so generated `ProgramArguments` points to installed `node_modules/minime-bot/scripts/run-cron.sh`.
- [x] Add CLI: `minime-bot launchd crons sync --workspace <path> [--dry-run] [--no-prune] [--launch-agents-dir <path>]`.
- [x] Dispatch `launchd` scope before `src/cli.ts` rejects extra command args.
- [x] Add dedicated parser for launchd options: `--dry-run`, `--no-prune`, `--launch-agents-dir`.
- [x] Dry-run computes create/update/delete/rebootstrap actions only.
- [x] Non-dry-run writes updated plists, prunes stale/disabled owned plists by default, and re-bootstraps affected cron labels.
- [x] For active changed labels: `bootout gui/<uid>/<label>` then `bootstrap gui/<uid> <plist>`.
- [x] For pruned/disabled labels: `bootout gui/<uid>/<label>`, delete plist, and do not bootstrap.
- [x] Ensure cron sync never bootouts/bootstraps/kills/signals `ai.minime.telegram-bot`.
- [x] Add synchronous injectable command runner for launchctl/plutil tests; keep `runCli` synchronous.
- [x] Preserve or update `scripts/generate-plists.ts` as a thin wrapper and keep existing generator tests green.
- [x] Add tests for local schedule override updating `StartCalendarInterval`.
- [x] Add tests for `every N` schedule generating `StartInterval`.
- [x] Add tests for default prune, `--no-prune`, dry-run, active rebootstrap, pruned bootout-without-bootstrap, and bot-label non-interference.
- [x] Add CLI tests for help, option parsing, dry-run output, default prune, `--no-prune`, and test LaunchAgents dir override.
- [x] Run targeted cron/CLI tests.

### Task 2: Make `restart-bot.sh --plist` self-safe by default [HIGH]

**Goal:** Make canonical restart self-safe while preserving explicit foreground worker/debug behavior.

**Files:**

- Modify: `scripts/restart-bot.sh`
- Modify: `src/pi-rpc-protocol.ts`
- Create/Modify: `src/__tests__/restart-bot-supervisor.test.ts`
- Modify: `src/__tests__/restart-bot.test.ts`
- Modify: `package.json` only if a new shipped helper file is introduced; prefer keeping all modes in existing `restart-bot.sh`.

- [x] Add `MINIME_BOT_PI_SESSION=1` to Pi child environment in `src/pi-rpc-protocol.ts`.
- [x] Change `restart-bot.sh --plist` default path to request mode: validate target plist/config enough to fail early, generate one-shot supervisor plist, bootstrap helper, print scheduled/status info, and return without booting out the bot.
- [x] Add explicit foreground/worker mode, e.g. `--foreground --plist` or `--worker --plist`, that runs the existing bootout/wait/bootstrap/wait-PID sequence.
- [x] Foreground/worker mode refuses when `MINIME_BOT_PI_SESSION=1` unless `MINIME_RESTART_UNSAFE_FOREGROUND=1` is set.
- [x] Use fixed helper label `ai.minime.telegram-bot.restart-supervisor`.
- [x] Before bootstrapping a new supervisor, best-effort `launchctl bootout gui/<uid>/ai.minime.telegram-bot.restart-supervisor` to clean up completed/stale helper registrations.
- [x] Generated supervisor plist must serialize required context explicitly via ProgramArguments and/or EnvironmentVariables: `BOT_PLIST`, `MINIME_CONTROL_WORKSPACE_ROOT`, `HOME`, `PATH`, `BOT_LABEL`, `BOT_UID` or domain, request id, status path, log path, and worker args.
- [x] `plutil -lint` generated supervisor plist before bootstrap.
- [x] Worker mode waits a bounded not-before delay before bot `bootout`; request mode must not wait for worker completion.
- [x] Worker mode preserves validation-before-bootout invariant.
- [x] Worker mode writes minimal status/log: request id, old PID if observed, new PID, mode, startedAt, finishedAt, success/failure.
- [x] Do not add custom lock files/stale-lock recovery in MVP; rely on fixed helper label + bootout cleanup.
- [x] Migrate existing `restart-bot.test.ts` assertions that expect inline `--plist` behavior to explicit foreground/worker mode.
- [x] Add tests for request scheduling, generated supervisor plist fields, plutil validation, fixed helper cleanup, two consecutive requests, bounded delay, foreground guard marker/override, worker validation failure, bootstrap failure, and success path.
- [x] Run targeted restart tests.

### Task 3: Document package-level ADRs and usage [HIGH]

**Goal:** Capture architectural decisions in the public package docs so future changes preserve the simple design.

**Files:**

- Modify: `README.md` or create appropriate docs under `docs/`
- Create ADR-style docs if the repo has an ADR convention; otherwise add concise docs in `docs/`.

- [x] Document self-restart via launchd one-shot supervisor and why shell detach is not used.
- [x] Document self-safe `restart-bot.sh --plist` default and explicit guarded foreground mode.
- [x] Document cron deploy separated from bot restart: timeout/prompt config vs schedule plist sync.
- [x] Document package-owned cron sync/prune contract for `ai.minime.cron.*` namespace.
- [x] Document fixed helper label cleanup and why custom lock files are deferred out of MVP.
- [x] Add examples for `minime-bot launchd crons sync --dry-run`, `--no-prune`, and self-safe restart.

### Task 4: Verify acceptance criteria [HIGH]

**Goal:** Prove public package changes meet the reliability goals and are ready for private wrapper integration.

**Files:** none expected unless failures require fixes.

- [x] Run targeted cron sync and CLI tests.
- [x] Run targeted restart tests.
- [x] Run `npm test`.
- [x] Run `npm run build`.
- [x] Run `npm pack --dry-run` and confirm required runtime scripts/files are included.
- [x] Run `node dist/cli.js --help` and confirm launchd command appears.
- [x] Confirm no private config/secret files were read or committed.
- [x] Leave private control wrapper integration for a separate follow-up after this package branch is reviewed/merged/deployed.
