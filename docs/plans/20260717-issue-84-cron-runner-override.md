# Preserve explicit cron runner during launchd sync (#84)

## Goal

Add a narrow, deployment-owned `--run-cron-script <absolute-path>` override to launchd cron generation/sync so a recovery deployment can preserve its atomic active-slot runner during cron-only dry-run and apply. Keep package-root runner behavior unchanged when the option is absent. Fail closed on unsafe overrides before any filesystem or launchctl mutation.

## Verified root cause

At base `cfbde559`:

- `src/launchd-cron-plists.ts` renders `context.runCronScript`, but `resolveLaunchdCronContext()` always derives it from `packageRoot/scripts/run-cron.sh`.
- `src/cli.ts` does not parse or forward a runner option.
- Therefore a cron-only sync cannot reproduce a deployment-owned active-slot plist and plans broad runner-only updates.

Public scope is package code/tests/docs only. Private deployment-wrapper wiring is a separate reviewed control-repository PR after this contract exists. Do not add deployment-specific paths, private values, or runtime artifacts.

## Contract decisions

- CLI/API name: `--run-cron-script`; support both split and `=` CLI forms. API option: `runCronScript?: string` on generation/planning/sync options.
- The default remains the normalized package-root `scripts/run-cron.sh` path and retains current compatibility.
- An explicit value must be a normalized absolute path whose basename is `run-cron.sh`; it must resolve to an existing regular executable file.
- Preserve the caller's validated lexical path in rendered plists so an atomic `current` symlink remains stable across slot switches; use canonical paths only for validation.
- Symlink policy: allow at most one operator-owned directory symlink component (the atomic slot selector), never a final-file symlink. Its resolved target must remain beneath the symlink's parent trust directory. The trust directory, symlink, resolved directories, and file must be owned by the current user and not group/world writable. Reject escaping, dangling, multi-symlink, wrong-owner, or writable components. Regular non-symlink fixtures are allowed when their containing directory and file meet the same owner/mode rules.
- Validate the explicit override while resolving context, before cron loading, directory creation, plist writes, pruning, or launchctl/plutil commands. Dry-run remains zero-write/zero-command.
- Use the validated value consistently in rendering, plan comparison, writes, rollback, and rebootstrap because those phases consume the same generated context.
- Error messages identify the failed invariant but do not echo the supplied path.

## Validation commands

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
git diff --check origin/main...HEAD
```

## Tasks

### Task 1: Add the safe API override

- [ ] Extend launchd generation/sync options with `runCronScript?: string` and resolve it through a dedicated validation helper.
- [ ] Implement the absolute/normalized/name/executable/ownership/mode/symlink-containment policy above without changing default package-root behavior.
- [ ] Keep the validated lexical path in `LaunchdCronContext.runCronScript` and fail before mutation/commands.
- [ ] Add focused tests proving default behavior, explicit regular runner behavior, accepted atomic `current` directory symlink, and rejection of relative, missing, non-executable, wrong-name, final-symlink, escaping, multiple-symlink, and writable-component inputs.

### Task 2: Wire CLI, planning, and narrow-sync regressions

- [ ] Parse `--run-cron-script <path>` and `--run-cron-script=<path>`, reject missing/duplicate/unknown forms, and forward it to `syncLaunchdCrons()`.
- [ ] Update help text and CLI tests without private or deployment-specific paths.
- [ ] Add regressions proving a matching existing plist is `unchanged`, and that adding one cron with a matching override plans only one `create` while all existing jobs remain `unchanged`.
- [ ] Prove invalid overrides fail before filesystem writes or command execution and dry-run with an override remains zero-write/zero-command.

### Task 3: Documentation and final validation

- [ ] Document the option and generic atomic release-slot use case in `README.md` and `docs/launchd-operations.md`; state that ordinary installations omit it.
- [ ] Run focused launchd/CLI/package-install tests, then the complete validation command set.
- [ ] Run Ralphex correctness/security and requirement/integration review to a clean result; fix every verified critical/major finding with regression coverage.
- [ ] Verify the final public diff contains no private paths, identifiers, secrets, control-workspace files, generated output, or unrelated refactors.
- [ ] Leave the branch clean and committed; PR/release/private wrapper/activation are post-Ralphex full-cycle steps.
