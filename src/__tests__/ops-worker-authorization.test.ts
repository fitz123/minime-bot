import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createAdr091AuthorizedIssueVerifier,
  hashAdr091AuthorizedIssueClaim,
  verifyOpsWorkerAuthorization,
  type Adr091AuthorizedIssueSnapshot,
} from "../ops-worker/authorization.js";
import {
  createEmptyOpsWorkerLifecycleManifest,
  createEmptyOpsWorkerMutationReceipts,
  createUnclaimedOpsWorkerCustody,
  hashOpsWorkerCanonicalSubmission,
  withOpsWorkerSubmissionFingerprint,
  type OpsWorkerTask,
} from "../ops-worker/types.js";
import {
  OPS_AVAILABILITY_DONE_CHECK_NAME,
  OPS_AVAILABILITY_INVARIANTS,
  OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
  type OpsAlertStateReading,
  type OpsMonitoringFreshnessReading,
  type OpsServiceAvailabilityReading,
} from "../ops-worker/availability-checks.js";
import {
  OPS_ALERTMANAGER_AUTHORIZATION_VALIDATOR_IDENTITY,
  OPS_AVAILABILITY_TEMPLATE_NAME,
  OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
  createOpsTaskContracts,
  hashOpsAlertmanagerAuthorizationSnapshot,
  type OpsAlertmanagerAuthorizationSnapshot,
} from "../ops-worker/ops-contracts.js";
import { inspectOpsWorkerPolicy } from "../ops-worker/status-server.js";
import { assertOpsWorkerStartAuthorizationVerifiers } from "../ops-worker/worker-cli.js";

const NOW = "2026-07-18T12:00:00.000Z";

function snapshot(): Adr091AuthorizedIssueSnapshot {
  return {
    canonicalTask: "github-issue:58",
    repository: {
      identity: "repo-node-id-1",
      resourceKey: "github:example/minime-bot",
    },
    issue: {
      identity: "issue-node-id-58",
      authorIdentity: "maintainer-node-id",
      title: "Bounded ops policy verifier",
      body: "Implement the registered authorization policy.",
      labels: ["autonomous-ready", "ops"],
      createdAt: "2026-07-18T09:00:00.000Z",
    },
    timeline: {
      complete: true,
      events: [
        {
          id: "edit-1",
          kind: "CONTENT_EDIT",
          at: "2026-07-18T10:00:00.000Z",
        },
        {
          id: "label-1",
          kind: "LABEL_APPLIED",
          label: "autonomous-ready",
          actorIdentity: "automation-owner-node-id",
          at: "2026-07-18T10:05:00.000Z",
        },
        {
          id: "comment-1",
          kind: "COMMENT",
          actorIdentity: "outsider-node-id",
          at: "2026-07-18T10:06:00.000Z",
        },
      ],
    },
  };
}

function task(remote: Adr091AuthorizedIssueSnapshot): OpsWorkerTask {
  const lifecycle = createEmptyOpsWorkerLifecycleManifest();
  lifecycle.canonicalTask = remote.canonicalTask;
  lifecycle.repository = remote.repository.identity;
  return withOpsWorkerSubmissionFingerprint({
    schemaVersion: 5,
    id: "authorized-issue-58",
    source: {
      kind: "authorized-issue",
      correlationKey: "github:example/minime-bot:issue:58",
      deliveryKey: "github:event:issue-58-ready-1",
      template: "issue-full-cycle",
    },
    resource: { kind: "repository", key: remote.repository.resourceKey },
    lifecycle,
    currentCheckpoint: null,
    mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
    custody: createUnclaimedOpsWorkerCustody(),
    priority: 30,
    objective: "Apply the registered issue workflow",
    evidence: [],
    doneCheck: { name: "fixture-check", params: {} },
    authorization: {
      profile: "issue.full-cycle.v1",
      scope: ["repository-read", "repository-write", "pull-request", "issue-lifecycle"],
      snapshotHash: hashAdr091AuthorizedIssueClaim(remote),
    },
    authorizationVerification: null,
    verification: null,
    legacyCompletion: null,
    steering: [],
    control: { paused: false, pausedAt: null, interrupt: null },
    state: "QUEUED",
    rounds: {
      remediation: 0,
      maxRemediation: 3,
      consecutiveInfrastructureFailures: 0,
    },
    schedule: { nextRunAt: null, nextCheckAt: null },
    session: {
      directory: "sessions/authorized-issue-58",
      sessionId: null,
      resume: false,
    },
    activeRun: null,
    unverifiedRun: null,
    lastOutcome: null,
    report: { state: "NONE", attempts: 0, lastError: null },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function verifier(remote: Adr091AuthorizedIssueSnapshot) {
  return createAdr091AuthorizedIssueVerifier({
    policy: {
      repository: {
        identity: "repo-node-id-1",
        resourceKey: "github:example/minime-bot",
      },
      allowedIssueAuthorIdentities: ["maintainer-node-id"],
      allowedReadyActorIdentities: ["automation-owner-node-id"],
    },
    resolver: {
      resolve: async () => structuredClone(remote),
    },
  });
}

describe("ADR-091 authorized issue verifier", () => {
  it("passes an exact fresh canonical claim and ignores outsider comments", async () => {
    const remote = snapshot();
    const result = await verifier(remote).verify(task(remote));
    assert.equal(result.status, "PASS");
    assert.match(result.evidenceHash, /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(result.summary, /outsider|maintainer|example/i);
  });

  it("fails closed on repository, author, label-actor, and freshness drift", async () => {
    const base = snapshot();
    const cases: Adr091AuthorizedIssueSnapshot[] = [];

    const repository = structuredClone(base);
    repository.repository.identity = "different-repository-node-id";
    cases.push(repository);

    const author = structuredClone(base);
    author.issue.authorIdentity = "outsider-author-node-id";
    cases.push(author);

    const actor = structuredClone(base);
    const applied = actor.timeline.events[1];
    assert.equal(applied.kind, "LABEL_APPLIED");
    applied.actorIdentity = "outsider-actor-node-id";
    cases.push(actor);

    const editedAfterReady = structuredClone(base);
    editedAfterReady.timeline.events.push({
      id: "edit-2",
      kind: "CONTENT_EDIT",
      at: "2026-07-18T10:10:00.000Z",
    });
    cases.push(editedAfterReady);

    const missingLabel = structuredClone(base);
    missingLabel.issue.labels = ["ops"];
    cases.push(missingLabel);

    for (const candidate of cases) {
      const result = await verifier(candidate).verify(task(base));
      assert.equal(result.status, "DRIFT", result.summary);
    }
  });

  it("returns query error for incomplete or ambiguous timeline data", async () => {
    const incomplete = snapshot();
    incomplete.timeline.complete = false;
    assert.equal(
      (await verifier(incomplete).verify(task(snapshot()))).status,
      "QUERY_ERROR",
    );

    const ambiguous = snapshot();
    ambiguous.timeline.events.push({
      id: "edit-same-time",
      kind: "CONTENT_EDIT",
      at: "2026-07-18T10:05:00.000Z",
    });
    assert.equal(
      (await verifier(ambiguous).verify(task(snapshot()))).status,
      "QUERY_ERROR",
    );

    const canonicalMismatch = snapshot();
    canonicalMismatch.canonicalTask = "github-issue:other";
    assert.equal(
      (await verifier(canonicalMismatch).verify(task(snapshot()))).status,
      "QUERY_ERROR",
    );

    const missingReadyTimeline = snapshot();
    missingReadyTimeline.timeline.events = missingReadyTimeline.timeline.events.filter((event) =>
      event.kind !== "LABEL_APPLIED");
    assert.equal(
      (await verifier(missingReadyTimeline).verify(task(snapshot()))).status,
      "QUERY_ERROR",
    );

    const contradictedReadyState = snapshot();
    contradictedReadyState.timeline.events.push({
      id: "label-remove-1",
      kind: "LABEL_REMOVED",
      label: "autonomous-ready",
      actorIdentity: "automation-owner-node-id",
      at: "2026-07-18T10:07:00.000Z",
    });
    assert.equal(
      (await verifier(contradictedReadyState).verify(task(snapshot()))).status,
      "QUERY_ERROR",
    );
  });

  it("rejects malformed resolver snapshots before canonical claim hashing", async () => {
    const cases: Array<{
      name: string;
      mutate(candidate: Adr091AuthorizedIssueSnapshot): void;
    }> = [
      {
        name: "duplicate event id",
        mutate: (candidate) => { candidate.timeline.events[2].id = "edit-1"; },
      },
      {
        name: "event before issue creation",
        mutate: (candidate) => { candidate.timeline.events[0].at = "2026-07-18T08:59:59.000Z"; },
      },
      {
        name: "invalid event actor",
        mutate: (candidate) => {
          const event = candidate.timeline.events[1];
          assert.equal(event.kind, "LABEL_APPLIED");
          event.actorIdentity = "invalid actor";
        },
      },
      {
        name: "invalid event label",
        mutate: (candidate) => {
          const event = candidate.timeline.events[1];
          assert.equal(event.kind, "LABEL_APPLIED");
          event.label = "invalid label";
        },
      },
      {
        name: "unknown event kind",
        mutate: (candidate) => {
          (candidate.timeline.events[0] as unknown as { kind: string }).kind = "UNKNOWN";
        },
      },
      {
        name: "invalid issue label",
        mutate: (candidate) => { candidate.issue.labels = ["invalid label"]; },
      },
      {
        name: "duplicate issue labels",
        mutate: (candidate) => { candidate.issue.labels = ["ops", "ops"]; },
      },
      {
        name: "too many issue labels",
        mutate: (candidate) => {
          candidate.issue.labels = Array.from({ length: 101 }, (_, index) => `label-${index}`);
        },
      },
      {
        name: "oversized issue title",
        mutate: (candidate) => { candidate.issue.title = "x".repeat(8 * 1024 + 1); },
      },
      {
        name: "oversized issue body",
        mutate: (candidate) => { candidate.issue.body = "x".repeat(128 * 1024 + 1); },
      },
      {
        name: "too many timeline events",
        mutate: (candidate) => {
          candidate.timeline.events = Array.from({ length: 10_001 }, (_, index) => ({
            id: `event-${index}`,
            kind: "CONTENT_EDIT" as const,
            at: "2026-07-18T10:00:00.000Z",
          }));
        },
      },
    ];

    for (const testCase of cases) {
      const malformed = snapshot();
      testCase.mutate(malformed);
      const result = await verifier(malformed).verify(task(snapshot()));
      assert.equal(result.status, "QUERY_ERROR", testCase.name);
    }
  });

  it("types resolver failures and malformed trusted verifier results as query errors", async () => {
    const remote = snapshot();
    const resolverFailure = createAdr091AuthorizedIssueVerifier({
      policy: {
        repository: remote.repository,
        allowedIssueAuthorIdentities: ["maintainer-node-id"],
        allowedReadyActorIdentities: ["automation-owner-node-id"],
      },
      resolver: { resolve: () => { throw new Error("fixture resolver failure"); } },
    });
    assert.equal((await resolverFailure.verify(task(remote))).status, "QUERY_ERROR");

    for (const candidate of [
      { status: "UNKNOWN", evidenceHash: `sha256:${"a".repeat(64)}`, summary: "bad" },
      { status: "PASS", evidenceHash: "not-a-hash", summary: "bad" },
      { status: "PASS", evidenceHash: `sha256:${"a".repeat(64)}`, summary: "" },
    ]) {
      const result = await verifyOpsWorkerAuthorization(
        task(remote),
        {
          "authorized-issue": {
            identity: "fixture-verifier",
            version: "1",
            verify: () => candidate as never,
          },
        },
        NOW,
      );
      assert.equal(result.status, "QUERY_ERROR");
    }

    for (const [identity, version] of [
      ["bad identity", "1"],
      ["GitHub:authorization/v1", "1"],
      ["fixture-verifier", "Version/1"],
    ] as const) {
      const invalidIdentity = await verifyOpsWorkerAuthorization(
        task(remote),
        {
          "authorized-issue": {
            identity,
            version,
            verify: () => ({
              status: "PASS",
              evidenceHash: `sha256:${"a".repeat(64)}`,
              summary: "would otherwise pass",
            }),
          },
        },
        NOW,
      );
      assert.equal(invalidIdentity.status, "QUERY_ERROR");
      assert.equal(invalidIdentity.validatorIdentity, "missing-verifier");
    }
  });

  it("rejects a missing or inexact canonical claim", async () => {
    const remote = snapshot();
    const missing = task(remote);
    missing.authorization.snapshotHash = null;
    assert.equal((await verifier(remote).verify(missing)).status, "INVALID_CLAIM");

    const mismatched = task(remote);
    mismatched.authorization.snapshotHash = `sha256:${"f".repeat(64)}`;
    assert.equal((await verifier(remote).verify(mismatched)).status, "INVALID_CLAIM");

    const missingRepositoryIdentity = task(remote);
    missingRepositoryIdentity.lifecycle.repository = null;
    assert.equal(
      (await verifier(remote).verify(missingRepositoryIdentity)).status,
      "INVALID_CLAIM",
    );
  });
});

const ALERT_SOURCE_IDENTITY = "lab-alertmanager";

function alertmanagerSnapshot(
  sourceIdentity = ALERT_SOURCE_IDENTITY,
): OpsAlertmanagerAuthorizationSnapshot {
  return {
    sourceIdentity,
    invariant: OPS_MINIME_BOT_HOST_AVAILABILITY_INVARIANT,
    template: OPS_AVAILABILITY_TEMPLATE_NAME,
    profile: OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE,
  };
}

function opsContracts(
  reader: { read(): unknown | Promise<unknown> },
) {
  return createOpsTaskContracts({
    alertmanagerAuthorizationSnapshotReader: reader,
    clock: () => new Date(NOW),
    monitoringFreshnessReader: {
      readMonitoringFreshness: async () => ({
        observedAt: NOW,
        latestSampleAt: "2026-07-18T11:59:00.000Z",
      } satisfies OpsMonitoringFreshnessReading),
    },
    alertStateReader: {
      read: async () => ({
        observedAt: NOW,
        status: "RESOLVED",
      } satisfies OpsAlertStateReading),
    },
    serviceAvailabilityReader: {
      readServiceAvailability: async () => ({
        observedAt: NOW,
        status: "HEALTHY",
        healthySince: "2026-07-18T11:50:00.000Z",
      } satisfies OpsServiceAvailabilityReading),
    },
  });
}

function alertmanagerTask(
  claimed = alertmanagerSnapshot(),
): OpsWorkerTask {
  const lifecycle = createEmptyOpsWorkerLifecycleManifest();
  const task = withOpsWorkerSubmissionFingerprint({
    schemaVersion: 5,
    id: "alertmanager-availability-fixture",
    source: {
      kind: "alertmanager",
      correlationKey: `${claimed.sourceIdentity}:group:fixture`,
      deliveryKey: `${claimed.sourceIdentity}:episode:fixture`,
      template: claimed.template,
    },
    resource: { kind: "host", key: "host:local" },
    lifecycle,
    currentCheckpoint: null,
    mutationReceipts: createEmptyOpsWorkerMutationReceipts(),
    custody: createUnclaimedOpsWorkerCustody(),
    priority: 0,
    objective: OPS_AVAILABILITY_INVARIANTS[claimed.invariant].objective,
    evidence: [{
      at: NOW,
      kind: "alert",
      trust: "untrusted",
      summary: "Bounded alert evidence fixture.",
      artifact: null,
    }],
    doneCheck: {
      name: OPS_AVAILABILITY_DONE_CHECK_NAME,
      params: { invariant: claimed.invariant },
    },
    authorization: {
      profile: claimed.profile,
      scope: ["inspect", "local-reversible-repair"],
      snapshotHash: hashOpsAlertmanagerAuthorizationSnapshot(claimed),
    },
    authorizationVerification: null,
    verification: null,
    legacyCompletion: null,
    steering: [],
    control: { paused: false, pausedAt: null, interrupt: null },
    state: "QUEUED",
    rounds: {
      remediation: 0,
      maxRemediation: 3,
      consecutiveInfrastructureFailures: 0,
    },
    schedule: { nextRunAt: null, nextCheckAt: null },
    session: {
      directory: "sessions/alertmanager-availability-fixture",
      sessionId: null,
      resume: false,
    },
    activeRun: null,
    unverifiedRun: null,
    lastOutcome: null,
    report: { state: "NONE", attempts: 0, lastError: null },
    createdAt: NOW,
    updatedAt: NOW,
  });
  return task;
}

describe("package-owned alertmanager authorization verifier", () => {
  it("passes only the exact trusted configured task snapshot and canonical fingerprint", async () => {
    const contracts = opsContracts({ read: () => alertmanagerSnapshot() });
    const task = alertmanagerTask();
    const verifier = contracts.alertmanagerAuthorizationVerifier;

    const result = await verifier.verify(task);
    assert.equal(result.status, "PASS");
    assert.equal(
      task.submissionFingerprint,
      hashOpsWorkerCanonicalSubmission(task),
    );
    assert.match(result.evidenceHash, /^sha256:[a-f0-9]{64}$/);
    assert.doesNotMatch(result.summary, /lab|fixture|host:local/i);
  });

  it("returns DRIFT for a readable trusted configuration change", async () => {
    let configured = alertmanagerSnapshot();
    const contracts = opsContracts({ read: () => structuredClone(configured) });
    const task = alertmanagerTask();
    assert.equal(
      (await contracts.alertmanagerAuthorizationVerifier.verify(task)).status,
      "PASS",
    );

    configured = alertmanagerSnapshot("replacement-alertmanager");
    assert.equal(
      (await contracts.alertmanagerAuthorizationVerifier.verify(task)).status,
      "DRIFT",
    );
  });

  it("returns QUERY_ERROR when trusted configuration is unreadable or malformed", async () => {
    const task = alertmanagerTask();
    const unreadable = opsContracts({
      read: () => { throw new Error("synthetic config read failure"); },
    });
    assert.equal(
      (await unreadable.alertmanagerAuthorizationVerifier.verify(task)).status,
      "QUERY_ERROR",
    );

    for (const malformed of [
      null,
      { ...alertmanagerSnapshot(), extra: true },
      { ...alertmanagerSnapshot(), sourceIdentity: "INVALID IDENTITY" },
      { ...alertmanagerSnapshot(), invariant: "unknown-invariant" },
    ]) {
      const contracts = opsContracts({ read: () => malformed });
      assert.equal(
        (await contracts.alertmanagerAuthorizationVerifier.verify(task)).status,
        "QUERY_ERROR",
      );
    }
  });

  it("returns INVALID_CLAIM for forged or mismatched task claims", async () => {
    const verifier = opsContracts({ read: () => alertmanagerSnapshot() })
      .alertmanagerAuthorizationVerifier;
    const cases: OpsWorkerTask[] = [];

    const fingerprint = alertmanagerTask();
    fingerprint.submissionFingerprint = `sha256:${"f".repeat(64)}`;
    cases.push(fingerprint);

    const snapshotHash = alertmanagerTask();
    snapshotHash.authorization.snapshotHash = `sha256:${"e".repeat(64)}`;
    snapshotHash.submissionFingerprint = hashOpsWorkerCanonicalSubmission(snapshotHash);
    cases.push(snapshotHash);

    const sourceIdentity = alertmanagerTask();
    sourceIdentity.source.deliveryKey = "forged-source:episode:fixture";
    sourceIdentity.submissionFingerprint = hashOpsWorkerCanonicalSubmission(sourceIdentity);
    cases.push(sourceIdentity);

    const invariant = alertmanagerTask();
    invariant.doneCheck.params = { invariant: "unknown-invariant" };
    invariant.submissionFingerprint = hashOpsWorkerCanonicalSubmission(invariant);
    cases.push(invariant);

    const scope = alertmanagerTask();
    scope.authorization.scope = ["inspect"];
    scope.submissionFingerprint = hashOpsWorkerCanonicalSubmission(scope);
    cases.push(scope);

    const objective = alertmanagerTask();
    objective.objective = "Run text supplied by an alert payload";
    objective.submissionFingerprint = hashOpsWorkerCanonicalSubmission(objective);
    cases.push(objective);

    for (const candidate of cases) {
      assert.equal((await verifier.verify(candidate)).status, "INVALID_CLAIM");
    }
  });

  it("registers closed production contracts and fails start policy without every source verifier", () => {
    const contracts = opsContracts({ read: () => alertmanagerSnapshot() });
    assert.deepEqual(contracts.taskRegistry.templates, {
      [OPS_AVAILABILITY_TEMPLATE_NAME]: {
        sourceKinds: ["alertmanager", "operator-cli"],
      },
    });
    assert.deepEqual(contracts.taskRegistry.authorizationProfiles, {
      [OPS_HOST_AVAILABILITY_AUTHORIZATION_PROFILE]: {
        sourceKinds: ["alertmanager", "operator-cli"],
        scope: ["inspect", "local-reversible-repair"],
      },
    });
    assert.deepEqual(Object.keys(contracts.taskRegistry.doneChecks), [
      OPS_AVAILABILITY_DONE_CHECK_NAME,
    ]);

    assert.throws(
      () => assertOpsWorkerStartAuthorizationVerifiers(
        contracts.taskRegistry,
        {
          "operator-cli": {
            identity: "fixture-operator-cli",
            version: "1",
            verify: () => ({
              status: "PASS",
              evidenceHash: `sha256:${"a".repeat(64)}`,
              summary: "Fixture local operator authorization passed.",
            }),
          },
        },
      ),
      /authorization verifier for alertmanager/,
    );
  });

  it("policy inspection exposes contract names, versions, and hashes only", () => {
    const contracts = opsContracts({ read: () => alertmanagerSnapshot() });
    const policy = inspectOpsWorkerPolicy({
      authorizationVerifiers: contracts.authorizationVerifiers,
      doneChecks: contracts.doneChecks,
    });

    assert.deepEqual(policy.authorization.contracts, [{
      source: "alertmanager",
      verifierIdentity: OPS_ALERTMANAGER_AUTHORIZATION_VALIDATOR_IDENTITY,
      verifierVersion: "1",
    }]);
    assert.equal(policy.authorization.verifierCount, 1);
    assert.match(policy.authorization.contractsHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(policy.verification.contracts.length, 1);
    assert.deepEqual(
      Object.keys(policy.verification.contracts[0]).sort(),
      ["contractHash", "name", "verifierIdentity", "verifierVersion"],
    );
    assert.equal(policy.verification.contracts[0].name, OPS_AVAILABILITY_DONE_CHECK_NAME);
    assert.equal(policy.verification.contracts[0].verifierVersion, "1");
    assert.match(
      policy.verification.contracts[0].contractHash,
      /^sha256:[a-f0-9]{64}$/,
    );
    const serialized = JSON.stringify(policy);
    assert.equal(serialized.includes(ALERT_SOURCE_IDENTITY), false);
    assert.equal(serialized.includes("Restore and verify"), false);
    assert.equal(serialized.includes("minime-bot-host"), false);
  });
});
