import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../src/config.js";
import {
  BENCH_SETTINGS,
  benchSetting,
  changeSetting,
  configCompletions,
  settingValue,
} from "../src/ui/settings.js";

test("config argument completion exposes only non-secret benchmark fields and full enum replacements", () => {
  assert.deepEqual(
    configCompletions("")!.map((item) => item.value),
    BENCH_SETTINGS.map((field) => field.key),
  );
  assert.deepEqual(
    configCompletions("ob")!.map((item) => item.value),
    ["observation"],
  );
  assert.deepEqual(
    configCompletions("knowledge l")!.map((item) => item.value),
    ["knowledge L0", "knowledge L1"],
  );
  assert.deepEqual(
    configCompletions("observation text+")!.map((item) => item.value),
    ["observation text+image"],
  );
  for (const value of [
    "apiKey",
    "sessionKey",
    "keyEnv",
    "baseUrl",
    "model",
    "thinking",
    "knowledge L2",
    "maxTokens ",
  ])
    assert.equal(configCompletions(value), null);
});

test("benchmark field validation preserves other config, supports auto paths and enforces cross-field bounds", () => {
  const config = defaults();
  const changed = changeSetting(config, benchSetting("knowledge"), "l0");
  assert.equal(changed.knowledge, "L0");
  assert.equal(config.knowledge, "L1");
  assert.deepEqual({ ...changed, knowledge: "L1" }, config);
  assert.equal(settingValue(config, benchSetting("gameSource")), "Auto-detect");
  assert.equal(
    changeSetting(config, benchSetting("piExecutable"), "").piExecutable,
    "",
  );
  assert.equal(
    changeSetting(
      config,
      benchSetting("gameSource"),
      "D:\\Game Library\\Hacknet",
    ).gameSource,
    "D:\\Game Library\\Hacknet",
  );
  for (const [key, value] of [
    ["knowledge", "L2"],
    ["observation", "image"],
    ["wallTimeSeconds", "NaN"],
    ["maxSteps", "1.5"],
    ["maxTokens", "Infinity"],
    ["contextWindow", "16383"],
    ["maxOutputTokens", "65537"],
  ]) {
    assert.throws(
      () => changeSetting(config, benchSetting(key!), value!),
      /Invalid/,
    );
  }
  const limited = changeSetting(config, benchSetting("contextWindow"), "65536");
  assert.throws(
    () => changeSetting(limited, benchSetting("maxOutputTokens"), "65536"),
    /smaller than context window/,
  );
  assert.throws(() => benchSetting("apiKey"), /Unknown benchmark setting/);
});
