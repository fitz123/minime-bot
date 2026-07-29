import type { OpsWorkerPolicySnapshot } from "./status-server.js";
import {
  getOpsWorkerReportReconciliationOperation,
  isOpsWorkerReportReconciliationBlocked,
  isOpsWorkerUnresolvedOrphan,
  type OpsWorkerReportReconciliationOperation,
} from "./supervisor.js";
import {
  OPS_WORKER_TASK_STATES,
  type OpsWorkerTask,
  type OpsWorkerTaskState,
} from "./types.js";
import type { OpsWorkerFieldRedactor } from "./reporting.js";

export const OPS_WORKER_CONVERSATION_VIEW_LIMITS = Object.freeze({
  currentTasks: 12,
  recentHistory: 8,
  recentAlerts: 8,
  alertDataPerTask: 4,
  recentReports: 8,
  blockers: 8,
  requestedInputs: 8,
  objectiveBytes: 1_024,
  summaryBytes: 1_024,
  actionBytes: 512,
  actions: 8,
  requestedInputBytes: 1_024,
  verificationSummaryBytes: 512,
  verificationComponents: 8,
  alertDataBytes: 1_024,
  reportErrorBytes: 512,
});

/**
 * Leaves room inside the runner's 128 KiB prompt ceiling for the maximum
 * operator input, one clarification, and JSON framing.
 */
export const OPS_WORKER_CONVERSATION_SNAPSHOT_MAX_BYTES = 80 * 1024;

export interface OpsWorkerBoundedView<T> {
  total: number;
  omitted: number;
  items: T[];
}

export interface OpsWorkerTaskVerificationView {
  outcome: NonNullable<OpsWorkerTask["verification"]>["outcome"];
  checkedAt: string;
  summary: string;
  nextCheckAt: string | null;
  components: OpsWorkerBoundedView<{
    identity: string;
    outcome: NonNullable<OpsWorkerTask["verification"]>["components"][number]["outcome"];
    observedAt: string;
    summary: string;
    nextCheckAt: string | null;
  }>;
}

export interface OpsWorkerTaskView {
  id: string;
  state: OpsWorkerTaskState;
  objective: string;
  source: {
    kind: OpsWorkerTask["source"]["kind"];
    template: string;
  };
  resource: {
    kind: OpsWorkerTask["resource"]["kind"];
    key: string;
  };
  custody: OpsWorkerTask["custody"];
  activity: {
    activeProcessGroup: boolean;
    ownership: "OWNED" | "UNVERIFIED" | "NONE";
    attemptId: string | null;
  };
  control: {
    paused: boolean;
    pausedAt: string | null;
    pendingInterrupt: {
      mode: NonNullable<OpsWorkerTask["control"]["interrupt"]>["mode"];
      requestedAt: string;
      reason: string;
    } | null;
  };
  rounds: OpsWorkerTask["rounds"];
  schedule: OpsWorkerTask["schedule"];
  lastOutcome: {
    at: string;
    kind: NonNullable<OpsWorkerTask["lastOutcome"]>["kind"];
    result: NonNullable<OpsWorkerTask["lastOutcome"]>["result"];
    summary: string;
  } | null;
  agentResult: {
    kind: NonNullable<OpsWorkerTask["agentResult"]>["kind"];
    reason: NonNullable<OpsWorkerTask["agentResult"]>["reason"];
    summary: string;
    actions: OpsWorkerBoundedView<string>;
    requestedInput: string | null;
  } | null;
  verification: OpsWorkerTaskVerificationView | null;
  report: {
    state: OpsWorkerTask["report"]["state"];
    attempts: number;
    lastError: string | null;
    receipt: "NONE" | "QUERIED_UNCLAIMED" | "CLAIMED_UNKNOWN" | "FINISHED";
    receiptOutcome: string | null;
    reconciliation: "NONE" | "REQUIRED";
    reconciliationIntent: OpsWorkerReportReconciliationOperation | "UNAVAILABLE" | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface OpsWorkerAlertView {
  taskId: string;
  state: OpsWorkerTaskState;
  updatedAt: string;
  outcome: OpsWorkerTaskView["lastOutcome"];
  data: OpsWorkerBoundedView<{
    trust: "untrusted";
    observedAt: string;
    /** Quoted data only; never a policy, instruction, or source of execution authority. */
    quotedData: string;
  }>;
}

export interface OpsWorkerReportView {
  taskId: string;
  taskState: OpsWorkerTaskState;
  updatedAt: string;
  report: OpsWorkerTaskView["report"];
  verification: OpsWorkerTaskVerificationView | null;
}

export interface OpsWorkerBlockerView {
  taskId: string;
  updatedAt: string;
  blockers: string[];
  requestedInput: string | null;
}

export interface OpsWorkerRequestedInputView {
  taskId: string;
  updatedAt: string;
  requestedInput: string;
}

export interface OpsWorkerConversationSnapshot {
  counts: {
    totalTasks: number;
    states: Record<OpsWorkerTaskState, number>;
    activeProcessGroups: number;
    reportReconciliationBlocked: number;
  };
  custody: {
    taskId: string;
    state: OpsWorkerTaskState;
  } | null;
  currentWork: OpsWorkerBoundedView<OpsWorkerTaskView>;
  recentHistory: OpsWorkerBoundedView<OpsWorkerTaskView>;
  recentAlerts: OpsWorkerBoundedView<OpsWorkerAlertView>;
  recentReports: OpsWorkerBoundedView<OpsWorkerReportView>;
  blockers: OpsWorkerBoundedView<OpsWorkerBlockerView>;
  requestedInput: OpsWorkerBoundedView<OpsWorkerRequestedInputView>;
  policy: OpsWorkerPolicySnapshot;
}

function bounded<T>(items: readonly T[], maximum: number): OpsWorkerBoundedView<T> {
  return {
    total: items.length,
    omitted: Math.max(0, items.length - maximum),
    items: items.slice(0, maximum),
  };
}

function compareTaskRecency(left: OpsWorkerTask, right: OpsWorkerTask): number {
  const updated = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  return updated === 0 ? left.id.localeCompare(right.id) : updated;
}

function copyPolicy(policy: OpsWorkerPolicySnapshot): OpsWorkerPolicySnapshot {
  return {
    authorization: {
      configuredSources: [...policy.authorization.configuredSources].sort(),
      verifierCount: policy.authorization.verifierCount,
      contractsHash: policy.authorization.contractsHash,
      contracts: policy.authorization.contracts
        .map((contract) => ({ ...contract }))
        .sort((left, right) =>
          left.source.localeCompare(right.source)
          || left.verifierIdentity.localeCompare(right.verifierIdentity)
          || left.verifierVersion.localeCompare(right.verifierVersion)),
    },
    verification: {
      verifierCount: policy.verification.verifierCount,
      contractsHash: policy.verification.contractsHash,
      contracts: policy.verification.contracts
        .map((contract) => ({ ...contract }))
        .sort((left, right) =>
          left.name.localeCompare(right.name)
          || left.verifierIdentity.localeCompare(right.verifierIdentity)
          || left.verifierVersion.localeCompare(right.verifierVersion)),
    },
    quota: policy.quota.configured
      ? { ...policy.quota, activeWindows: [...policy.quota.activeWindows].sort() }
      : { configured: false },
    parity: policy.parity.configured
      ? { ...policy.parity }
      : { configured: false },
  };
}

function reportReceiptView(task: Readonly<OpsWorkerTask>): {
  receipt: OpsWorkerTaskView["report"]["receipt"];
  receiptOutcome: string | null;
} {
  const receipt = task.mutationReceipts.report;
  if (receipt === null) return { receipt: "NONE", receiptOutcome: null };
  if (receipt.outcome !== null) {
    return { receipt: "FINISHED", receiptOutcome: receipt.outcome.result };
  }
  return receipt.mutationStartedAt === null
    ? { receipt: "QUERIED_UNCLAIMED", receiptOutcome: null }
    : { receipt: "CLAIMED_UNKNOWN", receiptOutcome: null };
}

export function buildOpsWorkerTaskView(
  task: Readonly<OpsWorkerTask>,
  redact: OpsWorkerFieldRedactor,
  options: {
    includeReconciliationIntent?: boolean;
  } = {},
): OpsWorkerTaskView {
  const receipt = reportReceiptView(task);
  const reconciliation = isOpsWorkerReportReconciliationBlocked(task);
  const reconciliationOperation = getOpsWorkerReportReconciliationOperation(task);
  const active = task.activeRun ?? task.unverifiedRun;
  const actions = task.agentResult?.actions.map((action) =>
    redact(action, OPS_WORKER_CONVERSATION_VIEW_LIMITS.actionBytes)) ?? [];
  const components = task.verification?.components.map((component) => ({
    identity: component.identity,
    outcome: component.outcome,
    observedAt: component.observedAt,
    summary: redact(
      component.summary,
      OPS_WORKER_CONVERSATION_VIEW_LIMITS.verificationSummaryBytes,
    ),
    nextCheckAt: component.nextCheckAt,
  })) ?? [];
  return {
    id: task.id,
    state: task.state,
    objective: redact(
      task.objective,
      OPS_WORKER_CONVERSATION_VIEW_LIMITS.objectiveBytes,
    ),
    source: {
      kind: task.source.kind,
      template: task.source.template,
    },
    resource: {
      kind: task.resource.kind,
      key: redact(task.resource.key, OPS_WORKER_CONVERSATION_VIEW_LIMITS.summaryBytes),
    },
    custody: { ...task.custody },
    activity: {
      activeProcessGroup: task.activeRun !== null || task.unverifiedRun !== null,
      ownership: task.activeRun !== null
        ? "OWNED"
        : task.unverifiedRun !== null
        ? "UNVERIFIED"
        : "NONE",
      attemptId: active?.attemptId ?? null,
    },
    control: {
      paused: task.control.paused,
      pausedAt: task.control.pausedAt,
      pendingInterrupt: task.control.interrupt === null
        ? null
        : {
            mode: task.control.interrupt.mode,
            requestedAt: task.control.interrupt.requestedAt,
            reason: redact(
              task.control.interrupt.reason,
              OPS_WORKER_CONVERSATION_VIEW_LIMITS.summaryBytes,
            ),
          },
    },
    rounds: { ...task.rounds },
    schedule: { ...task.schedule },
    lastOutcome: task.lastOutcome === null
      ? null
      : {
          at: task.lastOutcome.at,
          kind: task.lastOutcome.kind,
          result: task.lastOutcome.result,
          summary: redact(
            task.lastOutcome.summary,
            OPS_WORKER_CONVERSATION_VIEW_LIMITS.summaryBytes,
          ),
        },
    agentResult: task.agentResult === null
      ? null
      : {
          kind: task.agentResult.kind,
          reason: task.agentResult.reason,
          summary: redact(
            task.agentResult.summary,
            OPS_WORKER_CONVERSATION_VIEW_LIMITS.summaryBytes,
          ),
          actions: bounded(actions, OPS_WORKER_CONVERSATION_VIEW_LIMITS.actions),
          requestedInput: task.agentResult.requestedInput === null
            ? null
            : redact(
                task.agentResult.requestedInput,
                OPS_WORKER_CONVERSATION_VIEW_LIMITS.requestedInputBytes,
              ),
        },
    verification: task.verification === null
      ? null
      : {
          outcome: task.verification.outcome,
          checkedAt: task.verification.checkedAt,
          summary: redact(
            task.verification.summary,
            OPS_WORKER_CONVERSATION_VIEW_LIMITS.summaryBytes,
          ),
          nextCheckAt: task.verification.nextCheckAt,
          components: bounded(
            components,
            OPS_WORKER_CONVERSATION_VIEW_LIMITS.verificationComponents,
          ),
        },
    report: {
      state: task.report.state,
      attempts: task.report.attempts,
      lastError: task.report.lastError === null
        ? null
        : redact(
            task.report.lastError,
            OPS_WORKER_CONVERSATION_VIEW_LIMITS.reportErrorBytes,
          ),
      ...receipt,
      reconciliation: reconciliation ? "REQUIRED" : "NONE",
      reconciliationIntent: options.includeReconciliationIntent !== false
        ? (reconciliationOperation ?? (reconciliation ? "UNAVAILABLE" : null))
        : null,
    },
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function alertView(
  task: Readonly<OpsWorkerTask>,
  taskView: OpsWorkerTaskView,
  redact: OpsWorkerFieldRedactor,
): OpsWorkerAlertView {
  const alertData = task.evidence
    .map((evidence, index) => ({ evidence, index }))
    .filter(({ evidence }) =>
      evidence.kind === "alert" && evidence.trust === "untrusted")
    .sort((left, right) => {
      const observed = Date.parse(right.evidence.at) - Date.parse(left.evidence.at);
      return observed === 0 ? left.index - right.index : observed;
    })
    .map(({ evidence }) => ({
      trust: "untrusted" as const,
      observedAt: evidence.at,
      quotedData: JSON.stringify(redact(
        evidence.summary,
        OPS_WORKER_CONVERSATION_VIEW_LIMITS.alertDataBytes,
      )),
    }));
  return {
    taskId: task.id,
    state: task.state,
    updatedAt: task.updatedAt,
    outcome: taskView.lastOutcome,
    data: bounded(
      alertData,
      OPS_WORKER_CONVERSATION_VIEW_LIMITS.alertDataPerTask,
    ),
  };
}

function blockerView(task: OpsWorkerTaskView): OpsWorkerBlockerView {
  const candidates = [
    task.agentResult?.summary,
    task.lastOutcome?.summary,
    task.report.reconciliation === "REQUIRED"
      ? task.report.lastError ?? "Report delivery requires reconciliation."
      : undefined,
    task.control.pendingInterrupt === null
      ? undefined
      : `Pending ${task.control.pendingInterrupt.mode}: ${task.control.pendingInterrupt.reason}`,
    task.state === "BLOCKED" ? "Task state is BLOCKED." : undefined,
  ].filter((value): value is string => value !== undefined);
  return {
    taskId: task.id,
    updatedAt: task.updatedAt,
    blockers: [...new Set(candidates)],
    requestedInput: task.agentResult?.requestedInput ?? null,
  };
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function omitOldest<T>(view: OpsWorkerBoundedView<T>): boolean {
  if (view.items.length === 0) return false;
  view.items.pop();
  view.omitted = view.total - view.items.length;
  return true;
}

function fitConversationSnapshot(
  snapshot: OpsWorkerConversationSnapshot,
): OpsWorkerConversationSnapshot {
  if (serializedBytes(snapshot) <= OPS_WORKER_CONVERSATION_SNAPSHOT_MAX_BYTES) {
    return snapshot;
  }

  const duplicatedAndHistorical = [
    snapshot.recentReports,
    snapshot.blockers,
    snapshot.requestedInput,
    snapshot.recentAlerts,
    snapshot.recentHistory,
  ] as OpsWorkerBoundedView<unknown>[];
  const allViews = [
    ...duplicatedAndHistorical,
    snapshot.currentWork,
  ] as OpsWorkerBoundedView<unknown>[];

  let changed = true;
  while (
    serializedBytes(snapshot) > OPS_WORKER_CONVERSATION_SNAPSHOT_MAX_BYTES
    && changed
  ) {
    changed = false;
    for (const view of allViews) {
      if (view.items.length <= 1) continue;
      changed = omitOldest(view) || changed;
      if (
        serializedBytes(snapshot)
        <= OPS_WORKER_CONVERSATION_SNAPSHOT_MAX_BYTES
      ) return snapshot;
    }
  }

  changed = true;
  while (
    serializedBytes(snapshot) > OPS_WORKER_CONVERSATION_SNAPSHOT_MAX_BYTES
    && changed
  ) {
    changed = false;
    for (const view of allViews) {
      changed = omitOldest(view) || changed;
      if (
        serializedBytes(snapshot)
        <= OPS_WORKER_CONVERSATION_SNAPSHOT_MAX_BYTES
      ) return snapshot;
    }
  }

  if (serializedBytes(snapshot) > OPS_WORKER_CONVERSATION_SNAPSHOT_MAX_BYTES) {
    throw new Error("Ops-worker conversation snapshot cannot fit its byte budget");
  }
  return snapshot;
}

export function buildOpsWorkerConversationSnapshot(
  tasks: readonly OpsWorkerTask[],
  policy: OpsWorkerPolicySnapshot,
  options: {
    redact: OpsWorkerFieldRedactor;
  },
): OpsWorkerConversationSnapshot {
  const sorted = [...tasks].sort(compareTaskRecency);
  const taskViews = new Map(
    sorted.map((task) => [
      task.id,
      buildOpsWorkerTaskView(task, options.redact, {
        includeReconciliationIntent: false,
      }),
    ]),
  );
  const states = Object.fromEntries(
    OPS_WORKER_TASK_STATES.map((state) => [state, 0]),
  ) as Record<OpsWorkerTaskState, number>;
  for (const task of sorted) states[task.state] += 1;
  const custodyOwners = sorted.filter((task) => task.custody.status === "HELD");
  if (custodyOwners.length > 1) {
    throw new Error("Ops-worker conversation view found multiple held custody owners");
  }
  const currentWork = sorted
    .filter((task) => task.state !== "DONE" && task.state !== "CANCELLED")
    .map((task) => taskViews.get(task.id) as OpsWorkerTaskView);
  const recentHistory = sorted
    .filter((task) => task.state === "DONE" || task.state === "CANCELLED")
    .map((task) => taskViews.get(task.id) as OpsWorkerTaskView);
  const recentAlerts = sorted
    .filter((task) => task.source.kind === "alertmanager")
    .map((task) =>
      alertView(
        task,
        taskViews.get(task.id) as OpsWorkerTaskView,
        options.redact,
      ));
  const recentReports = sorted
    .filter((task) => task.report.state !== "NONE")
    .map((task) => {
      const view = taskViews.get(task.id) as OpsWorkerTaskView;
      return {
        taskId: task.id,
        taskState: task.state,
        updatedAt: task.updatedAt,
        report: view.report,
        verification: view.verification,
      };
    });
  const blockers = currentWork
    .filter((task) =>
      task.state === "BLOCKED"
      || task.report.reconciliation === "REQUIRED"
      || task.control.pendingInterrupt !== null)
    .map(blockerView);
  const requestedInput = currentWork
    .filter((task) => task.agentResult?.requestedInput !== null
      && task.agentResult?.requestedInput !== undefined)
    .map((task) => ({
      taskId: task.id,
      updatedAt: task.updatedAt,
      requestedInput: task.agentResult?.requestedInput as string,
    }));
  return fitConversationSnapshot({
    counts: {
      totalTasks: sorted.length,
      states,
      activeProcessGroups: sorted.filter((task) =>
        task.state === "RUNNING" || isOpsWorkerUnresolvedOrphan(task)).length,
      reportReconciliationBlocked: sorted.filter(
        isOpsWorkerReportReconciliationBlocked,
      ).length,
    },
    custody: custodyOwners[0]
      ? { taskId: custodyOwners[0].id, state: custodyOwners[0].state }
      : null,
    currentWork: bounded(
      currentWork,
      OPS_WORKER_CONVERSATION_VIEW_LIMITS.currentTasks,
    ),
    recentHistory: bounded(
      recentHistory,
      OPS_WORKER_CONVERSATION_VIEW_LIMITS.recentHistory,
    ),
    recentAlerts: bounded(
      recentAlerts,
      OPS_WORKER_CONVERSATION_VIEW_LIMITS.recentAlerts,
    ),
    recentReports: bounded(
      recentReports,
      OPS_WORKER_CONVERSATION_VIEW_LIMITS.recentReports,
    ),
    blockers: bounded(
      blockers,
      OPS_WORKER_CONVERSATION_VIEW_LIMITS.blockers,
    ),
    requestedInput: bounded(
      requestedInput,
      OPS_WORKER_CONVERSATION_VIEW_LIMITS.requestedInputs,
    ),
    policy: copyPolicy(policy),
  });
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm;
}

export function renderOpsWorkerStatusNarrative(
  snapshot: Readonly<OpsWorkerConversationSnapshot>,
): string {
  const states = OPS_WORKER_TASK_STATES
    .map((state) => `${state} ${snapshot.counts.states[state]}`)
    .join(", ");
  const quota = snapshot.policy.quota.configured
    ? `${snapshot.policy.quota.status} (${snapshot.policy.quota.reason})`
    : "not configured";
  return [
    "Ops worker status",
    `Tasks: ${snapshot.counts.totalTasks} total; ${states}.`,
    `Activity: ${snapshot.counts.activeProcessGroups} active process ${plural(snapshot.counts.activeProcessGroups, "group")}.`,
    `Custody: ${snapshot.custody === null
      ? "none"
      : `${snapshot.custody.taskId} (${snapshot.custody.state})`}.`,
    `Report reconciliation: ${snapshot.counts.reportReconciliationBlocked} blocked.`,
    `Authorization policy: ${snapshot.policy.authorization.verifierCount} ${plural(snapshot.policy.authorization.verifierCount, "verifier")}; contract ${snapshot.policy.authorization.contractsHash}.`,
    `Verification policy: ${snapshot.policy.verification.verifierCount} ${plural(snapshot.policy.verification.verifierCount, "verifier")}; contract ${snapshot.policy.verification.contractsHash}.`,
    `Quota: ${quota}.`,
    `Runtime parity: ${snapshot.policy.parity.configured ? "configured" : "not configured"}.`,
  ].join("\n");
}

function taskListLine(task: Readonly<OpsWorkerTaskView>): string {
  const flags = [
    task.control.paused ? "paused" : null,
    task.custody.status === "HELD" ? "holds custody" : null,
    task.activity.activeProcessGroup ? "active process group" : null,
  ].filter((value): value is string => value !== null);
  return `- ${task.id}: ${task.state}; updated ${task.updatedAt}${flags.length > 0
    ? `; ${flags.join(", ")}`
    : ""}.`;
}

export function renderOpsWorkerTasksNarrative(
  snapshot: Readonly<OpsWorkerConversationSnapshot>,
): string {
  if (snapshot.counts.totalTasks === 0) return "There are no Ops worker tasks.";
  const lines = ["Ops worker tasks, newest activity first"];
  if (snapshot.currentWork.total === 0) {
    lines.push("Current work: none.");
  } else {
    lines.push(`Current work (${snapshot.currentWork.total}):`);
    lines.push(...snapshot.currentWork.items.map(taskListLine));
    if (snapshot.currentWork.omitted > 0) {
      lines.push(`- ${snapshot.currentWork.omitted} older current ${plural(snapshot.currentWork.omitted, "task")} omitted.`);
    }
  }
  if (snapshot.recentHistory.total === 0) {
    lines.push("Recent history: none.");
  } else {
    lines.push(`Recent history (${snapshot.recentHistory.total}):`);
    lines.push(...snapshot.recentHistory.items.map(taskListLine));
    if (snapshot.recentHistory.omitted > 0) {
      lines.push(`- ${snapshot.recentHistory.omitted} older terminal ${plural(snapshot.recentHistory.omitted, "task")} omitted.`);
    }
  }
  return lines.join("\n");
}

function none(value: string | null): string {
  return value ?? "none";
}

export function renderOpsWorkerTaskNarrative(
  task: Readonly<OpsWorkerTaskView>,
): string {
  const lines = [
    `Task ${task.id}`,
    `State: ${task.state}. Paused: ${task.control.paused ? "yes" : "no"}.`,
    `Objective: ${task.objective}`,
    `Source: ${task.source.kind} / ${task.source.template}.`,
    `Resource: ${task.resource.kind} / ${task.resource.key}.`,
    `Custody: ${task.custody.status}; claimed at ${none(task.custody.claimedAt)}; released at ${none(task.custody.releasedAt)}; release reason ${none(task.custody.releaseReason)}.`,
    `Activity: ${task.activity.ownership}; active process group ${task.activity.activeProcessGroup ? "yes" : "no"}; attempt ${none(task.activity.attemptId)}.`,
    `Schedule: next run ${none(task.schedule.nextRunAt)}; next check ${none(task.schedule.nextCheckAt)}.`,
    `Rounds: remediation ${task.rounds.remediation}/${task.rounds.maxRemediation}; consecutive infrastructure failures ${task.rounds.consecutiveInfrastructureFailures}.`,
  ];
  if (task.control.pendingInterrupt !== null) {
    lines.push(
      `Pending interrupt: ${task.control.pendingInterrupt.mode} requested at ${task.control.pendingInterrupt.requestedAt}; reason: ${task.control.pendingInterrupt.reason}`,
    );
  }
  lines.push(task.lastOutcome === null
    ? "Latest outcome: none."
    : `Latest outcome: ${task.lastOutcome.kind}/${task.lastOutcome.result} at ${task.lastOutcome.at}; ${task.lastOutcome.summary}`);
  if (task.agentResult === null) {
    lines.push("Agent result: none.");
  } else {
    lines.push(
      `Agent result: ${task.agentResult.kind}; reason ${none(task.agentResult.reason)}; ${task.agentResult.summary}`,
    );
    lines.push(task.agentResult.actions.total === 0
      ? "Actions: none."
      : `Actions (${task.agentResult.actions.total}): ${task.agentResult.actions.items.join(" | ")}${task.agentResult.actions.omitted > 0
        ? ` | ${task.agentResult.actions.omitted} omitted`
        : ""}`);
    lines.push(`Requested input: ${none(task.agentResult.requestedInput)}.`);
  }
  if (task.verification === null) {
    lines.push("Verification: not run.");
  } else {
    lines.push(
      `Verification: ${task.verification.outcome} at ${task.verification.checkedAt}; next check ${none(task.verification.nextCheckAt)}; ${task.verification.summary}`,
    );
    lines.push(task.verification.components.total === 0
      ? "Verification components: none."
      : `Verification components (${task.verification.components.total}): ${task.verification.components.items.map((component) =>
        `${component.identity}/${component.outcome} at ${component.observedAt}: ${component.summary}`).join(" | ")}${task.verification.components.omitted > 0
        ? ` | ${task.verification.components.omitted} omitted`
        : ""}`);
  }
  lines.push(
    `Report: ${task.report.state}; attempts ${task.report.attempts}; last error ${none(task.report.lastError)}.`,
    `Report receipt: ${task.report.receipt}${task.report.receiptOutcome === null
      ? ""
      : `/${task.report.receiptOutcome}`}.`,
    `Report reconciliation: ${task.report.reconciliation}.`,
  );
  if (task.report.reconciliationIntent !== null) {
    lines.push(`Report reconciliation intent (exact JSON): ${task.report.reconciliationIntent === "UNAVAILABLE"
      ? "unavailable"
      : JSON.stringify(task.report.reconciliationIntent)}`);
  }
  lines.push(`Created: ${task.createdAt}. Updated: ${task.updatedAt}.`);
  return lines.join("\n");
}
