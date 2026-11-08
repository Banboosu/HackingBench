import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RUNTIME, validateEndpoint, type BenchConfig } from './config.js';
import { PiRpc } from './pi/rpc.js';
import { createJail } from './pi/jail.js';
import { redact } from './core/safety.js';

/** Probe through pi itself, so API serialization/auth matches the actual run. No player tools. */
export async function testProvider(config: BenchConfig, key: string, pi: string, signal?: AbortSignal): Promise<string> {
  validateEndpoint(config.baseUrl);
  if (!key) throw new Error('Save an API key with the native pi /login command first.');
  signal?.throwIfAborted();
  const callerSignal = signal;
  const deadline = AbortSignal.timeout(45000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const folder = path.join(RUNTIME,'preflight',randomUUID());
  await mkdir(folder, { recursive: true });
  const jail = await createJail(config,folder,key,'','');
  const args: string[] = [];
  for (let i = 0; i < jail.args.length; i++) {
    if (['-e','--tools','--system-prompt'].includes(jail.args[i]!)) { i++; continue; }
    args.push(jail.args[i]!);
  }
  args.push('--no-tools','--system-prompt','You are a connectivity test. Reply READY. Do not call tools.');
  const rpc = new PiRpc();
  let cancelWait: (() => void) | undefined;
  const abort = () => { void rpc.stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const done = new Promise<string>((resolve,reject) => {
      if (signal?.aborted) { reject(new Error('Provider preflight cancelled.')); return; }
      cancelWait = () => reject(new Error('Provider preflight cancelled.'));
      signal?.addEventListener('abort', cancelWait, { once: true });
      const settled = () => { if (cancelWait) signal?.removeEventListener('abort', cancelWait); };
      let text = ''; let failure = '';
      rpc.on('record', e => {
        if (e.type === 'message_end' && e.message?.role === 'assistant') {
          text = (e.message.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          if (e.message.stopReason === 'error' || e.message.stopReason === 'aborted') failure = e.message.errorMessage ?? 'Provider request failed.';
        }
        if (e.type === 'agent_settled') { settled(); failure || !text ? reject(new Error(failure || 'Provider returned no text.')) : resolve(text); }
      });
      rpc.on('fault', error => { settled(); reject(error); });
    });
    // Attach immediately so an early process failure cannot become an unhandled rejection.
    const observed = done.then(value => ({ value }), error => ({ error }));
    signal?.throwIfAborted();
    rpc.start(pi,args,{ cwd: jail.cwd, env: jail.env });
    await rpc.request('get_state',{},30000);
    await rpc.request('prompt',{ message: 'Reply READY only.' });
    const answer = await observed;
    if ('error' in answer) throw answer.error;
    return 'Connected: ' + redact(answer.value,[key]).slice(0,100);
  } catch (e) {
    if (callerSignal?.aborted) throw new Error('Provider preflight cancelled.');
    if (deadline.aborted) throw new Error('Provider preflight exceeded 45 seconds.');
    throw new Error(redact((e as Error).message,[key]));
  }
  finally {
    signal?.removeEventListener('abort', abort);
    if (cancelWait) signal?.removeEventListener('abort', cancelWait);
    await rpc.stop();
  }
}
