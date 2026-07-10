import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runCronScript = resolve(__dirname, "../../scripts/run-cron.sh");
const startBotScript = resolve(__dirname, "../../scripts/start-bot.sh");
const deliverScript = resolve(__dirname, "../../scripts/deliver.sh");
const telegramMaxUtf16Length = 4096;

type TelegramPayload = {
  chat_id: number;
  text: string;
  parse_mode?: string;
  message_thread_id?: number;
};

function hasUnpairedSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function runDeliverWithFakeTelegram(message: string): {
  payloads: TelegramPayload[];
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
} {
  const fixture = mkdtempSync(join(tmpdir(), "deliver-unicode-"));
  const binDir = join(fixture, "bin");
  const payloadPath = join(fixture, "telegram-payloads.jsonl");

  try {
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "curl"),
      [
        "#!/bin/bash",
        "set -euo pipefail",
        "payload=''",
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-d" ]; then',
        "    shift",
        '    payload="${1-}"',
        "  fi",
        "  shift || true",
        "done",
        "cat >/dev/null",
        'printf "%s\\n" "$payload" >> "$TELEGRAM_PAYLOAD_PATH"',
        'printf \'{"ok":true}\'',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(binDir, "sleep"), "#!/bin/bash\nexit 0\n", "utf8");
    chmodSync(join(binDir, "curl"), 0o755);
    chmodSync(join(binDir, "sleep"), 0o755);

    const result = spawnSync("/bin/bash", [deliverScript, "123"], {
      input: message,
      encoding: "utf8",
      env: {
        ...process.env,
        CURL_BIN: join(binDir, "curl"),
        ECHO_DIR_BASE: join(fixture, "echo"),
        HOME: fixture,
        LANG: "C",
        LC_ALL: "C",
        LOG_DIR: join(fixture, "logs"),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TELEGRAM_BOT_TOKEN: "fixture-token",
        TELEGRAM_PAYLOAD_PATH: payloadPath,
      },
    });

    const payloads = existsSync(payloadPath)
      ? readFileSync(payloadPath, "utf8")
          .trimEnd()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as TelegramPayload)
      : [];

    return {
      payloads,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function assertDeliverSucceeded(run: ReturnType<typeof runDeliverWithFakeTelegram>): void {
  assert.equal(run.status, 0, run.stderr || run.stdout || String(run.error));
}

function assertNoReplacementOrUnpairedSurrogates(payloads: TelegramPayload[]): void {
  for (const payload of payloads) {
    assert.equal(payload.text.includes("\uFFFD"), false, `payload contains replacement character: ${payload.text}`);
    assert.equal(hasUnpairedSurrogate(payload.text), false, `payload contains an unpaired surrogate: ${payload.text}`);
  }
}

function assertChunksWithinTelegramLimit(payloads: TelegramPayload[]): void {
  for (const payload of payloads) {
    assert.ok(
      payload.text.length <= telegramMaxUtf16Length,
      `payload length ${payload.text.length} exceeds ${telegramMaxUtf16Length} UTF-16 code units`,
    );
  }
}

describe("start-bot.sh", () => {
  it("does not read Claude OAuth credentials or export Claude runtime flags", () => {
    const script = readFileSync(startBotScript, "utf8");

    assert.doesNotMatch(script, /security find-generic-password/);
    assert.doesNotMatch(script, /claude-code-oauth-token/);
    assert.doesNotMatch(script, /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.doesNotMatch(script, /ANTHROPIC_API_KEY/);
    assert.doesNotMatch(script, /^export CLAUDE_CODE_/m);
  });

  it("scrubs inherited legacy runtime env before boot", () => {
    const fixture = mkdtempSync(join(tmpdir(), "start-bot-wrapper-"));
    const binDir = join(fixture, "bin");
    const captureFile = join(fixture, "capture.txt");

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, "node"),
        `#!/bin/bash
{
  printf 'args=%s\\n' "$*"
  printf 'token=%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-__unset__}"
  printf 'anthropic=%s\\n' "\${ANTHROPIC_API_KEY-__unset__}"
  printf 'marker=%s\\n' "\${CLAUDECODE-__unset__}"
} > "$CAPTURE_FILE"
`,
        "utf8",
      );
      chmodSync(join(binDir, "node"), 0o755);

      const result = spawnSync("/bin/bash", [startBotScript], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixture,
          PATH: "",
          MINIME_PATH_PREFIX: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
          CAPTURE_FILE: captureFile,
          CLAUDE_CODE_OAUTH_TOKEN: "stale-token",
          ANTHROPIC_API_KEY: "stale-anthropic-key",
          CLAUDECODE: "nested-marker",
        },
      });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout || "start-bot.sh failed");
      const capture = readFileSync(captureFile, "utf8");
      assert.match(capture, /args=.*\/dist\/main\.js$/m);
      assert.match(capture, /^token=__unset__$/m);
      assert.match(capture, /^anthropic=__unset__$/m);
      assert.match(capture, /^marker=__unset__$/m);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("run-cron.sh", () => {
  it("does not read Keychain credentials and scrubs inherited legacy runtime env", () => {
    const fixture = mkdtempSync(join(tmpdir(), "run-cron-wrapper-"));
    const binDir = join(fixture, "bin");
    const captureFile = join(fixture, "capture.txt");
    const securityCallsFile = join(fixture, "security-calls.txt");

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, "security"),
        "#!/bin/bash\nprintf 'security-called\\n' >> \"$SECURITY_CALLS_FILE\"\nexit 44\n",
        "utf8",
      );
      writeFileSync(
        join(binDir, "node"),
        `#!/bin/bash
{
  printf 'args=%s\\n' "$*"
  printf 'token=%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-__unset__}"
  printf 'anthropic=%s\\n' "\${ANTHROPIC_API_KEY-__unset__}"
  printf 'marker=%s\\n' "\${CLAUDECODE-__unset__}"
  printf 'auto_memory=%s\\n' "\${CLAUDE_CODE_DISABLE_AUTO_MEMORY-__unset__}"
  printf 'background_tasks=%s\\n' "\${CLAUDE_CODE_DISABLE_BACKGROUND_TASKS-__unset__}"
  printf 'cron=%s\\n' "\${CLAUDE_CODE_DISABLE_CRON-__unset__}"
  printf 'exit_delay=%s\\n' "\${CLAUDE_CODE_EXIT_AFTER_STOP_DELAY-__unset__}"
  printf 'telemetry=%s\\n' "\${CLAUDE_CODE_ENABLE_TELEMETRY-__unset__}"
  printf 'path=%s\\n' "$PATH"
} > "$CAPTURE_FILE"
`,
        "utf8",
      );
      chmodSync(join(binDir, "security"), 0o755);
      chmodSync(join(binDir, "node"), 0o755);

      const result = spawnSync("/bin/bash", [runCronScript, "pi-task"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fixture,
          PATH: "",
          MINIME_PATH_PREFIX: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
          CAPTURE_FILE: captureFile,
          SECURITY_CALLS_FILE: securityCallsFile,
          CLAUDE_CODE_OAUTH_TOKEN: "stale-token",
          ANTHROPIC_API_KEY: "stale-anthropic-key",
          CLAUDECODE: "nested-marker",
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
          CLAUDE_CODE_DISABLE_CRON: "1",
          CLAUDE_CODE_EXIT_AFTER_STOP_DELAY: "900000",
          CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        },
      });

      assert.strictEqual(result.status, 0, result.stderr || result.stdout || "run-cron.sh failed");
      assert.strictEqual(existsSync(securityCallsFile), false);
      const capture = readFileSync(captureFile, "utf8");
      assert.match(capture, /args=.*\/dist\/cron-runner\.js --task pi-task$/m);
      assert.match(capture, /^token=__unset__$/m);
      assert.match(capture, /^anthropic=__unset__$/m);
      assert.match(capture, /^marker=__unset__$/m);
      assert.match(capture, /^auto_memory=__unset__$/m);
      assert.match(capture, /^background_tasks=__unset__$/m);
      assert.match(capture, /^cron=__unset__$/m);
      assert.match(capture, /^exit_delay=__unset__$/m);
      assert.match(capture, /^telemetry=__unset__$/m);
      const pathLine = capture.split("\n").find((line) => line.startsWith("path="));
      assert.strictEqual(pathLine, `path=${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("deliver.sh", () => {
  it("does not read Keychain credentials and expects a resolved Telegram token in env", () => {
    const script = readFileSync(deliverScript, "utf8");

    assert.doesNotMatch(script, /security find-generic-password/);
    assert.doesNotMatch(script, /Keychain/);
    assert.match(script, /TELEGRAM_BOT_TOKEN/);
    assert.match(script, /\nTOKEN="\$\{TELEGRAM_BOT_TOKEN:-\}"[\s\S]*\nunset TELEGRAM_BOT_TOKEN/);
    assert.match(script, /--config -/);
    assert.doesNotMatch(script, /curl[^\n]*bot\$\{TOKEN\}/);
  });

  it("splits LC_ALL=C Cyrillic hard-boundary payloads without replacement characters", () => {
    const message = `${"a".repeat(4095)}системы`;
    const run = runDeliverWithFakeTelegram(message);

    assertDeliverSucceeded(run);
    assert.equal(run.payloads.length, 2);
    assertNoReplacementOrUnpairedSurrogates(run.payloads);
    assert.equal(
      run.payloads.map((payload) => payload.text).join(""),
      message,
    );
  });

  it("does not split a non-BMP character into an invalid surrogate at a hard boundary", () => {
    const message = `${"b".repeat(4095)}🚀done`;
    const run = runDeliverWithFakeTelegram(message);

    assertDeliverSucceeded(run);
    assert.equal(run.payloads.length, 2);
    assertNoReplacementOrUnpairedSurrogates(run.payloads);
    assertChunksWithinTelegramLimit(run.payloads);
    assert.equal(
      run.payloads.map((payload) => payload.text).join(""),
      message,
    );
  });

  it("prefers paragraph and newline boundaries with non-ASCII text within Telegram limits", () => {
    const paragraphLead = "Ж".repeat(3000);
    const paragraphTail = "д".repeat(1200);
    const paragraphRun = runDeliverWithFakeTelegram(`${paragraphLead}\n\n${paragraphTail}`);

    assertDeliverSucceeded(paragraphRun);
    assert.deepEqual(
      paragraphRun.payloads.map((payload) => payload.text),
      [paragraphLead, paragraphTail],
    );
    assertChunksWithinTelegramLimit(paragraphRun.payloads);

    const newlineLead = "界".repeat(3000);
    const newlineTail = "語".repeat(1200);
    const newlineRun = runDeliverWithFakeTelegram(`${newlineLead}\n${newlineTail}`);

    assertDeliverSucceeded(newlineRun);
    assert.deepEqual(
      newlineRun.payloads.map((payload) => payload.text),
      [newlineLead, newlineTail],
    );
    assertChunksWithinTelegramLimit(newlineRun.payloads);
  });
});
