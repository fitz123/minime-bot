import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  NewlineOnlyJsonlSplitter, parsePiStartupIdentityRecord, assertPiSessionIdentityMatchesBinding,
  parsePiRecord, handlePiExtensionUiRecord, type PiRpcParseState,
} from './pi-rpc-protocol.js';
import type { InteractiveSessionBinding } from './interactive-session-binding.js';
import type { StreamLine } from './types.js';
import { AgentRuntimeError } from './agent-runtime-protocol.js';

/** One stdout owner for the whole child lifetime, including startup and side replies. */
export class AgentRuntimePi {
  readonly ready: Promise<void>;
  private startup?: { id: string; resolve(): void; reject(error: Error): void };
  private active?: { state: PiRpcParseState; event(line: StreamLine): void; resolve(): void; reject(error: Error): void };
  private stopped?: Promise<void>;
  private failure?: Error;
  private readonly exited: Promise<void>;

  constructor(readonly child: ChildProcess, binding: InteractiveSessionBinding, startupTimeoutMs: number,
    expected: { model: string; thinking: string }) {
    const splitter = new NewlineOnlyJsonlSplitter();
    this.exited = new Promise(resolve => child.once('close', resolve));
    this.ready = new Promise((resolve, reject) => { this.startup = { id: randomUUID(), resolve, reject }; });
    const timer = setTimeout(() => this.fail(new AgentRuntimeError('startup_timeout', 'Pi startup identity deadline exceeded')), startupTimeoutMs);
    // Attach both branches so a fast spawn failure cannot become an unhandled rejection.
    void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    child.stderr?.resume(); // Consume privately; do not expose diagnostics/paths over IPC.
    child.on('error', () => this.fail(new AgentRuntimeError('pi_exit', 'Pi could not start')));
    child.stdin?.on('error', () => this.fail(new AgentRuntimeError('pi_exit', 'Pi input closed')));
    child.once('close', () => this.fail(new AgentRuntimeError('pi_exit', 'Pi exited before the lane closed')));
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        for (const record of splitter.push(chunk)) {
          if (this.startup) {
            const identity = parsePiStartupIdentityRecord(child, record, this.startup.id);
            if (identity) {
              assertPiSessionIdentityMatchesBinding(binding, identity);
              const data = JSON.parse(record).data;
              if (`${data?.model?.provider}/${data?.model?.id}` !== expected.model || data?.thinkingLevel !== expected.thinking) {
                throw new AgentRuntimeError('model_mismatch', 'Pi did not open the explicit model/thinking selection');
              }
              this.startup.resolve();
              this.startup = undefined;
            }
            continue;
          }
          if (handlePiExtensionUiRecord(child, record) === 'blocking') throw new AgentRuntimeError('unsupported_ui', 'Blocking Pi UI is unsupported');
          const active = this.active;
          if (!active) continue;
          const line = parsePiRecord(record, active.state);
          if (line) active.event(line);
          if (line?.type === 'result') {
            this.active = undefined;
            active.resolve();
          }
        }
      } catch (error) {
        this.fail(error instanceof AgentRuntimeError ? error : new AgentRuntimeError('pi_protocol', 'Invalid or unsupported Pi output'));
      }
    });
    this.write({ type: 'get_state', id: this.startup!.id });
  }

  prompt(requestId: string, text: string, event: (line: StreamLine) => void): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.active || this.startup) return Promise.reject(new AgentRuntimeError('busy', 'Pi lane is busy'));
    return new Promise((resolve, reject) => {
      this.active = { state: { expectedPromptId: requestId }, event, resolve, reject };
      this.write({ type: 'prompt', id: requestId, message: text });
    });
  }

  private write(command: object): void {
    if (!this.child.stdin?.writable) { this.fail(new AgentRuntimeError('pi_exit', 'Pi input unavailable')); return; }
    this.child.stdin.write(JSON.stringify(command) + '\n');
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.startup?.reject(error);
    this.startup = undefined;
    this.active?.reject(error);
    this.active = undefined;
  }

  /** Pi 1.5.0 SIGTERM cleans active tracked tools; completed detached jobs are unowned. */
  stop(): Promise<void> {
    return this.stopped ??= this.stopOwnedChild();
  }
  private async stopOwnedChild(): Promise<void> {
    this.fail(new AgentRuntimeError('interrupted', 'Pi lane interrupted; outcome may be partial'));
    const signal = (name: NodeJS.Signals) => {
      if (!this.child.pid) return;
      try { process.kill(-this.child.pid, name); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e; }
    };
    signal('SIGTERM');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      this.exited.then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 2_000); }),
    ]);
    clearTimeout(timer);
    if (!closed) {
      signal('SIGKILL');
      const reaped = await Promise.race([
        this.exited.then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 1_000); }),
      ]);
      clearTimeout(timer);
      if (!reaped) throw new AgentRuntimeError('cleanup_timeout', 'Pi child did not exit within cleanup deadline');
    }
  }
}
