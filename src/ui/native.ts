import {
  createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices,
  InteractiveMode, ModelRuntime, SessionManager, SettingsManager,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';
import { InMemoryModelsStore } from '@earendil-works/pi-ai';
import { AUTH_FILE, CONTROLLER_DIR, CONTROLLER_WORKSPACE, endpointIdentity, prepareControllerDirectory } from '../pi/project.js';
import type { BenchConfig } from '../config.js';
import { controllerExtension, type ControllerOptions } from './controller.js';
import { NativeSecretPrompts } from './secret.js';

/** Must be imported after PI_CODING_AGENT_DIR is set by the launcher. */
export async function createWorkbench(config: BenchConfig, demo = false, overrides: Pick<ControllerOptions, 'persist'|'makeRunner'|'autoInspect'> = {}) {
  if (process.env.PI_CODING_AGENT_DIR !== CONTROLLER_DIR) throw new Error('Native pi must run with the project agent directory.');
  await prepareControllerDirectory();
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager, sessionStartEvent }) => {
    const secretPrompts = new NativeSecretPrompts();
    const settingsManager = SettingsManager.inMemory({
      defaultTools: [], packages: [], extensions: [], skills: [], prompts: [], themes: [],
      defaultProvider: endpointIdentity(config), defaultModel: config.model, defaultThinkingLevel: config.thinking,
      defaultProjectTrust: 'never', cacheWarming: 'off', quietStartup: true, tuiMode: 'fullscreen',
      compaction: { enabled: false }, retry: { enabled: false },
    });
    const modelRuntime = await ModelRuntime.create({
      authPath: AUTH_FILE, modelsPath: null, modelsStore: new InMemoryModelsStore(),
      // Native /login refreshes with this policy; initial startup remains offline.
      allowModelNetwork: !demo, refreshOnCreate: false,
    });
    secretPrompts.attach(modelRuntime);
    // Keep pi's background network activity disabled via PI_OFFLINE, but let its
    // explicit /login and /model actions refresh our registered endpoint catalog.
    // ModelRuntime 1.5 reads PI_OFFLINE at construction, irrespective of
    // allowModelNetwork. Set policy through its public refresh API here.
    const refresh = modelRuntime.refresh.bind(modelRuntime);
    modelRuntime.refresh = options => refresh({
      ...options, allowNetwork: options?.allowNetwork ?? !demo,
      providers: options?.providers ?? modelRuntime.getRegisteredProviderIds(),
    });
    // Defense in depth: even an input path that bypasses extension input hooks
    // must not send a control-plane model request. Only the RPC player may do so.
    const noModelRequests = (): never => { throw new Error('Control-plane model requests are disabled. Use /start.'); };
    modelRuntime.stream = noModelRequests;
    modelRuntime.streamSimple = noModelRequests;
    modelRuntime.complete = noModelRequests;
    modelRuntime.completeSimple = noModelRequests;
    const services = await createAgentSessionServices({
      cwd: CONTROLLER_WORKSPACE, agentDir: CONTROLLER_DIR, settingsManager, modelRuntime,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [controllerExtension({ config, demo, secretPrompts, autoInspect: !demo, ...overrides })],
        systemPrompt: 'This is a command-only HackingBench control plane. Model requests are disabled.',
      },
    });
    return {
      ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, tools: [], noTools: 'all' }),
      services, diagnostics: services.diagnostics,
    };
  };
  return createAgentSessionRuntime(createRuntime, {
    cwd: CONTROLLER_WORKSPACE, agentDir: CONTROLLER_DIR, sessionManager: SessionManager.inMemory(CONTROLLER_WORKSPACE),
  });
}
export async function runNative(config: BenchConfig, demo: boolean): Promise<void> {
  const runtime = await createWorkbench(config, demo);
  const mode = new InteractiveMode(runtime, { tuiMode: 'fullscreen' });
  try { await mode.run(); }
  finally { mode.stop(); await runtime.dispose(); }
}
