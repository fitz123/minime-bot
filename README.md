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

The package also includes an inactive-by-default ops-worker foundation. It
exposes strict local submission and lifecycle evidence helpers plus loopback
health/status. Its opt-in feature surface adds continuous authorization,
primary context/capability attestation, quota-aware waits, typed availability
verification, a generic all-group Alertmanager incident contract with schema-v6
typed outcomes and redacted reports, a dedicated second-token Telegram control
plane with bounded text and locally transcribed voice conversation,
authenticated loopback Alertmanager intake, and a deterministic fake fault
lab. Conversational control proposals require a deterministic operator
confirmation and are revalidated through the same lifecycle path as slash
commands; incident work preempts conversation, while slash commands remain
provider-independent. Nothing
starts automatically: control and intake exist only under an explicit
`worker start --control-config` with trusted embedding dependencies. See
[Ops-worker policy, control, intake, and fault lab](docs/ops-worker.md).

Knowledge commands operate on an agent workspace, not the control workspace:

```bash
minime-bot knowledge search --workspace /path/to/agent-workspace --query "runtime notes" --scope default --max-results 10 --json
minime-bot knowledge get --workspace /path/to/agent-workspace --path wiki/pages/project/runtime.md --from 1 --lines 20
minime-bot knowledge update --workspace /path/to/agent-workspace --op upsert --type project --slug runtime --frontmatter '{"name":"Runtime","description":"Runtime notes","type":"project"}' --body-file /path/to/body.md --json
minime-bot knowledge update --workspace /path/to/agent-workspace --op archive --path wiki/pages/project/history/issue-123-2026-05-01.md --json
minime-bot knowledge update --workspace /path/to/agent-workspace --op restore --path wiki/pages/project/history/issue-123-2026-05-01.md --json
minime-bot knowledge sync --workspace /path/to/agent-workspace --json
minime-bot knowledge maintain --workspace /path/to/agent-workspace --closed-issues '[123,456]' --json --report artifacts/knowledge-maintenance/latest.json
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
wiki paths are blocked when first-party Pi extensions are enabled. Its
`create`, `update`, and `upsert` operations use the page write payload shown
above. `archive` and `restore` instead accept only `--op` and the original
managed `--path`; they do not accept type, slug, frontmatter, or body flags.
`sync` is the separate committed-history path for reconciling local `main` with
`origin/main`; it does not accept force, dirty-worktree, rebase, or other
destructive escape options.
Migration is dry-run by default. `--apply` writes planned files only when the
agent workspace has a clean git worktree and no blocking review items;
`--allow-dirty` bypasses only the git cleanliness gate after operator review.
Migration writes or copies files, does not delete legacy sources, and
`--report` writes the JSON response.
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
the package-owned Pi 0.82.1 entrypoints and execute them with Node. They never
fall back to a global `pi` from `PATH`; a missing packaged entrypoint fails
explicitly. Startup logs report only the expected version, entrypoint kind, and
mismatch state, without exposing the resolved host path.

The runtime dependency contract pins all four package-owned Pi packages to
0.82.1 and grammY to 1.45.1 (`@grammyjs/types` 4.0.0). Pi owns the bounded
summarization retry, including transient WebSocket recovery; Minime treats its
retry records as stream activity and does not add a second compaction retry.
`agent_settled` remains the accepted-turn terminal boundary. In primary
interactive sessions, a reasoning-only `stopReason=length` outcome without
visible text continues automatically after successful threshold compaction
through a hidden follow-up. If compaction produces no meaningful continuation
outcome, Minime returns a specific length-limit error. Cron, subagent-child, and
ask-agent-child sessions do not load this continuation wrapper.

Pi's OpenAI catalog reports a 272K (272,000-token) context window for the
supported GPT-5.6 models. Earlier compaction at that boundary is expected and
Minime does not override the model metadata. The grammY upgrade preserves the
existing polling, authoritative final delivery, cosmetic draft fallback,
topics, media/upload, retry/connectivity, and cancellation contracts; it does
not opt into new Bot API product features.

In Telegram DMs, streaming text uses one stable nonzero draft ID and refreshes
the latest visible snapshot every 25 seconds during quiet tool gaps, before
Telegram's 30-second draft expiry. Unchanged ordinary deltas are deduplicated,
while the configured periodic typing indicator remains active for the whole
turn as a fallback when drafts fail or are rate-limited. Draft publication is
held while trimmed output could still be the leading `NO_REPLY` sentinel;
disambiguated text such as `NO_REPLY_EXTRA` streams normally, and completed
leading or trailing sentinel responses remain suppressed.

Long draft snapshots retain the current response tail, stay within Telegram's
message bound, and do not split UTF-16 surrogate pairs. HTML entity or length
rejections use the same narrow bounded plain-text fallback as final messages.
At settlement, future cosmetic draft work stops and the one in-flight draft is
allowed up to three seconds to finish naturally before a hung request is
aborted. The authoritative final `sendMessage` still runs exactly once after
that bounded wait. Groups and other non-DM delivery are unchanged, and this
contract does not adopt Bot API 10.2 empty-text “Thinking…” drafts or rich
message drafts.

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

### Codex web search and direct URL workflows

The package registers one model-facing `web_search` tool. Its wrapper obtains
the refreshed OAuth credential and active `openai-codex` model from Pi's model
registry, then sends one bounded request to the fixed Codex subscription
Responses endpoint. It does not read `OPENAI_API_KEY`, accept a configurable
endpoint, switch providers, retry automatically, or apply a package-specific
search quota.

Interactive sessions, cron runs, package subagents, and ask-agent children each
load the canonical `dist/extensions/pi/web-tools.js` wrapper once.
Dynamic-workflow sessions inherit the same globally deployed wrapper.
Search-only bundled roles keep `web_search` without receiving Bash.

Search queries pass a bounded content-safety check before leaving the host.
Responses expose bounded answer text, citations, web-action metadata, response
identity, and token usage when Codex supplies them; failures return only a fixed
classification without provider bodies or credentials.

Direct URL reading and browser interaction are deliberately outside the package
tool. On macOS, install the official `agent-browser` Homebrew formula globally.
The `read` command requires version 0.30.0 or newer, and browser interaction
requires the one-time Chrome for Testing installation:

```bash
brew install agent-browser
agent-browser install
agent-browser --version
agent-browser doctor
```

Treat `agent-browser` upgrades as manual, planned host maintenance. Upgrade the
Homebrew formula intentionally, rerun the doctor check, and do not use
`brew pin`:

```bash
brew upgrade agent-browser
agent-browser doctor
```

Bash-capable full agents then use the host-installed CLI:

```bash
agent-browser skills get core --full
agent-browser read https://example.com
agent-browser open https://example.com
agent-browser snapshot
agent-browser close
```

Roles without Bash remain search-only. Codex subscription limits continue to be
reported by the package quota sampler and `/status`; there is no separate
provider credit monitor, incident outbox, billing path, or provider-specific
Prometheus metric family for web search.

### Cron delivery targets

Each cron may set `deliveryChatId` and, when needed, `deliveryThreadId` in its
cron definition. When `deliveryChatId` is omitted, the runner uses the top-level
`defaultDeliveryChatId`; `defaultDeliveryThreadId` is inherited only when the
cron targets that default chat. A cron-level thread always takes precedence.
Set top-level `adminChatId` to receive a failure notification when delivery to
the cron target fails.

```yaml
adminChatId: <admin-chat-id>
defaultDeliveryChatId: <default-chat-id>
defaultDeliveryThreadId: <positive-topic-id>
```

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
handle cancellation or provide a noninteractive path. Pi 0.82.1 does not bind
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

Archive and restore are reversible managed moves. Archiving
`wiki/pages/<type>/<path>.md` preserves its serialized bytes at
`artifacts/knowledge-archive/wiki/pages/<type>/<path>.md`, removes the active
page from `wiki/index.md` and default search, and returns both paths. Restoring
uses the same original `wiki/pages/**` path to move those bytes back into the
active corpus. The helper rejects missing sources, symlinks, path escapes, and
occupied or duplicate active/archive destinations instead of overwriting
either copy. When first-party Pi extensions are enabled, their integrity guard
also blocks direct write, edit, and mutating shell access to both
`wiki/pages/**` and `artifacts/knowledge-archive/**`; use `knowledge update`
for either side of the managed move. Explicitly destructive recursive,
archive-extraction, and worktree-mutating Git operations are also blocked when
they target an ancestor containing either managed tree. Read-only commands and
mutations confined to unrelated subdirectories remain available.

### Knowledge Git synchronization

`minime-bot knowledge sync` is a coordination mechanism for a trusted,
cooperative agent in a single-user workspace. The Pi protection and managed
command provide safe defaults and actionable errors; they are not an access
control boundary against another process running as the same user.

The command accepts only a Knowledge v2 agent workspace that is itself the Git
root, is on local `main`, has a clean worktree containing only committed input,
and has an `origin/main`. It fetches `origin/main`, prepares divergent merges in
a temporary detached worktree, validates the complete Knowledge corpus, and
fast-forwards canonical `main` only after validation. It then pushes and verifies
that local and remote `main` are equal. The command never loads control-workspace
secrets and does not force-push, reset, rebase, or select a silent winner.
Git command output is bounded at 64 MiB; an overflow fails without echoing the
captured Knowledge content.

For paths changed on both sides, sync accepts only Git's standard text or binary
merge behavior. It rejects `union` and custom merge drivers, configured
overrides of the built-in `text` and `binary` driver names, and other settings
that can hide conflicts. Sync also rejects Git check-in transformations on any
managed Knowledge file, including clean filters, `ident`,
`working-tree-encoding`, and `text`/`eol` attributes, because they can alter
committed variants. Remove the transformation before retrying.

Before convergence, both observed tips are retained under synthetic refs such as
`refs/minime/knowledge-sync/recovery/local-<commit>` and
`refs/minime/knowledge-sync/recovery/remote-<commit>`. Sync temporary worktrees
are removed only after local and remote `main` are verified equal. Recovery refs
are removed only after both observed tips are reachable from that canonical
commit; a failed or interrupted convergence retains recovery state for an
idempotent retry.

Git handles ordinary three-way merges first. A conflicting managed page becomes
one schema-valid unresolved page containing both complete committed variants,
their source commit IDs, an explicit unresolved body marker, and `revisit_if`
review guidance. `wiki/index.md` is regenerated from every active page and both
structural-log histories are retained. Conflicts outside managed Knowledge, or
unsupported schema, issues, and archive conflicts, stop without changing
canonical `main`.

Use `knowledge update` to create, edit, archive, or restore managed pages, commit
those changes normally, and use `knowledge sync` to reconcile committed history.
When the first-party Pi extension is enabled, direct managed writes and raw Git
worktree commands such as `merge`, `pull`, `rebase`, `cherry-pick`, `checkout`,
`switch`, and destructive `reset`, `restore`, or `clean` remain blocked.

Every committed modifying operation appends a structural entry to
`wiki/log.md`: `create`, `update`, `archive`, or `restore`. An upsert records
the create/update action it actually performed. Entries retain the original
page path; archive and restore entries also identify the mechanical archive
path. Failed or rolled-back operations do not append log entries, and the log
does not contain page bodies.

`knowledge maintain` implements a fixed policy intended for a parent-owned
weekly schedule:

- It measures the raw `wiki/index.md` size first. At or below 40 KiB (40960
  bytes), it does no candidate scan or mutation and emits no stdout by default.
- Above 40 KiB, it considers only project pages named for completed process
  records: `release-YYYY-M-PATCH.md` (the package CalVer page convention) or
  `issue-N.md` / `issue-N-<safe-slug>.md`. Release records are treated as
  completed; issue records require `N` in the caller-supplied positive-integer
  JSON array passed with `--closed-issues`. The package does not fetch issue
  state. Record age comes from `mtime`, not from interpreting a filename suffix
  as a calendar completion date.
- A candidate must have been unmodified for at least 30 days. Filesystem
  `mtime` is the conservative age clock, so any recent edit restarts the wait.
  A page containing the optional `revisit_if` frontmatter field is treated as
  mixed/current and skipped.
- Eligible pages are archived oldest first, with path as the deterministic
  tie-breaker, until the regenerated index is at or below 30 KiB (30720 bytes)
  or eligible pages are exhausted. The watermarks and age cannot be overridden.

Use `--json` to print the bounded maintenance manifest. `--report` writes the
same fixed-schema evidence to a contained workspace JSON path outside
`wiki/**` and `artifacts/knowledge-archive/**`; requesting a report also makes
an otherwise quiet run print its summary. The manifest reports before/after
bytes, archived and skipped counts, bounded paths/errors, stop reason, and
whether mutation occurred.

Closed-issue evidence accepts at most 1,000 array entries. A manifest retains
at most 100 archived paths and 20 errors (each error message is at most 240
characters); `archivedPathsOmitted` and `errorsOmitted` report additional
entries. `stopReason` is one of `below-high-watermark`,
`low-watermark-reached`, `eligible-exhausted`, or `unsafe-failure`. An
`unsafe-failure` manifest is still emitted or reported as requested, but the
CLI exits with status 1 so scheduled callers can alert on incomplete scans or
unverified state changes.

A one-time cleanup is deliberately separate from periodic maintenance:
operators review completed dated pages and invoke explicit installed
`knowledge update --op archive` operations for the selected original paths.
There is no force flag that weakens the fixed 40 KiB/30 KiB/30-day maintenance
policy. Production selection, scheduling, and private cron configuration stay
outside this public package.

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

Ordinary Telegram inputs received during an active Pi turn remain bot-owned
queue entries until a first-party Pi lifecycle gate atomically accepts and
enqueues the exact correlated correction. The queue offers entries serially in
arrival order: matching enqueue acceptance opens the next offer so Pi's
configured steering mode can group already-waiting corrections, but ownership
does not transfer yet. Only the matching consumption result transfers that
exact entry to Pi and removes it from fallback collection. Rejection, write or
child failure, or turn settlement before consumption leaves it for the existing
ordered follow-up drain. This keeps the process-lifetime
no-known-loss/no-duplicate boundary without an independent acknowledgement
timeout or retry loop. When first-party Pi extensions are deliberately
disabled, the queue uses fallback instead of attempting acknowledged steering.
Acknowledged media keeps session-lifetime file ownership, while fallback and
dropped entries retain their existing cleanup behavior.

The acknowledged path applies to text (including source, reply, and forward
framing), voice transcripts, photos, documents, supported media, and reaction
context. Both `/reconnect` and `/clean` explicitly clear pending and mid-turn
queue entries, including an acknowledgement currently in flight, and late
results cannot restore those dropped entries. `/reconnect` preserves stored
conversation state; `/clean` deletes it.

Native Pi steering takes effect after the current complete tool-call batch and
before the next model call; it does not interrupt a running tool or its sibling
calls. The child lifecycle gate remains available through retry backoff,
compaction, and queued continuations until `agent_settled`. Pi's configured
steering mode remains authoritative. Telegram's idle 3-second debounce, queue
cap and saturation policy, permanent final delivery, and outbox behavior are
unchanged.

In Telegram DMs, native draft streaming pauses for the current relay as soon as
another authenticated message enters the same chat topic. This cosmetic pause
does not change steering or final delivery: consumed steering continues in the
current Pi turn without reactivating the draft, including across queued-response
resets. If steering is rejected or remains unconsumed, the ordered fallback runs
after the current relay settles; that independent relay may stream a fresh
draft. Passive echo and shutdown steering remain best-effort, and Discord
message-queue behavior is unchanged.

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

Polling failure recovery depends on the active conversational platforms. A
Telegram-only deployment with Telegram agent bindings exits for supervisor
restart. When Discord has live agent bindings, the process keeps Discord online,
waits for grammY's final Telegram polling cleanup to settle, and retries Telegram
after exponential delays from five seconds up to one minute; all `getUpdates`
calls, including the signal-less final update-offset confirmation, are bounded
at 45 seconds. A successful polling-loop request resets that delay. A started
transport counts only when it has conversational bindings.

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

The bot and cron launch wrappers prefer the stable official Node runtime at
`$HOME/.minime/runtime/node`, with their existing PATH behavior as a fallback.
See [Official Node launch runtime](docs/launchd-operations.md#official-node-launch-runtime)
for the checksum- and signature-verified install, upgrade, process verification,
rollback, and manual TCC consent procedure.

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

Ordinary installations should omit `--run-cron-script`; cron plists then use
the package's `scripts/run-cron.sh`. A deployment that atomically switches
between release slots may preserve its stable selector path during cron-only
sync, including dry-run, with an explicit override:

```bash
minime-bot launchd crons sync --workspace /path/to/control-workspace \
  --run-cron-script /path/to/deployment/current/scripts/run-cron.sh
```

The override is deliberately narrow. It must be a normalized absolute path to
an existing regular file named `run-cron.sh`, with owner read and execute bits.
A direct path's containing directory and file must be current-user owned and
not group/world writable. At most one current-user-owned directory symlink is
allowed; its target must stay below its parent trust directory, and that trust
directory, the resolved directories, and the file must meet the same ownership
and mode rules. Ancestors of the containing or trust directory must be owned by
root or the current user and must not be group/world writable; writable sticky
ancestors are allowed when their path entry is root/current-user owned. Invalid
overrides fail before plist writes or launchd commands.
The validated lexical path is retained in the plist so an atomic `current`
selector can switch slots without rewriting cron plists.

Programmatic callers of `generateLaunchdCronPlists()`,
`writeLaunchdCronPlists()`, `planLaunchdCronSync()`, and `syncLaunchdCrons()`
may pass the same path as `runCronScript`. Explicit API values use the same
validation and lexical-path behavior as the CLI option and fail before cron
loading or side effects.

The sync command owns only the `ai.minime.cron.*` namespace. By default it
creates or updates active cron plists, lint-checks changed plists, re-bootstraps
changed active cron labels, and prunes stale or disabled owned cron plists by
booting them out, retiring that cron's exact terminal `.exit.prom` and
`.success.prom` snapshots after proving it inactive, and deleting the plist
without bootstrapping it again. Dry-run reports the planned retirement without
deleting metrics. `--no-prune` leaves stale owned cron plists and terminal
metrics in place for emergency/manual operation. `--launch-agents-dir`
overrides the default `~/Library/LaunchAgents` target. Cron sync must not
bootout, bootstrap, signal, or otherwise restart `ai.minime.telegram-bot`.

Planning uses byte identity as a fast path. If an existing plist has different
bytes, the configured `plutil` converts the existing file and desired in-memory
content to JSON for a deep value comparison, then checks the existing plist's
read-only XML conversion so integer/real type drift is not erased by JSON.
Formatting and dictionary key order do not cause updates; array order and
scalar, runner, or schedule changes do. Parsing is fail-closed: startup, exit,
or malformed conversion output plans `update` without exposing parser output,
plist contents, or paths.

Dry-run may perform that read-only parser comparison, with desired content sent
on standard input, but creates no temporary files or directories and performs
no writes, plist lint, launchctl calls, or other state mutation.

Each completed new logical cron run updates atomic node-exporter textfile
snapshots with a bounded `cron` label. The terminal snapshot contains exit
state, both counters, and the last-run timestamp; the separate success
timestamp snapshot changes only after success:

- `minime_cron_last_exit_code{cron}` is the latest terminal exit state;
- `minime_cron_last_success_timestamp{cron}` changes only after success;
- `minime_cron_runs_total{cron,outcome="success|failure"}` counts exactly one
  closed outcome per logical invocation and survives normal runner restarts;
- `minime_cron_last_run_timestamp_seconds{cron}` records the latest terminal
  classification time.

The runner writes these snapshots to
`/opt/homebrew/var/node_exporter/textfile` by default.
`CRON_HEALTH_TEXTFILE_DIR` overrides that location; it must be writable by the
runner and match the directory collected by node-exporter. Canonical cron sync
persists an explicit selection in generated plists and uses that persisted
directory when retiring a stale or disabled cron's exact snapshots.

Terminal metric persistence is fail-closed: a directory, lock, state-read, or
snapshot-write failure is reported on standard error and leaves the runner
non-zero instead of silently completing against an older snapshot.

LLM crons receive a package-owned instruction allowing the exact standalone
final non-empty line `[[MINIME_CRON_UNRESOLVED_V1]]`. The runner strips that
line from delivery, delivers any clean report through the ordinary
retry/outbox path, and then records a non-zero logical failure. Embedded,
quoted, repeated, or non-final marker-like text is ordinary output, and script
cron output is never interpreted as this marker.

Execution failures no longer send a direct generic `Cron FAIL` message or
create a failure-notice outbox entry. Prometheus and Alertmanager own terminal
incident grouping, repeats, and recovery. Bounded diagnostics remain in the
local cron log, while the existing admin fallback for a delivery-path failure
is unchanged. On upgrade, an old queued `failure-notice` record is discarded
without delivery.

Cron delivery is pickup-first. At the start of each scheduled invocation, the
runner tries to deliver any result owed by that cron before generating new
output. After bounded in-process delivery retries fail, it stores the exact
generated output in one atomic, durable outbox slot per cron. A queueable
pickup failure stops the invocation before generation, so a newer result
cannot overwrite the pending one. Redelivery is limited to 10 later attempts
and a 48-hour lifetime. Queue, redelivery, deferral, and terminal decisions are
recorded as `OUTBOX` lines in `cron-<name>.log`.

Pickup-only outbox preflight failures and deferred redelivery attempts do not
start a new logical cron run, so they do not change terminal metrics or
counters. Their non-zero process exit and `OUTBOX` log lines remain the
diagnostic evidence.

Delivery has at-least-once, not exactly-once, semantics: a process crash after
the chat accepts a message but before the outbox record is cleared can produce
a duplicate, including for multi-chunk messages. Recovery occurs only on the
same cron's next scheduled invocation; there is no background sweeper or
receipt-based deduplication. Pending records for crons that are disabled or
removed remain inert, inspectable files until an operator handles them.

See [Cron delivery outbox](docs/launchd-operations.md#cron-delivery-outbox) for
the record location and safe handling guidance.

### Host-native monitoring

The package also ships a Python-standard-library Telegram sender, loopback
Alertmanager webhook, and one-shot runtime doctor. They do not load Node or
package JavaScript, and the doctor can report failures of the container
monitoring stack itself. See [Host-native monitoring and Telegram alerts](docs/monitoring.md)
for prerequisites, configuration, installation, validation, diagnostics, and
rollback.

The webhook can optionally verify current Alertmanager groups and forward them
to the generic Ops incident intake. Noncritical bridge failures stay quiet and
retryable, relying on separately deduplicated Ops-health escalation instead of
per-group native fallback; required critical dual delivery remains independent.
Direct native Telegram delivery remains the default.

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

For a focused test run, pass one or more test paths after `--`, for example:

```bash
npm run test:file -- src/__tests__/pi-compaction-retry.test.ts
```

`test:file` forwards those paths to Node's test runner and uses the same
per-test timeout and process-group watchdog as `npm test`.
`npm test` gives each Node test 240 seconds and bounds the complete suite at
30 minutes; CI adds a 35-minute outer job limit. On a suite timeout, the
watchdog reports the stage, command, elapsed time, and live process-group
evidence, exits with status 124, and cleans the group with bounded `SIGTERM`
then `SIGKILL`. For focused runs, set `MINIME_TEST_SUITE_TIMEOUT_MS` or
`MINIME_TEST_TERMINATION_GRACE_MS` to a positive millisecond value no greater
than 2,147,483,647, and use `MINIME_TEST_STAGE` to label diagnostics.

Changes should land through pull requests. Do not push directly to `main`.
