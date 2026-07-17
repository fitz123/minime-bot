# Issue #71: Fix Linux timeout regression

## Overview

Fix the source-verified Ubuntu CI failure in the new bounded Tavily request tests without expanding issue #71 scope. The failed current-head run reports `Promise resolution is still pending but the event loop has already resolved` while awaiting a stalled fetch: `timeoutController()` creates the abort timer and immediately calls `unref()`, so the timer no longer guarantees the bounded request promise can finish when no other referenced handle exists.

The same run also hit the pre-existing recovery-supervisor nondeterminism tracked separately by issue #79. Do not change recovery code or tests in this plan; rerun the exact feature CI after the Tavily fix.

## Development Approach

- Keep the existing one-attempt, abort-signal timeout behavior and Tavily failure classifications.
- Make the smallest correction that guarantees the timeout remains live until the request settles, then cancels cleanly.
- Add a deterministic isolated-process regression so the test does not depend on unrelated suite handles.
- Do not change provider design, quota/incident semantics, egress guards, secrets handling, recovery-supervisor behavior, or unrelated files.

## Implementation Steps

### Task 1: Make bounded Tavily requests complete without ambient event-loop handles
- [x] Correct the timeout lifecycle in `src/tavily-monitor.ts` so stalled usage and recovery-probe fetches abort and resolve even when the timeout is the only event-loop handle.
- [x] Preserve cancellation after every success/failure path, one provider attempt, existing sanitized classifications, and fixed timeout bounds.
- [x] Add or update focused tests in `src/__tests__/tavily-monitor.test.ts`, including an isolated child-process regression that fails under the current unreferenced-timer behavior.
- [x] Run the focused Tavily monitor tests and `npm run typecheck`.

### Task 2: Validate the PR correction
- [x] Run `git diff --check` and verify the new diff remains limited to the timeout fix, its regression test, and this plan. Passed; the correction changes only `src/tavily-monitor.ts`, `src/__tests__/tavily-monitor.test.ts`, and this plan.
- [x] Run `npm test`, `npm run build`, and `npm pack --dry-run`; if only the already-tracked issue #79 recovery-supervisor nondeterminism appears, rerun unchanged once and record that distinction rather than modifying unrelated recovery code. All passed; `npm test` completed 1,945 tests with zero failures, including the recovery-supervisor suite, so no issue #79 rerun was needed.
- [x] Mark this plan complete with concise validation evidence. Build and package validation passed, and the dry-run package contained 223 files.

## Post-Completion

Push the corrected current-head branch, resolve addressed review threads if any, explicitly re-request Copilot, and use the package-owned PR poller for current-head CI/review verification before merge.
