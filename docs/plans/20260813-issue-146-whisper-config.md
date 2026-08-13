# Issue 146: Config-owned Whisper model selection with non-fatal voice degradation

## Goal

Make Whisper model selection a first-class setting in the canonical shared bot config so every ordinary Minime deployment resolves the same model, change the package default from `medium` to the benchmark-selected `large-v3-turbo` path, and remove environment-based model selection so the legacy private-plist `WHISPER_MODEL` carry-over becomes inert. A missing or unreadable model must never prevent bot startup or affect non-voice behavior: only voice transcription degrades, the affected voice request gets a clear bounded reply, failure logs carry bounded effective binary/model paths plus useful child-process stderr, and pre-deploy workspace validation surfaces a prominent non-fatal voice-readiness warning while still exiting successfully and never downloading or replacing model artifacts.

## Non-goals

- No per-instance model override: the instance overlay must keep rejecting the setting; do not add it to `INSTANCE_SCALAR_PATHS`.
- No hidden `medium` fallback and no fallback chain of any kind; absent config means the single package default.
- No generic readiness framework, health service, model registry, download manager, or automatic recovery/provisioning machinery. Validation and deploy never fetch or replace a model.
- No startup gate, startup probe retry loop, or restart behavior tied to model availability.
- No changes to `WHISPER_BIN`, `WHISPER_LANGUAGE`, `WHISPER_GLOSSARY_PATH`, the ffmpeg pipeline, media download/retry behavior, or user-facing bounded reply texts.
- No private deploy-script, private plist, release, deploy, or production-config edits in this repository; that rollout is parent-owned Post-Completion work.

## Context

- `src/voice.ts:13` defines `WHISPER_MODEL = process.env.WHISPER_MODEL ?? join(homedir(), ".minime/models/ggml-medium.bin")` — an env-based module constant with the stale `medium` default; `transcribeAudio` (`src/voice.ts:361`) consumes it directly via `-m`. This is the silent-fallback path from the 2026-07-26 incident: a fresh host lost the plist env value and transcribed on `medium`, then hard-failed opaquely when that file was removed.
- Voice call sites: `src/telegram-bot.ts:924` (`ingestLocalAudio(url, { maxBytes: config.sessionDefaults.maxMediaBytes })`) and `src/discord-bot.ts:416` (`transcribeAudio(tempPath)`). Both have the loaded `BotConfig` in scope. Both failure handlers (`src/telegram-bot.ts:946`, `src/discord-bot.ts:427`) log only `Voice media pipeline failed stage=...` — `MediaPipelineError` retains `cause` (`src/voice.ts:45-53`) but nothing surfaces it, matching the incident's opaque log.
- Config layering: `loadRawMergedConfig` (`src/config.ts:308`) merges canonical `config.yaml`, `config.local.yaml`, then a validated instance overlay. `validateInstanceOverlay` (`src/config.ts:137`) rejects every top-level key not explicitly allowlisted (`INSTANCE_SCALAR_PATHS`, `src/config.ts:127`) with `Instance config override is not allowed at <path>`, so a new canonical-only key is overlay-proof by construction. `BotConfig` lives at `src/types.ts:160`; `loadConfig` (`src/config.ts:913`) already validates flat optional scalars (`metricsPort`, `adminChatId`) and imports a package default from another module (`DEFAULT_MAX_MEDIA_BYTES` from `media-store.js`) — the same pattern fits here.
- Pre-deploy validation: `validateWorkspaceContract` (`src/workspace-validator.ts:208`) loads config with `resolveSecrets: false` and accumulates `error`/`warning` issues; `runWorkspaceValidate` (`src/cli.ts:806-814`) prints warnings but fails only on errors, so a warning-severity voice-readiness finding is prominent yet non-blocking by existing design. `cli.test.ts:1331` already distinguishes hard failures from warnings.
- Tests mock `execFile` via module mocks and assert exact whisper args (`src/__tests__/voice-transcription.test.ts`, `src/__tests__/voice.test.ts:631`); overlay-rejection patterns exist in `src/__tests__/config-merge.test.ts:439`; config scalar validation patterns in `src/__tests__/config-defaults.test.ts`.
- `WHISPER_MODEL` appears nowhere else in the package: not in `README.md` (only `WHISPER_GLOSSARY_PATH` at line 676), not in `telegram-bot.plist.example`, not in `scripts/`. The plist carry-over lives in private deployment tooling outside this repository, so making the package stop reading the env var is the complete public-side change.
- `CHANGELOG.md` keeps an `## Unreleased` section with one issue-referenced entry per change.

## Technical approach

1. **Config-owned selection.** Add optional top-level `whisperModel` (string) to canonical config. Validation in `loadConfig`: non-empty string, expand a leading `~/` to the home directory, require an absolute result; no filesystem access, so config load and bot startup never depend on the file existing. Resolve into a new always-present `BotConfig.whisperModelPath`, defaulting to `DEFAULT_WHISPER_MODEL_PATH = join(homedir(), ".minime/models/ggml-large-v3-turbo.bin")` exported from `voice.ts` (same `~/.minime/models/ggml-<name>.bin` convention as the current default). Remove the `WHISPER_MODEL` env read and export entirely; `transcribeAudio` and `ingestLocalAudio` take a required `modelPath`, passed from `config.whisperModelPath` at both call sites. The overlay validator's default-deny already rejects `whisperModel`; prove it with a regression instead of adding mechanism.
2. **Bounded diagnostics, degraded-only failure.** Add one small exported helper in `voice.ts` that formats a single-line bounded detail from a media-pipeline error: effective whisper binary and model paths (ffmpeg binary for the conversion stage), the child error `code`/exit information, and a length-capped, newline-collapsed stderr excerpt from the `execFile` cause. Append it to the existing `Voice media pipeline failed stage=...` log lines in both bots. User-facing bounded replies (`mediaPipelineFailureMessage`) stay unchanged; no environment contents or secrets ever enter the log line.
3. **Non-fatal readiness warning.** In `validateWorkspaceContract`, after successful config parse, check that `config.whisperModelPath` is an existing readable regular file; otherwise push a **warning** stating the effective path, that only voice transcription is degraded (startup, deploy, and non-voice behavior unaffected), and that validation does not download or provision models — the acting agent decides. Warning severity keeps `workspace validate` exiting 0 through the existing error-only failure gate.
4. **Docs.** Document `whisperModel`, its default, the no-override overlay rule, and degradation semantics in `README.md` near the existing voice-transcription section; add the `CHANGELOG.md` Unreleased entry for #146.

## Validation Commands

Focused (during tasks): `npm run test:file -- src/__tests__/<file>.test.ts`, `npm run typecheck`.

Full suite (required before completion, from package root per `AGENTS.md`):

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```

The fixture run will now print the voice-readiness warning (no model file in the fixture) and must still exit 0.

## Tasks

### Task 1: Config-owned Whisper model setting with large-v3-turbo default

**Serves:** operator inputs 1, 2, 7, 8.

- [x] in `src/voice.ts`, replace the `WHISPER_MODEL` env constant with exported `DEFAULT_WHISPER_MODEL_PATH` (`~/.minime/models/ggml-large-v3-turbo.bin`); remove all `process.env.WHISPER_MODEL` reads; change `transcribeAudio` and `LocalAudioIngestionOptions`/`ingestLocalAudio` to take a required `modelPath`
- [x] in `src/config.ts` + `src/types.ts`, validate optional top-level `whisperModel` (non-empty string, `~/` expansion, absolute path, no filesystem access) and resolve `BotConfig.whisperModelPath` with the package default when absent; extend the `RawConfig` shape
- [x] pass `config.whisperModelPath` at both call sites: `src/telegram-bot.ts` voice handler (`ingestLocalAudio` options) and `src/discord-bot.ts` audio-attachment handler (`transcribeAudio`)
- [x] write tests in `src/__tests__/config-defaults.test.ts`: absent setting resolves the large-v3-turbo default; `~/` expansion; rejection of empty/non-string/relative values; `process.env.WHISPER_MODEL` has no effect on the resolved path
- [x] write tests in `src/__tests__/config-merge.test.ts`: an instance overlay containing `whisperModel` is rejected with `Instance config override is not allowed at whisperModel`; a Primary-like canonical-only load and an ordinary canonical+overlay load resolve the identical `whisperModelPath`
- [x] update `src/__tests__/voice.test.ts` / `src/__tests__/voice-transcription.test.ts` for the new signatures and assert the whisper invocation receives `-m <modelPath>` exactly as passed
- [x] run focused tests and `npm run typecheck` — must pass before next task

### Task 2: Degraded-only runtime failure with bounded child-process diagnostics

**Serves:** operator inputs 3, 4, 8.

- [x] add a bounded failure-detail helper in `src/voice.ts` that renders effective binary and model paths for the failing stage, the child error/exit code, and a length-capped single-line stderr excerpt from the retained `cause`, never environment contents or secrets
- [x] append the helper output to the `Voice media pipeline failed stage=...` log lines in `src/telegram-bot.ts` and `src/discord-bot.ts`
- [x] write tests for the helper: whisper child failure with stderr (missing/unreadable model) includes both paths and the capped excerpt; missing-binary `ENOENT` case; over-long stderr is truncated to the cap; non-exec causes degrade gracefully
- [x] write regression tests proving startup independence and voice-only degradation: `loadConfig` succeeds when `whisperModelPath` points at a nonexistent file (no filesystem probe), and a transcription failure still produces the existing bounded user-facing reply plus the enriched log while the pipeline error stays contained to the voice request
- [x] run focused tests and `npm run typecheck` — must pass before next task

### Task 3: Non-fatal voice-readiness warning in workspace validation

**Serves:** operator inputs 5, 6.

- [ ] in `src/workspace-validator.ts`, after successful config load, emit a **warning** when `config.whisperModelPath` is not an existing readable regular file: include the effective path, state that only voice transcription is degraded while startup/deploy/non-voice behavior are unaffected, and state that validation does not download or replace models
- [ ] confirm no code path escalates the warning to an error and that `runWorkspaceValidate` in `src/cli.ts` needs no change to keep exiting 0 with the warning present
- [ ] write tests in `src/__tests__/cli.test.ts`: missing model produces the warning with the effective path and `Workspace valid.` plus success exit; a readable model file produces no warning; the warning coexists with other warnings without becoming a hard failure
- [ ] run `npm run workspace:validate -- --workspace test-fixtures/minimal-workspace` and assert warning-with-success behavior; run focused tests — must pass before next task

### Task 4: Documentation, cut pass, private-data scan, full validation

**Serves:** operator input 9 (and closes out 1–8 with docs and full-suite proof).

- [ ] document `whisperModel` in `README.md` near the voice-transcription/glossary section: canonical-config ownership, `large-v3-turbo` default when absent, no instance override, no env selection, degraded-only failure semantics, and the non-fatal validation warning
- [ ] add a `CHANGELOG.md` Unreleased entry referencing #146
- [ ] cut pass over the full diff: remove any abstraction beyond the single setting, helper, and warning (no readiness framework, registry, download, or recovery machinery); verify every change traces to a task above
- [ ] scan the diff for private data: no private identities, chat IDs, tokens, hostnames, private paths, or production values in code, tests, fixtures, or docs
- [ ] run the complete public validation set: `npm ci`, `npm test`, `npm run build`, `npm pack --dry-run`, `npm run check:schema-guard-contract`, `node dist/cli.js --help`, `npm run workspace:validate -- --workspace test-fixtures/minimal-workspace` — all must pass

## Post-Completion

Parent-supervisor-owned lifecycle work outside this repository; informational, no checkboxes:

- PR review/merge, package release, and version follow-through for the changes above.
- Private control-config rollout: set or intentionally omit `whisperModel` in the canonical shared configuration so Primary and every ordinary instance resolve the selected `large-v3-turbo` model.
- Remove the `WHISPER_MODEL` carry-over from the private deployment tooling that currently preserves it from an existing plist; after this package change the carried value is inert, and the private cleanup completes config ownership.
- Model provisioning decision on affected hosts: the acting agent either provisions/restores the `large-v3-turbo` model file before activation or knowingly proceeds with voice temporarily degraded; nothing in validation or deploy does this automatically.
- Deploy/restart affected ordinary instances via the canonical restart path, then verify in production that Primary and an ordinary instance transcribe on the same effective model, that a voice message during a deliberately missing-model window returns the bounded reply with the enriched log line, and that pre-deploy validation shows the voice-readiness warning while exiting successfully.
- Close issue #146 with verification evidence; continue with the private follow-up issue per the operator's execution authorization.
