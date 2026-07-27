import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateSummary } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  Model,
  Models,
  RetryCallbacks,
  RetryPolicy,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const TEST_MODEL: Model<"openai-responses"> = {
  id: "summary-test-model",
  name: "Summary Test Model",
  api: "openai-responses",
  provider: "test-provider",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 32_000,
  maxTokens: 4_096,
};

const ZERO_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

function assistantMessage(
  stopReason: AssistantMessage["stopReason"],
  text = "",
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: text.length > 0 ? [{ type: "text", text }] : [],
    api: TEST_MODEL.api,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    usage: ZERO_USAGE,
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

interface SummaryHarness {
  models: Models;
  calls: () => number;
  options: SimpleStreamOptions[];
}

function summaryHarness(
  produce: (call: number) => AssistantMessage | Promise<AssistantMessage>,
): SummaryHarness {
  let calls = 0;
  const options: SimpleStreamOptions[] = [];
  const models = {
    async completeSimple(
      _model: Model<"openai-responses">,
      _context: unknown,
      requestOptions: SimpleStreamOptions = {},
    ): Promise<AssistantMessage> {
      calls += 1;
      options.push(requestOptions);
      return produce(calls);
    },
  } as unknown as Models;
  return { models, calls: () => calls, options };
}

function retryPolicy(maxRetries: number, baseDelayMs = 1): RetryPolicy {
  return { enabled: true, maxRetries, baseDelayMs };
}

async function runSummary(
  models: Models,
  retry: RetryPolicy,
  callbacks: RetryCallbacks,
  signal?: AbortSignal,
) {
  return generateSummary(
    [{ role: "user", content: "Summarize this deterministic fixture.", timestamp: 1 }],
    models,
    TEST_MODEL,
    1_000,
    signal,
    undefined,
    undefined,
    undefined,
    retry,
    callbacks,
  );
}

describe("Pi 0.82.1 compaction summarization retry", () => {
  it("retries one WebSocket error and produces one successful summary", async () => {
    const harness = summaryHarness((call) =>
      call === 1
        ? assistantMessage("error", "", "WebSocket error: connection closed")
        : assistantMessage("stop", "single recovered summary"));
    const scheduled: Array<[number, number, number, string]> = [];
    let attemptStarts = 0;
    const finished: Array<[boolean, number, string | undefined]> = [];

    const result = await runSummary(harness.models, retryPolicy(1), {
      onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
        scheduled.push([attempt, maxAttempts, delayMs, errorMessage]);
      },
      onRetryAttemptStart: () => {
        attemptStarts += 1;
      },
      onRetryFinished: (success, attempt, finalError) => {
        finished.push([success, attempt, finalError]);
      },
    });

    assert.strictEqual(result.ok, true);
    if (!result.ok) return;
    assert.strictEqual(result.value, "single recovered summary");
    assert.strictEqual(harness.calls(), 2);
    assert.deepStrictEqual(scheduled, [
      [1, 1, 1, "WebSocket error: connection closed"],
    ]);
    assert.strictEqual(attemptStarts, 1);
    assert.deepStrictEqual(finished, [[true, 1, undefined]]);
    assert.ok(harness.options.every((options) => options.cacheRetention === "none"));
    assert.ok(harness.options.every((options) => typeof options.sessionId === "string"));
    assert.strictEqual(
      new Set(harness.options.map((options) => options.sessionId)).size,
      1,
      "the isolated summarization request identity remains stable across its retry",
    );
  });

  it("stops after the configured retry budget is exhausted", async () => {
    const harness = summaryHarness(() =>
      assistantMessage("error", "", "WebSocket error: connection closed"));
    const scheduled: number[] = [];
    let attemptStarts = 0;
    const finished: Array<[boolean, number, string | undefined]> = [];

    const result = await runSummary(harness.models, retryPolicy(2), {
      onRetryScheduled: (attempt) => {
        scheduled.push(attempt);
      },
      onRetryAttemptStart: () => {
        attemptStarts += 1;
      },
      onRetryFinished: (success, attempt, finalError) => {
        finished.push([success, attempt, finalError]);
      },
    });

    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.error.code, "summarization_failed");
    assert.match(result.error.message, /WebSocket error: connection closed/);
    assert.strictEqual(harness.calls(), 3, "one initial call plus two bounded retries");
    assert.deepStrictEqual(scheduled, [1, 2]);
    assert.strictEqual(attemptStarts, 2);
    assert.deepStrictEqual(finished, [
      [false, 2, "WebSocket error: connection closed"],
    ]);
  });

  it("does not retry a quota or billing failure", async () => {
    const harness = summaryHarness(() =>
      assistantMessage("error", "", "insufficient_quota: billing limit reached"));
    let callbackCount = 0;

    const result = await runSummary(harness.models, retryPolicy(3), {
      onRetryScheduled: () => {
        callbackCount += 1;
      },
      onRetryAttemptStart: () => {
        callbackCount += 1;
      },
      onRetryFinished: () => {
        callbackCount += 1;
      },
    });

    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.error.code, "summarization_failed");
    assert.match(result.error.message, /insufficient_quota/);
    assert.strictEqual(harness.calls(), 1);
    assert.strictEqual(callbackCount, 0, "no retry lifecycle starts for terminal quota errors");
  });

  it("aborts during retry backoff without starting another call", async () => {
    const controller = new AbortController();
    const harness = summaryHarness(() =>
      assistantMessage("error", "", "WebSocket error: connection closed"));
    let attemptStarts = 0;
    const finished: Array<[boolean, number, string | undefined]> = [];

    const result = await runSummary(harness.models, retryPolicy(3, 50), {
      onRetryScheduled: () => {
        controller.abort();
      },
      onRetryAttemptStart: () => {
        attemptStarts += 1;
      },
      onRetryFinished: (success, attempt, finalError) => {
        finished.push([success, attempt, finalError]);
      },
    }, controller.signal);

    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.error.code, "aborted");
    assert.match(result.error.message, /Summarization aborted/);
    assert.strictEqual(harness.calls(), 1);
    assert.strictEqual(attemptStarts, 0);
    assert.deepStrictEqual(finished, [
      [false, 1, "WebSocket error: connection closed"],
    ]);
  });
});
