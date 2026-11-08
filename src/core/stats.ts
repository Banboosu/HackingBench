/**
 * Run telemetry only. There is deliberately no wall-clock, tool-call or token
 * admission decision here: a run ends on success, hn_give_up, infra failure or
 * an explicit /stop, never because a counter reached a configured limit.
 */
export class RunStats {
  readonly started = performance.now();
  steps = 0;
  tokens = 0;
  errors = 0;

  get elapsedMs(): number {
    return performance.now() - this.started;
  }
  beginStep(): void {
    this.steps++;
  }
  finishStep(error: boolean): void {
    if (error) this.errors++;
  }
}
