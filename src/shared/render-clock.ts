import { TIME_SCALE } from "./constants";
import type { World } from "./types";

const EPSILON = 1e-6;
const MAX_SNAPSHOT_LEAD_REAL_SECONDS = 0.25;

/**
 * A presentation-only monotonic clock. Worker snapshots correct its bound, but
 * routine integer snapshots never pull an already-rendered frame backwards.
 */
export class RenderClock {
  private displayed: number;
  private sampledAt: number;
  private authoritative: number;
  private paused: boolean;
  private speed: World["speed"];

  constructor(
    time: number,
    paused: boolean,
    speed: World["speed"],
    now: number,
  ) {
    this.displayed = time;
    this.sampledAt = now;
    this.authoritative = time;
    this.paused = paused;
    this.speed = speed;
  }

  get authoritativeTime(): number {
    return this.authoritative;
  }

  private advance(now: number): number {
    const elapsed = Math.max(0, now - this.sampledAt) / 1_000;
    this.sampledAt = Math.max(this.sampledAt, now);
    if (this.paused || elapsed === 0) return this.displayed;

    const rate = TIME_SCALE * this.speed;
    const predicted = this.displayed + elapsed * rate;
    const leadLimit =
      this.authoritative + rate * MAX_SNAPSHOT_LEAD_REAL_SECONDS;
    this.displayed = Math.max(this.displayed, Math.min(predicted, leadLimit));
    return this.displayed;
  }

  /** Apply a new worker snapshot and return the time safe to draw now. */
  sync(
    time: number,
    paused: boolean,
    speed: World["speed"],
    now: number,
  ): number {
    this.advance(now);
    const timelineRestarted = time < this.authoritative - EPSILON;
    const resumed = this.paused && !paused;

    if (timelineRestarted || paused || resumed) {
      // Pause/load/reset are explicit discontinuities, so they snap exactly to
      // authoritative state. In normal running, correction is forward-only.
      this.displayed = time;
    } else {
      this.displayed = Math.max(this.displayed, time);
    }

    this.authoritative = time;
    this.paused = paused;
    this.speed = speed;
    this.sampledAt = now;
    return this.displayed;
  }

  /** Sample between worker updates for animation-frame rendering. */
  sample(now: number): number {
    return this.advance(now);
  }
}
