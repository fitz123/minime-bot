import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  DEFAULT_OPS_WORKER_CONTROL_POLL_TUNING,
  DEFAULT_OPS_WORKER_CONTROL_REPLY_TUNING,
  OpsWorkerControlConfigError,
  loadOpsWorkerControlConfig,
} from "../ops-worker/control-config.js";
import type { ResolveSecretOptions } from "../secrets.js";

function fixtureFile(t: TestContext, yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "minime-ops-control-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "ops-control.yaml");
  writeFileSync(path, yaml, { mode: 0o600 });
  return path;
}

describe("ops worker control config", () => {
  it("loads a dedicated env-token config with bounded defaults", (t) => {
    const path = fixtureFile(t, `
telegram:
  tokenEnv: TEST_OPS_TOKEN
  controlChatId: "-100000000"
  operatorIds: ["100000000", "100000001"]
`);

    const config = loadOpsWorkerControlConfig(path, {
      env: { TEST_OPS_TOKEN: "TEST_OPS_TOKEN_VALUE" },
    });

    assert.deepEqual(config, {
      telegram: {
        token: "TEST_OPS_TOKEN_VALUE",
        controlChatId: "-100000000",
        operatorIds: ["100000000", "100000001"],
      },
      intake: undefined,
      poll: DEFAULT_OPS_WORKER_CONTROL_POLL_TUNING,
      reply: DEFAULT_OPS_WORKER_CONTROL_REPLY_TUNING,
    });
  });

  it("resolves separate Telegram and intake SOPS references through the injected resolver", (t) => {
    const path = fixtureFile(t, `
telegram:
  sopsFile: ./ops-secrets.yaml
  tokenSopsKey: telegram.token
  controlChatId: "100000000"
  operatorIds:
    - "100000000"
intake:
  host: ::1
  port: 19465
  sopsFile: ./ops-secrets.yaml
  bearerTokenSopsKey: alertmanager.bearer
  sourceIdentity: lab-alertmanager
poll:
  longPollSeconds: 7
  requestTimeoutMs: 9000
  retryMinMs: 25
  retryMaxMs: 250
  maxResponseBytes: 65536
reply:
  maxBytes: 2048
`);
    const calls: ResolveSecretOptions[] = [];

    const config = loadOpsWorkerControlConfig(path, {
      resolveSecret(options) {
        calls.push(options);
        return options.fieldName === "ops control Telegram token"
          ? "TEST_TELEGRAM_SECRET"
          : "TEST_INTAKE_SECRET";
      },
    });

    assert.equal(config.telegram.token, "TEST_TELEGRAM_SECRET");
    assert.deepEqual(config.intake, {
      host: "::1",
      port: 19465,
      bearerToken: "TEST_INTAKE_SECRET",
      sourceIdentity: "lab-alertmanager",
    });
    assert.deepEqual(config.poll, {
      longPollSeconds: 7,
      requestTimeoutMs: 9000,
      retryMinMs: 25,
      retryMaxMs: 250,
      maxResponseBytes: 65536,
    });
    assert.deepEqual(config.reply, { maxBytes: 2048 });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].sopsFile, join(path.replace(/\/ops-control\.yaml$/, ""), "ops-secrets.yaml"));
    assert.equal(calls[0].sopsKey, "telegram.token");
    assert.equal(calls[1].sopsKey, "alertmanager.bearer");
  });

  it("rejects unknown and primary-token keys, remote intake, and empty allowlists", (t) => {
    const invalid = [
      [`telegram:\n  tokenEnv: TEST_OPS_TOKEN\n  telegramTokenEnv: PRIMARY_TOKEN\n  controlChatId: "1"\n  operatorIds: ["1"]\n`, /telegramTokenEnv is an unknown field/],
      [`telegram:\n  tokenEnv: TEST_OPS_TOKEN\n  controlChatId: "1"\n  operatorIds: []\n`, /operatorIds must contain at least one/],
      [`telegram:\n  tokenEnv: TEST_OPS_TOKEN\n  controlChatId: "1"\n  operatorIds: ["1"]\nintake:\n  host: 0.0.0.0\n  port: 9466\n  bearerTokenEnv: TEST_INTAKE_TOKEN\n  sourceIdentity: lab-alertmanager\n`, /intake.host must be 127\.0\.0\.1 or ::1/],
      [`telegram:\n  tokenEnv: TEST_OPS_TOKEN\n  sopsFile: ./secret.yaml\n  tokenSopsKey: telegram.token\n  controlChatId: "1"\n  operatorIds: ["1"]\n`, /exactly one token source/],
      [`telegram:\n  tokenEnv: TEST_OPS_TOKEN\n  controlChatId: "1"\n  operatorIds: ["1"]\npoll:\n  longPollSeconds: 50\n  requestTimeoutMs: 1000\n`, /requestTimeoutMs must exceed/],
      [`telegram:\n  tokenEnv: TEST_OPS_TOKEN\n  controlChatId: "9007199254740992"\n  operatorIds: ["1"]\n`, /canonical safe Telegram integer id/],
      [`telegram:\n  tokenEnv: TEST_OPS_TOKEN\n  controlChatId: "-0"\n  operatorIds: ["1"]\n`, /canonical safe Telegram integer id/],
      [`telegram:\n  tokenEnv: TEST_OPS_TOKEN\n  controlChatId: "1"\n  operatorIds: ["9007199254740992"]\n`, /canonical safe Telegram integer id/],
    ] as const;

    for (const [yaml, expected] of invalid) {
      const path = fixtureFile(t, yaml);
      assert.throws(
        () => loadOpsWorkerControlConfig(path, {
          env: { TEST_OPS_TOKEN: "TEST_OPS_TOKEN_VALUE", TEST_INTAKE_TOKEN: "TEST_INTAKE_TOKEN_VALUE" },
        }),
        (error: unknown) => error instanceof OpsWorkerControlConfigError
          && expected.test(error.message),
      );
    }
  });

  it("opens the config through a no-follow descriptor and enforces the read bound", (t) => {
    const target = fixtureFile(t, `
telegram:
  tokenEnv: TEST_OPS_TOKEN
  controlChatId: "1"
  operatorIds: ["1"]
`);
    const link = `${target}.link`;
    symlinkSync(target, link);
    assert.throws(
      () => loadOpsWorkerControlConfig(link, {
        env: { TEST_OPS_TOKEN: "TEST_OPS_TOKEN_VALUE" },
      }),
      (error: unknown) => error instanceof OpsWorkerControlConfigError
        && /regular file, not a symlink/.test(error.message),
    );

    const oversized = fixtureFile(t, "x".repeat(64 * 1024 + 1));
    assert.throws(
      () => loadOpsWorkerControlConfig(oversized),
      (error: unknown) => error instanceof OpsWorkerControlConfigError
        && /exceeds 65536 bytes/.test(error.message),
    );
  });
});
