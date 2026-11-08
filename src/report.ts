import path from 'node:path';
import { createReadStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { RUNTIME } from './config.js';
import { JsonLines } from './core/jsonl.js';
import { exists } from './environment.js';
import type { RunResult } from './runner.js';

export function summarizeResults(results: RunResult[]): string {
  const groups = new Map<string,RunResult[]>();
  for (const r of results.filter(r=>!r.demo)) {
    // Do not compare different thinking levels, goals, adapters, or resource limits.
    const key=JSON.stringify([r.endpoint,r.api,r.model,r.thinking ?? 'unknown',r.knowledge,r.observation,r.goal,r.provenance,r.limits]);
    groups.set(key,[...(groups.get(key) ?? []),r]);
  }
  if (!groups.size) return 'No real runs yet. Demo results are never added to the leaderboard.\n';
  const lines = ['# HackingBench results','', 'Early adapter results, not a validated leaderboard. Infra errors and cancellations are excluded from pass rate. Different goals, thinking levels, adapter provenance and budgets are grouped separately.','', '| Endpoint / API / model / thinking / knowledge / observation / goal / adapter / limits (s,calls,tokens) | Attempts | Pass rate | Infra errors | Best success (s) |','|---|---:|---:|---:|---:|'];
  for (const runs of groups.values()) {
    const r=runs[0]!;
    const limits=r.limits ? `${r.limits.wallTimeSeconds},${r.limits.maxSteps},${r.limits.maxTokens}` : 'unknown';
    const name=[r.endpoint,r.api,r.model,r.thinking ?? 'unknown',r.knowledge,r.observation,r.goal,r.provenance?.adapter.slice(0,12) ?? 'unknown',limits].join(' / ').replace(/[|\r\n]/g,' ');
    const valid = runs.filter(r => !['infra_error','cancelled'].includes(r.status));
    const successes = valid.filter(r => r.status === 'success');
    const rate = valid.length ? `${(successes.length/valid.length*100).toFixed(1)}%` : 'N/A';
    const best = successes.length ? (Math.min(...successes.map(r => r.wallMs))/1000).toFixed(1) : '—';
    lines.push(`| ${name} | ${valid.length} | ${rate} | ${runs.filter(r=>r.status==='infra_error').length} | ${best} |`);
  }
  return lines.join('\n')+'\n';
}
export async function report(): Promise<string> {
  const file = path.join(RUNTIME,'results.jsonl');
  if (!await exists(file)) return summarizeResults([]);
  const results: RunResult[] = [];
  const parser = new JsonLines(r => { results.push(r); });
  for await (const chunk of createReadStream(file)) parser.push(chunk as Buffer);
  const content=summarizeResults(results);
  await writeFile(path.join(RUNTIME,'leaderboard.md'),content);
  return content;
}
