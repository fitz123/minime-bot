import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createServer, createConnection, type Socket, type Server } from "node:net";

export type Address = { kind: "agent" | "thread" | "session" | "terminal"; id: string };
export type ReceiptStatus = "accepted" | "consumed" | "rejected" | "disconnected" | "unknown" | "expired";
export interface Receipt { id?: string; status: ReceiptStatus; reason?: string }
export interface Delivery { id: string; conversation: string; from: Address; to: Address; text: string; expires: number }
export interface Endpoint { address: Address; label: string }
export interface Discovery { endpoints: Endpoint[]; nextOffset?: number }
export interface CollaborationOwner {
  discover(): Endpoint[];
  deliver(message: Delivery, consumed: () => void): Promise<void>;
}
export class CollaborationDeliveryError extends Error {
  constructor(readonly status: Exclude<ReceiptStatus, "accepted" | "consumed">, message: string) { super(message); }
}
export const COLLABORATION_TTL_MS = 10 * 60_000;
export const COLLABORATION_MAX_MESSAGES = 32;
const MAX_FRAME = 64 * 1024;
const MAX_ENDPOINTS = 256;
const MAX_RECEIPTS = 4096;
const key = (a: Address) => `${a.kind}:${a.id}`;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validAddress(a: unknown): a is Address {
  return record(a) && typeof a.kind === "string" && ["agent", "thread", "session", "terminal"].includes(a.kind) && typeof a.id === "string" && a.id.length > 0 && a.id.length <= 256;
}
function frames(socket: Socket, receive: (frame: Record<string, any>) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffer += chunk;
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) { socket.destroy(); return; }
      try {
        const frame: unknown = JSON.parse(line);
        if (!record(frame)) { socket.destroy(); return; }
        receive(frame);
      } catch { socket.destroy(); return; }
    }
    if (Buffer.byteLength(buffer) > MAX_FRAME) socket.destroy();
  });
}
function write(socket: Socket, frame: unknown): boolean {
  const data = JSON.stringify(frame) + "\n";
  if (socket.destroyed || Buffer.byteLength(data) > MAX_FRAME || socket.writableLength > MAX_FRAME * 4) {
    socket.destroy();
    return false;
  }
  socket.write(data);
  return true;
}

async function prepareSocket(path: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || (process.getuid && parent.uid !== process.getuid())) {
    throw new Error("Collaboration socket requires a user-owned 0700 parent directory");
  }
  let existing;
  try { existing = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!existing.isSocket() || (process.getuid && existing.uid !== process.getuid())) throw new Error("Collaboration path is not a user-owned socket");
  const stale = await new Promise<boolean>(resolve => {
    const probe = createConnection(path);
    const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 1000);
    probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
    probe.once("error", (error: NodeJS.ErrnoException) => { clearTimeout(timer); probe.destroy(); resolve(error.code === "ECONNREFUSED"); });
  });
  if (!stale) throw new Error("Collaboration socket is already in use or cannot be inspected");
  const current = lstatSync(path);
  if (current.dev !== existing.dev || current.ino !== existing.ino) throw new Error("Collaboration socket changed during startup");
  unlinkSync(path);
}

/** Ephemeral, single-host coordination. Neither receipts nor effects survive router loss. */
export class CollaborationRouter {
  private server?: Server;
  private peers = new Map<string, { socket: Socket; endpoint: Endpoint }>();
  private sockets = new Set<Socket>();
  private messages = new Map<string, { delivery: Delivery; receipt: Receipt }>();
  private conversations = new Map<string, { count: number; expires: number }>();
  constructor(private owner: CollaborationOwner) {}
  async start(path: string): Promise<void> {
    await prepareSocket(path);
    this.server = createServer(socket => this.connect(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(path, () => { this.server!.removeListener("error", reject); resolve(); });
    });
    chmodSync(path, 0o600);
  }
  async stop(): Promise<void> {
    for (const entry of this.messages.values()) if (entry.receipt.status === "accepted") entry.receipt.status = "unknown";
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server ? this.server.close(() => resolve()) : resolve());
    this.server = undefined;
  }
  private prune(): void {
    // Keep terminal receipts for one additional lifetime. A missing record is
    // unknown, never evidence that an operation had no effects.
    for (const [id, entry] of this.messages) if (entry.delivery.expires + COLLABORATION_TTL_MS < Date.now()) this.messages.delete(id);
    for (const [id, c] of this.conversations) if (c.expires < Date.now()) this.conversations.delete(id);
  }
  private connect(socket: Socket): void {
    if (this.sockets.size >= MAX_ENDPOINTS) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.on("error", () => {});
    let source: Address | undefined;
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (source && this.peers.get(key(source))?.socket === socket) {
        this.peers.delete(key(source));
        // Bot deliveries belong to SessionManager, not the extension connection.
        if (source.kind === "terminal") for (const entry of this.messages.values()) {
          if (key(entry.delivery.to) === key(source) && entry.receipt.status === "accepted") entry.receipt.status = "unknown";
        }
      }
    });
    frames(socket, frame => {
      this.prune();
      const respond = (value: unknown) => write(socket, { request: frame.request, value });
      if (frame.op === "hello") {
        if (source || !validAddress(frame.address) || !["terminal", "session"].includes(frame.address.kind) || this.peers.has(key(frame.address))) {
          return void respond({ status: "rejected", reason: "invalid or duplicate endpoint" });
        }
        source = frame.address;
        this.peers.set(key(source), { socket, endpoint: { address: source, label: String(frame.label ?? source.kind).slice(0, 100) } });
        return void respond({ status: "accepted" });
      }
      if (!source) return void respond({ status: "rejected", reason: "register first" });
      if (frame.op === "discover") {
        const offset = frame.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) return void respond({ status: "rejected", reason: "invalid discovery offset" });
        try {
          const endpoints = [...this.owner.discover(), ...[...this.peers.values()].filter(p => p.endpoint.address.kind === "terminal").map(p => p.endpoint)];
          const unique = [...new Map(endpoints.map(e => [key(e.address), e])).values()];
          respond({ endpoints: unique.slice(offset, offset + 64), ...(offset + 64 < unique.length ? { nextOffset: offset + 64 } : {}) });
        } catch { respond({ status: "rejected", reason: "bot discovery unavailable" }); }
        return;
      }
      if (frame.op === "receipt") {
        const entry = this.messages.get(frame.id);
        if (!entry) return void respond({ id: frame.id, status: "unknown", reason: "receipt not retained or router restarted; do not replay" });
        if (entry.receipt.status === "accepted" && entry.delivery.expires < Date.now()) {
          // Delivery may have reached Pi without its consumption acknowledgement.
          return void respond({ id: frame.id, status: "unknown", reason: "delivery deadline passed without acknowledgement; do not replay" });
        }
        return void respond(entry.receipt);
      }
      if (frame.op === "delivery_status") {
        const entry = this.messages.get(frame.id);
        if (entry && key(entry.delivery.to) === key(source) && ["consumed", "expired", "rejected"].includes(frame.status) && entry.receipt.status === "accepted") {
          entry.receipt.status = frame.status;
        }
        return;
      }
      if (frame.op !== "send" && frame.op !== "reply") return void respond({ status: "rejected", reason: "unknown operation" });
      const previous = frame.op === "reply" ? this.messages.get(frame.replyTo)?.delivery : undefined;
      if (frame.op === "reply" && (!previous || key(previous.to) !== key(source))) return void respond({ status: "rejected", reason: "reply target missing or belongs to another endpoint" });
      if (previous && previous.expires <= Date.now()) return void respond({ status: "expired", reason: "conversation expired" });
      const target = previous?.from ?? frame.to;
      if (!validAddress(target) || typeof frame.text !== "string" || !frame.text.trim() || frame.text.length > 16000) return void respond({ status: "rejected", reason: "invalid target or text" });
      const conversation = previous?.conversation ?? randomUUID();
      const c = this.conversations.get(conversation) ?? { count: 0, expires: Date.now() + COLLABORATION_TTL_MS };
      if (c.count >= COLLABORATION_MAX_MESSAGES || this.messages.size >= MAX_RECEIPTS) return void respond({ status: "rejected", reason: "conversation limit or router capacity reached" });
      c.count++; this.conversations.set(conversation, c);
      const delivery: Delivery = { id: randomUUID(), conversation, from: source, to: target, text: frame.text, expires: c.expires };
      const receipt: Receipt = { id: delivery.id, status: "accepted" };
      this.messages.set(delivery.id, { delivery, receipt });
      const peer = target.kind === "terminal" ? this.peers.get(key(target)) : undefined;
      if (target.kind === "terminal" && !peer) { receipt.status = "disconnected"; return void respond(receipt); }
      respond(receipt); // Never wait for a peer turn/tool before acknowledging the send.
      if (peer) {
        if (!write(peer.socket, { delivery })) receipt.status = "unknown";
      } else {
        void this.owner.deliver(delivery, () => { receipt.status = "consumed"; }).catch(error => {
          if (receipt.status === "accepted") {
            receipt.status = error instanceof CollaborationDeliveryError ? error.status : "unknown";
            receipt.reason = error instanceof CollaborationDeliveryError ? error.message : "owner lost delivery outcome; do not replay";
          }
        });
      }
    });
  }
}

/** Re-register after bot restart, but never retry a request or received message. */
export class CollaborationClient {
  private socket?: Socket;
  private ready = false;
  private stopped = false;
  private connecting?: Promise<boolean>;
  private retry?: ReturnType<typeof setTimeout>;
  private pending = new Map<string, { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout>; hello: boolean }>();
  constructor(private path: string, private address: Address, private label: string, private receive: (delivery: Delivery) => void) {}
  connect(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    if (this.ready) return Promise.resolve(true);
    if (this.connecting) return this.connecting;
    this.connecting = this.open().finally(() => {
      this.connecting = undefined;
      if (!this.ready && !this.stopped) this.scheduleReconnect();
    });
    return this.connecting;
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, 1000);
    this.retry.unref();
  }
  private async open(): Promise<boolean> {
    const socket = createConnection(this.path); this.socket = socket;
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.ready = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ status: "unknown", reason: "router disconnected; do not replay" }); }
      this.pending.clear();
      this.scheduleReconnect();
    });
    frames(socket, frame => {
      if (this.socket !== socket) return;
      if (frame.delivery && this.ready) { this.receive(frame.delivery as Delivery); return; }
      const p = this.pending.get(frame.request);
      if (p) {
        // A delivery can follow hello in the same data chunk. frames() handles
        // it before the awaiting connect continuation gets a microtask.
        if (p.hello) this.ready = frame.value?.status === "accepted" && !socket.destroyed && !this.stopped;
        clearTimeout(p.timer); this.pending.delete(frame.request); p.resolve(frame.value);
      }
    });
    const connected = await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 1000);
      socket.once("connect", () => { clearTimeout(timer); resolve(true); });
      socket.once("close", () => { clearTimeout(timer); resolve(false); });
    });
    if (!connected || this.stopped) return false;
    const hello = await this.exchange({ op: "hello", address: this.address, label: this.label });
    this.ready = hello.status === "accepted" && !socket.destroyed && !this.stopped;
    if (!this.ready) socket.destroy();
    return this.ready;
  }
  async request(frame: Record<string, unknown>): Promise<any> {
    if (!await this.connect()) return { status: "disconnected" };
    return this.exchange(frame);
  }
  private exchange(frame: Record<string, unknown>): Promise<any> {
    if (!this.socket || this.socket.destroyed) return Promise.resolve({ status: "disconnected" });
    const request = randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(request); resolve({ status: "unknown", reason: "receipt timeout; do not replay" }); }, 3000);
      this.pending.set(request, { resolve, timer, hello: frame.op === "hello" });
      write(this.socket!, { ...frame, request });
    });
  }
  report(id: string, status: "consumed" | "expired" | "rejected"): void {
    if (this.ready && this.socket && !this.socket.destroyed) write(this.socket, { op: "delivery_status", id, status });
  }
  consumed(id: string): void { this.report(id, "consumed"); }
  close(): void {
    this.stopped = true;
    this.ready = false;
    if (this.retry) clearTimeout(this.retry);
    this.socket?.destroy();
  }
}
export function collaborationPrompt(d: Delivery): string {
  return `[Internal collaboration ${JSON.stringify({ id: d.id, conversation: d.conversation, from: d.from })}]\n${d.text}\nReply with collaboration_reply(replyTo=${JSON.stringify(d.id)}). Internal output must not be published to humans or placed in the delivery outbox. Send/reply only acknowledges delivery; finish this turn to allow further replies. Publication requires a separate explicit human request.`;
}
