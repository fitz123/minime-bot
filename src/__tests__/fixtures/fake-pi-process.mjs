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
import {
  attestOpsWorkerPiParity,
  readExpectedOpsWorkerParityContract,
  writeOpsWorkerParityReport,
} from "../../pi-extensions/ops-worker-parity-attestation.js";
import { captureCodexQuotaFromHeaders } from "../../pi-extensions/codex-usage.js";

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
const parityReport = attestOpsWorkerPiParity(parityExpected, {
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
  activeToolNames: selectedTools,
  allTools: selectedTools.map((name) => ({
    name,
    sourceInfo: sourceInfo(`<builtin:${name}>`),
  })),
  commands: flagValues("--extension").map((path, index) => ({
    name: `fake-extension-marker-${index}`,
    source: "extension",
    sourceInfo: sourceInfo(path),
  })),
});
writeOpsWorkerParityReport(parityReportPath, parityReport);
if (parityReport.status !== "PASS") process.exit(78);
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

switch (scenario) {
  case "success":
    process.stdout.write("fake Pi success claim\n");
    break;
  case "success-diagnostic":
    process.stdout.write("Investigated a prior HTTP 429 and maximum context length message successfully.\n");
    break;
  case "crash":
    process.stderr.write("fake Pi crashed\n");
    process.exitCode = 2;
    break;
  case "quota":
    captureCodexQuotaFromHeaders({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 3_600),
    });
    process.stderr.write("HTTP 429 rate limit quota exhausted\n");
    process.exitCode = 1;
    break;
  case "quota-probe-success":
    captureCodexQuotaFromHeaders({
      "x-codex-primary-used-percent": "10",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 18_000),
    });
    process.stdout.write("OK\n");
    break;
  case "quota-probe-quota":
    captureCodexQuotaFromHeaders({
      "x-codex-primary-used-percent": "100",
      "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1_000) + 3_600),
    });
    process.stderr.write("HTTP 429 quota smoke probe rate limit\n");
    process.exitCode = 1;
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
