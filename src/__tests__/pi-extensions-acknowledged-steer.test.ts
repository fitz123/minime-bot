import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
});
