import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isCodexTransportMessageTooBigDiagnostic,
  normalizeCodexTransportOverflowAssistantMessage,
} from "../pi-extensions/codex-transport-overflow.js";

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

  it("recognizes string-only WebSocket 1009 message-too-big diagnostics", () => {
    assert.equal(
      isCodexTransportMessageTooBigDiagnostic("WebSocket closed 1009 message too big before stream start"),
      true,
    );

    const message = {
      role: "assistant",
      stopReason: "error",
      errorMessage: "WebSocket closed 1009 message-too-big",
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
});
