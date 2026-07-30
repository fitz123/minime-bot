let prompt = "";
for await (const chunk of process.stdin) prompt += chunk.toString();
const input = JSON.parse(prompt);
if (
  input.contract !== "minime-ops-conversation-input-v1"
  || typeof input.operator_text !== "string"
) {
  process.stderr.write("invalid fake Ops conversation prompt\n");
  process.exit(64);
}
process.stdout.write(JSON.stringify({
  version: 1,
  kind: "answer",
  language: input.operator_language,
  text: input.operator_language === "ru"
    ? "Локальный тестовый ответ Ops."
    : "Local Ops fixture answer.",
}));
