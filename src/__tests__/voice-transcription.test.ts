import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

let whisperStdout = "";
const execFileCalls: Array<{
  file: string;
  args: string[];
  options: Record<string, unknown>;
  inputMode?: number;
}> = [];
const originalFetch = globalThis.fetch;

function execFileMock(): never {
  throw new Error("unexpected callback-style execFile invocation");
}

Object.defineProperty(execFileMock, promisify.custom, {
  value: async (
    file: string,
    args: string[],
    options: Record<string, unknown>,
  ) => {
    execFileCalls.push({
      file,
      args,
      options,
      ...(args[0] === "-i" && existsSync(args[1])
        ? { inputMode: statSync(args[1]).mode & 0o777 }
        : {}),
    });
    if (args.includes("--no-timestamps")) {
      return { stdout: whisperStdout, stderr: "" };
    }

    const wavPath = args.at(-2);
    assert.ok(wavPath, "ffmpeg output path is required");
    writeFileSync(wavPath, "");
    return { stdout: "", stderr: "" };
  },
});

mock.module("node:child_process", {
  namedExports: { execFile: execFileMock },
});

const {
  FFMPEG_BIN,
  MediaPipelineError,
  WHISPER_BIN,
  ingestLocalAudio,
  requireTranscript,
  transcribeAudio,
} = await import("../voice.js");

afterEach(() => {
  whisperStdout = "";
  execFileCalls.length = 0;
  globalThis.fetch = originalFetch;
});

describe("transcribeAudio ASR postprocessing", () => {
  it("normalizes mocked whisper stdout at the shared transcription boundary", async () => {
    const cases = [
      ["  Готово. Продолжение следует...  \n", "Готово."],
      ["  Обычный текст.  \n", "Обычный текст."],
    ] as const;

    for (const [stdout, expected] of cases) {
      whisperStdout = stdout;
      assert.strictEqual(await transcribeAudio("ignored-input.oga"), expected);
    }

    whisperStdout = "Продолжение следует…\n";
    const artifactOnlyTranscript = await transcribeAudio("ignored-input.oga");
    assert.strictEqual(artifactOnlyTranscript, "");
    assert.throws(
      () => requireTranscript(artifactOnlyTranscript),
      (error: Error) => error instanceof MediaPipelineError && error.stage === "empty-transcript",
    );
  });

  it("owns bounded local download, binaries, private files, and cleanup", async () => {
    const sourceUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      sourceUrls.push(String(input));
      return new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]));
    }) as typeof fetch;
    whisperStdout = "Локальная расшифровка.\n";
    const controller = new AbortController();

    const transcript = await ingestLocalAudio(
      "https://api.telegram.org/file/botTEST_TOKEN/voice/file.oga",
      {
        maxBytes: 4,
        downloadTimeoutMs: 1_234,
        signal: controller.signal,
      },
    );

    assert.strictEqual(transcript, "Локальная расшифровка.");
    assert.deepStrictEqual(sourceUrls, [
      "https://api.telegram.org/file/botTEST_TOKEN/voice/file.oga",
    ]);
    assert.strictEqual(execFileCalls.length, 2);
    const [ffmpeg, whisper] = execFileCalls;
    assert.strictEqual(ffmpeg.file, FFMPEG_BIN);
    assert.strictEqual(whisper.file, WHISPER_BIN);
    assert.strictEqual(ffmpeg.options.timeout, 30_000);
    assert.strictEqual(whisper.options.timeout, 120_000);
    assert.strictEqual(ffmpeg.options.signal, controller.signal);
    assert.strictEqual(whisper.options.signal, controller.signal);
    const sourcePath = ffmpeg.args[1];
    const wavPath = whisper.args[whisper.args.indexOf("-f") + 1];
    assert.match(sourcePath, /\/bot-voice-[A-Za-z0-9-]+\.oga$/);
    assert.match(wavPath, /\/bot-voice-wav-[A-Za-z0-9-]+\.wav$/);
    assert.strictEqual(ffmpeg.inputMode, 0o600);
    assert.strictEqual(existsSync(sourcePath), false);
    assert.strictEqual(existsSync(wavPath), false);
  });
});
