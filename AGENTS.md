# Repository Instructions

This is the public `minime-bot` package repository.

## Public Safety

- Do not commit secrets, tokens, private keys, SOPS output, production config,
  private paths, chat IDs, user IDs, real names, handles, addresses, or other
  PII.
- Do not add private workspace artifacts to the package root. Keep root
  `CLAUDE.md`, root `.claude`, `USER.md`, `IDENTITY.md`, `MEMORY.md`,
  `reference/`, `memory/`, root `config.yaml`, and root `crons.yaml` out of this
  repository.
- Keep generated and runtime output untracked, including `node_modules/`,
  `dist/`, `.tmp/`, logs, media files, and package tarballs.

## Ownership

- This repository owns package runtime code, tests, packaging scripts, and Pi
  extension source under `extensions/pi`.
- Control workspace files are external inputs selected by `--workspace` or
  `MINIME_WORKSPACE_ROOT`.
- Do not add deployment scripts or private production launch state here.

## Workflow

- During bootstrap, do not push directly to `main`; open pull requests for
  review.
- Keep changes scoped to the package contract and avoid unrelated refactors.
- Run validation from the package root before opening a pull request:

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace
```
