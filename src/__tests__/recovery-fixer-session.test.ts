import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { ExtensionAPI, ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  PI_EXTENSION_WRAPPER_RELPATHS,
  PI_RECOVERY_WRAPPER_RELPATHS,
  buildPiSpawnArgs,
  buildPiSpawnEnv,
  type PiStartupDiagnostics,
} from "../pi-rpc-protocol.js";
import {
  RecoveryProtocolClient,
  RecoveryToolJournal,
  forbiddenRecoveryBashReason,
  forbiddenRecoveryToolReason,
  isReadOnlyRecoveryBash,
  readPrivateRecoveryCredential,
  readRecoveryRuntimeContract,
  summarizeRecoveryIntent,
} from "../pi-extensions/recovery-protocol.js";
import {
  captureRecoverySessionId,
  classifyRecoveryFixerResult,
  discoverCanonicalRecoveryTranscript,
  hasNoSessionFoundClassifier,
  inspectRecoveryTranscript,
  runRecoveryFixer,
  recoveryStartsNewPiProcessGroup,
  terminateRecoveryProcessGroup,
} from "../recovery/fixer-session.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runtimeEnv(
  mode: "diagnose" | "enabled" = "enabled",
  endpoint = "http://127.0.0.1:9877",
): NodeJS.ProcessEnv {
  return {
    MINIME_RECOVERY_ENDPOINT: endpoint,
    MINIME_RECOVERY_FIXER_CREDENTIAL_FILE: "/private/fixer-token",
    MINIME_RECOVERY_MODE: mode,
    MINIME_RECOVERY_INVOCATION_ID: "7",
    MINIME_RECOVERY_INCIDENT_ID: "4",
    MINIME_RECOVERY_GENERATION: "3",
    MINIME_RECOVERY_EVIDENCE_HASH: "a".repeat(64),
    MINIME_RECOVERY_POLICY_REVISION: "2",
    MINIME_RECOVERY_LEASE_TOKEN: "b".repeat(48),
    MINIME_RECOVERY_PREIMAGE_DIRECTORY: "/private/preimages",
    MINIME_RECOVERY_PREIMAGE_MAX_BYTES: "1048576",
  };
}

function transcript(directory: string, sessionId: string): string {
  const path = join(directory, `2026-01-01_${sessionId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: "/agent",
  })}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.assign(child, {
    stdin,
    stdout,
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    killed: false,
    pid: 43210,
    kill: () => true,
  });
  return child;
}

describe("exact-session recovery fixer", () => {
  it("joins the supervisor-owned process group while preserving standalone fencing", () => {
    assert.equal(recoveryStartsNewPiProcessGroup({}), true);
    assert.equal(recoveryStartsNewPiProcessGroup({
      MINIME_RECOVERY_SUPERVISOR_PROCESS_GROUP: "1",
    }), false);
  });

  it("validates the closed runtime fence and passes only a credential-file path to Pi", () => {
    const contract = readRecoveryRuntimeContract(runtimeEnv());
    assert.equal(contract.mode, "enabled");
    assert.equal(contract.fence.invocationId, 7);

    const env = buildPiSpawnEnv("/agent", {
      askCallerAgentId: "recovery-fixer",
      startNewProcessGroup: true,
      recovery: {
        endpoint: contract.endpoint.origin,
        fixerCredentialFile: contract.fixerCredentialFile,
        mode: contract.mode,
        invocationId: contract.fence.invocationId,
        incidentId: contract.fence.incidentId,
        generation: contract.fence.generation,
        evidenceHash: contract.fence.evidenceHash,
        policyRevision: contract.fence.policyRevision,
        leaseToken: contract.fence.leaseToken,
        sessionDirectory: "/private/sessions/incident-4",
        piExecutable: "/usr/local/bin/pi",
        preimageDirectory: "/private/preimages",
        preimageMaxBytes: 1_048_576,
      },
    });
    assert.equal(env.MINIME_RECOVERY_FIXER_CREDENTIAL_FILE, "/private/fixer-token");
    assert.equal(env.PI_CODING_AGENT_SESSION_DIR, "/private/sessions/incident-4");
    assert.equal(Object.values(env).includes("synthetic-secret-value"), false);
    assert.equal(env.MINIME_BOT_PI_SESSION_AGENT_ID, "recovery-fixer");
  });

  it("derives one canonical owner-only JSONL and resumes the exact id/path", async () => {
    const root = mkdtempSync(join(tmpdir(), "minime-recovery-session-"));
    temporary.push(root);
    chmodSync(root, 0o700);
    const path = transcript(root, "session-exact");

    assert.deepEqual(inspectRecoveryTranscript(root, path, "session-exact"), {
      readable: true,
      reason: "ok",
      canonicalPath: realpathSync(path),
    });
    assert.equal(
      await discoverCanonicalRecoveryTranscript(root, "session-exact", 100),
      realpathSync(path),
    );
    assert.equal(inspectRecoveryTranscript(root, path, "different").readable, false);
  });

  it("degrades missing, unsafe, and invalid transcripts instead of silently replacing them", () => {
    const root = mkdtempSync(join(tmpdir(), "minime-recovery-unreadable-"));
    temporary.push(root);
    chmodSync(root, 0o700);
    assert.equal(inspectRecoveryTranscript(root, join(root, "missing.jsonl"), "s1").reason, "missing");

    const invalid = join(root, "invalid.jsonl");
    writeFileSync(invalid, "not-json\n", { mode: 0o600 });
    chmodSync(invalid, 0o600);
    assert.equal(inspectRecoveryTranscript(root, invalid, "s1").reason, "invalid");
    chmodSync(invalid, 0o644);
    assert.equal(inspectRecoveryTranscript(root, invalid, "s1").reason, "unsafe");
  });

  it("captures get_state.data.sessionId before any incident prompt", async () => {
    const child = fakeChild();
    child.stdin?.on("data", (chunk) => {
      const command = JSON.parse(chunk.toString()) as { type: string };
      assert.equal(command.type, "get_state");
      child.stdout?.push(`${JSON.stringify({
        type: "response",
        id: "recovery-session-binding",
        command: "get_state",
        success: true,
        data: { sessionId: "pi-minted-id", sessionFile: "/ignored/vendor/path.jsonl" },
      })}\n`);
    });
    const pending = captureRecoverySessionId(child, 1_000);
    setImmediate(() => child.emit("spawn"));
    assert.equal(await pending, "pi-minted-id");
  });

  it("requires both the vendor no-session classifier and unreadable host state for replacement", () => {
    const child = fakeChild();
    (child as unknown as PiStartupDiagnostics).piStartupStderr = () =>
      "No session found matching 'missing-id'";
    assert.equal(hasNoSessionFoundClassifier(child), true);
    (child as unknown as PiStartupDiagnostics).piStartupStderr = () => "provider unavailable";
    assert.equal(hasNoSessionFoundClassifier(child), false);
  });

  it("uses exact --session resume and does not reinterpret a Pi/provider outage as replacement", () => {
    const args = buildPiSpawnArgs({
      id: "recovery-fixer",
      workspaceCwd: process.cwd(),
      model: "gpt-5.5",
    }, "exact-session-id", { env: {} });
    assert.equal(args[args.indexOf("--session") + 1], "exact-session-id");
    assert.equal(args.includes("--session-dir"), false);
    assert.equal(args.includes("--no-session"), false);
    assert.equal(classifyRecoveryFixerResult({
      type: "result",
      subtype: "error_during_execution",
      result: "provider unavailable",
      session_id: "exact-session-id",
      is_error: true,
    }), "provider_error");
  });

  it("kills the full Pi process group on fence loss", async () => {
    const child = fakeChild();
    const calls: Array<[number, NodeJS.Signals]> = [];
    await terminateRecoveryProcessGroup(child, (pid, signal) => {
      calls.push([pid, signal]);
      Object.defineProperty(child, "signalCode", { value: signal, configurable: true });
      setImmediate(() => child.emit("exit", null, signal));
    });
    assert.deepEqual(calls, [[-43210, "SIGTERM"]]);
  });

  it("keeps the recovery wrapper non-default and the runner independent of chat bindings", () => {
    assert.equal(PI_EXTENSION_WRAPPER_RELPATHS.some((path) => path.includes("recovery")), false);
    assert.deepEqual(PI_RECOVERY_WRAPPER_RELPATHS, [
      "codex-transport-overflow.ts",
      "web-tools.ts",
      "knowledge-tools.ts",
    ]);
    assert.equal(PI_RECOVERY_WRAPPER_RELPATHS.some((path) => /subagent|ask-agent/.test(path)), false);
    const source = readFileSync(resolve("src/recovery/fixer-session.ts"), "utf8");
    assert.doesNotMatch(source, /new SessionManager|chatId|--no-session/);
    assert.match(source, /sendPiGetState|sendPiPrompt/);
  });

  it("verifies the pinned vendor mechanics used by the runner", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    assert.equal(manifest.dependencies["@earendil-works/pi-coding-agent"], "0.80.6");
    const vendorMain = readFileSync(
      resolve("node_modules/@earendil-works/pi-coding-agent/dist/main.js"),
      "utf8",
    );
    const vendorRpc = readFileSync(
      resolve("node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js"),
      "utf8",
    );
    assert.match(vendorMain, /PI_CODING_AGENT_SESSION_DIR|ENV_SESSION_DIR/);
    assert.match(vendorMain, /No session found matching/);
    assert.match(vendorRpc, /sessionId: session\.sessionId/);
  });

  it("validates private credentials and every fenced protocol route over loopback HTTP", async () => {
    const root = mkdtempSync(join(tmpdir(), "minime-recovery-client-"));
    temporary.push(root);
    const tokenPath = join(root, "fixer-token");
    writeFileSync(tokenPath, "synthetic-fixer-token-value\n", { mode: 0o600 });
    assert.equal(readPrivateRecoveryCredential(tokenPath), "synthetic-fixer-token-value");
    chmodSync(tokenPath, 0o644);
    assert.throws(() => readPrivateRecoveryCredential(tokenPath), /invalid/);
    chmodSync(tokenPath, 0o600);

    const requests: Array<{ path: string; authorization: string; body: Record<string, unknown> }> = [];
    let responseMode: "normal" | "invalid" | "oversized" | "timeout" = "normal";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (responseMode === "timeout") return;
        if (responseMode === "invalid") {
          response.end("not-json");
          return;
        }
        if (responseMode === "oversized") {
          response.end("x".repeat(256 * 1024 + 1));
          return;
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        requests.push({
          path: request.url ?? "",
          authorization: String(request.headers.authorization ?? ""),
          body,
        });
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify(
          request.url === "/v1/fixer/state"
            ? { mode: "enabled", evidence: [], unknownActions: [], journalDigest: "" }
            : request.url?.includes("session/")
              ? { ok: true, bindingId: 9 }
              : { ok: true },
        ));
      });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const env = runtimeEnv("enabled", `http://127.0.0.1:${address.port}`);
    env.MINIME_RECOVERY_FIXER_CREDENTIAL_FILE = tokenPath;
    env.MINIME_RECOVERY_PREIMAGE_DIRECTORY = join(root, "preimages");
    const contract = readRecoveryRuntimeContract(env);
    const client = new RecoveryProtocolClient(contract, { timeoutMs: 50 });
    const runtime = { model: "openai-codex/gpt-5.5", node: "v22.0.0", package: "1.0.0", pi: "0.80.6" };
    await client.state();
    await client.heartbeat();
    await client.bindSession({ sessionId: "s", sessionDirectory: "/s", transcriptPath: "/s/s.jsonl", runtime });
    await client.markSessionResumed(9);
    await client.replaceSession({
      previousBindingId: 9,
      sessionId: "s2",
      sessionDirectory: "/s2",
      transcriptPath: "/s2/s2.jsonl",
      startupClassifier: "no_session_found",
      journalDigest: "digest",
      runtime,
    });
    await client.intent("a", "edit", {});
    await client.outcome("a", "succeeded", {});
    await client.reconcile("a", "r", "applied", {});
    await client.guardRejected("g", "ambiguous-shell", "bash", "a".repeat(64));
    await client.quarantine("q", "/tmp/q");
    await client.restore("r", "qid");
    await client.operation("o", "restart-bot");
    await client.blocked("b", "blocked");
    await client.finish("f", { summary: "done" });
    assert.deepEqual(requests.map((item) => item.path), [
      "/v1/fixer/state",
      "/v1/fixer/heartbeat",
      "/v1/fixer/session/bind",
      "/v1/fixer/session/resumed",
      "/v1/fixer/session/replace",
      "/v1/fixer/action/intent",
      "/v1/fixer/action/outcome",
      "/v1/fixer/action/reconcile",
      "/v1/fixer/guard/rejection",
      "/v1/fixer/quarantine",
      "/v1/fixer/restore",
      "/v1/fixer/operation",
      "/v1/fixer/blocked",
      "/v1/fixer/finish",
    ]);
    assert.ok(requests.every((item) => item.authorization === "Bearer synthetic-fixer-token-value"));
    assert.ok(requests.every((item) => item.body.invocationId === 7 && item.body.leaseToken === "b".repeat(48)));

    responseMode = "invalid";
    await assert.rejects(client.state(), /invalid response/);
    responseMode = "oversized";
    await assert.rejects(client.state(), /too large/);
    responseMode = "timeout";
    await assert.rejects(client.state(), /timed out/);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  });

  it("runs the bind-before-prompt fixer flow with the recovery-only wrapper set", async () => {
    const root = mkdtempSync(join(tmpdir(), "minime-recovery-runner-"));
    temporary.push(root);
    const agentWorkspace = join(root, "agent");
    const sessionRoot = join(root, "sessions");
    mkdirSync(agentWorkspace, { recursive: true });
    mkdirSync(sessionRoot, { recursive: true, mode: 0o700 });
    chmodSync(sessionRoot, 0o700);
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, [
      "agents:",
      "  recovery-fixer:",
      `    workspaceCwd: ${JSON.stringify(agentWorkspace)}`,
      "    model: gpt-5.5",
      "  chat-agent:",
      `    workspaceCwd: ${JSON.stringify(agentWorkspace)}`,
      "    model: gpt-5.5",
      "telegramTokenEnv: MINIME_TEST_RECOVERY_TELEGRAM_TOKEN",
      "bindings:",
      "  - chatId: 111",
      "    agentId: chat-agent",
      "    kind: dm",
      "",
    ].join("\n"));
    const env: NodeJS.ProcessEnv = {
      ...runtimeEnv("enabled"),
      MINIME_CONFIG_PATH: configPath,
      MINIME_CONTROL_WORKSPACE_ROOT: root,
      MINIME_RECOVERY_AGENT_ID: "recovery-fixer",
      MINIME_RECOVERY_SESSION_ROOT: sessionRoot,
      MINIME_RECOVERY_STARTUP_TIMEOUT_SECONDS: "1",
      MINIME_RECOVERY_RESUME_TIMEOUT_SECONDS: "2",
      MINIME_RECOVERY_RENEW_SECONDS: "10",
      MINIME_RECOVERY_RUN_TIMEOUT_SECONDS: "10",
      MINIME_RECOVERY_PI_EXECUTABLE: "/usr/local/bin/pi",
      MINIME_RECOVERY_SUPERVISOR_PROCESS_GROUP: "1",
      MINIME_RECOVERY_PREIMAGE_DIRECTORY: join(root, "preimages"),
    };
    const order: string[] = [];
    let heartbeatCount = 0;
    let boundRuntime: Record<string, unknown> | undefined;
    const client = {
      contract: readRecoveryRuntimeContract(env),
      state: async () => ({ mode: "enabled", evidence: [], unknownActions: [], journalDigest: "" }),
      bindSession: async (binding: { runtime: Record<string, unknown> }) => {
        order.push("bind");
        boundRuntime = binding.runtime;
        return 11;
      },
      heartbeat: async () => {
        heartbeatCount += 1;
        return true;
      },
    } as unknown as RecoveryProtocolClient;
    const spawn = ((_agent: unknown, _session: unknown, extensions: { relpaths?: readonly string[] }, runtime: {
      recovery?: { sessionDirectory: string; piExecutable: string };
      startNewProcessGroup?: boolean;
    }) => {
      assert.deepEqual(extensions.relpaths, PI_RECOVERY_WRAPPER_RELPATHS);
      assert.equal(runtime.recovery?.piExecutable, "/usr/local/bin/pi");
      assert.equal(runtime.startNewProcessGroup, false);
      const child = fakeChild();
      child.kill = ((signal?: NodeJS.Signals) => {
        Object.defineProperty(child, "signalCode", { value: signal ?? "SIGTERM", configurable: true });
        setImmediate(() => child.emit("exit", null, signal));
        return true;
      }) as ChildProcess["kill"];
      child.stdin?.on("data", (chunk) => {
        const command = JSON.parse(chunk.toString()) as { type: string; id?: string };
        if (command.type === "get_state") {
          if (command.id !== "recovery-session-binding") return;
          order.push("get_state");
          const sessionId = "bound-session";
          setTimeout(() => {
            transcript(runtime.recovery?.sessionDirectory ?? "", sessionId);
            child.stdout?.push(`${JSON.stringify({
              type: "response",
              id: command.id,
              command: "get_state",
              success: true,
              data: { sessionId },
            })}\n`);
          }, 25);
        } else if (command.type === "prompt") {
          order.push("prompt");
          child.stdout?.push(`${JSON.stringify({
            type: "response",
            command: "prompt",
            success: true,
            id: command.id,
          })}\n`);
          child.stdout?.push(`${JSON.stringify({ type: "agent_start" })}\n`);
          child.stdout?.push(`${JSON.stringify({
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
          })}\n`);
          child.stdout?.push(`${JSON.stringify({ type: "agent_settled" })}\n`);
        }
      });
      setImmediate(() => child.emit("spawn"));
      return child;
    }) as never;
    const previousToken = process.env.MINIME_TEST_RECOVERY_TELEGRAM_TOKEN;
    process.env.MINIME_TEST_RECOVERY_TELEGRAM_TOKEN = "synthetic-test-token";
    const result = await (async () => {
      try {
        return await runRecoveryFixer({
          env,
          client,
          spawn,
          startupTimeoutMs: 1_000,
          renewMs: 5,
        });
      } finally {
        if (previousToken === undefined) delete process.env.MINIME_TEST_RECOVERY_TELEGRAM_TOKEN;
        else process.env.MINIME_TEST_RECOVERY_TELEGRAM_TOKEN = previousToken;
      }
    })();
    assert.equal(result.status, "settled");
    assert.deepEqual(order, ["get_state", "bind", "prompt"]);
    assert.ok(heartbeatCount > 0, "the lease must renew while session binding is pending");
    assert.equal(boundRuntime?.model, "openai-codex/gpt-5.5");
    assert.equal(boundRuntime?.pi, "0.80.6");
  });
});

describe("recovery action journaling", () => {
  it("permits conservative inspection while classifying writes and unknown tools as mutations", () => {
    assert.equal(isReadOnlyRecoveryBash("git status --short && rg error logs"), true);
    assert.equal(isReadOnlyRecoveryBash("cat config.yaml | head -20"), true);
    assert.equal(isReadOnlyRecoveryBash("git commit -am repair"), false);
    assert.equal(isReadOnlyRecoveryBash("printf secret > config.yaml"), false);
    assert.equal(isReadOnlyRecoveryBash("cat config.yaml\nrm config.yaml"), false);
    assert.equal(isReadOnlyRecoveryBash("cat config.yaml & rm config.yaml"), false);
    assert.equal(isReadOnlyRecoveryBash("cat <(rm config.yaml)"), false);
    assert.equal(isReadOnlyRecoveryBash("find . $RECOVERY_FIND_FLAGS"), false);

    const summary = summarizeRecoveryIntent({
      toolName: "bash",
      input: {
        command: "write-sensitive-value",
        path: "/private/identity/config.yaml",
        token: "must-not-persist",
      },
    } as unknown as ToolCallEvent);
    assert.equal(JSON.stringify(summary).includes("must-not-persist"), false);
    assert.equal(JSON.stringify(summary).includes("write-sensitive-value"), false);
    assert.equal(JSON.stringify(summary).includes("/private/identity"), false);
    assert.equal(typeof summary.commandSha256, "string");
  });

  it("blocks diagnose mutations and journals enabled intent before outcome", async () => {
    const calls: string[] = [];
    const fakeClient = {
      contract: readRecoveryRuntimeContract(runtimeEnv("enabled")),
      intent: async () => { calls.push("intent"); return true; },
      outcome: async () => { calls.push("outcome"); return true; },
    } as unknown as RecoveryProtocolClient;
    const enabled = new RecoveryToolJournal(fakeClient, "enabled");
    const call = {
      type: "tool_call",
      toolCallId: "tool-1",
      toolName: "edit",
      input: { path: "/agent/config.yaml", oldText: "a", newText: "b" },
    } as ToolCallEvent;
    assert.equal(await enabled.before(call), undefined);
    assert.deepEqual(calls, ["intent"]);
    await enabled.after({
      type: "tool_result",
      toolCallId: "tool-1",
      toolName: "edit",
      input: call.input,
      content: [{ type: "text", text: "done" }],
      details: undefined,
      isError: false,
    } as ToolResultEvent);
    assert.deepEqual(calls, ["intent", "outcome"]);

    const diagnose = new RecoveryToolJournal(fakeClient, "diagnose");
    assert.match((await diagnose.before(call))?.reason ?? "", /diagnose/);
    assert.deepEqual(calls, ["intent", "outcome"]);
  });

  it("captures a bounded owner-only preimage before accepting edit intent", async () => {
    const root = mkdtempSync(join(tmpdir(), "minime-recovery-preimage-"));
    temporary.push(root);
    const target = join(root, "config.yaml");
    const preimages = join(root, "preimages");
    writeFileSync(target, "before\n", { mode: 0o600 });
    const env = runtimeEnv("enabled");
    env.MINIME_RECOVERY_PREIMAGE_DIRECTORY = preimages;
    env.MINIME_RECOVERY_PREIMAGE_MAX_BYTES = "64";
    let intent: Record<string, unknown> | undefined;
    const fakeClient = {
      contract: readRecoveryRuntimeContract(env),
      intent: async (_key: string, _tool: string, value: Record<string, unknown>) => {
        intent = value;
        return true;
      },
    } as unknown as RecoveryProtocolClient;
    const journal = new RecoveryToolJournal(fakeClient, "enabled");
    assert.equal(await journal.before({
      type: "tool_call",
      toolCallId: "preimage-1",
      toolName: "edit",
      input: { path: target, oldText: "before", newText: "after" },
    } as ToolCallEvent), undefined);
    const preimage = intent?.preimage as Record<string, unknown>;
    assert.equal(preimage.state, "captured");
    assert.equal(readFileSync(String(preimage.reference), "utf8"), "before\n");
    assert.equal(lstatSync(String(preimage.reference)).mode & 0o077, 0);

    env.MINIME_RECOVERY_PREIMAGE_MAX_BYTES = "1";
    const blocked = new RecoveryToolJournal({
      ...fakeClient,
      contract: readRecoveryRuntimeContract(env),
    } as RecoveryProtocolClient, "enabled");
    assert.match((await blocked.before({
      type: "tool_call",
      toolCallId: "preimage-2",
      toolName: "write",
      input: { path: target, content: "after" },
    } as ToolCallEvent))?.reason ?? "", /not durably journaled/);
  });

  it("blocks and audits every trusted-agent forbidden action category", async () => {
    const fixtures: Array<[string, string]> = [
      ["sudo launchctl kickstart gui/501/example", "privilege-escalation"],
      ["rm -rf cache", "irreversible-deletion"],
      ["git push origin repair", "external-mutation"],
      ["curl -X POST https://example.invalid", "external-mutation"],
      ["npm install package", "package-or-image-download"],
      ["docker image prune -a", "prune-or-volume"],
      ["docker volume rm data", "prune-or-volume"],
      ["docker restart minime", "supervisor-owned-operation"],
      ["security find-generic-password -s bot", "secret-operation"],
      ["cat ~/.ssh/*", "secret-operation"],
      ["sed -n 1p ~/.aws/credentials", "secret-operation"],
      ["find ~/.gnupg -type f", "secret-operation"],
      ["cat ~/.config/gcloud/application_default_credentials.json", "secret-operation"],
      ["telegram getUpdates", "competing-polling"],
      ["printf value > config.yaml", "ambiguous-shell"],
      ["bash -lc 'rm -rf cache'", "ambiguous-shell"],
      ["sh -c 'sudo true'", "ambiguous-shell"],
      ["node -e 'process.exit()'", "ambiguous-shell"],
      ["git -c alias.x='!sudo true' x", "ambiguous-shell"],
      ["git fetch origin", "external-mutation"],
      ["git clone https://example.invalid/repo", "external-mutation"],
    ];
    for (const [command, category] of fixtures) {
      assert.equal(forbiddenRecoveryBashReason(command), category, command);
    }
    assert.equal(forbiddenRecoveryBashReason("git commit -am repair"), undefined);
    assert.equal(forbiddenRecoveryBashReason("launchctl print gui/501/example"), undefined);
    assert.equal(forbiddenRecoveryToolReason({
      toolName: "edit",
      input: { path: "/agent/config.yaml" },
    } as unknown as ToolCallEvent), undefined);
    assert.equal(forbiddenRecoveryToolReason({
      toolName: "web_search",
      input: { query: "service failure signature" },
    } as unknown as ToolCallEvent), undefined);
    assert.equal(forbiddenRecoveryToolReason({
      toolName: "read",
      input: { path: "/agent/recovery-auth-token" },
    } as unknown as ToolCallEvent), "secret-operation");
    for (const path of [
      "/Users/example/.ssh/id_ed25519",
      "/Users/example/.aws/credentials",
      "/Users/example/.kube/config",
      "/Users/example/.docker/config.json",
    ]) {
      assert.equal(forbiddenRecoveryToolReason({
        toolName: "read",
        input: { path },
      } as unknown as ToolCallEvent), "secret-operation", path);
    }

    const calls: string[] = [];
    const fakeClient = {
      contract: readRecoveryRuntimeContract(runtimeEnv("enabled")),
      guardRejected: async (_key: string, category: string) => {
        calls.push(`guard:${category}`);
        return true;
      },
      intent: async () => { calls.push("intent"); return true; },
    } as unknown as RecoveryProtocolClient;
    const journal = new RecoveryToolJournal(fakeClient, "enabled");
    const blocked = await journal.before({
      type: "tool_call",
      toolCallId: "forbidden-1",
      toolName: "bash",
      input: { command: "git push origin repair" },
    } as ToolCallEvent);
    assert.match(blocked?.reason ?? "", /external-mutation/);
    assert.deepEqual(calls, ["guard:external-mutation"]);
  });

  it("exposes reviewed operations by ID without argv, shell, or path policy", () => {
    const source = readFileSync(resolve("extensions/pi/recovery.ts"), "utf8");
    const start = source.indexOf('name: "recovery_operation"');
    const end = source.indexOf("pi.registerTool", start + 1);
    assert.ok(start >= 0 && end > start);
    const definition = source.slice(start, end);
    const parameterStart = definition.indexOf("parameters: Type.Object");
    const parameterEnd = definition.indexOf("execute:", parameterStart);
    const parameters = definition.slice(parameterStart, parameterEnd);
    assert.match(parameters, /operationId/);
    assert.doesNotMatch(parameters, /\bargv\b|\bshell\b|\bsourcePath\b|\btargetPath\b/);
  });
});

describe("recovery extension behavior", () => {
  it("executes every registered protocol tool and blocks the user-bash side channel", async () => {
    const extensionModule = await import(
      pathToFileURL(resolve("extensions/pi/recovery.ts")).href
    ) as {
      registerRecoveryExtension: (
        pi: ExtensionAPI,
        contract: ReturnType<typeof readRecoveryRuntimeContract>,
        client: RecoveryProtocolClient,
      ) => void;
    };
    const { registerRecoveryExtension } = extensionModule;
    const root = mkdtempSync(join(tmpdir(), "minime-recovery-extension-"));
    temporary.push(root);
    const env = runtimeEnv("enabled");
    env.MINIME_RECOVERY_PREIMAGE_DIRECTORY = join(root, "preimages");
    const contract = readRecoveryRuntimeContract(env);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const registered = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    const pi = {
      on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        registered.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI;
    const calls: string[] = [];
    const response = { ok: true, status: 200, body: { ok: true } };
    const client = {
      contract,
      state: async () => { calls.push("state"); return { mode: "enabled" }; },
      heartbeat: async () => { calls.push("heartbeat"); return true; },
      reconcile: async () => { calls.push("reconcile"); return true; },
      quarantine: async () => { calls.push("quarantine"); return response; },
      restore: async () => { calls.push("restore"); return response; },
      operation: async () => { calls.push("operation"); return response; },
      blocked: async () => { calls.push("blocked"); return true; },
      finish: async () => { calls.push("finish"); return true; },
      intent: async () => { calls.push("intent"); return true; },
      outcome: async () => { calls.push("outcome"); return true; },
    } as unknown as RecoveryProtocolClient;
    registerRecoveryExtension(pi, contract, client);
    assert.deepEqual([...registered.keys()].sort(), [
      "recovery_blocked",
      "recovery_finish",
      "recovery_heartbeat",
      "recovery_inspect",
      "recovery_operation",
      "recovery_quarantine",
      "recovery_reconcile",
      "recovery_restore",
    ]);
    const execute = async (name: string, params: Record<string, unknown> = {}) => {
      const tool = registered.get(name);
      assert.ok(tool);
      return tool.execute("tool-call", params);
    };
    await execute("recovery_inspect");
    await execute("recovery_heartbeat");
    await execute("recovery_reconcile", {
      actionKey: "a", idempotencyKey: "r", result: "applied", summary: "checked",
    });
    await execute("recovery_quarantine", { idempotencyKey: "q", sourcePath: "/tmp/q" });
    await execute("recovery_restore", { idempotencyKey: "r", quarantineId: "qid" });
    await execute("recovery_operation", { idempotencyKey: "o", operationId: "restart-bot" });
    await execute("recovery_blocked", { claimKey: "b", reason: "blocked" });
    await execute("recovery_finish", {
      claimKey: "f",
      summary: "done",
      rootCause: "cause",
      confidence: "high",
      changedFiles: [],
      changedServices: [],
      verification: [],
      residualRisk: "none",
      references: [],
    });
    assert.deepEqual(calls.slice(0, 8), [
      "state", "heartbeat", "reconcile", "quarantine", "restore", "operation", "blocked", "finish",
    ]);
    const userBash = handlers.get("user_bash");
    assert.ok(userBash);
    assert.equal(userBash({ command: "git status" }), undefined);
    assert.match(JSON.stringify(userBash({ command: "rm -rf cache" })), /irreversible-deletion/);
    const toolCall = handlers.get("tool_call");
    const toolResult = handlers.get("tool_result");
    assert.ok(toolCall && toolResult);
    assert.equal(await toolCall({
      type: "tool_call",
      toolCallId: "mutation",
      toolName: "write",
      input: { path: join(root, "new-file"), content: "new" },
    }), undefined);
    await toolResult({
      type: "tool_result",
      toolCallId: "mutation",
      toolName: "write",
      input: {},
      content: [],
      details: undefined,
      isError: false,
    });
    assert.deepEqual(calls.slice(-2), ["intent", "outcome"]);

    const diagnoseContract = readRecoveryRuntimeContract({
      ...env,
      MINIME_RECOVERY_MODE: "diagnose",
    });
    const diagnoseTools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
    registerRecoveryExtension({
      on: () => undefined,
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
        diagnoseTools.set(tool.name, tool);
      },
    } as unknown as ExtensionAPI, diagnoseContract, client);
    const diagnosed = await diagnoseTools.get("recovery_quarantine")?.execute(
      "tool-call",
      { idempotencyKey: "q", sourcePath: "/tmp/q" },
    );
    assert.match(JSON.stringify(diagnosed), /diagnose mode/);
  });
});
