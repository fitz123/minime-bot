# Plan: Hard-cut control vs agent workspace environment names

## Goal

Fix the ambiguous workspace environment contract after the package split with a **hard cutover** to explicit canonical names:

- `MINIME_CONTROL_WORKSPACE_ROOT` — control/app workspace for config, crons, runtime state, package install, and global secret files.
- `MINIME_AGENT_WORKSPACE_ROOT` — agent workspace whose context, Knowledge v2 wiki, and guard scope are being operated on.

Public issue: fitz123/minime-bot#10.

## Non-negotiable Requirement

No transition/compatibility alias period.

Remove package use of the old ambiguous env names instead of accepting or setting both:

- remove/stop accepting `MINIME_WORKSPACE_ROOT`
- remove/stop accepting `MINIME_AGENT_WORKSPACE_CWD`

The currently installed production package can keep running with the old contract until an explicit deploy. The new package version itself must not carry a dual-name compatibility layer.

## Context

Relevant package files:

- `src/workspace-contract.ts`
  - currently exports `MINIME_WORKSPACE_ROOT_ENV` and `MINIME_AGENT_WORKSPACE_CWD_ENV`.
  - `MINIME_WORKSPACE_ROOT_ENV` is semantically a control workspace root but has an ambiguous name.
  - `WorkspaceContractPaths.workspaceRoot` is an internal backwards-compatible property alias for `controlWorkspaceRoot`; this property may remain only if removing it causes excessive unrelated churn, but comments/docs must make it clear that the real concept is `controlWorkspaceRoot`.
- `src/pi-rpc-protocol.ts`
  - Pi child env allowlist includes the old env names.
  - `buildAllowedPiChildEnv` sets `MINIME_WORKSPACE_ROOT` and `MINIME_AGENT_WORKSPACE_CWD`.
- `src/pi-extensions/tavily-secret.ts`
  - web/Tavily secret lookup reads `MINIME_WORKSPACE_ROOT` as control workspace.
- `src/pi-extensions/knowledge-tools.ts`
  - Knowledge tools read `MINIME_AGENT_WORKSPACE_CWD` as the agent workspace root.
- `src/cli.ts`, `README.md`, installed-package smoke tests, cron tests, and package install tests contain old wording/assertions.

Important constraints:

- No plaintext secrets in env; only non-secret path values.
- Do not preserve legacy env lookup in the new package code.
- Do not set legacy env vars from bot-spawned Pi children.
- Do not change actual workspace directory layout.
- Do not restart or deploy production from this PR.
- Keep public package docs sanitized and generic; no private local paths.

## Design Requirements

1. Replace env constants in `src/workspace-contract.ts`:
   - `MINIME_CONTROL_WORKSPACE_ROOT_ENV = "MINIME_CONTROL_WORKSPACE_ROOT"`
   - `MINIME_AGENT_WORKSPACE_ROOT_ENV = "MINIME_AGENT_WORKSPACE_ROOT"`

2. Remove old exported env constants or stop exporting/using them:
   - no `MINIME_WORKSPACE_ROOT_ENV` constant in package code
   - no `MINIME_AGENT_WORKSPACE_CWD_ENV` constant in package code
   - no lookup helpers that fall back to legacy names

3. Env semantics:
   - CLI `--workspace` wins for control workspace.
   - `MINIME_CONTROL_WORKSPACE_ROOT` is the only env fallback for control workspace.
   - `MINIME_AGENT_WORKSPACE_ROOT` is the only env fallback for agent workspace.
   - Existing explicit function args still win over env for Knowledge helpers.
   - If only old env names are present, code should behave as if the relevant env is absent.

4. Bot-spawned Pi children should set only canonical names:
   - `MINIME_CONTROL_WORKSPACE_ROOT`
   - `MINIME_AGENT_WORKSPACE_ROOT` when an agent workspace is known
   - delete stale inherited old and canonical agent env names before setting the current value.

5. Web/Tavily extension should resolve the control workspace using only `MINIME_CONTROL_WORKSPACE_ROOT`.

6. Knowledge tools and CLI knowledge commands should resolve the agent workspace using only `MINIME_AGENT_WORKSPACE_ROOT`. Fallback warnings should mention only the canonical name.

7. README/help/docs should define the four entities clearly:
   - control/app workspace
   - agent workspace
   - package source checkout
   - package runtime install

8. Tests should prove hard-cut behavior:
   - canonical env names work
   - old env names are not accepted
   - Pi child env contains canonical names and does not contain old names
   - installed-package smoke validates canonical names only

## Tasks

### Task 1: Workspace contract constants and resolver

- [x] Replace old env constants with canonical constants.
- [x] Update control workspace resolver to use only `MINIME_CONTROL_WORKSPACE_ROOT`.
- [x] Update warnings/comments to say "control workspace" instead of ambiguous "workspace root" where relevant.
- [x] Add tests for canonical control env and old-env ignored behavior.

### Task 2: Pi child env contract

- [ ] Add canonical env names to the Pi child env allowlist.
- [ ] Remove old env names from the Pi child env allowlist.
- [ ] Update `buildAllowedPiChildEnv` to delete stale inherited old and canonical agent envs, then set only the canonical current value.
- [ ] Set only canonical control workspace env from the resolved contract.
- [ ] Update tests for parent Pi, subagent child Pi, and cron Pi envs.

### Task 3: Knowledge and web extension lookup

- [ ] Update Tavily control workspace lookup to use only canonical control env.
- [ ] Update Knowledge agent workspace lookup to use only canonical agent env.
- [ ] Update CLI knowledge command env fallback similarly.
- [ ] Add/adjust tests proving canonical-only works and old env names are ignored.

### Task 4: Docs/help/package install smoke

- [ ] Update `README.md` and CLI help text.
- [ ] Update installed-package smoke assertions to check canonical names and absence of old names.
- [ ] Update project naming/static tests if they whitelist env names.
- [ ] Search the package for old env names and remove remaining runtime/doc/test references except historical completed plans if intentionally left archived.

### Task 5: Validation

- [ ] Run focused tests:
  - `node --test dist/__tests__/workspace-contract.test.js dist/__tests__/pi-rpc-protocol.test.js dist/__tests__/knowledge-pi-extension.test.js dist/__tests__/tavily.test.js dist/__tests__/cli.test.js` after build, or the repo's equivalent focused workflow.
- [ ] Run full package validation:
  - `npm test`
  - `npm run build`
  - `npm pack --dry-run`

## Private follow-up after PR merge and explicit deploy approval

The private TUI env extension must be updated atomically with the package deploy:

- `~/.pi/agent/extensions/minime-tui-runtime-env.js` should set `MINIME_CONTROL_WORKSPACE_ROOT` and `MINIME_AGENT_WORKSPACE_ROOT` only.
- Remove old env names from private Pi/TUI docs and artifacts where they are current operational instructions.

This follow-up is private workspace work and should be tracked in bead `workspace-841v`; do not deploy or restart without Ninja's explicit confirmation.
