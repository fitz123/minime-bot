# Ops-worker core (PR 1)

The ops worker is an opt-in, inactive-by-default core. Installing or starting
`minime-bot` does not start it. PR 1 provides durable task snapshots, one
single-instance supervisor, ordinary Pi session continuation, deterministic
done checks, a local CLI skeleton, and read-only loopback health/status. Each
attempt receives the agent workspace's assembled context bundle plus the fixed
ops-worker policy; Pi's flat context loading is disabled only after assembly
succeeds, avoiding both missing rules and duplicate context.

The installed PR-1 binary registers no task templates, authorization profiles,
or done checks. Submission and start define the adapter-facing contract but
cannot execute production work until trusted package code registers all three.
Each trusted authorization profile fixes both its scopes and Pi tool allowlist;
task input cannot select commands, executables, URLs, models, tools, or scopes.

## Commands

All commands require an explicit state directory. Starting the supervisor also
requires an explicit agent workspace:

```text
minime-bot worker start --state-dir "$STATE_DIR" --agent-workspace "$AGENT_WORKSPACE"
minime-bot worker status --state-dir "$STATE_DIR"
minime-bot worker list --state-dir "$STATE_DIR"
minime-bot worker inspect --state-dir "$STATE_DIR" --id <task-id>
minime-bot worker submit --state-dir "$STATE_DIR" \
  --template <registered-template> \
  --authorization <registered-profile> \
  --done-check <registered-check> \
  [--done-check-params '<registered-parameters-json>'] \
  --correlation-key <source-correlation-key> \
  --objective <bounded-objective>
minime-bot worker retry --state-dir "$STATE_DIR" --id <task-id>
minime-bot worker cancel --state-dir "$STATE_DIR" --id <task-id> --reason <reason>
```

`worker start --once` performs at most one eligible scheduler action and exits.
Without `--once`, it runs until SIGINT or SIGTERM. The package-owned Pi
invocation, model/tool flags, authorization scope, remediation budget, task
priority, and source kind are not task-supplied CLI options.

`worker start` also accepts `--host` (only `127.0.0.1` or `::1`) and `--port`
(an integer from 0 through 65535). Omitted done-check parameters default to an
empty object. `status`, `list`, `inspect`, `submit`, `retry`, and `cancel`
accept `--json` for machine-readable output.

Submission creates an authoritative `tasks/<id>.json` snapshot before success
is reported. `retry` and `cancel` acquire the supervisor's single-instance
guard and therefore fail safely if the long-running supervisor is active;
live control transport is not part of the PR-1 skeleton. A running task cannot
be cancelled without its owning supervisor first proving and stopping the
process group.

An ambiguous process-group identity is a global safety fence: its task retains
any proven identity evidence, no new Pi attempt is launched, and ordinary retry
or cancellation is rejected until restart reconciliation proves the group gone.

## Loopback status

The supervisor binds to `127.0.0.1:9465` by default. Only `127.0.0.1` and `::1`
are accepted bind addresses. The surface is read-only:

- `GET /healthz` returns process health.
- `GET /status` returns bounded task-state counts and the number of active
  process groups.

There is no HTTP task intake, retry, cancellation, command, or arbitrary proxy
route in PR 1. CLI submission writes through the strict local task store.

## Deferred work

Alertmanager intake, authenticated HTTP intake, Telegram reporting, report
transport retries, production telemetry, production task templates and done
checks, the full fault lab, deployment configuration, launch activation,
release workflows, and production drills are PR 2 or later. Existing recovery
components remain in place during coexistence.
