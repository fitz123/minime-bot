from __future__ import annotations

import hashlib
import importlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest


INSTALLED_PACKAGE_ROOT = os.environ.get("MINIME_INSTALLED_PACKAGE_ROOT")


@unittest.skipUnless(
    INSTALLED_PACKAGE_ROOT,
    "installed-tarball acceptance runs from the package install test",
)
class InstalledRecoveryAcceptanceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        assert INSTALLED_PACKAGE_ROOT is not None
        cls.package_root = Path(INSTALLED_PACKAGE_ROOT).resolve()
        cls.scripts = cls.package_root / "scripts"
        sys.path.insert(0, str(cls.scripts))
        cls.config = importlib.import_module("recovery_config")
        cls.ledger = importlib.import_module("recovery_ledger")
        cls.rootctl = importlib.import_module("recovery_rootctl")
        cls.slots = importlib.import_module("recovery_slots")
        cls.supervisor = importlib.import_module("recovery_supervisor")
        for module in (
            cls.config,
            cls.ledger,
            cls.rootctl,
            cls.slots,
            cls.supervisor,
        ):
            cls.assert_path_is_installed(Path(module.__file__).resolve())

    @classmethod
    def tearDownClass(cls) -> None:
        if sys.path and sys.path[0] == str(cls.scripts):
            sys.path.pop(0)

    @classmethod
    def assert_path_is_installed(cls, path: Path) -> None:
        path.relative_to(cls.package_root)

    def _event(self, fingerprint: str, status: str, transition: str):
        return self.supervisor._normalized_event(
            source="alertmanager",
            fingerprint=fingerprint,
            code="InstalledRecovery",
            status=status,
            transition=transition,
            occurred_at=transition,
            component="bot",
            failure_class="unavailable",
        )

    def _policy(self):
        return self.supervisor.RecoveryPolicy(
            revision=1,
            rules=(
                self.supervisor.CorrelationRule(
                    "bot", "unavailable", "installed-recovery", impact=3
                ),
            ),
            lease_seconds=120,
        )

    def test_installed_authoritative_lifecycle_quarantine_and_report_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            allowed = root / "allowed"
            allowed.mkdir(mode=0o700)
            clock = [2_000_000_000.0]
            database = root / "ledger.sqlite3"
            ledger = self.ledger.RecoveryLedger(database)
            coordinator = self.supervisor.IncidentCoordinator(
                ledger,
                self._policy(),
                owner="installed-acceptance",
                mode="enabled",
                clock=lambda: clock[0],
            )
            firing = self._event(
                "installed-full-lifecycle", "firing", "2026-07-15T00:00:00Z"
            )
            self.assertEqual(ledger.record_events([firing]), 1)
            self.assertEqual(ledger.record_events([firing]), 0)
            fence = coordinator.claim_next()
            self.assertIsNotNone(fence)
            assert fence is not None

            binding = coordinator.bind_session(
                fence,
                session_id="installed-session",
                session_directory=str(root / "sessions/installed"),
                transcript_path=str(root / "sessions/installed/session.jsonl"),
            )
            self.assertIsNotNone(binding)
            self.assertIsNotNone(
                coordinator.record_action_intent(
                    fence,
                    action_key="crash-window",
                    tool_name="edit",
                    intent={"pathRef": "config:bot"},
                )
            )
            ledger.recover_unfinished_actions()
            self.assertEqual(
                ledger.connection.execute(
                    "SELECT state FROM action_intents WHERE action_key = 'crash-window'"
                ).fetchone()[0],
                "unknown",
            )
            self.assertIsNone(
                coordinator.record_action_intent(
                    fence,
                    action_key="blocked-before-reconcile",
                    tool_name="write",
                    intent={"pathRef": "config:other"},
                )
            )
            self.assertTrue(
                coordinator.reconcile_action(
                    fence,
                    action_key="crash-window",
                    idempotency_key="installed-reconcile",
                    result="not_applied",
                    details={"inspection": "preimage intact"},
                )
            )

            source = allowed / "cache.bin"
            source.write_bytes(b"installed quarantine fixture")
            source.chmod(0o600)
            quarantine = self.supervisor.RecoveryQuarantine(
                {
                    "directory": str(root / "quarantine"),
                    "allowedRoots": (str(allowed),),
                    "maxItemsPerIncident": 8,
                    "maxItemBytes": 1024,
                    "maxIncidentBytes": 4096,
                }
            )
            actuator = self.supervisor.RecoveryActuator(
                coordinator,
                quarantine,
                self.supervisor.ReviewedOperationExecutor(()),
            )
            status, quarantined = actuator.quarantine_file(
                fence,
                idempotency_key="installed-quarantine",
                source_path=str(source),
            )
            self.assertEqual(status, 200)
            self.assertFalse(source.exists())
            manifest = (
                root
                / "quarantine"
                / f"incident-{fence.incident_id}"
                / f"{quarantined['quarantineId']}.json"
            )
            self.assertEqual(stat.S_IMODE(manifest.stat().st_mode), 0o600)

            claim = {
                "summary": "local configuration repaired",
                "rootCause": "token=installed-secret-value copied from /private/fixture/config",
                "confidence": "high",
                "changedFiles": ["/private/fixture/config.yaml"],
                "changedServices": ["bot-service"],
                "verification": ["model-only assertion"],
                "residualRisk": "none observed",
                "references": ["knowledge:fixture", "beads:fixture", "commit:abc123"],
            }
            self.assertTrue(
                coordinator.accept_completion_claim(
                    fence, claim_key="installed-finish", claim=claim
                )
            )
            self.assertNotEqual(
                ledger.connection.execute(
                    "SELECT state FROM incidents WHERE id = ?", (fence.incident_id,)
                ).fetchone()[0],
                "recovered",
                "a model finish claim must not be recovery authority",
            )

            resolved = self._event(
                "installed-full-lifecycle", "resolved", "2026-07-15T00:10:00Z"
            )
            self.assertEqual(ledger.record_events([resolved]), 1)
            coordinator.reconcile()
            incident = ledger.connection.execute(
                "SELECT generation, policy_revision, state FROM incidents WHERE id = ?",
                (fence.incident_id,),
            ).fetchone()
            self.assertEqual(incident["state"], "verifying")
            verifier = self.supervisor.RecoveryVerifier(
                ledger,
                coordinator,
                cadence_seconds=1,
                freshness_seconds=3,
                hold_down_seconds=0,
                clock=lambda: clock[0],
            )
            verifier.record_heartbeat("supervisor")
            result = verifier.evaluate(fence.incident_id)
            self.assertTrue(result.recovered)

            store = self.supervisor.RecoveryReportStore(
                ledger, retry_seconds=1, clock=lambda: clock[0]
            )

            def unavailable(_key, _body):
                raise OSError("synthetic installed report outage")

            authority = self.supervisor.RecoveryReportAuthority(
                ledger,
                coordinator,
                store,
                max_timeline_entries=64,
                delivery=unavailable,
                enrichers={
                    "knowledge": lambda _context: (_ for _ in ()).throw(
                        RuntimeError("synthetic knowledge outage")
                    ),
                    "beads": lambda _context: (_ for _ in ()).throw(
                        RuntimeError("synthetic beads outage")
                    ),
                },
                clock=lambda: clock[0],
            )
            self.assertEqual(authority.queue_ready(), 1)
            self.assertEqual(authority.queue_ready(), 0)
            row = ledger.connection.execute(
                "SELECT report_key, body_json FROM incident_reports"
            ).fetchone()
            report_key = str(row["report_key"])
            report = json.loads(str(row["body_json"]))
            self.assertEqual(report["outcome"], "recovered")
            self.assertEqual(report["degradedMetadata"], ["beads", "knowledge"])
            self.assertNotIn("installed-secret-value", json.dumps(report))
            self.assertNotIn("/private/fixture", json.dumps(report))
            self.assertEqual(authority.deliver_due(), 0)
            self.assertEqual(store.state(report_key), "REPORT_PENDING")
            ledger.close()

            clock[0] += 2
            delivered = []
            with self.ledger.RecoveryLedger(database) as reopened:
                restarted_coordinator = self.supervisor.IncidentCoordinator(
                    reopened,
                    self._policy(),
                    owner="installed-acceptance-restarted",
                    mode="enabled",
                    clock=lambda: clock[0],
                )
                restarted_store = self.supervisor.RecoveryReportStore(
                    reopened, retry_seconds=1, clock=lambda: clock[0]
                )
                restarted = self.supervisor.RecoveryReportAuthority(
                    reopened,
                    restarted_coordinator,
                    restarted_store,
                    max_timeline_entries=64,
                    delivery=lambda key, _body: delivered.append(key),
                    clock=lambda: clock[0],
                )
                self.assertEqual(restarted.queue_ready(), 0)
                self.assertEqual(restarted.deliver_due(), 1)
                self.assertEqual(restarted.deliver_due(), 0)
                self.assertEqual(delivered, [report_key])
                self.assertEqual(restarted_store.state(report_key), "REPORTED")

    @staticmethod
    def _write(path: Path, content: str, *, executable: bool = False) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        path.chmod(0o755 if executable else 0o644)

    def _runtime_tree(self, root: Path, domain: str, version: str) -> Path:
        source = root / f"{domain}-runtime-{version}"
        dependencies = {"fixture-helper": "1.0.0"}
        if domain == "capsule":
            dependencies["@earendil-works/pi-coding-agent"] = "0.80.6"
        self._write(
            source / "package.json",
            json.dumps(
                {"name": "installed-slot-fixture", "version": version, "dependencies": dependencies}
            ),
        )
        self._write(
            source / "node_modules/fixture-helper/package.json",
            json.dumps({"name": "fixture-helper", "version": "1.0.0", "dependencies": {}}),
        )
        self._write(source / "node_modules/fixture-helper/index.js", "export {};\n")
        if domain == "bot":
            self._write(source / "dist/main.js", "export {};\n", executable=True)
            return source

        self._write(
            source / "node_modules/@earendil-works/pi-coding-agent/package.json",
            json.dumps(
                {
                    "name": "@earendil-works/pi-coding-agent",
                    "version": "0.80.6",
                    "dependencies": {"fixture-helper": "1.0.0"},
                }
            ),
        )
        self._write(
            source / "node_modules/@earendil-works/pi-coding-agent/index.js", "export {};\n"
        )
        self._write(source / "dist/recovery/fixer-session.js", "export {};\n", executable=True)
        self._write(source / "dist/extensions/pi/recovery.js", "export {};\n")
        for name in (
            "codex-transport-overflow.js",
            "knowledge-tools.js",
            "web-tools.js",
        ):
            self._write(source / "dist/extensions/pi" / name, "export {};\n")
        for name in (
            "config.js",
            "pi-rpc-protocol.js",
            "pi-extensions/recovery-mode.js",
            "pi-extensions/recovery-protocol.js",
            "session-manager.js",
            "types.js",
            "workspace-contract.js",
        ):
            self._write(source / "dist" / name, "export {};\n")
        for name in (
            "alertmanager_webhook.py",
            "monitoring_native.py",
            "recovery_cli.py",
            "recovery_config.py",
            "recovery_ledger.py",
            "recovery_rootctl.py",
            "recovery_slots.py",
            "recovery_supervisor.py",
            "runtime_doctor.py",
        ):
            self._write(source / "scripts" / name, "from __future__ import annotations\n")
        return source

    def _runtime_policy(self, root: Path):
        node = root / "host/bin/node"
        pi = root / "host/bin/pi"
        self._write(node, "node fixture\n", executable=True)
        self._write(pi, "pi fixture\n", executable=True)

        def runner(argv, _timeout):
            if len(argv) > 1 and argv[1] in {"--check", "--input-type=module"}:
                return subprocess.CompletedProcess(argv, 0, b"", b"")
            version = b"v22.19.0\n" if Path(argv[0]) == node else b"0.80.6\n"
            return subprocess.CompletedProcess(argv, 0, version, b"")

        return (
            {
                "nodeExecutable": str(node),
                "nodeVersion": "22.19.0",
                "piExecutable": str(pi),
                "piVersion": "0.80.6",
            },
            runner,
        )

    def _corrupt(self, path: Path) -> None:
        path.chmod(0o644)
        path.write_text("corrupt\n", encoding="utf-8")
        path.chmod(0o444)

    def test_installed_capsule_fallback_and_offline_bot_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            policy, command_runner = self._runtime_policy(root)
            capsules = self.slots.CapsuleSlots(
                root / "capsules",
                root / "state",
                startup_timeout_seconds=5,
                command_runner=command_runner,
            )
            capsules.stage(self._runtime_tree(root, "capsule", "1.0.0"), "old", policy)
            capsules.stage(self._runtime_tree(root, "capsule", "2.0.0"), "new", policy)
            capsules.activate("old")
            capsules.activate("new")
            self._corrupt(capsules.store.release_path("new") / "dist/recovery/fixer-session.js")
            boot = capsules.boot_with(
                lambda _release, _timeout: self.slots.StartupAttempt(True)
            )
            self.assertTrue(boot.fallback_used)
            self.assertEqual(boot.release_id, "old")
            with self.assertRaises(self.slots.SlotBootstrapError):
                capsules.state.fallback("second-fallback-must-fail")

            calls = []

            def restart(argv, _timeout):
                calls.append(list(argv))
                return subprocess.CompletedProcess(argv, 0, b"", b"")

            operations = (
                {
                    "id": "restart-bot",
                    "kind": "restart",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "timeoutSeconds": 10,
                },
            )
            bots = self.slots.BotReleaseSlots(
                root / "bots", root / "bot-state", operations, restart_runner=restart
            )
            bots.stage(self._runtime_tree(root, "bot", "1.0.0"), "old")
            bots.stage(self._runtime_tree(root, "bot", "2.0.0"), "new")
            bots.activate("old")
            bots.activate("new")
            self._corrupt(bots.store.release_path("new") / "dist/main.js")
            rollback = bots.rollback("restart-bot")
            self.assertTrue(rollback["ok"])
            self.assertEqual(rollback["currentRelease"], "old")
            self.assertEqual(calls, [["/usr/bin/true"]])

    def test_installed_rootctl_has_no_capability_or_generic_command_surface(self) -> None:
        now = 100.0
        uid = os.getuid() if hasattr(os, "getuid") else 0
        request = {
            "capabilityId": "restart-host-service",
            "incidentId": 7,
            "idempotencyKey": "installed-root-boundary",
            "activeFence": {
                "invocationId": 11,
                "incidentId": 7,
                "generation": 2,
                "evidenceHash": hashlib.sha256(b"installed").hexdigest(),
                "policyRevision": 3,
                "leaseToken": "installed-lease-token",
                "expiresAt": now + 10,
            },
            "currentUid": uid,
            "peerUid": uid,
            "rateLimit": {
                "now": now,
                "windowStartedAt": now - 1,
                "windowSeconds": 60,
                "attempts": 0,
                "maxAttempts": 1,
            },
        }
        self.assertEqual(self.rootctl.CAPABILITY_REGISTRY, frozenset())
        self.assertEqual(
            self.rootctl.evaluate_request(request, current_uid=uid)["status"],
            "unsupported_capability",
        )
        with self.assertRaises(self.rootctl.RootctlRequestError):
            self.rootctl.validate_request({**request, "argv": ["unsafe"]}, current_uid=uid)

        executed = subprocess.run(
            [sys.executable, str(Path(self.rootctl.__file__).resolve())],
            input=json.dumps(request).encode("ascii"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertEqual(executed.returncode, 3)
        self.assertEqual(
            json.loads(executed.stdout),
            {
                "ok": False,
                "status": "unsupported_capability",
                "capabilityId": "restart-host-service",
            },
        )
        self.assertEqual(executed.stderr, b"")


if __name__ == "__main__":
    unittest.main()
