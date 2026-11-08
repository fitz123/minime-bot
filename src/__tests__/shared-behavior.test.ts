import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadSkills, loadSkillsFromDir } from "../pi-native-skills.js";
import { log } from "../logger.js";
import { loadConfig, loadRawMergedConfig, validateAgent, validateBehavioralFoundation } from "../config.js";
import { assemblePiContext } from "../pi-context-assembler.js";
import { BehavioralFoundationError, resolveBehavioralFoundation } from "../behavioral-foundation.js";
import { publication, sharedBehaviorFixture } from "./shared-behavior-fixture.js";

test("required publications fail closed for missing/corrupt rules, skills and manifests", () => {
  for (const change of [
    (f: ReturnType<typeof sharedBehaviorFixture>) => renameSync(join(f.first.root, "manifest.json"), join(f.root, "unused.json")),
    (f: ReturnType<typeof sharedBehaviorFixture>) => writeFileSync(join(f.first.root, "manifest.json"), "{broken"),
    (f: ReturnType<typeof sharedBehaviorFixture>) => { delete f.first.manifest.files["rules/shared.md"]; f.first.save(); },
    (f: ReturnType<typeof sharedBehaviorFixture>) => writeFileSync(join(f.first.root, "rules/shared.md"), "CORRUPT_RULE"),
    (f: ReturnType<typeof sharedBehaviorFixture>) => writeFileSync(join(f.first.root, "skills/example-workflow/support.md"), "CORRUPT_SUPPORT"),
    (f: ReturnType<typeof sharedBehaviorFixture>) => renameSync(join(f.first.root, "skills/example-workflow/SKILL.md"), join(f.root, "unused.md")),
  ]) {
    const f = sharedBehaviorFixture();
    change(f);
    assert.throws(() => assemblePiContext(f.agent), BehavioralFoundationError);
  }
});

test("publication rejects escaped paths, escaped symlink assets and incomplete asset inventories", () => {
  const escaped = sharedBehaviorFixture();
  escaped.first.manifest.rules[0].path = "../outside.md";
  escaped.first.save();
  assert.throws(() => resolveBehavioralFoundation(escaped.current), /invalid.*rule/);
  for (const target of ["rules/shared.md", "skills/example-workflow/support.md"]) {
    const f = sharedBehaviorFixture();
    const path = join(f.first.root, target);
    renameSync(path, join(f.root, "outside.md"));
    symlinkSync(join(f.root, "outside.md"), path);
    assert.throws(() => resolveBehavioralFoundation(f.current), /escapes publication/);
  }
  const extra = sharedBehaviorFixture();
  writeFileSync(join(extra.first.root, "skills/example-workflow/unlisted.md"), "SYNTHETIC_UNLISTED");
  assert.throws(() => resolveBehavioralFoundation(extra.current), /required file missing.*unlisted/);
});

test("publication verifies rule source identities and native skill names", () => {
  const duplicate = sharedBehaviorFixture();
  duplicate.first.manifest.rules.push({ ...duplicate.first.manifest.rules[0] });
  duplicate.first.save();
  assert.throws(() => resolveBehavioralFoundation(duplicate.current), /duplicate rule/);
  const wrongSource = sharedBehaviorFixture();
  wrongSource.first.manifest.rules[0].source = "USER.md";
  wrongSource.first.save();
  assert.throws(() => resolveBehavioralFoundation(wrongSource.current), /rule.*identity/);
  const wrongName = sharedBehaviorFixture();
  wrongName.first.manifest.skills[0].name = "other-name";
  wrongName.first.save();
  assert.throws(() => resolveBehavioralFoundation(wrongName.current), /name differs/);
});

test("source owner excludes promoted rules by identity before reading unpublished WIP; nonowner shadow rejects", () => {
  const f = sharedBehaviorFixture();
  mkdirSync(join(f.workspace, ".claude/rules/platform"), { recursive: true });
  writeFileSync(join(f.workspace, "CLAUDE.md"), "@USER.md\n@.claude/rules/platform/shared.md\n");
  const local = join(f.workspace, ".claude/rules/platform/shared.md");
  writeFileSync(local, "SYNTHETIC_UNPUBLISHED_WIP");
  const owner = { ...f.agent, id: "source-owner" };
  const before = assemblePiContext(owner)!;
  assert.doesNotMatch(readFileSync(before.appendSystemPromptPath, "utf8"), /UNPUBLISHED/);
  renameSync(local, join(f.root, "unused-wip.md"));
  symlinkSync(join(f.root, "missing-wip.md"), local);
  const after = assemblePiContext(owner)!;
  assert.equal(after.manifest.digest, before.manifest.digest);
  assert.throws(() => assemblePiContext(f.agent), /local rule conflicts.*source identity/);
  renameSync(local, join(f.root, "unused-wip-link"));
  writeFileSync(local, f.first.content["rules/shared.md"]);
  assert.throws(() => assemblePiContext(f.agent), /local rule conflicts.*source identity/, "equal bytes do not authorize a same-identity nonowner shadow");
});

test("configured foundation ignores the legacy platform link without resolving it and keeps contained nonowner additions", () => {
  const f = sharedBehaviorFixture();
  mkdirSync(join(f.workspace, ".claude/rules/custom"), { recursive: true });
  // Deliberately nonexistent target: following it would fail this test.
  symlinkSync(join(f.root, "unavailable-source-home/platform"), join(f.workspace, ".claude/rules/platform"));
  writeFileSync(join(f.workspace, ".claude/rules/custom/local.md"), "SYNTHETIC_LOCAL_ADDITION");
  writeFileSync(join(f.workspace, ".claude/rules/custom/supplement.md"), f.first.content["rules/shared.md"]);
  const context = assemblePiContext(f.agent)!;
  const body = readFileSync(context.appendSystemPromptPath, "utf8");
  assert.match(body, /SYNTHETIC_SHARED_RULE/);
  assert.match(body, /SYNTHETIC_LOCAL_ADDITION/);
  assert.match(body, /SYNTHETIC_PRIVATE_LOCAL_MARKER/);
  assert.ok(context.manifest.sources.some(source => source.identity === "workspace:.claude/rules/custom/supplement.md"), "equal content under a different identity remains a local addition");
  assert.match(body, /when relevant/);
  assert.match(body, /cannot cancel or override/);
  assert.match(body, /does not grant permission/);
  assert.equal(JSON.stringify(context.manifest).includes(f.root), false);
  assert.equal(JSON.stringify(context.manifest).includes("SYNTHETIC_"), false);
  mkdirSync(join(f.workspace, ".claude/rules/other"));
  symlinkSync(join(f.root, "outside-rule.md"), join(f.workspace, ".claude/rules/other/escape.md"));
  writeFileSync(join(f.root, "outside-rule.md"), "SYNTHETIC_OUTSIDE");
  assert.throws(() => assemblePiContext(f.agent), /escapes workspace/);
});

test("native local skill additions stay contained and shared-first; same-name shadows reject visibly", () => {
  const f = sharedBehaviorFixture();
  mkdirSync(join(f.workspace, ".claude/skills/addition"), { recursive: true });
  const local = join(f.workspace, ".claude/skills/addition/SKILL.md");
  writeFileSync(local, "---\nname: addition\ndescription: Synthetic addition\n---\nLOCAL_SKILL\n");
  writeFileSync(join(f.workspace, ".claude/skills/flat.md"), "---\nname: flat\ndescription: Synthetic flat addition\n---\n");
  const context = assemblePiContext(f.agent)!;
  assert.deepEqual(context.behavioralFoundation!.skillPaths, [
    join(f.first.root, "skills/example-workflow/SKILL.md"), local, join(f.workspace, ".claude/skills/flat.md"),
  ]);
  writeFileSync(local, "---\nname: example-workflow\ndescription: Synthetic shadow\n---\n");
  assert.throws(() => assemblePiContext(f.agent), /local skill name conflicts.*example-workflow/);
  renameSync(local, join(f.root, "unused-local-skill.md"));
  symlinkSync(join(f.root, "unused-local-skill.md"), local);
  assert.throws(() => assemblePiContext(f.agent), /resource resolves outside/);
});

test("skill source identities are optional, constrained, unique and included in publication identity", () => {
  const f = sharedBehaviorFixture();
  const before = resolveBehavioralFoundation(f.current).digest;
  Object.assign(f.first.manifest.skills[0], { source: ".claude/skills/promoted" });
  f.first.save();
  assert.notEqual(resolveBehavioralFoundation(f.current).digest, before);
  for (const source of [null, "", "skills/promoted", ".claude/skills", ".claude/skills/../promoted", ".claude/skills//promoted", ".pi/other/promoted"]) {
    Object.assign(f.first.manifest.skills[0], { source });
    f.first.save();
    assert.throws(() => resolveBehavioralFoundation(f.current), /skill.*source/);
  }
  Object.assign(f.first.manifest.skills[0], { source: ".pi/skills/promoted" });
  f.first.manifest.skills.push({ ...f.first.manifest.skills[0], name: "another-name" });
  f.first.save();
  assert.throws(() => resolveBehavioralFoundation(f.current), /duplicate skill.*source/);
});

test("only source owners omit exact promoted skill directories before traversing WIP", () => {
  for (const tree of [".claude/skills", ".pi/skills", ".claude/skills/group"]) {
    const f = sharedBehaviorFixture();
    Object.assign(f.first.manifest.skills[0], { source: `${tree}/promoted` });
    f.first.save();
    const dir = join(f.workspace, tree);
    mkdirSync(join(dir, "promoted"), { recursive: true });
    writeFileSync(join(dir, "promoted/SKILL.md"), f.first.content["skills/example-workflow/SKILL.md"]);
    mkdirSync(join(dir, "addition"));
    const addition = join(dir, "addition/SKILL.md");
    writeFileSync(addition, "---\nname: addition\ndescription: Synthetic local addition\n---\n");
    const owner = { ...f.agent, id: "source-owner" };
    const before = assemblePiContext(owner)!;
    assert.deepEqual(before.behavioralFoundation!.skillPaths, [join(f.first.root, "skills/example-workflow/SKILL.md"), addition]);
    assert.throws(() => assemblePiContext(f.agent), /local skill name conflicts/);
    // Unpublished WIP cannot be traversed, including a broken support link.
    symlinkSync(join(f.root, "unavailable-support"), join(dir, "promoted/support"));
    writeFileSync(join(dir, "promoted/SKILL.md"), "---\ndescription: [invalid\n---\n");
    assert.equal(assemblePiContext(owner)!.manifest.digest, before.manifest.digest);
    renameSync(join(dir, "promoted"), join(f.root, "unused-source"));
    symlinkSync(join(f.root, "unavailable-source"), join(dir, "promoted"));
    assert.equal(assemblePiContext(owner)!.manifest.digest, before.manifest.digest);
    // Another directory with the published name remains a collision for the owner.
    writeFileSync(addition, f.first.content["skills/example-workflow/SKILL.md"]);
    assert.throws(() => assemblePiContext(owner), /local skill name conflicts/);
  }
});

test("legacy external or dangling skill-root symlinks visibly yield to required publication", t => {
  const warn = t.mock.method(log, "warn", () => {});
  for (const dangling of [false, true]) {
    const f = sharedBehaviorFixture();
    mkdirSync(join(f.workspace, ".claude"));
    const oldRoot = join(f.root, "legacy-shared-skills");
    if (!dangling) {
      mkdirSync(oldRoot);
      // A traversal into this tree would encounter a broken child link.
      symlinkSync(join(f.root, "unavailable-legacy-child"), join(oldRoot, "unavailable"));
    }
    symlinkSync(oldRoot, join(f.workspace, ".claude/skills"));
    mkdirSync(join(f.workspace, ".pi/skills/addition"), { recursive: true });
    const addition = join(f.workspace, ".pi/skills/addition/SKILL.md");
    writeFileSync(addition, "---\nname: addition\ndescription: Synthetic addition\n---\n");
    assert.deepEqual(assemblePiContext(f.agent)!.behavioralFoundation!.skillPaths, [join(f.first.root, "skills/example-workflow/SKILL.md"), addition]);
    assert.match(warn.mock.calls.at(-1)!.arguments.join(" "), /legacy shared skill-directory discovery.*\.claude\/skills.*replaced.*publication/i);
    renameSync(join(f.first.root, "manifest.json"), join(f.root, "unused-manifest.json"));
    assert.throws(() => assemblePiContext(f.agent), BehavioralFoundationError);
  }
});

test("owner filtering preserves native skill discovery, ignore rules and metadata warnings", t => {
  const warn = t.mock.method(log, "warn", () => {});
  const f = sharedBehaviorFixture();
  Object.assign(f.first.manifest.skills[0], { source: ".claude/skills/promoted" });
  f.first.save();
  const dir = join(f.workspace, ".claude/skills");
  for (const name of ["promoted", "addition", "ignored", "group/nested", "group/skipped"]) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name.replaceAll("/", "-")}\ndescription: Synthetic addition\n---\n`);
  }
  writeFileSync(join(dir, "addition/SKILL.md"), `---\nname: addition\ndescription: ${"x".repeat(1025)}\n---\n`);
  writeFileSync(join(dir, ".gitignore"), "/ignored/\n");
  writeFileSync(join(dir, "group/.ignore"), "/skipped/\n");
  writeFileSync(join(dir, "notes.md"), "Synthetic notes, no skill metadata\n");
  writeFileSync(join(dir, "flat.md"), "---\nname: flat\ndescription: Synthetic flat skill\n---\n");
  const native = loadSkillsFromDir({ dir, source: "path" });
  const expected = native.skills.filter(skill => !skill.filePath.includes("/promoted/"))
    .map(skill => skill.filePath).sort();
  const selected = assemblePiContext({ ...f.agent, id: "source-owner" })!.behavioralFoundation!.skillPaths;
  assert.deepEqual(selected, [join(f.first.root, "skills/example-workflow/SKILL.md"), ...expected]);
  assert.equal(expected.length, 3);
  assert.ok(warn.mock.calls.some(call => call.arguments.join(" ").includes(".claude/skills/addition/SKILL.md: native skill metadata portability warning")));
  // Ignored local trees follow native discovery, including their unused assets.
  symlinkSync(join(f.first.root, "skills/example-workflow/support.md"), join(dir, "ignored/support.md"));
  assert.deepEqual(assemblePiContext({ ...f.agent, id: "source-owner" })!.behavioralFoundation!.skillPaths, selected);
  // Unignored instruction assets remain contained.
  symlinkSync(join(f.first.root, "skills/example-workflow/support.md"), join(dir, "addition/support.md"));
  assert.throws(() => assemblePiContext({ ...f.agent, id: "source-owner" }), /resource resolves outside/);
});

test("local skill assets skip native hidden, dependency and ignored runtime trees", () => {
  for (const id of ["example-agent", "source-owner"]) {
    const f = sharedBehaviorFixture();
    const dir = join(f.workspace, ".claude/skills/addition");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "---\nname: addition\ndescription: Synthetic addition\n---\n");
    writeFileSync(join(dir, ".gitignore"), "/runtime/\n");
    writeFileSync(join(dir, ".ignore"), "/cache/\n");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets/.fdignore"), "/generated/\n");
    writeFileSync(join(f.root, "shared-python-runtime"), "SYNTHETIC_RUNTIME");
    for (const runtime of [".venv/bin", "node_modules/tool", "runtime/bin", "cache/bin", "assets/generated/bin"]) {
      mkdirSync(join(dir, runtime), { recursive: true });
      symlinkSync(join(f.root, "shared-python-runtime"), join(dir, runtime, "python"));
      // A dangling external runtime proves this subtree is never traversed.
      symlinkSync(join(f.root, "unavailable-python-runtime"), join(dir, runtime, "missing-python"));
    }
    const context = assemblePiContext({ ...f.agent, id })!;
    assert.deepEqual(context.behavioralFoundation!.skillPaths, [join(f.first.root, "skills/example-workflow/SKILL.md"), join(dir, "SKILL.md")]);
    assert.match(readFileSync(context.appendSystemPromptPath, "utf8"), /SYNTHETIC_SHARED_RULE/);
    symlinkSync(join(f.first.root, "skills/example-workflow/support.md"), join(dir, "assets/instructions.md"));
    assert.throws(() => assemblePiContext({ ...f.agent, id }), /resource resolves outside/);
  }
});

test("publication asset containment stays strict for hidden and ignored runtime trees", () => {
  for (const runtime of [".venv", "runtime", "node_modules"]) {
    const f = sharedBehaviorFixture();
    const dir = join(f.first.root, "skills/example-workflow");
    writeFileSync(join(dir, ".gitignore"), `/${runtime}/\n`);
    mkdirSync(join(dir, runtime));
    symlinkSync(join(f.root, "outside-python"), join(dir, runtime, "python"));
    writeFileSync(join(f.root, "outside-python"), "SYNTHETIC_RUNTIME");
    assert.throws(() => resolveBehavioralFoundation(f.current), /resource resolves outside/);
  }
});

test("native same-real-file aliases deduplicate across local skill roots before name conflicts", () => {
  for (const aliasRoot of [false, true]) {
    const f = sharedBehaviorFixture();
    const dir = join(f.workspace, ".claude/skills/addition");
    mkdirSync(dir, { recursive: true });
    const skill = join(dir, "SKILL.md");
    writeFileSync(skill, "---\nname: addition\ndescription: Synthetic addition\n---\n");
    mkdirSync(join(f.workspace, ".pi"));
    if (aliasRoot) symlinkSync(join(f.workspace, ".claude/skills"), join(f.workspace, ".pi/skills"));
    else {
      mkdirSync(join(f.workspace, ".pi/skills/alias"), { recursive: true });
      symlinkSync(skill, join(f.workspace, ".pi/skills/alias/SKILL.md"));
    }
    assert.deepEqual(assemblePiContext(f.agent)!.behavioralFoundation!.skillPaths, [join(f.first.root, "skills/example-workflow/SKILL.md"), skill]);
    // A different file with the same name remains a fatal local shadow.
    mkdirSync(join(f.workspace, ".pi/skills/duplicate"));
    writeFileSync(join(f.workspace, ".pi/skills/duplicate/SKILL.md"), readFileSync(skill));
    assert.throws(() => assemblePiContext(f.agent), /local skill name conflicts.*addition/);
  }
});

test("contained skill-root symlinks load additions while escaped child directories still reject", () => {
  const f = sharedBehaviorFixture();
  mkdirSync(join(f.workspace, ".claude"));
  mkdirSync(join(f.workspace, "local-skills/addition"), { recursive: true });
  symlinkSync(join(f.workspace, "local-skills"), join(f.workspace, ".claude/skills"));
  const addition = join(f.workspace, ".claude/skills/addition/SKILL.md");
  writeFileSync(addition, "---\nname: addition\ndescription: Synthetic addition\n---\n");
  assert.deepEqual(assemblePiContext(f.agent)!.behavioralFoundation!.skillPaths, [join(f.first.root, "skills/example-workflow/SKILL.md"), addition]);
  mkdirSync(join(f.root, "outside-directory"));
  symlinkSync(join(f.root, "outside-directory"), join(f.workspace, ".claude/skills/escaped-child"));
  assert.throws(() => assemblePiContext(f.agent), /resource resolves outside/);
});

test("native loaded skills retain portability warnings; malformed local skills visibly skip while foundation loads", t => {
  const warn = t.mock.method(log, "warn", () => {});
  for (const metadata of [
    "name: Synthetic_Workflow\ndescription: Synthetic description",
    `name: addition\ndescription: ${"x".repeat(1025)}`,
  ]) {
    const f = sharedBehaviorFixture();
    const dir = join(f.workspace, ".claude/skills/addition");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${metadata}\n---\n`);
    const native = loadSkillsFromDir({ dir, source: "path" });
    assert.equal(native.skills.length, 1);
    assert.ok(native.diagnostics.length);
    const context = assemblePiContext(f.agent)!;
    assert.equal(context.behavioralFoundation!.skillPaths[1], join(dir, "SKILL.md"));
    assert.ok(warn.mock.calls.some(call => call.arguments.join(" ").includes(".claude/skills/addition/SKILL.md: native skill metadata portability warning")));
    for (const content of ["---\nname: addition\n---\n", "---\ndescription: [SYNTHETIC_SENSITIVE_YAML_MARKER\n---\n"]) {
      writeFileSync(join(dir, "SKILL.md"), content);
      const skipped = loadSkillsFromDir({ dir, source: "path" });
      assert.equal(skipped.skills.length, 0);
      if (content.includes("SYNTHETIC_SENSITIVE_YAML_MARKER")) {
        assert.ok(skipped.diagnostics.some(d => d.message.includes("SYNTHETIC_SENSITIVE_YAML_MARKER")));
      }
      const before = warn.mock.calls.length;
      const context = assemblePiContext(f.agent)!;
      assert.deepEqual(context.behavioralFoundation!.skillPaths, [join(f.first.root, "skills/example-workflow/SKILL.md")]);
      assert.deepEqual(assemblePiContext(f.agent, { strict: true })!.behavioralFoundation!.skillPaths, context.behavioralFoundation!.skillPaths);
      assert.match(readFileSync(context.appendSystemPromptPath, "utf8"), /SYNTHETIC_SHARED_RULE/);
      assert.ok(skipped.diagnostics.length);
      assert.ok(warn.mock.calls.slice(before).some(call => call.arguments.join(" ").includes(".claude/skills/addition/SKILL.md (skipped): invalid/unloaded native skill metadata")));
      assert.ok(!warn.mock.calls.some(call => call.arguments.join(" ").includes("SYNTHETIC_SENSITIVE_YAML_MARKER")));
      // Skipping malformed local metadata cannot hide a broken required layer.
      writeFileSync(join(f.first.root, "rules/shared.md"), "SYNTHETIC_CORRUPTION");
      assert.throws(() => assemblePiContext(f.agent), /hash mismatch/);
      writeFileSync(join(f.first.root, "rules/shared.md"), f.first.content["rules/shared.md"]);
    }
    writeFileSync(join(dir, "SKILL.md"), `---\nname: example-workflow\ndescription: ${"x".repeat(1025)}\n---\n`);
    assert.throws(() => assemblePiContext(f.agent), /local skill name conflicts.*example-workflow/);
  }
});

test("required published malformed skill metadata remains fatal with valid hashes", () => {
  for (const content of ["---\nname: example-workflow\n---\n", "---\ndescription: [invalid\n---\n"]) {
    const f = sharedBehaviorFixture();
    const path = "skills/example-workflow/SKILL.md";
    writeFileSync(join(f.first.root, path), content);
    f.first.manifest.files[path] = createHash("sha256").update(content).digest("hex");
    f.first.save();
    assert.throws(() => assemblePiContext(f.agent), BehavioralFoundationError);
  }
});

test("missing optional output-style retains ordinary warning/default persona semantics with foundation present", t => {
  const warn = t.mock.method(log, "warn", () => {});
  const f = sharedBehaviorFixture();
  mkdirSync(join(f.workspace, ".claude"));
  writeFileSync(join(f.workspace, ".claude/settings.local.json"), JSON.stringify({ outputStyle: "optional-missing" }));
  const ordinary = assemblePiContext({ ...f.agent, behavioralFoundationRoot: undefined })!;
  assert.equal(ordinary.systemPromptPath, undefined);
  const before = warn.mock.calls.length;
  const context = assemblePiContext(f.agent, { strict: false })!;
  assert.equal(context.systemPromptPath, undefined);
  assert.deepEqual(context.behavioralFoundation!.skillPaths, [join(f.first.root, "skills/example-workflow/SKILL.md")]);
  assert.match(readFileSync(context.appendSystemPromptPath, "utf8"), /SYNTHETIC_SHARED_RULE/);
  assert.ok(warn.mock.calls.slice(before).some(call => /output-style.*optional-missing.*not found/.test(call.arguments.join(" "))));
  assert.throws(() => assemblePiContext(f.agent, { strict: true }), /Output-style is not a readable regular source/);
});

test("next publication or support asset changes invalidate shared identity while old revision paths remain pinned", () => {
  const f = sharedBehaviorFixture();
  const before = assemblePiContext(f.agent)!;
  const next = publication(f.root, "revision-two");
  symlinkSync(next.root, join(f.root, "next"));
  renameSync(join(f.root, "next"), f.current);
  const after = assemblePiContext(f.agent)!;
  assert.notEqual(before.manifest.digest, after.manifest.digest);
  assert.notEqual(before.behavioralFoundation!.digest, after.behavioralFoundation!.digest);
  assert.match(before.behavioralFoundation!.skillPaths[0], /revision-one/);
  assert.match(after.behavioralFoundation!.skillPaths[0], /revision-two/);
  // Even a skill-only publication change is part of the shared identity.
  const changed = "SYNTHETIC_CHANGED_SUPPORT\n";
  writeFileSync(join(next.root, "skills/example-workflow/support.md"), changed);
  next.manifest.files["skills/example-workflow/support.md"] = createHash("sha256").update(changed).digest("hex");
  next.save();
  assert.notEqual(assemblePiContext(f.agent)!.manifest.digest, after.manifest.digest);
});

test("deployment config enrolls existing and freshly added agents; instance overlays cannot unset or replace it", () => {
  const f = sharedBehaviorFixture();
  const configPath = join(f.root, "config.yaml");
  const raw = {
    behavioralFoundation: { root: f.current },
    agents: { existing: { workspaceCwd: f.workspace, model: "openai-codex/gpt-5.5" } },
    discord: { tokenEnv: "SYNTHETIC_UNUSED_TOKEN", bindings: [{ guildId: "synthetic-guild", channelId: "synthetic-channel", agentId: "existing", kind: "channel" }] },
  };
  const save = () => writeFileSync(configPath, JSON.stringify(raw));
  save();
  assert.equal(loadConfig(configPath, { resolveSecrets: false }).agents.existing.behavioralFoundationRoot, f.current);
  const freshWorkspace = join(f.root, "fresh-workspace");
  mkdirSync(freshWorkspace);
  Object.assign(raw.agents, { fresh: { workspaceCwd: freshWorkspace, model: "openai-codex/gpt-5.5" } });
  save();
  const config = loadConfig(configPath, { resolveSecrets: false });
  assert.equal(config.agents.fresh.behavioralFoundationRoot, f.current);
  const enrolled = assemblePiContext(config.agents.fresh)!;
  assert.match(readFileSync(enrolled.appendSystemPromptPath, "utf8"), /SYNTHETIC_SHARED_RULE/);
  assert.deepEqual(enrolled.behavioralFoundation!.skillPaths, [join(f.first.root, "skills/example-workflow/SKILL.md")]);
  assert.deepEqual(config.behavioralFoundation, { root: f.current });
  const overlay = join(f.root, "instance.yaml");
  writeFileSync(overlay, JSON.stringify({ behavioralFoundation: { root: f.current } }));
  assert.deepEqual(loadRawMergedConfig(configPath, overlay).behavioralFoundation, { root: f.current });
  for (const override of [null, false, {}, { root: null }, { root: f.first.root }]) {
    writeFileSync(overlay, JSON.stringify({ behavioralFoundation: override }));
    assert.throws(() => loadRawMergedConfig(configPath, overlay), /behavioralFoundation/);
  }
  for (const perAgent of [{ behavioralFoundation: false }, { behavioralFoundationRoot: f.current }]) {
    assert.throws(() => validateAgent({ workspaceCwd: f.workspace, ...perAgent }, "fresh"), /deployment-global/);
  }
  assert.equal(validateBehavioralFoundation(undefined), undefined);
  assert.throws(() => validateBehavioralFoundation({ root: "relative" }), /absolute/);
});

test("ordinary local unavailable rules warn and skip; strict rules fail; irrelevant junk is ignored", t => {
  const warn = t.mock.method(log, "warn", () => {});
  for (const unavailable of ["dangling", "unreadable", "directory"]) {
    const f = sharedBehaviorFixture();
    const dir = join(f.workspace, ".claude/rules/custom");
    mkdirSync(dir, {recursive:true});
    writeFileSync(join(dir, "valid.md"), "SYNTHETIC_LOCAL_RULE");
    const path = join(dir, unavailable === "directory" ? "blocked" : "optional.md");
    if (unavailable === "dangling") symlinkSync(join(f.root, "missing"), path);
    else {
      if (unavailable === "directory") mkdirSync(path);
      else writeFileSync(path, "SYNTHETIC_UNREADABLE");
      chmodSync(path, 0);
    }
    try {
      const context = assemblePiContext(f.agent)!;
      assert.match(readFileSync(context.appendSystemPromptPath, "utf8"), /SYNTHETIC_LOCAL_RULE/);
      assert.throws(() => assemblePiContext(f.agent, {strict:true}));
      assert.ok(warn.mock.calls.some(c => c.arguments.join(" ").includes("optional local rule")));
    } finally { if (unavailable !== "dangling") chmodSync(path, 0o700); }
  }
  const f = sharedBehaviorFixture();
  const dir = join(f.workspace, ".claude/rules/custom");
  mkdirSync(dir, {recursive:true});
  writeFileSync(join(dir, "junk.bin"), "SYNTHETIC_JUNK");
  chmodSync(join(dir, "junk.bin"), 0);
  symlinkSync(join(f.root, "missing-junk"), join(dir, "junk-link.bin"));
  try { assert.ok(assemblePiContext(f.agent)); }
  finally { chmodSync(join(dir, "junk.bin"), 0o600); }
});

test("unrequired dangling and unreadable local skills follow native skip semantics", t => {
  t.mock.method(log, "warn", () => {});
  for (const owner of [false, true]) {
    const f = sharedBehaviorFixture();
    if (owner) { f.first.manifest.skills[0].source = ".claude/skills/promoted"; f.first.save(); }
    const dir = join(f.workspace, ".claude/skills");
    mkdirSync(join(dir, "unreadable"), {recursive:true});
    symlinkSync(join(f.root, "missing-skill"), join(dir, "dangling"));
    const skill = join(dir, "unreadable/SKILL.md");
    writeFileSync(skill, "---\nname: unreadable\ndescription: Synthetic\n---\n");
    chmodSync(skill, 0);
    try {
      assert.equal(loadSkillsFromDir({dir, source:"path"}).skills.length, 0);
      const context = assemblePiContext({...f.agent, id:owner ? "source-owner" : f.agent.id})!;
      assert.deepEqual(context.behavioralFoundation!.skillPaths, [join(f.first.root, "skills/example-workflow/SKILL.md")]);
    } finally { chmodSync(skill, 0o600); }
  }
});

test("published SKILL.md paths load natively even when publication gitignore excludes them", () => {
  const f = sharedBehaviorFixture();
  const path = "skills/example-workflow/.gitignore";
  const body = "SKILL.md\n";
  writeFileSync(join(f.first.root, path), body);
  f.first.manifest.files[path] = createHash("sha256").update(body).digest("hex");
  f.first.save();
  const context = assemblePiContext(f.agent)!;
  const native = loadSkills({cwd:f.workspace, agentDir:f.workspace, includeDefaults:false,
    skillPaths:context.behavioralFoundation!.skillPaths});
  assert.deepEqual(native.skills.map(skill => skill.name), ["example-workflow"]);
  assert.equal(native.skills[0].filePath, join(f.first.root, "skills/example-workflow/SKILL.md"));
});

test("unreadable native ignore files and dangling root SKILL.md do not hide valid siblings", t => {
  t.mock.method(log, "warn", () => {});
  const f = sharedBehaviorFixture();
  f.first.manifest.skills[0].source = ".claude/skills/promoted";
  f.first.save();
  const dir = join(f.workspace, ".claude/skills");
  mkdirSync(join(dir, "addition"), {recursive:true});
  const skill = join(dir, "addition/SKILL.md");
  writeFileSync(skill, "---\nname: addition\ndescription: Synthetic\n---\n");
  symlinkSync(join(f.root, "missing-root-skill"), join(dir, "SKILL.md"));
  const ignored = join(dir, ".gitignore");
  writeFileSync(ignored, "addition/\n");
  chmodSync(ignored, 0);
  try {
    assert.equal(loadSkillsFromDir({dir, source:"path"}).skills.length, 1);
    assert.equal(assemblePiContext({...f.agent, id:"source-owner"})!.behavioralFoundation!.skillPaths[1], skill);
    symlinkSync(join(f.root, "outside"), join(dir, "escaped"));
    mkdirSync(join(f.root, "outside"));
    assert.throws(() => assemblePiContext({...f.agent, id:"source-owner"}), /resource resolves outside/);
  } finally { chmodSync(ignored, 0o600); }
});
