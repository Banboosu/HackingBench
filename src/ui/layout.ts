import {
  isViewportTUI,
  ScrollView,
  VStack,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

/**
 * pi 1.5's normal chat layout puts a fixed-height widget below a growing
 * transcript. This command-only workbench instead gives the deck that space.
 * Reuse the mounted native components and the SAME renderer/focus manager;
 * do not patch node_modules, private InteractiveMode fields, or input handling.
 * The public children order below is an explicit adapter contract for pinned
 * pi 1.5.0; refuse unexpected trees rather than accidentally dropping controls.
 */
export function mountDeckLayout(
  tui: TUI,
  renderDeck: (width: number, height: number) => string[],
  renderFeedback?: (document: Component, width: number) => string[],
): Component {
  if (!isViewportTUI(tui))
    return {
      render: (width) => renderDeck(width, Math.max(6, tui.terminal.rows - 6)),
      invalidate() {},
    };

  if (tui.children.length !== 7)
    throw new Error(
      "Unsupported pi control-deck component tree (expected pi 1.5.0 fullscreen).",
    );
  const [
    document,
    pending,
    status,
    _widgetsAbove,
    editor,
    widgetsBelow,
    footer,
  ] = tui.children;
  const controls = [pending!, status!, editor!, widgetsBelow!, footer!];
  // Native login/model/errors remain readable, but old notifications must not
  // become a large empty transcript above the deck. Longer output is scrollable.
  const feedbackDocument: Component = {
    render: (width) =>
      renderFeedback?.(document!, width) ?? document!.render(width),
    invalidate: () => document!.invalidate(),
  };
  const feedback = new ScrollView(feedbackDocument, {
    follow: "end",
    primary: true,
    scrollbar: "auto",
  });
  const maxFeedbackRows = 4;
  const deck: Component = {
    render(width) {
      const controlRows = controls.reduce(
        (sum, child) => sum + child.render(width).length,
        0,
      );
      const feedbackRows = Math.min(
        maxFeedbackRows,
        feedbackDocument.render(width).length,
      );
      return renderDeck(
        width,
        Math.max(1, tui.terminal.rows - controlRows - feedbackRows),
      );
    },
    invalidate() {},
  };
  tui.setLayoutRoot(
    new VStack([
      { component: deck, basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: feedback, shrink: 1, minSize: 0, maxSize: maxFeedbackRows },
      { component: pending!, shrink: 1, minSize: 0 },
      { component: status!, shrink: 1, minSize: 0 },
      { component: editor!, shrink: 1, minSize: 3 },
      { component: widgetsBelow!, shrink: 1, minSize: 0 },
      { component: footer!, shrink: 1, minSize: 0 },
    ]),
  );
  return deck;
}
