import type { RichBlock, RichMessage, RichText, PhotoSize } from "grammy/types";

export const RICH_INTAKE_MAX_PHOTOS = 50;
const MAX_DEPTH = 16;
const MAX_NODES = 2000;
const MAX_TEXT = 32768;

/** One budget for the message and its immediate parent; never follow reply chains. */
export function extractRichIntake(direct?: RichMessage, parent?: RichMessage): {
  text: string; parentText: string; photos: PhotoSize[]; parentPhotoIds: Set<string>;
} {
  let remaining = MAX_TEXT, nodes = MAX_NODES, blockBudget = 500;
  const photos: PhotoSize[] = [];
  const seen = new Set<string>();
  const bound = (text: string) => {
    const result = [...text].slice(0, remaining).join("");
    remaining -= [...result].length;
    return result;
  };
  const richText = (text: RichText | undefined, depth: number): string => {
    if (text === undefined) return "";
    if (depth > MAX_DEPTH || --nodes < 0) return "[Rich text limit]";
    if (typeof text === "string") return bound(text);
    if (Array.isArray(text)) {
      const parts: string[] = [];
      for (const item of text) {
        if (nodes <= 0 || remaining <= 0) { parts.push("[Rich text limit]"); break; }
        parts.push(richText(item, depth + 1));
      }
      return parts.join("");
    }
    if (text.type === "url") return richText(text.text, depth + 1) + bound(` (${text.url})`);
    if ("text" in text) return richText(text.text, depth + 1);
    if (text.type === "custom_emoji") return bound(text.alternative_text);
    if (text.type === "mathematical_expression") return bound(text.expression);
    if (text.type === "anchor") return "";
    return "[Unsupported rich text]";
  };
  const blocks = (items: RichBlock[], depth: number): string => {
    if (depth > MAX_DEPTH || nodes <= 0) return "[Rich content limit]";
    const result: string[] = [];
    for (const block of items) {
      if (--nodes < 0 || --blockBudget < 0 || remaining <= 0) { result.push("[Rich content limit]"); break; }
      let text = "";
      switch (block.type) {
        case "paragraph": case "heading": case "pre": case "footer": case "expandable_blockquote": case "pullquote":
          text = richText(block.text, depth + 1); break;
        case "blockquote": case "collage": case "slideshow":
          text = blocks(block.blocks, depth + 1); break;
        case "details": text = richText(block.summary, depth + 1) + "\n" + blocks(block.blocks, depth + 1); break;
        case "list":
          for (const item of block.items) {
            if (--nodes < 0 || --blockBudget < 0) { text += "\n[Rich list limit]"; break; }
            text += `${richText(item.label, depth + 1)} ${blocks(item.blocks, depth + 1)}\n`;
          }
          break;
        case "table":
          for (const row of block.cells) {
            if (--nodes < 0 || --blockBudget < 0) { text += "\n[Rich table limit]"; break; }
            text += row.slice(0, 20).map(cell => richText(cell.text, depth + 1)).join(" | ") + "\n";
            if (row.length > 20) text += "[Rich table column limit]\n";
          }
          break;
        case "photo": {
          const photo = block.photo.at(-1);
          text = "[Photo]";
          if (photo && !seen.has(photo.file_id)) {
            seen.add(photo.file_id);
            if (photos.length < RICH_INTAKE_MAX_PHOTOS) photos.push(photo);
            else text = "[Photo omitted: attachment limit]";
          }
          break;
        }
        case "divider": text = "---"; break;
        case "anchor": break;
        case "mathematical_expression": text = richText(block.expression, depth + 1); break;
        default: text = `[Unsupported rich media/block: ${block.type}]`;
      }
      if ("credit" in block && block.credit) text += "\n" + richText(block.credit, depth + 1);
      if ("caption" in block && block.caption) {
        const caption = block.caption;
        if (typeof caption === "object" && !Array.isArray(caption) && "text" in caption && !("type" in caption)) {
          text += "\n" + richText(caption.text, depth + 1);
          if (caption.credit) text += "\n" + richText(caption.credit, depth + 1);
        } else text += "\n" + richText(caption as RichText, depth + 1);
      }
      if (text) result.push(text);
    }
    return result.join("\n\n");
  };
  const text = direct ? blocks(direct.blocks, 0) : "";
  const directPhotoCount = photos.length;
  const parentText = parent ? blocks(parent.blocks, 0) : "";
  return { text, parentText, photos, parentPhotoIds: new Set(photos.slice(directPhotoCount).map(photo => photo.file_id)) };
}
