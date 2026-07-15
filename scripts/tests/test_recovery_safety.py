from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import recovery_config
import recovery_ledger
import recovery_rootctl
import recovery_supervisor


def active_fence(
    ledger: recovery_ledger.RecoveryLedger,
) -> tuple[recovery_supervisor.IncidentCoordinator, recovery_supervisor.InvocationFence]:
    policy = recovery_supervisor.RecoveryPolicy(
        revision=1,
        rules=(
            recovery_supervisor.CorrelationRule(
                "safety", "unavailable", "safety-incident", impact=3
            ),
        ),
    )
    coordinator = recovery_supervisor.IncidentCoordinator(
        ledger, policy, owner="safety-supervisor", mode="enabled"
    )
    event = recovery_supervisor._normalized_event(
        source="alertmanager",
        fingerprint="safety-fixture",
        code="SafetyDown",
        status="firing",
        transition="2026-07-15T00:00:00Z",
        occurred_at="2026-07-15T00:00:00Z",
        component="safety",
        failure_class="unavailable",
    )
    ledger.record_events([event])
    fence = coordinator.claim_next()
    assert fence is not None
    return coordinator, fence


def quarantine_policy(root: Path, allowed: Path, **overrides: int) -> dict[str, object]:
    policy: dict[str, object] = {
        "directory": str((root / "quarantine").resolve()),
        "allowedRoots": (str(allowed.resolve()),),
        "maxItemsPerIncident": 8,
        "maxItemBytes": 1024,
        "maxIncidentBytes": 4096,
    }
    policy.update(overrides)
    return policy


class RecoveryQuarantineSafetyTests(unittest.TestCase):
    def test_quarantine_and_restore_are_fenced_checksummed_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            allowed = root / "allowed"
            allowed.mkdir(mode=0o700)
            source = allowed / "cache.bin"
            source.write_bytes(b"bounded recovery fixture")
            source.chmod(0o640)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, fence = active_fence(ledger)
                quarantine = recovery_supervisor.RecoveryQuarantine(
                    quarantine_policy(root, allowed)
                )
                actuator = recovery_supervisor.RecoveryActuator(
                    coordinator,
                    quarantine,
                    recovery_supervisor.ReviewedOperationExecutor(()),
                )
                status, result = actuator.quarantine_file(
                    fence,
                    idempotency_key="quarantine-cache-v1",
                    source_path=str(source),
                )
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertFalse(source.exists())
                quarantine_id = str(result["quarantineId"])
                incident_directory = root / "quarantine" / f"incident-{fence.incident_id}"
                manifest_path = incident_directory / f"{quarantine_id}.json"
                item_path = incident_directory / f"{quarantine_id}.item"
                self.assertEqual(root.joinpath("quarantine").stat().st_mode & 0o777, 0o700)
                self.assertEqual(incident_directory.stat().st_mode & 0o777, 0o700)
                self.assertEqual(manifest_path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(item_path.stat().st_mode & 0o777, 0o600)
                manifest = json.loads(manifest_path.read_text("ascii"))
                checksum = manifest.pop("manifestChecksum")
                self.assertEqual(
                    checksum,
                    hashlib.sha256(
                        recovery_supervisor._canonical_json(manifest).encode("ascii")
                    ).hexdigest(),
                )
                self.assertEqual(manifest["contentSha256"], hashlib.sha256(item_path.read_bytes()).hexdigest())
                self.assertEqual(manifest["state"], "quarantined")

                different = allowed / "different.bin"
                different.write_bytes(b"different")
                different.chmod(0o600)
                reused_status, reused = actuator.quarantine_file(
                    fence,
                    idempotency_key="quarantine-cache-v1",
                    source_path=str(different),
                )
                self.assertEqual(
                    (reused_status, reused["code"]),
                    (409, "idempotency_key_reused"),
                )

                status, restored = actuator.restore_file(
                    fence,
                    idempotency_key="restore-cache-v1",
                    quarantine_id=quarantine_id,
                )
                self.assertEqual(status, 200)
                self.assertTrue(restored["ok"])
                self.assertEqual(source.read_bytes(), b"bounded recovery fixture")
                self.assertEqual(stat.S_IMODE(source.stat().st_mode), 0o640)
                self.assertFalse(item_path.exists())
                self.assertEqual(
                    quarantine._load_manifest(manifest_path)["state"], "restored"
                )

                replay_status, replay = actuator.restore_file(
                    fence,
                    idempotency_key="restore-cache-v1",
                    quarantine_id=quarantine_id,
                )
                self.assertEqual(replay_status, 200)
                self.assertTrue(replay["replayed"])
                rows = ledger.connection.execute(
                    "SELECT action_intents.tool_name, action_intents.state, "
                    "action_outcomes.outcome FROM action_intents JOIN action_outcomes "
                    "ON action_outcomes.action_intent_id = action_intents.id ORDER BY action_intents.id"
                ).fetchall()
                self.assertEqual(
                    [tuple(row) for row in rows],
                    [
                        ("recovery_quarantine", "completed", "succeeded"),
                        ("recovery_restore", "completed", "succeeded"),
                    ],
                )

    def test_quarantine_rejects_symlinks_modes_bounds_and_tampered_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            allowed = root / "allowed"
            allowed.mkdir(mode=0o700)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, fence = active_fence(ledger)
                actuator = recovery_supervisor.RecoveryActuator(
                    coordinator,
                    recovery_supervisor.RecoveryQuarantine(
                        quarantine_policy(
                            root, allowed, maxItemBytes=8, maxItemsPerIncident=1
                        )
                    ),
                    recovery_supervisor.ReviewedOperationExecutor(()),
                )

                large = allowed / "large.bin"
                large.write_bytes(b"0123456789")
                large.chmod(0o600)
                status, result = actuator.quarantine_file(
                    fence, idempotency_key="large", source_path=str(large)
                )
                self.assertEqual((status, result["code"]), (422, "item_too_large"))
                self.assertTrue(large.exists())

                unsafe_mode = allowed / "shared.bin"
                unsafe_mode.write_bytes(b"small")
                unsafe_mode.chmod(0o666)
                status, result = actuator.quarantine_file(
                    fence, idempotency_key="shared", source_path=str(unsafe_mode)
                )
                self.assertEqual((status, result["code"]), (422, "source_unsafe"))

                target = allowed / "target.bin"
                target.write_bytes(b"small")
                target.chmod(0o600)
                linked = allowed / "linked.bin"
                linked.symlink_to(target)
                status, result = actuator.quarantine_file(
                    fence, idempotency_key="linked", source_path=str(linked)
                )
                self.assertEqual((status, result["code"]), (422, "symlink_rejected"))

                outside = root / "outside.bin"
                outside.write_bytes(b"small")
                outside.chmod(0o600)
                status, result = actuator.quarantine_file(
                    fence, idempotency_key="outside", source_path=str(outside)
                )
                self.assertEqual(
                    (status, result["code"]), (422, "path_outside_allowed_roots")
                )

                good = allowed / "good.bin"
                good.write_bytes(b"small")
                good.chmod(0o600)
                status, result = actuator.quarantine_file(
                    fence, idempotency_key="good", source_path=str(good)
                )
                self.assertEqual(status, 200)
                identifier = str(result["quarantineId"])
                extra = allowed / "extra.bin"
                extra.write_bytes(b"tiny")
                extra.chmod(0o600)
                limit_status, limit_result = actuator.quarantine_file(
                    fence, idempotency_key="extra", source_path=str(extra)
                )
                self.assertEqual(
                    (limit_status, limit_result["code"]),
                    (422, "incident_item_limit"),
                )
                manifest_path = (
                    root / "quarantine" / f"incident-{fence.incident_id}" / f"{identifier}.json"
                )
                manifest = json.loads(manifest_path.read_text("ascii"))
                manifest["sizeBytes"] = 1
                manifest_path.write_text(json.dumps(manifest), encoding="ascii")
                manifest_path.chmod(0o600)
                status, result = actuator.restore_file(
                    fence, idempotency_key="tampered", quarantine_id=identifier
                )
                self.assertEqual((status, result["code"]), (422, "manifest_invalid"))

    def test_ambiguous_actuator_mutation_is_immediately_reconcilable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            allowed = root / "allowed"
            allowed.mkdir(mode=0o700)
            source = allowed / "ambiguous.bin"
            source.write_bytes(b"ambiguous")
            source.chmod(0o600)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, fence = active_fence(ledger)
                quarantine = recovery_supervisor.RecoveryQuarantine(
                    quarantine_policy(root, allowed)
                )
                actuator = recovery_supervisor.RecoveryActuator(
                    coordinator,
                    quarantine,
                    recovery_supervisor.ReviewedOperationExecutor(()),
                )
                with mock.patch.object(
                    quarantine,
                    "quarantine",
                    side_effect=recovery_supervisor.RecoveryMutationUnknown(
                        "synthetic ambiguous mutation"
                    ),
                ):
                    status, result = actuator.quarantine_file(
                        fence,
                        idempotency_key="ambiguous-once",
                        source_path=str(source),
                    )
                self.assertEqual((status, result["code"]), (409, "action_unknown"))
                action = ledger.connection.execute(
                    "SELECT action_key, state FROM action_intents"
                ).fetchone()
                self.assertEqual(action["state"], "unknown")
                state = coordinator.fixer_state(fence)
                assert state is not None
                self.assertEqual(
                    [item["actionKey"] for item in state["unknownActions"]],
                    [action["action_key"]],
                )
                self.assertTrue(
                    coordinator.reconcile_action(
                        fence,
                        action_key=str(action["action_key"]),
                        idempotency_key="reconcile-ambiguous-once",
                        result="not_applied",
                        details={"observed": "source_present"},
                    )
                )

    def test_quarantine_detects_source_replacement_and_restore_never_clobbers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            allowed = root / "allowed"
            allowed.mkdir(mode=0o700)
            source = allowed / "racy.bin"
            source.write_bytes(b"original")
            source.chmod(0o600)
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                _coordinator, fence = active_fence(ledger)
                quarantine = recovery_supervisor.RecoveryQuarantine(
                    quarantine_policy(root, allowed)
                )
                quarantine_id, _intent = quarantine.request_description(
                    fence,
                    idempotency_key="racy-source",
                    source_path=str(source),
                )
                saved_original = allowed / "saved-original.bin"
                replacement = allowed / "replacement.bin"
                real_rename = os.rename

                def replace_before_rename(src: object, dst: object) -> None:
                    if Path(src) == source:
                        real_rename(source, saved_original)
                        replacement.write_bytes(b"replacement")
                        replacement.chmod(0o600)
                        real_rename(replacement, source)
                    real_rename(src, dst)

                with mock.patch.object(
                    recovery_supervisor.os,
                    "rename",
                    side_effect=replace_before_rename,
                ), self.assertRaises(recovery_supervisor.RecoveryMutationUnknown):
                    quarantine.quarantine(
                        fence,
                        quarantine_id=quarantine_id,
                        source_path=str(source),
                    )
                self.assertEqual(saved_original.read_bytes(), b"original")
                self.assertFalse(
                    (
                        root
                        / "quarantine"
                        / f"incident-{fence.incident_id}"
                        / f"{quarantine_id}.item"
                    ).exists()
                )

                clean_source = allowed / "clean.bin"
                clean_source.write_bytes(b"clean")
                clean_source.chmod(0o600)
                clean_id, _intent = quarantine.request_description(
                    fence,
                    idempotency_key="restore-no-clobber",
                    source_path=str(clean_source),
                )
                quarantine.quarantine(
                    fence,
                    quarantine_id=clean_id,
                    source_path=str(clean_source),
                )
                clean_source.write_bytes(b"concurrent")
                clean_source.chmod(0o600)
                with self.assertRaisesRegex(
                    recovery_supervisor.RecoverySafetyError,
                    "restore_target_exists",
                ):
                    quarantine.restore(fence, quarantine_id=clean_id)
                self.assertEqual(clean_source.read_bytes(), b"concurrent")


class RecoveryReviewedOperationTests(unittest.TestCase):
    def test_static_id_execution_has_no_mutable_command_surface(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            allowed = root / "allowed"
            allowed.mkdir(mode=0o700)
            operation = {
                "id": "restart-bot",
                "kind": "restart",
                "executable": "/usr/bin/true",
                "argv": [],
                "timeoutSeconds": 10,
            }
            with recovery_ledger.RecoveryLedger(root / "ledger.sqlite3") as ledger:
                coordinator, fence = active_fence(ledger)
                actuator = recovery_supervisor.RecoveryActuator(
                    coordinator,
                    recovery_supervisor.RecoveryQuarantine(
                        quarantine_policy(root, allowed)
                    ),
                    recovery_supervisor.ReviewedOperationExecutor((operation,)),
                )
                completed = mock.Mock(returncode=0, pid=60_001)
                completed.poll.return_value = 0
                with mock.patch.object(
                    recovery_supervisor.subprocess, "Popen", return_value=completed
                ) as popen, mock.patch.object(
                    recovery_supervisor.PythonProbeRunner, "_terminate_process_group"
                ) as terminate:
                    status, result = actuator.reviewed_operation(
                        fence,
                        idempotency_key="restart-once",
                        operation_id="restart-bot",
                    )
                self.assertEqual(status, 200)
                self.assertTrue(result["ok"])
                self.assertEqual(popen.call_args.args[0], ["/usr/bin/true"])
                self.assertFalse(popen.call_args.kwargs["shell"])
                self.assertTrue(popen.call_args.kwargs["start_new_session"])
                terminate.assert_called_once_with(completed)
                intent = json.loads(
                    ledger.connection.execute(
                        "SELECT intent_json FROM action_intents"
                    ).fetchone()[0]
                )
                self.assertEqual(intent, {"kind": "restart", "operationId": "restart-bot"})

                service = recovery_supervisor.RecoveryService(
                    ledger,
                    recovery_supervisor.AtomicJsonSpool(root / "spool"),
                    recovery_supervisor.EmergencyNotifier(
                        root / "notifications", delivery=None
                    ),
                    coordinator=coordinator,
                    actuator=actuator,
                )
                body = {
                    "invocationId": fence.invocation_id,
                    "incidentId": fence.incident_id,
                    "generation": fence.generation,
                    "evidenceHash": fence.evidence_hash,
                    "policyRevision": fence.policy_revision,
                    "leaseToken": fence.lease_token,
                    "idempotencyKey": "bypass",
                    "operationId": "restart-bot",
                    "argv": ["unsafe"],
                }
                self.assertEqual(
                    service.fixer(
                        "/v1/fixer/operation", json.dumps(body).encode("ascii")
                    ).status,
                    400,
                )
                self.assertTrue(
                    coordinator.record_guard_rejection(
                        fence,
                        event_key="guard-audit-1",
                        category="external-mutation",
                        tool_name="bash",
                        input_sha256="c" * 64,
                    )
                )
                guard = ledger.connection.execute(
                    "SELECT actor, details_json FROM audit "
                    "WHERE operation = 'guard_rejected'"
                ).fetchone()
                self.assertEqual(guard["actor"], "fixer-extension")
                self.assertEqual(
                    json.loads(guard["details_json"])["category"],
                    "external-mutation",
                )

    def test_reviewed_operation_stops_the_process_group_on_fence_loss_and_timeout(self) -> None:
        operation = {
            "id": "restart-bot",
            "kind": "restart",
            "executable": "/usr/bin/true",
            "argv": [],
            "timeoutSeconds": 10,
        }
        executor = recovery_supervisor.ReviewedOperationExecutor((operation,))
        for expected_code, fence_values, monotonic_values in (
            ("fence_lost", [True, False], [0.0]),
            ("timeout", [True, True], [0.0, 11.0]),
        ):
            process = mock.Mock(returncode=None, pid=60_002)
            process.poll.return_value = None
            with self.subTest(code=expected_code), mock.patch.object(
                recovery_supervisor.subprocess, "Popen", return_value=process
            ) as popen, mock.patch.object(
                recovery_supervisor.PythonProbeRunner, "_terminate_process_group"
            ) as terminate, mock.patch.object(
                recovery_supervisor.time,
                "monotonic",
                side_effect=monotonic_values,
            ), mock.patch.object(recovery_supervisor.time, "sleep"):
                result = executor.execute(
                    "restart-bot",
                    fence_valid=mock.Mock(side_effect=fence_values),
                )
            self.assertEqual(result["code"], expected_code)
            self.assertTrue(popen.call_args.kwargs["start_new_session"])
            terminate.assert_called_once_with(process)

    def test_config_rejects_unsafe_reviewed_operations(self) -> None:
        unsafe = [
            ("/bin/rm", ["-f", "/tmp/file"]),
            ("/usr/bin/docker", ["pull", "example/image"]),
            ("/bin/launchctl", ["kickstart", "system/example.bot"]),
            ("/usr/local/bin/restart-wrapper", ["--token=value"]),
        ]
        for executable, argv in unsafe:
            with self.subTest(executable=executable, argv=argv), self.assertRaises(
                recovery_config.RecoveryConfigError
            ):
                recovery_config.validated_reviewed_operation(
                    {
                        "id": "unsafe",
                        "kind": "restart",
                        "executable": executable,
                        "argv": argv,
                        "timeoutSeconds": 30,
                    }
                )
        self.assertEqual(
            recovery_config.validated_reviewed_operation(
                {
                    "id": "restart-container",
                    "kind": "restart",
                    "executable": "/usr/local/bin/docker",
                    "argv": ["restart", "minime-bot"],
                    "timeoutSeconds": 30,
                }
            )["id"],
            "restart-container",
        )


class RecoveryRootctlTests(unittest.TestCase):
    @staticmethod
    def request() -> dict[str, object]:
        uid = os.getuid()
        return {
            "capabilityId": "restart-system-service",
            "incidentId": 4,
            "idempotencyKey": "root-op-once",
            "activeFence": {
                "invocationId": 7,
                "incidentId": 4,
                "generation": 3,
                "evidenceHash": "a" * 64,
                "policyRevision": 2,
                "leaseToken": "b" * 48,
                "expiresAt": 120.0,
            },
            "currentUid": uid,
            "peerUid": uid,
            "rateLimit": {
                "now": 100.0,
                "windowStartedAt": 90.0,
                "windowSeconds": 60,
                "attempts": 0,
                "maxAttempts": 3,
            },
        }

    def test_empty_registry_cannot_be_bypassed(self) -> None:
        request = self.request()
        self.assertEqual(recovery_rootctl.CAPABILITY_REGISTRY, frozenset())
        self.assertEqual(
            recovery_rootctl.evaluate_request(request)["status"],
            "unsupported_capability",
        )
        for field in ("command", "argv", "path", "shell"):
            invalid = json.loads(json.dumps(request))
            invalid[field] = [] if field == "argv" else "unsafe"
            with self.subTest(field=field), self.assertRaises(
                recovery_rootctl.RootctlRequestError
            ):
                recovery_rootctl.evaluate_request(invalid)

    def test_rootctl_validates_fence_uid_idempotency_and_rate_inputs(self) -> None:
        mutations = []
        wrong_uid = self.request()
        wrong_uid["peerUid"] = os.getuid() + 1
        mutations.append(wrong_uid)
        stale = self.request()
        assert isinstance(stale["activeFence"], dict)
        stale["activeFence"]["expiresAt"] = 100.0
        mutations.append(stale)
        exhausted = self.request()
        assert isinstance(exhausted["rateLimit"], dict)
        exhausted["rateLimit"]["attempts"] = 3
        mutations.append(exhausted)
        mismatched = self.request()
        assert isinstance(mismatched["activeFence"], dict)
        mismatched["activeFence"]["incidentId"] = 5
        mutations.append(mismatched)
        bad_key = self.request()
        bad_key["idempotencyKey"] = "unsafe key"
        mutations.append(bad_key)
        for request in mutations:
            with self.subTest(request=request), self.assertRaises(
                recovery_rootctl.RootctlRequestError
            ):
                recovery_rootctl.validate_request(request)

    def test_rootctl_entrypoint_is_bounded_and_fail_closed(self) -> None:
        command = [sys.executable, str(Path(recovery_rootctl.__file__).resolve())]
        accepted = subprocess.run(
            command,
            input=json.dumps(self.request()).encode("ascii"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(accepted.returncode, 3)
        self.assertEqual(
            accepted.stdout,
            b'{"capabilityId":"restart-system-service","ok":false,"status":"unsupported_capability"}\n',
        )
        self.assertEqual(accepted.stderr, b"")

        malformed = subprocess.run(
            command,
            input=b"{",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual((malformed.returncode, malformed.stdout), (2, b'{"ok":false,"status":"invalid_request"}\n'))

        oversized = subprocess.run(
            command,
            input=b"x" * (recovery_rootctl.MAX_REQUEST_BYTES + 1),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual((oversized.returncode, oversized.stdout), (2, b'{"ok":false,"status":"invalid_request"}\n'))


if __name__ == "__main__":
    unittest.main()
