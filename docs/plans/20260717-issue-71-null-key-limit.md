# Issue #71: Accept Tavily's nullable per-key usage limit

## Goal

Fix the post-deploy sampler regression where Tavily returns `key.limit: null` while the required account plan and PAYGO counters remain valid. Treat the nullable per-key limit as “no key-specific cap” without fabricating a value or weakening account validation. Keep the existing provider, single-key SOPS contract, egress guards, metrics schema, and incident/recovery behavior unchanged.

## Source Evidence

- `parseTavilyUsageResponse` currently passes `key.limit` through the strict numeric `counter`, so `null` becomes `usage_invalid`.
- `isTavilyUsageRecoverable` assumes every key has a numeric limit.
- `validUsageSample` requires the key to contain the same strict quota-counter shape as account counters.
- Metrics and status derive quota limits from `account.plan` and `account.paygo`, not from the key counter.

## Development Approach

Represent a provider-reported nullable key limit by omitting `key.limit` and `key.remaining` while retaining strict numeric `key.usage`. A finite key limit keeps the existing representation. Missing, negative, non-finite, or wrongly typed fields remain invalid. Account plan/PAYGO fields stay mandatory and strictly numeric.

## Tasks

### Task 1: Parse and validate a nullable key limit
- [x] Update the key sample type so `limit` and `remaining` are an optional pair; leave account quota counters unchanged.
- [x] Parse an explicit `null` key limit as an absent optional pair, preserve the existing finite-limit path, and reject missing or malformed values.
- [x] Treat an absent key limit as unconstrained in recoverability while preserving account capacity requirements.
- [x] Update persisted-state validation to accept only a consistent absent pair or valid finite pair.
- [x] Add parser, recoverability, malformed-input, recovery-probe, and legacy/new state round-trip tests.
- [x] Run focused monitor tests and `npm run typecheck` before Task 2.

### Task 2: Prove sampler and metrics behavior
- [x] Add an end-to-end sampler test showing a null-key-limit usage response records a successful sample rather than `usage_invalid`.
- [x] Verify account-based 80%/95% threshold behavior remains unchanged for the nullable-key-limit sample.
- [x] Add metrics coverage proving successful-sample and account plan/PAYGO gauges are populated, including PAYGO limit 1,250.
- [x] Run focused monitor, runtime, metrics, and status tests before Task 3.

### Task 3: Validate scope and package
- [ ] Confirm `git diff --check` passes and the diff is limited to the monitor, relevant tests, and this plan.
- [ ] Run full `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `npm pack --dry-run`.
- [ ] Record concise validation evidence in the plan.

## Post-Completion

Use the normal PR, review, fresh CalVer release, package deploy/restart, and live verification flow. Terminal acceptance requires a fresh successful live sampler sample, account plan/PAYGO gauges with PAYGO limit 1,250, no accumulating `usage_invalid` failures, successful fixed Search/Extract probes, and the full issue terminal checker passing.
