import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import type {
  BuildSystemPromptOptions,
  SlashCommandInfo,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { piResourceIdentity } from "../pi-primary-resources.js";

export const OPS_WORKER_PARITY_PROTOCOL_VERSION = 1 as const;
export const OPS_WORKER_PARITY_EXPECTED_PATH_ENV = "MINIME_OPS_WORKER_PARITY_EXPECTED_PATH";
export const OPS_WORKER_PARITY_REPORT_PATH_ENV = "MINIME_OPS_WORKER_PARITY_REPORT_PATH";
export const OPS_WORKER_PARITY_ACK_PATH_ENV = "MINIME_OPS_WORKER_PARITY_ACK_PATH";
export const OPS_WORKER_QUOTA_PROBE_ENV = "MINIME_OPS_WORKER_QUOTA_PROBE";
export const OPS_WORKER_EXTENSION_MARKER_PREFIX = "minime-ops-extension-";
export const OPS_WORKER_PARITY_FAILURE_EXIT_CODE = 78;

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const MAX_CONTRACT_BYTES = 32 * 1024;
const MAX_IDENTITIES = 128;
const MAX_TOOL_NAMES = 128;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface OpsWorkerExpectedParityContract {
  version: typeof OPS_WORKER_PARITY_PROTOCOL_VERSION;
  primaryContextDigest: string;
  customPromptHash: string | null;
  appendSystemPromptHash: string;
  contextFilesDigest: string;
  extensionIdentities: readonly string[];
  skillIdentities: readonly string[];
  toolNames: readonly string[];
  extensionsDigest: string;
  skillsDigest: string;
  toolsDigest: string;
  capabilityDigest: string;
  digest: string;
}

export type OpsWorkerParityAttestationStatus = "PASS" | "MISMATCH";

export interface OpsWorkerParityAttestationReport {
  version: typeof OPS_WORKER_PARITY_PROTOCOL_VERSION;
  status: OpsWorkerParityAttestationStatus;
  expectedDigest: string;
  primaryContextDigest: string;
  actualContextDigest: string;
  actualSystemPromptHash: string;
  actualCapabilityDigest: string;
  actualExtensionsDigest: string;
  actualSkillsDigest: string;
  actualToolsDigest: string;
  mismatch: readonly OpsWorkerParityMismatch[];
}

export type OpsWorkerParityMismatch =
  | "CUSTOM_PROMPT"
  | "APPEND_SYSTEM_PROMPT"
  | "CONTEXT_FILES"
  | "SYSTEM_PROMPT"
  | "EXTENSIONS"
  | "SKILLS"
  | "TOOLS";

export interface OpsWorkerParityRuntimeSnapshot {
  systemPrompt: string;
  baselineSystemPrompt: string | null;
  systemPromptOptions: BuildSystemPromptOptions;
  activeToolNames: readonly string[];
  allTools: readonly ToolInfo[];
  commands: readonly SlashCommandInfo[];
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function listDigest(domain: string, values: readonly string[]): string {
  return sha256(`${domain}\0${JSON.stringify([...values].sort())}`);
}

function contextFilesDigest(
  files: BuildSystemPromptOptions["contextFiles"],
): string {
  const identities = (files ?? []).map((file) => sha256([
    "minime-pi-context-file-v1",
    normalize(resolve(file.path)),
    sha256(file.content),
  ].join("\0")));
  return listDigest("minime-pi-context-files-v1", identities);
}

export const EMPTY_PI_CONTEXT_FILES_DIGEST = contextFilesDigest([]);

export function opsWorkerEffectiveContextDigest(input: {
  customPromptHash: string | null;
  appendSystemPromptHash: string;
  contextFilesDigest: string;
}): string {
  return sha256([
    "minime-ops-worker-effective-context-v1",
    input.customPromptHash ?? "none",
    input.appendSystemPromptHash,
    input.contextFilesDigest,
  ].join("\0"));
}

function requireSha256(value: unknown, path: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${path} must be a sha256 digest`);
  }
  return value;
}

function requireDigestList(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_IDENTITIES) {
    throw new TypeError(`${path} must be a bounded digest array`);
  }
  const result = value.map((entry, index) => requireSha256(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${path} must not contain duplicate identities`);
  }
  return result;
}

function requireToolNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TOOL_NAMES) {
    throw new TypeError("parity.toolNames must be a bounded array");
  }
  const result = value.map((entry, index) => {
    if (typeof entry !== "string" || !TOOL_NAME_PATTERN.test(entry)) {
      throw new TypeError(`parity.toolNames[${index}] is invalid`);
    }
    return entry;
  });
  if (new Set(result).size !== result.length) {
    throw new TypeError("parity.toolNames must not contain duplicates");
  }
  return result;
}

export function parseExpectedOpsWorkerParityContract(
  value: unknown,
): OpsWorkerExpectedParityContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("parity contract must be an object");
  }
  const obj = value as Record<string, unknown>;
  const expectedKeys = [
    "version",
    "primaryContextDigest",
    "customPromptHash",
    "appendSystemPromptHash",
    "contextFilesDigest",
    "extensionIdentities",
    "skillIdentities",
    "toolNames",
    "extensionsDigest",
    "skillsDigest",
    "toolsDigest",
    "capabilityDigest",
    "digest",
  ];
  if (
    Object.keys(obj).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(obj, key))
    || Object.keys(obj).some((key) => !expectedKeys.includes(key))
  ) throw new TypeError("parity contract fields must match the fixed schema");
  if (obj.version !== OPS_WORKER_PARITY_PROTOCOL_VERSION) {
    throw new TypeError("parity.version is unsupported");
  }
  const customPromptHash = obj.customPromptHash === null
    ? null
    : requireSha256(obj.customPromptHash, "parity.customPromptHash");
  const contract: OpsWorkerExpectedParityContract = {
    version: OPS_WORKER_PARITY_PROTOCOL_VERSION,
    primaryContextDigest: requireSha256(obj.primaryContextDigest, "parity.primaryContextDigest"),
    customPromptHash,
    appendSystemPromptHash: requireSha256(obj.appendSystemPromptHash, "parity.appendSystemPromptHash"),
    contextFilesDigest: requireSha256(obj.contextFilesDigest, "parity.contextFilesDigest"),
    extensionIdentities: requireDigestList(obj.extensionIdentities, "parity.extensionIdentities"),
    skillIdentities: requireDigestList(obj.skillIdentities, "parity.skillIdentities"),
    toolNames: requireToolNames(obj.toolNames),
    extensionsDigest: requireSha256(obj.extensionsDigest, "parity.extensionsDigest"),
    skillsDigest: requireSha256(obj.skillsDigest, "parity.skillsDigest"),
    toolsDigest: requireSha256(obj.toolsDigest, "parity.toolsDigest"),
    capabilityDigest: requireSha256(obj.capabilityDigest, "parity.capabilityDigest"),
    digest: requireSha256(obj.digest, "parity.digest"),
  };
  const recomputed = createExpectedOpsWorkerParityContract({
    primaryContextDigest: contract.primaryContextDigest,
    customPromptHash: contract.customPromptHash,
    appendSystemPromptHash: contract.appendSystemPromptHash,
    extensionIdentities: contract.extensionIdentities,
    skillIdentities: contract.skillIdentities,
    toolNames: contract.toolNames,
  });
  if (JSON.stringify(contract) !== JSON.stringify(recomputed)) {
    throw new TypeError("parity contract digests are inconsistent");
  }
  return contract;
}

export function createExpectedOpsWorkerParityContract(input: {
  primaryContextDigest: string;
  customPromptHash: string | null;
  appendSystemPromptHash: string;
  extensionIdentities: readonly string[];
  skillIdentities: readonly string[];
  toolNames: readonly string[];
}): OpsWorkerExpectedParityContract {
  const extensionIdentities = [...input.extensionIdentities].sort();
  const skillIdentities = [...input.skillIdentities].sort();
  const toolNames = [...input.toolNames].sort();
  const extensionsDigest = listDigest("minime-pi-extensions-v1", extensionIdentities);
  const skillsDigest = listDigest("minime-pi-skills-v1", skillIdentities);
  const toolsDigest = listDigest("minime-pi-tools-v1", toolNames);
  const capabilityDigest = sha256([
    "minime-ops-worker-capabilities-v1",
    extensionsDigest,
    skillsDigest,
    toolsDigest,
  ].join("\0"));
  const unsigned = {
    version: OPS_WORKER_PARITY_PROTOCOL_VERSION,
    primaryContextDigest: input.primaryContextDigest,
    customPromptHash: input.customPromptHash,
    appendSystemPromptHash: input.appendSystemPromptHash,
    contextFilesDigest: EMPTY_PI_CONTEXT_FILES_DIGEST,
    extensionIdentities,
    skillIdentities,
    toolNames,
    extensionsDigest,
    skillsDigest,
    toolsDigest,
    capabilityDigest,
  };
  return {
    ...unsigned,
    digest: sha256(`minime-ops-worker-parity-contract-v1\0${JSON.stringify(unsigned)}`),
  };
}

function activeExtensionIdentities(snapshot: OpsWorkerParityRuntimeSnapshot): string[] {
  const markerIdentities = new Map<string, Set<string>>();
  for (const command of snapshot.commands) {
    if (command.source !== "extension") continue;
    const path = command.sourceInfo.path;
    const marker = command.name.startsWith(OPS_WORKER_EXTENSION_MARKER_PREFIX)
      ? command.name.slice(OPS_WORKER_EXTENSION_MARKER_PREFIX.length)
      : "";
    if (!isAbsolute(path) || !/^[a-f0-9]{64}$/.test(marker)) continue;
    const normalized = normalize(resolve(path));
    const identities = markerIdentities.get(normalized) ?? new Set<string>();
    identities.add(`sha256:${marker}`);
    markerIdentities.set(normalized, identities);
  }
  const paths = new Set<string>();
  for (const tool of snapshot.allTools) {
    const path = tool.sourceInfo.path;
    if (isAbsolute(path)) paths.add(normalize(resolve(path)));
  }
  for (const command of snapshot.commands) {
    if (command.source !== "extension") continue;
    const path = command.sourceInfo.path;
    if (isAbsolute(path)) paths.add(normalize(resolve(path)));
  }
  const identities = new Set<string>();
  for (const path of paths) {
    const markers = markerIdentities.get(path);
    if (markers) {
      for (const marker of markers) identities.add(marker);
    } else {
      identities.add(piResourceIdentity("extension", path));
    }
  }
  return [...identities].sort();
}

function activeSkillIdentities(options: BuildSystemPromptOptions): string[] {
  return (options.skills ?? [])
    .map((skill) => piResourceIdentity("skill", skill.filePath))
    .sort();
}

export function attestOpsWorkerPiParity(
  expected: OpsWorkerExpectedParityContract,
  snapshot: OpsWorkerParityRuntimeSnapshot,
): OpsWorkerParityAttestationReport {
  const customPromptHash = snapshot.systemPromptOptions.customPrompt === undefined
    ? null
    : sha256(snapshot.systemPromptOptions.customPrompt);
  const appendSystemPromptHash = sha256(snapshot.systemPromptOptions.appendSystemPrompt ?? "");
  const actualContextFilesDigest = contextFilesDigest(snapshot.systemPromptOptions.contextFiles);
  const extensionIdentities = activeExtensionIdentities(snapshot);
  const skillIdentities = activeSkillIdentities(snapshot.systemPromptOptions);
  const toolNames = [...snapshot.activeToolNames].sort();
  const actualExtensionsDigest = listDigest("minime-pi-extensions-v1", extensionIdentities);
  const actualSkillsDigest = listDigest("minime-pi-skills-v1", skillIdentities);
  const actualToolsDigest = listDigest("minime-pi-tools-v1", toolNames);
  const actualCapabilityDigest = sha256([
    "minime-ops-worker-capabilities-v1",
    actualExtensionsDigest,
    actualSkillsDigest,
    actualToolsDigest,
  ].join("\0"));
  const actualContextDigest = opsWorkerEffectiveContextDigest({
    customPromptHash,
    appendSystemPromptHash,
    contextFilesDigest: actualContextFilesDigest,
  });
  const actualSystemPromptHash = sha256(snapshot.systemPrompt);
  const mismatch: OpsWorkerParityMismatch[] = [];
  if (customPromptHash !== expected.customPromptHash) mismatch.push("CUSTOM_PROMPT");
  if (appendSystemPromptHash !== expected.appendSystemPromptHash) mismatch.push("APPEND_SYSTEM_PROMPT");
  if (actualContextFilesDigest !== expected.contextFilesDigest) mismatch.push("CONTEXT_FILES");
  if (
    snapshot.baselineSystemPrompt === null
    || snapshot.systemPrompt !== snapshot.baselineSystemPrompt
  ) mismatch.push("SYSTEM_PROMPT");
  if (actualExtensionsDigest !== expected.extensionsDigest) mismatch.push("EXTENSIONS");
  if (actualSkillsDigest !== expected.skillsDigest) mismatch.push("SKILLS");
  if (actualToolsDigest !== expected.toolsDigest) mismatch.push("TOOLS");
  return {
    version: OPS_WORKER_PARITY_PROTOCOL_VERSION,
    status: mismatch.length === 0 ? "PASS" : "MISMATCH",
    expectedDigest: expected.digest,
    primaryContextDigest: expected.primaryContextDigest,
    actualContextDigest,
    actualSystemPromptHash,
    actualCapabilityDigest,
    actualExtensionsDigest,
    actualSkillsDigest,
    actualToolsDigest,
    mismatch,
  };
}

export function parseOpsWorkerParityAttestationReport(
  value: unknown,
): OpsWorkerParityAttestationReport {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("parity report must be an object");
  }
  const obj = value as Record<string, unknown>;
  const expectedKeys = [
    "version",
    "status",
    "expectedDigest",
    "primaryContextDigest",
    "actualContextDigest",
    "actualSystemPromptHash",
    "actualCapabilityDigest",
    "actualExtensionsDigest",
    "actualSkillsDigest",
    "actualToolsDigest",
    "mismatch",
  ];
  if (
    Object.keys(obj).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(obj, key))
    || Object.keys(obj).some((key) => !expectedKeys.includes(key))
  ) throw new TypeError("parity report fields must match the fixed schema");
  if (obj.version !== OPS_WORKER_PARITY_PROTOCOL_VERSION) {
    throw new TypeError("parity report version is unsupported");
  }
  if (obj.status !== "PASS" && obj.status !== "MISMATCH") {
    throw new TypeError("parity report status is invalid");
  }
  const allowedMismatch: readonly OpsWorkerParityMismatch[] = [
    "CUSTOM_PROMPT",
    "APPEND_SYSTEM_PROMPT",
    "CONTEXT_FILES",
    "SYSTEM_PROMPT",
    "EXTENSIONS",
    "SKILLS",
    "TOOLS",
  ];
  if (!Array.isArray(obj.mismatch) || obj.mismatch.length > allowedMismatch.length) {
    throw new TypeError("parity report mismatch is invalid");
  }
  const mismatch = obj.mismatch.map((entry) => {
    if (!allowedMismatch.includes(entry as OpsWorkerParityMismatch)) {
      throw new TypeError("parity report contains an unknown mismatch code");
    }
    return entry as OpsWorkerParityMismatch;
  });
  if (new Set(mismatch).size !== mismatch.length) {
    throw new TypeError("parity report mismatch contains duplicates");
  }
  if ((obj.status === "PASS") !== (mismatch.length === 0)) {
    throw new TypeError("parity report status contradicts mismatch evidence");
  }
  const actualExtensionsDigest = requireSha256(
    obj.actualExtensionsDigest,
    "parity report actualExtensionsDigest",
  );
  const actualSkillsDigest = requireSha256(
    obj.actualSkillsDigest,
    "parity report actualSkillsDigest",
  );
  const actualToolsDigest = requireSha256(
    obj.actualToolsDigest,
    "parity report actualToolsDigest",
  );
  const actualCapabilityDigest = requireSha256(
    obj.actualCapabilityDigest,
    "parity report actualCapabilityDigest",
  );
  const recomputedCapabilityDigest = sha256([
    "minime-ops-worker-capabilities-v1",
    actualExtensionsDigest,
    actualSkillsDigest,
    actualToolsDigest,
  ].join("\0"));
  if (actualCapabilityDigest !== recomputedCapabilityDigest) {
    throw new TypeError("parity report capability digests are inconsistent");
  }
  return {
    version: OPS_WORKER_PARITY_PROTOCOL_VERSION,
    status: obj.status,
    expectedDigest: requireSha256(obj.expectedDigest, "parity report expectedDigest"),
    primaryContextDigest: requireSha256(obj.primaryContextDigest, "parity report primaryContextDigest"),
    actualContextDigest: requireSha256(obj.actualContextDigest, "parity report actualContextDigest"),
    actualSystemPromptHash: requireSha256(
      obj.actualSystemPromptHash,
      "parity report actualSystemPromptHash",
    ),
    actualCapabilityDigest,
    actualExtensionsDigest,
    actualSkillsDigest,
    actualToolsDigest,
    mismatch,
  };
}

function assertPrivateRegularPath(path: string, label: string): void {
  if (!isAbsolute(path)) throw new TypeError(`${label} must be absolute`);
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) {
    throw new TypeError(`${label} parent must be a non-symlink directory`);
  }
  if (typeof process.getuid === "function" && parent.uid !== process.getuid()) {
    throw new TypeError(`${label} parent must be owned by the current user`);
  }
}

export function readExpectedOpsWorkerParityContract(path: string): OpsWorkerExpectedParityContract {
  assertPrivateRegularPath(path, "parity expected path");
  const direct = lstatSync(path);
  if (!direct.isFile() || direct.isSymbolicLink() || direct.size > MAX_CONTRACT_BYTES) {
    throw new TypeError("parity expected file must be a bounded regular file");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(descriptor).isFile()) throw new TypeError("parity expected file changed during read");
    return parseExpectedOpsWorkerParityContract(JSON.parse(readFileSync(descriptor, "utf8")));
  } finally {
    closeSync(descriptor);
  }
}

export function writeOpsWorkerParityReport(
  path: string,
  report: OpsWorkerParityAttestationReport,
): void {
  assertPrivateRegularPath(path, "parity report path");
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new TypeError("parity report path is unsafe");
    }
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const staging = `${path}.tmp.${process.pid}.${randomBytes(6).toString("hex")}`;
  writeFileSync(staging, `${JSON.stringify(report)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(staging, path);
}

export async function waitForOpsWorkerParityAck(
  path: string,
  expectedDigest: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 256) return false;
      return readFileSync(path, "utf8").trim() === expectedDigest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  } while (Date.now() < deadline);
  return false;
}
