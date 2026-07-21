from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

import recovery_config
import recovery_slots


def write_file(path: Path, content: str, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755 if executable else 0o644)


def runtime_tree(root: Path, *, domain: str, version: str) -> Path:
    source = root / f"{domain}-runtime-{version}"
    dependencies: dict[str, str] = {"fixture-helper": "1.0.0"}
    if domain == "capsule":
        dependencies["@earendil-works/pi-coding-agent"] = "0.80.6"
    write_file(
        source / "package.json",
        json.dumps(
            {
                "name": "slot-fixture",
                "version": version,
                "dependencies": dependencies,
            }
        ),
    )
    write_file(
        source / "node_modules/fixture-helper/package.json",
        json.dumps({"name": "fixture-helper", "version": "1.0.0", "dependencies": {}}),
    )
    write_file(source / "node_modules/fixture-helper/index.js", "export const fixture = true;\n")
    if domain == "capsule":
        write_file(
            source / "node_modules/@earendil-works/pi-coding-agent/package.json",
            json.dumps(
                {
                    "name": "@earendil-works/pi-coding-agent",
                    "version": "0.80.6",
                    "dependencies": {"fixture-helper": "1.0.0"},
                }
            ),
        )
        write_file(
            source / "node_modules/@earendil-works/pi-coding-agent/index.js",
            "export {};\n",
        )
        shim = source / "node_modules/.bin/pi"
        shim.parent.mkdir(parents=True, exist_ok=True)
        shim.symlink_to("../@earendil-works/pi-coding-agent/index.js")
        write_file(source / "dist/recovery/fixer-session.js", "export {};\n", executable=True)
        write_file(source / "dist/extensions/pi/recovery.js", "export {};\n")
        for name in (
            "codex-transport-overflow.js",
            "knowledge-tools.js",
            "web-tools.js",
        ):
            write_file(source / "dist/extensions/pi" / name, "export {};\n")
        for name in (
            "config.js",
            "pi-rpc-protocol.js",
            "pi-extensions/recovery-mode.js",
            "pi-extensions/recovery-protocol.js",
            "session-manager.js",
            "types.js",
            "workspace-contract.js",
        ):
            write_file(source / "dist" / name, "export {};\n")
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
            write_file(source / "scripts" / name, "from __future__ import annotations\n", executable=name == "recovery_supervisor.py")
    else:
        write_file(source / "dist/main.js", f"export const release = {version!r};\n", executable=True)
    return source


def runtime_policy(root: Path) -> tuple[dict[str, object], recovery_slots.CommandRunner]:
    node = root / "host/bin/node"
    pi = root / "host/bin/pi"
    write_file(node, "#!/bin/sh\necho v22.19.0\n", executable=True)
    write_file(pi, "#!/bin/sh\necho 0.80.6\n", executable=True)

    def runner(argv: list[str], _timeout: float) -> subprocess.CompletedProcess[bytes]:
        if argv[1] == "--check":
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


def operation() -> dict[str, object]:
    return {
        "id": "restart-bot",
        "kind": "restart",
        "executable": "/usr/bin/true",
        "argv": [],
        "timeoutSeconds": 10,
    }


def corrupt(path: Path, content: str = "corrupted\n") -> None:
    path.chmod(0o644)
    path.write_text(content, encoding="utf-8")
    path.chmod(0o444)


class RecoveryCapsuleSlotTests(unittest.TestCase):
    def test_executable_version_probe_uses_load_tolerant_bounded_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / "pi"
            write_file(executable, "#!/bin/sh\necho 0.80.6\n", executable=True)
            observed_timeouts: list[float] = []

            def runner(
                argv: list[str], timeout: float
            ) -> subprocess.CompletedProcess[bytes]:
                observed_timeouts.append(timeout)
                return subprocess.CompletedProcess(argv, 0, b"0.80.6\n", b"")

            record = recovery_slots._executable_record(
                str(executable), "0.80.6", "Pi", runner
            )

            self.assertEqual(record["version"], "0.80.6")
            self.assertEqual(
                observed_timeouts,
                [recovery_slots.EXECUTABLE_VERSION_TIMEOUT_SECONDS],
            )
            self.assertEqual(recovery_slots.EXECUTABLE_VERSION_TIMEOUT_SECONDS, 30.0)

    def test_capsule_stage_copies_independent_closure_and_pins_prerequisites(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = runtime_tree(root, domain="capsule", version="1.0.0")
            policy, runner = runtime_policy(root)
            slots = recovery_slots.CapsuleSlots(
                root / "capsules",
                root / "state",
                startup_timeout_seconds=5,
                command_runner=runner,
            )
            manifest = slots.stage(source, "capsule-1", policy)
            release = slots.store.release_path("capsule-1")
            self.assertEqual(manifest["packageVersion"], "1.0.0")
            self.assertEqual(
                {(item["name"], item["version"]) for item in manifest["dependencies"]},
                {
                    ("@earendil-works/pi-coding-agent", "0.80.6"),
                    ("fixture-helper", "1.0.0"),
                },
            )
            self.assertEqual(manifest["prerequisites"]["node"]["version"], "22.19.0")
            self.assertEqual(manifest["prerequisites"]["pi"]["version"], "0.80.6")
            self.assertEqual(manifest["selfCheck"]["nodeSyntax"], "passed")
            self.assertEqual(manifest["selfCheck"]["nodeImport"], "passed")
            self.assertFalse((release / "node_modules/.bin").exists())
            self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o555)
            self.assertEqual(
                stat.S_IMODE((release / recovery_slots.MANIFEST_NAME).stat().st_mode),
                0o444,
            )
            source_file = source / "dist/recovery/fixer-session.js"
            source_file.write_text("changed after staging\n", encoding="utf-8")
            self.assertEqual(
                (release / "dist/recovery/fixer-session.js").read_text("utf-8"),
                "export {};\n",
            )
            self.assertEqual(slots.store.validate("capsule-1")["releaseId"], "capsule-1")

    def test_capsule_rejects_prerequisite_version_or_installed_pi_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = runtime_tree(root, domain="capsule", version="1.0.0")
            policy, runner = runtime_policy(root)
            slots = recovery_slots.CapsuleSlots(
                root / "capsules",
                root / "state",
                startup_timeout_seconds=5,
                command_runner=runner,
            )
            wrong_policy = dict(policy)
            wrong_policy["nodeVersion"] = "23.0.0"
            with self.assertRaises(recovery_slots.SlotValidationError):
                slots.stage(source, "wrong-node", wrong_policy)

            pi_manifest = source / "node_modules/@earendil-works/pi-coding-agent/package.json"
            document = json.loads(pi_manifest.read_text("utf-8"))
            document["version"] = "0.80.7"
            pi_manifest.write_text(json.dumps(document), encoding="utf-8")
            with self.assertRaises(recovery_slots.SlotValidationError):
                slots.stage(source, "wrong-pi", policy)

    def test_broken_current_capsule_falls_back_once_to_verified_previous(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy, runner = runtime_policy(root)
            slots = recovery_slots.CapsuleSlots(
                root / "capsules",
                root / "state",
                startup_timeout_seconds=5,
                command_runner=runner,
            )
            slots.stage(runtime_tree(root, domain="capsule", version="1.0.0"), "good", policy)
            slots.stage(runtime_tree(root, domain="capsule", version="2.0.0"), "broken", policy)
            slots.activate("good")
            slots.activate("broken")
            corrupt(slots.store.release_path("broken") / "dist/recovery/fixer-session.js")
            launched: list[str] = []

            def healthy(release: Path, _timeout: int) -> recovery_slots.StartupAttempt:
                launched.append(release.name)
                return recovery_slots.StartupAttempt(True)

            boot = slots.boot_with(healthy)
            self.assertEqual((boot.release_id, boot.fallback_used), ("good", True))
            self.assertEqual(launched, ["good"])
            state = slots.state.reconcile()
            self.assertEqual((state["current"], state["previous"]), ("good", "broken"))
            self.assertTrue(state["fallbackAttempted"])

            with self.assertRaises(recovery_slots.SlotBootstrapError):
                slots.boot_with(lambda _release, _timeout: recovery_slots.StartupAttempt(False, 1))
            self.assertEqual(slots.state.reconcile()["current"], "good")

    def test_startup_health_failure_switches_to_previous_exactly_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy, runner = runtime_policy(root)
            slots = recovery_slots.CapsuleSlots(
                root / "capsules",
                root / "state",
                startup_timeout_seconds=5,
                command_runner=runner,
            )
            slots.stage(runtime_tree(root, domain="capsule", version="1.0.0"), "previous", policy)
            slots.stage(runtime_tree(root, domain="capsule", version="2.0.0"), "current", policy)
            slots.activate("previous")
            slots.activate("current")
            launched: list[str] = []
            failed_process = mock.Mock(pid=4815)
            failed_process.poll.return_value = None

            def launch(release: Path, _timeout: int) -> recovery_slots.StartupAttempt:
                launched.append(release.name)
                return recovery_slots.StartupAttempt(
                    release.name == "previous",
                    1,
                    failed_process if release.name == "current" else None,
                )

            with mock.patch.object(
                recovery_slots, "_terminate_startup_process"
            ) as terminate:
                result = slots.boot_with(launch)
            self.assertEqual(result.release_id, "previous")
            self.assertEqual(launched, ["current", "previous"])
            terminate.assert_called_once_with(failed_process)
            self.assertTrue(slots.state.reconcile()["fallbackAttempted"])

    def test_conflicting_supervisor_identity_never_switches_the_active_slot(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy, runner = runtime_policy(root)
            slots = recovery_slots.CapsuleSlots(
                root / "capsules",
                root / "state",
                startup_timeout_seconds=5,
                command_runner=runner,
            )
            slots.stage(
                runtime_tree(root, domain="capsule", version="1.0.0"),
                "previous",
                policy,
            )
            slots.stage(
                runtime_tree(root, domain="capsule", version="2.0.0"),
                "current",
                policy,
            )
            slots.activate("previous")
            slots.activate("current")
            process = mock.Mock(pid=4816)
            process.poll.return_value = None
            with mock.patch.object(
                recovery_slots, "_terminate_startup_process"
            ) as terminate, self.assertRaisesRegex(
                recovery_slots.SlotBootstrapError, "already active"
            ):
                slots.boot_with(
                    lambda _release, _timeout: recovery_slots.StartupAttempt(
                        False, None, process, identity_conflict=True
                    )
                )
            terminate.assert_called_once_with(process)
            state = slots.state.reconcile()
            self.assertEqual((state["current"], state["previous"]), ("current", "previous"))
            self.assertFalse(state["fallbackAttempted"])

    def test_startup_process_cleanup_escalates_to_process_group_kill(self) -> None:
        process = mock.Mock(pid=8123)
        process.wait.side_effect = [subprocess.TimeoutExpired("capsule", 5), 0]
        with mock.patch.object(recovery_slots.os, "killpg") as killpg:
            recovery_slots._terminate_startup_process(process)
        self.assertEqual(
            killpg.call_args_list,
            [
                mock.call(8123, recovery_slots.signal.SIGTERM),
                mock.call(8123, recovery_slots.signal.SIGKILL),
            ],
        )
        self.assertEqual(
            process.wait.call_args_list,
            [mock.call(timeout=5), mock.call(timeout=5)],
        )

    def test_stable_launcher_requires_authenticated_loopback_health(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy, runner = runtime_policy(root)
            slots = recovery_slots.CapsuleSlots(
                root / "capsules",
                root / "state",
                startup_timeout_seconds=5,
                command_runner=runner,
            )
            slots.stage(runtime_tree(root, domain="capsule", version="1.0.0"), "current", policy)
            release = slots.store.release_path("current")
            token = root / "intake-token"
            token.write_text("0123456789abcdef0123456789abcdef\n", encoding="ascii")
            token.chmod(0o600)
            requests: list[tuple[str, str, dict[str, str]]] = []

            class Response:
                status = 200

                @staticmethod
                def read(_limit: int) -> bytes:
                    return b"{}"

                @staticmethod
                def getheader(name: str, default: str = "") -> str:
                    return requests[-1][2].get(name, default)

            class Connection:
                def __init__(self, host: str, port: int, timeout: float):
                    self.address = (host, port, timeout)

                def request(self, method: str, path: str, *, headers: dict[str, str]) -> None:
                    requests.append((method, path, headers))

                @staticmethod
                def getresponse() -> Response:
                    return Response()

                @staticmethod
                def close() -> None:
                    return None

            process = mock.Mock(pid=1234)
            process.poll.return_value = None
            configured = SimpleNamespace(
                auth_token_file=token,
                host="127.0.0.1",
                port=9877,
            )
            with mock.patch.object(
                recovery_slots.subprocess, "Popen", return_value=process
            ) as popen, mock.patch.object(
                recovery_slots.http.client, "HTTPConnection", Connection
            ):
                attempt = recovery_slots._capsule_launcher(
                    root, root / "recovery.json", configured
                )(release, 5)
            self.assertTrue(attempt.healthy)
            self.assertIs(attempt.process, process)
            self.assertEqual(requests[0][0:2], ("GET", "/healthz"))
            self.assertEqual(
                requests[0][2]["Authorization"],
                "Bearer 0123456789abcdef0123456789abcdef",
            )
            nonce = requests[0][2][recovery_slots._STARTUP_NONCE_HEADER]
            release_id = requests[0][2][recovery_slots._STARTUP_RELEASE_HEADER]
            self.assertRegex(nonce, r"^[a-f0-9]{64}$")
            self.assertEqual(release_id, "current")
            environment = popen.call_args.kwargs["env"]
            self.assertEqual(environment["MINIME_RECOVERY_STARTUP_NONCE"], nonce)
            self.assertEqual(
                environment["MINIME_RECOVERY_CAPSULE_RELEASE_ID"], release_id
            )

            class StaleResponse(Response):
                @staticmethod
                def getheader(_name: str, default: str = "") -> str:
                    return default

            class StaleConnection(Connection):
                @staticmethod
                def getresponse() -> StaleResponse:
                    return StaleResponse()

            with mock.patch.object(
                recovery_slots.subprocess, "Popen", return_value=process
            ), mock.patch.object(
                recovery_slots.http.client, "HTTPConnection", StaleConnection
            ), mock.patch.object(
                recovery_slots.time, "monotonic", side_effect=[0.0, 0.0, 6.0]
            ), mock.patch.object(recovery_slots.time, "sleep"):
                stale = recovery_slots._capsule_launcher(
                    root, root / "recovery.json", configured
                )(release, 5)
            self.assertFalse(stale.healthy)
            self.assertTrue(stale.identity_conflict)


class RecoverySlotTransitionTests(unittest.TestCase):
    def test_active_slot_release_revalidates_manifest_and_exact_link(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy, runner = runtime_policy(root)
            slot_policy = {
                **policy,
                "capsuleRoot": str(root / "capsules"),
                "botReleaseRoot": str(root / "bots"),
                "stateDirectory": str(root / "state"),
                "startupHealthTimeoutSeconds": 5,
            }
            capsules = recovery_slots.CapsuleSlots(
                root / "capsules",
                root / "state",
                startup_timeout_seconds=5,
                command_runner=runner,
            )
            bots = recovery_slots.BotReleaseSlots(root / "bots", root / "state", ())
            capsules.stage(
                runtime_tree(root, domain="capsule", version="1.0.0"),
                "capsule-active",
                slot_policy,
            )
            capsules.activate("capsule-active")
            bots.stage(
                runtime_tree(root, domain="bot", version="1.0.0"),
                "bot-active",
            )
            bots.activate("bot-active")
            configured = SimpleNamespace(
                slot_policy=slot_policy,
                reviewed_operations=(),
            )
            self.assertEqual(
                recovery_slots.active_slot_release(configured, "capsule")["releaseId"],
                "capsule-active",
            )
            self.assertEqual(
                recovery_slots.active_slot_release(configured, "bot")["releaseId"],
                "bot-active",
            )
            corrupt(bots.store.release_path("bot-active") / "dist/main.js")
            with self.assertRaises(recovery_slots.SlotValidationError):
                recovery_slots.active_slot_release(configured, "bot")

    def test_runtime_inventory_accepts_contained_links_and_rejects_unsafe_nodes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = recovery_slots.BotReleaseSlots(root / "bot", root / "state", ())

            contained = runtime_tree(root, domain="bot", version="1.0.0")
            (contained / "dist/alias.js").symlink_to("main.js")
            manifest = slots.stage(contained, "contained")
            self.assertIn(
                {"path": "dist/alias.js", "type": "symlink", "target": "main.js"},
                manifest["files"],
            )
            self.assertTrue(
                (slots.store.release_path("contained") / "dist/alias.js").is_symlink()
            )

            cases = (
                ("absolute", "/tmp/minime-outside"),
                ("escaping", "../../outside"),
                ("dangling", "missing.js"),
            )
            (root / "outside").write_text("outside\n", encoding="utf-8")
            for index, (name, target) in enumerate(cases, start=2):
                source = runtime_tree(root, domain="bot", version=f"{index}.0.0")
                (source / "dist/unsafe.js").symlink_to(target)
                with self.subTest(name=name), self.assertRaises(
                    recovery_slots.SlotValidationError
                ):
                    slots.stage(source, name)

            if hasattr(os, "mkfifo"):
                source = runtime_tree(root, domain="bot", version="5.0.0")
                os.mkfifo(source / "dist/special")
                with self.assertRaises(recovery_slots.SlotValidationError):
                    slots.stage(source, "special")

    def test_interrupted_switch_is_completed_from_durable_intent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = recovery_slots.BotReleaseSlots(root / "bot", root / "state", ())
            slots.stage(runtime_tree(root, domain="bot", version="1.0.0"), "one")
            slots.stage(runtime_tree(root, domain="bot", version="2.0.0"), "two")
            slots.activate("one")
            with mock.patch.object(slots.state, "_apply", side_effect=OSError("interrupted")):
                with self.assertRaises(OSError):
                    slots.activate("two")
            self.assertEqual(os.readlink(root / "bot/current"), "releases/one")

            recovered = recovery_slots.SlotState(slots.store, root / "state")
            state = recovered.reconcile()
            self.assertEqual((state["current"], state["previous"]), ("two", "one"))
            self.assertEqual(os.readlink(root / "bot/current"), "releases/two")
            self.assertEqual(os.readlink(root / "bot/previous"), "releases/one")

    def test_domain_lock_serializes_complete_concurrent_transitions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = recovery_slots.BotReleaseSlots(root / "bot", root / "state", ())
            slots.stage(runtime_tree(root, domain="bot", version="1.0.0"), "one")
            slots.stage(runtime_tree(root, domain="bot", version="2.0.0"), "two")
            slots.activate("one")
            peer = recovery_slots.SlotState(slots.store, root / "state")
            entered = threading.Event()
            release = threading.Event()
            second_completed = threading.Event()
            errors: list[BaseException] = []
            original_apply = slots.state._apply

            def blocked_apply(current: str, previous: str | None) -> None:
                entered.set()
                if not release.wait(2):
                    raise AssertionError("slot transition test lock was not released")
                original_apply(current, previous)

            def run(function: object, completed: threading.Event | None = None) -> None:
                try:
                    assert callable(function)
                    function()
                except BaseException as exc:
                    errors.append(exc)
                finally:
                    if completed is not None:
                        completed.set()

            with mock.patch.object(slots.state, "_apply", side_effect=blocked_apply):
                first = threading.Thread(target=run, args=(lambda: slots.activate("two"),))
                first.start()
                self.assertTrue(entered.wait(2))
                second = threading.Thread(
                    target=run,
                    args=(lambda: peer.activate("one"), second_completed),
                )
                second.start()
                self.assertFalse(second_completed.wait(0.1))
                release.set()
                first.join(2)
                second.join(2)
            self.assertFalse(first.is_alive())
            self.assertFalse(second.is_alive())
            self.assertEqual(errors, [])
            state = slots.state.reconcile()
            self.assertEqual((state["current"], state["previous"]), ("one", "two"))
            self.assertEqual(os.readlink(root / "bot/current"), "releases/one")
            self.assertEqual(os.readlink(root / "bot/previous"), "releases/two")
            self.assertEqual(stat.S_IMODE(slots.state.lock_path.stat().st_mode), 0o600)

    def test_manifest_checksum_and_file_modes_detect_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = recovery_slots.BotReleaseSlots(root / "bot", root / "state", ())
            slots.stage(runtime_tree(root, domain="bot", version="1.0.0"), "one")
            release = slots.store.release_path("one")
            corrupt(release / "dist/main.js")
            with self.assertRaises(recovery_slots.SlotValidationError):
                slots.store.validate("one")

            source = runtime_tree(root, domain="bot", version="2.0.0")
            slots.stage(source, "two")
            manifest_path = slots.store.release_path("two") / recovery_slots.MANIFEST_NAME
            manifest_path.chmod(0o644)
            manifest = json.loads(manifest_path.read_text("ascii"))
            manifest["packageVersion"] = "9.9.9"
            manifest_path.write_text(json.dumps(manifest), encoding="ascii")
            manifest_path.chmod(0o444)
            with self.assertRaises(recovery_slots.SlotValidationError):
                slots.store.validate("two")

    def test_capsule_upgrade_and_bot_deploy_never_switch_each_other(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            policy, runner = runtime_policy(root)
            capsules = recovery_slots.CapsuleSlots(
                root / "capsules",
                root / "state",
                startup_timeout_seconds=5,
                command_runner=runner,
            )
            bots = recovery_slots.BotReleaseSlots(root / "bots", root / "state", ())
            capsules.stage(runtime_tree(root, domain="capsule", version="1.0.0"), "cap-1", policy)
            capsules.activate("cap-1")
            bots.stage(runtime_tree(root, domain="bot", version="1.0.0"), "bot-1")
            bots.activate("bot-1")
            capsule_target = os.readlink(root / "capsules/current")

            bots.stage(runtime_tree(root, domain="bot", version="2.0.0"), "bot-2")
            bots.activate("bot-2")
            self.assertEqual(os.readlink(root / "capsules/current"), capsule_target)
            self.assertEqual(os.readlink(root / "bots/current"), "releases/bot-2")


class RecoveryBotRollbackTests(unittest.TestCase):
    def test_config_pinned_restart_operation_is_reused_and_rechecked(self) -> None:
        calls: list[list[str]] = []

        def restart(argv: list[str], _timeout: int) -> subprocess.CompletedProcess[bytes]:
            calls.append(list(argv))
            return subprocess.CompletedProcess(argv, 0, b"", b"")

        pinned = recovery_config.validated_reviewed_operation(operation())
        registry = recovery_slots.ReviewedRestartRegistry((pinned,), runner=restart)
        self.assertTrue(registry.execute("restart-bot")["ok"])
        self.assertEqual(calls, [["/usr/bin/true"]])
        with mock.patch.object(
            recovery_slots,
            "reviewed_operation_executable_matches",
            return_value=False,
        ):
            result = registry.execute("restart-bot")
        self.assertEqual(result["code"], "executable_changed")
        self.assertEqual(calls, [["/usr/bin/true"]])

    def _slots(
        self,
        root: Path,
        return_codes: list[int],
    ) -> tuple[recovery_slots.BotReleaseSlots, list[list[str]]]:
        calls: list[list[str]] = []

        def restart(argv: list[str], _timeout: int) -> subprocess.CompletedProcess[bytes]:
            calls.append(list(argv))
            return subprocess.CompletedProcess(argv, return_codes.pop(0), b"", b"")

        slots = recovery_slots.BotReleaseSlots(
            root / "bot",
            root / "state",
            (operation(),),
            restart_runner=restart,
        )
        slots.stage(runtime_tree(root, domain="bot", version="1.0.0"), "old")
        slots.stage(runtime_tree(root, domain="bot", version="2.0.0"), "new")
        slots.activate("old")
        slots.activate("new")
        return slots, calls

    def test_offline_rollback_verifies_previous_and_runs_only_static_restart_id(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots, calls = self._slots(root, [0])
            result = slots.rollback("restart-bot")
            self.assertTrue(result["ok"])
            self.assertEqual(result["currentRelease"], "old")
            self.assertEqual(calls, [["/usr/bin/true"]])
            evidence_path = root / "state/bot-evidence" / str(result["evidenceFile"])
            self.assertEqual(stat.S_IMODE(evidence_path.stat().st_mode), 0o600)
            evidence = json.loads(evidence_path.read_text("ascii"))
            checksum = evidence.pop("checksum")
            self.assertEqual(
                checksum,
                hashlib.sha256(recovery_slots._canonical_json(evidence).encode("ascii")).hexdigest(),
            )
            self.assertEqual(evidence["outcome"], "rolled_back")

    def test_failed_restart_restores_former_verified_slot_and_restarts_it(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots, calls = self._slots(root, [1, 0])
            result = slots.rollback("restart-bot")
            self.assertFalse(result["ok"])
            self.assertTrue(result["restoredFormerSlot"])
            self.assertTrue(result["restoreRestartOk"])
            self.assertEqual(result["currentRelease"], "new")
            self.assertEqual(calls, [["/usr/bin/true"], ["/usr/bin/true"]])

    def test_broken_active_bot_is_not_restored_after_failed_rollback_restart(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots, calls = self._slots(root, [1])
            corrupt(slots.store.release_path("new") / "dist/main.js")
            result = slots.rollback("restart-bot")
            self.assertFalse(result["ok"])
            self.assertFalse(result["restoredFormerSlot"])
            self.assertEqual(result["currentRelease"], "old")
            self.assertEqual(calls, [["/usr/bin/true"]])

    def test_unreviewed_or_non_restart_operation_is_rejected_without_switch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots, calls = self._slots(root, [0])
            with self.assertRaises(recovery_slots.SlotValidationError):
                slots.rollback("not-reviewed")
            self.assertEqual(slots.state.reconcile()["current"], "new")
            self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
