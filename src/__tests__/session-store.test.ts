import { createHash } from "node:crypto";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";
import {
  LEGACY_SESSION_BACKUP_SUFFIX,
  SESSION_STORE_VERSION,
  SessionStore,
} from "../session-store.js";
import type { BotConfig, BoundSessionState } from "../types.js";
import { resolveWorkspaceContract } from "../workspace-contract.js";

const TEST_DIR = "/tmp/minime-test-store";
const TEST_PATH = `${TEST_DIR}/sessions.json`;
const WORKSPACE = `${TEST_DIR}/workspace`;
const SESSION_DIR = `${TEST_DIR}/pi-sessions`;
const OUTSIDE_DIR = `${TEST_DIR}/outside-sessions`;

function cleanup() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  if (existsSync(`${TEST_DIR}-target`)) {
    rmSync(`${TEST_DIR}-target`, { recursive: true });
  }
}

function makeConfig(workspaceCwd = WORKSPACE): BotConfig {
  return {
    whisperModelPath: "/tmp/minime-test-whisper-model.bin",
    agents: {
      main: { id: "main", workspaceCwd, model: "gpt-5.5" },
    },
    bindings: [],
    sessionDefaults: {
      idleTimeoutMs: 60_000,
      maxConcurrentSessions: 2,
      maxMessageAgeMs: 300_000,
      requireMention: false,
      maxMediaBytes: 10_000_000,
    },
  };
}

function boundState(
  chatId = "123",
  sessionId = "session-1",
  overrides: Partial<BoundSessionState> = {},
): BoundSessionState {
  return {
    bindingState: "bound",
    sessionId,
    sessionFile: join(SESSION_DIR, `${sessionId}.jsonl`),
    workspaceRealpath: WORKSPACE,
    chatId,
    agentId: "main",
    provider: "pi",
    model: "openai-codex/gpt-5.5",
    thinking: "high",
    lastActivity: 1_000,
    ...overrides,
  };
}

function legacyState(chatId: string, sessionId: string, agentId = "main") {
  return {
    sessionId,
    chatId,
    agentId,
    provider: "pi",
    model: "openai-codex/gpt-5.5",
    thinking: "high",
    lastActivity: 1_000,
  };
}

function writeLegacy(
  data: Record<string, ReturnType<typeof legacyState>>,
  raw = JSON.stringify(data, null, 2),
): Buffer {
  const bytes = Buffer.from(raw, "utf8");
  writeFileSync(TEST_PATH, bytes, { mode: 0o600 });
  chmodSync(TEST_PATH, 0o600);
  return bytes;
}

function writeTranscript(
  directory: string,
  filename: string,
  sessionId: string,
  cwd = realpathSync(WORKSPACE),
  suffix = "",
): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, filename);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp: "2026-08-02T00:00:00.000Z",
    cwd,
  };
  writeFileSync(path, `${JSON.stringify(header)}\n${suffix}`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function migrationOptions(extra: Record<string, unknown> = {}) {
  return {
    sessionDirectory: SESSION_DIR,
    env: {},
    homeDirectory: TEST_DIR,
    ...extra,
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("SessionStore", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
    chmodSync(TEST_DIR, 0o700);
    mkdirSync(WORKSPACE, { recursive: true, mode: 0o700 });
    mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    chmodSync(WORKSPACE, 0o700);
    chmodSync(SESSION_DIR, 0o700);
  });

  afterEach(() => {
    cleanup();
  });

  it("creates an empty current store when the file does not exist", () => {
    const store = new SessionStore(TEST_PATH);
    assert.strictEqual(store.size, 0);
    assert.deepStrictEqual(store.getAllSessions(), {});
  });

  it("strictly persists, reloads, and deletes canonical state", () => {
    const store = new SessionStore(TEST_PATH);
    const state = boundState();
    store.setSession("123", state);

    assert.deepStrictEqual(store.getSession("123"), state);
    const raw = JSON.parse(readFileSync(TEST_PATH, "utf8"));
    assert.strictEqual(raw.version, SESSION_STORE_VERSION);
    assert.strictEqual(raw.sessions["123"].sessionId, "session-1");
    assert.strictEqual(statSync(TEST_DIR).mode & 0o777, 0o700);
    assert.strictEqual(statSync(TEST_PATH).mode & 0o777, 0o600);

    const reloaded = new SessionStore(TEST_PATH);
    assert.deepStrictEqual(reloaded.getSession("123"), state);
    reloaded.deleteSession("123");
    assert.strictEqual(reloaded.getSession("123"), undefined);
    assert.strictEqual(new SessionStore(TEST_PATH).size, 0);
  });

  it("returns detached state snapshots", () => {
    const store = new SessionStore(TEST_PATH);
    store.setSession("123", boundState());
    const one = store.getSession("123") as BoundSessionState;
    one.sessionId = "mutated";
    const all = store.getAllSessions();
    delete all["123"];
    assert.strictEqual((store.getSession("123") as BoundSessionState).sessionId, "session-1");
  });

  it("rejects malformed, unsafe, and corrupted current input instead of becoming empty", () => {
    const store = new SessionStore(TEST_PATH);
    assert.throws(
      () => store.setSession("123", { ...boundState(), sessionFile: "relative.jsonl" }),
      /normalized absolute path/,
    );
    assert.throws(
      () => store.setSession(
        "123",
        { ...boundState(), unexpected: true } as unknown as BoundSessionState,
      ),
      /unexpected bound session field/,
    );
    assert.strictEqual(store.size, 0);

    writeFileSync(TEST_PATH, "not valid json{{{", { mode: 0o600 });
    chmodSync(TEST_PATH, 0o600);
    assert.throws(() => new SessionStore(TEST_PATH), /Invalid session store JSON/);
    assert.strictEqual(readFileSync(TEST_PATH, "utf8"), "not valid json{{{");
  });

  it("rejects unsafe store files and directories", () => {
    const current = JSON.stringify({ version: SESSION_STORE_VERSION, sessions: {} });
    writeFileSync(TEST_PATH, current, { mode: 0o644 });
    chmodSync(TEST_PATH, 0o644);
    assert.throws(() => new SessionStore(TEST_PATH), /permissions must be 0600/);

    rmSync(TEST_PATH);
    const targetFile = `${TEST_DIR}/target.json`;
    writeFileSync(targetFile, current, { mode: 0o600 });
    symlinkSync(targetFile, TEST_PATH);
    assert.throws(() => new SessionStore(TEST_PATH), /not a regular file/);
  });

  it("refuses to write through a symlinked store directory", () => {
    rmSync(TEST_DIR, { recursive: true });
    const target = `${TEST_DIR}-target`;
    mkdirSync(target, { recursive: true, mode: 0o700 });
    symlinkSync(target, TEST_DIR, "dir");

    const store = new SessionStore(TEST_PATH);
    assert.throws(() => store.setSession("123", boundState()), /symlink/);
    assert.ok(!existsSync(`${target}/sessions.json`));
  });

  it("creates private nested parent directories and leaves no temporary file", () => {
    const deepPath = `${TEST_DIR}/deep/nested/sessions.json`;
    const store = new SessionStore(deepPath);
    store.setSession("123", boundState());
    assert.ok(existsSync(deepPath));
    assert.deepStrictEqual(
      readdirSync(`${TEST_DIR}/deep/nested`).filter((name) => name.includes(".tmp-")),
      [],
    );
  });

  it("default path resolves through the workspace contract", () => {
    const store = new SessionStore();
    const expectedPath = resolveWorkspaceContract().paths.sessionStorePath;
    assert.strictEqual((store as unknown as { path: string }).path, expectedPath);
    assert.ok(expectedPath.endsWith("/data/sessions.json"));
  });
});

describe("SessionStore legacy cutover", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
    chmodSync(TEST_DIR, 0o700);
    mkdirSync(WORKSPACE, { recursive: true, mode: 0o700 });
    mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
    chmodSync(WORKSPACE, 0o700);
    chmodSync(SESSION_DIR, 0o700);
  });

  afterEach(() => {
    cleanup();
  });

  it("migrates one exact ID+CWD match and preserves source bytes in one private backup", () => {
    const sessionId = "unique-session";
    const transcript = writeTranscript(
      SESSION_DIR,
      `2026-08-02_${sessionId}.jsonl`,
      sessionId,
      realpathSync(WORKSPACE),
      `${JSON.stringify({ type: "message", id: "entry-1", role: "user" })}\n`,
    );
    const beforeHash = sha256(transcript);
    const beforeBytes = readFileSync(transcript);
    const beforeNames = readdirSync(SESSION_DIR);
    const legacyBytes = writeLegacy(
      { chat: legacyState("chat", sessionId) },
      `{\n  "chat": ${JSON.stringify(legacyState("chat", sessionId))}\n}\n`,
    );

    const store = new SessionStore(TEST_PATH);
    assert.throws(() => store.getSession("chat"), /must be migrated/);
    assert.strictEqual(store.migrateLegacySessions(makeConfig(), migrationOptions()), true);

    const { sessionId: _legacySessionId, ...legacyMetadata } = legacyState("chat", sessionId);
    assert.deepStrictEqual(store.getSession("chat"), {
      bindingState: "bound",
      sessionId,
      sessionFile: realpathSync(transcript),
      workspaceRealpath: realpathSync(WORKSPACE),
      ...legacyMetadata,
    });
    const backup = TEST_PATH + LEGACY_SESSION_BACKUP_SUFFIX;
    assert.deepStrictEqual(readFileSync(backup), legacyBytes);
    assert.strictEqual(lstatSync(backup).mode & 0o777, 0o600);
    assert.strictEqual(sha256(transcript), beforeHash);
    assert.deepStrictEqual(readFileSync(transcript), beforeBytes);
    assert.deepStrictEqual(readdirSync(SESSION_DIR), beforeNames);
  });

  it("turns missing, duplicate, malformed, cross-workspace, unsafe, and orphan evidence into explicit unresolved states", () => {
    const duplicateId = "duplicate-session";
    writeTranscript(SESSION_DIR, `first_${duplicateId}.jsonl`, duplicateId);
    writeTranscript(SESSION_DIR, `second_${duplicateId}.jsonl`, duplicateId);
    const malformedId = "malformed-session";
    writeFileSync(join(SESSION_DIR, `bad_${malformedId}.jsonl`), "not-json\n", { mode: 0o600 });
    const crossId = "cross-session";
    writeTranscript(SESSION_DIR, `cross_${crossId}.jsonl`, crossId, `${TEST_DIR}/other-workspace`);
    const symlinkId = "symlink-session";
    mkdirSync(OUTSIDE_DIR, { recursive: true, mode: 0o700 });
    chmodSync(OUTSIDE_DIR, 0o700);
    const symlinkTarget = writeTranscript(OUTSIDE_DIR, `target_${symlinkId}.jsonl`, symlinkId);
    const symlinkTargetHash = sha256(symlinkTarget);
    symlinkSync(symlinkTarget, join(SESSION_DIR, `unsafe_${symlinkId}.jsonl`));
    const modeId = "mode-conflict";
    const modeConflict = writeTranscript(SESSION_DIR, `unsafe_${modeId}.jsonl`, modeId);
    chmodSync(modeConflict, 0o640);
    const legacy = {
      missing: legacyState("missing", "missing-session"),
      duplicate: legacyState("duplicate", duplicateId),
      malformed: legacyState("malformed", malformedId),
      cross: legacyState("cross", crossId),
      symlink: legacyState("symlink", symlinkId),
      mode: legacyState("mode", modeId),
      orphan: legacyState("orphan", "orphan-session", "deleted-agent"),
    };
    writeLegacy(legacy);

    const store = new SessionStore(TEST_PATH);
    store.migrateLegacySessions(makeConfig(), migrationOptions());
    assert.deepStrictEqual(
      Object.fromEntries(Object.entries(store.getAllSessions()).map(([key, state]) => [
        key,
        state.bindingState === "legacy-unresolved" ? state.legacyFailure : "bound",
      ])),
      {
        missing: "missing",
        duplicate: "ambiguous",
        malformed: "invalid",
        cross: "invalid",
        symlink: "unsafe",
        mode: "unsafe",
        orphan: "agent-unavailable",
      },
    );
    for (const [chatId, state] of Object.entries(store.getAllSessions())) {
      assert.strictEqual(state.bindingState, "legacy-unresolved", chatId);
      assert.strictEqual(state.sessionId, undefined, `${chatId} has no replacement runtime identity`);
      assert.strictEqual(
        state.failedSessionId,
        legacy[chatId as keyof typeof legacy].sessionId,
        `${chatId} retains the exact failed old ID`,
      );
    }
    assert.strictEqual(sha256(symlinkTarget), symlinkTargetHash, "unsafe evidence target was unchanged");

    const unsafeId = "ownership-conflict";
    rmSync(TEST_PATH + LEGACY_SESSION_BACKUP_SUFFIX);
    writeLegacy({ unsafe: legacyState("unsafe", unsafeId) });
    const unsafeStore = new SessionStore(TEST_PATH);
    unsafeStore.migrateLegacySessions(
      makeConfig(),
      migrationOptions({ expectedUid: (typeof process.getuid === "function" ? process.getuid() : 0) + 1 }),
    );
    const unsafe = unsafeStore.getSession("unsafe");
    assert.strictEqual(unsafe?.bindingState, "legacy-unresolved");
    assert.strictEqual(unsafe?.legacyFailure, "unsafe");
  });

  it("is idempotent after cutover and never inspects a decoy outside the configured directory", () => {
    const sessionId = "outside-only";
    mkdirSync(OUTSIDE_DIR, { recursive: true, mode: 0o700 });
    chmodSync(OUTSIDE_DIR, 0o700);
    const decoy = writeTranscript(OUTSIDE_DIR, `decoy_${sessionId}.jsonl`, sessionId);
    const decoyHash = sha256(decoy);
    writeLegacy({ chat: legacyState("chat", sessionId) });

    const first = new SessionStore(TEST_PATH);
    assert.strictEqual(first.migrateLegacySessions(makeConfig(), migrationOptions()), true);
    const state = first.getSession("chat");
    assert.strictEqual(state?.bindingState, "legacy-unresolved");
    assert.strictEqual(state?.legacyFailure, "missing");
    const storeAfterFirst = readFileSync(TEST_PATH);
    const backupAfterFirst = readFileSync(TEST_PATH + LEGACY_SESSION_BACKUP_SUFFIX);

    const restarted = new SessionStore(TEST_PATH);
    assert.strictEqual(restarted.migrateLegacySessions(makeConfig(), migrationOptions()), false);
    assert.deepStrictEqual(readFileSync(TEST_PATH), storeAfterFirst);
    assert.deepStrictEqual(readFileSync(TEST_PATH + LEGACY_SESSION_BACKUP_SUFFIX), backupAfterFirst);
    assert.strictEqual(sha256(decoy), decoyHash);
  });

  it("rejects malformed legacy input without backup or rewrite", () => {
    const source = Buffer.from('{"chat":{"sessionId":"x"}}\n');
    writeFileSync(TEST_PATH, source, { mode: 0o600 });
    chmodSync(TEST_PATH, 0o600);
    assert.throws(() => new SessionStore(TEST_PATH), /chatId must be a bounded non-empty string/);
    assert.deepStrictEqual(readFileSync(TEST_PATH), source);
    assert.ok(!existsSync(TEST_PATH + LEGACY_SESSION_BACKUP_SUFFIX));
  });

  it("leaves the legacy source unchanged when backup validation or replacement writing fails", () => {
    const source = writeLegacy({ chat: legacyState("chat", "no-match") });
    const backupPath = TEST_PATH + LEGACY_SESSION_BACKUP_SUFFIX;
    writeFileSync(backupPath, "different source", { mode: 0o600 });
    chmodSync(backupPath, 0o600);
    const backupFailure = new SessionStore(TEST_PATH);
    assert.throws(
      () => backupFailure.migrateLegacySessions(makeConfig(), migrationOptions()),
      /non-matching legacy session backup/,
    );
    assert.deepStrictEqual(readFileSync(TEST_PATH), source);

    rmSync(backupPath);
    const writeFailure = new SessionStore(TEST_PATH);
    (writeFailure as unknown as { writeData: () => void }).writeData = () => {
      throw new Error("injected replacement failure");
    };
    assert.throws(
      () => writeFailure.migrateLegacySessions(makeConfig(), migrationOptions()),
      /injected replacement failure/,
    );
    assert.deepStrictEqual(readFileSync(TEST_PATH), source);
    assert.deepStrictEqual(readFileSync(backupPath), source);
  });
});

describe("SessionStore atomic state transitions", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
    chmodSync(TEST_DIR, 0o700);
  });

  afterEach(() => {
    cleanup();
  });

  it("rejects stale compare-and-set replacements and acknowledges only the exact durable notice", () => {
    const store = new SessionStore(TEST_PATH);
    const initial = boundState();
    store.setSession("123", initial);
    const notice = {
      failedSessionId: "failed-session",
      replacementSessionId: "replacement-session",
      reason: "missing" as const,
    };
    const withNotice = boundState("123", "replacement-session", {
      pendingRecoveryNotice: notice,
    });

    assert.strictEqual(store.compareAndSetSession("123", initial, withNotice), true);
    assert.strictEqual(store.compareAndSetSession("123", initial, boundState("123", "stale")), false);
    assert.strictEqual(
      store.acknowledgeRecoveryNotice("123", { ...notice, replacementSessionId: "wrong" }),
      false,
    );
    assert.deepStrictEqual(
      (store.getSession("123") as BoundSessionState).pendingRecoveryNotice,
      notice,
    );
    assert.strictEqual(store.acknowledgeRecoveryNotice("123", notice), true);
    assert.strictEqual(
      (new SessionStore(TEST_PATH).getSession("123") as BoundSessionState).pendingRecoveryNotice,
      undefined,
    );
    assert.strictEqual(store.acknowledgeRecoveryNotice("123", notice), false);
  });

  it("bounds recovery notice fields and ties the replacement ID to the binding", () => {
    const store = new SessionStore(TEST_PATH);
    assert.throws(
      () => store.setSession("123", boundState("123", "replacement", {
        pendingRecoveryNotice: {
          failedSessionId: "x".repeat(257),
          replacementSessionId: "replacement",
          reason: "invalid",
        },
      })),
      /bounded non-empty string/,
    );
    assert.throws(
      () => store.setSession("123", boundState("123", "replacement", {
        pendingRecoveryNotice: {
          failedSessionId: "failed",
          replacementSessionId: "different",
          reason: "invalid",
        },
      })),
      /replacement ID must match sessionId/,
    );
    assert.strictEqual(store.size, 0);
  });
});
