import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { resolveWorkspaceContract } from "./workspace-contract.js";

interface CronsYaml {
  crons: Array<Record<string, unknown>>;
}

function deriveCronsLocalPath(cronsPath: string): string {
  return cronsPath.replace(/\.yaml$/, ".local.yaml");
}

export function resolveCronsPath(cronsPath?: string): string {
  return cronsPath === undefined
    ? resolveWorkspaceContract().paths.cronsPath
    : resolve(cronsPath);
}

export function loadMergedCrons(cronsPath?: string): Array<Record<string, unknown>> {
  const path = resolveCronsPath(cronsPath);
  const raw: CronsYaml = parseYaml(readFileSync(path, "utf8"));
  if (!raw?.crons || !Array.isArray(raw.crons)) {
    throw new Error("crons.yaml missing 'crons' array");
  }
  const baseCrons = raw.crons as Array<Record<string, unknown>>;

  const localPath = deriveCronsLocalPath(path);
  if (!existsSync(localPath)) {
    return [...baseCrons];
  }
  const localRaw: CronsYaml = parseYaml(readFileSync(localPath, "utf8"));
  if (!localRaw?.crons || !Array.isArray(localRaw.crons)) {
    process.stderr.write(`Warning: ${localPath} found but has no valid 'crons' array - ignoring local overrides\n`);
    return [...baseCrons];
  }
  const localCrons = localRaw.crons as Array<Record<string, unknown>>;

  const merged = [...baseCrons];
  for (const localCron of localCrons) {
    const idx = merged.findIndex((cron) => cron.name === localCron.name);
    if (idx >= 0) {
      merged[idx] = localCron;
    } else {
      merged.push(localCron);
    }
  }
  return merged;
}
