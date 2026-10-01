import { lstatSync, readFileSync, mkdirSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { RichText, InputRichMessageWithoutUpload } from "grammy/types";
import type { AgentAnswerOptions } from "./types.js";
import { log } from "./logger.js";
import { linkDestinationEnd } from "./markdown-html.js";

/** Deliberately below native 32768-character / 500-block / 50-media limits. */
export const RICH_TEXT_BYTES = 24_000;
export const RICH_RESERVED_DIR = ".rich-reserved";
const MAX_LINES = 180;
const MAX_PHOTOS = 40;

export interface RichAnswerChunk {
  text: string;
  options: AgentAnswerOptions;
}

/** Split by Unicode scalar values; never emit half of a surrogate pair. */
function byteSlices(text: string, limit: number): string[] {
  const parts: string[] = [];
  let part = "", bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char);
    if (bytes + size > limit) { parts.push(part); part = ""; bytes = 0; }
    part += char;
    bytes += size;
  }
  if (part) parts.push(part);
  return parts;
}

/** Scan source blocks, retaining fence contents (including blank lines) verbatim. */
function sourceBlocks(source: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [], fence: string | undefined, indented = false;
  for (const line of source.split("\n")) {
    if (!fence && (indented || current.length === 0) && /^(?: {4}|\t)/.test(line)) indented = true;
    if (indented) {
      if (!line.trim() || /^(?: {4}|\t)/.test(line)) { current.push(line); continue; }
      blocks.push(current.join("\n")); current = []; indented = false;
    }
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker && !fence) {
      if (current.length) blocks.push(current.join("\n"));
      current = []; fence = marker[1];
    } else if (fence && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) {
      current.push(line); blocks.push(current.join("\n")); current = []; fence = undefined; continue;
    }
    if (!fence && !line.trim()) {
      if (current.length) blocks.push(current.join("\n"));
      current = [];
    } else current.push(line);
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}

/** Only explicit Markdown image syntax outside code participates in local custody. */
function mapImages(source: string, replace: (caption: string, target: string) => string): string {
  return source.replace(/(`+)[\s\S]*?\1|(?<!\\)!\[([^\]\n]*)\]\(([^)\n]+)\)|(?<!\\)!\[/g,
    (whole, code: string | undefined, caption: string | undefined, target: string | undefined, offset: number) => {
      if (code) return whole;
      if (caption !== undefined && target !== undefined) return replace(caption, target.replace(/\s+"[^"\n]*"$/, ""));
      if (source.slice(offset).split("\n")[0].includes("(outbox:")) throw new Error("Malformed inline photo reference; use ![caption](outbox:basename.png)");
      // Reference-style or incomplete external image syntax must not ask the server to fetch media.
      return "\\![";
    });
}

const INLINE_HTML_TYPES = {
  b: "bold", strong: "bold", i: "italic", em: "italic", u: "underline",
  s: "strikethrough", strike: "strikethrough", del: "strikethrough",
  sup: "superscript", sub: "subscript", mark: "marked", "tg-spoiler": "spoiler",
} as const;

function excessiveFormattingDepth(text: string): boolean {
  let depth = 0;
  for (const match of text.matchAll(/<(\/?)(b|strong|i|em|u|s|strike|del|sup|sub|mark|tg-spoiler)>/g)) {
    depth = Math.max(0, depth + (match[1] ? -1 : 1));
    if (depth > 12) return true;
  }
  return /[*_~|=]{33}/.test(text);
}

function needsLiteralEncoding(text: string): boolean {
  const outsideCode = text.replace(/(`+)[\s\S]*?\1/g, "");
  return (outsideCode.match(/<[^<>\n]+>/g) ?? []).some(tag => {
    const name = tag.match(/^<\/?([\w-]+)>$/)?.[1];
    return !name || !(name in INLINE_HTML_TYPES) || !new RegExp(`<${name}>[\\s\\S]*?</${name}>`).test(outsideCode);
  });
}

/** Native RichText for source-context literals: no HTML escape round trip.
 * Only inline formatting in these paragraphs is scanned; this is not a document AST.
 */
export function literalRichText(text: string, depth = 0): RichText {
  if (depth >= 6) return text;
  const parts: RichText[] = [];
  const tokens = /\\[\\`*_[\]{}()#+.!<>~-]|(`+)([\s\S]*?)\1|<(b|strong|i|em|u|s|strike|del|sup|sub|mark|tg-spoiler)>([\s\S]*?)<\/\3>|(\*\*|__|~~|==|\|\||\*|_)([^\n]+?)\5|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|https?:\/\/[^\s<>]+/g;
  let end = 0;
  for (let match; (match = tokens.exec(text));) {
    if (match[7]) {
      const urlStart = match.index + match[0].indexOf("](") + 2;
      const pos = linkDestinationEnd(text, urlStart);
      if (pos === undefined || !/^https?:\/\/\S+$/.test(text.slice(urlStart, pos - 1))) continue;
      match[8] = text.slice(urlStart, pos - 1);
      match[0] = text.slice(match.index, pos);
      tokens.lastIndex = pos;
    }
    if (match[5]) {
      const before = text[match.index! - 1] ?? "";
      const after = text[match.index! + match[0].length] ?? "";
      const inner = match[6];
      // Emphasis cannot open/close against whitespace. Underscores within
      // identifiers are literal (CommonMark's intraword underscore rule).
      if (/^\s|\s$/.test(inner) || (match[5].includes("_")
        && (/[\p{L}\p{N}_]/u.test(before) || /[\p{L}\p{N}_]/u.test(after)))) {
        tokens.lastIndex = match.index + match[5].length;
        continue;
      }
    }
    if (match.index! > end) parts.push(text.slice(end, match.index));
    if (match[0].startsWith("\\")) parts.push(match[0].slice(1));
    else if (match[1]) parts.push({ type: "code", text: match[2] });
    else if (match[3]) parts.push({ type: INLINE_HTML_TYPES[match[3] as keyof typeof INLINE_HTML_TYPES], text: literalRichText(match[4], depth + 1) });
    else if (match[5]) {
      const types = { "**": "bold", "__": "bold", "~~": "strikethrough", "==": "marked", "||": "spoiler", "*": "italic", "_": "italic" } as const;
      parts.push({ type: types[match[5] as keyof typeof types], text: literalRichText(match[6], depth + 1) });
    } else if (match[7]) parts.push({ type: "url", text: literalRichText(match[7], depth + 1), url: match[8] });
    else parts.push(match[0]); // A bare URL is opaque to emphasis scanning.
    end = match.index! + match[0].length;
  }
  if (end < text.length) parts.push(text.slice(end));
  return parts.length === 1 ? parts[0] : parts;
}

export function richDraftPayload(source: string): InputRichMessageWithoutUpload {
  const text = richDraft(source);
  if (blockCost(text) > 400 || excessiveFormattingDepth(text)) return { blocks: [{ type: "pre", text }] };
  return needsLiteralEncoding(text) ? { blocks: [{ type: "paragraph", text: literalRichText(text) }] } : { markdown: text };
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/)
    .map(cell => cell.trim().replace(/\\\|/g, "|"));
}

function blockCost(text: string): number {
  return text.split("\n").reduce((sum, line) => sum + 2 + (line.match(/>/g)?.length ?? 0)
    + Math.floor((line.match(/^ */)?.[0].length ?? 0) / 2), 0);
}

function isIndentedCode(block: string): boolean { return /^(?: {4}|\t)/.test(block); }

function isFence(block: string): boolean { return /^ {0,3}(`{3,}|~{3,})/.test(block); }

/** Text-only bounded projection; full authoritative source never undergoes tail slicing. */
export function richDraft(source: string): string {
  const blocks = sourceBlocks(source);
  const parts: string[] = [];
  let bytes = 0;
  for (const block of blocks.slice(-80).reverse()) {
    let part = isFence(block) || isIndentedCode(block) ? block : mapImages(block,
      (caption) => `[Image${caption ? `: ${caption}` : ""}]`);
    if (isFence(part)) {
      const lines = part.split("\n");
      const opener = lines.shift()!;
      const marker = opener.match(/(`{3,}|~{3,})/)![1];
      if (new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines.at(-1) ?? "")) lines.pop();
      // Select within the source block, then restore its fence context. Never
      // interpret a window beginning inside code as ordinary Markdown.
      const contextBytes = Buffer.byteLength(opener + marker) + 2;
      if (contextBytes > 3500) continue; // No safe preview window for this fence.
      const content = byteTail(lines.join("\n"), 3500 - contextBytes);
      part = `${opener}\n${content}\n${marker}`;
    } else if (Buffer.byteLength(part) > 3500) {
      part = byteTail(part, 3500);
      if (isIndentedCode(block)) part = "    " + byteTail(part, 3496);
    }
    const size = Buffer.byteLength(part) + (parts.length ? 2 : 0);
    if (bytes + size > 3500) break;
    parts.unshift(part); bytes += size;
  }
  return parts.join("\n\n");
}

function byteTail(text: string, limit: number): string {
  const chars = Array.from(text);
  let bytes = 0, start = chars.length;
  while (start > 0 && bytes + Buffer.byteLength(chars[start - 1]) <= limit) bytes += Buffer.byteLength(chars[--start]);
  return chars.slice(start).join("");
}

/** Native equivalents only for the simple blocks we already handle. Complex
 * Markdown remains on its server-parsed path; this is not a document parser. */
function compatibleNativeBlocks(text: string): InputRichMessageWithoutUpload["blocks"] | undefined {
  const result: NonNullable<InputRichMessageWithoutUpload["blocks"]> = [];
  for (const block of sourceBlocks(text)) {
    const photo = block.match(/^!\[([^\]]*)\]\(tg:\/\/photo\?id=([^)]+)\)$/);
    if (photo) {
      result.push({ type: "photo", photo: { type: "photo", media: photo[2] }, caption: { text: literalRichText(photo[1]) } });
      continue;
    }
    const rows = block.split("\n");
    if (rows.length >= 2 && /^\s*\|?\s*:?-{3,}/.test(rows[1])) {
      result.push({ type: "table", cells: [rows[0], ...rows.slice(2)].map((row, i) => tableCells(row).map((cell, j) => ({
        text: literalRichText(cell), ...(i === 0 ? { is_header: true as const } : {}),
        align: tableCells(rows[1])[j]?.endsWith(":") ? tableCells(rows[1])[j]?.startsWith(":") ? "center" : "right" : "left", valign: "top",
      }))) });
      continue;
    }
    // Leave lists, quotations, reference links, math and block HTML to native Markdown.
    const syntax = block.replace(/(`+)[\s\S]*?\1/g, "");
    if (/^\s*(?:[-*+] |\d+[.)] |> ?|(?:[-*_]{3,}|=+)\s*$|\[.+\]:|\$\$)/m.test(syntax)
      || /\[\^|\]\((?!https?:\/\/)|\$[^$]+\$|\]\[[^\]]*\]|<\/?(?:div|details|summary|table|ul|ol|li|p|h[1-6])\b/i.test(syntax)) return undefined;
    let paragraph: string[] = [];
    const flushParagraph = () => {
      if (paragraph.length) result.push({ type: "paragraph", text: literalRichText(paragraph.join("\n")) });
      paragraph = [];
    };
    for (const line of rows) {
      const heading = line.match(/^(#{1,6}) (.+)$/);
      if (heading) {
        flushParagraph();
        result.push({ type: "heading", size: heading[1].length as 1 | 2 | 3 | 4 | 5 | 6, text: literalRichText(heading[2]) });
      } else paragraph.push(line);
    }
    flushParagraph();
  }
  return result;
}

function packCompatibleChunks(chunks: RichAnswerChunk[]): void {
  for (let i = 1; i < chunks.length;) {
    const left = chunks[i - 1], right = chunks[i];
    const text = `${left.text}\n\n${right.text}`;
    if ((left.options.nativeBlocks || right.options.nativeBlocks) && Buffer.byteLength(text) <= RICH_TEXT_BYTES
      && blockCost(text) <= 400 && (text.match(/tg:\/\/photo\?id=/g)?.length ?? 0) <= MAX_PHOTOS) {
      const a = left.options.nativeBlocks ?? compatibleNativeBlocks(left.text);
      const b = right.options.nativeBlocks ?? compatibleNativeBlocks(right.text);
      if (a && b && a.length + b.length <= 400) {
        left.text = text;
        left.options.nativeBlocks = [...a, ...b];
        chunks.splice(i, 1);
        continue;
      }
    }
    i++;
  }
}

/** JPEG/PNG only: Telegram photo dimensions and bytes, inspected independently of suffix. */
export function validateRichPhoto(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw new Error("Inline photo must be a regular JPEG/PNG file of at most 10 MB");
  const data = readFileSync(path);
  let width = 0, height = 0;
  if (data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.toString("ascii", 12, 16) === "IHDR" && data.toString("ascii", data.length - 8, data.length - 4) === "IEND") {
    let offset = 8, hasData = false, hasEnd = false;
    while (offset + 12 <= data.length) {
      const length = data.readUInt32BE(offset);
      if (offset + length + 12 > data.length) break;
      const type = data.toString("ascii", offset + 4, offset + 8);
      if (offset === 8 && type === "IHDR" && length === 13) {
        width = data.readUInt32BE(16); height = data.readUInt32BE(20);
      }
      if (type === "IDAT" && length > 0) hasData = true;
      if (type === "IEND" && length === 0 && offset + 12 === data.length) hasEnd = true;
      offset += length + 12;
    }
    if (!hasData || !hasEnd) width = 0;
  } else if (data.length > 4 && data.readUInt16BE(0) === 0xffd8 && data.readUInt16BE(data.length - 2) === 0xffd9) {
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset] !== 0xff) break;
      const marker = data[offset + 1];
      const length = data.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
        height = data.readUInt16BE(offset + 5); width = data.readUInt16BE(offset + 7); break;
      }
      offset += length + 2;
    }
  }
  if (!width || !height || width + height > 10_000 || Math.max(width / height, height / width) > 20) {
    throw new Error("Inline photo has unsupported format or dimensions (JPEG/PNG, width + height <= 10000, ratio <= 20 required)");
  }
}

/** Preflight every chunk and source before reserving anything or making a final API call. */
export function prepareRichAnswer(source: string, outboxPath?: string): {
  chunks: RichAnswerChunk[];
  confirm: (index: number) => void;
} {
  const chunks: RichAnswerChunk[] = [];
  const names = new Map<string, string>();
  let pending = "";
  const flush = () => {
    if (pending) chunks.push({ text: pending, options: { purpose: "agent-answer" } });
    pending = "";
  };
  const literal = (text: string, language?: string, normalized = false) => {
    flush();
    for (const part of byteSlices(text, RICH_TEXT_BYTES)) chunks.push({ text: part, options: { purpose: "agent-answer", nativeBlocks: [...(normalized ? [{ type: "paragraph" as const, text: "[Formatting normalized to literal text to fit Telegram limits.]" }] : []), { type: "pre", text: part, ...(language ? { language } : {}) }] } });
  };
  const append = (text: string) => {
    const photoCaption = text.match(/^!\[([^\]]*)\]\(tg:\/\/photo\?id=[^)]+\)$/)?.[1];
    if (needsLiteralEncoding(text) || (photoCaption !== undefined && /["\\]/.test(photoCaption))) {
      flush();
      chunks.push({ text, options: { purpose: "agent-answer", nativeBlocks: compatibleNativeBlocks(text)
        ?? [{ type: "paragraph", text: literalRichText(text) }] } });
      return;
    }
    const candidate = pending ? `${pending}\n\n${text}` : text;
    if (Buffer.byteLength(candidate) > RICH_TEXT_BYTES || candidate.split("\n").length > MAX_LINES || blockCost(candidate) > 400
      || (candidate.match(/tg:\/\/photo\?id=/g)?.length ?? 0) > MAX_PHOTOS) flush();
    pending = pending ? `${pending}\n\n${text}` : text;
  };
  // Native media must be separate blocks. Also protects local references from
  // oversized paragraph normalization and gives each request its own media budget.
  const blocks = sourceBlocks(source).flatMap(block => {
    if (isFence(block) || isIndentedCode(block) || /^\s*\|?\s*:?-{3,}/.test(block.split("\n")[1] ?? "")) return [block];
    return sourceBlocks(mapImages(block, (caption, target) => `\n\n![${caption}](${target})\n\n`));
  });
  for (const block of blocks) {
    if (isIndentedCode(block)) {
      literal(block.replace(/^(?: {4}|\t)/gm, "")); continue;
    }
    if (isFence(block)) {
      const lines = block.split("\n");
      const marker = lines.shift()!.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)!;
      if (new RegExp(`^ {0,3}${marker[1][0]}{${marker[1].length},}\\s*$`).test(lines.at(-1) ?? "")) lines.pop();
      // Native pre blocks preserve blank lines and literal HTML without parser round trips.
      literal(lines.join("\n"), marker[2].trim() || undefined);
      continue;
    }
    const lines = block.split("\n");
    const table = lines.length >= 2 && /^\s*\|?\s*:?-{3,}/.test(lines[1]);
    const tooNested = excessiveFormattingDepth(block) || lines.some(line => /^(?:\s*>){13}/.test(line) || /^ {24,}(?:[-*+] |\d+\. )/.test(line));
    if (tooNested || (table && lines.some(line => tableCells(line).length > 20))) {
      log.warn("telegram-rich", "Rich formatting normalized to literal text: nesting/table limit");
      literal(block, undefined, true); continue;
    }
    const text = mapImages(block, (caption, target) => {
      if (!target.startsWith("outbox:")) return `[${caption || "Image"}](${target})`;
      if (table) throw new Error("Inline photos must be outside table cells; place the photo between paragraphs");
      const name = target.slice(7);
      if (!name || name !== basename(name) || /[\\/\s\x00-\x1f]/.test(name) || name === "." || name === "..") throw new Error("Inline photo requires an outbox basename");
      if (!names.has(name)) names.set(name, `photo_${names.size}`);
      return `![${caption}](tg://photo?id=${names.get(name)})`;
    });
    if (table && (Buffer.byteLength(text) > RICH_TEXT_BYTES || lines.length > MAX_LINES)) {
      const rows = text.split("\n");
      const header = rows.slice(0, 2).join("\n");
      if (Buffer.byteLength(header) > RICH_TEXT_BYTES / 2 || rows.some(row => Buffer.byteLength(row) > RICH_TEXT_BYTES / 2)) {
        log.warn("telegram-rich", "Rich formatting normalized to literal text: oversized table row");
        literal(block, undefined, true); continue;
      }
      let section = header;
      for (const row of rows.slice(2)) {
        if (Buffer.byteLength(section + "\n" + row) > RICH_TEXT_BYTES || section.split("\n").length >= MAX_LINES) {
          append(section); flush(); section = header;
        }
        section += "\n" + row;
      }
      append(section); continue;
    }
    if (Buffer.byteLength(text) > RICH_TEXT_BYTES || lines.length > MAX_LINES || blockCost(text) > 400) {
      if (text.includes("tg://photo?id=")) throw new Error("Inline photo caption exceeds rich message limits");
      // Split large plain paragraphs safely; complex oversized syntax remains literal.
      log.warn("telegram-rich", "Rich formatting normalized to literal text: oversized block");
      literal(block, undefined, true); continue;
    }
    append(text);
  }
  flush();
  packCompatibleChunks(chunks);
  // Only references actually retained as media need custody (literal examples do not).
  for (const [name, id] of names) {
    if (!chunks.some(chunk => (!chunk.options.nativeBlocks || chunk.options.nativeBlocks.some(block => block.type === "photo")) && chunk.text.includes(`tg://photo?id=${id})`))) names.delete(name);
  }
  if (names.size) {
    if (!outboxPath) throw new Error("Inline photo requires a session outbox");
    const dir = lstatSync(outboxPath);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error("Unsafe inline photo outbox");
    for (const name of names.keys()) validateRichPhoto(join(outboxPath, name));
  }
  const reserved = new Map<string, { path: string; pending: Set<number> }>();
  let reservationDir: string | undefined;
  if (names.size && outboxPath) {
    const root = join(outboxPath, RICH_RESERVED_DIR);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (lstatSync(root).isSymbolicLink()) throw new Error("Unsafe inline photo reservation directory");
    const batch = join(root, randomUUID());
    mkdirSync(batch, { mode: 0o700 });
    reservationDir = batch;
    log.info("telegram-rich", `Inline photos reserved in ${RICH_RESERVED_DIR}/${basename(batch)}; retained until all referencing chunks are confirmed`);
    for (const [name, id] of names) {
      const path = join(batch, name);
      renameSync(join(outboxPath, name), path);
      reserved.set(id, { path, pending: new Set() });
    }
  }
  chunks.forEach((chunk, index) => {
    const media = [...reserved].filter(([id]) => (!chunk.options.nativeBlocks || chunk.options.nativeBlocks.some(block => block.type === "photo")) && chunk.text.includes(`tg://photo?id=${id})`));
    chunk.options.media = media.map(([id, file]) => { file.pending.add(index); return { id, path: file.path }; });
    chunk.options.indexText = chunk.text.replace(/!\[([^\]]*)\]\(tg:\/\/photo\?id=[^)]+\)/g, (_, caption) => `[Image${caption ? `: ${caption}` : ""}]`);
    // In native Markdown the image title carries the visible media caption.
    // Captions requiring literal handling already use a native photo block.
    if (!chunk.options.nativeBlocks) chunk.text = chunk.text.replace(/!\[([^\]]*)\]\(tg:\/\/photo\?id=([^)]+)\)/g,
      (_, caption: string, id: string) => `![](tg://photo?id=${id}${caption ? ` "${caption}"` : ""})`);
  });
  return { chunks, confirm(index) {
    for (const file of reserved.values()) {
      if (!file.pending.delete(index) || file.pending.size) continue;
      try { unlinkSync(file.path); } catch { log.warn("telegram-rich", "Confirmed inline photo cleanup failed; retained in excluded reservation directory"); }
    }
    if (reservationDir && [...reserved.values()].every(file => file.pending.size === 0)) {
      // Only remove empty directories owned by this delivery. Failed unlink stays excluded.
      try { rmdirSync(reservationDir); } catch { return; }
      try { rmdirSync(join(outboxPath!, RICH_RESERVED_DIR)); } catch { /* another delivery may still hold files */ }
    }
  } };
}
