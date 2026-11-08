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
  await assert.rejects(() => player.input("one\ntwo"));
  assert.deepEqual(calls, []);
});
