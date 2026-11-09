import { setTimeout as delay } from "node:timers/promises";
import { Bridge } from "./bridge.js";
import { validateCommand } from "../core/safety.js";
import { sameTerminal, terminalDelta, terminalHistory } from "./terminal.js";

export function boundedText(value: unknown, maxBytes = 4096): string {
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return (
    Buffer.from(text)
      .subarray(0, maxBytes - 64)
      .toString("utf8") + "\n[Observation truncated to 4 KiB]"
  );
}
export class Player {
  constructor(private bridge: Bridge) {}
  async screen(signal?: AbortSignal): Promise<unknown> {
    return this.bridge.call("bench.screen", {}, signal);
  }
  async cmd(input: string, signal?: AbortSignal): Promise<unknown> {
    const cmd = validateCommand(input);
    const readHistory = async () =>
      terminalHistory(
        await this.bridge.call("terminal.history", { lines: 120 }, signal),
      );
    const before = await readHistory();
    await this.bridge.call("bench.command", { cmd }, signal);
    // OS.execute runs asynchronously. Stability is based on content, NOT
    // just the count: write() appends to existing rows and legacy bridges may
    // return a fixed-size rolling window whose total never increases.
    const deadline = performance.now() + 1500;
    const settleMs = 120;
    let lastChange = performance.now();
    let changed = false;
    let reset = false;
    let after = before;
    while (performance.now() < deadline) {
      await delay(40, undefined, { signal });
      const next = await readHistory();
      if (!sameTerminal(after, next)) {
        reset ||= terminalDelta(after, next).reset;
        changed = true;
        lastChange = performance.now();
      }
      after = next;
      if (changed && performance.now() - lastChange >= settleMs) break;
    }
    const output = () => {
      const delta = terminalDelta(before, after);
      const cleared = reset || delta.reset;
      return {
        cmd,
        lines: (cleared ? after.lines : delta.lines).slice(-120),
        ...(cleared ? { cleared: true } : {}),
      };
    };
    let result = output();
    if (result.lines.length || result.cleared) return result;
    const snapshot = (await this.screen(signal)) as Record<string, any>;
    // Output can arrive between the last poll and this fresh screen read.
    // Promote it to the primary result instead of incorrectly claiming silence.
    if (snapshot.terminal) after = terminalHistory(snapshot.terminal);
    result = output();
    if (result.lines.length || result.cleared) return result;
    // No observable change: provide explicitly labelled current context/state,
    // never an empty primary result paired with a misleading 'no new line'.
    const terminal = { lines: after.lines.slice(-20), total: after.total };
    return {
      cmd,
      lines: terminal.lines,
      output: "snapshot",
      screen: {
        connectedIP: snapshot.connectedIP,
        connectedName: snapshot.connectedName,
        thisComputerIP: snapshot.thisComputerIP,
        prompt: snapshot.prompt,
        awaitingInput: snapshot.awaitingInput,
        tutorial: snapshot.tutorial,
        network: snapshot.network,
        processes: snapshot.processes,
        shells: snapshot.shells,
        proxy: snapshot.proxy,
        terminal,
      },
    };
  }
  async shell(
    action: "overload" | "cancel" | "exit",
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!["overload", "cancel", "exit"].includes(action))
      throw new Error("Unknown shell action.");
    return this.bridge.call("bench.shell", { action }, signal);
  }
  async wait(seconds: number, signal?: AbortSignal): Promise<unknown> {
    if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 30)
      throw new Error("Wait must be 0.1–30 seconds.");
    await delay(seconds * 1000, undefined, { signal });
    return this.screen(signal);
  }
  async input(text: string, signal?: AbortSignal): Promise<unknown> {
    if (
      typeof text !== "string" ||
      text.length > 256 ||
      /[\p{Cc}\p{Cf}]/u.test(text)
    )
      throw new Error("Prompt input must be at most 256 printable characters.");
    return this.bridge.call("bench.input", { text }, signal);
  }
  async tutorial(
    action: "continue" | "hint",
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!["continue", "hint"].includes(action))
      throw new Error("Unknown tutorial button.");
    return this.bridge.call("bench.tutorial", { action }, signal);
  }
  async mail(
    action: "list" | "read",
    id?: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      !["list", "read"].includes(action) ||
      (action === "read" && (!Number.isInteger(id) || id! < 0))
    )
      throw new Error("Use list, or read with a nonnegative mail ID.");
    return this.bridge.call("bench.mail", { action, id }, signal);
  }
  async reply(
    id: number,
    answer: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      !Number.isInteger(id) ||
      id < 0 ||
      typeof answer !== "string" ||
      answer.length > 2000
    )
      throw new Error("Invalid mail reply.");
    return this.bridge.call("bench.reply", { id, answer }, signal);
  }
  async hub(
    action: "list" | "accept",
    id?: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (
      !["list", "accept"].includes(action) ||
      (action === "accept" &&
        (!id || !/^(contract|listing|dhs):[a-zA-Z0-9_.-]{1,100}$/.test(id)))
    )
      throw new Error("Use a listing ID returned by hn_hub.");
    return this.bridge.call("bench.hub", { action, id }, signal);
  }
  async capture(
    signal?: AbortSignal,
  ): Promise<{ data: string; mimeType: string }> {
    const image = await this.bridge.call("bench.capture", {}, signal);
    if (
      image.mimeType !== "image/png" ||
      typeof image.data !== "string" ||
      image.data.length > 8_000_000
    )
      throw new Error("Invalid or oversized game screenshot.");
    return image;
  }
}
