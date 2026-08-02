import { SessionManager } from "@earendil-works/pi-coding-agent";

const [mode, sessionFile, sessionDirectory, workspace] = process.argv.slice(2);

if (!mode || !sessionFile || !sessionDirectory || !workspace) {
  throw new Error("usage: pi-session-round-trip.mjs <write|resume> <session-file> <session-dir> <workspace>");
}

const session = SessionManager.open(sessionFile, sessionDirectory, workspace);

if (mode === "write") {
  if (session.getEntries().length !== 0) {
    throw new Error("round-trip write requires a pre-seeded transcript with no entries");
  }

  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
  session.appendMessage({
    role: "user",
    content: "first offline turn",
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "first offline reply" }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "user",
    content: "second offline turn",
    timestamp: Date.now(),
  });
  session.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "second offline reply" }],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  });
} else if (mode !== "resume") {
  throw new Error(`unsupported round-trip mode: ${mode}`);
}

process.stdout.write(`${JSON.stringify({
  sessionId: session.getSessionId(),
  sessionFile: session.getSessionFile(),
  cwd: session.getCwd(),
  entries: session.getEntries(),
})}\n`);
