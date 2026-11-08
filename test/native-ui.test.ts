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
import { NativeSecretPrompts } from "../src/ui/secret.js";
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
    "budget consumed",
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
  state.result = "budget_exhausted";
  state.phase = "FINISHED";
  assert.match(
    dashboardLines(state, defaults(), false, 100).join("\n"),
    /BUDGET_EXHAUSTED/,
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
  const choices: string[] = [];
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
      select: async () => choices.shift(),
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
    getThinkingLevel: () => "high",
  };
  return { pi, ctx, commands, handlers, providers, widgets, notices, choices };
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
  assert.match(frame, /Not an OS sandbox/);
  assert.match(frame, /DLC not scored/);
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
    for (const name of ["provider", "start", "stop", "test", "bench"])
      assert.ok(mock.commands.has(name));
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
    assert.match(mock.notices.at(-1)!, /no catalog request/);
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
});
test("native start returns promptly, denies duplicate starts, and stop/shutdown await owned cleanup", async () => {
  const mock = mockPi();
  let starts = 0;
  let stops = 0;
  let finish: (() => void) | undefined;
  class FakeRunner extends EventEmitter {
    async run() {
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
    await mock.commands.get("bench").handler("60 10 1000", mock.ctx);
    assert.match(mock.notices.at(-1)!, /stop before changing budgets/);
    assert.match(
      mock.widgets.get("bench.dashboard").render(120).join("\n"),
      /3 \/ 1,500/,
      "Active metrics must retain startup budgets.",
    );
    await mock.commands.get("stop").handler("", mock.ctx);
    assert.equal(stops, 2); // Operation AbortSignal and explicit owned-run cancellation are idempotent.
    assert.match(mock.notices.at(-1)!, /cleanup finished/);
    await mock.commands.get("bench").handler("60 10 1000", mock.ctx);
    const stopped = mock.widgets.get("bench.dashboard").render(120).join("\n");
    assert.match(stopped, /CANCELLED/);
    assert.match(stopped, /TPS 48\.0/);
    assert.match(stopped, /3 \/ 1,500/);
    await mock.commands.get("start").handler("", mock.ctx);
    await delay(0);
    assert.equal(starts, 2);
    assert.match(
      mock.widgets.get("bench.dashboard").render(120).join("\n"),
      /3 \/ 10/,
      "Next run must use the new budgets.",
    );
  } finally {
    await mock.handlers.get("session_shutdown")!();
  }
  assert.equal(stops, 4);
});
test("native bench command validates budgets and persists only non-secret settings", async () => {
  const mock = mockPi();
  const saved: any[] = [];
  await controllerExtension({
    config: defaults(),
    demo: true,
    persist: async (config) => {
      saved.push(config);
    },
  })(mock.pi);
  try {
    await mock.handlers.get("session_start")!({}, mock.ctx);
    await mock.commands.get("bench").handler("60 10 1000", mock.ctx);
    assert.equal(saved.at(-1)?.wallTimeSeconds, 60);
    assert.equal("keyEnv" in saved.at(-1), false);
    await mock.commands.get("bench").handler("-1 0 0", mock.ctx);
    assert.equal(saved.length, 1);
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
