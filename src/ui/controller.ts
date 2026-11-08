import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type AutocompleteItem } from "@earendil-works/pi-tui";
import { configSchema, saveConfig, type BenchConfig } from "../config.js";
import { RunController } from "../runner.js";
import { endpointIdentity, projectKey, literalApiKey } from "../pi/project.js";
import {
  discoverModels,
  manualModel,
  piModel,
  readModelCache,
  saveModelCache,
  modelIdSchema,
} from "../pi/discovery.js";
import { inspect } from "../environment.js";
import { prepareGame } from "../game/setup.js";
import { report } from "../report.js";
import { testProvider } from "../provider.js";
import { redact, terminalText } from "../core/safety.js";
import {
  appendDashboard,
  dashboardLines,
  deckFooter,
  emptyDashboard,
  observeDashboard,
} from "./dashboard.js";
import { BenchEditor } from "./editor.js";
import { mountDeckLayout } from "./layout.js";
import { nativeFeedback } from "./feedback.js";
import {
  BENCH_SETTINGS,
  benchSetting,
  changeSetting,
  configCompletions,
  settingValue,
  type BenchSetting,
} from "./settings.js";
import type { NativeSecretPrompts } from "./secret.js";

export interface ControllerOptions {
  config: BenchConfig;
  demo?: boolean;
  persist?: (config: BenchConfig) => Promise<void>;
  makeRunner?: () => RunController;
  secretPrompts?: NativeSecretPrompts;
  autoInspect?: boolean;
  inspectEnvironment?: typeof inspect;
}
/** Native pi control plane. No login command, no player tools, no control-plane LLM calls. */
export function controllerExtension(options: ControllerOptions) {
  return async (pi: ExtensionAPI): Promise<void> => {
    let config = configSchema.parse(options.config);
    const persist = options.persist ?? saveConfig;
    const demo = !!options.demo;
    let ctx: ExtensionContext | undefined;
    let repaint: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let runner: RunController | undefined;
    let task: Promise<void> | undefined;
    let operation: AbortController | undefined;
    let closed = false;
    let state = emptyDashboard();
    let activeConfig: BenchConfig | undefined;
    let lastRunConfig: BenchConfig | undefined;
    const secrets = new Set<string>();
    const safe = (text: string) => terminalText(redact(text, [...secrets]));
    const update = () => {
      if (!closed) repaint?.();
    };
    const notify = (
      text: string,
      type: "info" | "warning" | "error" = "info",
    ) => {
      if (closed) return;
      const message = safe(text);
      // Routine feedback has one home in the deck. Only actionable warnings /
      // errors use pi's native feedback area (below the deck, never above it).
      state.log = type === "info" ? message.slice(-1000) : "";
      if (type !== "info") ctx?.ui.notify(message, type);
      update();
    };
    let saving = Promise.resolve();
    const commit = async (next: BenchConfig) => {
      const snapshot = configSchema.parse(next);
      config = snapshot;
      saving = saving.catch(() => undefined).then(() => persist(snapshot));
      await saving;
      update();
    };
    const stop = async () => {
      operation?.abort();
      runner?.stop();
      if (task) await task;
    };
    const launch = (
      label: string,
      action: (signal: AbortSignal) => Promise<void>,
    ) => {
      if (task) {
        notify("An operation is already active. Use /stop first.", "warning");
        return;
      }
      operation = new AbortController();
      state.phase = label;
      state.activity = label.toLowerCase();
      state.log = "";
      update();
      task = Promise.resolve()
        .then(() => action(operation!.signal))
        .catch((error) => {
          state.phase = "ERROR";
          notify((error as Error).message, "error");
        })
        .finally(() => {
          task = undefined;
          runner = undefined;
          operation = undefined;
          activeConfig = undefined;
          state.activity = "idle";
          state.phase =
            state.phase === "ERROR"
              ? "ERROR"
              : state.result
                ? "FINISHED"
                : "IDLE";
          update();
        });
    };
    const loadKey = async (snapshot: BenchConfig) => {
      const key = await projectKey(snapshot);
      if (!key)
        throw new Error(
          `Use native /login ${endpointIdentity(snapshot)} to save an API key in runtime/controller/auth.json.`,
        );
      secrets.add(key);
      state.credential = "stored";
      return key;
    };
    const registerEndpoint = async () => {
      const snapshot = { ...config };
      const id = endpointIdentity(snapshot);
      let models = await readModelCache(snapshot);
      if (!models.length) models = [manualModel(snapshot)];
      pi.registerProvider(id, {
        name: `${new URL(snapshot.baseUrl).hostname} [HackingBench]`,
        api: snapshot.api,
        baseUrl: snapshot.baseUrl,
        authHeader: snapshot.api !== "anthropic-messages",
        models: models.map(piModel),
        // Native /login and /model invoke this; no replacement login dialog is needed.
        async refreshModels(context) {
          if (
            demo ||
            !context.allowNetwork ||
            context.credential?.type !== "api_key"
          )
            return models.map(piModel);
          const key = context.credential.key;
          if (!literalApiKey(key))
            throw new Error("Use a literal API key with native /login.");
          secrets.add(key);
          state.credential = "stored";
          const discovered = await discoverModels(
            snapshot,
            key,
            context.signal,
          );
          if (closed || context.signal.aborted) return models.map(piModel);
          models = discovered;
          await saveModelCache(snapshot, models);
          if (endpointIdentity(config) === id) {
            state.log = `${models.length} models fetched. Use native /model to search and select.`;
            update();
            notify(state.log);
            if (ctx && !ctx.ui.getEditorText()) ctx.ui.setEditorText("/model ");
          }
          return models.map(piModel);
        },
      });
    };
    await registerEndpoint();

    pi.registerEntryRenderer(
      "bench.notice",
      (entry) => new Text(safe(String((entry.data as any)?.text ?? "")), 0, 0),
    );
    pi.on("session_start", (_event, context) => {
      ctx = context;
      if (options.secretPrompts) options.secretPrompts.context = context;
      pi.setActiveTools([]);
      if (pi.getActiveTools().length)
        throw new Error("Control-plane tool allowlist assertion failed.");
      // The deck owns its branding; don't duplicate the startup banner in chat scrollback.
      context.ui.setHeader(() => ({ render: () => [], invalidate() {} }));
      context.ui.setEditorComponent(
        (tui, editorTheme, keys) =>
          new BenchEditor(tui, editorTheme, keys, () => context.ui.theme),
      );
      context.ui.setWidget("bench.dashboard", (tui, theme) => {
        repaint = () => tui.requestRender();
        const deck = mountDeckLayout(
          tui,
          (width, height) => {
            const displayedConfig =
              activeConfig ??
              (state.result ? lastRunConfig : undefined) ??
              config;
            const auth = context.modelRegistry?.getProviderAuthStatus(
              endpointIdentity(displayedConfig),
            );
            if (auth)
              state.credential =
                auth.configured && auth.source === "stored"
                  ? "stored"
                  : "unknown";
            return dashboardLines(state, displayedConfig, demo, width, {
              height,
              theme,
              frame: Math.floor(performance.now() / 240),
            });
          },
          (document, width) =>
            nativeFeedback(
              document,
              width,
              theme,
              (provider) =>
                provider === endpointIdentity(config) &&
                context.model?.provider !== provider,
            ),
        );
        return {
          ...deck,
          dispose() {
            repaint = undefined;
          },
        };
      });
      context.ui.setFooter((_tui, theme) => ({
        render: (width: number) => deckFooter(width, theme),
        invalidate() {},
      }));
      timer = setInterval(update, 250);
      timer.unref();
      state.log = "";
      if (options.autoInspect)
        launch("DETECTING", async () => {
          const env = await (options.inspectEnvironment ?? inspect)(config);
          state.environment = {
            runtime: env.runtime,
            pi: env.piVersion ?? "not found",
            game: !!env.gameSource,
            dlc: env.dlc,
            problems: env.problems.length,
          };
          if (env.problems.length) notify(env.problems.join("\n"), "warning");
          update();
        });
    });
    pi.on("session_shutdown", async () => {
      closed = true;
      if (timer) clearInterval(timer);
      await stop();
      await saving.catch(() => undefined);
      secrets.clear();
      if (options.secretPrompts) options.secretPrompts.context = undefined;
    });
    // Session replacements could bypass the in-memory manager or abandon a live game.
    pi.on("session_before_switch", () => ({ cancel: true }));
    pi.on("session_before_fork", () => ({ cancel: true }));
    pi.on("session_before_compact", () => ({ cancel: true }));
    pi.on("input", () => {
      notify(
        "Control deck only: use /config, /provider, /login, /model, /test, /start or /stop. No prompt was sent.",
      );
      return { action: "handled" };
    });
    pi.on("before_agent_start", () => {
      throw new Error(
        "Control-plane model requests are disabled. Use /start for the restricted player.",
      );
    });
    pi.on("tool_call", () => ({
      block: true,
      reason: "The control plane has no tools.",
      terminate: true,
    }));
    pi.on("user_bash", () => ({
      result: {
        output: "Host shell is disabled in HackingBench.",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    }));
    pi.on("cache_warming_decision", () => ({ action: "stop" }));
    pi.on("model_select", async (event) => {
      if (event.model.provider !== endpointIdentity(config)) {
        notify(
          "Runs currently support the endpoint configured with /provider only. Native account/OAuth providers are not yet wired to the restricted runner.",
          "warning",
        );
        return;
      }
      const model = event.model;
      await commit({
        ...config,
        model: model.id,
        contextWindow: Math.min(2000000, model.contextWindow),
        maxOutputTokens: Math.min(
          config.maxOutputTokens,
          model.maxTokens,
          model.contextWindow - 1,
        ),
        thinking: model.reasoning ? pi.getThinkingLevel() : "off",
      });
      notify(`Next run model selected: ${model.id}. Use /start when ready.`);
    });
    pi.on("thinking_level_select", async (event) => {
      if (ctx?.model?.provider === endpointIdentity(config))
        await commit({ ...config, thinking: event.level });
    });

    const command = (
      name: string,
      description: string,
      handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
      getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null,
    ) => {
      pi.registerCommand(name, {
        description,
        getArgumentCompletions,
        handler: async (args, context) => {
          ctx = context;
          try {
            await handler(args.trim(), context);
          } catch (error) {
            notify((error as Error).message, "error");
          }
        },
      });
    };
    command(
      "config",
      "Benchmark settings: L0/L1, text/text+image, budgets and paths; /config [field [value]]",
      async (args, context) => {
        const ensureEditable = () => {
          if (closed) throw new Error("Workbench is closing.");
          if (task)
            throw new Error("Use /stop before changing benchmark settings.");
        };
        const edit = async (field: BenchSetting, raw?: string) => {
          if (raw === undefined) {
            if (field.choices) {
              const selected = await context.ui.select(
                `${field.label} · current: ${settingValue(config, field)}`,
                field.choices.map((choice) => choice.label),
              );
              raw = field.choices.find(
                (choice) => choice.label === selected,
              )?.value;
            } else {
              raw = await context.ui.input(
                `${field.label} · ${field.help}`,
                safe(String(config[field.key])),
              );
            }
          }
          if (raw === undefined) return;
          // Recheck after a dialog: a concurrent programmatic /start must not
          // mutate the active attempt or change its tool loadout.
          ensureEditable();
          await commit(changeSetting(config, field, raw));
          if (field.key === "gameSource" || field.key === "piExecutable")
            state.environment = undefined;
          notify(
            `Saved for next run: ${field.label} = ${settingValue(config, field)}.${
              field.key === "observation" && config.observation === "text+image"
                ? " Vision model required; images are game-only, not desktop captures."
                : ""
            }`,
          );
        };
        ensureEditable();
        if (args) {
          const [, key, value] = args.match(/^(\S+)(?:\s+([\s\S]+))?$/)!;
          await edit(benchSetting(key!), value);
          return;
        }
        // Reuse native pi dialogs; each accepted edit saves immediately. Esc
        // cancels the current prompt, and Esc on this menu returns to the deck.
        while (!closed) {
          ensureEditable();
          const labels = BENCH_SETTINGS.map((field) =>
            safe(`${field.label} · ${settingValue(config, field)}`),
          );
          const choice = await context.ui.select(
            "Benchmark settings / next run · auto-saved · Esc to close",
            labels,
          );
          if (choice === undefined || closed) return;
          const field = BENCH_SETTINGS[labels.indexOf(choice)];
          if (field) await edit(field);
        }
      },
      configCompletions,
    );
    command(
      "provider",
      "Configure endpoint (no key here), refresh catalog or enter a manual model",
      async (_args, context) => {
        if (task)
          throw new Error("Use /stop before changing provider configuration.");
        const choice = await context.ui.select("Provider / endpoint", [
          "CommandCode",
          "OpenAI",
          "Anthropic",
          "Custom compatible endpoint",
          "Refresh model list",
          "Manual model ID",
        ]);
        if (!choice) return;
        if (choice === "Refresh model list") {
          if (demo) {
            notify("Simulation: no catalog request was sent.");
            return;
          }
          launch("MODELS", async (signal) => {
            const snapshot = { ...config };
            const key = await loadKey(snapshot);
            const models = await discoverModels(snapshot, key, signal);
            signal.throwIfAborted();
            await saveModelCache(snapshot, models);
            await registerEndpoint();
            state.log = `${models.length} models fetched. Use /model.`;
            notify(state.log);
            context.ui.setEditorText("/model ");
          });
          return;
        }
        if (choice === "Manual model ID") {
          const model = await context.ui.input(
            "Model ID (not catalog-verified)",
            config.model,
          );
          if (model === undefined) return;
          modelIdSchema.parse(model);
          await commit({ ...config, model });
          await saveModelCache(config, [manualModel(config)]);
          await registerEndpoint();
          context.ui.setEditorText("/model ");
          return;
        }
        let baseUrl: string;
        let api: BenchConfig["api"];
        if (choice === "CommandCode") {
          baseUrl = "https://api.commandcode.ai/provider/v1";
          api = "openai-completions";
        } else if (choice === "OpenAI") {
          baseUrl = "https://api.openai.com/v1";
          api = "openai-responses";
        } else if (choice === "Anthropic") {
          baseUrl = "https://api.anthropic.com";
          api = "anthropic-messages";
        } else {
          const protocol = await context.ui.select("Wire protocol", [
            "openai-completions",
            "openai-responses",
            "anthropic-messages",
          ]);
          if (!protocol) return;
          const url = await context.ui.input(
            "Base URL (no credentials/query; include /v1 if required)",
            config.baseUrl,
          );
          if (url === undefined) return;
          baseUrl = url;
          api = protocol as BenchConfig["api"];
        }
        const oldId = endpointIdentity(config);
        await commit({ ...config, baseUrl, api });
        const id = endpointIdentity(config);
        if (oldId !== id) pi.unregisterProvider(oldId);
        await registerEndpoint();
        state.log = `Endpoint configured. Native /login ${id}, then /model. Keys are endpoint-bound.`;
        notify(state.log);
        context.ui.setEditorText(`/login ${id}`);
      },
    );
    command(
      "start",
      "Start one restricted game attempt (or a safe demo in --demo mode)",
      async (_args, context) => {
        if (!demo && context.model?.provider !== endpointIdentity(config))
          throw new Error(
            "Select the configured endpoint model using native /model first.",
          );
        const snapshot = { ...config };
        launch(demo ? "DEMO" : "STARTING", async (signal) => {
          const key = demo ? "" : await loadKey(snapshot);
          signal.throwIfAborted();
          state = {
            ...emptyDashboard(),
            phase: demo ? "DEMO" : "STARTING",
            activity: "initializing",
            environment: state.environment,
            credential: key ? "stored" : "unknown",
          };
          activeConfig = lastRunConfig = snapshot;
          runner = (options.makeRunner ?? (() => new RunController()))();
          signal.addEventListener("abort", () => runner?.stop(), {
            once: true,
          });
          runner.on("phase", (phase) => {
            state.phase = phase;
            update();
          });
          runner.on("activity", (activity) => {
            state.activity = safe(activity);
            update();
          });
          runner.on("metrics", (metrics) => {
            Object.assign(state, metrics);
            update();
          });
          runner.on("action", (text) => {
            state.action = safe(text).slice(-1000);
            state.activity = "tool execution";
            appendDashboard(state, "action", state.action);
            update();
          });
          runner.on("observation", (text) => {
            observeDashboard(state, safe(text));
            update();
          });
          runner.on("assistant", (text) => {
            state.assistant = safe(state.assistant + text).slice(-2000);
            state.activity = "responding";
            update();
          });
          runner.on("log", (text) => {
            appendDashboard(state, "system", safe(text));
            update();
          });
          const result = await runner.run(snapshot, key, demo);
          state.result = result.status;
          state.wallMs = result.wallMs;
          state.steps = result.steps;
          if (result.tokens !== undefined) state.tokens = result.tokens;
          if (result.llmMs !== undefined) state.llmMs = result.llmMs;
          if (result.toolMs !== undefined) state.toolMs = result.toolMs;
          state.outputTps = result.outputTps ?? state.outputTps;
          state.log = `${demo ? "SIMULATED / NOT SCORED" : result.status.toUpperCase()} · ${result.runId} · ${result.steps} tools · ${Math.round(result.wallMs / 1000)}s`;
          update();
        });
      },
    );
    command(
      "stop",
      "Cancel the current operation; stop only the owned player/game processes",
      async () => {
        await stop();
        notify("Stopped. Owned process cleanup finished.");
      },
    );
    command(
      "test",
      "Small billable provider preflight; no game and no player tools",
      async (_args, context) => {
        if (demo) {
          notify("Simulation: no provider request was sent.");
          return;
        }
        if (task) throw new Error("An operation is already active.");
        if (context.model?.provider !== endpointIdentity(config))
          throw new Error(
            "Use /model to select the configured endpoint first.",
          );
        if (
          !(await context.ui.confirm(
            "Provider connection test",
            "This sends a small, potentially billable request. It does not launch the game. Continue?",
          ))
        )
          return;
        const snapshot = { ...config };
        launch("PREFLIGHT", async (signal) => {
          const key = await loadKey(snapshot);
          const env = await inspect(snapshot);
          signal.throwIfAborted();
          if (!env.pi) throw new Error("Project pi executable not found.");
          state.log = await testProvider(snapshot, key, env.pi, signal);
          notify(state.log);
        });
      },
    );
    command(
      "bench",
      "Show budgets or set: /bench <seconds> <tools> <tokens>",
      async (args) => {
        if (task) throw new Error("Use /stop before changing budgets.");
        if (args) {
          const parts = args.split(/\s+/).map(Number);
          if (parts.length !== 3)
            throw new Error("Usage: /bench <seconds> <tools> <tokens>");
          await commit({
            ...config,
            wallTimeSeconds: parts[0]!,
            maxSteps: parts[1]!,
            maxTokens: parts[2]!,
          });
        }
        pi.appendEntry("bench.notice", {
          text: `${config.wallTimeSeconds}s / ${config.maxSteps} tools / ${config.maxTokens} tokens; ${config.knowledge}; ${config.observation}. Endpoint: ${config.baseUrl}. Native auth: runtime/controller/auth.json.`,
        });
      },
    );
    command(
      "doctor",
      "Inspect local prerequisites without launching the game",
      async () => {
        launch("DOCTOR", async () => {
          state.log = JSON.stringify(await inspect(config));
          notify(state.log);
        });
      },
    );
    command(
      "setup",
      "Prepare isolated game copy, without launching",
      async () => {
        if (demo) {
          notify("Simulation: setup skipped.");
          return;
        }
        launch("SETUP", async () => {
          await prepareGame(config, (text) => {
            state.log = safe(text);
            update();
          });
        });
      },
    );
    command("report", "Show the experimental run summary", async () => {
      pi.appendEntry("bench.notice", { text: safe(await report()) });
    });
  };
}
