import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CollaborationClient, CollaborationRouter } from "../collaboration.js";
import { SessionManager } from "../session-manager.js";
import { relayStream } from "../stream-relay.js";
import { resolvePackageOwnedPiInvocation } from "../pi-runtime.js";
import type { BotConfig, PlatformContext } from "../types.js";

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(check: () => boolean, ms = 20000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error("Timed out waiting for fixture"); await delay(30); }
}

for (const mode of ["rpc", "pty"] as const) test(`real Pi ${mode} extension -> busy bot thread -> clarification -> reply, with no internal Telegram output`, { timeout: 45000 }, async () => {
  mkdirSync(resolve(".tmp/222"), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), "collab-"));
  const env = { ...process.env };
  const fixture = resolve("src/__tests__/fixtures/collaboration-provider.ts");
  const extension = resolve("extensions/pi/collaboration.ts");
  for (const dir of ["agent", "sessions", "bot", "terminal", "tmp"]) mkdirSync(join(root, dir), { mode: 0o700 });
  Object.assign(process.env, { MINIME_CONTROL_WORKSPACE_ROOT: root, MINIME_COLLABORATION_SOCKET: join(root, "router.sock"), PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TMPDIR: join(root, "tmp") });
  delete process.env.PI_EXTENSIONS_DISABLED;
  const config: BotConfig = { whisperModelPath: "unused", collaboration: { socketPath: process.env.MINIME_COLLABORATION_SOCKET! }, agents: { b: { id: "b", workspaceCwd: join(root, "bot"), model: "openai-codex/fixture", systemPrompt: "Offline fixture context" } }, bindings: [], piExtraExtensions: [fixture], sessionDefaults: { maxConcurrentSessions: 4, idleTimeoutMs: 60000, maxMessageAgeMs: 60000, requireMention: false, maxMediaBytes: 1000 } };
  const manager = new SessionManager(() => config, join(root, "state", "sessions.json"), join(root, "logs"));
  const deliveries: any[] = [];
  const router = new CollaborationRouter({ discover: () => manager.collaborationEndpoints(), deliver: async (d, consumed) => { deliveries.push(d); await manager.deliverCollaboration(d, consumed); } });
  let child: ChildProcess | undefined;
  let terminalOutput = "";
  let terminalError = "";
  try {
    await router.start(process.env.MINIME_COLLABORATION_SOCKET!);
    const session = await manager.getOrCreateSession("fixture-thread", "b");
    const originalId = session.sessionId;
    for await (const _ of manager.sendSessionMessage("fixture-thread", "b", "Remember EXACT_CONTEXT_MARKER")) {}
    const publications: string[] = [];
    const platform: PlatformContext = { maxMessageLength: 4000, typingIntervalMs: 1000, typingIndicator: false,
      sendMessage: async text => { publications.push(text); return "fixture-message"; }, deleteMessage: async () => {}, sendTyping: async () => {}, sendDraft: async (_id, text) => { publications.push(text); return "sent" as any; }, sendFile: async path => { publications.push(readFileSync(path, "utf8")); }, replyError: async text => { publications.push(text); } };
    let release!: () => void;
    const outputDone = new Promise<void>(r => { release = r; });
    const human = relayStream(manager.sendSessionMessage("fixture-thread", "b", mode === "pty" ? "HUMAN_BUSY_PTY" : "HUMAN_BUSY", { outputDone }), platform, session.outboxPath).finally(() => release());
    await until(() => session.processingStartedAt !== null);
    const invocation = resolvePackageOwnedPiInvocation("cli", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension", fixture, "--extension", extension, "--model", "openai-codex/fixture"]);
    child = mode === "rpc"
      ? spawn(invocation.command, invocation.args, { cwd: join(root, "terminal"), env: process.env, stdio: ["pipe", "pipe", "pipe"] })
      : spawn("python3", [resolve("src/__tests__/fixtures/collaboration-pty-smoke.py"), "--socket", process.env.MINIME_COLLABORATION_SOCKET!], { cwd: process.cwd(), env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout!.on("data", chunk => { terminalOutput += chunk.toString(); });
    child.stderr!.on("data", chunk => { terminalError += chunk.toString(); });
    if (mode === "rpc") child.stdin!.write(JSON.stringify({ type: "prompt", message: "START_COLLAB" }) + "\n");
    await until(() => terminalOutput.includes("COLLABORATION_COMPLETE"));
    await human;
    assert.equal(manager.getActive("fixture-thread")?.sessionId, originalId);
    assert.equal(deliveries.length, 2);
    assert.ok(publications.some(text => text.includes("HUMAN_DONE")));
    assert.ok(publications.every(text => !/INTERNAL|CLARIFY|CLARIFICATION|EXACT_CONTEXT/.test(text)), JSON.stringify(publications));
    const transcript = readFileSync(session.sessionFile!, "utf8");
    assert.ok(transcript.indexOf("HUMAN_DONE") < transcript.indexOf("INTERNAL_TASK"));
    assert.match(transcript, /CLARIFICATION_VALUE=42/);
    assert.match(transcript, /INTERNAL_FINISHED/);
    for await (const _ of manager.sendSessionMessage("fixture-thread", "b", "Next human turn")) {}
    assert.deepEqual(readdirSync(session.outboxPath), []);
  } catch (error) {
    // Only isolated synthetic fixture data, useful when the actual Pi lifecycle fails.
    writeFileSync(resolve(".tmp/222/early-terminal.jsonl"), terminalOutput);
    writeFileSync(resolve(".tmp/222/early-terminal-stderr.log"), terminalError);
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => child!.once("exit", () => resolve()));
    }
    await router.stop();
    await manager.closeAll();
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  }
});


test("real standalone Pi session switch retires its exact address without redirecting old-context input", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "collab-switch-"));
  const path = join(root, "router.sock");
  const router = new CollaborationRouter({ discover: () => [], deliver: async () => { throw new Error("no bot target in this fixture"); } });
  const observer = new CollaborationClient(path, { kind: "terminal", id: "fixture-observer" }, "observer", () => {});
  const fixture = resolve("src/__tests__/fixtures/collaboration-provider.ts");
  const invocation = resolvePackageOwnedPiInvocation("cli", ["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--extension", fixture, "--extension", resolve("extensions/pi/collaboration.ts"), "--model", "openai-codex/fixture"]);
  let child: ChildProcess | undefined;
  const events: any[] = [];
  let buffer = "";
  const request = async (command: Record<string, unknown>) => {
    child!.stdin!.write(JSON.stringify(command) + "\n");
    await until(() => events.some(event => event.type === "response" && event.id === command.id));
    const response = events.find(event => event.type === "response" && event.id === command.id);
    assert.equal(response.success, true);
    return response;
  };
  const terminal = async () => (await observer.request({ op: "discover" })).endpoints?.find((e: any) => e.address.kind === "terminal" && e.address.id !== "fixture-observer");
  try {
    await router.start(path);
    assert.equal(await observer.connect(), true);
    const env = { ...process.env, MINIME_COLLABORATION_SOCKET: path, MINIME_COLLABORATION_SESSION: "", PI_CODING_AGENT_DIR: join(root, "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
    child = spawn(invocation.command, invocation.args, { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdout!.on("data", chunk => {
      buffer += chunk.toString();
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        try { events.push(JSON.parse(line)); } catch { /* non-RPC diagnostic */ }
      }
    });
    child.stderr!.resume();
    let original: any;
    for (let i = 0; i < 200 && !original; i++) { original = await terminal(); if (!original) await delay(30); }
    assert.ok(original);
    const originalState = await request({ id: "original-state", type: "get_state" });
    child.stdin!.write(JSON.stringify({ id: "busy", type: "prompt", message: "HUMAN_BUSY_PTY" }) + "\n");
    await until(() => events.some(event => event.type === "agent_start"));
    const queued = await observer.request({ op: "send", to: original.address, text: "OLD_PENDING_MUST_NOT_APPEAR" });
    assert.equal(queued.status, "accepted");
    await request({ id: "switch", type: "new_session" });
    let replacement: any;
    for (let i = 0; i < 200; i++) {
      replacement = await terminal();
      if (replacement && replacement.address.id !== original.address.id) break;
      await delay(30);
    }
    assert.ok(replacement);
    assert.notEqual(replacement.address.id, original.address.id);
    assert.equal((await observer.request({ op: "send", to: original.address, text: "cannot redirect" })).status, "disconnected");
    const oldStatus = (await observer.request({ op: "receipt", id: queued.id })).status;
    // A delivery racing the switch may finish in the original context; it must
    // never be silently redirected to the new context.
    assert.ok(["rejected", "unknown", "consumed"].includes(oldStatus), oldStatus);
    if (oldStatus === "consumed") assert.match(readFileSync(originalState.data.sessionFile, "utf8"), /OLD_PENDING_MUST_NOT_APPEAR/);
    await request({ id: "after", type: "prompt", message: "Human after switch" });
    await until(() => events.filter(event => event.type === "agent_settled").length >= 2);
    const state = await request({ id: "state", type: "get_state" });
    assert.doesNotMatch(readFileSync(state.data.sessionFile, "utf8"), /OLD_PENDING_MUST_NOT_APPEAR/);
  } finally {
    observer.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>(resolve => child!.once("exit", () => resolve()));
    }
    await router.stop();
  }
});
