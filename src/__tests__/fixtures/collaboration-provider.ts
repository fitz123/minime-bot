// Deterministic, offline provider: exercises actual Pi tool execution and scheduling.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
export default function(pi: ExtensionAPI) {
  pi.registerProvider("openai-codex", {
    baseUrl: "http://127.0.0.1:1", apiKey: "offline-fixture", api: "openai-completions",
    models: [{ id: "fixture", name: "Offline fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const messages = context.messages as any[];
        const all = JSON.stringify(messages);
        const last = messages[messages.length - 1];
        const text = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
        // Recover envelope from content, before JSON serialization escapes it.
        let envelope: any;
        for (const m of messages) {
          const content = typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join("");
          const match = content.match(/\[Internal collaboration (.*)\]/);
          if (match) envelope = JSON.parse(match[1]);
        }
        let content: any[] = [{ type: "text", text: "fixture idle" }];
        if (last?.role === "toolResult") content = [{ type: "text", text: "Internal tool receipt recorded; yielding." }];
        else if (text.includes("HUMAN_BUSY")) {
          await new Promise(r => setTimeout(r, text.includes("HUMAN_BUSY_PTY") ? 3500 : 1200));
          content = [{ type: "text", text: "HUMAN_DONE" }];
        } else if (text.includes("CONSULT_ONE")) {
          if (!all.includes("AGENT_CONTEXT_MARKER")) throw new Error("Missing target agent context");
          content = [{ type: "text", text: "CONSULT_FIRST_DONE" }];
        } else if (text.includes("CONSULT_TWO")) {
          if (!all.includes("AGENT_CONTEXT_MARKER") || !all.includes("CONSULT_FIRST_DONE")) throw new Error("Lost continuing agent context");
          content = [{ type: "text", text: "CONSULT_CONTINUED" }];
        } else if (text.includes("INTERNAL_BACKGROUND")) {
          const script = "setTimeout(() => { const fs = require('node:fs'); fs.mkdirSync(process.env.MINIME_OUTBOX, {recursive:true}); fs.writeFileSync(process.env.MINIME_OUTBOX + '/late.txt', 'PRIVATE_BACKGROUND'); }, 500)";
          content = [{ type: "toolCall", id: "background", name: "bash", arguments: { command: `node -e "${script}" >/dev/null 2>&1 &` } }];
        } else if (text.includes("INTERNAL_BUSY")) {
          if (process.env.MINIME_OUTBOX) writeFileSync(join(process.env.MINIME_OUTBOX, "internal.txt"), "INTERNAL_FILE");
          await new Promise(r => setTimeout(r, 1200));
          content = [{ type: "text", text: "INTERNAL_DONE" }];
        } else if (text.includes("START_COLLAB")) {
          content = [{ type: "toolCall", id: "start", name: "collaboration_send", arguments: { to: { kind: "thread", id: "fixture-thread" }, text: "Please solve INTERNAL_TASK using your exact context marker. Ask for clarification." } }];
        } else if (text.includes("INTERNAL_TASK")) {
          if (!all.includes("EXACT_CONTEXT_MARKER")) throw new Error("Missing exact session context");
          if (process.env.MINIME_OUTBOX) writeFileSync(join(process.env.MINIME_OUTBOX, "internal.txt"), "INTERNAL_FILE");
          content = [{ type: "text", text: "INTERNAL_DRAFT: checking the exact context" }, { type: "toolCall", id: "clarify", name: "collaboration_reply", arguments: { replyTo: envelope.id, text: "CLARIFY: which value? I retain EXACT_CONTEXT_MARKER." } }];
        } else if (text.includes("CLARIFY:")) {
          content = [{ type: "toolCall", id: "answer", name: "collaboration_reply", arguments: { replyTo: envelope.id, text: "CLARIFICATION_VALUE=42" } }];
        } else if (text.includes("CLARIFICATION_VALUE=42")) {
          content = [{ type: "toolCall", id: "finish", name: "collaboration_reply", arguments: { replyTo: envelope.id, text: "INTERNAL_FINISHED EXACT_CONTEXT_MARKER value=42" } }];
        } else if (text.includes("INTERNAL_FINISHED")) content = [{ type: "text", text: "COLLABORATION_COMPLETE" }];
        const message: any = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content.some(block => block.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now() };
        const finalContent = message.content;
        message.content = [];
        stream.push({ type: "start", partial: message });
        for (const block of finalContent) {
          const index = message.content.length;
          if (block.type === "text") {
            message.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: index, partial: message });
            await new Promise(resolve => setTimeout(resolve, 5));
            message.content[index].text = block.text;
            stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
            stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
          } else message.content.push(block);
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      })().catch(error => {
        stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: String(error), timestamp: Date.now() } }); stream.end();
      });
      return stream;
    },
  });
  // Every replacement runtime must stay on the local provider, including /new.
  // The fixture never falls back to an external model or credentials.
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.modelRegistry.find("openai-codex", "fixture");
    if (!model || !await pi.setModel(model)) throw new Error("Offline fixture model unavailable");
  });
}
