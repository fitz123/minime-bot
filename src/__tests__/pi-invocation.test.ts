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
      expectedVersion: "0.82.1",
      detectedVersion: "0.82.1",
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

    assert.match(diagnostic, /expectedVersion=0\.82\.1/);
    assert.match(diagnostic, /entrypointKind=cli/);
    assert.match(diagnostic, /versionMismatch=true/);
    assert.doesNotMatch(diagnostic, /\/opt\//);
  });

  it("keeps every direct and nested Pi resolution coherent at the exact approved version", () => {
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

    const piResolutions = Object.entries(packageLock.packages)
      .filter(([path]) => /(?:^|\/)node_modules\/@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)$/.test(path));
    assert.ok(piResolutions.length >= names.length);
    for (const [path, manifest] of piResolutions) {
      assert.equal(manifest.version, EXPECTED_PI_PACKAGE_VERSION, path);
      const installed = JSON.parse(
        readFileSync(resolve(TEST_ROOT, path, "package.json"), "utf8"),
      ) as { version?: string };
      assert.equal(installed.version, EXPECTED_PI_PACKAGE_VERSION, path);
    }
  });

  it("keeps grammY/types exact and the Pi-relevant patched transitive resolutions installed", () => {
    const packageJson = JSON.parse(readFileSync(resolve(TEST_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync(resolve(TEST_ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    const installedGrammy = JSON.parse(
      readFileSync(resolve(TEST_ROOT, "node_modules", "grammy", "package.json"), "utf8"),
    ) as { version?: string };
    const installedGrammyTypes = JSON.parse(
      readFileSync(resolve(TEST_ROOT, "node_modules", "@grammyjs", "types", "package.json"), "utf8"),
    ) as { version?: string };

    assert.equal(packageJson.dependencies.grammy, "1.45.1");
    assert.equal(packageLock.packages[""].dependencies?.grammy, "1.45.1");
    assert.equal(packageLock.packages["node_modules/grammy"].version, "1.45.1");
    assert.equal(packageLock.packages["node_modules/grammy"].dependencies?.["@grammyjs/types"], "4.0.0");
    assert.equal(packageLock.packages["node_modules/@grammyjs/types"].version, "4.0.0");
    assert.equal(installedGrammy.version, "1.45.1");
    assert.equal(installedGrammyTypes.version, "4.0.0");
    assert.equal(packageJson.dependencies["@grammyjs/auto-retry"], "^2.0.2");
    assert.equal(packageLock.packages[""].dependencies?.["@grammyjs/auto-retry"], "^2.0.2");
    assert.equal(
      packageLock.packages[
        "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"
      ].version,
      "5.0.7",
    );
    assert.equal(
      packageLock.packages[
        "node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs"
      ].version,
      "7.6.5",
    );
    assert.equal(packageLock.packages["node_modules/protobufjs"].version, "7.6.5");
  });
});
