import test from "node:test";
import assert from "node:assert/strict";
import { ProviderRecovery, RESUME_PROMPT } from "../src/core/recovery.js";

function fixture() {
  let now = 0;
  const events: string[] = [];
  let requests = 0;
  let restart = async () => {};
  const recovery = new ProviderRecovery({
    now: () => now,
    restart: async () => {
      requests++;
      await restart();
    },
    paused: (reason) => events.push(`paused:${reason}`),
    resumed: () => events.push("resumed"),
    fatal: (error) => events.push(`fatal:${error.message}`),
  });
  return {
    recovery,
    events,
    requests: () => requests,
    time: (value: number) => {
      now = value;
    },
    restart: (value: () => Promise<void>) => {
      restart = value;
    },
  };
}

test("settled provider failures pause without finishing or issuing more model requests", () => {
  for (const reason of [
    "Connection error.",
    "429 rate limit",
    "503 overloaded",
    "Request timed out",
    "Compaction request failed",
  ]) {
    const f = fixture();
    assert.equal(f.recovery.settled(reason), false);
    assert.equal(f.recovery.paused, true);
    assert.equal(f.requests(), 0);
    assert.deepEqual(f.events, [`paused:${reason}`]);
    assert.equal(f.recovery.settled(reason), false);
    assert.equal(f.recovery.settled(""), false);
    assert.equal(f.recovery.snapshot().providerPauses, 1);
  }
});

test("resume keeps the same recovery object and counts pause duration separately", async () => {
  const f = fixture();
  f.time(100);
  f.recovery.settled("Connection error.");
  f.time(600);
  assert.deepEqual(f.recovery.snapshot(), {
    providerPauses: 1,
    providerPauseMs: 500,
  });
  await f.recovery.resume();
  assert.equal(f.requests(), 1);
  assert.equal(f.recovery.paused, false);
  assert.equal(f.recovery.settled(""), true);
  f.time(1000);
  assert.deepEqual(f.recovery.snapshot(), {
    providerPauses: 1,
    providerPauseMs: 500,
  });
  assert.deepEqual(f.events, ["paused:Connection error.", "resumed"]);
  assert.match(RESUME_PROMPT, /First use hn_screen/);
  assert.match(RESUME_PROMPT, /do not blindly replay/);
});

test("concurrent resumes cannot submit duplicate prompts", async () => {
  const f = fixture();
  let release!: () => void;
  f.restart(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  f.recovery.settled("Connection error.");
  const first = f.recovery.resume();
  await assert.rejects(() => f.recovery.resume(), /No paused/);
  assert.equal(f.requests(), 1);
  release();
  await first;
});

test("repeated provider outages can be manually resumed without an attempt quota", async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) {
    assert.equal(f.recovery.settled("Connection error."), false);
    await f.recovery.resume();
  }
  assert.equal(f.requests(), 100);
  assert.equal(f.recovery.snapshot().providerPauses, 100);
  assert.equal(
    f.events.some((e) => e.startsWith("fatal:")),
    false,
  );
});

test("a new provider failure before resume acknowledgement is not accidentally unpaused", async () => {
  const f = fixture();
  f.restart(async () => {
    f.recovery.settled("503 overloaded");
  });
  f.recovery.settled("Connection error.");
  await f.recovery.resume();
  assert.equal(f.recovery.paused, true);
  assert.equal(f.recovery.snapshot().providerPauses, 2);
});

test("stopping while paused freezes pause statistics and rejects later resume", async () => {
  const f = fixture();
  f.recovery.settled("Connection error.");
  f.time(200);
  f.recovery.close();
  f.time(900);
  await assert.rejects(() => f.recovery.resume(), /No paused/);
  assert.equal(f.recovery.settled(""), false);
  assert.deepEqual(f.recovery.snapshot(), {
    providerPauses: 1,
    providerPauseMs: 200,
  });
  assert.equal(f.requests(), 0);
});

test("ambiguous prompt RPC failures are fatal, not automatically replayed", async () => {
  const f = fixture();
  f.restart(async () => {
    throw new Error("Pi RPC timeout: prompt");
  });
  f.recovery.settled("Connection error.");
  await assert.rejects(() => f.recovery.resume(), /RPC timeout/);
  await assert.rejects(() => f.recovery.resume(), /No paused/);
  assert.equal(f.requests(), 1);
  assert.deepEqual(f.events, [
    "paused:Connection error.",
    "resumed",
    "fatal:Pi RPC timeout: prompt",
  ]);
});
