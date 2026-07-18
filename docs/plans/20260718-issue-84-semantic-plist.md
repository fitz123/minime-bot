# Treat semantically equal cron plists as unchanged (#84 follow-up)

## Goal

Make launchd cron planning treat valid plist files with identical values as `unchanged` even when macOS plist tooling has reordered dictionary keys or reformatted XML. Preserve malformed/drifted plist repair, explicit runner validation, and dry-run zero-write behavior.

## Verified production root cause

Release v2026.7.16 and the reviewed private `--run-cron-script` wrapper correctly produce the same active recovery runner and the same parsed plist values as loaded jobs. However, `planLaunchdCronSync()` still uses raw string equality. The recovery cutover's plist patch tool rewrites key order/formatting, so every existing job is falsely planned as `update`. The narrow activation gate stopped before writes.

Base: `3ccfc7a`. Public package code/tests/docs only. No private paths, deployment files, runtime state, or identifiers.

## Contract decisions

- Add a side-effect-free semantic equality helper used only when an existing plist file is present.
- Parse both existing plist and desired in-memory content through the already configured `plutil` binary using read-only JSON conversion (`-convert json -o -`), sending desired content on stdin. Compare parsed JavaScript values with deep strict equality so dictionary order and XML formatting do not matter while arrays and scalar types remain significant.
- Do not create temporary files. Dry-run may execute read-only plist parsing but must not write files, create directories, call launchctl, or mutate plist state.
- If either parse command fails, returns malformed JSON, or cannot start, treat the existing plist as drifted (`update`) rather than unchanged; later normal write/lint/rollback behavior remains authoritative.
- Do not emit parser stderr, file contents, or paths through planning output/errors.
- Raw byte identity may remain a fast path before semantic parsing.

## Validation commands

```bash
npm ci
npm test
npm run lint
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
git diff --check origin/main...HEAD
```

## Tasks

### Task 1: Semantic equality in planning

- [x] Add the raw-equal fast path plus read-only semantic plist comparison for differing bytes.
- [x] Use the resolved `context.plutilBin`; parse desired content via stdin and existing content from its file path; compare parsed values with deep strict equality.
- [x] Fail safely to `update` on command/exit/JSON failure without exposing parser output.
- [x] Keep create/delete/write/rebootstrap/rollback behavior unchanged.

### Task 2: Production-shape regressions

- [x] Add a fixture whose existing plist is semantically identical but has PlistBuddy-like reordered top-level and nested dictionary keys/formatting; require `unchanged` with the matching explicit runner.
- [x] Extend the one-new-cron regression so reordered existing plists stay `unchanged` and only the new job is `create`.
- [x] Prove a real scalar/array/runner/schedule difference remains `update`.
- [x] Prove malformed existing plist and parser command failure remain `update` without writes, launchctl calls, or leaked parser/path text.
- [x] Prove dry-run leaves existing plist bytes and the LaunchAgents/log directories unchanged apart from pre-existing fixture content.

### Task 3: Final validation and review

- [x] Document semantic-vs-byte planning behavior and the read-only dry-run parser boundary.
- [x] Run focused launchd/CLI/package-install tests and the complete validation command set.
- [x] Run Ralphex correctness/security and requirement/integration review until a clean iteration; fix every verified critical/major finding with regression coverage.
- [x] Verify the exact public diff contains only package source/tests/docs/completed plan and no private evidence or generated artifacts.
- [x] Leave the branch clean and committed. PR/release/deploy/production dry-run are post-Ralphex steps; issue #84 remains open until the real narrow sync and first-run verification pass.
