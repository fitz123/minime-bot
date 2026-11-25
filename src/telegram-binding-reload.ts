import { isDeepStrictEqual } from "node:util";
import { resolveBinding } from "./telegram-binding.js";
import type { BotConfig, TelegramBinding } from "./types.js";

function groupAgentIds(bindings: TelegramBinding[]): Set<string> {
  const ids = new Set<string>();
  for (const binding of bindings) {
    ids.add(binding.agentId);
    for (const topic of binding.topics ?? []) {
      if (topic.agentId !== undefined) ids.add(topic.agentId);
    }
  }
  return ids;
}

function* groupAddresses(bindings: TelegramBinding[]): Generator<[number, number | undefined]> {
  for (const binding of bindings) {
    yield [binding.chatId, binding.topicId];
    for (const topic of binding.topics ?? []) yield [binding.chatId, topic.topicId];
  }
}

/** The running transport owns the applied routes. Disk reads still supply session settings. */
export function createTelegramBindingReload(startup: BotConfig, readConfig: () => BotConfig, readCandidate: () => BotConfig) {
  let lastParsedConfig = startup;
  let bindings = startup.bindings;
  // A removal followed by an addition still cannot reassign a lane in this process.
  const knownGroups = startup.bindings.filter(binding => binding.kind === "group");
  const startupDms = startup.bindings.filter(binding => binding.kind === "dm");
  const dmChatIds = new Set(startupDms.map(binding => binding.chatId));
  const trigger = startup.triggerInput;
  const triggerAgentId = trigger && resolveBinding(trigger.chatId, startup.bindings, trigger.threadId)?.agentId;

  function withGroupBindings(config: BotConfig): BotConfig {
    return {
      ...config,
      bindings: [
        ...config.bindings.filter(binding => binding.kind === "dm"),
        ...bindings.filter(binding => binding.kind === "group"),
      ],
    };
  }

  return {
    getBindings: () => bindings,
    withGroupBindings,
    loadGroupConfig(): BotConfig {
      try {
        lastParsedConfig = readConfig();
      } catch {
        // Only a failed read falls back. Callers still see valid changes to agents and worker routing.
      }
      return { ...lastParsedConfig, bindings };
    },
    reload(checkRunningTransport: (candidate: TelegramBinding[]) => void): number {
      let candidate: BotConfig;
      try {
        candidate = readCandidate();
      } catch {
        // Parser messages can include YAML source lines or configuration values.
        throw new Error("Effective config or Telegram credential is invalid. Run config validate for schema errors");
      }
      if (!candidate.telegramToken || candidate.telegramToken !== startup.telegramToken) {
        throw new Error("Telegram credential differs from the running transport");
      }
      if (candidate.sessionDefaults.requireMention !== startup.sessionDefaults.requireMention) {
        throw new Error("Changing the global mention policy requires a restart");
      }
      if (!isDeepStrictEqual(candidate.bindings.filter(binding => binding.kind === "dm"), startupDms)) {
        throw new Error("Telegram DM binding changes require a restart");
      }
      const groups = candidate.bindings.filter(binding => binding.kind === "group");
      if (groups.some(binding => dmChatIds.has(binding.chatId))) {
        throw new Error("A Telegram group binding conflicts with a running DM chat");
      }
      const addresses = new Set<string>();
      for (const [chatId, topicId] of groupAddresses(groups)) {
        const key = `${chatId}:${topicId ?? ""}`;
        if (addresses.has(key)) throw new Error("Duplicate Telegram group chat/topic route");
        addresses.add(key);
      }

      const newGroups: TelegramBinding[] = [];
      for (const group of groups) {
        const prior = knownGroups.find(binding => binding.chatId === group.chatId && binding.topicId === group.topicId);
        if (!prior) newGroups.push(group);
        else if (!isDeepStrictEqual(prior, group)) {
          throw new Error("Editing or reassigning an existing Telegram group binding requires a restart");
        }
      }
      for (const [chatId, topicId] of groupAddresses([...knownGroups, ...newGroups])) {
        const prior = resolveBinding(chatId, knownGroups, topicId);
        const next = resolveBinding(chatId, candidate.bindings, topicId);
        if (prior && next && prior.agentId !== next.agentId) {
          throw new Error("Reassigning an existing Telegram group chat/topic route requires a restart");
        }
      }
      for (const id of groupAgentIds(groups)) {
        if (!Object.hasOwn(startup.agents, id) || !Object.hasOwn(candidate.agents, id)) {
          throw new Error("A Telegram group references an agent unavailable in the running process");
        }
        if (!isDeepStrictEqual(candidate.agents[id].workerRuntime, startup.agents[id].workerRuntime)) {
          throw new Error("A Telegram group references an agent whose worker route changed since startup");
        }
      }
      if (trigger && resolveBinding(trigger.chatId, candidate.bindings, trigger.threadId)?.agentId !== triggerAgentId) {
        throw new Error("Changing the running trigger input binding requires a restart");
      }
      checkRunningTransport(candidate.bindings);
      knownGroups.push(...newGroups);
      lastParsedConfig = candidate;
      bindings = candidate.bindings;
      return groups.length;
    },
  };
}

export type TelegramBindingReload = ReturnType<typeof createTelegramBindingReload>;
