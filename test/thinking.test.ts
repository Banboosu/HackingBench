import test from "node:test";
import assert from "node:assert/strict";
import type { Model } from "@earendil-works/pi-ai";
import { defaults } from "../src/config.js";
import { manualModel } from "../src/pi/discovery.js";
import { normalizeThinking, thinkingLevelsFor } from "../src/pi/thinking.js";

function model(
  reasoning: boolean,
  thinkingLevelMap?: Record<string, string | null>,
): Model<any> {
  return { reasoning, thinkingLevelMap } as Model<any>;
}

test("supported thinking levels come from model reasoning and thinkingLevelMap", () => {
  assert.deepEqual(thinkingLevelsFor(undefined), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(thinkingLevelsFor(model(false)), ["off"]);
  assert.deepEqual(thinkingLevelsFor(model(true)), [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
  ]);
  assert.deepEqual(thinkingLevelsFor(model(true, { high: null })), [
    "off",
    "minimal",
    "low",
    "medium",
  ]);
  assert.deepEqual(
    thinkingLevelsFor(model(true, { xhigh: "xhigh", max: "max" })),
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
});

test("manual model reasoning is explicit instead of inferred from the current thinking value", () => {
  const config = { ...defaults(), thinking: "high" as const };
  assert.equal(manualModel(config, true).reasoning, true);
  assert.equal(manualModel(config, false).reasoning, false);
  assert.equal(
    manualModel({ ...config, thinking: "off" as const }, true).reasoning,
    true,
  );
});

test("effective thinking is clamped to model capabilities instead of the previous selection", () => {
  assert.equal(normalizeThinking(model(false), "max"), "off");
  assert.equal(normalizeThinking(model(true), "xhigh"), "high");
  assert.equal(
    normalizeThinking(model(true, { high: null }), "high"),
    "medium",
  );
  assert.equal(
    normalizeThinking(model(true, { xhigh: "xhigh" }), "max"),
    "xhigh",
  );
  assert.equal(normalizeThinking(undefined, "high"), "high");
});
