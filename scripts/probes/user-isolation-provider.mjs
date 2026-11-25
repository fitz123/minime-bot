// Offline fixture only. Every receipt comes from Pi's real bash tool result/history.
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const textOf = message => typeof message?.content === 'string' ? message.content :
  (message?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
export function receipt(message) {
  const line = textOf(message).split('\n').find(line => line.startsWith('CANARY_RESULT='));
  return line ? JSON.parse(line.slice(14)) : undefined;
}

export default function (pi) {
  const c = JSON.parse(process.env.PI_CANARY_CONFIG);
  const node = script => `${quote(c.nodePath)} -e ${quote(script)}`;
  pi.registerProvider('canary-offline', {
    baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic-offline', api: 'openai-completions',
    models: [{ id: 'fixture', name: 'Isolation canary offline fixture', reasoning: false,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2000 }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        try {
          const messages = context.messages;
          const last = messages.at(-1);
          let content;
          if (last?.role === 'toolResult') {
            const result = receipt(last);
            if (!result || last.isError) throw new Error('Missing successful real tool receipt');
            content = [{ type: 'text', text: JSON.stringify(result) }];
          } else {
            const prompt = textOf(last);
            let command;
            if (/^CANARY_INSPECT [a-f0-9-]{36}$/.test(prompt)) {
              const marker = prompt.split(' ')[1];
              command = node(`const fs=require('node:fs');const path=require('node:path');const c=${JSON.stringify(c)};
const attempt=f=>{try{f();return 'allowed'}catch(e){return e.code||'error'}};
fs.mkdirSync('outbox',{recursive:true,mode:0o700});fs.writeFileSync('outbox/marker.txt',${JSON.stringify(marker)},{mode:0o600});
const result={case:'inspect',piPid:${process.pid},marker:${JSON.stringify(marker)},nodeVersion:process.version,uid:process.getuid(),gid:process.getgid(),groups:process.getgroups(),home:process.env.HOME,cwd:process.cwd(),tmp:process.env.TMPDIR,agentDir:process.env.PI_CODING_AGENT_DIR,
privateParentAccess:attempt(()=>fs.accessSync(path.dirname(c.privateFixturePath),fs.constants.R_OK|fs.constants.X_OK)),
controllerHomeAccess:c.controllerHomeProbePath===undefined?'not_configured':attempt(()=>fs.accessSync(c.controllerHomeProbePath,fs.constants.R_OK|fs.constants.X_OK)),
privateRead:attempt(()=>fs.readFileSync(c.privateFixturePath)),protectedWrite:attempt(()=>{const fd=fs.openSync(c.protectedFilePath,'r+');try{fs.writeSync(fd,'CANARY_WRITE\\n',0,'utf8')}finally{fs.closeSync(fd)}})};
console.log('CANARY_RESULT='+JSON.stringify(result));`);
            } else if (prompt === 'CANARY_RESUME') {
              // Look only in persisted tool messages, never the new prompt or module memory.
              const prior = messages.filter(m => m.role === 'toolResult').map(receipt).findLast(r => r?.case === 'inspect');
              if (!prior?.marker) throw new Error('No inspect receipt in actual Pi message history');
              command = node(`console.log('CANARY_RESULT='+JSON.stringify({case:'resume',piPid:${process.pid},priorMarker:${JSON.stringify(prior.marker)},historyToolReceipt:true}));`);
            } else if (prompt === 'CANARY_CANCEL') {
              command = `/bin/sleep 20 &\nsleeper=$!\nprintf 'CANARY_SLEEP={"pid":%s}\\n' "$sleeper"\nwait "$sleeper"\nprintf 'CANARY_RESULT={"case":"cancel","completed":true}\\n'`;
            } else if (/^CANARY_STOPPED [1-9][0-9]*$/.test(prompt)) {
              const pid = Number(prompt.split(' ')[1]);
              command = node(`let status='alive';try{process.kill(${pid},0)}catch(e){status=e.code}console.log('CANARY_RESULT='+JSON.stringify({case:'stopped',pid:${pid},status}));`);
            } else throw new Error('Unrecognized synthetic canary prompt');
            content = [{ type: 'toolCall', id: `canary-${messages.length}`, name: 'bash', arguments: { command, timeout: 25 } }];
          }
          const message = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id,
            usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
          stream.push({ type: 'done', reason: message.stopReason, message });
          stream.end();
        } catch (error) {
          stream.push({ type: 'error', reason: 'error', error: { role: 'assistant', content: [], api: model.api,
            provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'error', errorMessage: String(error), timestamp: Date.now() } });
          stream.end();
        }
      });
      return stream;
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    const model = ctx.modelRegistry.find('canary-offline', 'fixture');
    if (!model || !await pi.setModel(model)) throw new Error('Offline canary model unavailable');
  });
}
