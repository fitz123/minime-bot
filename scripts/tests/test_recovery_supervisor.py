from __future__ import annotations

import http.client
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import threading
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import monitoring_native
import recovery_ledger
import recovery_supervisor
import runtime_doctor


def alert_body(*alerts: dict[str, object]) -> bytes:
    return json.dumps({"alerts": list(alerts)}, separators=(",", ":")).encode("utf-8")


def firing_alert(fingerprint: str = "synthetic-1") -> dict[str, object]:
    return {
        "status": "firing",
        "fingerprint": fingerprint,
        "startsAt": "2026-07-14T00:00:00Z",
        "labels": {
            "alertname": "SyntheticDown",
            "component": "synthetic",
            "failure_class": "unavailable",
            "instance": "test",
        },
        "annotations": {"private_payload": "must not be persisted"},
    }


class FailingLedger:
    def record_events(self, _events: object) -> int:
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
            self.assertEqual(ledger.record_events(events), 2)
            self.assertEqual(ledger.record_events(events[:1]), 0)
            ledger.close()

            reopened = recovery_ledger.RecoveryLedger(path)
            self.assertEqual(reopened.record_events(events), 0)
            self.assertEqual(reopened.connection.execute("SELECT count(*) FROM events").fetchone()[0], 2)
            stored = reopened.connection.execute("SELECT normalized_json FROM events ORDER BY id").fetchall()
            self.assertTrue(all("private_payload" not in row[0] for row in stored))
            reopened.close()

    def test_schema_mismatch_corruption_and_lock_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version_path = root / "version.sqlite3"
            with recovery_ledger.RecoveryLedger(version_path) as ledger:
                ledger.connection.execute("PRAGMA user_version=2")
            with self.assertRaises(recovery_ledger.LedgerCorrupt):
                recovery_ledger.RecoveryLedger(version_path)

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
            finally:
                locker.execute("ROLLBACK")
                locker.close()
                ledger.close()


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
            self.assertIn("persistence failed", messages[-1].lower())
            self.assertNotIn("SyntheticDown", messages[-1])

    def test_emergency_delivery_is_atomic_throttled_and_drained(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            delivered: list[str] = []
            available = False

            def delivery(message: str) -> None:
                if not available:
                    raise monitoring_native.DeliveryError("synthetic outage")
                delivered.append(message)

            notifier = recovery_supervisor.EmergencyNotifier(
                root / "notifications", delivery=delivery, cooldown=300, clock=lambda: 1_000
            )
            notifier.emit("ledger_corrupt")
            self.assertEqual(len(list((root / "notifications").glob("*.json"))), 1)
            available = True
            notifier.drain()
            self.assertEqual(len(delivered), 1)
            self.assertEqual(list((root / "notifications").glob("*.json")), [])
            notifier.emit("ledger_corrupt")
            self.assertEqual(len(delivered), 1)


class RecoveryHttpTests(unittest.TestCase):
    def test_authenticated_health_and_input_limits(self) -> None:
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
            finally:
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
        return runtime_doctor.DoctorConfig.from_environ(
            {
                "MINIME_DOCTOR_STATE_PATH": str(root / "doctor.json"),
                "MINIME_DOCTOR_SINK": mode,
                "MINIME_DOCTOR_RECOVERY_URL": "http://127.0.0.1:9877/v1/runtime-doctor",
                "MINIME_DOCTOR_RECOVERY_TOKEN_FILE": str(token),
                "MINIME_TELEGRAM_CHAT_ID": "10001",
            }
        )

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
            self.assertEqual(len(messages), 1)
            self.assertEqual(recovery_calls[0], recovery_calls[1])
            self.assertEqual(recovery_calls[0][0]["status"], "firing")
            self.assertEqual(
                recovery_calls[0][0]["transition_id"],
                runtime_doctor.doctor_transition_id(
                    recovery_calls[0][0]["code"],
                    recovery_calls[0][0]["status"],
                    recovery_calls[0][0]["transition"],
                ),
            )

            with mock.patch.object(runtime_doctor, "collect_incidents", return_value=set()):
                self.assertEqual(
                    runtime_doctor.run_doctor(
                        config, deliver=messages.append, deliver_recovery=recovery
                    ),
                    0,
                )
            self.assertEqual(len(messages), 2)
            self.assertEqual(recovery_calls[-1][0]["status"], "resolved")

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
            self.assertEqual([event["status"] for event in events], ["firing"])


class SupervisorStartupTests(unittest.TestCase):
    def test_corruption_triggers_only_compact_native_escalation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            database = root / "ledger.sqlite3"
            database.write_bytes(b"corrupt database with private-looking material")
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            messages: list[str] = []
            with mock.patch.object(recovery_supervisor, "send_telegram", side_effect=lambda message, _config: messages.append(message)):
                result = recovery_supervisor.main(
                    [
                        "--db",
                        str(database),
                        "--spool-dir",
                        str(root / "spool"),
                        "--auth-token-file",
                        str(token),
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
