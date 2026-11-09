export const RESUME_PROMPT =
  "The operator resumed this same attempt after a model/API failure. The game kept running while model requests were paused. First use hn_screen to refresh the current game state, then continue toward the campaign ending. Previously completed tool calls and their results are already in this conversation: do not blindly replay them. If unable to progress, use hn_give_up.";

/** Recovery is allowed only at agent_settled, never by replaying tool calls. */
export class ProviderRecovery {
  private state: "running" | "paused" | "closed" = "running";
  private pausedAt?: number;
  private elapsed = 0;
  private count = 0;
  constructor(
    private hooks: {
      restart: () => Promise<void>;
      paused: (reason: string) => void;
      resumed: () => void;
      fatal: (error: Error) => void;
      now?: () => number;
    },
  ) {}
  private now(): number {
    return (this.hooks.now ?? (() => performance.now()))();
  }
  get paused(): boolean {
    return this.state === "paused";
  }
  private get closed(): boolean {
    return this.state === "closed";
  }
  snapshot(): { providerPauses: number; providerPauseMs: number } {
    return {
      providerPauses: this.count,
      providerPauseMs:
        this.elapsed +
        (this.pausedAt === undefined
          ? 0
          : Math.max(0, this.now() - this.pausedAt)),
    };
  }
  /** True means the normal automatic continuation may proceed. */
  settled(error: string): boolean {
    if (this.state !== "running") return false;
    if (!error) return true;
    this.state = "paused";
    this.pausedAt = this.now();
    this.count++;
    this.hooks.paused(error);
    return false;
  }
  private endPause(): void {
    if (this.pausedAt === undefined) return;
    this.elapsed += Math.max(0, this.now() - this.pausedAt);
    this.pausedAt = undefined;
  }
  async resume(): Promise<void> {
    if (!this.paused)
      throw new Error(
        "No paused model session. /retry only continues a live paused run; use /start for a new attempt.",
      );
    // Claim synchronously: concurrent /retry calls must never send two prompts.
    this.state = "running";
    this.endPause();
    this.hooks.resumed();
    try {
      await this.hooks.restart();
    } catch (error) {
      // A prompt RPC timeout has ambiguous acceptance. Do NOT replay it or
      // pretend that a broken/dead child process is a resumable API failure.
      if (!this.closed) {
        this.close();
        this.hooks.fatal(error as Error);
      }
      throw error;
    }
  }
  close(): void {
    this.endPause();
    this.state = "closed";
  }
}
