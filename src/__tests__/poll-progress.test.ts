import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createPollProgressProbe,
  DEFAULT_POLL_STALL_THRESHOLD_MS,
  TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
} from "../poll-progress.js";

describe("poll-progress probe", () => {
  it("derives a conservative stall threshold from the explicit poll timeout", () => {
    assert.ok(DEFAULT_POLL_STALL_THRESHOLD_MS > TELEGRAM_LONG_POLL_TIMEOUT_SECONDS * 1000);
    assert.equal(DEFAULT_POLL_STALL_THRESHOLD_MS, TELEGRAM_LONG_POLL_TIMEOUT_SECONDS * 3 * 1000);
  });

  it("ignores non-getUpdates methods", async () => {
    let clock = 10;
    const probe = createPollProgressProbe(() => clock);
    const response = { ok: true, result: { id: 1 } } as const;
    const result = await probe.transformer(
      (async () => response) as never,
      "getMe",
      {},
    );
    assert.equal(result, response);
    assert.deepEqual(probe.snapshot(), {
      initializedAtMs: 10,
      lastPollStartedAtMs: null,
      lastPollSucceededAtMs: null,
      successfulPollCount: 0,
      inFlight: false,
      failedPollCount: 0,
    });
  });

  it("marks in-flight and advances only after a successful empty response", async () => {
    let clock = 100;
    let resolvePoll!: (value: { ok: true; result: never[] }) => void;
    const pending = new Promise<{ ok: true; result: never[] }>((resolve) => { resolvePoll = resolve; });
    const probe = createPollProgressProbe(() => clock);
    const call = probe.transformer((async () => pending) as never, "getUpdates", { timeout: 30 });

    assert.deepEqual(probe.snapshot(), {
      initializedAtMs: 100,
      lastPollStartedAtMs: 100,
      lastPollSucceededAtMs: null,
      successfulPollCount: 0,
      inFlight: true,
      failedPollCount: 0,
    });
    clock = 130;
    resolvePoll({ ok: true, result: [] });
    await call;
    assert.deepEqual(probe.snapshot(), {
      initializedAtMs: 100,
      lastPollStartedAtMs: 100,
      lastPollSucceededAtMs: 130,
      successfulPollCount: 1,
      inFlight: false,
      failedPollCount: 0,
    });
  });

  it("counts rejected and unsuccessful completions without advancing success", async () => {
    let clock = 0;
    const probe = createPollProgressProbe(() => clock);
    await probe.transformer(
      (async () => ({ ok: false, error_code: 500, description: "synthetic" })) as never,
      "getUpdates",
      {},
    );
    clock = 1;
    await assert.rejects(
      probe.transformer(
        (async () => { throw new Error("synthetic rejection"); }) as never,
        "getUpdates",
        {},
      ),
    );
    assert.deepEqual(probe.snapshot(), {
      initializedAtMs: 0,
      lastPollStartedAtMs: 1,
      lastPollSucceededAtMs: null,
      successfulPollCount: 0,
      inFlight: false,
      failedPollCount: 2,
    });
  });

  it("returns immutable snapshots containing no token, payload, or response", async () => {
    const secret = "synthetic-secret-token";
    const payload = { offset: 42, timeout: 30, marker: secret };
    const probe = createPollProgressProbe(() => 5);
    await probe.transformer(
      (async () => ({ ok: true, result: [{ update_id: 42, marker: secret }] })) as never,
      "getUpdates",
      payload,
    );
    const result = probe.snapshot();
    assert.equal(Object.isFrozen(result), true);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
    assert.equal("payload" in result, false);
    assert.equal("response" in result, false);
  });
});
