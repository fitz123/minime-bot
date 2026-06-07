# Plan: package-root import for minime-bot

## Goal

Turn this bootstrap repository into the working public `minime-bot` npm/GitHub package repository.

This is the public package phase only. Do not change private production runtime, launchd, or deployment state in this run.

GitHub issue: #1.

## Context

- This repo is the new bot-only package repository.
- The legacy public repository remains the source for current bot package code during this import.
- Source package input is the sibling checkout `../claude-code-bot/bot`.
- ADR-080: private workspace consumes this bot as a package; the private workspace owns workspace state.
- ADR-081: schema/write-guard is retired from the final package contract.
- Public-repo rule: do not commit secrets, private paths, chat/user IDs from production, real names, handles, addresses, or private workspace artifacts.

## Non-goals

- Do not implement private `deploy-bot-package.sh` here.
- Do not modify or restart production.
- Do not add workspace templates or private workspace files to this repo.
- Do not reintroduce the retired schema/write-guard wrapper, retired schema env vars, schema allow-list parsing, or guard parity tests as active runtime contract.
- Do not push directly to `main`; open a PR when done.

## Validation commands

Run from repo root:

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace

git ls-files | grep -E "^(node_modules/|dist/|\.tmp/|\.claude/|config\.yaml|config\.local\.yaml|crons\.yaml|crons\.local\.yaml|CLAUDE\.md|USER\.md|IDENTITY\.md|MEMORY\.md|reference/|memory/)" && exit 1 || true
npm run check:schema-guard-contract
```

## Tasks

### Task 1: Import package inputs safely

- [x] Copy allowed package inputs from `../claude-code-bot/bot` into repo root: `src`, `scripts`, `test-fixtures`, `package.json`, `package-lock.json`, `tsconfig.json`, and `telegram-bot.plist.example`.
- [x] Do not copy generated/runtime files: `node_modules`, `dist`, `.tmp`, logs, media/runtime data.
- [x] Do not copy private/workspace-root files from the legacy repository.
- [x] Keep or rewrite the bootstrap MIT license without real-person metadata.

### Task 2: Move Pi extension source to package-owned root path

- [x] Copy source Pi wrappers from the legacy Pi wrapper source directory to `extensions/pi` in this repo.
- [x] Update `scripts/build-package-artifacts.mjs` to read wrapper sources from `extensions/pi` and emit package artifacts under `dist/extensions/pi`.
- [x] Update `src/workspace-contract.ts` source-mode extension directory to `extensions/pi`.
- [x] Update comments/docs/tests that mention `.claude/extensions` as a current source path.
- [x] Ensure source wrapper TypeScript is not included in the packed package; packed runtime should use built `dist/extensions/pi` files.

### Task 3: Rename package metadata and install expectations

- [x] Set `package.json.name` to `minime-bot` and keep binary `minime-bot`.
- [x] Update repository URL to the new repo.
- [x] Remove real-person author metadata or replace it with non-PII contributor metadata.
- [x] Update package-lock consistently.
- [x] Update tests expecting `node_modules/minime` or package basename `minime` to `minime-bot`.

### Task 4: Rewrite public docs and repo instructions

- [x] Replace README with concise current package docs: purpose, package CLI, external control workspace via `--workspace` or `MINIME_WORKSPACE_ROOT`, validation commands, and no bundled private workspace.
- [x] Add/update CHANGELOG so tests pass and current architecture is not described as Claude-CLI-only.
- [x] Add AGENTS.md with public repo rules: no PII/secrets, PR-only after bootstrap, validation commands, package repo owns runtime code and Pi extensions only.
- [x] Do not add root `CLAUDE.md` or root `.claude`.

### Task 5: Add minimal CI guardrails

- [x] Add author identity workflow.
- [x] Add CI workflow for pull requests: `npm ci`, `npm test`, `npm run build`, `npm pack --dry-run`, and schema-contract check if present.
- [x] Do not add gitleaks workflow unless the required config secret exists in this repo.

### Task 6: Fix root-layout tests and stale references

- [x] Rewrite `src/__tests__/project-naming.test.ts` for package-root layout.
- [x] Remove tests that assert workspace template files at repo root.
- [x] Update path split tests from old `.claude/extensions` source paths to `extensions/pi`.
- [x] Keep package-install tests proving no schema requirement and no guard extension packaging.

### Task 7: Final public safety and package validation

- [x] Run all validation commands.
- [x] Confirm no tracked generated/runtime/private/workspace-template paths.
- [x] Confirm no known stale guard/schema contract strings outside historical/negative test context.
- [x] Commit changes with issue reference.
- [x] Push branch and open PR against `main`; do not merge.

## Completion criteria

- Repo root is a working npm package checkout.
- Source wrappers live under `extensions/pi`; built wrappers under `dist/extensions/pi`.
- Package install expectations use `minime-bot`.
- No active schema/write-guard runtime contract is reintroduced.
- CI exists and PR is opened for review.
