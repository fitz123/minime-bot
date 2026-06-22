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
- Do not include command environment variables or secrets.
- Preserve current behavior when diagnostics are absent.
- Preserve existing delivery-failure fallback behavior.
- Public repo: avoid private data in issue/commit/PR text.

## Validation Commands
```bash
npm test -- --runTestsByPath src/__tests__/cron-runner.test.ts
npm run build
```

## Tasks

### Task 1: Implement diagnostics in failure notifications
- [ ] In `src/cron-runner.ts`, build a failure notification string that includes diagnostics when present.
- [ ] Bound/truncate diagnostics separately so long stderr cannot bloat notifications.
- [ ] Keep `FAIL diagnostics: ...` local log line unchanged.
- [ ] Ensure fallback `handleDeliveryFailure` message includes the same concise context if delivery fails, without exceeding existing caps.

### Task 2: Add/adjust tests
- [ ] Add a cron-runner unit test for a Pi/LLM cron failure with diagnostics: delivery message includes diagnostics excerpt.
- [ ] Add/adjust a test proving diagnostics absence preserves previous shape.
- [ ] Add/adjust a delivery-failure fallback test if the implementation changes that path.

### Task 3: Validate and prepare PR
- [ ] Run focused cron-runner tests.
- [ ] Run build/typecheck.
- [ ] Update issue #20 with implementation evidence after success.
