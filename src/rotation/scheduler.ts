import { RotationManager } from "./index";
import { RotationResult } from "../types";

export type RotationEventHandler = (results: RotationResult[]) => void;

/**
 * Scheduler for automatic secret rotation
 */
export class RotationScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running: boolean = false;
  private checkIntervalMs: number;
  private onRotationComplete?: RotationEventHandler;

  constructor(
    private manager: RotationManager,
    options: {
      checkIntervalMs?: number;
      onRotationComplete?: RotationEventHandler;
    } = {}
  ) {
    // Default: check every hour
    this.checkIntervalMs = options.checkIntervalMs || 60 * 60 * 1000;
    this.onRotationComplete = options.onRotationComplete;
  }

  /**
   * Start the scheduler
   */
  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;

    // Run immediately on start
    this.tick().catch(this.handleError.bind(this));

    // Then run on interval
    this.intervalId = setInterval(() => {
      this.tick().catch(this.handleError.bind(this));
    }, this.checkIntervalMs);
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    this.running = false;

    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Check if scheduler is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the check interval in milliseconds
   */
  getCheckInterval(): number {
    return this.checkIntervalMs;
  }

  /**
   * Set the check interval
   */
  setCheckInterval(ms: number): void {
    this.checkIntervalMs = ms;

    // Restart if running
    if (this.running) {
      this.stop();
      this.start();
    }
  }

  /**
   * Run a single check and rotate due secrets
   */
  private async tick(): Promise<void> {
    if (!this.running) {
      return;
    }

    const dueRotations = this.manager.checkDueRotations();

    if (dueRotations.length === 0) {
      return;
    }

    const results = await this.manager.runDueRotations();

    // Log results
    for (const result of results) {
      if (result.success) {
        console.log(`[Rotation] Success: ${result.secretName}`);
      } else {
        console.error(`[Rotation] Failed: ${result.secretName} - ${result.error}`);
      }
    }

    // Notify handler
    if (this.onRotationComplete && results.length > 0) {
      this.onRotationComplete(results);
    }
  }

  /**
   * Handle errors during tick
   */
  private handleError(error: Error): void {
    console.error(`[Rotation Scheduler] Error: ${error.message}`);
  }

  /**
   * Force run all due rotations now
   */
  async runNow(): Promise<RotationResult[]> {
    return this.manager.runDueRotations();
  }

  /**
   * Get next scheduled check time
   */
  getNextCheckTime(): Date | null {
    if (!this.running || !this.intervalId) {
      return null;
    }

    // We don't have access to the actual next run time,
    // so we estimate based on when we started
    return new Date(Date.now() + this.checkIntervalMs);
  }
}
