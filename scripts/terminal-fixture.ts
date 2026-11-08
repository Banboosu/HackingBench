import {
  Terminal as HeadlessTerminal,
  type IBufferCell,
} from "@xterm/headless";
import type { Terminal, ProgramStatus } from "@earendil-works/pi-tui";

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        ch
      ]!,
  );
const defaultFg = "#dce7ed";
const defaultBg = "#0c151d";
function color(value: number, rgb: boolean): string {
  if (rgb) return `#${value.toString(16).padStart(6, "0")}`;
  if (value < 16)
    return [
      "#000000",
      "#cd0000",
      "#00cd00",
      "#cdcd00",
      "#0000ee",
      "#cd00cd",
      "#00cdcd",
      "#e5e5e5",
      "#7f7f7f",
      "#ff0000",
      "#00ff00",
      "#ffff00",
      "#5c5cff",
      "#ff00ff",
      "#00ffff",
      "#ffffff",
    ][value]!;
  if (value >= 232)
    return `rgb(${[1, 2, 3].map(() => 8 + (value - 232) * 10).join(",")})`;
  const n = value - 16;
  const cube = [0, 95, 135, 175, 215, 255];
  return `rgb(${[cube[Math.floor(n / 36)], cube[Math.floor(n / 6) % 6], cube[n % 6]].join(",")})`;
}
function cellHtml(cell: IBufferCell): string {
  const fg = cell.isFgDefault()
    ? defaultFg
    : color(cell.getFgColor(), cell.isFgRGB());
  const bg = cell.isBgDefault()
    ? defaultBg
    : color(cell.getBgColor(), cell.isBgRGB());
  return `<span style="color:${cell.isInverse() ? bg : fg};background:${cell.isInverse() ? fg : bg}${cell.isBold() ? ";font-weight:bold" : ""}">${escapeHtml(cell.getChars() || " ")}</span>`;
}
/** Test-only ANSI terminal emulator: inspect the actual viewport, not just output substrings. */
export class TestTerminal implements Terminal {
  columns = 100;
  rows = 36;
  kittyProtocolActive = false;
  output = "";
  input?: (data: string) => void;
  private onResize?: () => void;
  readonly screen = new HeadlessTerminal({
    cols: this.columns,
    rows: this.rows,
    allowProposedApi: true,
    scrollback: 100,
  });
  start(onInput: (data: string) => void, onResize: () => void) {
    this.input = onInput;
    this.onResize = onResize;
  }
  stop() {
    this.input = undefined;
    this.onResize = undefined;
  }
  write(data: string) {
    this.output += data;
    this.screen.write(data);
  }
  async drainInput() {}
  moveBy(lines: number) {
    this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? "A" : "B"}`);
  }
  hideCursor() {
    this.write("\x1b[?25l");
  }
  showCursor() {
    this.write("\x1b[?25h");
  }
  clearLine() {
    this.write("\x1b[2K");
  }
  clearFromCursor() {
    this.write("\x1b[J");
  }
  clearScreen() {
    this.write("\x1b[2J\x1b[H");
  }
  setTitle() {}
  setProgress() {}
  setProgramStatus(_status: ProgramStatus) {}
  type(text: string) {
    for (const ch of text) this.input?.(ch);
  }
  resize(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.screen.resize(columns, rows);
    this.onResize?.();
  }
  async flush() {
    await new Promise<void>((resolve) => this.screen.write("", resolve));
  }
  async frame(): Promise<string[]> {
    await this.flush();
    const buffer = this.screen.buffer.active;
    return Array.from(
      { length: this.rows },
      (_, i) =>
        buffer
          .getLine(buffer.viewportY + i)
          ?.translateToString(false, 0, this.columns) ?? "",
    );
  }
  async html(label: string): Promise<string> {
    await this.flush();
    const buffer = this.screen.buffer.active;
    const lines = Array.from({ length: this.rows }, (_, row) => {
      const line = buffer.getLine(buffer.viewportY + row);
      const chunks: string[] = [];
      for (let col = 0; col < this.columns; col++) {
        const cell = line?.getCell(col);
        if (cell && cell.getWidth()) chunks.push(cellHtml(cell));
      }
      return chunks.join("");
    });
    return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(label)}</title><style>body{background:#080f16;color:${defaultFg};padding:28px}h1{font:14px system-ui;color:#8da3af}pre{display:inline-block;font:16px/1.4 Consolas,'Cascadia Mono',monospace;background:${defaultBg};padding:16px;border:1px solid #37525e;border-radius:8px;font-variant-ligatures:none}</style><h1>${escapeHtml(label)} · ${this.columns} × ${this.rows} · native pi viewport / synthetic data only</h1><pre>${lines.join("\n")}</pre>`;
  }
  dispose() {
    this.screen.dispose();
  }
}
