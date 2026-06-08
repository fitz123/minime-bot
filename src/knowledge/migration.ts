import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep, posix } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  KNOWLEDGE_PAGE_TYPES,
  type KnowledgePageType,
  generateKnowledgeV2Schema,
  parseKnowledgeV2SchemaMarker,
  resolveKnowledgeLayout,
  type ResolvedKnowledgeLayout,
} from "./layout.js";
import {
  formatKnowledgePage,
  generateKnowledgeIndex,
  validateKnowledgePageFrontmatter,
  type KnowledgePageFrontmatter,
  type KnowledgeUpdateFailure,
  type ParsedPage,
} from "./update.js";
import { MINIME_AGENT_WORKSPACE_CWD_ENV } from "../workspace-contract.js";

export type KnowledgeMigrationMode = "dry-run" | "apply";
export type KnowledgeMigrationReviewKind =
  | "operator_review"
  | "type_review"
  | "secret_review"
  | "out_of_scope";

export interface KnowledgeMigrationArgs {
  dryRun?: unknown;
  apply?: unknown;
  allowDirty?: unknown;
  reportPath?: unknown;
}

export interface KnowledgeMigrationDeps {
  agentWorkspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  resolveLayout?: (agentWorkspaceRoot: string) => ResolvedKnowledgeLayout;
}

export interface KnowledgeMigrationOperation {
  action: "write" | "copy";
  role:
    | "schema"
    | "index"
    | "log"
    | "issues"
    | "wiki_page"
    | "diary"
    | "artifact";
  sourcePath?: string;
  targetPath: string;
  reason: string;
}

export interface KnowledgeMigrationReviewItem {
  kind: KnowledgeMigrationReviewKind;
  path: string;
  reason: string;
  message: string;
  suggestedTarget?: string;
  blocking: boolean;
}

export interface KnowledgeMigrationSummary {
  operations: number;
  pages: number;
  diaryEntries: number;
  artifacts: number;
  reviewItems: number;
  outOfScope: number;
  blockers: number;
  applied: boolean;
}

export interface KnowledgeMigrationSuccess {
  ok: true;
  mode: KnowledgeMigrationMode;
  layoutKind: ResolvedKnowledgeLayout["kind"];
  workspace: string;
  operations: KnowledgeMigrationOperation[];
  reviewItems: KnowledgeMigrationReviewItem[];
  summary: KnowledgeMigrationSummary;
  humanSummary: string;
  reportPath?: string;
  reportError?: string;
}

export interface KnowledgeMigrationFailure {
  ok: false;
  status: "unavailable" | "rejected" | "error";
  reason: string;
  message: string;
  mode?: KnowledgeMigrationMode;
  layoutKind?: ResolvedKnowledgeLayout["kind"];
  workspace?: string;
  operations?: KnowledgeMigrationOperation[];
  reviewItems?: KnowledgeMigrationReviewItem[];
  summary?: KnowledgeMigrationSummary;
  humanSummary?: string;
  reportPath?: string;
  reportError?: string;
}

export type KnowledgeMigrationResponse = KnowledgeMigrationSuccess | KnowledgeMigrationFailure;

interface InternalOperation extends KnowledgeMigrationOperation {
  absTargetPath: string;
  content: string;
  allowOverwrite: boolean;
}

interface MarkdownParts {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface LegacyMemorySection {
  title: string;
  body: string;
}

interface MutablePlan {
  layout: ResolvedKnowledgeLayout;
  workspaceRoot: string;
  operations: InternalOperation[];
  targetSources: Map<string, string>;
  sourceTargets: Map<string, string>;
  reviewItems: KnowledgeMigrationReviewItem[];
  handledSources: Set<string>;
  now: Date;
}

const PAGE_TYPES = new Set<string>(KNOWLEDGE_PAGE_TYPES);
const FRIEND_PROFILE_SLUGS = new Set([
  "about",
  "preferences",
  "relationships",
  "relationship",
  "communication",
  "interests",
  "events",
  "context",
]);
const SKIP_SCAN_DIRS = new Set([".git", "node_modules", "dist"]);
const HIDDEN_RUNTIME_PREFIXES = [".tmp/", ".playwright-mcp/", ".council/", ".ralphex/"];
const ROOT_DOC_RE = /^(README|CHANGELOG|AGENTS|CLAUDE|USER|IDENTITY)(?:\.[^.]+)?\.md$/i;
const ROOT_STATUS_DOC_RE = /^(?:(?:.+[-_])?status)\.md$/i;
const BEADS_METADATA_RE = /^(?:\.beads|beads)(?:\/|$)/i;
const NIX_TREE_RE = /(?:^nix(?:os)?\/|^flake\.(?:nix|lock)$|\.nix$)/i;
const DOMAIN_CLIENT_TRAINING_TREE_RE = /^(?:pilot|cyber-genpodryad|dolt|domain|domains|client|clients|training|trainings|docs)\//i;
const ACTIVE_RUNTIME_STATE_RE = /^(?:\.claude\/|(?:config|crons)(?:\.local)?\.ya?ml$|scripts\/|package(?:-lock)?\.json$)/i;
const MEDIA_OR_STRUCTURED_STATE_RE = /(?:\.sqlite3$|\.(?:png|jpe?g|gif|webp|pdf)$)/i;
const LEGACY_WIKI_CONTROL_PATHS = ["wiki/schema.md", "wiki/index.md", "wiki/log.md"] as const;
const SECRET_PATTERNS = [
  /(?:password|secret|token|api[_-]?key|private[_-]?key|pin|payment|card(?: number)?|credential)\s*[:=]\s*\S{4,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-[A-Za-z0-9_-]{10,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\b(?:AKIA|ASIA|A3T[A-Z0-9])[A-Z0-9]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
];

function failure(
  status: KnowledgeMigrationFailure["status"],
  reason: string,
  message: string,
  extra: Partial<KnowledgeMigrationFailure> = {},
): KnowledgeMigrationFailure {
  return { ok: false, status, reason, message, ...extra };
}

function flagEnabled(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === "yes";
}

function normalizeMode(args: KnowledgeMigrationArgs): KnowledgeMigrationMode | KnowledgeMigrationFailure {
  const apply = flagEnabled(args.apply);
  const dryRun = args.dryRun === undefined ? !apply : flagEnabled(args.dryRun);
  if (apply && dryRun) {
    return failure(
      "rejected",
      "knowledge-migration-mode-conflict",
      "knowledge migrate accepts apply or dry-run, not both.",
    );
  }
  return apply ? "apply" : "dry-run";
}

function resolveAgentWorkspaceRoot(deps: KnowledgeMigrationDeps): string | undefined {
  const env = deps.env ?? process.env;
  const root =
    deps.agentWorkspaceRoot ??
    env[MINIME_AGENT_WORKSPACE_CWD_ENV];
  return typeof root === "string" && root.trim() ? normalize(resolve(root)) : undefined;
}

function toWorkspaceRel(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}

function workspacePath(root: string, relPath: string): string {
  return join(root, ...relPath.split("/"));
}

function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function normalizeRelPath(relPath: string): string | undefined {
  const normalized = posix.normalize(relPath.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === ".." || posix.isAbsolute(normalized)) {
    return undefined;
  }
  return normalized;
}

function isMarkdownRelPath(relPath: string): boolean {
  const extension = extname(relPath).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

function isRootRelPath(relPath: string): boolean {
  return !relPath.includes("/");
}

function readText(root: string, relPath: string): string {
  return readFileSync(workspacePath(root, relPath), "utf8");
}

function contentHasSecret(content: string): boolean {
  const normalized = content.replace(/<REDACTED>/gi, "x");
  return SECRET_PATTERNS.some((pattern) => pattern.test(normalized));
}

function addReview(plan: MutablePlan, item: KnowledgeMigrationReviewItem): void {
  const key = `${item.kind}:${item.reason}:${item.path}:${item.suggestedTarget ?? ""}`;
  const exists = plan.reviewItems.some((existing) => (
    `${existing.kind}:${existing.reason}:${existing.path}:${existing.suggestedTarget ?? ""}` === key
  ));
  if (!exists) {
    plan.reviewItems.push(item);
  }
}

function isReviewItem(value: Record<string, unknown> | KnowledgeMigrationReviewItem): value is KnowledgeMigrationReviewItem {
  return (
    typeof value.kind === "string" &&
    typeof value.reason === "string" &&
    typeof value.message === "string" &&
    typeof value.blocking === "boolean"
  );
}

function isFrontmatterFailure(
  value: KnowledgePageFrontmatter | KnowledgeUpdateFailure,
): value is KnowledgeUpdateFailure {
  return "ok" in value && value.ok === false;
}

function expectedPageTypeFromTarget(targetPath: string): KnowledgePageType | undefined {
  const parts = targetPath.split("/");
  return parts[0] === "wiki" && parts[1] === "pages" && PAGE_TYPES.has(parts[2])
    ? (parts[2] as KnowledgePageType)
    : undefined;
}

function reviewForInvalidPlannedPageTarget(
  sourcePath: string | undefined,
  targetPath: string,
): KnowledgeMigrationReviewItem {
  return {
    kind: "type_review",
    path: sourcePath ?? "<generated>",
    suggestedTarget: targetPath,
    reason: "invalid_wiki_page_target_type",
    message: `Planned wiki page target ${targetPath} must be under wiki/pages/<type>/ with a known page type.`,
    blocking: true,
  };
}

function reviewForPlannedPageFrontmatterFailure(
  sourcePath: string | undefined,
  targetPath: string,
  frontmatterFailure: KnowledgeUpdateFailure,
): KnowledgeMigrationReviewItem {
  const reason = frontmatterFailure.reason === "frontmatter-type-mismatch"
    ? "frontmatter_target_type_mismatch"
    : frontmatterFailure.reason;
  const message = reason === "frontmatter_target_type_mismatch"
    ? `Planned wiki page target ${targetPath} disagrees with the page frontmatter type; operator review must choose the target path or page type.`
    : `Planned wiki page frontmatter failed validation: ${frontmatterFailure.message}`;
  return {
    kind: "type_review",
    path: sourcePath ?? "<generated>",
    suggestedTarget: targetPath,
    reason,
    message,
    blocking: true,
  };
}

function validatePlannedPageFrontmatter(
  sourcePath: string | undefined,
  targetPath: string,
  content: string,
): { frontmatter: KnowledgePageFrontmatter } | { reviewItem: KnowledgeMigrationReviewItem } {
  const parsed = parseMarkdown(content);
  const expectedType = expectedPageTypeFromTarget(targetPath);
  if (!expectedType) {
    return {
      reviewItem: reviewForInvalidPlannedPageTarget(sourcePath, targetPath),
    };
  }
  const frontmatter = validateKnowledgePageFrontmatter(parsed.frontmatter, expectedType);
  if (isFrontmatterFailure(frontmatter)) {
    return {
      reviewItem: reviewForPlannedPageFrontmatterFailure(sourcePath, targetPath, frontmatter),
    };
  }
  return { frontmatter };
}

function markHandled(plan: MutablePlan, relPath: string): void {
  plan.handledSources.add(relPath);
}

function publicOperations(operations: readonly InternalOperation[]): KnowledgeMigrationOperation[] {
  return operations.map(({ action, role, sourcePath, targetPath, reason }) => ({
    action,
    role,
    ...(sourcePath ? { sourcePath } : {}),
    targetPath,
    reason,
  }));
}

function sameContentIfExists(root: string, relPath: string, content: string): boolean {
  const path = workspacePath(root, relPath);
  return existsSync(path) && readFileSync(path, "utf8") === content;
}

function sameRegularFileContentIfExists(root: string, relPath: string, content: string): boolean {
  const path = workspacePath(root, relPath);
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink() && readFileSync(path, "utf8") === content;
  } catch {
    return false;
  }
}

function unsafeWriteTargetReason(workspaceRoot: string, absTargetPath: string): string | undefined {
  const normalizedRoot = normalize(resolve(workspaceRoot));
  const normalizedTarget = normalize(resolve(absTargetPath));
  if (!isInsidePath(normalizedRoot, normalizedTarget)) {
    return "Migration target escapes the agent workspace.";
  }

  const realWorkspaceRoot = safeRealpath(normalizedRoot);
  if (!realWorkspaceRoot) {
    return "Migration workspace root cannot be resolved.";
  }

  let current = normalizedRoot;
  const relParts = relative(normalizedRoot, normalizedTarget).split(sep).filter(Boolean);
  for (const part of relParts) {
    current = join(current, part);
    if (!existsSync(current)) {
      continue;
    }
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        return "Migration apply refuses to write through symlinked target paths.";
      }
    } catch {
      return "Migration target path cannot be inspected.";
    }
    const realCurrent = safeRealpath(current);
    if (!realCurrent || !isInsidePath(realWorkspaceRoot, realCurrent)) {
      return "Migration target real path escapes the agent workspace.";
    }
  }

  return undefined;
}

function addWrite(
  plan: MutablePlan,
  operation: Omit<KnowledgeMigrationOperation, "action"> & { action?: "write" | "copy" },
  content: string,
  options: { allowOverwrite?: boolean } = {},
): void {
  const targetPath = normalizeRelPath(operation.targetPath);
  if (!targetPath) {
    addReview(plan, {
      kind: "operator_review",
      path: operation.sourcePath ?? operation.targetPath,
      suggestedTarget: operation.targetPath,
      reason: "invalid_target_path",
      message: "Migration target is not a safe workspace-relative path.",
      blocking: true,
    });
    return;
  }

  const absTargetPath = workspacePath(plan.workspaceRoot, targetPath);
  const unsafeTargetReason = unsafeWriteTargetReason(plan.workspaceRoot, absTargetPath);
  if (unsafeTargetReason) {
    addReview(plan, {
      kind: "operator_review",
      path: operation.sourcePath ?? operation.targetPath,
      suggestedTarget: targetPath,
      reason: "symlink_escape",
      message: unsafeTargetReason,
      blocking: true,
    });
    return;
  }

  if (operation.role === "wiki_page") {
    const validatedPage = validatePlannedPageFrontmatter(operation.sourcePath, targetPath, content);
    if ("reviewItem" in validatedPage) {
      addReview(plan, validatedPage.reviewItem);
      return;
    }
  }

  const sourceLabel = operation.sourcePath ?? "<generated>";
  const existingSource = plan.targetSources.get(targetPath);
  if (existingSource && !sameContentIfExists(plan.workspaceRoot, targetPath, content)) {
    addReview(plan, {
      kind: "type_review",
      path: sourceLabel,
      suggestedTarget: targetPath,
      reason: "slug_collision",
      message: `Multiple sources route to ${targetPath}; operator must choose a conflict-free page.`,
      blocking: true,
    });
    return;
  }
  if (existingSource) {
    return;
  }

  if (existsSync(workspacePath(plan.workspaceRoot, targetPath)) && !options.allowOverwrite) {
    if (sameContentIfExists(plan.workspaceRoot, targetPath, content)) {
      return;
    }
    addReview(plan, {
      kind: "operator_review",
      path: sourceLabel,
      suggestedTarget: targetPath,
      reason: "target_exists",
      message: `Migration target already exists: ${targetPath}.`,
      blocking: true,
    });
    return;
  }

  plan.targetSources.set(targetPath, sourceLabel);
  if (operation.sourcePath) {
    plan.sourceTargets.set(operation.sourcePath, targetPath);
  }
  plan.operations.push({
    action: operation.action ?? "write",
    role: operation.role,
    sourcePath: operation.sourcePath,
    targetPath,
    reason: operation.reason,
    absTargetPath,
    content,
    allowOverwrite: options.allowOverwrite ?? false,
  });
}

function uniqueTarget(plan: MutablePlan, wantedRelPath: string): string {
  const normalized = normalizeRelPath(wantedRelPath) ?? wantedRelPath;
  if (!plan.targetSources.has(normalized) && !existsSync(workspacePath(plan.workspaceRoot, normalized))) {
    return normalized;
  }
  const dir = posix.dirname(normalized);
  const extension = extname(normalized);
  const base = basename(normalized, extension);
  for (let i = 2; i < 100; i += 1) {
    const candidate = posix.join(dir, `${base}-${i}${extension}`);
    if (!plan.targetSources.has(candidate) && !existsSync(workspacePath(plan.workspaceRoot, candidate))) {
      return candidate;
    }
  }
  return normalized;
}

function parseMarkdown(markdown: string): MarkdownParts {
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { frontmatter: {}, body: normalized };
  }
  const closing = normalized.indexOf("\n---", 4);
  if (closing < 0) {
    return { frontmatter: {}, body: normalized };
  }
  const yaml = normalized.slice(4, closing);
  const after = normalized.slice(closing + 4).replace(/^\n/, "");
  try {
    const parsed = parseYaml(yaml);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body: after };
    }
  } catch {
    return { frontmatter: {}, body: normalized };
  }
  return { frontmatter: {}, body: after };
}

function flattenLegacyFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> | KnowledgeMigrationReviewItem {
  const flat: Record<string, unknown> = { ...frontmatter };
  const metadata = flat.metadata;
  delete flat.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return flat;
  }
  for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (key === "node_type") {
      continue;
    }
    if (flat[key] !== undefined && flat[key] !== value) {
      return {
        kind: "type_review",
        path: "",
        reason: "frontmatter_conflict",
        message: `Legacy frontmatter metadata.${key} conflicts with top-level ${key}.`,
        blocking: true,
      };
    }
    flat[key] = value;
  }
  return flat;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

function firstSentence(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed === "---") {
      continue;
    }
    return trimmed.replace(/\s+/g, " ").slice(0, 160);
  }
  return undefined;
}

function humanizeSlug(slug: string): string {
  return slug
    .replace(/\.[^.]+$/, "")
    .replace(/^project_/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled";
}

function targetSlug(name: string, fallbackSlug: string): string {
  const slug = slugify(name);
  return slug === "untitled" ? slugify(fallbackSlug) : slug;
}

function rawType(value: unknown): string | undefined {
  return scalarString(value)?.toLowerCase().replace(/[_-]/g, "-");
}

function normalizePageType(value: unknown): KnowledgePageType | undefined {
  const type = rawType(value);
  return type && PAGE_TYPES.has(type) ? (type as KnowledgePageType) : undefined;
}

function looksFriendProfileLike(slug: string): boolean {
  const parts = slug.toLowerCase().split(/[/_-]+/);
  return parts.some((part) => FRIEND_PROFILE_SLUGS.has(part));
}

function inferPageType(sourceRel: string, frontmatter: Record<string, unknown>, body: string): KnowledgePageType | undefined {
  const explicit = normalizePageType(frontmatter.type ?? frontmatter.page_type ?? frontmatter.kind ?? frontmatter.category);
  if (explicit) {
    return explicit;
  }
  const slug = basename(sourceRel, extname(sourceRel)).toLowerCase();
  const text = `${sourceRel}\n${body}`.toLowerCase();
  if (slug.startsWith("project_") || /\b(project|status|workstream|initiative)\b/.test(text)) {
    return "project";
  }
  if (/\b(runbook|command reference|operational command|deploy script|one-off plan|execution plan|task plan)\b/.test(text)) {
    return "project";
  }
  if (/\b(feedback|correction|critique|do not|should not|never|preference correction|principles?|lessons?)\b/.test(text)) {
    return "feedback";
  }
  if (slug === "facts" || /\bfacts\b/.test(text)) {
    return "user";
  }
  if (/\b(pet|animal|cat|dog|curriculum|learning plan|course)\b/.test(text)) {
    return text.includes("treatment") || text.includes("medical") || text.includes("active plan") ? "project" : "user";
  }
  return undefined;
}

function frontmatterForSource(
  sourceRel: string,
  markdown: string,
): { frontmatter: KnowledgePageFrontmatter; body: string } | KnowledgeMigrationReviewItem {
  const parsed = parseMarkdown(markdown);
  const flattened = flattenLegacyFrontmatter(parsed.frontmatter);
  if (isReviewItem(flattened)) {
    return { ...flattened, path: sourceRel };
  }

  const legacyType = rawType(
    flattened.type ?? flattened.page_type ?? flattened.kind ?? flattened.category,
  );
  const baseSlug = basename(sourceRel, extname(sourceRel));
  if (legacyType === "reference" && looksFriendProfileLike(baseSlug)) {
    return {
      kind: "type_review",
      path: sourceRel,
      reason: "profile_reference_type_review",
      message: "Profile-like legacy reference pages need operator review before routing to user pages.",
      blocking: true,
    };
  }

  const type = inferPageType(sourceRel, flattened, parsed.body);
  if (!type) {
    return {
      kind: "type_review",
      path: sourceRel,
      reason: "missing_or_unknown_type",
      message: "Legacy page has no v2 page type that can be inferred safely.",
      blocking: true,
    };
  }

  const title = scalarString(flattened.name) ?? scalarString(flattened.title) ?? firstHeading(parsed.body) ?? humanizeSlug(baseSlug);
  const description =
    scalarString(flattened.description) ??
    scalarString(flattened.summary) ??
    firstSentence(parsed.body) ??
    `Migrated from ${sourceRel}.`;
  const candidate: Record<string, unknown> = {
    name: title,
    description,
    type,
  };
  for (const field of ["confidence", "revisit_if", "originSessionId"] as const) {
    if (flattened[field] !== undefined) {
      candidate[field] = flattened[field];
    }
  }

  const validated = validateKnowledgePageFrontmatter(candidate, type);
  if (isFrontmatterFailure(validated)) {
    return {
      kind: "type_review",
      path: sourceRel,
      reason: validated.reason,
      message: validated.message,
      blocking: true,
    };
  }
  return { frontmatter: validated, body: parsed.body };
}

function relativeWorkspaceLink(fromRelPath: string, toRelPath: string): string {
  const fromDir = posix.dirname(fromRelPath);
  const rel = posix.relative(fromDir, toRelPath);
  return rel === "" ? posix.basename(toRelPath) : rel;
}

function migratedTopicWikiTarget(sourceRel: string): string | undefined {
  if (!sourceRel.startsWith("wiki/") || sourceRel.startsWith("wiki/pages/")) {
    return undefined;
  }
  if (
    sourceRel === "wiki/schema.md" ||
    sourceRel === "wiki/index.md" ||
    sourceRel === "wiki/log.md" ||
    sourceRel === "wiki/issues.md"
  ) {
    return undefined;
  }
  if (!isMarkdownRelPath(sourceRel)) {
    return undefined;
  }
  const parts = sourceRel.split("/");
  if (parts.length < 3 || parts[0] !== "wiki") {
    return undefined;
  }
  const topic = slugify(parts[1]);
  const subpath = parts.slice(2).join("/");
  const landing = /^(README|index)$/i.test(basename(subpath, extname(subpath))) || slugify(basename(subpath, extname(subpath))) === topic;
  return landing
    ? `wiki/pages/project/${topic}/README.md`
    : `wiki/pages/project/${topic}/${subpath}`;
}

function deterministicMigratedTarget(plan: MutablePlan, sourceRel: string): string | undefined {
  const alreadyPlanned = plan.sourceTargets.get(sourceRel);
  if (alreadyPlanned) {
    return alreadyPlanned;
  }
  if (sourceRel.startsWith("memory/diary/") && isMarkdownRelPath(sourceRel)) {
    return `diary/${sourceRel.slice("memory/diary/".length)}`;
  }
  return migratedTopicWikiTarget(sourceRel);
}

function rewriteMarkdownLinks(body: string, sourceRel: string, targetRel: string, plan: MutablePlan): string {
  return body.replace(/\]\(([^)]+)\)/g, (full, rawTarget: string) => {
    const target = rawTarget.trim();
    if (
      !target ||
      target.startsWith("#") ||
      target.startsWith("/") ||
      /^[a-z][a-z0-9+.-]*:/i.test(target)
    ) {
      return full;
    }
    const [pathPart, ...fragmentParts] = target.split("#");
    const sourceTarget = normalizeRelPath(posix.join(posix.dirname(sourceRel), pathPart));
    if (!sourceTarget) {
      return full;
    }
    const fragment = fragmentParts.length > 0 ? `#${fragmentParts.join("#")}` : "";
    const migratedTarget = deterministicMigratedTarget(plan, sourceTarget) ?? sourceTarget;
    return `](${relativeWorkspaceLink(targetRel, migratedTarget)}${fragment})`;
  });
}

function bodyWithProvenance(
  plan: MutablePlan,
  sourceRel: string,
  targetRel: string,
  frontmatter: KnowledgePageFrontmatter,
  rawBody: string,
): string {
  const rewritten = rewriteMarkdownLinks(rawBody.trim(), sourceRel, targetRel, plan);
  const body = rewritten.length > 0 ? rewritten : `# ${frontmatter.name}`;
  const sourceLink = relativeWorkspaceLink(targetRel, sourceRel);
  return `${body}\n\nSource: [${sourceRel}](${sourceLink}).\n`;
}

function projectTopicFromLegacySlug(slug: string): string | undefined {
  const match = /^project[_-]([a-z0-9][a-z0-9._-]*)$/i.exec(slug);
  return match ? slugify(match[1]) : undefined;
}

function participantTopicFromLegacySlug(slug: string): string | undefined {
  const match = /^project[_-]([a-z0-9][a-z0-9._-]*)[_-](participants|roster|team)$/i.exec(slug);
  return match ? slugify(match[1]) : undefined;
}

function classifyLegacyTarget(
  plan: MutablePlan,
  sourceRel: string,
  frontmatter: KnowledgePageFrontmatter,
  body: string,
): string | KnowledgeMigrationReviewItem {
  const slug = basename(sourceRel, extname(sourceRel));
  const lower = `${sourceRel}\n${frontmatter.name}\n${body}`.toLowerCase();
  const pageSlug = targetSlug(frontmatter.name, slug);
  if (frontmatter.type === "feedback") {
    return `wiki/pages/feedback/${pageSlug}.md`;
  }
  if (frontmatter.type === "user") {
    return `wiki/pages/user/${pageSlug}.md`;
  }
  const participantTopic = participantTopicFromLegacySlug(slug);
  if (participantTopic) {
    return `wiki/pages/project/${participantTopic}/participants.md`;
  }
  const projectTopic = projectTopicFromLegacySlug(slug);
  if (projectTopic) {
    return uniqueTarget(plan, `wiki/pages/project/${projectTopic}/status.md`);
  }
  if (/\b(runbook|command reference|operational command|deploy script)\b/.test(lower)) {
    return {
      kind: "operator_review",
      path: sourceRel,
      suggestedTarget: `artifacts/runbooks/${pageSlug}.md`,
      reason: "active_runbook_review",
      message: "Command-level runbooks stay active or move to artifacts only after operator review.",
      blocking: true,
    };
  }
  if (/\b(one-off plan|execution plan|task plan)\b/.test(lower)) {
    return {
      kind: "operator_review",
      path: sourceRel,
      suggestedTarget: `artifacts/plans/${pageSlug}.md`,
      reason: "one_off_plan_artifact",
      message: "One-off execution plans route to artifacts/plans rather than wiki pages.",
      blocking: true,
    };
  }
  if (/\b(pet|animal)\b/.test(lower)) {
    if (/\b(treatment|medical|medicine|active plan|health)\b/.test(lower)) {
      return `wiki/pages/project/health/${pageSlug}-status.md`;
    }
    return `wiki/pages/user/pets/${pageSlug}.md`;
  }
  if (/\b(curriculum|learning plan|course plan)\b/.test(lower)) {
    return `wiki/pages/project/learning/${pageSlug}-status.md`;
  }
  if (frontmatter.type === "reference") {
    return `wiki/pages/reference/${pageSlug}.md`;
  }
  return `wiki/pages/project/${pageSlug}.md`;
}

function extractPendingReview(memoryMarkdown: string): string | undefined {
  const lines = memoryMarkdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+pending review\b/i.exec(lines[i]);
    if (match) {
      start = i;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) {
    return undefined;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[i]);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join("\n").trim();
  return section ? `${section}\n` : undefined;
}

function removePendingReview(memoryMarkdown: string): string {
  const lines = memoryMarkdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+pending review\b/i.exec(lines[i]);
    if (match) {
      start = i;
      level = match[1].length;
      break;
    }
  }
  if (start < 0) {
    return memoryMarkdown;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const match = /^(#{1,6})\s+/.exec(lines[i]);
    if (match && match[1].length <= level) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

function splitLegacyMemorySections(memoryMarkdown: string): LegacyMemorySection[] {
  const lines = memoryMarkdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const sections: Array<{ title: string; bodyLines: string[] }> = [];
  const prelude: string[] = [];
  let current: { title: string; bodyLines: string[] } | undefined;

  const pushCurrent = (): void => {
    if (current) {
      sections.push(current);
      current = undefined;
    }
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading && heading[1].length <= 2) {
      const title = heading[2].trim();
      if (!current && sections.length === 0 && prelude.length === 0 && /^legacy\s+memory$|^memory$/i.test(title)) {
        continue;
      }
      pushCurrent();
      current = { title, bodyLines: [] };
      continue;
    }

    if (current) {
      current.bodyLines.push(line);
    } else {
      prelude.push(line);
    }
  }
  pushCurrent();

  const normalizedSections = sections
    .map((section) => ({ title: section.title, body: section.bodyLines.join("\n").trim() }))
    .filter((section) => section.title.trim() || section.body.trim());

  const preludeBody = prelude.join("\n").trim();
  if (preludeBody) {
    normalizedSections.unshift({ title: "Unclassified MEMORY.md", body: preludeBody });
  }

  return normalizedSections;
}

const MARKDOWN_LINK_RE = /\[[^\]]+\]\([^)]+\)/;

function isCatalogLinkLine(line: string): boolean {
  const item = line
    .replace(/^[-*]\s+/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .trim();
  return /^\[[^\]]+\]\([^)]+\)(?:(?:\s*[-:]\s*|\s+).+)?$/.test(item);
}

function markdownTableCells(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) {
    return [];
  }
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isMarkdownTableRow(line: string): boolean {
  return markdownTableCells(line).length >= 2;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = markdownTableCells(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isSimpleCatalogTable(lines: readonly string[]): boolean {
  if (lines.length < 2 || !lines.every(isMarkdownTableRow)) {
    return false;
  }
  const separatorIndex = lines.findIndex(isMarkdownTableSeparator);
  if (separatorIndex < 0 || !lines.some((line) => MARKDOWN_LINK_RE.test(line))) {
    return false;
  }
  return lines.every((line, index) => (
    isMarkdownTableSeparator(line) ||
    index < separatorIndex ||
    MARKDOWN_LINK_RE.test(line)
  ));
}

function isMemoryIndexIntroSection(section: LegacyMemorySection): boolean {
  if (!/memory|index/i.test(section.title)) {
    return false;
  }
  const body = section.body.trim();
  return !body || /^(?:long-term\s+)?(?:auto-)?memory (?:files|index)\b/i.test(body) || /\b(?:auto-)?memory index\b/i.test(body) || /memory\/auto\/.*memory\/diary\//is.test(body);
}

function isPlaceholderCatalogLine(line: string): boolean {
  return /^#{3,6}\s+/.test(line) || /^\(?\s*(?:empty|none yet|none|no entries|no memory files)\b/i.test(line);
}

function isCatalogMemorySectionTitle(title: string): boolean {
  return /\b(index|catalog|contents|files|memory files|auto|diary|daily notes|project|projects|reference|references)\b/i.test(title);
}

function isCatalogOnlyMemorySection(section: LegacyMemorySection): boolean {
  if (isMemoryIndexIntroSection(section)) {
    return true;
  }
  const lines = section.body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!isCatalogMemorySectionTitle(section.title)) {
    return false;
  }
  const catalogLike = lines.length === 0 || lines.every(isCatalogLinkLine) || isSimpleCatalogTable(lines);
  if (catalogLike) {
    return true;
  }
  if (lines.every(isPlaceholderCatalogLine)) {
    return true;
  }
  return lines.every(isCatalogLinkLine) || isSimpleCatalogTable(lines);
}

function explicitMemorySectionType(title: string): { type: KnowledgePageType; name: string } | undefined {
  const prefix = /^(user|project|feedback|reference)\s*[:/-]\s*(.+)$/i.exec(title);
  if (prefix) {
    return { type: prefix[1].toLowerCase() as KnowledgePageType, name: prefix[2].trim() };
  }
  const suffix = /^(.+?)\s+\((user|project|feedback|reference)\)\s*$/i.exec(title);
  if (suffix) {
    return { type: suffix[2].toLowerCase() as KnowledgePageType, name: suffix[1].trim() };
  }
  return undefined;
}

function frontmatterForMemorySection(
  section: LegacyMemorySection,
): { frontmatter: KnowledgePageFrontmatter; body: string } | KnowledgeMigrationReviewItem | undefined {
  if (!section.body.trim() && /^legacy\s+memory$|^memory$/i.test(section.title)) {
    return undefined;
  }
  const explicit = explicitMemorySectionType(section.title);
  if (!explicit && isCatalogOnlyMemorySection(section)) {
    return undefined;
  }

  const type = explicit?.type ?? inferPageType("MEMORY.md", {}, `${section.title}\n${section.body}`);
  if (!type) {
    return {
      kind: "operator_review",
      path: "MEMORY.md",
      reason: "legacy_memory_split_required",
      message: `Legacy MEMORY.md section "${section.title}" needs an explicit v2 page type before apply.`,
      blocking: true,
    };
  }

  const name = explicit?.name || section.title;
  const body = section.body.trim() ? `# ${name}\n\n${section.body.trim()}\n` : `# ${name}\n`;
  const frontmatter = validateKnowledgePageFrontmatter(
    {
      name,
      description: firstSentence(section.body) ?? `Migrated from MEMORY.md section "${section.title}".`,
      type,
    },
    type,
  );
  if (isFrontmatterFailure(frontmatter)) {
    return {
      kind: "type_review",
      path: "MEMORY.md",
      reason: frontmatter.reason,
      message: frontmatter.message,
      blocking: true,
    };
  }

  return { frontmatter, body };
}

function memorySectionClassificationSource(name: string, sectionIndex: number): string {
  const nameSlug = slugify(name);
  const sourceSlug = nameSlug === "untitled" ? `memory-md-section-${sectionIndex + 1}` : nameSlug;
  return `MEMORY.md/${sourceSlug}.md`;
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    for (const dirent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absPath = join(dir, dirent.name);
      const relPath = toWorkspaceRel(root, absPath);
      if (dirent.isDirectory()) {
        if (!SKIP_SCAN_DIRS.has(dirent.name)) {
          walk(absPath);
        }
        continue;
      }
      if (dirent.isFile()) {
        files.push(relPath);
      }
    }
  }
  walk(root);
  return files.sort();
}

function planMemoryFile(plan: MutablePlan): void {
  const relPath = "MEMORY.md";
  const absPath = workspacePath(plan.workspaceRoot, relPath);
  let stat;
  try {
    stat = lstatSync(absPath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    addReview(plan, {
      kind: "operator_review",
      path: relPath,
      suggestedTarget: "artifacts/legacy/MEMORY.md",
      reason: "unsafe_legacy_memory_source",
      message: "Legacy MEMORY.md must be a regular file before migration; symlinks and special files require operator review.",
      blocking: true,
    });
    return;
  }
  markHandled(plan, relPath);
  const content = readText(plan.workspaceRoot, relPath);
  if (contentHasSecret(content)) {
    addReview(plan, {
      kind: "secret_review",
      path: relPath,
      suggestedTarget: "artifacts/legacy/MEMORY.md",
      reason: "secret_in_legacy_memory",
      message: "Legacy MEMORY.md appears to contain secret material; archive only after redaction/private backup.",
      blocking: true,
    });
    return;
  } else {
    addWrite(
      plan,
      {
        action: "copy",
        role: "artifact",
        sourcePath: relPath,
        targetPath: "artifacts/legacy/MEMORY.md",
        reason: "archive exact legacy MEMORY.md before splitting durable facts into v2 pages",
      },
      content,
    );
  }

  const pendingReview = extractPendingReview(content);
  if (pendingReview) {
    const issuesPath = "wiki/issues.md";
    const issuesExists = existsSync(workspacePath(plan.workspaceRoot, issuesPath));
    const canOverwriteIssues = !issuesExists || hasLegacyControlArchive(plan, issuesPath);
    if (canOverwriteIssues) {
      addWrite(
        plan,
        {
          role: "issues",
          sourcePath: relPath,
          targetPath: issuesPath,
          reason: "move existing pending review section into wiki/issues.md",
        },
        pendingReview,
        { allowOverwrite: issuesExists },
      );
    }
  }
  for (const [sectionIndex, section] of splitLegacyMemorySections(removePendingReview(content)).entries()) {
    const page = frontmatterForMemorySection(section);
    if (!page) {
      continue;
    }
    if ("kind" in page) {
      addReview(plan, page);
      continue;
    }
    const classificationSource = memorySectionClassificationSource(page.frontmatter.name, sectionIndex);
    const target = classifyLegacyTarget(plan, classificationSource, page.frontmatter, page.body);
    if (typeof target !== "string") {
      addReview(plan, { ...target, path: relPath });
      continue;
    }
    const body = bodyWithProvenance(plan, relPath, target, page.frontmatter, page.body);
    addWrite(
      plan,
      {
        role: "wiki_page",
        sourcePath: relPath,
        targetPath: target,
        reason: "split typed root MEMORY.md section into Knowledge v2 page",
      },
      formatKnowledgePage(page.frontmatter, body),
    );
  }
}

function planLegacyAutoFile(plan: MutablePlan, sourceRel: string): void {
  markHandled(plan, sourceRel);
  if (!isMarkdownRelPath(sourceRel)) {
    addReview(plan, {
      kind: "out_of_scope",
      path: sourceRel,
      reason: "non_markdown_legacy_state",
      message: "Non-Markdown structured state is not converted into a wiki page automatically.",
      blocking: false,
    });
    return;
  }

  const content = readText(plan.workspaceRoot, sourceRel);
  if (contentHasSecret(content)) {
    addReview(plan, {
      kind: "secret_review",
      path: sourceRel,
      reason: "secret_in_legacy_auto",
      message: "Legacy knowledge file appears to contain secret material and will not be migrated.",
      blocking: true,
    });
    return;
  }

  const page = frontmatterForSource(sourceRel, content);
  if ("kind" in page) {
    addReview(plan, page);
    return;
  }

  const target = classifyLegacyTarget(plan, sourceRel, page.frontmatter, page.body);
  if (typeof target !== "string") {
    addReview(plan, target);
    return;
  }

  const body = bodyWithProvenance(plan, sourceRel, target, page.frontmatter, page.body);
  addWrite(
    plan,
    {
      role: "wiki_page",
      sourcePath: sourceRel,
      targetPath: target,
      reason: "migrate legacy memory/auto Markdown to typed Knowledge v2 page",
    },
    formatKnowledgePage(page.frontmatter, body),
  );
}

function planLegacyDiaryFile(plan: MutablePlan, sourceRel: string): void {
  markHandled(plan, sourceRel);
  if (!isMarkdownRelPath(sourceRel)) {
    addReview(plan, {
      kind: "out_of_scope",
      path: sourceRel,
      reason: "non_markdown_diary_state",
      message: "Non-Markdown diary state is not converted automatically.",
      blocking: false,
    });
    return;
  }
  const content = readText(plan.workspaceRoot, sourceRel);
  if (contentHasSecret(content)) {
    addReview(plan, {
      kind: "secret_review",
      path: sourceRel,
      reason: "secret_diary_omitted",
      message: "Diary entry appears to contain secret material and is omitted from automatic migration.",
      blocking: false,
    });
    return;
  }
  const targetRel = `diary/${sourceRel.slice("memory/diary/".length)}`;
  addWrite(
    plan,
    {
      action: "copy",
      role: "diary",
      sourcePath: sourceRel,
      targetPath: targetRel,
      reason: "copy legacy memory/diary entry into v2 diary namespace",
    },
    content,
  );
}

function planTopicWikiFile(plan: MutablePlan, sourceRel: string): void {
  markHandled(plan, sourceRel);
  if (!isMarkdownRelPath(sourceRel)) {
    addReview(plan, {
      kind: "out_of_scope",
      path: sourceRel,
      reason: "non_markdown_wiki_state",
      message: "Non-Markdown wiki state remains active/artifact/raw by role.",
      blocking: false,
    });
    return;
  }
  const parts = sourceRel.split("/");
  if (parts.length < 3 || parts[0] !== "wiki") {
    return;
  }
  const topic = slugify(parts[1]);
  const subpath = parts.slice(2).join("/");
  const landing = /^(README|index)$/i.test(basename(subpath, extname(subpath))) || slugify(basename(subpath, extname(subpath))) === topic;
  const targetRel = landing
    ? `wiki/pages/project/${topic}/README.md`
    : `wiki/pages/project/${topic}/${subpath}`;
  const content = readText(plan.workspaceRoot, sourceRel);
  if (contentHasSecret(content)) {
    addReview(plan, {
      kind: "secret_review",
      path: sourceRel,
      reason: "secret_in_topic_wiki",
      message: "Karpathy-style topic wiki page appears to contain secret material and will not be migrated.",
      blocking: true,
    });
    return;
  }
  const parsed = parseMarkdown(content);
  const name = scalarString(parsed.frontmatter.name) ?? firstHeading(parsed.body) ?? humanizeSlug(landing ? topic : basename(subpath));
  const frontmatterResult = validateKnowledgePageFrontmatter(
    {
      name,
      description: scalarString(parsed.frontmatter.description) ?? firstSentence(parsed.body) ?? `Migrated topic-wiki page from ${sourceRel}.`,
      type: "project",
    },
    "project",
  );
  if (isFrontmatterFailure(frontmatterResult)) {
    addReview(plan, {
      kind: "type_review",
      path: sourceRel,
      reason: frontmatterResult.reason,
      message: frontmatterResult.message,
      blocking: true,
    });
    return;
  }
  const body = bodyWithProvenance(plan, sourceRel, targetRel, frontmatterResult, parsed.body);
  addWrite(
    plan,
    {
      role: "wiki_page",
      sourcePath: sourceRel,
      targetPath: targetRel,
      reason: "move Karpathy-style topic wiki page under wiki/pages/project/<topic>",
    },
    formatKnowledgePage(frontmatterResult, body),
  );
}

function activeOutOfScopeReview(relPath: string): Omit<KnowledgeMigrationReviewItem, "kind" | "path" | "blocking"> | undefined {
  if (isRootRelPath(relPath) && ROOT_STATUS_DOC_RE.test(relPath)) {
    return {
      reason: "root_status_doc",
      message: "Root status documents describe active workspace state and need operator promotion before becoming Knowledge pages.",
    };
  }
  if (isRootRelPath(relPath) && ROOT_DOC_RE.test(relPath)) {
    return {
      reason: "root_active_doc",
      message: "Root README, CHANGELOG, and AGENTS-style documents stay as active workspace documentation.",
    };
  }
  if (BEADS_METADATA_RE.test(relPath)) {
    return {
      reason: "beads_metadata_doc",
      message: "Beads metadata is tracker-owned state and is not migrated into Knowledge pages.",
    };
  }
  if (NIX_TREE_RE.test(relPath)) {
    return {
      reason: "nix_runtime_tree",
      message: "Nix files and nix/ trees stay with runtime and development configuration.",
    };
  }
  if (DOMAIN_CLIENT_TRAINING_TREE_RE.test(relPath)) {
    return {
      reason: "domain_client_training_tree",
      message: "Domain, client, docs, and training trees stay in their owning source locations.",
    };
  }
  if (ACTIVE_RUNTIME_STATE_RE.test(relPath)) {
    return {
      reason: "active_runtime_state",
      message: "Active context, config, package, and tooling files are not migrated automatically.",
    };
  }
  if (MEDIA_OR_STRUCTURED_STATE_RE.test(relPath)) {
    return {
      reason: "media_or_structured_state",
      message: "Media, database, and structured runtime artifacts are not migrated automatically.",
    };
  }
  return undefined;
}

function classifyUnhandledFile(plan: MutablePlan, relPath: string): void {
  if (plan.handledSources.has(relPath)) {
    return;
  }
  if (relPath === "wiki/schema.md" || relPath === "wiki/index.md" || relPath === "wiki/log.md" || relPath === "wiki/issues.md") {
    markHandled(plan, relPath);
    return;
  }
  if (relPath.startsWith("raw/") || relPath.startsWith("artifacts/") || relPath.startsWith("diary/")) {
    markHandled(plan, relPath);
    return;
  }
  if (HIDDEN_RUNTIME_PREFIXES.some((prefix) => relPath.startsWith(prefix))) {
    addReview(plan, {
      kind: "out_of_scope",
      path: relPath,
      reason: "hidden_runtime_state",
      message: "Hidden/runtime captures need an explicit retention and citation marker before promotion.",
      blocking: false,
    });
    return;
  }
  if (relPath.startsWith("reference/drafts/")) {
    addReview(plan, {
      kind: "out_of_scope",
      path: relPath,
      suggestedTarget: `artifacts/drafts/${relPath.slice("reference/drafts/".length)}`,
      reason: "reference_draft_artifact",
      message: "reference/drafts routes to artifacts/drafts by default after operator review.",
      blocking: false,
    });
    return;
  }
  if (relPath.startsWith("reference/plans/")) {
    addReview(plan, {
      kind: "out_of_scope",
      path: relPath,
      suggestedTarget: `artifacts/plans/${relPath.slice("reference/plans/".length)}`,
      reason: "reference_plan_artifact",
      message: "Approved operational plans route to artifacts/plans; package migration reports but does not silently move root reference.",
      blocking: false,
    });
    return;
  }
  if (relPath.startsWith("reference/reports/")) {
    addReview(plan, {
      kind: "out_of_scope",
      path: relPath,
      suggestedTarget: `artifacts/reports/${relPath.slice("reference/reports/".length)}`,
      reason: "reference_report_artifact",
      message: "Dated analysis reports route to artifacts/reports after operator review.",
      blocking: false,
    });
    return;
  }
  if (relPath.startsWith("reference/")) {
    addReview(plan, {
      kind: "out_of_scope",
      path: relPath,
      suggestedTarget: `artifacts/${relPath.slice("reference/".length)}`,
      reason: "reference_operator_rename",
      message: "Root reference to artifacts is an operator/private-workspace rename, not a silent package migration.",
      blocking: false,
    });
    return;
  }
  const activeReview = activeOutOfScopeReview(relPath);
  if (activeReview) {
    addReview(plan, {
      kind: "out_of_scope",
      path: relPath,
      ...activeReview,
      blocking: false,
    });
    return;
  }
  if (!isMarkdownRelPath(relPath)) {
    addReview(plan, {
      kind: "out_of_scope",
      path: relPath,
      reason: "non_markdown_state",
      message: "Non-Markdown structured state remains active state, artifact, or raw material by role.",
      blocking: false,
    });
    return;
  }
  addReview(plan, {
    kind: "operator_review",
    path: relPath,
    suggestedTarget: `raw/unassigned/${basename(relPath)}`,
    reason: "unknown_provenance",
    message: "Unknown source-vs-generated provenance blocks automatic routing; raw/unassigned is only a review suggestion.",
    blocking: true,
  });
}

function collectPlannedPages(plan: MutablePlan): ParsedPage[] {
  const pages: ParsedPage[] = [];
  for (const operation of plan.operations) {
    if (operation.role !== "wiki_page") {
      continue;
    }
    const validatedPage = validatePlannedPageFrontmatter(
      operation.sourcePath,
      operation.targetPath,
      operation.content,
    );
    if ("reviewItem" in validatedPage) {
      addReview(plan, validatedPage.reviewItem);
      continue;
    }
    pages.push({
      absPath: operation.absTargetPath,
      relPath: operation.targetPath,
      linkPath: relative(workspacePath(plan.workspaceRoot, "wiki"), operation.absTargetPath).split(sep).join("/"),
      frontmatter: validatedPage.frontmatter,
    });
  }
  return pages
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function hasExistingV2SchemaMarker(plan: MutablePlan): boolean {
  const schemaPath = workspacePath(plan.workspaceRoot, "wiki/schema.md");
  try {
    const stat = lstatSync(schemaPath);
    return stat.isFile() && !stat.isSymbolicLink() && parseKnowledgeV2SchemaMarker(readFileSync(schemaPath, "utf8")) !== undefined;
  } catch {
    return false;
  }
}

function hasLegacyControlArchive(plan: MutablePlan, relPath: string): boolean {
  const archivePath = `artifacts/legacy/${relPath}`;
  if (plan.operations.some((operation) => (
    operation.action === "copy" &&
    operation.role === "artifact" &&
    operation.sourcePath === relPath &&
    operation.targetPath === archivePath
  ))) {
    return true;
  }

  const absPath = workspacePath(plan.workspaceRoot, relPath);
  try {
    const stat = lstatSync(absPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return false;
    }
    return sameRegularFileContentIfExists(plan.workspaceRoot, archivePath, readFileSync(absPath, "utf8"));
  } catch {
    return false;
  }
}

function planLegacyWikiControlArchives(plan: MutablePlan): void {
  const existingV2Schema = hasExistingV2SchemaMarker(plan);
  for (const relPath of [...LEGACY_WIKI_CONTROL_PATHS, "wiki/issues.md"]) {
    const absPath = workspacePath(plan.workspaceRoot, relPath);
    if (!existsSync(absPath)) {
      continue;
    }
    let stat;
    try {
      stat = lstatSync(absPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      addReview(plan, {
        kind: "operator_review",
        path: relPath,
        suggestedTarget: `artifacts/legacy/${relPath}`,
        reason: "unsafe_legacy_wiki_control",
        message: "Legacy wiki control files must be regular files before automatic archival and replacement.",
        blocking: true,
      });
      continue;
    }
    const content = readText(plan.workspaceRoot, relPath);
    if (contentHasSecret(content)) {
      addReview(plan, {
        kind: "secret_review",
        path: relPath,
        suggestedTarget: `artifacts/legacy/${relPath}`,
        reason: "secret_in_legacy_wiki_control",
        message: "Legacy wiki control file appears to contain secret material; archive only after redaction/private backup.",
        blocking: true,
      });
      continue;
    }
    if (existingV2Schema && LEGACY_WIKI_CONTROL_PATHS.includes(relPath as (typeof LEGACY_WIKI_CONTROL_PATHS)[number])) {
      continue;
    }
    addWrite(
      plan,
      {
        action: "copy",
        role: "artifact",
        sourcePath: relPath,
        targetPath: `artifacts/legacy/${relPath}`,
        reason: "archive pre-v2 wiki control file before generating canonical Knowledge v2 controls",
      },
      content,
    );
  }
}

function planGeneratedV2Control(
  plan: MutablePlan,
  operation: Omit<KnowledgeMigrationOperation, "action" | "sourcePath">,
  content: string,
): void {
  const exists = existsSync(workspacePath(plan.workspaceRoot, operation.targetPath));
  if (exists && !hasLegacyControlArchive(plan, operation.targetPath)) {
    return;
  }
  addWrite(
    plan,
    operation,
    content,
    { allowOverwrite: exists },
  );
}

function planGeneratedV2Files(plan: MutablePlan): void {
  planGeneratedV2Control(
    plan,
    {
      role: "schema",
      targetPath: "wiki/schema.md",
      reason: "generate canonical Knowledge v2 schema marker and contract",
    },
    generateKnowledgeV2Schema(),
  );

  const pages = collectPlannedPages(plan);
  planGeneratedV2Control(
    plan,
    {
      role: "index",
      targetPath: "wiki/index.md",
      reason: "generate Knowledge v2 index from migrated pages",
    },
    generateKnowledgeIndex(pages),
  );

  const pageCreates = pages.map((page) => `- ${plan.now.toISOString()} create ${page.relPath}`).join("\n");
  const structuralLines = pageCreates ? `${pageCreates}\n` : "";
  planGeneratedV2Control(
    plan,
    {
      role: "log",
      targetPath: "wiki/log.md",
      reason: "record structural creates planned by knowledge migration",
    },
    structuralLines,
  );
}

function buildPlan(workspaceRoot: string, deps: KnowledgeMigrationDeps): MutablePlan {
  const layout = (deps.resolveLayout ?? resolveKnowledgeLayout)(workspaceRoot);
  return {
    layout,
    workspaceRoot,
    operations: [],
    targetSources: new Map(),
    sourceTargets: new Map(),
    reviewItems: [],
    handledSources: new Set(),
    now: deps.now?.() ?? new Date(),
  };
}

function planMigration(workspaceRoot: string, deps: KnowledgeMigrationDeps): MutablePlan {
  const plan = buildPlan(workspaceRoot, deps);
  if (plan.layout.kind === "v2") {
    return plan;
  }

  const files = walkFiles(workspaceRoot);
  planLegacyWikiControlArchives(plan);
  planMemoryFile(plan);

  for (const relPath of files) {
    if (relPath.startsWith("memory/auto/")) {
      planLegacyAutoFile(plan, relPath);
    } else if (relPath.startsWith("memory/diary/")) {
      planLegacyDiaryFile(plan, relPath);
    } else if (
      relPath.startsWith("wiki/") &&
      !relPath.startsWith("wiki/pages/") &&
      relPath !== "wiki/schema.md" &&
      relPath !== "wiki/index.md" &&
      relPath !== "wiki/log.md" &&
      relPath !== "wiki/issues.md"
    ) {
      planTopicWikiFile(plan, relPath);
    }
  }

  planGeneratedV2Files(plan);

  for (const relPath of files) {
    classifyUnhandledFile(plan, relPath);
  }

  plan.operations.sort((a, b) => a.targetPath.localeCompare(b.targetPath));
  plan.reviewItems.sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason));
  return plan;
}

function summarize(
  operations: readonly KnowledgeMigrationOperation[],
  reviewItems: readonly KnowledgeMigrationReviewItem[],
  applied = false,
): KnowledgeMigrationSummary {
  return {
    operations: operations.length,
    pages: operations.filter((operation) => operation.role === "wiki_page").length,
    diaryEntries: operations.filter((operation) => operation.role === "diary").length,
    artifacts: operations.filter((operation) => operation.role === "artifact").length,
    reviewItems: reviewItems.length,
    outOfScope: reviewItems.filter((item) => item.kind === "out_of_scope").length,
    blockers: reviewItems.filter((item) => item.blocking).length,
    applied,
  };
}

function humanSummary(mode: KnowledgeMigrationMode, summary: KnowledgeMigrationSummary): string {
  const prefix = mode === "apply"
    ? (summary.applied ? "Knowledge migration applied" : "Knowledge migration not applied")
    : "Knowledge migration dry-run";
  return `${prefix}: ${summary.operations} operation(s), ${summary.pages} page(s), ${summary.diaryEntries} diary file(s), ${summary.reviewItems} review item(s), ${summary.blockers} blocker(s).`;
}

function gitDirtyStatus(workspaceRoot: string): { gitRepository: boolean; dirty: boolean; detail: string } {
  const repo = spawnSync("git", ["-C", workspaceRoot, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (repo.status !== 0) {
    return {
      gitRepository: false,
      dirty: true,
      detail: repo.stderr.trim() || repo.stdout.trim() || repo.error?.message || "not a git repository",
    };
  }
  const result = spawnSync("git", ["-C", workspaceRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { gitRepository: true, dirty: true, detail: result.stderr.trim() || "git status failed" };
  }
  const detail = result.stdout.trim();
  return { gitRepository: true, dirty: detail.length > 0, detail };
}

interface AtomicWritePlan {
  path: string;
  tempPath: string;
  content: string;
  existed: boolean;
  previousContent?: string;
  committed: boolean;
}

function tempPathFor(path: string): string {
  return join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
}

function applyOperations(workspaceRoot: string, operations: readonly InternalOperation[]): void {
  const plans: AtomicWritePlan[] = operations.map((operation) => ({
    path: operation.absTargetPath,
    tempPath: tempPathFor(operation.absTargetPath),
    content: operation.content,
    existed: existsSync(operation.absTargetPath),
    previousContent: existsSync(operation.absTargetPath) ? readFileSync(operation.absTargetPath, "utf8") : undefined,
    committed: false,
  }));

  try {
    for (const plan of plans) {
      const unsafeTargetReason = unsafeWriteTargetReason(workspaceRoot, plan.path);
      if (unsafeTargetReason) {
        throw new Error(unsafeTargetReason);
      }
    }
    for (const plan of plans) {
      mkdirSync(dirname(plan.path), { recursive: true });
      writeFileSync(plan.tempPath, plan.content, "utf8");
    }
    for (const plan of plans) {
      renameSync(plan.tempPath, plan.path);
      plan.committed = true;
    }
  } catch (error) {
    for (const plan of plans) {
      if (!plan.committed) {
        try {
          unlinkSync(plan.tempPath);
        } catch {
          // Best effort cleanup for staging files.
        }
      }
    }
    for (const plan of plans.slice().reverse()) {
      if (!plan.committed) {
        continue;
      }
      try {
        if (plan.existed) {
          writeFileSync(plan.path, plan.previousContent ?? "", "utf8");
        } else {
          unlinkSync(plan.path);
        }
      } catch {
        // Preserve the original failure; rollback is best effort.
      }
    }
    throw error;
  }
}

function normalizeReportPath(raw: unknown, workspaceRoot: string): string | undefined {
  const value = typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  if (!value) {
    return undefined;
  }
  return isAbsolute(value) ? normalize(resolve(value)) : normalize(resolve(workspaceRoot, value));
}

function comparableAbsPath(path: string): string {
  return normalize(resolve(path)).split(sep).join("/").toLowerCase();
}

function isManagedKnowledgeRelPath(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) {
    return false;
  }
  return (
    normalized === "wiki/schema.md" ||
    normalized === "wiki/index.md" ||
    normalized === "wiki/log.md" ||
    normalized === "wiki/issues.md" ||
    normalized === "wiki/pages" ||
    normalized.startsWith("wiki/pages/")
  );
}

function reportPathFilesystemProblem(reportPath: string): string | undefined {
  try {
    const targetStat = lstatSync(reportPath);
    if (targetStat.isSymbolicLink()) {
      return "report path must not be a symlink";
    }
    if (!targetStat.isFile()) {
      return "report path must be a file path";
    }
    accessSync(reportPath, fsConstants.W_OK);
    return undefined;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      return errorMessage(error);
    }
  }

  let current = dirname(reportPath);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      return `report parent path does not exist: ${dirname(reportPath)}`;
    }
    current = parent;
  }

  try {
    const parentStat = lstatSync(current);
    if (parentStat.isSymbolicLink()) {
      return `report parent path must not be a symlink: ${current}`;
    }
    if (!parentStat.isDirectory()) {
      return `report parent path is not a directory: ${current}`;
    }
    accessSync(current, fsConstants.W_OK);
  } catch (error) {
    return errorMessage(error);
  }

  return undefined;
}

function reportPathProblem(
  reportPath: string,
  workspaceRoot: string,
  operations: readonly InternalOperation[],
): string | undefined {
  const reportKey = comparableAbsPath(reportPath);
  for (const operation of operations) {
    if (reportKey === comparableAbsPath(operation.absTargetPath)) {
      return `report path collides with planned migration target: ${operation.targetPath}`;
    }
  }

  const normalizedRoot = normalize(resolve(workspaceRoot));
  const normalizedReport = normalize(resolve(reportPath));
  if (isInsidePath(normalizedRoot, normalizedReport)) {
    const relPath = toWorkspaceRel(normalizedRoot, normalizedReport);
    if (isManagedKnowledgeRelPath(relPath)) {
      return `report path must not target managed Knowledge v2 paths: ${relPath}`;
    }
  }

  return reportPathFilesystemProblem(reportPath);
}

function writeReport(path: string, response: KnowledgeMigrationSuccess | KnowledgeMigrationFailure): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(response, null, 2)}\n`, "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function executeKnowledgeMigration(
  args: KnowledgeMigrationArgs = {},
  deps: KnowledgeMigrationDeps = {},
): KnowledgeMigrationResponse {
  const mode = normalizeMode(args);
  if (typeof mode !== "string") {
    return mode;
  }
  const workspaceRoot = resolveAgentWorkspaceRoot(deps);
  if (!workspaceRoot) {
    return failure(
      "unavailable",
      "agent-workspace-unset",
      "knowledge migrate requires an agent workspace from --workspace or MINIME_AGENT_WORKSPACE_CWD.",
      { mode },
    );
  }

  try {
    const plan = planMigration(workspaceRoot, deps);
    const operations = publicOperations(plan.operations);
    const summary = summarize(operations, plan.reviewItems);
    const base = {
      mode,
      layoutKind: plan.layout.kind,
      workspace: workspaceRoot,
      operations,
      reviewItems: plan.reviewItems,
      summary,
      humanSummary: humanSummary(mode, summary),
      reportPath: normalizeReportPath(args.reportPath, workspaceRoot),
    };
    const reportProblem = base.reportPath ? reportPathProblem(base.reportPath, workspaceRoot, plan.operations) : undefined;
    if (reportProblem) {
      return failure(
        "rejected",
        "knowledge-migration-report-path-invalid",
        `knowledge migrate report path is unsafe: ${reportProblem}`,
        base,
      );
    }

    if (mode === "apply") {
      if (summary.blockers > 0) {
        const response = failure(
          "rejected",
          "knowledge-migration-review-required",
          "knowledge migrate apply requires operator review for blocking items before writing.",
          base,
        );
        if (base.reportPath) {
          writeReport(base.reportPath, response);
        }
        return response;
      }
      const dirty = gitDirtyStatus(workspaceRoot);
      if (!dirty.gitRepository) {
        const response = failure(
          "rejected",
          "knowledge-migration-git-required",
          `knowledge migrate apply requires the agent workspace to be a git repository: ${dirty.detail}`,
          base,
        );
        if (base.reportPath) {
          writeReport(base.reportPath, response);
        }
        return response;
      }
      if (dirty.dirty && !flagEnabled(args.allowDirty)) {
        const response = failure(
          "rejected",
          "knowledge-migration-dirty-worktree",
          `knowledge migrate apply refuses a dirty git worktree unless --allow-dirty is supplied: ${dirty.detail}`,
          base,
        );
        if (base.reportPath) {
          writeReport(base.reportPath, response);
        }
        return response;
      }
      applyOperations(workspaceRoot, plan.operations);
    }

    const appliedSummary = mode === "apply" ? summarize(operations, plan.reviewItems, true) : summary;
    const response: KnowledgeMigrationSuccess = {
      ok: true,
      ...base,
      summary: appliedSummary,
      humanSummary: humanSummary(mode, appliedSummary),
    };
    if (response.reportPath) {
      try {
        writeReport(response.reportPath, response);
      } catch (error) {
        if (mode === "apply") {
          const reportError = errorMessage(error);
          return {
            ...response,
            reportError,
            humanSummary: `${response.humanSummary} Report write failed after apply: ${reportError}`,
          };
        }
        throw error;
      }
    }
    return response;
  } catch (error) {
    return failure("error", "knowledge-migration-failed", `knowledge migrate failed: ${errorMessage(error)}`, {
      mode,
      workspace: workspaceRoot,
    });
  }
}

export function formatKnowledgeMigrationResponse(response: KnowledgeMigrationResponse): string {
  return JSON.stringify(response, null, 2);
}
