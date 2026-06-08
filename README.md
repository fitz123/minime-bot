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

Knowledge commands operate on an agent workspace, not the control workspace:

```bash
minime-bot knowledge search --workspace /path/to/agent-workspace --query "runtime notes" --scope default --max-results 10 --json
minime-bot knowledge get --workspace /path/to/agent-workspace --path wiki/pages/project/runtime.md --from 1 --lines 20
minime-bot knowledge update --workspace /path/to/agent-workspace --op upsert --type project --slug runtime --frontmatter '{"name":"Runtime","description":"Runtime notes","type":"project"}' --body-file /path/to/body.md --json
minime-bot knowledge migrate --workspace /path/to/agent-workspace --dry-run --report /path/to/report.json --json
minime-bot knowledge migrate --workspace /path/to/agent-workspace --apply --allow-dirty --report /path/to/report.json --json
```

Knowledge commands do not load config secrets. `search` reads the curated corpus
by default (`wiki/index.md` and `wiki/pages/**/*.md` in v2, or `MEMORY.md` and
`memory/auto/**/*.md` in legacy workspaces). `--scope default` and `--scope auto`
both select that curated corpus. Use `--scope diary` for narrative history and
`--scope all` when both curated pages and diary chronology are needed. If
`--workspace` is omitted, knowledge commands use `MINIME_AGENT_WORKSPACE_CWD`;
config and workspace commands still use `MINIME_WORKSPACE_ROOT`.

`update` is the durable Knowledge v2 write path; direct Pi writes to managed v2
wiki paths are blocked when first-party Pi extensions are enabled. Migration is
dry-run by default. `--apply` writes planned files only when the agent workspace
has a clean git worktree and no blocking review items; `--allow-dirty` bypasses
only the git cleanliness gate after operator review. Migration writes or copies
files, does not delete legacy sources, and `--report` writes the JSON response.
Dry-runs skip catalog-only legacy memory indexes and report known active
runtime docs or package/domain trees as nonblocking `out_of_scope` review items.
Pre-v2 `wiki/schema.md`, `wiki/index.md`, and `wiki/log.md` controls are
archived under `artifacts/legacy/wiki/` before canonical Knowledge v2 controls
are generated. Secret-bearing or unsafe legacy controls still block migration.
If a planned wiki page target disagrees with page frontmatter type, migration
emits a blocking `type_review` item, omits that unsafe page write, still writes
the dry-run report, and keeps `--apply` blocked until review.

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

## Knowledge v2 Layout

Agent workspaces may use the package-owned Knowledge v2 layout:

- `wiki/schema.md` declares `format: minime-knowledge-v2` and the page contract.
- `wiki/index.md` is the catalog/discovery file maintained by package helpers.
- `wiki/pages/<type>/**/*.md` contains synthesized durable knowledge pages.
- `diary/**` contains narrative history and is excluded from default search.
- `raw/**` contains external, user-provided, or source inputs.
- `artifacts/**` contains process evidence such as plans, reports, runbooks,
  retained logs, and task outputs; it is outside the default knowledge corpus.

Route source material to `raw/**`, generated process evidence to `artifacts/**`,
and durable conclusions to `wiki/pages/**` with links back to source material.
The legacy `reference/` name is tolerated during compatibility, but
`artifacts/` is the target process-artifact namespace.

Knowledge pages are Markdown files under `wiki/pages/<type>/**/*.md`, where
`type` is `user`, `project`, `feedback`, or `reference`. Page frontmatter is
flat YAML with required `name`, `description`, and `type`; optional fields are
`confidence`, `revisit_if`, and `originSessionId`. The Markdown body passed to
`knowledge update` must not include its own frontmatter. `--op create` refuses
existing pages, `--op update` requires an existing page, and `--op upsert`
creates or updates as needed while regenerating `wiki/index.md`.

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
`.claude`, `USER.md`, `IDENTITY.md`, `MEMORY.md`, `reference/`, `memory/`, or
`artifacts/`.

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

git ls-files | grep -E "^(node_modules/|dist/|\.tmp/|\.claude/|config\.yaml|config\.local\.yaml|crons\.yaml|crons\.local\.yaml|CLAUDE\.md|USER\.md|IDENTITY\.md|MEMORY\.md|reference/|memory/|artifacts/)" && exit 1 || true
npm run check:schema-guard-contract
```

Changes should land through pull requests. Do not push directly to `main`.
