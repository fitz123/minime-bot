// Controller process only uses the public socket client, never private worker transcripts/store.
import { AgentRuntimeClient } from '../../src/agent-runtime-client.js';
import type { AgentLaneHandle } from '../../src/agent-runtime-protocol.js';
const client = await AgentRuntimeClient.connect(process.argv[2]);
const send = (message: unknown) => { if (process.connected) process.send!(message); };
let handle: AgentLaneHandle | undefined;
process.on('message', async (input: { id: string; op: string; expectedSessionId?: string; text?: string; requestId?: string }) => {
  try {
    let state;
    if (input.op === 'open') { state = await client.open('lane', input.expectedSessionId); handle = state.handle; }
    else if (input.op === 'prompt') {
      const request = client.prompt(handle!, input.requestId!, input.text!, event => send({ id: input.id, event }));
      send({ id: input.id, accepted: await request.accepted });
      state = await request.completed;
    } else if (input.op === 'state') state = await client.getState(handle!);
    else if (input.op === 'abort') state = await client.abort(handle!, input.requestId!);
    else if (input.op === 'close') state = await client.close(handle!);
    else if (input.op === 'shutdown') { await client.shutdown(); process.disconnect(); return; }
    else if (input.op === 'disconnect') { client.disconnect(); process.disconnect(); return; }
    send({ id: input.id, done: true, state });
  } catch (error) { send({ id: input.id, done: true, error: { code: (error as {code?: string}).code, message: String(error) } }); }
});
process.once('disconnect', () => client.disconnect());
process.send?.({ ready: true });
