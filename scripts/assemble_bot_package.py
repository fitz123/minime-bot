#!/usr/bin/env python3
"""Assemble one self-contained installed minime-bot dependency closure."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat


SAFE_PACKAGE_NAME = re.compile(r"^(?:@[A-Za-z0-9._-]+/)?[A-Za-z0-9._-]+$")


class AssemblyError(RuntimeError):
    """The installed package closure cannot be assembled safely."""


def _manifest(path: Path) -> dict[str, object]:
    try:
        details = path.lstat()
        if (
            not stat.S_ISREG(details.st_mode)
            or stat.S_ISLNK(details.st_mode)
            or details.st_size > 1024 * 1024
            or details.st_mode & 0o022
        ):
            raise AssemblyError("package manifest is unsafe")
        value = json.loads(path.read_text("utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise AssemblyError("package manifest is unreadable") from exc
    if not isinstance(value, dict):
        raise AssemblyError("package manifest is invalid")
    return value


def _dependency_entries(value: dict[str, object]) -> list[tuple[str, bool]]:
    result: dict[str, bool] = {}
    for field, required in (
        ("dependencies", True),
        ("optionalDependencies", False),
    ):
        dependencies = value.get(field, {})
        if not isinstance(dependencies, dict):
            raise AssemblyError("package dependencies are invalid")
        for name, requested in dependencies.items():
            if (
                not isinstance(name, str)
                or SAFE_PACKAGE_NAME.fullmatch(name) is None
                or not isinstance(requested, str)
                or not requested
                or len(requested) > 256
            ):
                raise AssemblyError("package dependency entry is invalid")
            result[name] = required

    peers = value.get("peerDependencies", {})
    peer_meta = value.get("peerDependenciesMeta", {})
    if not isinstance(peers, dict) or not isinstance(peer_meta, dict):
        raise AssemblyError("package peer dependencies are invalid")
    for name, requested in peers.items():
        if (
            not isinstance(name, str)
            or SAFE_PACKAGE_NAME.fullmatch(name) is None
            or not isinstance(requested, str)
            or not requested
            or len(requested) > 256
        ):
            raise AssemblyError("package peer dependency entry is invalid")
        metadata = peer_meta.get(name, {})
        if not isinstance(metadata, dict):
            raise AssemblyError("package peer dependency metadata is invalid")
        if name not in result:
            result[name] = metadata.get("optional") is not True
    return sorted(result.items())


def _validate_tree(root: Path, *, omit_modules: bool) -> None:
    for directory, child_dirs, child_files in os.walk(
        root, topdown=True, followlinks=False
    ):
        current = Path(directory)
        details = current.lstat()
        if (
            not stat.S_ISDIR(details.st_mode)
            or stat.S_ISLNK(details.st_mode)
            or details.st_mode & 0o022
        ):
            raise AssemblyError("package tree contains an unsafe directory")
        if omit_modules and "node_modules" in child_dirs:
            child_dirs.remove("node_modules")
        if ".bin" in child_dirs:
            child_dirs.remove(".bin")
        child_dirs.sort()
        child_files.sort()
        for name in child_dirs:
            child = (current / name).lstat()
            if not stat.S_ISDIR(child.st_mode) or stat.S_ISLNK(child.st_mode):
                raise AssemblyError("package tree contains a symlink or special file")
        for name in child_files:
            child = (current / name).lstat()
            if (
                not stat.S_ISREG(child.st_mode)
                or stat.S_ISLNK(child.st_mode)
                or child.st_mode & 0o022
            ):
                raise AssemblyError("package tree contains a symlink or unsafe file")


def _copy_tree(source: Path, target: Path, *, omit_modules: bool) -> None:
    _validate_tree(source, omit_modules=omit_modules)

    def ignored(_directory: str, names: list[str]) -> set[str]:
        result = {".bin"} if ".bin" in names else set()
        if omit_modules and "node_modules" in names:
            result.add("node_modules")
        return result

    shutil.copytree(
        source,
        target,
        symlinks=False,
        copy_function=shutil.copy2,
        ignore=ignored,
        dirs_exist_ok=True,
    )
    target.chmod(0o700)


def assemble(package_root: Path, destination: Path) -> None:
    try:
        package_root = package_root.resolve(strict=True)
        package_details = package_root.lstat()
    except OSError as exc:
        raise AssemblyError("installed package is unavailable") from exc
    if (
        not stat.S_ISDIR(package_details.st_mode)
        or stat.S_ISLNK(package_details.st_mode)
        or package_details.st_mode & 0o022
    ):
        raise AssemblyError("installed package root is unsafe")
    if destination.exists() or destination.is_symlink():
        raise AssemblyError("assembly destination already exists")

    install_modules = package_root.parent
    if install_modules.name.startswith("@"):
        install_modules = install_modules.parent
    install_parent = install_modules.parent

    destination.mkdir(mode=0o700)
    for name in ("package.json", "dist", "scripts"):
        source = package_root / name
        try:
            details = source.lstat()
        except OSError as exc:
            raise AssemblyError("required package content is unavailable") from exc
        target = destination / name
        if stat.S_ISDIR(details.st_mode) and not stat.S_ISLNK(details.st_mode):
            _copy_tree(source, target, omit_modules=False)
        elif stat.S_ISREG(details.st_mode) and not stat.S_ISLNK(details.st_mode):
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target, follow_symlinks=False)
        else:
            raise AssemblyError("required package content is unsafe")

    queue: list[Path] = [package_root]
    seen: set[Path] = {package_root}
    while queue:
        owner = queue.pop(0)
        for name, required in _dependency_entries(_manifest(owner / "package.json")):
            relative_name = Path(*name.split("/"))
            cursor = owner
            resolved: Path | None = None
            while True:
                candidate = cursor / "node_modules" / relative_name
                if candidate.exists():
                    details = candidate.lstat()
                    if not stat.S_ISDIR(details.st_mode) or stat.S_ISLNK(
                        details.st_mode
                    ):
                        raise AssemblyError("installed dependency is unsafe")
                    resolved = candidate.resolve(strict=True)
                    try:
                        resolved.relative_to(install_parent)
                    except ValueError as exc:
                        raise AssemblyError(
                            "installed dependency escapes the install root"
                        ) from exc
                    break
                if cursor == install_parent or cursor.parent == cursor:
                    break
                cursor = cursor.parent
            if resolved is None:
                if required:
                    raise AssemblyError("installed dependency closure is incomplete")
                continue
            if package_root in resolved.parents:
                target = destination / resolved.relative_to(package_root)
            else:
                target = (
                    destination / "node_modules" / resolved.relative_to(install_modules)
                )
            if resolved not in seen:
                _copy_tree(resolved, target, omit_modules=True)
                seen.add(resolved)
                queue.append(resolved)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-root", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args(argv)
    if not args.package_root.is_absolute() or not args.destination.is_absolute():
        return 2
    try:
        assemble(args.package_root, args.destination)
    except (AssemblyError, OSError, shutil.Error):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
