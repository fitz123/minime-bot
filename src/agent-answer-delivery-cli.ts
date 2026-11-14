import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Api } from "grammy";
import { createTelegramApiAdapter, type TelegramAdapterApi } from "./telegram-adapter.js";
import { prepareRichAnswer } from "./telegram-rich.js";
import { writeResultEcho } from "./result-echo.js";

export const DELIVERY_NOT_SENT = "FULL_CYCLE_DELIVERY_NOT_SENT";

interface DeliveryDeps {
  env: NodeJS.ProcessEnv;
  createApi: (token: string) => TelegramAdapterApi;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

function numericId(value: string | undefined, thread = false): number {
  if (!value || !(thread ? /^\d+$/ : /^-?\d+$/).test(value)) {
    throw new Error(thread ? "invalid thread_id" : "invalid chat_id");
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id) || (thread ? id < 0 : id === 0)) {
    throw new Error(thread ? "invalid thread_id" : "invalid chat_id");
  }
  return id;
}

/** One attempt only. The no-send marker belongs exclusively to local preflight. */
export async function runAgentAnswerDelivery(
  argv: string[], source: string, overrides: Partial<DeliveryDeps> = {},
): Promise<number> {
  const deps: DeliveryDeps = {
    env: process.env,
    // No auto-retry transformer: the caller owns uncertain delivery custody.
    createApi: token => new Api(token, { timeoutSeconds: 30 }),
    stdout: text => { process.stdout.write(text); },
    stderr: text => { process.stderr.write(text); },
    ...overrides,
  };
  let chatId: number;
  let threadId: number | undefined;
  let prepared: ReturnType<typeof prepareRichAnswer>;
  let platform: ReturnType<typeof createTelegramApiAdapter>;
  let phase = "arguments";
  try {
    if (argv.length !== 1 && !(argv.length === 3 && argv[1] === "--thread")) {
      throw new Error("invalid arguments");
    }
    chatId = numericId(argv[0]);
    threadId = argv.length === 3 ? numericId(argv[2], true) : undefined;
    phase = "empty input";
    if (!source.trim()) throw new Error("empty input");
    phase = "rich preparation (inline media requires a session outbox)";
    // Preflight the entire source without consulting or consuming ambient media.
    prepared = prepareRichAnswer(source);
    if (!prepared.chunks.length) throw new Error("no rich chunks");
    phase = "sender configuration";
    const token = deps.env.TELEGRAM_BOT_TOKEN;
    if (!token) throw new Error("missing token");
    platform = createTelegramApiAdapter({ api: deps.createApi(token), chatId, threadId });
  } catch {
    // Fixed diagnostics cannot disclose a token, input, local path, or transport URL.
    deps.stderr(`[deliver] Rich answer preflight rejected: ${phase}\n`);
    deps.stdout(`${DELIVERY_NOT_SENT}\n`);
    return 1;
  }

  for (const [index, chunk] of prepared.chunks.entries()) {
    try {
      // From this point, even a first-chunk rejection is conservatively uncertain.
      await platform.sendMessage(chunk.text, chunk.options);
      prepared.confirm(index);
    } catch {
      deps.stderr(`[deliver] Rich answer delivery uncertain at chunk ${index + 1}; do not replay automatically\n`);
      return 1;
    }
    writeResultEcho(chatId, threadId, chunk.options.indexText ?? chunk.text, "deliver.sh");
  }
  return 0;
}

function realpathOrResolve(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

if (process.argv[1] && realpathOrResolve(process.argv[1]) === realpathOrResolve(fileURLToPath(import.meta.url))) {
  let source: string;
  try {
    source = readFileSync(0, "utf8");
  } catch {
    process.stderr.write("[deliver] Rich answer preflight rejected: unreadable input\n");
    process.stdout.write(`${DELIVERY_NOT_SENT}\n`);
    process.exit(1);
  }
  process.exitCode = await runAgentAnswerDelivery(process.argv.slice(2), source);
}
