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
import urllib.parse
from collections import OrderedDict
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

from monitoring_native import (
    HTTP_RESPONSE_MAX_BYTES,
    OPS_INTAKE_SOPS_FILE_ENV,
    OPS_INTAKE_SOPS_KEY_ENV,
    TELEGRAM_TEXT_MAX_UTF16_UNITS,
    DeliveryConfig,
    DeliveryError,
    MonitoringError,
    normalize_loopback_http_url,
    post_loopback_json_with_bearer,
    request_with_deadline,
    resolve_ops_intake_bearer,
    send_telegram,
)

MAX_BODY_DEFAULT = 256 * 1024
MAX_CONCURRENT_REQUESTS = 32
MAX_ACTIVE_ALERTS = 1024
MAX_ALERT_FIELDS = 32
MAX_LABELS = 64
MAX_LABEL_BYTES = 2 * 1024
MAX_KEY_BYTES = 256
MAX_RECEIVER_BYTES = 1024
OPS_INTAKE_URL_ENV = "MINIME_OPS_INTAKE_URL"
ALERTMANAGER_URL_ENV = "MINIME_ALERTMANAGER_URL"
BRIDGE_TIMEOUT_ENV = "MINIME_BRIDGE_TIMEOUT"
_SAFE_TEXT = re.compile(r"[^A-Za-z0-9 ._:/@+-]+")
_LABEL_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_RE2_META_CHARACTERS = frozenset(r"\.+*?()|[]{}^$")


@dataclass(frozen=True)
class ParsedAlertmanagerBatch:
    native_key: str
    bridge_key: str
    message: str
    has_firing: bool
    critical: bool
    receiver: str
    group_labels: dict[str, str]
    firing_labels: tuple[dict[str, str], ...]


@dataclass(frozen=True)
class BridgeConfig:
    ops_intake_url: str
    alertmanager_url: str
    bearer: str
    timeout: float


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


def _decode_alertmanager_payload(body: bytes) -> dict[str, Any]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise ValueError("malformed JSON") from None
    if not isinstance(payload, dict) or not isinstance(payload.get("alerts"), list):
        raise ValueError("malformed Alertmanager payload")
    return payload


def _native_payload_fields(
    payload: dict[str, Any],
    *,
    episode_group_key: str | None = None,
) -> tuple[str, str]:
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
        if episode_group_key is None:
            identities.append(f"{status}:{identity}")
        else:
            starts_at = _bounded_string(
                item.get("startsAt"),
                limit=128,
                allow_empty=False,
            )
            identities.append(json.dumps(
                [episode_group_key, status, identity, starts_at],
                separators=(",", ":"),
            ))

    try:
        identity_bytes = "\n".join(sorted(identities)).encode("utf-8")
    except UnicodeEncodeError:
        raise ValueError("invalid alert fingerprint") from None
    digest = hashlib.sha256(identity_bytes).hexdigest()
    message = _bounded_alert_message(lines)
    return digest, message


def parse_alertmanager_payload(body: bytes) -> tuple[str, str]:
    """Parse the legacy native-only contract without changing its behavior."""
    return _native_payload_fields(_decode_alertmanager_payload(body))


def _bounded_string(value: Any, *, limit: int, allow_empty: bool = True) -> str:
    if (
        not isinstance(value, str)
        or (not allow_empty and not value)
        or "\x00" in value
        or len(value.encode("utf-8")) > limit
    ):
        raise ValueError("invalid bounded string")
    return value


def _bounded_string_map(value: Any, *, max_entries: int, max_value_bytes: int) -> dict[str, str]:
    if not isinstance(value, dict) or len(value) > max_entries:
        raise ValueError("invalid bounded label map")
    result: dict[str, str] = {}
    for key, raw_value in value.items():
        bounded_key = _bounded_string(key, limit=MAX_KEY_BYTES, allow_empty=False)
        result[bounded_key] = _bounded_string(raw_value, limit=max_value_bytes)
    return result


def parse_bridge_alertmanager_payload(body: bytes) -> ParsedAlertmanagerBatch:
    """Validate fields needed to authenticate and forward one Alertmanager v4 group."""
    payload = _decode_alertmanager_payload(body)
    alerts = payload["alerts"]
    if (
        payload.get("version") != "4"
        or payload.get("status") not in {"firing", "resolved"}
        or not isinstance(alerts, list)
        or not 1 <= len(alerts) <= MAX_ACTIVE_ALERTS
    ):
        raise ValueError("invalid bridge payload")
    group_key = _bounded_string(
        payload.get("groupKey"),
        limit=8 * 1024,
        allow_empty=False,
    )
    native_key, message = _native_payload_fields(
        payload,
        episode_group_key=group_key,
    )
    if "groupLabels" not in payload:
        raise ValueError("invalid bridge payload")
    group_labels = _bounded_string_map(
        payload["groupLabels"],
        max_entries=MAX_LABELS,
        max_value_bytes=MAX_LABEL_BYTES,
    )
    if any(not _LABEL_NAME.fullmatch(key) for key in group_labels):
        raise ValueError("invalid bridge group labels")
    receiver = _bounded_string(
        payload.get("receiver"),
        limit=MAX_RECEIVER_BYTES,
        allow_empty=False,
    )
    firing_count = 0
    firing_labels: list[dict[str, str]] = []
    critical = False
    for alert in alerts:
        if not isinstance(alert, dict) or len(alert) > MAX_ALERT_FIELDS:
            raise ValueError("invalid bridge alert")
        status = alert.get("status")
        if status not in {"firing", "resolved"}:
            raise ValueError("invalid bridge alert status")
        labels = _bounded_string_map(
            alert.get("labels"),
            max_entries=MAX_LABELS,
            max_value_bytes=MAX_LABEL_BYTES,
        )
        if status == "firing":
            firing_count += 1
            firing_labels.append(labels)
            if any(labels.get(key) != value for key, value in group_labels.items()):
                raise ValueError("group labels do not match firing alert")
        if labels.get("severity") == "critical":
            critical = True
    if (
        (payload["status"] == "firing" and firing_count == 0)
        or (payload["status"] == "resolved" and firing_count != 0)
    ):
        raise ValueError("bridge batch status is inconsistent")
    return ParsedAlertmanagerBatch(
        native_key=native_key,
        bridge_key=hashlib.sha256(body).hexdigest(),
        message=message,
        has_firing=firing_count > 0,
        critical=critical,
        receiver=receiver,
        group_labels=group_labels,
        firing_labels=tuple(firing_labels),
    )


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


def _active_alert_groups_url(
    base_url: str,
    receiver: str,
    group_labels: dict[str, str],
) -> str:
    quoted_receiver = "".join(
        f"\\{character}" if character in _RE2_META_CHARACTERS else character
        for character in receiver
    )
    parameters = [
        ("active", "true"),
        ("silenced", "true"),
        ("inhibited", "true"),
        ("muted", "true"),
        ("receiver", f"^(?:{quoted_receiver})$"),
    ]
    parameters.extend(
        ("filter", f"{key}={json.dumps(value, ensure_ascii=False)}")
        for key, value in sorted(group_labels.items())
    )
    return f"{base_url}/api/v2/alerts/groups?{urllib.parse.urlencode(parameters)}"


def alertmanager_has_exact_group(
    config: BridgeConfig,
    receiver: str,
    group_labels: dict[str, str],
    firing_labels: tuple[dict[str, str], ...],
) -> bool:
    """Require an exact routed group containing every delivered firing alert."""
    try:
        response = request_with_deadline(
            _active_alert_groups_url(
                config.alertmanager_url,
                receiver,
                group_labels,
            ),
            method="GET",
            headers={"Accept": "application/json"},
            timeout=config.timeout,
            max_body=HTTP_RESPONSE_MAX_BYTES,
        )
    except (OSError, TimeoutError, ValueError) as exc:
        raise DeliveryError("Alertmanager source verification failed") from exc
    if not 200 <= response.status <= 299 or len(response.body) > HTTP_RESPONSE_MAX_BYTES:
        raise DeliveryError("Alertmanager source verification failed")
    try:
        groups = json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise DeliveryError("Alertmanager source verification failed") from None
    if not isinstance(groups, list) or len(groups) > MAX_ACTIVE_ALERTS:
        raise DeliveryError("Alertmanager source verification failed")
    current_group_members: set[tuple[tuple[str, str], ...]] = set()
    for group in groups:
        if not isinstance(group, dict) or len(group) > MAX_ALERT_FIELDS:
            raise DeliveryError("Alertmanager source verification failed")
        try:
            labels = _bounded_string_map(
                group.get("labels"),
                max_entries=MAX_LABELS,
                max_value_bytes=MAX_LABEL_BYTES,
            )
            group_receiver = group.get("receiver")
            if not isinstance(group_receiver, dict) or len(group_receiver) > MAX_ALERT_FIELDS:
                raise ValueError("invalid receiver")
            receiver_name = _bounded_string(
                group_receiver.get("name"),
                limit=MAX_RECEIVER_BYTES,
                allow_empty=False,
            )
        except ValueError:
            raise DeliveryError("Alertmanager source verification failed") from None
        if labels != group_labels or receiver_name != receiver:
            continue
        alerts = group.get("alerts")
        if not isinstance(alerts, list) or len(alerts) > MAX_ACTIVE_ALERTS:
            raise DeliveryError("Alertmanager source verification failed")
        for alert in alerts:
            if not isinstance(alert, dict) or len(alert) > MAX_ALERT_FIELDS:
                raise DeliveryError("Alertmanager source verification failed")
            try:
                alert_labels = _bounded_string_map(
                    alert.get("labels"),
                    max_entries=MAX_LABELS,
                    max_value_bytes=MAX_LABEL_BYTES,
                )
            except ValueError:
                raise DeliveryError("Alertmanager source verification failed") from None
            status = alert.get("status")
            if not isinstance(status, dict) or status.get("state") not in {
                "active",
                "suppressed",
                "unprocessed",
            }:
                raise DeliveryError("Alertmanager source verification failed")
            current_group_members.add(tuple(sorted(alert_labels.items())))
    return bool(firing_labels) and all(
        tuple(sorted(candidate.items())) in current_group_members
        for candidate in firing_labels
    )


def forward_to_ops(config: BridgeConfig, body: bytes) -> bool:
    try:
        response = post_loopback_json_with_bearer(
            config.ops_intake_url,
            body,
            config.bearer,
            timeout=config.timeout,
        )
    except (MonitoringError, OSError, TimeoutError, ValueError):
        return False
    return 200 <= response.status <= 299


class WebhookApplication:
    def __init__(
        self,
        *,
        path: str,
        max_body: int,
        body_timeout: float,
        deliver: Callable[[str], None],
        deduplicator: BatchDeduplicator | None = None,
        bridge: BridgeConfig | None = None,
        native_deduplicator: BatchDeduplicator | None = None,
        verify_group: Callable[
            [BridgeConfig, str, dict[str, str], tuple[dict[str, str], ...]], bool
        ] = alertmanager_has_exact_group,
        forward: Callable[[BridgeConfig, bytes], bool] = forward_to_ops,
    ):
        self.path = path
        self.max_body = max_body
        self.body_timeout = body_timeout
        self.deliver = deliver
        self.deduplicator = deduplicator or BatchDeduplicator()
        self.bridge = bridge
        self.native_deduplicator = native_deduplicator or BatchDeduplicator()
        self.verify_group = verify_group
        self.forward = forward


def _deliver_native_once(
    app: WebhookApplication,
    key: str,
    message: str,
) -> bool:
    claim = app.native_deduplicator.claim(key)
    if claim == "committed":
        return True
    if claim == "in_flight":
        return False
    try:
        app.deliver(message)
    except (MonitoringError, OSError):
        app.native_deduplicator.release(key)
        return False
    app.native_deduplicator.commit(key)
    return True


def _deliver_bridge_batch(
    app: WebhookApplication,
    batch: ParsedAlertmanagerBatch,
    body: bytes,
) -> bool:
    bridge = app.bridge
    if bridge is None:
        raise RuntimeError("bridge delivery requires bridge configuration")
    if not batch.has_firing:
        return (
            _deliver_native_once(app, batch.native_key, batch.message)
            if batch.critical
            else True
        )
    try:
        source_present = app.verify_group(
            bridge,
            batch.receiver,
            batch.group_labels,
            batch.firing_labels,
        )
    except Exception:
        # Verification must be retried even when the independent fallback succeeds.
        _deliver_native_once(app, batch.native_key, batch.message)
        return False
    if not source_present:
        # Stale or forged local deliveries are acknowledged without granting Ops authority.
        return True

    try:
        ops_succeeded = app.forward(bridge, body)
    except Exception:
        ops_succeeded = False
    if batch.critical:
        native_succeeded = _deliver_native_once(app, batch.native_key, batch.message)
        return ops_succeeded and native_succeeded
    if ops_succeeded:
        return True
    # Native fallback prevents silence but does not hide the failed required Ops sink.
    _deliver_native_once(app, batch.native_key, batch.message)
    return False


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
                if app.bridge is None:
                    key, message = parse_alertmanager_payload(body)
                    batch = None
                else:
                    batch = parse_bridge_alertmanager_payload(body)
                    key = batch.bridge_key
                    message = batch.message
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
            if batch is not None:
                succeeded = _deliver_bridge_batch(app, batch, body)
                if not succeeded:
                    app.deduplicator.release(key)
                    self._reply(503, "delivery failed")
                    return
            else:
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
    parser.add_argument("--ops-intake-url", default=os.environ.get(OPS_INTAKE_URL_ENV, ""))
    parser.add_argument("--alertmanager-url", default=os.environ.get(ALERTMANAGER_URL_ENV, ""))
    parser.add_argument(
        "--bridge-timeout",
        type=float,
        default=os.environ.get(BRIDGE_TIMEOUT_ENV, "5"),
    )
    return parser


def _load_bridge(args: argparse.Namespace) -> BridgeConfig | None:
    sources = [
        args.ops_intake_url,
        args.alertmanager_url,
        os.environ.get(OPS_INTAKE_SOPS_FILE_ENV, ""),
        os.environ.get(OPS_INTAKE_SOPS_KEY_ENV, ""),
    ]
    if not any(sources):
        return None
    if not all(sources) or not math.isfinite(args.bridge_timeout) or not 0 < args.bridge_timeout <= 30:
        raise DeliveryError("bridge configuration is incomplete")
    ops_intake_url = normalize_loopback_http_url(
        args.ops_intake_url,
        required_path="/intake/alertmanager",
    )
    alertmanager_url = normalize_loopback_http_url(
        args.alertmanager_url,
        base_only=True,
    )
    bearer = resolve_ops_intake_bearer()
    try:
        encoded_bearer = bearer.encode("ascii")
    except UnicodeEncodeError:
        raise DeliveryError("bridge bearer is invalid") from None
    if (
        not 16 <= len(encoded_bearer) <= 8 * 1024
        or any(byte < 0x21 or byte > 0x7E for byte in encoded_bearer)
    ):
        raise DeliveryError("bridge bearer is invalid")
    return BridgeConfig(
        ops_intake_url=ops_intake_url,
        alertmanager_url=alertmanager_url,
        bearer=bearer,
        timeout=args.bridge_timeout,
    )


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

    try:
        bridge = _load_bridge(args)
    except MonitoringError:
        print("webhook bridge configuration rejected", file=sys.stderr)
        return 2
    if bridge is not None and args.max_body > MAX_BODY_DEFAULT:
        print("webhook bridge configuration rejected", file=sys.stderr)
        return 2

    config = DeliveryConfig(args.chat_id, args.thread_id)
    app = WebhookApplication(
        path=args.path,
        max_body=args.max_body,
        body_timeout=min(args.body_timeout, 30.0),
        deliver=lambda message: send_telegram(message, config),
        bridge=bridge,
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
