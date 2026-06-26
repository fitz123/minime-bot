/**
 * Ask Agent Pi extension wrapper.
 *
 * Registers the model-callable ask-agent tool and delegates all validation,
 * policy checks, and result shaping to the pure helper under src/pi-extensions.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../../src/config.js";
import { assemblePiContext } from "../../../src/pi-context-assembler.js";
import {
  ASK_AGENT_TOOL,
  executeAskAgent,
  formatAskAgentToolResult,
  makeAskAgentError,
  type AskAgentToolDetails,
} from "../../../src/pi-extensions/ask-agent-args.js";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    ...ASK_AGENT_TOOL,
    execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
      try {
        const config = loadConfig(undefined, { resolveSecrets: false });
        return formatAskAgentToolResult(
          await executeAskAgent(params ?? {}, {
            config,
            env: process.env,
            assembleContext: assemblePiContext,
            signal,
          }),
        ) as AgentToolResult<AskAgentToolDetails>;
      } catch {
        return formatAskAgentToolResult(
          makeAskAgentError("config_unavailable", "ask-agent configuration is unavailable"),
        ) as AgentToolResult<AskAgentToolDetails>;
      }
    },
  });
}
