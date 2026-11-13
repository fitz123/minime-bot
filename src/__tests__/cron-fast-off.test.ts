import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPi, runScript, type PiRunDeps } from "../cron-runner.js";
import { buildCronFastEnv, CRON_CODEX_SHIM_DIR_ENV, CRON_FAST_OFF_ENV, CRON_REAL_CODEX_ENV } from "../cron-fast-env.js";
import { applyCronFastOffToRequest } from "../pi-extensions/cron-fast-request.js";
import { buildPiAskAgentChildSpawnEnv, buildPiSpawnEnv, buildPiSubagentChildSpawnEnv, resolvePiAskAgentChildExtensionArgs, resolvePiSubagentChildExtensionArgs } from "../pi-rpc-protocol.js";
import { buildSubagentSpawnArgs } from "../pi-extensions/subagent-args.js";
import type { CronJob } from "../types.js";
import { installCronTestEnv } from "./cron-test-env.js";

installCronTestEnv();
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function fixture(t: TestContext): { root: string; bin: string; real: string } {
  const root = mkdtempSync(join(tmpdir(), "cron-fast-off-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const binary = join(root, "fake-codex.cjs");
  writeFileSync(binary, `#!${process.execPath}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  console.log(JSON.stringify({ args: process.argv.slice(2), input, marker: process.env.MINIME_CRON_FAST_OFF }));
  process.exit(process.argv.includes("--fixture-fail") ? 23 : 0);
});
`);
  chmodSync(binary, 0o755);
  const real = join(bin, "codex");
  symlinkSync(binary, real);
  return { root, bin, real };
}

function setEnv(t: TestContext, values: NodeJS.ProcessEnv): void {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

test("script cron marks descendants Fast off without changing the parent env", () => {
  const previous = process.env.MINIME_CRON_FAST_OFF;
  const cron = {
    name: "fast-off-script", type: "script", command: 'printf "%s" "$MINIME_CRON_FAST_OFF"',
  } as CronJob;
  assert.equal(runScript(cron), "1");
  assert.equal(process.env.MINIME_CRON_FAST_OFF, previous);
});

test("cron override replaces any tier without mutating model, reasoning or the original body", () => {
  for (const service_tier of [undefined, "priority", "auto", "default"]) {
    const body = { model: "gpt-6-astra", reasoning: { effort: "high" }, service_tier };
    assert.deepEqual(applyCronFastOffToRequest(body, body.model), { ...body, service_tier: "default" });
    assert.equal(body.service_tier, service_tier);
  }
  for (const body of [undefined, null, [], 1, "body", { model: "other-model" }]) {
    assert.equal(applyCronFastOffToRequest(body, "gpt-6-astra"), undefined);
  }
});

test("cron CLI shim preserves the real symlink, argv, stdin and exit status", t => {
  const { bin, real } = fixture(t);
  const original = { PATH: `${bin}:/usr/bin:/bin`, KEEP: "unchanged" };
  const env = buildCronFastEnv(original);
  assert.deepEqual(original, { PATH: `${bin}:/usr/bin:/bin`, KEEP: "unchanged" });
  assert.equal(env[CRON_REAL_CODEX_ENV], real);
  const shim = join(env[CRON_CODEX_SHIM_DIR_ENV], "codex");
  const args = ["exec", "-", 'a prompt with spaces, "quotes", $value and `literal`'];
  for (const failure of [false, true]) {
    const passedArgs = failure ? [...args, "--fixture-fail"] : args;
    const result = spawnSync(shim, passedArgs, { env, input: "stdin prompt\nsecond line\n", encoding: "utf8" });
    assert.equal(result.status, failure ? 23 : 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["-c", 'service_tier="default"', "-c", `shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`, ...passedArgs], input: "stdin prompt\nsecond line\n", marker: "1",
    });
  }
  assert.deepEqual(buildCronFastEnv(env), env, "nested cron does not duplicate the shim");
  const missing = spawnSync(shim, [], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  assert.equal(missing.status, 127);
  assert.match(missing.stderr, /must name the real Codex executable/);
  const recursive = spawnSync(shim, [], { env: { [CRON_REAL_CODEX_ENV]: shim }, encoding: "utf8" });
  assert.equal(recursive.status, 127);
});

test("cron CLI shim captures exact PATH as a TOML string and preserves model, reasoning and argv order", t => {
  const { bin } = fixture(t);
  const args = ["--model", "gpt-6-astra", "-c", 'model_reasoning_effort="high"', "exec", "--json", "--", 'prompt with "quotes", $value and `literal`'];
  for (const extra of [
    ":/plain::/trailing/:",
    String.raw`:/spaces and 'single' "double" quotes/with\backslashes/$value/$(literal)/\n/\"/é`,
    ":/controls\b\t\n\f\r/end",
  ]) {
    const env = buildCronFastEnv({ PATH: `${bin}${extra}` });
    const result = spawnSync(join(env[CRON_CODEX_SHIM_DIR_ENV], "codex"), args, { env, input: "", encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(result.stdout);
    assert.deepEqual(captured.args.slice(0, 3), ["-c", 'service_tier="default"', "-c"]);
    const prefix = "shell_environment_policy.set.PATH=";
    assert.ok(captured.args[3]?.startsWith(prefix));
    // These JSON escapes are also TOML basic-string escapes; round-trip the value.
    assert.equal(JSON.parse(captured.args[3].slice(prefix.length)), env.PATH);
    assert.deepEqual(captured.args.slice(4), args);
  }
});

test("script cron resolves the shim on PATH and leaves its parent untouched", t => {
  const { bin } = fixture(t);
  setEnv(t, { PATH: `${bin}:/usr/bin:/bin` });
  const keys = ["PATH", CRON_FAST_OFF_ENV, CRON_REAL_CODEX_ENV, CRON_CODEX_SHIM_DIR_ENV];
  const before = keys.map(key => process.env[key]);
  const output = runScript({ name: "cli-script", type: "script", command: "printf 'script input' | codex exec - 'script prompt'" } as CronJob);
  assert.deepEqual(JSON.parse(output), {
    args: ["-c", 'service_tier="default"', "-c", `shell_environment_policy.set.PATH=${JSON.stringify(buildCronFastEnv({ PATH: process.env.PATH }).PATH)}`, "exec", "-", "script prompt"], input: "script input", marker: "1",
  });
  assert.deepEqual(keys.map(key => process.env[key]), before);
});

test("runPi passes enforced env and the real cron wrapper without changing model or reasoning", t => {
  const { root, bin, real } = fixture(t);
  const deps: PiRunDeps = {
    buildAgentConfig: () => ({ id: "fixture", workspaceCwd: root, model: "openai-codex/gpt-6-astra", thinking: "high" }),
    buildEnv: () => ({ PATH: `${bin}:/usr/bin:/bin` }),
    assembleContext: () => null,
    spawnSync: (_command, args, options) => {
      assert.equal(options.env?.[CRON_FAST_OFF_ENV], "1");
      assert.equal(options.env?.[CRON_REAL_CODEX_ENV], real);
      assert.equal(options.env?.PATH?.split(":")[0], options.env?.[CRON_CODEX_SHIM_DIR_ENV]);
      assert.equal(args[args.indexOf("--model") + 1], "openai-codex/gpt-6-astra");
      assert.equal(args[args.indexOf("--thinking") + 1], "high");
      assert.ok(args.some(arg => /codex-fast\.(ts|js)$/.test(arg)));
      assert.ok(args.some(arg => arg.includes(`direct absolute Codex CLI calls must include -c 'service_tier="default"'`)));
      return { pid: 1, status: 0, signal: null, output: [null, "fixture report", ""], stdout: "fixture report", stderr: "" };
    },
  };
  assert.equal(runPi({ name: "pi-fixture", prompt: "fixture prompt", agentId: "fixture" } as CronJob, root, deps), "fixture report");
});

test("missing Codex keeps PATH unchanged, while a non-executable shim fails clearly", t => {
  const { root, bin } = fixture(t);
  const env = buildCronFastEnv({ PATH: root });
  assert.deepEqual(env, { PATH: root, [CRON_FAST_OFF_ENV]: "1" });
  const shim = join(packageRoot, "scripts/cron-bin/codex");
  chmodSync(shim, 0o644);
  try {
    assert.throws(() => buildCronFastEnv({ PATH: bin }), /shim is missing or not executable/);
  } finally {
    chmodSync(shim, 0o755);
  }
});

test("only marked cron parents propagate the contract; interactive env clears shim and scope state", t => {
  const { bin, real } = fixture(t);
  const cronEnv = buildCronFastEnv({ PATH: `${bin}:/usr/bin:/bin` });
  setEnv(t, { ...cronEnv, MINIME_BOT_PI_SESSION_AGENT_ID: "caller", MINIME_BOT_PI_SESSION_THREAD_KEY: "caller-topic", OPENAI_API_KEY: "fixture-not-a-credential" });
  for (const child of [buildPiAskAgentChildSpawnEnv(undefined, "target"), buildPiSubagentChildSpawnEnv()]) {
    assert.equal(child[CRON_FAST_OFF_ENV], "1");
    assert.equal(child[CRON_REAL_CODEX_ENV], real);
    assert.equal(child.PATH.split(":")[0], cronEnv[CRON_CODEX_SHIM_DIR_ENV]);
    assert.equal(child.PATH.split(":").filter(part => part === cronEnv[CRON_CODEX_SHIM_DIR_ENV]).length, 1);
    assert.equal(child.MINIME_BOT_PI_SESSION_THREAD_KEY, undefined);
    assert.equal(child.OPENAI_API_KEY, undefined);
  }
  assert.equal(buildPiAskAgentChildSpawnEnv(undefined, "target").MINIME_BOT_PI_SESSION_AGENT_ID, "target");
  assert.equal(buildPiSubagentChildSpawnEnv().MINIME_BOT_PI_SESSION_AGENT_ID, undefined);
  const interactive = buildPiSpawnEnv(undefined, { askCallerAgentId: "interactive", fastThreadKey: "actual-topic" });
  for (const key of [CRON_FAST_OFF_ENV, CRON_REAL_CODEX_ENV, CRON_CODEX_SHIM_DIR_ENV]) assert.equal(interactive[key], undefined);
  assert.ok(!interactive.PATH.includes(cronEnv[CRON_CODEX_SHIM_DIR_ENV]));
  assert.equal(interactive.MINIME_BOT_PI_SESSION_THREAD_KEY, "actual-topic");
  delete process.env[CRON_FAST_OFF_ENV];
  assert.equal(buildPiSubagentChildSpawnEnv()[CRON_REAL_CODEX_ENV], undefined);
});

test("actual child argv resolver selects Fast only for cron subagents in source and artifacts", () => {
  for (const [dir, suffix] of [["extensions/pi", "ts"], ["dist/extensions/pi", "js"]]) {
    const options = { extensionsDir: join(packageRoot, dir) };
    for (const marked of [false, true]) {
      const env = marked ? { [CRON_FAST_OFF_ENV]: "1" } : {};
      const extensionArgs = resolvePiSubagentChildExtensionArgs({ ...options, env });
      const args = buildSubagentSpawnArgs({}, "delegated task", { extensionArgs });
      const expected = ["codex-transport-overflow", "web-tools", "knowledge-tools", ...(marked ? ["codex-fast"] : [])];
      assert.deepEqual(extensionArgs, expected.flatMap(name => ["--extension", join(options.extensionsDir, `${name}.${suffix}`)]));
      assert.deepEqual(args.slice(-extensionArgs.length - 1), [...extensionArgs, "Task: delegated task"]);
      assert.ok(resolvePiAskAgentChildExtensionArgs({ ...options, env }).includes(join(options.extensionsDir, `codex-fast.${suffix}`)));
    }
  }
});
