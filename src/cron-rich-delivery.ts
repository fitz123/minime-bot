import { createTelegramApiAdapter, type TelegramAdapterApi } from "./telegram-adapter.js";
import { prepareRichAnswer } from "./telegram-rich.js";
import { writeResultEcho } from "./result-echo.js";
import { sanitizePiProcessOutput } from "./pi-process-utils.js";

/** Replaying the same source cannot fix a cron result preflight rejection. */
export class CronResultPreparationError extends Error {
  override name = "CronResultPreparationError";
}

function sanitizeDescription(description: string): string {
  return sanitizePiProcessOutput(description)
    .replace(/https?:\/\/\S+/gi, "[URL redacted]")
    .replace(/\s+/g, " ").slice(0, 400);
}

/** Cron owns retries. No ordinary-message fallback or nested API retry layer. */
export async function deliverCronResult(
  api: TelegramAdapterApi,
  chatId: number,
  source: string,
  threadId?: number,
): Promise<void> {
  // Cron print-mode has no session outbox. Preflight rejects local photo
  // references without reserving or consuming ambient session files.
  let prepared: ReturnType<typeof prepareRichAnswer>;
  try {
    prepared = prepareRichAnswer(source);
  } catch (err) {
    // Without an outbox, preparation only renders and validates this payload.
    const detail = err instanceof Error ? sanitizeDescription(err.message) : "invalid rich result";
    throw new CronResultPreparationError(`Rich cron result preparation failed: ${detail}`);
  }
  const platform = createTelegramApiAdapter({ api, chatId, threadId });
  for (const [index, chunk] of prepared.chunks.entries()) {
    try {
      await platform.sendMessage(chunk.text, chunk.options);
    } catch (err) {
      // Preserve API evidence for cron's existing terminal/transient policy.
      // Never copy HttpError messages or causes: transport URLs may hold tokens.
      const native = err as { error_code?: unknown; description?: unknown } | null;
      const code = typeof native?.error_code === "number" ? native.error_code : undefined;
      const description = code !== undefined && typeof native?.description === "string"
        ? sanitizeDescription(native.description) : undefined;
      throw Object.assign(new Error(`Rich cron result delivery failed at chunk ${index + 1}${code !== undefined ? ` (Telegram ${code})` : ""}${description ? `: ${description}` : ""}`), {
        error_code: code, description,
      });
    }
    prepared.confirm(index);
    writeResultEcho(chatId, threadId, chunk.options.indexText ?? chunk.text);
  }
}
