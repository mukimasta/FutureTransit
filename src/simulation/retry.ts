import type { Journey, World } from "../shared/types";

/** A failed request sleeps this long, plus a per-request spread. */
const RETRY_BASE_SECONDS = 20;
const RETRY_SPREAD_SECONDS = 20;

/** A failure only wakes for news that could change it.
 *
 * Waiting on a Pod is waiting on the fleet, so those sleep until the idle fleet
 * moves. Waiting on a jammed corridor or a full parking row is not: another Pod
 * parking across the city leaves the jam exactly as it was, and waking every
 * such request on every arrival is what makes a rush hour re-price the whole
 * fleet several times a minute. Those sleep on the clock and on the network
 * instead. Nothing here owns a reservation or is persisted; importing a save
 * starts fresh. */
export class RetryQueue {
  private stamp = "";
  private fleetStamp = "";
  private failures = new Map<string, { at: number; fleet: boolean }>();
  refresh(world: World): void {
    const stamp = `${world.networkVersion}|${world.pendingEdits
      .map((e) => `${e.type}:${e.id}`)
      .join(",")}`;
    const fleetStamp = world.pods
      .filter((p) => !p.plan)
      .map((p) => `${p.id}:${p.berthId}`)
      .join(",");
    if (stamp !== this.stamp) {
      this.stamp = stamp;
      this.fleetStamp = fleetStamp;
      this.failures.clear();
    } else if (fleetStamp !== this.fleetStamp) {
      this.fleetStamp = fleetStamp;
      for (const [key, entry] of this.failures)
        if (entry.fleet) this.failures.delete(key);
    }
    for (const [key, entry] of this.failures)
      if (entry.at <= world.time) this.failures.delete(key);
  }
  /** Spread over the interval, so requests that failed together do not all
   * come back in the same pass and make one of them carry the whole rush. */
  private offset(key: string): number {
    let hash = 0;
    for (let index = 0; index < key.length; index += 1)
      hash = (hash * 31 + key.charCodeAt(index)) | 0;
    return Math.abs(hash) % RETRY_SPREAD_SECONDS;
  }
  ready(key: string, time: number): boolean {
    return (this.failures.get(key)?.at ?? -Infinity) <= time;
  }
  failed(
    key: string,
    time: number,
    reason: NonNullable<Journey["waitReason"]>,
  ): void {
    // A bounded fallback also catches time-window openings with no fleet event.
    this.failures.set(key, {
      at: time + RETRY_BASE_SECONDS + this.offset(key),
      fleet: reason === "no-pod" || reason === "disconnected",
    });
  }
}

const queues = new WeakMap<World, RetryQueue>();
export function retryQueue(world: World): RetryQueue {
  let queue = queues.get(world);
  if (!queue) {
    queue = new RetryQueue();
    queues.set(world, queue);
  }
  queue.refresh(world);
  return queue;
}
