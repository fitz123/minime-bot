import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  KNOWLEDGE_PAGE_TYPES,
  type KnowledgePageType,
  type ResolvedKnowledgeLayout,
  type ResolvedKnowledgeV2Layout,
  resolveKnowledgeLayout,
} from "./layout.js";
import { MINIME_AGENT_WORKSPACE_CWD_ENV } from "../workspace-contract.js";

export type KnowledgeUpdateOperation = "create" | "update" | "upsert";
export type KnowledgeUpdateAction = "created" | "updated";

export interface KnowledgeUpdateArgs {
  op?: unknown;
  operation?: unknown;
  type?: unknown;
  slug?: unknown;
  path?: unknown;
  frontmatter?: unknown;
  body?: unknown;
}

export interface KnowledgePageFrontmatter {
  name: string;
  description: string;
  type: KnowledgePageType;
  confidence?: string | number | boolean;
  revisit_if?: string;
  originSessionId?: string;
}

export interface KnowledgeUpdateDeps {
  agentWorkspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  resolveLayout?: (agentWorkspaceRoot: string) => ResolvedKnowledgeLayout;
  fs?: Partial<KnowledgeUpdateFs>;
  now?: () => Date;
  staleLockMs?: number;
  refreshSearchBackend?: (layout: ResolvedKnowledgeV2Layout) => void;
}

export interface KnowledgeUpdateSuccess {
  ok: true;
  layoutKind: "v2";
  operation: KnowledgeUpdateOperation;
  action: KnowledgeUpdateAction;
  path: string;
  indexPath: "wiki/index.md";
  logPath?: "wiki/log.md";
  lockPath: ".tmp/knowledge-update.lock";
  frontmatter: KnowledgePageFrontmatter;
}

export interface KnowledgeUpdateFailure {
  ok: false;
  status: "unavailable" | "unsupported" | "rejected" | "locked" | "error";
  reason: string;
  message: string;
  layoutKind?: ResolvedKnowledgeLayout["kind"];
}

export type KnowledgeUpdateResponse = KnowledgeUpdateSuccess | KnowledgeUpdateFailure;

export interface KnowledgeUpdateFs {
  existsSync: typeof existsSync;
  lstatSync: typeof lstatSync;
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  closeSync: typeof closeSync;
  readFileSync: typeof readFileSync;
  readdirSync: typeof readdirSync;
  realpathSync: typeof realpathSync;
  renameSync: typeof renameSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
}

export interface ParsedPage {
  absPath: string;
  relPath: string;
  linkPath: string;
  frontmatter: KnowledgePageFrontmatter;
}

interface AtomicWrite {
  path: string;
  content: string;
}

interface AtomicWritePlan extends AtomicWrite {
  tempPath: string;
  existed: boolean;
  previousContent?: string;
  committed: boolean;
}

interface LockHandle {
  path: string;
  relPath: ".tmp/knowledge-update.lock";
  release: () => void;
}

const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;
const KNOWN_PAGE_TYPES = new Set<string>(KNOWLEDGE_PAGE_TYPES);
const REQUIRED_FRONTMATTER = ["name", "description", "type"] as const;
const OPTIONAL_FRONTMATTER = ["confidence", "revisit_if", "originSessionId"] as const;
const ALLOWED_FRONTMATTER = new Set<string>([...REQUIRED_FRONTMATTER, ...OPTIONAL_FRONTMATTER]);
const TYPE_LABELS: Record<KnowledgePageType, string> = {
  user: "User",
  project: "Project",
  feedback: "Feedback",
  reference: "Reference",
};

const defaultFs: KnowledgeUpdateFs = {
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
};

function failure(
  status: KnowledgeUpdateFailure["status"],
  reason: string,
  message: string,
  layoutKind?: ResolvedKnowledgeLayout["kind"],
): KnowledgeUpdateFailure {
  return { ok: false, status, reason, message, ...(layoutKind ? { layoutKind } : {}) };
}

function isUpdateFailure(value: unknown): value is KnowledgeUpdateFailure {
  return isRecord(value) && value.ok === false;
}

function fsForDeps(deps: KnowledgeUpdateDeps): KnowledgeUpdateFs {
  return { ...defaultFs, ...(deps.fs ?? {}) };
}

function resolveAgentWorkspaceRoot(deps: KnowledgeUpdateDeps): string | undefined {
  const env = deps.env ?? process.env;
  const root =
    deps.agentWorkspaceRoot ??
    env[MINIME_AGENT_WORKSPACE_CWD_ENV];
  return typeof root === "string" && root.trim() ? root : undefined;
}

function resolveLayoutForDeps(deps: KnowledgeUpdateDeps): ResolvedKnowledgeLayout | KnowledgeUpdateFailure {
  const agentWorkspaceRoot = resolveAgentWorkspaceRoot(deps);
  if (!agentWorkspaceRoot) {
    return failure(
      "unavailable",
      "agent-workspace-unset",
      "knowledge_update is unavailable because MINIME_AGENT_WORKSPACE_CWD was not provided.",
    );
  }

  return (deps.resolveLayout ?? resolveKnowledgeLayout)(agentWorkspaceRoot);
}

function isKnowledgeFailure(value: ResolvedKnowledgeLayout | KnowledgeUpdateFailure): value is KnowledgeUpdateFailure {
  return isUpdateFailure(value);
}

function normalizeOperation(raw: unknown): KnowledgeUpdateOperation | undefined {
  const op = typeof raw === "string" ? raw.toLowerCase() : "";
  if (op === "create" || op === "update" || op === "upsert") {
    return op;
  }
  return undefined;
}

function normalizeType(raw: unknown): KnowledgePageType | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const type = raw.toLowerCase();
  return KNOWN_PAGE_TYPES.has(type) ? (type as KnowledgePageType) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is string | number | boolean {
  return ["string", "number", "boolean"].includes(typeof value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function markdownBody(raw: unknown): string | KnowledgeUpdateFailure {
  if (typeof raw !== "string") {
    return failure("rejected", "invalid-body", "knowledge_update requires a Markdown body string.");
  }
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/^---\n/.test(normalized)) {
    return failure(
      "rejected",
      "body-frontmatter-not-allowed",
      "knowledge_update body must not include frontmatter; pass flat frontmatter separately.",
    );
  }
  return normalized;
}

export function validateKnowledgePageFrontmatter(
  input: unknown,
  expectedType?: KnowledgePageType,
): KnowledgePageFrontmatter | KnowledgeUpdateFailure {
  if (!isRecord(input)) {
    return failure("rejected", "invalid-frontmatter", "knowledge_update frontmatter must be a flat object.");
  }

  if ("metadata" in input) {
    return failure(
      "rejected",
      "nested-metadata-frontmatter",
      "Knowledge v2 pages use flat frontmatter; nested metadata is rejected.",
    );
  }

  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_FRONTMATTER.has(key)) {
      return failure("rejected", "unknown-frontmatter-field", `Unsupported v2 frontmatter field: ${key}.`);
    }
    if (!isScalar(value)) {
      return failure("rejected", "nested-frontmatter", `Frontmatter field ${key} must be a scalar value.`);
    }
  }

  const type = normalizeType(input.type ?? expectedType);
  if (!type) {
    return failure(
      "rejected",
      "invalid-frontmatter-type",
      "Frontmatter type must be one of user, project, feedback, or reference.",
    );
  }
  if (expectedType && type !== expectedType) {
    return failure("rejected", "frontmatter-type-mismatch", "Frontmatter type must match the target page type.");
  }

  const name = nonEmptyString(input.name);
  const description = nonEmptyString(input.description);
  if (!name || !description) {
    return failure(
      "rejected",
      "missing-frontmatter-field",
      "Frontmatter requires non-empty name, description, and type fields.",
    );
  }

  const frontmatter: KnowledgePageFrontmatter = { name, description, type };
  if (input.confidence !== undefined) {
    frontmatter.confidence = input.confidence as string | number | boolean;
  }
  if (input.revisit_if !== undefined) {
    const revisitIf = nonEmptyString(input.revisit_if);
    if (!revisitIf) {
      return failure("rejected", "invalid-frontmatter-field", "Frontmatter revisit_if must be a non-empty string.");
    }
    frontmatter.revisit_if = revisitIf;
  }
  if (input.originSessionId !== undefined) {
    const originSessionId = nonEmptyString(input.originSessionId);
    if (!originSessionId) {
      return failure("rejected", "invalid-frontmatter-field", "Frontmatter originSessionId must be a non-empty string.");
    }
    frontmatter.originSessionId = originSessionId;
  }

  return frontmatter;
}

function normalizeSlug(raw: unknown): string | KnowledgeUpdateFailure {
  if (typeof raw !== "string" || !raw.trim()) {
    return failure("rejected", "invalid-slug", "knowledge_update requires a slug or page path.");
  }
  const slug = raw.trim().replace(/\.md$/i, "");
  if (isAbsolute(slug) || slug.includes("\\") || /^[A-Za-z]:/.test(slug)) {
    return failure("rejected", "invalid-slug", "knowledge_update slug must be relative.");
  }
  const parts = slug.split("/");
  if (
    parts.some((part) => !part || part === "." || part === ".." || !/^[a-z0-9][a-z0-9._-]*$/i.test(part))
  ) {
    return failure(
      "rejected",
      "invalid-slug",
      "knowledge_update slug segments must be non-empty safe filename segments.",
    );
  }
  return `${parts.join("/")}.md`;
}

function normalizePagePath(raw: unknown): string | KnowledgeUpdateFailure {
  if (typeof raw !== "string" || !raw.trim()) {
    return failure("rejected", "invalid-path", "knowledge_update page path must be a relative Markdown path.");
  }
  const relPath = raw.trim();
  if (isAbsolute(relPath) || relPath.includes("\\") || /^[A-Za-z]:/.test(relPath)) {
    return failure("rejected", "invalid-path", "knowledge_update only accepts workspace-relative Markdown paths.");
  }
  const parts = relPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    return failure("rejected", "invalid-path", "knowledge_update rejects empty, dot, and traversal path segments.");
  }
  if (extname(relPath).toLowerCase() !== ".md") {
    return failure("rejected", "non-markdown", "knowledge_update only writes Markdown pages.");
  }
  return parts.join("/");
}

function resolveTargetRelPath(args: KnowledgeUpdateArgs, type: KnowledgePageType): string | KnowledgeUpdateFailure {
  if (args.path !== undefined && args.path !== null && args.path !== "") {
    const relPath = normalizePagePath(args.path);
    if (typeof relPath !== "string") {
      return relPath;
    }
    const prefix = `wiki/pages/${type}/`;
    if (!relPath.startsWith(prefix)) {
      return failure("rejected", "path-type-mismatch", `Page writes are constrained to ${prefix}**/*.md.`);
    }
    return relPath;
  }

  const slug = normalizeSlug(args.slug);
  if (typeof slug !== "string") {
    return slug;
  }
  return `wiki/pages/${type}/${slug}`;
}

function toWorkspaceRel(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}

function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertSafeWorkspaceWritePath(root: string, target: string, fs: KnowledgeUpdateFs): KnowledgeUpdateFailure | undefined {
  const rootResolved = normalize(resolve(root));
  const targetResolved = normalize(resolve(target));
  if (!isInsidePath(rootResolved, targetResolved)) {
    return failure("rejected", "path-escape", "knowledge_update target path must stay inside the agent workspace.");
  }

  const realRoot = safeRealpath(rootResolved, fs);
  if (!realRoot) {
    return failure("rejected", "path-unreadable", "knowledge_update could not inspect the workspace root.");
  }

  let current = rootResolved;
  const relParts = relative(rootResolved, targetResolved).split(sep).filter(Boolean);
  for (const part of relParts) {
    current = join(current, part);
    let stat: ReturnType<KnowledgeUpdateFs["lstatSync"]>;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        continue;
      }
      return failure("rejected", "path-unreadable", "knowledge_update could not inspect the target path.");
    }
    if (stat.isSymbolicLink()) {
      return failure("rejected", "symlink-escape", "knowledge_update refuses to write through symlinked paths.");
    }
    const realCurrent = safeRealpath(current, fs);
    if (!realCurrent || !isInsidePath(realRoot, realCurrent)) {
      return failure("rejected", "symlink-escape", "knowledge_update refuses paths whose real location escapes the workspace.");
    }
  }
  return undefined;
}

function assertRegularFileIfExists(
  path: string,
  fs: KnowledgeUpdateFs,
  message: string,
): KnowledgeUpdateFailure | undefined {
  let stat: ReturnType<KnowledgeUpdateFs["lstatSync"]>;
  try {
    stat = fs.lstatSync(path);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return undefined;
    }
    return failure("rejected", "path-unreadable", "knowledge_update could not inspect the managed file path.");
  }
  if (stat.isSymbolicLink()) {
    return failure("rejected", "symlink-escape", "knowledge_update refuses to read or replace symlinked managed files.");
  }
  if (!stat.isFile()) {
    return failure("rejected", "managed-file-not-regular", message);
  }
  return undefined;
}

function assertTargetPath(
  layout: ResolvedKnowledgeV2Layout,
  relPath: string,
  type: KnowledgePageType,
  fs: KnowledgeUpdateFs,
): string | KnowledgeUpdateFailure {
  const absPath = normalize(resolve(layout.agentWorkspaceRoot, ...relPath.split("/")));
  if (!isInsidePath(layout.agentWorkspaceRoot, absPath)) {
    return failure("rejected", "path-escape", "knowledge_update target path must stay inside the agent workspace.");
  }
  if (!isInsidePath(layout.paths.pageTypeDirs[type], absPath)) {
    return failure("rejected", "path-type-mismatch", `Page writes are constrained to wiki/pages/${type}/**/*.md.`);
  }

  const symlinkProblem = assertSafeWorkspaceWritePath(layout.agentWorkspaceRoot, absPath, fs);
  if (symlinkProblem) {
    return symlinkProblem;
  }

  return absPath;
}

function splitMarkdownLines(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0) {
    return [];
  }
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

function parseMarkdownFrontmatter(markdown: string): { frontmatter: Record<string, unknown>; body: string } | KnowledgeUpdateFailure {
  const lines = splitMarkdownLines(markdown);
  if (lines[0] !== "---") {
    return failure("rejected", "missing-frontmatter", "Knowledge v2 pages require YAML frontmatter.");
  }
  const closingIndex = lines.slice(1).findIndex((line) => line === "---");
  if (closingIndex < 0) {
    return failure("rejected", "unterminated-frontmatter", "Knowledge v2 page frontmatter must close with ---.");
  }
  const yaml = lines.slice(1, closingIndex + 1).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(yaml);
  } catch {
    return failure("rejected", "invalid-frontmatter-yaml", "Knowledge v2 page frontmatter must be valid YAML.");
  }
  if (!isRecord(parsed)) {
    return failure("rejected", "invalid-frontmatter", "Knowledge v2 page frontmatter must be a flat object.");
  }
  return {
    frontmatter: parsed,
    body: lines.slice(closingIndex + 2).join("\n"),
  };
}

function formatFrontmatter(frontmatter: KnowledgePageFrontmatter): string {
  const ordered: Record<string, unknown> = {
    name: frontmatter.name,
    description: frontmatter.description,
    type: frontmatter.type,
  };
  for (const field of OPTIONAL_FRONTMATTER) {
    if (frontmatter[field] !== undefined) {
      ordered[field] = frontmatter[field];
    }
  }
  return stringifyYaml(ordered).trimEnd();
}

export function formatKnowledgePage(frontmatter: KnowledgePageFrontmatter, body: string): string {
  const normalizedBody = body.endsWith("\n") ? body : `${body}\n`;
  return `---\n${formatFrontmatter(frontmatter)}\n---\n\n${normalizedBody}`;
}

function safeRealpath(path: string, fs: KnowledgeUpdateFs): string | undefined {
  try {
    return fs.realpathSync(path);
  } catch {
    return undefined;
  }
}

function walkPageFiles(
  layout: ResolvedKnowledgeV2Layout,
  dir: string,
  pages: ParsedPage[],
  fs: KnowledgeUpdateFs,
): KnowledgeUpdateFailure | undefined {
  let dirents;
  try {
    dirents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    const absPath = join(dir, dirent.name);
    if (dirent.isSymbolicLink()) {
      return failure("rejected", "symlink-escape", "knowledge_update refuses to index symlinked wiki pages.");
    }
    if (dirent.isDirectory()) {
      const problem = walkPageFiles(layout, absPath, pages, fs);
      if (problem) {
        return problem;
      }
      continue;
    }
    if (!dirent.isFile() || extname(absPath).toLowerCase() !== ".md") {
      continue;
    }

    const relPath = toWorkspaceRel(layout.agentWorkspaceRoot, absPath);
    const parsed = parseExistingPage(layout, absPath, relPath, fs);
    if (isUpdateFailure(parsed)) {
      return parsed;
    }
    pages.push(parsed);
  }
  return undefined;
}

function parseExistingPage(
  layout: ResolvedKnowledgeV2Layout,
  absPath: string,
  relPath: string,
  fs: KnowledgeUpdateFs,
): ParsedPage | KnowledgeUpdateFailure {
  const frontmatterResult = parseMarkdownFrontmatter(fs.readFileSync(absPath, "utf8"));
  if (isUpdateFailure(frontmatterResult)) {
    return frontmatterResult;
  }

  const type = pageTypeForRelPath(relPath);
  if (!type) {
    return failure("rejected", "invalid-page-path", "Knowledge v2 pages must live under wiki/pages/<type>/**/*.md.");
  }
  const frontmatter = validateKnowledgePageFrontmatter(frontmatterResult.frontmatter, type);
  if (isUpdateFailure(frontmatter)) {
    return frontmatter;
  }

  const realPagesRoot = safeRealpath(layout.paths.pagesDir, fs);
  const realFile = safeRealpath(absPath, fs);
  if (realPagesRoot && realFile && !isInsidePath(realPagesRoot, realFile)) {
    return failure("rejected", "symlink-escape", "Knowledge v2 page real path escapes wiki/pages.");
  }

  return {
    absPath,
    relPath,
    linkPath: relative(dirname(layout.paths.indexPath), absPath).split(sep).join("/"),
    frontmatter,
  };
}

function collectPages(layout: ResolvedKnowledgeV2Layout, fs: KnowledgeUpdateFs): ParsedPage[] | KnowledgeUpdateFailure {
  const pages: ParsedPage[] = [];
  const problem = walkPageFiles(layout, layout.paths.pagesDir, pages, fs);
  if (problem) {
    return problem;
  }
  return pages.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function pageTypeForRelPath(relPath: string): KnowledgePageType | undefined {
  const parts = relPath.split("/");
  if (parts[0] !== "wiki" || parts[1] !== "pages") {
    return undefined;
  }
  return normalizeType(parts[2]);
}

function escapeIndexText(value: string): string {
  return value.replace(/\s+/g, " ").trim().replace(/\]/g, "\\]");
}

export function generateKnowledgeIndex(pages: readonly ParsedPage[]): string {
  const lines = [
    "# Knowledge Index",
    "",
    "Generated by minime-bot knowledge_update. Do not hand-edit page entries here; update wiki pages through the package helper.",
    "",
  ];

  for (const type of KNOWLEDGE_PAGE_TYPES) {
    lines.push(`## ${TYPE_LABELS[type]}`, "");
    const typePages = pages.filter((page) => page.frontmatter.type === type);
    if (typePages.length === 0) {
      lines.push("_No pages._", "");
      continue;
    }
    for (const page of typePages) {
      lines.push(
        `- [${escapeIndexText(page.frontmatter.name)}](${page.linkPath}) - ${escapeIndexText(page.frontmatter.description)}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function extractMarkdownLinks(markdown: string): string[] {
  const links: string[] = [];
  const pattern = /\[[^\]]+\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(markdown)) !== null) {
    const target = match[1].trim();
    if (target) {
      links.push(target);
    }
  }
  return links;
}

function verifyIndexInvariants(
  layout: ResolvedKnowledgeV2Layout,
  updatedRelPath: string,
  fs: KnowledgeUpdateFs,
): KnowledgeUpdateFailure | undefined {
  const index = fs.readFileSync(layout.paths.indexPath, "utf8");
  const expectedLink = relative(dirname(layout.paths.indexPath), resolve(layout.agentWorkspaceRoot, ...updatedRelPath.split("/")))
    .split(sep)
    .join("/");
  let updatedCount = 0;

  for (const link of extractMarkdownLinks(index)) {
    if (link === expectedLink) {
      updatedCount += 1;
    }
    if (isAbsolute(link) || link.includes("\\") || link.includes("#")) {
      return failure("error", "index-link-invalid", `Knowledge index link is not a plain relative Markdown link: ${link}.`);
    }
    const parts = link.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
      return failure("error", "index-link-invalid", `Knowledge index link escapes the wiki directory: ${link}.`);
    }
    const target = normalize(resolve(dirname(layout.paths.indexPath), ...parts));
    if (!isInsidePath(layout.paths.pagesDir, target) || extname(target).toLowerCase() !== ".md" || !fs.existsSync(target)) {
      return failure("error", "index-link-missing", `Knowledge index link does not resolve to a page: ${link}.`);
    }
  }

  if (updatedCount !== 1) {
    return failure("error", "updated-page-index-count", "Updated page must appear exactly once in wiki/index.md.");
  }

  const pages = collectPages(layout, fs);
  if (isUpdateFailure(pages)) {
    return pages;
  }
  return undefined;
}

function acquireKnowledgeUpdateLock(
  layout: ResolvedKnowledgeV2Layout,
  fs: KnowledgeUpdateFs,
  deps: KnowledgeUpdateDeps,
): LockHandle | KnowledgeUpdateFailure {
  const lockRelPath = ".tmp/knowledge-update.lock" as const;
  const lockPath = join(layout.agentWorkspaceRoot, ".tmp", "knowledge-update.lock");
  const now = deps.now?.() ?? new Date();
  const staleLockMs = deps.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const lockSafetyProblem = assertSafeWorkspaceWritePath(layout.agentWorkspaceRoot, lockPath, fs);
  if (lockSafetyProblem) {
    return lockSafetyProblem;
  }
  fs.mkdirSync(dirname(lockPath), { recursive: true });
  const createdParentSafetyProblem = assertSafeWorkspaceWritePath(layout.agentWorkspaceRoot, lockPath, fs);
  if (createdParentSafetyProblem) {
    return createdParentSafetyProblem;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined;
    let createdLock = false;
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      createdLock = true;
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: now.toISOString(), path: lockRelPath }, null, 2)}\n`, {
        encoding: "utf8",
      });
      if (fd !== undefined) {
        fs.closeSync(fd);
        fd = undefined;
      }
      return {
        path: lockPath,
        relPath: lockRelPath,
        release: () => {
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Lock release is best effort; the next caller has stale-lock recovery.
          }
        },
      };
    } catch (error) {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          // Best effort cleanup after a failed exclusive open.
        }
      }
      if (createdLock) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Best effort cleanup of a lock file this process created but did not initialize.
        }
        return failure("error", "knowledge-update-lock-write-failed", "knowledge_update could not initialize its lock file.");
      }
      if (!fs.existsSync(lockPath)) {
        continue;
      }
      const stale = isStaleLock(lockPath, now, staleLockMs, fs);
      if (stale && attempt === 0) {
        try {
          fs.unlinkSync(lockPath);
          continue;
        } catch {
          return failure("locked", "knowledge-update-locked", "knowledge_update could not remove a stale lock file.");
        }
      }
      return failure("locked", "knowledge-update-locked", "knowledge_update is already running for this agent workspace.");
    }
  }

  return failure("locked", "knowledge-update-locked", "knowledge_update could not acquire its workspace lock.");
}

function isStaleLock(lockPath: string, now: Date, staleLockMs: number, fs: KnowledgeUpdateFs): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as { acquiredAt?: unknown };
    if (typeof parsed.acquiredAt === "string") {
      const acquiredAt = Date.parse(parsed.acquiredAt);
      return Number.isFinite(acquiredAt) && now.getTime() - acquiredAt > staleLockMs;
    }
  } catch {
    // Fall back to mtime below.
  }

  try {
    return now.getTime() - fs.statSync(lockPath).mtimeMs > staleLockMs;
  } catch {
    return false;
  }
}

function tempPathFor(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
}

function readPreviousFile(path: string, fs: KnowledgeUpdateFs): { existed: boolean; previousContent?: string } {
  if (!fs.existsSync(path)) {
    return { existed: false };
  }
  return { existed: true, previousContent: fs.readFileSync(path, "utf8") };
}

function rollbackCommittedWrites(plans: AtomicWritePlan[], fs: KnowledgeUpdateFs): void {
  for (const plan of plans.slice().reverse()) {
    if (!plan.committed) {
      continue;
    }
    try {
      if (plan.existed) {
        fs.writeFileSync(plan.path, plan.previousContent ?? "", { encoding: "utf8" });
      } else {
        fs.unlinkSync(plan.path);
      }
    } catch {
      // Preserve the original failure; rollback is best effort.
    }
  }
}

function atomicWriteFiles(writes: AtomicWrite[], fs: KnowledgeUpdateFs): AtomicWritePlan[] {
  const seen = new Set<string>();
  const plans = writes.map((write) => {
    if (seen.has(write.path)) {
      throw new Error(`duplicate atomic write path: ${write.path}`);
    }
    seen.add(write.path);
    return {
      ...write,
      tempPath: tempPathFor(write.path),
      ...readPreviousFile(write.path, fs),
      committed: false,
    };
  });

  try {
    for (const plan of plans) {
      fs.mkdirSync(dirname(plan.path), { recursive: true });
      fs.writeFileSync(plan.tempPath, plan.content, { encoding: "utf8" });
    }
    for (const plan of plans) {
      fs.renameSync(plan.tempPath, plan.path);
      plan.committed = true;
    }
    return plans;
  } catch (error) {
    for (const plan of plans) {
      if (!plan.committed) {
        try {
          fs.unlinkSync(plan.tempPath);
        } catch {
          // Best effort cleanup of same-directory staging files.
        }
      }
    }
    rollbackCommittedWrites(plans, fs);
    throw error;
  }
}

function actionForOperation(operation: KnowledgeUpdateOperation, existed: boolean): KnowledgeUpdateAction | KnowledgeUpdateFailure {
  if (operation === "create") {
    return existed
      ? failure("rejected", "page-exists", "knowledge_update create refused to overwrite an existing page.")
      : "created";
  }
  if (operation === "update") {
    return existed
      ? "updated"
      : failure("rejected", "page-missing", "knowledge_update update requires an existing page.");
  }
  return existed ? "updated" : "created";
}

function appendStructuralLog(existingLog: string, action: KnowledgeUpdateAction, relPath: string, now: Date): string {
  if (action !== "created") {
    return existingLog;
  }
  const base = existingLog.endsWith("\n") || existingLog.length === 0 ? existingLog : `${existingLog}\n`;
  return `${base}- ${now.toISOString()} create ${relPath}\n`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function executeKnowledgeUpdate(args: KnowledgeUpdateArgs = {}, deps: KnowledgeUpdateDeps = {}): KnowledgeUpdateResponse {
  const fs = fsForDeps(deps);
  let lock: LockHandle | undefined;

  try {
    const operation = normalizeOperation(args.op ?? args.operation);
    if (!operation) {
      return failure("rejected", "invalid-operation", "knowledge_update op must be create, update, or upsert.");
    }

    const type = normalizeType(args.type);
    if (!type) {
      return failure("rejected", "invalid-type", "knowledge_update type must be user, project, feedback, or reference.");
    }

    const frontmatter = validateKnowledgePageFrontmatter(args.frontmatter, type);
    if (isUpdateFailure(frontmatter)) {
      return frontmatter;
    }

    const body = markdownBody(args.body);
    if (typeof body !== "string") {
      return body;
    }

    const layout = resolveLayoutForDeps(deps);
    if (isKnowledgeFailure(layout)) {
      return layout;
    }
    if (layout.kind !== "v2") {
      return failure(
        "unsupported",
        "knowledge-update-requires-v2",
        "knowledge_update writes only to positively detected Knowledge v2 workspaces.",
        layout.kind,
      );
    }

    const acquiredLock = acquireKnowledgeUpdateLock(layout, fs, deps);
    if (isUpdateFailure(acquiredLock)) {
      return acquiredLock;
    }
    lock = acquiredLock;
    const lockRelPath = lock.relPath;

    const relPath = resolveTargetRelPath(args, type);
    if (typeof relPath !== "string") {
      return relPath;
    }
    const absPath = assertTargetPath(layout, relPath, type, fs);
    if (typeof absPath !== "string") {
      return absPath;
    }

    const existed = fs.existsSync(absPath);
    const action = actionForOperation(operation, existed);
    if (typeof action !== "string") {
      return action;
    }

    if (existed) {
      const stat = fs.lstatSync(absPath);
      if (!stat.isFile()) {
        return failure("rejected", "target-not-file", "knowledge_update target must be a regular Markdown file.");
      }
    }

    const pageContent = formatKnowledgePage(frontmatter, body);
    const beforePages = collectPages(layout, fs);
    if (isUpdateFailure(beforePages)) {
      return beforePages;
    }

    const pageForIndex: ParsedPage = {
      absPath,
      relPath,
      linkPath: relative(dirname(layout.paths.indexPath), absPath).split(sep).join("/"),
      frontmatter,
    };
    const pagesByPath = new Map(beforePages.map((page) => [page.relPath, page]));
    pagesByPath.set(relPath, pageForIndex);
    const nextPages = [...pagesByPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
    const indexContent = generateKnowledgeIndex(nextPages);
    const indexSafetyProblem = assertSafeWorkspaceWritePath(layout.agentWorkspaceRoot, layout.paths.indexPath, fs);
    if (indexSafetyProblem) {
      return indexSafetyProblem;
    }
    const logSafetyProblem =
      assertSafeWorkspaceWritePath(layout.agentWorkspaceRoot, layout.paths.logPath, fs) ??
      assertRegularFileIfExists(layout.paths.logPath, fs, "knowledge_update log path must be a regular Markdown file.");
    if (logSafetyProblem) {
      return logSafetyProblem;
    }
    const existingLog = fs.existsSync(layout.paths.logPath) ? fs.readFileSync(layout.paths.logPath, "utf8") : "";
    const now = deps.now?.() ?? new Date();
    const logContent = appendStructuralLog(existingLog, action, relPath, now);
    const writes: AtomicWrite[] = [
      { path: absPath, content: pageContent },
      { path: layout.paths.indexPath, content: indexContent },
    ];
    if (logContent !== existingLog) {
      writes.push({ path: layout.paths.logPath, content: logContent });
    }

    const plans = atomicWriteFiles(writes, fs);
    try {
      const invariantProblem = verifyIndexInvariants(layout, relPath, fs);
      if (invariantProblem) {
        rollbackCommittedWrites(plans, fs);
        return invariantProblem;
      }
      deps.refreshSearchBackend?.(layout);
    } catch (error) {
      rollbackCommittedWrites(plans, fs);
      return failure("error", "knowledge-update-verify-failed", `knowledge_update verification failed: ${errorMessage(error)}`);
    }

    return {
      ok: true,
      layoutKind: "v2",
      operation,
      action,
      path: relPath,
      indexPath: "wiki/index.md",
      ...(logContent !== existingLog ? { logPath: "wiki/log.md" as const } : {}),
      lockPath: lockRelPath,
      frontmatter,
    };
  } catch (error) {
    return failure("error", "knowledge-update-failed", `knowledge_update failed: ${errorMessage(error)}`);
  } finally {
    lock?.release();
  }
}

export function formatKnowledgeUpdateResponse(response: KnowledgeUpdateResponse): string {
  return JSON.stringify(response, null, 2);
}
