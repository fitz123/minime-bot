import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  PI_COMPACTION_CONTINUATION_CONTENT,
  PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
  PiCompactionContinuationGate,
} from "../../src/pi-extensions/compaction-continuation.js";

export default function compactionContinuationExtension(
  pi: ExtensionAPI,
): void {
  const gate = new PiCompactionContinuationGate();

  pi.on("agent_start", () => {
    gate.clear();
  });
  pi.on("agent_end", (event) => {
    gate.observeAgentEnd(event.messages);
  });
  pi.on("session_before_compact", (event) => {
    gate.observeCompactionStart(event);
  });
  pi.on("session_compact", (event) => {
    if (!gate.consumeCompaction(event)) {
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
  });
  pi.on("session_shutdown", () => {
    gate.clear();
  });
}
