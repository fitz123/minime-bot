import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCodexWebSearchRequest,
  cancelCodexWebSearchResponse,
  CODEX_WEB_SEARCH_ENDPOINT,
  CODEX_WEB_SEARCH_PROVIDER,
  CODEX_WEB_SEARCH_RETRY_WINDOW_MS,
  CODEX_WEB_SEARCH_TOOL,
  createBoundedCodexSearchSignal,
  executeCodexWebSearch,
  formatCodexWebSearchWarn,
  MAX_CODEX_WEB_SEARCH_QUERY_CHARS,
  MAX_CODEX_WEB_SEARCH_RESPONSE_BYTES,
  MAX_CODEX_WEB_SEARCH_TEXT_CHARS,
  parseCodexWebSearchSse,
  resolveCodexWebSearchOAuth,
  validateCodexWebSearchQuery,
  type CodexWebSearchExecutionContext,
  type CodexWebSearchWarn,
} from "../pi-extensions/codex-web-search.js";

const BOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ContextOptions {
  provider?: string;
  model?: string;
  oauth?: boolean;
  providerAuthToken?: string;
  resolvedToken?: string;
  accountId?: string;
  authOk?: boolean;
  providerAuthOk?: boolean;
}

function codexOAuthToken(accountId: string, marker = "refreshed"): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
      marker,
    })).toString("base64url"),
    Buffer.from(`signature-${marker}`).toString("base64url"),
  ].join(".");
}

function makeContext(options: ContextOptions = {}): {
  context: CodexWebSearchExecutionContext;
  calls: { isUsingOAuth: number; getProviderAuth: number; getRequestAuth: number };
} {
  const provider = options.provider ?? CODEX_WEB_SEARCH_PROVIDER;
  const model = options.model ?? "gpt-active-codex";
  const providerAuthToken = options.providerAuthToken
    ?? codexOAuthToken(options.accountId ?? "account-fixture");
  const resolvedToken = options.resolvedToken ?? providerAuthToken;
  const calls = { isUsingOAuth: 0, getProviderAuth: 0, getRequestAuth: 0 };
  return {
    calls,
    context: {
      model: { provider, id: model, api: "openai-codex-responses" },
      modelRegistry: {
        isUsingOAuth: () => {
          calls.isUsingOAuth += 1;
          return options.oauth ?? true;
        },
        getProviderAuth: async () => {
          calls.getProviderAuth += 1;
          if (options.providerAuthOk === false) return undefined;
          return { auth: { apiKey: providerAuthToken }, source: "OAuth" };
        },
        getApiKeyAndHeaders: async () => {
          calls.getRequestAuth += 1;
          if (options.authOk === false) return { ok: false as const, error: "private auth error" };
          return { ok: true as const, apiKey: resolvedToken };
        },
      },
    },
  };
}

function sseEvent(value: unknown, newline = "\n"): string {
  return `data: ${JSON.stringify(value)}${newline}${newline}`;
}

function successSse(options: {
  answer?: string;
  model?: string;
  includeDelta?: boolean;
  newline?: "\n" | "\r\n";
} = {}): string {
  const answer = options.answer ?? "Codex search answer [1].";
  const newline = options.newline ?? "\n";
  const response = {
    id: "resp-search-1",
    status: "completed",
    output: [
      {
        id: "ws-1",
        type: "web_search_call",
        status: "completed",
        action: {
          type: "search",
          query: "fixture query",
          queries: ["fixture query", "fixture details"],
          sources: [{ type: "url", url: "https://example.com/source" }],
        },
      },
      {
        id: "msg-1",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{
          type: "output_text",
          text: answer,
          annotations: [{
            type: "url_citation",
            title: "Example source",
            url: "https://example.com/source",
            start_index: 20,
            end_index: 23,
          }],
        }],
      },
    ],
    usage: {
      input_tokens: 101,
      output_tokens: 23,
      total_tokens: 124,
      input_tokens_details: { cached_tokens: 7 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
  };
  return [
    sseEvent({ type: "response.created", response: { id: response.id } }, newline),
    options.includeDelta
      ? sseEvent({ type: "response.output_text.delta", delta: answer }, newline)
      : "",
    sseEvent({
      type: "response.output_item.done",
      output_index: 0,
      item: response.output[0],
    }, newline),
    sseEvent({ type: "response.completed", response }, newline),
    `data: [DONE]${newline}${newline}`,
  ].join("");
}

function sseResponse(body: string, chunks?: number[]): Response {
  if (!chunks) {
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
  const encoded = new TextEncoder().encode(body);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const size of chunks) {
        if (offset >= encoded.length) break;
        controller.enqueue(encoded.slice(offset, offset + size));
        offset += size;
      }
      if (offset < encoded.length) controller.enqueue(encoded.slice(offset));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function makeVirtualRetryClock(wallStart = Date.UTC(2026, 8, 2, 12)): {
  now(): number;
  wallNow(): number;
  random(): number;
  sleep(delayMs: number, signal?: AbortSignal): Promise<void>;
  delays: number[];
  advance(delayMs: number): void;
  setElapsed(elapsedMs: number): void;
} {
  let elapsed = 0;
  const delays: number[] = [];
  return {
    now: () => elapsed,
    wallNow: () => wallStart + elapsed,
    random: () => 0,
    sleep: async (delayMs, signal) => {
      if (signal?.aborted) throw signal.reason;
      delays.push(delayMs);
      elapsed += delayMs;
    },
    delays,
    advance: (delayMs) => { elapsed += delayMs; },
    setElapsed: (elapsedMs) => { elapsed = elapsedMs; },
  };
}

function expireRetryWindowAfterSleep(): {
  now(): number;
  random(): number;
  sleep(): Promise<void>;
} {
  let elapsed = 0;
  return {
    now: () => elapsed,
    random: () => 0,
    sleep: async () => { elapsed = CODEX_WEB_SEARCH_RETRY_WINDOW_MS; },
  };
}

describe("Codex web search auth and request", () => {
  it("resolves the active model's refreshed OAuth token and locally validated account id", async () => {
    const { context, calls } = makeContext({ model: "gpt-current", accountId: "account-current" });
    const auth = await resolveCodexWebSearchOAuth(context);
    assert.deepEqual(auth, {
      token: codexOAuthToken("account-current"),
      accountId: "account-current",
      provider: CODEX_WEB_SEARCH_PROVIDER,
      model: "gpt-current",
    });
    assert.deepEqual(calls, { isUsingOAuth: 1, getProviderAuth: 1, getRequestAuth: 1 });
  });

  it("rejects non-Codex, non-OAuth, unresolved, stale, API-key, and malformed auth", async () => {
    const refreshed = codexOAuthToken("account-current", "refreshed");
    for (const options of [
      { provider: "openai" },
      { oauth: false },
      { providerAuthOk: false },
      { authOk: false },
      {
        providerAuthToken: refreshed,
        resolvedToken: codexOAuthToken("account-current", "stale"),
      },
      { providerAuthToken: refreshed, resolvedToken: "runtime-api-key" },
      { providerAuthToken: "malformed-token", resolvedToken: "malformed-token" },
      { accountId: "" },
    ]) {
      const { context } = makeContext(options);
      assert.equal(await resolveCodexWebSearchOAuth(context), undefined);
    }
  });

  it("does not start OAuth resolution after cancellation", async () => {
    const { context, calls } = makeContext();
    context.modelRegistry.getProviderAuth = async () => {
      calls.getProviderAuth += 1;
      throw new Error("orphaned provider auth rejection");
    };
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    controller.abort(reason);

    await assert.rejects(
      resolveCodexWebSearchOAuth(context, controller.signal),
      (error: unknown) => error === reason,
    );
    assert.deepEqual(calls, { isUsingOAuth: 1, getProviderAuth: 0, getRequestAuth: 0 });
  });

  it("builds one fixed subscription request with the compatible controls", () => {
    const request = buildCodexWebSearchRequest({
      token: "oauth-fixture",
      accountId: "account-fixture",
      provider: CODEX_WEB_SEARCH_PROVIDER,
      model: "gpt-active",
    }, {
      query: "current primary documentation",
      max_results: 7,
      search_depth: "advanced",
      include_answer: false,
    });
    assert.equal(request.url, CODEX_WEB_SEARCH_ENDPOINT);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.Authorization, "Bearer oauth-fixture");
    assert.equal(request.headers["ChatGPT-Account-Id"], "account-fixture");
    assert.equal(request.headers["OpenAI-Beta"], "responses=experimental");
    const body = JSON.parse(request.body) as Record<string, unknown>;
    assert.equal(body.model, "gpt-active");
    assert.equal(body.stream, true);
    assert.equal(body.store, false);
    assert.deepEqual(body.input, [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "current primary documentation" }],
    }]);
    assert.deepEqual(body.tools, [{
      type: "web_search",
      external_web_access: true,
      search_context_size: "high",
    }]);
    assert.equal(body.tool_choice, "required");
    assert.equal(body.parallel_tool_calls, true);
    assert.deepEqual(body.include, []);
    assert.equal(body.max_output_tokens, undefined);
    assert.equal(body.text, undefined);
    assert.match(String(body.instructions), /no more than 7 distinct sources/i);
    assert.match(String(body.instructions), /without a synthesized answer/i);
  });

  it("normalizes every compatible request control boundary", () => {
    const auth = {
      token: "oauth-fixture",
      accountId: "account-fixture",
      provider: CODEX_WEB_SEARCH_PROVIDER,
      model: "gpt-active",
    };
    const cases = [
      { args: {}, maxResults: 5, contextSize: "medium", includesAnswer: true },
      { args: { max_results: 0 }, maxResults: 5, contextSize: "medium", includesAnswer: true },
      { args: { max_results: "invalid" }, maxResults: 5, contextSize: "medium", includesAnswer: true },
      { args: { max_results: 7.9 }, maxResults: 7, contextSize: "medium", includesAnswer: true },
      { args: { max_results: 99 }, maxResults: 20, contextSize: "medium", includesAnswer: true },
      {
        args: { max_results: 1, search_depth: "advanced", include_answer: false },
        maxResults: 1,
        contextSize: "high",
        includesAnswer: false,
      },
    ];

    for (const entry of cases) {
      const request = buildCodexWebSearchRequest(auth, {
        query: "current primary documentation",
        ...entry.args,
      });
      const body = JSON.parse(request.body) as {
        instructions: string;
        tools: Array<{ search_context_size: string }>;
      };
      assert.match(body.instructions, new RegExp(`no more than ${entry.maxResults} distinct sources`, "i"));
      assert.equal(body.tools[0]?.search_context_size, entry.contextSize);
      if (entry.includesAnswer) {
        assert.match(body.instructions, /answer the query/i);
      } else {
        assert.match(body.instructions, /without a synthesized answer/i);
      }
    }
  });

  it("ignores OPENAI_API_KEY and selects the active model for the HTTP call", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "forbidden-environment-key";
    const { context } = makeContext({ model: "gpt-live-model" });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    try {
      const result = await executeCodexWebSearch({ query: "official current docs" }, {
        context,
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          calls.push({ url: String(url), init });
          return sseResponse(successSse());
        }) as typeof fetch,
      });
      assert.equal(result.ok, true);
      assert.equal(result.model, "gpt-live-model");
      assert.equal(result.provider, CODEX_WEB_SEARCH_PROVIDER);
      assert.equal(result.authType, "oauth");
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, CODEX_WEB_SEARCH_ENDPOINT);
      const headers = calls[0].init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, `Bearer ${codexOAuthToken("account-fixture")}`);
      assert.doesNotMatch(JSON.stringify(calls[0]), /forbidden-environment-key|api\.openai\.com/);
      assert.equal((JSON.parse(String(calls[0].init?.body)) as { model: string }).model, "gpt-live-model");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
  });

  it("rejects redirects without issuing a second credential-bearing request", async (t) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/start") {
        response.writeHead(307, { location: "/redirected" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(successSse());
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    t.after(() => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }));
    const address = server.address();
    assert(address && typeof address !== "string");

    const { context } = makeContext();
    let redirectMode: RequestRedirect | undefined;
    const result = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      ...expireRetryWindowAfterSleep(),
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
        redirectMode = init?.redirect;
        return fetch(`http://127.0.0.1:${address.port}/start`, init);
      }) as typeof fetch,
    });

    assert.equal(result.failure?.classification, "transport");
    assert.equal(redirectMode, "error");
    assert.deepEqual(requests, ["/start"]);
  });
});

describe("Codex web search streamed response parsing", () => {
  it("parses split CRLF SSE, citations, web actions, response id, model, and usage", async () => {
    const body = successSse({ includeDelta: true, newline: "\r\n" });
    const result = await parseCodexWebSearchSse(
      sseResponse(body, [1, 2, 7, 13, 29]),
      { provider: CODEX_WEB_SEARCH_PROVIDER, model: "gpt-active" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.responseId, "resp-search-1");
    assert.equal(result.provider, CODEX_WEB_SEARCH_PROVIDER);
    assert.equal(result.model, "gpt-active");
    assert.equal(result.authType, "oauth");
    assert.match(result.text, /Codex search answer/);
    assert.match(result.text, /Example source: https:\/\/example\.com\/source/);
    assert.deepEqual(result.citations, [{
      title: "Example source",
      url: "https://example.com/source",
      startIndex: 20,
      endIndex: 23,
    }]);
    assert.deepEqual(result.webActions, [{
      type: "search",
      queries: ["fixture query", "fixture details"],
      sources: ["https://example.com/source"],
    }]);
    assert.deepEqual(result.usage, {
      inputTokens: 101,
      outputTokens: 23,
      totalTokens: 124,
      cachedInputTokens: 7,
      reasoningTokens: 5,
    });
  });

  it("uses streamed answer deltas when the terminal payload omits output", async () => {
    const body = [
      sseEvent({ type: "response.output_text.delta", delta: "delta answer" }),
      sseEvent({
        type: "response.completed",
        response: {
          id: "resp-delta",
          status: "completed",
          output: [],
          usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
        },
      }),
    ].join("");
    const result = await parseCodexWebSearchSse(
      sseResponse(body),
      { provider: CODEX_WEB_SEARCH_PROVIDER, model: "gpt-active" },
    );
    assert.equal(result.text, "delta answer");
    assert.equal(result.responseId, "resp-delta");
  });

  it("reports truncation when a delta-only answer exceeds the text cap", async () => {
    const body = [
      sseEvent({
        type: "response.output_text.delta",
        delta: "x".repeat(MAX_CODEX_WEB_SEARCH_TEXT_CHARS + 1),
      }),
      sseEvent({
        type: "response.completed",
        response: { id: "resp-delta-cap", status: "completed", output: [] },
      }),
    ].join("");
    const result = await parseCodexWebSearchSse(
      sseResponse(body),
      { provider: CODEX_WEB_SEARCH_PROVIDER, model: "gpt-active" },
    );
    assert.equal(result.text.length, MAX_CODEX_WEB_SEARCH_TEXT_CHARS);
    assert.equal(result.truncated, true);
  });

  it("finishes and cancels the reader as soon as a terminal event arrives", async () => {
    let cancelled = false;
    const encoded = new TextEncoder().encode(`${successSse()}data: not-json\n\n`);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const result = await parseCodexWebSearchSse(
      response,
      { provider: CODEX_WEB_SEARCH_PROVIDER, model: "gpt-active" },
      AbortSignal.timeout(100),
    );
    assert.equal(result.ok, true);
    assert.equal(cancelled, true);
  });

  it("rejects and cancels successful response bodies beyond the byte cap", async () => {
    let cancelled = false;
    const oversized = new Uint8Array(MAX_CODEX_WEB_SEARCH_RESPONSE_BYTES + 1);
    oversized.fill(0x61);
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized);
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    const { context } = makeContext();
    const result = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      ...expireRetryWindowAfterSleep(),
      requestTimeoutMs: 20,
      fetchImpl: (async () => response) as typeof fetch,
    });

    assert.equal(result.failure?.classification, "schema");
    assert.equal(cancelled, true);
  });

  it("enforces source count and answer omission independently of provider output", async () => {
    const response = {
      id: "resp-adversarial-controls",
      status: "completed",
      output: [
        {
          type: "web_search_call",
          action: {
            type: "search",
            queries: ["fixture query"],
            sources: [
              { type: "url", url: "https://example.com/one" },
              { type: "url", url: "https://example.com/two" },
            ],
          },
        },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: "provider synthesized answer that must be hidden",
            annotations: [
              { type: "url_citation", title: "One", url: "https://example.com/one" },
              { type: "url_citation", title: "Two", url: "https://example.com/two" },
              { type: "url_citation", title: "One duplicate", url: "https://example.com/one" },
            ],
          }],
        },
      ],
    };
    const { context } = makeContext();
    const result = await executeCodexWebSearch({
      query: "safe query",
      max_results: 1,
      include_answer: false,
    }, {
      context,
      fetchImpl: (async () => sseResponse(sseEvent({ type: "response.completed", response }))) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, "Sources:\n- One: https://example.com/one");
    assert.deepEqual(result.citations, [{ title: "One", url: "https://example.com/one" }]);
    assert.deepEqual(result.webActions, [{
      type: "search",
      queries: ["fixture query"],
      sources: ["https://example.com/one"],
    }]);
    assert.doesNotMatch(result.text, /provider synthesized answer/);
  });

  it("uses SSE event names when Codex omits type from data payloads", async () => {
    const body = [
      'event: response.output_item.done\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"event-framed answer","annotations":[{"type":"url_citation","title":"RFC Editor","url":"https://www.rfc-editor.org/rfc/rfc9110"}]}]}}\n\n',
      'event: response.completed\ndata: {"response":{"id":"resp-event-framed","status":"completed","usage":{"input_tokens":4,"output_tokens":5,"total_tokens":9}}}\n\n',
    ].join("");
    const result = await parseCodexWebSearchSse(
      sseResponse(body),
      { provider: CODEX_WEB_SEARCH_PROVIDER, model: "gpt-active" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.text, "event-framed answer\n\nSources:\n- RFC Editor: https://www.rfc-editor.org/rfc/rfc9110");
    assert.equal(result.responseId, "resp-event-framed");
    assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 5, totalTokens: 9 });
  });

  it("caps model-facing output at 50,000 characters", async () => {
    const answer = "x".repeat(MAX_CODEX_WEB_SEARCH_TEXT_CHARS + 500);
    const result = await parseCodexWebSearchSse(
      sseResponse(successSse({ answer })),
      { provider: CODEX_WEB_SEARCH_PROVIDER, model: "gpt-active" },
    );
    assert.equal(result.text.length, MAX_CODEX_WEB_SEARCH_TEXT_CHARS);
    assert.equal(result.truncated, true);
  });

  it("classifies malformed, unterminated, and failed streams without provider text", async () => {
    const cases = [
      { body: "data: not-json\n\n", classification: "schema" },
      { body: sseEvent({ type: "response.output_text.delta", delta: "partial" }), classification: "schema" },
      {
        body: sseEvent({
          type: "response.failed",
          response: { error: { code: "rate_limit_exceeded", message: "private provider body" } },
        }),
        classification: "rate_limit",
      },
      {
        body: sseEvent({ type: "response.output_text.delta", delta: "partial" }) + sseEvent({
          type: "response.incomplete",
          response: { id: "resp-incomplete", status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
        }),
        classification: "unknown",
      },
    ];
    const { context } = makeContext();
    for (const entry of cases) {
      const result = await executeCodexWebSearch({ query: "safe query" }, {
        context,
        ...expireRetryWindowAfterSleep(),
        fetchImpl: (async () => sseResponse(entry.body)) as typeof fetch,
      });
      assert.equal(result.failure?.classification, entry.classification);
      assert.doesNotMatch(result.text, /private provider body|rate_limit_exceeded|not-json|partial/);
    }
  });
});

describe("Codex web search retries", () => {
  it("recovers after three 429s using numeric, HTTP-date, and fallback delays while cleaning bodies", async () => {
    const wallStart = Date.UTC(2026, 8, 2, 12);
    const clock = makeVirtualRetryClock(wallStart);
    const { context, calls } = makeContext();
    const warnings: CodexWebSearchWarn[] = [];
    const retryHeaders = [
      "2",
      new Date(wallStart + 7_000).toUTCString(),
      "invalid-retry-after",
    ];
    let fetchCalls = 0;
    let cancelledBodies = 0;
    const result = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      ...clock,
      warn: (event) => warnings.push(event),
      fetchImpl: (async () => {
        const retryAfter = retryHeaders[fetchCalls];
        fetchCalls += 1;
        if (retryAfter === undefined) return sseResponse(successSse());
        return new Response(new ReadableStream({
          cancel() { cancelledBodies += 1; },
        }), { status: 429, headers: { "Retry-After": retryAfter } });
      }) as typeof fetch,
    });

    assert.equal(result.ok, true);
    assert.equal(fetchCalls, 4);
    assert.deepEqual(clock.delays, [2_000, 5_000, 1_000]);
    assert.equal(cancelledBodies, 3);
    assert.deepEqual(calls, { isUsingOAuth: 4, getProviderAuth: 4, getRequestAuth: 4 });
    assert.deepEqual(warnings.map((event) => event.detail), [
      "retry-scheduled",
      "retry-scheduled",
      "retry-scheduled",
    ]);
  });

  it("recovers from timeout, transport, 5xx, and provider-schema failures", async () => {
    const cases: Array<{
      name: string;
      failure(): Response | never;
      classification: string;
    }> = [
      { name: "timeout", failure: () => new Response(null, { status: 408 }), classification: "timeout" },
      {
        name: "transport",
        failure: () => { throw new TypeError("private transport detail"); },
        classification: "transport",
      },
      { name: "5xx", failure: () => new Response(null, { status: 503 }), classification: "transport" },
      {
        name: "provider schema",
        failure: () => sseResponse("data: not-json\n\n"),
        classification: "schema",
      },
    ];

    for (const entry of cases) {
      const clock = makeVirtualRetryClock();
      const { context } = makeContext();
      const warnings: CodexWebSearchWarn[] = [];
      let fetchCalls = 0;
      const result = await executeCodexWebSearch({ query: "safe query" }, {
        context,
        ...clock,
        warn: (event) => warnings.push(event),
        fetchImpl: (async () => {
          fetchCalls += 1;
          return fetchCalls === 1 ? entry.failure() : sseResponse(successSse());
        }) as typeof fetch,
      });
      assert.equal(result.ok, true, entry.name);
      assert.equal(fetchCalls, 2, entry.name);
      assert.deepEqual(clock.delays, [250], entry.name);
      assert.equal(warnings[0]?.classification, entry.classification, entry.name);
    }
  });

  it("resolves refreshed OAuth before every retry attempt", async () => {
    const clock = makeVirtualRetryClock();
    let authAttempt = 0;
    let activeToken = "";
    const authorizationHeaders: string[] = [];
    const context: CodexWebSearchExecutionContext = {
      model: { provider: CODEX_WEB_SEARCH_PROVIDER, id: "gpt-refresh", api: "openai-codex-responses" },
      modelRegistry: {
        isUsingOAuth: () => true,
        getProviderAuth: async () => {
          authAttempt += 1;
          activeToken = codexOAuthToken("account-refresh", `attempt-${authAttempt}`);
          return { auth: { apiKey: activeToken } };
        },
        getApiKeyAndHeaders: async () => ({ ok: true, apiKey: activeToken }),
      },
    };
    const result = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      ...clock,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        authorizationHeaders.push((init?.headers as Record<string, string>).Authorization);
        return authorizationHeaders.length < 3
          ? new Response(null, { status: 503 })
          : sseResponse(successSse());
      }) as typeof fetch,
    });

    assert.equal(result.ok, true);
    assert.equal(authAttempt, 3);
    assert.equal(new Set(authorizationHeaders).size, 3);
    assert.deepEqual(clock.delays, [250, 500]);
  });

  it("has no hidden attempt cap and succeeds after more than forty retries", async () => {
    const clock = makeVirtualRetryClock();
    const { context, calls } = makeContext();
    let fetchCalls = 0;
    const result = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      ...clock,
      sleep: async (delayMs) => { clock.delays.push(delayMs); clock.advance(1); },
      fetchImpl: (async () => {
        fetchCalls += 1;
        return fetchCalls <= 41
          ? new Response(null, { status: 503 })
          : sseResponse(successSse());
      }) as typeof fetch,
    });

    assert.equal(result.ok, true);
    assert.equal(fetchCalls, 42);
    assert.equal(clock.delays.length, 41);
    assert.equal(calls.getProviderAuth, 42);
    assert.ok(clock.now() < CODEX_WEB_SEARCH_RETRY_WINDOW_MS);
  });

  it("exhausts at the strict ten-minute boundary without real waiting", async () => {
    const { context } = makeContext();
    let elapsed = 0;
    let fetchCalls = 0;
    const warnings: CodexWebSearchWarn[] = [];
    const result = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      now: () => elapsed,
      random: () => 0,
      sleep: async () => { elapsed = CODEX_WEB_SEARCH_RETRY_WINDOW_MS; },
      warn: (event) => warnings.push(event),
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response(null, { status: 503 });
      }) as typeof fetch,
    });

    assert.equal(result.failure?.classification, "transport");
    assert.equal(fetchCalls, 1);
    assert.equal(warnings.at(-1)?.detail, "retry-exhausted");
    assert.equal(warnings.at(-1)?.elapsedMs, CODEX_WEB_SEARCH_RETRY_WINDOW_MS);
  });

  it("does not wait when Retry-After exceeds the remaining window", async () => {
    const clock = makeVirtualRetryClock();
    const { context } = makeContext();
    let fetchCalls = 0;
    const result = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      ...clock,
      fetchImpl: (async () => {
        fetchCalls += 1;
        clock.advance(CODEX_WEB_SEARCH_RETRY_WINDOW_MS - 1_000);
        return new Response(null, { status: 429, headers: { "Retry-After": "2" } });
      }) as typeof fetch,
    });

    assert.equal(result.failure?.classification, "rate_limit");
    assert.equal(fetchCalls, 1);
    assert.deepEqual(clock.delays, []);
  });

  it("clamps the final request timeout to the remaining retry window", async () => {
    const clock = makeVirtualRetryClock();
    const { context } = makeContext();
    const timeouts: number[] = [];
    let fetchCalls = 0;
    const result = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      ...clock,
      sleep: async () => { clock.setElapsed(CODEX_WEB_SEARCH_RETRY_WINDOW_MS - 123); },
      createRequestSignal: (parent, timeoutMs) => {
        timeouts.push(timeoutMs);
        const controller = new AbortController();
        const abort = (): void => controller.abort(parent?.reason);
        parent?.addEventListener("abort", abort, { once: true });
        return {
          signal: controller.signal,
          didTimeout: () => false,
          parentAborted: () => parent?.aborted ?? false,
          cancel: () => parent?.removeEventListener("abort", abort),
        };
      },
      fetchImpl: (async () => {
        fetchCalls += 1;
        return fetchCalls === 1
          ? new Response(null, { status: 503 })
          : sseResponse(successSse());
      }) as typeof fetch,
    });

    assert.equal(result.ok, true);
    assert.deepEqual(timeouts, [60_000, 123]);
  });

  it("stops immediately when the caller aborts during a request or backoff", async () => {
    {
      const { context } = makeContext();
      const parent = new AbortController();
      let fetchCalls = 0;
      const pending = executeCodexWebSearch({ query: "safe query" }, {
        context,
        fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
          fetchCalls += 1;
          const requestSignal = init?.signal as AbortSignal;
          return new Promise<Response>((_resolve, reject) => {
            requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
          });
        }) as typeof fetch,
      }, parent.signal);
      setImmediate(() => parent.abort(new Error("caller cancelled request")));
      const result = await pending;
      assert.equal(result.failure?.classification, "transport");
      assert.equal(fetchCalls, 1);
    }

    {
      const clock = makeVirtualRetryClock();
      const { context } = makeContext();
      const parent = new AbortController();
      let fetchCalls = 0;
      const result = await executeCodexWebSearch({ query: "safe query" }, {
        context,
        ...clock,
        sleep: async (_delayMs, waitSignal) => {
          parent.abort(new Error("caller cancelled backoff"));
          throw waitSignal?.reason;
        },
        fetchImpl: (async () => {
          fetchCalls += 1;
          return new Response(null, { status: 429 });
        }) as typeof fetch,
      }, parent.signal);
      assert.equal(result.failure?.classification, "rate_limit");
      assert.equal(fetchCalls, 1);
    }
  });

  it("does not retry invalid input, blocked egress, auth, or ordinary 4xx failures", async () => {
    for (const query of [42, "read /private/project/file.ts"] as const) {
      const { context, calls } = makeContext();
      let fetchCalls = 0;
      await executeCodexWebSearch({ query } as never, {
        context,
        fetchImpl: (async () => { fetchCalls += 1; return sseResponse(successSse()); }) as typeof fetch,
      });
      assert.equal(calls.getProviderAuth, 0);
      assert.equal(fetchCalls, 0);
    }

    const terminalCases = [
      { status: 401, classification: "auth" },
      { status: 418, classification: "unknown" },
    ] as const;
    for (const entry of terminalCases) {
      const clock = makeVirtualRetryClock();
      const { context } = makeContext();
      let fetchCalls = 0;
      const result = await executeCodexWebSearch({ query: "safe query" }, {
        context,
        ...clock,
        fetchImpl: (async () => {
          fetchCalls += 1;
          return new Response(null, { status: entry.status });
        }) as typeof fetch,
      });
      assert.equal(result.failure?.classification, entry.classification);
      assert.equal(fetchCalls, 1);
      assert.deepEqual(clock.delays, []);
    }

    const { context } = makeContext({ providerAuthOk: false });
    let fetchCalls = 0;
    const auth = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      fetchImpl: (async () => { fetchCalls += 1; return sseResponse(successSse()); }) as typeof fetch,
    });
    assert.equal(auth.failure?.classification, "auth");
    assert.equal(fetchCalls, 0);
  });
});

describe("Codex web search cleanup and bounded failures", () => {
  it("classifies HTTP failures and cancels bodies when status is sufficient", async () => {
    const expected = new Map([
      [401, "auth"],
      [403, "auth"],
      [408, "timeout"],
      [429, "rate_limit"],
      [503, "transport"],
    ]);
    for (const [status, classification] of expected) {
      let cancelled = false;
      const response = new Response(new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }), { status });
      const { context } = makeContext();
      const result = await executeCodexWebSearch({ query: "safe query" }, {
        context,
        ...expireRetryWindowAfterSleep(),
        fetchImpl: (async () => response) as typeof fetch,
      });
      assert.equal(result.failure?.classification, classification, String(status));
      assert.equal(result.failure?.httpStatus, status);
      assert.equal(cancelled, true);
    }
  });

  it("classifies bounded provider error codes independently of HTTP status", async () => {
    for (const [code, classification] of [
      ["usage_limit_reached", "rate_limit"],
      ["usage_not_included", "rate_limit"],
      ["rate_limit_exceeded", "rate_limit"],
      ["authentication_error", "auth"],
    ] as const) {
      const { context } = makeContext();
      const result = await executeCodexWebSearch({ query: "safe query" }, {
        context,
        ...expireRetryWindowAfterSleep(),
        fetchImpl: (async () => new Response(JSON.stringify({
          error: { code, message: "private provider diagnostic" },
        }), { status: 400 })) as typeof fetch,
      });
      assert.equal(result.failure?.classification, classification, code);
      assert.equal(result.failure?.httpStatus, 400);
      assert.doesNotMatch(result.text, /private provider diagnostic|usage_limit|authentication_error/);
    }

    const { context } = makeContext();
    const unknown = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      fetchImpl: (async () => new Response(JSON.stringify({
        error: { code: "unrecognized_code", message: "private provider diagnostic" },
      }), { status: 400 })) as typeof fetch,
    });
    assert.equal(unknown.failure?.classification, "unknown");
    assert.doesNotMatch(unknown.text, /private provider diagnostic|unrecognized_code/);
  });

  it("classifies transport, unknown, and timeout failures", async () => {
    const { context } = makeContext();
    const transport = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      ...expireRetryWindowAfterSleep(),
      fetchImpl: (async () => { throw new TypeError("private transport details"); }) as typeof fetch,
    });
    assert.equal(transport.failure?.classification, "transport");
    assert.doesNotMatch(transport.text, /private transport details/);

    const unknown = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      fetchImpl: (async () => { throw new Error("private unknown details"); }) as typeof fetch,
    });
    assert.equal(unknown.failure?.classification, "unknown");
    assert.doesNotMatch(unknown.text, /private unknown details/);

    let requestSignal: AbortSignal | undefined;
    const timeout = await executeCodexWebSearch({ query: "safe query" }, {
      context,
      ...expireRetryWindowAfterSleep(),
      requestTimeoutMs: 5,
      fetchImpl: ((_url: string | URL | Request, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
        });
      }) as typeof fetch,
    });
    assert.equal(timeout.failure?.classification, "timeout");
    assert.equal(requestSignal?.aborted, true);
  });

  it("detaches parent cancellation and cancels response readers", async () => {
    const parent = new AbortController();
    const bounded = createBoundedCodexSearchSignal(parent.signal, 1_000);
    bounded.cancel();
    parent.abort();
    assert.equal(bounded.signal.aborted, false);

    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }), { status: 500 });
    await cancelCodexWebSearchResponse(response);
    assert.equal(cancelled, true);
  });

  it("bounds OAuth resolution before fetch and honors parent cancellation", async () => {
    for (const resolver of ["provider", "request"] as const) {
      for (const mode of ["timeout", "parent"] as const) {
        const { context } = makeContext();
        if (resolver === "provider") {
          context.modelRegistry.getProviderAuth = async () => new Promise(() => {});
        } else {
          context.modelRegistry.getApiKeyAndHeaders = async () => new Promise(() => {});
        }
        const parent = new AbortController();
        let fetchCalls = 0;
        const pending = executeCodexWebSearch({ query: "safe query" }, {
          context,
          ...expireRetryWindowAfterSleep(),
          requestTimeoutMs: mode === "timeout" ? 5 : 1_000,
          fetchImpl: (async () => {
            fetchCalls += 1;
            throw new Error("must not fetch");
          }) as typeof fetch,
        }, parent.signal);
        if (mode === "parent") setImmediate(() => parent.abort(new Error("cancelled by caller")));
        const result = await pending;
        assert.equal(result.failure?.classification, mode === "timeout" ? "timeout" : "transport");
        assert.equal(fetchCalls, 0);
      }
    }
  });

  it("cancels live SSE readers on timeout and parent cancellation", async () => {
    for (const mode of ["timeout", "parent"] as const) {
      const { context } = makeContext();
      const parent = new AbortController();
      let cancelled = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      const pending = executeCodexWebSearch({ query: "safe query" }, {
        context,
        ...expireRetryWindowAfterSleep(),
        requestTimeoutMs: mode === "timeout" ? 5 : 1_000,
        fetchImpl: (async () => response) as typeof fetch,
      }, parent.signal);
      if (mode === "parent") setImmediate(() => parent.abort(new Error("cancelled by caller")));
      const result = await pending;
      assert.equal(result.failure?.classification, mode === "timeout" ? "timeout" : "transport");
      assert.equal(cancelled, true);
    }
  });

  it("covers every private-query branch and length boundary before auth or fetch", async () => {
    const commonSecretPrefix = ["gh", "p_"].join("");
    const blocked = [
      "a".repeat(MAX_CODEX_WEB_SEARCH_QUERY_CHARS + 1),
      "line one\nline two",
      "```private code```",
      "-----BEGIN PRIVATE KEY-----",
      "Bearer abcdefghijklmnopqrstuvwxyz",
      `${commonSecretPrefix}${"a".repeat(20)}`,
      `eyJ${"a".repeat(12)}.${"b".repeat(12)}.${"c".repeat(8)}`,
      "password=abcd",
      "read /private/project/file.ts",
      "inspect config.local.yaml",
      `search ${"Aa0".repeat(11)}`,
    ];
    const allowed = [
      "a".repeat(MAX_CODEX_WEB_SEARCH_QUERY_CHARS),
      "how bearer auth works",
      "public configuration documentation",
      "token economy in transformers",
    ];
    for (const query of blocked) {
      assert.ok(validateCodexWebSearchQuery(query), query.slice(0, 80));
      const { context, calls } = makeContext();
      let fetchCalls = 0;
      const result = await executeCodexWebSearch({ query }, {
        context,
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.ok, false);
      assert.match(result.text, /blocked/);
      assert.equal(calls.getRequestAuth, 0);
      assert.equal(fetchCalls, 0);
    }
    for (const query of allowed) assert.equal(validateCodexWebSearchQuery(query), undefined, query.slice(0, 80));

    for (const query of ["", "   ", 42]) {
      const { context, calls } = makeContext();
      let fetchCalls = 0;
      const result = await executeCodexWebSearch({ query } as never, {
        context,
        fetchImpl: (async () => {
          fetchCalls += 1;
          throw new Error("must not fetch");
        }) as typeof fetch,
      });
      assert.equal(result.failure?.classification, "schema");
      assert.equal(calls.getRequestAuth, 0);
      assert.equal(fetchCalls, 0);
    }
  });

  it("formats bounded warnings without queries, bodies, or credentials", () => {
    assert.equal(
      formatCodexWebSearchWarn({ classification: "rate_limit", httpStatus: 429, detail: "request-failed" }),
      "[web-tools] tool=web_search provider=openai-codex classification=rate_limit httpStatus=429 detail=request-failed",
    );
    assert.equal(
      formatCodexWebSearchWarn({
        classification: "rate_limit",
        httpStatus: 429,
        detail: "retry-scheduled",
        attempt: 3,
        delayMs: 1_000,
        elapsedMs: 7_000,
      }),
      "[web-tools] tool=web_search provider=openai-codex classification=rate_limit" +
        " httpStatus=429 detail=retry-scheduled attempt=3 delayMs=1000 elapsedMs=7000",
    );
  });
});

describe("Codex web_search Pi wrapper", () => {
  it("registers only web_search and returns sanitized result metadata", async () => {
    const moduleUrl = pathToFileURL(resolve(BOT_DIR, "extensions", "pi", "web-tools.ts")).href;
    const mod = await import(moduleUrl) as {
      default(pi: { registerTool(tool: RegisteredTool): void }): void;
    };
    interface RegisteredTool {
      name: string;
      parameters: { required: readonly string[] };
      execute(
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
        onUpdate: undefined,
        context: CodexWebSearchExecutionContext,
      ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
    }
    const tools: RegisteredTool[] = [];
    const { context } = makeContext({ model: "gpt-wrapper" });
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => sseResponse(successSse())) as typeof fetch;
    try {
      mod.default({ registerTool: (tool) => tools.push(tool) });
      assert.deepEqual(tools.map((tool) => tool.name), ["web_search"]);
      assert.deepEqual([...tools[0].parameters.required], ["query"]);
      const result = await tools[0].execute("call-1", { query: "safe query" }, undefined, undefined, context);
      assert.match(result.content[0].text, /Codex search answer/);
      assert.equal(result.details.ok, true);
      assert.equal(result.details.authType, "oauth");
      assert.equal(result.details.model, "gpt-wrapper");
      assert.equal("text" in result.details, false);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  it("keeps the compatible web-search schema", () => {
    assert.equal(CODEX_WEB_SEARCH_TOOL.name, "web_search");
    assert.equal(CODEX_WEB_SEARCH_TOOL.parameters.properties.query.type, "string");
    assert.equal(CODEX_WEB_SEARCH_TOOL.parameters.properties.include_answer.type, "boolean");
  });
});
