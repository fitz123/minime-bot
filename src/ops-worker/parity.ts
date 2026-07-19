import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { PiContextArtifacts } from "../pi-context-assembler.js";
import {
  createExpectedOpsWorkerParityContract,
  OPS_WORKER_EXTENSION_MARKER_PREFIX,
  opsWorkerEffectiveContextDigest,
  parseOpsWorkerParityAttestationReport,
  type OpsWorkerExpectedParityContract,
  type OpsWorkerParityAttestationReport,
} from "../pi-extensions/ops-worker-parity-attestation.js";
import {
  createPiExtensionResourceSnapshot,
  createPiSkillResourceSnapshot,
  PI_EXTENSION_JITI_EXTENSIONS,
  piResourceIdentity,
  type PiExtensionResourceFile,
  type PiPrimaryResourceContract,
  type PiSkillResourceFile,
  validatePiPrimaryResourceContract,
} from "../pi-primary-resources.js";

const MAX_REPORT_BYTES = 32 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

const PI_EXTENSION_JITI_ALIASES = (() => {
  const piCodingAgent = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const piAgentCore = fileURLToPath(import.meta.resolve("@earendil-works/pi-agent-core"));
  const piTui = fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"));
  const piAiCompat = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/compat"));
  const piAiOauth = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/oauth"));
  const typebox = fileURLToPath(import.meta.resolve("typebox"));
  const typeboxCompile = fileURLToPath(import.meta.resolve("typebox/compile"));
  const typeboxValue = fileURLToPath(import.meta.resolve("typebox/value"));
  const typescript = fileURLToPath(import.meta.resolve("typescript"));
  const yaml = fileURLToPath(import.meta.resolve("yaml"));
  return {
    "@earendil-works/pi-coding-agent": piCodingAgent,
    "@earendil-works/pi-agent-core": piAgentCore,
    "@earendil-works/pi-tui": piTui,
    "@earendil-works/pi-ai": piAiCompat,
    "@earendil-works/pi-ai/compat": piAiCompat,
    "@earendil-works/pi-ai/oauth": piAiOauth,
    "@mariozechner/pi-coding-agent": piCodingAgent,
    "@mariozechner/pi-agent-core": piAgentCore,
    "@mariozechner/pi-tui": piTui,
    "@mariozechner/pi-ai": piAiCompat,
    "@mariozechner/pi-ai/compat": piAiCompat,
    "@mariozechner/pi-ai/oauth": piAiOauth,
    typebox,
    "typebox/compile": typeboxCompile,
    "typebox/value": typeboxValue,
    "@sinclair/typebox": typebox,
    "@sinclair/typebox/compile": typeboxCompile,
    "@sinclair/typebox/value": typeboxValue,
    typescript,
    yaml,
  };
})();

const JITI_STATIC_URL = import.meta.resolve("jiti/static");

export interface OpsWorkerParityLaunch {
  expected: OpsWorkerExpectedParityContract;
  expectedPath: string;
  reportPath: string;
  ackPath: string;
  parityExtensionPath: string;
  parityExtensionIdentity: string;
  primaryResources: PiPrimaryResourceContract;
  sessionDirectory: string;
  /** Private copied extension closures and skill packages used only for this child launch. */
  snapshotRoots: readonly string[];
  /** Generated identity wrappers followed by the package parity gate. */
  extensionPaths: readonly string[];
  /** Immutable package copies rooted at each primary skill file. */
  skillPaths: readonly string[];
}

const PARITY_SNAPSHOT_DIRECTORY_PATTERN =
  /^parity-(?:extension-[0-9]+|skill-[0-9]+|gate)-snapshot-[A-Za-z0-9]+$/;

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function assertSafeSessionFile(path: string): void {
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error("Refusing unsafe parity handshake file");
    }
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writePrivateJson(path: string, value: unknown): void {
  assertSafeSessionFile(path);
  const staging = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(staging, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(staging, path);
}

function writePrivateExtensionWrapper(
  path: string,
  targetPath: string,
  identity: string,
  resourceFiles: readonly PiExtensionResourceFile[],
): void {
  assertSafeSessionFile(path);
  const digest = identity.startsWith("sha256:") ? identity.slice("sha256:".length) : "";
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError("Primary extension identity is not a sha256 digest");
  }
  const marker = `${OPS_WORKER_EXTENSION_MARKER_PREFIX}${digest}`;
  const source = [
    "import { createHash } from 'node:crypto';",
    "import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';",
    "import { normalize, resolve } from 'node:path';",
    `import { createJiti } from ${JSON.stringify(JITI_STATIC_URL)};`,
    `const targetExtensionPath = ${JSON.stringify(targetPath)};`,
    `const expectedFiles = ${JSON.stringify(resourceFiles)};`,
    `const extensionAliases = ${JSON.stringify(PI_EXTENSION_JITI_ALIASES)};`,
    `const extensionJitiExtensions = ${JSON.stringify(PI_EXTENSION_JITI_EXTENSIONS)};`,
    "const jiti = createJiti(import.meta.url, { alias: extensionAliases, esmEvalTempFile: false, extensions: extensionJitiExtensions, fsCache: true, interopDefault: true, jsx: false, moduleCache: false, nativeModules: [], rebuildFsCache: false, sourceMaps: false, transformModules: [], tryNative: false, tsconfigPaths: false });",
    "function sha256(value) { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }",
    "function verifyPinnedResources() {",
    "  for (const expected of expectedFiles) {",
    "    const direct = lstatSync(expected.path);",
    "    if (!direct.isFile() || direct.isSymbolicLink()) throw new Error('Pi extension resource changed after parity preparation');",
    "    if (typeof process.getuid === 'function' && direct.uid !== process.getuid()) throw new Error('Pi extension resource changed after parity preparation');",
    "    if (normalize(realpathSync(expected.path)) !== normalize(resolve(expected.path))) throw new Error('Pi extension resource changed after parity preparation');",
    "    const descriptor = openSync(expected.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));",
    "    try {",
    "      const opened = fstatSync(descriptor);",
    "      if (!opened.isFile() || opened.dev !== direct.dev || opened.ino !== direct.ino) throw new Error('Pi extension resource changed after parity preparation');",
    "      const content = readFileSync(descriptor);",
    "      const completed = fstatSync(descriptor);",
    "      if (completed.dev !== opened.dev || completed.ino !== opened.ino || completed.size !== opened.size || completed.mtimeMs !== opened.mtimeMs || completed.ctimeMs !== opened.ctimeMs || sha256(content) !== expected.contentHash) throw new Error('Pi extension resource changed after parity preparation');",
    "    } finally { closeSync(descriptor); }",
    "  }",
    "}",
    "export default async function minimeOpsExtensionWrapper(pi) {",
    "  verifyPinnedResources();",
    "  const targetExtension = await jiti.import(targetExtensionPath, { default: true });",
    "  verifyPinnedResources();",
    "  if (typeof targetExtension !== 'function') throw new TypeError('Pinned Pi extension has no default factory');",
    "  await targetExtension(pi);",
    "  verifyPinnedResources();",
    `  pi.registerCommand(${JSON.stringify(marker)}, { handler: async () => {} });`,
    "}",
    "",
  ].join("\n");
  const staging = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(staging, source, { mode: 0o400, flag: "wx" });
  renameSync(staging, path);
}

function commonResourceDirectory(files: readonly PiExtensionResourceFile[]): string {
  if (files.length === 0) throw new TypeError("Pi extension snapshot has no files");
  let common = dirname(files[0].path);
  for (;;) {
    const containsEveryFile = files.every((file) => {
      const child = relative(common, file.path);
      return child !== ".."
        && !child.startsWith(`..${sep}`)
        && !isAbsolute(child);
    });
    if (containsEveryFile) return common;
    const parent = dirname(common);
    if (parent === common) {
      throw new TypeError("Pi extension snapshot files do not share a filesystem root");
    }
    common = parent;
  }
}

function readPinnedResource(file: PiExtensionResourceFile, label = "Pi resource"): Buffer {
  const direct = lstatSync(file.path);
  if (
    !direct.isFile()
    || direct.isSymbolicLink()
    || (typeof process.getuid === "function" && direct.uid !== process.getuid())
    || normalize(realpathSync(file.path)) !== normalize(resolve(file.path))
  ) throw new Error(`${label} changed during private snapshot creation`);
  const descriptor = openSync(file.path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== direct.dev || opened.ino !== direct.ino) {
      throw new Error(`${label} changed during private snapshot creation`);
    }
    const content = readFileSync(descriptor);
    const completed = fstatSync(descriptor);
    if (
      completed.dev !== opened.dev
      || completed.ino !== opened.ino
      || completed.size !== opened.size
      || completed.mtimeMs !== opened.mtimeMs
      || completed.ctimeMs !== opened.ctimeMs
      || sha256(content) !== file.contentHash
    ) throw new Error(`${label} changed during private snapshot creation`);
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function writePrivateExtensionSnapshot(
  sessionDirectory: string,
  label: string,
  targetPath: string,
  snapshot: readonly PiExtensionResourceFile[],
): { snapshotRoot: string; targetPath: string; files: PiExtensionResourceFile[] } {
  const common = commonResourceDirectory(snapshot);
  const snapshotRoot = normalize(realpathSync(
    mkdtempSync(join(sessionDirectory, `${label}-snapshot-`)),
  ));
  chmodSync(snapshotRoot, 0o700);
  try {
    const copied = snapshot.map((file) => {
      const child = relative(common, file.path);
      if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new TypeError("Pi extension snapshot path escaped its private root");
      }
      const destination = join(snapshotRoot, child);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, readPinnedResource(file), { mode: 0o400, flag: "wx" });
      return { path: destination, contentHash: file.contentHash };
    });
    const targetChild = relative(common, targetPath);
    if (
      targetChild === ".."
      || targetChild.startsWith(`..${sep}`)
      || isAbsolute(targetChild)
    ) throw new TypeError("Pi extension entrypoint escaped its private snapshot");
    const copiedTarget = join(snapshotRoot, targetChild);
    if (!copied.some((file) => file.path === copiedTarget)) {
      throw new TypeError("Pi extension entrypoint is absent from its private snapshot");
    }
    return { snapshotRoot, targetPath: copiedTarget, files: copied };
  } catch (error) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function writePrivateSkillSnapshot(
  sessionDirectory: string,
  label: string,
  sourcePath: string,
  identity: string,
): { snapshotRoot: string; skillPath: string } {
  const snapshot = createPiSkillResourceSnapshot(sourcePath);
  if (snapshot.identity !== identity) {
    throw new Error("Pi skill package changed during private snapshot creation");
  }
  const snapshotRoot = normalize(realpathSync(
    mkdtempSync(join(sessionDirectory, `${label}-snapshot-`)),
  ));
  chmodSync(snapshotRoot, 0o700);
  try {
    const copied = snapshot.files.map((file: PiSkillResourceFile) => {
      const child = relative(snapshot.rootPath, file.path);
      if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new TypeError("Pi skill package path escaped its private root");
      }
      const destination = join(snapshotRoot, child);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(
        destination,
        readPinnedResource(file, "Pi skill package"),
        { mode: file.executable ? 0o500 : 0o400, flag: "wx" },
      );
      return destination;
    });
    const skillChild = relative(snapshot.rootPath, snapshot.skillPath);
    if (
      skillChild === ".."
      || skillChild.startsWith(`..${sep}`)
      || isAbsolute(skillChild)
    ) throw new TypeError("Pi skill entrypoint escaped its private snapshot");
    const skillPath = join(snapshotRoot, skillChild);
    if (!copied.includes(skillPath)) {
      throw new TypeError("Pi skill entrypoint is absent from its private snapshot");
    }
    if (piResourceIdentity("skill", skillPath) !== identity) {
      throw new Error("Pi skill package changed during private snapshot creation");
    }
    return { snapshotRoot, skillPath };
  } catch (error) {
    rmSync(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function preparePrivateExtensionWrapper(input: {
  sessionDirectory: string;
  label: string;
  wrapperPath: string;
  targetPath: string;
  identity: string;
}): { wrapperPath: string; snapshotRoot: string } {
  const snapshot = createPiExtensionResourceSnapshot(input.targetPath);
  if (snapshot.identity !== input.identity) {
    throw new Error("Pi extension changed during parity preparation");
  }
  const privateSnapshot = writePrivateExtensionSnapshot(
    input.sessionDirectory,
    input.label,
    normalize(realpathSync(input.targetPath)),
    snapshot.files,
  );
  try {
    writePrivateExtensionWrapper(
      input.wrapperPath,
      privateSnapshot.targetPath,
      input.identity,
      privateSnapshot.files,
    );
    return { wrapperPath: input.wrapperPath, snapshotRoot: privateSnapshot.snapshotRoot };
  } catch (error) {
    rmSync(privateSnapshot.snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

function removePrivateSnapshotRoot(sessionDirectory: string, snapshotRoot: string): void {
  let stats;
  try {
    stats = lstatSync(snapshotRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Refusing to remove a non-directory ops-worker parity snapshot");
  }
  const canonicalSessionDirectory = normalize(realpathSync(sessionDirectory));
  const canonicalSnapshotRoot = normalize(realpathSync(snapshotRoot));
  const relativeRoot = relative(canonicalSessionDirectory, canonicalSnapshotRoot);
  if (
    relativeRoot.includes(sep)
    || relativeRoot === ""
    || relativeRoot === "."
    || !PARITY_SNAPSHOT_DIRECTORY_PATTERN.test(relativeRoot)
  ) throw new Error("Refusing to remove an unsafe ops-worker parity snapshot path");
  rmSync(canonicalSnapshotRoot, { recursive: true, force: true });
}

export function cleanupOpsWorkerParityLaunch(launch: OpsWorkerParityLaunch): void {
  for (const snapshotRoot of launch.snapshotRoots) {
    removePrivateSnapshotRoot(launch.sessionDirectory, snapshotRoot);
  }
}

/** Remove crash leftovers only after the caller has proven no child can use them. */
export function cleanupOpsWorkerParitySessionSnapshots(sessionDirectory: string): void {
  for (const entry of readdirSync(sessionDirectory, { withFileTypes: true })) {
    if (!PARITY_SNAPSHOT_DIRECTORY_PATTERN.test(entry.name)) continue;
    removePrivateSnapshotRoot(sessionDirectory, join(sessionDirectory, entry.name));
  }
}

export function prepareOpsWorkerParityLaunch(input: {
  context: PiContextArtifacts;
  resources: PiPrimaryResourceContract;
  parityExtensionPath: string;
  parityExtensionIdentity: string;
  sessionDirectory: string;
  opsPolicy: string;
}): OpsWorkerParityLaunch {
  const resources = validatePiPrimaryResourceContract(input.resources);
  const parityExtensionIdentity = piResourceIdentity("extension", input.parityExtensionPath);
  if (parityExtensionIdentity !== input.parityExtensionIdentity) {
    throw new Error("Ops-worker parity extension changed after startup pinning");
  }
  const bundle = readFileSync(input.context.appendSystemPromptPath, "utf8");
  if (sha256(bundle) !== input.context.manifest.bundleHash) {
    throw new Error("Assembled Pi context bundle changed before parity preparation");
  }
  if (input.context.systemPromptPath) {
    const persona = readFileSync(input.context.systemPromptPath, "utf8");
    if (sha256(persona) !== input.context.manifest.personaHash) {
      throw new Error("Assembled Pi persona changed before parity preparation");
    }
  } else if (input.context.manifest.personaHash !== null) {
    throw new Error("Assembled Pi persona artifact is missing");
  }
  const expected = createExpectedOpsWorkerParityContract({
    primaryContextDigest: input.context.manifest.digest,
    customPromptHash: input.context.manifest.personaHash,
    appendSystemPromptHash: sha256(`${bundle}\n\n${input.opsPolicy}`),
    extensionIdentities: [
      ...resources.extensionIdentities,
      parityExtensionIdentity,
    ],
    skillIdentities: resources.skillIdentities,
    toolNames: resources.toolNames,
  });
  const expectedPath = join(input.sessionDirectory, "parity-expected-v1.json");
  const reportPath = join(input.sessionDirectory, "parity-report-v1.json");
  const ackPath = join(input.sessionDirectory, "parity-ack-v1.txt");
  writePrivateJson(expectedPath, expected);
  const snapshotRoots: string[] = [];
  try {
    const skillPaths = resources.skillPaths.map((skillPath, index) => {
      const prepared = writePrivateSkillSnapshot(
        input.sessionDirectory,
        `parity-skill-${index}`,
        skillPath,
        resources.skillIdentities[index],
      );
      snapshotRoots.push(prepared.snapshotRoot);
      return prepared.skillPath;
    });
    const wrappedExtensionPaths = resources.extensionPaths.map((extensionPath, index) => {
      const wrapperPath = join(input.sessionDirectory, `parity-extension-${index}.mjs`);
      const prepared = preparePrivateExtensionWrapper({
        sessionDirectory: input.sessionDirectory,
        label: `parity-extension-${index}`,
        wrapperPath,
        targetPath: extensionPath,
        identity: resources.extensionIdentities[index],
      });
      snapshotRoots.push(prepared.snapshotRoot);
      return prepared.wrapperPath;
    });
    const parityWrapperPath = join(input.sessionDirectory, "parity-gate.mjs");
    const preparedParity = preparePrivateExtensionWrapper({
      sessionDirectory: input.sessionDirectory,
      label: "parity-gate",
      wrapperPath: parityWrapperPath,
      targetPath: input.parityExtensionPath,
      identity: parityExtensionIdentity,
    });
    snapshotRoots.push(preparedParity.snapshotRoot);
    assertSafeSessionFile(reportPath);
    assertSafeSessionFile(ackPath);
    return {
      expected,
      expectedPath,
      reportPath,
      ackPath,
      parityExtensionPath: input.parityExtensionPath,
      parityExtensionIdentity,
      primaryResources: resources,
      sessionDirectory: input.sessionDirectory,
      snapshotRoots,
      extensionPaths: [...wrappedExtensionPaths, parityWrapperPath],
      skillPaths,
    };
  } catch (error) {
    for (const snapshotRoot of snapshotRoots) {
      removePrivateSnapshotRoot(input.sessionDirectory, snapshotRoot);
    }
    throw error;
  }
}

export function tryReadOpsWorkerParityReport(
  launch: OpsWorkerParityLaunch,
): OpsWorkerParityAttestationReport | null {
  let stats;
  try {
    stats = lstatSync(launch.reportPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_REPORT_BYTES) {
    throw new Error("Ops-worker parity report is not a bounded regular file");
  }
  const descriptor = openSync(launch.reportPath, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.ino !== stats.ino || opened.dev !== stats.dev) {
      throw new Error("Ops-worker parity report changed during read");
    }
    const parsed = parseOpsWorkerParityAttestationReport(
      JSON.parse(readFileSync(descriptor, "utf8")),
    );
    if (
      parsed.expectedDigest !== launch.expected.digest
      || parsed.primaryContextDigest !== launch.expected.primaryContextDigest
    ) throw new Error("Ops-worker parity report does not match the prepared contract");
    const expectedContextDigest = opsWorkerEffectiveContextDigest({
      customPromptHash: launch.expected.customPromptHash,
      appendSystemPromptHash: launch.expected.appendSystemPromptHash,
      contextFilesDigest: launch.expected.contextFilesDigest,
    });
    const contextCodes = ["CUSTOM_PROMPT", "APPEND_SYSTEM_PROMPT", "CONTEXT_FILES"] as const;
    const hasContextCode = contextCodes.some((code) => parsed.mismatch.includes(code));
    const hasCapabilityDigestMismatch =
      parsed.actualExtensionsDigest !== launch.expected.extensionsDigest
      || parsed.actualSkillsDigest !== launch.expected.skillsDigest
      || parsed.actualToolsDigest !== launch.expected.toolsDigest;
    const inconsistent =
      (parsed.actualContextDigest !== expectedContextDigest) !== hasContextCode
      || (parsed.actualExtensionsDigest !== launch.expected.extensionsDigest)
        !== parsed.mismatch.includes("EXTENSIONS")
      || (parsed.actualSkillsDigest !== launch.expected.skillsDigest)
        !== parsed.mismatch.includes("SKILLS")
      || (parsed.actualToolsDigest !== launch.expected.toolsDigest)
        !== parsed.mismatch.includes("TOOLS")
      || (parsed.actualCapabilityDigest !== launch.expected.capabilityDigest)
        !== hasCapabilityDigestMismatch;
    if (inconsistent) {
      throw new Error("Ops-worker parity report contradicts the prepared contract digests");
    }
    return parsed;
  } finally {
    closeSync(descriptor);
  }
}

export function acknowledgeOpsWorkerParityPass(launch: OpsWorkerParityLaunch): void {
  if (tryReadOpsWorkerParityReport(launch)?.status !== "PASS") {
    throw new Error("Cannot acknowledge a missing or failed Pi parity report");
  }
  validatePiPrimaryResourceContract(launch.primaryResources);
  if (piResourceIdentity("extension", launch.parityExtensionPath)
    !== launch.parityExtensionIdentity) {
    throw new Error("Ops-worker parity extension changed before acknowledgement");
  }
  const staging = `${launch.ackPath}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(staging, `${launch.expected.digest}\n`, { mode: 0o600, flag: "wx" });
  renameSync(staging, launch.ackPath);
}

export function formatOpsWorkerParityEvidence(
  report: OpsWorkerParityAttestationReport,
): string {
  return [
    `Pi parity v${report.version} ${report.status}`,
    `primary-context=${report.primaryContextDigest}`,
    `actual-context=${report.actualContextDigest}`,
    `capabilities=${report.actualCapabilityDigest}`,
    report.mismatch.length === 0 ? null : `mismatch=${report.mismatch.join(",")}`,
  ].filter((value): value is string => value !== null).join("; ");
}
