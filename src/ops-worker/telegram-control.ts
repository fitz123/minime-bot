import { timingSafeEqual } from "node:crypto";
import type { OpsWorkerControlConfig } from "./control-config.js";
import {
  hashOpsWorkerTelegramUpdate,
  type OpsWorkerControlLedger,
} from "./control-ledger.js";
import {
  summarizeOpsWorkerTasks,
  type OpsWorkerPolicySnapshot,
} from "./status-server.js";
import type { OpsWorkerSupervisor } from "./supervisor.js";
import {
  OPS_WORKER_LIMITS,
  type OpsWorkerSteeringKind,
  type OpsWorkerTask,
} from "./types.js";

const MAX_UPDATES_PER_POLL = 100;
const MAX_COMMAND_BYTES = 16 * 1024;
const TASK_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/;
const TRUNCATION_MARKER = "\n… [truncated]";

export type OpsWorkerTelegramFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type OpsWorkerTelegramControlFaultPoint =
  | "after-effect-before-ledger"
  | "after-ledger-before-reply";

export interface OpsWorkerTelegramControlOptions {
  config: OpsWorkerControlConfig;
  supervisor: OpsWorkerSupervisor;
  ledger: OpsWorkerControlLedger;
  fetch?: OpsWorkerTelegramFetch;
  inspectPolicy: () => OpsWorkerPolicySnapshot;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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

interface ParsedTelegramMessage {
  updateId: number;
  senderId: string;
  chatId: string;
  receivedAt: string;
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

function parseMessage(update: Record<string, unknown>): ParsedTelegramMessage | null {
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
    typeof message.text !== "string"
    || message.text.trim() === ""
    || Buffer.byteLength(message.text, "utf8") > MAX_COMMAND_BYTES
  ) return null;
  if (
    !Number.isSafeInteger(message.date)
    || (message.date as number) < 0
    || (message.date as number) > 8_640_000_000
  ) return null;
  return {
    updateId: updateId as number,
    senderId,
    chatId,
    receivedAt: new Date((message.date as number) * 1_000).toISOString(),
    text: message.text,
  };
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
  let previous = offset === undefined ? -1 : offset - 1;
  return value.result.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new OpsWorkerTelegramTransportError(`Telegram update ${index} is not an object`);
    }
    const updateId = entry.update_id;
    if (!Number.isSafeInteger(updateId) || (updateId as number) < 0) {
      throw new OpsWorkerTelegramTransportError(`Telegram update ${index} has an invalid update_id`);
    }
    if ((updateId as number) < previous) {
      throw new OpsWorkerTelegramTransportError("Telegram updates are not monotonically ordered");
    }
    previous = updateId as number;
    return entry;
  });
}

function taskSummary(task: OpsWorkerTask): string {
  const outcome = task.lastOutcome === null
    ? "none"
    : `${task.lastOutcome.kind}/${task.lastOutcome.result}: ${task.lastOutcome.summary}`;
  return [
    `Task ${task.id}`,
    `state=${task.state} paused=${task.control.paused}`,
    `source=${task.source.kind}/${task.source.template}`,
    `resource=${task.resource.key}`,
    `nextRunAt=${task.schedule.nextRunAt ?? "none"}`,
    `nextCheckAt=${task.schedule.nextCheckAt ?? "none"}`,
    `report=${task.report.state}/${task.report.attempts}`,
    `outcome=${outcome}`,
  ].join("\n");
}

function reportSummary(task: OpsWorkerTask): string {
  return [
    `Ops task report: ${task.id}`,
    `state=${task.state}`,
    task.lastOutcome === null
      ? "outcome=none"
      : `outcome=${task.lastOutcome.kind}/${task.lastOutcome.result}: ${task.lastOutcome.summary}`,
  ].join("\n");
}

function usage(): string {
  return "Usage: /status | /tasks | /task <id> | /answer <id> <text> | /correct <id> <text> | /pause <id> | /resume <id> | /cancel <id> <reason> | /retry <id>";
}

function taskArgument(value: string | undefined): string | null {
  const taskId = value?.trim();
  return taskId && TASK_ID_PATTERN.test(taskId) ? taskId : null;
}

export class OpsWorkerTelegramControl {
  private readonly config: OpsWorkerControlConfig;
  private readonly supervisor: OpsWorkerSupervisor;
  private readonly ledger: OpsWorkerControlLedger;
  private readonly fetch: OpsWorkerTelegramFetch;
  private readonly inspectPolicy: () => OpsWorkerPolicySnapshot;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
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
    this.sleep = options.sleep ?? defaultSleep;
    this.faultInjector = options.faultInjector;
  }

  async tick(signal: AbortSignal = new AbortController().signal): Promise<OpsWorkerTelegramTickResult> {
    const reportTaskId = await this.deliverOnePendingReport(signal);
    const offset = this.ledger.nextOffset();
    const value = await this.telegramApi("getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      timeout: this.config.poll.longPollSeconds,
      limit: MAX_UPDATES_PER_POLL,
      allowed_updates: ["message"],
    }, signal);
    const updates = parseGetUpdatesResult(value, offset);
    for (const update of updates) await this.processUpdate(update, signal);
    return { updates: updates.length, reportTaskId };
  }

  async run(signal: AbortSignal): Promise<void> {
    let backoff = this.config.poll.retryMinMs;
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
  }

  private async telegramApi(
    method: "getUpdates" | "sendMessage",
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

  private async processUpdate(
    update: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const updateId = update.update_id as number;
    const fingerprint = hashOpsWorkerTelegramUpdate(stableJson(update));
    const retained = this.ledger.read().processedUpdates.find(
      (entry) => entry.updateId === updateId,
    );
    if (retained) {
      if (!fingerprintsEqual(retained.fingerprint, fingerprint)) {
        this.ledger.record(updateId, fingerprint);
      }
      return;
    }
    const message = parseMessage(update);
    if (
      message === null
      || message.chatId !== this.config.telegram.controlChatId
      || !this.config.telegram.operatorIds.includes(message.senderId)
    ) {
      this.ledger.record(updateId, fingerprint);
      return;
    }
    const reply = this.dispatchCommand(message);
    this.faultInjector?.("after-effect-before-ledger", updateId);
    this.ledger.record(updateId, fingerprint);
    this.faultInjector?.("after-ledger-before-reply", updateId);
    await this.sendMessage(reply, signal);
  }

  private dispatchCommand(message: ParsedTelegramMessage): string {
    const match = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(message.text.trim());
    if (!match) return usage();
    const command = match[1];
    const tail = match[2]?.trim();
    if (command === "status" && tail === undefined) {
      const tasks = this.supervisor.listTasks();
      const summary = summarizeOpsWorkerTasks(tasks);
      const policy = this.inspectPolicy();
      return [
        `Ops worker: tasks=${summary.totalTasks} activeGroups=${summary.activeProcessGroups}`,
        `custody=${summary.custodyOwner?.id ?? "none"}`,
        `states=${Object.entries(summary.states).map(([state, count]) => `${state}:${count}`).join(",")}`,
        `authorization=${policy.authorization.verifierCount}/${policy.authorization.contractsHash}`,
        `verification=${policy.verification.verifierCount}/${policy.verification.contractsHash}`,
        `quota=${policy.quota.configured ? "configured" : "unconfigured"}`,
        `parity=${policy.parity.configured ? "configured" : "unconfigured"}`,
      ].join("\n");
    }
    if (command === "tasks" && tail === undefined) {
      const tasks = this.supervisor.listTasks();
      return tasks.length === 0
        ? "No ops-worker tasks."
        : tasks.map((task) =>
          `${task.id} ${task.state}${task.control.paused ? " paused" : ""}`).join("\n");
    }
    if (command === "task") {
      const taskId = taskArgument(tail);
      if (taskId === null) return usage();
      const task = this.supervisor.getTask(taskId);
      return task ? taskSummary(task) : `Unknown ops-worker task ${taskId}.`;
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
      const task = this.supervisor.getTask(taskId);
      if (!task) return `Unknown ops-worker task ${taskId}.`;
      const steeringId = `telegram:update:${message.updateId}`;
      if ((task.state === "DONE" || task.state === "CANCELLED")
        && !task.steering.some((entry) => entry.steeringId === steeringId)) {
        return `Task ${taskId} is terminal; steering was not recorded.`;
      }
      this.supervisor.appendTaskSteering(taskId, {
        steeringId,
        receivedAt: message.receivedAt,
        kind: command === "answer" ? "answer" : "correction",
        operatorRef: `telegram:${message.senderId}`,
        text,
        consumedAt: null,
      });
      return `Recorded ${command === "answer" ? "answer" : "correction"} for ${taskId}.`;
    }
    if (command === "pause" || command === "resume" || command === "retry") {
      const taskId = taskArgument(tail);
      if (taskId === null) return usage();
      const task = this.supervisor.getTask(taskId);
      if (!task) return `Unknown ops-worker task ${taskId}.`;
      const steeringId = `telegram:update:${message.updateId}`;
      const replayed = task.steering.some((entry) => entry.steeringId === steeringId);
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
      this.appendControlSteering(message, taskId, command === "pause" ? "pause" : "resume", command);
      if (command === "retry") {
        const retried = this.supervisor.retryBlockedTask(taskId);
        return `Retried ${taskId}; state=${retried.state}.`;
      }
      const changed = this.supervisor.setTaskPaused(taskId, command === "pause");
      return `${command === "pause" ? "Paused" : "Resumed"} ${taskId}; state=${changed.state}.`;
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
      const task = this.supervisor.getTask(taskId);
      if (!task) return `Unknown ops-worker task ${taskId}.`;
      const steeringId = `telegram:update:${message.updateId}`;
      const replayed = task.steering.some((entry) => entry.steeringId === steeringId);
      if (task.state === "CANCELLED" && replayed) return `Cancellation for ${taskId} was already applied.`;
      if (task.state === "DONE" || task.state === "CANCELLED") {
        return `Task ${taskId} is terminal; cancellation was not recorded.`;
      }
      if (
        task.control.interrupt !== null
        && (task.control.interrupt.mode !== "cancel" || task.control.interrupt.reason !== reason)
        && !replayed
      ) return `Task ${taskId} already has a different pending interrupt.`;
      this.appendControlSteering(message, taskId, "cancel", reason);
      const changed = this.supervisor.requestOperatorInterrupt(taskId, "cancel", reason);
      return `Cancellation recorded for ${taskId}; state=${changed.state}.`;
    }
    return usage();
  }

  private appendControlSteering(
    message: ParsedTelegramMessage,
    taskId: string,
    kind: OpsWorkerSteeringKind,
    text: string,
  ): void {
    this.supervisor.appendTaskSteering(taskId, {
      steeringId: `telegram:update:${message.updateId}`,
      receivedAt: message.receivedAt,
      kind,
      operatorRef: `telegram:${message.senderId}`,
      text,
      consumedAt: null,
    });
  }

  private async deliverOnePendingReport(signal: AbortSignal): Promise<string | null> {
    const task = this.supervisor.listTasks().find(
      (candidate) => candidate.report.state === "PENDING",
    );
    if (!task) return null;
    try {
      await this.sendMessage(reportSummary(task), signal);
    } catch (error) {
      await this.supervisor.recordReportAttempt(task.id, {
        sent: false,
        error: safeError(error),
      });
      return task.id;
    }
    await this.supervisor.recordReportAttempt(task.id, { sent: true });
    return task.id;
  }
}
