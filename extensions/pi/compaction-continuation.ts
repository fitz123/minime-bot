import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_ACKNOWLEDGED_STEER_RESULT_EVENT } from "../../src/pi-extensions/acknowledged-steer.js";
import {
  PI_COMPACTION_CONTINUATION_CONTENT,
  PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
  PiCompactionContinuationGate,
} from "../../src/pi-extensions/compaction-continuation.js";

function isContinuationControlMessage(message: {
  role?: unknown;
  customType?: unknown;
}): boolean {
  return (
    (message.role === "custom" || message.role === "bashExecution") &&
    message.customType === PI_COMPACTION_CONTINUATION_CUSTOM_TYPE
  );
}

function discardContinuationQueueMarker(message: object): void {
  // Pi 0.82.1 runs message_end hooks before its role-based persistence step.
  // Keep the empty scheduling marker in the live loop, but classify it as an
  // excluded runtime message so it never becomes a CustomMessageEntry.
  Object.assign(message, {
    role: "bashExecution",
    command: "",
    output: "",
    exitCode: 0,
    cancelled: false,
    truncated: false,
    excludeFromContext: true,
  });
}

export default function compactionContinuationExtension(
  pi: ExtensionAPI,
): void {
  const gate = new PiCompactionContinuationGate();
  const pendingAcknowledgedSteers = new Set<string>();
  let continuationContextPending = false;
  const stopListeningForSteers = pi.events.on(
    PI_ACKNOWLEDGED_STEER_RESULT_EVENT,
    (data) => {
      if (typeof data !== "object" || data === null) {
        return;
      }
      const { id, status } = data as { id?: unknown; status?: unknown };
      if (typeof id !== "string" || id.length === 0) {
        return;
      }
      if (status === "enqueued") {
        pendingAcknowledgedSteers.add(id);
      } else if (status === "consumed" || status === "rejected") {
        pendingAcknowledgedSteers.delete(id);
      }
    },
  );

  pi.on("agent_start", () => {
    gate.clear();
  });
  pi.on("agent_end", (event) => {
    gate.observeAgentEnd(event.messages);
  });
  pi.on("session_before_compact", (event) => {
    gate.observeCompactionStart(event);
  });
  pi.on("session_compact", (event, ctx) => {
    if (!gate.consumeCompaction(event)) {
      return;
    }
    if (ctx.hasPendingMessages() || pendingAcknowledgedSteers.size > 0) {
      return;
    }
    continuationContextPending = true;
    pi.sendMessage(
      {
        customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
        content: [],
        display: false,
      },
      { deliverAs: "followUp" },
    );
  });
  pi.on("message_end", (event) => {
    if (
      event.message.role === "custom" &&
      event.message.customType === PI_COMPACTION_CONTINUATION_CUSTOM_TYPE
    ) {
      discardContinuationQueueMarker(event.message);
    }
  });
  pi.on("context", (event) => {
    const messages = event.messages.filter(
      (message) => !isContinuationControlMessage(message),
    );
    if (continuationContextPending) {
      continuationContextPending = false;
      messages.push({
        role: "custom",
        customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
        content: PI_COMPACTION_CONTINUATION_CONTENT,
        display: false,
        timestamp: Date.now(),
      });
    }
    return { messages };
  });
  pi.on("agent_settled", () => {
    gate.clear();
    pendingAcknowledgedSteers.clear();
    continuationContextPending = false;
  });
  pi.on("session_shutdown", () => {
    gate.clear();
    pendingAcknowledgedSteers.clear();
    continuationContextPending = false;
    stopListeningForSteers();
  });
}
