import { lstatSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const KNOWLEDGE_V2_FORMAT = "minime-knowledge-v2";
export const KNOWLEDGE_V2_VERSION = "2.0";

export const KNOWLEDGE_PAGE_TYPES = ["user", "project", "feedback", "reference"] as const;

export type KnowledgePageType = (typeof KNOWLEDGE_PAGE_TYPES)[number];
export type KnowledgeLayoutKind = "v2" | "legacy" | "none";

export interface KnowledgeV2SchemaMarker {
  format: typeof KNOWLEDGE_V2_FORMAT;
  version?: string;
}

export interface KnowledgeV2LayoutPaths {
  schemaPath: string;
  indexPath: string;
  pagesDir: string;
  pagesGlob: string;
  pageTypeDirs: Record<KnowledgePageType, string>;
  pageTypeGlobs: Record<KnowledgePageType, string>;
  diaryDir: string;
  diaryGlob: string;
  issuesPath: string;
  logPath: string;
  rawDir: string;
  rawGlob: string;
  artifactsDir: string;
  artifactsGlob: string;
}

export interface KnowledgeLegacyLayoutPaths {
  memoryPath: string;
  autoDir: string;
  autoGlob: string;
  diaryDir: string;
  diaryGlob: string;
}

export interface KnowledgeLayoutCandidatePaths {
  v2: KnowledgeV2LayoutPaths;
  legacy: KnowledgeLegacyLayoutPaths;
}

export interface ResolvedKnowledgeLayoutBase {
  agentWorkspaceRoot: string;
  candidatePaths: KnowledgeLayoutCandidatePaths;
}

export interface ResolvedKnowledgeV2Layout extends ResolvedKnowledgeLayoutBase {
  kind: "v2";
  marker: KnowledgeV2SchemaMarker;
  paths: KnowledgeV2LayoutPaths;
}

export interface ResolvedKnowledgeLegacyLayout extends ResolvedKnowledgeLayoutBase {
  kind: "legacy";
  paths: KnowledgeLegacyLayoutPaths;
}

export interface ResolvedKnowledgeNoneLayout extends ResolvedKnowledgeLayoutBase {
  kind: "none";
  reason:
    | "missing"
    | "schema-unreadable"
    | "schema-marker-missing"
    | "schema-marker-invalid"
    | "v2-index-missing";
}

export type ResolvedKnowledgeLayout =
  | ResolvedKnowledgeV2Layout
  | ResolvedKnowledgeLegacyLayout
  | ResolvedKnowledgeNoneLayout;

interface SchemaMarkerReadResult {
  marker?: KnowledgeV2SchemaMarker;
  schemaExists: boolean;
  schemaReadable: boolean;
}

function workspacePath(root: string, relpath: string): string {
  return join(root, ...relpath.split("/"));
}

function existsAsFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function buildCandidatePaths(agentWorkspaceRoot: string): KnowledgeLayoutCandidatePaths {
  const pageTypeDirs = Object.fromEntries(
    KNOWLEDGE_PAGE_TYPES.map((type) => [type, workspacePath(agentWorkspaceRoot, `wiki/pages/${type}`)]),
  ) as Record<KnowledgePageType, string>;
  const pageTypeGlobs = Object.fromEntries(
    KNOWLEDGE_PAGE_TYPES.map((type) => [type, workspacePath(agentWorkspaceRoot, `wiki/pages/${type}/**`)]),
  ) as Record<KnowledgePageType, string>;

  return {
    v2: {
      schemaPath: workspacePath(agentWorkspaceRoot, "wiki/schema.md"),
      indexPath: workspacePath(agentWorkspaceRoot, "wiki/index.md"),
      pagesDir: workspacePath(agentWorkspaceRoot, "wiki/pages"),
      pagesGlob: workspacePath(agentWorkspaceRoot, "wiki/pages/**"),
      pageTypeDirs,
      pageTypeGlobs,
      diaryDir: workspacePath(agentWorkspaceRoot, "diary"),
      diaryGlob: workspacePath(agentWorkspaceRoot, "diary/**"),
      issuesPath: workspacePath(agentWorkspaceRoot, "wiki/issues.md"),
      logPath: workspacePath(agentWorkspaceRoot, "wiki/log.md"),
      rawDir: workspacePath(agentWorkspaceRoot, "raw"),
      rawGlob: workspacePath(agentWorkspaceRoot, "raw/**"),
      artifactsDir: workspacePath(agentWorkspaceRoot, "artifacts"),
      artifactsGlob: workspacePath(agentWorkspaceRoot, "artifacts/**"),
    },
    legacy: {
      memoryPath: workspacePath(agentWorkspaceRoot, "MEMORY.md"),
      autoDir: workspacePath(agentWorkspaceRoot, "memory/auto"),
      autoGlob: workspacePath(agentWorkspaceRoot, "memory/auto/**"),
      diaryDir: workspacePath(agentWorkspaceRoot, "memory/diary"),
      diaryGlob: workspacePath(agentWorkspaceRoot, "memory/diary/**"),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersion(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export function parseKnowledgeV2SchemaMarker(markdown: string): KnowledgeV2SchemaMarker | undefined {
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!frontmatterMatch) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterMatch[1]);
  } catch {
    return undefined;
  }

  if (!isRecord(parsed) || parsed.format !== KNOWLEDGE_V2_FORMAT) {
    return undefined;
  }

  return {
    format: KNOWLEDGE_V2_FORMAT,
    version: parseVersion(parsed.version),
  };
}

function readSchemaMarker(schemaPath: string): SchemaMarkerReadResult {
  let stat;
  try {
    stat = lstatSync(schemaPath);
  } catch {
    return { schemaExists: false, schemaReadable: false };
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { schemaExists: true, schemaReadable: false };
  }

  try {
    const marker = parseKnowledgeV2SchemaMarker(readFileSync(schemaPath, "utf8"));
    return { marker, schemaExists: true, schemaReadable: true };
  } catch {
    return { schemaExists: true, schemaReadable: false };
  }
}

export function resolveKnowledgeLayout(agentWorkspaceRoot: string): ResolvedKnowledgeLayout {
  const root = normalize(resolve(agentWorkspaceRoot));
  const candidatePaths = buildCandidatePaths(root);
  const markerResult = readSchemaMarker(candidatePaths.v2.schemaPath);

  if (markerResult.marker) {
    if (existsAsFile(candidatePaths.v2.indexPath)) {
      return {
        kind: "v2",
        agentWorkspaceRoot: root,
        candidatePaths,
        marker: markerResult.marker,
        paths: candidatePaths.v2,
      };
    }
    return {
      kind: "none",
      agentWorkspaceRoot: root,
      candidatePaths,
      reason: "v2-index-missing",
    };
  }

  if (existsAsFile(candidatePaths.legacy.memoryPath)) {
    return {
      kind: "legacy",
      agentWorkspaceRoot: root,
      candidatePaths,
      paths: candidatePaths.legacy,
    };
  }

  let reason: ResolvedKnowledgeNoneLayout["reason"] = "missing";
  if (markerResult.schemaExists && !markerResult.schemaReadable) {
    reason = "schema-unreadable";
  } else if (markerResult.schemaExists) {
    reason = "schema-marker-missing";
  }

  return {
    kind: "none",
    agentWorkspaceRoot: root,
    candidatePaths,
    reason,
  };
}

export function generateKnowledgeV2Schema(): string {
  return [
    "---",
    `format: ${KNOWLEDGE_V2_FORMAT}`,
    `version: "${KNOWLEDGE_V2_VERSION}"`,
    "---",
    "",
    "# Knowledge Schema",
    "",
    "This wiki uses the minime Knowledge v2 layout. Package tools resolve this layout only when this file carries the v2 format marker and `wiki/index.md` is present.",
    "",
    "## Page Types",
    "",
    "- `user`: durable synthesized knowledge about the user.",
    "- `project`: any concrete thing, theme, workstream, or initiative that evolves over time, not only software or business projects.",
    "- `feedback`: durable preferences, corrections, critiques, and recurring evaluation notes.",
    "- `reference`: reusable synthesized reference material with no project or topic owner.",
    "",
    "## Page Frontmatter",
    "",
    "Each page in `wiki/pages/**` must use flat YAML frontmatter.",
    "",
    "Required fields:",
    "",
    "- `name`: human-readable page name.",
    "- `description`: concise summary of what the page covers.",
    "- `type`: one of `user`, `project`, `feedback`, or `reference`.",
    "",
    "Optional fields:",
    "",
    "- `confidence`: confidence or freshness signal for the synthesized claim set.",
    "- `revisit_if`: condition that should trigger review.",
    "- `originSessionId`: originating session identifier when available.",
    "",
    "Do not use nested `metadata:` frontmatter in v2 pages.",
    "",
    "## Provenance",
    "",
    "Pages derived from `raw/**` or external source material preserve source links and citations. Strict citation from raw/source material into synthesized Karpathy-style topic wiki pages remains valid under canonical v2.",
    "",
    "## Routing",
    "",
    "- `raw/**`: primary sources and source captures.",
    "- `artifacts/**`: process artifacts outside the default knowledge search corpus.",
    "- `wiki/pages/reference/**`: global synthesized reference with no project or topic owner.",
    "- `wiki/pages/project/**`: preferred when synthesized knowledge belongs to a thing, theme, workstream, or initiative.",
    "",
    "## Migration Boundaries",
    "",
    "Automatic wiki migration must not move or duplicate active context, configuration, or tooling files. Keep `CLAUDE.md`, `USER.md`, `IDENTITY.md`, `.claude/**`, config and crons files, executable scripts, and other active tooling in place unless an operator explicitly asks for synthesized wiki pages derived from them.",
    "",
    "Active runbooks and configuration documents stay in their owning runtime location until that runtime is migrated atomically. Archived runbooks move to `artifacts/runbooks/**` only after references are updated. Unknown active status defaults to keep-in-place and operator review.",
    "",
    "Legacy `MEMORY.md` is split by role: catalog material becomes `wiki/index.md`, durable facts become typed pages, and migration must not create a wholesale duplicate page. First migration should archive the exact legacy file as `artifacts/legacy/MEMORY.md` unless secret exclusion requires a redacted artifact plus private backup.",
    "",
    "Decision logs, ADRs, plans, task documents, dated research or reports, generated process evidence, retained backups, and retained logs stay in `artifacts/**`. Only durable conclusions are synthesized into wiki pages, with source links back to the source artifact or raw input.",
    "",
    "External, user-provided, or source inputs go to `raw/**`. Generated process evidence goes to `artifacts/tasks/**`. Unknown provenance blocks automatic migration pending operator review; it is not a schema ambiguity.",
    "",
    "Secrets, credentials, tokens, PINs, payment secrets, and comparable private access material are never migrated into wiki, raw, or artifacts paths.",
    "",
    "## Edge Routing",
    "",
    "- `reference/drafts/**` routes to `artifacts/drafts/**` by default.",
    "- Stable pet profiles route to user pet pages; active treatment or health plans route to project health/status pages.",
    "- Ongoing personal curricula or learning plans route to project status when they are durable context.",
    "- One-off execution plans route to `artifacts/plans/**`.",
    "- Wiki pages are Markdown only; non-Markdown state remains active state, artifact, or raw material according to role.",
    "",
  ].join("\n");
}
