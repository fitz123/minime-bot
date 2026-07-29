import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import {
  executeKnowledgeMaintenance,
  KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES,
  KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES,
  KNOWLEDGE_MAINTENANCE_MAX_ARCHIVED_PATHS,
  KNOWLEDGE_MAINTENANCE_MAX_CLOSED_ISSUES,
  KNOWLEDGE_MAINTENANCE_MAX_ERRORS,
  type KnowledgeMaintenanceResponse,
} from "../knowledge/maintenance.js";
import {
  executeKnowledgeUpdate,
  formatKnowledgePage,
  generateKnowledgeIndex,
  type KnowledgePageFrontmatter,
  type ParsedPage,
} from "../knowledge/update.js";

const fixtures: string[] = [];
const NOW = new Date("2026-07-29T00:00:00.000Z");
const OLD = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1_000);

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function writeWorkspaceFile(root: string, relPath: string, content: string | Buffer): string {
  const path = join(root, ...relPath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "minime-knowledge-maintenance-"));
  fixtures.push(workspace);
  writeWorkspaceFile(workspace, "wiki/schema.md", generateKnowledgeV2Schema());
  writeWorkspaceFile(workspace, "wiki/index.md", "# Knowledge Index\n");
  return workspace;
}

function frontmatter(
  name: string,
  description = `${name} description`,
  revisitIf?: string,
): KnowledgePageFrontmatter {
  return {
    name,
    description,
    type: "project",
    ...(revisitIf ? { revisit_if: revisitIf } : {}),
  };
}

function addPage(
  workspace: string,
  relPath: string,
  pageFrontmatter = frontmatter(relPath),
  mtime = OLD,
): ParsedPage {
  const absPath = writeWorkspaceFile(
    workspace,
    relPath,
    formatKnowledgePage(pageFrontmatter, `# ${pageFrontmatter.name}\n\nDurable record.\n`),
  );
  utimesSync(absPath, mtime, mtime);
  return {
    absPath,
    relPath,
    linkPath: relative(join(workspace, "wiki"), absPath).split(sep).join("/"),
    frontmatter: pageFrontmatter,
  };
}

function writeGeneratedIndex(workspace: string, pages: readonly ParsedPage[]): number {
  const content = generateKnowledgeIndex(pages);
  writeWorkspaceFile(workspace, "wiki/index.md", content);
  return Buffer.byteLength(content);
}

function writeExactIndexSize(workspace: string, bytes: number): void {
  const prefix = "# Knowledge Index\n";
  assert.ok(Buffer.byteLength(prefix) <= bytes);
  writeWorkspaceFile(
    workspace,
    "wiki/index.md",
    `${prefix}${" ".repeat(bytes - Buffer.byteLength(prefix))}`,
  );
  assert.equal(readFileSync(join(workspace, "wiki/index.md")).byteLength, bytes);
}

function assertMaintenanceOk(
  response: KnowledgeMaintenanceResponse,
): asserts response is Extract<KnowledgeMaintenanceResponse, { ok: true }> {
  assert.equal(response.ok, true, JSON.stringify(response));
}

describe("knowledge maintenance", () => {
  it("keeps the 40960-byte fast path quiet, mutation-free, and evidence-lazy", () => {
    const workspace = createWorkspace();
    const relPath = "wiki/pages/project/history/release-2026-05-01.md";
    const page = addPage(workspace, relPath);
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES);
    let evidenceLoads = 0;

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: () => NOW,
        loadClosedIssueNumbers: () => {
          evidenceLoads += 1;
          throw new Error("fast path must not load evidence");
        },
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.bytesBefore, 40_960);
    assert.equal(response.bytesAfter, 40_960);
    assert.equal(response.stopReason, "below-high-watermark");
    assert.equal(response.mutated, false);
    assert.equal(response.archivedCount, 0);
    assert.equal(response.errors.length, 0);
    assert.equal(evidenceLoads, 0);
    assert.equal(existsSync(page.absPath), true);
    assert.equal(existsSync(join(workspace, "artifacts/knowledge-archive", relPath)), false);
  });

  it("activates at 40961 bytes and archives an old completed release through the managed updater", () => {
    const workspace = createWorkspace();
    const relPath = "wiki/pages/project/history/release-2026-05-01.md";
    addPage(workspace, relPath);
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const response = executeKnowledgeMaintenance(
      {},
      { agentWorkspaceRoot: workspace, now: () => NOW },
    );

    assertMaintenanceOk(response);
    assert.equal(response.bytesBefore, 40_961);
    assert.ok(response.bytesAfter <= KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES);
    assert.equal(response.stopReason, "low-watermark-reached");
    assert.equal(response.archivedCount, 1);
    assert.deepEqual(response.archivedPaths, [relPath]);
    assert.equal(existsSync(join(workspace, ...relPath.split("/"))), false);
    assert.equal(
      existsSync(join(workspace, "artifacts/knowledge-archive", ...relPath.split("/"))),
      true,
    );
    assert.match(readFileSync(join(workspace, "wiki/log.md"), "utf8"), / archive /);
  });

  it("treats exactly 30 days as eligible and a just-younger page as recent", () => {
    const workspace = createWorkspace();
    const exactPath = "wiki/pages/project/history/release-2026-04-01.md";
    const youngPath = "wiki/pages/project/history/release-2026-04-02.md";
    addPage(
      workspace,
      exactPath,
      frontmatter("Exact boundary"),
      new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1_000),
    );
    addPage(
      workspace,
      youngPath,
      frontmatter("Just younger"),
      new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1_000 + 1_000),
    );
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const response = executeKnowledgeMaintenance(
      {},
      { agentWorkspaceRoot: workspace, now: () => NOW },
    );

    assertMaintenanceOk(response);
    assert.deepEqual(response.archivedPaths, [exactPath]);
    assert.equal(response.skipped.recentlyModified, 1);
    assert.equal(existsSync(join(workspace, ...youngPath.split("/"))), true);
  });

  it("archives oldest-first with a path tiebreak and recalculates index bytes after every archive until low", () => {
    const workspace = createWorkspace();
    const pages: ParsedPage[] = [];
    const equalAge = new Date(OLD);
    for (let index = 0; index < 180; index += 1) {
      const bucket = `bucket-${String(index).padStart(3, "0")}`;
      pages.push(addPage(
        workspace,
        `wiki/pages/project/${bucket}/release-2026-01-01.md`,
        frontmatter(
          `Release ${index}`,
          `Completed release ${index} ${"x".repeat(260)}`,
        ),
        equalAge,
      ));
    }
    const initialBytes = writeGeneratedIndex(workspace, pages);
    assert.ok(initialBytes > KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES);
    const measuredSizes: number[] = [];

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: () => NOW,
        executeUpdate: (args, deps) => {
          const result = executeKnowledgeUpdate(args, deps);
          if (result.ok) {
            measuredSizes.push(readFileSync(join(workspace, "wiki/index.md")).byteLength);
          }
          return result;
        },
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.stopReason, "low-watermark-reached");
    assert.ok(response.archivedCount > 1);
    assert.equal(measuredSizes.length, response.archivedCount);
    assert.equal(response.bytesAfter, measuredSizes.at(-1));
    assert.ok(response.bytesAfter <= KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES);
    assert.ok(measuredSizes.every((size, index) => index === 0 || size < measuredSizes[index - 1]));
    assert.deepEqual(response.archivedPaths.slice(0, 2), [
      "wiki/pages/project/bucket-000/release-2026-01-01.md",
      "wiki/pages/project/bucket-001/release-2026-01-01.md",
    ]);
  });

  it("reports eligible exhaustion above low when only one old completed record can be removed", () => {
    const workspace = createWorkspace();
    const pages: ParsedPage[] = [];
    const eligible = "wiki/pages/project/history/release-2026-01-01.md";
    pages.push(addPage(workspace, eligible, frontmatter("Eligible")));
    for (let index = 0; index < 120; index += 1) {
      pages.push(addPage(
        workspace,
        `wiki/pages/project/current-${String(index).padStart(3, "0")}.md`,
        frontmatter(`Current ${index}`, `Current record ${"x".repeat(300)}`),
      ));
    }
    assert.ok(writeGeneratedIndex(workspace, pages) > KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES);

    const response = executeKnowledgeMaintenance(
      {},
      { agentWorkspaceRoot: workspace, now: () => NOW },
    );

    assertMaintenanceOk(response);
    assert.equal(response.archivedCount, 1);
    assert.equal(response.stopReason, "eligible-exhausted");
    assert.ok(response.bytesAfter > KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES);
    assert.equal(response.skipped.nonDated, 120);
  });

  it("skips mixed, recent, open or unproven issue, and non-dated project pages fail-safe", () => {
    const workspace = createWorkspace();
    const pages = [
      addPage(
        workspace,
        "wiki/pages/project/history/issue-10-2026-01-01.md",
        frontmatter("Closed but mixed", "Mixed", "when work resumes"),
      ),
      addPage(
        workspace,
        "wiki/pages/project/history/issue-11-2026-01-01.md",
        frontmatter("Closed but recent"),
        new Date(NOW.getTime() - 2 * 24 * 60 * 60 * 1_000),
      ),
      addPage(
        workspace,
        "wiki/pages/project/history/issue-12-2026-01-01.md",
        frontmatter("Known open"),
      ),
      addPage(
        workspace,
        "wiki/pages/project/history/issue-13-2026-01-01.md",
        frontmatter("No completion evidence"),
      ),
      addPage(
        workspace,
        "wiki/pages/project/history/issue-10-2026-02-30.md",
        frontmatter("Invalid filename date"),
      ),
      addPage(
        workspace,
        "wiki/pages/project/history/project-notes.md",
        frontmatter("Non dated"),
      ),
    ];
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const response = executeKnowledgeMaintenance(
      { closedIssueNumbers: [10, 11] },
      { agentWorkspaceRoot: workspace, now: () => NOW },
    );

    assertMaintenanceOk(response);
    assert.equal(response.archivedCount, 0);
    assert.equal(response.stopReason, "eligible-exhausted");
    assert.equal(response.skipped.mixed, 1);
    assert.equal(response.skipped.recentlyModified, 1);
    assert.equal(response.skipped.issueNotProvenClosed, 2);
    assert.equal(response.skipped.nonDated, 2);
    assert.ok(pages.every((page) => existsSync(page.absPath)));
  });

  it("continues after a state-preserving per-page rejection and archives the next candidate", () => {
    const workspace = createWorkspace();
    const first = "wiki/pages/project/a/release-2026-01-01.md";
    const second = "wiki/pages/project/b/release-2026-01-01.md";
    addPage(workspace, first, frontmatter("First"), new Date(OLD.getTime() - 1_000));
    addPage(workspace, second, frontmatter("Second"), OLD);
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: () => NOW,
        executeUpdate: (args, deps) => {
          if (args.path === first) {
            return {
              ok: false,
              status: "rejected",
              reason: "injected-safe-rejection",
              message: "Injected state-preserving rejection.",
            };
          }
          return executeKnowledgeUpdate(args, deps);
        },
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.archivedCount, 1);
    assert.deepEqual(response.archivedPaths, [second]);
    assert.equal(response.errors[0]?.reason, "injected-safe-rejection");
    assert.equal(existsSync(join(workspace, ...first.split("/"))), true);
    assert.equal(existsSync(join(workspace, ...second.split("/"))), false);
  });

  it("stops after a failed archive when post-failure state no longer matches", () => {
    const workspace = createWorkspace();
    const relPath = "wiki/pages/project/history/release-2026-01-01.md";
    addPage(workspace, relPath, frontmatter("Unsafe failure"));
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: () => NOW,
        executeUpdate: () => {
          writeFileSync(join(workspace, "wiki/index.md"), "changed\n", "utf8");
          return {
            ok: false,
            status: "error",
            reason: "injected-unsafe-failure",
            message: "Injected failure with state drift.",
          };
        },
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.stopReason, "unsafe-failure");
    assert.equal(response.archivedCount, 0);
    assert.equal(response.errors[0]?.reason, "injected-unsafe-failure");
    assert.equal(response.bytesAfter, Buffer.byteLength("changed\n"));
    assert.equal(existsSync(join(workspace, ...relPath.split("/"))), true);
  });

  it("bounds closed evidence and error arrays without mutating rejected candidates", () => {
    const workspace = createWorkspace();
    for (let index = 0; index < KNOWLEDGE_MAINTENANCE_MAX_ERRORS + 5; index += 1) {
      addPage(
        workspace,
        `wiki/pages/project/bucket-${index}/release-2026-01-01.md`,
        frontmatter(`Release ${index}`),
      );
    }
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);
    const oversizedEvidence = Array.from(
      { length: KNOWLEDGE_MAINTENANCE_MAX_CLOSED_ISSUES + 1 },
      (_, index) => index + 1,
    );

    const evidenceFailure = executeKnowledgeMaintenance(
      { closedIssueNumbers: oversizedEvidence },
      { agentWorkspaceRoot: workspace, now: () => NOW },
    );
    assert.equal(evidenceFailure.ok, false);
    assert.equal(evidenceFailure.reason, "closed-issue-evidence-too-large");

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: () => NOW,
        executeUpdate: () => ({
          ok: false,
          status: "rejected",
          reason: "injected-safe-rejection",
          message: "x".repeat(1_000),
        }),
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.errors.length, KNOWLEDGE_MAINTENANCE_MAX_ERRORS);
    assert.equal(response.errorsOmitted, 5);
    assert.ok(response.errors.every((error) => error.message.length <= 240));
    assert.equal(response.archivedCount, 0);
    assert.equal(response.mutated, false);
  });

  it("bounds archived paths and writes a workspace-contained JSON report", () => {
    const workspace = createWorkspace();
    const pages: ParsedPage[] = [];
    for (let index = 0; index < KNOWLEDGE_MAINTENANCE_MAX_ARCHIVED_PATHS + 1; index += 1) {
      pages.push(addPage(
        workspace,
        `wiki/pages/project/archive-${String(index).padStart(3, "0")}/release-2026-01-01.md`,
        frontmatter(`Archived ${index}`),
      ));
    }
    for (let index = 0; index < 130; index += 1) {
      pages.push(addPage(
        workspace,
        `wiki/pages/project/retained-${String(index).padStart(3, "0")}.md`,
        frontmatter(`Retained ${index}`, `Retained ${"x".repeat(300)}`),
      ));
    }
    assert.ok(writeGeneratedIndex(workspace, pages) > KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES);

    const response = executeKnowledgeMaintenance(
      { reportPath: "artifacts/maintenance/report.json" },
      { agentWorkspaceRoot: workspace, now: () => NOW },
    );

    assertMaintenanceOk(response);
    assert.equal(response.stopReason, "eligible-exhausted");
    assert.equal(response.archivedCount, KNOWLEDGE_MAINTENANCE_MAX_ARCHIVED_PATHS + 1);
    assert.equal(response.archivedPaths.length, KNOWLEDGE_MAINTENANCE_MAX_ARCHIVED_PATHS);
    assert.equal(response.archivedPathsOmitted, 1);
    assert.ok(response.bytesAfter > KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES);
    assert.equal(response.reportPath, "artifacts/maintenance/report.json");
    const report = JSON.parse(
      readFileSync(join(workspace, "artifacts/maintenance/report.json"), "utf8"),
    ) as KnowledgeMaintenanceResponse;
    assert.deepEqual(report, response);
  });

  it("rejects traversal, managed, and symlinked report paths before maintenance", () => {
    const workspace = createWorkspace();
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES);
    const outside = mkdtempSync(join(tmpdir(), "minime-knowledge-maintenance-report-"));
    fixtures.push(outside);
    symlinkSync(outside, join(workspace, "reports"), "dir");

    for (const reportPath of [
      "../outside.json",
      "wiki/report.json",
      "artifacts/knowledge-archive/report.json",
      "reports/report.json",
      "report.txt",
    ]) {
      const response = executeKnowledgeMaintenance(
        { reportPath },
        { agentWorkspaceRoot: workspace, now: () => NOW },
      );
      assert.equal(response.ok, false, reportPath);
      assert.equal(response.reason, "knowledge-maintenance-report-path-invalid");
    }
    assert.equal(existsSync(join(outside, "report.json")), false);
  });
});
