// A bounded startup-timeout test kills this Pi before the timer fires.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import provider from './provider.mjs';
export default function(pi) {
  provider(pi);
  pi.on('session_start', async (_event, ctx) => {
    writeFileSync(join(ctx.cwd, 'blocked-pid.json'), JSON.stringify({ pid: process.pid }));
    await new Promise(resolve => setTimeout(resolve, 30_000));
  });
}
