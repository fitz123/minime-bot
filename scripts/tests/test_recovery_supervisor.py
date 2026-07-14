from __future__ import annotations

import http.client
import json
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


def correlation_policy(
    *,
    lease_seconds: float = 30,
    reevaluation_delay: float = 60,
    max_reevaluations: int = 1,
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
        reevaluation_delays=(
            ("malformed_output", reevaluation_delay),
            ("not_actionable", reevaluation_delay),
            ("observe", reevaluation_delay),
        ),
        max_reevaluations=max_reevaluations,
        lease_seconds=lease_seconds,
    )


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
    def test_cross_source_correlation_groups_one_incident_and_one_launch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                )
                ledger.record_events(
                    doctor_events(("node_unavailable", "firing", "doctor-firing-1"))
                )
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="supervisor-one"
                )
                self.assertEqual(coordinator.reconcile(), 1)
                incidents = ledger.connection.execute("SELECT * FROM incidents").fetchall()
                self.assertEqual(len(incidents), 1)
                self.assertEqual(incidents[0]["correlation_key"], "bot-unavailable")
                fence = coordinator.claim_next()
                self.assertIsNotNone(fence)
                self.assertIsNone(coordinator.claim_next())
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0],
                    1,
                )

    def test_unchanged_suppressing_outcomes_do_not_relaunch(self) -> None:
        for outcome in (
            "observe",
            "not_actionable",
            "malformed_output",
            "pending_approval",
            "retries_exhausted",
        ):
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                clock = [100.0]
                with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                    ledger.record_events(
                        recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                    )
                    coordinator = recovery_supervisor.IncidentCoordinator(
                        ledger,
                        correlation_policy(),
                        owner="supervisor-one",
                        clock=lambda: clock[0],
                    )
                    fence = coordinator.claim_next()
                    self.assertIsNotNone(fence)
                    assert fence is not None
                    self.assertTrue(coordinator.finish(fence, outcome))
                    ledger.record_events(
                        recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                    )
                    self.assertIsNone(coordinator.claim_next())
                    self.assertEqual(
                        ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0],
                        1,
                    )

    def test_material_evidence_and_explicit_retry_create_new_generations(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="supervisor-one"
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(firing_alert("one")))
                )
                first = coordinator.claim_next()
                self.assertIsNotNone(first)
                assert first is not None
                self.assertTrue(coordinator.finish(first, "not_actionable"))

                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(
                            firing_alert(
                                "two", starts_at="2026-07-14T00:01:00Z"
                            )
                        )
                    )
                )
                second = coordinator.claim_next()
                self.assertIsNotNone(second)
                assert second is not None
                self.assertEqual(second.generation, first.generation + 1)
                self.assertNotEqual(second.evidence_hash, first.evidence_hash)
                self.assertTrue(coordinator.finish(second, "pending_approval"))

                self.assertTrue(
                    coordinator.explicit_retry(second.incident_id, reason="operator requested retry")
                )
                third = coordinator.claim_next()
                self.assertIsNotNone(third)
                assert third is not None
                self.assertEqual(third.generation, second.generation + 1)
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT operation FROM audit ORDER BY id DESC LIMIT 1"
                    ).fetchone()[0],
                    "explicit_retry",
                )

    def test_explicit_retry_does_not_redispatch_unrelated_incidents(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                policy = recovery_supervisor.RecoveryPolicy(
                    revision=1,
                    rules=(
                        recovery_supervisor.CorrelationRule(
                            "synthetic", "unavailable", "incident-one", impact=2
                        ),
                        recovery_supervisor.CorrelationRule(
                            "synthetic", "degraded", "incident-two", impact=2
                        ),
                    ),
                )
                controls = recovery_supervisor.RecoveryControls(ledger)
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, policy, owner="supervisor-one", controls=controls
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(
                            firing_alert("one"),
                            firing_alert("two", failure_class="degraded"),
                        )
                    )
                )
                first = coordinator.claim_next()
                self.assertIsNotNone(first)
                assert first is not None
                self.assertTrue(coordinator.finish(first, "not_actionable"))
                second = coordinator.claim_next()
                self.assertIsNotNone(second)
                assert second is not None
                self.assertTrue(coordinator.finish(second, "not_actionable"))
                effective_revision = controls.current().revision

                self.assertTrue(
                    coordinator.explicit_retry(
                        first.incident_id, reason="retry only the reviewed incident"
                    )
                )
                coordinator.reconcile()
                unrelated = ledger.connection.execute(
                    "SELECT state, generation, policy_revision FROM incidents WHERE id = ?",
                    (second.incident_id,),
                ).fetchone()
                self.assertEqual(
                    tuple(unrelated),
                    ("not_actionable", second.generation, effective_revision),
                )
                self.assertEqual(controls.current().revision, effective_revision)
                self.assertGreater(
                    ledger.connection.execute(
                        "SELECT max(revision) FROM policy_revisions"
                    ).fetchone()[0],
                    effective_revision,
                )
                retried = coordinator.claim_next()
                self.assertIsNotNone(retried)
                assert retried is not None
                self.assertEqual(retried.incident_id, first.incident_id)
                self.assertTrue(coordinator.finish(retried, "not_actionable"))
                self.assertIsNone(coordinator.claim_next())

    def test_resolved_first_and_out_of_order_events_do_not_false_fire(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="supervisor-one"
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(resolved_alert("episode-one"))
                    )
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("episode-one"))
                    )
                )
                self.assertEqual(coordinator.reconcile(), 0)
                self.assertIsNone(coordinator.claim_next())

                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(
                            firing_alert(
                                "episode-one", starts_at="2026-07-14T00:20:00Z"
                            )
                        )
                    )
                )
                self.assertEqual(coordinator.reconcile(), 1)
                self.assertIsNotNone(coordinator.claim_next())

    def test_concurrent_global_lease_and_crash_reconciliation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ledger.sqlite3"
            clock = [100.0]
            first_ledger = recovery_ledger.RecoveryLedger(path)
            second_ledger = recovery_ledger.RecoveryLedger(path)
            try:
                first_ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                )
                policy = correlation_policy(lease_seconds=10)
                first = recovery_supervisor.IncidentCoordinator(
                    first_ledger,
                    policy,
                    owner="supervisor-one",
                    clock=lambda: clock[0],
                )
                second = recovery_supervisor.IncidentCoordinator(
                    second_ledger,
                    policy,
                    owner="supervisor-two",
                    clock=lambda: clock[0],
                )
                abandoned = first.claim_next()
                self.assertIsNotNone(abandoned)
                self.assertIsNone(second.claim_next())

                clock[0] = 111.0
                recovered = second.claim_next()
                self.assertIsNotNone(recovered)
                assert abandoned is not None and recovered is not None
                self.assertEqual(recovered.generation, abandoned.generation + 1)
                self.assertEqual(
                    second_ledger.connection.execute(
                        "SELECT state FROM invocations WHERE id = ?", (abandoned.invocation_id,)
                    ).fetchone()[0],
                    "interrupted",
                )
            finally:
                second_ledger.close()
                first_ledger.close()

    def test_stale_fence_is_rejected_after_material_evidence_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="supervisor-one"
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(firing_alert("one")))
                )
                stale = coordinator.claim_next()
                self.assertIsNotNone(stale)
                assert stale is not None
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(
                            firing_alert(
                                "two", starts_at="2026-07-14T00:01:00Z"
                            )
                        )
                    )
                )
                self.assertFalse(coordinator.finish(stale, "completed"))
                current = coordinator.claim_next()
                self.assertIsNotNone(current)
                assert current is not None
                self.assertGreater(current.generation, stale.generation)

    def test_bounded_reevaluation_launches_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                )
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(reevaluation_delay=10, max_reevaluations=1),
                    owner="supervisor-one",
                    clock=lambda: clock[0],
                )
                first = coordinator.claim_next()
                self.assertIsNotNone(first)
                assert first is not None
                self.assertTrue(coordinator.finish(first, "observe"))
                clock[0] = 109.0
                self.assertIsNone(coordinator.claim_next())
                clock[0] = 110.0
                second = coordinator.claim_next()
                self.assertIsNotNone(second)
                assert second is not None
                self.assertTrue(coordinator.finish(second, "observe"))
                clock[0] = 120.0
                self.assertIsNone(coordinator.claim_next())
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0],
                    2,
                )

    def test_confirmed_impact_and_terminal_failures_use_immediate_escalation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            escalations: list[str] = []
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                controls = recovery_supervisor.RecoveryControls(ledger)
                adapter = recovery_supervisor.BoundedPolicyAdapter(ledger, controls)
                ledger.record_events(
                    doctor_events(("node_unavailable", "firing", "doctor-critical"))
                )
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(),
                    owner="supervisor-one",
                    controls=controls,
                    immediate_escalation=escalations.append,
                    mechanical_outcome=adapter.record_outcome,
                )
                coordinator.reconcile()
                coordinator.reconcile()
                self.assertIn("confirmed_impact", escalations)
                impact_rows = ledger.connection.execute(
                    "SELECT count(*) FROM audit WHERE operation = 'mechanical_outcome' "
                    "AND details_json LIKE '%\"classification\":\"impact\"%'"
                ).fetchone()[0]
                self.assertEqual(impact_rows, 1)

        expected = {
            "pending_approval": "approval_required",
            "pi_unavailable": "pi_unavailable",
            "recovery_failed": "recovery_failed",
            "recovery_unsafe": "recovery_unsafe",
            "retries_exhausted": "retries_exhausted",
        }
        for outcome, escalation in expected.items():
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as directory:
                escalations = []
                with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                    ledger.record_events(
                        recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                    )
                    coordinator = recovery_supervisor.IncidentCoordinator(
                        ledger,
                        correlation_policy(),
                        owner="supervisor-one",
                        immediate_escalation=escalations.append,
                    )
                    fence = coordinator.claim_next()
                    self.assertIsNotNone(fence)
                    assert fence is not None
                    self.assertTrue(coordinator.finish(fence, outcome))
                    self.assertEqual(escalations, [escalation])

    def test_lease_renewal_keeps_one_owner_and_rejects_changed_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(firing_alert("one")))
                )
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(lease_seconds=2),
                    owner="supervisor-one",
                    clock=lambda: clock[0],
                )
                fence = coordinator.claim_next()
                self.assertIsNotNone(fence)
                assert fence is not None
                clock[0] = 101.5
                self.assertTrue(coordinator.renew_lease(fence))
                lease_expiry = ledger.connection.execute(
                    "SELECT expires_at FROM fixer_lease WHERE singleton = 1"
                ).fetchone()[0]
                self.assertEqual(lease_expiry, 103.5)
                contender = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(lease_seconds=2),
                    owner="supervisor-two",
                    clock=lambda: clock[0],
                )
                self.assertIsNone(contender.claim_next())
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("two", starts_at="2026-07-14T00:01:00Z"))
                    )
                )
                self.assertFalse(coordinator.renew_lease(fence))


class RecoveryControlTests(unittest.TestCase):
    def test_controls_expire_and_rollback_with_complete_revision_audits(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                controls = recovery_supervisor.RecoveryControls(
                    ledger, clock=lambda: clock[0]
                )
                dispatch_revision = controls.set_dispatch(
                    False,
                    actor="operator",
                    reason="bounded maintenance",
                    expires_at=150.0,
                )
                self.assertFalse(controls.current().dispatch_enabled)
                clock[0] = 151.0
                expiry_revision = controls.expire()
                self.assertIsNotNone(expiry_revision)
                self.assertTrue(controls.current().dispatch_enabled)

                confirmation_revision = controls.set_confirmation_count(
                    2, actor="operator", reason="require corroboration"
                )
                cooldown_revision = controls.set_cooldown(
                    120, actor="operator", reason="bound repeated planning"
                )
                retry_revision = controls.set_retry_budget(
                    2, actor="operator", reason="bounded retry allowance"
                )
                silence_revision = controls.silence(
                    "bot-unavailable",
                    actor="operator",
                    reason="known maintenance",
                    expires_at=200.0,
                )
                rollback_revision = controls.rollback(
                    confirmation_revision,
                    actor="operator",
                    reason="restore reviewed controls",
                )
                revisions = [
                    dispatch_revision,
                    expiry_revision,
                    confirmation_revision,
                    cooldown_revision,
                    retry_revision,
                    silence_revision,
                    rollback_revision,
                ]
                self.assertEqual(revisions, sorted(revisions))
                snapshot = controls.current()
                self.assertEqual(snapshot.confirmation_count, 2)
                self.assertEqual(snapshot.cooldown_seconds, 0)
                self.assertEqual(snapshot.retry_budget, 1)
                self.assertEqual(snapshot.silences, ())

                audits = ledger.connection.execute(
                    "SELECT actor, operation, details_json FROM audit ORDER BY id"
                ).fetchall()
                self.assertEqual(len(audits), len(revisions))
                self.assertEqual(
                    [row["operation"] for row in audits],
                    [
                        "dispatch_control",
                        "control_expiry",
                        "confirmation_control",
                        "cooldown_control",
                        "retry_budget_control",
                        "silence_control",
                        "policy_rollback",
                    ],
                )
                for row in audits:
                    details = json.loads(row["details_json"])
                    self.assertEqual(
                        set(details),
                        {"after", "before", "expires_at", "reason", "revision"},
                    )
                    self.assertIsInstance(details["revision"], int)
                    self.assertTrue(details["reason"])

    def test_replacing_expired_temporary_control_reverts_to_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                controls = recovery_supervisor.RecoveryControls(
                    ledger, clock=lambda: clock[0]
                )
                controls.set_dispatch(
                    False,
                    actor="operator",
                    reason="first window",
                    expires_at=110.0,
                )
                clock[0] = 111.0
                controls.set_dispatch(
                    False,
                    actor="operator",
                    reason="second window",
                    expires_at=120.0,
                )
                clock[0] = 121.0
                self.assertTrue(controls.current().dispatch_enabled)
                controls.expire()
                self.assertTrue(controls.current().dispatch_enabled)

    def test_static_configuration_is_revision_fenced_and_rollback_preserves_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                controls = recovery_supervisor.RecoveryControls(ledger)
                first = controls.ensure_static_policy(
                    {"version": 1, "mode": "plan", "runbooks": [{"id": "one"}]}
                )
                same = controls.ensure_static_policy(
                    {"version": 1, "mode": "plan", "runbooks": [{"id": "one"}]}
                )
                self.assertEqual(same, first)
                control_revision = controls.set_cooldown(
                    60, actor="operator", reason="reviewed cooldown"
                )
                changed = controls.ensure_static_policy(
                    {"version": 1, "mode": "plan", "runbooks": [{"id": "two"}]}
                )
                self.assertGreater(changed, control_revision)
                rollback = controls.rollback(
                    control_revision, actor="operator", reason="restore controls only"
                )
                document = json.loads(
                    ledger.connection.execute(
                        "SELECT policy_json FROM policy_revisions WHERE revision = ?", (rollback,)
                    ).fetchone()[0]
                )
                self.assertEqual(document["recovery_static"]["runbooks"], [{"id": "two"}])

    def test_running_coordinator_fails_closed_after_static_policy_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                controls = recovery_supervisor.RecoveryControls(ledger)
                original = {"version": 1, "mode": "enabled", "runbooks": [{"id": "one"}]}
                revision = controls.ensure_static_policy(original)
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    recovery_supervisor.RecoveryPolicy(
                        revision=revision, rules=correlation_policy().rules
                    ),
                    owner="supervisor-one",
                    controls=controls,
                    static_policy=original,
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("one"))
                    )
                )
                controls.ensure_static_policy(
                    {"version": 1, "mode": "observe", "runbooks": []}
                )

                self.assertIsNone(coordinator.claim_next())
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM incidents").fetchone()[0],
                    0,
                )
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0],
                    0,
                )

    def test_static_policy_change_invalidates_an_active_worker_fence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                controls = recovery_supervisor.RecoveryControls(ledger)
                original = {"version": 1, "mode": "enabled", "runbooks": []}
                revision = controls.ensure_static_policy(original)
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    recovery_supervisor.RecoveryPolicy(
                        revision=revision, rules=correlation_policy().rules
                    ),
                    owner="supervisor-one",
                    controls=controls,
                    static_policy=original,
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("one"))
                    )
                )
                fence = coordinator.claim_next()
                self.assertIsNotNone(fence)
                assert fence is not None

                controls.ensure_static_policy(
                    {"version": 1, "mode": "observe", "runbooks": []}
                )
                self.assertFalse(coordinator.renew_lease(fence))
                self.assertFalse(coordinator.finish(fence, "completed"))

    def test_dispatch_confirmation_cooldown_silence_and_retry_budget_gate_claims(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                controls = recovery_supervisor.RecoveryControls(
                    ledger, clock=lambda: clock[0]
                )
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(),
                    owner="supervisor-one",
                    clock=lambda: clock[0],
                    controls=controls,
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert("one"))
                    )
                )
                controls.set_dispatch(False, actor="operator", reason="pause planning")
                self.assertIsNone(coordinator.claim_next())
                controls.set_dispatch(True, actor="operator", reason="resume planning")
                controls.set_confirmation_count(
                    2, actor="operator", reason="require two episodes"
                )
                self.assertIsNone(coordinator.claim_next())
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(
                            firing_alert("two", starts_at="2026-07-14T00:01:00Z")
                        )
                    )
                )
                controls.silence(
                    "bot-unavailable",
                    actor="operator",
                    reason="short maintenance",
                    expires_at=110.0,
                )
                self.assertIsNone(coordinator.claim_next())
                clock[0] = 111.0
                first = coordinator.claim_next()
                self.assertIsNotNone(first)
                assert first is not None
                self.assertTrue(coordinator.finish(first, "not_actionable"))
                controls.set_cooldown(60, actor="operator", reason="slow repeated planning")
                controls.set_retry_budget(1, actor="operator", reason="one explicit retry")
                self.assertTrue(
                    coordinator.explicit_retry(
                        first.incident_id,
                        actor="operator",
                        reason="reviewed retry",
                    )
                )
                self.assertFalse(
                    coordinator.explicit_retry(
                        first.incident_id,
                        actor="operator",
                        reason="second retry refused",
                    )
                )
                self.assertIsNone(coordinator.claim_next())
                clock[0] = 172.0
                self.assertIsNotNone(coordinator.claim_next())

    def test_disabled_dispatch_keeps_intake_source_health_digest_audit_and_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            clock = [1_000.0]
            delivered: list[str] = []
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                emergency = recovery_supervisor.EmergencyNotifier(
                    root / "notifications",
                    delivery=delivered.append,
                    cooldown=0,
                    clock=lambda: clock[0],
                )
                controls = recovery_supervisor.RecoveryControls(
                    ledger, clock=lambda: clock[0]
                )
                notifications = recovery_supervisor.RecoveryNotificationOutbox(
                    ledger, emergency=emergency, clock=lambda: clock[0]
                )
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(),
                    owner="supervisor-one",
                    clock=lambda: clock[0],
                    controls=controls,
                    immediate_escalation=notifications.immediate_escalation,
                )
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    source_ids=("alertmanager",),
                    clock=lambda: clock[0],
                )
                service = recovery_supervisor.RecoveryService(
                    ledger,
                    recovery_supervisor.AtomicJsonSpool(root / "events"),
                    emergency,
                    coordinator,
                    verifier,
                    notifications=notifications,
                )
                controls.set_dispatch(False, actor="operator", reason="observe only")
                events = recovery_supervisor.normalize_alertmanager(
                    alert_body(firing_alert())
                )
                self.assertEqual(service.accept(events).status, 200)
                self.assertIsNone(coordinator.claim_next())
                self.assertIsNotNone(
                    ledger.connection.execute(
                        "SELECT value FROM metadata WHERE key = 'verification:heartbeat:alertmanager'"
                    ).fetchone()
                )
                digest = notifications.queue_digest(900, 1_000)
                self.assertEqual(digest["kind"], "digest")
                self.assertTrue(notifications.immediate_escalation("pi_unavailable"))
                self.assertEqual(len(delivered), 1)
                self.assertGreater(
                    ledger.connection.execute("SELECT count(*) FROM audit").fetchone()[0], 0
                )


class BoundedAdaptationTests(unittest.TestCase):
    def test_adaptation_requires_three_outcomes_runs_daily_and_reverts_after_impact(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100_000.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                immutable_policy = {
                    "alert_definitions": ["reviewed-alert"],
                    "allowlists": [],
                    "escalation_classes": ["critical"],
                    "fallback": {"enabled": True},
                }
                ledger.add_policy_revision(
                    2,
                    immutable_policy,
                    actor="operator",
                    reason="reviewed policy",
                    now=clock[0] - 1,
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                )
                controls = recovery_supervisor.RecoveryControls(
                    ledger, clock=lambda: clock[0]
                )
                controls.set_retry_budget(2, actor="operator", reason="reviewed retry bound")
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(),
                    owner="supervisor-one",
                    clock=lambda: clock[0],
                    controls=controls,
                )
                coordinator.reconcile()
                incident_id = int(
                    ledger.connection.execute("SELECT id FROM incidents").fetchone()[0]
                )
                adapter = recovery_supervisor.BoundedPolicyAdapter(
                    ledger, controls, clock=lambda: clock[0]
                )
                adapter.record_outcome(incident_id, "false_positive")
                adapter.record_outcome(incident_id, "false_positive")
                self.assertIsNone(adapter.adapt())
                adapter.record_outcome(incident_id, "false_positive")
                adapted_revision = adapter.adapt()
                self.assertIsNotNone(adapted_revision)
                adapted = controls.current()
                self.assertEqual(
                    (adapted.confirmation_count, adapted.cooldown_seconds), (2, 60.0)
                )
                self.assertEqual(adapted.retry_budget, 2)
                self.assertTrue(adapted.dispatch_enabled)
                self.assertIsNone(adapter.adapt())

                clock[0] += 86_400
                for _ in range(3):
                    adapter.record_outcome(incident_id, "impact", critical=True)
                reverted_revision = adapter.adapt()
                self.assertIsNotNone(reverted_revision)
                reverted = controls.current()
                self.assertEqual(
                    (reverted.confirmation_count, reverted.cooldown_seconds), (1, 0.0)
                )
                self.assertEqual(reverted.retry_budget, 2)
                self.assertTrue(reverted.dispatch_enabled)
                stored_policy = json.loads(
                    ledger.connection.execute(
                        "SELECT policy_json FROM policy_revisions ORDER BY revision DESC LIMIT 1"
                    ).fetchone()[0]
                )
                for key, value in immutable_policy.items():
                    self.assertEqual(stored_policy[key], value)
                self.assertGreater(int(reverted_revision), int(adapted_revision))
                operations = [
                    row[0]
                    for row in ledger.connection.execute(
                        "SELECT operation FROM audit ORDER BY id"
                    ).fetchall()
                ]
                self.assertEqual(operations.count("policy_adaptation"), 2)


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
            owner="supervisor-one",
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

    def test_missed_recovery_escalates_and_allows_empty_evidence_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            escalations: list[str] = []
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(),
                    owner="supervisor-one",
                    clock=lambda: clock[0],
                    immediate_escalation=escalations.append,
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(firing_alert())
                    )
                )
                fence = coordinator.claim_next()
                self.assertIsNotNone(fence)
                assert fence is not None
                self.assertTrue(coordinator.finish(fence, "completed"))

                clock[0] = 101.0
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        alert_body(resolved_alert())
                    )
                )
                coordinator.reconcile()
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("bot-health",),
                    source_ids=(),
                    freshness_seconds=10,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
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

                clock[0] = 112.0
                service.maintenance()
                incident = ledger.connection.execute(
                    "SELECT id, state, generation, evidence_hash FROM incidents"
                ).fetchone()
                self.assertEqual(incident["state"], "recovery_failed")
                self.assertEqual(escalations, ["recovery_failed"])
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM audit WHERE operation = 'verification_failed'"
                    ).fetchone()[0],
                    1,
                )

                self.assertTrue(
                    coordinator.explicit_retry(
                        int(incident["id"]), actor="operator", reason="rerun verification"
                    )
                )
                retried = ledger.connection.execute(
                    "SELECT state, generation, evidence_hash FROM incidents WHERE id = ?",
                    (incident["id"],),
                ).fetchone()
                self.assertEqual(retried["state"], "verifying")
                self.assertEqual(retried["generation"], incident["generation"] + 1)
                self.assertEqual(
                    retried["evidence_hash"], recovery_supervisor._EMPTY_EVIDENCE_HASH
                )

    def test_verification_requires_resolved_episodes_fresh_health_and_hold_down(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [100.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("bot-health",),
                    source_ids=("alertmanager",),
                    freshness_seconds=30,
                    hold_down_seconds=20,
                    clock=lambda: clock[0],
                )
                verifier.record_heartbeat("supervisor")
                verifier.record_heartbeat("alertmanager")
                verifier.record_probe(self._fence(ledger, incident_id), "bot-health", True)
                holding = verifier.evaluate(incident_id)
                self.assertFalse(holding.recovered)
                self.assertIn("hold_down", holding.reasons)
                clock[0] += 21
                recovered = verifier.evaluate(incident_id)
                self.assertTrue(recovered.recovered)
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT state FROM incidents WHERE id = ?", (incident_id,)
                    ).fetchone()[0],
                    "recovered",
                )

    def test_missing_or_stale_monitoring_never_means_recovered(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [200.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("bot-health",),
                    source_ids=("alertmanager",),
                    freshness_seconds=10,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
                )
                missing = verifier.evaluate(incident_id)
                self.assertFalse(missing.recovered)
                self.assertTrue(any("missing" in reason for reason in missing.reasons))
                verifier.record_heartbeat("supervisor", observed_at=100)
                verifier.record_heartbeat("alertmanager", observed_at=100)
                verifier.record_probe(
                    self._fence(ledger, incident_id),
                    "bot-health",
                    True,
                    observed_at=100,
                )
                stale = verifier.evaluate(incident_id)
                self.assertFalse(stale.recovered)
                self.assertTrue(any("unhealthy" in reason for reason in stale.reasons))

    def test_probe_evidence_is_fenced_to_the_exact_verification_generation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [300.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("bot-health",),
                    source_ids=(),
                    freshness_seconds=60,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
                )
                verifier.record_heartbeat("supervisor")
                old_fence = self._fence(ledger, incident_id)
                self.assertTrue(verifier.record_probe(old_fence, "bot-health", True))
                ledger.connection.execute(
                    "UPDATE incidents SET generation = generation + 1 WHERE id = ?",
                    (incident_id,),
                )
                current_fence = self._fence(ledger, incident_id)
                self.assertFalse(verifier.fence_valid(old_fence))
                result = verifier.evaluate(incident_id)
                self.assertFalse(result.recovered)
                self.assertIn("probe_missing:bot-health", result.reasons)
                self.assertEqual(verifier.next_probe_refresh(), current_fence)

    def test_verification_is_refenced_when_static_probe_policy_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [400.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                coordinator, incident_id = self._verifying_incident(ledger, clock)
                controls = coordinator.controls
                controls.ensure_static_policy({"version": 1, "probes": ["old-probe"]})
                coordinator.reconcile()
                old_fence = self._fence(ledger, incident_id)

                current_revision = controls.ensure_static_policy(
                    {"version": 1, "probes": ["new-probe"]}
                )
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("new-probe",),
                    source_ids=(),
                    freshness_seconds=60,
                    hold_down_seconds=0,
                    clock=lambda: clock[0],
                )
                self.assertFalse(verifier.fence_valid(old_fence))
                stale = verifier.evaluate(incident_id)
                self.assertFalse(stale.recovered)
                self.assertIn("policy_stale", stale.reasons)

                coordinator.reconcile()
                current_fence = self._fence(ledger, incident_id)
                self.assertEqual(current_fence.policy_revision, current_revision)
                self.assertEqual(current_fence.generation, old_fence.generation + 1)
                self.assertEqual(verifier.next_probe_refresh(), current_fence)

    def test_completed_commands_are_classified_only_after_verification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [1_000.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                )
                controls = recovery_supervisor.RecoveryControls(
                    ledger, clock=lambda: clock[0]
                )
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    correlation_policy(),
                    owner="verification-owner",
                    controls=controls,
                    clock=lambda: clock[0],
                )
                fence = coordinator.claim_next()
                self.assertIsNotNone(fence)
                assert fence is not None
                self.assertTrue(coordinator.finish(fence, "completed"))
                ledger.connection.execute(
                    "INSERT INTO metadata(key, value) VALUES (?, ?)",
                    (
                        f"invocation:{fence.invocation_id}:plan",
                        json.dumps(
                            {"nextEvaluationDelaySeconds": 60},
                            separators=(",", ":"),
                        ),
                    ),
                )
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("bot-health",),
                    source_ids=("alertmanager",),
                    freshness_seconds=30,
                    hold_down_seconds=10,
                    clock=lambda: clock[0],
                )
                adapter = recovery_supervisor.BoundedPolicyAdapter(
                    ledger, controls, clock=lambda: clock[0]
                )

                initial = verifier.evaluate(fence.incident_id)
                self.assertFalse(initial.recovered)
                self.assertIsNone(
                    verifier.mechanical_classification(fence.incident_id, initial)
                )
                clock[0] += 61
                missed = verifier.evaluate(fence.incident_id)
                classification = verifier.mechanical_classification(
                    fence.incident_id, missed
                )
                self.assertEqual(classification[0] if classification else None, "missed_recovery")
                assert classification is not None
                adapter.record_outcome(
                    fence.incident_id,
                    classification[0],
                    dedupe_key=classification[1],
                )

                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(resolved_alert()))
                )
                coordinator.reconcile()
                verifier.record_heartbeat("supervisor")
                verifier.record_heartbeat("alertmanager")
                verifier.record_probe(
                    self._fence(ledger, fence.incident_id), "bot-health", True
                )
                clock[0] += 11
                recovered = verifier.evaluate(fence.incident_id)
                self.assertTrue(recovered.recovered)
                stable = verifier.mechanical_classification(fence.incident_id, recovered)
                self.assertEqual(stable[0] if stable else None, "stable_recovery")


class RecoveryDigestTests(unittest.TestCase):
    def test_digest_is_deterministic_and_notification_outage_retries(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            clock = [200.0]
            with recovery_ledger.RecoveryLedger(Path(directory) / "ledger.sqlite3") as ledger:
                outbox = recovery_supervisor.RecoveryNotificationOutbox(
                    ledger, clock=lambda: clock[0]
                )
                first = outbox.queue_digest(100, 200)
                second = outbox.queue_digest(100, 200)
                self.assertEqual(first, second)
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM notification_outbox"
                    ).fetchone()[0],
                    1,
                )

                def unavailable(_body: dict[str, object]) -> None:
                    raise OSError("synthetic notification outage")

                self.assertEqual(outbox.deliver_due(unavailable), 0)
                pending = ledger.connection.execute(
                    "SELECT attempts, available_at, delivered_at FROM notification_outbox"
                ).fetchone()
                self.assertEqual(pending["attempts"], 1)
                self.assertEqual(pending["available_at"], 205.0)
                self.assertIsNone(pending["delivered_at"])
                delivered: list[dict[str, object]] = []
                clock[0] = 204.0
                self.assertEqual(outbox.deliver_due(delivered.append), 0)
                clock[0] = 205.0
                self.assertEqual(outbox.deliver_due(delivered.append), 1)
                self.assertEqual(delivered, [first])

    def test_immediate_escalation_accepts_only_reserved_reasons(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            messages: list[str] = []
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                emergency = recovery_supervisor.EmergencyNotifier(
                    root / "notifications", delivery=messages.append, cooldown=0
                )
                outbox = recovery_supervisor.RecoveryNotificationOutbox(
                    ledger, emergency=emergency
                )
                for reason in sorted(recovery_supervisor._IMMEDIATE_ESCALATION_REASONS):
                    self.assertTrue(outbox.immediate_escalation(reason))
                self.assertEqual(len(messages), len(recovery_supervisor._IMMEDIATE_ESCALATION_REASONS))
                with self.assertRaises(ValueError):
                    outbox.immediate_escalation("routine_digest")

    def test_immediate_escalation_reports_missing_delivery_owner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                emergency = recovery_supervisor.EmergencyNotifier(
                    root / "notifications", delivery=None
                )
                outbox = recovery_supervisor.RecoveryNotificationOutbox(
                    ledger, emergency=emergency
                )
                self.assertFalse(outbox.immediate_escalation("pi_unavailable"))


class RecoveryProcessorTests(unittest.TestCase):
    def test_shadow_modes_do_not_launch_verification_probes(self) -> None:
        for mode in ("observe", "plan"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                config = recovery_config.RecoveryConfig(
                    path=root / "recovery.json",
                    workspace=root,
                    mode=mode,
                    database=root / "ledger.sqlite3",
                    spool_directory=root / "spool",
                    auth_token_file=root / "auth-token",
                    host="127.0.0.1",
                    port=9877,
                    correlation_rules=(),
                    source_ids=("alertmanager",),
                    runbooks=(),
                    probes=(
                        {
                            "id": "side-effecting-probe",
                            "executable": "/usr/bin/touch",
                            "argv": [str(root / "must-not-exist")],
                            "env": {},
                            "timeoutMs": 1000,
                        },
                    ),
                )
                with recovery_ledger.RecoveryLedger(config.database) as ledger:
                    initial = recovery_supervisor.IncidentCoordinator(
                        ledger, correlation_policy(), owner="initial-owner"
                    )
                    ledger.record_events(
                        recovery_supervisor.normalize_alertmanager(
                            alert_body(firing_alert())
                        )
                    )
                    initial.reconcile()
                    ledger.record_events(
                        recovery_supervisor.normalize_alertmanager(
                            alert_body(resolved_alert())
                        )
                    )
                    initial.reconcile()
                    controls = initial.controls
                    controls.ensure_static_policy(
                        recovery_config.recovery_static_policy(config)
                    )
                    coordinator = recovery_supervisor.IncidentCoordinator(
                        ledger,
                        correlation_policy(),
                        owner=f"{mode}-owner",
                        controls=controls,
                        mode=mode,
                    )
                    verifier = recovery_supervisor.RecoveryVerifier(
                        ledger,
                        coordinator,
                        probe_ids=("side-effecting-probe",),
                        source_ids=("alertmanager",),
                    )
                    verification_runner = mock.Mock()
                    processor = recovery_supervisor.RecoveryProcessor(
                        config,
                        coordinator,
                        verifier,
                        recovery_supervisor.BoundedPolicyAdapter(ledger, controls),
                        verification_runner=verification_runner,
                    )

                    result = processor.process_once()
                    self.assertFalse(result["plannerLaunched"])
                    self.assertFalse(result["executorLaunched"])
                    verification_runner.assert_not_called()
                    self.assertFalse((root / "must-not-exist").exists())

    def test_worker_executor_boundaries_use_synchronous_coordinator_fence_channel(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake_node = root / "fake-node"
            fake_node.write_text(
                """#!/usr/bin/python3
import json
import os
import sys
json.load(sys.stdin)
descriptor = int(os.environ[\"MINIME_RECOVERY_FENCE_FD\"])
responses = []
for _ in range(2):
    os.write(descriptor, b\"?\")
    responses.append(os.read(descriptor, 1) == b\"1\")
sys.stdout.write(json.dumps({\"version\": 1, \"responses\": responses}))
""",
                encoding="utf-8",
            )
            fake_node.chmod(0o700)
            config = recovery_config.RecoveryConfig(
                path=root / "recovery.json",
                workspace=root,
                mode="enabled",
                database=root / "ledger.sqlite3",
                spool_directory=root / "spool",
                auth_token_file=root / "auth-token",
                host="127.0.0.1",
                port=9877,
                correlation_rules=(),
                source_ids=("alertmanager",),
                runbooks=(),
                probes=(),
            )
            with recovery_ledger.RecoveryLedger(config.database) as ledger:
                controls = recovery_supervisor.RecoveryControls(ledger)
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="fence-owner", controls=controls
                )
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger, coordinator, source_ids=("alertmanager",)
                )
                processor = recovery_supervisor.RecoveryProcessor(
                    config,
                    coordinator,
                    verifier,
                    recovery_supervisor.BoundedPolicyAdapter(ledger, controls),
                    environment={"MINIME_RECOVERY_NODE_EXECUTABLE": str(fake_node)},
                )
                checks = [True, False]
                with mock.patch.object(recovery_supervisor.Path, "is_file", return_value=True):
                    result = processor._run_worker_process(
                        {"version": 1}, lambda: checks.pop(0)
                    )
                self.assertEqual(result["responses"], [True, False])
                self.assertEqual(checks, [])

    def test_claim_plan_execute_persist_probe_and_finish_are_wired(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = recovery_config.RecoveryConfig(
                path=root / "recovery.json",
                workspace=root,
                mode="enabled",
                database=root / "ledger.sqlite3",
                spool_directory=root / "spool",
                auth_token_file=root / "auth-token",
                host="127.0.0.1",
                port=9877,
                correlation_rules=(),
                source_ids=("alertmanager",),
                runbooks=(
                    {
                        "id": "repair-local",
                        "actionClass": "local_repair",
                        "executable": "/usr/bin/true",
                        "argv": [],
                        "env": {},
                        "timeoutMs": 1000,
                    },
                ),
                probes=(
                    {
                        "id": "probe-local",
                        "executable": "/usr/bin/true",
                        "argv": [],
                        "env": {},
                        "timeoutMs": 1000,
                    },
                ),
            )
            with recovery_ledger.RecoveryLedger(config.database) as ledger:
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(alert_body(firing_alert()))
                )
                controls = recovery_supervisor.RecoveryControls(ledger)
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger, correlation_policy(), owner="processor-owner", controls=controls
                )
                verifier = recovery_supervisor.RecoveryVerifier(
                    ledger,
                    coordinator,
                    probe_ids=("probe-local",),
                    source_ids=("alertmanager",),
                )
                adapter = recovery_supervisor.BoundedPolicyAdapter(ledger, controls)
                requests: list[dict[str, object]] = []
                verification_requests: list[dict[str, object]] = []

                def runner(
                    request: dict[str, object], _fence: recovery_supervisor.InvocationFence
                ) -> dict[str, object]:
                    requests.append(request)
                    public_fence = {
                        key: request["fence"][key]  # type: ignore[index]
                        for key in (
                            "invocationId",
                            "incidentId",
                            "generation",
                            "evidenceHash",
                            "policyRevision",
                        )
                    }
                    return {
                        "version": 1,
                        "status": "completed",
                        "plannerLaunched": True,
                        "executorLaunched": True,
                        "plan": {
                            **public_fence,
                            "verdict": "execute",
                            "diagnosisCode": "local_repair",
                            "summary": "A configured local repair is applicable.",
                            "evidenceRefs": [request["evidence"][0]["ref"]],  # type: ignore[index]
                            "runbookIds": ["repair-local"],
                            "probeIds": ["probe-local"],
                            "nextEvaluationDelaySeconds": 60,
                        },
                        "actions": [
                            {
                                "id": "repair-local",
                                "exitCode": 0,
                                "timedOut": False,
                                "output": "",
                                "truncated": False,
                            }
                        ],
                        "probes": [
                            {
                                "id": "probe-local",
                                "exitCode": 0,
                                "timedOut": False,
                                "output": "",
                                "truncated": False,
                            }
                        ],
                    }

                def verification_runner(
                    request: dict[str, object],
                    _fence: recovery_supervisor.VerificationFence,
                ) -> dict[str, object]:
                    verification_requests.append(request)
                    return {
                        "version": 1,
                        "status": "completed",
                        "probes": [
                            {
                                "id": "probe-local",
                                "exitCode": 0,
                                "timedOut": False,
                                "output": "",
                                "truncated": False,
                            }
                        ],
                    }

                processor = recovery_supervisor.RecoveryProcessor(
                    config,
                    coordinator,
                    verifier,
                    adapter,
                    runner=runner,
                    verification_runner=verification_runner,
                )
                result = processor.process_once()
                self.assertEqual(result["outcome"], "completed")
                self.assertEqual(len(requests), 1)
                self.assertEqual(len(requests[0]["evidence"]), 1)  # type: ignore[arg-type]
                invocation = ledger.connection.execute(
                    "SELECT id, state FROM invocations"
                ).fetchone()
                self.assertEqual(invocation["state"], "completed")
                self.assertIsNotNone(
                    ledger.connection.execute(
                        "SELECT value FROM metadata WHERE key = ?",
                        (f"invocation:{invocation['id']}:plan",),
                    ).fetchone()
                )
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM actions").fetchone()[0], 2
                )
                refresh = processor.process_once()
                self.assertEqual(refresh["outcome"], "verification_refreshed")
                self.assertEqual(len(verification_requests), 1)
                verification_fence = verifier.next_probe_refresh()
                self.assertIsNone(verification_fence)
                incident = ledger.connection.execute(
                    "SELECT id, generation, policy_revision FROM incidents"
                ).fetchone()
                probe = json.loads(
                    ledger.connection.execute(
                        "SELECT value FROM metadata WHERE key = ?",
                        (
                            "verification:probe:"
                            f"{incident['id']}:{incident['generation']}:"
                            f"{incident['policy_revision']}:probe-local",
                        ),
                    ).fetchone()[0]
                )
                self.assertTrue(probe["healthy"])
                self.assertIsNone(
                    ledger.connection.execute(
                        "SELECT 1 FROM audit WHERE operation = 'mechanical_outcome'"
                    ).fetchone()
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

    def test_delivery_state_replace_fsyncs_file_and_parent_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "doctor.json"
            with mock.patch.object(runtime_doctor.os, "fsync") as fsync:
                runtime_doctor.write_delivery_state(path, {"node_unavailable"}, None)
            self.assertEqual(fsync.call_count, 2)

    def test_recovery_mode_uses_throttled_native_fallback_when_supervisor_is_down(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = self.config(root, "recovery")
            messages: list[str] = []

            def unavailable(_events: list[dict[str, str]]) -> None:
                raise monitoring_native.DeliveryError("synthetic supervisor outage")

            with mock.patch.object(
                runtime_doctor, "collect_incidents", return_value={"node_unavailable"}
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
                self.assertEqual(messages, [runtime_doctor.SUPERVISOR_UNAVAILABLE_MESSAGE])

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
                        "MINIME_DOCTOR_TIMEOUT": "0.2",
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
                        "runbooks": [],
                        "probes": [],
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

    def test_sigterm_requests_graceful_processor_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
            server = mock.Mock()
            service = mock.Mock()
            processor = mock.Mock()

            def terminate_during_request() -> None:
                handler = recovery_supervisor.signal.getsignal(
                    recovery_supervisor.signal.SIGTERM
                )
                self.assertTrue(callable(handler))
                handler(recovery_supervisor.signal.SIGTERM, None)

            server.handle_request.side_effect = terminate_during_request
            with (
                mock.patch.object(
                    recovery_supervisor, "BoundedThreadingHTTPServer", return_value=server
                ),
                mock.patch.object(
                    recovery_supervisor,
                    "_build_recovery_service",
                    return_value=(service, processor),
                ),
            ):
                result = recovery_supervisor.main(
                    [
                        "--mode",
                        "observe",
                        "--db",
                        str(root / "ledger.sqlite3"),
                        "--spool-dir",
                        str(root / "spool"),
                        "--auth-token-file",
                        str(token),
                    ]
                )
            self.assertEqual(result, 0)
            processor.close.assert_called_once_with()
            server.server_close.assert_called_once_with()

    def test_temporary_startup_ledger_failure_keeps_spool_only_intake_available(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            token = root / "auth-token"
            token.write_text("synthetic-auth-token-value", encoding="utf-8")
            token.chmod(0o600)
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
                        "--mode",
                        "observe",
                        "--db",
                        str(root / "ledger.sqlite3"),
                        "--spool-dir",
                        str(root / "spool"),
                        "--auth-token-file",
                        str(token),
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
            messages: list[str] = []
            with mock.patch.object(recovery_supervisor, "send_telegram", side_effect=lambda message, _config: messages.append(message)):
                result = recovery_supervisor.main(
                    [
                        "--mode",
                        "observe",
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
