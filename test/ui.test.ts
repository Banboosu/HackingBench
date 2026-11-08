import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { setTimeout as delay } from 'node:timers/promises';
import { App } from '../src/ui/app.js';
import { defaults } from '../src/config.js';

const tick=()=>delay(40);
test('TUI deck renders demo, security notice, controls and metrics',async()=>{
  const app=render(React.createElement(App,{initialConfig:defaults(),demo:true}));
  try {
    await tick();
    const frame=app.lastFrame() ?? '';
    assert.match(frame,/HACKINGBENCH/);assert.match(frame,/SIMULATION/);assert.match(frame,/Not an OS sandbox/);
    assert.match(frame,/Start/);assert.match(frame,/TOKENS/);
    app.stdin.write('c');await tick();
    assert.match(app.lastFrame() ?? '',/LINK CONFIGURATION/);
    app.stdin.write('\x1b');await tick();
    assert.match(app.lastFrame() ?? '',/LIVE TERMINAL/);
  } finally {app.unmount();cleanup();}
});
test('masked session key is never printed in TUI frames',async()=>{
  const app=render(React.createElement(App,{initialConfig:defaults(),demo:true}));
  try {
    await tick();app.stdin.write('c');await tick();
    for(let i=0;i<4;i++){app.stdin.write('\x1b[B');await tick();}
    app.stdin.write('\r');await tick();
    app.stdin.write('secret-do-not-display');await tick();
    assert.ok(!app.frames.join('\n').includes('secret-do-not-display'));
    app.stdin.write('\r');await tick();
    assert.match(app.lastFrame() ?? '',/memory only/);
  } finally {app.unmount();cleanup();}
});
