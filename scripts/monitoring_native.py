#!/usr/bin/env python3
"""Node-independent secret resolution and Telegram delivery primitives."""

from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import math
import multiprocessing
import os
from pathlib import Path
import re
import socket
import stat
import subprocess
import sys
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Callable

TOKEN_ENV = "MINIME_TELEGRAM_BOT_TOKEN"
SOPS_FILE_ENV = "MINIME_TELEGRAM_SOPS_FILE"
SOPS_KEY_ENV = "MINIME_TELEGRAM_SOPS_KEY"
OPS_INTAKE_SOPS_FILE_ENV = "MINIME_OPS_INTAKE_SOPS_FILE"
OPS_INTAKE_SOPS_KEY_ENV = "MINIME_OPS_INTAKE_SOPS_KEY"
SOPS_EXECUTABLE_ENV = "MINIME_SOPS_EXECUTABLE"
API_BASE_ENV = "MINIME_TELEGRAM_API_BASE"
INSECURE_TEST_ENV = "MINIME_TELEGRAM_ALLOW_INSECURE_TEST_API"
DEFAULT_API_BASE = "https://api.telegram.org"
TELEGRAM_TEXT_MAX_UTF16_UNITS = 4096
HTTP_RESPONSE_MAX_BYTES = 1_000_000
_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$")
_ENV_NAME_RE = re.compile(r"^[A-Z][A-Z0-9_]*$")


class MonitoringError(Exception):
    """A public-safe error whose text never contains secret or endpoint details."""


class SecretError(MonitoringError):
    pass


class DeliveryError(MonitoringError):
    pass


def read_private_ascii_token(path: Path, *, max_bytes: int) -> str:
    """Read an owner-only regular token file without following symlinks."""

    descriptor: int | None = None
    flags = os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        metadata = os.fstat(descriptor)
        if (
            not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.geteuid()
            or metadata.st_mode & 0o077
            or not 16 <= metadata.st_size <= max_bytes
        ):
            raise MonitoringError("authentication token file is invalid")
        raw = os.read(descriptor, max_bytes + 1)
        token = raw.decode("utf-8").strip()
        if len(raw) > max_bytes or not 16 <= len(token) or "\n" in token or "\r" in token:
            raise MonitoringError("authentication token file is invalid")
        token.encode("ascii")
        return token
    except (OSError, UnicodeError) as exc:
        raise MonitoringError("authentication token file is invalid") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)


def sops_expression(dotted_key: str) -> str:
    if not _KEY_RE.fullmatch(dotted_key):
        raise SecretError("secret key is invalid")
    return "".join(f"[{json.dumps(part)}]" for part in dotted_key.split("."))


def resolve_secret(
    *,
    value_env: str | None,
    sops_file_env: str,
    sops_key_env: str,
    environ: dict[str, str] | os._Environ[str] = os.environ,
    sops_timeout: float = 5.0,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    env_names = [sops_file_env, sops_key_env]
    if value_env is not None:
        env_names.append(value_env)
    if any(not _ENV_NAME_RE.fullmatch(name) for name in env_names):
        raise SecretError("secret environment name is invalid")

    value = environ.get(value_env, "") if value_env is not None else ""
    if value:
        if "\n" in value or "\r" in value:
            raise SecretError("environment secret is invalid")
        return value

    sops_file = environ.get(sops_file_env, "")
    sops_key = environ.get(sops_key_env, "")
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


def resolve_token(
    *,
    environ: dict[str, str] | os._Environ[str] = os.environ,
    sops_timeout: float = 5.0,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    """Resolve the Telegram token through the backward-compatible source names."""
    return resolve_secret(
        value_env=TOKEN_ENV,
        sops_file_env=SOPS_FILE_ENV,
        sops_key_env=SOPS_KEY_ENV,
        environ=environ,
        sops_timeout=sops_timeout,
        run=run,
    )


def resolve_ops_intake_bearer(
    *,
    environ: dict[str, str] | os._Environ[str] = os.environ,
    sops_timeout: float = 5.0,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    """Resolve the Ops bearer only from its named SOPS source."""
    return resolve_secret(
        value_env=None,
        sops_file_env=OPS_INTAKE_SOPS_FILE_ENV,
        sops_key_env=OPS_INTAKE_SOPS_KEY_ENV,
        environ=environ,
        sops_timeout=sops_timeout,
        run=run,
    )


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


def normalize_loopback_http_url(
    value: str,
    *,
    required_path: str | None = None,
    base_only: bool = False,
) -> str:
    """Validate a local HTTP endpoint without resolving an attacker-controlled host."""
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
        hostname = parsed.hostname
        is_loopback = hostname == "localhost"
        if hostname is not None and not is_loopback:
            is_loopback = ipaddress.ip_address(hostname).is_loopback
    except (ValueError, UnicodeError):
        raise DeliveryError("bridge URL is invalid") from None
    if (
        parsed.scheme != "http"
        or not parsed.netloc
        or not is_loopback
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise DeliveryError("bridge URL must use loopback HTTP")
    if required_path is not None and parsed.path != required_path:
        raise DeliveryError("bridge URL path is invalid")
    if base_only and parsed.path not in {"", "/"}:
        raise DeliveryError("bridge base URL path is invalid")
    return value.rstrip("/") if base_only else value


def _perform_http_request(
    url: str,
    method: str,
    data: bytes | None,
    headers: dict[str, str],
    timeout: float,
    max_body: int,
) -> HttpResponse:
    parsed = urllib.parse.urlsplit(url)
    port = parsed.port
    connection_type = (
        http.client.HTTPSConnection if parsed.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_type(parsed.hostname, port=port, timeout=timeout)
    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    try:
        connection.request(method, target, body=data, headers=headers)
        response = connection.getresponse()
        body = response.read(max_body + 1) if max_body > 0 else b""
        return HttpResponse(response.status, body)
    finally:
        connection.close()


def _http_request_worker(
    sender: Any,
    url: str,
    method: str,
    data: bytes | None,
    headers: dict[str, str],
    timeout: float,
    max_body: int,
) -> None:
    try:
        response = _perform_http_request(url, method, data, headers, timeout, max_body)
        sender.send(("ok", response.status, response.body))
    except BaseException:
        # Endpoint, resolver, and protocol details must not cross the boundary.
        try:
            sender.send(("error",))
        except (BrokenPipeError, EOFError, OSError):
            pass
    finally:
        sender.close()


def _stop_worker(process: multiprocessing.Process) -> None:
    if process.pid is None:
        return
    if not process.is_alive():
        process.join(timeout=0)
        return
    process.terminate()
    process.join(timeout=0.1)
    if process.is_alive():
        process.kill()
        process.join(timeout=0.1)


def request_with_deadline(
    url: str,
    *,
    method: str,
    timeout: float,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    max_body: int = 0,
) -> HttpResponse:
    """Perform one HTTP request with a process-enforced absolute deadline."""
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("HTTP URL is invalid")
    # Force port validation in the parent so malformed configuration fails
    # synchronously rather than being collapsed into a network failure.
    parsed.port
    if not math.isfinite(timeout) or timeout <= 0 or max_body < 0:
        raise ValueError("HTTP request options are invalid")

    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(
        target=_http_request_worker,
        args=(sender, url, method, data, headers or {}, timeout, max_body),
        daemon=True,
    )
    deadline = time.monotonic() + timeout
    try:
        process.start()
        sender.close()
        remaining = max(0.0, deadline - time.monotonic())
        if not receiver.poll(remaining):
            raise TimeoutError("HTTP request timed out")
        result = receiver.recv()
        if len(result) != 3 or result[0] != "ok":
            raise OSError("HTTP request failed")
        return HttpResponse(result[1], result[2])
    except EOFError:
        raise OSError("HTTP request failed") from None
    finally:
        sender.close()
        receiver.close()
        _stop_worker(process)


def post_loopback_json_with_bearer(
    url: str,
    body: bytes,
    bearer: str,
    *,
    timeout: float,
    max_body: int = 64 * 1024,
) -> HttpResponse:
    """POST bounded JSON with an in-memory bearer to a verified loopback endpoint."""
    normalize_loopback_http_url(url)
    try:
        encoded_bearer = bearer.encode("ascii")
    except UnicodeEncodeError:
        raise DeliveryError("bridge bearer is invalid") from None
    if (
        not body
        or len(body) > 256 * 1024
        or not 16 <= len(encoded_bearer) <= 8 * 1024
        or any(byte < 0x21 or byte > 0x7E for byte in encoded_bearer)
    ):
        raise DeliveryError("bridge request is invalid")
    response = request_with_deadline(
        url,
        method="POST",
        data=body,
        headers={
            "Authorization": f"Bearer {bearer}",
            "Content-Type": "application/json",
        },
        timeout=timeout,
        max_body=max_body,
    )
    if len(response.body) > max_body:
        raise DeliveryError("bridge response is too large")
    return response


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
