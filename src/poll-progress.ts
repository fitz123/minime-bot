import type { Transformer } from "grammy";

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
