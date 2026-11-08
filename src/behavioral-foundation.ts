import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { loadSkills, loadSkillsFromDir, parseFrontmatter, type LoadSkillsResult } from "./pi-native-skills.js";
import ignore, { type Ignore } from "ignore";
import { log } from "./logger.js";

/** Trusted adapter input. Always a resolved physical revision, never `current`. */
export const MINIME_BEHAVIORAL_FOUNDATION_ROOT_ENV = "MINIME_BEHAVIORAL_FOUNDATION_ROOT";

export interface BehavioralFoundationManifest {
  version: 1;
  revision: string;
  rules: { path: string; source: string }[];
  skills: { path: string; name: string; source?: string }[];
  /** Lowercase hex SHA-256, without a prefix. Includes all skill support files. */
  files: Record<string, string>;
  sourceOwnerAgentIds: string[];
}

export interface ResolvedBehavioralFoundation {
  root: string;
  manifest: BehavioralFoundationManifest;
  /** Hash-only publication identity, suitable for context manifests. */
  digest: string;
  rules: { source: string; content: string }[];
  skillPaths: string[];
}

export class BehavioralFoundationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Behavioral foundation: ${message}`, options);
    this.name = "BehavioralFoundationError";
  }
}

function fail(message: string): never { throw new BehavioralFoundationError(message); }
function hash(bytes: string | Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function relativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value) &&
    !/[\\\0\r\n]/.test(value) && value.split("/").every(p => p !== "" && p !== "." && p !== "..");
}
function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Does not consult config, environment, agent homes or mutable module state. */
export function resolveBehavioralFoundation(root: string): ResolvedBehavioralFoundation {
  try {
    if (!isAbsolute(root)) fail("root must be an absolute publication directory");
    // Resolve current exactly once. All subsequent reads and advertisements use this root.
    const pinnedRoot = realpathSync(root);
    if (!statSync(pinnedRoot).isDirectory()) fail("root must be a publication directory");
    const read = (path: string): Buffer => {
      try {
        const real = realpathSync(join(pinnedRoot, path));
        if (!contained(pinnedRoot, real) || !statSync(real).isFile()) fail(`file escapes publication or is not regular: ${path}`);
        return readFileSync(real);
      } catch (error) {
        if (error instanceof BehavioralFoundationError) throw error;
        throw new BehavioralFoundationError(`cannot read required publication file: ${path}; check the published revision`, { cause: error });
      }
    };
    const raw: unknown = JSON.parse(read("manifest.json").toString("utf8"));
    if (!record(raw) || raw.version !== 1 || typeof raw.revision !== "string" || !raw.revision.trim() ||
        !Array.isArray(raw.rules) || !Array.isArray(raw.skills) || !record(raw.files) ||
        !Array.isArray(raw.sourceOwnerAgentIds) || raw.sourceOwnerAgentIds.some(id => typeof id !== "string" || !id.trim())) {
      fail("invalid manifest.json; expected version 1 publication (see docs/shared-behavior.md)");
    }
    const sources = new Set<string>();
    for (const rule of raw.rules) {
      if (!record(rule) || !relativePath(rule.path) || !rule.path.endsWith(".md") ||
          !relativePath(rule.source) || !rule.source.startsWith(".claude/rules/") || !rule.source.endsWith(".md") ||
          sources.has(rule.source)) fail("invalid or duplicate rule path/source identity in manifest");
      sources.add(rule.source);
    }
    const names = new Set<string>();
    const skillSources = new Set<string>();
    for (const skill of raw.skills) {
      if (!record(skill) || !relativePath(skill.path) || typeof skill.name !== "string" || !skill.name.trim() ||
          names.has(skill.name)) fail("invalid or duplicate skill path/name in manifest");
      if (skill.source !== undefined) {
        if (!relativePath(skill.source) || !/^\.(claude|pi)\/skills\/.+$/.test(skill.source) ||
            skillSources.has(skill.source)) fail("invalid or duplicate skill source identity in manifest");
        skillSources.add(skill.source);
      }
      names.add(skill.name);
    }
    const manifest = raw as unknown as BehavioralFoundationManifest;
    const bytes = new Map<string, Buffer>();
    for (const [path, expected] of Object.entries(manifest.files)) {
      if (!relativePath(path) || typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected)) fail(`invalid file path/hash: ${path}`);
      const content = read(path);
      if (hash(content) !== expected) fail(`hash mismatch: ${path}; republish a complete immutable revision`);
      bytes.set(path, content);
    }
    const required = (path: string): Buffer => bytes.get(path) ?? fail(`required file missing from files: ${path}`);
    const rules = manifest.rules.map(rule => ({ source: rule.source, content: required(rule.path).toString("utf8") }));
    const skillPaths = manifest.skills.map(skill => {
      const skillRoot = realpathSync(join(pinnedRoot, skill.path));
      if (!contained(pinnedRoot, skillRoot) || !statSync(skillRoot).isDirectory()) fail(`skill escapes publication: ${skill.path}`);
      // Check the complete asset tree, not just SKILL.md. Pi reads support files lazily.
      for (const path of listContainedFiles(skillRoot, pinnedRoot)) required(`${skill.path}/${path}`);
      const metadata = skillMetadata(required(`${skill.path}/SKILL.md`).toString("utf8"), basename(skill.path));
      if (metadata !== skill.name) fail(`SKILL.md name differs from declared name: ${skill.path}`);
      return join(pinnedRoot, skill.path, "SKILL.md");
    });
    // Stable object-key ordering; arrays intentionally retain publisher order.
    const identity: BehavioralFoundationManifest = {
      version: 1, revision: manifest.revision,
      rules: manifest.rules.map(({ path, source }) => ({ path, source })),
      skills: manifest.skills.map(({ path, name, source }) => ({ path, name, ...(source === undefined ? {} : { source }) })),
      files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))),
      sourceOwnerAgentIds: manifest.sourceOwnerAgentIds,
    };
    return { root: pinnedRoot, manifest, digest: `sha256:${hash(JSON.stringify(identity))}`, rules, skillPaths };
  } catch (error) {
    if (error instanceof BehavioralFoundationError) throw error;
    throw new BehavioralFoundationError("cannot load required publication; check root, manifest.json and all declared files", { cause: error });
  }
}

/** Publications check every asset; local assets follow native discovery ignores. */
function listContainedFiles(
  dir: string, root: string, ancestors = new Set<string>(), excluded = new Set<string>(),
  localIgnore?: { root: string; matcher: Ignore },
): string[] {
  try {
    const real = realpathSync(dir);
    if (!contained(root, real)) fail(`resource resolves outside its root: ${relative(root, dir)}`);
    if (ancestors.has(real)) fail(`resource directory cycle: ${relative(root, dir)}`);
    const next = new Set([...ancestors, real]);
    const files: string[] = [];
    if (localIgnore) addSkillIgnoreRules(localIgnore.matcher, dir, localIgnore.root);
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (excluded.has(path)) continue;
      try {
        if (localIgnore) {
          if (name.startsWith(".") || name === "node_modules") continue;
          const rel = relative(localIgnore.root, path).split(sep).join("/");
          if (localIgnore.matcher.ignores(rel) ||
              (statSync(path).isDirectory() && localIgnore.matcher.ignores(`${rel}/`))) continue;
        }
        const target = realpathSync(path);
        if (!contained(root, target)) fail(`resource resolves outside its root: ${relative(root, path)}`);
        const stat = statSync(target);
        if (stat.isDirectory()) files.push(...listContainedFiles(path, root, next, excluded, localIgnore).map(p => `${name}/${p}`));
        else if (stat.isFile()) files.push(name);
        else fail(`resource is not a regular file: ${relative(root, path)}`);
      } catch (error) {
        if (!localIgnore || error instanceof BehavioralFoundationError) throw error;
        log.warn("behavioral-foundation", `Cannot read optional local skill asset ${relative(root, path)}; skipped`);
      }
    }
    return files;
  } catch (error) {
    if (!localIgnore || error instanceof BehavioralFoundationError) throw error;
    log.warn("behavioral-foundation", `Cannot read optional local skill directory ${relative(root, dir)}; skipped`);
    return [];
  }
}

function skillMetadata(content: string, fallback: string): string {
  // Use the pinned native parser; do not inline skill bodies into the prompt.
  const { frontmatter } = parseFrontmatter<{ name?: unknown; description?: unknown }>(content);
  if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) fail("SKILL.md needs a nonempty description");
  return typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : fallback;
}

/** Decide by source identity before reading any unpublished owner rule bytes. */
export function includeLocalFoundationRule(foundation: ResolvedBehavioralFoundation, agentId: string, identity: string): boolean {
  if (!foundation.rules.some(rule => rule.source === identity)) return true;
  if (foundation.manifest.sourceOwnerAgentIds.includes(agentId)) return false;
  return fail(`local rule conflicts with published source identity ${identity}; remove the local shadow`);
}

/** Configured rule discovery replaces the legacy external platform link exception. */
export function collectFoundationLocalRules(foundation: ResolvedBehavioralFoundation, workspace: string, agentId: string, strict = false): { relpath: string; content: string }[] {
  const root = realpathSync(workspace);
  const rules = join(root, ".claude/rules");
  const out: { relpath: string; content: string }[] = [];
  const walk = (dir: string, ancestors = new Set<string>()) => {
    try {
      if (!lstatSync(dir, { throwIfNoEntry: false })) return;
      const real = realpathSync(dir);
      if (!contained(root, real)) fail(`local rule directory escapes workspace: ${relative(root, dir)}`);
      if (ancestors.has(real)) fail("local rule directory cycle");
      const next = new Set([...ancestors, real]);
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const { name } = entry;
        const path = join(dir, name);
        const identity = relative(root, path).split(sep).join("/");
        // This exact legacy link is replaced without inspecting its target.
        if (path === join(rules, "platform") && entry.isSymbolicLink()) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink() && !name.endsWith(".md")) continue;
        if (name.endsWith(".md") && !includeLocalFoundationRule(foundation, agentId, identity)) continue;
        try {
          const target = realpathSync(path);
          const stat = statSync(target);
          if (!stat.isDirectory() && !name.endsWith(".md")) continue;
          if (!contained(root, target)) fail(`local rule escapes workspace: ${identity}`);
          if (stat.isDirectory()) walk(path, next);
          else {
            if (!stat.isFile()) fail(`local rule is not a regular file: ${identity}`);
            out.push({ relpath: identity, content: readFileSync(target, "utf8") });
          }
        } catch (error) {
          if (strict || error instanceof BehavioralFoundationError) throw error;
          log.warn("behavioral-foundation", `Cannot read optional local rule ${identity}; skipped`);
        }
      }
    } catch (error) {
      if (strict || error instanceof BehavioralFoundationError) throw error;
      log.warn("behavioral-foundation", `Cannot read optional local rule directory ${relative(root, dir)}; skipped`);
    }
  };
  walk(rules);
  return out;
}

/** Native discovery with owner directories pruned before any metadata/support read.
 * Pi's public directory loader has no exclusion option. Keep its 1.5.0 discovery
 * and ignore semantics here, delegating all skill parsing to the native loader.
 */
function loadSkillsExcluding(dir: string, root: string, excluded: Set<string>): LoadSkillsResult {
  const result: LoadSkillsResult = { skills: [], diagnostics: [] };
  const ig = ignore();
  const load = (path: string) => {
    const local = loadSkills({ cwd: root, agentDir: root, includeDefaults: false, skillPaths: [path] });
    result.skills.push(...local.skills);
    result.diagnostics.push(...local.diagnostics);
  };
  const walk = (current: string, includeRootFiles: boolean) => {
    try {
      addSkillIgnoreRules(ig, current, dir);
      const entries = readdirSync(current).sort().filter(name => !excluded.has(join(current, name)));
      const ignored = (path: string, directory = false) => ig.ignores(`${relative(dir, path).split(sep).join("/")}${directory ? "/" : ""}`);
      const skill = join(current, "SKILL.md");
      if (entries.includes("SKILL.md")) {
        try {
          if (statSync(skill).isFile() && !ignored(skill)) {
            load(skill);
            return;
          }
        } catch { log.warn("behavioral-foundation", "Cannot read optional local SKILL.md; skipped"); }
      }
      for (const name of entries) {
        if (name.startsWith(".") || name === "node_modules") continue;
        const path = join(current, name);
        try {
          const stat = statSync(path);
          if (ignored(path, stat.isDirectory())) continue;
          if (stat.isDirectory()) walk(path, false);
          else if (stat.isFile() && includeRootFiles && name.endsWith(".md")) load(path);
        } catch { log.warn("behavioral-foundation", "Cannot read optional local skill entry; skipped"); }
      }
    } catch { log.warn("behavioral-foundation", "Cannot read optional local skill directory; skipped"); }
  };
  walk(dir, true);
  return result;
}

/** Same scoped gitignore patterns used by the pinned native skill loader. */
function addSkillIgnoreRules(ig: Ignore, dir: string, root: string): void {
  const rel = relative(root, dir).split(sep).join("/");
  for (const name of [".gitignore", ".ignore", ".fdignore"]) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const patterns = readFileSync(path, "utf8").split(/\r?\n/).flatMap(line => {
        if (!line.trim() || (line.trim().startsWith("#") && !line.trim().startsWith("\\#"))) return [];
        const negated = line.startsWith("!");
        let pattern = negated ? line.slice(1) : line.startsWith("\\!") ? line.slice(1) : line;
        if (pattern.startsWith("/")) pattern = pattern.slice(1);
        return [`${negated ? "!" : ""}${rel ? `${rel}/` : ""}${pattern}`];
      });
      ig.add(patterns);
    } catch { log.warn("behavioral-foundation", `Cannot read optional local skill ignore file ${relative(root, path)}; skipped`); }
  }
}

/** Explicit shared-first skill selection, with contained local additions only. */
export function resolveFoundationSkillPaths(foundation: ResolvedBehavioralFoundation, workspace: string, agentId: string): string[] {
  const root = realpathSync(workspace);
  const paths = [...foundation.skillPaths];
  const names = new Set(foundation.manifest.skills.map(skill => skill.name));
  const realPaths = new Set(foundation.skillPaths.map(path => realpathSync(path)));
  const excluded = new Set(foundation.manifest.sourceOwnerAgentIds.includes(agentId)
    ? foundation.manifest.skills.flatMap(skill => skill.source === undefined ? [] : [join(root, skill.source)]) : []);
  for (const rel of [".claude/skills", ".pi/skills"]) {
    const dir = join(root, rel);
    let entry;
    try { entry = lstatSync(dir, { throwIfNoEntry: false }); }
    catch { log.warn("behavioral-foundation", `Cannot read optional local skill root ${rel}; skipped`); continue; }
    if (!entry) continue;
    if (entry.isSymbolicLink()) {
      let target: string | undefined;
      try { target = realpathSync(dir); }
      catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          log.warn("behavioral-foundation", `Cannot read optional local skill root ${rel}; skipped`);
          continue;
        }
      }
      if (target === undefined || !contained(root, target)) {
        log.warn("behavioral-foundation", `Legacy shared skill-directory discovery at ${rel} is replaced by the selected publication; legacy target contents were not read`);
        continue;
      }
    }
    // Validate unignored lazy assets, pruning promoted owner sources and runtime trees.
    listContainedFiles(dir, root, new Set(), excluded, { root: dir, matcher: ignore() });
    const local = [...excluded].some(path => path.startsWith(`${dir}${sep}`))
      ? loadSkillsExcluding(dir, root, excluded) : loadSkillsFromDir({ dir, source: "path" });
    const loaded = new Set(local.skills.map(skill => skill.filePath));
    for (const diagnostic of local.diagnostics) {
      const identity = relative(root, diagnostic.path ?? dir);
      const skipped = diagnostic.path && loaded.has(diagnostic.path) ? "" : " (skipped)";
      // Native parser messages can include source YAML (including private text).
      const category = skipped ? "invalid/unloaded native skill metadata" : "native skill metadata portability warning";
      log.warn("behavioral-foundation", `Local skill metadata at ${identity}${skipped}: ${category}`);
    }
    for (const skill of local.skills.sort((a, b) => a.filePath.localeCompare(b.filePath))) {
      const realPath = realpathSync(skill.filePath);
      if (realPaths.has(realPath)) continue;
      if (names.has(skill.name)) fail(`local skill name conflicts with selected skill ${skill.name}; remove the local shadow`);
      realPaths.add(realPath);
      names.add(skill.name);
      paths.push(skill.filePath);
    }
  }
  return paths;
}

/** Shared authority text is stable across all managed launch adapters. */
export function renderBehavioralFoundation(foundation: ResolvedBehavioralFoundation): string {
  return [
    "## Shared behavioral foundation",
    "Canonical Main-owned rules and workflows apply when relevant. Local additions supplement these instructions and cannot cancel or override them. Resource and skill availability does not grant permission to take action. Local user, persona and Knowledge context remains separate and private.",
    ...foundation.rules.map(rule => `### ${rule.source}\n\n${rule.content.trim()}`),
  ].join("\n\n");
}

/** Explicit paths remain enabled by Pi 1.5.0 even when ambient discovery is off. */
export function foundationSkillArgs(skillPaths: readonly string[]): string[] {
  return ["--no-skills", ...skillPaths.flatMap(path => ["--skill", path])];
}
