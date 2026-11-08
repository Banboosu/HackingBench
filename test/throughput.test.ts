import test from "node:test";
import assert from "node:assert/strict";
import { OutputThroughput } from "../src/core/throughput.js";

test("TPS stays unknown until a completed generation reports usage", () => {
  let now = 0;
  const meter = new OutputThroughput(() => now);
  assert.equal(meter.snapshot().outputTps, undefined);
  meter.start();
  now = 3000;
  assert.equal(meter.snapshot().outputTps, undefined);
  meter.complete(120);
  assert.deepEqual(meter.snapshot(), {
    outputTokens: 120,
    generationMs: 3000,
    tpsSamples: 1,
    outputTps: 40,
  });
});

test("TPS is weighted output throughput, excluding time spent running tools", () => {
  let now = 0;
  const meter = new OutputThroughput(() => now);
  meter.start();
  now = 1000;
  meter.complete(100); // 100 TPS
  now += 10000; // tool execution / no generation
  meter.start();
  now += 3000;
  meter.complete(60); // 20 TPS
  // Weighted rate is 160/4 = 40, not the average of 100 and 20, or 160/14.
  assert.deepEqual(meter.snapshot(), {
    outputTokens: 160,
    generationMs: 4000,
    tpsSamples: 2,
    outputTps: 40,
  });
});

test("missing or invalid output usage never creates fabricated TPS", () => {
  let now = 0;
  const meter = new OutputThroughput(() => now);
  for (const tokens of [
    undefined,
    null,
    "30",
    NaN,
    Infinity,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    meter.start();
    now += 1000;
    meter.complete(tokens);
  }
  assert.deepEqual(meter.snapshot(), {
    outputTokens: 0,
    generationMs: 0,
    tpsSamples: 0,
    outputTps: undefined,
  });
  meter.start();
  now += 1000;
  meter.complete(0);
  assert.equal(
    meter.snapshot().outputTps,
    0,
    "Explicit zero output is valid, unlike missing usage.",
  );
});

test("failed, aborted or incomplete generations do not dilute TPS", () => {
  let now = 0;
  const meter = new OutputThroughput(() => now);
  meter.start();
  now = 2000;
  meter.complete(100);
  meter.start();
  now += 5000;
  meter.complete(500, false);
  meter.start();
  now += 5000;
  meter.discard();
  meter.complete(1000);
  meter.complete(999); // duplicate end without a start
  assert.deepEqual(meter.snapshot(), {
    outputTokens: 100,
    generationMs: 2000,
    tpsSamples: 1,
    outputTps: 50,
  });
});

test("pi default all-zero usage is unknown; explicitly reported input with zero output is valid", () => {
  let now = 0;
  const meter = new OutputThroughput(() => now);
  for (const usage of [
    undefined,
    {},
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  ]) {
    meter.start();
    now += 1000;
    meter.completeUsage(usage);
  }
  assert.equal(meter.snapshot().outputTps, undefined);
  meter.start();
  now += 1000;
  meter.completeUsage({ input: 20, output: 0 });
  assert.equal(meter.snapshot().outputTps, 0);
  meter.start();
  now += 1000;
  meter.completeUsage({ input: 50, output: 40 });
  assert.equal(meter.snapshot().outputTokens, 40);
  assert.equal(meter.snapshot().outputTps, 20);
});

test("zero or negative generation durations are refused", () => {
  let now = 10;
  const meter = new OutputThroughput(() => now);
  meter.start();
  meter.complete(20);
  meter.start();
  now--;
  meter.complete(20);
  meter.start();
  now = Infinity;
  meter.complete(20);
  assert.equal(meter.snapshot().outputTps, undefined);
});
