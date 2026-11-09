import path from "node:path";
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { RUNTIME } from "./config.js";
import { JsonLines } from "./core/jsonl.js";
import { exists } from "./environment.js";
import type { RunResult } from "./runner.js";

export function summarizeResults(results: RunResult[]): string {
  const groups = new Map<string, RunResult[]>();
  // Legacy results stopped by removed budgets must not count as model failures.
  const legacyBudgetStops = new Set(["timeout", "budget_exhausted", "stalled"]);
  for (const r of results.filter(
    (r) => !r.demo && !legacyBudgetStops.has(String(r.status)),
  )) {
    // Do not compare different thinking levels, goals, adapters or provenance.
    const key = JSON.stringify([
      r.endpoint,
      r.api,
      r.model,
      r.thinking ?? "unknown",
      r.knowledge,
      r.observation,
      r.skipIntro ?? false,
      r.goal,
      r.provenance,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  if (!groups.size)
    return "No real runs yet. Demo results are never added to the leaderboard.\n";
  const lines = [
    "# HackingBench results",
    "",
    "Early adapter results, not a validated leaderboard. Infra errors, cancellations and legacy budget-stopped records are excluded from pass rate. Different goals, thinking levels, observations, intro settings and adapter provenance are grouped separately. Wall time, tool calls and tokens are recorded as statistics, not enforced quotas.",
    "",
    "| Endpoint / API / model / thinking / knowledge / observation / intro / goal / adapter | Attempts | Pass rate | Infra errors | Best success (s) |",
    "|---|---:|---:|---:|---:|",
  ];
  for (const runs of groups.values()) {
    const r = runs[0]!;
    const name = [
      r.endpoint,
      r.api,
      r.model,
      r.thinking ?? "unknown",
      r.knowledge,
      r.observation,
      r.skipIntro ? "skip-intro" : "full-intro",
      r.goal,
      r.provenance?.adapter.slice(0, 12) ?? "unknown",
    ]
      .join(" / ")
      .replace(/[|\r\n]/g, " ");
    const valid = runs.filter(
      (r) => !["infra_error", "cancelled"].includes(r.status),
    );
    const successes = valid.filter((r) => r.status === "success");
    const rate = valid.length
      ? `${((successes.length / valid.length) * 100).toFixed(1)}%`
      : "N/A";
    const best = successes.length
      ? (Math.min(...successes.map((r) => r.wallMs)) / 1000).toFixed(1)
      : "—";
    lines.push(
      `| ${name} | ${valid.length} | ${rate} | ${runs.filter((r) => r.status === "infra_error").length} | ${best} |`,
    );
  }
  return lines.join("\n") + "\n";
}
export async function report(): Promise<string> {
  const file = path.join(RUNTIME, "results.jsonl");
  if (!(await exists(file))) return summarizeResults([]);
  const results: RunResult[] = [];
  const parser = new JsonLines((r) => {
    results.push(r);
  });
  for await (const chunk of createReadStream(file))
    parser.push(chunk as Buffer);
  const content = summarizeResults(results);
  await writeFile(path.join(RUNTIME, "leaderboard.md"), content);
  return content;
}
