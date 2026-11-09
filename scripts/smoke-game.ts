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
import { gameWindow, loadConfig, ROOT, RUNTIME } from "../src/config.js";
import { GameSession } from "../src/game/session.js";
import { Player } from "../src/game/player.js";
import { prepareGame } from "../src/game/setup.js";
import { exists } from "../src/environment.js";
import { childEnvironment, validateCommand } from "../src/core/safety.js";
import { command } from "../src/core/process.js";
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
const display = gameWindow(config);
// Exercise both startup modes without changing the user's persisted config.
const skipIntro = process.argv.includes("--skip-intro");
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
  const initial = (await game.start(folder, display, controller.signal, {
    skipIntro,
  })) as Record<string, unknown>;
  console.log("OWNED PID:", game.pid);
  const window = JSON.parse(
    await command(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(ROOT, "scripts", "inspect-window.ps1"),
        "-OwnedProcessId",
        String(game.pid),
      ],
      { cwd: ROOT, env: childEnvironment(), timeout: 15000 },
    ),
  );
  assert.equal(window.visible, true, "Owned game window must be visible.");
  assert.equal(window.minimized, false, "Owned game must not start minimized.");
  if (!display.fullscreen) {
    // The bridge declares per-monitor-v2 DPI awareness before Game1 creates
    // the window, so Settings.txt pixels must equal physical client pixels.
    assert.equal(window.width, display.width);
    assert.equal(window.height, display.height);
  }
  console.log("OWNED WINDOW:", JSON.stringify(window));
  console.log("INITIAL PLAYER VIEW:", JSON.stringify(initial));
  const player = new Player(game.bridge!);
  assert.throws(() => validateCommand("ls && powershell.exe"));
  console.log("HELP:", JSON.stringify(await player.cmd("help")));
  const fullHistory = await game.bridge!.call("terminal.history", {
    lines: 120,
  });
  assert.ok(
    fullHistory.total > 30 && fullHistory.lines.length > 30,
    "Full terminal history must not fall back to the fixed 29-row reader.",
  );
  // The old smoke only checked help before the history reached 30 rows, so it
  // missed the frozen-total bug. Repeat a normal command after that threshold.
  for (let i = 0; i < 3; i++) {
    const listing = (await player.cmd("ls")) as any;
    assert.equal(
      listing.output,
      undefined,
      "ls must return a delta, not context.",
    );
    assert.ok(
      listing.lines.some((line: string) => line.includes(":bin")),
      "ls produced visible rows but hn_cmd failed to return them.",
    );
    assert.equal(listing.note, undefined);
  }
  console.log(
    "TERMINAL: full history >30 rows and repeated ls deltas verified.",
  );
  let afterContinue: any;
  if (skipIntro) {
    assert.equal(
      initial.tutorial,
      undefined,
      "Opening tutorial was not skipped.",
    );
    assert.ok(
      ((await player.mail("list")) as any).mails.length > 0,
      "Skip must deliver the first campaign email.",
    );
    assert.equal((await game.bridge!.call("bench.judge")).completed, false);
    assert.match(diagnostic, /opening story intro skipped/);
    assert.match(
      diagnostic,
      /intro animation skipped \([1-9]\d* presentation sleeps removed\)/,
    );
    console.log(
      "SKIP INTRO: story skipped, animation delays removed, no tutorial, first email delivered, campaign not completed.",
    );
  } else {
    assert.doesNotMatch(
      diagnostic,
      /opening story intro skipped|intro animation skipped/,
    );
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
    afterContinue = (await player.screen()) as any;
    if (afterContinue.tutorial?.canHint) await player.tutorial("hint");
    else await assert.rejects(() => player.tutorial("hint"));
    console.log(
      "TUTORIAL AFTER CONTINUE:",
      JSON.stringify(afterContinue.tutorial),
    );
    console.log(
      "Tutorial controls respect visible button availability and cannot skip command-driven steps.",
    );
  }
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
  if (!skipIntro) {
    assert.notDeepEqual(
      connected.tutorial?.text,
      afterContinue.tutorial?.text,
      "Tutorial did not advance through a normal player command.",
    );
    if (connected.tutorial?.canHint) await player.tutorial("hint");
    console.log(
      "Normal virtual-terminal connect advanced the tutorial without privileged progression.",
    );
  }
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
  const shells = screen.shells as any;
  assert.ok(
    shells && Number.isInteger(shells.count) && Array.isArray(shells.ips),
    "Player screen must expose shell count/IPs without hidden state.",
  );
  assert.ok("proxy" in screen, "Connected proxy state must be explicit.");
  await assert.rejects(
    () => game.bridge!.call("bench.shell", { action: "format" }),
    /Shell action/,
    "The shell adapter must reject actions outside overload/cancel/exit.",
  );
  await assert.rejects(() => player.shell("overload"), /No active shells/);
  // Open a real shell through normal terminal gameplay. The local player node
  // is admin-owned and has a native proxy; do not spawn exes or alter its ticks.
  await player.cmd("shell");
  const opened = (await player.screen()) as any;
  assert.equal(
    opened.shells.count,
    1,
    "Normal shell command did not open a shell.",
  );
  assert.equal(opened.shells.entries[0].hostIP, initial.thisComputerIP);
  assert.equal(opened.shells.entries[0].state, 0);
  const overloaded = (await player.shell("overload")) as any;
  assert.equal(overloaded.affected, 1);
  assert.equal(
    overloaded.shells.entries[0].state,
    1,
    "Native overload was a no-op.",
  );
  assert.equal(overloaded.shells.entries[0].targetIP, initial.thisComputerIP);
  console.log("SHELL OVERLOAD:", JSON.stringify(overloaded));
  const progress = (await player.wait(2)) as any;
  console.log("PROXY AFTER 2s:", JSON.stringify(progress.proxy));
  assert.ok(
    progress.proxy.proxyActive === false ||
      progress.proxy.overloadTicks < overloaded.proxy.overloadTicks,
    "Shell entered overload state but native proxy ticks did not decrease.",
  );
  const cancelled = (await player.shell("cancel")) as any;
  assert.ok(
    cancelled.shells.entries.every((s: any) => s.state === 0),
    "Cancel did not reset all shells.",
  );
  await player.shell("overload");
  let completed: any;
  const proxyDeadline = Date.now() + 40000;
  do {
    completed = (await player.wait(1)) as any;
  } while (completed.proxy?.proxyActive && Date.now() < proxyDeadline);
  assert.equal(
    completed.proxy?.proxyActive,
    false,
    "Native proxy never became inactive.",
  );
  console.log("PROXY COMPLETED:", JSON.stringify(completed.proxy));
  await player.shell("exit");
  const exited = (await player.wait(1)) as any;
  assert.equal(exited.shells.count, 0, "Exit did not close the shell.");
  await assert.rejects(() => player.shell("overload"), /No active shells/);
  console.log(
    "A real shell overloaded the proxy to completion; cancel and exit both worked.",
  );
  await assert.rejects(() => player.input("not a pending prompt"));
  console.log("PLAYER MAIL:", JSON.stringify(await player.mail("list")));
  console.log("SCREEN:", JSON.stringify(await player.screen()));
  const verdict = await game.bridge!.call("bench.judge");
  assert.equal(verdict.completed, false);
  assert.equal(
    path.resolve(verdict.saveRoot),
    path.resolve(folder, "accounts"),
  );
  console.log("Save-root and non-completion assertions passed.");
  const capture = await player.capture();
  const png = Buffer.from(capture.data, "base64");
  await writeFile(path.join(folder, "frame.png"), png);
  console.log(
    `${png.readUInt32BE(16)}×${png.readUInt32BE(20)} game-only framebuffer captured (configured ${display.width}×${display.height} ${display.fullscreen ? "fullscreen" : "windowed"}).`,
  );
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
  `PASS: visible non-minimized ${display.width}x${display.height} ${display.fullscreen ? "fullscreen" : "windowed"} owned game, vanilla startup/tutorial controls, interactive login, tools, native proxy overload to completion/cancel/exit, skipIntro=${skipIntro}, isolated XML save, game-only screenshot, owned-PID cleanup. Personal save folders unchanged.`,
);
