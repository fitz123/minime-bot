#!/usr/bin/env python3
"""Manage manifest-verified, atomically selected bot release slots."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import sys
from typing import Any, Iterator


SCHEMA_VERSION = 1
MANIFEST_NAME = ".slot-manifest.json"
STATE_NAME = "active.json"
TRANSITION_NAME = "transition.json"
EXIT_OPERATION_FAILED = 1
EXIT_USAGE = 2
EXIT_VERIFICATION_FAILED = 3

_MAX_FILE_COUNT = 200_000
_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024
_MAX_MANIFEST_BYTES = 16 * 1024 * 1024
_SAFE_RELEASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")


class BotSlotError(RuntimeError):
    """A bot slot operation failed."""


class UsageError(BotSlotError):
    """Command input is invalid."""


class VerificationError(BotSlotError):
    """Filesystem state or release contents failed verification."""


def _canonical_json(value: Any) -> bytes:
    text = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return (text + "\n").encode("ascii")


def _utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


def _same_owner(details: os.stat_result) -> bool:
    return not hasattr(os, "getuid") or details.st_uid == os.getuid()


def _safe_id(value: Any, *, usage: bool = False) -> str:
    if not isinstance(value, str) or _SAFE_RELEASE_ID.fullmatch(value) is None:
        raise (UsageError if usage else VerificationError)("release ID is invalid")
    return value


def _fsync_dir(path: Path) -> None:
    descriptor = os.open(
        path,
        os.O_RDONLY
        | os.O_CLOEXEC
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _private_dir(path: Path, *, create: bool) -> Path:
    try:
        details = path.lstat()
    except FileNotFoundError:
        if not create:
            raise VerificationError("slot storage is unavailable")
        try:
            path.mkdir(parents=True, mode=0o700, exist_ok=False)
            path.chmod(0o700)
            details = path.lstat()
        except OSError as exc:
            raise VerificationError("slot storage is unavailable") from exc
    except OSError as exc:
        raise VerificationError("slot storage is unavailable") from exc
    if (
        not stat.S_ISDIR(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or not _same_owner(details)
        or stat.S_IMODE(details.st_mode) != 0o700
    ):
        raise VerificationError("slot storage is not owner-only")
    return path


def _layout(root: Path, *, create: bool) -> tuple[Path, Path, Path]:
    root = _private_dir(root, create=create)
    return (
        root,
        _private_dir(root / "releases", create=create),
        _private_dir(root / "state", create=create),
    )


@contextmanager
def _lock(state_dir: Path) -> Iterator[None]:
    descriptor = -1
    try:
        descriptor = os.open(
            state_dir / ".bot-slots.lock",
            os.O_RDWR
            | os.O_CREAT
            | os.O_CLOEXEC
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or not _same_owner(details)
            or stat.S_IMODE(details.st_mode) != 0o600
        ):
            raise VerificationError("slot lock is unsafe")
        fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    except VerificationError:
        raise
    except OSError as exc:
        raise VerificationError("slot lock is unavailable") from exc
    finally:
        if descriptor >= 0:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)


def _safe_mode(details: os.stat_result, *, source: bool, directory: bool) -> None:
    if not _same_owner(details):
        raise VerificationError("runtime tree owner is unsafe")
    mode = stat.S_IMODE(details.st_mode)
    if source:
        required = stat.S_IRUSR | (stat.S_IXUSR if directory else 0)
        if mode & 0o022 or details.st_mode & (stat.S_ISUID | stat.S_ISGID | stat.S_ISVTX):
            raise VerificationError("runtime source mode is unsafe")
        if mode & required != required:
            raise VerificationError("runtime source mode is unsafe")
    elif mode != (0o700 if directory else mode) or (
        not directory and mode not in {0o600, 0o700}
    ):
        raise VerificationError("release mode is unsafe")


def _hash_file(
    path: Path, expected: os.stat_result, *, source: bool
) -> tuple[str, int, bool]:
    descriptor = -1
    try:
        descriptor = os.open(
            path, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        )
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISREG(opened.st_mode)
            or (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                stat.S_IMODE(opened.st_mode),
            )
            != (
                expected.st_dev,
                expected.st_ino,
                expected.st_size,
                stat.S_IMODE(expected.st_mode),
            )
        ):
            raise VerificationError("runtime tree changed during verification")
        _safe_mode(opened, source=source, directory=False)
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > _MAX_TOTAL_BYTES:
                raise VerificationError("runtime tree exceeds the byte bound")
            digest.update(chunk)
        final = os.fstat(descriptor)
        if (
            size != expected.st_size
            or (
                final.st_dev,
                final.st_ino,
                final.st_size,
                final.st_mtime_ns,
                stat.S_IMODE(final.st_mode),
            )
            != (
                expected.st_dev,
                expected.st_ino,
                expected.st_size,
                expected.st_mtime_ns,
                stat.S_IMODE(expected.st_mode),
            )
        ):
            raise VerificationError("runtime tree changed during verification")
        return digest.hexdigest(), size, bool(opened.st_mode & stat.S_IXUSR)
    except VerificationError:
        raise
    except OSError as exc:
        raise VerificationError("runtime file is unreadable") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _inventory(root: Path, *, source: bool) -> dict[str, Any]:
    files: dict[str, str] = {}
    directories: list[str] = []
    executable_files: list[str] = []
    total = 0
    try:
        root_details = root.lstat()
        if not stat.S_ISDIR(root_details.st_mode) or stat.S_ISLNK(root_details.st_mode):
            raise VerificationError("runtime tree root is unsafe")
        _safe_mode(root_details, source=source, directory=True)
        for directory, child_dirs, child_files in os.walk(
            root, topdown=True, followlinks=False
        ):
            current = Path(directory)
            details = current.lstat()
            if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(details.st_mode):
                raise VerificationError("runtime tree contains a symlink")
            _safe_mode(details, source=source, directory=True)
            child_dirs.sort()
            child_files.sort()
            for name in child_dirs:
                path = current / name
                child = path.lstat()
                if not stat.S_ISDIR(child.st_mode) or stat.S_ISLNK(child.st_mode):
                    raise VerificationError("runtime tree contains a symlink or special file")
                _safe_mode(child, source=source, directory=True)
                directories.append(path.relative_to(root).as_posix())
            for name in child_files:
                path = current / name
                relative = path.relative_to(root).as_posix()
                child = path.lstat()
                if not stat.S_ISREG(child.st_mode) or stat.S_ISLNK(child.st_mode):
                    raise VerificationError("runtime tree contains a symlink or special file")
                if relative == MANIFEST_NAME:
                    if source:
                        raise VerificationError("runtime source uses a reserved path")
                    _safe_mode(child, source=False, directory=False)
                    continue
                if len(files) >= _MAX_FILE_COUNT:
                    raise VerificationError("runtime tree exceeds the file bound")
                digest, size, executable = _hash_file(path, child, source=source)
                total += size
                if total > _MAX_TOTAL_BYTES:
                    raise VerificationError("runtime tree exceeds the byte bound")
                files[relative] = digest
                if executable:
                    executable_files.append(relative)
    except VerificationError:
        raise
    except OSError as exc:
        raise VerificationError("runtime tree is unreadable") from exc
    return {
        "directories": sorted(directories),
        "executableFiles": sorted(executable_files),
        "files": dict(sorted(files.items())),
        "fileCount": len(files),
        "totalBytes": total,
    }


def _copy_file(source: str, destination: str) -> str:
    source_path = Path(source)
    destination_path = Path(destination)
    source_descriptor = -1
    destination_descriptor = -1
    try:
        expected = source_path.lstat()
        if not stat.S_ISREG(expected.st_mode) or stat.S_ISLNK(expected.st_mode):
            raise VerificationError("runtime source contains a symlink or special file")
        _safe_mode(expected, source=True, directory=False)
        source_descriptor = os.open(
            source_path,
            os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0),
        )
        destination_descriptor = os.open(
            destination_path,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_CLOEXEC
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
    except VerificationError:
        if source_descriptor >= 0:
            os.close(source_descriptor)
        if destination_descriptor >= 0:
            os.close(destination_descriptor)
        raise
    except OSError as exc:
        if source_descriptor >= 0:
            os.close(source_descriptor)
        if destination_descriptor >= 0:
            os.close(destination_descriptor)
        raise VerificationError("runtime source cannot be copied safely") from exc
    try:
        opened = os.fstat(source_descriptor)
        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino):
            raise VerificationError("runtime source changed while staging")
        copied = 0
        while True:
            chunk = os.read(source_descriptor, 1024 * 1024)
            if not chunk:
                break
            copied += len(chunk)
            if copied > expected.st_size or copied > _MAX_TOTAL_BYTES:
                raise VerificationError("runtime source exceeds the byte bound")
            offset = 0
            while offset < len(chunk):
                count = os.write(destination_descriptor, chunk[offset:])
                if count <= 0:
                    raise OSError("short release file write")
                offset += count
        final = os.fstat(source_descriptor)
        if (
            copied != expected.st_size
            or (final.st_size, final.st_mtime_ns) != (
                expected.st_size,
                expected.st_mtime_ns,
            )
        ):
            raise VerificationError("runtime source changed while staging")
        os.fchmod(destination_descriptor, 0o700 if expected.st_mode & stat.S_IXUSR else 0o600)
        os.fsync(destination_descriptor)
        return destination
    except OSError as exc:
        raise VerificationError("runtime source cannot be copied safely") from exc
    finally:
        if source_descriptor >= 0:
            os.close(source_descriptor)
        if destination_descriptor >= 0:
            os.close(destination_descriptor)


def _normalize_dirs(root: Path) -> None:
    for directory, child_dirs, _files in os.walk(root, topdown=False, followlinks=False):
        current = Path(directory)
        for name in child_dirs:
            path = current / name
            if path.is_symlink():
                raise VerificationError("runtime source contains a symlink")
            path.chmod(0o700)
        current.chmod(0o700)


def _read_json(path: Path, *, max_bytes: int) -> dict[str, Any]:
    descriptor = -1
    try:
        descriptor = os.open(
            path, os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
        )
        details = os.fstat(descriptor)
        if (
            not stat.S_ISREG(details.st_mode)
            or not _same_owner(details)
            or stat.S_IMODE(details.st_mode) != 0o600
            or details.st_size > max_bytes
        ):
            raise VerificationError("slot JSON metadata is unsafe")
        raw = os.read(descriptor, max_bytes + 1)
        if len(raw) != details.st_size or len(raw) > max_bytes:
            raise VerificationError("slot JSON metadata exceeds its byte bound")
        value = json.loads(raw.decode("ascii"))
    except VerificationError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError("slot JSON metadata is unreadable") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not isinstance(value, dict):
        raise VerificationError("slot JSON metadata is invalid")
    return value


def _write_new(path: Path, encoded: bytes) -> None:
    descriptor = -1
    try:
        descriptor = os.open(
            path,
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | os.O_CLOEXEC
            | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        offset = 0
        while offset < len(encoded):
            count = os.write(descriptor, encoded[offset:])
            if count <= 0:
                raise OSError("short metadata write")
            offset += count
        os.fchmod(descriptor, 0o600)
        os.fsync(descriptor)
    except OSError as exc:
        raise VerificationError("slot JSON metadata cannot be written") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)


def _valid_relative_path(value: Any) -> str:
    if not isinstance(value, str) or not value or "\0" in value:
        raise VerificationError("release manifest path is invalid")
    parsed = PurePosixPath(value)
    if (
        parsed.is_absolute()
        or parsed.as_posix() != value
        or any(part in {"", ".", ".."} for part in parsed.parts)
        or value == MANIFEST_NAME
    ):
        raise VerificationError("release manifest path is invalid")
    return value


def _verify_release_path(path: Path, release_id: str) -> dict[str, Any]:
    identifier = _safe_id(release_id)
    manifest = _read_json(path / MANIFEST_NAME, max_bytes=_MAX_MANIFEST_BYTES)
    files = manifest.get("files")
    directories = manifest.get("directories")
    executable_files = manifest.get("executableFiles")
    if (
        set(manifest)
        != {
            "schemaVersion",
            "releaseId",
            "createdAt",
            "directories",
            "executableFiles",
            "files",
            "fileCount",
            "totalBytes",
        }
        or manifest.get("schemaVersion") != SCHEMA_VERSION
        or manifest.get("releaseId") != identifier
        or not isinstance(manifest.get("createdAt"), str)
        or not isinstance(files, dict)
        or not isinstance(directories, list)
        or not isinstance(executable_files, list)
        or isinstance(manifest.get("fileCount"), bool)
        or not isinstance(manifest.get("fileCount"), int)
        or isinstance(manifest.get("totalBytes"), bool)
        or not isinstance(manifest.get("totalBytes"), int)
        or list(files) != sorted(files)
        or directories != sorted(set(directories))
        or executable_files != sorted(set(executable_files))
    ):
        raise VerificationError("release manifest is invalid")
    for relative, digest in files.items():
        _valid_relative_path(relative)
        if not isinstance(digest, str) or _SHA256.fullmatch(digest) is None:
            raise VerificationError("release manifest digest is invalid")
    for relative in directories:
        _valid_relative_path(relative)
    for relative in executable_files:
        _valid_relative_path(relative)
        if relative not in files:
            raise VerificationError("release manifest executable path is invalid")
    expected = {
        "directories": directories,
        "executableFiles": executable_files,
        "files": files,
        "fileCount": manifest["fileCount"],
        "totalBytes": manifest["totalBytes"],
    }
    if (
        manifest["fileCount"] != len(files)
        or not 0 <= manifest["fileCount"] <= _MAX_FILE_COUNT
        or not 0 <= manifest["totalBytes"] <= _MAX_TOTAL_BYTES
        or _inventory(path, source=False) != expected
    ):
        raise VerificationError("release contents do not match the manifest")
    return manifest


def _verify_release(releases: Path, release_id: str) -> dict[str, Any]:
    identifier = _safe_id(release_id)
    return _verify_release_path(releases / identifier, identifier)


def _atomic_private_json(path: Path, value: dict[str, Any]) -> None:
    encoded = _canonical_json(value)
    if len(encoded) > _MAX_MANIFEST_BYTES:
        raise VerificationError("slot JSON metadata exceeds its byte bound")
    temporary = path.parent / f".{path.name}.tmp.{os.getpid()}"
    _write_new(temporary, encoded)
    try:
        os.replace(temporary, path)
        _fsync_dir(path.parent)
    except OSError as exc:
        raise VerificationError("slot JSON metadata cannot be replaced") from exc
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _state(state_dir: Path) -> dict[str, Any] | None:
    path = state_dir / STATE_NAME
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    value = _read_json(path, max_bytes=_MAX_MANIFEST_BYTES)
    if set(value) != {"releaseId", "previousReleaseId", "activatedAt"}:
        raise VerificationError("slot activation state is invalid")
    for key in ("releaseId", "previousReleaseId"):
        if value[key] is not None:
            _safe_id(value[key])
    if not isinstance(value["activatedAt"], str):
        raise VerificationError("slot activation state is invalid")
    return value


def _transition(state_dir: Path) -> dict[str, Any] | None:
    path = state_dir / TRANSITION_NAME
    try:
        path.lstat()
    except FileNotFoundError:
        return None
    value = _read_json(path, max_bytes=_MAX_MANIFEST_BYTES)
    if set(value) != {
        "fromCurrentReleaseId",
        "fromPreviousReleaseId",
        "toCurrentReleaseId",
        "toPreviousReleaseId",
        "startedAt",
    }:
        raise VerificationError("slot transition state is invalid")
    for key in (
        "fromCurrentReleaseId",
        "fromPreviousReleaseId",
        "toCurrentReleaseId",
        "toPreviousReleaseId",
    ):
        if value[key] is not None:
            _safe_id(value[key])
    if not isinstance(value["startedAt"], str):
        raise VerificationError("slot transition state is invalid")
    return value


def _selector(root: Path, name: str) -> str | None:
    path = root / name
    try:
        details = path.lstat()
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise VerificationError("slot selector is unavailable") from exc
    if not stat.S_ISLNK(details.st_mode) or not _same_owner(details):
        raise VerificationError("slot selector is unsafe")
    try:
        target = os.readlink(path)
    except OSError as exc:
        raise VerificationError("slot selector is unreadable") from exc
    if not target.startswith("releases/") or "/" in target[len("releases/") :]:
        raise VerificationError("slot selector target is unsafe")
    identifier = _safe_id(target[len("releases/") :])
    release = root / target
    try:
        release_details = release.lstat()
    except OSError as exc:
        raise VerificationError("slot selector target is unavailable") from exc
    if (
        not stat.S_ISDIR(release_details.st_mode)
        or stat.S_ISLNK(release_details.st_mode)
        or not _same_owner(release_details)
        or stat.S_IMODE(release_details.st_mode) != 0o700
    ):
        raise VerificationError("slot selector target is unsafe")
    return identifier


def _replace_selector(root: Path, name: str, release_id: str) -> None:
    identifier = _safe_id(release_id)
    temporary = root / f".{name}.tmp.{os.getpid()}"
    try:
        os.symlink(f"releases/{identifier}", temporary)
        os.replace(temporary, root / name)
        _fsync_dir(root)
    except OSError as exc:
        raise VerificationError("slot selector cannot be replaced") from exc
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _remove_private_file(path: Path) -> None:
    try:
        details = path.lstat()
    except FileNotFoundError:
        return
    if (
        not stat.S_ISREG(details.st_mode)
        or stat.S_ISLNK(details.st_mode)
        or not _same_owner(details)
        or stat.S_IMODE(details.st_mode) != 0o600
    ):
        raise VerificationError("slot metadata file is unsafe")
    try:
        path.unlink()
        _fsync_dir(path.parent)
    except OSError as exc:
        raise VerificationError("slot metadata file cannot be removed") from exc


def _set_selector(root: Path, name: str, release_id: str | None) -> None:
    if release_id is not None:
        _replace_selector(root, name, release_id)
        return
    path = root / name
    try:
        details = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISLNK(details.st_mode) or not _same_owner(details):
        raise VerificationError("slot selector is unsafe")
    try:
        path.unlink()
        _fsync_dir(root)
    except OSError as exc:
        raise VerificationError("slot selector cannot be removed") from exc


def _begin_transition(
    state_dir: Path,
    *,
    current: str | None,
    previous: str | None,
    target_current: str,
    target_previous: str | None,
) -> None:
    if _transition(state_dir) is not None:
        raise VerificationError("slot transition is already active")
    _atomic_private_json(
        state_dir / TRANSITION_NAME,
        {
            "fromCurrentReleaseId": current,
            "fromPreviousReleaseId": previous,
            "toCurrentReleaseId": target_current,
            "toPreviousReleaseId": target_previous,
            "startedAt": _utc_now(),
        },
    )


def _finish_transition(
    state_dir: Path, *, current: str, previous: str | None
) -> None:
    _atomic_private_json(
        state_dir / STATE_NAME,
        {
            "releaseId": current,
            "previousReleaseId": previous,
            "activatedAt": _utc_now(),
        },
    )
    _remove_private_file(state_dir / TRANSITION_NAME)


def _reconcile_transition(root: Path, state_dir: Path) -> None:
    pending = _transition(state_dir)
    if pending is None:
        return
    active = _state(state_dir)
    committed = (
        active is not None
        and active["releaseId"] == pending["toCurrentReleaseId"]
        and active["previousReleaseId"] == pending["toPreviousReleaseId"]
    )
    current = pending[
        "toCurrentReleaseId" if committed else "fromCurrentReleaseId"
    ]
    previous = pending[
        "toPreviousReleaseId" if committed else "fromPreviousReleaseId"
    ]
    _set_selector(root, "previous", previous)
    _set_selector(root, "current", current)
    if current is None:
        _remove_private_file(state_dir / STATE_NAME)
    else:
        _atomic_private_json(
            state_dir / STATE_NAME,
            {
                "releaseId": current,
                "previousReleaseId": previous,
                "activatedAt": _utc_now(),
            },
        )
    _remove_private_file(state_dir / TRANSITION_NAME)


def stage(slots_root: Path, source: Path, release_id: str) -> dict[str, Any]:
    identifier = _safe_id(release_id, usage=True)
    try:
        source_details = source.lstat()
        source_resolved = source.resolve(strict=True)
        root_resolved = slots_root.resolve(strict=False)
    except OSError as exc:
        raise VerificationError("runtime source is unavailable") from exc
    if not stat.S_ISDIR(source_details.st_mode) or stat.S_ISLNK(source_details.st_mode):
        raise VerificationError("runtime source is not a real directory")
    _safe_mode(source_details, source=True, directory=True)
    if (
        source_resolved == root_resolved
        or source_resolved in root_resolved.parents
        or root_resolved in source_resolved.parents
    ):
        raise VerificationError("runtime source and slot storage overlap")

    _root, releases, state_dir = _layout(slots_root, create=True)
    with _lock(state_dir):
        destination = releases / identifier
        try:
            destination.lstat()
        except FileNotFoundError:
            pass
        else:
            _verify_release(releases, identifier)
            return {"ok": True, "releaseId": identifier, "idempotent": True}

        temporary = releases / f"{identifier}.tmp.{os.getpid()}"
        published = False
        try:
            before = _inventory(source, source=True)
            temporary.mkdir(mode=0o700)
            shutil.copytree(
                source,
                temporary,
                symlinks=True,
                dirs_exist_ok=True,
                copy_function=_copy_file,
            )
            _normalize_dirs(temporary)
            if _inventory(source, source=True) != before:
                raise VerificationError("runtime source changed while staging")
            copied = _inventory(temporary, source=False)
            if copied != before:
                raise VerificationError("staged release differs from its source")
            manifest = {
                "schemaVersion": SCHEMA_VERSION,
                "releaseId": identifier,
                "createdAt": _utc_now(),
                **copied,
            }
            encoded = _canonical_json(manifest)
            if len(encoded) > _MAX_MANIFEST_BYTES:
                raise VerificationError("release manifest exceeds the JSON byte bound")
            _write_new(temporary / MANIFEST_NAME, encoded)
            _fsync_dir(temporary)
            _verify_release_path(temporary, identifier)
            os.replace(temporary, destination)
            published = True
            _fsync_dir(releases)
            _verify_release(releases, identifier)
            return {"ok": True, "releaseId": identifier, "idempotent": False}
        except (OSError, shutil.Error) as exc:
            raise VerificationError("release cannot be staged safely") from exc
        finally:
            if not published and temporary.exists() and not temporary.is_symlink():
                shutil.rmtree(temporary)


def activate(slots_root: Path, release_id: str) -> dict[str, Any]:
    identifier = _safe_id(release_id, usage=True)
    root, releases, state_dir = _layout(slots_root, create=False)
    with _lock(state_dir):
        _reconcile_transition(root, state_dir)
        _verify_release(releases, identifier)
        current = _selector(root, "current")
        previous = _selector(root, "previous")
        if current == identifier:
            active = _state(state_dir)
            if (
                active is None
                or active["releaseId"] != current
                or active["previousReleaseId"] != previous
            ):
                _atomic_private_json(
                    state_dir / STATE_NAME,
                    {
                        "releaseId": current,
                        "previousReleaseId": previous,
                        "activatedAt": _utc_now(),
                    },
                )
            return {
                "ok": True,
                "releaseId": current,
                "previousReleaseId": previous,
                "idempotent": True,
            }
        if current is None and previous is not None:
            raise VerificationError("slot selectors are inconsistent")
        if current is not None:
            _verify_release(releases, current)
        _begin_transition(
            state_dir,
            current=current,
            previous=previous,
            target_current=identifier,
            target_previous=current,
        )
        if current is not None:
            _replace_selector(root, "previous", current)
        _replace_selector(root, "current", identifier)
        _finish_transition(
            state_dir,
            current=identifier,
            previous=current,
        )
        return {
            "ok": True,
            "releaseId": identifier,
            "previousReleaseId": current,
            "idempotent": False,
        }


def rollback(slots_root: Path) -> dict[str, Any]:
    root, releases, state_dir = _layout(slots_root, create=False)
    with _lock(state_dir):
        _reconcile_transition(root, state_dir)
        current = _selector(root, "current")
        previous = _selector(root, "previous")
        if current is None or previous is None:
            raise VerificationError("rollback requires current and previous releases")
        _verify_release(releases, previous)
        _begin_transition(
            state_dir,
            current=current,
            previous=previous,
            target_current=previous,
            target_previous=current,
        )
        _replace_selector(root, "previous", current)
        _replace_selector(root, "current", previous)
        _finish_transition(
            state_dir,
            current=previous,
            previous=current,
        )
        return {
            "ok": True,
            "releaseId": previous,
            "previousReleaseId": current,
        }


def prune(slots_root: Path) -> dict[str, Any]:
    root, releases, state_dir = _layout(slots_root, create=False)
    with _lock(state_dir):
        _reconcile_transition(root, state_dir)
        referenced = {
            value
            for value in (_selector(root, "current"), _selector(root, "previous"))
            if value is not None
        }
        active = _state(state_dir)
        if active is not None:
            referenced.update(
                value
                for value in (active["releaseId"], active["previousReleaseId"])
                if value is not None
            )
        removed: list[str] = []
        removed_temporary: list[str] = []
        for entry in sorted(os.scandir(releases), key=lambda item: item.name):
            if re.fullmatch(r".+\.tmp\.[0-9]+", entry.name):
                temporary = Path(entry.path)
                details = temporary.lstat()
                if (
                    not stat.S_ISDIR(details.st_mode)
                    or stat.S_ISLNK(details.st_mode)
                    or not _same_owner(details)
                    or stat.S_IMODE(details.st_mode) != 0o700
                ):
                    raise VerificationError("abandoned staging directory is unsafe")
                shutil.rmtree(temporary)
                removed_temporary.append(entry.name)
                continue
            identifier = _safe_id(entry.name)
            if identifier in referenced:
                continue
            release = Path(entry.path)
            _inventory(release, source=False)
            shutil.rmtree(release)
            removed.append(identifier)
        _fsync_dir(releases)
        return {
            "ok": True,
            "removedReleaseIds": removed,
            "removedTemporaryDirectories": removed_temporary,
        }


def status(slots_root: Path) -> tuple[dict[str, Any], bool]:
    root, releases, state_dir = _layout(slots_root, create=False)
    with _lock(state_dir):
        _reconcile_transition(root, state_dir)
        current = _selector(root, "current")
        previous = _selector(root, "previous")
        _state(state_dir)

        def verified(identifier: str | None) -> bool | None:
            if identifier is None:
                return None
            try:
                _verify_release(releases, identifier)
            except VerificationError:
                return False
            return True

        current_ok = verified(current)
        previous_ok = verified(previous)
        return (
            {
                "currentReleaseId": current,
                "previousReleaseId": previous,
                "currentManifestVerified": current_ok,
                "previousManifestVerified": previous_ok,
            },
            current_ok is not False and previous_ok is not False,
        )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Manage manifest-verified bot release slots"
    )
    commands = parser.add_subparsers(dest="command", required=True)
    item = commands.add_parser("stage")
    item.add_argument("--slots-root", required=True)
    item.add_argument("--source", required=True)
    item.add_argument("--release-id", required=True)
    item = commands.add_parser("activate")
    item.add_argument("--slots-root", required=True)
    item.add_argument("--release-id", required=True)
    for name in ("rollback", "prune"):
        commands.add_parser(name).add_argument("--slots-root", required=True)
    item = commands.add_parser("status")
    item.add_argument("--slots-root", required=True)
    item.add_argument("--json", action="store_true", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        root = Path(args.slots_root)
        if args.command == "stage":
            result, success = stage(root, Path(args.source), args.release_id), True
        elif args.command == "activate":
            result, success = activate(root, args.release_id), True
        elif args.command == "rollback":
            result, success = rollback(root), True
        elif args.command == "prune":
            result, success = prune(root), True
        else:
            result, success = status(root)
        print(_canonical_json(result).decode("ascii"), end="")
        return 0 if success else EXIT_VERIFICATION_FAILED
    except UsageError as exc:
        print(f"bot slot usage error: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except VerificationError as exc:
        print(f"bot slot verification failed: {exc}", file=sys.stderr)
        return EXIT_VERIFICATION_FAILED
    except (BotSlotError, OSError, ValueError, TypeError):
        print("bot slot operation failed", file=sys.stderr)
        return EXIT_OPERATION_FAILED


if __name__ == "__main__":
    raise SystemExit(main())
