/**
 * A2 — web-tools (Tavily) Pi extension wrapper.
 *
 * Thin, jiti-loaded wrapper (intentionally OUTSIDE `src`, so excluded from
 * `tsc --noEmit` and the `npm test` glob — see `src/pi-extensions/README.md`).
 * All request/parse/error logic lives in the unit-tested pure helper `tavily.ts`;
 * this file only:
 *  1. obtains the control-workspace Tavily API key for this Pi process — warn-logs if absent;
 *  2. registers the `web_search` + `web_fetch` tools so the model can call them;
 *  3. delegates each `execute` to the pure helper and returns its `text`.
 *
 * Loaded into every `pi --mode rpc` spawn via `--extension` (see
 * `resolvePiExtensionArgs` in `src/pi-rpc-protocol.ts`). Disable the whole
 * extension set with `PI_EXTENSIONS_DISABLED=1`.
 *
 * Graceful by contract: a missing key does NOT prevent registration — the tools
 * stay model-callable and return a clear "unavailable" result (no throw), so the
 * Pi session never crashes over a web tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  executeWebFetch,
  executeWebSearch,
  formatTavilyWarn,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  type RunToolDeps,
  type TavilyWarn,
  type WebToolResult,
} from "../../src/pi-extensions/tavily.js";
import { writeTavilyChildEvent } from "../../src/pi-extensions/tavily-events.js";
import {
  readTavilyApiKeyFromSops,
  tavilyControlWorkspaceRoot,
} from "../../src/pi-extensions/tavily-secret.js";

/** Read the Tavily key for this Pi process; returns undefined if absent. */
function readTavilyApiKey(): string | undefined {
  return readTavilyApiKeyFromSops();
}

export default function (pi: ExtensionAPI): void {
  const apiKey = readTavilyApiKey();
  const controlWorkspaceRoot = tavilyControlWorkspaceRoot();

  const warn = (event: TavilyWarn): void => {
    // eslint-disable-next-line no-console -- structured warn-log for the Pi session
    console.warn(formatTavilyWarn(event));
  };

  if (!apiKey) {
    warn({
      tool: "web_search",
      reason: "missing-key",
      classification: "credential_missing",
    });
  }

  const deps: RunToolDeps = { apiKey, fetchImpl: fetch, warn };

  const persistFailure = (
    tool: "web_search" | "web_fetch",
    result: WebToolResult,
  ): void => {
    if (!controlWorkspaceRoot || !result.failure) return;
    try {
      writeTavilyChildEvent(controlWorkspaceRoot, tool, result.failure);
    } catch {
      warn({ tool, reason: "event-write-failed", classification: result.failure.classification });
    }
  };

  // Pi's tool `execute` signature is `(toolCallId, params, signal, onUpdate, ctx)`
  // and it MUST resolve to an `AgentToolResult` (`{ content, details }`), NOT a
  // bare string — see the vendor `subagent/index.ts` and the
  // `@earendil-works/pi-coding-agent` `ToolDefinition` type. The actual tool
  // arguments are the SECOND positional (`params`); the first is the tool-call id.
  pi.registerTool({
    ...WEB_SEARCH_TOOL,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const result = await executeWebSearch(params ?? {}, deps, signal);
      persistFailure("web_search", result);
      return { content: [{ type: "text" as const, text: result.text }], details: { ok: result.ok } };
    },
  });

  pi.registerTool({
    ...WEB_FETCH_TOOL,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      const result = await executeWebFetch(params ?? {}, deps, signal);
      persistFailure("web_fetch", result);
      return { content: [{ type: "text" as const, text: result.text }], details: { ok: result.ok } };
    },
  });
}
