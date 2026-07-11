import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type RequestListener, type Server as HttpServer } from "node:http";
import {
  createConnection,
  createServer as createNetServer,
  type Server as NetServer,
  type Socket,
} from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const python = process.env.PYTHON ?? "/usr/bin/python3";
const nativeScript = join(root, "scripts", "monitoring_native.py");
const webhookScript = join(root, "scripts", "alertmanager_webhook.py");
const doctorScript = join(root, "scripts", "runtime_doctor.py");
const syntheticSecret = "synthetic_test_token_42";
const temporaryDirectories: string[] = [];

interface RunResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  args: string[];
}

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "minime-native-monitoring-"));
  temporaryDirectories.push(path);
  return path;
}

function runPython(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 10_000,
): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, args, {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr, args });
    });
  });
}

async function startServer(
  handler: RequestListener,
): Promise<{ server: HttpServer; base: string; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function startRawServer(
  handler: (socket: Socket) => void,
): Promise<{ server: NetServer; base: string; port: number }> {
  const server = createNetServer(handler);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function closeServer(server: HttpServer | NetServer): Promise<void> {
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
}

function telegramEnv(base: string): NodeJS.ProcessEnv {
  return {
    MINIME_TELEGRAM_BOT_TOKEN: syntheticSecret,
    MINIME_TELEGRAM_API_BASE: base,
    MINIME_TELEGRAM_ALLOW_INSECURE_TEST_API: "1",
    MINIME_TELEGRAM_CHAT_ID: "10001",
  };
}

function assertSecretAbsent(result: RunResult): void {
  assert.ok(!result.args.join(" ").includes(syntheticSecret));
  assert.ok(!result.stdout.includes(syntheticSecret));
  assert.ok(!result.stderr.includes(syntheticSecret));
}

function spawnWebhook(port: number, env: NodeJS.ProcessEnv, extra: string[] = []): ChildProcessWithoutNullStreams {
  return spawn(python, [webhookScript, "--port", String(port), ...extra], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitUntilReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`webhook readiness timed out: ${output}`)), 5_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      output += chunk;
      if (output.includes("webhook ready")) {
        clearTimeout(timer);
        resolvePromise();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`webhook exited before ready: ${code}`));
    });
  });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("host-native secret and Telegram delivery", () => {
  it("extracts one validated SOPS key and sanitizes malformed, failed, and timed-out resolution", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    const argsFile = join(dir, "sops-args.json");
    mkdirSync(bin);
    const sops = join(bin, "sops");
    writeFileSync(
      sops,
      `#!/bin/sh\n/usr/bin/python3 -c 'import json,sys; open(sys.argv[1], "w").write(json.dumps(sys.argv[2:]))' "${argsFile}" "$@"\nprintf '%s\\n' '${syntheticSecret}'\n`,
    );
    chmodSync(sops, 0o755);
    const commonEnv = {
      PATH: "/usr/bin:/bin",
      MINIME_SOPS_EXECUTABLE: sops,
      MINIME_TELEGRAM_SOPS_FILE: join(dir, "synthetic.sops.yaml"),
      MINIME_TELEGRAM_SOPS_KEY: "telegram.bot_token",
      EXPECTED_TOKEN: syntheticSecret,
    };
    const check = [
      "-c",
      "import os,sys; sys.path.insert(0, 'scripts'); import monitoring_native as m; assert m.resolve_token() == os.environ['EXPECTED_TOKEN']; print('ok')",
    ];
    const success = await runPython(check, commonEnv);
    assert.equal(success.status, 0, success.stderr);
    assertSecretAbsent(success);
    const sopsArgs = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    assert.deepEqual(sopsArgs.slice(0, 3), ["-d", "--extract", '["telegram"]["bot_token"]']);
    assert.ok(!sopsArgs.join(" ").includes(syntheticSecret));

    const malformed = await runPython(check, { ...commonEnv, MINIME_TELEGRAM_SOPS_KEY: "bad;key" });
    assert.notEqual(malformed.status, 0);
    assertSecretAbsent(malformed);
    assert.ok(!malformed.stderr.includes(commonEnv.MINIME_TELEGRAM_SOPS_FILE));

    writeFileSync(sops, "#!/bin/sh\necho 'sensitive backend detail' >&2\nexit 1\n");
    chmodSync(sops, 0o755);
    const failed = await runPython(check, commonEnv);
    assert.notEqual(failed.status, 0);
    assert.ok(!failed.stderr.includes("sensitive backend detail"));
    assertSecretAbsent(failed);

    writeFileSync(sops, "#!/bin/sh\nsleep 2\n");
    chmodSync(sops, 0o755);
    const timed = await runPython(
      ["-c", "import sys; sys.path.insert(0, 'scripts'); import monitoring_native as m; m.resolve_token(sops_timeout=.05)"],
      commonEnv,
    );
    assert.notEqual(timed.status, 0);
    assert.match(timed.stderr, /timed out/);
    assertSecretAbsent(timed);
  });

  it("requires explicit test mode for every custom Telegram API origin", async () => {
    const check = await runPython(
      [
        "-c",
        [
          "import sys",
          "sys.path.insert(0, 'scripts')",
          "import monitoring_native as m",
          "assert m._api_base({}) == m.DEFAULT_API_BASE",
          "for value in ['https://example.invalid', 'http://127.0.0.1']:",
          " try: m._api_base({m.API_BASE_ENV: value})",
          " except m.DeliveryError: pass",
          " else: raise AssertionError('custom origin accepted without test mode')",
          "test_env = {m.INSECURE_TEST_ENV: '1'}",
          "for value in ['https://user@example.invalid', 'https://example.invalid/path', 'https://example.invalid?query=1', 'https://example.invalid#fragment']:",
          " try: m._api_base({**test_env, m.API_BASE_ENV: value})",
          " except m.DeliveryError: pass",
          " else: raise AssertionError('unsafe custom origin accepted')",
          "assert m._api_base({**test_env, m.API_BASE_ENV: 'https://example.invalid/'}) == 'https://example.invalid'",
          "assert m._api_base({**test_env, m.API_BASE_ENV: 'http://127.0.0.1:9876'}) == 'http://127.0.0.1:9876'",
        ].join("\n"),
      ],
      {},
    );
    assert.equal(check.status, 0, check.stderr);
  });

  it("sends POST data, retries transient responses, bounds retry_after, and fails safely", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    let attempts = 0;
    const { server, base } = await startServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.push({ url: request.url ?? "", body });
        attempts += 1;
        response.setHeader("Content-Type", "application/json");
        if (attempts === 1) {
          response.statusCode = 429;
          response.end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 999 } }));
        } else {
          response.end(JSON.stringify({ ok: true, result: {} }));
        }
      });
    });
    try {
      const result = await runPython(
        [
          "-c",
          "import sys; sys.path.insert(0, 'scripts'); import monitoring_native as m; m.send_telegram('synthetic firing', m.DeliveryConfig('10001', '9', attempts=3, max_retry_after=.01), sleep=lambda value: print(f'sleep={value}'))",
        ],
        telegramEnv(base),
      );
      assert.equal(result.status, 0, result.stderr);
      assertSecretAbsent(result);
      assert.equal(requests.length, 2);
      assert.match(result.stdout, /sleep=0\.01/);
      assert.match(requests[1].url, /^\/bot.+\/sendMessage$/);
      const form = new URLSearchParams(requests[1].body);
      assert.equal(form.get("chat_id"), "10001");
      assert.equal(form.get("message_thread_id"), "9");
      assert.equal(form.get("text"), "synthetic firing");
    } finally {
      await closeServer(server);
    }

    const failedServer = await startServer((_request, response) => {
      response.statusCode = 400;
      response.end(JSON.stringify({ ok: false, error_code: 400 }));
    });
    try {
      const failed = await runPython(
        [nativeScript, "--message", "synthetic failure", "--chat-id", "10001"],
        telegramEnv(failedServer.base),
      );
      assert.equal(failed.status, 1);
      assert.match(failed.stderr, /Telegram rejected/);
      assert.ok(!failed.stderr.includes(failedServer.base));
      assertSecretAbsent(failed);
    } finally {
      await closeServer(failedServer.server);
    }

    let exhaustedAttempts = 0;
    const exhaustedServer = await startServer((_request, response) => {
      exhaustedAttempts += 1;
      response.statusCode = 503;
      response.end(JSON.stringify({ ok: false, error_code: 503 }));
    });
    try {
      const exhausted = await runPython(
        [
          "-c",
          "import sys; sys.path.insert(0, 'scripts'); import monitoring_native as m; m.send_telegram('synthetic exhaustion', m.DeliveryConfig('10001', attempts=2, max_retry_after=0), sleep=lambda _value: None)",
        ],
        telegramEnv(exhaustedServer.base),
      );
      assert.notEqual(exhausted.status, 0);
      assert.equal(exhaustedAttempts, 2);
      assertSecretAbsent(exhausted);
    } finally {
      await closeServer(exhaustedServer.server);
    }

    const networkRetry = await runPython(
      [
        "-c",
        "import sys,urllib.error; sys.path.insert(0, 'scripts'); import monitoring_native as m; calls=[]; m.urllib.request.urlopen=lambda *_a, **_k: (calls.append(1), (_ for _ in ()).throw(urllib.error.URLError('private endpoint')))[1];\ntry: m.send_telegram('network failure', m.DeliveryConfig('10001', attempts=2, max_retry_after=0), environ={'MINIME_TELEGRAM_BOT_TOKEN':'synthetic', 'MINIME_TELEGRAM_API_BASE':'http://127.0.0.1', 'MINIME_TELEGRAM_ALLOW_INSECURE_TEST_API':'1'}, sleep=lambda _value: None)\nexcept m.DeliveryError: assert len(calls) == 2; print('network retries bounded')",
      ],
      {},
    );
    assert.equal(networkRetry.status, 0, networkRetry.stderr);
    assert.match(networkRetry.stdout, /network retries bounded/);

    let protocolAttempts = 0;
    const malformedProtocol = await startRawServer((socket) => {
      protocolAttempts += 1;
      socket.once("data", () => socket.end("not-an-http-response\r\n\r\n"));
    });
    try {
      const protocolRetry = await runPython(
        [
          "-c",
          "import sys; sys.path.insert(0, 'scripts'); import monitoring_native as m;\ntry: m.send_telegram('protocol failure', m.DeliveryConfig('10001', attempts=2, max_retry_after=0), sleep=lambda _value: None)\nexcept m.DeliveryError: print('protocol retries bounded')",
        ],
        telegramEnv(malformedProtocol.base),
      );
      assert.equal(protocolRetry.status, 0, protocolRetry.stderr);
      assert.equal(protocolAttempts, 2);
      assert.match(protocolRetry.stdout, /protocol retries bounded/);
      assert.ok(!protocolRetry.stderr.includes("Traceback"));
      assertSecretAbsent(protocolRetry);
    } finally {
      await closeServer(malformedProtocol.server);
    }

    for (const timeout of ["-1", "31", "nan"]) {
      const invalid = await runPython(
        [nativeScript, "--message", "synthetic", "--chat-id", "10001", "--timeout", timeout],
        telegramEnv("http://127.0.0.1:1"),
      );
      assert.equal(invalid.status, 1);
      assert.ok(!invalid.stderr.includes("Traceback"));
      assertSecretAbsent(invalid);
    }
    const excessiveAttempts = await runPython(
      [nativeScript, "--message", "synthetic", "--chat-id", "10001", "--attempts", "11"],
      telegramEnv("http://127.0.0.1:1"),
    );
    assert.equal(excessiveAttempts.status, 1);
    assert.ok(!excessiveAttempts.stderr.includes("Traceback"));
  });
});

describe("Alertmanager webhook", () => {
  it("delivers firing and resolved batches, suppresses duplicates, and uses no Node subprocess", async () => {
    const messages: string[] = [];
    const dir = tempDir();
    const marker = join(dir, "node-invoked");
    const fakeBin = join(dir, "bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "node"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(fakeBin, "node"), 0o755);
    const telegram = await startServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        messages.push(new URLSearchParams(body).get("text") ?? "");
        setTimeout(() => response.end(JSON.stringify({ ok: true })), 100);
      });
    });
    const reservation = await startServer((_request, response) => response.end());
    const port = reservation.port;
    await closeServer(reservation.server);
    const child = spawnWebhook(port, {
      ...telegramEnv(telegram.base),
      PATH: `${fakeBin}:/usr/bin:/bin`,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    try {
      await waitUntilReady(child);
      const firing = {
        alerts: [{ status: "firing", fingerprint: "synthetic-1", labels: { alertname: "BotDown", severity: "critical", instance: "test" } }],
      };
      const post = (payload: unknown) =>
        fetch(`http://127.0.0.1:${port}/alertmanager`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
      const concurrent = await Promise.all([post(firing), post(firing)]);
      assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 503]);
      assert.equal((await post(firing)).status, 200);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /FIRING alert=BotDown severity=critical instance=test/);
      const resolved = { alerts: [{ ...firing.alerts[0], status: "resolved" }] };
      assert.equal((await post(resolved)).status, 200);
      assert.equal(messages.length, 2);
      assert.match(messages[1], /RESOLVED/);
      const largeBatch = {
        alerts: Array.from({ length: 101 }, (_, index) => ({
          status: "firing",
          fingerprint: `large-${index}`,
          labels: { alertname: `Alert${index}${"A".repeat(110)}`, severity: "critical", instance: "I".repeat(120) },
        })),
      };
      assert.equal((await post(largeBatch)).status, 200);
      assert.ok(Buffer.from(messages[2], "utf16le").byteLength / 2 <= 4096);
      assert.match(messages[2], /alerts omitted/);
      assert.equal(existsSync(marker), false);
      assert.ok(!stderr.includes(syntheticSecret));
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolvePromise) => child.once("close", resolvePromise));
      await closeServer(telegram.server);
    }
  });

  it("rejects malformed and oversized bodies and returns non-2xx when delivery fails", async () => {
    let deliveryAttempts = 0;
    const telegram = await startServer((_request, response) => {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) {
        setTimeout(() => {
          response.statusCode = 400;
          response.end(JSON.stringify({ ok: false, error_code: 400 }));
        }, 100);
      } else {
        response.end(JSON.stringify({ ok: true }));
      }
    });
    const reservation = await startServer((_request, response) => response.end());
    const port = reservation.port;
    await closeServer(reservation.server);
    const child = spawnWebhook(port, telegramEnv(telegram.base), ["--max-body", "256"]);
    try {
      await waitUntilReady(child);
      const endpoint = `http://127.0.0.1:${port}/alertmanager`;
      assert.equal((await fetch(endpoint, { method: "POST", body: "{" })).status, 400);
      assert.equal((await fetch(endpoint, { method: "POST", body: "x".repeat(257) })).status, 413);
      const invalidUnicode = { alerts: [{ status: "firing", fingerprint: "\ud800" }] };
      assert.equal((await fetch(endpoint, { method: "POST", body: JSON.stringify(invalidUnicode) })).status, 400);
      const valid = { alerts: [{ status: "firing", fingerprint: "retryable", labels: { alertname: "Synthetic" } }] };
      const concurrent = await Promise.all([
        fetch(endpoint, { method: "POST", body: JSON.stringify(valid) }),
        fetch(endpoint, { method: "POST", body: JSON.stringify(valid) }),
      ]);
      assert.deepEqual(concurrent.map((response) => response.status), [503, 503]);
      assert.equal(deliveryAttempts, 1, "an in-flight duplicate must not start or acknowledge another delivery");
      assert.equal((await fetch(endpoint, { method: "POST", body: JSON.stringify(valid) })).status, 200);
      assert.equal(deliveryAttempts, 2, "a failed delivery must release its deduplication claim");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolvePromise) => child.once("close", resolvePromise));
      await closeServer(telegram.server);
    }
  });

  it("rejects unsupported IPv6 binding without a traceback", async () => {
    const result = await runPython([webhookScript, "--host", "::1", "--port", "0"], {});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /host must be loopback/);
    assert.ok(!result.stderr.includes("Traceback"));
  });

  it("enforces an absolute input deadline for slow request bodies", async () => {
    const reservation = await startServer((_request, response) => response.end());
    const port = reservation.port;
    await closeServer(reservation.server);
    const child = spawnWebhook(port, {}, ["--body-timeout", "0.2"]);
    try {
      await waitUntilReady(child);
      const startedAt = Date.now();
      const response = await new Promise<string>((resolvePromise, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        let output = "";
        let finished = false;
        let drip: NodeJS.Timeout | undefined;
        const timeout = setTimeout(() => {
          socket.destroy();
          reject(new Error("slow request was not bounded"));
        }, 1_500);
        const finish = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timeout);
          if (drip) clearInterval(drip);
          resolvePromise(output);
        };
        socket.setEncoding("utf8");
        socket.on("data", (chunk) => (output += chunk));
        socket.on("end", finish);
        socket.on("close", finish);
        socket.on("error", (error) => {
          if (output) finish();
          else reject(error);
        });
        socket.on("connect", () => {
          socket.write("POST /alertmanager HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{");
          drip = setInterval(() => socket.write(" "), 50);
        });
      });
      assert.match(response, /408 Request Timeout/);
      assert.ok(Date.now() - startedAt < 1_000);
      assert.equal((await fetch(`http://127.0.0.1:${port}/healthz`)).status, 200);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolvePromise) => child.once("close", resolvePromise));
    }
  });
});

describe("runtime doctor", () => {
  it("reports malformed HTTP health responses as incidents", async () => {
    let healthRequests = 0;
    const malformedHealth = await startRawServer((socket) => {
      healthRequests += 1;
      socket.once("data", () => socket.end("not-an-http-response\r\n\r\n"));
    });
    const messages: string[] = [];
    const telegram = await startServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        messages.push(new URLSearchParams(body).get("text") ?? "");
        response.end(JSON.stringify({ ok: true }));
      });
    });
    try {
      const result = await runPython([doctorScript], {
        ...telegramEnv(telegram.base),
        MINIME_DOCTOR_STATE_PATH: join(tempDir(), "state.json"),
        MINIME_DOCTOR_PROMETHEUS_URL: `${malformedHealth.base}/health`,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(healthRequests, 1);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /prometheus_unhealthy/);
      assert.ok(!result.stderr.includes("doctor_runtime_failed"));
    } finally {
      await closeServer(malformedHealth.server);
      await closeServer(telegram.server);
    }
  });

  it("detects monitoring failure, deduplicates it, and emits exactly one recovery with Node unavailable", async () => {
    const dir = tempDir();
    const state = join(dir, "doctor-state.json");
    const marker = join(dir, "node-invoked");
    const fakeBin = join(dir, "bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "node"), `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
    chmodSync(join(fakeBin, "node"), 0o755);
    const messages: string[] = [];
    let prometheusStatus = 200;
    const synthetic = await startServer((request, response) => {
      if (request.method === "POST") {
        let body = "";
        request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          messages.push(new URLSearchParams(body).get("text") ?? "");
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      response.statusCode = request.url === "/prometheus" ? prometheusStatus : 200;
      response.end("healthy");
    });
    const env = {
      ...telegramEnv(synthetic.base),
      PATH: `${fakeBin}:/usr/bin:/bin`,
      MINIME_DOCTOR_STATE_PATH: state,
      MINIME_DOCTOR_BOT_METRICS_URL: `${synthetic.base}/metrics`,
      MINIME_DOCTOR_PROMETHEUS_URL: `${synthetic.base}/prometheus`,
      MINIME_DOCTOR_ALERTMANAGER_URL: `${synthetic.base}/alertmanager`,
    };
    try {
      assert.equal((await runPython([doctorScript], env)).status, 0);
      assert.equal(messages.length, 0);
      prometheusStatus = 503;
      assert.equal((await runPython([doctorScript], env)).status, 0);
      assert.equal((await runPython([doctorScript], env)).status, 0);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /prometheus_unhealthy/);
      prometheusStatus = 200;
      assert.equal((await runPython([doctorScript], env)).status, 0);
      assert.equal((await runPython([doctorScript], env)).status, 0);
      assert.equal(messages.length, 2);
      assert.match(messages[1], /RECOVERED/);
      assert.equal(existsSync(marker), false, "native doctor must not invoke a Node binary from PATH");
      assert.equal((JSON.parse(readFileSync(state, "utf8")) as { version: number }).version, 1);
    } finally {
      await closeServer(synthetic.server);
    }
  });

  it("reports stable component, drift, freshness, and TCC codes without leaking configured values", async () => {
    const dir = tempDir();
    const state = join(dir, "state.json");
    const runtimeState = join(dir, "private-runtime-state.json");
    const nodeStub = join(dir, "private-node");
    const launchctlStub = join(dir, "private-launchctl");
    const messages: string[] = [];
    writeFileSync(runtimeState, "{}\n");
    utimesSync(runtimeState, new Date(0), new Date(0));
    writeFileSync(nodeStub, "#!/bin/sh\nprintf 'v0.synthetic\\n'\n");
    writeFileSync(launchctlStub, "#!/bin/sh\nexit 1\n");
    chmodSync(nodeStub, 0o755);
    chmodSync(launchctlStub, 0o755);
    const telegram = await startServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        messages.push(new URLSearchParams(body).get("text") ?? "");
        response.end(JSON.stringify({ ok: true }));
      });
    });
    const unavailable = await startServer((_request, response) => {
      response.statusCode = 503;
      response.end("down");
    });
    const configuredValues = [dir, telegram.base, unavailable.base, syntheticSecret, "private.bot.label"];
    try {
      const result = await runPython([doctorScript], {
        ...telegramEnv(telegram.base),
        MINIME_DOCTOR_STATE_PATH: state,
        MINIME_DOCTOR_LAUNCHD_LABEL: "private.bot.label",
        MINIME_DOCTOR_LAUNCHCTL: launchctlStub,
        MINIME_DOCTOR_BOT_METRICS_URL: `${unavailable.base}/metrics/private`,
        MINIME_DOCTOR_PROMETHEUS_URL: `${unavailable.base}/prometheus/private`,
        MINIME_DOCTOR_ALERTMANAGER_URL: `${unavailable.base}/alertmanager/private`,
        MINIME_DOCTOR_NODE_EXECUTABLE: nodeStub,
        MINIME_DOCTOR_NODE_BASELINE_PATH: join(dir, "expected-private-node"),
        MINIME_DOCTOR_NODE_BASELINE_VERSION: "v999.private",
        MINIME_DOCTOR_RUNTIME_STATE_PATH: runtimeState,
        MINIME_DOCTOR_RUNTIME_MAX_AGE: "2",
        MINIME_DOCTOR_TCC_STATUS_PATH: join(dir, "missing-private-tcc-signal"),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(messages.length, 1);
      for (const code of [
        "bot_service_unhealthy",
        "bot_metrics_unhealthy",
        "prometheus_unhealthy",
        "alertmanager_unhealthy",
        "node_path_drift",
        "node_version_drift",
        "runtime_state_stale",
        "tcc_unknown",
      ]) assert.ok(messages[0].includes(code), `expected ${code}`);
      for (const value of configuredValues) {
        assert.ok(!messages[0].includes(value));
        assert.ok(!result.stdout.includes(value));
        assert.ok(!result.stderr.includes(value));
      }
    } finally {
      await closeServer(unavailable.server);
      await closeServer(telegram.server);
    }
  });

  it("fails safe for corrupt state, overlap locks, timeouts, and missing runtime state", async () => {
    const dir = tempDir();
    const state = join(dir, "state.json");
    const lock = `${state}.lock`;
    let deliveries = 0;
    const telegram = await startServer((_request, response) => {
      deliveries += 1;
      response.end(JSON.stringify({ ok: true }));
    });
    const hanging = await startServer(() => undefined);
    const env = {
      ...telegramEnv(telegram.base),
      MINIME_DOCTOR_STATE_PATH: state,
      MINIME_DOCTOR_TIMEOUT: "0.1",
      MINIME_DOCTOR_PROMETHEUS_URL: `${hanging.base}/hang`,
      MINIME_DOCTOR_RUNTIME_STATE_PATH: join(dir, "missing-state"),
    };
    try {
      for (const corruptState of [
        "not-json\n",
        JSON.stringify({ version: 1, incidents: [{}] }),
      ]) {
        writeFileSync(state, corruptState);
        const corrupt = await runPython([doctorScript], env);
        assert.equal(corrupt.status, 0);
        assert.equal(deliveries, 0, "corrupt state must be reset without a notification storm");
        assert.deepEqual((JSON.parse(readFileSync(state, "utf8")) as { incidents: string[] }).incidents, []);
      }

      const repaired = await runPython([doctorScript], env);
      assert.equal(repaired.status, 0);
      assert.equal(deliveries, 1, "the next run must notify an active incident after repair");
      assert.match(readFileSync(state, "utf8"), /runtime_state_missing/);

      // A stale lock inode is harmless because ownership is process-bound.
      writeFileSync(lock, "active\n");
      const staleLock = await runPython([doctorScript], env);
      assert.equal(staleLock.status, 0);
      assert.equal(deliveries, 1);

      const holder = spawn(
        python,
        [
          "-c",
          "import fcntl,sys,time; handle=open(sys.argv[1], 'a'); fcntl.flock(handle, fcntl.LOCK_EX); print('locked', flush=True); time.sleep(30)",
          lock,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      await new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(() => reject(new Error("lock holder timed out")), 2_000);
        holder.stdout.setEncoding("utf8").on("data", (chunk) => {
          if (chunk.includes("locked")) {
            clearTimeout(timer);
            resolvePromise();
          }
        });
      });
      const overlap = await runPython([doctorScript], env);
      holder.kill("SIGTERM");
      await new Promise((resolvePromise) => holder.once("close", resolvePromise));
      assert.equal(overlap.status, 0);
      assert.match(overlap.stderr, /doctor_overlap_suppressed/);
      assert.equal(deliveries, 1);

      await closeServer(hanging.server);
      writeFileSync(join(dir, "missing-state"), "fresh\n");
      const changed = await runPython([doctorScript], { ...env, MINIME_DOCTOR_PROMETHEUS_URL: "http://127.0.0.1:1/down" });
      assert.equal(changed.status, 0);
      assert.equal(deliveries, 2);
    } finally {
      if (hanging.server.listening) await closeServer(hanging.server);
      await closeServer(telegram.server);
    }
  });

  it("retries an unchanged incident after notification delivery fails", async () => {
    const dir = tempDir();
    const state = join(dir, "state.json");
    let requests = 0;
    const telegram = await startServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.statusCode = 400;
        response.end(JSON.stringify({ ok: false, error_code: 400 }));
      } else {
        response.end(JSON.stringify({ ok: true }));
      }
    });
    const env = {
      ...telegramEnv(telegram.base),
      MINIME_DOCTOR_STATE_PATH: state,
      MINIME_DOCTOR_NODE_EXECUTABLE: join(dir, "missing-node"),
    };
    try {
      const failed = await runPython([doctorScript], env);
      assert.equal(failed.status, 1);
      assert.equal(existsSync(state), false, "failed delivery must not advance incident state");
      const retried = await runPython([doctorScript], env);
      assert.equal(retried.status, 0, retried.stderr);
      assert.match(readFileSync(state, "utf8"), /node_unavailable/);
      const unchanged = await runPython([doctorScript], env);
      assert.equal(unchanged.status, 0);
      assert.equal(requests, 2);
    } finally {
      await closeServer(telegram.server);
    }
  });

  it("sanitizes malformed configuration and runtime filesystem failures", async () => {
    const dir = tempDir();
    const privateUrl = "file:///private/configured/health";
    const invalidUrl = await runPython([doctorScript], {
      MINIME_DOCTOR_STATE_PATH: join(dir, "state.json"),
      MINIME_DOCTOR_PROMETHEUS_URL: privateUrl,
    });
    assert.equal(invalidUrl.status, 2);
    assert.ok(!invalidUrl.stderr.includes(privateUrl));
    assert.ok(!invalidUrl.stderr.includes("Traceback"));

    const blockedParent = join(dir, "private-parent");
    writeFileSync(blockedParent, "not a directory");
    const runtimeFailure = await runPython([doctorScript], {
      MINIME_DOCTOR_STATE_PATH: join(blockedParent, "state.json"),
    });
    assert.equal(runtimeFailure.status, 1);
    assert.match(runtimeFailure.stderr, /doctor_runtime_failed/);
    assert.ok(!runtimeFailure.stderr.includes(blockedParent));
    assert.ok(!runtimeFailure.stderr.includes("Traceback"));
  });

  it("maps malformed, non-regular, and oversized TCC signals to the stable unknown incident", async () => {
    const dir = tempDir();
    const malformed = join(dir, "tcc-malformed");
    const fifo = join(dir, "tcc-fifo");
    const oversized = join(dir, "tcc-oversized");
    writeFileSync(malformed, Buffer.from([0xff, 0xfe]));
    writeFileSync(oversized, "x".repeat(1025));
    const fifoResult = await runPython(["-c", "import os,sys; os.mkfifo(sys.argv[1])", fifo], {});
    assert.equal(fifoResult.status, 0, fifoResult.stderr);
    const messages: string[] = [];
    const telegram = await startServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        messages.push(new URLSearchParams(body).get("text") ?? "");
        response.end(JSON.stringify({ ok: true }));
      });
    });
    try {
      for (const [index, tccPath] of [malformed, fifo, oversized].entries()) {
        const result = await runPython([doctorScript], {
          ...telegramEnv(telegram.base),
          MINIME_DOCTOR_STATE_PATH: join(dir, `state-${index}.json`),
          MINIME_DOCTOR_TCC_STATUS_PATH: tccPath,
        }, 2_000);
        assert.equal(result.status, 0, result.stderr);
      }
      assert.equal(messages.length, 3);
      for (const message of messages) assert.match(message, /tcc_unknown/);
    } finally {
      await closeServer(telegram.server);
    }
  });

  it("detects an explicitly configured missing Node executable while native delivery remains available", async () => {
    const dir = tempDir();
    const messages: string[] = [];
    const telegram = await startServer((request, response) => {
      let body = "";
      request.setEncoding("utf8").on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        messages.push(new URLSearchParams(body).get("text") ?? "");
        response.end(JSON.stringify({ ok: true }));
      });
    });
    try {
      const result = await runPython([doctorScript], {
        ...telegramEnv(telegram.base),
        MINIME_DOCTOR_STATE_PATH: join(dir, "state.json"),
        MINIME_DOCTOR_NODE_EXECUTABLE: join(dir, "node-does-not-exist"),
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /node_unavailable/);
      assertSecretAbsent(result);
    } finally {
      await closeServer(telegram.server);
    }
  });
});

describe("monitoring package examples", () => {
  it("ships valid Node-free launchd plists with placeholders", async () => {
    for (const name of ["ai.minime.alertmanager-webhook.plist", "ai.minime.runtime-doctor.plist"]) {
      const path = join(root, "examples", "monitoring", name);
      const result = await runPython(
        ["-c", "import plistlib,sys; plistlib.load(open(sys.argv[1], 'rb')); print('valid')", path],
        {},
      );
      assert.equal(result.status, 0, result.stderr);
      const plist = readFileSync(path, "utf8");
      assert.match(plist, /<string>\/usr\/bin\/python3<\/string>/);
      assert.match(plist, /<string>\/usr\/bin:\/bin<\/string>/);
      assert.match(plist, /<key>MINIME_SOPS_EXECUTABLE<\/key>/);
      assert.ok(!plist.includes("users/"));
      assert.ok(!plist.includes("node_modules"));
    }
  });
});
