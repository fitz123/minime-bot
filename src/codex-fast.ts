import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { AgentConfig } from "./types.js";
import { resolveWorkspaceContract } from "./workspace-contract.js";

export const PI_FAST_THREAD_ENV = "MINIME_BOT_PI_SESSION_THREAD_KEY";
class FastPreferencesError extends Error {}
export function formatFastCommandError(error: unknown): string {
  return error instanceof FastPreferencesError ? error.message : "Codex Fast control data is unavailable; check configuration/preferences and permissions, then retry.";
}

export type FastOverride = "on" | "off" | "inherit";
interface Preference {
  agentId: string;
  provider: "openai-codex";
  model: string;
  enabled: boolean;
  threadKey?: string;
}
interface Preferences { version: 1; defaults: Preference[]; threads: Preference[] }
export interface FastScope { agent: AgentConfig; threadKey?: string }

export function fastPreferencesPath(): string {
  return join(resolveWorkspaceContract().paths.dataDir, "codex-fast.json");
}

export function isFastEligible(agent: AgentConfig | undefined, model?: { provider: string; id: string }): agent is AgentConfig & { codexFast: NonNullable<AgentConfig["codexFast"]> } {
  const pin = agent?.codexFast;
  return !!agent && !!pin && pin.provider === "openai-codex" &&
    (agent.model.includes("/") ? agent.model : `openai-codex/${agent.model}`) === `${pin.provider}/${pin.model}` &&
    (!model || (model.provider === pin.provider && model.id === pin.model));
}

function readPreferences(path: string): Preferences {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, defaults: [], threads: [] };
    throw error;
  }
  const invalid = () => { throw new FastPreferencesError("Invalid Codex Fast preferences; restore valid version 1 control data"); };
  if (Buffer.byteLength(text) > 1024 * 1024) return invalid();
  let raw: any;
  try { raw = JSON.parse(text); } catch { return invalid(); }
  if (!raw || raw.version !== 1 || Object.keys(raw).some(key => !["version", "defaults", "threads"].includes(key))) return invalid();
  for (const group of ["defaults", "threads"] as const) {
    if (!Array.isArray(raw[group])) return invalid();
    const keys = new Set<string>();
    for (const item of raw[group]) {
      const fields = ["agentId", "provider", "model", "enabled", ...(group === "threads" ? ["threadKey"] : [])];
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== fields.length ||
          Object.keys(item).some(key => !fields.includes(key)) || item.provider !== "openai-codex" ||
          typeof item.enabled !== "boolean" || [item.agentId, item.model, ...(group === "threads" ? [item.threadKey] : [])]
            .some(value => typeof value !== "string" || !value.trim() || value.length > 4096)) return invalid();
      const key = JSON.stringify([item.agentId, item.provider, item.model, item.threadKey]);
      if (keys.has(key)) return invalid();
      keys.add(key);
    }
  }
  return raw as Preferences;
}

function matches(item: Preference, scope: FastScope): boolean {
  return item.agentId === scope.agent.id && item.provider === scope.agent.codexFast?.provider && item.model === scope.agent.codexFast.model;
}

export function readFastStatus(scope: FastScope, path = fastPreferencesPath()): { defaultEnabled: boolean; override: FastOverride; enabled: boolean } {
  if (!isFastEligible(scope.agent)) throw new Error("Codex Fast is not opted in for this agent/exact model");
  const data = readPreferences(path);
  const defaultEnabled = data.defaults.find(item => matches(item, scope))?.enabled ?? false;
  const thread = scope.threadKey === undefined ? undefined : data.threads.find(item => matches(item, scope) && item.threadKey === scope.threadKey);
  return { defaultEnabled, override: thread ? (thread.enabled ? "on" : "off") : "inherit", enabled: thread?.enabled ?? defaultEnabled };
}

function setPreference(scope: FastScope, value: FastOverride, defaultScope: boolean, path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Native commands and the bot can write from different processes. Fail with an
  // actionable retry instead of losing another scope's read/modify/write update.
  let lock: number;
  try { lock = openSync(`${path}.lock`, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new FastPreferencesError("Codex Fast preferences are busy; retry (remove a stale codex-fast.json.lock after a crashed writer)");
    throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const data = readPreferences(path);
    const group = defaultScope ? "defaults" : "threads";
    data[group] = data[group].filter(item => !matches(item, scope) || (!defaultScope && item.threadKey !== scope.threadKey));
    if (value !== "inherit") data[group].push({ agentId: scope.agent.id, ...scope.agent.codexFast!, enabled: value === "on", ...(!defaultScope ? { threadKey: scope.threadKey } : {}) });
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    closeSync(lock);
    unlinkSync(`${path}.lock`);
  }
}

/** Presentation for the queried session, gated by current opt-in and its actual model. */
export function formatFastStatusLine(scope: FastScope | undefined, model: string, path?: string): string {
  if (!scope || !isFastEligible(scope.agent) ||
      (model !== scope.agent.codexFast.model && model !== `${scope.agent.codexFast.provider}/${scope.agent.codexFast.model}`)) {
    return "Fast: unavailable (agent/model not opted in)";
  }
  try {
    const status = readFastStatus(scope, path);
    return `Fast: ${status.enabled ? "on" : "off"} · ${status.override === "inherit" ? "inherited" : "thread override"}`;
  } catch {
    return "Fast: unknown (read error)";
  }
}

export const FAST_USAGE = "Usage: /fast [status|on|off|inherit|help] or /fast default [on|off|status]";
const FAST_HELP = [
  "/fast или /fast status — показать режим для этого треда.",
  "/fast on|off — включить или выключить Fast в этом треде.",
  "/fast inherit — следовать общему режиму агента/модели.",
  "/fast default on|off|status — общий режим агента/модели; без треда доступен только общий режим.",
  "В Telegram менять общий режим можно только в личном чате с DM-привязкой.",
  "Нужен явный opt-in агента для точной модели openai-codex. /fast help доступен и без него.",
  "Fast — настройка запроса service_tier=priority; выданный сервером приоритет неизвестен.",
  "Независимые настройки service_tier сохраняются: priority действует и при выключенном Fast, а auto или другой заданный tier мешает адаптеру добавить priority.",
  "Fast не меняет модель, thinking, авторизацию или историю. Квоты и расход — отдельно: в Telegram /status показывает доступные данные квот.",
].join("\n");
export function handleFastCommand(args: string, scope: FastScope | undefined, path?: string): string {
  const words = args.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1 && words[0] === "help") return FAST_HELP;
  const defaultScope = words[0] === "default";
  const value = defaultScope ? words[1] : words[0];
  if (defaultScope ? words.length !== 2 || !["on", "off", "status"].includes(value) : words.length > 1 || (value !== undefined && !["status", "on", "off", "inherit"].includes(value))) return FAST_USAGE;
  if (!scope || !isFastEligible(scope.agent)) return "Codex Fast unavailable: an identified agent must explicitly opt into its exact openai-codex model.";
  if (!defaultScope && value !== undefined && value !== "status" && scope.threadKey === undefined) return "No identified chat/thread here. Use /fast default on|off|status.";
  if (value !== undefined && value !== "status") setPreference(scope, value as FastOverride, defaultScope, path ?? fastPreferencesPath());
  const status = readFastStatus(scope, path);
  const agentLabel = scope.agent.id === "main" ? "Main" : scope.agent.id;
  const modelLabel = scope.agent.codexFast.model === "gpt-6-astra" ? "Astra" : `${scope.agent.codexFast.provider}/${scope.agent.codexFast.model}`;
  const enabledLabel = (enabled: boolean) => enabled ? "включён" : "выключен";
  return [
    `Fast: ${enabledLabel(status.enabled)}`,
    `Модель: ${modelLabel}`,
    scope.threadKey === undefined ? "Область: только общий режим (без треда)" :
      `Этот тред: ${status.override === "inherit" ? "по умолчанию" : `${enabledLabel(status.enabled)} (переопределение)`}`,
    `Общий режим ${agentLabel}/${modelLabel}: ${enabledLabel(status.defaultEnabled)}`,
  ].join("\n");
}
