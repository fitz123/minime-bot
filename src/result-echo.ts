import { chmodSync, lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveWorkspaceContract } from "./workspace-contract.js";

/** Same passive-context spool as deliver.sh; echo failure must not resend a post. */
export function writeResultEcho(chatId: number, threadId: number | undefined, text: string, origin = "cron-runner"): void {
  try {
    const base = resolveWorkspaceContract().paths.echoDir;
    const dir = join(base, String(chatId));
    for (const path of [base, dir]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      if (lstatSync(path).isSymbolicLink()) return;
      chmodSync(path, 0o700);
    }
    const name = `${Date.now()}-${process.pid}-${randomUUID()}.json`;
    const temp = join(dir, `.${name}.tmp`);
    writeFileSync(temp, JSON.stringify({
      chatId: String(chatId), threadId: threadId == null ? null : String(threadId),
      text, origin, timestamp: Math.floor(Date.now() / 1000),
    }), { mode: 0o600 });
    renameSync(temp, join(dir, name));
  } catch {
    // Echo is best-effort, just as for ordinary service delivery.
  }
}

