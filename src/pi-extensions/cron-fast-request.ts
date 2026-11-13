/** Cron processing is always normal, independent of interactive Fast preferences. */
export function applyCronFastOffToRequest(payload: unknown, modelId: string): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (body.model !== modelId) return undefined;
  return { ...body, service_tier: "default" };
}
