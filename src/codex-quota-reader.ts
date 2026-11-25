import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { parseCodexQuotaUsage, type CodexQuotaSnapshot } from "./pi-extensions/codex-usage.js";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export type QuotaReadFailure = "timeout" | "auth_unavailable" | "auth_failed" | "account_missing" | "request_failed" | "http_error" | "invalid_response";
export class CodexQuotaReadError extends Error {
  constructor(public readonly code: QuotaReadFailure) { super(code); }
}

export interface QuotaAuthRuntime {
  getAuth(provider: string, options: { signal: AbortSignal }): Promise<{
    source?: string; auth: { apiKey?: string };
  } | undefined>;
}
export interface CodexQuotaReaderOptions {
  timeoutMs?: number;
  now?: Date;
  createRuntime?: (options: { modelsPath: null; refreshOnCreate: false; allowModelNetwork: false; signal: AbortSignal }) => Promise<QuotaAuthRuntime>;
  fetch?: typeof globalThis.fetch;
}

/** The deadline covers runtime creation, OAuth resolution, GET and body consumption. */
export async function readCodexQuota(options: CodexQuotaReaderOptions = {}): Promise<CodexQuotaSnapshot> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CodexQuotaReadError("timeout"));
    }, options.timeoutMs ?? 3_000);
  });
  const acquire = async () => {
    const signal = controller.signal;
    let runtime: QuotaAuthRuntime;
    let resolved: Awaited<ReturnType<QuotaAuthRuntime["getAuth"]>>;
    try {
      runtime = await (options.createRuntime ?? ModelRuntime.create)({
        modelsPath: null, refreshOnCreate: false, allowModelNetwork: false, signal,
      });
      signal.throwIfAborted();
      resolved = await runtime.getAuth("openai-codex", { signal });
      signal.throwIfAborted();
    } catch { throw new CodexQuotaReadError("auth_failed"); }
    if (resolved?.source !== "OAuth" || !resolved.auth.apiKey) throw new CodexQuotaReadError("auth_unavailable");
    const token = resolved.auth.apiKey;
    let account: unknown;
    try {
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
      account = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    } catch { /* Invalid JWT is classified without including token material. */ }
    if (typeof account !== "string" || !account.trim()) throw new CodexQuotaReadError("account_missing");
    let response: Response;
    try {
      signal.throwIfAborted();
      response = await (options.fetch ?? globalThis.fetch)(CODEX_USAGE_URL, {
        method: "GET", headers: { Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account }, signal,
        redirect: "error",
      });
    } catch { throw new CodexQuotaReadError("request_failed"); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new CodexQuotaReadError("http_error");
    }
    try {
      signal.throwIfAborted();
      const body: unknown = await response.json();
      signal.throwIfAborted();
      const snapshot = parseCodexQuotaUsage(body, options.now ?? new Date());
      if (!snapshot) throw new Error();
      return snapshot;
    } catch { throw new CodexQuotaReadError("invalid_response"); }
  };
  try { return await Promise.race([acquire(), deadline]); }
  catch (error) {
    if (controller.signal.aborted) throw new CodexQuotaReadError("timeout");
    throw error instanceof CodexQuotaReadError ? error : new CodexQuotaReadError("request_failed");
  } finally { clearTimeout(timer); }
}
