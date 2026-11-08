import test from "node:test";
import assert from "node:assert/strict";
import {
  Container,
  Spacer,
  Text,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { createBenchTheme } from "../src/ui/theme.js";
import { nativeFeedback } from "../src/ui/feedback.js";

const provider = "endpoint-0123456789abcdef";
const theme = createBenchTheme();
function document(message: string): Container {
  const root = new Container();
  const chat = new Container();
  chat.addChild(new Spacer(1));
  chat.addChild(new Text(theme.fg("error", message), 1, 0));
  root.addChild(chat);
  return root;
}
const advisory = `Error: Saved API key for example.test [HackingBench], but no default model is configured for provider "${provider}". Use /model to select a model.`;

test("native custom-provider login guidance is informational, resolves after selection, and survives wrapping", () => {
  for (const width of [12, 20, 40, 55, 80, 100, 168]) {
    const doc = document(advisory);
    const before = nativeFeedback(doc, width, theme, (id) => id === provider);
    assert.ok(before.every((line) => visibleWidth(line) <= width));
    const text = stripTerminalSequences(before.join("")).replace(/\s/g, "");
    assert.match(text, /Credentialssaved\.Use\/model/);
    assert.doesNotMatch(text, /Error:|nodefaultmodel/);
    assert.deepEqual(
      nativeFeedback(doc, width, theme, () => false),
      [],
    );
    assert.match(
      stripTerminalSequences(doc.render(200).join("")),
      /Error: Saved API key/,
      "Native transcript must remain unchanged.",
    );
  }
  const commandcode = advisory.replace(
    provider,
    "commandcode-0123456789abcdef",
  );
  assert.deepEqual(
    nativeFeedback(document(commandcode), 80, theme, () => false),
    [],
  );
});

test("real auth/catalog/model errors and other providers are never hidden or recolored", () => {
  for (const text of [
    "Error: Failed to save API key: HTTP 401",
    "Warning: Model catalog refresh timed out; using cached models.",
    `Error: Saved API key, but no models are available for that provider. Use /model to select a model.`,
    `Error: Saved API key, but selecting its default model failed: HTTP 403. Use /model to select a model.`,
    advisory.replace(provider, "another-provider"),
    advisory + " Additional genuine failure.",
  ]) {
    const doc = document(text);
    const before = doc
      .render(100)
      .filter((line) => stripTerminalSequences(line).trim());
    assert.deepEqual(
      nativeFeedback(doc, 100, theme, () => false),
      before,
    );
  }
});
