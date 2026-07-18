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

const [scenario, ...args] = process.argv.slice(2);
let privatePrompt = "";
for await (const chunk of process.stdin) privatePrompt += chunk.toString();
if (!privatePrompt.includes("Ops worker objective:")) {
  process.stderr.write("fake Pi requires its private prompt on stdin\n");
  process.exit(64);
}

function flagValue(flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

const sessionDirectory = flagValue("--session-dir");
const createdSessionId = flagValue("--session-id");
const resumedSessionId = flagValue("--session");
const sessionId = createdSessionId ?? resumedSessionId;

if (!sessionDirectory || !sessionId) {
  process.stderr.write("fake Pi requires ordinary session flags\n");
  process.exit(64);
}

mkdirSync(sessionDirectory, { recursive: true });
let sessionFile;
for (const file of readdirSync(sessionDirectory)) {
  if (file.endsWith(".jsonl") && file.includes(sessionId)) {
    sessionFile = join(sessionDirectory, file);
    break;
  }
}

if (resumedSessionId) {
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

if (!sessionFile) {
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

if (existsSync(sessionFile)) {
  appendFileSync(sessionFile, `${JSON.stringify({
    type: "message",
    id: "fixture-message",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "fixture attempt" },
  })}\n`, "utf8");
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
    process.stderr.write("HTTP 429 rate limit quota exhausted\n");
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
