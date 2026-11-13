import { accessSync, constants, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Trusted cron descendants keep this contract; interactive launches clear it. */
export const CRON_FAST_OFF_ENV = "MINIME_CRON_FAST_OFF";
export const CRON_REAL_CODEX_ENV = "MINIME_CRON_REAL_CODEX";
export const CRON_CODEX_SHIM_DIR_ENV = "MINIME_CRON_CODEX_SHIM_DIR";
const shimDir = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/cron-bin");
const shim = join(shimDir, "codex");

export function isCronFastOff(env: NodeJS.ProcessEnv): boolean {
  return env[CRON_FAST_OFF_ENV] === "1";
}

export function stripCronFastEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...rawEnv };
  if (env.PATH !== undefined) {
    const inheritedShimDir = env[CRON_CODEX_SHIM_DIR_ENV];
    env.PATH = env.PATH.split(delimiter)
      .filter(part => resolve(part) !== shimDir && (!inheritedShimDir || resolve(part) !== resolve(inheritedShimDir)))
      .join(delimiter);
  }
  delete env[CRON_FAST_OFF_ENV];
  delete env[CRON_REAL_CODEX_ENV];
  delete env[CRON_CODEX_SHIM_DIR_ENV];
  return env;
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function buildCronFastEnv(rawEnv: Record<string, string>): Record<string, string>;
export function buildCronFastEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function buildCronFastEnv(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = stripCronFastEnv(rawEnv);
  env[CRON_FAST_OFF_ENV] = "1";
  // Keep the symlink path so a cask update does not pin an obsolete binary.
  const inheritedReal = isCronFastOff(rawEnv) ? rawEnv[CRON_REAL_CODEX_ENV] : undefined;
  const realCodex = inheritedReal || env.PATH?.split(delimiter)
    .map(part => resolve(part, "codex"))
    .find(candidate => candidate !== shim && isExecutableFile(candidate));
  // Pi-only cron hosts need no Codex CLI or PATH change.
  if (!realCodex) return env;
  if (!isExecutableFile(shim)) throw new Error("Cron Codex shim is missing or not executable");
  env[CRON_REAL_CODEX_ENV] = realCodex;
  env[CRON_CODEX_SHIM_DIR_ENV] = shimDir;
  env.PATH = [shimDir, env.PATH].filter(part => part !== undefined).join(delimiter);
  return env;
}
