import { createHash } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  attestOpsWorkerPiParity,
  createExpectedOpsWorkerParityContract,
  type OpsWorkerParityRuntimeSnapshot,
} from "../pi-extensions/ops-worker-parity-attestation.js";
import {
  PI_BUILTIN_TOOL_NAMES,
  piResourceIdentity,
  resolvePiPrimaryResourceContract,
  validatePiPrimaryResourceContract,
} from "../pi-primary-resources.js";
import { resolvePiSpawnExtensionArgs } from "../pi-rpc-protocol.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const created: string[] = [];

function tempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "minime-pi-parity-"));
  created.push(path);
  return path;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

after(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true });
});

describe("primary Pi resource contract", () => {
  it("uses the primary RPC resolver and hashes explicit extensions, skills, and full tools", () => {
    const root = tempDirectory();
    const extra = join(root, "configured-extra.ts");
    const skill = join(root, "SKILL.md");
    writeFileSync(extra, "export default function () {}\n", "utf8");
    writeFileSync(skill, "# Generic parity skill\n", "utf8");
    const extensionOptions = {
      extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
      extraExtensions: [extra],
    };
    const tools = [...PI_BUILTIN_TOOL_NAMES, "configured_tool"];

    const contract = resolvePiPrimaryResourceContract({
      extensionOptions,
      skillPaths: [skill],
      toolNames: tools,
    });
    const primaryArgs = resolvePiSpawnExtensionArgs(extensionOptions);
    assert.deepEqual(
      contract.extensionPaths,
      primaryArgs.filter((_, index) => index % 2 === 1).map((path) => realpathSync(path)),
    );
    assert.deepEqual(contract.skillPaths, [realpathSync(skill)]);
    assert.deepEqual(contract.toolNames, tools);
    assert.deepEqual(
      contract.extensionIdentities,
      contract.extensionPaths.map((path) => piResourceIdentity("extension", path)),
    );
    assert.match(contract.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(contract.extensionIdentities).includes(root), false);
    assert.equal(JSON.stringify(contract.skillIdentities).includes(root), false);
    assert.deepEqual(validatePiPrimaryResourceContract(contract), contract);
  });

  it("rejects symlink, missing, duplicate, relative, and incomplete resources", () => {
    const root = tempDirectory();
    const targetExtension = join(root, "extension.ts");
    const linkedExtension = join(root, "extension-link.ts");
    const targetSkill = join(root, "SKILL.md");
    const linkedSkill = join(root, "SKILL-link.md");
    writeFileSync(targetExtension, "export default function () {}\n", "utf8");
    writeFileSync(targetSkill, "# Generic skill\n", "utf8");
    symlinkSync(targetExtension, linkedExtension);
    symlinkSync(targetSkill, linkedSkill);
    const base = {
      extensionOptions: { extensionsDir: join(PACKAGE_ROOT, "extensions", "pi") },
      skillPaths: [targetSkill],
      toolNames: [...PI_BUILTIN_TOOL_NAMES],
    };

    assert.throws(() => resolvePiPrimaryResourceContract({
      ...base,
      extensionOptions: { ...base.extensionOptions, extraExtensions: [linkedExtension] },
    }), /non-symlink/);
    assert.throws(() => resolvePiPrimaryResourceContract({
      ...base,
      skillPaths: [linkedSkill],
    }), /non-symlink/);
    assert.throws(() => resolvePiPrimaryResourceContract({
      ...base,
      skillPaths: [join(root, "missing.md")],
    }));
    assert.throws(() => resolvePiPrimaryResourceContract({
      ...base,
      skillPaths: ["SKILL.md"],
    }), /absolute/);
    assert.throws(() => resolvePiPrimaryResourceContract({
      ...base,
      skillPaths: [targetSkill, targetSkill],
    }), /duplicate/);
    assert.throws(() => resolvePiPrimaryResourceContract({
      ...base,
      toolNames: PI_BUILTIN_TOOL_NAMES.filter((tool) => tool !== "bash"),
    }), /missing built-in bash/);
  });
});

describe("ops-worker before-provider parity attestation", () => {
  function fixture(): {
    expected: ReturnType<typeof createExpectedOpsWorkerParityContract>;
    snapshot: OpsWorkerParityRuntimeSnapshot;
    privateValues: string[];
  } {
    const root = tempDirectory();
    const extensionToolPath = join(root, "tool-extension.ts");
    const extensionCommandPath = join(root, "hook-extension.ts");
    const skillPath = join(root, "SKILL.md");
    const customPrompt = "GENERIC_PRIMARY_PERSONA_BODY";
    const appendSystemPrompt = "GENERIC_PRIMARY_BUNDLE_BODY\n\nGENERIC_OPS_POLICY_BODY";
    const toolNames = [...PI_BUILTIN_TOOL_NAMES, "configured_tool"];
    const extensionIdentities = [extensionToolPath, extensionCommandPath]
      .map((path) => piResourceIdentity("extension", path));
    const expected = createExpectedOpsWorkerParityContract({
      primaryContextDigest: sha256("generic primary manifest"),
      customPromptHash: sha256(customPrompt),
      appendSystemPromptHash: sha256(appendSystemPrompt),
      extensionIdentities,
      skillIdentities: [piResourceIdentity("skill", skillPath)],
      toolNames,
    });
    const sourceInfo = (path: string) => ({
      path,
      source: "temporary",
      scope: "temporary" as const,
      origin: "top-level" as const,
    });
    const snapshot = {
      systemPromptOptions: {
        cwd: root,
        customPrompt,
        appendSystemPrompt,
        contextFiles: [],
        skills: [{ filePath: skillPath }],
      },
      activeToolNames: toolNames,
      allTools: [
        { name: "read", sourceInfo: sourceInfo("<builtin:read>") },
        { name: "configured_tool", sourceInfo: sourceInfo(extensionToolPath) },
      ],
      commands: [{
        name: "configured-hook-marker",
        source: "extension" as const,
        sourceInfo: sourceInfo(extensionCommandPath),
      }],
    } as unknown as OpsWorkerParityRuntimeSnapshot;
    return {
      expected,
      snapshot,
      privateValues: [root, customPrompt, appendSystemPrompt],
    };
  }

  it("reports a hash-only PASS for exact structured context and active resources", () => {
    const { expected, snapshot, privateValues } = fixture();
    const report = attestOpsWorkerPiParity(expected, snapshot);
    assert.equal(report.status, "PASS");
    assert.deepEqual(report.mismatch, []);
    assert.equal(report.expectedDigest, expected.digest);
    assert.equal(report.actualCapabilityDigest, expected.capabilityDigest);
    const serialized = JSON.stringify(report);
    for (const value of privateValues) assert.equal(serialized.includes(value), false);
  });

  it("fails closed on each context and capability mismatch class", () => {
    const cases = [
      ["CUSTOM_PROMPT", (snapshot: OpsWorkerParityRuntimeSnapshot) => ({
        ...snapshot,
        systemPromptOptions: { ...snapshot.systemPromptOptions, customPrompt: "changed" },
      })],
      ["APPEND_SYSTEM_PROMPT", (snapshot: OpsWorkerParityRuntimeSnapshot) => ({
        ...snapshot,
        systemPromptOptions: { ...snapshot.systemPromptOptions, appendSystemPrompt: "changed" },
      })],
      ["CONTEXT_FILES", (snapshot: OpsWorkerParityRuntimeSnapshot) => ({
        ...snapshot,
        systemPromptOptions: {
          ...snapshot.systemPromptOptions,
          contextFiles: [{ path: "AGENTS.md", content: "duplicate" }],
        },
      })],
      ["EXTENSIONS", (snapshot: OpsWorkerParityRuntimeSnapshot) => ({
        ...snapshot,
        commands: [],
      })],
      ["SKILLS", (snapshot: OpsWorkerParityRuntimeSnapshot) => ({
        ...snapshot,
        systemPromptOptions: { ...snapshot.systemPromptOptions, skills: [] },
      })],
      ["TOOLS", (snapshot: OpsWorkerParityRuntimeSnapshot) => ({
        ...snapshot,
        activeToolNames: snapshot.activeToolNames.slice(0, -1),
      })],
    ] as const;

    for (const [mismatch, mutate] of cases) {
      const { expected, snapshot } = fixture();
      const report = attestOpsWorkerPiParity(expected, mutate(snapshot));
      assert.equal(report.status, "MISMATCH", mismatch);
      assert.ok(report.mismatch.includes(mismatch), mismatch);
    }
  });

  it("ships a package-owned marker, parity gate, and attempt quota capture", async () => {
    const commands: string[] = [];
    const events: string[] = [];
    const wrapper = (await import(
      `${pathToFileURL(resolve(PACKAGE_ROOT, "extensions", "pi", "ops-worker-parity-attestation.ts")).href}?test=${Date.now()}`
    )).default;
    wrapper({
      registerCommand: (name: string) => commands.push(name),
      on: (event: string) => events.push(event),
    } as unknown as ExtensionAPI);
    assert.deepEqual(commands, ["minime-ops-parity-resource"]);
    assert.deepEqual(events, ["before_agent_start", "after_provider_response"]);
  });
});
