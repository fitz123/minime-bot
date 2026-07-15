import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { ToolCallEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
  PI_EXTENSION_WRAPPER_RELPATHS,
  buildPiSpawnArgs,
  buildPiSpawnEnv,
  type PiStartupDiagnostics,
} from "../pi-rpc-protocol.js";
import {
  RecoveryProtocolClient,
  RecoveryToolJournal,
  isReadOnlyRecoveryBash,
  readRecoveryRuntimeContract,
  summarizeRecoveryIntent,
} from "../pi-extensions/recovery-protocol.js";
import {
  captureRecoverySessionId,
  classifyRecoveryFixerResult,
  discoverCanonicalRecoveryTranscript,
  hasNoSessionFoundClassifier,
  inspectRecoveryTranscript,
  terminateRecoveryProcessGroup,
} from "../recovery/fixer-session.js";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function runtimeEnv(mode: "diagnose" | "enabled" = "enabled"): NodeJS.ProcessEnv {
  return {
    MINIME_RECOVERY_ENDPOINT: "http://127.0.0.1:9877",
    MINIME_RECOVERY_FIXER_CREDENTIAL_FILE: "/private/fixer-token",
    MINIME_RECOVERY_MODE: mode,
    MINIME_RECOVERY_INVOCATION_ID: "7",
    MINIME_RECOVERY_INCIDENT_ID: "4",
    MINIME_RECOVERY_GENERATION: "3",
    MINIME_RECOVERY_EVIDENCE_HASH: "a".repeat(64),
    MINIME_RECOVERY_POLICY_REVISION: "2",
    MINIME_RECOVERY_LEASE_TOKEN: "b".repeat(48),
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
});
