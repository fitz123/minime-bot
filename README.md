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

Interactive RPC sessions, cron runs, subagents, and ask-agent children resolve
the package-owned Pi 0.80.6 entrypoints and execute them with Node. They never
fall back to a global `pi` from `PATH`; a missing packaged entrypoint fails
explicitly. Startup logs report only the expected version, entrypoint kind, and
mismatch state, without exposing the resolved host path.

The sampler uses the same packaged Pi CLI by default; override it explicitly
with `--pi-bin` or `CODEX_QUOTA_PI_BIN`. Its probe passes `--approve` for the
isolated sampler project settings, and `--dry-run` prints the resolved command
without executing it.

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

Satellite agent workspaces may symlink `.claude/rules/platform` to the
configured `agents.main.workspaceCwd` `.claude/rules/platform`. Pi context
assembly includes that exact contained realpath match and keeps bundle headings
under the satellite `.claude/rules/platform/<file>.md` path. Other
out-of-workspace rule directories, custom rules, imports, output styles, and
escaping rule-file symlinks remain skipped.

Optional top-level `piExtraExtensions` entries allow operator-approved external
Pi extension entrypoints in normal bot-created interactive RPC sessions:

```yaml
piExtraExtensions:
  - /opt/minime/pi-extensions/approved-extension.ts
```

Entries are validated as non-empty absolute path strings during config load.
The bot still starts Pi with `--no-extensions`, loads its first-party wrappers
explicitly, then appends each approved extra unchanged as a repeatable
`--extension` argument. Each configured file must exist on the host that starts
Pi; a missing file fails the interactive spawn with a clear error.
`PI_EXTENSIONS_DISABLED=1` disables both first-party wrappers and configured
extras for a spawn. Cron extension subsets keep their existing first-party-only
scope. Subagent and ask-agent child spawns load the non-recursive first-party
wrappers, including the Codex transport overflow normalizer; ask-agent target
children also load approved `piExtraExtensions`, but reject configured extras
that point back at the first-party `subagent` or `ask-agent` wrappers.

Bot-created RPC sessions do not provide an interactive extension UI bridge.
Blocking `select`, `confirm`, `input`, and `editor` requests are answered as
cancelled; fire-and-forget UI updates are ignored. External extensions must
handle cancellation or provide a noninteractive path. Pi 0.80.6 does not bind
its RPC input reader until startup handlers complete, so a blocking dialog from
`session_start` instead fails session creation promptly and the child is reaped.

Agents opt into first-party `ask_agent` handoffs with an `askAgent` block. Both
the caller and target must have `enabled: true`; an omitted `canAsk` on an
enabled caller means wildcard allow, and `deny` overrides allow rules. Use
neutral agent ids and workspace placeholders in shared examples:

```yaml
agents:
  main:
    workspaceCwd: ./agent-workspace
    model: gpt-5.5
    askAgent:
      enabled: true
      canAsk:
        - helper
  helper:
    workspaceCwd: ./helper-workspace
    model: gpt-5.5-mini
    askAgent:
      enabled: true
      deny:
        - "*"
```

The target runs as a one-shot full Pi child in its own `workspaceCwd` with its
assembled context. Ask-agent children do not load recursive `subagent` or
`ask_agent` tools in the MVP.

The Pi tool is named `ask_agent` and accepts `agent`, `question`, and optional
`context`. Questions and caller-provided context are capped at 64 KiB. Target
children have a bounded 120s run window, and returned answers are capped at
32 KiB / 128 KiB with a `…[truncated]` marker. Successful tool content is JSON
with `answer`, `truncated`, and `needsClarification`; tool details also include
the caller and target ids.
Structured errors use stable codes such as `caller_unknown`, `target_unknown`,
`context_failed`, `not_enabled`, `denied`, `invalid_request`, `config_unavailable`,
and `spawn_unavailable`.

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

### Runtime Session Controls

`/clean` clears queued work, deletes the stored session state for that chat, and
supersedes any in-flight startup for the same chat. The next accepted message for
that chat starts a fresh Pi session instead of resuming the previous one.

If Pi reports `No session found matching ...` while resuming a stored session id,
the bot discards that stale resume once and starts a fresh Pi session. These
graceful stale-resume recoveries increment
`bot_pi_session_resume_discarded_total`; recovered stale resumes and
`/clean`-superseded startups do not increment `bot_session_crashes_total`.

Message buffers remain capped at 20 inputs. Over-cap input is not processed and
receives a coalesced resend-later notice, at most once per chat every 30 seconds.
`bot_message_queue_saturation_total` counts rejected inputs with a bounded
`buffer` label (`debounce` or `collect`), while
`bot_message_queue_rejection_notices_total` records `sent`, `failed`, and
`rate_limited` notice outcomes without identifying the chat.

Media downloads retry transient network or stream failures and HTTP 408, 429,
and 5xx responses up to three attempts, honoring a bounded `Retry-After` value.
`bot_media_download_retries_total` records bounded `recovered` and `exhausted`
outcomes. Permanent HTTP, size-limit, conversion, transcription, and empty
transcript failures are not retried; user replies identify the failed stage
without exposing transport details.

Streaming draft backpressure is reported by
`bot_draft_scheduler_events_total`; its bounded `event` label is one of
`throttled`, `coalesced`, `rate_limited`, or `failed`. These cosmetic outcomes
are kept separate from user-visible final response failures, which increment
`bot_final_delivery_failures_total`; neither metric uses chat identifiers or
message content as labels.

Pi interactive sessions normalize Codex/OpenAI request-byte transport overflows
before Pi decides retry versus compaction. When diagnostics include a WebSocket
1009/message-too-big signal with a pre-stream or `requestBytes` marker, the bot
treats the failure as context overflow so Pi can compact and retry. A generic
`Codex SSE response headers timed out` message alone is not treated as overflow.
If recovery fails, the delivered error includes the original 1009/message-too-big
cause. `PI_EXTENSIONS_DISABLED=1` disables this normalizer with the other
first-party wrappers.

Telegram polling liveness is based on successful `getUpdates` completions,
including empty responses during quiet chats. The runtime uses a 30-second
long-poll timeout and treats 90 seconds without successful poll progress as
stale. A bounded API check then distinguishes a reachable stalled poller from
degraded connectivity. A reachable API with no poll progress triggers one
deliberate `poll_stalled` restart. After degraded connectivity, polling uses
grammY's short retry cadence and gets one stale-threshold recovery window before
that restart can be selected. A failed or timed-out reachability check records
`api_unreachable` while keeping the process, queued messages, and active turns
alive; ordinary Telegram silence never causes a restart. Delayed Telegram
commands, messages, media, and reactions continue through normal handling
regardless of `sessionDefaults.maxMessageAgeMs`; that setting remains the
Discord stale-message cutoff. The low-cardinality metrics are
`bot_telegram_poll_progress_age_seconds`, `bot_telegram_poll_in_flight`,
`bot_poll_watchdog_checks_total`, and `bot_poll_watchdog_restarts_total`.
Because grammY pauses simple polling while middleware runs, bounded media
preprocessing is tracked separately and allowed up to ten minutes before it is
treated as a stalled handler.

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
launchd `bootout`/`bootstrap` sequence. If that fixed supervisor label is
already running, the request refuses to replace it instead of interrupting an
in-progress restart.

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
label for stale-registration cleanup instead of custom lock files.

Cron schedule deployment is separate from bot restart. Cron prompt and timeout
changes are read by the cron runner from the merged workspace cron files at
each execution, so they do not require restarting `ai.minime.telegram-bot`.
Each LLM cron inherits the model configured for its selected agent; there is no
per-cron model override or implicit package-level cron model pin.
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

Cron execution failures send `Cron FAIL: <task>` plus the error line to the
delivery chat. When Pi diagnostics are available, the notification appends a
`Diagnostics:` excerpt capped at 300 characters after sanitization and
best-effort redaction of common credential shapes. Full diagnostics remain in
the local `FAIL diagnostics: ...` cron log, and admin delivery-failure fallback
uses the same concise failure context.

More detail is in `docs/launchd-operations.md`.

### Host-native monitoring

The package also ships a Python-standard-library Telegram sender, loopback
Alertmanager webhook, and one-shot runtime doctor. They do not load Node or
package JavaScript, and the doctor can report failures of the container
monitoring stack itself. See [Host-native monitoring and Telegram alerts](docs/monitoring.md)
for prerequisites, configuration, installation, validation, diagnostics, and
rollback.

An opt-in same-host recovery supervisor can durably correlate and verify those
native signals while exposing bounded controls and native fallback. `observe`
keeps fixer dispatch off, `diagnose` permits the exact-session fixer to inspect
and reconcile without mutation, and `enabled` permits durably journaled repair.
Fresh host-native probes and active-slot validation, not the model's finish
claim, decide recovery. The package also ships a stable two-slot recovery
capsule plus manifest-verified bot staging and offline rollback commands.
Direct Telegram remains the default monitoring path.
Start with `minime-bot recovery config validate --workspace /path/to/control-workspace`
and `minime-bot recovery status --workspace /path/to/control-workspace`; see
[Same-host recovery supervisor](docs/recovery.md) for configuration, safety
boundaries, `capsule-stage`/`capsule-bootstrap`, `bot-stage`/`bot-rollback`,
drills, and rollback.

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
