#!/usr/bin/env python3
"""Strict public configuration contract for same-host recovery."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Any


RECOVERY_MODES = frozenset({"observe"})
DEFAULT_RUNTIME_DOCTOR_CADENCE_SECONDS = 300
DEFAULT_VERIFICATION_FRESHNESS_SECONDS = 660
DEFAULT_VERIFICATION_HOLD_DOWN_SECONDS = 60
RUNTIME_DOCTOR_CADENCE_BOUNDS = (30, 3_600)
VERIFICATION_FRESHNESS_BOUNDS = (60, 86_400)
VERIFICATION_HOLD_DOWN_BOUNDS = (0, 86_400)
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_LOCALE_VALUE = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")
_LAUNCHD_TARGET = re.compile(
    r"^(?:system|user/[0-9]+|gui/[0-9]+|pid/[0-9]+)/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
)
_SLEEP_SECONDS = re.compile(r"^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,3})?$")
_READ_ONLY_PROBE_EXECUTABLES = {
    "/bin/false": "constant",
    "/bin/launchctl": "launchctl-print",
    "/bin/sleep": "sleep",
    "/bin/true": "constant",
    "/usr/bin/false": "constant",
    "/usr/bin/sleep": "sleep",
    "/usr/bin/true": "constant",
}
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
    "probes",
    "runtimeDoctorCadenceSeconds",
    "verificationFreshnessSeconds",
    "verificationHoldDownSeconds",
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
    probes: tuple[dict[str, Any], ...]
    runtime_doctor_cadence_seconds: int
    verification_freshness_seconds: int
    verification_hold_down_seconds: int


def _object(value: Any, keys: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise RecoveryConfigError(f"recovery {name} is invalid")
    return value


def _safe_id(value: Any, name: str) -> str:
    if not isinstance(value, str) or _SAFE_ID.fullmatch(value) is None:
        raise RecoveryConfigError(f"recovery {name} is invalid")
    return value


def _workspace_path(workspace: Path, value: Any, name: str) -> Path:
    if (
        not isinstance(value, str)
        or not value
        or "\0" in value
        or not _utf8_within(value, 4096)
    ):
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


def _utf8_within(value: str, limit: int) -> bool:
    try:
        return len(value.encode("utf-8")) <= limit
    except UnicodeEncodeError:
        return False


def _probe_argv_valid(executable: str, argv: list[str]) -> bool:
    contract = _READ_ONLY_PROBE_EXECUTABLES.get(executable)
    if contract == "constant":
        return not argv
    if contract == "sleep":
        return bool(len(argv) == 1 and _SLEEP_SECONDS.fullmatch(argv[0]))
    if contract == "launchctl-print":
        return bool(
            len(argv) == 2
            and argv[0] == "print"
            and _LAUNCHD_TARGET.fullmatch(argv[1])
        )
    return False


def validated_probe_command(value: Any) -> dict[str, Any]:
    """Return one closed, non-mutating host-native probe definition."""

    keys = {"id", "executable", "argv", "env", "timeoutMs"}
    item = _object(value, keys, "probe")
    _safe_id(item["id"], "command id")
    executable = item["executable"]
    if (
        not isinstance(executable, str)
        or not Path(executable).is_absolute()
        or ".." in Path(executable).parts
        or "\0" in executable
        or not _utf8_within(executable, 4096)
        or executable not in _READ_ONLY_PROBE_EXECUTABLES
    ):
        raise RecoveryConfigError("recovery command executable is invalid")
    argv = item["argv"]
    if (
        not isinstance(argv, list)
        or len(argv) > 64
        or not all(
            isinstance(arg, str)
            and "\0" not in arg
            and _utf8_within(arg, 4096)
            for arg in argv
        )
        or sum(len(arg.encode("utf-8")) for arg in argv) > 16 * 1024
        or not _probe_argv_valid(executable, argv)
    ):
        raise RecoveryConfigError("recovery command argv is invalid")
    env = item["env"]
    if not isinstance(env, dict) or len(env) > 32:
        raise RecoveryConfigError("recovery command environment is invalid")
    for key, env_value in env.items():
        if (
            key not in {"LANG", "LC_ALL"}
            or not isinstance(env_value, str)
            or "\0" in env_value
            or _LOCALE_VALUE.fullmatch(env_value) is None
            or not _utf8_within(env_value, 64)
        ):
            raise RecoveryConfigError("recovery command environment is invalid")
    timeout = item["timeoutMs"]
    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 100 <= timeout <= 300_000:
        raise RecoveryConfigError("recovery command timeout is invalid")
    return dict(item)


def _bounded_seconds(value: Any, bounds: tuple[int, int], name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not bounds[0] <= value <= bounds[1]:
        raise RecoveryConfigError(f"recovery {name} is invalid")
    return value


def recovery_static_policy(config: RecoveryConfig) -> dict[str, Any]:
    """Return the canonical dispatch-relevant configuration for durable fencing."""

    return {
        "version": 1,
        "mode": config.mode,
        "correlationRules": [dict(rule) for rule in config.correlation_rules],
        "sourceIds": list(config.source_ids),
        "probes": [dict(probe) for probe in config.probes],
        "runtimeDoctorCadenceSeconds": config.runtime_doctor_cadence_seconds,
        "verificationFreshnessSeconds": config.verification_freshness_seconds,
        "verificationHoldDownSeconds": config.verification_hold_down_seconds,
    }


def load_recovery_config(path: Path, workspace: Path) -> RecoveryConfig:
    """Load one exact JSON document without resolving secrets."""

    workspace = workspace.resolve()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RecoveryConfigError("recovery configuration could not be read") from exc
    document = _object(raw, _ROOT_KEYS, "configuration")
    if (
        isinstance(document["version"], bool)
        or document["version"] != 1
        or not isinstance(document["mode"], str)
        or document["mode"] not in RECOVERY_MODES
    ):
        raise RecoveryConfigError("recovery configuration version or mode is invalid")
    if (
        not isinstance(document["host"], str)
        or document["host"] not in {"127.0.0.1", "localhost"}
    ):
        raise RecoveryConfigError("recovery host must be loopback")
    port = document["port"]
    if isinstance(port, bool) or not isinstance(port, int) or not 0 <= port <= 65535:
        raise RecoveryConfigError("recovery port is invalid")

    cadence_seconds = _bounded_seconds(
        document["runtimeDoctorCadenceSeconds"],
        RUNTIME_DOCTOR_CADENCE_BOUNDS,
        "runtime doctor cadence",
    )
    freshness_seconds = _bounded_seconds(
        document["verificationFreshnessSeconds"],
        VERIFICATION_FRESHNESS_BOUNDS,
        "verification freshness",
    )
    hold_down_seconds = _bounded_seconds(
        document["verificationHoldDownSeconds"],
        VERIFICATION_HOLD_DOWN_BOUNDS,
        "verification hold-down",
    )
    if freshness_seconds <= cadence_seconds * 2:
        raise RecoveryConfigError(
            "recovery verification freshness must exceed two runtime doctor cadences"
        )

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
    ):
        raise RecoveryConfigError("recovery source IDs are invalid")
    sources = tuple(_safe_id(source, "source id") for source in raw_sources)
    if len(set(sources)) != len(sources) or not set(sources).issubset(
        {"alertmanager", "runtime_doctor"}
    ):
        raise RecoveryConfigError("recovery source IDs are invalid")

    raw_probes = document["probes"]
    if not isinstance(raw_probes, list) or len(raw_probes) > 128:
        raise RecoveryConfigError("recovery probes are invalid")
    probes = tuple(validated_probe_command(item) for item in raw_probes)
    ids = [str(item["id"]) for item in probes]
    if len(ids) != len(set(ids)):
        raise RecoveryConfigError("recovery probes contain duplicate IDs")

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
        probes=probes,
        runtime_doctor_cadence_seconds=cadence_seconds,
        verification_freshness_seconds=freshness_seconds,
        verification_hold_down_seconds=hold_down_seconds,
    )
