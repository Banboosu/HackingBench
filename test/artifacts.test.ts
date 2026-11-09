import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Journal } from "../src/core/journal.js";
import { command } from "../src/core/process.js";
import { summarizeResults } from "../src/report.js";
import type { RunResult } from "../src/runner.js";
import { temporaryDirectory } from "./fixtures.js";
import { ROOT } from "../src/config.js";
import { childEnvironment } from "../src/core/safety.js";
import { PiRpc } from "../src/pi/rpc.js";

test("journal redacts before JSON escaping, keeping valid JSONL", async () => {
  const dir = await temporaryDirectory("journal-");
  try {
    const key = 'a-key-with-"quotes"-and-\\slashes';
    const journal = new Journal(dir, [key, "pipe-secret"]);
    journal.append("events.jsonl", {
      nested: { text: `API returned ${key}, pipe-secret` },
      data: "x".repeat(100001),
    });
    const parsed = JSON.parse(
      (await readFile(path.join(dir, "events.jsonl"), "utf8")).trim(),
    );
    assert.equal(
      parsed.record.nested.text,
      "API returned [REDACTED], [REDACTED]",
    );
    assert.match(parsed.record.data, /omitted/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Bun config does not auto-load a project .env", async () => {
  const dir = await temporaryDirectory("bun-env-");
  try {
    await writeFile(
      path.join(dir, ".env"),
      "HACKINGBENCH_TEST_DOTENV=must-not-load\n",
    );
    const output = await command(
      process.execPath,
      [
        "--config=" + path.join(ROOT, "bunfig.toml"),
        "-e",
        'process.stdout.write(process.env.HACKINGBENCH_TEST_DOTENV ?? "absent")',
      ],
      { cwd: dir, env: childEnvironment() },
    );
    assert.equal(output, "absent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("owned child command success, failure and timeout cleanup", async () => {
  assert.equal(
    await command(process.execPath, ["-e", 'process.stdout.write("OK")']),
    "OK",
  );
  await assert.rejects(
    () =>
      command(process.execPath, [
        "-e",
        'process.stderr.write("expected failure");process.exit(3)',
      ]),
    /expected failure/,
  );
  await assert.rejects(
    () =>
      command(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeout: 40,
      }),
    /timed out/,
  );
});
test("concurrent RPC stop callers await the same owned-process cleanup", async () => {
  const rpc = new PiRpc();
  rpc.start(
    process.execPath,
    ["-e", "process.stdin.resume();setInterval(()=>{},1000)"],
    { cwd: ROOT, env: childEnvironment() },
  );
  const pending = rpc.request("get_state");
  const rejected = assert.rejects(pending, /stopped/);
  const first = rpc.stop();
  const second = rpc.stop();
  assert.equal(first, second);
  await Promise.all([first, second, rejected]);
  await assert.rejects(() => rpc.request("get_state"), /not running/);
  assert.throws(
    () =>
      rpc.start(process.execPath, [], { cwd: ROOT, env: childEnvironment() }),
    /stopped/,
  );
});
const result = (
  status: RunResult["status"],
  extra: Partial<RunResult> = {},
): RunResult => ({
  runId: "fixture",
  status,
  score: status === "success" ? 1 : 0,
  model: "test-model",
  api: "openai-completions",
  endpoint: "https://fake.example/v1",
  startedAt: "2026-01-01T00:00:00Z",
  wallMs: 1000,
  steps: 1,
  errors: 0,
  tokens: 25,
  llmMs: 10,
  toolMs: 10,
  knowledge: "L1",
  observation: "text",
  goal: "experimental-fixture",
  demo: false,
  thinking: "off",
  ...extra,
});
test("report excludes demos, infra errors and cancellation from pass rate", () => {
  const text = summarizeResults([
    result("success"),
    result("gave_up"),
    result("infra_error"),
    result("cancelled"),
    result("success", { demo: true }),
  ]);
  assert.match(text, /not a validated leaderboard/);
  assert.match(text, /\| 2 \| 50\.0% \| 1 \| 1\.0 \|/);
  assert.match(
    summarizeResults([result("success", { demo: true })]),
    /No real runs/,
  );
});
test("legacy budget-stopped records do not count as model failures", () => {
  const legacy = {
    ...result("infra_error"),
    status: "budget_exhausted",
  } as unknown as RunResult;
  const text = summarizeResults([result("success"), legacy]);
  assert.match(text, /\| 1 \| 100\.0% \| 0 \|/);
});

test("report keeps skipped-intro runs separate and treats legacy runs as full intro", () => {
  const text = summarizeResults([
    result("success"),
    result("success", { skipIntro: false }),
    result("gave_up", { skipIntro: true }),
  ]);
  assert.equal(
    text.split("\n").filter((l) => l.startsWith("| https:")).length,
    2,
  );
  assert.match(text, /full-intro.*\| 2 \| 100\.0%/);
  assert.match(text, /skip-intro.*\| 1 \| 0\.0%/);
});

test("report separates thinking levels, endpoints and goals", () => {
  const text = summarizeResults([
    result("success"),
    result("success", { thinking: "high" }),
    result("success", { endpoint: "https://fake.example/another-path" }),
    result("success", { goal: "other" }),
  ]);
  assert.equal(
    text.split("\n").filter((l) => l.startsWith("| https:")).length,
    4,
  );
});
