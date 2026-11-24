export const MINIME_CRON_UNRESOLVED_MARKER = "[[MINIME_CRON_UNRESOLVED_V1]]";

export function buildCronSystemInstruction(): string {
  const today = new Date().toISOString().split("T")[0];
  return [
    `Today is ${today}. Respond concisely.`,
    `Cron jobs always run with Fast off. Preserve the cron environment in child processes; direct absolute Codex CLI calls must include -c 'service_tier="default"'.`,
    `If your final report has an unresolved finding, add ${MINIME_CRON_UNRESOLVED_MARKER} as its exact standalone final non-empty line. Do not use this marker otherwise.`,
  ].join(" ");
}
