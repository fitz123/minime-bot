import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CRON_DIAGNOSTIC_FILE_NAME = "cron-diagnostics.jsonl";
export const CRON_DIAGNOSTIC_SCHEMA_VERSION = 1;
export const CRON_DIAGNOSTIC_OUTPUT_CHARS = 4_096;
export const CRON_DIAGNOSTIC_SUMMARY_CHARS = 512;

export type CronDiagnosticCronType = "llm" | "script" | "unknown";
export type CronDiagnosticOutcome = "success" | "failure";

export interface CronDiagnosticText {
  text: string;
  sourceChars: number;
  retainedChars: number;
  omittedChars: number;
  truncated: boolean;
  redacted: boolean;
}

export type CronDiagnosticFailureCategory =
  | "delivery_api"
  | "delivery_error"
  | "delivery_preparation"
  | "delivery_subprocess"
  | "delivery_timeout"
  | "execution_error"
  | "execution_timeout"
  | "pi_exit"
  | "pi_output_error"
  | "pi_signal"
  | "pi_spawn"
  | "pi_timeout"
  | "script_exit"
  | "script_failure"
  | "script_signal"
  | "script_timeout";

export interface CronDiagnosticFailure {
  category: CronDiagnosticFailureCategory;
  kind: "error" | "timeout";
  summary: CronDiagnosticText;
  code?: string;
  status?: number;
  signal?: string;
  errorCode?: number;
  timeoutMs?: number;
}

interface CronDiagnosticBase {
  cron: string;
  cronType: CronDiagnosticCronType;
  runId: string;
}

export type CronDiagnosticDisposition =
  | "configuration_failed"
  | "delivered"
  | "delivery_failed"
  | "empty_output"
  | "execution_failed"
  | "fresh_queue_skipped_existing"
  | "fresh_queue_skipped_unreadable"
  | "fresh_queue_write_failed"
  | "fresh_queued"
  | "no_reply"
  | "replay_clear_failed"
  | "replay_deferred"
  | "replay_delivered"
  | "replay_dropped_corrupt"
  | "replay_dropped_expired"
  | "replay_dropped_legacy"
  | "replay_state_failed"
  | "replay_terminal"
  | "replay_write_failed"
  | "usage_error";

export type CronDiagnosticEvent =
  | (CronDiagnosticBase & {
    event: "run_started";
  })
  | (CronDiagnosticBase & {
    detail: "completed" | "logical_failure";
    event: "execution_result";
    outcome: CronDiagnosticOutcome;
    output: CronDiagnosticText;
  })
  | (CronDiagnosticBase & {
    event: "execution_failure";
    failure: CronDiagnosticFailure;
    outcome: "failure";
  })
  | (CronDiagnosticBase & {
    attempt: number;
    delivery: "fresh" | "replay";
    event: "delivery_attempt";
    originalRunId?: string;
    outcome: CronDiagnosticOutcome;
    queueable?: boolean;
    failure?: CronDiagnosticFailure;
  })
  | (CronDiagnosticBase & {
    disposition: CronDiagnosticDisposition;
    event: "disposition";
    originalRunId?: string;
  })
  | (CronDiagnosticBase & {
    disposition:
      | "configuration_failed"
      | "delivered"
      | "delivery_failed"
      | "empty_output"
      | "execution_failed"
      | "no_reply"
      | "usage_error";
    event: "run_terminal";
    outcome: CronDiagnosticOutcome;
  });

export type CronDiagnosticEventPayload = CronDiagnosticEvent extends infer Event
  ? Event extends CronDiagnosticEvent
    ? Omit<Event, "cron" | "cronType" | "runId">
    : never
  : never;

const URL_PATTERN = /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"']+(?=$|[\s<>"'])/gu;
const SENSITIVE_KEY_SUFFIX_PATTERN = /(?:secret[_-]?key|password|passwd|private[_-]?key|access[_-]?key|api[_-]?key|credential|secret|token|pass|pwd)$/iu;
const NAMED_SECRET_PATTERN = /(^|[^\p{L}\p{N}_-])((?:["'][\p{L}\p{N}_-]*(?:secret[_-]?key|password|passwd|private[_-]?key|access[_-]?key|api[_-]?key|credential|secret|token|pass|pwd)["'])|(?:[\p{L}\p{N}_-]*(?:secret[_-]?key|password|passwd|private[_-]?key|access[_-]?key|api[_-]?key|credential|secret|token|pass|pwd)))(\s*[:=]\s*)(?:(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?![|>][+-]?(?:\s|$))[^\s,;}\]]+)/gimu;
const AUTHORIZATION_SECRET_PATTERN = /\b(Authorization\s*:\s*)(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const AUTH_SECRET_PATTERN = /\b(Bearer|Basic)\s+([A-Za-z0-9._~+/=-]{8,})/giu;
const CLEAR_AUTH_TOKEN_PATTERN = /[0-9._~+/=-]/u;
const PRIVATE_KEY_PATTERN = /-----BEGIN ((?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?-----END \1-----/gu;
const PROVIDER_SECRET_PATTERNS = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/gu,
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/gu,
] as const;

interface PreservedLine {
  content: string;
  ending: string;
}

function splitPreservingLineEndings(value: string): PreservedLine[] {
  const lines: PreservedLine[] = [];
  let start = 0;
  while (start < value.length) {
    let end = start;
    while (end < value.length && value[end] !== "\r" && value[end] !== "\n") end += 1;
    let next = end;
    if (value[next] === "\r" && value[next + 1] === "\n") next += 2;
    else if (value[next] === "\r" || value[next] === "\n") next += 1;
    lines.push({ content: value.slice(start, end), ending: value.slice(end, next) });
    start = next;
  }
  return lines;
}

function redactYamlSecretBlocks(value: string): { text: string; redacted: boolean } {
  const lines = splitPreservingLineEndings(value);
  const output: string[] = [];
  let redacted = false;
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    const header = line.content.match(
      /^([ \t]*)(["']?)([\p{L}\p{N}_-]+)\2[ \t]*:[ \t]*[|>][+-]?(?:[ \t]+#[^\r\n]*)?[ \t]*$/iu,
    );
    if (!header || !SENSITIVE_KEY_SUFFIX_PATTERN.test(header[3])) {
      output.push(line.content, line.ending);
      index += 1;
      continue;
    }

    const baseIndent = header[1].length;
    let bodyEnd = index + 1;
    let bodyIndent: string | undefined;
    while (bodyEnd < lines.length) {
      const bodyLine = lines[bodyEnd].content;
      if (bodyLine.trim() === "") {
        bodyEnd += 1;
        continue;
      }
      const indent = bodyLine.match(/^[ \t]*/u)?.[0] ?? "";
      if (indent.length <= baseIndent) break;
      bodyIndent ??= indent;
      bodyEnd += 1;
    }
    if (bodyIndent === undefined) {
      output.push(line.content, line.ending);
      index += 1;
      continue;
    }

    output.push(line.content, line.ending);
    output.push(bodyIndent, "[REDACTED]", lines[bodyEnd - 1].ending);
    redacted = true;
    index = bodyEnd;
  }
  return { text: output.join(""), redacted };
}

function isEscapedJsonQuoteAt(value: string, index: number): boolean {
  return value[index] === "\\"
    && value[index + 1] === '"'
    && value[index - 1] !== "\\";
}

function isEscapedJsonKeyChar(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 48 && code <= 57
    || code >= 65 && code <= 90
    || code >= 97 && code <= 122
    || value === "_"
    || value === "-";
}

function redactEscapedJsonSecrets(value: string): { text: string; redacted: boolean } {
  const output: string[] = [];
  let copyFrom = 0;
  let index = 0;
  let redacted = false;
  while (index + 1 < value.length) {
    if (!isEscapedJsonQuoteAt(value, index)) {
      index += 1;
      continue;
    }

    const keyStart = index + 2;
    let keyEnd = keyStart;
    while (keyEnd < value.length && isEscapedJsonKeyChar(value[keyEnd])) keyEnd += 1;
    if (keyEnd === keyStart || !isEscapedJsonQuoteAt(value, keyEnd)) {
      index = Math.max(index + 2, keyEnd + 1);
      continue;
    }
    const key = value.slice(keyStart, keyEnd);
    index = keyEnd + 2;
    if (!SENSITIVE_KEY_SUFFIX_PATTERN.test(key)) continue;

    while (value[index] === " " || value[index] === "\t") index += 1;
    if (value[index] !== ":") continue;
    index += 1;
    while (value[index] === " " || value[index] === "\t") index += 1;
    if (!isEscapedJsonQuoteAt(value, index)) continue;

    const valueStart = index;
    index += 2;
    let valueEnd: number | undefined;
    while (index + 1 < value.length) {
      if (!isEscapedJsonQuoteAt(value, index)) {
        index += 1;
        continue;
      }
      let afterValue = index + 2;
      while (value[afterValue] === " " || value[afterValue] === "\t") afterValue += 1;
      if (afterValue === value.length || value[afterValue] === ","
        || value[afterValue] === "}" || value[afterValue] === "]") {
        valueEnd = index + 2;
        break;
      }
      index = afterValue;
    }

    output.push(value.slice(copyFrom, valueStart), "[REDACTED]");
    redacted = true;
    if (valueEnd === undefined) {
      copyFrom = value.length;
      index = value.length;
      break;
    }
    copyFrom = valueEnd;
    index = valueEnd;
  }
  if (!redacted) return { text: value, redacted: false };
  output.push(value.slice(copyFrom));
  return { text: output.join(""), redacted: true };
}

function redactCronDiagnosticText(value: string): { text: string; redacted: boolean } {
  const yamlBlocks = redactYamlSecretBlocks(value);
  let redacted = yamlBlocks.redacted;
  let text = yamlBlocks.text
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, " ");
  const escapedJson = redactEscapedJsonSecrets(text);
  text = escapedJson.text;
  redacted ||= escapedJson.redacted;
  text = text.replace(PRIVATE_KEY_PATTERN, () => {
    redacted = true;
    return "[REDACTED_PRIVATE_KEY]";
  });
  text = text.replace(URL_PATTERN, () => {
    redacted = true;
    return "[REDACTED_URL]";
  });
  text = text.replace(AUTHORIZATION_SECRET_PATTERN, (_match, prefix: string, scheme: string) => {
    redacted = true;
    return `${prefix}${scheme} [REDACTED]`;
  });
  text = text.replace(NAMED_SECRET_PATTERN, (
    _match,
    prefix: string,
    name: string,
    separator: string,
  ) => {
    redacted = true;
    return `${prefix}${name}${separator}[REDACTED]`;
  });
  text = text.replace(AUTH_SECRET_PATTERN, (match, scheme: string, token: string) => {
    if (!CLEAR_AUTH_TOKEN_PATTERN.test(token)) return match;
    redacted = true;
    return `${scheme} [REDACTED]`;
  });
  for (const pattern of PROVIDER_SECRET_PATTERNS) {
    text = text.replace(pattern, () => {
      redacted = true;
      return "[REDACTED]";
    });
  }
  return { text, redacted };
}

export function retainCronDiagnosticText(
  value: string,
  maxChars: number,
): CronDiagnosticText {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new Error("cron diagnostic text limit must be a non-negative safe integer");
  }
  const sourceChars = Array.from(value).length;
  const sanitized = redactCronDiagnosticText(value);
  const characters = Array.from(sanitized.text);
  const retained = characters.slice(0, maxChars).join("");
  const omittedChars = Math.max(0, characters.length - maxChars);
  return {
    text: retained,
    sourceChars,
    retainedChars: Array.from(retained).length,
    omittedChars,
    truncated: omittedChars > 0,
    redacted: sanitized.redacted,
  };
}

function boundedMetadata(value: string): string {
  const sanitized = redactCronDiagnosticText(value).text;
  const characters = Array.from(sanitized);
  const limit = 256;
  if (characters.length <= limit) return sanitized;
  let omittedChars = characters.length - limit;
  let suffix = "";
  let retainedChars = limit;
  while (true) {
    suffix = ` [truncated ${omittedChars} chars]`;
    retainedChars = Math.max(0, limit - Array.from(suffix).length);
    const actualOmittedChars = characters.length - retainedChars;
    if (actualOmittedChars === omittedChars) break;
    omittedChars = actualOmittedChars;
  }
  return characters.slice(0, retainedChars).join("") + suffix;
}

function commonRecord(event: CronDiagnosticEvent): Record<string, unknown> {
  return {
    schemaVersion: CRON_DIAGNOSTIC_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    event: event.event,
    runId: boundedMetadata(event.runId),
    cron: boundedMetadata(event.cron),
    cronType: event.cronType,
  };
}

function textRecord(value: CronDiagnosticText): CronDiagnosticText {
  return {
    text: value.text,
    sourceChars: value.sourceChars,
    retainedChars: value.retainedChars,
    omittedChars: value.omittedChars,
    truncated: value.truncated,
    redacted: value.redacted,
  };
}

function failureRecord(value: CronDiagnosticFailure): Record<string, unknown> {
  const record: Record<string, unknown> = {
    category: value.category,
    kind: value.kind,
    summary: textRecord(value.summary),
  };
  if (value.code !== undefined) record.code = value.code;
  if (value.status !== undefined) record.status = value.status;
  if (value.signal !== undefined) record.signal = value.signal;
  if (value.errorCode !== undefined) record.errorCode = value.errorCode;
  if (value.timeoutMs !== undefined) record.timeoutMs = value.timeoutMs;
  return record;
}

export function serializeCronDiagnosticEvent(event: CronDiagnosticEvent): string {
  const record = commonRecord(event);
  switch (event.event) {
    case "run_started":
      break;
    case "execution_result":
      Object.assign(record, {
        outcome: event.outcome,
        detail: event.detail,
        output: textRecord(event.output),
      });
      break;
    case "execution_failure":
      Object.assign(record, {
        outcome: event.outcome,
        failure: failureRecord(event.failure),
      });
      break;
    case "delivery_attempt":
      Object.assign(record, {
        delivery: event.delivery,
        attempt: event.attempt,
        outcome: event.outcome,
      });
      if (event.originalRunId !== undefined) {
        record.originalRunId = boundedMetadata(event.originalRunId);
      }
      if (event.queueable !== undefined) record.queueable = event.queueable;
      if (event.failure !== undefined) record.failure = failureRecord(event.failure);
      break;
    case "disposition":
      record.disposition = event.disposition;
      if (event.originalRunId !== undefined) {
        record.originalRunId = boundedMetadata(event.originalRunId);
      }
      break;
    case "run_terminal":
      Object.assign(record, {
        outcome: event.outcome,
        disposition: event.disposition,
      });
      break;
  }
  return JSON.stringify(record);
}

export function resolveCronDiagnosticPath(logDir?: string): string {
  const configured = logDir ?? process.env.LOG_DIR;
  const directory = configured?.trim()
    ? resolve(configured)
    : join(homedir(), ".minime", "logs");
  return join(directory, CRON_DIAGNOSTIC_FILE_NAME);
}

export function writeCronDiagnosticEvent(
  event: CronDiagnosticEvent,
  logDir?: string,
): void {
  const filePath = resolveCronDiagnosticPath(logDir);
  const directory = dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("cron diagnostic log directory is not a safe directory");
  }

  const flags = constants.O_WRONLY
    | constants.O_CREAT
    | constants.O_APPEND
    | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(filePath, flags, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("cron diagnostic log is not a regular file");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error("cron diagnostic log is not owned by the current user");
    }
    fchmodSync(fd, 0o600);
    const line = `${serializeCronDiagnosticEvent(event)}\n`;
    const bytes = Buffer.from(line, "utf8");
    const written = writeSync(fd, bytes, 0, bytes.length);
    if (written !== bytes.length) {
      throw new Error("cron diagnostic log append was incomplete");
    }
  } finally {
    closeSync(fd);
  }
}
