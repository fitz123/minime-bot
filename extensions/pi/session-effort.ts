import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { resolveCliModel, type ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiThinkingLevel } from "../../src/types.js";
import {
  SESSION_EFFORT_ENV, SESSION_EFFORT_COMMAND, SESSION_EFFORT_ACK_COMMAND,
  effortDefaultPath, effortNotice, readEffortDefault, writeEffortDefault,
  type EffortRequestAction, type EffortSource,
} from "../../src/pi-extensions/session-effort.js";

export default function sessionEffort(pi: ExtensionAPI): void {
  const initial = process.env[SESSION_EFFORT_ENV];
  const routedAgent = process.env.MINIME_BOT_PI_SESSION_AGENT_ID;
  if (!initial || !routedAgent) return;
  const agentId = routedAgent;
  const startup = JSON.parse(initial) as { model?: string; inherited?: PiThinkingLevel; override?: PiThinkingLevel };
  let override = startup.override;
  const pending = new Map<string, (result: { text: string; ok: boolean }) => void>();

  function effective(ctx: ExtensionContext, configured = startup): { effective: PiThinkingLevel; source: EffortSource } {
    const model = ctx.model;
    if (!model) return { effective: pi.getThinkingLevel(), source: "Pi default" };
    if (override !== undefined) return { effective: clampThinkingLevel(model, override), source: "conversation override" };
    const saved = readEffortDefault(effortDefaultPath(agentId, model));
    const level = getSupportedThinkingLevels(model).find(candidate => candidate === saved);
    if (level !== undefined) return { effective: level, source: "agent default" };

    // Preserve native CLI suffix resolution, including model IDs that contain a colon.
    // On resume Pi can restore an old thinking entry, so recover the baseline from configuration.
    const runtime: Pick<ModelRuntime, "getModels" | "hasConfiguredAuth"> = {
      getModels: () => ctx.modelRegistry.getAll(),
      hasConfiguredAuth: provider => ctx.modelRegistry.getAll().some(candidate => candidate.provider === provider && ctx.modelRegistry.hasConfiguredAuth(candidate)),
    };
    const cli = configured.model && resolveCliModel({ cliModel: configured.model, cliThinking: configured.inherited, modelRuntime: runtime as ModelRuntime });
    if (!cli || (cli.model?.provider === model.provider && cli.model.id === model.id)) {
      const inherited = configured.inherited ?? (cli ? cli.thinkingLevel : undefined);
      if (inherited !== undefined) return { effective: clampThinkingLevel(model, inherited), source: "agent configuration" };
    }
    const settings = pi.getSettings();
    const native = settings.modelThinkingLevels?.[`${model.provider}/${model.id}`] ?? settings.defaultThinkingLevel ?? "medium";
    return { effective: clampThinkingLevel(model, native), source: "Pi default" };
  }

  const sync = (ctx: ExtensionContext) => {
    const level = effective(ctx).effective;
    if (level !== pi.getThinkingLevel()) pi.setThinkingLevel(level);
  };
  pi.on("session_start", (_event, ctx) => sync(ctx));
  // Pi awaits user message hooks before preparing the native request, including
  // queued steering and follow-up messages inside an existing run.
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === "user") sync(ctx);
  });

  pi.registerCommand(SESSION_EFFORT_COMMAND, {
    description: "Control reasoning effort for this Telegram conversation",
    handler: async (args, ctx) => {
      const request = JSON.parse(Buffer.from(args, "base64url").toString()) as {
        id: string; action: EffortRequestAction; inherited?: PiThinkingLevel; model?: string;
      };
      if (!request.id) return;
      const { action } = request;
      const model = ctx.model;
      const levels = model ? getSupportedThinkingLevels(model) : [];
      const previousOverride = override;
      let result = { effective: pi.getThinkingLevel(), source: "Pi default" as EffortSource };
      let error: string | undefined;
      try {
        if (action.kind === "default" || action.kind === "override") {
          const level = levels.find(candidate => candidate === action.level);
          if (!model || level === undefined) {
            error = model ? `This model does not support ${action.level}.` : "No current model is available.";
          } else if (action.kind === "default") {
            writeEffortDefault(effortDefaultPath(agentId, model), level);
          } else {
            override = level;
          }
        } else if (action.kind !== "status") {
          override = action.kind === "restore" ? action.level : undefined;
        }
        const configured = request.model === undefined ? startup : request;
        result = effective(ctx, configured);
        if (!error && action.kind !== "status" && action.kind !== "default") {
          pi.setThinkingLevel(result.effective);
        }
      } catch {
        override = previousOverride;
        error = "Could not apply effort. Check the control workspace permissions and retry.";
      }
      ctx.ui.notify(effortNotice({ kind: "result", id: request.id, ...result, levels, ...(error ? { error } : {}) }), "info");
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
