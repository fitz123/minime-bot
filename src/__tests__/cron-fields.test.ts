import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateCronForPlist, type CronPlistDef } from "../cron-plist.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");

function readPackageFile(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), "utf-8");
}

describe("cron field contract", () => {
  const cronFields = [
    "type",
    "engine",
    "timeout",
    "deliveryThreadId",
    "enabled",
  ];

  it("types.ts CronJob interface has the supported cron fields", () => {
    const typesSource = readPackageFile("src/types.ts");
    const cronJobMatch = typesSource.match(/export interface CronJob \{[\s\S]*?\}/);
    assert.ok(cronJobMatch, "CronJob interface not found in types.ts");

    for (const field of cronFields) {
      assert.ok(
        cronJobMatch[0].includes(field),
        `CronJob interface does not include '${field}' field`,
      );
    }
  });

  it("cron-plist.ts CronPlistDef interface has the supported cron fields", () => {
    const cronPlistSource = readPackageFile("src/cron-plist.ts");
    const cronPlistMatch = cronPlistSource.match(/export interface CronPlistDef \{[\s\S]*?\}/);
    assert.ok(cronPlistMatch, "CronPlistDef interface not found in cron-plist.ts");

    for (const field of ["type", "engine", "timeout", "enabled"]) {
      assert.ok(
        cronPlistMatch[0].includes(field),
        `CronPlistDef interface does not include '${field}' field`,
      );
    }
  });

  it("plist generator validates LLM engine values", () => {
    const validPiCron: CronPlistDef = {
      name: "valid-pi",
      schedule: "0 * * * *",
      type: "llm",
      engine: "pi",
      prompt: "Summarize status",
      agentId: "main",
    };
    const invalidPiCron: CronPlistDef = {
      ...validPiCron,
      name: "invalid-pi",
      engine: "bad" as unknown as CronPlistDef["engine"],
    };
    const scriptCron: CronPlistDef = {
      name: "script-bad-engine",
      schedule: "0 * * * *",
      type: "script",
      engine: "bad" as unknown as CronPlistDef["engine"],
      command: "echo ok",
      agentId: "main",
    };

    assert.strictEqual(validateCronForPlist(validPiCron), undefined);
    assert.match(
      validateCronForPlist(invalidPiCron) ?? "",
      /invalid-pi has invalid engine "bad"/,
    );
    assert.strictEqual(validateCronForPlist(scriptCron), undefined);
  });

  it("rejects unsafe plist names and malformed schedules deterministically", () => {
    const baseCron: CronPlistDef = {
      name: "safe-name_1.2",
      schedule: "*/15 9-17 * * 1-5",
      type: "llm",
      engine: "pi",
      prompt: "Summarize status",
      agentId: "main",
    };

    assert.strictEqual(validateCronForPlist(baseCron), undefined);
    assert.match(
      validateCronForPlist({ ...baseCron, name: "../escape" }) ?? "",
      /invalid name/,
    );
    assert.match(
      validateCronForPlist({ ...baseCron, schedule: "*/0 * * * *" }) ?? "",
      /step must be positive/,
    );
    assert.match(
      validateCronForPlist({ ...baseCron, schedule: "61 * * * *" }) ?? "",
      /outside allowed range 0-59/,
    );
    assert.match(
      validateCronForPlist({ ...baseCron, schedule: "every nope" }) ?? "",
      /every interval must be a positive integer/,
    );
  });
});
