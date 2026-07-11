import type { Context, MiddlewareFn, Transformer } from "grammy";

/** Explicit cadence used by grammY long polling in main.ts. */
export const TELEGRAM_LONG_POLL_TIMEOUT_SECONDS = 30;

/**
 * A successful poll should normally complete once per long-poll timeout. Three
 * full cadences leave room for request turnover and scheduler delay without
 * hiding a genuinely stuck polling loop.
 */
export const DEFAULT_POLL_STALL_THRESHOLD_MS =
  TELEGRAM_LONG_POLL_TIMEOUT_SECONDS * 3 * 1000;

export interface PollProgressSnapshot {
  readonly initializedAtMs: number;
  readonly lastPollStartedAtMs: number | null;
  readonly lastPollSucceededAtMs: number | null;
  readonly successfulPollCount: number;
  readonly inFlight: boolean;
  readonly failedPollCount: number;
}

export interface PollProgressProbe {
  readonly transformer: Transformer;
  snapshot(): Readonly<PollProgressSnapshot>;
}

export interface UpdateProcessingSnapshot {
  readonly inFlight: boolean;
  readonly startedAtMs: number | null;
}

export interface UpdateProcessingProbe {
  readonly middleware: MiddlewareFn<Context>;
  snapshot(): Readonly<UpdateProcessingSnapshot>;
}

/**
 * Observe grammY's internal getUpdates calls without retaining their payloads
 * or responses. Empty successful responses count as healthy poll progress.
 */
export function createPollProgressProbe(now: () => number = Date.now): PollProgressProbe {
  const initializedAtMs = now();
  let lastPollStartedAtMs: number | null = null;
  let lastPollSucceededAtMs: number | null = null;
  let successfulPollCount = 0;
  let inFlightCount = 0;
  let failedPollCount = 0;

  const transformer: Transformer = async (prev, method, payload, signal) => {
    if (method !== "getUpdates") {
      return prev(method, payload, signal);
    }

    lastPollStartedAtMs = now();
    inFlightCount++;
    try {
      const response = await prev(method, payload, signal);
      if (response.ok) {
        lastPollSucceededAtMs = now();
        successfulPollCount++;
      } else {
        failedPollCount++;
      }
      return response;
    } catch (error) {
      failedPollCount++;
      throw error;
    } finally {
      inFlightCount--;
    }
  };

  return {
    transformer,
    snapshot(): Readonly<PollProgressSnapshot> {
      return Object.freeze({
        initializedAtMs,
        lastPollStartedAtMs,
        lastPollSucceededAtMs,
        successfulPollCount,
        inFlight: inFlightCount > 0,
        failedPollCount,
      });
    },
  };
}

/**
 * Track time spent inside grammY middleware. Simple long polling waits for the
 * current update handler before issuing the next getUpdates call, so this is
 * distinct from a stalled request and must be bounded separately.
 */
export function createUpdateProcessingProbe(now: () => number = Date.now): UpdateProcessingProbe {
  let inFlightCount = 0;
  let startedAtMs: number | null = null;

  const middleware: MiddlewareFn<Context> = async (_ctx, next) => {
    if (inFlightCount === 0) startedAtMs = now();
    inFlightCount++;
    try {
      await next();
    } finally {
      inFlightCount--;
      if (inFlightCount === 0) startedAtMs = null;
    }
  };

  return {
    middleware,
    snapshot(): Readonly<UpdateProcessingSnapshot> {
      return Object.freeze({
        inFlight: inFlightCount > 0,
        startedAtMs,
      });
    },
  };
}
