/**
 * Codex transport overflow normalizer Pi extension wrapper.
 *
 * Rewrites only Codex/OpenAI transport byte-size overflow assistant errors into
 * Pi's recognized context-overflow shape before Pi decides retry vs compaction.
 * It does not register tools and does not log message content or diagnostics.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  normalizeCodexTransportOverflowAssistantMessage,
  type CodexTransportOverflowAssistantMessage,
} from "../../src/pi-extensions/codex-transport-overflow.js";

export default function (pi: ExtensionAPI): void {
  pi.on("message_end", (event) => {
    const message = event.message;
    const normalized = normalizeCodexTransportOverflowAssistantMessage(
      message as unknown as CodexTransportOverflowAssistantMessage,
    );

    if (Object.is(normalized, message)) {
      return undefined;
    }

    return { message: normalized as unknown as typeof message };
  });
}
