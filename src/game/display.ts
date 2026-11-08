import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME } from "../config.js";
import { assertNoLinks, within } from "../core/safety.js";

export interface GameWindow {
  width: number;
  height: number;
  fullscreen: boolean;
}
export const DEFAULT_GAME_WINDOW: Readonly<GameWindow> = Object.freeze({
  width: 1920,
  height: 1080,
  fullscreen: false,
});
const DEFAULT_SETTINGS = [
  String(DEFAULT_GAME_WINDOW.width),
  String(DEFAULT_GAME_WINDOW.height),
  String(DEFAULT_GAME_WINDOW.fullscreen),
  "bloom: true",
  "scanlines: true",
  "muted: false",
  "volume: 0.8",
  "fontConfig: medium",
  "hasSaved: True",
  "shouldMultisample: True",
  "defaultLocale: en-us",
  "drawMusicVis: True",
  "",
].join("\r\n");

function checkWindow(window: GameWindow): void {
  for (const [name, value, min, max] of [
    ["width", window.width, 640, 4096],
    ["height", window.height, 480, 4096],
  ] as const) {
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(
        `Game window ${name} must be an integer from ${min} to ${max}.`,
      );
  }
  if (typeof window.fullscreen !== "boolean")
    throw new Error("Game fullscreen must be true or false.");
}

/** Windows Hacknet SettingsLoader reads width, height, fullscreen from the first three lines. */
export function windowedSettings(
  text: string,
  window: GameWindow = DEFAULT_GAME_WINDOW,
): string {
  checkWindow(window);
  const header =
    /^(?:\uFEFF)?[1-9]\d*\r?\n[1-9]\d*\r?\n(?:true|false)(?=\r?\n|$)/i.exec(
      text,
    );
  if (!header)
    throw new Error(
      "Unsupported project Settings.txt header; expected width, height and fullscreen flag.",
    );
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const bom = text.startsWith("\uFEFF") ? "\uFEFF" : "";
  return (
    bom +
    [
      String(window.width),
      String(window.height),
      String(window.fullscreen),
    ].join(eol) +
    text.slice(header[0].length)
  );
}

/** Never write Steam's settings. Called only for the prepared/staging project copy, before launch. */
export async function ensureGameWindow(
  gameRoot: string,
  window: GameWindow = DEFAULT_GAME_WINDOW,
): Promise<void> {
  checkWindow(window);
  if (
    !within(RUNTIME, gameRoot) ||
    path.resolve(gameRoot) === path.resolve(RUNTIME)
  )
    throw new Error(
      "Refusing to change game display settings outside a project runtime game directory.",
    );
  const file = path.join(gameRoot, "Settings.txt");
  await assertNoLinks(RUNTIME, file);
  let previous: string | undefined;
  try {
    previous = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next = windowedSettings(previous ?? DEFAULT_SETTINGS, window);
  if (next !== previous) await writeFile(file, next, "utf8");
}
