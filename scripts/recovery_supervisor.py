#!/usr/bin/env python3
"""Node-independent, same-host recovery event supervisor."""

from __future__ import annotations

import argparse
import copy
from dataclasses import dataclass
import errno
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
    MAX_PROBE_TOTAL_TIMEOUT_MS,
    RECOVERY_MODES,
    RecoveryConfig,
    RecoveryConfigError,
    load_recovery_config,
    recovery_endpoint_allowed,
    recovery_mode_allows_dispatch,
    recovery_static_policy,
    reviewed_operation_executable_matches,
    validated_reviewed_operation,
    validated_probe_command,
)
from recovery_ledger import (
    DEFAULT_EVENT_RETENTION_BATCH_SIZE,
    DEFAULT_EVENT_RETENTION_SECONDS,
    LedgerCorrupt,
    LedgerError,
    LedgerUnavailable,
    RecoveryLedger,
)
from recovery_slots import RecoverySlotError, active_slot_release

MAX_BODY_DEFAULT = 256 * 1024
MAX_CONCURRENT_REQUESTS = 16
MAX_ALERTS_PER_REQUEST = 512
SPOOL_ITEM_MAX_BYTES = 1024 * 1024
AUTH_TOKEN_MAX_BYTES = 4 * 1024
_SAFE_FIELD = re.compile(r"[^A-Za-z0-9 ._:/@+-]+")
_TRANSITION_ID = re.compile(r"^[a-f0-9]{64}$")
_CAPSULE_RELEASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_PREIMAGE_FILE_NAME = re.compile(r"^[a-f0-9]{64}\.preimage$")
_STARTUP_NONCE_HEADER = "X-Minime-Recovery-Startup-Nonce"
_STARTUP_RELEASE_HEADER = "X-Minime-Recovery-Capsule-Release"
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
REPORT_PENDING = "REPORT_PENDING"
REPORTED = "REPORTED"
_CONFIRMATION_BOUNDS = (1, 5)
_COOLDOWN_BOUNDS = (0.0, 86_400.0)
_RETRY_BUDGET_BOUNDS = (0, 10)
_MAX_CONTROL_TTL = 31 * 86_400.0
PROBE_FENCE_POLL_SECONDS = 0.1
PROBE_TERMINATION_GRACE_SECONDS = 0.25
MAX_PROBE_REFRESHES_PER_MAINTENANCE = 1
_FIXER_FENCE_FIELDS = frozenset(
    {
        "invocationId",
        "incidentId",
        "generation",
        "evidenceHash",
        "policyRevision",
        "leaseToken",
    }
)
_FIXER_ENDPOINT_FIELDS = {
    "/v1/fixer/state": frozenset(),
    "/v1/fixer/heartbeat": frozenset(),
    "/v1/fixer/session/bind": frozenset(
        {"sessionId", "sessionDirectory", "transcriptPath", "runtime"}
    ),
    "/v1/fixer/session/resumed": frozenset({"bindingId"}),
    "/v1/fixer/session/replace": frozenset(
        {
            "previousBindingId",
            "sessionId",
            "sessionDirectory",
            "transcriptPath",
            "startupClassifier",
            "journalDigest",
            "runtime",
        }
    ),
    "/v1/fixer/action/intent": frozenset({"actionKey", "toolName", "intent"}),
    "/v1/fixer/action/outcome": frozenset({"actionKey", "outcome", "details"}),
    "/v1/fixer/action/reconcile": frozenset(
        {"actionKey", "idempotencyKey", "result", "details"}
    ),
    "/v1/fixer/guard/rejection": frozenset(
        {"eventKey", "category", "toolName", "inputSha256"}
    ),
    "/v1/fixer/quarantine": frozenset({"idempotencyKey", "sourcePath"}),
    "/v1/fixer/restore": frozenset({"idempotencyKey", "quarantineId"}),
    "/v1/fixer/operation": frozenset({"idempotencyKey", "operationId"}),
    "/v1/fixer/blocked": frozenset({"claimKey", "reason", "residualRisk"}),
    "/v1/fixer/finish": frozenset({"claimKey", "claim"}),
}
_FIXER_ENDPOINT_OPERATIONS = {
    "/v1/fixer/state": "inspect",
    "/v1/fixer/heartbeat": "inspect",
    "/v1/fixer/session/bind": "inspect",
    "/v1/fixer/session/resumed": "inspect",
    "/v1/fixer/session/replace": "inspect",
    "/v1/fixer/action/intent": "mutate",
    "/v1/fixer/action/outcome": "mutate",
    "/v1/fixer/action/reconcile": "reconcile",
    "/v1/fixer/guard/rejection": "reconcile",
    "/v1/fixer/quarantine": "mutate",
    "/v1/fixer/restore": "mutate",
    "/v1/fixer/operation": "mutate",
    "/v1/fixer/blocked": "blocked",
    "/v1/fixer/finish": "finish",
}
_FIXER_RUNNER_ENV_KEYS = frozenset(
    {
        "CI",
        "COLORTERM",
        "FORCE_COLOR",
        "HOME",
        "LANG",
        "LOGNAME",
        "MINIME_AGENT_WORKSPACE_ROOT",
        "MINIME_CONFIG_PATH",
        "MINIME_CONTROL_WORKSPACE_ROOT",
        "MINIME_CRONS_PATH",
        "NO_COLOR",
        "PATH",
        "PI_CODING_AGENT_DIR",
        "PI_EXTENSIONS_DISABLED",
        "PI_OFFLINE",
        "PI_PACKAGE_DIR",
        "PI_SHARE_VIEWER_URL",
        "PI_SKIP_VERSION_CHECK",
        "PI_TELEMETRY",
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
)
_REPORT_SECRET = re.compile(
    r"(?i)(?:bearer\s+|(?:api[-_]?key|auth|password|secret|token|credential)\s*[:=]\s*)[^\s,;]+"
)
_REPORT_KNOWN_CREDENTIAL = re.compile(
    r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|"
    r"\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255}|"
    r"sk-[A-Za-z0-9_-]{20,255}|xox[baprs]-[A-Za-z0-9-]{10,255}|"
    r"AIza[0-9A-Za-z_-]{35})\b|"
    r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"
)
_REPORT_URL_USERINFO = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/@\s]+@")
_REPORT_PRIVATE_KEY = re.compile(
    r"(?i)-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----.*?"
    r"(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY-----|$)"
)
_REPORT_HOME_PATH = re.compile(r"/(?:Users|home)/[^/\s]+(?:/[^\s,;]*)?")
_REPORT_ABSOLUTE_PATH = re.compile(r"(?<![:/A-Za-z0-9])/(?:[^\s,;]+)")


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
            if (
                correlation_key not in state["silences"]
                and len(state["silences"]) >= 128
            ):
                raise ValueError("recovery silence limit is exceeded")
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
        max_actions_per_invocation: int = 128,
        session_root: Path | None = None,
        max_session_replacements: int = 0,
        journal_digest_max_bytes: int = 32_768,
    ):
        if not isinstance(owner, str) or safe_field(owner, default="") != owner:
            raise ValueError("recovery owner is invalid")
        if mode not in RECOVERY_MODES:
            raise ValueError("recovery mode is invalid")
        if (
            isinstance(max_actions_per_invocation, bool)
            or not isinstance(max_actions_per_invocation, int)
            or not 1 <= max_actions_per_invocation <= 1_000
        ):
            raise ValueError("recovery action count bound is invalid")
        self.ledger = ledger
        self.policy = policy
        self.owner = owner
        self.clock = clock
        self.controls = controls or RecoveryControls(
            ledger, base_revision=policy.revision, clock=clock
        )
        self.immediate_escalation = immediate_escalation
        self.mode = mode
        self.max_actions_per_invocation = max_actions_per_invocation
        self.session_root = session_root.resolve() if session_root is not None else None
        self.max_session_replacements = max_session_replacements
        self.journal_digest_max_bytes = journal_digest_max_bytes
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
        latest: list[dict[str, Any]] = []
        rows = self.ledger.latest_events(connection)
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
            latest.append(event)

        grouped: dict[str, list[list[Any]]] = {}
        for event in latest:
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
    def _verification_retry_pending(connection: Any, incident: Any) -> bool:
        target = f"incident:{int(incident['id'])}:generation:{int(incident['generation'])}"
        return connection.execute(
            "SELECT 1 FROM audit WHERE operation = 'verification_retry_scheduled' "
            "AND target = ?",
            (target,),
        ).fetchone() is not None

    @staticmethod
    def _unresolved_actions(connection: Any, incident_id: int) -> bool:
        return connection.execute(
            "SELECT 1 FROM action_intents JOIN invocations "
            "ON invocations.id = action_intents.invocation_id "
            "WHERE invocations.incident_id = ? "
            "AND action_intents.state IN ('pending', 'unknown') LIMIT 1",
            (incident_id,),
        ).fetchone() is not None

    @staticmethod
    def _invalidate_invocation(connection: Any, incident_id: int, now: float) -> None:
        active = connection.execute(
            "SELECT id, lease_token FROM invocations WHERE incident_id = ? AND state = 'active'",
            (incident_id,),
        ).fetchall()
        if not active:
            return
        tokens = [str(row["lease_token"]) for row in active]
        for row in active:
            connection.execute(
                "UPDATE action_intents SET state = 'unknown', updated_at = ? "
                "WHERE invocation_id = ? AND state = 'pending'",
                (now, row["id"]),
            )
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
                "UPDATE action_intents SET state = 'unknown', updated_at = ? "
                "WHERE invocation_id = ? AND state = 'pending'",
                (now, invocation["id"]),
            )
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
                if (
                    incident["state"] in {"eligible", "invoking"}
                    and incident["evidence_hash"] == _EMPTY_EVIDENCE_HASH
                    and self._verification_retry_pending(connection, incident)
                ):
                    # A fresh deterministic contradiction may dispatch the same
                    # bound session once more even though the original alert is
                    # resolved. The durable audit marker is the closed reason
                    # this otherwise-empty generation remains dispatchable.
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
                incident_id = int(incident["id"])
                self._invalidate_invocation(connection, incident_id, now)
                next_generation = int(incident["generation"]) + 1
                reconciliation_required = self._unresolved_actions(
                    connection, incident_id
                )
                next_state = (
                    "eligible"
                    if reconciliation_required and recovery_mode_allows_dispatch(self.mode)
                    else "verifying"
                )
                connection.execute(
                    "UPDATE incidents SET state = ?, generation = generation + 1, "
                    "evidence_hash = ?, policy_revision = ?, updated_at = ? WHERE id = ?",
                    (
                        next_state,
                        _EMPTY_EVIDENCE_HASH,
                        control.revision,
                        now,
                        incident_id,
                    ),
                )
                if next_state == "eligible":
                    connection.execute(
                        "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                        "VALUES (?, 'system', 'verification_retry_scheduled', ?, ?)",
                        (
                            now,
                            f"incident:{incident_id}:generation:{next_generation}",
                            _canonical_json(
                                {
                                    "prior_generation": int(incident["generation"]),
                                    "reason": "action_reconciliation",
                                }
                            ),
                        ),
                    )
            active_count = len(evidence)
        if critical_impact and self.immediate_escalation is not None:
            self.immediate_escalation("confirmed_impact")
        if retries_exhausted and self.immediate_escalation is not None:
            self.immediate_escalation("retries_exhausted")
        return active_count

    def presentation_state(self, incident_id: int) -> str:
        """Map durable foundation states without storing presentation-only names."""

        if not isinstance(incident_id, int) or incident_id < 1:
            raise ValueError("recovery incident id is invalid")
        now = self.clock()
        with self.ledger.transaction() as connection:
            incident = connection.execute(
                "SELECT * FROM incidents WHERE id = ?", (incident_id,)
            ).fetchone()
            if incident is None:
                raise ValueError("recovery incident id is invalid")
            raw_state = str(incident["state"])
            if raw_state == "eligible":
                control = self.controls.current(connection, now=now)
                detail = self._active_evidence_details(connection).get(
                    str(incident["correlation_key"])
                )
                if detail is None:
                    return "ELIGIBLE"
                if detail.max_impact >= 3 or detail.confirmation_count >= control.confirmation_count:
                    return "ELIGIBLE"
                return "OBSERVED" if detail.confirmation_count == 1 else "CONFIRMING"
            return {
                "invoking": "RUNNING",
                "verifying": "VERIFYING",
                "recovered": "RECOVERED",
                "recovery_unsafe": "BLOCKED",
                "recovery_failed": "FAILED",
                "retries_exhausted": "ESCALATED",
            }.get(raw_state, raw_state.upper())

    def claim_next(self) -> InvocationFence | None:
        """Acquire the one global lease and atomically create one invocation."""

        self.reconcile()
        if not recovery_mode_allows_dispatch(self.mode):
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
                "SELECT * FROM incidents WHERE state = 'eligible' ORDER BY opened_at, id"
            ).fetchall()
            active = self._active_evidence_details(connection)
            incident = None
            for candidate in candidates:
                correlation_key = str(candidate["correlation_key"])
                details = active.get(correlation_key)
                verification_retry = bool(
                    candidate["evidence_hash"] == _EMPTY_EVIDENCE_HASH
                    and self._verification_retry_pending(connection, candidate)
                )
                if details is None and not verification_retry:
                    continue
                if control.silence_expiry(correlation_key, now) is not None:
                    continue
                critical = verification_retry or bool(details and details.max_impact >= 3)
                if (
                    not critical
                    and details is not None
                    and details.confirmation_count < control.confirmation_count
                ):
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

    def invocation_fence_valid(self, fence: InvocationFence) -> bool:
        """Recompute the complete durable fixer fence without renewing it."""

        now = self.clock()
        with self.ledger.transaction() as connection:
            return self._fence_valid(connection, fence, now)

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
            latest: list[tuple[Any, dict[str, Any]]] = []
            rows = self.ledger.latest_events(connection)
            for row in rows:
                try:
                    event = json.loads(str(row["normalized_json"]))
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
                latest.append((row, event))
            evidence: list[dict[str, Any]] = []
            for row, event in latest:
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
                incident_row = connection.execute(
                    "SELECT * FROM incidents WHERE id = ?", (fence.incident_id,)
                ).fetchone()
                retry = bool(
                    incident_row is not None
                    and incident_row["evidence_hash"] == _EMPTY_EVIDENCE_HASH
                    and self._verification_retry_pending(connection, incident_row)
                )
                attempt = connection.execute(
                    "SELECT id, result, reasons_json, evidence_json "
                    "FROM verification_attempts WHERE incident_id = ? AND generation < ? "
                    "AND result = 'contradicted' ORDER BY generation DESC, attempt DESC LIMIT 1",
                    (fence.incident_id, fence.generation),
                ).fetchone()
                if retry and attempt is None:
                    unresolved = connection.execute(
                        "SELECT action_intents.id, action_intents.action_key "
                        "FROM action_intents JOIN invocations "
                        "ON invocations.id = action_intents.invocation_id "
                        "WHERE invocations.incident_id = ? "
                        "AND action_intents.state IN ('pending', 'unknown') "
                        "ORDER BY action_intents.id LIMIT 32",
                        (fence.incident_id,),
                    ).fetchall()
                    if unresolved:
                        return [
                            {
                                "ref": f"action:{int(row['id'])}",
                                "kind": "actionReconciliation",
                                "actionKey": str(row["action_key"]),
                            }
                            for row in unresolved
                        ]
                if not retry or attempt is None:
                    raise ValueError("recovery invocation evidence is unavailable")
                try:
                    reasons = json.loads(str(attempt["reasons_json"]))
                    observations = json.loads(str(attempt["evidence_json"]))
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise LedgerCorrupt("recovery verification evidence is invalid") from exc
                if not isinstance(reasons, list) or not isinstance(observations, list):
                    raise LedgerCorrupt("recovery verification evidence is invalid")
                return [
                    {
                        "ref": f"verification:{int(attempt['id'])}",
                        "kind": "deterministicContradiction",
                        "reasons": [safe_field(reason) for reason in reasons[:32]],
                        "observations": observations[:32],
                    }
                ]
            return evidence[:32]

    @staticmethod
    def _journal_text(value: Any, name: str, *, limit: int = 160) -> str:
        if not isinstance(value, str) or safe_field(value, limit=limit, default="") != value:
            raise ValueError(f"recovery {name} is invalid")
        return value

    @staticmethod
    def _journal_json(value: Any, name: str, *, limit: int = 256 * 1024) -> str:
        if not isinstance(value, dict):
            raise ValueError(f"recovery {name} is invalid")
        try:
            encoded = _canonical_json(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"recovery {name} is invalid") from exc
        if len(encoded.encode("utf-8")) > limit:
            raise ValueError(f"recovery {name} is too large")
        return encoded

    @staticmethod
    def _session_path(value: Any, name: str) -> str:
        try:
            encoded_size = len(value.encode("utf-8")) if isinstance(value, str) else 0
        except UnicodeEncodeError:
            encoded_size = 4_097
        if (
            not isinstance(value, str)
            or not value
            or "\0" in value
            or encoded_size > 4_096
        ):
            raise ValueError(f"recovery {name} is invalid")
        path = Path(value)
        if not path.is_absolute() or ".." in path.parts:
            raise ValueError(f"recovery {name} is invalid")
        return str(path)

    def endpoint_allowed(self, operation: str) -> bool:
        return recovery_endpoint_allowed(self.mode, operation)

    @staticmethod
    def _binding_document(row: Any) -> dict[str, Any]:
        return {
            "bindingId": int(row["id"]),
            "sessionId": str(row["session_id"]),
            "sessionDirectory": str(row["session_directory"]),
            "transcriptPath": str(row["transcript_path"]),
            "generation": int(row["generation"]),
            "runtime": json.loads(str(row["runtime_json"])),
        }

    def _runtime_versions(self, value: Any) -> tuple[dict[str, str], str]:
        if value is None:
            value = {name: "unreported" for name in ("model", "node", "package", "pi")}
        if not isinstance(value, dict) or set(value) != {"model", "node", "package", "pi"}:
            raise ValueError("recovery runtime versions are invalid")
        normalized = {
            name: self._journal_text(value[name], f"runtime {name}", limit=160)
            for name in ("model", "node", "package", "pi")
        }
        return normalized, _canonical_json(normalized)

    def fixer_state(self, fence: InvocationFence) -> dict[str, Any] | None:
        """Return bounded, redacted state needed to resume and reconcile one fixer."""

        if not self.endpoint_allowed("inspect"):
            return None
        evidence = self.invocation_evidence(fence)
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return None
            current = connection.execute(
                "SELECT * FROM session_bindings WHERE incident_id = ? AND generation = ? "
                "AND state = 'current' ORDER BY id DESC LIMIT 1",
                (fence.incident_id, fence.generation),
            ).fetchone()
            resume = current or connection.execute(
                "SELECT * FROM session_bindings WHERE incident_id = ? AND state = 'current' "
                "ORDER BY generation DESC, id DESC LIMIT 1",
                (fence.incident_id,),
            ).fetchone()
            actions: list[dict[str, Any]] = []
            for row in connection.execute(
                "SELECT action_intents.action_key, action_intents.tool_name, "
                "action_intents.intent_json FROM action_intents "
                "JOIN invocations ON invocations.id = action_intents.invocation_id "
                "WHERE invocations.incident_id = ? AND action_intents.state = 'unknown' "
                "ORDER BY action_intents.id",
                (fence.incident_id,),
            ).fetchall():
                try:
                    intent = json.loads(str(row["intent_json"]))
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise LedgerCorrupt("recovery action intent is invalid") from exc
                if not isinstance(intent, dict):
                    raise LedgerCorrupt("recovery action intent is invalid")
                actions.append(
                    {
                        "actionKey": str(row["action_key"]),
                        "toolName": str(row["tool_name"]),
                        "intent": intent,
                        "state": "unknown",
                    }
                )
            digest_source = _canonical_json({"evidence": evidence, "unknownActions": actions})
            encoded = digest_source.encode("utf-8")
            if len(encoded) > self.journal_digest_max_bytes:
                digest_source = _canonical_json(
                    {
                        "evidenceRefs": [item["ref"] for item in evidence],
                        "unknownActionKeys": [item["actionKey"] for item in actions],
                        "sha256": hashlib.sha256(encoded).hexdigest(),
                        "truncated": True,
                    }
                )
            result: dict[str, Any] = {
                "mode": self.mode,
                "evidence": evidence,
                "unknownActions": actions,
                "journalDigest": digest_source,
            }
            if current is not None:
                result["currentSession"] = self._binding_document(current)
            if resume is not None:
                result["resumeSession"] = self._binding_document(resume)
            return result

    def mark_session_resumed(self, fence: InvocationFence, binding_id: int) -> bool:
        if not self.endpoint_allowed("inspect") or isinstance(binding_id, bool) or binding_id < 1:
            return False
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return False
            binding = connection.execute(
                "SELECT * FROM session_bindings WHERE id = ? AND incident_id = ? "
                "AND generation = ? AND state = 'current'",
                (binding_id, fence.incident_id, fence.generation),
            ).fetchone()
            if binding is None:
                return False
            connection.execute(
                "UPDATE session_bindings SET last_resumed_at = ? WHERE id = ?",
                (now, binding_id),
            )
            return True

    def _configured_session_path(self, value: str) -> bool:
        if self.session_root is None:
            return True
        try:
            Path(value).resolve(strict=False).relative_to(self.session_root)
        except ValueError:
            return False
        return True

    @staticmethod
    def _transcript_is_unusable(binding: Any) -> bool:
        directory = Path(str(binding["session_directory"]))
        transcript = Path(str(binding["transcript_path"]))
        try:
            directory_details = directory.lstat()
            transcript_details = transcript.lstat()
            if (
                not stat.S_ISDIR(directory_details.st_mode)
                or stat.S_ISLNK(directory_details.st_mode)
                or directory_details.st_uid != os.getuid()
                or directory_details.st_mode & 0o077
                or not stat.S_ISREG(transcript_details.st_mode)
                or stat.S_ISLNK(transcript_details.st_mode)
                or transcript_details.st_uid != os.getuid()
                or transcript_details.st_mode & 0o077
            ):
                return True
            canonical_directory = directory.resolve(strict=True)
            canonical_transcript = transcript.resolve(strict=True)
            canonical_transcript.relative_to(canonical_directory)
            with canonical_transcript.open("r", encoding="utf-8") as handle:
                first = handle.readline(65_537)
            if len(first.encode("utf-8")) > 65_536:
                return True
            header = json.loads(first)
            return not (
                isinstance(header, dict)
                and header.get("type") == "session"
                and header.get("id") == binding["session_id"]
            )
        except (OSError, ValueError, UnicodeError, json.JSONDecodeError):
            return True

    def replace_session_with_proof(
        self,
        fence: InvocationFence,
        *,
        previous_binding_id: int,
        session_id: str,
        session_directory: str,
        transcript_path: str,
        startup_classifier: str,
        journal_digest: str,
        runtime: dict[str, Any] | None = None,
    ) -> int | None:
        if startup_classifier != "no_session_found":
            return None
        with self.ledger.transaction() as connection:
            previous = connection.execute(
                "SELECT * FROM session_bindings WHERE id = ? AND incident_id = ? "
                "AND state = 'current'",
                (previous_binding_id, fence.incident_id),
            ).fetchone()
            if previous is None or not self._transcript_is_unusable(previous):
                return None
        return self.replace_session(
            fence,
            previous_binding_id=previous_binding_id,
            session_id=session_id,
            session_directory=session_directory,
            transcript_path=transcript_path,
            reason="transcript_unusable_and_resume_not_found",
            journal_digest=journal_digest,
            runtime=runtime,
            max_replacements=self.max_session_replacements,
        )

    def bind_session(
        self,
        fence: InvocationFence,
        *,
        session_id: str,
        session_directory: str,
        transcript_path: str,
        runtime: dict[str, Any] | None = None,
    ) -> int | None:
        """Idempotently commit the first exact-session binding behind a live fence."""

        identifier = self._journal_text(session_id, "session id", limit=128)
        _runtime, runtime_json = self._runtime_versions(runtime)
        directory = self._session_path(session_directory, "session directory")
        transcript = self._session_path(transcript_path, "session transcript path")
        try:
            Path(transcript).relative_to(Path(directory))
        except ValueError:
            raise ValueError("recovery session transcript escapes its directory") from None
        if Path(transcript).suffix != ".jsonl":
            raise ValueError("recovery session transcript path is invalid")
        if (
            not self._configured_session_path(directory)
            or not self._configured_session_path(transcript)
            or (
                self.session_root is not None
                and self._transcript_is_unusable(
                    {
                        "session_id": identifier,
                        "session_directory": directory,
                        "transcript_path": transcript,
                    }
                )
            )
        ):
            raise ValueError("recovery session binding storage is invalid")
        if not recovery_mode_allows_dispatch(self.mode):
            return None
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return None
            existing = connection.execute(
                "SELECT * FROM session_bindings WHERE incident_id = ? AND generation = ? "
                "AND state = 'current' ORDER BY id DESC LIMIT 1",
                (fence.incident_id, fence.generation),
            ).fetchone()
            if existing is not None:
                if (
                    existing["invocation_id"] == fence.invocation_id
                    and existing["session_id"] == identifier
                    and existing["session_directory"] == directory
                    and existing["transcript_path"] == transcript
                    and existing["runtime_json"] == runtime_json
                ):
                    return int(existing["id"])
                raise ValueError("recovery session generation is already bound")
            cursor = connection.execute(
                "INSERT INTO session_bindings(incident_id, generation, evidence_hash, "
                "policy_revision, invocation_id, session_id, session_directory, transcript_path, "
                "runtime_json, state, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)",
                (
                    fence.incident_id,
                    fence.generation,
                    fence.evidence_hash,
                    fence.policy_revision,
                    fence.invocation_id,
                    identifier,
                    directory,
                    transcript,
                    runtime_json,
                    now,
                ),
            )
            return int(cursor.lastrowid)

    def replace_session(
        self,
        fence: InvocationFence,
        *,
        previous_binding_id: int,
        session_id: str,
        session_directory: str,
        transcript_path: str,
        reason: str,
        journal_digest: str,
        max_replacements: int,
        runtime: dict[str, Any] | None = None,
    ) -> int | None:
        """Record an explicitly bounded replacement without losing the prior binding."""

        if (
            isinstance(previous_binding_id, bool)
            or not isinstance(previous_binding_id, int)
            or previous_binding_id < 1
            or isinstance(max_replacements, bool)
            or not isinstance(max_replacements, int)
            or not 0 <= max_replacements <= 10
        ):
            raise ValueError("recovery session replacement is invalid")
        identifier = self._journal_text(session_id, "session id", limit=128)
        _runtime, runtime_json = self._runtime_versions(runtime)
        directory = self._session_path(session_directory, "session directory")
        transcript = self._session_path(transcript_path, "session transcript path")
        replacement_reason = self._journal_text(reason, "session replacement reason")
        try:
            digest_size = (
                len(journal_digest.encode("utf-8"))
                if isinstance(journal_digest, str)
                else 262_145
            )
        except UnicodeEncodeError:
            digest_size = 262_145
        if not isinstance(journal_digest, str) or digest_size > 262_144:
            raise ValueError("recovery session journal digest is invalid")
        try:
            Path(transcript).relative_to(Path(directory))
        except ValueError:
            raise ValueError("recovery session transcript escapes its directory") from None
        if Path(transcript).suffix != ".jsonl":
            raise ValueError("recovery session transcript path is invalid")
        if (
            not self._configured_session_path(directory)
            or not self._configured_session_path(transcript)
            or (
                self.session_root is not None
                and self._transcript_is_unusable(
                    {
                        "session_id": identifier,
                        "session_directory": directory,
                        "transcript_path": transcript,
                    }
                )
            )
        ):
            raise ValueError("recovery session binding storage is invalid")
        if not recovery_mode_allows_dispatch(self.mode):
            return None
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return None
            previous = connection.execute(
                "SELECT * FROM session_bindings WHERE id = ? AND incident_id = ? "
                "AND state = 'current'",
                (previous_binding_id, fence.incident_id),
            ).fetchone()
            if previous is None:
                return None
            replacements = int(
                connection.execute(
                    "SELECT count(*) FROM session_replacements WHERE incident_id = ? "
                    "AND generation = ?",
                    (fence.incident_id, fence.generation),
                ).fetchone()[0]
            )
            if replacements >= max_replacements:
                return None
            if previous["session_id"] == identifier or previous["transcript_path"] == transcript:
                raise ValueError("recovery replacement session must be distinct")
            connection.execute(
                "UPDATE session_bindings SET state = 'replaced' WHERE id = ?",
                (previous_binding_id,),
            )
            cursor = connection.execute(
                "INSERT INTO session_bindings(incident_id, generation, evidence_hash, "
                "policy_revision, invocation_id, session_id, session_directory, transcript_path, "
                "runtime_json, state, bound_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'current', ?)",
                (
                    fence.incident_id,
                    fence.generation,
                    fence.evidence_hash,
                    fence.policy_revision,
                    fence.invocation_id,
                    identifier,
                    directory,
                    transcript,
                    runtime_json,
                    now,
                ),
            )
            replacement_id = int(cursor.lastrowid)
            connection.execute(
                "INSERT INTO session_replacements(incident_id, generation, previous_binding_id, "
                "replacement_binding_id, reason, journal_digest, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    fence.incident_id,
                    fence.generation,
                    previous_binding_id,
                    replacement_id,
                    replacement_reason,
                    journal_digest,
                    now,
                ),
            )
            return replacement_id

    def record_action_intent(
        self,
        fence: InvocationFence,
        *,
        action_key: str,
        tool_name: str,
        intent: dict[str, Any],
    ) -> int | None:
        """Commit a mutating action intent and block on every unresolved predecessor."""

        if not self.endpoint_allowed("mutate"):
            return None
        key = self._journal_text(action_key, "action key")
        tool = self._journal_text(tool_name, "action tool", limit=80)
        encoded = self._journal_json(intent, "action intent", limit=64 * 1024)
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return None
            existing = connection.execute(
                "SELECT * FROM action_intents WHERE invocation_id = ? AND action_key = ?",
                (fence.invocation_id, key),
            ).fetchone()
            if existing is not None:
                if existing["tool_name"] != tool or existing["intent_json"] != encoded:
                    raise ValueError("recovery action idempotency key was reused")
                return int(existing["id"])
            unresolved = connection.execute(
                "SELECT 1 FROM action_intents JOIN invocations "
                "ON invocations.id = action_intents.invocation_id "
                "WHERE invocations.incident_id = ? "
                "AND action_intents.state IN ('pending', 'unknown') LIMIT 1",
                (fence.incident_id,),
            ).fetchone()
            if unresolved is not None:
                return None
            count = int(
                connection.execute(
                    "SELECT count(*) FROM action_intents WHERE invocation_id = ?",
                    (fence.invocation_id,),
                ).fetchone()[0]
            )
            if count >= self.max_actions_per_invocation:
                return None
            cursor = connection.execute(
                "INSERT INTO action_intents(invocation_id, action_key, tool_name, intent_json, "
                "state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
                (fence.invocation_id, key, tool, encoded, now, now),
            )
            return int(cursor.lastrowid)

    def record_action_outcome(
        self,
        fence: InvocationFence,
        *,
        action_key: str,
        outcome: str,
        details: dict[str, Any],
    ) -> bool:
        if outcome not in {"succeeded", "failed"}:
            raise ValueError("recovery action outcome is invalid")
        key = self._journal_text(action_key, "action key")
        encoded = self._journal_json(details, "action outcome", limit=64 * 1024)
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return False
            intent = connection.execute(
                "SELECT * FROM action_intents WHERE invocation_id = ? AND action_key = ?",
                (fence.invocation_id, key),
            ).fetchone()
            if intent is None:
                return False
            existing = connection.execute(
                "SELECT outcome, outcome_json FROM action_outcomes WHERE action_intent_id = ?",
                (intent["id"],),
            ).fetchone()
            if existing is not None:
                if existing["outcome"] != outcome or existing["outcome_json"] != encoded:
                    raise ValueError("recovery action outcome conflicts with its first record")
                return True
            if intent["state"] != "pending":
                return False
            connection.execute(
                "INSERT INTO action_outcomes(action_intent_id, outcome, outcome_json, created_at) "
                "VALUES (?, ?, ?, ?)",
                (intent["id"], outcome, encoded, now),
            )
            connection.execute(
                "UPDATE action_intents SET state = 'completed', updated_at = ? WHERE id = ?",
                (now, intent["id"]),
            )
            return True

    def mark_action_unknown(self, fence: InvocationFence, *, action_key: str) -> bool:
        """Persist an ambiguous mutation even when host state invalidated its live fence."""

        key = self._journal_text(action_key, "action key")
        now = self.clock()
        with self.ledger.transaction() as connection:
            row = connection.execute(
                "SELECT action_intents.id, action_intents.state, invocations.incident_id, "
                "invocations.generation, invocations.evidence_hash, "
                "invocations.policy_revision, invocations.lease_token "
                "FROM action_intents JOIN invocations "
                "ON invocations.id = action_intents.invocation_id "
                "WHERE action_intents.invocation_id = ? AND action_intents.action_key = ?",
                (fence.invocation_id, key),
            ).fetchone()
            if row is None or (
                int(row["incident_id"]) != fence.incident_id
                or int(row["generation"]) != fence.generation
                or str(row["evidence_hash"]) != fence.evidence_hash
                or int(row["policy_revision"]) != fence.policy_revision
                or str(row["lease_token"]) != fence.lease_token
            ):
                return False
            if row["state"] == "unknown":
                return True
            if row["state"] != "pending":
                return False
            connection.execute(
                "UPDATE action_intents SET state = 'unknown', updated_at = ? WHERE id = ?",
                (now, row["id"]),
            )
            return True

    def reconcile_action(
        self,
        fence: InvocationFence,
        *,
        action_key: str,
        idempotency_key: str,
        result: str,
        details: dict[str, Any],
    ) -> bool:
        if not self.endpoint_allowed("reconcile"):
            return False
        if result not in {"applied", "not_applied"}:
            raise ValueError("recovery action reconciliation result is invalid")
        key = self._journal_text(action_key, "action key")
        idempotency = self._journal_text(
            idempotency_key, "action reconciliation idempotency key"
        )
        encoded = self._journal_json(details, "action reconciliation", limit=64 * 1024)
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return False
            intent = connection.execute(
                "SELECT action_intents.* FROM action_intents JOIN invocations "
                "ON invocations.id = action_intents.invocation_id "
                "WHERE invocations.incident_id = ? AND action_intents.action_key = ? "
                "AND action_intents.state IN ('unknown', 'reconciled') "
                "ORDER BY action_intents.id DESC LIMIT 1",
                (fence.incident_id, key),
            ).fetchone()
            if intent is None:
                return False
            existing = connection.execute(
                "SELECT idempotency_key, result, details_json FROM action_reconciliations "
                "WHERE action_intent_id = ?",
                (intent["id"],),
            ).fetchone()
            if existing is not None:
                if (
                    existing["idempotency_key"] != idempotency
                    or existing["result"] != result
                    or existing["details_json"] != encoded
                ):
                    raise ValueError("recovery action reconciliation conflicts with its first record")
                return True
            if intent["state"] != "unknown":
                return False
            connection.execute(
                "INSERT INTO action_reconciliations(action_intent_id, idempotency_key, result, "
                "details_json, created_at) VALUES (?, ?, ?, ?, ?)",
                (intent["id"], idempotency, result, encoded, now),
            )
            connection.execute(
                "UPDATE action_intents SET state = 'reconciled', updated_at = ? WHERE id = ?",
                (now, intent["id"]),
            )
            return True

    def action_status(
        self, fence: InvocationFence, action_key: str
    ) -> tuple[str, str, dict[str, Any], str | None, dict[str, Any] | None] | None:
        """Inspect one supervisor-owned action without exposing mutable inputs."""

        key = self._journal_text(action_key, "action key")
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return None
            row = connection.execute(
                "SELECT action_intents.state, action_intents.tool_name, "
                "action_intents.intent_json, action_outcomes.outcome, "
                "action_outcomes.outcome_json FROM action_intents "
                "LEFT JOIN action_outcomes "
                "ON action_outcomes.action_intent_id = action_intents.id "
                "WHERE action_intents.invocation_id = ? "
                "AND action_intents.action_key = ?",
                (fence.invocation_id, key),
            ).fetchone()
            if row is None:
                return None
            try:
                intent = json.loads(str(row["intent_json"]))
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise LedgerCorrupt("recovery action intent is invalid") from exc
            if not isinstance(intent, dict):
                raise LedgerCorrupt("recovery action intent is invalid")
            details: dict[str, Any] | None = None
            if row["outcome_json"] is not None:
                try:
                    parsed = json.loads(str(row["outcome_json"]))
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise LedgerCorrupt("recovery action outcome is invalid") from exc
                if not isinstance(parsed, dict):
                    raise LedgerCorrupt("recovery action outcome is invalid")
                details = parsed
            return (
                str(row["state"]),
                str(row["tool_name"]),
                intent,
                None if row["outcome"] is None else str(row["outcome"]),
                details,
            )

    def record_guard_rejection(
        self,
        fence: InvocationFence,
        *,
        event_key: str,
        category: str,
        tool_name: str,
        input_sha256: str,
    ) -> bool:
        """Audit a rejected tool call; the rejected host mutation never runs."""

        if not self.endpoint_allowed("reconcile"):
            return False
        event = self._journal_text(event_key, "guard event key")
        guard_category = self._journal_text(category, "guard category", limit=80)
        tool = self._journal_text(tool_name, "guard tool", limit=80)
        if not isinstance(input_sha256, str) or _TRANSITION_ID.fullmatch(input_sha256) is None:
            raise ValueError("recovery guard input digest is invalid")
        now = self.clock()
        target = f"invocation:{fence.invocation_id}:guard:{event}"
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return False
            existing = connection.execute(
                "SELECT details_json FROM audit WHERE operation = 'guard_rejected' "
                "AND target = ?",
                (target,),
            ).fetchone()
            details = _canonical_json(
                {
                    "category": guard_category,
                    "inputSha256": input_sha256,
                    "toolName": tool,
                }
            )
            if existing is not None:
                if existing["details_json"] != details:
                    raise ValueError("recovery guard event key was reused")
                return True
            connection.execute(
                "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                "VALUES (?, 'fixer-extension', 'guard_rejected', ?, ?)",
                (now, target, details),
            )
            return True

    def record_completion_claim(
        self,
        fence: InvocationFence,
        *,
        claim_key: str,
        claim: dict[str, Any],
    ) -> int | None:
        if not self.endpoint_allowed("finish"):
            return None
        key = self._journal_text(claim_key, "completion claim key")
        encoded = self._journal_json(claim, "completion claim")
        now = self.clock()
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                return None
            if connection.execute(
                "SELECT 1 FROM action_intents JOIN invocations "
                "ON invocations.id = action_intents.invocation_id "
                "WHERE invocations.incident_id = ? "
                "AND action_intents.state IN ('pending', 'unknown') LIMIT 1",
                (fence.incident_id,),
            ).fetchone() is not None:
                return None
            existing = connection.execute(
                "SELECT * FROM fixer_claims WHERE invocation_id = ?",
                (fence.invocation_id,),
            ).fetchone()
            if existing is not None:
                if existing["claim_key"] != key or existing["claim_json"] != encoded:
                    raise ValueError("recovery completion claim conflicts with its first record")
                return int(existing["id"])
            cursor = connection.execute(
                "INSERT INTO fixer_claims(invocation_id, incident_id, generation, evidence_hash, "
                "policy_revision, claim_key, claim_json, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    fence.invocation_id,
                    fence.incident_id,
                    fence.generation,
                    fence.evidence_hash,
                    fence.policy_revision,
                    key,
                    encoded,
                    now,
                ),
            )
            return int(cursor.lastrowid)

    def _finished_claim_matches(
        self,
        fence: InvocationFence,
        *,
        claim_key: str,
        claim_json: str,
        outcome: str,
    ) -> bool:
        with self.ledger.transaction() as connection:
            invocation = connection.execute(
                "SELECT * FROM invocations WHERE id = ?", (fence.invocation_id,)
            ).fetchone()
            claim = connection.execute(
                "SELECT claim_key, claim_json FROM fixer_claims WHERE invocation_id = ?",
                (fence.invocation_id,),
            ).fetchone()
            return bool(
                invocation is not None
                and claim is not None
                and invocation["incident_id"] == fence.incident_id
                and invocation["generation"] == fence.generation
                and invocation["evidence_hash"] == fence.evidence_hash
                and invocation["policy_revision"] == fence.policy_revision
                and invocation["lease_token"] == fence.lease_token
                and invocation["state"] == outcome
                and claim["claim_key"] == claim_key
                and claim["claim_json"] == claim_json
            )

    def accept_completion_claim(
        self,
        fence: InvocationFence,
        *,
        claim_key: str,
        claim: dict[str, Any],
    ) -> bool:
        key = self._journal_text(claim_key, "completion claim key")
        encoded = self._journal_json(claim, "completion claim")
        claim_id = self.record_completion_claim(fence, claim_key=key, claim=claim)
        if claim_id is not None and self.finish(fence, "completed"):
            return True
        return self._finished_claim_matches(
            fence,
            claim_key=key,
            claim_json=encoded,
            outcome="completed",
        )

    def accept_blocked_claim(
        self,
        fence: InvocationFence,
        *,
        claim_key: str,
        reason: str,
        residual_risk: str | None,
    ) -> bool:
        if not self.endpoint_allowed("blocked"):
            return False
        key = self._journal_text(claim_key, "blocked claim key")
        if (
            not isinstance(reason, str)
            or not reason
            or "\0" in reason
            or len(reason.encode("utf-8")) > 4_096
        ):
            raise ValueError("recovery blocked reason is invalid")
        if residual_risk is not None and (
            not isinstance(residual_risk, str)
            or "\0" in residual_risk
            or len(residual_risk.encode("utf-8")) > 4_096
        ):
            raise ValueError("recovery blocked residual risk is invalid")
        blocked_reason = reason
        risk = residual_risk
        claim = {"kind": "blocked", "reason": blocked_reason, "residualRisk": risk}
        encoded = self._journal_json(claim, "blocked claim")
        now = self.clock()
        with self.ledger.transaction() as connection:
            if self._fence_valid(connection, fence, now):
                existing = connection.execute(
                    "SELECT claim_key, claim_json FROM fixer_claims WHERE invocation_id = ?",
                    (fence.invocation_id,),
                ).fetchone()
                if existing is None:
                    connection.execute(
                        "INSERT INTO fixer_claims(invocation_id, incident_id, generation, "
                        "evidence_hash, policy_revision, claim_key, claim_json, claimed_at) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (
                            fence.invocation_id,
                            fence.incident_id,
                            fence.generation,
                            fence.evidence_hash,
                            fence.policy_revision,
                            key,
                            encoded,
                            now,
                        ),
                    )
                elif existing["claim_key"] != key or existing["claim_json"] != encoded:
                    raise ValueError("recovery blocked claim conflicts with its first record")
        if self.finish(fence, "recovery_unsafe"):
            return True
        return self._finished_claim_matches(
            fence,
            claim_key=key,
            claim_json=encoded,
            outcome="recovery_unsafe",
        )

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

    def interrupt_invocation(self, fence: InvocationFence, *, reason: str) -> bool:
        """Classify one runner exit and consume only the static crash retry budget."""

        interruption_reason = self._journal_text(
            reason, "invocation interruption reason", limit=80
        )
        now = self.clock()
        exhausted = False
        with self.ledger.transaction() as connection:
            if not self._fence_valid(connection, fence, now):
                invocation = connection.execute(
                    "SELECT state FROM invocations WHERE id = ?", (fence.invocation_id,)
                ).fetchone()
                return bool(invocation is not None and invocation["state"] != "active")
            control = self.controls.current(connection, now=now)
            connection.execute(
                "UPDATE action_intents SET state = 'unknown', updated_at = ? "
                "WHERE invocation_id = ? AND state = 'pending'",
                (now, fence.invocation_id),
            )
            connection.execute(
                "UPDATE invocations SET state = 'interrupted', updated_at = ? WHERE id = ?",
                (now, fence.invocation_id),
            )
            interruptions = int(
                connection.execute(
                    "SELECT count(*) FROM invocations WHERE incident_id = ? "
                    "AND evidence_hash = ? AND policy_revision = ? "
                    "AND state = 'interrupted'",
                    (
                        fence.incident_id,
                        fence.evidence_hash,
                        fence.policy_revision,
                    ),
                ).fetchone()[0]
            )
            retry_limit = min(self.policy.max_crash_retries, control.retry_budget)
            next_state = "eligible" if interruptions <= retry_limit else "retries_exhausted"
            exhausted = next_state == "retries_exhausted"
            connection.execute(
                "UPDATE incidents SET state = ?, generation = generation + 1, updated_at = ? "
                "WHERE id = ?",
                (next_state, now, fence.incident_id),
            )
            connection.execute(
                "UPDATE fixer_lease SET owner = NULL, token = NULL, acquired_at = NULL, "
                "expires_at = NULL WHERE singleton = 1 AND token = ?",
                (fence.lease_token,),
            )
            connection.execute(
                "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                "VALUES (?, 'system', 'fixer_interrupted', ?, ?)",
                (
                    now,
                    f"invocation:{fence.invocation_id}",
                    _canonical_json(
                        {
                            "reason": interruption_reason,
                            "retry_limit": retry_limit,
                            "state": next_state,
                        }
                    ),
                ),
            )
        if exhausted and self.immediate_escalation is not None:
            self.immediate_escalation("retries_exhausted")
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

    def mark_missed_recovery(
        self,
        incident_id: int,
        *,
        dedupe_key: str,
        result: VerificationResult,
    ) -> bool:
        """Retry one fresh contradiction, or exhaust the closed retry budget."""

        if not isinstance(incident_id, int) or incident_id < 1:
            raise ValueError("recovery incident id is invalid")
        if safe_field(dedupe_key, limit=160, default="") != dedupe_key:
            raise ValueError("recovery verification dedupe key is invalid")
        claim = re.fullmatch(r"invocation:([1-9][0-9]*):verification:([1-9][0-9]*)", dedupe_key)
        now = self.clock()
        if claim is None or not _is_fresh_contradiction(result, now=now):
            return False
        invocation_id = int(claim.group(1))
        verification_generation = int(claim.group(2))
        target = f"incident:{incident_id}:{dedupe_key}"
        exhausted = False
        with self.ledger.transaction() as connection:
            if connection.execute(
                "SELECT 1 FROM audit WHERE operation = 'verification_failed' AND target = ?",
                (target,),
            ).fetchone() is not None:
                return False
            incident = connection.execute(
                "SELECT state, generation, policy_revision, correlation_key "
                "FROM incidents WHERE id = ?",
                (incident_id,),
            ).fetchone()
            if (
                incident is None
                or incident["state"] != "verifying"
                or int(incident["generation"]) != verification_generation
            ):
                return False
            control = self.controls.current(connection, now=now)
            if (
                control.revision != int(incident["policy_revision"])
                or not self._static_policy_matches(connection, control.revision)
                or str(incident["correlation_key"]) in self._active_evidence(connection)
                or not _current_evidence_matches(
                    connection,
                    incident_id=incident_id,
                    generation=verification_generation,
                    policy_revision=int(incident["policy_revision"]),
                    result=result,
                    now=now,
                )
            ):
                return False
            invocation = connection.execute(
                "SELECT invocations.generation FROM invocations JOIN fixer_claims "
                "ON fixer_claims.invocation_id = invocations.id "
                "WHERE invocations.id = ? AND invocations.incident_id = ? "
                "AND invocations.state = 'completed' AND invocations.policy_revision = ?",
                (invocation_id, incident_id, incident["policy_revision"]),
            ).fetchone()
            if (
                invocation is None
                or not max(1, verification_generation - 1)
                <= int(invocation["generation"])
                <= verification_generation
            ):
                return False
            retries = int(
                connection.execute(
                    "SELECT count(*) FROM audit WHERE operation = "
                    "'verification_retry_scheduled' AND target LIKE ?",
                    (f"incident:{incident_id}:generation:%",),
                ).fetchone()[0]
            )
            next_generation = verification_generation + 1
            exhausted = retries >= control.retry_budget
            next_state = "retries_exhausted" if exhausted else "eligible"
            connection.execute(
                "UPDATE incidents SET state = ?, generation = ?, evidence_hash = ?, "
                "updated_at = ? WHERE id = ?",
                (next_state, next_generation, _EMPTY_EVIDENCE_HASH, now, incident_id),
            )
            connection.execute(
                "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                "VALUES (?, 'system', 'verification_failed', ?, ?)",
                (
                    now,
                    target,
                    _canonical_json(
                        {
                            "reason": "fresh_contradiction",
                            "state": next_state,
                        }
                    ),
                ),
            )
            if not exhausted:
                connection.execute(
                    "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                    "VALUES (?, 'system', 'verification_retry_scheduled', ?, ?)",
                    (
                        now,
                        f"incident:{incident_id}:generation:{next_generation}",
                        _canonical_json(
                            {
                                "prior_invocation_id": invocation_id,
                                "prior_verification_generation": verification_generation,
                            }
                        ),
                    ),
                )
        if exhausted and self.immediate_escalation is not None:
            self.immediate_escalation("retries_exhausted")
        return True


class RecoverySafetyError(ValueError):
    """A fixed recovery actuator request failed a safety boundary."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class RecoveryMutationUnknown(RuntimeError):
    """Host state may have changed and requires explicit reconciliation."""


def _require_recovery_fence(
    fence_valid: Callable[[], bool], *, mutation_started: bool
) -> None:
    try:
        valid = fence_valid()
    except Exception:
        valid = False
    if valid is True:
        return
    if mutation_started:
        raise RecoveryMutationUnknown("recovery fence was lost during mutation")
    raise RecoverySafetyError("fence_stale")


def _sha256_file_descriptor(
    descriptor: int,
    *,
    byte_limit: int,
    fence_valid: Callable[[], bool] | None = None,
    mutation_started: bool = False,
) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    os.lseek(descriptor, 0, os.SEEK_SET)
    while True:
        if fence_valid is not None:
            _require_recovery_fence(
                fence_valid, mutation_started=mutation_started
            )
        chunk = os.read(descriptor, 128 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > byte_limit:
            raise RecoverySafetyError("item_too_large")
        digest.update(chunk)
    if fence_valid is not None:
        _require_recovery_fence(fence_valid, mutation_started=mutation_started)
    os.lseek(descriptor, 0, os.SEEK_SET)
    return digest.hexdigest(), size


def _write_all(
    descriptor: int,
    data: bytes,
    *,
    fence_valid: Callable[[], bool] | None = None,
    mutation_started: bool = False,
) -> None:
    offset = 0
    while offset < len(data):
        if fence_valid is not None:
            _require_recovery_fence(
                fence_valid, mutation_started=mutation_started
            )
        written = os.write(descriptor, data[offset:])
        if written <= 0:
            raise OSError("short recovery quarantine write")
        offset += written


class RecoveryQuarantine:
    """Owner-only, checksummed quarantine with no automatic purge path."""

    _MANIFEST_KEYS = frozenset(
        {
            "version",
            "quarantineId",
            "incidentId",
            "generation",
            "sourcePath",
            "sourceMode",
            "sourceUid",
            "sourceGid",
            "sizeBytes",
            "contentSha256",
            "quarantinedPath",
            "method",
            "state",
            "createdAt",
            "restoredAt",
            "manifestChecksum",
        }
    )

    def __init__(
        self,
        policy: dict[str, Any],
        *,
        clock: Callable[[], float] = time.time,
        uid: int | None = None,
    ):
        self.root = Path(str(policy["directory"]))
        self.allowed_roots = tuple(Path(str(root)) for root in policy["allowedRoots"])
        self.max_items = int(policy["maxItemsPerIncident"])
        self.max_item_bytes = int(policy["maxItemBytes"])
        self.max_incident_bytes = int(policy["maxIncidentBytes"])
        self.clock = clock
        self.uid = os.getuid() if uid is None else uid

    @staticmethod
    def _safe_identifier(value: Any, name: str) -> str:
        if (
            not isinstance(value, str)
            or safe_field(value, limit=160, default="") != value
        ):
            raise RecoverySafetyError(name)
        return value

    def _private_directory(self, path: Path, *, create: bool) -> Path:
        if create:
            path.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            details = path.lstat()
            canonical = path.resolve(strict=True)
        except OSError as exc:
            raise RecoverySafetyError("quarantine_storage_unavailable") from exc
        if (
            not stat.S_ISDIR(details.st_mode)
            or stat.S_ISLNK(details.st_mode)
            or details.st_uid != self.uid
            or details.st_mode & 0o077
            or canonical != path.absolute()
        ):
            raise RecoverySafetyError("quarantine_storage_unsafe")
        return canonical

    def _incident_directory(self, incident_id: int, *, create: bool = True) -> Path:
        root = self._private_directory(self.root, create=create)
        return self._private_directory(root / f"incident-{incident_id}", create=create)

    def _allowed_root(self, path: Path, *, require_source: bool) -> tuple[Path, Path]:
        if not path.is_absolute() or ".." in path.parts or "\0" in str(path):
            raise RecoverySafetyError("path_invalid")
        candidate = path
        try:
            canonical_candidate = (
                candidate.resolve(strict=True)
                if require_source
                else candidate.parent.resolve(strict=True) / candidate.name
            )
        except OSError as exc:
            raise RecoverySafetyError("path_unavailable") from exc
        for configured_root in self.allowed_roots:
            try:
                root_details = configured_root.lstat()
                canonical_root = configured_root.resolve(strict=True)
                lexical_relative = candidate.absolute().relative_to(
                    configured_root.absolute()
                )
                canonical_candidate.relative_to(canonical_root)
            except (OSError, ValueError):
                continue
            if (
                not stat.S_ISDIR(root_details.st_mode)
                or stat.S_ISLNK(root_details.st_mode)
                or root_details.st_uid != self.uid
                or root_details.st_mode & 0o022
                or canonical_root != configured_root.absolute()
            ):
                continue
            current = configured_root.absolute()
            components = (
                lexical_relative.parts
                if require_source
                else lexical_relative.parts[:-1]
            )
            try:
                for index, component in enumerate(components):
                    current = current / component
                    details = current.lstat()
                    if stat.S_ISLNK(details.st_mode):
                        raise RecoverySafetyError("symlink_rejected")
                    if (
                        (not require_source or index < len(components) - 1)
                        and (
                            not stat.S_ISDIR(details.st_mode)
                            or details.st_uid != self.uid
                            or details.st_mode & 0o022
                        )
                    ):
                        raise RecoverySafetyError("path_component_unsafe")
            except OSError as exc:
                raise RecoverySafetyError("path_unavailable") from exc
            return canonical_root, canonical_candidate
        raise RecoverySafetyError("path_outside_allowed_roots")

    @staticmethod
    def _manifest_checksum(value: dict[str, Any]) -> str:
        unsigned = {key: item for key, item in value.items() if key != "manifestChecksum"}
        return hashlib.sha256(_canonical_json(unsigned).encode("ascii")).hexdigest()

    def _write_manifest(self, path: Path, value: dict[str, Any]) -> None:
        document = dict(value)
        document["manifestChecksum"] = self._manifest_checksum(document)
        _atomic_json(path, document)
        details = path.lstat()
        if (
            not stat.S_ISREG(details.st_mode)
            or stat.S_ISLNK(details.st_mode)
            or details.st_uid != self.uid
            or details.st_mode & 0o077
        ):
            raise RecoveryMutationUnknown("quarantine manifest mode is unknown")

    def _load_manifest(self, path: Path) -> dict[str, Any]:
        try:
            details = path.lstat()
            raw = path.read_bytes()
            document = json.loads(raw)
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise RecoverySafetyError("manifest_unreadable") from exc
        if (
            not stat.S_ISREG(details.st_mode)
            or stat.S_ISLNK(details.st_mode)
            or details.st_uid != self.uid
            or details.st_mode & 0o077
            or len(raw) > 64 * 1024
            or not isinstance(document, dict)
            or set(document) != self._MANIFEST_KEYS
            or document.get("version") != 1
            or document.get("state") not in {"pending", "quarantined", "restored"}
            or document.get("method") not in {"rename", "copy_verify"}
            or not isinstance(document.get("quarantineId"), str)
            or re.fullmatch(r"[a-f0-9]{40}", str(document.get("quarantineId"))) is None
            or isinstance(document.get("incidentId"), bool)
            or not isinstance(document.get("incidentId"), int)
            or int(document["incidentId"]) < 1
            or isinstance(document.get("generation"), bool)
            or not isinstance(document.get("generation"), int)
            or int(document["generation"]) < 1
            or not isinstance(document.get("sourcePath"), str)
            or not Path(str(document["sourcePath"])).is_absolute()
            or not isinstance(document.get("quarantinedPath"), str)
            or not Path(str(document["quarantinedPath"])).is_absolute()
            or isinstance(document.get("sourceMode"), bool)
            or not isinstance(document.get("sourceMode"), int)
            or not 0 <= int(document["sourceMode"]) <= 0o777
            or any(
                isinstance(document.get(key), bool)
                or not isinstance(document.get(key), int)
                or int(document[key]) < 0
                for key in ("sourceUid", "sourceGid", "sizeBytes")
            )
            or int(document["sourceUid"]) != self.uid
            or int(document["sizeBytes"]) > self.max_item_bytes
            or not isinstance(document.get("contentSha256"), str)
            or _TRANSITION_ID.fullmatch(str(document["contentSha256"])) is None
            or isinstance(document.get("createdAt"), bool)
            or not isinstance(document.get("createdAt"), (int, float))
            or not math.isfinite(float(document["createdAt"]))
            or (
                document.get("restoredAt") is not None
                and (
                    isinstance(document.get("restoredAt"), bool)
                    or not isinstance(document.get("restoredAt"), (int, float))
                    or not math.isfinite(float(document["restoredAt"]))
                )
            )
            or (document.get("state") == "restored") != (document.get("restoredAt") is not None)
            or not isinstance(document.get("manifestChecksum"), str)
            or not hmac.compare_digest(
                str(document["manifestChecksum"]), self._manifest_checksum(document)
            )
        ):
            raise RecoverySafetyError("manifest_invalid")
        return document

    def _manifests(self, incident_id: int) -> list[dict[str, Any]]:
        directory = self._incident_directory(incident_id)
        manifests: list[dict[str, Any]] = []
        try:
            paths = sorted(directory.glob("*.json"))
        except OSError as exc:
            raise RecoverySafetyError("quarantine_storage_unavailable") from exc
        for path in paths:
            manifests.append(self._load_manifest(path))
        return manifests

    def request_description(
        self,
        fence: InvocationFence,
        *,
        idempotency_key: str,
        source_path: str,
    ) -> tuple[str, dict[str, Any]]:
        idempotency = self._safe_identifier(idempotency_key, "idempotency_key_invalid")
        if not isinstance(source_path, str) or len(source_path.encode("utf-8")) > 4_096:
            raise RecoverySafetyError("path_invalid")
        quarantine_id = hashlib.sha256(
            f"{fence.incident_id}\0{fence.generation}\0{idempotency}".encode("utf-8")
        ).hexdigest()[:40]
        return quarantine_id, {
            "kind": "quarantine",
            "quarantineId": quarantine_id,
            "sourcePathSha256": hashlib.sha256(source_path.encode("utf-8")).hexdigest(),
        }

    def quarantine(
        self,
        fence: InvocationFence,
        *,
        quarantine_id: str,
        source_path: str,
        fence_valid: Callable[[], bool],
    ) -> dict[str, Any]:
        _require_recovery_fence(fence_valid, mutation_started=False)
        incident_directory = self._incident_directory(fence.incident_id)
        manifest_path = incident_directory / f"{quarantine_id}.json"
        destination = incident_directory / f"{quarantine_id}.item"
        if manifest_path.exists():
            existing = self._load_manifest(manifest_path)
            if (
                existing["quarantineId"] != quarantine_id
                or existing["incidentId"] != fence.incident_id
                or existing["generation"] != fence.generation
                or existing["sourcePath"] != source_path
            ):
                raise RecoverySafetyError("idempotency_key_reused")
            if existing["state"] != "quarantined":
                raise RecoveryMutationUnknown("quarantine request needs reconciliation")
            return {
                "ok": True,
                "quarantineId": quarantine_id,
                "contentSha256": existing["contentSha256"],
                "sizeBytes": existing["sizeBytes"],
                "method": existing["method"],
                "replayed": True,
            }
        manifests = self._manifests(fence.incident_id)
        if len(manifests) >= self.max_items:
            raise RecoverySafetyError("incident_item_limit")
        used_bytes = sum(
            int(item["sizeBytes"])
            for item in manifests
            if isinstance(item.get("sizeBytes"), int)
        )
        _root, source = self._allowed_root(Path(source_path), require_source=True)
        try:
            source_details = source.lstat()
        except OSError as exc:
            raise RecoverySafetyError("path_unavailable") from exc
        if (
            not stat.S_ISREG(source_details.st_mode)
            or stat.S_ISLNK(source_details.st_mode)
            or source_details.st_uid != self.uid
            or source_details.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX | 0o022)
        ):
            raise RecoverySafetyError("source_unsafe")
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(source, flags)
        mutated = False
        manifest_written = False
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (source_details.st_dev, source_details.st_ino):
                raise RecoverySafetyError("source_changed")
            content_sha256, size = _sha256_file_descriptor(
                descriptor,
                byte_limit=self.max_item_bytes,
                fence_valid=fence_valid,
            )
            if used_bytes + size > self.max_incident_bytes:
                raise RecoverySafetyError("incident_byte_limit")
            method = (
                "rename"
                if source_details.st_dev == incident_directory.stat().st_dev
                else "copy_verify"
            )
            manifest = {
                "version": 1,
                "quarantineId": quarantine_id,
                "incidentId": fence.incident_id,
                "generation": fence.generation,
                "sourcePath": str(source),
                "sourceMode": stat.S_IMODE(source_details.st_mode),
                "sourceUid": source_details.st_uid,
                "sourceGid": source_details.st_gid,
                "sizeBytes": size,
                "contentSha256": content_sha256,
                "quarantinedPath": str(destination),
                "method": method,
                "state": "pending",
                "createdAt": self.clock(),
                "restoredAt": None,
            }
            _require_recovery_fence(fence_valid, mutation_started=False)
            self._write_manifest(manifest_path, manifest)
            manifest_written = True
            current = source.lstat()
            if (current.st_dev, current.st_ino) != (opened.st_dev, opened.st_ino):
                raise RecoverySafetyError("source_changed")
            staged = source.parent / f".{source.name}.minime-quarantine-{quarantine_id}"
            if staged.exists() or staged.is_symlink():
                raise RecoverySafetyError("quarantine_staging_exists")
            _require_recovery_fence(
                fence_valid, mutation_started=manifest_written
            )
            os.rename(source, staged)
            mutated = True
            _require_recovery_fence(fence_valid, mutation_started=True)
            staged_details = staged.lstat()
            if (staged_details.st_dev, staged_details.st_ino) != (
                opened.st_dev,
                opened.st_ino,
            ):
                raise RecoveryMutationUnknown("quarantine source changed during move")
            if method == "rename":
                _require_recovery_fence(fence_valid, mutation_started=True)
                os.rename(staged, destination)
                _require_recovery_fence(fence_valid, mutation_started=True)
                os.chmod(destination, 0o600)
            else:
                _require_recovery_fence(fence_valid, mutation_started=True)
                output = os.open(
                    destination,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                    0o600,
                )
                try:
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    while True:
                        _require_recovery_fence(fence_valid, mutation_started=True)
                        chunk = os.read(descriptor, 128 * 1024)
                        if not chunk:
                            break
                        _write_all(
                            output,
                            chunk,
                            fence_valid=fence_valid,
                            mutation_started=True,
                        )
                    _require_recovery_fence(fence_valid, mutation_started=True)
                    os.fsync(output)
                    copied_descriptor = os.open(destination, flags)
                    try:
                        copied_hash, copied_size = _sha256_file_descriptor(
                            copied_descriptor,
                            byte_limit=self.max_item_bytes,
                            fence_valid=fence_valid,
                            mutation_started=True,
                        )
                    finally:
                        os.close(copied_descriptor)
                    if copied_hash != content_sha256 or copied_size != size:
                        raise RecoverySafetyError("copy_verification_failed")
                finally:
                    os.close(output)
                _require_recovery_fence(fence_valid, mutation_started=True)
                os.unlink(staged)
            _require_recovery_fence(fence_valid, mutation_started=True)
            _fsync_directory(source.parent)
            _fsync_directory(incident_directory)
            manifest["state"] = "quarantined"
            _require_recovery_fence(fence_valid, mutation_started=True)
            self._write_manifest(manifest_path, manifest)
            return {
                "ok": True,
                "quarantineId": quarantine_id,
                "contentSha256": content_sha256,
                "sizeBytes": size,
                "method": method,
                "replayed": False,
            }
        except RecoverySafetyError:
            if mutated:
                raise RecoveryMutationUnknown("quarantine state is unknown") from None
            if manifest_written:
                try:
                    manifest_path.unlink()
                except FileNotFoundError:
                    pass
            raise
        except OSError as exc:
            if mutated:
                raise RecoveryMutationUnknown("quarantine state is unknown") from exc
            if manifest_written:
                try:
                    manifest_path.unlink()
                except FileNotFoundError:
                    pass
            if exc.errno == errno.EXDEV:
                raise RecoverySafetyError("copy_fallback_unavailable") from exc
            raise RecoverySafetyError("quarantine_failed") from exc
        finally:
            os.close(descriptor)

    def restore(
        self,
        fence: InvocationFence,
        *,
        quarantine_id: str,
        fence_valid: Callable[[], bool],
    ) -> dict[str, Any]:
        _require_recovery_fence(fence_valid, mutation_started=False)
        identifier = self._safe_identifier(quarantine_id, "quarantine_id_invalid")
        incident_directory = self._incident_directory(fence.incident_id)
        manifest_path = incident_directory / f"{identifier}.json"
        manifest = self._load_manifest(manifest_path)
        if (
            manifest["quarantineId"] != identifier
            or manifest["incidentId"] != fence.incident_id
        ):
            raise RecoverySafetyError("manifest_invalid")
        if manifest["state"] == "restored":
            return {"ok": True, "quarantineId": identifier, "replayed": True}
        if manifest["state"] != "quarantined":
            raise RecoveryMutationUnknown("restore request needs reconciliation")
        source = Path(str(manifest["sourcePath"]))
        _root, canonical_source = self._allowed_root(source, require_source=False)
        if canonical_source.exists() or canonical_source.is_symlink():
            raise RecoverySafetyError("restore_target_exists")
        quarantined = Path(str(manifest["quarantinedPath"]))
        try:
            quarantined.relative_to(incident_directory)
            if quarantined != incident_directory / f"{identifier}.item":
                raise ValueError
            details = quarantined.lstat()
        except (OSError, ValueError) as exc:
            raise RecoverySafetyError("quarantined_item_unavailable") from exc
        if (
            not stat.S_ISREG(details.st_mode)
            or stat.S_ISLNK(details.st_mode)
            or details.st_uid != self.uid
            or details.st_mode & 0o077
        ):
            raise RecoverySafetyError("quarantined_item_unsafe")
        descriptor = os.open(quarantined, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        mutated = False
        target_created = False
        try:
            digest, size = _sha256_file_descriptor(
                descriptor,
                byte_limit=self.max_item_bytes,
                fence_valid=fence_valid,
            )
            if (
                digest != manifest["contentSha256"]
                or size != manifest["sizeBytes"]
            ):
                raise RecoverySafetyError("quarantined_item_checksum_mismatch")
            if details.st_dev == canonical_source.parent.stat().st_dev:
                _require_recovery_fence(fence_valid, mutation_started=False)
                os.link(quarantined, canonical_source, follow_symlinks=False)
                target_created = True
                _require_recovery_fence(fence_valid, mutation_started=True)
                linked_details = canonical_source.lstat()
                if (linked_details.st_dev, linked_details.st_ino) != (
                    details.st_dev,
                    details.st_ino,
                ):
                    raise RecoverySafetyError("restore_target_changed")
                _require_recovery_fence(fence_valid, mutation_started=True)
                os.unlink(quarantined)
                mutated = True
            else:
                _require_recovery_fence(fence_valid, mutation_started=False)
                output = os.open(
                    canonical_source,
                    os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
                    int(manifest["sourceMode"]),
                )
                target_created = True
                try:
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    while True:
                        _require_recovery_fence(fence_valid, mutation_started=True)
                        chunk = os.read(descriptor, 128 * 1024)
                        if not chunk:
                            break
                        _write_all(
                            output,
                            chunk,
                            fence_valid=fence_valid,
                            mutation_started=True,
                        )
                    _require_recovery_fence(fence_valid, mutation_started=True)
                    os.fsync(output)
                finally:
                    os.close(output)
                restored_descriptor = os.open(
                    canonical_source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                )
                try:
                        restored_hash, restored_size = _sha256_file_descriptor(
                            restored_descriptor,
                            byte_limit=self.max_item_bytes,
                            fence_valid=fence_valid,
                            mutation_started=True,
                        )
                finally:
                    os.close(restored_descriptor)
                if restored_hash != digest or restored_size != size:
                    raise RecoveryMutationUnknown("restore copy verification is unknown")
                _require_recovery_fence(fence_valid, mutation_started=True)
                os.unlink(quarantined)
                mutated = True
            _require_recovery_fence(fence_valid, mutation_started=True)
            os.chmod(canonical_source, int(manifest["sourceMode"]))
            _fsync_directory(canonical_source.parent)
            _fsync_directory(incident_directory)
            manifest["state"] = "restored"
            manifest["restoredAt"] = self.clock()
            _require_recovery_fence(fence_valid, mutation_started=True)
            self._write_manifest(manifest_path, manifest)
            return {"ok": True, "quarantineId": identifier, "replayed": False}
        except RecoverySafetyError:
            if mutated or target_created:
                raise RecoveryMutationUnknown("restore state is unknown") from None
            raise
        except OSError as exc:
            if mutated or target_created:
                raise RecoveryMutationUnknown("restore state is unknown") from exc
            raise RecoverySafetyError("restore_failed") from exc
        finally:
            os.close(descriptor)


class ReviewedOperationExecutor:
    """Run only immutable, configuration-reviewed argv selected by operation ID."""

    def __init__(
        self,
        operations: tuple[dict[str, Any], ...],
        *,
        active_bot_release: Callable[[], str | None] | None = None,
    ):
        normalized: list[dict[str, Any]] = []
        for item in operations:
            if "executableSha256" in item:
                pinned = dict(item)
                if not reviewed_operation_executable_matches(pinned):
                    raise ValueError("recovery reviewed operation executable changed")
            else:
                pinned = validated_reviewed_operation(
                    {
                        key: item[key]
                        for key in ("id", "kind", "executable", "argv", "timeoutSeconds")
                    }
                )
            normalized.append(pinned)
        self.operations = {str(item["id"]): item for item in normalized}
        if len(self.operations) != len(operations):
            raise ValueError("recovery reviewed operation IDs overlap")
        self.active_bot_release = active_bot_release

    def description(self, operation_id: Any) -> dict[str, Any]:
        if not isinstance(operation_id, str) or safe_field(operation_id, default="") != operation_id:
            raise RecoverySafetyError("operation_id_invalid")
        operation = self.operations.get(operation_id)
        if operation is None:
            raise RecoverySafetyError("operation_not_reviewed")
        return {
            "kind": str(operation["kind"]),
            "operationId": operation_id,
        }

    def execute(
        self, operation_id: str, *, fence_valid: Callable[[], bool]
    ) -> dict[str, Any]:
        operation = self.operations[operation_id]
        if not reviewed_operation_executable_matches(operation):
            return {
                "ok": False,
                "operationId": operation_id,
                "kind": operation["kind"],
                "code": "executable_changed",
            }
        previous_release = (
            None if self.active_bot_release is None else self.active_bot_release()
        )
        process: subprocess.Popen[bytes] | None = None
        try:
            if not fence_valid():
                result = {
                    "ok": False,
                    "operationId": operation_id,
                    "kind": operation["kind"],
                    "code": "fence_lost",
                }
                return result
            process = subprocess.Popen(
                [str(operation["executable"]), *map(str, operation["argv"])],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                cwd="/",
                env={
                    "LANG": "C",
                    "LC_ALL": "C",
                    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
                },
                close_fds=True,
                shell=False,
                start_new_session=True,
            )
            deadline = time.monotonic() + int(operation["timeoutSeconds"])
            code = "completed"
            while process.poll() is None:
                if not fence_valid():
                    code = "fence_lost"
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    code = "timeout"
                    break
                time.sleep(min(0.1, remaining))
            if code != "completed":
                PythonProbeRunner._terminate_process_group(process)
                result = {
                    "ok": False,
                    "operationId": operation_id,
                    "kind": operation["kind"],
                    "code": code,
                }
            else:
                return_code = int(process.returncode or 0)
                # A reviewed wrapper may have left descendants behind. The
                # isolated group never survives the direct child.
                PythonProbeRunner._terminate_process_group(process)
                result = {
                    "ok": return_code == 0,
                    "operationId": operation_id,
                    "kind": operation["kind"],
                    "code": "completed" if return_code == 0 else "nonzero_exit",
                    "exitCode": return_code,
                }
        except OSError:
            if process is not None:
                PythonProbeRunner._terminate_process_group(process)
            result = {
                "ok": False,
                "operationId": operation_id,
                "kind": operation["kind"],
                "code": "execution_failed",
            }
        if operation["kind"] == "rollback" and self.active_bot_release is not None:
            result["previousRelease"] = previous_release
            result["activeRelease"] = self.active_bot_release()
        return result


class RecoveryActuator:
    """Journal and execute the small supervisor-owned mutation surface."""

    def __init__(
        self,
        coordinator: IncidentCoordinator,
        quarantine: RecoveryQuarantine,
        operations: ReviewedOperationExecutor,
    ):
        self.coordinator = coordinator
        self.quarantine = quarantine
        self.operations = operations
        self._lock = threading.Lock()

    def _run(
        self,
        fence: InvocationFence,
        *,
        action_key: str,
        tool_name: str,
        intent: dict[str, Any],
        execute: Callable[[], dict[str, Any]],
    ) -> tuple[int, dict[str, Any]]:
        with self._lock:
            status = self.coordinator.action_status(fence, action_key)
            if status is not None:
                state, recorded_tool, recorded_intent, outcome, details = status
                if recorded_tool != tool_name or recorded_intent != intent:
                    return 409, {"ok": False, "code": "idempotency_key_reused"}
                if state == "completed" and outcome is not None and details is not None:
                    return (
                        200 if outcome == "succeeded" else 422,
                        {**details, "ok": outcome == "succeeded", "replayed": True},
                    )
                return 409, {"ok": False, "code": "action_unresolved"}
            action_id = self.coordinator.record_action_intent(
                fence,
                action_key=action_key,
                tool_name=tool_name,
                intent=intent,
            )
            if action_id is None:
                return 409, {"ok": False, "code": "intent_rejected"}
            try:
                details = execute()
            except RecoveryMutationUnknown:
                if not self.coordinator.mark_action_unknown(
                    fence, action_key=action_key
                ):
                    return 409, {"ok": False, "code": "outcome_uncommitted"}
                return 409, {"ok": False, "code": "action_unknown"}
            except RecoverySafetyError as exc:
                details = {"ok": False, "code": exc.code}
            outcome = "succeeded" if details.get("ok") is True else "failed"
            if not self.coordinator.record_action_outcome(
                fence,
                action_key=action_key,
                outcome=outcome,
                details=details,
            ):
                if self.coordinator.mark_action_unknown(
                    fence, action_key=action_key
                ):
                    return 409, {"ok": False, "code": "action_unknown"}
                return 409, {"ok": False, "code": "outcome_uncommitted"}
            return (200 if outcome == "succeeded" else 422), details

    @staticmethod
    def _action_key(kind: str, idempotency_key: Any) -> str:
        if (
            not isinstance(idempotency_key, str)
            or safe_field(idempotency_key, limit=120, default="") != idempotency_key
        ):
            raise RecoverySafetyError("idempotency_key_invalid")
        return f"supervisor:{kind}:{idempotency_key}"

    def quarantine_file(
        self,
        fence: InvocationFence,
        *,
        idempotency_key: Any,
        source_path: Any,
    ) -> tuple[int, dict[str, Any]]:
        if not isinstance(source_path, str):
            raise RecoverySafetyError("path_invalid")
        action_key = self._action_key("quarantine", idempotency_key)
        quarantine_id, intent = self.quarantine.request_description(
            fence,
            idempotency_key=str(idempotency_key),
            source_path=source_path,
        )
        return self._run(
            fence,
            action_key=action_key,
            tool_name="recovery_quarantine",
            intent=intent,
            execute=lambda: self.quarantine.quarantine(
                fence,
                quarantine_id=quarantine_id,
                source_path=source_path,
                fence_valid=lambda: self.coordinator.invocation_fence_valid(fence),
            ),
        )

    def restore_file(
        self,
        fence: InvocationFence,
        *,
        idempotency_key: Any,
        quarantine_id: Any,
    ) -> tuple[int, dict[str, Any]]:
        identifier = self.quarantine._safe_identifier(
            quarantine_id, "quarantine_id_invalid"
        )
        action_key = self._action_key("restore", idempotency_key)
        return self._run(
            fence,
            action_key=action_key,
            tool_name="recovery_restore",
            intent={"kind": "restore", "quarantineId": identifier},
            execute=lambda: self.quarantine.restore(
                fence,
                quarantine_id=identifier,
                fence_valid=lambda: self.coordinator.invocation_fence_valid(fence),
            ),
        )

    def reviewed_operation(
        self,
        fence: InvocationFence,
        *,
        idempotency_key: Any,
        operation_id: Any,
    ) -> tuple[int, dict[str, Any]]:
        action_key = self._action_key("operation", idempotency_key)
        intent = self.operations.description(operation_id)
        return self._run(
            fence,
            action_key=action_key,
            tool_name="recovery_operation",
            intent=intent,
            execute=lambda: self.operations.execute(
                str(operation_id),
                fence_valid=lambda: self.coordinator.invocation_fence_valid(fence),
            ),
        )


@dataclass(frozen=True)
class VerificationEvidence:
    kind: str
    identifier: str
    state: str
    observed_at: float | None = None
    fresh_until: float | None = None


@dataclass(frozen=True)
class VerificationResult:
    recovered: bool
    reasons: tuple[str, ...]
    evidence: tuple[VerificationEvidence, ...] = ()


def _is_fresh_contradiction(
    result: VerificationResult, *, now: float | None = None
) -> bool:
    if not isinstance(result, VerificationResult) or not result.evidence:
        return False
    if any(item.state not in {"fresh_healthy", "fresh_unhealthy"} for item in result.evidence):
        return False
    if now is not None and any(
        item.observed_at is None
        or item.fresh_until is None
        or item.observed_at > now
        or now >= item.fresh_until
        for item in result.evidence
    ):
        return False
    contradictions = {
        f"{item.kind}_unhealthy:{item.identifier}"
        for item in result.evidence
        if item.state == "fresh_unhealthy"
    }
    return bool(contradictions) and set(result.reasons) == contradictions


@dataclass(frozen=True)
class VerificationFence:
    incident_id: int
    generation: int
    policy_revision: int


def _current_evidence_matches(
    connection: Any,
    *,
    incident_id: int,
    generation: int,
    policy_revision: int,
    result: VerificationResult,
    now: float,
) -> bool:
    if not _is_fresh_contradiction(result, now=now):
        return False
    fence = VerificationFence(incident_id, generation, policy_revision)
    for item in result.evidence:
        if item.kind == "heartbeat":
            observation = RecoveryVerifier._observation(
                connection, f"verification:heartbeat:{item.identifier}"
            )
        elif item.kind == "probe":
            observation = RecoveryVerifier._probe_observation(
                connection, fence, item.identifier
            )
        elif item.kind == "slot":
            observation = RecoveryVerifier._observation(
                connection, f"verification:slot:{item.identifier}"
            )
        else:
            return False
        if observation != (item.state == "fresh_healthy", item.observed_at):
            return False
    return True


class RecoveryVerifier:
    """Fail-closed deterministic verification backed by durable observations."""

    def __init__(
        self,
        ledger: RecoveryLedger,
        coordinator: IncidentCoordinator,
        *,
        probe_ids: tuple[str, ...] = (),
        source_ids: tuple[str, ...] = (),
        cadence_seconds: float,
        freshness_seconds: float,
        hold_down_seconds: float,
        slot_validator: Callable[[], dict[str, bool]] | None = None,
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
        for value in (cadence_seconds, freshness_seconds, hold_down_seconds):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(value)
                or not 0 <= value <= 86_400
            ):
                raise ValueError("recovery verification timing is invalid")
        if cadence_seconds <= 0 or freshness_seconds <= cadence_seconds * 2:
            raise ValueError("recovery verification timing relationship is invalid")
        self.ledger = ledger
        self.coordinator = coordinator
        self.probe_ids = probe_ids
        self.source_ids = source_ids
        self.cadence_seconds = float(cadence_seconds)
        self.freshness_seconds = float(freshness_seconds)
        self.hold_down_seconds = float(hold_down_seconds)
        self.slot_validator = slot_validator
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
            current = self._observation(connection, key)
            if current is not None:
                current_healthy, current_observed_at = current
                if observed_at < current_observed_at or (
                    observed_at == current_observed_at
                    and not current_healthy
                    and healthy
                ):
                    return
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
    def _probe_set_key(fence: VerificationFence) -> str:
        return (
            f"verification:probe-set:{fence.incident_id}:{fence.generation}:"
            f"{fence.policy_revision}"
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

    @staticmethod
    def _probe_set_observation(
        connection: Any, fence: VerificationFence
    ) -> float | None:
        row = connection.execute(
            "SELECT value FROM metadata WHERE key = ?",
            (RecoveryVerifier._probe_set_key(fence),),
        ).fetchone()
        if row is None:
            return None
        try:
            value = json.loads(str(row["value"]))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise LedgerCorrupt("recovery probe-set observation is invalid") from exc
        if (
            not isinstance(value, dict)
            or set(value)
            != {"completed_at", "generation", "incident_id", "policy_revision"}
            or value["incident_id"] != fence.incident_id
            or value["generation"] != fence.generation
            or value["policy_revision"] != fence.policy_revision
            or isinstance(value["completed_at"], bool)
            or not isinstance(value["completed_at"], (int, float))
            or not math.isfinite(value["completed_at"])
        ):
            raise LedgerCorrupt("recovery probe-set observation is invalid")
        return float(value["completed_at"])

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
        refresh_after = self.cadence_seconds
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
                if not self._fence_valid(connection, fence):
                    continue
                observations = [
                    self._probe_observation(connection, fence, probe_id)
                    for probe_id in self.probe_ids
                ]
                if any(
                    observation is None
                    or observation[1] > now + 1.0
                    or now - observation[1] >= self.freshness_seconds
                    for observation in observations
                ):
                    return fence
                completed_at = self._probe_set_observation(connection, fence)
                if (
                    completed_at is None
                    or completed_at > now + 1.0
                    or now - completed_at >= refresh_after
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
        normalized: dict[str, tuple[bool, float | None]] = {}
        for result in results:
            if not isinstance(result, dict):
                raise ValueError("recovery probe result is invalid")
            probe_id = result.get("id")
            exit_code = result.get("exitCode")
            timed_out = result.get("timedOut")
            result_observed_at = result.get("observedAt")
            if (
                not isinstance(probe_id, str)
                or probe_id not in self.probe_ids
                or probe_id in normalized
                or isinstance(exit_code, bool)
                or not isinstance(exit_code, int)
                or not isinstance(timed_out, bool)
                or (
                    result_observed_at is not None
                    and (
                        isinstance(result_observed_at, bool)
                        or not isinstance(result_observed_at, (int, float))
                        or not math.isfinite(result_observed_at)
                    )
                )
            ):
                raise ValueError("recovery probe result is invalid")
            normalized[probe_id] = (
                exit_code == 0 and not timed_out,
                None if result_observed_at is None else float(result_observed_at),
            )
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
            for probe_id, (healthy, result_timestamp) in normalized.items():
                probe_timestamp = (
                    float(timestamp)
                    if observed_at is not None or result_timestamp is None
                    else result_timestamp
                )
                value = _canonical_json(
                    {
                        "generation": fence.generation,
                        "healthy": healthy,
                        "incident_id": fence.incident_id,
                        "observed_at": probe_timestamp,
                        "policy_revision": fence.policy_revision,
                    }
                )
                connection.execute(
                    "INSERT INTO metadata(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (self._probe_key(fence, probe_id), value),
                )
            if require_all:
                completed = _canonical_json(
                    {
                        "completed_at": float(timestamp),
                        "generation": fence.generation,
                        "incident_id": fence.incident_id,
                        "policy_revision": fence.policy_revision,
                    }
                )
                connection.execute(
                    "INSERT INTO metadata(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (self._probe_set_key(fence), completed),
                )
        return True

    @staticmethod
    def _attempt_documents(
        result: VerificationResult,
    ) -> tuple[str, str]:
        reasons_json = _canonical_json(list(result.reasons))
        evidence_json = _canonical_json(
            [
                {
                    "fresh_until": item.fresh_until,
                    "id": item.identifier,
                    "kind": item.kind,
                    "observed_at": item.observed_at,
                    "state": item.state,
                }
                for item in result.evidence
            ]
        )
        return reasons_json, evidence_json

    def _record_attempt(
        self,
        connection: Any,
        incident: Any,
        result: VerificationResult,
        now: float,
    ) -> None:
        status = (
            "recovered"
            if result.recovered
            else "contradicted"
            if _is_fresh_contradiction(result, now=now)
            else "deferred"
        )
        reasons_json, evidence_json = self._attempt_documents(result)
        previous = connection.execute(
            "SELECT result, reasons_json, evidence_json FROM verification_attempts "
            "WHERE incident_id = ? AND generation = ? ORDER BY attempt DESC LIMIT 1",
            (incident["id"], incident["generation"]),
        ).fetchone()
        if (
            previous is not None
            and previous["result"] == status
            and previous["reasons_json"] == reasons_json
            and previous["evidence_json"] == evidence_json
        ):
            return
        attempt = int(
            connection.execute(
                "SELECT coalesce(max(attempt), 0) + 1 FROM verification_attempts "
                "WHERE incident_id = ? AND generation = ?",
                (incident["id"], incident["generation"]),
            ).fetchone()[0]
        )
        invocation = connection.execute(
            "SELECT id FROM invocations WHERE incident_id = ? AND policy_revision = ? "
            "ORDER BY generation DESC, id DESC LIMIT 1",
            (incident["id"], incident["policy_revision"]),
        ).fetchone()
        connection.execute(
            "INSERT INTO verification_attempts(incident_id, generation, evidence_hash, "
            "policy_revision, invocation_id, attempt, result, reasons_json, evidence_json, "
            "started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                incident["id"],
                incident["generation"],
                incident["evidence_hash"],
                incident["policy_revision"],
                None if invocation is None else invocation["id"],
                attempt,
                status,
                reasons_json,
                evidence_json,
                now,
                now,
            ),
        )

    def evaluate(self, incident_id: int) -> VerificationResult:
        if not isinstance(incident_id, int) or incident_id < 1:
            raise ValueError("recovery verification incident is invalid")
        now = self.clock()
        slot_health: dict[str, bool] = {}
        if self.slot_validator is not None:
            try:
                slot_health = self.slot_validator()
            except Exception:
                slot_health = {"bot": False, "capsule": False}
            if set(slot_health) != {"bot", "capsule"} or any(
                not isinstance(value, bool) for value in slot_health.values()
            ):
                raise ValueError("recovery slot verification result is invalid")
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
            evidence: list[VerificationEvidence] = []
            control = self.coordinator.controls.current(connection, now=now)
            if control.revision != fence.policy_revision:
                reasons.append("policy_stale")
            active = self.coordinator._active_evidence(connection)
            if str(incident["correlation_key"]) in active:
                reasons.append("episodes_firing")
            if incident["state"] != "verifying":
                reasons.append("not_verifying")
            if self.coordinator._unresolved_actions(connection, incident_id):
                reasons.append("actions_unresolved")
            for source in ("supervisor",) + self.source_ids:
                observation = self._observation(
                    connection, f"verification:heartbeat:{source}"
                )
                if observation is None:
                    state = "missing"
                    reasons.append(f"heartbeat_missing:{source}")
                elif observation[1] > now or now - observation[1] >= self.freshness_seconds:
                    state = "stale"
                    reasons.append(f"heartbeat_stale:{source}")
                elif not observation[0]:
                    state = "fresh_unhealthy"
                    reasons.append(f"heartbeat_unhealthy:{source}")
                else:
                    state = "fresh_healthy"
                observed_at = None if observation is None else observation[1]
                evidence.append(
                    VerificationEvidence(
                        "heartbeat",
                        source,
                        state,
                        observed_at,
                        None if observed_at is None else observed_at + self.freshness_seconds,
                    )
                )
            for probe_id in self.probe_ids:
                observation = self._probe_observation(connection, fence, probe_id)
                if observation is None:
                    state = "missing"
                    reasons.append(f"probe_missing:{probe_id}")
                elif observation[1] > now or now - observation[1] >= self.freshness_seconds:
                    state = "stale"
                    reasons.append(f"probe_stale:{probe_id}")
                elif not observation[0]:
                    state = "fresh_unhealthy"
                    reasons.append(f"probe_unhealthy:{probe_id}")
                else:
                    state = "fresh_healthy"
                observed_at = None if observation is None else observation[1]
                evidence.append(
                    VerificationEvidence(
                        "probe",
                        probe_id,
                        state,
                        observed_at,
                        None if observed_at is None else observed_at + self.freshness_seconds,
                    )
                )
            for domain in sorted(slot_health):
                healthy = slot_health[domain]
                state = "fresh_healthy" if healthy else "fresh_unhealthy"
                if not healthy:
                    reasons.append(f"slot_unhealthy:{domain}")
                connection.execute(
                    "INSERT INTO metadata(key, value) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (
                        f"verification:slot:{domain}",
                        _canonical_json({"healthy": healthy, "observed_at": now}),
                    ),
                )
                evidence.append(
                    VerificationEvidence(
                        "slot",
                        domain,
                        state,
                        now,
                        now + self.freshness_seconds,
                    )
                )
            if now - float(incident["updated_at"]) < self.hold_down_seconds:
                reasons.append("hold_down")
            if reasons:
                result = VerificationResult(
                    False,
                    tuple(sorted(set(reasons))),
                    tuple(evidence),
                )
                self._record_attempt(connection, incident, result, now)
                return result
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
            result = VerificationResult(True, (), tuple(evidence))
            self._record_attempt(connection, incident, result, now)
            return result

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
                "SELECT invocations.id, invocations.generation FROM invocations "
                "JOIN fixer_claims ON fixer_claims.invocation_id = invocations.id "
                "WHERE invocations.incident_id = ? AND invocations.state = 'completed' "
                "AND invocations.policy_revision = ? AND invocations.generation >= ? "
                "AND invocations.generation <= ? "
                "ORDER BY invocations.generation DESC, invocations.id DESC LIMIT 1",
                (incident_id, incident["policy_revision"], max(1, generation - 1), generation),
            ).fetchone()
            if invocation is None:
                return None
            if result.recovered:
                return "stable_recovery", f"invocation:{int(invocation['id'])}"
            if not _is_fresh_contradiction(result, now=now):
                return None
            delay = max(self.hold_down_seconds, self.freshness_seconds)
            if now - float(incident["updated_at"]) < delay:
                return None
            return (
                "missed_recovery",
                f"invocation:{int(invocation['id'])}:verification:{generation}",
            )


@dataclass(frozen=True)
class ProbeCommand:
    """Immutable execution form of one validated static probe definition."""

    identifier: str
    executable: str
    argv: tuple[str, ...]
    env: tuple[tuple[str, str], ...]
    timeout_seconds: float

    @classmethod
    def from_config(cls, value: dict[str, Any]) -> ProbeCommand:
        normalized = validated_probe_command(value)
        return cls(
            identifier=str(normalized["id"]),
            executable=str(normalized["executable"]),
            argv=tuple(str(arg) for arg in normalized["argv"]),
            env=tuple(
                sorted(
                    (str(key), str(item))
                    for key, item in normalized["env"].items()
                )
            ),
            timeout_seconds=int(normalized["timeoutMs"]) / 1_000.0,
        )


class PythonProbeRunner:
    """Run reviewed verification commands without Node, a shell, or inherited state."""

    def __init__(
        self,
        verifier: RecoveryVerifier,
        probes: tuple[dict[str, Any], ...],
        *,
        monotonic: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ):
        commands = tuple(ProbeCommand.from_config(probe) for probe in probes)
        timeout_budget_ms = sum(
            int(round(command.timeout_seconds * 1_000)) for command in commands
        )
        if timeout_budget_ms > min(
            MAX_PROBE_TOTAL_TIMEOUT_MS,
            int(verifier.cadence_seconds * 1_000),
        ):
            raise ValueError("recovery probe runner timeout budget is invalid")
        if tuple(command.identifier for command in commands) != verifier.probe_ids:
            raise ValueError("recovery probe runner definitions do not match verifier")
        self.verifier = verifier
        self.commands = commands
        self.monotonic = monotonic
        self.sleeper = sleeper
        self.maintenance_budget_seconds = min(
            MAX_PROBE_TOTAL_TIMEOUT_MS / 1_000.0,
            verifier.cadence_seconds,
        )

    @staticmethod
    def _resolved_executable(command: ProbeCommand) -> str | None:
        """Resolve and revalidate the exact native executable immediately before launch."""

        try:
            resolved = Path(command.executable).resolve(strict=True)
            details = resolved.stat()
            if not stat.S_ISREG(details.st_mode) or not os.access(resolved, os.X_OK):
                return None
            with resolved.open("rb") as executable:
                if executable.read(2) == b"#!":
                    return None
            validated_probe_command(
                {
                    "id": command.identifier,
                    "executable": str(resolved),
                    "argv": list(command.argv),
                    "env": dict(command.env),
                    "timeoutMs": int(command.timeout_seconds * 1_000),
                }
            )
            return str(resolved)
        except (OSError, RecoveryConfigError):
            return None

    @staticmethod
    def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
        """Terminate every process left in the probe's isolated process group."""

        if process.poll() is not None:
            # A probe is not allowed to leave descendants behind after its
            # direct child exits. Any remaining member still has the child's
            # process-group ID because start_new_session created the group.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            try:
                process.terminate()
            except OSError:
                pass
        try:
            process.wait(timeout=PROBE_TERMINATION_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            try:
                process.kill()
            except OSError:
                pass
        try:
            process.wait(timeout=PROBE_TERMINATION_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            # The process is already signalled. Never turn cleanup delay into
            # unbounded maintenance work if the kernel has not reaped it yet.
            pass

    def _run_command(
        self,
        fence: VerificationFence,
        command: ProbeCommand,
        *,
        maintenance_deadline: float,
    ) -> dict[str, Any] | None:
        if not self.verifier.fence_valid(fence):
            return None
        if self.monotonic() >= maintenance_deadline:
            return {
                "id": command.identifier,
                "exitCode": -1,
                "timedOut": True,
                "observedAt": self.verifier.clock(),
            }
        executable = self._resolved_executable(command)
        if executable is None:
            if not self.verifier.fence_valid(fence):
                return None
            return {
                "id": command.identifier,
                "exitCode": 126,
                "timedOut": False,
                "observedAt": self.verifier.clock(),
            }
        if not self.verifier.fence_valid(fence):
            return None
        # stdout/stderr are deliberately discarded. The retained output bound
        # is therefore zero bytes and an unbounded writer cannot fill a pipe or
        # consume supervisor memory. The absolute executable, static argv/env,
        # root cwd, closed descriptors, and shell=False keep execution detached
        # from Node, Pi, the active package checkout, and ambient credentials.
        try:
            process = subprocess.Popen(
                (executable, *command.argv),
                executable=executable,
                cwd="/",
                env=dict(command.env),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                shell=False,
                start_new_session=True,
            )
        except OSError:
            if not self.verifier.fence_valid(fence):
                return None
            return {
                "id": command.identifier,
                "exitCode": 127,
                "timedOut": False,
                "observedAt": self.verifier.clock(),
            }

        deadline = min(
            self.monotonic() + command.timeout_seconds,
            maintenance_deadline,
        )
        timed_out = False
        stale = False
        try:
            while process.poll() is None:
                if not self.verifier.fence_valid(fence):
                    stale = True
                    break
                remaining = deadline - self.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                self.sleeper(min(PROBE_FENCE_POLL_SECONDS, remaining))
        finally:
            self._terminate_process_group(process)
        if stale or not self.verifier.fence_valid(fence):
            return None
        return {
            "id": command.identifier,
            "exitCode": int(
                process.returncode if process.returncode is not None else -1
            ),
            "timedOut": timed_out,
            "observedAt": self.verifier.clock(),
        }

    def refresh(self, fence: VerificationFence) -> bool:
        """Execute and atomically record one fully fenced probe set."""

        if not self.commands or not self.verifier.fence_valid(fence):
            return False
        results: list[dict[str, Any]] = []
        maintenance_deadline = self.monotonic() + self.maintenance_budget_seconds
        for command in self.commands:
            result = self._run_command(
                fence,
                command,
                maintenance_deadline=maintenance_deadline,
            )
            if result is None:
                return False
            results.append(result)
        if not self.verifier.fence_valid(fence):
            return False
        return self.verifier.record_probe_results(fence, results)

    def refresh_due(
        self, *, limit: int = MAX_PROBE_REFRESHES_PER_MAINTENANCE
    ) -> int:
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or limit != MAX_PROBE_REFRESHES_PER_MAINTENANCE
        ):
            raise ValueError("recovery probe refresh limit is invalid")
        fence = self.verifier.next_probe_refresh()
        if fence is None:
            return 0
        return 1 if self.refresh(fence) else 0


class RecoveryFixerProcessManager:
    """Own at most one recovery runner process behind the coordinator lease."""

    def __init__(
        self,
        coordinator: IncidentCoordinator,
        *,
        runner_argv: tuple[str, str] | None,
        package_root: Path,
        control_workspace: Path,
        endpoint: str,
        fixer_credential_file: Path,
        agent_id: str,
        session_root: Path,
        startup_timeout_seconds: int,
        resume_timeout_seconds: int,
        renew_seconds: int,
        run_timeout_seconds: int,
        pi_executable: Path,
        preimage_directory: Path,
        preimage_max_bytes: int,
        inherited_env: dict[str, str] | None = None,
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
        monotonic: Callable[[], float] = time.monotonic,
    ):
        if runner_argv is not None and (
            len(runner_argv) != 2
            or any(not Path(value).is_absolute() or "\0" in value for value in runner_argv)
        ):
            raise ValueError("recovery fixer runner command is invalid")
        for value, name in (
            (endpoint, "endpoint"),
            (agent_id, "agent id"),
        ):
            if not isinstance(value, str) or safe_field(value, limit=512, default="") != value:
                raise ValueError(f"recovery fixer runner {name} is invalid")
        for value in (
            startup_timeout_seconds,
            resume_timeout_seconds,
            renew_seconds,
            run_timeout_seconds,
        ):
            if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 86_400:
                raise ValueError("recovery fixer runner timeout is invalid")
        self.coordinator = coordinator
        self.runner_argv = runner_argv
        self.package_root = package_root.resolve()
        self.control_workspace = control_workspace.resolve()
        self.endpoint = endpoint
        self.fixer_credential_file = fixer_credential_file.resolve()
        self.agent_id = agent_id
        self.session_root = session_root.resolve()
        self.startup_timeout_seconds = startup_timeout_seconds
        self.resume_timeout_seconds = resume_timeout_seconds
        self.renew_seconds = renew_seconds
        self.run_timeout_seconds = run_timeout_seconds
        self.pi_executable = pi_executable.resolve()
        self.preimage_directory = preimage_directory.resolve()
        if (
            isinstance(preimage_max_bytes, bool)
            or not isinstance(preimage_max_bytes, int)
            or not 0 <= preimage_max_bytes <= 16 * 1024 * 1024
        ):
            raise ValueError("recovery fixer preimage bound is invalid")
        self.preimage_max_bytes = preimage_max_bytes
        source_env = dict(os.environ) if inherited_env is None else inherited_env
        self.base_env = {
            key: value
            for key, value in source_env.items()
            if isinstance(value, str)
            and (key in _FIXER_RUNNER_ENV_KEYS or key.startswith("LC_"))
        }
        # Only the two unambiguous workspace roots are retained. Historical
        # aliases are deliberately neither accepted nor synthesized here.
        self.base_env.pop("MINIME_WORKSPACE_ROOT", None)
        self.base_env.pop("MINIME_AGENT_WORKSPACE_CWD", None)
        self.base_env["MINIME_CONTROL_WORKSPACE_ROOT"] = str(self.control_workspace)
        self.base_env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        self.popen = popen
        self.monotonic = monotonic
        self.process: subprocess.Popen[bytes] | None = None
        self.fence: InvocationFence | None = None
        self.deadline: float | None = None
        self.next_renewal: float | None = None

    @property
    def active(self) -> bool:
        return self.process is not None and self.process.poll() is None

    def _environment(self, fence: InvocationFence) -> dict[str, str]:
        return {
            **self.base_env,
            "MINIME_RECOVERY_ENDPOINT": self.endpoint,
            "MINIME_RECOVERY_FIXER_CREDENTIAL_FILE": str(
                self.fixer_credential_file
            ),
            "MINIME_RECOVERY_MODE": self.coordinator.mode,
            "MINIME_RECOVERY_INVOCATION_ID": str(fence.invocation_id),
            "MINIME_RECOVERY_INCIDENT_ID": str(fence.incident_id),
            "MINIME_RECOVERY_GENERATION": str(fence.generation),
            "MINIME_RECOVERY_EVIDENCE_HASH": fence.evidence_hash,
            "MINIME_RECOVERY_POLICY_REVISION": str(fence.policy_revision),
            "MINIME_RECOVERY_LEASE_TOKEN": fence.lease_token,
            "MINIME_RECOVERY_AGENT_ID": self.agent_id,
            "MINIME_RECOVERY_SESSION_ROOT": str(self.session_root),
            "MINIME_RECOVERY_STARTUP_TIMEOUT_SECONDS": str(
                self.startup_timeout_seconds
            ),
            "MINIME_RECOVERY_RESUME_TIMEOUT_SECONDS": str(
                self.resume_timeout_seconds
            ),
            "MINIME_RECOVERY_RENEW_SECONDS": str(self.renew_seconds),
            "MINIME_RECOVERY_RUN_TIMEOUT_SECONDS": str(self.run_timeout_seconds),
            "MINIME_RECOVERY_PI_EXECUTABLE": str(self.pi_executable),
            "MINIME_RECOVERY_PREIMAGE_DIRECTORY": str(self.preimage_directory),
            "MINIME_RECOVERY_PREIMAGE_MAX_BYTES": str(self.preimage_max_bytes),
            "MINIME_RECOVERY_SUPERVISOR_PROCESS_GROUP": "1",
        }

    def _spawn(self, fence: InvocationFence) -> bool:
        if self.runner_argv is None:
            self.coordinator.interrupt_invocation(
                fence, reason="runner_unavailable"
            )
            return False
        try:
            self.process = self.popen(
                self.runner_argv,
                executable=self.runner_argv[0],
                cwd=str(self.package_root),
                env=self._environment(fence),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                shell=False,
                start_new_session=True,
            )
        except OSError:
            self.coordinator.interrupt_invocation(fence, reason="spawn_failed")
            self.process = None
            return False
        self.fence = fence
        started = self.monotonic()
        self.deadline = started + self.run_timeout_seconds
        self.next_renewal = started + self.renew_seconds
        return True

    def tick(self) -> str:
        """Poll the active runner, then claim at most one fenced invocation."""

        if self.process is not None:
            if self.process.poll() is None:
                fence = self.fence
                now = self.monotonic()
                timed_out = self.deadline is not None and now >= self.deadline
                fence_lost = fence is None or not self.coordinator.invocation_fence_valid(fence)
                if (
                    not timed_out
                    and not fence_lost
                    and self.next_renewal is not None
                    and now >= self.next_renewal
                ):
                    fence_lost = fence is None or not self.coordinator.renew_lease(fence)
                    if not fence_lost:
                        self.next_renewal = now + self.renew_seconds
                if not timed_out and not fence_lost:
                    return "running"
                process = self.process
                self.process = None
                self.fence = None
                self.deadline = None
                self.next_renewal = None
                PythonProbeRunner._terminate_process_group(process)
                if fence is not None:
                    self.coordinator.interrupt_invocation(
                        fence,
                        reason="runner_timeout" if timed_out else "fence_lost",
                    )
                return "timed_out" if timed_out else "fence_lost"
            PythonProbeRunner._terminate_process_group(self.process)
            fence = self.fence
            return_code = int(self.process.returncode or 0)
            self.process = None
            self.fence = None
            self.deadline = None
            self.next_renewal = None
            if fence is not None:
                self.coordinator.interrupt_invocation(
                    fence,
                    reason="runner_exited" if return_code == 0 else "runner_failed",
                )
            return "settled"
        fence = self.coordinator.claim_next()
        if fence is None:
            return "idle"
        return "started" if self._spawn(fence) else "failed"

    def close(self) -> None:
        process = self.process
        fence = self.fence
        self.process = None
        self.fence = None
        self.deadline = None
        self.next_renewal = None
        if process is None:
            return
        PythonProbeRunner._terminate_process_group(process)
        if fence is not None:
            self.coordinator.interrupt_invocation(
                fence, reason="supervisor_stopping"
            )


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(
        path,
        os.O_RDONLY
        | os.O_CLOEXEC
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class AtomicJsonSpool:
    def __init__(self, path: Path, *, max_item_bytes: int = SPOOL_ITEM_MAX_BYTES):
        self.path = path
        self.max_item_bytes = max_item_bytes
        self._lock = threading.Lock()

    @staticmethod
    def _validate_private_directory(details: os.stat_result) -> None:
        if (
            not stat.S_ISDIR(details.st_mode)
            or details.st_uid != os.geteuid()
            or details.st_mode & 0o077
        ):
            raise SpoolError("spool directory permissions are unsafe")

    @staticmethod
    def _validate_private_file(details: os.stat_result) -> None:
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.geteuid()
            or details.st_mode & 0o077
        ):
            raise SpoolError("spool item permissions are unsafe")

    def _directory_descriptor(self, *, create: bool) -> int | None:
        try:
            if create:
                self.path.mkdir(parents=True, exist_ok=True, mode=0o700)
            descriptor = os.open(
                self.path,
                os.O_RDONLY
                | os.O_CLOEXEC
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0),
            )
        except FileNotFoundError:
            if not create:
                return None
            raise SpoolError("spool directory is unavailable") from None
        except OSError as exc:
            raise SpoolError("spool directory validation failed") from exc
        try:
            self._validate_private_directory(os.fstat(descriptor))
        except BaseException:
            os.close(descriptor)
            raise
        return descriptor

    def _entry_details(self, descriptor: int, name: str) -> os.stat_result | None:
        try:
            details = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        except FileNotFoundError:
            return None
        self._validate_private_file(details)
        return details

    def put(self, key: str, value: dict[str, Any], *, replace: bool = False) -> None:
        data = json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")
        if not data or len(data) > self.max_item_bytes:
            raise SpoolError("spool item is invalid")
        destination = self.path_for_key(key)
        with self._lock:
            directory_descriptor: int | None = None
            item_descriptor: int | None = None
            temporary: str | None = None
            try:
                directory_descriptor = self._directory_descriptor(create=True)
                assert directory_descriptor is not None
                if (
                    self._entry_details(directory_descriptor, destination.name)
                    is not None
                    and not replace
                ):
                    return
                for _attempt in range(128):
                    temporary = f".pending-{secrets.token_hex(16)}"
                    try:
                        item_descriptor = os.open(
                            temporary,
                            os.O_WRONLY
                            | os.O_CREAT
                            | os.O_EXCL
                            | os.O_CLOEXEC
                            | getattr(os, "O_NOFOLLOW", 0),
                            0o600,
                            dir_fd=directory_descriptor,
                        )
                        break
                    except FileExistsError:
                        continue
                else:
                    raise SpoolError("spool temporary allocation failed")
                assert item_descriptor is not None
                os.fchmod(item_descriptor, 0o600)
                handle = os.fdopen(item_descriptor, "wb")
                item_descriptor = None
                with handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(
                    temporary,
                    destination.name,
                    src_dir_fd=directory_descriptor,
                    dst_dir_fd=directory_descriptor,
                )
                temporary = None
                os.fsync(directory_descriptor)
            except (OSError, UnicodeError, ValueError) as exc:
                if isinstance(exc, SpoolError):
                    raise
                raise SpoolError("spool write failed") from exc
            finally:
                if temporary is not None and directory_descriptor is not None:
                    try:
                        os.unlink(temporary, dir_fd=directory_descriptor)
                    except FileNotFoundError:
                        pass
                if item_descriptor is not None:
                    os.close(item_descriptor)
                if directory_descriptor is not None:
                    os.close(directory_descriptor)

    def path_for_key(self, key: str) -> Path:
        name = f"{hashlib.sha256(key.encode('utf-8')).hexdigest()}.json"
        return self.path / name

    def remove_key(self, key: str) -> None:
        self.remove(self.path_for_key(key))

    def items(self) -> list[tuple[Path, dict[str, Any]]]:
        with self._lock:
            directory_descriptor: int | None = None
            try:
                directory_descriptor = self._directory_descriptor(create=False)
                if directory_descriptor is None:
                    return []
                names = sorted(
                    name
                    for name in os.listdir(directory_descriptor)
                    if name.endswith(".json")
                )
                values: list[tuple[Path, dict[str, Any]]] = []
                for name in names:
                    details = self._entry_details(directory_descriptor, name)
                    if details is None or details.st_size > self.max_item_bytes:
                        raise SpoolError("spool item validation failed")
                    item_descriptor = os.open(
                        name,
                        os.O_RDONLY
                        | os.O_CLOEXEC
                        | getattr(os, "O_NOFOLLOW", 0),
                        dir_fd=directory_descriptor,
                    )
                    try:
                        opened_details = os.fstat(item_descriptor)
                        self._validate_private_file(opened_details)
                        if (
                            opened_details.st_dev != details.st_dev
                            or opened_details.st_ino != details.st_ino
                            or opened_details.st_size > self.max_item_bytes
                        ):
                            raise SpoolError("spool item validation failed")
                        chunks: list[bytes] = []
                        remaining = self.max_item_bytes + 1
                        while remaining:
                            chunk = os.read(item_descriptor, remaining)
                            if not chunk:
                                break
                            chunks.append(chunk)
                            remaining -= len(chunk)
                        raw = b"".join(chunks)
                    finally:
                        os.close(item_descriptor)
                    if len(raw) > self.max_item_bytes:
                        raise SpoolError("spool item validation failed")
                    value = json.loads(raw.decode("ascii"))
                    if not isinstance(value, dict):
                        raise SpoolError("spool item validation failed")
                    values.append((self.path / name, value))
                return values
            except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as exc:
                if isinstance(exc, SpoolError):
                    raise
                raise SpoolError("spool read failed") from exc
            finally:
                if directory_descriptor is not None:
                    os.close(directory_descriptor)

    def remove(self, path: Path) -> None:
        if path.parent != self.path or not path.name.endswith(".json"):
            raise SpoolError("spool removal target is invalid")
        with self._lock:
            directory_descriptor: int | None = None
            try:
                directory_descriptor = self._directory_descriptor(create=False)
                if directory_descriptor is None:
                    return
                if self._entry_details(directory_descriptor, path.name) is None:
                    return
                os.unlink(path.name, dir_fd=directory_descriptor)
                os.fsync(directory_descriptor)
            except FileNotFoundError:
                return
            except OSError as exc:
                if isinstance(exc, SpoolError):
                    raise
                raise SpoolError("spool removal failed") from exc
            finally:
                if directory_descriptor is not None:
                    os.close(directory_descriptor)


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

    def emit(self, code: str) -> bool:
        if code not in _EMERGENCY_MESSAGES:
            raise ValueError("emergency code is invalid")
        with self._lock:
            now = self.clock()
            state = self._state()
            if now - state.get(code, 0.0) < self.cooldown:
                return True
            try:
                self.spool.put(code, {"code": code})
            except SpoolError:
                if self.delivery is not None:
                    try:
                        self.delivery(_EMERGENCY_MESSAGES[code])
                        state[code] = now
                        try:
                            _atomic_json(self.state_path, state)
                        except OSError:
                            pass
                        return True
                    except (MonitoringError, OSError):
                        return False
                return False
            # Request paths own only this durable handoff. Maintenance drains
            # the native network delivery so an unavailable sink cannot occupy
            # the bounded HTTP request pool.
            return True

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


class RecoveryReportStore:
    """Detailed reports and their delivery state, independent of incidents."""

    def __init__(
        self,
        ledger: RecoveryLedger,
        *,
        max_bytes: int = 256 * 1024,
        retry_seconds: float = 300.0,
        clock: Callable[[], float] = time.time,
    ):
        if (
            isinstance(max_bytes, bool)
            or not isinstance(max_bytes, int)
            or not 1_024 <= max_bytes <= 1024 * 1024
            or isinstance(retry_seconds, bool)
            or not isinstance(retry_seconds, (int, float))
            or not math.isfinite(retry_seconds)
            or not 1 <= retry_seconds <= 86_400
        ):
            raise ValueError("recovery report policy is invalid")
        self.ledger = ledger
        self.max_bytes = max_bytes
        self.retry_seconds = float(retry_seconds)
        self.clock = clock

    def queue(
        self,
        *,
        report_key: str,
        incident_id: int,
        generation: int,
        body: dict[str, Any],
        invocation_id: int | None = None,
    ) -> int:
        if (
            not isinstance(report_key, str)
            or safe_field(report_key, default="") != report_key
            or isinstance(incident_id, bool)
            or not isinstance(incident_id, int)
            or incident_id < 1
            or isinstance(generation, bool)
            or not isinstance(generation, int)
            or generation < 1
            or (
                invocation_id is not None
                and (
                    isinstance(invocation_id, bool)
                    or not isinstance(invocation_id, int)
                    or invocation_id < 1
                )
            )
            or not isinstance(body, dict)
        ):
            raise ValueError("recovery report is invalid")
        try:
            body_json = _canonical_json(body)
        except (TypeError, ValueError) as exc:
            raise ValueError("recovery report is invalid") from exc
        if len(body_json.encode("utf-8")) > self.max_bytes:
            raise ValueError("recovery report is too large")
        now = self.clock()
        with self.ledger.transaction() as connection:
            incident = connection.execute(
                "SELECT generation FROM incidents WHERE id = ?", (incident_id,)
            ).fetchone()
            if incident is None or int(incident["generation"]) != generation:
                raise ValueError("recovery report fence is stale")
            if invocation_id is not None:
                invocation = connection.execute(
                    "SELECT 1 FROM invocations WHERE id = ? AND incident_id = ?",
                    (invocation_id, incident_id),
                ).fetchone()
                if invocation is None:
                    raise ValueError("recovery report invocation is invalid")
            existing = connection.execute(
                "SELECT * FROM incident_reports WHERE report_key = ?",
                (report_key,),
            ).fetchone()
            if existing is not None:
                if (
                    existing["incident_id"] != incident_id
                    or existing["generation"] != generation
                    or existing["invocation_id"] != invocation_id
                    or existing["body_json"] != body_json
                ):
                    raise ValueError("recovery report key was reused")
                return int(existing["id"])
            conflicting = connection.execute(
                "SELECT 1 FROM incident_reports WHERE incident_id = ? AND generation = ?",
                (incident_id, generation),
            ).fetchone()
            if conflicting is not None:
                raise ValueError("recovery incident generation already has a report")
            cursor = connection.execute(
                "INSERT INTO incident_reports(report_key, incident_id, generation, invocation_id, "
                "body_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (report_key, incident_id, generation, invocation_id, body_json, now),
            )
            report_id = int(cursor.lastrowid)
            connection.execute(
                "INSERT INTO report_outbox(report_id, state, created_at, available_at) "
                "VALUES (?, ?, ?, ?)",
                (report_id, REPORT_PENDING, now, now),
            )
            return report_id

    def state(self, report_key: str) -> str | None:
        if not isinstance(report_key, str) or safe_field(report_key, default="") != report_key:
            raise ValueError("recovery report key is invalid")
        with self.ledger.transaction() as connection:
            row = connection.execute(
                "SELECT report_outbox.state FROM report_outbox "
                "JOIN incident_reports ON incident_reports.id = report_outbox.report_id "
                "WHERE incident_reports.report_key = ?",
                (report_key,),
            ).fetchone()
        return None if row is None else str(row["state"])

    def mark_reported(self, report_key: str) -> bool:
        if not isinstance(report_key, str) or safe_field(report_key, default="") != report_key:
            raise ValueError("recovery report key is invalid")
        now = self.clock()
        with self.ledger.transaction() as connection:
            row = connection.execute(
                "SELECT report_outbox.id, report_outbox.state FROM report_outbox "
                "JOIN incident_reports ON incident_reports.id = report_outbox.report_id "
                "WHERE incident_reports.report_key = ?",
                (report_key,),
            ).fetchone()
            if row is None:
                return False
            if row["state"] == REPORTED:
                return True
            connection.execute(
                "UPDATE report_outbox SET state = ?, delivered_at = ?, attempts = attempts + 1 "
                "WHERE id = ? AND state = ?",
                (REPORTED, now, row["id"], REPORT_PENDING),
            )
            return True

    def defer(self, report_key: str) -> bool:
        if not isinstance(report_key, str) or safe_field(report_key, default="") != report_key:
            raise ValueError("recovery report key is invalid")
        now = self.clock()
        with self.ledger.transaction() as connection:
            cursor = connection.execute(
                "UPDATE report_outbox SET attempts = attempts + 1, available_at = ? "
                "WHERE state = ? AND report_id = ("
                "SELECT id FROM incident_reports WHERE report_key = ?)",
                (now + self.retry_seconds, REPORT_PENDING, report_key),
            )
            return cursor.rowcount == 1

    def due(self, *, limit: int = 16) -> list[tuple[str, dict[str, Any]]]:
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 128:
            raise ValueError("recovery report delivery limit is invalid")
        with self.ledger.transaction() as connection:
            rows = connection.execute(
                "SELECT incident_reports.report_key, incident_reports.body_json "
                "FROM report_outbox JOIN incident_reports "
                "ON incident_reports.id = report_outbox.report_id "
                "WHERE report_outbox.state = ? AND report_outbox.available_at <= ? "
                "ORDER BY report_outbox.available_at, report_outbox.id LIMIT ?",
                (REPORT_PENDING, self.clock(), limit),
            ).fetchall()
        pending: list[tuple[str, dict[str, Any]]] = []
        for row in rows:
            try:
                body = json.loads(str(row["body_json"]))
            except (TypeError, ValueError, json.JSONDecodeError) as exc:
                raise LedgerCorrupt("recovery report body is invalid") from exc
            if not isinstance(body, dict):
                raise LedgerCorrupt("recovery report body is invalid")
            pending.append((str(row["report_key"]), body))
        return pending


def _redact_report_text(value: Any, *, limit: int = 8_192) -> str:
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        return "unreported"
    text = str(value).replace("\0", "").replace("\r", " ").replace("\n", " ")
    text = _REPORT_PRIVATE_KEY.sub("[redacted-private-key]", text)
    text = _REPORT_URL_USERINFO.sub(r"\1[redacted]@", text)
    text = _REPORT_SECRET.sub("[redacted]", text)
    text = _REPORT_KNOWN_CREDENTIAL.sub("[redacted]", text)
    text = _REPORT_HOME_PATH.sub("[private-path]", text)
    text = _REPORT_ABSOLUTE_PATH.sub("[absolute-path]", text)
    return text[:limit].strip() or "unreported"


def _redact_report_reference(value: Any, *, limit: int = 1_024) -> str:
    text = _redact_report_text(value, limit=limit)
    path = Path(text)
    if path.is_absolute():
        return f"[absolute-path]/{path.name}"[:limit]
    return text


def _report_preimage(action_key: str, value: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "actionKey": action_key,
        "state": "unreported",
        "reference": None,
        "contentSha256": None,
        "sizeBytes": None,
        "pathSha256": None,
    }
    if not isinstance(value, dict):
        record["reference"] = _redact_report_reference(value)
        return record
    state = value.get("state")
    if state in {"absent", "captured"}:
        record["state"] = state
    path_sha256 = value.get("pathSha256")
    if isinstance(path_sha256, str) and _TRANSITION_ID.fullmatch(path_sha256):
        record["pathSha256"] = path_sha256
    if state != "captured":
        return record
    reference = value.get("reference")
    if isinstance(reference, str):
        reference_path = Path(reference)
        if reference_path.is_absolute() and _PREIMAGE_FILE_NAME.fullmatch(
            reference_path.name
        ):
            record["reference"] = f"[absolute-path]/{reference_path.name}"
        else:
            record["reference"] = _redact_report_reference(reference)
    content_sha256 = value.get("contentSha256")
    if isinstance(content_sha256, str) and _TRANSITION_ID.fullmatch(content_sha256):
        record["contentSha256"] = content_sha256
    size_bytes = value.get("sizeBytes")
    if (
        not isinstance(size_bytes, bool)
        and isinstance(size_bytes, int)
        and size_bytes >= 0
    ):
        record["sizeBytes"] = size_bytes
    return record


class RecoveryReportAuthority:
    """Merge claims with durable host evidence and own report delivery state."""

    def __init__(
        self,
        ledger: RecoveryLedger,
        coordinator: IncidentCoordinator,
        store: RecoveryReportStore,
        *,
        max_timeline_entries: int,
        delivery: Callable[[str, dict[str, Any]], None] | None = None,
        enrichers: dict[str, Callable[[dict[str, Any]], list[str]]] | None = None,
        clock: Callable[[], float] = time.time,
    ):
        if (
            isinstance(max_timeline_entries, bool)
            or not isinstance(max_timeline_entries, int)
            or not 1 <= max_timeline_entries <= 2_000
        ):
            raise ValueError("recovery report timeline policy is invalid")
        self.ledger = ledger
        self.coordinator = coordinator
        self.store = store
        self.max_timeline_entries = max_timeline_entries
        self.delivery = delivery
        self.enrichers = {} if enrichers is None else dict(enrichers)
        if any(name not in {"knowledge", "beads"} for name in self.enrichers):
            raise ValueError("recovery report enricher is invalid")
        self.clock = clock

    @staticmethod
    def _document(raw: Any, name: str) -> dict[str, Any]:
        try:
            value = json.loads(str(raw))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise LedgerCorrupt(f"recovery {name} is invalid") from exc
        if not isinstance(value, dict):
            raise LedgerCorrupt(f"recovery {name} is invalid")
        return value

    @staticmethod
    def _text_list(value: Any, *, limit: int, references: bool = False) -> list[str]:
        if not isinstance(value, list):
            return []
        redactor = _redact_report_reference if references else _redact_report_text
        return [redactor(item, limit=limit) for item in value[:256]]

    def _bounded_body(self, body: dict[str, Any]) -> dict[str, Any]:
        if len(_canonical_json(body).encode("utf-8")) <= self.store.max_bytes:
            return body
        compact = copy.deepcopy(body)
        compact["truncated"] = True
        compact["claimSummary"] = str(compact["claimSummary"])[:512]
        compact["rootCause"] = str(compact["rootCause"])[:512]
        compact["residualRisk"] = str(compact["residualRisk"])[:512]
        compact["timeline"] = compact["timeline"][-32:]
        compact["evidenceReferences"] = compact["evidenceReferences"][-64:]
        compact["actions"] = compact["actions"][-32:]
        compact["changedFiles"] = compact["changedFiles"][-32:]
        compact["changedServices"] = compact["changedServices"][-32:]
        compact["changedReleases"] = compact["changedReleases"][-32:]
        compact["preimages"] = compact["preimages"][-32:]
        compact["quarantine"] = compact["quarantine"][-32:]
        compact["rollback"] = compact["rollback"][-32:]
        compact["verification"] = [
            {
                "attempt": item["attempt"],
                "generation": item["generation"],
                "reasons": item["reasons"][:16],
                "ref": item["ref"],
                "result": item["result"],
            }
            for item in compact["verification"][-32:]
        ]
        compact["incident"]["sessions"] = compact["incident"]["sessions"][-16:]
        compact["references"] = {
            key: values[-32:] for key, values in compact["references"].items()
        }
        if len(_canonical_json(compact).encode("utf-8")) <= self.store.max_bytes:
            return compact
        # The configured lower bound is intentionally small. Preserve the
        # complete authoritative shape and terminal outcome even when only a
        # minimal, explicitly truncated report fits that bound.
        minimal = {
            "version": compact["version"],
            "incident": {**compact["incident"], "sessions": compact["incident"]["sessions"][-1:]},
            "trigger": compact["trigger"],
            "claimSummary": str(compact["claimSummary"])[:128],
            "rootCause": str(compact["rootCause"])[:128],
            "confidence": compact["confidence"],
            "timeline": [],
            "evidenceReferences": compact["evidenceReferences"][-8:],
            "actions": [],
            "changedFiles": [],
            "changedServices": [],
            "changedReleases": [],
            "preimages": [],
            "quarantine": [],
            "rollback": [],
            "verification": [],
            "residualRisk": str(compact["residualRisk"])[:128],
            "references": {key: [] for key in compact["references"]},
            "versions": compact["versions"],
            "degradedMetadata": compact["degradedMetadata"],
            "outcome": compact["outcome"],
            "truncated": True,
        }
        if len(_canonical_json(minimal).encode("utf-8")) > self.store.max_bytes:
            minimal["claimSummary"] = "truncated"
            minimal["rootCause"] = "truncated"
            minimal["residualRisk"] = "truncated"
            minimal["evidenceReferences"] = []
            minimal["incident"]["sessions"] = []
        return minimal

    def _trigger_evidence(
        self, connection: Any, correlation_key: str
    ) -> tuple[list[str], int, list[dict[str, Any]]]:
        references: list[str] = []
        impact = 0
        timeline: list[dict[str, Any]] = []
        for row in connection.execute(
            "SELECT id, event_at, normalized_json FROM events ORDER BY event_at, id"
        ).fetchall():
            event = self._document(row["normalized_json"], "report event")
            rule = self.coordinator._rules.get(
                (str(event.get("component", "")), str(event.get("failure_class", "")))
            )
            if rule is None or rule.incident_key != correlation_key:
                continue
            reference = f"event:{int(row['id'])}"
            references.append(reference)
            impact = max(impact, rule.impact)
            timeline.append(
                {
                    "at": float(row["event_at"]),
                    "kind": "trigger",
                    "ref": reference,
                    "state": str(event.get("status", "unknown")),
                }
            )
        return references[-256:], impact, timeline

    def _build(self, incident_id: int) -> tuple[str, int, int | None, dict[str, Any]]:
        degraded: list[str] = []
        with self.ledger.transaction() as connection:
            incident = connection.execute(
                "SELECT * FROM incidents WHERE id = ?", (incident_id,)
            ).fetchone()
            if incident is None or incident["state"] not in {
                "recovered",
                "recovery_failed",
                "recovery_unsafe",
                "retries_exhausted",
            }:
                raise ValueError("recovery report incident is not ready")
            claim_row = connection.execute(
                "SELECT fixer_claims.*, invocations.state AS invocation_state "
                "FROM fixer_claims JOIN invocations "
                "ON invocations.id = fixer_claims.invocation_id "
                "WHERE fixer_claims.incident_id = ? AND invocations.state IN "
                "('completed', 'recovery_failed', 'recovery_unsafe', 'retries_exhausted') "
                "ORDER BY fixer_claims.generation DESC, fixer_claims.id DESC LIMIT 1",
                (incident_id,),
            ).fetchone()
            latest_invocation = connection.execute(
                "SELECT id FROM invocations WHERE incident_id = ? "
                "ORDER BY generation DESC, id DESC LIMIT 1",
                (incident_id,),
            ).fetchone()
            if claim_row is None:
                claim = {
                    "summary": "fixer claim unavailable",
                    "rootCause": "unreported",
                    "residualRisk": "unreported",
                }
                degraded.append("fixer-claim")
                invocation_id = (
                    None if latest_invocation is None else int(latest_invocation["id"])
                )
            else:
                claim = self._document(claim_row["claim_json"], "report claim")
                invocation_id = int(claim_row["invocation_id"])
            references = self._text_list(
                claim.get("references"), limit=1_024, references=True
            )
            reference_groups: dict[str, list[str]] = {
                "knowledge": [],
                "beads": [],
                "adrs": [],
                "localCommits": [],
                "other": [],
            }
            for reference in references:
                prefix = reference.split(":", 1)[0].lower()
                target = {
                    "knowledge": "knowledge",
                    "beads": "beads",
                    "adr": "adrs",
                    "commit": "localCommits",
                    "local-commit": "localCommits",
                }.get(prefix, "other")
                reference_groups[target].append(reference)

            context = {
                "incidentId": incident_id,
                "generation": int(incident["generation"]),
                "invocationId": invocation_id,
            }
            for name in ("knowledge", "beads"):
                enricher = self.enrichers.get(name)
                if enricher is None:
                    degraded.append(name)
                    continue
                try:
                    extra = enricher(dict(context))
                    if not isinstance(extra, list):
                        raise ValueError("invalid enrichment")
                    reference_groups[name].extend(
                        _redact_report_reference(item) for item in extra[:256]
                    )
                except Exception:
                    degraded.append(name)

            event_refs, impact, timeline = self._trigger_evidence(
                connection, str(incident["correlation_key"])
            )
            session_rows = connection.execute(
                "SELECT generation, session_id, state, runtime_json FROM session_bindings "
                "WHERE incident_id = ? ORDER BY generation, id",
                (incident_id,),
            ).fetchall()
            sessions = [
                {
                    "generation": int(row["generation"]),
                    "sessionId": _redact_report_text(row["session_id"], limit=128),
                    "state": str(row["state"]),
                }
                for row in session_rows
            ]
            runtime_versions = (
                {name: "unreported" for name in ("model", "node", "package", "pi")}
                if not session_rows
                else self._document(session_rows[-1]["runtime_json"], "report runtime")
            )
            actions: list[dict[str, Any]] = []
            preimages: list[dict[str, Any]] = []
            quarantine_records: list[dict[str, Any]] = []
            rollback_records: list[dict[str, Any]] = []
            changed_releases: list[dict[str, str]] = []
            action_rows = connection.execute(
                "SELECT action_intents.*, action_outcomes.outcome, "
                "action_outcomes.outcome_json, action_outcomes.created_at AS outcome_at, "
                "action_reconciliations.result AS reconciliation_result "
                "FROM action_intents JOIN invocations "
                "ON invocations.id = action_intents.invocation_id "
                "LEFT JOIN action_outcomes "
                "ON action_outcomes.action_intent_id = action_intents.id "
                "LEFT JOIN action_reconciliations "
                "ON action_reconciliations.action_intent_id = action_intents.id "
                "WHERE invocations.incident_id = ? ORDER BY action_intents.id",
                (incident_id,),
            ).fetchall()
            for row in action_rows:
                intent = self._document(row["intent_json"], "report action intent")
                outcome = (
                    {}
                    if row["outcome_json"] is None
                    else self._document(row["outcome_json"], "report action outcome")
                )
                action = {
                    "actionKey": _redact_report_text(row["action_key"], limit=160),
                    "tool": _redact_report_text(row["tool_name"], limit=80),
                    "state": str(row["state"]),
                    "outcome": None if row["outcome"] is None else str(row["outcome"]),
                    "reconciliation": row["reconciliation_result"],
                    "summary": _redact_report_text(
                        outcome.get("summary", outcome.get("changed", "recorded")),
                        limit=1_024,
                    ),
                }
                actions.append(action)
                if row["tool_name"] in {"recovery_quarantine", "recovery_restore"}:
                    quarantine_records.append(
                        {
                            "actionKey": action["actionKey"],
                            "kind": intent.get("kind"),
                            "quarantineId": _redact_report_text(
                                outcome.get(
                                    "quarantineId", intent.get("quarantineId", "unreported")
                                ),
                                limit=80,
                            ),
                            "outcome": action["outcome"],
                        }
                    )
                if (
                    row["tool_name"] == "recovery_operation"
                    and intent.get("kind") == "rollback"
                ):
                    rollback_records.append(
                        {
                            "actionKey": action["actionKey"],
                            "operationId": _redact_report_text(
                                intent.get("operationId"), limit=128
                            ),
                            "outcome": action["outcome"],
                            "previousRelease": _redact_report_text(
                                outcome.get("previousRelease"), limit=128
                            ),
                            "activeRelease": _redact_report_text(
                                outcome.get("activeRelease"), limit=128
                            ),
                        }
                    )
                    if (
                        isinstance(outcome.get("activeRelease"), str)
                        and outcome.get("activeRelease") != outcome.get("previousRelease")
                    ):
                        changed_releases.append(
                            {
                                "domain": "bot",
                                "from": _redact_report_text(
                                    outcome.get("previousRelease"), limit=128
                                ),
                                "to": _redact_report_text(
                                    outcome.get("activeRelease"), limit=128
                                ),
                            }
                        )
                timeline.append(
                    {
                        "at": float(row["created_at"]),
                        "kind": "action",
                        "ref": f"action:{int(row['id'])}",
                        "state": action["outcome"] or action["state"],
                    }
                )
                for key, value in intent.items():
                    if "preimage" in str(key).lower():
                        preimages.append(_report_preimage(action["actionKey"], value))

            verification: list[dict[str, Any]] = []
            verification_refs: list[str] = []
            for row in connection.execute(
                "SELECT * FROM verification_attempts WHERE incident_id = ? "
                "ORDER BY generation, attempt",
                (incident_id,),
            ).fetchall():
                try:
                    reasons = json.loads(str(row["reasons_json"]))
                    evidence = json.loads(str(row["evidence_json"]))
                except (TypeError, ValueError, json.JSONDecodeError) as exc:
                    raise LedgerCorrupt("recovery report verification is invalid") from exc
                if not isinstance(reasons, list) or not isinstance(evidence, list):
                    raise LedgerCorrupt("recovery report verification is invalid")
                reference = f"verification:{int(row['id'])}"
                verification_refs.append(reference)
                verification.append(
                    {
                        "attempt": int(row["attempt"]),
                        "evidence": evidence[:256],
                        "generation": int(row["generation"]),
                        "reasons": [_redact_report_text(item, limit=256) for item in reasons[:256]],
                        "ref": reference,
                        "result": str(row["result"]),
                    }
                )
                timeline.append(
                    {
                        "at": float(row["completed_at"]),
                        "kind": "verification",
                        "ref": reference,
                        "state": str(row["result"]),
                    }
                )

            timeline.sort(key=lambda item: (item["at"], item["kind"], item["ref"]))
            generation = int(incident["generation"])
            report_key = f"incident:{incident_id}:generation:{generation}:report:v1"
            body = {
                "version": 1,
                "incident": {
                    "id": incident_id,
                    "generation": generation,
                    "sessions": sessions,
                },
                "trigger": {
                    "correlationKey": _redact_report_text(
                        incident["correlation_key"], limit=160
                    ),
                    "impact": impact,
                },
                "claimSummary": _redact_report_text(
                    claim.get("summary", claim.get("reason"))
                ),
                "rootCause": _redact_report_text(
                    claim.get("rootCause", claim.get("reason"))
                ),
                "confidence": (
                    claim.get("confidence")
                    if claim.get("confidence") in {"low", "medium", "high"}
                    else "unreported"
                ),
                "timeline": timeline[-self.max_timeline_entries :],
                "evidenceReferences": event_refs + verification_refs,
                "actions": actions,
                "changedFiles": self._text_list(
                    claim.get("changedFiles"), limit=4_096, references=True
                ),
                "changedServices": self._text_list(
                    claim.get("changedServices"), limit=256
                ),
                "changedReleases": changed_releases,
                "preimages": preimages,
                "quarantine": quarantine_records,
                "rollback": rollback_records,
                "verification": verification,
                "residualRisk": _redact_report_text(claim.get("residualRisk")),
                "references": reference_groups,
                "versions": {
                    "model": _redact_report_text(runtime_versions.get("model"), limit=160),
                    "policy": int(incident["policy_revision"]),
                    "runtime": {
                        "node": _redact_report_text(runtime_versions.get("node"), limit=80),
                        "package": _redact_report_text(runtime_versions.get("package"), limit=80),
                        "pi": _redact_report_text(runtime_versions.get("pi"), limit=80),
                    },
                },
                "degradedMetadata": sorted(degraded),
                "outcome": {
                    "recovered": "recovered",
                    "recovery_failed": "failed",
                    "recovery_unsafe": "blocked",
                    "retries_exhausted": "escalated",
                }[str(incident["state"])],
            }
            if degraded:
                target = f"report:{report_key}"
                if connection.execute(
                    "SELECT 1 FROM audit WHERE operation = 'report_enrichment_degraded' "
                    "AND target = ?",
                    (target,),
                ).fetchone() is None:
                    connection.execute(
                        "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                        "VALUES (?, 'system', 'report_enrichment_degraded', ?, ?)",
                        (
                            self.clock(),
                            target,
                            _canonical_json({"sources": sorted(degraded)}),
                        ),
                    )
        return report_key, generation, invocation_id, self._bounded_body(body)

    def queue_ready(self) -> int:
        with self.ledger.transaction() as connection:
            rows = connection.execute(
                "SELECT incidents.id FROM incidents WHERE incidents.state IN "
                "('recovered', 'recovery_failed', 'recovery_unsafe', 'retries_exhausted') "
                "AND NOT EXISTS (SELECT 1 FROM incident_reports "
                "WHERE incident_reports.incident_id = incidents.id "
                "AND incident_reports.generation = incidents.generation) "
                "ORDER BY incidents.id"
            ).fetchall()
        queued = 0
        for row in rows:
            incident_id = int(row["id"])
            try:
                key, generation, invocation_id, body = self._build(incident_id)
                self.store.queue(
                    report_key=key,
                    incident_id=incident_id,
                    generation=generation,
                    invocation_id=invocation_id,
                    body=body,
                )
            except ValueError:
                # Intake may advance the incident generation between the due
                # scan and the fenced queue transaction. The next maintenance
                # pass rebuilds only from the new authoritative state.
                continue
            queued += 1
        return queued

    def deliver_due(self) -> int:
        if self.delivery is None:
            return 0
        delivered = 0
        for report_key, body in self.store.due():
            try:
                self.delivery(report_key, body)
            except Exception:
                self.store.defer(report_key)
                continue
            if self.store.mark_reported(report_key):
                delivered += 1
        return delivered


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
            cursor = connection.execute(
                "INSERT OR IGNORE INTO notification_outbox(notification_key, kind, body_json, "
                "created_at, available_at) VALUES (?, 'immediate', ?, ?, ?)",
                (key, body, now, now),
            )
        # Intake and reconciliation only own the durable handoff. Network
        # delivery belongs to maintenance so unavailable Telegram cannot consume
        # the bounded HTTP request pool.
        return cursor.rowcount > 0

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
            if not self.emergency.emit(str(body["reason"])):
                continue
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


@dataclass(frozen=True)
class FixerResult:
    status: int
    body: dict[str, Any]


class RecoveryService:
    def __init__(
        self,
        ledger: RecoveryLedger,
        event_spool: AtomicJsonSpool,
        emergency: EmergencyNotifier,
        coordinator: IncidentCoordinator | None = None,
        verifier: RecoveryVerifier | None = None,
        probe_runner: PythonProbeRunner | None = None,
        notifications: RecoveryNotificationOutbox | None = None,
        fixer_process: RecoveryFixerProcessManager | None = None,
        reports: RecoveryReportAuthority | None = None,
        actuator: RecoveryActuator | None = None,
        event_retention_seconds: float = DEFAULT_EVENT_RETENTION_SECONDS,
        event_retention_batch_size: int = DEFAULT_EVENT_RETENTION_BATCH_SIZE,
    ):
        self.ledger = ledger
        self.event_spool = event_spool
        self.emergency = emergency
        self.coordinator = coordinator
        self.verifier = verifier
        if probe_runner is not None and probe_runner.verifier is not verifier:
            raise ValueError("recovery probe runner does not match verifier")
        self.probe_runner = probe_runner
        self.notifications = notifications
        if fixer_process is not None and fixer_process.coordinator is not coordinator:
            raise ValueError("recovery fixer process does not match coordinator")
        if reports is not None and reports.coordinator is not coordinator:
            raise ValueError("recovery report authority does not match coordinator")
        if actuator is not None and actuator.coordinator is not coordinator:
            raise ValueError("recovery actuator does not match coordinator")
        self.fixer_process = fixer_process
        self.reports = reports
        self.actuator = actuator
        self.event_retention_seconds = event_retention_seconds
        self.event_retention_batch_size = event_retention_batch_size
        self._ledger_corrupt = False

    def _report_ledger_error(self, error: LedgerError) -> None:
        if isinstance(error, LedgerCorrupt) or self._ledger_corrupt:
            self._ledger_corrupt = True
            close = getattr(self.ledger, "close", None)
            if callable(close):
                close()
            self.emergency.emit("ledger_corrupt")
            return
        self.emergency.emit("ledger_unavailable")

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
        observed_at = float(envelope["observed_at"])
        inserted = self.ledger.record_events(events, observed_at=observed_at)
        if self.coordinator is not None:
            self.coordinator.reconcile()
        if self.verifier is not None:
            for source, healthy in sorted(envelope["heartbeats"].items()):
                if source in self.verifier.source_ids:
                    self.verifier.record_heartbeat(
                        source, healthy=healthy, observed_at=observed_at
                    )
        return inserted

    def _drain_events(self) -> None:
        pending: list[tuple[Path, dict[str, Any]]] = []
        for path, item in self.event_spool.items():
            if _valid_spooled_event(item):
                envelope = self._intake_envelope([item], None)
            elif _valid_spooled_intake(item):
                envelope = item
            else:
                raise SpoolError("event spool item is invalid")
            pending.append((path, envelope))
        # Spool filenames are content hashes, not chronology. The durable intake
        # observation orders replay after a ledger outage.
        pending.sort(key=lambda entry: (float(entry[1]["observed_at"]), entry[0].name))
        for path, envelope in pending:
            self._persist_intake(envelope)
            self.event_spool.remove(path)

    def accept(
        self,
        events: list[dict[str, Any]],
        *,
        heartbeats: dict[str, bool] | None = None,
    ) -> IntakeResult:
        if not self._ledger_corrupt:
            try:
                self._drain_events()
            except LedgerError as exc:
                self._report_ledger_error(exc)
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
            self.event_spool.put(spool_key, envelope, replace=True)
        except SpoolError:
            self.emergency.emit("persistence_failed")
            return IntakeResult(503, "persistence unavailable")
        if self._ledger_corrupt:
            return IntakeResult(202, "durably spooled")
        try:
            inserted = self._persist_intake(envelope)
            self.event_spool.remove_key(spool_key)
            return IntakeResult(200, "accepted" if inserted else "duplicate")
        except LedgerError as exc:
            self._report_ledger_error(exc)
            return IntakeResult(202, "durably spooled")
        except SpoolError:
            self.emergency.emit("spool_corrupt")
            return IntakeResult(503, "persistence unavailable")

    def _fixer_fence(self, payload: dict[str, Any]) -> InvocationFence:
        if self.coordinator is None:
            raise ValueError("recovery fixer coordinator is unavailable")
        integers = [
            payload.get("invocationId"),
            payload.get("incidentId"),
            payload.get("generation"),
            payload.get("policyRevision"),
        ]
        if any(
            isinstance(value, bool) or not isinstance(value, int) or value < 1
            for value in integers
        ):
            raise ValueError("recovery fixer fence is invalid")
        evidence_hash = payload.get("evidenceHash")
        lease_token = payload.get("leaseToken")
        if (
            not isinstance(evidence_hash, str)
            or _TRANSITION_ID.fullmatch(evidence_hash) is None
            or not isinstance(lease_token, str)
            or safe_field(lease_token, limit=160, default="") != lease_token
        ):
            raise ValueError("recovery fixer fence is invalid")
        return InvocationFence(
            invocation_id=int(payload["invocationId"]),
            incident_id=int(payload["incidentId"]),
            generation=int(payload["generation"]),
            evidence_hash=evidence_hash,
            policy_revision=int(payload["policyRevision"]),
            lease_token=lease_token,
            owner=self.coordinator.owner,
        )

    def fixer(self, path: str, body: bytes) -> FixerResult:
        """Handle one closed, body-bounded fixer protocol operation."""

        fields = _FIXER_ENDPOINT_FIELDS.get(path)
        operation = _FIXER_ENDPOINT_OPERATIONS.get(path)
        if fields is None or operation is None:
            return FixerResult(404, {"ok": False})
        if self.coordinator is None:
            return FixerResult(503, {"ok": False})
        if not self.coordinator.endpoint_allowed(operation):
            return FixerResult(403, {"ok": False})
        try:
            payload = _decode_object(body)
            if set(payload) != _FIXER_FENCE_FIELDS | fields:
                raise ValueError("recovery fixer payload is invalid")
            fence = self._fixer_fence(payload)
            if path == "/v1/fixer/state":
                state = self.coordinator.fixer_state(fence)
                return FixerResult(200, {"ok": True, **state}) if state else FixerResult(409, {"ok": False})
            if path == "/v1/fixer/heartbeat":
                ok = self.coordinator.renew_lease(fence)
                return FixerResult(200 if ok else 409, {"ok": ok})
            if path == "/v1/fixer/session/bind":
                binding_id = self.coordinator.bind_session(
                    fence,
                    session_id=payload["sessionId"],
                    session_directory=payload["sessionDirectory"],
                    transcript_path=payload["transcriptPath"],
                    runtime=payload["runtime"],
                )
                return (
                    FixerResult(200, {"ok": True, "bindingId": binding_id})
                    if binding_id is not None
                    else FixerResult(409, {"ok": False})
                )
            if path == "/v1/fixer/session/resumed":
                ok = self.coordinator.mark_session_resumed(fence, payload["bindingId"])
                return FixerResult(200 if ok else 409, {"ok": ok})
            if path == "/v1/fixer/session/replace":
                binding_id = self.coordinator.replace_session_with_proof(
                    fence,
                    previous_binding_id=payload["previousBindingId"],
                    session_id=payload["sessionId"],
                    session_directory=payload["sessionDirectory"],
                    transcript_path=payload["transcriptPath"],
                    startup_classifier=payload["startupClassifier"],
                    journal_digest=payload["journalDigest"],
                    runtime=payload["runtime"],
                )
                return (
                    FixerResult(200, {"ok": True, "bindingId": binding_id})
                    if binding_id is not None
                    else FixerResult(409, {"ok": False})
                )
            if path == "/v1/fixer/action/intent":
                action_id = self.coordinator.record_action_intent(
                    fence,
                    action_key=payload["actionKey"],
                    tool_name=payload["toolName"],
                    intent=payload["intent"],
                )
                return (
                    FixerResult(200, {"ok": True, "actionId": action_id})
                    if action_id is not None
                    else FixerResult(409, {"ok": False})
                )
            if path == "/v1/fixer/action/outcome":
                ok = self.coordinator.record_action_outcome(
                    fence,
                    action_key=payload["actionKey"],
                    outcome=payload["outcome"],
                    details=payload["details"],
                )
                return FixerResult(200 if ok else 409, {"ok": ok})
            if path == "/v1/fixer/action/reconcile":
                ok = self.coordinator.reconcile_action(
                    fence,
                    action_key=payload["actionKey"],
                    idempotency_key=payload["idempotencyKey"],
                    result=payload["result"],
                    details=payload["details"],
                )
                return FixerResult(200 if ok else 409, {"ok": ok})
            if path == "/v1/fixer/guard/rejection":
                ok = self.coordinator.record_guard_rejection(
                    fence,
                    event_key=payload["eventKey"],
                    category=payload["category"],
                    tool_name=payload["toolName"],
                    input_sha256=payload["inputSha256"],
                )
                return FixerResult(200 if ok else 409, {"ok": ok})
            if path in {
                "/v1/fixer/quarantine",
                "/v1/fixer/restore",
                "/v1/fixer/operation",
            }:
                if self.actuator is None:
                    return FixerResult(503, {"ok": False})
                if path == "/v1/fixer/quarantine":
                    status, result = self.actuator.quarantine_file(
                        fence,
                        idempotency_key=payload["idempotencyKey"],
                        source_path=payload["sourcePath"],
                    )
                elif path == "/v1/fixer/restore":
                    status, result = self.actuator.restore_file(
                        fence,
                        idempotency_key=payload["idempotencyKey"],
                        quarantine_id=payload["quarantineId"],
                    )
                else:
                    status, result = self.actuator.reviewed_operation(
                        fence,
                        idempotency_key=payload["idempotencyKey"],
                        operation_id=payload["operationId"],
                    )
                return FixerResult(status, result)
            if path == "/v1/fixer/blocked":
                ok = self.coordinator.accept_blocked_claim(
                    fence,
                    claim_key=payload["claimKey"],
                    reason=payload["reason"],
                    residual_risk=payload["residualRisk"],
                )
                return FixerResult(200 if ok else 409, {"ok": ok})
            if path == "/v1/fixer/finish":
                ok = self.coordinator.accept_completion_claim(
                    fence,
                    claim_key=payload["claimKey"],
                    claim=payload["claim"],
                )
                return FixerResult(200 if ok else 409, {"ok": ok})
        except (IntakeError, TypeError, ValueError, UnicodeError):
            return FixerResult(400, {"ok": False})
        except LedgerError as exc:
            self._report_ledger_error(exc)
            return FixerResult(503, {"ok": False})
        return FixerResult(404, {"ok": False})

    def health(self) -> IntakeResult:
        if self._ledger_corrupt:
            self.emergency.emit("ledger_corrupt")
            return IntakeResult(503, "unhealthy")
        try:
            self.ledger.ping()
            self._drain_events()
            if self.verifier is not None:
                self.verifier.record_heartbeat("supervisor")
            if self.coordinator is not None:
                self.coordinator.reconcile()
        except LedgerError as exc:
            self._report_ledger_error(exc)
            return IntakeResult(503, "unhealthy")
        except SpoolError:
            self.emergency.emit("spool_corrupt")
            return IntakeResult(503, "unhealthy")
        return IntakeResult(200, "ok")

    def maintenance(self) -> dict[str, Any]:
        summary: dict[str, Any] = {"activeIncidents": 0, "verification": []}
        if self._ledger_corrupt:
            self.emergency.emit("ledger_corrupt")
            try:
                self.emergency.drain()
            except SpoolError:
                pass
            return summary
        try:
            self._drain_events()
            if self.coordinator is not None:
                self.coordinator.controls.expire()
                summary["activeIncidents"] = self.coordinator.reconcile()
        except LedgerError as exc:
            self._report_ledger_error(exc)
        except SpoolError:
            self.emergency.emit("spool_corrupt")
        if self._ledger_corrupt:
            return summary
        # Reconciliation can invalidate a live generation. Fence and terminate
        # its process group before delivery or deterministic probes can block
        # this maintenance pass.
        if self.fixer_process is not None:
            try:
                summary["fixer"] = self.fixer_process.tick()
            except LedgerError as exc:
                self._report_ledger_error(exc)
        if self._ledger_corrupt:
            return summary
        try:
            self.ledger.prune_event_history(
                retention_seconds=self.event_retention_seconds,
                batch_size=self.event_retention_batch_size,
            )
        except LedgerError as exc:
            self._report_ledger_error(exc)
        if self._ledger_corrupt:
            return summary
        if self.notifications is not None:
            try:
                self.notifications.deliver_due()
            except LedgerError as exc:
                self._report_ledger_error(exc)
        try:
            self.emergency.drain()
        except SpoolError:
            self.emergency.emit("spool_corrupt")
        if self._ledger_corrupt:
            return summary
        if self.verifier is not None:
            try:
                self.verifier.record_heartbeat("supervisor")
                if self.probe_runner is not None:
                    self.probe_runner.refresh_due()
                verification_results = self.verifier.evaluate_all()
                summary["verification"] = [
                    {
                        "incidentId": incident_id,
                        "recovered": result.recovered,
                        "reasons": list(result.reasons),
                        "evidence": [
                            {
                                "kind": item.kind,
                                "id": item.identifier,
                                "state": item.state,
                            }
                            for item in result.evidence
                        ],
                    }
                    for incident_id, result in verification_results
                ]
                for incident_id, result in verification_results:
                    classification = self.verifier.mechanical_classification(incident_id, result)
                    if classification is not None:
                        name, dedupe_key = classification
                        if name == "missed_recovery":
                            self.verifier.coordinator.mark_missed_recovery(
                                incident_id,
                                dedupe_key=dedupe_key,
                                result=result,
                            )
            except LedgerError as exc:
                self._report_ledger_error(exc)
        if self._ledger_corrupt:
            return summary
        if self.reports is not None:
            try:
                summary["reportsQueued"] = self.reports.queue_ready()
                summary["reportsDelivered"] = self.reports.deliver_due()
            except LedgerError as exc:
                self._report_ledger_error(exc)
        return summary

    def close(self) -> None:
        if self.fixer_process is not None:
            try:
                self.fixer_process.close()
            except LedgerError:
                # The process group has already been terminated; a ledger that
                # failed closed cannot accept the optional interruption audit.
                pass


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
        fixer_auth_token: str | None = None,
        max_body: int,
        body_timeout: float,
        service: RecoveryService,
        startup_nonce: str | None = None,
        capsule_release_id: str | None = None,
    ):
        if fixer_auth_token is not None and hmac.compare_digest(
            auth_token, fixer_auth_token
        ):
            raise ValueError("recovery credentials overlap")
        if (startup_nonce is None) != (capsule_release_id is None) or (
            startup_nonce is not None
            and (
                _TRANSITION_ID.fullmatch(startup_nonce) is None
                or not isinstance(capsule_release_id, str)
                or _CAPSULE_RELEASE_ID.fullmatch(capsule_release_id) is None
            )
        ):
            raise ValueError("recovery startup identity is invalid")
        self.intake_auth_header = f"Bearer {auth_token}".encode("utf-8")
        self.fixer_auth_header = (
            None
            if fixer_auth_token is None
            else f"Bearer {fixer_auth_token}".encode("utf-8")
        )
        self.max_body = max_body
        self.body_timeout = body_timeout
        self.service = service
        self.startup_nonce = startup_nonce
        self.capsule_release_id = capsule_release_id


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

        def _reply(
            self,
            status: int,
            text: str,
            *,
            headers: dict[str, str] | None = None,
        ) -> None:
            body = text.encode("ascii")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "text/plain; charset=us-ascii")
                self.send_header("Content-Length", str(len(body)))
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionError, OSError):
                return

        def _reply_json(self, status: int, value: dict[str, Any]) -> None:
            body = _canonical_json(value).encode("ascii")
            try:
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=us-ascii")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionError, OSError):
                return

        def _authenticated(self, *, fixer: bool = False) -> bool:
            supplied = self.headers.get("Authorization", "").encode("utf-8", "surrogatepass")
            expected = app.fixer_auth_header if fixer else app.intake_auth_header
            if expected is None or not hmac.compare_digest(supplied, expected):
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
            identity_headers = (
                {}
                if app.startup_nonce is None or app.capsule_release_id is None
                else {
                    _STARTUP_NONCE_HEADER: app.startup_nonce,
                    _STARTUP_RELEASE_HEADER: app.capsule_release_id,
                }
            )
            self._reply(result.status, result.text, headers=identity_headers)

        def do_POST(self) -> None:  # noqa: N802
            fixer_request = self.path in _FIXER_ENDPOINT_FIELDS
            if self.path not in {"/v1/alertmanager", "/v1/runtime-doctor"} and not fixer_request:
                self._reply(404, "not found")
                return
            if not self._authenticated(fixer=fixer_request):
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
                if fixer_request:
                    result = app.service.fixer(self.path, body)
                    self._reply_json(result.status, result.body)
                    return
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
    parser.add_argument("--config", required=True)
    parser.add_argument(
        "--workspace", default=os.environ.get("MINIME_CONTROL_WORKSPACE_ROOT", "")
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
    def record_events(
        self, _events: Any, *, observed_at: float | None = None
    ) -> int:
        del observed_at
        raise LedgerUnavailable("ledger startup is unavailable")

    def ping(self) -> None:
        raise LedgerUnavailable("ledger startup is unavailable")

    def prune_event_history(
        self,
        *,
        now: float | None = None,
        retention_seconds: float = DEFAULT_EVENT_RETENTION_SECONDS,
        batch_size: int = DEFAULT_EVENT_RETENTION_BATCH_SIZE,
    ) -> int:
        del now, retention_seconds, batch_size
        raise LedgerUnavailable("ledger startup is unavailable")


def _installed_fixer_runner(
    configured: RecoveryConfig,
) -> tuple[Path, tuple[str, str] | None]:
    package_root = Path(__file__).resolve().parent.parent
    runner = package_root / "dist" / "recovery" / "fixer-session.js"
    node = Path(str(configured.slot_policy["nodeExecutable"]))
    if not runner.is_file():
        return package_root, None
    try:
        executable = node.resolve(strict=True)
        runner = runner.resolve(strict=True)
        if not executable.is_file() or not os.access(executable, os.X_OK):
            return package_root, None
    except OSError:
        return package_root, None
    return package_root, (str(executable), str(runner))


def _active_slot_health(configured: RecoveryConfig) -> dict[str, bool]:
    health: dict[str, bool] = {}
    for domain in ("bot", "capsule"):
        try:
            active_slot_release(configured, domain)
        except (RecoverySlotError, OSError, ValueError, KeyError, TypeError):
            health[domain] = False
        else:
            health[domain] = True
    return health


def _active_bot_release(configured: RecoveryConfig) -> str | None:
    try:
        return str(active_slot_release(configured, "bot")["releaseId"])
    except (RecoverySlotError, OSError, ValueError, KeyError, TypeError):
        return None


def _report_delivery_message(report_key: str, body: dict[str, Any]) -> str:
    """Build one bounded Telegram handoff while the full report stays durable."""

    incident = body.get("incident")
    incident_summary = {
        "id": incident.get("id"),
        "generation": incident.get("generation"),
    } if isinstance(incident, dict) else None
    summary = {
        "reportKey": safe_field(report_key, limit=256),
        "incident": incident_summary,
        "degradedMetadata": body.get("degradedMetadata"),
        "outcome": body.get("outcome"),
    }
    encoded = _canonical_json(summary)
    prefix = "MINIME RECOVERY REPORT\n"
    suffix = "\nFull redacted report remains in the durable local outbox."
    maximum = 4_096 - len(prefix) - len(suffix)
    if len(encoded) > maximum:
        encoded = encoded[: max(0, maximum - 16)] + "...[truncated]"
    return f"{prefix}{encoded}{suffix}"


def _build_recovery_service(
    ledger: RecoveryLedger,
    event_spool: AtomicJsonSpool,
    emergency: EmergencyNotifier,
    *,
    configured: RecoveryConfig,
    report_delivery: Callable[[str, dict[str, Any]], None] | None = None,
    allow_fixer_dispatch: bool = True,
    verify_active_slots: bool = True,
) -> RecoveryService:
    controls = RecoveryControls(ledger)
    static_policy = recovery_static_policy(configured)
    controls.ensure_static_policy(static_policy)
    revision = controls.current().revision
    notifications = RecoveryNotificationOutbox(ledger, emergency=emergency)
    configured_rules = tuple(
        CorrelationRule(
            component=str(rule["component"]),
            failure_class=str(rule["failureClass"]),
            incident_key=str(rule["incidentKey"]),
            impact=int(rule["impact"]),
        )
        for rule in configured.correlation_rules
    )
    coordinator = IncidentCoordinator(
        ledger,
        RecoveryPolicy(
            revision=revision,
            rules=configured_rules,
            lease_seconds=configured.fixer_lease_seconds,
        ),
        owner=f"supervisor-{os.getpid()}",
        controls=controls,
        immediate_escalation=notifications.immediate_escalation,
        mode=configured.mode,
        static_policy=static_policy,
        max_actions_per_invocation=int(
            configured.action_policy["maxActionsPerInvocation"]
        ),
        session_root=Path(str(configured.session_policy["directory"])),
        max_session_replacements=int(
            configured.session_policy["maxReplacementsPerGeneration"]
        ),
        journal_digest_max_bytes=int(
            configured.session_policy["journalDigestMaxBytes"]
        ),
    )
    verifier = RecoveryVerifier(
        ledger,
        coordinator,
        probe_ids=tuple(str(probe["id"]) for probe in configured.probes),
        source_ids=configured.source_ids,
        cadence_seconds=configured.runtime_doctor_cadence_seconds,
        freshness_seconds=configured.verification_freshness_seconds,
        hold_down_seconds=configured.verification_hold_down_seconds,
        slot_validator=(
            (lambda: _active_slot_health(configured))
            if verify_active_slots
            else None
        ),
    )
    probe_runner = PythonProbeRunner(verifier, configured.probes)
    package_root, runner_argv = _installed_fixer_runner(configured)
    fixer_process = RecoveryFixerProcessManager(
        coordinator,
        runner_argv=runner_argv,
        package_root=package_root,
        control_workspace=configured.workspace,
        endpoint=f"http://{configured.host}:{configured.port}",
        fixer_credential_file=configured.fixer_auth_token_file,
        agent_id=configured.internal_agent_id,
        session_root=Path(str(configured.session_policy["directory"])),
        startup_timeout_seconds=int(
            configured.session_policy["startupTimeoutSeconds"]
        ),
        resume_timeout_seconds=int(
            configured.session_policy["resumeTimeoutSeconds"]
        ),
        renew_seconds=configured.fixer_renew_seconds,
        run_timeout_seconds=int(
            configured.action_policy["reconciliationTimeoutSeconds"]
        ),
        pi_executable=Path(str(configured.slot_policy["piExecutable"])),
        preimage_directory=Path(str(configured.session_policy["directory"]))
        / "preimages",
        preimage_max_bytes=int(configured.action_policy["preimageMaxBytes"]),
    )
    report_store = RecoveryReportStore(
        ledger,
        max_bytes=int(configured.report_policy["maxBytes"]),
        retry_seconds=int(configured.report_policy["retrySeconds"]),
    )
    reports = RecoveryReportAuthority(
        ledger,
        coordinator,
        report_store,
        max_timeline_entries=int(configured.report_policy["maxTimelineEntries"]),
        delivery=report_delivery,
    )
    actuator = RecoveryActuator(
        coordinator,
        RecoveryQuarantine(configured.quarantine_policy),
        ReviewedOperationExecutor(
            configured.reviewed_operations,
            active_bot_release=lambda: _active_bot_release(configured),
        ),
    )
    service = RecoveryService(
        ledger,
        event_spool,
        emergency,
        coordinator=coordinator,
        verifier=verifier,
        probe_runner=probe_runner,
        notifications=notifications,
        fixer_process=fixer_process if allow_fixer_dispatch else None,
        reports=reports,
        actuator=actuator,
    )
    return service


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    if not args.workspace:
        print("recovery supervisor configuration rejected", file=sys.stderr)
        return 2
    workspace = Path(args.workspace).resolve()
    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = workspace / config_path
    try:
        configured = load_recovery_config(config_path, workspace)
    except RecoveryConfigError:
        print("recovery supervisor configuration rejected", file=sys.stderr)
        return 2
    if (
        not 1 <= args.max_body <= 4 * 1024 * 1024
        or not 1 <= args.max_concurrent <= 128
        or not 1 <= args.busy_timeout_ms <= 30_000
        or not math.isfinite(args.body_timeout)
        or not 0 < args.body_timeout <= 30
        or not math.isfinite(args.emergency_cooldown)
        or not 0 <= args.emergency_cooldown <= 86_400
    ):
        print("recovery supervisor configuration rejected", file=sys.stderr)
        return 2
    startup_nonce = os.environ.get("MINIME_RECOVERY_STARTUP_NONCE")
    capsule_release_id = os.environ.get("MINIME_RECOVERY_CAPSULE_RELEASE_ID")
    if (startup_nonce is None) != (capsule_release_id is None) or (
        startup_nonce is not None
        and (
            _TRANSITION_ID.fullmatch(startup_nonce) is None
            or not isinstance(capsule_release_id, str)
            or _CAPSULE_RELEASE_ID.fullmatch(capsule_release_id) is None
        )
    ):
        print("recovery supervisor configuration rejected", file=sys.stderr)
        return 2
    try:
        token = read_auth_token(configured.auth_token_file)
        fixer_token = read_auth_token(configured.fixer_auth_token_file)
        if hmac.compare_digest(token, fixer_token):
            raise ValueError("recovery credentials overlap")
    except ValueError:
        print("recovery supervisor configuration rejected", file=sys.stderr)
        return 2

    spool_root = configured.spool_directory
    event_spool = AtomicJsonSpool(spool_root / "events")
    delivery = None
    report_delivery = None
    if args.chat_id:
        telegram_config = DeliveryConfig(args.chat_id, args.thread_id)
        delivery = lambda message: send_telegram(message, telegram_config)
        report_delivery = lambda report_key, body: send_telegram(
            _report_delivery_message(report_key, body), telegram_config
        )
    emergency = EmergencyNotifier(
        spool_root / "notifications",
        delivery=delivery,
        cooldown=args.emergency_cooldown,
    )
    ledger: RecoveryLedger | None
    try:
        ledger = RecoveryLedger(
            configured.database, busy_timeout_ms=args.busy_timeout_ms
        )
    except LedgerCorrupt:
        emergency.emit("ledger_corrupt")
        try:
            emergency.drain()
        except SpoolError:
            pass
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
        fixer_auth_token=fixer_token,
        max_body=args.max_body,
        body_timeout=args.body_timeout,
        service=service,
        startup_nonce=startup_nonce,
        capsule_release_id=capsule_release_id,
    )
    try:
        server = BoundedThreadingHTTPServer(
            (configured.host, configured.port),
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
            ledger.recover_unfinished_actions()
            service = _build_recovery_service(
                ledger,
                event_spool,
                emergency,
                configured=configured,
                report_delivery=report_delivery,
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
            try:
                emergency.drain()
            except SpoolError:
                pass
            print("recovery supervisor ledger validation failed", file=sys.stderr)
            return 1
    def serve_requests() -> None:
        try:
            server.serve_forever(poll_interval=0.2)
        finally:
            stop_requested.set()

    request_thread = threading.Thread(
        target=serve_requests,
        name="recovery-http",
        daemon=True,
    )
    request_thread.start()
    print("recovery supervisor ready", flush=True)
    next_ledger_retry = time.monotonic()
    try:
        while not stop_requested.is_set():
            if stop_requested.wait(1.0):
                break
            if ledger is None and time.monotonic() >= next_ledger_retry:
                next_ledger_retry = time.monotonic() + 5.0
                recovered_ledger: RecoveryLedger | None = None
                try:
                    recovered_ledger = RecoveryLedger(
                        configured.database,
                        busy_timeout_ms=args.busy_timeout_ms,
                        recover_unfinished_actions=True,
                    )
                    recovered_service = _build_recovery_service(
                        recovered_ledger,
                        event_spool,
                        emergency,
                        configured=configured,
                        report_delivery=report_delivery,
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
        server.shutdown()
        request_thread.join(timeout=5.0)
        server.server_close()
        app.service.close()
        if ledger is not None:
            ledger.close()
        restore_signal_handlers()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
