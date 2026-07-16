import type { BotConfig } from "./types.js";
import {
  TAVILY_EVENT_POLL_INTERVAL_MS,
  type TavilyMonitor,
  type TavilyNotification,
  type TavilyNotificationFailure,
  type TavilyRecoveryResult,
} from "./tavily-monitor.js";

export const TAVILY_USAGE_SAMPLE_INTERVAL_MS = 5 * 60 * 1_000;
export const TAVILY_DELIVERY_RETRY_BASE_MS = 30_000;
export const TAVILY_DELIVERY_RETRY_MAX_MS = 60 * 60 * 1_000;
export const TAVILY_ACK_CALLBACK_PREFIX = "tavily:ack:";
export const TAVILY_RECHECK_CALLBACK_PREFIX = "tavily:recheck:";

export interface TavilyDeliveryDestination {
  chatId: number;
  threadId?: number;
}

export interface TavilyInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export interface TavilyDeliveryPayload extends TavilyDeliveryDestination {
  text: string;
  replyMarkup?: TavilyInlineKeyboard;
}

export type TavilyNotificationDelivery = (payload: TavilyDeliveryPayload) => Promise<void>;

export interface TavilyOperatorActions {
  getDeliveryDestination(): TavilyDeliveryDestination | undefined;
  acknowledgeIncident(generation: string): Promise<boolean>;
  recheckIncident(generation: string): Promise<TavilyRecoveryResult>;
}

interface TavilyIntervalHandle {
  unref?: () => void;
}

export interface TavilyMonitorRuntimeOptions {
  monitor: TavilyMonitor;
  destination: TavilyDeliveryDestination | undefined;
  deliver: TavilyNotificationDelivery;
  now?: () => Date;
  usageSampleIntervalMs?: number;
  processIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  setIntervalImpl?: (callback: () => void, intervalMs: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  onError?: (error: unknown) => void;
}

export type TavilyCallbackAction =
  | { action: "acknowledge"; generation: string }
  | { action: "recheck"; generation: string };

type DeliveryFailure = {
  failure: TavilyNotificationFailure;
  retryAfterMs?: number;
};

function positiveInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return value;
}

function errorRecord(error: unknown): Record<string, unknown> | undefined {
  return typeof error === "object" && error !== null
    ? error as Record<string, unknown>
    : undefined;
}

function numericErrorCode(error: unknown): number | undefined {
  const record = errorRecord(error);
  if (!record) return undefined;
  if (Number.isInteger(record.error_code)) return record.error_code as number;
  return numericErrorCode(record.error);
}

function retryAfterMilliseconds(error: unknown): number | undefined {
  const record = errorRecord(error);
  if (!record) return undefined;
  const parameters = errorRecord(record.parameters);
  const seconds = parameters?.retry_after;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1_000;
  }
  return retryAfterMilliseconds(record.error);
}

/** Reduce grammY/network failures to the bounded durable outbox vocabulary. */
export function classifyTavilyDeliveryError(error: unknown): DeliveryFailure {
  const errorCode = numericErrorCode(error);
  if (errorCode === 429) {
    const retryAfterMs = retryAfterMilliseconds(error);
    return {
      failure: "rate_limited",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (errorCode !== undefined && errorCode >= 500 && errorCode <= 599) {
    return { failure: "server_error" };
  }
  if (errorCode !== undefined && errorCode >= 400 && errorCode <= 499) {
    return { failure: "destination_invalid" };
  }
  return { failure: "transport" };
}

export function resolveTavilyDeliveryDestination(
  config: Pick<BotConfig, "adminChatId" | "defaultDeliveryChatId" | "defaultDeliveryThreadId">,
): TavilyDeliveryDestination | undefined {
  if (Number.isSafeInteger(config.adminChatId) && config.adminChatId !== 0) {
    return { chatId: config.adminChatId as number };
  }
  if (!Number.isSafeInteger(config.defaultDeliveryChatId) || config.defaultDeliveryChatId === 0) {
    return undefined;
  }
  return {
    chatId: config.defaultDeliveryChatId as number,
    ...(Number.isSafeInteger(config.defaultDeliveryThreadId) && config.defaultDeliveryThreadId !== 0
      ? { threadId: config.defaultDeliveryThreadId as number }
      : {}),
  };
}

export function tavilyIncidentReplyMarkup(
  notification: Pick<TavilyNotification, "kind" | "incidentGeneration">,
): TavilyInlineKeyboard | undefined {
  const generation = notification.incidentGeneration;
  if (!generation || (notification.kind !== "incident" && notification.kind !== "reminder")) {
    return undefined;
  }
  return {
    inline_keyboard: [[
      {
        text: "acknowledge degraded mode",
        callback_data: `${TAVILY_ACK_CALLBACK_PREFIX}${generation}`,
      },
      {
        text: "credits fixed — recheck",
        callback_data: `${TAVILY_RECHECK_CALLBACK_PREFIX}${generation}`,
      },
    ]],
  };
}

export function parseTavilyCallbackData(data: string): TavilyCallbackAction | undefined {
  const match = /^tavily:(ack|recheck):(\d{4}-\d{2}-[1-9]\d*)$/.exec(data);
  if (!match) return undefined;
  return {
    action: match[1] === "ack" ? "acknowledge" : "recheck",
    generation: match[2],
  };
}

/**
 * Serialize the main-process sampler, spool, delivery, and operator transitions
 * around the durable Tavily state core.
 */
export class TavilyMonitorRuntime implements TavilyOperatorActions {
  private readonly monitor: TavilyMonitor;
  private readonly destination: TavilyDeliveryDestination | undefined;
  private readonly deliver: TavilyNotificationDelivery;
  private readonly now: () => Date;
  private readonly usageSampleIntervalMs: number;
  private readonly processIntervalMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly setIntervalImpl: (callback: () => void, intervalMs: number) => unknown;
  private readonly clearIntervalImpl: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private transitionTail: Promise<void> = Promise.resolve();
  private usageTimer: unknown;
  private processTimer: unknown;
  private running = false;
  private startup: Promise<void> | undefined;
  private readonly recheckFlights = new Map<string, Promise<TavilyRecoveryResult>>();

  constructor(options: TavilyMonitorRuntimeOptions) {
    this.monitor = options.monitor;
    this.destination = options.destination;
    this.deliver = options.deliver;
    this.now = options.now ?? (() => new Date());
    this.usageSampleIntervalMs = positiveInterval(
      options.usageSampleIntervalMs ?? TAVILY_USAGE_SAMPLE_INTERVAL_MS,
      "Tavily usage sample interval",
    );
    this.processIntervalMs = positiveInterval(
      options.processIntervalMs ?? TAVILY_EVENT_POLL_INTERVAL_MS,
      "Tavily processing interval",
    );
    this.retryBaseMs = positiveInterval(
      options.retryBaseMs ?? TAVILY_DELIVERY_RETRY_BASE_MS,
      "Tavily delivery retry base",
    );
    this.retryMaxMs = positiveInterval(
      options.retryMaxMs ?? TAVILY_DELIVERY_RETRY_MAX_MS,
      "Tavily delivery retry maximum",
    );
    if (this.retryBaseMs > this.retryMaxMs) {
      throw new Error("Tavily delivery retry base exceeds maximum");
    }
    this.setIntervalImpl = options.setIntervalImpl ?? ((callback, intervalMs) =>
      setInterval(callback, intervalMs));
    this.clearIntervalImpl = options.clearIntervalImpl ?? ((handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>));
    this.onError = options.onError ?? (() => {});
  }

  getDeliveryDestination(): TavilyDeliveryDestination | undefined {
    return this.destination ? { ...this.destination } : undefined;
  }

  isRunning(): boolean {
    return this.running;
  }

  private enqueue<T>(transition: () => Promise<T> | T): Promise<T> {
    const result = this.transitionTail.then(async () => {
      try {
        return await transition();
      } finally {
        this.monitor.refreshDiagnostics(this.now());
      }
    });
    this.transitionTail = result.then(
      () => undefined,
      (error) => { this.onError(error); },
    );
    return result;
  }

  private installTimer(callback: () => void, intervalMs: number): unknown {
    const handle = this.setIntervalImpl(callback, intervalMs);
    (handle as TavilyIntervalHandle | undefined)?.unref?.();
    return handle;
  }

  private retryDelay(notification: TavilyNotification, retryAfterMs?: number): number {
    const exponent = Math.min(notification.attempts, 30);
    const backoff = Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** exponent));
    return Math.min(this.retryMaxMs, Math.max(backoff, retryAfterMs ?? 0));
  }

  private async deliverDueNotifications(): Promise<void> {
    for (const notification of this.monitor.dueNotifications(this.now())) {
      if (!this.destination) {
        this.monitor.recordNotificationTerminal(notification.key);
        continue;
      }
      try {
        const replyMarkup = tavilyIncidentReplyMarkup(notification);
        await this.deliver({
          ...this.destination,
          text: notification.message,
          ...(replyMarkup === undefined ? {} : { replyMarkup }),
        });
        this.monitor.recordNotificationDelivered(notification.key);
      } catch (error) {
        const classified = classifyTavilyDeliveryError(error);
        if (classified.failure === "destination_invalid") {
          this.monitor.recordNotificationTerminal(notification.key);
          continue;
        }
        const nextAttemptAt = new Date(
          this.now().getTime() + this.retryDelay(notification, classified.retryAfterMs),
        );
        this.monitor.recordNotificationRetry(
          notification.key,
          nextAttemptAt,
          classified.failure,
        );
      }
    }
  }

  private async processTransition(): Promise<void> {
    this.monitor.drainChildEvents();
    this.monitor.queueDueReminder();
    await this.deliverDueNotifications();
  }

  private async sampleTransition(): Promise<void> {
    await this.monitor.sampleUsage();
    this.monitor.queueDueReminder();
    await this.deliverDueNotifications();
  }

  /** Restore is performed by the core constructor; start drains and samples before returning. */
  start(): Promise<void> {
    if (this.running) return this.startup ?? Promise.resolve();
    this.running = true;
    this.processTimer = this.installTimer(() => {
      if (!this.running) return;
      void this.enqueue(() => this.processTransition());
    }, this.processIntervalMs);
    this.usageTimer = this.installTimer(() => {
      if (!this.running) return;
      void this.enqueue(() => this.sampleTransition());
    }, this.usageSampleIntervalMs);
    this.startup = this.enqueue(async () => {
      this.monitor.drainChildEvents();
      await this.monitor.runPendingAutomaticRecovery();
      await this.sampleTransition();
    });
    return this.startup;
  }

  async stop(): Promise<void> {
    if (this.running) {
      this.running = false;
      if (this.processTimer !== undefined) this.clearIntervalImpl(this.processTimer);
      if (this.usageTimer !== undefined) this.clearIntervalImpl(this.usageTimer);
      this.processTimer = undefined;
      this.usageTimer = undefined;
      this.startup = undefined;
    }
    await this.transitionTail;
  }

  processNow(): Promise<void> {
    return this.enqueue(() => this.processTransition());
  }

  sampleNow(): Promise<void> {
    return this.enqueue(() => this.sampleTransition());
  }

  acknowledgeIncident(generation: string): Promise<boolean> {
    return this.enqueue(() => this.monitor.acknowledgeIncident(generation));
  }

  recheckIncident(generation: string): Promise<TavilyRecoveryResult> {
    const existing = this.recheckFlights.get(generation);
    if (existing) return existing;
    const flight = this.enqueue(async () => {
      const result = await this.monitor.recheckIncident(generation);
      await this.deliverDueNotifications();
      return result;
    });
    this.recheckFlights.set(generation, flight);
    void flight.then(
      () => this.recheckFlights.delete(generation),
      () => this.recheckFlights.delete(generation),
    );
    return flight;
  }
}
