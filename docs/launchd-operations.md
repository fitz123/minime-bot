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
  `ai.minime.telegram-bot.restart-supervisor` under the restart runtime
  directory by default, not under `~/Library/LaunchAgents`;
- serializes the required context into the supervisor plist, including
  `BOT_PLIST`, `BOT_LABEL`, launchd domain details, workspace root, `HOME`,
  `PATH`, request id, status path, log path, and worker arguments;
- lint-checks the generated supervisor plist with `plutil -lint`;
- refuses to replace a running supervisor for the fixed label;
- best-effort bootouts a stale stopped supervisor registration for the fixed
  label;
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
The fixed supervisor label plus active-helper refusal and stale-helper
best-effort `bootout` is the only cleanup contract. If a richer concurrency
protocol is needed later, it should preserve the default self-safe `--plist`
behavior.

Operator environment knobs:

- `RESTART_RUNTIME_DIR` changes the default directory for supervisor plist,
  status, and log files. The default is `~/Library/Logs/minime-bot/restart`.
- `RESTART_SUPERVISOR_PLIST` overrides only the helper plist path. The helper
  label remains fixed as `ai.minime.telegram-bot.restart-supervisor`.
- `RESTART_STATUS_PATH` and `RESTART_LOG_PATH` override the request status and
  log paths.
- `RESTART_WORKER_NOT_BEFORE_DELAY` controls the worker's bounded delay before
  bot `bootout`; `RESTART_MAX_WORKER_NOT_BEFORE_DELAY` caps that delay.

The `--request-id`, `--status-path`, and `--log-path` flags are supervisor
automation arguments used when request mode launches worker mode. Operators
should normally call `scripts/restart-bot.sh --plist` without these flags.

## Official Node launch runtime

`scripts/start-bot.sh` and `scripts/run-cron.sh` prefer
`$HOME/.minime/runtime/node/bin/node` before the package's existing PATH
fallbacks. `MINIME_NODE_RUNTIME_ROOT` is the narrow override for an isolated
test or a deliberately non-default installation. Do not use it as an automatic
version selector: upgrades should replace the verified tree at one stable
runtime root.

Use only an official macOS archive from `nodejs.org`. Choose a supported Node
release that satisfies `package.json`'s `engines.node` range and the host
architecture. Pin the complete version for each maintenance operation; do not
resolve `latest` during activation. Map Apple silicon (`arm64`) to
`darwin-arm64` and Intel (`x86_64`) to `darwin-x64`. Run every block through
activation in the same Bash shell; the fail-fast settings in the first block
must remain active, and any non-zero command means stop rather than continuing
to a later block:

```bash
set -euo pipefail
umask 077
RUNTIME_BASE="${HOME:?HOME must be set}/.minime/runtime"
STABLE_NODE="$RUNTIME_BASE/node"
NODE_VERSION=vX.Y.Z
test "$NODE_VERSION" != vX.Y.Z

case "$(uname -m)" in
  arm64) NODE_PLATFORM=darwin-arm64 ;;
  x86_64) NODE_PLATFORM=darwin-x64 ;;
  *) echo "unsupported macOS architecture" >&2; exit 1 ;;
esac

NODE_ARCHIVE="node-${NODE_VERSION}-${NODE_PLATFORM}.tar.gz"
install -d -m 700 "$RUNTIME_BASE"
STAGE_DIR="$(mktemp -d "$RUNTIME_BASE/.node-stage.XXXXXX")"
cd "$STAGE_DIR"
curl --fail --location --proto '=https' --tlsv1.2 \
  --remote-name "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
curl --fail --location --proto '=https' --tlsv1.2 \
  --remote-name "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}"
```

Replace `vX.Y.Z` before running the commands. Keep the staging directory
owner-only and abort on any failed check. Select the archive's exact entry from
the official `SHASUMS256.txt`, require exactly one match, and verify it before
extraction:

```bash
awk -v name="$NODE_ARCHIVE" '$2 == name { print }' \
  SHASUMS256.txt > SHASUMS256.selected
test "$(wc -l < SHASUMS256.selected | tr -d ' ')" = 1
shasum -a 256 -c SHASUMS256.selected

tar -xzf "$NODE_ARCHIVE"
STAGED_TREE="$STAGE_DIR/${NODE_ARCHIVE%.tar.gz}"
STAGED_NODE="$STAGED_TREE/bin/node"
test -x "$STAGED_NODE"
```

Verify the extracted executable with macOS's trust tools. The explicit
requirement authenticates the Apple Developer ID chain, Node identifier, and
expected Node.js team rather than trusting identity metadata supplied by the
candidate signature itself. `codesign` validation must succeed, and its
reported identity must also contain the exact standalone lines
`Identifier=node` and `TeamIdentifier=HX7739G8FX`. Reject a Homebrew dependency
and any other dependency outside the macOS system library roots:

```bash
NODE_REQUIREMENT='=identifier "node" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "HX7739G8FX"'
codesign -v --strict -R "$NODE_REQUIREMENT" "$STAGED_NODE"
codesign -dv --verbose=4 "$STAGED_NODE" 2> codesign-details.txt
grep -Fx 'Identifier=node' codesign-details.txt
grep -Fx 'TeamIdentifier=HX7739G8FX' codesign-details.txt

otool -L "$STAGED_NODE" > node-dependencies.txt
if grep -Fq '/opt/homebrew/' node-dependencies.txt; then
  echo "refusing Node with Homebrew dependencies" >&2
  exit 1
fi
if tail -n +2 node-dependencies.txt | awk '{print $1}' \
  | grep -Ev '^(/usr/lib/|/System/Library/)'; then
  echo "refusing Node with non-system dependencies" >&2
  exit 1
fi
```

Only after every check passes, move the staged tree next to the stable path.
Refuse an unexplained stale `node.next`; inspect and remove it separately
rather than overwriting it during this procedure.

```bash
NEXT_NODE="$RUNTIME_BASE/node.next"
test ! -e "$NEXT_NODE"
mv "$STAGED_TREE" "$NEXT_NODE"
cd "$HOME"
rm -rf "$STAGE_DIR"
test -x "$NEXT_NODE/bin/node"
```

For activation, preserve at most one rollback tree. A fresh install has no
current `node`; an upgrade moves the current verified tree to `node.rollback`
before putting `node.next` at the stable path. Run these commands as the
launchd user:

```bash
if test -e "$STABLE_NODE"; then
  rm -rf "$RUNTIME_BASE/node.rollback"
  mv "$STABLE_NODE" "$RUNTIME_BASE/node.rollback"
fi
if ! mv "$NEXT_NODE" "$STABLE_NODE"; then
  if test -d "$RUNTIME_BASE/node.rollback" && test ! -e "$STABLE_NODE"; then
    mv "$RUNTIME_BASE/node.rollback" "$STABLE_NODE"
  fi
  exit 1
fi
```

Restart the bot only through the canonical package helper. Its default
`--plist` request returns after scheduling the one-shot supervisor, so poll the
request's status file with a bounded deadline before inspecting the process.
The helper below fails on an explicit worker failure or after four minutes and
prints the terminal status as evidence:

```bash
restart_and_wait() {
  local package_root="$1"
  local request_id="node-runtime-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
  local restart_dir="$HOME/Library/Logs/minime-bot/restart"
  local status_path="$restart_dir/${request_id}.status"
  local log_path="$restart_dir/${request_id}.log"
  local deadline status

  (
    cd "$package_root"
    scripts/restart-bot.sh --plist \
      --request-id "$request_id" \
      --status-path "$status_path" \
      --log-path "$log_path"
  )

  deadline=$((SECONDS + 240))
  while :; do
    status=""
    if test -f "$status_path"; then
      status="$(awk -F= '$1 == "status" { print $2 }' "$status_path")"
    fi
    case "$status" in
      success) break ;;
      failure)
        grep -E '^(requestId|status|error)=' "$status_path" >&2
        return 1
        ;;
    esac
    if test "$SECONDS" -ge "$deadline"; then
      echo "timeout waiting for restart request $request_id" >&2
      return 1
    fi
    sleep 1
  done
  grep -E '^(requestId|newPid|status)=' "$status_path"
}

PACKAGE_ROOT=/path/to/installed/minime-bot
restart_and_wait "$PACKAGE_ROOT"
BOT_LABEL=ai.minime.telegram-bot
BOT_PID="$(launchctl print "gui/$(id -u)/$BOT_LABEL" \
  | awk '/pid = / { print $3; exit }')"
test -n "$BOT_PID"
lsof -a -p "$BOT_PID" -d txt -Fn \
  | grep -Fx "n$RUNTIME_BASE/node/bin/node"
```

The cron wrapper uses the same stable runtime on its next launch. A deliberate
non-default `MINIME_NODE_RUNTIME_ROOT` must also be present in the bot launchd
environment; launchd cron sync preserves the variable in generated cron
plists.

If bot startup or verification fails, start a fresh Bash shell, enable
fail-fast mode, and re-enter the `restart_and_wait` function above. Then move
the failed tree aside. An upgrade restores `node.rollback`; a fresh
installation has no rollback tree, so leaving the stable path absent restores
the existing PATH fallback. Delete the failed tree only after the replacement
or fallback process is running and verified:

```bash
set -euo pipefail
RUNTIME_BASE="${HOME:?HOME must be set}/.minime/runtime"
STABLE_NODE="$RUNTIME_BASE/node"
ROLLBACK_NODE="$RUNTIME_BASE/node.rollback"
FAILED_NODE="$RUNTIME_BASE/node.failed"
PACKAGE_ROOT=/path/to/installed/minime-bot

test -x "$STABLE_NODE/bin/node"
test ! -e "$FAILED_NODE"
mv "$STABLE_NODE" "$FAILED_NODE"
if test -e "$ROLLBACK_NODE"; then
  test -x "$ROLLBACK_NODE/bin/node"
  if mv "$ROLLBACK_NODE" "$STABLE_NODE"; then
    EXPECTED_NODE="$STABLE_NODE/bin/node"
  else
    mv "$FAILED_NODE" "$STABLE_NODE"
    exit 1
  fi
else
  EXPECTED_NODE=""
fi

restart_and_wait "$PACKAGE_ROOT"
BOT_LABEL=ai.minime.telegram-bot
BOT_PID="$(launchctl print "gui/$(id -u)/$BOT_LABEL" \
  | awk '/pid = / { print $3; exit }')"
test -n "$BOT_PID"
LIVE_NODE="$(lsof -a -p "$BOT_PID" -d txt -Fn \
  | awk '/^n/ { print substr($0, 2); exit }')"
test -n "$LIVE_NODE"
if test -n "$EXPECTED_NODE"; then
  test "$LIVE_NODE" = "$EXPECTED_NODE"
else
  test "$LIVE_NODE" != "$FAILED_NODE/bin/node"
fi
printf 'live_node=%s\n' "$LIVE_NODE"
rm -rf "$FAILED_NODE"
```

### TCC consent boundary

Consent for a protected macOS resource is a one-time manual operator action
through the system prompt or System Settings for the exact required resource.
The package, installation procedure, and operators must never read, edit, or
write the TCC database directly. They must not attempt to pre-seed consent.

Keeping the stable path and the official Node signing identity is intended to
preserve an existing grant across a verified official Node upgrade, but it is
not an unconditional guarantee. An OS or privacy-settings reset, an upstream
certificate, TeamIdentifier, or designated-requirement change, certificate
revocation, and manual revocation of the TCC grant are outside that survival
guarantee. If macOS requests consent after one of those events, stop and
perform the exact manual consent action again.

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

## Cron delivery outbox

When delivery retries are exhausted, the cron runner stores the exact owed
message under `<control-workspace>/data/cron-outbox/`. The directory and its
hashed per-cron JSON records are owner-only. An enabled cron normally consumes
only its own record at the start of its next invocation; no background process
redelivers or garbage-collects records.

Records for disabled or removed crons remain inert. Inspect a record before
manually removing it so the owed payload, target, run identity, age, and attempt
count are understood. Removing a record discards that pending delivery; retain
it if the cron will be re-enabled and should perform the normal pickup.

## Cron launchd sync

Cron launchd sync is a package CLI operation:

```bash
minime-bot launchd crons sync --workspace /path/to/control-workspace --dry-run
minime-bot launchd crons sync --workspace /path/to/control-workspace
minime-bot launchd crons sync --workspace /path/to/control-workspace --no-prune
minime-bot launchd crons sync --workspace /path/to/control-workspace --launch-agents-dir /tmp/LaunchAgents
```

`--dry-run` computes create, update, delete, and rebootstrap actions without
writing plists or calling launchctl. Planning first treats byte-identical
existing and desired plists as unchanged. When their bytes differ, it converts
both plists to JSON with the configured `plutil` and compares their parsed
values. The existing plist is read from its path, while the desired in-memory
plist is sent on standard input. After equal JSON values, a read-only XML
conversion of the existing plist preserves the integer/real distinction that
JSON numbers erase. Dictionary key order and XML formatting are therefore
ignored, but array order, scalar types, runner paths, and schedules remain
significant.

This semantic comparison is the only command boundary used by dry-run. It uses
`plutil -convert json -o -` and, after equal values, `-convert xml1 -o -` for
read-only output and creates no temporary files or directories. A parser
startup, exit, or malformed-output failure conservatively plans the plist as
`update`; parser output, plist contents, and paths are not included in planning
output. Dry-run still performs no writes, plist lint, launchctl calls, or other
state mutation. The default non-dry-run mode writes active cron plists,
lint-checks changed plists, bootouts changed active cron labels, and bootstraps
them into the current user launchd domain.

Before mutating a created, updated, or deleted cron, sync checks its launchd activity.
A loaded job with a reported PID is active; an exit-zero result without a PID
is idle, and launchd's known service-not-found response means not loaded. Active
jobs are deferred without writing or deleting their plist and without calling
`bootout`. Any unrecognized response, command error, or missing output is also
deferred as activity unknown. The command reports the deferral and continues
with other items. Re-run sync after the job finishes to converge the deferred
item; sync does not schedule that follow-up automatically, so the previous
schedule remains live until then.

After a safe update is booted out, replacement bootstrap retries transient
launchd removal/registration races up to five total attempts, waiting 500 ms
between attempts. The same bounded retry applies when a failed replacement
requires the previous plist to be restored and bootstrapped.

Prune is enabled by default for the package-owned `ai.minime.cron.*` namespace.
Pruning means a stale or disabled owned cron label is booted out, its plist is
deleted, and it is not bootstrapped again. `--no-prune` is an escape hatch for
manual recovery or phased operations where existing owned cron plists should be
left alone temporarily.

Cron sync never owns the bot service label. It must not bootout, bootstrap,
kill, signal, or otherwise restart `ai.minime.telegram-bot`.

### Package-owned bot release slots

`scripts/bot_slots.py` manages immutable local bot release copies independently
of the restart helper:

```text
/path/to/bot-slots/
  releases/<release-id>/
  current -> releases/<release-id>
  previous -> releases/<release-id>
  state/active.json
```

`scripts/assemble_bot_package.py` first copies the package and its complete
installed dependency closure into a self-contained source without network
access. Stage copies that source into a temporary release directory, writes and
re-verifies its bounded SHA-256 manifest, and publishes the release with an
atomic rename. Activation and rollback journal their selector transition before
changing `previous` and `current`; the next operation restores the last
committed pair after an interruption. Rollback verifies and selects only the
local `previous` release, so a corrupt `current` does not block recovery. Prune
retains every release referenced by either selector or activation state and
removes abandoned staging directories while holding the slot lock.

```bash
python3 scripts/assemble_bot_package.py \
  --package-root /path/to/node_modules/minime-bot \
  --destination /private/tmp/self-contained-bot
python3 scripts/bot_slots.py stage \
  --slots-root /path/to/bot-slots \
  --source /private/tmp/self-contained-bot \
  --release-id bot-2026.7.28-example
python3 scripts/bot_slots.py activate \
  --slots-root /path/to/bot-slots \
  --release-id bot-2026.7.28-example
python3 scripts/bot_slots.py status \
  --slots-root /path/to/bot-slots --json
python3 scripts/bot_slots.py rollback --slots-root /path/to/bot-slots
python3 scripts/bot_slots.py prune --slots-root /path/to/bot-slots
```

The slot helper does not restart services or rewrite launchd plists. Deployment
wrappers keep those actions separate and continue to use the validated
`restart-bot.sh --plist` path described above.

### Explicit cron runner for atomic release slots

Ordinary installations should not set `--run-cron-script`. When the option is
absent, generated plists continue to invoke the package's
`scripts/run-cron.sh`.

A deployment that maintains immutable release slots behind one atomic directory
selector can preserve that stable lexical runner path during cron-only planning
and sync:

```bash
minime-bot launchd crons sync --workspace /path/to/control-workspace --dry-run \
  --run-cron-script /path/to/bot-slots/current/scripts/run-cron.sh
minime-bot launchd crons sync --workspace /path/to/control-workspace \
  --run-cron-script=/path/to/bot-slots/current/scripts/run-cron.sh
```

Both split and `=` forms are supported. The caller's validated lexical path is
written to every generated cron plist; it is not replaced with the canonical
slot path. An atomic switch of `current` can therefore select a new release
without causing runner-only plist updates.

The override is not a general arbitrary-script hook. Validation requires:

- a normalized absolute path with basename `run-cron.sh`;
- an existing regular final file, not a final-file symlink, readable and
  executable by its owner;
- no symlinks for a direct path, or at most one current-user-owned directory
  symlink for an atomic slot selector;
- a directory-symlink target contained beneath the symlink's parent trust
  directory; and
- for a direct path, current-user ownership and no group/world write bits on
  the containing directory and runner file; or
- for a selector path, those ownership and mode rules on the parent trust
  directory, resolved directories, and runner file. Symlink mode bits are not
  enforced because POSIX systems do not use them for replacement safety; and
- ancestors of the direct containing directory or selector trust directory
  must be root/current-user owned and not group/world writable. Writable sticky
  ancestors are accepted when the protected child entry is root/current-user
  owned.

Escaping, dangling, multi-symlink, wrong-owner, writable-component, missing,
unreadable, non-executable, and incorrectly named paths are rejected. Explicit
override validation happens before cron loading, directory creation, plist
writes, pruning, or `plutil`/`launchctl` execution. Dry-run remains zero-write
and never calls launchctl; when existing plist bytes differ, it may run only the
read-only semantic `plutil` comparison described above.

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
