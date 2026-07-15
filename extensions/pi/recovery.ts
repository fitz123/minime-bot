/**
 * Recovery-only Pi extension.
 *
 * This wrapper is never part of the bot's default extension list. The recovery
 * runner loads it explicitly and supplies only the protected fixer credential
 * file path plus a durable invocation fence through the scrubbed child env.
 */

import type {
  ExtensionAPI,
  ToolCallEvent,
  ToolResultEvent,
  UserBashEvent,
  UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  RecoveryProtocolClient,
  RecoveryToolJournal,
  isReadOnlyRecoveryBash,
  readRecoveryRuntimeContract,
} from "../../src/pi-extensions/recovery-protocol.js";

function result(ok: boolean, message: string, details: Record<string, unknown> = {}) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: { ok, ...details },
    isError: !ok,
  };
}

export default function (pi: ExtensionAPI): void {
  // Parse eagerly. A missing or malformed contract aborts extension loading,
  // which makes the recovery spawn fail closed before default tools are usable.
  const contract = readRecoveryRuntimeContract();
  const client = new RecoveryProtocolClient(contract);
  const journal = new RecoveryToolJournal(client);

  pi.on("tool_call", async (event: ToolCallEvent) => journal.before(event));
  pi.on("tool_result", async (event: ToolResultEvent) => journal.after(event));

  // RPC user-bash commands do not expose a toolCallId shared by a post-execution
  // hook, so mutations through that side channel cannot satisfy intent/outcome
  // journaling. Inspection remains available.
  pi.on("user_bash", (event: UserBashEvent): UserBashEventResult | undefined => {
    if (isReadOnlyRecoveryBash(event.command)) return undefined;
    return {
      result: {
        output: "Recovery user-bash mutation is blocked; use the journaled bash tool",
        exitCode: 126,
        cancelled: false,
        truncated: false,
      },
    };
  });

  pi.registerTool({
    name: "recovery_inspect",
    label: "Recovery Inspect",
    description: "Read the authoritative recovery fence, evidence references, session binding, and unresolved actions.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const state = await client.state();
        return result(true, JSON.stringify(state), { state });
      } catch {
        return result(false, "Recovery supervisor inspection is unavailable");
      }
    },
  });

  pi.registerTool({
    name: "recovery_heartbeat",
    label: "Recovery Heartbeat",
    description: "Renew the currently fenced recovery lease after a long inspection or repair step.",
    parameters: Type.Object({}),
    execute: async () => {
      try {
        const ok = await client.heartbeat();
        return result(ok, ok ? "Recovery lease renewed" : "Recovery lease is stale");
      } catch {
        return result(false, "Recovery lease renewal is unavailable");
      }
    },
  });

  pi.registerTool({
    name: "recovery_reconcile",
    label: "Recovery Reconcile",
    description:
      "After inspecting host state, reconcile one unknown prior mutation as applied or not_applied before any new mutation.",
    parameters: Type.Object({
      actionKey: Type.String({ minLength: 1, maxLength: 160 }),
      idempotencyKey: Type.String({ minLength: 1, maxLength: 160 }),
      result: Type.Union([Type.Literal("applied"), Type.Literal("not_applied")]),
      summary: Type.String({ minLength: 1, maxLength: 4_096 }),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const ok = await client.reconcile(
          params.actionKey,
          params.idempotencyKey,
          params.result,
          { summary: params.summary },
        );
        return result(ok, ok ? "Unknown recovery action reconciled" : "Recovery reconciliation was rejected");
      } catch {
        return result(false, "Recovery reconciliation is unavailable");
      }
    },
  });

  pi.registerTool({
    name: "recovery_blocked",
    label: "Recovery Blocked",
    description: "End this fenced invocation as blocked when repair cannot proceed safely.",
    parameters: Type.Object({
      claimKey: Type.String({ minLength: 1, maxLength: 160 }),
      reason: Type.String({ minLength: 1, maxLength: 4_096 }),
      residualRisk: Type.Optional(Type.String({ maxLength: 4_096 })),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const ok = await client.blocked(params.claimKey, params.reason, params.residualRisk);
        return result(ok, ok ? "Recovery invocation recorded as blocked" : "Recovery blocked claim was rejected");
      } catch {
        return result(false, "Recovery blocked claim is unavailable");
      }
    },
  });

  pi.registerTool({
    name: "recovery_finish",
    label: "Recovery Finish",
    description:
      "Submit a structured repair claim. This is only a claim; independent Python probes decide whether recovery succeeded.",
    parameters: Type.Object({
      claimKey: Type.String({ minLength: 1, maxLength: 160 }),
      summary: Type.String({ minLength: 1, maxLength: 8_192 }),
      rootCause: Type.String({ minLength: 1, maxLength: 8_192 }),
      confidence: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
      changedFiles: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 256 }),
      changedServices: Type.Array(Type.String({ maxLength: 256 }), { maxItems: 128 }),
      verification: Type.Array(Type.String({ maxLength: 4_096 }), { maxItems: 256 }),
      residualRisk: Type.String({ maxLength: 8_192 }),
      references: Type.Array(Type.String({ maxLength: 1_024 }), { maxItems: 256 }),
    }),
    execute: async (_toolCallId, params) => {
      const { claimKey, ...claim } = params;
      try {
        const ok = await client.finish(claimKey, claim);
        return result(
          ok,
          ok
            ? "Recovery claim recorded; authoritative verification is pending"
            : "Recovery finish claim was rejected",
        );
      } catch {
        return result(false, "Recovery finish claim is unavailable");
      }
    },
  });
}
