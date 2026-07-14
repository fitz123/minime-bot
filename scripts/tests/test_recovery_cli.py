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
        "probes": [],
    }


def write_config(root: Path) -> None:
    (root / "recovery.json").write_text(
        json.dumps(config_document()), encoding="utf-8"
    )


def call_cli(root: Path, *args: str) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = recovery_cli.main(["--workspace", str(root), *args])
    return code, stdout.getvalue(), stderr.getvalue()


class RecoveryConfigTests(unittest.TestCase):
    def test_foundation_config_accepts_only_observe_and_validated_probes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            document = config_document()
            document["probes"] = [
                {
                    "id": "local-health",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "env": {"LANG": "C"},
                    "timeoutMs": 1000,
                }
            ]
            (root / "recovery.json").write_text(
                json.dumps(document), encoding="utf-8"
            )
            loaded = recovery_config.load_recovery_config(
                root / "recovery.json", root
            )
            self.assertEqual(loaded.mode, "observe")
            self.assertEqual(len(loaded.probes), 1)
            self.assertEqual(
                loaded.database, root.resolve() / "var/recovery/ledger.sqlite3"
            )
            self.assertEqual(
                set(recovery_config.recovery_static_policy(loaded)),
                {"version", "mode", "correlationRules", "sourceIds", "probes"},
            )

            for legacy_mode in ("plan", "enabled"):
                invalid = config_document(legacy_mode)
                (root / "recovery.json").write_text(
                    json.dumps(invalid), encoding="utf-8"
                )
                with self.subTest(mode=legacy_mode), self.assertRaises(
                    recovery_config.RecoveryConfigError
                ):
                    recovery_config.load_recovery_config(
                        root / "recovery.json", root
                    )

    def test_closed_config_rejects_actuator_fields_and_unsafe_probe_commands(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            extra_registry = config_document()
            extra_registry["runbooks"] = []
            (root / "recovery.json").write_text(
                json.dumps(extra_registry), encoding="utf-8"
            )
            with self.assertRaises(recovery_config.RecoveryConfigError):
                recovery_config.load_recovery_config(
                    root / "recovery.json", root
                )

            unsafe_shapes = [
                {
                    "id": "bad+id",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "sensitive-argv",
                    "executable": "/usr/bin/true",
                    "argv": ["--token=literal-value"],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "shell",
                    "executable": "/bin/sh",
                    "argv": ["-c", "true"],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "service-control",
                    "executable": "/bin/launchctl",
                    "argv": ["kickstart", "gui/501/example"],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "sensitive-env",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "env": {"API_TOKEN": "not-allowed"},
                    "timeoutMs": 1000,
                },
            ]
            for probe in unsafe_shapes:
                invalid = config_document()
                invalid["probes"] = [probe]
                (root / "recovery.json").write_text(
                    json.dumps(invalid), encoding="utf-8"
                )
                with self.subTest(probe=probe["id"]), self.assertRaises(
                    recovery_config.RecoveryConfigError
                ):
                    recovery_config.load_recovery_config(
                        root / "recovery.json", root
                    )


class RecoveryCliTests(unittest.TestCase):
    def test_retained_commands_are_bounded_and_removed_commands_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_config(root)

            code, output, error = call_cli(root, "config", "validate")
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(
                json.loads(output),
                {
                    "config": str((root / "recovery.json").resolve()),
                    "mode": "observe",
                    "ok": True,
                    "probes": 0,
                },
            )

            code, status, error = call_cli(root, "status")
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(json.loads(status)["mode"], "observe")

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

            code, history, error = call_cli(
                root, "policy", "history", "--limit", "2"
            )
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(len(json.loads(history)), 2)

            for removed in (("approve", "1"), ("reject", "1"), ("digest", "preview")):
                code, _output, error = call_cli(root, *removed)
                self.assertEqual(code, 2)
                self.assertIn("invalid choice", error)

            code, _output, error = call_cli(root, "incidents", "--limit", "101")
            self.assertEqual(code, 2)
            self.assertIn("must be between 1 and 100", error)

    def test_process_once_reports_foundation_state_without_launch_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_config(root)
            loaded = recovery_config.load_recovery_config(
                root / "recovery.json", root
            )
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

            with mock.patch("subprocess.Popen") as popen:
                code, output, error = call_cli(root, "process", "--once")
            self.assertEqual((code, error), (0, ""))
            popen.assert_not_called()
            result = json.loads(output)
            self.assertEqual(
                set(result),
                {"ok", "mode", "activeIncidents", "verification"},
            )
            self.assertEqual(result["mode"], "observe")
            self.assertEqual(result["activeIncidents"], 1)
            self.assertEqual(result["verification"], [])
            with recovery_ledger.RecoveryLedger(loaded.database) as ledger:
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM invocations"
                    ).fetchone()[0],
                    0,
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM actions"
                    ).fetchone()[0],
                    0,
                )


if __name__ == "__main__":
    unittest.main()
