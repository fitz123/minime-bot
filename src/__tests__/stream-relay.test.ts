import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { splitMessage, extractText, isImageExtension, sendOutboxFiles, relayStream, collapseNewlines } from "../stream-relay.js";
import type { DraftSendResult, StreamLine, StreamEvent, AssistantMessage, ResultMessage, ToolProgress, PlatformContext } from "../types.js";
import { draftSchedulerEvents, finalDeliveryFailures } from "../metrics.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("splitMessage", () => {
  it("returns single chunk for short text", () => {
    const result = splitMessage("Hello world", 4096);
    assert.deepStrictEqual(result, ["Hello world"]);
  });

  it("returns single chunk for exactly max length", () => {
    const text = "a".repeat(4096);
    const result = splitMessage(text, 4096);
    assert.deepStrictEqual(result, [text]);
  });

  it("splits at paragraph boundary", () => {
    const para1 = "a".repeat(100);
    const para2 = "b".repeat(100);
    const text = para1 + "\n\n" + para2;
    const result = splitMessage(text, 150);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], para1);
    assert.strictEqual(result[1], para2);
  });

  it("splits at newline if no paragraph boundary", () => {
    const line1 = "a".repeat(100);
    const line2 = "b".repeat(100);
    const text = line1 + "\n" + line2;
    const result = splitMessage(text, 150);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], line1);
    assert.strictEqual(result[1], line2);
  });

  it("splits at space if no newline", () => {
    const text = "word ".repeat(30).trim(); // ~150 chars
    const result = splitMessage(text, 50);
    assert.ok(result.length > 1);
    for (const chunk of result) {
      assert.ok(chunk.length <= 50, `Chunk too long: ${chunk.length}`);
    }
  });

  it("hard-cuts if no natural boundary", () => {
    const text = "a".repeat(200);
    const result = splitMessage(text, 50);
    assert.ok(result.length >= 4);
    assert.strictEqual(result[0].length, 50);
  });

  it("preserves paragraph breaks across split chunks", () => {
    // When splitting at \n\n, extra newlines after the boundary must survive
    const para1 = "a".repeat(100);
    const para2 = "b".repeat(100);
    // Three newlines: split consumes \n\n boundary, one \n remains at start of next chunk
    const text = para1 + "\n\n\n" + para2;
    const result = splitMessage(text, 150);
    assert.strictEqual(result.length, 2);
    assert.strictEqual(result[0], para1);
    assert.strictEqual(result[1], "\n" + para2, "extra newline after split boundary should be preserved");
  });

  it("preserves multiple paragraph breaks across split chunks", () => {
    const para1 = "a".repeat(80);
    const para2 = "b".repeat(80);
    const para3 = "c".repeat(80);
    // Build text: para1 \n\n para2 \n\n para3
    const text = para1 + "\n\n" + para2 + "\n\n" + para3;
    const result = splitMessage(text, 100);
    // Should split into 3 chunks, each paragraph intact
    assert.strictEqual(result.length, 3);
    assert.strictEqual(result[0], para1);
    assert.strictEqual(result[1], para2);
    assert.strictEqual(result[2], para3);
  });

  it("handles empty string", () => {
    const result = splitMessage("", 4096);
    assert.deepStrictEqual(result, [""]);
  });

  it("splits long response into multiple 4096-char chunks", () => {
    const text = "x".repeat(10000);
    const result = splitMessage(text, 4096);
    assert.ok(result.length >= 3);
    for (const chunk of result) {
      assert.ok(chunk.length <= 4096);
    }
    // Total content preserved
    assert.strictEqual(result.join("").length, 10000);
  });
});

describe("extractText", () => {
  it("extracts text_delta from stream_event", () => {
    const msg: StreamEvent = {
      type: "stream_event",
      event: {
        delta: { type: "text_delta", text: "Hello" },
      },
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, "Hello");
    assert.strictEqual(result.isFinal, false);
  });

  it("ignores assistant message snapshot (text already delivered via deltas)", () => {
    const msg: AssistantMessage = {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello " },
          { type: "text", text: "world" },
        ],
      },
      session_id: "test-id",
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, false);
  });

  it("returns isFinal for result message without duplicating text", () => {
    const msg: ResultMessage = {
      type: "result",
      result: "Final answer",
      session_id: "test-id",
      cost_usd: 0.01,
      duration_ms: 1000,
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, true);
  });

  it("returns null for tool_progress", () => {
    const msg: ToolProgress = {
      type: "assistant",
      subtype: "tool_progress",
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, false);
  });

  it("returns isFinal=true for result with no text", () => {
    const msg: ResultMessage = {
      type: "result",
      result: "",
      session_id: "test-id",
    };
    const result = extractText(msg);
    assert.strictEqual(result.isFinal, true);
  });

  it("handles stream_event without text delta", () => {
    const msg: StreamEvent = {
      type: "stream_event",
      event: {
        delta: { type: "input_json_delta" },
      },
    };
    const result = extractText(msg);
    assert.strictEqual(result.text, null);
    assert.strictEqual(result.isFinal, false);
  });

  it("does not duplicate text when processing full CLI event sequence", () => {
    // Simulates a stream with partial chunks followed by full-message snapshots:
    // 1. text_delta events (streaming chunks)
    // 2. assistant message snapshot (full text)
    // 3. result message (full text again)
    const events: StreamLine[] = [
      { type: "stream_event", event: { delta: { type: "text_delta", text: "Hello" } } } as StreamEvent,
      { type: "stream_event", event: { delta: { type: "text_delta", text: " world" } } } as StreamEvent,
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Hello world" }] }, session_id: "s" } as AssistantMessage,
      { type: "result", result: "Hello world", session_id: "s" } as ResultMessage,
    ];

    let accumulated = "";
    let isFinal = false;
    for (const msg of events) {
      const r = extractText(msg);
      if (r.text !== null) accumulated += r.text;
      if (r.isFinal) isFinal = true;
    }

    assert.strictEqual(accumulated, "Hello world");
    assert.strictEqual(isFinal, true);
  });
});

describe("isImageExtension", () => {
  it("returns true for supported image extensions", () => {
    assert.strictEqual(isImageExtension("/path/to/file.jpg"), true);
    assert.strictEqual(isImageExtension("/path/to/file.jpeg"), true);
    assert.strictEqual(isImageExtension("/path/to/file.png"), true);
    assert.strictEqual(isImageExtension("/path/to/file.gif"), true);
    assert.strictEqual(isImageExtension("/path/to/file.webp"), true);
  });

  it("returns true for uppercase extensions", () => {
    assert.strictEqual(isImageExtension("/path/to/file.PNG"), true);
    assert.strictEqual(isImageExtension("/path/to/file.JPG"), true);
  });

  it("returns false for non-image extensions", () => {
    assert.strictEqual(isImageExtension("/path/to/file.txt"), false);
    assert.strictEqual(isImageExtension("/path/to/file.pdf"), false);
    assert.strictEqual(isImageExtension("/path/to/file.bmp"), false);
    assert.strictEqual(isImageExtension("/path/to/file.ts"), false);
  });

  it("returns false for files with no extension", () => {
    assert.strictEqual(isImageExtension("/path/to/Makefile"), false);
  });
});

describe("sendOutboxFiles", () => {
  const outboxPath = "/tmp/bot-outbox-test-relay";

  beforeEach(() => {
    rmSync(outboxPath, { recursive: true, force: true });
    mkdirSync(outboxPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(outboxPath, { recursive: true, force: true });
  });

  it("sends files from outbox directory", async () => {
    writeFileSync(join(outboxPath, "chart.png"), "fake-png");
    writeFileSync(join(outboxPath, "report.pdf"), "fake-pdf");

    const sentFiles: Array<{ path: string; isImage: boolean }> = [];
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string, isImage: boolean): Promise<void> {
        sentFiles.push({ path: filePath, isImage });
      },
    };

    await sendOutboxFiles(outboxPath, platform);

    assert.strictEqual(sentFiles.length, 2);
    const names = sentFiles.map(f => f.path.split("/").pop());
    assert.ok(names.includes("chart.png"));
    assert.ok(names.includes("report.pdf"));

    // Image detection
    const png = sentFiles.find(f => f.path.endsWith("chart.png"));
    assert.strictEqual(png?.isImage, true);
    const pdf = sentFiles.find(f => f.path.endsWith("report.pdf"));
    assert.strictEqual(pdf?.isImage, false);
  });

  it("cleans up files after sending", async () => {
    writeFileSync(join(outboxPath, "output.txt"), "hello");

    await sendOutboxFiles(outboxPath, mockPlatform().platform);

    const remaining = readdirSync(outboxPath);
    assert.strictEqual(remaining.length, 0);
  });

  it("skips subdirectories in outbox", async () => {
    mkdirSync(join(outboxPath, "subdir"));
    writeFileSync(join(outboxPath, "file.txt"), "hello");

    const sentFiles: string[] = [];
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string): Promise<void> {
        sentFiles.push(filePath);
      },
    };

    await sendOutboxFiles(outboxPath, platform);
    assert.strictEqual(sentFiles.length, 1);
    assert.ok(sentFiles[0].endsWith("file.txt"));
  });

  it("handles nonexistent outbox directory gracefully", async () => {
    rmSync(outboxPath, { recursive: true, force: true });
    // Should not throw
    await sendOutboxFiles(outboxPath, mockPlatform().platform);
  });

  it("handles empty outbox directory", async () => {
    const sentFiles: string[] = [];
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string): Promise<void> {
        sentFiles.push(filePath);
      },
    };

    await sendOutboxFiles(outboxPath, platform);
    assert.strictEqual(sentFiles.length, 0);
  });

  it("continues sending remaining files if one fails", async () => {
    writeFileSync(join(outboxPath, "a.txt"), "aaa");
    writeFileSync(join(outboxPath, "b.png"), "bbb");

    const sentFiles: string[] = [];
    let callCount = 0;
    const platform = {
      ...mockPlatform().platform,
      async sendFile(filePath: string): Promise<void> {
        callCount++;
        if (callCount === 1) throw new Error("network error");
        sentFiles.push(filePath);
      },
    };

    await sendOutboxFiles(outboxPath, platform);
    // One succeeded, one failed — but both were attempted
    assert.strictEqual(sentFiles.length, 1);

    // Failed file should still exist (not deleted), successful file should be gone
    const remaining = readdirSync(outboxPath);
    assert.strictEqual(remaining.length, 1, "failed file should remain in outbox");
  });
});

// -------------------------------------------------------------------
// relayStream — tests using PlatformContext
// -------------------------------------------------------------------

/** Create a mock async generator yielding text deltas and a result. */
async function* fakeStream(deltas: string[]): AsyncGenerator<StreamLine> {
  for (const delta of deltas) {
    yield {
      type: "stream_event",
      event: { delta: { type: "text_delta", text: delta } },
    } as StreamEvent;
  }
  yield {
    type: "result",
    result: deltas.join(""),
    session_id: "test",
  } as ResultMessage;
}

/**
 * Create a mock stream that simulates text → tool_use → text sequences.
 * Each segment is either a string (text deltas) or "tool_use" (a tool block).
 */
async function* fakeStreamWithTools(segments: Array<string | "tool_use">): AsyncGenerator<StreamLine> {
  let fullText = "";
  for (const seg of segments) {
    if (seg === "tool_use") {
      // content_block_start for tool_use
      yield {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Edit" } },
      } as unknown as StreamEvent;
      // input_json_delta
      yield {
        type: "stream_event",
        event: { delta: { type: "input_json_delta", partial_json: "{}" } },
      } as unknown as StreamEvent;
      // content_block_stop
      yield {
        type: "stream_event",
        event: { type: "content_block_stop" },
      } as unknown as StreamEvent;
    } else {
      // content_block_start for text
      yield {
        type: "stream_event",
        event: { type: "content_block_start", content_block: { type: "text" } },
      } as unknown as StreamEvent;
      // text_delta
      yield {
        type: "stream_event",
        event: { delta: { type: "text_delta", text: seg } },
      } as StreamEvent;
      fullText += seg;
    }
  }
  yield {
    type: "result",
    result: fullText,
    session_id: "test",
  } as ResultMessage;
}

/** Create a mock PlatformContext for relayStream tests. */
function mockPlatform(options?: {
  sendShouldThrow?: boolean | number;
  typingIndicator?: boolean;
  typingIntervalMs?: number;
}) {
  const sends: Array<{ text: string }> = [];
  const drafts: Array<{ draftId: number; text: string }> = [];
  const typings: number[] = [];
  let messageCounter = 0;

  const platform: PlatformContext = {
    maxMessageLength: 4096,
    typingIntervalMs: options?.typingIntervalMs ?? 4000,
    typingIndicator: options?.typingIndicator !== false,

    async sendMessage(text: string): Promise<string> {
      messageCounter++;
      if (options?.sendShouldThrow === true ||
          (typeof options?.sendShouldThrow === "number" && messageCounter === options.sendShouldThrow)) {
        throw new Error("NetworkError: sendMessage failed");
      }
      sends.push({ text });
      return String(messageCounter);
    },

    async sendDraft(draftId: number, text: string) {
      drafts.push({ draftId, text });
      return { status: "sent" } as const;
    },

    async sendTyping(): Promise<void> {
      typings.push(Date.now());
    },

    async deleteMessage(): Promise<void> {},

    async sendFile(): Promise<void> {},

    async replyError(text: string): Promise<void> {
      sends.push({ text });
    },
  };

  return { platform, sends, drafts, typings };
}

describe("relayStream draft streaming", () => {
  it("sends final message via sendMessage", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1, "Should send exactly one final message");
    assert.strictEqual(sends[0].text, "Hello world");
  });

  it("sends draft updates during streaming", async () => {
    const { platform, drafts } = mockPlatform();
    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, platform);

    // Draft updates are debounced, so at least one should fire
    assert.ok(drafts.length >= 1, "Should send at least one draft update");
    // All drafts use the same draftId
    const draftIds = new Set(drafts.map(d => d.draftId));
    assert.strictEqual(draftIds.size, 1, "All drafts should share the same draftId");
  });

  it("handles multi-chunk final message", async () => {
    const { platform, sends } = mockPlatform();
    const longText = "x".repeat(5000);
    const stream = fakeStream([longText]);

    await relayStream(stream, platform);

    assert.ok(sends.length >= 2, "Should split into multiple messages");
    const totalText = sends.map(s => s.text).join("");
    assert.strictEqual(totalText.length, 5000);
  });

  it("delivers single-chunk stream via sendMessage after drafts complete", async () => {
    const { platform, drafts, sends } = mockPlatform();
    const stream = fakeStream(["Only chunk"]);

    await relayStream(stream, platform);

    // Draft may fire for the delta (debounce allows immediate send on first call)
    // but final delivery always goes through sendMessage
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Only chunk");
    // All drafts (if any) should use the same draftId
    const draftIds = new Set(drafts.map(d => d.draftId));
    assert.ok(draftIds.size <= 1, "All drafts should share the same draftId");
  });
});

describe("relayStream bounded draft scheduler", () => {
  it("keeps one request in flight, enforces the minimum interval, and sends only the latest snapshot", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000 });
    const { platform, sends } = mockPlatform({ typingIndicator: false });
    const draftCalls: string[] = [];
    const draftResults: Array<ReturnType<typeof deferred<DraftSendResult>>> = [];
    platform.sendDraft = async (_draftId, text) => {
      draftCalls.push(text);
      const result = deferred<DraftSendResult>();
      draftResults.push(result);
      return result.promise;
    };
    const second = deferred<void>();
    const third = deferred<void>();
    const finish = deferred<void>();
    async function* stream(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "one" } } } as StreamEvent;
      await second.promise;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: " two" } } } as StreamEvent;
      await third.promise;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: " three" } } } as StreamEvent;
      await finish.promise;
      yield { type: "result", result: "one two three", session_id: "test" } as ResultMessage;
    }

    const relay = relayStream(stream(), platform);
    await flushMicrotasks();
    assert.deepStrictEqual(draftCalls, ["one"]);

    second.resolve();
    await flushMicrotasks();
    third.resolve();
    await flushMicrotasks();
    assert.deepStrictEqual(draftCalls, ["one"], "new snapshots do not create concurrent calls");

    draftResults[0].resolve({ status: "sent" });
    await flushMicrotasks();
    t.mock.timers.tick(999);
    await flushMicrotasks();
    assert.strictEqual(draftCalls.length, 1);
    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.deepStrictEqual(draftCalls, ["one", "one two three"]);

    draftResults[1].resolve({ status: "sent" });
    finish.resolve();
    await relay;
    assert.deepStrictEqual(sends, [{ text: "one two three" }]);
  });

  it("honors bounded retry-after feedback without retrying the rejected draft or bursting afterward", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000 });
    const { platform } = mockPlatform({ typingIndicator: false });
    const calls: string[] = [];
    const firstResult = deferred<DraftSendResult>();
    platform.sendDraft = async (_draftId, text) => {
      calls.push(text);
      if (calls.length === 1) return firstResult.promise;
      return { status: "sent" };
    };
    const addSecond = deferred<void>();
    const addThird = deferred<void>();
    const finish = deferred<void>();
    async function* stream(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "old" } } } as StreamEvent;
      await addSecond.promise;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: " newer" } } } as StreamEvent;
      await addThird.promise;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: " latest" } } } as StreamEvent;
      await finish.promise;
      yield { type: "result", result: "old newer latest", session_id: "test" } as ResultMessage;
    }

    const relay = relayStream(stream(), platform);
    await flushMicrotasks();
    addSecond.resolve();
    await flushMicrotasks();
    addThird.resolve();
    await flushMicrotasks();
    firstResult.resolve({ status: "rate_limited", retryAfterMs: 5_000 });
    await flushMicrotasks();

    t.mock.timers.tick(4_999);
    await flushMicrotasks();
    assert.deepStrictEqual(calls, ["old"]);
    t.mock.timers.tick(1);
    await flushMicrotasks();
    assert.deepStrictEqual(calls, ["old", "old newer latest"]);
    t.mock.timers.tick(20_000);
    await flushMicrotasks();
    assert.strictEqual(calls.length, 2, "the pause releases only one coalesced snapshot");

    finish.resolve();
    await relay;
  });

  it("contains rejected and failed draft outcomes, keeps typing, and records production metrics", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000 });

    for (const outcome of ["rejected", "failed"] as const) {
      const { platform, sends, typings } = mockPlatform({ typingIntervalMs: 100 });
      const failedBefore = (await draftSchedulerEvents.get()).values
        .find(({ labels }) => labels.event === "failed")?.value ?? 0;
      let calls = 0;
      platform.sendDraft = async () => {
        calls += 1;
        if (calls === 1 && outcome === "rejected") throw new Error("cosmetic failure");
        if (calls === 1) return { status: "failed" };
        return { status: "sent" };
      };
      const addSecond = deferred<void>();
      const finish = deferred<void>();
      async function* stream(): AsyncGenerator<StreamLine> {
        yield { type: "stream_event", event: { delta: { type: "text_delta", text: "first" } } } as StreamEvent;
        await addSecond.promise;
        yield { type: "stream_event", event: { delta: { type: "text_delta", text: " second" } } } as StreamEvent;
        await finish.promise;
        yield { type: "result", result: "first second", session_id: "test" } as ResultMessage;
      }

      const relay = relayStream(stream(), platform);
      await flushMicrotasks();
      t.mock.timers.tick(500);
      await flushMicrotasks();
      assert.ok(typings.length > 1, `${outcome} draft must not stop periodic typing`);
      addSecond.resolve();
      await flushMicrotasks();
      t.mock.timers.tick(500);
      await flushMicrotasks();
      assert.strictEqual(calls, 2, `${outcome} draft must not stop later coalesced progress`);
      finish.resolve();
      await relay;
      assert.deepStrictEqual(sends, [{ text: "first second" }]);
      const failedAfter = (await draftSchedulerEvents.get()).values
        .find(({ labels }) => labels.event === "failed")?.value ?? 0;
      assert.strictEqual(failedAfter, failedBefore + 1);
    }
  });

  it("aborts an in-flight draft before authoritative final delivery", async () => {
    const { platform, sends } = mockPlatform({ typingIndicator: false });
    const visibleDrafts: string[] = [];
    let releaseDraft!: () => void;
    let draftSignal: AbortSignal | undefined;
    platform.sendDraft = async (_draftId, text, signal) => new Promise<DraftSendResult>((resolve, reject) => {
      draftSignal = signal;
      releaseDraft = () => {
        if (signal?.aborted) return;
        visibleDrafts.push(text);
        resolve({ status: "sent" });
      };
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
    const finish = deferred<void>();
    async function* stream(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "final answer" } } } as StreamEvent;
      await finish.promise;
      yield { type: "result", result: "final answer", session_id: "test" } as ResultMessage;
    }

    const relay = relayStream(stream(), platform);
    await flushMicrotasks();
    assert.ok(draftSignal && !draftSignal.aborted);
    finish.resolve();
    await relay;
    assert.strictEqual(draftSignal.aborted, true);
    assert.deepStrictEqual(sends, [{ text: "final answer" }]);
    releaseDraft();
    await flushMicrotasks();
    assert.deepStrictEqual(visibleDrafts, [], "an aborted stale draft cannot become visible after final delivery");
  });

  it("bounds waiting for a hung cosmetic draft before authoritative final delivery", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000 });
    const { platform, sends } = mockPlatform({ typingIndicator: false });
    platform.sendDraft = async () => new Promise(() => {});

    const relay = relayStream(fakeStream(["final answer"]), platform);
    await flushMicrotasks();
    t.mock.timers.tick(2_999);
    await flushMicrotasks();
    assert.strictEqual(sends.length, 0);
    t.mock.timers.tick(1);
    await relay;
    assert.deepStrictEqual(sends, [{ text: "final answer" }]);
  });

  it("stops periodic typing after the first visible draft", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000 });
    const { platform, typings } = mockPlatform({ typingIntervalMs: 100 });
    const finish = deferred<void>();
    async function* stream(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "visible" } } } as StreamEvent;
      await finish.promise;
      yield { type: "result", result: "visible", session_id: "test" } as ResultMessage;
    }

    const relay = relayStream(stream(), platform);
    await flushMicrotasks();
    assert.strictEqual(typings.length, 1, "initial typing is preserved");
    t.mock.timers.tick(1_000);
    await flushMicrotasks();
    assert.strictEqual(typings.length, 1, "visible draft stops periodic typing");
    finish.resolve();
    await relay;
  });

  it("preserves periodic typing when drafts are unsupported", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000 });
    const { platform, typings } = mockPlatform({ typingIntervalMs: 100 });
    platform.sendDraft = async () => ({ status: "unsupported" });
    const finish = deferred<void>();
    async function* stream(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "discord" } } } as StreamEvent;
      await finish.promise;
      yield { type: "result", result: "discord", session_id: "test" } as ResultMessage;
    }

    const relay = relayStream(stream(), platform);
    await flushMicrotasks();
    t.mock.timers.tick(300);
    await flushMicrotasks();
    assert.strictEqual(typings.length, 4, "initial typing plus three periodic actions remain");
    finish.resolve();
    await relay;
  });

  it("cancels pending draft timers on NO_REPLY, stream error, and abort", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000 });

    for (const ending of ["no_reply", "error", "abort"] as const) {
      const { platform, sends } = mockPlatform({ typingIndicator: false });
      let draftCalls = 0;
      platform.sendDraft = async () => {
        draftCalls++;
        return { status: "sent" };
      };
      async function* stream(): AsyncGenerator<StreamLine> {
        yield { type: "stream_event", event: { delta: { type: "text_delta", text: ending === "no_reply" ? "NO_" : "partial" } } } as StreamEvent;
        await flushMicrotasks();
        yield { type: "stream_event", event: { delta: { type: "text_delta", text: ending === "no_reply" ? "REPLY" : " newer" } } } as StreamEvent;
        if (ending === "error") throw new Error("stream failed");
        if (ending === "abort") throw new DOMException("aborted", "AbortError");
        yield { type: "result", result: "NO_REPLY", session_id: "test" } as ResultMessage;
      }

      if (ending === "no_reply") await relayStream(stream(), platform);
      else await assert.rejects(() => relayStream(stream(), platform));
      const callsAtEnd = draftCalls;
      t.mock.timers.tick(10_000);
      await flushMicrotasks();
      assert.strictEqual(draftCalls, callsAtEnd, `${ending} must not leave a draft timer`);
      assert.strictEqual(sends.length, 0);
    }
  });
});

describe("relayStream typingIndicator=false", () => {
  it("sends no typing indicators when disabled", async () => {
    const { platform, typings } = mockPlatform({ typingIndicator: false });
    const stream = fakeStream(["Hello"]);

    await relayStream(stream, platform);

    assert.strictEqual(typings.length, 0, "Should have no typing indicators");
  });

  it("sends typing indicators when enabled (default)", async () => {
    const { platform, typings } = mockPlatform({ typingIndicator: true });
    const stream = fakeStream(["Hello"]);

    await relayStream(stream, platform);

    assert.ok(typings.length >= 1, "Should have at least one typing indicator");
  });
});

describe("relayStream pre-stream typing handoff", () => {
  it("clears preStreamTypingTimer when relayStream starts", async () => {
    const { platform, typings } = mockPlatform({ typingIndicator: true });
    const stream = fakeStream(["Hello"]);

    // Simulate message queue having set a pre-stream typing timer
    let preStreamTimerCleared = false;
    platform.preStreamTypingTimer = setInterval(() => {
      // this would fire if not cleared
    }, 50);
    const originalTimer = platform.preStreamTypingTimer;

    await relayStream(stream, platform);

    // Pre-stream timer should have been cleared
    assert.strictEqual(platform.preStreamTypingTimer, undefined, "preStreamTypingTimer should be cleared");
    // relayStream's own typing should still have fired
    assert.ok(typings.length >= 1, "relayStream should send its own typing");

    // Clean up just in case
    clearInterval(originalTimer);
  });

  it("clears preStreamTypingTimer even when typingIndicator is false", async () => {
    const { platform } = mockPlatform({ typingIndicator: false });
    const stream = fakeStream(["Hello"]);

    // Pre-stream timer should still be cleared even if typing is disabled
    platform.preStreamTypingTimer = setInterval(() => {}, 50);
    const originalTimer = platform.preStreamTypingTimer;

    await relayStream(stream, platform);

    assert.strictEqual(platform.preStreamTypingTimer, undefined, "preStreamTypingTimer should be cleared");

    clearInterval(originalTimer);
  });
});

describe("relayStream paragraph breaks across tool-use", () => {
  it("inserts paragraph break between text blocks separated by tool_use", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Here's the plan:", "tool_use", "Done! Applied."]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Here's the plan:\n\nDone! Applied.");
  });

  it("does not double paragraph break when text already ends with \\n\\n", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Plan:\n\n", "tool_use", "Done!"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Plan:\n\nDone!");
  });

  it("adds one \\n when text already ends with single \\n", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Plan:\n", "tool_use", "Done!"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Plan:\n\nDone!");
  });

  it("handles multiple tool-use blocks between text", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Part 1", "tool_use", "Part 2", "tool_use", "Part 3"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Part 1\n\nPart 2\n\nPart 3");
  });

  it("does not insert break when tool_use is before any text", async () => {
    const { platform, sends } = mockPlatform();
    // Tool use before first text — no accumulated text yet, no separator needed
    async function* toolFirst(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_stop" } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "Result here" } } } as StreamEvent;
      yield { type: "result", result: "Result here", session_id: "test" } as ResultMessage;
    }

    await relayStream(toolFirst(), platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Result here");
  });

  it("does not insert break when tool_use is before first text arriving in multiple deltas", async () => {
    const { platform, sends } = mockPlatform();
    // Tool use before first text, text arrives in multiple deltas — no spurious \n\n
    async function* toolFirstMultiDelta(): AsyncGenerator<StreamLine> {
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Read" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_stop" } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text" } } } as unknown as StreamEvent;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: "Result" } } } as StreamEvent;
      yield { type: "stream_event", event: { delta: { type: "text_delta", text: " here" } } } as StreamEvent;
      yield { type: "result", result: "Result here", session_id: "test" } as ResultMessage;
    }

    await relayStream(toolFirstMultiDelta(), platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Result here");
  });

  it("preserves paragraph breaks in draft updates", async () => {
    const { platform, drafts, sends } = mockPlatform();
    const stream = fakeStreamWithTools(["Before tool", "tool_use", "After tool"]);

    await relayStream(stream, platform);

    // Final sendMessage should contain the paragraph break
    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Before tool\n\nAfter tool");
  });

  it("preserves paragraph breaks in split messages over 4096 chars", async () => {
    const { platform, sends } = mockPlatform();
    const longBefore = "x".repeat(3000);
    const longAfter = "y".repeat(3000);
    const stream = fakeStreamWithTools([longBefore, "tool_use", longAfter]);

    await relayStream(stream, platform);

    // splitMessage splits at \n\n boundary, consuming it — the paragraph break
    // becomes a message boundary (separate Telegram messages), which is correct.
    assert.strictEqual(sends.length, 2, "Should split into 2 messages");
    assert.strictEqual(sends[0].text, longBefore);
    assert.strictEqual(sends[1].text, longAfter);
  });
});

describe("collapseNewlines", () => {
  it("collapses 4+ consecutive newlines to \\n\\n", () => {
    assert.strictEqual(collapseNewlines("a\n\n\n\nb"), "a\n\nb");
    assert.strictEqual(collapseNewlines("a\n\n\n\n\nb"), "a\n\nb");
  });

  it("collapses 3 consecutive newlines to \\n\\n", () => {
    assert.strictEqual(collapseNewlines("a\n\n\nb"), "a\n\nb");
  });

  it("does not collapse \\n\\n (paragraph break)", () => {
    assert.strictEqual(collapseNewlines("a\n\nb"), "a\n\nb");
  });

  it("does not affect single \\n (line break)", () => {
    assert.strictEqual(collapseNewlines("a\nb"), "a\nb");
  });

  it("handles multiple collapse sites in one string", () => {
    assert.strictEqual(collapseNewlines("a\n\n\nb\n\n\n\nc"), "a\n\nb\n\nc");
  });

  it("returns empty string unchanged", () => {
    assert.strictEqual(collapseNewlines(""), "");
  });

  it("handles string with no newlines", () => {
    assert.strictEqual(collapseNewlines("hello world"), "hello world");
  });
});

describe("relayStream newline collapsing", () => {
  it("collapses excess newlines produced by text ending in \\n + tool_use + text starting with \\n", async () => {
    const { platform, sends } = mockPlatform();
    // text1 ends with \n, tool_use adds another \n (making \n\n), text2 starts with \n → \n\n\n
    const stream = fakeStreamWithTools(["Line 1\n", "tool_use", "\nLine 2"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    // \n\n\n should be collapsed to \n\n
    assert.strictEqual(sends[0].text, "Line 1\n\nLine 2");
    assert.ok(!sends[0].text.includes("\n\n\n"), "Should not contain 3+ consecutive newlines");
  });

  it("collapses newlines in draft updates", async () => {
    const { platform, drafts } = mockPlatform();
    const stream = fakeStreamWithTools(["Before\n", "tool_use", "\nAfter"]);

    await relayStream(stream, platform);

    assert.ok(drafts.length >= 1, "Need at least one draft to verify collapsing");
    for (const draft of drafts) {
      assert.ok(!draft.text.includes("\n\n\n"), "Draft should not contain 3+ consecutive newlines");
    }
  });

  it("preserves \\n\\n after collapsing", async () => {
    const { platform, sends } = mockPlatform();
    // Normal case: paragraph break, no excess
    const stream = fakeStreamWithTools(["Para 1", "tool_use", "Para 2"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Para 1\n\nPara 2");
  });

  it("preserves single \\n after collapsing", async () => {
    const { platform, sends } = mockPlatform();
    // Text with line breaks (not paragraph breaks) — no tool use, no change
    const stream = fakeStream(["Line 1\nLine 2\nLine 3"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Line 1\nLine 2\nLine 3");
  });

  it("collapses newlines in final sendMessage", async () => {
    const { platform, sends } = mockPlatform();
    // Text with 3+ newlines — final sendMessage must collapse them
    const stream = fakeStream(["Hello\n\n\nWorld"]);

    await relayStream(stream, platform);

    assert.ok(sends.length >= 1, "Should have sent at least one message");
    assert.strictEqual(sends[0].text, "Hello\n\nWorld");
  });
});

describe("relayStream sendMessage error handling", () => {
  it("aborts remaining chunks when first chunk fails", async () => {
    const { platform, sends } = mockPlatform({ sendShouldThrow: 1 });
    // Create text that splits into 3 chunks (each ~3000 chars, max is 4096)
    const chunk1 = "a".repeat(3000);
    const chunk2 = "b".repeat(3000);
    const chunk3 = "c".repeat(3000);
    const text = chunk1 + "\n\n" + chunk2 + "\n\n" + chunk3;
    const stream = fakeStream([text]);

    // First chunk fails — throws so the queue's error handler can notify the user
    const failuresBefore = (await finalDeliveryFailures.get()).values[0]?.value ?? 0;
    await assert.rejects(() => relayStream(stream, platform), /Failed to deliver response/);
    const failuresAfter = (await finalDeliveryFailures.get()).values[0]?.value ?? 0;
    assert.strictEqual(failuresAfter, failuresBefore + 1, "production failure wiring increments the final-delivery metric");

    // No chunks should have been sent
    assert.strictEqual(sends.length, 0, "Should not send any chunks when first fails");
  });

  it("continues sending remaining chunks when a non-first chunk fails", async () => {
    const { platform, sends } = mockPlatform({ sendShouldThrow: 2 });
    // Create text that splits into 3 chunks (each ~3000 chars, max is 4096)
    const chunk1 = "a".repeat(3000);
    const chunk2 = "b".repeat(3000);
    const chunk3 = "c".repeat(3000);
    const text = chunk1 + "\n\n" + chunk2 + "\n\n" + chunk3;
    const stream = fakeStream([text]);

    await relayStream(stream, platform);

    // Chunk 1 succeeds, chunk 2 (call 2) fails, chunk 3 succeeds
    assert.strictEqual(sends.length, 2, "Should send chunks 1 and 3 (chunk 2 failed)");
  });

  it("throws when all sendMessage calls fail so queue can notify user", async () => {
    const { platform, sends } = mockPlatform({ sendShouldThrow: true });
    const stream = fakeStream(["Hello"]);

    // Should throw so the queue's error handler can send a user-facing error
    await assert.rejects(() => relayStream(stream, platform), /Failed to deliver response/);

    assert.strictEqual(sends.length, 0, "No messages should be recorded when all sends fail");
  });
});

describe("relayStream NO_REPLY with drafts", () => {
  it("suppresses delivery for exact NO_REPLY", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["NO_REPLY"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 0, "Should not send any messages for NO_REPLY");
  });

  it("suppresses delivery for NO_REPLY with trailing text", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["NO_REPLY\n\nSome explanation text..."]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 0, "Should not send messages when output starts with NO_REPLY");
  });

  it("suppresses delivery for NO_REPLY with surrounding whitespace", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["  NO_REPLY  "]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 0, "Should not send messages for whitespace-padded NO_REPLY");
  });

  it("does not call deleteMessage for NO_REPLY — drafts auto-disappear", async () => {
    const { platform, sends } = mockPlatform();
    let deleteCalled = false;
    platform.deleteMessage = async () => { deleteCalled = true; };

    const stream = fakeStream(["NO_REPLY"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 0, "Should not send any messages for NO_REPLY");
    assert.strictEqual(deleteCalled, false, "Should not call deleteMessage — drafts auto-disappear");
  });

  it("delivers output that starts with NO_REPLY as a substring (e.g. NO_REPLY_EXTRA)", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["NO_REPLY_EXTRA some content"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1, "Should deliver when NO_REPLY is only a substring prefix");
    assert.strictEqual(sends[0].text, "NO_REPLY_EXTRA some content");
  });

  it("suppresses delivery for NO_REPLY followed by punctuation (e.g. NO_REPLY: reason)", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["NO_REPLY: The user didn't ask a question."]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 0, "Should not send messages when output starts with NO_REPLY followed by punctuation");
  });

  it("delivers regular output normally", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["Hello, this is a normal response"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1, "Should deliver regular output");
    assert.strictEqual(sends[0].text, "Hello, this is a normal response");
  });

  it("suppresses delivery for <content>\\n\\nNO_REPLY (end-of-message, blank line before)", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["All checks complete. Everything is clean.\n\nNO_REPLY"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 0, "Should suppress when NO_REPLY is alone on last non-empty line after blank line");
  });

  it("suppresses delivery for <content>\\nNO_REPLY (single newline before)", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["All clean.\nNO_REPLY"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 0, "Should suppress when NO_REPLY is alone on last line after single newline");
  });

  it("suppresses delivery for <content>\\nNO_REPLY\\n (trailing newline)", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["All clean.\nNO_REPLY\n"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 0, "Should suppress when NO_REPLY is alone on last non-empty line with trailing newline");
  });

  it("suppresses operator's leaked workspace-health sample verbatim", async () => {
    const { platform, sends } = mockPlatform();
    const sample = [
      "All checks complete. Let me compile the results:",
      "• Size audit: OK (335M, no bloat)",
      "• Hook integrity: OK",
      "• Config check: 1 warning (settings.local.json missing outputStyle — minor, file doesn't exist)",
      "The only finding is the settings.local.json warning, which is informational.",
      "",
      "NO_REPLY",
    ].join("\n");
    const stream = fakeStream([sample]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 0, "Should suppress multi-line operator sample with end-of-message NO_REPLY");
  });

  it("delivers same-line `Some text NO_REPLY` (token shares line with content)", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["Some text NO_REPLY"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1, "Should deliver when NO_REPLY shares its line with other content");
    assert.strictEqual(sends[0].text, "Some text NO_REPLY");
  });

  it("delivers `Done. NO_REPLY_EXTRA more` (substring prefix on same line)", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["Done. NO_REPLY_EXTRA more"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1, "Should deliver when only a substring prefix appears on the same line");
    assert.strictEqual(sends[0].text, "Done. NO_REPLY_EXTRA more");
  });

  it("delivers `<content>\\n\\nNO_REPLY_EXTRA` (substring alone on last line is NOT exact match)", async () => {
    const { platform, sends } = mockPlatform();
    const stream = fakeStream(["Some content\n\nNO_REPLY_EXTRA"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1, "Should deliver when last non-empty line is NO_REPLY_EXTRA, not exact NO_REPLY");
    assert.strictEqual(sends[0].text, "Some content\n\nNO_REPLY_EXTRA");
  });
});

describe("relayStream edge cases", () => {
  it("delivers resultText when no streaming deltas arrive", async () => {
    const { platform, sends } = mockPlatform();
    // Stream yields only a result message with no text_delta events
    async function* resultOnly(): AsyncGenerator<StreamLine> {
      yield {
        type: "result",
        result: "Fallback text from result",
        session_id: "test",
      } as ResultMessage;
    }

    await relayStream(resultOnly(), platform);

    assert.strictEqual(sends.length, 1, "Should deliver the result text as fallback");
    assert.strictEqual(sends[0].text, "Fallback text from result");
  });

  it("delivers an error result instead of stale streamed deltas", async () => {
    const { platform, sends } = mockPlatform();
    async function* erroredStream(): AsyncGenerator<StreamLine> {
      yield {
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "stale partial text" } },
      } as StreamEvent;
      yield {
        type: "result",
        result: "Visible failure from Pi",
        session_id: "test",
        is_error: true,
      } as ResultMessage;
    }

    await relayStream(erroredStream(), platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "Visible failure from Pi");
  });

  it("clears stale accumulated deltas after a retry reset signal", async () => {
    const { platform, sends } = mockPlatform();
    async function* recoveredStream(): AsyncGenerator<StreamLine> {
      yield {
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "stale pre-retry text" } },
      } as StreamEvent;
      yield {
        type: "assistant",
        subtype: "control_request",
        action: "reset_response_text",
        reason: "pi_context_overflow_retry",
      };
      yield {
        type: "result",
        result: "post-compaction answer",
        session_id: "test",
      } as ResultMessage;
    }

    await relayStream(recoveredStream(), platform);

    assert.strictEqual(sends.length, 1);
    assert.strictEqual(sends[0].text, "post-compaction answer");
  });

  it("handles empty stream without sending any messages", async () => {
    const { platform, sends, drafts } = mockPlatform();
    async function* emptyStream(): AsyncGenerator<StreamLine> {
      // yields nothing
    }

    await relayStream(emptyStream(), platform);

    assert.strictEqual(sends.length, 0, "Should not send any messages for empty stream");
    assert.strictEqual(drafts.length, 0, "Should not send any drafts for empty stream");
  });

  it("still delivers final message when sendDraft throws", async () => {
    const { platform, sends } = mockPlatform();
    platform.sendDraft = async () => { throw new Error("draft API unavailable"); };

    const stream = fakeStream(["Hello", " ", "world"]);

    await relayStream(stream, platform);

    assert.strictEqual(sends.length, 1, "Final message should still be delivered");
    assert.strictEqual(sends[0].text, "Hello world");
  });
});
