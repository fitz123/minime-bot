export const MAX_ASK_AGENT_QUESTION_CHARS = 64 * 1024;
export const MAX_ASK_AGENT_QUESTION_BYTES = 64 * 1024;
export const MAX_ASK_AGENT_CONTEXT_CHARS = 64 * 1024;
export const MAX_ASK_AGENT_CONTEXT_BYTES = 64 * 1024;
export const MAX_ASK_AGENT_ANSWER_CHARS = 32 * 1024;
export const MAX_ASK_AGENT_ANSWER_BYTES = 128 * 1024;
export const ASK_AGENT_TRUNCATED_MARKER = "…[truncated]";

export interface AskAgentStructuredResult {
  answer: string;
  truncated: boolean;
  needsClarification: boolean;
}

function takeFittingPrefix(value: string, maxChars: number, maxBytes: number): string {
  let output = "";
  let chars = 0;
  let bytes = 0;
  for (const char of value) {
    const charLength = char.length;
    const byteLength = Buffer.byteLength(char, "utf8");
    if (chars + charLength > maxChars || bytes + byteLength > maxBytes) {
      break;
    }
    output += char;
    chars += charLength;
    bytes += byteLength;
  }
  return output;
}

export function truncateAskAgentAnswer(
  answer: string,
  options?: { maxChars?: number; maxBytes?: number },
): { answer: string; truncated: boolean } {
  const maxChars = options?.maxChars ?? MAX_ASK_AGENT_ANSWER_CHARS;
  const maxBytes = options?.maxBytes ?? MAX_ASK_AGENT_ANSWER_BYTES;
  if (answer.length <= maxChars && Buffer.byteLength(answer, "utf8") <= maxBytes) {
    return { answer, truncated: false };
  }

  const markerBytes = Buffer.byteLength(ASK_AGENT_TRUNCATED_MARKER, "utf8");
  const prefixMaxChars = Math.max(0, maxChars - ASK_AGENT_TRUNCATED_MARKER.length);
  const prefixMaxBytes = Math.max(0, maxBytes - markerBytes);
  const prefix = takeFittingPrefix(answer, prefixMaxChars, prefixMaxBytes);
  return {
    answer: `${prefix}${ASK_AGENT_TRUNCATED_MARKER}`,
    truncated: true,
  };
}

export function isAskAgentClarificationQuestion(answer: string, stopReason?: string): boolean {
  const normalizedStopReason = stopReason?.trim().toLowerCase();
  if (normalizedStopReason === "clarification" || normalizedStopReason === "question") {
    return true;
  }
  return /[?？]\s*$/u.test(answer.trim());
}

export function buildAskAgentStructuredResult(answer: string, stopReason?: string): AskAgentStructuredResult {
  const truncated = truncateAskAgentAnswer(answer);
  return {
    answer: truncated.answer,
    truncated: truncated.truncated,
    needsClarification: isAskAgentClarificationQuestion(answer, stopReason),
  };
}

export function normalizeAskAgentQuestion(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > MAX_ASK_AGENT_QUESTION_CHARS
    || Buffer.byteLength(raw, "utf8") > MAX_ASK_AGENT_QUESTION_BYTES || !raw.trim()) return undefined;
  return raw;
}
