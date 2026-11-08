import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, RUNTIME, defaults, gameWindow } from "../src/config.js";
import {
  DEFAULT_GAME_WINDOW,
  ensureGameWindow,
  windowedSettings,
  type GameWindow,
} from "../src/game/display.js";
import { temporaryDirectory } from "./fixtures.js";

const window = (extra: Partial<GameWindow> = {}): GameWindow => ({
  width: 1280,
  height: 720,
  fullscreen: false,
  ...extra,
});

test("default benchmark config selects 1920x1080 windowed", () => {
  assert.deepEqual(gameWindow(defaults()), {
    width: 1920,
    height: 1080,
    fullscreen: false,
  });
  assert.deepEqual({ ...DEFAULT_GAME_WINDOW }, gameWindow(defaults()));
});

test("project window settings apply width, height and fullscreen while preserving all other settings", () => {
  for (const eol of ["\n", "\r\n"]) {
    for (const bom of ["", "\uFEFF"]) {
      for (const size of [
        window(),
        window({ width: 1920, height: 1080 }),
        window({ width: 640, height: 480, fullscreen: true }),
        window({ width: 4096, height: 4096 }),
      ]) {
        const tail =
          eol +
          [
            "bloom: false",
            "volume: 0.3",
            "fontConfig: large",
            "defaultLocale: zh-cn",
            "custom: 保留",
            "",
          ].join(eol);
        const previous = bom + ["1152", "768", "True"].join(eol) + tail;
        const next = windowedSettings(previous, size);
        assert.equal(
          next,
          bom +
            [
              String(size.width),
              String(size.height),
              String(size.fullscreen),
            ].join(eol) +
            tail,
        );
        assert.equal(windowedSettings(next, size), next);
      }
    }
  }
});

test("window setup handles missing settings, is idempotent and never writes outside runtime", async () => {
  const dir = await temporaryDirectory("game-display-");
  const file = path.join(dir, "Settings.txt");
  try {
    await ensureGameWindow(dir, window());
    const created = await readFile(file, "utf8");
    assert.match(created, /^1280\r\n720\r\nfalse\r\n/);
    assert.match(created, /hasSaved: True/);
    await ensureGameWindow(dir, window());
    assert.equal(await readFile(file, "utf8"), created);
    const previous = "800\n600\ntrue\nvolume: 0.2\n";
    await writeFile(file, previous);
    await ensureGameWindow(dir, window({ fullscreen: true }));
    assert.equal(
      await readFile(file, "utf8"),
      "1280\n720\ntrue\nvolume: 0.2\n",
    );
    await assert.rejects(
      () => ensureGameWindow(ROOT, window()),
      /Refusing to change/,
    );
    await assert.rejects(
      () => ensureGameWindow(RUNTIME, window()),
      /Refusing to change/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid window sizes and malformed settings fail without destroying the file", async () => {
  for (const [size, message] of [
    [window({ width: 639 }), /width must be an integer/],
    [window({ width: 4097 }), /width must be an integer/],
    [window({ width: 1280.5 }), /width must be an integer/],
    [window({ height: 479 }), /height must be an integer/],
    [window({ height: 4097 }), /height must be an integer/],
    [
      window({ fullscreen: "yes" as unknown as boolean }),
      /fullscreen must be true or false/,
    ],
  ] as const) {
    assert.throws(() => windowedSettings("800\n600\nfalse\n", size), message);
  }
  for (const text of [
    "",
    "1920\n1080",
    "width: 1920\n1080\nfalse",
    "1920\n1080\nwindowed",
  ]) {
    assert.throws(
      () => windowedSettings(text, window()),
      /Unsupported project Settings/,
    );
  }
  const dir = await temporaryDirectory("game-display-invalid-");
  try {
    const file = path.join(dir, "Settings.txt");
    await writeFile(file, "unknown settings format");
    await assert.rejects(
      () => ensureGameWindow(dir, window()),
      /Unsupported project Settings/,
    );
    assert.equal(await readFile(file, "utf8"), "unknown settings format");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
