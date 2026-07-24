from __future__ import annotations

from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock


SCRIPTS = Path(__file__).resolve().parents[1]
import sys

sys.path.insert(0, str(SCRIPTS))

import bot_slots


def write_file(path: Path, content: bytes, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    path.chmod(0o755 if executable else 0o644)


def source_tree(root: Path, name: str, content: bytes = b"release\n") -> Path:
    source = root / name
    source.mkdir(mode=0o755)
    source.chmod(0o755)
    write_file(source / "dist/main.js", content)
    write_file(source / "scripts/start-bot.sh", b"#!/bin/sh\n", executable=True)
    return source


def call_cli(*args: str) -> tuple[int, str, str]:
    stdout = io.StringIO()
    stderr = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(stderr):
        code = bot_slots.main(list(args))
    return code, stdout.getvalue(), stderr.getvalue()


def stage(slots: Path, source: Path, release_id: str) -> dict[str, object]:
    code, stdout, stderr = call_cli(
        "stage",
        "--slots-root",
        str(slots),
        "--source",
        str(source),
        "--release-id",
        release_id,
    )
    if code != 0:
        raise AssertionError(f"stage failed: code={code} stderr={stderr}")
    return json.loads(stdout)


def activate(slots: Path, release_id: str) -> dict[str, object]:
    code, stdout, stderr = call_cli(
        "activate",
        "--slots-root",
        str(slots),
        "--release-id",
        release_id,
    )
    if code != 0:
        raise AssertionError(f"activate failed: code={code} stderr={stderr}")
    return json.loads(stdout)


class BotSlotHappyPathTests(unittest.TestCase):
    def test_stage_activate_status_and_offline_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = root / "bot-slots"
            first = source_tree(root, "first", b"first\n")
            second = source_tree(root, "second", b"second\n")

            first_result = stage(slots, first, "release-1")
            self.assertFalse(first_result["idempotent"])
            self.assertEqual(stat.S_IMODE(slots.stat().st_mode), 0o700)
            self.assertEqual(
                stat.S_IMODE((slots / "releases").stat().st_mode), 0o700
            )
            release = slots / "releases/release-1"
            self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o700)
            self.assertEqual(
                stat.S_IMODE((release / "dist/main.js").stat().st_mode), 0o600
            )
            self.assertEqual(
                stat.S_IMODE((release / "scripts/start-bot.sh").stat().st_mode),
                0o700,
            )
            manifest = json.loads(
                (release / bot_slots.MANIFEST_NAME).read_text("ascii")
            )
            self.assertEqual(
                manifest["executableFiles"], ["scripts/start-bot.sh"]
            )

            activate(slots, "release-1")
            stage(slots, second, "release-2")
            activated = activate(slots, "release-2")
            self.assertEqual(activated["previousReleaseId"], "release-1")
            self.assertTrue((slots / "current").is_symlink())
            self.assertTrue((slots / "previous").is_symlink())
            self.assertEqual(
                os.readlink(slots / "current"), "releases/release-2"
            )
            self.assertEqual(
                os.readlink(slots / "previous"), "releases/release-1"
            )

            status_code, status_stdout, status_stderr = call_cli(
                "status", "--slots-root", str(slots), "--json"
            )
            self.assertEqual((status_code, status_stderr), (0, ""))
            self.assertEqual(
                json.loads(status_stdout),
                {
                    "currentManifestVerified": True,
                    "currentReleaseId": "release-2",
                    "previousManifestVerified": True,
                    "previousReleaseId": "release-1",
                },
            )

            class NoEnvironment(dict[str, str]):
                def __getitem__(self, _key: str) -> str:
                    raise AssertionError("rollback read the environment")

                def get(self, _key: str, _default: object = None) -> object:
                    raise AssertionError("rollback read the environment")

            (slots / "releases/release-2/dist/main.js").write_bytes(
                b"broken current\n"
            )
            with mock.patch.object(bot_slots.os, "environ", NoEnvironment()):
                rollback_result = bot_slots.rollback(slots)
            self.assertEqual(rollback_result["releaseId"], "release-1")
            self.assertEqual(
                os.readlink(slots / "current"), "releases/release-1"
            )
            self.assertEqual(
                os.readlink(slots / "previous"), "releases/release-2"
            )
            state = json.loads((slots / "state/active.json").read_text("ascii"))
            self.assertEqual(
                (state["releaseId"], state["previousReleaseId"]),
                ("release-1", "release-2"),
            )

    def test_stage_is_idempotent_and_reverifies_existing_release(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = root / "bot-slots"
            source = source_tree(root, "source")
            stage(slots, source, "same-release")
            repeated = stage(slots, source, "same-release")
            self.assertTrue(repeated["idempotent"])

            installed = slots / "releases/same-release/dist/main.js"
            installed.write_bytes(b"corrupted\n")
            code, _stdout, stderr = call_cli(
                "stage",
                "--slots-root",
                str(slots),
                "--source",
                str(source),
                "--release-id",
                "same-release",
            )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)
            self.assertIn("verification failed", stderr)

    def test_stage_does_not_reconcile_an_interrupted_activation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = root / "bot-slots"
            stage(slots, source_tree(root, "first"), "release-1")
            activate(slots, "release-1")
            stage(slots, source_tree(root, "second"), "release-2")

            state_dir = slots / "state"
            bot_slots._begin_transition(
                state_dir,
                current="release-1",
                previous=None,
                target_current="release-2",
                target_previous="release-1",
            )
            bot_slots._replace_selector(slots, "previous", "release-1")
            bot_slots._replace_selector(slots, "current", "release-2")
            selectors_before = (
                os.readlink(slots / "current"),
                os.readlink(slots / "previous"),
            )
            state_before = (state_dir / "active.json").read_bytes()
            transition_before = (state_dir / "transition.json").read_bytes()

            stage(slots, source_tree(root, "third"), "release-3")

            self.assertEqual(
                (
                    os.readlink(slots / "current"),
                    os.readlink(slots / "previous"),
                ),
                selectors_before,
            )
            self.assertEqual((state_dir / "active.json").read_bytes(), state_before)
            self.assertEqual(
                (state_dir / "transition.json").read_bytes(),
                transition_before,
            )

    def test_idempotent_activate_reconciles_state_after_interrupted_activation(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = root / "bot-slots"
            stage(slots, source_tree(root, "first"), "release-1")
            activate(slots, "release-1")
            stage(slots, source_tree(root, "second"), "release-2")

            bot_slots._replace_selector(slots, "previous", "release-1")
            bot_slots._replace_selector(slots, "current", "release-2")
            stale = json.loads((slots / "state/active.json").read_text("ascii"))
            self.assertEqual(
                (stale["releaseId"], stale["previousReleaseId"]),
                ("release-1", None),
            )

            result = activate(slots, "release-2")
            self.assertTrue(result["idempotent"])
            reconciled = json.loads(
                (slots / "state/active.json").read_text("ascii")
            )
            self.assertEqual(
                (reconciled["releaseId"], reconciled["previousReleaseId"]),
                ("release-2", "release-1"),
            )

    def test_interrupted_selector_transitions_restore_last_committed_pair(
        self,
    ) -> None:
        for operation in ("activate", "rollback"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                slots = root / "bot-slots"
                stage(slots, source_tree(root, "first"), "release-1")
                activate(slots, "release-1")
                stage(slots, source_tree(root, "second"), "release-2")
                if operation == "rollback":
                    activate(slots, "release-2")
                    expected = ("releases/release-2", "releases/release-1")
                else:
                    expected = ("releases/release-1", None)

                original_replace = bot_slots._replace_selector
                calls = 0

                def interrupt_after_first(
                    selector_root: Path, name: str, release_id: str
                ) -> None:
                    nonlocal calls
                    calls += 1
                    original_replace(selector_root, name, release_id)
                    if calls == 1:
                        raise RuntimeError("simulated interruption")

                with mock.patch.object(
                    bot_slots, "_replace_selector", interrupt_after_first
                ):
                    with self.assertRaisesRegex(RuntimeError, "simulated interruption"):
                        if operation == "rollback":
                            bot_slots.rollback(slots)
                        else:
                            bot_slots.activate(slots, "release-2")

                self.assertTrue((slots / "state/transition.json").is_file())
                status, ok = bot_slots.status(slots)
                self.assertTrue(ok)
                self.assertEqual(os.readlink(slots / "current"), expected[0])
                if expected[1] is None:
                    self.assertFalse((slots / "previous").exists())
                else:
                    self.assertEqual(os.readlink(slots / "previous"), expected[1])
                self.assertFalse((slots / "state/transition.json").exists())
                self.assertEqual(
                    (status["currentReleaseId"], status["previousReleaseId"]),
                    (
                        Path(expected[0]).name,
                        Path(expected[1]).name if expected[1] is not None else None,
                    ),
                )

    def test_interrupted_transition_cleanup_preserves_committed_pair(self) -> None:
        for operation in ("activate", "rollback"):
            with self.subTest(operation=operation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                slots = root / "bot-slots"
                stage(slots, source_tree(root, "first"), "release-1")
                activate(slots, "release-1")
                stage(slots, source_tree(root, "second"), "release-2")
                if operation == "rollback":
                    activate(slots, "release-2")
                    expected = ("release-1", "release-2")
                else:
                    expected = ("release-2", "release-1")

                original_remove = bot_slots._remove_private_file
                interrupted = False

                def interrupt_transition_cleanup(path: Path) -> None:
                    nonlocal interrupted
                    if path.name == bot_slots.TRANSITION_NAME and not interrupted:
                        interrupted = True
                        raise RuntimeError("simulated cleanup interruption")
                    original_remove(path)

                with mock.patch.object(
                    bot_slots,
                    "_remove_private_file",
                    interrupt_transition_cleanup,
                ):
                    with self.assertRaisesRegex(
                        RuntimeError, "simulated cleanup interruption"
                    ):
                        if operation == "rollback":
                            bot_slots.rollback(slots)
                        else:
                            bot_slots.activate(slots, "release-2")

                self.assertTrue((slots / "state/transition.json").is_file())
                status, ok = bot_slots.status(slots)
                self.assertTrue(ok)
                self.assertEqual(
                    (status["currentReleaseId"], status["previousReleaseId"]),
                    expected,
                )
                self.assertFalse((slots / "state/transition.json").exists())


class BotSlotSafetyTests(unittest.TestCase):
    def test_manifest_corruption_is_reported_with_verification_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = root / "bot-slots"
            stage(slots, source_tree(root, "source"), "release-1")
            activate(slots, "release-1")
            manifest = slots / "releases/release-1" / bot_slots.MANIFEST_NAME
            manifest.write_text("{}\n", encoding="ascii")
            manifest.chmod(0o600)

            code, stdout, stderr = call_cli(
                "status", "--slots-root", str(slots), "--json"
            )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)
            self.assertEqual(json.loads(stdout)["currentManifestVerified"], False)
            self.assertEqual(stderr, "")

            code, _stdout, stderr = call_cli(
                "activate",
                "--slots-root",
                str(slots),
                "--release-id",
                "release-1",
            )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)
            self.assertIn("verification failed", stderr)

    def test_stage_rejects_symlinks_and_unsafe_modes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            symlink_source = source_tree(root, "symlink-source")
            (symlink_source / "dist/alias.js").symlink_to("main.js")
            code, _stdout, _stderr = call_cli(
                "stage",
                "--slots-root",
                str(root / "slots-a"),
                "--source",
                str(symlink_source),
                "--release-id",
                "symlinked",
            )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)

            unsafe_source = source_tree(root, "unsafe-source")
            (unsafe_source / "dist/main.js").chmod(0o666)
            code, _stdout, _stderr = call_cli(
                "stage",
                "--slots-root",
                str(root / "slots-b"),
                "--source",
                str(unsafe_source),
                "--release-id",
                "unsafe-mode",
            )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)

            real_source = source_tree(root, "real-source")
            source_link = root / "source-link"
            source_link.symlink_to(real_source, target_is_directory=True)
            code, _stdout, _stderr = call_cli(
                "stage",
                "--slots-root",
                str(root / "slots-c"),
                "--source",
                str(source_link),
                "--release-id",
                "source-link",
            )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)

            real_slots = root / "real-slots"
            real_slots.mkdir(mode=0o700)
            real_slots.chmod(0o700)
            slots_link = root / "slots-link"
            slots_link.symlink_to(real_slots, target_is_directory=True)
            code, _stdout, _stderr = call_cli(
                "stage",
                "--slots-root",
                str(slots_link),
                "--source",
                str(real_source),
                "--release-id",
                "slots-link",
            )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)

            overlap_source = source_tree(root, "overlap-source")
            overlapping_slots = overlap_source / "bot-slots"
            code, _stdout, _stderr = call_cli(
                "stage",
                "--slots-root",
                str(overlapping_slots),
                "--source",
                str(overlap_source),
                "--release-id",
                "overlap",
            )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)
            self.assertFalse(overlapping_slots.exists())

    def test_manifest_verification_detects_executable_mode_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = root / "bot-slots"
            stage(slots, source_tree(root, "source"), "release-1")
            activate(slots, "release-1")
            (slots / "releases/release-1/scripts/start-bot.sh").chmod(0o600)

            code, stdout, stderr = call_cli(
                "status", "--slots-root", str(slots), "--json"
            )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)
            self.assertEqual(
                json.loads(stdout)["currentManifestVerified"], False
            )
            self.assertEqual(stderr, "")

    def test_usage_and_verification_failures_have_distinct_exit_codes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = source_tree(root, "source")
            code, _stdout, _stderr = call_cli(
                "stage",
                "--slots-root",
                str(root / "slots"),
                "--source",
                str(source),
                "--release-id",
                "../escape",
            )
            self.assertEqual(code, bot_slots.EXIT_USAGE)

            missing_code, _stdout, _stderr = call_cli(
                "activate",
                "--slots-root",
                str(root / "slots"),
                "--release-id",
                "missing",
            )
            self.assertEqual(
                missing_code,
                bot_slots.EXIT_VERIFICATION_FAILED,
            )

    def test_file_byte_and_manifest_bounds_are_enforced(self) -> None:
        self.assertEqual(
            bot_slots._MAX_MANIFEST_BYTES,
            16 * 1024 * 1024,
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = source_tree(root, "source")
            write_file(source / "extra.txt", b"x")

            with mock.patch.object(bot_slots, "_MAX_FILE_COUNT", 1):
                code, _stdout, _stderr = call_cli(
                    "stage",
                    "--slots-root",
                    str(root / "file-bound"),
                    "--source",
                    str(source),
                    "--release-id",
                    "file-bound",
                )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)

            with mock.patch.object(bot_slots, "_MAX_TOTAL_BYTES", 3):
                code, _stdout, _stderr = call_cli(
                    "stage",
                    "--slots-root",
                    str(root / "byte-bound"),
                    "--source",
                    str(source),
                    "--release-id",
                    "byte-bound",
                )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)

            with mock.patch.object(bot_slots, "_MAX_MANIFEST_BYTES", 128):
                code, _stdout, _stderr = call_cli(
                    "stage",
                    "--slots-root",
                    str(root / "manifest-bound"),
                    "--source",
                    str(source),
                    "--release-id",
                    "manifest-bound",
                )
            self.assertEqual(code, bot_slots.EXIT_VERIFICATION_FAILED)


class BotSlotPruneTests(unittest.TestCase):
    def test_prune_removes_only_unreferenced_releases(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = root / "bot-slots"
            for release_id in ("one", "two", "state-only", "unused"):
                stage(
                    slots,
                    source_tree(root, f"source-{release_id}", release_id.encode()),
                    release_id,
                )
            activate(slots, "one")
            activate(slots, "two")
            bot_slots._atomic_private_json(
                slots / "state/active.json",
                {
                    "releaseId": "two",
                    "previousReleaseId": "state-only",
                    "activatedAt": "2026-07-24T00:00:00Z",
                },
            )

            code, stdout, stderr = call_cli(
                "prune", "--slots-root", str(slots)
            )
            self.assertEqual((code, stderr), (0, ""))
            self.assertEqual(json.loads(stdout)["removedReleaseIds"], ["unused"])
            self.assertTrue((slots / "releases/one").is_dir())
            self.assertTrue((slots / "releases/two").is_dir())
            self.assertTrue((slots / "releases/state-only").is_dir())
            self.assertFalse((slots / "releases/unused").exists())

    def test_prune_removes_abandoned_staging_directories(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            slots = root / "bot-slots"
            stage(slots, source_tree(root, "source"), "release-1")
            activate(slots, "release-1")
            abandoned = slots / "releases/release-2.tmp.12345"
            abandoned.mkdir(mode=0o700)
            partial = abandoned / "partial"
            partial.write_bytes(b"incomplete")
            partial.chmod(0o600)

            code, stdout, stderr = call_cli(
                "prune", "--slots-root", str(slots)
            )
            self.assertEqual((code, stderr), (0, ""))
            self.assertEqual(
                json.loads(stdout)["removedTemporaryDirectories"],
                ["release-2.tmp.12345"],
            )
            self.assertFalse(abandoned.exists())


if __name__ == "__main__":
    unittest.main()
