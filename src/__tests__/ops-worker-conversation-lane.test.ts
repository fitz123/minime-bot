import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OpsWorkerConversationLane,
  OpsWorkerConversationPreemptionError,
} from "../ops-worker/conversation-lane.js";

describe("ops worker incident-first conversation lane", () => {
  it("has one queue-free slot and closes admission during incident execution", async () => {
    let resolveTurn!: (value: string) => void;
    const turn = new Promise<string>((resolvePromise) => {
      resolveTurn = resolvePromise;
    });
    let incidentActive = false;
    const lane = new OpsWorkerConversationLane({
      blocksAdmission: () => false,
      abortConversation: async () => true,
    });

    const first = lane.tryStart(async () => turn);
    assert.ok(first);
    assert.equal(lane.tryStart(async () => "queued"), null);
    resolveTurn("complete");
    assert.equal(await first, "complete");

    await lane.runIncident(async () => {
      incidentActive = true;
      assert.equal(lane.tryStart(async () => "late"), null);
    });
    assert.equal(incidentActive, true);
    const after = lane.tryStart(async () => "admitted");
    assert.ok(after);
    assert.equal(await after, "admitted");
  });

  it("fails closed and never starts incident work when conversation reaping is unproven", async () => {
    let turnAborted = false;
    let incidentStarted = false;
    const lane = new OpsWorkerConversationLane({
      blocksAdmission: () => false,
      abortConversation: async () => false,
    });
    const active = lane.tryStart(async (signal) => await new Promise<string>((resolve) => {
      const abort = (): void => {
        turnAborted = true;
        resolve("aborted");
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }));
    assert.ok(active);

    await assert.rejects(
      lane.runIncident(async () => {
        incidentStarted = true;
      }),
      OpsWorkerConversationPreemptionError,
    );

    assert.equal(await active, "aborted");
    assert.equal(turnAborted, true);
    assert.equal(incidentStarted, false);
  });

  it("fails admission closed when the incident-state inspector faults", () => {
    const lane = new OpsWorkerConversationLane({
      blocksAdmission: () => {
        throw new Error("synthetic scheduler-state failure");
      },
      abortConversation: async () => true,
    });
    assert.equal(lane.tryStart(async () => "unexpected"), null);
  });
});
