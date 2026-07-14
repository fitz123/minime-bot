/** Terminating recovery_plan Pi extension wrapper. */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  executeRecoveryPlanTool,
  RECOVERY_PLAN_TOOL,
  type RecoveryPlanToolState,
} from "../../src/pi-extensions/recovery-plan.js";

export default function (pi: ExtensionAPI): void {
  const state: RecoveryPlanToolState = { accepted: false };
  pi.registerTool({
    ...RECOVERY_PLAN_TOOL,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: { shutdown(): void },
    ) => executeRecoveryPlanTool(params, state, () => ctx.shutdown()) as AgentToolResult<
      ReturnType<typeof executeRecoveryPlanTool>["details"]
    >,
  });
}
