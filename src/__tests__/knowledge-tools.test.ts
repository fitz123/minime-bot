import { after, describe, it } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateKnowledgeV2Schema } from "../knowledge/layout.js";
import {
  executeKnowledgeGet,
  executeKnowledgeSearch,
  formatKnowledgeToolResponse,
  type KnowledgeGetResponse,
  type KnowledgeSearchResponse,
} from "../knowledge/tools.js";
import { MINIME_AGENT_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

const RETIRED_AGENT_WORKSPACE_ENV = ["MINIME", "AGENT", "WORKSPACE", "CWD"].join("_");

const fixtures: string[] = [];

after(() => {
  for (const fixture of fixtures) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relpath, content] of Object.entries(files)) {
    const path = join(root, ...relpath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
}

function createWorkspace(files: Record<string, string> = {}): string {
  const workspace = mkdtempSync(join(tmpdir(), "minime-knowledge-tools-"));
  fixtures.push(workspace);
  writeFiles(workspace, files);
  return workspace;
}

function createV2Workspace(files: Record<string, string> = {}): string {
  return createWorkspace({
    "wiki/schema.md": generateKnowledgeV2Schema(),
    "wiki/index.md": [
      "# Knowledge Index",
      "",
      "- [Runtime Notes](pages/project/runtime/runtime-notes.md) - C++/Node.js adapter work.",
      "- [User Preferences](pages/user/preferences.md)",
      "",
    ].join("\n"),
    ...files,
  });
}

function assertSearchOk(response: KnowledgeSearchResponse): asserts response is Extract<KnowledgeSearchResponse, { ok: true }> {
  assert.equal(response.ok, true, JSON.stringify(response));
}

function assertGetOk(response: KnowledgeGetResponse): asserts response is Extract<KnowledgeGetResponse, { ok: true }> {
  assert.equal(response.ok, true, JSON.stringify(response));
}

describe("knowledge tools", () => {
  it("recalls partial queries and same-call cross-language variants", () => {
    const workspace = createV2Workspace({
      "wiki/pages/project/cooling.md": "# Cooling system\n\nThermal control uses a radiator.\n",
    });
    for (const args of [
      { query: "radiator maintenance details" },
      { query: "охлаждение", variants: ["thermal control"] },
    ]) {
      const result = executeKnowledgeSearch(args, { agentWorkspaceRoot: workspace });
      assertSearchOk(result);
      assert.equal(result.results[0]?.path, "wiki/pages/project/cooling.md");
    }
  });

  it("keeps translated meaningful matches ahead of bilingual function-word distractors", () => {
    const files: Record<string, string> = {
      "wiki/index.md": "# Catalog\n",
      "wiki/pages/relevant.md": "# Maintenance\nRadiator coolant replacement procedure.\n",
    };
    for (let i = 0; i < 12; i++) {
      files[`wiki/pages/noise-${i}.md`] = "# Notes\nкак и где это мы для the and where is it for\n";
    }
    const deps = { agentWorkspaceRoot: createV2Workspace(files) };
    const translated = "where is the radiator coolant replacement procedure";
    for (const args of [
      { query: "как и где замена охлаждающей жидкости", variants: [translated] },
      { query: translated },
    ]) {
      const response = executeKnowledgeSearch(args, deps);
      assertSearchOk(response);
      assert.equal(response.results[0]?.path, "wiki/pages/relevant.md");
      assert.equal(response.results.some((hit) => hit.path.includes("noise-")), false);
    }
  });

  it("uses uniform votes for original and reformulated candidate lists", () => {
    const deps = { agentWorkspaceRoot: createV2Workspace({
      "wiki/index.md": "# Catalog\n",
      "wiki/pages/a.md": "# Record A\nRadiator coolant replacement.\n",
      "wiki/pages/z.md": "# Record Z\nАрхив.\n",
    }) };
    const forward = executeKnowledgeSearch({ query: "архив", variants: ["radiator coolant replacement"] }, deps);
    const reverse = executeKnowledgeSearch({ query: "radiator coolant replacement", variants: ["архив"] }, deps);
    assertSearchOk(forward);
    assertSearchOk(reverse);
    assert.deepEqual(forward.results, reverse.results);
    assert.equal(forward.results[0].score, forward.results[1].score);
  });

  it("preserves the original ranked list and scores with zero-hit variants", () => {
    const deps = { agentWorkspaceRoot: createV2Workspace({
      "wiki/index.md": "# Catalog\n",
      "wiki/pages/r.md": "# Radiator coolant guide\nRadiator coolant radiator coolant.\n",
      "wiki/pages/n.md": `# Garage log\nRadiator notes coolant records replacement ${"garage ".repeat(200)}\n`,
    }) };
    const query = "radiator coolant replacement";
    const original = executeKnowledgeSearch({ query }, deps);
    assertSearchOk(original);
    assert.deepEqual(original.results.map((hit) => hit.path), ["wiki/pages/r.md", "wiki/pages/n.md"]);
    for (const variants of [["замена охлаждающей жидкости"], ["!!!"], ["!!!", "замена охлаждающей жидкости"]]) {
      const response = executeKnowledgeSearch({ query, variants }, deps);
      assertSearchOk(response);
      assert.deepEqual(response.results, original.results);
    }
  });

  it("preserves the sole variant ranked list and scores when the original has zero hits", () => {
    const deps = { agentWorkspaceRoot: createV2Workspace({
      "wiki/index.md": "# Catalog\n",
      "wiki/pages/r.md": "# Radiator coolant guide\nRadiator coolant radiator coolant.\n",
      "wiki/pages/n.md": `# Garage log\nRadiator notes coolant records replacement ${"garage ".repeat(200)}\n`,
    }) };
    const variant = "radiator coolant replacement";
    const expected = executeKnowledgeSearch({ query: variant }, deps);
    assertSearchOk(expected);
    const response = executeKnowledgeSearch({ query: "несуществующий", variants: [variant, "!!!"] }, deps);
    assertSearchOk(response);
    assert.deepEqual(response.results, expected.results);
  });

  it("bounds each fused list so repeated tail matches cannot vote", () => {
    const files: Record<string, string> = { "wiki/index.md": "# Catalog\n" };
    for (const term of ["radiator", "coolant"]) {
      for (let i = 0; i < 50; i++) {
        files[`wiki/pages/${term}-${i}.md`] = `# ${term}\n${term} maintenance procedure\n`;
      }
    }
    files["wiki/pages/tail.md"] = `# Notes\nRadiator coolant ${"unrelated ".repeat(300)}\n`;
    const deps = { agentWorkspaceRoot: createV2Workspace(files) };
    const response = executeKnowledgeSearch({ query: "radiator instructions", variants: ["coolant instructions"], maxResults: 50 }, deps);
    assertSearchOk(response);
    assert.equal(response.results.some((hit) => hit.path.endsWith("/tail.md")), false);
  });

  it("weights each uniform fusion vote by matched-token coverage", () => {
    const deps = { agentWorkspaceRoot: createV2Workspace({
      "wiki/index.md": "# Catalog\n",
      "wiki/pages/a.md": "# Loop tuning\nThermal control parameters.\n",
      "wiki/pages/b.md": "# Access\nAccess control and heat map.\n",
    }) };
    for (const args of [
      { query: "thermal control", variants: ["heat management"] },
      { query: "heat management", variants: ["thermal control"] },
    ]) {
      const response = executeKnowledgeSearch(args, deps);
      assertSearchOk(response);
      assert.deepEqual(response.results.map((hit) => hit.path), ["wiki/pages/a.md", "wiki/pages/b.md"]);
      assert.equal(response.results[0].score, 1 / 61);
      assert.equal(response.results[1].score, 0.5 / 62 + 0.5 / 61);
      assert.deepEqual(Object.keys(response.results[0]).sort(),
        ["path", "title", "heading", "startLine", "endLine", "snippet", "sourceKind", "authority", "score", "rank"].sort());
    }
  });

  it("keeps exact-ID priority attached to its actual catalog representative", () => {
    const deps = { agentWorkspaceRoot: createV2Workspace({
      "wiki/index.md": "- [Thermal](pages/project/thermal.md) - Record ZX-4317\n- [Cooling](pages/project/cooling.md) - Coolant pump notes\n",
      "wiki/pages/project/thermal.md": "# Thermal\nRecord ZX-4317.\n",
    }) };
    const response = executeKnowledgeSearch({ query: "ZX-4317", variants: ["coolant pump"] }, deps);
    assertSearchOk(response);
    const catalog = response.results.find((hit) => hit.sourceKind === "index")!;
    assert.equal(catalog.startLine, 2);
    assert.match(catalog.snippet, /Coolant pump/);
    assert.equal(catalog.score, 1 / 61);
    assert.equal(response.results[0].path, "wiki/pages/project/thermal.md");
    const limited = executeKnowledgeSearch({ query: "ZX-4317", variants: ["coolant pump"], maxResults: 1 }, deps);
    assertSearchOk(limited);
    assert.equal(limited.results[0].path, "wiki/pages/project/thermal.md");
  });

  for (const identity of ["title", "name", "path", "ID"] as const) {
    it(`prioritizes exact ${identity} before the bounded candidate cutoff and for a single query`, () => {
      const query = identity === "path" ? "wiki/pages/record.md" : identity === "ID" ? "ZX-4317" : "Thermal Control";
      const files: Record<string, string> = {
        "wiki/index.md": "# Catalog\n",
        "wiki/pages/record.md": identity === "name" ? "---\nname: Thermal Control\n---\n# Record\n" :
          identity === "title" ? "# Thermal Control\n" : identity === "ID" ? "# Record\nRecord ZX-4317.\n" : "# Record\n",
      };
      for (let i = 0; i < 50; i++) {
        const stem = identity === "path" ? "wiki-pages-record-md" : identity === "ID" ? "ZX-4317" : "thermal-control";
        const mention = identity === "ID" ? "ZX note 4317" : query;
        files[`wiki/pages/${stem}-note-${i}.md`] = `# ${mention} Note ${i}\n${mention} note details.\n`;
      }
      const deps = { agentWorkspaceRoot: createV2Workspace(files) };
      for (const variants of [[], ["cooling"]]) {
        const response = executeKnowledgeSearch({ query, variants, maxResults: 50 }, deps);
        assertSearchOk(response);
        assert.equal(response.results[0].path, "wiki/pages/record.md");
        assert.equal(response.results.length, 50);
      }
    });
  }

  it("keeps source preference proportional to relevance for scope all", () => {
    const files: Record<string, string> = {
      "wiki/index.md": "# Catalog\n",
      "diary/day.md": "# Travel\nTbilisi.\n",
    };
    for (let i = 0; i < 10; i++) files[`wiki/pages/noise-${i}.md`] = "# Notes\nTravel plans.\n";
    const deps = { agentWorkspaceRoot: createV2Workspace(files) };
    for (const variants of [[], ["tbilisi journey"]]) {
      const response = executeKnowledgeSearch({ query: "travel tbilisi journey details", variants, scope: "all" }, deps);
      assertSearchOk(response);
      assert.equal(response.results[0]?.path, "diary/day.md");
    }
  });

  it("preserves complete phrases, names containing function words, and function-word-only queries", () => {
    const deps = { agentWorkspaceRoot: createV2Workspace({
      "wiki/index.md": "# Catalog\n",
      "wiki/pages/named.md": "# The Who\nTo be or not to be.\n",
      "wiki/pages/other.md": "# Other\nWho knows. Broad synonyms.\n",
      "wiki/pages/ru.md": "# Words\nи в на\n",
      "wiki/pages/mixed-name.md": "# The Radiator\nDesign notes.\n",
      "wiki/pages/phrase.md": "# Example\nState of the art.\n",
      "wiki/pages/words.md": "# Example\nArt of the state.\n",
    }) };
    for (const query of ["The Who", "The Radiator", "to be or not to be", "the"]) {
      const response = executeKnowledgeSearch({ query, variants: ["broad synonyms"] }, deps);
      assertSearchOk(response);
      const expected = query === "The Radiator" ? "wiki/pages/mixed-name.md" : "wiki/pages/named.md";
      assert.ok(response.results.some((hit) => hit.path === expected));
      if (query.startsWith("The ")) assert.equal(response.results[0].path, expected);
    }
    const phrase = executeKnowledgeSearch({ query: "state of the art" }, deps);
    assertSearchOk(phrase);
    assert.equal(phrase.results[0]?.path, "wiki/pages/phrase.md");
    const russian = executeKnowledgeSearch({ query: "и в на" }, deps);
    assertSearchOk(russian);
    assert.equal(russian.results[0]?.path, "wiki/pages/ru.md");
  });

  it("bounds variants, deduplicates normalized queries, and requires the original", () => {
    const workspace = createV2Workspace({ "wiki/pages/topic.md": "# Café\nRadiator details.\n" });
    const deps = { agentWorkspaceRoot: workspace };
    const original = executeKnowledgeSearch({ query: "café" }, deps);
    assert.deepEqual(executeKnowledgeSearch({ query: "café", variants: [" CAFÉ ", "cafe"] }, deps), original);
    for (const variants of [null, "cafe", [1], [" "], ["x".repeat(501)], Array(6).fill("cafe")]) {
      const response = executeKnowledgeSearch({ query: "cafe", variants }, deps);
      assert.equal(response.ok, false);
      if (!response.ok) assert.equal(response.reason, "invalid-variants");
    }
    assert.equal(executeKnowledgeSearch({ variants: ["cafe"] }, deps).ok, false);
    assert.equal(executeKnowledgeSearch({ query: "cafe", variants: ["x".repeat(500)] }, deps).ok, true);
  });

  it("ranks exact names, paths and identifiers with whole-token boundaries", () => {
    const workspace = createV2Workspace({
      "wiki/pages/thermal.md": "---\nname: Thermal Control\ndescription: Radiator design\n---\n# Design\nRecord ZX-4317.\n",
      "wiki/pages/other.md": "# Other\nThermal control is mentioned. Broad synonyms here. Record ZX-94317.\n",
    });
    const deps = { agentWorkspaceRoot: workspace };
    for (const query of ["Thermal Control", "wiki/pages/thermal.md", "ZX-4317"]) {
      const response = executeKnowledgeSearch({ query, variants: ["broad", "synonyms", "here"] }, deps);
      assertSearchOk(response);
      assert.equal(response.results[0].path, "wiki/pages/thermal.md");
      assert.equal(new Set(response.results.map((hit) => hit.path)).size, response.results.length);
    }
    for (const query of ["431", "9431", "radi", "不存在"]) {
      const response = executeKnowledgeSearch({ query }, deps);
      assertSearchOk(response);
      assert.deepEqual(response.results, []);
    }
    const description = executeKnowledgeSearch({ query: "radiator" }, deps);
    assertSearchOk(description);
    assert.equal(description.results[0].startLine, 3);
  });

  it("keeps catalog support line-local and returns faithful bounded source lines", () => {
    const workspace = createV2Workspace({
      "wiki/index.md": "# Catalog\n- Amber turbines\n- Violet reservoirs\n",
      "wiki/pages/combined.md": "# Combined\nAmber reservoirs\n",
    });
    const deps = { agentWorkspaceRoot: workspace };
    const response = executeKnowledgeSearch({ query: "amber reservoirs" }, deps);
    assertSearchOk(response);
    assert.equal(response.results[0].path, "wiki/pages/combined.md");
    const withVariants = executeKnowledgeSearch({ query: "amber reservoirs", variants: ["violet", "turbines"] }, deps);
    assertSearchOk(withVariants);
    // Each one-word variant ranks its matching catalog entry first with full coverage.
    // Catalog fusion keeps the strongest vote instead of summing across entries.
    assert.equal(withVariants.results.find((hit) => hit.sourceKind === "index")?.score,
      1 / 61);
    const catalog = response.results.find((hit) => hit.sourceKind === "index")!;
    assert.equal(catalog.authority, "catalog/discovery");
    assert.equal(catalog.startLine, catalog.endLine);
    assert.ok(["- Amber turbines", "- Violet reservoirs"].includes(catalog.snippet));
    const source = executeKnowledgeGet({ path: catalog.path, startLine: catalog.startLine, endLine: catalog.endLine }, deps);
    assertGetOk(source);
    assert.equal(source.content, catalog.snippet);
    writeFiles(workspace, { "wiki/index.md": "# Catalog\n- Amber turbines\n- Unrelated text\n" });
    const isolated = executeKnowledgeSearch({ query: "amber reservoirs" }, deps);
    assertSearchOk(isolated);
    // Removing the other entry's matching term cannot remove support from this entry.
    const isolatedCatalog = isolated.results.find((hit) => hit.path === "wiki/index.md")!;
    assert.equal(isolatedCatalog.snippet, "- Amber turbines");
    assert.equal(isolatedCatalog.score, catalog.score);
  });

  it("reads each corpus file once across variants and sees edits on the next call", (t) => {
    const workspace = createV2Workspace({
      "wiki/pages/cooling.md": "# Cooling\nRadiator thermal control.\n",
      "diary/day.md": "# History\nThermal recollection.\n",
    });
    const reads: string[] = [];
    const realRead = fs.readFileSync;
    t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      reads.push(String(args[0]));
      return realRead(...args);
    });
    syncBuiltinESMExports();
    try {
      const deps = { agentWorkspaceRoot: workspace };
      const args = { query: "radiator", variants: ["thermal", "cooling"], scope: "all" };
      const response = executeKnowledgeSearch(args, deps);
      assertSearchOk(response);
      for (const path of ["wiki/index.md", "wiki/pages/cooling.md", "diary/day.md"]) {
        assert.equal(reads.filter((read) => read === join(workspace, path)).length, 1, path);
      }
      writeFiles(workspace, { "wiki/pages/cooling.md": "# Replacement\nNew content.\n" });
      const updated = executeKnowledgeSearch({ query: "radiator", variants: ["thermal"] }, deps);
      assertSearchOk(updated);
      assert.equal(updated.results.some((hit) => hit.path === "wiki/pages/cooling.md"), false);
      assert.equal(response.results.find((hit) => hit.sourceKind === "diary")?.authority, "narrative/history; stale-prone");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  it("searches v2 index and pages with punctuation-heavy queries", () => {
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime/runtime-notes.md": [
        "---",
        "name: Runtime Notes",
        "description: Notes about the C++ and Node.js bridge",
        "type: project",
        "---",
        "",
        "# Runtime Notes",
        "",
        "The C++/Node.js adapter should keep ABI details explicit.",
        "",
      ].join("\n"),
      "diary/2026-06-07.md": "# Diary\n\nC++/Node.js appeared in a debugging narrative.\n",
    });

    const response = executeKnowledgeSearch(
      { query: "C++/Node.js adapter", maxResults: 5 },
      { agentWorkspaceRoot: workspace },
    );

    assertSearchOk(response);
    assert.equal(response.layoutKind, "v2");
    assert.equal(response.scope, "auto");
    assert.equal(response.results.length, 2);
    assert.equal(response.results[0].path, "wiki/pages/project/runtime/runtime-notes.md");
    assert.equal(response.results[0].title, "Runtime Notes");
    assert.equal(response.results[0].heading, "Runtime Notes");
    assert.equal(response.results[0].sourceKind, "wiki");
    assert.equal(response.results[0].authority, "durable synthesized knowledge; verify freshness for time-sensitive facts");
    assert.equal(response.results[0].rank, 1);
    assert.match(response.results[0].snippet, /C\+\+\/Node\.js adapter/);
    assert.equal(response.results[1].path, "wiki/index.md");
    assert.equal(response.results[1].sourceKind, "index");
  });

  it("matches mixed Cyrillic and Latin query tokens regardless of case, punctuation, or order", () => {
    const workspace = createV2Workspace({
      "wiki/pages/project/mixed-search.md": "# Mixed Search\n\nРусский search material.\n",
      "wiki/pages/project/cyrillic-only.md": "# Cyrillic Only\n\nРусский material.\n",
      "wiki/pages/project/latin-only.md": "# Latin Only\n\nSearch material.\n",
    });

    for (const query of ["русский search", "РУССКИЙ, SEARCH!!!", "search русский"]) {
      const response = executeKnowledgeSearch(
        { query },
        { agentWorkspaceRoot: workspace },
      );

      assertSearchOk(response);
      assert.deepEqual(
        response.results.slice(0, 1).map((result) => result.path),
        ["wiki/pages/project/mixed-search.md"],
        query,
      );
    }
  });

  it("searches legacy default and diary scopes", () => {
    const workspace = createWorkspace({
      "MEMORY.md": "# Memory\n\n- [Shipping](memory/auto/shipping.md)\n",
      "memory/auto/shipping.md": "# Shipping\n\nRelease notes mention ferrite planning.\n",
      "memory/diary/2026-06-07.md": "# Diary\n\nFerrite was discussed informally.\n",
    });

    const defaultResponse = executeKnowledgeSearch(
      { query: "ferrite", scope: "default" },
      { agentWorkspaceRoot: workspace },
    );
    assertSearchOk(defaultResponse);
    assert.equal(defaultResponse.layoutKind, "legacy");
    assert.deepEqual(
      defaultResponse.results.map((result) => result.path),
      ["memory/auto/shipping.md"],
    );
    assert.equal(defaultResponse.results[0].sourceKind, "auto");

    const diaryResponse = executeKnowledgeSearch(
      { query: "ferrite", scope: "diary" },
      { agentWorkspaceRoot: workspace },
    );
    assertSearchOk(diaryResponse);
    assert.deepEqual(
      diaryResponse.results.map((result) => result.path),
      ["memory/diary/2026-06-07.md"],
    );
    assert.equal(diaryResponse.results[0].authority, "narrative/history; stale-prone");
  });

  it("returns unavailable JSON for no-layout workspaces", () => {
    const workspace = createWorkspace({
      "notes.md": "# Notes\n",
    });

    const search = executeKnowledgeSearch({ query: "notes" }, { agentWorkspaceRoot: workspace });
    assert.equal(search.ok, false);
    assert.equal(search.status, "unavailable");
    assert.equal(search.reason, "knowledge-layout-unavailable");
    assert.equal(search.results.length, 0);
    assert.match(formatKnowledgeToolResponse(search), /"ok": false/);

    const get = executeKnowledgeGet({ path: "notes.md" }, { agentWorkspaceRoot: workspace });
    assert.equal(get.ok, false);
    assert.equal(get.status, "unavailable");
    assert.equal(get.reason, "knowledge-layout-unavailable");
  });

  it("returns unavailable JSON when the agent workspace is unset", () => {
    const search = executeKnowledgeSearch({ query: "notes" }, { env: {} });
    assert.equal(search.ok, false);
    assert.equal(search.status, "unavailable");
    assert.equal(search.reason, "agent-workspace-unset");
    assert.equal(search.results.length, 0);
    assert.match(formatKnowledgeToolResponse(search), /"agent-workspace-unset"/);

    const get = executeKnowledgeGet({ path: "wiki/index.md" }, { env: {} });
    assert.equal(get.ok, false);
    assert.equal(get.status, "unavailable");
    assert.equal(get.reason, "agent-workspace-unset");
  });

  it("uses MINIME_AGENT_WORKSPACE_ROOT and ignores the retired agent workspace env", () => {
    const retiredWorkspace = createV2Workspace({
      "wiki/pages/project/retired.md": "# Retired\n\nRetired-only token.\n",
      "wiki/index.md": "# Knowledge Index\n\n- [Retired](pages/project/retired.md)\n",
    });
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime.md": "# Runtime\n\nCanonical-only token.\n",
      "wiki/index.md": "# Knowledge Index\n\n- [Runtime](pages/project/runtime.md)\n",
    });

    const search = executeKnowledgeSearch(
      { query: "canonical-only" },
      {
        env: {
          [MINIME_AGENT_WORKSPACE_ROOT_ENV]: workspace,
          [RETIRED_AGENT_WORKSPACE_ENV]: retiredWorkspace,
        },
      },
    );
    assert.equal(search.ok, true, JSON.stringify(search));
    assert.equal(search.results[0]?.path, "wiki/pages/project/runtime.md");

    const retiredOnly = executeKnowledgeSearch(
      { query: "retired-only" },
      { env: { [RETIRED_AGENT_WORKSPACE_ENV]: retiredWorkspace } },
    );
    assert.equal(retiredOnly.ok, false);
    assert.equal(retiredOnly.reason, "agent-workspace-unset");
  });

  it("treats an explicit empty env as authoritative over the process env", () => {
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime.md": "# Runtime\n\nAmbient-only token.\n",
      "wiki/index.md": "# Knowledge Index\n\n- [Runtime](pages/project/runtime.md)\n",
    });
    const previous = process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
    process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV] = workspace;
    try {
      const search = executeKnowledgeSearch({ query: "ambient-only" }, { env: {} });
      assert.equal(search.ok, false);
      assert.equal(search.reason, "agent-workspace-unset");
    } finally {
      if (previous === undefined) {
        delete process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV];
      } else {
        process.env[MINIME_AGENT_WORKSPACE_ROOT_ENV] = previous;
      }
    }
  });

  it("rejects traversal, absolute, non-corpus, non-markdown, and symlink escape reads", () => {
    const outside = createWorkspace({
      "secret.md": "# Secret\n",
    });
    const workspace = createV2Workspace({
      "wiki/pages/project/runtime/runtime-notes.md": "# Runtime Notes\n\nVisible knowledge.\n",
      "wiki/pages/project/runtime/not-markdown.txt": "Nope\n",
      "raw/source.md": "# Raw\n",
    });
    symlinkSync(join(outside, "secret.md"), join(workspace, "wiki", "pages", "project", "runtime", "escaped.md"));

    for (const path of [
      "../secret.md",
      "/tmp/secret.md",
      "wiki/pages/project/runtime/not-markdown.txt",
      "raw/source.md",
      "wiki/pages/project/runtime/escaped.md",
    ]) {
      const response = executeKnowledgeGet({ path }, { agentWorkspaceRoot: workspace });
      assert.equal(response.ok, false, path);
      assert.equal(response.status, "rejected", path);
    }
  });

  it("does not index exact corpus files or corpus roots that are symlinked", () => {
    const outsideExact = createWorkspace({
      "index.md": "# Secret Index\n\noutside-exact-token\n",
      "MEMORY.md": "# Secret Memory\n\noutside-legacy-token\n",
    });
    const v2Workspace = createWorkspace({
      "wiki/schema.md": generateKnowledgeV2Schema(),
    });
    symlinkSync(join(outsideExact, "index.md"), join(v2Workspace, "wiki", "index.md"));

    const v2Search = executeKnowledgeSearch(
      { query: "outside-exact-token" },
      { agentWorkspaceRoot: v2Workspace },
    );
    assert.equal(v2Search.ok, false);
    assert.equal(v2Search.reason, "knowledge-layout-unavailable");

    const v2Get = executeKnowledgeGet(
      { path: "wiki/index.md" },
      { agentWorkspaceRoot: v2Workspace },
    );
    assert.equal(v2Get.ok, false);
    assert.equal(v2Get.reason, "knowledge-layout-unavailable");

    const legacyWorkspace = createWorkspace();
    symlinkSync(join(outsideExact, "MEMORY.md"), join(legacyWorkspace, "MEMORY.md"));
    const legacySearch = executeKnowledgeSearch(
      { query: "outside-legacy-token" },
      { agentWorkspaceRoot: legacyWorkspace },
    );
    assert.equal(legacySearch.ok, false);
    assert.equal(legacySearch.reason, "knowledge-layout-unavailable");

    const outsidePages = createWorkspace({
      "runtime.md": "# Runtime\n\nzzoutsidezz\n",
    });
    const rootSymlinkWorkspace = createV2Workspace();
    symlinkSync(outsidePages, join(rootSymlinkWorkspace, "wiki", "pages"), "dir");
    const rootSymlinkSearch = executeKnowledgeSearch(
      { query: "zzoutsidezz" },
      { agentWorkspaceRoot: rootSymlinkWorkspace },
    );
    assertSearchOk(rootSymlinkSearch);
    assert.deepEqual(rootSymlinkSearch.results, []);

    const rawRootSymlinkWorkspace = createV2Workspace({
      "raw/private.md": "# Raw\n\nraw-root-token\n",
    });
    symlinkSync(join(rawRootSymlinkWorkspace, "raw"), join(rawRootSymlinkWorkspace, "wiki", "pages"), "dir");
    const rawRootSymlinkSearch = executeKnowledgeSearch(
      { query: "raw-root-token" },
      { agentWorkspaceRoot: rawRootSymlinkWorkspace },
    );
    assertSearchOk(rawRootSymlinkSearch);
    assert.deepEqual(rawRootSymlinkSearch.results, []);

    const rawRootSymlinkGet = executeKnowledgeGet(
      { path: "wiki/pages/private.md" },
      { agentWorkspaceRoot: rawRootSymlinkWorkspace },
    );
    assert.equal(rawRootSymlinkGet.ok, false);
    assert.equal(rawRootSymlinkGet.reason, "non-corpus-path");

    const rawSymlinkWorkspace = createV2Workspace({
      "raw/private.md": "# Raw\n\nraw-private-token\n",
    });
    mkdirSync(join(rawSymlinkWorkspace, "wiki", "pages", "project"), { recursive: true });
    symlinkSync(
      join(rawSymlinkWorkspace, "raw", "private.md"),
      join(rawSymlinkWorkspace, "wiki", "pages", "project", "private.md"),
    );
    const rawSymlinkSearch = executeKnowledgeSearch(
      { query: "raw-private-token" },
      { agentWorkspaceRoot: rawSymlinkWorkspace },
    );
    assertSearchOk(rawSymlinkSearch);
    assert.deepEqual(rawSymlinkSearch.results, []);

    const rawSymlinkGet = executeKnowledgeGet(
      { path: "wiki/pages/project/private.md" },
      { agentWorkspaceRoot: rawSymlinkWorkspace },
    );
    assert.equal(rawSymlinkGet.ok, false);
    assert.equal(rawSymlinkGet.reason, "non-corpus-path");
  });

  it("reads exact clamped line ranges from corpus markdown", () => {
    const workspace = createV2Workspace({
      "wiki/pages/user/preferences.md": [
        "---",
        "name: Preferences",
        "description: User preferences",
        "type: user",
        "---",
        "",
        "# Preferences",
        "",
        "Line nine",
        "Line ten",
        "Line eleven",
      ].join("\n"),
    });

    const exact = executeKnowledgeGet(
      { path: "wiki/pages/user/preferences.md", startLine: 9, endLine: 10 },
      { agentWorkspaceRoot: workspace },
    );
    assertGetOk(exact);
    assert.equal(exact.title, "Preferences");
    assert.equal(exact.startLine, 9);
    assert.equal(exact.endLine, 10);
    assert.equal(exact.content, "Line nine\nLine ten");
    assert.equal(exact.sourceKind, "wiki");

    const clamped = executeKnowledgeGet(
      { path: "wiki/pages/user/preferences.md", startLine: -20, endLine: 999 },
      { agentWorkspaceRoot: workspace },
    );
    assertGetOk(clamped);
    assert.equal(clamped.startLine, 1);
    assert.equal(clamped.endLine, 11);
    assert.match(clamped.content, /^---\nname: Preferences/);
    assert.match(clamped.content, /Line eleven$/);
  });
});
