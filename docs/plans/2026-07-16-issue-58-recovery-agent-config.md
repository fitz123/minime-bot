# Issue #58 recovery agent config isolation hotfix

## Goal

Allow the recovery fixer runner to resolve its configured internal agent from a secret-backed bot configuration without materializing unrelated transport credentials. Preserve full agent/config validation, the sanitized runner environment, and the existing recovery safety boundary.

## Context

A production-equivalent diagnose drill showed that the fixer-session runner exits before Pi session binding: `resolveRecoveryAgent()` calls the full config loader with secret resolution enabled even though it only needs agent metadata. The supervisor intentionally strips secret-resolution variables from the runner environment, so unrelated transport credential resolution fails before Pi can start.

## Validation Commands

```bash
npm test -- --runInBand
npm run lint
npm run build
npm pack --dry-run
python3 -B scripts/tests/test_recovery_supervisor.py
```

## Tasks

### Task 1: Decouple recovery-agent lookup from transport secret materialization
- [x] Update `src/recovery/fixer-session.ts` so recovery-agent lookup validates merged configuration and the selected agent without resolving configured transport credentials.
- [x] Preserve rejection of missing/invalid agents, models, workspaces, bindings, and other configuration errors; do not pass secret-resolution environment variables into the runner.
- [x] Add focused tests proving a secret-backed config resolves the internal recovery agent when credential material is unavailable and never invokes the secret resolver.
- [x] Run focused recovery fixer/session tests and fix all failures before continuing.

### Task 2: Verify packaged and host-native recovery compatibility
- [x] Run the TypeScript test suite, lint, and build.
- [x] Run Python recovery-supervisor tests.
- [x] Run package dry-run/install validation so the built fixer-session artifact contains the fix.
- [x] Confirm the diff contains no private paths, identifiers, destinations, credentials, or production payloads.

## Post-Completion

Open a sanitized issue-linked pull request, complete CI/Copilot review, merge, publish the next CalVer patch release, update the private package pin through its own PR, deploy through the canonical wrapper, and rerun the bounded diagnose gate before enabled-mode promotion.
