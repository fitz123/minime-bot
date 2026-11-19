/** Offline installed-package verifier. All writes are confined to a disposable fixture. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { stream as buildCodexRequest } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { formatFastStatusLine, PI_FAST_THREAD_ENV } from "./codex-fast.js";
import { CRON_FAST_OFF_ENV, isCronFastOff } from "./cron-fast-env.js";
import { buildStatusReport } from "./status-report.js";
import { EXPECTED_PI_PACKAGE_VERSION, resolvePackageOwnedPiInvocation } from "./pi-runtime.js";
import { MINIME_CONFIG_PATH_ENV, MINIME_CONTROL_WORKSPACE_ROOT_ENV, MINIME_INSTANCE_CONFIG_PATH_ENV } from "./workspace-contract.js";

export async function verifyCodexFast(extensionPath?: string): Promise<{ piVersion: string; requestChecks: number; commandsChecked: number }> {
  for (const name of ["pi-ai", "pi-agent-core", "pi-tui", "pi-coding-agent"]) {
    const packageName = `@earendil-works/${name}`;
    let current = dirname(fileURLToPath(import.meta.resolve(packageName)));
    for (;;) {
      const manifest = join(current, "package.json");
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, "utf8"));
        if (pkg.name === packageName) { assert.equal(pkg.version, EXPECTED_PI_PACKAGE_VERSION, packageName); break; }
      }
      const parent = dirname(current);
      assert.notEqual(parent, current, `Cannot locate ${packageName} manifest`);
      current = parent;
    }
  }
  assert.equal(resolvePackageOwnedPiInvocation("rpc", []).diagnostic.versionMismatch, false);
  const root = mkdtempSync(join(tmpdir(), "minime-fast-verify-"));
  const envKeys = ["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", MINIME_CONTROL_WORKSPACE_ROOT_ENV, MINIME_CONFIG_PATH_ENV, MINIME_INSTANCE_CONFIG_PATH_ENV, "MINIME_BOT_PI_SESSION_AGENT_ID", PI_FAST_THREAD_ENV, CRON_FAST_OFF_ENV];
  const previous = new Map(envKeys.map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  let requestChecks = 0;
  let commandsChecked = 0;
  try {
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = join(root, "agent");
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";
    process.env[MINIME_CONTROL_WORKSPACE_ROOT_ENV] = root;
    process.env[MINIME_CONFIG_PATH_ENV] = join(root, "config.yaml");
    delete process.env[MINIME_INSTANCE_CONFIG_PATH_ENV];
    process.env.MINIME_BOT_PI_SESSION_AGENT_ID = "fixture-primary";
    process.env[PI_FAST_THREAD_ENV] = "fixture-chat:one";
    delete process.env[CRON_FAST_OFF_ENV];
    globalThis.fetch = async () => { throw new Error("Offline verifier forbids provider/network calls"); };
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    // Synthetic bindings allow the regular no-resolve-secrets config loader.
    const agent = { workspaceCwd: root, model: "openai-codex/gpt-6-astra", thinking: "high" as const, codexFast: { provider: "openai-codex" as const, model: "gpt-6-astra" } };
    const config = { agents: { "fixture-primary": agent, "fixture-other": { ...agent, codexFast: undefined } }, telegramTokenEnv: "UNUSED_FAST_VERIFIER_TOKEN", bindings: [{ chatId: 1, agentId: "fixture-primary", kind: "dm" }] };
    writeFileSync(join(root, "config.yaml"), JSON.stringify(config));
    const sourceDir = dirname(fileURLToPath(import.meta.url));
    const wrapper = extensionPath ?? (existsSync(join(sourceDir, "extensions/pi/codex-fast.js"))
      ? join(sourceDir, "extensions/pi/codex-fast.js") : resolve(sourceDir, "../extensions/pi/codex-fast.ts"));
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true, noThemes: true, additionalExtensionPaths: [wrapper] });
    await resourceLoader.reload();
    assert.deepEqual(resourceLoader.getExtensions().errors, []);
    assert.deepEqual(resourceLoader.getExtensions().extensions.map(ext => ext.path), [wrapper]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null });
    const created = await createAgentSession({ cwd: root, agentDir, resourceLoader, settingsManager, modelRuntime, model: OPENAI_CODEX_MODELS["gpt-6-astra"], thinkingLevel: "high", noTools: "all", sessionManager: SessionManager.inMemory(root) });
    session = created.session;
    assert.deepEqual(created.extensionsResult.errors, []);
    assert.ok(session.extensionRunner.getCommand("fast"));
    const errors: string[] = [];
    session.extensionRunner.onError(error => errors.push(error.error));
    const notices: string[] = [];
    session.extensionRunner.setUIContext({ ...session.extensionRunner.getUIContext(), notify: text => { notices.push(text); } });
    session.subscribe(event => { assert.notEqual(event.type, "agent_start", "Commands must never invoke an LLM"); });
    const command = async (args: string, expected: RegExp) => {
      const count = notices.length;
      await session!.prompt(`/fast${args ? ` ${args}` : ""}`);
      assert.equal(notices.length, count + 1);
      assert.match(notices.at(-1)!, expected);
      if (!isCronFastOff(process.env) && notices.at(-1)!.startsWith("Fast:")) {
        assert.equal(notices.at(-1)!.split("\n").length, 4);
        assert.match(notices.at(-1)!, /Модель: Astra/);
        assert.match(notices.at(-1)!, /Общий режим fixture-primary\/Astra:/);
        assert.doesNotMatch(notices.at(-1)!, /service_tier|priority|Backend/);
      }
      commandsChecked++;
    };
    const payload = { model: "gpt-6-astra", reasoning: { effort: "high" }, input: [] };
    const check = async (priority: boolean, body: Record<string, unknown> = payload) => {
      const original = structuredClone(body);
      const result = await session!.extensionRunner.emitBeforeProviderRequest(body);
      assert.deepEqual(result, priority ? { ...body, service_tier: "priority" } : body);
      assert.deepEqual(body, original, "Hook must preserve original payload");
      assert.deepEqual((result as typeof payload).reasoning, body.reasoning);
      assert.equal((result as typeof payload).model, body.model);
      requestChecks++;
    };
    const preferencesPath = join(root, "data/codex-fast.json");
    await command("help", /service_tier=priority/);
    await command("", /Fast: выключен/); await check(false);
    assert.equal(existsSync(preferencesPath), false, "Help/status must not create preferences");
    await command("on", /Этот тред: включён \(переопределение\)/); await check(true);
    await command("off", /Fast: выключен/); await check(false);
    await command("inherit", /Этот тред: по умолчанию/); await check(false);
    await command("default on", /Общий режим .*: включён/); await check(true);
    await command("off", /Этот тред: выключен \(переопределение\)/); await check(false);
    process.env[PI_FAST_THREAD_ENV] = "fixture-chat:two";
    await command("", /Этот тред: по умолчанию/); await check(true);
    const statusScope = { agent: { ...agent, id: "fixture-primary" }, threadKey: process.env[PI_FAST_THREAD_ENV] };
    const beforeStatus = readFileSync(preferencesPath, "utf8");
    const fastStatusLine = formatFastStatusLine(statusScope, agent.model);
    assert.equal(fastStatusLine, "Fast: on · inherited");
    const report = buildStatusReport({
      activeCount: 1, maxSessions: 2, uptimeSeconds: 60, fastStatusLine,
      sessionHealth: { agentId: "fixture-primary", model: agent.model, thinking: "high", provider: "pi", sessionId: "fixture-session", pid: null, alive: true, idleMs: 0, processingMs: null, lastSuccessAt: Date.now(), restartCount: 0 },
    });
    assert.match(report, /Model: openai-codex\/gpt-6-astra\nThinking: high\nFast: on · inherited\nState:/);
    assert.match(report, /Session ID: fixture-session/);
    assert.match(report, /Codex quota:/);
    assert.equal(readFileSync(preferencesPath, "utf8"), beforeStatus);
    await command("on", /Этот тред: включён \(переопределение\)/);
    await command("default off", /Общий режим .*: выключен/); await check(true);
    process.env[PI_FAST_THREAD_ENV] = "fixture-chat:one"; await check(false);
    await command("inherit", /Этот тред: по умолчанию/); await check(false);
    await command("default on", /Общий режим .*: включён/);
    delete process.env[PI_FAST_THREAD_ENV];
    await command("", /Область: только общий режим \(без треда\)/); await check(true);
    await command("status", /Область: только общий режим \(без треда\)/);
    await command("off", /No identified chat/); await check(true);
    await command("default status", /Общий режим .*: включён/);
    await command("default inherit", /Usage:/);
    await command("on extra", /Usage:/);
    await check(false, { ...payload, service_tier: "auto" });
    await check(false, { ...payload, service_tier: "priority" });
    await command("default off", /Общий режим .*: выключен/);
    await check(false, { ...payload, service_tier: "priority" });
    await check(false, { ...payload, model: "another-model" });
    await command("default on", /Общий режим .*: включён/);
    for (const id of ["fixture-other", "unknown", ""]) {
      process.env.MINIME_BOT_PI_SESSION_AGENT_ID = id;
      await check(false); await command("on", /unavailable/);
    }
    process.env.MINIME_BOT_PI_SESSION_AGENT_ID = "fixture-primary";
    // The native scope uses ctx.model, not a replacement configured model.
    writeFileSync(join(root, "config.yaml"), JSON.stringify({ ...config, agents: { ...config.agents, "fixture-primary": { ...agent, model: "openai-codex/gpt-6-sol", codexFast: { provider: "openai-codex", model: "gpt-6-sol" } } } }));
    const beforeHelp = readFileSync(preferencesPath, "utf8");
    await command("status", /unavailable/);
    assert.equal(readFileSync(preferencesPath, "utf8"), beforeHelp);
    await check(false);
    // Configuration is re-read by the already-loaded hook.
    writeFileSync(join(root, "config.yaml"), JSON.stringify({ ...config, agents: { ...config.agents, "fixture-primary": { ...agent, codexFast: undefined } } }));
    await check(false);
    await command("help", /\/fast default on\|off\|status/);
    // Help must not even need valid opt-in configuration or preferences.
    writeFileSync(join(root, "config.yaml"), "invalid fixture config");
    await command("help", /выданный сервером приоритет неизвестен/);
    assert.equal(readFileSync(preferencesPath, "utf8"), beforeHelp);
    writeFileSync(join(root, "config.yaml"), JSON.stringify(config));
    await check(true);
    // Execute Pi's real Codex request builder, stopping inside onPayload before
    // any transport. The token contains only synthetic fixture claims.
    const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
    const built: Record<string, unknown>[] = [];
    for (const mode of ["on", "off", "cron"]) {
      if (mode === "cron") process.env[CRON_FAST_OFF_ENV] = "1";
      else await command(`default ${mode}`, /Общий режим /);
      const result = await buildCodexRequest(OPENAI_CODEX_MODELS["gpt-6-astra"], normalizeContext({ messages: [{ role: "user", content: "offline fixture", timestamp: 0 }] }), {
        apiKey: token, reasoningEffort: "high", transport: "sse",
        onPayload: async body => {
          built.push(await session!.extensionRunner.emitBeforeProviderRequest(body) as Record<string, unknown>);
          throw new Error("offline-verifier-stop-before-transport");
        },
      }).result();
      assert.equal(result.stopReason, "error");
      assert.match(result.errorMessage!, /offline-verifier-stop-before-transport/);
      requestChecks++;
    }
    delete process.env[CRON_FAST_OFF_ENV];
    assert.equal(built.length, 3);
    assert.deepEqual(built[0], { ...built[1], service_tier: "priority" });
    assert.deepEqual(built[2], { ...built[1], service_tier: "default" });
    assert.equal(built[1].model, "gpt-6-astra");
    assert.deepEqual(built[1].reasoning, { effort: "high", summary: "auto" });
    assert.equal("service_tier" in built[1], false);
    // The loaded hook must bypass scope/config/preferences even for unopted or
    // unidentified cron descendants, and must replace independently set tiers.
    const checkCron = async () => {
      for (const tier of [undefined, "priority", "auto", "default"]) {
        const body = { ...payload, ...(tier === undefined ? {} : { service_tier: tier }) };
        const original = structuredClone(body);
        assert.deepEqual(await session!.extensionRunner.emitBeforeProviderRequest(body), { ...body, service_tier: "default" });
        assert.deepEqual(body, original);
        requestChecks++;
      }
      for (const args of ["", "status", "on", "off", "inherit", "default on", "default off", "default status", "help"]) {
        await command(args, /Fast: off \(enforced for cron jobs\)/);
      }
    };
    for (const enabled of [true, false]) {
      await command(`default ${enabled ? "on" : "off"}`, /Общий режим /);
      const beforeCron = readFileSync(preferencesPath, "utf8");
      process.env[CRON_FAST_OFF_ENV] = "1";
      for (const id of ["fixture-primary", "fixture-other", ""]) {
        process.env.MINIME_BOT_PI_SESSION_AGENT_ID = id;
        await checkCron();
        assert.equal(readFileSync(preferencesPath, "utf8"), beforeCron);
      }
      delete process.env[CRON_FAST_OFF_ENV];
      process.env.MINIME_BOT_PI_SESSION_AGENT_ID = "fixture-primary";
    }
    process.env[CRON_FAST_OFF_ENV] = "1";
    writeFileSync(preferencesPath, "invalid fixture preferences");
    writeFileSync(join(root, "config.yaml"), "invalid fixture config");
    await checkCron();
    assert.equal(readFileSync(preferencesPath, "utf8"), "invalid fixture preferences");
    const mismatch = { ...payload, model: "other-model", service_tier: "priority" };
    assert.deepEqual(await session.extensionRunner.emitBeforeProviderRequest(mismatch), mismatch);
    assert.deepEqual(errors, []);
    assert.equal(session.state.messages.length, 0);
    assert.equal(session.thinkingLevel, "high");
    assert.equal(session.model?.id, "gpt-6-astra");
    assert.equal(existsSync(join(agentDir, "models.json")), false);
    return { piVersion: EXPECTED_PI_PACKAGE_VERSION, requestChecks, commandsChecked };
  } finally {
    session?.dispose();
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

if (process.argv[1] && realpathOrResolve(process.argv[1]) === realpathOrResolve(fileURLToPath(import.meta.url))) {
  const deadline = setTimeout(() => { process.stderr.write("Codex Fast offline verification timed out\n"); process.exit(1); }, 20_000);
  verifyCodexFast().then(result => { console.log(JSON.stringify(result)); }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearTimeout(deadline));
}
