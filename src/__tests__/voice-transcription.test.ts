import { after, afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

let whisperStdout = "";
let execFailure: "ffmpeg" | "whisper" | null = null;
const execFileCalls: Array<{
  file: string;
  args: string[];
  options: Record<string, unknown>;
  inputMode?: number;
}> = [];
const originalFetch = globalThis.fetch;
const originalWhisperGlossaryPath = process.env.WHISPER_GLOSSARY_PATH;
const originalWhisperLanguage = process.env.WHISPER_LANGUAGE;
const glossaryPaths = new Set<string>();

delete process.env.WHISPER_GLOSSARY_PATH;
delete process.env.WHISPER_LANGUAGE;

function createGlossary(contents: string): string {
  const path = `/tmp/minime-test-voice-glossary-${crypto.randomUUID()}.txt`;
  glossaryPaths.add(path);
  writeFileSync(path, contents, { mode: 0o600 });
  return path;
}

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
    const whisper = args.includes("--no-timestamps");
    if (
      execFailure === (whisper ? "whisper" : "ffmpeg")
    ) throw new Error(`synthetic ${execFailure} failure`);
    if (whisper) {
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

const TEST_MODEL_PATH = "/tmp/minime-test-whisper-model.bin";

function whisperCalls(): typeof execFileCalls {
  return execFileCalls.filter(({ args }) => args.includes("--no-timestamps"));
}

function historicalWhisperArgs(actualArgs: string[], modelPath = TEST_MODEL_PATH): string[] {
  const wavPath = actualArgs[actualArgs.indexOf("-f") + 1];
  assert.ok(wavPath);
  return [
    "-m", modelPath,
    "-f", wavPath,
    "--no-timestamps",
    "--no-prints",
    "--language", "auto",
  ];
}

afterEach(() => {
  whisperStdout = "";
  execFailure = null;
  execFileCalls.length = 0;
  globalThis.fetch = originalFetch;
  delete process.env.WHISPER_GLOSSARY_PATH;
  delete process.env.WHISPER_LANGUAGE;
  for (const path of glossaryPaths) {
    rmSync(path, { force: true });
  }
  glossaryPaths.clear();
});

after(() => {
  if (originalWhisperGlossaryPath === undefined) delete process.env.WHISPER_GLOSSARY_PATH;
  else process.env.WHISPER_GLOSSARY_PATH = originalWhisperGlossaryPath;
  if (originalWhisperLanguage === undefined) delete process.env.WHISPER_LANGUAGE;
  else process.env.WHISPER_LANGUAGE = originalWhisperLanguage;
});

describe("transcribeAudio ASR postprocessing", () => {
  it("passes the configured model path in the exact Whisper argv", async () => {
    const cases: Array<{ path?: string; contents?: string }> = [
      {},
      { path: "/tmp/minime-test-missing-voice-glossary.txt" },
      { contents: "  \n # comment only\n\t# another comment\n" },
      { contents: "🙂".repeat(56) },
    ];

    for (const testCase of cases) {
      execFileCalls.length = 0;
      if (testCase.contents !== undefined) {
        process.env.WHISPER_GLOSSARY_PATH = createGlossary(testCase.contents);
      } else if (testCase.path !== undefined) {
        process.env.WHISPER_GLOSSARY_PATH = testCase.path;
      } else {
        delete process.env.WHISPER_GLOSSARY_PATH;
      }

      await transcribeAudio("ignored-input.oga", TEST_MODEL_PATH);
      const [whisper] = whisperCalls();
      assert.ok(whisper);
      assert.deepStrictEqual(whisper.args, historicalWhisperArgs(whisper.args));
    }
  });

  it("appends exactly one bounded prompt after all historical Whisper arguments", async () => {
    process.env.WHISPER_GLOSSARY_PATH = createGlossary([
      "# synthetic terms",
      "Alpha",
      "alpha",
      "Beta",
    ].join("\n"));

    await transcribeAudio("ignored-input.oga", TEST_MODEL_PATH);

    const [whisper] = whisperCalls();
    assert.ok(whisper);
    assert.deepStrictEqual(whisper.args, [
      ...historicalWhisperArgs(whisper.args),
      "--prompt", "Alpha, Beta",
    ]);
    assert.strictEqual(whisper.args.filter((arg) => arg === "--prompt").length, 1);
  });

  it("reloads the configured glossary before every transcription", async () => {
    const glossaryPath = createGlossary("First Term\n");
    process.env.WHISPER_GLOSSARY_PATH = glossaryPath;

    await transcribeAudio("first-input.oga", TEST_MODEL_PATH);
    writeFileSync(glossaryPath, "Second Term\nThird Term\n", { mode: 0o600 });
    await transcribeAudio("second-input.oga", TEST_MODEL_PATH);

    assert.deepStrictEqual(
      whisperCalls().map(({ args }) => args.slice(-2)),
      [
        ["--prompt", "First Term"],
        ["--prompt", "Second Term, Third Term"],
      ],
    );
  });

  it("wraps non-missing glossary read failures as redacted transcription errors", async () => {
    const glossaryPath = createGlossary("Synthetic Term\n");
    chmodSync(glossaryPath, 0o000);
    process.env.WHISPER_GLOSSARY_PATH = glossaryPath;

    await assert.rejects(
      transcribeAudio("ignored-input.oga", TEST_MODEL_PATH),
      (error: Error) => {
        assert.ok(error instanceof MediaPipelineError);
        assert.strictEqual(error.stage, "transcription");
        assert.strictEqual(error.message, "Audio transcription failed");
        assert.doesNotMatch(error.message, /Synthetic Term|voice-glossary|\/tmp\//);
        return true;
      },
    );
    assert.strictEqual(whisperCalls().length, 0);
  });

  it("normalizes mocked whisper stdout at the shared transcription boundary", async () => {
    const cases = [
      ["  Готово. Продолжение следует...  \n", "Готово."],
      ["  Обычный текст.  \n", "Обычный текст."],
    ] as const;

    for (const [stdout, expected] of cases) {
      whisperStdout = stdout;
      assert.strictEqual(await transcribeAudio("ignored-input.oga", TEST_MODEL_PATH), expected);
    }

    whisperStdout = "Продолжение следует…\n";
    const artifactOnlyTranscript = await transcribeAudio("ignored-input.oga", TEST_MODEL_PATH);
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
        modelPath: TEST_MODEL_PATH,
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

  it("reclaims private source and WAV files on conversion, transcription, and empty-result failures", async () => {
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))) as typeof fetch;

    for (const failure of ["ffmpeg", "whisper", "empty"] as const) {
      execFileCalls.length = 0;
      execFailure = failure === "empty" ? null : failure;
      whisperStdout = "";

      await assert.rejects(
        ingestLocalAudio(
          `https://api.telegram.org/file/botTEST_TOKEN/voice/${failure}.oga`,
          { maxBytes: 4, modelPath: TEST_MODEL_PATH },
        ),
        (error: unknown) =>
          error instanceof MediaPipelineError
          && error.stage === (
            failure === "ffmpeg"
              ? "conversion"
              : failure === "whisper"
                ? "transcription"
                : "empty-transcript"
          ),
      );

      const ffmpeg = execFileCalls[0];
      assert.ok(ffmpeg);
      const sourcePath = ffmpeg.args[1];
      const wavPath = ffmpeg.args.at(-2);
      assert.ok(wavPath);
      assert.equal(existsSync(sourcePath), false);
      assert.equal(existsSync(wavPath), false);
    }
  });
});
