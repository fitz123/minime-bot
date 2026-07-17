import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildCodexWebSearchRequest,
  cancelCodexWebSearchResponse,
  CODEX_WEB_SEARCH_ENDPOINT,
  CODEX_WEB_SEARCH_PROVIDER,
  CODEX_WEB_SEARCH_TOOL,
  createBoundedCodexSearchSignal,
  executeCodexWebSearch,
  formatCodexWebSearchWarn,
  MAX_CODEX_WEB_SEARCH_QUERY_CHARS,
  MAX_CODEX_WEB_SEARCH_TEXT_CHARS,
  parseCodexWebSearchSse,
  resolveCodexWebSearchOAuth,
  validateCodexWebSearchQuery,
  type CodexWebSearchExecutionContext,
} from "../pi-extensions/codex-web-search.js";

const BOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface ContextOptions {
  provider?: string;
  model?: string;
  oauth?: boolean;
  resolvedToken?: string;
  storedToken?: string;
  accountId?: string;
  authOk?: boolean;
}

function makeContext(options: ContextOptions = {}): {
  context: CodexWebSearchExecutionContext;
  calls: { isUsingOAuth: number; getAuth: number; getStored: number };
} {
  const provider = options.provider ?? CODEX_WEB_SEARCH_PROVIDER;
  const model = options.model ?? "gpt-active-codex";
  const resolvedToken = options.resolvedToken ?? "oauth-access-token";
  const storedToken = options.storedToken ?? resolvedToken;
  const calls = { isUsingOAuth: 0, getAuth: 0, getStored: 0 };
  return {
    calls,
    context: {
      model: { provider, id: model, api: "openai-codex-responses" },
      modelRegistry: {
        isUsingOAuth: () => {
          calls.isUsingOAuth += 1;
          return options.oauth ?? true;
        },
        getApiKeyAndHeaders: async () => {
          calls.getAuth += 1;
          if (options.authOk === false) return { ok: false as const, error: "private auth error" };
          return { ok: true as const, apiKey: resolvedToken };
        },
        authStorage: {
          get: () => {
            calls.getStored += 1;
            return {
              type: "oauth",
              access: storedToken,
              accountId: options.accountId ?? "account-fixture",
            };
          },
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

describe("Codex web search auth and request", () => {
  it("resolves the active model's refreshed OAuth token and stored account id", async () => {
    const { context, calls } = makeContext({ model: "gpt-current", accountId: "account-current" });
    const auth = await resolveCodexWebSearchOAuth(context);
    assert.deepEqual(auth, {
      token: "oauth-access-token",
      accountId: "account-current",
      provider: CODEX_WEB_SEARCH_PROVIDER,
      model: "gpt-current",
    });
    assert.deepEqual(calls, { isUsingOAuth: 1, getAuth: 1, getStored: 1 });
  });

  it("rejects non-Codex, non-OAuth, unresolved, and API-key override auth", async () => {
    for (const options of [
      { provider: "openai" },
      { oauth: false },
      { authOk: false },
      { storedToken: "stored-oauth", resolvedToken: "runtime-api-key" },
      { accountId: "" },
    ]) {
      const { context } = makeContext(options);
      assert.equal(await resolveCodexWebSearchOAuth(context), undefined);
    }
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
      assert.equal(headers.Authorization, "Bearer oauth-access-token");
      assert.doesNotMatch(JSON.stringify(calls[0]), /forbidden-environment-key|api\.openai\.com/);
      assert.equal((JSON.parse(String(calls[0].init?.body)) as { model: string }).model, "gpt-live-model");
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }
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
        fetchImpl: (async () => sseResponse(entry.body)) as typeof fetch,
      });
      assert.equal(result.failure?.classification, entry.classification);
      assert.doesNotMatch(result.text, /private provider body|rate_limit_exceeded|not-json|partial/);
    }
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
    for (const mode of ["timeout", "parent"] as const) {
      const { context } = makeContext();
      context.modelRegistry.getApiKeyAndHeaders = async () => new Promise(() => {});
      const parent = new AbortController();
      let fetchCalls = 0;
      const pending = executeCodexWebSearch({ query: "safe query" }, {
        context,
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
      assert.equal(calls.getAuth, 0);
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
      assert.equal(calls.getAuth, 0);
      assert.equal(fetchCalls, 0);
    }
  });

  it("formats bounded warnings without queries, bodies, or credentials", () => {
    assert.equal(
      formatCodexWebSearchWarn({ classification: "rate_limit", httpStatus: 429, detail: "request-failed" }),
      "[web-tools] tool=web_search provider=openai-codex classification=rate_limit httpStatus=429 detail=request-failed",
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
