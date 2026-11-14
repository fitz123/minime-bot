import { after, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { Api } from "grammy";
import { DELIVERY_NOT_SENT, runAgentAnswerDelivery } from "../agent-answer-delivery-cli.js";
import { prepareRichAnswer } from "../telegram-rich.js";

const root = mkdtempSync(join(tmpdir(), "agent-answer-delivery-"));
const savedEcho = process.env.ECHO_DIR_BASE;
afterEach(() => {
  if (savedEcho === undefined) delete process.env.ECHO_DIR_BASE;
  else process.env.ECHO_DIR_BASE = savedEcho;
});
after(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
const report = "# Research overview\n\n" + "A synthetic observation supports further comparison. ".repeat(100)
  + "\n\n## Sources\n\nRead the [reference](https://example.com/research).";
const longReport = Array.from({ length: 12 }, (_, index) =>
  `## Observation ${index + 1}\n\n${"Synthetic research findings support comparison. ".repeat(90)}`).join("\n\n");

function harness(failure?: number | "network" | "timeout", failAt = 1) {
  const echoDir = join(root, `echo-${++sequence}`);
  process.env.ECHO_DIR_BASE = echoDir;
  const calls: Array<{ method: string; body: any }> = [];
  let stdout = "";
  let stderr = "";
  let creations = 0;
  const api = new Api("test:fixture", {
    timeoutSeconds: failure === "timeout" ? 0.01 : 30,
    fetch: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      calls.push({ method: String(url).split("/").at(-1)!, body: JSON.parse(init!.body as string) });
      if (calls.length === failAt) {
        if (failure === "network") throw new Error(`private transport URL ${url}`);
        if (failure === "timeout") return new Promise(() => {});
        if (failure) return Response.json({ ok: false, error_code: failure, description: `rejected ${url}` });
      }
      return Response.json({ ok: true, result: { message_id: calls.length } });
    },
  });
  return {
    calls, echoDir,
    output: () => ({ stdout, stderr }),
    creations: () => creations,
    echoes: () => existsSync(join(echoDir, "-123"))
      ? readdirSync(join(echoDir, "-123")).map(file => JSON.parse(readFileSync(join(echoDir, "-123", file), "utf8"))) : [],
    run: (source = report, args = ["-123", "--thread", "42"], token: string | undefined = "test:fixture") =>
      runAgentAnswerDelivery(args, source, {
        env: { TELEGRAM_BOT_TOKEN: token },
        createApi: supplied => { creations++; assert.equal(supplied, "test:fixture"); return api; },
        stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
      }),
  };
}

describe("detached native agent answers", () => {
  it("sends a report over 4096 characters as one native rich payload through the real adapter", async () => {
    assert.ok(report.length > 4096);
    const h = harness();
    assert.equal(await h.run(), 0);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].method, "sendRichMessage");
    assert.equal(h.calls[0].body.chat_id, -123);
    assert.equal(h.calls[0].body.message_thread_id, 42);
    assert.deepEqual(h.calls[0].body.rich_message, { markdown: report, media: [] });
    assert.equal(h.calls[0].body.parse_mode, undefined);
    assert.equal(h.output().stdout, "");
    assert.deepEqual(h.echoes().map(e => [e.chatId, e.threadId, e.text, e.origin]), [["-123", "42", report, "deliver.sh"]]);
  });

  it("preserves native heading and paragraph blocks for simple research prose without a thread", async () => {
    const h = harness();
    assert.equal(await h.run("# Overview\n\nFirst finding.\n\nSecond finding.", ["-123"]), 0);
    assert.deepEqual(h.calls[0].body.rich_message.blocks, [
      { type: "heading", size: 1, text: "Overview" },
      { type: "paragraph", text: "First finding." },
      { type: "paragraph", text: "Second finding." },
    ]);
    assert.equal(h.calls[0].body.message_thread_id, undefined);
    assert.equal(h.echoes()[0].threadId, null);
  });

  it("sends all rich chunks once and echoes only confirmed source projections", async () => {
    const h = harness();
    const prepared = prepareRichAnswer(longReport);
    assert.ok(prepared.chunks.length > 1);
    assert.equal(await h.run(longReport), 0);
    assert.equal(h.calls.length, prepared.chunks.length);
    assert.ok(h.calls.every(c => c.method === "sendRichMessage"));
    assert.deepEqual(h.echoes().map(e => e.text).sort(), prepared.chunks.map(c => c.options.indexText).sort());
  });

  it("preserves the General topic thread ID of zero", async () => {
    const h = harness();
    assert.equal(await h.run("A synthetic finding.", ["-123", "--thread", "0"]), 0);
    assert.equal(h.calls[0].body.message_thread_id, 0);
    assert.equal(h.echoes()[0].threadId, "0");
  });

  for (const failure of [400, 429, 500, "network", "timeout"] as const) {
    for (const chunk of [1, 2]) {
      it(`leaves ${failure} at chunk ${chunk} uncertain, without retry or ordinary fallback`, async () => {
        const h = harness(failure, chunk);
        assert.equal(await h.run(longReport), 1);
        assert.equal(h.calls.length, chunk);
        assert.ok(h.calls.every(c => c.method === "sendRichMessage"));
        assert.equal(h.echoes().length, chunk - 1);
        assert.equal(h.output().stdout, "");
        assert.match(h.output().stderr, /uncertain/);
        assert.doesNotMatch(h.output().stderr, /test:fixture|https?:|FULL_CYCLE_DELIVERY_NOT_SENT/);
        assert.ok(h.output().stderr.length < 200);
      });
    }
  }

  const badInputs: Array<[string[], string, string | undefined]> = [
    [["9007199254740992"], report, "test:fixture"],
    [["0"], report, "test:fixture"],
    [["@fixture"], report, "test:fixture"],
    [["-123", "--thread", "9007199254740992"], report, "test:fixture"],
    [["-123", "--thread", "-1"], report, "test:fixture"],
    [["-123", "--thread"], report, "test:fixture"],
    [["-123"], " \n\n", "test:fixture"],
    [["-123"], `${longReport}\n\n![Figure](outbox:missing.png)`, "test:fixture"],
    [["-123"], report, ""],
  ];
  for (const [index, [args, source, token]] of badInputs.entries()) {
    it(`rejects preflight case ${index + 1} before creating or calling the API`, async () => {
      const h = harness();
      assert.equal(await h.run(source, args, token), 1);
      assert.equal(h.output().stdout, `${DELIVERY_NOT_SENT}\n`);
      assert.equal(h.creations(), 0);
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.echoes(), []);
    });
  }

  it("does not fail or retry a confirmed send when the echo spool is unavailable", async () => {
    const h = harness();
    writeFileSync(h.echoDir, "blocked fixture spool");
    assert.equal(await h.run(), 0);
    assert.equal(h.calls.length, 1);
  });
});

// Exercise the actual shell and CLI entry points, retaining grammY serialization.
// A test-only preload replaces Api construction with an Api using fake fetch.
function runShell(mode: "dist" | "source", args: string[], input: string, failAt = 0) {
  const fixture = join(root, `shell-${++sequence}`);
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  copyFileSync(resolve("scripts/deliver.sh"), join(fixture, "scripts/deliver.sh"));
  writeFileSync(join(fixture, "package.json"), '{"type":"module"}');
  mkdirSync(join(fixture, "node_modules", ".bin"), { recursive: true });
  symlinkSync(resolve("node_modules/grammy"), join(fixture, "node_modules/grammy"), "dir");
  symlinkSync(resolve(mode === "source" ? "src" : "dist"), join(fixture, mode === "source" ? "src" : "dist"), "dir");
  const nodeWrapper = join(fixture, "node");
  writeFileSync(nodeWrapper, '#!/bin/bash\nexec "$FAKE_NODE" --experimental-test-module-mocks --import "$FAKE_PRELOAD" "$@"\n');
  chmodSync(nodeWrapper, 0o755);
  const tsxWrapper = join(fixture, "node_modules/.bin/tsx");
  writeFileSync(tsxWrapper, '#!/bin/bash\nexec "$FAKE_NODE" --experimental-test-module-mocks --import "$FAKE_PRELOAD" --import tsx "$@"\n');
  chmodSync(tsxWrapper, 0o755);
  const capture = join(fixture, "calls.jsonl");
  const curl = join(fixture, "curl");
  writeFileSync(curl, `#!/bin/bash
set -euo pipefail
payload=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-d" ]; then shift; payload="$1"; fi
  shift
done
cat >/dev/null
printf '{"method":"sendMessage","body":%s}\\n' "$payload" >> "$FAKE_CAPTURE"
printf '{"ok":true}'
`);
  chmodSync(curl, 0o755);
  const preload = join(fixture, "preload.mjs");
  writeFileSync(preload, `
import { mock } from 'node:test';
import { appendFileSync } from 'node:fs';
import { Api, InputFile } from 'grammy';
let calls = 0;
mock.module('grammy', { namedExports: { InputFile, Api: class extends Api {
  constructor(token, options) {
    super(token, { ...options, fetch: async (url, init) => {
      calls++;
      appendFileSync(process.env.FAKE_CAPTURE, JSON.stringify({ method: String(url).split('/').at(-1), body: JSON.parse(init.body) }) + '\\n');
      if (calls === Number(process.env.FAKE_FAIL_AT)) throw new Error('synthetic network failure');
      return Response.json({ ok: true, result: { message_id: calls } });
    }});
  }
}}});
`);
  const result = spawnSync("/bin/bash", [join(fixture, "scripts/deliver.sh"), ...args], {
    input, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, NODE_BIN: nodeWrapper, CURL_BIN: curl, HOME: fixture,
      NODE_OPTIONS: "", FAKE_NODE: process.execPath, FAKE_PRELOAD: pathToFileURL(preload).href,
      TELEGRAM_BOT_TOKEN: "test:fixture", ECHO_DIR_BASE: join(fixture, "echo"),
      FAKE_CAPTURE: capture, FAKE_FAIL_AT: String(failAt) },
  });
  return { ...result, calls: existsSync(capture) ? readFileSync(capture, "utf8").trim().split("\n").map(s => JSON.parse(s)) : [] };
}

describe("deliver.sh agent-answer entry", () => {
  for (const purpose of [[], ["--purpose", "service"]]) {
    it(`keeps ${purpose.length ? "explicit" : "default"} service delivery ordinary`, () => {
      const h = runShell("dist", ["-123", ...purpose, "--thread", "42"], "A synthetic service notice.");
      assert.equal(h.status, 0, h.stderr);
      assert.equal(h.stdout, "");
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].method, "sendMessage");
      assert.equal(h.calls[0].body.text, "A synthetic service notice.");
      assert.equal(h.calls[0].body.message_thread_id, 42);
    });
  }
  for (const args of [
    ["invalid", "--purpose", "agent-answer"],
    ["-123", "--purpose", "agent-answer", "--thread"],
    ["-123", "--thread", "invalid", "--purpose", "agent-answer"],
    ["9007199254740992", "--purpose", "agent-answer"],
  ]) {
    it("rejects invalid shell destinations/options before sending", () => {
      const h = runShell("dist", args, report);
      assert.equal(h.status, 1, h.stderr);
      assert.equal(h.stdout, `${DELIVERY_NOT_SENT}\n`);
      assert.deepEqual(h.calls, []);
    });
  }
  for (const mode of ["dist", "source"] as const) {
    for (const options of [["--thread", "42", "--purpose", "agent-answer"], ["--purpose", "agent-answer", "--thread", "42"]]) {
      it(`runs the ${mode} CLI with options ${options[0]} first`, () => {
        const h = runShell(mode, ["-123", ...options], report);
        assert.equal(h.status, 0, h.stderr);
        assert.equal(h.stdout, "");
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0].method, "sendRichMessage");
        assert.deepEqual(h.calls[0].body.rich_message, { markdown: report, media: [] });
        assert.equal(h.calls[0].body.message_thread_id, 42);
      });
    }
  }
  it("accepts message arguments without a thread", () => {
    const h = runShell("dist", ["-123", "--purpose", "agent-answer", "# Research", "summary"], "");
    assert.equal(h.status, 0, h.stderr);
    assert.equal(h.calls[0].body.message_thread_id, undefined);
    assert.deepEqual(h.calls[0].body.rich_message.blocks, [{ type: "heading", size: 1, text: "Research summary" }]);
  });
  for (const source of ["", "  ", `${longReport}\n\n![Figure](outbox:missing.png)`]) {
    it("marks shell preflight rejection with no requests", () => {
      const h = runShell("dist", ["-123", "--purpose", "agent-answer"], source);
      assert.equal(h.status, 1, h.stderr);
      assert.equal(h.stdout, `${DELIVERY_NOT_SENT}\n`);
      assert.deepEqual(h.calls, []);
    });
  }
  it("does not mark or fall back after a later API request fails", () => {
    const h = runShell("dist", ["-123", "--purpose", "agent-answer"], longReport, 2);
    assert.equal(h.status, 1, h.stderr);
    assert.equal(h.stdout, "");
    assert.equal(h.calls.length, 2);
    assert.ok(h.calls.every(c => c.method === "sendRichMessage"));
  });
});
