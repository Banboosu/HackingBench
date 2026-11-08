import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai";
import type { BenchConfig } from "../config.js";

export type ThinkingSetting = BenchConfig["thinking"];
const ALL_LEVELS: ThinkingSetting[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** The exact levels pi exposes for this model; no model yet means native defaults. */
export function thinkingLevelsFor(
  model: Model<any> | undefined,
): ThinkingSetting[] {
  return model
    ? ([...getSupportedThinkingLevels(model)] as ThinkingSetting[])
    : [...ALL_LEVELS];
}

/**
 * Derive the effective thinking level from model attributes, not from the
 * previous selection. Non-reasoning models are always off; reasoning models
 * use the nearest supported level when the requested one is unavailable.
 */
export function normalizeThinking(
  model: Model<any> | undefined,
  requested: ThinkingSetting,
): ThinkingSetting {
  if (!model) return requested;
  return clampThinkingLevel(model, requested) as ThinkingSetting;
}
