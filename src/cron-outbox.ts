import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveWorkspaceContract } from "./workspace-contract.js";

export interface CronOutboxRecord {
  version: 1;
  cron: string;
  runId: string;
  kind: "output" | "failure-notice";
  payload: string;
  chatId: number;
  threadId?: number;
  createdAt: string;
  attempts: number;
}

export const CRON_HEALTH_TEXTFILE_DIR_ENV = "CRON_HEALTH_TEXTFILE_DIR";
export const DEFAULT_CRON_HEALTH_TEXTFILE_DIR =
  "/opt/homebrew/var/node_exporter/textfile";

export interface CronHealthMetricArtifacts {
  textfileDir: string;
  fileStem: string;
  exitFileName: string;
  exitFilePath: string;
  successFileName: string;
  successFilePath: string;
}

export function shortStableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function sanitizeCronMetricStem(cronName: string): string {
  const safeName = cronName.trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${safeName || "unnamed"}_${shortStableHash(cronName)}`;
}

export function resolveCronHealthTextfileDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env[CRON_HEALTH_TEXTFILE_DIR_ENV]?.trim()
    || DEFAULT_CRON_HEALTH_TEXTFILE_DIR;
}

export function resolveCronHealthMetricArtifacts(
  cronName: string,
  textfileDir = resolveCronHealthTextfileDir(),
): CronHealthMetricArtifacts {
  const fileStem = sanitizeCronMetricStem(cronName);
  const exitFileName = `minime_cron_${fileStem}.exit.prom`;
  const successFileName = `minime_cron_${fileStem}.success.prom`;
  return {
    textfileDir,
    fileStem,
    exitFileName,
    exitFilePath: join(textfileDir, exitFileName),
    successFileName,
    successFilePath: join(textfileDir, successFileName),
  };
}

function resolveCronOutboxDir(): string {
  return join(resolveWorkspaceContract().paths.dataDir, "cron-outbox");
}

function resolveCronOutboxRecordPath(cronName: string): string {
  return join(resolveCronOutboxDir(), `${sanitizeCronMetricStem(cronName)}.json`);
}

function isCronOutboxRecord(value: unknown, cronName: string): value is CronOutboxRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Partial<CronOutboxRecord>;
  return record.version === 1
    && record.cron === cronName
    && typeof record.runId === "string"
    && (record.kind === "output" || record.kind === "failure-notice")
    && typeof record.payload === "string"
    && typeof record.chatId === "number"
    && Number.isFinite(record.chatId)
    && (record.threadId === undefined
      || (typeof record.threadId === "number" && Number.isFinite(record.threadId)))
    && typeof record.createdAt === "string"
    && Number.isFinite(Date.parse(record.createdAt))
    && typeof record.attempts === "number"
    && Number.isInteger(record.attempts)
    && record.attempts >= 0;
}

export function writeCronOutboxRecord(record: CronOutboxRecord): void {
  const dir = resolveCronOutboxDir();
  const fileName = `${sanitizeCronMetricStem(record.cron)}.json`;
  const filePath = join(dir, fileName);
  const tmpPath = join(
    dir,
    `.${fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  try {
    writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // The temp file may not have been created or may already have been renamed.
    }
    throw err;
  }
}

export function readCronOutboxRecord(
  cronName: string,
): CronOutboxRecord | "corrupt" | undefined {
  let contents: string;
  try {
    contents = readFileSync(resolveCronOutboxRecordPath(cronName), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }

  try {
    const parsed: unknown = JSON.parse(contents);
    return isCronOutboxRecord(parsed, cronName) ? parsed : "corrupt";
  } catch {
    return "corrupt";
  }
}

export function clearCronOutboxRecord(cronName: string): void {
  try {
    unlinkSync(resolveCronOutboxRecordPath(cronName));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}
