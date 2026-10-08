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
import { MINIME_AGENT_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

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
  variants?: unknown;
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
const FUSION_LIST_DEPTH = 50;
export const MAX_QUERY_VARIANTS = 5;
export const MAX_QUERY_VARIANT_LENGTH = 500;
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
  const env = deps.env ?? process.env;
  const root =
    deps.agentWorkspaceRoot ??
    env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
  return typeof root === "string" && root.trim() ? root : undefined;
}

function resolveLayoutForDeps(deps: KnowledgeToolDeps): ResolvedKnowledgeLayout | KnowledgeFailure {
  const agentWorkspaceRoot = resolveAgentWorkspaceRoot(deps);
  if (!agentWorkspaceRoot) {
    return failure(
      "unavailable",
      "agent-workspace-unset",
      "Knowledge tools are unavailable because MINIME_AGENT_WORKSPACE_ROOT was not provided.",
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
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Ignore common grammatical words for candidate support, but retain the complete
// normalized query for phrase/identity matching. All-function-word queries fall back
// to their original tokens so names and literal lookups remain searchable.
const FUNCTION_WORDS = new Set(normalizeSearchText(
  "a an the and or but not no of to in on at by for from with as is are was were be been being " +
  "do does did have has had it its this that these those i me my we us our you your he him his she her they them their " +
  "what which who whom whose where when why how " +
  "и а но или в во на к ко с со у о об от до из за по для при " +
  "я мы ты вы он она оно они мне нам тебе вам ему ей им мой наш твой ваш его ее их " +
  "это этот эта эти то тот та те как где когда кто что какой какая какие " +
  "не ни бы же ли есть был была было были быть"
).split(" "));

function prepareQuery(query: string): PreparedQuery {
  const raw = query.trim();
  const normalized = normalizeSearchText(raw);
  const tokens = normalized ? [...new Set(normalized.split(" "))] : [];
  const meaningful = tokens.filter((token) => !FUNCTION_WORDS.has(token));
  return { normalized, tokens: meaningful.length ? meaningful : tokens };
}

interface SearchText {
  normalized: string;
  frequencies: Map<string, number>;
  length: number;
}

function prepareText(text: string): SearchText {
  const normalized = normalizeSearchText(text);
  const tokens = normalized ? normalized.split(" ") : [];
  const frequencies = new Map<string, number>();
  for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  return { normalized, frequencies, length: tokens.length };
}

function containsPhrase(text: SearchText, query: PreparedQuery): boolean {
  return !!query.normalized && ` ${text.normalized} `.includes(` ${query.normalized} `);
}

interface SearchUnit {
  entry: CorpusEntry;
  document: MarkdownDocument;
  lines: { line: MarkdownLine; text: SearchText }[];
  body: SearchText;
  title: SearchText;
  path: SearchText;
}

function prepareEntry(entry: CorpusEntry): SearchUnit[] {
  let markdown: string;
  try {
    markdown = readFileSync(entry.absPath, "utf8");
  } catch {
    return [];
  }
  const document = parseMarkdownDocument(markdown, entry.relPath, entry.sourceKind);
  const lines = document.annotatedLines.filter((line) => line.text.trim())
    .map((line) => ({ line, text: prepareText(line.text) }));
  const title = prepareText(document.title);
  const path = prepareText(entry.relPath);
  // Catalog discovery is atomic: never pool terms or frequency across entries.
  if (entry.sourceKind === "index") {
    const emptyTitle = prepareText("");
    return lines.map((line) => ({
      entry, document, lines: [line], body: line.text, title: emptyTitle, path,
    }));
  }
  return [{ entry, document, lines, body: prepareText(document.searchableText), title, path }];
}

function snippetForLine(line: string): string {
  const trimmed = line.trim().replace(/\s+/g, " ");
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

function rankUnits(units: SearchUnit[], query: PreparedQuery, idf: Map<string, number>, averageLength: number): KnowledgeSearchResult[] {
  const results = new Map<string, KnowledgeSearchResult>();
  for (const unit of units) {
    let matched = 0;
    let score = 0;
    for (const token of query.tokens) {
      const frequency = unit.body.frequencies.get(token) ?? 0;
      const titleMatch = unit.title.frequencies.has(token);
      const pathMatch = unit.path.frequencies.has(token);
      if (!frequency && !titleMatch && !pathMatch) continue;
      matched += 1;
      // Saturated term frequency and length normalization, with explicit field weights.
      score += (idf.get(token) ?? 1) * (
        frequency * 2.2 / (frequency + 1.2 * (0.25 + 0.75 * unit.body.length / averageLength)) +
        (titleMatch ? 3 : 0) + (pathMatch ? 2 : 0));
    }
    if (!matched) continue;
    score *= matched / query.tokens.length;
    if (containsPhrase(unit.body, query)) score += 4;
    if (containsPhrase(unit.title, query)) score += 8;
    if (containsPhrase(unit.path, query)) score += 8;
    // Prefer curated sources without overwhelming low-coverage relevance.
    if (unit.entry.sourceKind === "wiki" || unit.entry.sourceKind === "auto") score *= 1.2;
    let best = unit.lines[0];
    let bestScore = -1;
    for (const candidate of unit.lines) {
      const matches = query.tokens.reduce((sum, token) => sum + (candidate.text.frequencies.has(token) ? (idf.get(token) ?? 1) : 0), 0);
      const lineScore = matches + (containsPhrase(candidate.text, query) ? 4 : 0) +
        (matches && candidate.line.sectionKind !== "body" ? 0.5 : 0);
      if (lineScore > bestScore) { best = candidate; bestScore = lineScore; }
    }
    if (!best) continue;
    const result: KnowledgeSearchResult = {
      path: unit.entry.relPath, title: unit.document.title,
      ...(best.line.heading ? { heading: best.line.heading } : {}),
      startLine: best.line.lineNumber, endLine: best.line.lineNumber,
      snippet: snippetForLine(best.line.text), sourceKind: unit.entry.sourceKind,
      authority: unit.entry.authority, score, rank: 0,
    };
    const previous = results.get(result.path);
    if (!previous || result.score > previous.score) results.set(result.path, result);
  }
  return [...results.values()].sort(compareResults);
}

function compareResults(a: KnowledgeSearchResult, b: KnowledgeSearchResult): number {
  return b.score - a.score || a.path.localeCompare(b.path) || a.startLine - b.startLine;
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

    const rawVariants = args.variants === undefined ? [] : args.variants;
    if (!Array.isArray(rawVariants) || rawVariants.length > MAX_QUERY_VARIANTS ||
      rawVariants.some((value) => typeof value !== "string" || !value.trim() || value.length > MAX_QUERY_VARIANT_LENGTH)) {
      return searchFailure("rejected", "invalid-variants",
        `variants must be an array of at most ${MAX_QUERY_VARIANTS} non-empty strings, each at most ${MAX_QUERY_VARIANT_LENGTH} characters.`);
    }

    const layout = resolveLayoutForDeps(deps);
    if (isKnowledgeFailure(layout)) {
      return { ...layout, results: [] };
    }
    if (layout.kind === "none") {
      return { ...unavailableForLayout(layout), results: [] };
    }

    const queries = [prepareQuery(query)];
    for (const variant of rawVariants) {
      const prepared = prepareQuery(variant);
      if (!queries.some((existing) => existing.normalized === prepared.normalized)) queries.push(prepared);
    }
    const units = buildCorpus(layout, scope).flatMap(prepareEntry);
    const averageLength = units.reduce((sum, unit) => sum + unit.body.length, 0) / (units.length || 1) || 1;
    const documentFrequency = new Map<string, number>();
    for (const unit of units) {
      for (const token of new Set([...unit.body.frequencies.keys(), ...unit.title.frequencies.keys(), ...unit.path.frequencies.keys()])) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
    }
    const idf = new Map([...documentFrequency].map(([token, count]) =>
      [token, Math.log(1 + (units.length - count + 0.5) / (count + 0.5))]));
    const ranked = queries.map((prepared) => rankUnits(units, prepared, idf, averageLength));
    const fused = new Map<string, KnowledgeSearchResult>();
    for (const list of ranked) {
      for (const [index, result] of list.slice(0, FUSION_LIST_DEPTH).entries()) {
        // Each reformulation gets an equal vote; weak tail matches do not accumulate.
        const contribution = 1 / (60 + index + 1);
        const existing = fused.get(result.path);
        if (existing && result.sourceKind === "index") {
          // Different catalog entries must not reinforce one another through variants.
          if (contribution > existing.score) fused.set(result.path, { ...result, score: contribution });
        } else if (existing) existing.score += contribution;
        else fused.set(result.path, { ...result, score: contribution });
      }
    }
    // Preserve exact original names/paths/identifiers even when several broad variants agree elsewhere.
    const original = queries[0];
    const boostedPaths = new Set<string>();
    for (const unit of units) {
      const hit = fused.get(unit.entry.relPath);
      if (hit && !boostedPaths.has(unit.entry.relPath) && original.normalized &&
        (unit.title.normalized === original.normalized || unit.path.normalized === original.normalized ||
          (original.tokens.some((token) => /\p{N}/u.test(token)) && containsPhrase(unit.body, original)))) {
        hit.score += 1;
        boostedPaths.add(unit.entry.relPath);
      }
    }
    const results = (queries.length === 1 ? ranked[0] : [...fused.values()].sort(compareResults))
      .slice(0, coerceMaxResults(args.maxResults))
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
