# Plan: Strip known trailing ASR artifacts (#86)

## Goal

Prevent known decoder stock endings from reaching Telegram/Discord agent input while keeping the fix narrow, shared, and easy to extend.

## Evidence

- `src/voice.ts:268-275` executes `whisper-cli` and returns `stdout.trim()` unchanged.
- Telegram (`src/telegram-bot.ts:1006-1016`) and Discord (`src/discord-bot.ts:377-395`) both consume `transcribeAudio`, so the shared voice module is the correct boundary.
- Private reproduction in #63 confirmed that W0, W1-ru, and W2 append the unspoken terminal phrase `Продолжение следует...`.

## Constraints

- Public repository: no private audio, transcripts, identifiers, or paths.
- Suffix-only removal; preserve the same phrase in the middle of legitimate text.
- Initial known artifact only: terminal `Продолжение следует`, case-insensitive, with optional whitespace and common ellipsis/terminal punctuation variants.
- Artifact-only output becomes empty and remains governed by existing `requireTranscript` behavior.
- No model, prompt, VAD, config schema, platform-handler, or generic punctuation changes.

## Validation Commands

```bash
MINIME_TEST_MEDIA_BASE=/tmp/bot-media-test node --experimental-test-module-mocks --import tsx --test src/__tests__/voice.test.ts
npm test
npm run build
npm pack --dry-run
```

### Task 1: Implement and verify shared trailing-artifact removal

- [ ] Add a small pure postprocessor in `src/voice.ts` backed by an ordered list of known anchored suffix patterns.
- [ ] Apply it exactly once to trimmed `whisper-cli` stdout before `transcribeAudio` returns.
- [ ] Add focused unit tests for ASCII/Unicode ellipsis, case/whitespace, no punctuation, artifact-only input, middle-of-text preservation, unrelated text, and surrounding valid text/punctuation.
- [ ] Run focused and full validation; keep the diff limited to the shared voice path and tests.
