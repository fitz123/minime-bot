import type { TelegramBinding } from "./types.js";

/**
 * Resolve a Telegram chatId (and optional topicId) to its binding config.
 * Bindings with topicId set only match when both chatId and topicId match.
 * A chatId-only binding serves as a fallback when no topic-specific binding matches.
 */
export function resolveBinding(
  chatId: number,
  bindings: TelegramBinding[],
  topicId?: number,
): TelegramBinding | undefined {
  let fallback: TelegramBinding | undefined;
  for (const binding of bindings) {
    if (binding.chatId !== chatId) continue;
    if (binding.topicId !== undefined) {
      if (binding.topicId === topicId) return binding;
    } else {
      fallback ??= binding;
    }
  }

  if (fallback && topicId !== undefined && fallback.topics) {
    const topic = fallback.topics.find((candidate) => candidate.topicId === topicId);
    if (topic) {
      const { topics: _, ...base } = fallback;
      return {
        ...base,
        agentId: topic.agentId ?? fallback.agentId,
        requireMention: topic.requireMention ?? fallback.requireMention,
        topicId,
      };
    }
  }

  if (fallback && topicId !== undefined) {
    return { ...fallback, topicId };
  }

  return fallback;
}
