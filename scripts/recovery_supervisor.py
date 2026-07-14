#!/usr/bin/env python3
"""Node-independent, same-host recovery event supervisor."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
from pathlib import Path
import re
import secrets
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
_EMPTY_EVIDENCE_HASH = hashlib.sha256(b"[]").hexdigest()
_INVOCATION_OUTCOMES = {
    "completed",
    "malformed_output",
    "not_actionable",
    "observe",
    "pending_approval",
    "retries_exhausted",
}
_REEVALUATABLE_OUTCOMES = {"malformed_output", "not_actionable", "observe"}


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


@dataclass(frozen=True)
class CorrelationRule:
    """Map one normalized component/failure class to a shared incident key."""

    component: str
    failure_class: str
    incident_key: str
    impact: int = 1

    def __post_init__(self) -> None:
        for name, value in (
            ("component", self.component),
            ("failure class", self.failure_class),
            ("incident key", self.incident_key),
        ):
            if not isinstance(value, str) or safe_field(value, default="") != value:
                raise ValueError(f"correlation {name} is invalid")
        if not isinstance(self.impact, int) or not 0 <= self.impact <= 3:
            raise ValueError("correlation impact is invalid")


@dataclass(frozen=True)
class RecoveryPolicy:
    """Small deterministic policy surface used before configurable controls exist."""

    revision: int
    rules: tuple[CorrelationRule, ...]
    reevaluation_delays: tuple[tuple[str, float], ...] = (
        ("malformed_output", 900.0),
        ("not_actionable", 900.0),
        ("observe", 900.0),
    )
    max_reevaluations: int = 1
    max_crash_retries: int = 1
    lease_seconds: float = 120.0

    def __post_init__(self) -> None:
        if not isinstance(self.revision, int) or self.revision < 1:
            raise ValueError("recovery policy revision is invalid")
        if not isinstance(self.rules, tuple) or not all(
            isinstance(rule, CorrelationRule) for rule in self.rules
        ):
            raise ValueError("recovery correlation rules are invalid")
        rule_keys = [(rule.component, rule.failure_class) for rule in self.rules]
        if len(rule_keys) != len(set(rule_keys)):
            raise ValueError("recovery correlation rules overlap")
        delays = dict(self.reevaluation_delays)
        if len(delays) != len(self.reevaluation_delays) or any(
            outcome not in _REEVALUATABLE_OUTCOMES
            or isinstance(delay, bool)
            or not isinstance(delay, (int, float))
            or not math.isfinite(delay)
            or not 1 <= delay <= 86_400
            for outcome, delay in self.reevaluation_delays
        ):
            raise ValueError("recovery reevaluation bounds are invalid")
        if not isinstance(self.max_reevaluations, int) or not 0 <= self.max_reevaluations <= 10:
            raise ValueError("recovery reevaluation count is invalid")
        if not isinstance(self.max_crash_retries, int) or not 0 <= self.max_crash_retries <= 10:
            raise ValueError("recovery crash retry count is invalid")
        if (
            isinstance(self.lease_seconds, bool)
            or not isinstance(self.lease_seconds, (int, float))
            or not math.isfinite(self.lease_seconds)
            or not 1 <= self.lease_seconds <= 3_600
        ):
            raise ValueError("recovery lease duration is invalid")


@dataclass(frozen=True)
class InvocationFence:
    invocation_id: int
    incident_id: int
    generation: int
    evidence_hash: str
    policy_revision: int
    lease_token: str
    owner: str


def _event_time(row: Any, event: dict[str, Any]) -> tuple[float, int, int]:
    timestamp = float(row["received_at"])
    occurred_at = event.get("occurred_at")
    if isinstance(occurred_at, str) and occurred_at:
        try:
            parsed = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            timestamp = parsed.timestamp()
        except (OverflowError, ValueError):
            pass
    return timestamp, 1 if event.get("status") == "resolved" else 0, int(row["id"])


class IncidentCoordinator:
    """Correlate durable events and own fenced, globally serialized invocations."""

    def __init__(
        self,
        ledger: RecoveryLedger,
        policy: RecoveryPolicy,
        *,
        owner: str,
        clock: Callable[[], float] = time.time,
    ):
        if not isinstance(owner, str) or safe_field(owner, default="") != owner:
            raise ValueError("recovery owner is invalid")
        self.ledger = ledger
        self.policy = policy
        self.owner = owner
        self.clock = clock
        self._rules = {
            (rule.component, rule.failure_class): rule for rule in self.policy.rules
        }

    def _verify_policy_revision(self, connection: Any) -> None:
        row = connection.execute(
            "SELECT 1 FROM policy_revisions WHERE revision = ?",
            (self.policy.revision,),
        ).fetchone()
        if row is None:
            raise LedgerCorrupt("configured recovery policy revision is missing")

    def _active_evidence(self, connection: Any) -> dict[str, str]:
        latest: dict[tuple[str, str], tuple[tuple[float, int, int], dict[str, Any]]] = {}
        rows = connection.execute(
            "SELECT id, source, fingerprint, status, received_at, normalized_json FROM events"
        ).fetchall()
        for row in rows:
            try:
                event = json.loads(row["normalized_json"])
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise LedgerCorrupt("normalized recovery evidence is invalid") from exc
            if (
                not isinstance(event, dict)
                or not _valid_spooled_event(event)
                or event["source"] != row["source"]
                or event["fingerprint"] != row["fingerprint"]
                or event["status"] != row["status"]
            ):
                raise LedgerCorrupt("normalized recovery evidence is invalid")
            identity = (str(row["source"]), str(row["fingerprint"]))
            order = _event_time(row, event)
            previous = latest.get(identity)
            if previous is None or order > previous[0]:
                latest[identity] = (order, event)

        grouped: dict[str, list[list[Any]]] = {}
        for _order, event in latest.values():
            if event["status"] != "firing":
                continue
            rule = self._rules.get((event["component"], event["failure_class"]))
            if rule is None:
                continue
            grouped.setdefault(rule.incident_key, []).append(
                [
                    event["source"],
                    event["fingerprint"],
                    event["code"],
                    event["component"],
                    event["failure_class"],
                    event["transition_id"],
                    rule.impact,
                ]
            )
        return {
            key: hashlib.sha256(
                json.dumps(sorted(items), ensure_ascii=True, separators=(",", ":")).encode("ascii")
            ).hexdigest()
            for key, items in grouped.items()
        }

    @staticmethod
    def _invalidate_invocation(connection: Any, incident_id: int, now: float) -> None:
        active = connection.execute(
            "SELECT lease_token FROM invocations WHERE incident_id = ? AND state = 'active'",
            (incident_id,),
        ).fetchall()
        if not active:
            return
        tokens = [str(row["lease_token"]) for row in active]
        connection.execute(
            "UPDATE invocations SET state = 'stale', updated_at = ? "
            "WHERE incident_id = ? AND state = 'active'",
            (now, incident_id),
        )
        for token in tokens:
            connection.execute(
                "UPDATE fixer_lease SET owner = NULL, token = NULL, acquired_at = NULL, "
                "expires_at = NULL WHERE singleton = 1 AND token = ?",
                (token,),
            )

    def _interrupt_orphans(self, connection: Any, now: float) -> None:
        lease = connection.execute(
            "SELECT token, expires_at FROM fixer_lease WHERE singleton = 1"
        ).fetchone()
        valid_token = None
        if lease is not None and lease["token"] is not None and float(lease["expires_at"]) > now:
            valid_token = str(lease["token"])
        active = connection.execute(
            "SELECT id, incident_id, generation, evidence_hash, policy_revision, lease_token "
            "FROM invocations WHERE state = 'active'"
        ).fetchall()
        for invocation in active:
            if invocation["lease_token"] == valid_token:
                continue
            connection.execute(
                "UPDATE invocations SET state = 'interrupted', updated_at = ? WHERE id = ?",
                (now, invocation["id"]),
            )
            incident = connection.execute(
                "SELECT generation, evidence_hash, policy_revision, state FROM incidents WHERE id = ?",
                (invocation["incident_id"],),
            ).fetchone()
            if (
                incident is None
                or incident["generation"] != invocation["generation"]
                or incident["evidence_hash"] != invocation["evidence_hash"]
                or incident["policy_revision"] != invocation["policy_revision"]
                or incident["state"] == "resolved"
            ):
                continue
            interruptions = connection.execute(
                "SELECT count(*) FROM invocations WHERE incident_id = ? AND evidence_hash = ? "
                "AND policy_revision = ? AND state = 'interrupted'",
                (
                    invocation["incident_id"],
                    invocation["evidence_hash"],
                    invocation["policy_revision"],
                ),
            ).fetchone()[0]
            next_state = (
                "eligible"
                if interruptions <= self.policy.max_crash_retries
                else "retries_exhausted"
            )
            connection.execute(
                "UPDATE incidents SET generation = generation + 1, state = ?, updated_at = ? "
                "WHERE id = ?",
                (next_state, now, invocation["incident_id"]),
            )
        if valid_token is None:
            connection.execute(
                "UPDATE fixer_lease SET owner = NULL, token = NULL, acquired_at = NULL, "
                "expires_at = NULL WHERE singleton = 1"
            )

    def _reevaluation_due(self, connection: Any, incident: Any, now: float) -> bool:
        state = str(incident["state"])
        delay = dict(self.policy.reevaluation_delays).get(state)
        if delay is None or now - float(incident["updated_at"]) < delay:
            return False
        attempts = connection.execute(
            "SELECT count(*) FROM invocations WHERE incident_id = ? AND evidence_hash = ? "
            "AND policy_revision = ? AND state IN ('malformed_output', 'not_actionable', 'observe')",
            (incident["id"], incident["evidence_hash"], incident["policy_revision"]),
        ).fetchone()[0]
        return attempts <= self.policy.max_reevaluations

    def reconcile(self) -> int:
        """Rebuild active incidents from the durable event stream."""

        now = self.clock()
        with self.ledger.transaction() as connection:
            self._verify_policy_revision(connection)
            self._interrupt_orphans(connection, now)
            evidence = self._active_evidence(connection)
            incidents = {
                str(row["correlation_key"]): row
                for row in connection.execute("SELECT * FROM incidents").fetchall()
            }
            for correlation_key, evidence_hash in sorted(evidence.items()):
                incident = incidents.get(correlation_key)
                if incident is None:
                    connection.execute(
                        "INSERT INTO incidents(correlation_key, state, generation, evidence_hash, "
                        "policy_revision, opened_at, updated_at) VALUES (?, 'eligible', 1, ?, ?, ?, ?)",
                        (correlation_key, evidence_hash, self.policy.revision, now, now),
                    )
                    continue
                changed = (
                    incident["evidence_hash"] != evidence_hash
                    or incident["policy_revision"] != self.policy.revision
                    or incident["state"] == "resolved"
                )
                if changed:
                    self._invalidate_invocation(connection, int(incident["id"]), now)
                    connection.execute(
                        "UPDATE incidents SET state = 'eligible', generation = generation + 1, "
                        "evidence_hash = ?, policy_revision = ?, updated_at = ? WHERE id = ?",
                        (evidence_hash, self.policy.revision, now, incident["id"]),
                    )
                elif self._reevaluation_due(connection, incident, now):
                    connection.execute(
                        "UPDATE incidents SET state = 'eligible', generation = generation + 1, "
                        "updated_at = ? WHERE id = ?",
                        (now, incident["id"]),
                    )

            for correlation_key, incident in incidents.items():
                if correlation_key in evidence or incident["state"] == "resolved":
                    continue
                self._invalidate_invocation(connection, int(incident["id"]), now)
                connection.execute(
                    "UPDATE incidents SET state = 'resolved', generation = generation + 1, "
                    "evidence_hash = ?, policy_revision = ?, updated_at = ? WHERE id = ?",
                    (_EMPTY_EVIDENCE_HASH, self.policy.revision, now, incident["id"]),
                )
            return len(evidence)

    def claim_next(self) -> InvocationFence | None:
        """Acquire the one global lease and atomically create one invocation."""

        self.reconcile()
        now = self.clock()
        with self.ledger.transaction() as connection:
            lease = connection.execute(
                "SELECT owner, token, expires_at FROM fixer_lease WHERE singleton = 1"
            ).fetchone()
            if lease["token"] is not None and float(lease["expires_at"]) > now:
                return None
            incident = connection.execute(
                "SELECT * FROM incidents WHERE state = 'eligible' AND evidence_hash != ? "
                "ORDER BY opened_at, id LIMIT 1",
                (_EMPTY_EVIDENCE_HASH,),
            ).fetchone()
            if incident is None:
                return None
            token = secrets.token_hex(24)
            connection.execute(
                "UPDATE fixer_lease SET owner = ?, token = ?, acquired_at = ?, expires_at = ? "
                "WHERE singleton = 1",
                (self.owner, token, now, now + self.policy.lease_seconds),
            )
            cursor = connection.execute(
                "INSERT INTO invocations(incident_id, generation, evidence_hash, policy_revision, "
                "lease_token, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
                (
                    incident["id"],
                    incident["generation"],
                    incident["evidence_hash"],
                    incident["policy_revision"],
                    token,
                    now,
                    now,
                ),
            )
            connection.execute(
                "UPDATE incidents SET state = 'invoking', updated_at = ? WHERE id = ?",
                (now, incident["id"]),
            )
            return InvocationFence(
                invocation_id=int(cursor.lastrowid),
                incident_id=int(incident["id"]),
                generation=int(incident["generation"]),
                evidence_hash=str(incident["evidence_hash"]),
                policy_revision=int(incident["policy_revision"]),
                lease_token=token,
                owner=self.owner,
            )

    def finish(self, fence: InvocationFence, outcome: str) -> bool:
        """Accept a planner result only while every durable fence still matches."""

        if outcome not in _INVOCATION_OUTCOMES:
            raise ValueError("recovery invocation outcome is invalid")
        now = self.clock()
        with self.ledger.transaction() as connection:
            self._verify_policy_revision(connection)
            incident = connection.execute(
                "SELECT * FROM incidents WHERE id = ?",
                (fence.incident_id,),
            ).fetchone()
            if incident is None or incident["policy_revision"] != self.policy.revision:
                return False
            current_hash = self._active_evidence(connection).get(
                str(incident["correlation_key"]), _EMPTY_EVIDENCE_HASH
            )
            if current_hash != incident["evidence_hash"]:
                self._invalidate_invocation(connection, fence.incident_id, now)
                state = "resolved" if current_hash == _EMPTY_EVIDENCE_HASH else "eligible"
                connection.execute(
                    "UPDATE incidents SET state = ?, generation = generation + 1, "
                    "evidence_hash = ?, updated_at = ? WHERE id = ?",
                    (state, current_hash, now, fence.incident_id),
                )
                return False
            invocation = connection.execute(
                "SELECT * FROM invocations WHERE id = ?",
                (fence.invocation_id,),
            ).fetchone()
            lease = connection.execute(
                "SELECT owner, token, expires_at FROM fixer_lease WHERE singleton = 1"
            ).fetchone()
            valid = (
                invocation is not None
                and incident is not None
                and invocation["state"] == "active"
                and invocation["incident_id"] == fence.incident_id
                and invocation["generation"] == fence.generation
                and invocation["evidence_hash"] == fence.evidence_hash
                and invocation["policy_revision"] == fence.policy_revision
                and invocation["lease_token"] == fence.lease_token
                and incident["generation"] == fence.generation
                and incident["evidence_hash"] == fence.evidence_hash
                and incident["policy_revision"] == fence.policy_revision
                and lease["owner"] == fence.owner
                and lease["token"] == fence.lease_token
                and float(lease["expires_at"]) > now
            )
            if not valid:
                return False
            connection.execute(
                "UPDATE invocations SET state = ?, updated_at = ? WHERE id = ?",
                (outcome, now, fence.invocation_id),
            )
            connection.execute(
                "UPDATE incidents SET state = ?, updated_at = ? WHERE id = ?",
                (outcome, now, fence.incident_id),
            )
            connection.execute(
                "UPDATE fixer_lease SET owner = NULL, token = NULL, acquired_at = NULL, "
                "expires_at = NULL WHERE singleton = 1 AND token = ?",
                (fence.lease_token,),
            )
            return True

    def explicit_retry(self, incident_id: int, *, reason: str) -> bool:
        """Create one auditable generation without weakening dispatch fences."""

        if not isinstance(incident_id, int) or incident_id < 1:
            raise ValueError("recovery incident id is invalid")
        if not isinstance(reason, str) or safe_field(reason, default="") != reason:
            raise ValueError("recovery retry reason is invalid")
        now = self.clock()
        with self.ledger.transaction() as connection:
            incident = connection.execute(
                "SELECT * FROM incidents WHERE id = ?",
                (incident_id,),
            ).fetchone()
            if (
                incident is None
                or incident["state"] in {"invoking", "resolved"}
                or incident["evidence_hash"] == _EMPTY_EVIDENCE_HASH
            ):
                return False
            connection.execute(
                "UPDATE incidents SET state = 'eligible', generation = generation + 1, "
                "updated_at = ? WHERE id = ?",
                (now, incident_id),
            )
            connection.execute(
                "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                "VALUES (?, ?, 'explicit_retry', ?, ?)",
                (
                    now,
                    self.owner,
                    f"incident:{incident_id}",
                    json.dumps({"reason": reason}, ensure_ascii=True, separators=(",", ":")),
                ),
            )
            return True


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
        coordinator: IncidentCoordinator | None = None,
    ):
        self.ledger = ledger
        self.event_spool = event_spool
        self.emergency = emergency
        self.coordinator = coordinator

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
            if self.coordinator is not None:
                self.coordinator.reconcile()
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
            if self.coordinator is not None:
                self.coordinator.reconcile()
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
            if self.coordinator is not None:
                self.coordinator.reconcile()
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
    coordinator = IncidentCoordinator(
        ledger,
        RecoveryPolicy(revision=1, rules=()),
        owner=f"supervisor-{os.getpid()}",
    )
    app = RecoveryApplication(
        auth_token=token,
        max_body=args.max_body,
        body_timeout=args.body_timeout,
        service=RecoveryService(
            ledger,
            AtomicJsonSpool(spool_root / "events"),
            emergency,
            coordinator,
        ),
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
