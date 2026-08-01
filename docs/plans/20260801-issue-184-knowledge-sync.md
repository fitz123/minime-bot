# Plan: Self-completing Knowledge Git synchronization

## Goal

Add one first-party `minime-bot knowledge sync` path for a clean, committed Knowledge v2 workspace that reconciles local `main` with `origin/main`, preserves every committed Knowledge variant and provenance, regenerates derived catalog state, retains append-only structural history, and finishes with a clean local/remote canonical branch. The existing Pi guard continues blocking raw accidental managed-path and worktree mutations, but points agents to the managed sync command instead of stranding committed history.

## Non-goals

- No defense against a malicious same-UID agent or alternate-command bypass hardening.
- No generic Git synchronization framework, daemon, database, queue, workflow engine, or multi-tenant protocol.
- No force-push, reset, shared-history rebase, destructive cleanup, silent winner selection, or automatic resolution of non-Knowledge conflicts.
- No package-owned workspace snapshot policy: workspace-health/backup remain responsible for validating and committing their owned local changes before sync.
- No Ralphex-owned PR, release, deployment, production reconciliation, private cron changes, or cleanup of production recovery branches.

## Context

- `src/pi-extensions/knowledge-tools.ts` currently maps every worktree-mutating Git command to the workspace root. The managed-ancestor check therefore blocks `merge`, `pull`, `cherry-pick`, and related commands before Git can reconcile already-committed history.
- `src/knowledge/update.ts` already provides the narrow Knowledge v2 layout detection, per-workspace lock pattern, page/frontmatter validation, complete index generation, structural-log append behavior, search refresh boundary, and rollback conventions. Reuse/extract these primitives rather than creating a parallel Knowledge model.
- `src/cli.ts` is the existing first-party surface for `knowledge update`, `maintain`, and `migrate`; `knowledge sync` belongs beside them and accepts an agent workspace without loading control-workspace secrets.
- The sync engine must leave the canonical worktree untouched while preparing a divergent merge. Use a temporary detached Git worktree plus durable recovery refs for the pre-sync local and fetched remote tips. Fast-forward canonical `main` only after the candidate tree validates; remove temporary/recovery state only after local and remote `main` both reach the validated commit.
- Let Git perform the normal three-way merge first. For conflicting managed pages, deterministically produce one schema-valid page that preserves both committed variants with source commit provenance and an explicit unresolved marker; do not infer which claim is true. Preserve both structural-log histories and regenerate `wiki/index.md` from the resulting active pages. Any unresolved conflict outside managed Knowledge aborts the candidate and leaves canonical state and recovery refs intact.
- A push race receives one bounded fetch/reconcile retry. A crash before canonical fast-forward leaves canonical history untouched; a crash after local fast-forward is idempotently recoverable by a later sync invocation.

## Validation Commands

```bash
npm run test:file -- src/__tests__/knowledge-sync.test.ts src/__tests__/knowledge-pi-extension.test.ts src/__tests__/cli.test.ts
npm run build
npm test
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
```

## Tasks

### Task 1: Build the isolated Git convergence transaction

**Goal:** Reconcile clean committed local/remote history without exposing canonical `main` to a partial merge or losing either pre-sync tip.

**Serves:** Ninja requires local `main`, remote `main`, and the working tree to converge autonomously while all committed information remains reachable and destructive Git operations stay forbidden.

- [x] Create `src/knowledge/sync.ts` with typed success/failure results, Knowledge v2/Git-root/current-branch/clean-worktree validation, injected Git/filesystem dependencies for tests, and the existing Knowledge workspace lock boundary.
- [x] Implement fetch and ahead/behind/diverged classification, durable local/remote recovery refs, an isolated temporary detached worktree for divergent candidates, canonical fast-forward only after validation, push verification, and one bounded push-race retry.
- [x] Keep recovery refs when convergence fails or their unique commits are not yet reachable from canonical history; remove temporary worktrees and recovery refs only after verified local/remote convergence.
- [x] Add `src/__tests__/knowledge-sync.test.ts` integration fixtures with temporary local/bare remotes covering no-op, behind fast-forward, ahead push, clean divergence, push race, interrupted/retried state, and pre-sync commit reachability.
- [x] Add error-path tests proving dirty/non-main/non-repository inputs and non-Knowledge conflicts leave canonical HEAD/worktree unchanged with bounded actionable failures.
- [x] Run `npm run test:file -- src/__tests__/knowledge-sync.test.ts` and fix all failures before Task 2.

### Task 2: Reconcile managed Knowledge conflicts data-preservingly

**Goal:** Turn a divergent candidate into one valid Knowledge v2 corpus without dropping either committed page/log history or trusting one conflicting claim as truth.

**Serves:** Ninja requires different-page changes, same-page semantic changes, generated index drift, and append-only structural history to converge without operator Git repair; irreconcilable claims must remain explicit with provenance.

- [x] Extract the minimum reusable page collection/frontmatter/index/lock validation primitives from `src/knowledge/update.ts` for the sync candidate; do not create a second parser or index format.
- [x] Resolve `wiki/index.md` only by regenerating it from validated active pages, and merge `wiki/log.md` as a stable data-preserving union plus one bounded sync provenance entry.
- [x] For a Git-conflicting `wiki/pages/<type>/**/*.md`, first accept Git's clean three-way result; otherwise create one schema-valid unresolved page that retains both complete source variants, identifies their commit tips, preserves path-derived type, and carries an explicit `revisit_if`/body marker without declaring a winner.
- [x] Handle managed add/add, modify/modify, and modify/delete cases without losing a committed variant; fail closed on unsupported managed control/archive conflicts while preserving both recovery refs and canonical state.
- [x] Validate every candidate page, exact full-corpus index equality, structural-log preservation, managed-path safety, and clean candidate Git state before creating the merge commit.
- [x] Extend `src/__tests__/knowledge-sync.test.ts` for independent pages, stale concurrent indexes, concurrent structural logs, same-page compatible and contradictory edits, modify/delete, malformed variants, unsupported archive/control conflicts, and deterministic idempotent reruns.
- [x] Run `npm run test:file -- src/__tests__/knowledge-sync.test.ts src/__tests__/knowledge-update.test.ts` and fix all failures before Task 3.

### Task 3: Expose the managed path and preserve guard guidance

**Goal:** Make the safe convergence path package-installed and agent-legible while retaining the existing narrow protection against accidental direct writes and raw Git worktree mutations.

**Serves:** Ninja requires a first-party self-completing alternative so the guard helps fallible cooperative agents rather than blocking them into operator intervention.

- [ ] Add `knowledge sync --workspace <agent-workspace> [--json]` to `src/cli.ts`, CLI help, response formatting, and installed package exports without loading control secrets or accepting destructive escape flags.
- [ ] Update `src/pi-extensions/knowledge-tools.ts` block reasons and static context/documentation to distinguish `knowledge_update` for page mutations from `minime-bot knowledge sync` for committed-history reconciliation; keep raw worktree-mutating Git commands and direct managed writes blocked.
- [ ] Extend `src/__tests__/knowledge-pi-extension.test.ts` and `src/__tests__/cli.test.ts` for actionable guard output, successful/failed sync exit contracts, strict option parsing, and unchanged legacy/pre-v2 behavior.
- [ ] Extend `src/__tests__/package-install.test.ts` with an installed-package local/bare-remote fixture proving divergent Knowledge histories converge, search sees the regenerated corpus, and a non-Knowledge conflict leaves canonical state unchanged.
- [ ] Update `src/pi-extensions/README.md` and the minimum relevant public documentation with the trusted-agent boundary, clean committed-input contract, recovery-ref behavior, unresolved-page semantics, and forbidden Git operations; include only synthetic public examples.
- [ ] Run the focused validation commands, then `npm test`, `npm run build`, `npm pack --dry-run`, and `npm run check:schema-guard-contract`; review `git diff main...HEAD` for scope and public-data safety.

## Post-Completion

The parent supervisor owns PR/Copilot/CI, release, validated deployment/restart, and the production #184/#108 convergence stage. Production verification must prove all unique pre-sync commits remain reachable, the real workspace becomes clean with local/remote `main` equal, Knowledge validates, dependent health import/backup behavior recovers, and recovery refs/worktrees are removed only after canonical reachability is demonstrated.
