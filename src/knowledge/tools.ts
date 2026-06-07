import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { type ResolvedKnowledgeLayout, resolveKnowledgeLayout } from "./layout.js";
import { MINIME_AGENT_WORKSPACE_CWD_ENV } from "../workspace-contract.js";

export type KnowledgeSearchScope = "auto" | "default" | "diary" | "all";
export type KnowledgeSourceKind = "index" | "wiki" | "auto" | "diary";
export type KnowledgeAuthority =
  | "catalog/discovery"
  | "durable synthesized knowledge; verify freshness for time-sensitive facts"
  | "narrative/history; stale-prone";

export interface KnowledgeSearchResult {
  path: string;
  title: string;
  heading?: string;
  startLine: number;
  endLine: number;
  snippet: string;
  sourceKind: KnowledgeSourceKind;
  authority: KnowledgeAuthority;
  score: number;
  rank: number;
}

export interface KnowledgeSearchArgs {
  query?: unknown;
  scope?: unknown;
  maxResults?: unknown;
}

export interface KnowledgeGetArgs {
  path?: unknown;
  startLine?: unknown;
  endLine?: unknown;
}

export interface KnowledgeToolDeps {
  agentWorkspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  resolveLayout?: (agentWorkspaceRoot: string) => ResolvedKnowledgeLayout;
}

interface KnowledgeFailure {
  ok: false;
  status: "unavailable" | "rejected" | "error";
  reason: string;
  message: string;
  layoutKind?: ResolvedKnowledgeLayout["kind"];
}

export interface KnowledgeSearchSuccess {
  ok: true;
  layoutKind: "v2" | "legacy";
  scope: KnowledgeSearchScope;
  query: string;
  results: KnowledgeSearchResult[];
}

export type KnowledgeSearchResponse = KnowledgeSearchSuccess | (KnowledgeFailure & { results: [] });

export interface KnowledgeGetSuccess {
  ok: true;
  layoutKind: "v2" | "legacy";
  path: string;
  title: string;
  startLine: number;
  endLine: number;
  lineCount: number;
  content: string;
  sourceKind: KnowledgeSourceKind;
  authority: KnowledgeAuthority;
}

export type KnowledgeGetResponse = KnowledgeGetSuccess | KnowledgeFailure;

interface CorpusEntry {
  absPath: string;
  realPath: string;
  relPath: string;
  sourceKind: KnowledgeSourceKind;
  authority: KnowledgeAuthority;
}

interface PreparedQuery {
  raw: string;
  rawLower: string;
  normalized: string;
  tokens: string[];
}

interface MarkdownLine {
  lineNumber: number;
  text: string;
  heading?: string;
  sectionKind: "frontmatter" | "heading" | "index-entry" | "body";
}

interface MarkdownDocument {
  title: string;
  lines: string[];
  searchableText: string;
  annotatedLines: MarkdownLine[];
}

const DEFAULT_MAX_RESULTS = 10;
const MAX_RESULTS = 50;
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

const INDEX_AUTHORITY: KnowledgeAuthority = "catalog/discovery";
const CURATED_AUTHORITY: KnowledgeAuthority =
  "durable synthesized knowledge; verify freshness for time-sensitive facts";
const DIARY_AUTHORITY: KnowledgeAuthority = "narrative/history; stale-prone";

function failure(
  status: KnowledgeFailure["status"],
  reason: string,
  message: string,
  layoutKind?: ResolvedKnowledgeLayout["kind"],
): KnowledgeFailure {
  return { ok: false, status, reason, message, ...(layoutKind ? { layoutKind } : {}) };
}

function searchFailure(
  status: KnowledgeFailure["status"],
  reason: string,
  message: string,
  layoutKind?: ResolvedKnowledgeLayout["kind"],
): KnowledgeSearchResponse {
  return { ...failure(status, reason, message, layoutKind), results: [] };
}

function resolveAgentWorkspaceRoot(deps: KnowledgeToolDeps): string | undefined {
  const root =
    deps.agentWorkspaceRoot ??
    deps.env?.[MINIME_AGENT_WORKSPACE_CWD_ENV] ??
    process.env[MINIME_AGENT_WORKSPACE_CWD_ENV];
  return typeof root === "string" && root.trim() ? root : undefined;
}

function resolveLayoutForDeps(deps: KnowledgeToolDeps): ResolvedKnowledgeLayout | KnowledgeFailure {
  const agentWorkspaceRoot = resolveAgentWorkspaceRoot(deps);
  if (!agentWorkspaceRoot) {
    return failure(
      "unavailable",
      "agent-workspace-unset",
      "Knowledge tools are unavailable because MINIME_AGENT_WORKSPACE_CWD was not provided.",
    );
  }

  return (deps.resolveLayout ?? resolveKnowledgeLayout)(agentWorkspaceRoot);
}

function unavailableForLayout(layout: ResolvedKnowledgeLayout): KnowledgeFailure {
  if (layout.kind === "none") {
    return failure(
      "unavailable",
      "knowledge-layout-unavailable",
      `No supported knowledge layout is available in the agent workspace (${layout.reason}).`,
      layout.kind,
    );
  }
  return failure(
    "error",
    "knowledge-layout-invalid",
    "Knowledge layout resolution returned an unsupported state.",
    layout.kind,
  );
}

function isKnowledgeFailure(value: ResolvedKnowledgeLayout | KnowledgeFailure): value is KnowledgeFailure {
  return "ok" in value && value.ok === false;
}

function normalizeScope(raw: unknown): KnowledgeSearchScope | undefined {
  if (raw === undefined || raw === null || raw === "") {
    return "auto";
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const scope = raw.toLowerCase();
  if (scope === "auto" || scope === "default" || scope === "diary" || scope === "all") {
    return scope;
  }
  return undefined;
}

function coerceMaxResults(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_RESULTS;
  }
  return Math.min(Math.floor(value), MAX_RESULTS);
}

function toWorkspaceRel(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
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

function isPathWithinRealWorkspace(workspaceRoot: string, path: string): boolean {
  const realWorkspaceRoot = safeRealpath(workspaceRoot);
  const realPath = safeRealpath(path);
  return !!realWorkspaceRoot && !!realPath && isInsidePath(realWorkspaceRoot, realPath);
}

function hasNoSymlinkPathSegments(workspaceRoot: string, path: string): boolean {
  const root = normalize(resolve(workspaceRoot));
  const target = normalize(resolve(path));
  if (!isInsidePath(root, target)) {
    return false;
  }

  let current = root;
  const relParts = relative(root, target).split(sep).filter(Boolean);
  for (const part of relParts) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        return false;
      }
    } catch {
      return false;
    }
  }
  return true;
}

function maybeAddFile(
  entries: CorpusEntry[],
  workspaceRoot: string,
  allowedRoot: string,
  absPath: string,
  sourceKind: KnowledgeSourceKind,
  authority: KnowledgeAuthority,
): void {
  if (!isMarkdownPath(absPath)) {
    return;
  }

  let stat;
  try {
    stat = lstatSync(absPath);
  } catch {
    return;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return;
  }

  const realAllowedRoot = safeRealpath(allowedRoot);
  const realFile = safeRealpath(absPath);
  const realWorkspaceRoot = safeRealpath(workspaceRoot);
  if (
    !realWorkspaceRoot ||
    !realAllowedRoot ||
    !realFile ||
    !isInsidePath(realWorkspaceRoot, realAllowedRoot) ||
    !isInsidePath(realWorkspaceRoot, realFile) ||
    !isInsidePath(realAllowedRoot, realFile)
  ) {
    return;
  }

  entries.push({
    absPath: normalize(resolve(absPath)),
    realPath: realFile,
    relPath: toWorkspaceRel(workspaceRoot, absPath),
    sourceKind,
    authority,
  });
}

function walkMarkdownFiles(
  entries: CorpusEntry[],
  workspaceRoot: string,
  dir: string,
  sourceKind: KnowledgeSourceKind,
  authority: KnowledgeAuthority,
): void {
  if (!isPathWithinRealWorkspace(workspaceRoot, dir) || !hasNoSymlinkPathSegments(workspaceRoot, dir)) {
    return;
  }

  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    const absPath = join(dir, dirent.name);
    try {
      if (dirent.isDirectory()) {
        walkMarkdownFiles(entries, workspaceRoot, absPath, sourceKind, authority);
      } else if (dirent.isFile() || dirent.isSymbolicLink()) {
        maybeAddFile(entries, workspaceRoot, dir, absPath, sourceKind, authority);
      }
    } catch {
      continue;
    }
  }
}

function uniqueEntries(entries: CorpusEntry[]): CorpusEntry[] {
  const seen = new Set<string>();
  const deduped: CorpusEntry[] = [];
  for (const entry of entries.sort((a, b) => a.relPath.localeCompare(b.relPath))) {
    if (seen.has(entry.realPath)) {
      continue;
    }
    seen.add(entry.realPath);
    deduped.push(entry);
  }
  return deduped;
}

function buildCorpus(layout: Extract<ResolvedKnowledgeLayout, { kind: "v2" | "legacy" }>, scope: KnowledgeSearchScope): CorpusEntry[] {
  const entries: CorpusEntry[] = [];
  const includeDefault = scope === "auto" || scope === "default" || scope === "all";
  const includeDiary = scope === "diary" || scope === "all";

  if (layout.kind === "v2") {
    if (includeDefault) {
      maybeAddFile(entries, layout.agentWorkspaceRoot, layout.paths.indexPath, layout.paths.indexPath, "index", INDEX_AUTHORITY);
      walkMarkdownFiles(entries, layout.agentWorkspaceRoot, layout.paths.pagesDir, "wiki", CURATED_AUTHORITY);
    }
    if (includeDiary) {
      walkMarkdownFiles(entries, layout.agentWorkspaceRoot, layout.paths.diaryDir, "diary", DIARY_AUTHORITY);
    }
  } else {
    if (includeDefault) {
      maybeAddFile(entries, layout.agentWorkspaceRoot, layout.paths.memoryPath, layout.paths.memoryPath, "index", INDEX_AUTHORITY);
      walkMarkdownFiles(entries, layout.agentWorkspaceRoot, layout.paths.autoDir, "auto", CURATED_AUTHORITY);
    }
    if (includeDiary) {
      walkMarkdownFiles(entries, layout.agentWorkspaceRoot, layout.paths.diaryDir, "diary", DIARY_AUTHORITY);
    }
  }

  return uniqueEntries(entries);
}

function splitMarkdownLines(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.length === 0) {
    return [];
  }
  return (normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized).split("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseFrontmatter(lines: string[]): { fields: Record<string, unknown>; endLine: number } {
  if (lines[0] !== "---") {
    return { fields: {}, endLine: 0 };
  }

  const closingIndex = lines.slice(1).findIndex((line) => line === "---");
  if (closingIndex < 0) {
    return { fields: {}, endLine: 0 };
  }

  const yaml = lines.slice(1, closingIndex + 1).join("\n");
  try {
    const parsed = parseYaml(yaml);
    return { fields: isRecord(parsed) ? parsed : {}, endLine: closingIndex + 2 };
  } catch {
    return { fields: {}, endLine: closingIndex + 2 };
  }
}

function stripHeading(line: string): string | undefined {
  const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
  return match?.[2]?.trim() || undefined;
}

function titleFromPath(relPath: string): string {
  const stem = basename(relPath).replace(/\.(?:md|markdown)$/i, "");
  return stem
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseMarkdownDocument(markdown: string, relPath: string, sourceKind: KnowledgeSourceKind): MarkdownDocument {
  const lines = splitMarkdownLines(markdown);
  const frontmatter = parseFrontmatter(lines);
  const frontmatterName = typeof frontmatter.fields.name === "string" ? frontmatter.fields.name.trim() : "";
  let firstHeading: string | undefined;
  let currentHeading: string | undefined;

  const annotatedLines: MarkdownLine[] = lines.map((line, index) => {
    const lineNumber = index + 1;
    const heading = stripHeading(line);
    if (heading) {
      currentHeading = heading;
      firstHeading ??= heading;
    }

    let sectionKind: MarkdownLine["sectionKind"] = "body";
    if (frontmatter.endLine > 0 && lineNumber <= frontmatter.endLine) {
      sectionKind = "frontmatter";
    } else if (heading) {
      sectionKind = "heading";
    } else if (sourceKind === "index" && /^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
      sectionKind = "index-entry";
    }

    return {
      lineNumber,
      text: line,
      ...(currentHeading ? { heading: currentHeading } : {}),
      sectionKind,
    };
  });

  return {
    title: frontmatterName || firstHeading || titleFromPath(relPath),
    lines,
    searchableText: lines.join("\n"),
    annotatedLines,
  };
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function prepareQuery(query: string): PreparedQuery {
  const raw = query.trim();
  const normalized = normalizeSearchText(raw);
  return {
    raw,
    rawLower: raw.toLowerCase(),
    normalized,
    tokens: normalized ? normalized.split(" ").filter(Boolean) : [],
  };
}

function scoreText(text: string, query: PreparedQuery): number {
  const rawLower = text.toLowerCase();
  const normalized = normalizeSearchText(text);
  let score = 0;

  if (query.rawLower && rawLower.includes(query.rawLower)) {
    score += 50;
  }
  if (query.normalized && normalized.includes(query.normalized)) {
    score += 40;
  }
  if (query.tokens.length > 0) {
    let matched = 0;
    for (const token of query.tokens) {
      if (normalized.includes(token) || rawLower.includes(token)) {
        matched += 1;
      }
    }
    if (matched === query.tokens.length) {
      score += 20 + matched * 4;
    } else {
      score += matched;
    }
  }

  return score;
}

function sectionScoreBonus(sectionKind: MarkdownLine["sectionKind"]): number {
  switch (sectionKind) {
    case "frontmatter":
      return 8;
    case "heading":
      return 6;
    case "index-entry":
      return 5;
    case "body":
      return 0;
  }
}

function snippetForLine(line: string): string {
  const trimmed = line.trim().replace(/\s+/g, " ");
  if (trimmed.length <= 240) {
    return trimmed;
  }
  return `${trimmed.slice(0, 237)}...`;
}

function bestLineForDocument(document: MarkdownDocument, query: PreparedQuery): { line: MarkdownLine; score: number } | undefined {
  let best: { line: MarkdownLine; score: number } | undefined;

  for (const line of document.annotatedLines) {
    const score = scoreText(line.text, query) + sectionScoreBonus(line.sectionKind);
    if (score <= sectionScoreBonus(line.sectionKind)) {
      continue;
    }
    if (
      !best ||
      score > best.score ||
      (score === best.score && line.lineNumber < best.line.lineNumber)
    ) {
      best = { line, score };
    }
  }

  if (best) {
    return best;
  }

  const documentScore = scoreText(document.searchableText, query);
  if (documentScore <= 0) {
    return undefined;
  }

  const firstToken = query.tokens[0];
  const fallback =
    document.annotatedLines.find((line) => {
      const normalized = normalizeSearchText(line.text);
      return firstToken ? normalized.includes(firstToken) : line.text.toLowerCase().includes(query.rawLower);
    }) ?? document.annotatedLines.find((line) => line.text.trim()) ?? document.annotatedLines[0];

  return fallback ? { line: fallback, score: documentScore } : undefined;
}

function searchEntry(entry: CorpusEntry, query: PreparedQuery): KnowledgeSearchResult | undefined {
  let markdown: string;
  try {
    markdown = readFileSync(entry.absPath, "utf8");
  } catch {
    return undefined;
  }

  const document = parseMarkdownDocument(markdown, entry.relPath, entry.sourceKind);
  const best = bestLineForDocument(document, query);
  if (!best) {
    return undefined;
  }

  const titleScore = scoreText(document.title, query) > 0 ? 10 : 0;
  const sourceScore = entry.sourceKind === "wiki" || entry.sourceKind === "auto" ? 8 : 0;

  return {
    path: entry.relPath,
    title: document.title,
    ...(best.line.heading ? { heading: best.line.heading } : {}),
    startLine: best.line.lineNumber,
    endLine: best.line.lineNumber,
    snippet: snippetForLine(best.line.text),
    sourceKind: entry.sourceKind,
    authority: entry.authority,
    score: best.score + titleScore + sourceScore,
    rank: 0,
  };
}

function normalizeGetPath(raw: unknown): string | KnowledgeFailure {
  if (typeof raw !== "string" || !raw.trim()) {
    return failure("rejected", "invalid-path", "knowledge_get requires a relative Markdown path from knowledge_search.");
  }
  const relPath = raw.trim();
  if (isAbsolute(relPath) || relPath.includes("\\") || /^[A-Za-z]:/.test(relPath)) {
    return failure("rejected", "invalid-path", "knowledge_get only accepts workspace-relative Markdown paths.");
  }
  const parts = relPath.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return failure("rejected", "invalid-path", "knowledge_get rejects empty, dot, and traversal path segments.");
  }
  if (!isMarkdownPath(relPath)) {
    return failure("rejected", "non-markdown", "knowledge_get only reads Markdown files in the knowledge corpus.");
  }
  return relPath;
}

function floorNumber(raw: unknown): number | undefined {
  const value = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(value) ? Math.floor(value) : undefined;
}

function clampLineRange(lineCount: number, rawStart: unknown, rawEnd: unknown): { startLine: number; endLine: number } {
  if (lineCount === 0) {
    return { startLine: 0, endLine: 0 };
  }

  const requestedStart = floorNumber(rawStart) ?? 1;
  const requestedEnd = floorNumber(rawEnd) ?? lineCount;
  const startLine = Math.min(Math.max(requestedStart, 1), lineCount);
  const endLine = Math.min(Math.max(requestedEnd, startLine), lineCount);
  return { startLine, endLine };
}

function corpusMap(entries: CorpusEntry[]): Map<string, CorpusEntry> {
  const byRelPath = new Map<string, CorpusEntry>();
  for (const entry of entries) {
    byRelPath.set(entry.relPath, entry);
  }
  return byRelPath;
}

export function executeKnowledgeSearch(args: KnowledgeSearchArgs = {}, deps: KnowledgeToolDeps = {}): KnowledgeSearchResponse {
  try {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return searchFailure("rejected", "invalid-query", "knowledge_search requires a non-empty query.");
    }

    const scope = normalizeScope(args.scope);
    if (!scope) {
      return searchFailure("rejected", "invalid-scope", "knowledge_search scope must be one of auto, default, diary, or all.");
    }

    const layout = resolveLayoutForDeps(deps);
    if (isKnowledgeFailure(layout)) {
      return { ...layout, results: [] };
    }
    if (layout.kind === "none") {
      return { ...unavailableForLayout(layout), results: [] };
    }

    const prepared = prepareQuery(query);
    const maxResults = coerceMaxResults(args.maxResults);
    const results = buildCorpus(layout, scope)
      .map((entry) => searchEntry(entry, prepared))
      .filter((result): result is KnowledgeSearchResult => Boolean(result))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.path.localeCompare(b.path) ||
          a.startLine - b.startLine,
      )
      .slice(0, maxResults)
      .map((result, index) => ({ ...result, rank: index + 1 }));

    return {
      ok: true,
      layoutKind: layout.kind,
      scope,
      query,
      results,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return searchFailure("error", "knowledge-search-failed", `knowledge_search failed: ${message}`);
  }
}

export function executeKnowledgeGet(args: KnowledgeGetArgs = {}, deps: KnowledgeToolDeps = {}): KnowledgeGetResponse {
  try {
    const relPath = normalizeGetPath(args.path);
    if (typeof relPath !== "string") {
      return relPath;
    }

    const layout = resolveLayoutForDeps(deps);
    if (isKnowledgeFailure(layout)) {
      return layout;
    }
    if (layout.kind === "none") {
      return unavailableForLayout(layout);
    }

    const absPath = resolve(layout.agentWorkspaceRoot, ...relPath.split("/"));
    if (!isInsidePath(layout.agentWorkspaceRoot, absPath) || !existsSync(absPath)) {
      return failure("rejected", "non-corpus-path", "knowledge_get can only read Markdown files inside the resolved knowledge corpus.", layout.kind);
    }

    const allowedEntry = corpusMap(buildCorpus(layout, "all")).get(relPath);
    if (!allowedEntry) {
      return failure("rejected", "non-corpus-path", "knowledge_get can only read Markdown files inside the resolved knowledge corpus.", layout.kind);
    }

    let stat;
    try {
      stat = lstatSync(absPath);
    } catch {
      return failure("rejected", "non-corpus-path", "knowledge_get can only read Markdown files inside the resolved knowledge corpus.", layout.kind);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return failure("rejected", "non-corpus-path", "knowledge_get can only read Markdown files inside the resolved knowledge corpus.", layout.kind);
    }

    const markdown = readFileSync(allowedEntry.absPath, "utf8");
    const document = parseMarkdownDocument(markdown, allowedEntry.relPath, allowedEntry.sourceKind);
    const { startLine, endLine } = clampLineRange(document.lines.length, args.startLine, args.endLine);
    const content =
      startLine === 0 ? "" : document.lines.slice(startLine - 1, endLine).join("\n");

    return {
      ok: true,
      layoutKind: layout.kind,
      path: allowedEntry.relPath,
      title: document.title,
      startLine,
      endLine,
      lineCount: document.lines.length,
      content,
      sourceKind: allowedEntry.sourceKind,
      authority: allowedEntry.authority,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failure("error", "knowledge-get-failed", `knowledge_get failed: ${message}`);
  }
}

export function formatKnowledgeToolResponse(response: KnowledgeSearchResponse | KnowledgeGetResponse): string {
  return JSON.stringify(response, null, 2);
}
