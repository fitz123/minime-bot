import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..", "..");
const retiredProductSegment = ["ops", "worker"].join("-");
const retiredPrimaryResourceModule = ["pi", "primary", "resources"].join("-");

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

  it("does not retain removed product modules, documentation, or CLI imports", () => {
    const retiredPaths = [
      join("src", retiredProductSegment, "worker-cli.ts"),
      join("src", `${retiredPrimaryResourceModule}.ts`),
      join("docs", `${retiredProductSegment}.md`),
    ];
    for (const relativePath of retiredPaths) {
      assert.equal(existsSync(resolve(packageRoot, relativePath)), false, relativePath);
    }

    assert.equal(readPackageFile("src/cli.ts").includes(retiredProductSegment), false);
  });

  it("keeps the standalone agent runtime inert on import and exposes its own help", () => {
    const imported = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", [
      'const before = process.listenerCount("SIGTERM");',
      'await import("./src/agent-runtime.ts");',
      'if (process.listenerCount("SIGTERM") !== before) throw new Error("runtime activated on import");',
    ].join("\n")], { cwd: packageRoot, encoding: "utf8", timeout: 10_000 });
    assert.equal(imported.status, 0, imported.stderr);
    assert.equal(imported.stdout, "");
    const help = spawnSync(process.execPath, ["--import", "tsx", "src/agent-runtime.ts", "--help"], {
      cwd: packageRoot, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /minime-agent-runtime --descriptor/);
    const binLink = join(mkdtempSync(join(tmpdir(), "agent-runtime-bin-")), "runtime.ts");
    symlinkSync(resolve(packageRoot, "src/agent-runtime.ts"), binLink);
    const linkedHelp = spawnSync(process.execPath, ["--import", "tsx", binLink, "--help"], {
      cwd: packageRoot, encoding: "utf8", timeout: 10_000,
    });
    assert.equal(linkedHelp.status, 0, linkedHelp.stderr);
    assert.match(linkedHelp.stdout, /minime-agent-runtime --descriptor/);
    const pkg = JSON.parse(readPackageFile("package.json"));
    assert.equal(pkg.bin["minime-agent-runtime"], "./dist/agent-runtime.js");
  });
});
