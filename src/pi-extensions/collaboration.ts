import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CollaborationClient, collaborationPrompt, type Delivery } from "../collaboration.js";

/** Internal custom messages and collaboration prompts are never human topic content. */
function isHumanCollaborationTurn(event: { messageType: string; prompt?: string }): boolean {
  return event.messageType === "user" && !event.prompt?.startsWith("[Internal collaboration ");
}

export function registerCollaboration(pi: ExtensionAPI): void {
  const path = process.env.MINIME_COLLABORATION_SOCKET;
  if (!path) return;
  const topicOnly = process.env.MINIME_COLLABORATION_TOPIC_ONLY === "1";
  let humanTurn = false;
  // Bash snapshots process.env when each tool starts. A background command from
  // an internal turn must retain a private outbox after human turns resume.
  const humanOutbox = process.env.MINIME_COLLABORATION_SESSION ? process.env.MINIME_OUTBOX : undefined;
  pi.on("before_agent_start", event => {
    humanTurn = isHumanCollaborationTurn(event);
    if (humanOutbox) process.env.MINIME_OUTBOX = (event.messageType === "custom" ? event.message.customType === "minime-collaboration" : !isHumanCollaborationTurn(event))
      ? `${humanOutbox}.internal` : humanOutbox;
  });
  let client: CollaborationClient | undefined;
  let context: ExtensionContext | undefined;
  const inbox: Array<{ delivery: Delivery; client: CollaborationClient; timer: ReturnType<typeof setTimeout>; injected: boolean }> = [];
  let wakeup: ReturnType<typeof setTimeout> | undefined;
  const clearInbox = () => {
    clearTimeout(wakeup);
    wakeup = undefined;
    for (const item of inbox.splice(0)) {
      clearTimeout(item.timer);
      if (!item.injected) item.client.report(item.delivery.id, "rejected");
    }
  };
  const drain = () => {
    clearTimeout(wakeup);
    wakeup = undefined;
    const item = inbox.find(item => !item.injected);
    if (!item) return;
    if (!context?.isIdle()) {
      // Pi 0.99.1 manual compaction has no extension idle event on every
      // success/cancel/failure path. Poll only while uninjected input waits.
      wakeup = setTimeout(drain, 100);
      wakeup.unref();
      return;
    }
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
    const bot = process.env.MINIME_COLLABORATION_SESSION || undefined;
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
    humanTurn = false;
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
  if (process.env.MINIME_PRIVATE_TOPIC_POLICY === "1" && process.env.MINIME_COLLABORATION_SESSION) {
    pi.on("before_agent_start", async event => {
      if (!isHumanCollaborationTurn(event)) return;
      try {
        const value = await client?.request({ op: "topic_context" }, 1000);
        if (!value?.revision) return;
        return { systemPrompt: `${event.systemPrompt}\n\nPrivate topic context:\n${JSON.stringify(value)}` };
      } catch { /* Cosmetic context never prevents an ordinary turn. */ }
    });
    pi.registerTool({
      name: "topic_apply", label: "Set topic presentation",
      description: "Initialize once after meaningful human content (intent=auto), or edit ONLY fields explicitly requested by the current human (intent=manual), pinning their choices. Completed topics are manual-only. Use the current context revision, name grapheme cap and thematic free catalog indices. Accepted means reserved, NOT applied: do not claim success until confirmed by a later context receipt/current fields. Never replay pending/uncertain edits. A fresh explicit human request may supersede an inactive reservation when context.manualCanSupersede is true. On stale, use the returned refreshed context to retry the current explicit request.",
      parameters: Type.Object({ intent: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("manual")])), revision: Type.String(), name: Type.Optional(Type.String()), iconCandidates: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))) }),
      execute: async (_id, p) => {
        if (!humanTurn) return result({ status: "unavailable" });
        try {
          const value = await client?.request({ op: "topic_apply", ...p }) ?? { status: "unavailable" };
          if (value.status === "stale" && humanTurn) {
            return result({ ...value, context: await client?.request({ op: "topic_context" }, 1000) ?? { status: "unavailable" } });
          }
          return result(value);
        }
        catch { return result({ status: "unavailable" }); }
      },
    });
  }
  if (topicOnly) return;
  const address = Type.Object({ kind: Type.Union([Type.Literal("agent"), Type.Literal("thread"), Type.Literal("session"), Type.Literal("terminal")]), id: Type.String() });
  pi.registerTool({ name: "collaboration_discover", label: "Discover collaborators", description: "List same-host collaborators (64 per page; pass nextOffset as offset). Internal conversations only; requires running bot router.", parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })) }), execute: async (_id, p) => result(await client?.request({ op: "discover", ...p }) ?? { status: "disconnected" }) });
  pi.registerTool({ name: "collaboration_send", label: "Send internal message", description: "Start an internal conversation. Returns a receipt without waiting for an answer. Finish the turn so replies can arrive. At most 32 messages / 10 minutes per conversation.", parameters: Type.Object({ to: address, text: Type.String() }), execute: async (_id, p) => result(await client?.request({ op: "send", ...p }) ?? { status: "disconnected" }) });
  pi.registerTool({ name: "collaboration_reply", label: "Reply internally", description: "Reply to an incoming collaboration message id in its continuing conversation. Never waits for the peer response.", parameters: Type.Object({ replyTo: Type.String(), text: Type.String() }), execute: async (_id, p) => result(await client?.request({ op: "reply", ...p }) ?? { status: "disconnected" }) });
  pi.registerTool({ name: "collaboration_receipt", label: "Check receipt", description: "Check accepted/consumed/rejected/disconnected/unknown/expired delivery status. Consumption is not successful completion. Never blindly replay unknown effects.", parameters: Type.Object({ id: Type.String() }), execute: async (_id, p) => result(await client?.request({ op: "receipt", ...p }) ?? { status: "disconnected" }) });
}
