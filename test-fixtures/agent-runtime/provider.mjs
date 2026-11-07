// Deterministic, credential-free provider. Pi's real bash tool authors the receipts.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
const text = m => typeof m?.content === 'string' ? m.content : (m?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const receipt = m => {
  const line = text(m).split('\n').find(l => l.startsWith('WORKER_RECEIPT='));
  return line ? JSON.parse(line.slice(15)) : undefined;
};
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
export default function(pi) {
  pi.registerProvider('worker-offline', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-offline', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Worker offline fixture', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        try {
          const last = context.messages.at(-1);
          let content;
          if (last?.role === 'toolResult') {
            const value = receipt(last);
            if (!value || last.isError) throw new Error('Missing real tool receipt');
            content = [{ type: 'text', text: JSON.stringify(value) }];
          } else {
            const prompt = text(last);
            let script;
            if (prompt === 'CONTEXT') {
              const instructions = JSON.stringify(context.messages.filter(m => m.role === 'system'));
              content = [{ type: 'text', text: JSON.stringify({
                sentinel: instructions.includes('SYNTHETIC_AMBIENT_SYSTEM_SENTINEL'),
                defaultPrompt: instructions.includes('You are a coding assistant running inside pi'),
                before: instructions.includes('SYNTHETIC_LANE_BEFORE'),
                after: instructions.includes('SYNTHETIC_LANE_AFTER'),
              }) }];
            } else if (/^WRITE [a-z0-9-]+$/.test(prompt)) {
              const marker = prompt.slice(6);
              const instructions = JSON.stringify(context.messages.filter(m => m.role === 'system'));
              const value = { marker, context: instructions.includes('SYNTHETIC_LOCAL_CONTEXT')
                && instructions.includes('SYNTHETIC_IMPORTED_CONTEXT') && instructions.includes('SYNTHETIC_RULE_CONTEXT')
                && instructions.includes('SYNTHETIC_KNOWLEDGE_INDEX') };
              script = `const fs=require('node:fs');fs.writeFileSync('marker.txt',${JSON.stringify(marker)});console.log('WORKER_RECEIPT='+JSON.stringify(${JSON.stringify(value)}));`;
            } else if (prompt === 'HISTORY') {
              const prior = context.messages.filter(m => m.role === 'toolResult').map(receipt).findLast(r => r?.marker);
              if (!prior) throw new Error('No prior real tool receipt in Pi history');
              script = `console.log('WORKER_RECEIPT='+JSON.stringify({priorMarker:${JSON.stringify(prior.marker)},historyToolReceipt:true}));`;
            } else if (prompt === 'WAIT') {
              const command = `/bin/sleep 30 &\nsleeper=$!\nprintf '{"pid":%s}\\n' "$sleeper" > sleeper.json\nwait "$sleeper"\nprintf 'WORKER_RECEIPT={"waitCompleted":true}\\n'`;
              content = [{ type: 'toolCall', id: `worker-${context.messages.length}`, name: 'bash', arguments: { command, timeout: 35 } }];
            } else throw new Error('Unknown offline prompt');
            if (script) content = [{ type: 'toolCall', id: `worker-${context.messages.length}`, name: 'bash', arguments: { command: `${quote(process.execPath)} -e ${quote(script)}`, timeout: 10 } }];
          }
          const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
          if (content[0]?.type === 'text') {
            stream.push({ type: 'start', partial: message });
            stream.push({ type: 'text_start', contentIndex: 0, partial: message });
            stream.push({ type: 'text_delta', contentIndex: 0, delta: content[0].text, partial: message });
            stream.push({ type: 'text_end', contentIndex: 0, content: content[0].text, partial: message });
          }
          stream.push({ type: 'done', reason: message.stopReason, message }); stream.end();
        } catch (error) {
          stream.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api,
            provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: 'error', errorMessage: String(error), timestamp: Date.now() } }); stream.end();
        }
      });
      return stream;
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    const root = dirname(process.env.PI_CODING_AGENT_DIR);
    const records = readdirSync(join(root, 'lanes')).map(name => JSON.parse(readFileSync(join(root, 'lanes', name, 'binding.json'), 'utf8')));
    const own = records.find(r => r.binding.sessionId === ctx.sessionManager.getSessionId());
    if (!own) throw new Error('Binding was not durable before Pi startup');
    writeFileSync(join(ctx.cwd, 'started.json'), JSON.stringify({ pid: process.pid, sessionId: own.binding.sessionId,
      bindingVisible: true, generation: own.generation, uid: process.getuid(),
      privateHome: process.env.HOME !== process.env.MINIME_CONTROL_WORKSPACE_ROOT,
      noCentralEnv: !Object.keys(process.env).some(k => /MINIME_(CONFIG|INSTANCE|CONTROL|CRONS)/.test(k)),
    }));
    const model = ctx.modelRegistry.find('worker-offline', 'fixture');
    if (!model || !await pi.setModel(model)) throw new Error('Offline fixture model unavailable');
  });
  pi.on('agent_settled', async (_event, ctx) => {
    // Native agent_end has already been emitted; native agent_settled waits for this hook.
    writeFileSync(join(ctx.cwd, 'settling.json'), JSON.stringify({ pid: process.pid }));
    await new Promise(resolve => setTimeout(resolve, 150));
  });
}
