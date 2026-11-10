/**
 * Codex quota usage Pi extension wrapper.
 *
 * Compatibility hook for callers that explicitly capture provider headers.
 * The quota sampler now uses GET /wham/usage directly and does not load this hook.
 */

import {
  captureCodexQuotaFromProviderResponse,
  formatCodexQuotaWriteError,
} from "../../src/pi-extensions/codex-usage.js";

interface PiExtensionLike {
  on: (eventName: string, handler: (...args: unknown[]) => unknown) => void;
}

export default function (pi: PiExtensionLike): void {
  pi.on("after_provider_response", (event: unknown) => {
    const result = captureCodexQuotaFromProviderResponse(event);
    if (result.status === "write_error") {
      // eslint-disable-next-line no-console -- structured warning for the explicitly loaded compatibility capture hook
      console.warn(formatCodexQuotaWriteError(result.error));
    }
  });
}
