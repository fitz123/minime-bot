import { randomUUID } from "node:crypto";
import { Type, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiThinkingLevel } from "../../src/types.js";
import { SESSION_EFFORT_ENV, SESSION_EFFORT_COMMAND, SESSION_EFFORT_ACK_COMMAND, effortNotice } from "../../src/pi-extensions/session-effort.js";

export default function sessionEffort(pi: ExtensionAPI): void {
  // Only a Telegram-owned interactive process receives this envelope. Child and
  // cron wrapper lists omit this extension as well.
  const initial = process.env[SESSION_EFFORT_ENV];
  if (!initial) return;
  const startup = JSON.parse(initial) as { inherited?: PiThinkingLevel; override?: PiThinkingLevel };
  const pending = new Map<string, (result: { text: string; ok: boolean }) => void>();
  const inherited = (ctx: ExtensionContext, configured?: PiThinkingLevel): PiThinkingLevel => {
    const settings = pi.getSettings();
    // Same fallback as the pinned native SDK; tested against a fresh SDK session.
    return configured ?? (ctx.model && settings.modelThinkingLevels?.[`${ctx.model.provider}/${ctx.model.id}`])
      ?? settings.defaultThinkingLevel ?? "medium";
  };
  pi.on("session_start", (_event, ctx) => {
    pi.setThinkingLevel(startup.override ?? inherited(ctx, startup.inherited));
  });
  pi.registerCommand(SESSION_EFFORT_COMMAND, {
    description: "Control effort for the current Telegram session",
    handler: async (args, ctx) => {
      const request = JSON.parse(Buffer.from(args, "base64url").toString()) as { id: string; value?: string; inherited?: PiThinkingLevel };
      if (!request.id) return;
      const levels = ctx.model ? getSupportedThinkingLevels(ctx.model) : [];
      const previous = pi.getThinkingLevel();
      let error: string | undefined;
      if (request.value !== undefined) {
        if (request.value !== "default" && !levels.includes(request.value as PiThinkingLevel)) {
          error = `Unsupported effort: ${request.value}.`;
        } else if (!ctx.model) {
          error = "No current model is available.";
        } else {
          pi.setThinkingLevel(request.value === "default" ? inherited(ctx, request.inherited) : request.value as PiThinkingLevel);
          if (request.value !== "default" && pi.getThinkingLevel() !== request.value) error = "Pi did not apply the requested effort.";
        }
      }
      ctx.ui.notify(effortNotice({ kind: "result", id: request.id, previous, effective: pi.getThinkingLevel(), levels, ...(error ? { error } : {}) }), "info");
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
    label: "Set session effort",
    description: "Change reasoning effort only for this Telegram thread, when the user explicitly requests it. Use default to restore inherited configuration. Does not change model or other sessions. Takes effect on the next model request; an in-flight request is unchanged.",
    parameters: Type.Object({ level: Type.String({ description: "Native effort level, or default. Unsupported values return current-model supported levels." }) }),
    execute: async (_id, { level }, _signal, _update, ctx) => {
      const id = randomUUID();
      const result = await new Promise<{ text: string; ok: boolean }>(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, text: "Effort change was not confirmed. Check /effort before retrying." }); }, 10_000);
        pending.set(id, value => { clearTimeout(timer); pending.delete(id); resolve(value); });
        ctx.ui.notify(effortNotice({ kind: "request", id, value: level }), "info");
      });
      return { content: [{ type: "text", text: result.text }], details: { ok: result.ok }, isError: !result.ok };
    },
  });
}
