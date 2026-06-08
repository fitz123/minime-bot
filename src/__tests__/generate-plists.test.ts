import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MINIME_CONTROL_WORKSPACE_ROOT_ENV } from "../workspace-contract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");
const scriptPath = join(packageRoot, "scripts", "generate-plists.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const retiredControlWorkspaceEnv = ["MINIME", "WORKSPACE", "ROOT"].join("_");

describe("generate-plists.ts", () => {
  it("writes launchd cron plists with the canonical control workspace env only", () => {
    const temp = mkdtempSync(join(tmpdir(), "minime-generate-plists-"));
    try {
      const home = join(temp, "home");
      const workspace = join(temp, "control-workspace");
      const retiredWorkspace = join(temp, "retired-control-workspace");
      const logDir = join(temp, "logs");
      mkdirSync(home, { recursive: true });
      mkdirSync(workspace, { recursive: true });
      writeFileSync(
        join(workspace, "crons.yaml"),
        [
          "crons:",
          "  - name: workspace-task",
          '    schedule: "0 9 * * *"',
          '    prompt: "workspace"',
          "    agentId: main",
          "    deliveryChatId: 111111111",
          "",
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, ["--import", tsxLoader, scriptPath], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          LOG_DIR: logDir,
          [MINIME_CONTROL_WORKSPACE_ROOT_ENV]: workspace,
          [retiredControlWorkspaceEnv]: retiredWorkspace,
        },
        timeout: 60_000,
      });

      assert.equal(result.status, 0, result.stderr || result.stdout);
      const plistPath = join(home, "Library", "LaunchAgents", "ai.minime.cron.workspace-task.plist");
      const plist = readFileSync(plistPath, "utf8");
      assert.ok(plist.includes(`<key>${MINIME_CONTROL_WORKSPACE_ROOT_ENV}</key>`));
      assert.ok(plist.includes(`<string>${workspace}</string>`));
      assert.ok(!plist.includes(retiredControlWorkspaceEnv));
      assert.ok(!plist.includes(retiredWorkspace));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
