# Plan: Fix codex-quota-sampler after Pi 0.79 project trust change

## Goal
Fix issue #11: `codex-quota-sampler` must pass `--approve` to its isolated Pi probe so Pi 0.79 trusts the sampler project settings (`.pi/settings.json` with `transport: "sse"`) and emits `after_provider_response` headers to the quota extension.

Do **not** deploy the package from this task.

## Context
- Runtime failure: sampler cron exits with `probe failed: quota cache was not refreshed`.
- Manual evidence:
  - `pi ... --extension <debug> ...` without `--approve` returns `OK` but no `after_provider_response` callback.
  - same command with `--approve` emits `after_provider_response status=200` and `x-codex-*` header keys.
  - sampler succeeds when `pi` is wrapped as `pi --approve`.
- Relevant source:
  - `src/codex-quota-sampler.ts`
  - `src/__tests__/codex-quota-sampler.test.ts`
- Existing code writes isolated project settings in `ensureSamplerProjectSettings()` and builds Pi args in `buildCodexQuotaSamplerArgs()`.

## Requirements
- Add `--approve` to the Pi probe args produced by `buildCodexQuotaSamplerArgs()`.
- Keep the sampler isolated: no agent workspace cwd, no normal context files, no tools, no skills, no default extension discovery, no session.
- Add/update tests proving `--approve` is present in sampler args.
- Do not add deployment scripts or private workspace changes.
- Do not include private local paths, usernames, chat IDs, or secrets in public repo files/PR text.

## Validation Commands
```bash
npm test -- src/__tests__/codex-quota-sampler.test.ts
npm run build
npm run lint
npm pack --dry-run
```

## Tasks

### Task 1: Patch sampler args
- [x] Update `buildCodexQuotaSamplerArgs()` so the spawned Pi command includes `--approve`.
- [x] Preserve existing args and semantics (`--provider openai-codex`, `--thinking off`, `--no-context-files`, `--no-skills`, `--no-extensions`, explicit quota extension, `--no-session`, `--no-tools`, `-p`).

### Task 2: Tests
- [x] Update `src/__tests__/codex-quota-sampler.test.ts` to assert the built args include `--approve`.
- [x] If there is a dry-run/result assertion that snapshots args, update it too.

### Task 3: Validate and prepare PR
- [ ] Run the focused test.
- [ ] Run build/lint/package dry-run validation.
- [ ] Commit with issue reference `(#11)`.
- [ ] Leave deployment to the operator; do not touch the private workspace package install.
