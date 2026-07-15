#!/usr/bin/env python3
"""Strict public configuration contract for same-host recovery."""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re
from typing import Any


RECOVERY_CONFIG_VERSION = 2
RECOVERY_MODES = frozenset({"observe", "diagnose", "enabled"})
FIXER_ENDPOINT_OPERATIONS = frozenset(
    {"inspect", "reconcile", "blocked", "finish", "mutate"}
)
DEFAULT_RUNTIME_DOCTOR_CADENCE_SECONDS = 300
DEFAULT_VERIFICATION_FRESHNESS_SECONDS = 660
DEFAULT_VERIFICATION_HOLD_DOWN_SECONDS = 60
RUNTIME_DOCTOR_CADENCE_BOUNDS = (30, 3_600)
VERIFICATION_FRESHNESS_BOUNDS = (60, 86_400)
VERIFICATION_HOLD_DOWN_BOUNDS = (0, 86_400)
MAX_PROBE_TOTAL_TIMEOUT_MS = 300_000
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_LOCALE_VALUE = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")
_LAUNCHD_TARGET = re.compile(
    r"^(?:system|user/[0-9]+|gui/[0-9]+|pid/[0-9]+)/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
)
_SLEEP_SECONDS = re.compile(r"^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,3})?$")
_RUNTIME_VERSION = re.compile(
    r"^[0-9]+(?:\.[0-9]+){1,3}(?:[-+][A-Za-z0-9][A-Za-z0-9.-]{0,63})?$"
)
PINNED_PI_VERSION = "0.80.6"
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
    "internalAgentId",
    "fixerAuthTokenFile",
    "sessionPolicy",
    "actionPolicy",
    "quarantinePolicy",
    "reportPolicy",
    "slotPolicy",
    "reviewedOperations",
    "fixerLeaseSeconds",
    "fixerRenewSeconds",
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
    fixer_auth_token_file: Path
    host: str
    port: int
    correlation_rules: tuple[dict[str, Any], ...]
    source_ids: tuple[str, ...]
    probes: tuple[dict[str, Any], ...]
    runtime_doctor_cadence_seconds: int
    verification_freshness_seconds: int
    verification_hold_down_seconds: int
    internal_agent_id: str
    session_policy: dict[str, Any]
    action_policy: dict[str, Any]
    quarantine_policy: dict[str, Any]
    report_policy: dict[str, Any]
    slot_policy: dict[str, Any]
    reviewed_operations: tuple[dict[str, Any], ...]
    fixer_lease_seconds: int
    fixer_renew_seconds: int


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


def _bounded_integer(value: Any, bounds: tuple[int, int], name: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not bounds[0] <= value <= bounds[1]
    ):
        raise RecoveryConfigError(f"recovery {name} is invalid")
    return value


def _policy_workspace_path(
    workspace: Path, value: Any, name: str
) -> str:
    return str(_workspace_path(workspace, value, name))


def _absolute_policy_path(value: Any, name: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\0" in value
        or not _utf8_within(value, 4096)
    ):
        raise RecoveryConfigError(f"recovery {name} is invalid")
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or path == Path(path.anchor):
        raise RecoveryConfigError(f"recovery {name} must be a bounded absolute path")
    return str(path)


def _path_contains(parent: str, child: str) -> bool:
    try:
        Path(child).resolve().relative_to(Path(parent).resolve())
        return True
    except (OSError, RuntimeError, ValueError):
        return False


_FORBIDDEN_OPERATION_EXECUTABLES = {
    "apt",
    "apt-get",
    "bash",
    "brew",
    "curl",
    "dnf",
    "env",
    "fish",
    "gh",
    "git",
    "node",
    "npm",
    "npx",
    "pip",
    "pip3",
    "perl",
    "podman",
    "python",
    "python3",
    "rm",
    "ruby",
    "scp",
    "sh",
    "shred",
    "ssh",
    "sudo",
    "unlink",
    "wget",
    "yum",
    "zsh",
}
_SHELL_FRAGMENT = re.compile(r"(?:[;&|`<>\n\r]|\$\(|\$\{|\x00)")
_REVIEWED_SECRET_ARGUMENT = re.compile(
    r"(?:^|[-_.])(?:auth|credential|password|secret|token)(?:$|[-_.=])",
    re.IGNORECASE,
)
_SAFE_CONTAINER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def _reviewed_operation_argv_valid(
    kind: str, executable: str, argv: list[str]
) -> bool:
    """Reject reviewed commands that cross the phase-1 trusted-agent boundary."""

    name = Path(executable).name.lower()
    lowered = [argument.lower() for argument in argv]
    if any(
        _REVIEWED_SECRET_ARGUMENT.search(argument) is not None
        or argument in {"sudo", "getupdates"}
        for argument in lowered
    ):
        return False
    if any(
        argument in {
            "build",
            "download",
            "install",
            "prune",
            "pull",
            "push",
            "volume",
        }
        for argument in lowered
    ):
        return False
    if name == "launchctl":
        return bool(
            kind == "restart"
            and len(argv) in {2, 3}
            and argv[0] == "kickstart"
            and (len(argv) == 2 or argv[1] == "-k")
            and _LAUNCHD_TARGET.fullmatch(argv[-1])
            and argv[-1].split("/", 1)[0] in {"user", "gui"}
        )
    if name == "docker":
        return bool(
            kind == "restart"
            and len(argv) == 2
            and argv[0] == "restart"
            and _SAFE_CONTAINER_NAME.fullmatch(argv[1])
        )
    # A deployment-specific rollback/restart wrapper is allowed only as an
    # immutable absolute executable selected by ID. It still cannot contain
    # shell syntax or any of the forbidden operation vocabulary above.
    return name not in _FORBIDDEN_OPERATION_EXECUTABLES


def validated_reviewed_operation(value: Any) -> dict[str, Any]:
    """Return one closed static supervisor operation without shell semantics."""

    item = _object(
        value,
        {"id", "kind", "executable", "argv", "timeoutSeconds"},
        "reviewed operation",
    )
    identifier = _safe_id(item["id"], "reviewed operation id")
    kind = item["kind"]
    if not isinstance(kind, str) or kind not in {"restart", "rollback"}:
        raise RecoveryConfigError("recovery reviewed operation kind is invalid")
    executable = item["executable"]
    if (
        not isinstance(executable, str)
        or not executable
        or "\0" in executable
        or not _utf8_within(executable, 4096)
        or not Path(executable).is_absolute()
        or ".." in Path(executable).parts
        or Path(executable).name.lower() in _FORBIDDEN_OPERATION_EXECUTABLES
    ):
        raise RecoveryConfigError("recovery reviewed operation executable is invalid")
    argv = item["argv"]
    if (
        not isinstance(argv, list)
        or len(argv) > 64
        or not all(
            isinstance(arg, str)
            and arg
            and _utf8_within(arg, 4096)
            and _SHELL_FRAGMENT.search(arg) is None
            for arg in argv
        )
        or sum(len(arg.encode("utf-8")) for arg in argv) > 16 * 1024
        or not _reviewed_operation_argv_valid(str(kind), executable, argv)
    ):
        raise RecoveryConfigError("recovery reviewed operation argv is invalid")
    timeout = _bounded_integer(
        item["timeoutSeconds"], (1, 300), "reviewed operation timeout"
    )
    return {
        "id": identifier,
        "kind": str(kind),
        "executable": executable,
        "argv": list(argv),
        "timeoutSeconds": timeout,
    }


def recovery_mode_allows_dispatch(mode: str) -> bool:
    if mode not in RECOVERY_MODES:
        raise ValueError("recovery mode is invalid")
    return mode in {"diagnose", "enabled"}


def recovery_mode_allows_mutation(mode: str) -> bool:
    if mode not in RECOVERY_MODES:
        raise ValueError("recovery mode is invalid")
    return mode == "enabled"


def recovery_endpoint_allowed(mode: str, operation: str) -> bool:
    """Authorize one fixer endpoint class independently of route parsing."""

    if operation not in FIXER_ENDPOINT_OPERATIONS:
        raise ValueError("recovery endpoint operation is invalid")
    if not recovery_mode_allows_dispatch(mode):
        return False
    return operation != "mutate" or recovery_mode_allows_mutation(mode)


def recovery_static_policy(config: RecoveryConfig) -> dict[str, Any]:
    """Return the canonical dispatch-relevant configuration for durable fencing."""

    return {
        "version": RECOVERY_CONFIG_VERSION,
        "mode": config.mode,
        "internalAgentId": config.internal_agent_id,
        "correlationRules": [dict(rule) for rule in config.correlation_rules],
        "sourceIds": list(config.source_ids),
        "probes": [dict(probe) for probe in config.probes],
        "runtimeDoctorCadenceSeconds": config.runtime_doctor_cadence_seconds,
        "verificationFreshnessSeconds": config.verification_freshness_seconds,
        "verificationHoldDownSeconds": config.verification_hold_down_seconds,
        "sessionPolicy": dict(config.session_policy),
        "actionPolicy": dict(config.action_policy),
        "quarantinePolicy": {
            **config.quarantine_policy,
            "allowedRoots": list(config.quarantine_policy["allowedRoots"]),
        },
        "reportPolicy": dict(config.report_policy),
        "slotPolicy": dict(config.slot_policy),
        "reviewedOperations": [dict(operation) for operation in config.reviewed_operations],
        "fixerLeaseSeconds": config.fixer_lease_seconds,
        "fixerRenewSeconds": config.fixer_renew_seconds,
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
        or document["version"] != RECOVERY_CONFIG_VERSION
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
    if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
        raise RecoveryConfigError("recovery port is invalid")

    cadence_seconds = _bounded_integer(
        document["runtimeDoctorCadenceSeconds"],
        RUNTIME_DOCTOR_CADENCE_BOUNDS,
        "runtime doctor cadence",
    )
    freshness_seconds = _bounded_integer(
        document["verificationFreshnessSeconds"],
        VERIFICATION_FRESHNESS_BOUNDS,
        "verification freshness",
    )
    hold_down_seconds = _bounded_integer(
        document["verificationHoldDownSeconds"],
        VERIFICATION_HOLD_DOWN_BOUNDS,
        "verification hold-down",
    )
    if freshness_seconds <= cadence_seconds * 2:
        raise RecoveryConfigError(
            "recovery verification freshness must exceed two runtime doctor cadences"
        )

    internal_agent_id = _safe_id(document["internalAgentId"], "internal agent id")
    fixer_lease_seconds = _bounded_integer(
        document["fixerLeaseSeconds"], (10, 3_600), "fixer lease"
    )
    fixer_renew_seconds = _bounded_integer(
        document["fixerRenewSeconds"], (1, 1_800), "fixer renew interval"
    )
    if fixer_renew_seconds * 2 >= fixer_lease_seconds:
        raise RecoveryConfigError(
            "recovery fixer renew interval must be less than half the lease"
        )

    raw_session = _object(
        document["sessionPolicy"],
        {
            "directory",
            "startupTimeoutSeconds",
            "resumeTimeoutSeconds",
            "maxReplacementsPerGeneration",
            "journalDigestMaxBytes",
        },
        "session policy",
    )
    session_policy = {
        "directory": _policy_workspace_path(
            workspace, raw_session["directory"], "session directory"
        ),
        "startupTimeoutSeconds": _bounded_integer(
            raw_session["startupTimeoutSeconds"], (1, 300), "session startup timeout"
        ),
        "resumeTimeoutSeconds": _bounded_integer(
            raw_session["resumeTimeoutSeconds"], (1, 300), "session resume timeout"
        ),
        "maxReplacementsPerGeneration": _bounded_integer(
            raw_session["maxReplacementsPerGeneration"],
            (0, 10),
            "session replacement limit",
        ),
        "journalDigestMaxBytes": _bounded_integer(
            raw_session["journalDigestMaxBytes"],
            (1_024, 262_144),
            "session journal digest bound",
        ),
    }

    raw_action = _object(
        document["actionPolicy"],
        {"maxActionsPerInvocation", "preimageMaxBytes", "reconciliationTimeoutSeconds"},
        "action policy",
    )
    action_policy = {
        "maxActionsPerInvocation": _bounded_integer(
            raw_action["maxActionsPerInvocation"], (1, 1_000), "action count bound"
        ),
        "preimageMaxBytes": _bounded_integer(
            raw_action["preimageMaxBytes"], (0, 16 * 1024 * 1024), "preimage byte bound"
        ),
        "reconciliationTimeoutSeconds": _bounded_integer(
            raw_action["reconciliationTimeoutSeconds"],
            (1, 3_600),
            "action reconciliation timeout",
        ),
    }

    raw_quarantine = _object(
        document["quarantinePolicy"],
        {"directory", "allowedRoots", "maxItemsPerIncident", "maxItemBytes", "maxIncidentBytes"},
        "quarantine policy",
    )
    raw_allowed_roots = raw_quarantine["allowedRoots"]
    if not isinstance(raw_allowed_roots, list) or len(raw_allowed_roots) > 32:
        raise RecoveryConfigError("recovery quarantine roots are invalid")
    allowed_roots = tuple(
        _absolute_policy_path(root, "quarantine root") for root in raw_allowed_roots
    )
    if len(set(allowed_roots)) != len(allowed_roots):
        raise RecoveryConfigError("recovery quarantine roots contain duplicates")
    max_item_bytes = _bounded_integer(
        raw_quarantine["maxItemBytes"], (1, 1024 * 1024 * 1024), "quarantine item byte bound"
    )
    max_incident_bytes = _bounded_integer(
        raw_quarantine["maxIncidentBytes"],
        (1, 10 * 1024 * 1024 * 1024),
        "quarantine incident byte bound",
    )
    if max_incident_bytes < max_item_bytes:
        raise RecoveryConfigError(
            "recovery quarantine incident byte bound is smaller than the item bound"
        )
    quarantine_policy = {
        "directory": _policy_workspace_path(
            workspace, raw_quarantine["directory"], "quarantine directory"
        ),
        "allowedRoots": allowed_roots,
        "maxItemsPerIncident": _bounded_integer(
            raw_quarantine["maxItemsPerIncident"], (1, 1_000), "quarantine item bound"
        ),
        "maxItemBytes": max_item_bytes,
        "maxIncidentBytes": max_incident_bytes,
    }

    raw_report = _object(
        document["reportPolicy"],
        {"maxBytes", "maxTimelineEntries", "retrySeconds"},
        "report policy",
    )
    report_policy = {
        "maxBytes": _bounded_integer(
            raw_report["maxBytes"], (1_024, 1024 * 1024), "report byte bound"
        ),
        "maxTimelineEntries": _bounded_integer(
            raw_report["maxTimelineEntries"], (1, 2_000), "report timeline bound"
        ),
        "retrySeconds": _bounded_integer(
            raw_report["retrySeconds"], (1, 86_400), "report retry interval"
        ),
    }

    raw_slot = _object(
        document["slotPolicy"],
        {
            "stateDirectory",
            "capsuleRoot",
            "botReleaseRoot",
            "startupHealthTimeoutSeconds",
            "nodeExecutable",
            "nodeVersion",
            "piExecutable",
            "piVersion",
        },
        "slot policy",
    )
    node_executable = _absolute_policy_path(
        raw_slot["nodeExecutable"], "slot Node executable"
    )
    pi_executable = _absolute_policy_path(
        raw_slot["piExecutable"], "slot Pi executable"
    )
    node_version = raw_slot["nodeVersion"]
    pi_version = raw_slot["piVersion"]
    if (
        node_executable == pi_executable
        or not isinstance(node_version, str)
        or _RUNTIME_VERSION.fullmatch(node_version) is None
        or not isinstance(pi_version, str)
        or pi_version != PINNED_PI_VERSION
    ):
        raise RecoveryConfigError("recovery slot runtime prerequisites are invalid")
    state_directory = _policy_workspace_path(
        workspace, raw_slot["stateDirectory"], "slot state directory"
    )
    capsule_root = _policy_workspace_path(
        workspace, raw_slot["capsuleRoot"], "capsule root"
    )
    bot_release_root = _policy_workspace_path(
        workspace, raw_slot["botReleaseRoot"], "bot release root"
    )
    slot_roots = (state_directory, capsule_root, bot_release_root)
    if len(set(slot_roots)) != len(slot_roots) or any(
        _path_contains(left, right) or _path_contains(right, left)
        for index, left in enumerate(slot_roots)
        for right in slot_roots[index + 1 :]
    ) or any(
        _path_contains(root, executable)
        for root in slot_roots
        for executable in (node_executable, pi_executable)
    ):
        raise RecoveryConfigError("recovery slot roots and prerequisites overlap")
    slot_policy = {
        "stateDirectory": state_directory,
        "capsuleRoot": capsule_root,
        "botReleaseRoot": bot_release_root,
        "startupHealthTimeoutSeconds": _bounded_integer(
            raw_slot["startupHealthTimeoutSeconds"], (1, 600), "slot health timeout"
        ),
        "nodeExecutable": node_executable,
        "nodeVersion": node_version,
        "piExecutable": pi_executable,
        "piVersion": pi_version,
    }

    raw_operations = document["reviewedOperations"]
    if not isinstance(raw_operations, list) or len(raw_operations) > 64:
        raise RecoveryConfigError("recovery reviewed operations are invalid")
    reviewed_operations = tuple(
        validated_reviewed_operation(operation) for operation in raw_operations
    )
    operation_ids = [str(operation["id"]) for operation in reviewed_operations]
    if len(set(operation_ids)) != len(operation_ids):
        raise RecoveryConfigError("recovery reviewed operation IDs contain duplicates")
    if any(
        _path_contains(root, str(operation["executable"]))
        for root in (capsule_root, bot_release_root)
        for operation in reviewed_operations
    ):
        raise RecoveryConfigError("recovery reviewed operation is inside a release slot")

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
    probe_timeout_budget_ms = sum(int(item["timeoutMs"]) for item in probes)
    if probe_timeout_budget_ms > min(
        MAX_PROBE_TOTAL_TIMEOUT_MS,
        cadence_seconds * 1_000,
    ):
        raise RecoveryConfigError("recovery probe timeout budget is invalid")
    ids = [str(item["id"]) for item in probes]
    if len(ids) != len(set(ids)):
        raise RecoveryConfigError("recovery probes contain duplicate IDs")

    auth_token_file = _workspace_path(
        workspace, document["authTokenFile"], "auth token path"
    )
    fixer_auth_token_file = _workspace_path(
        workspace, document["fixerAuthTokenFile"], "fixer auth token path"
    )
    if auth_token_file == fixer_auth_token_file:
        raise RecoveryConfigError("recovery intake and fixer credentials must be distinct")

    return RecoveryConfig(
        path=path.resolve(),
        workspace=workspace,
        mode=str(document["mode"]),
        database=_workspace_path(workspace, document["database"], "database path"),
        spool_directory=_workspace_path(workspace, document["spoolDirectory"], "spool directory"),
        auth_token_file=auth_token_file,
        fixer_auth_token_file=fixer_auth_token_file,
        host=str(document["host"]),
        port=int(port),
        correlation_rules=tuple(rules),
        source_ids=sources,
        probes=probes,
        runtime_doctor_cadence_seconds=cadence_seconds,
        verification_freshness_seconds=freshness_seconds,
        verification_hold_down_seconds=hold_down_seconds,
        internal_agent_id=internal_agent_id,
        session_policy=session_policy,
        action_policy=action_policy,
        quarantine_policy=quarantine_policy,
        report_policy=report_policy,
        slot_policy=slot_policy,
        reviewed_operations=reviewed_operations,
        fixer_lease_seconds=fixer_lease_seconds,
        fixer_renew_seconds=fixer_renew_seconds,
    )
