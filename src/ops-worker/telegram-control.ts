import { timingSafeEqual } from "node:crypto";
import type { OpsWorkerControlConfig } from "./control-config.js";
import {
  hashOpsWorkerTelegramUpdate,
  type OpsWorkerControlLedger,
} from "./control-ledger.js";
import type { OpsWorkerPolicySnapshot } from "./status-server.js";
import {
  buildOpsWorkerConversationSnapshot,
  buildOpsWorkerTaskView,
  renderOpsWorkerStatusNarrative,
  renderOpsWorkerTaskNarrative,
  renderOpsWorkerTasksNarrative,
} from "./conversation-view.js";
import {
  buildOpsWorkerTelegramReport,
  createOpsWorkerFieldRedactor,
  type OpsWorkerFieldRedactor,
} from "./reporting.js";
import {
  isOpsWorkerReportReconciliationBlocked,
  isOpsWorkerUnresolvedOrphan,
  OpsWorkerSupervisorStateError,
  type OpsWorkerSupervisor,
} from "./supervisor.js";
import { OpsWorkerSteeringCapacityError } from "./task-store.js";
import {
  OPS_WORKER_LIMITS,
  isOpsWorkerTaskId,
  type OpsWorkerSteeringEntry,
  type OpsWorkerSteeringKind,
  type OpsWorkerTask,
} from "./types.js";
import {
  ingestLocalAudio,
  type LocalAudioIngestionOptions,
} from "../voice.js";
import {
  OPS_WORKER_CONVERSATION_FALLBACK_MESSAGE,
  OPS_WORKER_CONVERSATION_RUNNER_LIMITS,
  type OpsWorkerConversationControlIntent,
  type OpsWorkerConversationControlProposal,
  type OpsWorkerConversationTurnOptions,
  type OpsWorkerConversationTurnResult,
  type OpsWorkerPreviousClarification,
} from "./conversation-runner.js";
import { OpsWorkerConversationLane } from "./conversation-lane.js";

const MAX_UPDATES_PER_POLL = 100;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_TELEGRAM_MESSAGE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const TRUNCATION_MARKER = "\n… [truncated]";
const TELEGRAM_FILE_ID_MAX_BYTES = 512;
const TELEGRAM_FILE_PATH_MAX_BYTES = 1_024;
const TELEGRAM_FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const TELEGRAM_FILE_PATH_PATTERN = /^[A-Za-z0-9_./-]+$/;
const CONVERSATION_CLARIFICATION_TTL_MS = 5 * 60 * 1_000;
const MAX_CONVERSATION_CLARIFICATION_CANDIDATES = 16;
const MAX_PENDING_REPLIES = MAX_UPDATES_PER_POLL + 1;

export const OPS_WORKER_TELEGRAM_VOICE_LIMITS = Object.freeze({
  maxBytes: 20 * 1024 * 1024,
  maxDurationSeconds: 10 * 60,
  downloadTimeoutMs: 30_000,
});

export const OPS_WORKER_CONVERSATION_UNAVAILABLE_MESSAGE =
  OPS_WORKER_CONVERSATION_FALLBACK_MESSAGE;

export const OPS_WORKER_VOICE_TRANSCRIPTION_FALLBACK =
  "Could not transcribe the voice message locally. Send text, or use /status, /tasks, or /task <id>.";

export type OpsWorkerTelegramFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpsWorkerConversationInput {
  updateId: number;
  senderId: string;
  chatId: string;
  receivedAt: string;
}

export type OpsWorkerConversationHandler = (
  text: string,
  input: OpsWorkerConversationInput,
  options?: OpsWorkerConversationTurnOptions,
) =>
  | string
  | OpsWorkerConversationTurnResult
  | Promise<string | OpsWorkerConversationTurnResult>;

export type OpsWorkerVoiceIngestor = (
  url: string,
  options: LocalAudioIngestionOptions,
) => Promise<string>;

export type OpsWorkerTelegramControlFaultPoint =
  | "after-effect-before-ledger"
  | "after-ledger-before-reply"
  | "after-report-send-before-receipt-finish";

export interface OpsWorkerTelegramControlOptions {
  config: OpsWorkerControlConfig;
  supervisor: OpsWorkerSupervisor;
  ledger: OpsWorkerControlLedger;
  fetch?: OpsWorkerTelegramFetch;
  inspectPolicy: () => OpsWorkerPolicySnapshot;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  handleConversation?: OpsWorkerConversationHandler;
  conversationLane?: OpsWorkerConversationLane;
  ingestVoice?: OpsWorkerVoiceIngestor;
  sensitiveValues?: readonly string[];
  /** Test-only durable-boundary hook. Production callers should leave this unset. */
  faultInjector?: (
    point: OpsWorkerTelegramControlFaultPoint,
    updateId: number,
  ) => void;
}

export interface OpsWorkerTelegramTickResult {
  updates: number;
  reportTaskId: string | null;
}

interface ParsedTelegramMessageBase {
  updateId: number;
  fingerprint: string;
  senderId: string;
  chatId: string;
  receivedAt: string;
}

interface ParsedTelegramTextMessage extends ParsedTelegramMessageBase {
  kind: "text";
  text: string;
}

interface ParsedTelegramVoiceMessage extends ParsedTelegramMessageBase {
  kind: "voice";
  fileId: string;
}

type ParsedTelegramMessage =
  | ParsedTelegramTextMessage
  | ParsedTelegramVoiceMessage;

interface OpsWorkerControlOperation {
  command: OpsWorkerConversationControlIntent;
  taskId: string;
  argument: string | null;
}

interface OpsWorkerClarificationSlot {
  expiresAt: number;
  previous: OpsWorkerPreviousClarification;
  control:
    | {
        intent: OpsWorkerConversationControlIntent;
        argument: string | null;
        candidateIds: readonly string[];
        confirmationToken: string | null;
        language: OpsWorkerConversationControlProposal["language"];
      }
    | null;
}

interface OpsWorkerPendingReply {
  sequence: number;
  text: string;
}

export class OpsWorkerTelegramTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsWorkerTelegramTransportError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) as string;
}

function fingerprintsEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const contentLimit = Math.max(0, maxBytes - markerBytes);
  let result = "";
  for (const character of value) {
    if (Buffer.byteLength(result + character, "utf8") > contentLimit) break;
    result += character;
  }
  return `${result}${TRUNCATION_MARKER}`;
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (chunkBytes + characterBytes > maxBytes) {
      chunks.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  chunks.push(chunk);
  return chunks;
}

function safeError(error: unknown): string {
  if (error instanceof OpsWorkerTelegramTransportError) return error.message;
  return error instanceof Error ? error.name : "unknown transport error";
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolveSleep();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function numberId(value: unknown): string | null {
  return Number.isSafeInteger(value) ? String(value) : null;
}

function boundedTelegramFileId(value: unknown): string | null {
  return typeof value === "string"
    && value !== ""
    && Buffer.byteLength(value, "utf8") <= TELEGRAM_FILE_ID_MAX_BYTES
    && TELEGRAM_FILE_ID_PATTERN.test(value)
    ? value
    : null;
}

function parseVoice(
  voice: Record<string, unknown>,
): { fileId: string } | null {
  const fileId = boundedTelegramFileId(voice.file_id);
  const uniqueId = boundedTelegramFileId(voice.file_unique_id);
  if (fileId === null || uniqueId === null) return null;
  if (
    !Number.isSafeInteger(voice.duration)
    || (voice.duration as number) < 0
    || (voice.duration as number) > OPS_WORKER_TELEGRAM_VOICE_LIMITS.maxDurationSeconds
  ) return null;
  if (
    voice.file_size !== undefined
    && (
      !Number.isSafeInteger(voice.file_size)
      || (voice.file_size as number) < 0
      || (voice.file_size as number) > OPS_WORKER_TELEGRAM_VOICE_LIMITS.maxBytes
    )
  ) return null;
  if (voice.mime_type !== undefined && voice.mime_type !== "audio/ogg") return null;
  return { fileId };
}

function parseMessage(
  update: Record<string, unknown>,
  fingerprint: string,
  trustedNow: Date,
): ParsedTelegramMessage | null {
  const updateId = update.update_id;
  if (!Number.isSafeInteger(updateId) || (updateId as number) < 0) return null;
  if (!isPlainObject(update.message)) return null;
  const message = update.message;
  if (!isPlainObject(message.from) || !isPlainObject(message.chat)) return null;
  const senderId = numberId(message.from.id);
  const chatId = numberId(message.chat.id);
  if (senderId === null || chatId === null) return null;
  if (message.from.is_bot === true) return null;
  if (
    !Number.isSafeInteger(message.date)
    || (message.date as number) < 0
    || (message.date as number) > 8_640_000_000
  ) return null;
  const trustedNowMs = trustedNow.getTime();
  if (!Number.isFinite(trustedNowMs)) {
    throw new TypeError("Telegram control clock returned an invalid date");
  }
  const messageDateMs = (message.date as number) * 1_000;
  if (messageDateMs > trustedNowMs + MAX_TELEGRAM_MESSAGE_FUTURE_SKEW_MS) {
    return null;
  }
  const parsedBase: ParsedTelegramMessageBase = {
    updateId: updateId as number,
    fingerprint,
    senderId,
    chatId,
    receivedAt: new Date(messageDateMs).toISOString(),
  };
  const hasText = message.text !== undefined;
  const hasVoice = message.voice !== undefined;
  if (hasText === hasVoice) return null;
  if (hasText) {
    if (
      typeof message.text !== "string"
      || message.text.trim() === ""
      || message.text.includes("\0")
      || Buffer.byteLength(message.text, "utf8") > MAX_COMMAND_BYTES
    ) return null;
    return { ...parsedBase, kind: "text", text: message.text };
  }
  if (!isPlainObject(message.voice)) return null;
  const voice = parseVoice(message.voice);
  return voice === null
    ? null
    : { ...parsedBase, kind: "voice", fileId: voice.fileId };
}

function parseGetFilePath(value: unknown): string {
  if (!isPlainObject(value) || !isPlainObject(value.result)) {
    throw new OpsWorkerTelegramTransportError("Telegram getFile returned an invalid envelope");
  }
  const filePath = value.result.file_path;
  if (
    typeof filePath !== "string"
    || filePath === ""
    || Buffer.byteLength(filePath, "utf8") > TELEGRAM_FILE_PATH_MAX_BYTES
    || !TELEGRAM_FILE_PATH_PATTERN.test(filePath)
    || filePath.startsWith("/")
    || filePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new OpsWorkerTelegramTransportError("Telegram getFile returned an invalid file path");
  }
  const fileSize = value.result.file_size;
  if (
    fileSize !== undefined
    && (
      !Number.isSafeInteger(fileSize)
      || (fileSize as number) < 0
      || (fileSize as number) > OPS_WORKER_TELEGRAM_VOICE_LIMITS.maxBytes
    )
  ) {
    throw new OpsWorkerTelegramTransportError("Telegram getFile returned an invalid file size");
  }
  return filePath;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) {
    throw new OpsWorkerTelegramTransportError("Telegram returned an empty response body");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new OpsWorkerTelegramTransportError(
        `Telegram response exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(part.value);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new OpsWorkerTelegramTransportError("Telegram returned malformed JSON");
  }
  return parsed;
}

function parseGetUpdatesResult(value: unknown, offset: number | undefined): Record<string, unknown>[] {
  if (!isPlainObject(value) || value.ok !== true || !Array.isArray(value.result)) {
    throw new OpsWorkerTelegramTransportError("Telegram getUpdates returned an invalid envelope");
  }
  if (value.result.length > MAX_UPDATES_PER_POLL) {
    throw new OpsWorkerTelegramTransportError(
      `Telegram getUpdates returned more than ${MAX_UPDATES_PER_POLL} updates`,
    );
  }
  let previous: number | undefined;
  return value.result.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new OpsWorkerTelegramTransportError(`Telegram update ${index} is not an object`);
    }
    const updateId = entry.update_id;
    if (!Number.isSafeInteger(updateId) || (updateId as number) < 0) {
      throw new OpsWorkerTelegramTransportError(`Telegram update ${index} has an invalid update_id`);
    }
    if (
      (index === 0 && offset !== undefined && (updateId as number) < offset - 1)
      || (previous !== undefined && (updateId as number) <= previous)
    ) {
      throw new OpsWorkerTelegramTransportError("Telegram updates are not strictly ordered");
    }
    previous = updateId as number;
    return entry;
  });
}

function taskSummaryPage(
  task: OpsWorkerTask,
  page: number,
  maxBytes: number,
  redact: OpsWorkerFieldRedactor,
): string {
  const summary = renderOpsWorkerTaskNarrative(
    buildOpsWorkerTaskView(task, redact),
  );
  if (Buffer.byteLength(summary, "utf8") <= maxBytes) {
    return page === 1
      ? summary
      : `Task ${task.id} has 1 page; request /task ${task.id}.`;
  }
  let pageCount = 2;
  let pages: string[];
  while (true) {
    const largestHeader = `Task ${task.id} page ${pageCount}/${pageCount}\n`;
    const contentBytes = maxBytes - Buffer.byteLength(largestHeader, "utf8");
    if (contentBytes < 4) {
      throw new TypeError("Telegram reply limit cannot fit a task page header");
    }
    pages = splitUtf8(summary, contentBytes);
    if (pages.length === pageCount) break;
    pageCount = pages.length;
  }
  if (page > pages.length) {
    return `Task ${task.id} has ${pages.length} pages; request /task ${task.id} <page>.`;
  }
  return `Task ${task.id} page ${page}/${pages.length}\n${pages[page - 1]}`;
}

function usage(): string {
  return "Usage: /status | /tasks | /task <id> [page] | /answer <id> <text> | /correct <id> <text> | /pause <id> | /resume <id> | /cancel <id> <reason> | /retry <id>";
}

function taskArgument(value: string | undefined): string | null {
  const taskId = value?.trim();
  return isOpsWorkerTaskId(taskId) ? taskId : null;
}

function taskPageArgument(
  value: string | undefined,
): { taskId: string; page: number } | null {
  const match = /^(\S+)(?:\s+([1-9]\d*))?$/.exec(value?.trim() ?? "");
  const taskId = taskArgument(match?.[1]);
  const page = match?.[2] === undefined ? 1 : Number(match[2]);
  return taskId !== null && Number.isSafeInteger(page)
    ? { taskId, page }
    : null;
}

export class OpsWorkerTelegramControl {
  private readonly config: OpsWorkerControlConfig;
  private readonly supervisor: OpsWorkerSupervisor;
  private readonly ledger: OpsWorkerControlLedger;
  private readonly fetch: OpsWorkerTelegramFetch;
  private readonly inspectPolicy: () => OpsWorkerPolicySnapshot;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly handleConversation: OpsWorkerConversationHandler;
  private readonly conversationLane: OpsWorkerConversationLane;
  private readonly ingestVoice: OpsWorkerVoiceIngestor;
  private readonly redactAgentField: OpsWorkerFieldRedactor;
  private readonly pendingReplies: OpsWorkerPendingReply[] = [];
  private replyDelivery: Promise<void> | null = null;
  private nextReplySequence = 1;
  private readonly conversationDeliveries = new Set<Promise<void>>();
  private clarification: OpsWorkerClarificationSlot | null = null;
  private readonly faultInjector:
    | ((point: OpsWorkerTelegramControlFaultPoint, updateId: number) => void)
    | undefined;

  constructor(options: OpsWorkerTelegramControlOptions) {
    if (typeof options.inspectPolicy !== "function") {
      throw new TypeError("Telegram control requires a policy inspector");
    }
    this.config = options.config;
    this.supervisor = options.supervisor;
    this.ledger = options.ledger;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.inspectPolicy = options.inspectPolicy;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? defaultSleep;
    this.handleConversation = options.handleConversation
      ?? (() => OPS_WORKER_CONVERSATION_UNAVAILABLE_MESSAGE);
    this.conversationLane = options.conversationLane
      ?? new OpsWorkerConversationLane({
        blocksAdmission: () => this.supervisor.blocksConversationAdmission(),
        abortConversation: async () => true,
      });
    this.ingestVoice = options.ingestVoice ?? ingestLocalAudio;
    this.redactAgentField = createOpsWorkerFieldRedactor([
      options.config.telegram.token,
      options.config.intake?.bearerToken ?? "",
      ...(options.sensitiveValues ?? []),
    ]);
    this.faultInjector = options.faultInjector;
  }

  async tick(signal: AbortSignal = new AbortController().signal): Promise<OpsWorkerTelegramTickResult> {
    await this.flushPendingReply(signal);
    const reportTaskId = await this.deliverOnePendingReport(signal);
    const cursor = this.ledger.pollCursor(this.now());
    const offset = cursor.offset;
    const value = await this.telegramApi("getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      timeout: this.config.poll.longPollSeconds,
      limit: MAX_UPDATES_PER_POLL,
      allowed_updates: ["message"],
    }, signal);
    const updates = parseGetUpdatesResult(value, offset);
    for (const update of updates) {
      await this.processUpdate(update, signal, cursor.epoch);
    }
    return { updates: updates.length, reportTaskId };
  }

  async waitForConversation(): Promise<void> {
    while (this.conversationDeliveries.size > 0) {
      await Promise.all([...this.conversationDeliveries]);
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let backoff = this.config.poll.retryMinMs;
    try {
      while (!signal.aborted) {
        try {
          await this.tick(signal);
          backoff = this.config.poll.retryMinMs;
        } catch (error) {
          if (signal.aborted) return;
          if (!(error instanceof OpsWorkerTelegramTransportError)) throw error;
          await this.sleep(backoff, signal);
          backoff = Math.min(this.config.poll.retryMaxMs, backoff * 2);
        }
      }
    } finally {
      await this.conversationLane.close();
    }
  }

  private async telegramApi(
    method: "getUpdates" | "getFile" | "sendMessage",
    payload: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const requestController = new AbortController();
    const abortFromParent = (): void => requestController.abort();
    if (signal.aborted) requestController.abort();
    else signal.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(
      () => requestController.abort(),
      this.config.poll.requestTimeoutMs,
    );
    let response: Response;
    let value: unknown;
    try {
      response = await this.fetch(
        `https://api.telegram.org/bot${this.config.telegram.token}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: requestController.signal,
        },
      );
      value = await readBoundedResponse(response, this.config.poll.maxResponseBytes);
    } catch (error) {
      if (error instanceof OpsWorkerTelegramTransportError) throw error;
      throw new OpsWorkerTelegramTransportError(`Telegram ${method} request failed`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abortFromParent);
    }
    if (!response.ok) {
      throw new OpsWorkerTelegramTransportError(
        `Telegram ${method} returned HTTP ${response.status}`,
      );
    }
    if (!isPlainObject(value) || value.ok !== true) {
      throw new OpsWorkerTelegramTransportError(`Telegram ${method} rejected the request`);
    }
    return value;
  }

  private async sendMessage(text: string, signal: AbortSignal): Promise<void> {
    await this.telegramApi("sendMessage", {
      chat_id: this.config.telegram.controlChatId,
      text: truncateUtf8(text, this.config.reply.maxBytes),
    }, signal);
  }

  private enqueueReply(text: string): void {
    if (this.pendingReplies.length >= MAX_PENDING_REPLIES) {
      throw new OpsWorkerTelegramTransportError(
        "Telegram reply outbox reached its fixed bound",
      );
    }
    this.pendingReplies.push({
      sequence: this.nextReplySequence,
      text,
    });
    this.nextReplySequence += 1;
  }

  private async flushPendingReply(signal: AbortSignal): Promise<void> {
    while (this.pendingReplies.length > 0) {
      const existing = this.replyDelivery;
      if (existing !== null) {
        await existing;
        continue;
      }
      const pending = this.pendingReplies[0];
      let delivery!: Promise<void>;
      delivery = this.sendMessage(pending.text, signal).finally(() => {
        if (this.replyDelivery === delivery) this.replyDelivery = null;
      });
      this.replyDelivery = delivery;
      await delivery;
      if (this.pendingReplies[0]?.sequence !== pending.sequence) {
        throw new Error("Telegram reply outbox order changed during delivery");
      }
      this.pendingReplies.shift();
    }
  }

  private async processUpdate(
    update: Record<string, unknown>,
    signal: AbortSignal,
    epoch: number,
  ): Promise<void> {
    const updateId = update.update_id as number;
    const fingerprint = hashOpsWorkerTelegramUpdate(stableJson(update));
    const retained = this.ledger.read().processedUpdates.find(
      (entry) => entry.epoch === epoch && entry.updateId === updateId,
    );
    if (retained) {
      if (!fingerprintsEqual(retained.fingerprint, fingerprint)) {
        this.ledger.record(updateId, fingerprint, {
          epoch,
          acknowledgedAt: this.now(),
        });
      }
      return;
    }
    const message = parseMessage(
      update,
      fingerprint,
      this.now(),
    );
    if (
      message === null
      || message.chatId !== this.config.telegram.controlChatId
      || !this.config.telegram.operatorIds.includes(message.senderId)
    ) {
      this.ledger.record(updateId, fingerprint, {
        epoch,
        acknowledgedAt: this.now(),
      });
      return;
    }
    const isConversation = message.kind === "voice"
      || !message.text.trimStart().startsWith("/");
    if (isConversation) {
      this.ledger.record(updateId, fingerprint, {
        epoch,
        acknowledgedAt: this.now(),
      });
      this.faultInjector?.("after-ledger-before-reply", updateId);
      const turn = this.conversationLane.tryStart(
        async (turnSignal) => this.dispatchConversationMessage(
          message,
          turnSignal,
        ),
      );
      if (turn === null) {
        this.enqueueReply(OPS_WORKER_CONVERSATION_UNAVAILABLE_MESSAGE);
        await this.flushPendingReply(signal);
        return;
      }
      let delivery!: Promise<void>;
      delivery = (async () => {
        let reply = OPS_WORKER_CONVERSATION_UNAVAILABLE_MESSAGE;
        try {
          reply = await turn;
        } catch {
          // The reply remains the deterministic provider-independent fallback.
        }
        this.enqueueReply(reply);
        await this.flushPendingReply(signal).catch(() => undefined);
      })().finally(() => {
        this.conversationDeliveries.delete(delivery);
      });
      this.conversationDeliveries.add(delivery);
      return;
    }

    if (message.kind !== "text") {
      throw new TypeError("Only text messages can reach slash-command dispatch");
    }
    let reply: string;
    try {
      reply = this.dispatchCommand(message);
    } catch (error) {
      if (!(error instanceof OpsWorkerSteeringCapacityError)) throw error;
      reply = "The task has no remaining steering capacity; the command was not recorded.";
    }
    this.faultInjector?.("after-effect-before-ledger", updateId);
    this.ledger.record(updateId, fingerprint, {
      epoch,
      acknowledgedAt: this.now(),
    });
    this.faultInjector?.("after-ledger-before-reply", updateId);
    this.enqueueReply(reply);
    await this.flushPendingReply(signal);
  }

  private async dispatchConversationMessage(
    message: ParsedTelegramMessage,
    turnSignal: AbortSignal,
  ): Promise<string> {
    if (message.kind === "text") {
      return this.conversationReply(message.text, message, turnSignal);
    }
    try {
      const value = await this.telegramApi("getFile", {
        file_id: message.fileId,
      }, turnSignal);
      const filePath = parseGetFilePath(value);
      const transcript = await this.ingestVoice(
        `https://api.telegram.org/file/bot${this.config.telegram.token}/${filePath}`,
        {
          maxBytes: OPS_WORKER_TELEGRAM_VOICE_LIMITS.maxBytes,
          downloadTimeoutMs: OPS_WORKER_TELEGRAM_VOICE_LIMITS.downloadTimeoutMs,
          signal: turnSignal,
        },
      );
      if (
        typeof transcript !== "string"
        || transcript.trim() === ""
        || transcript.includes("\0")
        || Buffer.byteLength(transcript, "utf8") > MAX_COMMAND_BYTES
      ) return OPS_WORKER_VOICE_TRANSCRIPTION_FALLBACK;
      return this.conversationReply(transcript, message, turnSignal);
    } catch {
      return turnSignal.aborted
        ? OPS_WORKER_CONVERSATION_UNAVAILABLE_MESSAGE
        : OPS_WORKER_VOICE_TRANSCRIPTION_FALLBACK;
    }
  }

  private async conversationReply(
    text: string,
    message: ParsedTelegramMessageBase,
    signal: AbortSignal,
  ): Promise<string> {
    const clarification = this.takeClarification();
    if (clarification !== null && clarification.control !== null) {
      return this.resolveControlClarification(text, message, clarification);
    }
    try {
      const reply = await this.handleConversation(text, {
        updateId: message.updateId,
        senderId: message.senderId,
        chatId: message.chatId,
        receivedAt: message.receivedAt,
      }, {
        signal,
        ...(clarification === null
          ? {}
          : { previousClarification: clarification.previous }),
      });
      if (typeof reply === "string") {
        return reply.trim() !== "" && !reply.includes("\0")
          ? reply
          : OPS_WORKER_CONVERSATION_UNAVAILABLE_MESSAGE;
      }
      if (reply.status === "FALLBACK") return reply.reply;
      if (reply.envelope.kind === "answer") return reply.envelope.text;
      if (reply.envelope.kind === "clarification") {
        this.storeClarification(text, reply.envelope.text, null);
        return reply.envelope.text;
      }
      return this.dispatchNaturalControl(
        reply.envelope,
        text,
      );
    } catch {
      return OPS_WORKER_CONVERSATION_UNAVAILABLE_MESSAGE;
    }
  }

  private dispatchCommand(message: ParsedTelegramTextMessage): string {
    const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(message.text.trim());
    if (!match) return usage();
    const command = match[1];
    const tail = match[2]?.trim();
    if (command === "status" && tail === undefined) {
      const tasks = this.supervisor.listTasks();
      return renderOpsWorkerStatusNarrative(
        buildOpsWorkerConversationSnapshot(tasks, this.inspectPolicy(), {
          redact: this.redactAgentField,
        }),
      );
    }
    if (command === "tasks" && tail === undefined) {
      const tasks = this.supervisor.listTasks();
      return renderOpsWorkerTasksNarrative(
        buildOpsWorkerConversationSnapshot(tasks, this.inspectPolicy(), {
          redact: this.redactAgentField,
        }),
      );
    }
    if (command === "task") {
      const argument = taskPageArgument(tail);
      if (argument === null) return usage();
      const task = this.supervisor.getTask(argument.taskId);
      return task
        ? taskSummaryPage(
            task,
            argument.page,
            this.config.reply.maxBytes,
            this.redactAgentField,
          )
        : `Unknown ops-worker task ${argument.taskId}.`;
    }
    if (command === "answer" || command === "correct") {
      const steering = /^(\S+)\s+([\s\S]+)$/.exec(tail ?? "");
      const taskId = taskArgument(steering?.[1]);
      const text = steering?.[2]?.trim();
      if (
        taskId === null
        || !text
        || Buffer.byteLength(text, "utf8") > OPS_WORKER_LIMITS.maxSteeringTextBytes
      ) return usage();
      return this.dispatchControlOperation({
        command,
        taskId,
        argument: text,
      }, message);
    }
    if (command === "pause" || command === "resume" || command === "retry") {
      const taskId = taskArgument(tail);
      if (taskId === null) return usage();
      return this.dispatchControlOperation({
        command,
        taskId,
        argument: null,
      }, message);
    }
    if (command === "cancel") {
      const cancellation = /^(\S+)\s+([\s\S]+)$/.exec(tail ?? "");
      const taskId = taskArgument(cancellation?.[1]);
      const reason = cancellation?.[2]?.trim();
      if (
        taskId === null
        || !reason
        || Buffer.byteLength(reason, "utf8") > OPS_WORKER_LIMITS.maxInterruptReasonBytes
      ) return usage();
      return this.dispatchControlOperation({
        command,
        taskId,
        argument: reason,
      }, message);
    }
    return usage();
  }

  private dispatchControlOperation(
    operation: OpsWorkerControlOperation,
    message: ParsedTelegramMessageBase,
  ): string {
    const { command, taskId, argument } = operation;
    const task = this.supervisor.getTask(taskId);
    if (!task) return `Unknown ops-worker task ${taskId}.`;
    const steeringId = this.steeringId(message);
    const replayed = task.steering.some((entry) => entry.steeringId === steeringId);

    if (command === "answer" || command === "correct") {
      if (
        argument === null
        || Buffer.byteLength(argument, "utf8") > OPS_WORKER_LIMITS.maxSteeringTextBytes
      ) return usage();
      if ((task.state === "DONE" || task.state === "CANCELLED")
        && !replayed) {
        return `Task ${taskId} is terminal; steering was not recorded.`;
      }
      if (!replayed && task.steering.length >= OPS_WORKER_LIMITS.maxSteeringEntries) {
        return `Task ${taskId} cannot record more steering.`;
      }
      this.supervisor.appendTaskSteering(taskId, {
        steeringId,
        receivedAt: message.receivedAt,
        kind: command === "answer" ? "answer" : "correction",
        operatorRef: `telegram:${message.senderId}`,
        text: argument,
        consumedAt: null,
      });
      return `Recorded ${command === "answer" ? "answer" : "correction"} for ${taskId}.`;
    }

    if (command === "pause" || command === "resume" || command === "retry") {
      if (argument !== null) return usage();
      if ((task.state === "DONE" || task.state === "CANCELLED") && !replayed) {
        return `Task ${taskId} is terminal; ${command} was not recorded.`;
      }
      if (command === "retry" && task.state !== "BLOCKED") {
        return replayed
          ? `Retry for ${taskId} was already applied; state=${task.state}.`
          : `Task ${taskId} cannot retry from ${task.state}.`;
      }
      if (command === "resume" && task.control.interrupt !== null && !replayed) {
        return `Task ${taskId} has a pending ${task.control.interrupt.mode} interrupt.`;
      }
      if (!replayed && task.steering.length >= OPS_WORKER_LIMITS.maxSteeringEntries) {
        return `Task ${taskId} cannot record more steering.`;
      }
      if (command === "retry") {
        let retried: OpsWorkerTask;
        try {
          retried = this.supervisor.retryBlockedTask(
            taskId,
            this.controlSteering(message, "resume", command),
          );
        } catch (error) {
          if (error instanceof OpsWorkerSupervisorStateError) {
            return `Retry for ${taskId} was rejected at its current safe boundary.`;
          }
          throw error;
        }
        return `Retried ${taskId}; state=${retried.state}.`;
      }
      const changed = this.supervisor.setTaskPaused(
        taskId,
        command === "pause",
        this.controlSteering(message, command === "pause" ? "pause" : "resume", command),
      );
      return `${command === "pause" ? "Paused" : "Resumed"} ${taskId}; state=${changed.state}.`;
    }

    if (command === "cancel") {
      if (
        argument === null
        || Buffer.byteLength(argument, "utf8") > OPS_WORKER_LIMITS.maxInterruptReasonBytes
      ) return usage();
      if (task.state === "CANCELLED" && replayed) return `Cancellation for ${taskId} was already applied.`;
      if (task.state === "DONE" || task.state === "CANCELLED") {
        return `Task ${taskId} is terminal; cancellation was not recorded.`;
      }
      if (
        task.control.interrupt !== null
        && (
          task.control.interrupt.mode !== "cancel"
          || task.control.interrupt.reason !== argument
        )
        && !replayed
      ) return `Task ${taskId} already has a different pending interrupt.`;
      if (!replayed && task.steering.length >= OPS_WORKER_LIMITS.maxSteeringEntries) {
        return `Task ${taskId} cannot record more steering.`;
      }
      const changed = this.supervisor.requestOperatorInterrupt(
        taskId,
        "cancel",
        argument,
        this.controlSteering(message, "cancel", argument),
      );
      return `Cancellation recorded for ${taskId}; state=${changed.state}.`;
    }
    return usage();
  }

  private dispatchNaturalControl(
    proposal: OpsWorkerConversationControlProposal,
    operatorText: string,
  ): string {
    const candidates = this.supervisor.listTasks()
      .filter((task) =>
        this.isNaturalControlCandidate(task, proposal.intent, proposal.argument))
      .sort((left, right) =>
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
        || left.id.localeCompare(right.id));
    if (candidates.length === 0) {
      return proposal.language === "ru"
        ? "Нет задачи, для которой эта операция сейчас допустима; изменений нет."
        : "No task is currently eligible for that operation; nothing changed.";
    }
    if (candidates.length > MAX_CONVERSATION_CLARIFICATION_CANDIDATES) {
      return proposal.language === "ru"
        ? "Подходящих задач слишком много для безопасного уточнения; изменений нет. Используйте /tasks."
        : "Too many tasks are eligible for a safe clarification; nothing changed. Use /tasks.";
    }

    const ids = candidates.map((task) => task.id);
    const confirmationToken = candidates.length === 1
      ? proposal.language === "ru" ? "ПОДТВЕРЖДАЮ" : "CONFIRM"
      : null;
    const operation = proposal.argument === null
      ? proposal.intent
      : `${proposal.intent} ${JSON.stringify(proposal.argument)}`;
    const question = confirmationToken !== null
      ? proposal.language === "ru"
        ? `Подтвердите ${operation} для ${ids[0]}. Ответьте ровно: ${confirmationToken}`
        : `Confirm ${operation} for ${ids[0]}. Reply exactly: ${confirmationToken}`
      : proposal.language === "ru"
        ? `Уточните задачу для ${operation}: ${ids.join(", ")}. Ответьте точным идентификатором.`
        : `Which task for ${operation}: ${ids.join(", ")}? Reply with the exact identifier.`;
    this.storeClarification(operatorText, question, {
      intent: proposal.intent,
      argument: proposal.argument,
      candidateIds: ids,
      confirmationToken,
      language: proposal.language,
    });
    return question;
  }

  private resolveControlClarification(
    operatorText: string,
    message: ParsedTelegramMessageBase,
    clarification: OpsWorkerClarificationSlot,
  ): string {
    const selection = clarification.control;
    if (selection === null) {
      return OPS_WORKER_CONVERSATION_UNAVAILABLE_MESSAGE;
    }
    const normalized = operatorText.trim();
    const selectedId = selection.confirmationToken === null
      ? selection.candidateIds.find((candidateId) => candidateId === normalized)
      : normalized === selection.confirmationToken
        ? selection.candidateIds[0]
        : undefined;
    if (selectedId !== undefined) {
      const selected = this.supervisor.getTask(selectedId);
      if (
        selected !== undefined
        && this.isNaturalControlCandidate(
          selected,
          selection.intent,
          selection.argument,
        )
      ) {
        return this.dispatchControlOperation({
          command: selection.intent,
          taskId: selectedId,
          argument: selection.argument,
        }, message);
      }
    }
    return selection.language === "ru"
      ? "Выбор или подтверждение не принято; изменений нет. Используйте /tasks и точную slash-команду."
      : "Selection or confirmation was not accepted; nothing changed. Use /tasks and an exact slash command.";
  }

  private isNaturalControlCandidate(
    task: OpsWorkerTask,
    intent: OpsWorkerConversationControlIntent,
    argument: string | null,
  ): boolean {
    if (task.state === "DONE" || task.state === "CANCELLED") return false;
    if (task.steering.length >= OPS_WORKER_LIMITS.maxSteeringEntries) return false;
    if (intent === "answer") {
      return argument !== null
        && Buffer.byteLength(argument, "utf8") <= OPS_WORKER_LIMITS.maxSteeringTextBytes
        && task.agentResult?.kind === "input-needed"
        && task.agentResult.requestedInput !== null;
    }
    if (intent === "correct") {
      return argument !== null
        && Buffer.byteLength(argument, "utf8") <= OPS_WORKER_LIMITS.maxSteeringTextBytes;
    }
    if (intent === "retry") {
      return argument === null
        && task.state === "BLOCKED"
        && !isOpsWorkerUnresolvedOrphan(task)
        && !isOpsWorkerReportReconciliationBlocked(task)
        && !(
          task.mutationReceipts.report?.outcome === null
          && task.mutationReceipts.report.mutationStartedAt !== null
        );
    }
    if (intent === "pause") {
      return argument === null
        && !task.control.paused
        && task.control.interrupt === null;
    }
    if (intent === "resume") {
      return argument === null
        && task.control.paused
        && task.control.interrupt === null;
    }
    return argument !== null
      && Buffer.byteLength(argument, "utf8") <= OPS_WORKER_LIMITS.maxInterruptReasonBytes
      && task.control.interrupt === null;
  }

  private takeClarification(): OpsWorkerClarificationSlot | null {
    const clarification = this.clarification;
    this.clarification = null;
    return clarification !== null && clarification.expiresAt >= this.now().getTime()
      ? clarification
      : null;
  }

  private storeClarification(
    operatorText: string,
    question: string,
    control: OpsWorkerClarificationSlot["control"],
  ): void {
    const boundedQuestion = truncateUtf8(
      question,
      OPS_WORKER_CONVERSATION_RUNNER_LIMITS.maxClarificationBytes,
    );
    this.clarification = {
      expiresAt: this.now().getTime() + CONVERSATION_CLARIFICATION_TTL_MS,
      previous: {
        operatorText: truncateUtf8(
          operatorText,
          OPS_WORKER_CONVERSATION_RUNNER_LIMITS.maxClarificationBytes,
        ),
        question: boundedQuestion,
      },
      control,
    };
  }

  private controlSteering(
    message: ParsedTelegramMessageBase,
    kind: OpsWorkerSteeringKind,
    text: string,
  ): OpsWorkerSteeringEntry {
    return {
      steeringId: this.steeringId(message),
      receivedAt: message.receivedAt,
      kind,
      operatorRef: `telegram:${message.senderId}`,
      text,
      consumedAt: null,
    };
  }

  private steeringId(message: ParsedTelegramMessageBase): string {
    return `telegram:update:${message.updateId}:${message.fingerprint}`;
  }

  private async deliverOnePendingReport(signal: AbortSignal): Promise<string | null> {
    const tasks = this.supervisor.listTasks()
      .filter((candidate) =>
        candidate.report.state === "PENDING"
        && candidate.report.attempts < OPS_WORKER_LIMITS.maxReportAttempts
        && !isOpsWorkerReportReconciliationBlocked(candidate))
      .sort((left, right) => {
        const leftObservedAt = left.mutationReceipts.report?.queryObservedAt;
        const rightObservedAt = right.mutationReceipts.report?.queryObservedAt;
        if (leftObservedAt === undefined && rightObservedAt !== undefined) return -1;
        if (leftObservedAt !== undefined && rightObservedAt === undefined) return 1;
        if (leftObservedAt !== rightObservedAt) {
          return Date.parse(leftObservedAt ?? "") - Date.parse(rightObservedAt ?? "");
        }
        return left.id.localeCompare(right.id);
      });
    for (const task of tasks) {
      const result = await this.supervisor.recordReportAttempt(
        task.id,
        async (prepared) => {
          try {
            await this.sendMessage(buildOpsWorkerTelegramReport(prepared, {
              redact: this.redactAgentField,
              maxBytes: this.config.reply.maxBytes,
            }), signal);
          } catch (error) {
            return { sent: false, error: safeError(error) };
          }
          this.faultInjector?.("after-report-send-before-receipt-finish", -1);
          return { sent: true };
        },
      );
      if (isOpsWorkerReportReconciliationBlocked(result)) continue;
      return task.id;
    }
    return null;
  }
}
