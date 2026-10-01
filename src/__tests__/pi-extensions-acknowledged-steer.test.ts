import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, type Context } from "@earendil-works/pi-ai";
import {
  PI_ACKNOWLEDGED_STEER_COMMAND,
  PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE,
  PI_ACKNOWLEDGED_STEER_RESULT_EVENT,
  buildPiAcknowledgedSteerInvocation,
  parsePiAcknowledgedSteerEnvelope,
  parsePiAcknowledgedSteerResultNotice,
} from "../pi-extensions/acknowledged-steer.js";

type EventHandler = (
  event: unknown,
  ctx: ExtensionCommandContext,
) => void;
type CommandHandler = (args: string, ctx: ExtensionCommandContext) => Promise<void>;

async function loadWrapper(): Promise<(pi: ExtensionAPI) => void> {
  const wrapperUrl = pathToFileURL(resolve("extensions/pi/acknowledged-steer.ts"));
  wrapperUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
  return (await import(wrapperUrl.href)).default as (pi: ExtensionAPI) => void;
}

function createHarness() {
  const handlers = new Map<string, EventHandler[]>();
  const sent: Array<{
    message: Record<string, unknown>;
    options: Record<string, unknown> | undefined;
  }> = [];
  const notices: string[] = [];
  const busEvents: Array<{ channel: string; data: unknown }> = [];
  let commandName = "";
  let commandHandler: CommandHandler | undefined;
  const context = {
    isIdle: () => false,
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
  } as ExtensionCommandContext;

  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      emit(channel: string, data: unknown) {
        busEvents.push({ channel, data });
      },
    },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commandName = name;
      commandHandler = options.handler;
    },
    sendMessage(
      message: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) {
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    sent,
    notices,
    busEvents,
    context,
    get commandName() {
      return commandName;
    },
    get commandHandler() {
      assert.ok(commandHandler);
      return commandHandler;
    },
    emit(event: string, payload?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload, context);
    },
  };
}

function commandArgs(id: string, text: string): string {
  return buildPiAcknowledgedSteerInvocation(id, text).split(" ")[1];
}

describe("acknowledged-steer Pi extension", () => {
  it("round-trips arbitrary message text through its command envelope", () => {
    const invocation = buildPiAcknowledgedSteerInvocation(
      "steer-1",
      "line one\n/command-looking text 🧭",
    );
    const [command, encoded] = invocation.split(" ");
    assert.strictEqual(command, `/${PI_ACKNOWLEDGED_STEER_COMMAND}`);
    assert.deepStrictEqual(parsePiAcknowledgedSteerEnvelope(encoded), {
      id: "steer-1",
      text: "line one\n/command-looking text 🧭",
    });
    assert.strictEqual(parsePiAcknowledgedSteerEnvelope("not-base64-json"), null);
  });

  it("atomically accepts from agent_start through post-run continuation work", async () => {
    const wrapper = await loadWrapper();
    const harness = createHarness();
    wrapper(harness.pi);
    assert.strictEqual(harness.commandName, PI_ACKNOWLEDGED_STEER_COMMAND);

    await harness.commandHandler(commandArgs("before", "too early"), harness.context);
    assert.strictEqual(harness.sent.length, 0);

    harness.emit("agent_start");
    await harness.commandHandler(commandArgs("accepted", "apply correction"), harness.context);
    assert.deepStrictEqual(harness.sent, [{
      message: {
        customType: PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE,
        content: "apply correction",
        display: false,
        details: { requestId: "accepted" },
      },
      options: { deliverAs: "steer" },
    }]);
    harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE,
        content: "apply correction",
        display: false,
        details: { requestId: "accepted" },
        timestamp: 1,
      },
    });

    harness.emit("agent_end");
    await harness.commandHandler(
      commandArgs("post-run", "apply during retry or compaction"),
      harness.context,
    );
    assert.strictEqual(
      harness.sent.length,
      2,
      "agent_end is followed by retry, compaction, or queued continuation work",
    );
    harness.emit("message_start", {
      type: "message_start",
      message: {
        role: "custom",
        customType: PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE,
        content: "apply during retry or compaction",
        display: false,
        details: { requestId: "post-run" },
        timestamp: 2,
      },
    });

    harness.emit("agent_settled");
    await harness.commandHandler(commandArgs("after", "too late"), harness.context);
    assert.strictEqual(harness.sent.length, 2);

    assert.deepStrictEqual(
      harness.notices.map((notice) => parsePiAcknowledgedSteerResultNotice(notice)),
      [
        { id: "before", status: "rejected" },
        { id: "accepted", status: "enqueued" },
        { id: "accepted", status: "consumed" },
        { id: "post-run", status: "enqueued" },
        { id: "post-run", status: "consumed" },
        { id: "after", status: "rejected" },
      ],
    );
    assert.deepStrictEqual(
      harness.busEvents,
      [
        { channel: PI_ACKNOWLEDGED_STEER_RESULT_EVENT, data: { id: "before", status: "rejected" } },
        { channel: PI_ACKNOWLEDGED_STEER_RESULT_EVENT, data: { id: "accepted", status: "enqueued" } },
        { channel: PI_ACKNOWLEDGED_STEER_RESULT_EVENT, data: { id: "accepted", status: "consumed" } },
        { channel: PI_ACKNOWLEDGED_STEER_RESULT_EVENT, data: { id: "post-run", status: "enqueued" } },
        { channel: PI_ACKNOWLEDGED_STEER_RESULT_EVENT, data: { id: "post-run", status: "consumed" } },
        { channel: PI_ACKNOWLEDGED_STEER_RESULT_EVENT, data: { id: "after", status: "rejected" } },
      ],
    );
  });

  it("rejects a stale parent-side busy flag when the child is idle", async () => {
    const wrapper = await loadWrapper();
    const harness = createHarness();
    wrapper(harness.pi);
    harness.emit("agent_start");

    const idleContext = {
      ...harness.context,
      isIdle: () => true,
    } as ExtensionCommandContext;
    await harness.commandHandler(
      commandArgs("idle-race", "must stay bot-owned"),
      idleContext,
    );

    assert.strictEqual(harness.sent.length, 0);
    assert.deepStrictEqual(parsePiAcknowledgedSteerResultNotice(harness.notices[0]), {
      id: "idle-race",
      status: "rejected",
    });
  });

  it("enqueues and consumes steering in an installed Pi run and rejects it after settlement", { timeout: 20_000 }, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "minime-acknowledged-steer-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(cwd, "auth.json") });
    const faux = fauxProvider({ provider: "acknowledged-steer-test" });
    modelRuntime.registerNativeProvider(faux.provider);
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolveGate) => { releaseResponse = resolveGate; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => { markStarted = resolveStarted; });
    let steeredRequest: Context | undefined;
    faux.setResponses([
      async () => {
        markStarted();
        await responseGate;
        return fauxAssistantMessage("initial answer");
      },
      (context) => {
        steeredRequest = context;
        return fauxAssistantMessage("corrected answer");
      },
    ]);
    const { session, extensionsResult } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      modelRuntime,
      model: faux.getModel(),
      settingsManager: SettingsManager.inMemory({
        extensions: [resolve("extensions/pi/acknowledged-steer.ts")],
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "all",
    });
    const notices: string[] = [];
    session.extensionRunner.setUIContext({
      ...session.extensionRunner.getUIContext(),
      notify: (message) => { notices.push(message); },
    });
    let settlements = 0;
    session.subscribe((event) => {
      if (event.type === "agent_settled") settlements += 1;
    });
    try {
      assert.deepEqual(extensionsResult.errors, []);
      await session.prompt(buildPiAcknowledgedSteerInvocation("before", "too early"));
      const run = session.prompt("initial question");
      await started;
      const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=" };
      await session.prompt(buildPiAcknowledgedSteerInvocation("during", "apply correction", [image]));
      releaseResponse();
      await run;
      await session.prompt(buildPiAcknowledgedSteerInvocation("after", "too late"));
      assert.equal(faux.state.callCount, 2);
      assert.ok(steeredRequest);
      assert.match(JSON.stringify(steeredRequest.messages), /apply correction/);
      const imageParts = steeredRequest.messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image") : []);
      assert.deepEqual(imageParts, [image], "installed Pi delivers steering photos to model vision");
      assert.equal(session.getLastAssistantText(), "corrected answer");
      assert.equal(settlements, 1);
      assert.deepEqual(notices.map(parsePiAcknowledgedSteerResultNotice), [
        { id: "before", status: "rejected" },
        { id: "during", status: "enqueued" },
        { id: "during", status: "consumed" },
        { id: "after", status: "rejected" },
      ]);
    } finally {
      releaseResponse();
      session.dispose();
    }
  });
});
