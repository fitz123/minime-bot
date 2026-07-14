#!/usr/bin/env python3
"""Strict public configuration contract for same-host recovery."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Any


RECOVERY_MODES = frozenset({"observe", "plan", "enabled"})
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_ENV_KEY = re.compile(r"^[A-Z_][A-Z0-9_]{0,127}$")
_SENSITIVE = re.compile(r"AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN", re.IGNORECASE)
_SENSITIVE_ARG = re.compile(
    r"^--?(?:api[-_]?key|authorization|credential|password|secret|token)(?:=|$)",
    re.IGNORECASE,
)
_ROOT_KEYS = {
    "version",
    "mode",
    "database",
    "spoolDirectory",
    "authTokenFile",
    "host",
    "port",
    "correlationRules",
    "sourceIds",
    "runbooks",
    "probes",
}


class RecoveryConfigError(ValueError):
    """The recovery configuration does not match the fixed public contract."""


@dataclass(frozen=True)
class RecoveryConfig:
    path: Path
    workspace: Path
    mode: str
    database: Path
    spool_directory: Path
    auth_token_file: Path
    host: str
    port: int
    correlation_rules: tuple[dict[str, Any], ...]
    source_ids: tuple[str, ...]
    runbooks: tuple[dict[str, Any], ...]
    probes: tuple[dict[str, Any], ...]


def _object(value: Any, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise RecoveryConfigError(f"recovery {name} is invalid")
    return value


def _safe_id(value: Any, name: str) -> str:
    if not isinstance(value, str) or _SAFE_ID.fullmatch(value) is None:
        raise RecoveryConfigError(f"recovery {name} is invalid")
    return value


def _workspace_path(workspace: Path, value: Any, name: str) -> Path:
    if not isinstance(value, str) or not value or "\0" in value:
        raise RecoveryConfigError(f"recovery {name} is invalid")
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise RecoveryConfigError(f"recovery {name} must be workspace-relative")
    resolved = (workspace / candidate).resolve()
    try:
        resolved.relative_to(workspace)
    except ValueError:
        raise RecoveryConfigError(f"recovery {name} escapes the control workspace") from None
    return resolved


def _command(value: Any, *, runbook: bool) -> dict[str, Any]:
    keys = {"id", "executable", "argv", "env", "timeoutMs"}
    if runbook:
        keys.add("actionClass")
    item = _object(value, keys, "runbook" if runbook else "probe")
    _safe_id(item["id"], "command id")
    executable = item["executable"]
    if (
        not isinstance(executable, str)
        or not Path(executable).is_absolute()
        or "\0" in executable
        or Path(executable).name.lower() == "sudo"
    ):
        raise RecoveryConfigError("recovery command executable is invalid")
    argv = item["argv"]
    if (
        not isinstance(argv, list)
        or len(argv) > 64
        or not all(
            isinstance(arg, str)
            and "\0" not in arg
            and len(arg.encode()) <= 4096
            and _SENSITIVE_ARG.search(arg) is None
            for arg in argv
        )
        or sum(len(arg.encode()) for arg in argv) > 16 * 1024
    ):
        raise RecoveryConfigError("recovery command argv is invalid")
    env = item["env"]
    if not isinstance(env, dict) or len(env) > 32:
        raise RecoveryConfigError("recovery command environment is invalid")
    for key, env_value in env.items():
        if (
            not isinstance(key, str)
            or _ENV_KEY.fullmatch(key) is None
            or _SENSITIVE.search(key) is not None
            or not isinstance(env_value, str)
            or "\0" in env_value
            or len(env_value.encode()) > 4096
        ):
            raise RecoveryConfigError("recovery command environment is invalid")
    timeout = item["timeoutMs"]
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 100 <= timeout <= 300_000:
        raise RecoveryConfigError("recovery command timeout is invalid")
    if runbook and item["actionClass"] not in {
        "diagnostic",
        "local_repair",
        "cache_cleanup",
        "restart",
        "deploy",
        "sudo",
        "package_upgrade",
        "secret_migration",
        "public_write",
    }:
        raise RecoveryConfigError("recovery runbook action class is invalid")
    return dict(item)


def recovery_static_policy(config: RecoveryConfig) -> dict[str, Any]:
    """Return the canonical dispatch-relevant configuration for durable fencing."""

    return {
        "version": 1,
        "mode": config.mode,
        "correlationRules": [dict(rule) for rule in config.correlation_rules],
        "sourceIds": list(config.source_ids),
        "runbooks": [dict(runbook) for runbook in config.runbooks],
        "probes": [dict(probe) for probe in config.probes],
    }


def load_recovery_config(path: Path, workspace: Path) -> RecoveryConfig:
    """Load one exact JSON document without resolving secrets."""

    workspace = workspace.resolve()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RecoveryConfigError("recovery configuration could not be read") from exc
    document = _object(raw, _ROOT_KEYS, "configuration")
    if document["version"] != 1 or document["mode"] not in RECOVERY_MODES:
        raise RecoveryConfigError("recovery configuration version or mode is invalid")
    if document["host"] not in {"127.0.0.1", "localhost"}:
        raise RecoveryConfigError("recovery host must be loopback")
    port = document["port"]
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise RecoveryConfigError("recovery port is invalid")

    raw_rules = document["correlationRules"]
    if not isinstance(raw_rules, list) or len(raw_rules) > 128:
        raise RecoveryConfigError("recovery correlation rules are invalid")
    rules: list[dict[str, Any]] = []
    rule_keys: set[tuple[str, str]] = set()
    for raw_rule in raw_rules:
        rule = _object(raw_rule, {"component", "failureClass", "incidentKey", "impact"}, "rule")
        component = _safe_id(rule["component"], "rule component")
        failure_class = _safe_id(rule["failureClass"], "rule failure class")
        incident_key = _safe_id(rule["incidentKey"], "rule incident key")
        impact = rule["impact"]
        if isinstance(impact, bool) or not isinstance(impact, int) or not 0 <= impact <= 3:
            raise RecoveryConfigError("recovery rule impact is invalid")
        identity = (component, failure_class)
        if identity in rule_keys:
            raise RecoveryConfigError("recovery correlation rules overlap")
        rule_keys.add(identity)
        rules.append({
            "component": component,
            "failureClass": failure_class,
            "incidentKey": incident_key,
            "impact": impact,
        })

    raw_sources = document["sourceIds"]
    if (
        not isinstance(raw_sources, list)
        or not 1 <= len(raw_sources) <= 16
        or len(set(raw_sources)) != len(raw_sources)
    ):
        raise RecoveryConfigError("recovery source IDs are invalid")
    sources = tuple(_safe_id(source, "source id") for source in raw_sources)
    if not set(sources).issubset({"alertmanager", "runtime_doctor"}):
        raise RecoveryConfigError("recovery source IDs are invalid")

    raw_runbooks = document["runbooks"]
    raw_probes = document["probes"]
    if not isinstance(raw_runbooks, list) or len(raw_runbooks) > 128:
        raise RecoveryConfigError("recovery runbooks are invalid")
    if not isinstance(raw_probes, list) or len(raw_probes) > 128:
        raise RecoveryConfigError("recovery probes are invalid")
    runbooks = tuple(_command(item, runbook=True) for item in raw_runbooks)
    probes = tuple(_command(item, runbook=False) for item in raw_probes)
    for registry, name in ((runbooks, "runbooks"), (probes, "probes")):
        ids = [str(item["id"]) for item in registry]
        if len(ids) != len(set(ids)):
            raise RecoveryConfigError(f"recovery {name} contain duplicate IDs")

    return RecoveryConfig(
        path=path.resolve(),
        workspace=workspace,
        mode=str(document["mode"]),
        database=_workspace_path(workspace, document["database"], "database path"),
        spool_directory=_workspace_path(workspace, document["spoolDirectory"], "spool directory"),
        auth_token_file=_workspace_path(workspace, document["authTokenFile"], "auth token path"),
        host=str(document["host"]),
        port=int(port),
        correlation_rules=tuple(rules),
        source_ids=sources,
        runbooks=runbooks,
        probes=probes,
    )
