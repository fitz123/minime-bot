/**
 * Ask Agent Pi extension wrapper.
 *
 * Registers the model-callable ask-agent tool and delegates all validation,
 * policy checks, and result shaping to the pure helper under src/pi-extensions.
 */

import { spawn } from "node:child_process";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../../src/config.js";
import { assemblePiContext } from "../../../src/pi-context-assembler.js";
import {
  buildPiAskAgentChildSpawnEnv,
  resolvePiAskAgentChildExtensionArgs,
} from "../../../src/pi-rpc-protocol.js";
import {
  ASK_AGENT_TOOL,
  executeAskAgent,
  formatAskAgentChildWarn,
  formatAskAgentExecutionLog,
  formatAskAgentToolResult,
  makeAskAgentError,
  runAskAgentTargetChild,
  type AskAgentToolDetails,
} from "../../../src/pi-extensions/ask-agent-args.js";
import { resolvePiInvocation } from "../../../src/pi-extensions/pi-invocation.js";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    ...ASK_AGENT_TOOL,
    execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
      const startedAt = Date.now();
      let config;
      try {
        config = loadConfig(undefined, { resolveSecrets: false });
      } catch {
        // eslint-disable-next-line no-console -- structured metadata-only ask-agent execution log
        console.warn(formatAskAgentExecutionLog({
          durationMs: Date.now() - startedAt,
          outcome: "error",
          errorCode: "config_unavailable",
        }));
        return formatAskAgentToolResult(
          makeAskAgentError("config_unavailable", "ask-agent configuration is unavailable"),
        ) as AgentToolResult<AskAgentToolDetails>;
      }
      return formatAskAgentToolResult(
        await executeAskAgent(params ?? {}, {
          config,
          env: process.env,
          assembleContext: assemblePiContext,
          runTarget: (request) => runAskAgentTargetChild(request, {
            spawn,
            resolveInvocation: resolvePiInvocation,
            extensionArgs: resolvePiAskAgentChildExtensionArgs({
              extraExtensions: config.piExtraExtensions,
            }),
            env: buildPiAskAgentChildSpawnEnv(request.target.workspaceCwd),
            warn: (event) => {
              // eslint-disable-next-line no-console -- structured metadata-only warn for the Pi session
              console.warn(formatAskAgentChildWarn(event));
            },
          }),
          signal,
          log: (event) => {
            // eslint-disable-next-line no-console -- structured metadata-only ask-agent execution log
            console.warn(formatAskAgentExecutionLog(event));
          },
        }),
      ) as AgentToolResult<AskAgentToolDetails>;
    },
  });
}
