import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  type Context,
} from "@earendil-works/pi-ai";
import {
  PI_ACKNOWLEDGED_STEER_COMMAND,
  PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE,
  buildPiAcknowledgedSteerInvocation,
} from "../pi-extensions/acknowledged-steer.js";
import {
  PI_COMPACTION_CONTINUATION_CONTENT,
  PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
  isReasoningOnlyLengthAgentEnd,
} from "../pi-extensions/compaction-continuation.js";

type EventHandler = (
  event: Record<string, unknown>,
  ctx: ExtensionCommandContext,
) => unknown;
type CommandHandler = (
  args: string,
  ctx: ExtensionCommandContext,
) => Promise<void>;

async function loadWrapper(
  name = "compaction-continuation",
): Promise<(pi: ExtensionAPI) => void> {
  const wrapperUrl = pathToFileURL(
    resolve(`extensions/pi/${name}.ts`),
  );
  wrapperUrl.searchParams.set("test", `${Date.now()}-${Math.random()}`);
  return (await import(wrapperUrl.href)).default as (pi: ExtensionAPI) => void;
}

function createHarness() {
  const handlers = new Map<string, EventHandler[]>();
  const busHandlers = new Map<string, Array<(data: unknown) => void>>();
  const commands = new Map<string, CommandHandler>();
  const sent: Array<{
    message: Record<string, unknown>;
    options: Record<string, unknown> | undefined;
  }> = [];
  const userMessages: unknown[] = [];
  let hasPendingMessages = false;
  const context = {
    hasPendingMessages: () => hasPendingMessages,
    isIdle: () => false,
    ui: {
      notify() {},
    },
  } as unknown as ExtensionCommandContext;

  const pi = {
    on(event: string, handler: EventHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      emit(channel: string, data: unknown) {
        for (const handler of busHandlers.get(channel) ?? []) {
          handler(data);
        }
      },
      on(channel: string, handler: (data: unknown) => void) {
        busHandlers.set(channel, [...(busHandlers.get(channel) ?? []), handler]);
        return () => {
          busHandlers.set(
            channel,
            (busHandlers.get(channel) ?? []).filter(
              (candidate) => candidate !== handler,
            ),
          );
        };
      },
    },
    registerCommand(name: string, options: { handler: CommandHandler }) {
      commands.set(name, options.handler);
    },
    sendMessage(
      message: Record<string, unknown>,
      options?: Record<string, unknown>,
    ) {
      sent.push({ message, options });
    },
    sendUserMessage(message: unknown) {
      userMessages.push(message);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    sent,
    userMessages,
    context,
    setHasPendingMessages(value: boolean) {
      hasPendingMessages = value;
    },
    async runCommand(name: string, args: string) {
      const handler = commands.get(name);
      assert.ok(handler, `missing command handler for ${name}`);
      await handler(args, context);
    },
    emit(event: string, payload: Record<string, unknown> = {}) {
      return (handlers.get(event) ?? []).map((handler) =>
        handler({ type: event, ...payload }, context)
      );
    },
  };
}

function assistant(
  stopReason: string,
  content: unknown[],
): Record<string, unknown> {
  return {
    role: "assistant",
    stopReason,
    content,
  };
}

describe("compaction continuation Pi extension", () => {
  it("recognizes only a final reasoning-only length assistant outcome", () => {
    assert.equal(
      isReasoningOnlyLengthAgentEnd([
        { role: "user", content: "question" },
        assistant("length", [
          { type: "thinking", thinking: "unfinished reasoning" },
          { type: "text", text: " \n\t " },
        ]),
      ]),
      true,
    );

    assert.equal(
      isReasoningOnlyLengthAgentEnd([
        assistant("length", [
          { type: "thinking", thinking: "reasoning" },
          { type: "text", text: "visible answer" },
        ]),
      ]),
      false,
    );
    assert.equal(
      isReasoningOnlyLengthAgentEnd([
        assistant("stop", [{ type: "thinking", thinking: "reasoning" }]),
      ]),
      false,
    );
    assert.equal(
      isReasoningOnlyLengthAgentEnd([
        assistant("length", [{ type: "thinking", thinking: "reasoning" }]),
        assistant("error", []),
      ]),
      false,
    );
    assert.equal(isReasoningOnlyLengthAgentEnd([]), false);
  });

  it("queues exactly one hidden custom follow-up at successful threshold compaction", async () => {
    const wrapper = await loadWrapper();
    const harness = createHarness();
    wrapper(harness.pi);

    const messages = [
      assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
    ];
    harness.emit("agent_end", { messages });
    harness.emit("agent_end", { messages });
    harness.emit("session_before_compact", {
      reason: "threshold",
      willRetry: false,
    });
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });

    assert.deepEqual(harness.sent, [
      {
        message: {
          customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
          content: [],
          display: false,
        },
        options: { deliverAs: "followUp" },
      },
    ]);
    assert.deepEqual(
      harness.userMessages,
      [],
      "the continuation must remain a custom message, not a synthetic user message",
    );

    const marker = {
      role: "custom",
      customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
      content: [],
      display: false,
      timestamp: Date.now(),
    };
    harness.emit("message_end", { message: marker });
    assert.equal(marker.role, "bashExecution");
    assert.equal(
      (marker as Record<string, unknown>).excludeFromContext,
      true,
    );

    const userMessage = {
      role: "user",
      content: "question",
      timestamp: Date.now(),
    };
    const contextResults = harness.emit("context", {
      messages: [userMessage, marker],
    });
    assert.equal(contextResults.length, 1);
    const contextMessages = (
      contextResults[0] as { messages: Array<Record<string, unknown>> }
    ).messages;
    assert.deepEqual(contextMessages[0], userMessage);
    assert.deepEqual(
      {
        ...contextMessages[1],
        timestamp: 0,
      },
      {
        role: "custom",
        customType: PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
        content: PI_COMPACTION_CONTINUATION_CONTENT,
        display: false,
        timestamp: 0,
      },
    );
    assert.deepEqual(
      harness.emit("context", { messages: [marker] }),
      [{ messages: [] }],
      "the transient instruction must be injected only once",
    );

    harness.emit("agent_settled");
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });
    assert.equal(harness.sent.length, 1);
  });

  it("keeps the continuation control out of real Pi session persistence", async (t) => {
    for (const hostContext of ["minimal", "global", "project", "global-and-project"] as const) {
      await t.test(hostContext, async (t) => {
        const testRoot = await mkdtemp(
          join(tmpdir(), "minime-continuation-session-"),
        );
        t.after(async () => {
          await rm(testRoot, { recursive: true, force: true });
        });
        const agentDir = join(testRoot, "agent");
        await mkdir(agentDir, { recursive: true });
        const ambientDirs = [
          ...(hostContext.includes("global") ? [agentDir] : []),
          ...(hostContext.includes("project") ? [join(testRoot, ".pi")] : []),
        ];
        for (const dir of ambientDirs) {
          await mkdir(join(dir, "skills", "ambient"), { recursive: true });
          await mkdir(join(dir, "prompts"), { recursive: true });
          const ambient = "UNUSED_HOST_CONTEXT ".repeat(2_000);
          for (const file of ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"]) {
            await writeFile(join(dir, file), ambient);
          }
          await writeFile(join(dir, "skills/ambient/SKILL.md"), `---\nname: ambient\ndescription: ${ambient}\n---\n${ambient}`);
          await writeFile(join(dir, "prompts/ambient.md"), ambient);
        }
        const sessionDir = join(testRoot, "sessions");
        const sessionManager = SessionManager.create(testRoot, sessionDir);
        const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(agentDir, "auth.json") });
        const faux = fauxProvider({
          provider: "compaction-continuation-test",
          api: "compaction-continuation-test",
          models: [{
            id: "continuation-model",
            reasoning: true,
            contextWindow: 200_000,
            maxTokens: 1_024,
          }],
        });
        modelRuntime.registerNativeProvider(faux.provider);

        // Pi retries a length stop below the model's output budget as overflow.
        // Exhaust that budget to exercise threshold compaction and our continuation.
        let continuationRequest: Context | undefined;
        faux.setResponses([
          fauxAssistantMessage(fauxThinking("r".repeat(1_024 * 4)), {
            stopReason: "length",
          }),
          fauxAssistantMessage("compacted turn prefix"),
          (context) => {
            continuationRequest = context;
            return fauxAssistantMessage("continued final answer");
          },
        ]);

        const settingsManager = SettingsManager.inMemory({
          compaction: {
            enabled: true,
            // The controlled input is ~1.4K tokens; the 1K reasoning response
            // crosses this 2K threshold. Summary/continuation remain below it.
            reserveTokens: 198_000,
            keepRecentTokens: 1,
          },
          retry: { enabled: false },
        });
        const extensionPath = resolve("extensions/pi/compaction-continuation.ts");
        const resourceLoader = new DefaultResourceLoader({
          cwd: testRoot,
          agentDir,
          settingsManager,
          noExtensions: true,
          additionalExtensionPaths: [extensionPath],
          noContextFiles: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          systemPrompt: "Offline continuation fixture.",
          appendSystemPrompt: [],
        });
        await resourceLoader.reload();
        const { session, extensionsResult } = await createAgentSession({
          cwd: testRoot,
          agentDir,
          resourceLoader,
          modelRuntime,
          model: faux.getModel(),
          thinkingLevel: "off",
          settingsManager,
          sessionManager,
          noTools: "all",
        });

        try {
          assert.deepEqual(extensionsResult.errors, []);
          assert.deepEqual(extensionsResult.extensions.map(extension => extension.path), [extensionPath]);
          assert.deepEqual(resourceLoader.getAgentsFiles().agentsFiles, []);
          assert.deepEqual(resourceLoader.getSkills().skills, []);
          assert.deepEqual(resourceLoader.getPrompts().prompts, []);
          assert.deepEqual(resourceLoader.getThemes().themes, []);
          assert.equal(resourceLoader.getSystemPrompt(), "Offline continuation fixture.");
          assert.deepEqual(resourceLoader.getAppendSystemPrompt(), []);
          const compactions: string[] = [];
          const responseTokens: number[] = [];
          let settlements = 0;
          session.subscribe((event) => {
            if (event.type === "compaction_start") {
              assert.equal(responseTokens.length, 1, "compact after the reasoning response, not before it");
              compactions.push(event.reason);
            }
            if (event.type === "message_end" && event.message.role === "assistant") responseTokens.push(event.message.usage.totalTokens);
            if (event.type === "agent_settled") settlements += 1;
          });
          await session.prompt("fixture input ".repeat(400));
          assert.deepEqual(compactions, ["threshold"]);
          assert.equal(responseTokens.length, 2);
          assert.ok(responseTokens[0] > 2_000, "reasoning response crosses the controlled threshold");
          assert.ok(responseTokens[1] < 2_000, "continuation stays below the controlled threshold");
          assert.equal(settlements, 1);
          assert.equal(session.getLastAssistantText(), "continued final answer");
        } finally {
          session.dispose();
        }

        assert.equal(faux.state.callCount, 3);
        assert.ok(continuationRequest);
        const requestText = JSON.stringify(continuationRequest.messages);
        assert.equal(
          requestText.split(PI_COMPACTION_CONTINUATION_CONTENT).length - 1,
          1,
          "the continuation request must receive one transient instruction",
        );

        const sessionFile = sessionManager.getSessionFile();
        assert.ok(sessionFile);
        const persistedText = await readFile(sessionFile, "utf8");
        const persistedEntries = persistedText
          .trim()
          .split("\n")
          .slice(1)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(persistedEntries.filter(entry => entry.type === "compaction").length, 1);
        assert.equal(
          persistedEntries.some(
            (entry) =>
              entry.type === "custom_message" &&
              entry.customType === PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
          ),
          false,
        );
        assert.equal(
          persistedText.includes(PI_COMPACTION_CONTINUATION_CONTENT),
          false,
        );

        const resumed = SessionManager.open(sessionFile, sessionDir, testRoot);
        const resumedText = JSON.stringify(resumed.buildSessionContext().messages);
        assert.equal(
          resumedText.includes(PI_COMPACTION_CONTINUATION_CUSTOM_TYPE),
          false,
        );
        assert.equal(
          resumedText.includes(PI_COMPACTION_CONTINUATION_CONTENT),
          false,
        );
      });
    }
  });

  it("clears the arm when a later agent outcome does not match", async () => {
    const wrapper = await loadWrapper();
    const harness = createHarness();
    wrapper(harness.pi);

    harness.emit("agent_end", {
      messages: [
        assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
      ],
    });
    harness.emit("agent_end", {
      messages: [
        assistant("length", [{ type: "text", text: "already visible" }]),
      ],
    });
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });

    assert.deepEqual(harness.sent, []);
  });

  it("ignores manual and overflow-retry compaction boundaries", async () => {
    const wrapper = await loadWrapper();

    for (const boundary of [
      { reason: "manual", willRetry: false },
      { reason: "overflow", willRetry: true },
      { reason: "overflow", willRetry: false },
      { reason: "threshold", willRetry: true },
    ]) {
      const harness = createHarness();
      wrapper(harness.pi);
      harness.emit("agent_end", {
        messages: [
          assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
        ],
      });
      harness.emit("session_before_compact", boundary);
      harness.emit("session_compact", boundary);
      harness.emit("session_compact", {
        reason: "threshold",
        willRetry: false,
      });
      assert.deepEqual(harness.sent, [], JSON.stringify(boundary));
    }
  });

  it("does not continue after failed or aborted compaction settles", async () => {
    const wrapper = await loadWrapper();
    const harness = createHarness();
    wrapper(harness.pi);

    harness.emit("agent_end", {
      messages: [
        assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
      ],
    });
    harness.emit("session_before_compact", {
      reason: "threshold",
      willRetry: false,
    });
    harness.emit("agent_settled");
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });

    assert.deepEqual(harness.sent, []);
    assert.deepEqual(harness.userMessages, []);
  });

  it("clears the arm when another run starts or the session shuts down", async () => {
    const wrapper = await loadWrapper();

    for (const resetEvent of ["agent_start", "session_shutdown"]) {
      const harness = createHarness();
      wrapper(harness.pi);
      harness.emit("agent_end", {
        messages: [
          assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
        ],
      });
      harness.emit(resetEvent);
      harness.emit("session_compact", {
        reason: "threshold",
        willRetry: false,
      });
      assert.deepEqual(harness.sent, [], resetEvent);
    }
  });

  it("uses already queued user work instead of appending an internal continuation", async () => {
    const wrapper = await loadWrapper();
    const harness = createHarness();
    wrapper(harness.pi);

    harness.emit("agent_end", {
      messages: [
        assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
      ],
    });
    harness.setHasPendingMessages(true);
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });

    assert.deepEqual(harness.sent, []);
  });

  it("does not append an internal continuation behind acknowledged steering", async () => {
    const acknowledgedSteer = await loadWrapper("acknowledged-steer");
    const continuation = await loadWrapper();
    const harness = createHarness();
    acknowledgedSteer(harness.pi);
    continuation(harness.pi);

    harness.emit("agent_start");
    harness.emit("agent_end", {
      messages: [
        assistant("length", [{ type: "thinking", thinking: "unfinished" }]),
      ],
    });
    const command = buildPiAcknowledgedSteerInvocation(
      "during-compaction",
      "apply the user's newer direction",
    );
    await harness.runCommand(
      PI_ACKNOWLEDGED_STEER_COMMAND,
      command.slice(command.indexOf(" ") + 1),
    );
    harness.emit("session_compact", {
      reason: "threshold",
      willRetry: false,
    });

    assert.deepEqual(harness.sent, [{
      message: {
        customType: PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE,
        content: "apply the user's newer direction",
        display: false,
        details: { requestId: "during-compaction" },
      },
      options: { deliverAs: "steer" },
    }]);
    assert.equal(
      harness.sent.some(
        ({ message }) =>
          message.customType === PI_COMPACTION_CONTINUATION_CUSTOM_TYPE,
      ),
      false,
    );
  });
});
