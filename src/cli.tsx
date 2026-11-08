#!/usr/bin/env bun
import { loadConfig } from "./config.js";
import { inspect, providerCatalog } from "./environment.js";
import { prepareGame } from "./game/setup.js";
import { RunController } from "./runner.js";
import { report } from "./report.js";
import { redact, terminalText } from "./core/safety.js";
import {
  controllerEnvironment,
  projectKey,
  prepareControllerDirectory,
} from "./pi/project.js";

const args = process.argv.slice(2);
const usage = `HackingBench — native pi Hacknet workbench

  bun run start             Native pi TUI: /provider /login /model /start /stop
  bun run demo              Safe native-TUI preview (no API/game)
  bun run doctor            Detect Windows Bun, pi, Steam game and DLC
  bun run setup             Prepare isolated game copy (never launches)
  bun run start run         Headless live run, using project native /login auth
  bun run start report      Summarize real run artifacts
  bun run start models      Read pi-provider model metadata (no credentials)
  bun run start --demo --headless  Scriptable simulation

Live mode requires Windows-native Bun >=1.4.4 and pi 1.5.0.
Native /login stores credentials in runtime/controller/auth.json, not global pi.
Use /provider to configure an endpoint, /model to choose, /test to verify.
Only /start launches a game attempt. Tool restrictions are not an OS sandbox.
`;
let key = "";
async function main(): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(usage);
    return;
  }
  const config = await loadConfig();
  const print = (s: string) => console.log(terminalText(redact(s, [key])));
  const headless = args.includes("--headless") || args[0] === "run";
  const demo = args.includes("--demo");
  if (args[0] === "doctor") {
    const env = await inspect(config);
    console.log(JSON.stringify(env, null, 2));
    if (env.problems.length) process.exitCode = 1;
    return;
  }
  if (args[0] === "setup") {
    await prepareGame(config, print);
    return;
  }
  if (args[0] === "report") {
    print(await report());
    return;
  }
  if (args[0] === "models") {
    console.log(JSON.stringify(await providerCatalog(), null, 2));
    return;
  }
  if (headless) {
    if (!demo) key = await projectKey(config);
    const run = new RunController();
    const stop = () => run.stop();
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    run.on("phase", (s) => print(`[${s}]`));
    run.on("log", print);
    run.on("action", print);
    run.on("observation", print);
    try {
      const result = await run.run(config, key, demo);
      print(JSON.stringify(result, null, 2));
      if (result.status !== "success") process.exitCode = 1;
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  if (args.some((arg) => arg !== "--demo"))
    throw new Error("Unknown command. Use --help.");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(usage);
    throw new Error(
      "Interactive mode needs a terminal. Use --demo --headless for a smoke test.",
    );
  }
  await prepareControllerDirectory();
  // Set before importing the SDK: pi also uses this path for native login notices,
  // crash/debug files and theme infrastructure. No ~/.pi/agent state is read/written.
  const env = controllerEnvironment();
  for (const name of Object.keys(process.env))
    if (!(name in env)) delete process.env[name];
  Object.assign(process.env, env);
  const { runNative } = await import("./ui/native.js");
  await runNative(config, demo);
}
main().catch((error) => {
  console.error(
    terminalText(redact(`HackingBench: ${(error as Error).message}`, [key])),
  );
  process.exitCode = 1;
});
