# Plan: Issue #18 approved extra Pi extensions for bot RPC sessions

## Goal

Fix <https://github.com/fitz123/minime-bot/issues/18>: allow an operator-approved list of extra Pi extension entrypoints to be loaded into bot-created Pi RPC sessions, so packages like `pi-dynamic-workflows` can expose tools while the bot still starts Pi with `--no-extensions`.

## Context

Current `src/pi-rpc-protocol.ts` behavior:

- `buildPiSpawnArgs()` always includes `--no-extensions`.
- `resolvePiExtensionArgs()` appends only first-party wrapper extensions: web tools, Knowledge tools, and subagent.
- Global/user Pi packages installed by `pi install npm:...` resolve in normal Pi, but are not loaded into bot RPC children.

Do **not** hardcode private absolute paths or the `pi-dynamic-workflows` package path in the public repo. Public repo must stay generic and PII-free.

## Desired design

Implement a minimal top-level config allowlist for interactive bot RPC sessions:

```yaml
piExtraExtensions:
  - /absolute/path/to/approved/extension.ts
```

Semantics:

- Applies to normal bot-created Pi RPC sessions only.
- Keeps `--no-extensions`; approved extras are passed as explicit repeatable `--extension <abs-path>` args.
- First-party wrappers must still load exactly as before.
- Extra extension paths should be validated as non-empty strings and preferably absolute paths.
- Missing configured extra extension should fail loudly before/at spawn with a clear message.
- `PI_EXTENSIONS_DISABLED=1` remains a kill switch for all explicit extensions (first-party + extras).
- Do not change cron/subagent-child extension inheritance unless necessary; if touched, document why.

Implementation shape can differ if the code has an existing cleaner config mechanism, but keep it small and backwards-compatible.

## Likely files

- `src/types.ts` — add `piExtraExtensions?: string[]` to config/agent shape as needed.
- `src/config.ts` — validate top-level config and propagate to agents/spawn path.
- `src/pi-rpc-protocol.ts` — append extra extension paths without applying the package-dist `.ts` → `.js` remap intended for first-party wrappers.
- `src/__tests__/config-*.test.ts` and/or `src/__tests__/pi-rpc-protocol.test.ts` — cover parsing and spawn args.
- `config.yaml` / docs if appropriate — document the new field without private paths.

## Validation Commands

```bash
npm test -- --runInBand
npm run build
node dist/cli.js config validate --workspace /tmp/nonexistent 2>/dev/null || true
```

Prefer focused tests if the full suite is slow; at minimum run the changed test files and `npm run build`.

## Tasks

### Task 1: Add config plumbing

- [x] Add a generic `piExtraExtensions` allowlist field.
- [x] Validate it rejects non-arrays, empty/non-string entries, and relative paths if absolute-only is chosen.
- [x] Ensure loaded config can reach Pi RPC spawn construction without changing public behavior when unset.

### Task 2: Add spawn-arg support

- [x] Keep `--no-extensions`.
- [x] Append first-party wrappers as today.
- [x] Append configured extra extensions as explicit `--extension` args.
- [x] Do not run the first-party dist `.ts`→`.js` remap on external absolute extension paths.
- [x] Preserve `PI_EXTENSIONS_DISABLED=1` as a full explicit-extension kill switch.

### Task 3: Tests and docs

- [ ] Add/adjust tests for default no-extra behavior.
- [ ] Add tests for one approved absolute `.ts` extension path appearing in spawn args unchanged.
- [ ] Add tests for missing/invalid extra extension errors.
- [ ] Update config comments/docs with the new field and its scope.
