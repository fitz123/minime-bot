import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import type { MessageQueue } from "./message-queue.js";
import { log } from "./logger.js";
import { createTelegramApiAdapter, type TelegramAdapterApi } from "./telegram-adapter.js";
import { resolveBinding } from "./telegram-binding.js";
import { sessionKey } from "./telegram-bot.js";
import type {
  SessionDefaults,
  TelegramBinding,
  TriggerInputConfig,
} from "./types.js";

export const TRIGGER_INPUT_MAX_BODY_BYTES = 16 * 1024;
export const TRIGGER_INPUT_MAX_TEXT_UTF16_UNITS = 4096;
export const TRIGGER_INPUT_READ_DEADLINE_MS = 5_000;

type TriggerStatus = 202 | 400 | 401 | 404 | 405 | 413 | 415 | 429;

const STATUS_WORDS: Record<TriggerStatus, string> = {
  202: "accepted",
  400: "malformed",
  401: "unauthorized",
  404: "not-found",
  405: "method-not-allowed",
  413: "too-large",
  415: "unsupported-media-type",
  429: "saturated",
};

const SOURCE_SLUG = /^[a-z0-9-]{1,32}$/;

class TriggerBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super(STATUS_WORDS[status]);
  }
}

export class TriggerInputBindError extends Error {
  constructor() {
    super("Trigger input address is in use");
    this.name = "TriggerInputBindError";
  }
}

export interface StartTriggerInputOptions {
  config: TriggerInputConfig;
  bindings: TelegramBinding[];
  sessionDefaults: SessionDefaults;
  api: TelegramAdapterApi;
  messageQueue: Pick<MessageQueue, "enqueue">;
}

export interface TriggerInputServer {
  readonly server: Server;
  readonly address: AddressInfo;
  stop(): Promise<void>;
}

function sendStatus(response: ServerResponse, status: TriggerStatus): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(STATUS_WORDS[status]);
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";
  const candidate = header?.startsWith(prefix) ? header.slice(prefix.length) : "";
  const expectedDigest = createHash("sha256").update(expected).digest();
  const candidateDigest = createHash("sha256").update(candidate).digest();
  return timingSafeEqual(expectedDigest, candidateDigest);
}

function hasJsonContentType(header: string | undefined): boolean {
  return header?.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > TRIGGER_INPUT_MAX_BODY_BYTES) {
      request.resume();
      return Promise.reject(new TriggerBodyError(413));
    }
  }

  return new Promise<Buffer>((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(deadline);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("aborted", onAborted);
      request.off("error", onError);
    };
    const reject = (error: TriggerBodyError) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      request.off("data", onData);
      request.off("aborted", onAborted);
      request.resume();
      rejectPromise(error);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > TRIGGER_INPUT_MAX_BODY_BYTES) {
        reject(new TriggerBodyError(413));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      if (settled) {
        request.off("error", onError);
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(Buffer.concat(chunks, byteLength));
    };
    const onAborted = () => reject(new TriggerBodyError(400));
    const onError = () => reject(new TriggerBodyError(400));
    const deadline = setTimeout(
      () => reject(new TriggerBodyError(400)),
      TRIGGER_INPUT_READ_DEADLINE_MS,
    );
    deadline.unref();

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("aborted", onAborted);
    request.once("error", onError);
  });
}

function parsePayload(body: Buffer): { source: string; text: string } | undefined {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(decoded) as unknown;
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (
    keys.length !== 2
    || !Object.hasOwn(payload, "source")
    || !Object.hasOwn(payload, "text")
    || typeof payload.source !== "string"
    || !SOURCE_SLUG.test(payload.source)
    || typeof payload.text !== "string"
    || payload.text.length === 0
    || payload.text.length > TRIGGER_INPUT_MAX_TEXT_UTF16_UNITS
  ) {
    return undefined;
  }
  return { source: payload.source, text: payload.text };
}

export function frameTriggerText(source: string, text: string, now = new Date()): string {
  const hour = now.getHours().toString().padStart(2, "0");
  const minute = now.getMinutes().toString().padStart(2, "0");
  return `[Automatic trigger | source: ${source} | ${hour}:${minute}]\n\n${text}`;
}

function createHandler(options: StartTriggerInputOptions) {
  const { config } = options;
  const binding = resolveBinding(config.chatId, options.bindings, config.threadId);
  if (!binding) {
    throw new Error("Trigger input binding is unavailable after config validation");
  }
  const platform = createTelegramApiAdapter({
    api: options.api,
    chatId: config.chatId,
    binding,
    threadId: config.threadId,
    sessionDefaults: options.sessionDefaults,
  });
  const key = sessionKey(config.chatId, config.threadId);

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url !== config.path) {
      sendStatus(response, 404);
      return;
    }
    if (request.method !== "POST") {
      sendStatus(response, 405);
      return;
    }
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization
      : undefined;
    if (!bearerMatches(authorization, config.bearer)) {
      sendStatus(response, 401);
      return;
    }
    const contentType = typeof request.headers["content-type"] === "string"
      ? request.headers["content-type"]
      : undefined;
    if (!hasJsonContentType(contentType)) {
      sendStatus(response, 415);
      return;
    }

    let body: Buffer;
    try {
      body = await readBody(request);
    } catch (error) {
      sendStatus(response, error instanceof TriggerBodyError ? error.status : 400);
      return;
    }
    const payload = parsePayload(body);
    if (!payload) {
      sendStatus(response, 400);
      return;
    }

    const accepted = options.messageQueue.enqueue(
      key,
      binding.agentId,
      frameTriggerText(payload.source, payload.text),
      platform,
    );
    sendStatus(response, accepted ? 202 : 429);
  };
}

export async function startTriggerInput(
  options: StartTriggerInputOptions,
): Promise<TriggerInputServer> {
  const handler = createHandler(options);
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => sendStatus(response, 400));
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const onListening = () => {
      server.off("error", onBindError);
      server.on("error", () => log.error("trigger-input", "Trigger input server error"));
      resolvePromise();
    };
    const onBindError = (error: Error) => {
      server.off("listening", onListening);
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
        rejectPromise(new TriggerInputBindError());
        return;
      }
      rejectPromise(error);
    };
    server.once("listening", onListening);
    server.once("error", onBindError);
    server.listen(options.config.port, options.config.host);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    throw new Error("Trigger input did not expose a TCP address");
  }
  log.info("trigger-input", "Trigger input listening");

  return {
    server,
    address,
    stop: () => new Promise<void>((resolvePromise) => {
      if (!server.listening) {
        resolvePromise();
        return;
      }
      server.close((error) => {
        if (error) log.error("trigger-input", "Failed to stop trigger input");
        resolvePromise();
      });
    }),
  };
}
