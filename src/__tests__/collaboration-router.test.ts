// Protocol/lifecycle tests with socket peers. Real Pi proof lives in collaboration-integration.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationClient, CollaborationDeliveryError, CollaborationRouter, COLLABORATION_TTL_MS, type Delivery, type CollaborationOwner } from "../collaboration.js";

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() >= deadline) throw new Error("Socket test timeout"); await delay(20); }
}
async function fixture(owner: CollaborationOwner = { discover: () => [], deliver: async () => { throw new CollaborationDeliveryError("rejected", "unavailable"); } }) {
  const root = mkdtempSync(join(tmpdir(), "collab-router-"));
  const path = join(root, "router.sock");
  const router = new CollaborationRouter(owner);
  const clients: CollaborationClient[] = [];
  await router.start(path);
  return {
    root, path, router,
    async peer(id: string, receive: (d: Delivery) => void = () => {}) {
      const client = new CollaborationClient(path, { kind: "terminal", id }, id, receive);
      clients.push(client);
      assert.equal(await client.connect(), true);
      return client;
    },
    async close() { for (const client of clients) client.close(); await router.stop(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("socket is private; second router cannot unlink a live owner; only stale owned sockets are removed", async () => {
  const f = await fixture();
  try {
    assert.equal(lstatSync(f.path).mode & 0o777, 0o600);
    const inode = lstatSync(f.path).ino;
    await assert.rejects(new CollaborationRouter({ discover: () => [], deliver: async () => {} }).start(f.path), /already in use/);
    assert.equal(lstatSync(f.path).ino, inode);
    await f.router.stop();
    const child = spawn(process.execPath, ["--input-type=module", "-e", "import net from 'node:net'; net.createServer().listen(process.argv[1],()=>console.log('ready'));", f.path], { stdio: ["ignore", "pipe", "pipe"] });
    let ready = false;
    child.stdout.on("data", () => { ready = true; });
    try { await until(() => ready); } finally {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await exited;
    }
    const next = new CollaborationRouter({ discover: () => [], deliver: async () => {} });
    await next.start(f.path);
    await next.stop();
    writeFileSync(f.path, "unrelated fixture file");
    await assert.rejects(next.start(f.path), /not a user-owned socket/);
    chmodSync(f.root, 0o755);
    await assert.rejects(next.start(f.path), /0700/);
  } finally { await f.close(); }
});

test("nonblocking send/reply receipts and per-conversation stop condition", async () => {
  const f = await fixture();
  const aInbox: Delivery[] = [], bInbox: Delivery[] = [];
  try {
    const a = await f.peer("a", d => aInbox.push(d));
    const b = await f.peer("b", d => bInbox.push(d));
    const receipt = await a.request({ op: "send", to: { kind: "terminal", id: "b" }, text: "question" });
    assert.equal(receipt.status, "accepted");
    await until(() => bInbox.length === 1);
    assert.equal((await a.request({ op: "receipt", id: receipt.id })).status, "accepted");
    b.consumed(receipt.id);
    await until(async () => (await a.request({ op: "receipt", id: receipt.id })).status === "consumed");
    let previous = bInbox[0];
    for (let count = 2; count <= 32; count++) {
      const sender = count % 2 === 0 ? b : a;
      const inbox = count % 2 === 0 ? aInbox : bInbox;
      const length = inbox.length;
      const response = await sender.request({ op: "reply", replyTo: previous.id, text: `reply ${count}` });
      assert.equal(response.status, "accepted");
      await until(() => inbox.length === length + 1);
      previous = inbox.at(-1)!;
      assert.equal(previous.conversation, bInbox[0].conversation);
    }
    assert.equal((await a.request({ op: "reply", replyTo: previous.id, text: "beyond stop" })).status, "rejected");
    assert.equal((await a.request({ op: "send", to: { kind: "terminal", id: "b" }, text: "new conversation" })).status, "accepted");
    assert.equal((await a.request({ op: "send", to: { kind: "terminal", id: "missing" }, text: "hello" })).status, "disconnected");
  } finally { await f.close(); }
});

test("owner reports rejected/expired/disconnected/unknown honestly; consumption survives a later error", async () => {
  const f = await fixture({ discover: () => [], deliver: async (d, consumed) => {
    if (d.text === "consumed") consumed();
    throw new CollaborationDeliveryError(d.text === "consumed" ? "unknown" : d.text as "rejected", "fixture outcome");
  } });
  try {
    const a = await f.peer("a");
    for (const status of ["rejected", "expired", "disconnected", "unknown", "consumed"]) {
      const receipt = await a.request({ op: "send", to: { kind: "agent", id: "b" }, text: status });
      assert.equal(receipt.status, "accepted");
      await until(async () => (await a.request({ op: "receipt", id: receipt.id })).status === status);
    }
    assert.equal((await a.request({ op: "receipt", id: "unretained" })).status, "unknown");
  } finally { await f.close(); }
});

test("deadline without consumption acknowledgement is unknown; a dropped message can be expired", async t => {
  const f = await fixture();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const inbox: Delivery[] = [];
  try {
    const a = await f.peer("a"), b = await f.peer("b", d => inbox.push(d));
    const first = await a.request({ op: "send", to: { kind: "terminal", id: "b" }, text: "might have run" });
    await until(() => inbox.length === 1);
    now += COLLABORATION_TTL_MS + 1;
    assert.equal((await a.request({ op: "receipt", id: first.id })).status, "unknown");
    b.report(first.id, "expired");
    await until(async () => (await a.request({ op: "receipt", id: first.id })).status === "expired");
    assert.equal((await b.request({ op: "reply", replyTo: first.id, text: "too late" })).status, "expired");
    now += COLLABORATION_TTL_MS;
    assert.equal((await a.request({ op: "receipt", id: first.id })).status, "unknown");
  } finally { await f.close(); }
});

test("disconnect after dispatch is unknown, restart re-registers without replay, old receipt stays unknown", async () => {
  let deliveries = 0;
  const f = await fixture({ discover: () => [], deliver: async () => { deliveries++; } });
  const inbox: Delivery[] = [];
  let replacement: CollaborationRouter | undefined;
  try {
    const a = await f.peer("a"), b = await f.peer("b", d => inbox.push(d));
    const receipt = await a.request({ op: "send", to: { kind: "terminal", id: "b" }, text: "no ack" });
    await until(() => inbox.length === 1);
    b.close();
    await until(async () => (await a.request({ op: "receipt", id: receipt.id })).status === "unknown");
    await a.request({ op: "send", to: { kind: "agent", id: "b" }, text: "once" });
    await until(() => deliveries === 1);
    await f.router.stop();
    replacement = new CollaborationRouter({ discover: () => [], deliver: async () => { deliveries++; } });
    await replacement.start(f.path);
    await until(async () => (await a.request({ op: "discover" })).endpoints?.some((e: any) => e.address.id === "a"));
    assert.equal((await a.request({ op: "receipt", id: receipt.id })).status, "unknown");
    await delay(1100);
    assert.equal(deliveries, 1);
    assert.equal(inbox.length, 1);
  } finally { await f.close(); await replacement?.stop(); }
});

test("absent bot can appear later; discovery pages cover configured and connected endpoints", async () => {
  const root = mkdtempSync(join(tmpdir(), "collab-late-"));
  const path = join(root, "router.sock");
  const a = new CollaborationClient(path, { kind: "terminal", id: "a" }, "a", () => {});
  const router = new CollaborationRouter({ discover: () => Array.from({ length: 150 }, (_, i) => ({ address: { kind: "agent", id: `agent-${i}` }, label: `agent-${i}` })), deliver: async () => {} });
  try {
    assert.equal(await a.connect(), false);
    await router.start(path);
    const observer = new CollaborationClient(path, { kind: "terminal", id: "observer" }, "observer", () => {});
    try {
      assert.equal(await observer.connect(), true);
      await until(async () => {
        const page = await observer.request({ op: "discover", offset: 128 });
        return page.endpoints?.some((e: any) => e.address.id === "a");
      });
      let offset = 0, total = 0;
      for (;;) {
        const page = await a.request({ op: "discover", offset });
        assert.ok(page.endpoints.length <= 64);
        total += page.endpoints.length;
        if (page.nextOffset === undefined) break;
        offset = page.nextOffset;
      }
      assert.equal(total, 152);
    } finally { observer.close(); }
  } finally { a.close(); await router.stop(); rmSync(root, { recursive: true, force: true }); }
});
