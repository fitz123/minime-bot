import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export const EXPECTED_PI_PACKAGE_VERSION = "0.80.6";
const PI_RPC_ENTRY_SPECIFIER = `${PI_CODING_AGENT_PACKAGE}/rpc-entry`;

export type PiEntrypointKind = "rpc" | "cli";

export interface PiInvocation {
  command: string;
  args: string[];
}

export interface PiRuntimeDiagnostic {
  expectedVersion: string;
  detectedVersion: string;
  entrypointKind: PiEntrypointKind;
  versionMismatch: boolean;
}

export interface PackageOwnedPiInvocation extends PiInvocation {
  diagnostic: PiRuntimeDiagnostic;
}

export interface PiRuntimeResolveOptions {
  execPath?: string;
  currentEntrypoint?: string;
  expectedVersion?: string;
  resolveModule?: (specifier: string) => string;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  realpath?: (path: string) => string;
}

interface PiCodingAgentManifest {
  name?: unknown;
  version?: unknown;
  bin?: unknown;
}

/**
 * Resolve a Pi entrypoint from this package's dependency graph. This deliberately
 * never consults PATH: every package-owned child must run the version selected
 * by package-lock.json.
 */
export function resolvePackageOwnedPiInvocation(
  entrypointKind: PiEntrypointKind,
  args: readonly string[],
  options: PiRuntimeResolveOptions = {},
): PackageOwnedPiInvocation {
  const resolveModule = options.resolveModule ?? ((specifier: string) => fileURLToPath(import.meta.resolve(specifier)));
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const realpath = options.realpath ?? realpathSync;
  const expectedVersion = options.expectedVersion ?? EXPECTED_PI_PACKAGE_VERSION;

  let rpcEntrypoint: string;
  try {
    rpcEntrypoint = resolveModule(PI_RPC_ENTRY_SPECIFIER);
  } catch (error) {
    throw new Error(
      `Package-owned Pi ${entrypointKind} entrypoint is unavailable from ${PI_RPC_ENTRY_SPECIFIER}: ${errorMessage(error)}`,
    );
  }

  const packageRoot = resolve(dirname(rpcEntrypoint), "..");
  const manifestPath = resolve(packageRoot, "package.json");
  let manifest: PiCodingAgentManifest;
  try {
    manifest = JSON.parse(readFile(manifestPath)) as PiCodingAgentManifest;
  } catch (error) {
    throw new Error(`Package-owned Pi manifest is unavailable: ${errorMessage(error)}`);
  }

  const cliRelpath = piCliRelpath(manifest.bin);
  const targetEntrypoint = entrypointKind === "rpc"
    ? rpcEntrypoint
    : resolve(packageRoot, cliRelpath);
  if (!exists(targetEntrypoint)) {
    throw new Error(`Package-owned Pi ${entrypointKind} entrypoint is missing`);
  }

  // Preserve the current Pi script when it is the same package-owned entrypoint
  // (including a node_modules/.bin symlink). This avoids needlessly changing the
  // entry script identity for nested print-mode children.
  const currentEntrypoint = options.currentEntrypoint ?? process.argv[1];
  const selectedEntrypoint = currentEntrypoint && exists(currentEntrypoint)
    && sameEntrypoint(currentEntrypoint, targetEntrypoint, realpath)
    ? currentEntrypoint
    : targetEntrypoint;
  const detectedVersion = typeof manifest.version === "string" && manifest.version.trim()
    ? manifest.version.trim()
    : "unknown";

  return {
    command: options.execPath ?? process.execPath,
    args: [selectedEntrypoint, ...args],
    diagnostic: {
      expectedVersion,
      detectedVersion,
      entrypointKind,
      versionMismatch: detectedVersion !== expectedVersion,
    },
  };
}

/** Metadata-only diagnostic: it intentionally excludes resolved host paths. */
export function formatPiRuntimeDiagnostic(diagnostic: PiRuntimeDiagnostic): string {
  return [
    `expectedVersion=${diagnostic.expectedVersion}`,
    `entrypointKind=${diagnostic.entrypointKind}`,
    `versionMismatch=${diagnostic.versionMismatch}`,
  ].join(" ");
}

function piCliRelpath(bin: unknown): string {
  const value = typeof bin === "string"
    ? bin
    : isRecord(bin) && typeof bin.pi === "string"
      ? bin.pi
      : undefined;
  if (!value?.trim()) {
    throw new Error("Package-owned Pi CLI entrypoint is absent from the package manifest");
  }
  return value;
}

function sameEntrypoint(left: string, right: string, realpath: (path: string) => string): boolean {
  try {
    return realpath(left) === realpath(right);
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
