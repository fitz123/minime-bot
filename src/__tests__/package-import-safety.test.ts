import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");

const requiredPackageInputs = [
  "src",
  "scripts",
  "test-fixtures",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "telegram-bot.plist.example",
];

const forbiddenTrackedPathPatterns = [
  /^node_modules\//,
  /^dist\//,
  /^\.tmp\//,
  /^\.claude\//,
  /^config\.yaml$/,
  /^config\.local\.yaml$/,
  /^crons\.yaml$/,
  /^crons\.local\.yaml$/,
  /^CLAUDE\.md$/,
  /^USER\.md$/,
  /^IDENTITY\.md$/,
  /^MEMORY\.md$/,
  /^reference\//,
  /^memory\//,
  /\.log$/,
];
const forbiddenLegacyAuthor = ["Nico", "Bailon"].join(" ");

function readPackageFile(relativePath: string): string {
  return readFileSync(resolve(packageRoot, relativePath), "utf8");
}

describe("package root import safety", () => {
  it("keeps all allowed package inputs present at the package root", () => {
    for (const relativePath of requiredPackageInputs) {
      assert.ok(existsSync(resolve(packageRoot, relativePath)), `${relativePath} should exist`);
    }
  });

  it("keeps public-safe package and license metadata", () => {
    const packageJson = JSON.parse(readPackageFile("package.json")) as { author?: string };
    const license = readPackageFile("LICENSE");

    assert.equal(packageJson.author, "Minime Bot contributors");
    assert.match(license, /MIT License/);
    assert.ok(!JSON.stringify(packageJson).includes(forbiddenLegacyAuthor));
    assert.ok(!license.includes(forbiddenLegacyAuthor));
  });

  it("does not track generated runtime or private workspace-root paths", () => {
    const result = spawnSync("git", ["ls-files"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    const trackedFiles = result.stdout.split("\n").filter(Boolean);
    const forbiddenFiles = trackedFiles.filter((file) =>
      forbiddenTrackedPathPatterns.some((pattern) => pattern.test(file)),
    );
    assert.deepEqual(forbiddenFiles, []);
  });
});
