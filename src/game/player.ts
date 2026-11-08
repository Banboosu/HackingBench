import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from './bridge.js';
import { validateCommand } from '../core/safety.js';

export function boundedText(value: unknown, maxBytes = 4096): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text) <= maxBytes) return text;
  return Buffer.from(text).subarray(0, maxBytes - 64).toString('utf8') + '\n[Observation truncated to 4 KiB]';
}
export class Player {
  constructor(private bridge: Bridge) {}
  async screen(signal?: AbortSignal): Promise<unknown> { return this.bridge.call('bench.screen', {}, signal); }
  async cmd(input: string, signal?: AbortSignal): Promise<unknown> {
    const cmd = validateCommand(input);
    const before = await this.bridge.call('terminal.history', { lines: 120 }, signal);
    await this.bridge.call('bench.command', { cmd }, signal);
    // Command submission is not completion. Allow asynchronous executables to progress.
    await delay(650, undefined, { signal });
    const after = await this.bridge.call('terminal.history', { lines: 120 }, signal);
    const delta = Math.max(0, Number(after.total) - Number(before.total));
    return { cmd, lines: delta ? after.lines.slice(-Math.min(delta, 120)) : [], note: delta ? undefined : 'Submitted; no new terminal output yet. Use hn_wait/hn_screen for running programs.' };
  }
  async wait(seconds: number, signal?: AbortSignal): Promise<unknown> {
    if (!Number.isFinite(seconds) || seconds < 0.1 || seconds > 30) throw new Error('Wait must be 0.1–30 seconds.');
    await delay(seconds * 1000, undefined, { signal });
    return this.screen(signal);
  }
  async input(text: string, signal?: AbortSignal): Promise<unknown> {
    if (typeof text !== 'string' || text.length > 256 || /[\p{Cc}\p{Cf}]/u.test(text)) throw new Error('Prompt input must be at most 256 printable characters.');
    return this.bridge.call('bench.input', { text }, signal);
  }
  async tutorial(action: 'continue' | 'hint', signal?: AbortSignal): Promise<unknown> {
    if (!['continue','hint'].includes(action)) throw new Error('Unknown tutorial button.');
    return this.bridge.call('bench.tutorial', { action }, signal);
  }
  async mail(action: 'list' | 'read', id?: number, signal?: AbortSignal): Promise<unknown> {
    if (!['list','read'].includes(action) || (action === 'read' && (!Number.isInteger(id) || id! < 0))) throw new Error('Use list, or read with a nonnegative mail ID.');
    return this.bridge.call('bench.mail', { action, id }, signal);
  }
  async reply(id: number, answer: string, signal?: AbortSignal): Promise<unknown> {
    if (!Number.isInteger(id) || id < 0 || typeof answer !== 'string' || answer.length > 2000) throw new Error('Invalid mail reply.');
    return this.bridge.call('bench.reply', { id, answer }, signal);
  }
  async hub(action: 'list' | 'accept', id?: string, signal?: AbortSignal): Promise<unknown> {
    if (!['list','accept'].includes(action) || (action === 'accept' && (!id || !/^(contract|listing|dhs):[a-zA-Z0-9_.-]{1,100}$/.test(id)))) throw new Error('Use a listing ID returned by hn_hub.');
    return this.bridge.call('bench.hub', { action, id }, signal);
  }
  async capture(signal?: AbortSignal): Promise<{ data: string; mimeType: string }> {
    const image = await this.bridge.call('bench.capture', {}, signal);
    if (image.mimeType !== 'image/png' || typeof image.data !== 'string' || image.data.length > 8_000_000) throw new Error('Invalid or oversized game screenshot.');
    return image;
  }
}
