import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolvePiInvocation } from "../pi-extensions/pi-invocation.js";
import {
  EXPECTED_PI_PACKAGE_VERSION,
  formatPiRuntimeDiagnostic,
  resolvePackageOwnedPiInvocation,
  type PiRuntimeResolveOptions,
} from "../pi-runtime.js";

const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RPC_ENTRY = "/opt/package/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js";
const CLI_ENTRY = "/opt/package/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

function fixtureOptions(overrides: PiRuntimeResolveOptions = {}): PiRuntimeResolveOptions {
  return {
    execPath: "/usr/local/bin/node",
    currentEntrypoint: "/opt/minime/dist/cli.js",
    resolveModule: (specifier) => {
      assert.equal(specifier, "@earendil-works/pi-coding-agent/rpc-entry");
      return RPC_ENTRY;
    },
    exists: (path) => path === RPC_ENTRY || path === CLI_ENTRY,
    readFile: () => JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: EXPECTED_PI_PACKAGE_VERSION,
      bin: { pi: "dist/cli.js" },
    }),
    realpath: (path) => path,
    ...overrides,
  };
}

describe("package-owned Pi invocation", () => {
  it("resolves the exported RPC entrypoint and executes it with Node", () => {
    const invocation = resolvePackageOwnedPiInvocation("rpc", ["--model", "gpt-5.5"], fixtureOptions());

    assert.equal(invocation.command, "/usr/local/bin/node");
    assert.deepEqual(invocation.args, [RPC_ENTRY, "--model", "gpt-5.5"]);
    assert.deepEqual(invocation.diagnostic, {
      expectedVersion: "0.80.6",
      detectedVersion: "0.80.6",
      entrypointKind: "rpc",
      versionMismatch: false,
    });
  });

  it("resolves the sibling package CLI for print-mode children without PATH fallback", () => {
    const invocation = resolvePiInvocation(["--mode", "json"], fixtureOptions());

    assert.deepEqual(invocation, {
      command: "/usr/local/bin/node",
      args: [CLI_ENTRY, "--mode", "json"],
    });
    assert.notEqual(invocation.command, "pi");
  });

  it("reuses a current package-owned CLI symlink", () => {
    const currentEntrypoint = "/opt/package/node_modules/.bin/pi";
    const invocation = resolvePiInvocation(["-p"], {
      ...fixtureOptions(),
      entrypoint: currentEntrypoint,
      exists: (path) => path === RPC_ENTRY || path === CLI_ENTRY || path === currentEntrypoint,
      realpath: (path) => path === currentEntrypoint ? CLI_ENTRY : path,
    });

    assert.deepEqual(invocation.args, [currentEntrypoint, "-p"]);
  });

  it("fails loudly when the locked exported entrypoint cannot be resolved", () => {
    assert.throws(
      () => resolvePiInvocation([], fixtureOptions({
        resolveModule: () => {
          throw new Error("not exported");
        },
      })),
      /Package-owned Pi cli entrypoint is unavailable/,
    );
  });

  it("reports version mismatch without exposing an entrypoint path", () => {
    const invocation = resolvePackageOwnedPiInvocation("cli", [], fixtureOptions({
      readFile: () => JSON.stringify({ version: "9.9.9", bin: { pi: "dist/cli.js" } }),
    }));
    const diagnostic = formatPiRuntimeDiagnostic(invocation.diagnostic);

    assert.match(diagnostic, /expectedVersion=0\.80\.6/);
    assert.match(diagnostic, /entrypointKind=cli/);
    assert.match(diagnostic, /versionMismatch=true/);
    assert.doesNotMatch(diagnostic, /\/opt\//);
  });

  it("keeps all four direct Pi dependencies exact and aligned with the lockfile", () => {
    const packageJson = JSON.parse(readFileSync(resolve(TEST_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync(resolve(TEST_ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    const names = [
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ];

    for (const name of names) {
      assert.equal(packageJson.dependencies[name], EXPECTED_PI_PACKAGE_VERSION);
      assert.equal(packageLock.packages[""].dependencies?.[name], EXPECTED_PI_PACKAGE_VERSION);
      assert.equal(packageLock.packages[`node_modules/${name}`].version, EXPECTED_PI_PACKAGE_VERSION);
    }
  });
});
