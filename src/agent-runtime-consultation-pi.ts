import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  ModelRuntime, runRpcMode, SessionManager, SettingsManager,
} from '@earendil-works/pi-coding-agent';

export interface ConsultationPiResources {
  model: string;
  thinking: ThinkingLevel;
  tools: readonly string[];
  extensions: readonly string[];
  systemPrompt: string;
  appendSystemPrompt: string;
}

// The parent launches this entrypoint with the worker's explicit environment.
const resources: ConsultationPiResources = JSON.parse(process.argv[2]);
const cwd = process.cwd();
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error('Pi consultation requires the worker agent directory');
const runtime = await createAgentSessionRuntime(async ({ sessionManager }) => {
  // Pi's default credential store uses PI_CODING_AGENT_DIR. Use its
  // in-memory model catalog to keep model configuration scoped to this call.
  const modelRuntime = await ModelRuntime.create({ modelsPath: null });
  const services = await createAgentSessionServices({
    cwd, agentDir, modelRuntime,
    settingsManager: SettingsManager.inMemory({
      retry: { enabled: false, provider: { maxRetries: 0 } },
      compaction: { enabled: false },
      cacheWarming: 'off',
      // Codex WebSocket resubmissions have a separate budget from SSE retries.
      transport: 'sse',
    }, { projectTrusted: false }),
    resourceLoaderOptions: {
      additionalExtensionPaths: [...resources.extensions],
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: resources.systemPrompt,
      appendSystemPrompt: [resources.appendSystemPrompt],
    },
  });
  const slash = resources.model.indexOf('/');
  const provider = resources.model.slice(0, slash);
  const model = modelRuntime.getModel(provider, resources.model.slice(slash + 1));
  if (!model || !modelRuntime.isUsingSubscription(provider)) {
    throw new Error('Pi consultation requires the explicit model and its worker subscription');
  }
  // Anthropic can resubmit a strict-tool rejection or request model fallbacks
  // independently of maxRetries. Override that model's request capabilities locally.
  const requestModel = model.api === 'anthropic-messages'
    ? { ...model, compat: { ...model.compat, supportsStrictTools: false, allowedFallbackModels: [] } }
    : model;
  const session = await createAgentSessionFromServices({
    services, sessionManager, model: requestModel, thinkingLevel: resources.thinking, tools: [...resources.tools],
  });
  return { ...session, services, diagnostics: services.diagnostics };
}, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd) });
await runRpcMode(runtime);
