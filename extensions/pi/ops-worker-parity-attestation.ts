/**
 * Ops-worker-only context/capability parity gate.
 *
 * It runs at Pi's structured before_agent_start boundary, writes only hashes,
 * and waits for a package-owned parent acknowledgement before allowing the
 * provider request to start. It is not part of normal primary RPC sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  captureCodexQuotaFromProviderResponse,
  formatCodexQuotaWriteError,
} from "../../src/pi-extensions/codex-usage.js";
import {
  OPS_WORKER_PARITY_ACK_PATH_ENV,
  OPS_WORKER_PARITY_EXPECTED_PATH_ENV,
  OPS_WORKER_PARITY_FAILURE_EXIT_CODE,
  OPS_WORKER_PARITY_PROBE_ENV,
  OPS_WORKER_PARITY_REPORT_PATH_ENV,
  attestOpsWorkerPiParity,
  readExpectedOpsWorkerParityContract,
  waitForOpsWorkerParityAck,
  writeOpsWorkerParityReport,
} from "../../src/pi-extensions/ops-worker-parity-attestation.js";

const RESOURCE_MARKER_COMMAND = "minime-ops-parity-resource";

export default function (pi: ExtensionAPI): void {
  // The command's SourceInfo is supported active resource metadata. It makes
  // this handler-only extension attestable without exposing its host path.
  pi.registerCommand(RESOURCE_MARKER_COMMAND, { handler: async () => {} });

  pi.on("before_agent_start", async (event) => {
    const expectedPath = process.env[OPS_WORKER_PARITY_EXPECTED_PATH_ENV];
    const reportPath = process.env[OPS_WORKER_PARITY_REPORT_PATH_ENV];
    const ackPath = process.env[OPS_WORKER_PARITY_ACK_PATH_ENV];
    if (!expectedPath || !reportPath || !ackPath) {
      process.exit(OPS_WORKER_PARITY_FAILURE_EXIT_CODE);
    }
    try {
      const expected = readExpectedOpsWorkerParityContract(expectedPath);
      const report = attestOpsWorkerPiParity(expected, {
        systemPromptOptions: event.systemPromptOptions,
        activeToolNames: pi.getActiveTools(),
        allTools: pi.getAllTools(),
        commands: pi.getCommands(),
      });
      writeOpsWorkerParityReport(reportPath, report);
      if (process.env[OPS_WORKER_PARITY_PROBE_ENV] === "1") {
        process.exit(report.status === "PASS" ? 0 : OPS_WORKER_PARITY_FAILURE_EXIT_CODE);
      }
      if (
        report.status !== "PASS"
        || !(await waitForOpsWorkerParityAck(ackPath, expected.digest))
      ) process.exit(OPS_WORKER_PARITY_FAILURE_EXIT_CODE);
    } catch {
      // Pi contains extension handler errors and could otherwise continue to the
      // provider. This gate must terminate on every malformed or I/O failure.
      process.exit(OPS_WORKER_PARITY_FAILURE_EXIT_CODE);
    }
  });

  pi.on("after_provider_response", (...args: unknown[]) => {
    const event = args.length === 1 ? args[0] : args;
    const result = captureCodexQuotaFromProviderResponse(event);
    if (result.status === "write_error") {
      // eslint-disable-next-line no-console -- bounded package-owned capture failure
      console.warn(formatCodexQuotaWriteError(result.error));
    }
  });
}
