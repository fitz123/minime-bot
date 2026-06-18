#!/usr/bin/env npx tsx
// Generates launchd cron plist files from crons.yaml for source-tree development.

import {
  generateLaunchdCronPlists,
  writeLaunchdCronPlists,
} from "../src/launchd-cron-plists.js";

const dryRun = process.argv.includes("--dry-run");
const workspace = readOptionalFlag("--workspace");
const launchAgentsDir = readOptionalFlag("--launch-agents-dir");

function readOptionalFlag(flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg.startsWith(equalsPrefix)) {
      const value = arg.slice(equalsPrefix.length).trim();
      return value || undefined;
    }
    if (arg === flag) {
      const value = process.argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      return value;
    }
  }
  return undefined;
}

function main(): void {
  try {
    const result = dryRun
      ? generateLaunchdCronPlists({ workspace, launchAgentsDir })
      : writeLaunchdCronPlists({ workspace, launchAgentsDir });

    for (const skipped of result.skipped) {
      console.log(`[SKIP] ${skipped.name} (enabled: false)`);
    }
    for (const plist of result.plists) {
      if (dryRun) {
        console.log(`[DRY-RUN] Would write: ${plist.plistPath}`);
        console.log(`  Schedule: ${plist.cron.schedule} -> ${plist.scheduleSummary}`);
      } else {
        console.log(`Generated: ${plist.plistPath}`);
      }
    }
    console.log(`\n${dryRun ? "[DRY-RUN] " : ""}Generated ${result.plists.length} plists, 0 errors`);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1]?.endsWith("generate-plists.ts") ||
  process.argv[1]?.endsWith("generate-plists.js");
if (isMain) {
  main();
}
