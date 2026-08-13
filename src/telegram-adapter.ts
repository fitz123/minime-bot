import { type Context, InputFile } from "grammy";
import type { DraftSendResult, PlatformContext, SessionDefaults, TelegramBinding } from "./types.js";
import { markdownToHtml } from "./markdown-html.js";
import { setThread } from "./message-thread-cache.js";
import { recordMessage } from "./message-content-index.js";

export type TelegramAdapterApi = Pick<
  Context["api"],
  | "sendMessage"
  | "sendMessageDraft"
  | "deleteMessage"
  | "sendChatAction"
  | "sendPhoto"
  | "sendDocument"
>;

export interface TelegramApiAdapterOptions {
  api: TelegramAdapterApi;
  chatId: number | undefined;
  binding?: TelegramBinding;
  threadId?: number;
  sessionDefaults?: SessionDefaults;
}

/** Telegram platform constants. */
const TELEGRAM_MAX_MSG_LENGTH = 4096;
const TELEGRAM_TYPING_INTERVAL_MS = 5000;
const MAX_DRAFT_RETRY_AFTER_MS = 60_000;

function shouldFallbackToPlainText(err: unknown): boolean {
  return err instanceof Error && /can't parse entities|message is too long/.test(err.message);
}

/** Convert Telegram's structured 429 response into bounded scheduler feedback. */
function draftFailureResult(err: unknown): DraftSendResult {
  if (typeof err !== "object" || err === null) return { status: "failed" };
  const apiError = err as {
    error_code?: unknown;
    parameters?: { retry_after?: unknown };
  };
  if (apiError.error_code !== 429) return { status: "failed" };

  const retryAfter = apiError.parameters?.retry_after;
  const retryAfterMs = typeof retryAfter === "number" && Number.isFinite(retryAfter)
    ? Math.min(MAX_DRAFT_RETRY_AFTER_MS, Math.max(0, retryAfter * 1000))
    : 1000;
  return { status: "rate_limited", retryAfterMs };
}

/** Bot username for outgoing message recording. Set at startup via setBotUsername(). */
let _botUsername = "bot";

/** Set the bot's username for outgoing message index recording. */
export function setBotUsername(username: string): void {
  _botUsername = username;
}

/** Build a platform context directly over the Telegram Bot API. */
export function createTelegramApiAdapter({
  api,
  chatId,
  binding,
  threadId,
}: TelegramApiAdapterOptions): PlatformContext {
  const threadOpts = threadId != null ? { message_thread_id: threadId } : {};
  const isDm = binding?.kind === "dm";

  return {
    maxMessageLength: TELEGRAM_MAX_MSG_LENGTH,
    typingIntervalMs: TELEGRAM_TYPING_INTERVAL_MS,
    typingIndicator: binding?.typingIndicator !== false,

    async sendMessage(text: string): Promise<string> {
      if (chatId == null) return "";
      const html = markdownToHtml(text);
      try {
        const sent = await api.sendMessage(chatId, html, { ...threadOpts, parse_mode: "HTML" });
        if (threadId != null) setThread(chatId, sent.message_id, threadId);
        recordMessage(chatId, sent.message_id, `@${_botUsername}`, text, "out");
        return String(sent.message_id);
      } catch (err) {
        // Only fall back to plain text for HTML parse errors; re-throw everything else
        if (shouldFallbackToPlainText(err)) {
          const sent = await api.sendMessage(chatId, text, { ...threadOpts });
          if (threadId != null) setThread(chatId, sent.message_id, threadId);
          recordMessage(chatId, sent.message_id, `@${_botUsername}`, text, "out");
          return String(sent.message_id);
        }
        throw err;
      }
    },

    async sendDraft(draftId: number, text: string, signal?: AbortSignal): Promise<DraftSendResult> {
      if (!chatId || !isDm) return { status: "unsupported" };
      const html = markdownToHtml(text);
      try {
        await api.sendMessageDraft(chatId, draftId, html, {
          parse_mode: "HTML",
          ...threadOpts,
        }, signal as Parameters<TelegramAdapterApi["sendMessageDraft"]>[4]);
        return { status: "sent" };
      } catch (err) {
        if (shouldFallbackToPlainText(err)) {
          try {
            await api.sendMessageDraft(chatId, draftId, text, {
              ...threadOpts,
            }, signal as Parameters<TelegramAdapterApi["sendMessageDraft"]>[4]);
            return { status: "sent" };
          } catch (fallbackErr) {
            return draftFailureResult(fallbackErr);
          }
        }
        return draftFailureResult(err);
      }
    },

    async deleteMessage(messageId: string): Promise<void> {
      if (!chatId) return;
      await api.deleteMessage(chatId, Number(messageId));
    },

    async sendTyping(): Promise<void> {
      if (!chatId) return;
      await api.sendChatAction(
        chatId,
        "typing",
        threadId != null ? { message_thread_id: threadId } : undefined,
      );
    },

    async sendFile(filePath: string, isImage: boolean): Promise<void> {
      if (chatId == null) return;
      const sent = isImage
        ? await api.sendPhoto(chatId, new InputFile(filePath), threadOpts)
        : await api.sendDocument(chatId, new InputFile(filePath), threadOpts);
      if (threadId != null) setThread(chatId, sent.message_id, threadId);
      recordMessage(chatId, sent.message_id, `@${_botUsername}`, isImage ? "[photo]" : "[file]", "out");
    },

    async replyError(text: string): Promise<void> {
      if (chatId == null) return;
      const sent = await api.sendMessage(chatId, text, { ...threadOpts });
      if (threadId != null) setThread(chatId, sent.message_id, threadId);
      recordMessage(chatId, sent.message_id, `@${_botUsername}`, text, "out");
    },
  };
}

/**
 * Wraps a grammy Context into a platform-agnostic PlatformContext.
 * Handles Telegram-specific message threading (message_thread_id) and
 * maps message IDs to strings for the generic interface.
 */
export function createTelegramAdapter(
  ctx: Context,
  binding?: TelegramBinding,
  threadIdOverride?: number,
  sessionDefaults?: SessionDefaults,
): PlatformContext {
  const contextApi: TelegramAdapterApi = {
    sendMessage: (_chatId, text, other, signal) => ctx.reply(text, other, signal),
    sendMessageDraft: (chatId, draftId, text, other, signal) => (
      ctx.api.sendMessageDraft(chatId, draftId, text, other, signal)
    ),
    deleteMessage: (chatId, messageId, signal) => (
      ctx.api.deleteMessage(chatId, messageId, signal)
    ),
    sendChatAction: (chatId, action, other, signal) => (
      ctx.api.sendChatAction(chatId, action, other, signal)
    ),
    sendPhoto: (_chatId, photo, other, signal) => ctx.replyWithPhoto(photo, other, signal),
    sendDocument: (_chatId, document, other, signal) => (
      ctx.replyWithDocument(document, other, signal)
    ),
  };
  return createTelegramApiAdapter({
    api: contextApi,
    chatId: ctx.chat?.id,
    binding,
    threadId: threadIdOverride ?? ctx.message?.message_thread_id,
    sessionDefaults,
  });
}
