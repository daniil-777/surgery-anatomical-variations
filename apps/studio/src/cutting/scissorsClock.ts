/** Fixed mechanical updates independent of display refresh. Long foreground
 * stalls are bounded and their unsimulated time is recorded, never hidden. */
export class ScissorsClock {
  static readonly stepSeconds = 1 / 120;
  private accumulator = 0;
  private steps = 0;
  private dropped = 0;
  advance(elapsedSeconds: number, step: (dt: number) => void): number {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) throw new Error("Scissors elapsed time must be finite and nonnegative");
    const accepted = Math.min(elapsedSeconds, 8 * ScissorsClock.stepSeconds);
    this.dropped += elapsedSeconds - accepted; this.accumulator += accepted;
    let count = 0;
    while (this.accumulator + 1e-10 >= ScissorsClock.stepSeconds && count < 8) {
      step(ScissorsClock.stepSeconds);
      this.accumulator = Math.max(0, this.accumulator - ScissorsClock.stepSeconds); this.steps++; count++;
    }
    return count;
  }
  reset() { this.accumulator = 0; this.steps = 0; this.dropped = 0; }
  snapshot() { return { stepSeconds: ScissorsClock.stepSeconds, acceptedSteps: this.steps, simulationSeconds: this.steps * ScissorsClock.stepSeconds, pendingSeconds: this.accumulator, droppedWallSeconds: this.dropped }; }
}
