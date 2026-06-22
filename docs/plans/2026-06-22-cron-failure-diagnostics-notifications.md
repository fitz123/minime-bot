# Plan: Include cron failure diagnostics in notifications (#20)

## Goal
When a cron fails and `cronErrorDiagnostics(err)` returns useful diagnostics, include a concise bounded diagnostics excerpt in the Telegram failure notification, not only in the local cron log.

## Context
- Issue: https://github.com/fitz123/minime-bot/issues/20
- Current code in `src/cron-runner.ts` logs diagnostics:
  - `FAIL diagnostics: <diagnostics>`
- Current delivered message omits diagnostics:
  - `⚠️ Cron FAIL: <task>\n<Cron task failed...>`
- Recent incident: multiple Pi cron failures delivered only `Pi cron exited with code 1`, while logs contained `stderr: fetch failed`.
- Related but separate issue #3 covers script-mode failures not populating diagnostics at all. Do not conflate scopes.

## Constraints
- Keep notification concise and below Telegram limits.
- Reuse existing sanitization/truncation behavior where possible.
- Public repo: avoid private data in issue/commit/PR text.
- Existing diagnostics can include subprocess stderr/stdout. Current test `keeps subprocess diagnostics out of cron FAIL notifications` intentionally prevents leaking diagnostics to Telegram. This plan deliberately changes that policy for bounded diagnostics only.
- Redaction decision: before adding diagnostics to the notification, apply a small notification-only redaction pass for obvious secret shapes (Bearer tokens, API/key/token/password assignments, URL credentials). Do not claim perfect secret detection; still cap aggressively.
- Notification diagnostics cap: append at most ~300 chars of redacted diagnostics after the existing error line. Keep existing local `FAIL diagnostics: ...` log unchanged and more detailed.
- Preserve current notification shape when diagnostics are absent.
- Preserve existing delivery-failure fallback behavior; build the fallback string at the call site rather than changing `handleDeliveryFailure` signature.

## Validation Commands
```bash
npx tsx --test src/__tests__/cron-runner.test.ts
npm run build
```

## Tasks

### Task 1: Implement diagnostics in failure notifications
- [x] In `src/cron-runner.ts`, build a failure notification string that includes diagnostics when present.
- [x] Add notification-only redaction for obvious token/credential shapes before diagnostics leave the host.
- [x] Cap notification diagnostics at ~300 chars, separately from existing log diagnostics.
- [x] Keep `FAIL diagnostics: ...` local log line unchanged.
- [x] Ensure fallback `handleDeliveryFailure` message includes the same concise context if delivery fails, without changing `handleDeliveryFailure` signature.

### Task 2: Add/adjust tests
- [x] Deliberately update/replace existing test `keeps subprocess diagnostics out of cron FAIL notifications` to reflect the new bounded/redacted diagnostics policy.
- [x] Add or adjust a cron-runner unit test for a Pi/LLM cron failure with diagnostics: delivery message includes diagnostics excerpt.
- [x] Add a test proving notification diagnostics are redacted/capped.
- [x] Add/adjust a test proving diagnostics absence preserves previous shape.
- [x] Add/adjust a delivery-failure fallback test if the implementation changes that path.

### Task 3: Validate and prepare PR
- [x] Run focused cron-runner tests.
- [x] Run build/typecheck.
- [x] Update issue #20 with implementation evidence after success.
