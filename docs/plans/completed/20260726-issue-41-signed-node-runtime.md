# Issue #41: Stable official Node runtime for launchd trees

## Goal

Make the package-owned bot and cron launch wrappers prefer an official nodejs.org Developer-ID-signed Node installation at the stable per-user path `~/.minime/runtime/node`, while preserving a compatible fallback for installations that have not provisioned that runtime. Document a deliberate, signature-verified install/upgrade/rollback procedure. Do not add a custom launcher, custom signing infrastructure, private deployment state, or TCC database access.

## Context

- `scripts/start-bot.sh:9-10,25` currently puts Homebrew first in `PATH` and executes unqualified `node` for `dist/main.js`.
- `scripts/run-cron.sh:10-11,25` has the same resolution path for `dist/cron-runner.js`.
- Current-host verification reconfirmed that Homebrew Node 26.5.0 is ad-hoc signed with a build-specific CDHash and links 21 Homebrew dylibs. The checksum-verified official darwin-arm64 archive is signed as `Identifier=node`, TeamIdentifier `HX7739G8FX`, has a certificate-anchored designated requirement, and links only system libraries.
- The approved design keeps Node + TypeScript runtime architecture intact. Runtime upgrades are deliberate planned maintenance: stage an official archive, verify checksum/signature/team and dependencies, replace the stable directory, restart through the canonical path, and retain a bounded rollback copy.
- GUI TCC consent and post-consent validation are operator-assisted rollout work. Implementation must never read or write the TCC database.

## Validation Commands

```bash
node --experimental-test-module-mocks --import tsx --test src/__tests__/run-cron-wrapper.test.ts
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
git diff --check
```

## Tasks

### Task 1: Prefer the stable official runtime in both launch wrappers

- [x] Update `scripts/start-bot.sh` and `scripts/run-cron.sh` so the default stable runtime bin directory (`$HOME/.minime/runtime/node/bin`) is prepended before the existing package path fallback; allow a narrowly named runtime-root override for isolated tests and non-default installations without hard-coding a user or production path.
- [x] Preserve existing `MINIME_PATH_PREFIX`, inherited-path, environment-scrubbing, working-directory, argument, and `exec node` behavior outside the new precedence rule.
- [x] Extend `src/__tests__/run-cron-wrapper.test.ts` with isolated fixtures proving both wrappers select the stable runtime even when another `node` is available later in `PATH`.
- [x] Add fallback/override coverage proving installations without the stable runtime retain current behavior and no private host path is embedded.
- [x] Run the focused wrapper test command and fix all failures before Task 2.

### Task 2: Document verified install, upgrade, rollback, and consent boundaries

- [x] Add a minimum-sufficient official-Node runtime section to `docs/launchd-operations.md` and link it from the launchd/runtime section of `README.md`.
- [x] Document architecture/version selection, official `SHASUMS256.txt` verification, `codesign -v --strict`, exact `Identifier=node` and TeamIdentifier `HX7739G8FX` checks, and an `otool -L` guard rejecting `/opt/homebrew` dependencies before activation.
- [x] Document owner-only staging, stable-path replacement with one bounded rollback copy, canonical restart, process executable verification, and rollback; keep commands generic and free of private identifiers.
- [x] State explicitly that TCC consent is a one-time manual System Settings/prompt action, direct TCC database writes are forbidden, and OS resets/upstream certificate changes/manual revocation are outside the survival guarantee.
- [x] Re-run the focused wrapper tests and documentation-sensitive package build/pack checks before Task 3.

### Task 3: Verify package acceptance and scope

- [x] Run every command in `Validation Commands` and resolve failures.
- [x] Confirm the packed package contains the changed wrappers and launchd documentation but no runtime archive, generated output, private path, credential, chat/user identifier, or deployment state.
- [x] Confirm the implementation changes no launchd labels/schedules, private deployment wrapper, package manager, TCC database, custom signer, or interactive terminal identity.
- [x] Record concise validation evidence in the final commit/PR handoff and ensure the worktree is clean.

Validation evidence (2026-07-26): the focused wrapper suite passed 21/21 and
the full suite passed 2273/2273 after fixing six fixed-clock assertions that
crossed their one-week fixture boundary. Build, pack dry-run, schema-contract,
CLI help, fixture workspace validation, and `git diff --check` all passed. A
temporary extracted package contained 267 files including both changed wrappers
and `docs/launchd-operations.md`; inventory, private-path/credential, and scope
scans found no prohibited runtime, deployment, identity, signer, schedule, or
TCC-mutation material.

## Technical Details

The wrappers remain the single package-owned resolution point because launchd invokes them through `/bin/bash` and they already normalize `HOME` and `PATH` before replacing the shell with Node. The stable runtime bin directory must precede both the existing `MINIME_PATH_PREFIX` fallback and inherited `PATH`; a missing stable executable naturally falls through to the existing resolution behavior. Tests must use temporary directories and marker executables rather than any production runtime.

## Post-Completion

The persistent full-cycle supervisor, not Ralphex, owns these external stages:

- open/review/merge the implementation PR, release a new CalVer package, and deploy it through the canonical private wrapper;
- provision a checksum- and signature-verified official Node at the stable runtime path, restart, and verify the live daemon plus a controlled package-cron execution resolve that executable with zero Homebrew dylib dependencies;
- request only the exact manual macOS TCC consent action when the new stable identity first reaches that gate;
- after consent, verify required grants, replace the runtime with a different verified official Node version at the same path, restart, and confirm grants remain effective without a new prompt;
- complete clean startup/smoke/log checks, merged-PR/release/tag/issue checks, source-main validation, and the bounded tail audit before advancing to the next authorized issue.
