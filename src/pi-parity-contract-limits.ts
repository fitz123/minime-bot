export const OPS_WORKER_PARITY_MAX_CONTRACT_BYTES = 32 * 1024;
export const OPS_WORKER_PARITY_MAX_IDENTITIES = 128;
export const OPS_WORKER_PARITY_MAX_TOOL_NAMES = 128;

const REPRESENTATIVE_SHA256 = `sha256:${"0".repeat(64)}`;

/**
 * Keep startup resource validation inside the exact bounds enforced by the
 * child parity protocol. The parity gate itself consumes one extension slot.
 */
export function assertOpsWorkerParityContractRepresentable(input: {
  extensionIdentities: readonly string[];
  skillIdentities: readonly string[];
  toolNames: readonly string[];
  additionalExtensionIdentities?: number;
}): void {
  const additionalExtensionIdentities = input.additionalExtensionIdentities ?? 0;
  if (
    !Number.isSafeInteger(additionalExtensionIdentities)
    || additionalExtensionIdentities < 0
  ) throw new TypeError("Additional parity extension count must be a non-negative integer");
  const extensionCount = input.extensionIdentities.length + additionalExtensionIdentities;
  if (extensionCount > OPS_WORKER_PARITY_MAX_IDENTITIES) {
    throw new TypeError(
      `Primary Pi extensions plus parity gate must not exceed ${OPS_WORKER_PARITY_MAX_IDENTITIES}`,
    );
  }
  if (input.skillIdentities.length > OPS_WORKER_PARITY_MAX_IDENTITIES) {
    throw new TypeError(
      `Primary Pi skills must not exceed ${OPS_WORKER_PARITY_MAX_IDENTITIES}`,
    );
  }
  if (input.toolNames.length > OPS_WORKER_PARITY_MAX_TOOL_NAMES) {
    throw new TypeError(
      `Primary Pi tools must not exceed ${OPS_WORKER_PARITY_MAX_TOOL_NAMES}`,
    );
  }

  const representative = {
    version: 1,
    primaryContextDigest: REPRESENTATIVE_SHA256,
    customPromptHash: REPRESENTATIVE_SHA256,
    appendSystemPromptHash: REPRESENTATIVE_SHA256,
    contextFilesDigest: REPRESENTATIVE_SHA256,
    extensionIdentities: [
      ...input.extensionIdentities,
      ...Array.from({ length: additionalExtensionIdentities }, () => REPRESENTATIVE_SHA256),
    ].sort(),
    skillIdentities: [...input.skillIdentities].sort(),
    toolNames: [...input.toolNames].sort(),
    extensionsDigest: REPRESENTATIVE_SHA256,
    skillsDigest: REPRESENTATIVE_SHA256,
    toolsDigest: REPRESENTATIVE_SHA256,
    capabilityDigest: REPRESENTATIVE_SHA256,
    digest: REPRESENTATIVE_SHA256,
  };
  const serializedBytes = Buffer.byteLength(`${JSON.stringify(representative)}\n`, "utf8");
  if (serializedBytes > OPS_WORKER_PARITY_MAX_CONTRACT_BYTES) {
    throw new TypeError(
      `Primary Pi resources exceed the ${OPS_WORKER_PARITY_MAX_CONTRACT_BYTES}-byte parity contract limit`,
    );
  }
}
