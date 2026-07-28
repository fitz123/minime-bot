import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import {
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import {
  buildDeliverArgs,
  buildPiCronAgentConfig,
  classifyLlmCronTerminalResult,
  classifyPiResult,
  CRON_DELIVERY_RETRY_DELAYS_MS,
  CRON_OUTBOX_EXPIRY_MS,
  CRON_OUTBOX_MAX_ATTEMPTS,
  deliver,
  DeliveryError,
  getAgentWorkspace,
  handleDeliveryFailure,
  isQueueableDeliveryFailure,
  loadAdminChatId,
  loadCronTask,
  loadDefaultDelivery,
  main,
  MINIME_CRON_UNRESOLVED_MARKER,
  resolveCronAgentData,
  resolveCronEngine,
  runOneShot,
  runScript,
  writeCronHealthMetric,
} from "../cron-runner.js";
import type {
  CronAgentData,
  CronRunnerMainDeps,
  CronTerminalOutcome,
  DeliveryDefaults,
} from "../cron-runner.js";
import {
  clearCronOutboxRecord,
  readCronOutboxRecord,
  sanitizeCronMetricStem,
  writeCronOutboxRecord,
  type CronOutboxRecord,
} from "../cron-outbox.js";
import type { CronJob } from "../types.js";
import { installCronTestEnv } from "./cron-test-env.js";

// We test the pure functions. runPi and deliver require real Pi/Telegram unless stubbed.

installCronTestEnv();

const TEST_DIR = join("/tmp", "cron-runner-test-" + Date.now());
const CRON_RUNNER_SOURCE_URL = new URL("../cron-runner.ts", import.meta.url).href;

function runMetricWriterChild(
  metricDir: string,
  cronName: string,
  outcome: CronTerminalOutcome,
  iterations: number,
): Promise<void> {
  const script = [
    `import { writeCronHealthMetric } from ${JSON.stringify(CRON_RUNNER_SOURCE_URL)};`,
    `for (let index = 0; index < ${iterations}; index += 1) {`,
    `  writeCronHealthMetric(${JSON.stringify(cronName)}, ${outcome === "success" ? 0 : 1}, ${JSON.stringify(outcome)});`,
    "}",
  ].join("\n");

  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script],
      {
        cwd: process.cwd(),
        env: { ...process.env, CRON_HEALTH_TEXTFILE_DIR: metricDir },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`metric writer child failed: code=${code} signal=${signal}\n${stderr}`));
    });
  });
}

function makeLlmCron(engine?: CronJob["engine"]): CronJob {
  const cron: CronJob = {
    name: engine ? `${engine}-engine-task` : "default-engine-task",
    schedule: "0 * * * *",
    type: "llm",
    prompt: "test",
    agentId: "main",
    deliveryChatId: 111111111,
  };
  if (engine !== undefined) {
    cron.engine = engine;
  }
  return cron;
}

describe("cron-runner", () => {
  describe("buildDeliverArgs", () => {
    it("builds argv without thread", () => {
      const args = buildDeliverArgs(111111111);
      assert.deepStrictEqual(args, ["111111111"]);
    });

    it("builds argv with thread ID", () => {
      const args = buildDeliverArgs(111111111, 12345);
      assert.deepStrictEqual(args, ["111111111", "--thread", "12345"]);
    });

    it("does not include --thread when threadId is undefined", () => {
      const args = buildDeliverArgs(123456, undefined);
      assert.ok(!args.includes("--thread"));
    });
  });

  describe("delivery failure classification", () => {
    it("retains structured delivery error evidence", () => {
      const err = new DeliveryError("Delivery failed: command failed", {
        status: 7,
        code: "ETIMEDOUT",
        stderrExcerpt: "sanitized stderr",
      });

      assert.strictEqual(err.name, "DeliveryError");
      assert.strictEqual(err.message, "Delivery failed: command failed");
      assert.strictEqual(err.status, 7);
      assert.strictEqual(err.code, "ETIMEDOUT");
      assert.strictEqual(err.stderrExcerpt, "sanitized stderr");
    });

    it("extracts, sanitizes, and bounds subprocess failure evidence", () => {
      const subprocessError = Object.assign(new Error("command failed"), {
        status: 1,
        code: "ERR_CHILD_PROCESS",
        stderr: `\u001b[31m[deliver] Error: invalid chat_id\u001b[0m ${"x".repeat(500)}`,
      });
      let caught: unknown;

      try {
        deliver(111111111, "message", undefined, {
          loadTelegramToken: () => "synthetic-test-token",
          execFileSync: () => {
            throw subprocessError;
          },
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught instanceof DeliveryError);
      assert.strictEqual(caught.message, "Delivery failed: command failed");
      assert.strictEqual(caught.status, 1);
      assert.strictEqual(caught.code, "ERR_CHILD_PROCESS");
      assert.strictEqual(caught.stderrExcerpt?.length, 400);
      assert.doesNotMatch(caught.stderrExcerpt ?? "", /\u001b/);
      assert.strictEqual(isQueueableDeliveryFailure(caught), false);
    });

    it("retries token resolution after a transient load failure", () => {
      let tokenLoads = 0;
      let subprocessCalls = 0;
      const deliveryDeps = {
        loadTelegramToken: () => {
          tokenLoads += 1;
          if (tokenLoads === 1) {
            throw new Error("temporary token source failure");
          }
          return "synthetic-test-token";
        },
        execFileSync: () => {
          subprocessCalls += 1;
          return "";
        },
      };

      assert.throws(
        () => deliver(111111111, "message", undefined, deliveryDeps),
        /Delivery failed: temporary token source failure/,
      );
      assert.doesNotThrow(() => deliver(111111111, "message", undefined, deliveryDeps));
      assert.strictEqual(tokenLoads, 2);
      assert.strictEqual(subprocessCalls, 1);
    });

    it("queues every failure except proven deliver.sh pre-send validation errors", () => {
      const cases: Array<{ name: string; error: unknown; expected: boolean }> = [
        {
          name: "invalid chat id",
          error: new DeliveryError("Delivery failed: invalid chat", {
            status: 1,
            stderrExcerpt: "[deliver] Error: invalid chat_id",
          }),
          expected: false,
        },
        {
          name: "invalid thread id",
          error: new DeliveryError("Delivery failed: invalid thread", {
            status: 1,
            stderrExcerpt: "[deliver] Error: invalid thread_id",
          }),
          expected: false,
        },
        {
          name: "empty message",
          error: new DeliveryError("Delivery failed: empty", {
            status: 1,
            stderrExcerpt: "[deliver] Error: empty message",
          }),
          expected: false,
        },
        {
          name: "same stderr with a different status",
          error: new DeliveryError("Delivery failed: wrapper", {
            status: 2,
            stderrExcerpt: "[deliver] Error: invalid chat_id",
          }),
          expected: true,
        },
        {
          name: "Telegram API rejection",
          error: new DeliveryError("Delivery failed: API rejected", {
            status: 1,
            stderrExcerpt: "[deliver] Error: sendMessage failed: {\"ok\":false}",
          }),
          expected: true,
        },
        {
          name: "curl transport exit",
          error: new DeliveryError("Delivery failed: curl", { status: 28 }),
          expected: true,
        },
        {
          name: "spawn timeout",
          error: new DeliveryError("Delivery failed: timeout", { code: "ETIMEDOUT" }),
          expected: true,
        },
        {
          name: "token load failure",
          error: new DeliveryError("Delivery failed: token unavailable"),
          expected: true,
        },
        { name: "ordinary error", error: new Error("unknown"), expected: true },
        { name: "unknown thrown value", error: "network down", expected: true },
      ];

      for (const testCase of cases) {
        assert.strictEqual(
          isQueueableDeliveryFailure(testCase.error),
          testCase.expected,
          testCase.name,
        );
      }
    });
  });

  describe("loadAdminChatId — with temp config.yaml", () => {
    const CONFIG_DIR = join(TEST_DIR, "admin-config");
    const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

    beforeEach(() => {
      mkdirSync(CONFIG_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CONFIG_DIR, { recursive: true, force: true });
    });

    it("returns adminChatId when present in config", () => {
      writeFileSync(CONFIG_FILE, `adminChatId: 999999999\nagents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, 999999999);
    });

    it("returns undefined when adminChatId is absent", () => {
      writeFileSync(CONFIG_FILE, `agents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, undefined);
    });

    it("returns undefined when adminChatId is a float", () => {
      writeFileSync(CONFIG_FILE, `adminChatId: 3.14\nagents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, undefined);
    });

    it("returns undefined when adminChatId is zero", () => {
      writeFileSync(CONFIG_FILE, `adminChatId: 0\nagents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, undefined);
    });

    it("returns adminChatId when it is negative (Telegram group chat)", () => {
      writeFileSync(CONFIG_FILE, `adminChatId: -1001234567890\nagents: {}\nbindings: []\n`);
      const id = loadAdminChatId(CONFIG_FILE);
      assert.strictEqual(id, -1001234567890);
    });
  });

  describe("handleDeliveryFailure", () => {
    it("calls deliverFn with adminChatId when adminChatId is set", () => {
      const calls: Array<[number, string]> = [];
      const mockDeliver = (chatId: number, msg: string) => {
        calls.push([chatId, msg]);
      };
      handleDeliveryFailure("my-task", 111111111, "bot blocked", 999999999, mockDeliver);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0][0], 999999999);
      assert.ok(calls[0][1].includes("my-task"));
      assert.ok(calls[0][1].includes("111111111"));
      assert.ok(calls[0][1].includes("bot blocked"));
    });

    it("does not call deliverFn when adminChatId is undefined", () => {
      const calls: Array<[number, string]> = [];
      const mockDeliver = (chatId: number, msg: string) => {
        calls.push([chatId, msg]);
      };
      handleDeliveryFailure("my-task", 111111111, "bot blocked", undefined, mockDeliver);
      assert.strictEqual(calls.length, 0);
    });

    it("does not throw when deliverFn itself throws", () => {
      const mockDeliver = () => {
        throw new Error("admin unreachable");
      };
      // Should not throw
      assert.doesNotThrow(() =>
        handleDeliveryFailure("my-task", 111111111, "bot blocked", 999999999, mockDeliver),
      );
    });
  });

  describe("loadCronTask — with temp crons.yaml", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-yaml");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("parses deliveryThreadId when present", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 111111111
    deliveryThreadId: 42
`);
      const cron = loadCronTask("test-task", CRONS_FILE);
      assert.strictEqual(cron.deliveryThreadId, 42);
      assert.strictEqual(cron.deliveryChatId, 111111111);
    });

    it("deliveryThreadId is undefined when absent", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("test-task", CRONS_FILE);
      assert.strictEqual(cron.deliveryThreadId, undefined);
    });

    it("throws when deliveryChatId is missing", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
`);
      assert.throws(() => loadCronTask("test-task", CRONS_FILE), /missing 'deliveryChatId'/);
    });

    it("throws when task name not found", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: other-task
    schedule: "0 9 * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("nonexistent", CRONS_FILE), /not found in crons.yaml/);
    });
  });

  describe("loadDefaultDelivery — with temp config.yaml", () => {
    const CONFIG_DIR = join(TEST_DIR, "delivery-config");
    const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");

    beforeEach(() => {
      mkdirSync(CONFIG_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CONFIG_DIR, { recursive: true, force: true });
    });

    it("returns both defaults when present", () => {
      writeFileSync(CONFIG_FILE, `defaultDeliveryChatId: -1001234567890\ndefaultDeliveryThreadId: 99\n`);
      const d = loadDefaultDelivery(CONFIG_FILE);
      assert.strictEqual(d.defaultDeliveryChatId, -1001234567890);
      assert.strictEqual(d.defaultDeliveryThreadId, 99);
    });

    it("returns empty object when neither field present", () => {
      writeFileSync(CONFIG_FILE, `agents: {}\n`);
      const d = loadDefaultDelivery(CONFIG_FILE);
      assert.strictEqual(d.defaultDeliveryChatId, undefined);
      assert.strictEqual(d.defaultDeliveryThreadId, undefined);
    });

    it("ignores zero values", () => {
      writeFileSync(CONFIG_FILE, `defaultDeliveryChatId: 0\ndefaultDeliveryThreadId: 0\n`);
      const d = loadDefaultDelivery(CONFIG_FILE);
      assert.strictEqual(d.defaultDeliveryChatId, undefined);
      assert.strictEqual(d.defaultDeliveryThreadId, undefined);
    });

    it("ignores non-integer values", () => {
      writeFileSync(CONFIG_FILE, `defaultDeliveryChatId: 3.14\ndefaultDeliveryThreadId: "abc"\n`);
      const d = loadDefaultDelivery(CONFIG_FILE);
      assert.strictEqual(d.defaultDeliveryChatId, undefined);
      assert.strictEqual(d.defaultDeliveryThreadId, undefined);
    });
  });

  describe("loadCronTask — config default delivery fallback", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-defaults");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("falls back to config default deliveryChatId when cron omits it", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, -1001234567890);
    });

    it("cron-level deliveryChatId overrides config default", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 999999999
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, 999999999);
    });

    it("falls back to config default deliveryThreadId when cron uses default chat", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890, defaultDeliveryThreadId: 42 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, -1001234567890);
      assert.strictEqual(cron.deliveryThreadId, 42);
    });

    it("cron-level deliveryThreadId overrides config default", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 111111111
    deliveryThreadId: 77
`);
      const defaults: DeliveryDefaults = { defaultDeliveryThreadId: 42 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryThreadId, 77);
    });

    it("throws when neither cron nor config has deliveryChatId", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
`);
      assert.throws(() => loadCronTask("test-task", CRONS_FILE, {}), /missing 'deliveryChatId'/);
    });

    it("throws when cron has invalid deliveryChatId (float) instead of falling back", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 3.14
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890 };
      assert.throws(() => loadCronTask("test-task", CRONS_FILE, defaults), /invalid 'deliveryChatId'/);
    });

    it("throws when cron has invalid deliveryChatId (zero) instead of falling back", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 0
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890 };
      assert.throws(() => loadCronTask("test-task", CRONS_FILE, defaults), /invalid 'deliveryChatId'/);
    });

    it("throws when cron has invalid deliveryThreadId (float)", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 111111111
    deliveryThreadId: 3.14
`);
      assert.throws(() => loadCronTask("test-task", CRONS_FILE), /invalid 'deliveryThreadId'/);
    });

    it("inherits default thread when cron explicitly sets same chat as default", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: -1001234567890
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890, defaultDeliveryThreadId: 42 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, -1001234567890);
      assert.strictEqual(cron.deliveryThreadId, 42);
    });

    it("does not inherit default thread when cron overrides chat", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: test-task
    schedule: "0 9 * * *"
    prompt: "test prompt"
    agentId: main
    deliveryChatId: 999999999
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890, defaultDeliveryThreadId: 42 };
      const cron = loadCronTask("test-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, 999999999);
      assert.strictEqual(cron.deliveryThreadId, undefined);
    });
  });

  describe("loadCronTask — script-mode crons", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-script");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("loads script-mode cron with command field", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: backup-task
    schedule: "0 2 * * *"
    type: script
    command: "/usr/bin/backup.sh --full"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("backup-task", CRONS_FILE);
      assert.strictEqual(cron.type, "script");
      assert.strictEqual(cron.command, "/usr/bin/backup.sh --full");
      assert.strictEqual(cron.prompt, undefined);
    });

    it("throws when script-mode cron is missing command field", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-script
    schedule: "0 2 * * *"
    type: script
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("bad-script", CRONS_FILE), /missing required 'command' field/);
    });

    it("defaults type to llm when not specified", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: llm-task
    schedule: "0 9 * * *"
    prompt: "do something"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("llm-task", CRONS_FILE);
      assert.strictEqual(cron.type, "llm");
      assert.strictEqual(cron.prompt, "do something");
      assert.strictEqual(cron.command, undefined);
    });

    it("throws when llm-mode cron is missing prompt field", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-llm
    schedule: "0 9 * * *"
    type: llm
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("bad-llm", CRONS_FILE), /missing required 'prompt' field/);
    });

    it("throws when script command is whitespace-only", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-script
    schedule: "0 2 * * *"
    type: script
    command: "   "
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("bad-script", CRONS_FILE), /missing required 'command' field/);
    });

    it("throws when llm prompt is whitespace-only", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-llm
    schedule: "0 9 * * *"
    prompt: "   "
    agentId: main
    deliveryChatId: 111111111
`);
      assert.throws(() => loadCronTask("bad-llm", CRONS_FILE), /missing required 'prompt' field/);
    });

    it("throws when type is invalid", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-type
    schedule: "0 9 * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    type: scrpt
`);
      assert.throws(() => loadCronTask("bad-type", CRONS_FILE), /invalid type "scrpt"/);
    });

    it("script-mode cron uses config default delivery", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: script-task
    schedule: "0 2 * * *"
    type: script
    command: "echo hello"
    agentId: main
`);
      const defaults: DeliveryDefaults = { defaultDeliveryChatId: -1001234567890, defaultDeliveryThreadId: 99 };
      const cron = loadCronTask("script-task", CRONS_FILE, defaults);
      assert.strictEqual(cron.deliveryChatId, -1001234567890);
      assert.strictEqual(cron.deliveryThreadId, 99);
    });
  });

  describe("loadCronTask — enabled field", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-enabled");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("parses enabled: false from YAML", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: disabled-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    enabled: false
`);
      const cron = loadCronTask("disabled-task", CRONS_FILE);
      assert.strictEqual(cron.enabled, false);
    });

    it("returns undefined for enabled when omitted", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: default-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("default-task", CRONS_FILE);
      assert.strictEqual(cron.enabled, undefined);
    });

    it("throws when timeout is zero", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-timeout
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    timeout: 0
`);
      assert.throws(() => loadCronTask("bad-timeout", CRONS_FILE), /invalid 'timeout'/);
    });

    it("throws when timeout is negative", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-timeout
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    timeout: -1000
`);
      assert.throws(() => loadCronTask("bad-timeout", CRONS_FILE), /invalid 'timeout'/);
    });

    it("returns undefined for enabled: true (only false is preserved)", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: enabled-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    enabled: true
`);
      const cron = loadCronTask("enabled-task", CRONS_FILE);
      assert.strictEqual(cron.enabled, undefined);
    });
  });

  describe("loadCronTask — engine field", () => {
    const CRONS_DIR = join(TEST_DIR, "cron-engine");
    const CRONS_FILE = join(CRONS_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CRONS_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CRONS_DIR, { recursive: true, force: true });
    });

    it("returns undefined engine when omitted", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: default-engine-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
`);
      const cron = loadCronTask("default-engine-task", CRONS_FILE);
      assert.strictEqual(cron.engine, undefined);
    });

    it("rejects engine: claude with a migration error", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: claude-engine-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    engine: claude
`);
      assert.throws(
        () => loadCronTask("claude-engine-task", CRONS_FILE),
        /Claude cron runtime was removed; remove engine or set engine: pi/,
      );
    });

    it("parses engine: pi", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: pi-engine-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    engine: pi
`);
      const cron = loadCronTask("pi-engine-task", CRONS_FILE);
      assert.strictEqual(cron.engine, "pi");
    });

    it("rejects invalid engine values", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: bad-engine-task
    schedule: "0 * * * *"
    prompt: "test"
    agentId: main
    deliveryChatId: 111111111
    engine: codex
`);
      assert.throws(() => loadCronTask("bad-engine-task", CRONS_FILE), /invalid 'engine' "codex" \(must be "pi" or omitted\)/);
    });

    it("ignores engine on script crons without changing script validation", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: script-engine-task
    schedule: "0 * * * *"
    type: script
    command: "echo script"
    agentId: main
    deliveryChatId: 111111111
    engine: pi
`);
      const cron = loadCronTask("script-engine-task", CRONS_FILE);
      assert.strictEqual(cron.type, "script");
      assert.strictEqual(cron.command, "echo script");
      assert.strictEqual(cron.prompt, undefined);
      assert.strictEqual(cron.engine, undefined);
    });

    it("ignores invalid engine values on script crons", () => {
      writeFileSync(CRONS_FILE, `crons:
  - name: script-bad-engine-task
    schedule: "0 * * * *"
    type: script
    command: "echo script"
    agentId: main
    deliveryChatId: 111111111
    engine: codex
`);
      const cron = loadCronTask("script-bad-engine-task", CRONS_FILE);
      assert.strictEqual(cron.type, "script");
      assert.strictEqual(cron.command, "echo script");
      assert.strictEqual(cron.engine, undefined);
    });
  });

  describe("cron engine dispatch", () => {
    let oldCronPiDisabled: string | undefined;

    beforeEach(() => {
      oldCronPiDisabled = process.env.CRON_PI_DISABLED;
      delete process.env.CRON_PI_DISABLED;
    });

    afterEach(() => {
      if (oldCronPiDisabled === undefined) {
        delete process.env.CRON_PI_DISABLED;
      } else {
        process.env.CRON_PI_DISABLED = oldCronPiDisabled;
      }
    });

    function makeDispatchDeps(calls: string[]) {
      return {
        runPi: (cron: CronJob, workspaceCwd: string): string => {
          calls.push(`pi:${cron.name}:${workspaceCwd}`);
          return "pi-output";
        },
      };
    }

    it("defaults omitted engine to Pi", () => {
      const cron = makeLlmCron();
      const calls: string[] = [];

      assert.strictEqual(resolveCronEngine(cron), "pi");
      assert.strictEqual(runOneShot(cron, "/tmp/workspace", makeDispatchDeps(calls)), "pi-output");
      assert.deepStrictEqual(calls, ["pi:default-engine-task:/tmp/workspace"]);
    });

    it("dispatches explicit Pi engine to Pi", () => {
      const cron = makeLlmCron("pi");
      const calls: string[] = [];

      assert.strictEqual(resolveCronEngine(cron), "pi");
      assert.strictEqual(runOneShot(cron, "/tmp/workspace", makeDispatchDeps(calls)), "pi-output");
      assert.deepStrictEqual(calls, ["pi:pi-engine-task:/tmp/workspace"]);
    });

    it("rejects the old CRON_PI_DISABLED fallback", () => {
      const cron = makeLlmCron("pi");
      const calls: string[] = [];
      process.env.CRON_PI_DISABLED = "1";

      assert.throws(() => resolveCronEngine(cron), /CRON_PI_DISABLED=1 is no longer supported/);
      assert.throws(
        () => runOneShot(cron, "/tmp/workspace", makeDispatchDeps(calls)),
        /CRON_PI_DISABLED=1 is no longer supported/,
      );
      assert.deepStrictEqual(calls, []);
    });
  });

  describe("Pi result classification", () => {
    const cases = [
      {
        name: "returns trimmed stdout for a zero exit with output",
        args: [0, null, "  hello from pi\n", ""] as const,
        expected: { status: "ok" as const, output: "hello from pi" },
      },
      {
        name: "treats a zero exit with empty stdout and empty stderr as intentional empty success",
        args: [0, null, " \n\t", ""] as const,
        expected: { status: "ok" as const, output: "" },
      },
      {
        name: "preserves NO_REPLY output for the existing post-run suppression logic",
        args: [0, null, "\nNO_REPLY\n", "diagnostic warning"] as const,
        expected: { status: "ok" as const, output: "NO_REPLY" },
      },
      {
        name: "treats a zero exit with empty stdout and non-empty stderr as an error",
        args: [0, null, "", "auth expired"] as const,
        messageMatches: [/stderr without stdout/],
        diagnosticMatches: [/stderr: auth expired/],
      },
      {
        name: "treats a non-zero exit as an error with bounded stderr and stdout diagnostics",
        args: [2, null, "partial output", "failure details"] as const,
        messageMatches: [/code 2/],
        diagnosticMatches: [/stderr: failure details/, /stdout: partial output/],
      },
      {
        name: "treats a signal as an error with bounded output diagnostics",
        args: [null, "SIGTERM", "partial output", "terminated"] as const,
        messageMatches: [/signal SIGTERM/],
        diagnosticMatches: [/stderr: terminated/, /stdout: partial output/],
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        const [exitCode, signal, stdout, stderr] = testCase.args;
        const result = classifyPiResult(exitCode, signal, stdout, stderr);
        if ("expected" in testCase) {
          assert.deepStrictEqual(result, testCase.expected);
          return;
        }
        assert.strictEqual(result.status, "error");
        for (const pattern of testCase.messageMatches) {
          assert.match(result.message, pattern);
        }
        for (const pattern of testCase.diagnosticMatches) {
          assert.match(result.diagnostics ?? "", pattern);
        }
      });
    }

    it("treats a missing exit code without signal as an error", () => {
      const result = classifyPiResult(undefined, null, "", "");

      assert.strictEqual(result.status, "error");
      assert.match(result.message, /without an exit code/);
    });

    it("bounds long stderr/stdout excerpts in diagnostics", () => {
      const longStdout = `stdout-${"o".repeat(2100)}-tail`;
      const longStderr = `stderr-${"e".repeat(2100)}-tail`;
      const result = classifyPiResult(1, null, longStdout, longStderr);

      assert.strictEqual(result.status, "error");
      assert.match(result.message, /code 1/);
      assert.match(result.diagnostics ?? "", /stderr \(first 1000 chars\): stderr-eeee/);
      assert.match(result.diagnostics ?? "", /stdout \(first 1000 chars\): stdout-oooo/);
      assert.match(result.diagnostics ?? "", /truncated \d+ chars/);
      assert.doesNotMatch(result.diagnostics ?? "", /-tail/);
      assert.ok((result.diagnostics ?? "").length < 2400, `diagnostics were not bounded: ${result.diagnostics?.length}`);
    });
  });

  describe("LLM cron terminal classification", () => {
    it("strips one exact final unresolved marker and classifies failure", () => {
      assert.deepStrictEqual(
        classifyLlmCronTerminalResult(
          `Finding remains unresolved.\n\n${MINIME_CRON_UNRESOLVED_MARKER}\n`,
        ),
        {
          output: "Finding remains unresolved.",
          outcome: "failure",
        },
      );
      assert.deepStrictEqual(
        classifyLlmCronTerminalResult(
          `Finding remains unresolved.\r\n\r\n${MINIME_CRON_UNRESOLVED_MARKER}\r\n`,
        ),
        {
          output: "Finding remains unresolved.",
          outcome: "failure",
        },
      );
    });

    it("accepts a marker-only unresolved result without creating deliverable output", () => {
      assert.deepStrictEqual(
        classifyLlmCronTerminalResult(MINIME_CRON_UNRESOLVED_MARKER),
        { output: "", outcome: "failure" },
      );
    });

    it("leaves embedded, quoted, non-final, and repeated marker-like prose unchanged", () => {
      const cases = [
        `The token ${MINIME_CRON_UNRESOLVED_MARKER} is documented here.`,
        `> ${MINIME_CRON_UNRESOLVED_MARKER}`,
        `\`${MINIME_CRON_UNRESOLVED_MARKER}\``,
        `${MINIME_CRON_UNRESOLVED_MARKER}\nThis is the final line.`,
        `${MINIME_CRON_UNRESOLVED_MARKER}\n${MINIME_CRON_UNRESOLVED_MARKER}`,
        ` ${MINIME_CRON_UNRESOLVED_MARKER}`,
        `${MINIME_CRON_UNRESOLVED_MARKER} `,
        `\t${MINIME_CRON_UNRESOLVED_MARKER}\t`,
      ];

      for (const output of cases) {
        assert.deepStrictEqual(
          classifyLlmCronTerminalResult(output),
          { output, outcome: "success" },
        );
      }
    });
  });

  describe("cron agent data resolution", () => {
    const CONFIG_DIR = join(TEST_DIR, "cron-agent-config");
    const CONFIG_FILE = join(CONFIG_DIR, "config.yaml");
    const CRONS_FILE = join(CONFIG_DIR, "crons.yaml");

    beforeEach(() => {
      mkdirSync(CONFIG_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(CONFIG_DIR, { recursive: true, force: true });
    });

    it("resolves the default main agent for cron Pi context assembly", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    id: ignored-raw-id
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    systemPrompt: "Use the main persona"
    thinking: high
bindings: []
`);
      writeFileSync(CRONS_FILE, `crons:
  - name: default-main-cron
    schedule: "0 * * * *"
    prompt: "test"
    deliveryChatId: 111111111
`);

      const cron = loadCronTask("default-main-cron", CRONS_FILE);
      const agent = buildPiCronAgentConfig(cron.agentId, CONFIG_FILE);

      assert.strictEqual(cron.agentId, "main");
      assert.deepStrictEqual(agent, {
        id: "main",
        workspaceCwd: "/tmp/main-workspace",
        provider: "pi",
        model: "openai-codex/gpt-5.5",
        systemPrompt: "Use the main persona",
        thinking: "high",
      });
    });

    it("propagates and normalizes the selected agent model", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: "  gpt-5.5  "
  worker:
    workspaceCwd: /tmp/worker-workspace
    model: "  custom-provider/custom-model  "
bindings: []
`);

      const mainAgent = buildPiCronAgentConfig("main", CONFIG_FILE);
      const workerAgent = buildPiCronAgentConfig("worker", CONFIG_FILE);

      assert.strictEqual(mainAgent.model, "openai-codex/gpt-5.5");
      assert.strictEqual(workerAgent.model, "custom-provider/custom-model");
      assert.strictEqual(mainAgent.workspaceCwd, "/tmp/main-workspace");
      assert.strictEqual(workerAgent.workspaceCwd, "/tmp/worker-workspace");
    });

    it("validates askAgent references on the cron agent config path", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    askAgent:
      enabled: true
      canAsk:
        - missing-agent
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("main", CONFIG_FILE),
        /Agent "main" askAgent\.canAsk\[0\] references unknown agent "missing-agent"/,
      );
    });

    it("ignores non-string systemPrompt", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    systemPrompt: 42
bindings: []
`);

      const agent = buildPiCronAgentConfig("main", CONFIG_FILE);
      assert.strictEqual(agent.systemPrompt, undefined);
      assert.strictEqual(agent.thinking, undefined);
    });

    it("rejects unsupported thinking values through shared agent validation", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    thinking: turbo
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("main", CONFIG_FILE),
        /Agent "main" has invalid thinking "turbo"/,
      );
    });

    it("rejects obsolete Claude-era fields through shared agent validation", () => {
      const cases: Array<{ yaml: string; pattern: RegExp }> = [
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    provider: claude
bindings: []
`,
          pattern: /Agent "main" uses provider "claude"/,
        },
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    fallbackModel: gpt-5-mini
bindings: []
`,
          pattern: /Agent "main" uses fallbackModel/,
        },
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    effort: high
bindings: []
`,
          pattern: /Agent "main" uses effort/,
        },
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    maxTurns: 10
bindings: []
`,
          pattern: /Agent "main" uses maxTurns/,
        },
        {
          yaml: `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
    allowedTools: ["Read"]
bindings: []
`,
          pattern: /Agent "main" uses allowedTools/,
        },
        {
          yaml: `defaultFallbackModel: gpt-5-mini
agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
bindings: []
`,
          pattern: /defaultFallbackModel was removed with the Claude runtime/,
        },
      ];

      for (const { yaml, pattern } of cases) {
        writeFileSync(CONFIG_FILE, yaml);
        assert.throws(() => buildPiCronAgentConfig("main", CONFIG_FILE), pattern);
      }
    });

    it("getAgentWorkspace uses the same agent config resolution", () => {
      writeFileSync(CONFIG_FILE, `agents:
  worker:
    workspaceCwd: /tmp/worker-workspace
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.strictEqual(getAgentWorkspace("worker", CONFIG_FILE), "/tmp/worker-workspace");
      assert.deepStrictEqual(resolveCronAgentData("worker", CONFIG_FILE), {
        id: "worker",
        workspaceCwd: "/tmp/worker-workspace",
        model: "openai-codex/gpt-5.5",
      });
    });

    it("resolves relative workspaceCwd against the config workspace root", () => {
      const workspace = join(CONFIG_DIR, "workspace");
      const agentWorkspace = join(workspace, "agent-workspace");
      const configFile = join(workspace, "config.yaml");
      mkdirSync(agentWorkspace, { recursive: true });
      writeFileSync(configFile, `agents:
  main:
    workspaceCwd: ./agent-workspace
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.strictEqual(getAgentWorkspace("main", configFile), agentWorkspace);
      assert.deepStrictEqual(resolveCronAgentData("main", configFile), {
        id: "main",
        workspaceCwd: agentWorkspace,
        model: "openai-codex/gpt-5.5",
      });
    });

    it("throws before spawn when the cron agent is missing", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("missing", CONFIG_FILE),
        /Agent "missing" not found in config.yaml \/ config.local.yaml/,
      );
    });

    it("throws before spawn when workspaceCwd is missing", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("main", CONFIG_FILE),
        /Agent "main" missing workspaceCwd/,
      );
    });

    it("throws before spawn when workspaceCwd is invalid", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: 42
    model: openai-codex/gpt-5.5
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("main", CONFIG_FILE),
        /Agent "main" missing workspaceCwd/,
      );
    });

    it("throws before spawn when the selected agent model is blank", () => {
      writeFileSync(CONFIG_FILE, `agents:
  main:
    workspaceCwd: /tmp/main-workspace
    model: "   "
bindings: []
`);

      assert.throws(
        () => buildPiCronAgentConfig("main", CONFIG_FILE),
        /Agent "main" has invalid model \(must be a non-empty string\)/,
      );
    });
  });

  describe("cron health metrics", () => {
    const METRIC_DIR = join(TEST_DIR, "cron-health-metrics");
    let oldTextfileDir: string | undefined;

    beforeEach(() => {
      oldTextfileDir = process.env.CRON_HEALTH_TEXTFILE_DIR;
      mkdirSync(METRIC_DIR, { recursive: true });
      process.env.CRON_HEALTH_TEXTFILE_DIR = METRIC_DIR;
    });

    afterEach(() => {
      if (oldTextfileDir === undefined) {
        delete process.env.CRON_HEALTH_TEXTFILE_DIR;
      } else {
        process.env.CRON_HEALTH_TEXTFILE_DIR = oldTextfileDir;
      }
      rmSync(METRIC_DIR, { recursive: true, force: true });
    });

    function captureStderr(run: () => void): string {
      const oldWrite = process.stderr.write;
      const stderrWrites: string[] = [];
      try {
        process.stderr.write = ((chunk: string | Uint8Array) => {
          stderrWrites.push(String(chunk));
          return true;
        }) as typeof process.stderr.write;
        run();
      } finally {
        process.stderr.write = oldWrite;
      }
      return stderrWrites.join("");
    }

    it("writes all terminal series to stable hashed textfiles without temporary residue", () => {
      const before = Math.floor(Date.now() / 1000);

      writeCronHealthMetric("Daily Pi / Main!", 0, "success");

      const files = readdirSync(METRIC_DIR).filter((name) => name.endsWith(".prom")).sort();
      assert.strictEqual(files.length, 2);
      assert.ok(files.some((name) => /^minime_cron_Daily_Pi_Main_[a-f0-9]{12}\.success\.prom$/.test(name)), files.join(","));
      assert.ok(files.some((name) => /^minime_cron_Daily_Pi_Main_[a-f0-9]{12}\.exit\.prom$/.test(name)), files.join(","));
      const content = files.map((name) => readFileSync(join(METRIC_DIR, name), "utf8")).join("\n");
      const after = Math.floor(Date.now() / 1000);
      const timestampMatch = content.match(
        /minime_cron_last_success_timestamp\{cron="Daily Pi \/ Main!"\} (\d+)/,
      );

      assert.ok(timestampMatch, content);
      const timestamp = Number(timestampMatch[1]);
      assert.ok(timestamp >= before && timestamp <= after, `timestamp ${timestamp} outside test window`);
      assert.match(content, /minime_cron_last_exit_code\{cron="Daily Pi \/ Main!"\} 0/);
      assert.match(
        content,
        /minime_cron_runs_total\{cron="Daily Pi \/ Main!",outcome="success"\} 1/,
      );
      assert.match(
        content,
        /minime_cron_runs_total\{cron="Daily Pi \/ Main!",outcome="failure"\} 0/,
      );
      assert.match(
        content,
        /minime_cron_last_run_timestamp_seconds\{cron="Daily Pi \/ Main!"\} \d+/,
      );
      assert.doesNotMatch(content, /\{[^}]*?(?:error|run_id|destination|chat_id)=/);
      assert.deepStrictEqual(
        readdirSync(METRIC_DIR).filter((name) => name.endsWith(".tmp")),
        [],
      );
    });

    it("preserves the success timestamp and monotonically restores both counters from disk", () => {
      writeCronHealthMetric("failing-cron", 0, "success");
      const successFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".success.prom"));
      assert.ok(successFile);
      const successContent = readFileSync(join(METRIC_DIR, successFile), "utf8");

      writeCronHealthMetric("failing-cron", 2, "failure");

      assert.strictEqual(readFileSync(join(METRIC_DIR, successFile), "utf8"), successContent);
      const exitFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      assert.ok(exitFile);
      const exitContent = readFileSync(join(METRIC_DIR, exitFile), "utf8");
      assert.match(exitContent, /minime_cron_last_exit_code\{cron="failing-cron"\} 2/);
      assert.match(
        exitContent,
        /minime_cron_runs_total\{cron="failing-cron",outcome="success"\} 1/,
      );
      assert.match(
        exitContent,
        /minime_cron_runs_total\{cron="failing-cron",outcome="failure"\} 1/,
      );

      writeCronHealthMetric("failing-cron", 0, "success");
      const repairedContent = readFileSync(join(METRIC_DIR, exitFile), "utf8");
      assert.match(
        repairedContent,
        /minime_cron_runs_total\{cron="failing-cron",outcome="success"\} 2/,
      );
      assert.match(
        repairedContent,
        /minime_cron_runs_total\{cron="failing-cron",outcome="failure"\} 1/,
      );
      assert.match(repairedContent, /minime_cron_last_exit_code\{cron="failing-cron"\} 0/);
    });

    it("advances the exact terminal timestamp on every outcome and success time only on success", (t) => {
      let now = 1_900_000_000_000;
      t.mock.method(Date, "now", () => now);

      writeCronHealthMetric("timestamp-contract", 0, "success");
      const exitFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      const successFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".success.prom"));
      assert.ok(exitFile);
      assert.ok(successFile);
      assert.match(
        readFileSync(join(METRIC_DIR, exitFile), "utf8"),
        /minime_cron_last_run_timestamp_seconds\{cron="timestamp-contract"\} 1900000000/,
      );
      assert.match(
        readFileSync(join(METRIC_DIR, successFile), "utf8"),
        /minime_cron_last_success_timestamp\{cron="timestamp-contract"\} 1900000000/,
      );

      now += 60_000;
      writeCronHealthMetric("timestamp-contract", 1, "failure");
      assert.match(
        readFileSync(join(METRIC_DIR, exitFile), "utf8"),
        /minime_cron_last_run_timestamp_seconds\{cron="timestamp-contract"\} 1900000060/,
      );
      assert.match(
        readFileSync(join(METRIC_DIR, successFile), "utf8"),
        /minime_cron_last_success_timestamp\{cron="timestamp-contract"\} 1900000000/,
      );

      now += 60_000;
      writeCronHealthMetric("timestamp-contract", 0, "success");
      assert.match(
        readFileSync(join(METRIC_DIR, exitFile), "utf8"),
        /minime_cron_last_run_timestamp_seconds\{cron="timestamp-contract"\} 1900000120/,
      );
      assert.match(
        readFileSync(join(METRIC_DIR, successFile), "utf8"),
        /minime_cron_last_success_timestamp\{cron="timestamp-contract"\} 1900000120/,
      );
    });

    it("serializes concurrent process writers without losing terminal counts", async () => {
      const cronName = "concurrent-metric";
      await Promise.all([
        runMetricWriterChild(METRIC_DIR, cronName, "success", 8),
        runMetricWriterChild(METRIC_DIR, cronName, "failure", 8),
        runMetricWriterChild(METRIC_DIR, cronName, "success", 8),
        runMetricWriterChild(METRIC_DIR, cronName, "failure", 8),
        runMetricWriterChild(METRIC_DIR, cronName, "success", 8),
        runMetricWriterChild(METRIC_DIR, cronName, "failure", 8),
      ]);

      const exitFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      assert.ok(exitFile);
      const content = readFileSync(join(METRIC_DIR, exitFile), "utf8");
      assert.match(
        content,
        /minime_cron_runs_total\{cron="concurrent-metric",outcome="success"\} 24/,
      );
      assert.match(
        content,
        /minime_cron_runs_total\{cron="concurrent-metric",outcome="failure"\} 24/,
      );
      assert.deepStrictEqual(
        readdirSync(METRIC_DIR).filter((name) => name.endsWith(".lock")),
        [],
      );
    });

    it("recovers a stale writer lock left by a terminated process", () => {
      const cronName = "stale-lock";
      const stem = sanitizeCronMetricStem(cronName);
      const lockPath = join(METRIC_DIR, `.minime_cron_${stem}.lock`);
      writeFileSync(lockPath, "stale\n");
      utimesSync(lockPath, new Date(0), new Date(0));

      writeCronHealthMetric(cronName, 0, "success");

      assert.ok(!readdirSync(METRIC_DIR).includes(`.minime_cron_${stem}.lock`));
      const exitFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      assert.ok(exitFile);
      assert.match(
        readFileSync(join(METRIC_DIR, exitFile), "utf8"),
        /minime_cron_runs_total\{cron="stale-lock",outcome="success"\} 1/,
      );
    });

    it("starts a valid counter epoch when prior state is missing or corrupt", () => {
      writeCronHealthMetric("counter-reset", 1, "failure");
      const exitFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      assert.ok(exitFile);
      const exitPath = join(METRIC_DIR, exitFile);
      assert.match(
        readFileSync(exitPath, "utf8"),
        /minime_cron_runs_total\{cron="counter-reset",outcome="failure"\} 1/,
      );

      writeFileSync(exitPath, "not prometheus state\n", "utf8");
      writeCronHealthMetric("counter-reset", 0, "success");
      const resetContent = readFileSync(exitPath, "utf8");
      assert.match(
        resetContent,
        /minime_cron_runs_total\{cron="counter-reset",outcome="success"\} 1/,
      );
      assert.match(
        resetContent,
        /minime_cron_runs_total\{cron="counter-reset",outcome="failure"\} 0/,
      );
    });

    it("keeps distinct files and labels for cron names that sanitize to the same stem", () => {
      writeCronHealthMetric("a/b", 1, "failure");
      writeCronHealthMetric("a_b", 1, "failure");

      const files = readdirSync(METRIC_DIR).filter((name) => name.endsWith(".exit.prom")).sort();
      assert.strictEqual(files.length, 2);
      assert.notStrictEqual(files[0], files[1]);
      const content = files.map((name) => readFileSync(join(METRIC_DIR, name), "utf8")).join("\n");
      assert.match(content, /minime_cron_last_exit_code\{cron="a\/b"\} 1/);
      assert.match(content, /minime_cron_last_exit_code\{cron="a_b"\} 1/);
    });

    it("normalizes contradictory exit values to the closed terminal outcome", () => {
      writeCronHealthMetric("normalized-outcome", 0, "failure");
      const exitFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      assert.ok(exitFile);
      assert.match(
        readFileSync(join(METRIC_DIR, exitFile), "utf8"),
        /minime_cron_last_exit_code\{cron="normalized-outcome"\} 1/,
      );

      writeCronHealthMetric("normalized-outcome", 9, "success");
      const content = readFileSync(join(METRIC_DIR, exitFile), "utf8");
      assert.match(content, /minime_cron_last_exit_code\{cron="normalized-outcome"\} 0/);
      assert.match(
        content,
        /minime_cron_runs_total\{cron="normalized-outcome",outcome="success"\} 1/,
      );
      assert.match(
        content,
        /minime_cron_runs_total\{cron="normalized-outcome",outcome="failure"\} 1/,
      );
    });

    it("escapes quotes, backslashes, newlines, and carriage returns in Prometheus labels", () => {
      writeCronHealthMetric('quoted"slash\\newline\ncarriage\rname', 7, "failure");

      const file = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      assert.ok(file);
      const content = readFileSync(join(METRIC_DIR, file), "utf8");
      assert.match(
        content,
        /^minime_cron_last_exit_code\{cron="quoted\\"slash\\\\newline\\ncarriage\\rname"\} 7$/m,
      );
      assert.match(
        content,
        /^minime_cron_runs_total\{cron="quoted\\"slash\\\\newline\\ncarriage\\rname",outcome="failure"\} 1$/m,
      );
    });

    it("does not reset or overwrite counters after an unexpected prior-state read error", () => {
      const cronName = "unreadable-prior-state";
      const stem = sanitizeCronMetricStem(cronName);
      const exitPath = join(METRIC_DIR, `minime_cron_${stem}.exit.prom`);
      mkdirSync(exitPath);

      const stderr = captureStderr(() => {
        assert.doesNotThrow(() => writeCronHealthMetric(cronName, 1, "failure"));
      });

      assert.match(stderr, /failed to read prior cron health metric/);
      assert.deepStrictEqual(readdirSync(exitPath), []);
      assert.deepStrictEqual(
        readdirSync(METRIC_DIR).filter((name) => name.endsWith(".tmp")),
        [],
      );
    });

    it("cleans a temporary file when the success snapshot rename fails", () => {
      const cronName = "rename-cleanup";
      const stem = sanitizeCronMetricStem(cronName);
      const successPath = join(METRIC_DIR, `minime_cron_${stem}.success.prom`);
      mkdirSync(successPath);

      const stderr = captureStderr(() => {
        assert.doesNotThrow(() => writeCronHealthMetric(cronName, 0, "success"));
      });

      assert.match(stderr, /failed to write cron health success metric/);
      assert.deepStrictEqual(readdirSync(successPath), []);
      assert.deepStrictEqual(
        readdirSync(METRIC_DIR).filter((name) => name.endsWith(".tmp")),
        [],
      );
      const exitFile = readdirSync(METRIC_DIR).find((name) => name.endsWith(".exit.prom"));
      assert.ok(exitFile);
      assert.match(
        readFileSync(join(METRIC_DIR, exitFile), "utf8"),
        /minime_cron_runs_total\{cron="rename-cleanup",outcome="success"\} 1/,
      );
    });

    it("warns but does not throw when the textfile path cannot be written", () => {
      const blocker = join(METRIC_DIR, "not-a-directory");
      writeFileSync(blocker, "blocking file", "utf8");
      process.env.CRON_HEALTH_TEXTFILE_DIR = join(blocker, "child");
      const stderr = captureStderr(() => {
        assert.doesNotThrow(() => writeCronHealthMetric("blocked metric", 1, "failure"));
      });
      assert.match(stderr, /blocked metric/);
      assert.match(stderr, /failed to prepare cron health metric dir/);
    });
  });

  describe("main behavior preservation", () => {
    class MainExitError extends Error {
      code: number;

      constructor(code: number) {
        super(`process.exit(${code})`);
        this.code = code;
      }
    }

    interface MainCalls {
      consoleErrors: string[];
      logs: Array<{ taskName: string; message: string }>;
      defaultLoads: number;
      cronLoads: Array<{ taskName: string; defaults?: DeliveryDefaults }>;
      adminLoads: number;
      workspaces: string[];
      scripts: string[];
      oneShots: Array<{ cronName: string; workspaceCwd: string; engine: "pi"; agentData?: CronAgentData }>;
      deliveries: Array<{ chatId: number; message: string; threadId?: number }>;
      deliveryFailures: Array<{
        cronName: string;
        targetChatId: number;
        errorMsg: string;
        adminChatId: number | undefined;
      }>;
      metrics: Array<{ cronName: string; exitCode: number; success: boolean }>;
      sleeps: number[];
      outboxReads: string[];
      outboxWrites: CronOutboxRecord[];
      outboxClears: string[];
      events: string[];
      exits: number[];
    }

    interface MainHarnessState {
      pending: CronOutboxRecord | "corrupt" | undefined;
    }

    function makeMainCron(overrides: Partial<CronJob> = {}): CronJob {
      return {
        name: "main-behavior-task",
        schedule: "0 * * * *",
        type: "llm",
        prompt: "test prompt",
        agentId: "main",
        deliveryChatId: 111111111,
        deliveryThreadId: 42,
        ...overrides,
      };
    }

    function makePendingRecord(
      cron: CronJob,
      overrides: Partial<CronOutboxRecord> = {},
    ): CronOutboxRecord {
      return {
        version: 1,
        cron: cron.name,
        runId: `${cron.name}@2026-07-17T09:00:01.234Z#4242`,
        kind: "output",
        payload: "owed output",
        chatId: cron.deliveryChatId,
        ...(cron.deliveryThreadId === undefined ? {} : { threadId: cron.deliveryThreadId }),
        createdAt: new Date().toISOString(),
        attempts: 0,
        ...overrides,
      };
    }

    function makeMainHarness(cron: CronJob): {
      calls: MainCalls;
      deps: CronRunnerMainDeps;
      state: MainHarnessState;
    } {
      const calls: MainCalls = {
        consoleErrors: [],
        logs: [],
        defaultLoads: 0,
        cronLoads: [],
        adminLoads: 0,
        workspaces: [],
        scripts: [],
        oneShots: [],
        deliveries: [],
        deliveryFailures: [],
        metrics: [],
        sleeps: [],
        outboxReads: [],
        outboxWrites: [],
        outboxClears: [],
        events: [],
        exits: [],
      };
      const state: MainHarnessState = { pending: undefined };

      const deps: CronRunnerMainDeps = {
        argv: ["node", "cron-runner.ts", "--task", cron.name],
        consoleError: (message?: unknown) => {
          calls.consoleErrors.push(String(message));
        },
        exit: (code: number): never => {
          calls.exits.push(code);
          throw new MainExitError(code);
        },
        log: (taskName: string, message: string) => {
          calls.logs.push({ taskName, message });
        },
        loadDefaultDelivery: () => {
          calls.defaultLoads += 1;
          return {};
        },
        loadCronTask: (taskName: string, _cronsPath?: string, defaults?: DeliveryDefaults) => {
          calls.cronLoads.push({ taskName, defaults });
          return cron;
        },
        loadAdminChatId: () => {
          calls.adminLoads += 1;
          return 999999999;
        },
        resolveCronAgentData: (agentId: string) => {
          calls.workspaces.push(agentId);
          return {
            id: agentId,
            workspaceCwd: "/tmp/main-workspace",
            model: "openai-codex/gpt-5.5",
            systemPrompt: "persona",
            thinking: "high",
          };
        },
        runScript: (scriptCron: CronJob) => {
          calls.scripts.push(scriptCron.name);
          calls.events.push(`generate:${scriptCron.name}`);
          return "script output";
        },
        runPi: (llmCron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => {
          calls.oneShots.push({ cronName: llmCron.name, workspaceCwd, engine: "pi", agentData });
          calls.events.push(`generate:${llmCron.name}`);
          return "llm output";
        },
        deliver: (chatId: number, message: string, threadId?: number) => {
          calls.deliveries.push({ chatId, message, threadId });
          calls.events.push(`deliver:${message}`);
        },
        sleep: async (ms: number) => {
          calls.sleeps.push(ms);
        },
        readCronOutboxRecord: (cronName: string) => {
          calls.outboxReads.push(cronName);
          return state.pending;
        },
        writeCronOutboxRecord: (record: CronOutboxRecord) => {
          calls.outboxWrites.push(record);
          state.pending = record;
        },
        clearCronOutboxRecord: (cronName: string) => {
          calls.outboxClears.push(cronName);
          state.pending = undefined;
        },
        handleDeliveryFailure: (
          cronName: string,
          targetChatId: number,
          errorMsg: string,
          adminChatId: number | undefined,
        ) => {
          calls.deliveryFailures.push({ cronName, targetChatId, errorMsg, adminChatId });
        },
        writeCronHealthMetric: (
          cronName: string,
          exitCode: number,
          outcome: CronTerminalOutcome,
        ) => {
          calls.metrics.push({ cronName, exitCode, success: outcome === "success" });
        },
      };

      return { calls, deps, state };
    }

    async function assertMainExits(
      deps: Partial<CronRunnerMainDeps>,
      expectedCode: number,
    ): Promise<void> {
      await assert.rejects(
        () => main(deps),
        (err: unknown) => err instanceof MainExitError && err.code === expectedCode,
      );
    }

    it("writes an unknown failure metric and exits when --task is missing", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.argv = ["node", "cron-runner.ts"];

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.consoleErrors, ["Usage: cron-runner.ts --task <name>"]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: "unknown", exitCode: 1, success: false },
      ]);
      assert.deepStrictEqual(calls.cronLoads, []);
    });

    it("records one failure when cron configuration cannot be loaded", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.loadCronTask = () => {
        throw new Error("invalid cron configuration");
      };

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
      assert.ok(calls.logs.some((entry) =>
        entry.message === "FAIL: invalid cron configuration"));
    });

    it("keeps script crons on the script path and delivers their output", async () => {
      const cron = makeMainCron({
        type: "script",
        prompt: undefined,
        command: "echo script",
        engine: "pi",
      });
      const { calls, deps } = makeMainHarness(cron);
      deps.resolveCronAgentData = () => {
        throw new Error("script crons must not resolve an agent workspace");
      };
      deps.runPi = () => {
        throw new Error("script crons must not use LLM dispatch");
      };

      await main(deps);

      assert.deepStrictEqual(calls.scripts, [cron.name]);
      assert.deepStrictEqual(calls.workspaces, []);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.deliveries, [
        { chatId: 111111111, message: "script output", threadId: 42 },
      ]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
      assert.strictEqual(calls.exits.length, 0);
      assert.ok(calls.logs.some((entry) => entry.message === "Script returned 13 chars"));
      assert.ok(calls.logs.some((entry) => entry.message === "DONE"));
    });

    it("logs bounded diagnostics without direct delivery from failing script crons", async () => {
      const cron = makeMainCron({
        type: "script",
        prompt: undefined,
        command: "printf 'script-stdout'; printf 'script-stderr' >&2; exit 7",
        engine: "pi",
      });
      const { calls, deps } = makeMainHarness(cron);
      deps.runScript = runScript;

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.workspaces, []);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.ok(calls.logs.some((entry) => entry.message === "FAIL diagnostics: stderr: script-stderr; stdout: script-stdout; status: 7"));
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
      assert.deepStrictEqual(calls.exits, [1]);
    });

    it("resolves workspace and uses one-shot LLM dispatch for LLM crons", async () => {
      const cron = makeMainCron({ engine: "pi" });
      const { calls, deps } = makeMainHarness(cron);

      await main(deps);

      assert.deepStrictEqual(calls.workspaces, ["main"]);
      assert.deepStrictEqual(calls.oneShots, [
        {
          cronName: cron.name,
          workspaceCwd: "/tmp/main-workspace",
          engine: "pi",
          agentData: {
            id: "main",
            workspaceCwd: "/tmp/main-workspace",
            model: "openai-codex/gpt-5.5",
            systemPrompt: "persona",
            thinking: "high",
          },
        },
      ]);
      assert.deepStrictEqual(calls.deliveries, [
        { chatId: 111111111, message: "llm output", threadId: 42 },
      ]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
      assert.ok(calls.logs.some((entry) => entry.message === "Pi returned 10 chars"));
    });

    it("records a failure without direct delivery when the old Pi kill-switch is set", async () => {
      const oldCronPiDisabled = process.env.CRON_PI_DISABLED;
      const cron = makeMainCron({ engine: "pi" });
      const { calls, deps } = makeMainHarness(cron);

      try {
        process.env.CRON_PI_DISABLED = "1";
        await assertMainExits(deps, 1);
      } finally {
        if (oldCronPiDisabled === undefined) {
          delete process.env.CRON_PI_DISABLED;
        } else {
          process.env.CRON_PI_DISABLED = oldCronPiDisabled;
        }
      }

      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.ok(calls.logs.some((entry) =>
        entry.message.includes("CRON_PI_DISABLED=1 is no longer supported")));
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("keeps empty output as a successful skip without delivery", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = (llmCron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => {
        calls.oneShots.push({ cronName: llmCron.name, workspaceCwd, engine: "pi", agentData });
        return "";
      };

      await main(deps);

      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.outboxReads, [cron.name]);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
      assert.ok(calls.logs.some((entry) => entry.message === "WARN: empty output — skipping delivery"));
      assert.ok(calls.logs.some((entry) => entry.message === "DONE"));
    });

    it("keeps LLM NO_REPLY output as a successful skip without delivery", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = (llmCron: CronJob, workspaceCwd: string, agentData?: CronAgentData) => {
        calls.oneShots.push({ cronName: llmCron.name, workspaceCwd, engine: "pi", agentData });
        return "All clean.\n\nNO_REPLY";
      };

      await main(deps);

      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.outboxReads, [cron.name]);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
      assert.ok(calls.logs.some((entry) => entry.message === "NO_REPLY — skipping delivery"));
      assert.ok(calls.logs.some((entry) => entry.message === "DONE"));
    });

    it("delivers a stripped unresolved LLM report once, records failure, and exits non-zero", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = () =>
        `Actionable report for the operator.\n\n${MINIME_CRON_UNRESOLVED_MARKER}`;

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.deliveries, [
        {
          chatId: cron.deliveryChatId,
          message: "Actionable report for the operator.",
          threadId: cron.deliveryThreadId,
        },
      ]);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.doesNotMatch(calls.deliveries[0].message, /MINIME_CRON_UNRESOLVED/);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("records marker-only unresolved output as failure without delivery", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = () => MINIME_CRON_UNRESOLVED_MARKER;

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("queues only the stripped unresolved report when output delivery is unavailable", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      deps.runPi = () => `Unresolved report.\n${MINIME_CRON_UNRESOLVED_MARKER}`;
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("delivery unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(calls.outboxWrites.length, 1);
      assert.strictEqual(calls.outboxWrites[0].kind, "output");
      assert.strictEqual(calls.outboxWrites[0].payload, "Unresolved report.");
      assert.strictEqual(state.pending, calls.outboxWrites[0]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("does not apply LLM terminal markers or NO_REPLY suppression to script output", async () => {
      const cron = makeMainCron({
        type: "script",
        prompt: undefined,
        command: "echo marker",
      });
      const { calls, deps } = makeMainHarness(cron);
      deps.runScript = (scriptCron: CronJob) => {
        calls.scripts.push(scriptCron.name);
        return `NO_REPLY\n${MINIME_CRON_UNRESOLVED_MARKER}`;
      };

      await main(deps);

      assert.deepStrictEqual(calls.deliveries, [
        {
          chatId: 111111111,
          message: `NO_REPLY\n${MINIME_CRON_UNRESOLVED_MARKER}`,
          threadId: 42,
        },
      ]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
    });

    it("records one failure without direct delivery or outbox creation when execution fails", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = () => {
        throw new Error("runner exploded");
      };

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.sleeps, []);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.deliveryFailures, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("records execution failure even when failure logging throws", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      const captureLog = deps.log;
      deps.runPi = () => {
        throw new Error("runner exploded");
      };
      deps.log = (taskName: string, message: string) => {
        captureLog(taskName, message);
        if (message.startsWith("FAIL:")) {
          throw new Error("log unavailable");
        }
      };

      await assert.rejects(() => main(deps), /log unavailable/);

      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
      assert.deepStrictEqual(calls.deliveries, []);
    });

    it("records one failure without direct delivery when LLM workspace resolution fails", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.resolveCronAgentData = () => {
        throw new Error('Agent "missing" not found in config.yaml / config.local.yaml');
      };
      deps.runPi = () => {
        throw new Error("LLM dispatch must not run without a workspace");
      };

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.ok(calls.logs.some((entry) => entry.message.includes('Agent "missing" not found')));
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("keeps bounded execution diagnostics local without emitting a generic failure", async () => {
      const cron = makeMainCron({ engine: "pi" });
      const { calls, deps } = makeMainHarness(cron);
      deps.runPi = () => {
        throw Object.assign(new Error("Pi cron produced stderr without stdout"), {
          diagnostics: "stderr: local diagnostic",
        });
      };

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.ok(
        calls.logs.some((entry) => entry.message === "FAIL diagnostics: stderr: local diagnostic"),
        "expected local diagnostics log",
      );
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("queues failed output after bounded retries and redelivers it before the next generation", async () => {
      const cron = makeMainCron({ name: "durable-output-test" });
      const { calls, deps } = makeMainHarness(cron);
      let failOutputDelivery = true;
      deps.readCronOutboxRecord = (cronName: string) => {
        calls.outboxReads.push(cronName);
        return readCronOutboxRecord(cronName);
      };
      deps.writeCronOutboxRecord = (record: CronOutboxRecord) => {
        calls.outboxWrites.push(record);
        writeCronOutboxRecord(record);
      };
      deps.clearCronOutboxRecord = (cronName: string) => {
        calls.outboxClears.push(cronName);
        clearCronOutboxRecord(cronName);
      };
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        calls.events.push(`deliver:${message}`);
        if (failOutputDelivery && message === "llm output") {
          throw new Error("temporary delivery outage");
        }
      };

      try {
        await assertMainExits(deps, 1);

        assert.deepStrictEqual(calls.sleeps, [...CRON_DELIVERY_RETRY_DELAYS_MS]);
        assert.strictEqual(calls.outboxWrites.length, 1);
        const queued = readCronOutboxRecord(cron.name);
        assert.ok(queued !== undefined && queued !== "corrupt");
        assert.deepStrictEqual(
          {
            version: queued.version,
            cron: queued.cron,
            kind: queued.kind,
            payload: queued.payload,
            chatId: queued.chatId,
            threadId: queued.threadId,
            attempts: queued.attempts,
          },
          {
            version: 1,
            cron: cron.name,
            kind: "output",
            payload: "llm output",
            chatId: 111111111,
            threadId: 42,
            attempts: 0,
          },
        );
        assert.match(
          queued.runId,
          new RegExp(`^${cron.name}@\\d{4}-\\d{2}-\\d{2}T.+Z#${process.pid}$`),
        );
        assert.ok(Number.isFinite(Date.parse(queued.createdAt)));
        assert.ok(calls.logs.some((entry) =>
          entry.message === `OUTBOX QUEUED runId=${queued.runId} kind=output`));

        failOutputDelivery = false;
        calls.events.length = 0;
        calls.sleeps.length = 0;
        await main(deps);

        assert.deepStrictEqual(calls.events, [
          "deliver:llm output",
          `generate:${cron.name}`,
          "deliver:llm output",
        ]);
        assert.strictEqual(readCronOutboxRecord(cron.name), undefined);
        assert.deepStrictEqual(calls.outboxClears, [cron.name]);
        assert.deepStrictEqual(calls.sleeps, []);
        assert.ok(calls.logs.some((entry) =>
          entry.message === `OUTBOX REDELIVERED runId=${queued.runId} attempts=0`));
      } finally {
        clearCronOutboxRecord(cron.name);
      }
    });

    it("does not attempt delivery or create a failure-notice outbox record on generation failure", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      deps.runPi = () => {
        throw new Error("generation failed");
      };
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("notification transport failed");
      };

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.deliveries, []);
      assert.deepStrictEqual(calls.sleeps, []);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("stops retrying after an in-process delivery retry succeeds", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      let attempts = 0;
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        attempts += 1;
        if (attempts === 1) {
          throw new Error("one transient failure");
        }
      };

      await main(deps);

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(calls.sleeps, [CRON_DELIVERY_RETRY_DELAYS_MS[0]]);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
    });

    it("does not queue a deterministic deliver.sh validation failure", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const validationError = new DeliveryError("Delivery failed: invalid chat", {
        status: 1,
        stderrExcerpt: "[deliver] Error: invalid chat_id",
      });
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw validationError;
      };

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.sleeps, [...CRON_DELIVERY_RETRY_DELAYS_MS]);
      assert.deepStrictEqual(calls.outboxReads, [cron.name]);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.strictEqual(state.pending, undefined);
      assert.doesNotMatch(calls.logs.map((entry) => entry.message).join("\n"), /OUTBOX QUEUED/);
    });

    it("clears an attempts-exhausted pending record, notifies admin, and counts only the new logical run", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron, { attempts: CRON_OUTBOX_MAX_ATTEMPTS });
      state.pending = pending;

      await main(deps);

      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.outboxClears, [cron.name]);
      assert.strictEqual(
        calls.logs.find((entry) => entry.message.startsWith("OUTBOX TERMINAL"))?.message,
        `OUTBOX TERMINAL gave-up runId=${pending.runId} attempts=${CRON_OUTBOX_MAX_ATTEMPTS}`,
      );
      assert.strictEqual(calls.deliveries[0].chatId, 999999999);
      assert.match(calls.deliveries[0].message, /Cron outbox gave-up/);
      assert.deepStrictEqual(calls.oneShots.map((call) => call.cronName), [cron.name]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
    });

    it("clears an expired pending record, notifies admin, and counts only the new logical run", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron, {
        createdAt: new Date(Date.now() - CRON_OUTBOX_EXPIRY_MS - 1_000).toISOString(),
        attempts: 4,
      });
      state.pending = pending;

      await main(deps);

      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.outboxClears, [cron.name]);
      assert.ok(calls.logs.some((entry) =>
        entry.message === `OUTBOX TERMINAL gave-up runId=${pending.runId} attempts=4`));
      assert.strictEqual(calls.deliveries[0].chatId, 999999999);
      assert.match(calls.deliveries[0].message, /Cron outbox gave-up/);
      assert.deepStrictEqual(calls.oneShots.map((call) => call.cronName), [cron.name]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
    });

    it("clears corrupt pending state and counts only the new logical run", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      state.pending = "corrupt";

      await main(deps);

      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.outboxClears, [cron.name]);
      assert.ok(calls.logs.some((entry) => entry.message === "OUTBOX TERMINAL corrupt"));
      assert.deepStrictEqual(calls.oneShots.map((call) => call.cronName), [cron.name]);
      assert.deepStrictEqual(calls.deliveries, [
        { chatId: 111111111, message: "llm output", threadId: 42 },
      ]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
    });

    it("drops a legacy failure-notice outbox record without delivering it", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron, {
        kind: "failure-notice",
        payload: "⚠️ Cron FAIL: legacy failure",
      });
      state.pending = pending;

      await main(deps);

      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.outboxClears, [cron.name]);
      assert.ok(calls.logs.some((entry) =>
        entry.message === `OUTBOX DROPPED legacy-failure-notice runId=${pending.runId}`));
      assert.deepStrictEqual(calls.deliveries, [
        { chatId: cron.deliveryChatId, message: "llm output", threadId: cron.deliveryThreadId },
      ]);
      assert.deepStrictEqual(calls.oneShots.map((call) => call.cronName), [cron.name]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
    });

    it("clears a deterministically undeliverable pending record, notifies admin, and counts only the new logical run", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron);
      state.pending = pending;
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        if (message === pending.payload) {
          throw new DeliveryError("Delivery failed: invalid thread", {
            status: 1,
            stderrExcerpt: "[deliver] Error: invalid thread_id",
          });
        }
      };

      await main(deps);

      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.outboxClears, [cron.name]);
      assert.ok(calls.logs.some((entry) =>
        entry.message === `OUTBOX TERMINAL deterministic runId=${pending.runId} attempts=0`));
      assert.deepStrictEqual(calls.deliveries.map((call) => call.chatId), [
        cron.deliveryChatId,
        999999999,
        cron.deliveryChatId,
      ]);
      assert.match(calls.deliveries[1].message, /Cron outbox deterministic/);
      assert.deepStrictEqual(calls.oneShots.map((call) => call.cronName), [cron.name]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
    });

    it("defers a queueable pending failure before generation and persists the next attempt", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron, { attempts: 2 });
      state.pending = pending;
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("network unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(calls.outboxWrites.length, 1);
      assert.strictEqual(calls.outboxWrites[0].attempts, 3);
      assert.strictEqual(state.pending, calls.outboxWrites[0]);
      assert.ok(calls.logs.some((entry) =>
        entry.message === `OUTBOX RETRY-DEFERRED runId=${pending.runId} attempts=3`));
      assert.deepStrictEqual(calls.metrics, []);
      assert.deepStrictEqual(calls.scripts, []);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.sleeps, []);
    });

    it("fails closed when corrupt pending state cannot be cleared", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      state.pending = "corrupt";
      deps.clearCronOutboxRecord = (cronName: string) => {
        calls.outboxClears.push(cronName);
        throw new Error("clear unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(state.pending, "corrupt");
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.metrics, []);
      assert.ok(calls.logs.some((entry) =>
        entry.message === "OUTBOX CLEAR-FAILED corrupt: clear unavailable"));
    });

    it("fails closed when an attempts-exhausted record cannot be cleared", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron, { attempts: CRON_OUTBOX_MAX_ATTEMPTS });
      state.pending = pending;
      deps.clearCronOutboxRecord = (cronName: string) => {
        calls.outboxClears.push(cronName);
        throw new Error("clear unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(state.pending, pending);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.metrics, []);
      assert.ok(calls.logs.some((entry) =>
        entry.message === `OUTBOX CLEAR-FAILED runId=${pending.runId}: clear unavailable`));
    });

    it("fails closed when a deterministic pickup failure cannot be cleared", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron);
      state.pending = pending;
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new DeliveryError("invalid destination", {
          status: 1,
          stderrExcerpt: "[deliver] Error: invalid chat_id",
        });
      };
      deps.clearCronOutboxRecord = (cronName: string) => {
        calls.outboxClears.push(cronName);
        throw new Error("clear unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(state.pending, pending);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.metrics, []);
      assert.ok(calls.logs.some((entry) =>
        entry.message === `OUTBOX CLEAR-FAILED runId=${pending.runId}: clear unavailable`));
    });

    it("fails closed when a queueable pickup retry cannot be persisted", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron, { attempts: 2 });
      state.pending = pending;
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("network unavailable");
      };
      deps.writeCronOutboxRecord = (record: CronOutboxRecord) => {
        calls.outboxWrites.push(record);
        throw new Error("write unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(state.pending, pending);
      assert.strictEqual(calls.outboxWrites.length, 1);
      assert.strictEqual(calls.outboxWrites[0].attempts, 3);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.metrics, []);
      assert.ok(calls.logs.some((entry) =>
        entry.message === `OUTBOX RETRY-WRITE-FAILED runId=${pending.runId}: write unavailable`));
    });

    it("does not resurrect a delivered record when success logging fails", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron);
      state.pending = pending;
      const captureLog = deps.log;
      deps.log = (taskName: string, message: string) => {
        captureLog(taskName, message);
        if (message.startsWith("OUTBOX REDELIVERED")) {
          throw new Error("log unavailable");
        }
      };

      await assert.rejects(() => main(deps), /log unavailable/);

      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.outboxClears, [cron.name]);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.metrics, []);
    });

    it("fails closed without rewriting when a delivered record cannot be cleared", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const pending = makePendingRecord(cron);
      state.pending = pending;
      deps.clearCronOutboxRecord = (cronName: string) => {
        calls.outboxClears.push(cronName);
        throw new Error("clear unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(state.pending, pending);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.metrics, []);
      assert.ok(calls.logs.some((entry) =>
        entry.message === `OUTBOX CLEAR-FAILED runId=${pending.runId}: clear unavailable`));
    });

    it("fails closed before generation when outbox state cannot be read", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.readCronOutboxRecord = () => {
        throw new Error("disk unavailable");
      };

      await assertMainExits(deps, 1);

      assert.ok(calls.logs.some((entry) =>
        entry.message === "OUTBOX STATE-READ-FAILED: disk unavailable"));
      assert.deepStrictEqual(calls.metrics, []);
      assert.deepStrictEqual(calls.scripts, []);
      assert.deepStrictEqual(calls.oneShots, []);
      assert.deepStrictEqual(calls.deliveries, []);
    });

    it("preserves an unexpected occupied slot discovered while queueing", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const existing = makePendingRecord(cron, {
        runId: `${cron.name}@2026-07-17T08:00:00.000Z#3131`,
        payload: "older owed output",
      });
      let reads = 0;
      deps.readCronOutboxRecord = (cronName: string) => {
        calls.outboxReads.push(cronName);
        reads += 1;
        if (reads === 1) {
          return undefined;
        }
        state.pending = existing;
        return existing;
      };
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("network unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(state.pending, existing);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.outboxReads, [cron.name, cron.name]);
      assert.ok(calls.logs.some((entry) =>
        entry.message === "OUTBOX QUEUE-SKIPPED pending-existing"));
    });

    it("does not overwrite unknown state when the queue-time read fails", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      let reads = 0;
      deps.readCronOutboxRecord = (cronName: string) => {
        calls.outboxReads.push(cronName);
        reads += 1;
        if (reads === 2) {
          throw new Error("queue-time read unavailable");
        }
        return undefined;
      };
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("network unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.outboxReads, [cron.name, cron.name]);
      assert.ok(calls.logs.some((entry) =>
        entry.message === "OUTBOX QUEUE-SKIPPED pending-existing"));
      assert.strictEqual(calls.deliveryFailures.length, 1);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("reports a queue write failure and preserves the empty slot", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("network unavailable");
      };
      deps.writeCronOutboxRecord = (record: CronOutboxRecord) => {
        calls.outboxWrites.push(record);
        throw new Error("queue write unavailable");
      };

      await assertMainExits(deps, 1);

      assert.strictEqual(state.pending, undefined);
      assert.strictEqual(calls.outboxWrites.length, 1);
      assert.ok(calls.logs.some((entry) =>
        entry.message === "OUTBOX QUEUE-WRITE-FAILED: queue write unavailable"));
      assert.strictEqual(calls.deliveryFailures.length, 1);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("uses the admin fallback and exits when final output delivery fails", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new Error("delivery transport failed");
      };

      await assertMainExits(deps, 1);

      assert.deepStrictEqual(calls.deliveries, [
        { chatId: 111111111, message: "llm output", threadId: 42 },
        { chatId: 111111111, message: "llm output", threadId: 42 },
        { chatId: 111111111, message: "llm output", threadId: 42 },
      ]);
      assert.deepStrictEqual(calls.deliveryFailures, [
        {
          cronName: cron.name,
          targetChatId: 111111111,
          errorMsg: "delivery transport failed",
          adminChatId: 999999999,
        },
      ]);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("records delivery failure before a fallback handler throws", async () => {
      const cron = makeMainCron();
      const { calls, deps } = makeMainHarness(cron);
      deps.deliver = (chatId: number, message: string, threadId?: number) => {
        calls.deliveries.push({ chatId, message, threadId });
        throw new DeliveryError("invalid destination", {
          status: 1,
          stderrExcerpt: "[deliver] Error: invalid chat_id",
        });
      };
      deps.handleDeliveryFailure = () => {
        throw new Error("fallback unavailable");
      };

      await assert.rejects(() => main(deps), /fallback unavailable/);

      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 1, success: false },
      ]);
    });

    it("records delivered output before success logging fails", async () => {
      const cron = makeMainCron();
      const { calls, deps, state } = makeMainHarness(cron);
      const captureLog = deps.log;
      deps.log = (taskName: string, message: string) => {
        captureLog(taskName, message);
        if (message.startsWith("Delivered to chat")) {
          throw new Error("log unavailable");
        }
      };

      await assert.rejects(() => main(deps), /log unavailable/);

      assert.deepStrictEqual(calls.deliveries, [
        { chatId: 111111111, message: "llm output", threadId: 42 },
      ]);
      assert.strictEqual(state.pending, undefined);
      assert.deepStrictEqual(calls.outboxWrites, []);
      assert.deepStrictEqual(calls.deliveryFailures, []);
      assert.deepStrictEqual(calls.metrics, [
        { cronName: cron.name, exitCode: 0, success: true },
      ]);
    });
  });

  describe("runScript", () => {
    it("executes command and returns stdout", () => {
      const cron: CronJob = {
        name: "echo-test",
        schedule: "0 * * * *",
        type: "script",
        command: "echo 'hello from script'",
        agentId: "main",
        deliveryChatId: 111111111,
      };
      const output = runScript(cron);
      assert.strictEqual(output, "hello from script");
    });

    it("throws CronRunError diagnostics with captured stderr/stdout on non-zero exit", () => {
      const cron: CronJob = {
        name: "failing-script",
        schedule: "0 * * * *",
        type: "script",
        command: "printf 'script-stdout'; printf 'script-stderr' >&2; exit 7",
        agentId: "main",
        deliveryChatId: 111111111,
      };

      assert.throws(
        () => runScript(cron),
        (err: unknown) => {
          const error = err as { name?: unknown; message?: unknown; diagnostics?: unknown };
          assert.strictEqual(error.name, "CronRunError");
          assert.match(String(error.message), /Script cron exited with code 7/);
          assert.match(String(error.diagnostics), /stderr: script-stderr/);
          assert.match(String(error.diagnostics), /stdout: script-stdout/);
          assert.match(String(error.diagnostics), /status: 7/);
          assert.doesNotMatch(String(error.message), /script-stderr|script-stdout/);
          return true;
        },
      );
    });

    it("sanitizes and truncates script failure diagnostics", () => {
      const longOutput = "x".repeat(1100);
      const cron: CronJob = {
        name: "noisy-script",
        schedule: "0 * * * *",
        type: "script",
        command: `printf '\\001\\033[31m${longOutput}\\033[0m' >&2; exit 2`,
        agentId: "main",
        deliveryChatId: 111111111,
      };

      assert.throws(
        () => runScript(cron),
        (err: unknown) => {
          const diagnostics = String((err as { diagnostics?: unknown }).diagnostics);
          assert.match(diagnostics, /stderr \(first 1000 chars\):/);
          assert.match(diagnostics, /\[truncated 101 chars\]/);
          assert.doesNotMatch(diagnostics, /\u001b|\x1B|\[31m|\[0m/);
          assert.match(diagnostics, /\?/);
          return true;
        },
      );
    });

    it("respects timeout", () => {
      const cron: CronJob = {
        name: "slow-script",
        schedule: "0 * * * *",
        type: "script",
        command: "sleep 10",
        agentId: "main",
        deliveryChatId: 111111111,
        timeout: 100, // 100ms — will timeout
      };
      assert.throws(
        () => runScript(cron),
        (err: unknown) => {
          const error = err as { name?: unknown; message?: unknown; diagnostics?: unknown };
          assert.strictEqual(error.name, "CronRunError");
          assert.match(String(error.message), /timed out after 100ms/);
          assert.match(String(error.diagnostics), /signal: SIGTERM/);
          assert.match(String(error.diagnostics), /code: ETIMEDOUT/);
          return true;
        },
      );
    });

    it("throws when command is missing", () => {
      const cron: CronJob = {
        name: "no-cmd",
        schedule: "0 * * * *",
        type: "script",
        agentId: "main",
        deliveryChatId: 111111111,
      };
      assert.throws(() => runScript(cron), /no command/i);
    });

    it("scrubs legacy runtime environment for direct script execution", () => {
      const legacyAnthropicEnv = "ANTHROPIC_" + "API_KEY";
      const oldValues = {
        token: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        anthropic: process.env[legacyAnthropicEnv],
        marker: process.env.CLAUDECODE,
      };
      try {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-token";
        process.env[legacyAnthropicEnv] = "stale-anthropic-key";
        process.env.CLAUDECODE = "nested-marker";
        const cron: CronJob = {
          name: "env-script",
          schedule: "0 * * * *",
          type: "script",
          command: `printf 'token=%s\\nanthropic=%s\\nmarker=%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-__unset__}" "\${ANTHROPIC_API_KEY-__unset__}" "\${CLAUDECODE-__unset__}"`,
          agentId: "main",
          deliveryChatId: 111111111,
        };

        assert.strictEqual(
          runScript(cron),
          "token=__unset__\nanthropic=__unset__\nmarker=__unset__",
        );
      } finally {
        if (oldValues.token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
        else process.env.CLAUDE_CODE_OAUTH_TOKEN = oldValues.token;
        if (oldValues.anthropic === undefined) delete process.env[legacyAnthropicEnv];
        else process.env[legacyAnthropicEnv] = oldValues.anthropic;
        if (oldValues.marker === undefined) delete process.env.CLAUDECODE;
        else process.env.CLAUDECODE = oldValues.marker;
      }
    });
  });
});

describe("cron-runner NO_REPLY suppression (shouldSuppressNoReply)", () => {
  // The cron LLM-output gate (cron-runner.ts) calls shouldSuppressNoReply on
  // raw output before delivery. Verify the same end-of-message + start-of-message
  // patterns the stream-relay tests cover.
  let shouldSuppressNoReply: (s: string) => boolean;

  before(async () => {
    ({ shouldSuppressNoReply } = await import("../no-reply.js"));
  });

  it("suppresses <content>\\n\\nNO_REPLY (end-of-message, blank line before)", () => {
    assert.strictEqual(shouldSuppressNoReply("All checks complete. Everything is clean.\n\nNO_REPLY"), true);
  });

  it("suppresses <content>\\nNO_REPLY (single newline before)", () => {
    assert.strictEqual(shouldSuppressNoReply("All clean.\nNO_REPLY"), true);
  });

  it("suppresses <content>\\nNO_REPLY\\n (trailing newline)", () => {
    assert.strictEqual(shouldSuppressNoReply("All clean.\nNO_REPLY\n"), true);
  });

  it("suppresses operator's leaked workspace-health sample verbatim", () => {
    const sample = [
      "All checks complete. Let me compile the results:",
      "• Size audit: OK (335M, no bloat)",
      "• Hook integrity: OK",
      "• Config check: 1 warning (settings.local.json missing outputStyle — minor, file doesn't exist)",
      "The only finding is the settings.local.json warning, which is informational.",
      "",
      "NO_REPLY",
    ].join("\n");
    assert.strictEqual(shouldSuppressNoReply(sample), true);
  });

  it("delivers same-line `Some text NO_REPLY` (token shares line with content)", () => {
    assert.strictEqual(shouldSuppressNoReply("Some text NO_REPLY"), false);
  });

  it("delivers `Done. NO_REPLY_EXTRA more` (substring prefix on same line)", () => {
    assert.strictEqual(shouldSuppressNoReply("Done. NO_REPLY_EXTRA more"), false);
  });

  it("preserves issue #80: suppresses NO_REPLY at start (exact)", () => {
    assert.strictEqual(shouldSuppressNoReply("NO_REPLY"), true);
  });

  it("preserves issue #80: suppresses NO_REPLY\\n\\n<text> at start", () => {
    assert.strictEqual(shouldSuppressNoReply("NO_REPLY\n\nSome explanation text..."), true);
  });

  it("preserves issue #80: suppresses NO_REPLY: reason at start", () => {
    assert.strictEqual(shouldSuppressNoReply("NO_REPLY: nothing actionable"), true);
  });

  it("preserves issue #80: suppresses whitespace-padded NO_REPLY", () => {
    assert.strictEqual(shouldSuppressNoReply("  NO_REPLY  "), true);
  });

  it("does not suppress regular output", () => {
    assert.strictEqual(shouldSuppressNoReply("Hello, this is a normal response"), false);
  });

  it("does not suppress empty / whitespace-only output", () => {
    assert.strictEqual(shouldSuppressNoReply(""), false);
    assert.strictEqual(shouldSuppressNoReply("   \n\n  "), false);
  });

  it("does not suppress NO_REPLY_EXTRA alone on last line (substring, not equal)", () => {
    assert.strictEqual(shouldSuppressNoReply("Some content\n\nNO_REPLY_EXTRA"), false);
  });
});
