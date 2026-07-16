import type { BotConfig } from "./types.js";
import {
  TAVILY_EVENT_POLL_INTERVAL_MS,
  type TavilyMonitor,
  type TavilyNotification,
  type TavilyNotificationFailure,
  type TavilyRecoveryResult,
  type TavilyStatusSnapshot,
} from "./tavily-monitor.js";

export const TAVILY_USAGE_SAMPLE_INTERVAL_MS = 5 * 60 * 1_000;
export const TAVILY_DELIVERY_RETRY_BASE_MS = 30_000;
export const TAVILY_DELIVERY_RETRY_MAX_MS = 60 * 60 * 1_000;
export const TAVILY_DELIVERY_TIMEOUT_MS = 10_000;
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

export type TavilyNotificationDelivery = (
  payload: TavilyDeliveryPayload,
  signal: AbortSignal,
) => Promise<void>;

export interface TavilyOperatorActions {
  getDeliveryDestination(): TavilyDeliveryDestination | undefined;
  isIncidentActive(generation: string): boolean;
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
  deliveryTimeoutMs?: number;
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
  private readonly deliveryTimeoutMs: number;
  private readonly setIntervalImpl: (callback: () => void, intervalMs: number) => unknown;
  private readonly clearIntervalImpl: (handle: unknown) => void;
  private readonly onError: (error: unknown) => void;
  private transitionTail: Promise<void> = Promise.resolve();
  private acceptingTransitions = true;
  private usageTimer: unknown;
  private processTimer: unknown;
  private running = false;
  private startup: Promise<void> | undefined;
  private readonly recheckFlights = new Map<string, Promise<TavilyRecoveryResult>>();
  private readonly activeDeliveryControllers = new Set<AbortController>();

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
    this.deliveryTimeoutMs = positiveInterval(
      options.deliveryTimeoutMs ?? TAVILY_DELIVERY_TIMEOUT_MS,
      "Tavily delivery timeout",
    );
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

  isIncidentActive(generation: string): boolean {
    return this.monitor.isIncidentActive(generation);
  }

  private enqueue<T>(transition: () => Promise<T> | T): Promise<T> {
    if (!this.acceptingTransitions) {
      return Promise.reject(new Error("Tavily monitor runtime is stopped"));
    }
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

  private async deliverOnce(payload: TavilyDeliveryPayload): Promise<void> {
    const controller = new AbortController();
    this.activeDeliveryControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.deliveryTimeoutMs);
    timer.unref();
    try {
      await this.deliver(payload, controller.signal);
    } finally {
      clearTimeout(timer);
      this.activeDeliveryControllers.delete(controller);
    }
  }

  private async deliverDueNotifications(): Promise<void> {
    for (const notification of this.monitor.dueNotifications(this.now())) {
      if (!this.acceptingTransitions) return;
      if (!this.destination) {
        this.monitor.recordNotificationTerminal(notification.key);
        continue;
      }
      try {
        const replyMarkup = tavilyIncidentReplyMarkup(notification);
        await this.deliverOnce({
          ...this.destination,
          text: notification.message,
          ...(replyMarkup === undefined ? {} : { replyMarkup }),
        });
        this.monitor.recordNotificationDelivered(notification.key);
      } catch (error) {
        // Shutdown aborts active deliveries. Leave the entry pending for the
        // next process and never advance to another notification afterward.
        if (!this.acceptingTransitions) return;
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
    this.acceptingTransitions = true;
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
      if (this.destination) this.monitor.resumeIncidentDelivery();
      this.monitor.drainChildEvents();
      await this.monitor.runPendingAutomaticRecovery();
      await this.sampleTransition();
    });
    return this.startup;
  }

  async stop(): Promise<void> {
    this.acceptingTransitions = false;
    if (this.running) {
      this.running = false;
      if (this.processTimer !== undefined) this.clearIntervalImpl(this.processTimer);
      if (this.usageTimer !== undefined) this.clearIntervalImpl(this.usageTimer);
      this.processTimer = undefined;
      this.usageTimer = undefined;
      this.startup = undefined;
    }
    const finalTail = this.transitionTail;
    for (const controller of this.activeDeliveryControllers) controller.abort();
    await finalTail;
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

export interface TavilyMonitorSupervisorLease {
  release: () => void;
}

export interface TavilyOwnedMonitorRuntime extends TavilyOperatorActions {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface TavilyMonitorSupervisorOptions {
  destination: TavilyDeliveryDestination | undefined;
  tryAcquireLease: () => TavilyMonitorSupervisorLease | undefined;
  createRuntime: () => {
    monitor: Pick<TavilyMonitor, "getStatus">;
    runtime: TavilyOwnedMonitorRuntime;
  };
  retryIntervalMs?: number;
  setTimeoutImpl?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  onWait?: () => void;
  onAcquired?: () => void;
  onError?: (error: unknown) => void;
}

interface TavilyMonitorOwner {
  lease: TavilyMonitorSupervisorLease;
  monitor: Pick<TavilyMonitor, "getStatus">;
  runtime: TavilyOwnedMonitorRuntime;
}

/**
 * Acquire the production writer lease without blocking bot startup. A fresh
 * monitor is constructed only after ownership is obtained, so a waiting
 * replacement cannot later overwrite state from the previous writer.
 */
export class TavilyMonitorSupervisor implements TavilyOperatorActions {
  private readonly destination: TavilyDeliveryDestination | undefined;
  private readonly tryAcquireLease: () => TavilyMonitorSupervisorLease | undefined;
  private readonly createRuntime: TavilyMonitorSupervisorOptions["createRuntime"];
  private readonly retryIntervalMs: number;
  private readonly setTimeoutImpl: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;
  private readonly onWait: () => void;
  private readonly onAcquired: () => void;
  private readonly onError: (error: unknown) => void;
  private owner: TavilyMonitorOwner | undefined;
  private retryTimer: unknown;
  private activation: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private startRequested = false;
  private stopped = false;
  private waitingLogged = false;

  constructor(options: TavilyMonitorSupervisorOptions) {
    this.destination = options.destination;
    this.tryAcquireLease = options.tryAcquireLease;
    this.createRuntime = options.createRuntime;
    this.retryIntervalMs = positiveInterval(
      options.retryIntervalMs ?? 1_000,
      "Tavily monitor lease retry interval",
    );
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((callback, delayMs) =>
      setTimeout(callback, delayMs));
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? ((handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.onWait = options.onWait ?? (() => {});
    this.onAcquired = options.onAcquired ?? (() => {});
    this.onError = options.onError ?? (() => {});
  }

  getDeliveryDestination(): TavilyDeliveryDestination | undefined {
    return this.destination ? { ...this.destination } : undefined;
  }

  getStatus(): TavilyStatusSnapshot | undefined {
    return this.owner?.monitor.getStatus();
  }

  isIncidentActive(generation: string): boolean {
    return this.owner?.runtime.isIncidentActive(generation) ?? false;
  }

  acknowledgeIncident(generation: string): Promise<boolean> {
    if (!this.owner) return Promise.reject(new Error("Tavily monitor writer is unavailable"));
    return this.owner.runtime.acknowledgeIncident(generation);
  }

  recheckIncident(generation: string): Promise<TavilyRecoveryResult> {
    if (!this.owner) return Promise.reject(new Error("Tavily monitor writer is unavailable"));
    return this.owner.runtime.recheckIncident(generation);
  }

  start(): void {
    if (this.stopped) throw new Error("Tavily monitor supervisor is stopped");
    if (this.startRequested) return;
    this.startRequested = true;
    this.tryActivate();
  }

  private scheduleRetry(): void {
    if (!this.startRequested || this.stopped || this.retryTimer !== undefined) return;
    this.retryTimer = this.setTimeoutImpl(() => {
      this.retryTimer = undefined;
      this.tryActivate();
    }, this.retryIntervalMs);
    (this.retryTimer as TavilyIntervalHandle | undefined)?.unref?.();
  }

  private releaseOwner(owner: TavilyMonitorOwner): void {
    if (this.owner !== owner) return;
    this.owner = undefined;
    try {
      owner.lease.release();
    } catch (error) {
      this.onError(error);
    }
  }

  private tryActivate(): void {
    if (!this.startRequested || this.stopped || this.owner || this.activation) return;
    let lease: TavilyMonitorSupervisorLease | undefined;
    try {
      lease = this.tryAcquireLease();
    } catch (error) {
      this.onError(error);
      this.scheduleRetry();
      return;
    }
    if (!lease) {
      if (!this.waitingLogged) {
        this.waitingLogged = true;
        this.onWait();
      }
      this.scheduleRetry();
      return;
    }

    let created: ReturnType<TavilyMonitorSupervisorOptions["createRuntime"]>;
    try {
      created = this.createRuntime();
    } catch (error) {
      try { lease.release(); } catch (releaseError) { this.onError(releaseError); }
      this.onError(error);
      this.scheduleRetry();
      return;
    }
    const owner: TavilyMonitorOwner = { lease, ...created };
    this.owner = owner;
    if (this.waitingLogged) this.waitingLogged = false;
    this.onAcquired();

    let startup: Promise<void>;
    try {
      startup = owner.runtime.start();
    } catch (error) {
      this.onError(error);
      this.releaseOwner(owner);
      this.scheduleRetry();
      return;
    }
    let activation!: Promise<void>;
    activation = startup.then(
      () => {
        if (this.activation === activation) this.activation = undefined;
      },
      async (error) => {
        this.onError(error);
        try {
          await owner.runtime.stop();
        } catch (stopError) {
          this.onError(stopError);
        }
        this.releaseOwner(owner);
        if (this.activation === activation) this.activation = undefined;
        this.scheduleRetry();
      },
    );
    this.activation = activation;
    void activation;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.startRequested = false;
    if (this.retryTimer !== undefined) {
      this.clearTimeoutImpl(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.stopPromise = (async () => {
      const owner = this.owner;
      if (owner) {
        try {
          await owner.runtime.stop();
        } finally {
          this.releaseOwner(owner);
        }
      }
      await this.activation;
    })();
    return this.stopPromise;
  }
}
