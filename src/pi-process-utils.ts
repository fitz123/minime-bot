/** Normalize output returned by Node's process APIs before classification. */
export function normalizePiProcessOutput(
  value: string | Buffer | null | undefined,
): string {
  if (value === undefined || value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}

/**
 * Remove terminal escapes and non-printing control bytes from captured Pi
 * output before it is included in diagnostics or durable evidence.
 */
export function sanitizePiProcessOutput(value: string): string {
  return value
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "?")
    .trim();
}
