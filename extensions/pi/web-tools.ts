/**
 * Canonical Pi wrapper for subscription-backed Codex web search.
 *
 * The pure implementation owns OAuth resolution, the fixed transport, parsing,
 * and bounded failures. This wrapper registers exactly one model-facing tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CODEX_WEB_SEARCH_TOOL,
  executeCodexWebSearch,
  formatCodexWebSearchWarn,
} from "../../src/pi-extensions/codex-web-search.js";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    ...CODEX_WEB_SEARCH_TOOL,
    execute: async (
      _toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ) => {
      const result = await executeCodexWebSearch(params ?? {}, {
        context: ctx,
        fetchImpl: fetch,
        warn: (event) => {
          // Structured and bounded: never includes queries, provider bodies, or credentials.
          console.warn(formatCodexWebSearchWarn(event));
        },
      }, signal);
      const { text, ...details } = result;
      return {
        content: [{ type: "text" as const, text }],
        details,
      };
    },
  });
}
