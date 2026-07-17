import { afterEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";

let whisperStdout = "";

function execFileMock(): never {
  throw new Error("unexpected callback-style execFile invocation");
}

Object.defineProperty(execFileMock, promisify.custom, {
  value: async (_file: string, args: string[]) => {
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
  MediaPipelineError,
  requireTranscript,
  transcribeAudio,
} = await import("../voice.js");

afterEach(() => {
  whisperStdout = "";
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
});
