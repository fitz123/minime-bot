export class OpsWorkerConversationPreemptionError extends Error {
  constructor() {
    super("Conversational Ops process group could not be proven reaped");
    this.name = "OpsWorkerConversationPreemptionError";
  }
}

export interface OpsWorkerConversationLaneOptions {
  blocksAdmission: () => boolean;
  abortConversation: () => Promise<boolean>;
}

interface ActiveConversation {
  controller: AbortController;
  done: Promise<unknown>;
}

/**
 * One in-memory, queue-free conversation slot shared by the Telegram poller
 * and incident scheduler. Incident execution closes admission synchronously
 * and cannot begin until any conversational process group is proven reaped.
 */
export class OpsWorkerConversationLane {
  private readonly blocksAdmission: () => boolean;
  private readonly abortConversation: () => Promise<boolean>;
  private active: ActiveConversation | null = null;
  private incidentRunning = false;
  private closed = false;

  constructor(options: OpsWorkerConversationLaneOptions) {
    this.blocksAdmission = options.blocksAdmission;
    this.abortConversation = options.abortConversation;
  }

  tryStart<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> | null {
    if (
      this.closed
      || this.incidentRunning
      || this.active !== null
      || this.isAdmissionBlocked()
    ) return null;

    const controller = new AbortController();
    let done!: Promise<T>;
    done = Promise.resolve()
      .then(() => work(controller.signal))
      .finally(() => {
        if (this.active?.done === done) this.active = null;
      });
    this.active = { controller, done };
    return done;
  }

  async runIncident<T>(work: () => Promise<T>): Promise<T> {
    this.incidentRunning = true;
    try {
      await this.preemptActive();
      return await work();
    } finally {
      this.incidentRunning = false;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.preemptActive();
  }

  private isAdmissionBlocked(): boolean {
    try {
      return this.blocksAdmission();
    } catch {
      return true;
    }
  }

  private async preemptActive(): Promise<void> {
    const active = this.active;
    if (active === null) return;
    active.controller.abort();
    const reaped = await this.abortConversation();
    await active.done.catch(() => undefined);
    if (!reaped) throw new OpsWorkerConversationPreemptionError();
  }
}
