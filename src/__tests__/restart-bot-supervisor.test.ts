import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT = resolve(__dirname, "../../scripts/restart-bot.sh");

const MOCK_LAUNCHCTL = `#!/bin/bash
set -uo pipefail
STATE="\${STATE_DIR}/state"
touch "\$STATE"

get() { awk -F= -v k="\$1" 'BEGIN{v=""} $1==k {v=$0; sub(/^[^=]*=/,"",v)} END{print v}' "\$STATE"; }
set_kv() {
  tmp="\$STATE.tmp"
  awk -F= -v k="\$1" '$1!=k' "\$STATE" > "\$tmp"
  printf '%s=%s\\n' "\$1" "\$2" >> "\$tmp"
  mv "\$tmp" "\$STATE"
}
del_kv() {
  tmp="\$STATE.tmp"
  awk -F= -v k="\$1" '$1!=k' "\$STATE" > "\$tmp"
  mv "\$tmp" "\$STATE"
}
now() { date +%s; }
incr() {
  cur=\$(get "\$1"); [ -z "\$cur" ] && cur=0
  set_kv "\$1" \$(( cur + 1 ))
}
label_from_plist() {
  file="\$1"
  if [ -n "\$file" ] && [ -f "\$file" ]; then
    tr -d '\\n' < "\$file" | sed -n 's|.*<key>[[:space:]]*Label[[:space:]]*</key>[[:space:]]*<string>\\([^<]*\\)</string>.*|\\1|p'
  fi
}
log_cmd() {
  printf '%s' "\$cmd" >> "\${STATE_DIR}/commands"
  for arg in "\$@"; do
    printf '\\t%s' "\$arg" >> "\${STATE_DIR}/commands"
  done
  printf '\\n' >> "\${STATE_DIR}/commands"
}
apply() {
  kat=\$(get kill_at)
  bat=\$(get bootout_at)
  if [ -n "\$kat" ] && [ "\$(now)" -ge "\$kat" ]; then
    np=\$(get next_pid); [ -z "\$np" ] && np=99999
    set_kv pid "\$np"
    del_kv kill_at
  fi
  if [ -n "\$bat" ] && [ "\$(now)" -ge "\$bat" ]; then
    set_kv registered 0
    del_kv pid
    del_kv bootout_at
  fi
}

cmd="\${1:-}"; shift || true
log_cmd "\$@"
case "\$cmd" in
  list)
    apply
    if [ "\$(get list_fail)" = "1" ]; then
      echo "launchctl list failed" >&2
      exit 42
    fi
    if [ "\$(get registered)" = "1" ]; then
      label=\$(get label); [ -z "\$label" ] && label="ai.minime.telegram-bot"
      pid=\$(get pid); [ -z "\$pid" ] && pid="-"
      printf 'PID\\tStatus\\tLabel\\n'
      printf '%s\\t0\\t%s\\n' "\$pid" "\$label"
    fi
    ;;
  kill)
    apply
    delay=\$(get kill_delay); [ -z "\$delay" ] && delay=0
    set_kv kill_at \$(( \$(now) + delay ))
    ;;
  bootout)
    apply
    service="\${1:-}"
    label="\${service##*/}"
    if [ "\$label" = "ai.minime.telegram-bot.restart-supervisor" ]; then
      incr supervisor_bootout_count
      set_kv supervisor_bootout_service "\$service"
    else
      incr bot_bootout_count
      delay=\$(get bootout_delay); [ -z "\$delay" ] && delay=0
      set_kv bootout_at \$(( \$(now) + delay ))
    fi
    ;;
  bootstrap)
    apply
    domain="\${1:-}"
    plist_path="\${2:-}"
    label=\$(label_from_plist "\$plist_path")
    if [ "\$label" = "ai.minime.telegram-bot.restart-supervisor" ]; then
      if [ "\$(get supervisor_bootstrap_fail)" = "1" ]; then
        echo "Bootstrap failed: 5: Input/output error" >&2
        exit 5
      fi
      incr supervisor_bootstrap_count
      set_kv supervisor_bootstrap_domain "\$domain"
      set_kv supervisor_plist "\$plist_path"
      exit 0
    fi
    if [ "\$(get bootstrap_fail)" = "1" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    if [ "\$(get registered)" = "1" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2
      exit 5
    fi
    if [ "\$(get bootstrap_no_pid)" = "1" ]; then
      set_kv registered 1
      del_kv pid
      exit 0
    fi
    np=\$(get next_pid); [ -z "\$np" ] && np=99999
    set_kv pid "\$np"
    set_kv registered 1
    ;;
  *)
    echo "mock-launchctl: unknown command: \$cmd" >&2
    exit 1
    ;;
esac
`;

const MOCK_PLUTIL = `#!/bin/bash
set -uo pipefail

get() {
  if [ -z "\${STATE_DIR:-}" ] || [ ! -f "\${STATE_DIR}/state" ]; then
    return 0
  fi
  awk -F= -v k="\$1" 'BEGIN{v=""} $1==k {v=$0; sub(/^[^=]*=/,"",v)} END{print v}' "\${STATE_DIR}/state"
}

cmd="\${1:-}"; shift || true
if [ -n "\${STATE_DIR:-}" ]; then
  printf '%s' "\$cmd" >> "\${STATE_DIR}/plutil-commands"
  for arg in "\$@"; do
    printf '\\t%s' "\$arg" >> "\${STATE_DIR}/plutil-commands"
  done
  printf '\\n' >> "\${STATE_DIR}/plutil-commands"
fi

case "\$cmd" in
  -lint)
    file="\${1:-}"
    if [ -z "\$file" ] || [ ! -f "\$file" ]; then
      exit 1
    fi
    if [ "\$(get supervisor_lint_fail)" = "1" ] && grep -q "ai.minime.telegram-bot.restart-supervisor" "\$file"; then
      echo "mock-plutil: supervisor lint failed" >&2
      exit 1
    fi
    if grep -q "<plist" "\$file" && grep -q "</plist>" "\$file" && grep -q "<dict>" "\$file" && grep -q "</dict>" "\$file"; then
      exit 0
    fi
    echo "mock-plutil: malformed plist" >&2
    exit 1
    ;;
  -extract)
    key="\${1:-}"
    fmt="\${2:-}"
    file="\${3:-}"
    if [ "\$key" != "Label" ] || [ "\$fmt" != "raw" ] || [ -z "\$file" ] || [ ! -f "\$file" ]; then
      exit 1
    fi
    label=\$(tr -d '\\n' < "\$file" | sed -n 's|.*<key>[[:space:]]*Label[[:space:]]*</key>[[:space:]]*<string>\\([^<]*\\)</string>.*|\\1|p')
    if [ -n "\$label" ]; then
      printf '%s\\n' "\$label"
      exit 0
    fi
    exit 1
    ;;
  *)
    echo "mock-plutil: unsupported args: \$cmd \$*" >&2
    exit 1
    ;;
esac
`;

const VALID_PLIST = (label = "ai.minime.telegram-bot") => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
</dict>
</plist>
`;

type Harness = {
  dir: string;
  plist: string;
  stateDir: string;
  setState(kv: Record<string, string | number>): void;
  readState(): Record<string, string>;
  readCommands(): string[];
  readPlutilCommands(): string[];
  run(args: string[], env?: Record<string, string>): { status: number | null; stdout: string; stderr: string };
};

function createHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "restart-bot-supervisor-test-"));
  const launchctl = join(dir, "launchctl");
  const plutil = join(dir, "plutil");
  const stateDir = join(dir, "state-dir");
  const plist = join(dir, "ai.minime.telegram-bot.plist");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(launchctl, MOCK_LAUNCHCTL);
  writeFileSync(plutil, MOCK_PLUTIL);
  writeFileSync(plist, VALID_PLIST());
  chmodSync(launchctl, 0o755);
  chmodSync(plutil, 0o755);

  const stateFile = join(stateDir, "state");
  const setState = (kv: Record<string, string | number>) => {
    const existing: Record<string, string> = {};
    if (existsSync(stateFile)) {
      for (const line of readFileSync(stateFile, "utf8").split("\n")) {
        if (!line) continue;
        const idx = line.indexOf("=");
        if (idx !== -1) existing[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    for (const [k, v] of Object.entries(kv)) existing[k] = String(v);
    writeFileSync(stateFile, Object.entries(existing).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  };

  const readState = () => {
    const state: Record<string, string> = {};
    if (!existsSync(stateFile)) return state;
    for (const line of readFileSync(stateFile, "utf8").split("\n")) {
      if (!line) continue;
      const idx = line.indexOf("=");
      if (idx !== -1) state[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return state;
  };

  const readLines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
  const readCommands = () => readLines(join(stateDir, "commands"));
  const readPlutilCommands = () => readLines(join(stateDir, "plutil-commands"));

  const run = (args: string[], env: Record<string, string> = {}) => {
    const result = spawnSync(SCRIPT, args, {
      env: {
        ...process.env,
        HOME: dir,
        LAUNCHCTL_BIN: launchctl,
        PLUTIL_BIN: plutil,
        BOT_LABEL: "ai.minime.telegram-bot",
        BOT_PLIST: plist,
        BOT_UID: "501",
        STATE_DIR: stateDir,
        CONFIG_VALIDATE_BIN: "true",
        POLL_INTERVAL: "0.05",
        SHUTDOWN_TIMEOUT: "10",
        TEARDOWN_TIMEOUT: "10",
        STARTUP_TIMEOUT: "10",
        RESTART_WORKER_NOT_BEFORE_DELAY: "0",
        RESTART_MAX_WORKER_NOT_BEFORE_DELAY: "1",
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };

  return { dir, plist, stateDir, setState, readState, readCommands, readPlutilCommands, run };
}

function cleanup(h: Harness) {
  rmSync(h.dir, { recursive: true, force: true });
}

function readStatus(path: string): Record<string, string> {
  const status: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx !== -1) status[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return status;
}

function xmlUnescape(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function plistStringArray(plist: string, key: string): string[] {
  const match = plist.match(new RegExp(`<key>\\s*${key}\\s*<\\/key>\\s*<array>([\\s\\S]*?)<\\/array>`));
  assert.ok(match, `expected ${key} array`);
  return Array.from(match[1].matchAll(/<string>([\s\S]*?)<\/string>/g), (entry) => xmlUnescape(entry[1]));
}

function plistStringDict(plist: string, key: string): Record<string, string> {
  const match = plist.match(new RegExp(`<key>\\s*${key}\\s*<\\/key>\\s*<dict>([\\s\\S]*?)<\\/dict>`));
  assert.ok(match, `expected ${key} dict`);
  const dict: Record<string, string> = {};
  const pairPattern = /<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (const entry of match[1].matchAll(pairPattern)) {
    dict[xmlUnescape(entry[1])] = xmlUnescape(entry[2]);
  }
  return dict;
}

describe("restart-bot.sh supervisor mode", () => {
  it("--plist schedules the supervisor and leaves the bot service untouched", () => {
    const h = createHarness();
    try {
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222 });

      const { status, stdout, stderr } = h.run(["--plist"], { MINIME_BOT_PI_SESSION: "1" });

      assert.strictEqual(status, 0, `expected exit 0, got ${status}: ${stderr}`);
      assert.match(stdout, /Restart scheduled/);
      const state = h.readState();
      assert.strictEqual(state.registered, "1");
      assert.strictEqual(state.pid, "1111");
      assert.strictEqual(state.supervisor_bootout_count, "1");
      assert.strictEqual(state.supervisor_bootstrap_count, "1");
      assert.strictEqual(state.bot_bootout_count, undefined);
      assert.strictEqual(state.bootstrapped_sig, undefined);
    } finally {
      cleanup(h);
    }
  });

  it("generated supervisor plist serializes required context and is linted", () => {
    const h = createHarness();
    try {
      const controlWorkspace = join(h.dir, "control & workspace");
      const statusPath = join(h.dir, "status & logs", "request.status");
      const logPath = join(h.dir, "status & logs", "request.log");
      const configPath = "settings/config.yaml";
      const cronsPath = join(controlWorkspace, "settings", "crons.yaml");
      mkdirSync(controlWorkspace, { recursive: true });

      const { status, stderr } = h.run(["--plist"], {
        MINIME_CONTROL_WORKSPACE_ROOT: controlWorkspace,
        MINIME_CONFIG_PATH: configPath,
        MINIME_CRONS_PATH: cronsPath,
        RESTART_REQUEST_ID: "request-special",
        RESTART_STATUS_PATH: statusPath,
        RESTART_LOG_PATH: logPath,
        RESTART_WORKER_NOT_BEFORE_DELAY: "0.25",
      });

      assert.strictEqual(status, 0, `expected exit 0, got ${status}: ${stderr}`);
      const state = h.readState();
      const supervisorPlist = state.supervisor_plist;
      assert.ok(supervisorPlist, "expected supervisor plist path to be recorded");
      assert.equal(supervisorPlist.startsWith(join(h.dir, "Library", "Logs", "minime-bot", "restart")), true);
      assert.equal(supervisorPlist.includes(`${join("Library", "LaunchAgents")}`), false);
      const plist = readFileSync(supervisorPlist, "utf8");

      assert.match(plist, /<string>ai\.minime\.telegram-bot\.restart-supervisor<\/string>/);
      assert.deepEqual(plistStringArray(plist, "ProgramArguments"), [
        SCRIPT,
        "--worker",
        "--plist",
        "--request-id",
        "request-special",
        "--status-path",
        statusPath,
        "--log-path",
        logPath,
      ]);
      assert.deepEqual(
        {
          BOT_PLIST: plistStringDict(plist, "EnvironmentVariables").BOT_PLIST,
          BOT_LABEL: plistStringDict(plist, "EnvironmentVariables").BOT_LABEL,
          BOT_UID: plistStringDict(plist, "EnvironmentVariables").BOT_UID,
          MINIME_CONTROL_WORKSPACE_ROOT: plistStringDict(plist, "EnvironmentVariables").MINIME_CONTROL_WORKSPACE_ROOT,
          MINIME_CONFIG_PATH: plistStringDict(plist, "EnvironmentVariables").MINIME_CONFIG_PATH,
          MINIME_CRONS_PATH: plistStringDict(plist, "EnvironmentVariables").MINIME_CRONS_PATH,
          HOME: plistStringDict(plist, "EnvironmentVariables").HOME,
          RESTART_REQUEST_ID: plistStringDict(plist, "EnvironmentVariables").RESTART_REQUEST_ID,
          RESTART_STATUS_PATH: plistStringDict(plist, "EnvironmentVariables").RESTART_STATUS_PATH,
          RESTART_LOG_PATH: plistStringDict(plist, "EnvironmentVariables").RESTART_LOG_PATH,
        },
        {
          BOT_PLIST: h.plist,
          BOT_LABEL: "ai.minime.telegram-bot",
          BOT_UID: "501",
          MINIME_CONTROL_WORKSPACE_ROOT: controlWorkspace,
          MINIME_CONFIG_PATH: configPath,
          MINIME_CRONS_PATH: cronsPath,
          HOME: h.dir,
          RESTART_REQUEST_ID: "request-special",
          RESTART_STATUS_PATH: statusPath,
          RESTART_LOG_PATH: logPath,
        },
      );
      const env = plistStringDict(plist, "EnvironmentVariables");
      assert.ok(env.PATH.includes("/usr/bin"));
      assert.equal("BOT_DOMAIN" in env, false);
      assert.equal("RESTART_WORKER_ARGS" in env, false);
      assert.match(plist, /<key>StandardOutPath<\/key>/);
      assert.match(plist, /<key>StandardErrorPath<\/key>/);
      assert.doesNotMatch(plist, /MINIME_BOT_PI_SESSION/);

      assert.ok(
        h.readPlutilCommands().some((line) => line === `-lint\t${supervisorPlist}`),
        `expected supervisor plist lint, got ${JSON.stringify(h.readPlutilCommands())}`,
      );
    } finally {
      cleanup(h);
    }
  });

  it("cleans the fixed helper label before every request", () => {
    const h = createHarness();
    try {
      assert.strictEqual(h.run(["--plist"]).status, 0);
      assert.strictEqual(h.run(["--plist"]).status, 0);

      const state = h.readState();
      assert.strictEqual(state.supervisor_bootout_count, "2");
      assert.strictEqual(state.supervisor_bootstrap_count, "2");
      assert.strictEqual(state.supervisor_bootout_service, "gui/501/ai.minime.telegram-bot.restart-supervisor");

      const commands = h.readCommands();
      const firstBootout = commands.findIndex((line) => line === "bootout\tgui/501/ai.minime.telegram-bot.restart-supervisor");
      const firstBootstrap = commands.findIndex((line) => line.startsWith("bootstrap\tgui/501\t"));
      assert.ok(firstBootout >= 0, `expected supervisor bootout, got ${JSON.stringify(commands)}`);
      assert.ok(firstBootstrap > firstBootout, `expected bootstrap after cleanup, got ${JSON.stringify(commands)}`);
      assert.ok(commands.every((line) => !line.includes("kill\tSIGTERM\tgui/501/ai.minime.telegram-bot")));
    } finally {
      cleanup(h);
    }
  });

  it("ignores attempts to override the fixed helper label", () => {
    const h = createHarness();
    try {
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222 });

      const { status, stderr } = h.run(["--plist"], {
        RESTART_SUPERVISOR_LABEL: "ai.minime.telegram-bot",
      });

      assert.strictEqual(status, 0, `expected fixed-label request success: ${stderr}`);
      const state = h.readState();
      assert.strictEqual(state.supervisor_bootout_service, "gui/501/ai.minime.telegram-bot.restart-supervisor");
      assert.strictEqual(state.bot_bootout_count, undefined);
      assert.strictEqual(state.registered, "1");
      assert.strictEqual(state.pid, "1111");
    } finally {
      cleanup(h);
    }
  });

  it("--plist creates status and log parents before supervisor bootstrap", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "nested", "status", "request.status");
      const logPath = join(h.dir, "nested", "logs", "request.log");

      const { status, stderr } = h.run(["--plist"], {
        RESTART_STATUS_PATH: statusPath,
        RESTART_LOG_PATH: logPath,
      });

      assert.strictEqual(status, 0, `expected request success: ${stderr}`);
      assert.equal(existsSync(dirname(statusPath)), true);
      assert.equal(existsSync(dirname(logPath)), true);
      assert.strictEqual(readStatus(statusPath).status, "scheduled");
    } finally {
      cleanup(h);
    }
  });

  it("--plist fails before scheduling when the bot plist is missing", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "missing-plist.status");
      rmSync(h.plist);

      const { status, stderr } = h.run(["--plist"], { RESTART_STATUS_PATH: statusPath });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /plist not found/);
      assert.strictEqual(h.readState().supervisor_bootstrap_count, undefined);
      assert.strictEqual(h.readState().bot_bootout_count, undefined);
      assert.strictEqual(readStatus(statusPath).error, "plist not found");
    } finally {
      cleanup(h);
    }
  });

  it("--plist fails before scheduling when plist validation fails", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "invalid-plist.status");
      writeFileSync(h.plist, VALID_PLIST("ai.minime.wrong-label"));

      const { status, stderr } = h.run(["--plist"], { RESTART_STATUS_PATH: statusPath });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /Label .* does not match/);
      assert.strictEqual(h.readState().supervisor_bootstrap_count, undefined);
      assert.strictEqual(h.readState().bot_bootout_count, undefined);
      assert.strictEqual(readStatus(statusPath).error, "plist validation failed");
    } finally {
      cleanup(h);
    }
  });

  it("--plist fails before scheduling when config validation fails", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "config-validation.status");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111 });

      const { status, stderr } = h.run(["--plist"], {
        CONFIG_VALIDATE_BIN: "false",
        RESTART_STATUS_PATH: statusPath,
      });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /config validation failed/);
      const state = h.readState();
      assert.strictEqual(state.registered, "1");
      assert.strictEqual(state.pid, "1111");
      assert.strictEqual(state.supervisor_bootstrap_count, undefined);
      assert.strictEqual(state.bot_bootout_count, undefined);
      assert.strictEqual(readStatus(statusPath).error, "config validation failed");
    } finally {
      cleanup(h);
    }
  });

  it("reports supervisor bootstrap failure without booting out the bot", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "request.status");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, supervisor_bootstrap_fail: 1 });

      const { status, stderr } = h.run(["--plist"], { RESTART_STATUS_PATH: statusPath });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /launchctl bootstrap failed for restart supervisor/);
      const state = h.readState();
      assert.strictEqual(state.registered, "1");
      assert.strictEqual(state.pid, "1111");
      assert.strictEqual(state.bot_bootout_count, undefined);
      assert.deepStrictEqual(readStatus(statusPath).status, "failure");
      assert.strictEqual(readStatus(statusPath).error, "supervisor bootstrap failed");
    } finally {
      cleanup(h);
    }
  });

  it("reports supervisor plist lint failure before bootstrap", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "supervisor-lint.status");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, supervisor_lint_fail: 1 });

      const { status, stderr } = h.run(["--plist"], { RESTART_STATUS_PATH: statusPath });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /restart supervisor plist is malformed/);
      const state = h.readState();
      assert.strictEqual(state.registered, "1");
      assert.strictEqual(state.pid, "1111");
      assert.strictEqual(state.supervisor_bootstrap_count, undefined);
      assert.strictEqual(state.bot_bootout_count, undefined);
      assert.strictEqual(readStatus(statusPath).error, "supervisor plist validation failed");
    } finally {
      cleanup(h);
    }
  });

  it("foreground worker refuses Pi session marker unless explicitly overridden", () => {
    const h = createHarness();
    try {
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222 });

      const blocked = h.run(["--foreground", "--plist"], { MINIME_BOT_PI_SESSION: "1" });
      assert.notStrictEqual(blocked.status, 0);
      assert.match(blocked.stderr, /foreground plist restart refused inside Pi session/);
      assert.strictEqual(h.readState().bot_bootout_count, undefined);

      const allowed = h.run(["--foreground", "--plist"], {
        MINIME_BOT_PI_SESSION: "1",
        MINIME_RESTART_UNSAFE_FOREGROUND: "1",
      });
      assert.strictEqual(allowed.status, 0, `expected override success: ${allowed.stderr}`);
      assert.match(allowed.stdout, /New PID: 2222/);
    } finally {
      cleanup(h);
    }
  });

  it("worker waits the bounded not-before delay before bot bootout", () => {
    const h = createHarness();
    try {
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222 });
      const start = Date.now();

      const { status, stderr } = h.run(["--worker", "--plist"], {
        RESTART_WORKER_NOT_BEFORE_DELAY: "0.2",
        RESTART_MAX_WORKER_NOT_BEFORE_DELAY: "0.2",
      });

      assert.strictEqual(status, 0, `expected worker success: ${stderr}`);
      assert.ok(Date.now() - start >= 150, "expected worker to wait before bootout");
      assert.strictEqual(h.readState().bot_bootout_count, "1");
    } finally {
      cleanup(h);
    }
  });

  it("worker records validation failure before bootout", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "worker-validation.status");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222 });

      const { status, stderr } = h.run(["--worker", "--plist"], {
        CONFIG_VALIDATE_BIN: "false",
        RESTART_STATUS_PATH: statusPath,
      });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /config validation failed/);
      assert.strictEqual(h.readState().bot_bootout_count, undefined);
      const workerStatus = readStatus(statusPath);
      assert.strictEqual(workerStatus.status, "failure");
      assert.strictEqual(workerStatus.error, "config validation failed");
    } finally {
      cleanup(h);
    }
  });

  it("worker records bootstrap failure", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "worker-bootstrap.status");
      h.setState({ registered: 0, label: "ai.minime.telegram-bot", next_pid: 2222, bootstrap_fail: 1 });

      const { status, stderr } = h.run(["--worker", "--plist"], { RESTART_STATUS_PATH: statusPath });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /launchctl bootstrap failed/);
      const workerStatus = readStatus(statusPath);
      assert.strictEqual(workerStatus.status, "failure");
      assert.strictEqual(workerStatus.error, "bot bootstrap failed");
    } finally {
      cleanup(h);
    }
  });

  it("worker refuses to bootstrap when launchctl state is unknown", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "worker-unknown-state.status");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222, list_fail: 1 });

      const { status, stderr } = h.run(["--worker", "--plist"], { RESTART_STATUS_PATH: statusPath });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /unknown service state/);
      const state = h.readState();
      assert.strictEqual(state.bot_bootout_count, undefined);
      assert.strictEqual(state.bootstrapped_sig, undefined);
      assert.strictEqual(readStatus(statusPath).error, "unknown launchd state");
    } finally {
      cleanup(h);
    }
  });

  it("worker records teardown timeout without bootstrapping", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "worker-teardown-timeout.status");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222, bootout_delay: 5 });

      const { status, stderr } = h.run(["--worker", "--plist"], {
        RESTART_STATUS_PATH: statusPath,
        TEARDOWN_TIMEOUT: "1",
      });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /did not unregister/);
      const state = h.readState();
      assert.strictEqual(state.bot_bootout_count, "1");
      assert.strictEqual(state.bootstrapped_sig, undefined);
      assert.strictEqual(readStatus(statusPath).error, "teardown timeout");
    } finally {
      cleanup(h);
    }
  });

  it("worker records startup timeout when bootstrap does not produce a PID", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "worker-startup-timeout.status");
      h.setState({ registered: 0, label: "ai.minime.telegram-bot", bootstrap_no_pid: 1 });

      const { status, stderr } = h.run(["--worker", "--plist"], {
        RESTART_STATUS_PATH: statusPath,
        STARTUP_TIMEOUT: "1",
      });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /no running PID/);
      assert.strictEqual(readStatus(statusPath).error, "startup timeout");
    } finally {
      cleanup(h);
    }
  });

  it("worker rejects a stale old PID after bootstrap", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "worker-stale-pid.status");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 1111 });

      const { status, stderr } = h.run(["--worker", "--plist"], {
        RESTART_STATUS_PATH: statusPath,
        STARTUP_TIMEOUT: "1",
      });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /no running PID/);
      const workerStatus = readStatus(statusPath);
      assert.strictEqual(workerStatus.error, "startup timeout");
      assert.strictEqual(workerStatus.oldPid, "1111");
      assert.strictEqual(workerStatus.newPid, "");
    } finally {
      cleanup(h);
    }
  });

  it("worker records invalid delay before bootout", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "worker-invalid-delay.status");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 2222 });

      const { status, stderr } = h.run(["--worker", "--plist"], {
        RESTART_STATUS_PATH: statusPath,
        RESTART_WORKER_NOT_BEFORE_DELAY: "not-a-number",
      });

      assert.notStrictEqual(status, 0);
      assert.match(stderr, /invalid RESTART_WORKER_NOT_BEFORE_DELAY/);
      assert.strictEqual(h.readState().bot_bootout_count, undefined);
      assert.strictEqual(readStatus(statusPath).error, "invalid worker delay");
    } finally {
      cleanup(h);
    }
  });

  it("worker success path records status and log", () => {
    const h = createHarness();
    try {
      const statusPath = join(h.dir, "worker-success.status");
      const logPath = join(h.dir, "worker-success.log");
      h.setState({ registered: 1, label: "ai.minime.telegram-bot", pid: 1111, next_pid: 3333 });

      const { status, stdout, stderr } = h.run(["--worker", "--plist"], {
        RESTART_STATUS_PATH: statusPath,
        RESTART_LOG_PATH: logPath,
      });

      assert.strictEqual(status, 0, `expected worker success: ${stderr}`);
      assert.match(stdout, /New PID: 3333/);
      const workerStatus = readStatus(statusPath);
      assert.strictEqual(workerStatus.requestId.startsWith("restart-"), true);
      assert.strictEqual(workerStatus.mode, "worker");
      assert.strictEqual(workerStatus.status, "success");
      assert.strictEqual(workerStatus.oldPid, "1111");
      assert.strictEqual(workerStatus.newPid, "3333");
      const log = readFileSync(logPath, "utf8");
      assert.match(log, /mode=worker started/);
      assert.match(log, /mode=worker success oldPid=1111 newPid=3333/);
    } finally {
      cleanup(h);
    }
  });
});
