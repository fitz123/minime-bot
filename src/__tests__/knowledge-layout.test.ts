import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  KNOWLEDGE_PAGE_TYPES,
  KNOWLEDGE_V2_FORMAT,
  KNOWLEDGE_V2_VERSION,
  generateKnowledgeV2Schema,
  parseKnowledgeV2SchemaMarker,
  resolveKnowledgeLayout,
} from "../knowledge/layout.js";

const fixtures: string[] = [];

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createWorkspace(files: Record<string, string> = {}): string {
  const workspace = mkdtempSync(join(tmpdir(), "minime-knowledge-layout-"));
  fixtures.push(workspace);

  for (const [relpath, content] of Object.entries(files)) {
    const path = join(workspace, ...relpath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  return workspace;
}

describe("knowledge layout resolver", () => {
  it("detects v2 only from the package-owned schema marker plus index", () => {
    const workspace = createWorkspace({
      "wiki/schema.md": generateKnowledgeV2Schema(),
      "wiki/index.md": "# Knowledge Index\n",
    });

    const layout = resolveKnowledgeLayout(workspace);

    assert.equal(layout.kind, "v2");
    assert.equal(layout.marker.format, KNOWLEDGE_V2_FORMAT);
    assert.equal(layout.marker.version, KNOWLEDGE_V2_VERSION);
    assert.equal(layout.paths.schemaPath, join(workspace, "wiki", "schema.md"));
    assert.equal(layout.paths.indexPath, join(workspace, "wiki", "index.md"));
    assert.equal(layout.paths.pagesDir, join(workspace, "wiki", "pages"));
    assert.equal(layout.paths.pagesGlob, join(workspace, "wiki", "pages", "**"));
    assert.equal(layout.paths.diaryDir, join(workspace, "diary"));
    assert.equal(layout.paths.diaryGlob, join(workspace, "diary", "**"));
    assert.equal(layout.paths.issuesPath, join(workspace, "wiki", "issues.md"));
    assert.equal(layout.paths.logPath, join(workspace, "wiki", "log.md"));
    assert.equal(layout.paths.rawDir, join(workspace, "raw"));
    assert.equal(layout.paths.rawGlob, join(workspace, "raw", "**"));
    assert.equal(layout.paths.artifactsDir, join(workspace, "artifacts"));
    assert.equal(layout.paths.artifactsGlob, join(workspace, "artifacts", "**"));
    assert.deepEqual(Object.keys(layout.paths.pageTypeDirs).sort(), [...KNOWLEDGE_PAGE_TYPES].sort());
    assert.deepEqual(Object.keys(layout.paths.pageTypeGlobs).sort(), [...KNOWLEDGE_PAGE_TYPES].sort());
    assert.equal(layout.paths.pageTypeGlobs.project, join(workspace, "wiki", "pages", "project", "**"));
  });

  it("does not classify a marker-only schema as v2 without wiki/index.md", () => {
    const workspace = createWorkspace({
      "wiki/schema.md": generateKnowledgeV2Schema(),
    });

    const layout = resolveKnowledgeLayout(workspace);

    assert.equal(layout.kind, "none");
    assert.equal(layout.reason, "v2-index-missing");
  });

  it("detects legacy memory when the v2 marker is absent", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n",
      "memory/auto/topic.md": "# Topic\n",
      "memory/diary/2026-06-07.md": "# Diary\n",
    });

    const layout = resolveKnowledgeLayout(workspace);

    assert.equal(layout.kind, "legacy");
    assert.equal(layout.paths.memoryPath, join(workspace, "MEMORY.md"));
    assert.equal(layout.paths.autoDir, join(workspace, "memory", "auto"));
    assert.equal(layout.paths.autoGlob, join(workspace, "memory", "auto", "**"));
    assert.equal(layout.paths.diaryDir, join(workspace, "memory", "diary"));
    assert.equal(layout.paths.diaryGlob, join(workspace, "memory", "diary", "**"));
  });

  it("does not activate knowledge layouts through symlinked control files", () => {
    const schemaTarget = createWorkspace({
      "schema.md": generateKnowledgeV2Schema(),
      "index.md": "# Knowledge Index\n",
      "MEMORY.md": "# Memory\n",
    });
    const v2SchemaLink = createWorkspace({
      "wiki/index.md": "# Knowledge Index\n",
    });
    symlinkSync(join(schemaTarget, "schema.md"), join(v2SchemaLink, "wiki", "schema.md"));

    const v2IndexLink = createWorkspace({
      "wiki/schema.md": generateKnowledgeV2Schema(),
    });
    symlinkSync(join(schemaTarget, "index.md"), join(v2IndexLink, "wiki", "index.md"));

    const legacyLink = createWorkspace();
    symlinkSync(join(schemaTarget, "MEMORY.md"), join(legacyLink, "MEMORY.md"));

    const schemaLinkLayout = resolveKnowledgeLayout(v2SchemaLink);
    assert.equal(schemaLinkLayout.kind, "none");
    assert.equal(schemaLinkLayout.reason, "schema-unreadable");

    const indexLinkLayout = resolveKnowledgeLayout(v2IndexLink);
    assert.equal(indexLinkLayout.kind, "none");
    assert.equal(indexLinkLayout.reason, "v2-index-missing");

    const legacyLinkLayout = resolveKnowledgeLayout(legacyLink);
    assert.equal(legacyLinkLayout.kind, "none");
    assert.equal(legacyLinkLayout.reason, "missing");
  });

  it("returns none when no knowledge layout is present", () => {
    const workspace = createWorkspace();

    const layout = resolveKnowledgeLayout(workspace);

    assert.equal(layout.kind, "none");
    assert.equal(layout.reason, "missing");
  });

  it("accepts nested v2 project page directories", () => {
    const workspace = createWorkspace({
      "wiki/schema.md": generateKnowledgeV2Schema(),
      "wiki/index.md": "# Knowledge Index\n\n- [Strategy](pages/project/sample-topic/strategy.md)\n",
      "wiki/pages/project/sample-topic/strategy.md": [
        "---",
        "name: Strategy",
        "description: Topic strategy notes",
        "type: project",
        "---",
        "",
        "# Strategy",
        "",
      ].join("\n"),
    });

    const layout = resolveKnowledgeLayout(workspace);

    assert.equal(layout.kind, "v2");
    assert.equal(layout.paths.pageTypeDirs.project, join(workspace, "wiki", "pages", "project"));
  });

  it("does not treat Karpathy-style wiki schema and index files as v2", () => {
    const workspace = createWorkspace({
      "wiki/schema.md": [
        "---",
        "format: karpathy-llm-wiki",
        "version: 1",
        "---",
        "",
        "# Wiki Schema",
        "",
      ].join("\n"),
      "wiki/index.md": "# Wiki Index\n",
    });

    const layout = resolveKnowledgeLayout(workspace);

    assert.equal(layout.kind, "none");
    assert.equal(layout.reason, "schema-marker-missing");
  });

  it("generates the canonical v2 schema contract", () => {
    const schema = generateKnowledgeV2Schema();
    const marker = parseKnowledgeV2SchemaMarker(schema);

    assert.deepEqual(marker, {
      format: KNOWLEDGE_V2_FORMAT,
      version: KNOWLEDGE_V2_VERSION,
    });
    for (const pageType of KNOWLEDGE_PAGE_TYPES) {
      assert.match(schema, new RegExp(`\\\`${pageType}\\\``));
    }
    for (const field of ["name", "description", "type", "confidence", "revisit_if", "originSessionId"]) {
      assert.match(schema, new RegExp(`\\\`${field}\\\``));
    }
    assert.match(schema, /raw\/\*\*/);
    assert.match(schema, /artifacts\/\*\*/);
    assert.match(schema, /wiki\/pages\/reference\/\*\*/);
    assert.match(schema, /wiki\/pages\/project\/\*\*/);
    assert.match(schema, /Strict citation from raw\/source material/);
    assert.match(schema, /CLAUDE\.md/);
    assert.match(schema, /USER\.md/);
    assert.match(schema, /IDENTITY\.md/);
    assert.match(schema, /\.claude\/\*\*/);
    assert.match(schema, /config and crons files/);
    assert.match(schema, /Active runbooks and configuration documents stay/);
    assert.match(schema, /Archived runbooks move to `artifacts\/runbooks\/\*\*`/);
    assert.match(schema, /Unknown active status defaults to keep-in-place/);
    assert.match(schema, /Legacy `MEMORY\.md` is split by role/);
    assert.match(schema, /archive the exact legacy file as `artifacts\/legacy\/MEMORY\.md`/);
    assert.match(schema, /Decision logs, ADRs, plans, task documents/);
    assert.match(schema, /Generated process evidence goes to `artifacts\/tasks\/\*\*`/);
    assert.match(schema, /Unknown provenance blocks automatic migration pending operator review/);
    assert.match(schema, /Secrets, credentials, tokens, PINs, payment secrets/);
    assert.match(schema, /reference\/drafts\/\*\*/);
    assert.match(schema, /Stable pet profiles route to user pet pages/);
    assert.match(schema, /active treatment or health plans route to project health\/status pages/);
    assert.match(schema, /Ongoing personal curricula or learning plans route to project status/);
    assert.match(schema, /One-off execution plans route to `artifacts\/plans\/\*\*`/);
    assert.match(schema, /Wiki pages are Markdown only/);
    assert.doesNotMatch(schema, /write-guard|root write|root schema\.md/i);
  });
});
