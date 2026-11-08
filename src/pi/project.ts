import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import {
  ROOT,
  RUNTIME,
  validateEndpoint,
  type BenchConfig,
} from "../config.js";
import { assertNoLinks, childEnvironment } from "../core/safety.js";

export const CONTROLLER_DIR = path.join(RUNTIME, "controller");
export const AUTH_FILE = path.join(CONTROLLER_DIR, "auth.json");
export const CONTROLLER_WORKSPACE = path.join(CONTROLLER_DIR, "workspace");

/** Bind native pi credentials to the entire normalized endpoint AND wire protocol. */
export function endpointIdentity(
  config: Pick<BenchConfig, "baseUrl" | "api">,
): string {
  const endpoint = validateEndpoint(config.baseUrl).href.replace(/\/+$/, "");
  const prefix =
    endpoint === "https://api.commandcode.ai/provider/v1"
      ? "commandcode"
      : "endpoint";
  return `${prefix}-${createHash("sha256").update(`${config.api}\n${endpoint}`).digest("hex").slice(0, 16)}`;
}
export async function prepareControllerDirectory(): Promise<void> {
  await assertNoLinks(ROOT, CONTROLLER_DIR);
  await mkdir(CONTROLLER_WORKSPACE, { recursive: true });
  for (const name of [
    "auth.json",
    "models.json",
    "settings.json",
    "models-cache.json",
  ]) {
    await assertNoLinks(ROOT, path.join(CONTROLLER_DIR, name));
  }
  await validateProjectAuth();
}
export function literalApiKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16384 &&
    !value.startsWith("!") &&
    !value.includes("$") &&
    !/[\s\p{Cc}\p{Cf}]/u.test(value)
  );
}
/** Native pi permits command-backed keys; the workbench deliberately does not. */
export async function validateProjectAuth(authFile = AUTH_FILE): Promise<void> {
  await assertNoLinks(ROOT, authFile);
  let raw: string;
  try {
    raw = await readFile(authFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error("Project auth.json exceeds 1 MiB.");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Project auth.json is not valid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Project auth.json must be a provider credential map.");
  for (const value of Object.values(data)) {
    if (
      value?.type === "api_key" &&
      value.key !== undefined &&
      !literalApiKey(value.key)
    ) {
      throw new Error(
        "Project auth.json must contain literal API keys, not commands or variable references.",
      );
    }
  }
}
export function controllerEnvironment(): NodeJS.ProcessEnv {
  return childEnvironment({
    PI_CODING_AGENT_DIR: CONTROLLER_DIR,
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  });
}
/** Headless access to native /login's file. Do not interpret !commands or $variables. */
export async function projectKey(
  config: BenchConfig,
  authFile = AUTH_FILE,
): Promise<string> {
  await assertNoLinks(ROOT, authFile);
  let raw: string;
  try {
    raw = await readFile(authFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  if (Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error("Project auth.json exceeds 1 MiB.");
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Project auth.json is not valid JSON.");
  }
  const credential = data?.[endpointIdentity(config)];
  if (!credential) return "";
  if (credential.type !== "api_key" || !literalApiKey(credential.key)) {
    throw new Error(
      "This endpoint requires a literal API key saved with native /login (no commands or variable references).",
    );
  }
  return credential.key;
}
