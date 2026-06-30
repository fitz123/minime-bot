# Plan: Issue #32 trusted shared platform-rule symlinks

## Goal

Fix Pi context assembly so satellite agent workspaces can share the main workspace platform rules via a trusted `.claude/rules/platform` symlink, without allowing arbitrary out-of-workspace symlink traversal.

## Context and decision

- Public issue: `fitz123/minime-bot#32`.
- Private decision: ADR-084 (2026-06-30) records the intended pattern: satellite workspaces may symlink `.claude/rules/platform` to the configured main agent workspace's `.claude/rules/platform`; Pi context assembly must include that exact target.
- Existing warning shape:
  - `WARN [pi-context] markdown directory resolves outside the workspace, skipping: <satellite-workspace>/.claude/rules/platform`
- Root cause:
  - `src/pi-context-assembler.ts:listMarkdown(dir, baseDir)` uses `resolveContainedRealPath(dir, baseDir)`.
  - A symlink target outside the satellite workspace is classified as escaped, so no platform rules are collected.

Claude/Opus plan validation was attempted from the bot/Pi launch context before writing this plan; direct `claude -p --model opus` and `launchctl bsexec` via Terminal/iTerm both returned `401 Invalid authentication credentials`, so proceed with best available planner.

## Constraints

- Do not allow general out-of-workspace imports/rules.
- Keep arbitrary symlinked rule files blocked unless they are inside the allowed trusted platform directory.
- The trust edge is narrow: only `.claude/rules/platform` symlink target matching the configured main workspace platform rules directory.
- Public repo text must not include private local paths, user handles, chat IDs, or transcript payloads.

## Tasks

### Task 1: Add trusted platform-rules allowlist to assembler

- [x] Add a helper in `src/pi-context-assembler.ts` that identifies a rules directory request for `.claude/rules/platform` whose resolved realpath equals the configured main workspace platform rules directory.
- [x] Use the configured workspace contract / config surface already available to the package; avoid hardcoded private paths.
- [x] Let `collectRules()` include markdown files from that trusted directory while preserving relpaths as `.claude/rules/platform/<file>.md` in the satellite bundle.
- [x] Keep warnings/skips for all other escaped markdown directories.

### Task 2: Preserve containment for unsafe symlinks

- [ ] Keep `@` imports, output styles, knowledge files, custom rules, arbitrary symlinked platform dirs, and individual rule-file symlinks outside allowed roots blocked.
- [ ] If a platform directory is trusted but a file inside it resolves outside the trusted target, skip that file and warn.

### Task 3: Tests

- [ ] Add regression coverage in `src/__tests__/context-assembler.test.ts` for a satellite workspace whose `.claude/rules/platform` symlinks to a main workspace `.claude/rules/platform`; assert the platform rule appears in `collectRules()` and `buildBundle()`.
- [ ] Add/keep negative coverage for an escaped `.claude/rules/platform` symlink to an untrusted directory; assert it is skipped.
- [ ] Add/keep negative coverage for a malicious rule-file symlink inside a trusted platform rules dir escaping the trusted dir.
- [ ] Ensure source-manifest/cache signatures notice trusted shared rule content changes.

### Task 4: Validation and PR

Run:

```bash
npm test -- src/__tests__/context-assembler.test.ts
npm test
npm run lint
npm run build
npm pack --dry-run
```

Then open/update PR for #32, run `gh pr checks`, and report the result. Do not release/deploy unless Ninja explicitly asks for a full release flow.
