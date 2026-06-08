# Plan: Knowledge migrate false-blocker reduction

## Goal

Address GitHub issue #9 by reducing package-level false blockers in `knowledge migrate --dry-run` while keeping real safety reviews blocking.

This is a continuation on top of the existing Knowledge migration review-fix branch. Keep public repo content sanitized: no private workspace paths, chat IDs, personal names, or secret values.

## Context

Current migration dry-run behavior can over-block on inputs where the safe package-level decision is deterministic:

- catalog-only `MEMORY.md` sections should not become wiki pages;
- active/runtime docs and domain trees should be nonblocking `out_of_scope` items, not `unknown_provenance` blockers;
- explicit `type: feedback` pages should not be overridden by broad runbook keyword heuristics;
- non-ASCII names can slugify to `untitled`, creating avoidable collisions;
- pre-v2 topic-wiki control files should be archived and then safely replaced by canonical v2 controls.

Keep these constraints:

- friend-agent profile/reference pages must still require operator-reviewed classification; do not blindly route them;
- secret-containing legacy knowledge must not be migrated into wiki/raw/artifacts;
- do not resurrect root `schema.md` or any broad workspace write-guard.

## Validation Commands

```bash
npm test -- --test-name-pattern "knowledge layout migration"
npm test
npm run build
npm pack --dry-run
```

Private operator validation with real workspaces will be run outside this public repo plan after the package tests pass.

## Tasks

### Task 1: Improve catalog and active-doc classification

- [x] Expand catalog-only `MEMORY.md` detection for link lists with descriptions and simple Markdown tables.
- [x] Add tests proving catalog/index sections are skipped rather than becoming pages or blockers.
- [x] Classify active/runtime docs and domain trees as nonblocking out-of-scope with specific reasons:
  - root README/CHANGELOG/AGENTS-style docs;
  - Beads metadata docs;
  - Nix/domain/client/training trees;
  - root status docs.
- [x] Keep genuinely unknown Markdown as blocking `unknown_provenance`.

### Task 2: Preserve explicit feedback and harden slugging

- [x] Ensure explicit `type: feedback` legacy pages route to feedback pages before broad runbook/artifact keyword checks.
- [x] Keep one-off plan/runbook heuristics for untyped or project/reference pages where they still apply.
- [x] Add a slug fallback that uses the source filename when the display name slugifies to an empty/`untitled` slug.
- [x] Add tests for non-ASCII feedback names avoiding `untitled` collisions.

### Task 3: Handle pre-v2 wiki controls safely

- [x] When a legacy/pre-v2 workspace already has non-v2 `wiki/schema.md`, `wiki/index.md`, or `wiki/log.md`, plan archive copies under `artifacts/`.
- [x] Generate canonical v2 controls with explicit safe overwrite semantics only after archive copies are planned.
- [x] Do not overwrite existing v2 controls, symlinks, or unsafe paths.
- [x] Add tests for pre-v2 control archival and canonical v2 control generation.

### Task 4: Validate and document

- [ ] Run the validation commands.
- [ ] Update README notes only if behavior needs operator-visible documentation.
- [ ] Keep issue #7 behavior intact and update PR body to mention issue #9 if this branch remains the same PR.
