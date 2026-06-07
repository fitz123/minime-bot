#!/usr/bin/env npx tsx
// generate-plists.ts — Generates launchd plist files from crons.yaml
// Usage: npx tsx scripts/generate-plists.ts [--dry-run]
// Output: ~/Library/LaunchAgents/ai.minime.cron.<name>.plist

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { loadMergedCrons } from "../src/cron-runner.js";
import {
  expandCronField,
  parseEveryScheduleSeconds,
  validateCronForPlist,
  type CronPlistDef,
} from "../src/cron-plist.js";
import { resolveWorkspaceContract, MINIME_WORKSPACE_ROOT_ENV } from "../src/workspace-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_DIR = resolve(__dirname, "..");
const HOME = homedir();
const LAUNCH_AGENTS_DIR = join(HOME, "Library", "LaunchAgents");
const LOG_DIR = process.env.LOG_DIR ?? join(HOME, ".minime", "logs");
const RUN_CRON_SCRIPT = resolve(BOT_DIR, "scripts", "run-cron.sh");

const dryRun = process.argv.includes("--dry-run");
const workspace = readOptionalFlag("--workspace");

type CronDef = CronPlistDef;

// Parse cron expression to launchd StartCalendarInterval entries
// launchd doesn't support */N — we expand to individual entries
interface CalendarInterval {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Month?: number;
  Weekday?: number;
}

function parseCronToCalendarIntervals(expr: string): CalendarInterval[] | null {
  // Handle "every N" (seconds) → use StartInterval instead
  if (parseEveryScheduleSeconds(expr) !== undefined) {
    return null; // signals to use StartInterval
  }

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expr}`);
  }

  const [minute, hour, day, month, weekday] = parts;

  // Expand each field
  const minutes = expandCronField(minute, 0, 59);
  const hours = expandCronField(hour, 0, 23);
  const days = expandCronField(day, 1, 31);
  const months = expandCronField(month, 1, 12);
  const weekdays = expandCronField(weekday, 0, 7); // 0 or 7 = Sunday

  // Convert cron weekdays (0=Sun, 1=Mon..7=Sun) to launchd (0=Sun, 1=Mon..)
  // Actually both use 0=Sunday convention, so no conversion needed
  // But cron uses 1-5 for Mon-Fri, launchd uses 1-5 for Mon-Fri. Compatible.

  // Generate all combinations
  const intervals: CalendarInterval[] = [];

  // If weekday is specified (not *), iterate over weekdays
  // If day/month is specified, iterate over those
  // Generate the minimal set of entries

  for (const m of months) {
    for (const d of days) {
      for (const wd of weekdays) {
        for (const h of hours) {
          for (const min of minutes) {
            const entry: CalendarInterval = {};
            if (min !== -1) entry.Minute = min;
            if (h !== -1) entry.Hour = h;
            if (d !== -1) entry.Day = d;
            if (m !== -1) entry.Month = m;
            if (wd !== -1) entry.Weekday = wd;
            intervals.push(entry);
          }
        }
      }
    }
  }

  return intervals;
}

function calendarIntervalToPlist(interval: CalendarInterval): string {
  const lines: string[] = [];
  lines.push("        <dict>");
  if (interval.Month !== undefined && interval.Month !== -1) {
    lines.push(`          <key>Month</key>`);
    lines.push(`          <integer>${interval.Month}</integer>`);
  }
  if (interval.Day !== undefined && interval.Day !== -1) {
    lines.push(`          <key>Day</key>`);
    lines.push(`          <integer>${interval.Day}</integer>`);
  }
  if (interval.Weekday !== undefined && interval.Weekday !== -1) {
    lines.push(`          <key>Weekday</key>`);
    lines.push(`          <integer>${interval.Weekday}</integer>`);
  }
  if (interval.Hour !== undefined && interval.Hour !== -1) {
    lines.push(`          <key>Hour</key>`);
    lines.push(`          <integer>${interval.Hour}</integer>`);
  }
  if (interval.Minute !== undefined && interval.Minute !== -1) {
    lines.push(`          <key>Minute</key>`);
    lines.push(`          <integer>${interval.Minute}</integer>`);
  }
  lines.push("        </dict>");
  return lines.join("\n");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function pathInside(dir: string, path: string): boolean {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function readOptionalFlag(flag: string): string | undefined {
  const equalsPrefix = `${flag}=`;
  for (let i = 2; i < process.argv.length; i++) {
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

function generatePlist(cron: CronDef, controlWorkspaceRoot: string): string {
  const label = `ai.minime.cron.${cron.name}`;
  const intervals = parseCronToCalendarIntervals(cron.schedule);

  let scheduleSection: string;

  if (intervals === null) {
    // "every N" seconds
    const seconds = parseEveryScheduleSeconds(cron.schedule);
    if (seconds === undefined) {
      throw new Error(`Invalid every schedule: ${cron.schedule}`);
    }
    scheduleSection = `    <key>StartInterval</key>
    <integer>${seconds}</integer>`;
  } else if (intervals.length === 1) {
    scheduleSection = `    <key>StartCalendarInterval</key>
${calendarIntervalToPlist(intervals[0]).replace(/^        /gm, "    ")}`;
  } else {
    const entriesXml = intervals
      .map((i) => calendarIntervalToPlist(i))
      .join("\n");
    scheduleSection = `    <key>StartCalendarInterval</key>
    <array>
${entriesXml}
    </array>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
	<dict>
	    <key>Label</key>
	    <string>${xmlEscape(label)}</string>
	    <key>ProgramArguments</key>
	    <array>
	        <string>/bin/bash</string>
	        <string>${xmlEscape(RUN_CRON_SCRIPT)}</string>
	        <string>${xmlEscape(cron.name)}</string>
	    </array>
${scheduleSection}
    <key>RunAtLoad</key>
	    <false/>
	    <key>WorkingDirectory</key>
	    <string>${xmlEscape(controlWorkspaceRoot)}</string>
	    <key>StandardOutPath</key>
	    <string>${xmlEscape(`${LOG_DIR}/cron-${cron.name}.stdout.log`)}</string>
	    <key>StandardErrorPath</key>
	    <string>${xmlEscape(`${LOG_DIR}/cron-${cron.name}.stderr.log`)}</string>
	    <key>EnvironmentVariables</key>
	    <dict>
	        <key>HOME</key>
	        <string>${xmlEscape(HOME)}</string>
	        <key>${MINIME_WORKSPACE_ROOT_ENV}</key>
	        <string>${xmlEscape(controlWorkspaceRoot)}</string>
	        <key>LOG_DIR</key>
	        <string>${xmlEscape(LOG_DIR)}</string>
	        <key>PATH</key>
	        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
`;
}

function main(): void {
  let crons: CronDef[];
  const contract = resolveWorkspaceContract({ workspace });
  try {
    crons = loadMergedCrons(contract.paths.cronsPath) as unknown as CronDef[];
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }

  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });

  let generated = 0;
  let errors = 0;

  for (const cron of crons) {
    if (cron.enabled === false) {
      console.log(`[SKIP] ${cron.name} (enabled: false)`);
      continue;
    }
    const validationError = validateCronForPlist(cron);
    if (validationError) {
      console.error(`ERROR: ${validationError}`);
      errors++;
      continue;
    }
    try {
      const plistContent = generatePlist(cron, contract.paths.controlWorkspaceRoot);
      const plistPath = resolve(
        LAUNCH_AGENTS_DIR,
        `ai.minime.cron.${cron.name}.plist`,
      );
      if (!pathInside(LAUNCH_AGENTS_DIR, plistPath)) {
        throw new Error(`resolved plist path escapes LaunchAgents dir: ${plistPath}`);
      }

      if (dryRun) {
        console.log(`[DRY-RUN] Would write: ${plistPath}`);
        const intervals = parseCronToCalendarIntervals(cron.schedule);
        console.log(
          `  Schedule: ${cron.schedule} → ${intervals === null ? `StartInterval(${parseEveryScheduleSeconds(cron.schedule)}s)` : `${intervals.length} calendar interval(s)`}`,
        );
      } else {
        writeFileSync(plistPath, plistContent, "utf8");
        console.log(`Generated: ${plistPath}`);
      }
      generated++;
    } catch (err) {
      console.error(
        `ERROR generating plist for ${cron.name}: ${(err as Error).message}`,
      );
      errors++;
    }
  }

  console.log(
    `\n${dryRun ? "[DRY-RUN] " : ""}Generated ${generated} plists, ${errors} errors`,
  );

  if (errors > 0) {
    process.exit(1);
  }
}

const isMain =
  process.argv[1]?.endsWith("generate-plists.ts") ||
  process.argv[1]?.endsWith("generate-plists.js");
if (isMain) {
  main();
}
