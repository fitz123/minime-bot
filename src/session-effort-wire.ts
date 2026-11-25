import type { NativeEffortLevel, PiThinkingLevel } from "./types.js";

export const SESSION_EFFORT_ENV = "MINIME_SESSION_EFFORT";
export const SESSION_EFFORT_COMMAND = "minime-session-effort";
export const SESSION_EFFORT_ACK_COMMAND = "minime-session-effort-ack";
const PREFIX = "minime_session_effort:";
export const EFFORT_USAGE = "Use /effort to see supported levels, /effort LEVEL to change this conversation, /effort inherit to follow the default, or /effort default LEVEL to change the agent's default for this model.";
export const EFFORT_DEFAULT_PERMISSION = "Use a private chat with a DM binding to change effort defaults.";
export const EFFORT_CURRENT_CONVERSATION = "Effort controls are available only in the current human Telegram conversation.";

export class EffortControlError extends Error {}
export class EffortConfirmationTimeout extends EffortControlError {}

export function formatEffortError(error: unknown): string {
  return `Effort change not confirmed: ${error instanceof EffortControlError
    ? error.message
    : "Effort control data is unavailable. Check configuration and control workspace permissions, then retry."}`;
}

export type EffortAction = { kind: "status" | "inherit" } | { kind: "override" | "default"; level: string };
export type EffortRequestAction = EffortAction | { kind: "restore"; level?: NativeEffortLevel };
export type EffortSource = "conversation override" | "agent default" | "agent configuration" | "Pi default";
export interface EffortConfiguration { provider?: string; model?: string; inherited?: PiThinkingLevel }
export interface SessionEffortStartup extends EffortConfiguration { override?: NativeEffortLevel; readOnly?: boolean }
export interface EffortCommandRequest {
  id: string;
  action: EffortRequestAction;
  model?: string;
  inherited?: PiThinkingLevel;
}

export function parseEffortAction(args = ""): EffortAction | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || (words.length === 1 && words[0] === "status")) return { kind: "status" };
  if (words.length === 2 && words[0] === "default" && !["inherit", "status", "default"].includes(words[1])) {
    return { kind: "default", level: words[1] };
  }
  if (words.length !== 1 || words[0] === "default") return;
  return words[0] === "inherit" ? { kind: "inherit" } : { kind: "override", level: words[0] };
}

export interface EffortResult {
  kind: "result";
  id: string;
  effective: NativeEffortLevel;
  source: EffortSource;
  levels: NativeEffortLevel[];
  running?: NativeEffortLevel;
  error?: string;
}

export function formatEffortStatus({ effective, source, levels, running }: Pick<EffortResult, "effective" | "source" | "levels" | "running">): string {
  const supported = levels.length ? `Supported levels are ${levels.join(", ")}.` : "No supported levels are available.";
  const status = running !== undefined && running !== effective
    ? `The current answer uses ${running}. The next message will use ${effective}.`
    : `Effort is ${effective}.`;
  return `${status} Source is the ${source}. ${supported}`;
}

export interface EffortRequest { kind: "request"; id: string; value: string }
export type EffortNotice = EffortResult | EffortRequest;
export function effortNotice(value: EffortNotice): string {
  return PREFIX + Buffer.from(JSON.stringify(value)).toString("base64url");
}
export function parseEffortNotice(message: unknown): EffortNotice | undefined {
  if (typeof message !== "string" || !message.startsWith(PREFIX)) return;
  try {
    const value = JSON.parse(Buffer.from(message.slice(PREFIX.length), "base64url").toString());
    if (typeof value.id !== "string" || !value.id) return;
    if (value.kind === "request" && typeof value.value === "string") return value;
    if (value.kind === "result" && typeof value.effective === "string" && Array.isArray(value.levels)
      && ["conversation override", "agent default", "agent configuration", "Pi default"].includes(value.source)
      && value.levels.every((level: unknown) => typeof level === "string")
      && (value.running === undefined || typeof value.running === "string")
      && (value.error === undefined || typeof value.error === "string")) return value;
  } catch { /* Ignore unrelated/malformed notices. */ }
}
export function effortInvocation(command: string, value: unknown): string {
  return `/${command} ${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}
