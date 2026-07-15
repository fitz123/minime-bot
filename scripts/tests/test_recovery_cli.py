from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import plistlib
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
        "version": 2,
        "mode": mode,
        "database": "var/recovery/ledger.sqlite3",
        "spoolDirectory": "var/recovery/spool",
        "authTokenFile": "config/recovery-auth-token",
        "fixerAuthTokenFile": "config/recovery-fixer-auth-token",
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
        "runtimeDoctorCadenceSeconds": 300,
        "verificationFreshnessSeconds": 660,
        "verificationHoldDownSeconds": 60,
        "internalAgentId": "recovery-fixer",
        "sessionPolicy": {
            "directory": "var/recovery/sessions",
            "startupTimeoutSeconds": 30,
            "resumeTimeoutSeconds": 30,
            "maxReplacementsPerGeneration": 1,
            "journalDigestMaxBytes": 32_768,
        },
        "actionPolicy": {
            "maxActionsPerInvocation": 128,
            "preimageMaxBytes": 1024 * 1024,
            "reconciliationTimeoutSeconds": 300,
        },
        "quarantinePolicy": {
            "directory": "var/recovery/quarantine",
            "allowedRoots": [],
            "maxItemsPerIncident": 64,
            "maxItemBytes": 10 * 1024 * 1024,
            "maxIncidentBytes": 50 * 1024 * 1024,
        },
        "reportPolicy": {
            "maxBytes": 256 * 1024,
            "maxTimelineEntries": 256,
            "retrySeconds": 300,
        },
        "slotPolicy": {
            "stateDirectory": "var/recovery/slots",
            "capsuleRoot": "var/recovery/capsule",
            "botReleaseRoot": "var/releases",
            "startupHealthTimeoutSeconds": 60,
            "nodeExecutable": "/usr/local/bin/node",
            "nodeVersion": "22.19.0",
            "piExecutable": "/usr/local/bin/pi",
            "piVersion": "0.80.6",
        },
        "reviewedOperations": [],
        "fixerLeaseSeconds": 120,
        "fixerRenewSeconds": 30,
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
    def test_version_two_config_accepts_exact_modes_and_static_fixer_policy(self) -> None:
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
            self.assertEqual(loaded.runtime_doctor_cadence_seconds, 300)
            self.assertEqual(loaded.verification_freshness_seconds, 660)
            self.assertEqual(loaded.verification_hold_down_seconds, 60)
            self.assertEqual(
                loaded.database, root.resolve() / "var/recovery/ledger.sqlite3"
            )
            self.assertEqual(
                set(recovery_config.recovery_static_policy(loaded)),
                {
                    "version",
                    "mode",
                    "correlationRules",
                    "sourceIds",
                    "probes",
                    "runtimeDoctorCadenceSeconds",
                    "verificationFreshnessSeconds",
                    "verificationHoldDownSeconds",
                    "internalAgentId",
                    "sessionPolicy",
                    "actionPolicy",
                    "quarantinePolicy",
                    "reportPolicy",
                    "slotPolicy",
                    "reviewedOperations",
                    "fixerLeaseSeconds",
                    "fixerRenewSeconds",
                },
            )

            for mode in ("diagnose", "enabled"):
                valid = config_document(mode)
                (root / "recovery.json").write_text(
                    json.dumps(valid), encoding="utf-8"
                )
                self.assertEqual(
                    recovery_config.load_recovery_config(
                        root / "recovery.json", root
                    ).mode,
                    mode,
                )

            for invalid_mode in ("plan", "disabled", "OBSERVE"):
                invalid = config_document(invalid_mode)
                (root / "recovery.json").write_text(
                    json.dumps(invalid), encoding="utf-8"
                )
                with self.subTest(mode=invalid_mode), self.assertRaises(
                    recovery_config.RecoveryConfigError
                ):
                    recovery_config.load_recovery_config(
                        root / "recovery.json", root
                    )

            old_version = config_document()
            old_version["version"] = 1
            (root / "recovery.json").write_text(json.dumps(old_version), encoding="utf-8")
            with self.assertRaises(recovery_config.RecoveryConfigError):
                recovery_config.load_recovery_config(root / "recovery.json", root)

    def test_mode_endpoint_authorization_matrix_is_closed(self) -> None:
        for operation in ("inspect", "reconcile", "blocked", "finish"):
            self.assertFalse(recovery_config.recovery_endpoint_allowed("observe", operation))
            self.assertTrue(recovery_config.recovery_endpoint_allowed("diagnose", operation))
            self.assertTrue(recovery_config.recovery_endpoint_allowed("enabled", operation))
        self.assertFalse(recovery_config.recovery_endpoint_allowed("diagnose", "mutate"))
        self.assertTrue(recovery_config.recovery_endpoint_allowed("enabled", "mutate"))
        with self.assertRaises(ValueError):
            recovery_config.recovery_endpoint_allowed("enabled", "arbitrary")

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
                    "id": "path-traversal",
                    "executable": "/usr/bin/../bin/true",
                    "argv": [],
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
                {
                    "id": "filesystem-mutation",
                    "executable": "/bin/rm",
                    "argv": ["-f", "/tmp/example"],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "network-mutation",
                    "executable": "/usr/bin/curl",
                    "argv": ["-X", "POST", "http://127.0.0.1:9877/example"],
                    "env": {},
                    "timeoutMs": 1000,
                },
                {
                    "id": "loader-injection",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "env": {"DYLD_INSERT_LIBRARIES": "/tmp/example"},
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

    def test_closed_fixer_policy_rejects_unknown_adaptive_paths_and_shell_strings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            invalid_documents: list[tuple[str, dict[str, object]]] = []

            adaptive = config_document()
            adaptive["adaptivePolicy"] = {"enabled": True}
            invalid_documents.append(("adaptive-root", adaptive))

            unknown_nested = config_document()
            assert isinstance(unknown_nested["sessionPolicy"], dict)
            unknown_nested["sessionPolicy"]["adaptiveTimeout"] = 1
            invalid_documents.append(("unknown-nested", unknown_nested))

            unsafe_root = config_document()
            assert isinstance(unsafe_root["quarantinePolicy"], dict)
            unsafe_root["quarantinePolicy"]["allowedRoots"] = ["../private"]
            invalid_documents.append(("unsafe-root", unsafe_root))

            same_token = config_document()
            same_token["fixerAuthTokenFile"] = same_token["authTokenFile"]
            invalid_documents.append(("shared-credential", same_token))

            bad_renew = config_document()
            bad_renew["fixerRenewSeconds"] = 60
            invalid_documents.append(("unsafe-renew", bad_renew))

            relative_node = config_document()
            assert isinstance(relative_node["slotPolicy"], dict)
            relative_node["slotPolicy"]["nodeExecutable"] = "bin/node"
            invalid_documents.append(("relative-slot-node", relative_node))

            unpinned_pi = config_document()
            assert isinstance(unpinned_pi["slotPolicy"], dict)
            unpinned_pi["slotPolicy"]["piVersion"] = "0.80.7"
            invalid_documents.append(("unpinned-slot-pi", unpinned_pi))

            overlapping_slots = config_document()
            assert isinstance(overlapping_slots["slotPolicy"], dict)
            overlapping_slots["slotPolicy"]["botReleaseRoot"] = "var/recovery/capsule/bot"
            invalid_documents.append(("overlapping-slot-roots", overlapping_slots))

            slotted_runtime = config_document()
            assert isinstance(slotted_runtime["slotPolicy"], dict)
            slotted_runtime["slotPolicy"]["piExecutable"] = str(
                root.resolve() / "var/releases/current/bin/pi"
            )
            invalid_documents.append(("slotted-runtime-prerequisite", slotted_runtime))

            shell_operation = config_document()
            shell_operation["reviewedOperations"] = [
                {
                    "id": "restart",
                    "kind": "restart",
                    "executable": "/bin/sh",
                    "argv": ["-c", "service restart; echo secret"],
                    "timeoutSeconds": 30,
                }
            ]
            invalid_documents.append(("shell-operation", shell_operation))

            malformed_operation = config_document()
            malformed_operation["reviewedOperations"] = [
                {
                    "id": "restart",
                    "kind": [],
                    "executable": "/bin/launchctl",
                    "argv": ["kickstart", "-k", "gui/501/ai.minime.bot"],
                    "timeoutSeconds": 30,
                }
            ]
            invalid_documents.append(("malformed-operation", malformed_operation))

            valid_operation = config_document("enabled")
            valid_operation["reviewedOperations"] = [
                {
                    "id": "restart-bot",
                    "kind": "restart",
                    "executable": "/bin/launchctl",
                    "argv": ["kickstart", "-k", "gui/501/ai.minime.bot"],
                    "timeoutSeconds": 30,
                }
            ]
            (root / "recovery.json").write_text(
                json.dumps(valid_operation), encoding="utf-8"
            )
            loaded = recovery_config.load_recovery_config(root / "recovery.json", root)
            self.assertEqual(loaded.reviewed_operations[0]["id"], "restart-bot")

            for name, document in invalid_documents:
                (root / "recovery.json").write_text(json.dumps(document), encoding="utf-8")
                with self.subTest(case=name), self.assertRaises(
                    recovery_config.RecoveryConfigError
                ):
                    recovery_config.load_recovery_config(root / "recovery.json", root)

    def test_config_rejects_zero_port_and_excessive_total_probe_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            zero_port = config_document()
            zero_port["port"] = 0
            excessive_probes = config_document()
            excessive_probes["probes"] = [
                {
                    "id": f"probe-{index}",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "env": {},
                    "timeoutMs": 200_000,
                }
                for index in range(2)
            ]
            cadence_exhausting_probes = config_document()
            cadence_exhausting_probes["runtimeDoctorCadenceSeconds"] = 30
            cadence_exhausting_probes["verificationFreshnessSeconds"] = 120
            cadence_exhausting_probes["probes"] = [
                {
                    "id": f"cadence-probe-{index}",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "env": {},
                    "timeoutMs": 20_000,
                }
                for index in range(2)
            ]
            for name, document in (
                ("zero-port", zero_port),
                ("probe-timeout-budget", excessive_probes),
                ("probe-cadence-budget", cadence_exhausting_probes),
            ):
                (root / "recovery.json").write_text(
                    json.dumps(document), encoding="utf-8"
                )
                with self.subTest(case=name), self.assertRaises(
                    recovery_config.RecoveryConfigError
                ):
                    recovery_config.load_recovery_config(
                        root / "recovery.json", root
                    )

    def test_malformed_config_types_and_unicode_are_bounded_rejections(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            malformed: list[tuple[str, dict[str, object]]] = []
            for name, field, value in (
                ("mode", "mode", []),
                ("host", "host", []),
                ("source", "sourceIds", [{}]),
            ):
                document = config_document()
                document[field] = value
                malformed.append((name, document))
            for name, probe in (
                (
                    "argv-unicode",
                    {
                        "id": "unicode",
                        "executable": "/usr/bin/true",
                        "argv": ["\ud800"],
                        "env": {},
                        "timeoutMs": 1000,
                    },
                ),
                (
                    "env-unicode",
                    {
                        "id": "unicode",
                        "executable": "/usr/bin/true",
                        "argv": [],
                        "env": {"LANG": "\ud800"},
                        "timeoutMs": 1000,
                    },
                ),
            ):
                document = config_document()
                document["probes"] = [probe]
                malformed.append((name, document))
            for name, document in malformed:
                (root / "recovery.json").write_text(
                    json.dumps(document), encoding="utf-8"
                )
                with self.subTest(case=name), self.assertRaises(
                    recovery_config.RecoveryConfigError
                ):
                    recovery_config.load_recovery_config(
                        root / "recovery.json", root
                    )

    def test_timing_fields_are_required_bounded_and_relationship_checked(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            timing_fields = (
                "runtimeDoctorCadenceSeconds",
                "verificationFreshnessSeconds",
                "verificationHoldDownSeconds",
            )
            for field in timing_fields:
                document = config_document()
                del document[field]
                (root / "recovery.json").write_text(json.dumps(document), encoding="utf-8")
                with self.subTest(missing=field), self.assertRaises(
                    recovery_config.RecoveryConfigError
                ):
                    recovery_config.load_recovery_config(root / "recovery.json", root)

            invalid_values = (
                ("runtimeDoctorCadenceSeconds", True),
                ("runtimeDoctorCadenceSeconds", 29),
                ("runtimeDoctorCadenceSeconds", 3_601),
                ("verificationFreshnessSeconds", 59),
                ("verificationFreshnessSeconds", 86_401),
                ("verificationHoldDownSeconds", -1),
                ("verificationHoldDownSeconds", 86_401),
                ("verificationHoldDownSeconds", 1.5),
            )
            for field, value in invalid_values:
                document = config_document()
                document[field] = value
                (root / "recovery.json").write_text(json.dumps(document), encoding="utf-8")
                with self.subTest(field=field, value=value), self.assertRaises(
                    recovery_config.RecoveryConfigError
                ):
                    recovery_config.load_recovery_config(root / "recovery.json", root)

            too_tight = config_document()
            too_tight["verificationFreshnessSeconds"] = 600
            (root / "recovery.json").write_text(json.dumps(too_tight), encoding="utf-8")
            with self.assertRaisesRegex(
                recovery_config.RecoveryConfigError, "must exceed two"
            ):
                recovery_config.load_recovery_config(root / "recovery.json", root)

            lower_bounds = config_document()
            lower_bounds["runtimeDoctorCadenceSeconds"] = 30
            lower_bounds["verificationFreshnessSeconds"] = 61
            lower_bounds["verificationHoldDownSeconds"] = 0
            (root / "recovery.json").write_text(json.dumps(lower_bounds), encoding="utf-8")
            loaded = recovery_config.load_recovery_config(root / "recovery.json", root)
            self.assertEqual(
                (
                    loaded.runtime_doctor_cadence_seconds,
                    loaded.verification_freshness_seconds,
                    loaded.verification_hold_down_seconds,
                ),
                (30, 61, 0),
            )

    def test_shadow_launchd_cadence_matches_shipped_configuration(self) -> None:
        example = json.loads(
            (SCRIPTS.parent / "examples/recovery/recovery.json").read_text(encoding="utf-8")
        )
        with (SCRIPTS.parent / "examples/recovery/ai.minime.runtime-doctor-shadow.plist").open(
            "rb"
        ) as source:
            shadow = plistlib.load(source)
        self.assertEqual(
            shadow["StartInterval"],
            example["runtimeDoctorCadenceSeconds"],
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
                    "runtimeDoctorCadenceSeconds": 300,
                    "verificationFreshnessSeconds": 660,
                    "verificationHoldDownSeconds": 60,
                },
            )

            code, status, error = call_cli(root, "status")
            self.assertEqual((code, error), (0, ""))
            status_result = json.loads(status)
            self.assertEqual(status_result["mode"], "observe")
            self.assertEqual(
                status_result["foundation"],
                {
                    "fixerAvailable": False,
                    "fixerDispatchAllowed": False,
                    "mutationAllowed": False,
                    "nativeVerification": True,
                    "observeOnly": True,
                    "remediationActionsAvailable": False,
                },
            )

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

            for control, value in (
                ("confirmation-count", "2"),
                ("cooldown", "30"),
                ("retry-budget", "2"),
            ):
                code, output, error = call_cli(
                    root,
                    "controls",
                    control,
                    value,
                    "--actor",
                    "operator",
                    "--reason",
                    "bounded control",
                )
                self.assertEqual((code, error), (0, ""))
                self.assertTrue(json.loads(output)["ok"])

            code, output, error = call_cli(
                root,
                "silence",
                "bot-unavailable",
                "--ttl",
                "60",
                "--actor",
                "operator",
                "--reason",
                "known maintenance",
            )
            self.assertEqual((code, error), (0, ""))
            self.assertTrue(json.loads(output)["ok"])

            loaded = recovery_config.load_recovery_config(
                root / "recovery.json", root
            )
            with recovery_ledger.RecoveryLedger(loaded.database) as ledger:
                controls = recovery_supervisor.RecoveryControls(ledger)
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    recovery_cli._policy(loaded, controls.current().revision),
                    owner="cli-fixture",
                    controls=controls,
                )
                ledger.record_events(
                    recovery_supervisor.normalize_alertmanager(
                        json.dumps(
                            {
                                "alerts": [
                                    {
                                        "status": "firing",
                                        "fingerprint": "cli-retained",
                                        "startsAt": "2026-07-14T00:00:00Z",
                                        "labels": {
                                            "alertname": "BotUnavailable",
                                            "component": "bot",
                                            "failure_class": "unavailable",
                                        },
                                    }
                                ]
                            }
                        ).encode()
                    )
                )
                coordinator.reconcile()
                incident = ledger.connection.execute(
                    "SELECT * FROM incidents"
                ).fetchone()
                ledger.connection.execute(
                    "INSERT INTO invocations(incident_id, generation, evidence_hash, "
                    "policy_revision, lease_token, state, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, 'inspection-token', 'interrupted', 1, 1)",
                    (
                        incident["id"],
                        incident["generation"],
                        incident["evidence_hash"],
                        incident["policy_revision"],
                    ),
                )
                incident_id = int(incident["id"])

            code, incidents, error = call_cli(
                root, "incidents", "--id", str(incident_id), "--limit", "1"
            )
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(json.loads(incidents)[0]["id"], incident_id)
            code, invocations, error = call_cli(
                root, "invocations", "--limit", "1"
            )
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(json.loads(invocations)[0]["incident_id"], incident_id)

            code, output, error = call_cli(
                root,
                "retry",
                str(incident_id),
                "--actor",
                "operator",
                "--reason",
                "explicit retry drill",
            )
            self.assertEqual((code, error), (0, ""))
            self.assertTrue(json.loads(output)["ok"])

            code, history, error = call_cli(
                root, "policy", "history", "--limit", "2"
            )
            self.assertEqual((code, error), (0, ""))
            self.assertEqual(len(json.loads(history)), 2)

            code, output, error = call_cli(
                root,
                "policy",
                "rollback",
                "1",
                "--actor",
                "operator",
                "--reason",
                "restore baseline",
            )
            self.assertEqual((code, error), (0, ""))
            self.assertTrue(json.loads(output)["ok"])

            with recovery_ledger.RecoveryLedger(loaded.database) as ledger:
                operations = {
                    row[0]
                    for row in ledger.connection.execute(
                        "SELECT operation FROM audit"
                    )
                }
            self.assertTrue(
                {
                    "confirmation_control",
                    "cooldown_control",
                    "dispatch_control",
                    "explicit_retry",
                    "policy_rollback",
                    "retry_budget_control",
                    "silence_control",
                }.issubset(operations)
            )

            for removed in (("approve", "1"), ("reject", "1"), ("digest", "preview")):
                code, _output, error = call_cli(root, *removed)
                self.assertEqual(code, 2)
                self.assertIn("invalid choice", error)

            code, _output, error = call_cli(root, "incidents", "--limit", "101")
            self.assertEqual(code, 2)
            self.assertIn("must be between 1 and 100", error)

    def test_process_once_reports_idle_observe_state_without_launching_fixer(self) -> None:
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
                {
                    "ok",
                    "mode",
                    "activeIncidents",
                    "verification",
                    "fixer",
                    "reportsQueued",
                    "reportsDelivered",
                },
            )
            self.assertEqual(result["mode"], "observe")
            self.assertEqual(result["activeIncidents"], 1)
            self.assertEqual(result["verification"], [])
            self.assertEqual(result["fixer"], "idle")
            self.assertEqual(result["reportsQueued"], 0)
            self.assertEqual(result["reportsDelivered"], 0)
            with recovery_ledger.RecoveryLedger(loaded.database) as ledger:
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

    def test_process_once_refreshes_probes_with_python_authority(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            document = config_document()
            document["probes"] = [
                {
                    "id": "host-health",
                    "executable": "/usr/bin/true",
                    "argv": [],
                    "env": {},
                    "timeoutMs": 1000,
                }
            ]
            (root / "recovery.json").write_text(
                json.dumps(document), encoding="utf-8"
            )
            loaded = recovery_config.load_recovery_config(
                root / "recovery.json", root
            )
            with recovery_ledger.RecoveryLedger(loaded.database) as ledger:
                controls = recovery_supervisor.RecoveryControls(ledger)
                static_policy = recovery_config.recovery_static_policy(loaded)
                revision = controls.ensure_static_policy(static_policy)
                coordinator = recovery_supervisor.IncidentCoordinator(
                    ledger,
                    recovery_cli._policy(loaded, revision),
                    owner="cli-probe-test",
                    controls=controls,
                    mode="observe",
                    static_policy=static_policy,
                )
                firing = recovery_supervisor.normalize_alertmanager(
                    json.dumps(
                        {
                            "alerts": [
                                {
                                    "status": "firing",
                                    "fingerprint": "cli-probe",
                                    "startsAt": "2026-07-14T00:00:00Z",
                                    "labels": {
                                        "alertname": "BotUnavailable",
                                        "component": "bot",
                                        "failure_class": "unavailable",
                                    },
                                }
                            ]
                        }
                    ).encode()
                )
                ledger.record_events(firing)
                coordinator.reconcile()
                resolved = recovery_supervisor.normalize_alertmanager(
                    json.dumps(
                        {
                            "alerts": [
                                {
                                    "status": "resolved",
                                    "fingerprint": "cli-probe",
                                    "startsAt": "2026-07-14T00:00:00Z",
                                    "endsAt": "2026-07-14T00:10:00Z",
                                    "labels": {
                                        "alertname": "BotUnavailable",
                                        "component": "bot",
                                        "failure_class": "unavailable",
                                    },
                                }
                            ]
                        }
                    ).encode()
                )
                ledger.record_events(resolved)
                coordinator.reconcile()

            code, output, error = call_cli(root, "process", "--once")
            self.assertEqual((code, error), (0, ""))
            result = json.loads(output)
            self.assertEqual(len(result["verification"]), 1)
            probe_evidence = [
                item
                for item in result["verification"][0]["evidence"]
                if item["kind"] == "probe"
            ]
            self.assertEqual(
                probe_evidence,
                [{"id": "host-health", "kind": "probe", "state": "fresh_healthy"}],
            )
            with recovery_ledger.RecoveryLedger(loaded.database) as ledger:
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM metadata "
                        "WHERE key LIKE 'verification:probe:%:host-health'"
                    ).fetchone()[0],
                    1,
                )
                self.assertEqual(
                    ledger.connection.execute(
                        "SELECT count(*) FROM invocations"
                    ).fetchone()[0],
                    0,
                )


if __name__ == "__main__":
    unittest.main()
