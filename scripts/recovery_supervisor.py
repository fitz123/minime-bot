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
import shutil
import signal
import socket
import stat
import subprocess
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
MAX_WORKER_OUTPUT_BYTES = 512 * 1024
RECOVERY_WORKER_MAX_SECONDS = 3 * 60 * 60.0
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
    "confirmed_impact": "MINIME RECOVERY SUPERVISOR\ncritical impact confirmed",
    "approval_required": "MINIME RECOVERY SUPERVISOR\nrecovery requires operator approval",
    "recovery_unsafe": "MINIME RECOVERY SUPERVISOR\nrecovery was refused as unsafe",
    "recovery_failed": "MINIME RECOVERY SUPERVISOR\nrecovery action or verification failed",
    "retries_exhausted": "MINIME RECOVERY SUPERVISOR\nrecovery retry budget exhausted",
    "supervisor_unavailable": "MINIME RECOVERY SUPERVISOR\nsupervisor unavailable",
    "pi_unavailable": "MINIME RECOVERY SUPERVISOR\nfixer planner unavailable",
}
_IMMEDIATE_ESCALATION_REASONS = frozenset(
    {
        "confirmed_impact",
        "approval_required",
        "recovery_unsafe",
        "recovery_failed",
        "retries_exhausted",
        "supervisor_unavailable",
        "pi_unavailable",
        "persistence_failed",
    }
)
_EMPTY_EVIDENCE_HASH = hashlib.sha256(b"[]").hexdigest()
_INVOCATION_OUTCOMES = {
    "completed",
    "malformed_output",
    "not_actionable",
    "observe",
    "pending_approval",
    "pi_unavailable",
    "recovery_failed",
    "recovery_unsafe",
    "retries_exhausted",
}
_REEVALUATABLE_OUTCOMES = {"malformed_output", "not_actionable", "observe"}
_CONTROL_POLICY_KEY = "recovery_controls"
_STATIC_POLICY_KEY = "recovery_static"
_EFFECTIVE_POLICY_REVISION_KEY = "effective_policy_revision"
_CONTROL_POLICY_VERSION = 1
_CONFIRMATION_BOUNDS = (1, 5)
_COOLDOWN_BOUNDS = (0.0, 86_400.0)
_RETRY_BUDGET_BOUNDS = (0, 10)
_MAX_CONTROL_TTL = 31 * 86_400.0
_ADAPTATION_COOLDOWN_STEP = 60.0
_MECHANICAL_OUTCOMES = frozenset(
    {"false_positive", "stable_recovery", "failed_recovery", "missed_recovery", "impact"}
)


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


@dataclass(frozen=True)
class ControlSnapshot:
    """Effective bounded dispatch controls at one immutable policy revision."""

    revision: int
    dispatch_enabled: bool
    confirmation_count: int
    cooldown_seconds: float
    retry_budget: int
    silences: tuple[tuple[str, float], ...]
    baseline_confirmation_count: int
    baseline_cooldown_seconds: float

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
        "baseline": {"confirmation_count": 1, "cooldown_seconds": 0.0},
        "adaptation": {"last_day": None, "last_outcome_id": 0},
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
            "baseline",
            "adaptation",
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
        baseline = state.get("baseline")
        if not isinstance(baseline, dict) or set(baseline) != {
            "confirmation_count",
            "cooldown_seconds",
        }:
            raise LedgerCorrupt("recovery control policy is invalid")
        baseline_count = baseline.get("confirmation_count")
        baseline_cooldown = baseline.get("cooldown_seconds")
        if (
            isinstance(baseline_count, bool)
            or not isinstance(baseline_count, int)
            or not _CONFIRMATION_BOUNDS[0] <= baseline_count <= _CONFIRMATION_BOUNDS[1]
            or isinstance(baseline_cooldown, bool)
            or not isinstance(baseline_cooldown, (int, float))
            or not _COOLDOWN_BOUNDS[0] <= baseline_cooldown <= _COOLDOWN_BOUNDS[1]
        ):
            raise LedgerCorrupt("recovery control policy is invalid")
        adaptation = state.get("adaptation")
        if not isinstance(adaptation, dict) or set(adaptation) != {"last_day", "last_outcome_id"}:
            raise LedgerCorrupt("recovery control policy is invalid")
        if adaptation["last_day"] is not None and not isinstance(adaptation["last_day"], int):
            raise LedgerCorrupt("recovery control policy is invalid")
        if (
            isinstance(adaptation["last_outcome_id"], bool)
            or not isinstance(adaptation["last_outcome_id"], int)
            or adaptation["last_outcome_id"] < 0
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
            baseline_confirmation_count=int(state["baseline"]["confirmation_count"]),
            baseline_cooldown_seconds=float(state["baseline"]["cooldown_seconds"]),
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
            result = self._replace_entry(
                state, "confirmation_count", value, expires_at, self.clock()
            )
            if expires_at is None:
                state["baseline"]["confirmation_count"] = value
            return result

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
            result = self._replace_entry(
                state, "cooldown_seconds", float(seconds), expires_at, self.clock()
            )
            if expires_at is None:
                state["baseline"]["cooldown_seconds"] = float(seconds)
            return result

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
        mechanical_outcome: Callable[..., Any] | None = None,
        mode: str = "enabled",
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
        self.mechanical_outcome = mechanical_outcome
        self.mode = mode
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

    def _reevaluation_due(
        self, connection: Any, incident: Any, now: float, retry_budget: int
    ) -> bool:
        state = str(incident["state"])
        delay = dict(self.policy.reevaluation_delays).get(state)
        if delay is None or now - float(incident["updated_at"]) < delay:
            return False
        attempts = connection.execute(
            "SELECT count(*) FROM invocations WHERE incident_id = ? AND evidence_hash = ? "
            "AND policy_revision = ? AND state IN ('malformed_output', 'not_actionable', 'observe')",
            (incident["id"], incident["evidence_hash"], incident["policy_revision"]),
        ).fetchone()[0]
        return attempts <= min(self.policy.max_reevaluations, retry_budget)

    def reconcile(self) -> int:
        """Rebuild active incidents from the durable event stream."""

        now = self.clock()
        self.controls.expire(now=now)
        critical_impact = False
        critical_incidents: list[tuple[int, int]] = []
        retries_exhausted = False
        with self.ledger.transaction() as connection:
            control = self.controls.current(connection, now=now)
            self._verify_policy_revision(connection, control.revision)
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
                    cursor = connection.execute(
                        "INSERT INTO incidents(correlation_key, state, generation, evidence_hash, "
                        "policy_revision, opened_at, updated_at) VALUES (?, 'eligible', 1, ?, ?, ?, ?)",
                        (correlation_key, evidence_hash, control.revision, now, now),
                    )
                    if evidence_details[correlation_key].max_impact >= 3:
                        critical_incidents.append((int(cursor.lastrowid), 1))
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
                elif self._reevaluation_due(connection, incident, now, control.retry_budget):
                    connection.execute(
                        "UPDATE incidents SET state = 'eligible', generation = generation + 1, "
                        "updated_at = ? WHERE id = ?",
                        (now, incident["id"]),
                    )
                if evidence_details[correlation_key].max_impact >= 3:
                    generation = int(incident["generation"]) + (1 if changed else 0)
                    critical_incidents.append((int(incident["id"]), generation))

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
        if self.mechanical_outcome is not None:
            for incident_id, generation in critical_incidents:
                self.mechanical_outcome(
                    incident_id,
                    "impact",
                    critical=True,
                    dedupe_key=f"impact:{generation}",
                )
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
            if not control.dispatch_enabled:
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

    def planner_evidence(self, fence: InvocationFence) -> list[dict[str, Any]]:
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

    def record_worker_result(
        self,
        fence: InvocationFence,
        plan: dict[str, Any],
        actions: list[dict[str, Any]],
        probes: list[dict[str, Any]],
    ) -> bool:
        """Persist the frozen plan and bounded action/probe result codes under its fence."""

        if not isinstance(plan, dict) or len(_canonical_json(plan).encode("utf-8")) > 16 * 1024:
            raise ValueError("recovery frozen plan is invalid")
        if not isinstance(actions, list) or len(actions) > 8:
            raise ValueError("recovery action results are invalid")
        if not isinstance(probes, list) or len(probes) > 16:
            raise ValueError("recovery probe results are invalid")

        def normalized_result(value: Any, kind: str) -> tuple[str, str, str]:
            if not isinstance(value, dict):
                raise ValueError(f"recovery {kind} result is invalid")
            identifier = value.get("id")
            exit_code = value.get("exitCode")
            timed_out = value.get("timedOut")
            if (
                not isinstance(identifier, str)
                or safe_field(identifier, limit=128, default="") != identifier
                or isinstance(exit_code, bool)
                or not isinstance(exit_code, int)
                or not isinstance(timed_out, bool)
            ):
                raise ValueError(f"recovery {kind} result is invalid")
            state = "failed" if timed_out or exit_code != 0 else "completed"
            code = "timeout" if timed_out else f"exit:{exit_code}"
            return identifier, state, code

        normalized = [
            ("runbook", *normalized_result(value, "action")) for value in actions
        ] + [("probe", *normalized_result(value, "probe")) for value in probes]
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return False
            key = f"invocation:{fence.invocation_id}:plan"
            connection.execute(
                "INSERT INTO metadata(key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (key, _canonical_json(plan)),
            )
            if connection.execute(
                "SELECT 1 FROM actions WHERE invocation_id = ? LIMIT 1",
                (fence.invocation_id,),
            ).fetchone() is not None:
                raise LedgerCorrupt("recovery invocation results are duplicated")
            for kind, identifier, state, code in normalized:
                connection.execute(
                    "INSERT INTO actions(invocation_id, runbook_id, state, started_at, "
                    "finished_at, result_code) VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        fence.invocation_id,
                        identifier if kind == "runbook" else f"probe:{identifier}",
                        state,
                        now,
                        now,
                        code,
                    ),
                )
            return True

    def finish(self, fence: InvocationFence, outcome: str) -> bool:
        """Accept a planner result only while every durable fence still matches."""

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
            if incident is None or incident["policy_revision"] != control.revision:
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
            "pending_approval": "approval_required",
            "pi_unavailable": "pi_unavailable",
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
                or incident["evidence_hash"] == _EMPTY_EVIDENCE_HASH
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
            after = {"generation": int(incident["generation"]) + 1, "state": "eligible"}
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
                "UPDATE incidents SET state = 'eligible', generation = generation + 1, "
                "policy_revision = ?, updated_at = ? WHERE id = ?",
                (control.revision, now, incident_id),
            )
            return True


class BoundedPolicyAdapter:
    """Replay mechanical outcomes into two tightly bounded policy knobs."""

    def __init__(
        self,
        ledger: RecoveryLedger,
        controls: RecoveryControls,
        *,
        clock: Callable[[], float] = time.time,
    ):
        self.ledger = ledger
        self.controls = controls
        self.clock = clock

    def record_outcome(
        self,
        incident_id: int,
        classification: str,
        *,
        critical: bool = False,
        dedupe_key: str | None = None,
        now: float | None = None,
    ) -> int:
        if not isinstance(incident_id, int) or incident_id < 1:
            raise ValueError("recovery outcome incident is invalid")
        if classification not in _MECHANICAL_OUTCOMES or not isinstance(critical, bool):
            raise ValueError("recovery outcome classification is invalid")
        if dedupe_key is not None and (
            not isinstance(dedupe_key, str)
            or safe_field(dedupe_key, limit=160, default="") != dedupe_key
        ):
            raise ValueError("recovery outcome dedupe key is invalid")
        timestamp = self.clock() if now is None else now
        target = f"incident:{incident_id}"
        if dedupe_key is not None:
            target = f"{target}:{dedupe_key}"
        with self.ledger.transaction() as connection:
            if connection.execute(
                "SELECT 1 FROM incidents WHERE id = ?", (incident_id,)
            ).fetchone() is None:
                raise ValueError("recovery outcome incident is invalid")
            if dedupe_key is not None:
                existing = connection.execute(
                    "SELECT id FROM audit WHERE operation = 'mechanical_outcome' "
                    "AND target = ? ORDER BY id LIMIT 1",
                    (target,),
                ).fetchone()
                if existing is not None:
                    return int(existing["id"])
            cursor = connection.execute(
                "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                "VALUES (?, 'system', 'mechanical_outcome', ?, ?)",
                (
                    timestamp,
                    target,
                    _canonical_json({"classification": classification, "critical": critical}),
                ),
            )
            return int(cursor.lastrowid)

    @staticmethod
    def _toward(current: float, baseline: float, step: float) -> float:
        if current < baseline:
            return min(baseline, current + step)
        if current > baseline:
            return max(baseline, current - step)
        return current

    @classmethod
    def replay(
        cls,
        *,
        confirmation_count: int,
        cooldown_seconds: float,
        baseline_confirmation_count: int,
        baseline_cooldown_seconds: float,
        outcomes: tuple[tuple[str, bool], ...],
    ) -> tuple[int, float]:
        if len(outcomes) < 3 or any(name not in _MECHANICAL_OUTCOMES for name, _ in outcomes):
            raise ValueError("recovery adaptation replay is invalid")
        classifications = [name for name, _critical in outcomes]
        critical = any(is_critical for _name, is_critical in outcomes)
        must_revert = critical or any(
            name in {"impact", "missed_recovery"} for name in classifications
        )
        if must_revert:
            next_confirmation = int(
                cls._toward(confirmation_count, baseline_confirmation_count, 1)
            )
            next_cooldown = cls._toward(
                cooldown_seconds, baseline_cooldown_seconds, _ADAPTATION_COOLDOWN_STEP
            )
        elif all(name == "false_positive" for name in classifications):
            next_confirmation = confirmation_count + 1
            next_cooldown = cooldown_seconds + _ADAPTATION_COOLDOWN_STEP
        elif all(name == "stable_recovery" for name in classifications):
            next_confirmation = confirmation_count - 1
            next_cooldown = cooldown_seconds - _ADAPTATION_COOLDOWN_STEP
        elif any(name == "failed_recovery" for name in classifications):
            next_confirmation = confirmation_count - 1
            next_cooldown = cooldown_seconds - _ADAPTATION_COOLDOWN_STEP
        else:
            next_confirmation = confirmation_count
            next_cooldown = cooldown_seconds
        return (
            min(_CONFIRMATION_BOUNDS[1], max(_CONFIRMATION_BOUNDS[0], next_confirmation)),
            min(_COOLDOWN_BOUNDS[1], max(_COOLDOWN_BOUNDS[0], float(next_cooldown))),
        )

    def adapt(self, *, now: float | None = None) -> int | None:
        timestamp = self.clock() if now is None else now
        day = int(timestamp // 86_400)
        with self.ledger.transaction() as connection:
            row = self.controls._current_row(connection)
            document = self.controls._document(row)
            state = self.controls._state(document)
            if state["adaptation"]["last_day"] == day:
                return None
            prior_adaptations = connection.execute(
                "SELECT occurred_at, details_json FROM audit "
                "WHERE operation = 'policy_adaptation' ORDER BY id"
            ).fetchall()
            last_outcome_id = int(state["adaptation"]["last_outcome_id"])
            for prior in prior_adaptations:
                if day * 86_400 <= float(prior["occurred_at"]) < (day + 1) * 86_400:
                    return None
                try:
                    prior_details = json.loads(str(prior["details_json"]))
                    consumed = prior_details["after"]["last_outcome_id"]
                except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise LedgerCorrupt("recovery adaptation audit is invalid") from exc
                if isinstance(consumed, bool) or not isinstance(consumed, int) or consumed < 0:
                    raise LedgerCorrupt("recovery adaptation audit is invalid")
                last_outcome_id = max(last_outcome_id, consumed)
            if any(
                state[name]["expires_at"] is not None
                and state[name]["expires_at"] > timestamp
                for name in ("confirmation_count", "cooldown_seconds")
            ):
                return None
            rows = connection.execute(
                "SELECT id, details_json FROM audit WHERE operation = 'mechanical_outcome' "
                "AND id > ? ORDER BY id",
                (last_outcome_id,),
            ).fetchall()
            outcomes: list[tuple[str, bool]] = []
            for outcome_row in rows:
                try:
                    details = json.loads(str(outcome_row["details_json"]))
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise LedgerCorrupt("mechanical recovery outcome is invalid") from exc
                if (
                    not isinstance(details, dict)
                    or set(details) != {"classification", "critical"}
                    or details["classification"] not in _MECHANICAL_OUTCOMES
                    or not isinstance(details["critical"], bool)
                ):
                    raise LedgerCorrupt("mechanical recovery outcome is invalid")
                outcomes.append((str(details["classification"]), bool(details["critical"])))
            if len(outcomes) < 3:
                return None
            arguments = {
                "confirmation_count": int(state["confirmation_count"]["value"]),
                "cooldown_seconds": float(state["cooldown_seconds"]["value"]),
                "baseline_confirmation_count": int(state["baseline"]["confirmation_count"]),
                "baseline_cooldown_seconds": float(state["baseline"]["cooldown_seconds"]),
                "outcomes": tuple(outcomes),
            }
            target = self.replay(**arguments)
            if target != self.replay(**arguments):
                raise LedgerCorrupt("recovery adaptation replay is nondeterministic")
            before = {
                "confirmation_count": state["confirmation_count"]["value"],
                "cooldown_seconds": state["cooldown_seconds"]["value"],
                "last_outcome_id": last_outcome_id,
            }
            state["confirmation_count"] = {
                "value": target[0],
                "expires_at": None,
                "revert": target[0],
            }
            state["cooldown_seconds"] = {
                "value": target[1],
                "expires_at": None,
                "revert": target[1],
            }
            state["adaptation"] = {
                "last_day": day,
                "last_outcome_id": int(rows[-1]["id"]),
            }
            after = {
                "confirmation_count": target[0],
                "cooldown_seconds": target[1],
                "last_outcome_id": int(rows[-1]["id"]),
            }
            updated = copy.deepcopy(document)
            updated[_CONTROL_POLICY_KEY] = state
            return self.controls.append_revision(
                connection,
                updated,
                operation="policy_adaptation",
                target="dispatch_policy",
                actor="system",
                reason="deterministic mechanical outcome replay",
                expires_at=None,
                before=before,
                after=after,
                now=timestamp,
            )


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
            plan_row = connection.execute(
                "SELECT value FROM metadata WHERE key = ?",
                (f"invocation:{int(invocation['id'])}:plan",),
            ).fetchone()
            if plan_row is not None:
                try:
                    plan = json.loads(str(plan_row["value"]))
                    requested_delay = plan["nextEvaluationDelaySeconds"]
                except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise LedgerCorrupt("recovery frozen plan is invalid") from exc
                if (
                    isinstance(requested_delay, bool)
                    or not isinstance(requested_delay, int)
                    or not 30 <= requested_delay <= 86_400
                ):
                    raise LedgerCorrupt("recovery frozen plan is invalid")
                delay = max(delay, float(requested_delay))
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
    """Deterministic digest creation and durable bounded delivery retry."""

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
        if self.emergency is None or not self.emergency.delivery_available:
            return False
        self.emergency.emit(reason)
        return True

    def queue_digest(self, window_start: float, window_end: float) -> dict[str, Any]:
        if (
            isinstance(window_start, bool)
            or isinstance(window_end, bool)
            or not isinstance(window_start, (int, float))
            or not isinstance(window_end, (int, float))
            or not math.isfinite(window_start)
            or not math.isfinite(window_end)
            or window_start < 0
            or window_end <= window_start
            or int(window_start) != window_start
            or int(window_end) != window_end
        ):
            raise ValueError("recovery digest window is invalid")
        start = int(window_start)
        end = int(window_end)
        key = f"digest:{start}:{end}"
        with self.ledger.transaction() as connection:
            existing = connection.execute(
                "SELECT body_json FROM notification_outbox WHERE notification_key = ?", (key,)
            ).fetchone()
            if existing is not None:
                try:
                    body = json.loads(str(existing["body_json"]))
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise LedgerCorrupt("recovery notification body is invalid") from exc
                if not isinstance(body, dict):
                    raise LedgerCorrupt("recovery notification body is invalid")
                return body
            counts = {
                "actions": int(
                    connection.execute(
                        "SELECT count(*) FROM actions WHERE started_at >= ? AND started_at < ?",
                        (start, end),
                    ).fetchone()[0]
                ),
                "audit_entries": int(
                    connection.execute(
                        "SELECT count(*) FROM audit WHERE occurred_at >= ? AND occurred_at < ?",
                        (start, end),
                    ).fetchone()[0]
                ),
                "events": int(
                    connection.execute(
                        "SELECT count(*) FROM events WHERE received_at >= ? AND received_at < ?",
                        (start, end),
                    ).fetchone()[0]
                ),
                "invocations": int(
                    connection.execute(
                        "SELECT count(*) FROM invocations WHERE created_at >= ? AND created_at < ?",
                        (start, end),
                    ).fetchone()[0]
                ),
                "recoveries": int(
                    connection.execute(
                        "SELECT count(*) FROM audit WHERE operation = 'verification_recovered' "
                        "AND occurred_at >= ? AND occurred_at < ?",
                        (start, end),
                    ).fetchone()[0]
                ),
            }
            states = {
                str(row["state"]): int(row["count"])
                for row in connection.execute(
                    "SELECT state, count(*) AS count FROM incidents GROUP BY state ORDER BY state"
                ).fetchall()
            }
            body = {
                "counts": counts,
                "incident_states": states,
                "kind": "digest",
                "version": 1,
                "window_end": end,
                "window_start": start,
            }
            connection.execute(
                "INSERT INTO notification_outbox(notification_key, kind, body_json, created_at, "
                "available_at) VALUES (?, 'digest', ?, ?, ?)",
                (key, _canonical_json(body), self.clock(), self.clock()),
            )
            return body

    def queue_periodic(self, interval_seconds: int = 86_400) -> dict[str, Any] | None:
        if (
            isinstance(interval_seconds, bool)
            or not isinstance(interval_seconds, int)
            or not 60 <= interval_seconds <= 86_400
        ):
            raise ValueError("recovery digest interval is invalid")
        now = self.clock()
        end = int(now // interval_seconds) * interval_seconds
        if end <= 0:
            return None
        return self.queue_digest(end - interval_seconds, end)

    def deliver_due(
        self,
        delivery: Callable[[dict[str, Any]], None],
        *,
        limit: int = 32,
    ) -> int:
        if not callable(delivery) or not isinstance(limit, int) or not 1 <= limit <= 128:
            raise ValueError("recovery notification delivery is invalid")
        delivered = 0
        now = self.clock()
        with self.ledger.transaction() as connection:
            rows = connection.execute(
                "SELECT * FROM notification_outbox WHERE delivered_at IS NULL "
                "AND available_at <= ? ORDER BY available_at, id LIMIT ?",
                (now, limit),
            ).fetchall()
        for row in rows:
            try:
                body = json.loads(str(row["body_json"]))
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise LedgerCorrupt("recovery notification body is invalid") from exc
            if not isinstance(body, dict) or body.get("kind") != row["kind"]:
                raise LedgerCorrupt("recovery notification body is invalid")
            try:
                delivery(body)
            except Exception:
                attempts = int(row["attempts"]) + 1
                delay = min(3_600.0, 5.0 * (2 ** min(attempts - 1, 10)))
                with self.ledger.transaction() as connection:
                    connection.execute(
                        "UPDATE notification_outbox SET attempts = ?, available_at = ? "
                        "WHERE id = ? AND delivered_at IS NULL",
                        (attempts, now + delay, row["id"]),
                    )
                continue
            with self.ledger.transaction() as connection:
                cursor = connection.execute(
                    "UPDATE notification_outbox SET delivered_at = ? "
                    "WHERE id = ? AND delivered_at IS NULL",
                    (self.clock(), row["id"]),
                )
            delivered += cursor.rowcount
        return delivered


def format_recovery_notification(body: dict[str, Any]) -> str:
    if body.get("kind") != "digest" or not isinstance(body.get("counts"), dict):
        raise ValueError("recovery notification body is invalid")
    counts = body["counts"]
    return (
        "MINIME RECOVERY DIGEST\n"
        f"window={body.get('window_start')}-{body.get('window_end')} "
        f"events={counts.get('events', 0)} invocations={counts.get('invocations', 0)} "
        f"recoveries={counts.get('recoveries', 0)}"
    )


@dataclass(frozen=True)
class IntakeResult:
    status: int
    text: str


class RecoveryWorkerUnavailable(RuntimeError):
    pass


class RecoveryWorkerStale(RuntimeError):
    pass


class RecoveryProcessor:
    """Own one durable claim -> bounded Node worker -> persisted finish cycle."""

    def __init__(
        self,
        config: RecoveryConfig,
        coordinator: IncidentCoordinator,
        verifier: RecoveryVerifier,
        adapter: BoundedPolicyAdapter,
        *,
        environment: dict[str, str] | os._Environ[str] = os.environ,
        runner: Callable[[dict[str, Any], InvocationFence], dict[str, Any]] | None = None,
        verification_runner: (
            Callable[[dict[str, Any], VerificationFence], dict[str, Any]] | None
        ) = None,
        clock: Callable[[], float] = time.time,
    ):
        self.config = config
        self.coordinator = coordinator
        self.verifier = verifier
        self.adapter = adapter
        self.environment = environment
        self.runner = runner or self._run_node_worker
        self.verification_runner = verification_runner or self._run_verification_worker
        self.clock = clock
        self._state_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._closing = False

    @staticmethod
    def _fence_document(fence: InvocationFence) -> dict[str, Any]:
        return {
            "invocationId": fence.invocation_id,
            "incidentId": fence.incident_id,
            "generation": fence.generation,
            "evidenceHash": fence.evidence_hash,
            "policyRevision": fence.policy_revision,
            "leaseToken": fence.lease_token,
            "owner": fence.owner,
        }

    def _request(self, fence: InvocationFence) -> dict[str, Any]:
        return {
            "version": 1,
            "mode": self.config.mode,
            "fence": self._fence_document(fence),
            "evidence": self.coordinator.planner_evidence(fence),
            "runbooks": [dict(item) for item in self.config.runbooks],
            "probes": [dict(item) for item in self.config.probes],
        }

    def _verification_request(self, fence: VerificationFence) -> dict[str, Any]:
        return {
            "version": 1,
            "operation": "verify",
            "fence": {
                "incidentId": fence.incident_id,
                "generation": fence.generation,
                "policyRevision": fence.policy_revision,
            },
            "probes": [dict(item) for item in self.config.probes],
        }

    def _valid_plan(self, plan: Any, fence: InvocationFence) -> bool:
        if not isinstance(plan, dict) or set(plan) != {
            "invocationId",
            "incidentId",
            "generation",
            "evidenceHash",
            "policyRevision",
            "verdict",
            "diagnosisCode",
            "summary",
            "evidenceRefs",
            "runbookIds",
            "probeIds",
            "nextEvaluationDelaySeconds",
        }:
            return False
        expected = self._fence_document(fence)
        if any(plan.get(key) != expected[key] for key in (
            "invocationId",
            "incidentId",
            "generation",
            "evidenceHash",
            "policyRevision",
        )):
            return False
        runbook_ids = plan.get("runbookIds")
        probe_ids = plan.get("probeIds")
        evidence_refs = plan.get("evidenceRefs")
        known_runbooks = {str(item["id"]) for item in self.config.runbooks}
        known_probes = {str(item["id"]) for item in self.config.probes}
        return bool(
            isinstance(runbook_ids, list)
            and isinstance(probe_ids, list)
            and isinstance(evidence_refs, list)
            and all(isinstance(value, str) for value in runbook_ids)
            and all(isinstance(value, str) for value in probe_ids)
            and all(isinstance(value, str) for value in evidence_refs)
            and len(runbook_ids) <= 8
            and len(probe_ids) <= 16
            and len(evidence_refs) <= 16
            and len(set(runbook_ids)) == len(runbook_ids)
            and len(set(probe_ids)) == len(probe_ids)
            and set(runbook_ids).issubset(known_runbooks)
            and set(probe_ids).issubset(known_probes)
        )

    def _worker_environment(self, fence_descriptor: int | None = None) -> dict[str, str]:
        allowed = {
            "CI",
            "COLORTERM",
            "FORCE_COLOR",
            "HOME",
            "LANG",
            "LOGNAME",
            "NO_COLOR",
            "PATH",
            "SHELL",
            "SSL_CERT_DIR",
            "SSL_CERT_FILE",
            "TEMP",
            "TERM",
            "TMP",
            "TMPDIR",
            "USER",
            "XDG_CACHE_HOME",
            "XDG_CONFIG_HOME",
            "XDG_DATA_HOME",
            "XDG_RUNTIME_DIR",
        }
        result = {
            key: value
            for key, value in self.environment.items()
            if key in allowed or key.startswith("LC_")
        }
        result["MINIME_CONTROL_WORKSPACE_ROOT"] = str(self.config.workspace)
        agent_root = self.environment.get("MINIME_AGENT_WORKSPACE_ROOT", "").strip()
        if agent_root:
            result["MINIME_AGENT_WORKSPACE_ROOT"] = agent_root
        if fence_descriptor is not None:
            result["MINIME_RECOVERY_FENCE_FD"] = str(fence_descriptor)
        return result

    def _terminate_worker(self, process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (OSError, ProcessLookupError):
            try:
                process.terminate()
            except OSError:
                return
        try:
            # The Node executor uses a two-second abort grace before killing a
            # detached runbook process group. Let that cleanup complete first.
            process.wait(timeout=3)
            return
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (OSError, ProcessLookupError):
            try:
                process.kill()
            except OSError:
                pass

    def _run_worker_process(
        self, request: dict[str, Any], fence_check: Callable[[], bool]
    ) -> dict[str, Any]:
        configured_node = self.environment.get("MINIME_RECOVERY_NODE_EXECUTABLE", "").strip()
        node = configured_node or shutil.which("node", path=self.environment.get("PATH")) or ""
        worker = Path(__file__).resolve().parent.parent / "dist" / "recovery" / "worker.js"
        if not node or not Path(node).is_absolute() or not os.access(node, os.X_OK) or not worker.is_file():
            raise RecoveryWorkerUnavailable("recovery worker runtime is unavailable")
        payload = _canonical_json(request).encode("ascii")
        if len(payload) > MAX_WORKER_OUTPUT_BYTES:
            raise RecoveryWorkerUnavailable("recovery worker request is oversized")
        parent_fence, child_fence = socket.socketpair()
        try:
            process = subprocess.Popen(
                [node, str(worker)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=self.config.workspace,
                env=self._worker_environment(child_fence.fileno()),
                start_new_session=True,
                pass_fds=(child_fence.fileno(),),
            )
        except (OSError, ValueError) as exc:
            parent_fence.close()
            child_fence.close()
            raise RecoveryWorkerUnavailable("recovery worker failed to start") from exc
        child_fence.close()
        with self._state_lock:
            if self._closing:
                self._terminate_worker(process)
                parent_fence.close()
                raise RecoveryWorkerStale("recovery worker is stopping")
            self._process = process
        deadline = time.monotonic() + RECOVERY_WORKER_MAX_SECONDS
        input_value: bytes | None = payload
        stop_fence_checks = threading.Event()
        fence_lost = threading.Event()

        def durable_fence_valid() -> bool:
            try:
                return fence_check()
            except (LedgerError, OSError, ValueError):
                return False

        def serve_fence_checks() -> None:
            parent_fence.settimeout(0.25)
            while not stop_fence_checks.is_set():
                try:
                    request_byte = parent_fence.recv(1)
                except socket.timeout:
                    continue
                except OSError:
                    return
                if not request_byte:
                    return
                valid = request_byte == b"?"
                if valid:
                    valid = durable_fence_valid()
                if not valid:
                    fence_lost.set()
                try:
                    parent_fence.sendall(b"1" if valid else b"0")
                except OSError:
                    return

        fence_thread = threading.Thread(target=serve_fence_checks, daemon=True)
        fence_thread.start()
        try:
            while True:
                try:
                    stdout, _stderr = process.communicate(input=input_value, timeout=1.0)
                    break
                except subprocess.TimeoutExpired:
                    input_value = None
                    if self._closing or time.monotonic() >= deadline:
                        self._terminate_worker(process)
                        raise RecoveryWorkerUnavailable("recovery worker timed out")
                    if fence_lost.is_set() or not durable_fence_valid():
                        self._terminate_worker(process)
                        raise RecoveryWorkerStale("recovery worker lost its fence")
            if process.returncode != 0:
                raise RecoveryWorkerUnavailable("recovery worker failed")
            if len(stdout) > MAX_WORKER_OUTPUT_BYTES:
                raise RecoveryWorkerUnavailable("recovery worker output is oversized")
            try:
                result = json.loads(stdout.decode("ascii"))
            except (UnicodeError, ValueError, json.JSONDecodeError) as exc:
                raise RecoveryWorkerUnavailable("recovery worker output is invalid") from exc
            if not isinstance(result, dict) or result.get("version") != 1:
                raise RecoveryWorkerUnavailable("recovery worker output is invalid")
            return result
        finally:
            if process.poll() is None:
                self._terminate_worker(process)
            stop_fence_checks.set()
            try:
                parent_fence.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            parent_fence.close()
            fence_thread.join(timeout=1)
            with self._state_lock:
                if self._process is process:
                    self._process = None

    def _run_node_worker(
        self, request: dict[str, Any], fence: InvocationFence
    ) -> dict[str, Any]:
        return self._run_worker_process(
            request, lambda: self.coordinator.renew_lease(fence)
        )

    def _run_verification_worker(
        self, request: dict[str, Any], fence: VerificationFence
    ) -> dict[str, Any]:
        return self._run_worker_process(request, lambda: self.verifier.fence_valid(fence))

    def _refresh_verification_once(self) -> dict[str, Any] | None:
        if self.config.mode != "enabled":
            return None
        fence = self.verifier.next_probe_refresh()
        if fence is None:
            return None
        try:
            result = self.verification_runner(self._verification_request(fence), fence)
        except RecoveryWorkerStale:
            return {"plannerLaunched": False, "executorLaunched": False, "outcome": "stale"}
        except (RecoveryWorkerUnavailable, LedgerError, OSError, ValueError):
            if self.coordinator.immediate_escalation is not None:
                self.coordinator.immediate_escalation("recovery_failed")
            return {
                "plannerLaunched": False,
                "executorLaunched": False,
                "outcome": "verification_failed",
            }
        status = result.get("status")
        probes = result.get("probes")
        if status == "stale":
            return {"plannerLaunched": False, "executorLaunched": False, "outcome": "stale"}
        if status not in {"completed", "failed"} or not isinstance(probes, list):
            if self.coordinator.immediate_escalation is not None:
                self.coordinator.immediate_escalation("recovery_failed")
            return {
                "plannerLaunched": False,
                "executorLaunched": False,
                "outcome": "verification_failed",
            }
        try:
            stored = self.verifier.record_probe_results(fence, probes)
        except (LedgerError, ValueError):
            stored = False
        return {
            "plannerLaunched": False,
            "executorLaunched": bool(probes),
            "outcome": ("verification_refreshed" if stored else "stale"),
        }

    def process_once(self) -> dict[str, Any]:
        fence = self.coordinator.claim_next()
        if fence is None:
            refreshed = self._refresh_verification_once()
            return refreshed or {
                "plannerLaunched": False,
                "executorLaunched": False,
                "outcome": None,
            }
        try:
            result = self.runner(self._request(fence), fence)
        except RecoveryWorkerStale:
            return {"plannerLaunched": True, "executorLaunched": False, "outcome": "stale"}
        except (RecoveryWorkerUnavailable, LedgerError, OSError, ValueError):
            accepted = self.coordinator.finish(fence, "pi_unavailable")
            return {
                "plannerLaunched": True,
                "executorLaunched": False,
                "outcome": "pi_unavailable" if accepted else "stale",
            }

        planner_launched = result.get("plannerLaunched") is True
        executor_launched = result.get("executorLaunched") is True
        status = result.get("status")
        if not planner_launched or not isinstance(status, str):
            accepted = self.coordinator.finish(fence, "malformed_output")
            return {
                "plannerLaunched": True,
                "executorLaunched": executor_launched,
                "outcome": "malformed_output" if accepted else "stale",
            }
        if status == "planner_error":
            code = result.get("code")
            malformed = code in {
                "malformed_result",
                "missing_result",
                "multiple_results",
                "output_oversized",
            }
            outcome = "malformed_output" if malformed else "pi_unavailable"
            accepted = self.coordinator.finish(fence, outcome)
            return {
                "plannerLaunched": True,
                "executorLaunched": False,
                "outcome": outcome if accepted else "stale",
            }
        if status == "stale":
            return {
                "plannerLaunched": True,
                "executorLaunched": executor_launched,
                "outcome": "stale",
            }
        plan = result.get("plan")
        actions = result.get("actions", [])
        probes = result.get("probes", [])
        if not self._valid_plan(plan, fence) or not isinstance(actions, list) or not isinstance(probes, list):
            accepted = self.coordinator.finish(fence, "malformed_output")
            return {
                "plannerLaunched": True,
                "executorLaunched": executor_launched,
                "outcome": "malformed_output" if accepted else "stale",
            }
        try:
            stored = self.coordinator.record_worker_result(fence, plan, actions, probes)
        except (LedgerError, ValueError):
            stored = False
        if not stored:
            return {
                "plannerLaunched": True,
                "executorLaunched": executor_launched,
                "outcome": "stale",
            }
        outcome = {
            "observe": "observe",
            "not_actionable": "not_actionable",
            "planned": "observe",
            "approval_required": "pending_approval",
            "rejected": "recovery_unsafe",
            "failed": "recovery_failed",
            "completed": "completed",
        }.get(status, "malformed_output")
        accepted = self.coordinator.finish(fence, outcome)
        if accepted and outcome == "recovery_failed":
            self.adapter.record_outcome(
                fence.incident_id,
                "failed_recovery",
                dedupe_key=f"invocation:{fence.invocation_id}",
            )
        return {
            "plannerLaunched": True,
            "executorLaunched": executor_launched,
            "outcome": outcome if accepted else "stale",
        }

    def start_background(self) -> None:
        def run() -> None:
            try:
                self.process_once()
            except (LedgerError, OSError, ValueError):
                return

        with self._state_lock:
            if self._closing or (self._thread is not None and self._thread.is_alive()):
                return
            self._thread = threading.Thread(target=run, daemon=True)
            self._thread.start()

    def close(self) -> None:
        with self._state_lock:
            self._closing = True
            process = self._process
            thread = self._thread
        if process is not None:
            self._terminate_worker(process)
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5)


class RecoveryService:
    def __init__(
        self,
        ledger: RecoveryLedger,
        event_spool: AtomicJsonSpool,
        emergency: EmergencyNotifier,
        coordinator: IncidentCoordinator | None = None,
        verifier: RecoveryVerifier | None = None,
        adapter: BoundedPolicyAdapter | None = None,
        notifications: RecoveryNotificationOutbox | None = None,
        processor: RecoveryProcessor | None = None,
        notification_delivery: Callable[[dict[str, Any]], None] | None = None,
        digest_interval_seconds: int = 86_400,
    ):
        self.ledger = ledger
        self.event_spool = event_spool
        self.emergency = emergency
        self.coordinator = coordinator
        self.verifier = verifier
        self.adapter = adapter
        self.notifications = notifications
        self.processor = processor
        self.notification_delivery = notification_delivery
        self.digest_interval_seconds = digest_interval_seconds

    def _drain_events(self) -> None:
        for path, event in self.event_spool.items():
            if not _valid_spooled_event(event):
                raise SpoolError("event spool item is invalid")
            self.ledger.record_events([event])
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
        try:
            inserted = self.ledger.record_events(events)
            if self.coordinator is not None:
                self.coordinator.reconcile()
            if self.verifier is not None:
                observations = {
                    str(event["source"]): True for event in events
                }
                observations.update(heartbeats or {})
                for source, healthy in sorted(observations.items()):
                    if source in self.verifier.source_ids:
                        self.verifier.record_heartbeat(source, healthy=healthy)
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
        if self.processor is not None:
            self.processor.start_background()
        if self.verifier is not None:
            try:
                self.verifier.record_heartbeat("supervisor")
                verification_results = self.verifier.evaluate_all()
                if self.adapter is not None:
                    for incident_id, result in verification_results:
                        classification = self.verifier.mechanical_classification(
                            incident_id, result
                        )
                        if classification is not None:
                            name, dedupe_key = classification
                            self.adapter.record_outcome(
                                incident_id, name, dedupe_key=dedupe_key
                            )
            except LedgerError:
                self.emergency.emit("ledger_unavailable")
        if self.adapter is not None:
            try:
                self.adapter.adapt()
            except LedgerError:
                self.emergency.emit("ledger_unavailable")
        if self.notifications is not None:
            try:
                self.notifications.queue_periodic(self.digest_interval_seconds)
                if self.notification_delivery is not None:
                    self.notifications.deliver_due(self.notification_delivery)
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
    parser.add_argument("--mode", choices=sorted(RECOVERY_MODES), default="enabled")
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
    delivery: Callable[[str], None] | None,
) -> tuple[RecoveryService, RecoveryProcessor | None]:
    controls = RecoveryControls(ledger)
    if configured is not None:
        controls.ensure_static_policy(recovery_static_policy(configured))
    revision = controls.current().revision
    notifications = RecoveryNotificationOutbox(ledger, emergency=emergency)
    coordinator = IncidentCoordinator(
        ledger,
        RecoveryPolicy(revision=revision, rules=configured_rules),
        owner=f"supervisor-{os.getpid()}",
        controls=controls,
        immediate_escalation=notifications.immediate_escalation,
        mode=mode,
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
    adapter = BoundedPolicyAdapter(ledger, controls)
    coordinator.mechanical_outcome = adapter.record_outcome
    processor = (
        RecoveryProcessor(configured, coordinator, verifier, adapter)
        if configured is not None
        else None
    )
    notification_delivery = None
    if delivery is not None:
        notification_delivery = lambda body: delivery(format_recovery_notification(body))
    service = RecoveryService(
        ledger,
        event_spool,
        emergency,
        coordinator=coordinator,
        verifier=verifier,
        adapter=adapter,
        notifications=notifications,
        processor=processor,
        notification_delivery=notification_delivery,
    )
    return service, processor


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
    emergency_configured = bool(
        args.chat_id
        and os.environ.get("MINIME_TELEGRAM_SOPS_FILE", "").strip()
        and os.environ.get("MINIME_TELEGRAM_SOPS_KEY", "").strip()
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
        or (args.mode in {"plan", "enabled"} and not emergency_configured)
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
    processor: RecoveryProcessor | None = None
    try:
        ledger = RecoveryLedger(Path(args.db), busy_timeout_ms=args.busy_timeout_ms)
    except LedgerCorrupt:
        emergency.emit("ledger_corrupt")
        print("recovery supervisor ledger validation failed", file=sys.stderr)
        return 1
    except LedgerUnavailable:
        emergency.emit("ledger_unavailable")
        ledger = None
    if ledger is not None:
        try:
            service, processor = _build_recovery_service(
                ledger,
                event_spool,
                emergency,
                configured=configured,
                configured_rules=configured_rules,
                source_ids=source_ids,
                mode=args.mode,
                delivery=delivery,
            )
        except LedgerUnavailable:
            ledger.close()
            ledger = None
            emergency.emit("ledger_unavailable")
        except LedgerCorrupt:
            ledger.close()
            emergency.emit("ledger_corrupt")
            print("recovery supervisor ledger validation failed", file=sys.stderr)
            return 1
    if ledger is None:
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
        if processor is not None:
            processor.close()
        if ledger is not None:
            ledger.close()
        print("recovery supervisor failed to bind", file=sys.stderr)
        return 1
    server.timeout = 1.0
    print("recovery supervisor ready", flush=True)
    next_ledger_retry = time.monotonic()
    try:
        while True:
            server.handle_request()
            if ledger is None and time.monotonic() >= next_ledger_retry:
                next_ledger_retry = time.monotonic() + 5.0
                recovered_ledger: RecoveryLedger | None = None
                try:
                    recovered_ledger = RecoveryLedger(
                        Path(args.db), busy_timeout_ms=args.busy_timeout_ms
                    )
                    recovered_service, recovered_processor = _build_recovery_service(
                        recovered_ledger,
                        event_spool,
                        emergency,
                        configured=configured,
                        configured_rules=configured_rules,
                        source_ids=source_ids,
                        mode=args.mode,
                        delivery=delivery,
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
                    processor = recovered_processor
                    app.service = recovered_service
            app.service.maintenance()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        if processor is not None:
            processor.close()
        if ledger is not None:
            ledger.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
