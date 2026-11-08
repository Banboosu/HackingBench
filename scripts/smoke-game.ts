import assert from "node:assert/strict";
import {
  mkdir,
  open,
  rm,
  writeFile,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { loadConfig, RUNTIME } from "../src/config.js";
import { GameSession } from "../src/game/session.js";
import { Player } from "../src/game/player.js";
import { prepareGame } from "../src/game/setup.js";
import { exists } from "../src/environment.js";
import { validateCommand } from "../src/core/safety.js";
import { setTimeout as delay } from "node:timers/promises";

// Explicit, opt-in GUI smoke test. Uses no LLM key and never counts as a benchmark run.
async function fingerprint(folder: string): Promise<string> {
  const hash = createHash("sha256");
  if (!(await exists(folder))) return "absent";
  const walk = async (dir: string): Promise<void> => {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      hash.update(path.relative(folder, path.join(dir, e.name)));
      if (e.isDirectory()) await walk(path.join(dir, e.name));
      else hash.update(await readFile(path.join(dir, e.name)));
    }
  };
  await walk(folder);
  return hash.digest("hex");
}
const config = await loadConfig();
await prepareGame(config, console.log);
const folder = path.join(RUNTIME, "smoke", randomUUID());
await mkdir(folder, { recursive: true });
const personal = path.join(
  os.homedir(),
  "Documents",
  "My Games",
  "Hacknet",
  "Accounts",
);
const before = await fingerprint(personal);
const pfPersonal = path.join(
  os.homedir(),
  "Documents",
  "My Games",
  "HacknetPathfinder",
);
const pfBefore = await fingerprint(pfPersonal);
const lock = await open(path.join(RUNTIME, "active-run.lock"), "wx");
const game = new GameSession();
let diagnostic = "";
game.on("diagnostic", (s) => {
  diagnostic += s;
});
game.on("fault", (e) => console.error("Owned game:", e.message));
const controller = new AbortController();
const stop = () => controller.abort();
process.on("SIGINT", stop);
try {
  console.log(
    "Launching ONLY the project game copy for an API-free smoke test…",
  );
  const initial = (await game.start(folder, controller.signal)) as Record<
    string,
    unknown
  >;
  console.log("OWNED PID:", game.pid);
  console.log("INITIAL PLAYER VIEW:", JSON.stringify(initial));
  const player = new Player(game.bridge!);
  assert.throws(() => validateCommand("ls && powershell.exe"));
  console.log("HELP:", JSON.stringify(await player.cmd("help")));
  const tutorialDeadline = Date.now() + 12000;
  let tutorialScreen: any;
  do {
    tutorialScreen = await player.screen();
    if (tutorialScreen.tutorial?.canContinue) break;
    await delay(200);
  } while (Date.now() < tutorialDeadline);
  assert.equal(
    tutorialScreen.tutorial?.canContinue,
    true,
    "Original tutorial Continue button never appeared.",
  );
  await player.tutorial("continue");
  await assert.rejects(() => player.tutorial("continue"));
  const afterContinue = (await player.screen()) as any;
  if (afterContinue.tutorial?.canHint) await player.tutorial("hint");
  else await assert.rejects(() => player.tutorial("hint"));
  console.log(
    "TUTORIAL AFTER CONTINUE:",
    JSON.stringify(afterContinue.tutorial),
  );
  console.log(
    "Tutorial controls respect visible button availability and cannot skip command-driven steps.",
  );
  await player.cmd("login");
  assert.equal(((await player.screen()) as any).awaitingInput, true);
  await assert.rejects(() => player.cmd("ls"));
  await player.input("nonexistent-smoke-user");
  const passwordDeadline = Date.now() + 3000;
  while (
    !((await player.screen()) as any).prompt.includes("Password") &&
    Date.now() < passwordDeadline
  )
    await delay(50);
  assert.match(((await player.screen()) as any).prompt, /Password/);
  await player.input("not-a-password");
  const loginDeadline = Date.now() + 3000;
  while (
    ((await player.screen()) as any).awaitingInput &&
    Date.now() < loginDeadline
  )
    await delay(50);
  assert.equal(
    ((await player.screen()) as any).awaitingInput,
    false,
    "Interactive login did not finish.",
  );
  assert.equal(
    diagnostic.includes("Spawning thread for command not-a-password"),
    false,
    "Prompt input was dispatched as a command!",
  );
  await player.cmd("connect " + initial.thisComputerIP);
  const connected = (await player.wait(1)) as any;
  assert.equal(
    connected.connectedIP,
    initial.thisComputerIP,
    "Virtual connect did not reach the local player node.",
  );
  assert.notDeepEqual(
    connected.tutorial?.text,
    afterContinue.tutorial?.text,
    "Tutorial did not advance through a normal player command.",
  );
  if (connected.tutorial?.canHint) await player.tutorial("hint");
  console.log(
    "Normal virtual-terminal connect advanced the tutorial without privileged progression.",
  );
  const screen = (await player.screen()) as Record<string, unknown>;
  for (const key of [
    "flags",
    "users",
    "adminPass",
    "firewall",
    "missionSource",
  ])
    assert.equal(key in screen, false, `Hidden field leaked: ${key}`);
  assert.ok(
    (screen.terminal as any)?.lines?.length > 0,
    "Player terminal history is empty after help.",
  );
  await assert.rejects(() => player.input("not a pending prompt"));
  console.log("PLAYER MAIL:", JSON.stringify(await player.mail("list")));
  console.log("SCREEN:", JSON.stringify(screen));
  const verdict = await game.bridge!.call("bench.judge");
  assert.equal(verdict.completed, false);
  assert.equal(
    path.resolve(verdict.saveRoot),
    path.resolve(folder, "accounts"),
  );
  console.log("Save-root and non-completion assertions passed.");
  const capture = await player.capture();
  await writeFile(
    path.join(folder, "frame.png"),
    Buffer.from(capture.data, "base64"),
  );
  console.log("Game-only framebuffer captured.");
  await game.bridge!.call("game.save");
  const saveDeadline = Date.now() + 10000;
  while (
    Date.now() < saveDeadline &&
    !(await readdir(path.join(folder, "accounts"))).some((n) =>
      n.endsWith(".xml"),
    )
  )
    await delay(200);
  assert.ok(
    (await readdir(path.join(folder, "accounts"))).some((n) =>
      n.endsWith(".xml"),
    ),
    "No isolated XML save was written.",
  );
} finally {
  await game.close();
  process.off("SIGINT", stop);
  await lock.close();
  await rm(path.join(RUNTIME, "active-run.lock"), { force: true });
  await writeFile(path.join(folder, "game.log"), diagnostic);
  assert.equal(
    await fingerprint(personal),
    before,
    "Personal Hacknet saves changed!",
  );
  assert.equal(
    await fingerprint(pfPersonal),
    pfBefore,
    "Personal Pathfinder folder changed!",
  );
}
console.log(
  "PASS: vanilla startup/tutorial controls, interactive login, tools, isolated XML save, game-only screenshot, owned-PID cleanup. Personal save folders unchanged.",
);
