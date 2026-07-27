# Issue #79 — Bound package release tests and clean stalled descendants

## Goal

Make `npm test`, and therefore package release CI, terminate deterministically with actionable diagnostics when a test runner or descendant stalls. Preserve the successful suite's behavior and keep production runtime code unchanged.

## Context and evidence

- CI attempt 1 from the reported release failed a legacy assertion (`fixerAvailable` mismatch) after 10.6 seconds; it was not a timeout. The rerun passed.
- The separate macOS incident left the legacy `recovery-fixer-session.test.ts` process idle with no child or new output. Surviving evidence does not identify one exact leaked handle.
- PR #139 intentionally removed the entire superseded ADR-086 recovery runtime and both tests named in the original issue. They must not be restored.
- Current `npm test` invokes Node's test runner serially with no global test timeout; current CI has no job timeout.
- Node 22.19 supports `--test-timeout`. `--test-force-exit` is deliberately not the default solution because it can hide leaked resources instead of producing a failure.
- Current successor integration tests still use child processes and servers, so the package-level release gate needs bounded cleanup independent of one retired test file.

## Non-goals

- Do not restore or reimplement the removed ADR-086 supervisor, fixer, protocol, tests, or documentation.
- Do not change production bot/Ops/recovery behavior.
- Do not add a general workflow/orchestration framework, third-party test runner, or new dependency.
- Do not make `--test-force-exit` mask open handles or weaken existing assertions/timeouts.
- Do not include release, PR polling, deployment, restart, issue closure, or private runtime changes in the Ralphex implementation task.

## Validation Commands

```bash
node --test --import tsx src/__tests__/test-runner-watchdog.test.ts
for run in 1 2 3; do node --test --import tsx src/__tests__/test-runner-watchdog.test.ts || exit 1; done
npm test
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
git diff --check
git diff --stat main...HEAD
```

## Tasks

### Task 1: Add one bounded package-test supervisor and wire the release gate
**Serves:** Operator outcome that every later release validation must terminate or fail within a deterministic bound, clean up subprocess/resources, and emit actionable diagnostics without changing production behavior.

- [x] Reproduce the current gap with a synthetic test fixture that leaves a descendant/resource alive, proving the existing direct Node test invocation can outlive completed or stalled test work.
- [x] Add one dependency-free, test-only Node supervisor under `scripts/` that runs the existing Node test command in an owned process group, applies a configurable bounded deadline with a conservative production default, reports the command/stage/elapsed time and child-process evidence on timeout, and performs bounded `SIGTERM` then `SIGKILL` cleanup of the owned group on success, failure, and timeout paths.
- [x] Add a Node per-test timeout suitable for the existing explicit 120–180 second package tests; do not use force-exit to turn leaked handles into success.
- [x] Wire `npm test` through the supervisor without changing the selected tests, serial concurrency, media-test environment, or existing Node flags; add an explicit CI job timeout as an outer non-success safety bound.
- [x] Add focused regression tests that use short injected deadlines to prove timeout diagnostics, nonzero exit, descendant termination, ordinary exit-code propagation, and no leftover fixture process after each case.
- [x] Run the focused regression three times, the full suite twice, build, package dry-run, contract check, CLI/workspace validation, `git diff --check`, and compare the final Ralphex diffstat with `main...HEAD`.

## Post-Completion

The parent supervisor owns the public PR/Copilot/CI cycle, merge, next CalVer release PR/tag, validated private deployment/restart, feature smoke, clean tail audit, issue/Knowledge updates, milestone delivery, and queue-state advance.
