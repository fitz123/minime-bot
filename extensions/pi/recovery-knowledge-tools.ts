/** Read-only Knowledge v2 tools for the isolated recovery planner. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  KNOWLEDGE_GET_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  executePiKnowledgeGet,
  executePiKnowledgeSearch,
} from "../../src/pi-extensions/knowledge-tools.js";

function asParams(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

export default function (pi: ExtensionAPI): void {
  const deps = () => ({ cwd: process.cwd(), env: process.env });

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
}
