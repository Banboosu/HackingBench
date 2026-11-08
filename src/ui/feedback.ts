import {
  Container,
  Text,
  stripTerminalSequences,
  type Component,
} from "@earendil-works/pi-tui";
import type { DashboardPaint } from "./dashboard.js";

/**
 * pi 1.5 hard-codes default models for built-in providers only. Its native
 * successful /login reports this normal next step as Error for our hashed IDs.
 * Project the exact advisory as a hint until selection, then omit it. Never
 * suppress failed auth, unavailable models, refresh errors or inference errors.
 * This only reads public mounted components; it does not alter native auth,
 * private InteractiveMode fields, transcript data, or the input/focus manager.
 */
export function nativeFeedback(
  document: Component,
  width: number,
  theme: DashboardPaint,
  needsModel: (provider: string) => boolean,
): string[] {
  const render = (node: Component): string[] => {
    // Only plain Containers are transparent. Subclasses may implement their
    // own layout/padding/interaction and must retain their normal rendering.
    if (node.constructor === Container)
      return (node as Container).children.flatMap(render);
    const lines = node.render(width);
    // Matching a whole text component, without layout whitespace, also works
    // when native wrapping splits the provider hash over narrow terminal rows.
    const text = stripTerminalSequences(lines.join("")).replace(/\s+/g, "");
    const advisory =
      /^Error:(?:SavedAPIkeyfor|Loggedinto).+,butnodefaultmodelisconfiguredforprovider"((?:endpoint|commandcode)-[a-f0-9]{16})"\.Use\/modeltoselectamodel\.$/.exec(
        text,
      );
    if (!advisory) return lines;
    return needsModel(advisory[1]!)
      ? new Text(
          theme.fg(
            "accent",
            "Credentials saved. Use /model to select a model.",
          ),
          1,
          0,
        ).render(width)
      : [];
  };
  const lines = render(document);
  // Omitted advisories leave their native Spacer behind. Don't reserve blank
  // feedback rows after a resolved hint, nor remove any non-empty real error.
  while (lines.length && !stripTerminalSequences(lines[0]!).trim())
    lines.shift();
  while (lines.length && !stripTerminalSequences(lines.at(-1)!).trim())
    lines.pop();
  return lines;
}
