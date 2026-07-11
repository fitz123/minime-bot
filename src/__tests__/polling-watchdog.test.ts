import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import client from "prom-client";
import { createWatchdog } from "../polling-watchdog.js";
import type { PollProgressSnapshot } from "../poll-progress.js";
import { pollWatchdogChecks, pollWatchdogRestarts } from "../metrics.js";

function snapshot(overrides: Partial<PollProgressSnapshot> = {}): PollProgressSnapshot {
  return {
    initializedAtMs: 0,
    lastPollStartedAtMs: null,
    lastPollSucceededAtMs: null,
    successfulPollCount: 0,
    inFlight: false,
    failedPollCount: 0,
    ...overrides,
  };
}

function immediateTimeout(callback: () => void): ReturnType<typeof setTimeout> {
  callback();
  return {} as ReturnType<typeof setTimeout>;
}

beforeEach(() => client.register.resetMetrics());

describe("polling-watchdog", () => {
  it("keeps at least 60 minutes of successful empty polling healthy", async () => {
    let clock = 0;
    let progress = snapshot();
    let exits = 0;
    let heartbeats = 0;
    const wd = createWatchdog({
      pollProgress: () => progress,
      heartbeat: async () => { heartbeats++; return true; },
      exit: () => { exits++; },
      now: () => clock,
      thresholdMs: 90_000,
    });

    for (let minute = 1; minute <= 60; minute++) {
      // Two empty getUpdates responses complete per minute. No update touch.
      clock = minute * 60_000 - 30_000;
      progress = snapshot({
        lastPollStartedAtMs: clock - 30_000,
        lastPollSucceededAtMs: clock,
        successfulPollCount: minute * 2 - 1,
      });
      clock = minute * 60_000;
      progress = { ...progress, lastPollStartedAtMs: clock - 30_000, lastPollSucceededAtMs: clock, successfulPollCount: minute * 2 };
      await wd.check();
    }

    assert.equal(exits, 0);
    assert.equal(heartbeats, 0);
    const checks = await pollWatchdogChecks.get();
    assert.equal(checks.values.find((v) => v.labels.outcome === "healthy_quiet")?.value, 59);
  });

  it("restarts exactly once with poll_stalled when API is reachable", async () => {
    let clock = 0;
    let exits = 0;
    let heartbeatCalls = 0;
    const progress = snapshot({ lastPollStartedAtMs: 1_000, inFlight: true });
    const wd = createWatchdog({
      pollProgress: () => progress,
      heartbeat: async () => { heartbeatCalls++; return true; },
      exit: () => { exits++; },
      now: () => clock,
      thresholdMs: 5_000,
    });

    clock = 6_000;

    await wd.check();
    clock += 10_000;
    await wd.check();

    assert.equal(exits, 1);
    assert.equal(heartbeatCalls, 1);
    const restarts = await pollWatchdogRestarts.get();
    assert.equal(restarts.values.find((v) => v.labels.reason === "poll_stalled")?.value, 1);
  });

  for (const failure of ["false", "throw"] as const) {
    it(`restarts exactly once with api_unreachable when heartbeat returns ${failure}`, async () => {
      let clock = 0;
      let exits = 0;
      let calls = 0;
      const wd = createWatchdog({
        pollProgress: () => snapshot(),
        heartbeat: async () => {
          calls++;
          if (failure === "throw") throw new Error("synthetic network failure");
          return false;
        },
        exit: () => { exits++; },
        now: () => clock,
        thresholdMs: 5_000,
      });

      clock = 6_000;
      await wd.check();
      await wd.check();
      assert.equal(exits, 1);
      assert.equal(calls, 1);
      const restarts = await pollWatchdogRestarts.get();
      assert.equal(restarts.values.find((v) => v.labels.reason === "api_unreachable")?.value, 1);
    });
  }

  it("bounds a hung heartbeat and emits one api_unreachable decision", async () => {
    let clock = 0;
    let exits = 0;
    let aborted = false;
    const wd = createWatchdog({
      pollProgress: () => snapshot(),
      heartbeat: (signal) => {
        aborted = signal.aborted;
        signal.addEventListener("abort", () => { aborted = true; });
        return new Promise<boolean>(() => {});
      },
      exit: () => { exits++; },
      now: () => clock,
      thresholdMs: 5_000,
      setTimeoutFn: immediateTimeout,
      clearTimeoutFn: () => {},
    });

    clock = 6_000;
    await wd.check();
    await wd.check();
    assert.equal(aborted, true);
    assert.equal(exits, 1);
  });

  it("detects hung and rejected polls, but accepts resumed polling", async () => {
    let clock = 0;
    let progress = snapshot({ lastPollStartedAtMs: 1_000, inFlight: true });
    let exits = 0;
    const wd = createWatchdog({
      pollProgress: () => progress,
      heartbeat: async () => {
        // Polling resumes while reachability is being checked.
        progress = snapshot({
          lastPollStartedAtMs: clock,
          lastPollSucceededAtMs: clock,
          successfulPollCount: 1,
          failedPollCount: 1,
        });
        return true;
      },
      exit: () => { exits++; },
      now: () => clock,
      thresholdMs: 5_000,
    });

    clock = 6_000;
    await wd.check();
    assert.equal(exits, 0);
    clock = 10_000;
    await wd.check();
    assert.equal(exits, 0);
    const checks = await pollWatchdogChecks.get();
    assert.equal(checks.values.find((v) => v.labels.outcome === "poll_resumed")?.value, 1);
  });

  it("does not treat a real incoming update as poll progress", async () => {
    let clock = 0;
    let exits = 0;
    let progress = snapshot();
    const wd = createWatchdog({
      pollProgress: () => progress,
      heartbeat: async () => true,
      exit: () => { exits++; },
      now: () => clock,
      thresholdMs: 5_000,
    });

    clock = 6_000;
    wd.touch();
    await wd.check();
    assert.equal(exits, 1, "touch must not mask a stale poll");

    // A separate healthy watchdog remains healthy with or without activity.
    exits = 0;
    clock = 12_000;
    progress = snapshot({ lastPollSucceededAtMs: 12_000, successfulPollCount: 1 });
    const healthy = createWatchdog({
      pollProgress: () => progress,
      heartbeat: async () => false,
      exit: () => { exits++; },
      now: () => clock,
      thresholdMs: 5_000,
    });
    healthy.touch();
    await healthy.check();
    assert.equal(exits, 0);
  });

  it("allows a long-running agent turn while getUpdates keeps completing", async () => {
    let clock = 0;
    let progress = snapshot();
    let exits = 0;
    const wd = createWatchdog({
      pollProgress: () => progress,
      heartbeat: async () => false,
      exit: () => { exits++; },
      now: () => clock,
      thresholdMs: 90_000,
    });

    wd.touch(); // The update that starts the long-running turn.
    for (let minute = 1; minute <= 20; minute++) {
      clock = minute * 60_000;
      progress = snapshot({ lastPollSucceededAtMs: clock, successfulPollCount: minute * 2 });
      await wd.check();
    }
    assert.equal(exits, 0);
  });

  it("suppresses overlapping and post-decision checks", async () => {
    let clock = 0;
    let resolveHeartbeat!: (value: boolean) => void;
    const heartbeat = new Promise<boolean>((resolve) => { resolveHeartbeat = resolve; });
    let calls = 0;
    let exits = 0;
    const wd = createWatchdog({
      pollProgress: () => snapshot(),
      heartbeat: async () => { calls++; return heartbeat; },
      exit: () => { exits++; },
      now: () => clock,
      thresholdMs: 5_000,
    });

    clock = 6_000;
    const first = wd.check();
    await wd.check();
    resolveHeartbeat(true);
    await first;
    await wd.check();

    assert.equal(calls, 1);
    assert.equal(exits, 1);
    const checks = await pollWatchdogChecks.get();
    assert.equal(checks.values.find((v) => v.labels.outcome === "overlap_suppressed")?.value, 1);
  });

  it("starts and stops idempotently", () => {
    const wd = createWatchdog({
      pollProgress: () => snapshot(),
      heartbeat: async () => true,
      intervalMs: 100_000,
    });
    wd.start();
    wd.start();
    wd.stop();
    wd.stop();
  });
});
