import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createTelegramBot, buildReplyContext } from '../telegram-bot.js';
import { extractRichIntake } from '../telegram-rich-intake.js';
import { buildPiPromptCommand, buildPiAcknowledgedSteerCommand } from '../pi-rpc-protocol.js';
import { parsePiAcknowledgedSteerEnvelope } from '../pi-extensions/acknowledged-steer.js';
import { cleanupSessionMediaDir } from '../media-store.js';
import type { BotConfig, StreamLine } from '../types.js';
import type { SessionManager } from '../session-manager.js';
import type { RichMessage } from 'grammy/types';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const photo = (id: string) => ({ type: 'photo' as const, photo: [{ file_id: id, file_unique_id: id, width: 1, height: 1, file_size: png.length }] });
const rich = (...blocks: RichMessage['blocks']): RichMessage => ({ blocks });
const tick = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(r => setImmediate(r)); };
const config: BotConfig = {
  telegramToken: 'test:rich-fixture', whisperModelPath: '/tmp/test-model.bin',
  agents: { test: { id: 'test', workspaceCwd: '/tmp/test-workspace', model: 'gpt-5.5' } },
  bindings: [{ chatId: 31, agentId: 'test', kind: 'dm', typingIndicator: false }],
  sessionDefaults: { idleTimeoutMs: 60000, maxConcurrentSessions: 2, maxMessageAgeMs: 300000, maxMediaBytes: 1024, requireMention: false },
};
function setup(overrides: Partial<BotConfig> = {}) {
  const commands: ReturnType<typeof buildPiPromptCommand>[] = [];
  const apiCalls: Array<{ method: string; payload: any }> = [];
  const manager = {
    touchActivity() {}, getActive() { return undefined; }, getOrCreateSession: async () => ({}), deliverPendingRecoveryNotice: async () => false,
    async *sendSessionMessage(_key: string, _agent: string, text: string, options: { imagePaths?: string[] }): AsyncGenerator<StreamLine> {
      commands.push(buildPiPromptCommand(text, 'followUp', 'test-prompt', options.imagePaths));
      yield { type: 'result', result: 'NO_REPLY' } as StreamLine;
    },
  } as unknown as SessionManager;
  const result = createTelegramBot({ ...config, ...overrides }, manager);
  result.bot.botInfo = { id: 99, is_bot: true, first_name: 'Fixture bot', username: 'fixture_bot' } as any;
  result.bot.api.config.use(async (_prev, method, payload) => {
    apiCalls.push({ method, payload });
    return { ok: true, result: method === 'getFile' ? { file_id: 'fixture', file_path: 'photos/fixture.png', file_size: png.length } : { message_id: 2 } } as any;
  });
  return { ...result, commands, apiCalls };
}
function update(extra: Record<string, unknown>, chatId = 31): any {
  return { update_id: 1, message: { message_id: 1, chat: { id: chatId, type: 'private' }, from: { id: 31, is_bot: false, first_name: 'Fixture' }, date: Math.floor(Date.now() / 1000), ...extra } };
}

describe('rich incoming extraction', () => {
  it('extracts structured text, bounded photos and explicit unsupported markers in order', () => {
    const input = rich(
      { type: 'heading', size: 1, text: 'Title' },
      { type: 'list', items: [{ label: '1.', blocks: [{ type: 'paragraph', text: { type: 'bold', text: 'Item' } }] }] },
      { type: 'table', cells: [[{ text: 'Cell', align: 'left', valign: 'top' }]] },
      photo('same'), photo('same'), { type: 'video' } as any,
    );
    const extracted = extractRichIntake(input, rich(photo('parent')));
    assert.match(extracted.text, /Title[\s\S]*1\. Item[\s\S]*Cell[\s\S]*\[Photo\][\s\S]*Unsupported rich media\/block: video/);
    assert.deepEqual(extracted.photos.map(p => p.file_id), ['same', 'parent']);
    assert.match(buildReplyContext({ rich_message: input }), /Title/);
    assert.equal(buildReplyContext({ rich_message: input }, { text: 'selected quote' }), '[Reply, quoting]\n> selected quote\n');
  });
  it('shares attachment caps across direct and parent and limits nesting', () => {
    const extracted = extractRichIntake(rich(...Array.from({ length: 40 }, (_, i) => photo(`direct${i}`))), rich(...Array.from({ length: 20 }, (_, i) => photo(`parent${i}`))));
    assert.equal(extracted.photos.length, 50); assert.match(extracted.parentText, /attachment limit/);
    let deep: any = { type: 'paragraph', text: 'too deep' };
    for (let i = 0; i < 20; i++) deep = { type: 'blockquote', blocks: [deep] };
    assert.match(extractRichIntake(rich(deep)).text, /Rich content limit/);
  });
});

describe('actual rich handler to queue to Pi vision', () => {
  for (const ordinaryTop of [false, true]) it(`attaches direct/immediate parent photos as real images (${ordinaryTop ? 'ordinary top text' : 'rich top'})`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
    let downloads = 0;
    t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response(png); });
    const { bot, messageQueue, commands, apiCalls } = setup();
    const parent = update({ rich_message: rich({ type: 'paragraph', text: 'parent full text' }, photo('shared')), forward_origin: { type: 'hidden_user', sender_user_name: 'Fixture source', date: 1 }, reply_to_message: update({ rich_message: rich(photo('grandparent')) }).message }).message;
    await bot.handleUpdate(update({ ...(ordinaryTop ? { text: 'Explain this' } : { rich_message: rich({ type: 'heading', size: 2, text: 'Explain this' }, photo('shared')) }), reply_to_message: parent, quote: { text: 'selected only', position: 0, is_manual: true } }));
    assert.equal(downloads, 1); assert.equal(apiCalls.filter(c => c.method === 'getFile').length, 1);
    t.mock.timers.tick(3000); await tick();
    assert.equal(commands.length, 1);
    assert.match(commands[0].message, /selected only/); assert.doesNotMatch(commands[0].message, /parent full text/);
    assert.match(commands[0].message, /Fixture source/); assert.match(commands[0].message, /Explain this/);
    assert.deepEqual(commands[0].images, [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
    const path = commands[0].message.split('\n').find(line => line.endsWith('.jpg'))!;
    assert.ok(existsSync(path), 'accepted prompt retains image for session lifetime');
    const steer = buildPiAcknowledgedSteerCommand('follow-up', 'steer-test', [path]);
    const envelope = parsePiAcknowledgedSteerEnvelope(steer.message.split(' ')[1]);
    assert.deepEqual(envelope?.images, commands[0].images);
    messageQueue.clearAll(); cleanupSessionMediaDir('31');
  });

  it('attaches an ordinary parent photo without traversing its reply chain', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
    t.mock.method(globalThis, 'fetch', async () => new Response(png));
    const { bot, messageQueue, commands, apiCalls } = setup();
    await bot.handleUpdate(update({ text: 'Explain the parent photo', reply_to_message: update({ photo: photo('ordinary-parent').photo, caption: 'Parent caption', reply_to_message: update({ photo: photo('grandparent').photo }).message }).message }));
    t.mock.timers.tick(3000); await tick();
    assert.equal(apiCalls.filter(c => c.method === 'getFile').length, 1);
    assert.equal(commands[0].images?.length, 1);
    assert.match(commands[0].message, /Parent caption/);
    messageQueue.clearAll(); cleanupSessionMediaDir('31');
  });

  it('shares the byte budget and reclaims queued rich photos on drop', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(png));
    const { bot, messageQueue } = setup({ sessionDefaults: { ...config.sessionDefaults, maxMediaBytes: png.length } });
    const captured: Parameters<typeof messageQueue.enqueue>[] = [];
    const original = messageQueue.enqueue.bind(messageQueue);
    t.mock.method(messageQueue, 'enqueue', (...args: Parameters<typeof messageQueue.enqueue>) => { captured.push(args); return original(...args); });
    await bot.handleUpdate(update({ rich_message: rich(photo('first')), reply_to_message: update({ rich_message: rich(photo('second')) }).message }));
    assert.equal(captured.length, 1); assert.match(captured[0][2], /Photo omitted: shared media limit/);
    const paths = captured[0][6]!; assert.equal(paths.length, 1); assert.ok(existsSync(paths[0]));
    messageQueue.clearAll(); assert.ok(!existsSync(paths[0])); cleanupSessionMediaDir('31');
  });

  it('does not download unauthorized rich photos', async t => {
    t.mock.method(globalThis, 'fetch', async () => { assert.fail('unauthorized download'); });
    const { bot, messageQueue, apiCalls } = setup();
    await bot.handleUpdate(update({ rich_message: rich(photo('blocked')) }, 32));
    assert.equal(apiCalls.length, 0); assert.equal(messageQueue.getPendingCount('32'), 0); messageQueue.clearAll();
  });
});

for (const ordinaryParent of [false, true]) for (const failure of ['metadata', 'download', 'format'] as const) {
  if (ordinaryParent && failure === 'format') continue; // Ordinary photos keep their existing format handling.
  it(`keeps primary text when optional ${ordinaryParent ? 'ordinary' : 'rich'} parent photo fails at ${failure}`, async t => {
    const { readdirSync } = await import('node:fs');
    const { ensureSessionMediaDir } = await import('../media-store.js');
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
    const { bot, messageQueue, commands, apiCalls } = setup();
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method !== 'getFile') return prev(method, payload, signal);
      if (failure === 'metadata') throw new Error('fixture metadata failure');
      return { ok: true, result: { file_id: 'parent', file_unique_id: 'parent', file_path: 'parent.png' } } as any;
    });
    t.mock.method(globalThis, 'fetch', async () => {
      if (failure === 'download') return new Response('unavailable', { status: 404 });
      return new Response('invalid photo fixture');
    });
    try {
      await bot.handleUpdate(update({ text: 'Keep my primary text', reply_to_message: update(ordinaryParent
        ? { photo: photo('parent').photo, caption: 'Parent caption' }
        : { rich_message: rich(photo('parent')) }).message }));
      t.mock.timers.tick(3000); await tick();
      assert.equal(commands.length, 1); assert.match(commands[0].message, /Keep my primary text/);
      assert.match(commands[0].message, /Photo omitted: parent unavailable/); assert.equal(commands[0].images, undefined);
      assert.equal(apiCalls.filter(c => c.method === 'sendMessage').length, 0, 'optional context does not send a turn-failure notice');
      assert.deepEqual(readdirSync(ensureSessionMediaDir('31')), [], 'failed optional download leaves no file');
    } finally { messageQueue.clearAll(); cleanupSessionMediaDir('31'); }
  });
}

it('keeps successful direct and later parent photos after an optional failure and reclaims them on drop', async t => {
  const { readdirSync } = await import('node:fs');
  const { ensureSessionMediaDir } = await import('../media-store.js');
  const { bot, messageQueue } = setup();
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method !== 'getFile') return prev(method, payload, signal);
    const id = (payload as { file_id: string }).file_id;
    return { ok: true, result: { file_id: id, file_unique_id: id, file_path: `${id}.png` } } as any;
  });
  t.mock.method(globalThis, 'fetch', async (url: any) => new Response(String(url).includes('bad.png') ? 'invalid photo' : png));
  const captured: Parameters<typeof messageQueue.enqueue>[] = [];
  const enqueue = messageQueue.enqueue.bind(messageQueue);
  t.mock.method(messageQueue, 'enqueue', (...args: Parameters<typeof messageQueue.enqueue>) => { captured.push(args); return enqueue(...args); });
  try {
    await bot.handleUpdate(update({ rich_message: rich({ type: 'paragraph', text: 'Primary' }, photo('direct')),
      reply_to_message: update({ rich_message: rich(photo('direct'), photo('bad'), photo('good')) }).message }));
    assert.equal(captured.length, 1); assert.match(captured[0][2], /Primary/); assert.match(captured[0][2], /parent unavailable/);
    assert.equal(captured[0][6]?.length, 2); assert.equal(readdirSync(ensureSessionMediaDir('31')).length, 2);
    messageQueue.clearAll(); assert.deepEqual(readdirSync(ensureSessionMediaDir('31')), []);
  } finally { messageQueue.clearAll(); cleanupSessionMediaDir('31'); }
});

it('still aborts on a failed primary photo even when the parent repeats that photo', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() });
  const { bot, messageQueue, commands, apiCalls } = setup();
  bot.api.config.use(async (prev, method, payload, signal) => {
    if (method === 'getFile') throw new Error('primary unavailable');
    return prev(method, payload, signal);
  });
  try {
    await bot.handleUpdate(update({ rich_message: rich({ type: 'paragraph', text: 'Primary' }, photo('same')),
      reply_to_message: update({ rich_message: rich(photo('same')) }).message }));
    t.mock.timers.tick(3000); await tick();
    assert.equal(commands.length, 0);
    assert.equal(apiCalls.filter(c => c.method === 'sendMessage').length, 1);
  } finally { messageQueue.clearAll(); cleanupSessionMediaDir('31'); }
});
