import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES,
  OpsWorkerControlLedger,
  OpsWorkerControlLedgerSafetyError,
  hashOpsWorkerTelegramUpdate,
} from "../ops-worker/control-ledger.js";

function stateDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "minime-control-ledger-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fingerprint(updateId: number, suffix = "fixture"): string {
  return hashOpsWorkerTelegramUpdate(`telegram-update:${updateId}:${suffix}`);
}

describe("ops worker Telegram control ledger", () => {
  it("starts fresh without writing and durably advances a monotonic offset", (t) => {
    const ledger = new OpsWorkerControlLedger(stateDirectory(t));

    assert.deepEqual(ledger.read(), {
      schemaVersion: 1,
      lastAckedUpdateId: null,
      processedUpdates: [],
    });
    assert.equal(ledger.nextOffset(), undefined);
    assert.equal(existsSync(ledger.ledgerPath), false);

    const recorded = ledger.recordProcessedUpdate(41, fingerprint(41));

    assert.equal(recorded.recorded, true);
    assert.equal(recorded.replayed, false);
    assert.equal(recorded.state.lastAckedUpdateId, 41);
    assert.equal(ledger.nextOffset(), 42);
    assert.equal(lstatSync(ledger.controlDirectory).mode & 0o777, 0o700);
    assert.equal(lstatSync(ledger.ledgerPath).mode & 0o777, 0o600);
    assert.deepEqual(new OpsWorkerControlLedger(ledger.controlDirectory.replace(/\/control$/, "")).read(), recorded.state);
  });

  it("treats an identical update-id replay as a no-op and rejects conflicting reuse", (t) => {
    const ledger = new OpsWorkerControlLedger(stateDirectory(t));
    const first = ledger.record(100, fingerprint(100));
    const raw = readFileSync(ledger.ledgerPath, "utf8");

    const replay = ledger.record(100, fingerprint(100));

    assert.equal(replay.recorded, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.state, first.state);
    assert.equal(readFileSync(ledger.ledgerPath, "utf8"), raw);
    assert.throws(
      () => ledger.record(100, fingerprint(100, "conflict")),
      /conflicts with its durable fingerprint/,
    );
  });

  it("uses the bounded fingerprint ring for retained replay and old-update rejection", (t) => {
    const ledger = new OpsWorkerControlLedger(stateDirectory(t), {
      maxProcessedUpdates: 2,
    });
    ledger.record(10, fingerprint(10));
    ledger.record(11, fingerprint(11));
    ledger.record(12, fingerprint(12));

    assert.deepEqual(
      ledger.read().processedUpdates.map((entry) => entry.updateId),
      [11, 12],
    );
    assert.equal(ledger.record(11, fingerprint(11)).replayed, true);
    assert.throws(
      () => ledger.record(11, fingerprint(11, "conflict")),
      /conflicts with its durable fingerprint/,
    );
    assert.throws(
      () => ledger.record(10, fingerprint(10)),
      /older than the retained replay window/,
    );
    assert.equal(ledger.read().lastAckedUpdateId, 12);
  });

  it("recovers the old ledger when a crash leaves only a partial temp write", (t) => {
    const directory = stateDirectory(t);
    const initial = new OpsWorkerControlLedger(directory);
    initial.record(1, fingerprint(1));
    const durableBeforeCrash = readFileSync(initial.ledgerPath, "utf8");
    let armed = true;
    const crashing = new OpsWorkerControlLedger(directory, {
      faultInjector(point) {
        if (armed && point === "after-temp-file-fsync") {
          armed = false;
          throw new Error("simulated control-ledger crash");
        }
      },
    });

    assert.throws(
      () => crashing.record(2, fingerprint(2)),
      /simulated control-ledger crash/,
    );
    assert.equal(readFileSync(initial.ledgerPath, "utf8"), durableBeforeCrash);
    assert.equal(
      readdirSync(initial.controlDirectory).some((name) => name.endsWith(".tmp")),
      true,
    );

    const recovered = new OpsWorkerControlLedger(directory);
    assert.equal(recovered.read().lastAckedUpdateId, 1);
    assert.equal(recovered.record(2, fingerprint(2)).state.lastAckedUpdateId, 2);
  });

  it("fails closed on ring overflow, malformed fingerprints, and future versions", (t) => {
    const directory = stateDirectory(t);
    const ledger = new OpsWorkerControlLedger(directory);
    const overflow = {
      schemaVersion: 1,
      lastAckedUpdateId: OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES,
      processedUpdates: Array.from(
        { length: OPS_WORKER_CONTROL_LEDGER_MAX_PROCESSED_UPDATES + 1 },
        (_, updateId) => ({ updateId, fingerprint: fingerprint(updateId) }),
      ),
    };
    writeFileSync(ledger.ledgerPath, `${JSON.stringify(overflow)}\n`, { mode: 0o600 });
    assert.throws(() => ledger.read(), /retains more than 256 updates/);

    writeFileSync(ledger.ledgerPath, `${JSON.stringify({
      schemaVersion: 2,
      lastAckedUpdateId: null,
      processedUpdates: [],
    })}\n`, { mode: 0o600 });
    assert.throws(
      () => ledger.read(),
      (error: unknown) => error instanceof OpsWorkerControlLedgerSafetyError
        && /Unsupported control ledger schema version 2/.test(error.message),
    );
    assert.throws(() => ledger.record(1, "not-a-fingerprint"), /sha256:<hex>/);
  });
});
