import test from "node:test";
import assert from "node:assert/strict";
import { JsonLines } from "../src/core/jsonl.js";
import { RunStats } from "../src/core/stats.js";
import { boundedText } from "../src/game/player.js";
import { defaults } from "../src/config.js";
import { RunController } from "../src/runner.js";
import { supportedBun, runtimeDescription } from "../src/core/runtime.js";

test("runtime detection accepts supported Bun and rejects Node/old versions", () => {
  for (const version of ["1.4.4", "1.4.5", "1.5.0", "2.0.0"])
    assert.equal(supportedBun(version), true);
  for (const version of [
    "",
    "1.3.99",
    "1.4.3",
    "0.9.0",
    "v1.4.4",
    "1.4.4-canary",
  ])
    assert.equal(supportedBun(version), false);
  assert.match(runtimeDescription(), /^Bun /);
});
test("JSONL handles byte fragmentation, UTF-8, CRLF, U+2028/U+2029", () => {
  const records: unknown[] = [];
  const parser = new JsonLines((v) => records.push(v));
  const expected = { text: "你好\u2028one\u2029two" };
  const bytes = Buffer.from(
    JSON.stringify(expected) + "\r\n" + JSON.stringify({ id: 2 }) + "\n",
  );
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  assert.deepEqual(records, [expected, { id: 2 }]);
});
test("JSONL malformed and oversized frames fail closed", () => {
  assert.throws(() => new JsonLines(() => {}).push("{broken}\n"));
  assert.throws(() => new JsonLines(() => {}, 5).push("123456"));
  assert.throws(() => new JsonLines(() => {}, 5).push("123456\n"));
});
test("run telemetry counts tools, failures and tokens without enforcing limits", () => {
  const stats = new RunStats();
  for (let i = 0; i < 100; i++) stats.beginStep();
  stats.finishStep(false);
  stats.finishStep(true);
  stats.tokens = 10_000_000;
  assert.equal(stats.steps, 100);
  assert.equal(stats.errors, 1);
  assert.equal(stats.tokens, 10_000_000);
  assert.ok(stats.elapsedMs >= 0);
  assert.equal(
    "check" in stats,
    false,
    "Statistics must not expose a stop decision.",
  );
});
test("tokens and observations are bounded", () => {
  const output = boundedText("你".repeat(3000));
  assert.ok(Buffer.byteLength(output) <= 4096);
  assert.match(output, /truncated/);
});
test("demo cancellation uses no real game/API and yields no benchmark score", async () => {
  const controller = new RunController();
  const done = controller.run(defaults(), "no-real-key", true);
  controller.stop();
  const result = await done;
  assert.equal(result.demo, true);
  assert.equal(result.score, 0);
  assert.equal(result.status, "cancelled");
});
