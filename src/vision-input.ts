import { readFileSync, lstatSync } from "node:fs";
import type { ImageContent } from "@earendil-works/pi-ai";

/** Explicit handler-owned downloads only; never discover paths from user prose. */
export function readVisionImages(paths: readonly string[] = []): ImageContent[] | undefined {
  const unique = [...new Set(paths)];
  if (!unique.length) return undefined;
  if (unique.length > 50) throw new Error("Vision attachment limit exceeded");
  let remaining = 20 * 1024 * 1024;
  return unique.map(path => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > remaining) throw new Error("Vision media size or file constraint exceeded");
    const data = readFileSync(path);
    remaining -= data.length;
    const mimeType = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : data.length > 2 && data.readUInt16BE(0) === 0xffd8 ? "image/jpeg" : undefined;
    if (!mimeType) throw new Error("Unsupported vision photo format");
    return { type: "image", mimeType, data: data.toString("base64") };
  });
}
