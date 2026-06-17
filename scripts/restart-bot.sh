#!/bin/bash
# restart-bot.sh — Safely restart the Telegram bot launchd service
# Usage:
#   restart-bot.sh              Graceful SIGTERM restart (code / config.yaml changes)
#   restart-bot.sh --plist      Schedule a self-safe launchd supervisor restart
#   restart-bot.sh --worker --plist
#                               Run unregister + re-bootstrap in the foreground
#   restart-bot.sh -h|--help    Show this help
#
# Never sends SIGKILL. Validates config before restarting. Polls launchd
# teardown so bootout is not raced against bootstrap. The default --plist mode
# is safe to call from inside a live bot/Pi turn because it schedules a one-shot
# supervisor and returns before the bot service is stopped.

set -euo pipefail

if [ -z "${HOME:-}" ]; then
  if command -v dscl >/dev/null 2>&1; then
    HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  fi
fi
if [ -z "${HOME:-}" ]; then
  if command -v getent >/dev/null 2>&1; then
    HOME="$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)"
  fi
fi
export HOME
if [ -z "$HOME" ]; then
  echo "[restart-bot] Error: could not determine HOME from environment or fallback lookups" >&2
  exit 1
fi
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/restart-bot.sh"

LAUNCHCTL_BIN="${LAUNCHCTL_BIN:-/bin/launchctl}"
PLUTIL_BIN="${PLUTIL_BIN:-/usr/bin/plutil}"
BOT_LABEL="${BOT_LABEL:-ai.minime.telegram-bot}"
BOT_PLIST="${BOT_PLIST:-$HOME/Library/LaunchAgents/${BOT_LABEL}.plist}"
BOT_UID="${BOT_UID:-$(id -u)}"
DOMAIN="gui/${BOT_UID}"
SERVICE="${DOMAIN}/${BOT_LABEL}"
RESTART_RUNTIME_DIR="${RESTART_RUNTIME_DIR:-$HOME/Library/Logs/minime-bot/restart}"
RESTART_SUPERVISOR_LABEL="ai.minime.telegram-bot.restart-supervisor"
RESTART_SUPERVISOR_SERVICE="${DOMAIN}/${RESTART_SUPERVISOR_LABEL}"
RESTART_SUPERVISOR_PLIST="${RESTART_SUPERVISOR_PLIST:-$RESTART_RUNTIME_DIR/${RESTART_SUPERVISOR_LABEL}.plist}"
RESTART_REQUEST_ID="${RESTART_REQUEST_ID:-}"
RESTART_STATUS_PATH="${RESTART_STATUS_PATH:-}"
RESTART_LOG_PATH="${RESTART_LOG_PATH:-}"

# Test-only: override the validator with a single executable (no args, no eval).
# Tests set this to `true` / `false` to simulate validation pass / fail paths.
CONFIG_VALIDATE_BIN="${CONFIG_VALIDATE_BIN:-}"

# Timeouts (seconds). Drain window is 60s — give headroom.
SHUTDOWN_TIMEOUT="${SHUTDOWN_TIMEOUT:-90}"
TEARDOWN_TIMEOUT="${TEARDOWN_TIMEOUT:-90}"
STARTUP_TIMEOUT="${STARTUP_TIMEOUT:-60}"
POLL_INTERVAL="${POLL_INTERVAL:-1}"
RESTART_WORKER_NOT_BEFORE_DELAY="${RESTART_WORKER_NOT_BEFORE_DELAY:-2}"
RESTART_MAX_WORKER_NOT_BEFORE_DELAY="${RESTART_MAX_WORKER_NOT_BEFORE_DELAY:-30}"

usage() {
  cat <<EOF
Usage:
  restart-bot.sh              Graceful SIGTERM restart (code / config.yaml changes)
  restart-bot.sh --plist      Schedule self-safe launchd supervisor restart
  restart-bot.sh --worker --plist
                              Run unregister + re-bootstrap in the foreground
  restart-bot.sh --foreground --plist
                              Alias for --worker --plist
  restart-bot.sh -h|--help    Show this help

On graceful/worker success: prints new PID and exits 0.
On scheduled --plist success: prints request/status/log details and exits 0.
On failure: prints a diagnostic and exits non-zero.
EOF
}

log() { echo "[restart-bot] $*"; }
err() { echo "[restart-bot] Error: $*" >&2; }

MODE="graceful"
PLIST_MODE=0
WORKER_MODE=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --plist) PLIST_MODE=1; shift ;;
    --worker|--foreground) WORKER_MODE=1; shift ;;
    --request-id)
      shift
      if [ $# -eq 0 ]; then err "missing value for --request-id"; usage >&2; exit 2; fi
      RESTART_REQUEST_ID="$1"
      shift
      ;;
    --status-path)
      shift
      if [ $# -eq 0 ]; then err "missing value for --status-path"; usage >&2; exit 2; fi
      RESTART_STATUS_PATH="$1"
      shift
      ;;
    --log-path)
      shift
      if [ $# -eq 0 ]; then err "missing value for --log-path"; usage >&2; exit 2; fi
      RESTART_LOG_PATH="$1"
      shift
      ;;
    *) err "unknown argument: $1"; usage >&2; exit 2 ;;
  esac
done

if [ "$PLIST_MODE" -eq 1 ]; then
  if [ "$WORKER_MODE" -eq 1 ]; then
    MODE="plist_worker"
  else
    MODE="plist_request"
  fi
elif [ "$WORKER_MODE" -eq 1 ]; then
  err "--worker/--foreground must be used with --plist"
  usage >&2
  exit 2
fi

# get_pid prints one of:
#   <numeric pid> — service is registered and running
#   ""            — service is registered but has no running process (PID = "-")
# exit status:
#   0 — registered (pid may be empty)
#   1 — not registered (launchctl query succeeded, label absent)
#   2 — launchctl query itself failed (unknown state)
get_pid() {
  local out
  if ! out=$("$LAUNCHCTL_BIN" list 2>/dev/null); then
    return 2
  fi
  local line
  line=$(printf '%s\n' "$out" | awk -v L="$BOT_LABEL" '$3==L { print; exit }')
  if [ -z "$line" ]; then
    return 1
  fi
  local pid
  pid=$(printf '%s\n' "$line" | awk '{print $1}')
  if [ "$pid" = "-" ]; then
    echo ""
  else
    echo "$pid"
  fi
  return 0
}

# True only when launchctl query succeeded AND the service is registered.
# A transient query failure is NOT treated as "registered" or "not registered".
is_registered() {
  local rc=0
  get_pid >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 0 ]
}

wait_until() {
  # wait_until <timeout_seconds> <predicate_fn>
  local timeout="$1"; local pred="$2"
  local deadline
  deadline=$(( $(date +%s) + timeout ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if "$pred"; then
      return 0
    fi
    sleep "$POLL_INTERVAL"
  done
  return 1
}

_old_pid=""
_pred_old_pid_gone() {
  local cur rc=0
  cur=$(get_pid 2>/dev/null) || rc=$?
  case "$rc" in
    0) [ "$cur" != "$_old_pid" ] ;;
    1) return 0 ;;   # explicitly not registered → old pid gone
    *) return 1 ;;   # query failed → unknown, keep polling
  esac
}

# Distinguishes "confirmed not registered" from "query failed", so a transient
# launchctl error can't trick us into bootstrapping over a still-registered svc.
_pred_unregistered() {
  local rc=0
  get_pid >/dev/null 2>&1 || rc=$?
  [ "$rc" -eq 1 ]
}

# Requires a successful query AND a non-empty PID that differs from the old PID,
# so a stale `launchctl list` response can't be mistaken for the new process.
_pred_running_pid() {
  local pid rc=0
  pid=$(get_pid 2>/dev/null) || rc=$?
  [ "$rc" -eq 0 ] && [ -n "$pid" ] && [ "$pid" != "$_old_pid" ]
}

validate_plist() {
  log "Validating plist at ${BOT_PLIST}…"
  if ! "$PLUTIL_BIN" -lint "$BOT_PLIST" >/dev/null 2>&1; then
    err "plist is malformed: $BOT_PLIST"
    err "run: $PLUTIL_BIN -lint \"$BOT_PLIST\" for details"
    return 1
  fi
  local plist_label
  if ! plist_label=$("$PLUTIL_BIN" -extract Label raw "$BOT_PLIST" 2>/dev/null); then
    err "plist is missing 'Label' key: $BOT_PLIST"
    return 1
  fi
  if [ "$plist_label" != "$BOT_LABEL" ]; then
    err "plist Label '$plist_label' does not match expected '$BOT_LABEL'"
    return 1
  fi
}

validate_config() {
  log "Validating config before restart…"
  if [ -n "$CONFIG_VALIDATE_BIN" ]; then
    if ! ( cd "$BOT_DIR" && "$CONFIG_VALIDATE_BIN" >/dev/null 2>&1 ); then
      err "config validation failed; refusing to restart"
      return 1
    fi
    return 0
  fi
  local args=(config validate)
  if [ -n "${MINIME_CONTROL_WORKSPACE_ROOT:-}" ]; then
    args+=(--workspace "$MINIME_CONTROL_WORKSPACE_ROOT")
  fi
  if ! ( cd "$BOT_DIR" && node "$BOT_DIR/dist/cli.js" "${args[@]}" >/dev/null ); then
    err "config validation failed; refusing to restart"
    return 1
  fi
}

iso_now() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

new_request_id() {
  printf 'restart-%s-%s' "$(date -u +"%Y%m%dT%H%M%SZ")" "$$"
}

ensure_restart_paths() {
  if [ -z "$RESTART_REQUEST_ID" ]; then
    RESTART_REQUEST_ID="$(new_request_id)"
  fi
  if [ -z "$RESTART_STATUS_PATH" ]; then
    RESTART_STATUS_PATH="$RESTART_RUNTIME_DIR/${RESTART_REQUEST_ID}.status"
  fi
  if [ -z "$RESTART_LOG_PATH" ]; then
    RESTART_LOG_PATH="$RESTART_RUNTIME_DIR/${RESTART_REQUEST_ID}.log"
  fi
}

ensure_parent_dir() {
  local path="$1"
  local dir
  dir="$(dirname "$path")"
  mkdir -p "$dir"
}

xml_escape() {
  printf '%s' "$1" \
    | sed -e 's/&/\&amp;/g' \
          -e 's/</\&lt;/g' \
          -e 's/>/\&gt;/g' \
          -e 's/"/\&quot;/g' \
          -e "s/'/\&apos;/g"
}

write_plist_string() {
  local indent="$1"
  local value="$2"
  printf '%s<string>%s</string>\n' "$indent" "$(xml_escape "$value")"
}

write_env_entry() {
  local key="$1"
  local value="$2"
  printf '    <key>%s</key>\n' "$(xml_escape "$key")"
  write_plist_string "    " "$value"
}

bounded_worker_delay() {
  local delay="$RESTART_WORKER_NOT_BEFORE_DELAY"
  local max_delay="$RESTART_MAX_WORKER_NOT_BEFORE_DELAY"
  local normalized
  if ! normalized=$(awk -v delay="$delay" -v max_delay="$max_delay" '
    BEGIN {
      if (delay !~ /^[0-9]+([.][0-9]+)?$/ || max_delay !~ /^[0-9]+([.][0-9]+)?$/) {
        exit 1
      }
      if ((delay + 0) > (max_delay + 0)) {
        printf "%g", (max_delay + 0)
      } else {
        printf "%g", (delay + 0)
      }
    }
  '); then
    err "invalid RESTART_WORKER_NOT_BEFORE_DELAY or RESTART_MAX_WORKER_NOT_BEFORE_DELAY"
    return 1
  fi
  printf '%s' "$normalized"
}

write_restart_status() {
  local mode="$1"
  local status="$2"
  local old_pid="$3"
  local new_pid="$4"
  local error_message="$5"

  [ -n "$RESTART_STATUS_PATH" ] || return 0
  ensure_parent_dir "$RESTART_STATUS_PATH"

  local tmp="${RESTART_STATUS_PATH}.tmp"
  {
    printf 'requestId=%s\n' "$RESTART_REQUEST_ID"
    printf 'mode=%s\n' "$mode"
    printf 'startedAt=%s\n' "${RESTART_STARTED_AT:-}"
    printf 'finishedAt=%s\n' "$(iso_now)"
    printf 'oldPid=%s\n' "$old_pid"
    printf 'newPid=%s\n' "$new_pid"
    printf 'status=%s\n' "$status"
    if [ -n "$error_message" ]; then
      printf 'error=%s\n' "$error_message"
    fi
  } > "$tmp"
  mv "$tmp" "$RESTART_STATUS_PATH"
}

append_restart_log() {
  local message="$1"
  [ -n "$RESTART_LOG_PATH" ] || return 0
  ensure_parent_dir "$RESTART_LOG_PATH"
  printf '%s %s\n' "$(iso_now)" "$message" >> "$RESTART_LOG_PATH"
}

generate_supervisor_plist() {
  local request_id="$1"
  local status_path="$2"
  local log_path="$3"

  ensure_parent_dir "$RESTART_SUPERVISOR_PLIST"
  local tmp="${RESTART_SUPERVISOR_PLIST}.tmp"
  {
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0">'
    printf '%s\n' '<dict>'
    printf '  <key>Label</key>\n'
    write_plist_string "  " "$RESTART_SUPERVISOR_LABEL"
    printf '  <key>ProgramArguments</key>\n'
    printf '  <array>\n'
    write_plist_string "    " "$SCRIPT_PATH"
    write_plist_string "    " "--worker"
    write_plist_string "    " "--plist"
    write_plist_string "    " "--request-id"
    write_plist_string "    " "$request_id"
    write_plist_string "    " "--status-path"
    write_plist_string "    " "$status_path"
    write_plist_string "    " "--log-path"
    write_plist_string "    " "$log_path"
    printf '  </array>\n'
    printf '  <key>EnvironmentVariables</key>\n'
    printf '  <dict>\n'
    write_env_entry "BOT_PLIST" "$BOT_PLIST"
    write_env_entry "BOT_LABEL" "$BOT_LABEL"
    write_env_entry "BOT_UID" "$BOT_UID"
    write_env_entry "MINIME_CONTROL_WORKSPACE_ROOT" "${MINIME_CONTROL_WORKSPACE_ROOT:-}"
    write_env_entry "HOME" "$HOME"
    write_env_entry "PATH" "$PATH"
    write_env_entry "RESTART_REQUEST_ID" "$request_id"
    write_env_entry "RESTART_STATUS_PATH" "$status_path"
    write_env_entry "RESTART_LOG_PATH" "$log_path"
    write_env_entry "SHUTDOWN_TIMEOUT" "$SHUTDOWN_TIMEOUT"
    write_env_entry "TEARDOWN_TIMEOUT" "$TEARDOWN_TIMEOUT"
    write_env_entry "STARTUP_TIMEOUT" "$STARTUP_TIMEOUT"
    write_env_entry "POLL_INTERVAL" "$POLL_INTERVAL"
    write_env_entry "RESTART_WORKER_NOT_BEFORE_DELAY" "$RESTART_WORKER_NOT_BEFORE_DELAY"
    write_env_entry "RESTART_MAX_WORKER_NOT_BEFORE_DELAY" "$RESTART_MAX_WORKER_NOT_BEFORE_DELAY"
    printf '  </dict>\n'
    printf '  <key>RunAtLoad</key>\n'
    printf '  <true/>\n'
    printf '  <key>StandardOutPath</key>\n'
    write_plist_string "  " "$log_path"
    printf '  <key>StandardErrorPath</key>\n'
    write_plist_string "  " "$log_path"
    printf '%s\n' '</dict>'
    printf '%s\n' '</plist>'
  } > "$tmp"
  mv "$tmp" "$RESTART_SUPERVISOR_PLIST"
}

graceful_restart() {
  local old_pid
  if ! old_pid=$(get_pid); then
    err "service $BOT_LABEL is not registered with launchd; run: restart-bot.sh --plist"
    return 1
  fi

  if [ -z "$old_pid" ]; then
    err "service $BOT_LABEL is registered but has no running process (PID=-); run: restart-bot.sh --plist"
    return 1
  fi

  validate_config || return 1

  log "Sending SIGTERM to $SERVICE (old PID: $old_pid)"
  if ! "$LAUNCHCTL_BIN" kill SIGTERM "$SERVICE"; then
    err "launchctl kill SIGTERM failed"
    return 1
  fi

  _old_pid="$old_pid"
  log "Waiting up to ${SHUTDOWN_TIMEOUT}s for old process $old_pid to exit…"
  if ! wait_until "$SHUTDOWN_TIMEOUT" _pred_old_pid_gone; then
    err "old process $old_pid did not exit within ${SHUTDOWN_TIMEOUT}s"
    return 1
  fi

  log "Waiting up to ${STARTUP_TIMEOUT}s for KeepAlive to spawn a new PID…"
  if ! wait_until "$STARTUP_TIMEOUT" _pred_running_pid; then
    err "no new PID observed within ${STARTUP_TIMEOUT}s; KeepAlive did not restart"
    return 1
  fi

  local new_pid
  new_pid=$(get_pid 2>/dev/null || true)
  log "Restart complete. New PID: ${new_pid:-unknown}"
  echo "$new_pid"
}

plist_request_restart() {
  ensure_restart_paths
  ensure_parent_dir "$RESTART_STATUS_PATH"
  ensure_parent_dir "$RESTART_LOG_PATH"
  RESTART_STARTED_AT="$(iso_now)"

  if [ ! -f "$BOT_PLIST" ]; then
    err "plist not found: $BOT_PLIST"
    write_restart_status "request" "failure" "" "" "plist not found"
    return 1
  fi

  if ! validate_plist; then
    write_restart_status "request" "failure" "" "" "plist validation failed"
    return 1
  fi
  if ! validate_config; then
    write_restart_status "request" "failure" "" "" "config validation failed"
    return 1
  fi

  generate_supervisor_plist "$RESTART_REQUEST_ID" "$RESTART_STATUS_PATH" "$RESTART_LOG_PATH"

  log "Validating restart supervisor plist at ${RESTART_SUPERVISOR_PLIST}…"
  if ! "$PLUTIL_BIN" -lint "$RESTART_SUPERVISOR_PLIST" >/dev/null 2>&1; then
    err "restart supervisor plist is malformed: $RESTART_SUPERVISOR_PLIST"
    write_restart_status "request" "failure" "" "" "supervisor plist validation failed"
    return 1
  fi

  log "Cleaning up any existing restart supervisor registration (${RESTART_SUPERVISOR_SERVICE})…"
  "$LAUNCHCTL_BIN" bootout "$RESTART_SUPERVISOR_SERVICE" >/dev/null 2>&1 || true

  log "Scheduling restart supervisor ${RESTART_SUPERVISOR_LABEL}…"
  if ! "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$RESTART_SUPERVISOR_PLIST"; then
    err "launchctl bootstrap failed for restart supervisor"
    write_restart_status "request" "failure" "" "" "supervisor bootstrap failed"
    return 1
  fi

  write_restart_status "request" "scheduled" "" "" ""
  log "Restart scheduled. Request ID: ${RESTART_REQUEST_ID}"
  log "Status path: ${RESTART_STATUS_PATH}"
  log "Log path: ${RESTART_LOG_PATH}"
}

plist_worker_guard() {
  if [ "${MINIME_BOT_PI_SESSION:-}" = "1" ] && [ "${MINIME_RESTART_UNSAFE_FOREGROUND:-}" != "1" ]; then
    err "foreground plist restart refused inside Pi session; use default --plist scheduler or set MINIME_RESTART_UNSAFE_FOREGROUND=1"
    RESTART_STATUS_ERROR="foreground restart refused inside Pi session"
    return 1
  fi
}

plist_worker_restart_impl() {
  if [ ! -f "$BOT_PLIST" ]; then
    err "plist not found: $BOT_PLIST"
    RESTART_STATUS_ERROR="plist not found"
    return 1
  fi

  if ! validate_plist; then
    RESTART_STATUS_ERROR="plist validation failed"
    return 1
  fi
  if ! validate_config; then
    RESTART_STATUS_ERROR="config validation failed"
    return 1
  fi

  local observed_pid rc=0
  observed_pid=$(get_pid 2>/dev/null) || rc=$?
  if [ "$rc" -eq 0 ]; then
    RESTART_STATUS_OLD_PID="$observed_pid"
  fi

  local delay
  if ! delay="$(bounded_worker_delay)"; then
    RESTART_STATUS_ERROR="invalid worker delay"
    return 1
  fi
  log "Waiting ${delay}s before launchd bootout so the scheduling process can return…"
  sleep "$delay"

  local registration_rc=0
  get_pid >/dev/null 2>&1 || registration_rc=$?
  case "$registration_rc" in
  0)
    log "Unregistering $SERVICE (launchctl bootout)…"
    # bootout may return non-zero even when the teardown is in progress;
    # we rely on polling below, not the exit code.
    "$LAUNCHCTL_BIN" bootout "$SERVICE" >/dev/null 2>&1 || true

    log "Waiting up to ${TEARDOWN_TIMEOUT}s for teardown to complete…"
    if ! wait_until "$TEARDOWN_TIMEOUT" _pred_unregistered; then
      err "service did not unregister within ${TEARDOWN_TIMEOUT}s; refusing to bootstrap"
      err "bootout is still draining sessions — rerun once 'launchctl list' no longer shows $BOT_LABEL"
      RESTART_STATUS_ERROR="teardown timeout"
      return 1
    fi
    ;;
  1)
    log "Service not currently registered; skipping bootout."
    ;;
  *)
    err "launchctl list failed; refusing to bootstrap over unknown service state"
    RESTART_STATUS_ERROR="unknown launchd state"
    return 1
    ;;
  esac

  log "Bootstrapping from ${BOT_PLIST}…"
  if ! "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$BOT_PLIST"; then
    err "launchctl bootstrap failed"
    RESTART_STATUS_ERROR="bot bootstrap failed"
    return 1
  fi

  log "Waiting up to ${STARTUP_TIMEOUT}s for a running PID…"
  if ! wait_until "$STARTUP_TIMEOUT" _pred_running_pid; then
    err "service registered but no running PID within ${STARTUP_TIMEOUT}s"
    RESTART_STATUS_ERROR="startup timeout"
    return 1
  fi

  local new_pid
  new_pid=$(get_pid 2>/dev/null || true)
  RESTART_STATUS_NEW_PID="$new_pid"
  log "Restart complete. New PID: ${new_pid:-unknown}"
  echo "$new_pid"
}

plist_worker_restart() {
  ensure_restart_paths
  RESTART_STARTED_AT="$(iso_now)"
  RESTART_STATUS_OLD_PID=""
  RESTART_STATUS_NEW_PID=""
  RESTART_STATUS_ERROR=""

  if ! plist_worker_guard; then
    write_restart_status "worker" "failure" "$RESTART_STATUS_OLD_PID" "$RESTART_STATUS_NEW_PID" "$RESTART_STATUS_ERROR"
    return 1
  fi

  append_restart_log "requestId=${RESTART_REQUEST_ID} mode=worker started"
  local rc=0
  if plist_worker_restart_impl; then
    rc=0
  else
    rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    append_restart_log "requestId=${RESTART_REQUEST_ID} mode=worker success oldPid=${RESTART_STATUS_OLD_PID} newPid=${RESTART_STATUS_NEW_PID}"
    write_restart_status "worker" "success" "$RESTART_STATUS_OLD_PID" "$RESTART_STATUS_NEW_PID" ""
    return 0
  fi

  append_restart_log "requestId=${RESTART_REQUEST_ID} mode=worker failure error=${RESTART_STATUS_ERROR}"
  write_restart_status "worker" "failure" "$RESTART_STATUS_OLD_PID" "$RESTART_STATUS_NEW_PID" "$RESTART_STATUS_ERROR"
  return "$rc"
}

case "$MODE" in
  graceful)      graceful_restart ;;
  plist_request) plist_request_restart ;;
  plist_worker)  plist_worker_restart ;;
  *)        err "internal: unhandled mode $MODE"; exit 1 ;;
esac
