import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { resolveWorkspaceContract } from "./workspace-contract.js";

export interface TopicTarget { botId: number; chatId: number; topicId: number }
export interface TopicField {
  value?: string;
  provenance: "unknown" | "implicit" | "manual" | "policy-initialized";
  pinned: boolean;
  observedAt?: number;
  appliedAt?: number;
}
export interface TopicRecord extends TopicTarget {
  /** Observation evidence is optional for imported or older inventory records. Times are Unix milliseconds. */
  peerId?: number;
  lastActor?: { actorId: number; isBot: boolean };
  lastObservedAt?: number;
  lastMessageId?: number;
  lastUpdateId?: number;
  lastObservationSource?: "message" | "topic-created" | "topic-edited";
  lastReceipt?: { requestId?: string; confirmedAt: number; source: "telegram-true" | "telegram-not-modified" };
  name: TopicField;
  icon: TopicField;
  /** Conflicting observed/applied icons remain occupied until a later explicit human icon event. */
  occupiedIconIds?: string[];
  revision: number;
  initialized: boolean;
  availability: "observed" | "unavailable" | "deleted-unconfirmed";
  pending?: {
    id: string;
    revision: number;
    name?: string;
    icon?: string;
    intent?: "auto" | "manual";
    state: "accepted" | "uncertain";
  };
}
export type TopicSnapshot = Omit<TopicRecord, "revision" | "pending" | "initialized"> & { initialized?: boolean };
const key = (target: TopicTarget) => `${target.botId}:${target.chatId}:${target.topicId}`;
const optionalInteger = (value: number | undefined) => value === undefined || (Number.isSafeInteger(value) && value >= 0);
const fieldValid = (field: TopicField) => field && typeof field.pinned === "boolean" &&
  ["unknown", "implicit", "manual", "policy-initialized"].includes(field.provenance) &&
  (field.value === undefined || typeof field.value === "string") && optionalInteger(field.observedAt) && optionalInteger(field.appliedAt);
function valid(record: TopicRecord): boolean {
  return record && [record.botId, record.chatId, record.topicId].every(Number.isSafeInteger) &&
    record.botId > 0 && record.topicId > 0 && fieldValid(record.name) && fieldValid(record.icon) &&
    (record.occupiedIconIds === undefined || (Array.isArray(record.occupiedIconIds) && record.occupiedIconIds.every(id => typeof id === "string" && id.length > 0))) &&
    [record.peerId, record.lastObservedAt, record.lastMessageId, record.lastUpdateId].every(optionalInteger) &&
    (record.lastActor === undefined || (Number.isSafeInteger(record.lastActor.actorId) && typeof record.lastActor.isBot === "boolean")) &&
    (record.lastObservationSource === undefined || ["message", "topic-created", "topic-edited"].includes(record.lastObservationSource)) &&
    (record.lastReceipt === undefined || (Number.isSafeInteger(record.lastReceipt.confirmedAt) && record.lastReceipt.confirmedAt >= 0 &&
      ["telegram-true", "telegram-not-modified"].includes(record.lastReceipt.source) &&
      (record.lastReceipt.requestId === undefined || typeof record.lastReceipt.requestId === "string"))) &&
    Number.isSafeInteger(record.revision) && record.revision >= 0 && typeof record.initialized === "boolean" &&
    ["observed", "unavailable", "deleted-unconfirmed"].includes(record.availability) &&
    (!record.pending || (typeof record.pending.id === "string" && Number.isSafeInteger(record.pending.revision) &&
      ["accepted", "uncertain"].includes(record.pending.state) &&
      (record.pending.intent === undefined || ["auto", "manual"].includes(record.pending.intent)) &&
      [record.pending.name, record.pending.icon].every(value => value === undefined || typeof value === "string")));
}

/** One runtime host owns this inventory. Import verified snapshots offline, before enabling it. */
export class TopicStore {
  private records: TopicRecord[];
  constructor(readonly path = join(resolveWorkspaceContract().paths.dataDir, "private-topics.json")) {
    let raw;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      raw = { version: 1, topics: [] };
    }
    if (raw?.version !== 1 || !Array.isArray(raw.topics) || !raw.topics.every(valid) ||
        new Set(raw.topics.map(key)).size !== raw.topics.length) throw new Error("Invalid private-topic inventory");
    this.records = raw.topics;
  }
  get(target: TopicTarget): TopicRecord | undefined { return this.list().find(record => key(record) === key(target)); }
  list(): TopicRecord[] { return structuredClone(this.records); }
  put(record: TopicRecord): void {
    const next = this.list();
    const index = next.findIndex(item => key(item) === key(record));
    if (index < 0) next.push(record); else next[index] = record;
    this.save(next);
  }
  /** No API access, inferred provenance, or replacement of existing observations. */
  importSnapshot(snapshot: TopicSnapshot[]): void {
    const next = this.list();
    for (const item of snapshot) {
      if (next.some(record => key(record) === key(item))) throw new Error("Topic already known; snapshot import must precede observation");
      next.push({ ...structuredClone(item), initialized: item.initialized ?? false, revision: 0 });
    }
    this.save(next);
  }
  private save(records: TopicRecord[]): void {
    if (!records.every(valid)) throw new Error("Invalid private-topic inventory record");
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, topics: records }));
      fsyncSync(fd);
      closeSync(fd); fd = undefined;
      renameSync(temp, this.path);
      // A directory fsync failure has an uncertain durability outcome. Keep the
      // in-memory reservation too, even though the caller will not dispatch it.
      this.records = structuredClone(records);
      const directory = openSync(dir, "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
}
