import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseDocument } from "yaml";
import {
  resolveSecret as resolveConfiguredSecret,
  type ResolveSecretOptions,
} from "../secrets.js";
import { isOpsWorkerRegisteredName } from "./types.js";

const MAX_CONTROL_CONFIG_BYTES = 64 * 1024;
const MAX_SECRET_BYTES = 4 * 1024;
const MAX_OPERATORS = 64;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TELEGRAM_CHAT_ID_PATTERN = /^-?(?:0|[1-9][0-9]{0,19})$/;
const TELEGRAM_OPERATOR_ID_PATTERN = /^(?:0|[1-9][0-9]{0,19})$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1"]);
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

export interface OpsWorkerControlTelegramConfig {
  token: string;
  controlChatId: string;
  operatorIds: string[];
}

export interface OpsWorkerControlIntakeConfig {
  host: "127.0.0.1" | "::1";
  port: number;
  bearerToken: string;
  sourceIdentity: string;
}

export interface OpsWorkerControlPollTuning {
  longPollSeconds: number;
  requestTimeoutMs: number;
  retryMinMs: number;
  retryMaxMs: number;
  maxResponseBytes: number;
}

export interface OpsWorkerControlReplyTuning {
  maxBytes: number;
}

export interface OpsWorkerControlConfig {
  telegram: OpsWorkerControlTelegramConfig;
  intake: OpsWorkerControlIntakeConfig | undefined;
  poll: OpsWorkerControlPollTuning;
  reply: OpsWorkerControlReplyTuning;
}

export const DEFAULT_OPS_WORKER_CONTROL_POLL_TUNING:
Readonly<OpsWorkerControlPollTuning> = Object.freeze({
  longPollSeconds: 30,
  requestTimeoutMs: 35_000,
  retryMinMs: 250,
  retryMaxMs: 5_000,
  maxResponseBytes: 256 * 1024,
});

export const DEFAULT_OPS_WORKER_CONTROL_REPLY_TUNING:
Readonly<OpsWorkerControlReplyTuning> = Object.freeze({
  maxBytes: 3_500,
});

export interface LoadOpsWorkerControlConfigOptions {
  env?: NodeJS.ProcessEnv;
  resolveSecret?: (options: ResolveSecretOptions) => string;
}

export class OpsWorkerControlConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsWorkerControlConfigError";
  }
}

function fail(message: string): never {
  throw new OpsWorkerControlConfigError(message);
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)
  ) fail(`${path} must be a plain object`);
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) fail(`${path}.${key} is an unknown field`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      fail(`${path}.${key} is required`);
    }
  }
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${path} must be a non-empty string`);
  }
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${path} must not contain surrounding whitespace or control characters`);
  }
  return value;
}

function expectInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    fail(`${path} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function expectTelegramId(
  value: unknown,
  path: string,
  pattern: RegExp,
): string {
  const id = expectString(value, path);
  const numeric = Number(id);
  if (
    !pattern.test(id)
    || !Number.isSafeInteger(numeric)
    || String(numeric) !== id
  ) fail(`${path} must be a canonical safe Telegram integer id string`);
  return id;
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  path: string,
): number {
  return value[key] === undefined
    ? fallback
    : expectInteger(value[key], `${path}.${key}`, minimum, maximum);
}

function resolveSecretSource(
  value: Record<string, unknown>,
  options: {
    envKey: string;
    sopsKey: string;
    sopsFileKey: string;
    fieldName: string;
    configDirectory: string;
    env?: NodeJS.ProcessEnv;
    resolver: (options: ResolveSecretOptions) => string;
  },
): string {
  const envValue = value[options.envKey];
  const sopsKeyValue = value[options.sopsKey];
  const sopsFileValue = value[options.sopsFileKey];
  const hasEnv = envValue !== undefined;
  const hasSopsKey = sopsKeyValue !== undefined;
  const hasSopsFile = sopsFileValue !== undefined;
  if ((hasEnv ? 1 : 0) + (hasSopsKey && hasSopsFile ? 1 : 0) !== 1
    || hasSopsKey !== hasSopsFile) {
    fail(`${options.fieldName} must configure exactly one token source: ${options.envKey} or ${options.sopsFileKey}+${options.sopsKey}`);
  }
  let resolved: string;
  if (hasEnv) {
    const envVar = expectString(envValue, options.envKey);
    if (!ENV_NAME_PATTERN.test(envVar)) fail(`${options.envKey} is not a valid environment variable name`);
    resolved = options.resolver({
      envVar,
      fieldName: options.fieldName,
      env: options.env,
    });
  } else {
    const rawFile = expectString(sopsFileValue, options.sopsFileKey);
    const sopsFile = isAbsolute(rawFile)
      ? resolve(rawFile)
      : resolve(options.configDirectory, rawFile);
    resolved = options.resolver({
      sopsFile,
      sopsKey: expectString(sopsKeyValue, options.sopsKey),
      fieldName: options.fieldName,
      env: options.env,
    });
  }
  if (
    resolved.trim() === ""
    || resolved !== resolved.trim()
    || /[\u0000-\u0020\u007f]/.test(resolved)
    || Buffer.byteLength(resolved, "utf8") > MAX_SECRET_BYTES
  ) fail(`${options.fieldName} resolved to an invalid bounded secret`);
  return resolved;
}

function parseTelegram(
  value: unknown,
  configDirectory: string,
  options: LoadOpsWorkerControlConfigOptions,
): OpsWorkerControlTelegramConfig {
  const telegram = expectObject(value, "telegram");
  assertKeys(
    telegram,
    ["tokenEnv", "sopsFile", "tokenSopsKey", "controlChatId", "operatorIds"],
    ["controlChatId", "operatorIds"],
    "telegram",
  );
  const controlChatId = expectTelegramId(
    telegram.controlChatId,
    "telegram.controlChatId",
    TELEGRAM_CHAT_ID_PATTERN,
  );
  if (!Array.isArray(telegram.operatorIds)) fail("telegram.operatorIds must be an array");
  if (telegram.operatorIds.length < 1) fail("telegram.operatorIds must contain at least one operator id");
  if (telegram.operatorIds.length > MAX_OPERATORS) {
    fail(`telegram.operatorIds must contain at most ${MAX_OPERATORS} operator ids`);
  }
  const operatorIds = telegram.operatorIds.map((entry, index) => {
    return expectTelegramId(
      entry,
      `telegram.operatorIds[${index}]`,
      TELEGRAM_OPERATOR_ID_PATTERN,
    );
  });
  if (new Set(operatorIds).size !== operatorIds.length) {
    fail("telegram.operatorIds must not contain duplicates");
  }
  return {
    token: resolveSecretSource(telegram, {
      envKey: "tokenEnv",
      sopsFileKey: "sopsFile",
      sopsKey: "tokenSopsKey",
      fieldName: "ops control Telegram token",
      configDirectory,
      env: options.env,
      resolver: options.resolveSecret ?? resolveConfiguredSecret,
    }),
    controlChatId,
    operatorIds,
  };
}

function parseIntake(
  value: unknown,
  configDirectory: string,
  options: LoadOpsWorkerControlConfigOptions,
): OpsWorkerControlIntakeConfig {
  const intake = expectObject(value, "intake");
  assertKeys(
    intake,
    ["host", "port", "bearerTokenEnv", "sopsFile", "bearerTokenSopsKey", "sourceIdentity"],
    ["host", "port", "sourceIdentity"],
    "intake",
  );
  const host = expectString(intake.host, "intake.host");
  if (!LOOPBACK_HOSTS.has(host)) fail("intake.host must be 127.0.0.1 or ::1");
  const sourceIdentity = expectString(intake.sourceIdentity, "intake.sourceIdentity");
  if (!isOpsWorkerRegisteredName(sourceIdentity)) {
    fail("intake.sourceIdentity must be a registered lowercase name");
  }
  return {
    host: host as "127.0.0.1" | "::1",
    port: expectInteger(intake.port, "intake.port", 0, 65_535),
    bearerToken: resolveSecretSource(intake, {
      envKey: "bearerTokenEnv",
      sopsFileKey: "sopsFile",
      sopsKey: "bearerTokenSopsKey",
      fieldName: "ops control intake bearer token",
      configDirectory,
      env: options.env,
      resolver: options.resolveSecret ?? resolveConfiguredSecret,
    }),
    sourceIdentity,
  };
}

function parsePoll(value: unknown): OpsWorkerControlPollTuning {
  if (value === undefined) return { ...DEFAULT_OPS_WORKER_CONTROL_POLL_TUNING };
  const poll = expectObject(value, "poll");
  assertKeys(
    poll,
    ["longPollSeconds", "requestTimeoutMs", "retryMinMs", "retryMaxMs", "maxResponseBytes"],
    [],
    "poll",
  );
  const parsed = {
    longPollSeconds: optionalInteger(poll, "longPollSeconds", 30, 1, 50, "poll"),
    requestTimeoutMs: optionalInteger(poll, "requestTimeoutMs", 35_000, 1_000, 120_000, "poll"),
    retryMinMs: optionalInteger(poll, "retryMinMs", 250, 10, 60_000, "poll"),
    retryMaxMs: optionalInteger(poll, "retryMaxMs", 5_000, 10, 300_000, "poll"),
    maxResponseBytes: optionalInteger(poll, "maxResponseBytes", 256 * 1024, 1_024, 1024 * 1024, "poll"),
  };
  if (parsed.requestTimeoutMs <= parsed.longPollSeconds * 1_000) {
    fail("poll.requestTimeoutMs must exceed the configured long-poll duration");
  }
  if (parsed.retryMaxMs < parsed.retryMinMs) {
    fail("poll.retryMaxMs must be at least poll.retryMinMs");
  }
  return parsed;
}

function parseReply(value: unknown): OpsWorkerControlReplyTuning {
  if (value === undefined) return { ...DEFAULT_OPS_WORKER_CONTROL_REPLY_TUNING };
  const reply = expectObject(value, "reply");
  assertKeys(reply, ["maxBytes"], [], "reply");
  return {
    maxBytes: optionalInteger(reply, "maxBytes", 3_500, 256, 4_096, "reply"),
  };
}

export function loadOpsWorkerControlConfig(
  path: string,
  options: LoadOpsWorkerControlConfigOptions = {},
): OpsWorkerControlConfig {
  const resolvedPath = resolve(path);
  let descriptor: number;
  try {
    descriptor = openSync(resolvedPath, constants.O_RDONLY | NO_FOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      fail("Ops control config must be a regular file, not a symlink");
    }
    throw error;
  }
  let raw: string;
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      fail("Ops control config must be a regular file, not a symlink");
    }
    if (stats.size > MAX_CONTROL_CONFIG_BYTES) {
      fail(`Ops control config exceeds ${MAX_CONTROL_CONFIG_BYTES} bytes`);
    }
    const buffer = Buffer.allocUnsafe(MAX_CONTROL_CONFIG_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const count = readSync(
        descriptor,
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        null,
      );
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_CONTROL_CONFIG_BYTES) {
      fail(`Ops control config exceeds ${MAX_CONTROL_CONFIG_BYTES} bytes`);
    }
    raw = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
  const document = parseDocument(raw, {
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    fail(`Ops control config is malformed YAML: ${document.errors[0].message}`);
  }
  let decoded: unknown;
  try {
    decoded = document.toJS({ maxAliasCount: 0 }) as unknown;
  } catch (error) {
    fail(`Ops control config cannot use YAML aliases: ${(error as Error).message}`);
  }
  const root = expectObject(decoded, "ops control config");
  assertKeys(root, ["telegram", "intake", "poll", "reply"], ["telegram"], "ops control config");
  const configDirectory = dirname(resolvedPath);
  return {
    telegram: parseTelegram(root.telegram, configDirectory, options),
    intake: root.intake === undefined
      ? undefined
      : parseIntake(root.intake, configDirectory, options),
    poll: parsePoll(root.poll),
    reply: parseReply(root.reply),
  };
}
