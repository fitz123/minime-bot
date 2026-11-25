import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createAgentSession, ModelRuntime, resolveCliModel, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { SESSION_EFFORT_ENV, SESSION_EFFORT_COMMAND, SESSION_EFFORT_ACK_COMMAND, parseEffortNotice, effortInvocation, parseEffortAction } from "../session-effort-wire.js";
import { buildPiAcknowledgedSteerInvocation, parsePiAcknowledgedSteerResultNotice } from "../pi-extensions/acknowledged-steer.js";
import { buildPiSpawnArgs, PI_PROVIDER } from "../pi-rpc-protocol.js";
import type { NativeEffortLevel, PiThinkingLevel } from "../types.js";

function effortEnvironment(t: { after: (fn: () => void) => void }, cwd: string, initial: object): void {
  for (const [key, value] of Object.entries({
    [SESSION_EFFORT_ENV]: JSON.stringify(initial),
    MINIME_BOT_PI_SESSION_AGENT_ID: "personal",
    MINIME_CONTROL_WORKSPACE_ROOT: cwd,
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

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
  const cwd = await mkdtemp(join(tmpdir(), "minime-effort-extension-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  effortEnvironment(t, cwd, { inherited: "low", override: "medium" });
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(cwd, "auth.json") });
  const faux = fauxProvider({ provider: "effort-extension-test", models: [{ id: "reasoner", reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  const levels: unknown[] = [];
  const responses: Parameters<typeof faux.setResponses>[0] = [
    (_context, options) => { levels.push(options?.reasoning); return fauxAssistantMessage(fauxToolCall("set_session_effort", { level: "high" }), { stopReason: "toolUse" }); },
    (_context, options) => { levels.push(options?.reasoning); return fauxAssistantMessage("effort changed"); },
  ];
  faux.setResponses(responses);
  const settings = SettingsManager.inMemory({ extensions: [resolve("extensions/pi/session-effort.ts")], defaultThinkingLevel: "minimal", modelThinkingLevels: { "effort-extension-test/reasoner": "medium" }, compaction: { enabled: false }, retry: { enabled: false } });
  const nativeStore = SessionManager.inMemory(cwd);
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: faux.getModel(), settingsManager: settings, sessionManager: nativeStore, tools: ["set_session_effort"] });
  let saved = false;
  let rejectTranscript = false;
  let requestId: string | undefined;
  try {
    assert.deepEqual(extensionsResult.errors, []);
    await session.bindExtensions({ uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify: message => {
        const notice = parseEffortNotice(message);
        if (notice?.kind === "request") {
          requestId = notice.id;
          void session.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: notice.id, action: parseEffortAction(notice.value) }));
        } else if (notice?.kind === "result" && notice.id === requestId) {
          assert.equal(notice.effective, rejectTranscript ? "low" : "high");
          assert.ok(notice.levels.includes("high"));
          assert.equal(Boolean(notice.error), rejectTranscript);
          assert.doesNotMatch(notice.error ?? "", /could not be restored/i);
          saved = !notice.error;
          void session.prompt(effortInvocation(SESSION_EFFORT_ACK_COMMAND, { id: requestId, text: notice.error ?? "Saved thread effort: high", ok: saved }));
        }
      },
    } });
    assert.equal(session.thinkingLevel, "medium", "stored thread override is applied at startup");
    await session.prompt("Please set effort to high for this thread");
    assert.equal(saved, true);
    assert.deepEqual(levels, ["medium", "high"]);
    assert.match(JSON.stringify(session.messages), /Saved thread effort: high/);
    assert.equal(settings.getDefaultThinkingLevel(), "minimal");
    await session.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: "reset", action: { kind: "inherit" } }));
    assert.equal(session.thinkingLevel, "low");
    rejectTranscript = true;
    const append = t.mock.method(nativeStore, "appendThinkingLevelChange", () => { throw new Error("simulated transcript write failure"); });
    faux.setResponses(responses);
    await session.prompt("Ask the tool to change effort again");
    assert.equal(append.mock.callCount(), 2, "Pi attempts to persist both the rejected level and the native restoration");
    assert.equal(saved, false);
    assert.equal(session.thinkingLevel, "low");
    assert.deepEqual(levels.slice(2), ["low", "low"], "the next provider request keeps the previous effort");
  } finally {
    session.dispose();
  }
});

for (const scenario of [
  { name: "model suffix", id: "reasoner", pattern: "reasoner:high", expected: "high", perModel: "medium" },
  { name: "explicit thinking over suffix", id: "reasoner", pattern: "reasoner:high", thinking: "low", expected: "low", perModel: "medium" },
  { name: "per-model default", id: "reasoner", pattern: "reasoner", expected: "medium", perModel: "medium" },
  { name: "global default", id: "reasoner", pattern: "reasoner", expected: "minimal" },
  { name: "literal colon model ID", id: "reasoner:high", pattern: "reasoner:high", expected: "medium", perModel: "medium" },
  { name: "literal non-effort colon model ID", id: "reasoner:extended", pattern: "reasoner:extended", expected: "minimal" },
  { name: "spawn provider for a cross-provider literal ID", id: "openai/gpt-6-sol", pattern: "openai/gpt-6-sol", provider: PI_PROVIDER, thinking: "high", expected: "high", perModel: "medium" },
] as const) {
  it(`inherits ${scenario.name} at startup, reset and resume without changing models`, { timeout: 20_000 }, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "minime-effort-inheritance-"));
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(cwd, "auth.json") });
    const provider = "provider" in scenario ? scenario.provider : "effort-inheritance-test";
    const faux = fauxProvider({ provider, models: [{ id: scenario.id, reasoning: true }] });
    runtime.registerNativeProvider(faux.provider);
    let configured: { model: string; inherited?: PiThinkingLevel; provider?: string } = {
      model: `${provider}/${scenario.pattern}`, inherited: "thinking" in scenario ? scenario.thinking : undefined,
    };
    if ("provider" in scenario) {
      runtime.registerNativeProvider(fauxProvider({ provider: "openai", models: [{ id: "gpt-6-sol", reasoning: true }] }).provider);
      await runtime.refresh({ allowNetwork: false });
      const args = buildPiSpawnArgs({ id: "fixture", workspaceCwd: cwd, model: scenario.pattern, thinking: scenario.thinking });
      configured = {
        provider: args[args.indexOf("--provider") + 1],
        model: args[args.indexOf("--model") + 1],
        inherited: args[args.indexOf("--thinking") + 1] as PiThinkingLevel,
      };
      assert.equal(resolveCliModel({ cliModel: configured.model, modelRuntime: runtime }).model?.provider, "openai");
    }
    const resolved = resolveCliModel({ cliProvider: configured.provider, cliModel: configured.model, cliThinking: configured.inherited, modelRuntime: runtime });
    assert.equal(resolved.error, undefined);
    assert.equal(resolved.model?.id, scenario.id, "native CLI resolution keeps the intended model");
    assert.equal(resolved.model?.provider, provider);
    const perModel = "perModel" in scenario ? scenario.perModel : undefined;
    const settings = SettingsManager.inMemory({
      extensions: [resolve("extensions/pi/session-effort.ts")], defaultThinkingLevel: "minimal",
      modelThinkingLevels: perModel ? { [`${provider}/${scenario.id}`]: perModel } : {},
      compaction: { enabled: false }, retry: { enabled: false },
    });
    effortEnvironment(t, cwd, configured);
    const nativeStore = SessionManager.create(cwd, join(cwd, "sessions"));
    const options = { cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model: resolved.model!, settingsManager: settings, noTools: "all" as const };
    let active: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const created = await createAgentSession({ ...options, sessionManager: nativeStore, thinkingLevel: configured.inherited ?? resolved.thinkingLevel });
      active = created.session;
      assert.deepEqual(created.extensionsResult.errors, []);
      await active.bindExtensions({});
      assert.equal(active.thinkingLevel, scenario.expected);
      const reset = async () => {
        await active!.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: "change", action: { kind: "override", level: "high" } }));
        await active!.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: "reset", action: { kind: "inherit" }, ...configured }));
        assert.equal(active!.thinkingLevel, scenario.expected);
        assert.equal(active!.model?.id, scenario.id);
        assert.equal(active!.model?.provider, provider);
        assert.equal(settings.getDefaultThinkingLevel(), "minimal");
      };
      await reset();
      faux.setResponses([fauxAssistantMessage("Persisted reply")]);
      await active.prompt("Keep this exchange in the transcript");
      const stale = scenario.expected === "low" ? "medium" : "low";
      active.setThinkingLevel(stale);
      const file = nativeStore.getSessionFile()!;
      const sessionId = nativeStore.getSessionId();
      active.dispose();
      active = undefined;
      // Resume native saved effort without an override: configured inheritance
      // still wins over the last native thinking entry.
      const reopened = SessionManager.open(file);
      assert.equal(reopened.getSessionId(), sessionId);
      const resumed = await createAgentSession({ ...options, sessionManager: reopened });
      active = resumed.session;
      assert.match(JSON.stringify(active.messages), /Keep this exchange in the transcript/);
      assert.equal(active.thinkingLevel, stale);
      await active.bindExtensions({});
      assert.equal(active.thinkingLevel, scenario.expected);
      await reset();
      active.dispose();
      active = undefined;
      process.env[SESSION_EFFORT_ENV] = JSON.stringify({ ...configured, override: "high" satisfies NativeEffortLevel });
      const overridden = await createAgentSession({ ...options, sessionManager: SessionManager.open(file) });
      active = overridden.session;
      await active.bindExtensions({});
      assert.equal(active.thinkingLevel, "high", "thread override wins on resume");
      await reset();
    } finally {
      active?.dispose();
    }
  });
}

it("native Pi refreshes agent/model defaults for acknowledged Telegram steers and read-only Discord conversations", { timeout: 20_000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), "minime-effort-default-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  effortEnvironment(t, cwd, {});
  const runtime = await ModelRuntime.create({ modelsPath: null, authPath: join(cwd, "auth.json") });
  const faux = fauxProvider({ provider: "effort-default-test", models: [
    { id: "reasoner", reasoning: true },
    { id: "other-model", reasoning: true },
  ] });
  const otherProvider = fauxProvider({ provider: "effort-other-provider", models: [{ id: "reasoner", reasoning: true }] });
  runtime.registerNativeProvider(faux.provider);
  runtime.registerNativeProvider(otherProvider.provider);
  const settings = SettingsManager.inMemory({
    extensions: [resolve("extensions/pi/acknowledged-steer.ts"), resolve("extensions/pi/session-effort.ts")], defaultThinkingLevel: "low",
    compaction: { enabled: false }, retry: { enabled: false },
  });
  async function open(agent: string, model = faux.getModel("reasoner"), override?: NativeEffortLevel, nativeStore = SessionManager.create(cwd, join(cwd, "sessions")), readOnly = false) {
    process.env.MINIME_BOT_PI_SESSION_AGENT_ID = agent;
    process.env[SESSION_EFFORT_ENV] = JSON.stringify({ override, readOnly });
    const { session, extensionsResult } = await createAgentSession({
      cwd, agentDir: join(cwd, "agent"), modelRuntime: runtime, model,
      settingsManager: settings, sessionManager: nativeStore, tools: [],
    });
    assert.deepEqual(extensionsResult.errors, []);
    const notices: string[] = [];
    await session.bindExtensions({ uiContext: { ...session.extensionRunner.getUIContext(), notify: message => notices.push(message) } });
    t.after(() => session.dispose());
    return { session, nativeStore, notices };
  }

  const first = await open("personal");
  const second = await open("personal", undefined, undefined, undefined, true);
  assert.equal(second.session.extensionRunner.getCommand(SESSION_EFFORT_COMMAND), undefined);
  assert.equal(second.session.extensionRunner.getCommand(SESSION_EFFORT_ACK_COMMAND), undefined);
  assert.ok(!second.session.getAllTools().some(tool => tool.name === "set_session_effort"));
  const pinned = await open("personal", undefined, "minimal");
  const otherAgent = await open("another");
  const otherModel = await open("personal", faux.getModel("other-model"));
  const otherProviderSession = await open("personal", otherProvider.getModel());
  const seen: unknown[] = [];
  const respond: Parameters<typeof faux.setResponses>[0][number] = (_context, options) => {
    seen.push(options?.reasoning);
    return fauxAssistantMessage("done");
  };
  faux.setResponses([respond]);
  await second.session.prompt("Keep this message in history");

  // The native provider has already captured the current request by the time
  // the default is changed. The acknowledged steer must use the new default.
  let started!: () => void;
  const startedRequest = new Promise<void>(resolve => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  faux.setResponses([
    async (_context, options) => {
      seen.push(options?.reasoning);
      started();
      await gate;
      return fauxAssistantMessage("first answer");
    },
    (...args) => {
      const [context] = args;
      assert.match(JSON.stringify(context.messages), /Steered Telegram message/);
      return respond(...args);
    },
  ]);
  const run = first.session.prompt("Start a request");
  try {
    await startedRequest;
    await pinned.session.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: "default", action: { kind: "default", level: "high" } }));
    assert.deepEqual(parseEffortNotice(pinned.notices.at(-1)), {
      kind: "result", id: "default", effective: "minimal", source: "conversation override",
      levels: ["off", "minimal", "low", "medium", "high"],
    });
    assert.equal(first.session.thinkingLevel, "low");
    await first.session.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: "status", action: { kind: "status" } }));
    assert.deepEqual(parseEffortNotice(first.notices.at(-1)), {
      kind: "result", id: "status", effective: "high", source: "agent default", running: "low",
      levels: ["off", "minimal", "low", "medium", "high"],
    });
    await first.session.prompt(buildPiAcknowledgedSteerInvocation("telegram-steer", "Steered Telegram message"));
  } finally { release(); }
  await run;
  assert.deepEqual(seen, ["low", "low", "high"]);
  assert.deepEqual(first.notices.map(parsePiAcknowledgedSteerResultNotice).filter(Boolean), [
    { id: "telegram-steer", status: "enqueued" }, { id: "telegram-steer", status: "consumed" },
  ]);

  faux.setResponses([respond, respond, respond, respond]);
  otherProvider.setResponses([respond]);
  await second.session.prompt("Use the updated default here");
  await pinned.session.prompt("Keep this conversation pinned");
  await otherAgent.session.prompt("Keep this agent's level");
  await otherModel.session.prompt("Keep this model's level");
  await otherProviderSession.session.prompt("Keep this provider's level");
  assert.deepEqual(seen.slice(3), ["high", "minimal", "low", "low", "low"]);

  const file = second.nativeStore.getSessionFile()!;
  second.session.dispose();
  const resumed = await open("personal", undefined, undefined, SessionManager.open(file), true);
  const fresh = await open("personal", undefined, undefined, undefined, true);
  assert.equal(resumed.session.thinkingLevel, "high");
  assert.match(JSON.stringify(resumed.session.messages), /Keep this message in history/);
  assert.equal(fresh.session.thinkingLevel, "high");
  await pinned.session.prompt(effortInvocation(SESSION_EFFORT_COMMAND, { id: "inherit", action: { kind: "inherit" } }));
  assert.equal(pinned.session.thinkingLevel, "high");
  assert.equal(settings.getDefaultThinkingLevel(), "low");
});
