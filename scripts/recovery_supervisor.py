#!/usr/bin/env python3
"""Node-independent, same-host recovery event supervisor."""

from __future__ import annotations

import argparse
import copy
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
import signal
import socket
import stat
import sys
import tempfile
import threading
import time
from typing import Any, Callable

from monitoring_native import (
    DeliveryConfig,
    MonitoringError,
    read_private_ascii_token,
    send_telegram,
)
from recovery_config import (
    RECOVERY_MODES,
    RecoveryConfig,
    RecoveryConfigError,
    load_recovery_config,
    recovery_static_policy,
)
from recovery_ledger import LedgerCorrupt, LedgerError, LedgerUnavailable, RecoveryLedger

MAX_BODY_DEFAULT = 256 * 1024
MAX_CONCURRENT_REQUESTS = 16
MAX_ALERTS_PER_REQUEST = 512
SPOOL_ITEM_MAX_BYTES = 1024 * 1024
AUTH_TOKEN_MAX_BYTES = 4 * 1024
_SAFE_FIELD = re.compile(r"[^A-Za-z0-9 ._:/@+-]+")
_TRANSITION_ID = re.compile(r"^[a-f0-9]{64}$")
_EMERGENCY_MESSAGES = {
    "ledger_corrupt": "MINIME RECOVERY SUPERVISOR\nledger integrity or schema validation failed",
    "ledger_unavailable": "MINIME RECOVERY SUPERVISOR\nledger unavailable; intake is using the durable spool",
    "persistence_failed": "MINIME RECOVERY SUPERVISOR\nledger and emergency spool persistence failed",
    "spool_corrupt": "MINIME RECOVERY SUPERVISOR\nemergency spool validation failed",
    "confirmed_impact": "MINIME RECOVERY SUPERVISOR\ncritical impact confirmed",
    "recovery_unsafe": "MINIME RECOVERY SUPERVISOR\nrecovery was refused as unsafe",
    "recovery_failed": "MINIME RECOVERY SUPERVISOR\nrecovery action or verification failed",
    "retries_exhausted": "MINIME RECOVERY SUPERVISOR\nrecovery retry budget exhausted",
    "supervisor_unavailable": "MINIME RECOVERY SUPERVISOR\nsupervisor unavailable",
}
_IMMEDIATE_ESCALATION_REASONS = frozenset(
    {
        "confirmed_impact",
        "recovery_unsafe",
        "recovery_failed",
        "retries_exhausted",
        "supervisor_unavailable",
        "persistence_failed",
    }
)
_EMPTY_EVIDENCE_HASH = hashlib.sha256(b"[]").hexdigest()
_INVOCATION_OUTCOMES = {
    "completed",
    "recovery_failed",
    "recovery_unsafe",
    "retries_exhausted",
}
_CONTROL_POLICY_KEY = "recovery_controls"
_STATIC_POLICY_KEY = "recovery_static"
_EFFECTIVE_POLICY_REVISION_KEY = "effective_policy_revision"
_CONTROL_POLICY_VERSION = 1
_CONFIRMATION_BOUNDS = (1, 5)
_COOLDOWN_BOUNDS = (0.0, 86_400.0)
_RETRY_BUDGET_BOUNDS = (0, 10)
_MAX_CONTROL_TTL = 31 * 86_400.0


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


def _normalize_runtime_doctor_payload(
    body: bytes,
) -> tuple[list[dict[str, Any]], dict[str, bool]]:
    payload = _decode_object(body)
    events = payload.get("events")
    raw_heartbeats = payload.get("heartbeats", {"runtime_doctor": True})
    if (
        payload.get("version") != 1
        or not isinstance(events, list)
        or len(events) > 64
        or not isinstance(raw_heartbeats, dict)
        or not raw_heartbeats
        or len(raw_heartbeats) > 2
        or any(
            source not in {"runtime_doctor", "alertmanager"}
            or not isinstance(healthy, bool)
            for source, healthy in raw_heartbeats.items()
        )
        or (not events and "heartbeats" not in payload)
    ):
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
    return normalized, {str(source): bool(healthy) for source, healthy in raw_heartbeats.items()}


def normalize_runtime_doctor(body: bytes) -> list[dict[str, Any]]:
    """Compatibility wrapper returning normalized transition events only."""

    return _normalize_runtime_doctor_payload(body)[0]


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


@dataclass(frozen=True)
class ControlSnapshot:
    """Effective bounded dispatch controls at one immutable policy revision."""

    revision: int
    dispatch_enabled: bool
    confirmation_count: int
    cooldown_seconds: float
    retry_budget: int
    silences: tuple[tuple[str, float], ...]

    def silence_expiry(self, correlation_key: str, now: float) -> float | None:
        for target, expires_at in self.silences:
            if target == correlation_key and expires_at > now:
                return expires_at
        return None


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _default_control_state() -> dict[str, Any]:
    return {
        "version": _CONTROL_POLICY_VERSION,
        "dispatch": {"value": True, "expires_at": None, "revert": True},
        "confirmation_count": {"value": 1, "expires_at": None, "revert": 1},
        "cooldown_seconds": {"value": 0.0, "expires_at": None, "revert": 0.0},
        "retry_budget": {"value": 1, "expires_at": None, "revert": 1},
        "silences": {},
    }


class RecoveryControls:
    """Immutable policy revisions plus complete, public-safe control audits."""

    def __init__(
        self,
        ledger: RecoveryLedger,
        *,
        base_revision: int = 1,
        clock: Callable[[], float] = time.time,
    ):
        if not isinstance(base_revision, int) or base_revision < 1:
            raise ValueError("recovery control base revision is invalid")
        self.ledger = ledger
        self.base_revision = base_revision
        self.clock = clock

    @staticmethod
    def _operator(actor: str, reason: str) -> None:
        if not isinstance(actor, str) or safe_field(actor, limit=80, default="") != actor:
            raise ValueError("recovery control actor is invalid")
        if not isinstance(reason, str) or safe_field(reason, limit=160, default="") != reason:
            raise ValueError("recovery control reason is invalid")

    @staticmethod
    def _expiry(expires_at: float | None, now: float, *, required: bool = False) -> None:
        if expires_at is None:
            if required:
                raise ValueError("recovery control expiry is required")
            return
        if (
            isinstance(expires_at, bool)
            or not isinstance(expires_at, (int, float))
            or not math.isfinite(expires_at)
            or not now < float(expires_at) <= now + _MAX_CONTROL_TTL
        ):
            raise ValueError("recovery control expiry is invalid")

    @staticmethod
    def _document(row: Any) -> dict[str, Any]:
        try:
            document = json.loads(str(row["policy_json"]))
        except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise LedgerCorrupt("recovery control policy is invalid") from exc
        if not isinstance(document, dict):
            raise LedgerCorrupt("recovery control policy is invalid")
        return document

    @staticmethod
    def _state(document: dict[str, Any]) -> dict[str, Any]:
        raw = document.get(_CONTROL_POLICY_KEY)
        if raw is None:
            return _default_control_state()
        if not isinstance(raw, dict) or set(raw) != {
            "version",
            "dispatch",
            "confirmation_count",
            "cooldown_seconds",
            "retry_budget",
            "silences",
        }:
            raise LedgerCorrupt("recovery control policy is invalid")
        state = copy.deepcopy(raw)
        if state.get("version") != _CONTROL_POLICY_VERSION:
            raise LedgerCorrupt("recovery control policy version mismatch")
        entries = (
            ("dispatch", bool, None),
            ("confirmation_count", int, _CONFIRMATION_BOUNDS),
            ("cooldown_seconds", (int, float), _COOLDOWN_BOUNDS),
            ("retry_budget", int, _RETRY_BUDGET_BOUNDS),
        )
        for name, expected_type, bounds in entries:
            entry = state.get(name)
            if not isinstance(entry, dict) or set(entry) != {"value", "expires_at", "revert"}:
                raise LedgerCorrupt("recovery control policy is invalid")
            for key in ("value", "revert"):
                value = entry.get(key)
                if isinstance(value, bool) != (expected_type is bool) or not isinstance(
                    value, expected_type
                ):
                    raise LedgerCorrupt("recovery control policy is invalid")
                if bounds is not None and not bounds[0] <= value <= bounds[1]:
                    raise LedgerCorrupt("recovery control policy is invalid")
            expiry = entry.get("expires_at")
            if expiry is not None and (
                isinstance(expiry, bool)
                or not isinstance(expiry, (int, float))
                or not math.isfinite(expiry)
            ):
                raise LedgerCorrupt("recovery control policy is invalid")
        silences = state.get("silences")
        if not isinstance(silences, dict) or len(silences) > 128:
            raise LedgerCorrupt("recovery control policy is invalid")
        for target, expiry in silences.items():
            if (
                not isinstance(target, str)
                or safe_field(target, default="") != target
                or isinstance(expiry, bool)
                or not isinstance(expiry, (int, float))
                or not math.isfinite(expiry)
            ):
                raise LedgerCorrupt("recovery control policy is invalid")
        return state

    def _current_row(self, connection: Any) -> Any:
        pointer = connection.execute(
            "SELECT value FROM metadata WHERE key = ?",
            (_EFFECTIVE_POLICY_REVISION_KEY,),
        ).fetchone()
        revision: int | None = None
        if pointer is not None:
            try:
                revision = int(str(pointer["value"]))
            except (TypeError, ValueError) as exc:
                raise LedgerCorrupt("effective recovery policy revision is invalid") from exc
            if revision < 1:
                raise LedgerCorrupt("effective recovery policy revision is invalid")
        row = None
        if revision is not None and revision >= self.base_revision:
            row = connection.execute(
                "SELECT revision, policy_json FROM policy_revisions WHERE revision = ?",
                (revision,),
            ).fetchone()
            if row is None:
                raise LedgerCorrupt("effective recovery policy revision is missing")
        if row is None:
            row = connection.execute(
                "SELECT revision, policy_json FROM policy_revisions "
                "WHERE revision >= ? ORDER BY revision DESC LIMIT 1",
                (self.base_revision,),
            ).fetchone()
        if row is None:
            raise LedgerCorrupt("configured recovery policy revision is missing")
        if revision != int(row["revision"]):
            connection.execute(
                "INSERT INTO metadata(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (_EFFECTIVE_POLICY_REVISION_KEY, str(int(row["revision"]))),
            )
        return row

    def current(self, connection: Any | None = None, *, now: float | None = None) -> ControlSnapshot:
        timestamp = self.clock() if now is None else now
        if connection is None:
            with self.ledger.transaction() as current_connection:
                return self.current(current_connection, now=timestamp)
        row = self._current_row(connection)
        state = self._state(self._document(row))

        def effective(name: str) -> Any:
            entry = state[name]
            expiry = entry["expires_at"]
            return entry["revert"] if expiry is not None and expiry <= timestamp else entry["value"]

        return ControlSnapshot(
            revision=int(row["revision"]),
            dispatch_enabled=bool(effective("dispatch")),
            confirmation_count=int(effective("confirmation_count")),
            cooldown_seconds=float(effective("cooldown_seconds")),
            retry_budget=int(effective("retry_budget")),
            silences=tuple(
                sorted((str(target), float(expiry)) for target, expiry in state["silences"].items())
            ),
        )

    @staticmethod
    def _next_revision(connection: Any) -> int:
        return int(connection.execute("SELECT max(revision) FROM policy_revisions").fetchone()[0]) + 1

    def append_revision(
        self,
        connection: Any,
        document: dict[str, Any],
        *,
        operation: str,
        target: str,
        actor: str,
        reason: str,
        expires_at: float | None,
        before: Any,
        after: Any,
        now: float,
        effective: bool = True,
    ) -> int:
        self._operator(actor, reason)
        revision = self._next_revision(connection)
        connection.execute(
            "INSERT INTO policy_revisions(revision, created_at, actor, reason, policy_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (revision, now, actor, reason, _canonical_json(document)),
        )
        if effective:
            connection.execute(
                "INSERT INTO metadata(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (_EFFECTIVE_POLICY_REVISION_KEY, str(revision)),
            )
        details = {
            "after": after,
            "before": before,
            "expires_at": expires_at,
            "reason": reason,
            "revision": revision,
        }
        connection.execute(
            "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
            "VALUES (?, ?, ?, ?, ?)",
            (now, actor, operation, target, _canonical_json(details)),
        )
        return revision

    def _change(
        self,
        *,
        operation: str,
        target: str,
        actor: str,
        reason: str,
        expires_at: float | None,
        mutate: Callable[[dict[str, Any]], tuple[Any, Any]],
        now: float | None = None,
    ) -> int:
        timestamp = self.clock() if now is None else now
        self._operator(actor, reason)
        self._expiry(expires_at, timestamp)
        with self.ledger.transaction() as connection:
            row = self._current_row(connection)
            document = self._document(row)
            state = self._state(document)
            before, after = mutate(state)
            updated = copy.deepcopy(document)
            updated[_CONTROL_POLICY_KEY] = state
            return self.append_revision(
                connection,
                updated,
                operation=operation,
                target=target,
                actor=actor,
                reason=reason,
                expires_at=expires_at,
                before=before,
                after=after,
                now=timestamp,
            )

    def ensure_static_policy(self, policy: dict[str, Any]) -> int:
        """Fence invocations to the exact dispatch-relevant static configuration."""

        if not isinstance(policy, dict):
            raise ValueError("recovery static policy is invalid")
        timestamp = self.clock()
        canonical = _canonical_json(policy)
        with self.ledger.transaction() as connection:
            row = self._current_row(connection)
            document = self._document(row)
            current = document.get(_STATIC_POLICY_KEY)
            if current is not None and _canonical_json(current) == canonical:
                return int(row["revision"])
            updated = copy.deepcopy(document)
            updated[_STATIC_POLICY_KEY] = copy.deepcopy(policy)
            before_hash = (
                hashlib.sha256(_canonical_json(current).encode("ascii")).hexdigest()
                if current is not None
                else None
            )
            after_hash = hashlib.sha256(canonical.encode("ascii")).hexdigest()
            return self.append_revision(
                connection,
                updated,
                operation="static_policy_configured",
                target="policy",
                actor="system",
                reason="validated recovery configuration",
                expires_at=None,
                before={"hash": before_hash},
                after={"hash": after_hash},
                now=timestamp,
            )

    @staticmethod
    def _replace_entry(
        state: dict[str, Any],
        name: str,
        value: Any,
        expires_at: float | None,
        now: float,
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        before = copy.deepcopy(state[name])
        previous = (
            before["revert"]
            if before["expires_at"] is not None and before["expires_at"] <= now
            else before["value"]
        )
        state[name] = {
            "value": value,
            "expires_at": expires_at,
            "revert": previous if expires_at is not None else value,
        }
        return before, copy.deepcopy(state[name])

    def set_dispatch(
        self,
        enabled: bool,
        *,
        actor: str,
        reason: str,
        expires_at: float | None = None,
    ) -> int:
        if not isinstance(enabled, bool):
            raise ValueError("recovery dispatch control is invalid")
        return self._change(
            operation="dispatch_control",
            target="dispatch",
            actor=actor,
            reason=reason,
            expires_at=expires_at,
            mutate=lambda state: self._replace_entry(
                state, "dispatch", enabled, expires_at, self.clock()
            ),
        )

    def set_confirmation_count(
        self,
        value: int,
        *,
        actor: str,
        reason: str,
        expires_at: float | None = None,
    ) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not _CONFIRMATION_BOUNDS[0] <= value <= _CONFIRMATION_BOUNDS[1]:
            raise ValueError("recovery confirmation count is invalid")

        def mutate(state: dict[str, Any]) -> tuple[Any, Any]:
            return self._replace_entry(
                state, "confirmation_count", value, expires_at, self.clock()
            )

        return self._change(
            operation="confirmation_control",
            target="confirmation_count",
            actor=actor,
            reason=reason,
            expires_at=expires_at,
            mutate=mutate,
        )

    def set_cooldown(
        self,
        seconds: float,
        *,
        actor: str,
        reason: str,
        expires_at: float | None = None,
    ) -> int:
        if (
            isinstance(seconds, bool)
            or not isinstance(seconds, (int, float))
            or not math.isfinite(seconds)
            or not _COOLDOWN_BOUNDS[0] <= seconds <= _COOLDOWN_BOUNDS[1]
        ):
            raise ValueError("recovery cooldown is invalid")

        def mutate(state: dict[str, Any]) -> tuple[Any, Any]:
            return self._replace_entry(
                state, "cooldown_seconds", float(seconds), expires_at, self.clock()
            )

        return self._change(
            operation="cooldown_control",
            target="cooldown_seconds",
            actor=actor,
            reason=reason,
            expires_at=expires_at,
            mutate=mutate,
        )

    def set_retry_budget(
        self,
        value: int,
        *,
        actor: str,
        reason: str,
        expires_at: float | None = None,
    ) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or not _RETRY_BUDGET_BOUNDS[0] <= value <= _RETRY_BUDGET_BOUNDS[1]:
            raise ValueError("recovery retry budget is invalid")
        return self._change(
            operation="retry_budget_control",
            target="retry_budget",
            actor=actor,
            reason=reason,
            expires_at=expires_at,
            mutate=lambda state: self._replace_entry(
                state, "retry_budget", value, expires_at, self.clock()
            ),
        )

    def silence(
        self,
        correlation_key: str,
        *,
        actor: str,
        reason: str,
        expires_at: float,
    ) -> int:
        now = self.clock()
        if not isinstance(correlation_key, str) or safe_field(correlation_key, default="") != correlation_key:
            raise ValueError("recovery silence target is invalid")
        self._expiry(expires_at, now, required=True)

        def mutate(state: dict[str, Any]) -> tuple[Any, Any]:
            before = state["silences"].get(correlation_key)
            state["silences"][correlation_key] = float(expires_at)
            return before, float(expires_at)

        return self._change(
            operation="silence_control",
            target=f"incident:{correlation_key}",
            actor=actor,
            reason=reason,
            expires_at=float(expires_at),
            mutate=mutate,
            now=now,
        )

    def expire(self, *, now: float | None = None) -> int | None:
        timestamp = self.clock() if now is None else now
        with self.ledger.transaction() as connection:
            row = self._current_row(connection)
            document = self._document(row)
            state = self._state(document)
            before = copy.deepcopy(state)
            changed = False
            for name in ("dispatch", "confirmation_count", "cooldown_seconds", "retry_budget"):
                entry = state[name]
                if entry["expires_at"] is not None and entry["expires_at"] <= timestamp:
                    entry["value"] = entry["revert"]
                    entry["expires_at"] = None
                    entry["revert"] = entry["value"]
                    changed = True
            expired_silences = [
                target for target, expiry in state["silences"].items() if expiry <= timestamp
            ]
            for target in expired_silences:
                del state["silences"][target]
                changed = True
            if not changed:
                return None
            updated = copy.deepcopy(document)
            updated[_CONTROL_POLICY_KEY] = state
            return self.append_revision(
                connection,
                updated,
                operation="control_expiry",
                target="policy",
                actor="system",
                reason="bounded control expired",
                expires_at=timestamp,
                before=before,
                after=state,
                now=timestamp,
            )

    def rollback(self, revision: int, *, actor: str, reason: str) -> int:
        if not isinstance(revision, int) or revision < self.base_revision:
            raise ValueError("recovery rollback revision is invalid")
        timestamp = self.clock()
        self._operator(actor, reason)
        with self.ledger.transaction() as connection:
            current = self._current_row(connection)
            target = connection.execute(
                "SELECT revision, policy_json FROM policy_revisions WHERE revision = ?",
                (revision,),
            ).fetchone()
            if target is None or int(target["revision"]) >= int(current["revision"]):
                raise ValueError("recovery rollback revision is invalid")
            before_document = self._document(current)
            target_document = self._document(target)
            target_state = self._state(target_document)
            updated = copy.deepcopy(before_document)
            updated[_CONTROL_POLICY_KEY] = target_state
            return self.append_revision(
                connection,
                updated,
                operation="policy_rollback",
                target=f"revision:{revision}",
                actor=actor,
                reason=reason,
                expires_at=None,
                before=before_document.get(_CONTROL_POLICY_KEY, _default_control_state()),
                after=target_document.get(_CONTROL_POLICY_KEY, _default_control_state()),
                now=timestamp,
            )


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


@dataclass(frozen=True)
class IncidentEvidence:
    evidence_hash: str
    confirmation_count: int
    max_impact: int


class IncidentCoordinator:
    """Correlate durable events and own fenced, globally serialized invocations."""

    def __init__(
        self,
        ledger: RecoveryLedger,
        policy: RecoveryPolicy,
        *,
        owner: str,
        clock: Callable[[], float] = time.time,
        controls: RecoveryControls | None = None,
        immediate_escalation: Callable[[str], Any] | None = None,
        mode: str = "observe",
        static_policy: dict[str, Any] | None = None,
    ):
        if not isinstance(owner, str) or safe_field(owner, default="") != owner:
            raise ValueError("recovery owner is invalid")
        if mode not in RECOVERY_MODES:
            raise ValueError("recovery mode is invalid")
        self.ledger = ledger
        self.policy = policy
        self.owner = owner
        self.clock = clock
        self.controls = controls or RecoveryControls(
            ledger, base_revision=policy.revision, clock=clock
        )
        self.immediate_escalation = immediate_escalation
        self.mode = mode
        self._static_policy = (
            _canonical_json(static_policy) if static_policy is not None else None
        )
        self._rules = {
            (rule.component, rule.failure_class): rule for rule in self.policy.rules
        }

    @staticmethod
    def _verify_policy_revision(connection: Any, revision: int) -> None:
        row = connection.execute(
            "SELECT 1 FROM policy_revisions WHERE revision = ?",
            (revision,),
        ).fetchone()
        if row is None:
            raise LedgerCorrupt("configured recovery policy revision is missing")

    def _static_policy_matches(self, connection: Any, revision: int) -> bool:
        if self._static_policy is None:
            return True
        row = connection.execute(
            "SELECT policy_json FROM policy_revisions WHERE revision = ?",
            (revision,),
        ).fetchone()
        if row is None:
            raise LedgerCorrupt("configured recovery policy revision is missing")
        document = self.controls._document(row)
        current = document.get(_STATIC_POLICY_KEY)
        return current is not None and _canonical_json(current) == self._static_policy

    def _active_evidence_details(self, connection: Any) -> dict[str, IncidentEvidence]:
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
            key: IncidentEvidence(
                evidence_hash=hashlib.sha256(
                    json.dumps(sorted(items), ensure_ascii=True, separators=(",", ":")).encode(
                        "ascii"
                    )
                ).hexdigest(),
                confirmation_count=len(items),
                max_impact=max(int(item[-1]) for item in items),
            )
            for key, items in grouped.items()
        }

    def _active_evidence(self, connection: Any) -> dict[str, str]:
        return {
            key: details.evidence_hash
            for key, details in self._active_evidence_details(connection).items()
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

    def _interrupt_orphans(self, connection: Any, now: float, retry_budget: int) -> bool:
        exhausted = False
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
                or incident["state"] in {"verifying", "recovered"}
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
                if interruptions <= min(self.policy.max_crash_retries, retry_budget)
                else "retries_exhausted"
            )
            exhausted = exhausted or next_state == "retries_exhausted"
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
        return exhausted

    def reconcile(self) -> int:
        """Rebuild active incidents from the durable event stream."""

        now = self.clock()
        self.controls.expire(now=now)
        critical_impact = False
        retries_exhausted = False
        with self.ledger.transaction() as connection:
            control = self.controls.current(connection, now=now)
            self._verify_policy_revision(connection, control.revision)
            if not self._static_policy_matches(connection, control.revision):
                return 0
            retries_exhausted = self._interrupt_orphans(
                connection, now, control.retry_budget
            )
            evidence_details = self._active_evidence_details(connection)
            evidence = {
                key: details.evidence_hash for key, details in evidence_details.items()
            }
            critical_impact = any(details.max_impact >= 3 for details in evidence_details.values())
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
                        (correlation_key, evidence_hash, control.revision, now, now),
                    )
                    continue
                changed = (
                    incident["evidence_hash"] != evidence_hash
                    or incident["policy_revision"] != control.revision
                )
                if changed:
                    self._invalidate_invocation(connection, int(incident["id"]), now)
                    connection.execute(
                        "UPDATE incidents SET state = 'eligible', generation = generation + 1, "
                        "evidence_hash = ?, policy_revision = ?, updated_at = ? WHERE id = ?",
                        (evidence_hash, control.revision, now, incident["id"]),
                    )

            for correlation_key, incident in incidents.items():
                already_resolved = (
                    incident["state"] in {"verifying", "recovered"}
                    and incident["evidence_hash"] == _EMPTY_EVIDENCE_HASH
                )
                if correlation_key in evidence:
                    continue
                if already_resolved:
                    if (
                        incident["state"] == "verifying"
                        and incident["policy_revision"] != control.revision
                    ):
                        connection.execute(
                            "UPDATE incidents SET generation = generation + 1, "
                            "policy_revision = ?, updated_at = ? WHERE id = ?",
                            (control.revision, now, incident["id"]),
                        )
                    continue
                self._invalidate_invocation(connection, int(incident["id"]), now)
                connection.execute(
                    "UPDATE incidents SET state = 'verifying', generation = generation + 1, "
                    "evidence_hash = ?, policy_revision = ?, updated_at = ? WHERE id = ?",
                    (_EMPTY_EVIDENCE_HASH, control.revision, now, incident["id"]),
                )
            active_count = len(evidence)
        if critical_impact and self.immediate_escalation is not None:
            self.immediate_escalation("confirmed_impact")
        if retries_exhausted and self.immediate_escalation is not None:
            self.immediate_escalation("retries_exhausted")
        return active_count

    def claim_next(self) -> InvocationFence | None:
        """Acquire the one global lease and atomically create one invocation."""

        self.reconcile()
        if self.mode == "observe":
            return None
        now = self.clock()
        with self.ledger.transaction() as connection:
            control = self.controls.current(connection, now=now)
            if (
                not control.dispatch_enabled
                or not self._static_policy_matches(connection, control.revision)
            ):
                return None
            lease = connection.execute(
                "SELECT owner, token, expires_at FROM fixer_lease WHERE singleton = 1"
            ).fetchone()
            if lease["token"] is not None and float(lease["expires_at"]) > now:
                return None
            candidates = connection.execute(
                "SELECT * FROM incidents WHERE state = 'eligible' AND evidence_hash != ? "
                "ORDER BY opened_at, id",
                (_EMPTY_EVIDENCE_HASH,),
            ).fetchall()
            active = self._active_evidence_details(connection)
            incident = None
            for candidate in candidates:
                correlation_key = str(candidate["correlation_key"])
                details = active.get(correlation_key)
                if details is None:
                    continue
                if control.silence_expiry(correlation_key, now) is not None:
                    continue
                critical = details.max_impact >= 3
                if not critical and details.confirmation_count < control.confirmation_count:
                    continue
                last = connection.execute(
                    "SELECT max(updated_at) FROM invocations WHERE incident_id = ?",
                    (candidate["id"],),
                ).fetchone()[0]
                if (
                    not critical
                    and last is not None
                    and now - float(last) < control.cooldown_seconds
                ):
                    continue
                incident = candidate
                break
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

    def _fence_valid(self, connection: Any, fence: InvocationFence, now: float) -> bool:
        control = self.controls.current(connection, now=now)
        incident = connection.execute(
            "SELECT * FROM incidents WHERE id = ?", (fence.incident_id,)
        ).fetchone()
        invocation = connection.execute(
            "SELECT * FROM invocations WHERE id = ?", (fence.invocation_id,)
        ).fetchone()
        lease = connection.execute(
            "SELECT owner, token, expires_at FROM fixer_lease WHERE singleton = 1"
        ).fetchone()
        if incident is None or invocation is None or lease is None:
            return False
        current_hash = self._active_evidence(connection).get(
            str(incident["correlation_key"]), _EMPTY_EVIDENCE_HASH
        )
        return bool(
            invocation["state"] == "active"
            and invocation["incident_id"] == fence.incident_id
            and invocation["generation"] == fence.generation
            and invocation["evidence_hash"] == fence.evidence_hash
            and invocation["policy_revision"] == fence.policy_revision
            and invocation["lease_token"] == fence.lease_token
            and incident["state"] == "invoking"
            and incident["generation"] == fence.generation
            and incident["evidence_hash"] == fence.evidence_hash
            and incident["policy_revision"] == fence.policy_revision
            and control.revision == fence.policy_revision
            and self._static_policy_matches(connection, control.revision)
            and current_hash == fence.evidence_hash
            and lease["owner"] == fence.owner
            and lease["token"] == fence.lease_token
            and lease["expires_at"] is not None
            and float(lease["expires_at"]) > now
        )

    def renew_lease(self, fence: InvocationFence) -> bool:
        """Extend one valid token-owned lease while recomputing every durable fence."""

        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return False
            cursor = connection.execute(
                "UPDATE fixer_lease SET expires_at = ? "
                "WHERE singleton = 1 AND owner = ? AND token = ? AND expires_at > ?",
                (now + self.policy.lease_seconds, fence.owner, fence.lease_token, now),
            )
            if cursor.rowcount != 1:
                return False
            connection.execute(
                "UPDATE invocations SET updated_at = ? WHERE id = ? AND state = 'active'",
                (now, fence.invocation_id),
            )
            return True

    def invocation_evidence(self, fence: InvocationFence) -> list[dict[str, Any]]:
        """Return at most 32 normalized firing observations for the claimed incident."""

        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                raise ValueError("recovery invocation fence is stale")
            incident = connection.execute(
                "SELECT correlation_key FROM incidents WHERE id = ?", (fence.incident_id,)
            ).fetchone()
            assert incident is not None
            latest: dict[tuple[str, str], tuple[tuple[float, int, int], Any, dict[str, Any]]] = {}
            rows = connection.execute(
                "SELECT id, source, fingerprint, status, received_at, normalized_json FROM events"
            ).fetchall()
            for row in rows:
                try:
                    event = json.loads(str(row["normalized_json"]))
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise LedgerCorrupt("normalized recovery evidence is invalid") from exc
                if not isinstance(event, dict) or not _valid_spooled_event(event):
                    raise LedgerCorrupt("normalized recovery evidence is invalid")
                identity = (str(row["source"]), str(row["fingerprint"]))
                order = _event_time(row, event)
                previous = latest.get(identity)
                if previous is None or order > previous[0]:
                    latest[identity] = (order, row, event)
            evidence: list[dict[str, Any]] = []
            for _order, row, event in latest.values():
                if event["status"] != "firing":
                    continue
                rule = self._rules.get((event["component"], event["failure_class"]))
                if rule is None or rule.incident_key != str(incident["correlation_key"]):
                    continue
                evidence.append(
                    {
                        "ref": f"event:{int(row['id'])}",
                        "source": event["source"],
                        "fingerprint": event["fingerprint"],
                        "code": event["code"],
                        "component": event["component"],
                        "failureClass": event["failure_class"],
                        "status": event["status"],
                        "transitionId": event["transition_id"],
                    }
                )
            evidence.sort(key=lambda item: (item["source"], item["fingerprint"], item["ref"]))
            if not evidence:
                raise ValueError("recovery invocation evidence is unavailable")
            return evidence[:32]

    def finish(self, fence: InvocationFence, outcome: str) -> bool:
        """Accept a future fixer result only while every durable fence still matches."""

        if outcome not in _INVOCATION_OUTCOMES:
            raise ValueError("recovery invocation outcome is invalid")
        now = self.clock()
        with self.ledger.transaction() as connection:
            control = self.controls.current(connection, now=now)
            self._verify_policy_revision(connection, control.revision)
            incident = connection.execute(
                "SELECT * FROM incidents WHERE id = ?",
                (fence.incident_id,),
            ).fetchone()
            if (
                incident is None
                or incident["policy_revision"] != control.revision
                or not self._static_policy_matches(connection, control.revision)
            ):
                return False
            current_hash = self._active_evidence(connection).get(
                str(incident["correlation_key"]), _EMPTY_EVIDENCE_HASH
            )
            if current_hash != incident["evidence_hash"]:
                self._invalidate_invocation(connection, fence.incident_id, now)
                state = "verifying" if current_hash == _EMPTY_EVIDENCE_HASH else "eligible"
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
            incident_state = "verifying" if outcome == "completed" else outcome
            connection.execute(
                "UPDATE incidents SET state = ?, updated_at = ? WHERE id = ?",
                (incident_state, now, fence.incident_id),
            )
            connection.execute(
                "UPDATE fixer_lease SET owner = NULL, token = NULL, acquired_at = NULL, "
                "expires_at = NULL WHERE singleton = 1 AND token = ?",
                (fence.lease_token,),
            )
        escalation = {
            "recovery_failed": "recovery_failed",
            "recovery_unsafe": "recovery_unsafe",
            "retries_exhausted": "retries_exhausted",
        }.get(outcome)
        if escalation is not None and self.immediate_escalation is not None:
            self.immediate_escalation(escalation)
        return True

    def explicit_retry(
        self, incident_id: int, *, reason: str, actor: str | None = None
    ) -> bool:
        """Create one auditable generation without weakening dispatch fences."""

        if not isinstance(incident_id, int) or incident_id < 1:
            raise ValueError("recovery incident id is invalid")
        if not isinstance(reason, str) or safe_field(reason, default="") != reason:
            raise ValueError("recovery retry reason is invalid")
        control_actor = self.owner if actor is None else actor
        self.controls._operator(control_actor, reason)
        now = self.clock()
        with self.ledger.transaction() as connection:
            control = self.controls.current(connection, now=now)
            incident = connection.execute(
                "SELECT * FROM incidents WHERE id = ?",
                (incident_id,),
            ).fetchone()
            if (
                incident is None
                or incident["state"] in {"invoking", "verifying", "recovered"}
                or (
                    incident["evidence_hash"] == _EMPTY_EVIDENCE_HASH
                    and incident["state"] != "recovery_failed"
                )
            ):
                return False
            retry_count = connection.execute(
                "SELECT count(*) FROM audit WHERE operation = 'explicit_retry' AND target = ?",
                (f"incident:{incident_id}",),
            ).fetchone()[0]
            if retry_count >= control.retry_budget:
                return False
            row = self.controls._current_row(connection)
            document = self.controls._document(row)
            before = {
                "generation": int(incident["generation"]),
                "state": str(incident["state"]),
            }
            next_state = (
                "verifying"
                if incident["evidence_hash"] == _EMPTY_EVIDENCE_HASH
                else "eligible"
            )
            after = {
                "generation": int(incident["generation"]) + 1,
                "state": next_state,
            }
            self.controls.append_revision(
                connection,
                document,
                operation="explicit_retry",
                target=f"incident:{incident_id}",
                actor=control_actor,
                reason=reason,
                expires_at=None,
                before=before,
                after=after,
                now=now,
                effective=False,
            )
            connection.execute(
                "UPDATE incidents SET state = ?, generation = generation + 1, "
                "policy_revision = ?, updated_at = ? WHERE id = ?",
                (next_state, control.revision, now, incident_id),
            )
            return True

    def mark_missed_recovery(self, incident_id: int, *, dedupe_key: str) -> bool:
        """Fail one overdue verification generation and escalate it exactly once."""

        if not isinstance(incident_id, int) or incident_id < 1:
            raise ValueError("recovery incident id is invalid")
        if safe_field(dedupe_key, limit=160, default="") != dedupe_key:
            raise ValueError("recovery verification dedupe key is invalid")
        now = self.clock()
        target = f"incident:{incident_id}:{dedupe_key}"
        with self.ledger.transaction() as connection:
            if connection.execute(
                "SELECT 1 FROM audit WHERE operation = 'verification_failed' AND target = ?",
                (target,),
            ).fetchone() is not None:
                return False
            incident = connection.execute(
                "SELECT state FROM incidents WHERE id = ?", (incident_id,)
            ).fetchone()
            if incident is None or incident["state"] != "verifying":
                return False
            connection.execute(
                "UPDATE incidents SET state = 'recovery_failed', updated_at = ? WHERE id = ?",
                (now, incident_id),
            )
            connection.execute(
                "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                "VALUES (?, 'system', 'verification_failed', ?, ?)",
                (now, target, _canonical_json({"reason": "missed_recovery"})),
            )
        if self.immediate_escalation is not None:
            self.immediate_escalation("recovery_failed")
        return True


@dataclass(frozen=True)
class VerificationResult:
    recovered: bool
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class VerificationFence:
    incident_id: int
    generation: int
    policy_revision: int


class RecoveryVerifier:
    """Fail-closed deterministic verification backed by durable observations."""

    def __init__(
        self,
        ledger: RecoveryLedger,
        coordinator: IncidentCoordinator,
        *,
        probe_ids: tuple[str, ...] = (),
        source_ids: tuple[str, ...] = (),
        freshness_seconds: float = 120.0,
        hold_down_seconds: float = 60.0,
        clock: Callable[[], float] = time.time,
    ):
        identifiers = probe_ids + source_ids
        if len(set(probe_ids)) != len(probe_ids) or len(set(source_ids)) != len(source_ids):
            raise ValueError("recovery verification identifiers overlap")
        if any(
            not isinstance(identifier, str) or safe_field(identifier, default="") != identifier
            for identifier in identifiers
        ):
            raise ValueError("recovery verification identifier is invalid")
        for value in (freshness_seconds, hold_down_seconds):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not 0 <= value <= 86_400
            ):
                raise ValueError("recovery verification timing is invalid")
        self.ledger = ledger
        self.coordinator = coordinator
        self.probe_ids = probe_ids
        self.source_ids = source_ids
        self.freshness_seconds = float(freshness_seconds)
        self.hold_down_seconds = float(hold_down_seconds)
        self.clock = clock

    def _record_heartbeat(self, identifier: str, healthy: bool, observed_at: float) -> None:
        if not isinstance(healthy, bool) or (
            isinstance(observed_at, bool)
            or not isinstance(observed_at, (int, float))
            or not math.isfinite(observed_at)
        ):
            raise ValueError("recovery verification observation is invalid")
        key = f"verification:heartbeat:{identifier}"
        value = _canonical_json({"healthy": healthy, "observed_at": float(observed_at)})
        with self.ledger.transaction() as connection:
            connection.execute(
                "INSERT INTO metadata(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, value),
            )

    def record_heartbeat(
        self, source: str, *, healthy: bool = True, observed_at: float | None = None
    ) -> None:
        if source not in {"supervisor", *self.source_ids}:
            raise ValueError("recovery heartbeat source is invalid")
        self._record_heartbeat(source, healthy, self.clock() if observed_at is None else observed_at)

    def record_probe(
        self,
        fence: VerificationFence,
        probe_id: str,
        healthy: bool,
        *,
        observed_at: float | None = None,
    ) -> bool:
        if probe_id not in self.probe_ids:
            raise ValueError("recovery probe id is invalid")
        return self.record_probe_results(
            fence,
            [{"id": probe_id, "exitCode": 0 if healthy else 1, "timedOut": False}],
            require_all=False,
            observed_at=observed_at,
        )

    @staticmethod
    def _observation(connection: Any, key: str) -> tuple[bool, float] | None:
        row = connection.execute("SELECT value FROM metadata WHERE key = ?", (key,)).fetchone()
        if row is None:
            return None
        try:
            value = json.loads(str(row["value"]))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise LedgerCorrupt("recovery verification observation is invalid") from exc
        if (
            not isinstance(value, dict)
            or set(value) != {"healthy", "observed_at"}
            or not isinstance(value["healthy"], bool)
            or isinstance(value["observed_at"], bool)
            or not isinstance(value["observed_at"], (int, float))
            or not math.isfinite(value["observed_at"])
        ):
            raise LedgerCorrupt("recovery verification observation is invalid")
        return bool(value["healthy"]), float(value["observed_at"])

    @staticmethod
    def _probe_key(fence: VerificationFence, probe_id: str) -> str:
        return (
            f"verification:probe:{fence.incident_id}:{fence.generation}:"
            f"{fence.policy_revision}:{probe_id}"
        )

    @staticmethod
    def _probe_observation(
        connection: Any, fence: VerificationFence, probe_id: str
    ) -> tuple[bool, float] | None:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key = ?",
            (RecoveryVerifier._probe_key(fence, probe_id),),
        ).fetchone()
        if row is None:
            return None
        try:
            value = json.loads(str(row["value"]))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise LedgerCorrupt("recovery probe observation is invalid") from exc
        if (
            not isinstance(value, dict)
            or set(value)
            != {"generation", "healthy", "incident_id", "observed_at", "policy_revision"}
            or value["incident_id"] != fence.incident_id
            or value["generation"] != fence.generation
            or value["policy_revision"] != fence.policy_revision
            or not isinstance(value["healthy"], bool)
            or isinstance(value["observed_at"], bool)
            or not isinstance(value["observed_at"], (int, float))
            or not math.isfinite(value["observed_at"])
        ):
            raise LedgerCorrupt("recovery probe observation is invalid")
        return bool(value["healthy"]), float(value["observed_at"])

    def _fence_valid(self, connection: Any, fence: VerificationFence) -> bool:
        incident = connection.execute(
            "SELECT state, generation, policy_revision FROM incidents WHERE id = ?",
            (fence.incident_id,),
        ).fetchone()
        control = self.coordinator.controls.current(connection, now=self.clock())
        return bool(
            incident is not None
            and incident["state"] == "verifying"
            and incident["generation"] == fence.generation
            and incident["policy_revision"] == fence.policy_revision
            and control.revision == fence.policy_revision
            and self.coordinator._static_policy_matches(connection, control.revision)
        )

    def fence_valid(self, fence: VerificationFence) -> bool:
        with self.ledger.transaction() as connection:
            return self._fence_valid(connection, fence)

    def next_probe_refresh(self) -> VerificationFence | None:
        if not self.probe_ids:
            return None
        now = self.clock()
        refresh_after = min(30.0, max(1.0, self.freshness_seconds / 2.0))
        with self.ledger.transaction() as connection:
            incidents = connection.execute(
                "SELECT id, generation, policy_revision FROM incidents "
                "WHERE state = 'verifying' ORDER BY updated_at, id"
            ).fetchall()
            for incident in incidents:
                fence = VerificationFence(
                    int(incident["id"]),
                    int(incident["generation"]),
                    int(incident["policy_revision"]),
                )
                observations = [
                    self._probe_observation(connection, fence, probe_id)
                    for probe_id in self.probe_ids
                ]
                if any(
                    observation is None
                    or observation[1] > now + 1.0
                    or now - observation[1] >= refresh_after
                    for observation in observations
                ):
                    return fence
        return None

    def record_probe_results(
        self,
        fence: VerificationFence,
        results: list[dict[str, Any]],
        *,
        require_all: bool = True,
        observed_at: float | None = None,
    ) -> bool:
        if not isinstance(fence, VerificationFence) or not isinstance(results, list):
            raise ValueError("recovery probe results are invalid")
        normalized: dict[str, bool] = {}
        for result in results:
            if not isinstance(result, dict):
                raise ValueError("recovery probe result is invalid")
            probe_id = result.get("id")
            exit_code = result.get("exitCode")
            timed_out = result.get("timedOut")
            if (
                not isinstance(probe_id, str)
                or probe_id not in self.probe_ids
                or probe_id in normalized
                or isinstance(exit_code, bool)
                or not isinstance(exit_code, int)
                or not isinstance(timed_out, bool)
            ):
                raise ValueError("recovery probe result is invalid")
            normalized[probe_id] = exit_code == 0 and not timed_out
        if require_all and set(normalized) != set(self.probe_ids):
            raise ValueError("recovery probe results are incomplete")
        timestamp = self.clock() if observed_at is None else observed_at
        if (
            isinstance(timestamp, bool)
            or not isinstance(timestamp, (int, float))
            or not math.isfinite(timestamp)
        ):
            raise ValueError("recovery probe observation is invalid")
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence):
                return False
            for probe_id, healthy in normalized.items():
                value = _canonical_json(
                    {
                        "generation": fence.generation,
                        "healthy": healthy,
                        "incident_id": fence.incident_id,
                        "observed_at": float(timestamp),
                        "policy_revision": fence.policy_revision,
                    }
                )
                connection.execute(
                    "INSERT INTO metadata(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (self._probe_key(fence, probe_id), value),
                )
        return True

    def evaluate(self, incident_id: int) -> VerificationResult:
        if not isinstance(incident_id, int) or incident_id < 1:
            raise ValueError("recovery verification incident is invalid")
        now = self.clock()
        with self.ledger.transaction() as connection:
            incident = connection.execute(
                "SELECT * FROM incidents WHERE id = ?", (incident_id,)
            ).fetchone()
            if incident is None:
                raise ValueError("recovery verification incident is invalid")
            if incident["state"] == "recovered":
                return VerificationResult(True, ())
            fence = VerificationFence(
                incident_id,
                int(incident["generation"]),
                int(incident["policy_revision"]),
            )
            reasons: list[str] = []
            control = self.coordinator.controls.current(connection, now=now)
            if control.revision != fence.policy_revision:
                reasons.append("policy_stale")
            active = self.coordinator._active_evidence(connection)
            if str(incident["correlation_key"]) in active:
                reasons.append("episodes_firing")
            if incident["state"] != "verifying":
                reasons.append("not_verifying")
            for source in ("supervisor",) + self.source_ids:
                observation = self._observation(
                    connection, f"verification:heartbeat:{source}"
                )
                if observation is None:
                    reasons.append(f"heartbeat_missing:{source}")
                elif (
                    not observation[0]
                    or observation[1] > now + 1.0
                    or now - observation[1] > self.freshness_seconds
                ):
                    reasons.append(f"heartbeat_unhealthy:{source}")
            for probe_id in self.probe_ids:
                observation = self._probe_observation(connection, fence, probe_id)
                if observation is None:
                    reasons.append(f"probe_missing:{probe_id}")
                elif (
                    not observation[0]
                    or observation[1] > now + 1.0
                    or now - observation[1] > self.freshness_seconds
                ):
                    reasons.append(f"probe_unhealthy:{probe_id}")
            if now - float(incident["updated_at"]) < self.hold_down_seconds:
                reasons.append("hold_down")
            if reasons:
                return VerificationResult(False, tuple(sorted(set(reasons))))
            connection.execute(
                "UPDATE incidents SET state = 'recovered', updated_at = ? WHERE id = ?",
                (now, incident_id),
            )
            connection.execute(
                "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                "VALUES (?, 'system', 'verification_recovered', ?, ?)",
                (
                    now,
                    f"incident:{incident_id}",
                    _canonical_json(
                        {
                            "hold_down_seconds": self.hold_down_seconds,
                            "probe_count": len(self.probe_ids),
                            "source_count": len(self.source_ids) + 1,
                        }
                    ),
                ),
            )
            return VerificationResult(True, ())

    def evaluate_all(self) -> list[tuple[int, VerificationResult]]:
        with self.ledger.transaction() as connection:
            ids = [
                int(row["id"])
                for row in connection.execute(
                    "SELECT id FROM incidents WHERE state = 'verifying' ORDER BY id"
                ).fetchall()
            ]
        return [(incident_id, self.evaluate(incident_id)) for incident_id in ids]

    def mechanical_classification(
        self, incident_id: int, result: VerificationResult
    ) -> tuple[str, str] | None:
        now = self.clock()
        with self.ledger.transaction() as connection:
            incident = connection.execute(
                "SELECT generation, policy_revision, state, updated_at FROM incidents WHERE id = ?",
                (incident_id,),
            ).fetchone()
            if incident is None:
                raise ValueError("recovery verification incident is invalid")
            generation = int(incident["generation"])
            invocation = connection.execute(
                "SELECT id, generation FROM invocations WHERE incident_id = ? "
                "AND state = 'completed' AND policy_revision = ? AND generation >= ? "
                "AND generation <= ? ORDER BY generation DESC, id DESC LIMIT 1",
                (incident_id, incident["policy_revision"], max(1, generation - 1), generation),
            ).fetchone()
            if result.recovered:
                if invocation is None:
                    return "false_positive", f"verification:{generation}"
                return "stable_recovery", f"invocation:{int(invocation['id'])}"
            if invocation is None or "hold_down" in result.reasons:
                return None
            delay = max(self.hold_down_seconds, self.freshness_seconds)
            if now - float(incident["updated_at"]) < delay:
                return None
            return (
                "missed_recovery",
                f"invocation:{int(invocation['id'])}:verification:{generation}",
            )


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
        destination = self.path_for_key(key)
        with self._lock:
            try:
                self.path.mkdir(parents=True, exist_ok=True, mode=0o700)
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

    def path_for_key(self, key: str) -> Path:
        name = f"{hashlib.sha256(key.encode('utf-8')).hexdigest()}.json"
        return self.path / name

    def remove_key(self, key: str) -> None:
        self.remove(self.path_for_key(key))

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

    @property
    def delivery_available(self) -> bool:
        return self.delivery is not None

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


class RecoveryNotificationOutbox:
    """Durable immediate escalation handoff to the native notifier."""

    def __init__(
        self,
        ledger: RecoveryLedger,
        *,
        emergency: EmergencyNotifier | None = None,
        clock: Callable[[], float] = time.time,
    ):
        self.ledger = ledger
        self.emergency = emergency
        self.clock = clock

    def immediate_escalation(self, reason: str) -> bool:
        if reason not in _IMMEDIATE_ESCALATION_REASONS:
            raise ValueError("immediate recovery escalation reason is invalid")
        now = self.clock()
        cooldown = 300.0 if self.emergency is None else max(1.0, self.emergency.cooldown)
        key = f"immediate:{reason}:{int(now // cooldown)}"
        body = _canonical_json({"kind": "immediate", "reason": reason, "version": 1})
        with self.ledger.transaction() as connection:
            connection.execute(
                "INSERT OR IGNORE INTO notification_outbox(notification_key, kind, body_json, "
                "created_at, available_at) VALUES (?, 'immediate', ?, ?, ?)",
                (key, body, now, now),
            )
        return self.deliver_due() > 0

    def deliver_due(self, *, limit: int = 32) -> int:
        if not isinstance(limit, int) or not 1 <= limit <= 128:
            raise ValueError("recovery notification delivery is invalid")
        if self.emergency is None or not self.emergency.delivery_available:
            return 0
        with self.ledger.transaction() as connection:
            rows = connection.execute(
                "SELECT id, body_json FROM notification_outbox WHERE kind = 'immediate' "
                "AND delivered_at IS NULL AND available_at <= ? ORDER BY available_at, id LIMIT ?",
                (self.clock(), limit),
            ).fetchall()
        delivered = 0
        for row in rows:
            try:
                body = json.loads(str(row["body_json"]))
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise LedgerCorrupt("recovery notification body is invalid") from exc
            if (
                not isinstance(body, dict)
                or set(body) != {"kind", "reason", "version"}
                or body["kind"] != "immediate"
                or body["reason"] not in _IMMEDIATE_ESCALATION_REASONS
                or body["version"] != 1
            ):
                raise LedgerCorrupt("recovery notification body is invalid")
            self.emergency.emit(str(body["reason"]))
            with self.ledger.transaction() as connection:
                cursor = connection.execute(
                    "UPDATE notification_outbox SET delivered_at = ? "
                    "WHERE id = ? AND delivered_at IS NULL",
                    (self.clock(), row["id"]),
                )
            delivered += cursor.rowcount
        return delivered


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
        verifier: RecoveryVerifier | None = None,
        notifications: RecoveryNotificationOutbox | None = None,
    ):
        self.ledger = ledger
        self.event_spool = event_spool
        self.emergency = emergency
        self.coordinator = coordinator
        self.verifier = verifier
        self.notifications = notifications

    @staticmethod
    def _intake_envelope(
        events: list[dict[str, Any]], heartbeats: dict[str, bool] | None
    ) -> dict[str, Any]:
        observations = {str(event["source"]): True for event in events}
        observations.update(heartbeats or {})
        return {
            "version": 1,
            "events": [dict(event) for event in events],
            "heartbeats": observations,
            "observed_at": time.time(),
        }

    def _persist_intake(self, envelope: dict[str, Any]) -> int:
        events = envelope["events"]
        inserted = self.ledger.record_events(events)
        if self.coordinator is not None:
            self.coordinator.reconcile()
        if self.verifier is not None:
            observed_at = float(envelope["observed_at"])
            for source, healthy in sorted(envelope["heartbeats"].items()):
                if source in self.verifier.source_ids:
                    self.verifier.record_heartbeat(
                        source, healthy=healthy, observed_at=observed_at
                    )
        return inserted

    def _drain_events(self) -> None:
        for path, item in self.event_spool.items():
            if _valid_spooled_event(item):
                envelope = self._intake_envelope([item], None)
            elif _valid_spooled_intake(item):
                envelope = item
            else:
                raise SpoolError("event spool item is invalid")
            self._persist_intake(envelope)
            self.event_spool.remove(path)

    def accept(
        self,
        events: list[dict[str, Any]],
        *,
        heartbeats: dict[str, bool] | None = None,
    ) -> IntakeResult:
        try:
            self._drain_events()
        except LedgerError:
            pass
        except SpoolError:
            self.emergency.emit("spool_corrupt")
            return IntakeResult(503, "persistence unavailable")
        envelope = self._intake_envelope(events, heartbeats)
        durable_identity = {
            "events": envelope["events"],
            "heartbeats": envelope["heartbeats"],
            "version": envelope["version"],
        }
        spool_key = (
            "intake:"
            + hashlib.sha256(_canonical_json(durable_identity).encode("ascii")).hexdigest()
        )
        try:
            self.event_spool.put(spool_key, envelope)
        except SpoolError:
            self.emergency.emit("persistence_failed")
            return IntakeResult(503, "persistence unavailable")
        try:
            inserted = self._persist_intake(envelope)
            self.event_spool.remove_key(spool_key)
            return IntakeResult(200, "accepted" if inserted else "duplicate")
        except LedgerError:
            self.emergency.emit("ledger_unavailable")
            return IntakeResult(202, "durably spooled")
        except SpoolError:
            self.emergency.emit("spool_corrupt")
            return IntakeResult(503, "persistence unavailable")

    def health(self) -> IntakeResult:
        try:
            self.ledger.ping()
            self._drain_events()
            if self.verifier is not None:
                self.verifier.record_heartbeat("supervisor")
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
        except LedgerError:
            self.emergency.emit("ledger_unavailable")
        except SpoolError:
            self.emergency.emit("spool_corrupt")
        if self.verifier is not None:
            try:
                self.verifier.record_heartbeat("supervisor")
                verification_results = self.verifier.evaluate_all()
                for incident_id, result in verification_results:
                    classification = self.verifier.mechanical_classification(incident_id, result)
                    if classification is not None:
                        name, dedupe_key = classification
                        if name == "missed_recovery":
                            self.verifier.coordinator.mark_missed_recovery(
                                incident_id, dedupe_key=dedupe_key
                            )
            except LedgerError:
                self.emergency.emit("ledger_unavailable")
        if self.notifications is not None:
            try:
                self.notifications.deliver_due()
            except LedgerError:
                self.emergency.emit("ledger_unavailable")
        try:
            self.emergency.drain()
        except SpoolError:
            self.emergency.emit("spool_corrupt")


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


def _valid_spooled_intake(value: dict[str, Any]) -> bool:
    if set(value) != {"version", "events", "heartbeats", "observed_at"}:
        return False
    events = value.get("events")
    heartbeats = value.get("heartbeats")
    observed_at = value.get("observed_at")
    return bool(
        value.get("version") == 1
        and isinstance(events, list)
        and len(events) <= MAX_ALERTS_PER_REQUEST
        and all(isinstance(event, dict) and _valid_spooled_event(event) for event in events)
        and isinstance(heartbeats, dict)
        and heartbeats
        and len(heartbeats) <= 2
        and all(
            source in {"alertmanager", "runtime_doctor"}
            and isinstance(healthy, bool)
            for source, healthy in heartbeats.items()
        )
        and not isinstance(observed_at, bool)
        and isinstance(observed_at, (int, float))
        and math.isfinite(observed_at)
        and observed_at >= 0
    )


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
            try:
                self.send_response(status)
                self.send_header("Content-Type", "text/plain; charset=us-ascii")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionError, OSError):
                return

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
            if self.path not in {"/v1/alertmanager", "/v1/runtime-doctor"}:
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
                if self.path == "/v1/runtime-doctor":
                    events, heartbeats = _normalize_runtime_doctor_payload(body)
                else:
                    events = normalize_alertmanager(body)
                    heartbeats = {"alertmanager": True}
            except (TimeoutError, OSError):
                self._reply(408, "request timed out")
                return
            except IntakeError:
                self._reply(400, "invalid payload")
                return
            result = app.service.accept(events, heartbeats=heartbeats)
            self._reply(result.status, result.text)

    return Handler


def read_auth_token(path: Path) -> str:
    try:
        return read_private_ascii_token(path, max_bytes=AUTH_TOKEN_MAX_BYTES)
    except MonitoringError as exc:
        raise ValueError("authentication token file is invalid") from exc


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the same-host minime recovery supervisor")
    parser.add_argument("--config", default="")
    parser.add_argument(
        "--workspace", default=os.environ.get("MINIME_CONTROL_WORKSPACE_ROOT", "")
    )
    parser.add_argument("--mode", choices=sorted(RECOVERY_MODES), default="observe")
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


class _UnavailableLedger:
    def record_events(self, _events: Any) -> int:
        raise LedgerUnavailable("ledger startup is unavailable")

    def ping(self) -> None:
        raise LedgerUnavailable("ledger startup is unavailable")


def _build_recovery_service(
    ledger: RecoveryLedger,
    event_spool: AtomicJsonSpool,
    emergency: EmergencyNotifier,
    *,
    configured: RecoveryConfig | None,
    configured_rules: tuple[CorrelationRule, ...],
    source_ids: tuple[str, ...],
    mode: str,
) -> RecoveryService:
    controls = RecoveryControls(ledger)
    static_policy = None
    if configured is not None:
        static_policy = recovery_static_policy(configured)
        controls.ensure_static_policy(static_policy)
    revision = controls.current().revision
    notifications = RecoveryNotificationOutbox(ledger, emergency=emergency)
    coordinator = IncidentCoordinator(
        ledger,
        RecoveryPolicy(revision=revision, rules=configured_rules),
        owner=f"supervisor-{os.getpid()}",
        controls=controls,
        immediate_escalation=notifications.immediate_escalation,
        mode=mode,
        static_policy=static_policy,
    )
    verifier = RecoveryVerifier(
        ledger,
        coordinator,
        probe_ids=(
            tuple(str(probe["id"]) for probe in configured.probes)
            if configured is not None
            else ()
        ),
        source_ids=source_ids,
    )
    service = RecoveryService(
        ledger,
        event_spool,
        emergency,
        coordinator=coordinator,
        verifier=verifier,
        notifications=notifications,
    )
    return service


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    configured: RecoveryConfig | None = None
    configured_rules: tuple[CorrelationRule, ...] = ()
    source_ids = ("alertmanager", "runtime_doctor")
    if args.config:
        workspace = Path(args.workspace).resolve() if args.workspace else Path.cwd().resolve()
        config_path = Path(args.config)
        if not config_path.is_absolute():
            config_path = workspace / config_path
        try:
            configured = load_recovery_config(config_path, workspace)
        except RecoveryConfigError:
            print("recovery supervisor configuration rejected", file=sys.stderr)
            return 2
        args.host = configured.host
        args.port = configured.port
        args.db = str(configured.database)
        args.spool_dir = str(configured.spool_directory)
        args.auth_token_file = str(configured.auth_token_file)
        args.mode = configured.mode
        source_ids = configured.source_ids
        configured_rules = tuple(
            CorrelationRule(
                component=str(rule["component"]),
                failure_class=str(rule["failureClass"]),
                incident_key=str(rule["incidentKey"]),
                impact=int(rule["impact"]),
            )
            for rule in configured.correlation_rules
        )
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
    event_spool = AtomicJsonSpool(spool_root / "events")
    delivery = None
    if args.chat_id:
        telegram_config = DeliveryConfig(args.chat_id, args.thread_id)
        delivery = lambda message: send_telegram(message, telegram_config)
    emergency = EmergencyNotifier(
        spool_root / "notifications",
        delivery=delivery,
        cooldown=args.emergency_cooldown,
    )
    ledger: RecoveryLedger | None
    try:
        ledger = RecoveryLedger(Path(args.db), busy_timeout_ms=args.busy_timeout_ms)
    except LedgerCorrupt:
        emergency.emit("ledger_corrupt")
        print("recovery supervisor ledger validation failed", file=sys.stderr)
        return 1
    except LedgerUnavailable:
        emergency.emit("ledger_unavailable")
        ledger = None
    stop_requested = threading.Event()
    previous_signal_handlers: dict[int, Any] = {}

    def request_stop(_signum: int, _frame: Any) -> None:
        stop_requested.set()

    def restore_signal_handlers() -> None:
        for signum, previous in previous_signal_handlers.items():
            signal.signal(signum, previous)
        previous_signal_handlers.clear()

    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            previous_signal_handlers[signum] = signal.getsignal(signum)
            signal.signal(signum, request_stop)
        except (OSError, ValueError):
            previous_signal_handlers.pop(signum, None)
    service = RecoveryService(_UnavailableLedger(), event_spool, emergency)  # type: ignore[arg-type]
    app = RecoveryApplication(
        auth_token=token,
        max_body=args.max_body,
        body_timeout=args.body_timeout,
        service=service,
    )
    try:
        server = BoundedThreadingHTTPServer(
            (args.host, args.port),
            handler_for(app),
            max_concurrent_requests=args.max_concurrent,
        )
    except OSError:
        if ledger is not None:
            ledger.close()
        restore_signal_handlers()
        print("recovery supervisor failed to bind", file=sys.stderr)
        return 1
    if ledger is not None:
        try:
            service = _build_recovery_service(
                ledger,
                event_spool,
                emergency,
                configured=configured,
                configured_rules=configured_rules,
                source_ids=source_ids,
                mode=args.mode,
            )
            app.service = service
        except LedgerUnavailable:
            ledger.close()
            ledger = None
            emergency.emit("ledger_unavailable")
        except LedgerCorrupt:
            ledger.close()
            server.server_close()
            restore_signal_handlers()
            emergency.emit("ledger_corrupt")
            print("recovery supervisor ledger validation failed", file=sys.stderr)
            return 1
    server.timeout = 1.0
    print("recovery supervisor ready", flush=True)
    next_ledger_retry = time.monotonic()
    try:
        while not stop_requested.is_set():
            server.handle_request()
            if stop_requested.is_set():
                break
            if ledger is None and time.monotonic() >= next_ledger_retry:
                next_ledger_retry = time.monotonic() + 5.0
                recovered_ledger: RecoveryLedger | None = None
                try:
                    recovered_ledger = RecoveryLedger(
                        Path(args.db), busy_timeout_ms=args.busy_timeout_ms
                    )
                    recovered_service = _build_recovery_service(
                        recovered_ledger,
                        event_spool,
                        emergency,
                        configured=configured,
                        configured_rules=configured_rules,
                        source_ids=source_ids,
                        mode=args.mode,
                    )
                except LedgerUnavailable:
                    if recovered_ledger is not None:
                        recovered_ledger.close()
                    emergency.emit("ledger_unavailable")
                except LedgerCorrupt:
                    if recovered_ledger is not None:
                        recovered_ledger.close()
                    emergency.emit("ledger_corrupt")
                    next_ledger_retry = float("inf")
                else:
                    ledger = recovered_ledger
                    app.service = recovered_service
            app.service.maintenance()
    except KeyboardInterrupt:
        stop_requested.set()
    finally:
        server.server_close()
        if ledger is not None:
            ledger.close()
        restore_signal_handlers()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
