import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { open, writeFile, unlink, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCb);

export const FFMPEG_BIN = process.env.FFMPEG_BIN ?? "/opt/homebrew/bin/ffmpeg";
export const WHISPER_BIN = process.env.WHISPER_BIN ?? "/opt/homebrew/bin/whisper-cli";
export const WHISPER_MODEL = process.env.WHISPER_MODEL ?? join(homedir(), ".minime/models/ggml-medium.bin");
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface DownloadFileOptions {
  maxBytes?: number;
  timeoutMs?: number;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`Download failed: HTTP ${resp.status}`);
    }

    const headers = resp.headers as { get?: (name: string) => string | null } | undefined;
    const contentLength = headers?.get?.("content-length");
    if (contentLength && maxBytes !== undefined) {
      const declaredBytes = Number(contentLength);
      if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
        throw new Error(`Download too large: ${declaredBytes} bytes exceeds limit ${maxBytes}`);
      }
    }

    if (!resp.body) {
      const buffer = Buffer.from(await resp.arrayBuffer());
      if (maxBytes !== undefined && buffer.byteLength > maxBytes) {
        throw new Error(`Download too large: ${buffer.byteLength} bytes exceeds limit ${maxBytes}`);
      }
      await writeFile(destPath, buffer, { mode: 0o600 });
      return;
    }

    const file = await open(destPath, "w", 0o600);
    let written = 0;
    try {
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        written += value.byteLength;
        if (maxBytes !== undefined && written > maxBytes) {
          throw new Error(`Download too large: ${written} bytes exceeds limit ${maxBytes}`);
        }
        await file.write(value);
      }
    } finally {
      await file.close();
    }
  } catch (err) {
    await cleanupTempFile(destPath);
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Download timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
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
    throw err;
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
    const { stdout } = await execFileAsync(WHISPER_BIN, [
      "-m", WHISPER_MODEL,
      "-f", wavPath,
      "--no-timestamps",
      "--no-prints",
      "--language", process.env.WHISPER_LANGUAGE ?? "auto",
    ], { timeout: 120_000 });
    return stdout.trim();
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
