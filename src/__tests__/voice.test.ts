import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MediaPipelineError,
  tempFilePath,
  downloadFile,
  cleanupTempFile,
  transcribeAudio,
  convertToWav,
  mediaPipelineFailureMessage,
  requireTranscript,
  FFMPEG_BIN,
  WHISPER_BIN,
  WHISPER_MODEL,
} from "../voice.js";
import { mediaDownloadRetries } from "../metrics.js";

async function retryMetricValue(result: "recovered" | "exhausted"): Promise<number> {
  return (await mediaDownloadRetries.get()).values.find(({ labels }) => labels.result === result)?.value ?? 0;
}

describe("tempFilePath", () => {
  it("generates path with correct prefix and extension", () => {
    const path = tempFilePath("voice", ".oga");
    assert.ok(path.includes("/bot-voice-"), `Expected path to contain /bot-voice-, got: ${path}`);
    assert.ok(path.endsWith(".oga"), `Expected path to end with .oga, got: ${path}`);
  });

  it("generates unique paths on each call", () => {
    const a = tempFilePath("voice", ".oga");
    const b = tempFilePath("voice", ".oga");
    assert.notStrictEqual(a, b);
  });

  it("uses the given prefix", () => {
    const path = tempFilePath("photo", ".jpg");
    assert.ok(path.includes("/bot-photo-"));
    assert.ok(path.endsWith(".jpg"));
  });
});

describe("downloadFile", () => {
  const testDest = "/tmp/minime-test-download-voice.oga";

  afterEach(() => {
    try { rmSync(testDest); } catch { /* ignore */ }
  });

  it("writes fetched content to destination", async () => {
    const testData = new Uint8Array([0x4f, 0x67, 0x67, 0x53]); // OggS magic
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      arrayBuffer: async () => testData.buffer,
    })) as unknown as typeof fetch;

    try {
      await downloadFile("https://api.telegram.org/file/bot123/voice/file.oga", testDest);
      assert.ok(existsSync(testDest));
      const content = readFileSync(testDest);
      assert.strictEqual(content.length, 4);
      assert.strictEqual(content[0], 0x4f); // 'O'
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on HTTP error response", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return { ok: false, status: 404 };
    }) as unknown as typeof fetch;

    try {
      await assert.rejects(
        () => downloadFile("https://example.com/missing.oga", testDest),
        (error: Error) => error instanceof MediaPipelineError && error.stage === "download",
      );
      assert.strictEqual(calls, 1);
      assert.ok(!existsSync(testDest));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("aborts when fetched content exceeds the configured byte limit", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    })) as unknown as typeof fetch;

    try {
      await assert.rejects(
        () => downloadFile("https://example.com/large.oga", testDest, { maxBytes: 3 }),
        (error: Error) => error instanceof MediaPipelineError && error.stage === "size-limit",
      );
      assert.ok(!existsSync(testDest));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recovers from a transient fetch failure without duplicating content", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary network failure");
      return new Response(new Uint8Array([1, 2, 3]));
    }) as unknown as typeof fetch;

    try {
      const metricBefore = await retryMetricValue("recovered");
      await downloadFile("https://example.com/file.oga", testDest);
      assert.strictEqual(calls, 2);
      assert.deepStrictEqual([...readFileSync(testDest)], [1, 2, 3]);
      assert.strictEqual(await retryMetricValue("recovered"), metricBefore + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exhausts bounded retries and retains the final cause internally", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error(`transient-${calls}`);
    }) as unknown as typeof fetch;

    try {
      const metricBefore = await retryMetricValue("exhausted");
      await assert.rejects(
        () => downloadFile("https://example.com/file.oga", testDest),
        (error: Error) => {
          assert.ok(error instanceof MediaPipelineError);
          assert.strictEqual(error.stage, "download");
          assert.strictEqual((error.cause as Error).message, "transient-3");
          return true;
        },
      );
      assert.strictEqual(calls, 3);
      assert.ok(!existsSync(testDest));
      assert.strictEqual(await retryMetricValue("exhausted"), metricBefore + 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries 408, 429, and 5xx responses but not permanent 4xx", async () => {
    const originalFetch = globalThis.fetch;
    try {
      for (const status of [408, 429, 503]) {
        let calls = 0;
        globalThis.fetch = (async () => {
          calls += 1;
          if (calls === 1) {
            return new Response(null, {
              status,
              headers: status === 429 ? { "Retry-After": "0" } : undefined,
            });
          }
          return new Response(new Uint8Array([status % 256]));
        }) as unknown as typeof fetch;
        await downloadFile("https://example.com/retryable", testDest);
        assert.strictEqual(calls, 2, `expected HTTP ${status} to retry once`);
      }

      let permanentCalls = 0;
      globalThis.fetch = (async () => {
        permanentCalls += 1;
        return new Response(null, { status: 403 });
      }) as unknown as typeof fetch;
      await assert.rejects(() => downloadFile("https://example.com/permanent", testDest));
      assert.strictEqual(permanentCalls, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("cancels response bodies on retry and size-limit early exits", async () => {
    const originalFetch = globalThis.fetch;
    let statusBodyCancels = 0;
    let declaredBodyCancels = 0;
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 503,
            headers: { get: (name: string) => name === "retry-after" ? "0" : null },
            body: { cancel: async () => { statusBodyCancels += 1; } },
          };
        }
        return new Response(new Uint8Array([1]));
      }) as unknown as typeof fetch;
      await downloadFile("https://example.com/retry-cancel", testDest);
      assert.strictEqual(statusBodyCancels, 1);

      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        headers: { get: (name: string) => name === "content-length" ? "10" : null },
        body: { cancel: async () => { declaredBodyCancels += 1; } },
      })) as unknown as typeof fetch;
      await assert.rejects(
        () => downloadFile("https://example.com/declared-cancel", testDest, { maxBytes: 3 }),
        (error: Error) => error instanceof MediaPipelineError && error.stage === "size-limit",
      );
      assert.strictEqual(declaredBodyCancels, 1);

      let streamedBodyCancels = 0;
      globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
        },
        cancel() {
          streamedBodyCancels += 1;
        },
      }))) as unknown as typeof fetch;
      await assert.rejects(
        () => downloadFile("https://example.com/stream-cancel", testDest, { maxBytes: 3 }),
        (error: Error) => error instanceof MediaPipelineError && error.stage === "size-limit",
      );
      assert.strictEqual(streamedBodyCancels, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("honors bounded numeric and HTTP-date Retry-After on every retryable status", async (t) => {
    const originalFetch = globalThis.fetch;
    const realSetTimeout = globalThis.setTimeout;
    const observedRetryDelays: number[] = [];
    t.mock.method(Date, "now", () => 1_000);
    t.mock.method(globalThis, "setTimeout", ((callback: (...args: any[]) => void, delay = 0, ...args: any[]) => {
      const delayMs = Number(delay);
      if (delayMs === 30_000) {
        return realSetTimeout(callback, delayMs, ...args);
      }
      observedRetryDelays.push(delayMs);
      return realSetTimeout(callback, 0, ...args);
    }) as typeof setTimeout);

    try {
      const cases = [
        { status: 429, header: () => "2", expectedMs: 2_000 },
        { status: 503, header: () => new Date(Date.now() + 3_000).toUTCString(), expectedMs: 3_000 },
        { status: 408, header: () => "999", expectedMs: 5_000 },
      ];
      for (const testCase of cases) {
        let calls = 0;
        globalThis.fetch = (async () => {
          calls += 1;
          if (calls === 1) {
            return new Response(null, {
              status: testCase.status,
              headers: { "Retry-After": testCase.header() },
            });
          }
          return new Response(new Uint8Array([1]));
        }) as unknown as typeof fetch;

        await downloadFile(`https://example.com/retry-after-${testCase.status}`, testDest);
        assert.strictEqual(calls, 2);
        assert.strictEqual(observedRetryDelays.at(-1), testCase.expectedMs);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("creates fresh timeout state for every attempt", async () => {
    const originalFetch = globalThis.fetch;
    const signals: AbortSignal[] = [];
    const initiallyAborted: boolean[] = [];
    let calls = 0;
    globalThis.fetch = ((_url, init) => {
      calls += 1;
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      initiallyAborted.push(signal.aborted);
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      return Promise.resolve(new Response(new Uint8Array([7])));
    }) as typeof fetch;

    try {
      await downloadFile("https://example.com/timeout", testDest, { timeoutMs: 5 });
      assert.strictEqual(calls, 2);
      assert.notStrictEqual(signals[0], signals[1]);
      assert.deepStrictEqual(initiallyAborted, [false, false]);
      assert.strictEqual(signals[0].aborted, true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("removes a corrupt partial file before retrying a failed stream", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 2) {
        assert.strictEqual(existsSync(testDest), false, "partial file must be removed before retry");
        return new Response(new Uint8Array([9, 8]));
      }
      let pulled = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!pulled) {
            pulled = true;
            controller.enqueue(new Uint8Array([1, 2, 3]));
          } else {
            controller.error(new Error("stream reset"));
          }
        },
      }));
    }) as unknown as typeof fetch;

    try {
      await downloadFile("https://example.com/stream", testDest);
      assert.deepStrictEqual([...readFileSync(testDest)], [9, 8]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("enforces declared and streamed size limits on every attempt without retry", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(new Uint8Array([1]), { headers: { "Content-Length": "10" } });
      }) as unknown as typeof fetch;
      await assert.rejects(
        () => downloadFile("https://example.com/declared-large", testDest, { maxBytes: 3 }),
        (error: Error) => error instanceof MediaPipelineError && error.stage === "size-limit",
      );
      assert.strictEqual(calls, 1);

      calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(new Uint8Array([1, 2, 3, 4]));
      }) as unknown as typeof fetch;
      await assert.rejects(
        () => downloadFile("https://example.com/stream-large", testDest, { maxBytes: 3 }),
        (error: Error) => error instanceof MediaPipelineError && error.stage === "size-limit",
      );
      assert.strictEqual(calls, 1);
      assert.strictEqual(existsSync(testDest), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("sets destination permissions to 0600 even when replacing an existing file", async () => {
    writeFileSync(testDest, "old", { mode: 0o644 });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Uint8Array([4, 5]))) as unknown as typeof fetch;
    try {
      await downloadFile("https://example.com/private", testDest);
      assert.strictEqual(statSync(testDest).mode & 0o777, 0o600);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes a bounded redacted error while retaining a sensitive cause internally", async () => {
    const originalFetch = globalThis.fetch;
    const secretUrl = "https://example.com/file?token=super-secret";
    globalThis.fetch = (async () => {
      throw new Error(`network failed for ${secretUrl} at ${testDest}`);
    }) as unknown as typeof fetch;
    try {
      await assert.rejects(
        () => downloadFile(secretUrl, testDest),
        (error: Error) => {
          assert.ok(error instanceof MediaPipelineError);
          assert.strictEqual(error.message, "Media download failed");
          assert.doesNotMatch(error.message, /super-secret|example\.com|\/tmp\//);
          assert.match((error.cause as Error).message, /super-secret/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("media pipeline stages", () => {
  it("uses typed conversion and empty-transcript failures", async () => {
    await assert.rejects(
      () => convertToWav("/tmp/minime-nonexistent-audio-99999.oga"),
      (error: Error) => error instanceof MediaPipelineError && error.stage === "conversion",
    );
    assert.throws(
      () => requireTranscript(""),
      (error: Error) => error instanceof MediaPipelineError && error.stage === "empty-transcript",
    );
  });

  it("maps every bounded stage to an accurate user-visible message", () => {
    const expected = new Map([
      ["metadata", /metadata/],
      ["download", /download/],
      ["size-limit", /too large/],
      ["conversion", /convert/],
      ["transcription", /transcribe/],
      ["empty-transcript", /empty result/],
    ] as const);
    for (const [stage, pattern] of expected) {
      const message = mediaPipelineFailureMessage(new MediaPipelineError(stage), "download");
      assert.match(message, pattern);
      assert.ok(message.length < 120);
    }
  });
});

describe("convertToWav", () => {
  it("exports correct ffmpeg path", () => {
    const expectedFfmpeg = process.env.FFMPEG_BIN ?? "/opt/homebrew/bin/ffmpeg";
    assert.strictEqual(FFMPEG_BIN, expectedFfmpeg);
  });

  it(
    "converts a valid audio file to 16kHz mono WAV",
    { skip: existsSync(FFMPEG_BIN) ? false : `${FFMPEG_BIN} is not available` },
    async () => {
    // Create a minimal valid WAV: 44-byte RIFF header + 2 bytes of silence
    const header = Buffer.alloc(46);
    header.write("RIFF", 0);
    header.writeUInt32LE(38, 4);
    header.write("WAVE", 8);
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(44100, 24); // sample rate
    header.writeUInt32LE(88200, 28); // byte rate
    header.writeUInt16LE(2, 32); // block align
    header.writeUInt16LE(16, 34); // bits per sample
    header.write("data", 36);
    header.writeUInt32LE(2, 40); // 2 bytes of audio data
    // 2 bytes of silence already zeroed

    const inputPath = tempFilePath("test-input", ".wav");
    writeFileSync(inputPath, header);

    try {
      const outputPath = await convertToWav(inputPath);
      try {
        assert.ok(existsSync(outputPath), "Output WAV file should exist");
        assert.ok(outputPath.includes("/bot-voice-wav-"), "Output path should use voice-wav prefix");
        assert.ok(outputPath.endsWith(".wav"), "Output should have .wav extension");
        const content = readFileSync(outputPath);
        assert.strictEqual(content.toString("ascii", 0, 4), "RIFF", "Output should have RIFF header");
      } finally {
        await cleanupTempFile(outputPath);
      }
    } finally {
      rmSync(inputPath, { force: true });
    }
    },
  );

  it("rejects when given a nonexistent input file", async () => {
    await assert.rejects(
      () => convertToWav("/tmp/minime-nonexistent-audio-99999.oga"),
      (err: Error) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});

describe("transcribeAudio", () => {
  it("exports correct whisper-cli paths", () => {
    assert.strictEqual(WHISPER_BIN, "/opt/homebrew/bin/whisper-cli");
    const expectedModel = process.env.WHISPER_MODEL ?? join(homedir(), ".minime/models/ggml-medium.bin");
    assert.strictEqual(WHISPER_MODEL, expectedModel);
  });

  it("rejects when given a nonexistent audio file", async () => {
    await assert.rejects(
      () => transcribeAudio("/tmp/minime-nonexistent-audio-99999.oga"),
      (err: Error) => {
        assert.ok(err instanceof Error);
        return true;
      },
    );
  });
});

describe("cleanupTempFile", () => {
  it("removes an existing file", async () => {
    const path = "/tmp/minime-test-cleanup-voice.tmp";
    writeFileSync(path, "test data");
    assert.ok(existsSync(path));

    await cleanupTempFile(path);
    assert.ok(!existsSync(path));
  });

  it("does not throw for non-existent file", async () => {
    // Should complete without error
    await cleanupTempFile("/tmp/minime-nonexistent-file-12345.tmp");
  });
});
