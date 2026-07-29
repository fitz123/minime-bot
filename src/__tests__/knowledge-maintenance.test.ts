import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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

  it("recognizes deployed CalVer release and descriptive issue page names", () => {
    const releaseWorkspace = createWorkspace();
    const releasePath = "wiki/pages/project/minime-bot/release-2026-7-39.md";
    addPage(releaseWorkspace, releasePath);
    writeExactIndexSize(
      releaseWorkspace,
      KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1,
    );

    const releaseResponse = executeKnowledgeMaintenance(
      {},
      { agentWorkspaceRoot: releaseWorkspace, now: () => NOW },
    );
    assertMaintenanceOk(releaseResponse);
    assert.deepEqual(releaseResponse.archivedPaths, [releasePath]);

    const issueWorkspace = createWorkspace();
    const issuePath = "wiki/pages/project/minime-bot/issue-103-terminal-cron-health.md";
    addPage(issueWorkspace, issuePath);
    writeExactIndexSize(
      issueWorkspace,
      KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1,
    );

    const issueResponse = executeKnowledgeMaintenance(
      { closedIssueNumbers: [103] },
      { agentWorkspaceRoot: issueWorkspace, now: () => NOW },
    );
    assertMaintenanceOk(issueResponse);
    assert.deepEqual(issueResponse.archivedPaths, [issuePath]);
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
      const bucket =
        index === 0
          ? "Z-bucket"
          : index === 1
            ? "a-bucket"
            : `bucket-${String(index).padStart(3, "0")}`;
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
      "wiki/pages/project/Z-bucket/release-2026-01-01.md",
      "wiki/pages/project/a-bucket/release-2026-01-01.md",
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
        "wiki/pages/project/history/issue-010-invalid-name.md",
        frontmatter("Invalid issue number"),
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

  it("continues after a state-preserving archive throw and verifies the next candidate", () => {
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
            throw new Error("Injected state-preserving throw.");
          }
          return executeKnowledgeUpdate(args, deps);
        },
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.archivedCount, 1);
    assert.deepEqual(response.archivedPaths, [second]);
    assert.equal(response.errors[0]?.reason, "archive-threw");
    assert.equal(existsSync(join(workspace, ...first.split("/"))), true);
    assert.equal(existsSync(join(workspace, ...second.split("/"))), false);
  });

  it("passes a live operation clock to archives instead of pinning the scan timestamp", () => {
    const workspace = createWorkspace();
    const relPath = "wiki/pages/project/history/release-2026-01-01.md";
    addPage(workspace, relPath, frontmatter("Live archive clock"));
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);
    let currentTime = NOW;
    const clock = () => currentTime;

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: clock,
        executeUpdate: (_args, deps) => {
          currentTime = new Date(NOW.getTime() + 11 * 60 * 1_000);
          assert.equal(deps?.now, clock);
          assert.equal(deps.now?.(), currentTime);
          return {
            ok: false,
            status: "rejected",
            reason: "injected-safe-rejection",
            message: "Clock contract verified without mutation.",
          };
        },
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.archivedCount, 0);
    assert.equal(response.mutated, false);
    assert.equal(response.errors[0]?.reason, "injected-safe-rejection");
  });

  it("stops safely when an updater reports success without performing the archive", () => {
    const workspace = createWorkspace();
    const relPath = "wiki/pages/project/history/release-2026-01-01.md";
    addPage(workspace, relPath, frontmatter("False success"));
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: () => NOW,
        executeUpdate: () => ({
          ok: true,
          layoutKind: "v2",
          operation: "archive",
          action: "archived",
          path: relPath,
          archivePath: `artifacts/knowledge-archive/${relPath}`,
          indexPath: "wiki/index.md",
          logPath: "wiki/log.md",
          lockPath: ".tmp/knowledge-update.lock",
        }),
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.stopReason, "unsafe-failure");
    assert.equal(response.archivedCount, 0);
    assert.equal(response.mutated, false);
    assert.equal(response.errors[0]?.reason, "archive-verification-failed");
    assert.equal(existsSync(join(workspace, ...relPath.split("/"))), true);
  });

  it("rejects a partial updater success that moves bytes without updating index and log", () => {
    const workspace = createWorkspace();
    const relPath = "wiki/pages/project/history/release-2026-01-01.md";
    const activePath = addPage(workspace, relPath, frontmatter("Partial success")).absPath;
    const archiveRelPath = `artifacts/knowledge-archive/${relPath}`;
    const archivePath = join(workspace, ...archiveRelPath.split("/"));
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: () => NOW,
        executeUpdate: () => {
          mkdirSync(dirname(archivePath), { recursive: true });
          linkSync(activePath, archivePath);
          unlinkSync(activePath);
          return {
            ok: true,
            layoutKind: "v2",
            operation: "archive",
            action: "archived",
            path: relPath,
            archivePath: archiveRelPath,
            indexPath: "wiki/index.md",
            logPath: "wiki/log.md",
            lockPath: ".tmp/knowledge-update.lock",
          };
        },
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.stopReason, "unsafe-failure");
    assert.equal(response.archivedCount, 0);
    assert.equal(response.mutated, true);
    assert.equal(response.errors[0]?.reason, "archive-verification-failed");
    assert.equal(response.bytesAfter, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);
    assert.equal(existsSync(join(workspace, "wiki/log.md")), false);
  });

  it("treats a log-only failed updater as unsafe state drift", () => {
    const workspace = createWorkspace();
    const relPath = "wiki/pages/project/history/release-2026-01-01.md";
    addPage(workspace, relPath, frontmatter("Log drift"));
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: () => NOW,
        executeUpdate: () => {
          writeWorkspaceFile(workspace, "wiki/log.md", "- injected drift\n");
          return {
            ok: false,
            status: "rejected",
            reason: "injected-log-drift",
            message: "Injected failure with log-only drift.",
          };
        },
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.stopReason, "unsafe-failure");
    assert.equal(response.archivedCount, 0);
    assert.equal(response.mutated, true);
    assert.equal(response.errors[0]?.reason, "injected-log-drift");
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
    assert.equal(response.mutated, true);
    assert.equal(response.errors[0]?.reason, "injected-unsafe-failure");
    assert.equal(response.bytesAfter, Buffer.byteLength("changed\n"));
    assert.equal(existsSync(join(workspace, ...relPath.split("/"))), true);
  });

  it("marks a throwing updater with state drift as unsafe and mutated", () => {
    const workspace = createWorkspace();
    const relPath = "wiki/pages/project/history/release-2026-01-01.md";
    addPage(workspace, relPath, frontmatter("Unsafe throw"));
    writeExactIndexSize(workspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const response = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: workspace,
        now: () => NOW,
        executeUpdate: () => {
          writeFileSync(join(workspace, "wiki/index.md"), "changed by throw\n", "utf8");
          throw new Error("Injected throw with state drift.");
        },
      },
    );

    assertMaintenanceOk(response);
    assert.equal(response.stopReason, "unsafe-failure");
    assert.equal(response.archivedCount, 0);
    assert.equal(response.mutated, true);
    assert.equal(response.errors[0]?.reason, "archive-threw");
  });

  it("revalidates candidate bytes and low-watermark pressure under the archive lock", () => {
    const changedWorkspace = createWorkspace();
    const changedPath = "wiki/pages/project/history/release-2026-01-01.md";
    const changedPage = addPage(changedWorkspace, changedPath, frontmatter("Changed under lock"));
    writeExactIndexSize(changedWorkspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const changedResponse = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: changedWorkspace,
        now: () => NOW,
        executeUpdate: (args, deps) => {
          writeFileSync(
            changedPage.absPath,
            formatKnowledgePage(
              frontmatter("Changed under lock", "Now current", "when work resumes"),
              "# Current again\n",
            ),
            "utf8",
          );
          utimesSync(changedPage.absPath, NOW, NOW);
          return executeKnowledgeUpdate(args, deps);
        },
      },
    );
    assertMaintenanceOk(changedResponse);
    assert.equal(changedResponse.archivedCount, 0);
    assert.equal(changedResponse.stopReason, "eligible-exhausted");
    assert.equal(changedResponse.mutated, false);
    assert.equal(changedResponse.errors[0]?.reason, "archive-precondition-changed");
    assert.equal(existsSync(changedPage.absPath), true);

    const lowWorkspace = createWorkspace();
    const lowPath = "wiki/pages/project/history/release-2026-01-01.md";
    const lowPage = addPage(lowWorkspace, lowPath, frontmatter("Pressure cleared"));
    writeExactIndexSize(lowWorkspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);
    const lowResponse = executeKnowledgeMaintenance(
      {},
      {
        agentWorkspaceRoot: lowWorkspace,
        now: () => NOW,
        executeUpdate: (args, deps) => {
          writeExactIndexSize(lowWorkspace, KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES);
          return executeKnowledgeUpdate(args, deps);
        },
      },
    );
    assertMaintenanceOk(lowResponse);
    assert.equal(lowResponse.archivedCount, 0);
    assert.equal(lowResponse.stopReason, "low-watermark-reached");
    assert.equal(lowResponse.bytesAfter, KNOWLEDGE_MAINTENANCE_LOW_WATERMARK_BYTES);
    assert.equal(lowResponse.mutated, false);
    assert.equal(existsSync(lowPage.absPath), true);
  });

  it("fails closed before mutation when a dated candidate cannot be validated", () => {
    const workspace = createWorkspace();
    const valid = addPage(
      workspace,
      "wiki/pages/project/history/release-2026-7-39.md",
    );
    writeWorkspaceFile(
      workspace,
      "wiki/pages/project/history/release-2026-6-0.md",
      "# Missing required frontmatter\n",
    );
    writeExactIndexSize(
      workspace,
      KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1,
    );

    const response = executeKnowledgeMaintenance(
      {},
      { agentWorkspaceRoot: workspace, now: () => NOW },
    );

    assertMaintenanceOk(response);
    assert.equal(response.stopReason, "unsafe-failure");
    assert.equal(response.archivedCount, 0);
    assert.equal(response.mutated, false);
    assert.equal(existsSync(valid.absPath), true);
    assert.ok(response.errors.some((error) => error.reason === "candidate-frontmatter-invalid"));
  });

  it("fails closed before mutation when the project scan root is symlinked or unreadable", () => {
    const symlinkWorkspace = createWorkspace();
    const outside = mkdtempSync(join(tmpdir(), "minime-knowledge-maintenance-outside-"));
    fixtures.push(outside);
    const outsidePage = writeWorkspaceFile(
      outside,
      "release-2026-01-01.md",
      formatKnowledgePage(frontmatter("Outside"), "# Outside\n"),
    );
    utimesSync(outsidePage, OLD, OLD);
    mkdirSync(join(symlinkWorkspace, "wiki/pages"), { recursive: true });
    symlinkSync(outside, join(symlinkWorkspace, "wiki/pages/project"), "dir");
    writeExactIndexSize(symlinkWorkspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);

    const symlinkResponse = executeKnowledgeMaintenance(
      {},
      { agentWorkspaceRoot: symlinkWorkspace, now: () => NOW },
    );
    assertMaintenanceOk(symlinkResponse);
    assert.equal(symlinkResponse.stopReason, "unsafe-failure");
    assert.equal(symlinkResponse.archivedCount, 0);
    assert.equal(symlinkResponse.mutated, false);
    assert.equal(symlinkResponse.errors[0]?.reason, "symlink-rejected");
    assert.equal(existsSync(outsidePage), true);

    const unreadableWorkspace = createWorkspace();
    writeWorkspaceFile(unreadableWorkspace, "wiki/pages/project", "not a directory");
    writeExactIndexSize(unreadableWorkspace, KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1);
    const unreadableResponse = executeKnowledgeMaintenance(
      {},
      { agentWorkspaceRoot: unreadableWorkspace, now: () => NOW },
    );
    assertMaintenanceOk(unreadableResponse);
    assert.equal(unreadableResponse.stopReason, "unsafe-failure");
    assert.equal(unreadableResponse.archivedCount, 0);
    assert.equal(unreadableResponse.mutated, false);
    assert.equal(unreadableResponse.errors[0]?.reason, "scan-failed");

    const nestedSymlinkWorkspace = createWorkspace();
    const nestedCandidate = addPage(
      nestedSymlinkWorkspace,
      "wiki/pages/project/release-2026-01-01.md",
    );
    mkdirSync(join(nestedSymlinkWorkspace, "wiki/pages/project/history"), { recursive: true });
    symlinkSync(outside, join(nestedSymlinkWorkspace, "wiki/pages/project/history/link"), "dir");
    writeExactIndexSize(
      nestedSymlinkWorkspace,
      KNOWLEDGE_MAINTENANCE_HIGH_WATERMARK_BYTES + 1,
    );

    const nestedSymlinkResponse = executeKnowledgeMaintenance(
      {},
      { agentWorkspaceRoot: nestedSymlinkWorkspace, now: () => NOW },
    );
    assertMaintenanceOk(nestedSymlinkResponse);
    assert.equal(nestedSymlinkResponse.stopReason, "unsafe-failure");
    assert.equal(nestedSymlinkResponse.archivedCount, 0);
    assert.equal(nestedSymlinkResponse.mutated, false);
    assert.equal(existsSync(nestedCandidate.absPath), true);
    assert.ok(nestedSymlinkResponse.errors.some((error) => error.reason === "symlink-rejected"));
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
      ".tmp/knowledge-update.lock/report.json",
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
    assert.equal(existsSync(join(workspace, ".tmp/knowledge-update.lock")), false);
  });
});
