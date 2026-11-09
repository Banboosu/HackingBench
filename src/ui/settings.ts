import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { configSchema, type BenchConfig } from "../config.js";

type SettingKey =
  | "knowledge"
  | "observation"
  | "contextWindow"
  | "maxOutputTokens"
  | "gameWindowWidth"
  | "gameWindowHeight"
  | "gameFullscreen"
  | "skipIntro"
  | "gameSource"
  | "piExecutable";
export interface BenchSetting {
  key: SettingKey;
  label: string;
  help: string;
  numeric?: boolean;
  boolean?: boolean;
  choices?: { value: string; label: string }[];
}
/** Only non-secret benchmark settings. Auth/model/provider remain native pi commands. */
export const BENCH_SETTINGS: readonly BenchSetting[] = [
  {
    key: "knowledge",
    label: "Knowledge",
    help: "L0 uses game help; L1 adds a short command guide. Neither enables host tools.",
    choices: [
      { value: "L0", label: "L0 — Game help only; no extra command guide" },
      { value: "L1", label: "L1 — Include a short command guide" },
    ],
  },
  {
    key: "observation",
    label: "Observation",
    help: "text+image adds game-only hn_screenshot. Requires an image-capable model; catalog support is not guaranteed.",
    choices: [
      { value: "text", label: "text — Text tools only; no screenshot tool" },
      {
        value: "text+image",
        label: "text+image — Text + game framebuffer; vision model required",
      },
    ],
  },
  {
    key: "gameWindowWidth",
    label: "Game window width",
    numeric: true,
    help: "Integer 640–4096 pixels. Applied to the project game copy before launch; Steam's files are untouched.",
  },
  {
    key: "gameWindowHeight",
    label: "Game window height",
    numeric: true,
    help: "Integer 480–4096 pixels. Applied to the project game copy before launch; Steam's files are untouched.",
  },
  {
    key: "gameFullscreen",
    label: "Game fullscreen",
    boolean: true,
    help: "Windowed uses the configured size; fullscreen fills the display. Applied before launch.",
    choices: [
      { value: "false", label: "false — Windowed with the configured size" },
      { value: "true", label: "true — Fullscreen" },
    ],
  },
  {
    key: "skipIntro",
    label: "Skip intro",
    boolean: true,
    help: "Skip the opening story text, boot/typewriter/flicker delays and dismiss the tutorial using normal kill behavior. Start with the first email. Next run only; later reboots and missions are unchanged.",
    choices: [
      {
        value: "false",
        label: "false — Play the original opening tutorial (default)",
      },
      {
        value: "true",
        label: "true — Skip boot animation + tutorial; start with first email",
      },
    ],
  },
  {
    key: "contextWindow",
    label: "Context window",
    numeric: true,
    help: "Integer 16384–2000000; must exceed output limit. Must match the model.",
  },
  {
    key: "maxOutputTokens",
    label: "Output limit per request",
    numeric: true,
    help: "Integer 256–65536; must be smaller than context window. Must match the model.",
  },
  {
    key: "gameSource",
    label: "Hacknet source folder",
    help: "Original game folder (read-only source for setup). Empty input means auto-detect; does not rebuild an existing copy.",
  },
  {
    key: "piExecutable",
    label: "pi.exe path",
    help: "Windows-native pi 1.5.0 executable. Empty input means auto-detect (project install first).",
  },
];
export function benchSetting(key: string): BenchSetting {
  const field = BENCH_SETTINGS.find((field) => field.key === key);
  if (!field)
    throw new Error(
      "Unknown benchmark setting. Use /config to choose; use /provider, /model, /thinking or /login for provider settings.",
    );
  return field;
}
export function settingValue(config: BenchConfig, field: BenchSetting): string {
  return String(config[field.key]) || "Auto-detect";
}
export function changeSetting(
  config: BenchConfig,
  field: BenchSetting,
  text: string,
): BenchConfig {
  const raw = text.trim();
  let value: unknown;
  if (field.boolean) {
    if (!/^(?:true|false)$/i.test(raw))
      throw new Error(`Invalid ${field.label}. ${field.help}`);
    value = raw.toLowerCase() === "true";
  } else if (field.numeric) value = Number(raw);
  else
    value =
      field.choices?.find(
        (choice) => choice.value.toLowerCase() === raw.toLowerCase(),
      )?.value ?? raw;
  const parsed = configSchema.safeParse({ ...config, [field.key]: value });
  // Do not echo arbitrary input or full config in validation errors.
  if (!parsed.success) throw new Error(`Invalid ${field.label}. ${field.help}`);
  return parsed.data;
}
export function configCompletions(prefix: string): AutocompleteItem[] | null {
  const match = prefix.trimStart().match(/^(\S+)\s+(.*)$/);
  const items = match
    ? BENCH_SETTINGS.find((field) => field.key === match[1])
        ?.choices?.filter((choice) =>
          choice.value.toLowerCase().startsWith(match[2]!.toLowerCase()),
        )
        .map((choice) => ({
          value: `${match[1]} ${choice.value}`,
          label: choice.label,
        }))
    : BENCH_SETTINGS.filter((field) =>
        field.key.toLowerCase().startsWith(prefix.trim().toLowerCase()),
      ).map((field) => ({
        value: field.key,
        label: field.key,
        description: field.help,
      }));
  return items?.length ? items : null;
}
