import path from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  ROOT,
  validateEndpoint,
  writeJson,
  type BenchConfig,
} from "../config.js";
import { assertNoLinks } from "../core/safety.js";
import { CONTROLLER_DIR, endpointIdentity } from "./project.js";

export const modelIdSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+\-]*$/);
export const discoveredModelSchema = z.object({
  id: modelIdSchema,
  name: z.string().min(1).max(256),
  reasoning: z.boolean(),
  contextWindow: z.number().int().min(16384).max(2000000),
  maxTokens: z.number().int().min(256).max(65536),
  input: z
    .array(z.enum(["text", "image"]))
    .min(1)
    .max(2),
});
export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;
const cacheSchema = z.object({
  provider: z.string(),
  models: z.array(discoveredModelSchema).max(10000),
});

/** Remote catalog fields are data, never pi config, headers, credentials or commands. */
export function parseModels(payload: unknown): DiscoveredModel[] {
  const list = (payload as any)?.data;
  if (!Array.isArray(list) || list.length > 10000)
    throw new Error(
      "Model catalog must contain a data array with at most 10000 entries.",
    );
  const models = new Map<string, DiscoveredModel>();
  for (const item of list) {
    const parsedId = modelIdSchema.safeParse(item?.id);
    if (!parsedId.success) continue;
    const id = parsedId.data;
    const context = boundedInteger(
      item.context_window ?? item.context_length ?? item.max_context_length,
      128000,
      16384,
      2000000,
    );
    const maxTokens = Math.min(
      context - 1,
      boundedInteger(
        item.max_output_tokens ?? item.max_tokens,
        8192,
        256,
        65536,
      ),
    );
    const name =
      typeof item.name === "string"
        ? item.name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").slice(0, 256)
        : id;
    const params = Array.isArray(item.supported_parameters)
      ? item.supported_parameters
      : [];
    models.set(id, {
      id,
      name: name || id,
      reasoning:
        item.reasoning === true ||
        params.includes("reasoning_effort") ||
        /deepseek.*(?:v4|reasoner)|(?:^|\/)o[134](?:-|$)/i.test(id),
      contextWindow: context,
      maxTokens,
      input: ["text"],
    });
  }
  if (!models.size)
    throw new Error(
      "No safe chat model IDs found. Retry discovery or configure a model manually.",
    );
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min
    ? Math.min(value, max)
    : fallback;
}
export async function discoverModels(
  config: BenchConfig,
  key: string,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const base = validateEndpoint(config.baseUrl);
  if (!key) throw new Error("Use native /login before fetching models.");
  const prefix = base.href.replace(/\/+$/, "");
  const url =
    prefix +
    (config.api === "anthropic-messages" && !/\/v1$/.test(prefix)
      ? "/v1/models"
      : "/models");
  const timeout = AbortSignal.timeout(15000);
  const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
  // Never follow a redirect with a credential, even to another HTTPS endpoint.
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      signal: combined,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(config.api === "anthropic-messages"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : {}),
        Accept: "application/json",
      },
    });
  } catch {
    throw new Error(
      combined.aborted
        ? "Model discovery cancelled or timed out."
        : "Model discovery failed (network error or refused redirect).",
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Model discovery returned HTTP ${response.status}. Response body omitted to protect credentials.`,
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Model discovery returned no body.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 2 * 1024 * 1024)
        throw new Error("Model catalog exceeds 2 MiB.");
      chunks.push(value);
    }
  } catch (error) {
    if (combined.aborted)
      throw new Error("Model discovery cancelled or timed out.");
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Model catalog is not valid JSON. Response body omitted.");
  }
  const models = parseModels(payload)
    .filter((model) => !model.id.includes(key))
    .map((model) => ({
      ...model,
      name: model.name.split(key).join("[REDACTED]"),
    }));
  if (!models.length) throw new Error("No safe model IDs found in catalog.");
  return models;
}
function cachePath(config: BenchConfig): string {
  return path.join(CONTROLLER_DIR, `${endpointIdentity(config)}.catalog.json`);
}
export async function readModelCache(
  config: BenchConfig,
): Promise<DiscoveredModel[]> {
  const file = cachePath(config);
  await assertNoLinks(ROOT, file);
  try {
    const raw = await readFile(file, "utf8");
    if (Buffer.byteLength(raw) > 4 * 1024 * 1024) return [];
    const parsed = cacheSchema.safeParse(JSON.parse(raw));
    return parsed.success && parsed.data.provider === endpointIdentity(config)
      ? parsed.data.models
      : [];
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      error instanceof SyntaxError
    )
      return [];
    throw error;
  }
}
export async function saveModelCache(
  config: BenchConfig,
  models: DiscoveredModel[],
): Promise<void> {
  const file = cachePath(config);
  await assertNoLinks(ROOT, file);
  await writeJson(
    file,
    cacheSchema.parse({ provider: endpointIdentity(config), models }),
  );
}
export function manualModel(config: BenchConfig): DiscoveredModel {
  return discoveredModelSchema.parse({
    id: config.model,
    name: `${config.model} (configured; not catalog-verified)`,
    reasoning: config.thinking !== "off",
    contextWindow: config.contextWindow,
    maxTokens: config.maxOutputTokens,
    input: ["text"],
  });
}
export function piModel(model: DiscoveredModel) {
  return {
    ...model,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
