import { readFileSync, lstatSync } from "node:fs";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Explicit handler-owned downloads only; never discover paths from user prose. */
export function readVisionImages(paths: readonly string[] = []): { images?: ImageContent[]; omissionNote: string } {
  const unique = [...new Set(paths)];
  const images: ImageContent[] = [];
  let omitted = 0;
  let remaining = 20 * 1024 * 1024;
  for (const path of unique) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Vision media file constraint exceeded");
    if (images.length >= 50 || stat.size > remaining) { omitted++; continue; }
    const data = readFileSync(path);
    remaining -= data.length;
    const mimeType = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : data.length > 2 && data.readUInt16BE(0) === 0xffd8 ? "image/jpeg" : undefined;
    if (!mimeType) throw new Error("Unsupported vision photo format");
    images.push({ type: "image", mimeType, data: data.toString("base64") });
  }
  return { images: images.length ? images : undefined, omissionNote: omitted ? `\n\n[${omitted} photo(s) omitted from this combined turn: vision limit is 50 photos / 20 MB.]` : "" };
}
