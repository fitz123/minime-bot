import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

it("native Pi uses live effort for the next request in the same tool loop", { timeout: 20_000 }, async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "minime-effort-native-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(cwd, "auth.json") });
  const faux = fauxProvider({ provider: "effort-test", models: [{ id: "reasoner", reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const levels: unknown[] = [];
  let started!: () => void;
  const firstRequest = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  faux.setResponses([
    async (_context, options) => {
      levels.push(options?.reasoning);
      started();
      await gate;
      return fauxAssistantMessage(fauxToolCall("continue_test", {}), { stopReason: "toolUse" });
    },
    (_context, options) => { levels.push(options?.reasoning); return fauxAssistantMessage("done"); },
  ]);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const { session } = await createAgentSession({
    cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: faux.getModel(),
    settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), noTools: "all",
    customTools: [{ name: "continue_test", label: "Continue", description: "Continue test", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) }],
  });
  try {
    assert.equal(session.thinkingLevel, "medium", "pinned SDK native fallback");
    session.setThinkingLevel("low");
    const run = session.prompt("test");
    await firstRequest;
    session.setThinkingLevel("high");
    release();
    await run;
    assert.deepEqual(levels, ["low", "high"]);
    assert.equal(settings.getDefaultThinkingLevel(), undefined, "session setter does not persist global defaults");
  } finally { release(); session.dispose(); }
});

it("native Pi advertises and sends max when the current model supports it", { timeout: 20_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "minime-effort-native-max-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(cwd, "auth.json") });
  const faux = fauxProvider({ provider: "effort-max-test", models: [{ id: "reasoner", reasoning: true }] });
  faux.getModel().thinkingLevelMap = { max: "max" };
  runtime.registerNativeProvider(faux.provider);
  const levels: unknown[] = [];
  faux.setResponses([(_context, options) => {
    levels.push(options?.reasoning);
    return fauxAssistantMessage("done");
  }]);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const { session } = await createAgentSession({
    cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: faux.getModel(),
    settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), noTools: "all",
  });
  try {
    assert.deepEqual(session.getAvailableThinkingLevels(), ["off", "minimal", "low", "medium", "high", "max"]);
    session.setThinkingLevel("max");
    assert.equal(session.thinkingLevel, "max");
    await session.prompt("test");
    assert.deepEqual(levels, ["max"]);
    assert.equal(settings.getDefaultThinkingLevel(), undefined);
  } finally { session.dispose(); }
});

it("installed Pi extension changes effort through its tool and waits for durable acknowledgement", { timeout: 20_000 }, async t => {
  const { resolve } = await import("node:path");
  const { SESSION_EFFORT_ENV, SESSION_EFFORT_COMMAND, SESSION_EFFORT_ACK_COMMAND, parseEffortNotice, effortInvocation } = await import("../pi-extensions/session-effort.js");
  const cwd = await mkdtemp(join(tmpdir(), "minime-effort-extension-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const previous = process.env[SESSION_EFFORT_ENV];
  process.env[SESSION_EFFORT_ENV] = JSON.stringify({ inherited: "low", override: "medium" });
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(cwd, "auth.json") });
  const faux = fauxProvider({ provider: "effort-extension-test", models: [{ id: "reasoner", reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const levels: unknown[] = [];
  faux.setResponses([
    (_context, options) => { levels.push(options?.reasoning); return fauxAssistantMessage(fauxToolCall("set_session_effort", { level: "high" }), { stopReason: "toolUse" }); },
    (_context, options) => { levels.push(options?.reasoning); return fauxAssistantMessage("effort changed"); },
  ]);
  const settings = SettingsManager.inMemory({ extensions: [resolve("extensions/pi/session-effort.ts")], defaultThinkingLevel: "minimal", modelThinkingLevels: { "effort-extension-test/reasoner": "medium" }, compaction: { enabled: false }, retry: { enabled: false } });
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: faux.getModel(), settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), tools: ["set_session_effort"] });
  let saved = false;
  let requestId: string | undefined;
  try {
    assert.deepEqual(extensionsResult.errors, []);
    await session.bindExtensions({ uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: message => {
        const notice = parseEffortNotice(message);
        if (notice?.kind === "request") {
          requestId = notice.id;
          void session.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: notice.id, value: notice.value }));
        } else if (notice?.kind === "result" && notice.id === requestId) {
          assert.equal(notice.effective, "high");
          assert.ok(notice.levels.includes("high"));
          saved = true;
          void session.prompt(effortInvocation(SESSION_EFFORT_ACK_COMMAND, { id: requestId, text: "Saved thread effort: high", ok: true }));
        }
      },
    } });
    assert.equal(session.thinkingLevel, "medium", "stored thread override is applied at startup");
    await session.prompt("Please set effort to high for this thread");
    assert.equal(saved, true);
    assert.deepEqual(levels, ["medium", "high"]);
    assert.match(JSON.stringify(session.messages), /Saved thread effort: high/);
    assert.equal(settings.getDefaultThinkingLevel(), "minimal");
    await session.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: "reset", value: "default", inherited: "low" }));
    assert.equal(session.thinkingLevel, "low");
    await session.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: "reset-native", value: "default" }));
    assert.equal(session.thinkingLevel, "medium", "native per-model default precedes global fallback");
  } finally {
    session.dispose();
    if (previous === undefined) delete process.env[SESSION_EFFORT_ENV]; else process.env[SESSION_EFFORT_ENV] = previous;
  }
});
