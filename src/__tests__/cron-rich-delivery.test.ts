import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api } from "grammy";
import { deliver, main, CRON_DELIVERY_RETRY_DELAYS_MS,
  type CronRunnerMainDeps } from "../cron-runner.js";
import { readCronOutboxRecord, writeCronOutboxRecord } from "../cron-outbox.js";
import { RICH_TEXT_BYTES } from "../telegram-rich.js";
import { EchoWatcher } from "../echo-watcher.js";
import { installCronTestEnv } from "./cron-test-env.js";

const env = installCronTestEnv();
const originalEcho = process.env.ECHO_DIR_BASE;
const originalOutbox = process.env.MINIME_OUTBOX;
afterEach(() => {
  if (originalEcho === undefined) delete process.env.ECHO_DIR_BASE;
  else process.env.ECHO_DIR_BASE = originalEcho;
  if (originalOutbox === undefined) delete process.env.MINIME_OUTBOX;
  else process.env.MINIME_OUTBOX = originalOutbox;
});

class Exit extends Error {}
let sequence = 0;
function harness(output = "# Result\n\nA short report.", type: "llm" | "script" = "llm") {
  const name = `rich-cron-${++sequence}`;
  const echoDir = join(env.root, name);
  process.env.ECHO_DIR_BASE = echoDir;
  const calls: Array<{ method: string; body: Record<string, any> }> = [];
  const ordinary: string[] = [];
  const sleeps: number[] = [];
  const errors: string[] = [];
  const metrics: string[] = [];
  let generated = 0;
  let failure: number | "network" | undefined;
  let failChunk: number | undefined;
  const api = new Api("test:fixture", {
    fetch: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      assert.ok(String(url).includes("/bottest:fixture/"), "uses the configured sender token");
      const method = String(url).split("/").at(-1)!;
      const body = JSON.parse(init!.body as string);
      calls.push({ method, body });
      if (failure !== undefined && (failChunk === undefined || calls.length % 2 === failChunk)) {
        if (failure === "network") throw new Error("synthetic transport failure");
        return Response.json({ ok: false, error_code: failure, description: "Bad Request: can't parse entities" });
      }
      return Response.json({ ok: true, result: { message_id: calls.length } });
    },
  });
  const tokenSource = () => "test:fixture";
  const transport = {
    loadTelegramToken: tokenSource,
    createTelegramApi: (token: string) => { assert.equal(token, "test:fixture"); return api; },
    execFileSync: (_file: string, _args: string[], options: { input?: unknown }) => {
      ordinary.push(String(options.input)); return "";
    },
  };
  const deps: Partial<CronRunnerMainDeps> = {
    argv: ["node", "cron-runner.js", "--task", name],
    exit: () => { throw new Exit(); },
    log: () => {},
    loadDefaultDelivery: () => ({}),
    loadAdminChatId: () => undefined,
    loadCronTask: () => ({ name, type, schedule: "0 * * * *", agentId: "fixture",
      deliveryChatId: 123, deliveryThreadId: 42, prompt: "report", command: "fixture" }),
    resolveCronAgentData: () => ({ id: "fixture", workspaceCwd: env.controlRoot, model: "fixture" }),
    runPi: () => { generated++; return output; },
    runScript: () => { generated++; return output; },
    // Keep the actual production routing, renderer, adapter, and grammY
    // serialization. Only credentials, network, and process execution are faked.
    deliver: (chat, text, thread, options) => deliver(chat, text, thread, { ...transport, ...options }),
    sleep: async ms => { sleeps.push(ms); },
    handleDeliveryFailure: (_name, _chat, error) => { errors.push(error); },
    writeCronHealthMetric: (_name, _code, outcome) => { metrics.push(outcome); },
  };
  return { name, echoDir, calls, ordinary, sleeps, errors, metrics, deps, transport,
    generated: () => generated,
    fail: (code: typeof failure, chunk?: number) => { failure = code; failChunk = chunk; },
    seed: (payload = output) => writeCronOutboxRecord({ version: 1, cron: name, runId: "fixture-run",
      kind: "output", payload, chatId: 456, threadId: 73, createdAt: new Date().toISOString(), attempts: 2 }),
    run: () => main(deps),
  };
}

describe("cron native result routing", () => {
  for (const type of ["llm", "script"] as const) {
    it(`sends fresh ${type} results natively and echoes confirmed source to the same thread`, async () => {
      const h = harness("# Report\n\n```ts\nconst x = '<literal>';\n\n\n```", type);
      await h.run();
      assert.equal(h.generated(), 1);
      assert.equal(h.calls.length, 1);
      assert.equal(h.calls[0].method, "sendRichMessage");
      assert.equal(h.calls[0].body.chat_id, 123);
      assert.equal(h.calls[0].body.message_thread_id, 42);
      assert.deepEqual(h.calls[0].body.rich_message.blocks, [
        { type: "heading", size: 1, text: "Report" },
        { type: "pre", language: "ts", text: "const x = '<literal>';\n\n" },
      ]);
      assert.deepEqual(h.ordinary, []);
      assert.deepEqual(h.sleeps, []);
      assert.equal(readCronOutboxRecord(h.name), undefined);
      const echoes: unknown[] = [];
      const watcher = new EchoWatcher({ echoDir: h.echoDir, handler: (...args) => { echoes.push(args); } });
      watcher.drain();
      assert.deepEqual(echoes, [["123", "42", "# Report\n\nconst x = '<literal>';\n\n"]]);
      watcher.drain();
      assert.equal(echoes.length, 1, "echo consumed once");
    });
  }

  it("uses native Markdown for short results and omits an absent thread", async () => {
    const h = harness();
    await deliver(123, "A short report", undefined, { ...h.transport, purpose: "result" });
    assert.equal(h.calls[0].method, "sendRichMessage");
    assert.deepEqual(h.calls[0].body.rich_message, { markdown: "A short report", media: [] });
    assert.equal(h.calls[0].body.message_thread_id, undefined);
  });

  it("replays old output records natively at their stored destination before generation", async () => {
    const h = harness();
    h.seed("Retained report");
    await h.run();
    assert.deepEqual(h.calls.map(c => [c.method, c.body.chat_id, c.body.message_thread_id]), [
      ["sendRichMessage", 456, 73], ["sendRichMessage", 123, 42],
    ]);
    assert.equal(h.calls[0].body.rich_message.markdown, "Retained report");
    assert.equal(h.generated(), 1);
    assert.equal(readCronOutboxRecord(h.name), undefined);
    assert.deepEqual(h.ordinary, []);
  });

  for (const code of [400, 403, 429, 500, "network"] as const) {
    it(`retains native ${code} failures through bounded retries and blocks regeneration on replay`, async () => {
      const h = harness();
      h.fail(code);
      await assert.rejects(h.run(), Exit);
      assert.equal(h.calls.length, 3);
      assert.deepEqual(h.sleeps, [...CRON_DELIVERY_RETRY_DELAYS_MS]);
      const pending = readCronOutboxRecord(h.name);
      assert.ok(pending && pending !== "corrupt");
      assert.equal(pending.payload, "# Result\n\nA short report.");
      assert.match(h.errors[0], /Rich cron result delivery failed at chunk 1/);
      if (typeof code === "number") assert.ok(h.errors[0].includes(`Telegram ${code}`));
      assert.equal(existsSync(h.echoDir), false);
      await assert.rejects(h.run(), Exit);
      assert.equal(h.calls.length, 4, "one replay attempt per invocation");
      assert.equal(h.generated(), 1, "failed replay must not generate a replacement");
      assert.deepEqual(readCronOutboxRecord(h.name), { ...pending, attempts: 1 });
      assert.deepEqual(h.ordinary, [], "no ordinary fallback even for parser rejection");
      assert.ok(h.calls.every(c => c.method === "sendRichMessage"));
      assert.deepEqual(h.metrics, ["failure"], "replay is not a new logical run");
      assert.doesNotMatch(h.errors.join(""), /test:fixture/);
      h.fail(undefined);
      await h.run();
      assert.equal(readCronOutboxRecord(h.name), undefined);
      assert.equal(h.generated(), 2);
    });
  }

  it("retains the full result after later-chunk rejection and echoes only confirmed chunks", async () => {
    const source = "x".repeat(RICH_TEXT_BYTES + 1);
    const h = harness(source);
    h.fail(400, 0);
    await assert.rejects(h.run(), Exit);
    assert.equal(h.calls.length, 6);
    assert.ok(h.calls.every(c => c.method === "sendRichMessage"));
    const pending = readCronOutboxRecord(h.name);
    assert.ok(pending && pending !== "corrupt");
    assert.equal(pending.payload, source);
    const files = readdirSync(join(h.echoDir, "123"));
    assert.equal(files.length, 3, "whole-result retry retains existing partial-delivery ambiguity");
    for (const file of files) {
      const echo = JSON.parse(readFileSync(join(h.echoDir, "123", file), "utf8"));
      assert.equal(echo.text, source.slice(0, RICH_TEXT_BYTES));
      assert.equal(echo.threadId, "42");
    }
    await assert.rejects(h.run(), Exit);
    assert.equal(h.generated(), 1);
    assert.deepEqual(h.ordinary, []);
  });

  for (const source of ["", "  ", "NO_REPLY", "Report\n\nNO_REPLY", "![Photo](outbox:missing.png)\nNO_REPLY"]) {
    it(`suppresses ${JSON.stringify(source)} before native preparation`, async () => {
      const h = harness(source);
      await h.run();
      assert.deepEqual(h.calls, []);
      assert.deepEqual(h.ordinary, []);
      assert.equal(readCronOutboxRecord(h.name), undefined);
      assert.equal(existsSync(h.echoDir), false);
    });
  }

  it("rejects unsupported cron inline photos without consuming ambient media or falling back", async () => {
    const h = harness("![Photo](outbox:photo.png)");
    const outbox = join(env.root, "ambient-outbox");
    mkdirSync(outbox);
    writeFileSync(join(outbox, "photo.png"), "untouched");
    process.env.MINIME_OUTBOX = outbox;
    await assert.rejects(h.run(), Exit);
    assert.match(h.errors[0], /requires a session outbox/);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.ordinary, []);
    assert.deepEqual(readdirSync(outbox), ["photo.png"]);
    assert.equal(readFileSync(join(outbox, "photo.png"), "utf8"), "untouched");
    await assert.rejects(h.run(), Exit);
    assert.equal(h.generated(), 1);
    assert.ok(readCronOutboxRecord(h.name));
  });

  it("echo spool failure does not retry a confirmed result", async () => {
    const h = harness();
    writeFileSync(h.echoDir, "blocked spool");
    await h.run();
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
    assert.equal(readCronOutboxRecord(h.name), undefined);
  });

  it("keeps explicit and default service delivery on the ordinary script", async () => {
    const h = harness();
    await deliver(123, "service notice", 42, { ...h.transport, purpose: "service" });
    await deliver(123, "legacy service notice", undefined, h.transport);
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.ordinary, ["service notice", "legacy service notice"]);
  });
});
