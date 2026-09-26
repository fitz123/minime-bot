# Issue #215: complete safe self-restart

## Goal

Complete the existing launchd-backed `restart-bot.sh --plist` path so an unattended current-release restart succeeds only after the replacement process has reached an application-owned serving-ready boundary, and makes one bounded same-release recovery attempt after failed startup. Preserve the already-proven pre-stop config validation, independent restart worker, and bounded graceful drain.

## Current evidence

- Request mode and worker mode both validate config before the healthy incumbent is stopped.
- Request mode schedules a fixed-label launchd worker and returns before that worker stops the bot.
- Runtime shutdown already defaults to 60 seconds and races busy-session completion against that deadline; focused tests prove both natural completion and timeout.
- The worker currently declares success from a different non-empty launchd PID alone. An isolated regression test proves that a replacement PID with no application-readiness evidence is incorrectly accepted.
- A current-release restart does not change the active slot. Package-level recovery must therefore retry the same validated plist/release, not claim that the separate ordinary Ops process is a rollback domain.

## Non-goals

- No new supervisor, generic one-off framework, Ops redesign, release-slot cutover, deployment, rollback to another version, dependency upgrade, or guard bypass.
- No production fault injection, release, deploy, restart, or merge.
- No private workspace paths, configuration, identities, or operational instructions in public code or history.
- No new network health service or requirement that metrics be configured.

## Validation commands

```bash
node --experimental-test-module-mocks --import tsx --test src/__tests__/runtime-readiness.test.ts src/__tests__/restart-bot-supervisor.test.ts src/__tests__/restart-bot.test.ts src/__tests__/session-manager.test.ts
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

## Tasks

### Task 1: Prove application readiness and bounded same-release recovery

**Goal:** Replace PID-only success with a package-owned ready marker tied to the serving process, and recover once from startup failure without adding another supervisor.

**Serves:** The operator requires actual ready-service verification, bounded recovery, and no manual restart or diagnosis for the recoverable startup case.

- [x] Add one owner-written atomic runtime readiness marker containing the current PID; publish it only after Telegram `onStart` or successful Discord startup, and clear it only when owned by the exiting process.
- [x] Make restart worker success require the launchd PID and readiness-marker PID to match; preserve old-PID rejection and bound the readiness wait.
- [x] After bootstrap/readiness failure, cleanly unregister and retry the same already-validated plist exactly once; retain an honest terminal failure if the bounded retry cannot become ready.
- [x] Preserve request-mode independence, fixed helper ownership, validation-before-bootout, teardown safety, and the existing 60-second runtime drain.
- [x] Extend isolated tests for invalid config, PID-without-readiness, readiness success, one-attempt recovery success, exhausted recovery, stale marker, and marker lifecycle; run focused tests.

### Task 2: Document and verify the narrowed contract

**Goal:** Leave a reviewable package contract and complete repository validation without broadening into deployment behavior.

**Serves:** The operator requested all necessary tests and an honest distinction between tested package guarantees and untested live activation.

- [ ] Document that `--plist` is a current-release self-restart, what application readiness means, and that failed startup receives one same-release retry rather than version rollback.
- [ ] Run the full repository validation commands and fix only branch-caused failures.
- [ ] Perform a final scope/privacy cut pass and leave the branch ready for PR/CI/Copilot review.

## Post-completion

Private operational guidance must separately distinguish current-release self-restart from release cutover. Live activation remains outside this plan and requires the normal release/deploy boundary.
