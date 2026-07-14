#!/usr/bin/env python3
"""Fixed-schema, standard-library SQLite ledger for local recovery intake."""

from __future__ import annotations

from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import threading
import time
from typing import Any, Iterable, Iterator

SCHEMA_VERSION = 1
DEFAULT_BUSY_TIMEOUT_MS = 2_000
EXPECTED_TABLES = {
    "actions",
    "audit",
    "events",
    "fixer_lease",
    "incidents",
    "invocations",
    "metadata",
    "notification_outbox",
    "policy_revisions",
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
        received_at REAL NOT NULL,
        normalized_json TEXT NOT NULL
    ) STRICT
    """,
    """
    CREATE TABLE incidents (
        id INTEGER PRIMARY KEY,
        correlation_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL,
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
        state TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        FOREIGN KEY (incident_id) REFERENCES incidents(id),
        FOREIGN KEY (policy_revision) REFERENCES policy_revisions(revision),
        UNIQUE (incident_id, generation)
    ) STRICT
    """,
    """
    CREATE TABLE actions (
        id INTEGER PRIMARY KEY,
        invocation_id INTEGER NOT NULL,
        runbook_id TEXT NOT NULL,
        state TEXT NOT NULL,
        started_at REAL,
        finished_at REAL,
        result_code TEXT,
        FOREIGN KEY (invocation_id) REFERENCES invocations(id)
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
    "CREATE INDEX events_source_fingerprint ON events(source, fingerprint, id)",
    "CREATE INDEX outbox_available ON notification_outbox(delivered_at, available_at, id)",
)


def _canonical_event(event: dict[str, Any]) -> str:
    return json.dumps(event, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


class RecoveryLedger:
    """One-process connection wrapper with fail-closed startup validation."""

    def __init__(self, path: Path, *, busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS):
        if not isinstance(busy_timeout_ms, int) or not 1 <= busy_timeout_ms <= 30_000:
            raise ValueError("ledger busy timeout is invalid")
        self.path = path
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
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
        except LedgerError:
            self.close()
            raise
        except sqlite3.OperationalError as exc:
            self.close()
            raise LedgerUnavailable("ledger startup is unavailable") from exc
        except (OSError, sqlite3.DatabaseError) as exc:
            self.close()
            raise LedgerCorrupt("ledger startup validation failed") from exc

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
        try:
            version_row = connection.execute(
                "SELECT value FROM metadata WHERE key='schema_version'"
            ).fetchone()
            user_version = connection.execute("PRAGMA user_version").fetchone()[0]
        except sqlite3.DatabaseError as exc:
            raise LedgerCorrupt("ledger schema metadata is invalid") from exc
        if version_row is None or version_row[0] != str(SCHEMA_VERSION) or user_version != SCHEMA_VERSION:
            raise LedgerCorrupt("ledger schema version mismatch")

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

    def record_events(self, events: Iterable[dict[str, Any]]) -> int:
        rows = list(events)
        if not rows:
            return 0
        with self._lock:
            connection = self.connection
            inserted = 0
            try:
                connection.execute("BEGIN IMMEDIATE")
                for event in rows:
                    cursor = connection.execute(
                        """
                        INSERT OR IGNORE INTO events(
                            transition_id, source, fingerprint, code, status,
                            transition, occurred_at, received_at, normalized_json
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            event["transition_id"],
                            event["source"],
                            event["fingerprint"],
                            event["code"],
                            event["status"],
                            event["transition"],
                            event.get("occurred_at"),
                            time.time(),
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

    def add_policy_revision(
        self,
        revision: int,
        policy: dict[str, Any],
        *,
        actor: str = "operator",
        reason: str = "configured policy",
        now: float | None = None,
    ) -> None:
        """Add an immutable policy revision for later invocation fencing."""

        if not isinstance(revision, int) or revision < 1:
            raise ValueError("policy revision is invalid")
        document = _canonical_event(policy)
        with self.transaction() as connection:
            existing = connection.execute(
                "SELECT policy_json FROM policy_revisions WHERE revision = ?",
                (revision,),
            ).fetchone()
            if existing is not None:
                if existing[0] != document:
                    raise LedgerCorrupt("policy revision is immutable")
                return
            connection.execute(
                "INSERT INTO policy_revisions(revision, created_at, actor, reason, policy_json) "
                "VALUES (?, ?, ?, ?, ?)",
                (revision, time.time() if now is None else now, actor, reason, document),
            )

    def ping(self) -> None:
        with self._lock:
            try:
                row = self.connection.execute("SELECT value FROM metadata WHERE key='schema_version'").fetchone()
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
