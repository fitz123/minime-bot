import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PiThinkingLevel } from "../types.js";
import { resolveWorkspaceContract } from "../workspace-contract.js";

export const SESSION_EFFORT_ENV = "MINIME_SESSION_EFFORT";
export const SESSION_EFFORT_COMMAND = "minime-session-effort";
export const SESSION_EFFORT_ACK_COMMAND = "minime-session-effort-ack";
const PREFIX = "minime_session_effort:";
export const EFFORT_USAGE = "Use /effort to see supported levels, /effort LEVEL to change this conversation, /effort inherit to follow the default, or /effort default LEVEL to change the agent's default for this model.";
export const EFFORT_DEFAULT_PERMISSION = "Use a private chat with a DM binding to change effort defaults.";

export type EffortAction = { kind: "status" | "inherit" } | { kind: "override" | "default"; level: string };
export type EffortRequestAction = EffortAction | { kind: "restore"; level?: PiThinkingLevel };
export type EffortSource = "conversation override" | "agent default" | "agent configuration" | "Pi default";

export function parseEffortAction(args = ""): EffortAction | undefined {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || (words.length === 1 && words[0] === "status")) return { kind: "status" };
  if (words.length === 2 && words[0] === "default" && !["inherit", "status", "default"].includes(words[1])) {
    return { kind: "default", level: words[1] };
  }
  if (words.length !== 1 || words[0] === "default") return;
  return words[0] === "inherit" ? { kind: "inherit" } : { kind: "override", level: words[0] };
}

export function effortDefaultPath(agentId: string, model: { provider: string; id: string }): string {
  const scope = createHash("sha256").update(JSON.stringify([agentId, model.provider, model.id])).digest("hex");
  return join(resolveWorkspaceContract().paths.dataDir, "effort-defaults", scope);
}

export function readEffortDefault(path: string): string | undefined {
  try { return readFileSync(path, "utf8").trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function writeEffortDefault(path: string, level: PiThinkingLevel): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // One atomic replacement per agent and model, with no shared read-modify-write.
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${level}\n`, { mode: 0o600, flag: "wx", flush: true });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

export interface EffortResult {
  kind: "result";
  id: string;
  effective: PiThinkingLevel;
  source: EffortSource;
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
      && ["conversation override", "agent default", "agent configuration", "Pi default"].includes(value.source)
      && value.levels.every((level: unknown) => typeof level === "string")
      && (value.error === undefined || typeof value.error === "string")) return value;
  } catch { /* Ignore unrelated/malformed notices. */ }
}
export function effortInvocation(command: string, value: unknown): string {
  return `/${command} ${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}
