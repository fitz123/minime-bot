import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseCodexQuotaSamplerArgs, resolveCodexQuotaSamplerConfig, runCodexQuotaSampler, formatCodexQuotaSamplerHelp, isDirectCodexQuotaSamplerEntrypoint } from "../codex-quota-sampler.js";
import { readCodexQuota, CODEX_USAGE_URL, type CodexQuotaReaderOptions } from "../codex-quota-reader.js";
import { refreshCodexQuota, refreshQuotaStatus } from "../codex-quota-refresh.js";
import { buildStatusReport } from "../status-report.js";

const fixtures: string[] = [];
after(() => fixtures.forEach(dir => rmSync(dir, { recursive: true, force: true })));
function target() {
  const dir = mkdtempSync(join(tmpdir(), "quota-get-test-")); fixtures.push(dir);
  return { stateFile: join(dir, "state.json"), textfileDir: join(dir, "metrics"), env: {}, timeoutMs: 100, now: new Date("2026-06-05T12:00:00Z") };
}
const usage = { plan_type: "pro", rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_after_seconds: 60 }, secondary_window: null }, account_id: "discard-this", credits: { balance: "discard-this" } };
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;
function injected(overrides: CodexQuotaReaderOptions = {}): CodexQuotaReaderOptions {
  return {
    createRuntime: async options => {
      assert.equal(options.modelsPath, null); assert.equal(options.refreshOnCreate, false); assert.equal(options.allowModelNetwork, false);
      return { getAuth: async (provider, authOptions) => {
        assert.equal(provider, "openai-codex"); assert.equal(authOptions.signal, options.signal);
        return { source: "OAuth", auth: { apiKey: token } };
      } };
    },
    fetch: async (url, options) => {
      assert.equal(url, CODEX_USAGE_URL); assert.equal(options?.method, "GET");
      assert.equal(options?.body, undefined); assert.equal(options?.redirect, "error");
      assert.deepEqual(options?.headers, { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": "synthetic-account" });
      return Response.json(usage);
    }, ...overrides,
  };
}

describe("GET quota acquisition", () => {
  it("resolves Pi OAuth and reads exhausted quota without inference or an entitlement check", async () => {
    const snapshot = await readCodexQuota({ ...injected(), now: new Date("2026-06-05T12:00:00Z") });
    assert.equal(snapshot.families[0].allowed, false);
    assert.equal(snapshot.families[0].limitReached, true);
    assert.equal(snapshot.families[0].windows.primary?.durationSeconds, 604800);
    assert.equal(snapshot.families[0].windows.primary?.resetTimestamp, 1780660860);
    assert.equal(snapshot.families[0].windows.secondary, undefined);
    assert.doesNotMatch(JSON.stringify(snapshot), /discard-this|account_id|credits/);
  });

  it("requires OAuth source and a JWT account claim, without invoking fetch on failure", async () => {
    for (const [auth, code] of [
      [undefined, "auth_unavailable"],
      [{ source: "API Key", auth: { apiKey: token } }, "auth_unavailable"],
      [{ source: "OAuth", auth: {} }, "auth_unavailable"],
      [{ source: "OAuth", auth: { apiKey: "private-invalid-token" } }, "account_missing"],
      [{ source: "OAuth", auth: { apiKey: `h.${Buffer.from("{}").toString("base64url")}.s` } }, "account_missing"],
    ] as const) {
      await assert.rejects(readCodexQuota({ ...injected(), createRuntime: async () => ({ getAuth: async () => auth }), fetch: async () => { throw new Error("must not fetch"); } }), { message: code });
    }
  });

  it("classifies errors without retaining raw auth/provider diagnostics or body", async () => {
    for (const [overrides, code] of [
      [{ createRuntime: async () => { throw new Error("secret-auth"); } }, "auth_failed"],
      [{ createRuntime: async () => ({ getAuth: async () => { throw new Error("secret-auth"); } }) }, "auth_failed"],
      [{ fetch: async () => { throw new Error("secret-provider"); } }, "request_failed"],
      [{ fetch: async () => new Response("secret-provider", { status: 401 }) }, "http_error"],
      [{ fetch: async () => new Response("secret-provider") }, "invalid_response"],
      [{ fetch: async () => Response.json({ plan_type: "pro" }) }, "invalid_response"],
    ] satisfies Array<[CodexQuotaReaderOptions, string]>) {
      await assert.rejects(readCodexQuota(injected(overrides)), error => {
        assert.equal((error as Error).message, code);
        assert.doesNotMatch(String(error) + (error as Error).stack, /secret-auth|secret-provider/);
        return true;
      });
    }
  });

  for (const phase of ["runtime", "auth", "fetch", "body"] as const) {
    it(`bounds the entire read when ${phase} ignores cancellation`, async () => {
      let signal: AbortSignal | undefined;
      const never = () => new Promise<never>(() => {});
      const options = injected({ createRuntime: async opts => {
        signal = opts.signal;
        if (phase === "runtime") return never();
        return { getAuth: async () => phase === "auth" ? never() : { source: "OAuth", auth: { apiKey: token } } };
      } });
      if (phase === "fetch") options.fetch = async () => never();
      if (phase === "body") options.fetch = async () => ({ ok: true, json: never }) as unknown as Response;
      await assert.rejects(readCodexQuota({ ...options, timeoutMs: 10 }), { message: "timeout" });
      assert.equal(signal?.aborted, true);
    });
  }
});

describe("sampler and shared status refresh", () => {
  it("keeps CLI flags harmless and honors paths/deadlines without child configuration", async () => {
    const paths = target();
    const cli = parseCodexQuotaSamplerArgs(["--workspace", "/tmp/control", "--state-file", paths.stateFile, "--textfile-dir", paths.textfileDir, "--model", "obsolete-model", "--pi-bin", "unused", "--prompt", "unused", "--sampler-cwd", "unused", "--timeout", "100", "--dry-run"]);
    const config = resolveCodexQuotaSamplerConfig({ cli, env: {}, isWritableDir: () => false });
    assert.equal(config.stateFile, paths.stateFile); assert.equal(config.timeoutMs, 100);
    assert.equal("model" in config, false);
    const result = await runCodexQuotaSampler({ config, createRuntime: async () => { throw new Error("dry run must not resolve OAuth"); } });
    assert.equal(result.status, "dry_run"); assert.equal(existsSync(paths.stateFile), false);
    for (const flag of ["--model", "--prompt", "--pi-bin", "--sampler-cwd", "--help"]) assert.ok(formatCodexQuotaSamplerHelp().includes(flag));
    assert.throws(() => parseCodexQuotaSamplerArgs(["--state-file"]), /requires a value/);
    assert.throws(() => parseCodexQuotaSamplerArgs(["--timeout", "0"]), /positive integer/);
    assert.throws(() => resolveCodexQuotaSamplerConfig({ env: {}, isWritableDir: () => false }), /requires a configured or writable/);
    assert.equal(isDirectCodexQuotaSamplerEntrypoint("file:///tmp/quota.js", "/tmp/quota.js"), true);
  });

  it("writes dynamic usage, duration-correct weekly projection, success and attempt metrics", async () => {
    const paths = target();
    const result = await runCodexQuotaSampler({ ...paths, ...injected(), config: { ...paths, dryRun: false } });
    assert.equal(result.status, "success");
    const state = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    assert.equal(state.lastSuccessTimestamp, 1780660800); assert.equal(state.lastAttemptTimestamp, 1780660800); assert.equal(state.probeSuccess, true);
    const metrics = readFileSync(join(paths.textfileDir, "codex_usage.prom"), "utf8");
    assert.match(metrics, /codex_usage_window_percent\{family="codex",window="primary"\} 100/);
    assert.match(metrics, /codex_usage_weekly_percent 100/); assert.doesNotMatch(metrics, /codex_usage_5h/);
    assert.match(metrics, /codex_usage_last_success_timestamp 1780660800/);
    assert.match(readFileSync(join(paths.textfileDir, "codex_usage_probe.prom"), "utf8"), /codex_usage_probe_success 1/);
  });

  it("preserves last success and usage metrics on failure/timeout, marking even recent cached data as failed", async () => {
    const paths = target();
    await refreshCodexQuota({ ...paths, ...injected() });
    const before = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    const metrics = readFileSync(join(paths.textfileDir, "codex_usage.prom"), "utf8");
    for (const timeout of [false, true]) {
      const now = new Date(paths.now.getTime() + 120000);
      const result = await refreshCodexQuota({ ...paths, now, ...injected({ fetch: async () => timeout ? new Promise(() => {}) : Promise.reject(new Error("private-provider-details")) }), timeoutMs: 10 });
      assert.equal(result.success, false); assert.equal(result.failureReason, timeout ? "timeout" : "request_failed");
      const state = JSON.parse(readFileSync(paths.stateFile, "utf8"));
      assert.equal(state.lastSuccess, before.lastSuccess); assert.deepEqual(state.families, before.families); assert.equal(state.probeSuccess, false);
      assert.equal(readFileSync(join(paths.textfileDir, "codex_usage.prom"), "utf8"), metrics);
      assert.match(readFileSync(join(paths.textfileDir, "codex_usage_probe.prom"), "utf8"), /codex_usage_probe_success 0/);
      const report = buildStatusReport({ activeCount: 0, maxSessions: 2, uptimeSeconds: 0, quotaStatus: result.status, now });
      assert.match(report, /cached \(last success 2m ago; refresh failed\)/); assert.doesNotMatch(report, /quota: fresh|private-provider-details/);
    }
  });

  it("preserves legacy values without inventing durations after a failed refresh", async () => {
    const paths = target();
    writeFileSync(paths.stateFile, JSON.stringify({ provider: "codex", lastSuccessTimestamp: 1780660800, windows: { "5h": { usedPercent: 50 }, week: {} } }));
    const result = await refreshCodexQuota({ ...paths, ...injected({ fetch: async () => { throw new Error(); } }) });
    assert.equal(result.status.state, "available");
    if (result.status.state === "available") {
      assert.equal(result.status.snapshot.families[0].windows.primary?.durationSeconds, undefined);
      assert.equal(result.status.snapshot.families[0].windows.primary?.usedPercent, 50);
    }
  });

  it("records a failed first attempt without creating a success or quota windows", async () => {
    const paths = target();
    const status = await refreshQuotaStatus({ ...paths, ...injected({ fetch: async () => { throw new Error(); } }) });
    assert.equal(status.state, "unavailable"); assert.equal(status.refreshFailed, true);
    const state = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    assert.equal(state.lastSuccess, undefined); assert.deepEqual(state.families, []); assert.equal(state.probeSuccess, false);
  });

  it("coalesces concurrent requests per target and allows the next refresh", async () => {
    const paths = target(); let calls = 0; let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const options = { ...paths, ...injected({ fetch: async () => { calls++; await blocked; return Response.json(usage); } }) };
    const first = refreshCodexQuota(options); const second = refreshCodexQuota(options);
    assert.equal(first, second);
    const other = refreshCodexQuota({ ...options, ...target() });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 2);
    release(); await Promise.all([first, second, other]);
    await refreshCodexQuota(options); assert.equal(calls, 3);
  });

  it("preserves valid cache if writing new usage metrics fails", async () => {
    const paths = target(); await refreshCodexQuota({ ...paths, ...injected() });
    const before = JSON.parse(readFileSync(paths.stateFile, "utf8"));
    const blocked = join(dirname(paths.stateFile), "blocked"); writeFileSync(blocked, "not a directory");
    const result = await refreshCodexQuota({ ...paths, ...injected(), textfileDir: blocked });
    assert.equal(result.success, false);
    const after = JSON.parse(readFileSync(paths.stateFile, "utf8")); assert.equal(after.lastSuccess, before.lastSuccess); assert.deepEqual(after.families, before.families);
  });
});
