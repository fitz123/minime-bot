# Bounded Plain-Text Voice Glossary Prompt

## Overview

Add the benchmark-selected W3 capability to the existing local voice path without changing its engine, model, language detection, WAV conversion, or process lifecycle. `voice.ts` will optionally read a plain-text recognition glossary selected by `WHISPER_GLOSSARY_PATH`, parse one canonical term per line with `#` comment lines, deduplicate terms, and append one bounded `--prompt` argument to the current `whisper-cli` invocation. When the environment variable is unset, the file is missing, or it contains no usable terms, the unprompted argv must remain byte-for-byte identical.

The public package contains only the generic reader, synthetic tests, and public documentation. Private glossary values, private paths, transcript/audio data, autonomous Memory Consolidation behavior, deployment wiring, benchmark cleanup, and live rollout remain outside this repository and are parent-owned post-completion work.

## Goal

Improve recognition of recurring terminology by exposing the approved optional bounded glossary prompt while preserving the current local transcription path and absent-safe behavior. Success requires deterministic parsing and deduplication, a conservative hard prompt bound compatible with Whisper's approximately 220-token initial-prompt window, synthetic regression coverage, no private data in the repository or logs, and unchanged unprompted argv.

## Non-goals

- No replacement ASR engine, model, persistent server, VAD, forced language, cloud inference, or WAV-pipeline change.
- No wrong-to-right substitution map, glossary management commands, audit/undo subsystem, database, API, watcher, or review queue.
- No private glossary terms, paths, audio, transcripts, sender/chat metadata, deployment state, or agent instructions in the public package.
- No private control-workspace wiring, shared Memory Consolidation changes, live voice test, release/deploy work, or benchmark deletion in this Ralphex run.

## Context

- `src/voice.ts` owns the common `whisper-cli` invocation used by Telegram, Discord, and the dedicated local Ops voice path.
- Existing runtime selection is environment-based: `WHISPER_BIN`, `WHISPER_MODEL`, and `WHISPER_LANGUAGE`.
- `src/__tests__/voice-transcription.test.ts` captures callback-style process argv without invoking real transcription; `src/__tests__/voice.test.ts` covers pure media helpers and local binary defaults.
- `README.md` and `docs/ops-worker.md` document local voice behavior and runtime environment controls.
- Whisper CLI reports that `--prompt` is limited to `max n_text_ctx/2` tokens. The implementation uses a conservative 220-byte UTF-8 payload ceiling and whole-term prefix truncation: byte-level tokenization cannot require more tokens than input bytes, so the package never knowingly exceeds the roughly 220-token window without adding a tokenizer dependency.

## Development Approach

- **Testing approach:** regular implementation with synthetic tests in the same task.
- Complete and validate each task before the next task.
- Keep parser/argv behavior pure and deterministic; do not log file contents or resolved glossary values.
- Maintain backward compatibility for existing callers of `transcribeAudio` and `ingestLocalAudio`.

## Testing Strategy

- Pure parser tests: comment/blank handling, order preservation, NFKC/case-insensitive deduplication, and whole-term bounded truncation.
- Mocked process tests: normal glossary adds exactly one `--prompt`; unset/missing/empty files produce the exact historical argv; unreadable non-missing files fail through the bounded transcription error.
- Existing Telegram, Discord, Ops, voice, and full package suites must remain green.
- Public privacy scans must find no private values or paths.

## Validation Commands

```bash
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node scripts/test-runner-watchdog.mjs -- --experimental-test-module-mocks --import tsx --test --test-concurrency=1 --test-timeout=240000 src/__tests__/voice.test.ts src/__tests__/voice-transcription.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run --json
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
git diff --check
gitleaks git --no-banner --redact --log-opts='main..HEAD' .
```

## Implementation Steps

### Task 1: Add the bounded absent-safe glossary prompt [HIGH]

**Goal:** Read a configured plain-text glossary at transcription time and append one deterministic bounded prompt without changing the historical invocation when no usable glossary exists.

**Serves:** Public issue #63 production decision: current per-message `whisper-cli` plus a bounded optional prompt from a plain-text glossary; missing/empty input must preserve current argv.

- [ ] Add a documented `WHISPER_GLOSSARY_PATH` runtime selector and exported prompt-bound constants/types in `src/voice.ts` without changing existing binary/model/language defaults.
- [ ] Implement a pure glossary parser/builder in `src/voice.ts` that ignores blank and `#` comment lines, preserves first-seen canonical spelling/order, deduplicates NFKC/case-insensitively, joins terms with a stable separator, and includes only the largest whole-term prefix within 220 UTF-8 bytes.
- [ ] Load the glossary for every transcription so later private file edits apply without a bot restart; treat unset, missing, whitespace-only, comment-only, and overlong-first-term inputs as no prompt, while propagating other read failures through the existing bounded transcription error.
- [ ] Append exactly `--prompt <value>` after the historical Whisper arguments only when the builder returns a non-empty prompt; keep current `transcribeAudio` and `ingestLocalAudio` callers/source compatibility.
- [ ] Add synthetic unit and mocked-process tests in `src/__tests__/voice.test.ts` and `src/__tests__/voice-transcription.test.ts` for absent, missing, empty/commented, normal, duplicate, oversized, unreadable, hot-reload, argument-order, and exact unprompted-argv behavior.
- [ ] Run the focused voice/transcription tests and lint; all must pass before Task 2.

### Task 2: Document and verify the public contract [HIGH]

**Goal:** Make the capability operable without exposing private rollout material, and prove the final branch meets the issue's public acceptance boundary.

**Serves:** Public issue #63 requires a short README contract, synthetic-only public evidence, local-only inference, and no private values/paths/audio/transcripts/identities in repository artifacts or logs.

- [ ] Add a concise `README.md` paragraph describing `WHISPER_GLOSSARY_PATH`, one-term-per-line format, `#` comments, deduplication/budget behavior, hot reload, and absent-safe fallback; extend `docs/ops-worker.md` only enough to list the shared optional runtime control.
- [ ] Verify Telegram, Discord, and dedicated Ops voice entry points all reach the common `voice.ts` invocation without platform-specific glossary handling or duplicated parsing.
- [ ] Run the full package test suite, lint, build, dry-pack, schema-contract, CLI-help, and minimal-workspace validation commands; all must pass.
- [ ] Run `git diff --check`, gitleaks, author-scope, and public privacy scans; confirm the diff contains only generic code, synthetic fixtures, and public documentation.

## Technical Details

- Configuration: optional `WHISPER_GLOSSARY_PATH` environment variable, read at transcription time.
- File grammar: UTF-8 text, one trimmed term per line; blank lines and lines whose first non-whitespace character is `#` are ignored.
- Deduplication key: trimmed `NFKC` plus lowercase; the first spelling and order win.
- Prompt serialization: accepted terms joined by `, `.
- Hard bound: 220 UTF-8 bytes, with no split UTF-8 sequence and no partial term; terms after the first non-fitting prefix are not emitted.
- Failure policy: unset/ENOENT/no usable terms/overlong first term omit `--prompt`; other read failures become the existing redacted transcription-stage error.
- Privacy: prompt contents are passed only as a local child-process argument and are never logged, included in metrics, or persisted by package code.
