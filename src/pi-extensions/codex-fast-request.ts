/**
 * Copied from @llblab/pi-codex-usage 0.13.2, lib/fast.ts (applyFastToRequest only).
 * https://github.com/llblab/pi-codex-usage/blob/main/lib/fast.ts
 * MIT copyright (c) 2026 narumiruna and llblab; see extensions/pi/codex-fast-LICENSE.md (also shipped under dist/).
 */
export function applyFastToRequest(payload: unknown, modelId: string, enabled: boolean): unknown {
  if (!enabled || !payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (body.model !== modelId || "service_tier" in body) return undefined;
  return { ...body, service_tier: "priority" };
}
