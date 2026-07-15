#!/usr/bin/env python3
"""Offline, manifest-verified recovery capsule and bot release slots."""

from __future__ import annotations

import argparse
import ast
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import http.client
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Iterable
import uuid

from recovery_config import (
    PINNED_PI_VERSION,
    RecoveryConfig,
    RecoveryConfigError,
    load_recovery_config,
    validated_reviewed_operation,
)


SLOT_SCHEMA_VERSION = 1
MANIFEST_NAME = ".recovery-slot-manifest.json"
_SAFE_RELEASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SAFE_PACKAGE_NAME = re.compile(
    r"^(?:@[a-z0-9][a-z0-9._-]{0,127}/)?[a-z0-9][a-z0-9._-]{0,127}$"
)
_SAFE_VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$")
_MAX_JSON_BYTES = 4 * 1024 * 1024
_CAPSULE_FILES = (
    "package.json",
    "dist/config.js",
    "dist/extensions/pi/codex-transport-overflow.js",
    "dist/extensions/pi/knowledge-tools.js",
    "dist/recovery/fixer-session.js",
    "dist/extensions/pi/recovery.js",
    "dist/extensions/pi/web-tools.js",
    "dist/pi-rpc-protocol.js",
    "dist/pi-extensions/recovery-mode.js",
    "dist/pi-extensions/recovery-protocol.js",
    "dist/session-manager.js",
    "dist/types.js",
    "dist/workspace-contract.js",
    "scripts/alertmanager_webhook.py",
    "scripts/monitoring_native.py",
    "scripts/recovery_cli.py",
    "scripts/recovery_config.py",
    "scripts/recovery_ledger.py",
    "scripts/recovery_rootctl.py",
    "scripts/recovery_slots.py",
    "scripts/recovery_supervisor.py",
    "scripts/runtime_doctor.py",
)
_BOT_FILES = ("package.json", "dist/main.js")


class RecoverySlotError(RuntimeError):
    """A slot operation cannot be completed safely."""


class SlotValidationError(RecoverySlotError):
    """A staged release, manifest, prerequisite, or state is invalid."""


class SlotBootstrapError(RecoverySlotError):
    """Neither the selected capsule nor its one fallback became healthy."""


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _checksum_document(value: dict[str, Any]) -> str:
    unsigned = {key: item for key, item in value.items() if key != "checksum"}
    return hashlib.sha256(_canonical_json(unsigned).encode("ascii")).hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _same_owner(details: os.stat_result) -> bool:
    return not hasattr(os, "getuid") or details.st_uid == os.getuid()


def _private_directory(path: Path) -> Path:
    try:
        path.mkdir(parents=True, mode=0o700, exist_ok=True)
        details = path.lstat()
    except OSError as exc:
        raise SlotValidationError("slot storage is unavailable") from exc
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or not _same_owner(details)
        or stat.S_IMODE(details.st_mode) & 0o077
    ):
        raise SlotValidationError("slot storage is not owner-only")
    return path.resolve()


def _safe_release_id(value: Any) -> str:
    if not isinstance(value, str) or _SAFE_RELEASE_ID.fullmatch(value) is None:
        raise SlotValidationError("release ID is invalid")
    return value


def _sha256_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    finally:
        os.close(descriptor)
    return digest.hexdigest(), size


def _read_json(path: Path, *, private: bool) -> dict[str, Any]:
    try:
        details = path.lstat()
        if (
            not stat.S_ISREG(details.st_mode)
            or stat.S_ISLNK(details.st_mode)
            or not _same_owner(details)
            or details.st_size > _MAX_JSON_BYTES
            or (private and stat.S_IMODE(details.st_mode) != 0o600)
        ):
            raise SlotValidationError("slot JSON metadata is unsafe")
        value = json.loads(path.read_text("ascii"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SlotValidationError("slot JSON metadata is unreadable") from exc
    if not isinstance(value, dict):
        raise SlotValidationError("slot JSON metadata is invalid")
    return value


def _atomic_private_json(path: Path, value: dict[str, Any]) -> None:
    parent = _private_directory(path.parent)
    document = dict(value)
    document["checksum"] = _checksum_document(document)
    encoded = (_canonical_json(document) + "\n").encode("ascii")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        written = 0
        while written < len(encoded):
            count = os.write(descriptor, encoded[written:])
            if count <= 0:
                raise OSError("short slot metadata write")
            written += count
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        _fsync_directory(parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _validate_relative_symlink(root: Path, link: Path, target: str) -> None:
    if not target or "\0" in target or Path(target).is_absolute():
        raise SlotValidationError("runtime tree contains an unsafe symlink")
    relative_link = link.relative_to(root).as_posix()
    normalized = PurePosixPath(relative_link).parent.joinpath(PurePosixPath(target))
    depth = 0
    for part in normalized.parts:
        if part in {"", "."}:
            continue
        if part == "..":
            depth -= 1
        else:
            depth += 1
        if depth < 0:
            raise SlotValidationError("runtime tree symlink escapes its release")
    try:
        resolved = link.resolve(strict=True)
        resolved.relative_to(root.resolve())
    except (OSError, ValueError) as exc:
        raise SlotValidationError("runtime tree symlink is dangling or escaping") from exc


def _inventory(root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    def visit(directory: Path) -> None:
        try:
            entries = sorted(os.scandir(directory), key=lambda item: item.name)
        except OSError as exc:
            raise SlotValidationError("runtime tree is unreadable") from exc
        for entry in entries:
            path = Path(entry.path)
            relative = path.relative_to(root).as_posix()
            if relative == MANIFEST_NAME:
                continue
            try:
                details = entry.stat(follow_symlinks=False)
            except OSError as exc:
                raise SlotValidationError("runtime tree changed during inspection") from exc
            if stat.S_ISDIR(details.st_mode):
                records.append({"path": relative, "type": "directory"})
                visit(path)
            elif stat.S_ISREG(details.st_mode):
                digest, size = _sha256_file(path)
                records.append(
                    {
                        "path": relative,
                        "type": "file",
                        "size": size,
                        "sha256": digest,
                        "executable": bool(details.st_mode & 0o111),
                    }
                )
            elif stat.S_ISLNK(details.st_mode):
                if not _same_owner(details):
                    raise SlotValidationError("runtime tree symlink has the wrong owner")
                target = os.readlink(path)
                _validate_relative_symlink(root, path, target)
                records.append({"path": relative, "type": "symlink", "target": target})
            else:
                raise SlotValidationError("runtime tree contains a special file")

    visit(root)
    return sorted(records, key=lambda item: str(item["path"]))


def _json_manifest(path: Path) -> dict[str, Any]:
    try:
        details = path.lstat()
        if not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode):
            raise SlotValidationError("package manifest is unsafe")
        if details.st_size > 1024 * 1024:
            raise SlotValidationError("package manifest is too large")
        value = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SlotValidationError("package manifest is unreadable") from exc
    if not isinstance(value, dict):
        raise SlotValidationError("package manifest is invalid")
    return value


def _package_dependency_names(manifest: dict[str, Any]) -> list[str]:
    dependencies = manifest.get("dependencies", {})
    if not isinstance(dependencies, dict):
        raise SlotValidationError("package dependencies are invalid")
    names: list[str] = []
    for name, requested in dependencies.items():
        if (
            not isinstance(name, str)
            or _SAFE_PACKAGE_NAME.fullmatch(name) is None
            or not isinstance(requested, str)
            or not requested
            or len(requested) > 256
        ):
            raise SlotValidationError("package dependency entry is invalid")
        names.append(name)
    return sorted(names)


def _resolve_dependency(package_directory: Path, root: Path, name: str) -> Path:
    cursor = package_directory
    while True:
        candidate = cursor / "node_modules" / Path(*name.split("/"))
        if candidate.exists():
            try:
                details = candidate.lstat()
                resolved = candidate.resolve(strict=True)
                resolved.relative_to(root.resolve())
            except (OSError, ValueError) as exc:
                raise SlotValidationError("dependency escapes the runtime tree") from exc
            if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode):
                raise SlotValidationError("dependency directory is unsafe")
            return candidate
        if cursor == root:
            break
        try:
            cursor.relative_to(root)
        except ValueError:
            break
        cursor = cursor.parent
    raise SlotValidationError("installed dependency closure is incomplete")


def _dependency_closure(root: Path) -> list[dict[str, str]]:
    root_manifest = _json_manifest(root / "package.json")
    queue: list[tuple[Path, str]] = [(root, name) for name in _package_dependency_names(root_manifest)]
    seen: set[Path] = set()
    closure: list[dict[str, str]] = []
    while queue:
        package_directory, requested_name = queue.pop(0)
        dependency = _resolve_dependency(package_directory, root, requested_name)
        identity = dependency.resolve()
        if identity in seen:
            continue
        seen.add(identity)
        manifest = _json_manifest(dependency / "package.json")
        name = manifest.get("name")
        version = manifest.get("version")
        if (
            name != requested_name
            or not isinstance(version, str)
            or _SAFE_VERSION.fullmatch(version) is None
        ):
            raise SlotValidationError("installed dependency identity is invalid")
        closure.append(
            {
                "name": name,
                "version": version,
                "path": dependency.relative_to(root).as_posix(),
            }
        )
        queue.extend((dependency, child) for child in _package_dependency_names(manifest))
    return sorted(closure, key=lambda item: (item["name"], item["path"]))


CommandRunner = Callable[[list[str], float], subprocess.CompletedProcess[bytes]]


def _default_command_runner(argv: list[str], timeout: float) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        argv,
        cwd="/",
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
        shell=False,
    )


def _executable_record(
    path_value: Any,
    expected_version: Any,
    label: str,
    command_runner: CommandRunner,
) -> dict[str, str]:
    if not isinstance(path_value, str) or not Path(path_value).is_absolute() or "\0" in path_value:
        raise SlotValidationError(f"{label} executable path is invalid")
    if not isinstance(expected_version, str) or _SAFE_VERSION.fullmatch(expected_version) is None:
        raise SlotValidationError(f"{label} version is invalid")
    path = Path(path_value)
    try:
        resolved = path.resolve(strict=True)
        details = resolved.stat()
    except OSError as exc:
        raise SlotValidationError(f"{label} executable is unavailable") from exc
    if (
        not stat.S_ISREG(details.st_mode)
        or not os.access(resolved, os.X_OK)
        or stat.S_IMODE(details.st_mode) & 0o022
    ):
        raise SlotValidationError(f"{label} executable is unsafe")
    try:
        result = command_runner([str(path), "--version"], 5.0)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise SlotValidationError(f"{label} version check failed") from exc
    output = result.stdout if result.stdout.strip() else result.stderr
    if result.returncode != 0 or len(output) > 4096:
        raise SlotValidationError(f"{label} version check failed")
    try:
        detected = output.decode("ascii", "strict").strip()
    except UnicodeDecodeError as exc:
        raise SlotValidationError(f"{label} version check failed") from exc
    if label == "Node" and detected.startswith("v"):
        detected = detected[1:]
    if detected != expected_version:
        raise SlotValidationError(f"{label} version mismatch")
    digest, _ = _sha256_file(resolved)
    return {
        "path": str(path),
        "resolvedPath": str(resolved),
        "version": expected_version,
        "sha256": digest,
    }


def _validate_executable_record(
    value: Any, label: str, command_runner: CommandRunner
) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != {"path", "resolvedPath", "version", "sha256"}:
        raise SlotValidationError(f"{label} prerequisite record is invalid")
    expected = _executable_record(value["path"], value["version"], label, command_runner)
    if expected != value:
        raise SlotValidationError(f"{label} prerequisite changed")
    return expected


def _copy_runtime(source: Path, destination: Path, domain: str) -> None:
    try:
        details = source.lstat()
    except OSError as exc:
        raise SlotValidationError("runtime source is unavailable") from exc
    if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode):
        raise SlotValidationError("runtime source is unsafe")
    names = ("package.json", "dist", "scripts", "node_modules") if domain == "capsule" else (
        "package.json",
        "dist",
        "scripts",
        "node_modules",
    )
    manifest = _json_manifest(source / "package.json")
    required = {"package.json", "dist"}
    if _package_dependency_names(manifest):
        required.add("node_modules")
    if domain == "capsule":
        required.add("scripts")
    for name in names:
        source_item = source / name
        if not source_item.exists():
            if name in required:
                raise SlotValidationError("runtime source is incomplete")
            continue
        try:
            item_details = source_item.lstat()
        except OSError as exc:
            raise SlotValidationError("runtime source changed while staging") from exc
        if stat.S_ISLNK(item_details.st_mode):
            raise SlotValidationError("runtime source top-level item is a symlink")
        target = destination / name
        if stat.S_ISDIR(item_details.st_mode):
            def ignore_shims(directory: str, entries: list[str]) -> set[str]:
                if Path(directory).name == "node_modules" and ".bin" in entries:
                    return {".bin"}
                return set()

            try:
                shutil.copytree(
                    source_item,
                    target,
                    symlinks=True,
                    ignore=ignore_shims if name == "node_modules" else None,
                )
            except (OSError, shutil.Error) as exc:
                raise SlotValidationError("runtime source cannot be copied safely") from exc
        elif stat.S_ISREG(item_details.st_mode):
            try:
                shutil.copy2(source_item, target, follow_symlinks=False)
            except OSError as exc:
                raise SlotValidationError("runtime source cannot be copied safely") from exc
        else:
            raise SlotValidationError("runtime source contains a special item")
    _inventory(destination)


def _freeze_release(root: Path) -> None:
    directories: list[Path] = []
    for directory, child_directories, files in os.walk(root, topdown=True, followlinks=False):
        current = Path(directory)
        directories.append(current)
        child_directories[:] = [
            name for name in child_directories if not (current / name).is_symlink()
        ]
        for name in files:
            path = current / name
            details = path.lstat()
            if stat.S_ISREG(details.st_mode):
                os.chmod(path, 0o555 if details.st_mode & 0o111 else 0o444)
    for directory in reversed(directories):
        os.chmod(directory, 0o555)


def _validate_required_layout(root: Path, domain: str) -> dict[str, Any]:
    for relative in _CAPSULE_FILES if domain == "capsule" else _BOT_FILES:
        path = root / relative
        try:
            details = path.lstat()
        except OSError as exc:
            raise SlotValidationError("required runtime artifact is missing") from exc
        if not stat.S_ISREG(details.st_mode) or stat.S_ISLNK(details.st_mode):
            raise SlotValidationError("required runtime artifact is unsafe")
    manifest = _json_manifest(root / "package.json")
    package_version = manifest.get("version")
    if not isinstance(package_version, str) or _SAFE_VERSION.fullmatch(package_version) is None:
        raise SlotValidationError("runtime package version is invalid")
    if domain == "capsule":
        dependencies = manifest.get("dependencies")
        pi_requested = dependencies.get("@earendil-works/pi-coding-agent") if isinstance(dependencies, dict) else None
        if pi_requested != PINNED_PI_VERSION:
            raise SlotValidationError("capsule Pi dependency is not pinned")
    return manifest


class ReleaseStore:
    """Stages complete local runtime trees and verifies immutable manifests."""

    def __init__(
        self,
        root: Path,
        *,
        domain: str,
        slot_policy: dict[str, Any] | None = None,
        command_runner: CommandRunner = _default_command_runner,
    ):
        if domain not in {"capsule", "bot"}:
            raise ValueError("slot domain is invalid")
        self.domain = domain
        self.root = _private_directory(root)
        self.releases = _private_directory(self.root / "releases")
        self.command_runner = command_runner
        self.slot_policy = dict(slot_policy) if slot_policy is not None else None

    def release_path(self, release_id: str) -> Path:
        return self.releases / _safe_release_id(release_id)

    def _capsule_prerequisites(self, policy: dict[str, Any]) -> dict[str, Any]:
        node = _executable_record(
            policy.get("nodeExecutable"), policy.get("nodeVersion"), "Node", self.command_runner
        )
        pi = _executable_record(
            policy.get("piExecutable"), policy.get("piVersion"), "Pi", self.command_runner
        )
        if (
            pi["version"] != PINNED_PI_VERSION
            or node["resolvedPath"] == pi["resolvedPath"]
        ):
            raise SlotValidationError("capsule Pi prerequisite is not pinned")
        return {"node": node, "pi": pi}

    def _self_check(self, root: Path, prerequisites: dict[str, Any]) -> dict[str, Any]:
        checked_python = 0
        scripts = root / "scripts"
        for path in sorted(scripts.glob("*.py")):
            try:
                ast.parse(path.read_text("utf-8"), filename=path.name)
            except (OSError, UnicodeError, SyntaxError) as exc:
                raise SlotValidationError("capsule Python self-check failed") from exc
            checked_python += 1
        if checked_python == 0:
            raise SlotValidationError("capsule has no Python artifacts")
        try:
            python_result = self.command_runner(
                [sys.executable, str(root / "scripts/recovery_supervisor.py"), "--help"],
                30.0,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SlotValidationError("capsule Python self-check failed") from exc
        if python_result.returncode != 0:
            raise SlotValidationError("capsule Python self-check failed")
        node = str(prerequisites["node"]["path"])
        try:
            result = self.command_runner(
                [node, "--check", str(root / "dist/recovery/fixer-session.js")], 30.0
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SlotValidationError("capsule Node self-check failed") from exc
        if result.returncode != 0:
            raise SlotValidationError("capsule Node self-check failed")
        try:
            import_result = self.command_runner(
                [
                    node,
                    "--input-type=module",
                    "--eval",
                    (
                        f"const fixer=await import({json.dumps((root / 'dist/recovery/fixer-session.js').as_uri())});"
                        f"const rpc=await import({json.dumps((root / 'dist/pi-rpc-protocol.js').as_uri())});"
                        "const options=fixer.recoveryExtensionOptions('diagnose',process.env);"
                        "const args=rpc.resolvePiExtensionArgs(options);"
                        "if(!args.includes('--extension')||options.extraExtensions.length!==1)process.exit(2);"
                    ),
                ],
                30.0,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise SlotValidationError("capsule Node import self-check failed") from exc
        if import_result.returncode != 0:
            raise SlotValidationError("capsule Node import self-check failed")
        return {
            "pythonFiles": checked_python,
            "pythonHelp": "passed",
            "nodeSyntax": "passed",
            "nodeImport": "passed",
            "manifest": "passed",
        }

    def stage(
        self,
        source: Path,
        release_id: str,
        *,
        slot_policy: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        identifier = _safe_release_id(release_id)
        if self.domain == "capsule":
            if slot_policy is None:
                slot_policy = self.slot_policy
            if slot_policy is None:
                raise SlotValidationError("capsule prerequisite policy is unavailable")
            if self.slot_policy is not None and dict(slot_policy) != self.slot_policy:
                raise SlotValidationError("capsule prerequisite policy changed during staging")
            self.slot_policy = dict(slot_policy)
        destination = self.release_path(identifier)
        if destination.exists() or destination.is_symlink():
            raise RecoverySlotError("release ID is already staged")
        temporary = Path(tempfile.mkdtemp(prefix=f".stage-{identifier}-", dir=self.releases))
        try:
            _copy_runtime(source, temporary, self.domain)
            package_manifest = _validate_required_layout(temporary, self.domain)
            dependencies = _dependency_closure(temporary)
            prerequisites: dict[str, Any] = {}
            self_check: dict[str, Any] = {"manifest": "passed"}
            if self.domain == "capsule":
                assert slot_policy is not None
                prerequisites = self._capsule_prerequisites(slot_policy)
                self_check = self._self_check(temporary, prerequisites)
                pi_entries = [
                    item for item in dependencies if item["name"] == "@earendil-works/pi-coding-agent"
                ]
                if len(pi_entries) != 1 or pi_entries[0]["version"] != PINNED_PI_VERSION:
                    raise SlotValidationError("capsule installed Pi dependency is invalid")
            manifest: dict[str, Any] = {
                "schemaVersion": SLOT_SCHEMA_VERSION,
                "domain": self.domain,
                "releaseId": identifier,
                "packageVersion": package_manifest["version"],
                "createdAt": _utc_now(),
                "files": _inventory(temporary),
                "dependencies": dependencies,
                "prerequisites": prerequisites,
                "selfCheck": self_check,
            }
            manifest["checksum"] = _checksum_document(manifest)
            manifest_path = temporary / MANIFEST_NAME
            manifest_path.write_text(_canonical_json(manifest) + "\n", encoding="ascii")
            os.chmod(manifest_path, 0o444)
            _freeze_release(temporary)
            self._validate_path(temporary, expected_release_id=identifier)
            # Darwin refuses to rename the fully read-only directory itself.
            # Only the unpublished staging root is made writable; all content
            # remains frozen, and activation revalidates the final root mode.
            os.chmod(temporary, 0o700)
            os.replace(temporary, destination)
            os.chmod(destination, 0o555)
            _fsync_directory(self.releases)
            return self.validate(identifier)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise

    def _validate_path(
        self, path: Path, *, expected_release_id: str | None = None
    ) -> dict[str, Any]:
        try:
            root_details = path.lstat()
            path.resolve(strict=True).relative_to(self.releases)
        except (OSError, ValueError) as exc:
            raise SlotValidationError("release path is unavailable") from exc
        if stat.S_ISLNK(root_details.st_mode) or not stat.S_ISDIR(root_details.st_mode):
            raise SlotValidationError("release path is unsafe")
        manifest_path = path / MANIFEST_NAME
        manifest = _read_json(manifest_path, private=False)
        expected_keys = {
            "schemaVersion",
            "domain",
            "releaseId",
            "packageVersion",
            "createdAt",
            "files",
            "dependencies",
            "prerequisites",
            "selfCheck",
            "checksum",
        }
        identifier = _safe_release_id(manifest.get("releaseId"))
        if (
            set(manifest) != expected_keys
            or manifest.get("schemaVersion") != SLOT_SCHEMA_VERSION
            or manifest.get("domain") != self.domain
            or (expected_release_id is not None and identifier != expected_release_id)
            or manifest.get("checksum") != _checksum_document(manifest)
            or not isinstance(manifest.get("files"), list)
            or not isinstance(manifest.get("dependencies"), list)
            or not isinstance(manifest.get("prerequisites"), dict)
            or not isinstance(manifest.get("selfCheck"), dict)
            or not isinstance(manifest.get("packageVersion"), str)
        ):
            raise SlotValidationError("release manifest is invalid")
        if stat.S_IMODE(manifest_path.stat().st_mode) != 0o444:
            raise SlotValidationError("release manifest mode is invalid")
        package_manifest = _validate_required_layout(path, self.domain)
        if package_manifest.get("version") != manifest["packageVersion"]:
            raise SlotValidationError("release package version changed")
        actual_inventory = _inventory(path)
        if actual_inventory != manifest["files"]:
            raise SlotValidationError("release contents do not match the manifest")
        for record in actual_inventory:
            if record["type"] != "file":
                continue
            details = (path / str(record["path"])).lstat()
            expected_mode = 0o555 if record["executable"] else 0o444
            if stat.S_IMODE(details.st_mode) != expected_mode or not _same_owner(details):
                raise SlotValidationError("release file is mutable or has the wrong owner")
        if _dependency_closure(path) != manifest["dependencies"]:
            raise SlotValidationError("release dependency closure changed")
        for directory, child_directories, files in os.walk(path, followlinks=False):
            details = Path(directory).lstat()
            if stat.S_IMODE(details.st_mode) != 0o555 or not _same_owner(details):
                raise SlotValidationError("release directory is mutable")
            child_directories[:] = [
                name for name in child_directories if not (Path(directory) / name).is_symlink()
            ]
            del files
        if self.domain == "capsule":
            prerequisites = manifest["prerequisites"]
            if set(prerequisites) != {"node", "pi"}:
                raise SlotValidationError("capsule prerequisites are invalid")
            _validate_executable_record(prerequisites["node"], "Node", self.command_runner)
            pi = _validate_executable_record(prerequisites["pi"], "Pi", self.command_runner)
            if pi["version"] != PINNED_PI_VERSION:
                raise SlotValidationError("capsule Pi prerequisite is not pinned")
            if (
                self.slot_policy is not None
                and prerequisites != self._capsule_prerequisites(self.slot_policy)
            ):
                raise SlotValidationError("capsule prerequisites differ from static policy")
        elif manifest["prerequisites"]:
            raise SlotValidationError("bot release has unexpected prerequisites")
        return manifest

    def validate(self, release_id: str) -> dict[str, Any]:
        identifier = _safe_release_id(release_id)
        return self._validate_path(
            self.release_path(identifier), expected_release_id=identifier
        )


class SlotState:
    """Durable current/previous state with recoverable symlink transitions."""

    def __init__(self, store: ReleaseStore, state_directory: Path):
        self.store = store
        self.root = store.root
        self.domain = store.domain
        self.state_directory = _private_directory(state_directory)
        self.path = self.state_directory / f"{self.domain}-state.json"
        if not self.path.exists():
            if any(
                (self.root / name).exists() or (self.root / name).is_symlink()
                for name in ("current", "previous")
            ):
                raise SlotValidationError("slot state is missing for existing links")
            self._write(
                {
                    "schemaVersion": SLOT_SCHEMA_VERSION,
                    "domain": self.domain,
                    "sequence": 0,
                    "generation": 0,
                    "current": None,
                    "previous": None,
                    "fallbackAttempted": False,
                    "pending": None,
                    "lastReason": "initialized",
                }
            )
        self.reconcile()

    def _write(self, value: dict[str, Any]) -> None:
        _atomic_private_json(self.path, value)

    def _load(self) -> dict[str, Any]:
        value = _read_json(self.path, private=True)
        expected = {
            "schemaVersion",
            "domain",
            "sequence",
            "generation",
            "current",
            "previous",
            "fallbackAttempted",
            "pending",
            "lastReason",
            "checksum",
        }
        if (
            set(value) != expected
            or value.get("schemaVersion") != SLOT_SCHEMA_VERSION
            or value.get("domain") != self.domain
            or value.get("checksum") != _checksum_document(value)
            or isinstance(value.get("sequence"), bool)
            or not isinstance(value.get("sequence"), int)
            or int(value["sequence"]) < 0
            or isinstance(value.get("generation"), bool)
            or not isinstance(value.get("generation"), int)
            or int(value["generation"]) < 0
            or not isinstance(value.get("fallbackAttempted"), bool)
            or not isinstance(value.get("lastReason"), str)
        ):
            raise SlotValidationError("slot state is invalid")
        for key in ("current", "previous"):
            if value[key] is not None:
                _safe_release_id(value[key])
        if value["current"] is not None and value["current"] == value["previous"]:
            raise SlotValidationError("slot state aliases current and previous")
        pending = value["pending"]
        if pending is not None:
            if not isinstance(pending, dict) or set(pending) != {
                "current",
                "previous",
                "generation",
                "fallbackAttempted",
                "reason",
            }:
                raise SlotValidationError("slot pending transition is invalid")
            for key in ("current", "previous"):
                if pending[key] is not None:
                    _safe_release_id(pending[key])
            if (
                pending["current"] is None
                or pending["current"] == pending["previous"]
                or isinstance(pending["generation"], bool)
                or not isinstance(pending["generation"], int)
                or pending["generation"] < value["generation"]
                or not isinstance(pending["fallbackAttempted"], bool)
                or not isinstance(pending["reason"], str)
            ):
                raise SlotValidationError("slot pending transition is invalid")
        return value

    def _link_release(self, name: str, release_id: str | None) -> None:
        link = self.root / name
        if release_id is None:
            try:
                link.unlink()
            except FileNotFoundError:
                return
            _fsync_directory(self.root)
            return
        release = self.store.release_path(release_id)
        try:
            details = release.lstat()
        except OSError as exc:
            raise SlotValidationError("slot transition target is unavailable") from exc
        if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode):
            raise SlotValidationError("slot transition target is unsafe")
        temporary = self.root / f".{name}.{uuid.uuid4().hex}"
        try:
            os.symlink(f"releases/{release_id}", temporary)
            os.replace(temporary, link)
            _fsync_directory(self.root)
        finally:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass

    def _apply(self, current: str, previous: str | None) -> None:
        self._link_release("previous", previous)
        self._link_release("current", current)
        _fsync_directory(self.root)

    def _assert_link(self, name: str, release_id: str | None) -> None:
        link = self.root / name
        if release_id is None:
            if link.exists() or link.is_symlink():
                raise SlotValidationError("slot link disagrees with durable state")
            return
        try:
            details = link.lstat()
            target = os.readlink(link)
        except OSError as exc:
            raise SlotValidationError("slot link is unavailable") from exc
        if not stat.S_ISLNK(details.st_mode) or target != f"releases/{release_id}":
            raise SlotValidationError("slot link is unsafe")

    def reconcile(self) -> dict[str, Any]:
        state = self._load()
        pending = state["pending"]
        if pending is not None:
            self._apply(pending["current"], pending["previous"])
            state.update(
                {
                    "sequence": int(state["sequence"]) + 1,
                    "generation": pending["generation"],
                    "current": pending["current"],
                    "previous": pending["previous"],
                    "fallbackAttempted": pending["fallbackAttempted"],
                    "pending": None,
                    "lastReason": pending["reason"],
                }
            )
            self._write({key: item for key, item in state.items() if key != "checksum"})
            state = self._load()
        self._assert_link("current", state["current"])
        self._assert_link("previous", state["previous"])
        return state

    def transition(
        self,
        *,
        current: str,
        previous: str | None,
        generation: int,
        fallback_attempted: bool,
        reason: str,
    ) -> dict[str, Any]:
        current = _safe_release_id(current)
        if previous is not None:
            previous = _safe_release_id(previous)
        if current == previous or not isinstance(reason, str) or not reason or len(reason) > 128:
            raise SlotValidationError("slot transition is invalid")
        state = self.reconcile()
        if generation < int(state["generation"]):
            raise SlotValidationError("slot generation cannot move backward")
        for identifier in (current, previous):
            if identifier is not None and not self.store.release_path(identifier).is_dir():
                raise SlotValidationError("slot transition target is unavailable")
        state["pending"] = {
            "current": current,
            "previous": previous,
            "generation": generation,
            "fallbackAttempted": fallback_attempted,
            "reason": reason,
        }
        self._write({key: item for key, item in state.items() if key != "checksum"})
        return self.reconcile()

    def activate(self, release_id: str) -> dict[str, Any]:
        identifier = _safe_release_id(release_id)
        self.store.validate(identifier)
        state = self.reconcile()
        if state["current"] == identifier:
            return state
        return self.transition(
            current=identifier,
            previous=state["current"],
            generation=int(state["generation"]) + 1,
            fallback_attempted=False,
            reason=f"{self.domain}_activate",
        )

    def fallback(self, reason: str) -> dict[str, Any]:
        state = self.reconcile()
        if state["fallbackAttempted"]:
            raise SlotBootstrapError("capsule fallback was already attempted")
        previous = state["previous"]
        current = state["current"]
        if previous is None or current is None:
            raise SlotBootstrapError("capsule has no previous release")
        self.store.validate(previous)
        return self.transition(
            current=previous,
            previous=current,
            generation=int(state["generation"]),
            fallback_attempted=True,
            reason=reason,
        )


@dataclass
class StartupAttempt:
    healthy: bool
    exit_code: int | None = None
    process: subprocess.Popen[bytes] | None = None


@dataclass
class CapsuleBootResult:
    release_id: str
    release_path: Path
    attempt: StartupAttempt
    fallback_used: bool


StartupLauncher = Callable[[Path, int], StartupAttempt]


class CapsuleSlots:
    def __init__(
        self,
        root: Path,
        state_directory: Path,
        *,
        startup_timeout_seconds: int,
        slot_policy: dict[str, Any] | None = None,
        command_runner: CommandRunner = _default_command_runner,
    ):
        self.store = ReleaseStore(
            root,
            domain="capsule",
            slot_policy=slot_policy,
            command_runner=command_runner,
        )
        self.state = SlotState(self.store, state_directory)
        if not isinstance(startup_timeout_seconds, int) or not 1 <= startup_timeout_seconds <= 600:
            raise SlotValidationError("capsule startup timeout is invalid")
        self.startup_timeout_seconds = startup_timeout_seconds

    def stage(self, source: Path, release_id: str, slot_policy: dict[str, Any]) -> dict[str, Any]:
        return self.store.stage(source, release_id, slot_policy=slot_policy)

    def activate(self, release_id: str) -> dict[str, Any]:
        return self.state.activate(release_id)

    def boot_with(self, launcher: StartupLauncher) -> CapsuleBootResult:
        state = self.state.reconcile()
        current = state["current"]
        if current is None:
            raise SlotBootstrapError("capsule has no active release")
        fallback_used = False
        try:
            self.store.validate(current)
        except SlotValidationError:
            state = self.state.fallback("capsule_validation_fallback")
            current = state["current"]
            fallback_used = True
        assert isinstance(current, str)
        attempt = launcher(self.store.release_path(current), self.startup_timeout_seconds)
        if not isinstance(attempt, StartupAttempt):
            raise SlotBootstrapError("capsule launcher returned an invalid result")
        if not attempt.healthy:
            if attempt.process is not None and attempt.process.poll() is None:
                _terminate_startup_process(attempt.process)
            state = self.state.fallback("capsule_startup_health_fallback")
            current = state["current"]
            assert isinstance(current, str)
            fallback_used = True
            attempt = launcher(self.store.release_path(current), self.startup_timeout_seconds)
            if not attempt.healthy:
                if attempt.process is not None and attempt.process.poll() is None:
                    _terminate_startup_process(attempt.process)
                raise SlotBootstrapError("capsule previous release failed startup health")
        return CapsuleBootResult(
            release_id=current,
            release_path=self.store.release_path(current),
            attempt=attempt,
            fallback_used=fallback_used,
        )


def _terminate_startup_process(process: subprocess.Popen[bytes]) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


RestartRunner = Callable[[list[str], int], subprocess.CompletedProcess[bytes]]


def _default_restart_runner(argv: list[str], timeout: int) -> subprocess.CompletedProcess[bytes]:
    process = subprocess.Popen(
        argv,
        cwd="/",
        env={"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C"},
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        shell=False,
        close_fds=True,
        start_new_session=True,
    )
    try:
        return subprocess.CompletedProcess(argv, process.wait(timeout=timeout), b"", b"")
    except subprocess.TimeoutExpired:
        _terminate_startup_process(process)
        raise


class ReviewedRestartRegistry:
    """Executes only a restart operation selected from closed recovery config."""

    def __init__(
        self,
        operations: Iterable[dict[str, Any]],
        *,
        runner: RestartRunner = _default_restart_runner,
    ):
        validated = [validated_reviewed_operation(dict(item)) for item in operations]
        self.operations = {str(item["id"]): item for item in validated}
        if len(self.operations) != len(validated):
            raise SlotValidationError("bot restart operation IDs overlap")
        self.runner = runner

    def require(self, operation_id: str) -> dict[str, Any]:
        operation = self.operations.get(operation_id)
        if operation is None or operation.get("kind") != "restart":
            raise SlotValidationError("bot restart operation is not reviewed")
        return operation

    def execute(self, operation_id: str) -> dict[str, Any]:
        operation = self.require(operation_id)
        argv = [str(operation["executable"]), *map(str, operation["argv"])]
        try:
            result = self.runner(argv, int(operation["timeoutSeconds"]))
        except subprocess.TimeoutExpired:
            return {"ok": False, "operationId": operation_id, "timedOut": True, "exitCode": None}
        except OSError:
            return {"ok": False, "operationId": operation_id, "timedOut": False, "exitCode": None}
        return {
            "ok": result.returncode == 0,
            "operationId": operation_id,
            "timedOut": False,
            "exitCode": int(result.returncode),
        }


class BotReleaseSlots:
    def __init__(
        self,
        root: Path,
        state_directory: Path,
        operations: Iterable[dict[str, Any]],
        *,
        restart_runner: RestartRunner = _default_restart_runner,
    ):
        self.store = ReleaseStore(root, domain="bot")
        self.state = SlotState(self.store, state_directory)
        self.restarts = ReviewedRestartRegistry(operations, runner=restart_runner)
        self.evidence_directory = _private_directory(Path(state_directory) / "bot-evidence")

    def stage(self, source: Path, release_id: str) -> dict[str, Any]:
        return self.store.stage(source, release_id)

    def activate(self, release_id: str) -> dict[str, Any]:
        return self.state.activate(release_id)

    def _record_evidence(self, evidence: dict[str, Any]) -> Path:
        state = self.state.reconcile()
        path = self.evidence_directory / f"{int(state['sequence']):08d}-{uuid.uuid4().hex}.json"
        _atomic_private_json(path, evidence)
        return path

    def rollback(self, restart_operation_id: str) -> dict[str, Any]:
        self.restarts.require(restart_operation_id)
        state = self.state.reconcile()
        former = state["current"]
        target = state["previous"]
        if former is None or target is None:
            raise SlotValidationError("bot rollback requires current and previous releases")
        self.store.validate(target)
        former_valid = True
        try:
            self.store.validate(former)
        except SlotValidationError:
            former_valid = False
        switched = self.state.transition(
            current=target,
            previous=former,
            generation=int(state["generation"]) + 1,
            fallback_attempted=False,
            reason="bot_offline_rollback",
        )
        restart = self.restarts.execute(restart_operation_id)
        restored = False
        restore_restart: dict[str, Any] | None = None
        if not restart["ok"] and former_valid:
            self.store.validate(former)
            self.state.transition(
                current=former,
                previous=target,
                generation=int(switched["generation"]) + 1,
                fallback_attempted=False,
                reason="bot_failed_restart_restore",
            )
            restored = True
            restore_restart = self.restarts.execute(restart_operation_id)
        evidence = {
            "schemaVersion": SLOT_SCHEMA_VERSION,
            "domain": "bot",
            "recordedAt": _utc_now(),
            "fromRelease": former,
            "toRelease": target,
            "targetManifestVerified": True,
            "formerManifestVerified": former_valid,
            "restart": restart,
            "restoredFormerSlot": restored,
            "restoreRestart": restore_restart,
            "outcome": "rolled_back" if restart["ok"] else "restart_failed",
        }
        evidence_path = self._record_evidence(evidence)
        return {
            "ok": bool(restart["ok"]),
            "outcome": evidence["outcome"],
            "currentRelease": self.state.reconcile()["current"],
            "restoredFormerSlot": restored,
            "restoreRestartOk": None if restore_restart is None else bool(restore_restart["ok"]),
            "evidenceFile": evidence_path.name,
        }


def _slot_policy(config: RecoveryConfig) -> dict[str, Any]:
    return dict(config.slot_policy)


def _capsule_slots(config: RecoveryConfig) -> CapsuleSlots:
    policy = _slot_policy(config)
    return CapsuleSlots(
        Path(str(policy["capsuleRoot"])),
        Path(str(policy["stateDirectory"])),
        startup_timeout_seconds=int(policy["startupHealthTimeoutSeconds"]),
        slot_policy=policy,
    )


def _bot_slots(config: RecoveryConfig) -> BotReleaseSlots:
    policy = _slot_policy(config)
    return BotReleaseSlots(
        Path(str(policy["botReleaseRoot"])),
        Path(str(policy["stateDirectory"])),
        config.reviewed_operations,
    )


def active_slot_release(config: RecoveryConfig, domain: str) -> dict[str, Any]:
    """Return one freshly manifest-validated active slot and exact link target."""

    if domain == "capsule":
        slots: CapsuleSlots | BotReleaseSlots = _capsule_slots(config)
    elif domain == "bot":
        slots = _bot_slots(config)
    else:
        raise SlotValidationError("slot domain is invalid")
    state = slots.state.reconcile()
    current = state["current"]
    if not isinstance(current, str):
        raise SlotValidationError("slot has no active release")
    manifest = slots.store.validate(current)
    link = slots.store.root / "current"
    expected = slots.store.release_path(current).resolve(strict=True)
    try:
        details = link.lstat()
        actual = link.resolve(strict=True)
    except OSError as exc:
        raise SlotValidationError("active slot link is unavailable") from exc
    if not stat.S_ISLNK(details.st_mode) or actual != expected:
        raise SlotValidationError("active slot link is invalid")
    return {
        "domain": domain,
        "releaseId": current,
        "packageVersion": str(manifest["packageVersion"]),
        "generation": int(state["generation"]),
    }


def _private_token(path: Path) -> str:
    descriptor = -1
    try:
        descriptor = os.open(
            path,
            os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
        )
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or not _same_owner(details)
            or stat.S_IMODE(details.st_mode) & 0o077
            or not 16 <= details.st_size <= 4096
        ):
            raise SlotValidationError("capsule health credential is unsafe")
        raw = os.read(descriptor, 4097)
        if len(raw) != details.st_size:
            raise SlotValidationError("capsule health credential changed while reading")
        token = raw.decode("ascii").strip()
    except (OSError, UnicodeError) as exc:
        raise SlotValidationError("capsule health credential is unavailable") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if (
        not 16 <= len(token.encode("ascii")) <= 4096
        or any(character.isspace() for character in token)
    ):
        raise SlotValidationError("capsule health credential is invalid")
    return token


def _capsule_launcher(
    workspace: Path, config_path: Path, configured: RecoveryConfig
) -> StartupLauncher:
    token = _private_token(configured.auth_token_file)

    def launch(release: Path, timeout: int) -> StartupAttempt:
        manifest = _read_json(release / MANIFEST_NAME, private=False)
        node_parent = str(Path(manifest["prerequisites"]["node"]["path"]).parent)
        pi_parent = str(Path(manifest["prerequisites"]["pi"]["path"]).parent)
        environment = dict(os.environ)
        environment["PATH"] = os.pathsep.join((node_parent, pi_parent, "/usr/bin", "/bin"))
        environment["MINIME_CONTROL_WORKSPACE_ROOT"] = str(workspace)
        process = subprocess.Popen(
            [
                sys.executable,
                str(release / "scripts/recovery_supervisor.py"),
                "--workspace",
                str(workspace),
                "--config",
                str(config_path),
            ],
            cwd=str(release),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            shell=False,
            start_new_session=True,
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            code = process.poll()
            if code is not None:
                return StartupAttempt(False, int(code), process)
            connection = http.client.HTTPConnection(configured.host, configured.port, timeout=0.5)
            try:
                connection.request(
                    "GET", "/healthz", headers={"Authorization": f"Bearer {token}"}
                )
                response = connection.getresponse()
                response.read(4096)
                if response.status == 200:
                    return StartupAttempt(True, None, process)
            except (OSError, http.client.HTTPException):
                pass
            finally:
                connection.close()
            time.sleep(0.1)
        return StartupAttempt(False, None, process)

    return launch


def _wait_for_capsule(process: subprocess.Popen[bytes]) -> int:
    previous: dict[int, Any] = {}

    def forward(signum: int, _frame: Any) -> None:
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass

    for signum in (signal.SIGTERM, signal.SIGINT):
        previous[signum] = signal.getsignal(signum)
        signal.signal(signum, forward)
    try:
        return int(process.wait())
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage offline recovery and bot release slots")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--config", default="recovery.json")
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("capsule-stage", "bot-stage"):
        item = commands.add_parser(command)
        item.add_argument("--source", required=True)
        item.add_argument("--release-id", required=True)
    for command in ("capsule-activate", "bot-activate"):
        item = commands.add_parser(command)
        item.add_argument("--release-id", required=True)
    commands.add_parser("capsule-bootstrap")
    rollback = commands.add_parser("bot-rollback")
    rollback.add_argument("--restart-operation-id", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    workspace = Path(args.workspace).resolve()
    config_path = Path(args.config)
    if not config_path.is_absolute():
        config_path = workspace / config_path
    try:
        configured = load_recovery_config(config_path, workspace)
        if args.command == "capsule-stage":
            manifest = _capsule_slots(configured).stage(
                Path(args.source), args.release_id, _slot_policy(configured)
            )
            result = {"ok": True, "domain": "capsule", "releaseId": manifest["releaseId"]}
        elif args.command == "capsule-activate":
            state = _capsule_slots(configured).activate(args.release_id)
            result = {"ok": True, "domain": "capsule", "currentRelease": state["current"]}
        elif args.command == "bot-stage":
            manifest = _bot_slots(configured).stage(Path(args.source), args.release_id)
            result = {"ok": True, "domain": "bot", "releaseId": manifest["releaseId"]}
        elif args.command == "bot-activate":
            state = _bot_slots(configured).activate(args.release_id)
            result = {"ok": True, "domain": "bot", "currentRelease": state["current"]}
        elif args.command == "bot-rollback":
            result = _bot_slots(configured).rollback(args.restart_operation_id)
        else:
            capsules = _capsule_slots(configured)
            state = capsules.state.reconcile()
            current = state["current"]
            if current is None:
                raise SlotBootstrapError("capsule has no active release")
            boot = capsules.boot_with(
                _capsule_launcher(workspace, config_path, configured)
            )
            if boot.attempt.process is None:
                raise SlotBootstrapError("capsule launcher did not return a process")
            return _wait_for_capsule(boot.attempt.process)
        print(_canonical_json(result))
        return 0 if result.get("ok", False) else 1
    except (RecoveryConfigError, RecoverySlotError, OSError, ValueError, KeyError, TypeError):
        print("recovery slot operation failed", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
