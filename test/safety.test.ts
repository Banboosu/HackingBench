import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm, symlink } from "node:fs/promises";
import { temporaryDirectory } from "./fixtures.js";
import path from "node:path";
import {
  validateCommand,
  within,
  assertNoLinks,
  redact,
  terminalText,
  childEnvironment,
} from "../src/core/safety.js";
import { zipDestination } from "../src/game/setup.js";
import { configSchema, validateEndpoint } from "../src/config.js";

for (const cmd of [
  "help",
  "help 2",
  "connect 192.0.2.1",
  "SSHcrack 22",
  "cat /home/notes.txt",
  "scp file.txt",
  "rm *",
  "solve AXCD",
]) {
  test(`player command accepted: ${cmd}`, () =>
    assert.equal(validateCommand(cmd), cmd));
}
for (const cmd of [
  "ls && whoami",
  "ls; mcp state",
  "ls\nrm *",
  "ls\r\nrm *",
  "ls\tfoo",
  "ls\u00a0foo",
  "ls\u2028foo",
  "ls\u200bfoo",
  "ls | cat",
  "ls`id`",
  "ls $(id)",
  "ls > file",
  "cat C:/secret",
  "cat \\server\\share",
  "cd ..",
  "scp ../../secret",
  "/bin/SSHcrack 22",
  "mcp exec help",
  "loadmission x",
  "loadactions x",
  "dscan",
  "sudo help",
  "execute anything",
  "quit",
  "z".repeat(257),
  "",
]) {
  test(`player command rejected: ${JSON.stringify(cmd)}`, () =>
    assert.throws(() => validateCommand(cmd)));
}
test("paths stay within runtime, including Windows drive/path rules", () => {
  const root = path.resolve("runtime");
  assert.equal(within(root, path.join(root, "runs", "x")), true);
  assert.equal(within(root, path.join(root, "..", "outside")), false);
  assert.equal(within(root, root + "-evil"), false);
  for (const name of ["../evil", "/abs", "C:/evil", "sub\\..\\evil"])
    assert.throws(() => zipDestination(root, name));
  assert.equal(
    zipDestination(root, "BepInEx/plugins/test.dll"),
    path.join(root, "BepInEx", "plugins", "test.dll"),
  );
});
test("junctions and symlink ancestors are refused", async () => {
  const base = await temporaryDirectory("safety-");
  try {
    await mkdir(path.join(base, "root"));
    await mkdir(path.join(base, "outside"));
    await symlink(
      path.join(base, "outside"),
      path.join(base, "root", "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(() =>
      assertNoLinks(
        path.join(base, "root"),
        path.join(base, "root", "link", "new"),
      ),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test("redaction, terminal escape filtering, and environment allowlist", () => {
  assert.equal(
    redact("key=abc-123 Bearer dangerous sk-abcdefghijkl", ["abc-123"]),
    "key=[REDACTED] Bearer [REDACTED] [REDACTED]",
  );
  assert.ok(!terminalText("\x1b]52;clipboard\x07\x1b[2J").includes("\x1b"));
  process.env.HACKINGBENCH_TEST_UNRELATED_SECRET = "do-not-copy";
  try {
    assert.equal(
      childEnvironment().HACKINGBENCH_TEST_UNRELATED_SECRET,
      undefined,
    );
  } finally {
    delete process.env.HACKINGBENCH_TEST_UNRELATED_SECRET;
  }
});
test("non-secret config is validated and unknown key fields stripped", () => {
  const config = configSchema.parse({
    apiKey: "not-persisted",
    secret: "not-persisted",
  });
  assert.equal("apiKey" in config, false);
  assert.equal("secret" in config, false);
  assert.equal(
    "keyEnv" in configSchema.parse({ keyEnv: "!powershell" }),
    false,
  );
  assert.throws(() => configSchema.parse({ model: "!powershell" }));
  assert.throws(() => configSchema.parse({ wallTimeSeconds: -1 }));
  assert.throws(() =>
    configSchema.parse({ baseUrl: "http://not-local.example/v1" }),
  );
  assert.throws(() =>
    configSchema.parse({ contextWindow: 16384, maxOutputTokens: 32768 }),
  );
});
test("endpoint rejects executable config, credentials and remote plaintext HTTP", () => {
  validateEndpoint("http://127.0.0.1:8080/v1");
  validateEndpoint("https://api.example.com/v1");
  for (const url of [
    "!curl example.com",
    "https://key@host/v1",
    "https://host/v1?key=secret",
    "https://host/v1#secret",
    "http://remote.example/v1",
    "file:///secret",
  ])
    assert.throws(() => validateEndpoint(url));
});
