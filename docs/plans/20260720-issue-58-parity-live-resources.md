# Issue #58: Live Primary-Resource Parity Compatibility

## Goal

Fix the two v2026.7.19 parity blockers without weakening ADR-099 exact-resource parity:

- effective skill packages may contain generated Python directories that are not capability inputs;
- a configured workflow extension legitimately imports `node:vm` and declared `acorn` package resources, and must run only from the immutable copied snapshot.

The change remains fail-closed for ordinary symlinks, arbitrary generated-directory names, arbitrary bare imports, runtime loaders, and snapshot escape. This plan covers the focused public package fix; the persistent supervisor owns PR, `v2026.7.20`, and the already-authorized inactive private rollout afterward.

## Source-grounded decisions

- `src/pi-primary-resources.ts:447-494` walks every skill-root entry and rejects every symlink. Only `createPiSkillResourceSnapshot` may skip the exact names `.venv`, `__pycache__`, and `.pytest_cache`, at any depth and before entry-type checks. Other traversals and all near-miss names remain strict. Because `src/ops-worker/parity.ts:317-370` copies only `snapshot.files` and rechecks the copied identity, skipped entries are absent from the immutable copy without changing identity formulas.
- Add only `node:vm` and `acorn` to the external specifier allowlist. The observed finite source graph also requires two exact AST corrections: allow only dot access `globalThis.navigator`, and treat a non-computed `PropertyAssignment` name such as `{ process: value }` as an inert key rather than an identifier reference. Bare/aliased/computed access and loader properties remain rejected.
- A declared bare dependency is not safe merely because its bytes are hashed. For `acorn`, primary contract resolution must prove that the explicit manifest covers its package metadata and runtime entry bytes. Missing coverage fails before launch.
- `commonResourceDirectory` currently flattens sibling packages under a hoisted `node_modules`, so bare resolution would leave or miss the immutable copy. Preserve the `node_modules` path segment in the private snapshot copy; do not solve this by loading ambient bytes or by a private wrapper substitution. Execute the generated wrapper through real Jiti after mutating the live fixture to prove it resolves the copied package.
- Keep `minime-pi-skill-identity-v5` and `minime-pi-extension-identity-v6`: identities are recomputed from the accepted bytes, and clean resources remain byte-identical.
- Add a concise `CHANGELOG.md` Unreleased entry. No credentials, listeners, activation, private paths, identifiers, or Windows-only work.

## Tasks

### Task 1: Exclude only bounded generated Python directories from skill snapshots

- [ ] Add regression tests for `.venv` symlink/directory, nested `__pycache__`, and `.pytest_cache` exclusion; exact-name near misses must remain included, and an ordinary nested symlink must still fail.
- [ ] Add the skill-only exact-name traversal exclusion and prove source/copy identities match while excluded entries are absent from prepared snapshots.
- [ ] Run the focused parity test and commit the logical unit.

### Task 2: Attest and execute the configured extension from a contained package layout

- [ ] Add focused tests for the exact accepted graph (`node:vm`, manifest-covered `acorn`, `globalThis.navigator`, inert `process:` key) and for rejection of unlisted/subpath imports, missing manifest coverage, unsafe aliases, computed access, object shorthand, computed keys, and loader-property access.
- [ ] Implement the exact allowlist/AST changes and fail-closed `acorn` package-entry/package-metadata manifest coverage in `src/pi-primary-resources.ts`.
- [ ] Preserve a hoisted `node_modules` segment when copying extension snapshots in `src/ops-worker/parity.ts`; test actual Jiti loading from the copied `acorn` package after the live fixture changes, with no ambient resolution.
- [ ] Add the Unreleased changelog entry; run focused parity/attempt/CLI tests and then the repository validation contract: `npm test`, `npm run lint`, `npm run build`, `npm pack --dry-run`, `npm run check:schema-guard-contract`, `node dist/cli.js --help`, and minimal-workspace validation. Run configured gitleaks, public-safety/identity checks, and verify the Ralphex diffstat equals `git diff --stat main...HEAD`.
- [ ] Commit the logical unit and leave a clean branch ready for the supervisor-owned PR/release cycle.

## Post-implementation gates

- Re-run both original live-resource reproductions outside the repository: effective skills resolve with generated directories excluded, and the configured extra extension resolves with its explicit dependency manifest, prepares an immutable copy with preserved package resolution, and loads through real Jiti.
- Use explicit `-b main`, Codex `gpt-5.6-sol` xhigh, no local Ralphex config/worktree, and the default 50-iteration ceiling. Never edit this plan after launch.
- Public PR/release text stays sanitized and links #58. The persistent full-cycle owner continues through feature PR, `v2026.7.20`, private pin refresh/PR, maximal inactive rollout, deterministic verification, and only then the single credential/activation gate.
