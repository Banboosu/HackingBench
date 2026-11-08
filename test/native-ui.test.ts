import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaults } from "../src/config.js";
import {
  appendDashboard,
  dashboardLines,
  deckFooter,
  emptyDashboard,
  observeDashboard,
  tpsLabel,
} from "../src/ui/dashboard.js";
import { createBenchTheme } from "../src/ui/theme.js";
import { controllerExtension } from "../src/ui/controller.js";
import { endpointIdentity } from "../src/pi/project.js";
import { NativeSecretPrompts } from "../src/ui/secret.js";
import { benchSetting } from "../src/ui/settings.js";
import type { RunController } from "../src/runner.js";

test("Hacknet panels preserve native input space and TPS across terminal sizes and color themes", () => {
  const config = {
    ...defaults(),
    model: "fixture-model",
    thinking: "high" as const,
  };
  const state = {
    ...emptyDashboard(),
    phase: "RUNNING",
    activity: "thinking",
    outputTps: 13.846,
    llmMs: 13000,
    toolMs: 600,
    assistant: "检查目标网络。 Checking the network.",
  };
  const theme = createBenchTheme();
  for (const width of [1, 2, 7, 18, 40, 55, 80, 88, 90, 100, 120, 140, 180]) {
    for (const rows of [20, 24, 28, 36, 42, 50]) {
      const lines = dashboardLines(state, config, false, width, {
        rows,
        theme,
      });
      assert.ok(
        lines.length <= rows - 5,
        `Must reserve editor/footer space at ${width}x${rows}`,
      );
      for (const line of [...lines, ...deckFooter(width, theme)])
        assert.ok(
          visibleWidth(line) <= width,
          `${width} columns overflowed: ${visibleWidth(line)}`,
        );
      if (width >= 55) assert.match(lines.join("\n"), /TPS 13\.8/);
    }
  }
  const full = dashboardLines(state, config, false, 100, { rows: 36 }).join(
    "\n",
  );
  for (const title of [
    "OPERATOR",
    "AGENT ACTIVITY",
    "LIVE TERMINAL",
    "RUN TELEMETRY",
    "LLM 13.0s",
    "TOOL 0.6s",
    "RUN TELEMETRY // live totals · no hard limits",
  ])
    assert.ok(full.includes(title), title);
  const modal = dashboardLines(state, config, false, 100, {
    rows: 36,
    compact: true,
  });
  assert.ok(modal.length <= 9, "Native dialogs must have room to breathe.");
  assert.match(modal.join("\n"), /TPS 13\.8/);
  assert.doesNotMatch(full, /mission.*\d+%/i);
});

test("large viewports use their allocated height without duplicate idle status or mission banners", () => {
  const state = {
    ...emptyDashboard(),
    environment: {
      runtime: "Bun fixture",
      pi: "1.5.0",
      game: true,
      dlc: true,
      problems: 0,
    },
  };
  for (const [width, height] of [
    [168, 50],
    [200, 66],
    [100, 32],
  ]) {
    const lines = dashboardLines(state, defaults(), false, width!, {
      height: height!,
    });
    assert.equal(lines.length, height);
    assert.match(lines[0]!, /HACKINGBENCH/);
    const frame = lines.join("\n");
    assert.equal(frame.split("Bun fixture").length - 1, 1);
    assert.equal(frame.split("CAMPAIGN").length - 1, 1);
    assert.doesNotMatch(
      frame,
      /MISSION \/\/|STATUS|No tool call yet|Agent starts only/,
    );
  }
});

test("successful startup environment inspection appears only in Operator, not native notifications or status", async () => {
  const mock = mockPi();
  await controllerExtension({
    config: defaults(),
    demo: true,
    autoInspect: true,
    inspectEnvironment: async () => ({
      platform: "win32",
      runtime: "Bun fixture",
      piVersion: "1.5.0",
      gameSource: "fixture-game",
      dlc: true,
      prepared: true,
      problems: [],
    }),
    persist: async () => {},
  })(mock.pi);
  try {
    await mock.handlers.get("session_start")!({}, mock.ctx);
    await delay(0);
    const frame = mock.widgets.get("bench.dashboard").render(120).join("\n");
    assert.equal(mock.notices.length, 0);
    assert.equal(frame.split("Bun fixture").length - 1, 1);
    assert.match(frame, /Local prerequisites OK/);
    assert.doesNotMatch(frame, /game found|DLC found|STATUS/);
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
});

test("TPS is explicit about unknown values and shows real zero, never NaN or Infinity", () => {
  for (const value of [undefined, NaN, Infinity, -1])
    assert.equal(tpsLabel({ outputTps: value }), "TPS —");
  assert.equal(tpsLabel({ outputTps: 0 }), "TPS 0.0");
  assert.equal(tpsLabel({ outputTps: 42.156 }), "TPS 42.2");
});

test("game observations become bounded, sanitized terminal history instead of JSON noise", () => {
  const state = emptyDashboard();
  observeDashboard(
    state,
    JSON.stringify({
      connectedName: "Test node",
      connectedIP: "192.0.2.17",
      terminal: { lines: ["Connected", "22 SSH -- OPEN"] },
      tutorial: { text: "Visible instructions" },
      network: [{}, {}],
    }),
  );
  assert.equal(state.observation, "Connected\n22 SSH -- OPEN");
  assert.equal(state.connection, "Test node / 192.0.2.17");
  assert.equal(state.nodes, 2);
  assert.equal(state.surface, "Tutorial visible");
  appendDashboard(
    state,
    "action",
    "\x1b]52;;YXR0YWNr\x07probe\x1b[31m\u202eevil",
  );
  assert.doesNotMatch(state.history.at(-1)!.text, /\x1b|\u202e|YXR0YWNr/);
  for (let i = 0; i < 100; i++)
    appendDashboard(state, "game", "x".repeat(5000));
  assert.equal(state.history.length, 64);
  assert.ok(state.history.every((entry) => entry.text.length <= 1200));
  observeDashboard(state, '{"terminal": truncated');
  assert.match(state.observation, /truncated/);
  state.result = "gave_up";
  state.phase = "FINISHED";
  assert.match(
    dashboardLines(state, defaults(), false, 100).join("\n"),
    /GAVE_UP/,
  );
  const demo = dashboardLines(emptyDashboard(), defaults(), true, 100).join(
    "\n",
  );
  assert.match(demo, /SIMULATION/);
  assert.match(demo, /no real game or API calls/);
});

function mockPi() {
  const commands = new Map<string, any>();
  const handlers = new Map<string, Function>();
  const providers = new Map<string, any>();
  const widgets = new Map<string, any>();
  const notices: string[] = [];
  let active = ["bash"];
  let editor = "";
  let thinking = "high";
  const choices: string[] = [];
  const inputs: (string | undefined)[] = [];
  const dialogs: { title: string; options: string[] }[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx: any = {
    mode: "tui",
    model: undefined,
    ui: {
      notify: (text: string) => notices.push(text),
      getEditorText: () => editor,
      setEditorText: (text: string) => {
        editor = text;
      },
      theme,
      setEditorComponent: () => {},
      setHeader: () => {},
      setFooter: () => {},
      setWidget: (name: string, factory: any) =>
        widgets.set(
          name,
          factory({ requestRender() {}, terminal: { rows: 36 } }, theme),
        ),
      select: async (title: string, options: string[]) => {
        dialogs.push({ title, options });
        return choices.shift();
      },
      input: async () => inputs.shift(),
      confirm: async () => false,
    },
  };
  const pi: any = {
    registerProvider: (id: string, provider: any) =>
      providers.set(id, provider),
    unregisterProvider: (id: string) => providers.delete(id),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    registerEntryRenderer: () => {},
    appendEntry: (_type: string, data: any) => notices.push(data.text),
    on: (name: string, handler: Function) => handlers.set(name, handler),
    setActiveTools: (tools: string[]) => {
      active = tools;
    },
    getActiveTools: () => active,
    getThinkingLevel: () => thinking,
    setThinkingLevel: (level: string) => {
      thinking = level;
    },
  };
  return {
    pi,
    ctx,
    commands,
    handlers,
    providers,
    widgets,
    notices,
    choices,
    inputs,
    dialogs,
  };
}
test("native dashboard handles narrow terminals, wide text and terminal control injection", () => {
  const state = {
    ...emptyDashboard(),
    wallMs: 61234,
    phase: "RUNNING",
    activity: "thinking",
    observation: "\x1b]52;bad\x07\n中文游戏\u202e",
    assistant: "model output",
  };
  for (const width of [1, 12, 40, 120]) {
    const lines = dashboardLines(state, defaults(), false, width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(!lines.join("").includes("\x1b]"));
    assert.ok(!lines.join("").includes("\u202e"));
  }
  const frame = dashboardLines(state, defaults(), true, 150).join("\n");
  assert.match(frame, /SIMULATION/);
  assert.match(frame, /01:01/);
  assert.match(frame, /DLC not scored/);
  assert.doesNotMatch(frame, /MISSION \/\/|STATUS/);
});
test("native controller does not replace login/model; it blocks prompts, host shell and tools", async () => {
  const mock = mockPi();
  await controllerExtension({
    config: defaults(),
    demo: true,
    persist: async () => {},
  })(mock.pi);
  try {
    await mock.handlers.get("session_start")!({}, mock.ctx);
    assert.deepEqual(mock.pi.getActiveTools(), []);
    assert.equal(mock.commands.has("login"), false);
    assert.equal(mock.commands.has("model"), false);
    assert.equal(mock.commands.has("settings"), false);
    for (const name of ["config", "provider", "start", "stop", "test"])
      assert.ok(mock.commands.has(name));
    assert.equal(
      mock.commands.has("bench"),
      false,
      "Budget-editing command must be removed.",
    );
    assert.equal(mock.handlers.get("input")!().action, "handled");
    assert.equal(mock.handlers.get("tool_call")!().block, true);
    assert.equal(mock.handlers.get("user_bash")!().result.exitCode, 1);
    assert.throws(() => mock.handlers.get("before_agent_start")!(), /disabled/);
    assert.equal(mock.handlers.get("session_before_switch")!().cancel, true);
    assert.match(
      mock.widgets.get("bench.dashboard").render(100).join("\n"),
      /LLM idle/,
    );
    mock.choices.push("Refresh model list");
    await mock.commands.get("provider").handler("", mock.ctx);
    assert.match(
      mock.widgets.get("bench.dashboard").render(120).join("\n"),
      /no catalog request/,
    );
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
});
test("model attributes drive thinking and unsupported levels are clamped", async () => {
  const mock = mockPi();
  const base = defaults();
  const provider = endpointIdentity(base);
  const saved: ReturnType<typeof defaults>[] = [];
  const model = (
    reasoning: boolean,
    thinkingLevelMap?: Record<string, string | null>,
  ) =>
    ({
      id: "fixture-model",
      provider,
      reasoning,
      thinkingLevelMap,
      contextWindow: 128000,
      maxTokens: 8192,
    }) as any;
  await controllerExtension({
    config: base,
    demo: true,
    persist: async (value) => {
      saved.push(value);
    },
  })(mock.pi);
  try {
    await mock.handlers.get("session_start")!({}, mock.ctx);
    // Before /model, the native selector allows a provisional level; the next
    // model selection must clamp it instead of dropping it.
    await mock.handlers.get("thinking_level_select")!({
      level: "high",
      previousLevel: "off",
    });
    assert.equal(saved.at(-1)?.thinking, "high");

    const nonThinking = model(false);
    mock.ctx.model = nonThinking;
    await mock.handlers.get("model_select")!({
      model: nonThinking,
      previousModel: undefined,
      source: "set",
    });
    assert.equal(saved.at(-1)?.thinking, "off");
    assert.equal(mock.pi.getThinkingLevel(), "off");

    const fullThinking = model(true);
    mock.ctx.model = fullThinking;
    mock.pi.setThinkingLevel("high");
    await mock.handlers.get("thinking_level_select")!({
      level: "high",
      previousLevel: "off",
    });
    assert.equal(saved.at(-1)?.thinking, "high");
    assert.equal(mock.pi.getThinkingLevel(), "high");

    const limited = model(true, { high: null });
    mock.ctx.model = limited;
    await mock.handlers.get("model_select")!({
      model: limited,
      previousModel: nonThinking,
      source: "set",
    });
    assert.equal(saved.at(-1)?.thinking, "medium");
    assert.equal(mock.pi.getThinkingLevel(), "medium");

    mock.ctx.model = nonThinking;
    await mock.handlers.get("thinking_level_select")!({
      level: "high",
      previousLevel: "medium",
    });
    assert.equal(saved.at(-1)?.thinking, "off");
    assert.equal(mock.pi.getThinkingLevel(), "off");
    assert.ok(mock.notices.some((text) => /not supported/.test(text)));
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
});

test("native start returns promptly, denies duplicate starts, and stop/shutdown await owned cleanup", async () => {
  const mock = mockPi();
  let starts = 0;
  let stops = 0;
  let finish: (() => void) | undefined;
  const snapshots: ReturnType<typeof defaults>[] = [];
  class FakeRunner extends EventEmitter {
    async run(config: ReturnType<typeof defaults>) {
      snapshots.push(config);
      starts++;
      this.emit("phase", "RUNNING");
      this.emit("activity", "thinking");
      this.emit("metrics", {
        wallMs: 1000,
        steps: 3,
        tokens: 25,
        llmMs: 50,
        toolMs: 30,
        outputTps: 50,
      });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return {
        status: "cancelled",
        runId: "fixture",
        steps: 3,
        wallMs: 1000,
        outputTps: 48,
      };
    }
    stop() {
      stops++;
      finish?.();
    }
  }
  await controllerExtension({
    config: defaults(),
    demo: true,
    persist: async () => {},
    makeRunner: () => new FakeRunner() as unknown as RunController,
  })(mock.pi);
  try {
    await mock.handlers.get("session_start")!({}, mock.ctx);
    await mock.commands.get("start").handler("", mock.ctx);
    await delay(0);
    assert.equal(starts, 1);
    await mock.commands.get("start").handler("", mock.ctx);
    assert.equal(starts, 1);
    assert.match(mock.notices.at(-1)!, /already active/);
    const frame = mock.widgets.get("bench.dashboard").render(120).join("\n");
    assert.match(frame, /LLM thinking/);
    assert.match(frame, /TOOLS\s+3/);
    assert.match(frame, /TPS 50\.0/);
    for (const args of ["knowledge L0", "observation text+image", ""]) {
      await mock.commands.get("config").handler(args, mock.ctx);
      assert.match(
        mock.notices.at(-1)!,
        /stop before changing benchmark settings/,
      );
    }
    assert.equal(
      mock.dialogs.length,
      0,
      "No settings dialogs while an operation is active.",
    );
    assert.match(
      mock.widgets.get("bench.dashboard").render(120).join("\n"),
      /TOOLS\s+3/,
      "Active telemetry must remain visible.",
    );
    await mock.commands.get("stop").handler("", mock.ctx);
    assert.equal(stops, 2); // Operation AbortSignal and explicit owned-run cancellation are idempotent.
    assert.match(
      mock.widgets.get("bench.dashboard").render(120).join("\n"),
      /cleanup finished/,
    );
    await mock.commands.get("config").handler("knowledge L0", mock.ctx);
    await mock.commands
      .get("config")
      .handler("observation text+image", mock.ctx);
    const stopped = mock.widgets.get("bench.dashboard").render(120).join("\n");
    assert.match(stopped, /CANCELLED/);
    assert.match(stopped, /TPS 48\.0/);
    assert.match(stopped, /TOOLS\s+3/);
    assert.match(
      stopped,
      /L1 · text/,
      "Completed metrics must retain the old knowledge/observation snapshot.",
    );
    assert.equal(snapshots[0]!.knowledge, "L1");
    assert.equal(snapshots[0]!.observation, "text");
    await mock.commands.get("start").handler("", mock.ctx);
    await delay(0);
    assert.equal(starts, 2);
    assert.equal(snapshots[1]!.knowledge, "L0");
    assert.equal(snapshots[1]!.observation, "text+image");
    assert.match(
      mock.widgets.get("bench.dashboard").render(120).join("\n"),
      /L0 · text\+image/,
    );
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
  assert.equal(stops, 4);
});
test("native config menu restores knowledge, observation and local paths with immediate non-secret persistence", async () => {
  const mock = mockPi();
  const saved: ReturnType<typeof defaults>[] = [];
  await controllerExtension({
    config: defaults(),
    demo: true,
    persist: async (value) => {
      saved.push(value);
    },
  })(mock.pi);
  try {
    await mock.handlers.get("session_start")!({}, mock.ctx);
    mock.choices.push(
      "Knowledge · L1",
      benchSetting("knowledge").choices![0]!.label,
      "Observation · text",
      benchSetting("observation").choices![1]!.label,
      "Hacknet source folder · Auto-detect",
    );
    mock.inputs.push("D:\\Game Library\\Hacknet");
    await mock.commands.get("config").handler("", mock.ctx);
    assert.equal(saved.length, 3);
    assert.equal(saved[0]!.knowledge, "L0");
    assert.equal(saved[1]!.observation, "text+image");
    assert.equal(saved[2]!.gameSource, "D:\\Game Library\\Hacknet");
    assert.equal("keyEnv" in saved[2]!, false);
    assert.equal("apiKey" in saved[2]!, false);
    assert.ok(
      mock.dialogs.some((dialog) => dialog.options.includes("Knowledge · L0")),
    );
    assert.ok(
      mock.dialogs.some((dialog) =>
        dialog.options.includes("Observation · text+image"),
      ),
    );
    assert.match(
      mock.widgets.get("bench.dashboard").render(120).join("\n"),
      /L0 · text\+image/,
    );
    for (const width of [40, 55, 80, 100])
      assert.match(deckFooter(width).join("\n"), /\/config/);
    assert.deepEqual(mock.pi.getActiveTools(), []);
    assert.equal(
      mock.notices.length,
      0,
      "Routine config feedback must not duplicate native notices.",
    );
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
});

test("native config menu exposes game window size and fullscreen with immediate persistence", async () => {
  const mock = mockPi();
  const saved: ReturnType<typeof defaults>[] = [];
  await controllerExtension({
    config: defaults(),
    demo: true,
    persist: async (value) => {
      saved.push(value);
    },
  })(mock.pi);
  try {
    await mock.handlers.get("session_start")!({}, mock.ctx);
    mock.choices.push(
      "Game window width · 1920",
      "Game window height · 1080",
      "Game fullscreen · false",
      benchSetting("gameFullscreen").choices![1]!.label,
    );
    mock.inputs.push("1280", "720");
    await mock.commands.get("config").handler("", mock.ctx);
    assert.deepEqual(
      saved.map((value) => [
        value.gameWindowWidth,
        value.gameWindowHeight,
        value.gameFullscreen,
      ]),
      [
        [1280, 1080, false],
        [1280, 720, false],
        [1280, 720, true],
      ],
    );
    assert.ok(
      mock.dialogs.some((dialog) =>
        dialog.options.includes("Game window width · 1920"),
      ),
    );
    assert.equal(mock.notices.length, 0);
    assert.match(
      mock.widgets.get("bench.dashboard").render(120).join("\n"),
      /Game fullscreen = true/,
    );
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
});

test("native config supports direct values and cancellation, rejects invalid/secret/provider fields without saving", async () => {
  const mock = mockPi();
  const saved: ReturnType<typeof defaults>[] = [];
  await controllerExtension({
    config: defaults(),
    demo: true,
    persist: async (value) => {
      saved.push(value);
    },
  })(mock.pi);
  try {
    await mock.handlers.get("session_start")!({}, mock.ctx);
    for (const args of ["", "knowledge", "gameSource"])
      await mock.commands.get("config").handler(args, mock.ctx);
    assert.equal(
      saved.length,
      0,
      "Esc cancels menus and inputs without saving.",
    );
    for (const args of [
      "knowledge L2",
      "observation image",
      "gameWindowWidth 639",
      "gameWindowHeight 4097",
      "gameFullscreen yes",
      "contextWindow 65536",
      "maxOutputTokens 65536",
      "apiKey do-not-store",
      "baseUrl https://other.example/v1",
    ]) {
      // The first context-window change is valid; the output limit equal to it must fail.
      await mock.commands.get("config").handler(args, mock.ctx);
    }
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.contextWindow, 65536);
    assert.ok(mock.notices.some((text) => /Invalid Knowledge/.test(text)));
    assert.ok(
      mock.notices.some((text) => /Unknown benchmark setting/.test(text)),
    );
    assert.ok(mock.notices.every((text) => !text.includes("do-not-store")));
    await mock.commands.get("config").handler("knowledge l0", mock.ctx);
    await mock.commands
      .get("config")
      .handler("observation text+image", mock.ctx);
    assert.equal(saved.at(-1)!.knowledge, "L0");
    assert.equal(saved.at(-1)!.observation, "text+image");
    assert.match(
      mock.widgets.get("bench.dashboard").render(120).join("\n"),
      /Vision model required/,
    );
    assert.deepEqual(
      mock.commands
        .get("config")
        .getArgumentCompletions("knowledge L")
        .map((item: any) => item.value),
      ["knowledge L0", "knowledge L1"],
    );
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
});

test("native config rechecks the operation guard after a prompt returns", async () => {
  const mock = mockPi();
  let saved = 0;
  let finish: (() => void) | undefined;
  class FakeRunner extends EventEmitter {
    async run() {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { status: "cancelled", runId: "fixture", steps: 0, wallMs: 0 };
    }
    stop() {
      finish?.();
    }
  }
  await controllerExtension({
    config: defaults(),
    demo: true,
    persist: async () => {
      saved++;
    },
    makeRunner: () => new FakeRunner() as unknown as RunController,
  })(mock.pi);
  try {
    await mock.handlers.get("session_start")!({}, mock.ctx);
    mock.ctx.ui.select = async () => {
      await mock.commands.get("start").handler("", mock.ctx);
      await delay(0);
      return benchSetting("knowledge").choices![0]!.label;
    };
    await mock.commands.get("config").handler("knowledge", mock.ctx);
    assert.equal(saved, 0);
    assert.match(
      mock.notices.at(-1)!,
      /stop before changing benchmark settings/,
    );
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
});

test("secret-only adapter masks typing/paste, preserves native login orchestration and rejects command keys", async () => {
  const adapter = new NativeSecretPrompts();
  let component: any;
  adapter.context = {
    mode: "tui",
    ui: {
      custom: async (factory: any) =>
        new Promise((resolve) => {
          component = factory(
            { requestRender() {} },
            { fg: (_color: string, text: string) => text },
            {},
            resolve,
          );
          component.focused = true;
        }),
    },
  } as any;
  const prompt = adapter.prompt({ type: "secret", message: "API key" });
  component.handleInput("fixture-key");
  assert.ok(!component.render(100).join("\n").includes("fixture-key"));
  assert.match(component.render(100).join("\n"), /\*{11}/);
  component.handleInput("\r");
  assert.equal(await prompt, "fixture-key");
  component.dispose();
  const forbidden = adapter.prompt({ type: "secret", message: "API key" });
  component.handleInput("!do-not-execute");
  component.handleInput("\r");
  await assert.rejects(forbidden, /literal API key/);
  component.dispose();
  const controller = new AbortController();
  const cancelled = adapter.prompt(
    { type: "secret", message: "API key" },
    controller.signal,
  );
  controller.abort();
  await assert.rejects(cancelled, /cancelled/);
  component.dispose();
});
