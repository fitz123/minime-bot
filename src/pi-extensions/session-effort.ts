import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { resolveCliModel, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { NativeEffortLevel, PiThinkingLevel } from "../types.js";
import { resolveWorkspaceContract } from "../workspace-contract.js";

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
export interface EffortConfiguration { model?: string; inherited?: PiThinkingLevel }
export interface SessionEffortStartup extends EffortConfiguration { override?: NativeEffortLevel; readOnly?: boolean }

export function resolveSessionEffort(options: {
  agentId: string;
  model: Model<Api>;
  override?: NativeEffortLevel;
  configured: EffortConfiguration;
  modelRuntime: Pick<ModelRuntime, "getModels" | "hasConfiguredAuth">;
  getSettings: () => { modelThinkingLevels?: Record<string, NativeEffortLevel>; defaultThinkingLevel?: NativeEffortLevel };
}): { effective: NativeEffortLevel; source: EffortSource } {
  const { agentId, model, override, configured, modelRuntime, getSettings } = options;
  if (override !== undefined) return { effective: clampThinkingLevel(model, override), source: "conversation override" };
  const saved = readEffortDefault(effortDefaultPath(agentId, model));
  const level = getSupportedThinkingLevels(model).find(candidate => candidate === saved);
  if (level !== undefined) return { effective: level, source: "agent default" };

  // Native CLI resolution distinguishes a thinking suffix from a literal colon in a model ID.
  // On resume the previous native thinking entry cannot supply the configured baseline.
  const cli = configured.model && resolveCliModel({
    cliModel: configured.model, cliThinking: configured.inherited, modelRuntime: modelRuntime as ModelRuntime,
  });
  if (!cli || (cli.model?.provider === model.provider && cli.model.id === model.id)) {
    const inherited = configured.inherited ?? (cli ? cli.thinkingLevel : undefined);
    if (inherited !== undefined) return { effective: clampThinkingLevel(model, inherited), source: "agent configuration" };
  }
  const settings = getSettings();
  const native = settings.modelThinkingLevels?.[`${model.provider}/${model.id}`] ?? settings.defaultThinkingLevel ?? "medium";
  return { effective: clampThinkingLevel(model, native), source: "Pi default" };
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

export function writeEffortDefault(path: string, level: NativeEffortLevel): void {
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
  effective: NativeEffortLevel;
  source: EffortSource;
  levels: NativeEffortLevel[];
  error?: string;
}

export function formatEffortStatus({ effective, source, levels }: Pick<EffortResult, "effective" | "source" | "levels">): string {
  const supported = levels.length ? `Supported levels are ${levels.join(", ")}.` : "No supported levels are available.";
  return `Effort is ${effective}. Source is the ${source}. ${supported}`;
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
