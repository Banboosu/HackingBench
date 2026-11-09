import {
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { BenchConfig } from "../config.js";
import { terminalText } from "../core/safety.js";

export type EntryKind = "system" | "action" | "game" | "error";
export interface DashboardEntry {
  kind: EntryKind;
  text: string;
}
export interface DashboardState {
  phase: string;
  activity: string;
  wallMs: number;
  steps: number;
  tokens: number;
  llmMs: number;
  toolMs: number;
  action: string;
  observation: string;
  assistant: string;
  reasoning: string;
  log: string;
  history: DashboardEntry[];
  connection: string;
  nodes?: number;
  surface: string;
  credential: "unknown" | "stored";
  result?: string;
  outputTokens?: number;
  generationMs?: number;
  outputTps?: number;
  tpsSamples?: number;
  environment?: {
    runtime: string;
    pi: string;
    game: boolean;
    dlc: boolean;
    problems: number;
  };
}
export function emptyDashboard(): DashboardState {
  return {
    phase: "IDLE",
    activity: "idle",
    wallMs: 0,
    steps: 0,
    tokens: 0,
    llmMs: 0,
    toolMs: 0,
    action: "",
    observation: "",
    assistant: "",
    reasoning: "",
    log: "",
    history: [],
    connection: "",
    surface: "Awaiting game",
    credential: "unknown",
  };
}
/** Sanitize before applying our own ANSI styles, including complete OSC sequences. */
export function displayText(text: string): string {
  return terminalText(stripTerminalSequences(text)).replace(
    /[\p{Cf}\p{Zl}\p{Zp}]/gu,
    "",
  );
}
const oneLine = (text: string) => displayText(text).replace(/[\r\n\t]+/g, " ");
export function appendDashboard(
  state: DashboardState,
  kind: EntryKind,
  text: string,
): void {
  const lines = displayText(text)
    .slice(-16000)
    .split(/\r?\n/)
    .filter((line) => line.trim());
  state.history.push(
    ...lines.slice(-48).map((line) => ({ kind, text: line.slice(-1200) })),
  );
  state.history = state.history.slice(-64);
}
/** Render player-visible terminal data, not JSON braces or privileged judge data. */
export function observeDashboard(state: DashboardState, text: string): void {
  const clean = displayText(text).slice(0, 32000);
  let lines: string[] | undefined;
  try {
    const value = JSON.parse(clean);
    const terminal = value?.terminal?.lines ?? value?.lines;
    if (Array.isArray(terminal))
      lines = terminal.filter(
        (line: unknown): line is string => typeof line === "string",
      );
    if (typeof value?.connectedIP === "string")
      state.connection = [value.connectedName, value.connectedIP]
        .filter((v) => typeof v === "string" && v)
        .join(" / ");
    if (Array.isArray(value?.network)) state.nodes = value.network.length;
    if (value?.tutorial && typeof value.tutorial.text === "string")
      state.surface = "Tutorial visible";
    else if (value?.awaitingInput === true)
      state.surface = "Terminal awaiting input";
    else if (terminal) state.surface = "Game terminal";
    if (lines?.length === 0 && typeof value?.note === "string")
      lines = [value.note];
  } catch {
    /* Bounded/truncated observations and plain demo text are valid display data. */
  }
  state.observation = displayText(lines ? lines.join("\n") : clean).slice(
    -8000,
  );
  appendDashboard(state, "game", state.observation);
}

export type DashboardPaint = Pick<Theme, "fg" | "bg" | "bold">;
const plain: DashboardPaint = {
  fg: (_role, text) => text,
  bg: (_role, text) => text,
  bold: (text) => text,
};
export interface DashboardOptions {
  /** Exact area allocated by the workbench layout; no terminal-height cap. */
  height?: number;
  rows?: number;
  theme?: DashboardPaint;
  frame?: number;
  compact?: boolean;
}
const number = (value: number) =>
  Number.isFinite(value) ? Math.max(0, value) : 0;
export function clock(ms: number): string {
  const seconds = Math.floor(number(ms) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  return `${hours ? `${hours.toString().padStart(2, "0")}:` : ""}${minutes.toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
const count = (value: number) =>
  Math.floor(number(value)).toLocaleString("en-US");
function shortCount(value: number): string {
  const n = number(value);
  return n >= 1000000
    ? `${(n / 1000000).toFixed(1)}m`
    : n >= 10000
      ? `${(n / 1000).toFixed(1)}k`
      : count(n);
}
function clip(text: string, width: number): string {
  return stripTerminalSequences(
    truncateToWidth(oneLine(text), Math.max(0, width), "…"),
  );
}
function fit(text: string, width: number): string {
  const value =
    visibleWidth(text) <= width
      ? text
      : truncateToWidth(text, Math.max(0, width), "…");
  return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}
function pair(
  left: string,
  right: string,
  width: number,
  rightFraction = 0.48,
): string {
  const rightWidth = Math.min(
    visibleWidth(right),
    Math.floor(width * rightFraction),
  );
  return (
    fit(left, Math.max(0, width - rightWidth - 1)) +
    " " +
    fit(right, rightWidth)
  );
}
/** Box cells are measured in terminal columns, never JS string length. */
function panel(
  title: string,
  content: string[],
  width: number,
  height: number,
  p: DashboardPaint,
): string[] {
  const inside = width - 4;
  const caption = clip(title, Math.max(0, width - 6));
  const border = (text: string) => p.fg("borderMuted", text);
  const lines = [
    border("╭─ ") +
      p.fg("accent", caption) +
      border(
        " " + "─".repeat(Math.max(0, width - visibleWidth(caption) - 5)) + "╮",
      ),
  ];
  for (let i = 0; i < height - 2; i++)
    lines.push(
      border("│") + " " + fit(content[i] ?? "", inside) + " " + border("│"),
    );
  lines.push(border("╰" + "─".repeat(width - 2) + "╯"));
  return lines.map((line) => p.bg("toolPendingBg", line));
}
function completedResult(state: DashboardState): string | undefined {
  return ["IDLE", "FINISHED"].includes(state.phase) ? state.result : undefined;
}
function phaseLabel(state: DashboardState, demo: boolean): string {
  const result = completedResult(state);
  return oneLine(
    result
      ? `${demo ? "DEMO " : ""}${result.toUpperCase()}`
      : state.phase === "IDLE"
        ? demo
          ? "DEMO READY"
          : "STANDBY"
        : state.phase,
  );
}
function phaseRole(
  state: DashboardState,
): "success" | "warning" | "error" | "accent" {
  const result = completedResult(state);
  return state.phase === "ERROR" ||
    (result && !["success", "cancelled"].includes(result))
    ? "error"
    : result === "cancelled" || state.phase === "PAUSED"
      ? "warning"
      : state.phase === "IDLE"
        ? "accent"
        : "success";
}
function header(
  state: DashboardState,
  demo: boolean,
  width: number,
  p: DashboardPaint,
): string[] {
  return [
    pair(
      p.fg("accent", p.bold("╱╱ HACKINGBENCH")) + p.fg("dim", "  v0.2"),
      p.fg(phaseRole(state), `● ${phaseLabel(state, demo)}`),
      width,
    ),
    pair(
      p.fg("muted", "AUTONOMOUS HACKNET SPEEDRUN LAB"),
      p.fg(
        demo ? "warning" : "dim",
        demo ? "SIMULATION / NO API OR GAME" : "LOCAL / EXPERIMENTAL",
      ),
      width,
    ),
  ];
}
export function tpsLabel(state: Pick<DashboardState, "outputTps">): string {
  return typeof state.outputTps === "number" &&
    Number.isFinite(state.outputTps) &&
    state.outputTps >= 0
    ? `TPS ${state.outputTps.toFixed(1)}`
    : "TPS —";
}
function activity(
  state: DashboardState,
  width: number,
  p: DashboardPaint,
  frame: number,
): string[] {
  const paused = state.activity === "paused";
  const busy = !["idle", "settled", "paused"].includes(state.activity);
  const spinner = busy
    ? ["◜", "◠", "◝", "◞", "◡", "◟"][Math.abs(frame) % 6]
    : "○";
  const speaking =
    state.activity === "thinking" || state.activity === "responding";
  const reasoning = !!state.reasoning;
  const voice = wrapTextWithAnsi(
    displayText(
      (paused
        ? "Model requests paused. Use /retry to continue. Game time is still running."
        : "") ||
        state.reasoning ||
        state.assistant ||
        (busy
          ? "Waiting for the player agent…"
          : "Agent starts only when you run /start."),
    ),
    Math.max(1, width - 8),
  ).slice(-2);
  return [
    pair(
      p.fg(
        speaking ? "warning" : busy ? "success" : "muted",
        `${spinner} LLM ${oneLine(state.activity)}`,
      ),
      p.fg("accent", tpsLabel(state)) +
        (width >= 62 && (state.llmMs > 0 || state.toolMs > 0 || !!state.action)
          ? p.fg(
              "dim",
              ` · LLM ${(number(state.llmMs) / 1000).toFixed(1)}s · TOOL ${(number(state.toolMs) / 1000).toFixed(1)}s`,
            )
          : ""),
      width,
      0.69,
    ),
    ...(state.action ? [p.fg("accent", clip(`› ${state.action}`, width))] : []),
    ...(paused || reasoning || state.assistant || busy
      ? voice.map((line, i) =>
          p.fg(
            "muted",
            `${i ? "        " : paused ? "PAUSED  " : reasoning ? "THINK   " : "AGENT   "}${line}`,
          ),
        )
      : []),
  ];
}
function terminalLines(
  state: DashboardState,
  width: number,
  height: number,
  p: DashboardPaint,
  demo = false,
): string[] {
  if (height <= 0) return [];
  const history = state.history.length
    ? state.history
    : state.observation
      ? [{ kind: "game" as const, text: state.observation }]
      : [];
  if (!history.length)
    return [
      p.fg(
        "dim",
        demo
          ? "// SIMULATION · no real game or API calls."
          : "// Waiting for the isolated game terminal.",
      ),
      "",
      ...(demo
        ? [
            p.fg("accent", "/start  preview synthetic agent activity"),
            p.fg("muted", "/stop   cancel the preview safely"),
          ]
        : [
            p.fg("muted", "01  /provider     configure your endpoint"),
            p.fg("muted", "02  /login        native pi authentication"),
            p.fg("muted", "03  /model        select an available model"),
            p.fg("accent", "04  /start        begin a fresh account"),
          ]),
    ].slice(0, height);
  const output: string[] = [];
  for (let i = history.length - 1; i >= 0 && output.length < height; i--) {
    const entry = history[i]!;
    const prefix =
      entry.kind === "action"
        ? "❯ "
        : entry.kind === "error"
          ? "! "
          : entry.kind === "system"
            ? "· "
            : "  ";
    const role =
      entry.kind === "action"
        ? "accent"
        : entry.kind === "error"
          ? "error"
          : entry.kind === "system"
            ? "dim"
            : "text";
    const wrapped = displayText(entry.text)
      .split(/\r?\n/)
      .flatMap((line) =>
        wrapTextWithAnsi(line, Math.max(1, width - 2)).map((chunk, j) =>
          p.fg(role, `${j ? "  " : prefix}${chunk}`),
        ),
      );
    output.unshift(...wrapped.slice(-(height - output.length)));
  }
  return output;
}
function operator(
  state: DashboardState,
  config: BenchConfig,
  demo: boolean,
  width: number,
  height: number,
  p: DashboardPaint,
): string[] {
  const label = (text: string) => p.fg("dim", text);
  const value = (text: string) => p.fg("text", clip(text, width));
  const protocol = {
    "openai-completions": "Chat Completions",
    "openai-responses": "OpenAI Responses",
    "anthropic-messages": "Anthropic Messages",
  }[config.api];
  const lines = [
    label(state.result ? "LAST RUN / MODEL" : "MODEL / REASONING"),
    value(demo ? "Synthetic preview" : config.model),
    p.fg("accent", `thinking ${config.thinking}`),
    "",
    label("LINK"),
    value(protocol),
    value(new URL(config.baseUrl).host),
    "",
    label("CAMPAIGN"),
    value("Original / fresh account"),
    p.fg("muted", clip(state.surface, width)),
    p.fg(
      "muted",
      state.nodes === undefined
        ? "DLC not scored"
        : `${state.nodes} visible nodes`,
    ),
    label("CREDENTIAL"),
    p.fg(
      demo ? "muted" : state.credential === "stored" ? "success" : "warning",
      demo
        ? "Not required in demo"
        : state.credential === "stored"
          ? "Stored / project auth"
          : "Project /login",
    ),
  ];
  if (height >= 17)
    lines.push(
      "",
      label("EXPERIMENT /config"),
      value(
        `${config.knowledge} · ${config.observation}${config.skipIntro ? " · skip intro" : ""}`,
      ),
    );
  if (height >= 21 && state.environment)
    lines.push(
      "",
      label("ENVIRONMENT"),
      value(`${state.environment.runtime} / pi ${state.environment.pi}`),
      p.fg(
        state.environment.problems ? "warning" : "success",
        state.environment.problems
          ? "Needs attention /doctor"
          : "Local prerequisites OK",
      ),
    );
  return lines;
}
function telemetry(
  state: DashboardState,
  width: number,
  p: DashboardPaint,
): string[] {
  const inner = width - 4;
  const col = Math.floor(inner / 3);
  const values = [
    ["TIME", clock(state.wallMs)],
    ["TOOLS", count(state.steps)],
    ["TOKENS", shortCount(state.tokens)],
  ] as const;
  const cells = values.map(([label, text], i) => {
    const size = i === 2 ? inner - col * 2 : col;
    return fit(p.fg("dim", label) + "  " + p.fg("text", text), size);
  });
  return panel("RUN TELEMETRY", [cells.join("")], width, 3, p);
}
function statusLines(
  state: DashboardState,
  width: number,
  p: DashboardPaint,
): string[] {
  return state.log
    ? [
        p.fg(
          state.phase === "ERROR" ? "error" : "muted",
          clip(state.log, width),
        ),
      ]
    : [];
}
function compact(
  state: DashboardState,
  demo: boolean,
  width: number,
  height: number,
  p: DashboardPaint,
  frame: number,
): string[] {
  const stats = `TIME ${clock(state.wallMs)}  TOOLS ${count(state.steps)}  TOKENS ${shortCount(state.tokens)}`;
  const notice = statusLines(state, width, p);
  if (height < 11 || width < 44) {
    return [
      p.fg(
        "accent",
        `HACKINGBENCH · ${demo ? "SIMULATION" : phaseLabel(state, demo)}`,
      ),
      pair(
        p.fg("warning", `LLM ${oneLine(state.activity)}`),
        p.fg("accent", tpsLabel(state)),
        width,
        0.55,
      ),
      p.fg("text", stats),
      ...terminalLines(
        state,
        Math.max(1, width),
        Math.max(0, height - 4 - notice.length),
        p,
        demo,
      ),
      ...notice,
      p.fg("warning", "Not an OS sandbox · DLC not scored"),
    ]
      .slice(0, height)
      .map((line) => fit(line, width));
  }
  const gameHeight = height - 4 - notice.length;
  return [
    ...header(state, demo, width, p),
    ...panel(
      "LIVE TERMINAL",
      [
        activity(state, width - 4, p, frame)[0]!,
        ...terminalLines(state, width - 4, gameHeight - 3, p, demo),
      ],
      width,
      gameHeight,
      p,
    ),
    p.fg("text", clip(stats, width)),
    ...notice,
    p.fg(
      "warning",
      clip("Not an OS sandbox · DLC not scored · /stop cancels run", width),
    ),
  ];
}
/** A native pi widget, not a second renderer. Reserve room for native editor/dialogs. */
export function dashboardLines(
  state: DashboardState,
  config: BenchConfig,
  demo: boolean,
  columns: number,
  options: DashboardOptions = {},
): string[] {
  const width = Math.max(1, Math.floor(columns));
  const rows = Math.max(1, Math.floor(options.rows ?? 36));
  const allocated = Math.max(
    1,
    Math.floor(options.height ?? Math.max(6, rows - 6)),
  );
  const height = options.compact ? Math.min(9, allocated) : allocated;
  const p = options.theme ?? plain;
  const frame = options.frame ?? 0;
  const margin = width >= 48 ? 1 : 0;
  const inner = width - margin * 2;
  let lines: string[];
  if (inner < 88 || height < 21)
    lines = compact(state, demo, inner, height, p, frame);
  else {
    const notice = statusLines(state, inner, p);
    const bodyHeight = height - 6 - notice.length;
    const leftWidth = Math.max(26, Math.min(32, Math.floor(inner * 0.26)));
    const rightWidth = inner - leftWidth - 1;
    const activityHeight =
      !state.action &&
      !state.assistant &&
      !state.reasoning &&
      ["idle", "settled", "paused"].includes(state.activity)
        ? 3
        : 6;
    const left = panel(
      "OPERATOR",
      operator(state, config, demo, leftWidth - 4, bodyHeight - 2, p),
      leftWidth,
      bodyHeight,
      p,
    );
    const right = [
      ...panel(
        "AGENT ACTIVITY",
        activity(state, rightWidth - 4, p, frame),
        rightWidth,
        activityHeight,
        p,
      ),
      ...panel(
        state.connection
          ? `LIVE TERMINAL // ${oneLine(state.connection)}`
          : "LIVE TERMINAL",
        terminalLines(
          state,
          rightWidth - 4,
          bodyHeight - activityHeight - 2,
          p,
          demo,
        ),
        rightWidth,
        bodyHeight - activityHeight,
        p,
      ),
    ];
    lines = [
      ...header(state, demo, inner, p),
      "",
      ...left.map((line, i) => line + " " + right[i]),
      ...telemetry(state, inner, p),
      ...notice,
    ];
  }
  return lines.map(
    (line) => " ".repeat(margin) + fit(line, inner) + " ".repeat(margin),
  );
}

export function deckFooter(width: number, p: DashboardPaint = plain): string[] {
  const commands =
    width >= 92
      ? "/start  /retry  /stop   /config  /provider  /login  /model  /thinking   /test   /quit"
      : width >= 55
        ? "/start  /retry  /stop  /config  /login  /model  /quit"
        : "/start  /retry  /stop  /config  /quit";
  return [p.fg("accent", clip(` ${commands}`, width))];
}
