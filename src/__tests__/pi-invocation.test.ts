import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH,
  clampOpenAIPromptCacheKey,
} from "@earendil-works/pi-ai/api/openai-prompt-cache";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { resolvePiInvocation } from "../pi-extensions/pi-invocation.js";
import {
  EXPECTED_PI_PACKAGE_VERSION,
  formatPiRuntimeDiagnostic,
  resolvePackageOwnedPiInvocation,
  type PiRuntimeResolveOptions,
} from "../pi-runtime.js";

const TEST_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEGACY_SESSION_FIXTURE = resolve(
  TEST_ROOT,
  "src",
  "__tests__",
  "fixtures",
  "pi-0.80.6-session.jsonl",
);
const RPC_ENTRY = "/opt/package/node_modules/@earendil-works/pi-coding-agent/dist/rpc-entry.js";
const CLI_ENTRY = "/opt/package/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";

interface RpcResponse {
  id?: string;
  type: string;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

function fixtureOptions(overrides: PiRuntimeResolveOptions = {}): PiRuntimeResolveOptions {
  return {
    execPath: "/usr/local/bin/node",
    currentEntrypoint: "/opt/minime/dist/cli.js",
    resolveModule: (specifier) => {
      assert.equal(specifier, "@earendil-works/pi-coding-agent/rpc-entry");
      return RPC_ENTRY;
    },
    exists: (path) => path === RPC_ENTRY || path === CLI_ENTRY,
    readFile: () => JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: EXPECTED_PI_PACKAGE_VERSION,
      bin: { pi: "dist/cli.js" },
    }),
    realpath: (path) => path,
    ...overrides,
  };
}

async function waitForRpcResponses(
  child: ChildProcess,
  expectedIds: readonly string[],
): Promise<Map<string, RpcResponse>> {
  const responses = new Map<string, RpcResponse>();
  let buffered = "";
  let settled = false;

  return new Promise<Map<string, RpcResponse>>((resolveResponses, rejectResponses) => {
    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for Pi RPC responses: ${expectedIds.join(", ")}`));
    }, 10_000);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout?.off("data", onData);
      if (error) rejectResponses(error);
      else resolveResponses(responses);
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`Pi RPC exited before responding: code=${code} signal=${signal}`));
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      while (true) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        const record = JSON.parse(line) as RpcResponse;
        if (record.type === "response" && typeof record.id === "string") {
          responses.set(record.id, record);
        }
      }
      if (expectedIds.every((id) => responses.has(id))) finish();
    };

    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.on("data", onData);
  });
}

async function reapRpcChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close");
  child.stdin?.end();
  const ended = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 1_000)),
  ]);
  if (ended || child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGTERM");
  const terminated = await Promise.race([
    closed.then(() => true),
    new Promise<false>((resolveWait) => setTimeout(() => resolveWait(false), 1_000)),
  ]);
  if (terminated || child.exitCode !== null || child.signalCode !== null) return;

  child.kill("SIGKILL");
  await closed;
}

describe("package-owned Pi invocation", () => {
  it("resolves the exported RPC entrypoint and executes it with Node", () => {
    const invocation = resolvePackageOwnedPiInvocation("rpc", ["--model", "gpt-5.5"], fixtureOptions());

    assert.equal(invocation.command, "/usr/local/bin/node");
    assert.deepEqual(invocation.args, [RPC_ENTRY, "--model", "gpt-5.5"]);
    assert.deepEqual(invocation.diagnostic, {
      expectedVersion: "0.82.1",
      detectedVersion: "0.82.1",
      entrypointKind: "rpc",
      versionMismatch: false,
    });
  });

  it("resolves the sibling package CLI for print-mode children without PATH fallback", () => {
    const invocation = resolvePiInvocation(["--mode", "json"], fixtureOptions());

    assert.deepEqual(invocation, {
      command: "/usr/local/bin/node",
      args: [CLI_ENTRY, "--mode", "json"],
    });
    assert.notEqual(invocation.command, "pi");
  });

  it("resolves the real installed 0.82.1 CLI/RPC and preserves upstream GPT-5.6 metadata", () => {
    const rpcEntry = fileURLToPath(
      import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"),
    );
    const packageRoot = resolve(dirname(rpcEntry), "..");
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as { version?: string; bin?: { pi?: string } };
    const cliEntry = resolve(packageRoot, manifest.bin?.pi ?? "");
    const rpc = resolvePackageOwnedPiInvocation("rpc", ["--offline"]);
    const cli = resolvePackageOwnedPiInvocation("cli", ["--offline"]);

    assert.equal(manifest.version, EXPECTED_PI_PACKAGE_VERSION);
    assert.equal(rpc.command, process.execPath);
    assert.deepEqual(rpc.args, [rpcEntry, "--offline"]);
    assert.equal(cli.command, process.execPath);
    assert.deepEqual(cli.args, [cliEntry, "--offline"]);
    assert.equal(rpc.diagnostic.versionMismatch, false);
    assert.equal(cli.diagnostic.versionMismatch, false);

    for (const id of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] as const) {
      const model = OPENAI_CODEX_MODELS[id];
      assert.equal(model.provider, "openai-codex", id);
      assert.equal(model.contextWindow, 272_000, id);
      assert.equal(model.maxTokens, 128_000, id);
    }
  });

  it("keeps Pi's Codex prompt-cache/session identity clamp at 64 Unicode characters", () => {
    const overlength = `${"a".repeat(63)}🛰️tail`;
    const clamped = clampOpenAIPromptCacheKey(overlength);

    assert.equal(OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH, 64);
    assert.equal(Array.from(clamped ?? "").length, 64);
    assert.equal(clamped, `${"a".repeat(63)}🛰`);
  });

  it(
    "resumes a copied Pi 0.80.6 session through the installed 0.82.1 RPC without provider work",
    { timeout: 20_000 },
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "minime-pi-0806-resume-"));
      const workspace = join(temp, "workspace");
      const agentDir = join(temp, "agent");
      const sessionDir = join(temp, "sessions");
      const copiedSession = join(sessionDir, "2026-07-01T08-00-00-000Z_pi-0806-legacy-session.jsonl");
      mkdirSync(workspace, { recursive: true });
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(sessionDir, { recursive: true });
      copyFileSync(LEGACY_SESSION_FIXTURE, copiedSession);
      const originalSession = readFileSync(copiedSession, "utf8");

      const invocation = resolvePackageOwnedPiInvocation("rpc", [
        "--offline",
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--session",
        copiedSession,
        "--session-dir",
        sessionDir,
        "--provider",
        "openai-codex",
        "--model",
        "gpt-5.6-sol",
      ]);
      const child = spawn(invocation.command, invocation.args, {
        cwd: workspace,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          HOME: temp,
          LANG: process.env.LANG ?? "C",
          PATH: process.env.PATH,
          PI_CODING_AGENT_DIR: agentDir,
          PI_CODING_AGENT_SESSION_DIR: sessionDir,
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
        },
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      try {
        const expectedIds = ["state", "entries", "messages", "last", "stats", "models"];
        const responsesPromise = waitForRpcResponses(child, expectedIds);
        for (const command of [
          { id: "state", type: "get_state" },
          { id: "entries", type: "get_entries" },
          { id: "messages", type: "get_messages" },
          { id: "last", type: "get_last_assistant_text" },
          { id: "stats", type: "get_session_stats" },
          { id: "models", type: "get_available_models" },
        ]) {
          child.stdin?.write(`${JSON.stringify(command)}\n`);
        }
        const responses = await responsesPromise;
        for (const id of expectedIds) {
          assert.equal(responses.get(id)?.success, true, `${id}: ${responses.get(id)?.error ?? stderr}`);
        }

        const state = responses.get("state")?.data as {
          sessionId: string;
          sessionName?: string;
          messageCount: number;
          model?: { provider?: string; id?: string; contextWindow?: number };
        };
        assert.equal(state.sessionId, "pi-0806-legacy-session");
        assert.equal(state.sessionName, "Pi 0.80.6 compatibility fixture");
        assert.equal(state.messageCount, 2);
        assert.equal(state.model?.provider, "openai-codex");
        assert.equal(state.model?.id, "gpt-5.6-sol");
        assert.equal(state.model?.contextWindow, 272_000);

        const entries = (responses.get("entries")?.data as {
          entries: Array<{ id: string }>;
          leafId: string;
        });
        assert.deepEqual(
          entries.entries.map((entry) => entry.id),
          ["legacy-model", "legacy-thinking", "legacy-user", "legacy-assistant", "legacy-name"],
        );
        assert.equal(entries.leafId, "legacy-name");

        const messages = (responses.get("messages")?.data as {
          messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
        }).messages;
        assert.deepEqual(messages.map((message) => message.role), ["user", "assistant"]);
        assert.equal(messages[0].content[0].text, "Legacy 0.80.6 user history marker.");
        assert.equal(messages[1].content[0].text, "Legacy 0.80.6 assistant history marker.");
        assert.deepEqual(responses.get("last")?.data, {
          text: "Legacy 0.80.6 assistant history marker.",
        });

        const stats = responses.get("stats")?.data as {
          sessionId: string;
          userMessages: number;
          assistantMessages: number;
          totalMessages: number;
        };
        assert.equal(stats.sessionId, "pi-0806-legacy-session");
        assert.equal(stats.userMessages, 1);
        assert.equal(stats.assistantMessages, 1);
        assert.equal(stats.totalMessages, 2);

        const availableModels = (responses.get("models")?.data as {
          models: Array<{ provider: string; id: string; contextWindow: number }>;
        }).models;
        assert.deepEqual(
          availableModels,
          [],
          "credential-free model refresh remains local and does not advertise unavailable provider models",
        );
        assert.equal(readFileSync(copiedSession, "utf8"), originalSession);
      } finally {
        await reapRpcChild(child);
        rmSync(temp, { recursive: true, force: true });
      }
    },
  );

  it("reuses a current package-owned CLI symlink", () => {
    const currentEntrypoint = "/opt/package/node_modules/.bin/pi";
    const invocation = resolvePiInvocation(["-p"], {
      ...fixtureOptions(),
      entrypoint: currentEntrypoint,
      exists: (path) => path === RPC_ENTRY || path === CLI_ENTRY || path === currentEntrypoint,
      realpath: (path) => path === currentEntrypoint ? CLI_ENTRY : path,
    });

    assert.deepEqual(invocation.args, [currentEntrypoint, "-p"]);
  });

  it("fails loudly when the locked exported entrypoint cannot be resolved", () => {
    assert.throws(
      () => resolvePiInvocation([], fixtureOptions({
        resolveModule: () => {
          throw new Error("not exported");
        },
      })),
      /Package-owned Pi cli entrypoint is unavailable/,
    );
  });

  it("reports version mismatch without exposing an entrypoint path", () => {
    const invocation = resolvePackageOwnedPiInvocation("cli", [], fixtureOptions({
      readFile: () => JSON.stringify({ version: "9.9.9", bin: { pi: "dist/cli.js" } }),
    }));
    const diagnostic = formatPiRuntimeDiagnostic(invocation.diagnostic);

    assert.match(diagnostic, /expectedVersion=0\.82\.1/);
    assert.match(diagnostic, /entrypointKind=cli/);
    assert.match(diagnostic, /versionMismatch=true/);
    assert.doesNotMatch(diagnostic, /\/opt\//);
  });

  it("keeps every direct and nested Pi resolution coherent at the exact approved version", () => {
    const packageJson = JSON.parse(readFileSync(resolve(TEST_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync(resolve(TEST_ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    const names = [
      "@earendil-works/pi-agent-core",
      "@earendil-works/pi-ai",
      "@earendil-works/pi-coding-agent",
      "@earendil-works/pi-tui",
    ];

    for (const name of names) {
      assert.equal(packageJson.dependencies[name], EXPECTED_PI_PACKAGE_VERSION);
      assert.equal(packageLock.packages[""].dependencies?.[name], EXPECTED_PI_PACKAGE_VERSION);
      assert.equal(packageLock.packages[`node_modules/${name}`].version, EXPECTED_PI_PACKAGE_VERSION);
    }

    const piResolutions = Object.entries(packageLock.packages)
      .filter(([path]) => /(?:^|\/)node_modules\/@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)$/.test(path));
    assert.ok(piResolutions.length >= names.length);
    for (const [path, manifest] of piResolutions) {
      assert.equal(manifest.version, EXPECTED_PI_PACKAGE_VERSION, path);
      const installed = JSON.parse(
        readFileSync(resolve(TEST_ROOT, path, "package.json"), "utf8"),
      ) as { version?: string };
      assert.equal(installed.version, EXPECTED_PI_PACKAGE_VERSION, path);
    }
  });

  it("keeps grammY/types exact and the Pi-relevant patched transitive resolutions installed", () => {
    const packageJson = JSON.parse(readFileSync(resolve(TEST_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const packageLock = JSON.parse(readFileSync(resolve(TEST_ROOT, "package-lock.json"), "utf8")) as {
      packages: Record<string, { version?: string; dependencies?: Record<string, string> }>;
    };
    const installedGrammy = JSON.parse(
      readFileSync(resolve(TEST_ROOT, "node_modules", "grammy", "package.json"), "utf8"),
    ) as { version?: string };
    const installedGrammyTypes = JSON.parse(
      readFileSync(resolve(TEST_ROOT, "node_modules", "@grammyjs", "types", "package.json"), "utf8"),
    ) as { version?: string };

    assert.equal(packageJson.dependencies.grammy, "1.45.1");
    assert.equal(packageLock.packages[""].dependencies?.grammy, "1.45.1");
    assert.equal(packageLock.packages["node_modules/grammy"].version, "1.45.1");
    assert.equal(packageLock.packages["node_modules/grammy"].dependencies?.["@grammyjs/types"], "4.0.0");
    assert.equal(packageLock.packages["node_modules/@grammyjs/types"].version, "4.0.0");
    assert.equal(installedGrammy.version, "1.45.1");
    assert.equal(installedGrammyTypes.version, "4.0.0");
    assert.equal(packageJson.dependencies["@grammyjs/auto-retry"], "^2.0.2");
    assert.equal(packageLock.packages[""].dependencies?.["@grammyjs/auto-retry"], "^2.0.2");
    assert.equal(
      packageLock.packages[
        "node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"
      ].version,
      "5.0.7",
    );
    assert.equal(
      packageLock.packages[
        "node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs"
      ].version,
      "7.6.5",
    );
    assert.equal(packageLock.packages["node_modules/protobufjs"].version, "7.6.5");
  });
});
