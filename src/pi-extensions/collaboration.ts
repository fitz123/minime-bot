import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CollaborationClient, collaborationPrompt, type Delivery } from "../collaboration.js";

export function registerCollaboration(pi: ExtensionAPI): void {
  const path = process.env.MINIME_COLLABORATION_SOCKET;
  if (!path) return;
  // Bash snapshots process.env when each tool starts. A background command from
  // an internal turn must retain a private outbox after human turns resume.
  const humanOutbox = process.env.MINIME_COLLABORATION_SESSION ? process.env.MINIME_OUTBOX : undefined;
  pi.on("before_agent_start", event => {
    if (humanOutbox) process.env.MINIME_OUTBOX = event.prompt.startsWith("[Internal collaboration ")
      ? `${humanOutbox}.internal` : humanOutbox;
  });
  let client: CollaborationClient | undefined;
  let context: ExtensionContext | undefined;
  const inbox: Array<{ delivery: Delivery; client: CollaborationClient; timer: ReturnType<typeof setTimeout>; injected: boolean }> = [];
  const clearInbox = () => {
    for (const item of inbox.splice(0)) {
      clearTimeout(item.timer);
      if (!item.injected) item.client.report(item.delivery.id, "rejected");
    }
  };
  const drain = () => {
    if (!context?.isIdle()) return;
    const item = inbox.find(item => !item.injected);
    if (!item) return;
    if (item.delivery.expires <= Date.now()) return;
    item.injected = true;
    pi.sendMessage({
      customType: "minime-collaboration", content: collaborationPrompt(item.delivery),
      display: true, details: { id: item.delivery.id },
    }, { triggerTurn: true, deliverAs: "followUp" });
  };
  const connect = async (_event: unknown, ctx: ExtensionContext) => {
    clearInbox();
    client?.close();
    context = ctx;
    const bot = process.env.MINIME_COLLABORATION_SESSION;
    // An owner-opened bot child must never advertise a replacement Pi context.
    if (bot && bot !== ctx.sessionManager.getSessionId()) { client = undefined; return; }
    const current = new CollaborationClient(path, {
      kind: bot ? "session" : "terminal",
      id: bot ?? `${ctx.sessionManager.getSessionId()}-${randomUUID()}`,
    }, process.env.MINIME_COLLABORATION_LABEL ?? "Pi terminal", delivery => {
      if (bot) return; // Bot input is exclusively scheduled/read by SessionManager.
      if (delivery.expires <= Date.now()) { current.report(delivery.id, "expired"); return; }
      if (inbox.length >= 64) { current.report(delivery.id, "rejected"); return; }
      const timer = setTimeout(() => {
        const index = inbox.findIndex(item => item.delivery.id === delivery.id);
        if (index < 0) return;
        const [item] = inbox.splice(index, 1);
        if (!item.injected) current.report(delivery.id, "expired");
      }, Math.max(1, delivery.expires - Date.now()));
      timer.unref();
      inbox.push({ delivery, client: current, timer, injected: false });
      drain();
    });
    client = current;
    await current.connect(); // Bot absence is non-fatal; registration retries, requests do not.
  };
  // Retire queued input before abort/settlement can start it during a context
  // change. A cancelled switch may drop queued input, but never silently replay it.
  pi.on("session_before_switch", () => { clearInbox(); });
  pi.on("session_before_fork", () => { clearInbox(); });
  pi.on("session_before_tree", () => { clearInbox(); });
  pi.on("session_start", connect);
  pi.on("session_tree", connect);
  pi.on("session_shutdown", () => { clearInbox(); client?.close(); });
  pi.on("agent_settled", () => {
    if (humanOutbox) process.env.MINIME_OUTBOX = humanOutbox;
    drain();
  });
  pi.on("message_start", event => {
    const m = event.message;
    if (m.role !== "custom" || m.customType !== "minime-collaboration") return;
    const id = (m.details as { id: string }).id;
    const index = inbox.findIndex(item => item.delivery.id === id);
    if (index < 0) return;
    const [item] = inbox.splice(index, 1);
    clearTimeout(item.timer);
    item.client.consumed(id);
  });
  const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
  const address = Type.Object({ kind: Type.Union([Type.Literal("agent"), Type.Literal("thread"), Type.Literal("session"), Type.Literal("terminal")]), id: Type.String() });
  pi.registerTool({ name: "collaboration_discover", label: "Discover collaborators", description: "List same-host collaborators (64 per page; pass nextOffset as offset). Internal conversations only; requires running bot router.", parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }), execute: async (_id, p) => result(await client?.request({ op: "discover", ...p }) ?? { status: "disconnected" }) });
  pi.registerTool({ name: "collaboration_send", label: "Send internal message", description: "Start an internal conversation. Returns a receipt without waiting for an answer. Finish the turn so replies can arrive. At most 32 messages / 10 minutes per conversation.", parameters: Type.Object({ to: address, text: Type.String() }), execute: async (_id, p) => result(await client?.request({ op: "send", ...p }) ?? { status: "disconnected" }) });
  pi.registerTool({ name: "collaboration_reply", label: "Reply internally", description: "Reply to an incoming collaboration message id in its continuing conversation. Never waits for the peer response.", parameters: Type.Object({ replyTo: Type.String(), text: Type.String() }), execute: async (_id, p) => result(await client?.request({ op: "reply", ...p }) ?? { status: "disconnected" }) });
  pi.registerTool({ name: "collaboration_receipt", label: "Check receipt", description: "Check accepted/consumed/rejected/disconnected/unknown/expired delivery status. Consumption is not successful completion. Never blindly replay unknown effects.", parameters: Type.Object({ id: Type.String() }), execute: async (_id, p) => result(await client?.request({ op: "receipt", ...p }) ?? { status: "disconnected" }) });
}
