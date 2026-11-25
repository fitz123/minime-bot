import { formatCodexQuotaSamplerError, runCodexQuotaSamplerFromCli } from "../src/codex-quota-sampler.js";

runCodexQuotaSamplerFromCli().catch((error: unknown) => {
  console.error(formatCodexQuotaSamplerError(error));
  process.exitCode = 1;
});
