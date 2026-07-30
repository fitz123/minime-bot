export const OPS_WORKER_CONVERSATION_MAX_OUTPUT_TOKENS = 2_048;
/**
 * UTF-8 is a byte-level tokenizer input, so one emitted model token cannot
 * consume less than one streamed byte. Keeping the streamed response at or
 * below this byte count is therefore also a provider-independent token ceiling.
 */
export const OPS_WORKER_CONVERSATION_MAX_STREAM_BYTES =
  OPS_WORKER_CONVERSATION_MAX_OUTPUT_TOKENS;
export const OPS_WORKER_CONVERSATION_BOUNDS_FAILURE_EXIT_CODE = 78;

const OPENAI_COMPLETION_TOKEN_FIELDS = [
  "max_completion_tokens",
  "max_tokens",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype
      || Object.getPrototypeOf(value) === null);
}

function requireArrayField(
  payload: Record<string, unknown>,
  field: string,
  api: string,
): void {
  if (!Array.isArray(payload[field])) {
    throw new TypeError(`Conversation ${api} payload has invalid ${field}`);
  }
}

function cloneObjectField(
  payload: Record<string, unknown>,
  field: string,
  api: string,
): Record<string, unknown> {
  const value = payload[field];
  if (!isPlainObject(value)) {
    throw new TypeError(`Conversation ${api} payload has invalid ${field}`);
  }
  const cloned = { ...value };
  payload[field] = cloned;
  return cloned;
}

function clampOutputTokenField(
  payload: Record<string, unknown>,
  field: string,
  maximum: number,
): void {
  if (!Object.prototype.hasOwnProperty.call(payload, field)) {
    payload[field] = maximum;
    return;
  }
  const current = payload[field];
  if (typeof current !== "number" || !Number.isFinite(current) || current < 1) {
    throw new TypeError(`Conversation provider payload has invalid ${field}`);
  }
  payload[field] = Math.min(Math.trunc(current), maximum);
}

/**
 * Apply the conversation response-token ceiling at Pi's final provider-payload
 * boundary. The package-owned wrapper exits fail-closed if a future provider
 * payload has no recognizable request shape.
 */
export function boundOpsWorkerConversationProviderPayload(
  payload: unknown,
  api: string,
  maximum = OPS_WORKER_CONVERSATION_MAX_OUTPUT_TOKENS,
): Record<string, unknown> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("Conversation output-token limit must be a positive integer");
  }
  if (!isPlainObject(payload)) {
    throw new TypeError("Conversation provider payload must be a plain object");
  }

  const bounded = { ...payload };
  if (api === "anthropic-messages") {
    requireArrayField(bounded, "messages", api);
    clampOutputTokenField(bounded, "max_tokens", maximum);
    return bounded;
  }
  if (api === "openai-completions") {
    requireArrayField(bounded, "messages", api);
    const fields = OPENAI_COMPLETION_TOKEN_FIELDS.filter((field) =>
      Object.prototype.hasOwnProperty.call(bounded, field));
    if (fields.length !== 1) {
      throw new TypeError(
        "Conversation openai-completions payload must have exactly one output-token field",
      );
    }
    clampOutputTokenField(bounded, fields[0], maximum);
    return bounded;
  }
  if (api === "openai-responses" || api === "azure-openai-responses") {
    requireArrayField(bounded, "input", api);
    clampOutputTokenField(bounded, "max_output_tokens", maximum);
    return bounded;
  }
  if (api === "openai-codex-responses") {
    requireArrayField(bounded, "input", api);
    // The ChatGPT Codex Responses transport rejects max_output_tokens. Its
    // explicit conversation wrapper runs with reasoning off and enforces the
    // same fixed ceiling over streamed UTF-8 bytes instead.
    return bounded;
  }
  if (api === "mistral-conversations") {
    requireArrayField(bounded, "messages", api);
    clampOutputTokenField(bounded, "maxTokens", maximum);
    return bounded;
  }
  if (api === "google-generative-ai" || api === "google-vertex") {
    requireArrayField(bounded, "contents", api);
    const config = cloneObjectField(bounded, "config", api);
    clampOutputTokenField(config, "maxOutputTokens", maximum);
    return bounded;
  }
  if (api === "bedrock-converse-stream") {
    requireArrayField(bounded, "messages", api);
    const inferenceConfig = cloneObjectField(bounded, "inferenceConfig", api);
    clampOutputTokenField(inferenceConfig, "maxTokens", maximum);
    return bounded;
  }
  if (api === "pi-messages") {
    const options = cloneObjectField(bounded, "options", api);
    clampOutputTokenField(options, "maxTokens", maximum);
    return bounded;
  }
  throw new TypeError(`Conversation provider payload uses unsupported provider API ${api}`);
}
