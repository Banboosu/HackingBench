/** Provider-reported output tokens / successful completed generation time.
 * Includes time to first token and reasoning; never estimates tokens from text deltas.
 */
export class OutputThroughput {
  private since?: number;
  private outputTokens = 0;
  private generationMs = 0;
  private samples = 0;
  constructor(private now: () => number = () => performance.now()) {}
  start(): void {
    this.since = this.now();
  }
  discard(): void {
    this.since = undefined;
  }
  completeUsage(usage: unknown, successful = true): void {
    // pi initializes absent provider usage to all zeros. Don't mistake that for
    // a measured 0 TPS. Zero output is meaningful when input/cache usage exists.
    const u =
      usage && typeof usage === "object"
        ? (usage as Record<string, unknown>)
        : {};
    const reported = ["input", "output", "cacheRead", "cacheWrite"].some(
      (key) =>
        typeof u[key] === "number" &&
        Number.isFinite(u[key]) &&
        (u[key] as number) > 0,
    );
    this.complete(reported ? u.output : undefined, successful);
  }
  complete(tokens: unknown, successful = true): void {
    const started = this.since;
    this.since = undefined;
    if (
      started === undefined ||
      !successful ||
      typeof tokens !== "number" ||
      !Number.isSafeInteger(tokens) ||
      tokens < 0
    )
      return;
    const duration = this.now() - started;
    if (
      !Number.isFinite(duration) ||
      duration <= 0 ||
      !Number.isSafeInteger(this.outputTokens + tokens)
    )
      return;
    this.outputTokens += tokens;
    this.generationMs += duration;
    this.samples++;
  }
  snapshot(): {
    outputTokens: number;
    generationMs: number;
    tpsSamples: number;
    outputTps?: number;
  } {
    return {
      outputTokens: this.outputTokens,
      generationMs: this.generationMs,
      tpsSamples: this.samples,
      outputTps:
        this.samples && this.generationMs > 0
          ? this.outputTokens / (this.generationMs / 1000)
          : undefined,
    };
  }
}
