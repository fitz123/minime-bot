export interface CodexTransportOverflowAssistantMessage {
  role?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: unknown;
  diagnostics?: unknown;
  [key: string]: unknown;
}

interface DiagnosticSignals {
  hasStructuredCode1009: boolean;
  hasText1009: boolean;
  hasMessageTooBig: boolean;
  hasWebSocketSignal: boolean;
  hasBeforeStreamStartSignal: boolean;
  requestBytes?: number;
}

const OVERFLOW_ERROR_PREFIX = "context_length_exceeded: Codex request too large";
const MESSAGE_TOO_BIG_RE = /\bmessage[\s_-]*too[\s_-]*big\b/i;
const WEBSOCKET_RE = /\bweb[\s_-]*socket\b/i;
const CODE_1009_RE = /\b1009\b/;
const REQUEST_BYTES_RE = /\brequest[\s_-]*bytes\s*[:=]\s*(\d+)\b/i;
const BEFORE_STREAM_START_RE = /\bbefore(?:[\s_-]*message)?[\s_-]*stream[\s_-]*start\b/i;
const MAX_DIAGNOSTIC_DEPTH = 6;

const CODE_KEYS = new Set([
  "code",
  "closecode",
  "close_code",
  "websocketcode",
  "websocket_code",
  "websocketclosecode",
  "websocket_close_code",
  "wscode",
  "ws_code",
  "wsclosecode",
  "ws_close_code",
]);

const REQUEST_BYTES_KEYS = new Set(["requestbytes", "request_bytes"]);

const SKIPPED_DIAGNOSTIC_KEYS = new Set([
  "content",
  "messages",
  "prompt",
  "prompts",
  "transcript",
  "transcripts",
]);

export function isCodexTransportMessageTooBigDiagnostic(diagnostic: unknown): boolean {
  const signals = collectDiagnosticSignals(diagnostic);
  return isCodexTransportMessageTooBigSignals(signals);
}

export function normalizeCodexTransportOverflowAssistantMessage<T extends CodexTransportOverflowAssistantMessage>(
  message: T,
): T {
  if (!isAssistantErrorMessage(message)) {
    return message;
  }

  const signals = collectDiagnosticSignals([message.errorMessage, message.diagnostics]);
  if (!isCodexTransportMessageTooBigSignals(signals)) {
    return message;
  }

  return {
    ...message,
    errorMessage: formatCodexTransportOverflowErrorMessage(signals),
  };
}

function isAssistantErrorMessage(message: CodexTransportOverflowAssistantMessage): boolean {
  return (
    typeof message.role === "string" &&
    message.role.trim().toLowerCase() === "assistant" &&
    typeof message.stopReason === "string" &&
    message.stopReason.trim().toLowerCase() === "error"
  );
}

function isCodexTransportMessageTooBigSignals(signals: DiagnosticSignals): boolean {
  const hasTransportOverflow =
    signals.hasStructuredCode1009 ||
    (signals.hasMessageTooBig && (signals.hasWebSocketSignal || signals.hasText1009));
  const hasRequestSideSignal = signals.hasBeforeStreamStartSignal || signals.requestBytes !== undefined;
  return hasTransportOverflow && hasRequestSideSignal;
}

function formatCodexTransportOverflowErrorMessage(signals: DiagnosticSignals): string {
  const details = ["WebSocket 1009 message too big"];
  if (signals.requestBytes !== undefined) {
    details.push(`requestBytes=${Math.trunc(signals.requestBytes)}`);
  }
  return `${OVERFLOW_ERROR_PREFIX} (${details.join("; ")})`;
}

function collectDiagnosticSignals(diagnostic: unknown): DiagnosticSignals {
  const signals: DiagnosticSignals = {
    hasStructuredCode1009: false,
    hasText1009: false,
    hasMessageTooBig: false,
    hasWebSocketSignal: false,
    hasBeforeStreamStartSignal: false,
  };
  collectDiagnosticValue(diagnostic, signals, undefined, new Set<object>(), 0);
  return signals;
}

function collectDiagnosticValue(
  value: unknown,
  signals: DiagnosticSignals,
  key: string | undefined,
  seen: Set<object>,
  depth: number,
): void {
  if (depth > MAX_DIAGNOSTIC_DEPTH) {
    return;
  }

  const normalizedKey = key === undefined ? undefined : normalizeKey(key);
  if (normalizedKey && CODE_KEYS.has(normalizedKey) && isCode1009Value(value)) {
    signals.hasStructuredCode1009 = true;
  }
  if (normalizedKey === "phase" && isBeforeStreamStartPhase(value)) {
    signals.hasBeforeStreamStartSignal = true;
  }
  if (normalizedKey && REQUEST_BYTES_KEYS.has(normalizedKey)) {
    const requestBytes = requestBytesValue(value);
    if (requestBytes !== undefined && signals.requestBytes === undefined) {
      signals.requestBytes = requestBytes;
    }
  }

  if (typeof value === "string") {
    collectDiagnosticText(value, signals);
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);

  if (value instanceof Error) {
    collectDiagnosticValue(value.name, signals, "name", seen, depth + 1);
    collectDiagnosticValue(value.message, signals, "message", seen, depth + 1);
    collectDiagnosticValue((value as { cause?: unknown }).cause, signals, "cause", seen, depth + 1);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectDiagnosticValue(item, signals, undefined, seen, depth + 1);
    }
    return;
  }

  for (const [childKey, childValue] of Object.entries(value)) {
    if (SKIPPED_DIAGNOSTIC_KEYS.has(normalizeKey(childKey))) {
      continue;
    }
    collectDiagnosticValue(childValue, signals, childKey, seen, depth + 1);
  }
}

function collectDiagnosticText(value: string, signals: DiagnosticSignals): void {
  if (MESSAGE_TOO_BIG_RE.test(value)) {
    signals.hasMessageTooBig = true;
  }
  if (WEBSOCKET_RE.test(value)) {
    signals.hasWebSocketSignal = true;
  }
  if (CODE_1009_RE.test(value)) {
    signals.hasText1009 = true;
  }
  if (BEFORE_STREAM_START_RE.test(value)) {
    signals.hasBeforeStreamStartSignal = true;
  }
  const requestBytes = REQUEST_BYTES_RE.exec(value)?.[1];
  if (requestBytes !== undefined && signals.requestBytes === undefined) {
    signals.requestBytes = Number(requestBytes);
  }
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();
}

function isCode1009Value(value: unknown): boolean {
  if (typeof value === "number") {
    return value === 1009;
  }
  if (typeof value === "string") {
    return value.trim() === "1009";
  }
  return false;
}

function isBeforeStreamStartPhase(value: unknown): boolean {
  return typeof value === "string" && BEFORE_STREAM_START_RE.test(value);
}

function requestBytesValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}
