import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RUNTIME } from '../config.js';
import { COMMANDS, assertNoLinks, childEnvironment } from '../core/safety.js';
import { terminate } from '../core/process.js';
import { Bridge } from './bridge.js';
import { verifyBinaries } from './integrity.js';
import { MIN_BUN_VERSION, supportedBun } from '../core/runtime.js';

export class GameSession extends EventEmitter {
  readonly token = randomBytes(32).toString('hex');
  readonly pipeName = `hnpf-bench-${randomUUID()}`;
  readonly pipe = `\\\\.\\pipe\\${this.pipeName}`;
  bridge?: Bridge;
  private child?: ChildProcess;
  private failure?: Error;
  private closing = false;
  get pid(): number | undefined { return this.child?.pid; }
  async start(runDir: string, signal?: AbortSignal): Promise<unknown> {
    if (process.platform !== 'win32' || !supportedBun()) throw new Error(`Live game sessions require Windows-native Bun >=${MIN_BUN_VERSION}.`);
    const root=path.join(RUNTIME,'game');
    await assertNoLinks(RUNTIME,root); await assertNoLinks(RUNTIME,runDir);
    const marker=JSON.parse(await readFile(path.join(root,'.hackingbench-install.json'),'utf8'));
    if (marker.version!==2 || !marker.steamDisabled || marker.saveRoot!=='HACKINGBENCH_SAVE_DIR' || marker.offlinePatchVersion!==2) throw new Error('Game isolation marker is invalid or outdated.');
    await verifyBinaries(root,marker.binaryFingerprints);
    const exe=path.join(root,'Hacknet.exe');
    const saves=path.join(runDir,'accounts')+path.sep;
    await mkdir(saves,{recursive:true});
    const documents=path.join(runDir,'documents');
    await mkdir(documents,{recursive:true});
    await writeFile(path.join(root,'BepInEx','config','com.HnpfMcp.Bridge.cfg'),
      `[Pipe]\nName = ${this.pipeName}\nToken = ${this.token}\nAutoToken = false\n\n[Safety]\nReadOnly = false\nAllowedCommands = ${COMMANDS.filter(c=>c!=='quit').join(',')}\nBlockedCommands = mcp,loadmission,loadactions,dscan,debug,sudo,execute,quit\n`,{mode:0o600});
    signal?.throwIfAborted();
    this.child=spawn(exe,[],{cwd:root,env:childEnvironment({HACKINGBENCH_SAVE_DIR:saves,HACKINGBENCH_DOCUMENTS:documents}),shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    this.child.on('error',e => this.fault(e));
    this.child.on('exit',(code,signal) => { if (!this.closing) this.fault(new Error(`Benchmark game exited (code=${code}, signal=${signal}).`)); });
    const diagnostic=(b: Buffer) => {
      const text=b.toString(); this.emit('diagnostic',text);
      if (/Error loading \[PathfinderAPI/.test(text)) this.fault(new Error('Pathfinder failed to initialize. Refusing a partially loaded game; inspect game logs.'));
    };
    this.child.stdout?.on('data',diagnostic);
    this.child.stderr?.on('data',diagnostic);
    const bootDeadline=performance.now()+60000;
    let lastError='No bridge connection.';
    while (performance.now()<bootDeadline) {
      signal?.throwIfAborted(); if (this.failure) throw this.failure;
      const attempt=new Bridge(this.pipe,this.token,2000);
      try {
        await attempt.connect();
        const status=await attempt.call('menu.status');
        if (path.resolve(status.saveRoot)!==path.resolve(saves)) throw new Error('Save-root isolation mismatch.');
        this.bridge=attempt; break;
      } catch(e) { lastError=(e as Error).message; attempt.close(); await delay(400,undefined,{signal}); }
    }
    if (!this.bridge) throw new Error(`Game did not reach a safe main menu within 60 seconds: ${lastError}`);
    // Mutating request is sent exactly once; never retry account creation on ambiguous timeout.
    await this.bridge.call('menu.start_vanilla',{username:'bench'+randomBytes(6).toString('hex')},signal,60000);
    const loadDeadline=performance.now()+60000;
    while (performance.now()<loadDeadline) {
      signal?.throwIfAborted(); if (this.failure) throw this.failure;
      try {
        const screen=await this.bridge.call('bench.screen',{},signal);
        if (screen.booting===false && screen.inputEnabled===true) return screen;
        lastError='Game is still showing its boot sequence.';
      } catch(e) { lastError=(e as Error).message; }
      await delay(500,undefined,{signal});
    }
    throw new Error(`Original campaign failed to load: ${lastError}`);
  }
  private fault(error: Error): void { this.failure=error; this.emit('fault',error); }
  async close(): Promise<void> {
    this.closing=true; this.bridge?.close(); this.bridge=undefined;
    if (this.child) await terminate(this.child);
  }
}
