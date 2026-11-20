#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAgentRuntimeDescriptor } from './agent-runtime-descriptor.js';

/** Inert on import. The parent provisions and launches this entrypoint manually. */
export async function agentRuntimeMain(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log('Usage: minime-agent-runtime --descriptor /absolute/readonly-descriptor.json');
    return;
  }
  if (args.length !== 2 || args[0] !== '--descriptor') throw new Error('Expected --descriptor /absolute/readonly-descriptor.json');
  const { AgentRuntimeWorker } = await import('./agent-runtime-worker.js');
  const worker = new AgentRuntimeWorker(loadAgentRuntimeDescriptor(args[1]));
  const stop = () => { void worker.shutdown().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try { await worker.listen(); }
  catch (error) {
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    await worker.shutdown(); throw error;
  }
}
function isDirectEntrypoint(): boolean {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}
if (isDirectEntrypoint()) {
  agentRuntimeMain().catch(() => { console.error('Agent runtime failed; check the local descriptor/context/endpoint.'); process.exitCode = 1; });
}
