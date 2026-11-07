import { AgentRuntimeWorker } from '../../src/agent-runtime-worker.js';
import { loadAgentRuntimeDescriptor } from '../../src/agent-runtime-descriptor.js';
const worker = new AgentRuntimeWorker(loadAgentRuntimeDescriptor(process.argv[2]), {
  trustedTestExtensions: process.argv[3] ? [process.argv[3]] : [],
  startupTimeoutMs: Number(process.argv[4] || 10_000), promptTimeoutMs: 30_000,
});
const stop = () => { void worker.shutdown().catch(() => { process.exitCode = 1; }); };
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
await worker.listen();
process.send?.({ ready: true });
