import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { mergeDeep, loadRawMergedConfig } from "../config.js";

const TEST_DIR = join("/tmp", "config-merge-test-" + Date.now());

describe("mergeDeep", () => {
  it("returns base values when override is empty", () => {
    const result = mergeDeep({ a: 1, b: 2 }, {});
    assert.deepStrictEqual(result, { a: 1, b: 2 });
  });

  it("override wins on scalar values", () => {
    const result = mergeDeep({ a: 1 }, { a: 2 });
    assert.strictEqual(result.a, 2);
  });

  it("preserves base keys not present in override", () => {
    const result = mergeDeep({ a: 1, b: 2 }, { a: 99 });
    assert.strictEqual(result.a, 99);
    assert.strictEqual(result.b, 2);
  });

  it("deep merges nested objects without losing sibling keys", () => {
    const result = mergeDeep(
      { sessionDefaults: { idleTimeoutMs: 3600000, maxConcurrentSessions: 12 } },
      { sessionDefaults: { idleTimeoutMs: 7200000 } },
    );
    const sd = result.sessionDefaults as Record<string, unknown>;
    assert.strictEqual(sd.idleTimeoutMs, 7200000);        // overridden
    assert.strictEqual(sd.maxConcurrentSessions, 12);     // preserved
  });

  it("replaces arrays entirely (no element-level merge)", () => {
    const result = mergeDeep(
      { bindings: [{ chatId: 111 }, { chatId: 222 }] },
      { bindings: [{ chatId: 999 }] },
    );
    const bindings = result.bindings as Array<Record<string, unknown>>;
    assert.strictEqual(bindings.length, 1);
    assert.strictEqual(bindings[0].chatId, 999);
  });

  it("adds keys from override not present in base", () => {
    const result = mergeDeep({ a: 1 }, { b: 2 });
    assert.strictEqual(result.a, 1);
    assert.strictEqual(result.b, 2);
  });

  it("override can set key to null", () => {
    const result = mergeDeep({ a: 1 }, { a: null });
    assert.strictEqual(result.a, null);
  });

  it("does not mutate base object", () => {
    const base = { a: 1, nested: { x: 10 } };
    mergeDeep(base as Record<string, unknown>, { a: 99, nested: { x: 20 } });
    assert.strictEqual(base.a, 1);
    assert.strictEqual(base.nested.x, 10);
  });

  it("deep merges agents object: local workspaceCwd overrides base, model preserved", () => {
    const base = parseYaml(`
agents:
  main:
    workspaceCwd: /tmp/minime-workspace
    model: gpt-5.5
    thinking: high
`) as Record<string, unknown>;
    const local = { agents: { main: { workspaceCwd: "/real/workspace" } } };
    const merged = mergeDeep(base, local as Record<string, unknown>);
    const agents = merged.agents as Record<string, Record<string, unknown>>;
    assert.strictEqual(agents.main.workspaceCwd, "/real/workspace");  // overridden
    assert.strictEqual(agents.main.model, "gpt-5.5");                 // preserved
    assert.strictEqual(agents.main.thinking, "high");                 // preserved
  });

  it("local bindings array replaces base bindings entirely", () => {
    const base = { bindings: [{ chatId: 111111111, agentId: "main", kind: "dm" }] };
    const local = { bindings: [{ chatId: 987654321, agentId: "main", kind: "dm", label: "Real DM" }] };
    const merged = mergeDeep(
      base as Record<string, unknown>,
      local as Record<string, unknown>,
    );
    const bindings = merged.bindings as Array<Record<string, unknown>>;
    assert.strictEqual(bindings.length, 1);
    assert.strictEqual(bindings[0].chatId, 987654321);
    assert.strictEqual(bindings[0].label, "Real DM");
  });

  it("local sessionDefaults partially overrides without losing other fields", () => {
    const base = parseYaml(`
sessionDefaults:
  idleTimeoutMs: 3600000
  maxConcurrentSessions: 12
  maxMessageAgeMs: 600000
`) as Record<string, unknown>;
    const local = { sessionDefaults: { idleTimeoutMs: 7200000 } };
    const merged = mergeDeep(base, local as Record<string, unknown>);
    const sd = merged.sessionDefaults as Record<string, unknown>;
    assert.strictEqual(sd.idleTimeoutMs, 7200000);     // overridden
    assert.strictEqual(sd.maxConcurrentSessions, 12);  // preserved
    assert.strictEqual(sd.maxMessageAgeMs, 600000);    // preserved
  });

  it("merge precedence: local always wins over base on conflict", () => {
    const result = mergeDeep(
      { logLevel: "info", metricsPort: 9091 },
      { logLevel: "debug", metricsPort: 8080 },
    );
    assert.strictEqual(result.logLevel, "debug");
    assert.strictEqual(result.metricsPort, 8080);
  });

  it("override introducing entirely new nested object is assigned as-is", () => {
    const result = mergeDeep({ a: 1 }, { nested: { x: 99 } });
    assert.strictEqual(result.a, 1);
    const nested = result.nested as Record<string, unknown>;
    assert.strictEqual(nested.x, 99);
  });

  it("ignores __proto__ key to prevent prototype pollution", () => {
    const before = ({} as Record<string, unknown>).polluted;
    const result = mergeDeep({}, JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>);
    // Verify global Object.prototype is not polluted
    assert.strictEqual(({} as Record<string, unknown>).polluted, before);
    // Verify the returned result's prototype chain is also not polluted
    // (old vulnerable code would set result's __proto__ to {polluted:true}, making result.polluted === true)
    assert.strictEqual(result.polluted, undefined);
    assert.strictEqual(Object.getPrototypeOf(result), Object.prototype);
  });

  it("ignores constructor and prototype keys", () => {
    const result = mergeDeep({ a: 1 }, { constructor: "evil", prototype: "evil" });
    assert.strictEqual(result.a, 1);
    // dangerous keys must not appear in the result
    assert.ok(!Object.prototype.hasOwnProperty.call(result, "constructor"));
    assert.ok(!Object.prototype.hasOwnProperty.call(result, "prototype"));
  });
});

describe("loadRawMergedConfig", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("returns base config when no local file exists", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(configPath, "logLevel: debug\nmetricsPort: 9091\n");
    const result = loadRawMergedConfig(configPath);
    assert.strictEqual(result.logLevel, "debug");
    assert.strictEqual(result.metricsPort, 9091);
  });

  it("merges local file when it exists alongside config.yaml", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(configPath, "logLevel: info\nmetricsPort: 9091\n");
    writeFileSync(localPath, "logLevel: debug\nadminChatId: 123456789\n");
    const result = loadRawMergedConfig(configPath);
    assert.strictEqual(result.logLevel, "debug");       // local wins
    assert.strictEqual(result.metricsPort, 9091);       // base preserved
    assert.strictEqual(result.adminChatId, 123456789);  // local addition
  });

  it("local value takes precedence over base", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(configPath, "metricsPort: 9091\n");
    writeFileSync(localPath, "metricsPort: 8080\n");
    const result = loadRawMergedConfig(configPath);
    assert.strictEqual(result.metricsPort, 8080);
  });

  it("handles empty local file gracefully", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(configPath, "logLevel: info\n");
    writeFileSync(localPath, "# no overrides\n");
    const result = loadRawMergedConfig(configPath);
    assert.strictEqual(result.logLevel, "info");
  });

  it("handles empty base YAML gracefully (returns empty object)", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(configPath, "# empty\n");
    const result = loadRawMergedConfig(configPath);
    assert.deepStrictEqual(result, {});
  });

  it("deep merges nested agent config from local", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    writeFileSync(configPath, `
agents:
  main:
    workspaceCwd: /tmp/default
    model: gpt-5.5
    thinking: high
`);
    writeFileSync(localPath, `
agents:
  main:
    workspaceCwd: /real/workspace
`);
    const result = loadRawMergedConfig(configPath);
    const agents = result.agents as Record<string, Record<string, unknown>>;
    assert.strictEqual(agents.main.workspaceCwd, "/real/workspace");  // overridden
    assert.strictEqual(agents.main.model, "gpt-5.5");                 // preserved
    assert.strictEqual(agents.main.thinking, "high");                 // preserved
  });

  it("applies every allowed instance leaf after config.local.yaml", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const localPath = join(TEST_DIR, "config.local.yaml");
    const instancePath = join(TEST_DIR, "instance.yaml");
    writeFileSync(configPath, `
agents:
  main:
    workspaceCwd: /srv/minime-agent
    model: gpt-5.5
bindings:
  - chatId: 111
    topicId: 10
    agentId: main
    kind: dm
    label: reserve
metricsPort: 9000
`);
    writeFileSync(localPath, "metricsPort: 9001\n");
    writeFileSync(instancePath, `
secrets:
  sopsFile: deployment.sops.yaml
telegramTokenSopsKey: telegram.reserve
telegramTokenEnv: RESERVE_TOKEN
bindingIdentityOverrides:
  reserve:
    chatId: 222
    topicId: 20
metricsPort: 9002
metricsHost: localhost
adminChatId: 333
defaultDeliveryChatId: 444
defaultDeliveryThreadId: 55
triggerInput:
  port: 9466
  bearerEnv: TRIGGER_BEARER
  chatId: 222
`);

    const result = loadRawMergedConfig(configPath, instancePath);
    const binding = (result.bindings as Array<Record<string, unknown>>)[0];
    assert.deepStrictEqual(result.secrets, { sopsFile: "deployment.sops.yaml" });
    assert.strictEqual(result.telegramTokenSopsKey, "telegram.reserve");
    assert.strictEqual(result.telegramTokenEnv, "RESERVE_TOKEN");
    assert.strictEqual(binding.chatId, 222);
    assert.strictEqual(binding.topicId, 20);
    assert.strictEqual(result.metricsPort, 9002);
    assert.strictEqual(result.metricsHost, "localhost");
    assert.strictEqual(result.adminChatId, 333);
    assert.strictEqual(result.defaultDeliveryChatId, 444);
    assert.strictEqual(result.defaultDeliveryThreadId, 55);
    assert.deepStrictEqual(result.triggerInput, {
      port: 9466,
      bearerEnv: "TRIGGER_BEARER",
      chatId: 222,
    });
    assert.strictEqual(result.bindingIdentityOverrides, undefined);
  });

  it("patches binding identity without replacing canonical behavior", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const instancePath = join(TEST_DIR, "instance.yaml");
    writeFileSync(configPath, `
agents:
  main:
    workspaceCwd: /srv/minime-agent
    model: gpt-5.5
bindings:
  - chatId: 111
    agentId: main
    kind: group
    label: reserve
    requireMention: true
    voiceTranscriptEcho: true
    typingIndicator: false
    topics:
      - topicId: 7
        agentId: main
        requireMention: false
`);
    writeFileSync(instancePath, `
bindingIdentityOverrides:
  reserve:
    chatId: 222
`);

    const result = loadRawMergedConfig(configPath, instancePath);
    const binding = (result.bindings as Array<Record<string, unknown>>)[0];
    assert.deepStrictEqual(binding, {
      chatId: 222,
      agentId: "main",
      kind: "group",
      label: "reserve",
      requireMention: true,
      voiceTranscriptEcho: true,
      typingIndicator: false,
      topics: [{ topicId: 7, agentId: "main", requireMention: false }],
    });
  });

  it("requires an identity override label to resolve exactly once", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const instancePath = join(TEST_DIR, "instance.yaml");
    writeFileSync(instancePath, "bindingIdentityOverrides:\n  reserve:\n    chatId: 222\n");
    writeFileSync(configPath, `
agents:
  main:
    workspaceCwd: /srv/minime-agent
    model: gpt-5.5
bindings:
  - { chatId: 111, agentId: main, kind: dm, label: primary }
`);
    assert.throws(
      () => loadRawMergedConfig(configPath, instancePath),
      /bindingIdentityOverrides\.reserve does not match a canonical binding label/,
    );

    writeFileSync(configPath, `
agents:
  main:
    workspaceCwd: /srv/minime-agent
    model: gpt-5.5
bindings:
  - { chatId: 111, agentId: main, kind: dm, label: reserve }
  - { chatId: 112, agentId: main, kind: dm, label: reserve }
`);
    assert.throws(
      () => loadRawMergedConfig(configPath, instancePath),
      /bindingIdentityOverrides\.reserve matches a duplicate canonical binding label/,
    );
  });

  it("rejects behavioral and unknown instance paths without leaking values", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const instancePath = join(TEST_DIR, "instance.yaml");
    writeFileSync(configPath, `
agents:
  main:
    workspaceCwd: /srv/minime-agent
    model: gpt-5.5
bindings:
  - { chatId: 111, agentId: main, kind: dm, label: reserve }
`);
    const cases = [
      ["bindings", "bindings:\n  - chatId: 999999\n"],
      ["bindingIdentityOverrides.reserve.requireMention", "bindingIdentityOverrides:\n  reserve:\n    requireMention: true\n"],
      ["agents.main.workspaceCwd", "agents:\n  main:\n    workspaceCwd: /private/should-not-leak\n"],
      ["agents.main.model", "agents:\n  main:\n    model: private-model-value\n"],
      ["agents.main.thinking", "agents:\n  main:\n    thinking: private-thinking-value\n"],
      ["agents.main.systemPrompt", "agents:\n  main:\n    systemPrompt: private-prompt-value\n"],
      ["agents.main.askAgent.enabled", "agents:\n  main:\n    askAgent:\n      enabled: true\n"],
      ["sessionDefaults.idleTimeoutMs", "sessionDefaults:\n  idleTimeoutMs: 12345\n"],
      ["piExtraExtensions", "piExtraExtensions:\n  - /private/extension.ts\n"],
      ["discord.tokenEnv", "discord:\n  tokenEnv: PRIVATE_DISCORD_ENV\n"],
      ["logLevel", "logLevel: private-log-level\n"],
      ["unknown.private", "unknown:\n  private: private-unknown-value\n"],
    ] as const;

    for (const [path, yaml] of cases) {
      writeFileSync(instancePath, yaml);
      assert.throws(() => loadRawMergedConfig(configPath, instancePath), (error: unknown) => {
        const message = (error as Error).message;
        assert.match(message, new RegExp(path.replaceAll(".", "\\.")));
        assert.doesNotMatch(
          message,
          /999999|should-not-leak|private-model-value|private-thinking-value|private-prompt-value|12345|private\/extension|PRIVATE_DISCORD_ENV|private-log-level|private-unknown-value/,
        );
        return true;
      }, path);
    }
  });

  it("requires absolute canonical agent workspaces only when an instance overlay is enabled", () => {
    const configPath = join(TEST_DIR, "config.yaml");
    const instancePath = join(TEST_DIR, "instance.yaml");
    writeFileSync(configPath, `
agents:
  main:
    workspaceCwd: ./agent-workspace
    model: gpt-5.5
`);
    writeFileSync(instancePath, "metricsPort: 9002\n");

    assert.strictEqual(
      ((loadRawMergedConfig(configPath).agents as Record<string, Record<string, unknown>>).main.workspaceCwd),
      "./agent-workspace",
    );
    assert.throws(
      () => loadRawMergedConfig(configPath, instancePath),
      /Instance config requires canonical agents\.main\.workspaceCwd to be absolute/,
    );
  });
});
