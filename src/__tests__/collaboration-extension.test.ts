// Extension scheduling regression with a controlled client/idle state. Actual
// Pi RPC and PTY scheduling proof remains in collaboration-integration.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CollaborationClient, type Address, type Delivery } from "../collaboration.js";
import { registerCollaboration } from "../pi-extensions/collaboration.js";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test("empty bot identity registers standalone; queued input wakes after manual compaction success/cancel/failure", async t => {
  const env = { socket: process.env.MINIME_COLLABORATION_SOCKET, session: process.env.MINIME_COLLABORATION_SESSION };
  process.env.MINIME_COLLABORATION_SOCKET = "/unused/fixture.sock";
  process.env.MINIME_COLLABORATION_SESSION = "";
  const handlers = new Map<string, (event?: any, ctx?: any) => any>();
  const sent: any[] = [];
  const reports: unknown[] = [];
  let idle = true;
  let client!: CollaborationClient;
  t.mock.method(CollaborationClient.prototype, "connect", async function(this: CollaborationClient) { client = this; return true; });
  t.mock.method(CollaborationClient.prototype, "report", (id: string, status: "consumed" | "expired" | "rejected") => { reports.push({ id, status }); });
  const context = { isIdle: () => idle, sessionManager: { getSessionId: () => "fixture-session" } };
  try {
    registerCollaboration({
      on: (name: string, handler: any) => { handlers.set(name, handler); },
      registerTool: () => {},
      sendMessage: (message: any) => { sent.push(message); },
    } as any);
    await handlers.get("session_start")!({}, context);
    const address = (client as any).address as Address;
    assert.equal(address.kind, "terminal");
    assert.match(address.id, /^fixture-session-.+/);
    for (const outcome of ["success", "cancel", "failure"]) {
      idle = false;
      const delivery: Delivery = { id: outcome, conversation: "fixture", from: { kind: "terminal", id: "sender" }, to: address, text: outcome, expires: Date.now() + 2000 };
      (client as any).receive(delivery);
      await delay(120);
      assert.ok(!sent.some(m => m.details.id === outcome));
      // Pi's successful session_compact runs before clearing compaction state;
      // failure/cancellation do not emit agent_settled either.
      await handlers.get(outcome === "success" ? "session_compact" : "session_compact_failed")?.({}, context);
      idle = true;
      await delay(200);
      assert.equal(sent.filter(m => m.details.id === outcome).length, 1);
      await handlers.get("message_start")!({ message: { role: "custom", customType: "minime-collaboration", details: { id: outcome } } });
    }
    assert.deepEqual(reports, ["success", "cancel", "failure"].map(id => ({ id, status: "consumed" })));
    idle = false;
    (client as any).receive({ id: "retired", conversation: "fixture", from: address, to: address, text: "old", expires: Date.now() + 2000 });
    await handlers.get("session_before_switch")!();
    idle = true;
    await delay(200);
    assert.equal(sent.length, 3, "switch must cancel scheduled wakeups and old input");
  } finally {
    await handlers.get("session_shutdown")?.();
    for (const [key, value] of [["MINIME_COLLABORATION_SOCKET", env.socket], ["MINIME_COLLABORATION_SESSION", env.session]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
