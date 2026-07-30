/**
 * Ops-worker-only output-token ceiling for tool-free conversational turns.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  OPS_WORKER_CONVERSATION_BOUNDS_FAILURE_EXIT_CODE,
  boundOpsWorkerConversationProviderPayload,
} from "../../src/pi-extensions/ops-worker-conversation-bounds.js";

export default function (pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    try {
      const api = ctx.model?.api;
      if (typeof api !== "string" || api === "") {
        throw new TypeError("Conversation provider model has no API identity");
      }
      return boundOpsWorkerConversationProviderPayload(event.payload, api);
    } catch {
      // Pi contains extension handler failures and would otherwise continue
      // with an unbounded provider request.
      process.exit(OPS_WORKER_CONVERSATION_BOUNDS_FAILURE_EXIT_CODE);
    }
  });
}
