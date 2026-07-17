import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { open, writeFile, unlink, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { recordMediaDownloadRetry } from "./metrics.js";

const execFileAsync = promisify(execFileCb);

export const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "/opt/homebrew/bin/ffmpeg";
export const WHISPER_BIN = process.env.WHISPER_BIN ?? "/opt/homebrew/bin/whisper-cli";
export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? join(homedir(), ".minime/models/ggml-medium.bin");
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_MAX_ATTEMPTS = 3;
const DOWNLOAD_RETRY_BASE_DELAY_MS = 100;
const DOWNLOAD_MAX_RETRY_AFTER_MS = 5_000;
const KNOWN_TRAILING_ASR_ARTIFACT_PATTERNS: readonly RegExp[] = [
  /(?<![\p{L}\p{M}\p{N}_])продолжение\s+следует(?:\s*[.!?…]+)?\s*$/iu,
];

export type MediaPipelineStage =
  | "metadata"
  | "download"
  | "size-limit"
  | "conversion"
  | "transcription"
  | "empty-transcript";

const STAGE_MESSAGES: Record<MediaPipelineStage, string> = {
  metadata: "Media metadata could not be retrieved",
  download: "Media download failed",
  "size-limit": "Media exceeds the configured size limit",
  conversion: "Audio conversion failed",
  transcription: "Audio transcription failed",
  "empty-transcript": "Audio transcription returned an empty result",
};

/** A bounded public error with the useful underlying cause retained internally. */
export class MediaPipelineError extends Error {
  readonly stage: MediaPipelineStage;

  constructor(stage: MediaPipelineStage, cause?: unknown) {
    super(STAGE_MESSAGES[stage], { cause });
    this.name = "MediaPipelineError";
    this.stage = stage;
  }
}

export function toMediaPipelineError(error: unknown, stage: MediaPipelineStage): MediaPipelineError {
  return error instanceof MediaPipelineError ? error : new MediaPipelineError(stage, error);
}

export function mediaPipelineStage(error: unknown, fallback: MediaPipelineStage): MediaPipelineStage {
  return error instanceof MediaPipelineError ? error.stage : fallback;
}

/** Format a stage-specific user message without including error details. */
export function mediaPipelineFailureMessage(
  error: unknown,
  fallback: MediaPipelineStage,
): string {
  switch (mediaPipelineStage(error, fallback)) {
    case "metadata":
      return "Could not retrieve media metadata. Please try again.";
    case "download":
      return "Could not download media. Please try again.";
    case "size-limit":
      return "Media is too large to process.";
    case "conversion":
      return "Could not convert the audio. Please try again or send text.";
    case "transcription":
      return "Could not transcribe the audio. Please try again or send text.";
    case "empty-transcript":
      return "Could not transcribe the audio (empty result). Please try again or send text.";
  }
}

export function requireTranscript(transcript: string): string {
  if (!transcript) throw new MediaPipelineError("empty-transcript");
  return transcript;
}

export function stripKnownTrailingAsrArtifacts(transcript: string): string {
  for (const pattern of KNOWN_TRAILING_ASR_ARTIFACT_PATTERNS) {
    const processed = transcript.replace(pattern, "");
    if (processed !== transcript) return processed.trimEnd();
  }
  return transcript;
}

export interface DownloadFileOptions {
  maxBytes?: number;
  timeoutMs?: number;
}

class DownloadAttemptError extends Error {
  constructor(
    readonly retryable: boolean,
    readonly retryAfterMs: number | undefined,
    cause?: unknown,
  ) {
    super("Media download attempt failed", { cause });
  }
}

function retryAfterMs(headers: Headers | { get?: (name: string) => string | null } | undefined): number | undefined {
  const value = headers?.get?.("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  if (!Number.isFinite(delay)) return undefined;
  return Math.max(0, Math.min(delay, DOWNLOAD_MAX_RETRY_AFTER_MS));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function downloadAttempt(
  url: string,
  destPath: string,
  maxBytes: number | undefined,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let resp: Response;
    try {
      resp = await fetch(url, { signal: controller.signal });
    } catch (error) {
      throw new DownloadAttemptError(true, undefined, error);
    }

    if (!resp.ok) {
      controller.abort();
      void resp.body?.cancel().catch(() => {});
      const retryable = isRetryableStatus(resp.status);
      throw new DownloadAttemptError(
        retryable,
        retryable ? retryAfterMs(resp.headers) : undefined,
        new Error(`HTTP ${resp.status}`),
      );
    }

    const contentLength = resp.headers?.get?.("content-length");
    if (contentLength && maxBytes !== undefined) {
      const declaredBytes = Number(contentLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        controller.abort();
        void resp.body?.cancel().catch(() => {});
        throw new MediaPipelineError("size-limit");
      }
    }

    if (!resp.body) {
      let buffer: Buffer;
      try {
        buffer = Buffer.from(await resp.arrayBuffer());
      } catch (error) {
        throw new DownloadAttemptError(true, undefined, error);
      }
      if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
        controller.abort();
        throw new MediaPipelineError("size-limit");
      }
      await writeFile(destPath, buffer, { mode: 0o600 });
      await chmod(destPath, 0o600);
      return;
    }

    const file = await open(destPath, "w", 0o600);
    await file.chmod(0o600);
    let written = 0;
    try {
      const reader = resp.body.getReader();
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          throw new DownloadAttemptError(true, undefined, error);
        }
        if (chunk.done) break;
        written += chunk.value.byteLength;
        if (maxBytes !== undefined && written > maxBytes) {
          controller.abort();
          void reader.cancel().catch(() => {});
          throw new MediaPipelineError("size-limit");
        }
        await file.write(chunk.value);
      }
    } finally {
      await file.close();
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate a unique temp file path with given prefix and extension.
 */
export function tempFilePath(prefix: string, extension: string): string {
  return `${tmpdir()}/bot-${prefix}-${randomUUID()}${extension}`;
}

/**
 * Download a file from a URL to a local path.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  options: DownloadFileOptions = {},
): Promise<void> {
  const maxBytes = options.maxBytes;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  await cleanupTempFile(destPath);

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt += 1) {
    try {
      await downloadAttempt(url, destPath, maxBytes, timeoutMs);
      if (attempt > 1) recordMediaDownloadRetry("recovered");
      return;
    } catch (error) {
      await cleanupTempFile(destPath);
      if (error instanceof MediaPipelineError) throw error;
      const retryable = error instanceof DownloadAttemptError && error.retryable;
      if (!retryable || attempt === DOWNLOAD_MAX_ATTEMPTS) {
        if (retryable) recordMediaDownloadRetry("exhausted");
        const cause = error instanceof DownloadAttemptError ? error.cause : error;
        throw new MediaPipelineError("download", cause);
      }
      const backoff = DOWNLOAD_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      await wait(error.retryAfterMs ?? backoff);
    }
  }
}

/**
 * Convert an audio file to 16kHz mono WAV using ffmpeg.
 * Returns the path to the generated WAV file.
 */
export async function convertToWav(inputPath: string): Promise<string> {
  const wavPath = tempFilePath("voice-wav", ".wav");
  try {
    await execFileAsync(FFMPEG_BIN, [
      "-i", inputPath,
      "-ar", "16000",
      "-ac", "1",
      "-f", "wav",
      wavPath,
      "-y",
    ], { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 });
    await chmod(wavPath, 0o600);
  } catch (err) {
    await cleanupTempFile(wavPath);
    throw toMediaPipelineError(err, "conversion");
  }
  return wavPath;
}

/**
 * Transcribe an audio file using local whisper-cli.
 * Converts to WAV first since whisper-cli cannot decode Opus-in-OGG directly.
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const wavPath = await convertToWav(filePath);
  try {
    try {
      const { stdout } = await execFileAsync(WHISPER_BIN, [
        "-m", WHISPER_MODEL,
        "-f", wavPath,
        "--no-timestamps",
        "--no-prints",
        "--language", process.env.WHISPER_LANGUAGE ?? "auto",
      ], { timeout: 120_000 });
      return stripKnownTrailingAsrArtifacts(stdout.trim());
    } catch (error) {
      throw toMediaPipelineError(error, "transcription");
    }
  } finally {
    await cleanupTempFile(wavPath);
  }
}

/**
 * Remove a temp file, ignoring errors if it doesn't exist.
 */
export async function cleanupTempFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Ignore - file may already be gone
  }
}
