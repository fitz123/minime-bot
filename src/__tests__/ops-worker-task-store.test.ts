import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  OPS_WORKER_LIMITS,
  OpsWorkerTaskValidationError,
  parseOpsWorkerTask,
  parseOpsWorkerTaskJson,
  type JsonObject,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "../ops-worker/types.js";
import {
  OpsWorkerDuplicateCorrelationError,
  OpsWorkerTaskStore,
  OpsWorkerTaskStoreSafetyError,
  type OpsWorkerTaskStoreFaultPoint,
} from "../ops-worker/task-store.js";

const NOW = "2026-07-17T12:00:00.000Z";
const LATER = "2026-07-17T12:01:00.000Z";

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  const object = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(object).sort(), [...expectedKeys].sort());
  return object;
}

const registry: OpsWorkerTaskContractRegistry = {
  templates: {
    "operator-health": { sourceKinds: ["operator-cli"] },
    "issue-full-cycle": { sourceKinds: ["authorized-issue"] },
  },
  authorizationProfiles: {
    "operator.inspect.v1": {
      sourceKinds: ["operator-cli"],
      scope: ["inspect"],
    },
    "issue.full-cycle.v1": {
      sourceKinds: ["authorized-issue"],
      scope: ["repository-read", "repository-write", "pull-request", "issue-lifecycle"],
    },
  },
  doneChecks: {
    "fixture-health": {
      validateParams(value: unknown): JsonObject {
        const params = exactObject(value, ["sampleCount"]);
        assert.ok(Number.isSafeInteger(params.sampleCount));
        assert.ok((params.sampleCount as number) >= 1 && (params.sampleCount as number) <= 10);
        return { sampleCount: params.sampleCount as number };
      },
    },
    "lax-fixture": {
      validateParams(value: unknown): JsonObject {
        assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
        return value as JsonObject;
      },
    },
  },
};

function makeTask(
  id = "wt-20260717-ab12cd",
  correlationKey = "operator:health:local",
): OpsWorkerTask {
  return {
    schemaVersion: 1,
    id,
    source: {
      kind: "operator-cli",
      correlationKey,
      template: "operator-health",
    },
    priority: 10,
    objective: "Verify the registered local health contract",
    evidence: [
      {
        at: NOW,
        kind: "operator",
        trust: "trusted",
        summary: "Operator requested the registered inspection template.",
        artifact: null,
      },
    ],
    doneCheck: {
      name: "fixture-health",
      params: { sampleCount: 3 },
    },
    authorization: {
      profile: "operator.inspect.v1",
      scope: ["inspect"],
      snapshotHash: null,
    },
    state: "QUEUED",
    rounds: {
      remediation: 0,
      maxRemediation: 5,
      consecutiveInfrastructureFailures: 0,
    },
    schedule: {
      nextRunAt: null,
      nextCheckAt: null,
    },
    session: {
      directory: `sessions/${id}`,
      sessionId: null,
      resume: false,
    },
    activeRun: null,
    lastOutcome: null,
    report: {
      state: "NONE",
      attempts: 0,
      lastError: null,
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function testStateDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "minime-ops-worker-store-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function makeStore(
  t: TestContext,
  options: {
    directory?: string;
    maxJournalBytes?: number;
    faultInjector?: (point: OpsWorkerTaskStoreFaultPoint) => void;
  } = {},
): OpsWorkerTaskStore {
  return new OpsWorkerTaskStore(options.directory ?? testStateDirectory(t), {
    registry,
    now: () => new Date(NOW),
    maxJournalBytes: options.maxJournalBytes,
    faultInjector: options.faultInjector,
  });
}

describe("ops worker task contract", () => {
  it("parses a complete schema-versioned envelope into an independent value", () => {
    const input = makeTask();
    input.state = "RUNNING";
    input.activeRun = {
      attemptId: "attempt-01",
      supervisorInstanceId: "supervisor-01",
      pid: 321,
      processGroupId: 321,
      processStartedAt: NOW,
      processStartToken: "darwin-start-123.45",
    };
    input.session.sessionId = "pi-session-01";
    input.session.resume = true;
    input.lastOutcome = {
      at: NOW,
      kind: "INFRASTRUCTURE",
      result: "NETWORK",
      summary: "Previous attempt stopped after a resumable network error.",
    };
    input.report = {
      state: "PENDING",
      attempts: 1,
      lastError: "Fixture transport unavailable.",
    };

    const parsed = parseOpsWorkerTask(input, registry);
    assert.deepEqual(parsed, input);
    assert.notStrictEqual(parsed, input);
    assert.notStrictEqual(parsed.source, input.source);
    input.objective = "changed after validation";
    assert.equal(parsed.objective, "Verify the registered local health contract");
  });

  it("supports the deferred issue source without letting it change fixed priority or scope", () => {
    const task = makeTask("wt-20260717-issue58", "issue:example-org/minime-bot:58");
    task.source = {
      kind: "authorized-issue",
      correlationKey: "issue:example-org/minime-bot:58",
      template: "issue-full-cycle",
    };
    task.priority = 30;
    task.authorization = {
      profile: "issue.full-cycle.v1",
      scope: ["repository-read", "repository-write", "pull-request", "issue-lifecycle"],
      snapshotHash: `sha256:${"a".repeat(64)}`,
    };

    const parsed = parseOpsWorkerTask(task, registry);
    assert.equal(parsed.priority, 30);
    assert.equal(parsed.authorization.snapshotHash, `sha256:${"a".repeat(64)}`);

    const wrongPriority = clone(task) as unknown as Record<string, unknown>;
    wrongPriority.priority = 0;
    assert.throws(
      () => parseOpsWorkerTask(wrongPriority, registry),
      /fixed priority 30/,
    );

    const elevatedScope = clone(task);
    elevatedScope.authorization.scope.push("deploy");
    assert.throws(
      () => parseOpsWorkerTask(elevatedScope, registry),
      /exactly match the registered authorization profile/,
    );
  });

  it("rejects unknown fields, arbitrary profiles, and unregistered names", () => {
    const withCommand = { ...makeTask(), command: "dangerous command" };
    assert.throws(
      () => parseOpsWorkerTask(withCommand, registry),
      /task\.command: unknown field/,
    );

    const arbitraryProfile = clone(makeTask());
    arbitraryProfile.authorization.profile = "operator.unrestricted.v1";
    assert.throws(
      () => parseOpsWorkerTask(arbitraryProfile, registry),
      /unregistered authorization profile/,
    );

    const unknownTemplate = clone(makeTask());
    unknownTemplate.source.template = "payload-template";
    assert.throws(
      () => parseOpsWorkerTask(unknownTemplate, registry),
      /unregistered template/,
    );

    const unknownCheck = clone(makeTask());
    unknownCheck.doneCheck.name = "payload-check";
    assert.throws(
      () => parseOpsWorkerTask(unknownCheck, registry),
      /unregistered done check/,
    );
  });

  it("rejects command, executable, and URL selectors even after a lax check validator", () => {
    for (const params of [
      { command: "restart service" },
      { nested: { executable: "/bin/tool" } },
      { url: "https://example.invalid/health" },
    ] as JsonObject[]) {
      const task = clone(makeTask());
      task.doneCheck = { name: "lax-fixture", params };
      assert.throws(
        () => parseOpsWorkerTask(task, registry),
        /cannot select commands, executables, URLs, or authorization/,
      );
    }
  });

  it("bounds evidence, JSON parameters, paths, timestamps, and whole snapshots", () => {
    const oversizedEvidence = clone(makeTask());
    oversizedEvidence.evidence[0].summary = "x".repeat(
      OPS_WORKER_LIMITS.maxEvidenceSummaryBytes + 1,
    );
    assert.throws(
      () => parseOpsWorkerTask(oversizedEvidence, registry),
      /must be at most 4096 UTF-8 bytes/,
    );

    const traversal = clone(makeTask());
    traversal.evidence[0].artifact = "artifacts/../outside";
    assert.throws(
      () => parseOpsWorkerTask(traversal, registry),
      /contain no traversal segments/,
    );

    const outsideSession = clone(makeTask());
    outsideSession.session.directory = "/tmp/session";
    assert.throws(
      () => parseOpsWorkerTask(outsideSession, registry),
      /must be the task-owned path/,
    );

    const invalidDate = clone(makeTask()) as unknown as Record<string, unknown>;
    invalidDate.updatedAt = "2026-02-30T12:00:00Z";
    assert.throws(
      () => parseOpsWorkerTask(invalidDate, registry),
      OpsWorkerTaskValidationError,
    );

    assert.throws(
      () => parseOpsWorkerTaskJson(
        `{"padding":"${"x".repeat(OPS_WORKER_LIMITS.maxSnapshotBytes)}"}`,
        registry,
      ),
      /snapshot exceeds/,
    );
  });

  it("requires process-group proof only for RUNNING tasks", () => {
    const missingIdentity = clone(makeTask());
    missingIdentity.state = "RUNNING";
    assert.throws(
      () => parseOpsWorkerTask(missingIdentity, registry),
      /must identify the owned process group/,
    );

    const unexpectedIdentity = clone(makeTask());
    unexpectedIdentity.activeRun = {
      attemptId: "attempt-1",
      supervisorInstanceId: "supervisor-1",
      pid: 123,
      processGroupId: 123,
      processStartedAt: NOW,
      processStartToken: "start-1",
    };
    assert.throws(
      () => parseOpsWorkerTask(unexpectedIdentity, registry),
      /must be null unless state is RUNNING/,
    );
  });
});

describe("ops worker durable task store", () => {
  it("writes a private authoritative snapshot before its bounded audit record", (t) => {
    const store = makeStore(t);
    const result = store.create(makeTask(), {
      event: "CREATED",
      summary: "Registered operator task accepted.",
    });

    assert.equal(result.journalAppended, true);
    assert.equal(lstatSync(store.stateDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(store.tasksDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(result.snapshotPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(store.journalPath).mode & 0o777, 0o600);
    assert.deepEqual(store.get(makeTask().id), makeTask());

    const entries = readFileSync(store.journalPath, "utf8").trim().split("\n");
    assert.equal(entries.length, 1);
    const entry = JSON.parse(entries[0]) as Record<string, unknown>;
    assert.equal(entry.taskId, makeTask().id);
    assert.equal(entry.state, "QUEUED");
    assert.equal(entry.event, "CREATED");
  });

  it("atomically replaces a snapshot and leaves no temp file on success", (t) => {
    const store = makeStore(t);
    const original = makeTask();
    store.create(original);
    const replacement = clone(original);
    replacement.updatedAt = LATER;
    replacement.evidence.push({
      at: LATER,
      kind: "system",
      trust: "trusted",
      summary: "A second bounded observation was persisted.",
      artifact: "artifacts/observation.json",
    });

    store.replace(replacement, { event: "EVIDENCE" });

    assert.deepEqual(store.get(original.id), replacement);
    assert.deepEqual(
      readdirSync(store.tasksDirectory).filter((name) => name.endsWith(".tmp")),
      [],
    );
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(store.tasksDirectory, `${original.id}.json`), "utf8")));
  });

  it("recovers the old snapshot when a crash occurs after temp-file fsync", (t) => {
    const directory = testStateDirectory(t);
    const initial = makeStore(t, { directory });
    const original = makeTask();
    initial.create(original);
    const replacement = clone(original);
    replacement.updatedAt = LATER;
    replacement.objective = "Replacement that must not become visible before rename";
    let armed = true;
    const crashing = makeStore(t, {
      directory,
      faultInjector(point) {
        if (armed && point === "after-temp-file-fsync") {
          armed = false;
          throw new Error("simulated process crash");
        }
      },
    });

    assert.throws(() => crashing.replace(replacement), /simulated process crash/);
    const recovered = makeStore(t, { directory });
    assert.deepEqual(recovered.get(original.id), original);
    assert.equal(
      readdirSync(recovered.tasksDirectory).some((name) => name.endsWith(".tmp")),
      true,
      "crash-like temp tail is ignored rather than treated as a snapshot",
    );
  });

  it("recovers the new snapshot when a crash occurs before journal append", (t) => {
    const directory = testStateDirectory(t);
    const initial = makeStore(t, { directory });
    const original = makeTask();
    initial.create(original);
    const oldJournal = readFileSync(initial.journalPath, "utf8");
    const replacement = clone(original);
    replacement.updatedAt = LATER;
    replacement.objective = "Durable replacement before non-authoritative audit";
    let armed = true;
    const crashing = makeStore(t, {
      directory,
      faultInjector(point) {
        if (armed && point === "before-journal-append") {
          armed = false;
          throw new Error("simulated process crash before audit");
        }
      },
    });

    assert.throws(() => crashing.replace(replacement), /simulated process crash before audit/);
    const recovered = makeStore(t, { directory });
    assert.deepEqual(recovered.get(original.id), replacement);
    assert.equal(readFileSync(recovered.journalPath, "utf8"), oldJournal);
  });

  it("loads snapshots with a missing, truncated, or contradictory journal tail", (t) => {
    const directory = testStateDirectory(t);
    const store = makeStore(t, { directory });
    const task = makeTask();
    store.create(task);

    writeFileSync(
      store.journalPath,
      `${JSON.stringify({ taskId: task.id, state: "DONE" })}\n{"truncated":`,
      { mode: 0o600 },
    );
    assert.equal(makeStore(t, { directory }).get(task.id)?.state, "QUEUED");

    unlinkSync(store.journalPath);
    assert.deepEqual(makeStore(t, { directory }).list(), [task]);
  });

  it("rejects malformed or mismatched authoritative snapshots", (t) => {
    const directory = testStateDirectory(t);
    const store = makeStore(t, { directory });
    writeFileSync(join(store.tasksDirectory, "wt-malformed.json"), "{not-json", { mode: 0o600 });
    assert.throws(() => store.list(), /malformed JSON/);
    unlinkSync(join(store.tasksDirectory, "wt-malformed.json"));

    const task = makeTask();
    writeFileSync(
      join(store.tasksDirectory, "wt-wrong-name.json"),
      `${JSON.stringify(task)}\n`,
      { mode: 0o600 },
    );
    assert.throws(() => store.list(), /does not match task id/);
  });

  it("rejects duplicate active correlations but permits a new task after a terminal snapshot", (t) => {
    const store = makeStore(t);
    const first = makeTask();
    store.create(first);
    const duplicate = makeTask("wt-20260717-duplicate", first.source.correlationKey);
    assert.throws(
      () => store.create(duplicate),
      (error: unknown) => {
        assert.ok(error instanceof OpsWorkerDuplicateCorrelationError);
        assert.equal(error.existingTaskId, first.id);
        return true;
      },
    );

    const completed = clone(first);
    completed.state = "DONE";
    completed.updatedAt = LATER;
    completed.lastOutcome = {
      at: LATER,
      kind: "DONE_CHECK",
      result: "PASS",
      summary: "Fresh fixture evidence passed.",
    };
    store.replace(completed, { event: "TRANSITION" });
    assert.doesNotThrow(() => store.create(duplicate));
    assert.equal(store.list().length, 2);
  });

  it("rejects traversal identifiers and symlinked state paths", (t) => {
    const store = makeStore(t);
    assert.throws(() => store.get("../outside"), /traversal-safe/);

    const outside = testStateDirectory(t);
    const symlinkRoot = join(testStateDirectory(t), "linked-state");
    symlinkSync(outside, symlinkRoot, "dir");
    assert.throws(
      () => new OpsWorkerTaskStore(symlinkRoot, { registry }),
      /path is a symlink/,
    );

    const task = makeTask();
    const snapshotPath = join(store.tasksDirectory, `${task.id}.json`);
    const target = join(testStateDirectory(t), "outside.json");
    writeFileSync(target, `${JSON.stringify(task)}\n`, { mode: 0o600 });
    symlinkSync(target, snapshotPath);
    assert.throws(() => store.get(task.id), /path is a symlink/);
  });

  it("rejects a symlinked journal before changing an existing snapshot", (t) => {
    const store = makeStore(t);
    const task = makeTask();
    store.create(task);
    unlinkSync(store.journalPath);
    const outsideJournal = join(testStateDirectory(t), "outside-journal.jsonl");
    writeFileSync(outsideJournal, "outside\n", { mode: 0o600 });
    symlinkSync(outsideJournal, store.journalPath);
    const replacement = clone(task);
    replacement.updatedAt = LATER;
    replacement.objective = "Must not be written through unsafe journal setup";

    assert.throws(() => store.replace(replacement), /path is a symlink/);
    rmSync(store.journalPath, { force: true });
    assert.deepEqual(store.get(task.id), task);
    assert.equal(readFileSync(outsideJournal, "utf8"), "outside\n");
  });

  it("keeps the append-only audit bounded without affecting snapshot authority", (t) => {
    const store = makeStore(t, { maxJournalBytes: 0 });
    const task = makeTask();
    const result = store.create(task);

    assert.equal(result.journalAppended, false);
    assert.equal(readFileSync(store.journalPath, "utf8"), "");
    assert.deepEqual(store.get(task.id), task);
  });

  it("rejects non-regular snapshot entries instead of following them", (t) => {
    const store = makeStore(t);
    const directoryName = "wt-directory.json";
    mkdirSync(join(store.tasksDirectory, directoryName), { mode: 0o700 });
    assert.throws(() => store.list(), OpsWorkerTaskStoreSafetyError);
  });

  it("does not depend on writable broad permissions supplied by the caller", (t) => {
    const directory = testStateDirectory(t);
    chmodSync(directory, 0o777);
    const store = makeStore(t, { directory });
    store.create(makeTask());
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.equal(existsSync(store.journalPath), true);
  });

  it("uses unpredictable same-directory temporary names at the crash boundary", (t) => {
    const directory = testStateDirectory(t);
    const suffix = randomBytes(3).toString("hex");
    const task = makeTask(`wt-temp-${suffix}`);
    const store = makeStore(t, {
      directory,
      faultInjector(point) {
        if (point === "after-temp-file-fsync") throw new Error("stop before rename");
      },
    });
    assert.throws(() => store.create(task), /stop before rename/);
    const tempNames = readdirSync(store.tasksDirectory).filter((name) => name.endsWith(".tmp"));
    assert.equal(tempNames.length, 1);
    assert.match(tempNames[0], new RegExp(`^\\.${task.id}\\.${process.pid}\\.[a-f0-9]{16}\\.tmp$`));
    assert.equal(lstatSync(join(store.tasksDirectory, tempNames[0])).isSymbolicLink(), false);
  });
});
