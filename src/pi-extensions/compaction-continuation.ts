export const PI_COMPACTION_CONTINUATION_CUSTOM_TYPE =
  "minime-compaction-continuation";

export const PI_COMPACTION_CONTINUATION_CONTENT =
  "Continue the interrupted response from where it stopped. Do not repeat completed content or mention this continuation message.";

interface PiAgentEndMessage {
  role?: unknown;
  stopReason?: unknown;
  content?: unknown;
}

export interface PiCompactionBoundary {
  reason?: unknown;
  willRetry?: unknown;
}

export function isReasoningOnlyLengthAgentEnd(
  messages: readonly unknown[],
): boolean {
  const finalAssistant = findFinalAssistant(messages);
  return (
    finalAssistant?.stopReason === "length" &&
    !hasNonWhitespaceVisibleText(finalAssistant.content)
  );
}

export function isSuccessfulThresholdCompaction(
  boundary: PiCompactionBoundary,
): boolean {
  return boundary.reason === "threshold" && boundary.willRetry === false;
}

export class PiCompactionContinuationGate {
  private armed = false;

  observeAgentEnd(messages: readonly unknown[]): void {
    this.armed = isReasoningOnlyLengthAgentEnd(messages);
  }

  observeCompactionStart(boundary: PiCompactionBoundary): void {
    if (!isSuccessfulThresholdCompaction(boundary)) {
      this.clear();
    }
  }

  consumeCompaction(boundary: PiCompactionBoundary): boolean {
    const shouldContinue =
      this.armed && isSuccessfulThresholdCompaction(boundary);
    this.clear();
    return shouldContinue;
  }

  clear(): void {
    this.armed = false;
  }
}

function findFinalAssistant(
  messages: readonly unknown[],
): PiAgentEndMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      typeof message === "object" &&
      message !== null &&
      (message as PiAgentEndMessage).role === "assistant"
    ) {
      return message as PiAgentEndMessage;
    }
  }
  return undefined;
}

function hasNonWhitespaceVisibleText(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return true;
  }
  return content.some(
    (block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      (typeof (block as { text?: unknown }).text !== "string" ||
        (block as { text: string }).text.trim().length > 0),
  );
}
