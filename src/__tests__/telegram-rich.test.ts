import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTelegramApiAdapter, createTelegramAdapter } from "../telegram-adapter.js";
import { relayStream } from "../stream-relay.js";
import type { StreamLine } from "../types.js";
import { prepareRichAnswer, RICH_RESERVED_DIR } from "../telegram-rich.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=", "base64");
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function* answer(text: string): AsyncGenerator<StreamLine> {
  yield { type: "stream_event", event: { delta: { type: "text_delta", text } } } as StreamLine;
  await tick();
  yield { type: "result" } as StreamLine;
}

describe("native rich relay vertical slice", () => {
  for (const context of [false, true]) it(`draft settles before final upload, no duplicate standalone (${context ? "context" : "API"})`, async () => {
    const outbox = mkdtempSync(join(tmpdir(), "rich-outbox-"));
    writeFileSync(join(outbox, "one.png"), png); writeFileSync(join(outbox, "two.png"), png);
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const api: any = {
      async sendRichMessageDraft(_chat: number, _id: number, rich: any) {
        calls.push("draft"); assert.equal(rich.media, undefined);
        assert.ok(!rich.markdown.includes("outbox:")); assert.match(rich.markdown, /Image: First/);
        await gate; calls.push("draft-settled"); return true;
      },
      async sendRichMessage(_chat: number, rich: any, opts: any) {
        calls.push("final"); assert.equal(opts.message_thread_id, 7);
        assert.equal(rich.media.length, 2);
        assert.match(rich.markdown, /# Report\n\nBefore\n\n!\[\]\(tg:\/\/photo\?id=photo_0 "First"\)\n\nBetween\n\n!\[\]\(tg:\/\/photo\?id=photo_1 "Second"\)/);
        return { message_id: 100 };
      },
      async sendPhoto() { calls.push("standalone"); }, async sendDocument() { calls.push("standalone"); },
    };
    const binding = { kind: "dm" as const, chatId: 1, agentId: "test", typingIndicator: false };
    const adapter = context ? createTelegramAdapter({ api, chat: { id: 1 }, message: { message_thread_id: 7 } } as any, binding)
      : createTelegramApiAdapter({ api, chatId: 1, binding, threadId: 7 });
    const task = relayStream(answer("# Report\n\nBefore\n\n![First](outbox:one.png)\n\nBetween\n\n![Second](outbox:two.png)"), adapter, outbox);
    await tick(); assert.deepEqual(calls, ["draft"]); release(); await task;
    assert.deepEqual(calls, ["draft", "draft-settled", "final"]);
    assert.deepEqual(readdirSync(outbox), []);
  });

  it("retains repeated source until every referencing chunk is confirmed", () => {
    const outbox = mkdtempSync(join(tmpdir(), "rich-outbox-"));
    writeFileSync(join(outbox, "one.png"), png);
    const prepared = prepareRichAnswer(`![First](outbox:one.png)\n\n${"x".repeat(23980)}\n\n![Again](outbox:one.png)`, outbox);
    const path = prepared.chunks[0].options.media![0].path;
    assert.ok(existsSync(path)); prepared.confirm(0); assert.ok(existsSync(path));
    prepared.confirm(prepared.chunks.length - 1); assert.ok(!existsSync(path));
  });
});

describe("rich preparation and custody", () => {
  it("preserves literal fence blank lines, placeholders and intentional formatting", () => {
    const source = '# Heading\n\nUse <widget> and <path/to/file> placeholders, with <u>intentional underline</u> and **bold**.\n\n```xml\n<widget>\n\n\nvalue\n</widget>\n```';
    const { chunks } = prepareRichAnswer(source);
    assert.match(chunks[1].text, /<widget>/);
    assert.deepEqual((chunks[1].options.nativeBlocks![0] as { text: unknown }).text, ["Use <widget> and <path/to/file> placeholders, with ", { type: "underline", text: "intentional underline" }, " and ", { type: "bold", text: "bold" }, "."]);
    assert.match(chunks[1].text, /<u>intentional underline<\/u>/);
    assert.match(chunks[1].text, /\*\*bold\*\*/);
    assert.equal(chunks[2].text, '<widget>\n\n\nvalue\n</widget>');
    assert.equal(chunks[2].options.nativeBlocks![0].type, "pre");
  });

  it("splits Unicode, large paragraphs and repeated table headers within native budgets", () => {
    const unicode = '😀'.repeat(20000);
    const unicodeChunks = prepareRichAnswer(unicode).chunks;
    assert.equal(unicodeChunks.map(c => c.text).join(''), unicode);
    for (const c of unicodeChunks) { assert.ok(Buffer.byteLength(c.text) <= 24000); assert.ok(!c.text.includes('\uFFFD')); }
    const header = '| Name | Value |\n| --- | --- |';
    const table = prepareRichAnswer(header + '\n' + Array.from({ length: 600 }, (_, i) => `| row${i} | ${i} |`).join('\n')).chunks;
    assert.ok(table.length > 1);
    for (const c of table) { assert.ok(c.text.startsWith(header)); assert.ok(c.text.split('\n').length <= 180); }
    assert.equal(table.flatMap(c => c.text.match(/\| row\d+ \|/g) ?? []).length, 600);
  });

  it("normalizes excessive table/nesting/link source to native literal text", () => {
    const wide = `| ${Array(21).fill('column').join(' | ')} |\n| ${Array(21).fill('---').join(' | ')} |`;
    for (const source of [wide, '>'.repeat(17) + ' nested', `[label](https://example.test/${'x'.repeat(25000)})`]) {
      const chunks = prepareRichAnswer(source).chunks;
      assert.ok(chunks.every(c => c.options.nativeBlocks?.some(block => block.type === "pre")));
      assert.equal(chunks.map(c => c.text).join(''), source);
    }
  });

  it("external images remain ordinary links, code examples do not reserve", () => {
    const chunks = prepareRichAnswer('![Remote](https://example.test/photo.png)\n\n`![Example](outbox:missing.png)`\n\n```\n![Example](outbox:missing.png)\n```').chunks;
    assert.equal(chunks[0].text, '[Remote](https://example.test/photo.png)\n\n`![Example](outbox:missing.png)`');
    assert.ok(chunks.every(c => !c.options.media?.length));
  });

  it("reserves all sources before the first chunk and respects the media count per request", () => {
    const outbox = mkdtempSync(join(tmpdir(), 'rich-many-'));
    writeFileSync(join(outbox, 'one.png'), png);
    const prepared = prepareRichAnswer(Array(100).fill('![Repeat](outbox:one.png)').join('\n'), outbox);
    assert.ok(prepared.chunks.length >= 3);
    for (const chunk of prepared.chunks) assert.ok((chunk.text.match(/tg:\/\/photo/g) ?? []).length <= 40);
    const path = prepared.chunks[0].options.media![0].path;
    prepared.chunks.forEach((_c, i) => {
      assert.ok(existsSync(path)); prepared.confirm(i);
    });
    assert.ok(!existsSync(path));
  });

  it("fails missing/unsafe/invalid refs before any reservation", async () => {
    const { symlinkSync } = await import('node:fs');
    const outbox = mkdtempSync(join(tmpdir(), 'rich-invalid-'));
    writeFileSync(join(outbox, 'good.png'), png);
    writeFileSync(join(outbox, 'fake.jpg'), 'not a photo');
    symlinkSync(join(outbox, 'good.png'), join(outbox, 'link.png'));
    const huge = Buffer.from(png); huge.writeUInt32BE(10001, 16); writeFileSync(join(outbox, 'huge.png'), huge);
    const ratio = Buffer.from(png); ratio.writeUInt32BE(100, 16); writeFileSync(join(outbox, 'ratio.png'), ratio);
    for (const name of ['missing.png', '../good.png', 'fake.jpg', 'link.png', 'huge.png', 'ratio.png', 'bad name.png']) {
      assert.throws(() => prepareRichAnswer(`![Good](outbox:good.png)\n\n![Bad](outbox:${name})`, outbox));
      assert.ok(existsSync(join(outbox, 'good.png')));
      assert.ok(!existsSync(join(outbox, RICH_RESERVED_DIR)));
    }
  });

  it("retains failed later references across cleanup and keeps unrelated standalone delivery", async () => {
    const { removeOutboxDirIfPresent } = await import('../session-manager.js');
    const outbox = mkdtempSync(join(tmpdir(), 'rich-failure-'));
    writeFileSync(join(outbox, 'one.png'), png); writeFileSync(join(outbox, 'other.txt'), 'standalone');
    let finals = 0, files = 0;
    const api: any = {
      async sendRichMessage(_chat: number, rich: any) {
        finals++; if (finals === 3) throw new Error('deterministic 400');
        assert.equal(rich.media.length, finals === 1 ? 1 : 0); return { message_id: finals };
      },
      async sendDocument() { files++; return { message_id: 99 }; },
      async sendMessage() { assert.fail('no ordinary fallback'); },
    };
    const adapter = createTelegramApiAdapter({ api, chatId: 1, binding: { chatId: 1, agentId: 'test', kind: 'group', typingIndicator: false } });
    await relayStream(answer(`![First](outbox:one.png)\n\n${'x'.repeat(23980)}\n\n![Again](outbox:one.png)`), adapter, outbox);
    assert.equal(finals, 3); assert.equal(files, 1);
    const root = join(outbox, RICH_RESERVED_DIR);
    const path = join(root, readdirSync(root)[0], 'one.png');
    assert.ok(existsSync(path)); removeOutboxDirIfPresent(outbox, true); assert.ok(existsSync(path));
  });

  it("NO_REPLY suppresses reservation, drafts, rich sends and standalone attachments", async () => {
    const outbox = mkdtempSync(join(tmpdir(), 'rich-no-reply-'));
    writeFileSync(join(outbox, 'one.png'), png);
    const api = new Proxy({}, { get: () => async () => assert.fail('NO_REPLY sent something') });
    const adapter = createTelegramApiAdapter({ api: api as any, chatId: 1, binding: { chatId: 1, agentId: 'test', kind: 'dm', typingIndicator: false } });
    await relayStream(answer('NO_REPLY'), adapter, outbox);
    assert.deepEqual(readdirSync(outbox), ['one.png']);
  });
});

describe('native draft transport and scheduler', () => {
  it('bypasses the actual autoRetry transformer on rich draft 429', async () => {
    const { Api } = await import('grammy');
    const { createTelegramAutoRetryTransformer } = await import('../telegram-bot.js');
    const api = new Api('test:fixture');
    const methods: string[] = [];
    api.config.use(async (_prev, method) => { methods.push(method); return { ok: false, error_code: 429, description: 'fixture rate limit', parameters: { retry_after: 3 } }; });
    api.config.use(createTelegramAutoRetryTransformer());
    const adapter = createTelegramApiAdapter({ api, chatId: 1, binding: { chatId: 1, agentId: 'test', kind: 'dm' } });
    assert.deepEqual(await adapter.sendDraft(1, 'partial answer'), { status: 'rate_limited', retryAfterMs: 3000 });
    assert.deepEqual(methods, ['sendRichMessageDraft']);
  });

  it('refreshes rich drafts at 15000ms and suspension survives reset', async t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let suspend!: () => void;
    let drafts = 0, finals = 0;
    const api: any = {
      async sendRichMessageDraft() { drafts++; return true; },
      async sendRichMessage() { finals++; return { message_id: 1 }; },
    };
    const adapter = createTelegramApiAdapter({ api, chatId: 1, binding: { chatId: 1, agentId: 'test', kind: 'dm', typingIndicator: false } });
    const stream = (async function* () {
      yield { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'short preview' } } } as StreamLine;
      await gate;
      yield { type: 'assistant', subtype: 'control_request', action: 'reset_response_text' } as StreamLine;
      yield { type: 'stream_event', event: { delta: { type: 'text_delta', text: 'final' } } } as StreamLine;
      yield { type: 'result' } as StreamLine;
    })();
    const task = relayStream(stream, adapter, undefined, undefined, callback => { suspend = callback; return () => {}; });
    await tick(); assert.equal(drafts, 1);
    t.mock.timers.tick(14999); await tick(); assert.equal(drafts, 1);
    t.mock.timers.tick(1); await tick(); assert.equal(drafts, 2);
    suspend(); t.mock.timers.tick(30000); await tick(); assert.equal(drafts, 2);
    release(); await task; assert.equal(drafts, 2); assert.equal(finals, 1);
  });

  it('produces a bounded text-only projection from an open fence without destroying final source', async () => {
    const { richDraft } = await import('../telegram-rich.js');
    const source = '```xml\n<widget>\n\n\n' + '😀'.repeat(3000);
    const draft = richDraft(source);
    assert.ok(Buffer.byteLength(draft) < 4096); assert.ok(draft.endsWith('\n```'));
    assert.match(draft, /<widget>\n\n\n/);
    assert.equal(prepareRichAnswer(source).chunks.map(c => c.text).join(''), source.slice(7));
    assert.doesNotMatch(richDraft('![photo](outbox:missing.png)\n\n![remote](https://example.test/a.png)'), /!\[|outbox:|https:/);
  });
});

describe('native literal encoding boundaries', () => {
  it('keeps unknown placeholders literal in table cells and photo captions', async () => {
    const table = prepareRichAnswer('| Name | Value |\n| --- | --- |\n| <unknown> | <u>intentional</u> |').chunks[0];
    const block = table.options.nativeBlocks![0];
    assert.equal(block.type, 'table');
    if (block.type !== 'table') assert.fail('native table expected');
    assert.equal(block.cells[1][0].text, '<unknown>');
    assert.deepEqual(block.cells[1][1].text, { type: 'underline', text: 'intentional' });
    const outbox = mkdtempSync(join(tmpdir(), 'rich-caption-'));
    writeFileSync(join(outbox, 'one.png'), png);
    const prepared = prepareRichAnswer('![<placeholder> **bold**](outbox:one.png)', outbox);
    let sent: any;
    const adapter = createTelegramApiAdapter({ api: { sendRichMessage: async (_chat: number, rich: any) => { sent = rich; return { message_id: 1 }; } } as any, chatId: 1 });
    await adapter.sendMessage(prepared.chunks[0].text, prepared.chunks[0].options);
    assert.equal(sent.blocks[0].type, 'photo');
    assert.equal(typeof sent.blocks[0].photo.media.toRaw, 'function');
    assert.deepEqual(sent.blocks[0].caption.text, ['<placeholder> ', { type: 'bold', text: 'bold' }]);
    prepared.confirm(0);
  });

  it('bounds excessive supported HTML nesting and dense drafts', async () => {
    const { richDraftPayload } = await import('../telegram-rich.js');
    const nested = '<b>'.repeat(20) + 'literal' + '</b>'.repeat(20);
    const chunk = prepareRichAnswer(nested).chunks[0];
    assert.ok(chunk.options.nativeBlocks?.some(block => block.type === 'pre' && block.text === nested));
    const dense = richDraftPayload('- item\n'.repeat(1000));
    assert.equal(dense.blocks?.[0].type, 'pre');
  });

  it('confirmed cleanup failure stays excluded from standalone scanning', async () => {
    const { chmodSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { sendOutboxFiles } = await import('../stream-relay.js');
    const outbox = mkdtempSync(join(tmpdir(), 'rich-unlink-'));
    writeFileSync(join(outbox, 'one.png'), png);
    const prepared = prepareRichAnswer('![Confirmed](outbox:one.png)', outbox);
    const path = prepared.chunks[0].options.media![0].path;
    chmodSync(dirname(path), 0o500);
    try {
      prepared.confirm(0); assert.ok(existsSync(path));
      await sendOutboxFiles(outbox, { sendFile: async () => assert.fail('confirmed photo replayed') } as any);
    } finally { chmodSync(dirname(path), 0o700); }
  });
});

it('preserves indented code and its literal outbox examples before media scanning', () => {
  const { chunks } = prepareRichAnswer('    <example>\n\n\n    ![Example](outbox:missing.png)');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, '<example>\n\n\n![Example](outbox:missing.png)');
  assert.equal(chunks[0].options.nativeBlocks![0].type, 'pre');
});

it('never requests server-side media for reference-style external images', () => {
  const { chunks } = prepareRichAnswer('![External][ref]\n\n[ref]: https://example.test/photo.png');
  assert.equal(chunks[0].text, '[External][ref]\n\n[ref]: https://example.test/photo.png');
  assert.throws(() => prepareRichAnswer('![bad [nested]](outbox:missing.png)'), /Malformed inline photo/);
});

it('uses grammY multipart serialization for the actual native final API call', async () => {
  const { Api } = await import('grammy');
  const outbox = mkdtempSync(join(tmpdir(), 'rich-wire-'));
  writeFileSync(join(outbox, 'one.png'), png); writeFileSync(join(outbox, 'two.png'), png);
  const methods: string[] = [];
  const api = new Api('test:fixture', {
    fetch: async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const method = String(url).split('/').at(-1)!;
      methods.push(method);
      if (method === 'sendRichMessageDraft') {
        const payload = JSON.parse(init!.body as string);
        assert.equal(payload.rich_message.media, undefined);
        assert.doesNotMatch(payload.rich_message.markdown, /outbox:|tg:\/\/photo/);
        return Response.json({ ok: true, result: true });
      }
      assert.equal(method, 'sendRichMessage');
      const pieces: Buffer[] = [];
      for await (const piece of init!.body as unknown as AsyncIterable<Uint8Array>) pieces.push(Buffer.from(piece));
      const wire = Buffer.concat(pieces);
      assert.ok(wire.includes(png), 'multipart contains actual image bytes');
      assert.match(wire.toString(), /attach:\/\//);
      assert.match(wire.toString(), /photo_0/); assert.match(wire.toString(), /photo_1/);
      assert.match(wire.toString(), /# Wire report/);
      return Response.json({ ok: true, result: { message_id: 7 } });
    },
  });
  const adapter = createTelegramApiAdapter({ api, chatId: 1, binding: { chatId: 1, kind: 'dm', agentId: 'test', typingIndicator: false } });
  await relayStream(answer('# Wire report\n\nBefore\n\n![One](outbox:one.png)\n\nBetween\n\n![Two](outbox:two.png)'), adapter, outbox);
  assert.deepEqual(methods, ['sendRichMessageDraft', 'sendRichMessage']);
  assert.deepEqual(readdirSync(outbox), []);
});

it('counts empty table cells toward the native column limit', () => {
  const source = `| ${Array(21).fill('').join(' | ')} |\n| ${Array(21).fill('---').join(' | ')} |`;
  const chunk = prepareRichAnswer(source).chunks[0];
  assert.ok(chunk.options.nativeBlocks?.some(block => block.type === 'pre' && block.text === source));
});

it('reserves later-chunk sources before the first API call and retains them after first-chunk failure', async () => {
  const outbox = mkdtempSync(join(tmpdir(), 'rich-first-failure-'));
  writeFileSync(join(outbox, 'one.png'), png); writeFileSync(join(outbox, 'two.png'), png);
  writeFileSync(join(outbox, 'other.txt'), 'ordinary attachment');
  let calls = 0;
  const api: any = {
    async sendRichMessage() {
      calls++;
      assert.ok(!existsSync(join(outbox, 'one.png'))); assert.ok(!existsSync(join(outbox, 'two.png')));
      const root = join(outbox, RICH_RESERVED_DIR);
      const batch = join(root, readdirSync(root)[0]);
      assert.ok(existsSync(join(batch, 'one.png'))); assert.ok(existsSync(join(batch, 'two.png')));
      throw new Error('deterministic 400');
    },
    async sendMessage() { assert.fail('ordinary fallback'); },
    async sendDocument() { assert.fail('standalone delivery after first-chunk failure'); },
  };
  const adapter = createTelegramApiAdapter({ api, chatId: 1, binding: { chatId: 1, agentId: 'test', kind: 'group', typingIndicator: false } });
  await assert.rejects(relayStream(answer(`![First](outbox:one.png)\n\n${'x'.repeat(24000)}\n\n![Last](outbox:two.png)`), adapter, outbox), /Failed to deliver response/);
  assert.equal(calls, 1); assert.ok(existsSync(join(outbox, 'other.txt')));
});

it('short agent answers are rich while service/error sends stay ordinary and indexing stays readable', async () => {
  const { getThread } = await import('../message-thread-cache.js');
  const { lookupMessage } = await import('../message-content-index.js');
  const methods: string[] = [];
  const api: any = {
    async sendRichMessage(_chat: number, rich: any) { methods.push('rich'); assert.equal(rich.markdown, 'Okay.'); return { message_id: 218 }; },
    async sendMessage() { methods.push('ordinary'); return { message_id: 219 }; },
  };
  const adapter = createTelegramApiAdapter({ api, chatId: 1, threadId: 7, binding: { chatId: 1, agentId: 'test', kind: 'group', typingIndicator: false } });
  await relayStream(answer('Okay.'), adapter);
  await adapter.sendMessage('Session recovery notice'); await adapter.replyError('Error notice');
  assert.deepEqual(methods, ['rich', 'ordinary', 'ordinary']);
  assert.equal(getThread(1, 218), 7); assert.match(JSON.stringify(lookupMessage(1, 218)), /Okay\./);
});
