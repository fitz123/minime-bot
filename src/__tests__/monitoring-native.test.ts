import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type RequestListener, type Server } from "node:http";
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
): Promise<{ server: Server; base: string; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, port: address.port };
}

async function closeServer(server: Server): Promise<void> {
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
      PATH: `${bin}:/usr/bin:/bin`,
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
          response.end(JSON.stringify({ ok: false, error_code: 429, parameters: { retry_after: 0 } }));
        } else {
          response.end(JSON.stringify({ ok: true, result: {} }));
        }
      });
    });
    try {
      const result = await runPython(
        [nativeScript, "--message", "synthetic firing", "--chat-id", "10001", "--thread-id", "9"],
        telegramEnv(base),
      );
      assert.equal(result.status, 0, result.stderr);
      assertSecretAbsent(result);
      assert.equal(requests.length, 2);
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
        response.end(JSON.stringify({ ok: true }));
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
      assert.equal((await post(firing)).status, 200);
      assert.equal((await post(firing)).status, 200);
      assert.equal(messages.length, 1);
      assert.match(messages[0], /FIRING alert=BotDown severity=critical instance=test/);
      const resolved = { alerts: [{ ...firing.alerts[0], status: "resolved" }] };
      assert.equal((await post(resolved)).status, 200);
      assert.equal(messages.length, 2);
      assert.match(messages[1], /RESOLVED/);
      assert.equal(existsSync(marker), false);
      assert.ok(!stderr.includes(syntheticSecret));
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolvePromise) => child.once("close", resolvePromise));
      await closeServer(telegram.server);
    }
  });

  it("rejects malformed and oversized bodies and returns non-2xx when delivery fails", async () => {
    const telegram = await startServer((_request, response) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ ok: false, error_code: 500 }));
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
      const valid = { alerts: [{ status: "firing", fingerprint: "retryable", labels: { alertname: "Synthetic" } }] };
      assert.equal((await fetch(endpoint, { method: "POST", body: JSON.stringify(valid) })).status, 503);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolvePromise) => child.once("close", resolvePromise));
      await closeServer(telegram.server);
    }
  });
});

describe("runtime doctor", () => {
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
      writeFileSync(state, "not-json\n");
      const corrupt = await runPython([doctorScript], env);
      assert.equal(corrupt.status, 0);
      assert.equal(deliveries, 0, "corrupt state must be reset without a notification storm");
      assert.match(readFileSync(state, "utf8"), /runtime_state_missing/);

      writeFileSync(lock, "active\n");
      const overlap = await runPython([doctorScript], env);
      assert.equal(overlap.status, 0);
      assert.equal(deliveries, 0);
      rmSync(lock);

      await closeServer(hanging.server);
      writeFileSync(join(dir, "missing-state"), "fresh\n");
      const changed = await runPython([doctorScript], { ...env, MINIME_DOCTOR_PROMETHEUS_URL: "http://127.0.0.1:1/down" });
      assert.equal(changed.status, 0);
      assert.equal(deliveries, 1);
    } finally {
      if (hanging.server.listening) await closeServer(hanging.server);
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
      assert.ok(!plist.includes("users/"));
      assert.ok(!plist.includes("node_modules"));
    }
  });
});
