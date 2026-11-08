import { EventEmitter } from "node:events";
import { appendFile, mkdir, open, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { RUNTIME, gameWindow, writeJson, type BenchConfig } from "./config.js";
import { inspect } from "./environment.js";
import { prepareGame } from "./game/setup.js";
import { GameSession } from "./game/session.js";
import { PLAYER_TOOLS, assertNoLinks, redact } from "./core/safety.js";
import { RunStats } from "./core/stats.js";
import { OutputThroughput } from "./core/throughput.js";
import { Journal } from "./core/journal.js";
import { PiRpc } from "./pi/rpc.js";
import { createJail } from "./pi/jail.js";
import { testProvider } from "./provider.js";

export type RunStatus =
  | "success"
  | "gave_up"
  | "cancelled"
  | "infra_error";
export interface RunResult {
  runId: string;
  status: RunStatus;
  score: number;
  model: string;
  api: string;
  endpoint: string;
  startedAt: string;
  wallMs: number;
  steps: number;
  errors: number;
  tokens: number;
  llmMs: number;
  toolMs: number;
  knowledge: string;
  observation: string;
  error?: string;
  outputTokens?: number;
  generationMs?: number;
  outputTps?: number;
  tpsSamples?: number;
  goal: string;
  evidence?: unknown;
  demo: boolean;
  thinking: string;
  provenance?: {
    pi: string;
    runtime: string;
    pathfinder: string;
    adapter: string;
    game: string;
  };
}
export class RunController extends EventEmitter {
  private cancellation = new AbortController();
  private rpc?: PiRpc;
  private game?: GameSession;
  private stoppedAt?: number;
  private stopping?: RunStatus;
  private wake?: () => void;
  private active = false;
  stop(): void {
    this.cancellation.abort();
    this.finish("cancelled");
  }
  private finish(status: RunStatus): void {
    if (this.stopping) return;
    this.stopping = status;
    this.stoppedAt = performance.now();
    this.wake?.();
  }
  private log(message: string): void {
    this.emit("log", message);
  }
  async run(
    config: BenchConfig,
    key: string,
    demo = false,
  ): Promise<RunResult> {
    if (this.active) throw new Error("A run is already active.");
    this.active = true;
    if (demo) return this.demo(config);
    const runId =
      new Date().toISOString().replace(/[:.]/g, "-") +
      "-" +
      randomUUID().slice(0, 8);
    const folder = path.join(RUNTIME, "runs", runId);
    const startedAt = new Date().toISOString();
    let stats: RunStats | undefined;
    let timer: NodeJS.Timeout | undefined;
    let judge: NodeJS.Timeout | undefined;
    let tokenTimer: NodeJS.Timeout | undefined;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    let game: GameSession | undefined;
    let error: string | undefined;
    let evidence: unknown;
    let provenance: RunResult["provenance"];
    let llmMs = 0;
    let toolMs = 0;
    let thinkingSince: number | undefined;
    const throughput = new OutputThroughput();
    let journal: Journal | undefined;
    const signal = this.cancellation.signal;
    const safeLog = (s: string) => this.log(redact(s, [key]));
    const record = (
      file: "events.jsonl" | "commands.jsonl",
      value: unknown,
    ) => {
      try {
        journal?.append(file, value);
      } catch (e) {
        error = (e as Error).message;
        this.finish("infra_error");
      }
    };
    try {
      const env = await inspect(config);
      if (env.problems.length) throw new Error(env.problems.join("\n"));
      if (!key)
        throw new Error(
          "No API key: use native /login in the HackingBench control deck first.",
        );
      this.emit("phase", "PREFLIGHT");
      safeLog("Checking model connectivity through isolated pi (no tools)…");
      safeLog(await testProvider(config, key, env.pi!, signal));
      signal.throwIfAborted();
      this.emit("phase", "SETUP");
      await prepareGame(config, safeLog);
      signal.throwIfAborted();
      await mkdir(RUNTIME, { recursive: true });
      await assertNoLinks(RUNTIME, folder);
      await assertNoLinks(RUNTIME, path.join(RUNTIME, "active-run.lock"));
      lock = await open(path.join(RUNTIME, "active-run.lock"), "wx");
      await lock.writeFile(JSON.stringify({ pid: process.pid, runId }));
      await mkdir(folder, { recursive: true });
      game = new GameSession();
      this.game = game;
      const token = game.token;
      journal = new Journal(folder, [key, token]);
      await writeJson(path.join(folder, "config.json"), config);
      game.on("diagnostic", (text) =>
        record("events.jsonl", { type: "game_log", text }),
      );
      game.on("fault", (e) => {
        error = e.message;
        this.finish("infra_error");
      });
      this.emit("phase", "BOOTING");
      safeLog(
        "Starting project game copy; personal Steam instance is not used or stopped.",
      );
      const initial = await game.start(folder, gameWindow(config), signal);
      const marker = JSON.parse(
        await readFile(
          path.join(RUNTIME, "game", ".hackingbench-install.json"),
          "utf8",
        ),
      );
      provenance = {
        pi: env.piVersion!,
        runtime: env.runtime,
        pathfinder: marker.pathfinder,
        adapter: marker.adapterFingerprint,
        game: marker.gameSha256,
      };
      stats = new RunStats();
      const jail = await createJail(config, folder, key, game.pipe, token);
      const rpc = new PiRpc();
      this.rpc = rpc;
      let ready = false;
      let lastProviderError = "";
      let statsInFlight = false;
      const checkCompletion = async () => {
        try {
          const value = await game!.bridge!.call("bench.judge");
          evidence = value;
          if (value.completed) {
            this.finish("success");
            return true;
          }
        } catch (e) {
          error = (e as Error).message;
          this.finish("infra_error");
        }
        return false;
      };
      const calls = new Map<string, string>();
      rpc.on("diagnostic", (s) =>
        record("events.jsonl", { type: "pi_diagnostic", text: s }),
      );
      rpc.on("fault", (e) => {
        error = redact(e.message, [key, token]);
        this.finish("infra_error");
      });
      rpc.on("record", (e) => {
        if (e.type !== "message_update") record("events.jsonl", e);
        if (
          e.type === "entry_appended" &&
          e.entry?.customType === "bench.ready"
        ) {
          const expected: string[] = [
            ...PLAYER_TOOLS,
            ...(config.observation === "text+image" ? ["hn_screenshot"] : []),
          ];
          const actual = e.entry.data?.activeTools;
          ready =
            Array.isArray(actual) &&
            actual.length === expected.length &&
            actual.every((n: string) => expected.includes(n));
        }
        if (e.type === "extension_error") {
          error = e.error;
          this.finish("infra_error");
        }
        if (e.type === "message_start" && e.message?.role === "assistant") {
          thinkingSince = performance.now();
          throughput.start();
          this.emit("activity", "thinking");
        }
        if (
          e.type === "message_update" &&
          e.assistantMessageEvent?.type === "text_delta"
        )
          this.emit("assistant", e.assistantMessageEvent.delta);
        if (e.type === "message_end" && e.message?.role === "assistant") {
          if (thinkingSince !== undefined) {
            llmMs += Math.max(
              0,
              Math.min(performance.now(), this.stoppedAt ?? Infinity) -
                thinkingSince,
            );
            thinkingSince = undefined;
          }
          if (this.stopping) throughput.discard();
          else
            throughput.completeUsage(
              e.message.usage,
              ["stop", "length", "toolUse"].includes(e.message.stopReason),
            );
          if (e.message.stopReason === "error")
            lastProviderError = e.message.errorMessage ?? "Provider error";
          else lastProviderError = "";
          this.emit("activity", "waiting for tools");
        }
        if (e.type === "tool_execution_start") {
          calls.set(e.toolCallId, JSON.stringify([e.toolName, e.args]));
          stats!.beginStep();
          this.emit("action", `${e.toolName} ${JSON.stringify(e.args)}`);
          if (e.toolName === "hn_cmd")
            record("commands.jsonl", {
              toolCallId: e.toolCallId,
              args: e.args,
            });
        }
        if (e.type === "tool_execution_end") {
          toolMs += e.durationMs ?? 0;
          const output =
            e.result?.content
              ?.filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n") ?? "";
          stats!.finishStep(!!e.isError);
          calls.delete(e.toolCallId);
          if (output) this.emit("observation", output);
          if (e.result?.details?.benchStatus === "gave_up")
            this.finish("gave_up");
          else if (!this.stopping) void checkCompletion();
        }
        if (e.type === "agent_settled") this.emit("activity", "settled");
        if (e.type === "agent_settled" && !this.stopping && ready) {
          if (lastProviderError) {
            error = lastProviderError;
            this.finish("infra_error");
            return;
          }
          void rpc
            .request("prompt", {
              message:
                "Continue playing toward the campaign ending. Use the game tools; if unable to continue, call hn_give_up.",
            })
            .catch((e) => {
              error = e.message;
              this.finish("infra_error");
            });
        }
      });
      signal.throwIfAborted();
      if (this.stopping)
        throw new Error(error ?? "Run stopped before pi startup.");
      rpc.start(env.pi!, jail.args, { cwd: jail.cwd, env: jail.env });
      await rpc.request("get_state");
      await rpc.request("prompt", { message: "/bench-status" });
      if (!ready)
        throw new Error(
          "Pi player extension handshake failed; no model prompt was sent.",
        );
      signal.throwIfAborted();
      if (this.stopping)
        throw new Error(
          error ?? "Run stopped before the initial model prompt.",
        );
      this.emit("phase", "RUNNING");
      safeLog("Tool-loadout verified. Starting original Hacknet campaign.");
      const finished = new Promise<void>((resolve) => {
        this.wake = resolve;
        if (this.stopping) resolve();
      });
      timer = setInterval(() => {
        const liveLlmMs =
          llmMs +
          (thinkingSince === undefined
            ? 0
            : Math.max(
                0,
                Math.min(performance.now(), this.stoppedAt ?? Infinity) -
                  thinkingSince,
              ));
        this.emit("metrics", {
          wallMs: Math.max(
            0,
            (this.stoppedAt ?? performance.now()) - stats!.started,
          ),
          steps: stats!.steps,
          tokens: stats!.tokens,
          llmMs: liveLlmMs,
          toolMs,
          ...throughput.snapshot(),
        });
      }, 250);
      let judging = false;
      judge = setInterval(() => {
        if (judging || this.stopping) return;
        judging = true;
        void checkCompletion().finally(() => {
          judging = false;
        });
      }, 1000);
      const pollTokens = () => {
        if (statsInFlight || this.stopping) return;
        statsInFlight = true;
        void rpc
          .request("get_session_stats")
          .then((s) => {
            stats!.tokens = s.tokens?.total ?? 0;
          })
          .catch((e) => {
            error = e.message;
            this.finish("infra_error");
          })
          .finally(() => {
            statsInFlight = false;
          });
      };
      tokenTimer = setInterval(pollTokens, 1000);
      const prompt = `Complete the ORIGINAL Hacknet campaign from a fresh account, including its tutorial. DLC content is installed, but this attempt's goal is the base campaign ending. There is no wall-clock, tool-call or token limit; continue until the campaign ending or hn_give_up. Begin by observing the terminal. Never report victory yourself; the runner checks it. Initial screen: ${JSON.stringify(initial).slice(0, 4096)}`;
      const accepted = await rpc.request("prompt", { message: prompt });
      if (accepted?.disposition === "handled")
        throw new Error("Initial game prompt was unexpectedly intercepted.");
      await finished;
      await rpc.request("clear_queue", {}, 3000).catch(() => undefined);
      await rpc.request("abort", {}, 5000).catch(() => undefined);
      const finalStats = await rpc
        .request("get_session_stats", {}, 3000)
        .catch(() => undefined);
      if (finalStats?.tokens?.total) stats.tokens = finalStats.tokens.total;
    } catch (e) {
      error = redact((e as Error).message, [key]);
      if (signal.aborted) this.finish("cancelled");
      else this.finish("infra_error");
      safeLog(error);
    } finally {
      if (timer) clearInterval(timer);
      if (judge) clearInterval(judge);
      if (tokenTimer) clearInterval(tokenTimer);
      if (thinkingSince !== undefined) {
        llmMs += Math.max(
          0,
          Math.min(performance.now(), this.stoppedAt ?? Infinity) -
            thinkingSince,
        );
        thinkingSince = undefined;
      }
      throughput.discard();
      this.emit("phase", "CLEANUP");
      await this.rpc?.stop();
      await game?.close().catch(() => undefined);
      if (lock) {
        await lock.close();
        await rm(path.join(RUNTIME, "active-run.lock"), { force: true });
      }
    }
    const result: RunResult = {
      runId,
      status: this.stopping ?? "infra_error",
      score: this.stopping === "success" ? 1 : 0,
      model: config.model,
      api: config.api,
      endpoint: new URL(config.baseUrl).href,
      startedAt,
      wallMs: stats
        ? Math.max(0, (this.stoppedAt ?? performance.now()) - stats.started)
        : 0,
      steps: stats?.steps ?? 0,
      errors: stats?.errors ?? 0,
      tokens: stats?.tokens ?? 0,
      llmMs,
      toolMs,
      ...throughput.snapshot(),
      knowledge: config.knowledge,
      observation: config.observation,
      error: error ? redact(error, [key, game?.token ?? ""]) : undefined,
      evidence,
      goal: "vanilla-credits-mission-v1-experimental",
      demo: false,
      thinking: config.thinking,
      provenance,
    };
    await mkdir(folder, { recursive: true });
    await writeJson(path.join(folder, "result.json"), result);
    await appendFile(
      path.join(RUNTIME, "results.jsonl"),
      JSON.stringify(result) + "\n",
    );
    this.emit("result", result);
    return result;
  }
  private async demo(config: BenchConfig): Promise<RunResult> {
    this.emit("phase", "DEMO");
    this.log(
      "SIMULATION ONLY — no game, API, credentials, or benchmark score.",
    );
    const started = performance.now();
    let steps = 0;
    try {
      for (const [action, output] of [
        [
          "hn_screen {}",
          "Hacknet OS\nConnection established.\nType help to begin.",
        ],
        [
          'hn_cmd {"cmd":"help"}',
          "connect · scan · probe · ls · cd · cat · scp · porthack",
        ],
        [
          'hn_cmd {"cmd":"connect 192.0.2.17"}',
          "Connected to test node (fictional demo address).",
        ],
        ['hn_cmd {"cmd":"probe"}', "22 SSH — OPEN\nRequired open ports: 1"],
        ['hn_cmd {"cmd":"SSHcrack 22"}', "SSHcrack running…"],
        ['hn_wait {"seconds":2}', "SSH port cracked."],
        ['hn_cmd {"cmd":"porthack"}', "Administrator access granted."],
        ['hn_mail {"action":"list"}', "[0] Welcome\n[1] First assignment"],
      ]) {
        await delay(650, undefined, { signal: this.cancellation.signal });
        this.emit("action", action);
        this.emit("observation", output);
        steps++;
        this.emit("metrics", {
          wallMs: performance.now() - started,
          steps,
          tokens: steps * 310,
          llmMs: steps * 100,
          toolMs: steps * 150,
          outputTokens: steps * 5,
          generationMs: steps * 100,
          outputTps: 50,
          tpsSamples: steps,
        });
      }
    } catch {
      /* User may cancel a demo safely. */
    }
    const result: RunResult = {
      runId: "demo",
      status: this.stopping ?? "success",
      score: 0,
      model: "DEMO / synthetic agent",
      api: "none",
      endpoint: "none",
      startedAt: new Date().toISOString(),
      wallMs: performance.now() - started,
      steps,
      errors: 0,
      tokens: 0,
      llmMs: 0,
      toolMs: 0,
      knowledge: config.knowledge,
      observation: "text",
      goal: "ui-preview-only",
      demo: true,
      thinking: "off",
    };
    this.emit("phase", "FINISHED");
    this.emit("result", result);
    return result;
  }
}
