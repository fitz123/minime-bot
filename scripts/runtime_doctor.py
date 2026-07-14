#!/usr/bin/env python3
"""One-shot, host-native runtime and monitoring health doctor."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import http.client
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import math
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import urllib.parse
import uuid
from dataclasses import dataclass
from typing import Any, Callable

from monitoring_native import (
    DeliveryConfig,
    MonitoringError,
    read_private_ascii_token,
    request_with_deadline,
    send_telegram,
)

STATE_VERSION = 1
TCC_STATUS_MAX_BYTES = 1024
STATE_MAX_BYTES = 64 * 1024
RECOVERY_TOKEN_MAX_BYTES = 4 * 1024
ENV_PREFIX = "MINIME_DOCTOR_"
INCIDENT_ACTIONS = {
    "alertmanager_unhealthy": "check Alertmanager health and recreate its current service",
    "bot_metrics_unhealthy": "check the bot metrics listener and bot logs",
    "bot_service_unhealthy": "check the configured launchd service",
    "node_path_drift": "restore or record the intended Node executable",
    "node_unavailable": "restore the configured Node executable",
    "node_version_drift": "restore or record the intended Node version",
    "prometheus_unhealthy": "check Prometheus health, targets, and current service",
    "runtime_state_missing": "verify the deploy runtime state producer",
    "runtime_state_stale": "verify the latest deployment completed",
    "tcc_denied": "review the external non-prompting permission signal",
    "tcc_unknown": "configure or refresh the external permission signal",
}


@dataclass(frozen=True)
class DoctorConfig:
    state_path: Path
    chat_id: str
    thread_id: str | None
    timeout: float
    launchd_label: str | None
    launchctl: str
    bot_metrics_url: str | None
    prometheus_url: str | None
    alertmanager_url: str | None
    node_executable: str | None
    node_baseline_path: str | None
    node_baseline_version: str | None
    runtime_state_path: Path | None
    runtime_max_age: float
    tcc_status_path: Path | None
    log_path: Path | None
    sink_mode: str
    recovery_url: str | None
    recovery_token_file: Path | None
    recovery_attempts: int

    @classmethod
    def from_environ(cls, env: dict[str, str] | os._Environ[str] = os.environ) -> "DoctorConfig":
        state = env.get(f"{ENV_PREFIX}STATE_PATH", "")
        if not state:
            raise ValueError("state path is required")
        timeout = float(env.get(f"{ENV_PREFIX}TIMEOUT", "5"))
        runtime_max_age = float(env.get(f"{ENV_PREFIX}RUNTIME_MAX_AGE", "3600"))
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout is invalid")
        if not math.isfinite(runtime_max_age) or runtime_max_age <= 0:
            raise ValueError("runtime age is invalid")
        runtime = env.get(f"{ENV_PREFIX}RUNTIME_STATE_PATH")
        tcc = env.get(f"{ENV_PREFIX}TCC_STATUS_PATH")
        log = env.get(f"{ENV_PREFIX}LOG_PATH")
        sink_mode = env.get(f"{ENV_PREFIX}SINK", "telegram")
        if sink_mode not in {"telegram", "tee", "recovery"}:
            raise ValueError("sink mode is invalid")
        recovery_url = env.get(f"{ENV_PREFIX}RECOVERY_URL") or None
        recovery_token = env.get(f"{ENV_PREFIX}RECOVERY_TOKEN_FILE") or None
        recovery_attempts = int(env.get(f"{ENV_PREFIX}RECOVERY_ATTEMPTS", "3"))
        if not 1 <= recovery_attempts <= 10:
            raise ValueError("recovery attempts are invalid")
        if sink_mode in {"tee", "recovery"}:
            if not recovery_url or not recovery_token:
                raise ValueError("recovery sink is not configured")
            parsed_recovery = urllib.parse.urlsplit(recovery_url)
            if (
                parsed_recovery.scheme != "http"
                or parsed_recovery.hostname not in {"127.0.0.1", "localhost"}
                or parsed_recovery.username is not None
                or parsed_recovery.password is not None
                or parsed_recovery.path != "/v1/runtime-doctor"
                or parsed_recovery.query
                or parsed_recovery.fragment
            ):
                raise ValueError("recovery URL is invalid")
            try:
                parsed_recovery.port
            except ValueError:
                raise ValueError("recovery URL is invalid") from None
        urls = {
            name: env.get(f"{ENV_PREFIX}{name}") or None
            for name in ("BOT_METRICS_URL", "PROMETHEUS_URL", "ALERTMANAGER_URL")
        }
        for url in urls.values():
            if url:
                parsed = urllib.parse.urlsplit(url)
                if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                    raise ValueError("health URL is invalid")
                try:
                    parsed.port
                except ValueError:
                    raise ValueError("health URL is invalid") from None
        return cls(
            state_path=Path(state),
            chat_id=env.get("MINIME_TELEGRAM_CHAT_ID", ""),
            thread_id=env.get("MINIME_TELEGRAM_THREAD_ID"),
            timeout=max(0.1, min(timeout, 30.0)),
            launchd_label=env.get(f"{ENV_PREFIX}LAUNCHD_LABEL") or None,
            launchctl=env.get(f"{ENV_PREFIX}LAUNCHCTL", "/bin/launchctl"),
            bot_metrics_url=urls["BOT_METRICS_URL"],
            prometheus_url=urls["PROMETHEUS_URL"],
            alertmanager_url=urls["ALERTMANAGER_URL"],
            node_executable=env.get(f"{ENV_PREFIX}NODE_EXECUTABLE") or None,
            node_baseline_path=env.get(f"{ENV_PREFIX}NODE_BASELINE_PATH") or None,
            node_baseline_version=env.get(f"{ENV_PREFIX}NODE_BASELINE_VERSION") or None,
            runtime_state_path=Path(runtime) if runtime else None,
            runtime_max_age=runtime_max_age,
            tcc_status_path=Path(tcc) if tcc else None,
            log_path=Path(log) if log else None,
            sink_mode=sink_mode,
            recovery_url=recovery_url,
            recovery_token_file=Path(recovery_token) if recovery_token else None,
            recovery_attempts=recovery_attempts,
        )


def make_logger(path: Path | None) -> logging.Logger:
    logger = logging.getLogger("minime-runtime-doctor")
    logger.handlers.clear()
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler: logging.Handler = RotatingFileHandler(path, maxBytes=256_000, backupCount=3)
    else:
        handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(formatter)
    logger.addHandler(handler)
    return logger


def _http_healthy(url: str, timeout: float) -> bool:
    try:
        response = request_with_deadline(url, method="GET", timeout=timeout)
        return 200 <= response.status < 300
    except (
        http.client.HTTPException,
        TimeoutError,
        OSError,
        ValueError,
    ):
        return False


def _read_tcc_status(path: Path) -> str:
    descriptor: int | None = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > TCC_STATUS_MAX_BYTES:
            return "unknown"
        value = os.read(descriptor, TCC_STATUS_MAX_BYTES + 1)
        if len(value) > TCC_STATUS_MAX_BYTES:
            return "unknown"
        return value.decode("utf-8").strip().lower()
    except (OSError, UnicodeError):
        return "unknown"
    finally:
        if descriptor is not None:
            os.close(descriptor)


def collect_incidents(config: DoctorConfig, *, now: float | None = None) -> set[str]:
    incidents: set[str] = set()
    current_time = time.time() if now is None else now

    if config.launchd_label:
        service = f"gui/{os.getuid()}/{config.launchd_label}"
        try:
            result = subprocess.run(
                [config.launchctl, "print", service],
                capture_output=True,
                text=True,
                timeout=config.timeout,
                check=False,
            )
            running = result.returncode == 0 and ("state = running" in result.stdout or "pid =" in result.stdout)
        except (OSError, subprocess.SubprocessError):
            running = False
        if not running:
            incidents.add("bot_service_unhealthy")

    for url, code in (
        (config.bot_metrics_url, "bot_metrics_unhealthy"),
        (config.prometheus_url, "prometheus_unhealthy"),
        (config.alertmanager_url, "alertmanager_unhealthy"),
    ):
        if url and not _http_healthy(url, config.timeout):
            incidents.add(code)

    if config.node_executable:
        resolved = shutil.which(config.node_executable)
        if not resolved:
            incidents.add("node_unavailable")
        else:
            actual_path = str(Path(resolved).resolve())
            if config.node_baseline_path and actual_path != str(Path(config.node_baseline_path).resolve()):
                incidents.add("node_path_drift")
            try:
                version_result = subprocess.run(
                    [resolved, "--version"],
                    capture_output=True,
                    text=True,
                    timeout=config.timeout,
                    check=False,
                )
                version = version_result.stdout.strip()
                if version_result.returncode != 0:
                    incidents.add("node_unavailable")
                elif config.node_baseline_version and version != config.node_baseline_version:
                    incidents.add("node_version_drift")
            except (OSError, subprocess.SubprocessError):
                incidents.add("node_unavailable")

    if config.runtime_state_path:
        descriptor: int | None = None
        try:
            descriptor = os.open(
                config.runtime_state_path,
                os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC,
            )
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise OSError("runtime state is not a regular file")
            age = current_time - metadata.st_mtime
            if age < -300 or age > config.runtime_max_age:
                incidents.add("runtime_state_stale")
        except OSError:
            incidents.add("runtime_state_missing")
        finally:
            if descriptor is not None:
                os.close(descriptor)

    if config.tcc_status_path:
        status = _read_tcc_status(config.tcc_status_path)
        if status == "denied":
            incidents.add("tcc_denied")
        elif status != "granted":
            incidents.add("tcc_unknown")

    return incidents


def incident_message(incidents: set[str]) -> str:
    if not incidents:
        return "RECOVERED minime_runtime_health\nall configured host checks are healthy"
    lines = ["FIRING minime_runtime_health"]
    for code in sorted(incidents):
        lines.append(f"{code}: {INCIDENT_ACTIONS[code]}")
    return "\n".join(lines)


def _read_state_document(path: Path) -> tuple[dict[str, Any] | None, bool]:
    descriptor: int | None = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > STATE_MAX_BYTES:
            return None, True
        raw = os.read(descriptor, STATE_MAX_BYTES + 1)
        if len(raw) > STATE_MAX_BYTES:
            return None, True
        value = json.loads(raw.decode("utf-8"))
    except FileNotFoundError:
        return None, False
    except (OSError, UnicodeError, ValueError):
        return None, True
    finally:
        if descriptor is not None:
            os.close(descriptor)
    incidents = (
        value.get("incidents")
        if isinstance(value, dict) and value.get("version") == STATE_VERSION
        else None
    )
    if not isinstance(incidents, list) or not all(
        isinstance(item, str) and item in INCIDENT_ACTIONS for item in incidents
    ):
        return None, True
    pending = value.get("pending")
    if pending is not None and not _valid_pending(pending):
        return None, True
    return value, False


def read_state(path: Path) -> tuple[set[str], bool]:
    value, corrupt = _read_state_document(path)
    if corrupt or value is None:
        return set(), corrupt
    pending = value.get("pending")
    if isinstance(pending, dict) and pending["native_delivered"]:
        return set(pending["target_incidents"]), False
    return set(value["incidents"]), False


def _write_state_document(
    path: Path, incidents: set[str], pending: dict[str, Any] | None = None
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    document: dict[str, Any] = {
        "version": STATE_VERSION,
        "incidents": sorted(incidents),
        "updated_at": int(time.time()),
    }
    if pending is not None:
        document["pending"] = pending
    payload = json.dumps(
        document,
        separators=(",", ":"),
    ) + "\n"
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def write_state(path: Path, incidents: set[str]) -> None:
    _write_state_document(path, incidents)


def doctor_transition_id(code: str, status: str, transition: str) -> str:
    canonical = json.dumps(
        ["runtime_doctor", code, status, transition],
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    return hashlib.sha256(canonical).hexdigest()


def _transition_events(previous: set[str], current: set[str]) -> list[dict[str, str]]:
    events: list[dict[str, str]] = []
    for status, codes in (("resolved", previous - current), ("firing", current - previous)):
        for code in sorted(codes):
            transition = uuid.uuid4().hex
            events.append(
                {
                    "code": code,
                    "status": status,
                    "transition": transition,
                    "transition_id": doctor_transition_id(code, status, transition),
                }
            )
    return events


def _valid_pending(value: Any) -> bool:
    if not isinstance(value, dict) or set(value) != {
        "events",
        "native_delivered",
        "target_incidents",
    }:
        return False
    target = value.get("target_incidents")
    events = value.get("events")
    if (
        not isinstance(target, list)
        or not all(isinstance(item, str) and item in INCIDENT_ACTIONS for item in target)
        or not isinstance(events, list)
        or not events
        or not isinstance(value.get("native_delivered"), bool)
    ):
        return False
    for event in events:
        if not isinstance(event, dict) or set(event) != {
            "code",
            "status",
            "transition",
            "transition_id",
        }:
            return False
        code = event.get("code")
        status_value = event.get("status")
        transition = event.get("transition")
        supplied = event.get("transition_id")
        if (
            not isinstance(code, str)
            or code not in INCIDENT_ACTIONS
            or status_value not in {"firing", "resolved"}
            or not isinstance(transition, str)
            or not transition
            or not isinstance(supplied, str)
            or supplied != doctor_transition_id(code, status_value, transition)
        ):
            return False
    return True


def read_delivery_state(path: Path) -> tuple[set[str], dict[str, Any] | None, bool]:
    value, corrupt = _read_state_document(path)
    if corrupt or value is None:
        return set(), None, corrupt
    pending = value.get("pending")
    if pending is not None and not isinstance(pending, dict):
        return set(), None, True
    return set(value["incidents"]), pending, False


def write_delivery_state(
    path: Path,
    incidents: set[str],
    pending: dict[str, Any] | None,
) -> None:
    _write_state_document(path, incidents, pending)


def _read_recovery_token(path: Path) -> str:
    try:
        return read_private_ascii_token(path, max_bytes=RECOVERY_TOKEN_MAX_BYTES)
    except MonitoringError as exc:
        raise MonitoringError("recovery authentication is unavailable") from exc


def send_recovery_events(
    events: list[dict[str, str]],
    config: DoctorConfig,
    *,
    heartbeats: dict[str, bool] | None = None,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    if config.recovery_url is None or config.recovery_token_file is None:
        raise MonitoringError("recovery sink is not configured")
    token = _read_recovery_token(config.recovery_token_file)
    body = json.dumps(
        {
            "version": 1,
            "events": events,
            "heartbeats": heartbeats or {"runtime_doctor": True},
        },
        ensure_ascii=True,
        separators=(",", ":"),
    ).encode("ascii")
    for attempt in range(config.recovery_attempts):
        retryable = True
        try:
            response = request_with_deadline(
                config.recovery_url,
                method="POST",
                timeout=config.timeout,
                data=body,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                max_body=1024,
            )
            if 200 <= response.status < 300:
                return
            retryable = response.status in {408, 429} or response.status >= 500
        except (http.client.HTTPException, TimeoutError, OSError):
            pass
        if not retryable or attempt + 1 >= config.recovery_attempts:
            break
        sleep(min(0.1 * (2**attempt), 1.0))
    raise MonitoringError("recovery delivery failed")


def acquire_lock(path: Path) -> int | None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        return None
    except OSError:
        os.close(descriptor)
        raise
    return descriptor


def run_doctor(
    config: DoctorConfig,
    *,
    deliver: Callable[[str], None] | None = None,
    deliver_recovery: Callable[[list[dict[str, str]]], None] | None = None,
    logger: logging.Logger | None = None,
) -> int:
    active_logger = logger or make_logger(config.log_path)
    lock_path = config.state_path.with_name(f"{config.state_path.name}.lock")
    lock_fd = acquire_lock(lock_path)
    if lock_fd is None:
        active_logger.warning("doctor_overlap_suppressed")
        return 0
    try:
        incidents = collect_incidents(config)
        notify = deliver or (lambda message: send_telegram(message, DeliveryConfig(config.chat_id, config.thread_id)))
        if config.sink_mode == "telegram":
            previous, corrupt = read_state(config.state_path)
            if corrupt:
                active_logger.error("doctor_state_corrupt_reset")
                write_state(config.state_path, set())
                return 0
            if incidents == previous:
                if not config.state_path.exists():
                    write_state(config.state_path, incidents)
                active_logger.info("doctor_state_unchanged codes=%s", ",".join(sorted(incidents)) or "healthy")
                return 0
            try:
                notify(incident_message(incidents))
            except (MonitoringError, OSError):
                active_logger.error("doctor_notification_failed")
                return 1
            write_state(config.state_path, incidents)
            active_logger.info("doctor_transition_notified codes=%s", ",".join(sorted(incidents)) or "recovered")
            return 0

        previous, pending, corrupt = read_delivery_state(config.state_path)
        if corrupt:
            active_logger.error("doctor_state_corrupt_reset")
            write_delivery_state(config.state_path, set(), None)
            return 0
        source_heartbeats = {"runtime_doctor": True}
        if config.alertmanager_url is not None:
            source_heartbeats["alertmanager"] = "alertmanager_unhealthy" not in incidents
        recovery_notify = deliver_recovery or (
            lambda events: send_recovery_events(
                events, config, heartbeats=source_heartbeats
            )
        )
        recovery_delivered = False

        def finish_pending(active: dict[str, Any]) -> tuple[bool, set[str]]:
            nonlocal recovery_delivered
            target = set(active["target_incidents"])
            if config.sink_mode == "tee" and not active["native_delivered"]:
                try:
                    notify(incident_message(target))
                except (MonitoringError, OSError):
                    active_logger.error("doctor_notification_failed")
                    return False, previous
                active["native_delivered"] = True
                write_delivery_state(config.state_path, previous, active)
            try:
                recovery_notify(active["events"])
            except (MonitoringError, OSError):
                active_logger.error("doctor_recovery_sink_failed")
                return False, previous
            recovery_delivered = True
            write_delivery_state(config.state_path, target, None)
            active_logger.info(
                "doctor_transition_notified codes=%s",
                ",".join(sorted(target)) or "recovered",
            )
            return True, target

        if pending is not None:
            completed, previous = finish_pending(pending)
            if not completed:
                return 1
        if incidents == previous:
            if not config.state_path.exists():
                write_delivery_state(config.state_path, incidents, None)
            if not recovery_delivered:
                try:
                    recovery_notify([])
                except (MonitoringError, OSError):
                    active_logger.error("doctor_recovery_sink_failed")
                    return 1
            active_logger.info("doctor_state_unchanged codes=%s", ",".join(sorted(incidents)) or "healthy")
            return 0
        pending = {
            "events": _transition_events(previous, incidents),
            "native_delivered": False,
            "target_incidents": sorted(incidents),
        }
        write_delivery_state(config.state_path, previous, pending)
        completed, _target = finish_pending(pending)
        return 0 if completed else 1
    finally:
        fcntl.flock(lock_fd, fcntl.LOCK_UN)
        os.close(lock_fd)


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the host-native minime runtime doctor once")
    parser.parse_args()
    try:
        config = DoctorConfig.from_environ()
        logger = make_logger(config.log_path)
    except (ValueError, OSError):
        print("doctor configuration invalid", file=sys.stderr)
        return 2
    try:
        return run_doctor(config, logger=logger)
    except Exception:
        logger.error("doctor_runtime_failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
