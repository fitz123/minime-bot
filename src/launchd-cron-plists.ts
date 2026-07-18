import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { homedir, userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual } from "node:util";
import { loadMergedCrons } from "./cron-loader.js";
import {
  expandCronField,
  parseEveryScheduleSeconds,
  validateCronForPlist,
  validateCronNameForPlist,
  type CronPlistDef,
} from "./cron-plist.js";
import {
  MINIME_CONFIG_PATH_ENV,
  MINIME_CONTROL_WORKSPACE_ROOT_ENV,
  MINIME_CRONS_PATH_ENV,
  resolveWorkspaceContract,
  type ResolvedWorkspaceContract,
} from "./workspace-contract.js";

export const CRON_LAUNCHD_LABEL_PREFIX = "ai.minime.cron.";
export const BOT_LAUNCHD_LABEL = "ai.minime.telegram-bot";
export const DEFAULT_LAUNCHCTL_BIN = "/bin/launchctl";
export const DEFAULT_PLUTIL_BIN = "/usr/bin/plutil";
const DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export interface CalendarInterval {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Month?: number;
  Weekday?: number;
}

export interface LaunchdCronContext {
  contract: ResolvedWorkspaceContract;
  launchAgentsDir: string;
  logDir: string;
  packageRoot: string;
  runCronScript: string;
  homeDir: string;
  uid: number;
  launchdDomain: string;
  launchctlBin: string;
  plutilBin: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export interface RenderedLaunchdCronPlist {
  cron: CronPlistDef;
  label: string;
  plistPath: string;
  content: string;
  scheduleSummary: string;
}

export interface GenerateLaunchdCronPlistsOptions {
  workspace?: string;
  launchAgentsDir?: string;
  runCronScript?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDir?: string;
  uid?: number;
  moduleUrl?: string;
}

export interface GenerateLaunchdCronPlistsResult {
  context: LaunchdCronContext;
  plists: RenderedLaunchdCronPlist[];
  skipped: Array<{ name: string; reason: "disabled" }>;
  disabledLabels: Set<string>;
}

export type LaunchdCronPlanAction = "create" | "update" | "unchanged" | "delete";

export interface LaunchdCronPlanItem {
  action: LaunchdCronPlanAction;
  label: string;
  plistPath: string;
  reason?: "active" | "disabled" | "stale";
  scheduleSummary?: string;
}

export interface LaunchdCommandResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
}

export type LaunchdCommandRunner = (
  command: string,
  args: readonly string[],
) => LaunchdCommandResult;

export interface LaunchdCommandRecord {
  command: string;
  args: string[];
  status: number | null;
  ignoredFailure?: boolean;
}

export interface SyncLaunchdCronsOptions extends GenerateLaunchdCronPlistsOptions {
  dryRun?: boolean;
  prune?: boolean;
  commandRunner?: LaunchdCommandRunner;
}

export interface SyncLaunchdCronsResult {
  dryRun: boolean;
  prune: boolean;
  context: LaunchdCronContext;
  items: LaunchdCronPlanItem[];
  commands: LaunchdCommandRecord[];
}

export function parseCronToCalendarIntervals(expr: string): CalendarInterval[] | null {
  if (parseEveryScheduleSeconds(expr) !== undefined) {
    return null;
  }

  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expr}`);
  }

  const [minute, hour, day, month, weekday] = parts;
  if (day !== "*" && weekday !== "*") {
    throw new Error(
      "restricting both day-of-month and weekday is unsupported for launchd plists; split it into separate crons",
    );
  }
  const minutes = expandCronField(minute, 0, 59);
  const hours = expandCronField(hour, 0, 23);
  const days = expandCronField(day, 1, 31);
  const months = expandCronField(month, 1, 12);
  const weekdays = expandCronField(weekday, 0, 7);

  const intervals: CalendarInterval[] = [];
  for (const m of months) {
    for (const d of days) {
      for (const wd of weekdays) {
        for (const h of hours) {
          for (const min of minutes) {
            const entry: CalendarInterval = {};
            if (m !== -1) entry.Month = m;
            if (d !== -1) entry.Day = d;
            if (wd !== -1) entry.Weekday = wd;
            if (h !== -1) entry.Hour = h;
            if (min !== -1) entry.Minute = min;
            intervals.push(entry);
          }
        }
      }
    }
  }
  return intervals;
}

export function cronLaunchdLabel(name: string): string {
  const nameError = validateCronNameForPlist(name);
  if (nameError) {
    throw new Error(nameError);
  }
  return `${CRON_LAUNCHD_LABEL_PREFIX}${name}`;
}

export function isOwnedCronLaunchdLabel(label: string): boolean {
  return label.startsWith(CRON_LAUNCHD_LABEL_PREFIX) && label !== BOT_LAUNCHD_LABEL;
}

export function renderLaunchdCronPlist(
  cron: CronPlistDef,
  context: Pick<LaunchdCronContext, "runCronScript" | "logDir" | "homeDir" | "contract">,
): string {
  const label = cronLaunchdLabel(cron.name);
  const intervals = parseCronToCalendarIntervals(cron.schedule);
  let scheduleSection: string;

  if (intervals === null) {
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
    const entriesXml = intervals.map((interval) => calendarIntervalToPlist(interval)).join("\n");
    scheduleSection = `    <key>StartCalendarInterval</key>
    <array>
${entriesXml}
    </array>`;
  }

  const controlWorkspaceRoot = context.contract.paths.controlWorkspaceRoot;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(label)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>${xmlEscape(context.runCronScript)}</string>
      <string>${xmlEscape(cron.name)}</string>
    </array>
${scheduleSection}
    <key>RunAtLoad</key>
    <false/>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(controlWorkspaceRoot)}</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(join(context.logDir, `cron-${cron.name}.stdout.log`))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(join(context.logDir, `cron-${cron.name}.stderr.log`))}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>HOME</key>
      <string>${xmlEscape(context.homeDir)}</string>
      <key>${MINIME_CONTROL_WORKSPACE_ROOT_ENV}</key>
      <string>${xmlEscape(controlWorkspaceRoot)}</string>
${renderExplicitPathEnvEntries(context.contract)}
      <key>LOG_DIR</key>
      <string>${xmlEscape(context.logDir)}</string>
      <key>PATH</key>
      <string>${DEFAULT_PATH}</string>
    </dict>
  </dict>
</plist>
`;
}

export function generateLaunchdCronPlists(
  options: GenerateLaunchdCronPlistsOptions = {},
): GenerateLaunchdCronPlistsResult {
  const context = resolveLaunchdCronContext(options);
  const crons = loadMergedCrons(context.contract.paths.cronsPath) as unknown as CronPlistDef[];
  const plists: RenderedLaunchdCronPlist[] = [];
  const skipped: Array<{ name: string; reason: "disabled" }> = [];
  const disabledLabels = new Set<string>();
  const errors: string[] = [];
  const labels = new Set<string>();

  for (const cron of crons) {
    if (cron.enabled === false) {
      const name = typeof cron.name === "string" ? cron.name : "(unnamed)";
      skipped.push({ name, reason: "disabled" });
      const nameError = typeof cron.name === "string" ? validateCronNameForPlist(cron.name) : "missing name";
      if (!nameError && typeof cron.name === "string") {
        disabledLabels.add(cronLaunchdLabel(cron.name));
      }
      continue;
    }

    const validationError = validateCronForPlist(cron);
    if (validationError) {
      errors.push(validationError);
      continue;
    }

    try {
      const label = cronLaunchdLabel(cron.name);
      if (labels.has(label)) {
        errors.push(`${cron.name} has a duplicate launchd label: ${label}`);
        continue;
      }
      labels.add(label);
      const plistPath = resolve(context.launchAgentsDir, `${label}.plist`);
      if (!pathInside(context.launchAgentsDir, plistPath)) {
        throw new Error(`resolved plist path escapes LaunchAgents dir: ${plistPath}`);
      }
      plists.push({
        cron,
        label,
        plistPath,
        content: renderLaunchdCronPlist(cron, context),
        scheduleSummary: describeLaunchdSchedule(cron.schedule),
      });
    } catch (err) {
      errors.push(`ERROR generating plist for ${cron.name}: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Cron plist validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

  return { context, plists, skipped, disabledLabels };
}

export function writeLaunchdCronPlists(
  options: GenerateLaunchdCronPlistsOptions = {},
): GenerateLaunchdCronPlistsResult {
  const result = generateLaunchdCronPlists(options);
  mkdirSync(result.context.launchAgentsDir, { recursive: true });
  mkdirSync(result.context.logDir, { recursive: true });
  for (const plist of result.plists) {
    writeFileSync(plist.plistPath, plist.content, "utf8");
  }
  return result;
}

export function planLaunchdCronSync(
  options: GenerateLaunchdCronPlistsOptions & { prune?: boolean } = {},
): GenerateLaunchdCronPlistsResult & { items: LaunchdCronPlanItem[] } {
  const generated = generateLaunchdCronPlists(options);
  const prune = options.prune !== false;
  const desiredByLabel = new Map(generated.plists.map((plist) => [plist.label, plist]));
  const items: LaunchdCronPlanItem[] = [];

  for (const plist of generated.plists) {
    const existing = existsSync(plist.plistPath) ? readFileSync(plist.plistPath, "utf8") : undefined;
    const action: LaunchdCronPlanAction =
      existing === undefined
        ? "create"
        : existing === plist.content || plistsSemanticallyEqual(generated.context, plist.plistPath, plist.content)
          ? "unchanged"
          : "update";
    items.push({
      action,
      label: plist.label,
      plistPath: plist.plistPath,
      reason: "active",
      scheduleSummary: plist.scheduleSummary,
    });
  }

  if (prune && existsSync(generated.context.launchAgentsDir)) {
    for (const [label, plistPath] of listOwnedCronPlists(generated.context.launchAgentsDir)) {
      if (desiredByLabel.has(label)) {
        continue;
      }
      items.push({
        action: "delete",
        label,
        plistPath,
        reason: generated.disabledLabels.has(label) ? "disabled" : "stale",
      });
    }
  }

  items.sort((a, b) => {
    if (a.action === "delete" && b.action !== "delete") return 1;
    if (a.action !== "delete" && b.action === "delete") return -1;
    return a.label.localeCompare(b.label);
  });

  return { ...generated, items };
}

export function syncLaunchdCrons(options: SyncLaunchdCronsOptions = {}): SyncLaunchdCronsResult {
  const dryRun = options.dryRun === true;
  const prune = options.prune !== false;
  const planned = planLaunchdCronSync({ ...options, prune });
  const commands: LaunchdCommandRecord[] = [];

  if (dryRun) {
    return { dryRun, prune, context: planned.context, items: planned.items, commands };
  }

  mkdirSync(planned.context.launchAgentsDir, { recursive: true });
  mkdirSync(planned.context.logDir, { recursive: true });
  const runner = options.commandRunner ?? defaultCommandRunner;
  const desiredByLabel = new Map(planned.plists.map((plist) => [plist.label, plist]));

  for (const item of planned.items) {
    if (item.action === "unchanged") {
      continue;
    }
    if (item.action === "delete") {
      runLaunchctl(planned.context, runner, commands, ["bootout", `${planned.context.launchdDomain}/${item.label}`], true);
      if (existsSync(item.plistPath)) {
        unlinkSync(item.plistPath);
      }
      continue;
    }

    const plist = desiredByLabel.get(item.label);
    if (!plist) {
      throw new Error(`internal error: missing generated plist for ${item.label}`);
    }
    const previousContent = writeValidatedPlist(planned.context, runner, commands, plist);
    let bootoutUnloaded = false;
    try {
      bootoutUnloaded = runLaunchctl(
        planned.context,
        runner,
        commands,
        ["bootout", `${planned.context.launchdDomain}/${item.label}`],
        true,
      );
      runLaunchctl(planned.context, runner, commands, ["bootstrap", planned.context.launchdDomain, plist.plistPath], false);
    } catch (err) {
      restorePreviousPlist(plist.plistPath, previousContent);
      if (bootoutUnloaded && previousContent !== undefined) {
        try {
          runLaunchctl(planned.context, runner, commands, ["bootstrap", planned.context.launchdDomain, plist.plistPath], false);
        } catch (rollbackErr) {
          throw new Error(
            `${errorMessage(err)}; rollback bootstrap of previous plist failed: ${errorMessage(rollbackErr)}`,
          );
        }
      }
      throw err;
    }
  }

  return { dryRun, prune, context: planned.context, items: planned.items, commands };
}

export function formatLaunchdCronSyncResult(result: SyncLaunchdCronsResult): string {
  const prefix = result.dryRun ? "[DRY-RUN] " : "";
  const lines = [
    `${prefix}LaunchAgents: ${result.context.launchAgentsDir}`,
    `${prefix}Prune: ${result.prune ? "enabled" : "disabled"}`,
  ];

  for (const item of result.items) {
    if (item.action === "unchanged") {
      lines.push(`${prefix}unchanged ${item.label} ${item.scheduleSummary ?? ""}`.trimEnd());
    } else if (item.action === "delete") {
      lines.push(`${prefix}delete ${item.label} (${item.reason ?? "stale"})`);
    } else {
      lines.push(`${prefix}${item.action} ${item.label} ${item.scheduleSummary ?? ""}`.trimEnd());
      lines.push(`${prefix}rebootstrap ${item.label}`);
    }
  }

  const counts = countPlanItems(result.items);
  lines.push(
    `${prefix}Summary: create ${counts.create}, update ${counts.update}, unchanged ${counts.unchanged}, delete ${counts.delete}`,
  );
  return `${lines.join("\n")}\n`;
}

function resolveLaunchdCronContext(options: GenerateLaunchdCronPlistsOptions): LaunchdCronContext {
  const env = options.env ?? process.env;
  const cwd = normalize(resolve(options.cwd ?? process.cwd()));
  const homeDir = normalize(resolve(options.homeDir ?? env.HOME ?? homedir()));
  const contract = resolveWorkspaceContract({
    workspace: options.workspace,
    env,
    cwd,
    homeDir,
    moduleUrl: options.moduleUrl ?? import.meta.url,
  });
  const launchAgentsDir = normalize(resolveCliPath(options.launchAgentsDir ?? join(homeDir, "Library", "LaunchAgents"), cwd));
  const uid = options.uid ?? resolveUid();
  const launchctlBin = env.LAUNCHCTL_BIN?.trim() || DEFAULT_LAUNCHCTL_BIN;
  const plutilBin = env.PLUTIL_BIN?.trim() || DEFAULT_PLUTIL_BIN;
  const runCronScript = options.runCronScript === undefined
    ? resolve(contract.paths.packageRoot, "scripts", "run-cron.sh")
    : validateExplicitRunCronScript(options.runCronScript);
  return {
    contract,
    launchAgentsDir,
    logDir: contract.paths.logDir,
    packageRoot: contract.paths.packageRoot,
    runCronScript,
    homeDir,
    uid,
    launchdDomain: `gui/${uid}`,
    launchctlBin,
    plutilBin,
    env,
    cwd,
  };
}

function validateExplicitRunCronScript(runCronScript: string): string {
  if (!isAbsolute(runCronScript)) {
    throw invalidRunCronScript("must be an absolute path");
  }
  if (normalize(runCronScript) !== runCronScript || resolve(runCronScript) !== runCronScript) {
    throw invalidRunCronScript("path must be normalized");
  }
  if (basename(runCronScript) !== "run-cron.sh") {
    throw invalidRunCronScript("basename must be run-cron.sh");
  }

  const symlinks = new Map<string, Stats>();
  inspectRunCronPath(runCronScript, symlinks);
  if (symlinks.size > 1) {
    throw invalidRunCronScript("path must contain at most one directory symlink");
  }

  const finalStats = inspectRunCronComponent(runCronScript);
  if (finalStats.isSymbolicLink()) {
    throw invalidRunCronScript("final file must not be a symlink");
  }
  if (!finalStats.isFile()) {
    throw invalidRunCronScript("must resolve to a regular file");
  }

  const currentUid = resolveUid();
  if (symlinks.size === 0) {
    const containingDir = dirname(runCronScript);
    validateOwnedRunCronComponent(containingDir, currentUid, "containing directory");
    validateRunCronAncestorDirectories(containingDir, currentUid);
    validateOwnedRunCronComponent(runCronScript, currentUid, "file", true);
    return runCronScript;
  }

  const [symlinkPath, symlinkStats] = symlinks.entries().next().value!;
  if (symlinkStats.uid !== currentUid) {
    throw invalidRunCronScript("directory symlink must be owned by the current user");
  }
  // POSIX symlink mode bits are not enforced and normally read as 0777. The
  // non-writable, owner-controlled trust directory governs replacement of the link.

  const trustDir = dirname(symlinkPath);
  const canonicalTrustDir = inspectRunCronRealpath(trustDir, "trust directory must exist");
  const linkTarget = inspectRunCronReadlink(symlinkPath);
  if (linkTarget.split(sep).includes("..")) {
    throw invalidRunCronScript("directory symlink target must not contain parent directory references");
  }
  const rawTarget = resolve(trustDir, linkTarget);
  inspectRunCronPath(rawTarget, symlinks);
  if (symlinks.size > 1) {
    throw invalidRunCronScript("path must contain at most one directory symlink");
  }

  let canonicalTarget: string;
  try {
    const targetStats = statSync(symlinkPath);
    if (!targetStats.isDirectory()) {
      throw invalidRunCronScript("directory symlink must resolve to a directory");
    }
    canonicalTarget = realpathSync(symlinkPath);
  } catch (err) {
    if (isInvalidRunCronScriptError(err)) {
      throw err;
    }
    throw invalidRunCronScript("directory symlink must resolve to an existing directory");
  }
  if (!pathInside(canonicalTrustDir, canonicalTarget)) {
    throw invalidRunCronScript("directory symlink target must remain beneath its parent trust directory");
  }

  const canonicalRunCronScript = inspectRunCronRealpath(runCronScript, "must resolve to an existing file");
  if (!pathInside(canonicalTrustDir, canonicalRunCronScript)) {
    throw invalidRunCronScript("resolved file must remain beneath the symlink trust directory");
  }

  validateOwnedRunCronComponent(canonicalTrustDir, currentUid, "trust directory");
  validateRunCronAncestorDirectories(canonicalTrustDir, currentUid);
  for (const component of pathComponentsBetween(canonicalTrustDir, canonicalRunCronScript)) {
    const isFile = component === canonicalRunCronScript;
    validateOwnedRunCronComponent(component, currentUid, isFile ? "file" : "resolved directory", isFile);
  }
  return runCronScript;
}

function inspectRunCronPath(
  path: string,
  symlinks: Map<string, Stats>,
): void {
  const components = absolutePathComponents(path);
  for (let index = 0; index < components.length; index += 1) {
    const component = components[index];
    const stats = inspectRunCronComponent(component);
    if (stats.isSymbolicLink()) {
      symlinks.set(component, stats);
      if (symlinks.size > 1) {
        throw invalidRunCronScript("path must contain at most one directory symlink");
      }
      continue;
    }
    if (index < components.length - 1 && !stats.isDirectory()) {
      throw invalidRunCronScript("path contains a component that is not a directory");
    }
  }
}

function inspectRunCronComponent(path: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    throw invalidRunCronScript("must resolve to an existing path");
  }
}

function inspectRunCronRealpath(path: string, invariant: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw invalidRunCronScript(invariant);
  }
}

function inspectRunCronReadlink(path: string): string {
  try {
    return readlinkSync(path);
  } catch {
    throw invalidRunCronScript("directory symlink target must be readable");
  }
}

function validateOwnedRunCronComponent(
  path: string,
  currentUid: number,
  kind: string,
  requireExecutable = false,
): void {
  const stats = inspectRunCronComponent(path);
  if (stats.uid !== currentUid) {
    throw invalidRunCronScript(`${kind} must be owned by the current user`);
  }
  if ((stats.mode & 0o022) !== 0) {
    throw invalidRunCronScript(`${kind} must not be group or world writable`);
  }
  if (requireExecutable && (stats.mode & 0o500) !== 0o500) {
    throw invalidRunCronScript("file must be readable and executable by its owner");
  }
}

function validateRunCronAncestorDirectories(directory: string, currentUid: number): void {
  let child = directory;
  for (;;) {
    const parent = dirname(child);
    if (parent === child) {
      return;
    }

    const parentStats = inspectRunCronComponent(parent);
    if (!parentStats.isDirectory()) {
      throw invalidRunCronScript("ancestor path contains a component that is not a directory");
    }
    if (parentStats.uid !== 0 && parentStats.uid !== currentUid) {
      throw invalidRunCronScript("ancestor directories must be owned by root or the current user");
    }

    const parentIsWritable = (parentStats.mode & 0o022) !== 0;
    const parentIsSticky = (parentStats.mode & 0o1000) !== 0;
    if (parentIsWritable && !parentIsSticky) {
      throw invalidRunCronScript("ancestor directories must not be group or world writable unless sticky");
    }
    if (parentIsWritable) {
      const childStats = inspectRunCronComponent(child);
      if (childStats.uid !== 0 && childStats.uid !== currentUid) {
        throw invalidRunCronScript("entries beneath writable sticky ancestors must be owned by root or the current user");
      }
    }

    child = parent;
  }
}

function absolutePathComponents(path: string): string[] {
  const root = parse(path).root;
  const names = path.slice(root.length).split(sep).filter(Boolean);
  const components: string[] = [];
  let current = root;
  for (const name of names) {
    current = join(current, name);
    components.push(current);
  }
  return components;
}

function pathComponentsBetween(parent: string, child: string): string[] {
  const rel = relative(parent, child);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw invalidRunCronScript("resolved file must remain beneath the symlink trust directory");
  }
  const components: string[] = [];
  let current = parent;
  for (const name of rel.split(sep)) {
    current = join(current, name);
    components.push(current);
  }
  return components;
}

function invalidRunCronScript(invariant: string): Error {
  return new Error(`Invalid run cron script override: ${invariant}`);
}

function isInvalidRunCronScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Invalid run cron script override:");
}

function defaultCommandRunner(command: string, args: readonly string[]): LaunchdCommandResult {
  const result = spawnSync(command, [...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function plistsSemanticallyEqual(
  context: LaunchdCronContext,
  existingPath: string,
  desiredContent: string,
): boolean {
  const existing = parsePlistJson(context.plutilBin, existingPath);
  if (!existing.ok) {
    return false;
  }
  const desired = parsePlistJson(context.plutilBin, "-", desiredContent);
  return desired.ok && isDeepStrictEqual(existing.value, desired.value);
}

function parsePlistJson(
  plutilBin: string,
  inputPath: string,
  input?: string,
): { ok: true; value: unknown } | { ok: false } {
  try {
    const result = spawnSync(
      plutilBin,
      ["-convert", "json", "-o", "-", inputPath],
      { encoding: "utf8", input },
    );
    if (result.error || result.status !== 0) {
      return { ok: false };
    }
    return { ok: true, value: JSON.parse(result.stdout) as unknown };
  } catch {
    return { ok: false };
  }
}

function runPlutilLint(
  context: LaunchdCronContext,
  runner: LaunchdCommandRunner,
  commands: LaunchdCommandRecord[],
  plistPath: string,
): void {
  runCommand(context.plutilBin, ["-lint", plistPath], runner, commands, false);
}

function runLaunchctl(
  context: LaunchdCronContext,
  runner: LaunchdCommandRunner,
  commands: LaunchdCommandRecord[],
  args: string[],
  ignoreFailure: boolean,
): boolean {
  return runCommand(context.launchctlBin, args, runner, commands, ignoreFailure);
}

function runCommand(
  command: string,
  args: string[],
  runner: LaunchdCommandRunner,
  commands: LaunchdCommandRecord[],
  ignoreFailure: boolean,
): boolean {
  const result = runner(command, args);
  const failed = result.error !== undefined || result.status !== 0;
  const ignoredFailure = ignoreFailure && failed && isIgnorableBootoutFailure(args, result);
  commands.push({
    command,
    args,
    status: result.status,
    ignoredFailure,
  });
  if (ignoredFailure) {
    return false;
  }
  if (result.error && !ignoreFailure) {
    throw result.error;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    throw new Error(`${basename(command)} ${args.join(" ")} failed${stderr || stdout ? `: ${stderr || stdout}` : ""}`);
  }
  return true;
}

function listOwnedCronPlists(launchAgentsDir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(launchAgentsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".plist")) {
      continue;
    }
    const plistPath = resolve(launchAgentsDir, entry.name);
    const label = readLaunchdPlistLabel(plistPath);
    if (!isOwnedCronLaunchdLabel(label)) {
      continue;
    }
    found.set(label, plistPath);
  }
  return found;
}

function writeValidatedPlist(
  context: LaunchdCronContext,
  runner: LaunchdCommandRunner,
  commands: LaunchdCommandRecord[],
  plist: RenderedLaunchdCronPlist,
): string | undefined {
  const previousContent = existsSync(plist.plistPath) ? readFileSync(plist.plistPath, "utf8") : undefined;
  const tmpPath = `${plist.plistPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, plist.content, "utf8");
    runPlutilLint(context, runner, commands, tmpPath);
    renameSync(tmpPath, plist.plistPath);
    return previousContent;
  } catch (err) {
    if (existsSync(tmpPath)) {
      unlinkSync(tmpPath);
    }
    throw err;
  }
}

function restorePreviousPlist(plistPath: string, previousContent: string | undefined): void {
  if (previousContent === undefined) {
    if (existsSync(plistPath)) {
      unlinkSync(plistPath);
    }
    return;
  }
  writeFileSync(plistPath, previousContent, "utf8");
}

function renderExplicitPathEnvEntries(contract: ResolvedWorkspaceContract): string {
  const entries: string[] = [];
  if (contract.effectivePaths.configPath.source === "env") {
    entries.push(renderEnvEntry(MINIME_CONFIG_PATH_ENV, contract.paths.configPath));
  }
  if (contract.effectivePaths.cronsPath.source === "env") {
    entries.push(renderEnvEntry(MINIME_CRONS_PATH_ENV, contract.paths.cronsPath));
  }
  return entries.join("");
}

function renderEnvEntry(key: string, value: string): string {
  return `      <key>${xmlEscape(key)}</key>
      <string>${xmlEscape(value)}</string>
`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readLaunchdPlistLabel(plistPath: string): string {
  try {
    const content = readFileSync(plistPath, "utf8");
    const match = content.match(/<key>\s*Label\s*<\/key>\s*<string>([^<]+)<\/string>/);
    return match ? xmlUnescape(match[1]) : "";
  } catch {
    return "";
  }
}

function isIgnorableBootoutFailure(args: readonly string[], result: LaunchdCommandResult): boolean {
  if (args[0] !== "bootout") {
    return false;
  }
  const message = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
  return /not loaded|no such process|could not find service|service .*not found|no such file/i.test(message);
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function countPlanItems(items: readonly LaunchdCronPlanItem[]): Record<LaunchdCronPlanAction, number> {
  const counts: Record<LaunchdCronPlanAction, number> = {
    create: 0,
    update: 0,
    unchanged: 0,
    delete: 0,
  };
  for (const item of items) {
    counts[item.action] += 1;
  }
  return counts;
}

function describeLaunchdSchedule(schedule: string): string {
  const seconds = parseEveryScheduleSeconds(schedule);
  if (seconds !== undefined) {
    return `StartInterval(${seconds}s)`;
  }
  const intervals = parseCronToCalendarIntervals(schedule);
  return `${intervals?.length ?? 0} calendar interval(s)`;
}

function calendarIntervalToPlist(interval: CalendarInterval): string {
  const lines: string[] = [];
  lines.push("        <dict>");
  if (interval.Month !== undefined && interval.Month !== -1) {
    lines.push("          <key>Month</key>");
    lines.push(`          <integer>${interval.Month}</integer>`);
  }
  if (interval.Day !== undefined && interval.Day !== -1) {
    lines.push("          <key>Day</key>");
    lines.push(`          <integer>${interval.Day}</integer>`);
  }
  if (interval.Weekday !== undefined && interval.Weekday !== -1) {
    lines.push("          <key>Weekday</key>");
    lines.push(`          <integer>${interval.Weekday}</integer>`);
  }
  if (interval.Hour !== undefined && interval.Hour !== -1) {
    lines.push("          <key>Hour</key>");
    lines.push(`          <integer>${interval.Hour}</integer>`);
  }
  if (interval.Minute !== undefined && interval.Minute !== -1) {
    lines.push("          <key>Minute</key>");
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
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function resolveCliPath(path: string, cwd: string): string {
  return isAbsolute(path) ? normalize(path) : normalize(resolve(cwd, path));
}

function resolveUid(): number {
  if (typeof process.getuid === "function") {
    return process.getuid();
  }
  return userInfo().uid;
}
