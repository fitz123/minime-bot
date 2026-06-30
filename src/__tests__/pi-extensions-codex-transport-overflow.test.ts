import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isCodexTransportMessageTooBigDiagnostic,
  normalizeCodexTransportOverflowAssistantMessage,
} from "../pi-extensions/codex-transport-overflow.js";

type MessageEndHandler = (event: { message: unknown }) => unknown;
type PiWrapper = (pi: { on(eventName: string, handler: MessageEndHandler): void }) => void;

async function loadCodexTransportOverflowWrapper(): Promise<PiWrapper> {
  const wrapperUrl = pathToFileURL(resolve("extensions/pi/codex-transport-overflow.ts"));
  const wrapper = (await import(wrapperUrl.href)) as { default: PiWrapper };
  return wrapper.default;
}

describe("Codex transport overflow normalization", () => {
  it("normalizes assistant error messages with structured WebSocket 1009 details", () => {
    const content = [{ type: "text", text: "partial" }];
    const diagnostics = {
      phase: "before_message_stream_start",
      error: {
        code: 1009,
        message: "WebSocket closed 1009 message too big",
      },
      details: {
        requestBytes: 24800000,
      },
    };
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      content,
      diagnostics,
      extra: "kept",
    };

    const normalized = normalizeCodexTransportOverflowAssistantMessage(message);

    assert.notStrictEqual(normalized, message);
    assert.equal(normalized.content, content);
    assert.equal(normalized.diagnostics, diagnostics);
    assert.equal(normalized.extra, "kept");
    assert.equal(
      normalized.errorMessage,
      "context_length_exceeded: Codex request too large (WebSocket 1009 message too big; requestBytes=24800000)",
    );
  });

  it("normalizes structured WebSocket 1009 request-size diagnostics without message-too-big text", () => {
    const normalized = normalizeCodexTransportOverflowAssistantMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      diagnostics: {
        error: {
          closeCode: "1009",
          message: "transport closed",
        },
        details: {
          requestBytes: "24800000",
        },
      },
      content: [],
    });

    assert.equal(
      normalized.errorMessage,
      "context_length_exceeded: Codex request too large (WebSocket 1009 message too big; requestBytes=24800000)",
    );
  });

  it("leaves explicit post-stream WebSocket 1009 request-size diagnostics unchanged", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      diagnostics: {
        phase: "after_message_stream_start",
        error: {
          closeCode: "1009",
          message: "WebSocket closed 1009 message too big",
        },
        details: {
          requestBytes: 24800000,
        },
      },
      content: [],
    };

    assert.equal(isCodexTransportMessageTooBigDiagnostic(message.diagnostics), false);
    assert.strictEqual(normalizeCodexTransportOverflowAssistantMessage(message), message);
  });

  it("leaves WebSocket 1009 request-size diagnostics unchanged after events were emitted", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      diagnostics: {
        eventsEmitted: true,
        error: {
          code: 1009,
          message: "WebSocket closed 1009 message too big",
        },
        details: {
          requestBytes: "24800000",
        },
      },
      content: [],
    };

    assert.equal(isCodexTransportMessageTooBigDiagnostic(message.diagnostics), false);
    assert.strictEqual(normalizeCodexTransportOverflowAssistantMessage(message), message);
  });

  it("recognizes string-only WebSocket 1009 message-too-big diagnostics", () => {
    assert.equal(
      isCodexTransportMessageTooBigDiagnostic("WebSocket closed 1009 message too big before stream start"),
      true,
    );

    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "WebSocket closed 1009 message-too-big before stream start",
      content: [],
    };

    assert.equal(
      normalizeCodexTransportOverflowAssistantMessage(message).errorMessage,
      "context_length_exceeded: Codex request too large (WebSocket 1009 message too big)",
    );
  });

  it("leaves the generic Codex SSE timeout unchanged without overflow diagnostics", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      content: [],
    };

    assert.equal(isCodexTransportMessageTooBigDiagnostic(message.errorMessage), false);
    assert.strictEqual(normalizeCodexTransportOverflowAssistantMessage(message), message);
  });

  it("leaves WebSocket 1009 message-too-big diagnostics unchanged without a request-side signal", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "WebSocket closed 1009 message too big",
      diagnostics: {
        error: {
          code: 1009,
          message: "WebSocket closed 1009 message too big",
        },
      },
      content: [],
    };

    assert.strictEqual(normalizeCodexTransportOverflowAssistantMessage(message), message);
  });

  it("leaves transient WebSocket errors unchanged without a message-too-big signal", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "WebSocket closed 1006 abnormal closure",
      diagnostics: {
        code: 1006,
        message: "WebSocket disconnected during stream",
      },
      content: [],
    };

    assert.equal(isCodexTransportMessageTooBigDiagnostic(message.diagnostics), false);
    assert.strictEqual(normalizeCodexTransportOverflowAssistantMessage(message), message);
  });

  it("leaves overflow-looking transcript fields unchanged without diagnostic metadata", () => {
    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      content: [{ type: "text", text: "WebSocket closed 1009 message too big before stream start" }],
      messages: [{ content: "WebSocket closed 1009 message too big before stream start" }],
      prompt: "WebSocket closed 1009 message too big before stream start",
      transcript: "WebSocket closed 1009 message too big before stream start",
    };

    assert.strictEqual(normalizeCodexTransportOverflowAssistantMessage(message), message);
  });

  it("formats normalized error text with the root cause for user-facing fallbacks", () => {
    const normalized = normalizeCodexTransportOverflowAssistantMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      diagnostics: "phase=before_message_stream_start WebSocket closed 1009 message too big requestBytes=24800000",
      content: [],
    });

    assert.equal(
      normalized.errorMessage,
      "context_length_exceeded: Codex request too large (WebSocket 1009 message too big; requestBytes=24800000)",
    );
    assert.match(String(normalized.errorMessage), /1009 message too big/);
    assert.doesNotMatch(String(normalized.errorMessage), /SSE response headers timed out/);
  });

  it("leaves non-assistant and non-error messages unchanged", () => {
    const diagnostic = {
      error: {
        code: 1009,
        message: "WebSocket closed 1009 message too big",
      },
    };
    const userMessage = {
      role: "user",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      diagnostics: diagnostic,
      content: [],
    };
    const assistantEndMessage = {
      role: "assistant",
      stopReason: "end",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      diagnostics: diagnostic,
      content: [],
    };

    assert.strictEqual(normalizeCodexTransportOverflowAssistantMessage(userMessage), userMessage);
    assert.strictEqual(normalizeCodexTransportOverflowAssistantMessage(assistantEndMessage), assistantEndMessage);
  });

  it("registers a message_end wrapper that returns a replacement only for normalized messages", async () => {
    const wrapper = await loadCodexTransportOverflowWrapper();
    let registeredEvent: string | undefined;
    let handler: MessageEndHandler | undefined;

    wrapper({
      on(eventName, messageEndHandler) {
        registeredEvent = eventName;
        handler = messageEndHandler;
      },
    });

    assert.equal(registeredEvent, "message_end");
    assert.ok(handler);

    const unchangedMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      content: [],
    };
    assert.equal(handler({ message: unchangedMessage }), undefined);

    const overflowMessage = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "Codex SSE response headers timed out after 20000ms",
      diagnostics: "phase=before_message_stream_start WebSocket closed 1009 message too big requestBytes=24800000",
      content: [],
    };

    const result = handler({ message: overflowMessage }) as { message?: typeof overflowMessage };
    assert.notStrictEqual(result.message, overflowMessage);
    assert.equal(
      result.message?.errorMessage,
      "context_length_exceeded: Codex request too large (WebSocket 1009 message too big; requestBytes=24800000)",
    );
  });
});
