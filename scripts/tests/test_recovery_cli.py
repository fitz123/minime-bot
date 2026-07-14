from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import recovery_cli
import recovery_config
import recovery_ledger
import recovery_supervisor


def config_document(mode: str = "observe") -> dict[str, object]:
    return {
        "version": 1,
        "mode": mode,
        "database": "var/recovery/ledger.sqlite3",
        "spoolDirectory": "var/recovery/spool",
        "authTokenFile": "config/recovery-auth-token",
        "host": "127.0.0.1",
        "port": 9877,
        "correlationRules": [
            {
                "component": "bot",
                "failureClass": "unavailable",
                "incidentKey": "bot-unavailable",
                "impact": 2,
            }
        ],
        "sourceIds": ["alertmanager", "runtime_doctor"],
        "runbooks": [],
        "probes": [],
    }


def write_config(root: Path, mode: str = "observe") -> None:
    (root / "recovery.json").write_text(
        json.dumps(config_document(mode)), encoding="utf-8"
    )


def call_cli(root: Path, *args: str) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = recovery_cli.main(["--workspace", str(root), *args])
    return code, stdout.getvalue(), stderr.getvalue()


class RecoveryConfigTests(unittest.TestCase):
    def test_fixed_config_accepts_public_defaults_and_rejects_escape_and_sensitive_env(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_config(root)
            loaded = recovery_config.load_recovery_config(root / "recovery.json", root)
            self.assertEqual(loaded.mode, "observe")
            self.assertEqual(loaded.runbooks, ())
            self.assertEqual(loaded.database, root.resolve() / "var/recovery/ledger.sqlite3")

            escaped = config_document()
            escaped["database"] = "../outside.sqlite3"
            (root / "recovery.json").write_text(json.dumps(escaped), encoding="utf-8")
            with self.assertRaises(recovery_config.RecoveryConfigError):
                recovery_config.load_recovery_config(root / "recovery.json", root)

            unsafe_commands = [
                {
                    "id": "bad+id",
                    "actionClass": "diagnostic",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "sensitive-argv",
                    "actionClass": "diagnostic",
                    "executable": "/usr/bin/true",
                    "argv": ["--token=literal-value"],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "sudo-executable",
                    "actionClass": "diagnostic",
                    "executable": "/usr/bin/sudo",
                    "argv": ["/usr/bin/true"],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "shell-string",
                    "actionClass": "diagnostic",
                    "executable": "/bin/sh",
                    "argv": ["-c", "sudo reboot"],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "env-indirection",
                    "actionClass": "diagnostic",
                    "executable": "/usr/bin/env",
                    "argv": ["sudo", "reboot"],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "misclassified-restart",
                    "actionClass": "diagnostic",
                    "executable": "/bin/launchctl",
                    "argv": ["kickstart", "gui/501/example"],
                    "env": {},
                    "timeoutMs": 1000,
                },
            ]
            for command in unsafe_commands:
                unsafe = config_document()
                unsafe["runbooks"] = [command]
                (root / "recovery.json").write_text(json.dumps(unsafe), encoding="utf-8")
                with self.subTest(command=command["id"]), self.assertRaises(
                    recovery_config.RecoveryConfigError
                ):
                    recovery_config.load_recovery_config(root / "recovery.json", root)

            sensitive = config_document()
            sensitive["runbooks"] = [
                {
                    "id": "unsafe",
                    "actionClass": "diagnostic",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "env": {"API_TOKEN": "not-allowed"},
                    "timeoutMs": 1000,
                }
            ]
            (root / "recovery.json").write_text(json.dumps(sensitive), encoding="utf-8")
            with self.assertRaises(recovery_config.RecoveryConfigError):
                recovery_config.load_recovery_config(root / "recovery.json", root)


class RecoveryCliTests(unittest.TestCase):
    def test_status_controls_history_digest_and_process_are_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_config(root)

            code, output, error = call_cli(root, "config", "validate")
            self.assertEqual((code, error), (0, ""))
            self.assertTrue(json.loads(output)["ok"])

            code, output, error = call_cli(root, "status")
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(json.loads(output)["mode"], "observe")

            code, output, error = call_cli(
                root,
                "dispatch",
                "disable",
                "--ttl",
                "60",
                "--actor",
                "operator",
                "--reason",
                "shadow drill",
            )
            self.assertEqual((code, error), (0, ""))
            self.assertGreater(json.loads(output)["revision"], 1)

            code, history, error = call_cli(root, "policy", "history", "--limit", "2")
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(len(json.loads(history)), 2)

            code, digest, error = call_cli(root, "digest", "preview", "--window", "3600")
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(json.loads(digest)["kind"], "digest")

            code, processed, error = call_cli(root, "process", "--once")
            self.assertEqual((code, error), (0, ""))
            result = json.loads(processed)
            self.assertFalse(result["plannerLaunched"])
            self.assertFalse(result["executorLaunched"])

            code, _output, error = call_cli(root, "incidents", "--limit", "101")
            self.assertEqual(code, 2)
            self.assertIn("must be between 1 and 100", error)

    def test_process_once_uses_the_concrete_recovery_processor(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_config(root, "plan")
            loaded = recovery_config.load_recovery_config(root / "recovery.json", root)
            with recovery_ledger.RecoveryLedger(loaded.database) as ledger:
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        json.dumps(
                            {
                                "alerts": [
                                    {
                                        "status": "firing",
                                        "fingerprint": "process-once",
                                        "startsAt": "2026-07-14T00:00:00Z",
                                        "labels": {
                                            "alertname": "BotUnavailable",
                                            "component": "bot",
                                            "failure_class": "unavailable",
                                            "instance": "local",
                                        },
                                    }
                                ]
                            }
                        ).encode()
                    )
                )
            processor = mock.Mock()
            processor.process_once.return_value = {
                "plannerLaunched": True,
                "executorLaunched": False,
                "outcome": "observe",
            }
            with mock.patch.object(
                recovery_cli, "RecoveryProcessor", return_value=processor
            ) as constructor:
                code, output, error = call_cli(root, "process", "--once")
            self.assertEqual((code, error), (0, ""))
            self.assertTrue(json.loads(output)["plannerLaunched"])
            constructor.assert_called_once()
            processor.process_once.assert_called_once_with()

    def test_observe_mode_never_claims_and_approval_decisions_are_audited(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_config(root, "observe")
            loaded = recovery_config.load_recovery_config(root / "recovery.json", root)
            event = recovery_supervisor.normalize_alertmanager(
                json.dumps(
                    {
                        "alerts": [
                            {
                                "status": "firing",
                                "fingerprint": "episode-one",
                                "startsAt": "2026-07-14T00:00:00Z",
                                "labels": {
                                    "alertname": "BotUnavailable",
                                    "component": "bot",
                                    "failure_class": "unavailable",
                                    "instance": "local",
                                },
                            }
                        ]
                    }
                ).encode()
            )
            with recovery_ledger.RecoveryLedger(loaded.database) as ledger:
                ledger.record_events(event)
                policy = recovery_cli._policy(loaded)
                observer = recovery_supervisor.IncidentCoordinator(
                    ledger, policy, owner="observer", mode="observe"
                )
                self.assertIsNone(observer.claim_next())
                self.assertEqual(
                    ledger.connection.execute("SELECT count(*) FROM invocations").fetchone()[0],
                    0,
                )

                enabled = recovery_supervisor.IncidentCoordinator(
                    ledger, policy, owner="enabled", mode="enabled"
                )
                fence = enabled.claim_next()
                self.assertIsNotNone(fence)
                assert fence is not None
                self.assertTrue(enabled.finish(fence, "pending_approval"))
                frozen_plan = {
                    "invocationId": fence.invocation_id,
                    "incidentId": fence.incident_id,
                    "generation": fence.generation,
                    "evidenceHash": fence.evidence_hash,
                    "policyRevision": fence.policy_revision,
                    "verdict": "approval_required",
                    "diagnosisCode": "operator_handoff",
                    "summary": "A reviewed external handoff is required.",
                    "evidenceRefs": ["event:1"],
                    "runbookIds": ["external-handoff"],
                    "probeIds": [],
                    "nextEvaluationDelaySeconds": 60,
                }
                ledger.connection.execute(
                    "INSERT INTO metadata(key, value) VALUES (?, ?)",
                    (
                        f"invocation:{fence.invocation_id}:plan",
                        json.dumps(frozen_plan, separators=(",", ":"), sort_keys=True),
                    ),
                )

            code, inspected, error = call_cli(
                root, "invocations", "--id", str(fence.invocation_id)
            )
            self.assertEqual((code, error), (0, ""))
            self.assertNotIn("lease_token", json.loads(inspected)[0])

            code, output, error = call_cli(
                root,
                "approve",
                str(fence.invocation_id),
                "--actor",
                "operator",
                "--reason",
                "reviewed static plan",
            )
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(json.loads(output)["decision"], "approve")
            with recovery_ledger.RecoveryLedger(loaded.database) as ledger:
                audit = ledger.connection.execute(
                    "SELECT operation FROM audit ORDER BY id DESC LIMIT 1"
                ).fetchone()[0]
                self.assertEqual(audit, "approval_decision")
                incident = ledger.connection.execute(
                    "SELECT state, generation FROM incidents WHERE id = ?", (fence.incident_id,)
                ).fetchone()
                self.assertEqual(incident["state"], "handoff_approved")
                self.assertEqual(incident["generation"], fence.generation)
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    recovery_cli._policy(
                        loaded,
                        recovery_supervisor.RecoveryControls(ledger).current().revision,
                    ),
                    owner="post-approval",
                    mode="enabled",
                )
                self.assertIsNone(coordinator.claim_next())


if __name__ == "__main__":
    unittest.main()
