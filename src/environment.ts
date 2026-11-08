import { access, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ROOT, RUNTIME, validateEndpoint, type BenchConfig } from './config.js';
import { command } from './core/process.js';
import { MIN_BUN_VERSION, supportedBun, runtimeDescription } from './core/runtime.js';

export interface Environment {
  platform: string; runtime: string; pi?: string; piVersion?: string; gameSource?: string;
  dlc: boolean; prepared: boolean; problems: string[];
}
export async function exists(p: string): Promise<boolean> { try { await access(p); return true; } catch { return false; } }
export async function findExecutable(name: string): Promise<string | undefined> {
  const suffixes = process.platform === 'win32' ? ['.exe', ''] : [''];
  const dirs=[...(name==='pi' ? [path.join(ROOT,'node_modules','.bin')] : []),...(process.env.PATH ?? '').split(path.delimiter)];
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name + suffix);
      if (await exists(candidate)) return candidate;
    }
  }
  return undefined;
}
export function steamLibraryPaths(text: string): string[] {
  return [...text.matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/g)].map(m => m[1]!.replace(/\\\\/g, '\\'));
}
export async function findGame(): Promise<string | undefined> {
  const steam = new Set<string>([
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Steam'),
  ]);
  if (process.platform === 'win32') {
    try {
      const registry = await command('reg.exe', ['query','HKCU\\Software\\Valve\\Steam','/v','SteamPath'], { timeout: 5000 });
      const value = registry.match(/SteamPath\s+REG_SZ\s+(.+)/)?.[1]?.trim();
      if (value) steam.add(value);
    } catch { /* Fall back to well-known locations. */ }
  }
  for (const root of [...steam]) {
    try { for (const lib of steamLibraryPaths(await readFile(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'))) steam.add(lib); } catch { /* Missing library list. */ }
  }
  for (const root of steam) {
    const folder = path.join(root, 'steamapps', 'common', 'Hacknet');
    if (await exists(path.join(folder, 'Hacknet.exe'))) return realpath(folder);
  }
  return undefined;
}
export async function inspect(config: BenchConfig): Promise<Environment> {
  const problems: string[] = [];
  if (!supportedBun()) problems.push(`Bun >=${MIN_BUN_VERSION} is required; use bun run start.`);
  if (process.platform !== 'win32') problems.push('Live runs require Windows-native Bun, not WSL. Demo/tests remain cross-platform.');
  const pi = config.piExecutable || await findExecutable('pi');
  let piVersion: string | undefined;
  if (pi) {
    try { piVersion = (await command(pi, ['--version'], { timeout: 15000 })).trim(); }
    catch { problems.push('Could not run pi --version.'); }
    if (piVersion && !/\b1\.5\.0\b/.test(piVersion)) problems.push(`This adapter is validated against pi 1.5.0; found ${piVersion}.`);
  } else problems.push('pi.exe is not on PATH. Install pi 1.5.0 or set piExecutable.');
  const gameSource = config.gameSource || await findGame();
  if (!gameSource || !await exists(path.join(gameSource, 'Hacknet.exe'))) problems.push('Hacknet installation not found. Set its folder in Configure.');
  const dlc = !!gameSource && await exists(path.join(gameSource, 'Content', 'DLC'));
  const prepared = await exists(path.join(RUNTIME, 'game', '.hackingbench-install.json'));
  if (!await exists(path.join(ROOT, 'vendor', 'hnpf-mcp', 'bridge', 'Executor.cs'))) problems.push('HNPF-MCP source missing; run git submodule update --init --recursive.');
  return { platform: process.platform, runtime: runtimeDescription(), pi, piVersion, gameSource, dlc, prepared, problems };
}
export interface CatalogEntry { provider: string; model: string; api: BenchConfig['api']; baseUrl: string; }
/** Read pi-provider's catalog without executing !commands, resolving keys, or copying auth/headers. */
export async function providerCatalog(file = path.join(os.homedir(), '.pi', 'agent', 'models.json')): Promise<CatalogEntry[]> {
  let data: any;
  try { data = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('Could not read pi model catalog.'); }
  const entries: CatalogEntry[] = [];
  for (const [provider, value] of Object.entries(data.providers ?? {})) {
    const p = value as any;
    for (const m of Array.isArray(p.models) ? p.models : []) {
      const api = m.api ?? p.api;
      if (!['openai-completions','openai-responses','anthropic-messages'].includes(api)) continue;
      if (typeof m.id !== 'string' || typeof (m.baseUrl ?? p.baseUrl) !== 'string') continue;
      const baseUrl: string = m.baseUrl ?? p.baseUrl;
      try { validateEndpoint(baseUrl); } catch { continue; }
      entries.push({ provider, model: m.id, api, baseUrl });
    }
  }
  return entries;
}
