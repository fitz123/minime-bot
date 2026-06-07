/**
 * Knowledge v2 Pi extension wrapper.
 *
 * Registers the model-callable knowledge_search, knowledge_get, and
 * knowledge_update tools, then blocks direct built-in writes to managed
 * Knowledge v2 wiki files. The protection is active only when the agent
 * workspace is positively detected as Knowledge v2. Setting
 * PI_EXTENSIONS_DISABLED=1 disables this wrapper together with all other
 * first-party Pi wrappers.
 */

import type { ExtensionAPI, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import {
  KNOWLEDGE_GET_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  KNOWLEDGE_UPDATE_TOOL,
  classifyKnowledgeIntegrityToolCall,
  executePiKnowledgeGet,
  executePiKnowledgeSearch,
  executePiKnowledgeUpdate,
} from "../../src/pi-extensions/knowledge-tools.js";

function asParams(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

export default function (pi: ExtensionAPI): void {
  const deps = () => ({
    cwd: process.cwd(),
    env: process.env,
  });

  pi.registerTool({
    ...KNOWLEDGE_SEARCH_TOOL,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = executePiKnowledgeSearch(asParams(params), deps());
      return { content: [{ type: "text" as const, text: result.text }], details: { ok: result.ok } };
    },
  });

  pi.registerTool({
    ...KNOWLEDGE_GET_TOOL,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = executePiKnowledgeGet(asParams(params), deps());
      return { content: [{ type: "text" as const, text: result.text }], details: { ok: result.ok } };
    },
  });

  pi.registerTool({
    ...KNOWLEDGE_UPDATE_TOOL,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const result = executePiKnowledgeUpdate(asParams(params), deps());
      return { content: [{ type: "text" as const, text: result.text }], details: { ok: result.ok } };
    },
  });

  pi.on("tool_call", async (event: ToolCallEvent) => {
    const decision = classifyKnowledgeIntegrityToolCall(event, deps());
    return decision ? { block: true, reason: decision.reason } : undefined;
  });
}
