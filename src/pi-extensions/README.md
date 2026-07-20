# pi-extensions

Pure, testable helpers for Pi extension wrappers.

Most helpers here back the live Pi extensions:

- `web-tools` for subscription-backed Codex `web_search`.
- `knowledge-tools` for `knowledge_search`, `knowledge_get`, `knowledge_update`,
  and scoped protection for managed Knowledge v2 wiki files.
- `subagent` for delegated child Pi runs.
- `ask-agent` for configured full-agent inter-agent questions.
- `codex-usage` for bounded Codex quota capture and persistence.
- `ops-worker-parity-attestation` for the ops-only, before-provider context and
  capability handshake.

There are no `memory_*` Pi tool aliases. The package exposes the canonical
Knowledge tool names only, and the scoped protection exists only to keep managed
Knowledge v2 wiki files consistent with `knowledge_update`.

The standalone `extensions/pi/codex-usage.ts` wrapper is different: it is used
only by the out-of-band Codex quota sampler and must not be added to the normal
`PI_EXTENSION_WRAPPER_RELPATHS` list. The helper is also called by the
ops-worker-only parity wrapper to persist attempt-scoped response telemetry.
See
`docs/plans/completed/2026-06-01-pi-phase2-extensions.md` for A1-A3.

`PI_EXTENSIONS_DISABLED=1` disables every explicit extension for that spawn:
first-party wrappers and any configured `piExtraExtensions`. That deliberately
removes the Knowledge tools and also removes the scoped managed-wiki protection;
use it only as an operator bypass when a Pi session must start without package
extensions.

## Codex web search

The `web-tools` wrapper registers `web_search` once. Its pure helper resolves
refreshed OAuth and account identity from Pi's `openai-codex` model registry,
uses the active Codex model, and calls only the fixed subscription Responses
endpoint. It does not read an API-key environment variable, accept another
endpoint or provider, retry automatically, or keep provider-specific state.

The helper validates and bounds each query before egress. It parses streamed
answer text, citations, web actions, response identity, and usage into bounded
results, while failures expose only fixed classifications. Direct URL reading
and browser interaction belong to the host `agent-browser` CLI and are available
only to Bash-capable agents.

## Location lock (Task 0)

There are TWO kinds of files in this feature, deliberately split:

1. **Pure helpers — `bot/src/pi-extensions/*.ts`** (this directory).
   All real logic lives here: Codex web-search request/parse, ask-agent policy/result
   helpers, subagent spawn-arg/result helpers, and the sampler-only Codex
   quota cache/export helper. These files are:
   - **Type-checked by `tsc --noEmit`** (the `npm run lint` command) because the
     bot `tsconfig.json` `include` is `["src/**/*.ts"]`, which matches this path.
   - **Exercised by `npm test`** because the test glob is `src/__tests__/*.test.ts`
     and those tests `import` the helpers from `../pi-extensions/<name>.js`.

   Proven in Task 0 by a throwaway stub helper (`_smoke.ts`) + a sibling test
   (`__tests__/pi-extensions-smoke.test.ts`); both were removed in Task 4 once
   the real helpers (`codex-web-search.ts`, `subagent-args.ts`) made the coverage
   self-evident.

2. **Thin wrappers — `extensions/pi/<name>.ts`** (or `<name>/index.ts`
   for A3). Each is a minimal `export default function (pi) { ... }` that wires a
   Pi `pi.on(...)` / `pi.registerTool(...)` call to the pure helpers above. They
   are jiti-loaded by Pi at spawn via `--extension <abs-path>` in source
   development.

3. **Package artifacts — `dist/extensions/pi/`**. `npm run build` runs
   `scripts/build-package-artifacts.mjs`, which clears this generated directory,
   transpiles the first-party wrappers to `.js` with imports rewritten to compiled
   `dist/` helpers, and copies A3 bundled `agents/*.md` and `prompts/*.md`
   resources. Built and installed package runs load wrappers from this artifact
   directory.

## Type-check coverage for wrappers

The source `extensions/pi/` wrappers are checked by
`tsc -p tsconfig.extensions.json --noEmit` during `npm run build`. They remain
outside the `npm test` file glob; tests load important wrappers through their
public registration surface, while package builds transpile them into generated
runtime artifacts.

Rationale:
- They live outside `src/`, so the main tsconfig and test glob do not reach them;
  `tsconfig.extensions.json` supplies their separate type-check boundary.
- They are intentionally thin: all branching/parsing/error-handling that is worth
  type-checking and unit-testing is factored into the `src/pi-extensions/*.ts`
  helpers, which ARE covered. A wrapper should contain no logic a test would want
  to assert on.
- Source-checkout mode jiti-loads the checked wrappers; built/package mode loads
  generated JS from `dist/extensions/pi`. A broken wrapper fails loudly at load
  (fail-closed loading is handled by `resolvePiExtensionArgs`).

If a wrapper ever grows logic worth testing, move that logic into a
`src/pi-extensions/*.ts` helper rather than adding a tsconfig for the wrapper.

## Ops-worker parity resource loading

Ops-worker capability parity intentionally uses two production dependencies at
runtime. `typescript` performs deterministic AST inspection of each selected
extension's statically resolved local module closure; dynamic and reflective
module loading fails closed. The package-owned subagent manifest additionally
pins its bundled `agents/` and `prompts/` resources.
`jiti` loads the resulting private, read-only extension snapshots with fixed
package aliases and resolver settings, so extension-local replacements or
ambient Jiti configuration cannot change the executed dependency bytes.
`node:vm` is accepted only through one default binding used directly by
`createContext` and `new Script`, with loader-bearing options, aliases, computed
access, re-exports, and other VM APIs rejected. Bare `acorn` imports require
manifest-covered package metadata and a self-contained import entry with no
module-loading escape, then execute from a copied, layout-preserving
`node_modules` snapshot rather than ambient resolution. Skills are pinned as
bounded directory packages rather than as `SKILL.md` alone, excluding only exact
generated Python directory names `.venv`, `.pytest_cache`, and `__pycache__`;
near misses remain included and other symlinks fail closed.

## Context assembler (workspace context parity at spawn)

`bot/src/pi-context-assembler.ts` gives Pi spawns the same workspace context
bundle. Pi reads context files as FLAT text: no `@`-import expansion and no
`.claude/rules/` auto-load, so an agent's CLAUDE.md `@`-imports and rule files
silently vanish under Pi. The assembler reads the agent's LIVE workspace files
(zero drift, always fresh) and hands the result to Pi via CLI args. It is wired into
`buildPiSpawnArgs` in
`bot/src/pi-rpc-protocol.ts` for all live Pi RPC sessions, and `cron-runner.ts`
also calls it directly for LLM print-mode crons where `engine` may be omitted
or set to `pi`. For crons, the runner builds a minimal Pi agent from the
selected agent's `id`, `workspaceCwd`, normalized required `model`, and optional
`systemPrompt` and `thinking`. That same model reaches context assembly and Pi's
`--model` argument, while CLAUDE/MEMORY/rules context is injected via files.

### Layer mapping

| Pi CLI arg | Carries | Pi semantics |
|---|---|---|
| `--system-prompt <personaFile>` | The agent's persona: the resolved output-style content (`.claude/settings.local.json` `outputStyle` → `.claude/output-styles/<slug>.md`), plus the config `systemPrompt` appended if set. | REPLACES Pi's base "coding assistant" prompt. Omitted entirely when no persona resolves → the agent rides Pi's base prompt. |
| `--append-system-prompt <bundleFile>` | The context bundle (see order below). | APPENDED to the system prompt. |
| `--no-context-files` | — | Stops Pi from ALSO loading CLAUDE.md/AGENTS.md from cwd, so context is delivered once (no double context). |

Personas and bundles are delivered as FILE PATHS, never inline argv: keeps
non-ASCII persona text out of argv (avoids the content-filter class), keeps argv
short, and stays inspectable.

### Bundle order (deterministic)

The `--append-system-prompt` bundle is assembled in this exact order:

1. The CLAUDE.md body with every standalone `@<path>` line removed.
2. Each removed `@`-import expanded as a `## <relpath>` section, in the order the
   `@`-lines appeared (read relative to the CLAUDE.md dir, **1 level only** — a
   nested `@`-line inside an imported file is NOT recursed, only `log.warn`-ed).
3. For Knowledge v2 workspaces, `wiki/schema.md` and `wiki/index.md`.
4. Every `.claude/rules/platform/*.md` as a `## <relpath>` section, sorted.
5. Every `.claude/rules/custom/*.md` as a `## <relpath>` section, sorted.
6. A fixed `## Knowledge access` directive (verbatim).

The only out-of-workspace rules exception is a satellite
`.claude/rules/platform` symlink whose realpath exactly matches the configured
main agent workspace's contained `.claude/rules/platform` realpath. For that
case, rule-file reads and source-manifest signatures use the trusted platform
directory as the containment base. Do not generalize this to custom rules,
imports, output styles, knowledge files, arbitrary platform symlinks, or files
inside the trusted platform directory that resolve outside it.

In v2 workspaces, the assembler auto-loads `wiki/schema.md` and `wiki/index.md`
even when root `MEMORY.md` is absent. During legacy compatibility, MEMORY.md keeps
reaching the bundle through the existing CLAUDE.md `@MEMORY.md` import convention.
The fixed directive tells agents to use `knowledge_search`, `knowledge_get`, and
`knowledge_update` when the first-party Knowledge tools are available. If tools are
unavailable, agents should fall back to the visible index or direct reads and
report that limitation.

### Fail-safe, strict mode, manifest, and cache

- **Fail-safe:** every file read is wrapped — a missing/unreadable source is
  `log.warn`-ed and skipped, NEVER thrown. A total failure returns `null` so the
  caller degrades to a bare Pi spawn. The assembler must never break a spawn.
- **Strict ops-worker mode:** `assemblePiContext(..., { strict: true })` rejects
  unsafe, missing, or unreadable declared sources. Ops workers use this mode and
  write the artifacts into their separate execution workspace; they never fall
  back to a smaller prompt after a canonical primary-context failure.
- **Manifest:** every accepted source and the assembled persona/bundle contribute
  redacted SHA-256 identities to the returned manifest; no source body or private
  absolute path is persisted in parity evidence.
- **Cache:** artifacts are cached per agent and strictness mode, keyed on source
  content hashes (plus directory membership metadata). On a cache HIT the assembler
  skips re-parsing and re-assembling the sources, but still reads source bytes to
  prove freshness and STILL re-writes the `.tmp/`
  artifact files from the cached content — it never trusts a possibly-stale or
  tampered on-disk bundle (a gitignored `.tmp/` file a prior Pi session or external
  process could overwrite), and this also transparently recreates a deleted
  artifact. A touched source re-assembles (freshness parity).
- **Artifacts:** written atomically (staging file → `renameSync`) to stable
  per-agent paths under the selected artifact workspace's
  `.tmp/pi-context-<agentId>.{bundle,persona}.md`
  — stable path ⇒ no accumulation, no cleanup job.
