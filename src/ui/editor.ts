import {
  CustomEditor,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  visibleWidth,
  truncateToWidth,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";

/** Style the border only. Native editing, focus/IME, history and command completion stay intact. */
export class BenchEditor extends CustomEditor {
  constructor(
    tui: TUI,
    editorTheme: EditorTheme,
    keybindings: KeybindingsManager,
    private paint: () => Theme,
  ) {
    super(tui, editorTheme, keybindings, {
      paddingX: 1,
      autocompleteMaxVisible: 6,
    });
  }
  protected renderTopBorder(width: number, hiddenLineCount: number): string {
    if (width < 12) return super.renderTopBorder(width, hiddenLineCount);
    const theme = this.paint();
    const label = truncateToWidth(
      hiddenLineCount ? ` COMMAND · ↑ ${hiddenLineCount} more ` : " COMMAND ",
      Math.max(1, width - 4),
      "",
    );
    return (
      theme.fg("borderMuted", "─ ") +
      theme.fg("accent", label) +
      theme.fg(
        "borderMuted",
        "─".repeat(Math.max(0, width - visibleWidth(label) - 2)),
      )
    );
  }
}
