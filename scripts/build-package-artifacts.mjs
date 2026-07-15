#!/usr/bin/env node
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const sourceExtensionDir = join(packageRoot, "extensions", "pi");
const artifactExtensionDir = join(packageRoot, "dist", "extensions", "pi");

const wrappers = [
  ["codex-usage.ts", "codex-usage.js"],
  ["codex-transport-overflow.ts", "codex-transport-overflow.js"],
  ["web-tools.ts", "web-tools.js"],
  ["knowledge-tools.ts", "knowledge-tools.js"],
  ["recovery.ts", "recovery.js"],
  [join("subagent", "agents.ts"), join("subagent", "agents.js")],
  [join("subagent", "index.ts"), join("subagent", "index.js")],
  [join("ask-agent", "index.ts"), join("ask-agent", "index.js")],
];

rmSync(artifactExtensionDir, { recursive: true, force: true });

function rewriteImports(source) {
  return source
    .replaceAll("../../src/", "../../")
    .replaceAll("../../../src/", "../../../")
    .replaceAll('from "./agents.ts"', 'from "./agents.js"');
}

function transpileWrapper(sourcePath, targetPath) {
  const source = rewriteImports(readFileSync(sourcePath, "utf8"));
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      sourceMap: false,
    },
    fileName: sourcePath,
    reportDiagnostics: true,
  });
  const diagnostics = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (diagnostics.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => packageRoot,
      getNewLine: () => "\n",
    }));
  }
  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, result.outputText, "utf8");
}

for (const [sourceRel, targetRel] of wrappers) {
  transpileWrapper(
    join(sourceExtensionDir, sourceRel),
    join(artifactExtensionDir, targetRel),
  );
}

for (const rel of [
  join("subagent", "agents"),
  join("subagent", "prompts"),
]) {
  cpSync(join(sourceExtensionDir, rel), join(artifactExtensionDir, rel), {
    recursive: true,
    force: true,
  });
}

chmodSync(join(packageRoot, "dist", "cli.js"), 0o755);
chmodSync(join(packageRoot, "dist", "codex-quota-sampler.js"), 0o755);
chmodSync(join(packageRoot, "dist", "recovery", "fixer-session.js"), 0o755);
