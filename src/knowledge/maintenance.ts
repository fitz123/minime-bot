import {
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
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  resolveKnowledgeLayout,
  type ResolvedKnowledgeLayout,
  type ResolvedKnowledgeV2Layout,
} from "./layout.js";
import {
  executeKnowledgeUpdate,
  KNOWLEDGE_ARCHIVE_PRECONDITION_CHANGED_REASON,
  KNOWLEDGE_ARCHIVE_PRECONDITION_LOW_WATERMARK_REASON,
  validateKnowledgePageFrontmatter,
  type KnowledgeUpdateArgs,
  type KnowledgeUpdateDeps,
  type KnowledgeUpdateResponse,
} from "./update.js";
import { MINIME_AGENT_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

export const KNOWLEDGE_MAINTENANCE_POLICY_VERSION = "knowledge-maintenance-v1";
export const KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES = 40 * 1024;
export const KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES = 30 * 1024;
export const KNOWLEDGE_MAINTENANCE_MIN_AGE_DAYS = 30;
export const KNOWLEDGE_MAINTENANCE_MAX_CLOSED_ISSUES = 1_000;
export const KNOWLEDGE_MAINTENANCE_MAX_ARCHIVED_PATHS = 100;
export const KNOWLEDGE_MAINTENANCE_MAX_ERRORS = 20;

const MIN_AGE_MS = KNOWLEDGE_MAINTENANCE_MIN_AGE_DAYS * 24 * 60 * 60 * 1_000;
const ISSUE_RECORD_RE = /^issue-([1-9][0-9]*)-(\d{4})-(\d{2})-(\d{2})\.md$/;
const RELEASE_RECORD_RE = /^release-(\d{4})-(\d{2})-(\d{2})\.md$/;
const MAX_ERROR_MESSAGE_LENGTH = 240;
const KNOWLEDGE_UPDATE_LOCK_RELPATH = ".tmp/knowledge-update.lock";

export interface KnowledgeMaintenanceArgs {
  closedIssueNumbers?: unknown;
  reportPath?: unknown;
}

export interface KnowledgeMaintenanceDeps {
  agentWorkspaceRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  resolveLayout?: (agentWorkspaceRoot: string) => ResolvedKnowledgeLayout;
  loadClosedIssueNumbers?: () => unknown;
  executeUpdate?: (
    args: KnowledgeUpdateArgs,
    deps?: KnowledgeUpdateDeps,
  ) => KnowledgeUpdateResponse;
}

export interface KnowledgeMaintenanceSkippedCounts {
  nonDated: number;
  issueNotProvenClosed: number;
  mixed: number;
  recentlyModified: number;
}

export interface KnowledgeMaintenanceError {
  path: string;
  reason: string;
  message: string;
}

export type KnowledgeMaintenanceStopReason =
  | "below-high-watermark"
  | "low-watermark-reached"
  | "eligible-exhausted"
  | "unsafe-failure";

export interface KnowledgeMaintenanceManifest {
  policyVersion: typeof KNOWLEDGE_MAINTENANCE_POLICY_VERSION;
  highWatermarkBytes: typeof KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES;
  lowWatermarkBytes: typeof KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES;
  minimumAgeDays: typeof KNOWLEDGE_MAINTENANCE_MIN_AGE_DAYS;
  bytesBefore: number;
  bytesAfter: number;
  archivedCount: number;
  archivedPaths: string[];
  archivedPathsOmitted: number;
  skipped: KnowledgeMaintenanceSkippedCounts;
  errors: KnowledgeMaintenanceError[];
  errorsOmitted: number;
  stopReason: KnowledgeMaintenanceStopReason;
  mutated: boolean;
}

export interface KnowledgeMaintenanceSuccess extends KnowledgeMaintenanceManifest {
  ok: true;
  layoutKind: "v2";
  reportPath?: string;
}

export interface KnowledgeMaintenanceFailure {
  ok: false;
  status: "unavailable" | "unsupported" | "rejected" | "error";
  reason: string;
  message: string;
  layoutKind?: ResolvedKnowledgeLayout["kind"];
  manifest?: KnowledgeMaintenanceManifest;
  reportPath?: string;
}

export type KnowledgeMaintenanceResponse =
  | KnowledgeMaintenanceSuccess
  | KnowledgeMaintenanceFailure;

interface DatedRecord {
  kind: "issue" | "release";
  issueNumber?: number;
}

interface MaintenanceCandidate {
  relPath: string;
  mtimeMs: number;
  expectedBytes: Buffer;
}

interface MutableManifestState {
  archivedCount: number;
  archivedPaths: string[];
  skipped: KnowledgeMaintenanceSkippedCounts;
  errors: KnowledgeMaintenanceError[];
  errorCount: number;
  mutated: boolean;
}

interface MaintenanceCandidateCollection {
  candidates: MaintenanceCandidate[];
  complete: boolean;
}

interface ReportTarget {
  absPath: string;
  relPath: string;
}

interface FileSnapshot {
  kind: "missing" | "file" | "other";
  bytes?: Buffer;
  mtimeMs?: number;
}

interface CandidateSnapshot {
  indexBytes: Buffer;
  active: FileSnapshot;
  archive: FileSnapshot;
}

function failure(
  status: KnowledgeMaintenanceFailure["status"],
  reason: string,
  message: string,
  extra: Partial<Omit<KnowledgeMaintenanceFailure, "ok" | "status" | "reason" | "message">> = {},
): KnowledgeMaintenanceFailure {
  return { ok: false, status, reason, message, ...extra };
}

function isMaintenanceFailure(
  value: ReportTarget | KnowledgeMaintenanceFailure | undefined,
): value is KnowledgeMaintenanceFailure {
  return value !== undefined && "ok" in value && value.ok === false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function boundedMessage(message: string): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_ERROR_MESSAGE_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function resolveAgentWorkspaceRoot(deps: KnowledgeMaintenanceDeps): string | undefined {
  const env = deps.env ?? process.env;
  const root = deps.agentWorkspaceRoot ?? env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
  return typeof root === "string" && root.trim()
    ? normalize(resolve(root))
    : undefined;
}

function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toWorkspaceRel(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/");
}

function readIndexBytes(layout: ResolvedKnowledgeV2Layout): Buffer {
  return Buffer.from(readFileSync(layout.paths.indexPath));
}

function emptyState(): MutableManifestState {
  return {
    archivedCount: 0,
    archivedPaths: [],
    skipped: {
      nonDated: 0,
      issueNotProvenClosed: 0,
      mixed: 0,
      recentlyModified: 0,
    },
    errors: [],
    errorCount: 0,
    mutated: false,
  };
}

function addError(
  state: MutableManifestState,
  path: string,
  reason: string,
  message: string,
): void {
  state.errorCount += 1;
  if (state.errors.length < KNOWLEDGE_MAINTENANCE_MAX_ERRORS) {
    state.errors.push({
      path,
      reason,
      message: boundedMessage(message),
    });
  }
}

function buildManifest(
  state: MutableManifestState,
  bytesBefore: number,
  bytesAfter: number,
  stopReason: KnowledgeMaintenanceStopReason,
): KnowledgeMaintenanceManifest {
  return {
    policyVersion: KNOWLEDGE_MAINTENANCE_POLICY_VERSION,
    highWatermarkBytes: KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES,
    lowWatermarkBytes: KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES,
    minimumAgeDays: KNOWLEDGE_MAINTENANCE_MIN_AGE_DAYS,
    bytesBefore,
    bytesAfter,
    archivedCount: state.archivedCount,
    archivedPaths: state.archivedPaths,
    archivedPathsOmitted: Math.max(0, state.archivedCount - state.archivedPaths.length),
    skipped: state.skipped,
    errors: state.errors,
    errorsOmitted: Math.max(0, state.errorCount - state.errors.length),
    stopReason,
    mutated: state.mutated,
  };
}

function parseValidDate(yearRaw: string, monthRaw: string, dayRaw: string): boolean {
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseDatedRecord(filename: string): DatedRecord | undefined {
  const issue = ISSUE_RECORD_RE.exec(filename);
  if (issue) {
    const issueNumber = Number(issue[1]);
    if (
      Number.isSafeInteger(issueNumber) &&
      parseValidDate(issue[2], issue[3], issue[4])
    ) {
      return { kind: "issue", issueNumber };
    }
    return undefined;
  }

  const release = RELEASE_RECORD_RE.exec(filename);
  if (release && parseValidDate(release[1], release[2], release[3])) {
    return { kind: "release" };
  }
  return undefined;
}

function normalizeClosedIssueNumbers(raw: unknown): Set<number> | KnowledgeMaintenanceFailure {
  if (raw === undefined) {
    return new Set<number>();
  }
  if (!Array.isArray(raw)) {
    return failure(
      "rejected",
      "invalid-closed-issue-evidence",
      "knowledge maintain closed-issue evidence must be a JSON array of positive issue numbers.",
    );
  }
  if (raw.length > KNOWLEDGE_MAINTENANCE_MAX_CLOSED_ISSUES) {
    return failure(
      "rejected",
      "closed-issue-evidence-too-large",
      `knowledge maintain accepts at most ${KNOWLEDGE_MAINTENANCE_MAX_CLOSED_ISSUES} closed issue numbers.`,
    );
  }

  const result = new Set<number>();
  for (const value of raw) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) {
      return failure(
        "rejected",
        "invalid-closed-issue-evidence",
        "knowledge maintain closed-issue evidence must contain only positive integer issue numbers.",
      );
    }
    result.add(Number(value));
  }
  return result;
}

function parseFrontmatter(markdown: string): Record<string, unknown> | undefined {
  const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return undefined;
  }
  const closing = normalized.indexOf("\n---", 4);
  if (closing < 0) {
    return undefined;
  }
  try {
    const parsed = parseYaml(normalized.slice(4, closing));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function collectMaintenanceCandidates(
  layout: ResolvedKnowledgeV2Layout,
  closedIssueNumbers: ReadonlySet<number>,
  nowMs: number,
  state: MutableManifestState,
): MaintenanceCandidateCollection {
  const candidates: MaintenanceCandidate[] = [];
  const projectRoot = layout.paths.pageTypeDirs.project;
  let complete = true;
  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = realpathSync(layout.agentWorkspaceRoot);
  } catch (error) {
    addError(
      state,
      ".",
      "scan-failed",
      `Could not inspect the workspace root before scanning project records: ${errorMessage(error)}`,
    );
    return { candidates, complete: false };
  }

  const inspectDirectory = (dir: string): "directory" | "missing" | "unsafe" => {
    if (!isInsidePath(layout.agentWorkspaceRoot, dir)) {
      addError(state, toWorkspaceRel(layout.agentWorkspaceRoot, dir), "scan-escape", "Project scan path escaped the workspace.");
      return "unsafe";
    }
    let current = layout.agentWorkspaceRoot;
    for (const part of relative(layout.agentWorkspaceRoot, dir).split(sep).filter(Boolean)) {
      current = join(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) {
          addError(
            state,
            toWorkspaceRel(layout.agentWorkspaceRoot, current),
            "symlink-rejected",
            "Maintenance does not follow symlinked project paths.",
          );
          return "unsafe";
        }
        if (!stat.isDirectory()) {
          addError(
            state,
            toWorkspaceRel(layout.agentWorkspaceRoot, current),
            "scan-failed",
            "Project scan path component is not a directory.",
          );
          return "unsafe";
        }
        if (!isInsidePath(realWorkspaceRoot, realpathSync(current))) {
          addError(
            state,
            toWorkspaceRel(layout.agentWorkspaceRoot, current),
            "scan-escape",
            "Project scan path real location escaped the workspace.",
          );
          return "unsafe";
        }
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return "missing";
        }
        addError(
          state,
          toWorkspaceRel(layout.agentWorkspaceRoot, current),
          "scan-failed",
          `Could not inspect the project scan path: ${errorMessage(error)}`,
        );
        return "unsafe";
      }
    }
    return "directory";
  };

  const walk = (dir: string): void => {
    const directoryStatus = inspectDirectory(dir);
    if (directoryStatus === "missing") {
      return;
    }
    if (directoryStatus === "unsafe") {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        complete = false;
        addError(
          state,
          toWorkspaceRel(layout.agentWorkspaceRoot, dir),
          "scan-failed",
          `Could not enumerate project records: ${errorMessage(error)}`,
        );
      }
      return;
    }

    for (const entry of entries.sort((a, b) => comparePath(a.name, b.name))) {
      const absPath = join(dir, entry.name);
      const relPath = toWorkspaceRel(layout.agentWorkspaceRoot, absPath);
      if (entry.isSymbolicLink()) {
        addError(state, relPath, "symlink-rejected", "Maintenance does not follow symlinked project paths.");
        continue;
      }
      if (entry.isDirectory()) {
        walk(absPath);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".md") {
        continue;
      }

      const datedRecord = parseDatedRecord(entry.name);
      if (!datedRecord) {
        state.skipped.nonDated += 1;
        continue;
      }
      if (
        datedRecord.kind === "issue" &&
        !closedIssueNumbers.has(datedRecord.issueNumber as number)
      ) {
        state.skipped.issueNotProvenClosed += 1;
        continue;
      }

      let stat;
      let markdown: string;
      let pageBytes: Buffer;
      try {
        stat = lstatSync(absPath);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          addError(state, relPath, "candidate-not-regular", "Maintenance candidates must be regular files.");
          continue;
        }
        pageBytes = Buffer.from(readFileSync(absPath));
        markdown = pageBytes.toString("utf8");
      } catch (error) {
        addError(
          state,
          relPath,
          "candidate-unreadable",
          `Could not inspect the dated project record: ${errorMessage(error)}`,
        );
        continue;
      }

      const frontmatter = parseFrontmatter(markdown);
      if (!frontmatter) {
        addError(state, relPath, "candidate-frontmatter-invalid", "Dated project record frontmatter is unreadable.");
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(frontmatter, "revisit_if")) {
        state.skipped.mixed += 1;
        continue;
      }
      const validated = validateKnowledgePageFrontmatter(frontmatter, "project");
      if ("ok" in validated && validated.ok === false) {
        addError(state, relPath, validated.reason, validated.message);
        continue;
      }
      if (nowMs - stat.mtimeMs < MIN_AGE_MS) {
        state.skipped.recentlyModified += 1;
        continue;
      }
      candidates.push({
        relPath,
        mtimeMs: stat.mtimeMs,
        expectedBytes: pageBytes,
      });
    }
  };

  walk(projectRoot);
  return {
    candidates: candidates.sort(
      (left, right) =>
        left.mtimeMs - right.mtimeMs ||
        comparePath(left.relPath, right.relPath),
    ),
    complete,
  };
}

function snapshotFile(path: string): FileSnapshot {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { kind: "other" };
    }
    return {
      kind: "file",
      bytes: Buffer.from(readFileSync(path)),
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "other" };
  }
}

function snapshotCandidate(
  layout: ResolvedKnowledgeV2Layout,
  relPath: string,
): CandidateSnapshot {
  return {
    indexBytes: readIndexBytes(layout),
    active: snapshotFile(resolve(layout.agentWorkspaceRoot, ...relPath.split("/"))),
    archive: snapshotFile(resolve(
      layout.paths.knowledgeArchiveDir,
      ...relPath.split("/"),
    )),
  };
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.kind === right.kind &&
    (
      left.kind !== "file" ||
      (
        left.mtimeMs === right.mtimeMs &&
        Boolean(left.bytes?.equals(right.bytes as Buffer))
      )
    )
  );
}

function sameCandidateSnapshot(left: CandidateSnapshot, right: CandidateSnapshot): boolean {
  return (
    left.indexBytes.equals(right.indexBytes) &&
    sameFileSnapshot(left.active, right.active) &&
    sameFileSnapshot(left.archive, right.archive)
  );
}

function successfulArchiveMatches(
  before: CandidateSnapshot,
  after: CandidateSnapshot,
): boolean {
  return (
    before.active.kind === "file" &&
    before.archive.kind === "missing" &&
    after.active.kind === "missing" &&
    after.archive.kind === "file" &&
    Boolean(before.active.bytes?.equals(after.archive.bytes as Buffer))
  );
}

function reportTargetFor(
  raw: unknown,
  workspaceRoot: string,
): ReportTarget | KnowledgeMaintenanceFailure | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== "string" || !raw.trim()) {
    return failure(
      "rejected",
      "knowledge-maintenance-report-path-invalid",
      "knowledge maintain report path must be a non-empty JSON file path.",
    );
  }

  const root = normalize(resolve(workspaceRoot));
  const target = normalize(
    isAbsolute(raw.trim()) ? resolve(raw.trim()) : resolve(root, raw.trim()),
  );
  if (!isInsidePath(root, target) || target === root) {
    return failure(
      "rejected",
      "knowledge-maintenance-report-path-invalid",
      "knowledge maintain report path must stay inside the agent workspace.",
    );
  }
  const relPath = toWorkspaceRel(root, target);
  const updateLockPath = resolve(root, KNOWLEDGE_UPDATE_LOCK_RELPATH);
  if (
    extname(target).toLowerCase() !== ".json" ||
    relPath === "wiki" ||
    relPath.startsWith("wiki/") ||
    relPath === "artifacts/knowledge-archive" ||
    relPath.startsWith("artifacts/knowledge-archive/") ||
    isInsidePath(updateLockPath, target)
  ) {
    return failure(
      "rejected",
      "knowledge-maintenance-report-path-invalid",
      "knowledge maintain report path must be a JSON file outside managed Knowledge and archive paths.",
    );
  }

  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        return failure(
          "rejected",
          "knowledge-maintenance-report-path-invalid",
          "knowledge maintain refuses symlinked report paths.",
        );
      }
      if (current === target ? !stat.isFile() : !stat.isDirectory()) {
        return failure(
          "rejected",
          "knowledge-maintenance-report-path-invalid",
          "knowledge maintain report path components have incompatible filesystem types.",
        );
      }
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        break;
      }
      return failure(
        "rejected",
        "knowledge-maintenance-report-path-invalid",
        `knowledge maintain could not inspect the report path: ${boundedMessage(errorMessage(error))}`,
      );
    }
  }
  return { absPath: target, relPath };
}

function writeReport(target: ReportTarget, response: KnowledgeMaintenanceSuccess): void {
  mkdirSync(dirname(target.absPath), { recursive: true });
  const tempPath = join(
    dirname(target.absPath),
    `.${basename(target.absPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    writeFileSync(tempPath, `${JSON.stringify(response, null, 2)}\n`, "utf8");
    renameSync(tempPath, target.absPath);
  } catch (error) {
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {
      // Preserve the report write failure.
    }
    throw error;
  }
}

function finalizeSuccess(
  layout: ResolvedKnowledgeV2Layout,
  manifest: KnowledgeMaintenanceManifest,
  reportTarget?: ReportTarget,
): KnowledgeMaintenanceResponse {
  const response: KnowledgeMaintenanceSuccess = {
    ok: true,
    layoutKind: "v2",
    ...manifest,
    ...(reportTarget ? { reportPath: reportTarget.relPath } : {}),
  };
  if (!reportTarget) {
    return response;
  }
  try {
    writeReport(reportTarget, response);
    return response;
  } catch (error) {
    return failure(
      "error",
      "knowledge-maintenance-report-write-failed",
      `knowledge maintain could not write its report: ${boundedMessage(errorMessage(error))}`,
      {
        layoutKind: layout.kind,
        manifest,
        reportPath: reportTarget.relPath,
      },
    );
  }
}

export function executeKnowledgeMaintenance(
  args: KnowledgeMaintenanceArgs = {},
  deps: KnowledgeMaintenanceDeps = {},
): KnowledgeMaintenanceResponse {
  const workspaceRoot = resolveAgentWorkspaceRoot(deps);
  if (!workspaceRoot) {
    return failure(
      "unavailable",
      "agent-workspace-unset",
      "knowledge maintain requires an agent workspace from --workspace or MINIME_AGENT_WORKSPACE_ROOT.",
    );
  }

  const layout = (deps.resolveLayout ?? resolveKnowledgeLayout)(workspaceRoot);
  if (layout.kind !== "v2") {
    return failure(
      "unsupported",
      "knowledge-maintenance-requires-v2",
      "knowledge maintain operates only on positively detected Knowledge v2 workspaces.",
      { layoutKind: layout.kind },
    );
  }

  const reportTarget = reportTargetFor(args.reportPath, workspaceRoot);
  if (isMaintenanceFailure(reportTarget)) {
    return { ...reportTarget, layoutKind: layout.kind };
  }

  let indexBytes: Buffer;
  try {
    indexBytes = readIndexBytes(layout);
  } catch (error) {
    return failure(
      "error",
      "knowledge-maintenance-index-unreadable",
      `knowledge maintain could not read wiki/index.md: ${boundedMessage(errorMessage(error))}`,
      { layoutKind: layout.kind },
    );
  }

  const bytesBefore = indexBytes.byteLength;
  const state = emptyState();
  if (bytesBefore <= KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES) {
    return finalizeSuccess(
      layout,
      buildManifest(state, bytesBefore, bytesBefore, "below-high-watermark"),
      reportTarget,
    );
  }

  let closedIssueNumbers: Set<number> | KnowledgeMaintenanceFailure;
  try {
    const rawEvidence = deps.loadClosedIssueNumbers
      ? deps.loadClosedIssueNumbers()
      : args.closedIssueNumbers;
    closedIssueNumbers = normalizeClosedIssueNumbers(rawEvidence);
  } catch (error) {
    closedIssueNumbers = failure(
      "rejected",
      "invalid-closed-issue-evidence",
      `knowledge maintain could not load closed-issue evidence: ${boundedMessage(errorMessage(error))}`,
      { layoutKind: layout.kind },
    );
  }
  if (!(closedIssueNumbers instanceof Set)) {
    return { ...closedIssueNumbers, layoutKind: layout.kind };
  }

  const now = deps.now?.() ?? new Date();
  const candidateCollection = collectMaintenanceCandidates(
    layout,
    closedIssueNumbers,
    now.getTime(),
    state,
  );
  if (!candidateCollection.complete) {
    return finalizeSuccess(
      layout,
      buildManifest(state, bytesBefore, bytesBefore, "unsafe-failure"),
      reportTarget,
    );
  }
  const candidates = candidateCollection.candidates;
  const update = deps.executeUpdate ?? executeKnowledgeUpdate;
  let bytesAfter = bytesBefore;
  let stopReason: KnowledgeMaintenanceStopReason = "eligible-exhausted";

  for (const candidate of candidates) {
    let before: CandidateSnapshot;
    try {
      before = snapshotCandidate(layout, candidate.relPath);
      bytesAfter = before.indexBytes.byteLength;
    } catch (error) {
      addError(
        state,
        candidate.relPath,
        "candidate-state-unreadable",
        `Could not capture pre-archive state: ${errorMessage(error)}`,
      );
      stopReason = "unsafe-failure";
      break;
    }
    if (bytesAfter <= KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES) {
      stopReason = "low-watermark-reached";
      break;
    }

    if (
      before.active.kind !== "file" ||
      before.active.mtimeMs !== candidate.mtimeMs ||
      !candidate.expectedBytes.equals(before.active.bytes as Buffer)
    ) {
      addError(
        state,
        candidate.relPath,
        "candidate-changed",
        "Dated project record changed after eligibility evaluation and was skipped.",
      );
      continue;
    }

    let response: KnowledgeUpdateResponse | undefined;
    let updateError: unknown;
    try {
      response = update(
        { op: "archive", path: candidate.relPath },
        {
          agentWorkspaceRoot: workspaceRoot,
          env: deps.env ?? process.env,
          now: deps.now,
          archivePrecondition: {
            expectedSourceBytes: candidate.expectedBytes,
            expectedSourceMtimeMs: candidate.mtimeMs,
            indexMustExceedBytes: KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES,
          },
        },
      );
    } catch (error) {
      updateError = error;
    }

    let after: CandidateSnapshot;
    try {
      after = snapshotCandidate(layout, candidate.relPath);
      bytesAfter = after.indexBytes.byteLength;
    } catch (error) {
      addError(
        state,
        candidate.relPath,
        "candidate-state-unreadable",
        `Could not verify post-archive state: ${errorMessage(error)}`,
      );
      state.mutated = true;
      stopReason = "unsafe-failure";
      break;
    }

    if (!response) {
      addError(
        state,
        candidate.relPath,
        "archive-threw",
        `Managed archive threw before returning a result: ${errorMessage(updateError)}`,
      );
      if (sameCandidateSnapshot(before, after)) {
        continue;
      }
      state.mutated = true;
      stopReason = "unsafe-failure";
      break;
    }

    if (!response.ok) {
      if (
        response.status === "rejected" &&
        response.reason === KNOWLEDGE_ARCHIVE_PRECONDITION_LOW_WATERMARK_REASON
      ) {
        stopReason = "low-watermark-reached";
        break;
      }
      if (
        response.status === "rejected" &&
        response.reason === KNOWLEDGE_ARCHIVE_PRECONDITION_CHANGED_REASON
      ) {
        addError(state, candidate.relPath, response.reason, response.message);
        continue;
      }
      addError(state, candidate.relPath, response.reason, response.message);
      if (
        (response.status === "rejected" || response.status === "locked") &&
        sameCandidateSnapshot(before, after)
      ) {
        continue;
      }
      if (!sameCandidateSnapshot(before, after)) {
        state.mutated = true;
      }
      stopReason = "unsafe-failure";
      break;
    }

    if (
      response.operation !== "archive" ||
      response.action !== "archived" ||
      !successfulArchiveMatches(before, after)
    ) {
      addError(
        state,
        candidate.relPath,
        "archive-verification-failed",
        "Managed archive returned success without the expected byte-identical active-to-archive move.",
      );
      if (!sameCandidateSnapshot(before, after)) {
        state.mutated = true;
      }
      stopReason = "unsafe-failure";
      break;
    }

    state.archivedCount += 1;
    state.mutated = true;
    if (state.archivedPaths.length < KNOWLEDGE_MAINTENANCE_MAX_ARCHIVED_PATHS) {
      state.archivedPaths.push(candidate.relPath);
    }
    if (bytesAfter <= KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES) {
      stopReason = "low-watermark-reached";
      break;
    }
  }

  return finalizeSuccess(
    layout,
    buildManifest(state, bytesBefore, bytesAfter, stopReason),
    reportTarget,
  );
}

export function formatKnowledgeMaintenanceResponse(
  response: KnowledgeMaintenanceResponse,
): string {
  return JSON.stringify(response, null, 2);
}
