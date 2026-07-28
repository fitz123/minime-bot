# Issue #128 — Managed Knowledge archive and bounded active-context maintenance

## Goal

Add one package-owned, reversible Knowledge v2 archive path that preserves page bytes, removes archived pages from the active index/default search corpus, keeps index/log/filesystem state coherent under failure, and supports both an operator-reviewed one-time cleanup and deterministic weekly 40 KiB → 30 KiB maintenance for safe dated records.

## Non-goals

- No permanent deletion, content rewriting/summarization, archive search/browsing UI, RAG/vector/FTS work, or generic garbage collector.
- No arbitrary-topic retention policy, semantic/LLM disposal classifier, emergency pressure tiers, policy engine, dashboard, or database.
- No private cron configuration, production workspace content, repository identities, or deployment values in the public package branch.
- No unrelated bot, session, cron-runner, monitoring, or Ops behavior changes.

## Context

- `src/knowledge/update.ts` currently admits only `create|update|upsert`, requires write payload fields for every call, writes page/index/log under one workspace lock, verifies one active target link, and logs only creates.
- The Pi schema and CLI mirror that write-only contract. Default Knowledge search already excludes `artifacts/**`, so an archive under `artifacts/knowledge-archive/<original-relpath>` needs no search-backend replacement.
- ADR-077 requires Markdown source of truth, the managed `knowledge_update` consistency boundary, atomic index refresh, search refresh, and rollback on drift. ADR-081 retains only this narrow Knowledge guard. ADR-083 rules out an unmeasured backend rewrite.
- The exact periodic policy is weekly, a 40 KiB high watermark, a 30 KiB low watermark, and a 30-day minimum age. Below/equal high watermark must be a quiet mutation-free fast path.
- Direct Fable planning was attempted once and failed with an expired OAuth token. This source-reviewed fallback plan preserves the approved scope and one-run budget.

## Decisions

1. **Managed operations and paths.** Extend the shared operation contract with `archive` and `restore`. Create/update/upsert keep their existing type/frontmatter/body contract. Archive and restore use an original managed `wiki/pages/<type>/**/*.md` `path` only and reject unrelated payload fields. Archive maps that path mechanically to `artifacts/knowledge-archive/<original-relpath>`; restore uses the same original path to find the archived source. Reject traversal, symlinks, missing source, occupied destination, and duplicate active/archive copies rather than overwrite.
2. **Byte preservation and transaction boundary.** Archive/restore move the exact serialized page bytes; they never parse and reformat page content. Use the existing per-workspace lock, safe-path checks, same-directory staging/rename/rollback conventions, and one transaction plan for source/destination movement plus regenerated index and structural log. Verify complete active-index set equality (not only one target count), target absence/presence, archive/source byte identity, and then refresh derived search. Any failed move, write, verification, or refresh restores the pre-call state best-effort and returns a bounded failure.
3. **Audit contract.** Record every successful modifying action as `create`, `update`, `archive`, or `restore`; an upsert logs `create` or `update` according to its result. Log only committed operations and retain the original page path plus archive path where relevant. Keep response fields explicit enough for CLI/tool callers to verify both locations.
4. **Deterministic maintenance without semantic guessing.** Put policy/evaluation in a dedicated Knowledge maintenance module. The engine measures raw `wiki/index.md` bytes first. It does no candidate/network work at or below 40 KiB. Above the watermark, it accepts/verifies bounded completion evidence for closed issue numbers (supplied by the caller after the fast path) and scans only dated `issue-*`/`release-*` project records. A release filename is completed; an issue filename is eligible only when its number is in the supplied closed set. Use page `mtime` as the conservative age clock so any recent modification resets the 30-day wait. A page with `revisit_if` is mixed/current and is skipped fail-safe; nonmatching/open/unproven pages are skipped. Sort eligible candidates by `mtime`, then path, and invoke the same managed archive operation one at a time until index bytes are at/below 30 KiB or candidates are exhausted.
5. **One-time versus periodic cleanup.** The fixed maintenance command never weakens 40 KiB/30 KiB/30-day policy. The parent-owned one-time production review may archive explicitly selected completed dated pages directly through installed `knowledge update --op archive`; this supports the original cleanup without adding a force/bypass mode to weekly policy. The CLI maintenance command supports explicit JSON output/report for controlled runs, while a default below-threshold cron invocation emits no stdout and performs no writes.
6. **Bounded manifest.** Above the high watermark, or when explicitly requesting JSON/report evidence, return a fixed-schema manifest with policy version, bytes before/after, archived count, bounded archived paths, skipped counts by closed reason, bounded errors, stop reason, and mutation status. No body text or unbounded diagnostics enter it. Continue fail-safe after a per-page rejection only where state verification remains sound; otherwise stop and report the error.

## Validation Commands

```bash
npm test -- --test-name-pattern "knowledge (update|archive|maintenance)|knowledge CLI|Knowledge Pi extension|package install"
npm test
npm run lint
npm run build
npm run schema:validate
npm run test:cli
npm pack --dry-run
```

### Task 1: Build the reversible managed archive/restore transaction

**Goal:** Extend the shared Knowledge update core so an active page can move byte-for-byte out of and back into the managed corpus with coherent index, search refresh, structural log, and rollback behavior.

**Serves:** Reversible preservation, active-index/default-search removal, complete update/archive logging, and the existing ADR-077/081 managed consistency boundary.

- [ ] Split write-payload validation from operation dispatch in `src/knowledge/update.ts`; add archive/restore path-only normalization, original-to-archive mapping, strict active/archive collision checks, regular-file/symlink/containment checks, and operation-specific success/failure responses without weakening create/update/upsert validation.
- [ ] Extend the locked transaction/rollback and invariant checks for exact-byte moves plus index/log updates: archive requires zero active target links and a byte-identical archive; restore requires one active target link, no archive source, and byte-identical restored content; every index link must exactly match the complete active page set.
- [ ] Log modifying create/update/upsert/archive/restore actions only after successful commit, refresh search after verification, and add focused filesystem tests for byte-identical round trip, default-search disappearance/reappearance, action logs, path/collision/symlink/lock rejection, injected move/write/refresh failure rollback, no dangling links, and unchanged legacy write behavior.

### Task 2: Add the fixed high/low maintenance engine and CLI

**Goal:** Implement a deterministic maintenance API/command whose weekly fast path is quiet and mutation-free and whose pressure path archives only conservatively proven, old, pure dated records oldest-first.

**Serves:** Exact 40 KiB → 30 KiB hysteresis, 30-day eligibility, fail-safe mixed/open handling, bounded manifests, and reusable parent-owned one-time/periodic rollout.

- [ ] Add a package-owned maintenance module with fixed 40 KiB high, 30 KiB low, 30-day age, index-byte fast path, strict dated-record parsing, caller-supplied bounded closed-issue evidence, `revisit_if` mixed-page exclusion, conservative `mtime` age, stable oldest-first ordering, and reuse of `executeKnowledgeUpdate({op:"archive"})` rather than direct wiki mutation.
- [ ] Add `minime-bot knowledge maintain` and operation-aware `knowledge update --op archive|restore --path ...` parsing/help/JSON/report behavior. Keep archive/restore free of fabricated body/frontmatter flags; keep default no-pressure maintenance output empty; validate report paths and bound all manifest arrays/errors.
- [ ] Add exact-boundary tests for `40960` no-op versus `40961` activation, `30 days` eligible versus just younger, reduction to `<=30720`, eligible exhaustion above low, equal-age path tiebreaking, counter/size recalculation after every archive, recently updated/mixed/open/unproven/non-dated skips, per-page safe failure, bounded report, and CLI exit/output contracts.

### Task 3: Expose, document, and package the complete contract

**Goal:** Keep Pi tool, CLI, installed package, documentation, and compatibility validation aligned with the managed operations and maintenance policy.

**Serves:** A deployable installed artifact, managed-only production cleanup, weekly private registration, and no regression to search/index/package behavior.

- [ ] Update the first-party Pi knowledge tool schema/description/guidelines for operation-specific arguments and reversible archive/restore, preserving the narrow direct-write guard; add extension tests that exercise archive and restore without requiring write payload fields and prove direct managed wiki writes stay blocked.
- [ ] Document archive destination/recovery, structural log semantics, fixed maintenance policy, conservative eligibility/mtime behavior, closed-issue evidence input, quiet no-op/report contracts, and parent-owned one-time cleanup without private examples. Extend package-install and CLI tests to execute installed archive → search miss → restore → search hit and an installed maintenance boundary fixture.
- [ ] Run focused tests, the full suite, lint, build, schema/CLI validation, and package dry-run; inspect `git diff --stat main...HEAD`, package inventory, generated extension parity, and public text for scope/PII leakage before review.

## Post-Completion

Parent flow: open and iterate the public feature PR through green CI/review, merge, prepare the next SemVer-valid CalVer release PR, rerun full release validation on the exact release tree, publish the tag/release, and deploy the installed package through the canonical wrapper while preserving the required Homebrew runtime root. Restart only if the package activation requires it; apply later private cron-only configuration with `--sync-crons` and prove the bot PID is unchanged.

After release, inspect production candidates against closed issue state and mixed/current durable conclusions. Run the one-time archival selection only through installed managed archive operations, retain a bounded manifest with before/after bytes and archived/skipped/error counts, prove archived bytes match their pre-pass hashes, default search/index omit archived pages, and no index link dangles. Run the installed fixed maintenance command once to prove its real below/above-threshold behavior without weakening policy, register the weekly private maintenance cron through the canonical private PR flow, and verify all persisted/live cron jobs still resolve Homebrew Node.

Finally verify public/private main and worktrees, feature/release/private PRs, tag target, installed version, runtime/config/workspace health, archive/restore installed-artifact smoke, production cleanup recovery evidence, issue closure, and no leftover issue-owned branches. Update durable Knowledge, write the single watcher-owned terminal report artifact, mark terminal verification truthfully, and wait for its delivery receipt before completing the queue.
