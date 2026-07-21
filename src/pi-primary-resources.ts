import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";
import { assertOpsWorkerParityContractRepresentable } from "./pi-parity-contract-limits.js";
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
const MAX_RESOURCE_DIRECTORIES = 2_048;
const SKILL_GENERATED_DIRECTORY_NAMES = new Set([
  ".venv",
  ".pytest_cache",
  "__pycache__",
]);
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
  "Proxy",
  "Reflect",
  "WebAssembly",
  "createRequire",
  "eval",
  "getBuiltinModule",
  "global",
  "globalThis",
  "jitiESMResolve",
  "jitiImport",
  "mainModule",
  "require",
  "self",
]);
const UNSAFE_MODULE_LOADER_PROPERTIES = new Set([
  "Function",
  "__proto__",
  "_load",
  "constructor",
  "createRequire",
  "eval",
  "getBuiltinModule",
  "mainModule",
  "prototype",
  "require",
]);
const SAFE_PROCESS_PROPERTIES = new Set([
  "argv",
  "cwd",
  "env",
  "execPath",
  "exit",
  "getuid",
  "pid",
]);
/**
 * Bare modules are executable code outside the local closure. Keep this list
 * fixed to the primary package contract instead of letting an extension select
 * a second transpiler, VM, or module loader whose eventual bytes cannot be
 * fenced before launch.
 */
const SAFE_EXTENSION_MODULE_SPECIFIERS = new Set([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-ai/compat",
  "@earendil-works/pi-ai/oauth",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-ai/compat",
  "@mariozechner/pi-ai/oauth",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:os",
  "node:path",
  "node:stream",
  "node:string_decoder",
  "node:url",
  "node:vm",
  "acorn",
  "typebox",
  "typebox/compile",
  "typebox/value",
  "typescript",
  "yaml",
]);

export interface PiExtensionResourceFile {
  /** Private canonical path used only inside the launch handshake. */
  path: string;
  contentHash: string;
  executable: boolean;
}

export interface PiExtensionResourceSnapshot {
  identity: string;
  files: readonly PiExtensionResourceFile[];
}

export type PiSkillResourceFile = PiExtensionResourceFile;

export interface PiSkillResourceSnapshot {
  identity: string;
  rootPath: string;
  skillPath: string;
  files: readonly PiSkillResourceFile[];
}

export interface PiPrimaryResourceContract {
  version: typeof PI_PRIMARY_RESOURCE_CONTRACT_VERSION;
  /** Trusted absolute entrypoints used to build repeatable --extension args. */
  extensionPaths: readonly string[];
  /** Trusted additional regular-file resources, parallel to extensionPaths. */
  extensionResourcePaths: readonly (readonly string[])[];
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
  /**
   * Explicit resource manifests for configured extra extensions, parallel to
   * extensionOptions.extraExtensions. An empty manifest is an explicit claim
   * that the extra has no non-module runtime resources.
   */
  extraExtensionResourcePaths?: readonly (readonly string[])[];
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
    throw new TypeError("Pi resource file exceeds the bounded size limit");
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

interface PiExtensionModuleSpecifiers {
  local: string[];
  declaredPackages: string[];
}

interface StaticBindingAnalysis {
  bindingCount(name: string): number;
  hasOpaqueComputedPropertyBinding(value: ts.Expression): boolean;
  staticString(value: ts.Expression, resolving?: Set<string>): string | undefined;
  staticStrings(value: ts.Expression): ReadonlySet<string>;
  uniqueConstantInitializer(name: string): ts.Expression | undefined;
}

interface StaticBindingWrite {
  kind: "append" | "value";
  value: ts.Expression;
}

function referencesJitiWrapperArguments(node: ts.Identifier): boolean {
  if (node.text !== "arguments") return false;
  const parent = node.parent as ts.Node & { name?: ts.Node };
  if (parent.name === node && !ts.isShorthandPropertyAssignment(parent)) return false;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) && !ts.isArrowFunction(current)) return false;
  }
  return true;
}

function createStaticBindingAnalysis(source: ts.SourceFile): StaticBindingAnalysis {
  const bindingCounts = new Map<string, number>();
  const constantInitializers = new Map<string, ts.Expression | null>();
  const bindingWrites = new Map<string, StaticBindingWrite[]>();
  const opaqueComputedPropertyBindings = new Set<string>();
  const recordBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      bindingCounts.set(name.text, (bindingCounts.get(name.text) ?? 0) + 1);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) recordBindingName(element.name);
    }
  };
  const recordOpaqueBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      opaqueComputedPropertyBindings.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) recordOpaqueBindingName(element.name);
    }
  };
  const recordOpaqueAssignmentTarget = (target: ts.Expression): void => {
    if (
      ts.isParenthesizedExpression(target)
      || ts.isAsExpression(target)
      || ts.isSatisfiesExpression(target)
      || ts.isNonNullExpression(target)
    ) {
      recordOpaqueAssignmentTarget(target.expression);
      return;
    }
    if (ts.isIdentifier(target)) {
      opaqueComputedPropertyBindings.add(target.text);
      return;
    }
    if (ts.isArrayLiteralExpression(target)) {
      for (const element of target.elements) {
        if (ts.isOmittedExpression(element)) continue;
        recordOpaqueAssignmentTarget(
          ts.isSpreadElement(element) ? element.expression : element,
        );
      }
      return;
    }
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          opaqueComputedPropertyBindings.add(property.name.text);
        } else if (ts.isPropertyAssignment(property)) {
          recordOpaqueAssignmentTarget(property.initializer);
        } else if (ts.isSpreadAssignment(property)) {
          recordOpaqueAssignmentTarget(property.expression);
        }
      }
      return;
    }
    if (
      ts.isBinaryExpression(target)
      && target.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      recordOpaqueAssignmentTarget(target.left);
    }
  };
  const recordBindingWrite = (
    name: string,
    value: ts.Expression,
    kind: StaticBindingWrite["kind"] = "value",
  ): void => {
    const writes = bindingWrites.get(name) ?? [];
    writes.push({ kind, value });
    bindingWrites.set(name, writes);
  };
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      recordBindingName(node.name);
      if (!ts.isIdentifier(node.name)) recordOpaqueBindingName(node.name);
    } else if (
      (ts.isFunctionDeclaration(node)
        || ts.isFunctionExpression(node)
        || ts.isClassDeclaration(node)
        || ts.isClassExpression(node)
        || ts.isEnumDeclaration(node))
      && node.name !== undefined
    ) {
      recordBindingName(node.name);
    } else if (ts.isImportClause(node) && node.name !== undefined) {
      recordBindingName(node.name);
    } else if (
      ts.isImportSpecifier(node)
      || ts.isNamespaceImport(node)
      || ts.isImportEqualsDeclaration(node)
    ) {
      recordBindingName(node.name);
    }
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.initializer !== undefined
    ) {
      recordBindingWrite(node.name.text, node.initializer);
      if (
        ts.isVariableDeclarationList(node.parent)
        && (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        constantInitializers.set(
          node.name.text,
          constantInitializers.has(node.name.text) ? null : node.initializer,
        );
      }
    } else if (
      ts.isBinaryExpression(node)
      && ts.isIdentifier(node.left)
      && (
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.BarBarEqualsToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionEqualsToken
      )
    ) {
      recordBindingWrite(
        node.left.text,
        node.right,
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken ? "append" : "value",
      );
    } else if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (
        ts.isArrayLiteralExpression(node.left)
        || ts.isObjectLiteralExpression(node.left)
      )
    ) {
      recordOpaqueAssignmentTarget(node.left);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(source);
  const uniqueConstantInitializer = (name: string): ts.Expression | undefined => {
    if (bindingCounts.get(name) !== 1) return undefined;
    return constantInitializers.get(name) ?? undefined;
  };
  const staticString = (
    value: ts.Expression,
    resolving = new Set<string>(),
  ): string | undefined => {
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) {
      return value.text;
    }
    if (
      ts.isParenthesizedExpression(value)
      || ts.isAsExpression(value)
      || ts.isSatisfiesExpression(value)
      || ts.isNonNullExpression(value)
    ) return staticString(value.expression, resolving);
    if (
      ts.isBinaryExpression(value)
      && value.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = staticString(value.left, resolving);
      const right = staticString(value.right, resolving);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isIdentifier(value) && !resolving.has(value.text)) {
      const initializer = uniqueConstantInitializer(value.text);
      if (initializer !== undefined) {
        const next = new Set(resolving);
        next.add(value.text);
        return staticString(initializer, next);
      }
    }
    return undefined;
  };
  const staticStrings = (value: ts.Expression): ReadonlySet<string> => {
    const values = new Set<string>();
    const direct = staticString(value);
    if (direct !== undefined) values.add(direct);
    if (ts.isIdentifier(value)) {
      const possibleValues = new Set<string>();
      for (const write of bindingWrites.get(value.text) ?? []) {
        const resolved = staticString(write.value, new Set([value.text]));
        if (resolved === undefined) continue;
        if (write.kind === "append") {
          for (const previous of [...possibleValues]) {
            const appended = previous + resolved;
            possibleValues.add(appended);
            values.add(appended);
          }
        } else {
          possibleValues.add(resolved);
          values.add(resolved);
        }
      }
    }
    return values;
  };
  return {
    bindingCount: (name) => bindingCounts.get(name) ?? 0,
    hasOpaqueComputedPropertyBinding: (value) => {
      let current = value;
      while (
        ts.isParenthesizedExpression(current)
        || ts.isAsExpression(current)
        || ts.isSatisfiesExpression(current)
        || ts.isNonNullExpression(current)
      ) current = current.expression;
      return ts.isIdentifier(current) && opaqueComputedPropertyBindings.has(current.text);
    },
    staticString,
    staticStrings,
    uniqueConstantInitializer,
  };
}

function extensionModuleSpecifiers(
  path: string,
  content: Buffer,
): PiExtensionModuleSpecifiers {
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
  const declaredPackages = new Set<string>();
  const vmBindings = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement)
      || !ts.isStringLiteral(statement.moduleSpecifier)
      || statement.moduleSpecifier.text !== "node:vm"
    ) continue;
    const clause = statement.importClause;
    if (
      clause === undefined
      || clause.isTypeOnly
      || clause.name === undefined
      || clause.namedBindings !== undefined
      || vmBindings.size > 0
    ) {
      throw new TypeError(
        "Pi extension node:vm loading cannot be attested safely without one default binding with bounded direct usage",
      );
    }
    vmBindings.add(clause.name.text);
  }
  const {
    bindingCount,
    hasOpaqueComputedPropertyBinding,
    staticString,
    staticStrings,
    uniqueConstantInitializer,
  } = createStaticBindingAnalysis(source);
  const add = (value: ts.Expression | undefined): void => {
    if (
      value === undefined
      || (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value))
    ) {
      throw new TypeError(
        "Pi extension module loading must use a statically analyzable string literal",
      );
    }
    if (isAbsolute(value.text) || value.text.startsWith("file:")) {
      throw new TypeError("Pi extension absolute module loading cannot be attested safely");
    }
    if (value.text.startsWith("./") || value.text.startsWith("../")) {
      specifiers.add(value.text);
      return;
    }
    if (!SAFE_EXTENSION_MODULE_SPECIFIERS.has(value.text)) {
      throw new TypeError(
        `Pi extension external module ${JSON.stringify(value.text)} is outside the fixed attested allowlist and cannot be attested safely`,
      );
    }
    if (value.text === "acorn") declaredPackages.add(value.text);
  };
  const literalProperty = (node: ts.Expression): string | undefined => {
    return staticString(node);
  };
  const objectPropertyName = (node: ts.PropertyName): string | undefined => {
    if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
      return node.text;
    }
    return undefined;
  };
  const unwrapExpression = (node: ts.Expression): ts.Expression => {
    let current = node;
    while (
      ts.isParenthesizedExpression(current)
      || ts.isAsExpression(current)
      || ts.isSatisfiesExpression(current)
      || ts.isNonNullExpression(current)
    ) current = current.expression;
    return current;
  };
  const directVmCreateContextCall = (node: ts.Expression): boolean => {
    const expression = unwrapExpression(node);
    if (
      !ts.isCallExpression(expression)
      || expression.questionDotToken !== undefined
      || expression.arguments.length !== 1
      || expression.arguments.some((argument) => ts.isSpreadElement(argument))
      || !ts.isPropertyAccessExpression(expression.expression)
      || expression.expression.questionDotToken !== undefined
      || expression.expression.name.text !== "createContext"
      || !ts.isIdentifier(expression.expression.expression)
    ) return false;
    const binding = expression.expression.expression.text;
    return vmBindings.has(binding) && bindingCount(binding) === 1;
  };
  const assertSafeVmScriptExecution = (invocation: ts.NewExpression): void => {
    let expression: ts.Expression = invocation;
    while (
      ts.isParenthesizedExpression(expression.parent)
      && expression.parent.expression === expression
    ) expression = expression.parent;
    const access = expression.parent;
    const execution = access?.parent;
    if (
      !ts.isPropertyAccessExpression(access)
      || access.expression !== expression
      || access.questionDotToken !== undefined
      || access.name.text !== "runInContext"
      || !ts.isCallExpression(execution)
      || execution.expression !== access
      || execution.questionDotToken !== undefined
      || execution.arguments.length !== 1
      || execution.arguments.some((argument) => ts.isSpreadElement(argument))
    ) {
      throw new TypeError(
        "Pi extension node:vm Script execution outside a direct attested context cannot be attested safely",
      );
    }
    const context = unwrapExpression(execution.arguments[0]);
    const initializer = ts.isIdentifier(context)
      ? uniqueConstantInitializer(context.text)
      : undefined;
    if (
      initializer === undefined
      || !directVmCreateContextCall(initializer)
    ) {
      throw new TypeError(
        "Pi extension node:vm Script context cannot be attested safely",
      );
    }
  };
  const assertSafeVmBindingUsage = (node: ts.Identifier): void => {
    const parent = node.parent;
    if (ts.isImportClause(parent) && parent.name === node) return;
    if (
      !ts.isPropertyAccessExpression(parent)
      || parent.expression !== node
      || parent.questionDotToken !== undefined
    ) {
      throw new TypeError(
        "Pi extension node:vm aliases and computed access cannot be attested safely",
      );
    }
    const operation = parent.name.text;
    const invocation = parent.parent;
    if (
      operation === "createContext"
      && ts.isCallExpression(invocation)
      && invocation.expression === parent
      && invocation.questionDotToken === undefined
    ) {
      if (!directVmCreateContextCall(invocation)) {
        throw new TypeError(
          "Pi extension node:vm context construction cannot be attested safely",
        );
      }
      return;
    }
    if (
      operation === "Script"
      && ts.isNewExpression(invocation)
      && invocation.expression === parent
    ) {
      const args = invocation.arguments ?? [];
      if (
        args.length < 1
        || args.length > 2
        || args.some((argument) => ts.isSpreadElement(argument))
      ) {
        throw new TypeError(
          "Pi extension node:vm Script options cannot be attested safely",
        );
      }
      const options = args[1];
      if (
        options !== undefined
        && (
          !ts.isObjectLiteralExpression(options)
          || options.properties.some((property) =>
            !ts.isPropertyAssignment(property)
            || objectPropertyName(property.name) !== "filename"
          )
        )
      ) {
        throw new TypeError(
          "Pi extension node:vm Script options cannot be attested safely",
        );
      }
      assertSafeVmScriptExecution(invocation);
      return;
    }
    throw new TypeError(
      "Pi extension node:vm usage outside the bounded workflow API cannot be attested safely",
    );
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isExportDeclaration(node)
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteral(node.moduleSpecifier)
      && node.moduleSpecifier.text === "node:vm"
    ) {
      throw new TypeError(
        "Pi extension node:vm re-exports cannot be attested safely",
      );
    }
    if (ts.isIdentifier(node) && vmBindings.has(node.text)) {
      assertSafeVmBindingUsage(node);
    }
    if (ts.isIdentifier(node) && node.text === "process") {
      const parent = node.parent;
      const inertPropertyName = ts.isPropertyAssignment(parent)
        && parent.name === node;
      const property = ts.isPropertyAccessExpression(parent) && parent.expression === node
        ? parent.name.text
        : ts.isElementAccessExpression(parent) && parent.expression === node
        ? literalProperty(parent.argumentExpression)
        : undefined;
      if (
        !inertPropertyName
        && (property === undefined || !SAFE_PROCESS_PROPERTIES.has(property))
      ) {
        throw new TypeError(
          "Pi extension process aliases and runtime loader access cannot be attested safely",
        );
      }
    }
    const safeGlobalNavigatorAccess = ts.isIdentifier(node)
      && node.text === "globalThis"
      && ts.isPropertyAccessExpression(node.parent)
      && node.parent.expression === node
      && node.parent.name.text === "navigator"
      && node.parent.questionDotToken === undefined;
    if (
      ts.isIdentifier(node)
      && (
        UNSAFE_MODULE_LOADER_IDENTIFIERS.has(node.text)
        || referencesJitiWrapperArguments(node)
      )
      && !safeGlobalNavigatorAccess
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
        hasOpaqueComputedPropertyBinding(node.argumentExpression)
        ||
        [...staticStrings(node.argumentExpression)].some((property) =>
          UNSAFE_MODULE_LOADER_PROPERTIES.has(property)
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
  return {
    local: [...specifiers],
    declaredPackages: [...declaredPackages],
  };
}

function assertDeclaredPackageEntrySelfContained(path: string, content: Buffer): void {
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
    throw new TypeError(
      "Pi extension declared package entry must parse before its bytes are attested",
    );
  }
  const {
    hasOpaqueComputedPropertyBinding,
    staticStrings,
  } = createStaticBindingAnalysis(source);
  const loaderIdentifiers = new Set([
    "Function",
    "Proxy",
    "Reflect",
    "WebAssembly",
    "createRequire",
    "eval",
    "getBuiltinModule",
    "global",
    "globalThis",
    "jitiESMResolve",
    "jitiImport",
    "mainModule",
    "module",
    "process",
    "require",
  ]);
  const loaderProperties = new Set([
    "_load",
    "constructor",
    "createRequire",
    "getBuiltinModule",
    "mainModule",
    "process",
    "require",
  ]);
  const reject = (): never => {
    throw new TypeError(
      "Pi extension declared package entry must be self-contained and cannot use runtime module loaders",
    );
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
    ) reject();
    if (
      ts.isImportEqualsDeclaration(node)
      || (
        ts.isCallExpression(node)
        && node.expression.kind === ts.SyntaxKind.ImportKeyword
      )
    ) reject();
    if (
      ts.isIdentifier(node)
      && (
        loaderIdentifiers.has(node.text)
        || referencesJitiWrapperArguments(node)
      )
    ) reject();
    if (
      ts.isPropertyAccessExpression(node)
      && loaderProperties.has(node.name.text)
    ) reject();
    if (
      ts.isElementAccessExpression(node)
      && (
        hasOpaqueComputedPropertyBinding(node.argumentExpression)
        || [...staticStrings(node.argumentExpression)].some((property) =>
          loaderProperties.has(property)
        )
      )
    ) reject();
    ts.forEachChild(node, visit);
  };
  visit(source);
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

function isContainedPath(base: string, target: string): boolean {
  const child = relative(base, target);
  return child === "" || !(
    child === ".."
    || child.startsWith(`..${sep}`)
    || isAbsolute(child)
  );
}

function strictTrustedDirectory(path: string, label: string): string {
  const normalized = normalize(resolve(path));
  const direct = lstatSync(normalized);
  if (!direct.isDirectory() || direct.isSymbolicLink()) {
    throw new TypeError(`${label} must be a regular non-symlink directory`);
  }
  if (typeof process.getuid === "function" && direct.uid !== process.getuid()) {
    throw new TypeError(`${label} must be owned by the current user`);
  }
  const real = normalize(realpathSync(normalized));
  if (real !== normalized || !statSync(real).isDirectory()) {
    throw new TypeError(`${label} must resolve without a symlink`);
  }
  return real;
}

function trustedDirectoryResourcePaths(
  rootPath: string,
  label: string,
  excludedEntryNames: ReadonlySet<string> = new Set(),
): Array<{ path: string; executable: boolean }> {
  const root = strictTrustedDirectory(rootPath, label);
  const pending = [root];
  const files: Array<{ path: string; executable: boolean }> = [];
  let directoryCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    directoryCount += 1;
    if (directoryCount > MAX_RESOURCE_DIRECTORIES) {
      throw new TypeError(`${label} exceeds the bounded directory limit`);
    }
    const entries = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (excludedEntryNames.has(entry.name)) continue;
      const path = join(directory, entry.name);
      const direct = lstatSync(path);
      if (direct.isSymbolicLink()) {
        throw new TypeError(`${label} must not contain symlinks`);
      }
      if (typeof process.getuid === "function" && direct.uid !== process.getuid()) {
        throw new TypeError(`${label} must remain current-user-owned`);
      }
      if (direct.isDirectory()) {
        const child = strictTrustedDirectory(path, label);
        if (!isContainedPath(root, child)) {
          throw new TypeError(`${label} escaped its trusted root`);
        }
        pending.push(child);
        continue;
      }
      if (!direct.isFile()) {
        throw new TypeError(`${label} must contain only regular files and directories`);
      }
      const file = strictTrustedFile(path, label);
      if (!isContainedPath(root, file)) {
        throw new TypeError(`${label} escaped its trusted root`);
      }
      files.push({ path: file, executable: (direct.mode & 0o111) !== 0 });
      if (files.length > MAX_EXTENSION_RESOURCE_FILES) {
        throw new TypeError(`${label} exceeds the bounded file limit`);
      }
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function packageOwnedExtensionResourcePaths(
  entryPath: string,
): Array<{ path: string; executable: boolean }> {
  if (
    basename(dirname(entryPath)) !== "subagent"
    || !/^index\.(?:[cm]?[jt]sx?)$/.test(basename(entryPath))
  ) return [];
  return ["agents", "prompts"].flatMap((directory) =>
    trustedDirectoryResourcePaths(
      join(dirname(entryPath), directory),
      `Pi subagent ${directory} resources`,
    ));
}

function declaredExtensionResourcePaths(
  paths: readonly string[],
): Array<{ path: string; executable: boolean }> {
  const resources: Array<{ path: string; executable: boolean }> = [];
  for (const [index, path] of paths.entries()) {
    if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path)) {
      throw new TypeError(
        `Pi extension resource manifest[${index}] must be a non-empty absolute path`,
      );
    }
    const normalized = normalize(resolve(path));
    const direct = lstatSync(normalized);
    if (direct.isSymbolicLink()) {
      throw new TypeError("Pi extension resource manifest must not contain symlinks");
    }
    if (!direct.isFile()) {
      throw new TypeError(
        "Pi extension resource manifest must contain only regular files",
      );
    }
    resources.push({
      path: strictTrustedFile(normalized, `Pi extension resource manifest[${index}]`),
      executable: (direct.mode & 0o111) !== 0,
    });
  }
  const unique = new Map(resources.map((resource) => [resource.path, resource]));
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
}

interface DeclaredPackageResourceCoverage {
  entryPath: string;
  metadataHash: string;
  metadataPath: string;
}

function assertDeclaredPackageResourceCoverage(
  importer: string,
  specifier: string,
  declaredResources: ReadonlySet<string>,
): DeclaredPackageResourceCoverage {
  let searchDirectory = dirname(importer);
  let metadataPath: string | undefined;
  for (;;) {
    const packageCandidate = join(searchDirectory, "node_modules", specifier);
    const metadataCandidate = join(packageCandidate, "package.json");
    const fileShadow = PI_EXTENSION_JITI_EXTENSIONS.some((extension) =>
      existsSync(`${packageCandidate}${extension}`));
    if (fileShadow) {
      throw new TypeError(
        `Pi extension ${specifier} package metadata cannot be resolved for attestation`,
      );
    }
    if (existsSync(metadataCandidate)) {
      const packageRoot = strictTrustedDirectory(
        packageCandidate,
        `Pi extension ${specifier} package root`,
      );
      metadataPath = strictTrustedFile(
        join(packageRoot, "package.json"),
        `Pi extension ${specifier} package metadata`,
      );
      break;
    }
    if (existsSync(packageCandidate)) {
      throw new TypeError(
        `Pi extension ${specifier} package metadata cannot be resolved for attestation`,
      );
    }
    const parent = dirname(searchDirectory);
    if (parent === searchDirectory) break;
    searchDirectory = parent;
  }
  if (metadataPath === undefined) {
    throw new TypeError(
      `Pi extension ${specifier} package metadata cannot be resolved for attestation`,
    );
  }
  let metadata: Record<string, unknown>;
  let metadataContent: Buffer;
  try {
    metadataContent = readTrustedFile(metadataPath);
    const parsed = JSON.parse(metadataContent.toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    metadata = parsed as Record<string, unknown>;
  } catch {
    throw new TypeError(`Pi extension ${specifier} package metadata is invalid`);
  }
  if (metadata.name !== specifier) {
    throw new TypeError(`Pi extension ${specifier} package metadata is invalid`);
  }
  const selectImportTarget = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      for (const candidate of value) {
        const selected = selectImportTarget(candidate);
        if (selected !== undefined) return selected;
      }
      return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    for (const [condition, candidate] of Object.entries(value)) {
      if (condition !== "node" && condition !== "import" && condition !== "default") continue;
      const selected = selectImportTarget(candidate);
      if (selected !== undefined) return selected;
    }
    return undefined;
  };
  const exportsRoot = typeof metadata.exports === "object"
    && metadata.exports !== null
    && !Array.isArray(metadata.exports)
    && Object.hasOwn(metadata.exports, ".")
    ? (metadata.exports as Record<string, unknown>)["."]
    : metadata.exports;
  const entryTarget = metadata.exports === undefined
    ? (typeof metadata.main === "string" ? metadata.main : "./index.js")
    : selectImportTarget(exportsRoot);
  if (entryTarget === undefined || !entryTarget.startsWith("./")) {
    throw new TypeError(`Pi extension ${specifier} package metadata is invalid`);
  }
  const packageRoot = dirname(metadataPath);
  const entryCandidate = normalize(resolve(packageRoot, entryTarget));
  const entryPath = strictTrustedFile(
    entryCandidate,
    `Pi extension ${specifier} package entry`,
  );
  if (
    entryPath !== entryCandidate
    || !isContainedPath(packageRoot, entryPath)
    || !declaredResources.has(metadataPath)
    || !declaredResources.has(entryPath)
  ) {
    throw new TypeError(
      `Pi extension resource manifest must cover the ${specifier} package metadata and runtime entry`,
    );
  }
  return {
    entryPath,
    metadataHash: sha256(metadataContent),
    metadataPath,
  };
}

function extensionResourceFiles(
  entryPath: string,
  declaredResourcePaths: readonly string[] = [],
): PiExtensionResourceFile[] {
  const trustedEntryPath = strictTrustedFile(entryPath, "Pi extension resource");
  const additionalResources = [
    ...packageOwnedExtensionResourcePaths(trustedEntryPath),
    ...declaredExtensionResourcePaths(declaredResourcePaths),
  ];
  const declaredResources = new Set(additionalResources.map((resource) => resource.path));
  const pending = [trustedEntryPath];
  const seen = new Set<string>();
  const declaredPackageEntries = new Set<string>();
  const declaredPackageMetadataHashes = new Map<string, string>();
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
    files.push({
      path,
      contentHash: sha256(content),
      executable: (lstatSync(path).mode & 0o111) !== 0,
    });
    if (extname(path) === ".json") continue;
    if (declaredPackageEntries.has(path)) {
      assertDeclaredPackageEntrySelfContained(path, content);
      continue;
    }
    const specifiers = extensionModuleSpecifiers(path, content);
    for (const specifier of specifiers.local) {
      const dependency = resolveLocalModule(path, specifier);
      if (!seen.has(dependency)) pending.push(dependency);
    }
    for (const specifier of specifiers.declaredPackages) {
      const coverage = assertDeclaredPackageResourceCoverage(
        path,
        specifier,
        declaredResources,
      );
      const expectedMetadataHash = declaredPackageMetadataHashes.get(coverage.metadataPath);
      if (
        expectedMetadataHash !== undefined
        && expectedMetadataHash !== coverage.metadataHash
      ) {
        throw new TypeError(
          `Pi extension ${specifier} package metadata changed before it could be captured`,
        );
      }
      declaredPackageMetadataHashes.set(coverage.metadataPath, coverage.metadataHash);
      const capturedMetadata = files.find((file) => file.path === coverage.metadataPath);
      if (
        capturedMetadata !== undefined
        && capturedMetadata.contentHash !== coverage.metadataHash
      ) {
        throw new TypeError(
          `Pi extension ${specifier} package metadata changed before it could be validated`,
        );
      }
      const dependency = coverage.entryPath;
      declaredPackageEntries.add(dependency);
      if (seen.has(dependency)) {
        const content = readTrustedFile(dependency);
        const captured = files.find((file) => file.path === dependency);
        if (captured?.contentHash !== sha256(content)) {
          throw new TypeError(
            `Pi extension ${specifier} package entry changed before it could be validated`,
          );
        }
        assertDeclaredPackageEntrySelfContained(dependency, content);
      } else {
        pending.push(dependency);
      }
    }
  }
  for (const resource of additionalResources) {
    if (seen.has(resource.path)) continue;
    seen.add(resource.path);
    if (seen.size > MAX_EXTENSION_RESOURCE_FILES) {
      throw new TypeError("Pi extension resource closure exceeds the bounded file limit");
    }
    const content = readTrustedFile(resource.path);
    const contentHash = sha256(content);
    const expectedMetadataHash = declaredPackageMetadataHashes.get(resource.path);
    if (
      expectedMetadataHash !== undefined
      && expectedMetadataHash !== contentHash
    ) {
      throw new TypeError(
        "Pi extension declared package metadata changed before it could be captured",
      );
    }
    totalBytes += content.length;
    if (totalBytes > MAX_EXTENSION_RESOURCE_TOTAL_BYTES) {
      throw new TypeError("Pi extension resource closure exceeds the bounded byte limit");
    }
    files.push({
      path: resource.path,
      contentHash,
      executable: resource.executable,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export function createPiExtensionResourceSnapshot(
  path: string,
  declaredResourcePaths: readonly string[] = [],
): PiExtensionResourceSnapshot {
  const entryPath = strictTrustedFile(path, "Pi extension resource");
  const files = extensionResourceFiles(entryPath, declaredResourcePaths);
  const entryIndex = files.findIndex((file) => file.path === entryPath);
  if (entryIndex < 0) {
    throw new TypeError("Pi extension entrypoint is absent from its resource closure");
  }
  return {
    files,
    identity: sha256(
      `minime-pi-extension-identity-v6\0${JSON.stringify(PI_EXTENSION_JITI_EXTENSIONS)}\0${entryIndex}\0${JSON.stringify(files)}`,
    ),
  };
}

export function createPiSkillResourceSnapshot(path: string): PiSkillResourceSnapshot {
  const skillPath = strictTrustedFile(path, "Pi skill resource");
  const rootPath = strictTrustedDirectory(dirname(skillPath), "Pi skill root");
  const resourcePaths = trustedDirectoryResourcePaths(
    rootPath,
    "Pi skill package",
    SKILL_GENERATED_DIRECTORY_NAMES,
  );
  const files: PiSkillResourceFile[] = [];
  let totalBytes = 0;
  for (const resource of resourcePaths) {
    const content = readTrustedFile(resource.path);
    totalBytes += content.length;
    if (totalBytes > MAX_EXTENSION_RESOURCE_TOTAL_BYTES) {
      throw new TypeError("Pi skill package exceeds the bounded byte limit");
    }
    files.push({
      path: resource.path,
      contentHash: sha256(content),
      executable: resource.executable,
    });
  }
  if (!files.some((file) => file.path === skillPath)) {
    throw new TypeError("Pi skill entrypoint is absent from its trusted package");
  }
  const identityFiles = files.map((file) => ({
    path: relative(rootPath, file.path).split(sep).join("/"),
    contentHash: file.contentHash,
    executable: file.executable,
  }));
  const skillEntrypoint = relative(rootPath, skillPath).split(sep).join("/");
  return {
    rootPath,
    skillPath,
    files,
    identity: sha256(
      `minime-pi-skill-identity-v5\0${skillEntrypoint}\0${JSON.stringify(identityFiles)}`,
    ),
  };
}

/** Stable one-way identity: private path and content bytes are never persisted or reported. */
export function piResourceIdentity(
  kind: "extension" | "skill",
  path: string,
  extensionResourcePaths: readonly string[] = [],
): string {
  const trustedPath = strictTrustedFile(path, `Pi ${kind} resource`);
  if (kind === "extension") {
    return createPiExtensionResourceSnapshot(trustedPath, extensionResourcePaths).identity;
  }
  if (extensionResourcePaths.length > 0) {
    throw new TypeError("Pi skill identities do not accept extension resource paths");
  }
  // Worker attempts execute a private copy of the accepted skill package. Keep
  // the identity path-independent so that immutable copy retains the primary
  // skill's capability identity without exposing its private host path.
  return createPiSkillResourceSnapshot(trustedPath).identity;
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

function normalizeDeclaredExtensionResourcePath(path: string, label: string): string {
  if (typeof path !== "string" || path.trim() === "" || !isAbsolute(path)) {
    throw new TypeError(`${label} must be a non-empty absolute path`);
  }
  const normalized = normalize(resolve(path));
  const direct = lstatSync(normalized);
  if (direct.isSymbolicLink()) throw new TypeError(`${label} must not be a symlink`);
  if (direct.isFile()) return strictTrustedFile(normalized, label);
  throw new TypeError(`${label} must be a regular file`);
}

function buildPiPrimaryResourceContract(input: {
  extensionPaths: readonly string[];
  extensionResourcePaths: readonly (readonly string[])[];
  skillPaths: readonly string[];
  toolNames: readonly string[];
}): PiPrimaryResourceContract {
  const extensionPaths = requireUnique(input.extensionPaths.map((path, index) =>
    strictTrustedFile(path, `primary extension[${index}]`)), "Primary Pi extensions");
  if (extensionPaths.length === 0) {
    throw new TypeError("Primary Pi resources must include explicit extensions");
  }
  if (
    !Array.isArray(input.extensionResourcePaths)
    || input.extensionResourcePaths.length !== extensionPaths.length
  ) {
    throw new TypeError(
      "Primary Pi extension resource manifests must be parallel to extension paths",
    );
  }
  const extensionResourcePaths = input.extensionResourcePaths.map((resources, extensionIndex) => {
    if (!Array.isArray(resources)) {
      throw new TypeError(
        `primary extension resource manifest[${extensionIndex}] must be an array`,
      );
    }
    return requireUnique(resources.map((path, resourceIndex) =>
      normalizeDeclaredExtensionResourcePath(
        path,
        `primary extension resource[${extensionIndex}][${resourceIndex}]`,
      )), `Primary Pi extension resource manifest[${extensionIndex}]`);
  });
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
  const extensionIdentities = requireUnique(extensionPaths.map((path, index) =>
    piResourceIdentity("extension", path, extensionResourcePaths[index])),
  "Primary Pi extension identities");
  const skillIdentities = requireUnique(skillPaths.map((path) =>
    piResourceIdentity("skill", path)), "Primary Pi skill identities");
  assertOpsWorkerParityContractRepresentable({
    extensionIdentities,
    skillIdentities,
    toolNames,
    additionalExtensionIdentities: 1,
  });
  const extensionsDigest = canonicalListDigest("minime-pi-extensions-v1", extensionIdentities);
  const skillsDigest = canonicalListDigest("minime-pi-skills-v1", skillIdentities);
  const toolsDigest = canonicalListDigest("minime-pi-tools-v1", toolNames);
  return {
    version: PI_PRIMARY_RESOURCE_CONTRACT_VERSION,
    extensionPaths,
    extensionResourcePaths,
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
  const extensionPaths = extensionPathsFromArgs(resolvedExtensionArgs);
  const extraExtensions = options.extensionOptions?.extraExtensions ?? [];
  if (extraExtensions.length > 0 && options.extraExtensionResourcePaths === undefined) {
    throw new TypeError(
      "Configured extra Pi extensions require explicit non-module resource manifests",
    );
  }
  const extraResourcePaths = options.extraExtensionResourcePaths ?? [];
  if (extraResourcePaths.length !== extraExtensions.length) {
    throw new TypeError(
      "Configured extra Pi extension resource manifests must be parallel to extra extensions",
    );
  }
  const firstPartyCount = extensionPaths.length - extraExtensions.length;
  if (firstPartyCount < 0) {
    throw new TypeError("Primary Pi extension resolver returned fewer paths than configured extras");
  }
  return buildPiPrimaryResourceContract({
    extensionPaths,
    extensionResourcePaths: [
      ...Array.from({ length: firstPartyCount }, () => [] as string[]),
      ...extraResourcePaths,
    ],
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
