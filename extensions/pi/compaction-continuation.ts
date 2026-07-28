import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_ACKNOWLEDGED_STEER_RESULT_EVENT } from "../../src/pi-extensions/acknowledged-steer.js";
import {
  PI_COMPACTION_CONTINUATION_CONTENT,
  PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
  PiCompactionContinuationGate,
} from "../../src/pi-extensions/compaction-continuation.js";

export default function compactionContinuationExtension(
  pi: ExtensionAPI,
): void {
  const gate = new PiCompactionContinuationGate();
  const pendingAcknowledgedSteers = new Set<string>();
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
    pi.sendMessage(
      {
        customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
        content: PI_COMPACTION_CONTINUATION_CONTENT,
        display: false,
      },
      { deliverAs: "followUp" },
    );
  });
  pi.on("agent_settled", () => {
    gate.clear();
    pendingAcknowledgedSteers.clear();
  });
  pi.on("session_shutdown", () => {
    gate.clear();
    pendingAcknowledgedSteers.clear();
    stopListeningForSteers();
  });
}
