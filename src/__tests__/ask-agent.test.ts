import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ASK_AGENT_TOOL,
  executeAskAgent,
  formatAskAgentToolResult,
  makeAskAgentError,
  readAskAgentCallerAgentId,
  type AskAgentExecutionResult,
} from "../pi-extensions/ask-agent-args.js";
import { MINIME_ASK_CALLER_AGENT_ID_ENV } from "../pi-rpc-protocol.js";
import type { PiContextArtifacts } from "../pi-context-assembler.js";
import type { AgentConfig, BotConfig } from "../types.js";

const CONTEXT: PiContextArtifacts = { appendSystemPromptPath: "target-context.md" };

function agent(id: string, askAgent: AgentConfig["askAgent"] = { enabled: true }): AgentConfig {
  return {
    id,
    workspaceCwd: `workspace-${id}`,
    model: "gpt-5.5",
    askAgent,
  };
}

function config(...agents: AgentConfig[]): Pick<BotConfig, "agents"> {
  return {
    agents: Object.fromEntries(agents.map((entry) => [entry.id, entry])),
  };
}

function env(callerAgentId?: string): NodeJS.ProcessEnv {
  return callerAgentId === undefined
    ? {}
    : { [MINIME_ASK_CALLER_AGENT_ID_ENV]: callerAgentId };
}

function assertError(result: AskAgentExecutionResult, code: string): void {
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, code);
  }
}

describe("ask-agent helper", () => {
  it("defines the first-party ask-agent tool contract", () => {
    assert.equal(ASK_AGENT_TOOL.name, "ask-agent");
    assert.deepEqual(ASK_AGENT_TOOL.parameters.required, ["targetAgentId", "question"]);
  });

  it("reads caller identity only from the trusted environment key", async () => {
    assert.equal(readAskAgentCallerAgentId(env("agent-b")), "agent-b");
    assert.equal(readAskAgentCallerAgentId({ [MINIME_ASK_CALLER_AGENT_ID_ENV]: "   " }), undefined);

    let runTargetCalled = false;
    const result = await executeAskAgent(
      { callerAgentId: "agent-c", targetAgentId: "agent-c", question: "status?" },
      {
        config: config(agent("agent-b"), agent("agent-c")),
        env: env("agent-b"),
        assembleContext: () => CONTEXT,
        runTarget: async (request) => {
          runTargetCalled = true;
          assert.equal(request.caller.id, "agent-b");
          return { answer: "from target", truncated: false, needsClarification: false };
        },
      },
    );

    assert.equal(runTargetCalled, true);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.result, {
        answer: "from target",
        truncated: false,
        needsClarification: false,
      });
    }
  });

  it("returns caller_unknown for missing, empty, or unconfigured caller without context or spawn", async () => {
    for (const testEnv of [
      env(),
      env(""),
      env("   "),
      env("agent-missing"),
    ]) {
      let assembleCalled = false;
      let runTargetCalled = false;
      const result = await executeAskAgent(
        { targetAgentId: "agent-c", question: "status?" },
        {
          config: config(agent("agent-b"), agent("agent-c")),
          env: testEnv,
          assembleContext: () => {
            assembleCalled = true;
            return CONTEXT;
          },
          runTarget: async () => {
            runTargetCalled = true;
            return { answer: "unexpected", truncated: false, needsClarification: false };
          },
        },
      );

      assertError(result, "caller_unknown");
      assert.equal(assembleCalled, false);
      assert.equal(runTargetCalled, false);
    }
  });

  it("returns target_unknown for missing or unknown targets without context or spawn", async () => {
    for (const params of [
      { question: "status?" },
      { targetAgentId: "agent-missing", question: "status?" },
    ]) {
      let assembleCalled = false;
      let runTargetCalled = false;
      const result = await executeAskAgent(params, {
        config: config(agent("agent-b"), agent("agent-c")),
        env: env("agent-b"),
        assembleContext: () => {
          assembleCalled = true;
          return CONTEXT;
        },
        runTarget: async () => {
          runTargetCalled = true;
          return { answer: "unexpected", truncated: false, needsClarification: false };
        },
      });

      assertError(result, "target_unknown");
      assert.equal(assembleCalled, false);
      assert.equal(runTargetCalled, false);
    }
  });

  it("enforces enabled, canAsk, and deny policy without context or spawn", async () => {
    const cases: Array<{
      name: string;
      caller: AgentConfig;
      target: AgentConfig;
      code: "not_enabled" | "denied";
    }> = [
      {
        name: "caller disabled",
        caller: agent("agent-b", { enabled: false }),
        target: agent("agent-c"),
        code: "not_enabled",
      },
      {
        name: "target disabled",
        caller: agent("agent-b"),
        target: agent("agent-c", { enabled: false }),
        code: "not_enabled",
      },
      {
        name: "deny override",
        caller: agent("agent-b", { enabled: true, canAsk: ["*"], deny: ["agent-c"] }),
        target: agent("agent-c"),
        code: "denied",
      },
      {
        name: "canAsk excludes target",
        caller: agent("agent-b", { enabled: true, canAsk: ["agent-d"] }),
        target: agent("agent-c"),
        code: "denied",
      },
    ];

    for (const entry of cases) {
      let assembleCalled = false;
      let runTargetCalled = false;
      const result = await executeAskAgent(
        { targetAgentId: "agent-c", question: "status?" },
        {
          config: config(entry.caller, entry.target),
          env: env("agent-b"),
          assembleContext: () => {
            assembleCalled = true;
            return CONTEXT;
          },
          runTarget: async () => {
            runTargetCalled = true;
            return { answer: "unexpected", truncated: false, needsClarification: false };
          },
        },
      );

      assertError(result, entry.code);
      assert.equal(assembleCalled, false, entry.name);
      assert.equal(runTargetCalled, false, entry.name);
    }
  });

  it("returns context_unavailable when context assembly is null or throws, without spawn", async () => {
    for (const assembleContext of [
      () => null,
      () => {
        throw new Error("assembly failed");
      },
    ]) {
      let runTargetCalled = false;
      const result = await executeAskAgent(
        { targetAgentId: "agent-c", question: "status?" },
        {
          config: config(agent("agent-b"), agent("agent-c")),
          env: env("agent-b"),
          assembleContext,
          runTarget: async () => {
            runTargetCalled = true;
            return { answer: "unexpected", truncated: false, needsClarification: false };
          },
        },
      );

      assertError(result, "context_unavailable");
      assert.equal(runTargetCalled, false);
    }
  });

  it("returns the injected target result in the structured answer shape", async () => {
    const result = await executeAskAgent(
      { targetAgentId: "agent-c", question: "clarify?" },
      {
        config: config(agent("agent-b"), agent("agent-c")),
        env: env("agent-b"),
        assembleContext: (target) => {
          assert.equal(target.id, "agent-c");
          return CONTEXT;
        },
        runTarget: async (request) => {
          assert.equal(request.question, "clarify?");
          assert.equal(request.context, CONTEXT);
          return { answer: "Which environment?", truncated: false, needsClarification: true };
        },
      },
    );

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.callerAgentId, "agent-b");
      assert.equal(result.targetAgentId, "agent-c");
      assert.deepEqual(result.result, {
        answer: "Which environment?",
        truncated: false,
        needsClarification: true,
      });
    }
  });

  it("formats success and error results for Pi tool responses", () => {
    const success = formatAskAgentToolResult({
      ok: true,
      callerAgentId: "agent-b",
      targetAgentId: "agent-c",
      result: { answer: "answer", truncated: false, needsClarification: false },
    });
    assert.equal(success.content[0].text, "answer");
    assert.deepEqual(success.details, {
      ok: true,
      callerAgentId: "agent-b",
      targetAgentId: "agent-c",
      result: { answer: "answer", truncated: false, needsClarification: false },
    });

    const error = formatAskAgentToolResult(
      makeAskAgentError("denied", "policy denied", { callerAgentId: "agent-b", targetAgentId: "agent-c" }),
    );
    assert.equal(error.isError, true);
    assert.match(error.content[0].text, /ask-agent error \(denied\): policy denied/);
    assert.deepEqual(error.details, {
      ok: false,
      callerAgentId: "agent-b",
      targetAgentId: "agent-c",
      error: { code: "denied", message: "policy denied" },
    });
  });
});
