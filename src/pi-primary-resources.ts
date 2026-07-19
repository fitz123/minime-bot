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
import ts from "typescript";
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
export const PI_EXTENSION_JITI_EXTENSIONS = [
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mtsx",
  ".ctsx",
] as const;

const UNSAFE_MODULE_LOADER_IDENTIFIERS = new Set([
  "Function",
  "createRequire",
  "eval",
  "getBuiltinModule",
  "mainModule",
  "require",
]);
const UNSAFE_MODULE_LOADER_PROPERTIES = new Set([
  "Function",
  "_load",
  "createRequire",
  "eval",
  "getBuiltinModule",
  "mainModule",
  "require",
]);
const UNSAFE_MODULE_LOADER_SPECIFIERS = new Set([
  "module",
  "node:module",
  "node:vm",
  "vm",
]);

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

function localModuleSpecifiers(path: string, content: Buffer): string[] {
  const source = ts.createSourceFile(
    path,
    content.toString("utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const parseDiagnostics = (
    source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }
  ).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    throw new TypeError("Pi extension source must parse before its dependency closure is hashed");
  }
  const specifiers = new Set<string>();
  const add = (value: ts.Expression | undefined): void => {
    if (
      value === undefined
      || (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value))
    ) {
      throw new TypeError(
        "Pi extension module loading must use a statically analyzable string literal",
      );
    }
    if (UNSAFE_MODULE_LOADER_SPECIFIERS.has(value.text)) {
      throw new TypeError("Pi extension runtime module loaders cannot be attested safely");
    }
    if (isAbsolute(value.text) || value.text.startsWith("file:")) {
      throw new TypeError("Pi extension absolute module loading cannot be attested safely");
    }
    if (value.text.startsWith("./") || value.text.startsWith("../")) {
      specifiers.add(value.text);
    }
  };
  const literalProperty = (node: ts.Expression): string | undefined => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    return undefined;
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node)
      && UNSAFE_MODULE_LOADER_IDENTIFIERS.has(node.text)
    ) {
      throw new TypeError("Pi extension runtime module loaders cannot be attested safely");
    }
    if (
      ts.isIdentifier(node)
      && node.text === "module"
      && !(
        ts.isPropertyAccessExpression(node.parent)
        && node.parent.expression === node
        && node.parent.name.text === "exports"
      )
      && !(
        ts.isElementAccessExpression(node.parent)
        && node.parent.expression === node
        && literalProperty(node.parent.argumentExpression) === "exports"
      )
    ) {
      throw new TypeError("Pi extension indirect module loading cannot be attested safely");
    }
    if (
      ts.isPropertyAccessExpression(node)
      && UNSAFE_MODULE_LOADER_PROPERTIES.has(node.name.text)
    ) {
      throw new TypeError("Pi extension indirect module loading cannot be attested safely");
    }
    if (
      ts.isElementAccessExpression(node)
      && (
        UNSAFE_MODULE_LOADER_PROPERTIES.has(
          literalProperty(node.argumentExpression) ?? "",
        )
        || (
          ts.isIdentifier(node.expression)
          && (node.expression.text === "globalThis" || node.expression.text === "module")
        )
      )
    ) {
      throw new TypeError("Pi extension computed module loading cannot be attested safely");
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier !== undefined) add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      throw new TypeError("Pi extension runtime require loading cannot be attested safely");
    } else if (ts.isCallExpression(node)) {
      const directImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if (directImport) {
        throw new TypeError("Pi extension dynamic import loading cannot be attested safely");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...specifiers];
}

function resolveLocalModule(importer: string, specifier: string): string {
  const base = resolve(dirname(importer), specifier);
  if (existsSync(base)) {
    const direct = lstatSync(base);
    if (direct.isDirectory()) {
      throw new TypeError(
        "Pi extension directory module resolution is ambiguous and cannot be attested safely",
      );
    }
    return strictTrustedFile(base, "Pi extension dependency");
  }
  const extension = extname(base);
  if (extension !== "") {
    const sourceExtension = {
      ".cjs": ".cts",
      ".js": ".ts",
      ".jsx": ".tsx",
      ".mjs": ".mts",
    }[extension];
    if (sourceExtension !== undefined) {
      const sourceCandidate = `${base.slice(0, -extension.length)}${sourceExtension}`;
      if (existsSync(sourceCandidate)) {
        return strictTrustedFile(sourceCandidate, "Pi extension dependency");
      }
    }
  } else {
    for (const candidateExtension of PI_EXTENSION_JITI_EXTENSIONS) {
      const candidate = `${base}${candidateExtension}`;
      if (existsSync(candidate)) {
        return strictTrustedFile(candidate, "Pi extension dependency");
      }
    }
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
    for (const specifier of localModuleSpecifiers(path, content)) {
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
      `minime-pi-extension-identity-v4\0${JSON.stringify(PI_EXTENSION_JITI_EXTENSIONS)}\0${JSON.stringify(files)}`,
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

function buildPiPrimaryResourceContract(input: {
  extensionPaths: readonly string[];
  skillPaths: readonly string[];
  toolNames: readonly string[];
}): PiPrimaryResourceContract {
  const extensionPaths = requireUnique(input.extensionPaths.map((path, index) =>
    strictTrustedFile(path, `primary extension[${index}]`)), "Primary Pi extensions");
  if (extensionPaths.length === 0) {
    throw new TypeError("Primary Pi resources must include explicit extensions");
  }
  const skillPaths = requireUnique(input.skillPaths.map((path, index) => {
    const resolved = strictTrustedFile(path, `primary skill[${index}]`);
    if (!resolved.endsWith(".md")) {
      throw new TypeError(`primary skill[${index}] must be a direct markdown skill file`);
    }
    return resolved;
  }), "Primary Pi skills");
  const toolNames = requireUnique(input.toolNames.map((tool, index) => {
    if (typeof tool !== "string" || !TOOL_NAME_PATTERN.test(tool)) {
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
    digest: sha256([
      "minime-pi-primary-resources-v1",
      extensionsDigest,
      skillsDigest,
      toolsDigest,
    ].join("\0")),
  };
}

export function resolvePiPrimaryResourceContract(
  options: ResolvePiPrimaryResourceContractOptions,
): PiPrimaryResourceContract {
  const resolvedExtensionArgs = resolvePiSpawnExtensionArgs(options.extensionOptions);
  return buildPiPrimaryResourceContract({
    extensionPaths: extensionPathsFromArgs(resolvedExtensionArgs),
    skillPaths: options.skillPaths,
    toolNames: options.toolNames,
  });
}

export function validatePiPrimaryResourceContract(
  value: PiPrimaryResourceContract,
): PiPrimaryResourceContract {
  if (value.version !== PI_PRIMARY_RESOURCE_CONTRACT_VERSION) {
    throw new TypeError("Primary Pi resource contract version is unsupported");
  }
  const rebuilt = buildPiPrimaryResourceContract(value);
  if (
    JSON.stringify(value.extensionIdentities) !== JSON.stringify(rebuilt.extensionIdentities)
    || JSON.stringify(value.skillIdentities) !== JSON.stringify(rebuilt.skillIdentities)
    || value.extensionsDigest !== rebuilt.extensionsDigest
    || value.skillsDigest !== rebuilt.skillsDigest
    || value.toolsDigest !== rebuilt.toolsDigest
    || value.digest !== rebuilt.digest
  ) throw new TypeError("Primary Pi resource contract hashes are inconsistent");
  return rebuilt;
}

export function resolveOpsWorkerParityExtensionPath(): string {
  const baseDir = resolveWorkspaceContract().paths.piExtensionDir;
  const relpath = piExtensionRelpathForDir(baseDir, "ops-worker-parity-attestation.ts");
  return strictTrustedFile(resolve(baseDir, relpath), "ops-worker parity extension");
}
