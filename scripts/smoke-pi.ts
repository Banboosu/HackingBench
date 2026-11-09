import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaults, RUNTIME } from "../src/config.js";
import { findExecutable } from "../src/environment.js";
import { createJail } from "../src/pi/jail.js";
import { PiRpc } from "../src/pi/rpc.js";
import { JsonLines } from "../src/core/jsonl.js";
import { OutputThroughput } from "../src/core/throughput.js";
import { PLAYER_TOOLS } from "../src/core/safety.js";
import { testProvider } from "../src/provider.js";
import { ProviderRecovery, RESUME_PROMPT } from "../src/core/recovery.js";
import { setTimeout as delay } from "node:timers/promises";

// Actual pi 1.5 RPC process + fake local model + fake local game. No game/real API/key needed.
const pi = await findExecutable("pi");
if (!pi) throw new Error("pi.exe/ pi not found on PATH.");
const seenTools: string[][] = [];
let assertions: Error | undefined;
let holdModel = false;
let failModel = false;
let modelRequests = 0;
let onHeldRequest: (() => void) | undefined;
const model = http.createServer(async (req, res) => {
  try {
    modelRequests++;
    let body = "";
    for await (const b of req) body += b;
    const payload = JSON.parse(body);
    assert.equal(req.headers.authorization, "Bearer test-only-key");
    assert.equal(
      payload.reasoning_effort,
      "high",
      "Thinking high must be sent on the wire, not just displayed.",
    );
    if (failModel) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "temporary outage (fake provider)",
            type: "server_error",
          },
        }),
      );
      return;
    }
    if (holdModel) {
      onHeldRequest?.();
      return;
    }
    const names = (payload.tools ?? []).map((t: any) => t.function.name);
    seenTools.push(names);
    const toolReply = payload.messages?.some((m: any) => m.role === "tool");
    const callTool = names.length > 0 && !toolReply;
    const common = {
      id: "chat-test",
      object: "chat.completion.chunk",
      created: 1,
      model: "test-local",
    };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (choices: any[], extra: object = {}) =>
      res.write(
        "data: " + JSON.stringify({ ...common, choices, ...extra }) + "\n\n",
      );
    if (callTool)
      send([
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "screen-1",
                type: "function",
                function: { name: "hn_screen", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ]);
    else
      send([
        {
          index: 0,
          delta: { role: "assistant", content: toolReply ? "DONE" : "READY" },
          finish_reason: null,
        },
      ]);
    send(
      [
        {
          index: 0,
          delta: {},
          finish_reason: callTool ? "tool_calls" : "stop",
        },
      ],
      { usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
    );
    res.end("data: [DONE]\n\n");
  } catch (e) {
    assertions = e as Error;
    res.writeHead(500);
    res.end("fake model assertion failed");
  }
});
await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
const port = (model.address() as net.AddressInfo).port;
const pipe =
  process.platform === "win32"
    ? `\\\\.\\pipe\\hnb-pi-test-${randomUUID()}`
    : path.join(RUNTIME, `pi-test-${randomUUID()}.sock`);
const sockets = new Set<net.Socket>();
let screenCalls = 0;
const game = net.createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => undefined);
  const parser = new JsonLines((req) => {
    let result: unknown;
    if (req.method === "auth")
      result = { authenticated: req.params.token === "fake-pipe-token" };
    else if (req.method === "bench.screen") {
      screenCalls++;
      result = { terminal: { lines: ["FAKE GAME SCREEN"] }, network: [] };
    } else throw new Error("Unexpected bridge method: " + req.method);
    socket.write(JSON.stringify({ id: req.id, result }) + "\n");
  });
  socket.on("data", (b) => parser.push(b));
});
await mkdir(RUNTIME, { recursive: true });
await new Promise<void>((resolve) => game.listen(pipe, resolve));
const rpc = new PiRpc();
const config = {
  ...defaults(),
  api: "openai-completions" as const,
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: "test-local",
  thinking: "high" as const,
};
const folder = path.join(RUNTIME, "smoke-pi", randomUUID());
const jail = await createJail(
  config,
  folder,
  "test-only-key",
  pipe,
  "fake-pipe-token",
);
let ready = false;
let diagnostic = "";
const throughput = new OutputThroughput();
let timer: NodeJS.Timeout | undefined;
const done = new Promise<void>((resolve, reject) => {
  rpc.on("fault", reject);
  rpc.on("record", (e) => {
    if (e.type === "message_start" && e.message?.role === "assistant")
      throughput.start();
    if (e.type === "message_end" && e.message?.role === "assistant")
      throughput.completeUsage(
        e.message.usage,
        ["stop", "length", "toolUse"].includes(e.message.stopReason),
      );
    if (e.type === "entry_appended" && e.entry?.customType === "bench.ready") {
      assert.deepEqual(e.entry.data.activeTools, PLAYER_TOOLS);
      ready = true;
    }
    if (e.type === "extension_error") reject(new Error(e.error));
    if (
      e.type === "message_end" &&
      e.message?.role === "assistant" &&
      e.message.stopReason === "error"
    )
      reject(new Error(e.message.errorMessage));
    if (e.type === "agent_settled") resolve();
  });
  timer = setTimeout(
    () => reject(new Error("Pi smoke timeout: " + diagnostic.slice(-3000))),
    60000,
  );
});
const observed = done.then(
  () => undefined,
  (error) => error as Error,
);
rpc.on("diagnostic", (s) => {
  diagnostic += s;
});
try {
  console.log(await testProvider(config, "test-only-key", pi));
  rpc.start(pi, jail.args, { cwd: jail.cwd, env: jail.env });
  await rpc.request("get_state");
  await rpc.request("prompt", { message: "/bench-status" });
  assert.equal(
    ready,
    true,
    "Player extension did not handshake. " + diagnostic.slice(-3000),
  );
  const commands = await rpc.request("get_commands");
  assert.deepEqual(
    commands.commands.map((c: any) => c.name),
    ["bench-status"],
  );
  await rpc.request("prompt", {
    message: "Observe the screen using hn_screen, then stop.",
  });
  const failure = await observed;
  if (failure) throw failure;
  assert.equal(screenCalls, 1);
  const stats = await rpc.request("get_session_stats");
  assert.ok(
    stats.tokens?.total >= 50,
    "Pi session token accounting was not reported.",
  );
  const measured = throughput.snapshot();
  assert.equal(measured.tpsSamples, 2);
  assert.equal(
    measured.outputTokens,
    10,
    "TPS must use output usage, not total input+output tokens.",
  );
  assert.ok(measured.generationMs > 0);
  assert.ok(
    Number.isFinite(measured.outputTps) && measured.outputTps! > 0,
    "Completed RPC generations did not yield measured TPS.",
  );
  assert.ok(
    seenTools.some((names) => names.length === 0),
    "Preflight had tools enabled.",
  );
  for (const names of seenTools.filter((n) => n.length))
    assert.deepEqual([...names].sort(), [...PLAYER_TOOLS].sort());
  if (assertions) throw assertions;

  // The real pi process must remain usable after its native retry budget is
  // exhausted. Keep its session/tool results, pause requests, then resume once.
  const sessionBefore = await rpc.request("get_state");
  let providerError = "";
  let pauseEvents = 0;
  let resumeEvents = 0;
  let fatal: Error | undefined;
  const recovery = new ProviderRecovery({
    restart: async () => {
      providerError = "";
      const accepted = await rpc.request("prompt", { message: RESUME_PROMPT });
      assert.equal(accepted.disposition, "started");
    },
    paused: () => {
      pauseEvents++;
    },
    resumed: () => {
      resumeEvents++;
    },
    fatal: (error) => {
      fatal = error;
    },
  });
  const recoveryListener = (event: any) => {
    if (event.type === "message_end" && event.message?.role === "assistant")
      providerError =
        event.message.stopReason === "error" ? event.message.errorMessage : "";
    if (event.type === "agent_settled") recovery.settled(providerError);
  };
  const nextSettled = () =>
    new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        rpc.off("record", listener);
        reject(new Error("Recovery smoke did not reach agent_settled."));
      }, 30000);
      const listener = (event: any) => {
        if (event.type !== "agent_settled") return;
        clearTimeout(timeout);
        rpc.off("record", listener);
        resolve();
      };
      rpc.on("record", listener);
    });
  rpc.on("record", recoveryListener);
  try {
    failModel = true;
    const failed = nextSettled();
    await rpc.request("prompt", {
      message: "Exercise transient provider outage recovery.",
    });
    await failed;
    assert.equal(recovery.paused, true);
    assert.equal(pauseEvents, 1);
    assert.equal((await rpc.request("get_state")).isStreaming, false);
    const pausedRequests = modelRequests;
    await delay(150);
    assert.equal(
      modelRequests,
      pausedRequests,
      "Paused sessions must not issue model requests.",
    );
    failModel = false;
    const resumed = nextSettled();
    await recovery.resume();
    await resumed;
    assert.equal(recovery.paused, false);
    assert.equal(resumeEvents, 1);
    assert.equal(fatal, undefined);
    assert.equal(
      (await rpc.request("get_state")).sessionId,
      sessionBefore.sessionId,
    );
    const retained = await rpc.request("get_messages");
    assert.ok(
      retained.messages.some(
        (m: any) => m.role === "toolResult" && m.toolCallId === "screen-1",
      ),
    );
    assert.equal(
      screenCalls,
      1,
      "Completed tool calls must not be replayed on resume.",
    );
    assert.equal(providerError, "");
    console.log(
      "RECOVERY: real RPC exhausted 503 retries, paused requests, resumed same session with prior tool results and no tool replay.",
    );
  } finally {
    failModel = false;
    recovery.close();
    rpc.off("record", recoveryListener);
  }
  holdModel = true;
  const controller = new AbortController();
  const held = new Promise<void>((resolve) => {
    onHeldRequest = resolve;
  });
  const cancelled = testProvider(
    config,
    "test-only-key",
    pi,
    controller.signal,
  );
  const cancelObserved = cancelled.then(
    () => undefined,
    (error) => error as Error,
  );
  await Promise.race([
    held,
    new Promise<never>((_resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("Held preflight was not sent.")),
        15000,
      );
      t.unref();
      held.finally(() => clearTimeout(t));
    }),
  ]);
  const cancellingAt = performance.now();
  controller.abort();
  assert.match((await cancelObserved)?.message ?? "", /cancelled/);
  assert.ok(
    performance.now() - cancellingAt < 5000,
    "Preflight cancellation waited for model timeout.",
  );
  console.log(
    "PASS: actual pi 1.5 RPC + high on wire + output-usage TPS + exact player-tool loadout + fake bridge + cancellable blocked preflight. No real API/game used.",
  );
} finally {
  if (timer) clearTimeout(timer);
  await rpc.stop();
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => game.close(() => resolve()));
  model.closeAllConnections();
  await new Promise<void>((resolve) => model.close(() => resolve()));
}
