import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export default function (pi) {
  pi.registerProvider('consultation-fixture', {
    baseUrl: 'http://127.0.0.1:1',
    apiKey: '$CONSULTATION_FIXTURE_UNUSED_API_KEY',
    oauth: {
      name: 'Offline subscription',
      isSubscription: true,
      async login() { throw new Error('Unexpected login'); },
      async refreshToken() { throw new Error('Unexpected refresh'); },
      getApiKey(credential) { return credential.access; },
    },
    api: 'anthropic-messages',
    models: [{ id: 'offline', name: 'Offline consultation', reasoning: false, input: ['text'],
      compat: { supportsStrictTools: true, allowedFallbackModels: [{ provider: 'consultation-fixture', model: 'unused' }] },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000 }],
    streamSimple(model, context, options) {
      appendFileSync('consultation-prompts', '1\n');
      const stream = createAssistantMessageEventStream();
      const prompt = JSON.stringify(context.messages.at(-1));
      const normal = prompt.includes('WORKER_PRIMARY');
      if (prompt.includes('CONSULT_CRASH')) process.exit(91);
      if (prompt.includes('CONSULT_WAIT')) return stream;
      const instructions = JSON.stringify(context);
      const expectedOptions = normal ? { retries: 2, transport: 'websocket-cached' } : { retries: 0, transport: 'sse' };
      const failed = prompt.includes('CONSULT_ERROR')
        || options?.apiKey !== 'offline-authorization-marker'
        || options.maxRetries !== expectedOptions.retries || options.transport !== expectedOptions.transport
        || model.compat?.supportsStrictTools !== normal || model.compat?.allowedFallbackModels?.length !== Number(normal)
        || (!normal && !prompt.includes('CONSULT_ONE'))
        || !instructions.includes('ISOLATED_TARGET_CONTEXT')
        || instructions.includes('SYNTHETIC_AMBIENT_SYSTEM');
      let answer = normal ? 'PRIMARY_PROFILE_ANSWER'
        : prompt.includes('CONSULT_LONG') ? 'a'.repeat(40_000) + '?' : 'ISOLATED_TARGET_ANSWER';
      if (prompt.includes('CONSULT_LITERAL')) {
        answer = JSON.stringify({ provider: model.provider, id: model.id, reasoning: options.reasoning });
      }
      const message = { role: 'assistant', content: failed ? [] : [{ type: 'text', text: answer }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: failed ? 'error' : 'stop',
        ...(failed ? { errorMessage: '503 synthetic model failure containing PRIVATE_DIAGNOSTIC' } : {}),
      };
      stream.push(failed ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: 'stop', message });
      stream.end();
      return stream;
    },
  });
  pi.on('session_start', (_event, ctx) => {
    const settings = pi.getSettings();
    writeFileSync(join(ctx.cwd, 'consultation-started.json'), JSON.stringify({
      pid: process.pid,
      noSession: !ctx.sessionManager.isPersisted() && ctx.sessionManager.getSessionFile() === undefined,
      noCentralEnv: !Object.keys(process.env).some(key => /^MINIME_(CONFIG|INSTANCE|CONTROL|CRONS|COLLABORATION)/.test(key)),
      tools: pi.getActiveTools().sort(),
      autoRetry: settings.retry?.enabled,
      autoCompaction: settings.compaction?.enabled,
      cacheWarming: settings.cacheWarming,
    }));
  });
}
