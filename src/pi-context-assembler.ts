import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type { AgentConfig } from "./types.js";
import { log } from "./logger.js";
import { resolveKnowledgeLayout } from "./knowledge/layout.js";
import { loadRawMergedConfig, resolveConfigWorkspaceRoot } from "./config.js";
import { resolveAgentWorkspaceCwd } from "./workspace-contract.js";

/**
 * Spawn-time context assembler for the Pi (`pi --mode rpc`, OpenAI Codex) path.
 *
 * Pi reads context files as FLAT text: no `@`-import expansion and no
 * `.claude/rules/` auto-load (verified in `@earendil-works/pi-coding-agent`
 * resource-loader/system-prompt). Without help, an agent's CLAUDE.md `@`-imports
 * and rule files silently vanish under Pi. This module assembles the same
 * workspace context convention from the agent's LIVE workspace files (zero drift),
 * and hands it to Pi via CLI args:
 *   --system-prompt          → the persona (REPLACES Pi's base prompt)
 *   --append-system-prompt   → the context bundle (APPENDED)
 *   --no-context-files       → so Pi does not ALSO load CLAUDE.md/AGENTS.md (no double context)
 *
 * Missing/unreadable sources are warned + skipped. Artifact-write failures are
 * deliberately allowed to throw so callers can fail closed by passing
 * `--no-context-files` without artifact args. Wiring into the spawn path is in
 * pi-rpc-protocol.ts.
 *
 * Deterministic bundle order (see {@link assembleBundle}):
 *   1. CLAUDE.md body with every `@<path>` line removed.
 *   2. Each removed `@`-import expanded as a `## <relpath>` section, in the order
 *      the `@`-lines appeared (read relative to the CLAUDE.md dir; 1 level only —
 *      a nested `@`-line in an imported file is NOT recursed, only warned).
 *   3. For Knowledge v2 workspaces, `wiki/schema.md` and `wiki/index.md`.
 *   4. Every `.claude/rules/platform/*.md` as a `## <relpath>` section, sorted.
 *   5. Every `.claude/rules/custom/*.md` as a `## <relpath>` section, sorted.
 *   6. A fixed `## Knowledge access` directive (verbatim {@link KNOWLEDGE_ACCESS_DIRECTIVE}).
 */

/** Resolved artifact paths handed to the Pi spawn (paths, not inline content). */
export interface PiContextArtifacts {
  /** Persona file for `--system-prompt`. Omitted when the agent has no persona. */
  systemPromptPath?: string;
  /** Context-bundle file for `--append-system-prompt`. Always present on success. */
  appendSystemPromptPath: string;
  /** Redacted deterministic identity of the accepted sources and assembled bytes. */
  manifest: PiContextManifest;
}

export const PI_CONTEXT_MANIFEST_VERSION = 1 as const;

export type PiContextSourceKind =
  | "workspace"
  | "knowledge"
  | "platform-rule"
  | "custom-rule"
  | "output-style"
  | "agent-config"
  | "package-directive";

/** A content-redacted source identity. No absolute path or source body is retained. */
export interface PiContextSourceManifest {
  kind: PiContextSourceKind;
  identity: string;
  contentHash: string;
}

/** Hash-only context evidence safe to persist or expose in bounded status output. */
export interface PiContextManifest {
  version: typeof PI_CONTEXT_MANIFEST_VERSION;
  sources: readonly PiContextSourceManifest[];
  bundleHash: string;
  personaHash: string | null;
  digest: string;
}

export interface PiContextAssemblyOptions {
  /** Private artifact destination. The context source workspace remains read-only. */
  artifactWorkspaceCwd?: string;
}

/** A `## <relpath>` bundle section: a header + the file's content. */
export interface ContextSection {
  relpath: string;
  content: string;
}

export type PiArtifactKind = "bundle" | "persona";

function safeArtifactAgentId(agentId: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(agentId)) {
    return agentId;
  }
  const stem = agentId
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const hash = createHash("sha256").update(agentId).digest("hex").slice(0, 12);
  return `${stem || "agent"}-${hash}`;
}

function ensurePrivateArtifactDir(path: string): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (err) {
    if ((err as { code?: string }).code !== "EEXIST") {
      throw err;
    }
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to use ${path}: it is a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to use ${path}: not a directory`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Refusing to use ${path}: owned by uid ${stat.uid}, expected ${process.getuid()}`);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    chmodSync(path, 0o700);
  }
}

/**
 * A standalone `@<path>` import line: optional leading whitespace, `@`, a single
 * non-whitespace path token, optional trailing whitespace, nothing else. This is
 * deliberately strict so an inline `user@host` or `@pkg/name` inside prose never
 * matches — only a line that IS an import (e.g. `@MEMORY.md`).
 *
 * The trailing `\r?` tolerates CRLF (Windows) line endings: bodies are split on
 * `\n`, so a CRLF line arrives as `@MEMORY.md\r`. Without this, that line would
 * match neither as an import (so it is never expanded) nor get stripped from the
 * body (so the literal `@MEMORY.md` text leaks into the bundle). `\S+` stops at
 * the `\r` (it is whitespace), so the captured path token stays clean.
 */
const IMPORT_LINE = /^[ \t]*@(\S+)[ \t]*\r?$/;

/**
 * The fixed `## Knowledge access` directive (verbatim). In v2 workspaces,
 * `wiki/schema.md` and `wiki/index.md` are auto-loaded below. During legacy
 * compatibility, MEMORY.md keeps reaching the bundle only through the existing
 * CLAUDE.md `@MEMORY.md` import convention.
 */
const KNOWLEDGE_ACCESS_DIRECTIVE = [
  "Use `knowledge_search` before answering about prior work, decisions, people, preferences, projects, health, dates, or \"what happened with X?\"",
  "",
  "- Use default scope for curated/current facts.",
  "- Use `diary` or `all` scope for chronology and history.",
  "- Use `knowledge_get` for exact source lines before important assertions.",
  "- Use `knowledge_update` for durable Knowledge v2 writes, not arbitrary file editing.",
  "- Put actionable work in Beads, not wiki pages.",
  "- If knowledge tools are unavailable, fall back to the visible index or direct reads and report the limitation.",
].join("\n");

/** Read a file, returning null on ANY error (fail-safe: missing/unreadable → skip). */
function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isResolvedPathContained(baseReal: string, targetReal: string): boolean {
  const rel = relative(baseReal, targetReal);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

function resolveContainedRealPath(targetPath: string, baseDir: string): { realPath: string | null; escaped: boolean } {
  try {
    const baseReal = realpathSync(baseDir);
    const targetReal = realpathSync(targetPath);
    if (!isResolvedPathContained(baseReal, targetReal)) {
      return { realPath: targetReal, escaped: true };
    }
    return { realPath: targetReal, escaped: false };
  } catch {
    return { realPath: null, escaped: false };
  }
}

/** Read a file only if its resolved target stays under the intended base dir. */
function safeReadContainedFile(
  targetPath: string,
  baseDir: string,
  options: { rejectSymlink?: boolean } = {},
): { content: string | null; escaped: boolean } {
  if (options.rejectSymlink) {
    try {
      if (lstatSync(targetPath).isSymbolicLink()) {
        return { content: null, escaped: false };
      }
    } catch {
      return { content: null, escaped: false };
    }
  }
  const resolved = resolveContainedRealPath(targetPath, baseDir);
  if (resolved.escaped || resolved.realPath === null) {
    return { content: null, escaped: resolved.escaped };
  }
  return { content: safeReadFile(resolved.realPath), escaped: false };
}

function sourceSignature(path: string, baseDir: string): string {
  const resolved = resolveContainedRealPath(path, baseDir);
  if (resolved.escaped) {
    try {
      const st = lstatSync(path);
      return `${path}:escaped:${st.mtimeMs}:${st.size}`;
    } catch {
      return `${path}:escaped`;
    }
  }
  if (resolved.realPath === null) {
    return `${path}:missing`;
  }
  try {
    const st = statSync(resolved.realPath);
    return `${path}->${resolved.realPath}:${st.mtimeMs}:${st.size}`;
  } catch {
    return `${path}:missing`;
  }
}

interface MarkdownSourceFile {
  path: string;
  baseDir: string;
}

function configuredMainPlatformRulesRealPath(): string | null {
  try {
    const raw = loadRawMergedConfig();
    const agents = raw.agents;
    if (typeof agents !== "object" || agents === null || Array.isArray(agents)) {
      return null;
    }
    const mainAgent = (agents as Record<string, unknown>).main;
    if (typeof mainAgent !== "object" || mainAgent === null || Array.isArray(mainAgent)) {
      return null;
    }
    const workspaceCwd = (mainAgent as Record<string, unknown>).workspaceCwd;
    if (typeof workspaceCwd !== "string" || workspaceCwd.trim() === "") {
      return null;
    }
    const mainWorkspace = resolveAgentWorkspaceCwd(resolveConfigWorkspaceRoot(), workspaceCwd);
    const mainWorkspaceReal = realpathSync(mainWorkspace);
    const platformRulesReal = realpathSync(join(mainWorkspace, ".claude", "rules", "platform"));
    return isResolvedPathContained(mainWorkspaceReal, platformRulesReal) ? platformRulesReal : null;
  } catch {
    return null;
  }
}

function trustedPlatformRulesRealPathForDirectoryRequest(
  dir: string,
  workspaceCwd: string,
  targetReal: string | null,
): string | null {
  if (resolve(dir) !== resolve(workspaceCwd, ".claude", "rules", "platform")) {
    return null;
  }
  const configuredPlatformReal = configuredMainPlatformRulesRealPath();
  if (targetReal === null || configuredPlatformReal === null) {
    return null;
  }
  return targetReal === configuredPlatformReal ? configuredPlatformReal : null;
}

/** List `*.md` files in a dir as absolute paths, sorted by name. Missing dir → []. */
function listMarkdown(dir: string, baseDir: string): MarkdownSourceFile[] {
  const resolved = resolveContainedRealPath(dir, baseDir);
  let realPath = resolved.realPath;
  let readBaseDir = baseDir;
  if (resolved.escaped) {
    const trustedRealPath = trustedPlatformRulesRealPathForDirectoryRequest(dir, baseDir, resolved.realPath);
    if (trustedRealPath === null) {
      log.warn("pi-context", `markdown directory resolves outside the workspace, skipping: ${dir}`);
      return [];
    }
    realPath = trustedRealPath;
    readBaseDir = trustedRealPath;
  }
  if (realPath === null) {
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(realPath);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ path: join(dir, name), baseDir: readBaseDir }));
}

/**
 * Single source of truth for parsing a body's `@`-import lines: returns the
 * non-import lines (in order) and the path tokens of every standalone `@<path>`
 * line (in order). Both expandImports (which expands them) and the manifest
 * signature (which stats them) use this, so the set of imports the cache tracks
 * can never drift from the set the bundle actually expands.
 */
function partitionImports(body: string): { keptLines: string[]; importRelpaths: string[] } {
  const keptLines: string[] = [];
  const importRelpaths: string[] = [];
  for (const line of body.split("\n")) {
    const match = IMPORT_LINE.exec(line);
    if (match) {
      importRelpaths.push(match[1]);
    } else {
      keptLines.push(line);
    }
  }
  return { keptLines, importRelpaths };
}

/** Render one `## <relpath>` section. Content is trimmed for stable spacing. */
function sectionMarkdown(relpath: string, content: string): string {
  return `## ${relpath}\n\n${content.trim()}`;
}

/**
 * True iff `relpath` resolves to a path CONTAINED under `baseDir` (the CLAUDE.md
 * dir). A workspace-controlled CLAUDE.md must not pull arbitrary host files into
 * the Pi system prompt, so an absolute import (`@/etc/passwd`) or one that escapes
 * `baseDir` via `..` (`@../../secret.md`) is rejected. The check is on the path
 * shape, not on disk (no symlink resolution) — same containment model as the
 * output-style slug guard.
 */
function isContainedImport(baseDir: string, relpath: string): boolean {
  if (isAbsolute(relpath)) {
    return false;
  }
  const resolved = resolve(baseDir, relpath);
  const rel = relative(baseDir, resolved);
  return !(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Split a CLAUDE.md body into (a) the body with every `@<path>` line removed and
 * (b) the expanded import sections, in the order the `@`-lines appeared. Each
 * import is read RELATIVE to baseDir (the CLAUDE.md dir), 1 level only:
 *  - a missing/unreadable import file → warn + skip (no section, no throw);
 *  - an imported file that itself contains a `@`-line → warn naming it, but do
 *    NOT recurse (its `@`-line is left as literal text in its section).
 */
export function expandImports(
  body: string,
  baseDir: string,
): {
  bodyWithoutImports: string;
  sections: ContextSection[];
  importLineCount: number;
  acceptedImportPaths: string[];
} {
  const { keptLines, importRelpaths } = partitionImports(body);

  const sections: ContextSection[] = [];
  const acceptedImportPaths: string[] = [];
  for (const relpath of importRelpaths) {
    if (!isContainedImport(baseDir, relpath)) {
      // Containment guard: an absolute import or one escaping baseDir via `..`
      // must NOT pull an arbitrary host file into the Pi system prompt. Skip +
      // warn, fail-safe (never read it, never throw).
      log.warn(
        "pi-context",
        `@-import escapes the workspace, skipping: "${relpath}"`,
      );
      continue;
    }
    const abs = resolve(baseDir, relpath);
    const { content, escaped } = safeReadContainedFile(abs, baseDir);
    if (escaped) {
      log.warn(
        "pi-context",
        `@-import resolves outside the workspace, skipping: "${relpath}"`,
      );
      continue;
    }
    if (content === null) {
      log.warn("pi-context", `@-import not readable, skipping: ${abs}`);
      continue;
    }
    if (content.split("\n").some((line) => IMPORT_LINE.test(line))) {
      // 1-level policy: do NOT recurse into a nested import. The nested `@`-line
      // stays as literal text in this section; only warn so the deeper import is
      // visible (no current agent has one — this catches a future regression).
      log.warn(
        "pi-context",
        `nested @-import inside "${relpath}" is NOT expanded (1-level policy)`,
      );
    }
    sections.push({ relpath, content });
    acceptedImportPaths.push(abs);
  }

  return {
    bodyWithoutImports: keptLines.join("\n"),
    sections,
    importLineCount: importRelpaths.length,
    acceptedImportPaths,
  };
}

/**
 * Collect every rule file as a `## <relpath>` section: all
 * `.claude/rules/platform/*.md` (sorted by relpath) followed by all
 * `.claude/rules/custom/*.md` (sorted by relpath). A missing dir is tolerated
 * (returns no sections for it). Relpaths are workspace-relative POSIX paths.
 */
export function collectRules(workspaceCwd: string): ContextSection[] {
  const out: ContextSection[] = [];
  for (const sub of ["platform", "custom"] as const) {
    const dir = join(workspaceCwd, ".claude", "rules", sub);
    for (const source of listMarkdown(dir, workspaceCwd)) {
      const { content, escaped } = safeReadContainedFile(source.path, source.baseDir);
      if (escaped) {
        log.warn("pi-context", `rule file resolves outside the workspace, skipping: ${source.path}`);
        continue;
      }
      if (content === null) {
        log.warn("pi-context", `rule file not readable, skipping: ${source.path}`);
        continue;
      }
      out.push({ relpath: relative(workspaceCwd, source.path), content });
    }
  }
  return out;
}

function collectKnowledgeSections(workspaceCwd: string): ContextSection[] {
  const layout = resolveKnowledgeLayout(workspaceCwd);
  if (layout.kind !== "v2") {
    return [];
  }

  const out: ContextSection[] = [];
  for (const [relpath, abs] of [
    ["wiki/schema.md", layout.paths.schemaPath],
    ["wiki/index.md", layout.paths.indexPath],
  ] as const) {
    const { content, escaped } = safeReadContainedFile(abs, workspaceCwd, { rejectSymlink: true });
    if (escaped) {
      log.warn("pi-context", `knowledge file resolves outside the workspace, skipping: ${abs}`);
      continue;
    }
    if (content === null) {
      log.warn("pi-context", `knowledge file not readable, skipping: ${abs}`);
      continue;
    }
    out.push({ relpath, content });
  }
  return out;
}

interface BundleResult {
  bundle: string;
  sources: PiContextSourceManifest[];
  /**
   * True when delivering the bundle (with `--no-context-files`) beats a bare Pi
   * spawn — i.e. at least one REAL source contributed (a CLAUDE.md body, an
   * expanded import, or a rule) OR the CLAUDE.md carried `@`-import lines that we
   * stripped. The import case matters even when EVERY import failed to read: a
   * bare spawn would let Pi flat-load the original CLAUDE.md and surface the
   * literal `@<path>` lines (exactly what this assembler exists to strip), so the
   * stripped bundle is strictly better and we must suppress flat loading. An
   * escaping CLAUDE.md symlink also counts: a bare spawn could flat-load the same
   * outside-workspace target we refused to read.
   *
   * False means the bundle is only the fixed memory directive over a CLAUDE.md
   * that had no body and no imports (or no CLAUDE.md at all) — nothing worth
   * forcing `--no-context-files` for, so the caller may prefer a bare spawn.
   */
  hasContent: boolean;
}

/** Assemble the deterministic context bundle (order 1-6 above) from live files. */
function assembleBundle(workspaceCwd: string): BundleResult {
  const claudeMdPath = join(workspaceCwd, "CLAUDE.md");
  const { content: rawBody, escaped } = safeReadContainedFile(claudeMdPath, workspaceCwd);
  if (escaped) {
    log.warn("pi-context", `CLAUDE.md resolves outside the workspace, skipping: ${claudeMdPath}`);
  }
  if (rawBody === null && !escaped) {
    log.warn("pi-context", `CLAUDE.md not found at ${claudeMdPath} — bundling rules only`);
  }

  const { bodyWithoutImports, sections, importLineCount } = expandImports(
    rawBody ?? "",
    dirname(claudeMdPath),
  );
  const knowledgeSections = collectKnowledgeSections(workspaceCwd);
  const rules = collectRules(workspaceCwd);

  const parts: string[] = [];
  const sources: PiContextSourceManifest[] = [];
  if (rawBody !== null) {
    sources.push(contextSource("workspace", "workspace:CLAUDE.md", rawBody));
  }
  const trimmedBody = bodyWithoutImports.trim();
  if (trimmedBody) {
    parts.push(trimmedBody);
  }
  for (const section of sections) {
    parts.push(sectionMarkdown(section.relpath, section.content));
    sources.push(contextSource("workspace", workspaceSourceIdentity(section.relpath), section.content));
  }
  for (const section of knowledgeSections) {
    parts.push(sectionMarkdown(section.relpath, section.content));
    sources.push(contextSource("knowledge", workspaceSourceIdentity(section.relpath), section.content));
  }
  for (const rule of rules) {
    parts.push(sectionMarkdown(rule.relpath, rule.content));
    sources.push(contextSource(
      rule.relpath.startsWith(".claude/rules/platform/") ? "platform-rule" : "custom-rule",
      workspaceSourceIdentity(rule.relpath),
      rule.content,
    ));
  }
  parts.push(`## Knowledge access\n\n${KNOWLEDGE_ACCESS_DIRECTIVE}`);
  sources.push(contextSource(
    "package-directive",
    "package:knowledge-access-v1",
    KNOWLEDGE_ACCESS_DIRECTIVE,
  ));

  // importLineCount > 0 (even with zero successfully-read sections) still counts:
  // a bare spawn would flat-load the original CLAUDE.md with its literal `@<path>`
  // lines intact, so the stripped bundle + `--no-context-files` is strictly better.
  const hasContent =
    trimmedBody !== "" ||
    sections.length > 0 ||
    knowledgeSections.length > 0 ||
    rules.length > 0 ||
    importLineCount > 0 ||
    escaped;
  return { bundle: `${parts.join("\n\n")}\n`, sources, hasContent };
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function workspaceSourceIdentity(relpath: string): string {
  return `workspace:${relpath.replaceAll("\\", "/")}`;
}

function contextSource(
  kind: PiContextSourceKind,
  identity: string,
  content: string,
): PiContextSourceManifest {
  return { kind, identity, contentHash: sha256(content) };
}

function canonicalManifestJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalManifestJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalManifestJson(entry)}`)
    .join(",")}}`;
}

function buildContextManifest(
  bundle: string,
  persona: string | null,
  sources: readonly PiContextSourceManifest[],
): PiContextManifest {
  const unsigned = {
    version: PI_CONTEXT_MANIFEST_VERSION,
    sources,
    bundleHash: sha256(bundle),
    personaHash: persona === null ? null : sha256(persona),
  };
  return {
    ...unsigned,
    digest: sha256(`minime-pi-context-manifest-v1\0${canonicalManifestJson(unsigned)}`),
  };
}

/** Build the context bundle markdown string for a workspace (order 1-6 above). */
export function buildBundle(workspaceCwd: string): string {
  return assembleBundle(workspaceCwd).bundle;
}

/**
 * Resolve the agent's persona (the `--system-prompt` content), or null when none.
 *  - Read `<workspaceCwd>/.claude/settings.local.json` `outputStyle` →
 *    `<workspaceCwd>/.claude/output-styles/<outputStyle>.md`; that file is the persona.
 *  - If `agent.systemPrompt` (config) is also set, append it AFTER the output-style
 *    content (blank-line separated).
 *  - If neither resolves → null → the caller passes NO `--system-prompt` (ride Pi base).
 */
export function resolvePersona(agent: AgentConfig): string | null {
  return resolvePersonaWithSources(agent).persona;
}

function resolvePersonaWithSources(agent: AgentConfig): {
  persona: string | null;
  sources: PiContextSourceManifest[];
} {
  const parts: string[] = [];
  const sources: PiContextSourceManifest[] = [];

  const outputStyle = readOutputStyleSource(agent.workspaceCwd);
  if (outputStyle && outputStyle.content.trim()) {
    parts.push(outputStyle.content.trim());
    sources.push(contextSource(
      "output-style",
      outputStyle.identity,
      outputStyle.content,
    ));
  }
  if (agent.systemPrompt && agent.systemPrompt.trim()) {
    parts.push(agent.systemPrompt.trim());
    sources.push(contextSource("agent-config", "agent:system-prompt", agent.systemPrompt));
  }

  return {
    persona: parts.length > 0 ? parts.join("\n\n") : null,
    sources,
  };
}

/**
 * An output-style slug must be a single path segment. Output styles resolve by
 * NAME, never by path. Reject any slug containing a path separator so a
 * settings.local.json value like `"../../../../etc/passwd"` cannot escape
 * `.claude/output-styles/` and pull an arbitrary file into the `--system-prompt`.
 */
function isSafeOutputStyleSlug(slug: string): boolean {
  return !slug.includes("/") && !slug.includes("\\");
}

/** Read the output-style markdown and its exact redacted workspace identity. */
function readOutputStyleSource(
  workspaceCwd: string,
): { content: string; identity: string } | null {
  const settingsPath = join(workspaceCwd, ".claude", "settings.local.json");
  const { content: raw, escaped: settingsEscaped } = safeReadContainedFile(settingsPath, workspaceCwd);
  if (settingsEscaped) {
    log.warn("pi-context", `settings.local.json resolves outside the workspace, skipping: ${settingsPath}`);
    return null;
  }
  if (raw === null) {
    return null;
  }
  let slug: unknown;
  try {
    slug = (JSON.parse(raw) as { outputStyle?: unknown }).outputStyle;
  } catch {
    log.warn("pi-context", `settings.local.json is not valid JSON: ${settingsPath}`);
    return null;
  }
  if (typeof slug !== "string" || slug.trim() === "") {
    return null;
  }
  if (!isSafeOutputStyleSlug(slug)) {
    log.warn("pi-context", `output-style slug is not a bare filename, ignoring: "${slug}"`);
    return null;
  }
  const stylePath = join(workspaceCwd, ".claude", "output-styles", `${slug}.md`);
  const { content, escaped: styleEscaped } = safeReadContainedFile(stylePath, workspaceCwd);
  if (styleEscaped) {
    log.warn("pi-context", `output-style "${slug}" resolves outside the workspace, skipping: ${stylePath}`);
    return null;
  }
  if (content === null) {
    log.warn("pi-context", `output-style "${slug}" not found at ${stylePath}`);
    return null;
  }
  return {
    content,
    identity: workspaceSourceIdentity(`.claude/output-styles/${slug}.md`),
  };
}

/**
 * Atomically write a bundle/persona artifact to a STABLE per-agent path under
 * `<workspaceCwd>/.tmp/`: `pi-context-<safe-agent-id>.<kind>.md`. Write a staging file
 * then `renameSync` over the final path, so a concurrent reader never sees a
 * half-written file. Stable path ⇒ no accumulation, no cleanup job. The `.tmp`
 * dir and artifact files are private because they contain assembled system
 * context. Returns the final path. May throw (e.g. unwritable `.tmp/`) — the
 * caller (assemblePiContext) wraps it in the fail-safe.
 */
export function writeTempArtifact(
  workspaceCwd: string,
  agentId: string,
  kind: PiArtifactKind,
  content: string,
  opts?: { stagingSuffix?: string },
): string {
  const tmpDir = join(workspaceCwd, ".tmp");
  ensurePrivateArtifactDir(tmpDir);
  const finalPath = join(tmpDir, `pi-context-${safeArtifactAgentId(agentId)}.${kind}.md`);
  const stagingSuffix = opts?.stagingSuffix ?? `${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}`;
  const stagingPath = `${finalPath}.tmp.${stagingSuffix}`;
  writeFileSync(stagingPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  renameSync(stagingPath, finalPath);
  return finalPath;
}

interface CacheEntry {
  signature: string;
  /** The assembled bundle string (the `--append-system-prompt` artifact body). */
  bundle: string;
  /** The resolved persona (the `--system-prompt` artifact body), or null when none. */
  persona: string | null;
  manifest: PiContextManifest;
}

/**
 * Per-agent cache of the last assembled CONTENT, keyed on a manifest signature of
 * every source file's `{path, mtime, size}` (the OpenClaw `workspaceFileCache`
 * pattern). Repeat spawns with unchanged sources skip the re-read + re-assemble of
 * the source tree, while a touched source re-assembles (freshness parity).
 *
 * The cache stores the assembled CONTENT, not just the artifact paths: a cache hit
 * still RE-WRITES the `.tmp/` artifacts from this content (see assemblePiContext).
 * Storing paths alone and trusting an existence check would let a prior Pi session,
 * a sibling spawn, or any external process overwrite the gitignored
 * `pi-context-<agent>.bundle.md` and have the next spawn hand Pi tampered
 * system-prompt content. Re-writing is cheap (a few KB) next to re-assembling the
 * whole source tree, so the optimization is preserved while the artifact on disk
 * always matches what the assembler produced. Module-scoped: the process lives for
 * the bot's lifetime.
 */
const cache = new Map<string, CacheEntry>();

/**
 * A manifest signature over every source file: CLAUDE.md, each `@`-import, every
 * platform + custom rule, settings.local.json, the resolved output-style file, and
 * the config-level systemPrompt. A missing file contributes a stable `missing`
 * marker, so adding/removing a source also changes the signature.
 */
function computeManifestSignature(agent: AgentConfig): string {
  const workspaceCwd = agent.workspaceCwd;
  const files: Array<{ path: string; baseDir: string }> = [];

  const claudeMdPath = join(workspaceCwd, "CLAUDE.md");
  files.push({ path: claudeMdPath, baseDir: workspaceCwd });
  files.push({ path: join(workspaceCwd, "wiki", "schema.md"), baseDir: workspaceCwd });
  files.push({ path: join(workspaceCwd, "wiki", "index.md"), baseDir: workspaceCwd });
  files.push({ path: join(workspaceCwd, "MEMORY.md"), baseDir: workspaceCwd });
  const { content: body } = safeReadContainedFile(claudeMdPath, workspaceCwd);
  if (body !== null) {
    const baseDir = dirname(claudeMdPath);
    for (const relpath of partitionImports(body).importRelpaths) {
      // Track ONLY the imports expandImports will actually inline: an escaping
      // import is skipped there, so the manifest must not `stat` it either —
      // otherwise the signature covers a path outside the workspace that is never
      // part of the bundle. Single containment rule, both sides.
      if (isContainedImport(baseDir, relpath)) {
        files.push({ path: resolve(baseDir, relpath), baseDir });
      }
    }
  }

  for (const sub of ["platform", "custom"] as const) {
    const dir = join(workspaceCwd, ".claude", "rules", sub);
    files.push({ path: dir, baseDir: workspaceCwd });
    files.push(...listMarkdown(dir, workspaceCwd));
  }

  const settingsPath = join(workspaceCwd, ".claude", "settings.local.json");
  files.push({ path: settingsPath, baseDir: workspaceCwd });
  const { content: settingsRaw } = safeReadContainedFile(settingsPath, workspaceCwd);
  if (settingsRaw !== null) {
    try {
      const slug = (JSON.parse(settingsRaw) as { outputStyle?: unknown }).outputStyle;
      if (typeof slug === "string" && slug.trim() !== "" && isSafeOutputStyleSlug(slug)) {
        files.push({
          path: join(workspaceCwd, ".claude", "output-styles", `${slug}.md`),
          baseDir: workspaceCwd,
        });
      }
    } catch {
      // Non-JSON settings yield no persona path; the settings file's own stat
      // (above) still invalidates the cache when its contents change.
    }
  }

  const parts = files
    .sort((a, b) => a.path.localeCompare(b.path) || a.baseDir.localeCompare(b.baseDir))
    .map(({ path, baseDir }) => sourceSignature(path, baseDir));
  // The config systemPrompt is not a file — fold it in directly.
  parts.push(`systemPrompt:${agent.systemPrompt ?? ""}`);
  return parts.join("|");
}

/**
 * Assemble the full Pi context for an agent and return the artifact paths, or null
 * to signal "no extra context — bare spawn".
 *
 * Caches by a source-file manifest: an unchanged source set skips the re-read +
 * re-assemble of the source tree, but STILL re-writes the `.tmp/` artifacts from
 * the cached content so the files on disk always match what the assembler produced
 * (and so a deleted artifact is transparently recreated).
 *
 * Returns null only for a genuinely empty workspace with no persona. If artifact
 * writing fails after content was assembled, this throws; Pi callers must catch
 * and add `--no-context-files` so Pi does not fall back to flat context loading.
 */
export function assemblePiContext(
  agent: AgentConfig,
  options: PiContextAssemblyOptions = {},
): PiContextArtifacts | null {
  const signature = computeManifestSignature(agent);
  const cacheKey = `${agent.id}\0${resolve(agent.workspaceCwd)}`;
  const cached = cache.get(cacheKey);

  let bundle: string;
  let persona: string | null;
  let manifest: PiContextManifest;
  if (cached && cached.signature === signature) {
    // Source manifest unchanged: reuse the assembled content (skip the expensive
    // re-read + re-parse of every source file) but fall through to RE-WRITE the
    // artifacts below. A cache entry only exists for a non-empty assembly, so the
    // content here is guaranteed meaningful — no empty-workspace re-check needed.
    bundle = cached.bundle;
    persona = cached.persona;
    manifest = cached.manifest;
  } else {
    const assembled = assembleBundle(agent.workspaceCwd);
    const resolvedPersona = resolvePersonaWithSources(agent);
    if (!assembled.hasContent && resolvedPersona.persona === null) {
      // Empty workspace — let Pi fall back to its own (flat) context loading
      // instead of forcing an empty bundle + --no-context-files.
      cache.delete(cacheKey);
      return null;
    }
    bundle = assembled.bundle;
    persona = resolvedPersona.persona;
    manifest = buildContextManifest(
      bundle,
      persona,
      [...assembled.sources, ...resolvedPersona.sources],
    );
  }

  // Always (re-)write the artifacts — on a cache hit too. This keeps the on-disk
  // bundle/persona faithful to the cached content even if a prior session or an
  // external process overwrote them, and recreates an artifact that was deleted.
  const artifactWorkspaceCwd = options.artifactWorkspaceCwd ?? agent.workspaceCwd;
  const appendSystemPromptPath = writeTempArtifact(artifactWorkspaceCwd, agent.id, "bundle", bundle);
  let systemPromptPath: string | undefined;
  if (persona !== null) {
    systemPromptPath = writeTempArtifact(artifactWorkspaceCwd, agent.id, "persona", persona);
  }

  const result: PiContextArtifacts =
    systemPromptPath !== undefined
      ? { systemPromptPath, appendSystemPromptPath, manifest }
      : { appendSystemPromptPath, manifest };
  cache.set(cacheKey, { signature, bundle, persona, manifest });
  return result;
}

/** Test-only: clear the per-agent manifest cache. */
export function _resetPiContextCache(): void {
  cache.clear();
}
