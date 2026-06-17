# Launchd Operations

This package owns public launchd behavior for the bot service restart helper
and packaged cron schedule sync. Private deployment wrappers can call these
interfaces, but private launch state and production configuration stay outside
this repository.

## Self-safe bot restart

`scripts/restart-bot.sh --plist` is the canonical launchd restart path. It is
safe to invoke from a live bot or Pi turn because it schedules an independent
one-shot launchd supervisor and returns before `ai.minime.telegram-bot` is
stopped.

The request path:

- validates the target bot plist before any service teardown;
- validates the current control workspace config;
- writes a one-shot supervisor plist using the fixed label
  `ai.minime.telegram-bot.restart-supervisor`;
- serializes the required context into the supervisor plist, including
  `BOT_PLIST`, `BOT_LABEL`, launchd domain details, workspace root, `HOME`,
  `PATH`, request id, status path, log path, and worker arguments;
- lint-checks the generated supervisor plist with `plutil -lint`;
- best-effort bootouts any existing supervisor registration for the fixed label;
- bootstraps the supervisor and exits after printing request, status, and log
  details.

The worker path then performs the actual launchd unregister/register sequence
outside the original bot process. It waits a bounded not-before delay, validates
again before `bootout`, waits for launchd teardown, bootstraps the bot plist,
waits for a running PID, and writes minimal status/log records.

Shell detach is not used for the self-restart contract. A detached shell
started by a live bot process can still depend on the process tree, session, or
environment that launchd is about to tear down. A launchd-owned one-shot helper
has an independent lifecycle, gives the restart request a stable label, and
lets repeated requests clean up stale helper registrations with `bootout`.

The package intentionally does not add custom restart lock files in this MVP.
The fixed supervisor label plus best-effort supervisor `bootout` is the only
stale-helper cleanup contract. If a richer concurrency protocol is needed later,
it should preserve the default self-safe `--plist` behavior.

## Foreground worker mode

Foreground worker mode exists for operator debugging:

```bash
scripts/restart-bot.sh --worker --plist
scripts/restart-bot.sh --foreground --plist
```

It runs the same launchd `bootout`/`bootstrap` sequence in the caller's process
instead of scheduling the one-shot supervisor. This is not the default because a
foreground restart invoked from inside the bot can be interrupted when the bot
service is stopped.

Pi child processes receive `MINIME_BOT_PI_SESSION=1`. When that marker is set,
foreground worker mode refuses to run unless
`MINIME_RESTART_UNSAFE_FOREGROUND=1` is also set. In-bot restart actions should
call `scripts/restart-bot.sh --plist` without `--worker`.

## Cron launchd sync

Cron launchd sync is a package CLI operation:

```bash
minime-bot launchd crons sync --workspace /path/to/control-workspace --dry-run
minime-bot launchd crons sync --workspace /path/to/control-workspace
minime-bot launchd crons sync --workspace /path/to/control-workspace --no-prune
minime-bot launchd crons sync --workspace /path/to/control-workspace --launch-agents-dir /tmp/LaunchAgents
```

`--dry-run` computes create, update, delete, and rebootstrap actions without
writing plists or calling launchctl. The default non-dry-run mode writes active
cron plists, lint-checks changed plists, bootouts changed active cron labels,
and bootstraps them into the current user launchd domain.

Prune is enabled by default for the package-owned `ai.minime.cron.*` namespace.
Pruning means a stale or disabled owned cron label is booted out, its plist is
deleted, and it is not bootstrapped again. `--no-prune` is an escape hatch for
manual recovery or phased operations where existing owned cron plists should be
left alone temporarily.

Cron sync never owns the bot service label. It must not bootout, bootstrap,
kill, signal, or otherwise restart `ai.minime.telegram-bot`.

## Cron deploy versus bot restart

Cron prompt and timeout changes are runtime config changes, not bot restart
events. `scripts/run-cron.sh` invokes the package cron runner for the selected
task, and the runner loads the merged workspace `crons.yaml` and
`crons.local.yaml` at each cron execution.

Use cron launchd sync only when launchd schedule materialization needs to
change, such as adding a cron, disabling a cron, removing a cron, or changing
the expression that becomes `StartCalendarInterval` or `StartInterval`.
Changing prompt text, timeout values, or other per-run cron behavior does not
require restarting `ai.minime.telegram-bot`.
