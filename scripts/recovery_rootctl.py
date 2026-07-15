#!/usr/bin/env python3
"""Zero-capability ordinary-user scaffold for future privileged recovery.

Phase 1 deliberately has no listener, helper, installer, or executable
capability. The process accepts one bounded JSON request on stdin so the
identity, fence, idempotency, UID, and rate contract can be tested without
creating a privilege boundary that does not yet exist.
"""

from __future__ import annotations

import json
import math
import os
import re
import sys
from typing import Any


MAX_REQUEST_BYTES = 64 * 1024
CAPABILITY_REGISTRY: frozenset[str] = frozenset()
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_SHA256 = re.compile(r"^[a-f0-9]{64}$")
_REQUEST_KEYS = {
    "capabilityId",
    "incidentId",
    "idempotencyKey",
    "activeFence",
    "currentUid",
    "peerUid",
    "rateLimit",
}
_FENCE_KEYS = {
    "invocationId",
    "incidentId",
    "generation",
    "evidenceHash",
    "policyRevision",
    "leaseToken",
    "expiresAt",
}
_RATE_KEYS = {
    "now",
    "windowStartedAt",
    "windowSeconds",
    "attempts",
    "maxAttempts",
}


class RootctlRequestError(ValueError):
    """The closed rootctl request contract was not satisfied."""


def _object(value: Any, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise RootctlRequestError("invalid_request")
    return value


def _positive_integer(value: Any, *, maximum: int = 2**63 - 1) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= maximum
    ):
        raise RootctlRequestError("invalid_request")
    return value


def _nonnegative_integer(value: Any, *, maximum: int = 2**31 - 1) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= maximum
    ):
        raise RootctlRequestError("invalid_request")
    return value


def _timestamp(value: Any) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value < 0
    ):
        raise RootctlRequestError("invalid_request")
    return float(value)


def validate_request(value: Any, *, current_uid: int | None = None) -> dict[str, Any]:
    """Validate the exact inert protocol and return a normalized copy."""

    request = _object(value, _REQUEST_KEYS)
    capability_id = request["capabilityId"]
    idempotency_key = request["idempotencyKey"]
    if (
        not isinstance(capability_id, str)
        or _SAFE_ID.fullmatch(capability_id) is None
        or not isinstance(idempotency_key, str)
        or _SAFE_ID.fullmatch(idempotency_key) is None
    ):
        raise RootctlRequestError("invalid_request")
    incident_id = _positive_integer(request["incidentId"])
    expected_uid = os.getuid() if current_uid is None else current_uid
    supplied_uid = _nonnegative_integer(request["currentUid"])
    peer_uid = _nonnegative_integer(request["peerUid"])
    if supplied_uid != expected_uid or peer_uid != expected_uid:
        raise RootctlRequestError("uid_mismatch")

    fence = _object(request["activeFence"], _FENCE_KEYS)
    if _positive_integer(fence["incidentId"]) != incident_id:
        raise RootctlRequestError("fence_mismatch")
    for key in ("invocationId", "generation", "policyRevision"):
        _positive_integer(fence[key])
    if (
        not isinstance(fence["evidenceHash"], str)
        or _SHA256.fullmatch(fence["evidenceHash"]) is None
        or not isinstance(fence["leaseToken"], str)
        or _SAFE_ID.fullmatch(fence["leaseToken"]) is None
    ):
        raise RootctlRequestError("invalid_request")

    rate = _object(request["rateLimit"], _RATE_KEYS)
    now = _timestamp(rate["now"])
    started = _timestamp(rate["windowStartedAt"])
    window = _positive_integer(rate["windowSeconds"], maximum=3_600)
    attempts = _nonnegative_integer(rate["attempts"], maximum=100)
    maximum = _positive_integer(rate["maxAttempts"], maximum=100)
    expires_at = _timestamp(fence["expiresAt"])
    if (
        started > now
        or now - started >= window
        or attempts >= maximum
        or expires_at <= now
    ):
        raise RootctlRequestError("inactive_fence_or_rate_limit")
    return json.loads(json.dumps(request, ensure_ascii=True))


def evaluate_request(value: Any, *, current_uid: int | None = None) -> dict[str, Any]:
    request = validate_request(value, current_uid=current_uid)
    capability_id = str(request["capabilityId"])
    if capability_id not in CAPABILITY_REGISTRY:
        return {
            "ok": False,
            "status": "unsupported_capability",
            "capabilityId": capability_id,
        }
    # The phase-1 registry is immutable and empty. Keeping this fail-closed
    # branch explicit prevents future callers from treating validation as
    # execution authority.
    raise RootctlRequestError("capability_registry_invariant")


def main() -> int:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if len(raw) > MAX_REQUEST_BYTES:
        print('{"ok":false,"status":"invalid_request"}')
        return 2
    try:
        value = json.loads(raw)
        response = evaluate_request(value)
    except (UnicodeError, json.JSONDecodeError, RootctlRequestError):
        print('{"ok":false,"status":"invalid_request"}')
        return 2
    print(json.dumps(response, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
    return 3


if __name__ == "__main__":
    raise SystemExit(main())
