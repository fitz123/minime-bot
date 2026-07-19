import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readExpectedOpsWorkerParityContract } from "../../pi-extensions/ops-worker-parity-attestation.js";

const [scenario, ...args] = process.argv.slice(2);
const quotaProbe = scenario.startsWith("quota-probe-");
let privatePrompt = "";
for await (const chunk of process.stdin) privatePrompt += chunk.toString();
if (
  (!quotaProbe && !privatePrompt.includes("Ops worker objective:"))
  || (quotaProbe && !privatePrompt.includes("bounded quota smoke probe"))
) {
  process.stderr.write("fake Pi requires its private prompt on stdin\n");
  process.exit(64);
}
if (process.env.MINIME_TEST_PRIVATE_PROMPT_PATH) {
  writeFileSync(process.env.MINIME_TEST_PRIVATE_PROMPT_PATH, privatePrompt, "utf8");
}

function flagValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function flagValues(flag) {
  return args.flatMap((arg, index) => arg === flag ? [args[index + 1]] : []);
}

function promptInput(value) {
  return value && existsSync(value) ? readFileSync(value, "utf8") : value;
}

const sessionDirectory = flagValue("--session-dir");
const createdSessionId = flagValue("--session-id");
const resumedSessionId = flagValue("--session");
const sessionId = createdSessionId ?? resumedSessionId;

if (!quotaProbe && (!sessionDirectory || !sessionId)) {
  process.stderr.write("fake Pi requires ordinary session flags\n");
  process.exit(64);
}

if (quotaProbe && !args.includes("--no-session")) {
  process.stderr.write("fake Pi quota probe requires --no-session\n");
  process.exit(64);
}

if (sessionDirectory) mkdirSync(sessionDirectory, { recursive: true });
let sessionFile;
for (const file of sessionDirectory ? readdirSync(sessionDirectory) : []) {
  if (file.endsWith(".jsonl") && file.includes(sessionId)) {
    sessionFile = join(sessionDirectory, file);
    break;
  }
}

if (!quotaProbe && resumedSessionId) {
  if (!sessionFile) {
    process.stderr.write(`No session found matching '${sessionId}'\n`);
    process.exit(1);
  }
  try {
    const firstLine = readFileSync(sessionFile, "utf8").split("\n")[0];
    const header = JSON.parse(firstLine);
    if (header.type !== "session" || header.id !== sessionId) throw new Error();
  } catch {
    process.stderr.write("Session file is not a valid pi session\n");
    process.exit(1);
  }
}

if (!quotaProbe && !sessionFile) {
  const timestamp = new Date().toISOString();
  sessionFile = join(
    sessionDirectory,
    `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`,
  );
  writeFileSync(sessionFile, `${JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp,
    cwd: process.cwd(),
  })}\n`, "utf8");
}

if (sessionFile && existsSync(sessionFile)) {
  appendFileSync(sessionFile, `${JSON.stringify({
    type: "message",
    id: "fixture-message",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "fixture attempt" },
  })}\n`, "utf8");
}

const parityExpectedPath = process.env.MINIME_OPS_WORKER_PARITY_EXPECTED_PATH;
const parityReportPath = process.env.MINIME_OPS_WORKER_PARITY_REPORT_PATH;
const parityAckPath = process.env.MINIME_OPS_WORKER_PARITY_ACK_PATH;
if (!parityExpectedPath || !parityReportPath || !parityAckPath) {
  process.stderr.write("fake Pi requires the parity handshake contract\n");
  process.exit(64);
}
const parityExpected = readExpectedOpsWorkerParityContract(parityExpectedPath);
const customPromptValue = flagValue("--system-prompt");
const selectedTools = (flagValue("--tools") ?? "").split(",").filter(Boolean);
if (scenario === "parity-mismatch") selectedTools.pop();
const sourceInfo = (path) => ({
  path,
  source: "temporary",
  scope: "temporary",
  origin: "top-level",
});
const extensionPaths = flagValues("--extension");
const parityExtensionPath = extensionPaths.at(-1);
if (!parityExtensionPath) process.exit(64);
const commands = [];
for (const path of extensionPaths.slice(0, -1)) {
  const wrapperSource = readFileSync(path, "utf8");
  const marker = /minime-ops-extension-[a-f0-9]{64}/.exec(wrapperSource)?.[0];
  if (!marker) process.exit(64);
  commands.push({ name: marker, source: "extension", sourceInfo: sourceInfo(path) });
}
const handlers = new Map();
const allTools = selectedTools.map((name) => ({
  name,
  sourceInfo: sourceInfo(`<builtin:${name}>`),
}));
const pi = {
  registerCommand(name) {
    commands.push({ name, source: "extension", sourceInfo: sourceInfo(parityExtensionPath) });
  },
  on(event, handler) {
    const current = handlers.get(event) ?? [];
    current.push(handler);
    handlers.set(event, current);
  },
  getActiveTools: () => selectedTools,
  getAllTools: () => allTools,
  getCommands: () => commands,
};
const parityExtension = (await import(
  `${pathToFileURL(parityExtensionPath).href}?fake=${Date.now()}`
)).default;
await parityExtension(pi);
const effectiveSystemPrompt = "fake effective system prompt";
for (const handler of handlers.get("session_start") ?? []) {
  await handler({}, { getSystemPrompt: () => effectiveSystemPrompt });
}
const beforeEvent = {
  systemPrompt: effectiveSystemPrompt,
  systemPromptOptions: {
    cwd: process.cwd(),
    customPrompt: customPromptValue === undefined
      ? undefined
      : promptInput(customPromptValue),
    appendSystemPrompt: flagValues("--append-system-prompt")
      .map(promptInput)
      .join("\n\n"),
    contextFiles: args.includes("--no-context-files")
      ? []
      : [{ path: "AGENTS.md", content: "fake ambient duplicate" }],
    skills: flagValues("--skill").map((filePath) => ({ filePath })),
  },
};
for (const handler of handlers.get("before_agent_start") ?? []) {
  await handler(beforeEvent, {});
}
const parityDeadline = Date.now() + 5_000;
while (Date.now() < parityDeadline) {
  if (
    existsSync(parityAckPath)
    && readFileSync(parityAckPath, "utf8").trim() === parityExpected.digest
  ) break;
  await new Promise((resolveWait) => setTimeout(resolveWait, 10));
}
if (
  !existsSync(parityAckPath)
  || readFileSync(parityAckPath, "utf8").trim() !== parityExpected.digest
) {
  process.stderr.write("fake Pi parity acknowledgement timed out\n");
  process.exit(78);
}

for (const handler of handlers.get("tool_call") ?? []) {
  const decision = await handler({ name: "fixture-tool" }, {});
  if (quotaProbe ? decision?.block !== true : decision !== undefined) {
    process.stderr.write("fake Pi quota probe tool gate mismatch\n");
    process.exit(78);
  }
}

async function emitProviderResponse(status, headers) {
  for (const handler of handlers.get("after_provider_response") ?? []) {
    await handler({ status, headers }, {});
  }
}

switch (scenario) {
  case "success":
    await emitProviderResponse(200, {});
    process.stdout.write("fake Pi success claim\n");
    break;
  case "success-diagnostic":
    await emitProviderResponse(200, {});
    process.stdout.write("Investigated a prior HTTP 429 and maximum context length message successfully.\n");
    break;
  case "success-missing-telemetry":
    process.stdout.write("fake Pi exited without response telemetry\n");
    break;
  case "success-stale-telemetry":
    await emitProviderResponse(200, {});
    for (const handler of handlers.get("after_provider_response") ?? []) {
      await handler({ headers: {} }, {});
    }
    process.stdout.write("fake Pi should not survive invalid final telemetry\n");
    break;
  case "crash":
    process.stderr.write("fake Pi crashed\n");
    process.exitCode = 2;
    break;
  case "quota":
    await emitProviderResponse(429, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 3_600),
    });
    process.stderr.write("fake Pi provider request rejected\n");
    process.exitCode = 1;
    break;
  case "quota-clean-exit":
    await emitProviderResponse(429, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 3_600),
    });
    process.stdout.write("fake Pi handled a provider rejection\n");
    break;
  case "quota-stale-telemetry":
    await emitProviderResponse(429, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 3_600),
    });
    for (const handler of handlers.get("after_provider_response") ?? []) {
      await handler({ headers: {} }, {});
    }
    process.stdout.write("fake Pi should not reuse stale quota telemetry\n");
    break;
  case "server-error-clean-exit":
    await emitProviderResponse(503, {});
    process.stdout.write("fake Pi handled a provider server error\n");
    break;
  case "quota-probe-success":
    await emitProviderResponse(200, {
      "x-codex-primary-used-percent": "10",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 18_000),
    });
    process.stdout.write("OK\n");
    break;
  case "quota-probe-success-no-quota-headers":
    await emitProviderResponse(200, {});
    process.stdout.write("OK\n");
    break;
  case "quota-probe-quota":
    await emitProviderResponse(429, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 3_600),
    });
    process.stderr.write("fake Pi quota probe provider request rejected\n");
    process.exitCode = 1;
    break;
  case "quota-probe-quota-clean-exit":
    await emitProviderResponse(429, {
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 3_600),
    });
    process.stdout.write("fake Pi handled a quota probe rejection\n");
    break;
  case "quota-probe-server-error":
    await emitProviderResponse(503, {
      "x-codex-primary-used-percent": "10",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 18_000),
    });
    process.stdout.write("fake Pi handled a provider server error\n");
    break;
  case "quota-probe-wait":
    setInterval(() => undefined, 1_000);
    break;
  case "network":
    process.stderr.write("fetch failed: ECONNRESET network error\n");
    process.exitCode = 1;
    break;
  case "context":
    process.stderr.write("context_length_exceeded: maximum context length\n");
    process.exitCode = 1;
    break;
  case "large-output":
    process.stderr.write("x".repeat(96 * 1024));
    process.exitCode = 2;
    break;
  case "wait":
    setInterval(() => undefined, 1_000);
    break;
  case "leader-exits-child-survives": {
    const descendant = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    setTimeout(() => {
      process.stdout.write(`descendant-ready:${String(descendant.pid)}\n`);
    }, 50);
    setInterval(() => undefined, 1_000);
    break;
  }
  default:
    process.stderr.write(`unknown fake Pi scenario ${String(scenario)}\n`);
    process.exitCode = 64;
}
