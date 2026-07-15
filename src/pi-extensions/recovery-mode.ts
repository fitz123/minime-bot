import { existsSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { PI_EXTENSIONS_DISABLED_ENV } from "../pi-rpc-protocol.js";

export const RECOVERY_MODES = ["observe", "diagnose", "enabled"] as const;
export type RecoveryMode = (typeof RECOVERY_MODES)[number];

export const RECOVERY_ENDPOINT_OPERATIONS = [
  "inspect",
  "reconcile",
  "blocked",
  "finish",
  "mutate",
] as const;
export type RecoveryEndpointOperation = (typeof RECOVERY_ENDPOINT_OPERATIONS)[number];

export function isRecoveryMode(value: unknown): value is RecoveryMode {
  return typeof value === "string" && (RECOVERY_MODES as readonly string[]).includes(value);
}

export function parseRecoveryMode(value: unknown): RecoveryMode {
  if (!isRecoveryMode(value)) {
    throw new Error("Recovery mode is invalid");
  }
  return value;
}

export function recoveryModeAllowsDispatch(mode: RecoveryMode): boolean {
  return mode === "diagnose" || mode === "enabled";
}

export function recoveryModeAllowsMutation(mode: RecoveryMode): boolean {
  return mode === "enabled";
}

export function recoveryEndpointAllowed(
  mode: RecoveryMode,
  operation: RecoveryEndpointOperation,
): boolean {
  if (!recoveryModeAllowsDispatch(mode)) {
    return false;
  }
  return operation !== "mutate" || recoveryModeAllowsMutation(mode);
}

export function assertRecoveryToolCallAllowed(mode: RecoveryMode, mutating: boolean): void {
  if (mode === "observe") {
    throw new Error("Recovery fixer tools are unavailable in observe mode");
  }
  if (mutating && !recoveryModeAllowsMutation(mode)) {
    throw new Error("Recovery mutation is blocked in diagnose mode");
  }
}

export interface RecoveryExtensionOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/**
 * Resolve the recovery-only extension for a fixer spawn.
 *
 * Unlike ordinary bot extension resolution, the global extension kill-switch is
 * never a supported bypass here: diagnose and enabled would otherwise launch a
 * full default-tool Pi without the journaling/mode guard.
 */
export function resolveRequiredRecoveryExtensionArgs(
  mode: RecoveryMode,
  extensionPath: string,
  options: RecoveryExtensionOptions = {},
): string[] {
  if (!recoveryModeAllowsDispatch(mode)) {
    throw new Error("Recovery fixer dispatch is disabled in observe mode");
  }
  const env = options.env ?? process.env;
  if (env[PI_EXTENSIONS_DISABLED_ENV] === "1") {
    throw new Error(
      `${PI_EXTENSIONS_DISABLED_ENV}=1 cannot be used for a recovery fixer spawn`,
    );
  }
  if (typeof extensionPath !== "string" || !isAbsolute(extensionPath)) {
    throw new Error("Recovery extension path must be absolute");
  }
  const absolute = normalize(resolve(extensionPath));
  if (!(options.exists ?? existsSync)(absolute)) {
    throw new Error(`Recovery extension wrapper not found: ${absolute}`);
  }
  return ["--extension", absolute];
}

export function assertRequiredRecoveryExtensionLoaded(
  mode: RecoveryMode,
  extensionPath: string,
  args: readonly string[],
  options: RecoveryExtensionOptions = {},
): void {
  const required = resolveRequiredRecoveryExtensionArgs(mode, extensionPath, options)[1];
  for (let index = 0; index + 1 < args.length; index++) {
    if (args[index] === "--extension" && normalize(resolve(args[index + 1])) === required) {
      return;
    }
  }
  throw new Error("Recovery fixer spawn is missing its required recovery extension");
}
