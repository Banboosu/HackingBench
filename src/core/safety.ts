import path from "node:path";
import { lstat, realpath } from "node:fs/promises";

// All in-game executables are available. Only commands that would bypass the
// game's normal UI/rules are blocked. This is not a host-command allowlist:
// hn_cmd sends one validated line to the game terminal, never to a host shell.
export const BLOCKED_COMMANDS = [
  "mcp",
  "loadmission",
  "loadactions",
  "dscan",
  "debug",
  "sudo",
  "execute",
  "quit",
  "fasthack",
  "revealall",
  "getstring",
  "setflag",
  "clearflag",
  "set_flag",
  "clear_flag",
  "addflag",
  "removeflag",
  "takeadmin",
  "take_admin",
] as const;
const blocked = new Set<string>(BLOCKED_COMMANDS);
export const PLAYER_TOOLS = [
  "hn_cmd",
  "hn_shell",
  "hn_screen",
  "hn_wait",
  "hn_input",
  "hn_tutorial",
  "hn_mail",
  "hn_reply",
  "hn_hub",
  "hn_give_up",
] as const;

export function validateCommand(input: unknown): string {
  if (typeof input !== "string" || input.length < 1 || input.length > 256)
    throw new Error("Command must be 1–256 characters.");
  // ASCII space is the only supported whitespace; reject controls, bidi and invisible separators.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input) || /[^\S ]/u.test(input))
    throw new Error(
      "Control characters and non-ASCII whitespace are forbidden.",
    );
  if (/[&|;`$()<>\\:]/u.test(input))
    throw new Error("Shell syntax, drive paths and UNC paths are forbidden.");
  if (/(^|[ /])\.\.([ /]|$)/u.test(input))
    throw new Error("Parent-directory traversal is forbidden.");
  const cmd = input.trim();
  const first = cmd.split(" ")[0]!.toLowerCase();
  // Commands are bare names. Reject path-shaped first tokens so a debug/cheat
  // name cannot be smuggled in as ./mcp or /bin/loadmission.
  if (/[\\/]/.test(first))
    throw new Error("Command names must be bare game commands or executables.");
  const base = first.endsWith(".exe") ? first.slice(0, -4) : first;
  if (blocked.has(first) || blocked.has(base))
    throw new Error(`Command is blocked by the game safety policy: ${first}`);
  return cmd;
}

export function within(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export async function assertNoLinks(
  root: string,
  target: string,
): Promise<void> {
  if (!within(root, target))
    throw new Error(`Refusing path outside project runtime: ${target}`);
  // Also inspect ancestors. This rejects junctions/reparse-point symlinks within the writable tree.
  const canonicalRoot = await realpath(root);
  let cursor = path.resolve(target);
  while (within(root, cursor)) {
    try {
      if ((await lstat(cursor)).isSymbolicLink())
        throw new Error(`Refusing linked runtime path: ${cursor}`);
      const canonical = await realpath(cursor);
      if (!within(canonicalRoot, canonical))
        throw new Error(`Runtime path escapes through an ancestor: ${cursor}`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (cursor === path.resolve(root)) break;
    cursor = path.dirname(cursor);
  }
}
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets.filter((s) => s.length > 0))
    out = out.split(secret).join("[REDACTED]");
  return out
    .replace(/\bBearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[REDACTED]");
}
// Do not allow content supplied by the game/model to execute terminal escape sequences.
export function terminalText(text: string): string {
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
export function childEnvironment(
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const keep = new Set([
    "systemroot",
    "windir",
    "comspec",
    "path",
    "pathext",
    "temp",
    "tmp",
    "userprofile",
    "homedrive",
    "homepath",
    "localappdata",
    "appdata",
    "programfiles",
    "programfiles(x86)",
    "programdata",
    "number_of_processors",
    "processor_architecture",
  ]);
  for (const [k, v] of Object.entries(process.env))
    if (keep.has(k.toLowerCase()) && v) env[k] = v;
  return { ...env, ...extra };
}
