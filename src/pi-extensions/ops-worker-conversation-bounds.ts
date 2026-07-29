export const OPS_WORKER_CONVERSATION_MAX_OUTPUT_TOKENS = 768;
export const OPS_WORKER_CONVERSATION_BOUNDS_FAILURE_EXIT_CODE = 78;

const OUTPUT_TOKEN_FIELDS = [
  "max_output_tokens",
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

/**
 * Apply the conversation response-token ceiling at Pi's final provider-payload
 * boundary. The package-owned wrapper exits fail-closed if a future provider
 * payload has no recognizable request shape.
 */
export function boundOpsWorkerConversationProviderPayload(
  payload: unknown,
  maximum = OPS_WORKER_CONVERSATION_MAX_OUTPUT_TOKENS,
): Record<string, unknown> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new TypeError("Conversation output-token limit must be a positive integer");
  }
  if (!isPlainObject(payload)) {
    throw new TypeError("Conversation provider payload must be a plain object");
  }

  const bounded = { ...payload };
  let recognizedField = false;
  for (const field of OUTPUT_TOKEN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(bounded, field)) continue;
    const current = bounded[field];
    if (typeof current !== "number" || !Number.isFinite(current) || current < 1) {
      throw new TypeError(`Conversation provider payload has invalid ${field}`);
    }
    bounded[field] = Math.min(Math.trunc(current), maximum);
    recognizedField = true;
  }
  if (recognizedField) return bounded;

  if (Array.isArray(bounded.input)) {
    bounded.max_output_tokens = maximum;
    return bounded;
  }
  if (Array.isArray(bounded.messages)) {
    bounded.max_tokens = maximum;
    return bounded;
  }
  throw new TypeError("Conversation provider payload has no recognized output-token field");
}
