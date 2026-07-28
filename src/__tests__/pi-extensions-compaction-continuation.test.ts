import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PI_COMPACTION_CONTINUATION_CONTENT,
  PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
  isReasoningOnlyLengthAgentEnd,
} from "../pi-extensions/compaction-continuation.js";

type EventHandler = (event: Record<string, unknown>) => void;

async function loadWrapper(): Promise<(pi: ExtensionAPI) => void> {
  const wrapperUrl = pathToFileURL(
    resolve("extensions/pi/compaction-continuation.ts"),
  );
  wrapperUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
  return (await import(wrapperUrl.href)).default as (pi: ExtensionAPI) => void;
}

function createHarness() {
  const handlers = new Map<string, EventHandler[]>();
  const sent: Array<{
    message: Record<string, unknown>;
    options: Record<string, unknown> | undefined;
  }> = [];
  const userMessages: unknown[] = [];

  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    sendMessage(
      message: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) {
      sent.push({ message, options });
    },
    sendUserMessage(message: unknown) {
      userMessages.push(message);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    sent,
    userMessages,
    emit(event: string, payload: Record<string, unknown> = {}) {
      for (const handler of handlers.get(event) ?? []) {
        handler({ type: event, ...payload });
      }
    },
  };
}

function assistant(
  stopReason: string,
  content: unknown[],
): Record<string, unknown> {
  return {
    role: "assistant",
    stopReason,
    content,
  };
}

describe("compaction continuation Pi extension", () => {
  it("recognizes only a final reasoning-only length assistant outcome", () => {
    assert.equal(
      isReasoningOnlyLengthAgentEnd([
        { role: "user", content: "question" },
        assistant("length", [
          { type: "thinking", thinking: "unfinished reasoning" },
          { type: "text", text: " \n\t " },
        ]),
      ]),
      true,
    );

    assert.equal(
      isReasoningOnlyLengthAgentEnd([
        assistant("length", [
          { type: "thinking", thinking: "reasoning" },
          { type: "text", text: "visible answer" },
        ]),
      ]),
      false,
    );
    assert.equal(
      isReasoningOnlyLengthAgentEnd([
        assistant("stop", [{ type: "thinking", thinking: "reasoning" }]),
      ]),
      false,
    );
    assert.equal(
      isReasoningOnlyLengthAgentEnd([
        assistant("length", [{ type: "thinking", thinking: "reasoning" }]),
        assistant("error", []),
      ]),
      false,
    );
    assert.equal(isReasoningOnlyLengthAgentEnd([]), false);
  });

  it("queues exactly one hidden custom follow-up at successful threshold compaction", async () => {
    const wrapper = await loadWrapper();
    const harness = createHarness();
    wrapper(harness.pi);

    const messages = [
      assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
    ];
    harness.emit("agent_end", { messages });
    harness.emit("agent_end", { messages });
    harness.emit("session_before_compact", {
      reason: "threshold",
      willRetry: false,
    });
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });

    assert.deepEqual(harness.sent, [
      {
        message: {
          customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
          content: PI_COMPACTION_CONTINUATION_CONTENT,
          display: false,
        },
        options: { deliverAs: "followUp" },
      },
    ]);
    assert.deepEqual(
      harness.userMessages,
      [],
      "the continuation must remain a custom message, not a synthetic user message",
    );

    harness.emit("agent_settled");
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });
    assert.equal(harness.sent.length, 1);
  });

  it("clears the arm when a later agent outcome does not match", async () => {
    const wrapper = await loadWrapper();
    const harness = createHarness();
    wrapper(harness.pi);

    harness.emit("agent_end", {
      messages: [
        assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
      ],
    });
    harness.emit("agent_end", {
      messages: [
        assistant("length", [{ type: "text", text: "already visible" }]),
      ],
    });
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });

    assert.deepEqual(harness.sent, []);
  });

  it("ignores manual and overflow-retry compaction boundaries", async () => {
    const wrapper = await loadWrapper();

    for (const boundary of [
      { reason: "manual", willRetry: false },
      { reason: "overflow", willRetry: true },
      { reason: "overflow", willRetry: false },
      { reason: "threshold", willRetry: true },
    ]) {
      const harness = createHarness();
      wrapper(harness.pi);
      harness.emit("agent_end", {
        messages: [
          assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
        ],
      });
      harness.emit("session_before_compact", boundary);
      harness.emit("session_compact", boundary);
      harness.emit("session_compact", {
        reason: "threshold",
        willRetry: false,
      });
      assert.deepEqual(harness.sent, [], JSON.stringify(boundary));
    }
  });

  it("does not continue after failed or aborted compaction settles", async () => {
    const wrapper = await loadWrapper();
    const harness = createHarness();
    wrapper(harness.pi);

    harness.emit("agent_end", {
      messages: [
        assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
      ],
    });
    harness.emit("session_before_compact", {
      reason: "threshold",
      willRetry: false,
    });
    harness.emit("agent_settled");
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });

    assert.deepEqual(harness.sent, []);
    assert.deepEqual(harness.userMessages, []);
  });
});
