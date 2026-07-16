import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GrammyError } from "grammy";
import {
  createTelegramPollingRestartScheduler,
  hasActiveAgentPlatform,
  is409ConflictError,
  runTelegramSetupInBackground,
  shouldRestartForTelegramFailure,
  startBotWithRetry,
  stopTelegramBot,
  stopTelegramBotInBackground,
} from "../bot-startup.js";

describe("createTelegramPollingRestartScheduler", () => {
  it("deduplicates restarts, bounds backoff, and resets after recovery", () => {
    const pending: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
    const scheduler = createTelegramPollingRestartScheduler({
      baseDelayMs: 5,
      maxDelayMs: 10,
      setTimeoutFn: (callback, delayMs) => {
        const entry = { callback, delayMs, cancelled: false };
        pending.push(entry);
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {
        const entry = pending.at(-1);
        if (entry) entry.cancelled = true;
      },
    });
    let restarts = 0;

    assert.equal(scheduler.schedule(() => { restarts++; }), 5);
    assert.equal(scheduler.schedule(() => assert.fail("duplicate restart ran")), undefined);
    assert.equal(pending[0]?.delayMs, 5);
    pending[0]?.callback();
    assert.equal(restarts, 1);

    assert.equal(scheduler.schedule(() => { restarts++; }), 10);
    pending[1]?.callback();
    assert.equal(scheduler.schedule(() => { restarts++; }), 10);
    pending[2]?.callback();
    assert.equal(restarts, 3);

    scheduler.reset();
    assert.equal(scheduler.schedule(() => { restarts++; }), 5);
    scheduler.cancel();
    assert.equal(pending[3]?.cancelled, true);
    assert.equal(restarts, 3);
  });
});

describe("hasActiveAgentPlatform", () => {
  it("does not count an owner-only Telegram alert transport after Discord startup fails", () => {
    assert.equal(hasActiveAgentPlatform({
      telegramStarted: true,
      telegramBindingCount: 0,
      discordStarted: false,
      discordBindingCount: 1,
    }), false);
  });

  it("accepts only started transports with conversational bindings", () => {
    assert.equal(hasActiveAgentPlatform({
      telegramStarted: true,
      telegramBindingCount: 1,
      discordStarted: false,
      discordBindingCount: 0,
    }), true);
    assert.equal(hasActiveAgentPlatform({
      telegramStarted: false,
      telegramBindingCount: 0,
      discordStarted: true,
      discordBindingCount: 1,
    }), true);
    assert.equal(hasActiveAgentPlatform({
      telegramStarted: false,
      telegramBindingCount: 1,
      discordStarted: true,
      discordBindingCount: 0,
    }), false);
  });
});

describe("shouldRestartForTelegramFailure", () => {
  it("keeps a Discord deployment alive when alert-only Telegram polling fails", () => {
    assert.equal(shouldRestartForTelegramFailure({
      telegramBindingCount: 0,
      discordStarted: true,
      discordBindingCount: 1,
    }), false);
  });

  it("keeps a live Discord platform alive when a bound Telegram platform fails", () => {
    assert.equal(shouldRestartForTelegramFailure({
      telegramBindingCount: 1,
      discordStarted: true,
      discordBindingCount: 1,
    }), false);
  });

  it("restarts when failed Telegram polling was the only conversational platform", () => {
    assert.equal(shouldRestartForTelegramFailure({
      telegramBindingCount: 1,
      discordStarted: false,
      discordBindingCount: 1,
    }), true);
    assert.equal(shouldRestartForTelegramFailure({
      telegramBindingCount: 1,
      discordStarted: true,
      discordBindingCount: 0,
    }), true);
  });
});

describe("runTelegramSetupInBackground", () => {
  it("returns before a pending setup task completes", async () => {
    let finishSetup!: () => void;
    const pending = new Promise<void>((resolve) => { finishSetup = resolve; });
    let succeeded = false;

    runTelegramSetupInBackground(
      () => pending,
      () => { succeeded = true; },
      () => assert.fail("setup unexpectedly failed"),
    );

    assert.equal(succeeded, false);
    finishSetup();
    await pending;
    await Promise.resolve();
    assert.equal(succeeded, true);
  });

  it("reports synchronous setup failures without an unhandled rejection", async () => {
    const expected = new Error("synthetic setup failure");
    let reported: unknown;

    runTelegramSetupInBackground(
      () => { throw expected; },
      () => assert.fail("setup unexpectedly succeeded"),
      (error) => { reported = error; },
    );

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reported, expected);
  });
});

describe("stopTelegramBotInBackground", () => {
  it("handles a rejected final getUpdates confirmation without an unhandled rejection", async () => {
    const expected = new Error("synthetic Telegram outage");
    let reported: unknown;
    let stopCalls = 0;

    stopTelegramBotInBackground(
      {
        stop: async () => {
          stopCalls++;
          throw expected;
        },
      },
      (error) => { reported = error; },
    );

    assert.equal(stopCalls, 1);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(reported, expected);
  });

  it("allows restart scheduling only after grammY cleanup settles", async () => {
    let finishStop!: () => void;
    const stopPending = new Promise<void>((resolve) => { finishStop = resolve; });
    const pendingTimers: Array<{ callback: () => void; delayMs: number }> = [];
    const scheduler = createTelegramPollingRestartScheduler({
      baseDelayMs: 5,
      setTimeoutFn: (callback, delayMs) => {
        pendingTimers.push({ callback, delayMs });
        return { unref() {} } as ReturnType<typeof setTimeout>;
      },
    });

    const cleanup = stopTelegramBot(
      { stop: () => stopPending },
      () => assert.fail("cleanup unexpectedly failed"),
    ).then(() => scheduler.schedule(() => {}));

    await Promise.resolve();
    assert.equal(pendingTimers.length, 0, "a new polling generation cannot overlap cleanup");
    finishStop();
    assert.equal(await cleanup, 5);
    assert.equal(pendingTimers.length, 1);
  });
});

describe("is409ConflictError", () => {
  it("returns true for GrammyError with error_code 409", () => {
    const err = new GrammyError(
      "Conflict: terminated by other getUpdates request",
      { ok: false, error_code: 409, description: "Conflict" } as any,
      "getUpdates",
      {},
    );
    assert.strictEqual(is409ConflictError(err), true);
  });

  it("returns true for BotError wrapping a 409 GrammyError", () => {
    const inner = new GrammyError(
      "Conflict",
      { ok: false, error_code: 409, description: "Conflict" } as any,
      "getUpdates",
      {},
    );
    const err = { error: inner };
    assert.strictEqual(is409ConflictError(err), true);
  });

  it("returns false for GrammyError with non-409 code", () => {
    const err = new GrammyError(
      "Too Many Requests",
      { ok: false, error_code: 429, description: "Too Many Requests" } as any,
      "sendMessage",
      {},
    );
    assert.strictEqual(is409ConflictError(err), false);
  });

  it("returns false for a generic Error", () => {
    assert.strictEqual(is409ConflictError(new Error("network error")), false);
  });

  it("returns false for null/undefined", () => {
    assert.strictEqual(is409ConflictError(null), false);
    assert.strictEqual(is409ConflictError(undefined), false);
  });
});

describe("startBotWithRetry", () => {
  const fakeSleep = async (_ms: number) => {};

  it("succeeds on first attempt without retry", async () => {
    let callCount = 0;
    await startBotWithRetry(
      async () => { callCount++; },
      { maxRetries: 3, sleep: fakeSleep },
    );
    assert.strictEqual(callCount, 1);
  });

  it("retries on 409 and succeeds on subsequent attempt", async () => {
    let callCount = 0;
    await startBotWithRetry(
      async () => {
        callCount++;
        if (callCount < 3) {
          throw new GrammyError(
            "Conflict",
            { ok: false, error_code: 409, description: "Conflict" } as any,
            "getUpdates",
            {},
          );
        }
      },
      { maxRetries: 5, baseDelayMs: 10, sleep: fakeSleep },
    );
    assert.strictEqual(callCount, 3);
  });

  it("throws after exhausting retries on persistent 409", async () => {
    let callCount = 0;
    await assert.rejects(
      () =>
        startBotWithRetry(
          async () => {
            callCount++;
            throw new GrammyError(
              "Conflict",
              { ok: false, error_code: 409, description: "Conflict" } as any,
              "getUpdates",
              {},
            );
          },
          { maxRetries: 3, baseDelayMs: 10, sleep: fakeSleep },
        ),
      (err: unknown) => {
        assert.ok(err instanceof GrammyError);
        assert.strictEqual(err.error_code, 409);
        return true;
      },
    );
    // Should have tried 3 times: attempts 1 and 2 retry, attempt 3 is last so it throws
    assert.strictEqual(callCount, 3);
  });

  it("does not retry non-409 errors", async () => {
    let callCount = 0;
    await assert.rejects(
      () =>
        startBotWithRetry(
          async () => {
            callCount++;
            throw new GrammyError(
              "Bad Request",
              { ok: false, error_code: 400, description: "Bad Request" } as any,
              "getUpdates",
              {},
            );
          },
          { maxRetries: 5, baseDelayMs: 10, sleep: fakeSleep },
        ),
      (err: unknown) => {
        assert.ok(err instanceof GrammyError);
        assert.strictEqual(err.error_code, 400);
        return true;
      },
    );
    assert.strictEqual(callCount, 1);
  });

  it("uses exponential backoff delays", async () => {
    const delays: number[] = [];
    let callCount = 0;
    const trackingSleep = async (ms: number) => { delays.push(ms); };

    await assert.rejects(
      () =>
        startBotWithRetry(
          async () => {
            callCount++;
            throw new GrammyError(
              "Conflict",
              { ok: false, error_code: 409, description: "Conflict" } as any,
              "getUpdates",
              {},
            );
          },
          { maxRetries: 4, baseDelayMs: 1000, sleep: trackingSleep },
        ),
    );
    // 3 retries before final throw: delays for attempts 1, 2, 3
    assert.deepStrictEqual(delays, [1000, 2000, 4000]);
  });

  it("caps backoff delay at 60 seconds", async () => {
    const delays: number[] = [];
    const trackingSleep = async (ms: number) => { delays.push(ms); };

    await assert.rejects(
      () =>
        startBotWithRetry(
          async () => {
            throw new GrammyError(
              "Conflict",
              { ok: false, error_code: 409, description: "Conflict" } as any,
              "getUpdates",
              {},
            );
          },
          { maxRetries: 4, baseDelayMs: 30000, sleep: trackingSleep },
        ),
    );
    // 30000, 60000 (capped from 60000), 60000 (capped from 120000)
    assert.deepStrictEqual(delays, [30000, 60000, 60000]);
  });
});
