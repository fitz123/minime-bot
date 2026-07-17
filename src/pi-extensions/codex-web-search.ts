/**
 * Package-owned Codex subscription web search.
 *
 * Authentication and active-model selection are supplied by Pi's tool
 * execution context. The transport deliberately has one fixed subscription
 * endpoint and no environment-key, alternate-provider, or retry path.
 */

export const CODEX_WEB_SEARCH_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_WEB_SEARCH_PROVIDER = "openai-codex";
export const CODEX_WEB_SEARCH_TIMEOUT_MS = 60_000;
export const MAX_CODEX_WEB_SEARCH_QUERY_CHARS = 300;
export const MAX_CODEX_WEB_SEARCH_TEXT_CHARS = 50_000;
export const MAX_CODEX_WEB_SEARCH_RESPONSE_BYTES = 1_000_000;
const MAX_WEB_ACTIONS = 50;
const MAX_ACTION_VALUES = 20;
const MAX_URL_CHARS = 2_048;
const MAX_METADATA_TEXT_CHARS = 512;
const MAX_HTTP_ERROR_BODY_CHARS = 4_096;
const RATE_LIMIT_ERROR_CODES = new Set([
  "rate_limit",
  "rate_limit_exceeded",
  "usage_limit",
  "usage_limit_reached",
  "usage_not_included",
  "quota_exceeded",
]);
const AUTH_ERROR_CODES = new Set([
  "auth_error",
  "authentication_error",
  "forbidden",
  "invalid_api_key",
  "invalid_oauth_token",
  "invalid_token",
  "oauth_token_expired",
  "token_expired",
  "unauthorized",
]);

export interface CodexWebSearchArgs {
  query?: unknown;
  max_results?: unknown;
  search_depth?: unknown;
  include_answer?: unknown;
}

export type CodexWebSearchFailureClassification =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "transport"
  | "schema"
  | "unknown";

export interface CodexWebSearchFailure {
  classification: CodexWebSearchFailureClassification;
  httpStatus?: number;
}

export interface CodexWebCitation {
  title: string;
  url: string;
  startIndex?: number;
  endIndex?: number;
}

export type CodexWebAction =
  | { type: "search"; queries: string[]; sources: string[] }
  | { type: "open_page"; url?: string }
  | { type: "find_in_page"; url: string; pattern: string };

export interface CodexWebSearchUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface CodexWebSearchResult {
  ok: boolean;
  text: string;
  authType?: "oauth";
  endpoint: typeof CODEX_WEB_SEARCH_ENDPOINT;
  provider?: string;
  model?: string;
  responseId?: string;
  citations: CodexWebCitation[];
  webActions: CodexWebAction[];
  usage?: CodexWebSearchUsage;
  truncated: boolean;
  failure?: CodexWebSearchFailure;
}

interface ActiveModel {
  provider: string;
  id: string;
  api?: string;
}

interface StoredCredential {
  type?: unknown;
  access?: unknown;
  accountId?: unknown;
}

export interface CodexWebSearchExecutionContext {
  model: ActiveModel | undefined;
  modelRegistry: {
    isUsingOAuth(model: ActiveModel): boolean;
    getApiKeyAndHeaders(model: ActiveModel): Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
    authStorage: {
      get(provider: string): StoredCredential | undefined;
    };
  };
}

export interface CodexWebSearchWarn {
  classification: CodexWebSearchFailureClassification;
  httpStatus?: number;
  detail?: "bad-args" | "blocked-egress" | "request-failed";
}

export interface RunCodexWebSearchDeps {
  context: CodexWebSearchExecutionContext;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  warn?: (event: CodexWebSearchWarn) => void;
}

export interface CodexWebSearchHttpRequest {
  url: typeof CODEX_WEB_SEARCH_ENDPOINT;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

interface ResolvedCodexOAuth {
  token: string;
  accountId: string;
  provider: string;
  model: string;
}

interface NormalizedCodexWebSearchControls {
  maxResults: number;
  includeAnswer: boolean;
  searchContextSize: "medium" | "high";
}

const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(?:api[_-]?key|authorization|cookie|credential|passwd|password|secret|session|token)\b\s*[:=]\s*\S{4,}/i;
const AUTH_HEADER_PATTERN = /\b(?:basic|bearer)\s+[A-Za-z0-9._~+/=-]{12,}\b/i;
const COMMON_SECRET_TOKEN_PATTERN =
  /\b(?:gh[pousr]_|sk-|tvly-|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\b/;
const PRIVATE_KEY_MARKER_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/i;
const LOCAL_PATH_PATTERN =
  /(?:^|[\s"'`=:(])(?:~\/|\.\.\/|\/(?:Users|home|private|var\/folders|etc|tmp)\/|[A-Za-z]:\\)[^\s"'`)]*/;
const REPO_FILE_PATH_PATTERN =
  /(?:^|[\s"'`=:(])(?:\.claude\/|bot\/|memory\/|\.ssh\/|(?:config\.local\.yaml|\.env|id_rsa)\b|[A-Za-z0-9_-]+\/[A-Za-z0-9._/-]+\.(?:env|json|key|md|pem|ts|tsx|yaml|yml)\b)/;
const HIGH_ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9_+/=-]{32,}/g;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function boundedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxChars);
}

function boundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function containsHighEntropyToken(text: string): boolean {
  for (const [token] of text.matchAll(HIGH_ENTROPY_TOKEN_PATTERN)) {
    if (/[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token)) return true;
  }
  return false;
}

/** Return a secret-safe reason when a model-supplied search query cannot leave the host. */
export function validateCodexWebSearchQuery(query: string): string | undefined {
  if (query.length > MAX_CODEX_WEB_SEARCH_QUERY_CHARS) {
    return `query exceeds ${MAX_CODEX_WEB_SEARCH_QUERY_CHARS} characters`;
  }
  if (/[\r\n]/.test(query)) return "query contains multiline content";
  if (query.includes("```")) return "query contains a code block";
  if (PRIVATE_KEY_MARKER_PATTERN.test(query)) return "query contains private-key material";
  if (AUTH_HEADER_PATTERN.test(query) || COMMON_SECRET_TOKEN_PATTERN.test(query) || JWT_PATTERN.test(query)) {
    return "query contains credential-like text";
  }
  if (SENSITIVE_ASSIGNMENT_PATTERN.test(query)) return "query contains a sensitive assignment";
  if (LOCAL_PATH_PATTERN.test(query)) return "query contains local path text";
  if (REPO_FILE_PATH_PATTERN.test(query)) return "query contains workspace/repository path text";
  if (containsHighEntropyToken(query)) return "query contains high-entropy token-like text";
  return undefined;
}

function emptyResult(text: string, failure: CodexWebSearchFailure): CodexWebSearchResult {
  return {
    ok: false,
    text,
    endpoint: CODEX_WEB_SEARCH_ENDPOINT,
    citations: [],
    webActions: [],
    truncated: false,
    failure,
  };
}

function failureText(failure: CodexWebSearchFailure): string {
  const suffix = failure.httpStatus === undefined ? "" : ` (HTTP ${failure.httpStatus})`;
  switch (failure.classification) {
    case "auth":
      return `web_search is unavailable: active openai-codex subscription OAuth is required${suffix}.`;
    case "rate_limit":
      return `web_search failed: Codex subscription rate limit reached${suffix}.`;
    case "timeout":
      return `web_search failed: Codex search timed out${suffix}.`;
    case "transport":
      return `web_search failed: Codex search transport is unavailable${suffix}.`;
    case "schema":
      return `web_search failed: Codex returned an invalid search response${suffix}.`;
    case "unknown":
      return `web_search failed: Codex search could not be completed${suffix}.`;
  }
}

function classifiedFailure(
  classification: CodexWebSearchFailureClassification,
  httpStatus?: number,
): CodexWebSearchResult {
  const failure = httpStatus === undefined ? { classification } : { classification, httpStatus };
  return emptyResult(failureText(failure), failure);
}

/** Resolve only the active model's refreshed, stored OAuth credential. */
export async function resolveCodexWebSearchOAuth(
  context: CodexWebSearchExecutionContext,
  signal?: AbortSignal,
): Promise<ResolvedCodexOAuth | undefined> {
  const model = context.model;
  if (!model || model.provider !== CODEX_WEB_SEARCH_PROVIDER || !context.modelRegistry.isUsingOAuth(model)) {
    return undefined;
  }

  if (signal?.aborted) throw signal.reason ?? new Error("Codex OAuth resolution aborted");
  const authPromise = context.modelRegistry.getApiKeyAndHeaders(model);
  let abortAuth: (() => void) | undefined;
  const auth = signal
    ? await Promise.race([
      authPromise,
      new Promise<never>((_resolve, reject) => {
        abortAuth = () => reject(signal.reason ?? new Error("Codex OAuth resolution aborted"));
        signal.addEventListener("abort", abortAuth, { once: true });
      }),
    ]).finally(() => {
      if (abortAuth) signal.removeEventListener("abort", abortAuth);
    })
    : await authPromise;
  if (!auth.ok || !auth.apiKey) return undefined;

  const stored = context.modelRegistry.authStorage.get(CODEX_WEB_SEARCH_PROVIDER);
  if (
    stored?.type !== "oauth" ||
    typeof stored.access !== "string" ||
    stored.access !== auth.apiKey ||
    typeof stored.accountId !== "string" ||
    stored.accountId.length === 0
  ) {
    // Reject runtime API-key overrides and stale/non-OAuth credential shapes.
    return undefined;
  }

  return {
    token: stored.access,
    accountId: stored.accountId,
    provider: model.provider,
    model: model.id,
  };
}

function normalizeMaxResults(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return Math.min(20, Math.floor(parsed));
}

function normalizeCodexWebSearchControls(args: CodexWebSearchArgs): NormalizedCodexWebSearchControls {
  return {
    maxResults: normalizeMaxResults(args.max_results),
    includeAnswer: args.include_answer !== false,
    searchContextSize: args.search_depth === "advanced" ? "high" : "medium",
  };
}

function buildNormalizedCodexWebSearchRequest(
  auth: ResolvedCodexOAuth,
  query: string,
  controls: NormalizedCodexWebSearchControls,
): CodexWebSearchHttpRequest {
  const responseInstruction = controls.includeAnswer
    ? "Answer the query using web search. Cite factual claims with the returned web sources."
    : "Use web search and return a concise source list with titles and URLs, without a synthesized answer.";

  return {
    url: CODEX_WEB_SEARCH_ENDPOINT,
    method: "POST",
    headers: {
      Accept: "text/event-stream",
      Authorization: `Bearer ${auth.token}`,
      "ChatGPT-Account-Id": auth.accountId,
      "Content-Type": "application/json",
      "OpenAI-Beta": "responses=experimental",
      Originator: "pi",
      "User-Agent": "minime-bot web_search",
    },
    body: JSON.stringify({
      model: auth.model,
      store: false,
      stream: true,
      instructions: `${responseInstruction} Use no more than ${controls.maxResults} distinct sources.`,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: query }] }],
      tools: [{
        type: "web_search",
        external_web_access: true,
        search_context_size: controls.searchContextSize,
      }],
      tool_choice: "required",
      parallel_tool_calls: true,
      include: [],
    }),
  };
}

/** Build the single fixed-endpoint Codex Responses request. */
export function buildCodexWebSearchRequest(
  auth: ResolvedCodexOAuth,
  args: CodexWebSearchArgs,
): CodexWebSearchHttpRequest {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  return buildNormalizedCodexWebSearchRequest(auth, query, normalizeCodexWebSearchControls(args));
}

export interface BoundedRequestSignal {
  signal: AbortSignal;
  didTimeout(): boolean;
  parentAborted(): boolean;
  cancel(): void;
}

/** Combine caller cancellation with a bounded request timeout and removable listeners. */
export function createBoundedCodexSearchSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): BoundedRequestSignal {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex web search timeout must be positive");
  }
  const controller = new AbortController();
  let timedOut = false;
  let abortedByParent = false;
  const abortFromParent = (): void => {
    abortedByParent = true;
    controller.abort(parent?.reason);
  };
  if (parent?.aborted) abortFromParent();
  else parent?.addEventListener("abort", abortFromParent, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Codex web search timeout"));
  }, timeoutMs);

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    parentAborted: () => abortedByParent,
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abortFromParent);
    },
  };
}

class CodexSearchSchemaError extends Error {}

class CodexSearchProviderError extends Error {
  constructor(readonly classification: CodexWebSearchFailureClassification) {
    super("Codex search provider event failed");
  }
}

function classifyProviderCode(raw: unknown): CodexWebSearchFailureClassification {
  const code = typeof raw === "string" ? raw.toLowerCase() : "";
  if (RATE_LIMIT_ERROR_CODES.has(code)) return "rate_limit";
  if (AUTH_ERROR_CODES.has(code)) return "auth";
  return "unknown";
}

function normalizeCitation(raw: unknown): CodexWebCitation | undefined {
  const annotation = asRecord(raw);
  if (annotation?.type !== "url_citation") return undefined;
  const url = boundedString(annotation.url, MAX_URL_CHARS);
  if (!url) return undefined;
  const title = boundedString(annotation.title, MAX_METADATA_TEXT_CHARS) ?? url;
  const startIndex = boundedNumber(annotation.start_index);
  const endIndex = boundedNumber(annotation.end_index);
  return {
    title,
    url,
    ...(startIndex === undefined ? {} : { startIndex }),
    ...(endIndex === undefined ? {} : { endIndex }),
  };
}

function boundedStringArray(raw: unknown, maxChars: number): string[] {
  if (!Array.isArray(raw)) return [];
  const values: string[] = [];
  for (const value of raw) {
    const normalized = boundedString(value, maxChars);
    if (normalized && !values.includes(normalized)) values.push(normalized);
    if (values.length >= MAX_ACTION_VALUES) break;
  }
  return values;
}

function normalizeWebAction(raw: unknown, maxSources = MAX_ACTION_VALUES): CodexWebAction | undefined {
  const action = asRecord(raw);
  if (action?.type === "search") {
    const fallbackQuery = boundedString(action.query, MAX_METADATA_TEXT_CHARS);
    const queries = boundedStringArray(action.queries, MAX_METADATA_TEXT_CHARS);
    if (queries.length === 0 && fallbackQuery) queries.push(fallbackQuery);
    const sources = Array.isArray(action.sources)
      ? action.sources.flatMap((source) => {
        const url = boundedString(asRecord(source)?.url, MAX_URL_CHARS);
        return url ? [url] : [];
      })
      : [];
    return { type: "search", queries, sources: [...new Set(sources)].slice(0, maxSources) };
  }
  if (action?.type === "open_page") {
    const url = boundedString(action.url, MAX_URL_CHARS);
    return { type: "open_page", ...(url ? { url } : {}) };
  }
  if (action?.type === "find_in_page") {
    const url = boundedString(action.url, MAX_URL_CHARS);
    const pattern = boundedString(action.pattern, MAX_METADATA_TEXT_CHARS);
    if (url && pattern) return { type: "find_in_page", url, pattern };
  }
  return undefined;
}

function limitWebActionSources(
  actions: readonly CodexWebAction[],
  citations: readonly CodexWebCitation[],
  maxSources: number,
): CodexWebAction[] {
  const exposedSources = new Set(citations.map((citation) => citation.url));
  const includeSource = (url: string): boolean => {
    if (exposedSources.has(url)) return true;
    if (exposedSources.size >= maxSources) return false;
    exposedSources.add(url);
    return true;
  };

  const limited: CodexWebAction[] = [];
  for (const action of actions) {
    if (action.type === "search") {
      limited.push({ ...action, sources: action.sources.filter(includeSource) });
      continue;
    }
    if (action.type === "open_page") {
      limited.push(!action.url || includeSource(action.url) ? action : { type: "open_page" });
      continue;
    }
    if (includeSource(action.url)) limited.push(action);
  }
  return limited;
}

function parseUsage(raw: unknown): CodexWebSearchUsage | undefined {
  const usage = asRecord(raw);
  if (!usage) return undefined;
  const inputTokens = boundedNumber(usage.input_tokens);
  const outputTokens = boundedNumber(usage.output_tokens);
  const totalTokens = boundedNumber(usage.total_tokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined;
  const cachedInputTokens = boundedNumber(asRecord(usage.input_tokens_details)?.cached_tokens);
  const reasoningTokens = boundedNumber(asRecord(usage.output_tokens_details)?.reasoning_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function extractMessageTextAndCitations(
  raw: unknown,
  addCitation: (citation: CodexWebCitation) => void,
): string {
  const item = asRecord(raw);
  if (item?.type !== "message" || !Array.isArray(item.content)) return "";
  const parts: string[] = [];
  for (const rawContent of item.content) {
    const content = asRecord(rawContent);
    if (content?.type !== "output_text") continue;
    if (typeof content.text === "string") parts.push(content.text);
    if (Array.isArray(content.annotations)) {
      for (const annotation of content.annotations) {
        const citation = normalizeCitation(annotation);
        if (citation) addCitation(citation);
      }
    }
  }
  return parts.join("");
}

function formatSearchOutput(
  answer: string,
  citations: readonly CodexWebCitation[],
  includeAnswer: boolean,
): {
  text: string;
  truncated: boolean;
} {
  const sources = citations.length === 0
    ? ""
    : `\n\nSources:\n${citations.map((citation) => `- ${citation.title}: ${citation.url}`).join("\n")}`;
  const combined = `${includeAnswer ? answer.trim() : ""}${sources}`.trim();
  if (combined.length <= MAX_CODEX_WEB_SEARCH_TEXT_CHARS) return { text: combined, truncated: false };
  return {
    text: combined.slice(0, MAX_CODEX_WEB_SEARCH_TEXT_CHARS),
    truncated: true,
  };
}

/** Parse a streamed Responses body without retaining raw provider diagnostics. */
export async function parseCodexWebSearchSse(
  response: Response,
  selected: Pick<ResolvedCodexOAuth, "provider" | "model">,
  signal?: AbortSignal,
  controls?: Pick<NormalizedCodexWebSearchControls, "maxResults" | "includeAnswer">,
): Promise<CodexWebSearchResult> {
  if (!response.body) throw new CodexSearchSchemaError("missing response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let responseBytes = 0;
  let answerDelta = "";
  let deltaTruncated = false;
  let finalAnswer = "";
  let responseId: string | undefined;
  let usage: CodexWebSearchUsage | undefined;
  let sawTerminal = false;
  let streamFinished = false;
  const citations: CodexWebCitation[] = [];
  const citationKeys = new Set<string>();
  const webActions: CodexWebAction[] = [];
  const actionKeys = new Set<string>();
  const maxResults = normalizeMaxResults(controls?.maxResults);
  const includeAnswer = controls?.includeAnswer !== false;

  const addCitation = (citation: CodexWebCitation): void => {
    const key = citation.url;
    if (citationKeys.has(key) || citations.length >= maxResults) return;
    citationKeys.add(key);
    citations.push(citation);
  };
  const addAction = (action: CodexWebAction): void => {
    const key = JSON.stringify(action);
    if (actionKeys.has(key) || webActions.length >= MAX_WEB_ACTIONS) return;
    actionKeys.add(key);
    webActions.push(action);
  };
  const captureOutput = (rawOutput: unknown): string => {
    if (!Array.isArray(rawOutput)) return "";
    const textParts: string[] = [];
    for (const rawItem of rawOutput) {
      const item = asRecord(rawItem);
      if (!item) continue;
      const text = extractMessageTextAndCitations(item, addCitation);
      if (text) textParts.push(text);
      if (item.type === "web_search_call") {
        const action = normalizeWebAction(item.action, maxResults);
        if (action) addAction(action);
      }
    }
    return textParts.join("\n");
  };
  const handleEvent = (rawEvent: unknown): void => {
    const event = asRecord(rawEvent);
    if (!event || typeof event.type !== "string") {
      throw new CodexSearchSchemaError("invalid event");
    }
    if (event.type === "response.created") {
      responseId = boundedString(asRecord(event.response)?.id, MAX_METADATA_TEXT_CHARS) ?? responseId;
      return;
    }
    if (event.type === "response.output_text.delta") {
      if (typeof event.delta === "string") {
        const remaining = MAX_CODEX_WEB_SEARCH_TEXT_CHARS - answerDelta.length;
        if (event.delta.length > remaining) deltaTruncated = true;
        if (remaining > 0) answerDelta += event.delta.slice(0, remaining);
      }
      return;
    }
    if (event.type === "response.output_text.annotation.added") {
      const citation = normalizeCitation(event.annotation);
      if (citation) addCitation(citation);
      return;
    }
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      const item = asRecord(event.item);
      if (item?.type === "web_search_call") {
        const action = normalizeWebAction(item.action, maxResults);
        if (action) addAction(action);
      }
      if (event.type === "response.output_item.done") {
        const text = extractMessageTextAndCitations(item, addCitation);
        if (text) finalAnswer = text;
      }
      return;
    }
    if (event.type === "response.failed" || event.type === "error") {
      const response = asRecord(event.response);
      const nestedError = asRecord(response?.error) ?? asRecord(event.error);
      throw new CodexSearchProviderError(classifyProviderCode(nestedError?.code ?? event.code));
    }
    if (
      event.type === "response.completed" ||
      event.type === "response.done" ||
      event.type === "response.incomplete"
    ) {
      const terminal = asRecord(event.response);
      if (!terminal) throw new CodexSearchSchemaError("missing terminal response");
      const status = terminal.status;
      if (event.type === "response.incomplete" || status === "incomplete") {
        throw new CodexSearchProviderError("unknown");
      }
      if (status === "failed" || status === "cancelled") {
        throw new CodexSearchProviderError(classifyProviderCode(asRecord(terminal.error)?.code));
      }
      responseId = boundedString(terminal.id, MAX_METADATA_TEXT_CHARS) ?? responseId;
      const terminalAnswer = captureOutput(terminal.output);
      if (terminalAnswer) finalAnswer = terminalAnswer;
      usage = parseUsage(terminal.usage) ?? usage;
      sawTerminal = true;
    }
  };
  const consumeChunk = (chunk: string): boolean => {
    const lines = chunk.split(/\r?\n/);
    const eventType = lines
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n")
      .trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new CodexSearchSchemaError("invalid event JSON");
    }
    const parsedRecord = asRecord(parsed);
    if (eventType && parsedRecord && typeof parsedRecord.type !== "string") {
      parsed = { ...parsedRecord, type: eventType };
    }
    handleEvent(parsed);
    return sawTerminal;
  };
  const abortReader = (): void => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", abortReader, { once: true });

  try {
    stream: while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("request aborted");
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new Error("request aborted");
      if (done) {
        streamFinished = true;
        break;
      }
      responseBytes += value.byteLength;
      if (responseBytes > MAX_CODEX_WEB_SEARCH_RESPONSE_BYTES) {
        throw new CodexSearchSchemaError("response body exceeds byte limit");
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1) {
        const separator = buffer.slice(boundary).startsWith("\r\n\r\n") ? 4 : 2;
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + separator);
        if (consumeChunk(chunk)) break stream;
        boundary = buffer.search(/\r?\n\r?\n/);
      }
    }
    if (streamFinished) {
      buffer += decoder.decode();
      if (buffer.trim()) consumeChunk(buffer);
    }
  } finally {
    signal?.removeEventListener("abort", abortReader);
    if (!streamFinished) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the primary failure classification.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // The reader may already be released by the runtime after cancellation.
    }
  }

  if (!sawTerminal) throw new CodexSearchSchemaError("missing terminal event");
  const answer = finalAnswer || answerDelta;
  if (includeAnswer && !answer.trim()) throw new CodexSearchSchemaError("missing answer text");
  const formatted = formatSearchOutput(answer, citations, includeAnswer);
  if (!formatted.text) throw new CodexSearchSchemaError("missing search output");
  const limitedWebActions = limitWebActionSources(webActions, citations, maxResults);
  const answerTruncated = finalAnswer
    ? finalAnswer.length > MAX_CODEX_WEB_SEARCH_TEXT_CHARS
    : deltaTruncated;
  return {
    ok: true,
    text: formatted.text,
    authType: "oauth",
    endpoint: CODEX_WEB_SEARCH_ENDPOINT,
    provider: selected.provider,
    model: selected.model,
    ...(responseId ? { responseId } : {}),
    citations,
    webActions: limitedWebActions,
    ...(usage ? { usage } : {}),
    truncated: formatted.truncated || (includeAnswer && answerTruncated),
  };
}

/** Release an HTTP error body without reading provider diagnostics. */
export async function cancelCodexWebSearchResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cleanup must not replace the bounded failure classification.
  }
}

async function readBoundedCodexErrorCode(response: Response): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let streamFinished = false;

  const findKnownCode = (): string | undefined => {
    for (const match of body.matchAll(/"(?:code|type)"\s*:\s*"([A-Za-z0-9_-]{1,64})"/g)) {
      if (classifyProviderCode(match[1]) !== "unknown") return match[1];
    }
    return undefined;
  };

  try {
    while (body.length < MAX_HTTP_ERROR_BODY_CHARS) {
      const { done, value } = await reader.read();
      if (done) {
        streamFinished = true;
        body += decoder.decode().slice(0, MAX_HTTP_ERROR_BODY_CHARS - body.length);
        return findKnownCode();
      }
      const remaining = MAX_HTTP_ERROR_BODY_CHARS - body.length;
      body += decoder.decode(value, { stream: true }).slice(0, remaining);
      const code = findKnownCode();
      if (code) return code;
    }
    return undefined;
  } finally {
    if (!streamFinished) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the bounded HTTP failure classification.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // The runtime may release the reader after cancellation.
    }
  }
}

function classifyHttpStatus(status: number): CodexWebSearchFailureClassification {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500 && status <= 599) return "transport";
  return "unknown";
}

/** Execute one OAuth-backed Codex Responses request. Never throws. */
export async function executeCodexWebSearch(
  args: CodexWebSearchArgs,
  deps: RunCodexWebSearchDeps,
  signal?: AbortSignal,
): Promise<CodexWebSearchResult> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    deps.warn?.({ classification: "schema", detail: "bad-args" });
    return emptyResult("web_search requires a non-empty 'query' string.", { classification: "schema" });
  }
  const queryProblem = validateCodexWebSearchQuery(query);
  if (queryProblem) {
    deps.warn?.({ classification: "schema", detail: "blocked-egress" });
    return emptyResult(
      `web_search blocked: ${queryProblem}. Do not send local or private data to external web services.`,
      { classification: "schema" },
    );
  }

  const bounded = createBoundedCodexSearchSignal(signal, deps.requestTimeoutMs ?? CODEX_WEB_SEARCH_TIMEOUT_MS);
  try {
    let auth: ResolvedCodexOAuth | undefined;
    try {
      auth = await resolveCodexWebSearchOAuth(deps.context, bounded.signal);
    } catch (error) {
      if (bounded.signal.aborted) throw error;
      // Registry/provider diagnostics can contain credential details; keep them private.
    }
    if (!auth) {
      const result = classifiedFailure("auth");
      deps.warn?.({ classification: "auth", detail: "request-failed" });
      return result;
    }

    const controls = normalizeCodexWebSearchControls(args);
    const request = buildNormalizedCodexWebSearchRequest(auth, query, controls);
    const response = await (deps.fetchImpl ?? fetch)(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "error",
      signal: bounded.signal,
    });
    if (!response.ok) {
      const status = response.status;
      const statusClassification = classifyHttpStatus(status);
      const classification = statusClassification === "unknown"
        ? classifyProviderCode(await readBoundedCodexErrorCode(response))
        : statusClassification;
      if (statusClassification !== "unknown") await cancelCodexWebSearchResponse(response);
      deps.warn?.({ classification, httpStatus: status, detail: "request-failed" });
      return classifiedFailure(classification, status);
    }
    return await parseCodexWebSearchSse(response, auth, bounded.signal, controls);
  } catch (error) {
    const classification = bounded.didTimeout()
      ? "timeout"
      : bounded.parentAborted()
        ? "transport"
        : error instanceof CodexSearchSchemaError
          ? "schema"
          : error instanceof CodexSearchProviderError
            ? error.classification
            : error instanceof TypeError
              ? "transport"
              : "unknown";
    deps.warn?.({ classification, detail: "request-failed" });
    return classifiedFailure(classification);
  } finally {
    bounded.cancel();
  }
}

export function formatCodexWebSearchWarn(event: CodexWebSearchWarn): string {
  return `[web-tools] tool=web_search provider=${CODEX_WEB_SEARCH_PROVIDER}` +
    ` classification=${event.classification}` +
    `${event.httpStatus === undefined ? "" : ` httpStatus=${event.httpStatus}`}` +
    `${event.detail === undefined ? "" : ` detail=${event.detail}`}`;
}

/** Compatible with the existing web_search input contract. */
export const CODEX_WEB_SEARCH_TOOL = {
  name: "web_search",
  label: "Web Search",
  description:
    "Search the web for current information using Codex subscription web search. " +
    "Returns a synthesized answer, citations, and search metadata. Do not include " +
    "local file contents, paths, credentials, or other private data.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query." },
      max_results: {
        type: "number",
        description: "Maximum distinct sources to use (1-20, default 5).",
      },
      search_depth: {
        type: "string",
        enum: ["basic", "advanced"],
        description: "Search depth; advanced requests more search context.",
      },
      include_answer: {
        type: "boolean",
        description: "Whether to include a synthesized answer (default true).",
      },
    },
    required: ["query"],
  },
} as const;
