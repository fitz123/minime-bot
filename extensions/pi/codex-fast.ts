/** Agent/thread-scoped priority requests. Never edits models.json or reasoning. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config.js";
import { formatFastCommandError, handleFastCommand, isFastEligible, PI_FAST_THREAD_ENV, readFastStatus, type FastScope } from "../../src/codex-fast.js";
import { applyFastToRequest } from "../../src/pi-extensions/codex-fast-request.js";

function currentScope(model?: { provider: string; id: string }): FastScope | undefined {
  const id = process.env.MINIME_BOT_PI_SESSION_AGENT_ID;
  if (!id || !model) return;
  const config = loadConfig(undefined, { resolveSecrets: false });
  const agent = Object.hasOwn(config.agents, id) ? config.agents[id] : undefined;
  if (!isFastEligible(agent, model)) return;
  return { agent, threadKey: process.env[PI_FAST_THREAD_ENV] || undefined };
}

export default function codexFast(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => {
    const scope = currentScope(ctx.model);
    if (!scope || !ctx.model) return;
    return applyFastToRequest(event.payload, ctx.model.id, readFastStatus(scope).enabled);
  });
  pi.registerCommand("fast", {
    description: "Show/set scoped Fast; /fast help for scopes and priority details",
    handler: async (args, ctx) => {
      try { ctx.ui.notify(handleFastCommand(args, args.trim() === "help" ? undefined : currentScope(ctx.model)), "info"); }
      catch (error) { ctx.ui.notify(formatFastCommandError(error), "error"); }
    },
  });
}
