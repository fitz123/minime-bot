import {
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname, isAbsolute, normalize } from "node:path";
import type {
  BotConfig,
  BoundSessionState,
  LegacyCutoverFailure,
  PendingSessionRecoveryNotice,
  PiThinkingLevel,
  SessionState,
  UnresolvedLegacySessionState,
} from "./types.js";
import {
  listInteractiveSessionEvidence,
  inspectLegacyInteractiveSessionCandidate,
  resolveInteractiveSessionLocation,
  type InteractiveSessionBinding,
  type InteractiveSessionInspectionOptions,
  type InteractiveSessionLocationOptions,
} from "./interactive-session-binding.js";
import {
  MAX_SESSION_ID_LENGTH,
  MAX_SESSION_RECOVERY_REASON_LENGTH,
} from "./types.js";
import { resolveWorkspaceContract } from "./workspace-contract.js";

function defaultStorePath(): string {
  return resolveWorkspaceContract().paths.sessionStorePath;
}

export type SessionStoreData = Record<string, SessionState>;

interface LegacySessionState {
  sessionId: string;
  chatId: string;
  agentId: string;
  provider?: "pi";
  model?: string;
  thinking?: PiThinkingLevel;
  lastActivity: number;
}

type LegacySessionStoreData = Record<string, LegacySessionState>;

export interface LegacySessionMigrationOptions
  extends InteractiveSessionLocationOptions, InteractiveSessionInspectionOptions {
  maxCandidates?: number;
}

export const SESSION_STORE_VERSION = 2;
export const MAX_SESSION_STORE_BYTES = 16 * 1024 * 1024;
export const MAX_SESSION_STATE_STRING_LENGTH = 4_096;
export const LEGACY_SESSION_BACKUP_SUFFIX = ".legacy-v1.bak";

const BASE_STATE_KEYS = new Set([
  "bindingState",
  "chatId",
  "agentId",
  "provider",
  "model",
  "thinking",
  "lastActivity",
]);
const BOUND_STATE_KEYS = new Set([
  ...BASE_STATE_KEYS,
  "sessionId",
  "sessionFile",
  "workspaceRealpath",
  "pendingRecoveryNotice",
]);
const UNRESOLVED_STATE_KEYS = new Set([
  ...BASE_STATE_KEYS,
  "failedSessionId",
  "legacyFailure",
]);
const LEGACY_STATE_KEYS = new Set([
  "sessionId",
  "chatId",
  "agentId",
  "provider",
  "model",
  "thinking",
  "lastActivity",
]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const LEGACY_FAILURES = new Set(["missing", "ambiguous", "invalid", "unsafe", "agent-unavailable"]);
const RECOVERY_REASONS = new Set([
  "legacy-unresolved",
  "missing",
  "unsafe",
  "unreadable",
  "invalid",
  "exact-open-rejected",
]);

function isMissingErr(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

function assertOwnedByCurrentUser(path: string, stat: Stats): void {
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid.call(process)) {
    throw new Error(`Refusing to use ${path}: owned by uid ${stat.uid}`);
  }
}

function verifyPrivateStoreDir(path: string, repairMode: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to use session store dir ${path}: it is a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to use session store dir ${path}: not a directory`);
  }
  assertOwnedByCurrentUser(path, stat);
  if ((stat.mode & 0o777) !== 0o700) {
    if (!repairMode) {
      throw new Error(`Refusing to use session store dir ${path}: permissions must be 0700`);
    }
    const descriptor = openSync(path, "r");
    try {
      fchmodSync(descriptor, 0o700);
    } finally {
      closeSync(descriptor);
    }
  }
}

function ensurePrivateStoreDir(path: string): void {
  try {
    verifyPrivateStoreDir(path, true);
    return;
  } catch (err) {
    if (!isMissingErr(err)) {
      throw err;
    }
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  verifyPrivateStoreDir(path, true);
}

function assertPrivateRegularFile(path: string): Stats {
  const details = lstatSync(path);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new Error(`Refusing to use session store file ${path}: not a regular file`);
  }
  assertOwnedByCurrentUser(path, details);
  if ((details.mode & 0o777) !== 0o600) {
    throw new Error(`Refusing to use session store file ${path}: permissions must be 0600`);
  }
  return details;
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid session store: ${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: Set<string>, description: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`Invalid session store: unexpected ${description} field "${key}"`);
    }
  }
}

function boundedString(
  value: unknown,
  description: string,
  maxLength: number = MAX_SESSION_STATE_STRING_LENGTH,
): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Invalid session store: ${description} must be a bounded non-empty string`);
  }
  return value;
}

function optionalRuntimeFields(value: Record<string, unknown>): {
  provider?: "pi";
  model?: string;
  thinking?: PiThinkingLevel;
} {
  const provider = value.provider;
  if (provider !== undefined && provider !== "pi") {
    throw new Error("Invalid session store: provider must be pi when present");
  }
  const model = value.model === undefined
    ? undefined
    : boundedString(value.model, "model");
  const thinking = value.thinking;
  if (thinking !== undefined && (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking))) {
    throw new Error("Invalid session store: unknown thinking level");
  }
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(thinking === undefined ? {} : { thinking: thinking as PiThinkingLevel }),
  };
}

function baseState(value: Record<string, unknown>, key: string): Omit<LegacySessionState, "sessionId"> {
  const chatId = boundedString(value.chatId, "chatId");
  if (chatId !== key) {
    throw new Error(`Invalid session store: record key "${key}" does not match chatId`);
  }
  const lastActivity = value.lastActivity;
  if (typeof lastActivity !== "number" || !Number.isSafeInteger(lastActivity) || lastActivity < 0) {
    throw new Error("Invalid session store: lastActivity must be a non-negative safe integer");
  }
  return {
    chatId,
    agentId: boundedString(value.agentId, "agentId"),
    ...optionalRuntimeFields(value),
    lastActivity,
  };
}

function normalizedAbsolutePath(value: unknown, description: string): string {
  const path = boundedString(value, description);
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new Error(`Invalid session store: ${description} must be a normalized absolute path`);
  }
  return path;
}

function parsePendingRecoveryNotice(value: unknown): PendingSessionRecoveryNotice {
  const notice = record(value, "pendingRecoveryNotice");
  assertExactKeys(
    notice,
    new Set(["failedSessionId", "replacementSessionId", "reason"]),
    "pendingRecoveryNotice",
  );
  const reason = boundedString(
    notice.reason,
    "pendingRecoveryNotice.reason",
    MAX_SESSION_RECOVERY_REASON_LENGTH,
  );
  if (!RECOVERY_REASONS.has(reason)) {
    throw new Error("Invalid session store: unknown pending recovery reason");
  }
  return {
    failedSessionId: boundedString(
      notice.failedSessionId,
      "pendingRecoveryNotice.failedSessionId",
      MAX_SESSION_ID_LENGTH,
    ),
    replacementSessionId: boundedString(
      notice.replacementSessionId,
      "pendingRecoveryNotice.replacementSessionId",
      MAX_SESSION_ID_LENGTH,
    ),
    reason: reason as PendingSessionRecoveryNotice["reason"],
  };
}

function parseSessionState(value: unknown, key: string): SessionState {
  const state = record(value, `session "${key}"`);
  if (state.bindingState === "bound") {
    assertExactKeys(state, BOUND_STATE_KEYS, "bound session");
    const sessionFile = normalizedAbsolutePath(state.sessionFile, "sessionFile");
    if (!sessionFile.endsWith(".jsonl")) {
      throw new Error("Invalid session store: sessionFile must end in .jsonl");
    }
    const parsed: BoundSessionState = {
      bindingState: "bound",
      sessionId: boundedString(state.sessionId, "sessionId", MAX_SESSION_ID_LENGTH),
      sessionFile,
      workspaceRealpath: normalizedAbsolutePath(state.workspaceRealpath, "workspaceRealpath"),
      ...baseState(state, key),
      ...(state.pendingRecoveryNotice === undefined
        ? {}
        : { pendingRecoveryNotice: parsePendingRecoveryNotice(state.pendingRecoveryNotice) }),
    };
    if (
      parsed.pendingRecoveryNotice
      && parsed.pendingRecoveryNotice.replacementSessionId !== parsed.sessionId
    ) {
      throw new Error("Invalid session store: pending recovery replacement ID must match sessionId");
    }
    return parsed;
  }
  if (state.bindingState === "legacy-unresolved") {
    assertExactKeys(state, UNRESOLVED_STATE_KEYS, "unresolved session");
    const legacyFailure = boundedString(state.legacyFailure, "legacyFailure");
    if (!LEGACY_FAILURES.has(legacyFailure)) {
      throw new Error("Invalid session store: unknown legacy cutover failure");
    }
    return {
      bindingState: "legacy-unresolved",
      failedSessionId: boundedString(state.failedSessionId, "failedSessionId", MAX_SESSION_ID_LENGTH),
      legacyFailure: legacyFailure as LegacyCutoverFailure,
      ...baseState(state, key),
    };
  }
  throw new Error(`Invalid session store: session "${key}" has no recognized bindingState`);
}

function parseCurrentStore(value: unknown): SessionStoreData {
  const file = record(value, "root");
  assertExactKeys(file, new Set(["version", "sessions"]), "root");
  if (file.version !== SESSION_STORE_VERSION) {
    throw new Error(`Invalid session store: unsupported version ${String(file.version)}`);
  }
  const sessions = record(file.sessions, "sessions");
  const result: SessionStoreData = {};
  for (const [key, state] of Object.entries(sessions)) {
    boundedString(key, "session map key");
    result[key] = parseSessionState(state, key);
  }
  return result;
}

function parseLegacyStore(value: unknown): LegacySessionStoreData {
  const file = record(value, "legacy root");
  const result: LegacySessionStoreData = {};
  for (const [key, rawState] of Object.entries(file)) {
    boundedString(key, "legacy session map key");
    const state = record(rawState, `legacy session "${key}"`);
    assertExactKeys(state, LEGACY_STATE_KEYS, "legacy session");
    result[key] = {
      sessionId: boundedString(state.sessionId, "legacy sessionId", MAX_SESSION_ID_LENGTH),
      ...baseState(state, key),
    };
  }
  return result;
}

function cloneState<T>(value: T): T {
  return structuredClone(value);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function serializeStore(data: SessionStoreData): string {
  const checked = parseCurrentStore({ version: SESSION_STORE_VERSION, sessions: data });
  return JSON.stringify({ version: SESSION_STORE_VERSION, sessions: checked }, null, 2);
}

function unresolvedLegacyState(
  legacy: LegacySessionState,
  legacyFailure: LegacyCutoverFailure,
): UnresolvedLegacySessionState {
  const { sessionId, ...base } = legacy;
  return {
    bindingState: "legacy-unresolved",
    failedSessionId: sessionId,
    legacyFailure,
    ...base,
  };
}

export class SessionStore {
  private data: SessionStoreData = {};
  private legacyData: LegacySessionStoreData | undefined;
  private legacySourceBytes: Buffer | undefined;
  private readonly path: string;

  constructor(path?: string) {
    this.path = path ?? defaultStorePath();
    this.load();
  }

  /** Load current state, or retain a validated legacy map until explicit cutover. */
  load(): void {
    try {
      const details = assertPrivateRegularFile(this.path);
      if (details.size > MAX_SESSION_STORE_BYTES) {
        throw new Error(`Invalid session store: exceeds ${MAX_SESSION_STORE_BYTES} bytes`);
      }
      verifyPrivateStoreDir(dirname(this.path), false);
      const raw = readFileSync(this.path);
      const text = raw.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(raw)) {
        throw new Error("Invalid session store: file is not valid UTF-8");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`Invalid session store JSON: ${(error as Error).message}`);
      }
      const root = record(parsed, "root");
      if (Object.hasOwn(root, "version") || Object.hasOwn(root, "sessions")) {
        this.data = parseCurrentStore(root);
        this.legacyData = undefined;
        this.legacySourceBytes = undefined;
      } else {
        this.data = {};
        this.legacyData = parseLegacyStore(root);
        this.legacySourceBytes = Buffer.from(raw);
      }
    } catch (error) {
      if (!isMissingErr(error)) throw error;
      this.data = {};
      this.legacyData = undefined;
      this.legacySourceBytes = undefined;
    }
  }

  private assertMigrated(): void {
    if (this.legacyData) {
      throw new Error("Legacy session store must be migrated before use");
    }
  }

  private writeData(data: SessionStoreData): void {
    const dir = dirname(this.path);
    ensurePrivateStoreDir(dir);
    try {
      assertPrivateRegularFile(this.path);
    } catch (error) {
      if (!isMissingErr(error)) throw error;
    }
    const tmpPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(tmpPath, "wx", 0o600);
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, serializeStore(data), "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      assertPrivateRegularFile(tmpPath);
      renameSync(tmpPath, this.path);
      fsyncDirectory(dir);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(tmpPath); } catch (cleanupError) {
        if (!isMissingErr(cleanupError)) {
          throw new AggregateError([error, cleanupError], "Session store write and cleanup failed");
        }
      }
      throw error;
    }
  }

  /** Persist the already-validated current store atomically. */
  save(): void {
    this.assertMigrated();
    this.writeData(this.data);
  }

  getSession(chatId: string): SessionState | undefined {
    this.assertMigrated();
    const state = this.data[chatId];
    return state === undefined ? undefined : cloneState(state);
  }

  setSession(chatId: string, state: SessionState): void {
    this.assertMigrated();
    const parsed = parseSessionState(state, chatId);
    const next = { ...this.data, [chatId]: parsed };
    this.writeData(next);
    this.data = next;
  }

  deleteSession(chatId: string): void {
    this.assertMigrated();
    if (!(chatId in this.data)) return;
    const next = { ...this.data };
    delete next[chatId];
    this.writeData(next);
    this.data = next;
  }

  getAllSessions(): SessionStoreData {
    this.assertMigrated();
    return cloneState(this.data);
  }

  /** Atomically replace one exact snapshot; stale owners receive false. */
  compareAndSetSession(
    chatId: string,
    expected: SessionState | undefined,
    replacement: SessionState | undefined,
  ): boolean {
    this.assertMigrated();
    const current = this.data[chatId];
    if (!isDeepStrictEqual(current, expected)) return false;
    const next = { ...this.data };
    if (replacement === undefined) {
      delete next[chatId];
    } else {
      next[chatId] = parseSessionState(replacement, chatId);
    }
    this.writeData(next);
    this.data = next;
    return true;
  }

  /** Clear only the exact notice a transport confirms it delivered. */
  acknowledgeRecoveryNotice(
    chatId: string,
    expected: PendingSessionRecoveryNotice,
  ): boolean {
    this.assertMigrated();
    const current = this.data[chatId];
    if (
      current?.bindingState !== "bound"
      || !isDeepStrictEqual(current.pendingRecoveryNotice, expected)
    ) {
      return false;
    }
    const { pendingRecoveryNotice: _acknowledged, ...replacement } = current;
    return this.compareAndSetSession(chatId, current, replacement);
  }

  private ensureLegacyBackup(source: Buffer): void {
    const backupPath = this.path + LEGACY_SESSION_BACKUP_SUFFIX;
    try {
      assertPrivateRegularFile(backupPath);
      const existing = readFileSync(backupPath);
      if (!existing.equals(source)) {
        throw new Error(`Refusing to replace non-matching legacy session backup ${backupPath}`);
      }
      return;
    } catch (error) {
      if (!isMissingErr(error)) throw error;
    }

    let descriptor: number | undefined;
    try {
      descriptor = openSync(backupPath, "wx", 0o600);
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, source);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      assertPrivateRegularFile(backupPath);
      fsyncDirectory(dirname(backupPath));
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(backupPath); } catch (cleanupError) {
        if (!isMissingErr(cleanupError)) {
          throw new AggregateError([error, cleanupError], "Legacy backup and cleanup failed");
        }
      }
      throw error;
    }
  }

  /**
   * Convert one complete legacy ID-only map using only each configured agent's
   * canonical local Pi directory. The source file is unchanged unless backup,
   * candidate inspection, new-format validation, and atomic replacement all
   * succeed.
   */
  migrateLegacySessions(config: BotConfig, options: LegacySessionMigrationOptions = {}): boolean {
    if (!this.legacyData || !this.legacySourceBytes) return false;
    const migrated: SessionStoreData = {};
    type AgentEvidence =
      | {
        bindingsById: Map<string, InteractiveSessionBinding[]>;
        invalidEntries: Array<{
          name: string;
          observedSessionId?: string;
          failure: LegacyCutoverFailure;
        }>;
      }
      | { failure: "unsafe" };
    const evidenceByAgent = new Map<string, AgentEvidence>();

    const inspectAgentEvidence = (agentId: string): AgentEvidence => {
      const cached = evidenceByAgent.get(agentId);
      if (cached) return cached;
      const agent = config.agents[agentId];
      if (!agent) return { failure: "unsafe" };
      try {
        const location = resolveInteractiveSessionLocation(agent, options);
        const candidates = listInteractiveSessionEvidence(
          location,
          options.maxCandidates,
          options,
        );
        const evidence: Exclude<AgentEvidence, { failure: "unsafe" }> = {
          bindingsById: new Map(),
          invalidEntries: [],
        };
        for (const candidate of candidates) {
          const inspection = inspectLegacyInteractiveSessionCandidate(location, candidate, options);
          if (inspection.valid) {
            const matches = evidence.bindingsById.get(inspection.binding.sessionId) ?? [];
            matches.push(inspection.binding);
            evidence.bindingsById.set(inspection.binding.sessionId, matches);
          } else {
            evidence.invalidEntries.push({
              name: basename(candidate),
              ...(inspection.observedSessionId === undefined
                ? {}
                : { observedSessionId: inspection.observedSessionId }),
              failure: inspection.reason === "invalid" ? "invalid" : "unsafe",
            });
          }
        }
        evidenceByAgent.set(agentId, evidence);
        return evidence;
      } catch {
        const failure = { failure: "unsafe" } as const;
        evidenceByAgent.set(agentId, failure);
        return failure;
      }
    };

    for (const [chatId, legacy] of Object.entries(this.legacyData)) {
      const agent = config.agents[legacy.agentId];
      if (!agent) {
        migrated[chatId] = unresolvedLegacyState(legacy, "agent-unavailable");
        continue;
      }

      const evidence = inspectAgentEvidence(legacy.agentId);
      if ("failure" in evidence) {
        migrated[chatId] = unresolvedLegacyState(legacy, "unsafe");
        continue;
      }
      const matches = evidence.bindingsById.get(legacy.sessionId) ?? [];
      const conflictingEvidence = evidence.invalidEntries.find(
        (entry) =>
          entry.observedSessionId === legacy.sessionId
          || entry.name.includes(legacy.sessionId),
      )?.failure;
      if (matches.length === 1 && !conflictingEvidence) {
        const { sessionDirectory: _sessionDirectory, ...durableBinding } = matches[0];
        migrated[chatId] = {
          bindingState: "bound",
          ...durableBinding,
          chatId: legacy.chatId,
          agentId: legacy.agentId,
          ...(legacy.provider === undefined ? {} : { provider: legacy.provider }),
          ...(legacy.model === undefined ? {} : { model: legacy.model }),
          ...(legacy.thinking === undefined ? {} : { thinking: legacy.thinking }),
          lastActivity: legacy.lastActivity,
        };
      } else if (matches.length > 1) {
        migrated[chatId] = unresolvedLegacyState(legacy, "ambiguous");
      } else if (conflictingEvidence) {
        migrated[chatId] = unresolvedLegacyState(legacy, conflictingEvidence);
      } else {
        migrated[chatId] = unresolvedLegacyState(legacy, "missing");
      }
    }

    // Validate the complete target before creating either backup or replacement.
    serializeStore(migrated);
    assertPrivateRegularFile(this.path);
    verifyPrivateStoreDir(dirname(this.path), false);
    const currentSource = readFileSync(this.path);
    if (!currentSource.equals(this.legacySourceBytes)) {
      throw new Error("Legacy session store changed during migration");
    }
    this.ensureLegacyBackup(this.legacySourceBytes);
    this.writeData(migrated);
    this.data = migrated;
    this.legacyData = undefined;
    this.legacySourceBytes = undefined;
    return true;
  }

  /** For testing: return count of stored sessions */
  get size(): number {
    this.assertMigrated();
    return Object.keys(this.data).length;
  }
}
