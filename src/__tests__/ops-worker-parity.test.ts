import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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
  createPiExtensionResourceSnapshot,
  createPiSkillResourceSnapshot,
  piResourceIdentity,
  resolveOpsWorkerParityExtensionPath,
  resolvePiPrimaryResourceContract,
  validatePiPrimaryResourceContract,
} from "../pi-primary-resources.js";
import { resolvePiSpawnExtensionArgs } from "../pi-rpc-protocol.js";
import {
  acknowledgeOpsWorkerParityPass,
  cleanupOpsWorkerParityLaunch,
  cleanupOpsWorkerParitySessionSnapshots,
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

function writeFixtureSkill(root: string, name: string, content: string): string {
  const skillDirectory = join(root, name);
  mkdirSync(skillDirectory, { recursive: true });
  const skillPath = join(skillDirectory, "SKILL.md");
  writeFileSync(skillPath, content, "utf8");
  return skillPath;
}

after(() => {
  for (const path of created) {
    if (existsSync(path)) cleanupOpsWorkerParitySessionSnapshots(path);
    rmSync(path, { recursive: true, force: true });
  }
});

describe("primary Pi resource contract", () => {
  it("uses the primary RPC resolver and hashes explicit extensions, skills, and full tools", () => {
    const root = tempDirectory();
    const extra = join(root, "configured-extra.ts");
    const extraImplementation = join(root, "configured-extra-implementation.ts");
    const skill = writeFixtureSkill(root, "contract-skill", "# Generic parity skill\n");
    const originalImplementation = "export default function configuredExtra() {}\n";
    writeFileSync(extraImplementation, originalImplementation, "utf8");
    writeFileSync(
      extra,
      "export { default } from './configured-extra-implementation.js';\n",
      "utf8",
    );
    const extensionOptions = {
      extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
      extraExtensions: [extra],
    };
    const tools = [...PI_BUILTIN_TOOL_NAMES, "configured_tool"];

    const contract = resolvePiPrimaryResourceContract({
      extensionOptions,
      extraExtensionResourcePaths: [[]],
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
    const targetSkill = writeFixtureSkill(root, "target-skill", "# Generic skill\n");
    const linkedSkill = join(root, "SKILL-link.md");
    writeFileSync(targetExtension, "export default function () {}\n", "utf8");
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
      extraExtensionResourcePaths: [[]],
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
    assert.throws(() => resolvePiPrimaryResourceContract({
      ...base,
      extensionOptions: { ...base.extensionOptions, extraExtensions: [targetExtension] },
    }), /require explicit non-module resource manifests/);

    const nestedSkillDirectory = join(dirname(targetSkill), "nested");
    mkdirSync(nestedSkillDirectory);
    symlinkSync(targetExtension, join(nestedSkillDirectory, "linked-resource"));
    assert.throws(
      () => resolvePiPrimaryResourceContract(base),
      /must not contain symlinks/,
    );
  });

  it("excludes only exact generated Python directory names from skill snapshots", () => {
    const root = tempDirectory();
    const skill = writeFixtureSkill(root, "python-skill", "# Generic Python skill\n");
    const skillRoot = dirname(skill);
    const ignoredEnvironment = join(root, "ignored-python-environment");
    mkdirSync(ignoredEnvironment);
    writeFileSync(join(ignoredEnvironment, "external.py"), "IGNORED_VENV\n", "utf8");
    symlinkSync(ignoredEnvironment, join(skillRoot, ".venv"), "dir");

    const ignoredPaths = [
      join(skillRoot, "nested", ".venv", "environment.py"),
      join(skillRoot, "nested", "__pycache__", "module.pyc"),
      join(skillRoot, ".pytest_cache", "state"),
    ];
    const includedPaths = [
      join(skillRoot, ".venv-copy", "environment.py"),
      join(skillRoot, "nested", "__pycache__-saved", "module.pyc"),
      join(skillRoot, ".pytest_cache.old", "state"),
    ];
    for (const path of [...ignoredPaths, ...includedPaths]) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${relative(skillRoot, path)}\n`, "utf8");
    }

    const snapshot = createPiSkillResourceSnapshot(skill);
    const snapshotPaths = snapshot.files.map((file) => relative(snapshot.rootPath, file.path));

    assert.equal(snapshotPaths.includes("SKILL.md"), true);
    assert.equal(snapshotPaths.some((path) => path === ".venv" || path.startsWith(".venv/")), false);
    assert.equal(snapshotPaths.some((path) => path.includes("/.venv/")), false);
    assert.equal(snapshotPaths.some((path) => path === ".pytest_cache" || path.startsWith(".pytest_cache/")), false);
    assert.equal(snapshotPaths.some((path) => path.includes("/__pycache__/")), false);
    assert.deepEqual(
      includedPaths.map((path) => snapshotPaths.includes(relative(skillRoot, path))),
      [true, true, true],
    );
    assert.equal(piResourceIdentity("skill", skill), snapshot.identity);
  });

  it("binds extension and skill identities to the selected entrypoint", () => {
    const root = tempDirectory();
    const extensionA = join(root, "extension-a.mjs");
    const extensionB = join(root, "extension-b.mjs");
    writeFileSync(
      extensionA,
      "import './extension-b.mjs'; export default function extensionA() {}\n",
      "utf8",
    );
    writeFileSync(
      extensionB,
      "import './extension-a.mjs'; export default function extensionB() {}\n",
      "utf8",
    );
    const skillRoot = join(root, "shared-skill-package");
    mkdirSync(skillRoot);
    const skillA = join(skillRoot, "A.md");
    const skillB = join(skillRoot, "B.md");
    writeFileSync(skillA, "# Skill A\n", "utf8");
    writeFileSync(skillB, "# Skill B\n", "utf8");

    const contract = resolvePiPrimaryResourceContract({
      extensionOptions: {
        relpaths: [],
        extraExtensions: [extensionA, extensionB],
      },
      extraExtensionResourcePaths: [[], []],
      skillPaths: [skillA, skillB],
      toolNames: [...PI_BUILTIN_TOOL_NAMES],
    });

    assert.notEqual(contract.extensionIdentities[0], contract.extensionIdentities[1]);
    assert.notEqual(contract.skillIdentities[0], contract.skillIdentities[1]);
    assert.deepEqual(validatePiPrimaryResourceContract(contract), contract);
  });

  it("rejects primary resources that the child parity protocol cannot represent", () => {
    const root = tempDirectory();
    const extensionsDir = join(PACKAGE_ROOT, "extensions", "pi");
    const defaultExtensionCount = resolvePiSpawnExtensionArgs({ extensionsDir }).length / 2;
    const extraExtensions = Array.from(
      { length: 128 - defaultExtensionCount },
      (_, index) => join(root, `extra-${index}.ts`),
    );
    for (const path of extraExtensions) {
      writeFileSync(path, "export default function extension() {}\n", "utf8");
    }
    assert.throws(
      () => resolvePiPrimaryResourceContract({
        extensionOptions: { extensionsDir, extraExtensions },
        extraExtensionResourcePaths: extraExtensions.map(() => []),
        skillPaths: [],
        toolNames: [...PI_BUILTIN_TOOL_NAMES],
      }),
      /extensions plus parity gate must not exceed 128/,
    );

    const tooManyTools = [
      ...PI_BUILTIN_TOOL_NAMES,
      ...Array.from(
        { length: 129 - PI_BUILTIN_TOOL_NAMES.length },
        (_, index) => `configured_tool_${index}`,
      ),
    ];
    assert.throws(
      () => resolvePiPrimaryResourceContract({
        extensionOptions: { extensionsDir },
        skillPaths: [],
        toolNames: tooManyTools,
      }),
      /tools must not exceed 128/,
    );

    const identities = Array.from({ length: 128 }, (_, index) => sha256(`identity-${index}`));
    const longTools = Array.from(
      { length: 128 },
      (_, index) => `tool_${index}_${"x".repeat(110)}`,
    );
    assert.throws(
      () => createExpectedOpsWorkerParityContract({
        primaryContextDigest: sha256("primary"),
        customPromptHash: sha256("persona"),
        appendSystemPromptHash: sha256("bundle"),
        extensionIdentities: identities,
        skillIdentities: identities,
        toolNames: longTools,
      }),
      /32768-byte parity contract limit/,
    );
  });

  it("hashes the exact Jiti-resolved closure and rejects runtime module loading", () => {
    const root = tempDirectory();
    const javascriptDependency = join(root, "dependency.js");
    const typescriptDependency = join(root, "dependency.ts");
    const extension = join(root, "extension.ts");
    writeFileSync(javascriptDependency, "export const value = 'javascript';\n", "utf8");
    writeFileSync(typescriptDependency, "export const value = 'typescript';\n", "utf8");
    writeFileSync(
      extension,
      [
        "import { value } from './dependency';",
        "export { value as selected } from './dependency';",
        "const payload = { arguments: [] };",
        "function localArguments() { return arguments.length + payload.arguments.length; }",
        "export default function extension() { return [value, localArguments()]; }",
        "",
      ].join("\n"),
      "utf8",
    );
    const original = createPiExtensionResourceSnapshot(extension);
    assert.deepEqual(
      original.files.map((file) => file.path),
      [realpathSync(javascriptDependency), realpathSync(extension)].sort(),
    );
    assert.equal(
      original.files.some((file) => file.path === realpathSync(typescriptDependency)),
      false,
    );
    writeFileSync(javascriptDependency, "export const value = 'changed';\n", "utf8");
    assert.notEqual(createPiExtensionResourceSnapshot(extension).identity, original.identity);

    const directoryDependency = join(root, "directory-dependency");
    mkdirSync(directoryDependency);
    writeFileSync(
      join(directoryDependency, "package.json"),
      `${JSON.stringify({ main: "./entry.js" })}\n`,
      "utf8",
    );
    writeFileSync(
      join(directoryDependency, "entry.js"),
      "export const value = 'package-main';\n",
      "utf8",
    );
    writeFileSync(
      extension,
      "import { value } from './directory-dependency'; export default value;\n",
      "utf8",
    );
    assert.throws(
      () => createPiExtensionResourceSnapshot(extension),
      /directory module resolution is ambiguous/,
    );

    const unattestableSources = [
      "export default async function extension(name: string) { return import('./' + name); }\n",
      "const dependency = require('./dependency.js'); export default function extension() { return dependency; }\n",
      "export default function extension() { return require('./dependency.js'); }\n",
      "export default function extension() { return module[`require`]('./dependency.js'); }\n",
      "export default function extension() { return module['require'].bind(module)('./dependency.js'); }\n",
      "export default function extension() { return eval('require')('./dependency.js'); }\n",
      "export default Function('return function extension() {}')();\n",
      "const p = process; const k = 'get' + 'BuiltinModule'; const m = p[k]('mod' + 'ule'); const c = m['create' + 'Require'](import.meta.url); export default c('./dependency.js');\n",
      "const g = globalThis; const key = 'Func' + 'tion'; export default g[key]('return () => 1')();\n",
      "const getter = Reflect.get; export default getter(globalThis, 'Function')('return () => 1')();\n",
      "const key = 'con' + 'structor'; export default (() => {})[key]('return () => 1')();\n",
      "export default jitiImport('/tmp/unpinned.mjs', { default: true });\n",
      "export default jitiESMResolve('/tmp/unpinned.mjs');\n",
      "export default arguments[1]('/tmp/unpinned.mjs');\n",
      "import { createRequire as load } from 'node:module'; export default function extension() { return load; }\n",
      "import { createJiti } from 'jiti'; export default createJiti(import.meta.url).import('./dependency.js');\n",
      "import unpinned from 'file:///tmp/unpinned.js'; export default unpinned;\n",
    ];
    for (const source of unattestableSources) {
      writeFileSync(extension, source, "utf8");
      assert.throws(
        () => createPiExtensionResourceSnapshot(extension),
        /cannot be attested safely/,
        source,
      );
    }
  });

  it("attests only the exact declared acorn graph and safe syntax forms", () => {
    const root = tempDirectory();
    const packageRoot = join(root, "node_modules", "acorn");
    const packageEntry = join(packageRoot, "dist", "acorn.mjs");
    const packageMetadata = join(packageRoot, "package.json");
    const extension = join(root, "node_modules", "configured-workflow", "index.ts");
    mkdirSync(dirname(packageEntry), { recursive: true });
    mkdirSync(dirname(extension), { recursive: true });
    const packageMetadataSource = `${JSON.stringify({
        name: "acorn",
        main: "./dist/acorn.cjs",
        exports: { ".": { import: "./dist/acorn.mjs", require: "./dist/acorn.cjs" } },
      })}\n`;
    writeFileSync(packageMetadata, packageMetadataSource, "utf8");
    writeFileSync(
      packageEntry,
      [
        "export function parse() {",
        "  const node = { arguments: [] };",
        "  return { type: arguments.length >= 0 && node.arguments.length === 0 ? 'Program' : 'Never' };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const accepted = [
      "import { Script } from 'node:vm';",
      "import { parse } from 'acorn';",
      "const runtime = { process: 'inert-key' };",
      "const navigatorValue = globalThis.navigator;",
      "export default function extension() { return [Script, parse, runtime, navigatorValue]; }",
      "",
    ].join("\n");
    writeFileSync(extension, accepted, "utf8");

    const snapshot = createPiExtensionResourceSnapshot(
      extension,
      [packageMetadata, packageEntry],
    );
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      [realpathSync(extension), realpathSync(packageMetadata), realpathSync(packageEntry)].sort(),
    );

    for (const manifest of [[packageMetadata], [packageEntry], []]) {
      assert.throws(
        () => createPiExtensionResourceSnapshot(extension, manifest),
        /manifest must cover the acorn package metadata and runtime entry/,
      );
    }

    const outsideEntry = join(root, "outside.mjs");
    writeFileSync(outsideEntry, "export const parse = () => ({ type: 'Outside' });\n", "utf8");
    writeFileSync(
      packageMetadata,
      `${JSON.stringify({
        name: "acorn",
        exports: { ".": { import: "./../../outside.mjs" } },
      })}\n`,
      "utf8",
    );
    assert.throws(
      () => createPiExtensionResourceSnapshot(
        extension,
        [packageMetadata, outsideEntry],
      ),
      /manifest must cover the acorn package metadata and runtime entry/,
    );

    writeFileSync(packageMetadata, packageMetadataSource, "utf8");
    writeFileSync(
      packageEntry,
      "import value from 'ambient-only'; export const parse = () => value;\n",
      "utf8",
    );
    assert.throws(
      () => createPiExtensionResourceSnapshot(extension, [packageMetadata, packageEntry]),
      /declared package entry must be self-contained/,
    );
    const injectedPackageLoaders = [
      "export const parse = () => jitiImport('/tmp/unpinned.mjs', { default: true });\n",
      "export const parse = () => jitiESMResolve('/tmp/unpinned.mjs');\n",
      "export const parse = () => arguments[1]('/tmp/unpinned.mjs');\n",
    ];
    for (const source of injectedPackageLoaders) {
      writeFileSync(packageEntry, source, "utf8");
      assert.throws(
        () => createPiExtensionResourceSnapshot(extension, [packageMetadata, packageEntry]),
        /declared package entry must be self-contained/,
        source,
      );
    }
    writeFileSync(packageEntry, "export const parse = () => ({ type: 'Program' });\n", "utf8");

    const rejected = [
      "import value from 'unlisted-package'; export default value;\n",
      "import { parse } from 'acorn/dist/acorn.mjs'; export default parse;\n",
      "const root = globalThis; export default root;\n",
      "const navigatorValue = globalThis['navigator']; export default navigatorValue;\n",
      "export default function extension() { return { process }; }\n",
      "export default function extension() { return { [process]: true }; }\n",
      "export default function extension() { return globalThis.require; }\n",
    ];
    for (const source of rejected) {
      writeFileSync(extension, source, "utf8");
      assert.throws(
        () => createPiExtensionResourceSnapshot(extension, [packageMetadata, packageEntry]),
        /cannot be attested safely/,
        source,
      );
    }
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
    const skillPath = writeFixtureSkill(root, "runtime-skill", "# Runtime parity skill\n");
    writeFileSync(extensionToolPath, "export default function () {}\n", "utf8");
    writeFileSync(extensionCommandPath, "export default function () {}\n", "utf8");
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
    const skill = writeFixtureSkill(root, "handler-skill", "# Parity fixture skill\n");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(
      handlerOnly,
      "export default function (pi) { pi.on('session_start', () => undefined); }\n",
      "utf8",
    );
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: {
        extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
        extraExtensions: [handlerOnly],
      },
      extraExtensionResourcePaths: [[]],
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

  it("pins package-owned subagent agents and prompts beside its private entrypoint", async () => {
    const root = tempDirectory();
    const subagentDirectory = join(root, "subagent");
    const agentsDirectory = join(subagentDirectory, "agents");
    const promptsDirectory = join(subagentDirectory, "prompts");
    mkdirSync(agentsDirectory, { recursive: true });
    mkdirSync(promptsDirectory, { recursive: true });
    const extension = join(subagentDirectory, "index.mjs");
    const agent = join(agentsDirectory, "worker.md");
    const prompt = join(promptsDirectory, "implement.md");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(
      extension,
      [
        "import path from 'node:path';",
        "import { fileURLToPath } from 'node:url';",
        "export default function (pi) {",
        "  pi.on('resources_discover', () => ({",
        "    promptPaths: [path.join(path.dirname(fileURLToPath(import.meta.url)), 'prompts')],",
        "  }));",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(agent, "PINNED_AGENT\n", "utf8");
    writeFileSync(prompt, "PINNED_PROMPT\n", "utf8");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const originalIdentity = createPiExtensionResourceSnapshot(extension).identity;
    writeFileSync(prompt, "CHANGED_PROMPT\n", "utf8");
    assert.notEqual(createPiExtensionResourceSnapshot(extension).identity, originalIdentity);
    writeFileSync(prompt, "PINNED_PROMPT\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: { relpaths: [], extraExtensions: [extension] },
      extraExtensionResourcePaths: [[]],
      skillPaths: [],
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
    let discoverResources: (() => { promptPaths: string[] }) | undefined;
    const wrapper = (await import(
      `${pathToFileURL(launch.extensionPaths[0]).href}?assets=${Date.now()}`
    )).default;
    await wrapper({
      on: (event: string, handler: () => { promptPaths: string[] }) => {
        if (event === "resources_discover") discoverResources = handler;
      },
      registerCommand: () => undefined,
    });
    assert.ok(discoverResources);
    const privatePromptDirectory = discoverResources().promptPaths[0];
    assert.notEqual(privatePromptDirectory, promptsDirectory);
    assert.equal(
      readFileSync(join(privatePromptDirectory, "implement.md"), "utf8"),
      "PINNED_PROMPT\n",
    );
    assert.equal(
      readFileSync(join(dirname(privatePromptDirectory), "agents", "worker.md"), "utf8"),
      "PINNED_AGENT\n",
    );
    cleanupOpsWorkerParityLaunch(launch);
  });

  it("copies explicitly declared non-module resources for configured extensions", async () => {
    const root = tempDirectory();
    const extension = join(root, "configured-assets.mjs");
    const asset = join(root, "configured-message.txt");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(
      extension,
      [
        "import { readFileSync } from 'node:fs';",
        "export default function extension(pi) {",
        "  const message = readFileSync(new URL('./configured-message.txt', import.meta.url), 'utf8').trim();",
        "  pi.registerCommand(`asset-${message}`, { handler: async () => {} });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(asset, "PINNED\n", "utf8");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: { relpaths: [], extraExtensions: [extension] },
      extraExtensionResourcePaths: [[asset]],
      skillPaths: [],
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
    writeFileSync(asset, "CHANGED_LIVE\n", "utf8");
    const commands: string[] = [];
    const wrapper = (await import(
      `${pathToFileURL(launch.extensionPaths[0]).href}?declared=${Date.now()}`
    )).default;

    await wrapper({ registerCommand: (name: string) => commands.push(name) });

    assert.ok(commands.includes("asset-PINNED"));
    assert.equal(commands.includes("asset-CHANGED_LIVE"), false);
    cleanupOpsWorkerParityLaunch(launch);
  });

  it("loads declared acorn only from a copied hoisted node_modules snapshot", async () => {
    const root = tempDirectory();
    const sourceRoot = join(root, "source");
    const sessionRoot = join(root, "session");
    const packageRoot = join(sourceRoot, "node_modules", "acorn");
    const packageEntry = join(packageRoot, "dist", "acorn.mjs");
    const packageMetadata = join(packageRoot, "package.json");
    const extension = join(sourceRoot, "node_modules", "configured-workflow", "index.ts");
    const bundlePath = join(sessionRoot, "bundle.md");
    mkdirSync(dirname(packageEntry), { recursive: true });
    mkdirSync(dirname(extension), { recursive: true });
    mkdirSync(sessionRoot, { recursive: true });
    writeFileSync(
      packageMetadata,
      `${JSON.stringify({
        name: "acorn",
        main: "./dist/acorn.cjs",
        exports: { ".": { import: "./dist/acorn.mjs", require: "./dist/acorn.cjs" } },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      packageEntry,
      "export const parse = () => ({ type: 'PINNED_PROGRAM' });\n",
      "utf8",
    );
    writeFileSync(
      extension,
      [
        "import { Script } from 'node:vm';",
        "import { parse } from 'acorn';",
        "const runtime = { process: 'inert-key' };",
        "const navigatorValue = globalThis.navigator;",
        "export default function extension(pi) {",
        "  const parsed = parse('fixture', { ecmaVersion: 'latest' });",
        "  new Script('1 + 1').runInNewContext();",
        "  void runtime; void navigatorValue;",
        "  pi.registerCommand(`acorn-${parsed.type}`, { handler: async () => {} });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: { relpaths: [], extraExtensions: [extension] },
      extraExtensionResourcePaths: [[packageMetadata, packageEntry]],
      skillPaths: [],
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
      sessionDirectory: sessionRoot,
      opsPolicy: "GENERIC_POLICY",
    });
    const extensionSnapshot = launch.preparedSnapshots.find((snapshot) =>
      snapshot.files.some((file) => file.path.endsWith(join("configured-workflow", "index.ts"))));
    assert.ok(extensionSnapshot);
    assert.equal(
      extensionSnapshot.files.some((file) =>
        relative(extensionSnapshot.rootPath, file.path)
          === join("node_modules", "acorn", "dist", "acorn.mjs")),
      true,
    );

    writeFileSync(extension, "throw new Error('LIVE_EXTENSION_LOADED');\n", "utf8");
    writeFileSync(packageEntry, "throw new Error('LIVE_ACORN_LOADED');\n", "utf8");
    const ambientRoot = join(sessionRoot, "node_modules", "acorn");
    mkdirSync(join(ambientRoot, "dist"), { recursive: true });
    writeFileSync(
      join(ambientRoot, "package.json"),
      `${JSON.stringify({
        name: "acorn",
        main: "./dist/acorn.cjs",
        exports: { ".": { import: "./dist/acorn.mjs", require: "./dist/acorn.cjs" } },
      })}\n`,
      "utf8",
    );
    writeFileSync(
      join(ambientRoot, "dist", "acorn.mjs"),
      "export const parse = () => ({ type: 'AMBIENT_PROGRAM' });\n",
      "utf8",
    );

    const commands: string[] = [];
    const wrapper = (await import(
      `${pathToFileURL(launch.extensionPaths[0]).href}?acorn=${Date.now()}`
    )).default;
    await wrapper({ registerCommand: (name: string) => commands.push(name) });

    assert.ok(commands.includes("acorn-PINNED_PROGRAM"));
    assert.equal(commands.includes("acorn-AMBIENT_PROGRAM"), false);
    cleanupOpsWorkerParityLaunch(launch);
  });

  it("removes private extension snapshots after use and on preparation failure", () => {
    const root = tempDirectory();
    const extension = join(root, "extension.mjs");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(extension, "export default function extension() {}\n", "utf8");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: { relpaths: [], extraExtensions: [extension] },
      extraExtensionResourcePaths: [[]],
      skillPaths: [],
      toolNames: [...PI_BUILTIN_TOOL_NAMES],
    });
    const parityExtensionPath = resolveOpsWorkerParityExtensionPath();
    const input = {
      context: {
        appendSystemPromptPath: bundlePath,
        manifest: {
          version: 1 as const,
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
    };
    const launch = prepareOpsWorkerParityLaunch(input);
    assert.equal(launch.snapshotRoots.length, 2);
    assert.equal(launch.snapshotRoots.every((path) => existsSync(path)), true);
    cleanupOpsWorkerParityLaunch(launch);
    assert.equal(launch.snapshotRoots.every((path) => !existsSync(path)), true);

    unlinkSync(join(root, "parity-extension-0.mjs"));
    mkdirSync(join(root, "parity-extension-0.mjs"));
    assert.throws(() => prepareOpsWorkerParityLaunch(input), /unsafe parity handshake file/);
    assert.deepEqual(
      readdirSync(root).filter((name) => /-snapshot-/.test(name)),
      [],
    );
  });

  it("launches skills from private byte-identical snapshots", () => {
    const root = tempDirectory();
    const extension = join(root, "extension.mjs");
    const bundlePath = join(root, "bundle.md");
    const originalSkill = [
      "---",
      "name: pinned-skill",
      "description: Generic pinned skill fixture.",
      "---",
      "# Original pinned instructions",
      "",
    ].join("\n");
    const skill = writeFixtureSkill(root, "pinned-skill", originalSkill);
    const skillRoot = dirname(skill);
    const scriptPath = join(skillRoot, "scripts", "inspect.sh");
    const referencePath = join(skillRoot, "references", "guide.md");
    const assetPath = join(skillRoot, "assets", "fixture.txt");
    const ignoredEnvironment = join(root, "ignored-python-environment");
    const ignoredCachePath = join(skillRoot, "nested", "__pycache__", "module.pyc");
    const ignoredPytestPath = join(skillRoot, ".pytest_cache", "state");
    const includedNearMissPath = join(skillRoot, ".pytest_cache.old", "state");
    mkdirSync(dirname(scriptPath), { recursive: true });
    mkdirSync(dirname(referencePath), { recursive: true });
    mkdirSync(dirname(assetPath), { recursive: true });
    mkdirSync(ignoredEnvironment);
    writeFileSync(join(ignoredEnvironment, "external.py"), "IGNORED_VENV\n", "utf8");
    symlinkSync(ignoredEnvironment, join(skillRoot, ".venv"), "dir");
    mkdirSync(dirname(ignoredCachePath), { recursive: true });
    mkdirSync(dirname(ignoredPytestPath), { recursive: true });
    mkdirSync(dirname(includedNearMissPath), { recursive: true });
    writeFileSync(scriptPath, "#!/bin/sh\nprintf 'skill package'\n", "utf8");
    chmodSync(scriptPath, 0o700);
    writeFileSync(referencePath, "PINNED_REFERENCE\n", "utf8");
    writeFileSync(assetPath, "PINNED_ASSET\n", "utf8");
    writeFileSync(ignoredCachePath, "IGNORED_CACHE\n", "utf8");
    writeFileSync(ignoredPytestPath, "IGNORED_PYTEST\n", "utf8");
    writeFileSync(includedNearMissPath, "PINNED_NEAR_MISS\n", "utf8");
    writeFileSync(extension, "export default function extension() {}\n", "utf8");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: { relpaths: [], extraExtensions: [extension] },
      extraExtensionResourcePaths: [[]],
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

    assert.equal(launch.skillPaths.length, 1);
    assert.notEqual(launch.skillPaths[0], resources.skillPaths[0]);
    assert.equal(readFileSync(launch.skillPaths[0], "utf8"), originalSkill);
    const privateSkillRoot = dirname(launch.skillPaths[0]);
    assert.equal(
      readFileSync(join(privateSkillRoot, "references", "guide.md"), "utf8"),
      "PINNED_REFERENCE\n",
    );
    assert.equal(
      readFileSync(join(privateSkillRoot, "assets", "fixture.txt"), "utf8"),
      "PINNED_ASSET\n",
    );
    assert.equal(existsSync(join(privateSkillRoot, ".venv")), false);
    assert.equal(existsSync(join(privateSkillRoot, "nested", "__pycache__")), false);
    assert.equal(existsSync(join(privateSkillRoot, ".pytest_cache")), false);
    assert.equal(
      readFileSync(join(privateSkillRoot, ".pytest_cache.old", "state"), "utf8"),
      "PINNED_NEAR_MISS\n",
    );
    assert.notEqual(statSync(join(privateSkillRoot, "scripts", "inspect.sh")).mode & 0o111, 0);
    assert.equal(
      piResourceIdentity("skill", launch.skillPaths[0]),
      resources.skillIdentities[0],
    );

    writeFileSync(skill, "# Changed live skill after preparation\n", "utf8");
    writeFileSync(referencePath, "CHANGED_LIVE_REFERENCE\n", "utf8");
    assert.equal(readFileSync(launch.skillPaths[0], "utf8"), originalSkill);
    assert.equal(
      readFileSync(join(privateSkillRoot, "references", "guide.md"), "utf8"),
      "PINNED_REFERENCE\n",
    );
    assert.notEqual(piResourceIdentity("skill", skill), resources.skillIdentities[0]);
    cleanupOpsWorkerParityLaunch(launch);
  });

  it("loads a generated source wrapper through Pi's real jiti extension loader", async () => {
    const root = tempDirectory();
    const skill = writeFixtureSkill(root, "loader-skill", "# Real loader parity fixture\n");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const extensionsDir = join(PACKAGE_ROOT, "extensions", "pi");
    const targetExtension = realpathSync(
      join(extensionsDir, "codex-transport-overflow.ts"),
    );
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: { extensionsDir },
      skillPaths: [skill],
      toolNames: [...PI_BUILTIN_TOOL_NAMES],
    });
    const targetIndex = resources.extensionPaths.indexOf(targetExtension);
    assert.ok(targetIndex >= 0);
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
    const rpcEntry = fileURLToPath(
      import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
    );
    const loaderPath = join(dirname(rpcEntry), "core", "extensions", "loader.js");
    const { loadExtensions } = await import(pathToFileURL(loaderPath).href);

    const loaded = await loadExtensions(
      [launch.extensionPaths[targetIndex]],
      PACKAGE_ROOT,
    );

    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const commandNames = [...loaded.extensions[0].commands.keys()];
    assert.ok(commandNames.includes("minime-codex-overflow-resource"));
    assert.ok(commandNames.includes(
      `minime-ops-extension-${resources.extensionIdentities[targetIndex].slice("sha256:".length)}`,
    ));
  });

  it("pins Jiti resolution instead of inheriting an ambient extension order", async () => {
    const root = tempDirectory();
    const extension = join(root, "configured-extension.ts");
    const javascriptDependency = join(root, "dependency.js");
    const typescriptDependency = join(root, "dependency.ts");
    const skill = writeFixtureSkill(root, "jiti-skill", "# Pinned Jiti resolver fixture\n");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(
      extension,
      [
        "import { selected } from './dependency';",
        "export default function extension(pi) {",
        "  pi.registerCommand(`selected-${selected}`, { handler: async () => {} });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(javascriptDependency, "export const selected = 'javascript';\n", "utf8");
    writeFileSync(typescriptDependency, "export const selected = 'typescript';\n", "utf8");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: {
        extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
        extraExtensions: [extension],
        relpaths: [],
      },
      extraExtensionResourcePaths: [[]],
      skillPaths: [skill],
      toolNames: [...PI_BUILTIN_TOOL_NAMES],
    });
    const targetIndex = resources.extensionPaths.indexOf(realpathSync(extension));
    assert.ok(targetIndex >= 0);
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
    const previousExtensions = process.env.JITI_EXTENSIONS;
    process.env.JITI_EXTENSIONS = JSON.stringify([
      ".ts",
      ".tsx",
      ".js",
      ".mjs",
      ".cjs",
      ".mts",
      ".cts",
    ]);
    try {
      const commands: string[] = [];
      const wrapper = (await import(
        `${pathToFileURL(launch.extensionPaths[targetIndex]).href}?pinned=${Date.now()}`
      )).default;
      await wrapper({
        registerCommand: (name: string) => commands.push(name),
      });
      assert.ok(commands.includes("selected-javascript"));
      assert.equal(commands.includes("selected-typescript"), false);
    } finally {
      if (previousExtensions === undefined) delete process.env.JITI_EXTENSIONS;
      else process.env.JITI_EXTENSIONS = previousExtensions;
    }
  });

  it("keeps root package semantics and rejects extension-local package replacements", async () => {
    const root = tempDirectory();
    const extension = join(root, "package-imports.ts");
    const localYaml = join(root, "node_modules", "yaml");
    const skill = writeFixtureSkill(root, "package-skill", "# Package alias fixture\n");
    const bundlePath = join(root, "bundle.md");
    mkdirSync(localYaml, { recursive: true });
    writeFileSync(
      join(localYaml, "package.json"),
      `${JSON.stringify({ type: "module", exports: "./index.js" })}\n`,
      "utf8",
    );
    writeFileSync(
      join(localYaml, "index.js"),
      "export function parse() { return { value: 'extension-local' }; }\n",
      "utf8",
    );
    writeFileSync(
      extension,
      [
        "import * as ai from '@earendil-works/pi-ai';",
        "import { parse } from 'yaml';",
        "export default function (pi) {",
        "  pi.registerCommand('pi-ai-' + ('getModel' in ai ? 'compat' : 'root'), { handler: async () => {} });",
        "  pi.registerCommand('yaml-' + parse('value: package-owned').value, { handler: async () => {} });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: {
        extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
        relpaths: [],
        extraExtensions: [extension],
      },
      extraExtensionResourcePaths: [[]],
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
    const commands: string[] = [];
    const wrapper = (await import(
      `${pathToFileURL(launch.extensionPaths[0]).href}?packages=${Date.now()}`
    )).default;

    await wrapper({ registerCommand: (name: string) => commands.push(name) });

    assert.ok(commands.includes("pi-ai-compat"));
    assert.ok(commands.includes("yaml-package-owned"));
    assert.equal(commands.includes("pi-ai-root"), false);
    assert.equal(commands.includes("yaml-extension-local"), false);
  });

  it("executes a verified private snapshot when the original implementation changes", async () => {
    const root = tempDirectory();
    const implementation = join(root, "configured-implementation.mjs");
    const extension = join(root, "configured-extension.mjs");
    const skill = writeFixtureSkill(
      root,
      "implementation-skill",
      "# Imported implementation parity fixture\n",
    );
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
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: {
        extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
        extraExtensions: [extension],
      },
      extraExtensionResourcePaths: [[]],
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
    await wrapper({
      registerCommand: (name: string) => commands.push(name),
      on: (event: string) => events.push(event),
    });
    assert.equal((globalThis as Record<string, unknown>)[sideEffectKey], undefined);
    assert.equal(commands.some((name) => /^minime-ops-extension-[a-f0-9]{64}$/.test(name)), true);
    assert.deepEqual(events, ["session_start"]);
  });

  it("executes the verified parity gate snapshot when its source changes", async () => {
    const root = tempDirectory();
    const extension = join(root, "configured-extension.mjs");
    const parityGate = join(root, "parity-gate-source.mjs");
    const skill = writeFixtureSkill(root, "gate-skill", "# Private parity gate fixture\n");
    const bundlePath = join(root, "bundle.md");
    writeFileSync(extension, "export default function () {}\n", "utf8");
    writeFileSync(
      parityGate,
      "export default function (pi) { pi.registerCommand('original-parity-gate', { handler: async () => {} }); }\n",
      "utf8",
    );
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: {
        extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
        relpaths: [],
        extraExtensions: [extension],
      },
      extraExtensionResourcePaths: [[]],
      skillPaths: [skill],
      toolNames: [...PI_BUILTIN_TOOL_NAMES],
    });
    const parityGateIdentity = piResourceIdentity("extension", parityGate);
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
      parityExtensionPath: parityGate,
      parityExtensionIdentity: parityGateIdentity,
      sessionDirectory: root,
      opsPolicy: "GENERIC_POLICY",
    });
    writeFileSync(
      parityGate,
      "export default function (pi) { pi.registerCommand('changed-parity-gate', { handler: async () => {} }); }\n",
      "utf8",
    );
    const commands: string[] = [];
    const wrapper = (await import(
      `${pathToFileURL(launch.extensionPaths.at(-1) as string).href}?gate=${Date.now()}`
    )).default;

    await wrapper({ registerCommand: (name: string) => commands.push(name) });

    assert.ok(commands.includes("original-parity-gate"));
    assert.ok(commands.includes(
      `minime-ops-extension-${parityGateIdentity.slice("sha256:".length)}`,
    ));
    assert.equal(commands.includes("changed-parity-gate"), false);
  });

  it("revalidates pinned resources immediately before parity acknowledgement", () => {
    const root = tempDirectory();
    const implementation = join(root, "ack-implementation.mjs");
    const extension = join(root, "ack-extension.mjs");
    const skill = writeFixtureSkill(root, "ack-skill", "# ACK parity fixture\n");
    const bundlePath = join(root, "bundle.md");
    const originalImplementation = "export default function ackImplementation() {}\n";
    writeFileSync(implementation, originalImplementation, "utf8");
    writeFileSync(extension, "export { default } from './ack-implementation.mjs';\n", "utf8");
    writeFileSync(bundlePath, "GENERIC_BUNDLE\n", "utf8");
    const resources = resolvePiPrimaryResourceContract({
      extensionOptions: {
        extensionsDir: join(PACKAGE_ROOT, "extensions", "pi"),
        extraExtensions: [extension],
      },
      extraExtensionResourcePaths: [[]],
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

    writeFileSync(implementation, originalImplementation, "utf8");
    const preparedWrapper = launch.preparedFiles.find(
      (file) => file.path === launch.extensionPaths[0],
    );
    assert.ok(preparedWrapper);
    const wrapperSource = readFileSync(preparedWrapper.path, "utf8");
    chmodSync(preparedWrapper.path, 0o600);
    writeFileSync(preparedWrapper.path, `${wrapperSource}\n// changed before ACK\n`, "utf8");
    assert.throws(
      () => acknowledgeOpsWorkerParityPass(launch),
      /Prepared Pi launch file/,
    );
    writeFileSync(preparedWrapper.path, wrapperSource, "utf8");
    chmodSync(preparedWrapper.path, 0o400);

    const preparedImplementation = launch.preparedSnapshots
      .flatMap((snapshot) => snapshot.files)
      .find((file) => file.path.endsWith("ack-implementation.mjs"));
    assert.ok(preparedImplementation);
    chmodSync(preparedImplementation.path, 0o600);
    writeFileSync(
      preparedImplementation.path,
      "export default function changedPreparedImplementation() {}\n",
      "utf8",
    );
    assert.throws(
      () => acknowledgeOpsWorkerParityPass(launch),
      /Prepared Pi snapshot file/,
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
