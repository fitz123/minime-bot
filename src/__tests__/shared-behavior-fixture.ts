import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BehavioralFoundationManifest } from "../behavioral-foundation.js";

/** Synthetic package-only data. No private source selection or publisher workflow. */
export function publication(parent: string, revision = "revision-one") {
  const root = join(parent, revision);
  const content = {
    "rules/shared.md": `SYNTHETIC_SHARED_RULE_${revision}\n`,
    "skills/example-workflow/SKILL.md": "---\nname: example-workflow\ndescription: SYNTHETIC_SKILL_METADATA\n---\nSYNTHETIC_SKILL_BODY\nRead support.md relative to this directory.\n",
    "skills/example-workflow/support.md": `SYNTHETIC_SUPPORT_${revision}\n`,
  };
  for (const [path, body] of Object.entries(content)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  const manifest: BehavioralFoundationManifest = {
    version: 1, revision,
    rules: [{ path: "rules/shared.md", source: ".claude/rules/platform/shared.md" }],
    skills: [{ path: "skills/example-workflow", name: "example-workflow" }],
    files: Object.fromEntries(Object.entries(content).map(([path, body]) => [path, createHash("sha256").update(body).digest("hex")])),
    sourceOwnerAgentIds: ["source-owner"],
  };
  const save = () => writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  save();
  return { root, manifest, content, save };
}

export function sharedBehaviorFixture() {
  const root = realpathSync(mkdtempSync("/tmp/shared-behavior-"));
  const first = publication(root);
  const current = join(root, "current");
  symlinkSync(first.root, current);
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "CLAUDE.md"), "SYNTHETIC_LOCAL_CONTEXT\n@USER.md\n");
  writeFileSync(join(workspace, "USER.md"), "SYNTHETIC_PRIVATE_LOCAL_MARKER\n");
  return { root, first, current, workspace,
    agent: { id: "example-agent", model: "foundation-offline/fixture", workspaceCwd: workspace, behavioralFoundationRoot: current } };
}
