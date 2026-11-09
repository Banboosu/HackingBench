import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import type { RunController } from "../src/runner.js";
import { mkdir, rm, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  defaults,
  CONFIG_FILE,
  RUNTIME,
  type BenchConfig,
} from "../src/config.js";
import {
  controllerEnvironment,
  CONTROLLER_DIR,
  endpointIdentity,
  projectKey,
} from "../src/pi/project.js";
import { TestTerminal } from "./terminal-fixture.js";

// Real native pi InteractiveMode + fake terminal + local model catalog. No game/real API.
const env = controllerEnvironment();
for (const name of Object.keys(process.env))
  if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);
const { InteractiveMode } = await import("@earendil-works/pi-coding-agent");
const { createWorkbench } = await import("../src/ui/native.js");

const key = "fixture-native-login-do-not-display";
let catalogCalls = 0;
const server = http.createServer((req, res) => {
  try {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    catalogCalls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          { id: "deepseek-v4.1-flash", name: "Fixture model", reasoning: true },
        ],
      }),
    );
  } catch {
    res.writeHead(500);
    res.end("fixture assertion failed");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as import("node:net").AddressInfo).port;
const config = {
  ...defaults(),
  baseUrl: `http://127.0.0.1:${port}/v1`,
  api: "openai-completions" as const,
  model: "deepseek-v4.1-flash",
  thinking: "high" as const,
};
const id = endpointIdentity(config);
const terminal = new TestTerminal();
const previousConfig = await readFile(CONFIG_FILE).catch(() => undefined);
let starts = 0;
let resumes = 0;
let currentRunner: FakeRunner | undefined;
const runConfigs: BenchConfig[] = [];
let finishRun: (() => void) | undefined;
class FakeRunner extends EventEmitter {
  paused = false;
  pause() {
    this.paused = true;
    this.emit("phase", "PAUSED");
    this.emit("activity", "paused");
    this.emit("paused", "Connection error. (synthetic)");
  }
  async resume() {
    assert.equal(this.paused, true);
    this.paused = false;
    resumes++;
    this.emit("phase", "RUNNING");
    this.emit("activity", "thinking");
    this.emit("resumed");
  }
  async run(snapshot: BenchConfig) {
    runConfigs.push(snapshot);
    starts++;
    this.emit("phase", "RUNNING");
    this.emit("activity", "thinking");
    this.emit("log", "SYNTHETIC UI TEST · no real API/game · no score");
    this.emit("metrics", {
      wallMs: 222000,
      steps: 42,
      tokens: 18220,
      llmMs: 13000,
      toolMs: 600,
      outputTokens: 180,
      generationMs: 13000,
      outputTps: 180 / 13,
      tpsSamples: 3,
    });
    this.emit("action", 'hn_cmd {"command":"probe"}');
    this.emit(
      "observation",
      JSON.stringify({
        connectedName: "Synthetic test node",
        connectedIP: "192.0.2.17",
        terminal: {
          lines: [
            "Connection established.",
            "22 SSH  --  OPEN",
            "80 HTTP --  LOCKED",
            "Required open ports: 1",
            "Waiting for next command.",
          ],
        },
        network: [{}, {}],
      }),
    );
    this.emit(
      "reasoning",
      "Inspecting the target network before probing ports.",
    );
    this.emit("assistant", "Checking open ports, then replying to the client.");
    this.emit("activity", "thinking");
    await new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    return {
      status: "cancelled",
      runId: "fake-native-ui-run",
      steps: 1,
      wallMs: 250,
    };
  }
  stop() {
    finishRun?.();
  }
}
const saved: any[] = [];
const runtime = await createWorkbench(config, false, {
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
  persist: async (value) => {
    saved.push(value);
  },
  makeRunner: () => {
    currentRunner = new FakeRunner();
    return currentRunner as unknown as RunController;
  },
});
const mode = new InteractiveMode(runtime, { terminal, tuiMode: "fullscreen" });
async function capture(name: string): Promise<string> {
  const dir = path.join(RUNTIME, "ui-preview");
  await mkdir(dir, { recursive: true });
  const lines = await terminal.frame();
  assert.match(
    lines[0]!,
    /HACKINGBENCH/,
    "Deck must start at the top, not below empty transcript space.",
  );
  const frame = lines.join("\n");
  assert.doesNotMatch(
    frame.replace(/\s+/g, ""),
    /Error:(?:SavedAPIkeyfor|Loggedinto).*nodefaultmodelisconfigured/,
    "Successful native login must not leave a red default-model advisory.",
  );
  assert.ok(
    !frame.includes(key),
    "Native viewport exposed fixture credential.",
  );
  await writeFile(path.join(dir, `${name}.txt`), frame);
  await writeFile(path.join(dir, `${name}.html`), await terminal.html(name));
  return frame;
}
async function frameIncludes(text: string) {
  return (await terminal.frame()).join("\n").includes(text);
}
async function until(
  condition: () => boolean | Promise<boolean>,
  message: string,
) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await delay(30);
  }
  throw new Error(message);
}
try {
  await mode.init();
  await until(() => frameIncludes("HACKINGBENCH"), "Dashboard did not render.");
  await until(
    () => frameIncludes("Local prerequisites OK"),
    "Startup environment did not render.",
  );
  const idle = await capture("native-idle-100x36");
  assert.doesNotMatch(idle, /Extension issues|conflicts with built-in/);
  for (const [columns, rows] of [
    [168, 54],
    [200, 70],
    [100, 36],
  ]) {
    terminal.resize(columns!, rows!);
    await delay(120);
    const frame = await capture(`native-idle-${columns}x${rows}`);
    assert.equal(
      frame.split("Bun fixture").length - 1,
      1,
      "Environment summary must appear only once.",
    );
    assert.doesNotMatch(frame, /MISSION \/\/|STATUS|game found|DLC found/);
    assert.match(frame, /RUN TELEMETRY/);
    assert.match(frame, /COMMAND/);
  }
  assert.doesNotMatch(idle, /COMMAND\s*\/\/\s*native pi/);
  assert.doesNotMatch(idle, /RUN TELEMETRY\s*\/\//);
  for (const title of [
    "OPERATOR",
    "AGENT ACTIVITY",
    "LIVE TERMINAL",
    "RUN TELEMETRY",
    "COMMAND",
  ])
    assert.ok(
      idle.includes(title),
      `Missing ${title} in actual native viewport.`,
    );
  assert.deepEqual(runtime.session.getActiveToolNames(), []);
  terminal.type("/pro");
  await until(
    () => frameIncludes("Configure endpoint"),
    "Native command completion did not render.",
  );
  await capture("native-command-completion");
  mode.clearEditor();
  terminal.input?.("\x1b[200~draft one\ndraft two\x1b[201~");
  await until(
    () => frameIncludes("draft two"),
    "Native multiline editing did not render.",
  );
  const multiline = await capture("native-multiline-editor");
  assert.match(multiline, /draft one/);
  assert.match(multiline, /COMMAND/);
  assert.equal(
    catalogCalls,
    0,
    "Layout and editing must not request a model catalog.",
  );
  mode.clearEditor();
  terminal.type("/config knowledge l");
  await until(
    () => frameIncludes("L0 — Game help"),
    "Knowledge argument completion did not render.",
  );
  terminal.input?.("\t");
  await until(
    () => frameIncludes("/config knowledge L0"),
    "Native completion did not preserve the /config field prefix.",
  );
  mode.clearEditor();
  // init() binds native UI but doesn't run InteractiveMode's input loop.
  // Dispatch extension commands through the SDK; dialogs still use native input.
  const settingsTask = runtime.session.prompt("/config");
  await until(
    () => frameIncludes("Benchmark settings / next run"),
    "Benchmark settings menu did not open.",
  );
  const settings = await capture("native-bench-settings");
  assert.match(settings, /Knowledge · L1/);
  assert.match(settings, /Observation · text/);
  assert.match(settings, /Game window width/);
  assert.match(settings, /pi.exe path/);
  terminal.resize(55, 20);
  await delay(120);
  const smallSettings = await capture("native-bench-settings-55x20");
  assert.match(smallSettings, /pi.exe path/);
  assert.match(smallSettings, /cancel/);
  terminal.resize(100, 36);
  await delay(120);
  terminal.input?.("\r");
  await until(
    () => frameIncludes("Knowledge · current: L1"),
    "Knowledge selector did not open.",
  );
  assert.match(
    await capture("native-knowledge-selector"),
    /L1 — Include a short command guide/,
  );
  terminal.input?.("\r"); // First choice: L0, game help only.
  await until(
    () => saved.at(-1)?.knowledge === "L0" && frameIncludes("Knowledge · L0"),
    "L0 was not saved and reflected in the menu.",
  );
  terminal.input?.("\x1b[B");
  terminal.input?.("\r"); // Observation.
  await until(
    () => frameIncludes("Observation · current: text"),
    "Observation selector did not open.",
  );
  assert.match(
    await capture("native-observation-selector"),
    /vision model required/,
  );
  terminal.input?.("\x1b[B");
  terminal.input?.("\r");
  await until(
    () => saved.at(-1)?.observation === "text+image",
    "Image observation was not persisted.",
  );
  await until(
    () => frameIncludes("Benchmark settings / next run"),
    "Settings menu did not reopen after saving.",
  );
  terminal.input?.("\x1b");
  await until(
    () => frameIncludes("COMMAND"),
    "Esc did not return from settings to the native editor.",
  );
  await settingsTask;
  assert.equal(catalogCalls, 0, "Benchmark settings must not call a provider.");
  // Built-in command handling is in the native editor submit path, not session.prompt().
  terminal.type(`/login ${id}`);
  terminal.input?.("\r");
  await until(
    () => terminal.output.includes("Enter API key"),
    "Native API key dialog did not open.",
  );
  terminal.type(key);
  await until(
    () => frameIncludes("********"),
    "Masked native input was not visible.",
  );
  await capture("native-login-masked");
  terminal.input?.("\r");
  await until(
    async () => (await projectKey(config)) === key,
    "Native /login did not save project credential.",
  );
  await until(
    () => catalogCalls > 0,
    "Native /login did not automatically discover models.",
  );
  await until(
    () =>
      runtime.session.modelRuntime.getModel(id, config.model)?.name ===
      "Fixture model",
    "Discovered model was not registered.",
  );
  assert.ok(
    !terminal.output.includes(key),
    "Native login leaked the fixture key in terminal output.",
  );
  assert.ok(runtime.session.modelRuntime.getModel(id, config.model)?.reasoning);
  await until(
    () => frameIncludes("Credentials saved. Use /model"),
    "Native login should show normal model-selection guidance, not Error.",
  );
  await capture("native-login-model-hint");
  await runtime.session.prompt("Do not run a model from the control deck.");
  assert.ok(
    !runtime.session.messages.some((message) => message.role === "user"),
  );
  assert.throws(
    () =>
      runtime.session.modelRuntime.streamSimple(runtime.session.model!, {
        messages: [],
      }),
    /disabled/,
  );
  mode.clearEditor();
  terminal.type("/model");
  terminal.input?.("\r");
  await until(
    () => frameIncludes("Fixture model"),
    "Native model selector was clipped or did not render.",
  );
  const picker = await capture("native-model-picker");
  assert.match(picker, /to cancel/);
  terminal.input?.("\x1b");
  mode.clearEditor();
  terminal.type(`/model ${id}/${config.model}`);
  terminal.input?.("\r");
  await until(
    () => runtime.session.model?.provider === id,
    "Native /model did not select endpoint model.",
  );
  await until(
    async () => !(await frameIncludes("Credentials saved. Use /model")),
    "Resolved model-selection guidance must disappear.",
  );
  const selected = await capture("native-model-selected");
  assert.doesNotMatch(
    selected.replace(/\s+/g, ""),
    /nodefaultmodelisconfigured/,
  );
  mode.clearEditor();
  terminal.type("/thinking high");
  terminal.input?.("\r");
  await until(
    () => saved.some((value) => value.thinking === "high"),
    "Native thinking selection was not persisted.",
  );
  await runtime.session.prompt("/start");
  await until(() => starts === 1, "Background fake run was not started.");
  assert.equal(runConfigs[0]!.knowledge, "L0");
  assert.equal(runConfigs[0]!.observation, "text+image");
  await until(
    () => frameIncludes("Connection established."),
    "Structured game terminal was not rendered.",
  );
  const running = await capture("native-running-100x36");
  assert.match(running, /LLM thinking/);
  assert.match(running, /03:42/);
  assert.match(running, /TOOLS\s+42/);
  assert.match(running, /TPS 13\.8/);
  for (const [columns, rows] of [
    [80, 24],
    [55, 20],
    [140, 42],
    [168, 54],
    [200, 70],
    [100, 36],
  ]) {
    terminal.resize(columns!, rows!);
    await delay(120);
    const frame = await capture(`native-running-${columns}x${rows}`);
    assert.match(frame, /HACKINGBENCH/);
    assert.match(frame, /COMMAND/);
    assert.doesNotMatch(frame, /COMMAND\s*\/\/\s*native pi/);
    assert.ok(
      frame.includes("/stop"),
      "Native controls were clipped after resize.",
    );
    assert.ok(
      frame.includes("LLM thinking"),
      "Agent activity was clipped after resize.",
    );
    if (frame.includes("AGENT ACTIVITY"))
      assert.ok(
        frame.includes("THINK") &&
          frame.includes("Inspecting the target network"),
        "Live reasoning was clipped after resize.",
      );
    assert.match(frame, /TPS 13\.8/);
  }
  currentRunner!.pause();
  await until(() => frameIncludes("PAUSED"), "Paused state was not rendered.");
  const paused = await capture("native-paused");
  assert.match(paused, /\/retry/);
  assert.match(paused, /game clock still running/);
  // Like /start above, dispatch through the real native session. This fixture
  // initializes InteractiveMode but does not run its blocking input loop.
  await runtime.session.prompt("/retry");
  await until(
    () => resumes === 1,
    "Native /retry did not resume the active runner.",
  );
  assert.equal(starts, 1, "Recovery must not start another attempt.");
  await until(
    () => frameIncludes("RUNNING"),
    "Resumed phase was not rendered.",
  );
  assert.doesNotMatch(
    await capture("native-resumed"),
    /Extension command.*conflicts/,
  );
  await runtime.session.prompt("/stop");
  await until(
    () => frameIncludes("CANCELLED"),
    "Stopped result was not retained in dashboard.",
  );
  assert.match(await capture("native-stopped"), /TPS 13\.8/);
  assert.ok(terminal.output.includes("RUNNING"));
  mode.clearEditor();
  terminal.type("/thinking definitely-invalid");
  terminal.input?.("\r");
  await until(
    () => frameIncludes("Unknown thinking level"),
    "Real native errors must remain visible.",
  );
  assert.match(
    await capture("native-real-error"),
    /Error: Unknown thinking level/,
  );
  // /start is backed exclusively by FakeRunner here. Never invoke real runner or /test.
  assert.equal(runtime.session.sessionFile, undefined);
  console.log(
    "PASS: real native pi viewport + top-anchored deck + one environment summary + native /config L0/L1/text/image + masked /login + resolving non-error model guidance + native model picker/high thinking + preserved real errors + background fake /start/stop + API pause/native /retry with same run + resize 55–200 columns / up to 70 rows. HTML/text previews: runtime/ui-preview/. No real API/game.",
  );
} catch (error) {
  await capture("native-smoke-failed").catch(() => undefined);
  throw error;
} finally {
  mode.stop();
  await runtime.session.modelRuntime.logout(id).catch(() => undefined);
  await runtime.dispose();
  terminal.dispose();
  await rm(path.join(CONTROLLER_DIR, `${id}.catalog.json`), { force: true });
  // The smoke never changes user config; detect unexpected persistence rather than overwriting it.
  assert.deepEqual(
    await readFile(CONFIG_FILE).catch(() => undefined),
    previousConfig,
  );
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
