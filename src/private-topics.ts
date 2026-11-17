import { createHash, randomUUID } from "node:crypto";
import type { Api } from "grammy";
import type { Message } from "grammy/types";
import type { BotConfig } from "./types.js";
import { resolveBinding } from "./telegram-binding.js";
import { TopicStore, type TopicRecord, type TopicTarget } from "./topic-store.js";

export interface TopicApi {
  getForumTopicIconStickers(): Promise<Array<{ custom_emoji_id?: string; emoji?: string }>>;
  editForumTopic(chatId: number, topicId: number, edit: { name?: string; icon_custom_emoji_id?: string }, signal?: Parameters<Api["editForumTopic"]>[3]): Promise<unknown>;
}
export interface TopicApply { revision: string; name?: string; iconCandidates?: number[] }
export function topicScopeEnabled(config: BotConfig, target: TopicTarget): boolean {
  return !!config.collaboration && config.privateTopics?.expectedBotId === target.botId &&
    config.privateTopics.chatIds.includes(target.chatId) && target.topicId > 0 &&
    resolveBinding(target.chatId, config.bindings, target.topicId)?.kind === "dm";
}
const graphemeCount = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
const completed = (topic: TopicRecord) => topic.initialized || (topic.name.pinned && topic.icon.pinned);

/** Cosmetic inventory only. All read/modify/reserve sections are synchronous on the host event loop. */
export class PrivateTopicController {
  private catalog?: Array<{ id: string; emoji: string }>;
  private catalogLoading?: Promise<void>;
  private running = new Set<Promise<void>>();
  private inFlight = new Map<string, AbortController>();
  private storageFailed = false;
  constructor(
    private config: BotConfig,
    readonly store: TopicStore,
    private api: TopicApi,
    private botId: () => number | undefined,
  ) {}
  eligible(target: TopicTarget, config = this.config): boolean {
    return !this.storageFailed && this.botId() === target.botId && topicScopeEnabled(this.config, target) && topicScopeEnabled(config, target);
  }
  currentBotId(): number | undefined { return this.botId(); }

  observe(message: Message, updateId?: number): void {
    const botId = this.botId();
    if (botId === undefined || message.chat.type !== "private" || !message.message_thread_id) return;
    const target = { botId, chatId: message.chat.id, topicId: message.message_thread_id };
    if (!this.eligible(target)) return;
    const old = this.store.get(target);
    const topic: TopicRecord = old ?? {
      ...target, name: { provenance: "unknown", pinned: false }, icon: { provenance: "unknown", pinned: false },
      revision: 0, initialized: false, availability: "observed",
    };
    topic.peerId = message.chat.id;
    topic.lastActor = message.from ? { actorId: message.from.id, isBot: message.from.is_bot } : undefined;
    topic.lastObservedAt = message.date * 1000;
    topic.lastMessageId = message.message_id;
    topic.lastUpdateId = updateId;
    topic.lastObservationSource = message.forum_topic_created ? "topic-created" : message.forum_topic_edited ? "topic-edited" : "message";
    const event = message.forum_topic_created ?? message.forum_topic_edited;
    if (event) {
      const implicit = "is_name_implicit" in event && event.is_name_implicit;
      const manual = !!message.from && message.from.id !== botId && !message.from.is_bot && !implicit;
      if (event.icon_custom_emoji_id !== undefined) {
        if (manual) delete topic.occupiedIconIds;
        else this.retainConflictingIcon(topic, event.icon_custom_emoji_id);
      }
      for (const [field, value] of [["name", event.name], ["icon", event.icon_custom_emoji_id]] as const) {
        if (value === undefined || (!manual && topic[field].pinned)) continue;
        // Echoes of our request never turn into manual pins or supersede a human edit.
        const policyEcho = message.from?.id === botId && (topic.pending?.[field] === value ||
          (topic[field].provenance === "policy-initialized" && topic[field].value === value));
        topic[field] = { value, pinned: manual, observedAt: topic.lastObservedAt,
          appliedAt: topic[field].value === value ? topic[field].appliedAt : undefined,
          provenance: manual ? "manual" : implicit ? "implicit" :
          policyEcho ? "policy-initialized" : "unknown" };
      }
      // Matching own echoes do not invalidate their request. Other observations
      // change the revision, including implicit creation arriving after context.
      const ownEcho = message.from?.id === botId && !!topic.pending &&
        (event.name === undefined || event.name === topic.pending.name) &&
        (event.icon_custom_emoji_id === undefined || event.icon_custom_emoji_id === topic.pending.icon);
      if (!ownEcho) {
        topic.revision++;
        this.inFlight.get(this.targetKey(target))?.abort();
      }
    }
    this.save(topic);
    if (event) for (const other of this.occupied(target)) {
      const pending = other.pending;
      if (pending && event.icon_custom_emoji_id !== undefined && pending.icon === event.icon_custom_emoji_id) {
        this.inFlight.get(this.targetKey(other))?.abort();
      }
    }
  }

  private targetKey(target: TopicTarget): string { return `${target.botId}:${target.chatId}:${target.topicId}`; }
  private save(topic: TopicRecord): void {
    try { this.store.put(topic); }
    catch (error) {
      this.storageFailed = true;
      for (const controller of this.inFlight.values()) controller.abort();
      throw error;
    }
  }

  private async loadCatalog(): Promise<void> {
    if (this.catalog) return;
    if (!this.catalogLoading) this.catalogLoading = this.api.getForumTopicIconStickers().then(stickers => {
      const icons = stickers.filter(s => s.custom_emoji_id && s.emoji).map(s => ({ id: s.custom_emoji_id!, emoji: s.emoji! }));
      this.catalog = [...new Map(icons.map(icon => [icon.id, icon])).values()];
    }).finally(() => { this.catalogLoading = undefined; });
    await this.catalogLoading;
  }
  private revision(topic: TopicRecord): string {
    // Candidate indices are meaningful only for this exact catalog ordering.
    return `${topic.revision}:${createHash("sha256").update(JSON.stringify(this.catalog ?? [])).digest("hex").slice(0, 16)}`;
  }
  private occupied(target: TopicTarget): TopicRecord[] {
    return this.store.list().filter(topic => topic.botId === target.botId && topic.chatId === target.chatId && topic.topicId !== target.topicId);
  }
  private freeIcon(target: TopicTarget, id: string): boolean {
    return !this.occupied(target).some(topic => topic.icon.value === id || topic.pending?.icon === id || topic.occupiedIconIds?.includes(id));
  }
  private retainConflictingIcon(topic: TopicRecord, icon: string): void {
    if (icon && topic.icon.pinned && icon !== topic.icon.value) {
      topic.occupiedIconIds = [...new Set([...(topic.occupiedIconIds ?? []), icon])];
    }
  }
  async context(target: TopicTarget): Promise<unknown> {
    if (!this.eligible(target)) return { status: "unavailable" };
    let topic = this.store.get(target);
    if (!topic) return { status: "unavailable" };
    if (completed(topic)) return { status: "complete" };
    if (topic.pending) return { status: "pending", outcome: topic.pending.state };
    if (topic.availability !== "observed") return { status: "unavailable" };
    if (!topic.icon.pinned) await this.loadCatalog();
    if (!this.eligible(target)) return { status: "unavailable" };
    topic = this.store.get(target)!;
    if (completed(topic)) return { status: "complete" };
    if (topic.pending) return { status: "pending", outcome: topic.pending.state };
    const candidates = (this.catalog ?? []).flatMap((icon, index) => this.freeIcon(target, icon.id) ? [{ index, emoji: icon.emoji }] : []);
    if (!topic.icon.pinned && !candidates.length) return { status: "catalog_exhausted" };
    return {
      status: "needs_presentation", revision: this.revision(topic), maxNameGraphemes: this.config.privateTopics?.maxNameGraphemes ?? 17,
      namePinned: topic.name.pinned, iconPinned: topic.icon.pinned, name: topic.name.value, candidates,
      instruction: "After the first meaningful human content, silently call topic_apply once with a concise semantic topic name and ranked thematically suitable free icon indices from this context. Greetings, empty content, commands, and internal messages must wait. Preserve pinned fields. Do not use status icons or arbitrary fallback icons. No acknowledgement is needed. Accepted means reserved, not applied. If no suitable icon exists, wait. Old instructions do not authorize changing completed topics.",
    };
  }

  apply(target: TopicTarget, request: TopicApply, isCurrent: () => boolean): unknown {
    if (!this.eligible(target) || !isCurrent()) return { status: "unavailable" };
    const topic = this.store.get(target);
    if (!topic || topic.availability !== "observed") return { status: "unavailable" };
    if (completed(topic)) return { status: "complete" };
    if (topic.pending) return { status: "pending", outcome: topic.pending.state };
    if (!request || request.revision !== this.revision(topic)) return { status: "stale" };
    let name: string | undefined;
    let icon: string | undefined;
    if (!topic.name.pinned) {
      name = typeof request.name === "string" ? request.name.normalize("NFC").trim() : undefined;
      if (!name || !/[\p{L}\p{N}]/u.test(name) || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name) ||
          graphemeCount(name) > (this.config.privateTopics?.maxNameGraphemes ?? 17)) return { status: "invalid_name" };
    }
    if (!topic.icon.pinned) {
      if (!this.catalog) return { status: "unavailable" };
      if (!Array.isArray(request.iconCandidates) || request.iconCandidates.length > this.catalog.length ||
          !request.iconCandidates.every(index => Number.isSafeInteger(index) && this.catalog![index])) return { status: "invalid_candidates" };
      icon = request.iconCandidates.map(index => this.catalog![index].id).find(id => this.freeIcon(target, id));
      if (!icon) return { status: "no_suitable_free_icon" };
    }
    // Even a no-op completes initialization durably, without an API call.
    if ((name === undefined || name === topic.name.value) && (icon === undefined || icon === topic.icon.value)) {
      this.finish(topic, { name, icon });
      return { status: "complete" };
    }
    topic.revision++;
    topic.pending = { id: randomUUID(), revision: topic.revision, name, icon, state: "accepted" };
    this.save(topic); // Reservation is durable BEFORE scheduling any network effects.
    const work = Promise.resolve().then(() => this.edit(target, topic.pending!, isCurrent)).catch(() => {
      // Storage/API failures are cosmetic. An existing pending reservation stays occupied.
    }).finally(() => { this.running.delete(work); });
    this.running.add(work);
    return { status: "accepted", outcome: "reserved; Telegram edit has not completed" };
  }
  private finish(topic: TopicRecord, target: { name?: string; icon?: string }, receipt?: NonNullable<TopicRecord["lastReceipt"]>): void {
    if (receipt && target.icon !== undefined) this.retainConflictingIcon(topic, target.icon);
    for (const field of ["name", "icon"] as const) if (!topic[field].pinned && target[field] !== undefined) {
      topic[field] = { value: target[field], pinned: false, provenance: "policy-initialized",
        observedAt: topic[field].value === target[field] ? topic[field].observedAt : undefined,
        appliedAt: receipt?.confirmedAt ?? (topic[field].value === target[field] ? topic[field].appliedAt : undefined) };
    }
    if (receipt) topic.lastReceipt = receipt;
    topic.initialized = true;
    topic.revision++;
    delete topic.pending;
    this.save(topic);
  }
  private async edit(target: TopicTarget, pending: NonNullable<TopicRecord["pending"]>, isCurrent: () => boolean): Promise<void> {
    let topic = this.store.get(target)!;
    if (topic.pending?.id !== pending.id) return;
    if (topic.revision !== pending.revision || !this.eligible(target) || !isCurrent() ||
        (pending.icon !== undefined && !this.freeIcon(target, pending.icon))) {
      delete topic.pending; // Definitely not sent; an observation or routing change won the race.
      this.save(topic);
      return;
    }
    let receiptSource: NonNullable<TopicRecord["lastReceipt"]>["source"] | undefined;
    const abort = new AbortController();
    this.inFlight.set(this.targetKey(target), abort);
    try {
      const result = await this.api.editForumTopic(target.chatId, target.topicId, {
        ...(pending.name !== undefined ? { name: pending.name } : {}),
        ...(pending.icon !== undefined ? { icon_custom_emoji_id: pending.icon } : {}),
      }, abort.signal as Parameters<TopicApi["editForumTopic"]>[3]);
      if (result === true) receiptSource = "telegram-true";
    } catch (error) {
      if ((error as { error_code?: number; description?: string }).error_code === 400 &&
          /(?:TOPIC|MESSAGE)_NOT_MODIFIED|topic (?:is )?not modified/i.test((error as { description?: string }).description ?? "")) receiptSource = "telegram-not-modified";
    } finally { this.inFlight.delete(this.targetKey(target)); }
    topic = this.store.get(target)!;
    if (topic.pending?.id !== pending.id) return;
    if (receiptSource) this.finish(topic, pending, { confirmedAt: Date.now(), source: receiptSource });
    else { topic.pending.state = "uncertain"; this.save(topic); }
  }
  /** For tests/operator shutdown inspection; no retries or replay on restart. */
  async waitForIdle(): Promise<void> { await Promise.all(this.running); }
}
