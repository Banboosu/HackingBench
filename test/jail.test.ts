import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { temporaryDirectory } from "./fixtures.js";
import path from "node:path";
import { createJail, SYSTEM_PROMPT, CHEATSHEET } from "../src/pi/jail.js";
import { defaults } from "../src/config.js";
import { providerCatalog, steamLibraryPaths } from "../src/environment.js";
import { PLAYER_TOOLS } from "../src/core/safety.js";
import extension from "../extension/hacknet-player.js";

test("isolated pi config never stores credentials or discovers global extensions", async () => {
  const dir = await temporaryDirectory("jail-");
  try {
    const jail = await createJail(
      defaults(),
      dir,
      "dummy-secret",
      "test-pipe",
      "pipe-token",
    );
    const settings = await readFile(
      path.join(dir, "pi-agent", "settings.json"),
      "utf8",
    );
    const models = await readFile(
      path.join(dir, "pi-agent", "models.json"),
      "utf8",
    );
    assert.ok(!settings.includes("dummy-secret"));
    assert.ok(!models.includes("dummy-secret"));
    assert.match(models, /\$HACKINGBENCH_API_KEY/);
    assert.equal(jail.env.HACKINGBENCH_API_KEY, "dummy-secret");
    assert.ok(jail.args.includes("--no-mcp"));
    assert.ok(jail.args.includes("--no-extensions"));
    assert.ok(jail.args.includes("--no-context-files"));
    assert.ok(jail.args.includes("--no-approve"));
    assert.ok(jail.args.includes("--no-session"));
    assert.equal(
      jail.args[jail.args.indexOf("--tools") + 1],
      PLAYER_TOOLS.join(","),
    );
    assert.equal(jail.args.includes("--api-key"), false);
    assert.deepEqual(JSON.parse(settings).packages, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("knowledge/observation settings reach the isolated prompt and exact text/image player loadout", async () => {
  const dir = await temporaryDirectory("jail-modes-");
  try {
    for (const knowledge of ["L0", "L1"] as const) {
      for (const observation of ["text", "text+image"] as const) {
        const runDir = path.join(dir, `${knowledge}-${observation}`);
        const jail = await createJail(
          { ...defaults(), knowledge, observation },
          runDir,
          "fixture-secret",
          "fixture-pipe",
          "fixture-token",
        );
        const prompt = jail.args[jail.args.indexOf("--system-prompt") + 1];
        assert.equal(
          prompt,
          SYSTEM_PROMPT + (knowledge === "L1" ? "\n\n" + CHEATSHEET : ""),
        );
        const tools = jail.args[jail.args.indexOf("--tools") + 1]!.split(",");
        assert.deepEqual(tools, [
          ...PLAYER_TOOLS,
          ...(observation === "text+image" ? ["hn_screenshot"] : []),
        ]);
        assert.equal(
          jail.env.HACKINGBENCH_IMAGES,
          observation === "text+image" ? "1" : "0",
        );
        const models = JSON.parse(
          await readFile(path.join(runDir, "pi-agent", "models.json"), "utf8"),
        );
        assert.deepEqual(
          models.providers.bench.models[0].input,
          observation === "text+image" ? ["text", "image"] : ["text"],
        );
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pi-provider import reads only safe model metadata, not credentials or commands", async () => {
  const dir = await temporaryDirectory("catalog-");
  try {
    const file = path.join(dir, "models.json");
    await writeFile(
      file,
      JSON.stringify({
        providers: {
          valid: {
            baseUrl: "https://example.com/v1",
            api: "openai-responses",
            apiKey: "!this-must-not-execute",
            headers: { Authorization: "secret" },
            models: [{ id: "good" }],
          },
          unsafe: {
            baseUrl: "https://secret@host/v1",
            api: "openai-responses",
            models: [{ id: "bad" }],
          },
          command: {
            baseUrl: "!do-not-run",
            api: "openai-responses",
            models: [{ id: "bad" }],
          },
          plaintext: {
            baseUrl: "http://remote.example/v1",
            api: "openai-responses",
            models: [{ id: "bad" }],
          },
          filesystem: {
            baseUrl: "file:///private",
            api: "openai-responses",
            models: [{ id: "bad" }],
          },
        },
      }),
    );
    assert.deepEqual(await providerCatalog(file), [
      {
        provider: "valid",
        model: "good",
        api: "openai-responses",
        baseUrl: "https://example.com/v1",
      },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Steam VDF paths handle escaped Windows separators", () => {
  assert.deepEqual(
    steamLibraryPaths('"0" { "path" "D:\\\\Game\\\\SteamLibrary" }'),
    ["D:\\Game\\SteamLibrary"],
  );
});
function mockPi(ignoreSelection = false) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, Function>();
  let active = ["read", "bash", "evil"];
  const pi: any = {
    registerTool: (t: any) => tools.set(t.name, t),
    on: (event: string, h: Function) => handlers.set(event, h),
    registerCommand: () => {},
    setActiveTools: (names: string[]) => {
      if (!ignoreSelection) active = [...names];
    },
    getActiveTools: () => active,
    appendEntry: () => {},
  };
  return { pi, tools, handlers };
}
test("player extension hardens loadout and denies unknown tools without an admission limit", async () => {
  const mock = mockPi();
  extension(mock.pi);
  mock.handlers.get("session_start")!();
  assert.deepEqual(mock.pi.getActiveTools(), PLAYER_TOOLS);
  assert.deepEqual([...mock.tools.keys()].sort(), [...PLAYER_TOOLS].sort());
  assert.equal(
    mock.handlers.get("tool_call")!({ toolName: "bash" }).block,
    true,
  );
  // Repeated admitted calls are never blocked by a counter.
  for (let i = 0; i < 100; i++)
    assert.equal(
      mock.handlers.get("tool_call")!({ toolName: "hn_screen" }),
      undefined,
    );
  const givenUp = await mock.tools
    .get("hn_give_up")
    .execute("id", { reason: "stuck" });
  assert.equal(givenUp.terminate, true);
  assert.equal(givenUp.details.benchStatus, "gave_up");
  const bad = mockPi(true);
  extension(bad.pi);
  assert.throws(() => bad.handlers.get("session_start")!(), /assertion/);
});
