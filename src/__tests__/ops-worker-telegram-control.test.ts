import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import type { OpsWorkerAuthorizationVerifierRegistry } from "../ops-worker/authorization.js";
import type { OpsWorkerControlConfig } from "../ops-worker/control-config.js";
import { OpsWorkerControlLedger } from "../ops-worker/control-ledger.js";
import { OpsWorkerDoneCheckRegistry } from "../ops-worker/done-checks.js";
import {
  OpsWorkerSupervisor,
  type OpsWorkerSupervisorOptions,
} from "../ops-worker/supervisor.js";
import {
  OpsWorkerTaskStore,
  type OpsWorkerTaskStoreFaultPoint,
} from "../ops-worker/task-store.js";
import {
  OpsWorkerTelegramControl,
  type OpsWorkerTelegramFetch,
} from "../ops-worker/telegram-control.js";
import {
  createEmptyOpsWorkerLifecycleManifest,
  createEmptyOpsWorkerMutationReceipts,
  createUnclaimedOpsWorkerCustody,
  OPS_WORKER_LIMITS,
  withOpsWorkerSubmissionFingerprint,
  type OpsWorkerTask,
  type OpsWorkerTaskContractRegistry,
} from "../ops-worker/types.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NOW = "2026-07-19T10:00:00.000Z";
const AUTH_HASH = `sha256:${"a".repeat(64)}`;

const doneChecks = new OpsWorkerDoneCheckRegistry({
  "fixture-check": {
    timeoutMs: 100,
    validateParams(value) {
      assert.deepEqual(value, {});
      return {};
    },
    run: () => ({ result: "PASS", summary: "Fixture passed." }),
  },
});
const taskRegistry: OpsWorkerTaskContractRegistry = {
  templates: { "fixture-task": { sourceKinds: ["operator-cli"] } },
  authorizationProfiles: {
    "fixture.inspect.v1": { sourceKinds: ["operator-cli"], scope: ["inspect"] },
  },
  doneChecks: doneChecks.contracts,
};
const authorizationVerifiers: OpsWorkerAuthorizationVerifierRegistry = {
  "operator-cli": {
    identity: "fixture-authorization",
    version: "1",
    verify: () => ({
      status: "PASS",
      evidenceHash: `sha256:${"b".repeat(64)}`,
      summary: "Fixture authorization remains valid.",
    }),
  },
};
const config: OpsWorkerControlConfig = {
  telegram: {
    token: "TEST_OPS_TOKEN",
    controlChatId: "100000000",
    operatorIds: ["100000000"],
  },
  intake: undefined,
  poll: {
    longPollSeconds: 1,
    requestTimeoutMs: 2000,
    retryMinMs: 10,
    retryMaxMs: 20,
    maxResponseBytes: 65536,
  },
  reply: { maxBytes: 1024 },
};

function makeTask(id: string): OpsWorkerTask {
  return withOpsWorkerSubmissionFingerprint({
    schemaVersion: 5,
    id,
    source: {
      kind: "operator-cli",
      correlationKey: `fixture:${id}`,
      deliveryKey: `fixture:${id}`,
      template: "fixture-task",
    },
    resource: { kind: "host", key: "host:local" },
    lifecycle: createEmptyOpsWorkerLifecycleManifest(),
    currentCheckpoint: null,
    mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
    custody: createUnclaimedOpsWorkerCustody(),
    priority: 10,
    objective: "Exercise the bounded Telegram fixture",
    evidence: [],
    doneCheck: { name: "fixture-check", params: {} },
    authorization: {
      profile: "fixture.inspect.v1",
      scope: ["inspect"],
      snapshotHash: AUTH_HASH,
    },
    authorizationVerification: null,
    verification: null,
    legacyCompletion: null,
    steering: [],
    control: { paused: false, pausedAt: null, interrupt: null },
    state: "QUEUED",
    rounds: { remediation: 0, maxRemediation: 3, consecutiveInfrastructureFailures: 0 },
    schedule: { nextRunAt: null, nextCheckAt: null },
    session: { directory: `sessions/${id}`, sessionId: null, resume: false },
    activeRun: null,
    unverifiedRun: null,
    lastOutcome: null,
    report: { state: "NONE", attempts: 0, lastError: null },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

class FakeTelegramTransport {
  readonly getUpdatesBodies: Record<string, unknown>[] = [];
  readonly messages: Record<string, unknown>[] = [];
  readonly updates: unknown[][] = [];
  sendCalls = 0;

  readonly fetch: OpsWorkerTelegramFetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (url.endsWith("/getUpdates")) {
      this.getUpdatesBodies.push(body);
      return Response.json({ ok: true, result: this.updates.shift() ?? [] });
    }
    if (url.endsWith("/sendMessage")) {
      this.sendCalls += 1;
      this.messages.push(body);
      return Response.json({ ok: true, result: { message_id: this.sendCalls } });
    }
    throw new Error(`Unexpected Telegram fixture URL ${url}`);
  };
}

function update(
  updateId: number,
  text: string,
  options: { senderId?: number; chatId?: number } = {},
): Record<string, unknown> {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_753_000_000,
      text,
      from: { id: options.senderId ?? 100000000, is_bot: false },
      chat: { id: options.chatId ?? 100000000, type: "private" },
    },
  };
}

interface Harness {
  directory: string;
  store: OpsWorkerTaskStore;
  supervisor: OpsWorkerSupervisor;
  ledger: OpsWorkerControlLedger;
  close(): void;
}

async function harness(
  t: TestContext,
  options: {
    faultInjector?: (point: OpsWorkerTaskStoreFaultPoint) => void;
    directory?: string;
    instanceId?: string;
    nowStart?: string;
  } = {},
): Promise<Harness> {
  const directory = options.directory
    ?? mkdtempSync(join(tmpdir(), "minime-telegram-control-"));
  if (!options.directory) {
    t.after(() => rmSync(directory, { recursive: true, force: true }));
  }
  const store = new OpsWorkerTaskStore(directory, {
    registry: taskRegistry,
    now: (() => {
      let milliseconds = Date.parse(options.nowStart ?? NOW);
      return () => new Date(milliseconds += 1_000);
    })(),
    faultInjector: options.faultInjector,
  });
  let supervisorNow = Date.parse(options.nowStart ?? NOW);
  const supervisorOptions: OpsWorkerSupervisorOptions = {
    store,
    doneChecks,
    instanceId: options.instanceId ?? "telegram-control-fixture",
    processStartToken: `${options.instanceId ?? "telegram-control-fixture"}-start`,
    now: () => new Date(supervisorNow += 1_000),
    authorizationVerifiers,
  };
  const supervisor = new OpsWorkerSupervisor(supervisorOptions);
  await supervisor.start();
  return {
    directory,
    store,
    supervisor,
    ledger: new OpsWorkerControlLedger(directory),
    close: () => supervisor.close(),
  };
}

function control(
  fixture: Harness,
  transport: FakeTelegramTransport,
  faultInjector?: ConstructorParameters<typeof OpsWorkerTelegramControl>[0]["faultInjector"],
): OpsWorkerTelegramControl {
  return new OpsWorkerTelegramControl({
    config,
    supervisor: fixture.supervisor,
    ledger: fixture.ledger,
    fetch: transport.fetch,
    inspectPolicy: () => ({
      authorization: { configuredSources: ["operator-cli"], verifierCount: 1, contractsHash: AUTH_HASH, contracts: [] },
      verification: { verifierCount: 1, contractsHash: AUTH_HASH, contracts: [] },
      quota: { configured: false },
      parity: { configured: false },
    }),
    faultInjector,
  });
}

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("ops worker dedicated Telegram control", () => {
  it("has no dependency on grammY or the primary Telegram runtime", () => {
    for (const path of sourceFiles(join(PACKAGE_ROOT, "src", "ops-worker"))) {
      if (!path.endsWith(".ts")) continue;
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, /from\s+["']grammy["']/);
      assert.doesNotMatch(source, /from\s+["']\.\.\/telegram-(?:bot|adapter)\.js["']/);
    }
    const changedPrimaryBot = execFileSync(
      "git",
      ["diff", "7c53a7a", "--name-only", "--", "src/telegram-bot.ts"],
      { cwd: PACKAGE_ROOT, encoding: "utf8" },
    );
    assert.equal(changedPrimaryBot, "");
  });

  it("persists effects and offsets, rejects the allowlist, and replays duplicates as no-ops", async (t) => {
    const fixture = await harness(t);
    t.after(() => fixture.close());
    fixture.store.create(makeTask("task-control"));
    const transport = new FakeTelegramTransport();
    const first = update(11, "/answer task-control use the retained checkpoint");
    transport.updates.push([first], [first], [
      update(12, "/correct task-control forbidden", { senderId: 100000999 }),
    ], [{ update_id: 13, message: { date: 1_753_000_000 } }]);
    const client = control(fixture, transport);

    await client.tick();
    await client.tick();
    await client.tick();
    await client.tick();

    const task = fixture.store.get("task-control");
    assert.equal(task?.steering.length, 1);
    assert.equal(task?.steering[0].kind, "answer");
    assert.equal(task?.steering[0].text, "use the retained checkpoint");
    assert.equal(fixture.ledger.read().lastAckedUpdateId, 13);
    assert.equal(transport.messages.length, 1);
    assert.deepEqual(
      transport.getUpdatesBodies.map((body) => body.offset),
      [undefined, 12, 12, 13],
    );
    assert.deepEqual(transport.getUpdatesBodies[0].allowed_updates, ["message"]);
  });

  it("acknowledges bounded command rejections instead of replaying poison updates", async (t) => {
    const fixture = await harness(t);
    t.after(() => fixture.close());
    const ambiguous = makeTask("task-ambiguous-retry");
    ambiguous.state = "BLOCKED";
    ambiguous.custody = {
      status: "HELD",
      claimedAt: NOW,
      releasedAt: null,
      releaseReason: null,
    };
    ambiguous.activeRun = {
      attemptId: "ambiguous-attempt",
      supervisorInstanceId: "prior-supervisor",
      pid: 321,
      processGroupId: 321,
      processStartedAt: NOW,
      processStartToken: "prior-process-start",
    };
    ambiguous.lastOutcome = {
      at: NOW,
      kind: "RECONCILIATION",
      result: "AMBIGUOUS_ORPHAN",
      summary: "Fixture prior process group remains ambiguous.",
    };
    ambiguous.report.state = "PENDING";
    fixture.store.create(ambiguous);

    const full = makeTask("task-full-steering");
    full.steering = Array.from({ length: OPS_WORKER_LIMITS.maxSteeringEntries }, (_, index) => ({
      steeringId: `fixture:steering:${index}`,
      receivedAt: NOW,
      kind: "answer" as const,
      operatorRef: "fixture:operator",
      text: `Bounded steering ${index}`,
      consumedAt: null,
    }));
    fixture.store.create(full);

    const transport = new FakeTelegramTransport();
    transport.updates.push([
      update(70, "/retry task-ambiguous-retry"),
      update(71, "/answer task-full-steering one more entry"),
    ]);

    await control(fixture, transport).tick();

    assert.equal(fixture.ledger.read().lastAckedUpdateId, 71);
    assert.equal(fixture.store.get(ambiguous.id)?.state, "BLOCKED");
    assert.equal(fixture.store.get(ambiguous.id)?.steering.length, 1);
    assert.equal(
      fixture.store.get(full.id)?.steering.length,
      OPS_WORKER_LIMITS.maxSteeringEntries,
    );
    assert.equal(transport.messages.some((message) =>
      String(message.text).includes("rejected at its current safe boundary")), true);
    assert.equal(transport.messages.some((message) =>
      String(message.text).includes("cannot record more steering")), true);
  });

  it("recovers a crash after the task effect without acknowledging or duplicating it", async (t) => {
    const fixture = await harness(t);
    t.after(() => fixture.close());
    fixture.store.create(makeTask("task-crash"));
    const transport = new FakeTelegramTransport();
    const redelivered = update(21, "/correct task-crash inspect the latest local evidence");
    transport.updates.push([redelivered], [redelivered]);
    let armed = true;
    const crashing = control(fixture, transport, (point) => {
      if (armed && point === "after-effect-before-ledger") {
        armed = false;
        throw new Error("synthetic crash before Telegram ack");
      }
    });

    await assert.rejects(crashing.tick(), /synthetic crash before Telegram ack/);
    assert.equal(fixture.store.get("task-crash")?.steering.length, 1);
    assert.equal(fixture.ledger.nextOffset(), undefined);

    await control(fixture, transport).tick();
    assert.equal(fixture.store.get("task-crash")?.steering.length, 1);
    assert.equal(fixture.ledger.nextOffset(), 22);
    assert.equal(transport.messages.length, 1);
  });

  it("converges multi-write commands when a crash follows their steering write", async (t) => {
    const cases = [
      { command: "pause", expectedState: "QUEUED", expectedPaused: true },
      { command: "resume", expectedState: "QUEUED", expectedPaused: false },
      { command: "retry", expectedState: "RESUMABLE", expectedPaused: false },
      { command: "cancel", expectedState: "CANCELLED", expectedPaused: false },
    ] as const;
    for (const [index, expected] of cases.entries()) {
      let armed = false;
      const fixture = await harness(t, {
        instanceId: `multi-write-${index}`,
        faultInjector(point) {
          if (armed && point === "after-snapshot-rename") {
            armed = false;
            throw new Error("synthetic crash after steering write");
          }
        },
      });
      const taskId = `task-multi-${index}`;
      const task = makeTask(taskId);
      if (expected.command.startsWith("resume")) task.control = {
        paused: true,
        pausedAt: NOW,
        interrupt: null,
      };
      if (expected.command.startsWith("retry")) {
        task.state = "BLOCKED";
        task.custody = {
          status: "RELEASED",
          claimedAt: null,
          releasedAt: NOW,
          releaseReason: "BLOCKED",
        };
        task.rounds.remediation = task.rounds.maxRemediation;
        task.lastOutcome = {
          at: NOW,
          kind: "OPERATOR",
          result: "BLOCKED",
          summary: "Fixture blocked before replay-safe retry.",
        };
        task.report.state = "PENDING";
      }
      fixture.store.create(task);
      const transport = new FakeTelegramTransport();
      const client = control(fixture, transport);
      if (expected.command.startsWith("retry")) {
        transport.updates.push([]);
        await client.tick();
      }
      const command = update(
        40 + index,
        `/${expected.command} ${taskId}${expected.command === "cancel" ? " planned recovery" : ""}`,
      );
      transport.updates.push([command], [command]);
      armed = true;

      await assert.rejects(client.tick(), /synthetic crash after steering write/);
      const persisted = fixture.store.get(taskId);
      assert.equal(persisted?.steering.length, 1);
      assert.equal(fixture.ledger.nextOffset(), undefined);
      fixture.close();

      const restarted = await harness(t, {
        directory: fixture.directory,
        instanceId: `multi-write-restarted-${index}`,
      });
      if (expected.command === "pause") {
        assert.equal(persisted?.control.paused, true);
        assert.equal(restarted.supervisor.selectNextTask(), undefined);
      } else if (expected.command === "cancel") {
        assert.equal(persisted?.control.interrupt?.mode, "cancel");
        assert.equal(restarted.store.get(taskId)?.state, "CANCELLED");
        assert.equal(restarted.supervisor.selectNextTask(), undefined);
      } else if (expected.command === "resume") {
        assert.equal(restarted.supervisor.selectNextTask()?.action, "RUN");
      } else {
        assert.equal(restarted.supervisor.selectNextTask(), undefined);
      }

      await control(restarted, transport).tick();
      const converged = restarted.store.get(taskId);
      assert.equal(converged?.steering.length, 1);
      assert.equal(converged?.state, expected.expectedState);
      assert.equal(converged?.control.paused, expected.expectedPaused);
      assert.equal(restarted.ledger.nextOffset(), 41 + index);
      restarted.close();
    }
  });

  it("retries transport failures with bounded backoff and never skips the durable offset", async (t) => {
    const fixture = await harness(t);
    t.after(() => fixture.close());
    const controller = new AbortController();
    const backoffs: number[] = [];
    const offsets: unknown[] = [];
    let calls = 0;
    const client = new OpsWorkerTelegramControl({
      config,
      supervisor: fixture.supervisor,
      ledger: fixture.ledger,
      inspectPolicy: () => ({
        authorization: { configuredSources: ["operator-cli"], verifierCount: 1, contractsHash: AUTH_HASH, contracts: [] },
        verification: { verifierCount: 1, contractsHash: AUTH_HASH, contracts: [] },
        quota: { configured: false },
        parity: { configured: false },
      }),
      fetch: async (input, init) => {
        calls += 1;
        if (calls <= 3) throw new Error("synthetic network failure");
        const method = String(input).split("/").at(-1);
        if (method === "getUpdates") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          offsets.push(body.offset);
          return Response.json({ ok: true, result: [update(25, "/status")] });
        }
        controller.abort();
        return Response.json({ ok: true, result: { message_id: 1 } });
      },
      sleep: async (milliseconds) => {
        backoffs.push(milliseconds);
      },
    });

    await client.run(controller.signal);

    assert.deepEqual(backoffs, [
      config.poll.retryMinMs,
      config.poll.retryMaxMs,
      config.poll.retryMaxMs,
    ]);
    assert.deepEqual(offsets, [undefined]);
    assert.equal(fixture.ledger.nextOffset(), 26);
  });

  it("rejects an oversized Telegram body without changing the ledger", async (t) => {
    const fixture = await harness(t);
    t.after(() => fixture.close());
    const client = new OpsWorkerTelegramControl({
      config,
      supervisor: fixture.supervisor,
      ledger: fixture.ledger,
      inspectPolicy: () => ({
        authorization: { configuredSources: ["operator-cli"], verifierCount: 1, contractsHash: AUTH_HASH, contracts: [] },
        verification: { verifierCount: 1, contractsHash: AUTH_HASH, contracts: [] },
        quota: { configured: false },
        parity: { configured: false },
      }),
      fetch: async () => new Response("x".repeat(config.poll.maxResponseBytes + 1)),
    });

    await assert.rejects(client.tick(), /response exceeds 65536 bytes/);
    assert.equal(fixture.ledger.nextOffset(), undefined);
  });

  it("durably handles task ids outside the canonical store contract as malformed commands", async (t) => {
    const fixture = await harness(t);
    t.after(() => fixture.close());
    const transport = new FakeTelegramTransport();
    transport.updates.push([update(29, "/task invalid.task")]);

    await control(fixture, transport).tick();

    assert.equal(fixture.ledger.nextOffset(), 30);
    assert.equal(transport.messages.length, 1);
    assert.match(String(transport.messages[0].text), /^Usage:/);
  });

  it("implements bounded summaries and safe-boundary pause, resume, cancel, and retry", async (t) => {
    const fixture = await harness(t);
    t.after(() => fixture.close());
    fixture.store.create(makeTask("task-safe"));
    const retryTask = makeTask("task-retry");
    retryTask.state = "BLOCKED";
    retryTask.custody = {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: NOW,
      releaseReason: "BLOCKED",
    };
    retryTask.rounds.remediation = retryTask.rounds.maxRemediation;
    retryTask.lastOutcome = { at: NOW, kind: "OPERATOR", result: "BLOCKED", summary: "Fixture blocked." };
    retryTask.report.state = "PENDING";
    fixture.store.create(retryTask);
    const transport = new FakeTelegramTransport();
    transport.updates.push(
      [update(31, "/status")],
      [update(32, "/tasks")],
      [update(33, "/task task-safe")],
      [update(34, "/pause task-safe")],
      [update(35, "/resume task-safe")],
      [update(36, "/retry task-retry")],
      [update(37, "/cancel task-safe planned operator cancellation")],
      [update(38, "/unknown")],
    );
    const client = control(fixture, transport);

    for (let index = 0; index < 8; index += 1) await client.tick();

    assert.equal(fixture.store.get("task-safe")?.state, "CANCELLED");
    assert.equal(fixture.store.get("task-safe")?.control.paused, false);
    assert.equal(fixture.store.get("task-retry")?.state, "RESUMABLE");
    assert.equal(fixture.store.get("task-retry")?.steering.at(-1)?.kind, "resume");
    assert.equal(transport.messages.length, 10); // two terminal reports plus eight command replies
    assert.ok(transport.messages.every((message) =>
      Buffer.byteLength(String(message.text), "utf8") <= config.reply.maxBytes));
    assert.match(String(transport.messages.at(-1)?.text), /Usage:/);
    assert.equal(JSON.stringify(transport.messages).includes("Exercise the bounded"), false);
  });

  it("redelivers a report after a crash with a strictly newer receipt query", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "minime-telegram-report-crash-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const first = await harness(t, {
      directory,
      instanceId: "report-first",
    });
    const pending = makeTask("task-report");
    pending.state = "CANCELLED";
    pending.custody = {
      status: "RELEASED",
      claimedAt: null,
      releasedAt: NOW,
      releaseReason: "CANCELLED",
    };
    pending.lastOutcome = {
      at: NOW,
      kind: "OPERATOR",
      result: "CANCELLED",
      summary: "bounded-report-evidence ".repeat(100),
    };
    pending.report.state = "PENDING";
    first.store.create(pending);
    const transport = new FakeTelegramTransport();
    transport.updates.push([]);
    await assert.rejects(
      control(first, transport, (point) => {
        if (point === "after-report-send-before-receipt-finish") {
          throw new Error("synthetic crash before receipt finish");
        }
      }).tick(),
      /synthetic crash before receipt finish/,
    );
    assert.match(String(transport.messages[0].text), /… \[truncated\]$/);
    const claimed = first.store.get("task-report")?.mutationReceipts.report;
    assert.ok(claimed?.mutationStartedAt);
    assert.equal(claimed.outcome, null);
    assert.equal(first.store.get("task-report")?.report.state, "PENDING");
    first.close();

    const restarted = await harness(t, {
      directory,
      instanceId: "report-restarted",
      nowStart: "2026-07-19T11:00:00.000Z",
    });
    t.after(() => restarted.close());
    transport.updates.push([]);
    await control(restarted, transport).tick();

    const sent = restarted.store.get("task-report");
    assert.equal(sent?.report.state, "SENT");
    assert.equal(sent?.report.attempts, 1);
    assert.equal(transport.sendCalls, 2);
    assert.ok(
      Date.parse(sent?.mutationReceipts.report?.queryObservedAt ?? "")
      > Date.parse(claimed.queryObservedAt),
    );
    assert.equal(sent?.mutationReceipts.report?.outcome?.result, "APPLIED");
  });
});
