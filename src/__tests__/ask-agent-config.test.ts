import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveAskAgentPolicy, validateAgent } from "../config.js";

const TEST_DIR = join("/tmp", "ask-agent-config-test-" + Date.now());
const KNOWN_AGENT_IDS = new Set(["agent-b", "agent-c"]);

function writeConfig(name: string, agentsYaml: string): string {
  const dir = join(TEST_DIR, name);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "config.yaml");
  writeFileSync(
    configPath,
    `
agents:
${agentsYaml}
telegramTokenEnv: TEST_UNSET_TELEGRAM_TOKEN
bindings:
  - chatId: 111
    agentId: agent-b
    kind: dm
`,
  );
  return configPath;
}

function loadTestConfig(name: string, agentsYaml: string) {
  return loadConfig(writeConfig(name, agentsYaml), { resolveSecrets: false });
}

describe("askAgent config validation", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("normalizes absent canAsk to wildcard allow for enabled agents", () => {
    const agent = validateAgent(
      {
        workspaceCwd: "/tmp/agent-b",
        model: "gpt-5.5",
        askAgent: { enabled: true },
      },
      "agent-b",
      undefined,
      undefined,
      KNOWN_AGENT_IDS,
    );

    assert.deepStrictEqual(agent.askAgent, {
      enabled: true,
      canAsk: ["*"],
      deny: undefined,
    });
  });

  it("allows an enabled caller to ask an enabled target by default", () => {
    const config = loadTestConfig(
      "default-allow",
      `
  agent-b:
    workspaceCwd: /tmp/agent-b
    model: gpt-5.5
    askAgent:
      enabled: true
  agent-c:
    workspaceCwd: /tmp/agent-c
    model: gpt-5.5
    askAgent:
      enabled: true
`,
    );

    assert.deepStrictEqual(
      resolveAskAgentPolicy(config.agents["agent-b"], config.agents["agent-c"]),
      { allowed: true },
    );
  });

  it("lets deny override wildcard allow", () => {
    const config = loadTestConfig(
      "deny-overrides",
      `
  agent-b:
    workspaceCwd: /tmp/agent-b
    model: gpt-5.5
    askAgent:
      enabled: true
      canAsk:
        - "*"
      deny:
        - agent-c
  agent-c:
    workspaceCwd: /tmp/agent-c
    model: gpt-5.5
    askAgent:
      enabled: true
`,
    );

    const result = resolveAskAgentPolicy(config.agents["agent-b"], config.agents["agent-c"]);
    assert.deepStrictEqual(result, {
      allowed: false,
      code: "denied",
      reason: 'Agent "agent-b" is denied from asking "agent-c"',
    });
  });

  it("supports deny wildcard as deny-all for the asker", () => {
    const config = loadTestConfig(
      "deny-all",
      `
  agent-b:
    workspaceCwd: /tmp/agent-b
    model: gpt-5.5
    askAgent:
      enabled: true
      canAsk:
        - agent-c
      deny:
        - "*"
  agent-c:
    workspaceCwd: /tmp/agent-c
    model: gpt-5.5
    askAgent:
      enabled: true
`,
    );

    const result = resolveAskAgentPolicy(config.agents["agent-b"], config.agents["agent-c"]);
    assert.strictEqual(result.allowed, false);
    if (!result.allowed) {
      assert.strictEqual(result.code, "denied");
      assert.match(result.reason, /denied from asking/);
    }
  });

  it("denies targets that are not askAgent-enabled", () => {
    const config = loadTestConfig(
      "target-disabled",
      `
  agent-b:
    workspaceCwd: /tmp/agent-b
    model: gpt-5.5
    askAgent:
      enabled: true
  agent-c:
    workspaceCwd: /tmp/agent-c
    model: gpt-5.5
    askAgent:
      enabled: false
`,
    );

    const result = resolveAskAgentPolicy(config.agents["agent-b"], config.agents["agent-c"]);
    assert.strictEqual(result.allowed, false);
    if (!result.allowed) {
      assert.strictEqual(result.code, "not_enabled");
    }
  });

  it("rejects unknown referenced agent ids", () => {
    assert.throws(
      () => loadTestConfig(
        "unknown-can-ask",
        `
  agent-b:
    workspaceCwd: /tmp/agent-b
    model: gpt-5.5
    askAgent:
      enabled: true
      canAsk:
        - agent-d
`,
      ),
      /Agent "agent-b" askAgent\.canAsk\[0\] references unknown agent "agent-d"/,
    );

    assert.throws(
      () => loadTestConfig(
        "unknown-deny",
        `
  agent-b:
    workspaceCwd: /tmp/agent-b
    model: gpt-5.5
    askAgent:
      enabled: true
      deny:
        - agent-d
`,
      ),
      /Agent "agent-b" askAgent\.deny\[0\] references unknown agent "agent-d"/,
    );
  });

  it("rejects invalid askAgent shapes and wildcard mixes", () => {
    const cases: Array<{ name: string; askAgent: unknown; expected: RegExp }> = [
      {
        name: "non-object",
        askAgent: true,
        expected: /Agent "agent-b" askAgent must be an object/,
      },
      {
        name: "missing-enabled",
        askAgent: {},
        expected: /Agent "agent-b" askAgent\.enabled must be a boolean/,
      },
      {
        name: "bad-can-ask",
        askAgent: { enabled: true, canAsk: "agent-c" },
        expected: /Agent "agent-b" askAgent\.canAsk must be an array/,
      },
      {
        name: "empty-deny-entry",
        askAgent: { enabled: true, deny: [""] },
        expected: /Agent "agent-b" askAgent\.deny\[0\] must be a non-empty agent id or "\*"/,
      },
      {
        name: "mixed-can-ask-wildcard",
        askAgent: { enabled: true, canAsk: ["*", "agent-c"] },
        expected: /Agent "agent-b" askAgent\.canAsk cannot combine "\*" with agent ids/,
      },
      {
        name: "mixed-deny-wildcard",
        askAgent: { enabled: true, deny: ["*", "agent-c"] },
        expected: /Agent "agent-b" askAgent\.deny cannot combine "\*" with agent ids/,
      },
    ];

    for (const entry of cases) {
      assert.throws(
        () => validateAgent(
          {
            workspaceCwd: "/tmp/agent-b",
            model: "gpt-5.5",
            askAgent: entry.askAgent,
          },
          "agent-b",
          undefined,
          undefined,
          KNOWN_AGENT_IDS,
        ),
        entry.expected,
        entry.name,
      );
    }
  });
});
