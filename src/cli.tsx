#!/usr/bin/env bun
import React from 'react';
import { render } from 'ink';
import { loadConfig } from './config.js';
import { inspect, providerCatalog } from './environment.js';
import { prepareGame } from './game/setup.js';
import { RunController } from './runner.js';
import { report } from './report.js';
import { redact, terminalText } from './core/safety.js';
import { App } from './ui/app.js';

const args = process.argv.slice(2);
const usage = `HackingBench — LLM Hacknet speedrun workbench\n\n  bun run start             Interactive cockpit + first-run setup\n  bun run demo              Safe TUI preview (no API/game)\n  bun run doctor            Detect Windows Bun, pi, Steam game and DLC\n  bun run setup             Prepare isolated game copy (never launches)\n  bun run start run         Headless live run; key comes from environment\n  bun run start report      Summarize real run artifacts\n  bun run start models      Read pi-provider model metadata (no credentials)\n  bun run start --demo --headless  Scriptable simulation\n\nLive mode requires Windows-native Bun >=1.4.4 and pi 1.5.0.\nKeys entered in the TUI are session-only. No key is saved in bench.json.\nTool restrictions are not an operating-system sandbox.\n`;
async function main(): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  const config = await loadConfig();
  const key = process.env[config.keyEnv] || '';
  const print = (s: string) => console.log(terminalText(redact(s,[key])));
  const headless = args.includes('--headless') || args.includes('run');
  const demo = args.includes('--demo');
  if (args[0] === 'doctor') {
    const env=await inspect(config); console.log(JSON.stringify(env,null,2));
    if (env.problems.length) process.exitCode=1;
    return;
  }
  if (args[0] === 'setup') { await prepareGame(config,print); return; }
  if (args[0] === 'report') { print(await report()); return; }
  if (args[0] === 'models') { console.log(JSON.stringify(await providerCatalog(),null,2)); return; }
  if (headless) {
    const run = new RunController();
    const stop = () => run.stop();
    process.on('SIGINT',stop); process.on('SIGTERM',stop);
    run.on('phase',s => print(`[${s}]`)); run.on('log',print); run.on('action',print); run.on('observation',print);
    try {
      const result=await run.run(config,key,demo); print(JSON.stringify(result,null,2));
      if (result.status !== 'success') process.exitCode=1;
    } finally { process.off('SIGINT',stop); process.off('SIGTERM',stop); }
    return;
  }
  if (args.length && !demo) throw new Error('Unknown command. Use --help.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.log(usage); throw new Error('Interactive mode needs a terminal. Use --demo --headless for a smoke test.'); }
  // Standalone renderer: the pi subprocess is RPC-only and never writes into this terminal.
  process.stdout.write('\x1b[?1049h');
  try {
    const app=render(<App initialConfig={config} demo={demo}/>,{exitOnCtrlC:false,patchConsole:false});
    await app.waitUntilExit();
  } finally { process.stdout.write('\x1b[?1049l'); }
}
main().catch(e => {
  const key = process.env.HACKINGBENCH_API_KEY || '';
  console.error(terminalText(redact(`HackingBench: ${(e as Error).message}`,[key])));
  process.exitCode=1;
});
