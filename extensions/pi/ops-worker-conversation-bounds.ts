/**
 * Ops-worker-only output-token ceiling for tool-free conversational turns.
 */

import { Buffer } from "node:buffer";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  OPS_WORKER_CONVERSATION_BOUNDS_FAILURE_EXIT_CODE,
  OPS_WORKER_CONVERSATION_MAX_STREAM_BYTES,
  boundOpsWorkerConversationProviderPayload,
} from "../../src/pi-extensions/ops-worker-conversation-bounds.js";

export default function (pi: ExtensionAPI): void {
  let streamedOutputBytes = 0;
  const failClosed = (abort?: () => void): never => {
    abort?.();
    // Pi contains extension handler failures and would otherwise continue.
    process.exit(OPS_WORKER_CONVERSATION_BOUNDS_FAILURE_EXIT_CODE);
  };

  pi.on("message_start", (event) => {
    if (event.message.role === "assistant") streamedOutputBytes = 0;
  });
  pi.on("message_update", (event, ctx) => {
    const update = event.assistantMessageEvent;
    if (
      update.type !== "text_delta"
      && update.type !== "thinking_delta"
      && update.type !== "toolcall_delta"
    ) return;
    streamedOutputBytes += Buffer.byteLength(update.delta, "utf8");
    if (streamedOutputBytes > OPS_WORKER_CONVERSATION_MAX_STREAM_BYTES) {
      failClosed(() => ctx.abort());
    }
  });
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const api = ctx.model?.api;
      if (typeof api !== "string" || api === "") {
        throw new TypeError("Conversation provider model has no API identity");
      }
      return boundOpsWorkerConversationProviderPayload(event.payload, api);
    } catch {
      failClosed();
    }
  });
}
