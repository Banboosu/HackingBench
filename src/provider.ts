import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RUNTIME, validateEndpoint, type BenchConfig } from './config.js';
import { PiRpc } from './pi/rpc.js';
import { createJail } from './pi/jail.js';
import { redact } from './core/safety.js';

/** Probe through pi itself, so API serialization/auth matches the actual run. No player tools. */
export async function testProvider(config: BenchConfig, key: string, pi: string): Promise<string> {
  validateEndpoint(config.baseUrl);
  if (!key) throw new Error(`Set ${config.keyEnv} or enter a session-only key in Configure.`);
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
  try {
    const done = new Promise<string>((resolve,reject) => {
      let text = ''; let failure = '';
      rpc.on('record', e => {
        if (e.type === 'message_end' && e.message?.role === 'assistant') {
          text = (e.message.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
          if (e.message.stopReason === 'error' || e.message.stopReason === 'aborted') failure = e.message.errorMessage ?? 'Provider request failed.';
        }
        if (e.type === 'agent_settled') failure || !text ? reject(new Error(failure || 'Provider returned no text.')) : resolve(text);
      });
      rpc.on('fault', reject);
    });
    // Attach immediately so an early process failure cannot become an unhandled rejection.
    const observed = done.then(value => ({ value }), error => ({ error }));
    rpc.start(pi,args,{ cwd: jail.cwd, env: jail.env });
    await rpc.request('get_state',{},30000);
    await rpc.request('prompt',{ message: 'Reply READY only.' });
    const answer = await Promise.race([observed, new Promise<{error: Error}>(resolve => {
      const timer = setTimeout(() => resolve({error:new Error('Provider preflight exceeded 45 seconds.')}),45000);
      timer.unref();
      observed.finally(() => clearTimeout(timer));
    })]);
    if ('error' in answer) throw answer.error;
    return 'Connected: ' + answer.value.slice(0,100);
  } catch (e) { throw new Error(redact((e as Error).message,[key])); }
  finally { await rpc.stop(); }
}
