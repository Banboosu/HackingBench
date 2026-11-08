export type StopReason = 'timeout' | 'budget_exhausted' | 'stalled';
export class Budget {
  readonly started = performance.now();
  steps = 0; tokens = 0; errors = 0;
  private failures = 0; private repeated = 0; private previous = '';
  constructor(private limits: { wallTimeSeconds: number; maxSteps: number; maxTokens: number }) {}
  get elapsedMs(): number { return performance.now() - this.started; }
  check(): StopReason | undefined {
    if (this.elapsedMs >= this.limits.wallTimeSeconds * 1000) return 'timeout';
    if (this.steps > this.limits.maxSteps || this.tokens >= this.limits.maxTokens || this.failures >= 15) return 'budget_exhausted';
    if (this.repeated >= 6) return 'stalled';
    return undefined;
  }
  beginStep(): StopReason | undefined {
    // Admission check: a configured budget permits exactly maxSteps tool starts.
    if (this.steps >= this.limits.maxSteps) return 'budget_exhausted';
    const reason = this.check();
    if (reason) return reason;
    this.steps++;
    return undefined;
  }
  finishStep(signature: string, output: string, error: boolean): void {
    if (error) { this.errors++; this.failures++; } else this.failures = 0;
    const value = signature + '\0' + output;
    this.repeated = value === this.previous ? this.repeated + 1 : 1;
    this.previous = value;
  }
}
