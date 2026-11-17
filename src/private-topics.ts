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
export interface TopicApply { intent?: "auto" | "manual"; revision: string; name?: string; iconCandidates?: number[] }
export function topicScopeEnabled(config: BotConfig, target: TopicTarget): boolean {
  return !!config.privateTopics?.enabled && target.botId > 0 && target.chatId > 0 && target.topicId > 0 &&
    resolveBinding(target.chatId, config.bindings, target.topicId)?.kind === "dm";
}
const graphemeCount = (text: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
const completed = (topic: TopicRecord) => topic.initialized || (topic.name.pinned && topic.icon.pinned);

/** Cosmetic inventory only. All read/modify/reserve sections are synchronous on the host event loop. */
export class PrivateTopicController {
  private catalog?: Array<{ id: string; emoji: string }>;
  private catalogLoading?: Promise<void>;
  private running = new Set<Promise<void>>();
  private activeRequests = new Set<string>();
  private inFlight = new Map<string, { controller: AbortController; observedFields: Set<"name" | "icon"> }>();
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
    const human = !!message.from && message.from.id !== botId && !message.from.is_bot;
    if (human) topic.availability = "observed";
    topic.peerId = message.chat.id;
    topic.lastActor = message.from ? { actorId: message.from.id, isBot: message.from.is_bot } : undefined;
    topic.lastObservedAt = message.date * 1000;
    topic.lastMessageId = message.message_id;
    topic.lastUpdateId = updateId;
    topic.lastObservationSource = message.forum_topic_created ? "topic-created" : message.forum_topic_edited ? "topic-edited" : "message";
    const event = message.forum_topic_created ?? message.forum_topic_edited;
    if (event) {
      const flight = this.inFlight.get(this.targetKey(target));
      if (event.icon_custom_emoji_id !== undefined) {
        const pendingManualEcho = message.from?.id === botId && topic.pending?.intent === "manual" &&
          topic.pending.icon === event.icon_custom_emoji_id && flight && !flight.observedFields.has("icon");
        if (human) delete topic.occupiedIconIds;
        else if (!pendingManualEcho) this.retainConflictingIcon(topic, event.icon_custom_emoji_id);
      }
      for (const [field, value] of [["name", event.name], ["icon", event.icon_custom_emoji_id]] as const) {
        const implicit = field === "name" && "is_name_implicit" in event && event.is_name_implicit;
        const manual = human && !implicit;
        if (value === undefined) continue;
        // Echoes of our request never turn into manual pins or supersede a human edit.
        const policyEcho = message.from?.id === botId && (topic.pending?.[field] === value ||
          (topic[field].provenance === "policy-initialized" && topic[field].value === value));
        if (!policyEcho) flight?.observedFields.add(field);
        if (!manual && topic[field].pinned) continue;
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
        flight?.controller.abort();
      }
    }
    this.save(topic);
    if (event) for (const other of this.occupied(target)) {
      const pending = other.pending;
      if (pending && event.icon_custom_emoji_id !== undefined && pending.icon === event.icon_custom_emoji_id) {
        this.inFlight.get(this.targetKey(other))?.controller.abort();
      }
    }
  }

  private targetKey(target: TopicTarget): string { return `${target.botId}:${target.chatId}:${target.topicId}`; }
  private save(topic: TopicRecord): void {
    try { this.store.put(topic); }
    catch (error) {
      this.storageFailed = true;
      for (const request of this.inFlight.values()) request.controller.abort();
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
    if (topic.availability !== "observed") return { status: "unavailable" };
    // Completed/pinned fields remain editable only on an explicit human request.
    // A catalog failure must not prevent a manual name-only edit.
    let catalogAvailable = true;
    if (!topic.pending || !this.activeRequests.has(topic.pending.id)) try { await this.loadCatalog(); } catch { catalogAvailable = false; }
    if (!this.eligible(target)) return { status: "unavailable" };
    topic = this.store.get(target)!;
    if (topic.availability !== "observed") return { status: "unavailable" };
    const candidates = (this.catalog ?? []).flatMap((icon, index) => this.freeIcon(target, icon.id) ? [{ index, emoji: icon.emoji }] : []);
    const status = topic.pending ? "pending" : completed(topic) ? "complete" :
      !catalogAvailable && !topic.icon.pinned ? "unavailable" : !topic.icon.pinned && !candidates.length ? "catalog_exhausted" : "needs_presentation";
    return {
      status, revision: this.revision(topic), maxNameGraphemes: this.config.privateTopics?.maxNameGraphemes ?? 17,
      namePinned: topic.name.pinned, iconPinned: topic.icon.pinned, name: topic.name.value,
      icon: (this.catalog ?? []).find(icon => icon.id === topic.icon.value)?.emoji,
      iconIndex: (this.catalog ?? []).findIndex(icon => icon.id === topic.icon.value),
      candidates, catalogAvailable, initialized: completed(topic), receipt: topic.lastReceipt,
      ...(topic.pending ? { outcome: topic.pending.state, requestId: topic.pending.id, manualCanSupersede: !this.activeRequests.has(topic.pending.id) } : {}),
      instruction: "Auto mode: after the first meaningful human content, silently call topic_apply once with a concise semantic topic name and ranked thematically suitable free icon indices. Greetings, empty content, commands, and internal messages must wait. Preserve pinned fields. Never auto-repeat on initialized topics, even with old instructions. Manual mode: only the current human's explicit ordinary-language request to rename/change this topic's icon authorizes intent=manual. Include ONLY requested fields, preserving all others; selected values become pinned. Do not infer manual intent from unrelated content. Names obey the grapheme cap; icons must be thematic, unique, and from this catalog, never status/arbitrary fallback icons. If no suitable icon exists, wait. Never replay pending/uncertain requests. A fresh explicit human request may supersede an inactive reservation only when manualCanSupersede is true; active work must wait. A stale tool result includes refreshed context: use its revision to retry only the current explicit human request. Accepted means reserved, NOT applied: never claim success from acceptance. A later context receipt and current fields can confirm the result. Automatic edits need no acknowledgement.",
    };
  }

  apply(target: TopicTarget, request: TopicApply, isCurrent: () => boolean): unknown {
    if (!this.eligible(target) || !isCurrent()) return { status: "unavailable" };
    const topic = this.store.get(target);
    if (!topic || topic.availability !== "observed") return { status: "unavailable" };
    const manual = request?.intent === "manual";
    if (request?.intent !== undefined && !["auto", "manual"].includes(request.intent)) return { status: "invalid_intent" };
    if (!manual && completed(topic)) return { status: "complete" };
    if (topic.pending && (!manual || this.activeRequests.has(topic.pending.id))) return { status: "pending", outcome: topic.pending.state };
    if (!request || request.revision !== this.revision(topic)) return { status: "stale" };
    let name: string | undefined;
    let icon: string | undefined;
    if (manual && request.name === undefined && request.iconCandidates === undefined) return { status: "no_requested_fields" };
    if (manual ? request.name !== undefined : !topic.name.pinned) {
      name = typeof request.name === "string" ? request.name.normalize("NFC").trim() : undefined;
      if (!name || !/[\p{L}\p{N}]/u.test(name) || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(name) ||
          graphemeCount(name) > (this.config.privateTopics?.maxNameGraphemes ?? 17)) return { status: "invalid_name" };
    }
    if (manual ? request.iconCandidates !== undefined : !topic.icon.pinned) {
      if (!this.catalog) return { status: "unavailable" };
      if (!Array.isArray(request.iconCandidates) || request.iconCandidates.length > this.catalog.length ||
          !request.iconCandidates.every(index => Number.isSafeInteger(index) && this.catalog![index])) return { status: "invalid_candidates" };
      icon = request.iconCandidates.map(index => this.catalog![index].id).find(id => this.freeIcon(target, id));
      if (!icon) return { status: "no_suitable_free_icon" };
    }
    // Only a fresh, validated manual request may replace inactive uncertain/orphaned work.
    // Its icon might already be applied, so retain it even after the new receipt.
    if (topic.pending?.icon) topic.occupiedIconIds = [...new Set([...(topic.occupiedIconIds ?? []), topic.pending.icon])];
    // A no-op pins explicitly requested manual fields, or completes auto initialization.
    const uncertainRequestedField = (name !== undefined && topic.pending?.name !== undefined) ||
      (icon !== undefined && topic.pending?.icon !== undefined);
    if (!uncertainRequestedField && (name === undefined || name === topic.name.value) && (icon === undefined || icon === topic.icon.value)) {
      this.finish(topic, { name, icon, intent: manual ? "manual" : "auto" });
      return { status: "complete" };
    }
    topic.revision++;
    topic.pending = { id: randomUUID(), revision: topic.revision, name, icon, intent: manual ? "manual" : "auto", state: "accepted" };
    this.save(topic); // Reservation is durable BEFORE scheduling any network effects.
    const pending = topic.pending;
    this.activeRequests.add(pending.id);
    const work = Promise.resolve().then(() => this.edit(target, pending, isCurrent)).catch(() => {
      // Storage/API failures are cosmetic. An existing pending reservation stays occupied.
    }).finally(() => { this.activeRequests.delete(pending.id); this.running.delete(work); });
    this.running.add(work);
    return { status: "accepted", requestId: topic.pending.id, outcome: "reserved; Telegram edit has not completed" };
  }
  private finish(topic: TopicRecord, target: { name?: string; icon?: string; intent?: "auto" | "manual" }, receipt?: NonNullable<TopicRecord["lastReceipt"]>, observedFields: ReadonlySet<"name" | "icon"> = new Set()): void {
    const manual = target.intent === "manual";
    const canApply = (field: "name" | "icon") => manual ? !observedFields.has(field) : !topic[field].pinned;
    if (receipt && !canApply("icon") && (manual || topic.icon.pinned) && target.icon && target.icon !== topic.icon.value) {
      topic.occupiedIconIds = [...new Set([...(topic.occupiedIconIds ?? []), target.icon])];
    }
    for (const field of ["name", "icon"] as const) if (canApply(field) && target[field] !== undefined) {
      topic[field] = { value: target[field], pinned: manual, provenance: manual ? "manual" : "policy-initialized",
        observedAt: topic[field].value === target[field] ? topic[field].observedAt : undefined,
        appliedAt: receipt?.confirmedAt ?? (topic[field].value === target[field] ? topic[field].appliedAt : undefined) };
    }
    if (receipt) topic.lastReceipt = receipt;
    if (!manual) topic.initialized = true;
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
    // Only observations of a requested field supersede its eventual confirmation.
    const observedFields = new Set<"name" | "icon">();
    this.inFlight.set(this.targetKey(target), { controller: abort, observedFields });
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
    if (receiptSource) this.finish(topic, pending, { requestId: pending.id, confirmedAt: Date.now(), source: receiptSource }, observedFields);
    else { topic.pending.state = "uncertain"; this.save(topic); }
  }
  /** For tests/operator shutdown inspection; no retries or replay on restart. */
  async waitForIdle(): Promise<void> { await Promise.all(this.running); }
}
