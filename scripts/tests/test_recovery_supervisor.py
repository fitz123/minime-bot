from __future__ import annotations

import http.client
import json
import os
from pathlib import Path
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import monitoring_native
import recovery_config
import recovery_ledger
import recovery_supervisor
import runtime_doctor


def alert_body(*alerts: dict[str, object]) -> bytes:
    return json.dumps({"alerts": list(alerts)}, separators=(",", ":")).encode("utf-8")


def firing_alert(
    fingerprint: str = "synthetic-1",
    *,
    starts_at: str = "2026-07-14T00:00:00Z",
    component: str = "synthetic",
    failure_class: str = "unavailable",
    alertname: str = "SyntheticDown",
) -> dict[str, object]:
    return {
        "status": "firing",
        "fingerprint": fingerprint,
        "startsAt": starts_at,
        "labels": {
            "alertname": alertname,
            "component": component,
            "failure_class": failure_class,
            "instance": "test",
        },
        "annotations": {"private_payload": "must not be persisted"},
    }


def resolved_alert(
    fingerprint: str = "synthetic-1",
    *,
    starts_at: str = "2026-07-14T00:00:00Z",
    ends_at: str = "2026-07-14T00:10:00Z",
) -> dict[str, object]:
    alert = firing_alert(fingerprint, starts_at=starts_at)
    alert["status"] = "resolved"
    alert["endsAt"] = ends_at
    return alert


def doctor_events(*events: tuple[str, str, str]) -> list[dict[str, object]]:
    payload: list[dict[str, str]] = []
    for code, status, transition in events:
        payload.append(
            {
                "code": code,
                "status": status,
                "transition": transition,
                "transition_id": recovery_supervisor.transition_id(
                    "runtime_doctor", code, status, transition
                ),
            }
        )
    return recovery_supervisor.normalize_runtime_doctor(
        json.dumps({"version": 1, "events": payload}, separators=(",", ":")).encode()
    )


def history_event(
    fingerprint: str,
    status: str,
    occurred_at: str,
) -> dict[str, object]:
    return recovery_supervisor._normalized_event(
        source="alertmanager",
        fingerprint=fingerprint,
        code="SyntheticDown",
        status=status,
        transition=occurred_at,
        occurred_at=occurred_at,
        component="synthetic",
        failure_class="unavailable",
    )


def correlation_policy(
    *,
    lease_seconds: float = 30,
) -> recovery_supervisor.RecoveryPolicy:
    return recovery_supervisor.RecoveryPolicy(
        revision=1,
        rules=(
            recovery_supervisor.CorrelationRule(
                "synthetic", "unavailable", "bot-unavailable", impact=2
            ),
            recovery_supervisor.CorrelationRule(
                "runtime", "node_unavailable", "bot-unavailable", impact=3
            ),
        ),
        lease_seconds=lease_seconds,
    )


class FailingLedger:
    def record_events(
        self, _events: object, *, observed_at: float | None = None
    ) -> int:
        del observed_at
        raise recovery_ledger.LedgerUnavailable("database or disk is full")

    def ping(self) -> None:
        raise recovery_ledger.LedgerUnavailable("database unavailable")


class RecoveryLedgerTests(unittest.TestCase):
    def test_fixed_schema_pragmas_and_restart_idempotency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.sqlite3"
            events = recovery_supervisor.normalize_alertmanager(
                alert_body(firing_alert("one"), firing_alert("two"))
            )
            ledger = recovery_ledger.RecoveryLedger(path)
            self.assertEqual(
                {
                    row[0]
                    for row in ledger.connection.execute(
                        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    )
                },
                recovery_ledger.EXPECTED_TABLES,
            )
            self.assertEqual(ledger.connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")
            self.assertEqual(ledger.connection.execute("PRAGMA synchronous").fetchone()[0], 2)
            self.assertEqual(ledger.connection.execute("PRAGMA foreign_keys").fetchone()[0], 1)
            self.assertGreater(ledger.connection.execute("PRAGMA busy_timeout").fetchone()[0], 0)
            self.assertEqual(
                {
                    row[0]
                    for row in ledger.connection.execute(
                        "SELECT name FROM sqlite_schema "
                        "WHERE type='index' AND sql IS NOT NULL"
                    )
                },
                recovery_ledger.EXPECTED_INDEXES,
            )
            self.assertEqual(ledger.record_events(events), 2)
            self.assertEqual(ledger.record_events(events[:1]), 0)
            ledger.close()

            reopened = recovery_ledger.RecoveryLedger(path)
            self.assertEqual(reopened.record_events(events), 0)
            self.assertEqual(reopened.connection.execute("SELECT count(*) FROM events").fetchone()[0], 2)
            stored = reopened.connection.execute("SELECT normalized_json FROM events ORDER BY id").fetchall()
            self.assertTrue(all("private_payload" not in row[0] for row in stored))
            reopened.close()

    def test_ledger_storage_is_owner_only_and_rejects_unsafe_paths(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private = root / "private"
            path = private / "ledger.sqlite3"
            with recovery_ledger.RecoveryLedger(path):
                self.assertEqual(private.stat().st_mode & 0o777, 0o700)
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                for suffix in ("-wal", "-shm"):
                    sidecar = Path(f"{path}{suffix}")
                    if sidecar.exists():
                        self.assertEqual(sidecar.stat().st_mode & 0o777, 0o600)

            unsafe_directory = root / "unsafe-directory"
            unsafe_directory.mkdir()
            unsafe_directory.chmod(0o755)
            with self.assertRaises(recovery_ledger.LedgerCorrupt):
                recovery_ledger.RecoveryLedger(
                    unsafe_directory / "ledger.sqlite3"
                )

            unsafe_file = root / "unsafe.sqlite3"
            unsafe_file.write_bytes(b"")
            unsafe_file.chmod(0o644)
            with self.assertRaises(recovery_ledger.LedgerCorrupt):
                recovery_ledger.RecoveryLedger(unsafe_file)

            target = root / "target.sqlite3"
            target.write_bytes(b"")
            target.chmod(0o600)
            link = root / "link.sqlite3"
            link.symlink_to(target)
            with self.assertRaises(recovery_ledger.LedgerCorrupt):
                recovery_ledger.RecoveryLedger(link)

    def test_implausible_future_event_time_cannot_mask_later_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                future = recovery_supervisor.normalize_alertmanager(
                    alert_body(
                        firing_alert(
                            "future-skew", starts_at="2100-01-01T00:00:00Z"
                        )
                    )
                )
                resolved = recovery_supervisor.normalize_alertmanager(
                    alert_body(
                        resolved_alert(
                            "future-skew",
                            starts_at="1970-01-01T00:16:40Z",
                            ends_at="1970-01-01T00:16:41Z",
                        )
                    )
                )
                with mock.patch.object(
                    recovery_ledger.time, "time", return_value=1000.0
                ):
                    ledger.record_events(future)
                    ledger.record_events(resolved)
                future_row = ledger.connection.execute(
                    "SELECT event_at FROM events WHERE status = 'firing'"
                ).fetchone()
                self.assertEqual(future_row[0], 1000.0)
                self.assertEqual(ledger.latest_events()[0]["status"], "resolved")

    def test_schema_mismatch_corruption_and_lock_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_path = root / "version.sqlite3"
            with recovery_ledger.RecoveryLedger(version_path) as ledger:
                ledger.connection.execute(
                    f"PRAGMA user_version={recovery_ledger.SCHEMA_VERSION + 1}"
                )
            with self.assertRaises(recovery_ledger.LedgerCorrupt):
                recovery_ledger.RecoveryLedger(version_path)

            index_path = root / "index.sqlite3"
            with recovery_ledger.RecoveryLedger(index_path) as ledger:
                ledger.connection.execute("DROP INDEX events_received_at")
            with self.assertRaises(recovery_ledger.LedgerCorrupt):
                recovery_ledger.RecoveryLedger(index_path)

            corrupt_path = root / "corrupt.sqlite3"
            corrupt_path.write_bytes(b"not a sqlite database")
            with self.assertRaises(recovery_ledger.LedgerCorrupt):
                recovery_ledger.RecoveryLedger(corrupt_path)
            self.assertEqual(corrupt_path.read_bytes(), b"not a sqlite database")

            lock_path = root / "locked.sqlite3"
            ledger = recovery_ledger.RecoveryLedger(lock_path, busy_timeout_ms=5)
            locker = sqlite3.connect(lock_path, isolation_level=None)
            locker.execute("BEGIN IMMEDIATE")
            try:
                with self.assertRaises(recovery_ledger.LedgerUnavailable):
                    ledger.record_events(
                        recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                    )
                with self.assertRaises(recovery_ledger.LedgerUnavailable):
                    ledger.prune_event_history(now=10, retention_seconds=1)
            finally:
                locker.execute("ROLLBACK")
                locker.close()
                ledger.close()

    def test_retention_is_bounded_audited_and_preserves_restart_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "ledger.sqlite3"
            ledger = recovery_ledger.RecoveryLedger(path)
            active_latest = history_event(
                "active", "firing", "2026-02-01T00:00:00Z"
            )
            active_history = [
                history_event(
                    "active",
                    "firing" if index % 2 == 0 else "resolved",
                    f"2026-01-01T{index // 3600:02d}:{(index // 60) % 60:02d}:{index % 60:02d}Z",
                )
                for index in range(300)
            ]
            resolved_latest = history_event(
                "resolved", "resolved", "2026-02-01T00:00:00Z"
            )
            resolved_history = [
                history_event(
                    "resolved",
                    "firing" if index % 2 == 0 else "resolved",
                    f"2026-01-01T00:00:0{index}Z",
                )
                for index in range(4)
            ]
            # Deliberately receive semantic latest state before older history.
            with mock.patch.object(
                recovery_ledger.time, "time", return_value=1_769_990_400.0
            ):
                self.assertEqual(
                    ledger.record_events(
                        [active_latest, *active_history, resolved_latest, *resolved_history]
                    ),
                    306,
                )

            coordinator = recovery_supervisor.IncidentCoordinator(
                ledger,
                correlation_policy(),
                owner="retention-test",
                clock=lambda: 2_000_000_000.0,
            )
            self.assertEqual(coordinator.reconcile(), 1)
            incident_before = ledger.connection.execute(
                "SELECT evidence_hash, generation, state FROM incidents"
            ).fetchone()
            assert incident_before is not None
            active_latest_id = int(
                ledger.connection.execute(
                    "SELECT id FROM events WHERE transition_id = ?",
                    (active_latest["transition_id"],),
                ).fetchone()[0]
            )

            service = recovery_supervisor.RecoveryService(
                ledger,
                recovery_supervisor.AtomicJsonSpool(root / "events"),
                recovery_supervisor.EmergencyNotifier(root / "notifications", delivery=None),
                coordinator=coordinator,
                event_retention_seconds=1,
                event_retention_batch_size=128,
            )
            service.maintenance()
            self.assertEqual(
                ledger.connection.execute("SELECT count(*) FROM events").fetchone()[0],
                178,
            )
            service.maintenance()
            self.assertEqual(
                ledger.connection.execute("SELECT count(*) FROM events").fetchone()[0],
                50,
            )
            service.maintenance()
            self.assertEqual(
                ledger.connection.execute("SELECT count(*) FROM events").fetchone()[0],
                2,
            )
            self.assertIsNotNone(
                ledger.connection.execute(
                    "SELECT 1 FROM events WHERE id = ?", (active_latest_id,)
                ).fetchone()
            )
            self.assertEqual(
                {
                    (str(row["fingerprint"]), str(row["status"]))
                    for row in ledger.latest_events()
                },
                {("active", "firing"), ("resolved", "resolved")},
            )
            audits = ledger.connection.execute(
                "SELECT details_json FROM audit "
                "WHERE operation = 'event_history_pruned' ORDER BY id"
            ).fetchall()
            self.assertEqual(
                [json.loads(row[0])["deleted"] for row in audits],
                [128, 128, 48],
            )
            self.assertTrue(
                all(json.loads(row[0])["batch_limit"] == 128 for row in audits)
            )
            incident_after = ledger.connection.execute(
                "SELECT evidence_hash, generation, state FROM incidents"
            ).fetchone()
            self.assertEqual(tuple(incident_after), tuple(incident_before))
            ledger.close()

            with recovery_ledger.RecoveryLedger(path) as reopened:
                restarted = recovery_supervisor.IncidentCoordinator(
                    reopened,
                    correlation_policy(),
                    owner="retention-restart-test",
                    clock=lambda: 2_000_000_001.0,
                )
                self.assertEqual(restarted.reconcile(), 1)
                incident_restarted = reopened.connection.execute(
                    "SELECT evidence_hash, generation, state FROM incidents"
                ).fetchone()
                self.assertEqual(tuple(incident_restarted), tuple(incident_before))

    def test_retention_uses_indexes_and_rolls_back_on_audit_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.sqlite3"
            with recovery_ledger.RecoveryLedger(path) as ledger:
                with mock.patch.object(recovery_ledger.time, "time", return_value=0.0):
                    ledger.record_events(
                        [
                            history_event("indexed", "firing", "1970-01-01T00:00:02Z"),
                            history_event("indexed", "resolved", "1970-01-01T00:00:01Z"),
                        ]
                    )
                latest_plan = ledger.connection.execute(
                    "EXPLAIN QUERY PLAN " + recovery_ledger.LATEST_EVENTS_QUERY
                ).fetchall()
                retention_plan = ledger.connection.execute(
                    "EXPLAIN QUERY PLAN " + recovery_ledger._RETENTION_CANDIDATES_QUERY,
                    (1.0, 1),
                ).fetchall()
                latest_details = " ".join(str(row[3]) for row in latest_plan)
                retention_details = " ".join(str(row[3]) for row in retention_plan)
                self.assertIn("events_latest_source_fingerprint", latest_details)
                self.assertIn("events_received_at", retention_details)
                self.assertIn("events_latest_source_fingerprint", retention_details)

                ledger.connection.execute(
                    "CREATE TRIGGER fail_retention_audit "
                    "BEFORE INSERT ON audit "
                    "WHEN NEW.operation = 'event_history_pruned' "
                    "BEGIN SELECT RAISE(FAIL, 'database or disk is full'); END"
                )
                with self.assertRaises(recovery_ledger.LedgerUnavailable):
                    ledger.prune_event_history(now=2.0, retention_seconds=1, batch_size=1)
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM events").fetchone()[0],
                    2,
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM audit "
                        "WHERE operation = 'event_history_pruned'"
                    ).fetchone()[0],
                    0,
                )
                ledger.connection.execute("DROP TRIGGER fail_retention_audit")
                ledger.connection.execute(
                    "UPDATE events SET normalized_json = '{}' WHERE status = 'firing'"
                )
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(),
                    owner="corrupt-retention-test",
                    clock=lambda: 2.0,
                )
                service = recovery_supervisor.RecoveryService(
                    ledger,
                    recovery_supervisor.AtomicJsonSpool(Path(directory) / "events"),
                    recovery_supervisor.EmergencyNotifier(
                        Path(directory) / "notifications", delivery=None
                    ),
                    coordinator=coordinator,
                    event_retention_seconds=1,
                    event_retention_batch_size=1,
                )
                service.maintenance()
                self.assertEqual(service.health().status, 503)
            with recovery_ledger.RecoveryLedger(path) as reopened:
                self.assertEqual(
                    reopened.connection.execute("SELECT count(*) FROM events").fetchone()[0],
                    2,
                )
                self.assertEqual(
                    reopened.connection.execute(
                        "SELECT count(*) FROM audit "
                        "WHERE operation = 'event_history_pruned'"
                    ).fetchone()[0],
                    0,
                )


class RecoveryServiceTests(unittest.TestCase):
    def test_lost_ack_retry_and_overlapping_batches_commit_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = recovery_ledger.RecoveryLedger(root / "ledger.sqlite3")
            emergency = recovery_supervisor.EmergencyNotifier(
                root / "notifications", delivery=lambda _message: None, cooldown=0
            )
            service = recovery_supervisor.RecoveryService(
                ledger,
                recovery_supervisor.AtomicJsonSpool(root / "events"),
                emergency,
            )
            first = recovery_supervisor.normalize_alertmanager(
                alert_body(firing_alert("one"), firing_alert("two"))
            )
            overlap = recovery_supervisor.normalize_alertmanager(
                alert_body(firing_alert("two"), firing_alert("three"))
            )
            self.assertEqual(service.accept(first).status, 200)
            self.assertEqual(service.accept(first).text, "duplicate")
            self.assertEqual(service.accept(overlap).status, 200)
            self.assertEqual(ledger.connection.execute("SELECT count(*) FROM events").fetchone()[0], 3)
            ledger.close()

    def test_full_ledger_spools_then_drains_and_total_failure_is_retryable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            messages: list[str] = []
            emergency = recovery_supervisor.EmergencyNotifier(
                root / "notifications", delivery=messages.append, cooldown=0
            )
            event_spool = recovery_supervisor.AtomicJsonSpool(root / "events")
            service = recovery_supervisor.RecoveryService(FailingLedger(), event_spool, emergency)  # type: ignore[arg-type]
            events = recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
            result = service.accept(events)
            self.assertEqual((result.status, result.text), (202, "durably spooled"))
            self.assertEqual(len(list((root / "events").glob("*.json"))), 1)
            self.assertEqual(messages, [])
            emergency.drain()
            self.assertEqual(len(messages), 1)
            self.assertNotIn("SyntheticDown", messages[0])

            ledger = recovery_ledger.RecoveryLedger(root / "ledger.sqlite3")
            recovered = recovery_supervisor.RecoveryService(ledger, event_spool, emergency)
            self.assertEqual(recovered.health().status, 200)
            self.assertEqual(ledger.connection.execute("SELECT count(*) FROM events").fetchone()[0], 1)
            self.assertEqual(list((root / "events").glob("*.json")), [])
            ledger.close()

            blocker = root / "blocked"
            blocker.write_text("not a directory", encoding="utf-8")
            failed = recovery_supervisor.RecoveryService(
                FailingLedger(),  # type: ignore[arg-type]
                recovery_supervisor.AtomicJsonSpool(blocker / "events"),
                emergency,
            ).accept(events)
            self.assertEqual(failed.status, 503)
            emergency.drain()
            self.assertIn("spool validation failed", messages[-1].lower())
            self.assertNotIn("SyntheticDown", messages[-1])

    def test_event_spool_rejects_unsafe_directories_and_items(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            private_spool = recovery_supervisor.AtomicJsonSpool(root / "private-events")
            private_spool.put("safe", {"version": 1})
            self.assertEqual(private_spool.path.stat().st_mode & 0o777, 0o700)
            [(item_path, _value)] = private_spool.items()
            self.assertEqual(item_path.stat().st_mode & 0o777, 0o600)

            unsafe_directory = root / "unsafe-events"
            unsafe_directory.mkdir()
            unsafe_directory.chmod(0o755)
            with self.assertRaises(recovery_supervisor.SpoolError):
                recovery_supervisor.AtomicJsonSpool(unsafe_directory).items()

            attacker_directory = root / "attacker-events"
            attacker_directory.mkdir(mode=0o700)
            linked_directory = root / "linked-events"
            linked_directory.symlink_to(attacker_directory, target_is_directory=True)
            with self.assertRaises(recovery_supervisor.SpoolError):
                recovery_supervisor.AtomicJsonSpool(linked_directory).put(
                    "unsafe", {"version": 1}
                )

            unsafe_item_spool = recovery_supervisor.AtomicJsonSpool(root / "unsafe-items")
            unsafe_item_spool.path.mkdir(mode=0o700)
            unsafe_item = unsafe_item_spool.path / "unsafe.json"
            unsafe_item.write_text("{}", encoding="ascii")
            unsafe_item.chmod(0o644)
            with self.assertRaises(recovery_supervisor.SpoolError):
                unsafe_item_spool.items()

            unsafe_item.unlink()
            target = root / "target.json"
            target.write_text("{}", encoding="ascii")
            target.chmod(0o600)
            unsafe_item.symlink_to(target)
            with self.assertRaises(recovery_supervisor.SpoolError):
                unsafe_item_spool.items()

    def test_symlinked_event_spool_cannot_inject_authenticated_intake(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            attacker_directory = root / "attacker-events"
            attacker_directory.mkdir(mode=0o700)
            event_spool_path = root / "events"
            event_spool_path.symlink_to(attacker_directory, target_is_directory=True)
            event = recovery_supervisor._normalized_event(
                source="runtime_doctor",
                fingerprint="node_unavailable",
                code="node_unavailable",
                status="firing",
                transition="forged-transition",
                occurred_at=None,
                component="runtime",
                failure_class="node_unavailable",
            )
            envelope = recovery_supervisor.RecoveryService._intake_envelope(
                [event], None
            )
            forged = attacker_directory / "forged.json"
            forged.write_text(json.dumps(envelope), encoding="ascii")
            forged.chmod(0o600)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                service = recovery_supervisor.RecoveryService(
                    ledger,
                    recovery_supervisor.AtomicJsonSpool(event_spool_path),
                    recovery_supervisor.EmergencyNotifier(
                        root / "notifications", delivery=None
                    ),
                )
                self.assertEqual(service.health().status, 503)
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM events").fetchone()[0],
                    0,
                )

    def test_request_path_only_spools_emergency_delivery(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            attempts: list[str] = []

            def unavailable(message: str) -> None:
                attempts.append(message)
                raise monitoring_native.DeliveryError("synthetic native outage")

            emergency = recovery_supervisor.EmergencyNotifier(
                root / "notifications", delivery=unavailable, cooldown=0
            )
            service = recovery_supervisor.RecoveryService(
                FailingLedger(),  # type: ignore[arg-type]
                recovery_supervisor.AtomicJsonSpool(root / "events"),
                emergency,
            )
            events = recovery_supervisor.normalize_alertmanager(
                alert_body(firing_alert())
            )
            self.assertEqual(service.accept(events).status, 202)
            self.assertEqual(attempts, [])
            emergency.drain()
            self.assertEqual(len(attempts), 1)

    def test_spool_replay_uses_durable_observation_order_and_event_time(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spool = recovery_supervisor.AtomicJsonSpool(root / "events")
            firing = recovery_supervisor._normalized_event(
                source="runtime_doctor",
                fingerprint="node_unavailable",
                code="node_unavailable",
                status="firing",
                transition="firing-transition",
                occurred_at=None,
                component="runtime",
                failure_class="node_unavailable",
            )
            resolved = recovery_supervisor._normalized_event(
                source="runtime_doctor",
                fingerprint="node_unavailable",
                code="node_unavailable",
                status="resolved",
                transition="resolved-transition",
                occurred_at=None,
                component="runtime",
                failure_class="node_unavailable",
            )
            first_key, second_key = "spool-first", "spool-second"
            if spool.path_for_key(first_key).name < spool.path_for_key(second_key).name:
                first_key, second_key = second_key, first_key
            spool.put(
                first_key,
                {
                    "version": 1,
                    "events": [firing],
                    "heartbeats": {"runtime_doctor": True},
                    "observed_at": 100.0,
                },
            )
            spool.put(
                second_key,
                {
                    "version": 1,
                    "events": [resolved],
                    "heartbeats": {"runtime_doctor": True},
                    "observed_at": 200.0,
                },
            )
            self.assertGreater(
                spool.path_for_key(first_key).name,
                spool.path_for_key(second_key).name,
            )

            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                service = recovery_supervisor.RecoveryService(
                    ledger,
                    spool,
                    recovery_supervisor.EmergencyNotifier(
                        root / "notifications", delivery=None
                    ),
                )
                self.assertEqual(service.health().status, 200)
                rows = ledger.connection.execute(
                    "SELECT status, event_at FROM events ORDER BY event_at"
                ).fetchall()
                self.assertEqual(
                    [(row["status"], row["event_at"]) for row in rows],
                    [("firing", 100.0), ("resolved", 200.0)],
                )
                self.assertEqual(ledger.latest_events()[0]["status"], "resolved")
                self.assertEqual(spool.items(), [])

    def test_heartbeat_only_intake_is_spooled_until_heartbeat_persists(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="supervisor-one"
                )
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    source_ids=("runtime_doctor",),
                    cadence_seconds=300,
                    freshness_seconds=660,
                    hold_down_seconds=60,
                )
                event_spool = recovery_supervisor.AtomicJsonSpool(root / "events")
                emergency = recovery_supervisor.EmergencyNotifier(
                    root / "notifications", delivery=None
                )
                service = recovery_supervisor.RecoveryService(
                    ledger,
                    event_spool,
                    emergency,
                    coordinator=coordinator,
                    verifier=verifier,
                )
                with mock.patch.object(
                    verifier,
                    "record_heartbeat",
                    side_effect=recovery_ledger.LedgerUnavailable("synthetic heartbeat failure"),
                ):
                    result = service.accept(
                        [], heartbeats={"runtime_doctor": False}
                    )
                self.assertEqual((result.status, result.text), (202, "durably spooled"))
                self.assertEqual(len(event_spool.items()), 1)
                self.assertIsNone(
                    ledger.connection.execute(
                        "SELECT value FROM metadata "
                        "WHERE key = 'verification:heartbeat:runtime_doctor'"
                    ).fetchone()
                )

                self.assertEqual(service.health().status, 200)
                self.assertEqual(event_spool.items(), [])
                observation = json.loads(
                    ledger.connection.execute(
                        "SELECT value FROM metadata "
                        "WHERE key = 'verification:heartbeat:runtime_doctor'"
                    ).fetchone()[0]
                )
                self.assertFalse(observation["healthy"])

    def test_heartbeat_spool_and_ledger_keep_newest_conservative_observation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="heartbeat-order"
                )
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    source_ids=("runtime_doctor",),
                    cadence_seconds=300,
                    freshness_seconds=660,
                    hold_down_seconds=60,
                )
                event_spool = recovery_supervisor.AtomicJsonSpool(root / "events")
                service = recovery_supervisor.RecoveryService(
                    ledger,
                    event_spool,
                    recovery_supervisor.EmergencyNotifier(
                        root / "notifications", delivery=None
                    ),
                    coordinator=coordinator,
                    verifier=verifier,
                )
                with mock.patch.object(
                    verifier,
                    "record_heartbeat",
                    side_effect=recovery_ledger.LedgerUnavailable("synthetic outage"),
                ), mock.patch.object(
                    service,
                    "_intake_envelope",
                    side_effect=(
                        {
                            "version": 1,
                            "events": [],
                            "heartbeats": {"runtime_doctor": True},
                            "observed_at": 100.0,
                        },
                        {
                            "version": 1,
                            "events": [],
                            "heartbeats": {"runtime_doctor": True},
                            "observed_at": 200.0,
                        },
                    ),
                ):
                    self.assertEqual(
                        service.accept(
                            [], heartbeats={"runtime_doctor": True}
                        ).status,
                        202,
                    )
                    self.assertEqual(
                        service.accept(
                            [], heartbeats={"runtime_doctor": True}
                        ).status,
                        202,
                    )
                queued = event_spool.items()
                self.assertEqual(len(queued), 1)
                self.assertEqual(queued[0][1]["observed_at"], 200.0)
                self.assertEqual(service.health().status, 200)

                verifier.record_heartbeat(
                    "runtime_doctor", healthy=False, observed_at=300.0
                )
                verifier.record_heartbeat(
                    "runtime_doctor", healthy=True, observed_at=250.0
                )
                verifier.record_heartbeat(
                    "runtime_doctor", healthy=True, observed_at=300.0
                )
                self.assertEqual(
                    verifier._observation(
                        ledger.connection,
                        "verification:heartbeat:runtime_doctor",
                    ),
                    (False, 300.0),
                )
                verifier.record_heartbeat(
                    "runtime_doctor", healthy=True, observed_at=301.0
                )
                self.assertEqual(
                    verifier._observation(
                        ledger.connection,
                        "verification:heartbeat:runtime_doctor",
                    ),
                    (True, 301.0),
                )

    def test_emergency_delivery_is_atomic_throttled_and_drained(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            delivered: list[str] = []
            attempts = [0]
            available = False

            def delivery(message: str) -> None:
                attempts[0] += 1
                if not available:
                    raise monitoring_native.DeliveryError("synthetic outage")
                delivered.append(message)

            notifier = recovery_supervisor.EmergencyNotifier(
                root / "notifications", delivery=delivery, cooldown=300, clock=lambda: 1_000
            )
            notifier.emit("ledger_corrupt")
            self.assertEqual(len(list((root / "notifications").glob("*.json"))), 1)
            self.assertEqual(attempts[0], 0)
            available = True
            notifier.drain()
            self.assertEqual(len(delivered), 1)
            self.assertEqual(list((root / "notifications").glob("*.json")), [])
            notifier.emit("ledger_corrupt")
            self.assertEqual(len(delivered), 1)

    def test_notification_outbox_retries_when_spool_and_delivery_both_fail(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            blocker = root / "blocked"
            blocker.write_text("not a directory", encoding="utf-8")
            available = False
            delivered: list[str] = []

            def delivery(message: str) -> None:
                if not available:
                    raise monitoring_native.DeliveryError("synthetic outage")
                delivered.append(message)

            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                notifier = recovery_supervisor.EmergencyNotifier(
                    blocker / "notifications", delivery=delivery, cooldown=0
                )
                outbox = recovery_supervisor.RecoveryNotificationOutbox(
                    ledger, emergency=notifier
                )
                self.assertTrue(outbox.immediate_escalation("recovery_failed"))
                self.assertIsNone(
                    ledger.connection.execute(
                        "SELECT delivered_at FROM notification_outbox"
                    ).fetchone()[0]
                )
                blocker.unlink()
                available = True
                self.assertEqual(outbox.deliver_due(), 1)
                self.assertEqual(delivered, [])
                notifier.drain()
                self.assertEqual(len(delivered), 1)
                self.assertIsNotNone(
                    ledger.connection.execute(
                        "SELECT delivered_at FROM notification_outbox"
                    ).fetchone()[0]
                )

    def test_runtime_ledger_corruption_closes_ledger_and_keeps_intake_spooled(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            messages: list[str] = []
            ledger = recovery_ledger.RecoveryLedger(root / "ledger.sqlite3")
            coordinator = recovery_supervisor.IncidentCoordinator(
                ledger, correlation_policy(), owner="corrupt-runtime"
            )
            event_spool = recovery_supervisor.AtomicJsonSpool(root / "events")
            service = recovery_supervisor.RecoveryService(
                ledger,
                event_spool,
                recovery_supervisor.EmergencyNotifier(
                    root / "notifications", delivery=messages.append, cooldown=0
                ),
                coordinator=coordinator,
            )
            with mock.patch.object(
                coordinator,
                "reconcile",
                side_effect=recovery_ledger.LedgerCorrupt("synthetic corruption"),
            ):
                result = service.accept(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("runtime-corrupt"))
                    )
                )
            self.assertEqual((result.status, result.text), (202, "durably spooled"))
            self.assertEqual(len(event_spool.items()), 1)
            self.assertEqual(service.health().status, 503)
            with self.assertRaises(recovery_ledger.LedgerUnavailable):
                _ = ledger.connection
            self.assertEqual(messages, [])
            service.maintenance()
            self.assertTrue(any("integrity" in message for message in messages))

    def test_corrupt_emergency_spool_does_not_terminate_maintenance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            delivered: list[str] = []
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                notifier = recovery_supervisor.EmergencyNotifier(
                    root / "notifications", delivery=delivered.append, cooldown=0
                )
                notifier.spool.path.mkdir(parents=True)
                (notifier.spool.path / "000-corrupt.json").write_text(
                    "not-json", encoding="ascii"
                )
                service = recovery_supervisor.RecoveryService(
                    ledger,
                    recovery_supervisor.AtomicJsonSpool(root / "events"),
                    notifier,
                )
                service.maintenance()
                service.maintenance()
            self.assertTrue(
                any("spool validation failed" in message for message in delivered)
            )


class IncidentCoordinatorTests(unittest.TestCase):
    def test_retained_invocation_fences_renew_evidence_finish_and_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(lease_seconds=30),
                    owner="future-fixer",
                    clock=lambda: clock[0],
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("fenced-invocation"))
                    )
                )
                coordinator.reconcile()
                incident = ledger.connection.execute(
                    "SELECT * FROM incidents"
                ).fetchone()
                token = "synthetic-lease-token"
                with ledger.transaction() as connection:
                    connection.execute(
                        "UPDATE incidents SET state = 'invoking' WHERE id = ?",
                        (incident["id"],),
                    )
                    connection.execute(
                        "UPDATE fixer_lease SET owner = ?, token = ?, acquired_at = ?, "
                        "expires_at = ? WHERE singleton = 1",
                        ("future-fixer", token, 100.0, 120.0),
                    )
                    cursor = connection.execute(
                        "INSERT INTO invocations(incident_id, generation, evidence_hash, "
                        "policy_revision, lease_token, state, created_at, updated_at) "
                        "VALUES (?, ?, ?, ?, ?, 'active', 100, 100)",
                        (
                            incident["id"],
                            incident["generation"],
                            incident["evidence_hash"],
                            incident["policy_revision"],
                            token,
                        ),
                    )
                fence = recovery_supervisor.InvocationFence(
                    int(cursor.lastrowid),
                    int(incident["id"]),
                    int(incident["generation"]),
                    str(incident["evidence_hash"]),
                    int(incident["policy_revision"]),
                    token,
                    "future-fixer",
                )
                evidence = coordinator.invocation_evidence(fence)
                self.assertEqual(len(evidence), 1)
                latest = json.loads(ledger.latest_events()[0]["normalized_json"])
                self.assertEqual(evidence[0]["transitionId"], latest["transition_id"])
                self.assertTrue(coordinator.renew_lease(fence))
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT expires_at FROM fixer_lease WHERE singleton = 1"
                    ).fetchone()[0],
                    130.0,
                )
                stale = recovery_supervisor.InvocationFence(
                    fence.invocation_id,
                    fence.incident_id,
                    fence.generation,
                    fence.evidence_hash,
                    fence.policy_revision,
                    "wrong-token",
                    fence.owner,
                )
                self.assertFalse(coordinator.renew_lease(stale))
                self.assertFalse(coordinator.finish(stale, "completed"))
                self.assertTrue(coordinator.finish(fence, "completed"))
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT state FROM invocations WHERE id = ?",
                        (fence.invocation_id,),
                    ).fetchone()[0],
                    "completed",
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT state FROM incidents WHERE id = ?",
                        (fence.incident_id,),
                    ).fetchone()[0],
                    "verifying",
                )

                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("fenced-invocation-retry"))
                    )
                )
                coordinator.reconcile()
                retried = ledger.connection.execute(
                    "SELECT id, generation FROM incidents WHERE state = 'eligible'"
                ).fetchone()
                self.assertTrue(
                    coordinator.explicit_retry(
                        int(retried["id"]), actor="operator", reason="bounded retry"
                    )
                )
                self.assertFalse(
                    coordinator.explicit_retry(
                        int(retried["id"]), actor="operator", reason="budget exhausted"
                    )
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM audit WHERE operation = 'explicit_retry'"
                    ).fetchone()[0],
                    1,
                )

    def test_observe_reconciles_generations_without_claims_or_actions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="observer", mode="observe"
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("episode-one"))
                    )
                )
                self.assertEqual(coordinator.reconcile(), 1)
                incident = ledger.connection.execute(
                    "SELECT id, state, generation FROM incidents"
                ).fetchone()
                self.assertEqual((incident["state"], incident["generation"]), ("eligible", 1))
                with mock.patch("subprocess.Popen") as popen:
                    self.assertIsNone(coordinator.claim_next())
                popen.assert_not_called()
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0],
                    0,
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'actions'"
                    ).fetchone()[0],
                    0,
                )

                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(resolved_alert("episode-one"))
                    )
                )
                self.assertEqual(coordinator.reconcile(), 0)
                resolved = ledger.connection.execute(
                    "SELECT state, generation FROM incidents WHERE id = ?", (incident["id"],)
                ).fetchone()
                self.assertEqual((resolved["state"], resolved["generation"]), ("verifying", 2))
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM audit WHERE operation = 'verification_recovered'"
                    ).fetchone()[0],
                    0,
                )

    def test_cross_source_and_out_of_order_evidence_remain_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="observer"
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(
                            resolved_alert(
                                "late",
                                starts_at="2026-07-14T00:00:00Z",
                                ends_at="2026-07-14T00:20:00Z",
                            ),
                            firing_alert("late", starts_at="2026-07-14T00:10:00Z"),
                        )
                    )
                )
                ledger.record_events(
                    doctor_events(("node_unavailable", "firing", "detected"))
                )
                self.assertEqual(coordinator.reconcile(), 1)
                row = ledger.connection.execute(
                    "SELECT correlation_key, state FROM incidents"
                ).fetchone()
                self.assertEqual(tuple(row), ("bot-unavailable", "eligible"))
                self.assertIsNone(coordinator.claim_next())
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0],
                    0,
                )

    def test_expired_synthetic_lease_is_reconciled_without_dispatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(lease_seconds=10),
                    owner="observer",
                    clock=lambda: clock[0],
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("crash"))
                    )
                )
                coordinator.reconcile()
                incident = ledger.connection.execute("SELECT * FROM incidents").fetchone()
                with ledger.transaction() as connection:
                    connection.execute(
                        "UPDATE incidents SET state = 'invoking' WHERE id = ?",
                        (incident["id"],),
                    )
                    connection.execute(
                        "UPDATE fixer_lease SET owner = 'future-fixer', token = 'lease-token', "
                        "acquired_at = 80, expires_at = 90 WHERE singleton = 1"
                    )
                    connection.execute(
                        "INSERT INTO invocations(incident_id, generation, evidence_hash, "
                        "policy_revision, lease_token, state, created_at, updated_at) "
                        "VALUES (?, ?, ?, ?, 'lease-token', 'active', 80, 80)",
                        (
                            incident["id"],
                            incident["generation"],
                            incident["evidence_hash"],
                            incident["policy_revision"],
                        ),
                    )
                coordinator.reconcile()
                invocation = ledger.connection.execute(
                    "SELECT state FROM invocations"
                ).fetchone()
                repaired = ledger.connection.execute(
                    "SELECT state, generation FROM incidents"
                ).fetchone()
                lease = ledger.connection.execute(
                    "SELECT owner, token FROM fixer_lease WHERE singleton = 1"
                ).fetchone()
                self.assertEqual(invocation["state"], "interrupted")
                self.assertEqual((repaired["state"], repaired["generation"]), ("eligible", 2))
                self.assertEqual(tuple(lease), (None, None))
                self.assertIsNone(coordinator.claim_next())


class RecoveryControlTests(unittest.TestCase):
    def test_silence_limit_rejects_new_target_without_corrupting_policy(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                controls = recovery_supervisor.RecoveryControls(
                    ledger, clock=lambda: clock[0]
                )
                for index in range(128):
                    controls.silence(
                        f"incident-{index}",
                        actor="operator",
                        reason="bounded silence fixture",
                        expires_at=200.0,
                    )
                with self.assertRaisesRegex(ValueError, "limit"):
                    controls.silence(
                        "incident-overflow",
                        actor="operator",
                        reason="must fail",
                        expires_at=200.0,
                    )
                self.assertEqual(len(controls.current().silences), 128)
                controls.silence(
                    "incident-0",
                    actor="operator",
                    reason="replacement remains allowed",
                    expires_at=201.0,
                )
                self.assertEqual(len(controls.current().silences), 128)

    def test_static_controls_expire_and_rollback_without_enabling_work(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                controls = recovery_supervisor.RecoveryControls(
                    ledger, clock=lambda: clock[0]
                )
                disabled_revision = controls.set_dispatch(
                    False,
                    actor="operator",
                    reason="maintenance",
                    expires_at=150.0,
                )
                controls.set_confirmation_count(
                    3, actor="operator", reason="reviewed threshold"
                )
                controls.set_cooldown(
                    30, actor="operator", reason="reviewed cooldown"
                )
                controls.set_retry_budget(
                    2, actor="operator", reason="reviewed retry bound"
                )
                controls.silence(
                    "bot-unavailable",
                    actor="operator",
                    reason="known maintenance",
                    expires_at=140.0,
                )
                current = controls.current()
                self.assertFalse(current.dispatch_enabled)
                self.assertEqual(
                    (
                        current.confirmation_count,
                        current.cooldown_seconds,
                        current.retry_budget,
                    ),
                    (3, 30.0, 2),
                )
                self.assertEqual(current.silence_expiry("bot-unavailable", clock[0]), 140.0)

                clock[0] = 160.0
                expired_revision = controls.expire()
                self.assertIsNotNone(expired_revision)
                self.assertTrue(controls.current().dispatch_enabled)
                self.assertIsNone(
                    controls.current().silence_expiry("bot-unavailable", clock[0])
                )
                rolled_back = controls.rollback(
                    disabled_revision,
                    actor="operator",
                    reason="restore reviewed revision",
                )
                self.assertGreater(rolled_back, int(expired_revision or 0))
                self.assertGreater(
                    ledger.connection.execute("SELECT count(*) FROM audit").fetchone()[0],
                    0,
                )

    def test_closed_static_policy_contains_only_observe_probes_and_correlation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = recovery_config.RecoveryConfig(
                path=root / "recovery.json",
                workspace=root,
                mode="observe",
                database=root / "ledger.sqlite3",
                spool_directory=root / "spool",
                auth_token_file=root / "token",
                host="127.0.0.1",
                port=9877,
                correlation_rules=(),
                source_ids=("alertmanager", "runtime_doctor"),
                probes=(
                    {
                        "id": "health",
                        "executable": "/usr/bin/true",
                        "argv": [],
                        "env": {},
                        "timeoutMs": 1000,
                    },
                ),
                runtime_doctor_cadence_seconds=300,
                verification_freshness_seconds=660,
                verification_hold_down_seconds=60,
            )
            policy = recovery_config.recovery_static_policy(config)
            self.assertEqual(
                set(policy),
                {
                    "version",
                    "mode",
                    "correlationRules",
                    "sourceIds",
                    "probes",
                    "runtimeDoctorCadenceSeconds",
                    "verificationFreshnessSeconds",
                    "verificationHoldDownSeconds",
                },
            )
            self.assertEqual(policy["mode"], "observe")
            with recovery_ledger.RecoveryLedger(config.database) as ledger:
                controls = recovery_supervisor.RecoveryControls(ledger)
                first = controls.ensure_static_policy(policy)
                second = controls.ensure_static_policy(policy)
                self.assertEqual(first, second)


class RecoveryVerificationTests(unittest.TestCase):
    @staticmethod
    def _fence(
        ledger: recovery_ledger.RecoveryLedger, incident_id: int
    ) -> recovery_supervisor.VerificationFence:
        row = ledger.connection.execute(
            "SELECT generation, policy_revision FROM incidents WHERE id = ?",
            (incident_id,),
        ).fetchone()
        return recovery_supervisor.VerificationFence(
            incident_id, int(row["generation"]), int(row["policy_revision"])
        )

    def _verifying_incident(
        self,
        ledger: recovery_ledger.RecoveryLedger,
        clock: list[float],
    ) -> tuple[recovery_supervisor.IncidentCoordinator, int]:
        coordinator = recovery_supervisor.IncidentCoordinator(
            ledger,
            correlation_policy(),
            owner="observer",
            clock=lambda: clock[0],
        )
        ledger.record_events(
            recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
        )
        coordinator.reconcile()
        clock[0] += 10
        ledger.record_events(
            recovery_supervisor.normalize_alertmanager(alert_body(resolved_alert()))
        )
        coordinator.reconcile()
        row = ledger.connection.execute("SELECT id, state FROM incidents").fetchone()
        self.assertEqual(row["state"], "verifying")
        return coordinator, int(row["id"])

    @staticmethod
    def _evidence_states(
        result: recovery_supervisor.VerificationResult,
    ) -> dict[tuple[str, str], str]:
        return {
            (item.kind, item.identifier): item.state
            for item in result.evidence
        }

    def test_verification_requires_fresh_health_probes_and_hold_down(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("bot-health",),
                    source_ids=("alertmanager",),
                    cadence_seconds=10,
                    freshness_seconds=30,
                    hold_down_seconds=20,
                    clock=lambda: clock[0],
                )
                missing = verifier.evaluate(incident_id)
                self.assertFalse(missing.recovered)
                self.assertIn("heartbeat_missing:supervisor", missing.reasons)
                verifier.record_heartbeat("supervisor")
                verifier.record_heartbeat("alertmanager")
                verifier.record_probe(
                    self._fence(ledger, incident_id), "bot-health", True
                )
                holding = verifier.evaluate(incident_id)
                self.assertFalse(holding.recovered)
                self.assertIn("hold_down", holding.reasons)
                clock[0] += 21
                recovered = verifier.evaluate(incident_id)
                self.assertTrue(recovered.recovered)
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM invocations"
                    ).fetchone()[0],
                    0,
                )

    def test_missing_or_stale_evidence_never_creates_a_completion_claim(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    source_ids=("alertmanager",),
                    cadence_seconds=4,
                    freshness_seconds=10,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
                )
                verifier.record_heartbeat("supervisor")
                verifier.record_heartbeat("alertmanager")
                clock[0] += 11
                result = verifier.evaluate(incident_id)
                self.assertFalse(result.recovered)
                self.assertIn("heartbeat_stale:alertmanager", result.reasons)
                self.assertEqual(
                    {item.state for item in result.evidence},
                    {"stale"},
                )
                self.assertIsNone(
                    verifier.mechanical_classification(incident_id, result)
                )
                service = recovery_supervisor.RecoveryService(
                    ledger,
                    recovery_supervisor.AtomicJsonSpool(Path(directory) / "events"),
                    recovery_supervisor.EmergencyNotifier(
                        Path(directory) / "notifications", delivery=None
                    ),
                    coordinator=coordinator,
                    verifier=verifier,
                )
                service.maintenance()
                state = ledger.connection.execute(
                    "SELECT state FROM incidents WHERE id = ?", (incident_id,)
                ).fetchone()[0]
                self.assertEqual(state, "verifying")
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM invocations"
                    ).fetchone()[0],
                    0,
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM sqlite_master "
                        "WHERE type = 'table' AND name = 'actions'"
                    ).fetchone()[0],
                    0,
                )

    def test_evidence_states_follow_300_second_cadence_and_660_second_expiry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("health",),
                    source_ids=("runtime_doctor",),
                    cadence_seconds=300,
                    freshness_seconds=660,
                    hold_down_seconds=86_400,
                    clock=lambda: clock[0],
                )
                fence = self._fence(ledger, incident_id)

                missing = verifier.evaluate(incident_id)
                self.assertEqual(
                    self._evidence_states(missing),
                    {
                        ("heartbeat", "supervisor"): "missing",
                        ("heartbeat", "runtime_doctor"): "missing",
                        ("probe", "health"): "missing",
                    },
                )

                for observed_at in (110.0, 410.0, 710.0):
                    clock[0] = observed_at
                    verifier.record_heartbeat("supervisor", observed_at=observed_at)
                    verifier.record_heartbeat("runtime_doctor", observed_at=observed_at)
                    self.assertTrue(
                        verifier.record_probe(
                            fence,
                            "health",
                            True,
                            observed_at=observed_at,
                        )
                    )
                    self.assertEqual(
                        set(self._evidence_states(verifier.evaluate(incident_id)).values()),
                        {"fresh_healthy"},
                    )

                clock[0] = 1_369.0
                self.assertEqual(
                    set(self._evidence_states(verifier.evaluate(incident_id)).values()),
                    {"fresh_healthy"},
                )
                clock[0] = 1_370.0
                expired = verifier.evaluate(incident_id)
                self.assertEqual(
                    set(self._evidence_states(expired).values()),
                    {"stale"},
                )
                self.assertIn("heartbeat_stale:runtime_doctor", expired.reasons)
                self.assertIn("probe_stale:health", expired.reasons)

                clock[0] = 1_371.0
                verifier.record_heartbeat("supervisor", observed_at=1_372.0)
                verifier.record_heartbeat("runtime_doctor", observed_at=1_372.0)
                self.assertTrue(
                    verifier.record_probe(fence, "health", True, observed_at=1_372.0)
                )
                future = verifier.evaluate(incident_id)
                self.assertEqual(
                    set(self._evidence_states(future).values()),
                    {"stale"},
                )

                clock[0] = 1_373.0
                verifier.record_heartbeat("supervisor", healthy=False)
                verifier.record_heartbeat("runtime_doctor", healthy=False)
                self.assertTrue(verifier.record_probe(fence, "health", False))
                unhealthy = verifier.evaluate(incident_id)
                self.assertEqual(
                    set(self._evidence_states(unhealthy).values()),
                    {"fresh_unhealthy"},
                )
                self.assertIn("heartbeat_unhealthy:runtime_doctor", unhealthy.reasons)
                self.assertIn("probe_unhealthy:health", unhealthy.reasons)

    def test_missed_recovery_requires_a_completed_claim_and_fresh_contradiction(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            root = Path(directory)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("health",),
                    source_ids=("runtime_doctor",),
                    cadence_seconds=300,
                    freshness_seconds=660,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
                )
                fence = self._fence(ledger, incident_id)
                clock[0] = 800.0
                verifier.record_heartbeat("supervisor", observed_at=140.0)
                verifier.record_heartbeat("runtime_doctor", observed_at=140.0)
                self.assertTrue(
                    verifier.record_probe(fence, "health", False, observed_at=140.0)
                )
                stale = verifier.evaluate(incident_id)
                self.assertIsNone(verifier.mechanical_classification(incident_id, stale))
                self.assertFalse(
                    coordinator.mark_missed_recovery(
                        incident_id,
                        dedupe_key=f"invocation:1:verification:{fence.generation}",
                        result=stale,
                    )
                )

                incident = ledger.connection.execute(
                    "SELECT evidence_hash, generation, policy_revision FROM incidents "
                    "WHERE id = ?",
                    (incident_id,),
                ).fetchone()
                with ledger.transaction() as connection:
                    cursor = connection.execute(
                        "INSERT INTO invocations(incident_id, generation, evidence_hash, "
                        "policy_revision, lease_token, state, created_at, updated_at) "
                        "VALUES (?, ?, ?, ?, 'test-completed-claim', 'completed', ?, ?)",
                        (
                            incident_id,
                            incident["generation"],
                            incident["evidence_hash"],
                            incident["policy_revision"],
                            clock[0],
                            clock[0],
                        ),
                    )
                    invocation_id = int(cursor.lastrowid)

                service = recovery_supervisor.RecoveryService(
                    ledger,
                    recovery_supervisor.AtomicJsonSpool(root / "events"),
                    recovery_supervisor.EmergencyNotifier(
                        root / "notifications", delivery=None
                    ),
                    coordinator=coordinator,
                    verifier=verifier,
                )
                service.maintenance()
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT state FROM incidents WHERE id = ?", (incident_id,)
                    ).fetchone()[0],
                    "verifying",
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM audit WHERE operation = 'verification_failed'"
                    ).fetchone()[0],
                    0,
                )

                verifier.record_heartbeat("runtime_doctor")
                self.assertTrue(verifier.record_probe(fence, "health", False))
                fresh_failure = verifier.evaluate(incident_id)
                self.assertEqual(
                    self._evidence_states(fresh_failure)[("probe", "health")],
                    "fresh_unhealthy",
                )
                self.assertEqual(
                    verifier.mechanical_classification(incident_id, fresh_failure),
                    (
                        "missed_recovery",
                        f"invocation:{invocation_id}:verification:{fence.generation}",
                    ),
                )
                clock[0] = 1_460.0
                self.assertFalse(
                    coordinator.mark_missed_recovery(
                        incident_id,
                        dedupe_key=(
                            f"invocation:{invocation_id}:verification:{fence.generation}"
                        ),
                        result=fresh_failure,
                    )
                )
                verifier.record_heartbeat("runtime_doctor")
                self.assertTrue(verifier.record_probe(fence, "health", False))
                service.maintenance()
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT state FROM incidents WHERE id = ?", (incident_id,)
                    ).fetchone()[0],
                    "recovery_failed",
                )

    def test_probe_results_are_fenced_to_the_verification_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(
                Path(directory) / "ledger.sqlite3"
            ) as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("health",),
                    cadence_seconds=30,
                    freshness_seconds=120,
                    hold_down_seconds=60,
                    clock=lambda: clock[0],
                )
                stale = self._fence(ledger, incident_id)
                with ledger.transaction() as connection:
                    connection.execute(
                        "UPDATE incidents SET generation = generation + 1 WHERE id = ?",
                        (incident_id,),
                    )
                self.assertFalse(verifier.record_probe(stale, "health", True))
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM metadata WHERE key LIKE 'verification:probe:%'"
                    ).fetchone()[0],
                    0,
                )

    @staticmethod
    def _native_executable(name: str) -> str:
        for parent in (Path("/usr/bin"), Path("/bin")):
            candidate = parent / name
            if candidate.is_file():
                return str(candidate)
        raise unittest.SkipTest(f"required native test executable is unavailable: {name}")

    def test_observe_maintenance_runs_native_probes_without_node_or_package(self) -> None:
        for executable_name, expected_healthy in (("true", True), ("false", False)):
            with self.subTest(executable=executable_name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = recovery_config.RecoveryConfig(
                    path=root / "recovery.json",
                    workspace=root,
                    mode="observe",
                    database=root / "ledger.sqlite3",
                    spool_directory=root / "spool",
                    auth_token_file=root / "token",
                    host="127.0.0.1",
                    port=9877,
                    correlation_rules=(
                        {
                            "component": "synthetic",
                            "failureClass": "unavailable",
                            "incidentKey": "bot-unavailable",
                            "impact": 2,
                        },
                    ),
                    source_ids=("alertmanager",),
                    probes=(
                        {
                            "id": "host-health",
                            "executable": self._native_executable(executable_name),
                            "argv": [],
                            "env": {"LANG": "C"},
                            "timeoutMs": 1000,
                        },
                    ),
                    runtime_doctor_cadence_seconds=30,
                    verification_freshness_seconds=120,
                    verification_hold_down_seconds=0,
                )
                with recovery_ledger.RecoveryLedger(config.database) as ledger:
                    service = recovery_supervisor._build_recovery_service(
                        ledger,
                        recovery_supervisor.AtomicJsonSpool(
                            config.spool_directory / "events"
                        ),
                        recovery_supervisor.EmergencyNotifier(
                            config.spool_directory / "notifications", delivery=None
                        ),
                        configured=config,
                    )
                    self.assertIsInstance(
                        service.probe_runner, recovery_supervisor.PythonProbeRunner
                    )
                    service.accept(
                        recovery_supervisor.normalize_alertmanager(
                            alert_body(firing_alert())
                        ),
                        heartbeats={"alertmanager": True},
                    )
                    service.accept(
                        recovery_supervisor.normalize_alertmanager(
                            alert_body(resolved_alert())
                        ),
                        heartbeats={"alertmanager": True},
                    )
                    incident_id = int(
                        ledger.connection.execute("SELECT id FROM incidents").fetchone()[0]
                    )
                    original_cwd = Path.cwd()
                    isolated_cwd = root / "no-package-checkout"
                    isolated_cwd.mkdir()
                    try:
                        os.chdir(isolated_cwd)
                        with mock.patch.dict(
                            os.environ,
                            {
                                "PATH": str(root / "missing-bin"),
                                "NODE": str(root / "missing-node"),
                            },
                            clear=True,
                        ):
                            service.maintenance()
                    finally:
                        os.chdir(original_cwd)
                    assert service.verifier is not None
                    verifier = service.verifier
                    fence = self._fence(ledger, incident_id)
                    observation = verifier._probe_observation(
                        ledger.connection, fence, "host-health"
                    )
                    self.assertIsNotNone(observation)
                    assert observation is not None
                    self.assertEqual(observation[0], expected_healthy)
                    state = ledger.connection.execute(
                        "SELECT state FROM incidents WHERE id = ?", (incident_id,)
                    ).fetchone()[0]
                    self.assertEqual(
                        state, "recovered" if expected_healthy else "verifying"
                    )
                    self.assertEqual(
                        ledger.connection.execute(
                            "SELECT count(*) FROM invocations"
                        ).fetchone()[0],
                        0,
                    )
                    self.assertEqual(
                        ledger.connection.execute(
                            "SELECT count(*) FROM sqlite_master "
                            "WHERE type = 'table' AND name = 'actions'"
                        ).fetchone()[0],
                        0,
                    )

    def test_sequential_probes_keep_their_individual_completion_times(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            incident_clock = [50.0]
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(
                    ledger, incident_clock
                )
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("first", "second"),
                    cadence_seconds=30,
                    freshness_seconds=660,
                    hold_down_seconds=0,
                    clock=lambda: 900.0,
                )
                executable = self._native_executable("true")
                probes = tuple(
                    {
                        "id": probe_id,
                        "executable": executable,
                        "argv": [],
                        "env": {},
                        "timeoutMs": 1000,
                    }
                    for probe_id in verifier.probe_ids
                )
                runner = recovery_supervisor.PythonProbeRunner(verifier, probes)
                fence = self._fence(ledger, incident_id)
                with mock.patch.object(
                    runner,
                    "_run_command",
                    side_effect=(
                        {
                            "id": "first",
                            "exitCode": 0,
                            "timedOut": False,
                            "observedAt": 100.0,
                        },
                        {
                            "id": "second",
                            "exitCode": 0,
                            "timedOut": False,
                            "observedAt": 500.0,
                        },
                    ),
                ):
                    self.assertTrue(runner.refresh(fence))
                observations = [
                    verifier._probe_observation(
                        ledger.connection, fence, probe_id
                    )
                    for probe_id in verifier.probe_ids
                ]
                self.assertEqual(observations, [(True, 100.0), (True, 500.0)])

    def test_probe_refresh_is_scheduled_from_set_completion_once_per_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("first", "second"),
                    cadence_seconds=30,
                    freshness_seconds=120,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
                )
                executable = self._native_executable("true")
                probes = tuple(
                    {
                        "id": probe_id,
                        "executable": executable,
                        "argv": [],
                        "env": {},
                        "timeoutMs": 1000,
                    }
                    for probe_id in verifier.probe_ids
                )
                runner = recovery_supervisor.PythonProbeRunner(verifier, probes)
                fence = self._fence(ledger, incident_id)
                with mock.patch.object(
                    runner,
                    "_run_command",
                    side_effect=(
                        {
                            "id": "first",
                            "exitCode": 0,
                            "timedOut": False,
                            "observedAt": 60.0,
                        },
                        {
                            "id": "second",
                            "exitCode": 0,
                            "timedOut": False,
                            "observedAt": 100.0,
                        },
                    ),
                ):
                    self.assertTrue(runner.refresh(fence))
                self.assertIsNone(verifier.next_probe_refresh())
                clock[0] = 141.0
                self.assertEqual(verifier.next_probe_refresh(), fence)
                with mock.patch.object(
                    verifier, "next_probe_refresh", return_value=fence
                ) as next_refresh, mock.patch.object(
                    runner, "refresh", return_value=True
                ) as refresh:
                    self.assertEqual(runner.refresh_due(), 1)
                next_refresh.assert_called_once_with()
                refresh.assert_called_once_with(fence)
                with self.assertRaises(ValueError):
                    runner.refresh_due(limit=2)

    def test_probe_timeout_discards_output_and_reaps_the_process_group(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                probe = {
                    "id": "bounded-output",
                    "executable": self._native_executable("sleep"),
                    "argv": ["5"],
                    "env": {},
                    "timeoutMs": 100,
                }
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("bounded-output",),
                    cadence_seconds=30,
                    freshness_seconds=120,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
                )
                runner = recovery_supervisor.PythonProbeRunner(verifier, (probe,))
                fence = self._fence(ledger, incident_id)
                spawned: list[object] = []
                launch_options: list[dict[str, object]] = []
                real_popen = recovery_supervisor.subprocess.Popen

                def capture_process(*args: object, **kwargs: object) -> object:
                    launch_options.append(dict(kwargs))
                    process = real_popen(*args, **kwargs)
                    spawned.append(process)
                    return process

                started = time.monotonic()
                with mock.patch.object(
                    recovery_supervisor.subprocess,
                    "Popen",
                    side_effect=capture_process,
                ):
                    self.assertTrue(runner.refresh(fence))
                self.assertLess(time.monotonic() - started, 2.0)
                self.assertEqual(len(spawned), 1)
                self.assertIsNotNone(spawned[0].poll())
                self.assertEqual(launch_options[0]["stdout"], recovery_supervisor.subprocess.DEVNULL)
                self.assertEqual(launch_options[0]["stderr"], recovery_supervisor.subprocess.DEVNULL)
                self.assertEqual(launch_options[0]["env"], {})
                self.assertEqual(launch_options[0]["cwd"], "/")
                self.assertIs(launch_options[0]["shell"], False)
                self.assertIs(launch_options[0]["start_new_session"], True)
                observation = verifier._probe_observation(
                    ledger.connection, fence, "bounded-output"
                )
                self.assertIsNotNone(observation)
                assert observation is not None
                self.assertFalse(observation[0])

    def test_probe_runner_rejects_unreviewed_paths_and_handles_missing_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clock = [100.0]
            script = root / "probe-helper"
            marker = root / "script-ran"
            script.write_text(f"#!/bin/sh\ntouch {marker}\n", encoding="utf-8")
            script.chmod(0o700)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                unsafe_probes = (
                    {
                        "id": "script",
                        "executable": str(script),
                        "argv": [],
                        "env": {},
                        "timeoutMs": 1000,
                    },
                    {
                        "id": "missing-package-probe",
                        "executable": str(root / "missing-package" / "probe"),
                        "argv": [],
                        "env": {},
                        "timeoutMs": 1000,
                    },
                )
                for probe in unsafe_probes:
                    with self.subTest(probe=probe["id"]), self.assertRaises(
                        recovery_config.RecoveryConfigError
                    ):
                        recovery_config.validated_probe_command(probe)
                probes = (
                    {
                        "id": "missing-native-probe",
                        "executable": self._native_executable("true"),
                        "argv": [],
                        "env": {},
                        "timeoutMs": 1000,
                    },
                )
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("missing-native-probe",),
                    cadence_seconds=30,
                    freshness_seconds=120,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
                )
                runner = recovery_supervisor.PythonProbeRunner(verifier, probes)
                fence = self._fence(ledger, incident_id)
                with mock.patch.object(
                    recovery_supervisor.PythonProbeRunner,
                    "_resolved_executable",
                    return_value=None,
                ), mock.patch.object(recovery_supervisor.subprocess, "Popen") as popen:
                    self.assertTrue(runner.refresh(fence))
                popen.assert_not_called()
                self.assertFalse(marker.exists())
                for probe_id in verifier.probe_ids:
                    observation = verifier._probe_observation(
                        ledger.connection, fence, probe_id
                    )
                    self.assertIsNotNone(observation)
                    assert observation is not None
                    self.assertFalse(observation[0])

    def test_probe_launch_and_recording_stop_on_generation_or_policy_staleness(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                sleep_probe = {
                    "id": "slow-health",
                    "executable": self._native_executable("sleep"),
                    "argv": ["5"],
                    "env": {},
                    "timeoutMs": 5000,
                }
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("slow-health",),
                    cadence_seconds=30,
                    freshness_seconds=120,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
                )
                runner = recovery_supervisor.PythonProbeRunner(
                    verifier, (sleep_probe,)
                )
                policy_stale = self._fence(ledger, incident_id)
                coordinator.controls.set_dispatch(
                    False,
                    actor="operator",
                    reason="synthetic policy change",
                )
                with mock.patch.object(recovery_supervisor.subprocess, "Popen") as popen:
                    self.assertFalse(runner.refresh(policy_stale))
                popen.assert_not_called()

                coordinator.reconcile()
                current = self._fence(ledger, incident_id)
                started = threading.Event()
                captured: list[object] = []
                real_popen = recovery_supervisor.subprocess.Popen

                def capture_process(*args: object, **kwargs: object) -> object:
                    process = real_popen(*args, **kwargs)
                    captured.append(process)
                    started.set()
                    return process

                def invalidate_generation() -> None:
                    self.assertTrue(started.wait(timeout=2.0))
                    with ledger.transaction() as connection:
                        connection.execute(
                            "UPDATE incidents SET generation = generation + 1 WHERE id = ?",
                            (incident_id,),
                        )

                invalidator = threading.Thread(target=invalidate_generation)
                invalidator.start()
                before = time.monotonic()
                with mock.patch.object(
                    recovery_supervisor.subprocess,
                    "Popen",
                    side_effect=capture_process,
                ):
                    self.assertFalse(runner.refresh(current))
                invalidator.join(timeout=2.0)
                self.assertFalse(invalidator.is_alive())
                self.assertLess(time.monotonic() - before, 2.0)
                self.assertEqual(len(captured), 1)
                self.assertIsNotNone(captured[0].poll())
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM metadata WHERE key LIKE 'verification:probe:%'"
                    ).fetchone()[0],
                    0,
                )


class RecoveryNotificationTests(unittest.TestCase):
    def test_immediate_escalation_uses_only_fixed_native_messages(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            messages: list[str] = []
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                emergency = recovery_supervisor.EmergencyNotifier(
                    root / "notifications",
                    delivery=messages.append,
                    cooldown=0,
                )
                outbox = recovery_supervisor.RecoveryNotificationOutbox(
                    ledger, emergency=emergency
                )
                for reason in sorted(recovery_supervisor._IMMEDIATE_ESCALATION_REASONS):
                    self.assertTrue(outbox.immediate_escalation(reason))
                self.assertEqual(messages, [])
                self.assertEqual(
                    outbox.deliver_due(),
                    len(recovery_supervisor._IMMEDIATE_ESCALATION_REASONS),
                )
                self.assertEqual(messages, [])
                emergency.drain()
                self.assertEqual(
                    len(messages), len(recovery_supervisor._IMMEDIATE_ESCALATION_REASONS)
                )
                with self.assertRaises(ValueError):
                    outbox.immediate_escalation("routine_summary")

    def test_immediate_escalation_remains_spooled_during_delivery_failure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def unavailable(_message: str) -> None:
                raise OSError("synthetic outage")

            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                emergency = recovery_supervisor.EmergencyNotifier(
                    root / "notifications",
                    delivery=unavailable,
                    cooldown=0,
                )
                outbox = recovery_supervisor.RecoveryNotificationOutbox(
                    ledger, emergency=emergency
                )
                self.assertTrue(outbox.immediate_escalation("recovery_failed"))
                self.assertEqual(
                    list((root / "notifications").glob("*.json")), []
                )
                stored = ledger.connection.execute(
                    "SELECT kind, delivered_at FROM notification_outbox"
                ).fetchone()
                self.assertEqual(stored["kind"], "immediate")
                self.assertIsNone(stored["delivered_at"])

                self.assertEqual(outbox.deliver_due(), 1)
                self.assertEqual(
                    len(list((root / "notifications").glob("*.json"))),
                    1,
                )
                delivered = ledger.connection.execute(
                    "SELECT kind, delivered_at FROM notification_outbox"
                ).fetchone()
                self.assertEqual(delivered["kind"], "immediate")
                self.assertIsNotNone(delivered["delivered_at"])

    def test_immediate_escalation_waits_durably_for_a_delivery_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                emergency = recovery_supervisor.EmergencyNotifier(
                    root / "notifications", delivery=None
                )
                outbox = recovery_supervisor.RecoveryNotificationOutbox(
                    ledger, emergency=emergency, clock=lambda: 100.0
                )
                self.assertTrue(outbox.immediate_escalation("supervisor_unavailable"))
                pending = ledger.connection.execute(
                    "SELECT kind, delivered_at FROM notification_outbox"
                ).fetchone()
                self.assertEqual(pending["kind"], "immediate")
                self.assertIsNone(pending["delivered_at"])


class RecoveryFoundationTests(unittest.TestCase):
    def test_foundation_exports_no_runnable_fixer_processor(self) -> None:
        removed = (
            "Recovery" + "Processor",
            "Recovery" + "WorkerUnavailable",
            "Bounded" + "PolicyAdapter",
        )
        self.assertTrue(all(not hasattr(recovery_supervisor, name) for name in removed))

    def test_observe_maintenance_has_zero_remediation_side_effects(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = recovery_config.RecoveryConfig(
                path=root / "recovery.json",
                workspace=root,
                mode="observe",
                database=root / "ledger.sqlite3",
                spool_directory=root / "spool",
                auth_token_file=root / "token",
                host="127.0.0.1",
                port=9877,
                correlation_rules=(
                    {
                        "component": "synthetic",
                        "failureClass": "unavailable",
                        "incidentKey": "bot-unavailable",
                        "impact": 2,
                    },
                ),
                source_ids=("alertmanager", "runtime_doctor"),
                probes=(),
                runtime_doctor_cadence_seconds=300,
                verification_freshness_seconds=660,
                verification_hold_down_seconds=60,
            )
            with recovery_ledger.RecoveryLedger(config.database) as ledger:
                service = recovery_supervisor._build_recovery_service(
                    ledger,
                    recovery_supervisor.AtomicJsonSpool(config.spool_directory / "events"),
                    recovery_supervisor.EmergencyNotifier(
                        config.spool_directory / "notifications", delivery=None
                    ),
                    configured=config,
                )
                self.assertIsNotNone(service.verifier)
                assert service.verifier is not None
                self.assertEqual(service.verifier.cadence_seconds, 300.0)
                self.assertEqual(service.verifier.freshness_seconds, 660.0)
                self.assertEqual(service.verifier.hold_down_seconds, 60.0)
                service.accept(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert())
                    )
                )
                with mock.patch("subprocess.Popen") as popen:
                    service.maintenance()
                popen.assert_not_called()
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0],
                    0,
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'actions'"
                    ).fetchone()[0],
                    0,
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM invocations WHERE state = 'completed'"
                    ).fetchone()[0],
                    0,
                )


class RecoveryHttpTests(unittest.TestCase):
    def test_authenticated_health_and_input_limits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = recovery_ledger.RecoveryLedger(root / "ledger.sqlite3")
            coordinator = recovery_supervisor.IncidentCoordinator(
                ledger,
                recovery_supervisor.RecoveryPolicy(revision=1, rules=()),
                owner="http-test",
                mode="observe",
            )
            verifier = recovery_supervisor.RecoveryVerifier(
                ledger,
                coordinator,
                source_ids=("alertmanager", "runtime_doctor"),
                cadence_seconds=300,
                freshness_seconds=660,
                hold_down_seconds=60,
            )
            service = recovery_supervisor.RecoveryService(
                ledger,
                recovery_supervisor.AtomicJsonSpool(root / "events"),
                recovery_supervisor.EmergencyNotifier(root / "notifications", delivery=None),
                coordinator,
                verifier,
            )
            token = "synthetic-auth-token-value"
            app = recovery_supervisor.RecoveryApplication(
                auth_token=token,
                max_body=1_024,
                body_timeout=1,
                service=service,
            )
            server = recovery_supervisor.BoundedThreadingHTTPServer(
                ("127.0.0.1", 0), recovery_supervisor.handler_for(app), max_concurrent_requests=2
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]

            def request(
                method: str,
                path: str,
                body: bytes | None = None,
                *,
                authorized: bool = True,
                content_type: str = "application/json",
            ) -> tuple[int, bytes]:
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
                headers = {"Content-Type": content_type}
                if authorized:
                    headers["Authorization"] = f"Bearer {token}"
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                value = response.read()
                connection.close()
                return response.status, value

            try:
                self.assertEqual(request("GET", "/healthz", authorized=False)[0], 401)
                self.assertEqual(request("GET", "/healthz")[0], 200)
                self.assertEqual(request("POST", "/v1/alertmanager", b"{}", authorized=False)[0], 401)
                self.assertEqual(request("POST", "/v1/alertmanager", b"not-json")[0], 400)
                self.assertEqual(request("POST", "/v1/alertmanager", b"x" * 1_025)[0], 413)
                self.assertEqual(
                    request("POST", "/v1/alertmanager", b"{}", content_type="text/plain")[0],
                    415,
                )
                valid = alert_body(firing_alert())
                self.assertEqual(request("POST", "/v1/alertmanager", valid)[0], 200)
                self.assertEqual(request("POST", "/v1/alertmanager", valid)[0], 200)
                self.assertEqual(ledger.connection.execute("SELECT count(*) FROM events").fetchone()[0], 1)
                heartbeat = json.dumps(
                    {
                        "version": 1,
                        "events": [],
                        "heartbeats": {"runtime_doctor": True, "alertmanager": True},
                    }
                ).encode()
                self.assertEqual(request("POST", "/v1/runtime-doctor", heartbeat)[0], 200)
                self.assertIsNotNone(
                    ledger.connection.execute(
                        "SELECT value FROM metadata "
                        "WHERE key = 'verification:heartbeat:runtime_doctor'"
                    ).fetchone()
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                ledger.close()

    def test_partial_body_timeout_releases_bounded_request_slots(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ledger = recovery_ledger.RecoveryLedger(root / "ledger.sqlite3")
            service = recovery_supervisor.RecoveryService(
                ledger,
                recovery_supervisor.AtomicJsonSpool(root / "events"),
                recovery_supervisor.EmergencyNotifier(root / "notifications", delivery=None),
            )
            token = "synthetic-auth-token-value"
            app = recovery_supervisor.RecoveryApplication(
                auth_token=token,
                max_body=1_024,
                body_timeout=1.0,
                service=service,
            )
            server = recovery_supervisor.BoundedThreadingHTTPServer(
                ("127.0.0.1", 0),
                recovery_supervisor.handler_for(app),
                max_concurrent_requests=2,
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]
            partials: list[socket.socket] = []
            try:
                request = (
                    "POST /v1/runtime-doctor HTTP/1.1\r\n"
                    f"Host: 127.0.0.1:{port}\r\n"
                    f"Authorization: Bearer {token}\r\n"
                    "Content-Type: application/json\r\n"
                    "Content-Length: 128\r\n\r\n{"
                ).encode("ascii")
                for _ in range(2):
                    connection = socket.create_connection(("127.0.0.1", port), timeout=1)
                    connection.sendall(request)
                    partials.append(connection)
                deadline = time.monotonic() + 1
                while getattr(server._request_slots, "_value", 1) != 0 and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertEqual(getattr(server._request_slots, "_value", 1), 0)
                excess = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                with self.assertRaises((ConnectionError, http.client.HTTPException, OSError)):
                    excess.request(
                        "GET",
                        "/healthz",
                        headers={"Authorization": f"Bearer {token}"},
                    )
                    excess.getresponse()
                excess.close()
                for connection in partials:
                    connection.settimeout(2)
                    response = connection.recv(1024)
                    self.assertIn(b"408", response)
                    connection.close()
                partials.clear()
                healthy = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                healthy.request(
                    "GET", "/healthz", headers={"Authorization": f"Bearer {token}"}
                )
                self.assertEqual(healthy.getresponse().status, 200)
                healthy.close()
            finally:
                for connection in partials:
                    connection.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                ledger.close()

    def test_runtime_doctor_rejects_forged_transition_id(self) -> None:
        payload = json.dumps(
            {
                "version": 1,
                "events": [
                    {
                        "code": "node_unavailable",
                        "status": "firing",
                        "transition": "stable-nonce",
                        "transition_id": "0" * 64,
                    }
                ],
            }
        ).encode()
        with self.assertRaises(recovery_supervisor.IntakeError):
            recovery_supervisor.normalize_runtime_doctor(payload)


class RuntimeDoctorRecoveryTests(unittest.TestCase):
    def config(self, root: Path, mode: str) -> runtime_doctor.DoctorConfig:
        token = root / "auth-token"
        token.write_text("synthetic-auth-token-value", encoding="utf-8")
        token.chmod(0o600)
        return runtime_doctor.DoctorConfig.from_environ(
            {
                "MINIME_DOCTOR_STATE_PATH": str(root / "doctor.json"),
                "MINIME_DOCTOR_SINK": mode,
                "MINIME_DOCTOR_RECOVERY_URL": "http://127.0.0.1:9877/v1/runtime-doctor",
                "MINIME_DOCTOR_RECOVERY_TOKEN_FILE": str(token),
                "MINIME_TELEGRAM_CHAT_ID": "10001",
            }
        )

    def test_recovery_sink_configuration_rejects_malformed_boundaries(self) -> None:
        base = {
            "MINIME_DOCTOR_STATE_PATH": "/tmp/minime-doctor-test-state",
            "MINIME_DOCTOR_SINK": "tee",
            "MINIME_DOCTOR_RECOVERY_URL": (
                "http://127.0.0.1:9877/v1/runtime-doctor"
            ),
            "MINIME_DOCTOR_RECOVERY_TOKEN_FILE": "/tmp/minime-doctor-test-token",
        }
        invalid: list[tuple[str, dict[str, str]]] = []
        for name, updates, removed in (
            ("sink", {"MINIME_DOCTOR_SINK": "invalid"}, ()),
            ("missing-url", {}, ("MINIME_DOCTOR_RECOVERY_URL",)),
            ("missing-token", {}, ("MINIME_DOCTOR_RECOVERY_TOKEN_FILE",)),
            ("https", {"MINIME_DOCTOR_RECOVERY_URL": "https://127.0.0.1:9877/v1/runtime-doctor"}, ()),
            ("remote", {"MINIME_DOCTOR_RECOVERY_URL": "http://example.com:9877/v1/runtime-doctor"}, ()),
            ("credentials", {"MINIME_DOCTOR_RECOVERY_URL": "http://user@127.0.0.1:9877/v1/runtime-doctor"}, ()),
            ("path", {"MINIME_DOCTOR_RECOVERY_URL": "http://127.0.0.1:9877/healthz"}, ()),
            ("query", {"MINIME_DOCTOR_RECOVERY_URL": "http://127.0.0.1:9877/v1/runtime-doctor?x=1"}, ()),
            ("fragment", {"MINIME_DOCTOR_RECOVERY_URL": "http://127.0.0.1:9877/v1/runtime-doctor#x"}, ()),
            ("missing-port", {"MINIME_DOCTOR_RECOVERY_URL": "http://127.0.0.1/v1/runtime-doctor"}, ()),
            ("zero-port", {"MINIME_DOCTOR_RECOVERY_URL": "http://127.0.0.1:0/v1/runtime-doctor"}, ()),
            ("attempt-zero", {"MINIME_DOCTOR_RECOVERY_ATTEMPTS": "0"}, ()),
            ("attempt-eleven", {"MINIME_DOCTOR_RECOVERY_ATTEMPTS": "11"}, ()),
        ):
            environment = dict(base)
            environment.update(updates)
            for key in removed:
                environment.pop(key)
            invalid.append((name, environment))
        for name, environment in invalid:
            with self.subTest(case=name), self.assertRaises(ValueError):
                runtime_doctor.DoctorConfig.from_environ(environment)

    def test_default_telegram_behavior_is_unchanged(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = runtime_doctor.DoctorConfig.from_environ(
                {
                    "MINIME_DOCTOR_STATE_PATH": str(root / "doctor.json"),
                    "MINIME_TELEGRAM_CHAT_ID": "10001",
                }
            )
            messages: list[str] = []
            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value={"node_unavailable"}
            ):
                self.assertEqual(runtime_doctor.run_doctor(config, deliver=messages.append), 0)
                self.assertEqual(runtime_doctor.run_doctor(config, deliver=messages.append), 0)
            self.assertEqual(len(messages), 1)
            state = json.loads(config.state_path.read_text("utf-8"))
            self.assertNotIn("pending", state)
            self.assertEqual(state["incidents"], ["node_unavailable"])

    def test_tee_retries_same_partial_event_without_duplicate_native_notification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "tee")
            messages: list[str] = []
            recovery_calls: list[list[dict[str, str]]] = []

            def recovery(events: list[dict[str, str]]) -> None:
                recovery_calls.append([dict(event) for event in events])
                if len(recovery_calls) == 1:
                    raise monitoring_native.DeliveryError("synthetic outage")

            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value={"node_unavailable"}
            ):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config, deliver=messages.append, deliver_recovery=recovery
                    ),
                    1,
                )
                pending = json.loads(config.state_path.read_text("utf-8"))["pending"]
                self.assertTrue(pending["native_delivered"])
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config, deliver=messages.append, deliver_recovery=recovery
                    ),
                    0,
                )
            self.assertEqual(
                messages,
                [
                    runtime_doctor.incident_message({"node_unavailable"}),
                    runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE,
                ],
            )
            self.assertEqual(recovery_calls[0], recovery_calls[1])
            firing = next(
                event
                for event in recovery_calls[0]
                if event["code"] == "node_unavailable"
            )
            self.assertEqual(firing["status"], "firing")
            self.assertEqual(
                firing["transition_id"],
                runtime_doctor.doctor_transition_id(
                    firing["code"],
                    firing["status"],
                    firing["transition"],
                ),
            )

            with mock.patch.object(runtime_doctor, "collect_incidents", return_value=set()):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config, deliver=messages.append, deliver_recovery=recovery
                    ),
                    0,
                )
            self.assertEqual(
                [
                    message
                    for message in messages
                    if message != runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE
                ],
                [
                    runtime_doctor.incident_message({"node_unavailable"}),
                    runtime_doctor.incident_message(set()),
                ],
            )
            self.assertEqual(
                messages.count(runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE), 1
            )
            self.assertEqual(recovery_calls[-1][0]["status"], "resolved")

    def test_tee_accumulates_each_transition_while_recovery_is_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "tee")
            runtime_doctor.write_delivery_state(config.state_path, set(), None)
            messages: list[str] = []
            recovery_calls: list[list[dict[str, str]]] = []

            def unavailable(events: list[dict[str, str]]) -> None:
                recovery_calls.append([dict(event) for event in events])
                raise monitoring_native.DeliveryError("synthetic supervisor outage")

            observations = [
                {"node_unavailable"},
                {"node_unavailable", "prometheus_unhealthy"},
                {"prometheus_unhealthy"},
                set(),
                set(),
            ]
            for incidents in observations:
                with mock.patch.object(
                    runtime_doctor, "collect_incidents", return_value=incidents
                ):
                    self.assertEqual(
                        runtime_doctor.run_doctor(
                            config,
                            deliver=messages.append,
                            deliver_recovery=unavailable,
                        ),
                        1,
                    )

            restarted = self.config(root, "tee")
            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value=set()
            ):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        restarted,
                        deliver=messages.append,
                        deliver_recovery=lambda events: recovery_calls.append(
                            [dict(event) for event in events]
                        ),
                    ),
                    0,
                )

            native_states = [
                message
                for message in messages
                if message != runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE
            ]
            self.assertEqual(
                native_states,
                [
                    runtime_doctor.incident_message({"node_unavailable"}),
                    runtime_doctor.incident_message(
                        {"node_unavailable", "prometheus_unhealthy"}
                    ),
                    runtime_doctor.incident_message({"prometheus_unhealthy"}),
                    runtime_doctor.incident_message(set()),
                ],
            )
            self.assertEqual(
                messages.count(runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE), 1
            )
            final_batch = recovery_calls[-1]
            self.assertEqual(
                [(event["code"], event["status"]) for event in final_batch],
                [
                    ("node_unavailable", "firing"),
                    ("prometheus_unhealthy", "firing"),
                    ("node_unavailable", "resolved"),
                    ("prometheus_unhealthy", "resolved"),
                ],
            )
            self.assertEqual(
                len({event["transition_id"] for event in final_batch}),
                len(final_batch),
            )
            self.assertEqual(recovery_calls[-3:], [final_batch, final_batch, final_batch])
            state = json.loads(config.state_path.read_text("utf-8"))
            self.assertEqual(state["incidents"], [])
            self.assertNotIn("pending", state)
            self.assertFalse(
                runtime_doctor._recovery_fallback_state_path(config.state_path).exists()
            )

    def test_tee_preserves_pending_batch_when_native_delivery_fails(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "tee")
            runtime_doctor.write_delivery_state(config.state_path, set(), None)
            messages: list[str] = []
            native_attempts: list[str] = []
            recovery_calls: list[list[dict[str, str]]] = []

            def native_failure(message: str) -> None:
                native_attempts.append(message)
                raise monitoring_native.DeliveryError("synthetic native outage")

            def recovery_failure(events: list[dict[str, str]]) -> None:
                recovery_calls.append([dict(event) for event in events])
                raise monitoring_native.DeliveryError("synthetic supervisor outage")

            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value={"node_unavailable"}
            ):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config,
                        deliver=messages.append,
                        deliver_recovery=recovery_failure,
                    ),
                    1,
                )
            self.assertEqual(len(recovery_calls), 1)

            new_incidents = {"node_unavailable", "prometheus_unhealthy"}
            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value=new_incidents
            ):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config,
                        deliver=native_failure,
                        deliver_recovery=recovery_failure,
                    ),
                    1,
                )
            self.assertEqual(len(recovery_calls), 1)
            pending = json.loads(config.state_path.read_text("utf-8"))["pending"]
            self.assertFalse(pending["native_delivered"])
            self.assertEqual(
                pending["target_incidents"],
                ["node_unavailable", "prometheus_unhealthy"],
            )
            self.assertEqual(len(pending["events"]), 2)

            restarted = self.config(root, "tee")
            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value=new_incidents
            ):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        restarted,
                        deliver=messages.append,
                        deliver_recovery=recovery_failure,
                    ),
                    1,
                )
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        restarted,
                        deliver=messages.append,
                        deliver_recovery=lambda events: recovery_calls.append(
                            [dict(event) for event in events]
                        ),
                    ),
                    0,
                )

            expected_state = runtime_doctor.incident_message(new_incidents)
            self.assertEqual(native_attempts, [expected_state])
            self.assertEqual(messages.count(expected_state), 1)
            self.assertEqual(
                messages.count(
                    runtime_doctor.incident_message({"node_unavailable"})
                ),
                1,
            )
            self.assertEqual(
                messages.count(runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE), 1
            )
            self.assertEqual(recovery_calls[1], recovery_calls[2])

    def test_recovery_mode_never_calls_native_notification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "recovery")
            events: list[dict[str, str]] = []
            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value={"node_unavailable"}
            ):
                result = runtime_doctor.run_doctor(
                    config,
                    deliver=lambda _message: self.fail("native notification called"),
                    deliver_recovery=lambda batch: events.extend(batch),
                )
            self.assertEqual(result, 0)
            snapshot = {event["code"]: event["status"] for event in events}
            self.assertEqual(set(snapshot), set(runtime_doctor.INCIDENT_ACTIONS))
            self.assertEqual(snapshot["node_unavailable"], "firing")
            self.assertTrue(
                all(
                    status == "resolved"
                    for code, status in snapshot.items()
                    if code != "node_unavailable"
                )
            )

    def test_lost_state_sends_a_stable_full_source_reconciliation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "recovery")
            recovery_calls: list[list[dict[str, str]]] = []

            def fail(events: list[dict[str, str]]) -> None:
                recovery_calls.append([dict(event) for event in events])
                raise monitoring_native.DeliveryError("synthetic outage")

            config.state_path.write_text("not-json", encoding="utf-8")
            with mock.patch.object(runtime_doctor, "collect_incidents", return_value=set()):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config, deliver=lambda _message: None, deliver_recovery=fail
                    ),
                    1,
                )
                pending = json.loads(config.state_path.read_text("utf-8"))["pending"]
                self.assertEqual(pending["target_incidents"], [])
                self.assertEqual(
                    {event["code"] for event in pending["events"]},
                    set(runtime_doctor.INCIDENT_ACTIONS),
                )
                self.assertTrue(
                    all(event["status"] == "resolved" for event in pending["events"])
                )
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config,
                        deliver=lambda _message: None,
                        deliver_recovery=lambda events: recovery_calls.append(
                            [dict(event) for event in events]
                        ),
                    ),
                    0,
                )
            self.assertEqual(recovery_calls[0], recovery_calls[1])
            self.assertNotIn(
                "pending", json.loads(config.state_path.read_text("utf-8"))
            )

    def test_surviving_queue_replays_before_lost_state_snapshot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "recovery")
            older = runtime_doctor._transition_events(
                set(), {"node_unavailable"}
            )
            runtime_doctor._enqueue_recovery_events(
                config.state_path, older, {"node_unavailable"}
            )
            config.state_path.write_text("not-json", encoding="utf-8")
            delivered: list[list[dict[str, str]]] = []

            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value=set()
            ):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config,
                        deliver=lambda _message: None,
                        deliver_recovery=lambda events: delivered.append(
                            [dict(event) for event in events]
                        ),
                    ),
                    0,
                )
            self.assertEqual(delivered[0], older)
            final_snapshot = {
                event["code"]: event["status"] for event in delivered[-1]
            }
            self.assertEqual(
                set(final_snapshot), set(runtime_doctor.INCIDENT_ACTIONS)
            )
            self.assertTrue(
                all(status == "resolved" for status in final_snapshot.values())
            )
            self.assertNotIn(
                "pending", json.loads(config.state_path.read_text("utf-8"))
            )

    def test_malformed_recovery_queue_does_not_suppress_new_tee_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "tee")
            pending = {
                "events": runtime_doctor._transition_events(
                    set(), {"node_unavailable"}
                ),
                "native_delivered": True,
                "queue_first": False,
                "target_incidents": ["node_unavailable"],
            }
            runtime_doctor.write_delivery_state(config.state_path, set(), pending)
            queue_path = runtime_doctor._recovery_queue_path(config.state_path)
            queue_path.mkdir()
            (queue_path / "malformed.json").write_text("{}", encoding="ascii")
            current = {"node_unavailable", "prometheus_unhealthy"}
            messages: list[str] = []

            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value=current
            ):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config,
                        deliver=messages.append,
                        deliver_recovery=lambda _events: self.fail(
                            "corrupt queue was delivered"
                        ),
                    ),
                    1,
                )
            self.assertEqual(
                messages.count(runtime_doctor.incident_message(current)), 1
            )
            self.assertEqual(
                messages.count(runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE), 1
            )
            stored = json.loads(config.state_path.read_text("utf-8"))["pending"]
            self.assertTrue(stored["native_delivered"])
            self.assertTrue(stored["queue_first"])
            self.assertEqual(stored["target_incidents"], sorted(current))

    def test_queue_enqueue_failure_preserves_tee_and_final_reconciliation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "tee")
            older = runtime_doctor._transition_events(
                set(), {"node_unavailable"}
            )
            pending = {
                "events": older,
                "native_delivered": True,
                "queue_first": False,
                "target_incidents": ["node_unavailable"],
            }
            runtime_doctor.write_delivery_state(config.state_path, set(), pending)
            runtime_doctor._enqueue_recovery_events(
                config.state_path, older, {"node_unavailable"}
            )
            current = {"node_unavailable", "prometheus_unhealthy"}
            messages: list[str] = []
            delivered: list[list[dict[str, str]]] = []

            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value=current
            ), mock.patch.object(
                runtime_doctor,
                "_enqueue_recovery_events",
                side_effect=OSError("synthetic queue write failure"),
            ):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config,
                        deliver=messages.append,
                        deliver_recovery=lambda events: delivered.append(
                            [dict(event) for event in events]
                        ),
                    ),
                    0,
                )
            self.assertEqual(
                messages.count(runtime_doctor.incident_message(current)), 1
            )
            self.assertEqual(
                messages.count(runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE), 1
            )
            final_snapshot = {
                event["code"]: event["status"] for event in delivered[-1]
            }
            self.assertEqual(final_snapshot["node_unavailable"], "firing")
            self.assertEqual(final_snapshot["prometheus_unhealthy"], "firing")
            self.assertNotIn(
                "pending", json.loads(config.state_path.read_text("utf-8"))
            )

    def test_delivery_state_replace_fsyncs_file_and_parent_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "doctor.json"
            with mock.patch.object(runtime_doctor.os, "fsync") as fsync:
                runtime_doctor.write_delivery_state(path, {"node_unavailable"}, None)
            self.assertEqual(fsync.call_count, 2)

    def test_recovery_and_tee_modes_throttle_native_fallback_when_supervisor_is_down(
        self,
    ) -> None:
        for mode in ("recovery", "tee"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = self.config(root, mode)
                runtime_doctor.write_delivery_state(
                    config.state_path, {"node_unavailable"}, None
                )
                messages: list[str] = []

                def unavailable(_events: list[dict[str, str]]) -> None:
                    raise monitoring_native.DeliveryError("synthetic supervisor outage")

                with mock.patch.object(
                    runtime_doctor,
                    "collect_incidents",
                    return_value={"node_unavailable"},
                ):
                    self.assertEqual(
                        runtime_doctor.run_doctor(
                            config, deliver=messages.append, deliver_recovery=unavailable
                        ),
                        1,
                    )
                    self.assertEqual(
                        runtime_doctor.run_doctor(
                            config, deliver=messages.append, deliver_recovery=unavailable
                        ),
                        1,
                    )
                    self.assertEqual(
                        messages, [runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE]
                    )

                    self.assertEqual(
                        runtime_doctor.run_doctor(
                            config,
                            deliver=messages.append,
                            deliver_recovery=lambda _events: None,
                        ),
                        0,
                    )
                    self.assertEqual(
                        runtime_doctor.run_doctor(
                            config, deliver=messages.append, deliver_recovery=unavailable
                        ),
                        1,
                    )
                self.assertEqual(
                    messages,
                    [
                        runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE,
                        runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE,
                    ],
                )

    def test_real_recovery_http_retries_and_sends_authenticated_heartbeats(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            received: list[tuple[str, dict[str, object]]] = []
            statuses = [503, 200]

            class Handler(recovery_supervisor.BaseHTTPRequestHandler):
                def log_message(self, _format: str, *_args: object) -> None:
                    return

                def do_POST(self) -> None:  # noqa: N802
                    length = int(self.headers["Content-Length"])
                    received.append(
                        (
                            self.headers.get("Authorization", ""),
                            json.loads(self.rfile.read(length).decode("ascii")),
                        )
                    )
                    self.send_response(statuses.pop(0))
                    self.send_header("Content-Length", "0")
                    self.end_headers()

            server = recovery_supervisor.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
            config = runtime_doctor.DoctorConfig.from_environ(
                {
                    "MINIME_DOCTOR_STATE_PATH": str(root / "doctor.json"),
                    "MINIME_DOCTOR_SINK": "recovery",
                    "MINIME_DOCTOR_RECOVERY_URL": (
                        f"http://127.0.0.1:{server.server_address[1]}/v1/runtime-doctor"
                    ),
                    "MINIME_DOCTOR_RECOVERY_TOKEN_FILE": str(token),
                    "MINIME_DOCTOR_RECOVERY_ATTEMPTS": "2",
                    "MINIME_DOCTOR_TIMEOUT": "1",
                }
            )
            try:
                runtime_doctor.send_recovery_events(
                    [],
                    config,
                    heartbeats={"runtime_doctor": True, "alertmanager": True},
                    sleep=lambda _delay: None,
                )
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
            self.assertEqual(len(received), 2)
            self.assertEqual(received[0], received[1])
            self.assertEqual(received[0][0], "Bearer synthetic-auth-token-value")
            self.assertEqual(
                received[0][1]["heartbeats"],
                {"runtime_doctor": True, "alertmanager": True},
            )

    def test_run_doctor_production_sender_posts_heartbeat_only_and_health_state(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            received: list[dict[str, object]] = []

            class Handler(recovery_supervisor.BaseHTTPRequestHandler):
                def log_message(self, _format: str, *_args: object) -> None:
                    return

                def do_POST(self) -> None:  # noqa: N802
                    length = int(self.headers["Content-Length"])
                    received.append(json.loads(self.rfile.read(length).decode("ascii")))
                    self.send_response(200)
                    self.send_header("Content-Length", "0")
                    self.end_headers()

            server = recovery_supervisor.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
            config = runtime_doctor.DoctorConfig.from_environ(
                {
                    "MINIME_DOCTOR_STATE_PATH": str(root / "doctor.json"),
                    "MINIME_DOCTOR_SINK": "recovery",
                    "MINIME_DOCTOR_RECOVERY_URL": (
                        f"http://127.0.0.1:{server.server_address[1]}/v1/runtime-doctor"
                    ),
                    "MINIME_DOCTOR_RECOVERY_TOKEN_FILE": str(token),
                    "MINIME_DOCTOR_ALERTMANAGER_URL": "http://127.0.0.1:1/-/healthy",
                    "MINIME_DOCTOR_TIMEOUT": "1",
                }
            )
            observations = (set(), set(), {"alertmanager_unhealthy"})
            try:
                with mock.patch.object(
                    runtime_doctor, "collect_incidents", side_effect=observations
                ):
                    for _observation in observations:
                        self.assertEqual(runtime_doctor.run_doctor(config), 0)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
            self.assertEqual(len(received), 3)
            self.assertEqual(received[0]["heartbeats"], {
                "runtime_doctor": True,
                "alertmanager": True,
            })
            self.assertEqual(received[1]["events"], [])
            self.assertEqual(received[1]["heartbeats"], {
                "runtime_doctor": True,
                "alertmanager": True,
            })
            self.assertEqual(received[2]["heartbeats"], {
                "runtime_doctor": True,
                "alertmanager": False,
            })

    def test_pending_recovery_history_is_chunked_without_state_loss(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "recovery")
            runtime_doctor.write_delivery_state(config.state_path, set(), None)
            all_incidents = set(runtime_doctor.INCIDENT_ACTIONS)
            observations = [all_incidents if index % 2 == 0 else set() for index in range(7)]

            def unavailable(_events: list[dict[str, str]]) -> None:
                raise monitoring_native.DeliveryError("synthetic outage")

            with mock.patch.object(
                runtime_doctor, "collect_incidents", side_effect=observations
            ):
                for _observation in observations:
                    self.assertEqual(
                        runtime_doctor.run_doctor(
                            config,
                            deliver=lambda _message: None,
                            deliver_recovery=unavailable,
                        ),
                        1,
                    )
            state = json.loads(config.state_path.read_text("utf-8"))
            self.assertLess(config.state_path.stat().st_size, runtime_doctor.STATE_MAX_BYTES)
            self.assertLessEqual(
                len(state["pending"]["events"]),
                runtime_doctor.RECOVERY_BATCH_MAX_EVENTS,
            )
            self.assertTrue(runtime_doctor._recovery_queue_items(config.state_path))

            delivered: list[list[dict[str, str]]] = []
            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value=observations[-1]
            ):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config,
                        deliver=lambda _message: None,
                        deliver_recovery=lambda events: delivered.append(
                            [dict(event) for event in events]
                        ),
                    ),
                    0,
                )
            self.assertTrue(delivered)
            self.assertTrue(
                all(
                    1 <= len(batch) <= runtime_doctor.RECOVERY_BATCH_MAX_EVENTS
                    for batch in delivered
                )
            )
            transition_ids = [
                event["transition_id"] for batch in delivered for event in batch
            ]
            self.assertEqual(len(transition_ids), 77)
            self.assertEqual(len(transition_ids), len(set(transition_ids)))
            self.assertNotIn(
                "pending", json.loads(config.state_path.read_text("utf-8"))
            )
            self.assertFalse(runtime_doctor._recovery_queue_path(config.state_path).exists())

    def test_real_recovery_http_does_not_retry_terminal_4xx_or_network_exhaustion(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
            calls = [0]

            class RejectingHandler(recovery_supervisor.BaseHTTPRequestHandler):
                def log_message(self, _format: str, *_args: object) -> None:
                    return

                def do_POST(self) -> None:  # noqa: N802
                    calls[0] += 1
                    self.rfile.read(int(self.headers["Content-Length"]))
                    self.send_response(400)
                    self.send_header("Content-Length", "0")
                    self.end_headers()

            server = recovery_supervisor.ThreadingHTTPServer(
                ("127.0.0.1", 0), RejectingHandler
            )
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            port = server.server_address[1]

            def config_for(target_port: int) -> runtime_doctor.DoctorConfig:
                return runtime_doctor.DoctorConfig.from_environ(
                    {
                        "MINIME_DOCTOR_STATE_PATH": str(root / "doctor.json"),
                        "MINIME_DOCTOR_SINK": "recovery",
                        "MINIME_DOCTOR_RECOVERY_URL": (
                            f"http://127.0.0.1:{target_port}/v1/runtime-doctor"
                        ),
                        "MINIME_DOCTOR_RECOVERY_TOKEN_FILE": str(token),
                        "MINIME_DOCTOR_RECOVERY_ATTEMPTS": "2",
                        "MINIME_DOCTOR_TIMEOUT": "1",
                    }
                )

            try:
                with self.assertRaises(monitoring_native.MonitoringError):
                    runtime_doctor.send_recovery_events([], config_for(port), sleep=lambda _delay: None)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
            self.assertEqual(calls[0], 1)

            unused = socket.socket()
            unused.bind(("127.0.0.1", 0))
            unused_port = unused.getsockname()[1]
            unused.close()
            with self.assertRaises(monitoring_native.MonitoringError):
                runtime_doctor.send_recovery_events(
                    [], config_for(unused_port), sleep=lambda _delay: None
                )

    def test_authentication_token_files_must_be_owner_only_and_not_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o644)
            with self.assertRaises(ValueError):
                recovery_supervisor.read_auth_token(token)
            with self.assertRaises(monitoring_native.MonitoringError):
                runtime_doctor._read_recovery_token(token)
            token.chmod(0o600)
            self.assertEqual(
                recovery_supervisor.read_auth_token(token), "synthetic-auth-token-value"
            )
            link = root / "auth-token-link"
            link.symlink_to(token)
            with self.assertRaises(ValueError):
                recovery_supervisor.read_auth_token(link)


class SupervisorStartupTests(unittest.TestCase):
    @staticmethod
    def _write_config(root: Path, *, port: int = 9877) -> None:
        (root / "recovery.json").write_text(
            json.dumps(
                {
                    "version": 1,
                    "mode": "observe",
                    "database": "ledger.sqlite3",
                    "spoolDirectory": "spool",
                    "authTokenFile": "auth-token",
                    "host": "127.0.0.1",
                    "port": port,
                    "correlationRules": [],
                    "sourceIds": ["alertmanager", "runtime_doctor"],
                    "probes": [],
                    "runtimeDoctorCadenceSeconds": 300,
                    "verificationFreshnessSeconds": 660,
                    "verificationHoldDownSeconds": 60,
                }
            ),
            encoding="utf-8",
        )

    def test_listener_ownership_precedes_policy_publication(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
            (root / "recovery.json").write_text(
                json.dumps(
                    {
                        "version": 1,
                        "mode": "observe",
                        "database": "ledger.sqlite3",
                        "spoolDirectory": "spool",
                        "authTokenFile": "auth-token",
                        "host": "127.0.0.1",
                        "port": 9877,
                        "correlationRules": [],
                        "sourceIds": ["alertmanager", "runtime_doctor"],
                        "probes": [],
                        "runtimeDoctorCadenceSeconds": 300,
                        "verificationFreshnessSeconds": 660,
                        "verificationHoldDownSeconds": 60,
                    }
                ),
                encoding="utf-8",
            )
            with (
                mock.patch.object(
                    recovery_supervisor,
                    "BoundedThreadingHTTPServer",
                    side_effect=OSError("synthetic bind race"),
                ),
                mock.patch.object(
                    recovery_supervisor, "_build_recovery_service"
                ) as build_service,
            ):
                result = recovery_supervisor.main(
                    [
                        "--workspace",
                        str(root),
                        "--config",
                        "recovery.json",
                    ]
                )
            self.assertEqual(result, 1)
            build_service.assert_not_called()
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM policy_revisions"
                    ).fetchone()[0],
                    1,
                )

    def test_startup_requires_closed_config_and_rejects_legacy_raw_flags(self) -> None:
        with self.assertRaises(SystemExit) as missing:
            recovery_supervisor.main(["--workspace", "/tmp/example"])
        self.assertEqual(missing.exception.code, 2)
        with self.assertRaises(SystemExit) as legacy:
            recovery_supervisor.main(
                [
                    "--workspace",
                    "/tmp/example",
                    "--config",
                    "recovery.json",
                    "--db",
                    "/tmp/example/ledger.sqlite3",
                ]
            )
        self.assertEqual(legacy.exception.code, 2)

    def test_sigterm_requests_graceful_service_shutdown(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
            self._write_config(root)
            server = mock.Mock()
            service = mock.Mock()

            def terminate_during_request(**_kwargs: object) -> None:
                handler = recovery_supervisor.signal.getsignal(
                    recovery_supervisor.signal.SIGTERM
                )
                self.assertTrue(callable(handler))
                handler(recovery_supervisor.signal.SIGTERM, None)

            server.serve_forever.side_effect = terminate_during_request
            with (
                mock.patch.object(
                    recovery_supervisor, "BoundedThreadingHTTPServer", return_value=server
                ),
                mock.patch.object(
                    recovery_supervisor,
                    "_build_recovery_service",
                    return_value=service,
                ),
            ):
                result = recovery_supervisor.main(
                    [
                        "--workspace",
                        str(root),
                        "--config",
                        "recovery.json",
                    ]
                )
            self.assertEqual(result, 0)
            server.server_close.assert_called_once_with()

    def test_http_acceptance_continues_while_maintenance_is_blocked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
            reservation = socket.socket()
            reservation.bind(("127.0.0.1", 0))
            port = int(reservation.getsockname()[1])
            reservation.close()
            self._write_config(root, port=port)
            maintenance_started = threading.Event()
            release_maintenance = threading.Event()
            service = mock.Mock()
            service.health.return_value = recovery_supervisor.IntakeResult(200, "ok")

            def blocked_maintenance() -> None:
                maintenance_started.set()
                release_maintenance.wait(3)
                raise KeyboardInterrupt

            service.maintenance.side_effect = blocked_maintenance
            result: list[int] = []
            with mock.patch.object(
                recovery_supervisor, "_build_recovery_service", return_value=service
            ):
                supervisor = threading.Thread(
                    target=lambda: result.append(
                        recovery_supervisor.main(
                            [
                                "--workspace",
                                str(root),
                                "--config",
                                "recovery.json",
                            ]
                        )
                    )
                )
                supervisor.start()
                self.assertTrue(maintenance_started.wait(3))
                connection = http.client.HTTPConnection("127.0.0.1", port, timeout=1)
                connection.request(
                    "GET",
                    "/healthz",
                    headers={"Authorization": "Bearer synthetic-auth-token-value"},
                )
                self.assertEqual(connection.getresponse().status, 200)
                connection.close()
                release_maintenance.set()
                supervisor.join(timeout=5)
            self.assertFalse(supervisor.is_alive())
            self.assertEqual(result, [0])

    def test_temporary_startup_ledger_failure_keeps_spool_only_intake_available(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
            self._write_config(root)
            captured: list[recovery_supervisor.RecoveryApplication] = []
            server = mock.Mock()
            server.handle_request.side_effect = KeyboardInterrupt

            def capture(app: recovery_supervisor.RecoveryApplication) -> object:
                captured.append(app)
                return object

            with (
                mock.patch.object(
                    recovery_supervisor,
                    "RecoveryLedger",
                    side_effect=recovery_ledger.LedgerUnavailable("synthetic startup lock"),
                ),
                mock.patch.object(recovery_supervisor, "handler_for", side_effect=capture),
                mock.patch.object(
                    recovery_supervisor, "BoundedThreadingHTTPServer", return_value=server
                ),
            ):
                result = recovery_supervisor.main(
                    [
                        "--workspace",
                        str(root),
                        "--config",
                        "recovery.json",
                    ]
                )
            self.assertEqual(result, 0)
            self.assertEqual(len(captured), 1)
            intake = captured[0].service.accept(
                recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
            )
            self.assertEqual(intake.status, 202)
            self.assertEqual(len(list((root / "spool" / "events").glob("*.json"))), 1)

    def test_corruption_triggers_only_compact_native_escalation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "ledger.sqlite3"
            database.write_bytes(b"corrupt database with private-looking material")
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
            self._write_config(root)
            messages: list[str] = []
            with mock.patch.object(recovery_supervisor, "send_telegram", side_effect=lambda message, _config: messages.append(message)):
                result = recovery_supervisor.main(
                    [
                        "--workspace",
                        str(root),
                        "--config",
                        "recovery.json",
                        "--chat-id",
                        "10001",
                    ]
                )
            self.assertEqual(result, 1)
            self.assertEqual(len(messages), 1)
            self.assertIn("ledger integrity", messages[0])
            self.assertNotIn("private-looking", messages[0])
            self.assertEqual(database.read_bytes(), b"corrupt database with private-looking material")


if __name__ == "__main__":
    unittest.main()
