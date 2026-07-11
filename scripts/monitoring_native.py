#!/usr/bin/env python3
"""Node-independent secret resolution and Telegram delivery primitives."""

from __future__ import annotations

import argparse
import http.client
import json
import math
import os
import re
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable

TOKEN_ENV = "MINIME_TELEGRAM_BOT_TOKEN"
SOPS_FILE_ENV = "MINIME_TELEGRAM_SOPS_FILE"
SOPS_KEY_ENV = "MINIME_TELEGRAM_SOPS_KEY"
SOPS_EXECUTABLE_ENV = "MINIME_SOPS_EXECUTABLE"
API_BASE_ENV = "MINIME_TELEGRAM_API_BASE"
INSECURE_TEST_ENV = "MINIME_TELEGRAM_ALLOW_INSECURE_TEST_API"
DEFAULT_API_BASE = "https://api.telegram.org"
TELEGRAM_TEXT_MAX_UTF16_UNITS = 4096
HTTP_RESPONSE_MAX_BYTES = 1_000_000
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
    base = environ.get(API_BASE_ENV, DEFAULT_API_BASE).rstrip("/")
    parsed = urllib.parse.urlsplit(base)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
    ):
        raise DeliveryError("Telegram API base is invalid")
    if base == DEFAULT_API_BASE:
        return base
    if environ.get(INSECURE_TEST_ENV) == "1":
        return base
    raise DeliveryError("custom Telegram API base requires test mode")


def _response_json(body: bytes) -> dict[str, Any]:
    if len(body) > HTTP_RESPONSE_MAX_BYTES:
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


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes


def _abort_connection(connection: http.client.HTTPConnection) -> None:
    """Interrupt an in-progress header/body read from the deadline timer."""
    sock = connection.sock
    if sock is not None:
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
    connection.close()


def request_with_deadline(
    url: str,
    *,
    method: str,
    timeout: float,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    max_body: int = 0,
) -> HttpResponse:
    """Perform one HTTP request with an absolute header/body deadline."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("HTTP URL is invalid")
    port = parsed.port
    connection_type = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_type(parsed.hostname, port=port, timeout=timeout)
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    expired = threading.Event()

    def expire() -> None:
        expired.set()
        _abort_connection(connection)

    timer = threading.Timer(timeout, expire)
    timer.daemon = True
    timer.start()
    try:
        connection.request(method, target, body=data, headers=headers or {})
        response = connection.getresponse()
        body = response.read(max_body + 1) if max_body > 0 else b""
        if expired.is_set():
            raise TimeoutError("HTTP request timed out")
        return HttpResponse(response.status, body)
    finally:
        timer.cancel()
        _abort_connection(connection)


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
            response = request_with_deadline(
                url,
                method="POST",
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=config.timeout,
                max_body=HTTP_RESPONSE_MAX_BYTES,
            )
            if response.status == 429:
                retryable = True
                try:
                    payload = _response_json(response.body)
                    raw_delay = payload.get("parameters", {}).get("retry_after")
                    if isinstance(raw_delay, (int, float)) and math.isfinite(raw_delay):
                        retry_delay = min(max(float(raw_delay), 0.0), config.max_retry_after)
                except (DeliveryError, AttributeError):
                    pass
            elif 500 <= response.status <= 599:
                retryable = True
            elif not 200 <= response.status <= 299:
                raise DeliveryError("Telegram rejected the notification")
            else:
                payload = _response_json(response.body)
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
        except (
            http.client.HTTPException,
            TimeoutError,
            socket.timeout,
            OSError,
            ValueError,
        ):
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
