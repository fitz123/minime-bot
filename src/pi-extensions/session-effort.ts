import type { PiThinkingLevel } from "../types.js";

export const SESSION_EFFORT_ENV = "MINIME_SESSION_EFFORT";
export const SESSION_EFFORT_COMMAND = "minime-session-effort";
export const SESSION_EFFORT_ACK_COMMAND = "minime-session-effort-ack";
const PREFIX = "minime_session_effort:";
export interface EffortResult {
  kind: "result";
  id: string;
  effective: PiThinkingLevel;
  previous?: PiThinkingLevel;
  levels: PiThinkingLevel[];
  error?: string;
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
      && (value.previous === undefined || typeof value.previous === "string")
      && value.levels.every((level: unknown) => typeof level === "string")
      && (value.error === undefined || typeof value.error === "string")) return value;
  } catch { /* Ignore unrelated/malformed notices. */ }
}
export function effortInvocation(command: string, value: unknown): string {
  return `/${command} ${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}
