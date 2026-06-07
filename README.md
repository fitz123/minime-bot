# minime-bot

minime-bot is the public npm package repository for a Telegram and Discord
multi-agent bot runtime backed by Pi/Codex sessions.

The package owns runtime TypeScript, packaging scripts, and Pi extension source.
It does not bundle a private control workspace, production config, chat IDs,
private agent memory, or local runtime state.

## Package CLI

Build the package before running the compiled CLI from this checkout:

```bash
npm ci
npm run build
node dist/cli.js --help
```

The installed package exposes the same binary:

```bash
minime-bot --help
minime-bot config validate --workspace /path/to/workspace
minime-bot workspace validate --workspace /path/to/workspace
```

The package also exposes a quota sampler for Prometheus textfile collectors:

```bash
minime-codex-quota-sampler --workspace /path/to/workspace --textfile-dir /path/to/textfiles
```

## Control Workspace

Runtime config and agent workspace files live outside this package in a control
workspace. Select it explicitly with `--workspace`:

```bash
minime-bot workspace validate --workspace test-fixtures/minimal-workspace
```

For long-running services, set `MINIME_WORKSPACE_ROOT` instead:

```bash
MINIME_WORKSPACE_ROOT=/path/to/workspace minime-bot workspace validate
```

By default, the workspace provides:

- `config.yaml` for agents, Telegram bindings, Discord bindings, and secrets
  references.
- `config.local.yaml` for local overrides when present.
- `crons.yaml` for scheduled prompts when present.
- `data/`, `.tmp/`, logs, and media locations used by runtime state.

Agent `workspaceCwd` values are resolved relative to the control workspace
unless they are absolute paths. Pi extension artifacts are loaded from the
package build under `dist/extensions/pi`.

## Running

Build first, then run the compiled runtime with an explicit control workspace:

```bash
npm run build
MINIME_WORKSPACE_ROOT=/path/to/workspace node dist/main.js
```

The launchd example uses separate `PACKAGE_ROOT` and `CONTROL_WORKSPACE`
placeholders and sets `MINIME_WORKSPACE_ROOT` in the service environment.

## Repository Boundaries

Do not add private workspace files to the package root. In particular, this
repository should not contain root `config.yaml`, `crons.yaml`, `CLAUDE.md`,
`.claude`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, `reference/`, or `memory/`.

The fixture under `test-fixtures/minimal-workspace` is intentionally minimal and
contains only public-safe sample paths and placeholder IDs.

## Validation

Run these commands from the package root before opening a pull request:

```bash
npm ci
npm test
npm run build
npm pack --dry-run
npm run check:schema-guard-contract
node dist/cli.js --help
npm run workspace:validate -- --workspace test-fixtures/minimal-workspace

git ls-files | grep -E "^(node_modules/|dist/|\.tmp/|\.claude/|config\.yaml|config\.local\.yaml|crons\.yaml|crons\.local\.yaml|CLAUDE\.md|USER\.md|IDENTITY\.md|MEMORY\.md|reference/|memory/)" && exit 1 || true
rg -n "$(printf '\116\151\143\157\040\102\141\151\154\157\156')" . && exit 1 || true
npm run check:schema-guard-contract
```

Changes should land through pull requests. Do not push directly to `main`.
