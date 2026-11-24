// Pi runs the registered provider, while this fixture supplies messages without a network request.
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const id = "continuity-fixture";
const text = message => typeof message.content === "string" ? message.content
  : message.content.filter(block => block.type === "text").map(block => block.text).join("");
const scopeAt = directory => readFileSync(join(directory, "fixture-scope.txt"), "utf8").trim();
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export default function(pi) {
  pi.registerProvider("openai-codex", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "synthetic-offline",
    api: "openai-completions",
    models: [{ id, name: "Continuity fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const turns = context.messages.filter(message => message.role === "user").map(text);
        const prompt = turns.at(-1);
        const payload = { model: model.id, service_tier: "priority" };
        const request = await options?.onPayload?.(payload, model) ?? payload;
        const answer = {
          turns,
          workspace: scopeAt(process.cwd()),
          home: scopeAt(process.env.HOME),
          cronFastOff: process.env.MINIME_CRON_FAST_OFF === "1",
          serviceTier: request.service_tier,
          cronSystemPrompt: getCurrentSystemPrompt(context.messages).includes("[[MINIME_CRON_UNRESOLVED_V1]]"),
          controllerEnv: ["MINIME_CONTROL_WORKSPACE_ROOT", "MINIME_CONFIG_PATH", "MINIME_OUTBOX"].some(key => key in process.env),
        };
        const output = prompt === "CRON_SUPPRESS" ? "NO_REPLY" : JSON.stringify(answer);
        const message = { role: "assistant", content: [{ type: "text", text: output }],
          api: model.api, provider: model.provider, model: model.id,
          usage, stopReason: "stop", timestamp: Date.now() };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: output, partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: output, partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      })().catch(error => {
        stream.push({ type: "error", reason: "error", error: {
          role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
          usage, stopReason: "error", errorMessage: String(error), timestamp: Date.now(),
        } });
        stream.end();
      });
      return stream;
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model?.provider === "openai-codex" && ctx.model.id === id) return;
    const model = ctx.modelRegistry.find("openai-codex", id);
    if (!model || !await pi.setModel(model)) throw new Error("Offline continuity model unavailable");
  });
}
