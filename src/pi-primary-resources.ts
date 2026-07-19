import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, extname, isAbsolute, normalize, resolve } from "node:path";
import {
  piExtensionRelpathForDir,
  resolvePiSpawnExtensionArgs,
  type PiSpawnExtensionOptions,
} from "./pi-rpc-protocol.js";
import { resolveWorkspaceContract } from "./workspace-contract.js";

export const PI_PRIMARY_RESOURCE_CONTRACT_VERSION = 1 as const;

export const PI_BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
] as const;

const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_EXTENSION_RESOURCE_FILES = 2_048;
const MAX_EXTENSION_RESOURCE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EXTENSION_RESOURCE_TOTAL_BYTES = 64 * 1024 * 1024;
const MODULE_FILE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
] as const;

export interface PiExtensionResourceFile {
  /** Private canonical path used only inside the launch handshake. */
  path: string;
  contentHash: string;
}

export interface PiExtensionResourceSnapshot {
  identity: string;
  files: readonly PiExtensionResourceFile[];
}

export interface PiPrimaryResourceContract {
  version: typeof PI_PRIMARY_RESOURCE_CONTRACT_VERSION;
  /** Trusted absolute entrypoints used to build repeatable --extension args. */
  extensionPaths: readonly string[];
  /** Trusted direct skill files used to build repeatable --skill args. */
  skillPaths: readonly string[];
  /** The primary session's complete selected built-in and extension tool surface. */
  toolNames: readonly string[];
  extensionIdentities: readonly string[];
  skillIdentities: readonly string[];
  extensionsDigest: string;
  skillsDigest: string;
  toolsDigest: string;
  digest: string;
}

export interface ResolvePiPrimaryResourceContractOptions {
  extensionOptions?: PiSpawnExtensionOptions;
  skillPaths: readonly string[];
  toolNames: readonly string[];
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalListDigest(domain: string, values: readonly string[]): string {
  return sha256(`${domain}\0${JSON.stringify([...values].sort())}`);
}

function readTrustedFile(path: string): Buffer {
  const direct = lstatSync(path);
  if (
    !direct.isFile()
    || direct.isSymbolicLink()
    || (typeof process.getuid === "function" && direct.uid !== process.getuid())
  ) throw new TypeError("Pi resource must remain a current-user-owned regular file");
  if (direct.size > MAX_EXTENSION_RESOURCE_FILE_BYTES) {
    throw new TypeError("Pi extension resource file exceeds the bounded size limit");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile()
      || opened.dev !== direct.dev
      || opened.ino !== direct.ino
    ) throw new TypeError("Pi resource changed before its content could be hashed");
    const content = readFileSync(descriptor);
    const completed = fstatSync(descriptor);
    if (
      completed.dev !== opened.dev
      || completed.ino !== opened.ino
      || completed.size !== opened.size
      || completed.mtimeMs !== opened.mtimeMs
      || completed.ctimeMs !== opened.ctimeMs
    ) throw new TypeError("Pi resource changed while its content was being hashed");
    return content;
  } finally {
    closeSync(descriptor);
  }
}

function trustedFileContentHash(path: string): string {
  return sha256(readTrustedFile(path));
}

function localModuleSpecifiers(content: Buffer): string[] {
  const source = content.toString("utf8");
  const specifiers = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?[^;]*?\s+from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

function moduleCandidates(importer: string, specifier: string): string[] {
  const base = resolve(dirname(importer), specifier);
  const extension = extname(base);
  const candidates = new Set<string>();
  if (extension !== "") {
    candidates.add(base);
    const sourceExtension = extension === ".js"
      ? [".ts", ".tsx"]
      : extension === ".mjs"
      ? [".mts", ".ts"]
      : extension === ".cjs"
      ? [".cts", ".ts"]
      : [];
    for (const replacement of sourceExtension) {
      candidates.add(`${base.slice(0, -extension.length)}${replacement}`);
    }
  } else {
    candidates.add(base);
    for (const candidateExtension of MODULE_FILE_EXTENSIONS) {
      candidates.add(`${base}${candidateExtension}`);
      candidates.add(resolve(base, `index${candidateExtension}`));
    }
  }
  return [...candidates];
}

function resolveLocalModule(importer: string, specifier: string): string {
  for (const candidate of moduleCandidates(importer, specifier)) {
    if (!existsSync(candidate)) continue;
    const direct = lstatSync(candidate);
    if (direct.isDirectory()) continue;
    return strictTrustedFile(candidate, "Pi extension dependency");
  }
  throw new TypeError("Pi extension contains an unresolved local module dependency");
}

function extensionResourceFiles(entryPath: string): PiExtensionResourceFile[] {
  const pending = [strictTrustedFile(entryPath, "Pi extension resource")];
  const seen = new Set<string>();
  const files: PiExtensionResourceFile[] = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    if (seen.size > MAX_EXTENSION_RESOURCE_FILES) {
      throw new TypeError("Pi extension dependency closure exceeds the bounded file limit");
    }
    const content = readTrustedFile(path);
    totalBytes += content.length;
    if (totalBytes > MAX_EXTENSION_RESOURCE_TOTAL_BYTES) {
      throw new TypeError("Pi extension dependency closure exceeds the bounded byte limit");
    }
    files.push({ path, contentHash: sha256(content) });
    if (extname(path) === ".json") continue;
    for (const specifier of localModuleSpecifiers(content)) {
      const dependency = resolveLocalModule(path, specifier);
      if (!seen.has(dependency)) pending.push(dependency);
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function createPiExtensionResourceSnapshot(path: string): PiExtensionResourceSnapshot {
  const files = extensionResourceFiles(path);
  return {
    files,
    identity: sha256(
      `minime-pi-extension-identity-v3\0${JSON.stringify(files)}`,
    ),
  };
}

/** Stable one-way identity: private path and content bytes are never persisted or reported. */
export function piResourceIdentity(kind: "extension" | "skill", path: string): string {
  const trustedPath = strictTrustedFile(path, `Pi ${kind} resource`);
  if (kind === "extension") {
    return createPiExtensionResourceSnapshot(trustedPath).identity;
  }
  return sha256([
    "minime-pi-skill-identity-v2",
    trustedPath,
    trustedFileContentHash(trustedPath),
  ].join("\0"));
}

function strictTrustedFile(path: string, label: string): string {
  if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path)) {
    throw new TypeError(`${label} must be a non-empty absolute file path`);
  }
  const normalized = normalize(resolve(path));
  const direct = lstatSync(normalized);
  if (!direct.isFile() || direct.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular non-symlink file`);
  }
  const real = normalize(realpathSync(normalized));
  if (!statSync(real).isFile()) throw new TypeError(`${label} must resolve to a regular file`);
  if (typeof process.getuid === "function" && direct.uid !== process.getuid()) {
    throw new TypeError(`${label} must be owned by the current user`);
  }
  return real;
}

function extensionPathsFromArgs(args: readonly string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] !== "--extension" || typeof args[index + 1] !== "string") {
      throw new TypeError("Primary Pi extension resolver returned malformed arguments");
    }
    paths.push(args[index + 1]);
  }
  return paths;
}

function requireUnique(values: readonly string[], label: string): string[] {
  const result = [...values];
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} must not contain duplicate identities`);
  }
  return result;
}

export function resolvePiPrimaryResourceContract(
  options: ResolvePiPrimaryResourceContractOptions,
): PiPrimaryResourceContract {
  const resolvedExtensionArgs = resolvePiSpawnExtensionArgs(options.extensionOptions);
  const extensionPaths = extensionPathsFromArgs(resolvedExtensionArgs)
    .map((path, index) => strictTrustedFile(path, `primary extension[${index}]`));
  if (extensionPaths.length === 0) {
    throw new TypeError("Primary Pi resources must include the explicit first-party extensions");
  }
  const uniqueExtensionPaths = requireUnique(extensionPaths, "Primary Pi extensions");

  const skillPaths = options.skillPaths.map((path, index) => {
    const resolved = strictTrustedFile(path, `primary skill[${index}]`);
    if (!resolved.endsWith(".md")) {
      throw new TypeError(`primary skill[${index}] must be a direct markdown skill file`);
    }
    return resolved;
  });
  const uniqueSkillPaths = requireUnique(skillPaths, "Primary Pi skills");

  const tools = options.toolNames.map((tool, index) => {
    if (typeof tool !== "string" || !TOOL_NAME_PATTERN.test(tool)) {
      throw new TypeError(`primary tool[${index}] has an invalid name`);
    }
    return tool;
  });
  const toolNames = requireUnique(tools, "Primary Pi tools");
  for (const builtIn of PI_BUILTIN_TOOL_NAMES) {
    if (!toolNames.includes(builtIn)) {
      throw new TypeError(`Primary Pi tools are incomplete: missing built-in ${builtIn}`);
    }
  }

  const extensionIdentities = uniqueExtensionPaths.map((path) =>
    piResourceIdentity("extension", path));
  const skillIdentities = uniqueSkillPaths.map((path) =>
    piResourceIdentity("skill", path));
  const extensionsDigest = canonicalListDigest("minime-pi-extensions-v1", extensionIdentities);
  const skillsDigest = canonicalListDigest("minime-pi-skills-v1", skillIdentities);
  const toolsDigest = canonicalListDigest("minime-pi-tools-v1", toolNames);
  return {
    version: PI_PRIMARY_RESOURCE_CONTRACT_VERSION,
    extensionPaths: uniqueExtensionPaths,
    skillPaths: uniqueSkillPaths,
    toolNames,
    extensionIdentities,
    skillIdentities,
    extensionsDigest,
    skillsDigest,
    toolsDigest,
    digest: sha256([
      "minime-pi-primary-resources-v1",
      extensionsDigest,
      skillsDigest,
      toolsDigest,
    ].join("\0")),
  };
}

export function validatePiPrimaryResourceContract(
  value: PiPrimaryResourceContract,
): PiPrimaryResourceContract {
  if (value.version !== PI_PRIMARY_RESOURCE_CONTRACT_VERSION) {
    throw new TypeError("Primary Pi resource contract version is unsupported");
  }
  const extensionPaths = requireUnique(value.extensionPaths.map((path, index) =>
    strictTrustedFile(path, `primary extension[${index}]`)), "Primary Pi extensions");
  if (extensionPaths.length === 0) {
    throw new TypeError("Primary Pi resources must include explicit extensions");
  }
  const skillPaths = requireUnique(value.skillPaths.map((path, index) => {
    const resolved = strictTrustedFile(path, `primary skill[${index}]`);
    if (!resolved.endsWith(".md")) {
      throw new TypeError(`primary skill[${index}] must be a direct markdown skill file`);
    }
    return resolved;
  }), "Primary Pi skills");
  const toolNames = requireUnique(value.toolNames.map((tool, index) => {
    if (!TOOL_NAME_PATTERN.test(tool)) {
      throw new TypeError(`primary tool[${index}] has an invalid name`);
    }
    return tool;
  }), "Primary Pi tools");
  for (const builtIn of PI_BUILTIN_TOOL_NAMES) {
    if (!toolNames.includes(builtIn)) {
      throw new TypeError(`Primary Pi tools are incomplete: missing built-in ${builtIn}`);
    }
  }
  const extensionIdentities = extensionPaths.map((path) => piResourceIdentity("extension", path));
  const skillIdentities = skillPaths.map((path) => piResourceIdentity("skill", path));
  const extensionsDigest = canonicalListDigest("minime-pi-extensions-v1", extensionIdentities);
  const skillsDigest = canonicalListDigest("minime-pi-skills-v1", skillIdentities);
  const toolsDigest = canonicalListDigest("minime-pi-tools-v1", toolNames);
  const digest = sha256([
    "minime-pi-primary-resources-v1",
    extensionsDigest,
    skillsDigest,
    toolsDigest,
  ].join("\0"));
  if (
    JSON.stringify(value.extensionIdentities) !== JSON.stringify(extensionIdentities)
    || JSON.stringify(value.skillIdentities) !== JSON.stringify(skillIdentities)
    || value.extensionsDigest !== extensionsDigest
    || value.skillsDigest !== skillsDigest
    || value.toolsDigest !== toolsDigest
    || value.digest !== digest
  ) throw new TypeError("Primary Pi resource contract hashes are inconsistent");
  return {
    version: PI_PRIMARY_RESOURCE_CONTRACT_VERSION,
    extensionPaths,
    skillPaths,
    toolNames,
    extensionIdentities,
    skillIdentities,
    extensionsDigest,
    skillsDigest,
    toolsDigest,
    digest,
  };
}

export function resolveOpsWorkerParityExtensionPath(): string {
  const baseDir = resolveWorkspaceContract().paths.piExtensionDir;
  const relpath = piExtensionRelpathForDir(baseDir, "ops-worker-parity-attestation.ts");
  return strictTrustedFile(resolve(baseDir, relpath), "ops-worker parity extension");
}
