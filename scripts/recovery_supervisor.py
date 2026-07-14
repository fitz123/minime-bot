#!/usr/bin/env python3
"""Node-independent, same-host recovery event supervisor."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import socket
import stat
import sys
import tempfile
import threading
import time
from typing import Any, Callable

from monitoring_native import DeliveryConfig, MonitoringError, send_telegram
from recovery_ledger import LedgerCorrupt, LedgerError, LedgerUnavailable, RecoveryLedger

MAX_BODY_DEFAULT = 256 * 1024
MAX_CONCURRENT_REQUESTS = 16
MAX_ALERTS_PER_REQUEST = 512
SPOOL_ITEM_MAX_BYTES = 16 * 1024
AUTH_TOKEN_MAX_BYTES = 4 * 1024
_SAFE_FIELD = re.compile(r"[^A-Za-z0-9 ._:/@+-]+")
_TRANSITION_ID = re.compile(r"^[a-f0-9]{64}$")
_EMERGENCY_MESSAGES = {
    "ledger_corrupt": "MINIME RECOVERY SUPERVISOR\nledger integrity or schema validation failed",
    "ledger_unavailable": "MINIME RECOVERY SUPERVISOR\nledger unavailable; intake is using the durable spool",
    "persistence_failed": "MINIME RECOVERY SUPERVISOR\nledger and emergency spool persistence failed",
    "spool_corrupt": "MINIME RECOVERY SUPERVISOR\nemergency spool validation failed",
}


class IntakeError(ValueError):
    """A public-safe malformed intake error."""


class SpoolError(OSError):
    """A public-safe durable spool failure."""


def safe_field(value: Any, *, limit: int = 160, default: str = "unknown") -> str:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return default
    cleaned = _SAFE_FIELD.sub("?", str(value).replace("\n", " ").replace("\r", " ")).strip()
    return cleaned[:limit] or default


def transition_id(source: str, fingerprint: str, status: str, transition: str) -> str:
    canonical = json.dumps(
        [source, fingerprint, status, transition],
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    return hashlib.sha256(canonical).hexdigest()


def _decode_object(body: bytes) -> dict[str, Any]:
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
        raise IntakeError("invalid JSON") from None
    if not isinstance(value, dict):
        raise IntakeError("invalid payload")
    return value


def _normalized_event(
    *,
    source: str,
    fingerprint: str,
    code: str,
    status: str,
    transition: str,
    occurred_at: str | None,
    component: str,
    failure_class: str,
) -> dict[str, Any]:
    identity = transition_id(source, fingerprint, status, transition)
    return {
        "code": code,
        "component": component,
        "failure_class": failure_class,
        "fingerprint": fingerprint,
        "occurred_at": occurred_at,
        "source": source,
        "status": status,
        "transition": transition,
        "transition_id": identity,
    }


def normalize_alertmanager(body: bytes) -> list[dict[str, Any]]:
    payload = _decode_object(body)
    alerts = payload.get("alerts")
    if not isinstance(alerts, list) or not alerts or len(alerts) > MAX_ALERTS_PER_REQUEST:
        raise IntakeError("invalid alert batch")
    normalized: list[dict[str, Any]] = []
    for alert in alerts:
        if not isinstance(alert, dict):
            raise IntakeError("invalid alert")
        status_value = alert.get("status")
        if status_value not in {"firing", "resolved"}:
            raise IntakeError("invalid alert status")
        status_name = str(status_value)
        labels = alert.get("labels") if isinstance(alert.get("labels"), dict) else {}
        code = safe_field(labels.get("alertname"))
        component = safe_field(labels.get("component"), default="unmapped")
        failure_class = safe_field(labels.get("failure_class"), default="unmapped")
        instance = safe_field(labels.get("instance"))
        fingerprint_value = alert.get("fingerprint")
        if isinstance(fingerprint_value, str) and fingerprint_value.strip():
            fingerprint = safe_field(fingerprint_value, limit=160)
        else:
            fallback = json.dumps(
                [code, component, failure_class, instance],
                ensure_ascii=True,
                separators=(",", ":"),
            ).encode("ascii")
            fingerprint = hashlib.sha256(fallback).hexdigest()
        occurred_value = alert.get("endsAt") if status_name == "resolved" else alert.get("startsAt")
        if not isinstance(occurred_value, str) or not occurred_value:
            occurred_value = alert.get("startsAt")
        occurred_at = safe_field(occurred_value, limit=80, default="unspecified")
        normalized.append(
            _normalized_event(
                source="alertmanager",
                fingerprint=fingerprint,
                code=code,
                status=status_name,
                transition=occurred_at,
                occurred_at=None if occurred_at == "unspecified" else occurred_at,
                component=component,
                failure_class=failure_class,
            )
        )
    return normalized


def normalize_runtime_doctor(body: bytes) -> list[dict[str, Any]]:
    payload = _decode_object(body)
    events = payload.get("events")
    if payload.get("version") != 1 or not isinstance(events, list) or not events or len(events) > 64:
        raise IntakeError("invalid runtime doctor batch")
    normalized: list[dict[str, Any]] = []
    for event in events:
        if not isinstance(event, dict) or event.get("status") not in {"firing", "resolved"}:
            raise IntakeError("invalid runtime doctor event")
        code = safe_field(event.get("code"))
        status_name = str(event["status"])
        transition = safe_field(event.get("transition"), limit=160, default="")
        if not transition:
            raise IntakeError("runtime doctor transition is missing")
        expected = transition_id("runtime_doctor", code, status_name, transition)
        supplied = event.get("transition_id")
        if not isinstance(supplied, str) or not _TRANSITION_ID.fullmatch(supplied) or supplied != expected:
            raise IntakeError("runtime doctor transition id is invalid")
        normalized.append(
            _normalized_event(
                source="runtime_doctor",
                fingerprint=code,
                code=code,
                status=status_name,
                transition=transition,
                occurred_at=None,
                component="runtime",
                failure_class=code,
            )
        )
    return normalized


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | os.O_CLOEXEC)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class AtomicJsonSpool:
    def __init__(self, path: Path, *, max_item_bytes: int = SPOOL_ITEM_MAX_BYTES):
        self.path = path
        self.max_item_bytes = max_item_bytes
        self._lock = threading.Lock()

    def put(self, key: str, value: dict[str, Any]) -> None:
        data = json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")
        if not data or len(data) > self.max_item_bytes:
            raise SpoolError("spool item is invalid")
        name = f"{hashlib.sha256(key.encode('utf-8')).hexdigest()}.json"
        with self._lock:
            try:
                self.path.mkdir(parents=True, exist_ok=True, mode=0o700)
                destination = self.path / name
                if destination.exists():
                    return
                descriptor, temporary = tempfile.mkstemp(prefix=".pending-", dir=self.path)
                try:
                    os.fchmod(descriptor, 0o600)
                    with os.fdopen(descriptor, "wb") as handle:
                        handle.write(data)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(temporary, destination)
                    _fsync_directory(self.path)
                finally:
                    try:
                        os.unlink(temporary)
                    except FileNotFoundError:
                        pass
            except (OSError, UnicodeError, ValueError) as exc:
                raise SpoolError("spool write failed") from exc

    def items(self) -> list[tuple[Path, dict[str, Any]]]:
        with self._lock:
            try:
                paths = sorted(self.path.glob("*.json")) if self.path.exists() else []
                values: list[tuple[Path, dict[str, Any]]] = []
                for path in paths:
                    if not path.is_file() or path.stat().st_size > self.max_item_bytes:
                        raise SpoolError("spool item validation failed")
                    raw = path.read_bytes()
                    value = json.loads(raw.decode("ascii"))
                    if not isinstance(value, dict):
                        raise SpoolError("spool item validation failed")
                    values.append((path, value))
                return values
            except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
                if isinstance(exc, SpoolError):
                    raise
                raise SpoolError("spool read failed") from exc

    def remove(self, path: Path) -> None:
        with self._lock:
            try:
                path.unlink()
                _fsync_directory(self.path)
            except FileNotFoundError:
                return
            except OSError as exc:
                raise SpoolError("spool removal failed") from exc


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    data = json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


class EmergencyNotifier:
    """Atomic, throttled delivery of fixed messages; never accepts request data."""

    def __init__(
        self,
        spool_path: Path,
        *,
        delivery: Callable[[str], None] | None,
        cooldown: float = 300.0,
        clock: Callable[[], float] = time.time,
    ):
        self.spool = AtomicJsonSpool(spool_path, max_item_bytes=2_048)
        self.state_path = spool_path.parent / "emergency-throttle.json"
        self.delivery = delivery
        self.cooldown = cooldown
        self.clock = clock
        self._lock = threading.Lock()

    def _state(self) -> dict[str, float]:
        try:
            if not self.state_path.exists() or self.state_path.stat().st_size > 8_192:
                return {}
            value = json.loads(self.state_path.read_text("ascii"))
            if not isinstance(value, dict):
                return {}
            return {
                key: float(timestamp)
                for key, timestamp in value.items()
                if key in _EMERGENCY_MESSAGES and isinstance(timestamp, (int, float))
            }
        except (OSError, UnicodeError, ValueError, json.JSONDecodeError):
            return {}

    def emit(self, code: str) -> None:
        if code not in _EMERGENCY_MESSAGES:
            raise ValueError("emergency code is invalid")
        with self._lock:
            now = self.clock()
            state = self._state()
            if now - state.get(code, 0.0) < self.cooldown:
                return
            try:
                self.spool.put(code, {"code": code})
                self._drain_locked(state)
            except SpoolError:
                if self.delivery is not None:
                    try:
                        self.delivery(_EMERGENCY_MESSAGES[code])
                        state[code] = now
                        _atomic_json(self.state_path, state)
                    except (MonitoringError, OSError):
                        pass

    def drain(self) -> None:
        with self._lock:
            self._drain_locked(self._state())

    def _drain_locked(self, state: dict[str, float]) -> None:
        if self.delivery is None:
            return
        for path, item in self.spool.items():
            code = item.get("code")
            if code not in _EMERGENCY_MESSAGES:
                raise SpoolError("emergency spool item is invalid")
            try:
                self.delivery(_EMERGENCY_MESSAGES[code])
            except (MonitoringError, OSError):
                return
            self.spool.remove(path)
            state[code] = self.clock()
            try:
                _atomic_json(self.state_path, state)
            except OSError:
                return


@dataclass(frozen=True)
class IntakeResult:
    status: int
    text: str


class RecoveryService:
    def __init__(
        self,
        ledger: RecoveryLedger,
        event_spool: AtomicJsonSpool,
        emergency: EmergencyNotifier,
    ):
        self.ledger = ledger
        self.event_spool = event_spool
        self.emergency = emergency

    def _drain_events(self) -> None:
        for path, event in self.event_spool.items():
            if not _valid_spooled_event(event):
                raise SpoolError("event spool item is invalid")
            self.ledger.record_events([event])
            self.event_spool.remove(path)

    def accept(self, events: list[dict[str, Any]]) -> IntakeResult:
        try:
            self._drain_events()
        except LedgerError:
            pass
        except SpoolError:
            self.emergency.emit("spool_corrupt")
            return IntakeResult(503, "persistence unavailable")
        try:
            inserted = self.ledger.record_events(events)
            return IntakeResult(200, "accepted" if inserted else "duplicate")
        except LedgerError:
            try:
                for event in events:
                    self.event_spool.put(str(event["transition_id"]), event)
            except (KeyError, SpoolError):
                self.emergency.emit("persistence_failed")
                return IntakeResult(503, "persistence unavailable")
            self.emergency.emit("ledger_unavailable")
            return IntakeResult(202, "durably spooled")

    def health(self) -> IntakeResult:
        try:
            self.ledger.ping()
            self._drain_events()
            self.emergency.drain()
        except LedgerError:
            self.emergency.emit("ledger_unavailable")
            return IntakeResult(503, "unhealthy")
        except SpoolError:
            self.emergency.emit("spool_corrupt")
            return IntakeResult(503, "unhealthy")
        return IntakeResult(200, "ok")

    def maintenance(self) -> None:
        try:
            self._drain_events()
            self.emergency.drain()
        except (LedgerError, SpoolError):
            return


def _valid_spooled_event(event: dict[str, Any]) -> bool:
    required = {
        "code",
        "component",
        "failure_class",
        "fingerprint",
        "occurred_at",
        "source",
        "status",
        "transition",
        "transition_id",
    }
    if set(event) != required or event.get("source") not in {"alertmanager", "runtime_doctor"}:
        return False
    if event.get("status") not in {"firing", "resolved"}:
        return False
    values = [event.get(key) for key in required - {"occurred_at"}]
    if not all(isinstance(value, str) and value for value in values):
        return False
    expected = transition_id(
        str(event["source"]), str(event["fingerprint"]), str(event["status"]), str(event["transition"])
    )
    return hmac.compare_digest(str(event["transition_id"]), expected)


class RecoveryApplication:
    def __init__(
        self,
        *,
        auth_token: str,
        max_body: int,
        body_timeout: float,
        service: RecoveryService,
    ):
        self.auth_header = f"Bearer {auth_token}".encode("utf-8")
        self.max_body = max_body
        self.body_timeout = body_timeout
        self.service = service


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


def handler_for(app: RecoveryApplication) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "MinimeRecoverySupervisor/1"
        sys_version = ""

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(app.body_timeout)

        def log_message(self, _format: str, *_args: object) -> None:
            return

        def _reply(self, status: int, text: str) -> None:
            body = text.encode("ascii")
            self.send_response(status)
            self.send_header("Content-Type", "text/plain; charset=us-ascii")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authenticated(self) -> bool:
            supplied = self.headers.get("Authorization", "").encode("utf-8", "surrogatepass")
            if not hmac.compare_digest(supplied, app.auth_header):
                self._reply(401, "unauthorized")
                return False
            return True

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

        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/healthz":
                self._reply(404, "not found")
                return
            if not self._authenticated():
                return
            result = app.service.health()
            self._reply(result.status, result.text)

        def do_POST(self) -> None:  # noqa: N802
            normalizer = {
                "/v1/alertmanager": normalize_alertmanager,
                "/v1/runtime-doctor": normalize_runtime_doctor,
            }.get(self.path)
            if normalizer is None:
                self._reply(404, "not found")
                return
            if not self._authenticated():
                return
            raw_length = self.headers.get("Content-Length")
            try:
                length = int(raw_length) if raw_length is not None else -1
            except ValueError:
                length = -1
            if length < 0:
                self._reply(411, "length required")
                return
            if length > app.max_body:
                self._reply(413, "payload too large")
                return
            if self.headers.get_content_type() != "application/json":
                self._reply(415, "JSON required")
                return
            try:
                body = self._read_body(length)
                events = normalizer(body)
            except (TimeoutError, OSError):
                self._reply(408, "request timed out")
                return
            except IntakeError:
                self._reply(400, "invalid payload")
                return
            result = app.service.accept(events)
            self._reply(result.status, result.text)

    return Handler


def read_auth_token(path: Path) -> str:
    descriptor: int | None = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or not 16 <= metadata.st_size <= AUTH_TOKEN_MAX_BYTES:
            raise ValueError("authentication token file is invalid")
        raw = os.read(descriptor, AUTH_TOKEN_MAX_BYTES + 1)
        token = raw.decode("utf-8").strip()
        if len(raw) > AUTH_TOKEN_MAX_BYTES or not 16 <= len(token) or "\n" in token or "\r" in token:
            raise ValueError("authentication token file is invalid")
        token.encode("ascii")
        return token
    except (OSError, UnicodeError) as exc:
        raise ValueError("authentication token file is invalid") from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the same-host minime recovery supervisor")
    parser.add_argument("--host", default=os.environ.get("MINIME_RECOVERY_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=os.environ.get("MINIME_RECOVERY_PORT", "9877"))
    parser.add_argument("--db", default=os.environ.get("MINIME_RECOVERY_DB_PATH", ""))
    parser.add_argument("--spool-dir", default=os.environ.get("MINIME_RECOVERY_SPOOL_DIR", ""))
    parser.add_argument(
        "--auth-token-file", default=os.environ.get("MINIME_RECOVERY_AUTH_TOKEN_FILE", "")
    )
    parser.add_argument("--max-body", type=int, default=MAX_BODY_DEFAULT)
    parser.add_argument("--body-timeout", type=float, default=5.0)
    parser.add_argument("--max-concurrent", type=int, default=MAX_CONCURRENT_REQUESTS)
    parser.add_argument("--busy-timeout-ms", type=int, default=2_000)
    parser.add_argument("--emergency-cooldown", type=float, default=300.0)
    parser.add_argument("--chat-id", default=os.environ.get("MINIME_TELEGRAM_CHAT_ID", ""))
    parser.add_argument("--thread-id", default=os.environ.get("MINIME_TELEGRAM_THREAD_ID"))
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if (
        args.host not in {"127.0.0.1", "localhost"}
        or not 0 <= args.port <= 65535
        or not args.db
        or not args.spool_dir
        or not args.auth_token_file
        or not 1 <= args.max_body <= 4 * 1024 * 1024
        or not 1 <= args.max_concurrent <= 128
        or not 1 <= args.busy_timeout_ms <= 30_000
        or not math.isfinite(args.body_timeout)
        or not 0 < args.body_timeout <= 30
        or not math.isfinite(args.emergency_cooldown)
        or not 0 <= args.emergency_cooldown <= 86_400
    ):
        print("recovery supervisor configuration rejected", file=sys.stderr)
        return 2
    try:
        token = read_auth_token(Path(args.auth_token_file))
    except ValueError:
        print("recovery supervisor configuration rejected", file=sys.stderr)
        return 2

    spool_root = Path(args.spool_dir)
    delivery = None
    if args.chat_id:
        telegram_config = DeliveryConfig(args.chat_id, args.thread_id)
        delivery = lambda message: send_telegram(message, telegram_config)
    emergency = EmergencyNotifier(
        spool_root / "notifications",
        delivery=delivery,
        cooldown=args.emergency_cooldown,
    )
    try:
        ledger = RecoveryLedger(Path(args.db), busy_timeout_ms=args.busy_timeout_ms)
    except LedgerCorrupt:
        emergency.emit("ledger_corrupt")
        print("recovery supervisor ledger validation failed", file=sys.stderr)
        return 1
    except LedgerUnavailable:
        emergency.emit("ledger_unavailable")
        print("recovery supervisor ledger unavailable", file=sys.stderr)
        return 1
    app = RecoveryApplication(
        auth_token=token,
        max_body=args.max_body,
        body_timeout=args.body_timeout,
        service=RecoveryService(ledger, AtomicJsonSpool(spool_root / "events"), emergency),
    )
    try:
        server = BoundedThreadingHTTPServer(
            (args.host, args.port),
            handler_for(app),
            max_concurrent_requests=args.max_concurrent,
        )
    except OSError:
        ledger.close()
        print("recovery supervisor failed to bind", file=sys.stderr)
        return 1
    server.timeout = 1.0
    print("recovery supervisor ready", flush=True)
    try:
        while True:
            server.handle_request()
            app.service.maintenance()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        ledger.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
