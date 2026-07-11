#!/usr/bin/env python3
"""Node-independent secret resolution and Telegram delivery primitives."""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable

TOKEN_ENV = "MINIME_TELEGRAM_BOT_TOKEN"
SOPS_FILE_ENV = "MINIME_TELEGRAM_SOPS_FILE"
SOPS_KEY_ENV = "MINIME_TELEGRAM_SOPS_KEY"
SOPS_EXECUTABLE_ENV = "MINIME_SOPS_EXECUTABLE"
API_BASE_ENV = "MINIME_TELEGRAM_API_BASE"
INSECURE_TEST_ENV = "MINIME_TELEGRAM_ALLOW_INSECURE_TEST_API"
TELEGRAM_TEXT_MAX_UTF16_UNITS = 4096
_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$")


class MonitoringError(Exception):
    """A public-safe error whose text never contains secret or endpoint details."""


class SecretError(MonitoringError):
    pass


class DeliveryError(MonitoringError):
    pass


def sops_expression(dotted_key: str) -> str:
    if not _KEY_RE.fullmatch(dotted_key):
        raise SecretError("secret key is invalid")
    return "".join(f"[{json.dumps(part)}]" for part in dotted_key.split("."))


def resolve_token(
    *,
    environ: dict[str, str] | os._Environ[str] = os.environ,
    sops_timeout: float = 5.0,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    token = environ.get(TOKEN_ENV, "")
    if token:
        if "\n" in token or "\r" in token:
            raise SecretError("environment secret is invalid")
        return token

    sops_file = environ.get(SOPS_FILE_ENV, "")
    sops_key = environ.get(SOPS_KEY_ENV, "")
    if not sops_file or not sops_key:
        raise SecretError("secret source is not configured")
    sops_executable = environ.get(SOPS_EXECUTABLE_ENV, "sops")
    if sops_executable != "sops" and not os.path.isabs(sops_executable):
        raise SecretError("secret executable is invalid")
    expression = sops_expression(sops_key)
    try:
        result = run(
            [sops_executable, "-d", "--extract", expression, sops_file],
            capture_output=True,
            text=True,
            timeout=sops_timeout,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise SecretError("secret resolution timed out") from None
    except (OSError, subprocess.SubprocessError):
        raise SecretError("secret resolution failed") from None
    if result.returncode != 0:
        raise SecretError("secret resolution failed")
    value = result.stdout.strip()
    if not value or "\n" in value or "\r" in value:
        raise SecretError("resolved secret is invalid")
    return value


def _api_base(environ: dict[str, str] | os._Environ[str]) -> str:
    base = environ.get(API_BASE_ENV, "https://api.telegram.org").rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if parsed.scheme == "https" and parsed.netloc:
        return base
    if parsed.scheme == "http" and parsed.netloc and environ.get(INSECURE_TEST_ENV) == "1":
        return base
    raise DeliveryError("Telegram API base must use HTTPS")


def _response_json(body: bytes) -> dict[str, Any]:
    if len(body) > 1_000_000:
        raise DeliveryError("Telegram response is too large")
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise DeliveryError("Telegram returned an invalid response") from None
    if not isinstance(value, dict):
        raise DeliveryError("Telegram returned an invalid response")
    return value


@dataclass(frozen=True)
class DeliveryConfig:
    chat_id: str
    thread_id: str | None = None
    timeout: float = 8.0
    attempts: int = 3
    max_retry_after: float = 10.0


def send_telegram(
    message: str,
    config: DeliveryConfig,
    *,
    environ: dict[str, str] | os._Environ[str] = os.environ,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    message_units = len(message.encode("utf-16-le")) // 2
    if not message or message_units > TELEGRAM_TEXT_MAX_UTF16_UNITS:
        raise DeliveryError("notification message is invalid")
    if (
        not config.chat_id
        or not 1 <= config.attempts <= 10
        or not math.isfinite(config.timeout)
        or not 0 < config.timeout <= 30
        or not math.isfinite(config.max_retry_after)
        or not 0 <= config.max_retry_after <= 60
    ):
        raise DeliveryError("Telegram destination is invalid")
    token = resolve_token(environ=environ)
    base = _api_base(environ)
    url = f"{base}/bot{token}/sendMessage"
    fields = {"chat_id": config.chat_id, "text": message}
    if config.thread_id:
        fields["message_thread_id"] = config.thread_id
    data = urllib.parse.urlencode(fields).encode("utf-8")

    for attempt in range(config.attempts):
        retry_delay = min(2**attempt, config.max_retry_after)
        try:
            request = urllib.request.Request(url, data=data, method="POST")
            request.add_header("Content-Type", "application/x-www-form-urlencoded")
            with urllib.request.urlopen(request, timeout=config.timeout) as response:
                payload = _response_json(response.read(1_000_001))
            if payload.get("ok") is True:
                return
            error_code = payload.get("error_code")
            parameters = payload.get("parameters")
            if error_code == 429 and isinstance(parameters, dict):
                raw_delay = parameters.get("retry_after")
                if isinstance(raw_delay, (int, float)) and math.isfinite(raw_delay):
                    retry_delay = min(max(float(raw_delay), 0.0), config.max_retry_after)
            retryable = error_code == 429 or (isinstance(error_code, int) and 500 <= error_code <= 599)
            if not retryable:
                raise DeliveryError("Telegram rejected the notification")
        except urllib.error.HTTPError as exc:
            retryable = exc.code == 429 or 500 <= exc.code <= 599
            if not retryable:
                raise DeliveryError("Telegram rejected the notification") from None
            if exc.code == 429:
                try:
                    payload = _response_json(exc.read(1_000_001))
                    raw_delay = payload.get("parameters", {}).get("retry_after")
                    if isinstance(raw_delay, (int, float)) and math.isfinite(raw_delay):
                        retry_delay = min(max(float(raw_delay), 0.0), config.max_retry_after)
                except (DeliveryError, AttributeError):
                    pass
        except (urllib.error.URLError, TimeoutError, socket.timeout, OSError):
            retryable = True

        if attempt + 1 >= config.attempts:
            raise DeliveryError("Telegram delivery failed after retries")
        sleep(retry_delay)


def _delivery_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Send a Telegram notification without Node")
    parser.add_argument("--message", required=True)
    parser.add_argument("--chat-id", default=os.environ.get("MINIME_TELEGRAM_CHAT_ID", ""))
    parser.add_argument("--thread-id", default=os.environ.get("MINIME_TELEGRAM_THREAD_ID"))
    parser.add_argument("--timeout", type=float, default=8.0)
    parser.add_argument("--attempts", type=int, default=3)
    return parser


def delivery_main(argv: list[str] | None = None) -> int:
    args = _delivery_parser().parse_args(argv)
    try:
        send_telegram(
            args.message,
            DeliveryConfig(args.chat_id, args.thread_id, args.timeout, args.attempts),
        )
    except MonitoringError as exc:
        print(f"notification failed: {exc}", file=sys.stderr)
        return 1
    print("notification delivered")
    return 0


if __name__ == "__main__":
    raise SystemExit(delivery_main())
