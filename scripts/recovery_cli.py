#!/usr/bin/env python3
"""Bounded operator CLI for the same-host recovery ledger."""

from __future__ import annotations

import argparse
from dataclasses import asdict
import json
import os
from pathlib import Path
import sys
import time
from typing import Any

from recovery_config import (
    RecoveryConfig,
    RecoveryConfigError,
    load_recovery_config,
    recovery_static_policy,
)
from recovery_ledger import LedgerError, RecoveryLedger
from recovery_supervisor import (
    CorrelationRule,
    IncidentCoordinator,
    RecoveryControls,
    RecoveryNotificationOutbox,
    RecoveryPolicy,
    RecoveryProcessor,
    RecoveryVerifier,
    BoundedPolicyAdapter,
    safe_field,
)


MAX_LIST_LIMIT = 100
MAX_TTL_SECONDS = 31 * 86_400


def _json(value: Any) -> None:
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True))


def _positive_id(value: str) -> int:
    parsed = int(value)
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _bounded_limit(value: str) -> int:
    parsed = int(value)
    if not 1 <= parsed <= MAX_LIST_LIMIT:
        raise argparse.ArgumentTypeError(f"must be between 1 and {MAX_LIST_LIMIT}")
    return parsed


def _ttl(value: str) -> float:
    parsed = float(value)
    if not 1 <= parsed <= MAX_TTL_SECONDS:
        raise argparse.ArgumentTypeError(f"must be between 1 and {MAX_TTL_SECONDS}")
    return parsed


def _safe_text(value: str, name: str, limit: int) -> str:
    if safe_field(value, limit=limit, default="") != value:
        raise ValueError(f"recovery {name} is invalid")
    return value


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage same-host minime recovery")
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--config", default="recovery.json")
    sub = parser.add_subparsers(dest="command", required=True)

    config = sub.add_parser("config")
    config.add_subparsers(dest="action", required=True).add_parser("validate")
    sub.add_parser("status")

    for name in ("incidents", "invocations"):
        inspect = sub.add_parser(name)
        inspect.add_argument("--id", type=_positive_id)
        inspect.add_argument("--limit", type=_bounded_limit, default=25)

    dispatch = sub.add_parser("dispatch")
    dispatch.add_argument("state", choices=("enable", "disable"))
    dispatch.add_argument("--ttl", type=_ttl)
    _operator_options(dispatch)

    controls = sub.add_parser("controls")
    controls.add_argument("control", choices=("confirmation-count", "cooldown", "retry-budget"))
    controls.add_argument("value", type=float)
    controls.add_argument("--ttl", type=_ttl)
    _operator_options(controls)

    silence = sub.add_parser("silence")
    silence.add_argument("incident_key")
    silence.add_argument("--ttl", type=_ttl, required=True)
    _operator_options(silence)

    retry = sub.add_parser("retry")
    retry.add_argument("incident_id", type=_positive_id)
    _operator_options(retry)

    policy = sub.add_parser("policy")
    policy_sub = policy.add_subparsers(dest="action", required=True)
    history = policy_sub.add_parser("history")
    history.add_argument("--limit", type=_bounded_limit, default=25)
    rollback = policy_sub.add_parser("rollback")
    rollback.add_argument("revision", type=_positive_id)
    _operator_options(rollback)

    for decision in ("approve", "reject"):
        approval = sub.add_parser(decision)
        approval.add_argument("invocation_id", type=_positive_id)
        _operator_options(approval)

    digest = sub.add_parser("digest")
    digest.add_argument("action", choices=("preview",))
    digest.add_argument("--window", type=_ttl, default=86_400)

    process = sub.add_parser("process")
    process.add_argument("--once", action="store_true", required=True)
    return parser


def _operator_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--actor", required=True)
    parser.add_argument("--reason", required=True)


def _config(args: argparse.Namespace) -> RecoveryConfig:
    workspace = Path(args.workspace).resolve()
    raw_path = Path(args.config)
    path = raw_path if raw_path.is_absolute() else workspace / raw_path
    return load_recovery_config(path, workspace)


def _policy(config: RecoveryConfig, revision: int = 1) -> RecoveryPolicy:
    return RecoveryPolicy(
        revision=revision,
        rules=tuple(
            CorrelationRule(
                component=str(rule["component"]),
                failure_class=str(rule["failureClass"]),
                incident_key=str(rule["incidentKey"]),
                impact=int(rule["impact"]),
            )
            for rule in config.correlation_rules
        ),
    )


def _rows(rows: Any) -> list[dict[str, Any]]:
    return [{key: row[key] for key in row.keys()} for row in rows]


def _status(ledger: RecoveryLedger, controls: RecoveryControls, config: RecoveryConfig) -> dict[str, Any]:
    snapshot = controls.current()
    connection = ledger.connection
    return {
        "mode": config.mode,
        "database": str(config.database),
        "emergencyDeliveryConfigured": bool(
            os.environ.get("MINIME_TELEGRAM_CHAT_ID", "").strip()
            and os.environ.get("MINIME_TELEGRAM_SOPS_FILE", "").strip()
            and os.environ.get("MINIME_TELEGRAM_SOPS_KEY", "").strip()
        ),
        "controls": asdict(snapshot),
        "counts": {
            "events": connection.execute("SELECT count(*) FROM events").fetchone()[0],
            "incidents": connection.execute("SELECT count(*) FROM incidents").fetchone()[0],
            "activeInvocations": connection.execute(
                "SELECT count(*) FROM invocations WHERE state = 'active'"
            ).fetchone()[0],
            "pendingNotifications": connection.execute(
                "SELECT count(*) FROM notification_outbox WHERE delivered_at IS NULL"
            ).fetchone()[0],
        },
    }


def _inspect(ledger: RecoveryLedger, table: str, identifier: int | None, limit: int) -> list[dict[str, Any]]:
    if table not in {"incidents", "invocations"}:
        raise ValueError("recovery inspection target is invalid")
    columns = (
        "id, correlation_key, state, generation, evidence_hash, policy_revision, opened_at, updated_at"
        if table == "incidents"
        else "id, incident_id, generation, evidence_hash, policy_revision, state, created_at, updated_at"
    )
    if identifier is None:
        rows = ledger.connection.execute(
            f"SELECT {columns} FROM {table} ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    else:
        rows = ledger.connection.execute(
            f"SELECT {columns} FROM {table} WHERE id = ?", (identifier,)
        ).fetchall()
    return _rows(rows)


def _operator(args: argparse.Namespace) -> tuple[str, str]:
    return (
        _safe_text(args.actor, "actor", 80),
        _safe_text(args.reason, "reason", 160),
    )


def _approval(
    ledger: RecoveryLedger,
    controls: RecoveryControls,
    invocation_id: int,
    approved: bool,
    actor: str,
    reason: str,
) -> int:
    now = time.time()
    with ledger.transaction() as connection:
        invocation = connection.execute(
            "SELECT * FROM invocations WHERE id = ?", (invocation_id,)
        ).fetchone()
        if invocation is None or invocation["state"] != "pending_approval":
            raise ValueError("recovery invocation is not pending approval")
        incident = connection.execute(
            "SELECT * FROM incidents WHERE id = ?", (invocation["incident_id"],)
        ).fetchone()
        if incident is None or incident["state"] != "pending_approval":
            raise ValueError("recovery incident is not pending approval")
        frozen = connection.execute(
            "SELECT value FROM metadata WHERE key = ?",
            (f"invocation:{invocation_id}:plan",),
        ).fetchone()
        if frozen is None:
            raise ValueError("recovery invocation has no frozen plan")
        try:
            frozen_plan = json.loads(str(frozen["value"]))
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ValueError("recovery invocation frozen plan is invalid") from exc
        if not isinstance(frozen_plan, dict) or frozen_plan.get("invocationId") != invocation_id:
            raise ValueError("recovery invocation frozen plan is invalid")
        control = controls.current(connection, now=now)
        if (
            incident["policy_revision"] != control.revision
            or invocation["policy_revision"] != control.revision
            or incident["generation"] != invocation["generation"]
            or incident["evidence_hash"] != invocation["evidence_hash"]
        ):
            raise ValueError("recovery approval fence is stale")
        row = controls._current_row(connection)
        document = controls._document(row)
        after_state = "handoff_approved" if approved else "handoff_rejected"
        revision = controls.append_revision(
            connection,
            document,
            operation="approval_decision",
            target=f"invocation:{invocation_id}",
            actor=actor,
            reason=reason,
            expires_at=None,
            before={"decision": "pending", "state": "pending_approval"},
            after={"decision": "approved" if approved else "rejected", "state": after_state},
            now=now,
            effective=False,
        )
        connection.execute(
            "UPDATE incidents SET state = ?, updated_at = ? WHERE id = ?",
            (after_state, now, incident["id"]),
        )
        connection.execute(
            "UPDATE invocations SET state = ?, updated_at = ? WHERE id = ?",
            ("approved" if approved else "rejected", now, invocation_id),
        )
        return revision


def _digest_preview(ledger: RecoveryLedger, window: float) -> dict[str, Any]:
    end = time.time()
    start = end - window
    connection = ledger.connection
    states = {
        str(row["state"]): int(row["count"])
        for row in connection.execute(
            "SELECT state, count(*) AS count FROM incidents GROUP BY state ORDER BY state"
        ).fetchall()
    }
    return {
        "kind": "digest",
        "version": 1,
        "windowStart": start,
        "windowEnd": end,
        "counts": {
            "events": connection.execute(
                "SELECT count(*) FROM events WHERE received_at >= ? AND received_at < ?", (start, end)
            ).fetchone()[0],
            "invocations": connection.execute(
                "SELECT count(*) FROM invocations WHERE created_at >= ? AND created_at < ?", (start, end)
            ).fetchone()[0],
            "recoveries": connection.execute(
                "SELECT count(*) FROM audit WHERE operation = 'verification_recovered' "
                "AND occurred_at >= ? AND occurred_at < ?", (start, end)
            ).fetchone()[0],
        },
        "incidentStates": states,
    }


def run(args: argparse.Namespace) -> int:
    config = _config(args)
    if args.command == "config":
        _json({
            "ok": True,
            "mode": config.mode,
            "config": str(config.path),
            "runbooks": len(config.runbooks),
            "probes": len(config.probes),
        })
        return 0

    with RecoveryLedger(config.database) as ledger:
        controls = RecoveryControls(ledger)
        static_policy = recovery_static_policy(config)
        revision = (
            controls.ensure_static_policy(static_policy)
            if args.command == "process"
            else controls.current().revision
        )
        coordinator = IncidentCoordinator(
            ledger,
            _policy(config, revision),
            owner="recovery-cli",
            controls=controls,
            mode=config.mode,
            static_policy=static_policy if args.command == "process" else None,
        )
        if args.command == "status":
            _json(_status(ledger, controls, config))
        elif args.command in {"incidents", "invocations"}:
            _json(_inspect(ledger, args.command, args.id, args.limit))
        elif args.command == "dispatch":
            actor, reason = _operator(args)
            expiry = None if args.ttl is None else time.time() + args.ttl
            revision = controls.set_dispatch(
                args.state == "enable", actor=actor, reason=reason, expires_at=expiry
            )
            _json({"ok": True, "revision": revision})
        elif args.command == "controls":
            actor, reason = _operator(args)
            expiry = None if args.ttl is None else time.time() + args.ttl
            if args.control == "confirmation-count":
                if not args.value.is_integer():
                    raise ValueError("recovery confirmation count is invalid")
                revision = controls.set_confirmation_count(
                    int(args.value), actor=actor, reason=reason, expires_at=expiry
                )
            elif args.control == "cooldown":
                revision = controls.set_cooldown(
                    args.value, actor=actor, reason=reason, expires_at=expiry
                )
            else:
                if not args.value.is_integer():
                    raise ValueError("recovery retry budget is invalid")
                revision = controls.set_retry_budget(
                    int(args.value), actor=actor, reason=reason, expires_at=expiry
                )
            _json({"ok": True, "revision": revision})
        elif args.command == "silence":
            actor, reason = _operator(args)
            revision = controls.silence(
                _safe_text(args.incident_key, "silence target", 160),
                actor=actor,
                reason=reason,
                expires_at=time.time() + args.ttl,
            )
            _json({"ok": True, "revision": revision})
        elif args.command == "retry":
            actor, reason = _operator(args)
            if not coordinator.explicit_retry(args.incident_id, actor=actor, reason=reason):
                raise ValueError("recovery incident is not eligible for explicit retry")
            _json({"ok": True})
        elif args.command == "policy" and args.action == "history":
            rows = ledger.connection.execute(
                "SELECT revision, created_at, actor, reason FROM policy_revisions "
                "ORDER BY revision DESC LIMIT ?", (args.limit,)
            ).fetchall()
            _json(_rows(rows))
        elif args.command == "policy" and args.action == "rollback":
            actor, reason = _operator(args)
            _json({"ok": True, "revision": controls.rollback(args.revision, actor=actor, reason=reason)})
        elif args.command in {"approve", "reject"}:
            actor, reason = _operator(args)
            revision = _approval(
                ledger, controls, args.invocation_id, args.command == "approve", actor, reason
            )
            _json({"ok": True, "revision": revision, "decision": args.command})
        elif args.command == "digest":
            _json(_digest_preview(ledger, args.window))
        elif args.command == "process":
            active = coordinator.reconcile()
            controls.expire()
            RecoveryNotificationOutbox(ledger).queue_periodic()
            verifier = RecoveryVerifier(
                ledger,
                coordinator,
                probe_ids=tuple(str(probe["id"]) for probe in config.probes),
                source_ids=config.source_ids,
            )
            adapter = BoundedPolicyAdapter(ledger, controls)
            processing = RecoveryProcessor(config, coordinator, verifier, adapter).process_once()
            _json({"ok": True, "mode": config.mode, "activeIncidents": active, **processing})
        else:
            raise ValueError("unknown recovery command")
    return 0


def main(argv: list[str] | None = None) -> int:
    try:
        try:
            args = _parser().parse_args(argv)
        except SystemExit as exc:
            return int(exc.code)
        return run(args)
    except (RecoveryConfigError, LedgerError, ValueError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
