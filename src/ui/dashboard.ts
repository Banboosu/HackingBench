import { truncateToWidth } from '@earendil-works/pi-tui';
import type { BenchConfig } from '../config.js';
import { terminalText } from '../core/safety.js';

export interface DashboardState {
  phase: string; activity: string; wallMs: number; steps: number; tokens: number;
  llmMs: number; toolMs: number; action: string; observation: string; assistant: string; log: string;
}
export function emptyDashboard(): DashboardState {
  return { phase: 'IDLE', activity: 'idle', wallMs: 0, steps: 0, tokens: 0, llmMs: 0, toolMs: 0, action: '', observation: '', assistant: '', log: '' };
}
const safeLine = (text: string) => terminalText(text).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/[\r\n\t]+/g, ' ');
export function dashboardLines(state: DashboardState, config: BenchConfig, demo: boolean, width: number): string[] {
  const seconds = Math.floor(state.wallMs / 1000);
  const timer = `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
  return [
    `HACKINGBENCH | ${demo ? 'SIMULATION' : 'EXPERIMENTAL / VANILLA'} | ${state.phase}`,
    `LLM ${state.activity} | ${config.model} | thinking ${config.thinking}`,
    `TIME ${timer} / ${config.wallTimeSeconds}s | TOOLS ${state.steps}/${config.maxSteps} | TOKENS ${state.tokens}/${config.maxTokens}`,
    `LLM ${(state.llmMs / 1000).toFixed(1)}s | TOOL ${(state.toolMs / 1000).toFixed(1)}s | Game runs in real time; no verified mission percentage`,
    `ACTION ${state.action || '(none)'}`,
    `AGENT ${state.assistant || '(waiting)'}`,
    ...((state.observation || 'No game observation yet.').split(/\r?\n/).filter(Boolean).slice(-3).map((line, i) => `${i ? '    ' : 'GAME'} ${line}`)),
    `STATUS ${state.log || '/provider -> /login -> /model -> /test -> /start'}`,
    'Not an OS sandbox | DLC not scored | /stop cancels the owned run',
  ].map(line => truncateToWidth(safeLine(line), Math.max(1, width)));
}
