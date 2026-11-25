import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { resolveCliModel, type ExtensionAPI, type ExtensionContext, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { NativeEffortLevel } from "../types.js";
import { formatEffortStatus, type EffortCommandRequest, type EffortConfiguration, type EffortResult, type EffortSource } from "../session-effort-wire.js";
import { resolveWorkspaceContract } from "../workspace-contract.js";

function resolveSessionEffort(options: {
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
    cliProvider: configured.provider, cliModel: configured.model, cliThinking: configured.inherited,
    modelRuntime: modelRuntime as ModelRuntime,
  });
  if (!cli || (cli.model?.provider === model.provider && cli.model.id === model.id)) {
    const inherited = configured.inherited ?? (cli ? cli.thinkingLevel : undefined);
    if (inherited !== undefined) return { effective: clampThinkingLevel(model, inherited), source: "agent configuration" };
  }
  const settings = getSettings();
  const native = settings.modelThinkingLevels?.[`${model.provider}/${model.id}`] ?? settings.defaultThinkingLevel ?? "medium";
  return { effective: clampThinkingLevel(model, native), source: "Pi default" };
}

interface EffortPolicyState {
  configured: EffortConfiguration;
  override?: NativeEffortLevel;
}

type EffortPi = Pick<ExtensionAPI, "getThinkingLevel" | "setThinkingLevel" | "getSettings">;

export function getSessionEffort(pi: EffortPi, ctx: ExtensionContext, agentId: string, state: EffortPolicyState) {
  if (!ctx.model) return { effective: pi.getThinkingLevel(), source: "Pi default" as const };
  return resolveSessionEffort({
    agentId, model: ctx.model, ...state, getSettings: () => pi.getSettings(),
    modelRuntime: {
      getModels: () => ctx.modelRegistry.getAll(),
      hasConfiguredAuth: provider => ctx.modelRegistry.getAll().some(candidate => candidate.provider === provider && ctx.modelRegistry.hasConfiguredAuth(candidate)),
    },
  });
}

export function applySessionEffort(
  pi: EffortPi, ctx: ExtensionContext, agentId: string, state: EffortPolicyState, request: EffortCommandRequest,
): EffortResult {
  const { action, id } = request;
  const model = ctx.model;
  const levels = model ? getSupportedThinkingLevels(model) : [];
  const previousOverride = state.override;
  const previousLevel = pi.getThinkingLevel();
  const result: EffortResult = { kind: "result", id, effective: previousLevel, source: "Pi default", levels };
  try {
    if (action.kind === "default" || action.kind === "override") {
      const level = levels.find(candidate => candidate === action.level);
      if (!model || level === undefined) {
        result.error = model ? "This model does not support that effort level." : "No current model is available.";
      } else if (action.kind === "default") {
        writeEffortDefault(effortDefaultPath(agentId, model), level);
      } else {
        state.override = level;
      }
    } else if (action.kind !== "status") {
      state.override = action.kind === "restore" ? action.level : undefined;
    }
    if (request.model !== undefined) {
      state.configured = { model: request.model, inherited: request.inherited, provider: state.configured.provider };
    }
    Object.assign(result, getSessionEffort(pi, ctx, agentId, state));
    if (!result.error && action.kind !== "status" && action.kind !== "default") {
      pi.setThinkingLevel(result.effective);
    }
    const native = pi.getThinkingLevel();
    if (native !== result.effective && !ctx.isIdle()) result.running = native;
    if (result.error) result.error += ` ${formatEffortStatus(result)}`;
  } catch {
    state.override = previousOverride;
    // Pi assigns the native level before writing its transcript entry.
    if (pi.getThinkingLevel() !== previousLevel) {
      try { pi.setThinkingLevel(previousLevel); } catch { /* Verify the native level below. */ }
    }
    result.effective = pi.getThinkingLevel();
    result.error = "Could not apply effort. Check the control workspace permissions and retry.";
    if (result.effective !== previousLevel) result.error += ` The previous level could not be restored. Effective effort is ${result.effective}.`;
  }
  return result;
}

function effortDefaultPath(agentId: string, model: { provider: string; id: string }): string {
  const scope = createHash("sha256").update(JSON.stringify([agentId, model.provider, model.id])).digest("hex");
  return join(resolveWorkspaceContract().paths.dataDir, "effort-defaults", scope);
}

function readEffortDefault(path: string): string | undefined {
  try { return readFileSync(path, "utf8").trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function writeEffortDefault(path: string, level: NativeEffortLevel): void {
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
