# Plan: Knowledge migrate type-mismatch dry-run review item

Status: complete. Addresses GitHub issue #7.

## Goal

Fix GitHub issue #7: `knowledge migrate --dry-run` must not abort when a routing heuristic plans a Knowledge v2 page path whose type directory disagrees with the page frontmatter. The migrator should emit a blocking review item and still write the dry-run report.

## Context

Observed failure shape, with workspace details redacted:

```text
knowledge migrate failed: planned page frontmatter failed validation for wiki/pages/project/learning/memory-files-status.md: frontmatter-type-mismatch
```

Current root cause:

- legacy page frontmatter is normalized and validated before routing;
- `classifyLegacyTarget` may route learning/curriculum content to `wiki/pages/project/learning/...` regardless of the legacy page's existing frontmatter type;
- `collectPlannedPages` derives expected type from the target path and currently throws on `frontmatter-type-mismatch`, aborting dry-run before a report can be written.

Required behavior:

- dry-run should be total/safe: produce a report unless the report path itself is invalid or the workspace cannot be read;
- type disagreement between target path and page frontmatter is an operator/type review blocker, not a thrown exception;
- apply must remain blocked while this review item exists;
- do not silently rewrite a page's frontmatter type unless the code has an explicit safe rule for that source class.

## Validation Commands

```bash
npm test -- --test-name-pattern "knowledge layout migration"
npm test
npm run build
```

## Tasks

### Task 1: Add regression test

- [x] Add a fixture with a legacy `memory/auto/*.md` page whose frontmatter type is not `project` but whose body triggers the learning/curriculum target heuristic.
- [x] Assert dry-run returns `ok: true` and includes a blocking review item instead of `knowledge-migration-failed`.
- [x] Assert the invalid planned wiki page is not included as a normal migrated page operation, or is otherwise guaranteed not to be applied before review.
- [x] Assert apply returns `knowledge-migration-review-required` and does not write managed v2 files for the mismatched page.

### Task 2: Fix planner behavior

- [x] Centralize validation that a `wiki/pages/<type>/...` target matches the page frontmatter `type`.
- [x] When target/frontmatter mismatch is found during planning, add a blocking `type_review` item with a stable reason such as `frontmatter_target_type_mismatch` and a useful `suggestedTarget`.
- [x] Skip adding the unsafe wiki page write operation for that source.
- [x] Keep `collectPlannedPages` defensive: it must not hard-throw for recoverable planned-page validation failures in dry-run/apply planning.

### Task 3: Verify no regressions

- [x] Existing successful migration tests still pass.
- [x] Existing review/blocker behavior still blocks apply.
- [x] Build succeeds.
- [x] Issue #7 can be closed by the PR.
