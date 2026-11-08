import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import type { RunController } from '../src/runner.js';
import { rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaults, CONFIG_FILE } from '../src/config.js';
import { controllerEnvironment, CONTROLLER_DIR, endpointIdentity, projectKey } from '../src/pi/project.js';
import type { Terminal, ProgramStatus } from '@earendil-works/pi-tui';

// Real native pi InteractiveMode + fake terminal + local model catalog. No game/real API.
const env = controllerEnvironment();
for (const name of Object.keys(process.env)) if (!(name in env)) delete process.env[name];
Object.assign(process.env, env);
const { InteractiveMode } = await import('@earendil-works/pi-coding-agent');
const { createWorkbench } = await import('../src/ui/native.js');

class TestTerminal implements Terminal {
  columns = 100; rows = 36; kittyProtocolActive = false;
  output = ''; input?: (data: string) => void;
  start(onInput: (data: string) => void) { this.input = onInput; }
  stop() { this.input = undefined; }
  write(data: string) { this.output += data; }
  async drainInput() {}
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {} setProgramStatus(_status: ProgramStatus) {}
  type(text: string) { for (const ch of text) this.input?.(ch); }
}
const key = 'fixture-native-login-do-not-display';
let catalogCalls = 0;
const server = http.createServer((req, res) => {
  try {
    assert.equal(req.url, '/v1/models');
    assert.equal(req.headers.authorization, `Bearer ${key}`);
    catalogCalls++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash', name: 'Fixture model', reasoning: true }] }));
  } catch { res.writeHead(500); res.end('fixture assertion failed'); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as import('node:net').AddressInfo).port;
const config = { ...defaults(), baseUrl: `http://127.0.0.1:${port}/v1`, api: 'openai-completions' as const, model: 'deepseek-v4.1-flash', thinking: 'high' as const };
const id = endpointIdentity(config);
const terminal = new TestTerminal();
const previousConfig = await readFile(CONFIG_FILE).catch(() => undefined);
let starts = 0; let finishRun: (() => void) | undefined;
class FakeRunner extends EventEmitter {
  async run() {
    starts++; this.emit('phase', 'RUNNING'); this.emit('activity', 'thinking');
    this.emit('metrics', { wallMs: 250, steps: 1, tokens: 25, llmMs: 20, toolMs: 10 });
    await new Promise<void>(resolve => { finishRun = resolve; });
    return { status: 'cancelled', runId: 'fake-native-ui-run', steps: 1, wallMs: 250 };
  }
  stop() { finishRun?.(); }
}
const saved: any[] = [];
const runtime = await createWorkbench(config, false, {
  autoInspect: false,
  persist: async value => { saved.push(value); },
  makeRunner: () => new FakeRunner() as unknown as RunController,
});
const mode = new InteractiveMode(runtime, { terminal, tuiMode: 'fullscreen' });
async function until(condition: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { if (await condition()) return; await delay(30); }
  throw new Error(message);
}
try {
  await mode.init();
  await until(() => terminal.output.includes('HACKINGBENCH'), 'Dashboard did not render.');
  assert.deepEqual(runtime.session.getActiveToolNames(), []);
  // Built-in command handling is in the native editor submit path, not session.prompt().
  terminal.type(`/login ${id}`); terminal.input?.('\r');
  await until(() => terminal.output.includes('Enter API key'), 'Native API key dialog did not open.');
  terminal.type(key); terminal.input?.('\r');
  await until(async () => await projectKey(config) === key, 'Native /login did not save project credential.');
  await until(() => catalogCalls > 0, 'Native /login did not automatically discover models.');
  await until(() => runtime.session.modelRuntime.getModel(id, config.model)?.name === 'Fixture model', 'Discovered model was not registered.');
  assert.ok(!terminal.output.includes(key), 'Native login leaked the fixture key in terminal output.');
  assert.ok(runtime.session.modelRuntime.getModel(id, config.model)?.reasoning);
  await runtime.session.prompt('Do not run a model from the control deck.');
  assert.ok(!runtime.session.messages.some(message => message.role === 'user'));
  assert.throws(() => runtime.session.modelRuntime.streamSimple(runtime.session.model!, { messages: [] }), /disabled/);
  mode.clearEditor(); terminal.type(`/model ${id}/${config.model}`); terminal.input?.('\r');
  await until(() => runtime.session.model?.provider === id, 'Native /model did not select endpoint model.');
  mode.clearEditor(); terminal.type('/thinking high'); terminal.input?.('\r');
  await until(() => saved.some(value => value.thinking === 'high'), 'Native thinking selection was not persisted.');
  await runtime.session.prompt('/bench');
  await runtime.session.prompt('/start');
  await until(() => starts === 1, 'Background fake run was not started.');
  await runtime.session.prompt('/stop');
  assert.ok(terminal.output.includes('RUNNING'));
  // /start is backed exclusively by FakeRunner here. Never invoke real runner or /test.
  assert.equal(runtime.session.sessionFile, undefined);
  console.log('PASS: real native pi UI + masked /login + project auth.json + automatic models + native /model/high thinking + background fake /start/stop. No real API/game.');
} finally {
  mode.stop();
  await runtime.session.modelRuntime.logout(id).catch(() => undefined);
  await runtime.dispose();
  await rm(path.join(CONTROLLER_DIR, `${id}.catalog.json`), { force: true });
  // The smoke never changes user config; detect unexpected persistence rather than overwriting it.
  assert.deepEqual(await readFile(CONFIG_FILE).catch(() => undefined), previousConfig);
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
