import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");
const workflowsDir = resolve(packageRoot, ".github", "workflows");

function readWorkflow(name: string): string {
  return readFileSync(resolve(workflowsDir, name), "utf-8");
}

describe("GitHub workflows", () => {
  it("checks pull request commit author emails", () => {
    const workflow = readWorkflow("author-identity.yml");

    assert.ok(workflow.includes("pull_request:"));
    assert.ok(workflow.includes("branches: [main]"));
    assert.ok(workflow.includes("actions/checkout@v4"));
    assert.ok(workflow.includes("users\\.noreply\\.github\\.com$"));
  });

  it("runs package validation on pull requests", () => {
    const workflow = readWorkflow("ci.yml");

    for (const expected of [
      "pull_request:",
      "branches: [main]",
      "actions/setup-node@v4",
      'node-version: "22.19.0"',
      "npm ci",
      "npm test",
      "npm run build",
      "npm pack --dry-run",
      "npm run check:schema-guard-contract",
    ]) {
      assert.ok(workflow.includes(expected), `ci.yml should include ${expected}`);
    }
  });

  it("does not add a gitleaks workflow without repo secret configuration", () => {
    const workflowFiles = existsSync(workflowsDir) ? readdirSync(workflowsDir) : [];

    assert.ok(
      workflowFiles.every((file) => !file.toLowerCase().includes("gitleaks")),
      "gitleaks workflow should not be added for this repository",
    );
  });
});
