# Plan: Make long Telegram delivery splitting Unicode-safe

## Goal

Fix GitHub issue #40 so `scripts/deliver.sh` continues splitting messages above Telegram's 4096-character limit while preserving every Unicode character under launchd's locale-free environment.

## Context

- Splitting the long response into two Telegram messages is expected and correct.
- User-visible defect: the first message ended with `си�` and the continuation began with `�темы` instead of preserving `системы`.
- Root cause: `deliver.sh` uses locale-dependent Bash length/substrings. With launchd's C locale, `${#MESSAGE}` and `${MESSAGE:offset:length}` count bytes, so the byte-4096 hard boundary can bisect Cyrillic `с` (`D1 81`). The per-chunk UTF-8 converter turns both invalid halves into `U+FFFD`.
- Confirmed current-code C-locale reproduction: chunk 1 ends `человеком �`; chunk 2 begins `�истемы`.
- The natural-boundary path also mixes `grep -b` byte offsets with Bash substring offsets, which become character positions under a UTF-8 locale.
- Use a single locale-independent Unicode splitter rather than relying on a forced host locale.
- Treat Telegram's limit conservatively as 4096 UTF-16 code units and never split a Unicode code point/surrogate pair.

## Validation Commands

```bash
npm test
npm run build
npm pack --dry-run
```

## Tasks

### Task 1: Add failing delivery regressions

- [x] Add an integration test that runs `deliver.sh` with `LC_ALL=C` and fake Telegram transport.
- [x] Place a Cyrillic character across the old byte-4096 boundary; assert two ordered payloads reconstruct the original text and contain no `U+FFFD`.
- [x] Cover a non-BMP character at a hard boundary so no unpaired surrogate/replacement character is emitted.
- [x] Cover paragraph/newline boundary preference with non-ASCII text and assert every chunk stays within 4096 UTF-16 code units.

### Task 2: Replace mixed-unit Bash splitting

- [ ] Move long-message boundary selection into one locale-independent Unicode-aware splitter available to the packaged script.
- [ ] Preserve the current preference order: paragraph boundary, newline, then hard split.
- [ ] Preserve intentional boundary consumption semantics and extra-newline behavior.
- [ ] Feed complete chunks back to `send_message` without line-based truncation or trailing-newline loss.
- [ ] Preserve the short-message fast path and the delay/order between continuation sends.

### Task 3: Validate and finalize

- [ ] Run focused wrapper/package tests while iterating.
- [ ] Run the full test suite, build, and package dry-run.
- [ ] Confirm the diff is limited to the plan, delivery script, and relevant regression tests/package metadata if required.
