# Make Pi Cron Jobs Follow the Selected Agent Model

## Overview

Fix issue #66 by removing the package-level cron model pin and making every LLM cron use the effective model of its selected agent. Context assembly and the Pi print-mode subprocess must receive the same resolved model. This change intentionally does not add a per-cron model override.

## Context

- `src/cron-runner.ts` currently hard-codes `PI_CRON_MODEL` both in the cron `AgentConfig` and in the Pi `--model` argument.
- `resolveCronAgentData()` already validates the selected agent but drops its `model` while preserving its workspace, system prompt, and thinking level.
- `src/config.ts` requires an explicit agent model but currently accepts an empty string.
- `src/pi-rpc-protocol.ts` provides the canonical `normalizePiModel()` behavior used by interactive Pi sessions.
- Existing focused coverage lives in `src/__tests__/cron-runner.test.ts` and `src/__tests__/cron-runner-pi.test.ts`.

## Development Approach

- **Testing approach:** regression tests alongside the focused implementation.
- Keep the model resolution path small and reuse the existing Pi model normalization helper.
- Do not add cron schema/configuration fields or a per-cron override.
- Complete each task fully and keep all tests green before proceeding.

## Testing Strategy

- Unit tests prove that changing the selected agent model changes the cron agent config.
- Spawn tests prove the exact same resolved model reaches context assembly and Pi `--model`.
- Validation tests prove missing or blank effective models fail instead of falling back.
- Full test, build, lint/typecheck, and package dry-run cover integration and packaging.

## Implementation Steps

### Task 1: Propagate the selected agent model through cron execution
- [x] Extend cron agent data to carry the selected agent's required effective model.
- [x] Normalize the configured Pi model with the shared runtime helper and remove `PI_CRON_MODEL`.
- [x] Use the resolved cron agent model consistently for context assembly and Pi spawn arguments.
- [x] Reject blank agent model strings through shared configuration validation.
- [x] Update focused config/cron-runner tests for model propagation, normalization, spawn consistency, and blank-model rejection.
- [x] Add a concise documentation note that LLM crons inherit their selected agent's model and have no implicit package pin.
- [x] Run the focused cron-runner and configuration tests; fix all failures before Task 2.

### Task 2: Verify issue #66 acceptance criteria and package integrity
- [x] Verify changing one agent model changes only cron runs selecting that agent.
- [x] Verify context assembly and Pi spawn receive the same resolved model.
- [x] Verify no unconditional cron model constant or stale documentation remains.
- [x] Run the full unit test suite.
- [x] Run build and typecheck/lint validation.
- [x] Run `npm pack --dry-run` and inspect the result.
- [x] Review `git diff --stat main...HEAD` and confirm the diff is limited to issue #66.

## Technical Details

Expected flow after the fix:

1. The merged config validates the selected agent and its explicit non-blank model.
2. Cron agent resolution normalizes that model through the same helper used by interactive Pi sessions.
3. The normalized model is stored in the cron `AgentConfig` used by context assembly.
4. Pi spawn arguments use `agent.model` from that same object rather than a second source.

A per-cron model override is out of scope. If introduced later, it requires explicit schema validation and documented precedence over the agent model.

## Post-Completion

- Open a pull request that closes issue #66.
- Release and deploy through the standard package workflow after CI and review are clean.
