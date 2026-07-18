import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

export interface CronTestEnv {
  root: string;
  logDir: string;
  metricsDir: string;
  controlRoot: string;
}

const CRON_TEST_ENV_KEYS = [
  "LOG_DIR",
  "CRON_HEALTH_TEXTFILE_DIR",
  "MINIME_CONTROL_WORKSPACE_ROOT",
] as const;

export function installCronTestEnv(): CronTestEnv {
  const root = mkdtempSync(join(tmpdir(), "minime-cron-test-"));
  const logDir = join(root, "logs");
  const metricsDir = join(root, "metrics");
  const controlRoot = join(root, "control");
  const savedEnv = Object.fromEntries(
    CRON_TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof CRON_TEST_ENV_KEYS)[number], string | undefined>;

  for (const dir of [logDir, metricsDir, controlRoot]) {
    mkdirSync(dir, { recursive: true });
  }
  process.env.LOG_DIR = logDir;
  process.env.CRON_HEALTH_TEXTFILE_DIR = metricsDir;
  process.env.MINIME_CONTROL_WORKSPACE_ROOT = controlRoot;

  after(() => {
    for (const key of CRON_TEST_ENV_KEYS) {
      const savedValue = savedEnv[key];
      if (savedValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedValue;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  return { root, logDir, metricsDir, controlRoot };
}
