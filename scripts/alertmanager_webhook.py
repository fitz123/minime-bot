#!/usr/bin/env python3
"""Loopback Alertmanager webhook that delivers through monitoring_native."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import socket
import sys
import threading
import time
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from monitoring_native import (
    TELEGRAM_TEXT_MAX_UTF16_UNITS,
    DeliveryConfig,
    MonitoringError,
    send_telegram,
)

MAX_BODY_DEFAULT = 256 * 1024
MAX_CONCURRENT_REQUESTS = 32
_SAFE_TEXT = re.compile(r"[^A-Za-z0-9 ._:/@+-]+")


def safe_field(value: Any, limit: int = 120) -> str:
    if not isinstance(value, (str, int, float)):
        return "unknown"
    cleaned = _SAFE_TEXT.sub("?", str(value).replace("\n", " ").replace("\r", " "))
    return cleaned[:limit] or "unknown"


def _utf16_units(value: str) -> int:
    return len(value.encode("utf-16-le")) // 2


def _bounded_alert_message(lines: list[str]) -> str:
    prefix = "minime monitoring"
    selected: list[str] = []
    for index, line in enumerate(lines):
        omitted = len(lines) - index - 1
        trailer = f"\n... {omitted} alerts omitted" if omitted else ""
        candidate = prefix + "\n" + "\n".join([*selected, line]) + trailer
        if _utf16_units(candidate) > TELEGRAM_TEXT_MAX_UTF16_UNITS:
            break
        selected.append(line)
    omitted = len(lines) - len(selected)
    trailer = f"\n... {omitted} alerts omitted" if omitted else ""
    return prefix + "\n" + "\n".join(selected) + trailer


def parse_alertmanager_payload(body: bytes) -> tuple[str, str]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("malformed JSON") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("alerts"), list):
        raise ValueError("malformed Alertmanager payload")
    alerts = payload["alerts"]
    if not alerts:
        raise ValueError("invalid alert batch")

    lines: list[str] = []
    identities: list[str] = []
    for item in alerts:
        if not isinstance(item, dict):
            raise ValueError("invalid alert")
        status = "resolved" if item.get("status") == "resolved" else "firing"
        labels = item.get("labels") if isinstance(item.get("labels"), dict) else {}
        name = safe_field(labels.get("alertname"))
        severity = safe_field(labels.get("severity"))
        instance = safe_field(labels.get("instance"))
        lines.append(f"{status.upper()} alert={name} severity={severity} instance={instance}")
        fingerprint = item.get("fingerprint")
        if isinstance(fingerprint, str) and fingerprint:
            identity = fingerprint
        else:
            identity = json.dumps([status, name, severity, instance], separators=(",", ":"))
        identities.append(f"{status}:{identity}")

    try:
        identity_bytes = "\n".join(sorted(identities)).encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("invalid alert fingerprint") from None
    digest = hashlib.sha256(identity_bytes).hexdigest()
    message = _bounded_alert_message(lines)
    return digest, message


class BatchDeduplicator:
    def __init__(self, ttl_seconds: float = 3600.0, limit: int = 1024):
        self.ttl_seconds = ttl_seconds
        self.limit = limit
        self._seen: OrderedDict[str, float] = OrderedDict()
        self._in_flight: set[str] = set()
        self._lock = threading.Lock()

    def claim(self, key: str, now: float | None = None) -> str:
        current = time.monotonic() if now is None else now
        with self._lock:
            self._prune(current)
            if key in self._seen:
                return "committed"
            if key in self._in_flight:
                return "in_flight"
            self._in_flight.add(key)
            return "claimed"

    def commit(self, key: str, now: float | None = None) -> None:
        current = time.monotonic() if now is None else now
        with self._lock:
            self._prune(current)
            self._in_flight.discard(key)
            self._seen[key] = current
            self._seen.move_to_end(key)
            while len(self._seen) > self.limit:
                self._seen.popitem(last=False)

    def release(self, key: str) -> None:
        with self._lock:
            self._in_flight.discard(key)

    def _prune(self, now: float) -> None:
        while self._seen:
            key, timestamp = next(iter(self._seen.items()))
            if now - timestamp <= self.ttl_seconds:
                break
            self._seen.pop(key, None)


class WebhookApplication:
    def __init__(
        self,
        *,
        path: str,
        max_body: int,
        body_timeout: float,
        deliver: Callable[[str], None],
        deduplicator: BatchDeduplicator | None = None,
    ):
        self.path = path
        self.max_body = max_body
        self.body_timeout = body_timeout
        self.deliver = deliver
        self.deduplicator = deduplicator or BatchDeduplicator()


class BoundedThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        request_handler: type[BaseHTTPRequestHandler],
        *,
        max_concurrent_requests: int = MAX_CONCURRENT_REQUESTS,
    ):
        self._request_slots = threading.BoundedSemaphore(max_concurrent_requests)
        super().__init__(server_address, request_handler)

    def process_request(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        if not self._request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self._request_slots.release()
            raise

    def process_request_thread(self, request: socket.socket, client_address: tuple[str, int]) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._request_slots.release()


def handler_for(app: WebhookApplication) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "MinimeNativeWebhook/1"
        sys_version = ""

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(app.body_timeout)
            self._input_deadline = threading.Timer(app.body_timeout, self._expire_input)
            self._input_deadline.daemon = True
            self._input_deadline.start()

        def finish(self) -> None:
            self._cancel_input_deadline()
            super().finish()

        def _expire_input(self) -> None:
            try:
                self.connection.shutdown(socket.SHUT_RD)
            except OSError:
                pass

        def _cancel_input_deadline(self) -> None:
            deadline = getattr(self, "_input_deadline", None)
            if deadline is not None:
                deadline.cancel()
                self._input_deadline = None

        def _read_body(self, length: int) -> bytes:
            chunks: list[bytes] = []
            remaining = length
            deadline = time.monotonic() + app.body_timeout
            while remaining:
                timeout = deadline - time.monotonic()
                if timeout <= 0:
                    raise TimeoutError
                self.connection.settimeout(timeout)
                chunk = self.rfile.read1(min(remaining, 64 * 1024))
                if not chunk:
                    raise TimeoutError
                chunks.append(chunk)
                remaining -= len(chunk)
            return b"".join(chunks)

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def _reply(self, status: int, text: str) -> None:
            body = text.encode("ascii")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=us-ascii")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802
            self._cancel_input_deadline()
            if self.path == "/healthz":
                self._reply(200, "ok")
            else:
                self._reply(404, "not found")

        def do_POST(self) -> None:  # noqa: N802
            if self.path != app.path:
                self._cancel_input_deadline()
                self._reply(404, "not found")
                return
            raw_length = self.headers.get("Content-Length")
            try:
                length = int(raw_length) if raw_length is not None else -1
            except ValueError:
                length = -1
            if length < 0:
                self._cancel_input_deadline()
                self._reply(411, "length required")
                return
            if length > app.max_body:
                self._cancel_input_deadline()
                self._reply(413, "payload too large")
                return
            try:
                body = self._read_body(length)
            except (TimeoutError, OSError):
                self._cancel_input_deadline()
                self._reply(408, "request timed out")
                return
            self._cancel_input_deadline()
            try:
                key, message = parse_alertmanager_payload(body)
            except ValueError:
                self._reply(400, "invalid payload")
                return
            claim = app.deduplicator.claim(key)
            if claim == "committed":
                self._reply(200, "duplicate suppressed")
                return
            if claim == "in_flight":
                self._reply(503, "delivery in progress")
                return
            try:
                app.deliver(message)
            except (MonitoringError, OSError):
                app.deduplicator.release(key)
                self._reply(503, "delivery failed")
                return
            app.deduplicator.commit(key)
            self._reply(200, "delivered")

    return Handler


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Receive Alertmanager webhooks without Node")
    parser.add_argument("--host", default=os.environ.get("MINIME_WEBHOOK_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=os.environ.get("MINIME_WEBHOOK_PORT", "9876"))
    parser.add_argument("--path", default=os.environ.get("MINIME_WEBHOOK_PATH", "/alertmanager"))
    parser.add_argument("--max-body", type=int, default=MAX_BODY_DEFAULT)
    parser.add_argument("--body-timeout", type=float, default=5.0)
    parser.add_argument("--chat-id", default=os.environ.get("MINIME_TELEGRAM_CHAT_ID", ""))
    parser.add_argument("--thread-id", default=os.environ.get("MINIME_TELEGRAM_THREAD_ID"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if args.host not in {"127.0.0.1", "localhost"}:
        print("webhook configuration rejected: host must be loopback", file=sys.stderr)
        return 2
    if (
        not args.path.startswith("/")
        or "?" in args.path
        or args.max_body < 1
        or not math.isfinite(args.body_timeout)
        or args.body_timeout <= 0
        or not 0 <= args.port <= 65535
    ):
        print("webhook configuration rejected", file=sys.stderr)
        return 2

    config = DeliveryConfig(args.chat_id, args.thread_id)
    app = WebhookApplication(
        path=args.path,
        max_body=args.max_body,
        body_timeout=min(args.body_timeout, 30.0),
        deliver=lambda message: send_telegram(message, config),
    )
    try:
        server = BoundedThreadingHTTPServer((args.host, args.port), handler_for(app))
    except OSError:
        print("webhook failed to bind", file=sys.stderr)
        return 1
    print("webhook ready", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
