#!/bin/bash
# deliver.sh — Send a message to Telegram via Bot API
# Usage: deliver.sh <chat_id> [message]
# Or:    deliver.sh <chat_id> --thread <thread_id> [message]
# Or:    echo "message" | deliver.sh <chat_id> [--thread <thread_id>]
# Handles >4096 char messages by splitting at paragraph boundaries.
# After each successful send, writes an echo JSON file to the private echo spool
# so the bot can route the message to active agent sessions as context.

set -euo pipefail

# Ensure Homebrew binaries are in PATH (needed when called from launchd)
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH}"

# Resolve project root for HTML converter
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

CHAT_ID="${1:?Usage: deliver.sh <chat_id> [--thread <thread_id>] [message]}"
shift

# Validate chat_id is numeric (prevents JSON injection)
[[ "$CHAT_ID" =~ ^-?[0-9]+$ ]] || { echo "[deliver] Error: invalid chat_id: $CHAT_ID" >&2; exit 1; }

THREAD_ID=""
if [ "${1:-}" = "--thread" ]; then
  if [ $# -lt 2 ] || [ -z "${2:-}" ]; then
    echo "[deliver] Error: --thread requires a value" >&2
    exit 1
  fi
  THREAD_ID="$2"
  shift 2
  [[ "$THREAD_ID" =~ ^[0-9]+$ ]] || { echo "[deliver] Error: invalid thread_id: $THREAD_ID" >&2; exit 1; }
fi

# Get message from args or stdin
if [ $# -gt 0 ]; then
  MESSAGE="$*"
else
  MESSAGE="$(cat)"
fi

if [ -z "$MESSAGE" ]; then
  echo "[deliver] Error: empty message" >&2
  exit 1
fi

# HTML converter setup (same converter as the bot's interactive path).
# Packed installs do not include src/ or devDependencies, so prefer the built
# CLI and keep the tsx source path only as a checkout-mode fallback.
NODE_BIN="${NODE_BIN:-node}"
CURL_BIN="${CURL_BIN:-curl}"
DIST_CONVERTER="$BOT_DIR/dist/markdown-html-cli.js"
TSX_BIN="$BOT_DIR/node_modules/.bin/tsx"
SOURCE_CONVERTER="$BOT_DIR/src/markdown-html-cli.ts"
CONVERTER_MODE=""
if [ -f "$DIST_CONVERTER" ]; then
  CONVERTER_MODE="dist"
elif [ -x "$TSX_BIN" ] && [ -f "$SOURCE_CONVERTER" ]; then
  CONVERTER_MODE="source"
fi

convert_markdown() {
  case "$CONVERTER_MODE" in
    dist)
      "$NODE_BIN" "$DIST_CONVERTER"
      ;;
    source)
      "$TSX_BIN" "$SOURCE_CONVERTER"
      ;;
    *)
      return 1
      ;;
  esac
}

# Token is supplied by cron-runner after SOPS/env config resolution.
TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "[deliver] Error: TELEGRAM_BOT_TOKEN is not set; run via cron-runner or provide a resolved token" >&2
  exit 1
fi
unset TELEGRAM_BOT_TOKEN

LOG_DIR="${LOG_DIR:-$HOME/.minime/logs}"
LOG_FILE="${LOG_DIR}/cron-delivery.log"
mkdir -p "$LOG_DIR"

if [ -n "${ECHO_DIR_BASE:-}" ]; then
  : # caller override, mainly for tests
elif [ -n "${HOME:-}" ]; then
  ECHO_DIR_BASE="$HOME/.minime/bot-echo"
else
  ECHO_DIR_BASE=""
fi

write_echo() {
  local chatId="$1" threadId="$2" text="$3"
  [ -n "$ECHO_DIR_BASE" ] || return 0
  local echo_dir="$ECHO_DIR_BASE/$chatId"
  [ ! -L "$ECHO_DIR_BASE" ] || return 0
  mkdir -p "$ECHO_DIR_BASE" || return 0
  chmod 700 "$ECHO_DIR_BASE" 2>/dev/null || return 0
  [ ! -L "$echo_dir" ] || return 0
  mkdir -p "$echo_dir" || return 0
  chmod 700 "$echo_dir" 2>/dev/null || return 0
  local fname
  fname="$(date +%s)-$$-$RANDOM.json"
  local escaped_text
  escaped_text=$(printf '%s' "$text" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))") || return 0
  local threadId_json
  if [ -z "$threadId" ]; then
    threadId_json="null"
  else
    threadId_json="\"$threadId\""
  fi
  local json
  json=$(printf '{"chatId":"%s","threadId":%s,"text":%s,"origin":"deliver.sh","timestamp":%s}' \
    "$chatId" "$threadId_json" "$escaped_text" "$(date +%s)")
  ( umask 077 && printf '%s' "$json" > "$echo_dir/.$fname.tmp" )
  mv "$echo_dir/.$fname.tmp" "$echo_dir/$fname" || return 0
}

build_payload() {
  local text_json="$1" parse_mode="${2:-}"
  local payload
  payload=$(printf '{"chat_id":%s,"text":%s' "$CHAT_ID" "$text_json")
  [ -n "$parse_mode" ] && payload="${payload},\"parse_mode\":\"${parse_mode}\""
  [ -n "$THREAD_ID" ] && payload="${payload},\"message_thread_id\":${THREAD_ID}"
  printf '%s}' "$payload"
}

telegram_post() {
  local method="$1" payload="$2"
  "$CURL_BIN" -s -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --config - <<EOF
url = "https://api.telegram.org/bot${TOKEN}/${method}"
EOF
}

send_message() {
  local text="$1"
  local response ok

  # Try HTML conversion and send (each chunk converted independently)
  if [ -n "$CONVERTER_MODE" ]; then
    local html_text
    html_text=$(convert_markdown <<< "$text" 2>>"$LOG_FILE") || html_text=""
    if [ -n "$html_text" ]; then
      local html_json
      html_json=$(printf '%s' "$html_text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
      response=$(telegram_post "sendMessage" "$(build_payload "$html_json" "HTML")")
      ok=$(printf '%s' "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
      if [ "$ok" = "True" ]; then
        echo "[deliver] $(date -Iseconds) OK chat=$CHAT_ID len=${#text}" >> "$LOG_FILE"
        write_echo "$CHAT_ID" "$THREAD_ID" "$text" || true
        return 0
      fi
    fi
  fi

  # Fallback: send original text without parse_mode
  local text_json
  text_json=$(printf '%s' "$text" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
  response=$(telegram_post "sendMessage" "$(build_payload "$text_json")")
  ok=$(printf '%s' "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok', False))" 2>/dev/null)
  if [ "$ok" != "True" ]; then
    echo "[deliver] $(date -Iseconds) FAIL chat=$CHAT_ID response=$response" >> "$LOG_FILE"
    echo "[deliver] Error: sendMessage failed: $response" >&2
    return 1
  fi

  echo "[deliver] $(date -Iseconds) OK chat=$CHAT_ID len=${#text}" >> "$LOG_FILE"
  write_echo "$CHAT_ID" "$THREAD_ID" "$text" || true
  return 0
}

MAX_LEN=4096

message_fits() {
  printf '%s' "$1" | python3 -c '
import sys

max_units = int(sys.argv[1])
message = sys.stdin.buffer.read().decode("utf-8")
sys.exit(0 if len(message.encode("utf-16-le")) // 2 <= max_units else 1)
' "$MAX_LEN"
}

split_message() {
  printf '%s' "$1" | python3 -c '
import sys

max_units = int(sys.argv[1])
message = sys.stdin.buffer.read().decode("utf-8")


def utf16_units(text):
    return len(text.encode("utf-16-le")) // 2


def prefix_end_for_units(text, limit):
    units = 0
    for index, char in enumerate(text):
        char_units = 2 if ord(char) > 0xFFFF else 1
        if units + char_units > limit:
            return index
        units += char_units
    return len(text)


remaining = message
while remaining:
    if utf16_units(remaining) <= max_units:
        sys.stdout.buffer.write(remaining.encode("utf-8") + b"\0")
        break

    end = prefix_end_for_units(remaining, max_units)
    chunk = remaining[:end]
    split_pos = chunk.rfind("\n\n")

    if split_pos != -1 and utf16_units(remaining[:split_pos]) > 100:
        while split_pos > 0 and remaining[split_pos - 1] == "\n":
            split_pos -= 1
        sys.stdout.buffer.write(remaining[:split_pos].encode("utf-8") + b"\0")
        remaining = remaining[split_pos + 2:]
        continue

    split_pos = chunk.rfind("\n")
    if split_pos != -1 and utf16_units(remaining[:split_pos]) > 100:
        sys.stdout.buffer.write(remaining[:split_pos].encode("utf-8") + b"\0")
        remaining = remaining[split_pos + 1:]
        continue

    sys.stdout.buffer.write(chunk.encode("utf-8") + b"\0")
    remaining = remaining[end:]
' "$MAX_LEN"
}

if message_fits "$MESSAGE"; then
  send_message "$MESSAGE"
else
  first_chunk=1
  while IFS= read -r -d '' chunk; do
    if [ "$first_chunk" -eq 0 ]; then
      # Brief pause between split messages to maintain order
      sleep 0.3
    fi
    send_message "$chunk"
    first_chunk=0
  done < <(split_message "$MESSAGE")
fi
