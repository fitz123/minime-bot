export const PI_ACKNOWLEDGED_STEER_COMMAND = "minime-acknowledged-steer";
export const PI_ACKNOWLEDGED_STEER_CUSTOM_TYPE = "minime-acknowledged-steer";
export const PI_ACKNOWLEDGED_STEER_RESULT_EVENT = "minime_acknowledged_steer_result";
export const PI_ACKNOWLEDGED_STEER_RESULT_PREFIX =
  `${PI_ACKNOWLEDGED_STEER_RESULT_EVENT}:`;

export interface PiAcknowledgedSteerEnvelope {
  id: string;
  text: string;
}

export interface PiAcknowledgedSteerResultEnvelope {
  id: string;
  success: boolean;
}

export function buildPiAcknowledgedSteerInvocation(id: string, text: string): string {
  const encoded = Buffer.from(JSON.stringify({ id, text }), "utf8").toString("base64url");
  return `/${PI_ACKNOWLEDGED_STEER_COMMAND} ${encoded}`;
}

export function parsePiAcknowledgedSteerEnvelope(
  encoded: string,
): PiAcknowledgedSteerEnvelope | null {
  try {
    const parsed = JSON.parse(
      Buffer.from(encoded.trim(), "base64url").toString("utf8"),
    ) as Partial<PiAcknowledgedSteerEnvelope>;
    if (
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      typeof parsed.text !== "string"
    ) {
      return null;
    }
    return { id: parsed.id, text: parsed.text };
  } catch {
    return null;
  }
}

export function buildPiAcknowledgedSteerResultNotice(
  id: string,
  success: boolean,
): string {
  const encoded = Buffer.from(JSON.stringify({ id, success }), "utf8").toString(
    "base64url",
  );
  return `${PI_ACKNOWLEDGED_STEER_RESULT_PREFIX}${encoded}`;
}

export function parsePiAcknowledgedSteerResultNotice(
  notice: string,
): PiAcknowledgedSteerResultEnvelope | null {
  if (!notice.startsWith(PI_ACKNOWLEDGED_STEER_RESULT_PREFIX)) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(
        notice.slice(PI_ACKNOWLEDGED_STEER_RESULT_PREFIX.length),
        "base64url",
      ).toString("utf8"),
    ) as Partial<PiAcknowledgedSteerResultEnvelope>;
    if (
      typeof parsed.id !== "string" ||
      parsed.id.length === 0 ||
      typeof parsed.success !== "boolean"
    ) {
      return null;
    }
    return { id: parsed.id, success: parsed.success };
  } catch {
    return null;
  }
}
