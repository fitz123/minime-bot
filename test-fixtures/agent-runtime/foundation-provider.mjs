// Credential-free provider drives Pi's real read tool and native skill disclosure.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

export default function(pi) {
  // Optional physical-publication probe. The caller selects contained manifest
  // resources in a fresh private input file; prompts cannot choose read paths.
  const probe = process.env.MINIME_FOUNDATION_PROBE_INPUT
    ? JSON.parse(readFileSync(process.env.MINIME_FOUNDATION_PROBE_INPUT, 'utf8')) : undefined;
  pi.registerProvider('foundation-offline', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-offline', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Foundation offline fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const instructions = JSON.stringify(context.messages.filter(m => m.role === 'system'));
        // Pi retains incremental system updates in history; use the latest advertisement.
        const location = [...instructions.matchAll(/<location>([^<]+\/SKILL.md)<\/location>/g)].at(-1)?.[1];
        const lastUser = context.messages.findLastIndex(m => m.role === 'user');
        const results = context.messages.slice(lastUser + 1).filter(m => m.role === 'toolResult');
        const reads = results.map(m => JSON.stringify(m));
        const probePaths = probe && [join(probe.root, probe.skillPath), join(probe.root, probe.supportPath)];
        const readMatches = (index) => {
          const result = results[index];
          const text = result?.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
          const expected = readFileSync(probePaths[index], 'utf8').slice(0, 160);
          return !!expected.trim() && !result?.isError && text?.startsWith(expected) === true;
        };
        const content = probe && results.length < 2
          ? [{ type: 'toolCall', id: `foundation-probe-${results.length}`, name: 'read', arguments: { path: probePaths[results.length] } }]
          : probe ? [{ type: 'text', text: JSON.stringify({
            commonRules: probe.rulePaths.length > 0 && probe.rulePaths.every(path =>
              instructions.includes(JSON.stringify(readFileSync(join(probe.root, path), 'utf8').trim()).slice(1, -1))),
            localPrivate: instructions.includes('SYNTHETIC_PRIVATE_LOCAL_MARKER'),
            skillAdvertised: instructions.includes(`<location>${probePaths[0]}</location>`),
            skillRead: readMatches(0), supportRead: readMatches(1),
          }) }]
          : location && results.length < 2
          ? [{ type: 'toolCall', id: `foundation-${results.length}`, name: 'read', arguments: {
            path: results.length === 0 ? location : join(dirname(location), 'support.md'),
          } }]
          : [{ type: 'text', text: JSON.stringify({
            sharedRule: instructions.includes('SYNTHETIC_SHARED_RULE'),
            localPrivate: instructions.includes('SYNTHETIC_PRIVATE_LOCAL_MARKER'),
            metadata: instructions.includes('SYNTHETIC_SKILL_METADATA'),
            lazyBody: !instructions.includes('SYNTHETIC_SKILL_BODY'),
            ambientSkill: instructions.includes('SYNTHETIC_AMBIENT_SKILL'),
            ambientSystem: instructions.includes('SYNTHETIC_AMBIENT_SYSTEM'),
            skillRead: reads[0]?.includes('SYNTHETIC_SKILL_BODY') === true,
            supportRead: reads[1]?.includes('SYNTHETIC_SUPPORT') === true,
            location,
            ...(process.env.MINIME_BEHAVIORAL_FOUNDATION_ROOT ? {
              root: process.env.MINIME_BEHAVIORAL_FOUNDATION_ROOT,
              noCentralEnv: !Object.keys(process.env).some(key => /MINIME_(CONFIG|INSTANCE|CONTROL|CRONS)/.test(key)),
            } : {}),
          }) }];
        const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', timestamp: Date.now() };
        stream.push({ type: 'done', reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
}
