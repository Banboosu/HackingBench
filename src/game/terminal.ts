export interface TerminalHistory {
  lines: string[];
  total: number;
}

/** Copy a bridge snapshot: never keep an alias to a mutable terminal buffer. */
export function terminalHistory(value: unknown): TerminalHistory {
  const raw = value as { lines?: unknown; total?: unknown } | null;
  const lines = Array.isArray(raw?.lines)
    ? raw.lines.filter((line): line is string => typeof line === "string")
    : [];
  const total = Number(raw?.total);
  return {
    lines,
    total:
      Number.isSafeInteger(total) && total >= lines.length
        ? total
        : lines.length,
  };
}

export function sameTerminal(a: TerminalHistory, b: TerminalHistory): boolean {
  return (
    a.total === b.total &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i])
  );
}

/**
 * Prefer absolute line positions from full-history counts. Also handle a
 * rolling/fallback window (constant total) and write() changing an existing row.
 * Returned rows include the whole changed row, not just its appended characters.
 */
export function terminalDelta(
  before: TerminalHistory,
  after: TerminalHistory,
): { lines: string[]; reset: boolean } {
  if (sameTerminal(before, after)) return { lines: [], reset: false };
  if (after.total > before.total) {
    const beforeStart = before.total - before.lines.length;
    const afterStart = after.total - after.lines.length;
    const first = after.lines.findIndex((line, i) => {
      const position = afterStart + i;
      return (
        position >= before.total ||
        (position >= beforeStart &&
          before.lines[position - beforeStart] !== line)
      );
    });
    return { lines: first < 0 ? [] : after.lines.slice(first), reset: false };
  }

  // A legacy bridge may expose only the latest 29 rows and report total=29.
  // Align the old suffix with the new prefix, rather than treating equal counts
  // as unchanged. Prefix comparison separately catches in-place row updates.
  let overlap = Math.min(before.lines.length, after.lines.length);
  while (
    overlap > 0 &&
    !before.lines.slice(-overlap).every((line, i) => line === after.lines[i])
  )
    overlap--;
  let prefix = 0;
  while (
    prefix < Math.min(before.lines.length, after.lines.length) &&
    before.lines[prefix] === after.lines[prefix]
  )
    prefix++;
  const reset = after.total < before.total && overlap === 0 && prefix === 0;
  return { lines: after.lines.slice(Math.max(overlap, prefix)), reset };
}
