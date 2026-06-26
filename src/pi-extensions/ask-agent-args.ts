import { resolveAskAgentPolicy } from "../config.js";
import { MINIME_ASK_CALLER_AGENT_ID_ENV } from "../pi-rpc-protocol.js";
import type { PiContextArtifacts } from "../pi-context-assembler.js";
import type { AgentConfig, BotConfig } from "../types.js";

export const MAX_ASK_AGENT_QUESTION_CHARS = 64 * 1024;

export const ASK_AGENT_TOOL = {
  name: "ask-agent",
  label: "Ask Agent",
  description:
    "Ask another configured Minime agent a one-shot question. The target runs with its own workspace context and returns a final answer.",
  parameters: {
    type: "object",
    properties: {
      targetAgentId: {
        type: "string",
        description: "Configured id of the target agent to ask.",
      },
      question: {
        type: "string",
        description: "Question for the target agent.",
        maxLength: MAX_ASK_AGENT_QUESTION_CHARS,
      },
    },
    required: ["targetAgentId", "question"],
  },
} as const;

export interface AskAgentStructuredResult {
  answer: string;
  truncated: boolean;
  needsClarification: boolean;
}

export type AskAgentErrorCode =
  | "caller_unknown"
  | "target_unknown"
  | "context_unavailable"
  | "not_enabled"
  | "denied"
  | "invalid_request"
  | "config_unavailable"
  | "spawn_unavailable";

export interface AskAgentStructuredError {
  code: AskAgentErrorCode;
  message: string;
}

export interface AskAgentPreparedRequest {
  caller: AgentConfig;
  target: AgentConfig;
  question: string;
  context: PiContextArtifacts;
  signal?: AbortSignal;
}

export type RunAskAgentTarget = (request: AskAgentPreparedRequest) => Promise<AskAgentStructuredResult>;

export interface ExecuteAskAgentDeps {
  config: Pick<BotConfig, "agents">;
  env?: NodeJS.ProcessEnv;
  assembleContext: (agent: AgentConfig) => PiContextArtifacts | null;
  runTarget?: RunAskAgentTarget;
  signal?: AbortSignal;
}

export type AskAgentExecutionResult =
  | {
      ok: true;
      callerAgentId: string;
      targetAgentId: string;
      result: AskAgentStructuredResult;
    }
  | {
      ok: false;
      callerAgentId?: string;
      targetAgentId?: string;
      error: AskAgentStructuredError;
    };

export type AskAgentToolDetails =
  | {
      ok: true;
      callerAgentId: string;
      targetAgentId: string;
      result: AskAgentStructuredResult;
    }
  | {
      ok: false;
      callerAgentId?: string;
      targetAgentId?: string;
      error: AskAgentStructuredError;
    };

export interface AskAgentToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: AskAgentToolDetails;
  isError?: boolean;
}

export function readAskAgentCallerAgentId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const caller = env[MINIME_ASK_CALLER_AGENT_ID_ENV]?.trim();
  return caller ? caller : undefined;
}

export function makeAskAgentError(
  code: AskAgentErrorCode,
  message: string,
  ids?: { callerAgentId?: string; targetAgentId?: string },
): AskAgentExecutionResult {
  return {
    ok: false,
    callerAgentId: ids?.callerAgentId,
    targetAgentId: ids?.targetAgentId,
    error: { code, message },
  };
}

function asParams(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeTargetAgentId(params: Record<string, unknown>): string | undefined {
  const raw = stringParam(params, "targetAgentId") ?? stringParam(params, "target") ?? stringParam(params, "agent");
  const target = raw?.trim();
  return target ? target : undefined;
}

function normalizeQuestion(params: Record<string, unknown>): string | undefined {
  const raw = stringParam(params, "question");
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw.length > MAX_ASK_AGENT_QUESTION_CHARS
    ? undefined
    : raw;
}

export async function executeAskAgent(paramsLike: unknown, deps: ExecuteAskAgentDeps): Promise<AskAgentExecutionResult> {
  const params = asParams(paramsLike);
  const callerAgentId = readAskAgentCallerAgentId(deps.env);
  if (!callerAgentId) {
    return makeAskAgentError("caller_unknown", "ask-agent caller identity is unavailable");
  }

  const caller = deps.config.agents[callerAgentId];
  if (!caller) {
    return makeAskAgentError("caller_unknown", "ask-agent caller identity is not a configured agent", {
      callerAgentId,
    });
  }

  const targetAgentId = normalizeTargetAgentId(params);
  if (!targetAgentId) {
    return makeAskAgentError("target_unknown", "ask-agent target agent is missing or unknown", {
      callerAgentId,
    });
  }

  const target = deps.config.agents[targetAgentId];
  if (!target) {
    return makeAskAgentError("target_unknown", "ask-agent target agent is not configured", {
      callerAgentId,
      targetAgentId,
    });
  }

  const question = normalizeQuestion(params);
  if (!question) {
    return makeAskAgentError("invalid_request", "ask-agent question is missing, empty, or too large", {
      callerAgentId,
      targetAgentId,
    });
  }

  const policy = resolveAskAgentPolicy(caller, target);
  if (!policy.allowed) {
    return makeAskAgentError(policy.code, policy.reason, {
      callerAgentId,
      targetAgentId,
    });
  }

  let context: PiContextArtifacts | null;
  try {
    context = deps.assembleContext(target);
  } catch {
    return makeAskAgentError("context_unavailable", "ask-agent target context is unavailable", {
      callerAgentId,
      targetAgentId,
    });
  }
  if (!context) {
    return makeAskAgentError("context_unavailable", "ask-agent target context is unavailable", {
      callerAgentId,
      targetAgentId,
    });
  }

  if (!deps.runTarget) {
    return makeAskAgentError("spawn_unavailable", "ask-agent target spawning is not available in this build", {
      callerAgentId,
      targetAgentId,
    });
  }

  try {
    const result = await deps.runTarget({
      caller,
      target,
      question,
      context,
      signal: deps.signal,
    });
    return {
      ok: true,
      callerAgentId,
      targetAgentId,
      result,
    };
  } catch {
    return makeAskAgentError("spawn_unavailable", "ask-agent target spawning failed before producing a result", {
      callerAgentId,
      targetAgentId,
    });
  }
}

export function formatAskAgentToolResult(result: AskAgentExecutionResult): AskAgentToolResult {
  if (result.ok) {
    return {
      content: [{ type: "text", text: result.result.answer }],
      details: {
        ok: true,
        callerAgentId: result.callerAgentId,
        targetAgentId: result.targetAgentId,
        result: result.result,
      },
    };
  }
  return {
    content: [{ type: "text", text: `ask-agent error (${result.error.code}): ${result.error.message}` }],
    details: {
      ok: false,
      callerAgentId: result.callerAgentId,
      targetAgentId: result.targetAgentId,
      error: result.error,
    },
    isError: true,
  };
}
