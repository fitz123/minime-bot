import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { fileURLToPath } from "node:url";
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
const STORE_CREATE_FIXTURE = fileURLToPath(
  new URL("./fixtures/ops-worker-store-create.ts", import.meta.url),
);

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
      tools: ["read", "grep", "find", "ls"],
    },
    "issue.full-cycle.v1": {
      sourceKinds: ["authorized-issue"],
      scope: ["repository-read", "repository-write", "pull-request", "issue-lifecycle"],
      tools: ["read", "bash", "edit", "write", "grep", "find", "ls"],
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
    unverifiedRun: null,
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

  it("enforces every done-check parameter boundary before and after registered validation", () => {
    const parseParams = (
      params: unknown,
      selectedRegistry = registry,
    ): OpsWorkerTask => {
      const task = makeTask();
      task.doneCheck = { name: "lax-fixture", params: params as JsonObject };
      return parseOpsWorkerTask(task, selectedRegistry);
    };
    const nested = (depth: number): JsonObject => {
      let value: JsonObject = { leaf: true };
      for (let index = 0; index < depth; index += 1) value = { nested: value };
      return value;
    };
    const itemObject = (count: number): JsonObject => Object.fromEntries(
      Array.from({ length: count }, (_unused, index) => [`value${index}`, index]),
    ) as JsonObject;
    const sizedObject = (bytes: number): JsonObject => {
      const result: JsonObject = { a: "", b: "", c: "", d: "", e: "" };
      let remaining = bytes - Buffer.byteLength(JSON.stringify(result), "utf8");
      for (const key of Object.keys(result)) {
        const length = Math.min(
          OPS_WORKER_LIMITS.maxDoneCheckParamStringBytes,
          remaining,
        );
        result[key] = "x".repeat(length);
        remaining -= length;
      }
      assert.equal(remaining, 0);
      assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8"), bytes);
      return result;
    };

    assert.doesNotThrow(() => parseParams(nested(
      OPS_WORKER_LIMITS.maxDoneCheckParamDepth - 1,
    )));
    assert.doesNotThrow(() => parseParams(itemObject(
      OPS_WORKER_LIMITS.maxDoneCheckParamItems - 1,
    )));
    assert.doesNotThrow(() => parseParams({
      values: Array(OPS_WORKER_LIMITS.maxDoneCheckParamArrayLength).fill(null),
    }));
    assert.doesNotThrow(() => parseParams({
      text: "é".repeat(OPS_WORKER_LIMITS.maxDoneCheckParamStringBytes / 2),
    }));
    assert.doesNotThrow(() => parseParams(sizedObject(
      OPS_WORKER_LIMITS.maxDoneCheckParamsBytes,
    )));

    for (const [params, message] of [
      [nested(OPS_WORKER_LIMITS.maxDoneCheckParamDepth), /nested too deeply/],
      [itemObject(OPS_WORKER_LIMITS.maxDoneCheckParamItems), /too many values/],
      [{ values: Array(OPS_WORKER_LIMITS.maxDoneCheckParamArrayLength + 1).fill(null) }, /array is too large/],
      [{ text: "é".repeat(OPS_WORKER_LIMITS.maxDoneCheckParamStringBytes / 2 + 1) }, /string value is too large/],
      [sizedObject(OPS_WORKER_LIMITS.maxDoneCheckParamsBytes + 1), /must be at most 8192/],
      [{ value: Number.NaN }, /number must be finite/],
      [{ "not.safe": true }, /unsafe parameter field name/],
    ] as const) {
      assert.throws(() => parseParams(params), message);
    }

    const accessorParams: Record<string, unknown> = {};
    Object.defineProperty(accessorParams, "value", {
      enumerable: true,
      get: () => true,
    });
    assert.throws(() => parseParams(accessorParams), /accessor fields are not allowed/);

    const unsafeValidatorRegistry: OpsWorkerTaskContractRegistry = {
      ...registry,
      doneChecks: {
        ...registry.doneChecks,
        "lax-fixture": {
          validateParams(): JsonObject {
            return { command: "validator-introduced" } as JsonObject;
          },
        },
      },
    };
    assert.throws(
      () => parseParams({}, unsafeValidatorRegistry),
      /cannot select commands, executables, URLs, or authorization/,
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

    const unexpectedFence = clone(makeTask());
    unexpectedFence.unverifiedRun = {
      attemptId: "attempt-unverified",
      supervisorInstanceId: "supervisor-1",
      pid: 456,
      expectedProcessGroupId: 456,
      launchedAt: NOW,
      ownershipNonceHash: `sha256:${"b".repeat(64)}`,
    };
    assert.throws(
      () => parseOpsWorkerTask(unexpectedFence, registry),
      /must be null unless retaining an ambiguous blocked launch fence/,
    );

    unexpectedFence.state = "BLOCKED";
    unexpectedFence.lastOutcome = {
      at: NOW,
      kind: "RECONCILIATION",
      result: "AMBIGUOUS_ORPHAN",
      summary: "Synthetic unverified launch remains fenced.",
    };
    assert.equal(
      parseOpsWorkerTask(unexpectedFence, registry).unverifiedRun?.pid,
      456,
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

  it("serializes concurrent cross-process correlation creation", async (t) => {
    const root = testStateDirectory(t);
    const directory = join(root, "state");
    const readyPath = join(root, "first-ready");
    const releasePath = join(root, "release-first");
    const runFixture = (
      taskId: string,
      barrier = false,
    ): Promise<{ code: number | null; stdout: string; stderr: string }> => {
      const child = spawn(process.execPath, [
        "--import",
        "tsx",
        STORE_CREATE_FIXTURE,
        directory,
        taskId,
        "operator:shared:concurrent",
        ...(barrier ? [readyPath, releasePath] : []),
      ], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      return new Promise((resolveChild) => {
        child.once("close", (code) => resolveChild({ code, stdout, stderr }));
      });
    };

    const first = runFixture("concurrent-a", true);
    let second:
      | Promise<{ code: number | null; stdout: string; stderr: string }>
      | undefined;
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(readyPath)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for first store writer");
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      second = runFixture("concurrent-b");
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    } finally {
      writeFileSync(releasePath, "release\n", "utf8");
    }
    assert.ok(second !== undefined);
    const results = await Promise.all([first, second]);

    assert.deepEqual(results.map((result) => result.code).sort(), [0, 1]);
    assert.equal(
      results.some((result) => /OpsWorkerDuplicateCorrelationError/.test(result.stderr)),
      true,
    );
    const recovered = new OpsWorkerTaskStore(directory, { registry });
    assert.equal(recovered.list().length, 1);
  });

  it("publishes complete mutation locks and reclaims a reused PID identity", (t) => {
    const directory = testStateDirectory(t);
    const interrupted = makeStore(t, {
      directory,
      faultInjector(point) {
        if (point === "after-mutation-lock-temp-fsync") {
          throw new Error("synthetic mutation-lock publication crash");
        }
      },
    });
    assert.throws(
      () => interrupted.create(makeTask()),
      /synthetic mutation-lock publication crash/,
    );
    const canonicalLock = join(directory, ".task-store.lock");
    assert.equal(existsSync(canonicalLock), false);

    writeFileSync(canonicalLock, `${JSON.stringify({
      pid: process.pid,
      processStartToken: `sha256:${"0".repeat(64)}`,
      nonce: "1".repeat(32),
    })}\n`, { mode: 0o600 });
    const recovered = makeStore(t, { directory });
    assert.doesNotThrow(() => recovered.create(makeTask()));
    assert.equal(existsSync(canonicalLock), false);
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
