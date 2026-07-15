#!/usr/bin/env python3
"""Fixed-schema, standard-library SQLite ledger for local recovery intake."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
import math
import os
from pathlib import Path
import sqlite3
import stat
import threading
import time
from typing import Any, Iterable, Iterator

SCHEMA_VERSION = 4
DEFAULT_BUSY_TIMEOUT_MS = 2_000
DEFAULT_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60
DEFAULT_EVENT_RETENTION_BATCH_SIZE = 256
MAX_EVENT_FUTURE_SKEW_SECONDS = 300
EXPECTED_TABLES = {
    "audit",
    "events",
    "action_intents",
    "action_outcomes",
    "action_reconciliations",
    "fixer_claims",
    "fixer_lease",
    "incidents",
    "incident_reports",
    "invocations",
    "metadata",
    "notification_outbox",
    "policy_revisions",
    "report_outbox",
    "session_bindings",
    "session_replacements",
    "verification_attempts",
}
EXPECTED_INDEXES = {
    "action_intents_unresolved",
    "events_latest_source_fingerprint",
    "events_received_at",
    "outbox_available",
    "report_outbox_available",
    "session_current_generation",
    "sessions_incident_generation",
    "verification_attempts_incident",
}


class LedgerError(Exception):
    """Base class for public-safe ledger failures."""


class LedgerCorrupt(LedgerError):
    """The ledger cannot be trusted and must not be reset automatically."""


class LedgerUnavailable(LedgerError):
    """The ledger is temporarily or permanently unavailable for a write."""


_SCHEMA = (
    """
    CREATE TABLE metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    ) STRICT
    """,
    """
    CREATE TABLE policy_revisions (
        revision INTEGER PRIMARY KEY,
        created_at REAL NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        policy_json TEXT NOT NULL
    ) STRICT
    """,
    """
    CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        transition_id TEXT NOT NULL UNIQUE,
        source TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        code TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('firing', 'resolved')),
        transition TEXT NOT NULL,
        occurred_at TEXT,
        event_at REAL NOT NULL,
        received_at REAL NOT NULL,
        normalized_json TEXT NOT NULL
    ) STRICT
    """,
    """
    CREATE TABLE incidents (
        id INTEGER PRIMARY KEY,
        correlation_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN (
            'eligible', 'invoking', 'verifying', 'recovered',
            'recovery_failed', 'recovery_unsafe', 'retries_exhausted'
        )),
        generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
        evidence_hash TEXT NOT NULL,
        policy_revision INTEGER NOT NULL,
        opened_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        FOREIGN KEY (policy_revision) REFERENCES policy_revisions(revision)
    ) STRICT
    """,
    """
    CREATE TABLE invocations (
        id INTEGER PRIMARY KEY,
        incident_id INTEGER NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        evidence_hash TEXT NOT NULL,
        policy_revision INTEGER NOT NULL,
        lease_token TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
            'active', 'interrupted', 'stale', 'completed',
            'recovery_failed', 'recovery_unsafe', 'retries_exhausted'
        )),
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id),
        FOREIGN KEY (policy_revision) REFERENCES policy_revisions(revision),
        UNIQUE (incident_id, generation)
    ) STRICT
    """,
    """
    CREATE TABLE session_bindings (
        id INTEGER PRIMARY KEY,
        incident_id INTEGER NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        evidence_hash TEXT NOT NULL,
        policy_revision INTEGER NOT NULL,
        invocation_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        session_directory TEXT NOT NULL,
        transcript_path TEXT NOT NULL,
        runtime_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('current', 'replaced', 'unreadable')),
        bound_at REAL NOT NULL,
        last_resumed_at REAL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id),
        FOREIGN KEY (invocation_id) REFERENCES invocations(id),
        FOREIGN KEY (policy_revision) REFERENCES policy_revisions(revision),
        UNIQUE (incident_id, generation, session_id),
        UNIQUE (incident_id, generation, transcript_path)
    ) STRICT
    """,
    """
    CREATE TABLE session_replacements (
        id INTEGER PRIMARY KEY,
        incident_id INTEGER NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        previous_binding_id INTEGER NOT NULL UNIQUE,
        replacement_binding_id INTEGER NOT NULL UNIQUE,
        reason TEXT NOT NULL,
        journal_digest TEXT NOT NULL,
        created_at REAL NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id),
        FOREIGN KEY (previous_binding_id) REFERENCES session_bindings(id),
        FOREIGN KEY (replacement_binding_id) REFERENCES session_bindings(id),
        CHECK (previous_binding_id != replacement_binding_id)
    ) STRICT
    """,
    """
    CREATE TABLE action_intents (
        id INTEGER PRIMARY KEY,
        invocation_id INTEGER NOT NULL,
        action_key TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        intent_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'unknown', 'completed', 'reconciled')),
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        FOREIGN KEY (invocation_id) REFERENCES invocations(id),
        UNIQUE (invocation_id, action_key)
    ) STRICT
    """,
    """
    CREATE TABLE action_outcomes (
        id INTEGER PRIMARY KEY,
        action_intent_id INTEGER NOT NULL UNIQUE,
        outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
        outcome_json TEXT NOT NULL,
        created_at REAL NOT NULL,
        FOREIGN KEY (action_intent_id) REFERENCES action_intents(id)
    ) STRICT
    """,
    """
    CREATE TABLE action_reconciliations (
        id INTEGER PRIMARY KEY,
        action_intent_id INTEGER NOT NULL UNIQUE,
        idempotency_key TEXT NOT NULL UNIQUE,
        result TEXT NOT NULL CHECK (result IN ('applied', 'not_applied')),
        details_json TEXT NOT NULL,
        created_at REAL NOT NULL,
        FOREIGN KEY (action_intent_id) REFERENCES action_intents(id)
    ) STRICT
    """,
    """
    CREATE TABLE fixer_claims (
        id INTEGER PRIMARY KEY,
        invocation_id INTEGER NOT NULL UNIQUE,
        incident_id INTEGER NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        evidence_hash TEXT NOT NULL,
        policy_revision INTEGER NOT NULL,
        claim_key TEXT NOT NULL UNIQUE,
        claim_json TEXT NOT NULL,
        claimed_at REAL NOT NULL,
        FOREIGN KEY (invocation_id) REFERENCES invocations(id),
        FOREIGN KEY (incident_id) REFERENCES incidents(id),
        FOREIGN KEY (policy_revision) REFERENCES policy_revisions(revision)
    ) STRICT
    """,
    """
    CREATE TABLE verification_attempts (
        id INTEGER PRIMARY KEY,
        incident_id INTEGER NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        evidence_hash TEXT NOT NULL,
        policy_revision INTEGER NOT NULL,
        invocation_id INTEGER,
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        result TEXT NOT NULL CHECK (result IN ('deferred', 'contradicted', 'recovered', 'failed')),
        reasons_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        started_at REAL NOT NULL,
        completed_at REAL NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id),
        FOREIGN KEY (invocation_id) REFERENCES invocations(id),
        FOREIGN KEY (policy_revision) REFERENCES policy_revisions(revision),
        UNIQUE (incident_id, generation, attempt)
    ) STRICT
    """,
    """
    CREATE TABLE incident_reports (
        id INTEGER PRIMARY KEY,
        report_key TEXT NOT NULL UNIQUE,
        incident_id INTEGER NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        invocation_id INTEGER,
        body_json TEXT NOT NULL,
        created_at REAL NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id),
        FOREIGN KEY (invocation_id) REFERENCES invocations(id),
        UNIQUE (incident_id, generation)
    ) STRICT
    """,
    """
    CREATE TABLE report_outbox (
        id INTEGER PRIMARY KEY,
        report_id INTEGER NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (state IN ('REPORT_PENDING', 'REPORTED')),
        created_at REAL NOT NULL,
        available_at REAL NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        delivered_at REAL,
        FOREIGN KEY (report_id) REFERENCES incident_reports(id)
    ) STRICT
    """,
    """
    CREATE TABLE fixer_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        owner TEXT,
        token TEXT,
        acquired_at REAL,
        expires_at REAL
    ) STRICT
    """,
    """
    CREATE TABLE notification_outbox (
        id INTEGER PRIMARY KEY,
        notification_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at REAL NOT NULL,
        available_at REAL NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        delivered_at REAL
    ) STRICT
    """,
    """
    CREATE TABLE audit (
        id INTEGER PRIMARY KEY,
        occurred_at REAL NOT NULL,
        actor TEXT NOT NULL,
        operation TEXT NOT NULL,
        target TEXT NOT NULL,
        details_json TEXT NOT NULL
    ) STRICT
    """,
    "CREATE INDEX events_latest_source_fingerprint "
    "ON events(source, fingerprint, event_at DESC, status DESC, id DESC)",
    "CREATE INDEX events_received_at ON events(received_at, id)",
    "CREATE INDEX outbox_available ON notification_outbox(delivered_at, available_at, id)",
    "CREATE INDEX sessions_incident_generation "
    "ON session_bindings(incident_id, generation, state, id)",
    "CREATE UNIQUE INDEX session_current_generation "
    "ON session_bindings(incident_id, generation) WHERE state = 'current'",
    "CREATE INDEX action_intents_unresolved "
    "ON action_intents(invocation_id, state, id)",
    "CREATE INDEX verification_attempts_incident "
    "ON verification_attempts(incident_id, generation, attempt)",
    "CREATE INDEX report_outbox_available "
    "ON report_outbox(state, available_at, id)",
)

LATEST_EVENTS_QUERY = """
    SELECT id, source, fingerprint, code, status, transition, occurred_at,
           event_at, received_at, normalized_json
    FROM (
        SELECT id, source, fingerprint, code, status, transition, occurred_at,
               event_at, received_at, normalized_json,
               row_number() OVER (
                   PARTITION BY source, fingerprint
                   ORDER BY event_at DESC, status DESC, id DESC
               ) AS event_rank
        FROM events INDEXED BY events_latest_source_fingerprint
    )
    WHERE event_rank = 1
    ORDER BY source, fingerprint
"""

_RETENTION_CANDIDATES_QUERY = """
    SELECT candidate.id, candidate.received_at
    FROM events AS candidate INDEXED BY events_received_at
    WHERE candidate.received_at < ?
      AND EXISTS (
          SELECT 1
          FROM events AS newer INDEXED BY events_latest_source_fingerprint
          WHERE newer.source = candidate.source
            AND newer.fingerprint = candidate.fingerprint
            AND (
                newer.event_at > candidate.event_at
                OR (
                    newer.event_at = candidate.event_at
                    AND newer.status > candidate.status
                )
                OR (
                    newer.event_at = candidate.event_at
                    AND newer.status = candidate.status
                    AND newer.id > candidate.id
                )
            )
          LIMIT 1
      )
    ORDER BY candidate.received_at, candidate.id
    LIMIT ?
"""


def _canonical_event(event: dict[str, Any]) -> str:
    return json.dumps(event, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def _event_timestamp(
    event: dict[str, Any], received_at: float, fallback_event_at: float | None = None
) -> float:
    occurred_at = event.get("occurred_at")
    if isinstance(occurred_at, str) and occurred_at:
        try:
            parsed = datetime.fromisoformat(occurred_at.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            timestamp = parsed.timestamp()
            if (
                math.isfinite(timestamp)
                and timestamp <= received_at + MAX_EVENT_FUTURE_SKEW_SECONDS
            ):
                return timestamp
        except (OverflowError, ValueError):
            pass
    if (
        fallback_event_at is not None
        and math.isfinite(fallback_event_at)
        and 0 <= fallback_event_at <= received_at + MAX_EVENT_FUTURE_SKEW_SECONDS
    ):
        return fallback_event_at
    return received_at


class RecoveryLedger:
    """One-process connection wrapper with fail-closed startup validation."""

    def __init__(
        self,
        path: Path,
        *,
        busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
        recover_unfinished_actions: bool = False,
    ):
        if not isinstance(busy_timeout_ms, int) or not 1 <= busy_timeout_ms <= 30_000:
            raise ValueError("ledger busy timeout is invalid")
        if not isinstance(recover_unfinished_actions, bool):
            raise ValueError("ledger action recovery setting is invalid")
        self.path = path
        self._recover_unfinished_actions_on_open = recover_unfinished_actions
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        try:
            self._prepare_private_storage()
            connection = sqlite3.connect(
                path,
                timeout=busy_timeout_ms / 1000,
                isolation_level=None,
                check_same_thread=False,
            )
            connection.row_factory = sqlite3.Row
            self._connection = connection
            connection.execute(f"PRAGMA busy_timeout={busy_timeout_ms}")
            connection.execute("PRAGMA foreign_keys=ON")
            journal_mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[0]
            if str(journal_mode).lower() != "wal":
                raise LedgerCorrupt("ledger WAL mode is unavailable")
            connection.execute("PRAGMA synchronous=FULL")
            self._initialize_or_validate()
            self._verify_private_storage()
        except LedgerError:
            self.close()
            raise
        except sqlite3.OperationalError as exc:
            self.close()
            raise LedgerUnavailable("ledger startup is unavailable") from exc
        except (OSError, sqlite3.DatabaseError) as exc:
            self.close()
            raise LedgerCorrupt("ledger startup validation failed") from exc

    @staticmethod
    def _private_directory(path: Path) -> None:
        details = path.lstat()
        if (
            not stat.S_ISDIR(details.st_mode)
            or details.st_uid != os.geteuid()
            or details.st_mode & 0o077
        ):
            raise LedgerCorrupt("ledger directory permissions are unsafe")

    @staticmethod
    def _private_file(path: Path) -> None:
        details = path.lstat()
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.geteuid()
            or details.st_mode & 0o077
        ):
            raise LedgerCorrupt("ledger file permissions are unsafe")

    def _prepare_private_storage(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._private_directory(self.path.parent)
        try:
            self._private_file(self.path)
        except FileNotFoundError:
            descriptor = os.open(
                self.path,
                os.O_CREAT
                | os.O_EXCL
                | os.O_RDWR
                | os.O_CLOEXEC
                | getattr(os, "O_NOFOLLOW", 0),
                0o600,
            )
            try:
                os.fchmod(descriptor, 0o600)
            finally:
                os.close(descriptor)
            self._private_file(self.path)

    def _verify_private_storage(self) -> None:
        self._private_directory(self.path.parent)
        self._private_file(self.path)
        for suffix in ("-wal", "-shm"):
            sidecar = Path(f"{self.path}{suffix}")
            try:
                self._private_file(sidecar)
            except FileNotFoundError:
                continue

    @property
    def connection(self) -> sqlite3.Connection:
        if self._connection is None:
            raise LedgerUnavailable("ledger is closed")
        return self._connection

    def _initialize_or_validate(self) -> None:
        connection = self.connection
        integrity = connection.execute("PRAGMA integrity_check(1)").fetchone()
        if integrity is None or integrity[0] != "ok":
            raise LedgerCorrupt("ledger integrity check failed")
        if connection.execute("PRAGMA foreign_key_check").fetchone() is not None:
            raise LedgerCorrupt("ledger foreign key check failed")

        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
        if not tables:
            self._create_schema()
            tables = EXPECTED_TABLES
        if tables != EXPECTED_TABLES:
            raise LedgerCorrupt("ledger schema is incomplete")
        indexes = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_schema "
                "WHERE type='index' AND sql IS NOT NULL"
            )
        }
        if indexes != EXPECTED_INDEXES:
            raise LedgerCorrupt("ledger indexes are incomplete")
        try:
            version_row = connection.execute(
                "SELECT value FROM metadata WHERE key='schema_version'"
            ).fetchone()
            user_version = connection.execute("PRAGMA user_version").fetchone()[0]
        except sqlite3.DatabaseError as exc:
            raise LedgerCorrupt("ledger schema metadata is invalid") from exc
        if version_row is None or version_row[0] != str(SCHEMA_VERSION) or user_version != SCHEMA_VERSION:
            raise LedgerCorrupt("ledger schema version mismatch")
        if self._recover_unfinished_actions_on_open:
            self.recover_unfinished_actions()

    def recover_unfinished_actions(self) -> None:
        """Turn every crash-window intent into a durable reconciliation gate."""

        connection = self.connection
        now = time.time()
        try:
            connection.execute("BEGIN IMMEDIATE")
            cursor = connection.execute(
                "UPDATE action_intents SET state = 'unknown', updated_at = ? "
                "WHERE state = 'pending'",
                (now,),
            )
            if cursor.rowcount:
                connection.execute(
                    "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                    "VALUES (?, 'system', 'unfinished_actions_unknown', 'action_intents', ?)",
                    (now, _canonical_event({"count": int(cursor.rowcount)})),
                )
            connection.execute("COMMIT")
        except sqlite3.OperationalError as exc:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.DatabaseError:
                pass
            raise LedgerUnavailable("ledger action recovery is unavailable") from exc
        except sqlite3.DatabaseError as exc:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.DatabaseError:
                pass
            raise LedgerCorrupt("ledger action recovery failed") from exc

    def _create_schema(self) -> None:
        connection = self.connection
        now = time.time()
        try:
            connection.execute("BEGIN IMMEDIATE")
            for statement in _SCHEMA:
                connection.execute(statement)
            connection.execute(
                "INSERT INTO metadata(key, value) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )
            connection.execute(
                "INSERT INTO metadata(key, value) VALUES ('effective_policy_revision', '1')"
            )
            connection.execute(
                "INSERT INTO policy_revisions(revision, created_at, actor, reason, policy_json) "
                "VALUES (1, ?, 'system', 'fixed schema initialization', '{}')",
                (now,),
            )
            connection.execute("INSERT INTO fixer_lease(singleton) VALUES (1)")
            connection.execute(f"PRAGMA user_version={SCHEMA_VERSION}")
            connection.execute("COMMIT")
        except sqlite3.OperationalError as exc:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.DatabaseError:
                pass
            raise LedgerUnavailable("ledger schema initialization is unavailable") from exc
        except sqlite3.DatabaseError as exc:
            try:
                connection.execute("ROLLBACK")
            except sqlite3.DatabaseError:
                pass
            raise LedgerCorrupt("ledger schema initialization failed") from exc

    def record_events(
        self,
        events: Iterable[dict[str, Any]],
        *,
        observed_at: float | None = None,
    ) -> int:
        rows = list(events)
        if not rows:
            return 0
        if (
            observed_at is not None
            and (
                isinstance(observed_at, bool)
                or not isinstance(observed_at, (int, float))
                or not math.isfinite(observed_at)
                or observed_at < 0
            )
        ):
            raise LedgerUnavailable("normalized event observation is invalid")
        with self._lock:
            connection = self.connection
            inserted = 0
            last_fallback: float | None = None
            try:
                connection.execute("BEGIN IMMEDIATE")
                for event in rows:
                    received_at = time.time()
                    fallback_event_at: float | None = None
                    if observed_at is not None:
                        fallback_event_at = (
                            float(observed_at)
                            if float(observed_at)
                            <= received_at + MAX_EVENT_FUTURE_SKEW_SECONDS
                            else received_at
                        )
                        if (
                            last_fallback is not None
                            and fallback_event_at <= last_fallback
                        ):
                            fallback_event_at = math.nextafter(
                                last_fallback, math.inf
                            )
                        last_fallback = fallback_event_at
                    cursor = connection.execute(
                        """
                        INSERT OR IGNORE INTO events(
                            transition_id, source, fingerprint, code, status,
                            transition, occurred_at, event_at, received_at, normalized_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            event["transition_id"],
                            event["source"],
                            event["fingerprint"],
                            event["code"],
                            event["status"],
                            event["transition"],
                            event.get("occurred_at"),
                            _event_timestamp(event, received_at, fallback_event_at),
                            received_at,
                            _canonical_event(event),
                        ),
                    )
                    inserted += cursor.rowcount
                connection.execute("COMMIT")
                return inserted
            except (KeyError, TypeError, ValueError) as exc:
                try:
                    connection.execute("ROLLBACK")
                except sqlite3.DatabaseError:
                    pass
                raise LedgerUnavailable("normalized event is invalid") from exc
            except sqlite3.DatabaseError as exc:
                try:
                    connection.execute("ROLLBACK")
                except sqlite3.DatabaseError:
                    pass
                raise LedgerUnavailable("ledger write failed") from exc

    def latest_events(
        self, connection: sqlite3.Connection | None = None
    ) -> list[sqlite3.Row]:
        """Return the one semantic latest state required for every event identity."""

        with self._lock:
            current = self.connection if connection is None else connection
            try:
                return current.execute(LATEST_EVENTS_QUERY).fetchall()
            except sqlite3.DatabaseError as exc:
                raise LedgerUnavailable("ledger latest-event lookup failed") from exc

    def prune_event_history(
        self,
        *,
        now: float | None = None,
        retention_seconds: float = DEFAULT_EVENT_RETENTION_SECONDS,
        batch_size: int = DEFAULT_EVENT_RETENTION_BATCH_SIZE,
    ) -> int:
        """Transactionally prune one bounded batch of old, superseded events."""

        timestamp = time.time() if now is None else now
        if (
            isinstance(timestamp, bool)
            or not isinstance(timestamp, (int, float))
            or not math.isfinite(timestamp)
            or isinstance(retention_seconds, bool)
            or not isinstance(retention_seconds, (int, float))
            or not math.isfinite(retention_seconds)
            or retention_seconds < 1
            or isinstance(batch_size, bool)
            or not isinstance(batch_size, int)
            or not 1 <= batch_size <= 10_000
        ):
            raise ValueError("event retention settings are invalid")
        cutoff = float(timestamp) - float(retention_seconds)
        with self.transaction() as connection:
            candidates = connection.execute(
                _RETENTION_CANDIDATES_QUERY,
                (cutoff, batch_size),
            ).fetchall()
            if not candidates:
                return 0
            identifiers = [int(row["id"]) for row in candidates]
            placeholders = ",".join("?" for _identifier in identifiers)
            cursor = connection.execute(
                f"DELETE FROM events WHERE id IN ({placeholders})",
                identifiers,
            )
            if cursor.rowcount != len(identifiers):
                raise LedgerCorrupt("event retention delete was incomplete")
            connection.execute(
                "INSERT INTO audit(occurred_at, actor, operation, target, details_json) "
                "VALUES (?, 'system', 'event_history_pruned', 'events', ?)",
                (
                    float(timestamp),
                    _canonical_event(
                        {
                            "batch_limit": batch_size,
                            "cutoff_received_at": cutoff,
                            "deleted": len(identifiers),
                            "retention_seconds": float(retention_seconds),
                        }
                    ),
                ),
            )
            return len(identifiers)

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Serialize a durable state transition and translate SQLite failures."""

        with self._lock:
            connection = self.connection
            try:
                connection.execute("BEGIN IMMEDIATE")
                yield connection
                connection.execute("COMMIT")
            except LedgerError:
                try:
                    connection.execute("ROLLBACK")
                except sqlite3.DatabaseError:
                    pass
                raise
            except sqlite3.DatabaseError as exc:
                try:
                    connection.execute("ROLLBACK")
                except sqlite3.DatabaseError:
                    pass
                raise LedgerUnavailable("ledger transaction failed") from exc
            except Exception:
                try:
                    connection.execute("ROLLBACK")
                except sqlite3.DatabaseError:
                    pass
                raise

    def ping(self) -> None:
        with self._lock:
            try:
                self._verify_private_storage()
                row = self.connection.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
            except LedgerCorrupt:
                raise
            except sqlite3.DatabaseError as exc:
                raise LedgerUnavailable("ledger health check failed") from exc
            if row is None or row[0] != str(SCHEMA_VERSION):
                raise LedgerCorrupt("ledger schema version mismatch")

    def close(self) -> None:
        connection, self._connection = self._connection, None
        if connection is not None:
            connection.close()

    def __enter__(self) -> "RecoveryLedger":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()
