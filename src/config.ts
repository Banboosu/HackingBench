import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RUNTIME = path.join(ROOT, 'runtime');
export const CONFIG_FILE = path.join(RUNTIME, 'bench.json');
export const configSchema = z.object({
  version: z.literal(1).default(1),
  gameSource: z.string().default(''),
  piExecutable: z.string().default(''),
  api: z.enum(['openai-completions', 'openai-responses', 'anthropic-messages']).default('openai-responses'),
  baseUrl: z.string().refine(value => { try { validateEndpoint(value); return true; } catch { return false; } }, 'Use an HTTPS API URL without credentials or query parameters.').default('https://api.openai.com/v1'),
  model: z.string().min(1).max(256).default('gpt-4.1'),
  keyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).default('HACKINGBENCH_API_KEY'),
  thinking: z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']).default('off'),
  contextWindow: z.number().int().min(16384).max(2000000).default(128000),
  maxOutputTokens: z.number().int().min(256).max(65536).default(8192),
  knowledge: z.enum(['L0', 'L1']).default('L1'),
  observation: z.enum(['text', 'text+image']).default('text'),
  wallTimeSeconds: z.number().int().min(10).max(86400).default(7200),
  maxSteps: z.number().int().min(1).max(10000).default(1500),
  maxTokens: z.number().int().min(100).max(100000000).default(2000000),
}).refine(config => config.maxOutputTokens < config.contextWindow, 'Output limit must be smaller than context window.');
export type BenchConfig = z.infer<typeof configSchema>;
export const defaults = (): BenchConfig => configSchema.parse({});
export async function loadConfig(): Promise<BenchConfig> {
  try { return configSchema.parse(JSON.parse(await readFile(CONFIG_FILE, 'utf8'))); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return defaults(); throw e; }
}
export async function writeJson(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
}
export async function saveConfig(config: BenchConfig): Promise<void> {
  const valid = configSchema.parse(config); // Strip unknown fields, including pasted keys.
  validateEndpoint(valid.baseUrl);
  if (valid.maxOutputTokens >= valid.contextWindow) throw new Error('Output token limit must be smaller than context window.');
  await writeJson(CONFIG_FILE, valid);
}
export function validateEndpoint(value: string): URL {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash) throw new Error('API URL must not contain credentials, query parameters, or fragments.');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('Use HTTPS (HTTP is allowed only for a local model server).');
  return u;
}
