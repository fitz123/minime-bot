import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  PI_ACKNOWLEDGED_STEER_COMMAND,
  PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE,
  buildPiAcknowledgedSteerResultNotice,
  parsePiAcknowledgedSteerEnvelope,
} from "../../src/pi-extensions/acknowledged-steer.js";

function emitResult(
  ctx: ExtensionContext,
  id: string,
  success: boolean,
): void {
  ctx.ui.notify(buildPiAcknowledgedSteerResultNotice(id, success), "info");
}

export default function acknowledgedSteerExtension(pi: ExtensionAPI): void {
  let steeringOpen = false;

  pi.on("agent_start", () => {
    steeringOpen = true;
  });
  pi.on("agent_end", () => {
    steeringOpen = false;
  });
  pi.on("agent_settled", () => {
    steeringOpen = false;
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (
      message.role !== "custom" ||
      message.customType !== PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE
    ) {
      return;
    }
    const requestId = (
      message.details as { requestId?: unknown } | undefined
    )?.requestId;
    if (typeof requestId === "string" && requestId.length > 0) {
      emitResult(ctx, requestId, true);
    }
  });

  pi.registerCommand(PI_ACKNOWLEDGED_STEER_COMMAND, {
    description: "Atomically enqueue a correlated Minime steering message",
    handler: async (args, ctx) => {
      const envelope = parsePiAcknowledgedSteerEnvelope(args);
      if (!envelope) return;

      if (!steeringOpen || ctx.isIdle()) {
        emitResult(ctx, envelope.id, false);
        return;
      }

      // sendMessage() enters AgentSession synchronously through its first-party
      // extension binding. In the streaming branch it queues this custom message
      // before returning, so no lifecycle transition can occur between the gate
      // above and ownership transfer.
      pi.sendMessage(
        {
          customType: PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE,
          content: envelope.text,
          display: false,
          details: { requestId: envelope.id },
        },
        { deliverAs: "steer" },
      );
    },
  });
}
