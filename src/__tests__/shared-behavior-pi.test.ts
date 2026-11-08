import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { assemblePiContext, assemblePiSubagentFoundation, piContextResourceArgs, type PiContextArtifacts } from "../pi-context-assembler.js";
import { resolvePackageOwnedPiInvocation } from "../pi-runtime.js";
import { publication, sharedBehaviorFixture } from "./shared-behavior-fixture.js";

test("pinned Pi offline: shared rule, private local context, native lazy skill/support reads and next-load revision", { timeout: 30_000 }, async () => {
  const f = sharedBehaviorFixture();
  const old = assemblePiContext(f.agent)!;
  const oldSkill = join(old.behavioralFoundation!.skillPaths[0], "SKILL.md");
  const second = publication(f.root, "revision-two");
  symlinkSync(second.root, join(f.root, "next"));
  renameSync(join(f.root, "next"), f.current);
  const next = assemblePiContext(f.agent)!;
  assert.notEqual(next.manifest.digest, old.manifest.digest);
  assert.notEqual(next.appendSystemPromptPath, old.appendSystemPromptPath);
  assert.match(readFileSync(old.appendSystemPromptPath, "utf8"), /SYNTHETIC_SHARED_RULE_revision-one/);
  assert.match(readFileSync(next.appendSystemPromptPath, "utf8"), /SYNTHETIC_SHARED_RULE_revision-two/);
  assert.match(readFileSync(join(old.behavioralFoundation!.skillPaths[0], "support.md"), "utf8"), /revision-one/);
  assert.equal(oldSkill.includes("current"), false);
  const home = join(f.root, "home");
  mkdirSync(home);
  mkdirSync(join(home, "pi/skills/ambient"), { recursive: true });
  writeFileSync(join(home, "pi/skills/ambient/SKILL.md"), "---\nname: ambient\ndescription: SYNTHETIC_AMBIENT_SKILL\n---\n");
  writeFileSync(join(f.workspace, "SYSTEM.md"), "SYNTHETIC_AMBIENT_SYSTEM");
  const run = async (context: PiContextArtifacts) => {
    const invocation = resolvePackageOwnedPiInvocation("cli", [
      "--offline", "--mode", "json", "-p", "--no-session", "--no-extensions", "--no-prompt-templates",
      ...piContextResourceArgs(context),
      "--extension", resolve("test-fixtures/agent-runtime/foundation-provider.mjs"),
      "--model", "foundation-offline/fixture", "--thinking", "off", "--tools", "read", "Verify shared foundation",
    ]);
    assert.equal(invocation.diagnostic.detectedVersion, "1.5.0");
    const result = await new Promise<{ stdout: string; stderr: string }>((done, reject) => {
      const child = execFile(invocation.command, invocation.args, {
        cwd: f.workspace, timeout: 20_000, maxBuffer: 2_000_000,
        env: { HOME: home, PATH: process.env.PATH, PI_CODING_AGENT_DIR: join(home, "pi"), PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
      }, (error, stdout, stderr) => error ? reject(Object.assign(error, { stdout, stderr })) : done({ stdout, stderr }));
      child.stdin?.end(); // Pi reads piped input before entering print mode.
    });
    const messages = result.stdout.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const last = messages.filter(m => m.type === "message_end" && m.message?.role === "assistant").at(-1);
    return JSON.parse(last.message.content[0].text);
  };
  const expected = { sharedRule: true, localPrivate: true, metadata: true, lazyBody: true, ambientSkill: false, ambientSystem: false, skillRead: true, supportRead: true, location: oldSkill };
  assert.deepEqual(await run(old), expected);
  const delegated = assemblePiSubagentFoundation(old.behavioralFoundation!.root, f.workspace, "role", "SYNTHETIC_DELEGATED_ROLE");
  assert.deepEqual(await run(delegated), { ...expected, localPrivate: false });
});
