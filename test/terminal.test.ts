import test from "node:test";
import assert from "node:assert/strict";
import {
  sameTerminal,
  terminalDelta,
  terminalHistory,
} from "../src/game/terminal.js";

const history = (lines: string[], total = lines.length) => ({ lines, total });

test("terminal snapshots copy rows and tolerate missing/invalid totals", () => {
  const lines = ["existing"];
  const snapshot = terminalHistory({ lines, total: 1 });
  lines[0] = "changed";
  assert.deepEqual(snapshot, history(["existing"]));
  for (const total of [undefined, -1, NaN, Infinity, "invalid"])
    assert.deepEqual(terminalHistory({ lines, total }), history(["changed"]));
  assert.deepEqual(terminalHistory(null), history([]));
});

test("terminal deltas use full-history positions beyond 30 rows", () => {
  const before = history(
    Array.from({ length: 120 }, (_, i) => `row ${i + 80}`),
    200,
  );
  const after = history(
    [...before.lines.slice(3), "> ls", ":home", ":bin"],
    203,
  );
  assert.deepEqual(terminalDelta(before, after), {
    lines: ["> ls", ":home", ":bin"],
    reset: false,
  });
});

test("terminal deltas detect rolling 29-row output with a constant total", () => {
  const before = history(Array.from({ length: 29 }, (_, i) => `row ${i}`));
  const after = history([...before.lines.slice(3), "> ls", ":home", ":sys"]);
  assert.deepEqual(terminalDelta(before, after), {
    lines: ["> ls", ":home", ":sys"],
    reset: false,
  });
  assert.equal(sameTerminal(before, after), false);
});

test("terminal deltas include in-place writes even without new rows", () => {
  const before = history(["old", "Probing ..."], 100);
  const after = history(["old", "Probing ....Complete"], 100);
  assert.deepEqual(terminalDelta(before, after), {
    lines: ["Probing ....Complete"],
    reset: false,
  });
});

test("terminal deltas include a changed old tail alongside appended output", () => {
  assert.deepEqual(
    terminalDelta(
      history(["old", "Probing ..."], 100),
      history(["old", "Probing ...Complete", "Port 22"], 101),
    ),
    { lines: ["Probing ...Complete", "Port 22"], reset: false },
  );
});

test("terminal deltas distinguish clears from a shorter view of the same history", () => {
  const before = history(["one", "two", "three"], 100);
  assert.deepEqual(terminalDelta(before, history([])), {
    lines: [],
    reset: true,
  });
  assert.deepEqual(terminalDelta(before, history(["fresh"])), {
    lines: ["fresh"],
    reset: true,
  });
  assert.deepEqual(terminalDelta(before, history(["two", "three"], 100)), {
    lines: [],
    reset: false,
  });
});

test("terminal deltas preserve repeated/blank rows and unchanged snapshots", () => {
  const before = history(["", "repeat", "repeat"], 100);
  assert.deepEqual(terminalDelta(before, history([...before.lines], 100)), {
    lines: [],
    reset: false,
  });
  assert.deepEqual(
    terminalDelta(before, history(["repeat", "repeat", "repeat"], 101)),
    {
      lines: ["repeat"],
      reset: false,
    },
  );
  assert.deepEqual(terminalDelta(before, history([...before.lines, ""], 101)), {
    lines: [""],
    reset: false,
  });
});
