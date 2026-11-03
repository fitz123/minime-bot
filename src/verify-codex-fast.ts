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
import { PI_FAST_THREAD_ENV } from "./codex-fast.js";
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
  const envKeys = ["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", MINIME_CONTROL_WORKSPACE_ROOT_ENV, MINIME_CONFIG_PATH_ENV, MINIME_INSTANCE_CONFIG_PATH_ENV, "MINIME_BOT_PI_SESSION_AGENT_ID", PI_FAST_THREAD_ENV];
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
    globalThis.fetch = async () => { throw new Error("Offline verifier forbids provider/network calls"); };
    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    // Synthetic bindings allow the regular no-resolve-secrets config loader.
    const agent = { workspaceCwd: root, model: "openai-codex/gpt-6-astra", thinking: "high", codexFast: { provider: "openai-codex", model: "gpt-6-astra" } };
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
    await command("", /intent: off/); await check(false);
    await command("on", /override: on/); await check(true);
    await command("off", /intent: off/); await check(false);
    await command("inherit", /override: inherit/); await check(false);
    await command("default on", /Default: on/); await check(true);
    await command("off", /override: off/); await check(false);
    process.env[PI_FAST_THREAD_ENV] = "fixture-chat:two";
    await command("", /override: inherit/); await check(true);
    await command("on", /override: on/);
    await command("default off", /Default: off/); await check(true);
    process.env[PI_FAST_THREAD_ENV] = "fixture-chat:one"; await check(false);
    await command("inherit", /override: inherit/); await check(false);
    await command("default on", /Default: on/);
    delete process.env[PI_FAST_THREAD_ENV];
    await command("", /default-only consumer/); await check(true);
    await command("status", /default-only consumer/);
    await command("off", /No identified chat/); await check(true);
    await command("default status", /Default: on/);
    await command("default inherit", /Usage:/);
    await command("on extra", /Usage:/);
    await check(false, { ...payload, service_tier: "auto" });
    await check(false, { ...payload, service_tier: "priority" });
    await command("default off", /Independent service_tier settings are preserved/);
    await check(false, { ...payload, service_tier: "priority" });
    await check(false, { ...payload, model: "another-model" });
    await command("default on", /Default: on/);
    for (const id of ["fixture-other", "unknown", ""]) {
      process.env.MINIME_BOT_PI_SESSION_AGENT_ID = id;
      await check(false); await command("on", /unavailable/);
    }
    process.env.MINIME_BOT_PI_SESSION_AGENT_ID = "fixture-primary";
    // Configuration is re-read by the already-loaded hook.
    writeFileSync(join(root, "config.yaml"), JSON.stringify({ ...config, agents: { ...config.agents, "fixture-primary": { ...agent, codexFast: undefined } } }));
    await check(false);
    writeFileSync(join(root, "config.yaml"), JSON.stringify(config));
    await check(true);
    // Execute Pi's real Codex request builder, stopping inside onPayload before
    // any transport. The token contains only synthetic fixture claims.
    const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
    const built: Record<string, unknown>[] = [];
    for (const enabled of [true, false]) {
      await command(`default ${enabled ? "on" : "off"}`, /Default:/);
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
    assert.equal(built.length, 2);
    assert.deepEqual(built[0], { ...built[1], service_tier: "priority" });
    assert.equal(built[1].model, "gpt-6-astra");
    assert.deepEqual(built[1].reasoning, { effort: "high", summary: "auto" });
    assert.equal("service_tier" in built[1], false);
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
