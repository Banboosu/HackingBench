import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdir } from "node:fs/promises";
import { RUNTIME } from "../src/config.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Bridge } from "../src/game/bridge.js";
import { JsonLines } from "../src/core/jsonl.js";
import { Player } from "../src/game/player.js";

async function fake(handler: (msg: any, reply: (value: any) => void) => void) {
  await mkdir(RUNTIME, { recursive: true });
  const pipe =
    process.platform === "win32"
      ? `\\\\.\\pipe\\hnb-test-${randomUUID()}`
      : path.join(RUNTIME, `hnb-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    const parser = new JsonLines((msg) =>
      handler(msg, (value) =>
        socket.write(JSON.stringify({ id: msg.id, result: value }) + "\n"),
      ),
    );
    socket.on("data", (b) => parser.push(b));
  });
  await new Promise<void>((resolve) => server.listen(pipe, resolve));
  return {
    pipe,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
test("bridge auth handshake, multiplexing and close reject pending calls", async () => {
  const server = await fake((msg, reply) => {
    if (msg.method === "auth")
      reply({ authenticated: msg.params.token === "test-token" });
    else if (msg.method === "slow") setTimeout(() => reply("slow"), 30);
    else if (msg.method === "fast") reply("fast");
  });
  const bridge = new Bridge(server.pipe, "test-token", 500);
  try {
    await bridge.connect();
    assert.deepEqual(
      await Promise.all([bridge.call("slow"), bridge.call("fast")]),
      ["slow", "fast"],
    );
    const pending = bridge.call("never");
    const rejected = assert.rejects(pending, /closed/);
    bridge.close();
    await rejected;
    assert.equal((bridge as any).pending.size, 0);
  } finally {
    bridge.close();
    await server.close();
  }
});
test("bridge authentication failure and timeout are clean", async () => {
  const server = await fake((msg, reply) => {
    if (msg.method === "auth")
      reply({ authenticated: msg.params.token === "correct" });
  });
  const wrong = new Bridge(server.pipe, "wrong", 50);
  const right = new Bridge(server.pipe, "correct", 50);
  try {
    await assert.rejects(() => wrong.connect(), /authentication/);
    await right.connect();
    await assert.rejects(() => right.call("no-response"), /timed out/);
    assert.equal((right as any).pending.size, 0);
    const abort = new AbortController();
    const pending = right.call("no-response", {}, abort.signal);
    const rejected = assert.rejects(pending, /aborted/);
    abort.abort();
    await rejected;
    assert.equal((right as any).pending.size, 0);
  } finally {
    wrong.close();
    right.close();
    await server.close();
  }
});
test("player rejects host/cheat calls before they reach the bridge", async () => {
  const calls: string[] = [];
  const bridge = {
    call: async (method: string) => {
      calls.push(method);
      return {};
    },
  } as unknown as Bridge;
  const player = new Player(bridge);
  await assert.rejects(() => player.cmd("mcp exec help"));
  await assert.rejects(() => player.cmd("ls\nwhoami"));
  await assert.rejects(() => player.wait(31));
  await assert.rejects(() => player.mail("read", -1));
  await assert.rejects(() => player.hub("accept", "../../unsafe"));
  await assert.rejects(() => player.hub("read", "../../unsafe"));
  await assert.rejects(() => player.hub("read"));
  await assert.rejects(() => player.hub("finish" as "accept", "listing:0"));
  await assert.rejects(() => player.input("one\ntwo"));
  await assert.rejects(() => player.shell("format" as unknown as "overload"));
  assert.deepEqual(calls, []);
});
test("hub list/read/accept preserve selected board IDs and use only the benchmark adapter", async () => {
  const calls: unknown[] = [];
  const bridge = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { ok: true };
    },
  } as unknown as Bridge;
  const player = new Player(bridge);
  await player.hub("list");
  await player.hub("read", "listing:0");
  await player.hub("accept", "listing:0");
  assert.deepEqual(calls, [
    { method: "bench.hub", params: { action: "list", id: undefined } },
    { method: "bench.hub", params: { action: "read", id: "listing:0" } },
    { method: "bench.hub", params: { action: "accept", id: "listing:0" } },
  ]);
});

test("player command polls terminal output instead of requiring a manual wait", async () => {
  let historyCalls = 0;
  const bridge = {
    call: async (method: string) => {
      if (method === "terminal.history") {
        historyCalls++;
        return historyCalls === 1
          ? { lines: [], total: 0 }
          : { lines: ["command output"], total: 1 };
      }
      if (method === "bench.command") return { ok: true };
      throw new Error(`unexpected bridge method: ${method}`);
    },
  } as unknown as Bridge;
  const player = new Player(bridge);
  const result = (await player.cmd("help")) as any;
  assert.deepEqual(result.lines, ["command output"]);
  assert.equal(result.note, undefined);
  assert.ok(
    historyCalls >= 3,
    "After output appeared, the player must wait for it to settle.",
  );
});
test("player command promotes output that arrives in the final screen read", async () => {
  const bridge = {
    call: async (method: string) => {
      if (method === "terminal.history") return { lines: [], total: 0 };
      if (method === "bench.command") return { ok: true };
      if (method === "bench.screen")
        return {
          connectedIP: "192.0.2.5",
          prompt: "192.0.2.5@> ",
          network: [{ name: "fixture", ip: "192.0.2.5", connected: true }],
          terminal: { lines: ["Scan Complete"], total: 1 },
        };
      throw new Error(`unexpected bridge method: ${method}`);
    },
  } as unknown as Bridge;
  const player = new Player(bridge);
  const result = (await player.cmd("scan")) as any;
  assert.deepEqual(result.lines, ["Scan Complete"]);
  assert.equal(result.note, undefined);
  assert.equal(result.output, undefined);
});
test("unchanged commands return labelled current terminal context and state", async () => {
  const bridge = {
    call: async (method: string) => {
      if (method === "terminal.history")
        return { lines: ["previous output"], total: 1 };
      if (method === "bench.command") return { ok: true };
      if (method === "bench.screen")
        return {
          connectedIP: "192.0.2.5",
          prompt: "192.0.2.5/bin/> ",
          terminal: { lines: ["previous output"], total: 1 },
        };
      throw new Error(`unexpected bridge method: ${method}`);
    },
  } as unknown as Bridge;
  const result = (await new Player(bridge).cmd("cd bin")) as any;
  assert.deepEqual(result.lines, ["previous output"]);
  assert.equal(result.output, "snapshot");
  assert.equal(result.screen.prompt, "192.0.2.5/bin/> ");
  assert.equal(result.note, undefined);
});

function scriptedTerminal(frames: { lines: string[]; total: number }[]) {
  let reads = 0;
  const bridge = {
    call: async (method: string) => {
      if (method === "terminal.history")
        return frames[Math.min(reads++, frames.length - 1)];
      if (method === "bench.command") return { ok: true };
      throw new Error(`unexpected bridge method: ${method}`);
    },
  } as unknown as Bridge;
  return { player: new Player(bridge), reads: () => reads };
}

test("player returns rolling terminal output even when total stays 29", async () => {
  const old = Array.from({ length: 29 }, (_, i) => `old ${i}`);
  const fixture = scriptedTerminal([
    { lines: old, total: 29 },
    { lines: [...old.slice(3), "> ls", ":home", ":bin"], total: 29 },
  ]);
  const result = (await fixture.player.cmd("ls")) as any;
  assert.deepEqual(result.lines, ["> ls", ":home", ":bin"]);
  assert.equal(result.note, undefined);
});

test("player waits for row content to settle, not only its count", async () => {
  const fixture = scriptedTerminal([
    { lines: ["old"], total: 100 },
    { lines: ["old", "Probing ."], total: 101 },
    { lines: ["old", "Probing .."], total: 101 },
    { lines: ["old", "Probing ...Complete"], total: 101 },
  ]);
  const result = (await fixture.player.cmd("probe")) as any;
  assert.deepEqual(result.lines, ["Probing ...Complete"]);
  assert.ok(
    fixture.reads() >= 6,
    "Each content update must reset the quiet timer.",
  );
});

test("player waits for delayed and multi-batch output", async () => {
  const unchanged = { lines: ["old"], total: 100 };
  const fixture = scriptedTerminal([
    unchanged,
    unchanged,
    unchanged,
    unchanged,
    { lines: ["old", "first"], total: 101 },
    { lines: ["old", "first", "second"], total: 102 },
  ]);
  assert.deepEqual(((await fixture.player.cmd("help")) as any).lines, [
    "first",
    "second",
  ]);
});

test("player keeps output written after clear instead of returning early", async () => {
  const fixture = scriptedTerminal([
    { lines: ["old 1", "old 2"], total: 100 },
    { lines: [], total: 0 },
    { lines: ["fresh output"], total: 1 },
  ]);
  const result = (await fixture.player.cmd("clear")) as any;
  assert.equal(result.cleared, true);
  assert.deepEqual(result.lines, ["fresh output"]);
});

test("player command terminal polling remains cancellable", async () => {
  const fixture = scriptedTerminal([{ lines: [], total: 0 }]);
  const controller = new AbortController();
  const pending = fixture.player.cmd("ls", controller.signal);
  const rejected = assert.rejects(pending, /abort/i);
  controller.abort();
  await rejected;
});

test("player shell drives only the reviewed overload bridge method", async () => {
  const calls: [string, unknown][] = [];
  const bridge = {
    call: async (method: string, params: unknown) => {
      calls.push([method, params]);
      return { ok: true };
    },
  } as unknown as Bridge;
  const player = new Player(bridge);
  await player.shell("overload");
  await player.shell("cancel");
  await player.shell("exit");
  assert.deepEqual(calls, [
    ["bench.shell", { action: "overload" }],
    ["bench.shell", { action: "cancel" }],
    ["bench.shell", { action: "exit" }],
  ]);
});
