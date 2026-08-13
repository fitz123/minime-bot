import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { loadConfig } from "../config.js";
import { MessageQueue } from "../message-queue.js";
import type { PlatformContext, TelegramBinding, TriggerInputConfig } from "../types.js";
import type { TelegramAdapterApi } from "../telegram-adapter.js";
import {
  startTriggerInput,
  TriggerInputBindError,
  TRIGGER_INPUT_MAX_BODY_BYTES,
  TRIGGER_INPUT_MAX_TEXT_UTF16_UNITS,
  type TriggerInputServer,
} from "../trigger-input.js";

const sessionDefaults = {
  idleTimeoutMs: 60_000,
  maxConcurrentSessions: 2,
  maxMessageAgeMs: 60_000,
  requireMention: true,
  maxMediaBytes: 1024,
};

const defaultBinding: TelegramBinding = {
  chatId: 111,
  agentId: "main",
  kind: "dm",
  typingIndicator: false,
};

function testConfig(overrides: Partial<TriggerInputConfig> = {}): TriggerInputConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    path: "/trigger",
    bearer: "test-bearer",
    chatId: 111,
    ...overrides,
  };
}

function mockApi(): TelegramAdapterApi {
  return {
    async sendMessage() { return { message_id: 1 } as never; },
    async sendMessageDraft() { return true; },
    async deleteMessage() { return true; },
    async sendChatAction() { return true; },
    async sendPhoto() { return { message_id: 2 } as never; },
    async sendDocument() { return { message_id: 3 } as never; },
  } as TelegramAdapterApi;
}

class CapturingQueue {
  accepted = true;
  readonly calls: Array<{
    chatId: string;
    agentId: string;
    text: string;
    platform: PlatformContext;
  }> = [];

  enqueue(
    chatId: string,
    agentId: string,
    text: string,
    platform: PlatformContext,
  ): boolean {
    this.calls.push({ chatId, agentId, text, platform });
    return this.accepted;
  }
}

async function request(
  server: TriggerInputServer,
  options: {
    path?: string;
    method?: string;
    bearer?: string;
    contentType?: string;
    body?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  const response = await fetch(
    `http://127.0.0.1:${server.address.port}${options.path ?? "/trigger"}`,
    {
      method: options.method ?? "POST",
      headers: {
        Authorization: `Bearer ${options.bearer ?? "test-bearer"}`,
        "Content-Type": options.contentType ?? "application/json",
      },
      body: options.method === "GET"
        ? undefined
        : (options.body ?? JSON.stringify({ source: "test-source", text: "evidence" })),
    },
  );
  return { status: response.status, body: await response.text() };
}

describe("trigger input", () => {
  const servers: TriggerInputServer[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  async function start(options: {
    config?: TriggerInputConfig;
    bindings?: TelegramBinding[];
    queue?: CapturingQueue | MessageQueue;
  } = {}) {
    const queue = options.queue ?? new CapturingQueue();
    const server = await startTriggerInput({
      config: options.config ?? testConfig(),
      bindings: options.bindings ?? [defaultBinding],
      sessionDefaults,
      api: mockApi(),
      messageQueue: queue,
    });
    servers.push(server);
    return { server, queue };
  }

  it("starts and stops one loopback listener", async () => {
    const { server } = await start();
    assert.strictEqual(server.server.listening, true);
    assert.strictEqual((await request(server)).status, 202);

    await server.stop();
    assert.strictEqual(server.server.listening, false);
    await assert.rejects(() => request(server));
  });

  it("stops promptly after a partial upload reaches the body deadline", async () => {
    const { server } = await start();
    const socket = createConnection({
      host: "127.0.0.1",
      port: server.address.port,
    });
    socket.setEncoding("utf8");
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        socket.once("connect", resolvePromise);
        socket.once("error", rejectPromise);
      });
      const responsePromise = new Promise<string>((resolvePromise, rejectPromise) => {
        let received = "";
        const deadline = setTimeout(
          () => rejectPromise(new Error("partial upload did not receive its deadline response")),
          7_000,
        );
        socket.on("data", (chunk: string) => {
          received += chunk;
          if (!received.includes("malformed")) return;
          clearTimeout(deadline);
          resolvePromise(received);
        });
        socket.once("error", (error) => {
          clearTimeout(deadline);
          rejectPromise(error);
        });
      });
      socket.write([
        "POST /trigger HTTP/1.1",
        `Host: 127.0.0.1:${server.address.port}`,
        "Authorization: Bearer test-bearer",
        "Content-Type: application/json",
        "Content-Length: 1024",
        "Connection: keep-alive",
        "",
        '{"source":"test-source",',
      ].join("\r\n"));

      const response = await responsePromise;
      assert.match(response, /^HTTP\/1\.1 400 /);
      assert.match(response, /\r\nmalformed\r\n/);

      let stopDeadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          server.stop(),
          new Promise<never>((_resolvePromise, rejectPromise) => {
            stopDeadline = setTimeout(
              () => rejectPromise(new Error("trigger input stop remained blocked")),
              1_000,
            );
          }),
        ]);
      } finally {
        if (stopDeadline) clearTimeout(stopDeadline);
      }
    } finally {
      socket.destroy();
    }
  });

  it("logs a stable listener status without configured routing or bearer values", async () => {
    const originalLog = console.log;
    const messages: string[] = [];
    console.log = (...args: unknown[]) => messages.push(args.map(String).join(" "));
    const config = testConfig({
      path: "/private-route-placeholder",
      bearer: "private-bearer-placeholder",
    });
    try {
      const { server } = await start({ config });
      const message = messages.at(-1) ?? "";
      assert.match(message, /INFO \[trigger-input\] Trigger input listening$/);
      assert.ok(!message.includes(config.host));
      assert.ok(!message.includes(String(server.address.port)));
      assert.ok(!message.includes(config.path));
      assert.ok(!message.includes(config.bearer));
    } finally {
      console.log = originalLog;
    }
  });

  it("enqueues one framed ordinary turn for the resolved topic binding and session key", async () => {
    const queue = new CapturingQueue();
    const bindings: TelegramBinding[] = [{
      chatId: -100111,
      agentId: "main",
      kind: "group",
      typingIndicator: false,
      topics: [{ topicId: 7, agentId: "topic-agent", requireMention: false }],
    }];
    const { server } = await start({
      config: testConfig({ chatId: -100111, threadId: 7 }),
      bindings,
      queue,
    });

    assert.deepStrictEqual(await request(server, {
      body: JSON.stringify({ source: "runtime-doctor", text: "Primary is unreachable" }),
    }), { status: 202, body: "accepted" });
    assert.strictEqual(queue.calls.length, 1);
    assert.strictEqual(queue.calls[0].chatId, "-100111:7");
    assert.strictEqual(queue.calls[0].agentId, "topic-agent");
    assert.match(
      queue.calls[0].text,
      /^\[Automatic trigger \| source: runtime-doctor \| \d{2}:\d{2}\]\n\nPrimary is unreachable$/,
    );
    assert.strictEqual(queue.calls[0].platform.typingIndicator, false);
  });

  it("accepts exactly 4096 UTF-16 evidence units and rejects one-unit overflow", async () => {
    const queue = new CapturingQueue();
    const { server } = await start({ queue });
    const exact = "x".repeat(TRIGGER_INPUT_MAX_TEXT_UTF16_UNITS);

    assert.deepStrictEqual(await request(server, {
      body: JSON.stringify({ source: "alertmanager", text: exact }),
    }), { status: 202, body: "accepted" });
    assert.ok(queue.calls[0].text.endsWith(exact));

    assert.deepStrictEqual(await request(server, {
      body: JSON.stringify({ source: "alertmanager", text: `${exact}x` }),
    }), { status: 400, body: "malformed" });
    assert.strictEqual(queue.calls.length, 1);
  });

  it("returns only bounded status words for authentication and request failures", async () => {
    const queue = new CapturingQueue();
    const { server } = await start({ queue });
    const cases: Array<[
      string,
      Parameters<typeof request>[1],
      { status: number; body: string },
    ]> = [
      ["bearer", { bearer: "wrong" }, { status: 401, body: "unauthorized" }],
      ["content type", { contentType: "text/plain" }, { status: 415, body: "unsupported-media-type" }],
      ["malformed JSON", { body: "{" }, { status: 400, body: "malformed" }],
      ["wrong path", { path: "/other" }, { status: 404, body: "not-found" }],
      ["wrong method", { method: "GET" }, { status: 405, body: "method-not-allowed" }],
      ["invalid source", { body: JSON.stringify({ source: "Bad Source", text: "evidence" }) }, { status: 400, body: "malformed" }],
      ["extra field", { body: JSON.stringify({ source: "source", text: "evidence", id: "forbidden" }) }, { status: 400, body: "malformed" }],
      ["oversized body", { body: "x".repeat(TRIGGER_INPUT_MAX_BODY_BYTES + 1) }, { status: 413, body: "too-large" }],
    ];

    for (const [name, options, expected] of cases) {
      assert.deepStrictEqual(await request(server, options), expected, name);
    }
    assert.strictEqual(queue.calls.length, 0);
  });

  it("reports queue saturation and shutdown as 429 without retry state", async () => {
    const saturated = new CapturingQueue();
    saturated.accepted = false;
    const { server: saturatedServer } = await start({ queue: saturated });
    assert.deepStrictEqual(await request(saturatedServer), {
      status: 429,
      body: "saturated",
    });

    const shutdownQueue = new MessageQueue(async () => {}, { debounceMs: 10_000 });
    shutdownQueue.beginShutdown();
    const { server: shutdownServer } = await start({ queue: shutdownQueue });
    assert.deepStrictEqual(await request(shutdownServer), {
      status: 429,
      body: "saturated",
    });
    assert.strictEqual(shutdownQueue.getPendingCount("111"), 0);
  });

  it("fails a second listener on the same address with the stable bind error", async () => {
    const { server } = await start();
    await assert.rejects(
      () => startTriggerInput({
        config: testConfig({ port: server.address.port }),
        bindings: [defaultBinding],
        sessionDefaults,
        api: mockApi(),
        messageQueue: new CapturingQueue(),
      }),
      (error: unknown) => (
        error instanceof TriggerInputBindError
        && error.message === "Trigger input address is in use"
      ),
    );
  });

  it("remains disabled without configuration and writes no trigger state or identifiers", async () => {
    const root = mkdtempSync(join(tmpdir(), "trigger-input-state-test-"));
    try {
      const configPath = join(root, "config.yaml");
      writeFileSync(configPath, `
agents:
  main:
    workspaceCwd: /tmp/agent
    model: gpt-5.5
telegramTokenEnv: TEST_TELEGRAM_TOKEN
bindings:
  - chatId: 111
    agentId: main
    kind: dm
`);
      const config = loadConfig(configPath, { resolveSecrets: false });
      assert.strictEqual(config.triggerInput, undefined);

      const before = readdirSync(root).sort();
      const queue = new CapturingQueue();
      const { server } = await start({ queue });
      const response = await request(server);
      assert.deepStrictEqual(response, { status: 202, body: "accepted" });
      assert.doesNotMatch(response.body, /\d|id|source|evidence/i);
      assert.deepStrictEqual(readdirSync(root).sort(), before);
      assert.strictEqual(queue.calls.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
