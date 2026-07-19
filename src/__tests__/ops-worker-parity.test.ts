import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
  opsWorkerEffectiveContextDigest,
  parseOpsWorkerParityAttestationReport,
  type OpsWorkerParityRuntimeSnapshot,
} from "../pi-extensions/ops-worker-parity-attestation.js";
import { CODEX_QUOTA_ATTEMPT_FILE_ENV } from "../pi-extensions/codex-usage.js";
import {
  PI_BUILTIN_TOOL_NAMES,
  piResourceIdentity,
  resolveOpsWorkerParityExtensionPath,
  resolvePiPrimaryResourceContract,
  validatePiPrimaryResourceContract,
} from "../pi-primary-resources.js";
import { resolvePiSpawnExtensionArgs } from "../pi-rpc-protocol.js";
import {
  acknowledgeOpsWorkerParityPass,
  prepareOpsWorkerParityLaunch,
  tryReadOpsWorkerParityReport,
} from "../ops-worker/parity.js";

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
    const extraImplementation = join(root, "configured-extra-implementation.ts");
    const skill = join(root, "SKILL.md");
    const originalImplementation = "export default function configuredExtra() {}\n";
    writeFileSync(extraImplementation, originalImplementation, "utf8");
    writeFileSync(
      extra,
      "export { default } from './configured-extra-implementation.js';\n",
      "utf8",
    );
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

    const originalExtensionIdentity = contract.extensionIdentities.at(-1);
    writeFileSync(
      extraImplementation,
      "export default function changedConfiguredExtra() {}\n",
      "utf8",
    );
    assert.notEqual(
      piResourceIdentity("extension", extra),
      originalExtensionIdentity,
    );
    assert.throws(
      () => validatePiPrimaryResourceContract(contract),
      /hashes are inconsistent/,
    );
    writeFileSync(extraImplementation, originalImplementation, "utf8");

    const originalSkillIdentity = contract.skillIdentities[0];
    writeFileSync(skill, "# Changed generic parity skill\n", "utf8");
    assert.notEqual(piResourceIdentity("skill", skill), originalSkillIdentity);
    assert.throws(
      () => validatePiPrimaryResourceContract(contract),
      /hashes are inconsistent/,
    );
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
    writeFileSync(extensionToolPath, "export default function () {}\n", "utf8");
    writeFileSync(extensionCommandPath, "export default function () {}\n", "utf8");
    writeFileSync(skillPath, "# Runtime parity skill\n", "utf8");
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
      systemPrompt: "GENERIC_EFFECTIVE_SYSTEM_PROMPT",
      baselineSystemPrompt: "GENERIC_EFFECTIVE_SYSTEM_PROMPT",
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
      ["SYSTEM_PROMPT", (snapshot: OpsWorkerParityRuntimeSnapshot) => ({
        ...snapshot,
        systemPrompt: `${snapshot.systemPrompt}\nchanged by an earlier extension`,
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

  it("rejects malformed, contradictory, and digest-inconsistent reports", () => {
    const { expected, snapshot } = fixture();
    const valid = attestOpsWorkerPiParity(expected, snapshot);
    assert.throws(
      () => parseOpsWorkerParityAttestationReport({ ...valid, extra: true }),
      /fixed schema/,
    );
    assert.throws(
      () => parseOpsWorkerParityAttestationReport({
        ...valid,
        status: "MISMATCH",
        mismatch: ["TOOLS", "TOOLS"],
      }),
      /duplicates/,
    );
    assert.throws(
      () => parseOpsWorkerParityAttestationReport({
        ...valid,
        actualToolsDigest: `sha256:${"f".repeat(64)}`,
      }),
      /capability digests are inconsistent/,
    );
    assert.throws(
      () => parseOpsWorkerParityAttestationReport({
        ...valid,
        status: "PASS",
        mismatch: ["TOOLS"],
      }),
      /contradicts/,
    );
  });

  it("wraps handler-only extensions with attestable identities and rejects a forged PASS", async () => {
    const root = tempDirectory();
    const handlerOnly = join(root, "handler-only.mjs");
    const skill = join(root, "SKILL.md");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(
      handlerOnly,
      "export default function (pi) { pi.on('session_start', () => undefined); }\n",
      "utf8",
    );
    writeFileSync(skill, "# Parity fixture skill\n", "utf8");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: {
        extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
        extraExtensions: [handlerOnly],
      },
      skillPaths: [skill],
      toolNames: [...PI_BUILTIN_TOOL_NAMES],
    });
    const parityExtensionPath = resolveOpsWorkerParityExtensionPath();
    const launch = prepareOpsWorkerParityLaunch({
      context: {
        appendSystemPromptPath: bundlePath,
        manifest: {
          version: 1,
          sources: [],
          bundleHash: sha256("GENERIC_BUNDLE\n"),
          personaHash: null,
          digest: sha256("GENERIC_MANIFEST"),
        },
      },
      resources,
      parityExtensionPath,
      parityExtensionIdentity: piResourceIdentity("extension", parityExtensionPath),
      sessionDirectory: root,
      opsPolicy: "GENERIC_POLICY",
    });
    const wrapperIndex = resources.extensionPaths.indexOf(realpathSync(handlerOnly));
    assert.ok(wrapperIndex >= 0);
    const commands: string[] = [];
    const events: string[] = [];
    const wrapper = (await import(
      `${pathToFileURL(launch.extensionPaths[wrapperIndex]).href}?wrapper=${Date.now()}`
    )).default;
    await wrapper({
      registerCommand: (name: string) => commands.push(name),
      on: (event: string) => events.push(event),
    });
    assert.deepEqual(events, ["session_start"]);
    assert.deepEqual(commands, [
      `minime-ops-extension-${resources.extensionIdentities[wrapperIndex].slice("sha256:".length)}`,
    ]);

    writeFileSync(launch.reportPath, `${JSON.stringify({
      version: 1,
      status: "PASS",
      expectedDigest: launch.expected.digest,
      primaryContextDigest: launch.expected.primaryContextDigest,
      actualContextDigest: `sha256:${"0".repeat(64)}`,
      actualSystemPromptHash: `sha256:${"1".repeat(64)}`,
      actualCapabilityDigest: launch.expected.capabilityDigest,
      actualExtensionsDigest: launch.expected.extensionsDigest,
      actualSkillsDigest: launch.expected.skillsDigest,
      actualToolsDigest: launch.expected.toolsDigest,
      mismatch: [],
    })}\n`, "utf8");
    assert.throws(
      () => tryReadOpsWorkerParityReport(launch),
      /contradicts the prepared contract digests/,
    );

    unlinkSync(launch.reportPath);
    symlinkSync(handlerOnly, launch.reportPath);
    assert.throws(
      () => tryReadOpsWorkerParityReport(launch),
      /not a bounded regular file/,
    );
    unlinkSync(launch.reportPath);
    writeFileSync(launch.reportPath, "x".repeat(32 * 1024 + 1), "utf8");
    assert.throws(
      () => tryReadOpsWorkerParityReport(launch),
      /not a bounded regular file/,
    );

    const changedParityExtension = join(root, "changed-parity-extension.mjs");
    writeFileSync(changedParityExtension, "export default function () {}\n", "utf8");
    const pinnedParityIdentity = piResourceIdentity("extension", changedParityExtension);
    writeFileSync(
      changedParityExtension,
      "export default function () { throw new Error('changed'); }\n",
      "utf8",
    );
    assert.throws(
      () => prepareOpsWorkerParityLaunch({
        context: {
          appendSystemPromptPath: bundlePath,
          manifest: {
            version: 1,
            sources: [],
            bundleHash: sha256("GENERIC_BUNDLE\n"),
            personaHash: null,
            digest: sha256("GENERIC_MANIFEST"),
          },
        },
        resources,
        parityExtensionPath: changedParityExtension,
        parityExtensionIdentity: pinnedParityIdentity,
        sessionDirectory: root,
        opsPolicy: "GENERIC_POLICY",
      }),
      /parity extension changed after startup pinning/,
    );
  });

  it("fences a generated wrapper when an imported implementation changes", async () => {
    const root = tempDirectory();
    const implementation = join(root, "configured-implementation.mjs");
    const extension = join(root, "configured-extension.mjs");
    const skill = join(root, "SKILL.md");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(
      implementation,
      "export function register(pi) { pi.on('session_start', () => undefined); }\n",
      "utf8",
    );
    writeFileSync(
      extension,
      "import { register } from './configured-implementation.mjs';\nexport default register;\n",
      "utf8",
    );
    writeFileSync(skill, "# Imported implementation parity fixture\n", "utf8");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: {
        extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
        extraExtensions: [extension],
      },
      skillPaths: [skill],
      toolNames: [...PI_BUILTIN_TOOL_NAMES],
    });
    const parityExtensionPath = resolveOpsWorkerParityExtensionPath();
    const launch = prepareOpsWorkerParityLaunch({
      context: {
        appendSystemPromptPath: bundlePath,
        manifest: {
          version: 1,
          sources: [],
          bundleHash: sha256("GENERIC_BUNDLE\n"),
          personaHash: null,
          digest: sha256("GENERIC_MANIFEST"),
        },
      },
      resources,
      parityExtensionPath,
      parityExtensionIdentity: piResourceIdentity("extension", parityExtensionPath),
      sessionDirectory: root,
      opsPolicy: "GENERIC_POLICY",
    });
    const wrapperIndex = resources.extensionPaths.indexOf(realpathSync(extension));
    assert.ok(wrapperIndex >= 0);

    const sideEffectKey = `__minimeParitySideEffect${Date.now()}`;
    writeFileSync(
      implementation,
      `globalThis[${JSON.stringify(sideEffectKey)}] = true;\n`
        + "export function register(pi) { pi.on('changed', () => undefined); }\n",
      "utf8",
    );
    const wrapper = (await import(
      `${pathToFileURL(launch.extensionPaths[wrapperIndex]).href}?drift=${Date.now()}`
    )).default;
    const commands: string[] = [];
    const events: string[] = [];
    assert.equal((globalThis as Record<string, unknown>)[sideEffectKey], undefined);
    await assert.rejects(
      wrapper({
        registerCommand: (name: string) => commands.push(name),
        on: (event: string) => events.push(event),
      }),
      /resource changed after parity preparation/,
    );
    assert.equal((globalThis as Record<string, unknown>)[sideEffectKey], undefined);
    assert.deepEqual(commands, []);
    assert.deepEqual(events, []);
  });

  it("revalidates pinned resources immediately before parity acknowledgement", () => {
    const root = tempDirectory();
    const implementation = join(root, "ack-implementation.mjs");
    const extension = join(root, "ack-extension.mjs");
    const skill = join(root, "SKILL.md");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(implementation, "export default function ackImplementation() {}\n", "utf8");
    writeFileSync(extension, "export { default } from './ack-implementation.mjs';\n", "utf8");
    writeFileSync(skill, "# ACK parity fixture\n", "utf8");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: {
        extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
        extraExtensions: [extension],
      },
      skillPaths: [skill],
      toolNames: [...PI_BUILTIN_TOOL_NAMES],
    });
    const parityExtensionPath = resolveOpsWorkerParityExtensionPath();
    const launch = prepareOpsWorkerParityLaunch({
      context: {
        appendSystemPromptPath: bundlePath,
        manifest: {
          version: 1,
          sources: [],
          bundleHash: sha256("GENERIC_BUNDLE\n"),
          personaHash: null,
          digest: sha256("GENERIC_MANIFEST"),
        },
      },
      resources,
      parityExtensionPath,
      parityExtensionIdentity: piResourceIdentity("extension", parityExtensionPath),
      sessionDirectory: root,
      opsPolicy: "GENERIC_POLICY",
    });
    writeFileSync(launch.reportPath, `${JSON.stringify({
      version: 1,
      status: "PASS",
      expectedDigest: launch.expected.digest,
      primaryContextDigest: launch.expected.primaryContextDigest,
      actualContextDigest: opsWorkerEffectiveContextDigest({
        customPromptHash: launch.expected.customPromptHash,
        appendSystemPromptHash: launch.expected.appendSystemPromptHash,
        contextFilesDigest: launch.expected.contextFilesDigest,
      }),
      actualSystemPromptHash: sha256("GENERIC_EFFECTIVE_SYSTEM_PROMPT"),
      actualCapabilityDigest: launch.expected.capabilityDigest,
      actualExtensionsDigest: launch.expected.extensionsDigest,
      actualSkillsDigest: launch.expected.skillsDigest,
      actualToolsDigest: launch.expected.toolsDigest,
      mismatch: [],
    })}\n`, "utf8");

    writeFileSync(implementation, "export default function changedAfterReport() {}\n", "utf8");
    assert.throws(
      () => acknowledgeOpsWorkerParityPass(launch),
      /hashes are inconsistent/,
    );
    assert.equal(existsSync(launch.ackPath), false);
  });

  it("ships a package-owned marker, parity gate, and attempt quota capture", async () => {
    const commands: string[] = [];
    const events: string[] = [];
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const wrapper = (await import(
      `${pathToFileURL(resolve(PACKAGE_ROOT, "extensions", "pi", "ops-worker-parity-attestation.ts")).href}?test=${Date.now()}`
    )).default;
    wrapper({
      registerCommand: (name: string) => commands.push(name),
      on: (event: string, handler: (...args: unknown[]) => unknown) => {
        events.push(event);
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI);
    assert.deepEqual(commands, ["minime-ops-parity-resource"]);
    assert.deepEqual(events, [
      "session_start",
      "before_agent_start",
      "tool_call",
      "after_provider_response",
    ]);
    const toolCall = handlers.get("tool_call");
    const afterProviderResponse = handlers.get("after_provider_response");
    assert.ok(toolCall);
    assert.ok(afterProviderResponse);
    const attemptFile = join(tempDirectory(), "attempt-quota.json");
    const originalProbe = process.env.MINIME_OPS_WORKER_QUOTA_PROBE;
    const originalAttemptFile = process.env[CODEX_QUOTA_ATTEMPT_FILE_ENV];
    try {
      delete process.env.MINIME_OPS_WORKER_QUOTA_PROBE;
      assert.equal(await toolCall({ name: "read" }), undefined);
      process.env.MINIME_OPS_WORKER_QUOTA_PROBE = "1";
      assert.deepEqual(await toolCall({ name: "read" }), {
        block: true,
        reason: "Quota smoke probes cannot execute tools",
      });
      process.env[CODEX_QUOTA_ATTEMPT_FILE_ENV] = attemptFile;
      await afterProviderResponse({
        status: 429,
        headers: {
          "x-codex-primary-used-percent": "100",
          "x-codex-primary-reset-at": "1784476800",
        },
      });
      const capture = JSON.parse(readFileSync(attemptFile, "utf8")) as Record<string, unknown>;
      assert.equal(capture.version, 1);
      assert.equal(capture.responseStatus, 429);
      assert.equal(
        ((capture.snapshot as { windows: { "5h": { usedPercent: number } } })
          .windows["5h"].usedPercent),
        100,
      );
      await afterProviderResponse({ status: 429, headers: {} });
      const missingTelemetry = JSON.parse(
        readFileSync(attemptFile, "utf8"),
      ) as Record<string, unknown>;
      assert.equal(missingTelemetry.responseStatus, 429);
      assert.equal(missingTelemetry.snapshot, null);
    } finally {
      if (originalProbe === undefined) delete process.env.MINIME_OPS_WORKER_QUOTA_PROBE;
      else process.env.MINIME_OPS_WORKER_QUOTA_PROBE = originalProbe;
      if (originalAttemptFile === undefined) delete process.env[CODEX_QUOTA_ATTEMPT_FILE_ENV];
      else process.env[CODEX_QUOTA_ATTEMPT_FILE_ENV] = originalAttemptFile;
    }
  });
});
