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
  `MINIME_CONTROL_WORKSPACE_ROOT`.
- Keep the control/app workspace, agent workspace, package source checkout, and
  package runtime install as distinct roots. Use only
  `MINIME_CONTROL_WORKSPACE_ROOT` and `MINIME_AGENT_WORKSPACE_ROOT` for the
  workspace env contract; retired ambiguous workspace env names must not be accepted
  or passed to Pi children.
- Do not add deployment scripts or private production launch state here.

## Workflow

- During bootstrap, do not push directly to `main`; open pull requests for
  review.
- PR commits must use a GitHub `users.noreply.github.com` author email; the
  author identity workflow rejects other author emails.
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
