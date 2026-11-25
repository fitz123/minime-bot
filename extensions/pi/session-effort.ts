import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE } from "../../src/pi-extensions/acknowledged-steer.js";
import { applySessionEffort, getSessionEffort } from "../../src/pi-extensions/session-effort.js";
import {
  SESSION_EFFORT_ENV, SESSION_EFFORT_COMMAND, SESSION_EFFORT_ACK_COMMAND,
  effortNotice, type EffortCommandRequest, type SessionEffortStartup,
} from "../../src/session-effort-wire.js";

export default function sessionEffort(pi: ExtensionAPI): void {
  const initial = process.env[SESSION_EFFORT_ENV];
  const routedAgent = process.env.MINIME_BOT_PI_SESSION_AGENT_ID;
  if (!initial || !routedAgent) return;
  const agentId = routedAgent;
  const startup = JSON.parse(initial) as SessionEffortStartup;
  const state = { configured: startup, override: startup.override };
  const pending = new Map<string, (result: { text: string; ok: boolean }) => void>();

  const sync = (ctx: ExtensionContext) => {
    const level = getSessionEffort(pi, ctx, agentId, state).effective;
    if (level !== pi.getThinkingLevel()) pi.setThinkingLevel(level);
  };
  pi.on("session_start", (_event, ctx) => sync(ctx));
  // Pi awaits message hooks before preparing the native request.
  pi.on("message_start", (event, ctx) => {
    const message = event.message;
    if (message.role === "user" ||
      (message.role === "custom" && message.customType === PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE)) sync(ctx);
  });
  if (startup.readOnly) return;

  pi.registerCommand(SESSION_EFFORT_COMMAND, {
    description: "Control reasoning effort for this Telegram conversation",
    handler: async (args, ctx) => {
      const request = JSON.parse(Buffer.from(args, "base64url").toString()) as EffortCommandRequest;
      if (!request.id) return;
      ctx.ui.notify(effortNotice(applySessionEffort(pi, ctx, agentId, state, request)), "info");
    },
  });
  pi.registerCommand(SESSION_EFFORT_ACK_COMMAND, {
    description: "Acknowledge current-session effort persistence",
    handler: async args => {
      const result = JSON.parse(Buffer.from(args, "base64url").toString()) as { id: string; text: string; ok: boolean };
      pending.get(result.id)?.(result);
    },
  });
  pi.registerTool({
    name: "set_session_effort",
    label: "Control reasoning effort",
    description: "Show effective effort and supported levels, or change effort when the user explicitly asks. A level sets this conversation's override. Use inherit to remove it. Use scope default with a level to change the routed agent's default for the current model from a private DM.",
    parameters: Type.Object({
      level: Type.Optional(Type.String({ description: "A supported level or inherit. Omit to show current effort." })),
      scope: Type.Optional(Type.Union([Type.Literal("conversation"), Type.Literal("default")])),
    }),
    execute: async (_id, { level, scope }, _signal, _update, ctx) => {
      const id = randomUUID();
      const requested = level?.trim() ?? "";
      if (/\s/.test(requested)) {
        return { content: [{ type: "text", text: "Use a single effort level. Omit the level to see what this model supports." }], details: { ok: false }, isError: true };
      }
      const value = scope === "default" ? `default ${requested}` : requested;
      const result = await new Promise<{ text: string; ok: boolean }>(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, text: "Effort change was not confirmed. Check /effort before retrying." }); }, 10_000);
        pending.set(id, answer => { clearTimeout(timer); pending.delete(id); resolve(answer); });
        ctx.ui.notify(effortNotice({ kind: "request", id, value }), "info");
      });
      return { content: [{ type: "text", text: result.text }], details: { ok: result.ok }, isError: !result.ok };
    },
  });
}
