# minime-bot

minime-bot is the public npm package repository for a Telegram and Discord
multi-agent bot runtime backed by Pi/Codex sessions.

The package owns runtime TypeScript, packaging scripts, and Pi extension source.
It does not bundle a private control workspace, production config, chat IDs,
private agent memory, or local runtime state.

The package uses four separate roots:

- The control/app workspace contains `config.yaml`, `crons.yaml`, runtime state,
  logs, media, and global secret-file references.
- The agent workspace is the project or context tree operated on by Pi/Codex,
  Knowledge v2, and guard checks.
- The package source checkout is this repository.
- The package runtime install is a built npm install that loads artifacts from
  `dist/`.

The workspace environment contract is a hard cut to canonical names. Config and
workspace commands read only `MINIME_CONTROL_WORKSPACE_ROOT` when `--workspace`
is omitted; Knowledge commands and Pi child processes use
`MINIME_AGENT_WORKSPACE_ROOT` for agent context. Ambiguous pre-cut workspace env
names are intentionally ignored and are not passed to Pi children.

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
`--workspace` is omitted, knowledge commands use
`MINIME_AGENT_WORKSPACE_ROOT`; config and workspace commands use
`MINIME_CONTROL_WORKSPACE_ROOT`.

`update` is the durable Knowledge v2 write path; direct Pi writes to managed v2
wiki paths are blocked when first-party Pi extensions are enabled. Migration is
dry-run by default. `--apply` writes planned files only when the agent workspace
has a clean git worktree and no blocking review items; `--allow-dirty` bypasses
only the git cleanliness gate after operator review. Migration writes or copies
files, does not delete legacy sources, and `--report` writes the JSON response.
Dry-runs skip catalog-only legacy memory indexes and report known active
runtime docs or package/domain trees as nonblocking `out_of_scope` review items.
Pre-v2 `wiki/schema.md`, `wiki/index.md`, `wiki/log.md`, and existing
`wiki/issues.md` controls are archived under `artifacts/legacy/wiki/` before
replacement or pending-review writes are planned. Secret-bearing legacy
`memory/auto` pages and unsafe controls still block migration; secret-bearing
`memory/diary` entries are omitted and reported as nonblocking
`secret_diary_omitted` review items.
If a planned wiki page target disagrees with page frontmatter type, migration
emits a blocking `type_review` item, omits that unsafe page write, still writes
the dry-run report, and keeps `--apply` blocked until review.

The package also exposes a quota sampler for Prometheus textfile collectors:

```bash
minime-codex-quota-sampler --workspace /path/to/workspace --textfile-dir /path/to/textfiles
```

The sampler uses the packaged Pi CLI by default; override it with `--pi-bin` or
`CODEX_QUOTA_PI_BIN`. Its probe passes `--approve` for Pi 0.79 project trust,
and `--dry-run` prints the resolved command without executing it.

## Control Workspace

Runtime config and agent workspace files live outside this package in a control
workspace. Select it explicitly with `--workspace`:

```bash
minime-bot workspace validate --workspace test-fixtures/minimal-workspace
```

For long-running services, set `MINIME_CONTROL_WORKSPACE_ROOT` instead:

```bash
MINIME_CONTROL_WORKSPACE_ROOT=/path/to/workspace minime-bot workspace validate
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
MINIME_CONTROL_WORKSPACE_ROOT=/path/to/workspace node dist/main.js
```

The launchd example uses separate `PACKAGE_ROOT` and `CONTROL_WORKSPACE`
placeholders and sets `MINIME_CONTROL_WORKSPACE_ROOT` in the service
environment.

## Launchd Operations

The packaged restart script is self-safe by default when the bot runs under
launchd:

```bash
scripts/restart-bot.sh --plist
```

That command validates the bot plist and current config, writes a fixed
one-shot restart supervisor plist labeled
`ai.minime.telegram-bot.restart-supervisor`, bootouts any stale supervisor
registration, lint-checks the generated plist, bootstraps the supervisor, and
returns before `ai.minime.telegram-bot` is stopped. The supervisor then runs the
worker restart outside the original bot/Pi process, records status and logs
under `~/Library/Logs/minime-bot/restart` by default, and performs the
launchd `bootout`/`bootstrap` sequence.

Explicit foreground mode is for operator debugging only:

```bash
scripts/restart-bot.sh --worker --plist
scripts/restart-bot.sh --foreground --plist
```

Foreground/worker mode is guarded inside Pi child sessions. If
`MINIME_BOT_PI_SESSION=1`, it refuses to run unless
`MINIME_RESTART_UNSAFE_FOREGROUND=1` is also set. The normal in-bot path should
use `--plist` without `--worker` so the request can return before launchd tears
down the bot service. The implementation intentionally uses the fixed helper
label cleanup instead of custom lock files.

Cron schedule deployment is separate from bot restart. Cron prompt and timeout
changes are read by the cron runner from the merged workspace cron files at
each execution, so they do not require restarting `ai.minime.telegram-bot`.
Schedule changes that affect launchd plists are synced with:

```bash
minime-bot launchd crons sync --workspace /path/to/control-workspace --dry-run
minime-bot launchd crons sync --workspace /path/to/control-workspace
minime-bot launchd crons sync --workspace /path/to/control-workspace --no-prune
minime-bot launchd crons sync --workspace /path/to/control-workspace --launch-agents-dir /tmp/LaunchAgents
```

The sync command owns only the `ai.minime.cron.*` namespace. By default it
creates or updates active cron plists, lint-checks changed plists, re-bootstraps
changed active cron labels, and prunes stale or disabled owned cron plists by
booting them out and deleting the plist without bootstrapping them again.
`--no-prune` leaves stale owned cron plists in place for emergency/manual
operation. `--launch-agents-dir` overrides the default
`~/Library/LaunchAgents` target. Cron sync must not bootout, bootstrap, signal,
or otherwise restart `ai.minime.telegram-bot`.

More detail is in `docs/launchd-operations.md`.

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
